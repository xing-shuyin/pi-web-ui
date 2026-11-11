/**
 * 移动端设置首页的「页签 → 分组」投影。
 *
 * 只做纯函数计算，不依赖 DOM / i18n，方便单测守住两件事：
 * 1. 分组内保持桌面侧栏的原有顺序（用户在两端的心理地图一致）；
 * 2. 任何新增页签都不会在移动端消失 —— 未知分组回落到最后一个分组，
 *    而不是被静默丢弃（这类回归在真机上极难发现）。
 */
export interface SettingsTabLike {
	id: string;
}

export interface GroupedTabs<T> {
	key: string;
	tabs: T[];
}

export function groupTabs<T extends SettingsTabLike>(
	tabs: readonly T[],
	groupOf: (id: string) => string,
	groupKeys: readonly string[],
): Array<GroupedTabs<T>> {
	const keys = [...groupKeys];
	const buckets = new Map<string, T[]>();
	for (const key of keys) buckets.set(key, []);
	const fallback = keys.at(-1);
	for (const tab of tabs) {
		const wanted = groupOf(tab.id);
		const bucket = buckets.get(wanted) ?? (fallback ? buckets.get(fallback) : undefined);
		bucket?.push(tab);
	}
	return keys.map((key) => ({ key, tabs: buckets.get(key) ?? [] }));
}
