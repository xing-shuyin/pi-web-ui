import { randomBytes } from "node:crypto";
import { mkdir, open, rm, readdir, stat } from "node:fs/promises";
import path from "node:path";

export const STOP_GUARANTEE = "SSH channel closed; remote processes and descendants may continue.";
export const id = () => randomBytes(24).toString("hex");
export function text(value, name, max = 4096) {
	if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0"))
		throw new Error(`Invalid ${name}`);
	return value.trim();
}
export function integer(value, fallback, min, max) {
	const n = value === undefined ? fallback : Number(value);
	if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Expected integer ${min}..${max}`);
	return n;
}
export const quote = (s) => `'${String(s).replaceAll("'", `'"'"'`)}'`;
export function utf8Tail(buffer, limit = 32768) {
	let start = Math.max(0, buffer.length - limit);
	while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
	return Buffer.from(buffer.subarray(start));
}
export function closeChannel(stream) {
	stream?.on?.("error", () => {});
	stream?.stderr?.on?.("error", () => {});
	try {
		stream.signal?.("TERM");
	} catch {}
	try {
		stream.close?.();
	} catch {}
	try {
		stream.destroy?.();
	} catch {}
}
export async function profile(svc, name) {
	const p = (await svc.listProfiles()).find((p) => p.name === name);
	if (!p) throw new Error(`Unknown SSH profile: ${name}`);
	return p;
}

export class Commands {
	constructor(host, svc, options = {}) {
		this.svc = svc;
		this.fileFactory = options.fileFactory ?? open;
		this.dir = path.join(host.dataDir, "remote-workbench-logs");
		this.logs = new Map();
		this.running = new Set();
		this.writing = new Set();
		this.disposed = false;
		this.totalBytes = 0;
		this.maxTotalBytes = options.maxTotalBytes ?? 256 * 1024 * 1024;
		this.maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
		this.ttl = options.ttl ?? 24 * 60 * 60 * 1000;
		this.reserved = 0;
		this.ready = this.initialize();
		this.ready.catch(() => {});
	}
	async run(args, signal, update) {
		if (this.disposed) throw new Error("Runtime disposed");
		const cmd = text(args.cmd, "cmd", 65536);
		const cwd = args.cwd ? text(args.cwd, "cwd") : "";
		const timeout = integer(args.timeout, 30, 1, 3600) * 1000;
		await this.ready;
		if (this.disposed || signal?.aborted) throw new Error("Cancelled");
		if (this.writing.size + this.reserved >= 16) throw new Error("Command concurrency capacity reached");
		if (this.logs.size + this.reserved >= 128) throw new Error("Log capacity reached; retry after logs expire");
		this.reserved++;
		const logId = id();
		const filePath = path.join(this.dir, logId);
		let file;
		try {
			file = await this.fileFactory(filePath, "wx", 0o600);
		} finally {
			this.reserved--;
		}
		const record = { filePath, totalBytes: 0, committedBytes: 0, expiresAt: Date.now() + this.ttl };
		this.logs.set(logId, record);
		this.writing.add(logId);
		return new Promise((resolve) => {
			let stream,
				settled = false,
				output = Buffer.alloc(0),
				pending = Promise.resolve(),
				pendingBytes = 0,
				error,
				timedOut = false,
				cancelled = false,
				truncated = false;
			const finish = (code = null, reason) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				this.running.delete(abort);
				if (reason) {
					error = String(reason);
					closeChannel(stream);
				}
				pending
					.catch((e) => {
						error = String(e.message ?? e);
					})
					.then(async () => {
						await file.close().catch((e) => {
							error = String(e.message ?? e);
						});
						this.writing.delete(logId);
						record.expiresAt = Date.now() + this.ttl;
						resolve({
							ok: code === 0 && !error,
							exitCode: code,
							output: output.toString("utf8"),
							truncated,
							logId,
							bytes: record.totalBytes,
							timedOut,
							cancelled,
							stopGuarantee: reason ? STOP_GUARANTEE : "SSH channel exited; detached descendants are not tracked.",
							...(error ? { error } : {}),
						});
					});
			};
			const abort = () => {
				cancelled = true;
				finish(null, "Cancelled");
			};
			const timer = setTimeout(() => {
				timedOut = true;
				finish(null, "Timed out");
			}, timeout);
			timer.unref?.();
			this.running.add(abort);
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted || this.disposed) {
				abort();
				return;
			}
			const receive = (chunk) => {
				if (settled) return;
				const b = Buffer.from(chunk);
				if (
					record.totalBytes + b.length > this.maxBytes ||
					this.totalBytes + b.length > this.maxTotalBytes ||
					pendingBytes + b.length > 1024 * 1024
				) {
					truncated = true;
					finish(null, "Log capacity reached; channel closed");
					return;
				}
				const offset = record.totalBytes;
				record.totalBytes += b.length;
				this.totalBytes += b.length;
				pendingBytes += b.length;
				output = utf8Tail(Buffer.concat([output, b]));
				truncated ||= record.totalBytes > 32768;
				stream.pause?.();
				stream.stderr?.pause?.();
				pending = pending
					.then(async () => {
						let written = 0;
						while (written < b.length) {
							const r = await file.write(b, written, b.length - written, offset + written);
							if (!r.bytesWritten) throw new Error("Log write stalled");
							written += r.bytesWritten;
						}
						record.committedBytes = offset + b.length;
						pendingBytes -= b.length;
						if (!settled && pendingBytes === 0) {
							stream.resume?.();
							stream.stderr?.resume?.();
						}
					})
					.catch((e) => {
						error = String(e.message ?? e);
						closeChannel(stream);
						finish(null, error);
					});
				try {
					update?.({
						content: [{ type: "text", text: output.toString("utf8") }],
						details: { logId, bytes: record.totalBytes },
					});
				} catch {}
			};
			(async () => {
				const p = await profile(this.svc(), text(args.host, "host", 256));
				if (settled) return;
				const dangerous = [
					/\brm\s+(-[a-z]*r[a-z]*f|--force|-[a-z]*f[a-z]*r)\s+[/*]/i,
					/\bmkfs\b/i,
					/\bdd\s+if=/i,
					/\b(shutdown|reboot|poweroff|init\s+0)\b/i,
					/\bdrop\s+(database|schema|table)\b/i,
					/:\(\)\{\s*:\|:&\s*\};:/,
				];
				if (p.reviewMode && dangerous.some((pattern) => pattern.test(cmd)))
					throw new Error("Approval Gate: destructive command rejected for review-mode host");
				const targetDir = cwd || p.remotePath;
				const conn = await this.svc().getOrConnectHost(p.host, p.port, p.username);
				if (settled) return;
				conn.client.exec(
					targetDir && targetDir !== "~" ? `cd -- ${quote(targetDir)} && ${cmd}` : cmd,
					(err, channel) => {
						if (settled) {
							closeChannel(channel);
							return;
						}
						if (err) {
							finish(null, err.message);
							return;
						}
						stream = channel;
						stream.on("data", receive);
						stream.stderr?.on("data", receive);
						stream.on("error", (e) => finish(null, e.message));
						stream.stderr?.on("error", (e) => finish(null, e.message));
						stream.on("close", (code) => finish(Number.isInteger(code) ? code : null));
					},
				);
			})().catch((e) => finish(null, e.message));
		});
	}
	async read(logId, offset = 0, limit = 65536) {
		await this.ready;
		const r = this.logs.get(logId);
		if (!r) throw new Error("Log expired or unknown");
		const committed = r.committedBytes ?? r.totalBytes;
		offset = integer(offset, 0, 0, committed);
		limit = integer(limit, 65536, 1, 65536);
		const f = await open(r.filePath, "r");
		try {
			const b = Buffer.alloc(Math.min(limit, committed - offset));
			const { bytesRead } = await f.read(b, 0, b.length, offset);
			return {
				logId,
				b64: b.subarray(0, bytesRead).toString("base64"),
				offset,
				nextOffset: offset + bytesRead,
				totalBytes: committed,
				running: this.writing.has(logId),
				eof: !this.writing.has(logId) && offset + bytesRead >= committed,
			};
		} finally {
			await f.close();
		}
	}
	async readText(logId, offset = 0, limit = 8192) {
		limit = integer(limit, 8192, 4, 16384);
		const page = await this.read(logId, offset, limit + 4);
		const bytes = Buffer.from(page.b64, "base64");
		let start = 0;
		while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
		let end = Math.min(limit, bytes.length);
		while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
		const { b64: _b64, ...meta } = page;
		return {
			...meta,
			text: bytes.subarray(start, end).toString("utf8"),
			nextOffset: page.offset + end,
			eof: page.eof && end === bytes.length,
		};
	}
	async initialize() {
		await mkdir(this.dir, { recursive: true });
		for (const entry of await readdir(this.dir, { withFileTypes: true })) {
			if (!entry.isFile() || !/^[a-f0-9]{48}$/.test(entry.name)) continue;
			const filePath = path.join(this.dir, entry.name),
				info = await stat(filePath);
			if (info.mtimeMs + this.ttl < Date.now()) {
				await rm(filePath);
				continue;
			}
			this.logs.set(entry.name, { filePath, totalBytes: info.size, expiresAt: info.mtimeMs + this.ttl });
			this.totalBytes += info.size;
		}
		for (const [key, r] of [...this.logs].sort((a, b) => a[1].expiresAt - b[1].expiresAt)) {
			if (this.totalBytes <= this.maxTotalBytes && this.logs.size <= 128) break;
			await rm(r.filePath);
			this.logs.delete(key);
			this.totalBytes -= r.totalBytes;
		}
	}
	async sweep() {
		await this.ready;
		if (this.sweeping) return;
		this.sweeping = true;
		try {
			for (const [key, r] of this.logs)
				if (!this.writing.has(key) && r.expiresAt < Date.now()) {
					await rm(r.filePath, { force: true });
					this.totalBytes -= r.totalBytes;
					this.logs.delete(key);
				}
		} finally {
			this.sweeping = false;
		}
	}
	dispose() {
		this.disposed = true;
		for (const abort of this.running) abort();
	}
}
