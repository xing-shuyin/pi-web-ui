export type AppendRejectionReason = "duplicate" | "cap";

export interface AppendRejectedTool {
	name: string;
	reason: AppendRejectionReason;
}

export interface AppendLoadedToolsResult {
	names: string[];
	rejected: AppendRejectedTool[];
}

/**
 * 按需加载只许追加：绝不就地修改入参、绝不删除已加载项（前缀缓存红线）。
 * 返回新数组，去重保序；到 cap 之后保留先加载的，后到的进 rejected。
 */
export function appendLoadedTools(
	current: readonly string[],
	added: readonly string[],
	cap: number,
): AppendLoadedToolsResult {
	const names: string[] = [];
	const seen = new Set<string>();
	for (const name of current) {
		if (seen.has(name)) continue;
		seen.add(name);
		names.push(name);
	}
	// cap 非法（NaN/负/小数）时按 0 收敛；已超 cap 的 current 原样保留，不删。
	const limit = Number.isFinite(cap) ? Math.max(0, Math.floor(cap)) : Number.POSITIVE_INFINITY;
	const rejected: AppendRejectedTool[] = [];
	for (const name of added) {
		if (seen.has(name)) {
			rejected.push({ name, reason: "duplicate" });
			continue;
		}
		if (names.length >= limit) {
			rejected.push({ name, reason: "cap" });
			continue;
		}
		seen.add(name);
		names.push(name);
	}
	return { names, rejected };
}
