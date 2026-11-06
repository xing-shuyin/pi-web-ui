import * as fsPromises from "node:fs/promises";
import { basename, resolve, sep } from "node:path";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import type { MessageAnchor } from "./protocol.js";
import { sessionLines, mapSessionsConcurrent } from "./session-scan.js";
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
	try {
		for await (const line of sessionLines(filePath, signal)) {
			let entry;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (entry?.type !== "message") continue;
			const message = entry.message;
			if (message?.role !== "user" && message?.role !== "assistant") continue;
			if (!messageSearchText(message).toLowerCase().includes(q)) continue;
			result.matched = true;
			if (
				typeof message.timestamp === "number" &&
				Number.isFinite(message.timestamp) &&
				result.anchors.length < limit
			) {
				result.anchors.push({ role: message.role, timestamp: message.timestamp });
			}
			if (result.anchors.length >= limit) break;
		}
	} catch {
		signal?.throwIfAborted();
	}
	signal?.throwIfAborted();
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
