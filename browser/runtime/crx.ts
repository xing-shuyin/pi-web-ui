import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import * as yauzl from "yauzl";

/**
 * Chromium 的 `.crx` 是「12~16 字节头部 + 原始 zip」，Electron 的 loadExtension 只吃解压目录，
 * 所以这里负责剥掉头部、把 zip 解到临时目录。签名头部**不校验**（与「加载已解压扩展」同信任级），
 * 但路径越界、条目数/体积上限、符号链接这些解包红线必须挡住。
 */

const CRX_MAGIC = "Cr24";
const ZIP_MAGIC = "PK\u0003\u0004";
const MAX_ENTRIES = 20000;
const MAX_BYTES = 512 * 1024 * 1024;

export function crxPayloadOffset(buf: Buffer): number {
	if (buf.length < 12 || buf.toString("latin1", 0, 4) !== CRX_MAGIC) {
		throw new Error("不是有效的 .crx 文件（缺少 Cr24 标记）");
	}
	const version = buf.readUInt32LE(4);
	if (version === 2) {
		if (buf.length < 16) throw new Error(".crx 头部损坏（版本 2 头长度不足）");
		return 16 + buf.readUInt32LE(8) + buf.readUInt32LE(12);
	}
	if (version === 3) {
		return 12 + buf.readUInt32LE(8);
	}
	throw new Error(`不支持的 .crx 版本：${version}`);
}

export function crxZipPayload(buf: Buffer): Buffer {
	const offset = crxPayloadOffset(buf);
	if (offset >= buf.length || buf.toString("latin1", offset, offset + ZIP_MAGIC.length) !== ZIP_MAGIC) {
		throw new Error(".crx 内容不是 zip 包（头部偏移或版本错误）");
	}
	return buf.subarray(offset);
}

function safeEntryPath(raw: string): string {
	const name = raw.replace(/\\/g, "/").replace(/^\.\/+/, "");
	if (!name || isAbsolute(name) || /^[A-Za-z]:/.test(name)) throw new Error(`.crx 内含非法路径：${raw}`);
	const cleaned = normalize(name).replace(/^\.\//, "");
	if (cleaned === ".." || cleaned.startsWith(`..${sep}`) || cleaned.split("/").includes("..")) {
		throw new Error(`.crx 内含越界路径：${raw}`);
	}
	return name;
}

/** 解压 .crx（或裸 zip）到 destDir；destDir 必须尚不存在（由调用方给临时目录，成功后再改名）。 */
export async function extractCrxInto(source: Buffer | string, destDir: string): Promise<void> {
	const buf = typeof source === "string" ? await readFile(source) : source;
	const zip = await new Promise<yauzl.ZipFile>((ok, fail) =>
		yauzl.fromBuffer(buf.subarray(crxPayloadOffset(buf)), { lazyEntries: true, strictFileNames: true }, (err, z) =>
			err ? fail(err) : ok(z!),
		),
	);
	let entries = 0;
	let bytes = 0;
	const seen = new Set<string>();
	try {
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
					const key = name.toLowerCase();
					if (seen.has(key)) throw new Error(`.crx 内含重复条目：${name}`);
					seen.add(key);
					const type = (entry.externalFileAttributes >>> 16) & 0o170000;
					if (type && type !== 0o100000 && type !== 0o040000) throw new Error(`.crx 内含链接或特殊文件：${name}`);
					if (++entries > MAX_ENTRIES) throw new Error(".crx 条目过多（上限 20000）");
					const dest = join(destDir, name);
					if (name.endsWith("/")) {
						await mkdir(dest, { recursive: true });
					} else {
						await mkdir(dirname(dest), { recursive: true });
						const stream = await new Promise<import("node:stream").Readable>((resolveStream, reject) =>
							zip.openReadStream(entry, (err, s) => (err ? reject(err) : resolveStream(s!))),
						);
						bytes += entry.uncompressedSize;
						if (bytes > MAX_BYTES) throw new Error(".crx 解压后体积超限（上限 512MB）");
						await pipeline(stream, createWriteStream(dest, { flags: "wx", mode: 0o600 }));
					}
					zip.readEntry();
				})().catch(abort);
			});
			zip.readEntry();
		});
	} catch (err) {
		zip.close();
		await rm(destDir, { recursive: true, force: true });
		throw err;
	}
}

export interface CrxManifest {
	name: string;
	version: string;
	manifestVersion: number;
}

/** 解压后校验 manifest.json —— 缺了它就不是可加载的扩展，早报错好过 Electron 抛底层错误。 */
export async function readCrxManifest(dir: string): Promise<CrxManifest> {
	let raw: string;
	try {
		raw = await readFile(join(dir, "manifest.json"), "utf8");
	} catch {
		throw new Error(".crx 里没有 manifest.json，不是可加载的扩展");
	}
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(raw.replace(/^\uFEFF/, "")) as Record<string, unknown>;
	} catch {
		throw new Error("manifest.json 不是合法 JSON");
	}
	const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
	if (!name) throw new Error("manifest.json 缺少 name");
	const version = typeof parsed.version === "string" ? parsed.version : "";
	const manifestVersion = Number(parsed.manifest_version) || 0;
	if (manifestVersion < 2) throw new Error("manifest_version 必须 >= 2");
	return { name, version, manifestVersion };
}
