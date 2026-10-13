/**
 * session-parser — 会话转录快速轻量解析器与磁盘项目发现。
 *
 * 负责：
 * - parseSessionInfoFast: 快速解析单个会话文件头部和消息，提取元信息，按需截断收集全文
 * - discoverRecentProjectsFromDisk: 遍历会话根目录，按最近修改时间轻量发现使用过的项目路径
 *
 * 从 agent-service.ts 抽出为独立模块。
 */
import * as fsPromises from "node:fs/promises";
import { join } from "node:path";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import type { ProjectSummary } from "./protocol.js";
import { normalizePathKey } from "./client-state.js";
import { MAX_SEARCH_TEXT_CHARS, readCwdFromSessionHeader } from "./session-search.js";

/**
 * 快速轻量地从 SDK 会话目录中发现项目路径（仅读取会话文件的第一行头部获取 cwd，
 * 绝不使用 SessionManager.listAll 遍历解析全部会话文本，避免大历史时阻塞数秒到数十秒）。
 */
export async function discoverRecentProjectsFromDisk(sessionRoots: string[], limit = 30): Promise<ProjectSummary[]> {
	const projects = new Map<string, ProjectSummary>();

	for (const root of sessionRoots) {
		if (projects.size >= limit) break;
		try {
			// 异步探测（issue #441）：会话根可能在已断连的网络盘上，同步 existsSync 会冻结事件循环。
			try {
				await fsPromises.access(root);
			} catch {
				continue;
			}
			const entries = await fsPromises.readdir(root, { withFileTypes: true });

			// 1. 扁平布局（PI_CODING_AGENT_SESSION_DIR）：根目录下直接是 .jsonl
			const flatFiles = entries.filter((e) => e.isFile() && e.name.endsWith(".jsonl"));
			if (flatFiles.length > 0) {
				const fileStats = await Promise.all(
					flatFiles.map(async (f) => {
						const fp = join(root, f.name);
						try {
							const st = await fsPromises.stat(fp);
							return { path: fp, mtime: st.mtimeMs };
						} catch {
							return null;
						}
					}),
				);
				fileStats.sort((a, b) => (b?.mtime ?? 0) - (a?.mtime ?? 0));
				for (const s of fileStats) {
					if (!s || projects.size >= limit) break;
					const cwd = await readCwdFromSessionHeader(s.path);
					if (cwd) {
						const key = normalizePathKey(cwd);
						if (!projects.has(key)) {
							try {
								// 异步探测（issue #441）：cwd 可能在已断连的网络盘上。
								await fsPromises.access(cwd);
								projects.set(key, { path: cwd, lastUsed: s.mtime });
							} catch {}
						}
					}
				}
			}

			// 2. 默认子目录布局（<agentDir>/sessions/--<cwd>--/）：每 cwd 一个子目录
			const subdirs = entries.filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => join(root, e.name));
			if (subdirs.length > 0 && projects.size < limit) {
				const CHUNK = 64;
				const dirStats: { path: string; mtime: number }[] = [];
				for (let i = 0; i < subdirs.length; i += CHUNK) {
					const chunk = subdirs.slice(i, i + CHUNK);
					const stats = await Promise.all(
						chunk.map(async (dir) => {
							try {
								const st = await fsPromises.stat(dir);
								return { path: dir, mtime: st.mtimeMs };
							} catch {
								return null;
							}
						}),
					);
					for (const s of stats) if (s) dirStats.push(s);
				}
				dirStats.sort((a, b) => b.mtime - a.mtime);

				for (let i = 0; i < dirStats.length; i += 16) {
					if (projects.size >= limit) break;
					const batch = dirStats.slice(i, i + 16);
					const batchRes = await Promise.all(
						batch.map(async (d) => {
							try {
								const files = await fsPromises.readdir(d.path);
								const jsonls = files.filter((f) => f.endsWith(".jsonl"));
								if (jsonls.length === 0) return null;
								const fileStats = await Promise.all(
									jsonls.map(async (f) => {
										const fp = join(d.path, f);
										try {
											const st = await fsPromises.stat(fp);
											return { fp, mtimeMs: st.mtimeMs };
										} catch {
											return null;
										}
									}),
								);
								let newestFile = "";
								let newestMtime = 0;
								for (const item of fileStats) {
									if (item && item.mtimeMs > newestMtime) {
										newestMtime = item.mtimeMs;
										newestFile = item.fp;
									}
								}
								if (!newestFile) return null;
								const cwd = await readCwdFromSessionHeader(newestFile);
								if (!cwd) return null;
								return { path: cwd, lastUsed: newestMtime };
							} catch {
								return null;
							}
						}),
					);

					for (const r of batchRes) {
						if (!r) continue;
						const key = normalizePathKey(r.path);
						if (!projects.has(key)) {
							try {
								// 异步探测（issue #441）：cwd 可能在已断连的网络盘上。
								await fsPromises.access(r.path);
								projects.set(key, r);
							} catch {}
						}
					}
				}
			}
		} catch {
			/* best effort */
		}
	}

	return [...projects.values()].sort((a, b) => b.lastUsed - a.lastUsed);
}

/**
 * 快速解析单个会话文件（提取 id/cwd/name/parentSessionPath/firstMessage/messageCount/modified，
 * 以及可选的转录全文 allMessagesText）。仅用于会话列表发现与搜索，避免调用 SDK 重型的全量树解析。
 *
 * withAllMessagesText=false（默认，列表路径）时不收集转录全文，allMessagesText 返回空串 ——
 * 全文单条可达 MB 级，绝不随列表进任何缓存（issue #440）；true（搜索路径）时收集全文并在
 * MAX_SEARCH_TEXT_CHARS 处截断。
 */
export async function parseSessionInfoFast(
	filePath: string,
	fileMtime: number,
	withAllMessagesText = false,
): Promise<SessionInfo | null> {
	try {
		const content = await fsPromises.readFile(filePath, "utf8");
		const lines = content.split("\n");
		let id = "";
		let cwd = "";
		let name: string | undefined;
		let parentSessionPath: string | undefined;
		let firstMessage = "";
		let messageCount = 0;
		let lastActivityTime = 0;
		let headerTime = 0;
		const allMessages: string[] | null = withAllMessagesText ? [] : null;
		let collectedChars = 0;

		for (const line of lines) {
			if (!line.trim()) continue;
			// 列表路径（withAllMessagesText=false）已拿到 id 与首条消息后，跳过对大块长行
			// （如数百 KB 的 toolResult/assistant 消息）的全量 JSON.parse：仅轻量计数并提取时间戳
			if (!withAllMessagesText && id && firstMessage && line.length > 512 && !line.includes('"session_info"')) {
				const head = line.slice(0, 140);
				if (/"type"\s*:\s*"message"/.test(head)) {
					messageCount++;
					const tsMatch = /"timestamp"\s*:\s*(\d{10,16})/.exec(line);
					if (tsMatch) {
						const ts = Number(tsMatch[1]);
						if (ts > lastActivityTime) lastActivityTime = ts;
					}
				}
				continue;
			}
			let entry: unknown;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			const rec = entry as Record<string, unknown> | null;
			if (!rec) continue;
			if (rec.type === "session") {
				id = typeof rec.id === "string" ? rec.id : "";
				cwd = typeof rec.cwd === "string" ? rec.cwd : "";
				if (typeof rec.timestamp === "string") headerTime = new Date(rec.timestamp).getTime();
				if (typeof rec.parentSession === "string") parentSessionPath = rec.parentSession;
			} else if (rec.type === "session_info") {
				if (typeof rec.name === "string" && rec.name.trim()) name = rec.name.trim();
			} else if (rec.type === "message") {
				messageCount++;
				const msg = rec.message as Record<string, unknown> | null;
				if (msg) {
					if (typeof msg.timestamp === "number") lastActivityTime = Math.max(lastActivityTime, msg.timestamp);
					const needText =
						(!firstMessage && msg.role === "user") || (allMessages !== null && collectedChars < MAX_SEARCH_TEXT_CHARS);
					if (needText) {
						let text = "";
						if (typeof msg.content === "string") {
							text = msg.content;
						} else if (Array.isArray(msg.content)) {
							for (const part of msg.content) {
								if (part && typeof part.text === "string") {
									text += (text ? " " : "") + part.text;
								}
							}
						}
						if (text) {
							if (!firstMessage && msg.role === "user") firstMessage = text;
							if (allMessages && collectedChars < MAX_SEARCH_TEXT_CHARS) {
								allMessages.push(text);
								collectedChars += text.length + 1;
							}
						}
					}
				}
			}
		}

		if (!id) return null;
		const modified = lastActivityTime > 0 ? lastActivityTime : headerTime > 0 ? headerTime : fileMtime;
		let allMessagesText = "";
		if (allMessages) {
			const joined = allMessages.join(" ");
			allMessagesText = joined.length > MAX_SEARCH_TEXT_CHARS ? joined.slice(0, MAX_SEARCH_TEXT_CHARS) : joined;
		}
		return {
			path: filePath,
			id,
			cwd,
			name,
			parentSessionPath,
			created: new Date(headerTime || fileMtime),
			modified: new Date(modified),
			messageCount,
			firstMessage: firstMessage || "(no messages)",
			allMessagesText,
		};
	} catch {
		return null;
	}
}

/**
 * 历史会话列表的 fork 父会话过滤：
 * - `showForkedParents === true` 时保留全部会话（父会话与子会话同时显示）；
 * - `showForkedParents === false`（默认）时隐藏「已被后续分支派生、且该分支链上存在叶子会话」的父会话，
 *   仅保留每条 fork 链最新的链尾叶子会话；
 * - 若某条链因异常形成纯环（无叶子）或自环，环上节点保留而不整条隐藏。
 */
export function filterForkedParentSessions<T extends { path: string; parentSessionPath?: string }>(
	infos: T[],
	showForkedParents = false,
): T[] {
	if (showForkedParents || infos.length <= 1) return infos;
	const byKey = new Map<string, T>();
	for (const info of infos) {
		byKey.set(normalizePathKey(info.path), info);
	}
	const childrenOf = new Map<string, Set<string>>();
	for (const info of infos) {
		if (typeof info.parentSessionPath !== "string" || !info.parentSessionPath) continue;
		const childKey = normalizePathKey(info.path);
		const parentKey = normalizePathKey(info.parentSessionPath);
		if (!parentKey || parentKey === childKey || !byKey.has(parentKey)) continue;
		let set = childrenOf.get(parentKey);
		if (!set) {
			set = new Set<string>();
			childrenOf.set(parentKey, set);
		}
		set.add(childKey);
	}
	if (childrenOf.size === 0) return infos;

	const canReachLeaf = new Set<string>();
	for (const key of byKey.keys()) {
		const children = childrenOf.get(key);
		if (!children || children.size === 0) {
			canReachLeaf.add(key);
		}
	}
	let changed = true;
	while (changed) {
		changed = false;
		for (const [parentKey, children] of childrenOf.entries()) {
			if (canReachLeaf.has(parentKey)) continue;
			for (const childKey of children) {
				if (canReachLeaf.has(childKey)) {
					canReachLeaf.add(parentKey);
					changed = true;
					break;
				}
			}
		}
	}

	const kept = infos.filter((info) => {
		const key = normalizePathKey(info.path);
		const children = childrenOf.get(key);
		if (!children || children.size === 0) return true;
		return !canReachLeaf.has(key);
	});
	return kept.length > 0 ? kept : infos;
}

/**
 * 极速定位指定目录下最近修改的单个有效会话文件路径（用于 attach/恢复 判定，毫秒级返回）。
 *
 * 绝不使用 SessionManager.list 递归全量加载解析全部历史消息（大历史会有数百个文件、
 * 几百兆 JSON 反序列化耗时数十秒，严重饿死 Node 事件循环）。
 *
 * 逻辑：
 * 1. 扫描目录下的 .jsonl 文件；
 * 2. 按 mtime 降序排序；
 * 3. 逐个轻量探测（仅读首行 cwd，使用 readCwdFromSessionHeader）；
 * 4. 找到首个匹配 targetCwd（若指定）的有效会话文件后立即返回；若未指定 targetCwd 则直接返回最新文件的路径。
 */
export async function findMostRecentSessionFileFast(
	sessionDir: string,
	targetCwd?: string,
): Promise<string | undefined> {
	try {
		try {
			await fsPromises.access(sessionDir);
		} catch {
			return undefined;
		}
		const dirEntries = await fsPromises.readdir(sessionDir);
		const jsonlFiles = dirEntries.filter((f) => f.endsWith(".jsonl"));
		if (jsonlFiles.length === 0) return undefined;

		const stats = await Promise.all(
			jsonlFiles.map(async (f) => {
				const fp = join(sessionDir, f);
				try {
					const st = await fsPromises.stat(fp);
					return { path: fp, mtime: st.mtimeMs };
				} catch {
					return null;
				}
			}),
		);
		const validStats = stats.filter((s): s is { path: string; mtime: number } => s !== null);
		validStats.sort((a, b) => b.mtime - a.mtime);

		if (!targetCwd) {
			return validStats[0]?.path;
		}

		const targetKey = normalizePathKey(targetCwd);
		for (const item of validStats) {
			const headerCwd = await readCwdFromSessionHeader(item.path);
			if (headerCwd && normalizePathKey(headerCwd) === targetKey) {
				return item.path;
			}
		}
		return validStats[0]?.path;
	} catch {
		return undefined;
	}
}
