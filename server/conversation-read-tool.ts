import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { pick, type ServerLang } from "./i18n.js";
import type { AgentMessage } from "./serialize.js";
import {
	extractTouches,
	formatTouchEntry,
	formatTouchesCompact,
	toolCallRefsOfContent,
	type TouchedFile,
	unionTouchLists,
} from "./conversation-touches.js";
import type { ClaimView } from "./claim-store.js";

export interface ConversationListEntry {
	id: string;
	title: string;
	cwd: string;
	messageCount: number;
	isStreaming: boolean;
	isSubagent: boolean;
	parentId?: string;
}

export interface HistorySessionEntry {
	path: string;
	name?: string;
	firstMessage: string;
	messageCount: number;
	modified: number;
	cwd: string;
}

export interface TranscriptInputMessage {
	role: string;
	content?: unknown;
	toolName?: string;
	isError?: boolean;
	command?: string;
	output?: string;
	summary?: string;
	details?: unknown;
	timestamp?: number;
	toolCalls?: { name: string; args?: unknown }[];
}

export interface ConversationReadHost {
	readTouchSidecar?(id?: string, path?: string): TouchedFile[] | undefined;
	listRunningConversations(): ConversationListEntry[];
	readRunningConversation(
		id: string,
	): { title: string; cwd: string; isSubagent: boolean; messages: TranscriptInputMessage[] } | undefined;
	listHistorySessions(scope: "current" | "all", cwd: string): Promise<HistorySessionEntry[]>;
	readHistorySession(path: string): Promise<
		| {
				title: string;
				cwd: string;
				sessionPath: string;
				messages: TranscriptInputMessage[];
		  }
		| undefined
	>;
}

function fillToolCalls(target: TranscriptInputMessage, content: unknown): void {
	const refs = toolCallRefsOfContent(content);
	if (refs.length > 0) target.toolCalls = refs;
}

export function toTranscriptInput(m: AgentMessage): TranscriptInputMessage {
	const role = (m as { role?: unknown }).role;
	const r = typeof role === "string" ? role : "unknown";
	const base: TranscriptInputMessage = { role: r };
	const anyM = m as unknown as Record<string, unknown>;
	if (typeof anyM.content !== "undefined") {
		base.content = anyM.content;
		fillToolCalls(base, anyM.content);
	}
	if (typeof anyM.toolName === "string") base.toolName = anyM.toolName;
	if (typeof anyM.isError === "boolean") base.isError = anyM.isError;
	if (typeof anyM.command === "string") base.command = anyM.command;
	if (typeof anyM.output === "string") base.output = anyM.output;
	if (typeof anyM.summary === "string") base.summary = anyM.summary;
	if (typeof anyM.details !== "undefined") base.details = anyM.details;
	if (typeof anyM.timestamp === "number") base.timestamp = anyM.timestamp;
	return base;
}

function textOfContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const b of content) {
		if (!b || typeof b !== "object") continue;
		const blk = b as { type?: unknown; text?: unknown; name?: unknown };
		if (blk.type === "text" && typeof blk.text === "string") {
			parts.push(blk.text);
		} else if (blk.type === "image") {
			parts.push("[image]");
		} else if (typeof blk.name === "string" && blk.name) {
			parts.push(`[tool call: ${blk.name}]`);
		} else {
			parts.push("[…]");
		}
	}
	return parts.join("\n");
}

function attachmentName(details: unknown): string {
	if (!details || typeof details !== "object") return "";
	const d = details as { name?: unknown; path?: unknown };
	if (typeof d.name === "string" && d.name) return d.name;
	if (typeof d.path === "string" && d.path) return d.path.split(/[\\/]/).pop() ?? d.path;
	return "";
}

export function transcriptText(m: TranscriptInputMessage): string {
	switch (m.role) {
		case "bashExecution":
			return `[bash $ ${m.command ?? ""}]\n${m.output ?? ""}`;
		case "branchSummary":
			return `[branch summary]\n${m.summary ?? ""}`;
		case "compactionSummary":
			return `[compaction summary]\n${m.summary ?? ""}`;
		case "toolResult": {
			const head = `[tool result${m.toolName ? ` (${m.toolName})` : ""}${m.isError ? " ERROR" : ""}]`;
			const body = textOfContent(m.content);
			return body ? `${head}\n${body}` : head;
		}
		case "custom": {
			const name = attachmentName(m.details);
			const body = textOfContent(m.content);
			const head = name ? `[attachment: ${name}]` : "[note]";
			return body ? `${head}\n${body}` : head;
		}
		case "user":
		case "assistant":
			return textOfContent(m.content);
		default: {
			const body = textOfContent(m.content);
			return body ? `[${m.role}]\n${body}` : `[${m.role}]`;
		}
	}
}

function roleLabel(m: TranscriptInputMessage): string {
	if (m.role === "toolResult") return `tool result${m.toolName ? ` (${m.toolName})` : ""}`;
	return m.role;
}

export function truncateCounted(s: string, cap: number): string {
	if (s.length <= cap) return s;
	return `${s.slice(0, cap)}\n… +${s.length - cap} chars`;
}

function trunc(s: string, cap: number): string {
	return truncateCounted(s, cap);
}

export interface FormatTranscriptOpts {
	offset?: number;
	limit?: number;
	perMsgCap?: number;
	maxChars?: number;
}

export interface FormattedTranscript {
	text: string;
	total: number;
	from: number;
	to: number;
	truncated: boolean;
}

export function formatTranscript(messages: TranscriptInputMessage[], opts?: FormatTranscriptOpts): FormattedTranscript {
	const total = messages.length;
	const offset = Math.max(0, Math.floor(opts?.offset ?? 0));
	const limit = Math.min(200, Math.max(1, Math.floor(opts?.limit ?? 50)));
	const perMsgCap = Math.max(100, Math.floor(opts?.perMsgCap ?? 2000));
	const maxChars = Math.min(60000, Math.max(1000, Math.floor(opts?.maxChars ?? 20000)));
	const from = Math.min(offset, total);
	const to = Math.min(from + limit, total);
	const lines: string[] = [];
	for (let i = from; i < to; i++) {
		const m = messages[i];
		lines.push(`[${i + 1}/${total} ${roleLabel(m)}]\n${trunc(transcriptText(m).trim(), perMsgCap)}`);
	}
	let text = lines.join("\n\n");
	let truncated = to < total;
	if (text.length > maxChars) {
		text = `${text.slice(0, maxChars)}\n… [truncated]`;
		truncated = true;
	}
	if (total === 0) text = "";
	return { text, total, from, to, truncated };
}

export function parseTranscriptLines(text: string): TranscriptInputMessage[] {
	const out: TranscriptInputMessage[] = [];
	for (const line of text.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		let e: {
			type?: unknown;
			message?: {
				role?: unknown;
				content?: unknown;
				toolName?: unknown;
				isError?: unknown;
				details?: unknown;
				timestamp?: unknown;
			};
			summary?: unknown;
		};
		try {
			e = JSON.parse(t);
		} catch {
			continue;
		}
		if (e?.type === "message" && e.message && typeof e.message.role === "string") {
			const msg = e.message;
			const m: TranscriptInputMessage = { role: msg.role as string };
			if (typeof msg.content !== "undefined") {
				m.content = msg.content;
				fillToolCalls(m, msg.content);
			}
			if (typeof msg.toolName === "string") m.toolName = msg.toolName;
			if (typeof msg.isError === "boolean") m.isError = msg.isError;
			if (typeof msg.details !== "undefined") m.details = msg.details;
			if (typeof msg.timestamp === "number") m.timestamp = msg.timestamp;
			out.push(m);
			continue;
		}
		if ((e?.type === "compaction" || e?.type === "branch_summary") && typeof e.summary === "string") {
			out.push({
				role: e.type === "compaction" ? "compactionSummary" : "branchSummary",
				summary: e.summary,
			});
		}
	}
	return out;
}

function matchesHay(hay: string, q: string): boolean {
	return q === "" || hay.toLowerCase().includes(q);
}

export type ReadView = "chat" | "full";

export interface ReadSelectionOpts {
	view?: ReadView;
	last?: number;
	query?: string;
}

export interface ReadSelection {
	selected: TranscriptInputMessage[];
	totalInView: number;
	hitIndices: number[];
}

export function selectReadMessages(messages: TranscriptInputMessage[], opts?: ReadSelectionOpts): ReadSelection {
	const list = Array.isArray(messages) ? messages : [];
	const view: ReadView = opts?.view === "full" ? "full" : "chat";
	const inView = view === "full" ? list : list.filter((m) => m.role === "user" || m.role === "assistant");
	const q = (opts?.query ?? "").trim().toLowerCase();
	let selected = inView;
	let hitIndices: number[] = [];
	if (q) {
		const hits: number[] = [];
		const keep = new Set<number>();
		for (let i = 0; i < inView.length; i++) {
			if (transcriptText(inView[i]).toLowerCase().includes(q)) {
				hits.push(i);
				for (let j = Math.max(0, i - 1); j <= Math.min(inView.length - 1, i + 1); j++) keep.add(j);
			}
		}
		hitIndices = hits;
		selected = [...keep].sort((a, b) => a - b).map((i) => inView[i]);
	}
	const last = opts?.last;
	if (typeof last === "number" && Number.isFinite(last)) {
		const n = Math.min(200, Math.max(1, Math.floor(last)));
		if (selected.length > n) {
			selected = selected.slice(selected.length - n);
			if (hitIndices.length > 0) {
				const keep = new Set(selected);
				hitIndices = hitIndices.filter((i) => keep.has(inView[i]));
			}
		}
	}
	return { selected, totalInView: inView.length, hitIndices };
}

function toolHint(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const a = args as { path?: unknown; file_path?: unknown; filePath?: unknown; command?: unknown };
	for (const k of ["path", "file_path", "filePath", "command"] as const) {
		const v = a[k];
		if (typeof v === "string" && v.trim()) {
			const oneLine = v.trim().replace(/\s+/g, " ");
			return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
		}
	}
	return "";
}

export interface ConversationSummary {
	lastTool?: { name: string; hint: string };
	lastAssistant?: string;
	waitingQuestion: boolean;
}

export function summarizeConversation(messages: TranscriptInputMessage[]): ConversationSummary {
	const list = Array.isArray(messages) ? messages : [];
	let lastTool: ConversationSummary["lastTool"];
	let lastAssistant: ConversationSummary["lastAssistant"];
	let lastAskIdx = -1;
	let lastAskResultIdx = -1;
	for (let i = 0; i < list.length; i++) {
		const m = list[i];
		if (!m || typeof m !== "object") continue;
		if (m.role === "assistant") {
			const textParts: string[] = [];
			const calls = toolCallRefsOfContent(m.content);
			if (m.toolCalls && m.toolCalls.length > 0) {
				for (const c of m.toolCalls) {
					if (c && typeof c.name === "string") {
						lastTool = { name: c.name, hint: toolHint(c.args) };
						if (c.name === "ask_user_question") lastAskIdx = i;
					}
				}
			} else {
				for (const c of calls) {
					lastTool = { name: c.name, hint: toolHint(c.args) };
					if (c.name === "ask_user_question") lastAskIdx = i;
				}
			}
			if (Array.isArray(m.content)) {
				for (const b of m.content) {
					if (b && typeof b === "object" && (b as { type?: unknown }).type === "text") {
						const t = (b as { text?: unknown }).text;
						if (typeof t === "string" && t) textParts.push(t);
					}
				}
			}
			const joined = textParts.join("\n").trim();
			if (joined) lastAssistant = joined;
		} else if (m.role === "bashExecution" && typeof m.command === "string") {
			lastTool = { name: "bash", hint: toolHint({ command: m.command }) };
		} else if (m.role === "toolResult" && m.toolName === "ask_user_question") {
			lastAskResultIdx = i;
		}
	}
	return { lastTool, lastAssistant, waitingQuestion: lastAskIdx >= 0 && lastAskResultIdx < lastAskIdx };
}

export function readExtraLines(
	L: ServerLang,
	query: string,
	sel: ReadSelection,
	rawTotal: number,
	view: ReadView,
): string {
	const lines: string[] = [];
	const q = query.trim();
	if (q && sel.hitIndices.length > 0) {
		const shown = sel.hitIndices.slice(0, 20).map((i) => i + 1);
		const idx = sel.hitIndices.length > 20 ? `${shown.join("、")}… (+${sel.hitIndices.length - 20})` : shown.join("、");
		lines.push(
			pick(
				L,
				`在对话内搜「${q}」：命中 ${sel.hitIndices.length} 条（选区第 ${idx} 条），上下文共 ${sel.selected.length} 条。`,
				`Searched for "${q}": ${sel.hitIndices.length} hit(s) (#${idx} in this selection), ${sel.selected.length} with context.`,
				"convread.read.query.head",
				{ q, hits: sel.hitIndices.length, indices: idx, shown: sel.selected.length },
			),
		);
	}
	if (view === "chat" && rawTotal > sel.totalInView) {
		lines.push(
			pick(
				L,
				`（chat 视图只含 user/assistant 共 ${sel.totalInView} 条；另有 ${rawTotal - sel.totalInView} 条工具调用/结果，用 view="full" 看。）`,
				`(chat view: only user/assistant, ${sel.totalInView} messages; ${rawTotal - sel.totalInView} more tool messages with view="full".)`,
				"convread.read.chat.note",
				{ chat: sel.totalInView, tools: rawTotal - sel.totalInView },
			),
		);
	}
	return lines.length > 0 ? `\n${lines.join("\n")}` : "";
}

export function formatClaimLines(claims: ClaimView[], maxItems = 5, style: "bullets" | "inline" = "bullets"): string[] {
	const list = Array.isArray(claims) ? claims : [];
	const shown = list.slice(0, Math.max(1, Math.floor(maxItems)));
	const dash = style === "bullets" ? "- " : "";
	const lines = shown.map((c) => `${dash}${c.path} · 「${c.ownerTitle}」${c.note ? ` · ${c.note}` : ""}`);
	if (list.length > shown.length) lines.push(`… (+${list.length - shown.length})`);
	return lines;
}

export function filterRunning(list: ConversationListEntry[], query: string): ConversationListEntry[] {
	const q = query.trim().toLowerCase();
	if (!q) return list;
	return list.filter((c) => matchesHay(c.id, q) || matchesHay(c.title, q) || matchesHay(c.cwd, q));
}

export function filterHistory(list: HistorySessionEntry[], query: string): HistorySessionEntry[] {
	const q = query.trim().toLowerCase();
	if (!q) return list;
	return list.filter((s) => matchesHay(s.path, q) || matchesHay(s.name ?? "", q) || matchesHay(s.firstMessage, q));
}

export function shortPath(p: string, keep = 48): string {
	return p.length <= keep ? p : `…${p.slice(p.length - keep)}`;
}

export const HISTORY_LIST_DEFAULT = 15;
export const RUNNING_LIST_CAP = 50;
export const READ_PER_MSG_CAP = 600;

export interface ConversationReadExtras {
	listClaims?: (cwd: string) => ClaimView[];
}

export function makeConversationReadTool(
	host: ConversationReadHost,
	lang?: () => ServerLang,
	extras?: ConversationReadExtras,
): ToolDefinition {
	const getLang: () => ServerLang = lang ?? (() => "en");
	const text = (t: string, details: unknown = {}): { content: { type: "text"; text: string }[]; details: unknown } => ({
		content: [{ type: "text", text: t }],
		details,
	});
	return defineTool({
		name: "conversation_read",
		label: "Read another conversation",
		description:
			"Read ANOTHER conversation: a running conversation of this client (incl. subagents — id from action=list) " +
			"or a persisted history session (file path). Use it whenever the user references another chat. " +
			"Only listed sessions are readable; other tabs' live runs appear in history once persisted.",
		promptSnippet: "inspect another conversation the user mentions (list/read/files/status)",
		parameters: Type.Object({
			action: Type.Optional(
				Type.String({
					description:
						'Default "list": running conversations + history sessions; read = one transcript (≤600 chars/msg); ' +
						"files = files it created/modified; status = last tool call, last assistant text, pending question.",
				}),
			),
			scope: Type.Optional(
				Type.String({
					description: 'list only: "current" = this project, "all" = every project. Default "all".',
				}),
			),
			kind: Type.Optional(
				Type.String({
					description: 'list only: "running" | "history" | "all" (which sections to show). Default "all".',
				}),
			),
			query: Type.Optional(
				Type.String({
					description:
						"list: case-insensitive filter over id/title/path/first message. read/files: search within the transcript (read returns hits ±1 context).",
				}),
			),
			view: Type.Optional(
				Type.String({
					description:
						'read only: "chat" = only user/assistant text (default, cheap); "full" = incl. tool calls/results.',
				}),
			),
			last: Type.Optional(
				Type.Number({ description: "read only: take the latest N messages instead of guessing offset." }),
			),
			id: Type.Optional(
				Type.String({ description: 'read only: running conversation id (e.g. "c3"), from action=list.' }),
			),
			path: Type.Optional(Type.String({ description: "read only: history session file path, from action=list." })),
			offset: Type.Optional(Type.Number({ description: "read only: first message index (0-based). Default 0." })),
			limit: Type.Optional(
				Type.Number({
					description:
						"list: max entries per section (history defaults to 15, running uncapped up to 50). read/files: max messages/entries (1-200, default 50).",
				}),
			),
			maxChars: Type.Optional(Type.Number({ description: "read only: max characters. Default 20000." })),
		}),
		execute: async (_id, p, _signal, _onUpdate, ctx) => {
			const action = (p.action ?? "list").trim().toLowerCase();
			if (action === "list") {
				const scopeRaw = (p.scope ?? "all").trim().toLowerCase();
				if (scopeRaw !== "current" && scopeRaw !== "all") {
					return text(
						pick(
							getLang(),
							`scope 非法：${p.scope}（只能是 current 或 all）。`,
							`Invalid scope: ${p.scope} (must be "current" or "all").`,
							"convread.list.bad.scope",
							{ "p.scope": p.scope },
						),
					);
				}
				const scope = scopeRaw as "current" | "all";
				const kindRaw = (p.kind ?? "all").trim().toLowerCase();
				if (kindRaw !== "running" && kindRaw !== "history" && kindRaw !== "all") {
					return text(
						pick(
							getLang(),
							`kind 非法：${p.kind}（只能是 running、history 或 all）。`,
							`Invalid kind: ${p.kind} (must be "running", "history" or "all").`,
							"convread.list.bad.kind",
							{ "p.kind": p.kind },
						),
					);
				}
				const kind = kindRaw as "running" | "history" | "all";
				const query = typeof p.query === "string" ? p.query : "";
				const cap =
					typeof p.limit === "number" && Number.isFinite(p.limit)
						? Math.min(200, Math.max(1, Math.floor(p.limit)))
						: undefined;
				const running = kind === "history" ? [] : filterRunning(host.listRunningConversations(), query);
				const history = kind === "running" ? [] : filterHistory(await host.listHistorySessions(scope, ctx.cwd), query);
				const shownRunning = running.slice(0, cap ?? RUNNING_LIST_CAP);
				const shownHistory = history.slice(0, cap ?? HISTORY_LIST_DEFAULT);
				const L = getLang();
				const runLines = shownRunning.map(
					(c) =>
						`- ${c.id} · ${c.title} · ${c.isSubagent ? (L === "zh" ? "子代理" : "subagent") : L === "zh" ? "对话" : "chat"}${
							c.isStreaming ? (L === "zh" ? "（进行中）" : " (streaming)") : ""
						} · ${c.messageCount} msgs · ${c.cwd}`,
				);
				const histLines = shownHistory.map(
					(s) =>
						`- ${shortPath(s.path)} · ${s.name || s.firstMessage || (L === "zh" ? "（空对话）" : "(empty)")}${
							s.messageCount ? ` · ${s.messageCount} msgs` : ""
						}`,
				);
				if (running.length > shownRunning.length) {
					runLines.push(
						pick(
							L,
							`… 还有 ${running.length - shownRunning.length} 条运行中（用 query 或 limit 收窄）。`,
							`… ${running.length - shownRunning.length} more running (narrow with query or limit).`,
							"convread.list.running.more",
							{ n: running.length - shownRunning.length },
						),
					);
				}
				if (history.length > shownHistory.length) {
					const n = history.length - shownHistory.length;
					histLines.push(
						pick(
							L,
							`… 还有 ${n} 条历史（用 query 或 limit 收窄；默认只给 ${HISTORY_LIST_DEFAULT} 条）。`,
							`… ${n} more history (narrow with query or limit; default shows ${HISTORY_LIST_DEFAULT}).`,
							"convread.list.history.more",
							{ n, def: HISTORY_LIST_DEFAULT },
						),
					);
				}
				const head =
					kind === "running"
						? pick(
								L,
								`运行中对话（${running.length}）：`,
								`Running conversations (${running.length}):`,
								"convread.list.head.running",
								{ n: running.length },
							)
						: kind === "history"
							? pick(
									L,
									`历史会话（${history.length}，scope=${scope}）：`,
									`History sessions (${history.length}, scope=${scope}):`,
									"convread.list.head.history",
									{ n: history.length, scope },
								)
							: pick(
									L,
									`运行中对话（${running.length}）+ 历史会话（${history.length}，scope=${scope}）：`,
									`Running conversations (${running.length}) + history sessions (${history.length}, scope=${scope}):`,
									"convread.list.head.all",
									{ running: running.length, history: history.length, scope },
								);
				const runHead = L === "zh" ? "【运行中】" : "[running]";
				const histHead = L === "zh" ? "【历史】" : "[history]";
				const empty = L === "zh" ? "（无）" : "(none)";
				const tail =
					L === "zh"
						? `读某一份：conversation(action="read", id="c…") 或 conversation(action="read", path="…")，长转录用 offset/limit 翻页；只看文件用 action="files"，先看摘要再决定读不读用 action="status"。`
						: `To read one: conversation(action="read", id="c…") or conversation(action="read", path="…"); page long transcripts with offset/limit; action="files" lists touched files, action="status" summarizes before you decide to read.`;
				const sections =
					kind === "history"
						? `${head}\n${histHead}\n${histLines.join("\n") || empty}`
						: kind === "running"
							? `${head}\n${runHead}\n${runLines.join("\n") || empty}`
							: `${head}\n${runHead}\n${runLines.join("\n") || empty}\n${histHead}\n${histLines.join("\n") || empty}`;
				return text(`${sections}\n${tail}`, {
					scope,
					kind,
					runningTotal: running.length,
					historyTotal: history.length,
					running: shownRunning,
					history: shownHistory.map((s) => ({
						...s,
						firstMessage:
							typeof s.firstMessage === "string" && s.firstMessage.length > 160
								? `${s.firstMessage.slice(0, 160)}…`
								: s.firstMessage,
					})),
					truncated: running.length > shownRunning.length || history.length > shownHistory.length,
				});
			}
			if (action === "read") {
				const viewRaw = (p.view ?? "chat").trim().toLowerCase();
				if (viewRaw !== "chat" && viewRaw !== "full") {
					return text(
						pick(
							getLang(),
							`view 非法：${p.view}（只能是 chat 或 full）。`,
							`Invalid view: ${p.view} (must be "chat" or "full").`,
							"convread.read.bad.view",
							{ "p.view": p.view },
						),
					);
				}
				const view = viewRaw as ReadView;
				const id = typeof p.id === "string" && p.id.trim() ? p.id.trim() : undefined;
				const path = typeof p.path === "string" && p.path.trim() ? p.path.trim() : undefined;
				if ((id && path) || (!id && !path)) {
					return text(
						pick(
							getLang(),
							`action=read 需要且只需要 id 或 path 其中之一（id 读运行中对话，path 读历史转录）。`,
							`action=read needs exactly one of id or path (id = running conversation, path = history transcript).`,
							"convread.read.bad.args",
						),
					);
				}
				const query = typeof p.query === "string" ? p.query : "";
				const opts = { offset: p.offset, limit: p.limit, maxChars: p.maxChars, perMsgCap: READ_PER_MSG_CAP };
				if (id) {
					const found = host.readRunningConversation(id);
					if (!found) {
						return text(
							pick(
								getLang(),
								`未找到运行中对话 ${id}（可能已关闭；用 action=list 看当前列表，落盘的可按 path 读历史）。`,
								`Running conversation ${id} not found (may be closed; use action=list for the current list, or read persisted ones by path).`,
								"convread.read.id.not.found",
								{ id },
							),
						);
					}
					const rawTotal = found.messages.length;
					const sel = selectReadMessages(found.messages, { view, last: p.last, query });
					const L = getLang();
					if (query.trim() && sel.hitIndices.length === 0) {
						return text(
							pick(
								L,
								`在对话内搜「${query.trim()}」：没有命中。换个词，或用 view="full" 把工具输出也纳入搜索。`,
								`No hits for "${query.trim()}". Try another term, or use view="full" to include tool outputs.`,
								"convread.read.query.empty",
								{ q: query.trim() },
							),
							{ id, title: found.title, view, query: query.trim(), hits: 0 },
						);
					}
					const f = formatTranscript(sel.selected, opts);
					const head =
						L === "zh"
							? `对话「${found.title}」（id=${id}${found.isSubagent ? "，子代理" : ""}，${found.cwd}，共 ${f.total} 条，${f.from + 1}-${f.to}）：`
							: `Conversation "${found.title}" (id=${id}${found.isSubagent ? ", subagent" : ""}, ${found.cwd}, ${f.total} messages, showing ${f.from + 1}-${f.to}):`;
					const notes = readExtraLines(L, query, sel, rawTotal, view);
					const more =
						f.truncated && f.total > 0
							? L === "zh"
								? `\n…还有后文（offset=${f.to} 再取）。`
								: `\n…more below (re-call with offset=${f.to}).`
							: "";
					const emptyNote = f.total === 0 ? (L === "zh" ? "（该对话暂无消息）" : "(no messages yet)") : "";
					return text(`${head}${notes}\n${f.text || emptyNote}${more}`, {
						id,
						title: found.title,
						view,
						...(query.trim() ? { query: query.trim(), hitIndices: sel.hitIndices.slice(0, 500) } : {}),
						total: f.total,
						rawTotal,
						from: f.from,
						to: f.to,
					});
				}
				const found = await host.readHistorySession(path!);
				if (!found) {
					return text(
						pick(
							getLang(),
							`读不到历史会话 ${path}（不在会话列表里：只能读 action=list 列出的转录路径）。`,
							`Cannot read history session ${path} (not in the session list: only transcripts from action=list can be read).`,
							"convread.read.path.not.found",
							{ path },
						),
					);
				}
				const rawTotal = found.messages.length;
				const sel = selectReadMessages(found.messages, { view, last: p.last, query });
				const L = getLang();
				if (query.trim() && sel.hitIndices.length === 0) {
					return text(
						pick(
							L,
							`在对话内搜「${query.trim()}」：没有命中。换个词，或用 view="full" 把工具输出也纳入搜索。`,
							`No hits for "${query.trim()}". Try another term, or use view="full" to include tool outputs.`,
							"convread.read.query.empty",
							{ q: query.trim() },
						),
						{ path: found.sessionPath, title: found.title, view, query: query.trim(), hits: 0 },
					);
				}
				const f = formatTranscript(sel.selected, opts);
				const head =
					L === "zh"
						? `历史会话「${found.title || found.sessionPath}」（${found.cwd}，共 ${f.total} 条，${f.from + 1}-${f.to}）：`
						: `History session "${found.title || found.sessionPath}" (${found.cwd}, ${f.total} messages, showing ${f.from + 1}-${f.to}):`;
				const notes = readExtraLines(L, query, sel, rawTotal, view);
				const more =
					f.truncated && f.total > 0
						? L === "zh"
							? `\n…还有后文（offset=${f.to} 再取）。`
							: `\n…more below (re-call with offset=${f.to}).`
						: "";
				const emptyNote = f.total === 0 ? (L === "zh" ? "（该会话暂无消息）" : "(no messages yet)") : "";
				return text(`${head}${notes}\n${f.text || emptyNote}${more}`, {
					path: found.sessionPath,
					title: found.title,
					view,
					...(query.trim() ? { query: query.trim(), hitIndices: sel.hitIndices.slice(0, 500) } : {}),
					total: f.total,
					rawTotal,
					from: f.from,
					to: f.to,
				});
			}
			if (action === "files" || action === "status") {
				const id = typeof p.id === "string" && p.id.trim() ? p.id.trim() : undefined;
				const path = typeof p.path === "string" && p.path.trim() ? p.path.trim() : undefined;
				if ((id && path) || (!id && !path)) {
					return text(
						pick(
							getLang(),
							`action=${action} 需要且只需要 id 或 path 其中之一（id 读运行中对话，path 读历史转录）。`,
							`action=${action} needs exactly one of id or path (id = running conversation, path = history transcript).`,
							action === "files" ? "convread.files.bad.args" : "convread.status.bad.args",
						),
					);
				}
				let title = "";
				let cwd = "";
				let messages: TranscriptInputMessage[] = [];
				if (id) {
					const found = host.readRunningConversation(id);
					if (!found) {
						return text(
							pick(
								getLang(),
								`未找到运行中对话 ${id}（可能已关闭；用 action=list 看当前列表，落盘的可按 path 读历史）。`,
								`Running conversation ${id} not found (may be closed; use action=list for the current list, or read persisted ones by path).`,
								"convread.read.id.not.found",
								{ id },
							),
						);
					}
					title = found.title;
					cwd = found.cwd;
					messages = found.messages;
				} else {
					const found = await host.readHistorySession(path!);
					if (!found) {
						return text(
							pick(
								getLang(),
								`读不到历史会话 ${path}（不在会话列表里：只能读 action=list 列出的转录路径）。`,
								`Cannot read history session ${path} (not in the session list: only transcripts from action=list can be read).`,
								"convread.read.path.not.found",
								{ path },
							),
						);
					}
					title = found.title || found.sessionPath;
					cwd = found.cwd;
					messages = found.messages;
				}
				const L = getLang();
				const where = id ? { id } : { path };
				if (action === "files") {
					const fq = (typeof p.query === "string" ? p.query : "").trim().toLowerCase();
					const all = unionTouchLists(host.readTouchSidecar?.(id, path) ?? [], extractTouches(messages));
					const filtered = fq ? all.filter((t) => t.path.toLowerCase().includes(fq)) : all;
					const listedClaims = (() => {
						try {
							const rows = extras?.listClaims?.(cwd) ?? [];
							return fq ? rows.filter((c) => c.path.toLowerCase().includes(fq)) : rows;
						} catch {
							return [];
						}
					})();
					const cap =
						typeof p.limit === "number" && Number.isFinite(p.limit)
							? Math.min(200, Math.max(1, Math.floor(p.limit)))
							: 50;
					const shown = filtered.slice(0, cap);
					if (filtered.length === 0 && listedClaims.length === 0) {
						return text(
							pick(
								L,
								`对话「${title}」还没有可识别的文件写入（只读围观/刚开场/压缩丢了旧记录都有可能）。`,
								`Conversation "${title}" has no recognizable file writes yet (read-only so far, just started, or pre-compaction touches lost).`,
								"convread.files.empty",
								{ title },
							),
							{ ...where, title, total: 0, files: [] },
						);
					}
					const sections: string[] = [];
					if (filtered.length > 0) {
						const lines = shown.map((t) => `- ${formatTouchEntry(t)}`);
						if (filtered.length > shown.length) {
							lines.push(
								pick(
									L,
									`… 还有 ${filtered.length - shown.length} 个（用 query 或 limit 收窄）。`,
									`… ${filtered.length - shown.length} more (narrow with query or limit).`,
									"convread.files.more",
									{ n: filtered.length - shown.length },
								),
							);
						}
						sections.push(
							`${pick(
								L,
								`对话「${title}」创建/修改过的文件（${filtered.length} 个，只算写不算读）：`,
								`Files created/modified by "${title}" (${filtered.length}, writes only):`,
								"convread.files.head",
								{ title, total: filtered.length },
							)}\n${lines.join("\n")}`,
						);
					}
					if (listedClaims.length > 0) {
						sections.push(
							`${pick(
								L,
								`本项目认领（${listedClaims.length} 条，绕行参考，先到先得）：`,
								`Claims in this project (${listedClaims.length}, steer clear, first-wins):`,
								"convread.files.claims",
								{ total: listedClaims.length },
							)}\n${formatClaimLines(listedClaims).join("\n")}`,
						);
					}
					return text(sections.join("\n"), {
						...where,
						title,
						total: filtered.length,
						files: shown,
						claims: listedClaims.map((c) => ({ path: c.path, ownerTitle: c.ownerTitle })),
					});
				}
				const sum = summarizeConversation(messages);
				const touched = unionTouchLists(host.readTouchSidecar?.(id, path) ?? [], extractTouches(messages)).slice(0, 6);
				let statusClaims: ClaimView[] = [];
				try {
					statusClaims = extras?.listClaims?.(cwd) ?? [];
				} catch {
					statusClaims = [];
				}
				const head = pick(
					L,
					`对话「${title}」状态（共 ${messages.length} 条）：`,
					`Status of "${title}" (${messages.length} messages):`,
					"convread.status.head",
					{ title, total: messages.length },
				);
				const toolLine = sum.lastTool
					? pick(
							L,
							`最后工具：${sum.lastTool.name}${sum.lastTool.hint ? `（${sum.lastTool.hint}）` : ""}。`,
							`Last tool: ${sum.lastTool.name}${sum.lastTool.hint ? ` (${sum.lastTool.hint})` : ""}.`,
							"convread.status.last.tool",
							{ name: sum.lastTool.name, hint: sum.lastTool.hint },
						)
					: pick(L, `还没调用过工具。`, `No tool calls yet.`, "convread.status.no.tool");
				const sayLine = sum.lastAssistant
					? pick(
							L,
							`最后一句：${truncateCounted(sum.lastAssistant, 200)}`,
							`Last assistant message: ${truncateCounted(sum.lastAssistant, 200)}`,
							"convread.status.last.say",
							{ text: truncateCounted(sum.lastAssistant, 200) },
						)
					: pick(L, `assistant 还没说过话。`, `No assistant message yet.`, "convread.status.no.say");
				const touchLine =
					touched.length > 0
						? pick(
								L,
								`最近动过：${formatTouchesCompact(touched, { maxItems: 5 })}。`,
								`Recently touched: ${formatTouchesCompact(touched, { maxItems: 5 })}.`,
								"convread.status.touched",
								{ files: formatTouchesCompact(touched, { maxItems: 5 }) },
							)
						: pick(L, `最近没动过文件。`, `No files touched recently.`, "convread.status.touched.none");
				const waitLine = sum.waitingQuestion
					? `\n${pick(
							L,
							`⚠ 转录显示它在等用户回答问卷（先回它，再干别的）。`,
							`⚠ The transcript shows it waiting for a question answer (answer first).`,
							"convread.status.waiting",
						)}`
					: "";
				const linesZh = formatClaimLines(statusClaims, 3, "inline").join("、");
				const linesEn = formatClaimLines(statusClaims, 3, "inline").join("; ");
				const claimLine =
					statusClaims.length > 0
						? `\n- ${pick(L, `认领：${linesZh}。`, `Claims: ${linesEn}.`, "convread.status.claims", {
								total: statusClaims.length,
								lines: linesEn,
								linesZh,
								linesEn,
							})}`
						: "";
				return text(`${head}\n- ${toolLine}\n- ${sayLine}\n- ${touchLine}${claimLine}${waitLine}`, {
					...where,
					title,
					lastTool: sum.lastTool,
					lastAssistant: sum.lastAssistant ? truncateCounted(sum.lastAssistant, 200) : undefined,
					touched: touched.slice(0, 5),
					claims: statusClaims.map((c) => ({ path: c.path, ownerTitle: c.ownerTitle })),
					waitingQuestion: sum.waitingQuestion,
				});
			}
			return text(
				pick(
					getLang(),
					`action 非法：${p.action}（只能是 list、read、files 或 status）。`,
					`Invalid action: ${p.action} (must be "list", "read", "files" or "status").`,
					"convread.bad.action",
					{ "p.action": p.action },
				),
			);
		},
	});
}
