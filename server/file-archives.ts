import { createReadStream, createWriteStream, constants } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, open, readdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { createGunzip } from "node:zlib";
import * as tar from "tar";
import * as yauzl from "yauzl";

export type ConflictPolicy = "skip" | "overwrite" | "error";
const MAX_ENTRIES = 20_000;
const MAX_BYTES = 1024 * 1024 * 1024;

export function archiveName(path: string, directory: boolean, now = new Date()): string {
	const time = now.toISOString().replace(/[:.]/g, "-");
	return `${basename(path)}${directory ? `-${time}` : ""}.tar.gz`;
}

export function safeEntryPath(name: string): string {
	const parts = name
		.replace(/\\/g, "/")
		.replace(/^(\.\/)+/, "")
		.replace(/\/$/, "")
		.split("/");
	if (
		name.length > 4096 ||
		parts.length > 128 ||
		!parts.length ||
		parts.some(
			(p) =>
				!p ||
				p === "." ||
				p === ".." ||
				/[\x00-\x1f<>:"|?*]/.test(p) ||
				/[. ]$/.test(p) ||
				/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p),
		)
	) {
		throw new Error(`Unsafe entry path: ${name}`);
	}
	return parts.join("/");
}

function trackEntry(paths: Set<string>, name: string): void {
	let prefix = "";
	for (const part of name.split("/")) {
		prefix = prefix ? `${prefix}/${part}` : part;
		paths.add(prefix.toLowerCase());
		if (paths.size > MAX_ENTRIES) throw new Error("Archive exceeds 20,000 expanded entries");
	}
}

async function maybeStat(path: string) {
	try {
		return await lstat(path);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw e;
	}
}

export async function safeDestination(root: string, name: string): Promise<string> {
	let path = root;
	for (const part of safeEntryPath(name).split("/")) {
		path = join(path, part);
		const st = await maybeStat(path);
		if (st?.isSymbolicLink()) throw new Error(`Symbolic link destination: ${name}`);
	}
	return path;
}

/**
 * Transform that enforces the 1 GiB expanded-size cap on the bytes that
 * actually flow through it. `total` makes several transforms share one global
 * counter — for ZIP extraction the header-declared uncompressedSize is
 * attacker-controlled, so the cap must be enforced on REAL decompressed output.
 */
function byteLimit(total?: { bytes: number }) {
	let bytes = 0;
	return new Transform({
		transform(chunk: Buffer, _encoding, done) {
			bytes += chunk.length;
			if (total) total.bytes += chunk.length;
			done((total ? total.bytes : bytes) > MAX_BYTES ? new Error("Archive exceeds 1 GiB expanded size") : null, chunk);
		},
	});
}

export async function createArchive(source: string, outputDir?: string): Promise<{ path: string; name: string }> {
	const abs = resolve(source);
	const st = await lstat(abs);
	if ((!st.isFile() && !st.isDirectory()) || dirname(abs) === abs)
		throw new Error("Select a regular file or folder, not a filesystem root");
	const name = archiveName(abs, st.isDirectory());
	const dest = join(outputDir ?? dirname(abs), name);
	let entries = 0;
	let bytes = 0;
	const names: string[] = [];
	const inodes = new Set<string>();
	async function walk(path: string, name: string): Promise<void> {
		const info = await lstat(path);
		if (!info.isFile() && !info.isDirectory()) throw new Error("Archive source contains a link or special file");
		if (info.isFile() && info.nlink > 1) {
			const inode = `${info.dev}:${info.ino}`;
			if (inodes.has(inode)) throw new Error("Archive source contains hard links");
			inodes.add(inode);
		}
		if (++entries > MAX_ENTRIES || (bytes += info.size) > MAX_BYTES)
			throw new Error("Archive limit exceeded (20,000 entries / 1 GiB)");
		names.push(safeEntryPath(name));
		if (info.isDirectory()) for (const child of await readdir(path)) await walk(join(path, child), `${name}/${child}`);
	}
	await walk(abs, basename(abs));
	const handle = await open(dest, "wx", 0o600);
	try {
		const stream = tar.c({ gzip: true, cwd: dirname(abs), portable: true, strict: true, noDirRecurse: true }, names);
		await pipeline(stream, handle.createWriteStream());
		return { path: dest, name };
	} catch (err) {
		await handle.close().catch(() => {});
		await rm(dest, { force: true });
		throw err;
	}
}

async function unzip(source: string, stage: string): Promise<void> {
	const zip = await new Promise<yauzl.ZipFile>((ok, fail) =>
		yauzl.open(source, { lazyEntries: true, strictFileNames: true }, (err, z) => (err ? fail(err) : ok(z!))),
	);
	let count = 0;
	const total = { bytes: 0 };
	const paths = new Set<string>();
	await new Promise<void>((ok, fail) => {
		const abort = (err: unknown) => {
			zip.close();
			fail(err);
		};
		zip.on("error", abort);
		zip.on("end", ok);
		zip.on("entry", (entry: yauzl.Entry) => {
			void (async () => {
				const name = safeEntryPath(entry.fileName);
				trackEntry(paths, name);
				const type = (entry.externalFileAttributes >>> 16) & 0o170000;
				if (type && type !== 0o100000 && type !== 0o040000) throw new Error("Archive contains a link or special file");
				if (++count > MAX_ENTRIES) throw new Error("Archive limit exceeded (20,000 entries / 1 GiB)");
				const dest = join(stage, name);
				if (entry.fileName.endsWith("/")) await mkdir(dest, { recursive: true });
				else {
					await mkdir(dirname(dest), { recursive: true });
					const stream = await new Promise<import("node:stream").Readable>((resolveStream, reject) =>
						zip.openReadStream(entry, (err, s) => (err ? reject(err) : resolveStream(s!))),
					);
					await pipeline(stream, byteLimit(total), createWriteStream(dest, { flags: "wx", mode: 0o600 }));
				}
				zip.readEntry();
			})().catch(abort);
		});
		zip.readEntry();
	});
}

async function unpack(source: string, stage: string): Promise<void> {
	if (/\.zip$/i.test(source)) return unzip(source, stage);
	if (/\.(?:tar|tar\.gz|tgz)$/i.test(source)) {
		let count = 0;
		let bytes = 0;
		const seen = new Set<string>();
		const paths = new Set<string>();
		const parser = tar.t({
			strict: true,
			onReadEntry: (entry) => {
				try {
					if (entry.type === "Directory" && /^(\.\/)*\.?$/.test(entry.path)) return;
					const name = safeEntryPath(entry.path).toLowerCase();
					trackEntry(paths, name);
					if (seen.has(name)) throw new Error(`Duplicate archive entry: ${name}`);
					seen.add(name);
					if (entry.type !== "File" && entry.type !== "Directory")
						throw new Error("Archive contains a link or special file");
					if (++count > MAX_ENTRIES || (bytes += entry.size) > MAX_BYTES)
						throw new Error("Archive limit exceeded (20,000 entries / 1 GiB)");
				} catch (err) {
					parser.abort(err instanceof Error ? err : new Error(String(err)));
				}
			},
		});
		const input = createReadStream(source);
		if (/\.(tgz|gz)$/i.test(source)) await pipeline(input, createGunzip(), byteLimit(), parser);
		else await pipeline(input, byteLimit(), parser);
		await tar.x({ file: source, cwd: stage, strict: true, preservePaths: false, noChmod: true, noMtime: true });
		return;
	}
	if (/\.gz$/i.test(source)) {
		const name = safeEntryPath(basename(source).slice(0, -3));
		await pipeline(
			createReadStream(source),
			createGunzip(),
			byteLimit(),
			createWriteStream(join(stage, name), { flags: "wx", mode: 0o600 }),
		);
		return;
	}
	throw new Error("Supported archives: ZIP, TAR, TAR.GZ, TGZ, GZ");
}

export async function extractArchive(
	source: string,
	destination: string,
	policy: ConflictPolicy,
): Promise<{ written: number; skipped: number }> {
	if (!["skip", "overwrite", "error"].includes(policy)) throw new Error("Invalid conflict policy");
	const root = await realpath(destination);
	if (!(await lstat(root)).isDirectory()) throw new Error("Destination must be a directory");
	const canonicalSource = await realpath(source);
	const sourceStat = await lstat(source);
	if (!sourceStat.isFile() || sourceStat.size > MAX_BYTES)
		throw new Error("Select an archive file no larger than 1 GiB");
	const tmp = await mkdtemp(join(tmpdir(), "pi-web-extract-"));
	try {
		const snapshot = join(tmp, basename(source));
		await copyFile(source, snapshot, constants.COPYFILE_EXCL);
		const stage = join(tmp, "contents");
		await mkdir(stage);
		await unpack(snapshot, stage);
		const plan: { src: string; dest: string; dir: boolean; exists: boolean }[] = [];
		async function walk(dir: string, prefix = "") {
			for (const entry of await readdir(dir, { withFileTypes: true })) {
				const name = prefix ? `${prefix}/${entry.name}` : entry.name;
				const dest = await safeDestination(root, name);
				const existing = await maybeStat(dest);
				const isDir = entry.isDirectory();
				if (existing && existing.isDirectory() !== isDir) throw new Error(`File/directory conflict: ${name}`);
				if (existing && !isDir && policy === "error") throw new Error(`File already exists: ${name}`);
				if (resolve(dest) === canonicalSource) throw new Error("Archive would overwrite itself");
				plan.push({ src: join(dir, entry.name), dest, dir: isDir, exists: Boolean(existing) });
				if (isDir) await walk(join(dir, entry.name), name);
			}
		}
		await walk(stage);
		let written = 0,
			skipped = 0;
		for (const item of plan) {
			await safeDestination(
				root,
				item.dest
					.slice(root.length + (root.endsWith(sep) ? 0 : 1))
					.split(sep)
					.join("/"),
			);
			if (item.dir) await mkdir(item.dest, { recursive: true });
			else if (item.exists && policy === "skip") skipped++;
			else {
				if (policy === "overwrite") await rm(item.dest, { force: true });
				await copyFile(item.src, item.dest, constants.COPYFILE_EXCL);
				written++;
			}
		}
		return { written, skipped };
	} finally {
		await rm(tmp, { recursive: true, force: true });
	}
}
