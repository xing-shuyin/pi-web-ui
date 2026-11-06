import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, rm, unlink, type FileHandle } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

const MAX_EVIDENCE_BYTES = 1024 * 1024;
const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const ARTIFACT = /^[a-f0-9]{64}\.txt$/;

export function contextEvidenceReference(text: string): string {
	return `context-evidence:${createHash("sha256").update(text).digest("hex")}`;
}

export async function buildContextEvidenceIndex(sessionFile: string): Promise<string> {
	return withEvidenceQueue([sessionFile], undefined, async () => {
		let directory: string;
		try {
			directory = await evidenceDirectory(sessionFile, false);
		} catch (error) {
			if (missing(error)) return "";
			throw error;
		}
		const names = (await readdir(directory, { withFileTypes: true }))
			.filter((entry) => entry.isFile() && ARTIFACT.test(entry.name))
			.map((entry) => entry.name)
			.sort();
		if (!names.length) return "";
		return [
			`[Context evidence: ${names.length} files. Read context-evidence:index for the complete directory listing.]`,
			...names.slice(0, 32).map((name) => `context-evidence:${name.slice(0, -4)}`),
		].join("\n");
	});
}

export function withContextEvidenceRead(
	base: ToolDefinition,
	getSessionFile: () => string | undefined,
): ToolDefinition {
	return {
		...base,
		execute: async (id, params, signal, onUpdate, ctx) => {
			signal?.throwIfAborted();
			const input = params as Record<string, unknown>;
			const value = input.path ?? input.file_path;
			if (typeof value !== "string") return base.execute(id, params, signal, onUpdate, ctx);
			const sessionFile = getSessionFile();
			let digest: string | undefined;
			let isIndex = false;
			if (value.startsWith("context-evidence:")) {
				digest = /^context-evidence:([a-f0-9]{64})$/.exec(value)?.[1];
				isIndex = value === "context-evidence:index";
				if ((!digest && !isIndex) || !sessionFile)
					throw new Error("Invalid evidence reference or no persisted session");
			} else if (sessionFile) {
				const directory = resolve(`${sessionFile}.evidence`);
				const candidate = resolve(ctx.cwd || process.cwd(), value);
				const child = relative(directory, candidate);
				isIndex = child === "";
				if (ARTIFACT.test(child)) digest = child.slice(0, -4);
			}
			if ((!digest && !isIndex) || !sessionFile) return base.execute(id, params, signal, onUpdate, ctx);
			return withEvidenceQueue([sessionFile], signal, async () => {
				const directory = await evidenceDirectory(sessionFile, false, signal);
				const path = digest ? join(directory, `${digest}.txt`) : directory;
				if (digest) await readEvidence(path, digest, signal);
				signal?.throwIfAborted();
				const result = await base.execute(
					id,
					{ ...input, path, ...("file_path" in input ? { file_path: path } : {}) },
					signal,
					onUpdate,
					ctx,
				);
				signal?.throwIfAborted();
				if (digest) await readEvidence(path, digest, signal);
				else await evidenceDirectory(sessionFile, false, signal);
				return result;
			});
		},
	};
}

const pendingWrites = new Map<string, Promise<unknown>>();
async function withEvidenceQueue<T>(
	sessions: string[],
	signal: AbortSignal | undefined,
	operation: () => Promise<T>,
): Promise<T> {
	signal?.throwIfAborted();
	const keys = [...new Set(sessions.map((file) => resolve(file)))];
	const previous = keys.map((key) => pendingWrites.get(key)?.catch(() => {}));
	const pending = Promise.all(previous).then(() => {
		signal?.throwIfAborted();
		return operation();
	});
	for (const key of keys) pendingWrites.set(key, pending);
	try {
		return await pending;
	} finally {
		for (const key of keys) if (pendingWrites.get(key) === pending) pendingWrites.delete(key);
	}
}

function missing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function openRegular(path: string, signal?: AbortSignal): Promise<FileHandle> {
	signal?.throwIfAborted();
	const before = await lstat(path);
	if (!before.isFile() || before.isSymbolicLink()) throw new Error("Invalid evidence artifact");
	const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK);
	const handle = await open(path, flags);
	try {
		signal?.throwIfAborted();
		const info = await handle.stat();
		const after = await lstat(path);
		if (
			!info.isFile() ||
			!after.isFile() ||
			after.isSymbolicLink() ||
			before.dev !== info.dev ||
			before.ino !== info.ino ||
			after.dev !== info.dev ||
			after.ino !== info.ino
		)
			throw new Error("Evidence artifact changed while opening");
		return handle;
	} catch (error) {
		await handle.close();
		throw error;
	}
}

async function evidenceDirectory(session: string, create: boolean, signal?: AbortSignal): Promise<string> {
	signal?.throwIfAborted();
	const directory = `${session}.evidence`;
	if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
	signal?.throwIfAborted();
	const info = await lstat(directory);
	if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid evidence directory");
	return directory;
}

async function readEvidence(
	path: string,
	digest: string,
	signal?: AbortSignal,
	output?: FileHandle,
	expectedSize?: number,
): Promise<void> {
	const handle = await openRegular(path, signal);
	try {
		const before = await handle.stat();
		if (before.size > MAX_EVIDENCE_BYTES) throw new Error("Evidence budget exceeded");
		if (expectedSize !== undefined && before.size !== expectedSize)
			throw new Error("Evidence artifact changed before copy");
		const hash = createHash("sha256");
		const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
		let position = 0;
		while (position <= before.size) {
			signal?.throwIfAborted();
			const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - position + 1), position);
			signal?.throwIfAborted();
			if (!bytesRead) break;
			if (position + bytesRead > before.size) throw new Error("Evidence artifact changed during read");
			hash.update(buffer.subarray(0, bytesRead));
			if (output) {
				let written = 0;
				while (written < bytesRead) {
					signal?.throwIfAborted();
					const result = await output.write(buffer, written, bytesRead - written, position + written);
					if (!result.bytesWritten) throw new Error("Incomplete evidence write");
					written += result.bytesWritten;
				}
			}
			position += bytesRead;
		}
		const after = await handle.stat();
		signal?.throwIfAborted();
		if (
			position !== before.size ||
			after.size !== before.size ||
			after.mtimeMs !== before.mtimeMs ||
			after.ctimeMs !== before.ctimeMs ||
			hash.digest("hex") !== digest
		)
			throw new Error("Evidence integrity check failed");
	} finally {
		await handle.close();
	}
}

async function sessionExists(session: string, signal?: AbortSignal): Promise<void> {
	const handle = await openRegular(session, signal);
	await handle.close();
	signal?.throwIfAborted();
}

async function inventory(directory: string, signal?: AbortSignal): Promise<Map<string, number>> {
	const sizes = new Map<string, number>();
	let total = 0;
	for (const name of await readdir(directory)) {
		const handle = await openRegular(join(directory, name), signal);
		try {
			const { size } = await handle.stat();
			total += size;
			if (total > MAX_SESSION_BYTES) throw new Error("Evidence budget exceeded");
			sizes.set(name, size);
		} finally {
			await handle.close();
		}
	}
	signal?.throwIfAborted();
	return sizes;
}

async function publish(temporary: string, target: string, session: string, signal?: AbortSignal): Promise<void> {
	await sessionExists(session, signal);
	signal?.throwIfAborted();
	await link(temporary, target);
	try {
		signal?.throwIfAborted();
	} catch (error) {
		await unlink(target);
		throw error;
	}
}

export async function persistContextEvidence(
	sessionFile: string,
	text: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	return withEvidenceQueue([sessionFile], signal, async () => {
		let temporary: string | undefined;
		try {
			signal?.throwIfAborted();
			const bytes = Buffer.byteLength(text);
			if (bytes > MAX_EVIDENCE_BYTES) return undefined;
			await sessionExists(sessionFile, signal);
			const directory = await evidenceDirectory(sessionFile, true, signal);
			const digest = contextEvidenceReference(text).slice("context-evidence:".length);
			const target = join(directory, `${digest}.txt`);
			const sizes = await inventory(directory, signal);
			if (sizes.has(`${digest}.txt`)) {
				await readEvidence(target, digest, signal);
				return target;
			}
			if ([...sizes.values()].reduce((a, b) => a + b, 0) + bytes > MAX_SESSION_BYTES) return undefined;
			signal?.throwIfAborted();
			temporary = join(directory, `.${randomUUID()}.tmp`);
			const handle = await open(temporary, "wx", 0o600);
			try {
				signal?.throwIfAborted();
				await handle.writeFile(text, { encoding: "utf8", signal });
				signal?.throwIfAborted();
			} finally {
				await handle.close();
			}
			await readEvidence(temporary, digest, signal);
			await publish(temporary, target, sessionFile, signal);
			return target;
		} catch {
			signal?.throwIfAborted();
			return undefined;
		} finally {
			if (temporary) await unlink(temporary).catch(() => {});
		}
	});
}

export async function removeContextEvidence(sessionFile: string, signal?: AbortSignal): Promise<void> {
	await withEvidenceQueue([sessionFile], signal, async () => {
		signal?.throwIfAborted();
		await rm(`${sessionFile}.evidence`, { recursive: true, force: true });
		signal?.throwIfAborted();
	});
}

export async function copyContextEvidence(source: string, destination: string, signal?: AbortSignal): Promise<void> {
	await withEvidenceQueue([source, destination], signal, async () => {
		signal?.throwIfAborted();
		if (resolve(source) === resolve(destination)) return;
		let sourceDirectory: string;
		try {
			sourceDirectory = await evidenceDirectory(source, false, signal);
		} catch (error) {
			if (missing(error)) return;
			throw error;
		}
		const sources = await inventory(sourceDirectory, signal);
		await sessionExists(destination, signal);
		const directory = await evidenceDirectory(destination, true, signal);
		const targets = await inventory(directory, signal);
		let total = [...targets.values()].reduce((a, b) => a + b, 0);
		for (const [name, size] of sources) {
			if (!ARTIFACT.test(name)) continue;
			if (size > MAX_EVIDENCE_BYTES) throw new Error("Evidence budget exceeded");
			if (!targets.has(name)) total += size;
		}
		if (total > MAX_SESSION_BYTES) throw new Error("Evidence budget exceeded");
		for (const [name, size] of sources) {
			if (!ARTIFACT.test(name)) continue;
			const digest = name.slice(0, -4);
			const target = join(directory, name);
			const path = join(sourceDirectory, name);
			if (targets.has(name)) {
				await readEvidence(path, digest, signal);
				await readEvidence(target, digest, signal);
				continue;
			}
			const temporary = join(directory, `.${randomUUID()}.tmp`);
			try {
				signal?.throwIfAborted();
				const handle = await open(temporary, "wx", 0o600);
				try {
					await readEvidence(path, digest, signal, handle, size);
					if ((await handle.stat()).size !== size) throw new Error("Evidence artifact changed during copy");
				} finally {
					await handle.close();
				}
				await publish(temporary, target, destination, signal);
			} finally {
				await unlink(temporary).catch(() => {});
			}
		}
		signal?.throwIfAborted();
	});
}
