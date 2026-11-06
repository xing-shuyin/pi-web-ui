import { DEFAULT_COMPACTION_SETTINGS } from "@earendil-works/pi-coding-agent";

export const DEFAULT_COMPACTION_RESERVE_TOKENS = DEFAULT_COMPACTION_SETTINGS.reserveTokens;

export const SOFT_CAP_MIN_TOKENS = 2000;
export const SOFT_CAP_MIN_HEADROOM = 2048;
export const SOFT_CAP_MAX_OVERRIDES = 64;

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

export function normalizeAutoCompactionInstructions(v: unknown): string {
	return typeof v === "string" ? v.slice(0, 2000) : "";
}

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

export function softCapToReserve(contextWindow: number, cap: number): number | null {
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) return null;
	if (!Number.isFinite(cap) || cap < SOFT_CAP_MIN_TOKENS) return null;
	const reserve = Math.floor(contextWindow - cap);
	if (reserve < SOFT_CAP_MIN_HEADROOM) return null;
	return reserve;
}

export function softCapReserveFor(contextWindow: number, cap: number, keepRecentTokens = 0): number | null {
	const reserve = softCapToReserve(contextWindow, cap);
	if (reserve === null) return null;
	if (Number.isFinite(keepRecentTokens) && keepRecentTokens > 0 && cap <= keepRecentTokens + SOFT_CAP_MIN_HEADROOM) {
		return null;
	}
	return Math.max(DEFAULT_COMPACTION_RESERVE_TOKENS, reserve);
}
