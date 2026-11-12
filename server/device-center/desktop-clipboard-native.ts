import { createHash } from "node:crypto";
import { lstat, open, mkdtemp, writeFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { CLIPBOARD_LIMITS, clipboardName, type ClipboardKind } from "./desktop-clipboard-protocol.js";

export type ClipboardContent = { kind: ClipboardKind; items: { name: string; data: Buffer }[] };
export interface ClipboardBackend {
	read(): Promise<ClipboardContent | undefined>;
	write(content: ClipboardContent): Promise<void>;
	watch(changed: () => void): () => void;
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
	let lastApplied = "";
	let writing = false;
	let canonicalizing = false;
	// Files must remain available after disconnect so a later OS paste still works.
	// Only directories created by this instance are ever removed; originals are never changed.
	const staged: { path: string; bytes: number }[] = [];
	let stagedBytes = 0;
	const backend: ClipboardBackend = {
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
					for (const notify of subscribers) notify();
				});
			} catch (error) {
				subscribers.delete(changed);
				throw error;
			}
			return () => {
				subscribers.delete(changed);
				if (!subscribers.size) {
					watcher?.stop();
					watcher = undefined;
				}
			};
		},
	};
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
	};
}
