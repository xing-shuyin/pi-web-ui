import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { ContextCategory, ContextCategoryUsage, UiState } from "../../protocol.js";

/**
 * `AgentSession.getSessionStats()` 的窄面：只声明快照真的用到的字段。
 * 真身是 SDK 会话，SDK 类型只许出现在 `adapters/sdk/**`，所以这里按结构收窄（不 `import type` SDK）。
 */
type SessionStatsValue = {
	totalMessages?: unknown;
	tokens?: { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown; total?: unknown };
	cost?: unknown;
	contextUsage?: { tokens?: unknown; contextWindow?: unknown; percent?: unknown } | null;
};

interface SessionStatsSource {
	getSessionStats?(): SessionStatsValue;
	/** 组装好的系统提示词（内核的引擎侧就是 SDK 自己这份，宿主模板不参与）。 */
	readonly systemPrompt?: unknown;
	/** 项目记忆（AGENTS.md 等）：内容已被 SDK 拼进 `systemPrompt`，这里只用来做分类拆分。 */
	readonly resourceLoader?: {
		getAgentsFiles?(): { agentsFiles?: Array<{ path?: unknown; content?: unknown }> } | undefined;
	};
	getAllTools?(): Array<{ name?: unknown; description?: unknown; parameters?: unknown }>;
	getActiveToolNames?(): readonly string[] | undefined;
	readonly messages?: readonly unknown[];
}

type Weights = Record<ContextCategory, number>;

const CATEGORIES: readonly ContextCategory[] = [
	"systemPrompt",
	"memoryFiles",
	"tools",
	"skills",
	"toolResults",
	"messages",
	"other",
];

function emptyWeights(): Weights {
	return { systemPrompt: 0, memoryFiles: 0, tools: 0, skills: 0, toolResults: 0, messages: 0, other: 0 };
}

/**
 * SDK `getSessionStats()` 对转录的假设比协议硬：累加 usage 时 `toolResult` 判了空，
 * **`assistant` 没判**（`usage-totals.addUsageToTotals` 直接读 `usage.input`）。
 * 手写/迁移/桩转录里 assistant 常常没有 `usage`，这时它抛 —— 而取统计的调用点在**出帧**里，
 * 一次抛错就等于把整条出帧链打断（会话已经切过去了，客户端却永远收不到新帧）。
 * 老实现 `sessionStats()` 外面有 try/catch 落到零值默认，内核对着同一份数据必须同样不抛。
 */
function rawStats(source: SessionStatsSource): SessionStatsValue | undefined {
	try {
		return source.getSessionStats?.();
	} catch {
		return undefined;
	}
}

/** 没有 SDK 统计时的兜底：按转录自己加，缺 `usage` 的条目算 0（不是猜，就是没有计费信息）。 */
function tolerantStats(messages: readonly unknown[] | undefined): SessionStatsValue {
	const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	let cost = 0;
	let totalMessages = 0;
	for (const value of messages ?? []) {
		if (!value || typeof value !== "object") continue;
		totalMessages += 1;
		const usage = (value as { usage?: unknown }).usage;
		if (!usage || typeof usage !== "object") continue;
		const u = usage as {
			input?: unknown;
			output?: unknown;
			cacheRead?: unknown;
			cacheWrite?: unknown;
			cost?: { total?: unknown };
		};
		const input = count(u.input);
		const output = count(u.output);
		const cacheRead = count(u.cacheRead);
		const cacheWrite = count(u.cacheWrite);
		tokens.input += input;
		tokens.output += output;
		tokens.cacheRead += cacheRead;
		tokens.cacheWrite += cacheWrite;
		tokens.total += input + output + cacheRead + cacheWrite;
		cost += typeof u.cost?.total === "number" && Number.isFinite(u.cost.total) ? u.cost.total : 0;
	}
	return { totalMessages, tokens, cost };
}

function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function maybeCount(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
}

function add(weights: Weights, category: ContextCategory, tokens: number): void {
	if (Number.isFinite(tokens) && tokens > 0) weights[category] += tokens;
}

/**
 * 纯文本的 token 估算：`estimateTokens()` 只吃消息，所以按同一条口径包成一条用户消息
 * （SDK 对它就是 `ceil(字符数 / 4)`，不另写一套换算）。
 */
function textTokens(text: unknown): number {
	if (typeof text !== "string" || text.length === 0) return 0;
	return estimateTokens({ role: "user", content: text, timestamp: 0 } as never);
}

function messageTokens(message: unknown, content: unknown): number {
	return estimateTokens({ ...(message as Record<string, unknown>), content } as never);
}

/**
 * 基础上下文（提示词 / 项目记忆 / 工具表）的分类权重。
 *
 * 内核的引擎侧**不用**宿主的 `prompt-composer`：系统提示词由 SDK 的资源加载器拼好。所以这里按 SDK
 * 自己的两个源拆：`systemPrompt` 是整份提示词、`resourceLoader.getAgentsFiles()` 是其中的项目记忆段
 * （AGENTS.md 已被拼进提示词，从提示词里**减掉**，不重复计数）。`skills` 同样内嵌在提示词里、
 * SDK 没有单列段落，这里记 0 —— 宁可少一个分类，不编数。
 */
function baseWeights(session: SessionStatsSource): Weights {
	const weights = emptyWeights();
	let systemPrompt = "";
	let agentsFiles: Array<{ content?: unknown }> = [];
	try {
		if (typeof session.systemPrompt === "string") systemPrompt = session.systemPrompt;
		const files = session.resourceLoader?.getAgentsFiles?.()?.agentsFiles;
		if (Array.isArray(files)) agentsFiles = files;
	} catch {
		// 会话正在换资源（reload）时读不到：这一帧就不给分类，下一次请求会补上。
	}
	for (const file of agentsFiles) add(weights, "memoryFiles", textTokens(file?.content));
	add(weights, "systemPrompt", Math.max(0, textTokens(systemPrompt) - weights.memoryFiles));
	try {
		const active = session.getActiveToolNames?.();
		const names = Array.isArray(active) && active.length > 0 ? new Set(active) : undefined;
		for (const tool of session.getAllTools?.() ?? []) {
			if (names && typeof tool?.name === "string" && !names.has(tool.name)) continue;
			add(
				weights,
				"tools",
				textTokens(JSON.stringify({ name: tool?.name, description: tool?.description, parameters: tool?.parameters })),
			);
		}
	} catch {
		// 工具表读不到就不算这一段（分类总量会由 `reconcile` 按真实总量摊回）。
	}
	return weights;
}

/** 转录消息的分类权重（与宿主 `estimateContextWeights` 同分桶：调用/结果归工具，正文归消息）。 */
function messageWeights(messages: readonly unknown[]): Weights {
	const weights = emptyWeights();
	for (const value of messages) {
		if (!value || typeof value !== "object") continue;
		const message = value as { role?: unknown; content?: unknown; toolName?: unknown };
		try {
			if (message.role === "system") continue;
			if (message.role === "toolResult") {
				add(weights, message.toolName === "skill" ? "skills" : "toolResults", estimateTokens(message as never));
				continue;
			}
			if (message.role === "assistant" && Array.isArray(message.content)) {
				const blocks = message.content as Array<{ type?: unknown }>;
				const calls = blocks.filter((block) => block?.type === "toolCall");
				const prose = blocks.filter((block) => block?.type !== "toolCall");
				if (calls.length > 0) add(weights, "toolResults", messageTokens(message, calls));
				if (prose.length > 0) add(weights, "messages", messageTokens(message, prose));
				continue;
			}
			add(weights, message.role === "user" ? "messages" : "other", estimateTokens(message as never));
		} catch {
			// 单条消息估不出来就跳过（不让一条坏消息把整帧分类弄丢）。
		}
	}
	return weights;
}

/**
 * 把分类权重摊到**真实**总量上（`contextUsage.tokens` 是 SDK 给的上下文总量）：
 * 少了记进 `other`、多了按比例缩放 —— 分类之和恒等于总数，前端堆叠条不会对不上。
 * 算法与宿主 `server/context-usage.ts` 的 `reconcileContextCategories` 同一口径。
 */
function reconcile(weights: Weights, usedTokens: number): ContextCategoryUsage[] | undefined {
	const total = Math.max(0, Math.round(usedTokens));
	if (total <= 0) return undefined;
	const entries = CATEGORIES.map((category) => ({ category, tokens: Math.max(0, weights[category]) }));
	const sum = entries.reduce((n, row) => n + row.tokens, 0);
	if (sum < total) entries.find((row) => row.category === "other")!.tokens += total - sum;
	const scale = sum > total ? total / sum : 1;
	let assigned = 0;
	const rows = entries.map((row) => {
		const previous = assigned;
		assigned += row.tokens * scale;
		return { category: row.category, tokens: Math.round(assigned) - Math.round(previous) };
	});
	return rows.filter((row) => row.tokens > 0);
}

/**
 * 会话统计 → 快照的 `stats`（老实现 `buildLightState` 的计数段，数值只有一个源：SDK 会话自己）。
 *
 * - `totalMessages` / `tokens` / `cost` / `contextUsage.{tokens,contextWindow,percent}` 直接来自
 *   `getSessionStats()`（与老实现 `sessionStats()` 同一份真值）；
 * - `contextUsage.categories` 由 SDK 的系统提示词 / 项目记忆 / 工具表 + 转录消息**估算**，再摊到真实
 *   总量上（分类之和 = `contextUsage.tokens`）；
 * - `softCap` 是宿主设置语义（软上限来自设置层）：内核不写。视图里宿主给了 `stats` 就以宿主为准。
 */
export function statsOfSession(
	session: unknown,
	softCapSettings?: { softCapTokens?: number; softCapByModel?: Record<string, number> },
): UiState["stats"] | undefined {
	const source = session as SessionStatsSource | undefined;
	if (!source) return undefined;
	const stats = rawStats(source) ?? tolerantStats(source.messages);
	const tokens = stats.tokens ?? {};
	const contextUsage = stats.contextUsage;
	let contextTokens = maybeCount(contextUsage?.tokens);
	const weights = baseWeights(source);
	const inMessages = messageWeights(source.messages ?? []);
	for (const category of CATEGORIES) weights[category] += inMessages[category];
	let estimated = false;
	if (contextTokens === null || contextTokens === 0) {
		// 还一轮都没跑（或刚压缩完）：SDK 不给 token 数，老实现也是拿「提示词 + 项目记忆 + 工具表 + 转录」
		// 自己估一个总量（`getEffectiveContextTokens`）。分类本身就是这份估算的明细，两者同一份权重。
		const estimate = CATEGORIES.reduce((sum, category) => sum + weights[category], 0);
		if (estimate > 0) {
			contextTokens = estimate;
			estimated = true;
		}
	}
	const categories = contextTokens === null ? undefined : reconcile(weights, contextTokens);
	const contextWindow = count(contextUsage?.contextWindow);
	const percent =
		typeof contextUsage?.percent === "number" && Number.isFinite(contextUsage.percent) && !estimated
			? contextUsage.percent
			: contextTokens !== null && contextWindow > 0
				? (contextTokens / contextWindow) * 100
				: null;
	let softCapField: { softCap: number | null } | undefined;
	if (softCapSettings) {
		const m = (source as { model?: { provider?: unknown; id?: unknown } }).model;
		const modelId =
			m && typeof m.provider === "string" && typeof m.id === "string" ? `${m.provider}/${m.id}` : undefined;
		const per = modelId ? softCapSettings.softCapByModel?.[modelId.trim()] : undefined;
		const globalCap = softCapSettings.softCapTokens ?? 0;
		const cap = per !== undefined && per > 0 ? per : globalCap > 0 ? globalCap : 0;
		softCapField = { softCap: cap > 0 ? cap : null };
	}
	return {
		totalMessages: count(stats.totalMessages),
		tokens: {
			input: count(tokens.input),
			output: count(tokens.output),
			cacheRead: count(tokens.cacheRead),
			cacheWrite: count(tokens.cacheWrite),
			total: count(tokens.total),
		},
		cost: typeof stats.cost === "number" && Number.isFinite(stats.cost) ? stats.cost : 0,
		contextUsage: {
			tokens: contextTokens,
			contextWindow,
			percent,
			...softCapField,
			...(estimated ? { estimated: true } : {}),
			...(categories && categories.length > 0 ? { categories } : {}),
		},
	};
}
