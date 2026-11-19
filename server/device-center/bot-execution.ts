import { randomUUID } from "node:crypto";
import {
	isTrustedTaskWorkspaceCapability,
	resolveTrustedTaskWorkspace,
	type TaskWorkspaceCapability,
} from "./task-workspace.js";
import { isAbsolute, resolve } from "node:path";
import type { ClientMessage } from "../protocol.js";
import type { LocalBot } from "./bots.js";
import { getBotExecutionInstructions } from "./execution-instructions.js";
import { buildBotMemoryInjection, createBotMemory } from "./bot-memory.js";
import type { GroupTaskContext } from "./group-context.js";
import { checkGroupTaskPlanGuard, isGroupToolForbiddenInPlanCatalog } from "./group-plan-guard.js";

export interface BotExecutionCapability {
	readonly bot: Readonly<LocalBot>;
	readonly instructions: string;
	/** 记忆目录（私产，跨项目）。缺失 = 本次执行不开放记忆工具。 */
	readonly memoryRoot?: string;
	/** 启动时装载的记忆块（常驻 + 目录 + 预取），由 runtime 异步预读后带入；每轮前可刷新。 */
	readonly memoryBlock?: string;
	/**
	 * 重新装载记忆块：私聊是长会话，本会话里 promote/新写的条目必须下一轮就出现在 system prompt 里，
	 * 而不是等重开对话。读失败不抛（记忆不可用也不该阻断对话）。
	 */
	refreshMemory(): Promise<void>;
	/** 直聊（一对一）执行：不是群上下文，不承担群内广播/黑板/主播协调职责。 */
	readonly direct: boolean;
	readonly groupContext?: Readonly<GroupTaskContext>;
	readonly authorizedResumePath?: string;
	readonly planOnly?: boolean;
	readonly attenuatedTools?: readonly string[];
	readonly executionCwd: string;
	readonly executionMode?: "chat" | "code";
	readonly workspaceHandleId?: string;
	readonly taskId?: string;
	readonly attemptId?: string;
	assertActive(): void;
	assertWorkspace(cwd?: string): Promise<void>;
	allowsToolRegistration(name: string): boolean;
	allowsTool(name: string, params?: unknown): boolean;
	filterSkills<T extends { name: string }>(skills: T[]): T[];
	captureModel(fallback: string | undefined): { provider: string; modelId: string };
	revoke(): void;
}
const bindings = new Map<string, BotExecutionCapability>();
const interactionReplies = new Map<string, string>();
const highPrivilegeTools = new Set([
	"bash",
	"powershell",
	"terminal",
	"conversation",
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

export function isBotToolHighPrivilege(name: string): boolean {
	return highPrivilegeTools.has(name) || name.startsWith("subagent_") || name.startsWith("team_");
}

export function computeAttenuatedTools(
	sourceTools: readonly string[] | string[],
	targetTools: readonly string[] | string[],
): string[] {
	const sourceSet = new Set(sourceTools);
	return targetTools.filter((tool) => isBotToolHighPrivilege(tool) && !sourceSet.has(tool));
}

export function registerBotExecution(
	bot: LocalBot,
	authorizedResumePath?: string,
	context?: {
		primary?: boolean;
		/** 一对一直聊（私聊）：不注入任何群协作指令，也不承担主播职责。 */
		chat?: boolean;
		groupContext?: GroupTaskContext;
		planOnly?: boolean;
		attenuatedTools?: string[];
		sourceBotId?: string;
		executionCwd?: string;
		executionMode?: "chat" | "code";
		workspaceHandleId?: string;
		workspaceCapability?: TaskWorkspaceCapability;
		deviceId?: string;
		taskId?: string;
		attemptId?: string;
		memoryRoot?: string;
		memoryBlock?: string;
	},
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
	if (context?.executionMode === "code" && authorizedResumePath) {
		throw new Error("Code execution mode refuses resuming old sessions in first slice");
	}
	if (context?.executionCwd !== undefined && !isAbsolute(context.executionCwd)) {
		throw new Error("Execution cwd must be absolute");
	}
	const snapshot = structuredClone(bot);
	snapshot.cwd = resolve(snapshot.cwd);
	const executionCwd = context?.executionCwd ? resolve(context.executionCwd) : snapshot.cwd;
	const code = context?.executionMode === "code";
	const workspace = context?.workspaceCapability;
	const workspaceBinding = Object.freeze({
		deviceId: context?.deviceId ?? "",
		botId: snapshot.id,
		botRevision: snapshot.revision,
		taskId: context?.taskId ?? "",
		attemptId: context?.attemptId ?? "",
	});
	if (code) {
		if (
			!isTrustedTaskWorkspaceCapability(workspace) ||
			!workspaceBinding.deviceId ||
			!workspaceBinding.taskId ||
			!workspaceBinding.attemptId ||
			workspace.handleId !== context?.workspaceHandleId
		)
			throw new Error("Code execution requires a trusted task workspace capability");
	} else if (executionCwd !== snapshot.cwd || context?.workspaceHandleId || workspace) {
		throw new Error("Chat execution cwd must match the Bot project");
	}
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
		if (groupContext.blackboard) {
			Object.freeze(groupContext.blackboard.updatedBy);
			Object.freeze(groupContext.blackboard);
		}
		Object.freeze(groupContext);
	}
	let active = true;
	let model = snapshot.model;
	const tools = new Set(snapshot.tools);
	/**
	 * issue #941：MCP 工具从裸名（`echo`）改成注册名 `mcp__<server>__echo`，
	 * 而老 Bot 存档里存的还是裸名。这里保留一层只读兼容：裸名只对「该 Bot 已允许的 MCP 服务器」
	 * 注册的工具生效（不做存档数据迁移，也不被未授权服务器借用）。
	 */
	const allowsToolName = (name: string): boolean => {
		if (tools.has(name)) return true;
		if (!name.startsWith("mcp__")) return false;
		const sep = name.indexOf("__", 5);
		if (sep < 0) return false;
		const server = name.slice(5, sep);
		const bare = name.slice(sep + 2);
		if (!bare) return false;
		const allowedServer = snapshot.mcpServers.some((s) => s.replace(/-/g, "_") === server);
		return allowedServer && tools.has(bare);
	};
	const skills = new Set(snapshot.skills);
	const attenuatedList = context?.attenuatedTools ? Array.from(new Set(context.attenuatedTools)) : undefined;
	const attenuatedSet = attenuatedList && attenuatedList.length > 0 ? new Set(attenuatedList) : undefined;
	const sourceBotLabel = context?.sourceBotId ?? "unknown";
	const attenuationWarning =
		attenuatedList && attenuatedList.length > 0
			? `\n\n[SECURITY ATTENUATION] This task originated from bot '${sourceBotLabel}' without privileges for [${attenuatedList.join(", ")}]. Those tools have been strictly disabled for this execution.`
			: "";
	const blackboardBlock = context?.groupContext?.blackboard
		? `\n\n[GROUP BLACKBOARD v${context.groupContext.blackboard.version}]${context.groupContext.blackboard.title ? ` ${context.groupContext.blackboard.title}` : ""}\n${context.groupContext.blackboard.content}`
		: "";
	let memoryBlock = context?.memoryBlock;
	// 私聊直接声明 `chat: true`；历史 `kind:"direct"` 房间按同一语义处理。
	const directChat = context?.chat === true || context?.groupContext?.roomKind === "direct";
	const capability: BotExecutionCapability = {
		bot: snapshot,
		memoryRoot: context?.memoryRoot,
		get memoryBlock() {
			return memoryBlock;
		},
		direct: directChat,
		instructions:
			getBotExecutionInstructions(context?.primary === true && !directChat, directChat) +
			(context?.planOnly
				? "\n\n[PLAN MODE HARD ENFORCEMENT]\nThis task is strictly PLAN ONLY. You are prohibited from mutating files, creating files, running state-changing terminal commands, or dispatching tasks. You must only read, inspect, and draft an executable plan via plan_update. Provide 1–32 steps with unique IDs, nonempty titles (max 200 characters), explicit pending/in_progress/done/failed status, and optional descriptions (max 1000 characters)."
				: "") +
			attenuationWarning +
			blackboardBlock,
		groupContext,
		authorizedResumePath,
		planOnly: context?.planOnly === true,
		attenuatedTools: attenuatedList ? Object.freeze([...attenuatedList]) : undefined,
		executionCwd,
		executionMode: context?.executionMode ?? "chat",
		workspaceHandleId: context?.workspaceHandleId,
		taskId: context?.taskId,
		attemptId: context?.attemptId,
		async refreshMemory() {
			const root = context?.memoryRoot;
			if (!root) return;
			try {
				const injection = await buildBotMemoryInjection(createBotMemory({ root }), {
					cwd: executionCwd,
					searchable: tools.has("memory"),
				});
				memoryBlock = injection?.text;
			} catch {
				memoryBlock = undefined;
			}
		},
		assertActive() {
			if (!active) throw new Error("Bot execution capability has been revoked");
			if (code && !isTrustedTaskWorkspaceCapability(workspace))
				throw new Error("Task workspace capability has expired");
		},
		async assertWorkspace(cwd = executionCwd) {
			this.assertActive();
			if (resolve(cwd) !== executionCwd) throw new Error("Bot execution cwd mismatch");
			if (code) {
				const actual = await resolveTrustedTaskWorkspace(workspace, workspaceBinding);
				this.assertActive();
				if (resolve(actual.cwd) !== executionCwd || resolve(actual.repoRoot) !== snapshot.cwd)
					throw new Error("Task workspace identity mismatch");
			}
		},
		allowsToolRegistration(name) {
			if (attenuatedSet?.has(name)) return false;
			return active && allowsToolName(name) && !isGroupToolForbiddenInPlanCatalog(name, context?.planOnly === true);
		},
		allowsTool(name, params) {
			if (!active) return false;
			if (attenuatedSet?.has(name)) return false;
			if (context?.planOnly) {
				if (name === "plan_update") return allowsToolName(name) && !checkGroupTaskPlanGuard(name, params, true);
				const denial = checkGroupTaskPlanGuard(name, params, true);
				if (denial) return false;
			}
			return allowsToolName(name);
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

export function isBotExecutionRegistered(clientId: string): boolean {
	return bindings.has(clientId);
}

export function getBotExecution(clientId: string): BotExecutionCapability | undefined {
	const binding = bindings.get(clientId);
	if (!binding && clientId.startsWith("device-task-")) throw new Error("Unregistered Bot execution client");
	return binding;
}

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
		if (!expected || JSON.stringify(message) !== expected) return false;
		interactionReplies.delete(clientId);
		return true;
	}
	if (type === "switch_session")
		return (
			capability.executionMode !== "code" &&
			!!capability.authorizedResumePath &&
			!!message &&
			typeof message === "object" &&
			"path" in message &&
			message.path === capability.authorizedResumePath
		);
	return ["hello", "new_chat", "prompt"].includes(type);
}
