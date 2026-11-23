import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, existsSync } from "node:fs";
import { readFile, readdir, rename, rm, writeFile, stat } from "node:fs/promises";
import { join, extname } from "node:path";
import { writeAtomicSync } from "./atomic-file.js";

interface AttachmentStore {
	dir: string;
	files: Map<string, Set<string>>;
	ready?: Promise<void>;
}

let store: AttachmentStore | undefined;

function indexFile(target: AttachmentStore, fileName: string): void {
	const match = /^([a-f0-9]{64})\..+$/i.exec(fileName);
	if (!match || fileName.endsWith(".tmp")) return;
	let files = target.files.get(match[1]);
	if (!files) target.files.set(match[1], (files = new Set()));
	files.add(fileName);
}

function ensureIndex(target: AttachmentStore): Promise<void> {
	return (target.ready ??= readdir(target.dir, { withFileTypes: true })
		.then((entries) => {
			for (const entry of entries) {
				if (entry.isFile()) indexFile(target, entry.name);
			}
		})
		.catch((error) => {
			target.ready = undefined;
			throw error;
		}));
}

export function initAttachmentStore(dataDir: string): string {
	const dir = join(dataDir, "attachments");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	store = { dir, files: new Map() };
	return dir;
}

export interface AttachmentRecord {
	hash: string;
	size: number;
	mimeType: string;
	ext: string;
	url: string;
	filePath: string;
}

const MIME_EXT_MAP: Record<string, string> = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/jpg": ".jpg",
	"image/gif": ".gif",
	"image/webp": ".webp",
	"image/svg+xml": ".svg",
	"image/bmp": ".bmp",
	"application/pdf": ".pdf",
};

const EXT_MIME_MAP: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".bmp": "image/bmp",
	".pdf": "application/pdf",
};

export async function saveAttachment(
	buffer: Buffer,
	mimeType = "application/octet-stream",
	preferredExt?: string,
): Promise<AttachmentRecord> {
	if (!store) {
		throw new Error("AttachmentStore has not been initialized with initAttachmentStore(dataDir)");
	}
	const hash = createHash("sha256").update(buffer).digest("hex");
	const ext = preferredExt || MIME_EXT_MAP[mimeType] || ".bin";
	const fileName = `${hash}${ext}`;
	const target = store;
	const filePath = join(target.dir, fileName);

	if (!existsSync(filePath)) {
		const tmpPath = `${filePath}.${randomUUID()}.tmp`;
		try {
			await writeFile(tmpPath, buffer);
			await rename(tmpPath, filePath);
		} catch (err) {
			await rm(tmpPath, { force: true }).catch(() => {});
			const code = (err as NodeJS.ErrnoException).code;
			if ((code !== "EEXIST" && code !== "EPERM") || !existsSync(filePath)) throw err;
		}
	}

	indexFile(target, fileName);
	return {
		hash,
		size: buffer.length,
		mimeType,
		ext,
		url: `/api/attachment/${hash}`,
		filePath,
	};
}

export function saveAttachmentSync(
	buffer: Buffer,
	mimeType = "application/octet-stream",
	preferredExt?: string,
): AttachmentRecord {
	if (!store) {
		throw new Error("AttachmentStore has not been initialized with initAttachmentStore(dataDir)");
	}
	const hash = createHash("sha256").update(buffer).digest("hex");
	const ext = preferredExt || MIME_EXT_MAP[mimeType] || ".bin";
	const fileName = `${hash}${ext}`;
	const target = store;
	const filePath = join(target.dir, fileName);

	if (!existsSync(filePath)) {
		try {
			writeAtomicSync(filePath, buffer);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "EEXIST") {
			} else if (code === "EPERM" && existsSync(filePath)) {
			} else {
				throw err;
			}
		}
		if (!existsSync(filePath)) {
			const err = new Error(`EPERM: target file does not exist after write ${filePath}`) as NodeJS.ErrnoException;
			err.code = "EPERM";
			throw err;
		}
	}

	indexFile(target, fileName);
	return {
		hash,
		size: buffer.length,
		mimeType,
		ext,
		url: `/api/attachment/${hash}`,
		filePath,
	};
}

export async function findAttachment(hash: string): Promise<AttachmentRecord | null> {
	const target = store;
	if (!target || !/^[a-f0-9]{64}$/i.test(hash)) return null;
	try {
		await ensureIndex(target);
		const files = target.files.get(hash);
		if (!files) return null;
		for (const fileName of [...files].sort()) {
			const filePath = join(target.dir, fileName);
			try {
				const st = await stat(filePath);
				if (!st.isFile()) continue;
				const ext = extname(fileName).toLowerCase();
				return {
					hash,
					size: st.size,
					mimeType: EXT_MIME_MAP[ext] || "application/octet-stream",
					ext,
					url: `/api/attachment/${hash}`,
					filePath,
				};
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code === "ENOENT" || code === "ENOTDIR") files.delete(fileName);
			}
		}
	} catch {
		return null;
	}
	return null;
}

export async function readAttachment(hash: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
	const record = await findAttachment(hash);
	if (!record) return null;
	try {
		const buffer = await readFile(record.filePath);
		return { buffer, mimeType: record.mimeType };
	} catch {
		return null;
	}
}
