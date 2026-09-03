/**
 * 模型使用次数统计（按 "provider/id" 计数，localStorage 持久化）。
 *
 * 纯函数核心（normalizeUsage / incrementUsage / sortByUsage）与存储层
 * （loadModelUsage / recordModelUsage）分离：核心可单测，存储层薄封装并做
 * 异常兜底（隐私模式 / 配额满时只内存计数，不抛错）。
 *
 * 计数时机：每次提交 prompt 时把当时的当前模型 +1（见 ChatInput.submit），
 * 模型下拉据此按使用次数降序排列（次数相同保持原有顺序）。
 */

const STORAGE_KEY = "pi-web-model-usage";

/** 解析并规整持久化的使用次数映射（防御坏数据：非对象 / 非正数 / 非有限值）。 */
export function normalizeUsage(raw: unknown): Record<string, number> {
	if (!raw || typeof raw !== "object") return {};
	const out: Record<string, number> = {};
	for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
		const n = typeof v === "number" ? Math.floor(v) : 0;
		if (Number.isFinite(n) && n > 0) out[k] = n;
	}
	return out;
}

/** 纯函数：把某模型使用次数 +1，返回新映射（不改入参）。空 id 直接原样返回。 */
export function incrementUsage(usage: Record<string, number>, modelId: string): Record<string, number> {
	if (!modelId) return usage;
	return { ...usage, [modelId]: (usage[modelId] ?? 0) + 1 };
}

/** 纯函数：按使用次数降序稳定排序（次数相同保持传入顺序，避免无使用记录的
 *  模型被无意义重排）。返回新数组，不改入参。 */
export function sortByUsage<T extends { id: string }>(models: T[], usage: Record<string, number>): T[] {
	const n = usage;
	return models
		.map((m, i) => ({ m, i, count: n[m.id] ?? 0 }))
		.sort((a, b) => b.count - a.count || a.i - b.i)
		.map((x) => x.m);
}

/** 读取持久化的使用次数（localStorage 不可用或数据损坏时回退空映射）。 */
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
	} catch {
		// 存储不可用——丢弃，仅影响本次会话内的排序。
	}
}

/** 记录一次模型使用（+1 并持久化），返回新的完整映射。 */
export function recordModelUsage(modelId: string): Record<string, number> {
	const next = incrementUsage(loadModelUsage(), modelId);
	persist(next);
	return next;
}
