import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { ClientMessage } from "../protocol.js";
import type { LocalBot } from "./bots.js";
import { getBotExecutionInstructions } from "./execution-instructions.js";
import type { GroupTaskContext } from "./group-context.js";
import { checkGroupTaskPlanGuard, isGroupToolForbiddenInPlanCatalog } from "./group-plan-guard.js";

/** Process-local authority. Never accept a Bot configuration or capability over WS. */
export interface BotExecutionCapability {
	readonly bot: Readonly<LocalBot>;
	readonly instructions: string;
	readonly groupContext?: Readonly<GroupTaskContext>;
	readonly authorizedResumePath?: string;
	readonly planOnly?: boolean;
	assertActive(): void;
	allowsToolRegistration(name: string): boolean;
	allowsTool(name: string, params?: unknown): boolean;
	filterSkills<T extends { name: string }>(skills: T[]): T[];
	captureModel(fallback: string | undefined): { provider: string; modelId: string };
	revoke(): void;
}
const bindings = new Map<string, BotExecutionCapability>();
// Exact locally constructed frames, scoped to one task capability and consumed by the WS gate.
const interactionReplies = new Map<string, string>();
// Advisory only: these tools can create execution contexts or mutate host policy.
const highPrivilegeTools = new Set([
	"conversation",
	"subagent",
	"worktree",
	"canvas",
	"mcp",
	"tool_manage",
	"codemode",
	"load_tools",
	"browser_page",
	"delegate_task",
	"schedule",
	"mcp_manage",
	"sandbox",
	"team",
	"tool_search",
]);

/** Catalog warning; authorization is determined solely by the configured whitelist. */
export function isBotToolHighPrivilege(name: string): boolean {
	return highPrivilegeTools.has(name) || name.startsWith("subagent_") || name.startsWith("team_");
}

export function registerBotExecution(
	bot: LocalBot,
	authorizedResumePath?: string,
	context?: { primary: boolean; groupContext?: GroupTaskContext; planOnly?: boolean },
): {
	clientId: string;
	capability: BotExecutionCapability;
	authorizeInteractionReply(message: ClientMessage): void;
	release(): void;
} {
	if (!bot?.enabled || !bot.id || !isAbsolute(bot.cwd) || !Number.isSafeInteger(bot.revision)) {
		throw new Error("An enabled, versioned local Bot with an absolute cwd is required");
	}
	if (authorizedResumePath !== undefined && !isAbsolute(authorizedResumePath))
		throw new Error("Resume path must be absolute");
	const snapshot = structuredClone(bot);
	snapshot.cwd = resolve(snapshot.cwd);
	Object.freeze(snapshot.tools);
	Object.freeze(snapshot.skills);
	Object.freeze(snapshot.mcpServers);
	if (snapshot.model) Object.freeze(snapshot.model);
	Object.freeze(snapshot);
	const groupContext = context?.groupContext ? structuredClone(context.groupContext) : undefined;
	if (groupContext) {
		for (const member of groupContext.members) Object.freeze(member);
		for (const message of groupContext.messages) {
			Object.freeze(message.sender);
			if (message.targetBotIds) Object.freeze(message.targetBotIds);
			Object.freeze(message);
		}
		Object.freeze(groupContext.members);
		Object.freeze(groupContext.messages);
		Object.freeze(groupContext);
	}
	let active = true;
	let model = snapshot.model;
	const tools = new Set(snapshot.tools);
	const skills = new Set(snapshot.skills);
	const capability: BotExecutionCapability = {
		bot: snapshot,
		instructions:
			getBotExecutionInstructions(context?.primary === true) +
			(context?.planOnly
				? "\n\n[PLAN MODE HARD ENFORCEMENT]\nThis task is strictly PLAN ONLY. You are prohibited from mutating files, creating files, running state-changing terminal commands, or dispatching tasks. You must only read, inspect, and draft an executable plan via plan_update. Provide 1–32 steps with unique IDs, nonempty titles (max 200 characters), explicit pending/in_progress/done/failed status, and optional descriptions (max 1000 characters)."
				: ""),
		groupContext,
		authorizedResumePath,
		planOnly: context?.planOnly === true,
		assertActive() {
			if (!active) throw new Error("Bot execution capability has been revoked");
		},
		allowsToolRegistration(name) {
			return active && tools.has(name) && !isGroupToolForbiddenInPlanCatalog(name, context?.planOnly === true);
		},
		allowsTool(name, params) {
			if (!active) return false;
			if (context?.planOnly) {
				if (name === "plan_update") return tools.has(name) && !checkGroupTaskPlanGuard(name, params, true);
				const denial = checkGroupTaskPlanGuard(name, params, true);
				if (denial) return false;
			}
			return tools.has(name);
		},
		filterSkills(items) {
			this.assertActive();
			return items.filter((item) => skills.has(item.name));
		},
		captureModel(fallback) {
			this.assertActive();
			if (!model) {
				const slash = fallback?.indexOf("/") ?? -1;
				if (!fallback || slash <= 0 || slash === fallback.length - 1) {
					throw new Error("Bot requires an explicit local default model");
				}
				model = Object.freeze({ provider: fallback.slice(0, slash), modelId: fallback.slice(slash + 1) });
			}
			return model;
		},
		revoke() {
			active = false;
			interactionReplies.delete(clientId);
		},
	};
	const clientId = `device-task-${randomUUID()}`;
	bindings.set(clientId, capability);
	return {
		clientId,
		capability,
		authorizeInteractionReply(message) {
			capability.assertActive();
			if (
				(message.type !== "question_answer" && message.type !== "tool_approval_response") ||
				!message.id ||
				(message.type === "tool_approval_response" && message.scope !== "once") ||
				interactionReplies.has(clientId)
			)
				throw new Error("Invalid or pending native interaction reply");
			interactionReplies.set(clientId, JSON.stringify(message));
		},
		release() {
			capability.revoke();
			bindings.delete(clientId);
		},
	};
}

/** A binding is removed only after the executor confirms its task has stopped. */
export function isBotExecutionRegistered(clientId: string): boolean {
	return bindings.has(clientId);
}

/** Unregistered private IDs fail closed, including after a server restart. */
export function getBotExecution(clientId: string): BotExecutionCapability | undefined {
	const binding = bindings.get(clientId);
	if (!binding && clientId.startsWith("device-task-")) throw new Error("Unregistered Bot execution client");
	return binding;
}

/** Executor uses only this control surface; all other public WS commands are denied. */
export function botExecutionMessageAllowed(clientId: string, type: string, message?: unknown): boolean {
	const capability = getBotExecution(clientId);
	if (!capability) return true;
	if (["abort", "get_state", "pong"].includes(type)) return true;
	try {
		capability.assertActive();
	} catch {
		return false;
	}
	if (type === "question_answer" || type === "tool_approval_response") {
		const expected = interactionReplies.get(clientId);
		// A rejected frame cannot consume the grant for the legitimate reply.
		if (!expected || JSON.stringify(message) !== expected) return false;
		interactionReplies.delete(clientId);
		return true;
	}
	if (type === "switch_session")
		return (
			!!capability.authorizedResumePath &&
			!!message &&
			typeof message === "object" &&
			"path" in message &&
			message.path === capability.authorizedResumePath
		);
	return ["hello", "new_chat", "prompt"].includes(type);
}
