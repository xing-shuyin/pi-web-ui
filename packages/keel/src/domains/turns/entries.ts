import type { TurnAgentMessage, TurnEntry } from "../../contracts/turns.js";

/** 附件旁注条目（老实现 `server/attachments.ts` 的 `isPromptAsideEntry`，删除用户消息时一起删）。 */
export function isPromptAsideEntry(entry: TurnEntry): boolean {
	const customType =
		entry.customType ??
		(entry.type === "message" && entry.message?.role === "custom" ? entry.message.customType : undefined);
	return (
		(entry.type === "custom_message" || (entry.type === "message" && entry.message?.role === "custom")) &&
		(customType === "file" || customType === "parallel-work-reminder")
	);
}

export function isUserMessageEntry(entry: TurnEntry): boolean {
	return entry.type === "message" && entry.message?.role === "user";
}

/** 「一轮对话的实体」：截断基准只认这些（与老实现同口径）。 */
export function isConversationTurnEntry(entry: TurnEntry): boolean {
	if (entry.type === "compaction" || entry.type === "branch_summary") return true;
	if (entry.type !== "message" || !entry.message) return false;
	const role = entry.message.role;
	return (
		role === "assistant" ||
		role === "toolResult" ||
		role === "bashExecution" ||
		role === "branchSummary" ||
		role === "compactionSummary" ||
		role === "user"
	);
}

/** 最新一条 `context_edit` 把目标置空 = 用户删掉了它；被删条目不再参与解析，也不能再删一次。 */
export function undeletedContextEntries(entries: readonly TurnEntry[]): TurnEntry[] {
	const edits = new Map<string, unknown>();
	for (const entry of entries) {
		if (entry.type === "context_edit" && typeof entry.targetId === "string")
			edits.set(entry.targetId, entry.replacement);
	}
	return entries.filter((entry) => edits.get(entry.id) !== null);
}

/**
 * 删除一条消息要连带摘掉的条目：删用户消息带上它前面的附件旁注，删 assistant 带上它工具调用的结果。
 * 逐字对齐 `server/message-deletion.ts`（含三种拒绝：目标不存在 / 非消息 / 不允许的角色）。
 */
export function messageDeletionTargets(entries: readonly TurnEntry[], targetId: string): string[] {
	const visible = undeletedContextEntries(entries);
	const index = visible.findIndex((entry) => entry.id === targetId);
	const target = visible[index];
	const role = target?.message?.role ?? "";
	if (!target || target.type !== "message" || (role !== "user" && role !== "assistant")) {
		throw new Error("Message is no longer available for deletion");
	}
	const ids = new Set([target.id]);
	if (role === "user") {
		for (let i = index - 1; i >= 0; i--) {
			const entry = visible[i];
			if (entry.type === "message" && entry.message?.role !== "system" && !isPromptAsideEntry(entry)) break;
			if (entry.type === "compaction" || entry.type === "branch_summary") break;
			if (isPromptAsideEntry(entry)) ids.add(entry.id);
		}
	} else {
		const calls = new Set(toolCallIds(target).map((call) => call.id));
		for (const entry of visible.slice(index + 1)) {
			if (entry.type !== "message" || entry.message?.role !== "toolResult") continue;
			const toolCallId = entry.message.toolCallId;
			if (toolCallId && calls.has(toolCallId)) ids.add(entry.id);
		}
	}
	return [...ids];
}

/**
 * 前端手里的消息 id → 条目：原始条目 id 直命中优先（老 `deleteMessage` 的 fallback），
 * 否则按出帧投影的编号匹配（`uiIds()`，编号单源在适配器里与 `view.ts` 同源）。
 */
export function resolveEntry(
	entries: readonly TurnEntry[],
	uiIds: ReadonlyMap<string, string>,
	messageId: string,
): TurnEntry | undefined {
	const direct = entries.find((entry) => entry.id === messageId);
	if (direct) return direct;
	for (const entry of entries) if (uiIds.get(entry.id) === messageId) return entry;
	return undefined;
}

export interface ToolCallRef {
	id: string;
	name: string;
}

/** 条目里的工具调用（`content` 是 SDK 的块数组，这里只做形状收窄）。 */
export function toolCallIds(entry: TurnEntry): ToolCallRef[] {
	const content = entry.message?.content;
	if (!Array.isArray(content)) return [];
	const out: ToolCallRef[] = [];
	for (const block of content) {
		const b = block as { type?: unknown; id?: unknown; name?: unknown };
		if (b.type !== "toolCall" || typeof b.id !== "string") continue;
		out.push({ id: b.id, name: typeof b.name === "string" ? b.name : "" });
	}
	return out;
}

/**
 * 重问要从哪个条目分叉：用户消息往上找到最近一个「轮次实体」的父条目；
 * 找不到（首条消息 / 父链断裂）= `null`，调用方 `resetLeaf()`。逐字对齐 `server/attachments.ts`。
 */
export function findTurnBaseEntryId(entryOf: (id: string) => TurnEntry | undefined, entryId: string): string | null {
	const target = entryOf(entryId);
	if (!target) return null;
	if (!isUserMessageEntry(target)) return target.parentId ?? null;

	let currentId: string | null | undefined = entryId;
	while (currentId) {
		const entry = entryOf(currentId);
		if (!entry) break;
		const parentId = entry.parentId;
		if (!parentId) return null;
		const parentEntry = entryOf(parentId);
		if (!parentEntry) return null;
		if (isConversationTurnEntry(parentEntry)) return parentId;
		currentId = parentId;
	}
	return null;
}

/**
 * 被丢弃的分支里登记过的 `schedule` 工具调用：截断前必须先取消它们（老实现 #966）。
 * 基准不在当前分支上 = 转录已被别人改写，直接拒绝（同老实现的报错文案）。
 */
export function discardedScheduleCalls(branchEntries: readonly TurnEntry[], baseEntryId: string | null): Set<string> {
	const baseIndex = baseEntryId ? branchEntries.findIndex((entry) => entry.id === baseEntryId) : -1;
	if (baseEntryId && baseIndex < 0) throw new Error("Reask base is no longer on the current branch");
	const calls = new Set<string>();
	for (const entry of branchEntries.slice(baseIndex + 1)) {
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		for (const call of toolCallIds(entry)) if (call.name === "schedule") calls.add(call.id);
	}
	return calls;
}

/** 最后一条 assistant 是报错结束的？老实现的循环只认最后一条（碰到就 break）。 */
export function lastAssistantFailed(messages: readonly TurnAgentMessage[]): boolean {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		const errorMessage = typeof message.errorMessage === "string" ? message.errorMessage.trim() : "";
		return errorMessage !== "" || message.stopReason === "error";
	}
	return false;
}
