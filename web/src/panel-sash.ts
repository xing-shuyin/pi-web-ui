interface SashPair {
	above: number;
	below: number;
}

export function parseWeights<T extends Record<string, number>>(raw: string | null, defaults: T): T {
	const out: Record<string, number> = { ...defaults };
	if (!raw) return out as T;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			for (const key of Object.keys(defaults)) {
				const value = (parsed as Record<string, unknown>)[key];
				if (typeof value === "number" && Number.isFinite(value) && value > 0) out[key] = value;
			}
		}
	} catch {}
	return out as T;
}

interface SashDragInput {
	start: SashPair;
	deltaPx: number;
	availablePx: number;
	totalWeight: number;
	minAbovePx: number;
	minBelowPx: number;
}

export function applySashDrag(input: SashDragInput): SashPair {
	const pairTotal = input.start.above + input.start.below;
	const available = Math.max(1, input.availablePx);
	const totalWeight = input.totalWeight > 0 ? input.totalWeight : 1;
	const pxPerWeight = available / totalWeight;
	const minAboveWeight = input.minAbovePx / pxPerWeight;
	const minBelowWeight = input.minBelowPx / pxPerWeight;
	if (minAboveWeight + minBelowWeight >= pairTotal) {
		const minTotal = input.minAbovePx + input.minBelowPx || 1;
		const above = (pairTotal * input.minAbovePx) / minTotal;
		return { above, below: pairTotal - above };
	}
	const above = Math.min(
		pairTotal - minBelowWeight,
		Math.max(minAboveWeight, input.start.above + input.deltaPx / pxPerWeight),
	);
	return { above, below: pairTotal - above };
}
