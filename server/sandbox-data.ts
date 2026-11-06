import { existsSync, mkdirSync, readFileSync, realpathSync, lstatSync } from "node:fs";
import { copyFile, chmod, lstat, mkdir, readdir, readFile, rename, rm, rmdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve, basename, parse } from "node:path";
import { homedir } from "node:os";
import type { SandboxInfo } from "./protocol.js";
import { writeAtomicSync } from "./atomic-file.js";
import { SANDBOX_IGNORED_DIRS, isSameOrSubpath } from "./sandbox-service.js";

type Tree = Record<string, string>;
type Baseline = { version: 1; files: Tree };
type Repository = {
	items: Map<string, SandboxInfo>;
	queues: Map<string, Promise<unknown>>;
	busy: Set<string>;
	leases: Map<string, number>;
};
const repositories = new Map<string, Repository>();
const wire = (p: string) => resolve(p).replace(/\\/g, "/");
const hash = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const ignored = (n: string) =>
	n === ".git" ||
	SANDBOX_IGNORED_DIRS.has(n) ||
	[".DS_Store", "Thumbs.db", "desktop.ini"].includes(n) ||
	n.startsWith(".pi-tmp");
function atomic(path: string, value: unknown) {
	mkdirSync(dirname(path), { recursive: true });
	safeRoot(dirname(path));
	if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error(`Linked metadata refused: ${path}`);
	writeAtomicSync(path, JSON.stringify(value), { fsync: true });
}
function safeRoot(path: string) {
	const abs = resolve(path);
	let cur = abs;
	while (true) {
		if (existsSync(cur) && lstatSync(cur).isSymbolicLink()) throw new Error(`Linked directory refused: ${cur}`);
		const parent = dirname(cur);
		if (parent === cur) break;
		cur = parent;
	}
	if (!existsSync(abs) || !lstatSync(abs).isDirectory()) throw new Error(`Directory unavailable: ${abs}`);
	return realpathSync(abs);
}
async function createSafeDirectories(path: string): Promise<void> {
	const missing: string[] = [];
	let current = resolve(path);
	while (!existsSync(current)) {
		missing.push(current);
		const parent = dirname(current);
		if (parent === current) throw new Error(`Directory unavailable: ${path}`);
		current = parent;
	}
	safeRoot(current);
	for (const dir of missing.reverse()) {
		safeRoot(dirname(dir));
		await mkdir(dir);
		safeRoot(dir);
	}
}
function protectedRoot(path: string) {
	const real = safeRoot(path);
	if (real === parse(real).root || wire(real) === wire(homedir())) throw new Error("System or home root refused");
	return real;
}
async function tree(root: string): Promise<Tree> {
	safeRoot(root);
	const out: Tree = Object.create(null);
	let bytes = 0;
	let count = 0;
	async function walk(dir: string, prefix: string) {
		for (const ent of await readdir(dir, { withFileTypes: true })) {
			if (ignored(ent.name)) continue;
			const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
			const path = join(root, rel);
			const st = await lstat(path);
			if (++count > 15000) throw new Error("Sandbox file budget exceeded");
			if (st.isSymbolicLink()) {
				out[rel] = "link";
				continue;
			}
			if (st.isDirectory()) {
				out[rel] = "dir";
				await walk(path, rel);
			} else if (st.isFile()) {
				bytes += st.size;
				if (st.size > 64 * 1024 * 1024 || bytes > 512 * 1024 * 1024) throw new Error("Sandbox byte budget exceeded");
				out[rel] = `file:${st.mode & 0o777}:${hash(await readFile(path))}`;
			} else throw new Error(`Unsupported file: ${rel}`);
		}
	}
	await walk(root, "");
	return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}
async function fingerprint(path: string): Promise<string | undefined> {
	try {
		const st = await lstat(path);
		if (st.isSymbolicLink()) return "link";
		if (st.isDirectory()) return "dir";
		if (st.isFile()) return `file:${st.mode & 0o777}:${hash(await readFile(path))}`;
		return "unsupported";
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}
async function copy(root: string, dest: string) {
	const realSource = safeRoot(root),
		realDest = safeRoot(dest);
	if (isSameOrSubpath(realDest, realSource) || isSameOrSubpath(realSource, realDest))
		throw new Error("Source and destination trees overlap");
	const before = await tree(root);
	let copiedFiles = 0;
	let skippedFiles = 0;
	for (const [rel, value] of Object.entries(before)) {
		if (value === "link") {
			skippedFiles++;
			continue;
		}
		if (value === "dir") await mkdir(join(dest, rel), { recursive: true });
		else {
			await mkdir(dirname(join(dest, rel)), { recursive: true });
			await copyFile(join(root, rel), join(dest, rel));
			await chmod(join(dest, rel), (await lstat(join(root, rel))).mode & 0o777);
			if ((await fingerprint(join(dest, rel))) !== value) throw new Error(`Copied content changed: ${rel}`);
			copiedFiles++;
		}
	}
	if (hash(JSON.stringify(before)) !== hash(JSON.stringify(await tree(root))))
		throw new Error("Source changed while copying");
	return { copiedFiles, skippedFiles };
}
export interface SandboxLifecycle {
	reset(): Promise<{ sandbox: SandboxInfo; copiedFiles: number; skippedFiles: number }>;
	destroy(): Promise<SandboxInfo | undefined>;
	applyToSource(
		expectedRevision?: string,
	): Promise<{ sandbox: SandboxInfo; sourcePath: string; copiedFiles: number; deletedFiles: number }>;
}
export class SandboxManager {
	readonly sandboxesRoot: string;
	private readonly registryPath: string;
	private readonly repo: Repository;
	constructor(dataDir: string) {
		this.sandboxesRoot = wire(join(dataDir, "sandboxes"));
		this.registryPath = join(this.sandboxesRoot, "registry.json");
		const key = process.platform === "win32" ? this.sandboxesRoot.toLowerCase() : this.sandboxesRoot;
		let repo = repositories.get(key);
		if (!repo) {
			repo = { items: new Map(), queues: new Map(), busy: new Set(), leases: new Map() };
			if (existsSync(this.registryPath)) {
				const raw = JSON.parse(readFileSync(this.registryPath, "utf8"));
				if (raw.version !== 1 || !Array.isArray(raw.sandboxes)) throw new Error("Invalid sandbox registry");
				for (const info of raw.sandboxes) {
					if (
						!info ||
						typeof info.id !== "string" ||
						!/^[a-zA-Z0-9_-]+$/.test(info.id) ||
						wire(info.path) !== wire(join(this.sandboxesRoot, info.id))
					)
						throw new Error("Invalid managed sandbox identity");
					if (existsSync(info.path)) safeRoot(info.path);
					repo.items.set(info.id, Object.freeze({ ...info }));
				}
			}
			repositories.set(key, repo);
		}
		this.repo = repo;
	}
	private commit(items: Map<string, SandboxInfo>) {
		atomic(this.registryPath, { version: 1, sandboxes: [...items.values()] });
		this.repo.items = items;
	}
	private baselinePath(info: SandboxInfo) {
		return join(this.sandboxesRoot, ".baselines", `${info.id}.json`);
	}
	private baseline(info: SandboxInfo): Tree {
		const path = this.baselinePath(info);
		if (!existsSync(path)) throw new Error("Sandbox baseline missing; rebuild sandbox before applying changes");
		safeRoot(dirname(path));
		if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) throw new Error("Invalid sandbox baseline file");
		const raw = JSON.parse(readFileSync(path, "utf8")) as Baseline;
		if (raw.version !== 1 || !raw.files || typeof raw.files !== "object")
			throw new Error("Invalid sandbox baseline; rebuild sandbox");
		for (const [rel, value] of Object.entries(raw.files)) {
			if (
				!rel ||
				rel.includes("\\") ||
				rel.startsWith("/") ||
				rel.split("/").some((p) => p === ".." || p === "." || !p || ignored(p)) ||
				!isSameOrSubpath(join(info.path, rel), info.path) ||
				!/^(dir|link|file:[0-9]+:[a-f0-9]{64})$/.test(value)
			)
				throw new Error("Invalid sandbox baseline path or value");
		}
		return Object.assign(Object.create(null), raw.files);
	}
	list() {
		return [...this.repo.items.values()].map((i) => ({ ...i })).sort((a, b) => b.createdAt - a.createdAt);
	}
	get(target: string) {
		return this.list().find((i) => i.id === target || wire(i.path) === wire(target));
	}
	isManagedRoot(cwd: string) {
		return isSameOrSubpath(cwd, this.sandboxesRoot);
	}
	getByCwd(cwd: string): SandboxInfo | undefined {
		if (!cwd) return undefined;
		const info = this.list().find((i) => isSameOrSubpath(cwd, i.path));
		if (!info && this.isManagedRoot(cwd)) throw new Error("Managed sandbox identity unavailable");
		if (info) {
			if (!existsSync(this.registryPath) || !lstatSync(this.registryPath).isFile())
				throw new Error("Sandbox registry unavailable");
			safeRoot(info.path);
		}
		return info;
	}
	getExecutionIdentity(cwd: string, captured?: SandboxInfo) {
		const info = this.getByCwd(cwd);
		if ((info || captured || this.isManagedRoot(cwd)) && !existsSync(this.registryPath))
			throw new Error("Sandbox registry unavailable");
		if (
			captured &&
			(!info || info.id !== captured.id || info.createdAt !== captured.createdAt || info.path !== captured.path)
		)
			throw new Error("Sandbox execution identity lost");
		if (info) this.assertAvailable(cwd);
		return info;
	}
	assertAvailable(cwd: string) {
		const info = this.getByCwd(cwd);
		if (info && this.repo.busy.has(info.id)) throw new Error("Sandbox lifecycle operation in progress");
	}
	acquireExecution(cwd: string, captured?: SandboxInfo) {
		const info = this.getExecutionIdentity(cwd, captured);
		if (!info) return () => {};
		this.repo.leases.set(info.id, (this.repo.leases.get(info.id) ?? 0) + 1);
		let released = false;
		return () => {
			if (!released) {
				released = true;
				this.repo.leases.set(info.id, (this.repo.leases.get(info.id) ?? 1) - 1);
			}
		};
	}
	private require(target: string) {
		const info = this.get(target) ?? this.getByCwd(target);
		if (!info) throw new Error(`Sandbox not found: ${target}`);
		safeRoot(info.path);
		return info;
	}
	async withLifecycle<T>(
		target: string,
		action: (info: SandboxInfo, lifecycle: SandboxLifecycle) => Promise<T>,
	): Promise<T> {
		const info = this.require(target);
		const prev = this.repo.queues.get(info.id) ?? Promise.resolve();
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		this.repo.queues.set(info.id, gate);
		this.repo.busy.add(info.id);
		await prev.catch(() => {});
		let active = true;
		let used = false;
		const check = () => {
			if (!active || used) throw new Error("Expired or already used lifecycle handle");
			used = true;
			this.require(info.id);
			if (this.repo.leases.get(info.id)) throw new Error("Sandbox is running; stop execution before mutation");
		};
		const pending: Promise<unknown>[] = [];
		const track = <R>(mutation: () => Promise<R>): Promise<R> => {
			const task = (async () => {
				check();
				return mutation();
			})();
			pending.push(task);
			void task.catch(() => {});
			return task;
		};
		let result!: T;
		let actionFailed = false;
		let actionError: unknown;
		let failures: unknown[] = [];
		try {
			try {
				result = await action(info, {
					reset: () => track(() => this.resetUnlocked(info)),
					destroy: () => track(() => this.destroyUnlocked(info)),
					applyToSource: (rev) => track(() => this.applyUnlocked(info, rev)),
				});
			} catch (error) {
				actionFailed = true;
				actionError = error;
			}
			active = false;
			const results = await Promise.allSettled(pending);
			failures = results.filter((entry) => entry.status === "rejected").map((entry) => entry.reason);
		} finally {
			active = false;
			if (this.repo.queues.get(info.id) === gate) {
				this.repo.queues.delete(info.id);
				this.repo.busy.delete(info.id);
			}
			release();
		}
		if (actionFailed) {
			const additional = failures.filter((error) => error !== actionError);
			if (additional.length)
				throw new AggregateError([actionError, ...additional], "Sandbox lifecycle operation failed");
			throw actionError;
		}
		if (failures.length) throw failures[0];
		return result;
	}
	async create(opts: { name?: string; sourcePath?: string; ephemeral?: boolean }) {
		mkdirSync(this.sandboxesRoot, { recursive: true });
		safeRoot(this.sandboxesRoot);
		const id = `sandbox-${randomUUID()}`;
		const path = wire(join(this.sandboxesRoot, id));
		const sourcePath = opts.sourcePath ? wire(protectedRoot(opts.sourcePath)) : undefined;
		if (
			sourcePath &&
			(isSameOrSubpath(sourcePath, this.sandboxesRoot) || isSameOrSubpath(this.sandboxesRoot, sourcePath))
		)
			throw new Error("Cannot import a managed sandbox");
		const info: SandboxInfo = {
			id,
			name: opts.name?.trim() || basename(sourcePath ?? id),
			path,
			sourcePath,
			ephemeral: opts.ephemeral ?? true,
			createdAt: Date.now(),
		};
		await mkdir(path);
		try {
			const stats = sourcePath ? await copy(sourcePath, path) : { copiedFiles: 0, skippedFiles: 0 };
			atomic(this.baselinePath(info), { version: 1, files: await tree(path) });
			const items = new Map(this.repo.items);
			items.set(id, Object.freeze(info));
			this.commit(items);
			return { sandbox: { ...info }, ...stats };
		} catch (error) {
			await rm(path, { recursive: true });
			throw error;
		}
	}
	persist(target: string) {
		const info = this.require(target);
		if (this.repo.busy.has(info.id)) throw new Error("Sandbox lifecycle operation in progress");
		const updated = { ...info, ephemeral: false };
		const items = new Map(this.repo.items);
		items.set(info.id, Object.freeze(updated));
		this.commit(items);
		return updated;
	}
	reset(target: string) {
		return this.withLifecycle(target, (_i, op) => op.reset());
	}
	private async resetUnlocked(info: SandboxInfo) {
		const staging = join(this.sandboxesRoot, `.pi-tmp-${randomUUID()}`);
		const backup = `${staging}-old`;
		await mkdir(staging);
		let swapped = false;
		const baseline = this.baselinePath(info);
		const oldBaseline = existsSync(baseline) ? readFileSync(baseline) : undefined;
		try {
			const stats = info.sourcePath
				? await copy(protectedRoot(info.sourcePath), staging)
				: { copiedFiles: 0, skippedFiles: 0 };
			const files = await tree(staging);
			safeRoot(info.path);
			await rename(info.path, backup);
			try {
				await rename(staging, info.path);
				swapped = true;
				atomic(baseline, { version: 1, files });
			} catch (error) {
				if (swapped) await rename(info.path, staging);
				await rename(backup, info.path);
				if (oldBaseline) atomic(baseline, JSON.parse(oldBaseline.toString("utf8")));
				throw error;
			}
			await rm(backup, { recursive: true });
			return { sandbox: info, ...stats };
		} finally {
			if (existsSync(staging)) await rm(staging, { recursive: true });
		}
	}
	async promote(target: string, targetPath: string) {
		return this.withLifecycle(target, async (info) => {
			if (this.repo.leases.get(info.id)) throw new Error("Sandbox is running");
			const trimmed = targetPath.trim();
			if (!trimmed) throw new Error("Target path is required");
			const dest = resolve(
				trimmed === "~" ? homedir() : /^~[\\/\\\\]/.test(trimmed) ? join(homedir(), trimmed.slice(2)) : trimmed,
			);
			if (isSameOrSubpath(dest, this.sandboxesRoot)) throw new Error("Target must be outside managed sandboxes");
			if (existsSync(dest)) {
				protectedRoot(dest);
				if ((await readdir(dest)).length) throw new Error("Target directory is not empty");
			} else {
				await createSafeDirectories(dest);
				protectedRoot(dest);
			}
			const stats = await copy(info.path, dest);
			return { sandbox: info, targetPath: wire(dest), copiedFiles: stats.copiedFiles };
		});
	}
	async diffWithSource(target: string) {
		const info = this.require(target);
		const base = this.baseline(info);
		const current = await tree(info.path);
		const source = info.sourcePath ? await tree(protectedRoot(info.sourcePath)) : {};
		const added: string[] = [],
			modified: string[] = [],
			deleted: string[] = [];
		let unchangedCount = 0;
		for (const rel of new Set([...Object.keys(base), ...Object.keys(current)])) {
			if (base[rel] === "dir" && current[rel] === "dir") continue;
			if (base[rel] === current[rel]) {
				if (base[rel]?.startsWith("file:")) unchangedCount++;
			} else if (!base[rel]) added.push(rel);
			else if (!current[rel]) deleted.push(rel);
			else modified.push(rel);
		}
		return {
			sandbox: info,
			sourcePath: info.sourcePath,
			added: added.sort(),
			modified: modified.sort(),
			deleted: deleted.sort(),
			unchangedCount,
			expectedRevision: hash(JSON.stringify([base, current, source])),
		};
	}
	applyToSource(target: string, expectedRevision?: string) {
		return this.withLifecycle(target, (_i, op) => op.applyToSource(expectedRevision));
	}
	private async applyUnlocked(info: SandboxInfo, expectedRevision?: string) {
		if (!info.sourcePath) throw new Error("Sandbox has no source project");
		const source = protectedRoot(info.sourcePath);
		const base = this.baseline(info);
		const current = await tree(info.path);
		const original = await tree(source);
		const revision = hash(JSON.stringify([base, current, original]));
		if (!expectedRevision) throw new Error("Sandbox preview revision required; refresh preview");
		if (revision !== expectedRevision) throw new Error("Sandbox or source changed; refresh preview");
		const changes = [...new Set([...Object.keys(base), ...Object.keys(current)])].filter(
			(r) => base[r] !== current[r] && original[r] !== current[r],
		);
		for (const rel of changes) {
			if (
				base[rel] === "dir" &&
				!current[rel] &&
				Object.keys(original).some((p) => p.startsWith(rel + "/") && !Object.hasOwn(base, p))
			)
				throw new Error(`Sandbox directory conflict: ${rel}`);
			if (original[rel] !== base[rel] && original[rel] !== current[rel]) throw new Error(`Sandbox conflict: ${rel}`);
			if (base[rel] === "link" || current[rel] === "link" || original[rel] === "link")
				throw new Error(`Linked target refused: ${rel}`);
			if (base[rel] && current[rel] && (base[rel] === "dir" || current[rel] === "dir"))
				throw new Error(`File type conflict: ${rel}`);
			let parent = dirname(rel);
			while (parent !== ".") {
				if (original[parent] && original[parent] !== "dir") throw new Error(`Unsafe target ancestor: ${parent}`);
				parent = dirname(parent);
			}
		}
		const stage = join(source, `.pi-tmp-${randomUUID()}`);
		await mkdir(stage);
		const undo: Array<() => Promise<void>> = [];
		const madeDirs: string[] = [];
		let copiedFiles = 0,
			deletedFiles = 0;
		let retainRecovery = false;
		try {
			for (let i = 0; i < changes.length; i++) {
				const rel = changes[i];
				if (current[rel]?.startsWith("file:")) {
					await copyFile(join(info.path, rel), join(stage, `new-${i}`));
					await chmod(join(stage, `new-${i}`), (await lstat(join(info.path, rel))).mode & 0o777);
					const staged = await lstat(join(stage, `new-${i}`));
					if (`file:${staged.mode & 0o777}:${hash(await readFile(join(stage, `new-${i}`)))}` !== current[rel])
						throw new Error(`Sandbox changed during staging: ${rel}`);
				}
			}
			if (revision !== hash(JSON.stringify([base, await tree(info.path), await tree(source)])))
				throw new Error("Source or sandbox changed while staging");
			atomic(join(stage, "recovery.json"), {
				version: 1,
				source,
				sandboxId: info.id,
				changes: changes.map((rel, index) => ({
					rel,
					backup: `old-${index}`,
					staged: `new-${index}`,
					original: original[rel],
					desired: current[rel],
				})),
			});
			for (let i = 0; i < changes.length; i++) {
				const rel = changes[i];
				const value = current[rel];
				const path = join(source, rel);
				protectedRoot(source);
				if (base[rel] === "dir" && !value) continue;
				safeRoot(dirname(path));
				if (original[rel] && !existsSync(path)) throw new Error(`Source disappeared before commit: ${rel}`);
				if (value === "dir") {
					if (!existsSync(path)) {
						await mkdir(path);
						madeDirs.push(path);
					}
					continue;
				}
				if (base[rel] === "dir") continue;
				if (existsSync(path)) {
					const st = await lstat(path);
					if (st.isFile() && `file:${st.mode & 0o777}:${hash(await readFile(path))}` !== original[rel])
						throw new Error(`Source changed before commit: ${rel}`);
					if (st.isSymbolicLink() || !st.isFile() || st.nlink > 1)
						throw new Error(`Unsafe linked or changed target: ${rel}`);
					const backup = join(stage, `old-${i}`);
					await rename(path, backup);
					let installed = false;
					undo.push(async () => {
						safeRoot(dirname(path));
						if ((await fingerprint(path)) !== (installed ? value : undefined))
							throw new Error(`Concurrent source change during rollback: ${rel}`);
						if (installed && value) await rm(path);
						await rename(backup, path);
					});
					if (value) {
						await rename(join(stage, `new-${i}`), path);
						installed = true;
						copiedFiles++;
					} else deletedFiles++;
				} else {
					let installed = false;
					undo.push(async () => {
						safeRoot(dirname(path));
						if ((await fingerprint(path)) !== (installed ? value : undefined))
							throw new Error(`Concurrent source change during rollback: ${rel}`);
						if (installed && value) await rm(path);
					});
					if (value) {
						await rename(join(stage, `new-${i}`), path);
						installed = true;
						copiedFiles++;
					}
				}
			}
			for (const rel of changes
				.filter((rel) => base[rel] === "dir" && !current[rel])
				.sort((a, b) => b.split("/").length - a.split("/").length)) {
				const path = join(source, rel);
				safeRoot(path);
				await rmdir(path);
				undo.push(async () => {
					safeRoot(dirname(path));
					if ((await fingerprint(path)) !== undefined)
						throw new Error(`Concurrent directory change during rollback: ${rel}`);
					await mkdir(path);
				});
			}
			return { sandbox: info, sourcePath: info.sourcePath, copiedFiles, deletedFiles };
		} catch (error) {
			const failures: unknown[] = [];
			for (const rollback of undo.reverse())
				try {
					await rollback();
				} catch (e) {
					failures.push(e);
				}
			for (const dir of madeDirs.reverse())
				try {
					await rmdir(dir);
				} catch (e) {
					failures.push(e);
				}
			if (failures.length) {
				retainRecovery = true;
				throw new AggregateError([error, ...failures], `Sandbox rollback failed; recovery files retained at ${stage}`);
			}
			throw error;
		} finally {
			if (!retainRecovery) await rm(stage, { recursive: true });
		}
	}
	destroy(target: string): Promise<SandboxInfo | undefined> {
		if (!this.get(target) && !this.getByCwd(target)) return Promise.resolve(undefined);
		return this.withLifecycle(target, (_i, op) => op.destroy());
	}
	private async destroyUnlocked(info: SandboxInfo) {
		this.require(info.id);
		const tombstone = join(this.sandboxesRoot, `.pi-tmp-destroy-${info.id}-${randomUUID()}`);
		await rename(info.path, tombstone);
		try {
			const items = new Map(this.repo.items);
			items.delete(info.id);
			this.commit(items);
		} catch (error) {
			try {
				await rename(tombstone, info.path);
			} catch (rollback) {
				throw new AggregateError(
					[error, rollback],
					`Sandbox destroy rollback failed; contents retained at ${tombstone}`,
				);
			}
			throw error;
		}
		try {
			await rm(tombstone, { recursive: true });
		} catch (error) {
			throw new Error(`Sandbox deregistered but cleanup failed; recovery contents retained at ${tombstone}`, {
				cause: error,
			});
		}
		return info;
	}
}
