/**
 * 自定义上下文压缩阈值（Soft Cap，issue #229，issue #716，issue #773）。
 *
 * 背景：SDK 的自动压缩只看物理上限（shouldCompact：tokens > window - reserveTokens，
 * reserveTokens 默认 16384）。对 1M 上下文的模型会堆到 ~900K 才压；对 Grok 这类
 * 200K 起阶梯翻倍计费的模型，会在高价区跑很久，还伴随长上下文降智。
 *
 * 实现机制（双层管控，两层共用同一个软上限 cap）：
 * 1. 回合内层（SDK reserve，issue #773）：把 compaction.reserveTokens 逐会话算成
 *    cw - cap（下限仍是默认 16384），让 SDK 在**每次工具调用间隙**的
 *    _compactBeforeNextAssistantResponse 里就能在 cap 处压缩。自治长跑（子代理、
 *    单回合几十次工具调用）全程没有空闲态，只有这一层能拦住它。
 *    必须是「逐会话无状态重算」（各自用自己当前模型算），否则换模型会残留上一模型的
 *    W - C，这正是 #716 当初撤掉注入的原因；重算点见 applyCompactionOverrides。
 * 2. 空闲态层（pi-web-ui 主动压缩）：回合结算后 / 新一轮提问前，若有效 token 已达 cap
 *    则主动 session.compact()。它负责 reserve 管不到的场景：cap 中途下调、附件注入
 *    超阈、从磁盘恢复的已超阈会话（首个请求前没有任何检查点）。
 * 3. 物理防爆始终在：reserve 只取 max(默认 16384, cw - cap)，触发点永远不晚于
 *    cw - 16384；cap 关闭/非法时 reserve 回落默认值，等于原样的物理兜底线。
 *
 * softCapToReserve / softCapReserveFor 同时服务分层上下文预算裁剪（context-budget-runner）。
 */
import { DEFAULT_COMPACTION_SETTINGS } from "@earendil-works/pi-coding-agent";

/** SDK 默认保留 token（软上限关闭时的回填值）。 */
export const DEFAULT_COMPACTION_RESERVE_TOKENS = DEFAULT_COMPACTION_SETTINGS.reserveTokens;

/** 软上限下限（tokens）：低于此值每轮都压，无意义，直接视为关闭。 */
export const SOFT_CAP_MIN_TOKENS = 2000;
/** 压缩后至少要剩这么多工作空间（摘要本身也要占 reserve*0.8 的预算）。 */
export const SOFT_CAP_MIN_HEADROOM = 2048;
/** 单客户端最多存多少条按模型覆盖（防手滑粘贴刷爆 client-state）。 */
export const SOFT_CAP_MAX_OVERRIDES = 64;

/** 归一化全局软上限：支持数字或带单位字符串（如 "300k", "1.5m", "300,000"）；
 *  <= 1000 的正数智能识别为 K tokens（如 300 -> 300,000）；<=0 或非法 = 关闭；
 *  钳制到 [0, 10_000_000] 整数。纯函数。 */
export function normalizeSoftCapTokens(v: unknown): number {
	if (v === null || v === undefined) return 0;
	if (typeof v === "number") {
		if (!Number.isFinite(v) || v <= 0) return 0;
		const n = Math.floor(v);
		if (n <= 1000) return n * 1000;
		return Math.min(10_000_000, n);
	}
	const s = String(v)
		.trim()
		.toLowerCase()
		.replace(/[,_\s]/g, "");
	if (!s) return 0;
	const m = s.match(/^(\d+(?:\.\d+)?)([km])?$/);
	if (!m) return 0;
	const num = parseFloat(m[1]);
	if (!Number.isFinite(num) || num <= 0) return 0;
	const unit = m[2];
	let tokens: number;
	if (unit === "k") {
		tokens = Math.floor(num * 1_000);
	} else if (unit === "m") {
		tokens = Math.floor(num * 1_000_000);
	} else {
		tokens = Math.floor(num);
		if (tokens <= 1000) tokens *= 1000;
	}
	return Math.min(10_000_000, Math.max(0, tokens));
}

/** 归一化按模型覆盖：key = "provider/id" 非空（≤200 字），value 走
 *  normalizeSoftCapTokens；0 值条目丢弃（= 用全局）；上限 64 条。纯函数。 */
export function normalizeSoftCapByModel(v: unknown): Record<string, number> {
	if (!v || typeof v !== "object" || Array.isArray(v)) return {};
	const out: Record<string, number> = {};
	for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
		if (Object.keys(out).length >= SOFT_CAP_MAX_OVERRIDES) break;
		const key = String(k).trim();
		if (!key || key.length > 200) continue;
		const n = normalizeSoftCapTokens(val);
		if (n > 0) out[key] = n;
	}
	return out;
}

/** 自动压缩附加指令：字符串、≤2000 字（空串 = 不传，保持 SDK 默认摘要）。
 *  只用于软上限触发的自动压缩；手动 `/compact` 与 AI 的 `compact_context` 不受影响。 */
export function normalizeAutoCompactionInstructions(v: unknown): string {
	return typeof v === "string" ? v.slice(0, 2000) : "";
}

/** 当前模型的生效软上限（0 = 关闭）：按模型覆盖优先于全局。 */
export function effectiveSoftCap(
	globalCap: number,
	byModel: Record<string, number> | undefined,
	modelId: string | null | undefined,
): number {
	if (modelId) {
		const per = byModel?.[modelId.trim()];
		if (per !== undefined && per > 0) return per;
	}
	return globalCap > 0 ? globalCap : 0;
}

/** 软上限 → SDK reserveTokens（null = 不合法/关闭，走 SDK 默认）。
 *  合法条件：cap ≥ SOFT_CAP_MIN_TOKENS 且压完至少剩 SOFT_CAP_MIN_HEADROOM。 */
export function softCapToReserve(contextWindow: number, cap: number): number | null {
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) return null;
	if (!Number.isFinite(cap) || cap < SOFT_CAP_MIN_TOKENS) return null;
	const reserve = Math.floor(contextWindow - cap);
	if (reserve < SOFT_CAP_MIN_HEADROOM) return null;
	return reserve;
}

/** 注入 SDK 的 reserveTokens（issue #773）：软上限合法时 = cw - cap，否则回落默认值。
 *
 * 额外守卫（keepRecentTokens）：SDK 压缩按 keepRecentTokens（默认 20000）留尾部，
 * 若 cap ≤ keepRecent + SOFT_CAP_MIN_HEADROOM，压完立刻又超阈 → 回合内每个工具间隙
 * 都重压一次（每次都要付摘要请求的钱），比撞墙还贵。这种「压不下来」的 cap 一律不注射，
 * 交给空闲态层与物理兜底。keepRecentTokens 未知（0/非法）时不做该守卫。 */
export function softCapReserveFor(contextWindow: number, cap: number, keepRecentTokens = 0): number | null {
	const reserve = softCapToReserve(contextWindow, cap);
	if (reserve === null) return null;
	if (Number.isFinite(keepRecentTokens) && keepRecentTokens > 0 && cap <= keepRecentTokens + SOFT_CAP_MIN_HEADROOM) {
		return null;
	}
	return Math.max(DEFAULT_COMPACTION_RESERVE_TOKENS, reserve);
}
