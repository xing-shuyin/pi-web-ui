import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve as nodeResolve } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	createEditToolDefinition,
	generateDiffString,
	generateUnifiedPatch,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { pick, type ServerLang } from "./i18n.js";
import { createRemoteSdkOperations } from "./remote-ssh-service.js";
import { EDIT_DESCRIPTION, EDIT_PARAMETERS, EDIT_PROMPT_GUIDELINES, EDIT_PROMPT_SNIPPET } from "./tool-prompts.js";

export type SingleEdit = { oldText: string; newText: string };
export type EditToolInput = { path: string; edits: SingleEdit[]; soft?: boolean };

function isSingleEditInput(value: unknown): value is SingleEdit {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const e = value as Record<string, unknown>;
	return typeof e.oldText === "string" && typeof e.newText === "string";
}

/** Tolerates the argument shapes models emit for edit calls (edits as JSON string / single object / legacy flat pair). */
export function prepareEditArguments(input: unknown): EditToolInput {
	if (!input || typeof input !== "object") return input as EditToolInput;
	const args = input as Record<string, unknown>;
	if (typeof args.edits === "string") {
		try {
			const parsed = JSON.parse(args.edits);
			if (Array.isArray(parsed)) args.edits = parsed;
			else if (isSingleEditInput(parsed)) args.edits = [parsed];
		} catch {}
	} else if (isSingleEditInput(args.edits)) {
		args.edits = [args.edits] as unknown;
	}
	const legacy = args as Record<string, unknown>;
	if (typeof legacy.oldText === "string" && typeof legacy.newText === "string") {
		const edits = Array.isArray(legacy.edits) ? ([...(legacy.edits as SingleEdit[])] as unknown[]) : [];
		edits.push({ oldText: legacy.oldText, newText: legacy.newText });
		const { oldText: _o, newText: _n, ...rest } = legacy;
		return { ...rest, edits } as unknown as EditToolInput;
	}
	return args as unknown as EditToolInput;
}

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

function resolveToCwd(filePath: string, cwd: string): string {
	let p = filePath.replace(UNICODE_SPACES, " ");
	if (p.startsWith("@")) p = p.slice(1);
	if (process.platform === "win32") p = normalizeShellPath(p);
	const home = homedir();
	if (p === "~") return home;
	if (p.startsWith("~/")) return join(home, p.slice(2));
	return isAbsolute(p) ? nodeResolve(p) : nodeResolve(cwd, p);
}

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

export function oldTextCores(oldTextLF: string): string[] {
	const parts = oldTextLF.split("\n");
	if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
	return parts.map((p) => p.trim());
}

export function fragmentLineEnds(cores: string[], units: LineUnit[]): number[] {
	const isMidLineFragment = (core: string): boolean => {
		if (core === "") return false;
		if (units.some((u) => u.core === core)) return false;
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

export function isMisalignedMultilineFragment(content: string, start: number, oldTextLF: string): boolean {
	if (!oldTextLF.includes("\n")) return false;
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

class EditMatchError extends Error {
	constructor(message: string) {
		super(message);
	}
}

function locateSoftReplacement(
	normalizedContent: string,
	oldTextLF: string,
	newTextLF: string,
	path: string,
	editIndex: number,
	lang: ServerLang,
): Replacement {
	if (oldTextLF.length === 0) {
		throw new EditMatchError(
			pick(
				lang,
				`edits[${editIndex}].oldText 在 ${path} 中不能为空。`,
				`edits[${editIndex}].oldText must not be empty in ${path}.`,
				"edit.oldtext.empty",
				{ editIndex, path },
			),
		);
	}

	const exactIdx = normalizedContent.indexOf(oldTextLF);
	const exactMisaligned = exactIdx !== -1 && isMisalignedMultilineFragment(normalizedContent, exactIdx, oldTextLF);
	if (exactIdx !== -1 && !exactMisaligned) {
		const occurrences = normalizedContent.split(oldTextLF).length - 1;
		if (occurrences > 1) {
			throw new EditMatchError(
				pick(
					lang,
					`在 ${path} 中找到 ${occurrences} 处 edits[${editIndex}].oldText。每个 oldText 必须唯一，请提供更多上下文。`,
					`Found ${occurrences} occurrences of edits[${editIndex}].oldText in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
					"edit.exact.not.unique",
					{ path, occurrences, editIndex },
				),
			);
		}
		return { start: exactIdx, end: exactIdx + oldTextLF.length, insertText: newTextLF };
	}

	const cores = oldTextCores(oldTextLF);
	if (cores.length === 0) {
		throw new EditMatchError(
			pick(
				lang,
				`edits[${editIndex}].oldText 在 ${path} 中实际为空。`,
				`edits[${editIndex}].oldText is effectively empty in ${path}.`,
				"edit.soft.oldtext.blank",
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
		if (exactMisaligned || fragmentLineEnds(cores, units).length > 0) {
			throw new EditMatchError(
				pick(
					lang,
					`在 ${path} 中找不到该文本：edits[${editIndex}].oldText 跨越多行但首/尾没有落在行边界上（首行或末行只是文件中某行的一部分），而 soft=true 按**整行**匹配。请让 oldText 的每一行都是完整行——行首缩进可以省略，但行内容必须完整。`,
					`Could not find the text in ${path}: edits[${editIndex}].oldText spans multiple lines but its start/end do not fall on line boundaries (its first or last line is only part of a file line), and soft=true matches whole lines. Make every line of oldText a complete line — leading indentation may be omitted, but the line content must be complete.`,
					"edit.soft.fragment.not.supported",
					{ path, editIndex },
				),
			);
		}
		throw new EditMatchError(
			pick(
				lang,
				`在 ${path} 中找不到该文本（精确或忽略缩进均未命中）。oldText 必须与文件的行内容一致；行首空白差异会被忽略，但实际内容必须完全相同。`,
				`Could not find the text (exact or indentation-insensitive) in ${path}. The oldText must match the file's line content; leading-whitespace differences are ignored, but the actual content must be identical.`,
				"edit.soft.match.not.found",
				{ path },
			),
		);
	}
	if (starts.length > 1) {
		throw new EditMatchError(
			pick(
				lang,
				`在 ${path} 中找到 ${starts.length} 处忽略缩进的 edits[${editIndex}].oldText。文本必须唯一，请提供更多上下文。`,
				`Found ${starts.length} indentation-insensitive occurrences of edits[${editIndex}].oldText in ${path}. The text must be unique. Please provide more context to make it unique.`,
				"edit.soft.match.not.unique",
				{ path, "starts.length": starts.length, editIndex },
			),
		);
	}
	const li = starts[0];
	const ri = li + k;
	const spanStart = units[li].start;
	const spanEnd = units[ri - 1].end;
	const lastNewline = units[ri - 1].newline;
	let insertText = newTextLF;
	if (lastNewline === "\n" && !insertText.endsWith("\n")) insertText += "\n";
	return { start: spanStart, end: spanEnd, insertText };
}

/**
 * Indentation-insensitive replacement used by `edit(soft: true)`. Exact substring matches still win,
 * so soft never rewrites a region the built-in edit would have matched literally.
 */
export function applySoftEdits(
	normalizedContent: string,
	edits: SingleEdit[],
	path: string,
	lang: ServerLang = "en",
): { baseContent: string; newContent: string } {
	const replacements: Replacement[] = [];
	for (let i = 0; i < edits.length; i++) {
		const oldTextLF = normalizeToLF(edits[i].oldText);
		const newTextLF = normalizeToLF(edits[i].newText);
		replacements.push(locateSoftReplacement(normalizedContent, oldTextLF, newTextLF, path, i, lang));
	}
	const sorted = [...replacements].sort((a, b) => a.start - b.start);
	for (let i = 1; i < sorted.length; i++) {
		if (sorted[i - 1].end > sorted[i].start) {
			throw new EditMatchError(
				pick(
					lang,
					`在 ${path} 中的 edits 重叠。请合并为一个 edit 或定位到不相交的区域。`,
					`edits overlap in ${path}. Merge them into one edit or target disjoint regions.`,
					"edit.edits.overlap",
					{ path },
				),
			);
		}
	}
	let result = normalizedContent;
	for (let i = sorted.length - 1; i >= 0; i--) {
		const r = sorted[i];
		result = result.slice(0, r.start) + r.insertText + result.slice(r.end);
	}
	if (result === normalizedContent) {
		throw new EditMatchError(
			pick(
				lang,
				`${path} 没有变化。替换产生了完全相同的内容。`,
				`No changes made to ${path}. The replacement produced identical content.`,
				"edit.result.identical",
				{ path },
			),
		);
	}
	return { baseContent: normalizedContent, newContent: result };
}

async function performEdit(
	input: EditToolInput,
	fallbackCwd: string,
	getLang: (() => ServerLang) | undefined,
	signal: AbortSignal | undefined,
): Promise<unknown> {
	const lang = getLang?.() ?? "en";
	const { path, edits } = input;
	if (!Array.isArray(edits) || edits.length === 0) {
		throw new Error(
			pick(
				lang,
				"edit 输入无效：edits 必须包含至少一个替换。",
				"edit input is invalid. edits must contain at least one replacement.",
				"edit.input.no.edits",
			),
		);
	}
	const cwd = fallbackCwd;
	const absolutePath = resolveToCwd(path, cwd);
	const remoteOps = createRemoteSdkOperations(cwd);

	return withFileMutationQueue(absolutePath, async () => {
		const throwIfAborted = () => {
			if (signal?.aborted) throw new Error(pick(lang, "操作已中止", "Operation aborted", "edit.operation.aborted"));
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
					"edit.file.access.failed",
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
						`已在 ${path} 中替换 ${edits.length} 个块（soft：忽略缩进匹配）。`,
						`Successfully replaced ${edits.length} block(s) in ${path} (soft: indentation-insensitive).`,
						"edit.soft.replace.done",
						{ path, "edits.length": edits.length },
					),
				},
			],
			details: { diff: diffResult.diff, patch, firstChangedLine: diffResult.firstChangedLine },
		};
	});
}

/**
 * The single `edit` tool of this host: built-in exact replacement plus the `soft` parameter for
 * indentation-tolerant matching. Replaces the SDK definition by name (see tool-overrides).
 */
export function makeEditToolDefinition(cwd: string, getLang?: () => ServerLang): ToolDefinition {
	const remoteOps = createRemoteSdkOperations(cwd);
	const exactTool = createEditToolDefinition(cwd, remoteOps ? { operations: remoteOps.edit } : undefined);
	return {
		...exactTool,
		description: EDIT_DESCRIPTION,
		promptSnippet: EDIT_PROMPT_SNIPPET,
		promptGuidelines: [...EDIT_PROMPT_GUIDELINES],
		parameters: EDIT_PARAMETERS,
		prepareArguments: prepareEditArguments as never,
		execute: async (
			toolCallId: string,
			input: unknown,
			signal: AbortSignal | undefined,
			onUpdate: ((update: never) => void) | undefined,
			ctx: { cwd?: string } | undefined,
		) => {
			const params = input as unknown as EditToolInput;
			if (params?.soft === true) {
				const toolCwd = typeof ctx?.cwd === "string" && ctx.cwd ? ctx.cwd : cwd;
				return (await performEdit(params, toolCwd, getLang, signal)) as never;
			}
			const exact: Record<string, unknown> = { ...(params as unknown as Record<string, unknown>) };
			delete exact.soft;
			return exactTool.execute(toolCallId, exact as never, signal, onUpdate as never, ctx as never);
		},
	} as unknown as ToolDefinition;
}
