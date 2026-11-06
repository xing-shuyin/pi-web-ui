import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const HL_HASH_LENGTH = 4;

export function normalizeLineEndings(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function computeFileHash(text: string): string {
	const normalized = normalizeLineEndings(text).replace(/[ \t]+(?=\n|$)/g, "");
	const hash = createHash("sha256").update(normalized, "utf8").digest("hex");
	return hash.slice(0, HL_HASH_LENGTH).toUpperCase();
}

export function formatHashlineHeader(filePath: string, hash: string): string {
	return `[${filePath}#${hash}]`;
}

export function formatNumberedLines(text: string, startLine = 1): string {
	const lines = normalizeLineEndings(text).split("\n");
	return lines.map((l, i) => `${startLine + i}:${l}`).join("\n");
}

export function resolveBlockSpan(
	lines: readonly string[],
	startLine: number,
	filePath = "",
): { start: number; end: number } {
	const n = lines.length;
	const sIdx = Math.max(0, Math.min(n - 1, startLine - 1));
	const startContent = lines[sIdx] ?? "";
	const trimmedStart = startContent.trim();

	const isMd = /\.(md|markdown|mdx)$/i.test(filePath);
	const mdHeaderMatch = trimmedStart.match(/^(#{1,6})\s+/);
	if (isMd && mdHeaderMatch) {
		const level = mdHeaderMatch[1].length;
		let endIdx = sIdx;
		for (let i = sIdx + 1; i < n; i++) {
			const line = lines[i].trim();
			const m = line.match(/^(#{1,6})\s+/);
			if (m && m[1].length <= level) break;
			endIdx = i;
		}
		return { start: sIdx + 1, end: endIdx + 1 };
	}

	const isIndentLang = /\.(py|yaml|yml|makefile|dockerfile)$/i.test(filePath) || !startContent.includes("{");
	if (isIndentLang && (trimmedStart.endsWith(":") || !trimmedStart.includes("{"))) {
		const baseIndent = startContent.match(/^[ \t]*/)?.[0].length ?? 0;
		let endIdx = sIdx;
		for (let i = sIdx + 1; i < n; i++) {
			const line = lines[i];
			if (line.trim().length === 0) {
				continue;
			}
			const curIndent = line.match(/^[ \t]*/)?.[0].length ?? 0;
			if (curIndent <= baseIndent) {
				break;
			}
			endIdx = i;
		}
		return { start: sIdx + 1, end: endIdx + 1 };
	}

	let braceDepth = 0;
	let parenDepth = 0;
	let bracketDepth = 0;
	let seenOpen = false;
	let endIdx = sIdx;

	for (let i = sIdx; i < n; i++) {
		const line = lines[i];
		let inString: string | null = null;
		let escaped = false;

		for (let j = 0; j < line.length; j++) {
			const char = line[j];
			const next = line[j + 1];

			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (inString) {
				if (char === inString) inString = null;
				continue;
			}
			if (char === '"' || char === "'" || char === "`") {
				inString = char;
				continue;
			}
			if (char === "/" && next === "/") break;

			if (char === "{") {
				braceDepth++;
				seenOpen = true;
			} else if (char === "}") {
				braceDepth--;
			} else if (char === "(") {
				parenDepth++;
			} else if (char === ")") {
				parenDepth--;
			} else if (char === "[") {
				bracketDepth++;
			} else if (char === "]") {
				bracketDepth--;
			}
		}

		endIdx = i;
		if (seenOpen && braceDepth <= 0 && parenDepth <= 0 && bracketDepth <= 0) {
			break;
		}
	}

	return { start: sIdx + 1, end: endIdx + 1 };
}

export type HunkOpKind =
	| "put_range"
	| "put_block"
	| "insert_before"
	| "insert_after"
	| "insert_after_block"
	| "cut_range"
	| "cut_block"
	| "paste_at"
	| "paste_over_range"
	| "paste_over_block"
	| "remove_file"
	| "move_file";

export interface Hunk {
	kind: HunkOpKind;
	lineStart?: number;
	lineEnd?: number;
	registerName?: string;
	targetPath?: string;
	bodyLines: string[];
}

export interface PatchSection {
	filePath: string;
	expectedHash?: string;
	hunks: Hunk[];
}

export function parseHashlinePatch(patchText: string): PatchSection[] {
	const lines = normalizeLineEndings(patchText).split("\n");
	const sections: PatchSection[] = [];
	let currentSection: PatchSection | null = null;
	let currentHunk: Hunk | null = null;

	const flushHunk = () => {
		if (currentHunk && currentSection) {
			currentSection.hunks.push(currentHunk);
			currentHunk = null;
		}
	};

	const flushSection = () => {
		flushHunk();
		if (currentSection) {
			sections.push(currentSection);
			currentSection = null;
		}
	};

	for (let i = 0; i < lines.length; i++) {
		const rawLine = lines[i];
		const trimmed = rawLine.trim();

		const secMatch = rawLine.match(/^\s*\[([^#\]]+)(?:#([0-9a-fA-F]{4}))?\]\s*$/);
		if (secMatch) {
			flushSection();
			currentSection = {
				filePath: secMatch[1].trim(),
				expectedHash: secMatch[2] ? secMatch[2].toUpperCase() : undefined,
				hunks: [],
			};
			continue;
		}

		if (!currentSection) {
			continue;
		}

		if (/^REM\b/i.test(trimmed)) {
			flushHunk();
			currentSection.hunks.push({ kind: "remove_file", bodyLines: [] });
			continue;
		}

		const mvMatch = trimmed.match(/^MV\s+([^\s]+)/i);
		if (mvMatch) {
			flushHunk();
			currentSection.hunks.push({ kind: "move_file", targetPath: mvMatch[1], bodyLines: [] });
			continue;
		}

		const cutMatch = trimmed.match(/^CUT\s+(\d+)(?:\.=(\d+)|\*)\s*(?:@([a-zA-Z0-9_-]+))?/);
		if (cutMatch) {
			flushHunk();
			const start = parseInt(cutMatch[1], 10);
			const isBlock = trimmed.includes("*");
			const end = cutMatch[2] ? parseInt(cutMatch[2], 10) : start;
			const reg = cutMatch[3];
			currentSection.hunks.push({
				kind: isBlock ? "cut_block" : "cut_range",
				lineStart: start,
				lineEnd: isBlock ? undefined : end,
				registerName: reg,
				bodyLines: [],
			});
			continue;
		}

		const pasteMatch = trimmed.match(/^PUT\s+(<|>)?(\d+)(?:\.=(\d+)|\*)?\s+@([a-zA-Z0-9_-]+)/);
		if (pasteMatch && !trimmed.endsWith(":")) {
			flushHunk();
			const prefix = pasteMatch[1];
			const num = parseInt(pasteMatch[2], 10);
			const endNum = pasteMatch[3] ? parseInt(pasteMatch[3], 10) : num;
			const isBlock = trimmed.includes("*");
			const reg = pasteMatch[4];
			let kind: HunkOpKind;
			if (prefix === "<") {
				kind = "insert_before";
			} else if (prefix === ">") {
				kind = "insert_after";
			} else if (isBlock) {
				kind = "paste_over_block";
			} else {
				kind = "paste_over_range";
			}
			currentSection.hunks.push({
				kind,
				lineStart: num,
				lineEnd: endNum,
				registerName: reg,
				bodyLines: [],
			});
			continue;
		}

		const putHeaderMatch = trimmed.match(/^PUT\s+(<|>)?(\d+|\$)(?:\.=(\d+)|\*)?:$/);
		if (putHeaderMatch) {
			flushHunk();
			const prefix = putHeaderMatch[1];
			const anchorStr = putHeaderMatch[2];
			const start = anchorStr === "$" ? -1 : parseInt(anchorStr, 10);
			const end = putHeaderMatch[3] ? parseInt(putHeaderMatch[3], 10) : start;
			const isBlock = trimmed.includes("*");

			let kind: HunkOpKind;
			if (prefix === "<") {
				kind = "insert_before";
			} else if (prefix === ">") {
				kind = isBlock ? "insert_after_block" : "insert_after";
			} else if (isBlock) {
				kind = "put_block";
			} else {
				kind = "put_range";
			}

			currentHunk = {
				kind,
				lineStart: start,
				lineEnd: isBlock ? undefined : end,
				bodyLines: [],
			};
			continue;
		}

		if (rawLine.startsWith("+")) {
			if (currentHunk) {
				currentHunk.bodyLines.push(rawLine.slice(1));
			}
			continue;
		}
	}

	flushSection();
	return sections;
}

export class HashlineSnapshotStore {
	private static readonly MAX_PER_FILE = 200;

	private snapshots = new Map<string, Map<string, string>>();

	record(filePath: string, text: string): string {
		const hash = computeFileHash(text);
		let fileMap = this.snapshots.get(filePath);
		if (!fileMap) {
			fileMap = new Map();
			this.snapshots.set(filePath, fileMap);
		}
		fileMap.delete(hash);
		fileMap.set(hash, text);
		while (fileMap.size > HashlineSnapshotStore.MAX_PER_FILE) {
			const oldest = fileMap.keys().next().value;
			if (oldest === undefined) break;
			fileMap.delete(oldest);
		}
		return hash;
	}

	get(filePath: string, hash: string): string | undefined {
		const fileMap = this.snapshots.get(filePath);
		if (!fileMap) return undefined;
		const key = hash.toUpperCase();
		const hit = fileMap.get(key);
		if (hit !== undefined) {
			fileMap.delete(key);
			fileMap.set(key, hit);
		}
		return hit;
	}
}

export const globalSnapshotStore = new HashlineSnapshotStore();

export function tryRecoverEdits(
	baseText: string,
	currentText: string,
	hunks: Hunk[],
	_filePath: string,
): { success: boolean; remappedHunks?: Hunk[]; reason?: string } {
	const baseLines = normalizeLineEndings(baseText).split("\n");
	const curLines = normalizeLineEndings(currentText).split("\n");

	if (baseText === currentText) return { success: true, remappedHunks: hunks };

	let firstDiff = -1;
	for (let i = 0; i < Math.max(baseLines.length, curLines.length); i++) {
		if (baseLines[i] !== curLines[i]) {
			firstDiff = i + 1;
			break;
		}
	}

	if (firstDiff === -1) return { success: true, remappedHunks: hunks };

	const delta = curLines.length - baseLines.length;
	const remapped: Hunk[] = [];

	for (const hunk of hunks) {
		const start = hunk.lineStart ?? 1;
		const end = hunk.lineEnd ?? start;

		if (start < firstDiff && end < firstDiff) {
			remapped.push({ ...hunk });
		} else {
			const shiftedStart = Math.max(1, start + delta);
			const shiftedEnd = Math.max(1, end + delta);

			const baseSnippet = baseLines.slice(Math.max(0, start - 2), Math.min(baseLines.length, end + 1)).join("\n");
			const curSnippet = curLines
				.slice(Math.max(0, shiftedStart - 2), Math.min(curLines.length, shiftedEnd + 1))
				.join("\n");

			if (baseSnippet.trim() === curSnippet.trim() || delta === 0) {
				remapped.push({
					...hunk,
					lineStart: shiftedStart,
					lineEnd: hunk.lineEnd !== undefined ? shiftedEnd : undefined,
				});
			} else {
				const baseCtx = baseLines
					.slice(Math.max(0, start - 2), Math.min(baseLines.length, end + 1))
					.join("\n")
					.trim();
				let matched: number | null = null;
				if (baseCtx) {
					for (let w = 1; w <= 6 && matched === null; w++) {
						for (const off of [w, -w]) {
							const s2 = Math.max(1, start + delta + off);
							const e2 = Math.max(1, end + delta + off);
							const curCtx = curLines
								.slice(Math.max(0, s2 - 2), Math.min(curLines.length, e2 + 1))
								.join("\n")
								.trim();
							if (curCtx && curCtx === baseCtx) {
								matched = off;
								break;
							}
						}
					}
				}
				if (matched !== null) {
					remapped.push({
						...hunk,
						lineStart: Math.max(1, start + delta + matched),
						lineEnd: hunk.lineEnd !== undefined ? Math.max(1, end + delta + matched) : undefined,
					});
				} else {
					return {
						success: false,
						reason: `目标文件在第 ${firstDiff} 行附近发生外部修改，补丁锚点（第 ${start} 行）产生冲突`,
					};
				}
			}
		}
	}

	return { success: true, remappedHunks: remapped };
}

export interface ApplySectionResult {
	filePath: string;
	op: "updated" | "deleted" | "moved";
	created?: boolean;
	note?: string;
	oldHash?: string;
	newHash?: string;
	linesChanged: number;
	newPath?: string;
	recovered?: boolean;
}

export interface PatchApplyReport {
	ok: boolean;
	summary: string;
	results: ApplySectionResult[];
	error?: string;
}

function patchFileExcerpt(lines: string[], aroundLine: number | undefined, filePath: string, hash: string): string {
	let n = lines.length;
	if (n > 0 && lines[n - 1] === "") n--;
	const head = `当前共 ${n} 行，最新锚点：[${filePath}#${hash}]`;
	if (n === 0) return `${head}（空文件）`;
	const center = Math.max(1, Math.min(n, aroundLine ?? n));
	const lo = Math.max(1, center - 2);
	const hi = Math.min(n, center + 2);
	const rows: string[] = [];
	for (let i = lo; i <= hi; i++) rows.push(`${i}: ${String(lines[i - 1]).slice(0, 160)}`);
	return `${head}；第 ${lo}-${hi} 行现内容：\n${rows.join("\n")}`;
}

const SAME_BASENAME_SKIP_DIRS = new Set([
	"node_modules",
	".git",
	"__pycache__",
	".venv",
	"venv",
	"dist",
	"build",
	".pytest_cache",
	".mypy_cache",
	"target",
	".next",
]);

interface SameBasenameLookup {
	status: "resolved" | "ambiguous" | "none";
	path?: string;
	candidates: string[];
}

function findUniqueSameBasename(cwd: string, targetPath: string): SameBasenameLookup {
	const base = basename(targetPath);
	if (!base || base.startsWith(".")) return { status: "none", candidates: [] };
	const same: string[] = [];
	const ci: string[] = [];
	const walk = (dir: string, depth: number): void => {
		if (depth > 6 || same.length + ci.length > 16) return;
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (e.name.startsWith(".")) continue;
			const full = join(dir, e.name);
			if (e.isDirectory()) {
				if (!SAME_BASENAME_SKIP_DIRS.has(e.name)) walk(full, depth + 1);
				continue;
			}
			if (e.name === base) same.push(full);
			else if (e.name.toLowerCase() === base.toLowerCase()) ci.push(full);
		}
	};
	walk(cwd, 0);
	if (same.length === 1) return { status: "resolved", path: relative(cwd, same[0]) || same[0], candidates: same };
	if (same.length === 0 && ci.length === 1)
		return { status: "resolved", path: relative(cwd, ci[0]) || ci[0], candidates: ci };
	return { status: same.length + ci.length > 1 ? "ambiguous" : "none", candidates: [...same, ...ci].slice(0, 8) };
}

export function applyHashlinePatch(
	patchText: string,
	options: {
		cwd?: string;
		readFile?: (relPath: string) => string | null;
		writeFile?: (relPath: string, content: string) => void;
		deleteFile?: (relPath: string) => void;
		snapshotStore?: HashlineSnapshotStore;
	} = {},
): PatchApplyReport {
	const cwd = options.cwd ?? process.cwd();
	const store = options.snapshotStore ?? globalSnapshotStore;

	const defaultRead = (p: string) => {
		const full = resolve(cwd, p);
		if (!existsSync(full)) return null;
		return readFileSync(full, "utf8");
	};

	const defaultWrite = (p: string, content: string) => {
		const full = resolve(cwd, p);
		const dir = dirname(full);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		writeFileSync(full, content, "utf8");
	};

	const defaultDelete = (p: string) => {
		const full = resolve(cwd, p);
		if (existsSync(full)) {
			unlinkSync(full);
		}
	};

	const read = options.readFile ?? defaultRead;
	const write = options.writeFile ?? defaultWrite;
	const remove = options.deleteFile ?? defaultDelete;

	const sections = parseHashlinePatch(patchText);
	if (sections.length === 0) {
		return { ok: false, summary: "未能从输入中解析出有效的 [path#TAG] 补丁段", results: [] };
	}

	const clipboard = new Map<string, string[]>();
	const plannedWrites = new Map<string, string>();
	const plannedDeletes = new Set<string>();
	const foldKey = (abs: string): string => (process.platform === "win32" ? abs.toLowerCase() : abs);
	const plannedPaths = new Map<string, string>();
	const results: ApplySectionResult[] = [];

	for (const sec of sections) {
		const rel = relative(cwd, resolve(cwd, sec.filePath));
		if (
			rel === ".." ||
			rel.startsWith(".." + sep) ||
			rel.startsWith("../") ||
			rel.startsWith("..\\") ||
			isAbsolute(rel)
		) {
			return {
				ok: false,
				summary: `路径越界：禁止修改工作区外的文件 ${sec.filePath}`,
				results: [],
				error: `Path traversal denied: ${sec.filePath}`,
			};
		}

		let currentText = plannedWrites.get(foldKey(resolve(cwd, sec.filePath))) ?? read(sec.filePath);
		let fuzzyNote = "";
		if (currentText === null && sec.expectedHash) {
			const cand = findUniqueSameBasename(cwd, sec.filePath);
			if (cand.status === "resolved" && cand.path) {
				fuzzyNote = `（路径 ${sec.filePath} 不存在，已解析为同名文件 ${cand.path}）`;
				sec.filePath = cand.path;
				currentText = plannedWrites.get(foldKey(resolve(cwd, sec.filePath))) ?? read(cand.path);
			}
		}
		const isNewFile = currentText === null;
		if (currentText === null) {
			if (sec.hunks.some((h) => h.kind === "remove_file" || h.kind === "move_file")) {
				return {
					ok: false,
					summary: `文件不存在，无法 REM/MV：${sec.filePath}（新建文件请用 [path] 段头 + PUT <1: 提供内容）`,
					results: [],
					error: `File not found: ${sec.filePath}`,
				};
			}
			if (sec.expectedHash) {
				const cand = findUniqueSameBasename(cwd, sec.filePath);
				const candRel = cand.candidates.map((c) => relative(cwd, c) || c);
				const advice = candRel.length
					? `工作区内相近文件：${candRel.join("、")}。请核对目录层级后用上述路径重试，勿新建同名文件遮蔽。`
					: `新建文件时段头不能带 #TAG（无法对不存在的文件校验哈希），请写 [${sec.filePath}] 并用 PUT <1: 提供内容。`;
				return {
					ok: false,
					summary: `文件不存在：${sec.filePath}。${advice}`,
					results: [],
					error: `Tagged header on nonexistent file: ${sec.filePath}`,
				};
			}
			currentText = "";
		}

		const isCrlf = currentText.includes("\r\n");
		const eol = isCrlf ? "\r\n" : "\n";

		const liveHash = computeFileHash(currentText);
		let workingText = currentText;
		let isRecovered = false;

		const absFilePath = resolve(cwd, sec.filePath);
		if (sec.expectedHash && sec.expectedHash !== liveHash) {
			const snapshot = store.get(absFilePath, sec.expectedHash) ?? store.get(sec.filePath, sec.expectedHash);
			if (snapshot) {
				const recovery = tryRecoverEdits(snapshot, currentText, sec.hunks, sec.filePath);
				if (recovery.success && recovery.remappedHunks) {
					sec.hunks = recovery.remappedHunks;
					isRecovered = true;
				} else {
					const excerptLines = normalizeLineEndings(currentText).split("\n");
					const firstHunk = sec.hunks.find((h) => h.kind !== "remove_file" && h.kind !== "move_file");
					return {
						ok: false,
						summary: `文件内容已发生变动，且三方合流失败：${sec.filePath}（预期哈希 #${sec.expectedHash}，实际哈希 #${liveHash}；${recovery.reason ?? "冲突"}）\n${patchFileExcerpt(excerptLines, firstHunk?.lineStart, sec.filePath, liveHash)}\n请基于上述现内容修正行号后重提交，或重新使用 read 工具查看该文件。`,
						results: [],
						error: `Hash mismatch and recovery failed on ${sec.filePath}`,
					};
				}
			} else {
				const excerptLines = normalizeLineEndings(currentText).split("\n");
				const firstHunk = sec.hunks.find((h) => h.kind !== "remove_file" && h.kind !== "move_file");
				return {
					ok: false,
					summary: `文件内容与锚点不一致：${sec.filePath}（预期哈希 #${sec.expectedHash}，实际哈希 #${liveHash}）${fuzzyNote}\n${patchFileExcerpt(excerptLines, firstHunk?.lineStart, sec.filePath, liveHash)}\n请基于上述现内容修正行号后重提交，或重新使用 read 工具读取该文件。`,
					results: [],
					error: `Hash mismatch on ${sec.filePath} (#${sec.expectedHash} vs #${liveHash})`,
				};
			}
		}

		const hasTrailingNewline = workingText.endsWith("\n");
		let lines = normalizeLineEndings(workingText).split("\n");
		if (hasTrailingNewline && lines.length > 0 && lines[lines.length - 1] === "") {
			lines.pop();
		}
		if (isNewFile) {
			lines = [];
		}
		let isDeleted = false;
		let moveDest: string | undefined = undefined;

		for (const h of sec.hunks) {
			if (h.kind === "remove_file") {
				isDeleted = true;
				break;
			}
			if (h.kind === "move_file") {
				if (!h.targetPath) continue;
				const destRel = relative(cwd, resolve(cwd, h.targetPath));
				if (
					destRel === ".." ||
					destRel.startsWith(".." + sep) ||
					destRel.startsWith("../") ||
					destRel.startsWith("..\\") ||
					isAbsolute(destRel)
				) {
					return {
						ok: false,
						summary: `路径越界：禁止移动文件到工作区外 ${h.targetPath}`,
						results: [],
						error: `Path traversal denied on move target: ${h.targetPath}`,
					};
				}
				moveDest = h.targetPath;
				continue;
			}

			if (h.kind === "put_block" || h.kind === "cut_block" || h.kind === "paste_over_block") {
				const span = resolveBlockSpan(lines, h.lineStart ?? 1, sec.filePath);
				h.lineStart = span.start;
				h.lineEnd = span.end;
			} else if (h.kind === "insert_after_block") {
				const span = resolveBlockSpan(lines, h.lineStart ?? 1, sec.filePath);
				h.lineStart = span.end;
				h.kind = "insert_after";
			}

			if (h.kind === "cut_range" || h.kind === "cut_block") {
				const start = Math.max(1, h.lineStart ?? 1);
				const end = Math.min(lines.length, h.lineEnd ?? start);
				const captured = lines.slice(start - 1, end);
				const regKey = h.registerName || "_anon";
				clipboard.set(regKey, captured);
			}
		}

		if (isDeleted) {
			plannedDeletes.add(foldKey(absFilePath));
			plannedPaths.set(foldKey(absFilePath), sec.filePath);
			results.push({
				filePath: sec.filePath,
				op: "deleted",
				note: fuzzyNote || undefined,
				oldHash: liveHash,
				linesChanged: lines.length,
			});
			continue;
		}

		for (const h of sec.hunks) {
			if (h.kind === "remove_file" || h.kind === "move_file") continue;
			if (h.lineStart !== -1 && typeof h.lineStart === "number") {
				if (h.lineStart < 1 || h.lineStart > Math.max(1, lines.length)) {
					return {
						ok: false,
						summary: `行号越界：${sec.filePath} 第 ${h.lineStart} 行（文件总共只有 ${lines.length} 行）。${patchFileExcerpt(lines, lines.length, sec.filePath, liveHash)}`,
						results: [],
						error: `Line out of bounds: line ${h.lineStart} in ${sec.filePath} (${lines.length} lines total)`,
					};
				}
				if (h.lineEnd !== undefined && h.lineEnd > Math.max(1, lines.length)) {
					return {
						ok: false,
						summary: `行号越界：${sec.filePath} 结束行 ${h.lineEnd} 超过文件总行数（总共 ${lines.length} 行）。${patchFileExcerpt(lines, h.lineStart, sec.filePath, liveHash)}`,
						results: [],
						error: `Line out of bounds: end line ${h.lineEnd} in ${sec.filePath} (${lines.length} lines total)`,
					};
				}
			}
		}

		const replacementSpans: Array<{ start: number; end: number }> = [];
		for (const h of sec.hunks) {
			let s: number;
			let e: number;
			if (h.kind === "insert_before" || h.kind === "insert_after") {
				s = h.lineStart === -1 ? lines.length : (h.lineStart ?? 1);
				e = s;
			} else if (
				h.kind === "put_range" ||
				h.kind === "put_block" ||
				h.kind === "cut_range" ||
				h.kind === "cut_block" ||
				h.kind === "paste_over_range" ||
				h.kind === "paste_over_block"
			) {
				s = h.lineStart === -1 ? lines.length : (h.lineStart ?? 1);
				e = h.lineEnd ?? s;
			} else {
				continue;
			}
			for (const prev of replacementSpans) {
				if (!(e < prev.start || s > prev.end)) {
					return {
						ok: false,
						summary: `补丁段存在重叠的行范围：${sec.filePath}（行 ${s}-${e} 与行 ${prev.start}-${prev.end} 发生重叠）。请合并为一个连续的修改块。`,
						results: [],
						error: `Overlapping hunks in ${sec.filePath} (${s}-${e} overlaps with ${prev.start}-${prev.end})`,
					};
				}
			}
			replacementSpans.push({ start: s, end: e });
		}

		const sortedHunks = [...sec.hunks]
			.filter((h) => h.kind !== "remove_file" && h.kind !== "move_file")
			.sort((a, b) => {
				const lineA = a.lineStart === -1 ? lines.length : (a.lineStart ?? 0);
				const lineB = b.lineStart === -1 ? lines.length : (b.lineStart ?? 0);
				return lineB - lineA;
			});

		let linesChangedCount = 0;

		for (const h of sortedHunks) {
			let contentToInsert: string[] = [];

			if (h.kind === "cut_range" || h.kind === "cut_block") {
				contentToInsert = [];
			} else if (h.registerName) {
				contentToInsert = clipboard.get(h.registerName) ?? [];
			} else {
				contentToInsert = h.bodyLines;
			}

			let start = h.lineStart ?? 1;
			if (start === -1) start = lines.length;

			if (h.kind === "insert_before") {
				const idx = Math.max(0, Math.min(lines.length, start - 1));
				lines.splice(idx, 0, ...contentToInsert);
				linesChangedCount += contentToInsert.length;
			} else if (h.kind === "insert_after") {
				const idx = Math.max(0, Math.min(lines.length, start));
				lines.splice(idx, 0, ...contentToInsert);
				linesChangedCount += contentToInsert.length;
			} else if (
				h.kind === "put_range" ||
				h.kind === "put_block" ||
				h.kind === "cut_range" ||
				h.kind === "cut_block" ||
				h.kind === "paste_over_range" ||
				h.kind === "paste_over_block"
			) {
				const s = Math.max(1, start);
				const e = Math.min(lines.length, h.lineEnd ?? s);
				const count = Math.max(0, e - s + 1);
				lines.splice(s - 1, count, ...contentToInsert);
				linesChangedCount += Math.max(count, contentToInsert.length);
			}
		}

		const newContent = isNewFile
			? lines.length > 0
				? lines.join(eol) + eol
				: ""
			: lines.join(eol) + (hasTrailingNewline ? eol : "");
		if (moveDest) {
			const moveKey = foldKey(resolve(cwd, moveDest));
			plannedDeletes.add(foldKey(absFilePath));
			plannedPaths.set(foldKey(absFilePath), sec.filePath);
			plannedWrites.set(moveKey, newContent);
			plannedPaths.set(moveKey, moveDest);
			results.push({
				filePath: sec.filePath,
				op: "moved",
				note: fuzzyNote || undefined,
				oldHash: liveHash,
				newHash: computeFileHash(newContent),
				linesChanged: linesChangedCount,
				newPath: moveDest,
				recovered: isRecovered,
			});
		} else {
			const updateKey = foldKey(absFilePath);
			plannedWrites.set(updateKey, newContent);
			plannedPaths.set(updateKey, sec.filePath);
			results.push({
				filePath: sec.filePath,
				op: "updated",
				created: isNewFile,
				note: fuzzyNote || undefined,
				oldHash: liveHash,
				newHash: computeFileHash(newContent),
				linesChanged: linesChangedCount,
				recovered: isRecovered,
			});
		}
	}

	for (const [key, content] of plannedWrites.entries()) {
		const p = plannedPaths.get(key) ?? key;
		write(p, content);
		store.record(resolve(cwd, p), content);
	}
	for (const key of plannedDeletes) {
		if (!plannedWrites.has(key)) {
			remove(plannedPaths.get(key) ?? key);
		}
	}

	const summaryParts = results.map((r) => {
		if (r.op === "deleted") return `删除 ${r.filePath}${r.note ?? ""}`;
		if (r.created) return `新建 ${r.filePath}（${r.linesChanged} 行，新哈希 #${r.newHash}）${r.note ?? ""}`;
		if (r.op === "moved") return `移动 ${r.filePath} -> ${r.newPath}（新哈希 #${r.newHash}）${r.note ?? ""}`;
		return `修改 ${r.filePath}（${r.linesChanged} 行变动，新哈希 #${r.newHash}${r.recovered ? "，三方自愈" : ""}）${r.note ?? ""}`;
	});

	return {
		ok: true,
		summary: `成功应用补丁：\n${summaryParts.map((s) => "• " + s).join("\n")}`,
		results,
	};
}
