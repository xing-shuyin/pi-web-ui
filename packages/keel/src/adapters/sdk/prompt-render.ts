import type { InlineExtension, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { PromptRenderBinding } from "../../contracts/prompt-render.js";
import { ALL_AGENT_TOOL_ENTRIES } from "../../tool-catalog.js";

/**
 * 提示词覆写扩展（SDK 的 `before_agent_start`）：按需加载生效时，把这一轮的整份系统提示词
 * 换成宿主渲染的那一份（老实现 `pi-webui-persona` 扩展同一位置、同一语义）。
 *
 * 只在**给了端口**时才挂（`openTurnSession({ promptRender })`）；没给 = 一个字节都不动。
 * 这里只干 SDK 那一半：读库存 / 活跃集 / 会话身份，然后问一次 `binding.catalog`（口径在
 * `domains/tools/lazy-state`，适配器层不认识域）。`undefined` = 这一帧不改提示词，SDK 默认那一份原样生效。
 */
export function createPromptRenderExtension(binding: PromptRenderBinding): InlineExtension {
	return {
		name: "keel-prompt-render",
		hidden: true,
		factory: (pi) => {
			pi.on("before_agent_start", (_event, ctx) => {
				const inventory = pi.getAllTools();
				// 库存 = 声明目录 ∪ 会话现存工具：插件/MCP 只有会话知道，而声明件即使这一轮没被注册
				// （按需未加载）也必须留在目录里 —— 否则加载一次提示词就变了，前缀缓存当场作废。
				const tools = binding.catalog({
					session: ctx.sessionManager,
					all: inventoryOf(inventory),
					active: pi.getActiveTools(),
					deferred: deferredToolNames(inventory),
					settings: binding.settings(),
				});
				if (!tools) return undefined;
				const rendered = binding.port.render({
					cwd: ctx.cwd,
					clientId: binding.clientId,
					conversationId: binding.conversationId,
					tools,
				});
				return typeof rendered === "string" && rendered.trim() !== "" ? { systemPrompt: rendered } : undefined;
			});
		},
	};
}

/** 声明目录（`tool-catalog` 的静态表，顺序即注册顺序）+ 会话现存工具里多出来的那些。 */
function inventoryOf(inventory: readonly ToolInfo[]): string[] {
	const names: string[] = [];
	const seen = new Set<string>();
	for (const entry of ALL_AGENT_TOOL_ENTRIES) {
		if (seen.has(entry.name)) continue;
		seen.add(entry.name);
		names.push(entry.name);
	}
	for (const tool of inventory) {
		const name = typeof tool?.name === "string" ? tool.name : "";
		if (!name || seen.has(name)) continue;
		seen.add(name);
		names.push(name);
	}
	return names;
}

/** MCP 延迟暴露的工具（老实现 `mcpDeferred` 同一口径）：连上才展开，不预先列进目录。 */
function deferredToolNames(inventory: readonly ToolInfo[]): string[] {
	const names: string[] = [];
	for (const tool of inventory) {
		const namespace = (tool as { namespace?: { name?: unknown } }).namespace?.name;
		if (typeof namespace !== "string" || !namespace.startsWith("mcp__")) continue;
		if ((tool.exposure ?? "codemode") !== "deferred") continue;
		names.push(tool.name);
	}
	return names;
}
