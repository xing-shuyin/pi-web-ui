interface TopbarFitItem {
	id: string;
	width: number;
}

export const MOBILE_ASIDE_TOPBAR_IDS: ReadonlySet<string> = new Set(["host:files"]);

export function sortOverflowMenuItems<T extends { id: string; align?: string }>(
	items: readonly T[],
	rankOf: (id: string) => number,
): T[] {
	const zone = (align?: string): number => (align === "center" ? 1 : align === "end" ? 2 : 0);
	return [...items].sort((a, b) => zone(a.align) - zone(b.align) || rankOf(a.id) - rankOf(b.id));
}

export function fitTopbar(
	items: TopbarFitItem[],
	available: number,
	gap: number,
	reserve: number,
	keepIds: ReadonlySet<string> = new Set(),
): Set<string> {
	const drop = new Set<string>();
	if (!Number.isFinite(available) || available <= 0) return drop;
	const keptWidth = items
		.filter((it) => keepIds.has(it.id) && it.width > 0)
		.reduce((sum, it) => sum + it.width + gap, 0);
	const budget = Math.max(0, available - Math.max(0, reserve) - keptWidth);
	let acc = 0;
	let overflowing = false;
	for (const it of items) {
		if (!(it.width > 0)) continue;
		if (keepIds.has(it.id)) continue;
		const need = it.width + gap;
		if (overflowing || acc + need > budget) {
			overflowing = true;
			drop.add(it.id);
			continue;
		}
		acc += need;
	}
	return drop;
}
