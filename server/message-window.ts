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
		private readonly send: (msg: ServerMessage) => void,
		private readonly cfg: MessageWindowConfig,
	) {}

	get enabled(): boolean {
		return this.cfg.windowSize > 0;
	}

	accept(msg: ServerMessage): void {
		if (!this.enabled) {
			this.send(msg);
			return;
		}
		if (msg.type === "snapshot") {
			const state = msg.state;
			const full = state.messages;
			const entry = this.entry(state.conversationId);
			this.updateBaseline(entry, full);
			this.lastConversationId = state.conversationId;
			this.send({
				...msg,
				state: {
					...state,
					messages: entry.start > 0 ? full.slice(entry.start) : full,
					historyStart: entry.start,
					historyTotal: full.length,
					historyGeneration: entry.generation,
				},
			});
			return;
		}
		if (msg.type === "snapshot_delta") {
			const entry = this.convs.get(msg.conversationId);
			if (!entry) {
				this.send(msg);
				return;
			}
			if (msg.appended.length > 0) {
				entry.full = entry.full.concat(msg.appended);
				entry.ids.push(...msg.appended.map((m) => m.id));
			}
			this.lastConversationId = msg.conversationId;
			this.send({
				...msg,
				state: {
					...msg.state,
					historyStart: entry.start,
					historyTotal: entry.full.length,
					historyGeneration: entry.generation,
				},
			});
			return;
		}
		this.send(msg);
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
		const rewritten = entry.ids.length > full.length || entry.ids.some((id, i) => full[i]?.id !== id);
		if (rewritten) entry.generation = randomUUID();
		if (entry.start < 0 || rewritten) entry.start = pickWindowStart(full, this.cfg);
		entry.full = full;
		entry.ids = full.map((m) => m.id);
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
