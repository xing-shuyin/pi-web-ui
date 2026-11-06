import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve as nodeResolve } from "node:path";
import {
	createLsToolDefinition,
	createReadToolDefinition,
	defineTool,
	type AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { pick, type ServerLang } from "./i18n.js";
import type { AnyToolDefinition } from "./tool-overrides.js";
import { createRemoteSdkOperations } from "./remote-ssh-service.js";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

export function resolvePathForDirCheck(input: string, cwd: string): string {
	let p = String(input ?? "").replace(UNICODE_SPACES, " ");
	if (p.startsWith("@")) p = p.slice(1);
	if (p === "~") return homedir();
	if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
	return isAbsolute(p) ? p : nodeResolve(cwd, p);
}

export async function isDirectoryPath(absolutePath: string): Promise<boolean> {
	try {
		const st = await stat(absolutePath);
		return st.isDirectory();
	} catch {
		return false;
	}
}

export interface ReadDirToolOptions {
	dirEnabled?: () => boolean;
	getLang?: () => ServerLang;
}

interface ReadDirInput {
	path?: string;
	file_path?: string;
	offset?: number;
	limit?: number;
}

const readDirSchema = Type.Object(
	{
		path: Type.String({
			description: "Path to the file (or directory) to read (relative or absolute)",
		}),
		file_path: Type.Optional(
			Type.String({
				description: "Alias of `path` — some clients/models emit file_path; if both are given, `path` wins",
			}),
		),
		offset: Type.Optional(
			Type.Number({
				description: "Line number to start reading from (1-indexed)",
			}),
		),
		limit: Type.Optional(
			Type.Number({
				description: "Maximum number of lines to read (for a directory path: maximum number of entries)",
			}),
		),
	},
	{},
);

export function prepareReadArguments(raw: unknown): Static<typeof readDirSchema> {
	const args: Record<string, unknown> =
		raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
	const primary = typeof args.path === "string" ? args.path : "";
	const alias = typeof args.file_path === "string" ? args.file_path : "";
	if (!primary.trim() && alias.trim()) args.path = alias;
	return args as unknown as Static<typeof readDirSchema>;
}

const DIR_DESCRIPTION_NOTE =
	"Also accepts a directory path: its entries are listed instead of contents (one per line, directories suffixed with '/'); `limit` then caps entries and `offset` is ignored.";

const FILE_PATH_ALIAS_NOTE = "Also accepts `file_path` as an alias of `path`.";

const DIR_GUIDELINE = "No need to shell out to `ls`: read lists a directory's entries";

async function dirAwareExecute(
	base: AnyToolDefinition,
	ls: AnyToolDefinition,
	fallbackCwd: string,
	dirEnabled: () => boolean,
	getLang: () => ServerLang,
	normalizePath: boolean,
	toolCallId: string,
	params: unknown,
	signal: AbortSignal | undefined,
	onUpdate: unknown,
	ctx: any,
): Promise<AgentToolResult<any>> {
	const input = (params ?? {}) as ReadDirInput;
	const rawPath = typeof input.path === "string" && input.path.trim() ? input.path : input.file_path;
	const path = typeof rawPath === "string" ? rawPath : "";
	if (path && dirEnabled()) {
		const cwd = typeof ctx?.cwd === "string" ? ctx.cwd : fallbackCwd;
		const remoteOps = createRemoteSdkOperations(cwd);
		const isDir = remoteOps
			? await remoteOps.isDirectory(resolvePathForDirCheck(path, cwd))
			: await isDirectoryPath(resolvePathForDirCheck(path, cwd));
		if (isDir) {
			const limit = typeof input.limit === "number" && input.limit > 0 ? Math.floor(input.limit) : undefined;
			const listed = (await ls.execute(
				toolCallId,
				{ path, ...(limit !== undefined ? { limit } : {}) },
				signal,
				onUpdate as never,
				ctx as never,
			)) as AgentToolResult<unknown>;
			const header = pick(getLang(), `[目录：${path}]`, `[Directory: ${path}]`, "read.dir.header", { path });
			const content = listed.content.map((part, index) =>
				index === 0 && part.type === "text" ? { ...part, text: `${header}\n${part.text}` } : part,
			);
			return { content, details: undefined };
		}
	}
	return base.execute(
		toolCallId,
		(normalizePath ? { ...input, path } : params) as never,
		signal,
		onUpdate as never,
		ctx as never,
	);
}

export function withReadDirSupport(
	base: AnyToolDefinition,
	fallbackCwd: string,
	options: ReadDirToolOptions = {},
): AnyToolDefinition {
	const dirEnabled = options.dirEnabled ?? ((): boolean => true);
	const getLang = options.getLang ?? ((): ServerLang => "en");
	const remoteOps = createRemoteSdkOperations(fallbackCwd);
	const ls = createLsToolDefinition(fallbackCwd, remoteOps ? { operations: remoteOps.ls } : undefined);
	return defineTool({
		...base,
		description: `${base.description} ${DIR_DESCRIPTION_NOTE}`,
		promptGuidelines: [...(base.promptGuidelines ?? []), DIR_GUIDELINE],
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return dirAwareExecute(
				base,
				ls,
				fallbackCwd,
				dirEnabled,
				getLang,
				false,
				toolCallId,
				params,
				signal,
				onUpdate,
				ctx,
			);
		},
	}) as AnyToolDefinition;
}

export function makeReadDirTool(fallbackCwd: string, options: ReadDirToolOptions = {}) {
	const remoteOps = createRemoteSdkOperations(fallbackCwd);
	const base = createReadToolDefinition(fallbackCwd, remoteOps ? { operations: remoteOps.read } : undefined);
	const ls = createLsToolDefinition(fallbackCwd, remoteOps ? { operations: remoteOps.ls } : undefined);
	const dirEnabled = options.dirEnabled ?? ((): boolean => true);
	const getLang = options.getLang ?? ((): ServerLang => "en");

	return defineTool({
		...base,
		description: `${base.description} ${FILE_PATH_ALIAS_NOTE} ${DIR_DESCRIPTION_NOTE}`,
		promptSnippet: "file contents by path (a directory lists its entries)",
		promptGuidelines: [...(base.promptGuidelines ?? []), DIR_GUIDELINE],
		parameters: readDirSchema,
		prepareArguments: prepareReadArguments,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return dirAwareExecute(
				base,
				ls,
				fallbackCwd,
				dirEnabled,
				getLang,
				true,
				toolCallId,
				params,
				signal,
				onUpdate,
				ctx,
			);
		},
	});
}
