import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, readFileSync, createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createZstdCompress } from "node:zlib";
import { pipeline } from "node:stream/promises";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";
import {
	checkArchiveEntryPath,
	checkArchiveEntryType,
	checkRuntimeCompatibility,
	compareVersions,
	parseRuntimeManifest,
	RUNTIME_ALLOWED_TOP_LEVEL,
	selectPayload,
	sha256Hex,
	verifyManifestSignature,
	verifyPayloadBytes,
} from "../../desktop/runtime-manifest.js";
import { extractRuntimeArchive } from "../../desktop/runtime-store.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(prefix = "pi-runtime-manifest-") {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

function manifest(overrides: Record<string, unknown> = {}) {
	return {
		schemaVersion: 1,
		version: "0.122.0",
		nativesVersion: null,
		protocol: 59,
		minShell: 1,
		createdAt: null,
		payloads: [
			{
				kind: "core",
				platform: "win32",
				arch: "x64",
				url: "https://example.invalid/core-0.122.0-win32-x64.tar.zst",
				size: 1024,
				sha256: "a".repeat(64),
			},
		],
		...overrides,
	};
}

function keys() {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	return {
		privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
		publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
	};
}

describe("清单解析（签名前置：结构不合规就是 manifest 错误）", () => {
	it("合法清单原样读出", () => {
		expect(parseRuntimeManifest(manifest())).toMatchObject({ version: "0.122.0", protocol: 59, minShell: 1 });
	});

	it("schemaVersion / protocol / minShell / payloads 缺一不可", () => {
		expect(parseRuntimeManifest(manifest({ schemaVersion: 2 }))).toBeNull();
		expect(parseRuntimeManifest(manifest({ protocol: 0 }))).toBeNull();
		expect(parseRuntimeManifest(manifest({ minShell: undefined }))).toBeNull();
		expect(parseRuntimeManifest(manifest({ payloads: [] }))).toBeNull();
		expect(parseRuntimeManifest(manifest({ payloads: [{ kind: "core" }] }))).toBeNull();
	});

	it("版本号仍然只认安全字符；sha256 必须是 64 位小写十六进制", () => {
		expect(parseRuntimeManifest(manifest({ version: "../0.122.0" }))).toBeNull();
		const bad = manifest();
		bad.payloads[0].sha256 = "A".repeat(64);
		expect(parseRuntimeManifest(bad)).toBeNull();
		const badSize = manifest();
		badSize.payloads[0].size = 0;
		expect(parseRuntimeManifest(badSize)).toBeNull();
	});
});

describe("清单签名（ed25519 detached，对原始字节校验）", () => {
	it("签名能验过；改一个字节就验不过", () => {
		const { privatePem, publicPem } = keys();
		const text = `${JSON.stringify(manifest(), null, 2)}\n`;
		const signature = sign(null, Buffer.from(text, "utf8"), privatePem).toString("base64");
		expect(verifyManifestSignature({ manifestText: text, signatureBase64: signature, publicKeyPem: publicPem })).toBe(
			true,
		);
		expect(
			verifyManifestSignature({ manifestText: `${text} `, signatureBase64: signature, publicKeyPem: publicPem }),
		).toBe(false);
	});

	it("换一把公钥 / 空公钥 / 垃圾签名都验不过（fail closed）", () => {
		const { privatePem, publicPem } = keys();
		const other = keys();
		const text = JSON.stringify(manifest());
		const signature = sign(null, Buffer.from(text, "utf8"), privatePem).toString("base64");
		expect(
			verifyManifestSignature({ manifestText: text, signatureBase64: signature, publicKeyPem: other.publicPem }),
		).toBe(false);
		expect(verifyManifestSignature({ manifestText: text, signatureBase64: signature, publicKeyPem: "" })).toBe(false);
		expect(
			verifyManifestSignature({ manifestText: text, signatureBase64: "bm90LWEtc2ln", publicKeyPem: publicPem }),
		).toBe(false);
		expect(verifyManifestSignature({ manifestText: text, signatureBase64: "", publicKeyPem: publicPem })).toBe(false);
	});
});

describe("版本闸门", () => {
	const shell = { protocol: 59, capability: 3, platform: "win32" as const, arch: "x64" as const };

	it("协议一致、壳能力够、有对应载荷 → 放行", () => {
		const result = checkRuntimeCompatibility(parseRuntimeManifest(manifest())!, shell);
		expect(result.ok).toBe(true);
	});

	it("协议不一致 → unsupported（提示先更新壳）", () => {
		const result = checkRuntimeCompatibility(parseRuntimeManifest(manifest({ protocol: 60 }))!, shell);
		expect(result).toMatchObject({ ok: false, code: "unsupported" });
	});

	it("minShell 高于壳能力 → unsupported", () => {
		const result = checkRuntimeCompatibility(parseRuntimeManifest(manifest({ minShell: 4 }))!, shell);
		expect(result).toMatchObject({ ok: false, code: "unsupported" });
	});

	it("平台/架构没有对应载荷 → unsupported", () => {
		const result = checkRuntimeCompatibility(parseRuntimeManifest(manifest())!, { ...shell, platform: "linux" });
		expect(result).toMatchObject({ ok: false, code: "unsupported" });
	});

	it("防降级：同版或更低版本一律拒绝", () => {
		const parsed = parseRuntimeManifest(manifest())!;
		expect(checkRuntimeCompatibility(parsed, { ...shell, installedVersion: "0.122.0" })).toMatchObject({
			code: "unsupported",
		});
		expect(checkRuntimeCompatibility(parsed, { ...shell, installedVersion: "0.123.0" })).toMatchObject({
			code: "unsupported",
		});
		expect(checkRuntimeCompatibility(parsed, { ...shell, installedVersion: "0.121.0" }).ok).toBe(true);
	});

	it("载荷按平台/架构挑，natives 可选", () => {
		const parsed = parseRuntimeManifest(manifest())!;
		expect(selectPayload(parsed, { platform: "win32", arch: "x64" })?.kind).toBe("core");
		expect(selectPayload(parsed, { platform: "win32", arch: "x64", kind: "natives" })).toBeNull();
	});

	it("版本比较只看主次补丁", () => {
		expect(compareVersions("0.122.0", "0.121.9")).toBe(1);
		expect(compareVersions("0.121.0", "0.122.0")).toBe(-1);
		expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
		expect(compareVersions("0.122.0-beta.1", "0.122.0")).toBe(0);
	});
});

describe("产物工具链接线（改名/删脚本会立刻红）", () => {
	it("package.json 暴露构建与验收脚本，且脚本文件真实存在", () => {
		const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { scripts: Record<string, string> };
		expect(pkg.scripts["build:desktop-runtime"]).toContain("scripts/build-desktop-runtime.mjs");
		expect(pkg.scripts["verify:desktop-runtime"]).toContain("scripts/verify-desktop-runtime.mjs");
		expect(existsSync(join(repoRoot, "scripts", "build-desktop-runtime.mjs"))).toBe(true);
		expect(existsSync(join(repoRoot, "scripts", "verify-desktop-runtime.mjs"))).toBe(true);
	});

	it("构建脚本默认不打包 dist/desktop / dist/browser（壳专用，不进运行时）", () => {
		const source = readFileSync(join(repoRoot, "scripts", "build-desktop-runtime.mjs"), "utf8");
		const include = /const DEFAULT_INCLUDE = \[([^\]]+)\]/.exec(source)?.[1] ?? "";
		expect(include).not.toContain("dist/desktop");
		expect(include).not.toContain("dist/browser");
		expect(include).toContain("dist/server");
	});
});

describe("归档安全", () => {
	it("白名单内的路径通过", () => {
		for (const name of [
			"dist/server/index.js",
			"web/dist/index.html",
			"bin/ffmpeg/win32-x64/ffmpeg.exe",
			"node_modules/ws/index.js",
			"./package.json",
		]) {
			expect(checkArchiveEntryPath(name), name).toEqual({ ok: true });
		}
	});

	it("绝对路径 / 盘符 / 穿越 / 未知顶层一律拒绝", () => {
		for (const name of ["/etc/passwd", "C:/Windows/system32/x.dll", "dist/../../etc/passwd", "..", "unknown/file"]) {
			expect(checkArchiveEntryPath(name).ok, name).toBe(false);
		}
	});

	it("链接与设备文件一律拒绝", () => {
		expect(checkArchiveEntryType("SymbolicLink", "dist/x").ok).toBe(false);
		expect(checkArchiveEntryType("Link", "dist/x").ok).toBe(false);
		expect(checkArchiveEntryType("File", "dist/x").ok).toBe(true);
		expect(checkArchiveEntryType("Directory", "dist").ok).toBe(true);
	});

	it("白名单覆盖 electron-builder.yml 的打包名单（漏一个就会打出残废运行时）", () => {
		const yml = readFileSync(join(repoRoot, "desktop", "electron-builder.yml"), "utf8");
		const filesBlock = yml.split(/^files:\s*$/m)[1]?.split(/^\S/m)[0] ?? "";
		const entries = filesBlock
			.split("\n")
			.map((line) => /^\s*-\s+(.+?)\s*$/.exec(line)?.[1] ?? "")
			.filter((entry): entry is string => Boolean(entry) && !entry.startsWith("#"));
		expect(entries.length).toBeGreaterThan(3);
		for (const entry of entries) {
			const top = entry.split("/")[0];
			// 壳专用目录（dist/desktop、dist/browser）不进运行时归档，其余必须被白名单覆盖
			if (entry.startsWith("dist/desktop") || entry.startsWith("dist/browser")) continue;
			if (entry.startsWith("node_modules/")) continue; // 整体走 node_modules 顶层
			expect(RUNTIME_ALLOWED_TOP_LEVEL.includes(top as (typeof RUNTIME_ALLOWED_TOP_LEVEL)[number]), entry).toBe(true);
		}
	});

	it("摘要校验：长度与 sha256 都要对", () => {
		const data = Buffer.from("runtime payload");
		expect(verifyPayloadBytes(data, { size: data.length, sha256: sha256Hex(data) })).toBe(true);
		expect(verifyPayloadBytes(data, { size: data.length + 1, sha256: sha256Hex(data) })).toBe(false);
		expect(verifyPayloadBytes(data, { size: data.length, sha256: "b".repeat(64) })).toBe(false);
	});
});

describe("解包（真 tar.zst 往返 + 白名单生效）", () => {
	async function buildArchive(sourceDir: string, archivePath: string, entries: string[]) {
		const tarPath = join(sourceDir, "payload.tar");
		await tar.c({ file: tarPath, cwd: sourceDir, portable: true }, entries);
		await pipeline(createReadStream(tarPath), createZstdCompress(), createWriteStream(archivePath));
		return archivePath;
	}

	it("正常归档解包到空目录，文件数与摘要都对", async () => {
		const src = await tempDir();
		await mkdir(join(src, "dist", "server"), { recursive: true });
		await writeFile(join(src, "dist", "server", "index.js"), "// runtime\n");
		await writeFile(join(src, "package.json"), "{}\n");
		const archive = await buildArchive(src, join(src, "core.tar.zst"), ["dist", "package.json"]);
		const bytes = readFileSync(archive);

		const target = join(await tempDir(), "runtime-0.122.0");
		const result = await extractRuntimeArchive({
			archivePath: archive,
			targetDir: target,
			expected: { size: bytes.length, sha256: sha256Hex(bytes) },
		});
		expect(result).toEqual({ ok: true, files: 2 });
		expect(readFileSync(join(target, "dist", "server", "index.js"), "utf8")).toBe("// runtime\n");
	});

	it("摘要不符 → 拒绝，且目标目录不残留", async () => {
		const src = await tempDir();
		await mkdir(join(src, "dist"), { recursive: true });
		await writeFile(join(src, "dist", "index.js"), "x");
		const archive = await buildArchive(src, join(src, "core.tar.zst"), ["dist"]);
		const target = join(await tempDir(), "runtime-0.122.0");
		const result = await extractRuntimeArchive({
			archivePath: archive,
			targetDir: target,
			expected: { size: 1, sha256: "c".repeat(64) },
		});
		expect(result).toMatchObject({ ok: false, code: "corrupt" });
		expect(existsSync(target)).toBe(false);
	});

	it("目标目录非空 → busy，绝不覆盖已有运行时", async () => {
		const src = await tempDir();
		await mkdir(join(src, "dist"), { recursive: true });
		await writeFile(join(src, "dist", "index.js"), "x");
		const archive = await buildArchive(src, join(src, "core.tar.zst"), ["dist"]);
		const target = await tempDir();
		await writeFile(join(target, "keep.txt"), "keep");
		const result = await extractRuntimeArchive({ archivePath: archive, targetDir: target });
		expect(result).toMatchObject({ ok: false, code: "busy" });
	});

	it("归档里混进白名单外的顶层 → 整包拒绝并清空目标目录", async () => {
		const src = await tempDir();
		await mkdir(join(src, "evil"), { recursive: true });
		await writeFile(join(src, "evil", "payload.sh"), "echo bad\n");
		await mkdir(join(src, "dist"), { recursive: true });
		await writeFile(join(src, "dist", "index.js"), "x");
		const archive = await buildArchive(src, join(src, "core.tar.zst"), ["dist", "evil"]);
		const target = join(await tempDir(), "runtime-0.122.0");
		const result = await extractRuntimeArchive({ archivePath: archive, targetDir: target });
		expect(result).toMatchObject({ ok: false, code: "corrupt" });
		expect(existsSync(target)).toBe(false);
	});
});
