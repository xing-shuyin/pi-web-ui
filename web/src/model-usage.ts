const STORAGE_KEY = "pi-web-model-usage";

export function normalizeUsage(raw: unknown): Record<string, number> {
	if (!raw || typeof raw !== "object") return {};
	const out: Record<string, number> = {};
	for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
		const n = typeof v === "number" ? Math.floor(v) : 0;
		if (Number.isFinite(n) && n > 0) out[k] = n;
	}
	return out;
}

export function incrementUsage(usage: Record<string, number>, modelId: string): Record<string, number> {
	if (!modelId) return usage;
	return { ...usage, [modelId]: (usage[modelId] ?? 0) + 1 };
}

export function sortByUsage<T extends { id: string }>(models: T[], usage: Record<string, number>): T[] {
	const n = usage;
	return models
		.map((m, i) => ({ m, i, count: n[m.id] ?? 0 }))
		.sort((a, b) => b.count - a.count || a.i - b.i)
		.map((x) => x.m);
}

export function loadModelUsage(): Record<string, number> {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		return raw ? normalizeUsage(JSON.parse(raw)) : {};
	} catch {
		return {};
	}
}

function persist(usage: Record<string, number>): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(usage));
	} catch {}
}

export function recordModelUsage(modelId: string): Record<string, number> {
	const next = incrementUsage(loadModelUsage(), modelId);
	persist(next);
	return next;
}
