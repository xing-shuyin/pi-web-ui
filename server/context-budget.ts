import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { SOFT_CAP_MIN_HEADROOM } from "./soft-cap.js";

export type AgentMessage = AgentSession["messages"][number];

export const DEFAULT_PRUNE_WATERMARK = 0.7;

export const DEFAULT_STAGE2_WATERMARK = 0.85;

export const DEFAULT_MIN_TRIM_LINES = 20;

export const DEFAULT_MIN_TRIM_BYTES = 1000;

export const DEFAULT_HEAD_LINES = 3;

export const DEFAULT_TAIL_LINES = 3;

export const DEFAULT_KEEP_RECENT_TURNS = 2;

export function estimateTextTokens(text: string): number {
	if (!text) return 0;
	return Math.ceil(text.length / 4);
}

export function estimateMessageTokens(message: AgentMessage): number {
	let total = 0;
	const msg = message as unknown as Record<string, unknown>;
	if (typeof msg.content === "string") {
		total += estimateTextTokens(msg.content);
	} else if (Array.isArray(msg.content)) {
		for (const block of msg.content) {
			if (!block || typeof block !== "object") continue;
			const b = block as Record<string, unknown>;
			if (b.type === "text" && typeof b.text === "string") {
				total += estimateTextTokens(b.text);
			} else if (b.type === "thinking" && typeof b.thinking === "string") {
				total += estimateTextTokens(b.thinking);
			} else if (b.type === "toolCall" && b.arguments) {
				total += estimateTextTokens(JSON.stringify(b.arguments));
			} else if (b.type === "image") {
				total += 800;
			}
		}
	}
	if (msg.role === "bashExecution" && typeof msg.output === "string") {
		total += estimateTextTokens(msg.output);
	}
	return Math.max(1, total);
}

export function estimateMessagesTotalTokens(messages: AgentMessage[]): number {
	let sum = 0;
	for (const m of messages) {
		sum += estimateMessageTokens(m);
	}
	return sum;
}

export interface TrimToolOutputOptions {
	minLines?: number;
	minBytes?: number;
	headLines?: number;
	tailLines?: number;
	keepRecentTurns?: number;
}

export interface TrimToolOutputResult {
	messages: AgentMessage[];
	trimmedCount: number;
	savedBytes: number;
	savedTokens: number;
}

export function findRecentCutoffIndex(messages: AgentMessage[], keepRecentTurns = DEFAULT_KEEP_RECENT_TURNS): number {
	if (messages.length === 0 || keepRecentTurns <= 0) return 0;
	let userTurnsSeen = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: unknown };
		if (m.role === "user") {
			userTurnsSeen++;
			if (userTurnsSeen >= keepRecentTurns) {
				return i;
			}
		}
	}
	return 0;
}

export function trimDistantToolOutputs(
	messages: AgentMessage[],
	options: TrimToolOutputOptions = {},
): TrimToolOutputResult {
	const minLines = options.minLines ?? DEFAULT_MIN_TRIM_LINES;
	const minBytes = options.minBytes ?? DEFAULT_MIN_TRIM_BYTES;
	const headLines = options.headLines ?? DEFAULT_HEAD_LINES;
	const tailLines = options.tailLines ?? DEFAULT_TAIL_LINES;
	const keepRecentTurns = options.keepRecentTurns ?? DEFAULT_KEEP_RECENT_TURNS;

	const cutoffIndex = findRecentCutoffIndex(messages, keepRecentTurns);
	let trimmedCount = 0;
	let savedBytes = 0;
	let savedTokens = 0;

	const newMessages: AgentMessage[] = messages.map((m, index) => {
		if (index >= cutoffIndex) {
			return m;
		}

		const msg = m as unknown as Record<string, unknown>;

		if (msg.role === "toolResult" && Array.isArray(msg.content)) {
			let modified = false;
			const newContent = msg.content.map((block) => {
				if (!block || typeof block !== "object") return block;
				const b = block as Record<string, unknown>;
				if (b.type === "text" && typeof b.text === "string") {
					const text = b.text;
					if (text.includes("[Tool output trimmed:")) {
						return block;
					}
					const byteLen = Buffer.byteLength(text, "utf8");
					const lines = text.split("\n");
					if (lines.length >= minLines || byteLen >= minBytes) {
						if (lines.length > headLines + tailLines) {
							const head = lines.slice(0, headLines).join("\n");
							const tail = lines.slice(lines.length - tailLines).join("\n");
							const trimmedLines = lines.length - headLines - tailLines;
							const middleText = lines.slice(headLines, lines.length - tailLines).join("\n");
							const trimmedBytes = Buffer.byteLength(middleText, "utf8");

							const placeholder = `[Tool output trimmed: ${trimmedLines} lines / ${trimmedBytes} bytes]`;
							const trimmedText = `${head}\n... ${placeholder} ...\n${tail}`;

							const diffBytes = byteLen - Buffer.byteLength(trimmedText, "utf8");
							if (diffBytes > 0) {
								savedBytes += diffBytes;
								savedTokens += estimateTextTokens(text) - estimateTextTokens(trimmedText);
								trimmedCount++;
								modified = true;
								return { ...b, text: trimmedText };
							}
						}
					}
				}
				return block;
			});

			if (modified) {
				return { ...msg, content: newContent } as unknown as AgentMessage;
			}
		}

		if (msg.role === "bashExecution" && typeof msg.output === "string") {
			const text = msg.output;
			if (!text.includes("[Tool output trimmed:")) {
				const byteLen = Buffer.byteLength(text, "utf8");
				const lines = text.split("\n");
				if (lines.length >= minLines || byteLen >= minBytes) {
					if (lines.length > headLines + tailLines) {
						const head = lines.slice(0, headLines).join("\n");
						const tail = lines.slice(lines.length - tailLines).join("\n");
						const trimmedLines = lines.length - headLines - tailLines;
						const middleText = lines.slice(headLines, lines.length - tailLines).join("\n");
						const trimmedBytes = Buffer.byteLength(middleText, "utf8");

						const placeholder = `[Tool output trimmed: ${trimmedLines} lines / ${trimmedBytes} bytes]`;
						const trimmedText = `${head}\n... ${placeholder} ...\n${tail}`;

						const diffBytes = byteLen - Buffer.byteLength(trimmedText, "utf8");
						if (diffBytes > 0) {
							savedBytes += diffBytes;
							savedTokens += estimateTextTokens(text) - estimateTextTokens(trimmedText);
							trimmedCount++;
							return { ...msg, output: trimmedText } as unknown as AgentMessage;
						}
					}
				}
			}
		}

		return m;
	});

	return {
		messages: newMessages,
		trimmedCount,
		savedBytes,
		savedTokens: Math.max(0, savedTokens),
	};
}

export interface FoldStepOptions {
	keepRecentTurns?: number;
}

export interface FoldStepResult {
	messages: AgentMessage[];
	foldedCount: number;
	savedBytes: number;
	savedTokens: number;
}

export function foldCompletedStepLogs(messages: AgentMessage[], options: FoldStepOptions = {}): FoldStepResult {
	const keepRecentTurns = options.keepRecentTurns ?? 1;
	const cutoffIndex = findRecentCutoffIndex(messages, keepRecentTurns);

	let foldedCount = 0;
	let savedBytes = 0;
	let savedTokens = 0;

	const newMessages: AgentMessage[] = messages.map((m, index) => {
		if (index >= cutoffIndex) {
			return m;
		}

		const msg = m as unknown as Record<string, unknown>;

		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			let modified = false;
			const newContent = msg.content.map((block) => {
				if (!block || typeof block !== "object") return block;
				const b = block as Record<string, unknown>;
				if (b.type === "thinking" && typeof b.thinking === "string") {
					const t = b.thinking;
					if (t.length > 500 && !t.includes("[Completed step debug logs folded:")) {
						const originalBytes = Buffer.byteLength(t, "utf8");
						const lines = t.split("\n").length;
						const foldedPlaceholder = `[Completed step debug logs folded: 1 entry / ${lines} lines]`;
						const diffBytes = originalBytes - Buffer.byteLength(foldedPlaceholder, "utf8");
						if (diffBytes > 0) {
							savedBytes += diffBytes;
							savedTokens += estimateTextTokens(t) - estimateTextTokens(foldedPlaceholder);
							foldedCount++;
							modified = true;
							return { ...b, thinking: foldedPlaceholder };
						}
					}
				}
				return block;
			});

			if (modified) {
				return { ...msg, content: newContent } as unknown as AgentMessage;
			}
		}

		return m;
	});

	return {
		messages: newMessages,
		foldedCount,
		savedBytes,
		savedTokens: Math.max(0, savedTokens),
	};
}

export interface ContextBudgetOptions {
	contextWindow: number;
	reserveTokens: number;
	softCap?: number | null;
	tier1Watermark?: number;
	tier2Watermark?: number;
	force?: boolean;
}

export interface HierarchicalPruningResult {
	messages: AgentMessage[];
	tokensBefore: number;
	tokensAfter: number;
	tier1: {
		trimmedCount: number;
		savedBytes: number;
		savedTokens: number;
	};
	tier2: {
		foldedCount: number;
		savedBytes: number;
		savedTokens: number;
	};
	needsCompaction: boolean;
	reachedTier1: boolean;
	reachedTier2: boolean;
}

export function pruneContextHierarchically(
	messages: AgentMessage[],
	options: ContextBudgetOptions,
): HierarchicalPruningResult {
	const contextWindow = options.contextWindow > 0 ? options.contextWindow : 128_000;
	const reserveTokens = options.reserveTokens > 0 ? options.reserveTokens : 16_384;
	const room = contextWindow - reserveTokens;
	const physicalCap = room > 0 ? room : Math.max(1, contextWindow - SOFT_CAP_MIN_HEADROOM);
	const effectiveCap = options.softCap && options.softCap > 0 ? Math.min(options.softCap, physicalCap) : physicalCap;

	const tier1Watermark = options.tier1Watermark ?? DEFAULT_PRUNE_WATERMARK;
	const tier2Watermark = options.tier2Watermark ?? DEFAULT_STAGE2_WATERMARK;

	const tier1Threshold = Math.floor(effectiveCap * tier1Watermark);
	const tier2Threshold = Math.floor(effectiveCap * tier2Watermark);

	const tokensBefore = estimateMessagesTotalTokens(messages);
	let currentTokens = tokensBefore;
	let currentMessages = messages;

	const tier1Result = { trimmedCount: 0, savedBytes: 0, savedTokens: 0 };
	const tier2Result = { foldedCount: 0, savedBytes: 0, savedTokens: 0 };

	const reachedTier1 = options.force || currentTokens >= tier1Threshold;
	let reachedTier2 = options.force || currentTokens >= tier2Threshold;

	if (reachedTier1) {
		const r1 = trimDistantToolOutputs(currentMessages);
		if (r1.trimmedCount > 0) {
			currentMessages = r1.messages;
			tier1Result.trimmedCount = r1.trimmedCount;
			tier1Result.savedBytes = r1.savedBytes;
			tier1Result.savedTokens = r1.savedTokens;
			currentTokens = estimateMessagesTotalTokens(currentMessages);
		}
	}

	reachedTier2 = reachedTier2 || currentTokens >= tier2Threshold;
	if (reachedTier2 || (options.force && currentTokens >= effectiveCap)) {
		const r2 = foldCompletedStepLogs(currentMessages);
		if (r2.foldedCount > 0) {
			currentMessages = r2.messages;
			tier2Result.foldedCount = r2.foldedCount;
			tier2Result.savedBytes = r2.savedBytes;
			tier2Result.savedTokens = r2.savedTokens;
			currentTokens = estimateMessagesTotalTokens(currentMessages);
		}
	}

	const needsCompaction = currentTokens >= effectiveCap;

	return {
		messages: currentMessages,
		tokensBefore,
		tokensAfter: currentTokens,
		tier1: tier1Result,
		tier2: tier2Result,
		needsCompaction,
		reachedTier1,
		reachedTier2,
	};
}
