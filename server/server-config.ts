import { chmodSync, constants, copyFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { writeAtomic } from "./atomic-file.js";

export type ServerFileConfig = {
	port?: number;
	host?: string;
	token?: string;
	allowHosts?: string;
	allowOrigins?: string;
};

/**
 * 口令落盘的两个权限位（POSIX）：文件只给属主读写，数据目录只给属主进入。
 * Windows 没有 POSIX mode（`chmod` 只能切只读位），一律跳过；那里的收紧属于目录 ACL，另一件事。
 */
export const CONFIG_FILE_MODE = 0o600;
export const DATA_DIR_MODE = 0o700;

const POSIX = process.platform !== "win32";
const FILE_NAME = "server-config.json";
/** 损坏文件的备份名：`server-config.json.corrupt-<内容哈希>.json`（同一份坏内容只留一份）。 */
const BACKUP_PREFIX = `${FILE_NAME}.corrupt-`;
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * 读配置文件的三态。`catch` 之后一律当「没配过」的写法必须消失：文件被写坏 / 读不动时
 * 静默变成空配置，等于保护悄悄消失（issue #969 第 2 条）。
 */
export type ServerConfigState = "absent" | "ok" | "corrupt";

export interface ServerConfigLoad {
	state: ServerConfigState;
	/**
	 * `state === "ok"` / `"absent"` 时是文件内容（`absent` 为 `{}`）。
	 * `state === "corrupt"` 时只有 `token`，值是**本次启动的内存临时口令**（不落盘）：目的是让服务
	 * 继续要求认证（fail-closed），用户凭它或到 `/setup` 改成自己的口令。
	 */
	config: ServerFileConfig;
	/** 损坏原因 + 备份文件名；正常态为空串。 */
	error: string;
}

export function configFilePath(dataDir: string): string {
	return join(dataDir, FILE_NAME);
}

/**
 * 读配置的唯一判据：`ENOENT` 才是「从未配置」，解析失败 / 读失败 / 顶层不是对象一律 `corrupt`。
 * 字段类型不对不算损坏（历史文件里本来就有被忽略的字段），只忽略该字段。
 */
export function readServerFileConfig(dataDir: string): ServerConfigLoad {
	const file = configFilePath(dataDir);
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent", config: {}, error: "" };
		return corruptLoad(file, "", `读取失败：${describeFsError(error)}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return corruptLoad(file, raw, `JSON 解析失败：${(error as Error).message}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return corruptLoad(file, raw, `顶层不是 JSON 对象（${Array.isArray(parsed) ? "数组" : typeof parsed}）`);
	}
	return { state: "ok", config: normalizeServerFileConfig(parsed as Record<string, unknown>), error: "" };
}

/**
 * 既有调用点的投影（`server/index.ts` 只吃 `ServerFileConfig`）：判据只在 `readServerFileConfig`，
 * 别在这里再判一遍。损坏态也会给出临时口令，所以经这里启动的服务同样是 fail-closed。
 */
export function loadServerFileConfig(dataDir: string): ServerFileConfig {
	return readServerFileConfig(dataDir).config;
}

export async function saveServerFileConfig(dataDir: string, cfg: ServerFileConfig): Promise<void> {
	ensurePrivateDataDir(dataDir);
	const file = configFilePath(dataDir);
	// 口令落盘的非阻塞版（`writeAtomic`）：临时文件直接以 0600 创建，rename 后目标文件就是这个 mode。
	// 仍然保留下面那次显式 chmod；它不再是「补 `writeAtomicSync` 沿用旧 mode 的缺口」，而是
	// 「文件系统忽略 open 的 mode / 老安装的 0644 目标还在」时的唯一收紧手段——两者任一缺失都会让 0600 变成偶然。
	await writeAtomic(file, `${JSON.stringify(cfg, null, "\t")}\n`, { mode: CONFIG_FILE_MODE });
	await chmodConfigFile(file);
}

/**
 * 数据目录：创建时就是 0700；已存在但更宽松（老安装的 0755）时收紧。
 * 目录权限是临时文件的唯一防线——`writeAtomic` 在目录里写 `.tmp` 时用的是显式传的 0600，
 * 但目录本身一旦 0755，别人就能看到那个瞬时文件。收紧失败只告警：口令文件本身仍是 0600。
 */
export function ensurePrivateDataDir(dataDir: string): void {
	mkdirSync(dataDir, { recursive: true, mode: DATA_DIR_MODE });
	if (!POSIX) return;
	try {
		if ((statSync(dataDir).mode & 0o077) !== 0) chmodSync(dataDir, DATA_DIR_MODE);
	} catch (error) {
		console.warn(`[config] 无法把数据目录 ${dataDir} 收紧为 0700：${describeFsError(error)}`);
	}
}

/** 临时口令：24 字节随机十六进制，只活在内存里，重启即换。 */
export function generateTemporaryToken(): string {
	return randomBytes(24).toString("hex");
}

async function chmodConfigFile(file: string): Promise<void> {
	if (!POSIX) return;
	try {
		await chmod(file, CONFIG_FILE_MODE);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		// FAT/exFAT/SMB 这类文件系统存不了 POSIX 权限位：告警，但不该让配置根本写不下去。
		// 其余错误（EPERM / EACCES / EIO…）意味着「本该 0600 却可能不是」，让保存直接失败才对。
		if (code === "ENOSYS" || code === "ENOTSUP" || code === "EOPNOTSUPP") {
			console.warn(`[config] ${file} 所在文件系统不支持 POSIX 权限位（${code}），无法收紧为 0600`);
			return;
		}
		throw new Error(`无法把 ${file} 收紧为 0600：${describeFsError(error)}`);
	}
}

/**
 * 损坏：按内容哈希留一份原文件备份（反复重启不会堆备份），再给这次启动发一个临时口令。
 * 绝不返回 `{}`——那等于「文件坏了就当没设口令」，保护静默消失。
 */
function corruptLoad(file: string, raw: string, reason: string): ServerConfigLoad {
	const backup = preserveCorruptFile(file, raw);
	return {
		state: "corrupt",
		config: { token: generateTemporaryToken() },
		error: backup ? `${reason}（原文件已备份为 ${backup}）` : reason,
	};
}

/** 只复制、不改动原文件：坏文件是排障证据，也让用户能手改回来。 */
function preserveCorruptFile(file: string, raw: string): string {
	if (!raw) return "";
	const digest = createHash("sha256").update(raw).digest("hex").slice(0, 8);
	const name = `${BACKUP_PREFIX}${digest}.json`;
	try {
		copyFileSync(file, join(dirname(file), name), constants.COPYFILE_EXCL);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
			console.warn(`[config] 备份损坏的配置文件 ${file} 失败：${describeFsError(error)}`);
			return "";
		}
	}
	return name;
}

function normalizeServerFileConfig(parsed: Record<string, unknown>): ServerFileConfig {
	const out: ServerFileConfig = {};
	if (typeof parsed.port === "number" && Number.isInteger(parsed.port)) out.port = parsed.port;
	if (typeof parsed.host === "string" && parsed.host.trim()) out.host = parsed.host.trim();
	if (typeof parsed.token === "string") out.token = parsed.token;
	if (typeof parsed.allowHosts === "string") out.allowHosts = parsed.allowHosts;
	if (Array.isArray(parsed.allowHosts))
		out.allowHosts = parsed.allowHosts.filter((s) => typeof s === "string").join(",");
	if (typeof parsed.allowOrigins === "string") out.allowOrigins = parsed.allowOrigins;
	if (Array.isArray(parsed.allowOrigins))
		out.allowOrigins = parsed.allowOrigins.filter((s) => typeof s === "string").join(",");
	return out;
}

function describeFsError(error: unknown): string {
	const code = (error as NodeJS.ErrnoException)?.code;
	const message = error instanceof Error ? error.message : String(error);
	return code ? `${code} ${message}` : message;
}

export function isLoopbackAddress(remoteAddress: string | undefined): boolean {
	if (!remoteAddress) return false;
	const ip = remoteAddress.trim().toLowerCase();
	if (LOOPBACK.has(ip)) return true;
	if (ip === "127.0.0.1" || ip.startsWith("127.")) return true;
	if (ip.startsWith("::ffff:127.")) return true;
	return false;
}

export function tokenWarning(token: string): string {
	if (!token) return "";
	if (token.length < 8) return "口令短于 8 字符，局域网暴露时建议更长。";
	return "";
}
