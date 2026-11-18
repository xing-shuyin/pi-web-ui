import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AGENT_BOT_TOOL_NAME } from "../tool-manager.js";
import type { BotDraft } from "./bot-drafts.js";

/**
 * 「一句话创建 Bot」的模型侧入口：只写草案，不建 Bot。
 *
 * 人必须在界面里按一次确认（高权限工具逐项授权）之后才会真的落库，
 * 所以这个工具的语义是"提议"，不是"创建"——模型拿不到 self-grant 的权力。
 */

export interface AgentBotHost {
	draft(input: unknown): Promise<BotDraft>;
	list(): Promise<BotDraft[]>;
	cancel(id: string): Promise<void>;
}

let host: AgentBotHost | undefined;

export function setAgentBotHost(next: AgentBotHost | undefined): void {
	host = next;
}

export function agentBotToolAvailable(): boolean {
	return Boolean(host);
}

export const AGENT_BOT_DESCRIPTION =
	"Draft a standalone Bot from one sentence: name, role, prompt, workspace, model and tools. The draft stays pending until the user confirms it; this tool never creates or authorizes anything by itself.";

export const AGENT_BOT_PROMPT_SNIPPET = "draft a new Bot for the user to confirm";

export const AGENT_BOT_PROMPT_GUIDELINES = [
	"Use op=draft only when the user asks for a new Bot or assistant; derive name, role and prompt from their sentence instead of asking them to fill a form.",
	"Never promise permissions: pick the narrowest tools that fit, and leave high-privilege tools (bash, terminal, browser, mcp, delegate) out unless the user explicitly asked for them.",
	'Include the "memory" tool when the Bot should remember facts across sessions (most assistants should); it only reads and writes the Bot\'s own memory directory.',
	"cwd must be an absolute path that already exists; reuse the current project when the user did not name one, and say so in rationale.",
	"After drafting, tell the user it is waiting for confirmation and what needs approval; do not create more drafts for the same request.",
	"Do not choose a trigger: always-on / scheduled execution belongs to the host's alwaysOn plugins and schedule tool, not to a Bot draft.",
	"Use op=list to show pending drafts and op=cancel when the user rejects one.",
];

const parameters = Type.Object({
	op: Type.Union([Type.Literal("draft"), Type.Literal("list"), Type.Literal("cancel")]),
	/** 一句话需求原话，便于草案留痕。 */
	request: Type.Optional(Type.String()),
	name: Type.Optional(Type.String()),
	description: Type.Optional(Type.String()),
	systemPrompt: Type.Optional(Type.String()),
	cwd: Type.Optional(Type.String()),
	model: Type.Optional(Type.Object({ provider: Type.String(), modelId: Type.String() })),
	tools: Type.Optional(Type.Array(Type.String())),
	skills: Type.Optional(Type.Array(Type.String())),
	mcpServers: Type.Optional(Type.Array(Type.String())),
	rationale: Type.Optional(Type.String()),
	id: Type.Optional(Type.String()),
});

export function makeAgentBotTool() {
	return defineTool({
		name: AGENT_BOT_TOOL_NAME,
		label: "Agent Bot",
		description: AGENT_BOT_DESCRIPTION,
		promptSnippet: AGENT_BOT_PROMPT_SNIPPET,
		promptGuidelines: AGENT_BOT_PROMPT_GUIDELINES,
		parameters,
		execute: async (_toolCallId, rawInput) => {
			const bound = host;
			if (!bound) throw new Error("Bot drafting is unavailable on this device");
			const input = rawInput as Record<string, unknown>;
			const op = input.op;
			let payload: unknown;
			if (op === "draft") {
				const draft = await bound.draft({
					name: input.name,
					description: input.description,
					systemPrompt: input.systemPrompt,
					cwd: input.cwd,
					...(input.model ? { model: input.model } : {}),
					...(input.tools ? { tools: input.tools } : {}),
					...(input.skills ? { skills: input.skills } : {}),
					...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
					...(input.rationale ? { rationale: input.rationale } : {}),
				});
				payload = {
					op,
					draft: {
						id: draft.id,
						name: draft.name,
						description: draft.description,
						trigger: draft.trigger,
						cwd: draft.cwd,
						tools: draft.tools,
						needsApproval: draft.highPrivilegeTools,
					},
					next: "Waiting for the user to confirm in the Agents panel; nothing is created yet.",
				};
			} else if (op === "list") {
				payload = {
					op,
					drafts: (await bound.list()).map((draft) => ({
						id: draft.id,
						name: draft.name,
						description: draft.description,
						tools: draft.tools,
						needsApproval: draft.highPrivilegeTools,
						createdAt: draft.createdAt,
					})),
				};
			} else {
				if (typeof input.id !== "string" || !input.id) throw new Error("cancel requires a draft id");
				await bound.cancel(input.id.slice(0, 128));
				payload = { op, cancelled: input.id };
			}
			const details = payload as Record<string, unknown>;
			return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
		},
	});
}
