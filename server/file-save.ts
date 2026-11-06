import { execFile } from "node:child_process";
import { access, mkdtemp, open, realpath, rename, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const timeout = 30_000;
const attributes = "--preserve=mode,ownership,timestamps,xattr";

export async function saveFilePreservingMetadata(path: string, text: string): Promise<void> {
	const target = await realpath(path);
	const before = await stat(target);
	if (!before.isFile()) throw new Error("Save target is not a regular file");
	if (before.nlink > 1) throw new Error("Cannot atomically save a file with multiple hard links");
	await access(target, constants.W_OK);
	if (!["win32", "linux", "darwin", "freebsd"].includes(process.platform))
		throw new Error(`Metadata-preserving saves are unsupported on ${process.platform}`);

	const stageDir = await mkdtemp(join(dirname(target), ".pi-save-"));
	const staged = join(stageDir, "content");
	const backup = join(stageDir, "original");
	let committed = false;
	try {
		if (process.platform !== "win32") {
			await run("cp", process.platform === "linux" ? [attributes, "--", target, staged] : ["-p", target, staged], {
				timeout,
			});
		}
		const handle = await open(staged, process.platform === "win32" ? "wx" : "r+", 0o600);
		try {
			await handle.writeFile(text, "utf8");
			await handle.truncate(Buffer.byteLength(text, "utf8"));
			await handle.sync();
		} finally {
			await handle.close();
		}
		if (process.platform === "linux") {
			await run("cp", ["--attributes-only", attributes, "--", target, staged], { timeout });
			const metadataHandle = await open(staged, "r");
			try {
				await metadataHandle.sync();
			} finally {
				await metadataHandle.close();
			}
		}
		const current = await stat(target);
		if (
			current.dev !== before.dev ||
			current.ino !== before.ino ||
			current.nlink > 1 ||
			current.size !== before.size ||
			current.mtimeMs !== before.mtimeMs ||
			current.ctimeMs !== before.ctimeMs
		)
			throw new Error("Save target changed while preparing replacement; retry saving");
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
					timeout,
					windowsHide: true,
					env: { ...process.env, PI_SAVE_SOURCE: staged, PI_SAVE_TARGET: target, PI_SAVE_BACKUP: backup },
				},
			);
		} else await rename(staged, target);
		committed = true;
	} catch (error) {
		if (
			await stat(backup).then(
				() => true,
				() => false,
			)
		)
			throw new Error(`Save failed; recovery file retained at ${backup}`, { cause: error });
		throw error;
	} finally {
		const hasBackup = await stat(backup).then(
			() => true,
			() => false,
		);
		if (committed || !hasBackup) await rm(stageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
}
