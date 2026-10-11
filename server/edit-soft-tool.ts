/**
 * edit_soft —— 一个「不严格要求缩进」的独立编辑工具（不覆盖内置 edit）。
 *
 * 背景：内置 `edit` 的 oldText 必须与文件恰好匹配（含缩进/空白）。某些语言
 * （如 JS/JSON）缩进不是语法的一部分，模型给出 oldText 时常常在缩进上与文件
 * 差几个空格/制表符，导致编辑失败。edit_soft 用「逐行核心 = 去掉行首+行尾空白」
 * 做宽松匹配：只要每行的内容一致、缩进不同也能命中。
 *
 * 语义约定：
 * - 先试精确子串匹配（与 edit 相同）。
 * - 精确失败后再按行宽松匹配：oldText 拆成若干行、每行取 trim 后的核心，
 *   在文件里找一段连续行，其核心序列与 oldText 完全一致（仅唯一匹配才写）。
 * - 命中后按「整行替换」写入 newText **原样**（AI 给的缩进就是最终缩进），
 *   只做必要的行尾换行平衡。
 * - 若不支持片段（oldText 不是完整行）会返回错误提示：
 *     • 多行 oldText 跨行但首/尾未对齐行边界 → 直接拒绝（否则会吃掉行首/行尾残留、
 *       写出粘连内容）；
 *     • 宽松阶段整块对不上、且首/尾行只是某行的一部分 → 报「片段」错而非笼统的「找不到」；
 *     • 单行片段（如 `b();`）不改变行结构，仍照旧支持。
 *
 * 开关：设置面板「编辑」页 `editSoftEnabled`（默认关）。关闭时该工具从活跃集移除。
 */
import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { createRemoteSdkOperations } from "./remote-ssh-service.js";
import { isAbsolute, join, resolve as nodeResolve } from "node:path";
import { Type } from "typebox";
import {
	defineTool,
	generateDiffString,
	generateUnifiedPatch,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { pick, type ServerLang } from "./i18n.js";

import { EDIT_SOFT_TOOL_NAME } from "./tool-manager.js";
/** 独立宽松编辑工具名（唯一登记见 tool-manager.ts；此处别名保兼容）。 */
export const SOFT_EDIT_TOOL_NAME = EDIT_SOFT_TOOL_NAME;

const replaceEditSchema = Type.Object(
	{
		oldText: Type.String({
			description:
				"Text to replace. Loose matching: each non-empty line must match by trimmed content, so leading-indentation (spaces/tabs) differences are ignored. " +
				"Prefer whole lines/blocks.",
		}),
		newText: Type.String({
			description: "Replacement text (written verbatim).",
		}),
	},
	{},
);

const editSoftSchema = Type.Object(
	{
		path: Type.String({
			description: "Path of the file to edit (relative or absolute).",
		}),
		edits: Type.Array(replaceEditSchema, {
			description:
				"One or more targeted replacements, matched against the original file (not incrementally); " +
				"do not include overlapping/nested edits.",
		}),
	},
	{},
);

type SingleEditInput = { oldText: string; newText: string };
type EditSoftInput = { path: string; edits: SingleEditInput[] };

function isSingleEditInput(value: unknown): value is SingleEditInput {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const e = value as Record<string, unknown>;
	return typeof e.oldText === "string" && typeof e.newText === "string";
}

/** 兼容几种模型把 edits 传成 JSON 字符串 / 单个对象的写法 + 遗留顶层 oldText/newText。 */
function prepareSoftEditArguments(input: unknown): EditSoftInput {
	if (!input || typeof input !== "object") return input as EditSoftInput;
	const args = input as Record<string, unknown>;
	if (typeof args.edits === "string") {
		try {
			const parsed = JSON.parse(args.edits);
			if (Array.isArray(parsed)) args.edits = parsed;
			else if (isSingleEditInput(parsed)) args.edits = [parsed];
		} catch {
			/* 保留原值，交给校验报错 */
		}
	} else if (isSingleEditInput(args.edits)) {
		args.edits = [args.edits];
	}
	const legacy = args as Record<string, unknown>;
	if (typeof legacy.oldText === "string" && typeof legacy.newText === "string") {
		const edits = Array.isArray(legacy.edits) ? [...(legacy.edits as SingleEditInput[])] : [];
		edits.push({ oldText: legacy.oldText, newText: legacy.newText });
		const { oldText: _o, newText: _n, ...rest } = legacy;
		return { ...rest, edits } as unknown as EditSoftInput;
	}
	return args as unknown as EditSoftInput;
}

// ---------------------------------------------------------------------------
// 轻量 helpers（SDK 未导出，这里按等价语义重现）
// ---------------------------------------------------------------------------

function splitBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

function detectLineEnding(content: string): "\n" | "\r\n" {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1) return "\n";
	if (crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function restoreLineEndings(text: string, ending: "\n" | "\r\n"): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

function normalizeShellPath(p: string): string {
	if (!p.startsWith("/") || p.startsWith("//") || p.includes("\\")) return p;
	const m = p.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
	if (!m) return p;
	return `${m[1].toUpperCase()}:\\${(m[2] ?? "").replaceAll("/", "\\")}`;
}

/** 与 SDK resolveToCwd 等价：处理 ~、@ 前缀、Unicode 空格、Windows shell 路径。 */
function resolveToCwd(filePath: string, cwd: string): string {
	let p = filePath.replace(UNICODE_SPACES, " ");
	if (p.startsWith("@")) p = p.slice(1);
	if (process.platform === "win32") p = normalizeShellPath(p);
	const home = homedir();
	if (p === "~") return home;
	if (p.startsWith("~/")) return join(home, p.slice(2));
	return isAbsolute(p) ? nodeResolve(p) : nodeResolve(cwd, p);
}

/** 按行切开并记录每行的原文偏移（LF 归一化后使用）。end 含该行尾换行（若有）。 */
interface LineUnit {
	raw: string;
	newline: "\n" | "";
	start: number;
	end: number;
	core: string;
}

function splitLineUnits(text: string): LineUnit[] {
	const units: LineUnit[] = [];
	const re = /[^\n]*\n|[^\n]+/g;
	let offset = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		const chunk = m[0];
		const newline = chunk.endsWith("\n") ? "\n" : "";
		const raw = newline ? chunk.slice(0, -1) : chunk;
		units.push({ raw, newline, start: offset, end: offset + chunk.length, core: raw.trim() });
		offset += chunk.length;
	}
	return units;
}

/** oldText 拆成「各行核心」：去掉尾部空行（模型常带尾 \n），每行取 trim。 */
export function oldTextCores(oldTextLF: string): string[] {
	const parts = oldTextLF.split("\n");
	if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
	return parts.map((p) => p.trim());
}

/**
 * 判断 oldText 的首行/末行是否只是「片段」（某文件行的一部分）。
 * 宽松匹配要求每行都是完整行；当整块对不上时，若首/末行的核心确实出现在文件的
 * **行中部**（既不在行首也不在行尾），则极可能是模型漏抄了行首/行尾。
 *
 * 仅在「整块核心序列一次都没命中」后才调用，因此只作诊断，不影响正常匹配。
 */
export function fragmentLineEnds(cores: string[], units: LineUnit[]): number[] {
	const isMidLineFragment = (core: string): boolean => {
		if (core === "") return false;
		// 先看有没有任意一行与它整行相同：有 → 不是片段（只是缩进/上下文不对）。
		if (units.some((u) => u.core === core)) return false;
		// 再看它是否出现在某行的中部（前后都还有内容）→ 是片段。
		return units.some((u) => {
			const idx = u.raw.indexOf(core);
			return idx > 0 && idx + core.length < u.raw.length;
		});
	};
	const ends: number[] = [];
	if (cores.length > 0 && isMidLineFragment(cores[0])) ends.push(0);
	if (cores.length > 1 && isMidLineFragment(cores[cores.length - 1])) ends.push(1);
	return ends;
}

/**
 * 判断一段**精确命中**是否为「跨行但未对齐整行」的非法片段。
 *
 * 只包含单行的 oldText（如 `const x = 1;  `）是安全的：替换不会改动行结构。
 * 但若 oldText 跨越了换行、且首/尾没落在行边界（既不在行首/行尾，也没包含整行），
 * 直接子串替换会吃掉行首/行尾的残留，写出粘连内容——例如在
 * `foo(a);\nfoo(b);` 上把 `a);\nfoo(` 换成 `z();` 会得到 `foo(z();b);`。
 * 这几乎总是模型漏抄行首/行尾所致，因此报错而不静默写坏。
 */
export function isMisalignedMultilineFragment(content: string, start: number, oldTextLF: string): boolean {
	if (!oldTextLF.includes("\n")) return false; // 单行片段：不影响行结构，允许
	const end = start + oldTextLF.length;
	const startsAtLineStart = start === 0 || content[start - 1] === "\n";
	const endsAtLineBoundary = end === content.length || content[end] === "\n" || content[end - 1] === "\n";
	return !(startsAtLineStart && endsAtLineBoundary);
}

interface Replacement {
	start: number;
	end: number;
	insertText: string;
}

/** NOT_FOUND / NOT_UNIQUE 用异常类型区分（与内置 edit 报错风格一致）。 */
class SoftEditMatchError extends Error {
	constructor(message: string) {
		super(message);
	}
}

/**
 * 命中一个 edit：先精确，后行核心宽松。返回原文件字符区间 + 待写入文本。
 * spans 全部相对 LF 归一化后的原文件正文。
 */
function locateReplacement(
	normalizedContent: string,
	oldTextLF: string,
	newTextLF: string,
	path: string,
	editIndex: number,
	lang: ServerLang = "en",
): Replacement {
	if (oldTextLF.length === 0) {
		throw new SoftEditMatchError(
			pick(
				lang,
				`edits[${editIndex}].oldText 在 ${path} 中不能为空。`,
				`edits[${editIndex}].oldText must not be empty in ${path}.`,
				"editsoft.oldtext.empty",
				{ editIndex, path },
			),
		);
	}

	// 1) 精确子串匹配（等价普通 edit，支持片段）
	const exactIdx = normalizedContent.indexOf(oldTextLF);
	// 非法片段防御：多行 oldText 若未对齐整行边界，精确子串替换会吃掉行首/行尾
	// 残留、写出粘连内容（如 `foo(a);\nfoo(b);` 把 `a);\nfoo(` 换成 `z();` →
	// `foo(z();b);`）。这种命中一律不走精确路径，改为交给下面的「整行宽松匹配」；
	// 只有当整行也匹配不上时才报错拒绝（避免误伤「首行省略缩进」等合法情况）。
	const exactMisaligned = exactIdx !== -1 && isMisalignedMultilineFragment(normalizedContent, exactIdx, oldTextLF);
	if (exactIdx !== -1 && !exactMisaligned) {
		// 唯一性：精确匹配出现多次 → 报错（模型应提供更多上下文）
		const occurrences = normalizedContent.split(oldTextLF).length - 1;
		if (occurrences > 1) {
			throw new SoftEditMatchError(
				pick(
					lang,
					`在 ${path} 中找到 ${occurrences} 处 edits[${editIndex}].oldText。每个 oldText 必须唯一，请提供更多上下文。`,
					`Found ${occurrences} occurrences of edits[${editIndex}].oldText in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
					"editsoft.exact.not.unique",
					{ path, occurrences, editIndex },
				),
			);
		}
		return { start: exactIdx, end: exactIdx + oldTextLF.length, insertText: newTextLF };
	}

	// 2) 行核心宽松匹配：逐行 trim 后序列一致（忽略缩进差异）
	const cores = oldTextCores(oldTextLF);
	if (cores.length === 0) {
		throw new SoftEditMatchError(
			pick(
				lang,
				`edits[${editIndex}].oldText 在 ${path} 中实际为空。`,
				`edits[${editIndex}].oldText is effectively empty in ${path}.`,
				"editsoft.oldtext.blank",
				{ editIndex, path },
			),
		);
	}
	const units = splitLineUnits(normalizedContent);
	const k = cores.length;
	const starts: number[] = [];
	for (let i = 0; i + k <= units.length; i++) {
		let ok = true;
		for (let j = 0; j < k; j++) {
			if (units[i + j].core !== cores[j]) {
				ok = false;
				break;
			}
		}
		if (ok) starts.push(i);
	}
	if (starts.length === 0) {
		// 非法片段诊断：宽松匹配要求 oldText 的每一行都是**完整行**。若首/尾行只是
		// 某文件行的一部分（模型漏抄了行首/行尾，例如只给了 `a);` 而非 `foo(a);`），
		// 逐行核心永远对不上；这里给出针对性提示，而不是笼统的「找不到」。
		// exactMisaligned 说明精确子串能命中、但跨行且未对齐整行（会写出粘连内容），
		// 而整行匹配又对不上 —— 这种命中绝对不能走精确路径。
		if (exactMisaligned || fragmentLineEnds(cores, units).length > 0) {
			throw new SoftEditMatchError(
				pick(
					lang,
					`在 ${path} 中找不到该文本：edits[${editIndex}].oldText 跨越多行但首/尾没有落在行边界上（首行或末行只是文件中某行的一部分），而本工具按**整行**匹配。请让 oldText 的每一行都是完整行——行首缩进可以省略，但行内容必须完整。`,
					`Could not find the text in ${path}: edits[${editIndex}].oldText spans multiple lines but its start/end do not fall on line boundaries (its first or last line is only part of a file line), and this tool matches whole lines. Make every line of oldText a complete line — leading indentation may be omitted, but the line content must be complete.`,
					"editsoft.fragment.not.supported",
					{ path, editIndex },
				),
			);
		}
		throw new SoftEditMatchError(
			pick(
				lang,
				`在 ${path} 中找不到该文本（精确或忽略缩进均未命中）。oldText 必须与文件的行内容一致；行首空白差异会被忽略，但实际内容必须完全相同。`,
				`Could not find the text (exact or indentation-insensitive) in ${path}. The oldText must match the file's line content; leading-whitespace differences are ignored, but the actual content must be identical.`,
				"editsoft.match.not.found",
				{ path },
			),
		);
	}
	if (starts.length > 1) {
		throw new SoftEditMatchError(
			pick(
				lang,
				`在 ${path} 中找到 ${starts.length} 处忽略缩进的 edits[${editIndex}].oldText。文本必须唯一，请提供更多上下文。`,
				`Found ${starts.length} indentation-insensitive occurrences of edits[${editIndex}].oldText in ${path}. The text must be unique. Please provide more context to make it unique.`,
				"editsoft.match.not.unique",
				{ path, "starts.length": starts.length, editIndex },
			),
		);
	}
	const li = starts[0];
	const ri = li + k;
	const spanStart = units[li].start;
	const spanEnd = units[ri - 1].end;
	// 行尾换行平衡：若最后一行原本带 \n 而 newText 没带，补一个，避免与下一行粘连。
	const lastNewline = units[ri - 1].newline;
	let insertText = newTextLF;
	if (lastNewline === "\n" && !insertText.endsWith("\n")) insertText += "\n";
	return { start: spanStart, end: spanEnd, insertText };
}

/** 对 LF 归一化内容应用一组 edit（含重叠检测），返回 {base,next}。 */
export function applySoftEdits(
	normalizedContent: string,
	edits: SingleEditInput[],
	path: string,
	lang: ServerLang = "en",
): { baseContent: string; newContent: string } {
	const replacements: Replacement[] = [];
	for (let i = 0; i < edits.length; i++) {
		const oldTextLF = normalizeToLF(edits[i].oldText);
		const newTextLF = normalizeToLF(edits[i].newText);
		replacements.push(locateReplacement(normalizedContent, oldTextLF, newTextLF, path, i, lang));
	}
	// 重叠检测
	const sorted = [...replacements].sort((a, b) => a.start - b.start);
	for (let i = 1; i < sorted.length; i++) {
		if (sorted[i - 1].end > sorted[i].start) {
			throw new SoftEditMatchError(
				pick(
					lang,
					`在 ${path} 中的 edits 重叠。请合并为一个 edit 或定位到不相交的区域。`,
					`edits overlap in ${path}. Merge them into one edit or target disjoint regions.`,
					"editsoft.edits.overlap",
					{ path },
				),
			);
		}
	}
	// 逆序应用，保持左侧偏移稳定。
	// 关键：必须按**位置升序**（前面的 `sorted`）再逆序应用，不能按 edits 的传入
	// 顺序逆序——模型若把靠后的 edit 写在前面，未排序的逆序应用会让后面的替换先
	// 改变长度，前面的偏移随即串位，写出错乱内容（历史 bug：protocol.ts /
	// use-chat.ts / ChatInput.tsx 被写坏）。内置 edit 同样先按 matchIndex 排序，此为对齐语义。
	let result = normalizedContent;
	for (let i = sorted.length - 1; i >= 0; i--) {
		const r = sorted[i];
		result = result.slice(0, r.start) + r.insertText + result.slice(r.end);
	}
	if (result === normalizedContent) {
		throw new SoftEditMatchError(
			pick(
				lang,
				`${path} 没有变化。替换产生了完全相同的内容。`,
				`No changes made to ${path}. The replacement produced identical content.`,
				"editsoft.result.identical",
				{ path },
			),
		);
	}
	return { baseContent: normalizedContent, newContent: result };
}

/**
 * 生成 edit_soft 工具定义。与内置 edit 同结构执行体，但用宽松缩进匹配 + 原样 newText。
 * cwd 仅供创建时固定；执行时优先 ctx.cwd（会话工作区）。
 * getLang 为可选的服务端语言取值器（每次调用时读取，默认英文，issue #91）。
 */
export function makeEditSoftTool(fallbackCwd: string, getLang?: () => ServerLang) {
	return defineTool({
		name: SOFT_EDIT_TOOL_NAME,
		label: "Edit (indentation-insensitive)",
		description:
			"Edit a single file with text replacement tolerant of indentation: oldText matches by trimmed line content, " +
			"so leading-whitespace drift (common in JS/JSON) does not fail the edit.",
		promptSnippet: "edit a file when whitespace/indentation makes the built-in edit fail",
		promptGuidelines: [
			"Use edit_soft when edit rejects oldText on an indentation/spacing mismatch",
			"Keep edits[].oldText as small as possible while still being unique; merge nearby changes into one edit",
		],
		parameters: editSoftSchema,
		prepareArguments: prepareSoftEditArguments,
		async execute(_toolCallId, input, signal, _onUpdate, ctx) {
			const lang = getLang?.() ?? "en";
			const { path, edits } = input as unknown as EditSoftInput;
			if (!Array.isArray(edits) || edits.length === 0) {
				throw new Error(
					pick(
						lang,
						"edit_soft 输入无效：edits 必须包含至少一个替换。",
						"edit_soft input is invalid. edits must contain at least one replacement.",
						"editsoft.input.no.edits",
					),
				);
			}
			const cwd = typeof ctx?.cwd === "string" ? ctx.cwd : fallbackCwd;
			const absolutePath = resolveToCwd(path, cwd);
			const remoteOps = createRemoteSdkOperations(cwd);

			return withFileMutationQueue(absolutePath, async () => {
				const throwIfAborted = () => {
					if (signal?.aborted)
						throw new Error(pick(lang, "操作已中止", "Operation aborted", "editsoft.operation.aborted"));
				};

				throwIfAborted();
				try {
					if (remoteOps) {
						await remoteOps.edit.access(absolutePath);
					} else {
						await access(absolutePath, constants.R_OK | constants.W_OK);
					}
				} catch (error: unknown) {
					throwIfAborted();
					const errorMessage = error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
					throw new Error(
						pick(
							lang,
							`无法编辑文件：${path}。${errorMessage}。`,
							`Could not edit file: ${path}. ${errorMessage}.`,
							"editsoft.file.access.failed",
							{ path, errorMessage },
						),
					);
				}
				throwIfAborted();

				const buffer = remoteOps ? await remoteOps.edit.readFile(absolutePath) : await readFile(absolutePath);
				const rawContent = buffer.toString("utf-8");
				throwIfAborted();

				const { bom, text: content } = splitBom(rawContent);
				const originalEnding = detectLineEnding(content);
				const normalizedContent = normalizeToLF(content);
				const { baseContent, newContent } = applySoftEdits(normalizedContent, edits, path, lang);
				throwIfAborted();

				const finalContent = bom + restoreLineEndings(newContent, originalEnding);
				if (remoteOps) {
					await remoteOps.edit.writeFile(absolutePath, finalContent);
				} else {
					await writeFile(absolutePath, finalContent, "utf-8");
				}
				throwIfAborted();

				const diffResult = generateDiffString(baseContent, newContent);
				const patch = generateUnifiedPatch(path, baseContent, newContent);
				return {
					content: [
						{
							type: "text",
							text: pick(
								lang,
								`已在 ${path} 中替换 ${edits.length} 个块（忽略缩进匹配）。`,
								`Successfully replaced ${edits.length} block(s) in ${path} (indentation-insensitive).`,
								"editsoft.replace.done",
								{ path, "edits.length": edits.length },
							),
						},
					],
					details: { diff: diffResult.diff, patch, firstChangedLine: diffResult.firstChangedLine },
				};
			});
		},
	});
}
