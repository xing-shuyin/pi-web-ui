/**
 * server/device-center/group-plan-guard.ts
 *
 * 群任务计划模式（Plan Mode）服务端硬门禁与审批状态机。
 *
 * 核心原则：
 * 1. 事实单源：复用 server/plan-mode.ts 的只读白名单判定（readOnlyToolCallAllowed）
 *    与 bash 只读语法校验（bashCommandIsReadOnly / bashCommandHasSupportedSyntax）。
 * 2. 严格闭门门禁（Fail-Closed）：除明确白名单中的只读工具外，其余未知工具（含第三方插件）
 *    在计划模式下全部拦截拒绝，绝不默认放行。
 * 3. device_collab 动作细分：只允许只读动作（read_history/context_metrics 等），
 *    写文件（sync_files）、派发与交付等写动作一律硬拦截。
 * 4. 服务端原子校验：计划批准仅允许从 "ready" 转移至 "approved"，拒绝 draft 或重复批准。
 */

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

/** device_collab 允许在计划模式下调用的安全只读 action 白名单 */
const DEVICE_COLLAB_READ_ONLY_ACTIONS = new Set<string>([
	"read_history",
	"context_metrics",
	"execution_guide",
	"conversation_read",
	"current_task",
	"transfer_preview",
]);

/** bash 类工具名 */
const BASH_TOOL_NAMES = new Set<string>(["bash", "terminal_bash", "command"]);

/**
 * 判断工具在计划模式下的目录注册期是否应被直接隐藏
 */
export function isGroupToolForbiddenInPlanCatalog(toolName: string, isPlanOnly: boolean): boolean {
	if (!isPlanOnly) return false;
	const name = (toolName || "").trim().toLowerCase();
	return PLAN_MODE_BLOCKED_TOOL_NAMES.has(name) && !isConversationTool(name);
}

/**
 * 校验群任务执行时的工具调用是否被计划模式拦截
 * @returns undefined 表示放行；返回 PlanModeDenial 表示被硬门禁拦截
 */
export function checkGroupTaskPlanGuard(
	toolName: string,
	params: unknown,
	isPlanOnly: boolean,
): PlanModeDenial | undefined {
	if (!isPlanOnly) {
		return undefined; // 非计划模式任务不施加此门禁
	}

	const name = (toolName || "").trim().toLowerCase();

	// This is execution authorization; catalog filtering uses its own explicit API.
	params ??= {};

	// 1. plan_update 允许用于制定和更新计划本身
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

	// 2. device_collab 工具动作级细分拦截
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

	// 3. bash / 终端命令只读检查
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

	// 4. 复用宿主已有的通用计划门禁判定
	const generalDenial = planModeDenial(name, params);
	if (generalDenial) {
		return generalDenial;
	}

	// 5. 严格闭门门禁：白名单判定
	if (readOnlyToolCallAllowed(name, params)) {
		return undefined;
	}

	// 未在白名单中的未知工具（含第三方插件）一律拦截
	return {
		kind: "bypass-tool",
		reason: `群计划模式：工具 "${name}" 未在只读白名单中，已被硬门禁拦截。请使用只读工具进行调研。`,
		reasonEn: `Group plan mode: tool "${name}" is not in the read-only allowlist and has been blocked. Use read-only tools for research.`,
	};
}

/**
 * 服务端原子批准群任务计划
 * 只有处于 ready 状态且具有步骤的计划才能被批准；draft 或已 approved 明确拒绝
 */
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
