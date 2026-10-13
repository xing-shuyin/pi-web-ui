export type { TextQuote } from "./protocol.js";
import type { TextQuote } from "./protocol.js";

/** 校验引用元数据，保留原文的换行和缩进。 */
export function readTextQuote(value: unknown): TextQuote | null {
	if (!value || typeof value !== "object") return null;
	const q = value as Partial<TextQuote>;
	if (
		typeof q.text !== "string" ||
		!q.text.trim() ||
		typeof q.messageId !== "string" ||
		!q.messageId ||
		typeof q.role !== "string" ||
		!q.role
	)
		return null;
	return {
		text: q.text,
		messageId: q.messageId,
		role: q.role,
		...(typeof q.sessionId === "string" && q.sessionId ? { sessionId: q.sessionId } : {}),
	};
}

/** JSON 字符串保留原文边界，引用中的换行不参与外层标记解析。 */
export function formatTextQuote(quote: TextQuote): string {
	return `<quoted-text>\n${JSON.stringify(quote)}\n</quoted-text>`;
}

export function parseTextQuote(text: string): TextQuote | null {
	const match = /^<quoted-text>\n([^\n]*)\n<\/quoted-text>$/.exec(text);
	if (!match) return null;
	try {
		return readTextQuote(JSON.parse(match[1]));
	} catch {
		return null;
	}
}

export function formatQuotedPrompt(text: string, quotes: readonly TextQuote[]): string {
	return [text, ...quotes.map(formatTextQuote)].join("\n\n");
}

export interface QueuedAttachmentMeta {
	type: "file" | "folder" | "page" | "conversation" | "image" | "vision-bridge";
	name: string;
	path?: string;
	url?: string;
	lines?: { start: number; end: number };
}

export interface ParsedQuotedPrompt {
	text: string;
	quotes: TextQuote[];
	attachments?: QueuedAttachmentMeta[];
}

function escapeAttr(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * 流式中排队/插队发送时把文本、文本附件（文件/目录/网页/对话引用/视觉桥）、
 * 引用与图片标记格式化到同一条提示词中，避免使用 SDK 的 _pendingNextTurnMessages
 * 造成排队消息丢失附件以及泄露到后续提问。
 */
export function formatStreamingPrompt(
	text: string,
	textAsides: readonly string[] = [],
	quotes: readonly TextQuote[] = [],
	imageNames: readonly string[] = [],
): string {
	const parts: string[] = [];
	const trimmed = (text ?? "").trim();
	if (trimmed) parts.push(trimmed);
	for (const img of imageNames) {
		if (img) parts.push(`<attached-image name="${escapeAttr(img)}" />`);
	}
	for (const aside of textAsides) {
		const a = (aside ?? "").trim();
		if (a) parts.push(a);
	}
	for (const q of quotes) {
		parts.push(formatTextQuote(q));
	}
	return parts.join("\n\n");
}

/** 排队项把引用与附件随提问一起保存；展示时拆分末尾的引用块与附件标记。 */
export function splitQuotedPrompt(value: string): ParsedQuotedPrompt {
	let text = value;
	const quotes: TextQuote[] = [];
	while (true) {
		const match = /(?:^|\n\n)(<quoted-text>\n[^\n]*\n<\/quoted-text>)$/.exec(text);
		const quote = match ? parseTextQuote(match[1]) : null;
		if (!match || !quote) break;
		quotes.unshift(quote);
		text = text.slice(0, match.index);
	}

	const attachments: QueuedAttachmentMeta[] = [];

	text = text.replace(/(?:^|\n\n)?<attached-image name="([^"]*)"\s*\/>/g, (_, name) => {
		attachments.push({ type: "image", name });
		return "";
	});

	text = text.replace(
		/(?:^|\n\n)?<file path="([^"]*)"(?:\s+size="[^"]*")?(?:\s+lines="(\d+)-(\d+)")?\s*\/>/g,
		(_, path, start, end) => {
			const name = path.split(/[\\/]/).pop() ?? path;
			const lines = start && end ? { start: Number(start), end: Number(end) } : undefined;
			attachments.push({ type: "file", name, path, lines });
			return "";
		},
	);

	text = text.replace(/(?:^|\n\n)?<folder path="([^"]*)"\s*\/>/g, (_, path) => {
		const name = path.split(/[\\/]/).pop() ?? path;
		attachments.push({ type: "folder", name, path });
		return "";
	});

	text = text.replace(
		/(?:^|\n\n)?<browser-page url="([^"]*)" title="([^"]*)">[\s\S]*?<\/browser-page>/g,
		(_, url, title) => {
			attachments.push({ type: "page", name: title || url, url });
			return "";
		},
	);

	text = text.replace(
		/(?:^|\n\n)?<conversation-ref[^>]*title="([^"]*)"[^>]*>[\s\S]*?<\/conversation-ref>/g,
		(_, title) => {
			attachments.push({ type: "conversation", name: title });
			return "";
		},
	);

	text = text.replace(/(?:^|\n\n)?<vision-bridge>[\s\S]*?<\/vision-bridge>/g, () => {
		attachments.push({ type: "vision-bridge", name: "视觉转写" });
		return "";
	});

	if (attachments.length > 0) {
		text = text.trim();
	}

	return {
		text,
		quotes,
		...(attachments.length ? { attachments } : {}),
	};
}

export function messageTextWithQuotes(message: {
	content: readonly { type: string; text?: unknown }[];
	details?: unknown;
}): string {
	const text = message.content
		.map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
		.join("\n");
	const values = (message.details as { quotes?: unknown[] } | undefined)?.quotes;
	const quotes = Array.isArray(values) ? values.map(readTextQuote).filter((q): q is TextQuote => q !== null) : [];
	return formatQuotedPrompt(text, quotes);
}
