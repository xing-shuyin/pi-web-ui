import { type Express, type Request } from "express";
import { randomUUID } from "node:crypto";
import { uploadLimitBytes } from "./payload-limits.js";
import { writeRemoteUploadExclusive } from "./uploads.js";
import { mkdtemp, mkdir, open, realpath, rm, stat, link } from "node:fs/promises";
import { join, dirname, posix } from "node:path";
import { tmpdir } from "node:os";
import { createArchive, extractArchive, safeDestination, safeEntryPath, type ConflictPolicy } from "./file-archives.js";
import { isAbsoluteWirePath, wireToAbs, workspacePath } from "./files-service.js";
import {
	getGlobalRemoteSshService,
	isRemoteWorkspaceUri,
	parseRemoteWorkspaceUri,
	resolveRemoteWorkspacePath,
	shellQuotePosix,
} from "./remote-ssh-service.js";

export function registerFileTransferRoutes(
	app: Express,
	getCwd: (clientId: string) => string | undefined,
	temporaryRoot = tmpdir(),
	getMaxUploadBytes: (clientId: string) => number = () => uploadLimitBytes({}, "folder"),
): void {
	const busy = new Set<string>();
	function root(req: Request): string {
		const id = typeof req.query.clientId === "string" ? req.query.clientId : "";
		const cwd = getCwd(id);
		if (!cwd) throw new Error("Client is not connected; reconnect before transferring files");
		return cwd;
	}
	function path(cwd: string, raw: unknown): string {
		if (typeof raw !== "string" || raw === "@root") throw new Error("Invalid path");
		if (isAbsoluteWirePath(raw)) return wireToAbs(raw);
		const resolved = workspacePath(cwd, raw);
		if (!resolved) throw new Error("Path outside workspace");
		return resolved.abs;
	}
	function remotePath(cwd: string, raw: unknown, allowRoot = false): string {
		if (typeof raw !== "string" || raw === "@root") throw new Error("Invalid path");
		const parsed = parseRemoteWorkspaceUri(cwd);
		if (!parsed) throw new Error("Invalid remote workspace");
		let trimmed = raw.trim();
		if (isRemoteWorkspaceUri(trimmed)) {
			const parsedRaw = parseRemoteWorkspaceUri(trimmed);
			if (parsedRaw) {
				trimmed = parsedRaw.remotePath;
			}
		}
		if (!trimmed || trimmed === ".") {
			if (!allowRoot) throw new Error("Invalid path");
			return parsed.remotePath;
		}
		if (trimmed.startsWith("/")) {
			const abs = posix.normalize(trimmed);
			if (abs === "/" && !allowRoot) throw new Error("Invalid path");
			return abs;
		}
		const w = resolveRemoteWorkspacePath(parsed.remotePath, trimmed);
		if (!w || (!allowRoot && w.rel === "")) throw new Error("Path outside workspace");
		return w.abs;
	}
	app.use("/api/file-transfer", (req, res, next) => {
		if (req.headers["x-file-operation"] !== "1") {
			res.status(403).send("Missing file operation header");
			return;
		}
		next();
	});
	app.post("/api/file-transfer/archive", async (req, res) => {
		let cwd: string | undefined;
		let acquired = false;
		let temp: string | undefined;
		try {
			cwd = root(req);
			if (busy.has(cwd)) {
				res.status(409).send("Another file operation is running");
				return;
			}
			busy.add(cwd);
			acquired = true;
			if (isRemoteWorkspaceUri(cwd)) {
				const sshSvc = getGlobalRemoteSshService();
				if (!sshSvc) throw new Error("Remote SSH service not available");
				const remoteSource = remotePath(cwd, req.body?.path);
				if (req.body?.action === "extract") {
					const remoteDest = remotePath(cwd, req.body?.destination, true);
					const lower = remoteSource.toLowerCase();
					const cmd = lower.endsWith(".zip")
						? `mkdir -p ${shellQuotePosix(remoteDest)} && unzip -o ${shellQuotePosix(remoteSource)} -d ${shellQuotePosix(remoteDest)}`
						: `mkdir -p ${shellQuotePosix(remoteDest)} && tar -xf ${shellQuotePosix(remoteSource)} -C ${shellQuotePosix(remoteDest)}`;
					const r = await sshSvc.execInWorkspace(cwd, cmd, { cwd: "/" });
					if (r.exitCode !== 0) throw new Error(r.stderr || r.stdout || "Remote extract failed");
					res.json({ extracted: 1, skipped: [] });
					return;
				}
				if (req.body?.action === "compress") {
					const parentDir = posix.dirname(remoteSource) || "/";
					const baseName = posix.basename(remoteSource);
					const archiveName = `${baseName}.tar.gz`;
					const remoteDest = posix.join(parentDir, archiveName);
					const cmd = `tar -czf ${shellQuotePosix(remoteDest)} -C ${shellQuotePosix(parentDir)} ${shellQuotePosix(baseName)}`;
					const r = await sshSvc.execInWorkspace(cwd, cmd, { cwd: "/" });
					if (r.exitCode !== 0) throw new Error(r.stderr || r.stdout || "Remote compress failed");
					res.json({ name: archiveName });
					return;
				}
				if (req.body?.action === "download") {
					const parentDir = posix.dirname(remoteSource) || "/";
					const baseName = posix.basename(remoteSource);
					const archiveName = `${baseName}.tar.gz`;
					const remoteTmp = `/tmp/pi-web-dl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tar.gz`;
					try {
						const cmd = `tar -czf ${shellQuotePosix(remoteTmp)} -C ${shellQuotePosix(parentDir)} ${shellQuotePosix(baseName)}`;
						const r = await sshSvc.execInWorkspace(cwd, cmd, { cwd: "/" });
						if (r.exitCode !== 0) throw new Error(r.stderr || r.stdout || "Remote archive creation failed");
						const st = await sshSvc.sftpStat(cwd, remoteTmp);
						if (st.size > 200 * 1024 * 1024) {
							throw new Error("Temporary download exceeds 200 MiB; compress in place and download the archive instead");
						}
						const asciiFallback = archiveName.replace(/[^\x20-\x7e]|["\\]/g, "_");
						const encoded = encodeURIComponent(archiveName).replace(
							/['()*]/g,
							(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
						);
						res.type(archiveName);
						res.setHeader(
							"Content-Disposition",
							`attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`,
						);
						res.setHeader("Content-Length", String(st.size));
						const stream = await sshSvc.sftpCreateReadStream(cwd, remoteTmp);
						await new Promise<void>((ok, fail) => {
							stream.on("error", fail);
							res.on("finish", ok);
							res.on("close", ok);
							stream.pipe(res);
						});
					} finally {
						await sshSvc.execInWorkspace(cwd, `rm -f ${shellQuotePosix(remoteTmp)}`, { cwd: "/" }).catch(() => {});
					}
					return;
				}
				throw new Error("Invalid archive action");
			}
			const source = path(cwd, req.body?.path);
			if (req.body?.action === "extract") {
				const result = await extractArchive(source, path(cwd, req.body.destination), req.body.policy as ConflictPolicy);
				res.json(result);
			} else if (req.body?.action === "compress" || req.body?.action === "download") {
				if (req.body.action === "download") temp = await mkdtemp(join(temporaryRoot, "pi-web-download-"));
				const archive = await createArchive(source, temp);
				if (temp) {
					if (res.destroyed) throw new Error("Download cancelled");
					if ((await stat(archive.path)).size > 200 * 1024 * 1024)
						throw new Error("Temporary download exceeds 200 MiB; compress in place and download the archive instead");
					await new Promise<void>((ok, fail) =>
						res.download(archive.path, archive.name, { dotfiles: "allow" }, (err) => (err ? fail(err) : ok())),
					);
				} else res.json({ name: archive.name });
			} else throw new Error("Invalid archive action");
		} catch (err) {
			if (!res.headersSent && !res.destroyed) res.status(400).send(err instanceof Error ? err.message : String(err));
		} finally {
			if (temp)
				await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch((err) =>
					console.error("Temporary archive cleanup failed:", err),
				);
			if (acquired && cwd) busy.delete(cwd);
		}
	});
	const maxInFlight = 200 * 1024 * 1024;
	let uploads = 0;
	let inFlight = 0;
	app.post("/api/file-transfer/upload", async (req, res) => {
		let reserved: number | undefined;
		let temp: string | undefined;
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		const controller = new AbortController();
		const cancel = () => controller.abort();
		res.on("close", cancel);
		try {
			const cwd = root(req);
			const maxBytes = getMaxUploadBytes(String(req.query.clientId));
			const name = safeEntryPath(typeof req.query.name === "string" ? req.query.name : "");
			const directory = req.query.kind === "directory";
			const remote = isRemoteWorkspaceUri(cwd);
			const ssh = remote ? getGlobalRemoteSshService() : undefined;
			if (remote && !ssh) throw new Error("Remote SSH service not available");
			const dir = remote
				? remotePath(cwd, typeof req.query.dir === "string" ? req.query.dir : "", true)
				: await realpath(path(cwd, req.query.dir));
			const dest = remote ? posix.join(dir, name) : await safeDestination(dir, name);
			if (!req.is("application/octet-stream")) throw new Error("Expected a binary file");
			const lengthHeader = req.headers["content-length"];
			const length = lengthHeader === undefined ? undefined : Number(lengthHeader);
			if (length !== undefined && (!Number.isSafeInteger(length) || length < 0))
				throw new Error("Invalid content length");
			if (length !== undefined && length > (directory ? 0 : maxBytes)) {
				res.status(413).send("Upload exceeds size limit");
				return;
			}
			const budget = length ?? (directory ? 0 : maxBytes);
			if (uploads >= 4 || inFlight + budget > maxInFlight) {
				res.status(429).send("Upload capacity exhausted; retry later");
				return;
			}
			uploads++;
			inFlight += budget;
			reserved = budget;
			if (!remote && !directory) {
				await mkdir(dirname(dest), { recursive: true });
				await safeDestination(dir, name);
				temp = join(dirname(dest), `.pi-upload-${randomUUID()}`);
				handle = await open(temp, "wx", 0o600);
			}
			let bytes = 0;
			const chunks: Buffer[] = [];
			for await (const chunk of req.iterator({ destroyOnReturn: false })) {
				controller.signal.throwIfAborted();
				const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				bytes += data.length;
				if (bytes > budget || (directory && bytes > 0)) {
					res.status(413).send("Upload exceeds size limit");
					return;
				}
				if (handle) await handle.writeFile(data);
				else if (!directory) chunks.push(data);
			}
			if (length !== undefined && bytes !== length) throw new Error("Incomplete upload");
			controller.signal.throwIfAborted();
			if (directory) {
				if (ssh) await ssh.sftpMkdirRecursive(cwd, dest);
				else await mkdir(dest, { recursive: true });
			} else if (ssh) {
				await writeRemoteUploadExclusive(ssh, cwd, dest, Buffer.concat(chunks, bytes), controller.signal);
			} else {
				await handle!.close();
				handle = undefined;
				await safeDestination(dir, name);
				controller.signal.throwIfAborted();
				await link(temp!, dest);
			}
			res.json({ name });
		} catch (err) {
			if (!res.headersSent && !res.destroyed)
				res
					.status((err as NodeJS.ErrnoException).code === "EEXIST" ? 409 : 400)
					.send(err instanceof Error ? err.message : String(err));
		} finally {
			res.off("close", cancel);
			await handle?.close().catch(() => {});
			if (temp)
				await rm(temp, { force: true, maxRetries: 5, retryDelay: 100 }).catch((err) =>
					console.error("Upload cleanup failed:", err),
				);
			if (reserved !== undefined) {
				uploads--;
				inFlight -= reserved;
			}
		}
	});
}
