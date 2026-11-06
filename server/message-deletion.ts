import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { isPromptAsideEntry } from "./attachments.js";

export function undeletedContextEntries(entries: SessionEntry[]): SessionEntry[] {
	const edits = new Map<string, unknown>();
	for (const entry of entries) {
		if (entry.type === "context_edit") edits.set(entry.targetId, entry.replacement);
	}
	return entries.filter((entry) => edits.get(entry.id) !== null);
}

export function messageDeletionTargets(entries: SessionEntry[], targetId: string): string[] {
	const visible = undeletedContextEntries(entries);
	const index = visible.findIndex((entry) => entry.id === targetId);
	const target = visible[index];
	if (!target || target.type !== "message" || !["user", "assistant"].includes(target.message.role)) {
		throw new Error("Message is no longer available for deletion");
	}
	const ids = new Set([target.id]);
	if (target.message.role === "user") {
		for (let i = index - 1; i >= 0; i--) {
			const entry = visible[i];
			if (entry.type === "message" && entry.message.role !== "system" && !isPromptAsideEntry(entry)) break;
			if (entry.type === "compaction" || entry.type === "branch_summary") break;
			if (isPromptAsideEntry(entry)) ids.add(entry.id);
		}
	} else if (target.message.role === "assistant") {
		const calls = new Set(target.message.content.filter((block) => block.type === "toolCall").map((block) => block.id));
		for (const entry of visible.slice(index + 1)) {
			if (entry.type === "message" && entry.message.role === "toolResult" && calls.has(entry.message.toolCallId)) {
				ids.add(entry.id);
			}
		}
	}
	return [...ids];
}
