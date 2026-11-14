import { createHash } from "node:crypto";
import { lstat, open, mkdtemp, writeFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { CLIPBOARD_LIMITS, clipboardName, type ClipboardKind } from "./desktop-clipboard-protocol.js";
import type { ClipboardOffer } from "./desktop-clipboard-protocol.js";
import {
	bufferClipboardSource,
	fileClipboardSource,
	diskClipboardSink,
	type ClipboardSource,
	type ClipboardSink,
} from "./desktop-clipboard-transfer.js";

export type ClipboardContent = { kind: ClipboardKind; items: { name: string; data: Buffer }[] };
export interface ClipboardBackend {
	read(): Promise<ClipboardContent | undefined>;
	write(content: ClipboardContent): Promise<void>;
	watch(changed: () => void): () => void;
	readSource?(signal: AbortSignal, maxBytes: number): Promise<ClipboardSource | undefined>;
	receiveFiles?(offer: ClipboardOffer, signal: AbortSignal): Promise<ClipboardSink>;
}
export function clipboardDigest(content: ClipboardContent): string {
	const hash = createHash("sha256").update(content.kind);
	for (const item of content.items) hash.update(JSON.stringify([item.name, item.data.length])).update(item.data);
	return hash.digest("hex");
}
export function clipboardPng(data: Buffer): boolean {
	return (
		data.length >= 33 &&
		data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
		data.toString("ascii", 12, 16) === "IHDR" &&
		data.readUInt32BE(16) > 0 &&
		data.readUInt32BE(20) > 0 &&
		data.readUInt32BE(16) <= 16384 &&
		data.readUInt32BE(20) <= 16384 &&
		data.readUInt32BE(16) * data.readUInt32BE(20) <= 32 * 1024 * 1024
	);
}

/** Lazy optional dependency: unsupported hosts keep the desktop working. */
export async function createNativeClipboard(): Promise<ClipboardBackend> {
	const api = await import("@crosscopy/clipboard");
	const subscribers = new Set<() => void>();
	let watcher: ReturnType<typeof api.startWatch> | undefined;
	let poll: ReturnType<typeof setInterval> | undefined,
		polling = false,
		fileSelection: string | undefined;
	let lastApplied = "";
	let writing = false;
	let canonicalizing = false;
	// Files must remain available after disconnect so a later OS paste still works.
	// Only directories created by this instance are ever removed; originals are never changed.
	const staged: { path: string; bytes: number }[] = [];
	let stagedBytes = 0;
	let reservedBytes = 0;
	let appliedFiles = "";
	async function filesIdentity(paths: string[]) {
		return JSON.stringify(
			await Promise.all(
				paths.map(async (path) => {
					const stat = await lstat(path);
					return [path, stat.size, stat.mtimeMs, stat.ino, stat.dev];
				}),
			),
		);
	}
	async function applyFiles(paths: string[], directory: string, bytes: number) {
		writing = true;
		try {
			const identity = await filesIdentity(paths);
			await api.setFiles(paths);
			appliedFiles = identity;
			staged.push({ path: directory, bytes });
			stagedBytes += bytes;
			// Keep the current clipboard batch, even when one transfer exceeds the old cache limit.
			while (staged.length > 1 && (staged.length > 16 || stagedBytes > CLIPBOARD_LIMITS.fileBytes * 2)) {
				const old = staged.shift()!;
				stagedBytes -= old.bytes;
				await rm(old.path, { recursive: true, force: true }).catch(() => {});
			}
		} finally {
			writing = false;
		}
	}
	const backend: ClipboardBackend = {
		async readSource(signal, maxBytes) {
			if (writing) return;
			if (api.hasFiles()) {
				const paths = await api.getFiles();
				if (!paths.length || paths.length > CLIPBOARD_LIMITS.files) throw new Error("clipboard-size");
				for (const path of paths) if ((await lstat(path)).isDirectory()) throw new Error("clipboard-folder");
				if ((await filesIdentity(paths)) === appliedFiles) return;
				return fileClipboardSource(paths, signal, maxBytes);
			}
			const content = await backend.read();
			return content ? bufferClipboardSource(content) : undefined;
		},
		async receiveFiles(offer, signal) {
			const bytes = offer.items.reduce((sum, item) => sum + item.size, 0);
			if (reservedBytes + bytes > CLIPBOARD_LIMITS.fileBytes * 2) throw new Error("clipboard-space");
			reservedBytes += bytes;
			let released = false;
			const release = () => {
				if (!released) {
					released = true;
					reservedBytes -= bytes;
				}
			};
			try {
				const sink = await diskClipboardSink(
					offer,
					(paths, dir, size) => serial(() => applyFiles(paths, dir, size)),
					signal,
				);
				return {
					write: sink.write,
					async finish() {
						try {
							return await sink.finish();
						} finally {
							release();
						}
					},
					async abort() {
						try {
							await sink.abort();
						} finally {
							release();
						}
					},
				};
			} catch (error) {
				release();
				throw error;
			}
		},
		async read() {
			if (writing && !canonicalizing) return;
			let content: ClipboardContent | undefined;
			if (api.hasFiles()) {
				const paths = await api.getFiles();
				if (!paths.length || paths.length > CLIPBOARD_LIMITS.files) throw new Error("clipboard-size");
				const items: ClipboardContent["items"] = [];
				let bytes = 0;
				for (const path of paths) {
					const name = basename(path),
						info = await lstat(path);
					if (!clipboardName(name) || !info.isFile() || info.isSymbolicLink()) throw new Error("clipboard-files");
					bytes += info.size;
					if (bytes > CLIPBOARD_LIMITS.bytes) throw new Error("clipboard-size");
					const file = await open(path, "r");
					try {
						const stat = await file.stat();
						if (!stat.isFile() || stat.size !== info.size || stat.ino !== info.ino)
							throw new Error("clipboard-changed");
						const data = Buffer.alloc(info.size);
						let offset = 0;
						while (offset < data.length) {
							const result = await file.read(data, offset, data.length - offset, offset);
							if (!result.bytesRead) throw new Error("clipboard-changed");
							offset += result.bytesRead;
						}
						const after = await file.stat();
						if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error("clipboard-changed");
						items.push({ name, data });
					} finally {
						await file.close();
					}
				}
				content = { kind: "files", items };
			} else if (api.hasImage()) {
				const data = Buffer.from(await api.getImageBinary());
				if (data.length > CLIPBOARD_LIMITS.image || !clipboardPng(data)) throw new Error("clipboard-image");
				content = { kind: "image", items: [{ name: "image.png", data }] };
			} else if (api.hasText()) {
				const data = Buffer.from(await api.getText());
				if (data.length > CLIPBOARD_LIMITS.text) throw new Error("clipboard-size");
				content = { kind: "text", items: [{ name: "text.txt", data }] };
			}
			if (content && (canonicalizing || clipboardDigest(content) !== lastApplied)) return content;
		},
		async write(content) {
			writing = true;
			const previous = lastApplied;
			lastApplied = clipboardDigest(content);
			try {
				if (content.kind === "text") await api.setText(content.items[0].data.toString("utf8"));
				else if (content.kind === "image") {
					if (!clipboardPng(content.items[0].data)) throw new Error("clipboard-image");
					await api.setImageBinary([...content.items[0].data]);
				} else {
					const directory = await mkdtemp(join(tmpdir(), "pi-web-clipboard-"));
					try {
						const paths: string[] = [];
						for (const item of content.items) {
							if (!clipboardName(item.name)) throw new Error("clipboard-files");
							const path = join(directory, item.name);
							await writeFile(path, item.data, { flag: "wx", mode: 0o600 });
							paths.push(path);
						}
						await api.setFiles(paths);
					} catch (error) {
						await rm(directory, { recursive: true, force: true });
						throw error;
					}
					const bytes = content.items.reduce((sum, item) => sum + item.data.length, 0);
					staged.push({ path: directory, bytes });
					stagedBytes += bytes;
					while (staged.length > 16 || stagedBytes > 128 * 1024 * 1024) {
						const old = staged.shift()!;
						stagedBytes -= old.bytes;
						await rm(old.path, { recursive: true, force: true }).catch(() => {});
					}
				}
				// OS image encoders and text line endings may normalize the supplied bytes.
				// Remember what the OS actually exposes so its watcher cannot bounce that normalization back.
				canonicalizing = true;
				const normalized = await backend.read();
				if (normalized) lastApplied = clipboardDigest(normalized);
			} catch (error) {
				lastApplied = previous;
				throw error;
			} finally {
				writing = canonicalizing = false;
			}
		},
		watch(changed) {
			subscribers.add(changed);
			try {
				watcher ??= api.startWatch(() => {
					void checkSelection(true);
				});
				if (!poll) {
					void checkSelection(false);
					poll = setInterval(() => {
						void checkSelection(false);
					}, 1000);
					poll.unref();
				}
			} catch (error) {
				subscribers.delete(changed);
				throw error;
			}
			return () => {
				subscribers.delete(changed);
				if (!subscribers.size) {
					watcher?.stop();
					watcher = undefined;
					clearInterval(poll);
					poll = undefined;
					fileSelection = undefined;
				}
			};
		},
	};
	async function checkSelection(event: boolean) {
		if (polling || !subscribers.size) return;
		polling = true;
		try {
			const paths = api.hasFiles() ? await api.getFiles() : [];
			const signature = paths.length
				? JSON.stringify([paths.length, await filesIdentity(paths.slice(0, CLIPBOARD_LIMITS.files + 1))])
				: "";
			const changed = signature ? fileSelection !== undefined && signature !== fileSelection : event;
			fileSelection = signature;
			if (changed || (event && signature)) for (const notify of subscribers) notify();
		} catch {
			if (event) for (const notify of subscribers) notify();
		} finally {
			polling = false;
		}
	}
	let operation = Promise.resolve();
	function serial<T>(work: () => Promise<T>): Promise<T> {
		const next = operation.then(work);
		operation = next.then(
			() => {},
			() => {},
		);
		return next;
	}
	return {
		read: () => serial(() => backend.read()),
		write: (content) => serial(() => backend.write(content)),
		watch: backend.watch,
		readSource: (signal, maxBytes) => serial(() => backend.readSource!(signal, maxBytes)),
		receiveFiles: (offer, signal) => backend.receiveFiles!(offer, signal),
	};
}
