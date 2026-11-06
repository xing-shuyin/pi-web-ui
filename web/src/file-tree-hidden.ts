export function isHiddenEntryName(name: string): boolean {
	return name.startsWith(".") && name !== "..";
}

export function visibleTreeEntries<T extends { name: string }>(
	entries: readonly T[],
	showHidden: boolean,
): readonly T[] {
	if (showHidden) return entries;
	return entries.filter((entry) => !isHiddenEntryName(entry.name));
}
