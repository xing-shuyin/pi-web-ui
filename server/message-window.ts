/**
 * message-window — 历史消息的服务端「按需加载」（尾部窗口 + 往前翻页）。
 *
 * 为什么在传输层做：四个引擎（pi / DSH / claude / durable）各有一条发快照的
 * 路径，各自实现窗口化必然三处改动、以后新引擎还会漏。这里挂在 `server/index.ts`
 * 每个连接唯一的 `send` 漏斗上，引擎侧零改动，所有引擎（含第三方扩展）口径一致。
 *
 * 只做三件事：
 *   1. `snapshot`：把 `state.messages`（全量）裁成尾部窗口，回填
 *      `historyStart`（窗口首条在全量里的下标）与 `historyTotal`；
 *   2. `snapshot_delta`：把新追加的消息并入缓存，并回填同样两个字段；
 *   3. `load_earlier_messages`：把窗口往前扩一页，回 `earlier_messages`。
 *
 * 刻意**不碰** `rev` / `baseRev`：各引擎的增量语义（DSH 的 baseRev 算法、
 * durable 的消息结构）完全不同，一旦在这里改写版本号就会把它们的自愈逻辑搞坏。
 * 往前翻页只是给客户端「补齐更早的一段」，不影响任何 rev 链。
 *
 * 兼容性：两个字段都是可选的（缺省 = 全量），老前端连新服务端、新前端连老服务端
 * 都只是退化成本来的「全量下发」，不会坏。
 */
import type { ServerMessage, UiMessage } from "./protocol.js";

/** 尾部窗口条数（缺省 300 条）。 */
export const DEFAULT_HISTORY_WINDOW = 300;
/** 尾部窗口字符预算（缺省 150 万字符 ≈ 3MB JSON）。
 *
 *  只按条数裁不够用：一条巨型 tool 输出就能把几十条普通消息顶下去——实测一份
 *  287 条、17MB 的转录序列化后仍有 4MB，按条数（300）根本裁不动。所以从尾部
 *  往前累加**字符长度**（只读每个字符串的 `.length`，O(block 数)，不展开内容），超预算即停。
 */
export const DEFAULT_HISTORY_CHARS = 1_500_000;
/** 「加载更早」单页条数。 */
export const DEFAULT_HISTORY_PAGE = 30;
/** 单次翻页上限，防止一条消息把几千条历史一次拉下来。 */
const MAX_PAGE = 2000;
/** 最多为几个对话保留全量缓存（LRU）—— 引用的是引擎已序列化好的对象，只有指针开销。 */
const MAX_CACHED_CONVERSATIONS = 64;

export interface LoadEarlierOptions {
	count?: number;
	all?: boolean;
	conversationId?: string;
	beforeId?: string;
	before?: number;
}

export interface MessageWindowConfig {
	/** 尾部窗口条数；<= 0 表示关闭窗口化（全量下发，与旧行为一致）。 */
	windowSize: number;
	/** 尾部窗口字符预算；<= 0 = 只按条数裁剪。 */
	charBudget: number;
	/** 「加载更早」缺省页大小。 */
	pageSize: number;
}

const OFF_CONFIG: MessageWindowConfig = { windowSize: 0, charBudget: 0, pageSize: DEFAULT_HISTORY_PAGE };
const DEFAULT_CONFIG: MessageWindowConfig = {
	windowSize: DEFAULT_HISTORY_WINDOW,
	charBudget: DEFAULT_HISTORY_CHARS,
	pageSize: DEFAULT_HISTORY_PAGE,
};

/** 从环境变量读窗口配置：`PI_WEB_HISTORY_WINDOW`（条数；0/off/false/no = 关闭）。 */
export function readMessageWindowConfig(env: NodeJS.ProcessEnv): MessageWindowConfig {
	const raw = (env.PI_WEB_HISTORY_WINDOW ?? "").trim().toLowerCase();
	if (raw === "0" || raw === "off" || raw === "false" || raw === "no") return OFF_CONFIG;
	if (raw === "") return DEFAULT_CONFIG;
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) return DEFAULT_CONFIG;
	return { ...DEFAULT_CONFIG, windowSize: Math.floor(n) };
}

/**
 * 本轮窗口起点（纯函数，便于单测）。
 *
 * `prevStart` 是上一次下发的起点（新对话传 -1）。起点只允许**单调不增**：
 * 客户端可能已经往前翻过几页，若某次全量快照把起点推回去（比如先 200 后 400），
 * 客户端会凭空丢掉已经看过的历史。消息总数变少（压缩重写）时以尾部窗口为准。
 */
export function computeWindowStart(prevStart: number, total: number, windowSize: number): number {
	if (windowSize <= 0) return 0;
	const tail = Math.max(0, total - windowSize);
	if (prevStart < 0) return tail;
	return Math.min(prevStart, tail);
}

/** 单条消息的字符量估算：只累加各文本字段的 `.length`（每条 O(block 数)，不展开内容）。 */
export function estimateMessageChars(m: UiMessage): number {
	let n = 0;
	const content = (m as { content?: readonly Record<string, unknown>[] }).content;
	if (Array.isArray(content)) {
		for (const b of content) {
			// dataUrl：截图类 toolResult 是真正的重量级（实测一份长会话的 4MB JSON 里
			// 3.4MB 全来自三张整页截图），漏掉它字符预算就形同虚设。
			for (const k of ["text", "thinking", "argumentsText", "output", "command", "dataUrl", "summary"]) {
				const v = b[k];
				if (typeof v === "string") n += v.length;
			}
		}
	}
	const summary = (m as { summary?: unknown }).summary;
	if (typeof summary === "string") n += summary.length;
	return n;
}

/**
 * 首次计算窗口起点：条数上限与字符预算取**更严**的那个，且至少保留最后一条消息。
 *  `windowSize <= 0` 时返回 0（窗口化关闭）。
 */
export function pickWindowStart(
	messages: readonly UiMessage[],
	cfg: Pick<MessageWindowConfig, "windowSize" | "charBudget">,
): number {
	const total = messages.length;
	if (cfg.windowSize <= 0) return 0;
	const byCount = Math.max(0, total - cfg.windowSize);
	if (cfg.charBudget <= 0) return byCount;
	let chars = 0;
	let i = total - 1;
	for (; i >= byCount; i--) {
		chars += estimateMessageChars(messages[i]);
		if (chars > cfg.charBudget) return Math.min(total - 1, i + 1);
	}
	return byCount;
}

interface ConvWindow {
	/** 全量消息（直接引用引擎序列化出来的 UiMessage，不复制内容）。 */
	full: UiMessage[];
	/** 已下发窗口的起点下标。 */
	start: number;
}

/**
 * 连接级历史窗口。每个 socket（= 每个标签页）一份，`accept()` 包在 send 之前，
 * `loadEarlier()` 由 WS 分发层直接调用。
 */
export class MessageWindowTap {
	private readonly convs = new Map<string, ConvWindow>();
	/** 最近一次快照所属的对话 —— `load_earlier_messages` 不带 id，按「当前对话」服务。 */
	private lastConversationId = "";

	constructor(
		private readonly send: (msg: ServerMessage) => void,
		private readonly cfg: MessageWindowConfig,
	) {}

	get enabled(): boolean {
		return this.cfg.windowSize > 0;
	}

	/** 引擎消息入口：窗口化 snapshot/delta，其余原样透传。 */
	accept(msg: ServerMessage): void {
		if (!this.enabled) {
			this.send(msg);
			return;
		}
		if (msg.type === "snapshot") {
			const state = msg.state;
			const full = state.messages;
			const entry = this.entry(state.conversationId);
			entry.full = full;
			// 首次按「条数 + 字符预算」算；之后只允许单调不增（已翻过的页不能被全量快照推回去）。
			entry.start =
				entry.start < 0
					? pickWindowStart(full, this.cfg)
					: computeWindowStart(entry.start, full.length, this.cfg.windowSize);
			this.lastConversationId = state.conversationId;
			this.send({
				...msg,
				state: {
					...state,
					messages: entry.start > 0 ? full.slice(entry.start) : full,
					historyStart: entry.start,
					historyTotal: full.length,
				},
			});
			return;
		}
		if (msg.type === "snapshot_delta") {
			const entry = this.convs.get(msg.conversationId);
			if (!entry) {
				// 没见过完整基线（重连后先来增量）：原样透传，客户端会凭 rev 缺口自愈。
				this.send(msg);
				return;
			}
			if (msg.appended.length > 0) {
				entry.full = entry.full.concat(msg.appended);
			}
			this.lastConversationId = msg.conversationId;
			this.send({
				...msg,
				state: { ...msg.state, historyStart: entry.start, historyTotal: entry.full.length },
			});
			return;
		}
		this.send(msg);
	}

	/**
	 * 按需回水：从运行时或存储中恢复某个会话的全量消息基线，
	 * 供 LRU 逐出、冷启动或跨连接无快照状态下立即恢复翻页服务能力。
	 */
	rehydrate(convId: string, full: UiMessage[], start?: number): void {
		const entry = this.entry(convId);
		entry.full = full;
		if (start !== undefined && Number.isFinite(start) && start >= 0) {
			entry.start = Math.min(full.length, start);
		} else if (entry.start < 0) {
			entry.start = pickWindowStart(full, this.cfg);
		}
	}

	/** 客户端往上翻页：把窗口起点往前扩 `count` 条（`all` = 一路拉到最早）。
	 *  - `conversationId`: 会话 ID（缺省回退最近一次快照会话）；
	 *  - `beforeId`: 客户端首条消息的 ID（优先使用该不可变锚点，不受压缩/重试导致的下标漂移影响）；
	 *  - `before`: 客户端当前窗口起点下标（自描述游标，entry 丢失或失忆时作为截断右边界）；
	 *  返回 boolean: true = 已命中并下发 earlier_messages; false = entry 未命中（调用方可尝试回水）。 */
	loadEarlier(
		countOrOpts?: number | LoadEarlierOptions,
		all?: boolean,
		conversationId?: string,
		beforeId?: string,
		before?: number,
	): boolean {
		const opts: LoadEarlierOptions =
			typeof countOrOpts === "object" && countOrOpts !== null
				? countOrOpts
				: { count: countOrOpts, all, conversationId, beforeId, before };

		const convId = opts.conversationId || this.lastConversationId;
		const entry = convId ? this.convs.get(convId) : undefined;
		if (!entry || !convId) return false;

		const total = entry.full.length;
		// 确定翻页右边界（end）：
		// 1. 优先使用不可变消息 ID beforeId 定位（防数组位移）；
		// 2. 其次使用客户端自描述下标 before（自描述游标）；
		// 3. 最后回退服务端自身记录的 entry.start（若小于 0 则说明未初始化，回退 total）。
		let end = entry.start >= 0 ? entry.start : total;
		if (opts.beforeId) {
			const idx = entry.full.findIndex((m) => m.id === opts.beforeId);
			if (idx >= 0) {
				end = idx;
			}
		} else if (typeof opts.before === "number" && Number.isFinite(opts.before) && opts.before >= 0) {
			end = Math.min(total, opts.before);
		}

		const page = opts.all ? end : Math.min(MAX_PAGE, Math.max(1, Math.floor(opts.count ?? this.cfg.pageSize) || 1));
		const start = opts.all ? 0 : Math.max(0, end - page);
		const messages = start < end ? entry.full.slice(start, end) : [];
		entry.start = start;
		this.send({
			type: "earlier_messages",
			conversationId: convId,
			messages,
			historyStart: start,
			historyTotal: total,
		});
		return true;
	}

	/** 取（或建）对话窗口；LRU 超限时淘汰最久未用的那个。 */
	private entry(convId: string): ConvWindow {
		const hit = this.convs.get(convId);
		if (hit) {
			this.convs.delete(convId);
			this.convs.set(convId, hit);
			return hit;
		}
		const created: ConvWindow = { full: [], start: -1 };
		this.convs.set(convId, created);
		while (this.convs.size > MAX_CACHED_CONVERSATIONS) {
			const oldest = this.convs.keys().next();
			if (oldest.done) break;
			this.convs.delete(oldest.value);
		}
		return created;
	}
}
