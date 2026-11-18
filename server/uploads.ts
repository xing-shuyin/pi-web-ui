import { readdir, rm, stat } from "node:fs/promises";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { publishFileExclusiveSync } from "./atomic-file.js";
import { shellQuotePosix, type RemoteSshService } from "./remote-ssh-service.js";
import { homedir } from "node:os";
import { join, resolve, posix } from "node:path";

export function resolveDataDir(): string {
	return resolve(process.env.PI_WEB_DATA_DIR ?? join(homedir(), ".pi-web"));
}

export function uploadsRoot(dataDir = resolveDataDir()): string {
	return join(dataDir, "uploads");
}

export function uploadRetentionDays(): number {
	const v = Number(process.env.PI_WEB_UPLOAD_RETENTION_DAYS);
	return Number.isFinite(v) && v >= 0 ? v : 14;
}

export const CLIENT_ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;

export function saveUpload(
	clientId: string,
	name: string,
	buf: Buffer,
	dataDir = resolveDataDir(),
): { abs: string; displayName: string } {
	if (!CLIENT_ID_PATTERN.test(clientId)) {
		throw new Error(`Invalid upload clientId: ${JSON.stringify(clientId.slice(0, 129))}`);
	}
	const base = name.split(/[\\/]/).pop() ?? "";
	if (!base || base === "." || base === "..") {
		throw new Error(`Invalid upload name: ${JSON.stringify(name.slice(0, 129))}`);
	}
	const displayName = base.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 80) || "file";
	const dir = join(uploadsRoot(dataDir), clientId);
	mkdirSync(dir, { recursive: true });
	const abs = join(dir, `${Date.now()}-${randomUUID()}-${displayName}`);
	writeUploadExclusiveSync(abs, buf);
	return { abs, displayName };
}

export function writeUploadExclusiveSync(dest: string, data: Buffer): void {
	const temp = `${dest}.${randomUUID()}.upload`;
	try {
		writeFileSync(temp, data, { flag: "wx", mode: 0o600 });
		// 独占发布：硬链接不可用的文件系统（Termux /data、FAT32 …）上降级为排他复制，不再 EACCES 整链断。
		publishFileExclusiveSync(temp, dest);
	} finally {
		rmSync(temp, { force: true });
	}
}

export async function writeRemoteUploadExclusive(
	ssh: RemoteSshService,
	cwd: string,
	dest: string,
	data: Buffer,
	signal?: AbortSignal,
): Promise<void> {
	const temp = `${dest}.${randomUUID()}.upload`;
	const operationSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
	const cleanup = async () => {
		const result = await ssh.execInWorkspace(cwd, `rm -f ${shellQuotePosix(temp)}`, {
			cwd: "/",
			timeoutMs: 5000,
			signal: AbortSignal.timeout(5000),
		});
		if (result.exitCode !== 0) throw new Error(result.stderr || "Remote upload cleanup failed");
	};
	try {
		operationSignal.throwIfAborted();
		await ssh.sftpWriteFile(cwd, temp, data, {
			createParents: true,
			flag: "wx",
			signal: operationSignal,
			timeoutMs: 30_000,
		});
		operationSignal.throwIfAborted();
		const target = shellQuotePosix(dest);
		const stray = shellQuotePosix(posix.join(dest, posix.basename(temp)));
		// 远端也要能降级：硬链接不可用的 fs（Termux /data、FAT32 挂载、SMB）上 `ln` 直接失败，整链会断在最后一步。
		// 但不能简单地 `cp -n`：目标已存在时它静默成功且不覆盖，等于「假装发布成功」，独占语义就没了。
		// 所以复制前后各判一次存在：前判给出干净的失败，后判堵住 test 与 cp 之间的竞态（ln 自己不存在这个窗口）。
		// 已存在一律 exit 17（调用方据此回 EEXIST/409）；复制出错用 exit 18，避开把磁盘满误报成 409。
		const commit = [
			`if test -e ${target} || test -L ${target}; then exit 17; fi`,
			`ln ${shellQuotePosix(temp)} ${target} || { if test -e ${target} || test -L ${target}; then exit 17; fi; cp ${shellQuotePosix(temp)} ${target} || exit 18; }`,
			`if test -d ${target}; then rm -f ${stray}; exit 17; fi`,
		].join("; ");
		const result = await ssh.execInWorkspace(cwd, commit, {
			cwd: "/",
			timeoutMs: 30_000,
			signal: operationSignal,
		});
		if (result.exitCode !== 0) {
			const error = new Error(result.stderr || result.stdout || "Upload commit failed") as NodeJS.ErrnoException;
			if (result.exitCode === 17) error.code = "EEXIST";
			throw error;
		}
	} finally {
		await cleanup();
	}
}

export async function cleanupUploads(
	dataDir = resolveDataDir(),
	retentionDays = uploadRetentionDays(),
): Promise<{ files: number; bytes: number; dirs: number }> {
	const out = { files: 0, bytes: 0, dirs: 0 };
	if (retentionDays <= 0) return out;
	const root = uploadsRoot(dataDir);
	if (!existsSync(root)) return out;

	const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
	let clients: string[];
	try {
		clients = await readdir(root);
	} catch {
		return out;
	}
	for (const clientId of clients) {
		const dir = join(root, clientId);
		let entries: string[];
		try {
			entries = await readdir(dir);
		} catch {
			continue;
		}
		for (const entry of entries) {
			const abs = join(dir, entry);
			try {
				const st = await stat(abs);
				if (st.mtimeMs >= cutoff) continue;
				await rm(abs, { recursive: true });
				out.files++;
				out.bytes += st.size;
			} catch {}
		}
		try {
			if ((await readdir(dir)).length === 0) {
				await rmdirSafe(dir);
				out.dirs++;
			}
		} catch {}
	}
	return out;
}

async function rmdirSafe(dir: string): Promise<void> {
	try {
		await rm(dir, { recursive: false });
	} catch {}
}

export function scheduleUploadCleanup(intervalMs = 6 * 60 * 60 * 1000): void {
	void cleanupUploads().catch(() => {});
	const timer = setInterval(() => {
		void cleanupUploads().catch(() => {});
	}, intervalMs);
	timer.unref?.();
}
