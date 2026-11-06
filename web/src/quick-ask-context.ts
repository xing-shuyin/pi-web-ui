import { appUrl } from "./base-url";
import type { QuickAskAttachment, QuickAskMessage } from "./quick-ask";
import type { QuickAskContextRequest, QuickAskContextSource } from "./types";
export type { QuickAskContextSource } from "./types";

export const QUICK_ASK_MAX_ATTACHMENTS = 8;
export const QUICK_ASK_MAX_FILE_BYTES = 2 * 1024 * 1024;
export type QuickAskContextScope = NonNullable<QuickAskContextRequest["scope"]>;
export class QuickAskAttachmentError extends Error {
	constructor(public readonly code: "quickAskFileTooLarge" | "quickAskTooManyReferences" | "quickAskUnsupportedFile") {
		super(code);
	}
}

export function quickAskBudgetError(
	messages: QuickAskMessage[],
): "quickAskTooManyReferences" | "quickAskImagesTooLarge" | "quickAskContextTooLarge" | null {
	let count = 0,
		text = 0,
		images = 0;
	for (const message of messages) {
		text += message.content.length;
		for (const attachment of message.attachments || []) {
			count++;
			text += attachment.content.length + attachment.name.length + (attachment.path?.length || 0) + 128;
			const data = attachment.image?.data;
			if (data) images += (data.length * 3) / 4 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
		}
	}
	if (count > QUICK_ASK_MAX_ATTACHMENTS) return "quickAskTooManyReferences";
	if (images > 6 * 1024 * 1024) return "quickAskImagesTooLarge";
	return text > 65_536 ? "quickAskContextTooLarge" : null;
}

export async function loadQuickAskReference(
	source: QuickAskContextSource,
	options: { scope?: QuickAskContextScope; clientId?: string; signal: AbortSignal },
): Promise<QuickAskAttachment> {
	const controller = new AbortController();
	const abort = () => controller.abort(options.signal.reason);
	if (options.signal.aborted) abort();
	else options.signal.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(() => controller.abort(new Error("Loading reference timed out")), 45_000);
	try {
		const response = await fetch(appUrl("/api/quick-ask/context"), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ source, scope: options.scope, clientId: options.clientId }),
			signal: controller.signal,
		});
		const result = (await response.json()) as { attachment?: QuickAskAttachment; error?: string };
		if (!response.ok) {
			if (response.status === 415 || /unsupported|binary file/i.test(result.error || ""))
				throw new QuickAskAttachmentError("quickAskUnsupportedFile");
			throw new Error(result.error || `HTTP ${response.status}`);
		}
		const attachment = result.attachment;
		if (
			!attachment ||
			typeof attachment.id !== "string" ||
			typeof attachment.name !== "string" ||
			typeof attachment.content !== "string" ||
			!["file", "directory", "conversation"].includes(attachment.kind)
		)
			throw new Error("Invalid reference response");
		return attachment;
	} finally {
		clearTimeout(timer);
		options.signal.removeEventListener("abort", abort);
	}
}

export async function loadQuickAskFile(
	file: File,
	options: { clientId?: string; signal: AbortSignal },
): Promise<QuickAskAttachment> {
	if (file.size > QUICK_ASK_MAX_FILE_BYTES) throw new QuickAskAttachmentError("quickAskFileTooLarge");
	options.signal.throwIfAborted();
	const bytes = new Uint8Array(await file.arrayBuffer());
	options.signal.throwIfAborted();
	let binary = "";
	for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
	return loadQuickAskReference({ kind: "upload", name: file.name, data: btoa(binary), mimeType: file.type }, options);
}

export async function loadQuickAskFolder(
	files: File[],
	options: { scope: "listing" | "content"; clientId?: string; signal: AbortSignal },
): Promise<QuickAskAttachment> {
	options.signal.throwIfAborted();
	const name = files[0]?.webkitRelativePath.split("/")[0] || "folder";
	const selected = files.slice(0, 64);
	let content = selected
		.map((file) => file.webkitRelativePath || file.name)
		.join("\n")
		.slice(0, 16_000);
	if (files.length > selected.length) content += `\n[Listing truncated: ${files.length - selected.length} more files]`;
	if (options.scope === "content") {
		const textFiles = selected.filter(
			(file) =>
				file.type.startsWith("text/") ||
				/\.(?:txt|md|mdx|json|jsonc|ya?ml|toml|xml|csv|ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|c|cpp|h|css|html|sh|sql|log|ini|conf)$/i.test(
					file.name,
				),
		);
		for (const file of textFiles.slice(0, 8)) {
			const item = await loadQuickAskFile(file, options);
			content += `\n\n--- ${file.webkitRelativePath || file.name} ---\n${item.content}`;
			if (content.length > 30_000) {
				content = content.slice(0, 30_000) + "\n[Content truncated]";
				break;
			}
		}
		if (textFiles.length > 8) content += "\n[Additional text files omitted]";
	}
	return { id: `upload-directory:${name}`, kind: "directory", name: `${name}/`, content };
}
