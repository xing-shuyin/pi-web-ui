const SUMMARY_CAP = 300;
const DETAIL_CAP = 8000;
const PREVIEW_CAP = 4000;
const MAX_CONVS = 10;
const REFRESH_DEBOUNCE_MS = 300;
const POLL_STREAMING_MS = 5000;
const POLL_IDLE_MS = 30000;

const WRITE_TOOL_RE = /edit|write|patch|apply|create|save|move|rename|delete|remove|mkdir/i;
const READONLY_TOOL_RE = /^(read|get|list|glob|grep|search|show|cat|fetch|query)/i;
const PATH_KEYS = new Set([
	"path",
	"file",
	"filepath",
	"filePath",
	"filename",
	"fileName",
	"paths",
	"files",
	"dir",
	"cwd",
]);

function cut(s, cap) {
	s = String(s ?? "");
	return s.length <= cap ? s : `${s.slice(0, cap)}\n… [truncated]`;
}

function firstLine(s, cap = 100) {
	const line = String(s ?? "").split("\n")[0] ?? "";
	const t = line.trim();
	return t.length <= cap ? t : `${t.slice(0, cap)}…`;
}

export function estTextMs(chars) {
	const n = Math.max(0, Number(chars) || 0);
	return Math.min(120000, Math.max(800, Math.round(n * 20)));
}

export function extractPaths(argsText) {
	const out = [];
	try {
		const args = JSON.parse(String(argsText ?? "null"));
		if (!args || typeof args !== "object") return out;
		const push = (v) => {
			if (typeof v !== "string") return;
			const t = v.trim();
			if (t.length < 1 || t.length > 300) return;
			if (!/[/\\.]/.test(t)) return;
			if (out.length < 10 && !out.includes(t)) out.push(t);
		};
		for (const [k, v] of Object.entries(args)) {
			if (!PATH_KEYS.has(k)) continue;
			if (typeof v === "string") push(v);
			else if (Array.isArray(v)) for (const x of v) push(x);
		}
	} catch {}
	return out;
}

export function toolHeadline(toolName, argsText) {
	const name = String(toolName ?? "tool");
	if (name === "bash") {
		try {
			const cmd = JSON.parse(String(argsText ?? "{}"))?.command;
			if (cmd) return `bash · ${firstLine(cmd)}`;
		} catch {}
		return "bash";
	}
	const paths = extractPaths(argsText);
	if (paths.length) return `${name} · ${paths[0]}${paths.length > 1 ? ` (+${paths.length - 1})` : ""}`;
	const flat = firstLine(String(argsText ?? "").replace(/^\{|\}$/g, ""), 80);
	return flat ? `${name} · ${flat}` : name;
}

function blockText(blocks, type, field) {
	const parts = [];
	for (const b of blocks ?? []) {
		if (b?.type === type && typeof b[field] === "string" && b[field].trim()) parts.push(b[field]);
	}
	return parts.join("\n");
}

export default {
	activate(host) {
		const convs = new Map();
		let activeId = null;
		let refreshTimer = null;
		let pollTimer = null;
		let disposed = false;

		const getConv = (id, title) => {
			let c = convs.get(id);
			if (!c) {
				c = {
					id,
					title,
					active: false,
					isStreaming: false,
					segs: [],
					full: new Map(),
					analysis: null,
					liveTools: new Map(),
					updatedAt: 0,
				};
				convs.set(id, c);
				while (convs.size > MAX_CONVS) {
					const oldest = [...convs.values()]
						.filter((x) => x.id !== activeId)
						.sort((a, b) => a.updatedAt - b.updatedAt)[0];
					if (!oldest) break;
					convs.delete(oldest.id);
				}
			}
			if (title) c.title = title;
			return c;
		};

		const summaryOf = (c) => ({
			id: c.id,
			title: c.title,
			active: c.id === activeId,
			isStreaming: c.isStreaming,
			segCount: c.segs.length,
			updatedAt: c.updatedAt,
			analysis: c.analysis,
		});

		const pushState = (to) => {
			const payload = { kind: "state", conversations: [...convs.values()].map(summaryOf), activeId };
			if (to) host.sendTo(to, payload);
			else host.broadcast(payload);
		};

		function buildHistory(messages, streamingMessage) {
			const segs = [];
			const full = new Map();
			const toolKeys = new Set();
			let turn = 0;
			const pending = new Map();
			const callInfo = new Map();

			let prevEnd = 0;
			const addSeg = (seg, detail) => {
				segs.push(seg);
				if (detail !== undefined) full.set(seg.key, detail);
				const e = seg.end ?? seg.t;
				if (e > prevEnd) prevEnd = e;
				return seg;
			};

			const all = streamingMessage ? [...(messages ?? []), { ...streamingMessage, _live: true }] : (messages ?? []);
			const nextTByMsg = new Map();
			{
				let nxt = undefined;
				for (let i = all.length - 1; i >= 0; i--) {
					nextTByMsg.set(all[i], nxt);
					const ts = all[i]?.timestamp;
					if (typeof ts === "number") nxt = ts;
				}
			}
			for (const m of all) {
				const live = !!m._live;
				const t = m.timestamp ?? Date.now();
				if (m.role === "user") {
					turn += 1;
					const text = blockText(m.content, "text", "text").trim() || "(附件/空消息)";
					addSeg(
						{
							key: `h-${m.id}`,
							kind: "user",
							lane: "input",
							t,
							end: t,
							title: `用户 · 第 ${turn} 轮`,
							summary: cut(text, SUMMARY_CAP),
							source: "用户",
							status: "done",
							turn,
							meta: { chars: text.length },
						},
						cut(text, DETAIL_CAP),
					);
				} else if (m.role === "assistant") {
					const blocks = m.content ?? [];
					const ests = [];
					let totalEst = 0;
					for (const b of blocks) {
						if (b?.type === "thinking" && b.thinking?.trim()) {
							const e = live ? 0 : estTextMs(b.thinking.length);
							ests.push(e);
							totalEst += e;
						} else if (b?.type === "text" && b.text?.trim()) {
							const e = live ? 0 : estTextMs(b.text.length);
							ests.push(e);
							totalEst += e;
						}
					}
					let cursor = Math.max(t, prevEnd);
					if (!live && totalEst > 0) {
						const nextT = nextTByMsg.get(m);
						const budget = nextT !== undefined ? Math.max(0, nextT - t) : Infinity;
						if (totalEst > budget) {
							const s = budget > 0 ? budget / totalEst : 0;
							for (let i = 0; i < ests.length; i++) ests[i] = Math.max(1, Math.floor(ests[i] * s));
						}
					}
					let ei = 0;
					let bi = 0;
					for (const b of blocks) {
						if (b?.type === "thinking" && b.thinking?.trim()) {
							const est = ests[ei++];
							const start = cursor;
							const end = live ? t : start + Math.max(1, est);
							cursor = end;
							addSeg(
								{
									key: `h-${m.id}-${bi++}`,
									kind: "thinking",
									lane: "model",
									t: start,
									end,
									...(live ? {} : { dur: Math.max(0, end - start) }),
									title: "思考",
									summary: cut(b.thinking.trim(), SUMMARY_CAP),
									source: "模型 · 思考",
									status: live ? "running" : "done",
									turn,
									meta: { chars: b.thinking.length },
								},
								cut(b.thinking, DETAIL_CAP),
							);
						} else if (b?.type === "text" && b.text?.trim()) {
							const est = ests[ei++];
							const start = cursor;
							const end = live ? t : start + Math.max(1, est);
							cursor = end;
							addSeg(
								{
									key: `h-${m.id}-${bi++}`,
									kind: "text",
									lane: "model",
									t: start,
									end,
									...(live ? {} : { dur: Math.max(0, end - start) }),
									title: "回答",
									summary: cut(b.text.trim(), SUMMARY_CAP),
									source: "模型 · 回答",
									status: live ? "running" : "done",
									turn,
									meta: { chars: b.text.length },
								},
								cut(b.text, DETAIL_CAP),
							);
						} else if (b?.type === "toolCall" && b.id) {
							if (liveTools(currentConvId, b.id)) {
								callInfo.set(b.id, { argsText: b.argumentsText ?? "null", ts: Math.max(t, cursor) });
								continue;
							}
							const argsText = b.argumentsText ?? "null";
							const toolT = Math.max(t, cursor);
							callInfo.set(b.id, { argsText, ts: toolT });
							const readonly = READONLY_TOOL_RE.test(String(b.name ?? ""));
							const seg = {
								key: `h-${b.id}`,
								kind: "tool",
								lane: "tools",
								t: toolT,
								end: toolT,
								title: `${readonly ? "📖" : "🔧"} ${toolHeadline(b.name, argsText)}`,
								summary: live ? "执行中…" : "（等待结果…）",
								source: `工具 · ${b.name}`,
								status: "running",
								turn,
								meta: {
									tool: b.name,
									toolCallId: b.id,
									args: cut(argsText, PREVIEW_CAP),
									files: extractPaths(argsText),
								},
							};
							toolKeys.add(b.id);
							pending.set(b.id, seg);
							addSeg(seg, cut(argsText, DETAIL_CAP));
						}
					}
				} else if (m.role === "toolResult" && m.toolCallId) {
					const text = blockText(m.content, "text", "text");
					const info = callInfo.get(m.toolCallId);
					const dur = info && m.timestamp && info.ts ? Math.max(0, m.timestamp - info.ts) : undefined;
					toolKeys.add(m.toolCallId);
					const seg = pending.get(m.toolCallId);
					const toolName = m.toolName ?? seg?.meta?.tool ?? "tool";
					if (seg) {
						pending.delete(m.toolCallId);
						seg.status = m.isError ? "error" : "done";
						seg.end = Math.max(m.timestamp ?? seg.t, seg.t);
						const realDur =
							info && seg.end !== undefined && info.ts !== undefined ? Math.max(0, seg.end - info.ts) : undefined;
						if (realDur !== undefined) {
							seg.dur = realDur;
						}
						seg.title = `${m.isError ? "❌" : "✅"} ${toolHeadline(toolName, info?.argsText)}`;
						seg.summary = cut(
							m.isError
								? `失败${realDur !== undefined ? ` · ${(realDur / 1000).toFixed(1)}s` : ""}`
								: text.trim().slice(0, 200) || "完成",
							SUMMARY_CAP,
						);
						seg.meta = { ...(seg.meta ?? {}), result: cut(text, PREVIEW_CAP), dur: realDur };
						full.set(seg.key, cut(text || "(无输出)", DETAIL_CAP));
						if (seg.end > prevEnd) prevEnd = seg.end;
					} else {
						addSeg(
							{
								key: `h-${m.toolCallId}`,
								kind: "tool",
								lane: "tools",
								t,
								end: m.timestamp ?? t,
								...(dur !== undefined ? { dur } : {}),
								title: `${m.isError ? "❌" : "✅"} ${toolName}`,
								summary: cut(text.trim().slice(0, 200) || (m.isError ? "失败" : "完成"), SUMMARY_CAP),
								source: `工具 · ${toolName}`,
								status: m.isError ? "error" : "done",
								turn,
								meta: { tool: toolName, toolCallId: m.toolCallId, result: cut(text, PREVIEW_CAP), dur },
							},
							cut(text || "(无输出)", DETAIL_CAP),
						);
					}
					if (!m.isError && WRITE_TOOL_RE.test(String(toolName)) && !READONLY_TOOL_RE.test(String(toolName))) {
						const files = extractPaths(info?.argsText);
						if (files.length) {
							addSeg(
								{
									key: `h-${m.toolCallId}-files`,
									kind: "file",
									lane: "tools",
									t,
									end: m.timestamp ?? t,
									title: `📝 改动 ${files.length} 个文件`,
									summary: files.slice(0, 3).join("、") + (files.length > 3 ? `（等 ${files.length} 个）` : ""),
									source: `工具 · ${toolName}`,
									status: "done",
									turn,
									meta: { tool: toolName, files },
								},
								files.join("\n"),
							);
						}
					}
				} else if (m.role === "bashExecution") {
					const b = (m.content ?? []).find((x) => x?.type === "bash") ?? {};
					addSeg(
						{
							key: `h-${m.id}`,
							kind: "tool",
							lane: "tools",
							t,
							end: t,
							title: `${b.cancelled || (b.exitCode && b.exitCode !== 0) ? "❌" : "✅"} bash · ${firstLine(b.command)}`,
							summary: cut(
								String(b.output ?? "")
									.trim()
									.slice(0, 200) || "完成",
								SUMMARY_CAP,
							),
							source: "工具 · bash",
							status: b.cancelled || (b.exitCode && b.exitCode !== 0) ? "error" : "done",
							turn,
							meta: { tool: "bash", command: cut(String(b.command ?? ""), PREVIEW_CAP), exitCode: b.exitCode },
						},
						`$ ${b.command ?? ""}\n${cut(String(b.output ?? ""), DETAIL_CAP)}`,
					);
				} else if (m.role === "compactionSummary" || m.role === "branchSummary") {
					const text = blockText(m.content, "text", "text").trim();
					if (text) {
						addSeg(
							{
								key: `h-${m.id}`,
								kind: "system",
								lane: "model",
								t,
								end: t,
								title: m.role === "compactionSummary" ? "🗜️ 上下文压缩" : "🌿 分支摘要",
								summary: cut(text, SUMMARY_CAP),
								source: "系统",
								status: "done",
								turn,
								meta: { chars: text.length },
							},
							cut(text, DETAIL_CAP),
						);
					}
				}
			}
			return { segs, full, toolKeys };
		}

		let currentConvId = null;
		const liveTools = (convId, toolCallId) => {
			const c = convs.get(convId ?? "");
			return c ? c.liveTools.has(toolCallId) : false;
		};

		function computeAnalysis(c) {
			const tools = new Map();
			let turns = 0;
			let filesChanged = [];
			let chars = 0;
			let toolErrs = 0;
			let toolMs = 0;
			const counts = { user: 0, thinking: 0, text: 0, tool: 0, file: 0, system: 0 };
			for (const s of c.segs) {
				if (counts[s.kind] !== undefined) counts[s.kind] += 1;
				if (s.kind === "user") turns = Math.max(turns, s.turn ?? 0);
				if (s.meta?.chars) chars += s.meta.chars;
				if (s.kind === "tool" && s.meta?.tool) {
					const st = tools.get(s.meta.tool) ?? { name: s.meta.tool, calls: 0, ms: 0, errs: 0 };
					st.calls += 1;
					if (s.dur !== undefined) {
						st.ms += s.dur;
						toolMs += s.dur;
					}
					if (s.status === "error") {
						st.errs += 1;
						toolErrs += 1;
					}
					tools.set(s.meta.tool, st);
				}
				if (s.kind === "file" && Array.isArray(s.meta?.files)) {
					for (const f of s.meta.files) if (!filesChanged.includes(f)) filesChanged.push(f);
				}
			}
			const startedAt = c.segs.length ? c.segs[0].t : c.updatedAt;
			const lastEnd = c.segs.reduce((m, s) => Math.max(m, s.end ?? s.t), startedAt);
			return {
				startedAt,
				totalMs: Math.max(0, lastEnd - startedAt),
				turns,
				counts,
				toolCalls: [...tools.values()].reduce((n, x) => n + x.calls, 0),
				toolErrs,
				toolMs,
				chars,
				filesChanged: filesChanged.slice(0, 50),
				tools: [...tools.values()].sort((a, b) => b.ms - a.ms).slice(0, 12),
			};
		}

		function refresh() {
			if (disposed) return;
			let snap = null;
			try {
				snap = host.getActiveConversation?.();
			} catch (err) {
				host.log("getActiveConversation failed:", err?.message ?? err);
				return;
			}
			if (!snap) return;
			const c = getConv(snap.conversationId, snap.title);
			const firstSeen = c.updatedAt === 0;
			const becameActive = activeId !== c.id;
			currentConvId = c.id;
			c.isStreaming = !!snap.isStreaming;
			c.title = snap.title || c.title;
			const { segs, full, toolKeys } = buildHistory(snap.messages, snap.streamingMessage);
			for (const [id] of c.liveTools) {
				if (toolKeys.has(id)) c.liveTools.delete(id);
			}
			const live = [...c.liveTools.values()];
			c.segs = [...segs, ...live];
			c.full = full;
			for (const s of live) if (s.detail !== undefined) c.full.set(s.key, s.detail);
			c.analysis = computeAnalysis(c);
			c.updatedAt = Date.now();
			if (becameActive) {
				activeId = c.id;
				for (const x of convs.values()) x.active = x.id === activeId;
			}
			if (becameActive || firstSeen) pushState();
			host.broadcast({ kind: "segs", convId: c.id, reset: true, segs: c.segs });
			host.broadcast({ kind: "conv_update", conv: summaryOf(c) });
			if (firstSeen) host.broadcast({ kind: "conv_new", conv: summaryOf(c) });
		}

		const scheduleRefresh = () => {
			if (refreshTimer) return;
			refreshTimer = setTimeout(() => {
				refreshTimer = null;
				refresh();
			}, REFRESH_DEBOUNCE_MS);
		};

		const offRun = host.onRunEvent((ev) => {
			try {
				if (ev.type === "tool_start") {
					const c = getConv(ev.conversationId ?? currentConvId ?? "unknown", undefined);
					const readonly = READONLY_TOOL_RE.test(String(ev.toolName ?? ""));
					const headline = toolHeadline(ev.toolName, ev.argsText);
					const seg = {
						key: `L-${ev.toolCallId ?? `${Date.now()}`}`,
						kind: "tool",
						lane: "tools",
						t: ev.at,
						end: ev.at,
						title: `${readonly ? "📖" : "🔧"} ${headline}`,
						headline,
						summary: "执行中…",
						source: `工具 · ${ev.toolName}`,
						status: "running",
						turn: 0,
						meta: {
							tool: ev.toolName,
							toolCallId: ev.toolCallId,
							args: cut(String(ev.argsText ?? "null"), PREVIEW_CAP),
							files: extractPaths(ev.argsText),
						},
						detail: cut(String(ev.argsText ?? "null"), DETAIL_CAP),
					};
					if (ev.toolCallId) c.liveTools.set(ev.toolCallId, seg);
					c.segs = [...c.segs, seg];
					c.full.set(seg.key, seg.detail);
					host.broadcast({ kind: "segs", convId: c.id, reset: false, segs: [seg] });
					return;
				}
				if (ev.type === "tool_end") {
					const c = convs.get(ev.conversationId ?? "");
					const seg = ev.toolCallId ? c?.liveTools.get(ev.toolCallId) : undefined;
					if (seg && c) {
						const secs = ev.durationMs !== undefined ? ` · ${(ev.durationMs / 1000).toFixed(1)}s` : "";
						const preview = cut(String(ev.resultText ?? ""), DETAIL_CAP).trim();
						const patch = {
							status: ev.isError ? "error" : "done",
							end: ev.at,
							...(ev.durationMs !== undefined ? { dur: ev.durationMs } : {}),
							title: `${ev.isError ? "❌" : "✅"} ${seg.headline ?? ev.toolName}`,
							summary: cut(
								ev.isError ? `失败${secs}` : preview ? `${preview.slice(0, 200)}${secs}` : `完成${secs}`,
								SUMMARY_CAP,
							),
							source: seg.source,
							turn: seg.turn,
							meta: { ...(seg.meta ?? {}), result: cut(String(ev.resultText ?? ""), PREVIEW_CAP), dur: ev.durationMs },
						};
						Object.assign(seg, patch);
						const detail = preview || "(无输出)";
						seg.detail = detail;
						c.full.set(seg.key, detail);
						host.broadcast({ kind: "seg_update", convId: c.id, key: seg.key, patch });
					}
					scheduleRefresh();
					return;
				}
				scheduleRefresh();
			} catch (err) {
				host.log("run event failed:", err?.message ?? err);
			}
		});

		const offMsg = host.onMessage((payload, from) => {
			const msg = payload ?? {};
			try {
				switch (msg.action) {
					case "state":
						pushState(from);
						scheduleRefresh();
						break;
					case "get_conv": {
						const c = convs.get(String(msg.convId ?? ""));
						if (c && from) {
							host.sendTo(from, { kind: "segs", convId: c.id, reset: true, segs: c.segs });
							host.sendTo(from, { kind: "conv_update", conv: summaryOf(c) });
						} else if (from) {
							scheduleRefresh();
							host.sendTo(from, { kind: "segs", convId: String(msg.convId ?? ""), reset: true, segs: [] });
						}
						break;
					}
					case "get_seg": {
						const c = convs.get(String(msg.convId ?? ""));
						const seg = c?.segs.find((s) => s.key === String(msg.key ?? ""));
						if (c && seg && from) {
							host.sendTo(from, {
								kind: "seg_detail",
								convId: c.id,
								key: seg.key,
								detail: c.full.get(seg.key) ?? seg.summary ?? "",
								seg,
								analysis: segAnalysis(c, seg),
							});
						}
						break;
					}
					case "clear":
						convs.clear();
						activeId = null;
						currentConvId = null;
						host.broadcast({ kind: "cleared" });
						pushState();
						scheduleRefresh();
						break;
					default:
						break;
				}
			} catch (err) {
				host.log("message failed:", err?.message ?? err);
			}
		});

		function segAnalysis(c, seg) {
			const a = c.analysis;
			const total = c.segs.length || 1;
			const idx = c.segs.findIndex((s) => s.key === seg.key);
			const base = {
				position: idx >= 0 ? `#${idx + 1}/${total}` : "—",
				turnText: seg.turn ? `第 ${seg.turn} 轮` : "—",
				convTurns: a?.turns ?? 0,
			};
			if (seg.kind === "tool" && seg.meta?.tool && a) {
				const st = a.tools.find((x) => x.name === seg.meta.tool);
				return {
					...base,
					tool: st ?? { name: seg.meta.tool, calls: 1, ms: seg.dur ?? 0, errs: seg.status === "error" ? 1 : 0 },
					convToolCalls: a.toolCalls,
					convToolMs: a.toolMs,
				};
			}
			return base;
		}

		const offConvChanged = host.onConversationChanged ? host.onConversationChanged(() => scheduleRefresh()) : () => {};

		const offAttach = host.onAttach((clientId) => {
			try {
				pushState(clientId);
				scheduleRefresh();
			} catch (err) {
				host.log("attach push failed:", err?.message ?? err);
			}
		});

		const poll = () => {
			if (disposed) return;
			try {
				const streaming = [...convs.values()].some((c) => c.isStreaming);
				refresh();
				pollTimer = setTimeout(poll, streaming ? POLL_STREAMING_MS : POLL_IDLE_MS);
			} catch {
				pollTimer = setTimeout(poll, POLL_IDLE_MS);
			}
		};
		refresh();
		pollTimer = setTimeout(poll, POLL_STREAMING_MS);

		host.log("activated (v2: 当前对话时间线 + 分析)");
		return () => {
			disposed = true;
			offRun();
			offMsg();
			offAttach();
			offConvChanged();
			if (refreshTimer) clearTimeout(refreshTimer);
			if (pollTimer) clearTimeout(pollTimer);
		};
	},
};
