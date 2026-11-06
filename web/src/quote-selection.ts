/// <reference lib="dom" />
import type { TextQuote } from "../../server/protocol.js";

const CONTENT = ".msg-text, .attachcard-content, .toolcall-output pre, .bashblock-output, .quote-content";
const EXCLUDED = "button, input, textarea, [contenteditable], .msg-meta, .msg-actions, .chead, .toolcall-output-label";

function parentElement(node: Node): Element | null {
	return node.nodeType === 1 ? (node as Element) : node.parentElement;
}

export function readQuoteSelection(
	root: HTMLElement,
	selection: Selection | null,
	sessionId?: string,
): TextQuote | null {
	if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
	const range = selection.getRangeAt(0);
	const start = parentElement(range.startContainer);
	const end = parentElement(range.endContainer);
	if (!start || !end || !root.contains(start) || !root.contains(end)) return null;
	if (!start.closest(CONTENT) || !end.closest(CONTENT)) return null;
	if (start.closest(EXCLUDED) || end.closest(EXCLUDED)) return null;
	const message = start.closest<HTMLElement>(".msg[data-msg-id]");
	if (!message || message !== end.closest(".msg[data-msg-id]")) return null;
	for (const element of message.querySelectorAll(EXCLUDED)) {
		if (range.intersectsNode(element)) return null;
	}
	const text = selection.toString();
	const messageId = message.dataset.msgId;
	const role = message.dataset.role;
	if (!text.trim() || !messageId || !role) return null;
	return { text, messageId, role, ...(sessionId ? { sessionId } : {}) };
}
