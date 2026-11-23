export type { TextQuote } from "./protocol.js";
import type { TextQuote } from "./protocol.js";

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
	type: "file" | "folder" | "page" | "conversation" | "image" | "vision-bridge" | "canvas";
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

export interface StreamingPayload {
	promptImages: { type: "image"; data: string; mimeType: string }[];
	textAsides: string[];
	imageNames: string[];
	quotes: TextQuote[];
}

export interface AsideMessageLike {
	message: {
		content?: unknown;
		details?: unknown;
	};
}

export function extractStreamingPayload(
	asides: readonly AsideMessageLike[],
	initialQuotes: readonly TextQuote[] = [],
	mainSupportsVision: boolean = false,
	modelLabel: string = "unknown",
): StreamingPayload {
	const promptImages: { type: "image"; data: string; mimeType: string }[] = [];
	const textAsides: string[] = [];
	const imageNames: string[] = [];
	const quotes: TextQuote[] = [...initialQuotes];

	for (const aside of asides) {
		const details = aside.message?.details as { name?: string; mode?: string; quote?: unknown } | undefined;
		const isBridged = details?.mode === "bridged";
		const isQuote = details?.mode === "quote";

		if (isQuote && details?.quote) {
			const q = readTextQuote(details.quote);
			if (q) {
				quotes.push(q);
				continue;
			}
		}

		const rawContent = aside.message?.content;
		if (typeof rawContent === "string") {
			if (rawContent.trim()) textAsides.push(rawContent.trim());
			continue;
		}
		const content = Array.isArray(rawContent) ? rawContent : [];
		for (const b of content) {
			if (typeof b === "string") {
				if (b.trim()) textAsides.push(b.trim());
				continue;
			}
			if (!b || typeof b !== "object") continue;

			const block = b as { type?: unknown; data?: unknown; mimeType?: unknown; text?: unknown };
			if (block.type === "image" && typeof block.data === "string") {
				const imgName = details?.name ?? "image.png";
				if (mainSupportsVision) {
					promptImages.push({
						type: "image",
						data: block.data,
						mimeType: typeof block.mimeType === "string" && block.mimeType ? block.mimeType : "image/png",
					});
					imageNames.push(imgName);
				} else if (!isBridged) {
					imageNames.push(imgName);
					textAsides.push(`[Attached image "${imgName}" omitted: model (${modelLabel}) does not support vision]`);
				}
			} else if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
				textAsides.push(block.text.trim());
				if (isBridged && details?.name) {
					imageNames.push(details.name);
				}
			}
		}
	}

	return { promptImages, textAsides, imageNames, quotes };
}

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

	text = text.replace(/(?:^|\n\n)?<canvas-ref id="([^"]*)" title="([^"]*)">[\s\S]*?<\/canvas-ref>/g, (_, id, title) => {
		const decode = (s: string) =>
			s
				.replace(/&quot;/g, '"')
				.replace(/&lt;/g, "<")
				.replace(/&gt;/g, ">")
				.replace(/&amp;/g, "&");
		attachments.push({ type: "canvas", path: decode(id), name: decode(title) || decode(id) });
		return "";
	});

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
