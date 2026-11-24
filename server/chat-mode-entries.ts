/**
 * 会话内模式条目的**读写单源**（计划模式 / 审查者模式 / 权限预设）。
 *
 * 转录是 append-only 树：`getEntries()` 是整份文件（含 fork 之后弃用的分支），
 * `getBranch()` 才是当前叶链。状态类条目一律沿叶链取「最后一条有效事件」——
 * 拿整份文件倒序找，会把弃用分支的旧状态当成当前状态（issue #979）。
 * 压缩只影响模型上下文，不动叶链，所以压缩点之前的模式事件仍然有效。
 *
 * 写侧是「先写转录条目、再改内存」的两段式（issues #968）：条目是重启后还能读回来的唯一依据，
 * 写结果折成三态（`ok` / `transient` / `failed`）交给调用方决定要不要改内存、要不要如实公告。
 * 宿主老树（`agent-service.ts`）与内核适配器（`core-chat-mode-adapter.ts`）都只认这一份。
 */
export const MODE_ENTRY_TYPES = {
	plan: "plan/mode",
	delegate: "delegate/mode",
	permission: "permission/preset",
} as const;

export type ModeEntryResult = "ok" | "transient" | "failed";

/** 模式条目读写的键（权限预设也走同一套三态，但不是「模式开关」）。 */
export type ModeEntryKind = keyof typeof MODE_ENTRY_TYPES;

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
export function lastBranchEvent<T>(
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
		if (entry.type !== "custom" || entry.customType !== MODE_ENTRY_TYPES.plan) return undefined;
		const enabled = (entry.data as { enabled?: unknown } | undefined)?.enabled;
		return typeof enabled === "boolean" ? enabled : undefined;
	});
	return hit?.value ?? false;
}

export function readDelegateModeFromSession(sm: unknown): boolean {
	const hit = lastBranchEvent<boolean>(sm, (entry) => {
		if (entry.type !== "custom" || entry.customType !== MODE_ENTRY_TYPES.delegate) return undefined;
		const enabled = (entry.data as { enabled?: unknown } | undefined)?.enabled;
		return typeof enabled === "boolean" ? enabled : undefined;
	});
	return hit?.value ?? false;
}

/**
 * 模式条目的写侧。调用方必须按结果决定要不要改内存：
 * - `ok`：真的写进转录了；
 * - `transient`：本来就不保存的会话（未落盘 / 内联会话）——不报错，但也不能说「已保存」；
 * - `failed`：写不进去（无 sessionManager / 抛错）——保持旧值并如实告知。
 */
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

export interface ModeReceipt {
	level: "info" | "warning";
	text: string;
	textEn: string;
}

const MODE_NAMES = {
	plan: { zh: "计划模式", en: "plan mode" },
	delegate: { zh: "审查者模式", en: "reviewer mode" },
} as const;

/** 「没写进转录 / 只在本进程生效」的回执：不报假成功，也不把失败说成已保存。 */
export function modeEntryReceipt(kind: "plan" | "delegate", result: "transient" | "failed"): ModeReceipt {
	const name = MODE_NAMES[kind];
	if (result === "failed") {
		return {
			level: "warning",
			text: `${name.zh}没能写入对话记录（切换未生效）：重启或重载后会回到旧值。可重试一次。`,
			textEn: `${name.en} could not be written to the conversation transcript, so the switch did not take effect. Retry, or it will fall back to the old value after a restart.`,
		};
	}
	return {
		level: "info",
		text: `${name.zh}已在本次运行生效；该对话未落盘（临时/内联会话），所以不保存。`,
		textEn: `${name.en} applies to this run only; this conversation is not persisted (temporary/inline session), so the setting is not saved.`,
	};
}
