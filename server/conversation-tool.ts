import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export function mergeConversationTools(tools: ToolDefinition[]): ToolDefinition[] {
	const reader = tools.find((tool) => tool.name === "conversation_read");
	if (!reader) return tools;
	return tools
		.filter((tool) => tool !== reader)
		.concat(
			tools.some((tool) => tool.name === "conversation")
				? []
				: [
						{
							...reader,
							name: "conversation",
							parameters: Type.Object({
								...(reader.parameters as any).properties,
								action: Type.String({ enum: ["list", "read", "files", "status"] }),
							}),
						},
					],
		)
		.map((tool) => {
			if (tool.name !== "conversation" && tool.name !== "subagent") return tool;
			if (tool.execute === reader.execute) return tool;
			const management = tool;
			const managementSchema = management.parameters as any;
			const readSchema = reader.parameters as any;
			return {
				...management,
				description:
					"Create and manage collaborative conversations, or inspect running and historical conversations. Use list to discover sessions and read/files/status when the user references another chat. Only listed sessions are readable.",
				promptSnippet: "manage conversations and inspect referenced chats (list/read/files/status)",
				parameters: Type.Object({
					...managementSchema.properties,
					...readSchema.properties,
					action: Type.String({
						enum: [...managementSchema.properties.action.enum, "read", "files", "status"],
						description: "Conversation action. list defaults to running and history sessions.",
					}),
					scope: Type.Optional(
						Type.String({
							enum: ["current", "all", "finished_all"],
							description: "list: current project or all projects (default all); dismiss: finished_all.",
						}),
					),
					kind: Type.Optional(
						Type.String({
							enum: ["running", "history", "all", "subagent", "persistent"],
							description: "list: running/history/all sessions, or subagent/persistent collaboration sessions.",
						}),
					),
				}),
				execute: (id, params: any, signal, onUpdate, ctx) => {
					const action = typeof params.action === "string" ? params.action.trim().toLowerCase() : params.action;
					const inspect =
						["read", "files", "status"].includes(action) ||
						(action === "list" && !["subagent", "persistent"].includes(params.kind));
					return (inspect ? reader : management).execute(id, { ...params, action }, signal, onUpdate, ctx);
				},
			};
		});
}
