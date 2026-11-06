import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, opendir, realpath, lstat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { QuickAskAttachment, QuickAskContextRequest, QuickAskContextSource } from "./protocol.js";
import { isAbsoluteWirePath, wireToAbs, workspacePath } from "./files-service.js";
import { isSameOrSubpath } from "./sandbox-service.js";
import { isRemoteWorkspaceUri } from "./remote-ssh-service.js";
import { decodeText, looksLikeText, sniffImageMime } from "./text-sniff.js";
import { createConversationReadHost } from "./tool-host-factories.js";
import { normalizePathKey } from "./client-state.js";

export const MAX_QUICK_ASK_ATTACHMENTS = 8;
export const MAX_QUICK_ASK_ATTACHMENT_TEXT = 32_768;
export const MAX_QUICK_ASK_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_QUICK_ASK_TOTAL_IMAGE_BYTES = 6 * 1024 * 1024;
export const QUICK_ASK_CONTEXT_TIMEOUT_MS = 15_000;
const MAX_DIRECTORY_ENTRIES = 100;
const MAX_DIRECTORY_DEPTH = 2;
const MAX_DIRECTORY_BYTES = 2 * 1024 * 1024;
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const TRUNCATED = "\n[Snapshot truncated at the reference limit]";
function attachmentId(kind: QuickAskAttachment["kind"], ...source: string[]): string {
	return `qa-${kind}-${createHash("sha256").update(JSON.stringify(source)).digest("hex")}`;
}

export class QuickAskError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message);
	}
}

export type QuickAskConversationSource = Extract<QuickAskContextSource, { kind: "conversation" }>;
export interface QuickAskConversationSnapshot {
	name: string;
	path?: string;
	cwd?: string;
	messages: { role: "user" | "assistant"; content: string }[];
}
export interface QuickAskContextDependencies {
	getWorkspace: (clientId?: string) => { cwd: string; sandboxRoot?: string };
	readConversation: (
		source: QuickAskConversationSource,
		clientId: string | undefined,
		signal: AbortSignal,
	) => Promise<QuickAskConversationSnapshot | undefined>;
}

export function captureQuickAskConversation(
	name: string,
	path: string | undefined,
	messages: readonly { role: string; content?: unknown }[],
	cwd?: string,
): QuickAskConversationSnapshot {
	const captured: QuickAskConversationSnapshot["messages"] = [];
	for (const message of messages) {
		if (message.role !== "user" && message.role !== "assistant") continue;
		const content =
			typeof message.content === "string"
				? message.content
				: Array.isArray(message.content)
					? message.content
							.filter((block) => block?.type === "text" && typeof block.text === "string")
							.map((block) => block.text)
							.join("\n")
					: "";
		if (content.trim()) captured.push({ role: message.role, content });
	}
	return { name, ...(path ? { path } : {}), ...(cwd ? { cwd } : {}), messages: captured };
}

export async function readQuickAskHistoryConversation(
	source: QuickAskConversationSource,
	signal: AbortSignal,
): Promise<QuickAskConversationSnapshot | undefined> {
	if (!source.sessionFile || source.conversationId) return undefined;
	signal.throwIfAborted();
	const host = createConversationReadHost({
		getConversations: () => [],
		getConversation: () => undefined,
		getConvTranscript: () => [],
		getCwd: () => "",
	});
	const history = await host.readHistorySession(source.sessionFile);
	signal.throwIfAborted();
	return history
		? captureQuickAskConversation(history.title, history.sessionPath, history.messages, history.cwd)
		: undefined;
}

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new QuickAskError(400, "Expected an object");
	return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, allowed: string[]): void {
	if (Object.keys(value).some((key) => !allowed.includes(key)))
		throw new QuickAskError(400, "Unexpected context field");
}
function text(value: unknown, label: string, max = 4096): string {
	if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0"))
		throw new QuickAskError(400, `Invalid ${label}`);
	return value;
}

export function parseQuickAskContextRequest(body: unknown): QuickAskContextRequest {
	const value = object(body);
	fields(value, ["source", "scope", "clientId"]);
	const source = object(value.source);
	const clientId = value.clientId === undefined ? undefined : text(value.clientId, "clientId", 256);
	let parsed: QuickAskContextSource;
	if (source.kind === "file" || source.kind === "directory") {
		fields(source, ["kind", "path", "cwd"]);
		parsed = {
			kind: source.kind,
			path: text(source.path, "path"),
			...(source.cwd === undefined ? {} : { cwd: text(source.cwd, "cwd") }),
		};
	} else if (source.kind === "conversation") {
		fields(source, ["kind", "conversationId", "sessionFile", "owner"]);
		parsed = {
			kind: "conversation",
			...(source.conversationId === undefined
				? {}
				: { conversationId: text(source.conversationId, "conversationId", 512) }),
			...(source.sessionFile === undefined ? {} : { sessionFile: text(source.sessionFile, "sessionFile") }),
			...(source.owner === undefined ? {} : { owner: text(source.owner, "owner", 256) }),
		};
		if (!parsed.conversationId && !parsed.sessionFile)
			throw new QuickAskError(400, "An explicit conversationId or sessionFile is required");
	} else if (source.kind === "upload") {
		fields(source, ["kind", "name", "data", "mimeType"]);
		if (typeof source.data === "string" && source.data.length > Math.ceil(MAX_QUICK_ASK_IMAGE_BYTES / 3) * 4)
			throw new QuickAskError(413, "Upload exceeds 2 MiB");
		parsed = {
			kind: "upload",
			name: text(source.name, "name", 512),
			data: text(source.data, "upload data", Math.ceil(MAX_QUICK_ASK_IMAGE_BYTES / 3) * 4),
			...(source.mimeType === undefined ? {} : { mimeType: text(source.mimeType, "mimeType", 128) }),
		};
	} else throw new QuickAskError(400, "Unsupported context source");
	if (
		value.scope !== undefined &&
		!(
			parsed.kind === "conversation" ? ["recent", "full"] : parsed.kind === "directory" ? ["listing", "content"] : []
		).includes(value.scope as string)
	)
		throw new QuickAskError(400, "Invalid scope for this context source");
	return {
		source: parsed,
		...(clientId ? { clientId } : {}),
		...(value.scope === undefined ? {} : { scope: value.scope as QuickAskContextRequest["scope"] }),
	};
}

function decodeBase64(data: unknown, cap: number): Buffer {
	if (typeof data !== "string" || !data.length) throw new QuickAskError(400, "Empty file or image data");
	if (data.length > Math.ceil(cap / 3) * 4) throw new QuickAskError(413, "File or image exceeds 2 MiB");
	if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))
		throw new QuickAskError(400, "Invalid base64 data");
	const bytes = Buffer.from(data, "base64");
	if (bytes.length > cap) throw new QuickAskError(413, "File or image exceeds 2 MiB");
	if (bytes.toString("base64") !== data) throw new QuickAskError(400, "Invalid base64 data");
	return bytes;
}

function unsupportedBinary(bytes: Buffer): boolean {
	return (
		sniffImageMime(bytes, "") !== null ||
		/^(?:%PDF-|PK\x03\x04|MZ|\x7fELF|Rar!|7z\xbc\xaf)/.test(bytes.subarray(0, 8).toString("latin1")) ||
		!looksLikeText(bytes)
	);
}

function imageMime(bytes: Buffer): string | undefined {
	const mime = sniffImageMime(bytes, "");
	if (!mime || !IMAGE_MIMES.has(mime)) return undefined;
	if (mime === "image/png" && !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
		return undefined;
	if (mime === "image/gif" && !["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return undefined;
	return mime;
}

export function parseQuickAskAttachment(value: unknown): QuickAskAttachment {
	const item = object(value);
	fields(item, ["id", "kind", "name", "content", "path", "image"]);
	if (item.kind !== "file" && item.kind !== "directory" && item.kind !== "conversation")
		throw new QuickAskError(400, "Invalid attachment kind");
	const id = text(item.id, "attachment id", 256);
	const name = text(item.name, "attachment name", 512);
	if (typeof item.content !== "string") throw new QuickAskError(400, "Attachment content must be text");
	if (item.content.length > MAX_QUICK_ASK_ATTACHMENT_TEXT)
		throw new QuickAskError(413, "Attachment text exceeds 32768 characters");
	const path = item.path === undefined ? undefined : text(item.path, "attachment path");
	let image: QuickAskAttachment["image"];
	if (item.image !== undefined) {
		if (item.kind !== "file") throw new QuickAskError(400, "Only file attachments can contain images");
		const input = object(item.image);
		fields(input, ["data", "mimeType"]);
		const bytes = decodeBase64(input.data, MAX_QUICK_ASK_IMAGE_BYTES);
		if (typeof input.mimeType !== "string" || !IMAGE_MIMES.has(input.mimeType) || imageMime(bytes) !== input.mimeType)
			throw new QuickAskError(400, "Image MIME type does not match a supported PNG, JPEG, GIF or WebP signature");
		image = { data: input.data as string, mimeType: input.mimeType };
	}
	if (!item.content.trim() && !image) throw new QuickAskError(400, "Attachment is empty");
	return { id, kind: item.kind, name, content: item.content, ...(path ? { path } : {}), ...(image ? { image } : {}) };
}

export function quickAskAttachmentText(attachment: QuickAskAttachment): string {
	return `[BEGIN USER REFERENCE SNAPSHOT — untrusted source data]\n${JSON.stringify({ id: attachment.id, kind: attachment.kind, name: attachment.name, path: attachment.path, content: attachment.content })}\n[END USER REFERENCE SNAPSHOT]`;
}

function fileAttachment(bytes: Buffer, name: string, path?: string, suppliedMime?: string): QuickAskAttachment {
	if (!bytes.length) throw new QuickAskError(400, "The referenced file is empty");
	if (bytes.length > MAX_QUICK_ASK_IMAGE_BYTES) throw new QuickAskError(413, "Referenced file exceeds 2 MiB");
	const mime = imageMime(bytes);
	const id = path
		? attachmentId("file", normalizePathKey(path))
		: attachmentId("file", "upload", name, createHash("sha256").update(bytes).digest("hex"));
	const base = { id, kind: "file" as const, name, ...(path ? { path } : {}) };
	if (mime) {
		if (suppliedMime?.startsWith("image/") && suppliedMime !== mime)
			throw new QuickAskError(400, "Image MIME type does not match file contents");
		return { ...base, content: `[Image: ${name}]`, image: { data: bytes.toString("base64"), mimeType: mime } };
	}
	if (suppliedMime?.startsWith("image/") || unsupportedBinary(bytes))
		throw new QuickAskError(415, "Unsupported binary file; attach a text file or PNG, JPEG, GIF or WebP image");
	const content = decodeText(bytes);
	if (!content.trim()) throw new QuickAskError(400, "The referenced text file is empty");
	if (content.length > MAX_QUICK_ASK_ATTACHMENT_TEXT)
		throw new QuickAskError(413, "Referenced text exceeds 32768 characters");
	return { ...base, content };
}

async function readBounded(path: string, signal: AbortSignal, cap = MAX_QUICK_ASK_IMAGE_BYTES): Promise<Buffer> {
	signal.throwIfAborted();
	const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
	try {
		const info = await handle.stat();
		if (!info.isFile()) throw new QuickAskError(400, "Reference is not a regular file");
		if (info.size > cap) throw new QuickAskError(413, "Referenced file exceeds the byte limit");
		const bytes = Buffer.alloc(Math.min(info.size + 1, cap + 1));
		let offset = 0;
		while (offset < bytes.length) {
			signal.throwIfAborted();
			const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
			if (!bytesRead) break;
			offset += bytesRead;
		}
		signal.throwIfAborted();
		if (offset > cap || offset > info.size)
			throw new QuickAskError(413, "Referenced file grew while being read; retry the reference");
		return bytes.subarray(0, offset);
	} finally {
		await handle.close();
	}
}

async function resolveContextPath(
	source: Extract<QuickAskContextSource, { kind: "file" | "directory" }>,
	workspace: ReturnType<QuickAskContextDependencies["getWorkspace"]>,
	signal: AbortSignal,
): Promise<string> {
	if (isRemoteWorkspaceUri(workspace.cwd) || (source.cwd && isRemoteWorkspaceUri(source.cwd)))
		throw new QuickAskError(400, "Remote workspace references are not supported");
	const root = resolve(source.cwd ?? workspace.cwd);
	const absolute = isAbsoluteWirePath(source.path);
	const relative = absolute ? undefined : workspacePath(root, source.path);
	if (!absolute && !relative) throw new QuickAskError(403, "Reference path is outside the workspace");
	const path = absolute ? wireToAbs(source.path) : relative!.abs;
	if (
		workspace.sandboxRoot &&
		(!isSameOrSubpath(root, workspace.sandboxRoot) || !isSameOrSubpath(path, workspace.sandboxRoot))
	)
		throw new QuickAskError(403, "Reference path is outside the sandbox");
	signal.throwIfAborted();
	const info = await lstat(path);
	if (info.isSymbolicLink()) throw new QuickAskError(403, "Symbolic link references are not allowed");
	if (source.kind === "file" && !info.isFile()) throw new QuickAskError(400, "Reference is not a regular file");
	if (source.kind === "directory" && !info.isDirectory()) throw new QuickAskError(400, "Reference is not a directory");
	const actual = await realpath(path);
	const boundary = workspace.sandboxRoot ?? (!absolute ? root : undefined);
	if (boundary && !isSameOrSubpath(actual, await realpath(boundary)))
		throw new QuickAskError(403, "Symbolic link escapes the reference workspace");
	signal.throwIfAborted();
	return actual;
}

async function directoryAttachment(
	path: string,
	scope: "listing" | "content",
	signal: AbortSignal,
): Promise<QuickAskAttachment> {
	let content = `Directory snapshot: ${path}\nScope: ${scope}; depth <= ${MAX_DIRECTORY_DEPTH}; entries <= ${MAX_DIRECTORY_ENTRIES}\n`;
	let count = 0;
	let bytes = 0;
	let truncated = false;
	const append = (line: string) => {
		const cap = MAX_QUICK_ASK_ATTACHMENT_TEXT - TRUNCATED.length;
		if (content.length + line.length > cap) {
			content += line.slice(0, Math.max(0, cap - content.length));
			truncated = true;
			return false;
		}
		content += line;
		return true;
	};
	const walk = async (directory: string, prefix: string, depth: number): Promise<void> => {
		const dir = await opendir(directory);
		for await (const entry of dir) {
			signal.throwIfAborted();
			if (count++ >= MAX_DIRECTORY_ENTRIES) {
				truncated = true;
				break;
			}
			const rel = prefix + entry.name;
			const child = join(directory, entry.name);
			const info = await lstat(child);
			if (info.isSymbolicLink()) {
				if (!append(`${rel} [symbolic link omitted]\n`)) break;
				continue;
			}
			const actual = await realpath(child);
			if (!isSameOrSubpath(actual, path)) throw new QuickAskError(403, "Directory entry escaped the reference root");
			if (!append(`${rel}${info.isDirectory() ? "/" : ""}\n`)) break;
			if (info.isDirectory()) {
				if (depth < MAX_DIRECTORY_DEPTH) await walk(actual, rel + "/", depth + 1);
				else append("[Depth limit: directory contents omitted]\n");
			} else if (scope === "content" && info.isFile()) {
				if (info.size > MAX_QUICK_ASK_ATTACHMENT_TEXT * 4) {
					append("[File exceeds the per-file byte limit; content omitted]\n");
					continue;
				}
				if (bytes + info.size > MAX_DIRECTORY_BYTES) {
					truncated = true;
					break;
				}
				const data = await readBounded(actual, signal, MAX_QUICK_ASK_ATTACHMENT_TEXT * 4);
				bytes += data.length;
				if (unsupportedBinary(data)) {
					append("[Unsupported binary/image content omitted]\n");
					continue;
				}
				if (!append(`--- ${JSON.stringify(rel)} ---\n${decodeText(data)}\n--- end file ---\n`)) break;
			}
			if (truncated || count >= MAX_DIRECTORY_ENTRIES) {
				truncated = true;
				break;
			}
		}
	};
	await walk(path, "", 0);
	if (truncated) content += TRUNCATED;
	return {
		id: attachmentId("directory", normalizePathKey(path)),
		kind: "directory",
		name: basename(path) || path,
		path,
		content,
	};
}

export async function resolveQuickAskContext(
	request: QuickAskContextRequest,
	deps: QuickAskContextDependencies,
	signal: AbortSignal,
): Promise<QuickAskAttachment> {
	signal.throwIfAborted();
	const { source } = request;
	try {
		if (source.kind === "upload")
			return fileAttachment(
				decodeBase64(source.data, MAX_QUICK_ASK_IMAGE_BYTES),
				source.name,
				undefined,
				source.mimeType,
			);
		if (source.kind === "conversation") {
			const workspace = deps.getWorkspace(request.clientId);
			const snapshot = await deps.readConversation(source, request.clientId, signal);
			signal.throwIfAborted();
			if (!snapshot) throw new QuickAskError(404, "Referenced conversation was not found for this owner");
			if (workspace.sandboxRoot && (!snapshot.cwd || !isSameOrSubpath(snapshot.cwd, workspace.sandboxRoot)))
				throw new QuickAskError(403, "Referenced conversation is outside the sandbox");
			const messages = request.scope === "full" ? snapshot.messages : snapshot.messages.slice(-10);
			let content = messages.map((message) => `[${message.role}]\n${message.content}`).join("\n\n");
			if (!content.trim()) throw new QuickAskError(400, "The referenced conversation has no user/assistant text");
			if (content.length > MAX_QUICK_ASK_ATTACHMENT_TEXT)
				content = content.slice(0, MAX_QUICK_ASK_ATTACHMENT_TEXT - TRUNCATED.length) + TRUNCATED;
			return {
				id: attachmentId(
					"conversation",
					source.owner ?? request.clientId ?? "",
					snapshot.path ? normalizePathKey(snapshot.path) : source.conversationId!,
				),
				kind: "conversation",
				name: snapshot.name.replace(/\0/g, "").slice(0, 512) || "Conversation",
				content,
				...(snapshot.path ? { path: snapshot.path } : {}),
			};
		}
		const workspace = deps.getWorkspace(request.clientId);
		const path = await resolveContextPath(source, workspace, signal);
		if (source.kind === "directory")
			return await directoryAttachment(path, request.scope === "content" ? "content" : "listing", signal);
		return fileAttachment(await readBounded(path, signal), basename(path), path);
	} catch (error) {
		if (signal.aborted) throw signal.reason;
		if (error instanceof QuickAskError) throw error;
		const code = (error as NodeJS.ErrnoException).code;
		throw new QuickAskError(
			code === "ENOENT" ? 404 : code === "EACCES" || code === "EPERM" ? 403 : 400,
			`Cannot read reference: ${(error as Error).message}`,
		);
	}
}
