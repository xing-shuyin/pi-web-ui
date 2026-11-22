/**
 * 会话内单值设置（计划模式 / 委派模式 / 权限预设 / 结构化计划）的唯一读取判据。
 *
 * 转录是 append-only 树：`getEntries()` 是整份文件（含 fork 之后弃用的分支），
 * `getBranch()` 才是当前叶链。状态类条目一律沿叶链取「最后一条有效事件」——
 * 拿整份文件倒序找，会把弃用分支的旧状态当成当前状态（issue #979）。
 * 压缩只影响模型上下文，不动叶链，所以压缩点之前的计划事件仍然有效。
 */
import type { PlanState } from "./protocol.js";

/** 计划事件读出的计划 + 它来自哪条转录条目（缓存的新旧游标）。 */
export type SessionPlanEvent = PlanState & { sourceEntryId?: string };

interface BranchEntry {
	id?: unknown;
	type?: unknown;
	customType?: unknown;
	data?: unknown;
}

/** 当前叶链（`getBranch()` 语义）；读不到叶链时返回 null，让调用方按「没有」处理。 */
function branchEntries(sm: unknown): BranchEntry[] | null {
	const mgr = sm as { getBranch?: () => unknown } | undefined;
	if (typeof mgr?.getBranch !== "function") return null;
	try {
		const branch = mgr.getBranch();
		return Array.isArray(branch) ? (branch as BranchEntry[]) : null;
	} catch {
		return null;
	}
}

/** 沿叶链倒序找最后一条匹配的事件数据。 */
function lastBranchEvent<T>(
	sm: unknown,
	match: (entry: { type?: unknown; customType?: unknown; data?: unknown }) => T | undefined,
): { value: T; sourceEntryId?: string } | null {
	const branch = branchEntries(sm);
	if (!branch) return null;
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (!entry || typeof entry !== "object") continue;
		const value = match(entry);
		if (value === undefined) continue;
		return { value, sourceEntryId: typeof entry.id === "string" && entry.id ? entry.id : undefined };
	}
	return null;
}

export function readPlanModeFromSession(sm: unknown): boolean {
	const hit = lastBranchEvent<boolean>(sm, (entry) => {
		if (entry.type !== "custom" || entry.customType !== "plan/mode") return undefined;
		const enabled = (entry.data as { enabled?: unknown } | undefined)?.enabled;
		return typeof enabled === "boolean" ? enabled : undefined;
	});
	return hit?.value ?? false;
}

export function readDelegateModeFromSession(sm: unknown): boolean {
	const hit = lastBranchEvent<boolean>(sm, (entry) => {
		if (entry.type !== "custom" || entry.customType !== "delegate/mode") return undefined;
		const enabled = (entry.data as { enabled?: unknown } | undefined)?.enabled;
		return typeof enabled === "boolean" ? enabled : undefined;
	});
	return hit?.value ?? false;
}

export function readPermissionFromSession(sm: unknown): string | undefined {
	const hit = lastBranchEvent<string>(sm, (entry) => {
		if (entry.type !== "custom" || entry.customType !== "permission/preset") return undefined;
		const preset = (entry.data as { preset?: unknown } | undefined)?.preset;
		return typeof preset === "string" ? preset : undefined;
	});
	return hit?.value;
}

/**
 * 当前分支上最后一条有效计划事件（含 `sourceEntryId` 游标）。
 * `plans.json` 只是可重建缓存，真值在这里；两者冲突时以分支事件为准。
 */
export function readPlanFromSession(sm: unknown): SessionPlanEvent | null {
	const hit = lastBranchEvent<PlanState>(sm, (entry) => {
		if (entry.type !== "custom") return undefined;
		if (entry.customType !== "plan/update" && entry.customType !== "pi-web-ui/plan") return undefined;
		const plan = (entry.data as { plan?: unknown } | undefined)?.plan as PlanState | undefined;
		return plan && Array.isArray(plan.steps) ? plan : undefined;
	});
	if (!hit) return null;
	return { ...hit.value, ...(hit.sourceEntryId ? { sourceEntryId: hit.sourceEntryId } : {}) };
}

/**
 * 会话内模式条目的写侧（issues #968）。
 *
 * 三个模式（计划 / 委派 / 权限预设）都是「先写转录条目、再改内存」：条目是重启后还能读回来的唯一依据。
 * 旧代码是「先改内存 + `try { appendCustomEntry } catch {}`」——写失败也报成功，重启后静默回到旧值。
 * 这里把写结果折成三态，调用方按状态决定要不要改内存／公告：
 * - `ok`：真的写进转录了；
 * - `transient`：本来就不保存的会话（未落盘 / 内联会话）——不报错，但也不能说「已保存」；
 * - `failed`：写不进去（无 sessionManager / 抛错）——保持旧值并如实告知。
 */
export const MODE_ENTRY_TYPES = {
	plan: "plan/mode",
	delegate: "delegate/mode",
	permission: "permission/preset",
} as const;

export type ModeEntryResult = "ok" | "transient" | "failed";

export function appendModeEntry(sm: unknown, customType: string, data: Record<string, unknown>): ModeEntryResult {
	const manager = sm as
		{ appendCustomEntry?: (type: string, payload: unknown) => void; isPersisted?: () => boolean } | undefined;
	if (typeof manager?.appendCustomEntry !== "function") return "failed";
	let persistedBefore = true;
	try {
		persistedBefore = typeof manager.isPersisted === "function" ? manager.isPersisted() !== false : true;
	} catch {
		persistedBefore = true;
	}
	try {
		manager.appendCustomEntry(customType, data);
	} catch {
		return persistedBefore ? "failed" : "transient";
	}
	// 写完之后再确认一次落盘能力：写不进去的会话不是失败，但绝不宣称「已保存」。
	try {
		if (typeof manager.isPersisted === "function" && manager.isPersisted() === false) return "transient";
	} catch {
		// 读不到就不猜。
	}
	return "ok";
}
