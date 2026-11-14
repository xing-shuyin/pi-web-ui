import { createHash, randomUUID } from "node:crypto";
import { lstat, open, mkdtemp, rm, statfs, type FileHandle } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import {
	CLIPBOARD_LIMITS,
	clipboardName,
	parseClipboardOffer,
	type ClipboardOffer,
} from "./desktop-clipboard-protocol.js";
import { clipboardDigest, type ClipboardContent } from "./desktop-clipboard-native.js";

export interface ClipboardSource {
	offer: ClipboardOffer;
	digest: string;
	chunks(): AsyncGenerator<{ item: number; offset: number; data: Buffer }>;
	close(): Promise<void>;
}
export interface ClipboardSink {
	write(item: number, offset: number, data: Buffer): Promise<void>;
	finish(): Promise<string>;
	abort(): Promise<void>;
}
export function bufferClipboardSource(content: ClipboardContent): ClipboardSource {
	return {
		offer: {
			type: "offer",
			id: randomUUID(),
			kind: content.kind,
			items: content.items.map(({ name, data }) => ({
				name,
				size: data.length,
				sha256: createHash("sha256").update(data).digest("hex"),
			})),
		},
		digest: clipboardDigest(content),
		async *chunks() {
			for (let item = 0; item < content.items.length; item++) {
				const data = content.items[item].data;
				for (let offset = 0; offset < data.length; offset += CLIPBOARD_LIMITS.chunk)
					yield { item, offset, data: data.subarray(offset, offset + CLIPBOARD_LIMITS.chunk) };
			}
		},
		async close() {},
	};
}

/** File descriptors pin the selected originals. No complete file is held in memory. */
export async function fileClipboardSource(
	paths: string[],
	signal: AbortSignal,
	maxBytes: number,
): Promise<ClipboardSource> {
	const opened: { file: FileHandle; size: number; mtime: number }[] = [];
	const offer: ClipboardOffer = { type: "offer", id: randomUUID(), kind: "files", items: [] };
	const digest = createHash("sha256").update("files");
	const close = async () => {
		await Promise.all(opened.map(({ file }) => file.close().catch(() => {})));
	};
	const unchanged = async (item: (typeof opened)[number]) => {
		signal.throwIfAborted();
		const stat = await item.file.stat();
		if (stat.size !== item.size || stat.mtimeMs !== item.mtime) throw new Error("clipboard-changed");
	};
	try {
		if (!paths.length || paths.length > CLIPBOARD_LIMITS.files) throw new Error("clipboard-size");
		let total = 0;
		const names = new Set<string>();
		for (const path of paths) {
			signal.throwIfAborted();
			const info = await lstat(path),
				name = basename(path);
			if (!info.isFile() || info.isSymbolicLink() || !clipboardName(name) || names.has(name.toLowerCase()))
				throw new Error("clipboard-files");
			names.add(name.toLowerCase());
			total += info.size;
			if (total > Math.min(maxBytes, CLIPBOARD_LIMITS.fileBytes)) throw new Error("clipboard-size");
			const file = await open(path, "r");
			const item = { file, size: info.size, mtime: info.mtimeMs };
			opened.push(item);
			const stat = await file.stat();
			if (!stat.isFile() || stat.ino !== info.ino || stat.dev !== info.dev) throw new Error("clipboard-changed");
			await unchanged(item);
			const hash = createHash("sha256"),
				buffer = Buffer.allocUnsafe(1024 * 1024);
			digest.update(JSON.stringify([name, info.size]));
			for (let offset = 0; offset < info.size;) {
				signal.throwIfAborted();
				const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, info.size - offset), offset);
				if (!bytesRead) throw new Error("clipboard-changed");
				const part = buffer.subarray(0, bytesRead);
				hash.update(part);
				digest.update(part);
				offset += bytesRead;
			}
			await unchanged(item);
			offer.items.push({ name, size: info.size, sha256: hash.digest("hex") });
		}
		return {
			offer,
			digest: digest.digest("hex"),
			close,
			async *chunks() {
				for (let item = 0; item < opened.length; item++) {
					const current = opened[item];
					await unchanged(current);
					for (let offset = 0; offset < current.size;) {
						signal.throwIfAborted();
						const data = Buffer.allocUnsafe(Math.min(CLIPBOARD_LIMITS.chunk, current.size - offset));
						let used = 0;
						while (used < data.length) {
							const { bytesRead } = await current.file.read(data, used, data.length - used, offset + used);
							if (!bytesRead) throw new Error("clipboard-changed");
							used += bytesRead;
						}
						yield { item, offset, data };
						offset += data.length;
					}
					await unchanged(current);
				}
			},
		};
	} catch (error) {
		await close();
		throw error;
	}
}

/** Ordered writes and hashes are shared by memory and disk receivers. */
function checkedSink(
	offer: ClipboardOffer,
	write: (item: number, offset: number, data: Buffer) => Promise<void>,
	commit: () => Promise<void>,
	abort: () => Promise<void>,
): ClipboardSink {
	let item = 0,
		offset = 0,
		finished = false;
	const hashes = offer.items.map(() => createHash("sha256"));
	const digest = createHash("sha256").update(offer.kind);
	let digestItem = -1;
	function advance() {
		while (item < offer.items.length) {
			if (digestItem !== item) {
				digest.update(JSON.stringify([offer.items[item].name, offer.items[item].size]));
				digestItem = item;
			}
			if (offset < offer.items[item].size) break;
			item++;
			offset = 0;
		}
	}
	return {
		async write(index, position, data) {
			advance();
			if (
				finished ||
				!offer.items[item] ||
				item !== index ||
				offset !== position ||
				!data.length ||
				data.length > CLIPBOARD_LIMITS.chunk ||
				offset + data.length > offer.items[item].size
			)
				throw new Error("clipboard-protocol");
			await write(index, position, data);
			hashes[index].update(data);
			digest.update(data);
			offset += data.length;
		},
		async finish() {
			advance();
			if (
				finished ||
				item !== offer.items.length ||
				hashes.some((hash, index) => hash.digest("hex") !== offer.items[index].sha256)
			)
				throw new Error("clipboard-integrity");
			finished = true;
			await commit();
			return digest.digest("hex");
		},
		abort,
	};
}
export function memoryClipboardSink(
	offer: ClipboardOffer,
	apply: (content: ClipboardContent) => Promise<void>,
): ClipboardSink {
	if (!parseClipboardOffer(offer)) throw new Error("clipboard-size");
	const content = {
		kind: offer.kind,
		items: offer.items.map((item) => ({ name: item.name, data: Buffer.alloc(item.size) })),
	};
	return checkedSink(
		offer,
		async (item, offset, data) => {
			data.copy(content.items[item].data, offset);
		},
		() => apply(content),
		async () => {},
	);
}

export async function diskClipboardSink(
	offer: ClipboardOffer,
	apply: (paths: string[], directory: string, bytes: number) => Promise<void>,
	signal: AbortSignal,
	root = tmpdir(),
): Promise<ClipboardSink> {
	if (offer.kind !== "files" || !parseClipboardOffer(offer, CLIPBOARD_LIMITS.fileBytes))
		throw new Error("clipboard-size");
	const bytes = offer.items.reduce((sum, item) => sum + item.size, 0);
	const space = await statfs(root);
	if (space.bavail * space.bsize < bytes + 64 * 1024 * 1024) throw new Error("clipboard-space");
	const directory = await mkdtemp(join(root, "pi-web-clipboard-"));
	const files: FileHandle[] = [],
		paths: string[] = [];
	let committed = false;
	const close = async () => {
		await Promise.all(files.map((file) => file.close().catch(() => {})));
	};
	const abort = async () => {
		await close();
		if (!committed) await rm(directory, { recursive: true, force: true, maxRetries: 2 });
	};
	try {
		for (const item of offer.items) {
			signal.throwIfAborted();
			const path = join(directory, item.name);
			files.push(await open(path, "wx", 0o600));
			paths.push(path);
		}
		return checkedSink(
			offer,
			async (item, offset, data) => {
				signal.throwIfAborted();
				let used = 0;
				while (used < data.length) {
					const { bytesWritten } = await files[item].write(data, used, data.length - used, offset + used);
					if (!bytesWritten) throw new Error("clipboard-write");
					used += bytesWritten;
				}
			},
			async () => {
				await close();
				signal.throwIfAborted();
				await apply(paths, directory, bytes);
				committed = true;
			},
			abort,
		);
	} catch (error) {
		await abort();
		throw error;
	}
}
