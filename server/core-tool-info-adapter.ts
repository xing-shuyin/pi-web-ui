import type { ToolInfoPort, ToolInfoRaw } from "../packages/keel/src/contracts/session.js";
import type { UiToolPromptOverride } from "./protocol.js";
import { effectiveToolPrompt, toolPromptOverrideOf } from "./tool-prompt-overrides.js";
import { normalizeToolInfo } from "./tool-info.js";

export interface CoreToolInfoAdapterOptions {
	/** 设置快照里的提示词覆盖表（`SettingsService.current.toolPromptOverrides`）。 */
	toolPromptOverrides(): Record<string, UiToolPromptOverride> | undefined;
}

/**
 * 宿主侧 `ToolInfoPort`：`get_tool_info` / `get_tool_prompt` 的**两件宿主单源**在这里合流。
 *
 * 1. `toolPromptOverrideOf` / `effectiveToolPrompt`（`server/tool-prompt-overrides.ts`）：
 *    `terminal` / `conversation` 的别名与 `terminal_*` 遗留名的归一只在这一份实现里；
 * 2. `normalizeToolInfo`（`server/tool-info.ts`）：载荷白名单与 `TOOL_*_CAP`（64KB 红线）。
 *
 * 内核只交「哪条工具、默认文案、是否活动」，不复制这两套策略（见 `domains/tools/info.ts`）。
 * 本适配器不抛：读不到设置就当没有覆盖（与老实现 `this.settingsSvc.current` 恒有值同效）。
 */
export function createCoreToolInfoAdapter(options: CoreToolInfoAdapterOptions): ToolInfoPort {
	const overrideOf = (name: string): UiToolPromptOverride | null =>
		toolPromptOverrideOf(options.toolPromptOverrides(), name) ?? null;

	return {
		promptOverrideOf: overrideOf,

		presentInfo(input: { name: string; base?: ToolInfoRaw; override: UiToolPromptOverride | null; active: boolean }) {
			if (!input.base) return normalizeToolInfo(input.name, undefined);
			const base = input.base as { description?: string; promptSnippet?: string; promptGuidelines?: string[] };
			// 老实现逐字相同：覆盖优先，缺省回落到定义里的默认文案。
			const effective = effectiveToolPrompt(base, input.override);
			return normalizeToolInfo(input.name, {
				...base,
				description: effective.description,
				promptSnippet: effective.promptSnippet,
				promptGuidelines: effective.promptGuidelines,
				active: input.active,
			});
		},
	};
}
