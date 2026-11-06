import type {
	QuickAskAttachment,
	QuickAskContextSource,
	QuickAskMessage,
	QuickAskStreamEvent,
	UiSettingsState,
} from "./types";
export type { QuickAskAttachment, QuickAskMessage } from "./types";

export type QuickAskReferenceSource = Exclude<QuickAskContextSource, { kind: "upload" }>;

export interface QuickAskOpenRequest {
	selection?: string;
	action?: "explain" | "translate";
	reference?: QuickAskReferenceSource;
	anchor?: { left: number; right: number; top: number; bottom: number };
}

export const QUICK_ASK_OPEN_EVENT = "pi:quick-ask-open";

export function openQuickAsk(request: QuickAskOpenRequest = {}): void {
	window.dispatchEvent(new CustomEvent<QuickAskOpenRequest>(QUICK_ASK_OPEN_EVENT, { detail: request }));
}

export function explainSelectionPrompt(template: string | undefined, input: string): string {
	return (template?.trim() || "解释下: {{input}}").replaceAll("{{input}}", () => input);
}

const LANGUAGE_NAMES: Record<string, string> = {
	zh: "Simplified Chinese",
	"zh-CN": "Simplified Chinese",
	"zh-TW": "Traditional Chinese",
	"zh-HK": "Traditional Chinese",
	"zh-Hant": "Traditional Chinese",
	en: "English",
	ja: "Japanese",
	ko: "Korean",
	de: "German",
	fr: "French",
	es: "Spanish",
	ru: "Russian",
	pt: "Portuguese",
	it: "Italian",
	tr: "Turkish",
};
export const QUICK_ASK_LANGUAGE_LABELS: Record<string, string> = {
	auto: "Auto",
	"zh-CN": "简体中文",
	"zh-TW": "繁體中文",
	en: "English",
	ja: "日本語",
	ko: "한국어",
	de: "Deutsch",
	fr: "Français",
	es: "Español",
	ru: "Русский",
	pt: "Português",
	it: "Italiano",
	tr: "Türkçe",
};

export function translateSelectionPrompt(
	settings: Pick<
		UiSettingsState,
		"quickAskTranslatePrompt" | "quickAskTranslateTarget" | "quickAskTranslateStyle"
	> | null,
	input: string,
	locale: string,
	target = settings?.quickAskTranslateTarget || "auto",
): string {
	const code = target === "auto" ? locale : target;
	const language = LANGUAGE_NAMES[code] || LANGUAGE_NAMES[code.split("-")[0]] || "English";
	const template =
		settings?.quickAskTranslatePrompt?.trim() ||
		"将以下文字翻译成{{targetLanguage}}，只输出译文，保留代码与专有名词。\n{{input}}";
	const style = {
		natural: "Use natural, fluent phrasing while preserving the original meaning.",
		literal: "Translate faithfully and stay close to the original wording.",
		technical: "Use precise technical terminology and preserve code and identifiers.",
	}[settings?.quickAskTranslateStyle || "natural"];
	return (
		template.replace(/\{\{(input|targetLanguage)\}\}/g, (_, field: string) => (field === "input" ? input : language)) +
		`\n\nTranslation style: ${style}`
	);
}

export async function readQuickAskResponse(
	response: Response,
	onEvent: (event: QuickAskStreamEvent) => void,
): Promise<void> {
	if (!response.ok || !response.headers.get("content-type")?.includes("application/x-ndjson")) {
		const result = (await response.json()) as { text?: string; model?: string; error?: string };
		if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
		if (!result.text?.trim()) throw new Error("Model returned no answer");
		onEvent({ type: "done", text: result.text, model: result.model ?? "" });
		return;
	}
	if (!response.body) throw new Error("Model response has no body");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let finished = false;
	const consume = (line: string) => {
		if (!line.trim()) return;
		const event = JSON.parse(line) as QuickAskStreamEvent;
		if (!event || typeof event !== "object") throw new Error("Invalid quick ask stream event");
		switch (event.type) {
			case "start":
				if (typeof event.model !== "string") throw new Error("Invalid model in stream");
				break;
			case "delta":
				if (typeof event.text !== "string") throw new Error("Invalid text in stream");
				break;
			case "done":
				if (typeof event.text !== "string" || !event.text.trim() || typeof event.model !== "string")
					throw new Error("Model returned no answer");
				finished = true;
				break;
			case "error":
				throw new Error(typeof event.error === "string" ? event.error : "Quick ask failed");
			default:
				throw new Error("Invalid quick ask stream event");
		}
		onEvent(event);
	};
	try {
		while (!finished) {
			const { done, value } = await reader.read();
			buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
			let newline: number;
			while (!finished && (newline = buffer.indexOf("\n")) !== -1) {
				consume(buffer.slice(0, newline));
				buffer = buffer.slice(newline + 1);
			}
			if (buffer.length > 1_048_576) throw new Error("Quick ask stream frame is too large");
			if (done) {
				if (!finished) consume(buffer);
				break;
			}
		}
		if (!finished) throw new Error("Model stream ended before completion");
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

export function appendQuickAskQuestion(
	messages: QuickAskMessage[],
	content: string,
	attachments: QuickAskAttachment[] = [],
): QuickAskMessage[] {
	const history = messages.at(-1)?.role === "user" ? messages.slice(0, -1) : messages;
	const fresh = attachments.filter(
		(attachment) =>
			!history.some((message) => message.attachments?.some((previous) => sameQuickAskAttachment(previous, attachment))),
	);
	return [...history, { role: "user", content, ...(fresh.length ? { attachments: fresh } : {}) }];
}

export function sameQuickAskAttachment(a: QuickAskAttachment, b: QuickAskAttachment): boolean {
	return (
		a.id === b.id &&
		a.content === b.content &&
		a.image?.data === b.image?.data &&
		a.image?.mimeType === b.image?.mimeType
	);
}
