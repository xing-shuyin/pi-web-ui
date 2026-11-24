import { CoreEngineNotReadyError } from "../../contracts/core-engine-errors.js";
import type {
	ToolInfoPort,
	ToolInfoRaw,
	ToolInfoPayload,
	ToolInventory,
	ToolPromptPayload,
} from "../../contracts/session.js";
import type { ServerMessage, UiToolPromptOverride } from "../../protocol.js";

export interface ToolInfoHandlersOptions {
	/** 活动对话的工具库存（会话没开 = `undefined`）：SDK 收口在 `adapters/sdk/tool-inspector`。 */
	inventory(): ToolInventory | undefined;
	/** 宿主侧：提示词覆盖解析 + 帧载荷截断；缺省 = 未接，handler 调到时同步抛。 */
	port?: () => ToolInfoPort | undefined;
	emit(msg: ServerMessage): void;
}

/** 工具信息面的 2 个 handler：签名与 `DispatchSession` 的同名成员一致（契约里都是可选成员）。 */
export interface ToolInfoHandlers {
	getToolInfo(name: string): void;
	getToolPrompt(name: string): void;
}

/**
 * `tool_info` / `tool_prompt` 两帧的生产者（老实现 `ClientSession.getToolInfo` / `getToolPrompt`）。
 *
 * 分工是硬的：**内核只投影**——哪条工具在清单里、它的默认文案是什么、是否在活动集里；
 * 覆盖的解析（`terminal` / `conversation` 别名 + 遗留名归一）与载荷截断（`TOOL_*_CAP`、64KB 红线）
 * 都在宿主 `ToolInfoPort` 后面，内核不复制这两套策略。
 *
 * 老实现把 SDK 读与载荷拼在一个 try/catch 里（读失败 → `found: false`）；这里保留同口径：库存取不到
 * 或 SDK 抛错都退化成 `found: false` 的帧，**绝不**回一个编出来的定义。
 * 未注入端口则同步抛 `CoreEngineNotReadyError`（注册表口径：不是 rejected promise）。
 */
export function createToolInfoHandlers(options: ToolInfoHandlersOptions): ToolInfoHandlers {
	const port = (what: string): ToolInfoPort => {
		const target = options.port?.();
		if (!target) throw new CoreEngineNotReadyError(what);
		return target;
	};

	return {
		getToolInfo(name: string): void {
			// 端口解析发生在调用时、且先于一切读：未注入就是同步抛。
			const target = port("getToolInfo");
			let base: ToolInfoRaw | undefined;
			let override: UiToolPromptOverride | null = null;
			let active = false;
			try {
				const inventory = options.inventory();
				const found = inventory?.getAllTools().find((tool) => tool.name === name);
				if (found && inventory) {
					const definition = inventory.getToolDefinition(name);
					// 老实现逐字一致：名单条目打底，`getToolDefinition()` 有 snippet 就盖上去。
					base = { ...found, ...(definition?.promptSnippet ? { promptSnippet: definition.promptSnippet } : {}) };
					active = inventory.getActiveToolNames().includes(name);
					override = target.promptOverrideOf(name);
				}
			} catch {}
			options.emit({ type: "tool_info", ...target.presentInfo({ name, base, override, active }) });
		},

		getToolPrompt(name: string): void {
			const target = port("getToolPrompt");
			let found: { description?: string; promptSnippet?: string; promptGuidelines?: string[] } | undefined;
			try {
				const definition = options.inventory()?.getToolDefinition(name);
				if (definition) {
					// 老实现只认「字符串 / 字符串数组」：`tool_prompt` 是给人看的默认文案编辑框。
					found = {
						...(typeof definition.description === "string" ? { description: definition.description } : {}),
						...(typeof definition.promptSnippet === "string" ? { promptSnippet: definition.promptSnippet } : {}),
						...(Array.isArray(definition.promptGuidelines)
							? { promptGuidelines: definition.promptGuidelines as string[] }
							: {}),
					};
				}
			} catch {}
			// 覆盖解析在 SDK 读之外（老实现同一顺序）：读失败也照样把当前覆盖发回去。
			const override = target.promptOverrideOf(name);
			const payload: ToolPromptPayload = {
				name,
				found: Boolean(found),
				...(found?.description ? { defaultDescription: found.description } : {}),
				...(found?.promptSnippet ? { defaultPromptSnippet: found.promptSnippet } : {}),
				...(found?.promptGuidelines ? { defaultPromptGuidelines: found.promptGuidelines } : {}),
				...(override ? { override } : {}),
			};
			options.emit({ type: "tool_prompt", ...payload });
		},
	};
}

/** 供调用方做类型收窄（`tool_info` 帧的形状由协议单源给出）。 */
export type { ToolInfoPayload };
