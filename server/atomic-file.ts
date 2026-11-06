import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export interface AtomicWriteOptions {
	mode?: number;
	fsync?: boolean;
}

export function writeAtomicSync(
	file: string,
	data: string | NodeJS.ArrayBufferView,
	options: AtomicWriteOptions = {},
): void {
	const dir = dirname(file);
	mkdirSync(dir, { recursive: true });
	const suffix = `${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}.tmp`;
	const tmp = `${file}.${suffix}`;
	try {
		if (options.mode !== undefined || options.fsync) {
			let mode = options.mode;
			if (mode !== undefined) {
				try {
					mode = statSync(file).mode & 0o777;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
			}
			const fd = openSync(tmp, "wx", mode);
			try {
				writeFileSync(fd, data);
				if (options.fsync) fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
		} else {
			writeFileSync(tmp, data);
		}
		for (let attempt = 0; ; attempt++) {
			try {
				renameSync(tmp, file);
				break;
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (attempt >= 2 || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) throw error;
			}
		}
	} finally {
		try {
			rmSync(tmp, { force: true });
		} catch {}
	}
}

export function writeAtomicPortableSync(
	fs: Pick<typeof import("node:fs"), "openSync" | "writeFileSync" | "closeSync" | "renameSync" | "rmSync">,
	file: string,
	data: string,
	nonce: string,
	mode = 0o600,
): void {
	if (!nonce || nonce.length > 128 || !/^[A-Za-z0-9_.-]+$/.test(nonce)) throw new Error("Invalid atomic-write nonce");
	const temporary = `${file}.${nonce}.tmp`;
	try {
		const descriptor = fs.openSync(temporary, "wx", mode);
		try {
			fs.writeFileSync(descriptor, data, "utf8");
		} finally {
			fs.closeSync(descriptor);
		}
		for (let attempt = 0; ; attempt++) {
			try {
				fs.renameSync(temporary, file);
				break;
			} catch (error) {
				if (attempt >= 2 || !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? ""))
					throw error;
			}
		}
	} finally {
		try {
			fs.rmSync(temporary, { force: true });
		} catch {}
	}
}

export function portableAtomicWriteSyncSource(): string {
	return `const writeAtomicPortable = (${writeAtomicPortableSync.toString()});`;
}

export function writeJsonAtomicSync(file: string, data: unknown, indent: number | string = 2): void {
	const text = JSON.stringify(data, null, indent) + "\n";
	writeAtomicSync(file, text);
}
