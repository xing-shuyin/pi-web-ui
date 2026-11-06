export function mergeRecalledDraft(current: string, recalled: string): string {
	if (!recalled) return current;
	if (!current.trim()) return recalled;
	return `${current.replace(/\s+$/, "")}\n${recalled}`;
}

export function selectDraftToRestore(
	server: { text: string; ts: number } | null | undefined,
	local: { text: string; ts: number } | null,
	appliedTs: number,
): { text: string; ts: number } | null {
	let best: { text: string; ts: number } | null = null;
	if (server && server.text && server.ts > 0) best = { text: server.text, ts: server.ts };
	if (local && local.text && local.ts > (best?.ts ?? 0)) best = local;
	if (!best || best.ts <= appliedTs) return null;
	return best;
}

export interface DraftAttachment {
	path: string;
	name: string;
	mode?: "inline" | "reference" | "lines" | "page" | "conversation" | "quote" | "canvas";
	quote?: import("../../server/protocol.js").TextQuote;
	conversationId?: string;
	sessionPath?: string;
	isDir?: boolean;
	lines?: { start: number; end: number };
	imageData?: string;
	mimeType?: string;
	fileData?: string;
	size?: number;
	key?: string;
}

function attachmentIdentity(a: DraftAttachment): string | null {
	if (a.mode === "quote" && a.quote) {
		return `quote:${JSON.stringify([a.quote.sessionId ?? "", a.quote.messageId, a.quote.role, a.quote.text])}`;
	}
	if (a.key) return `key:${a.key}`;
	if (a.mode === "conversation") {
		if (a.conversationId) return `conv:id:${a.conversationId}`;
		if (a.sessionPath) return `conv:path:${a.sessionPath}`;
		return null;
	}
	if (!a.path) return null;
	return `${a.path}|${a.mode}|${a.lines ? `${a.lines.start}-${a.lines.end}` : ""}`;
}

export function advanceComposerSession(prev: string, sessionId: string): { key: string; clear: boolean } {
	if (!sessionId) return { key: prev, clear: false };
	if (!prev) return { key: sessionId, clear: false };
	return { key: sessionId, clear: prev !== sessionId };
}

export function appendDraftAttachments(current: DraftAttachment[], incoming: DraftAttachment[]): DraftAttachment[] {
	if (incoming.length === 0) return current;
	if (current.length === 0) return [...incoming];
	const seen = new Set(current.map(attachmentIdentity).filter((id): id is string => id !== null));
	const out = [...current];
	for (const item of incoming) {
		const id = attachmentIdentity(item);
		if (id !== null) {
			if (seen.has(id)) continue;
			seen.add(id);
		}
		out.push(item);
	}
	return out;
}

export function shouldCarryOverDraft(
	pendingCarry: string | null | undefined,
	targetMessageCount: number,
	hasExistingDraftOnTarget: boolean,
): boolean {
	if (!pendingCarry || !pendingCarry.trim()) return false;
	if (targetMessageCount > 0) return false;
	if (hasExistingDraftOnTarget) return false;
	return true;
}

export function shouldPreserveDraftOnSwitch(
	pendingCarry: string | null | undefined,
	userEditedAfterSwitch: boolean,
	targetMessageCount: number,
	hasExistingDraftOnTarget: boolean,
	preserveDraftAcrossConversations: boolean = false,
): boolean {
	if (!pendingCarry || !pendingCarry.trim()) return false;
	if (userEditedAfterSwitch) return true;
	if (preserveDraftAcrossConversations) return true;
	return false;
}

export type TemplateFillChoice = "cancel" | "append" | "overwrite";

export function shouldConfirmTemplateFill(current: string, incoming: string): boolean {
	if (!incoming || !incoming.trim()) return false;
	const cur = current.trim();
	if (!cur) return false;
	if (cur === incoming.trim()) return false;
	return true;
}

export function applyTemplateFill(current: string, incoming: string, choice: TemplateFillChoice): string | null {
	switch (choice) {
		case "cancel":
			return null;
		case "append":
			return mergeRecalledDraft(current, incoming);
		case "overwrite":
			return incoming;
	}
}
