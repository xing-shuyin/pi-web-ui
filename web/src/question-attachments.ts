import { readTextQuote } from "../../server/text-quote.js";

export interface EditPromptAttachment {
	path: string;
	mode?: "inline" | "reference" | "lines" | "page" | "conversation" | "quote" | "canvas";
	quote?: import("../../server/protocol.js").TextQuote;
	conversationId?: string;
	sessionPath?: string;
	lines?: { start: number; end: number };
	imageData?: string;
	imageUrl?: string;
	fileData?: string;
	uploadPath?: string;
	mimeType?: string;
	name?: string;
	size?: number;
}

interface ImageBlock {
	type: "image";
	dataUrl?: string;
	mimeType?: string;
}

function pushImageAttachments(
	atts: EditPromptAttachment[],
	content: readonly unknown[],
	fallbackName?: string,
): boolean {
	let hasImage = false;
	for (const b of content) {
		const img = b as ImageBlock;
		if (img.type !== "image" || typeof img.dataUrl !== "string") continue;
		if (/^\/api\/attachment\/[a-f0-9]{64}$/.test(img.dataUrl)) {
			hasImage = true;
			atts.push({
				path: "",
				imageUrl: img.dataUrl,
				mimeType: img.mimeType,
				name: fallbackName ?? "image",
			});
			continue;
		}
		if (!img.dataUrl.startsWith("data:")) continue;
		const mm = img.dataUrl.match(/^data:([^;]*);base64,(.+)$/);
		if (!mm) continue;
		hasImage = true;
		atts.push({
			path: "",
			imageData: mm[2],
			mimeType: mm[1] || "image/png",
			name: fallbackName ?? `image.${(mm[1] || "image/png").split("/")[1] ?? "png"}`,
		});
	}
	return hasImage;
}

function parseFileCardAttachment(msg: { content: readonly unknown[]; details?: unknown }): EditPromptAttachment | null {
	const details = (msg.details ?? {}) as {
		quote?: import("../../server/protocol.js").TextQuote;
		mode?: string;
		name?: string;
		size?: number;
		path?: string;
		startLine?: number;
		endLine?: number;
		upload?: boolean;
	};
	if (details.mode === "quote") {
		const quote = readTextQuote(details.quote);
		if (quote) return { path: "", mode: "quote", quote };
		return null;
	}
	const imgAtts: EditPromptAttachment[] = [];
	if (pushImageAttachments(imgAtts, msg.content, details.name)) return imgAtts[0] ?? null;
	if (details.upload && details.path) {
		return {
			path: "",
			uploadPath: details.path,
			name: details.name ?? details.path,
			size: details.size,
		};
	}
	if ((details.mode === "page" || details.mode === "canvas") && details.path) {
		return { path: details.path, mode: details.mode, name: details.name ?? details.path };
	}
	if (details.mode === "conversation") {
		const d = details as { conversationId?: unknown; sessionPath?: unknown };
		const conversationId = typeof d.conversationId === "string" && d.conversationId ? d.conversationId : undefined;
		const sessionPath = typeof d.sessionPath === "string" && d.sessionPath ? d.sessionPath : undefined;
		if (conversationId || sessionPath) {
			return {
				path: "",
				mode: "conversation",
				name: details.name ?? conversationId ?? sessionPath,
				...(conversationId ? { conversationId } : {}),
				...(sessionPath ? { sessionPath } : {}),
			};
		}
		return null;
	}
	if (details.path && details.mode) {
		const mode = details.mode === "lines" ? "lines" : "reference";
		const att: EditPromptAttachment = { path: details.path, mode };
		if (details.mode === "lines" && typeof details.startLine === "number" && typeof details.endLine === "number") {
			att.lines = { start: details.startLine, end: details.endLine };
		}
		return att;
	}
	return null;
}

function attachmentDedupKey(att: EditPromptAttachment): string {
	if (att.mode === "quote" && att.quote) {
		return `quote:${att.quote.messageId ?? ""}:${att.quote.text}`;
	}
	if (att.mode === "conversation") {
		return `conv:${att.conversationId ?? ""}:${att.sessionPath ?? ""}:${att.name ?? ""}`;
	}
	if (att.mode === "page") {
		return `page:${att.path}`;
	}
	if (att.imageUrl) return `image-url:${att.imageUrl}`;
	if (att.imageData) {
		return `img:${att.name ?? ""}:${att.imageData.length}:${att.imageData.slice(0, 64)}`;
	}
	if (att.uploadPath) {
		return `upload:${att.uploadPath}`;
	}
	if (att.path) {
		const lines = att.lines ? `${att.lines.start}-${att.lines.end}` : "";
		return `path:${att.mode ?? "ref"}:${att.path}:${lines}`;
	}
	return `unknown:${JSON.stringify(att)}`;
}

export function deduplicateAttachments(atts: readonly EditPromptAttachment[]): EditPromptAttachment[] {
	const seen = new Set<string>();
	const result: EditPromptAttachment[] = [];
	for (const a of atts) {
		const key = attachmentDedupKey(a);
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(a);
	}
	return result;
}

export function collectQuestionAttachments(
	messages: readonly {
		id?: string;
		role: string;
		content: readonly unknown[];
		details?: unknown;
		customType?: string;
	}[],
): Map<string, EditPromptAttachment[]> {
	const m = new Map<string, EditPromptAttachment[]>();
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role !== "user" || !msg.id) continue;
		const atts: EditPromptAttachment[] = [];
		pushImageAttachments(atts, msg.content);
		const quotes = (msg.details as { quotes?: unknown[] } | undefined)?.quotes;
		for (const value of Array.isArray(quotes) ? quotes : []) {
			const quote = readTextQuote(value);
			if (quote) atts.push({ path: "", mode: "quote", quote });
		}
		const leadingAtts: EditPromptAttachment[] = [];
		for (let j = i - 1; j >= 0 && messages[j].role === "custom" && messages[j].customType === "file"; j--) {
			const att = parseFileCardAttachment(messages[j]);
			if (att) leadingAtts.unshift(att);
		}
		atts.push(...leadingAtts);

		for (
			let j = i + 1;
			j < messages.length && messages[j].role === "custom" && messages[j].customType === "file";
			j++
		) {
			const att = parseFileCardAttachment(messages[j]);
			if (att) atts.push(att);
		}
		const deduped = deduplicateAttachments(atts);
		if (deduped.length > 0) m.set(msg.id, deduped);
	}
	return m;
}
