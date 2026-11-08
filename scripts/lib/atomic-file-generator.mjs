// 把 server/atomic-file.ts 里的「注入式原子写 / 容错读」编译成 bin 侧可直接 import 的独立模块。
// 目的：Hub 升级 worker（bin/hub-upgrade.mjs）跑在 node 单文件里，不能 import dist 之外的 TS，
// 但 Windows EPERM 退避逻辑必须与 server 侧同一份实现 —— 于是由构建期生成，而不是各写一遍。
import { format, resolveConfig } from "prettier";

/**
 * @param {{ portableAtomicWriteSyncSource: () => string, portableAtomicReadSyncSource: () => string }} atomic
 * @returns {Promise<string>}
 */
export async function renderBinAtomicFile(atomic) {
	const body = `// AUTO-GENERATED FILE — 不要手改。
// 来源：server/atomic-file.ts 的 writeAtomicPortableSync / readFileSyncRetryPortableSync
// 重新生成：npm run gen:atomic（npm run build:server 末尾也会跑）
// 守卫：tests/unit/atomic-file-generated.test.ts 会在 dist 存在时逐字节比对，漂移即红。
import {
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";

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

${atomic.portableAtomicWriteSyncSource()}

${atomic.portableAtomicReadSyncSource()}

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
`;
	const config = (await resolveConfig("bin/lib/atomic-file.mjs")) ?? {};
	return await format(body, { ...config, parser: "babel", filepath: "bin/lib/atomic-file.mjs" });
}
