export interface ToolGatingInput {
	/** live 工具库存（注册顺序），结果按这个顺序出 */
	catalog: readonly string[];
	/** 硬关闭集：设置里的禁用 + 预设/模式闸门 + 安全模式，已由调用方并好 */
	disabled: readonly string[];
	/** 按需名单：名单里未加载的工具不参与本轮 */
	onDemand: readonly string[];
	/** 本会话已加载的按需工具：放行 */
	loaded: readonly string[];
	platformSupported: (name: string) => boolean;
}

/**
 * 活动工具集唯一漏斗：`(disabled ∪ onDemand - loaded)` 只做减法，catalog 原顺序、去重。
 * 禁用的工具即使进了按需名单并已加载也不放行（禁用永远是减法，不会被加载“复活”）。
 */
export function resolveActiveToolNames(input: ToolGatingInput): string[] {
	const loaded = new Set(input.loaded);
	const removed = new Set(input.disabled);
	for (const name of input.onDemand) {
		if (!loaded.has(name)) removed.add(name);
	}
	const active: string[] = [];
	const seen = new Set<string>();
	for (const name of input.catalog) {
		if (seen.has(name)) continue;
		seen.add(name);
		if (removed.has(name)) continue;
		if (!input.platformSupported(name)) continue;
		active.push(name);
	}
	return active;
}
