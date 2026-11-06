import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

const ID_RE = /^[a-z0-9][a-z0-9_-]*$/;
const REMOVAL_RE = /^removed-[0-9a-f-]{36}$/;

export function removePlugin(dataDir: string, id: string): { deferred: boolean } {
	if (!ID_RE.test(id)) throw new Error(`Invalid plugin id: ${id}`);
	const target = join(dataDir, "plugins", id);
	lstatSync(target);
	const trash = join(dataDir, "plugin-trash");
	mkdirSync(trash, { recursive: true });
	const removed = join(trash, `removed-${randomUUID()}`);
	renameSync(target, removed);
	try {
		rmSync(removed, { recursive: true, force: true });
		return { deferred: false };
	} catch {
		return { deferred: true };
	}
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
