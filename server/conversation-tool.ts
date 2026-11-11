import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/** Compact action signature for the merged tool: the only place documenting parameters,
 * so every field schema stays flat and prose-free. */
export const CONVERSATION_ACTION_SIGNATURE =
	"spawn(prompt,type?,key? | tasks[{key,prompt,type?,template?,model?,thinking?,isolation?,persist?,notifyOnDone?}]) | " +
	"steer/answer(runId,message,requestId?) | complete(summary,evidence{files[],commands[],none?,blocked?}) | consult(message) | " +
	"escalate(runId,requestId) | get_result/stop/status/resume(runId,message?) | wait_all/dismiss(runIds? keys accepted) | handoff(toRunId,payload) | " +
	"list(kind?,query?) | read/files(id|path,query?,last?)";

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
								action: Type.Unsafe<string>({
									type: "string",
									enum: ["list", "read", "files", "status"],
									description: "list | read(id|path,view?) | files(id|path) | status(id)",
								}),
							}),
						},
					],
		)
		.map((tool) => {
			if (tool.name !== "conversation") return tool;
			if (tool.execute === reader.execute) return tool;
			const management = tool;
			const managementSchema = management.parameters as any;
			const readSchema = reader.parameters as any;
			const properties: Record<string, any> = { ...managementSchema.properties, ...readSchema.properties };
			const timeoutSeconds = properties.timeoutSeconds;
			delete properties.timeoutSeconds;
			return {
				...management,
				description:
					"Create and manage collaborative conversations; inspect running and historical sessions. Only listed sessions are readable.",
				promptSnippet: "manage conversations and inspect referenced chats (list/read/files/status)",
				parameters: Type.Object({
					...properties,
					action: Type.Unsafe<string>({
						type: "string",
						enum: [...managementSchema.properties.action.enum, "read", "files", "status"],
						description: CONVERSATION_ACTION_SIGNATURE,
					}),
					scope: Type.Optional(Type.String({ enum: ["current", "all", "finished_all"] })),
					kind: Type.Optional(Type.String({ enum: ["running", "history", "all", "subagent", "persistent"] })),
					timeoutSeconds,
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
