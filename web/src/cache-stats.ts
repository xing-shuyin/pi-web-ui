/**
 * Pure cache-economics helpers for the footer status bar — the live
 * prompt-cache hit rate and the streaming generation rate (tokens/sec).
 *
 * Deliberately dependency-free (structural types only, like message-delta.ts /
 * skill-block.ts) so it can be unit-tested from tsconfig.tests.json (node16
 * resolution) while also being bundled by Vite.
 *
 * The pi SDK already surface the raw per-request counters on every turn:
 *   input    = input tokens billed as NON-cached (cache "misses")
 *   cacheRead  = cache_read_input_tokens   (served from provider cache)
 *   cacheWrite = cache_creation_input_tokens (wrote/refreshed a cache entry)
 * These are plain totals, so the hit rate we compute here rides the same
 * 60ms snapshot + message_delta the rest of the footer already updates on.
 */

/** Structural subset of UiState.stats.tokens we touch. */
export interface CacheTokenInput {
	input: number;
	cacheRead: number;
	cacheWrite: number;
}

/** Derived cache-economics numbers for one conversation. */
export interface CacheMetrics {
	/** Total input tokens this conversation has billed = miss + read + write. */
	totalInput: number;
	/** Input tokens billed as normal non-cached (cache "miss"). */
	miss: number;
	/** Input tokens served from the provider prompt cache. */
	read: number;
	/** Input tokens that wrote / refreshed a cache entry. */
	write: number;
	/** Prompt-cache hit rate, 0..1. */
	hitRate: number;
	/** Cache-write ratio, 0..1 (fraction of input that created cache entries). */
	writeRate: number;
}

/** Compute cache hit / write rates from the SDK's cumulative token counters.
 *
 *  The SDK's `input` is only the non-cached portion, so total input is
 *  `input + cacheRead + cacheWrite` (same accounting catop uses: the per-request
 *  `input_tokens` excludes `cache_read_input_tokens` and
 *  `cache_creation_input_tokens`). Rates are clamped to 1.0 before the counter
 *  totals converge (provider-side rounding can briefly exceed the cap).
 */
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

// ----------------------------------------------------------------------------
// Streaming generation rate (tokens/sec) — a rolling speedometer.
// ----------------------------------------------------------------------------

/** One throughput sample: wall-clock time + cumulative output token count. */
export interface RateSample {
	t: number;
	out: number;
}

/** Trailing window (ms) the live speedometer averages over. Short enough to
 *  feel live, long enough to damp per-message jitter. */
export const RATE_WINDOW_MS = 2000;

/** Drop samples older than `windowMs` from `now`. Time-ordered in, ordered out. */
export function trimRateSamples(
	samples: readonly RateSample[],
	now: number,
	windowMs: number = RATE_WINDOW_MS,
): RateSample[] {
	return samples.filter((s) => now - s.t <= windowMs);
}

/** Tokens/sec over the trailing window from an already-trimmed, time-ordered
 *  sample list. 0 when fewer than two samples (no measurable progress yet). */
export function streamRate(samples: readonly RateSample[], windowMs: number = RATE_WINDOW_MS): number {
	if (samples.length < 2) return 0;
	const last = samples[samples.length - 1];
	// Samples are pre-trimmed, so the first one is the window edge (or later if
	// generation only just started — that still yields a live, spiky reading).
	const firstInWindow = samples.find((s) => s.t >= last.t - windowMs) ?? samples[0];
	const dt = (last.t - firstInWindow.t) / 1000;
	if (dt <= 0) return 0;
	return Math.max(0, (last.out - firstInWindow.out) / dt);
}

// ----------------------------------------------------------------------------
// Live token estimation for the in-flight assistant message.
//
// The SDK only commits a turn's usage counters at message_end, so
// `stats.tokens.output` is FLAT for the whole streaming run. The only thing
// that actually grows per token on the wire is the streaming content itself
// (text + thinking). We approximate its token count with a lightweight,
// language-aware heuristic: CJK chars ≈ 1 token each, non-CJK runs ≈ 1 token
// per 4 chars. Good enough for a live speedometer where the exact number would
// only arrive at message_end anyway.
// ----------------------------------------------------------------------------

/** Structural subset of the streaming content blocks we count. `unknown` so it
 *  accepts the UiContentBlock union (whose catch-all carries an index signature). */
export interface StreamTokenBlock {
	type: string;
	text?: unknown;
	thinking?: unknown;
}

/** CRUDE tokens for a chunk of output text (CJK-aware). */
export function estimateTextTokens(text: string): number {
	if (!text) return 0;
	let cjk = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		// CJK Unified + CJK punctuation/ranges (kangxi, hiragana, katakana,
		// half/fullwidth forms). These are denser than latin, ~1 token each.
		if (
			(c >= 0x3040 && c <= 0x30ff) || // hiragana + katakana
			(c >= 0x3400 && c <= 0x4dbf) || // CJK ext A
			(c >= 0x4e00 && c <= 0x9fff) || // CJK unified
			(c >= 0xf900 && c <= 0xfaff) || // CJK compat
			(c >= 0xff00 && c <= 0xffef) || // fullwidth/halfwidth
			c === 0x3000 // ideographic space
		) {
			cjk++;
		}
	}
	const latin = text.length - cjk;
	return Math.round(cjk + latin / 4);
}

/** Cumulative token estimate for the in-flight assistant message content. */
export function estimateStreamTokens(content: readonly StreamTokenBlock[]): number {
	let tokens = 0;
	for (const block of content) {
		if (block.type === "text" && typeof block.text === "string" && block.text) tokens += estimateTextTokens(block.text);
		else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking)
			tokens += estimateTextTokens(block.thinking);
	}
	return tokens;
}
