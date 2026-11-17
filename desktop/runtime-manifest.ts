/**
 * 运行时清单与归档安全（P1）：签名、版本闸门、归档条目白名单、摘要校验。
 *
 * 设计约束（见 docs/architecture-desktop-runtime.md §五 §六 §十）：
 * - 信任根是**壳内硬编码的 ed25519 公钥**，私钥只在 CI secret；签名不通过一律拒绝。
 * - 闸门只有"明确放行"与"明确拒绝"，没有"先跑起来再说"。
 * - 纯函数 + `node:crypto`，不 import electron，可直接单测。
 */

import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";

export const RUNTIME_MANIFEST_SCHEMA_VERSION = 1;

/** 复用 desktop/updater.ts 的错误分类语义（面板按 code 决定重试/引导）。 */
export type RuntimeErrorCode = "manifest" | "unsupported" | "corrupt" | "busy" | "health";

export type RuntimePayloadKind = "core" | "natives";

export type RuntimePlatform = "win32" | "darwin" | "linux";

export type RuntimeArch = "x64" | "arm64";

export interface RuntimePayload {
	kind: RuntimePayloadKind;
	platform: RuntimePlatform;
	arch: RuntimeArch;
	/** 绝对 https 地址；本地 feed 测试时允许 http，由调用方决定是否放行。 */
	url: string;
	size: number;
	sha256: string;
}

export interface RuntimeManifest {
	schemaVersion: number;
	version: string;
	nativesVersion: string | null;
	/** 运行时与壳/前端的协议版本，必须等于壳自带那份。 */
	protocol: number;
	/** 运行时要求的最低壳能力（壳改 preload/IPC 时 +1）。 */
	minShell: number;
	createdAt: string | null;
	payloads: RuntimePayload[];
}

/**
 * 归档里允许出现的顶层条目。**必须覆盖 electron-builder.yml 的 files 名单**，
 * 否则打出来的运行时装得上、跑不起来（落盘的是个残废运行时）。
 * 守卫：tests/unit/desktop-runtime-manifest.test.ts 会拿 electron-builder.yml 逐项对。
 */
export const RUNTIME_ALLOWED_TOP_LEVEL = [
	"dist",
	"web",
	"bin",
	"node_modules",
	"themes",
	"plugins",
	"plugin-sdk",
	"docs",
	"package.json",
] as const;

export const RUNTIME_ALLOWED_FILES = ["package.json"] as const;

const SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export function isSafeRuntimeVersion(value: unknown): value is string {
	return typeof value === "string" && SAFE_VERSION.test(value);
}

function isPositiveInt(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isSha256(value: unknown): value is string {
	return typeof value === "string" && SHA256_HEX.test(value);
}

const PLATFORMS: RuntimePlatform[] = ["win32", "darwin", "linux"];
const ARCHES: RuntimeArch[] = ["x64", "arm64"];

function parsePayload(raw: unknown): RuntimePayload | null {
	if (typeof raw !== "object" || raw === null) return null;
	const value = raw as Record<string, unknown>;
	if (value.kind !== "core" && value.kind !== "natives") return null;
	if (!PLATFORMS.includes(value.platform as RuntimePlatform)) return null;
	if (!ARCHES.includes(value.arch as RuntimeArch)) return null;
	if (typeof value.url !== "string" || value.url.length === 0) return null;
	if (!isPositiveInt(value.size)) return null;
	if (!isSha256(value.sha256)) return null;
	return {
		kind: value.kind,
		platform: value.platform as RuntimePlatform,
		arch: value.arch as RuntimeArch,
		url: value.url,
		size: value.size,
		sha256: value.sha256,
	};
}

/** 解析清单；任何不合规返回 null（由调用方按 `manifest` 错误处理）。 */
export function parseRuntimeManifest(raw: unknown): RuntimeManifest | null {
	if (typeof raw !== "object" || raw === null) return null;
	const value = raw as Record<string, unknown>;
	if (value.schemaVersion !== RUNTIME_MANIFEST_SCHEMA_VERSION) return null;
	if (!isSafeRuntimeVersion(value.version)) return null;
	if (
		value.nativesVersion !== null &&
		value.nativesVersion !== undefined &&
		!isSafeRuntimeVersion(value.nativesVersion)
	)
		return null;
	if (!isPositiveInt(value.protocol)) return null;
	if (!isPositiveInt(value.minShell)) return null;
	if (!Array.isArray(value.payloads) || value.payloads.length === 0) return null;
	const payloads: RuntimePayload[] = [];
	for (const item of value.payloads) {
		const payload = parsePayload(item);
		if (!payload) return null;
		payloads.push(payload);
	}
	return {
		schemaVersion: RUNTIME_MANIFEST_SCHEMA_VERSION,
		version: value.version,
		nativesVersion: typeof value.nativesVersion === "string" ? value.nativesVersion : null,
		protocol: value.protocol,
		minShell: value.minShell,
		createdAt: typeof value.createdAt === "string" ? value.createdAt : null,
		payloads,
	};
}

/**
 * 清单签名验证：对**原始字节**（不是重新序列化的对象）做 ed25519 detached 校验，
 * 避免"验的是我重排过的 JSON"这类自欺。
 */
export function verifyManifestSignature(input: {
	manifestText: string;
	signatureBase64: string;
	publicKeyPem: string;
}): boolean {
	if (!input.publicKeyPem.trim() || !input.signatureBase64.trim()) return false;
	let key;
	let signature: Buffer;
	try {
		key = createPublicKey(input.publicKeyPem);
		signature = Buffer.from(input.signatureBase64, "base64");
	} catch {
		return false;
	}
	if (signature.length !== 64) return false;
	try {
		return cryptoVerify(null, Buffer.from(input.manifestText, "utf8"), key, signature);
	} catch {
		return false;
	}
}

export function sha256Hex(data: Buffer | string): string {
	return createHash("sha256").update(data).digest("hex");
}

/** 归档字节与清单里的 size/sha256 是否一致（先比长度，再比摘要，省掉大文件的无谓哈希）。 */
export function verifyPayloadBytes(data: Buffer, payload: Pick<RuntimePayload, "size" | "sha256">): boolean {
	return data.length === payload.size && sha256Hex(data) === payload.sha256;
}

/** 挑本次平台/架构要下的载荷；`kind` 未给时只挑 core。 */
export function selectPayload(
	manifest: RuntimeManifest,
	target: { platform: RuntimePlatform; arch: RuntimeArch; kind?: RuntimePayloadKind },
): RuntimePayload | null {
	const kind = target.kind ?? "core";
	return (
		manifest.payloads.find((p) => p.kind === kind && p.platform === target.platform && p.arch === target.arch) ?? null
	);
}

export interface ShellFacts {
	protocol: number;
	capability: number;
	platform: RuntimePlatform;
	arch: RuntimeArch;
	/** 已安装/包内自带的版本；给了就顺带做防降级。 */
	installedVersion?: string | null;
}

export type CompatibilityResult =
	| { ok: true; core: RuntimePayload; natives: RuntimePayload | null }
	| { ok: false; code: RuntimeErrorCode; reason: string };

/** 四道闸门 + 载荷可用性。返回的 reason 直接进日志/面板，别让用户猜。 */
export function checkRuntimeCompatibility(manifest: RuntimeManifest, shell: ShellFacts): CompatibilityResult {
	const core = selectPayload(manifest, { platform: shell.platform, arch: shell.arch, kind: "core" });
	if (!core) {
		return { ok: false, code: "unsupported", reason: `清单里没有 ${shell.platform}-${shell.arch} 的 core 载荷` };
	}
	const natives = selectPayload(manifest, { platform: shell.platform, arch: shell.arch, kind: "natives" });
	if (manifest.protocol !== shell.protocol) {
		return {
			ok: false,
			code: "unsupported",
			reason: `运行时协议 ${manifest.protocol} 与壳 ${shell.protocol} 不一致，需要先更新桌面壳`,
		};
	}
	if (manifest.minShell > shell.capability) {
		return {
			ok: false,
			code: "unsupported",
			reason: `运行时要求壳能力 ≥ ${manifest.minShell}，当前 ${shell.capability}，需要先更新桌面壳`,
		};
	}
	if (shell.installedVersion && compareVersions(manifest.version, shell.installedVersion) <= 0) {
		return {
			ok: false,
			code: "unsupported",
			reason: `清单版本 ${manifest.version} 不高于已安装 ${shell.installedVersion}（防降级）`,
		};
	}
	return { ok: true, core, natives };
}

/**
 * 比较 semver 主/次/补丁（忽略预发布标签的排序细节：只用来判"高一版/低一版/同版"）。
 * 返回 1 = a 更高，-1 = b 更高，0 = 相同。
 */
export function compareVersions(a: string, b: string): number {
	const norm = (v: string) =>
		v
			.split("-")[0]
			.split(".")
			.map((part) => Number.parseInt(part, 10) || 0);
	const left = norm(a);
	const right = norm(b);
	for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
		const l = left[i] ?? 0;
		const r = right[i] ?? 0;
		if (l !== r) return l > r ? 1 : -1;
	}
	return 0;
}

export type ArchiveEntryVerdict = { ok: true } | { ok: false; reason: string };

/**
 * 归档条目白名单：拒绝绝对路径、`..`、盘符、反斜杠穿越，以及不在允许顶层里的东西。
 * 解包前逐条过这一步，任何一条不合规就整包拒绝（不做"跳过坏条目"）。
 */
export function checkArchiveEntryPath(name: string): ArchiveEntryVerdict {
	if (typeof name !== "string" || name.length === 0) return { ok: false, reason: "空条目名" };
	if (name.includes("\0")) return { ok: false, reason: "条目名含 NUL" };
	if (/^[A-Za-z]:/.test(name)) return { ok: false, reason: `盘符路径：${name}` };
	if (name.startsWith("/") || name.startsWith("\\")) return { ok: false, reason: `绝对路径：${name}` };
	// tar 的 portable 模式给条目加 `./` 前缀；根目录条目（"./"/"."）本身无害，其余归一化后再判。
	const normalized = name.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
	const segments = normalized.split("/").filter((segment) => segment.length > 0);
	if (segments.length === 0) return { ok: true };
	const top = segments[0];
	if (!top || segments.includes("..")) return { ok: false, reason: `路径穿越：${name}` };
	if (top === ".") return { ok: false, reason: `路径穿越：${name}` };
	if (!(RUNTIME_ALLOWED_TOP_LEVEL as readonly string[]).includes(top))
		return { ok: false, reason: `不在允许顶层内：${name}` };
	return { ok: true };
}

/** tar 条目类型白/黑名单：链接会逃出目标目录，一律不收。 */
export function checkArchiveEntryType(type: string | undefined, name: string): ArchiveEntryVerdict {
	if (type === "SymbolicLink" || type === "Link") return { ok: false, reason: `拒绝链接条目：${name}` };
	if (type === "CharacterDevice" || type === "BlockDevice" || type === "FIFO")
		return { ok: false, reason: `拒绝特殊文件：${name}` };
	return { ok: true };
}
