import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { exec } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

function getAgentDir() {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function formatTokens(count) {
	const n = Number(count) || 0;
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

function formatBytes(bytes) {
	const n = Number(bytes) || 0;
	if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
	if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${n} B`;
}

const PLACEHOLDER_TOKENS_EST = 80;

const PROBE_LIMIT = 4;
const RESOLVE_CACHE_MAX = 500;
const LEDGER_NEG_TTL_MS = 5000;
const MTIME_SLACK_MS = 2 * 60 * 60 * 1000;

const resolveCache = new Map();

const ledgerPathCache = new Map();

function findLedgerPath(sid, agentDir) {
	if (!sid) return null;
	const key = `${agentDir}\u0000${sid}`;
	const hit = ledgerPathCache.get(key);
	if (hit) {
		if (hit.path) return hit.path;
		if (Date.now() - hit.at < LEDGER_NEG_TTL_MS) return null;
	}
	let found = null;
	try {
		const sessBase = join(agentDir, "sessions");
		for (const proj of readdirSync(sessBase)) {
			const cand = join(sessBase, proj, "sol-pi", sid, "observation-pack", "ledger.jsonl");
			if (existsSync(cand)) {
				found = cand;
				break;
			}
		}
	} catch {}
	if (ledgerPathCache.size >= RESOLVE_CACHE_MAX) ledgerPathCache.clear();
	ledgerPathCache.set(key, { path: found, at: Date.now() });
	return found;
}

/**
 * 尝试解析会话的真实持久化 sessionId（UUID）。
 * 优先取显式 sessionId；若为客户端内部序号（c1/c2），则根据消息时间戳与工具调用 ID 映射到物理 session 文件。
 * 扫描结果记忆化（见 resolveCache）：同一会话重复调用直接命中缓存，不会重复全盘扫描。
 * @param {string | null} [conversationId]
 * @param {any[]} [messages]
 * @param {string} [agentDir]
 */
export function resolveSessionId(conversationId = null, messages = [], agentDir = getAgentDir()) {
	if (!conversationId) return null;
	if (typeof conversationId === "string" && conversationId.length > 20 && conversationId.includes("-")) {
		return conversationId;
	}

	const sessBase = join(agentDir, "sessions");
	if (!existsSync(sessBase)) return null;

	const msgTimestamps = new Set();
	const toolCallIds = new Set();
	for (const m of messages) {
		if (m && typeof m.id === "string") {
			const parts = m.id.split("-");
			if (parts.length >= 2) {
				const ts = parseInt(parts[1], 10);
				if (ts > 1000000000000) msgTimestamps.add(ts);
			}
			if (parts[0] === "t" && parts.slice(1).join("-")) {
				toolCallIds.add(parts.slice(1).join("-"));
			}
		}
		if (m && m.timestamp) msgTimestamps.add(Number(m.timestamp));
		if (m && m.toolCallId) toolCallIds.add(String(m.toolCallId));
	}

	if (msgTimestamps.size === 0 && toolCallIds.size === 0) return null;

	const cacheKey = `${agentDir}\u0000${conversationId}\u0000${messages[0]?.id ?? ""}`;
	const cached = resolveCache.get(cacheKey);
	if (cached) {
		if (cached.sid) return cached.sid;
		if (messages.length < cached.scannedCount * 2) return null;
	}

	const tsProbes = [...msgTimestamps].slice(0, PROBE_LIMIT);
	const idProbes = [...toolCallIds].slice(0, PROBE_LIMIT);
	const earliestTs = msgTimestamps.size > 0 ? Math.min(...msgTimestamps) : 0;

	let hit = null;
	try {
		for (const proj of readdirSync(sessBase)) {
			const projDir = join(sessBase, proj);
			const solDir = join(projDir, "sol-pi");
			if (!existsSync(solDir)) continue;

			let files = [];
			try {
				files = readdirSync(projDir).filter((f) => f.endsWith(".jsonl"));
			} catch {
				continue;
			}

			for (const file of files) {
				const parts = file.slice(0, -6).split("_");
				const sid = parts.length >= 2 ? parts[parts.length - 1] : null;
				if (!sid) continue;

				const candidate = join(solDir, sid, "observation-pack", "ledger.jsonl");
				if (!existsSync(candidate)) continue;

				const filePath = join(projDir, file);
				try {
					if (earliestTs > 0 && statSync(filePath).mtimeMs + MTIME_SLACK_MS < earliestTs) continue;
					const content = readFileSync(filePath, "utf8");
					for (const ts of tsProbes) {
						if (content.includes(new Date(ts).toISOString())) {
							hit = sid;
							break;
						}
					}
					if (!hit) {
						for (const tid of idProbes) {
							if (content.includes(tid)) {
								hit = sid;
								break;
							}
						}
					}
				} catch {}
				if (hit) break;
			}
			if (hit) break;
		}
	} catch {}

	if (resolveCache.size >= RESOLVE_CACHE_MAX) resolveCache.clear();
	resolveCache.set(cacheKey, { sid: hit, scannedCount: messages.length });
	return hit;
}

/**
 * 从 SoL-Pi 的物理账本 ledger.jsonl 中直接读取真实的节省数据。
 * SoL-Pi 在 API 请求投影层（pi.on("context")）动态替换大输出，绝不就地改写会话历史 messages，
 * 真实的打包截断与 Token 削减全部记录在 <sessionDir>/sol-pi/<sessionId>/observation-pack/ledger.jsonl 中。
 * @param {string | null} [conversationId]
 * @param {string} [agentDir]
 * @param {any[]} [messages]
 */
export function getSavingsFromLedger(conversationId = null, agentDir = getAgentDir(), messages = []) {
	if (!conversationId) return null;
	if (!existsSync(join(agentDir, "sessions"))) return null;

	let targetSid = conversationId;
	let candidatePath = findLedgerPath(targetSid, agentDir);

	if (!candidatePath && Array.isArray(messages) && messages.length > 0) {
		const resolved = resolveSessionId(conversationId, messages, agentDir);
		if (resolved) {
			targetSid = resolved;
			candidatePath = findLedgerPath(targetSid, agentDir);
		}
	}

	if (!candidatePath) return null;

	try {
		let totalSavedTokens = 0;
		let totalOriginalBytes = 0;
		let packedCount = 0;
		const toolBreakdown = {};
		const packedList = [];
		const lines = readFileSync(candidatePath, "utf8").split("\n");
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const ev = JSON.parse(line);
				if (ev.event === "placeholder") {
					const saved = ev.removedTokens || 0;
					const bytes = ev.originalBytes || 0;
					const tool = ev.tool || "unknown";
					totalSavedTokens += saved;
					totalOriginalBytes += bytes;
					packedCount++;
					toolBreakdown[tool] = (toolBreakdown[tool] || 0) + 1;
					packedList.push({
						id: ev.id,
						tool,
						bytes,
						tokens: ev.originalTokens || 0,
						savedTokens: saved,
						sends: ev.sendNumber || 1,
					});
				}
			} catch {}
		}
		return { totalSavedTokens, totalOriginalBytes, packedCount, toolBreakdown, packedList };
	} catch {}

	return null;
}

/**
 * 从当前对话消息快照或 SoL-Pi 账本中分析 SoL-Pi 节省情况。
 * @param {any[]} [messages]
 * @param {string | null} [conversationId]
 * @param {string} [agentDir]
 */
export function analyzeSolSavings(messages = [], conversationId = null, agentDir = getAgentDir()) {
	let latestPlan = null;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		const contents = Array.isArray(m?.content) ? m.content : [];
		for (const c of contents) {
			const text = typeof c === "string" ? c : typeof c?.text === "string" ? c.text : "";
			if (text.includes("sol-pi-online-context-state-v1") || text.includes('"plan":')) {
				try {
					const jsonMatch = text.match(/\{[\s\S]*"plan"\s*:\s*\[[\s\S]*\][\s\S]*\}/);
					if (jsonMatch) {
						const parsed = JSON.parse(jsonMatch[0]);
						if (Array.isArray(parsed.plan) && parsed.plan.length > 0) {
							latestPlan = parsed.plan;
							break;
						}
					}
				} catch {}
			}
		}
		if (latestPlan) break;
	}

	if (conversationId) {
		const fromLedger = getSavingsFromLedger(conversationId, agentDir, messages);
		if (fromLedger && fromLedger.totalSavedTokens > 0) {
			return {
				...fromLedger,
				plan: latestPlan,
			};
		}
	}

	let totalSavedTokens = 0;
	let totalOriginalBytes = 0;
	let packedCount = 0;
	const toolBreakdown = {};
	const packedList = [];

	const assistantCountsAfter = new Array(messages.length).fill(0);
	let count = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		assistantCountsAfter[i] = count;
		if (messages[i]?.role === "assistant") {
			count++;
		}
	}

	for (let i = 0; i < messages.length; i++) {
		const m = messages[i];
		const contents = Array.isArray(m?.content) ? m.content : [];
		for (const c of contents) {
			const text = typeof c === "string" ? c : typeof c?.text === "string" ? c.text : "";
			if (!text.includes("[large tool result replaced")) continue;

			const match = text.match(
				/\[large tool result replaced after its first \d+ provider requests\][\s\S]*?id:\s*["']?([^"'\n\r,]+)["']?[\s\S]*?tool:\s*["']?([^"'\n\r,]+)["']?[\s\S]*?original_bytes:\s*["']?(\d+)["']?[\s\S]*?estimated_tokens:\s*["']?(\d+)["']?/i,
			);
			if (match) {
				const id = match[1].trim();
				const tool = match[2].trim();
				const bytes = parseInt(match[3], 10) || 0;
				const tokens = parseInt(match[4], 10) || 0;
				const netPerSend = Math.max(0, tokens - PLACEHOLDER_TOKENS_EST);
				const subsequentSends = Math.max(1, assistantCountsAfter[i]);
				const savedTokensForObs = netPerSend * subsequentSends;

				packedCount++;
				totalOriginalBytes += bytes;
				totalSavedTokens += savedTokensForObs;

				toolBreakdown[tool] = (toolBreakdown[tool] || 0) + 1;
				packedList.push({
					id,
					tool,
					bytes,
					tokens,
					savedTokens: savedTokensForObs,
					sends: subsequentSends,
				});
			}
		}
	}

	return {
		packedCount,
		totalSavedTokens,
		totalOriginalBytes,
		toolBreakdown,
		packedList,
		plan: latestPlan,
	};
}

export function formatPlanSummary(plan) {
	if (!Array.isArray(plan) || plan.length === 0) return null;
	const completed = plan.filter((s) => s.status === "completed").length;
	const active = plan.find((s) => s.status === "in_progress");
	const marker = active ? "◐" : "○";
	const currentGoal = active ? active.goal || active.title || "" : "";
	return {
		progress: `${completed}/${plan.length}`,
		marker,
		goal: currentGoal.length > 20 ? `${currentGoal.slice(0, 19)}…` : currentGoal,
		badge: `${completed}/${plan.length} ${marker}`,
	};
}

export function checkSolPiStatus() {
	const agentDir = getAgentDir();
	const configPath = join(agentDir, "sol-pi.json");
	const settingsPath = join(agentDir, "settings.json");

	let installed = false;
	try {
		if (existsSync(settingsPath)) {
			const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
			const pkgs = Array.isArray(settings?.packages) ? settings.packages : [];
			installed = pkgs.some((p) => typeof p === "string" && p.toLowerCase().includes("sol-pi"));
		}
	} catch {}

	if (!installed) {
		const gitPkgDir = join(agentDir, "git", "github.com", "NVlabs", "SoL-Pi");
		if (existsSync(gitPkgDir)) installed = true;
	}

	let hasConfig = false;
	let config = null;
	if (existsSync(configPath)) {
		try {
			config = JSON.parse(readFileSync(configPath, "utf8"));
			hasConfig = true;
		} catch {}
	}

	return {
		installed,
		hasConfig,
		configPath,
		config,
	};
}

export function writeSolPiConfig(customPatch = {}) {
	const agentDir = getAgentDir();
	const configPath = join(agentDir, "sol-pi.json");
	const recommended = {
		version: 1,
		observationPack: true,
		onlineContextCompact: true,
		actionFusion: false,
		evidencePreservingReducer: false,
		cacheWriteReadRatio: 12.5,
		...customPatch,
	};
	writeFileSync(configPath, JSON.stringify(recommended, null, 2), "utf8");
	return recommended;
}

export function saveSolPiConfig(patch = {}) {
	const agentDir = getAgentDir();
	const configPath = join(agentDir, "sol-pi.json");
	let current = {};
	if (existsSync(configPath)) {
		try {
			current = JSON.parse(readFileSync(configPath, "utf8"));
		} catch {}
	}
	/**
	 * 落盘配置：基础开关 + 可选的 EPR（证据保全压缩）辅模型。
	 * provider/model 只在用户显式设置过时存在，必须声明为可选 —— 否则 TS 从字面量
	 * 推断出的返回类型里没有这两个字段，调用方（单测/设置页）一读就报 TS2551。
	 * @type {{
	 *   version: number,
	 *   observationPack: boolean,
	 *   onlineContextCompact: boolean,
	 *   actionFusion: boolean,
	 *   evidencePreservingReducer: boolean,
	 *   cacheWriteReadRatio: number,
	 *   evidencePreservingReducerProvider?: string,
	 *   evidencePreservingReducerModel?: string,
	 * }}
	 */
	const updated = {
		version: current.version || 1,
		observationPack:
			typeof patch.observationPack === "boolean" ? patch.observationPack : Boolean(current.observationPack ?? true),
		onlineContextCompact:
			typeof patch.onlineContextCompact === "boolean"
				? patch.onlineContextCompact
				: Boolean(current.onlineContextCompact ?? true),
		actionFusion: typeof patch.actionFusion === "boolean" ? patch.actionFusion : Boolean(current.actionFusion ?? false),
		evidencePreservingReducer:
			typeof patch.evidencePreservingReducer === "boolean"
				? patch.evidencePreservingReducer
				: Boolean(current.evidencePreservingReducer ?? false),
		cacheWriteReadRatio:
			typeof patch.cacheWriteReadRatio === "number"
				? patch.cacheWriteReadRatio
				: typeof current.cacheWriteReadRatio === "number"
					? current.cacheWriteReadRatio
					: 12.5,
	};
	if (typeof patch.evidencePreservingReducerProvider === "string" && patch.evidencePreservingReducerProvider.trim()) {
		updated.evidencePreservingReducerProvider = patch.evidencePreservingReducerProvider.trim();
	} else if (patch.evidencePreservingReducerProvider === "") {
		delete updated.evidencePreservingReducerProvider;
	} else if (current.evidencePreservingReducerProvider) {
		updated.evidencePreservingReducerProvider = current.evidencePreservingReducerProvider;
	}
	if (typeof patch.evidencePreservingReducerModel === "string" && patch.evidencePreservingReducerModel.trim()) {
		updated.evidencePreservingReducerModel = patch.evidencePreservingReducerModel.trim();
	} else if (patch.evidencePreservingReducerModel === "") {
		delete updated.evidencePreservingReducerModel;
	} else if (current.evidencePreservingReducerModel) {
		updated.evidencePreservingReducerModel = current.evidencePreservingReducerModel;
	}
	writeFileSync(configPath, JSON.stringify(updated, null, 2), "utf8");
	return updated;
}

export function solSavingsPlugin(host) {
	let cachedStats = null;
	let refreshTimer = null;

	function scheduleRefresh(delay = 500) {
		if (refreshTimer) return;
		refreshTimer = setTimeout(() => {
			refreshTimer = null;
			refreshFooter();
		}, delay);
	}

	function refreshFooter() {
		const conv = host.getActiveConversation();
		if (!conv || !Array.isArray(conv.messages)) {
			host.ui.update("sol-savings-badge", {
				badge: undefined,
				label: "SoL-Pi",
				hint: "SoL-Pi 节省：当前会话暂无数据",
				hintEn: "SoL-Pi savings: No data for current conversation",
			});
			cachedStats = null;
			return;
		}

		const sid = conv.sessionId || conv.conversationId || conv.id;
		const stats = analyzeSolSavings(conv.messages, sid);
		cachedStats = stats;

		const planInfo = formatPlanSummary(stats.plan);
		let badgeText = undefined;
		let labelText = "SoL-Pi";

		if (stats.totalSavedTokens > 0) {
			const savedFmt = formatTokens(stats.totalSavedTokens);
			badgeText = planInfo ? `省 ${savedFmt} · ${planInfo.progress} ${planInfo.marker}` : `省 ${savedFmt}`;
		} else if (planInfo) {
			badgeText = `Plan ${planInfo.badge}`;
		} else {
			badgeText = "省 0";
		}

		const breakdownStr = Object.entries(stats.toolBreakdown)
			.map(([tool, cnt]) => `${tool}: ${cnt}`)
			.join(", ");

		const hintZh =
			stats.totalSavedTokens > 0
				? `⚡ SoL-Pi（当前会话）：已节省约 ${stats.totalSavedTokens.toLocaleString()} tokens（压缩 ${stats.packedCount} 个输出${breakdownStr ? ` [${breakdownStr}]` : ""}，累计原始数据 ${formatBytes(stats.totalOriginalBytes)}）${planInfo ? `\n🎯 规划进度：${planInfo.progress} ${planInfo.marker} ${planInfo.goal}` : ""}\n点击查看当前会话明细`
				: planInfo
					? `⚡ SoL-Pi（当前会话）规划进行中：${planInfo.progress} ${planInfo.marker} ${planInfo.goal}\n点击查看当前会话明细`
					: `⚡ SoL-Pi（当前会话）：已节省 0 tokens，暂未触发大工具输出打包（阈值 >10KB）\n点击查看当前会话明细`;

		const hintEn =
			stats.totalSavedTokens > 0
				? `⚡ SoL-Pi (Current conversation): Saved ~${stats.totalSavedTokens.toLocaleString()} tokens in this session (${stats.packedCount} outputs packed${breakdownStr ? ` [${breakdownStr}]` : ""}, ${formatBytes(stats.totalOriginalBytes)} raw data)${planInfo ? `\n🎯 Plan: ${planInfo.progress} ${planInfo.marker} ${planInfo.goal}` : ""}\nClick for session details`
				: planInfo
					? `⚡ SoL-Pi (Current conversation) Plan in progress: ${planInfo.progress} ${planInfo.marker} ${planInfo.goal}\nClick for session details`
					: `⚡ SoL-Pi (Current conversation): 0 tokens saved (no outputs >10KB packed yet)\nClick for session details`;

		host.ui.update("sol-savings-badge", {
			badge: badgeText,
			label: labelText,
			hint: hintZh,
			hintEn: hintEn,
		});
	}

	function showDetails() {
		if (!cachedStats || (cachedStats.totalSavedTokens === 0 && !cachedStats.plan)) {
			host.notify(
				"info",
				"⚡ SoL-Pi（当前会话）：暂未触发大输出截断（阈值 >10KB），当前会话累计节省 0 Tokens。\n• 仅按当前会话独立统计，未跨会话累加。",
				"⚡ SoL-Pi (Current conversation): No large tool outputs packed yet (>10KB threshold), 0 tokens saved in this session.",
			);
			return;
		}

		const breakdown = Object.entries(cachedStats.toolBreakdown)
			.map(([t, c]) => `  • ${t}：${c} 次打包`)
			.join("\n");

		const planInfo = formatPlanSummary(cachedStats.plan);

		const textZh = [
			`⚡ **SoL-Pi 会话节省统计明细（当前会话）**`,
			`• **当前会话累计节省**：约 **${cachedStats.totalSavedTokens.toLocaleString()}** tokens`,
			`• **打包大输出数量**：共 **${cachedStats.packedCount}** 个结果（原体积 ${formatBytes(cachedStats.totalOriginalBytes)}）`,
			breakdown ? `• **按工具细分**：\n${breakdown}` : null,
			planInfo ? `• **活动规划（Plan）**：${planInfo.progress} ${planInfo.marker} ${planInfo.goal}` : null,
			`• **统计范围**：仅限当前会话，切换会话自动隔离。`,
		]
			.filter(Boolean)
			.join("\n");

		const textEn = [
			`⚡ **SoL-Pi Session Savings Details (Current Conversation)**`,
			`• **Current Session Tokens Saved**: ~**${cachedStats.totalSavedTokens.toLocaleString()}** tokens`,
			`• **Outputs Packed**: **${cachedStats.packedCount}** observations (${formatBytes(cachedStats.totalOriginalBytes)} raw)`,
			breakdown ? `• **Tool Breakdown**:\n${breakdown}` : null,
			planInfo ? `• **Active Plan**: ${planInfo.progress} ${planInfo.marker} ${planInfo.goal}` : null,
			`• **Scope**: Current conversation only; isolated across sessions.`,
		]
			.filter(Boolean)
			.join("\n");

		host.notify("info", textZh, textEn);
	}

	host.route?.("GET", "/status", (_req, res) => {
		const conv = host.getActiveConversation?.();
		const sid = conv?.sessionId || conv?.conversationId || conv?.id || null;
		const stats = conv && Array.isArray(conv.messages) ? analyzeSolSavings(conv.messages, sid) : null;
		res.json({
			...checkSolPiStatus(),
			conversationId: conv?.conversationId || conv?.id || null,
			conversationTitle: conv?.title || null,
			stats,
		});
	});

	host.route?.("POST", "/action", async (req, res) => {
		const action = req.body?.action;
		try {
			if (action === "write_config") {
				const overwrite = String(req.body?.overwrite ?? "") === "true";
				const status = checkSolPiStatus();
				if (status.hasConfig && !overwrite) {
					res.status(409).json({ ok: false, error: '已存在 sol-pi.json，拒绝覆盖（如确需覆盖请带 overwrite:"true"）' });
					return;
				}
				const config = writeSolPiConfig();
				res.json({ ok: true, config });
			} else if (action === "install") {
				if (req.body?.confirm !== "install") {
					res.status(400).json({ ok: false, error: '缺少 confirm:"install" 确认参数' });
					return;
				}
				await execAsync("pi install git:github.com/NVlabs/SoL-Pi", { timeout: 120_000 });
				const status = checkSolPiStatus();
				const config = status.hasConfig ? status.config : writeSolPiConfig();
				res.json({ ok: true, config });
			} else if (action === "save_config") {
				const config = saveSolPiConfig(req.body?.config || {});
				res.json({ ok: true, config });
			} else if (action === "reset_config") {
				const config = writeSolPiConfig();
				res.json({ ok: true, config });
			} else {
				res.status(400).json({ ok: false, error: "unknown action" });
			}
		} catch (err) {
			res.status(500).json({ ok: false, error: err?.message || String(err) });
		}
	});

	host.onMessage((msg) => {
		if (msg && typeof msg === "object" && msg.action === "sol-savings:details") {
			showDetails();
		}
	});

	host.onAttach?.(() => refreshFooter());
	host.onConversationChanged?.(() => refreshFooter());
	host.onRunEvent?.((ev) => {
		if (ev.type === "turn_end" || ev.type === "run_end") {
			if (refreshTimer) {
				clearTimeout(refreshTimer);
				refreshTimer = null;
			}
			refreshFooter();
		} else if (ev.type === "tool_end" || ev.type === "message") {
			scheduleRefresh();
		}
	});

	refreshFooter();
}

Object.assign(solSavingsPlugin, {
	activate(host) {
		return solSavingsPlugin(host);
	},
});

export default solSavingsPlugin;
