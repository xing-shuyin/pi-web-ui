import { validateTaskPlan } from "./task-plan.js";
import { isConversationTool } from "../conversation-tool-names.js";
import {
	readOnlyToolCallAllowed,
	PLAN_MODE_BLOCKED_TOOL_NAMES,
	planModeDenial,
	bashCommandIsReadOnly,
	bashCommandHasSupportedSyntax,
	type PlanModeDenial,
} from "../plan-mode.js";

export type GroupTaskPlanStatus = "draft" | "ready" | "approved";

export interface GroupPlanStep {
	id: string;
	title: string;
	status?: "pending" | "in_progress" | "done" | "failed";
	description?: string;
}

export interface GroupTaskPlanRecord {
	state: GroupTaskPlanStatus;
	steps: GroupPlanStep[];
	summary?: string;
	approvedAt?: number;
	approvedBy?: string;
}

const DEVICE_COLLAB_READ_ONLY_ACTIONS = new Set<string>([
	"read_history",
	"context_metrics",
	"execution_guide",
	"conversation_read",
	"current_task",
	"transfer_preview",
]);

const BASH_TOOL_NAMES = new Set<string>(["bash", "terminal_bash", "command"]);

export function isGroupToolForbiddenInPlanCatalog(toolName: string, isPlanOnly: boolean): boolean {
	if (!isPlanOnly) return false;
	const name = (toolName || "").trim().toLowerCase();
	return PLAN_MODE_BLOCKED_TOOL_NAMES.has(name) && !isConversationTool(name);
}

export function checkGroupTaskPlanGuard(
	toolName: string,
	params: unknown,
	isPlanOnly: boolean,
): PlanModeDenial | undefined {
	if (!isPlanOnly) {
		return undefined;
	}

	const name = (toolName || "").trim().toLowerCase();

	params ??= {};

	if (name === "plan_update") {
		const steps = params && typeof params === "object" ? (params as { steps?: unknown }).steps : undefined;
		if (!validateTaskPlan({ state: "ready", steps }))
			return {
				kind: "write-tool",
				reason: "群计划模式：步骤须为 1–32 条，ID 唯一、标题非空、状态合法，且不得超过字段长度限制。",
				reasonEn:
					"Group plan mode: require 1–32 steps with unique IDs, nonempty titles, valid statuses and bounded field lengths.",
			};
		return undefined;
	}

	if (name === "device_collab") {
		const p = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
		const action = typeof p.action === "string" ? p.action.trim().toLowerCase() : "";
		if (DEVICE_COLLAB_READ_ONLY_ACTIONS.has(action)) {
			return undefined;
		}
		return {
			kind: "write-tool",
			reason: `群计划模式：禁止调用 device_collab(action="${action || "unknown"}")。计划阶段仅允许只读调研动作。`,
			reasonEn: `Group plan mode: device_collab(action="${action || "unknown"}") is prohibited. Only read-only actions are permitted during planning.`,
		};
	}

	if (BASH_TOOL_NAMES.has(name)) {
		const p = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
		const cmd = typeof p.command === "string" ? p.command : typeof p.cmd === "string" ? p.cmd : "";
		if (!cmd.trim()) {
			return {
				kind: "bash",
				reason: "群计划模式：空命令不可用。调研请用只读命令。",
				reasonEn: "Group plan mode: empty command unavailable. Run read-only commands for research.",
			};
		}
		if (bashCommandIsReadOnly(cmd) && bashCommandHasSupportedSyntax(cmd)) {
			return undefined;
		}
		return {
			kind: "bash",
			reason: `群计划模式：命令 "${cmd.slice(0, 80)}" 包含写操作或不受支持的复杂语法，已拦截。请使用只读命令或把改动列入计划。`,
			reasonEn: `Group plan mode: command "${cmd.slice(0, 80)}" contains write operations or unsupported syntax. Use read-only commands or record changes in the plan.`,
		};
	}

	const generalDenial = planModeDenial(name, params);
	if (generalDenial) {
		return generalDenial;
	}

	if (readOnlyToolCallAllowed(name, params)) {
		return undefined;
	}

	return {
		kind: "bypass-tool",
		reason: `群计划模式：工具 "${name}" 未在只读白名单中，已被硬门禁拦截。请使用只读工具进行调研。`,
		reasonEn: `Group plan mode: tool "${name}" is not in the read-only allowlist and has been blocked. Use read-only tools for research.`,
	};
}

export function atomicApproveGroupPlan(
	current: GroupTaskPlanRecord,
	approver = "user",
	now: number = Date.now(),
): { ok: true; plan: GroupTaskPlanRecord } | { ok: false; error: string } {
	if (!current) {
		return { ok: false, error: "No plan found to approve" };
	}
	if (current.state === "approved") {
		return { ok: false, error: "Plan has already been approved" };
	}
	if (current.state === "draft") {
		return { ok: false, error: "Plan is still in draft state and cannot be approved yet" };
	}
	if (current.state !== "ready") {
		return { ok: false, error: `Invalid plan state for approval: ${current.state}` };
	}
	if (!Array.isArray(current.steps) || current.steps.length === 0) {
		return { ok: false, error: "Plan contains no steps and cannot be approved" };
	}

	return {
		ok: true,
		plan: {
			...current,
			state: "approved",
			approvedAt: now,
			approvedBy: approver,
		},
	};
}
