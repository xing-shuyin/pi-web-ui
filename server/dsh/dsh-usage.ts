export interface DshTokens {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface DshContextUsage {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

function count(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
}

export function normalizeDshUsage(usage: unknown): DshTokens | null {
	if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
	const u = usage as {
		inputTokens?: unknown;
		outputTokens?: unknown;
		cacheReadTokens?: unknown;
		cacheWriteTokens?: unknown;
	};
	return {
		input: count(u.inputTokens),
		output: count(u.outputTokens),
		cacheRead: count(u.cacheReadTokens),
		cacheWrite: count(u.cacheWriteTokens),
	};
}

export function dshPromptTokens(tokens: DshTokens): number {
	return tokens.input + tokens.cacheRead + tokens.cacheWrite;
}

export function dshContextUsage(tokens: DshTokens | null, contextWindow: number): DshContextUsage {
	if (!tokens) return { tokens: null, contextWindow, percent: null };
	const used = dshPromptTokens(tokens) + tokens.output;
	if (!(contextWindow > 0)) return { tokens: used, contextWindow, percent: null };
	return { tokens: used, contextWindow, percent: Math.min(100, (used / contextWindow) * 100) };
}

export function lastUsageFromEvents(
	events: readonly { type: string; data?: Record<string, unknown> }[],
): DshTokens | null {
	let found: DshTokens | null = null;
	for (const ev of events) {
		const data = ev.data ?? {};
		if (ev.type === "assistant/message") {
			const usage = normalizeDshUsage(data.usage);
			if (usage) found = usage;
		} else if (ev.type === "assistant/chunk") {
			const chunk = data.chunk as { type?: unknown; usage?: unknown } | undefined;
			if (chunk?.type === "usage") {
				const usage = normalizeDshUsage(chunk.usage);
				if (usage) found = usage;
			}
		}
	}
	return found;
}
