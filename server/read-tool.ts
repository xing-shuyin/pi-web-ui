/**
 * read-tool.ts —— 覆盖 SDK 内置 read：路径是目录时列出目录条目。
 *
 * 背景：SDK 内置 `read` 只处理文件，`read('server')` 直接抛
 * `EISDIR: illegal operation on a directory, read`；模型想「看一眼这个目录」
 * 只能改用 bash（`ls`）。SDK 自带的 `ls` 工具不在默认活跃集里
 * （默认 `["read","bash","edit","write"]`），模型并不总能想到它。
 *
 * 做法（与 bash 覆盖同一机制）：customTools 按 name 覆盖内置定义 —— 用
 * `createReadToolDefinition(cwd)` 拿原实现当基底，只在「路径确实是目录」时
 * 分流到 `createLsToolDefinition(cwd)`（排序、目录 `/` 后缀、条目/字节截断
 * 与 SDK ls 完全一致）；其余情况（文件、图片、路径不存在、读取报错）原样
 * 转发基底，行为与内置完全一致。
 *
 * 基底也可能是**第三方扩展注册的 read**：`customTools` 恒胜、会把它顶掉（见
 * tool-overrides.ts），所以那种情况下改走 `withReadDirSupport()` —— 把扩展的实现
 * 整个当基底叠目录能力，它的 schema/描述/prompt 指引/渲染原样保留（扩展独有的参数
 * 照旧可用），只有目录分支归 pi-web-ui。
 *
 * 开关：`readDirEnabled`（设置面板「工具」页，默认开）。**行为开关**不是
 * ActiveSet 开关（read 本体不可关，关了 agent 就残了），因此不进
 * tool-manager 的 AGENT_TOOL_CATALOG；每次调用实时读设置，改动即时生效。
 *
 * 文案约定：工具 definition（description/promptSnippet/promptGuidelines）为纯英文；per-call
 * 返回文本（目录头）按 lang 取 pick(lang, zh, en, key)，缺表回落英文内联。
 *
 * DSH 引擎无 customTool 注册面（工具来自 shipped preset），本覆盖只服务 pi 引擎。
 */

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
// 覆盖层要接住任意具体定义（内置的、扩展注册的），只能用 any 参数化的工具定义别名。
import type { AnyToolDefinition } from "./tool-overrides.js";
import { createRemoteSdkOperations } from "./remote-ssh-service.js";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * 目录判定用的路径归一：~ / @ 前缀、Unicode 空格、相对 → 绝对（对齐 SDK
 * resolveToCwd 的主要语义）。这里只是「猜」，猜不中（例如 macOS 截图名的
 * 变体路径）就走内置实现，不会比现状更差。
 */
export function resolvePathForDirCheck(input: string, cwd: string): string {
	let p = String(input ?? "").replace(UNICODE_SPACES, " ");
	if (p.startsWith("@")) p = p.slice(1);
	if (p === "~") return homedir();
	if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
	return isAbsolute(p) ? p : nodeResolve(cwd, p);
}

/** 路径是不是目录（不存在/无权限/非目录一律 false → 交回内置实现）。 */
export async function isDirectoryPath(absolutePath: string): Promise<boolean> {
	try {
		const st = await stat(absolutePath);
		return st.isDirectory();
	} catch {
		return false;
	}
}

export interface ReadDirToolOptions {
	/** 行为开关（每次调用实时读取）：关 → 目录参数原样交回内置 read（报 EISDIR）。 */
	dirEnabled?: () => boolean;
	/** 服务端语言取值器（每次调用时读取，默认英文，issue #91）。 */
	getLang?: () => ServerLang;
}

/** read 的入参（与内置 read schema 一致，外加 path 的别名 file_path）。 */
interface ReadDirInput {
	path?: string;
	/** `path` 的别名：部分模型（Claude 风格）习惯发 file_path。 */
	file_path?: string;
	offset?: number;
	limit?: number;
}

/** 覆盖定义的参数 schema：内置的 path/offset/limit + file_path 别名。 */
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

/**
 * 校验前归一（SDK 的 prepareArguments 在 schema 校验前执行）：只有 file_path 时
 * 把它当 path（path 在 schema 里仍必填），两者都给时以 path 为准。
 */
export function prepareReadArguments(raw: unknown): Static<typeof readDirSchema> {
	const args: Record<string, unknown> =
		raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
	const primary = typeof args.path === "string" ? args.path : "";
	const alias = typeof args.file_path === "string" ? args.file_path : "";
	if (!primary.trim() && alias.trim()) args.path = alias;
	// 两者都没给时这里仍缺 path（静态类型是谎，运行时交给 schema 校验报错）。
	return args as unknown as Static<typeof readDirSchema>;
}

/** Directory support note appended to any read definition (definitions are English-only). */
const DIR_DESCRIPTION_NOTE =
	"Also accepts a directory path: its entries are listed instead of contents (one per line, directories suffixed with '/'); `limit` then caps entries and `offset` is ignored.";

/** 内置基底专用：`file_path` 别名只在没有扩展同名工具时由本模块提供。 */
const FILE_PATH_ALIAS_NOTE = "Also accepts `file_path` as an alias of `path`.";

const DIR_GUIDELINE = "No need to shell out to `ls`: read lists a directory's entries";

/**
 * 两条路（内置基底 / 扩展基底）共用的执行体：先判「路径是不是目录」—— 是就复用 SDK 的
 * ls 列条目（排序/`/` 后缀/截断提示口径一致），否则把请求转发给基底实现。
 *
 * `normalizePath`：只给了 `file_path` 别名时补出 `path` 再转发（SDK 内置实现需要）；
 * 扩展基底传 false —— 它自带 `prepareArguments`，参数原样交给它，免得我们这边把扩展
 * 独有的字段（如 better-edit 的 `windows`）吃掉。
 */
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
	// 兜底（不依赖 prepareArguments 一定跑过）：path 缺省/空时用 file_path。
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
			// 列目录本体完全复用 SDK 的 ls。
			const listed = (await ls.execute(
				toolCallId,
				{ path, ...(limit !== undefined ? { limit } : {}) },
				signal,
				onUpdate as never,
				ctx as never,
			)) as AgentToolResult<unknown>;
			const header = pick(getLang(), `[目录：${path}]`, `[Directory: ${path}]`, "read.dir.header", { path });
			// 只取列出来的正文：截断/条目上限提示已在正文末尾，read 卡片的
			// details 不需要 ls 的字段。
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

/**
 * 在**任意** read 实现（SDK 内置，或第三方扩展 `registerTool` 注册的同名工具）之上叠加
 * 「路径是目录时列出条目」。基底的 name/label/描述/参数 schema/prepareArguments/render*
 * 全部原样保留，只补一句目录说明与一条目录指引 —— 于是扩展的锚协议、独有参数、渲染都不丢。
 */
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

/**
 * 生成「read 读目录」覆盖定义（**没有**扩展同名工具时的完整实现：内置基底 + 英文描述 +
 * `file_path` 别名）。cwd 仅供创建时固定；执行时优先 ctx.cwd（会话工作区）。
 * 有扩展同名工具时改用 `withReadDirSupport` 组合它的实现（见 tool-overrides.ts）。
 */
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
			// 目录分支与转发都在共用执行体里（normalizePath=true：只给了 file_path 时补出 path）。
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
