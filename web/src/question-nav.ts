export function questionNavLayout(count: number, height: number, activeIndex: number) {
	const available = Math.max(0, height);
	const capacity = Math.floor((available + 4) / 7);
	const visible = Math.min(count, capacity);
	const indices = Array.from({ length: visible }, (_, slot) => {
		const start = Math.floor((slot * count) / visible);
		const end = Math.floor(((slot + 1) * count) / visible) - 1;
		if (activeIndex >= start && activeIndex <= end) return activeIndex;
		return slot === visible - 1 ? end : start;
	});
	const gap = visible > 1 ? Math.min(27, (available - visible * 3) / (visible - 1)) : 0;
	return { indices, gap, many: count > visible || (visible > 1 && gap < 20) };
}
