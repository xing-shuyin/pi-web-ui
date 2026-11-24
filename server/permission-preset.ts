/**
 * 会话内单值设置的唯一读取判据（计划 / 权限预设）。
 *
 * 模式条目（`plan/mode` / `delegate/mode` / `permission/preset`）的读写实现搬到了
 * `chat-mode-entries.ts`（内核适配器要复用同一份三态写侧），这里全部原样转出，
 * 老调用方（`agent-service.ts` 与单测）的 import 一个字都不用改。
 */
import type { PlanState } from "./protocol.js";
import { lastBranchEvent, MODE_ENTRY_TYPES } from "./chat-mode-entries.js";

/** 计划事件读出的计划 + 它来自哪条转录条目（缓存的新旧游标）。 */
export type SessionPlanEvent = PlanState & { sourceEntryId?: string };

export {
	appendModeEntry,
	lastBranchEvent,
	modeEntryReceipt,
	MODE_ENTRY_TYPES,
	readDelegateModeFromSession,
	readPlanModeFromSession,
	type ModeEntryKind,
	type ModeEntryResult,
	type ModeReceipt,
} from "./chat-mode-entries.js";

export function readPermissionFromSession(sm: unknown): string | undefined {
	const hit = lastBranchEvent<string>(sm, (entry) => {
		if (entry.type !== "custom" || entry.customType !== MODE_ENTRY_TYPES.permission) return undefined;
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
