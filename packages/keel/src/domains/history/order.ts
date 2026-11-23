/** 稳定排序用的字符串比较：不用 `localeCompare`（不同机器 locale 会给出不同次序）。 */
export function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
