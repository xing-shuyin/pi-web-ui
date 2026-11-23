import type { ClientSettings } from "../../settings-schema.js";
import {
	normalizeBgCleanupMinutes,
	normalizeCodemodeInlineBudget,
	normalizeCodemodeMode,
	normalizeDisabledPluginTools,
	normalizeKeepRecentMessages,
	normalizeQueueMode,
	normalizeRetryMaxAttempts,
	normalizeSkillList,
	normalizeSkillsCatalogBudget,
	normalizeSkillsCatalogMaxDesc,
	normalizeSkillsFullTextMaxBytes,
	normalizeSkillsMaxFileBytes,
	normalizeSubagentAutoWakeMaxTurns,
	normalizeToolWatchdogTimeoutMs,
} from "../../settings-normalize.js";
import { normalizeUiLayout } from "../../ui-layout.js";

/**
 * 提示词来源的归一规则：**单源在宿主**（`server/client-state.ts` 的 `normalizePromptOverrides` /
 * `normalizePromptDisabled`，它们依赖 `server/prompt-composer.ts` 的 token 表）。提示词域还没进内核，
 * 所以这里只按注入的两个纯函数收口——不在内核里复制一份 token 表，也不在这里改判定。
 */
export interface SettingsPromptNormalizers {
	normalizePromptOverrides(overrides?: Record<string, string> | null): Record<string, string>;
	normalizePromptDisabled(
		stored?: { promptDisabled?: string[]; _promptPluginDevConfigured?: boolean } | null,
	): string[];
}

/**
 * 下发视图只投影 schema 侧已有 `normalize*` 单源的字段，键名与 `ClientSettings` 逐字一致。
 * 补丁值类型不符（`string` 撞 `number`、数组撞对象…）→ 回落当前值；类型相符但越界 / 不在枚举内 →
 * 由单源 `normalize*` 收敛（可能收敛到它自己的默认值，域里不做第二套裁定）。
 */
export type SettingsViewKey =
	| "promptOverrides"
	| "promptDisabled"
	| "disabledPluginTools"
	| "keepRecentMessages"
	| "toolWatchdogTimeoutMs"
	| "bgAutoCleanupMin"
	| "retryMaxAttempts"
	| "subagentAutoWakeMaxTurns"
	| "skillsFullText"
	| "skillsMaxFileBytes"
	| "skillsFullTextMaxBytes"
	| "skillsCatalogMaxDesc"
	| "skillsCatalogBudget"
	| "codemodeMode"
	| "codemodeInlineBudget"
	| "steeringMode"
	| "followUpMode"
	| "uiLayout";

export type SettingsView = Required<Pick<ClientSettings, SettingsViewKey>>;

export interface SettingsViewInput {
	/** 当前生效值（可以是落盘原文，未归一化）。 */
	current: Partial<ClientSettings>;
	/** 按到达顺序排列的补丁序列；后面的覆盖前面的。 */
	patches?: readonly (Partial<ClientSettings> | null | undefined)[] | null;
	/** 提示词来源的归一（宿主注入，见 `SettingsPromptNormalizers`）。 */
	prompt: SettingsPromptNormalizers;
}

export function buildSettingsView(input: SettingsViewInput): SettingsView {
	const current = input.current ?? {};
	const patches = input.patches ?? [];
	const pick = <T>(key: keyof ClientSettings, coerce: (value: unknown) => T | undefined): T | undefined =>
		lastAccepted(key, coerce, current, patches);
	return {
		promptOverrides: input.prompt.normalizePromptOverrides(pick("promptOverrides", asStringRecord)),
		promptDisabled: input.prompt.normalizePromptDisabled({
			promptDisabled: pick("promptDisabled", asStringList),
			_promptPluginDevConfigured: pick("_promptPluginDevConfigured", asBoolean),
		}),
		disabledPluginTools: normalizeDisabledPluginTools(pick("disabledPluginTools", asStringList)),
		keepRecentMessages: normalizeKeepRecentMessages(pick("keepRecentMessages", asNumber)),
		toolWatchdogTimeoutMs: normalizeToolWatchdogTimeoutMs(pick("toolWatchdogTimeoutMs", asNumber)),
		bgAutoCleanupMin: normalizeBgCleanupMinutes(pick("bgAutoCleanupMin", asNumber)),
		retryMaxAttempts: normalizeRetryMaxAttempts(pick("retryMaxAttempts", asNumber)),
		subagentAutoWakeMaxTurns: normalizeSubagentAutoWakeMaxTurns(pick("subagentAutoWakeMaxTurns", asNumber)),
		skillsFullText: normalizeSkillList(pick("skillsFullText", asStringList)),
		skillsMaxFileBytes: normalizeSkillsMaxFileBytes(pick("skillsMaxFileBytes", asNumber)),
		skillsFullTextMaxBytes: normalizeSkillsFullTextMaxBytes(pick("skillsFullTextMaxBytes", asNumber)),
		skillsCatalogMaxDesc: normalizeSkillsCatalogMaxDesc(pick("skillsCatalogMaxDesc", asNumber)),
		skillsCatalogBudget: normalizeSkillsCatalogBudget(pick("skillsCatalogBudget", asNumber)),
		codemodeMode: normalizeCodemodeMode(pick("codemodeMode", asString)),
		codemodeInlineBudget: normalizeCodemodeInlineBudget(pick("codemodeInlineBudget", asNumber)),
		steeringMode: normalizeQueueMode(pick("steeringMode", asString)),
		followUpMode: normalizeQueueMode(pick("followUpMode", asString)),
		uiLayout: normalizeUiLayout(pick("uiLayout", asRecord)),
	};
}

/** 取「最后一个通过类型闸门的补丁值」，没有就退回当前值；undefined 的补丁值不算覆盖。 */
function lastAccepted<T>(
	key: keyof ClientSettings,
	coerce: (value: unknown) => T | undefined,
	current: Partial<ClientSettings>,
	patches: readonly (Partial<ClientSettings> | null | undefined)[],
): T | undefined {
	let resolved = coerce(current[key]);
	for (const patch of patches) {
		if (!patch || !Object.hasOwn(patch, key)) continue;
		const value: unknown = patch[key];
		if (value === undefined) continue;
		const accepted = coerce(value);
		if (accepted === undefined) continue;
		resolved = accepted;
	}
	return resolved;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function asStringList(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const items = value.filter((item): item is string => typeof item === "string");
	return items.length === value.length ? items : undefined;
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const out: Record<string, string> = {};
	for (const [key, item] of Object.entries(value)) {
		if (typeof item !== "string") return undefined;
		out[key] = item;
	}
	return out;
}

function asRecord(value: unknown): object | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value;
}
