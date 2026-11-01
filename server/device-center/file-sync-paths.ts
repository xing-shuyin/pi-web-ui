import { createHash } from "node:crypto";
import { access, lstat, mkdtemp, open, realpath, rename, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DeviceFileExclusion } from "./file-sync.js";

const run = promisify(execFile);
const TIMEOUT_MS = 30_000;

export type FileSnapshot = { hash: string; identity: string } | null;

export const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
export const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
export const same = (a: FileSnapshot, b: FileSnapshot) => JSON.stringify(a) === JSON.stringify(b);
export const identity = (s: Awaited<ReturnType<typeof lstat>>) =>
	`${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}:${s.nlink}`;

export function checkSignal(signal?: AbortSignal) {
	signal?.throwIfAborted();
}

/** Portable paths only. Case-fold duplicates even on case-sensitive hosts so a
 * bundle retains the same meaning when sent to Windows/macOS. */
export function deniedPart(part: string): DeviceFileExclusion["reason"] | undefined {
	if (/^(\.git|node_modules)$/i.test(part)) return "ignored";
	if (
		/^(\.env.*|\.ssh|\.aws|\.azure|\.gnupg|\.kube|\.npmrc|\.pypirc|\.netrc|_netrc|\.git-credentials|credentials(?:\..*)?|secrets?(?:\..*)?|tokens?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|authorized_keys|known_hosts)$/i.test(
			part,
		) ||
		/\.(?:pem|key|p12|pfx|keystore)$/i.test(part)
	)
		return "sensitive";
	return undefined;
}

export function safePath(value: unknown, allowDenied = false): string {
	if (
		typeof value !== "string" ||
		!value ||
		Buffer.byteLength(value, "utf8") > 1024 ||
		Buffer.from(value, "utf8").toString("utf8") !== value ||
		value.normalize("NFC") !== value ||
		isAbsolute(value) ||
		/[\\:\x00-\x1f\x7f]/.test(value)
	)
		throw new Error("Unsafe file path");
	const parts = value.split("/");
	if (parts.length > 32) throw new Error("File path is too deep");
	for (const part of parts) {
		if (
			!part ||
			part === "." ||
			part === ".." ||
			/[. ]$/.test(part) ||
			Buffer.byteLength(part) > 255 ||
			/[<>"|?*]/.test(part) ||
			/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)
		)
			throw new Error("Unsafe file path component");
		if (!allowDenied && deniedPart(part)) throw new Error("Sensitive file path is denied");
	}
	return value;
}

export function within(root: string, path: string) {
	const rel = relative(root, path);
	return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/** Reject symlinks/junctions at every existing component, including ancestors. */
export async function checkChain(path: string, allowMissing = false, signal?: AbortSignal) {
	checkSignal(signal);
	const absolute = resolve(path);
	let current = parse(absolute).root;
	const parts = absolute.slice(current.length).split(sep).filter(Boolean);
	for (let i = 0; i < parts.length; i++) {
		current = join(current, parts[i]);
		let s;
		try {
			s = await lstat(current);
			checkSignal(signal);
		} catch (e) {
			if (allowMissing && missing(e)) return;
			throw e;
		}
		if (s.isSymbolicLink()) throw new Error("Symlink paths are denied");
		if (i < parts.length - 1 && !s.isDirectory()) throw new Error("Path ancestor is not a directory");
		const canonical = await realpath(current);
		checkSignal(signal);
		if (relative(resolve(current), canonical) !== "") throw new Error("Real path changed");
	}
}

/** Deterministic JSON tuple hash for manifests */
export function computeManifestHash(files: { path: string; size: number; sha256: string }[]): string {
	const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
	const tuples = sorted.map((f) => [f.path, f.size, f.sha256]);
	return hash(JSON.stringify(tuples));
}

/** Atomic metadata-preserving save for bytes, shared between file-sync and transfer-stream. */
export async function saveBytesPreservingMetadata({
	path,
	bytes,
	baseline,
	signal,
}: {
	path: string;
	bytes: Buffer;
	baseline: FileSnapshot;
	signal?: AbortSignal;
}): Promise<void> {
	checkSignal(signal);
	if (!["linux", "darwin", "freebsd", "win32"].includes(process.platform))
		throw new Error(`Metadata-preserving saves unsupported on platform: ${process.platform}`);

	await access(path, constants.W_OK);
	const stageDir = await mkdtemp(join(dirname(path), ".pi-save-"));
	const staged = join(stageDir, "content");
	const backup = join(stageDir, "original");
	let committed = false;

	try {
		checkSignal(signal);
		if (process.platform !== "win32") {
			await run(
				"cp",
				process.platform === "linux"
					? ["--preserve=mode,ownership,timestamps,xattr", "--", path, staged]
					: ["-p", path, staged],
				{
					timeout: TIMEOUT_MS,
					signal,
				},
			);
		}

		const handle = await open(staged, process.platform === "win32" ? "wx" : "r+", 0o600);
		try {
			checkSignal(signal);
			await handle.writeFile(bytes);
			await handle.truncate(bytes.length);
			await handle.sync();
		} finally {
			await handle.close();
		}

		if (process.platform === "linux") {
			await run("cp", ["--attributes-only", "--preserve=mode,ownership,timestamps,xattr", "--", path, staged], {
				timeout: TIMEOUT_MS,
				signal,
			});
		}

		checkSignal(signal);
		const currentStat = await lstat(path);
		if (baseline && baseline.identity !== identity(currentStat)) {
			throw new Error("Baseline changed before replacement");
		}

		await checkChain(stageDir, false, signal);

		if (process.platform === "win32") {
			const script =
				"$ErrorActionPreference='Stop'; try { [IO.File]::Replace($env:PI_SAVE_SOURCE,$env:PI_SAVE_TARGET,$env:PI_SAVE_BACKUP,$false) } catch { [Console]::Error.WriteLine($_.Exception.ToString()); exit 1 }";
			await run(
				"powershell.exe",
				[
					"-NoLogo",
					"-NoProfile",
					"-NonInteractive",
					"-EncodedCommand",
					Buffer.from(script, "utf16le").toString("base64"),
				],
				{
					timeout: TIMEOUT_MS,
					signal,
					windowsHide: true,
					env: { ...process.env, PI_SAVE_SOURCE: staged, PI_SAVE_TARGET: path, PI_SAVE_BACKUP: backup },
				},
			);
		} else {
			await rename(staged, path);
		}
		committed = true;
	} catch (error) {
		const hasBackup = await lstat(backup).then(
			() => true,
			(e) => {
				if (missing(e)) return false;
				throw e;
			},
		);
		if (hasBackup) throw new Error(`Replacement failed; recovery retained at ${backup}`, { cause: error });
		throw error;
	} finally {
		const hasBackup = await lstat(backup).then(
			() => true,
			(e) => {
				if (missing(e)) return false;
				throw e;
			},
		);
		if (committed || !hasBackup) await rm(stageDir, { recursive: true, force: true });
	}
}
