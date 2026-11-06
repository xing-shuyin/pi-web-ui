interface CacheTokenInput {
	input: number;
	cacheRead: number;
	cacheWrite: number;
}

interface CacheMetrics {
	totalInput: number;
	miss: number;
	read: number;
	write: number;
	hitRate: number;
	writeRate: number;
}

export function cacheMetrics(tokens: CacheTokenInput): CacheMetrics {
	const miss = Math.max(0, tokens.input ?? 0);
	const read = Math.max(0, tokens.cacheRead ?? 0);
	const write = Math.max(0, tokens.cacheWrite ?? 0);
	const totalInput = miss + read + write;
	return {
		totalInput,
		miss,
		read,
		write,
		hitRate: totalInput > 0 ? Math.min(read / totalInput, 1) : 0,
		writeRate: totalInput > 0 ? Math.min(write / totalInput, 1) : 0,
	};
}

export interface RateSample {
	t: number;
	out: number;
}

const RATE_WINDOW_MS = 2000;

export function trimRateSamples(
	samples: readonly RateSample[],
	now: number,
	windowMs: number = RATE_WINDOW_MS,
): RateSample[] {
	return samples.filter((s) => now - s.t <= windowMs);
}

export function streamRate(samples: readonly RateSample[], windowMs: number = RATE_WINDOW_MS): number {
	if (samples.length < 2) return 0;
	const last = samples[samples.length - 1];
	const firstInWindow = samples.find((s) => s.t >= last.t - windowMs) ?? samples[0];
	const dt = (last.t - firstInWindow.t) / 1000;
	if (dt <= 0) return 0;
	return Math.max(0, (last.out - firstInWindow.out) / dt);
}

interface StreamTokenBlock {
	type: string;
	text?: unknown;
	thinking?: unknown;
}

export function estimateTextTokens(text: string): number {
	if (!text) return 0;
	let cjk = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (
			(c >= 0x3040 && c <= 0x30ff) ||
			(c >= 0x3400 && c <= 0x4dbf) ||
			(c >= 0x4e00 && c <= 0x9fff) ||
			(c >= 0xf900 && c <= 0xfaff) ||
			(c >= 0xff00 && c <= 0xffef) ||
			c === 0x3000
		) {
			cjk++;
		}
	}
	const latin = text.length - cjk;
	return Math.round(cjk + latin / 4);
}

export function estimateStreamTokens(content: readonly StreamTokenBlock[]): number {
	let tokens = 0;
	for (const block of content) {
		if (block.type === "text" && typeof block.text === "string" && block.text) tokens += estimateTextTokens(block.text);
		else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking)
			tokens += estimateTextTokens(block.thinking);
	}
	return tokens;
}
