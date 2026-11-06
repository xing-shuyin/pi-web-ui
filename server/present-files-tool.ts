import { open, stat } from "node:fs/promises";
import { basename, extname, posix, sep } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getServerString, pick, type ServerLang } from "./i18n.js";
import { resolvePathForDirCheck } from "./read-tool.js";
import {
	getGlobalRemoteSshService,
	isRemoteWorkspaceUri,
	parseRemoteWorkspaceUri,
	restoreWorkspaceUriFromSessionDir,
} from "./remote-ssh-service.js";
import { decodeText, isAudioFile, looksLikeText, previewKind } from "./text-sniff.js";
import { PRESENT_FILES_TOOL_NAME } from "./tool-manager.js";

export { PRESENT_FILES_TOOL_NAME };

export const MAX_PRESENT_ITEMS = 12;
export const MAX_EXCERPT_CHARS = 1200;
export const MAX_EXCERPT_TOTAL_CHARS = 6000;
const EXCERPT_READ_BYTES = 8192;
const SNIFF_BYTES = 4096;
const MAX_SNIFFABLE_BYTES = 4 * 1024 * 1024;

const MARKDOWN_EXTS = new Set(["md", "markdown", "mdx"]);
const HTML_EXTS = new Set(["html", "htm", "xhtml"]);

export type PresentKind =
	"image" | "video" | "audio" | "markdown" | "html" | "pdf" | "text" | "binary" | "dir" | "missing";

export interface PresentItemInput {
	path: string;
	caption?: string;
	focus?: boolean;
}

export interface PresentItem extends PresentItemInput {
	name: string;
	abs: string;
	kind: PresentKind;
	size?: number;
	mtime?: number;
	excerpt?: string;
	excerptTruncated?: boolean;
}

export interface PresentDetails {
	title?: string;
	note?: string;
	items: PresentItem[];
}

export function normalizePresentItems(raw: unknown, max = MAX_PRESENT_ITEMS): PresentItemInput[] {
	if (!Array.isArray(raw)) return [];
	const out: PresentItemInput[] = [];
	const seen = new Set<string>();
	for (const entry of raw) {
		if (typeof entry === "string") {
			const path = normPath(entry);
			if (!path || seen.has(path)) continue;
			seen.add(path);
			out.push({ path });
		} else if (entry && typeof entry === "object") {
			const e = entry as { path?: unknown; caption?: unknown; focus?: unknown };
			if (typeof e.path !== "string") continue;
			const path = normPath(e.path);
			if (!path || seen.has(path)) continue;
			seen.add(path);
			const item: PresentItemInput = { path };
			if (typeof e.caption === "string" && e.caption.trim()) item.caption = e.caption.trim();
			if (e.focus === true) item.focus = true;
			out.push(item);
		}
		if (out.length >= max) break;
	}
	return out;
}

export function normPath(p: string): string {
	const w = String(p ?? "")
		.trim()
		.replace(/\\/g, "/");
	if (w === "/" || w === "") return w;
	if (w.endsWith("/")) {
		const trimmed = w.replace(/\/+$/, "");
		return /^[A-Za-z]:$/.test(trimmed) ? `${trimmed}/` : trimmed;
	}
	return w;
}

export function toWirePath(abs: string): string {
	return sep === "/" ? abs : abs.split(sep).join("/");
}

export function classifyPresentKind(name: string): PresentKind {
	const ext = extname(name).toLowerCase().replace(/^\./, "");
	if (MARKDOWN_EXTS.has(ext)) return "markdown";
	if (HTML_EXTS.has(ext)) return "html";
	if (ext === "pdf") return "pdf";
	if (isAudioFile(name)) return "audio";
	const base = previewKind(name);
	if (base === "image") return "image";
	if (base === "video") return "video";
	if (base === "text") return "text";
	return "binary";
}

export function shouldSniff(kind: PresentKind): boolean {
	return kind === "binary";
}

export function hasExcerpt(kind: PresentKind): boolean {
	return kind === "text" || kind === "markdown" || kind === "html";
}

export function formatBytes(n: number): string {
	if (!Number.isFinite(n) || n < 0) return "?";
	if (n < 1024) return `${Math.round(n)} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
	if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
	return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

async function readHead(abs: string, bytes: number): Promise<Buffer | null> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(abs, "r");
		const buf = Buffer.alloc(bytes);
		const { bytesRead } = await handle.read(buf, 0, bytes, 0);
		return buf.subarray(0, bytesRead);
	} catch {
		return null;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

export interface PresentFilesToolOptions {
	enabled?: () => boolean;
	getLang?: () => ServerLang;
}

interface ExcerptBudget {
	left: number;
}

async function attachExcerpt(item: PresentItem, budget: ExcerptBudget, native: string): Promise<void> {
	if (!hasExcerpt(item.kind) || item.size === undefined || item.size === 0) return;
	if (item.size > MAX_SNIFFABLE_BYTES || budget.left <= 0) return;
	const head = await readHead(native, EXCERPT_READ_BYTES);
	if (!head || head.length === 0) return;
	const text = decodeText(head).replace(/\u0000+$/, "");
	if (!text) return;
	const cap = Math.min(MAX_EXCERPT_CHARS, budget.left);
	const clipped = text.length > cap;
	const excerpt = clipped ? text.slice(0, cap) : text;
	item.excerpt = excerpt;
	item.excerptTruncated = clipped || item.size > head.length;
	budget.left -= excerpt.length;
}

export async function probePresentItem(
	raw: PresentItemInput,
	cwd: string,
	budget: ExcerptBudget,
): Promise<PresentItem> {
	const effCwd = restoreWorkspaceUriFromSessionDir(cwd);
	if (isRemoteWorkspaceUri(effCwd)) {
		const parsed = parseRemoteWorkspaceUri(effCwd);
		const sshSvc = getGlobalRemoteSshService();
		const cleaned = String(raw.path ?? "")
			.trim()
			.replace(/^@/, "")
			.replace(/\\/g, "/");
		const remoteAbs = cleaned.startsWith("/")
			? posix.normalize(cleaned)
			: posix.resolve(parsed?.remotePath || "/", cleaned);
		const name = posix.basename(remoteAbs) || raw.path;
		const base: PresentItem = { ...raw, name, abs: remoteAbs, kind: "missing" };
		if (!sshSvc || !parsed) return base;
		const st = await sshSvc.sftpStat(effCwd, remoteAbs).catch(() => null);
		if (!st) return base;
		if (st.isDirectory) return { ...base, kind: "dir", mtime: st.mtime };
		if (!st.isFile) return base;
		let kind = classifyPresentKind(name);
		if (shouldSniff(kind) && st.size > 0 && st.size <= MAX_SNIFFABLE_BYTES) {
			const headRes = await sshSvc.sftpReadFile(effCwd, remoteAbs, SNIFF_BYTES).catch(() => null);
			if (headRes && headRes.data.length > 0 && looksLikeText(headRes.data)) kind = "text";
		}
		const item: PresentItem = { ...base, kind, size: st.size, mtime: st.mtime };
		if (hasExcerpt(item.kind) && st.size > 0 && st.size <= MAX_SNIFFABLE_BYTES && budget.left > 0) {
			const headRes = await sshSvc.sftpReadFile(effCwd, remoteAbs, EXCERPT_READ_BYTES).catch(() => null);
			if (headRes && headRes.data.length > 0) {
				const text = decodeText(headRes.data).replace(/\u0000+$/, "");
				if (text) {
					const cap = Math.min(MAX_EXCERPT_CHARS, budget.left);
					const clipped = text.length > cap;
					const excerpt = clipped ? text.slice(0, cap) : text;
					item.excerpt = excerpt;
					item.excerptTruncated = clipped || st.size > headRes.data.length;
					budget.left -= excerpt.length;
				}
			}
		}
		return item;
	}

	const native = resolvePathForDirCheck(raw.path, cwd);
	const abs = toWirePath(native);
	const name = basename(native) || raw.path;
	const base: PresentItem = { ...raw, name, abs, kind: "missing" };
	const st = await stat(native).catch(() => null);
	if (!st) return base;
	if (st.isDirectory()) return { ...base, kind: "dir", mtime: st.mtimeMs };
	if (!st.isFile()) return base;
	let kind = classifyPresentKind(name);
	if (shouldSniff(kind) && st.size > 0 && st.size <= MAX_SNIFFABLE_BYTES) {
		const head = await readHead(native, SNIFF_BYTES);
		if (head && head.length > 0 && looksLikeText(head)) kind = "text";
	}
	const item: PresentItem = { ...base, kind, size: st.size, mtime: st.mtimeMs };
	await attachExcerpt(item, budget, native);
	return item;
}

export function buildPresentResultText(items: PresentItem[], lang: ServerLang, title?: string): string {
	const shown = items.filter((i) => i.kind !== "missing");
	const missing = items.filter((i) => i.kind === "missing");
	const lines: string[] = [];
	const trimmedTitle = title?.trim();
	const key = trimmedTitle
		? getServerString(lang, "present.files.result.head.titled")
			? "present.files.result.head.titled"
			: "present.files.result.head"
		: "present.files.result.head";
	const head = trimmedTitle
		? pick(
				lang,
				`已把 ${shown.length} 个文件作为预览卡片展示给用户（${trimmedTitle}）：`,
				`Presented ${shown.length} file(s) to the user as preview cards (${trimmedTitle}):`,
				key,
				{ n: shown.length, title: trimmedTitle },
			)
		: pick(
				lang,
				`已把 ${shown.length} 个文件作为预览卡片展示给用户：`,
				`Presented ${shown.length} file(s) to the user as preview cards:`,
				"present.files.result.head",
				{ n: shown.length, title: "" },
			);
	lines.push(head);
	for (const [i, it] of shown.entries()) {
		const meta =
			it.kind === "dir"
				? pick(lang, "目录", "directory", "present.files.result.kindDir")
				: [it.kind, it.size !== undefined ? formatBytes(it.size) : ""].filter(Boolean).join(", ");
		const caption = it.caption ? ` — ${it.caption}` : "";
		lines.push(`${i + 1}. ${it.path} (${meta})${caption}`);
	}
	if (missing.length > 0) {
		lines.push(
			pick(
				lang,
				`未展示（路径不存在或不可读）：${missing.map((m) => m.path).join("、")}`,
				`Not shown (path missing or unreadable): ${missing.map((m) => m.path).join(", ")}`,
				"present.files.result.missing",
				{ paths: missing.map((m) => m.path).join(", ") },
			),
		);
	}
	lines.push(
		pick(
			lang,
			"用户在卡片上可以直接看图/播放、打开预览、在本机打开、在文件管理器中显示、下载或复制路径；不要再把文件内容贴一遍。",
			"The user can view/play media, open the preview dialog, open the file locally, reveal it in the file manager, download it or copy its path from the card — do not paste the file contents again.",
			"present.files.result.tail",
		),
	);
	return lines.join("\n");
}

function missingAllError(lang: ServerLang, paths: string[]): string {
	return pick(
		lang,
		`这些路径都不存在或不可读，没有任何卡片展示出去：${paths.join("、")}`,
		`None of these paths exist or are readable, nothing was shown: ${paths.join(", ")}`,
		"present.files.result.allMissing",
		{ paths: paths.join(", ") },
	);
}

export function makePresentFilesTool(fallbackCwd: string, options: PresentFilesToolOptions = {}): ToolDefinition {
	const enabled = options.enabled ?? ((): boolean => true);
	const getLang = options.getLang ?? ((): ServerLang => "en");
	return defineTool({
		name: PRESENT_FILES_TOOL_NAME,
		label: "Show files to the user",
		description:
			"Show files to the user as preview cards in the chat: images/videos/audio inline, text/markdown/HTML in a preview dialog; " +
			"each card can open locally, reveal in file manager, download, or copy path. " +
			"Give workspace-relative paths (max 12); `title`/`note` show above the cards, `caption` next to the name, `focus: true` opens that item immediately.",
		promptSnippet: "show a produced artifact (image/chart/report) to the user",
		promptGuidelines: [
			"After producing something visual or user-facing (screenshot, chart, video, report, log, build output), show it with present_files instead of only printing the path",
			"Skip it for ordinary source edits the user did not ask to see; never call it twice for the same file in one turn",
		],
		parameters: Type.Object({
			title: Type.Optional(
				Type.String({
					description: "Optional card title (short, e.g. 'Q3 revenue chart').",
				}),
			),
			note: Type.Optional(
				Type.String({
					description: "Optional one-line note above the cards (markdown).",
				}),
			),
			items: Type.Array(
				Type.Object({
					path: Type.String({ description: "File path (workspace-relative like 'docs/chart.png', or absolute)." }),
					caption: Type.Optional(Type.String({ description: "Optional short caption next to the file name." })),
					focus: Type.Optional(
						Type.Boolean({
							description: "true → open this item in the preview dialog immediately.",
						}),
					),
				}),
				{ description: `Files to show (1-${MAX_PRESENT_ITEMS}).` },
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const lang = getLang();
			if (!enabled()) {
				throw new Error(
					pick(
						lang,
						"用户的设置里关闭了 present_files 工具。",
						"The user disabled the present_files tool in settings.",
						"present.files.result.disabled",
					),
				);
			}
			const p = params as { title?: unknown; note?: unknown; items?: unknown };
			const items = normalizePresentItems(p.items);
			if (items.length === 0) {
				throw new Error(
					pick(
						lang,
						"present_files 至少需要一个带 path 的条目。",
						"present_files needs at least one item with a path.",
						"present.files.result.noItems",
					),
				);
			}
			const cwd = typeof ctx?.cwd === "string" && ctx.cwd ? ctx.cwd : fallbackCwd;
			const budget: ExcerptBudget = { left: MAX_EXCERPT_TOTAL_CHARS };
			const probed: PresentItem[] = [];
			for (const item of items) {
				if (signal?.aborted) throw new Error("aborted");
				probed.push(await probePresentItem(item, cwd, budget));
			}
			if (probed.every((i) => i.kind === "missing")) {
				throw new Error(
					missingAllError(
						lang,
						probed.map((i) => i.path),
					),
				);
			}
			const title = typeof p.title === "string" && p.title.trim() ? p.title.trim() : undefined;
			const note = typeof p.note === "string" && p.note.trim() ? p.note.trim() : undefined;
			const details: PresentDetails = { items: probed };
			if (title) details.title = title;
			if (note) details.note = note;
			return {
				content: [{ type: "text" as const, text: buildPresentResultText(probed, lang, title) }],
				details,
			};
		},
	}) as unknown as ToolDefinition;
}
