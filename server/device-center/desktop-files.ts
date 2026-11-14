import express, { type Express, type Request, type Response } from "express";
import { createHash, randomBytes } from "node:crypto";
import { hostname, homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, statfs, type FileHandle } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import * as tar from "tar";
import { clipboardName } from "./desktop-clipboard-protocol.js";
import { DESKTOP_FILE_LIMITS as limits, fileChunkCrc } from "./desktop-files-protocol.js";
import { desktopFilePaths, publishDesktopFiles, type PublishedFile } from "./desktop-files-fs.js";

type Entry = {
	path: string;
	size: number;
	directory: boolean;
	offset: number;
	crc: number;
	ino?: number;
	dev?: number;
	last?: { offset: number; size: number; hash: string };
};
type Job = {
	id: string;
	key: string;
	signature: string;
	root: string;
	entries: Entry[];
	total: number;
	touched: number;
	busy: boolean;
	destination?: string;
	published: Map<string, PublishedFile>;
	saved?: string[];
	complete?: string;
	cancelled?: boolean;
};
type Download = { path: string; directory: boolean; size: number; touched: number; streaming: boolean };
const fail = (message: string, status = 400) => Object.assign(new Error(message), { status });
const id = () => randomBytes(16).toString("hex");

export function desktopRelativePath(value: unknown): string {
	if (typeof value !== "string" || value.length > 1024 || value.includes("\\")) throw fail("Invalid file path");
	const parts = value.split("/");
	if (parts.length > 32 || parts.some((part) => !clipboardName(part))) throw fail("Invalid file name or path");
	return parts.join("/");
}

export function createDesktopFiles(options: {
	app: Express;
	allowed: (req: Request) => boolean;
	enabled: () => boolean;
	home?: string;
	base?: string;
	access?: (req: Request) => "read" | "write" | undefined;
}) {
	const jobs = new Map<string, Job>(),
		downloads = new Map<string, Download>();
	const home = resolve(options.home ?? homedir());
	const paths = desktopFilePaths(home, options.home !== undefined);
	const exports = new Map<
		string,
		{
			touched: number;
			entries: {
				path: string;
				source: string;
				directory: boolean;
				size: number;
				mtime: number;
				ino: number;
				dev: number;
			}[];
		}
	>();
	const inbox = join(home, "Downloads", "pi-web-ui-Received");
	let stopped = false,
		creating = false;
	const activeResponses = new Set<Response>();
	const total = () => [...jobs.values()].filter((job) => !job.complete).reduce((n, job) => n + job.total, 0);
	const dispose = async (job: Job) => {
		job.cancelled = true;
		if (job.busy) return;
		jobs.delete(job.id);
		if (!job.complete) await rm(job.root, { recursive: true, force: true });
	};
	const check = (job: Job) => {
		if (job.cancelled || stopped || !options.enabled()) throw fail("Transfer cancelled", 410);
	};
	const snapshot = (job: Job) => ({
		id: job.id,
		total: job.total,
		destination: job.complete ?? job.destination ?? inbox,
		saved: job.saved,
		complete: !!job.complete,
		entries: job.entries.map(({ offset, crc }) => ({ offset, crc })),
	});
	const safeSource = paths.source;
	async function sourceSize(path: string) {
		let bytes = 0,
			count = 0;
		async function visit(current: string) {
			const info = await lstat(current);
			if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()))
				throw fail("Symbolic links and special files cannot be transferred");
			if (++count > limits.entries) throw fail("Too many files (maximum 10000)");
			if (info.isFile()) bytes += info.size;
			if (bytes > limits.bytes) throw fail("Transfer exceeds 16 GiB", 413);
			if (info.isDirectory()) for (const name of await readdir(current)) await visit(join(current, name));
		}
		await visit(path);
		return bytes;
	}
	const router = express.Router();
	router.use((req, res, next) => {
		res.set({ "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
		if (stopped || !options.allowed(req)) return void res.status(403).json({ error: "Desktop authorization required" });
		if (!options.enabled())
			return void res.status(403).json({ error: "Enable remote desktop sharing on this device first" });
		const downloadId = /^\/download\/([a-f0-9]{32})$/.exec(req.path)?.[1];
		const access = options.access?.(req);
		if (options.access && !access && !(req.method === "GET" && downloadId && downloads.has(downloadId)))
			return void res.status(403).json({ error: "Connect the remote desktop before transferring files" });
		if (access === "read" && req.method !== "GET" && (req.path === "/mkdir" || /^\/jobs(?:\/|$)/.test(req.path)))
			return void res.status(403).json({ error: "File sending is unavailable in view-only mode" });
		next();
	});
	router.use(express.json({ limit: "2mb" }));
	const route = (work: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) => {
		void work(req, res).catch((error) => {
			if (res.headersSent) res.destroy();
			else
				res
					.status(error.status ?? (error.code === "ENOSPC" ? 507 : 400))
					.json({ error: error.code === "ENOSPC" ? "Not enough free disk space" : error.message || "Transfer failed" });
		});
	};
	router.get(
		"/info",
		route(async (req, res) =>
			res.json({
				device: hostname(),
				inbox,
				home,
				limits,
				roots: await paths.roots(),
				readOnly: options.access?.(req) === "read",
			}),
		),
	);
	router.post(
		"/jobs",
		route(async (req, res) => {
			const { key, entries, destination } = req.body ?? {};
			if (!/^[a-f0-9]{32}$/.test(key) || !Array.isArray(entries) || !entries.length || entries.length > limits.entries)
				throw fail("Invalid transfer manifest");
			const signature = createHash("sha256").update(JSON.stringify({ entries, destination })).digest("hex");
			const previous = [...jobs.values()].find((job) => job.key === key);
			if (previous) {
				if (previous.signature !== signature) throw fail("Transfer selection changed", 409);
				return res.json(snapshot(previous));
			}
			if (creating || jobs.size >= limits.jobs)
				throw fail("Too many transfers; finish or cancel an existing transfer", 429);
			creating = true;
			let root: string | undefined;
			try {
				const names = new Map<string, boolean>();
				let bytes = 0;
				const manifest: Entry[] = entries.map((entry) => {
					const path = desktopRelativePath(entry?.path),
						directory = entry.directory === true;
					if (!Number.isSafeInteger(entry.size) || entry.size < 0 || (directory && entry.size !== 0))
						throw fail("Invalid file size");
					const folded = path.toLowerCase();
					if (names.has(folded)) throw fail("Duplicate file name");
					names.set(folded, directory);
					bytes += entry.size;
					return { path, directory, size: entry.size, offset: 0, crc: 0 };
				});
				for (const name of names.keys()) {
					const parts = name.split("/");
					parts.pop();
					while (parts.length) {
						if (names.get(parts.join("/")) === false) throw fail("File and folder names overlap");
						parts.pop();
					}
				}
				if (bytes > limits.bytes || total() + bytes > limits.bytes * 2)
					throw fail("Transfer exceeds available 16 GiB / 32 GiB quota", 413);
				if (destination === undefined) await mkdir(inbox, { recursive: true });
				const physical = await safeSource(destination ?? inbox),
					disk = await statfs(physical);
				if (Number(disk.bavail) * Number(disk.bsize) < bytes + 64 * 1024 ** 2)
					throw fail("Not enough free disk space", 507);
				root = await mkdtemp(join(physical, ".incoming-"));
				for (const entry of manifest) {
					const path = join(root, entry.path);
					await mkdir(entry.directory ? path : dirname(path), { recursive: true });
					if (!entry.directory) {
						const file = await open(path, "wx", 0o600);
						try {
							const info = await file.stat();
							entry.ino = info.ino;
							entry.dev = info.dev;
						} finally {
							await file.close();
						}
					}
				}
				if (stopped || !options.enabled()) throw fail("Transfer cancelled", 410);
				const job: Job = {
					id: id(),
					key,
					signature,
					root,
					entries: manifest,
					total: bytes,
					touched: Date.now(),
					busy: false,
					destination: destination === undefined ? undefined : physical,
					published: new Map(),
				};
				jobs.set(job.id, job);
				root = undefined;
				return res.json(snapshot(job));
			} finally {
				creating = false;
				if (root) await rm(root, { recursive: true, force: true });
			}
		}),
	);
	router.get(
		"/jobs/:id",
		route(async (req, res) => {
			const job = jobs.get(String(req.params.id));
			if (!job) throw fail("Transfer expired; select files again", 410);
			job.touched = Date.now();
			return res.json(snapshot(job));
		}),
	);
	router.put(
		"/jobs/:id/chunk",
		express.raw({ type: "application/octet-stream", limit: limits.chunk }),
		route(async (req, res) => {
			const job = jobs.get(String(req.params.id));
			if (!job) throw fail("Transfer expired", 410);
			if (job.busy || job.complete) throw fail("Transfer busy or complete", 409);
			const index = Number(req.query.entry),
				offset = Number(req.query.offset),
				crc = Number(req.query.crc),
				data =
					typeof req.body?.data === "string" && req.body.data.length <= Math.ceil(limits.chunk / 3) * 4
						? Buffer.from(req.body.data, "base64")
						: req.body;
			if (
				!Number.isSafeInteger(index) ||
				!Number.isSafeInteger(offset) ||
				offset < 0 ||
				!Buffer.isBuffer(data) ||
				!data.length ||
				data.length > limits.chunk ||
				fileChunkCrc(data) !== crc
			)
				throw fail("Invalid or corrupted file chunk");
			const entry = job.entries[index];
			if (!entry || entry.directory || offset + data.length > entry.size) throw fail("Invalid file offset");
			const hash = createHash("sha256").update(data).digest("hex");
			if (entry.last?.offset === offset && entry.last.size === data.length && entry.last.hash === hash) {
				job.touched = Date.now();
				return res.json({ offset: entry.offset, crc: entry.crc });
			}
			if (entry.offset !== offset) throw fail("File offset changed; retry this transfer", 409);
			job.busy = true;
			let file: FileHandle | undefined;
			try {
				check(job);
				const path = join(job.root, entry.path);
				if ((await lstat(path)).isSymbolicLink() || !(await realpath(path)).startsWith(job.root + sep))
					throw fail("File path changed", 409);
				file = await open(path, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
				const info = await file.stat();
				if (!info.isFile() || info.ino !== entry.ino || info.dev !== entry.dev || info.nlink !== 1)
					throw fail("File path changed", 409);
				let written = 0;
				while (written < data.length) {
					check(job);
					const result = await file.write(data, written, data.length - written, offset + written);
					if (!result.bytesWritten) throw fail("Unable to write file");
					written += result.bytesWritten;
				}
				entry.crc = fileChunkCrc(data, entry.crc);
				entry.offset += data.length;
				entry.last = { offset, size: data.length, hash };
				job.touched = Date.now();
			} finally {
				try {
					await file?.close();
				} finally {
					job.busy = false;
					if (job.cancelled) await dispose(job);
				}
			}
			return res.json({ offset: entry.offset, crc: entry.crc });
		}),
	);
	router.post(
		"/jobs/:id/finish",
		route(async (req, res) => {
			const job = jobs.get(String(req.params.id));
			if (!job) throw fail("Transfer expired", 410);
			if (job.complete) return res.json(snapshot(job));
			if (job.busy) throw fail("Transfer busy", 409);
			if (
				!Array.isArray(req.body?.checksums) ||
				req.body.checksums.length !== job.entries.length ||
				job.entries.some((entry, index) => entry.offset !== entry.size || entry.crc !== req.body.checksums[index])
			)
				throw fail("File size or checksum mismatch", 409);
			job.busy = true;
			try {
				check(job);
				for (const entry of job.entries) {
					const path = join(job.root, entry.path),
						info = await lstat(path);
					if (
						info.isSymbolicLink() ||
						!(await realpath(path)).startsWith(job.root + sep) ||
						(entry.directory
							? !info.isDirectory()
							: !info.isFile() ||
								info.ino !== entry.ino ||
								info.dev !== entry.dev ||
								(!job.published.size && info.nlink !== 1) ||
								info.size !== entry.size)
					)
						throw fail("File path or size changed", 409);
				}
				const destination =
					job.destination ?? join(dirname(job.root), `${new Date().toISOString().slice(0, 10)}-${job.id}`);
				if (job.destination) {
					if ((await safeSource(job.destination)) !== dirname(job.root)) throw fail("Destination changed", 409);
					job.saved = await publishDesktopFiles(job.root, destination, job.published);
					await rm(job.root, { recursive: true, force: true });
				} else await rename(job.root, destination);
				job.complete = destination;
				job.touched = Date.now();
				return res.json(snapshot(job));
			} finally {
				job.busy = false;
				if (job.cancelled) await dispose(job);
			}
		}),
	);
	router.delete(
		"/jobs/:id",
		route(async (req, res) => {
			const job = jobs.get(String(req.params.id));
			if (job) await dispose(job);
			return res.status(204).end();
		}),
	);
	router.get(
		"/list",
		route(async (req, res) => {
			const path = typeof req.query.path === "string" ? req.query.path : "",
				source = await safeSource(path);
			const entries = await readdir(source, { withFileTypes: true });
			return res.json({
				path: source,
				parent: paths.parent(source),
				entries: (
					await Promise.all(
						entries
							.filter(
								(entry) =>
									!entry.isSymbolicLink() &&
									(entry.isFile() || entry.isDirectory()) &&
									!entry.name.startsWith(".incoming-"),
							)
							.slice(0, 2000)
							.map(async (entry) => {
								try {
									const full = join(source, entry.name),
										info = await lstat(full);
									return info.isSymbolicLink()
										? null
										: {
												name: entry.name,
												path: full,
												directory: entry.isDirectory(),
												size: info.size,
												modified: info.mtimeMs,
											};
								} catch {
									return null;
								}
							}),
					)
				).filter(Boolean),
				truncated: entries.length > 2000,
			});
		}),
	);
	router.post(
		"/downloads",
		route(async (req, res) => {
			if (downloads.size >= limits.jobs) throw fail("Too many downloads; retry later", 429);
			const path = await safeSource(req.body?.path),
				info = await lstat(path);
			const size = await sourceSize(path),
				key = id();
			downloads.set(key, { path, directory: info.isDirectory(), size, touched: Date.now(), streaming: false });
			return res.json({ id: key, name: basename(path) + (info.isDirectory() ? ".tar" : ""), size });
		}),
	);
	router.get(
		"/download/:id",
		route(async (req, res) => {
			const item = downloads.get(String(req.params.id));
			if (!item || item.streaming) throw fail("Download expired or busy", 410);
			item.streaming = true;
			activeResponses.add(res);
			const filename = basename(item.path) + (item.directory ? ".tar" : "");
			res.set({
				"content-type": "application/octet-stream",
				"content-disposition": `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(filename).replace(/'/g, "%27")}`,
			});
			try {
				if (item.directory)
					await pipeline(
						tar.c(
							{
								cwd: dirname(item.path),
								portable: true,
								follow: false,
								filter: (_path, entry) =>
									"isSymbolicLink" in entry ? !entry.isSymbolicLink() : entry.type !== "SymbolicLink",
							},
							[basename(item.path)],
						),
						res,
					);
				else {
					const file = await open(item.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
					try {
						const info = await file.stat();
						if (!info.isFile() || info.size !== item.size) throw fail("File changed; select it again", 409);
						res.setHeader("content-length", info.size);
						await pipeline(file.createReadStream(), res);
					} finally {
						await file.close();
					}
				}
			} finally {
				activeResponses.delete(res);
				downloads.delete(String(req.params.id));
			}
		}),
	);
	router.post(
		"/mkdir",
		route(async (req, res) => {
			const parent = await safeSource(req.body?.path),
				name = desktopRelativePath(req.body?.name);
			if (name.includes("/")) throw fail("Use a folder name, not a path");
			await mkdir(join(parent, name));
			res.json({ path: join(parent, name) });
		}),
	);
	router.post(
		"/exports",
		route(async (req, res) => {
			if (exports.size >= limits.jobs) throw fail("Too many transfers", 429);
			if (!Array.isArray(req.body?.paths) || !req.body.paths.length || req.body.paths.length > limits.entries)
				throw fail("Select files first");
			const entries: {
				path: string;
				source: string;
				directory: boolean;
				size: number;
				mtime: number;
				ino: number;
				dev: number;
			}[] = [];
			let bytes = 0;
			const names = new Set<string>();
			async function visit(source: string, path: string) {
				desktopRelativePath(path);
				const info = await lstat(source);
				if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()))
					throw fail("Symbolic links and special files are not supported");
				const directory = info.isDirectory(),
					size = directory ? 0 : info.size;
				bytes += size;
				if (entries.length >= limits.entries || bytes > limits.bytes)
					throw fail("Transfer exceeds 10000 entries or 16 GiB", 413);
				entries.push({ path, source, directory, size, mtime: info.mtimeMs, ino: info.ino, dev: info.dev });
				if (directory) for (const name of await readdir(source)) await visit(join(source, name), path + "/" + name);
			}
			for (const value of req.body.paths) {
				const source = await safeSource(value),
					name = basename(source);
				if (names.has(name.toLowerCase())) throw fail("Duplicate selection");
				names.add(name.toLowerCase());
				await visit(source, name);
			}
			const key = id();
			exports.set(key, { entries, touched: Date.now() });
			res.json({
				id: key,
				entries: entries.map(({ path, directory, size }) => ({ path, directory, size })),
				total: bytes,
			});
		}),
	);
	router.get(
		"/exports/:id/chunk",
		route(async (req, res) => {
			const item = exports.get(String(req.params.id));
			if (!item) throw fail("Source selection expired; select files again", 410);
			item.touched = Date.now();
			const index = Number(req.query.entry),
				offset = Number(req.query.offset),
				entry = item.entries[index];
			if (
				!Number.isSafeInteger(index) ||
				!Number.isSafeInteger(offset) ||
				offset < 0 ||
				!entry ||
				entry.directory ||
				offset >= entry.size
			)
				throw fail("Invalid source offset");
			const source = await safeSource(entry.source),
				file = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
			try {
				const info = await file.stat();
				if (
					!info.isFile() ||
					info.size !== entry.size ||
					info.mtimeMs !== entry.mtime ||
					info.ino !== entry.ino ||
					info.dev !== entry.dev
				)
					throw fail("Source file changed; select it again", 409);
				const data = Buffer.alloc(Math.min(limits.chunk, entry.size - offset));
				let read = 0;
				while (read < data.length) {
					const result = await file.read(data, read, data.length - read, offset + read);
					if (!result.bytesRead) throw fail("Source file changed", 409);
					read += result.bytesRead;
				}
				res.json({ data: data.toString("base64"), crc: fileChunkCrc(data), length: data.length });
			} finally {
				await file.close();
			}
		}),
	);
	router.delete("/exports/:id", (req, res) => {
		exports.delete(String(req.params.id));
		res.status(204).end();
	});
	options.app.use(options.base ?? "/api/device-desktop/files", router);
	const timer = setInterval(() => {
		const now = Date.now();
		for (const job of jobs.values())
			if (!job.busy && now - job.touched > limits.idleMs) void dispose(job).catch(() => {});
		for (const [key, item] of downloads)
			if (!item.streaming && now - item.touched > limits.idleMs) downloads.delete(key);
		for (const [key, item] of exports) if (now - item.touched > limits.idleMs) exports.delete(key);
	}, 60000);
	timer.unref();
	const reset = () => {
		for (const response of activeResponses) response.destroy();
		downloads.clear();
		exports.clear();
		for (const job of jobs.values()) void dispose(job).catch(() => {});
	};
	return {
		reset,
		close() {
			stopped = true;
			clearInterval(timer);
			reset();
		},
	};
}
