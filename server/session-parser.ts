import { existsSync } from "node:fs";
import { sessionLines } from "./session-scan.js";
import { scanSessionListInfo } from "./session-list-scan.js";
import * as fsPromises from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import type { ProjectSummary } from "./protocol.js";
import { normalizePathKey } from "./client-state.js";
import { MAX_SEARCH_TEXT_CHARS, readCwdFromSessionHeader, piSessionsRoot } from "./session-search.js";

export async function discoverRecentProjectsFromDisk(sessionRoots: string[], limit = 30): Promise<ProjectSummary[]> {
	const projects = new Map<string, ProjectSummary>();

	for (const root of sessionRoots) {
		if (projects.size >= limit) break;
		try {
			try {
				await fsPromises.access(root);
			} catch {
				continue;
			}
			const entries = await fsPromises.readdir(root, { withFileTypes: true });

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
								await fsPromises.access(cwd);
								projects.set(key, { path: cwd, lastUsed: s.mtime });
							} catch {}
						}
					}
				}
			}

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
								await fsPromises.access(r.path);
								projects.set(key, r);
							} catch {}
						}
					}
				}
			}
		} catch {}
	}

	return [...projects.values()].sort((a, b) => b.lastUsed - a.lastUsed);
}

export async function parseSessionInfoFast(
	filePath: string,
	fileMtime: number,
	withAllMessagesText = false,
): Promise<SessionInfo | null> {
	if (!withAllMessagesText) return (await scanSessionListInfo(filePath, fileMtime))?.info ?? null;
	try {
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

		for await (const line of sessionLines(filePath)) {
			if (!line.trim()) continue;
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
								const remaining = MAX_SEARCH_TEXT_CHARS - collectedChars;
								const excerpt = text.slice(0, remaining);
								allMessages.push(excerpt);
								collectedChars += excerpt.length + 1;
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

	const parentsOf = new Map<string, string[]>();
	for (const [parentKey, children] of childrenOf) {
		for (const childKey of children) {
			let parents = parentsOf.get(childKey);
			if (!parents) {
				parents = [];
				parentsOf.set(childKey, parents);
			}
			parents.push(parentKey);
		}
	}
	const canReachLeaf = new Set<string>();
	const queue: string[] = [];
	for (const key of byKey.keys()) {
		const children = childrenOf.get(key);
		if (!children || children.size === 0) {
			canReachLeaf.add(key);
			queue.push(key);
		}
	}
	for (let head = 0; head < queue.length; head++) {
		for (const parentKey of parentsOf.get(queue[head]) ?? []) {
			if (canReachLeaf.has(parentKey)) continue;
			canReachLeaf.add(parentKey);
			queue.push(parentKey);
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

export async function findMostRecentSessionFileFast(
	sessionDir: string,
	targetCwd?: string,
): Promise<string | undefined> {
	try {
		let targetDir = sessionDir;
		let dirEntries: string[] = [];
		try {
			await fsPromises.access(targetDir);
			dirEntries = await fsPromises.readdir(targetDir);
		} catch {
			return undefined;
		}
		let jsonlFiles = dirEntries.filter((f) => f.endsWith(".jsonl"));
		const candidateFiles = new Map<string, string>();
		if (jsonlFiles.length > 0) {
			for (const f of jsonlFiles) {
				const fp = join(targetDir, f);
				candidateFiles.set(normalizePathKey(fp), fp);
			}
		} else {
			try {
				const projectDir = SessionManager.create(targetDir).getSessionDir();
				if (existsSync(projectDir)) {
					try {
						const entries = await fsPromises.readdir(projectDir);
						for (const f of entries) {
							if (f.endsWith(".jsonl")) {
								const fp = join(projectDir, f);
								candidateFiles.set(normalizePathKey(fp), fp);
							}
						}
					} catch {}
				}
				const extra = piSessionsRoot();
				if (extra) {
					const resolvedExtra = resolve(extra);
					if (existsSync(resolvedExtra)) {
						try {
							const entries = await fsPromises.readdir(resolvedExtra);
							for (const f of entries) {
								if (f.endsWith(".jsonl")) {
									const fp = join(resolvedExtra, f);
									candidateFiles.set(normalizePathKey(fp), fp);
								}
							}
						} catch {}
						const extraSubdir = join(resolvedExtra, basename(projectDir));
						if (normalizePathKey(extraSubdir) !== normalizePathKey(projectDir) && existsSync(extraSubdir)) {
							try {
								const subEntries = await fsPromises.readdir(extraSubdir);
								for (const f of subEntries) {
									if (f.endsWith(".jsonl")) {
										const fp = join(extraSubdir, f);
										candidateFiles.set(normalizePathKey(fp), fp);
									}
								}
							} catch {}
						}
					}
				}
			} catch {}
		}
		if (candidateFiles.size === 0) return undefined;

		const stats = await Promise.all(
			Array.from(candidateFiles.values()).map(async (fp) => {
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
