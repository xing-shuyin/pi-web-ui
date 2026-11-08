// AUTO-GENERATED FILE — 不要手改。
// 来源：server/atomic-file.ts 的 writeAtomicPortableSync / readFileSyncRetryPortableSync
// 重新生成：npm run gen:atomic（npm run build:server 末尾也会跑）
// 守卫：tests/unit/atomic-file-generated.test.ts 会在 dist 存在时逐字节比对，漂移即红。
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

const fsApi = {
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
};

const writeAtomicPortable = function writeAtomicPortableSync(fs, file, data, nonce, mode = 0o600, fsync = false) {
	if (!nonce || nonce.length > 128 || !/^[A-Za-z0-9_.-]+$/.test(nonce)) throw new Error("Invalid atomic-write nonce");
	const sleep = (ms) => {
		try {
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
		} catch {}
	};
	const retryDelays = [20, 60, 150, 400];
	const transient = ["EPERM", "EACCES", "EBUSY"];
	const sep = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
	if (sep > 0) fs.mkdirSync(file.slice(0, sep), { recursive: true });
	const temporary = `${file}.${nonce}.tmp`;
	try {
		const descriptor = fs.openSync(temporary, "wx", mode);
		try {
			fs.writeFileSync(descriptor, data, "utf8");
			if (fsync) fs.fsyncSync(descriptor);
		} finally {
			fs.closeSync(descriptor);
		}
		for (let attempt = 0; ; attempt++) {
			try {
				fs.renameSync(temporary, file);
				break;
			} catch (error) {
				const code = error.code;
				const attemptDelay = retryDelays[attempt];
				if (attemptDelay === undefined || !transient.includes(code ?? "")) throw error;
				sleep(attemptDelay);
			}
		}
	} finally {
		try {
			fs.rmSync(temporary, { force: true });
		} catch {}
	}
};

const readFileSyncRetryPortable = function readFileSyncRetryPortableSync(fs, file, encoding = "utf8") {
	const sleep = (ms) => {
		try {
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
		} catch {}
	};
	const retryDelays = [20, 60, 150, 400];
	const transient = ["EPERM", "EACCES", "EBUSY"];
	for (let attempt = 0; ; attempt++) {
		try {
			return fs.readFileSync(file, encoding);
		} catch (error) {
			const code = error.code;
			const attemptDelay = retryDelays[attempt];
			if (code === "ENOENT" || attemptDelay === undefined || !transient.includes(code ?? "")) throw error;
			sleep(attemptDelay);
		}
	}
};

/**
 * 原子写：写临时文件 → 带退避重试的 rename。nonce 由调用方给（必须是 [A-Za-z0-9_.-]）。
 * @param {string} file
 * @param {string} data
 * @param {{ nonce: string, mode?: number, fsync?: boolean }} options
 */
export function writeAtomicFileSync(file, data, { nonce, mode = 0o600, fsync = false } = {}) {
	if (!nonce) throw new Error("writeAtomicFileSync requires a nonce");
	writeAtomicPortable(fsApi, file, data, nonce, mode, fsync);
}

/** 容错读：ENOENT 直接抛给调用方判断，EPERM/EACCES/EBUSY 退避重试。 */
export function readFileSyncRetry(file) {
	return readFileSyncRetryPortable(fsApi, file);
}
