import { randomUUID } from "node:crypto";
import type { ServerMessage, UiMessage } from "./protocol.js";

export const DEFAULT_HISTORY_WINDOW = 300;
export const DEFAULT_HISTORY_CHARS = 1_500_000;
export const DEFAULT_HISTORY_PAGE = 30;
const MAX_PAGE = 2000;
const MAX_CACHED_CONVERSATIONS = 64;

export interface LoadEarlierOptions {
	count?: number;
	all?: boolean;
	conversationId?: string;
	beforeId?: string;
	before?: number;
	historyGeneration?: string;
}

export interface MessageWindowConfig {
	windowSize: number;
	charBudget: number;
	pageSize: number;
}

const OFF_CONFIG: MessageWindowConfig = { windowSize: 0, charBudget: 0, pageSize: DEFAULT_HISTORY_PAGE };
const DEFAULT_CONFIG: MessageWindowConfig = {
	windowSize: DEFAULT_HISTORY_WINDOW,
	charBudget: DEFAULT_HISTORY_CHARS,
	pageSize: DEFAULT_HISTORY_PAGE,
};

export function readMessageWindowConfig(env: NodeJS.ProcessEnv): MessageWindowConfig {
	const raw = (env.PI_WEB_HISTORY_WINDOW ?? "").trim().toLowerCase();
	if (raw === "0" || raw === "off" || raw === "false" || raw === "no") return OFF_CONFIG;
	if (raw === "") return DEFAULT_CONFIG;
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) return DEFAULT_CONFIG;
	return { ...DEFAULT_CONFIG, windowSize: Math.floor(n) };
}

export function computeWindowStart(prevStart: number, total: number, windowSize: number): number {
	if (windowSize <= 0) return 0;
	const tail = Math.max(0, total - windowSize);
	if (prevStart < 0) return tail;
	return Math.min(prevStart, tail);
}

export function estimateMessageChars(m: UiMessage): number {
	let n = 0;
	const content = (m as { content?: readonly Record<string, unknown>[] }).content;
	if (Array.isArray(content)) {
		for (const b of content) {
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

/** 一次基线演进的结果：先算出来，帧真送出去了再落盘（见 `accept`）。 */
interface WindowPlan {
	start: number;
	generation: string;
}

function planWindow(entry: ConvWindow, full: readonly UiMessage[], cfg: MessageWindowConfig): WindowPlan {
	const rewritten = entry.ids.length > full.length || entry.ids.some((id, i) => full[i]?.id !== id);
	const start = entry.start < 0 || rewritten ? pickWindowStart(full, cfg) : entry.start;
	return { start, generation: rewritten ? randomUUID() : entry.generation };
}

function commitWindow(entry: ConvWindow, full: UiMessage[], plan: WindowPlan): void {
	entry.generation = plan.generation;
	entry.start = plan.start;
	entry.full = full;
	entry.ids = full.map((m) => m.id);
}

interface ConvWindow {
	full: UiMessage[];
	start: number;
	generation: string;
	ids: string[];
}

export class MessageWindowTap {
	private readonly convs = new Map<string, ConvWindow>();
	private lastConversationId = "";
	private scope = "";

	setScope(scope: string): void {
		if (this.scope === scope) return;
		this.scope = scope;
		this.convs.clear();
		this.lastConversationId = "";
	}

	constructor(
		private readonly send: (msg: ServerMessage) => boolean | void,
		private readonly cfg: MessageWindowConfig,
	) {}

	get enabled(): boolean {
		return this.cfg.windowSize > 0;
	}

	/**
	 * 返回 false = 这一帧没送到 socket（背压），调用方可据此不更新「已送达」基线。
	 *
	 * 窗口基线只在**真正送出去之后**才提交：丢了一帧却不回滚，基线就会跑在客户端前面，
	 * 下一次补发的 `appended` 会被重复追加进 `entry.full`（historyTotal / 翻页锚点跟着错）。
	 */
	accept(msg: ServerMessage): boolean | void {
		if (!this.enabled) {
			return this.send(msg);
		}
		if (msg.type === "snapshot") {
			const state = msg.state;
			const full = state.messages;
			const entry = this.entry(state.conversationId);
			const next = planWindow(entry, full, this.cfg);
			const delivered = this.send({
				...msg,
				state: {
					...state,
					messages: next.start > 0 ? full.slice(next.start) : full,
					historyStart: next.start,
					historyTotal: full.length,
					historyGeneration: next.generation,
				},
			});
			if (delivered === false) return false;
			commitWindow(entry, full, next);
			this.lastConversationId = state.conversationId;
			return delivered;
		}
		if (msg.type === "snapshot_delta") {
			const entry = this.convs.get(msg.conversationId);
			if (!entry) return this.send(msg);
			const full = msg.appended.length > 0 ? entry.full.concat(msg.appended) : entry.full;
			const delivered = this.send({
				...msg,
				state: {
					...msg.state,
					historyStart: entry.start,
					historyTotal: full.length,
					historyGeneration: entry.generation,
				},
			});
			if (delivered === false) return false;
			if (msg.appended.length > 0) {
				entry.full = full;
				entry.ids.push(...msg.appended.map((m) => m.id));
			}
			this.lastConversationId = msg.conversationId;
			return delivered;
		}
		return this.send(msg);
	}

	rehydrate(convId: string, full: UiMessage[], start?: number): void {
		const entry = this.entry(convId);
		const fresh = entry.start < 0;
		this.updateBaseline(entry, full);
		if (fresh && start !== undefined && Number.isFinite(start) && start >= 0) {
			entry.start = Math.min(full.length, start);
		}
	}

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
		const anchor = opts.beforeId === undefined ? undefined : entry.full.findIndex((m) => m.id === opts.beforeId);
		const invalid =
			(opts.historyGeneration !== undefined && opts.historyGeneration !== entry.generation) ||
			anchor === -1 ||
			(opts.before !== undefined && (!Number.isInteger(opts.before) || opts.before < 0 || opts.before > total)) ||
			(anchor !== undefined && opts.before !== undefined && anchor !== opts.before);
		if (invalid) {
			this.send({
				type: "earlier_messages",
				conversationId: convId,
				messages: [],
				historyStart: entry.start,
				historyTotal: total,
				historyGeneration: entry.generation,
				beforeId: opts.beforeId,
				before: opts.before,
				resyncRequired: true,
			});
			return true;
		}
		let end = entry.start >= 0 ? entry.start : total;
		if (anchor !== undefined) {
			end = anchor;
		} else if (typeof opts.before === "number" && Number.isFinite(opts.before) && opts.before >= 0) {
			end = Math.min(total, opts.before);
		}

		const page = opts.all ? end : Math.min(MAX_PAGE, Math.max(1, Math.floor(opts.count ?? this.cfg.pageSize) || 1));
		const start = opts.all ? 0 : Math.max(0, end - page);
		const messages = start < end ? entry.full.slice(start, end) : [];
		entry.start = Math.min(entry.start, start);
		this.send({
			type: "earlier_messages",
			conversationId: convId,
			messages,
			historyStart: start,
			historyTotal: total,
			historyGeneration: entry.generation,
			beforeId: entry.full[end]?.id,
			before: end,
		});
		return true;
	}

	private updateBaseline(entry: ConvWindow, full: UiMessage[]): void {
		const next = planWindow(entry, full, this.cfg);
		entry.generation = next.generation;
		entry.start = next.start;
		commitWindow(entry, full, next);
	}

	private entry(convId: string): ConvWindow {
		const hit = this.convs.get(convId);
		if (hit) {
			this.convs.delete(convId);
			this.convs.set(convId, hit);
			return hit;
		}
		const created: ConvWindow = { full: [], start: -1, generation: randomUUID(), ids: [] };
		this.convs.set(convId, created);
		while (this.convs.size > MAX_CACHED_CONVERSATIONS) {
			const oldest = this.convs.keys().next();
			if (oldest.done) break;
			this.convs.delete(oldest.value);
		}
		return created;
	}
}
