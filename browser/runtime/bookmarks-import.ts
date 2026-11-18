/**
 * 书签导入的**纯逻辑**：别的浏览器导出的文件 → 我们的书签树 → 合并进现有树。
 *
 * 三条边界（和 `passwords.import` / `data.import` 同一条口径）：
 * - **文件只由主进程读**：书签 HTML 动辄几 MB，渲染层不需要正文，只要回执里的条数。
 * - **只认 http(s)**：`javascript:` / `place:` / `chrome://` / 带账号密码的 URL 一律算 `skipped`，
 *   和 `BrowserStorage.saveBookmarks` 的校验同一口径——导入不能成为绕过校验的后门。
 * - **导入不覆盖、不重排**：已经在树里的 URL（忽略首尾空白与末尾斜杠）直接算 `duplicate` 丢掉，
 *   新条目整块挂到根下；根非空时先包一层（名字由宿主传进来的 `folderName` 决定，跟界面语言走），
 *   用户原有的文件夹不会被拆开或改名。
 */
import type { Bookmark } from "../storage/index.js";
import { isWebUrl } from "./urls.js";

/** 单个文件上限：再大就不是导出的书签文件，而是选错了文件。 */
export const BOOKMARK_FILE_MAX_BYTES = 8 * 1024 * 1024;
/** 条目上限：挡住结构爆炸的畸形文件（正常导出几千条就到头了）。 */
export const BOOKMARK_MAX_NODES = 20000;
/** 目录深度上限，与 `BrowserStorage` 读回时的限深保持一致。 */
const MAX_DEPTH = 30;
/** 条目名上限：文件损坏/被截断时 `</A>` 缺失，会把“标题”吞到文件尾。 */
const MAX_NAME = 512;

export interface ParsedBookmarks {
	nodes: Bookmark[];
	/** 认不出、网址非 http(s) 或超过上限被丢掉的条目数（不含空文件夹）。 */
	skipped: number;
}

export interface BookmarkMergeResult {
	children: Bookmark[];
	/** 真正写进树的书签条数。 */
	imported: number;
	/** 树里已经有同一 URL（含文件内自己重复）而没动的条数。 */
	duplicate: number;
	/** 合并阶段被丢掉的非法条目数（解析已经过滤过一遍，正常为 0）。 */
	skipped: number;
}

interface ParseState {
	count: number;
	skipped: number;
}

const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: "\u00a0",
};
const CLOSING_TAG = { a: /<\/a\s*>/i, h3: /<\/h3\s*>/i };

/** 实体解码：`&amp;` 在网址里极常见，`&#39;` / `&#x27;` 在标题里常见。认不出的原样留着。 */
export function decodeEntities(value: string): string {
	if (!value.includes("&")) return value;
	return value.replace(/&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]{2,8});/g, (match, body: string) => {
		if (body[0] !== "#") return NAMED_ENTITIES[body.toLowerCase()] ?? match;
		const hex = body[1] === "x" || body[1] === "X";
		const code = hex ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1));
		if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return match;
		return String.fromCodePoint(code);
	});
}

function clean(value: string): string {
	return decodeEntities(value).replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
}

/** 属性取值的三种写法（双引号 / 单引号 / 裸值），先到先得；HTML 属性里的实体在这里解掉。 */
function attribute(attrs: string, name: string): string {
	const found = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(attrs);
	return decodeEntities(found ? (found[1] ?? found[2] ?? found[3] ?? "") : "");
}

/** 可入库的网址：http(s)、非空、无内嵌账号密码（`isWebUrl` 单源），否则返回空串。 */
function usableUrl(value: string): string {
	const url = value.trim();
	return isWebUrl(url) ? url : "";
}

/** 去重口径：忽略首尾空白与末尾斜杠（`https://a.com/` 与 `https://a.com` 是同一个地址）。 */
function urlKey(url: string): string {
	return url.trim().replace(/\/+$/, "");
}

/** 从 `<tag ...>` 之后读到对应 `</tag>`：返回中间正文和闭合标签之后的位置。 */
function readBody(html: string, from: number, tag: "a" | "h3"): { text: string; end: number } {
	const rest = html.slice(from);
	const found = CLOSING_TAG[tag].exec(rest);
	if (!found) return { text: rest, end: html.length };
	return { text: rest.slice(0, found.index), end: from + found.index + found[0].length };
}

/**
 * Netscape 书签 HTML（Chrome / Edge / Firefox / Safari 的导出格式）。
 *
 * 只认四个记号：`<DL>` / `</DL>` 分层，`<H3>名字</H3>` 是文件夹名（它的 `<DL>` 落地时才入树，
 * 所以空文件夹自然被丢掉），`<A HREF="…">名字</A>` 是书签。`<DT>` / `<DD>` 与其余标记一律忽略——
 * 因此没有对应 `<DL>` 的 `<H3>` 会被下一个 `<H3>` 顶掉，正是想要的结果。
 */
export function parseNetscapeBookmarks(html: string): ParsedBookmarks {
	const state: ParseState = { count: 0, skipped: 0 };
	const nodes: Bookmark[] = [];
	const stack: Bookmark[][] = [nodes];
	let pending: Bookmark | undefined;
	const tag = /<(\/?)(dl|h3|a)\b([^>]*)>/gi;
	let match: RegExpExecArray | null;
	while ((match = tag.exec(html))) {
		const closing = match[1] === "/";
		const name = match[2].toLowerCase();
		if (name === "dl") {
			if (closing) {
				if (stack.length > 1) stack.pop();
				pending = undefined;
				continue;
			}
			const container = stack[stack.length - 1];
			const folder = pending;
			pending = undefined;
			if (folder && stack.length < MAX_DEPTH) {
				container.push(folder);
				stack.push(folder.children ?? []);
			} else if (folder) stack.push([]);
			// 顶层 `<DL>`（前面没有文件夹）沿用当前容器，配对的那个 `</DL>` 弹回同一层
			else stack.push(container);
			continue;
		}
		if (name === "h3") {
			if (closing) continue;
			const body = readBody(html, tag.lastIndex, "h3");
			tag.lastIndex = body.end;
			pending = { name: clean(body.text), type: "folder", children: [] };
			continue;
		}
		if (closing) continue;
		const url = usableUrl(attribute(match[3], "href"));
		const body = readBody(html, tag.lastIndex, "a");
		tag.lastIndex = body.end;
		const title = clean(body.text);
		if (!url || state.count >= BOOKMARK_MAX_NODES) {
			state.skipped += 1;
			continue;
		}
		state.count += 1;
		stack[stack.length - 1].push({ name: title || url, type: "link", url });
	}
	return { nodes: prune(nodes), skipped: state.skipped };
}

function field(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function pushJsonNode(value: unknown, out: Bookmark[], state: ParseState, depth: number): void {
	if (!value || typeof value !== "object" || Array.isArray(value) || depth > MAX_DEPTH) {
		state.skipped += 1;
		return;
	}
	const raw = value as Record<string, unknown>;
	const name = clean(field(raw.name) || field(raw.title));
	if (Array.isArray(raw.children)) {
		const children: Bookmark[] = [];
		for (const child of raw.children) pushJsonNode(child, children, state, depth + 1);
		out.push({ name, type: "folder", children });
		return;
	}
	const url = usableUrl(field(raw.url) || field(raw.uri));
	if (!url || state.count >= BOOKMARK_MAX_NODES) {
		state.skipped += 1;
		return;
	}
	state.count += 1;
	out.push({ name: name || url, type: "link", url });
}

/**
 * JSON 书签：认本仓库自己的树（`{name,type,children}` / `bookmarks.list` 的数组）、
 * Chrome 的 `Bookmarks` 数据文件（`{roots:{bookmark_bar,other,…}}`，链接的 `type` 是 `url`）
 * 与 Firefox 的备份（`text/x-moz-place*`，链接字段是 `uri`）。
 * 判「是不是文件夹」只看有没有 `children` 数组，判「是不是书签」只看有没有 url/uri——
 * 各家的 `type` 取值互相不兼容，认它反而会把另一家的文件读空。
 */
export function parseJsonBookmarks(value: unknown): ParsedBookmarks {
	const state: ParseState = { count: 0, skipped: 0 };
	const nodes: Bookmark[] = [];
	const roots: unknown[] = Array.isArray(value)
		? value
		: value && typeof value === "object" && (value as Record<string, unknown>).roots
			? Object.values((value as { roots: Record<string, unknown> }).roots)
			: value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).children)
				? (value as { children: unknown[] }).children
				: [value];
	for (const root of roots) pushJsonNode(root, nodes, state, 0);
	return { nodes: prune(nodes), skipped: state.skipped };
}

/**
 * 入口：按正文首字符分派（BOM 先剥）。以 `[` / `{` 开头就必须是合法 JSON，
 * 解析失败直接抛——比当成 HTML 静默读出 0 条更好查。
 */
export function parseBookmarks(text: string): ParsedBookmarks {
	const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
	if (!/^\s*[[{]/.test(body)) return parseNetscapeBookmarks(body);
	let value: unknown;
	try {
		value = JSON.parse(body);
	} catch {
		throw new Error("That file is not valid JSON");
	}
	return parseJsonBookmarks(value);
}

/** 丢掉空文件夹与非法链接（导入的「备份里的备份」经常只剩一层层空壳）。 */
function prune(nodes: Bookmark[]): Bookmark[] {
	const out: Bookmark[] = [];
	for (const node of nodes) {
		if (node.type === "folder") {
			const children = prune(node.children ?? []);
			if (children.length) out.push({ name: node.name, type: "folder", children });
			continue;
		}
		const url = usableUrl(node.url ?? "");
		if (url) out.push({ name: node.name || url, type: "link", url });
	}
	return out;
}

/**
 * 合并进现有树：返回新的根 children（不改动入参）。
 *
 * - `existing` 空 ⇒ 导入条目直接成为根内容（不套多余的一层）。
 * - `existing` 非空且给了 `folderName` ⇒ 套一层该名字的文件夹，导入内容整块挂在里面。
 * - 一个能进的都没有 ⇒ 原样返回 `existing`，宿主据此判断「什么都没发生」。
 */
export function mergeBookmarks(
	existing: Bookmark[],
	incoming: Bookmark[],
	options: { folderName?: string } = {},
): BookmarkMergeResult {
	const seen = new Set<string>();
	const remember = (nodes: Bookmark[]): void => {
		for (const node of nodes) {
			if (node.type === "folder") remember(node.children ?? []);
			else if (node.url) seen.add(urlKey(node.url));
		}
	};
	remember(existing);
	let imported = 0;
	let duplicate = 0;
	let skipped = 0;
	const take = (nodes: Bookmark[]): Bookmark[] => {
		const out: Bookmark[] = [];
		for (const node of nodes) {
			if (node.type === "folder") {
				const children = take(node.children ?? []);
				if (children.length) out.push({ name: node.name, type: "folder", children });
				continue;
			}
			const url = usableUrl(node.url ?? "");
			if (!url) {
				skipped += 1;
				continue;
			}
			const key = urlKey(url);
			if (seen.has(key)) {
				duplicate += 1;
				continue;
			}
			seen.add(key);
			imported += 1;
			out.push({ name: node.name || url, type: "link", url });
		}
		return out;
	};
	const added = take(incoming);
	const children = existing.slice();
	if (!added.length) return { children, imported: 0, duplicate, skipped };
	const folderName = options.folderName?.trim();
	if (children.length && folderName) children.push({ name: folderName, type: "folder", children: added });
	else children.push(...added);
	return { children, imported, duplicate, skipped };
}
