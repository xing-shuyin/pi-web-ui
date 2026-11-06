import { realpath, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { PageCallRequest, PageCallResult } from "./browser-page-tool.js";
import { isSafeGraphId, loadCanvasGraph } from "./canvas/canvas-store.js";
import { MAX_NATIVE_CLI_PASTE, sanitizeNativeCliPaste } from "./native-cli.js";
import { uploadLimitBytes, type UploadLimits } from "./payload-limits.js";
import type { PromptAttachment } from "./protocol.js";
import type { QuickAskConversationSnapshot, QuickAskConversationSource } from "./quick-ask-context.js";
import { CLIENT_ID_PATTERN, saveUpload, uploadsRoot } from "./uploads.js";

export interface NativeCliReferenceContext {
	clientId: string;
	settings: UploadLimits;
	dataDir: string;
	signal?: AbortSignal;
	pasteText?: string;
	readPage: (request: PageCallRequest, signal: AbortSignal) => Promise<PageCallResult>;
	readConversation: (
		source: QuickAskConversationSource,
		signal: AbortSignal,
	) => Promise<QuickAskConversationSnapshot | undefined>;
}

const MAX_INLINE_QUOTE_BYTES = 8 * 1024;
const PAGE_TIMEOUT_MS = 30_000;
const PATH_RESERVE_BYTES = 4096 + 32;

type ExportPlan = { text: string; name: string; mimeType: string };
type ReferencePlan = { attachment: PromptAttachment; exported?: ExportPlan };

function referenceString(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim() || value.length > 4096 || /[\x00-\x1f\x7f-\x9f]/.test(value))
		throw new Error(`Invalid native CLI reference ${label}`);
	return value;
}

function assertWithin(root: string, path: string): void {
	const rel = relative(root, path);
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
		throw new Error("Uploaded reference belongs to a different client or is outside uploads");
}

function withAbort<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
	signal.throwIfAborted();
	return new Promise<T>((resolveResult, reject) => {
		const abort = () => reject(signal.reason ?? new Error("Native CLI reference read aborted"));
		signal.addEventListener("abort", abort, { once: true });
		Promise.resolve()
			.then(() => {
				signal.throwIfAborted();
				return operation();
			})
			.then(resolveResult, reject)
			.finally(() => signal.removeEventListener("abort", abort));
	});
}

async function existingUploadBytes(attachment: PromptAttachment, context: NativeCliReferenceContext): Promise<number> {
	const sources = [attachment.fileData, attachment.imageData, attachment.uploadPath].filter((v) => v !== undefined);
	if (sources.length > 1) throw new Error("Ambiguous native CLI attachment source");
	if (attachment.uploadPath !== undefined) {
		const root = resolve(uploadsRoot(context.dataDir), context.clientId);
		const path = resolve(referenceString(attachment.uploadPath, "upload path"));
		assertWithin(root, path);
		assertWithin(await realpath(root), await realpath(path));
		const info = await stat(path);
		if (!info.isFile()) throw new Error("Uploaded native CLI reference is not a file");
		return info.size;
	}
	const encoded = attachment.fileData ?? attachment.imageData;
	if (encoded === undefined) return 0;
	if (typeof encoded !== "string") throw new Error("Invalid native CLI upload data");
	const raw = encoded.replace(/^data:[^;,]+;base64,/, "");
	if (raw.length % 4 === 1 || (raw.includes("=") && raw.length % 4 !== 0) || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw))
		throw new Error("Invalid native CLI upload base64");
	const padding = raw.endsWith("==") ? 2 : raw.endsWith("=") ? 1 : 0;
	return Math.floor((raw.length * 3) / 4) - padding;
}

function pageText(result: PageCallResult): string {
	if (!result.ok) throw new Error(result.error || "Authorized page read failed");
	const value = result.result;
	if (value && typeof value === "object" && "error" in value && value.error) throw new Error(String(value.error));
	const text =
		typeof value === "string" ? value : value && typeof value === "object" && "text" in value ? value.text : undefined;
	if (typeof text !== "string" || !text.trim()) throw new Error("Authorized page returned no readable body text");
	return text;
}

function conversationText(snapshot: QuickAskConversationSnapshot | undefined): string {
	if (!snapshot) throw new Error("Referenced conversation was not found or is not authorized");
	if (!Array.isArray(snapshot.messages)) throw new Error("Referenced conversation returned an invalid transcript");
	const messages: string[] = [];
	for (const message of snapshot.messages) {
		if (!message || !["user", "assistant"].includes(message.role) || typeof message.content !== "string")
			throw new Error("Referenced conversation returned an invalid message");
		if (message.content.trim()) messages.push(`${message.role === "user" ? "User" : "Assistant"}:\n${message.content}`);
	}
	if (!messages.length) throw new Error("Referenced conversation has no readable messages");
	return [
		`Conversation: ${snapshot.name}`,
		...(snapshot.path ? [`Session: ${snapshot.path}`] : []),
		...(snapshot.cwd ? [`Workspace: ${snapshot.cwd}`] : []),
		"",
		messages.join("\n\n"),
	].join("\n");
}

export async function materializeNativeCliReferences(
	attachments: PromptAttachment[] | undefined,
	context: NativeCliReferenceContext,
): Promise<PromptAttachment[]> {
	if (attachments !== undefined && (!Array.isArray(attachments) || attachments.length > 32))
		throw new Error("Invalid native CLI attachments (max 32)");
	if (!CLIENT_ID_PATTERN.test(context.clientId)) throw new Error("Invalid upload client identity");
	const signal = context.signal ?? AbortSignal.timeout(PAGE_TIMEOUT_MS);
	signal.throwIfAborted();
	const input = attachments ?? [];
	const maxBytes = uploadLimitBytes(context.settings, "chat");
	let uploadBytes = 0;
	for (const attachment of input) {
		if (!attachment || typeof attachment !== "object") throw new Error("Invalid native CLI attachment");
		uploadBytes += await withAbort(() => existingUploadBytes(attachment, context), signal);
		if (uploadBytes > maxBytes) throw new Error("Native CLI references exceed the chat upload limit");
	}
	let inlineBudget = Math.max(
		0,
		Math.min(
			MAX_INLINE_QUOTE_BYTES,
			MAX_NATIVE_CLI_PASTE -
				Buffer.byteLength(sanitizeNativeCliPaste(context.pasteText ?? ""), "utf8") -
				input.length * PATH_RESERVE_BYTES,
		),
	);
	const plans: ReferencePlan[] = [];
	for (const attachment of input) {
		signal.throwIfAborted();
		try {
			let exported: ExportPlan | undefined;
			const mode = attachment.mode;
			if (["quote", "page", "conversation", "canvas"].includes(mode ?? "")) {
				if ([attachment.fileData, attachment.imageData, attachment.uploadPath].some((v) => v !== undefined))
					throw new Error("Ambiguous native CLI reference source");
			}
			if (mode === "quote") {
				const text = attachment.quote?.text;
				if (typeof text !== "string") throw new Error("Invalid native CLI text quote");
				const inlineBytes = Buffer.byteLength(`\n\nQuoted text:\n${sanitizeNativeCliPaste(text)}`, "utf8");
				if (inlineBytes <= inlineBudget && text.length <= MAX_NATIVE_CLI_PASTE) inlineBudget -= inlineBytes;
				else exported = { text, name: "quoted-text.txt", mimeType: "text/plain" };
			} else if (mode === "page") {
				const target = referenceString(attachment.path, "page target");
				const result = await withAbort(
					() => context.readPage({ op: "read", target, args: { what: "text" }, timeoutMs: PAGE_TIMEOUT_MS }, signal),
					signal,
				);
				exported = {
					text: `Page: ${attachment.name || target}\nTarget: ${target}\n\n${pageText(result)}`,
					name: "page-reference.txt",
					mimeType: "text/plain",
				};
			} else if (mode === "conversation") {
				if (attachment.conversationId === undefined && attachment.sessionPath === undefined)
					throw new Error("Conversation reference requires a conversation ID or session path");
				const source: QuickAskConversationSource = {
					kind: "conversation",
					...(attachment.conversationId !== undefined
						? { conversationId: referenceString(attachment.conversationId, "conversation ID") }
						: {}),
					...(attachment.sessionPath !== undefined
						? { sessionFile: referenceString(attachment.sessionPath, "session path") }
						: {}),
				};
				const snapshot = await withAbort(() => context.readConversation(source, signal), signal);
				exported = { text: conversationText(snapshot), name: "conversation-reference.txt", mimeType: "text/plain" };
			} else if (mode === "canvas") {
				const id = referenceString(attachment.path, "canvas ID");
				if (!isSafeGraphId(id)) throw new Error("Invalid canvas reference ID");
				const info = await withAbort(() => stat(join(context.dataDir, "canvas", `${id}.json`)), signal);
				if (!info.isFile()) throw new Error("Referenced canvas is not a file");
				if (info.size > maxBytes - uploadBytes) throw new Error("Native CLI references exceed the chat upload limit");
				signal.throwIfAborted();
				const graph = loadCanvasGraph(context.dataDir, id);
				if (!graph || graph.id !== id || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges))
					throw new Error("Referenced canvas returned an invalid graph");
				exported = {
					text: `${JSON.stringify(graph, null, 2)}\n`,
					name: `canvas-${id}.json`,
					mimeType: "application/json",
				};
			} else if (mode && !["reference", "inline", "lines"].includes(mode)) {
				throw new Error(`Unsupported native CLI attachment mode: ${mode}`);
			}
			if (exported) {
				uploadBytes += Buffer.byteLength(exported.text, "utf8");
				if (uploadBytes > maxBytes) throw new Error("Native CLI references exceed the chat upload limit");
			}
			plans.push({ attachment, exported });
		} catch (error) {
			if (signal.aborted) signal.throwIfAborted();
			throw new Error(
				`Unable to materialize native CLI ${attachment.mode ?? "file"} reference: ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			);
		}
	}
	const savedPaths: string[] = [];
	try {
		return plans.map(({ attachment, exported }) => {
			signal.throwIfAborted();
			if (!exported) return attachment;
			const bytes = Buffer.from(exported.text, "utf8");
			const saved = saveUpload(context.clientId, exported.name, bytes, context.dataDir);
			savedPaths.push(saved.abs);
			signal.throwIfAborted();
			return {
				path: "",
				uploadPath: saved.abs,
				name: saved.displayName,
				size: bytes.length,
				mimeType: exported.mimeType,
			};
		});
	} catch (error) {
		await Promise.allSettled(savedPaths.map((path) => rm(path, { force: true })));
		throw error;
	}
}
