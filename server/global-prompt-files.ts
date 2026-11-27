import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import type { Express, Request } from "express";
import { writeAtomic } from "./atomic-file.js";
import { resolveGlobalAgentDir } from "./skill-discovery.js";
import { decodeText } from "./text-sniff.js";
import { isInsideRoots } from "../packages/keel/src/path-boundary.js";
import { openVersionedDoc, type VersionedDoc } from "../packages/keel/src/versioned-doc.js";

export type GlobalPromptAgent =
	"pi" | "claude" | "codex" | "cursor" | "windsurf" | "gemini" | "opencode" | "qwen" | "custom";

export type GlobalPromptKind = "system" | "append" | "context" | "rules";

export interface GlobalPromptFile {
	id: string;
	agent: GlobalPromptAgent;
	kind: GlobalPromptKind;
	path: string;
	label?: string;
	custom: boolean;
	exists: boolean;
	content: string;
	revision: string;
	truncated: boolean;
	error?: string;
}

export interface GlobalPromptDirectory {
	id: string;
	agent: GlobalPromptAgent;
	kind: "rules";
	path: string;
	fileCount: number;
	error?: string;
}

export interface GlobalPromptCatalog {
	files: GlobalPromptFile[];
	directories: GlobalPromptDirectory[];
	customStorageBlocked: boolean;
}

export interface GlobalPromptEnvironment {
	agentDir?: string;
	homeDir?: string;
	customStore: GlobalPromptCustomStore;
}

interface FileSpec {
	id: string;
	agent: GlobalPromptAgent;
	kind: GlobalPromptKind;
	path: string;
	root: string;
	label?: string;
	custom: boolean;
}

interface DirectorySpec {
	id: string;
	agent: GlobalPromptAgent;
	kind: "rules";
	path: string;
	extensions: readonly string[];
}

interface CustomGlobalPromptFile {
	id: string;
	label: string;
	path: string;
}

export const MAX_GLOBAL_PROMPT_FILE_BYTES = 512 * 1024;
export const MAX_GLOBAL_PROMPT_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_RULE_FILES = 200;
const CUSTOM_FILE_EXTENSIONS = new Set([".md", ".mdc", ".txt"]);

export class GlobalPromptValidationError extends Error {
	readonly status = 400;
}

export class GlobalPromptConflictError extends Error {
	readonly status = 409;
}

function comparablePath(path: string): string {
	const value = resolve(path);
	return process.platform === "win32" ? value.toLowerCase() : value;
}

function customId(path: string): string {
	return `custom:${createHash("sha256").update(comparablePath(path)).digest("hex").slice(0, 20)}`;
}

function parseCustomFile(value: unknown): CustomGlobalPromptFile | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	if (typeof raw.id !== "string" || !raw.id || raw.id.length > 100) return null;
	if (typeof raw.label !== "string" || !raw.label || raw.label.length > 120) return null;
	if (typeof raw.path !== "string" || !raw.path || raw.path.length > 4096 || !isAbsolute(raw.path)) return null;
	if (!CUSTOM_FILE_EXTENSIONS.has(extname(raw.path).toLowerCase())) return null;
	return { id: raw.id, label: raw.label, path: raw.path };
}

export class GlobalPromptCustomStore {
	private readonly doc: VersionedDoc<CustomGlobalPromptFile[]>;
	private tail: Promise<void> = Promise.resolve();

	constructor(file: string) {
		this.doc = openVersionedDoc<CustomGlobalPromptFile[]>({
			file,
			label: "global-prompt-files",
			versions: [1],
			parse(value) {
				if (!Array.isArray(value.files)) return null;
				const files: CustomGlobalPromptFile[] = [];
				for (const item of value.files) {
					const parsed = parseCustomFile(item);
					if (!parsed) return null;
					files.push(parsed);
				}
				return files;
			},
			serialize: (files) => ({ files }),
			empty: () => [],
		});
	}

	snapshot(): { files: CustomGlobalPromptFile[]; blockedReason: string } {
		const files = this.doc.read();
		return {
			files,
			blockedReason: this.doc.state === "foreign" || this.doc.state === "damaged" ? this.doc.blockedReason : "",
		};
	}

	add(path: string, label?: string): Promise<CustomGlobalPromptFile> {
		return this.enqueue(async () => {
			if (!isAbsolute(path) || path.includes("\0") || !CUSTOM_FILE_EXTENSIONS.has(extname(path).toLowerCase())) {
				throw new GlobalPromptValidationError("Custom prompt files must be absolute .md, .mdc, or .txt files");
			}
			if (!isInsideRoots(path, [dirname(path)])) {
				throw new GlobalPromptValidationError("Custom prompt file path is outside its registered directory");
			}
			let info: Awaited<ReturnType<typeof stat>>;
			try {
				info = await stat(path);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") {
					throw new GlobalPromptValidationError("Custom prompt file does not exist");
				}
				throw error;
			}
			if (!info.isFile()) throw new GlobalPromptValidationError("Custom prompt path is not a file");
			if (info.size > MAX_GLOBAL_PROMPT_FILE_BYTES) {
				throw new GlobalPromptValidationError("Custom prompt file exceeds the 512KB editor limit");
			}
			const absolute = await realpath(path);
			const files = this.doc.assertWritable();
			const key = comparablePath(absolute);
			if (files.some((file) => comparablePath(file.path) === key)) {
				throw new GlobalPromptValidationError("Custom prompt file is already registered");
			}
			const entry: CustomGlobalPromptFile = {
				id: customId(absolute),
				label: label?.trim().slice(0, 120) || basename(absolute),
				path: absolute,
			};
			await this.doc.write([...files, entry]);
			return entry;
		});
	}

	remove(id: string): Promise<void> {
		return this.enqueue(async () => {
			const files = this.doc.assertWritable();
			const next = files.filter((file) => file.id !== id);
			if (next.length === files.length) throw new GlobalPromptValidationError("Unknown custom prompt file");
			await this.doc.write(next);
		});
	}

	private enqueue<T>(run: () => Promise<T>): Promise<T> {
		const result = this.tail.then(run, run);
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}

function configHome(home: string, envName: string, fallback: string): string {
	const configured = process.env[envName]?.trim();
	return configured ? resolve(configured) : join(home, fallback);
}

function builtInSpecs(env: GlobalPromptEnvironment): { files: FileSpec[]; directories: DirectorySpec[] } {
	const home = env.homeDir ? resolve(env.homeDir) : homedir();
	const agentDir = resolveGlobalAgentDir(env.agentDir);
	const codexHome = configHome(home, "CODEX_HOME", ".codex");
	const geminiHome = configHome(home, "GEMINI_CLI_HOME", ".gemini");
	const opencodeHome = process.env.XDG_CONFIG_HOME?.trim()
		? join(resolve(process.env.XDG_CONFIG_HOME), "opencode")
		: join(home, ".config", "opencode");
	const qwenHome = configHome(home, "QWEN_CODE_HOME", ".qwen");
	const exact = (id: string, agent: GlobalPromptAgent, kind: GlobalPromptKind, path: string): FileSpec => ({
		id,
		agent,
		kind,
		path: resolve(path),
		root: dirname(resolve(path)),
		custom: false,
	});

	const files: FileSpec[] = [
		exact("pi:system", "pi", "system", join(agentDir, "SYSTEM.md")),
		exact("pi:append", "pi", "append", join(agentDir, "APPEND_SYSTEM.md")),
		exact("pi:agents", "pi", "context", join(agentDir, "AGENTS.md")),
		exact("pi:claude", "pi", "context", join(agentDir, "CLAUDE.md")),
		exact("claude:context", "claude", "context", join(home, ".claude", "CLAUDE.md")),
		exact("codex:context", "codex", "context", join(codexHome, "AGENTS.md")),
		exact("windsurf:rules", "windsurf", "rules", join(home, ".codeium", "windsurf", "memories", "global_rules.md")),
		exact("gemini:context", "gemini", "context", join(geminiHome, "GEMINI.md")),
		exact("opencode:context", "opencode", "context", join(opencodeHome, "AGENTS.md")),
		exact("qwen:context", "qwen", "context", join(qwenHome, "QWEN.md")),
	];
	const directories: DirectorySpec[] = [
		{
			id: "claude:rules",
			agent: "claude",
			kind: "rules",
			path: join(home, ".claude", "rules"),
			extensions: [".md"],
		},
		{
			id: "cursor:rules",
			agent: "cursor",
			kind: "rules",
			path: join(home, ".cursor", "rules"),
			extensions: [".md", ".mdc"],
		},
	];
	return { files, directories };
}

function allSpecs(env: GlobalPromptEnvironment): { files: FileSpec[]; directories: DirectorySpec[] } {
	const builtIn = builtInSpecs(env);
	const custom = env.customStore.snapshot().files.map((file): FileSpec => ({
		id: file.id,
		agent: "custom",
		kind: "context",
		path: resolve(file.path),
		root: dirname(resolve(file.path)),
		label: file.label,
		custom: true,
	}));
	return { files: [...builtIn.files, ...custom], directories: builtIn.directories };
}

async function readEntry(spec: FileSpec, totalBytes: { value: number }): Promise<GlobalPromptFile> {
	const base: GlobalPromptFile = {
		id: spec.id,
		agent: spec.agent,
		kind: spec.kind,
		path: spec.path,
		...(spec.label ? { label: spec.label } : {}),
		custom: spec.custom,
		exists: false,
		content: "",
		revision: "missing",
		truncated: false,
	};
	try {
		if (!isInsideRoots(spec.path, [spec.root])) {
			return { ...base, error: "Path resolves outside its registered directory" };
		}
		const info = await stat(spec.path);
		if (!info.isFile()) return { ...base, error: "Path is not a regular file" };
		base.exists = true;
		base.revision = `${info.mtimeMs.toFixed(3)}:${info.size}`;
		if (info.size > MAX_GLOBAL_PROMPT_FILE_BYTES || totalBytes.value + info.size > MAX_GLOBAL_PROMPT_TOTAL_BYTES) {
			return { ...base, truncated: true };
		}
		const buffer = await readFile(spec.path);
		totalBytes.value += buffer.length;
		return { ...base, content: decodeText(buffer) };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return base;
		return { ...base, error: error instanceof Error ? error.message : String(error) };
	}
}

export async function listGlobalPromptFiles(env: GlobalPromptEnvironment): Promise<GlobalPromptCatalog> {
	const specs = allSpecs(env);
	const customSnapshot = env.customStore.snapshot();
	const totalBytes = { value: 0 };
	const files: GlobalPromptFile[] = [];
	for (const spec of specs.files) files.push(await readEntry(spec, totalBytes));

	const directories: GlobalPromptDirectory[] = [];
	for (const directory of specs.directories) {
		try {
			const entries = await readdir(directory.path, { withFileTypes: true });
			const ruleFiles = entries
				.filter(
					(entry) =>
						entry.isFile() &&
						!entry.name.startsWith(".") &&
						directory.extensions.includes(extname(entry.name).toLowerCase()),
				)
				.map((entry) => entry.name)
				.sort((a, b) => a.localeCompare(b))
				.slice(0, MAX_RULE_FILES);
			const directoryResult: GlobalPromptDirectory = {
				id: directory.id,
				agent: directory.agent,
				kind: directory.kind,
				path: resolve(directory.path),
				fileCount: ruleFiles.length,
			};
			directories.push(directoryResult);
			for (const name of ruleFiles) {
				const path = resolve(directory.path, name);
				files.push(
					await readEntry(
						{
							id: `${directory.id}:${encodeURIComponent(name)}`,
							agent: directory.agent,
							kind: directory.kind,
							path,
							root: resolve(directory.path),
							custom: false,
						},
						totalBytes,
					),
				);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				directories.push({
					id: directory.id,
					agent: directory.agent,
					kind: directory.kind,
					path: resolve(directory.path),
					fileCount: 0,
				});
			} else {
				directories.push({
					id: directory.id,
					agent: directory.agent,
					kind: directory.kind,
					path: resolve(directory.path),
					fileCount: 0,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	files.sort((a, b) => a.agent.localeCompare(b.agent) || a.kind.localeCompare(b.kind) || a.path.localeCompare(b.path));
	return { files, directories, customStorageBlocked: Boolean(customSnapshot.blockedReason) };
}

async function revisionOf(path: string): Promise<string> {
	try {
		const info = await stat(path);
		return `${info.mtimeMs.toFixed(3)}:${info.size}`;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
		throw error;
	}
}

const writeChains = new Map<string, Promise<unknown>>();

function withWriteLock<T>(file: string, run: () => Promise<T>): Promise<T> {
	const key = comparablePath(file);
	const previous = writeChains.get(key);
	const result = previous ? (previous.then(run, run) as Promise<T>) : run();
	const tail = result.then(
		() => undefined,
		() => undefined,
	);
	writeChains.set(key, tail);
	void tail.finally(() => {
		if (writeChains.get(key) === tail) writeChains.delete(key);
	});
	return result;
}

export async function writeGlobalPromptFile(
	env: GlobalPromptEnvironment,
	input: { id: string; content: string; expectedRevision: string },
): Promise<GlobalPromptFile> {
	const specs = allSpecs(env);
	const spec = specs.files.find((file) => file.id === input.id);
	if (!spec) throw new GlobalPromptValidationError("Unknown global prompt file");
	if (typeof input.content !== "string" || Buffer.byteLength(input.content, "utf8") > MAX_GLOBAL_PROMPT_FILE_BYTES) {
		throw new GlobalPromptValidationError("Prompt content exceeds the 512KB editor limit");
	}
	if (typeof input.expectedRevision !== "string" || !input.expectedRevision) {
		throw new GlobalPromptValidationError("Missing expected revision");
	}
	if (!isInsideRoots(spec.path, [spec.root])) {
		throw new GlobalPromptValidationError("Prompt file path is outside its registered root");
	}
	return withWriteLock(spec.path, async () => {
		const currentRevision = await revisionOf(spec.path);
		if (currentRevision !== input.expectedRevision) {
			throw new GlobalPromptConflictError("File changed on disk; reload before saving again");
		}
		let mode = 0o600;
		try {
			const current = await stat(spec.path);
			if (current.size > MAX_GLOBAL_PROMPT_FILE_BYTES) {
				throw new GlobalPromptValidationError("Existing prompt file exceeds the 512KB editor limit");
			}
			mode = current.mode & 0o777;
		} catch (error) {
			if (error instanceof GlobalPromptValidationError) throw error;
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		await writeAtomic(spec.path, input.content, { mode, fsync: true });
		return readEntry(spec, { value: 0 });
	});
}

export function registerGlobalPromptRoutes(
	app: Express,
	options: { dataDir: string; agentDir?: string; homeDir?: string },
): void {
	const customStore = new GlobalPromptCustomStore(join(options.dataDir, "global-prompt-files.json"));
	const env: GlobalPromptEnvironment = { ...options, customStore };
	const sameOrigin = (req: Request): boolean => req.headers["sec-fetch-site"] !== "cross-site";
	const jsonOnly = (req: Request): boolean => sameOrigin(req) && Boolean(req.is("application/json"));

	app.get("/api/global-prompts", async (_req, res) => {
		try {
			res.setHeader("Cache-Control", "no-store");
			res.json(await listGlobalPromptFiles(env));
		} catch (error) {
			res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
		}
	});

	app.put("/api/global-prompts", async (req, res) => {
		if (!jsonOnly(req)) {
			res.status(403).json({ error: "Cross-site prompt write rejected" });
			return;
		}
		try {
			const body = req.body ?? {};
			if (typeof body.id !== "string" || typeof body.content !== "string") {
				throw new GlobalPromptValidationError("Missing prompt file id or content");
			}
			const file = await writeGlobalPromptFile(env, {
				id: body.id,
				content: body.content,
				expectedRevision: typeof body.expectedRevision === "string" ? body.expectedRevision : "",
			});
			res.json({ file });
		} catch (error) {
			const status =
				error instanceof GlobalPromptConflictError ? 409 : error instanceof GlobalPromptValidationError ? 400 : 500;
			res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
		}
	});

	app.post("/api/global-prompts/custom", async (req, res) => {
		if (!jsonOnly(req)) {
			res.status(403).json({ error: "Cross-site prompt write rejected" });
			return;
		}
		try {
			const body = req.body ?? {};
			if (typeof body.path !== "string") throw new GlobalPromptValidationError("Missing custom prompt path");
			await customStore.add(body.path, typeof body.label === "string" ? body.label : undefined);
			res.json(await listGlobalPromptFiles(env));
		} catch (error) {
			const status = error instanceof GlobalPromptValidationError ? 400 : 500;
			res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
		}
	});

	app.delete("/api/global-prompts/custom/:id", async (req, res) => {
		if (!sameOrigin(req)) {
			res.status(403).json({ error: "Cross-site prompt write rejected" });
			return;
		}
		try {
			await customStore.remove(String(req.params.id ?? ""));
			res.json(await listGlobalPromptFiles(env));
		} catch (error) {
			const status = error instanceof GlobalPromptValidationError ? 400 : 500;
			res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
		}
	});
}
