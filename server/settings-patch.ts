import { normalizeToolPromptOverrides } from "./tool-prompt-overrides.js";

/**
 * 设置面板发送的是局部补丁；map 字段按子键覆盖、空字符串删除，其余字段整值替换。
 * Core / Universal / DSH 必须共用这一语义，避免改一个 token 抹掉同 map 的其它 token。
 */
export function mergeSettingsPatch(before: object, patch: object): Record<string, unknown> {
	const beforeMap = before as Record<string, unknown>;
	const patchMap = patch as Record<string, unknown>;
	const merged = { ...patchMap };
	if (patchMap.promptOverrides !== undefined) {
		const overrides = { ...(beforeMap.promptOverrides as Record<string, unknown> | undefined) };
		for (const [key, value] of Object.entries((patchMap.promptOverrides as Record<string, unknown>) ?? {})) {
			if (typeof value === "string" && !value.trim()) delete overrides[key];
			else overrides[key] = value;
		}
		merged.promptOverrides = overrides;
	}
	if (patchMap.toolPromptOverrides !== undefined) {
		const overrides = { ...(beforeMap.toolPromptOverrides as Record<string, unknown> | undefined) };
		const normalized = normalizeToolPromptOverrides(patchMap.toolPromptOverrides);
		for (const key of Object.keys((patchMap.toolPromptOverrides as Record<string, unknown>) ?? {})) {
			if (normalized[key]) overrides[key] = normalized[key];
			else delete overrides[key];
		}
		merged.toolPromptOverrides = normalizeToolPromptOverrides(overrides);
	}
	return merged;
}
