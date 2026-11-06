import { promises as fsPromises } from "node:fs";
import { dirname, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const SLICE_MS = 8;

export interface ParsedJsonl {
	entries: Record<string, unknown>[];
	tail: string;
}

export async function parseJsonlSliced(raw: string, sliceMs = SLICE_MS): Promise<ParsedJsonl> {
	const entries: Record<string, unknown>[] = [];
	let start = 0;
	let sliceStart = performance.now();
	const take = (line: string) => {
		if (!line.trim()) return;
		try {
			const v = JSON.parse(line) as unknown;
			if (v) entries.push(v as Record<string, unknown>);
		} catch {}
	};
	for (;;) {
		const nl = raw.indexOf("\n", start);
		if (nl === -1) break;
		take(raw.slice(start, nl));
		start = nl + 1;
		if (performance.now() - sliceStart >= sliceMs) {
			await setImmediate();
			sliceStart = performance.now();
		}
	}
	const tail = raw.slice(start);
	take(tail);
	return { entries, tail };
}

type SessionManagerCtor = new (
	cwd: string,
	sessionDir: string,
	sessionFile: string,
	persist: boolean,
	newSessionOptions: undefined,
	preloadedFileEntries: unknown[],
) => SessionManager;

export async function openSessionManagerAsync(path: string): Promise<SessionManager> {
	const resolvedPath = resolve(path);
	if (process.env.PI_WEB_ASYNC_SESSION_OPEN === "0") return SessionManager.open(resolvedPath);
	let raw: string;
	try {
		raw = await fsPromises.readFile(resolvedPath, "utf8");
	} catch {
		return SessionManager.open(resolvedPath);
	}
	const { entries, tail } = await parseJsonlSliced(raw);
	const header = entries[0];
	if (!header || header.type !== "session" || typeof header.id !== "string") {
		return SessionManager.open(resolvedPath);
	}
	try {
		if (tail) await fsPromises.appendFile(resolvedPath, "\n");
		const cwd = typeof header.cwd === "string" ? header.cwd : process.cwd();
		const Ctor = SessionManager as unknown as SessionManagerCtor;
		const manager = new Ctor(cwd, dirname(resolvedPath), resolvedPath, true, undefined, entries);
		const file = manager.getSessionFile();
		const ok =
			typeof file === "string" &&
			resolve(file) === resolvedPath &&
			manager.getSessionId() === header.id &&
			manager.getEntries().length === entries.length - 1;
		if (!ok) return SessionManager.open(resolvedPath);
		return manager;
	} catch {
		return SessionManager.open(resolvedPath);
	}
}
