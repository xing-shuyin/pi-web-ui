import * as fsPromises from "node:fs/promises";
import { basename, resolve, sep } from "node:path";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import type { MessageAnchor } from "../../../server/protocol.js";
import { sessionLines, mapSessionsConcurrent } from "./session-scan.js";
import { isVisibleOnBranch, selectSessionBranch } from "./session-projection.js";
export { mapSessionsConcurrent } from "./session-scan.js";

export const MAX_TRANSCRIPT_SCAN_BYTES = 16 * 1024 * 1024;

export const MAX_SEARCH_TEXT_CHARS = 256 * 1024;

export function sessionMatchesMetadata(q: string, s: SessionInfo): boolean {
	if (s.name && s.name.toLowerCase().includes(q)) return true;
	if (basename(s.path).toLowerCase().includes(q)) return true;
	if (s.firstMessage.toLowerCase().includes(q)) return true;
	return false;
}

export function messageSearchText(m: { content?: unknown }): string {
	const c = m.content;
	if (typeof c === "string") return c;
	if (!Array.isArray(c)) return "";
	const parts: string[] = [];
	for (const b of c) {
		if (!b || typeof b !== "object") continue;
		const blk = b as { type?: unknown; text?: unknown };
		if (blk.type === "text" && typeof blk.text === "string") parts.push(blk.text);
	}
	return parts.join("\n");
}

export interface SessionSearchMatch {
	matched: boolean;
	anchors: MessageAnchor[];
}

/** 增量扫描时每条记录只需留这些字段：叶链判定（id/parentId/type/timestamp/customType）+ 命中。 */
interface ScanEntry {
	[key: string]: unknown;
	id?: string;
	parentId?: string | null;
	type?: string;
	customType?: string;
	timestamp?: string;
	/** context_edit 专用：被编辑的目标 + null 表示抹掉（不存替换后的正文）。 */
	targetId?: string;
	replacement?: unknown;
	role?: "user" | "assistant";
	messageTimestamp?: number;
}

/**
 * 会话内检索：流式扫完整份文件（叶链要扫完才能判定），再按投影口径过滤。
 * 只留轻量记录（不保留消息正文），所以不受整份文件字节数限制；
 * 但也不能在命中满 cap 时提前 break——那会把后续条目从叶链判定里漏掉。
 */
export async function scanSessionForSearch(
	filePath: string,
	query: string,
	cap = 10,
	signal?: AbortSignal,
): Promise<SessionSearchMatch> {
	signal?.throwIfAborted();
	const result: SessionSearchMatch = { matched: false, anchors: [] };
	const q = query.trim().toLowerCase();
	if (!q) return result;
	const limit = Number.isFinite(cap) ? Math.max(0, Math.floor(cap)) : 10;
	const scanned: ScanEntry[] = [];
	try {
		for await (const line of sessionLines(filePath, signal)) {
			let entry: {
				type?: unknown;
				id?: unknown;
				parentId?: unknown;
				customType?: unknown;
				timestamp?: unknown;
				message?: { role?: unknown; content?: unknown; timestamp?: unknown };
			};
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (!entry || typeof entry !== "object") continue;
			// 所有条目都要进叶链（压缩/标签条目也是消息的父节点），只不保留正文。
			const record: ScanEntry = {};
			if (typeof entry.id === "string") record.id = entry.id;
			if (typeof entry.parentId === "string" || entry.parentId === null) record.parentId = entry.parentId;
			if (typeof entry.type === "string") record.type = entry.type;
			if (typeof entry.customType === "string") record.customType = entry.customType;
			if (typeof entry.timestamp === "string") record.timestamp = entry.timestamp;
			if (entry.type === "context_edit") {
				const edit = entry as { targetId?: unknown; replacement?: unknown };
				if (typeof edit.targetId === "string") record.targetId = edit.targetId;
				record.replacement = edit.replacement === null ? null : {};
			}
			if (entry.type === "message") {
				const message = entry.message;
				if (message?.role === "user" || message?.role === "assistant") {
					if (messageSearchText(message).toLowerCase().includes(q)) {
						record.role = message.role;
						if (typeof message.timestamp === "number" && Number.isFinite(message.timestamp)) {
							record.messageTimestamp = message.timestamp;
						}
					}
				}
			}
			scanned.push(record);
		}
	} catch {
		signal?.throwIfAborted();
	}
	signal?.throwIfAborted();
	const branch = selectSessionBranch(scanned);
	for (const record of scanned) {
		if (!record.role) continue;
		if (!isVisibleOnBranch(branch, record.id)) continue;
		result.matched = true;
		if (typeof record.messageTimestamp === "number" && result.anchors.length < limit) {
			result.anchors.push({ role: record.role, timestamp: record.messageTimestamp });
		}
		if (result.anchors.length >= limit) break;
	}
	return result;
}

export async function collectSessionAnchors(
	filePath: string,
	q: string,
	cap = 10,
	signal?: AbortSignal,
): Promise<MessageAnchor[]> {
	return (await scanSessionForSearch(filePath, q, cap, signal)).anchors;
}

export async function searchSessions(
	sessions: readonly SessionInfo[],
	query: string,
	options: { concurrency?: number; anchorCap?: number; signal?: AbortSignal } = {},
): Promise<Array<{ session: SessionInfo; anchors: MessageAnchor[] }>> {
	const q = query.trim().toLowerCase();
	const results = await mapSessionsConcurrent(
		sessions,
		async (session) => {
			const scan = q
				? await scanSessionForSearch(session.path, q, options.anchorCap, options.signal)
				: { matched: true, anchors: [] };
			return scan.matched || sessionMatchesMetadata(q, session) ? { session, anchors: scan.anchors } : null;
		},
		options.concurrency ?? 4,
		options.signal,
	);
	return results.filter((result): result is NonNullable<typeof result> => result !== null);
}

export function piSessionsRoot(): string | undefined {
	return process.env.PI_CODING_AGENT_SESSION_DIR || undefined;
}

export function isInsideSessionsDir(agentDir: string, targetPath: string): boolean {
	const fold = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
	const abs = fold(resolve(targetPath));
	const roots = [fold(resolve(agentDir, "sessions")), fold(resolve(agentDir, "bot-sessions"))];
	const extra = piSessionsRoot();
	if (extra) roots.push(fold(resolve(extra)));
	return roots.some((root) => abs.startsWith(root + sep));
}

export async function readCwdFromSessionHeader(filePath: string): Promise<string | null> {
	let handle: fsPromises.FileHandle | undefined;
	try {
		handle = await fsPromises.open(filePath, "r");
		const buf = Buffer.alloc(2048);
		const { bytesRead } = await handle.read(buf, 0, 2048, 0);
		const text = buf.toString("utf8", 0, bytesRead);
		const nl = text.indexOf("\n");
		const firstLine = nl !== -1 ? text.slice(0, nl) : text;
		if (!firstLine.trim()) return null;
		const parsed = JSON.parse(firstLine);
		return typeof parsed.cwd === "string" && parsed.cwd.trim() ? parsed.cwd : null;
	} catch {
		return null;
	} finally {
		if (handle) await handle.close().catch(() => {});
	}
}
