import { appendFileSync, existsSync, readFileSync, statSync, promises as fsPromises } from "node:fs";
import { randomUUID } from "node:crypto";

export type DanglingCause = "restart" | "generic";

const DANGLING_TEXT: Record<DanglingCause, { zh: string; en: string }> = {
	generic: {
		zh: "（系统：上一次运行未正常结束（可能是工具执行超时、模型流卡死或服务中断），该工具调用没有返回结果。为避免对话记录损坏，已自动填入一条合成结果。该命令可能已部分或全部执行，若需重跑请先确认是否会产生重复副作用。）",
		en: "(System: the previous run did not finish cleanly (possibly a tool timeout, a hung model stream, or a service interruption) and this tool call never returned. A synthetic result was inserted automatically to keep the transcript valid. The command may have partly or fully run; confirm before re-running anything with side effects.)",
	},
	restart: {
		zh: "（系统：上一次运行因服务重启被中断，该工具调用没有返回结果——它可能已经执行过。为避免对话记录损坏，已自动填入一条合成结果。重跑前请先确认是否会产生重复副作用（如删除、部署、推送）。）",
		en: "(System: the previous run was interrupted by a service restart and this tool call never returned — it may already have executed. A synthetic result was inserted automatically to keep the transcript valid. Confirm before re-running anything with side effects such as deletes, deploys or pushes.)",
	},
};

export function danglingToolResultText(cause: DanglingCause = "generic"): string {
	const t = DANGLING_TEXT[cause];
	return `${t.zh}\n${t.en}`;
}

export interface DanglingToolCall {
	toolCallId: string;
	toolName: string;
}

interface ContentBlock {
	type?: unknown;
	id?: unknown;
	name?: unknown;
	toolCallId?: unknown;
	toolName?: unknown;
}

function toolCallsOfMessage(msg: unknown): DanglingToolCall[] {
	if (typeof msg !== "object" || msg === null) return [];
	const m = msg as { role?: unknown; content?: unknown; stopReason?: unknown };
	if (m.role !== "assistant" || !Array.isArray(m.content)) return [];
	if (m.stopReason === "error" || m.stopReason === "aborted") return [];
	const out: DanglingToolCall[] = [];
	for (const b of m.content as ContentBlock[]) {
		if (typeof b !== "object" || b === null || b.type !== "toolCall") continue;
		const id = typeof b.id === "string" ? b.id : "";
		if (!id) continue;
		const name = typeof b.name === "string" && b.name ? b.name : "unknown";
		out.push({ toolCallId: id, toolName: name });
	}
	return out;
}

function toolResultIdsOfMessage(msg: unknown): Set<string> {
	const ids = new Set<string>();
	if (typeof msg !== "object" || msg === null) return ids;
	const m = msg as { role?: unknown; toolCallId?: unknown; content?: unknown };
	if (m.role === "toolResult" && typeof m.toolCallId === "string") ids.add(m.toolCallId);
	if (Array.isArray(m.content)) {
		for (const b of m.content as ContentBlock[]) {
			if (typeof b !== "object" || b === null) continue;
			if ((b.type === "toolResult" || b.type === "tool_result") && typeof b.toolCallId === "string") {
				ids.add(b.toolCallId);
			}
		}
	}
	return ids;
}

function messagesOfEntries(entries: unknown[]): unknown[] {
	return entries.map((e) => {
		if (typeof e === "object" && e !== null && "message" in e) {
			const msg = (e as { message?: unknown }).message;
			if (typeof msg === "object" && msg !== null && "role" in msg) return msg;
		}
		return e;
	});
}

export function findDanglingToolCalls(messagesOrEntries: unknown[]): DanglingToolCall[] {
	const messages = messagesOfEntries(messagesOrEntries);
	const calls: { call: DanglingToolCall; index: number }[] = [];
	const results = new Map<string, number[]>();
	messages.forEach((msg, index) => {
		for (const c of toolCallsOfMessage(msg)) calls.push({ call: c, index });
		for (const id of toolResultIdsOfMessage(msg)) {
			let arr = results.get(id);
			if (!arr) {
				arr = [];
				results.set(id, arr);
			}
			arr.push(index);
		}
	});
	const out: DanglingToolCall[] = [];
	const seen = new Set<string>();
	for (const { call, index } of calls) {
		const later = (results.get(call.toolCallId) ?? []).some((ri) => ri > index);
		if (!later && !seen.has(call.toolCallId)) {
			seen.add(call.toolCallId);
			out.push(call);
		}
	}
	return out;
}

export function tailAssistantToolCallIds(entries: unknown[], lastId: string | null): Set<string> {
	if (!lastId) return new Set();
	const byId = new Map<string, unknown>();
	for (const e of entries) {
		if (typeof e === "object" && e !== null && typeof (e as { id?: unknown }).id === "string") {
			byId.set((e as { id: string }).id, e);
		}
	}
	const seen = new Set<string>();
	let cursor: string | null = lastId;
	while (cursor && !seen.has(cursor)) {
		seen.add(cursor);
		const entry = byId.get(cursor);
		if (!entry || typeof entry !== "object") break;
		const msg =
			"message" in entry && typeof (entry as { message?: unknown }).message === "object"
				? (entry as { message: unknown }).message
				: null;
		if (msg && typeof msg === "object" && "role" in msg) {
			const m = msg as { role?: unknown; stopReason?: unknown };
			if (m.role === "user") {
				break;
			}
			if (m.role === "assistant") {
				if (m.stopReason !== "error" && m.stopReason !== "aborted") {
					return new Set(toolCallsOfMessage(m).map((c) => c.toolCallId));
				}
				break;
			}
		}
		cursor =
			typeof (entry as { parentId?: unknown }).parentId === "string" ? (entry as { parentId: string }).parentId : null;
	}
	return new Set();
}

export function healDanglingToolCallFile(filePath: string, cause: DanglingCause = "generic"): number {
	let sig: string | null = null;
	try {
		const st = statSync(filePath);
		sig = `${st.mtimeMs}:${st.size}`;
		if (isDanglingHealthyCached(filePath, sig)) return 0;
	} catch {
		return -1;
	}
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf8");
	} catch {
		return -1;
	}
	const result = healDanglingToolCallsInText(filePath, raw, cause);
	if (result === 0 && sig) rememberHealthyDangling(filePath, sig);
	else healthyDanglingCache.delete(filePath);
	return result;
}

const healthyDanglingCache = new Map<string, string>();
const HEALTHY_DANGLING_CACHE_MAX = 512;

export function isDanglingHealthyCached(filePath: string, sig: string): boolean {
	if (healthyDanglingCache.get(filePath) !== sig) return false;
	healthyDanglingCache.delete(filePath);
	healthyDanglingCache.set(filePath, sig);
	return true;
}

export function rememberHealthyDangling(filePath: string, sig: string): void {
	healthyDanglingCache.delete(filePath);
	healthyDanglingCache.set(filePath, sig);
	while (healthyDanglingCache.size > HEALTHY_DANGLING_CACHE_MAX) {
		const oldest = healthyDanglingCache.keys().next();
		if (oldest.done) break;
		healthyDanglingCache.delete(oldest.value);
	}
}

export function forgetHealthyDangling(filePath: string): void {
	healthyDanglingCache.delete(filePath);
}

export function resetHealthyDanglingCacheForTest(): void {
	healthyDanglingCache.clear();
}

const HEADER_SCAN_CHARS = 260;
const FULL_PARSE_MAX_LINE = 512;

interface LineHeader {
	id: string | null;
	parentId: string | null;
	entry: Record<string, unknown> | null;
}

function parseLineFully(line: string): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(line);
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function lineHeader(line: string): LineHeader | null {
	if (line.length > FULL_PARSE_MAX_LINE) {
		const head = line.slice(0, HEADER_SCAN_CHARS);
		const brace = head.indexOf("{", 1);
		const topLevel = brace === -1 ? head : head.slice(0, brace);
		if (topLevel.startsWith("{")) {
			const idMatch = /"id"\s*:\s*"([^"\\]+)"/.exec(topLevel);
			const parentStr = /"parentId"\s*:\s*"([^"\\]*)"/.exec(topLevel);
			const parentNull = !parentStr && /"parentId"\s*:\s*null/.test(topLevel);
			if (idMatch && (parentStr || parentNull)) {
				return { id: idMatch[1], parentId: parentStr ? parentStr[1] : null, entry: null };
			}
		}
	}
	const entry = parseLineFully(line);
	if (!entry) return null;
	return {
		id: typeof entry.id === "string" ? entry.id : null,
		parentId: typeof entry.parentId === "string" ? entry.parentId : null,
		entry,
	};
}

export function healDanglingToolCallsInText(filePath: string, raw: string, cause: DanglingCause = "generic"): number {
	const lines = raw.split("\n");
	const chain = scanTailChain(lines, true);
	const dangling = danglingCallsOf(chain, lines);
	if (dangling.length === 0 || !chain.lastId) return 0;
	return appendDanglingResults(filePath, chain.lastId, dangling, cause);
}

interface TailChain {
	/** 最后一条带字符串 id 的条目（追加合成结果的 parentId 起点） */
	lastId: string | null;
	/** 尾部 assistant 消息的下标（-1 = 没有） */
	tailIndex: number;
	tailIds: Set<string>;
	/** 父链走出窗口（窗口没覆盖文件开头时可能只是窗口太小，需要更大窗口） */
	escaped: boolean;
}

/**
 * 沿 parentId 从最后一条回溯，找出「尾部 assistant 消息 + 它的工具调用 id」。
 *
 * `atFileStart` 为 false 时 `lines` 只是文件尾部的窗口：链走出窗口会标 `escaped`，
 * 由调用方决定扩大窗口还是回退整份读取。
 */
function scanTailChain(lines: string[], atFileStart: boolean): TailChain {
	const headers: (LineHeader | null)[] = new Array(lines.length).fill(null);
	const byId = new Map<string, number>();
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line.trim()) continue;
		const h = lineHeader(line);
		headers[i] = h;
		if (h?.id) byId.set(h.id, i);
	}
	const fullEntry = (i: number): Record<string, unknown> | null => {
		const h = headers[i];
		if (!h) return null;
		if (!h.entry) h.entry = parseLineFully(lines[i]);
		return h.entry;
	};

	let lastId: string | null = null;
	for (let i = lines.length - 1; i >= 0; i--) {
		if (!headers[i]) continue;
		const e = fullEntry(i);
		if (!e) {
			headers[i] = null;
			continue;
		}
		if (typeof e.id === "string") {
			lastId = e.id;
			break;
		}
	}
	if (!lastId) return { lastId: null, tailIndex: -1, tailIds: new Set(), escaped: !atFileStart };

	let tailIndex = -1;
	let tailIds = new Set<string>();
	const seen = new Set<string>();
	let cursor: string | null = lastId;
	while (cursor && !seen.has(cursor)) {
		seen.add(cursor);
		const idx = byId.get(cursor);
		if (idx === undefined) return { lastId, tailIndex, tailIds, escaped: !atFileStart };
		const entry = fullEntry(idx);
		if (!entry) break;
		const msg = typeof entry.message === "object" && entry.message !== null ? entry.message : null;
		if (msg && "role" in msg) {
			const m = msg as { role?: unknown; stopReason?: unknown };
			if (m.role === "user") break;
			if (m.role === "assistant") {
				if (m.stopReason !== "error" && m.stopReason !== "aborted") {
					tailIds = new Set(toolCallsOfMessage(m).map((c) => c.toolCallId));
					tailIndex = idx;
				}
				break;
			}
		}
		cursor = typeof entry.parentId === "string" ? entry.parentId : null;
	}
	return { lastId, tailIndex, tailIds, escaped: false };
}

function danglingCallsOf(chain: TailChain, lines: string[]): DanglingToolCall[] {
	if (chain.tailIds.size === 0 || chain.tailIndex < 0) return [];
	const after: unknown[] = [];
	for (let i = chain.tailIndex; i < lines.length; i++) {
		const e = parseLineFully(lines[i]);
		if (e) after.push(e);
	}
	return findDanglingToolCalls(after).filter((d) => chain.tailIds.has(d.toolCallId));
}

/** 为悬空工具调用追加合成结果（一条一条串到 `lastId` 后面），返回追加条数；失败 -1。 */
export function appendDanglingResults(
	filePath: string,
	lastId: string,
	dangling: DanglingToolCall[],
	cause: DanglingCause = "generic",
): number {
	if (dangling.length === 0) return 0;
	try {
		let parentId = lastId;
		for (const d of dangling) {
			const id = `synthetic-tool-result-${randomUUID().slice(0, 8)}`;
			const entry = {
				type: "message",
				id,
				parentId,
				timestamp: new Date().toISOString(),
				message: {
					role: "toolResult",
					toolCallId: d.toolCallId,
					toolName: d.toolName,
					content: [{ type: "text", text: danglingToolResultText(cause) }],
					isError: true,
					timestamp: Date.now(),
				},
			};
			const line = JSON.stringify(entry);
			if (!existsSync(filePath)) return -1;
			appendFileSync(filePath, `${line}\n`, "utf8");
			parentId = id;
		}
		return dangling.length;
	} catch {
		return -1;
	}
}

/** 尾部窗口逐级放大：绝大多数转录第一个窗口就能判定 */
const TAIL_WINDOWS = [256 * 1024, 1024 * 1024, 4 * 1024 * 1024, 16 * 1024 * 1024];

export interface TailDanglingProbe {
	/** 文件末尾最后一条带 id 的条目（`dangling` 非空时必有） */
	lastId: string | null;
	dangling: DanglingToolCall[];
}

/**
 * 只读文件尾部判定尾部悬空工具调用（打开前快路径，issue #945）。
 *
 * 返回 `null` = 窗口内无法判定（父链走出最大窗口），调用方应回退到整份读取。
 * 只在「修复必然不动文件」的转录上使用：那时没有重复 id，窗口内按 id 回溯与整份读取等价。
 */
export async function probeTailDangling(filePath: string): Promise<TailDanglingProbe | null> {
	let fh: fsPromises.FileHandle;
	try {
		fh = await fsPromises.open(filePath, "r");
	} catch {
		return null;
	}
	try {
		const size = (await fh.stat()).size;
		if (size <= 0) return null;
		for (const windowBytes of TAIL_WINDOWS) {
			const take = Math.min(size, windowBytes);
			const atFileStart = take >= size;
			const buf = Buffer.allocUnsafe(take);
			const { bytesRead } = await fh.read(buf, 0, take, size - take);
			let text = buf.subarray(0, bytesRead).toString("utf8");
			if (!atFileStart) {
				const nl = text.indexOf("\n");
				if (nl < 0) continue; // 整窗都是一行（超长行），换更大窗口
				text = text.slice(nl + 1); // 丢掉窗口首行残片
			}
			const lines = text.split("\n");
			const chain = scanTailChain(lines, atFileStart);
			if (chain.escaped) continue;
			return { lastId: chain.lastId, dangling: danglingCallsOf(chain, lines) };
		}
		return null;
	} catch {
		return null;
	} finally {
		await fh.close().catch(() => {});
	}
}
