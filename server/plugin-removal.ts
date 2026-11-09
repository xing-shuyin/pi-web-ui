import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pluginCodeDir, pluginStateDir } from "./plugin-paths.js";

const ID_RE = /^[a-z0-9][a-z0-9_-]*$/;
const REMOVAL_RE = /^removed-[0-9a-f-]{36}$/;

export function removePlugin(dataDir: string, id: string): { deferred: boolean } {
	if (!ID_RE.test(id)) throw new Error(`Invalid plugin id: ${id}`);
	const target = pluginCodeDir(dataDir, id);
	lstatSync(target);
	const trash = join(dataDir, "plugin-trash");
	mkdirSync(trash, { recursive: true });
	const removed = join(trash, `removed-${randomUUID()}`);
	renameSync(target, removed);
	let deferred = false;
	try {
		rmSync(removed, { recursive: true, force: true });
	} catch {
		deferred = true;
	}
	// 状态独立存放后卸载要连它一起删，否则重装会闦回旧的设置与机密
	const state = pluginStateDir(dataDir, id);
	try {
		if (lstatSync(state).isDirectory()) rmSync(state, { recursive: true, force: true });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			console.warn(`[plugins] 卸载时清理插件状态失败 (${state})：`, err instanceof Error ? err.message : err);
		}
	}
	return { deferred };
}

export function cleanupRemovedPlugins(dataDir: string): void {
	const trash = join(dataDir, "plugin-trash");
	let names: string[];
	try {
		if (lstatSync(trash).isSymbolicLink()) return;
		names = readdirSync(trash);
	} catch {
		return;
	}
	for (const name of names) {
		if (!REMOVAL_RE.test(name)) continue;
		try {
			rmSync(join(trash, name), { recursive: true, force: true });
		} catch {}
	}
}
