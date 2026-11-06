import { existsSync, readFileSync } from "node:fs";
import {
	readFile as fspReadFile,
	readdir as fspReaddir,
	rm as fspRm,
	mkdir as fspMkdir,
	writeFile as fspWriteFile,
	appendFile as fspAppendFile,
	stat as fspStat,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { writeAtomicSync } from "./atomic-file.js";
import { SETTINGS_SECRETS_KEY } from "./plugin-secrets.js";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { isInsideRoot, realPathOfNearest } from "./plugin-project.js";

function atomicWrite(file: string, data: string): void {
	writeAtomicSync(file, data);
}

const rmwChains = new Map<string, Promise<unknown>>();

export function withFileRmwLockSync<T>(file: string, fn: () => T): T {
	if (rmwChains.has(resolve(file))) throw new Error("Plugin storage is busy; retry settings save");
	return fn();
}

export function withFileRmwLock<T>(file: string, fn: () => T): T | Promise<T> {
	const key = resolve(file);
	const prev = rmwChains.get(key);
	const result = prev ? (prev.then(fn, fn) as Promise<T>) : fn();
	if (result instanceof Promise) {
		const tail = result
			.then(
				() => undefined,
				() => undefined,
			)
			.finally(() => {
				if (rmwChains.get(key) === tail) rmwChains.delete(key);
			});
		rmwChains.set(key, tail);
		return tail.then(() => result);
	}
	return result;
}

export class PluginStorage {
	private cache: Record<string, unknown> | undefined;
	constructor(private readonly file: string) {}

	private readFromDisk(): Record<string, unknown> {
		let text: string;
		try {
			text = readFileSync(this.file, "utf8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
			throw err;
		}
		const parsed: unknown = JSON.parse(text);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid plugin storage");
		return parsed as Record<string, unknown>;
	}

	private load(): Record<string, unknown> {
		const committed = this.readFromDisk();
		this.cache = committed;
		return this.cache;
	}

	private commit(candidate: Record<string, unknown>): void {
		const serialized = JSON.stringify(candidate);
		const committed = JSON.parse(serialized) as Record<string, unknown>;
		atomicWrite(this.file, serialized);
		this.cache = committed;
	}

	get<T>(key: string, fallback?: T): T | undefined {
		if (key === SETTINGS_SECRETS_KEY) return fallback;
		const v = this.load()[key];
		return v === undefined ? fallback : (v as T);
	}

	all(): Record<string, unknown> {
		return Object.fromEntries(Object.entries(this.load()).filter(([key]) => key !== SETTINGS_SECRETS_KEY));
	}

	set(key: string, value: unknown): void {
		if (!key) throw new Error("storage.set: key 不能为空");
		if (key === SETTINGS_SECRETS_KEY) throw new Error("Reserved plugin storage key");
		withFileRmwLockSync(this.file, () => {
			const candidate = { ...this.readFromDisk(), [key]: value };
			this.commit(candidate);
		});
	}

	has(key: string): boolean {
		return key !== SETTINGS_SECRETS_KEY && key in this.load();
	}

	keys(): string[] {
		return Object.keys(this.load()).filter((key) => key !== SETTINGS_SECRETS_KEY);
	}

	clear(preserveSettings = true): void {
		withFileRmwLockSync(this.file, () => {
			const store = this.readFromDisk();
			const candidate: Record<string, unknown> = {};
			if (SETTINGS_SECRETS_KEY in store) candidate[SETTINGS_SECRETS_KEY] = store[SETTINGS_SECRETS_KEY];
			if (preserveSettings && "settings" in store) candidate.settings = store.settings;
			this.commit(candidate);
		});
	}

	delete(key: string): void {
		if (key === SETTINGS_SECRETS_KEY) throw new Error("Reserved plugin storage key");
		withFileRmwLockSync(this.file, () => {
			const candidate = this.readFromDisk();
			if (!Object.hasOwn(candidate, key)) return;
			delete candidate[key];
			this.commit(candidate);
		});
	}
}

export { PluginSecrets } from "./plugin-secrets.js";

const DEP_TIMEOUT_MS = 180_000;

export function depName(spec: string): string {
	const m = /^(?:(@[^/\s]+\/[^/\s@]+)|([^/\s@:.]+))(?:@[^/\s]*)?$/.exec(str(spec));
	if (!m) return spec;
	return m[1] ?? m[2] ?? spec;
}

function str(v: unknown): string {
	return typeof v === "string" ? v.trim() : "";
}

function isPlainPackageName(name: string): boolean {
	return /^(?:@[a-z\d](?:[a-z\d._-]*[a-z\d])?\/)?[a-z\d](?:[a-z\d._-]*[a-z\d])?$/i.test(name);
}

function depOnDisk(fromDir: string, name: string): boolean {
	let dir = fromDir;
	for (;;) {
		try {
			if (existsSync(join(dir, "node_modules", ...name.split("/"), "package.json"))) return true;
		} catch {}
		const up = dirname(dir);
		if (!up || up === dir) return false;
		dir = up;
	}
}

export function isDepAvailable(pluginDir: string, spec: string): boolean {
	const name = depName(spec);
	try {
		createRequire(join(pluginDir, "index.mjs")).resolve(name);
		return true;
	} catch {
		return isPlainPackageName(name) && depOnDisk(pluginDir, name);
	}
}

const depInstallLocks = new Map<string, Promise<boolean>>();

export function ensurePluginDeps(
	pluginDir: string,
	specs: string[],
	onProgress?: (msg: string) => void,
): Promise<boolean> {
	if (specs.length === 0) return Promise.resolve(true);
	const missing = specs.filter((s) => !isDepAvailable(pluginDir, s));
	if (missing.length === 0) return Promise.resolve(true);

	const lockKey = join(pluginDir, missing.sort().join("|"));
	const inflight = depInstallLocks.get(lockKey);
	if (inflight) return inflight;

	const run = async (): Promise<boolean> => {
		if (!existsSync(join(pluginDir, "package.json"))) {
			try {
				atomicWrite(
					join(pluginDir, "package.json"),
					JSON.stringify({ name: "plugin-runtime-deps", private: true }, null, 2),
				);
			} catch {}
		}
		onProgress?.(`正在安装依赖：${missing.join(", ")}…（首次约需几分钟）`);
		const isWin = process.platform === "win32";
		const spawnCmd = isWin ? process.env.ComSpec || "cmd.exe" : "npm";
		const runNpmInstall = (extraFlags: string[]) => {
			const spawnArgs = isWin
				? ["/d", "/s", "/c", "npm.cmd", "install", "--no-audit", "--no-fund", ...extraFlags, ...missing]
				: ["install", "--no-audit", "--no-fund", ...extraFlags, ...missing];
			return spawnSync(spawnCmd, spawnArgs, {
				cwd: pluginDir,
				timeout: DEP_TIMEOUT_MS,
				windowsHide: true,
				encoding: "utf8",
			});
		};
		let res = runNpmInstall([]);
		if (res.error || res.status !== 0) {
			res = runNpmInstall(["--ignore-scripts"]);
		}
		if (res.error || res.status !== 0) {
			console.error(`[plugin-deps] ${join(pluginDir)} npm install 失败:`, res.error ?? res.stderr?.slice(0, 500));
			return false;
		}
		const stillMissing = specs.filter((s) => !isDepAvailable(pluginDir, s));
		if (stillMissing.length) {
			console.error(`[plugin-deps] 安装完成但仍缺：${stillMissing.join(", ")}`);
			return false;
		}
		onProgress?.("依赖安装完成");
		return true;
	};
	const p = run().finally(() => depInstallLocks.delete(lockKey));
	depInstallLocks.set(lockKey, p);
	return p;
}

export interface WsEntry {
	name: string;
	type: "file" | "dir";
}

export interface WsStat {
	name: string;
	type: "file" | "dir";
	size: number;
	mtime: number;
}

const GLOB_MAX_WALK = 2000;
const GLOB_MAX_RESULTS = 500;

export function globToRegExp(pattern: string): RegExp {
	const src = String(pattern ?? "")
		.trim()
		.replace(/\\/g, "/");
	let re = "";
	for (let i = 0; i < src.length; i++) {
		const c = src[i];
		if (c === "*") {
			if (src[i + 1] === "*") {
				if (src[i + 2] === "/") {
					re += "(?:.*/)?";
					i += 2;
				} else {
					re += ".*";
					i += 1;
				}
			} else {
				re += "[^/]*";
			}
		} else if (c === "?") {
			re += "[^/]";
		} else {
			re += c.replace(/[.+^${}()|[\]\\]/, (m) => `\\${m}`);
		}
	}
	return new RegExp(`^${re}$`);
}

export class WorkspaceFS {
	constructor(private readonly root: () => string) {}

	private abs(rel: unknown): string {
		const rootDir = resolve(this.root());
		const target = resolve(rootDir, typeof rel === "string" ? rel : "");
		if (target !== rootDir && !target.startsWith(rootDir + sepOf())) {
			throw new Error(`路径越界：${String(rel)}`);
		}
		return target;
	}

	private assertRealInsideRoot(rel: unknown): void {
		const target = this.abs(rel);
		const targetReal = realPathOfNearest(target);
		if (!targetReal) throw new Error(`路径越界：无法解析真实路径 ${String(rel)}`);
		const rootDir = resolve(this.root());
		const rootReal = realPathOfNearest(rootDir) ?? rootDir;
		if (!isInsideRoot(rootReal, targetReal)) {
			throw new Error(`路径越界（符号链接指向工作区之外）：${String(rel)}`);
		}
	}

	async list(relDir = ""): Promise<WsEntry[]> {
		try {
			const dirents = await fspReaddir(this.abs(relDir), { withFileTypes: true });
			return dirents
				.slice(0, 2000)
				.map((d) => ({ name: d.name, type: d.isDirectory() ? ("dir" as const) : ("file" as const) }));
		} catch (err) {
			throw new Error(`读取目录失败：${(err as Error).message}`);
		}
	}

	async read(relPath: string): Promise<Buffer> {
		return fspReadFile(this.abs(relPath));
	}

	async readText(relPath: string, maxBytes = 512 * 1024): Promise<string> {
		const buf = await this.read(relPath);
		return buf.subarray(0, maxBytes).toString("utf8");
	}

	async write(relPath: string, data: string | Uint8Array): Promise<void> {
		this.assertRealInsideRoot(relPath);
		const target = this.abs(relPath);
		await fspMkdir(dirname(target), { recursive: true });
		await fspWriteFile(target, data);
	}

	async append(relPath: string, data: string | Uint8Array): Promise<void> {
		this.assertRealInsideRoot(relPath);
		const target = this.abs(relPath);
		await fspMkdir(dirname(target), { recursive: true });
		await fspAppendFile(target, data);
	}

	async mkdir(relDir: string): Promise<void> {
		this.assertRealInsideRoot(relDir);
		await fspMkdir(this.abs(relDir), { recursive: true });
	}

	async stat(relPath: string): Promise<WsStat> {
		const target = this.abs(relPath);
		const st = await fspStat(target);
		const base =
			target
				.replace(/[/\\]+$/, "")
				.split("/")
				.pop() ?? String(relPath);
		return {
			name: base,
			type: st.isDirectory() ? "dir" : "file",
			size: st.isDirectory() ? 0 : st.size,
			mtime: Number(st.mtimeMs) || 0,
		};
	}

	async glob(pattern: string, relDir = ""): Promise<string[]> {
		const pat = String(pattern ?? "")
			.trim()
			.replace(/\\/g, "/");
		if (!pat) throw new Error("glob: pattern 为空");
		const re = globToRegExp(pat);
		const base = this.abs(relDir);
		const out: string[] = [];
		const stack: string[] = [base];
		let walked = 0;
		while (stack.length && walked < GLOB_MAX_WALK && out.length < GLOB_MAX_RESULTS) {
			const dir = stack.pop()!;
			let ents;
			try {
				ents = await fspReaddir(dir, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const e of ents) {
				if (walked++ >= GLOB_MAX_WALK || out.length >= GLOB_MAX_RESULTS) break;
				const abs = join(dir, e.name);
				const rel = relative(base, abs).replace(/\\/g, "/");
				if (e.isDirectory()) {
					if (re.test(rel) || re.test(`${rel}/`)) out.push(rel);
					stack.push(abs);
				} else if (re.test(rel)) {
					out.push(rel);
				}
			}
		}
		return out;
	}

	async remove(relPath: string): Promise<void> {
		this.assertRealInsideRoot(relPath);
		await fspRm(this.abs(relPath), { recursive: true, force: false });
	}
}

function sepOf(): string {
	return process.platform === "win32" ? "\\" : "/";
}
