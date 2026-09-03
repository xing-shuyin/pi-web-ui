/**
 * 插件宿主设施：插件私有 KV 存储 + 加密 secrets，从 plugins.ts 抽出的纯设施。
 *
 * storage —— <pluginDir>/storage.json 单文件 JSON KV：
 *   - 全内存缓存、写入 tmp+rename 原子落盘（同 client-state.ts 的做法）；
 *   - 供插件存非敏感配置（窗口布局、上次选中项…），替代各家手搓的
 *     read/write config.json 样板；
 *   - 生命周期跟插件目录绑定（uninstall 即删除），跨升级保留。
 *
 * secrets —— AES-256-GCM 加密的机密存储（密码/API key/token）：
 *   - 密钥文件 <dataDir>/secrets.key（随机 32 字节，首次生成；chmod 0600 仅对
 *     POSIX 有意义，Windows 上 NTFS 权限继承用户目录默认 ACL）；
 *   - 密文文件随插件目录 <pluginDir>/secrets.bin——拷到别的机器因无密钥解不开
 *     （fail closed）；卸载插件即连密文一起删除；
 *   - 威胁模型：防「 casually 复制/查看文件」（混淆级保护）与「密文外泄」，
 *     不能防同一用户账号下的完整进程妥协——本地个人工具的合理折衷。
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import {
	readFile as fspReadFile,
	readdir as fspReaddir,
	rm as fspRm,
	mkdir as fspMkdir,
	writeFile as fspWriteFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

/** tmp+rename 原子写（错误由调用方隔离——插件设施的 IO 一律尽力而为）。 */
function atomicWrite(file: string, data: string): void {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	writeFileSync(tmp, data);
	renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// storage
// ---------------------------------------------------------------------------

/** 每插件的 JSON 文件 KV。所有方法同步（数据量小，避免并发写乱序）。 */
export class PluginStorage {
	private cache: Record<string, unknown> | undefined;
	constructor(private readonly file: string) {}

	private load(): Record<string, unknown> {
		if (this.cache) return this.cache;
		try {
			const parsed = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
			this.cache = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
		} catch {
			this.cache = {}; // 不存在/损坏 = 空表（损坏不致命，重新积累）
		}
		return this.cache;
	}

	get<T>(key: string, fallback?: T): T | undefined {
		const v = this.load()[key];
		return v === undefined ? fallback : (v as T);
	}

	all(): Record<string, unknown> {
		return { ...this.load() };
	}

	set(key: string, value: unknown): void {
		if (!key) throw new Error("storage.set: key 不能为空");
		const store = this.load();
		store[key] = value;
		try {
			atomicWrite(this.file, JSON.stringify(store));
		} catch (err) {
			console.error(`[plugin-storage] 写入失败 (${this.file}):`, err);
		}
	}

	delete(key: string): void {
		const store = this.load();
		if (!(key in store)) return;
		delete store[key];
		try {
			atomicWrite(this.file, JSON.stringify(store));
		} catch (err) {
			console.error(`[plugin-storage] 写入失败 (${this.file}):`, err);
		}
	}
}

// ---------------------------------------------------------------------------
// secrets
// ---------------------------------------------------------------------------

interface SealedBlob {
	iv: string;
	tag: string;
	ct: string;
}
type SecretFile = { v: 1; items: Record<string, SealedBlob> };

function seal(key: Buffer, plaintext: string): SealedBlob {
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
	return { iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex"), ct: ct.toString("hex") };
}

function unseal(key: Buffer, blob: SealedBlob): string {
	const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(blob.iv, "hex"));
	decipher.setAuthTag(Buffer.from(blob.tag, "hex"));
	return Buffer.concat([decipher.update(Buffer.from(blob.ct, "hex")), decipher.final()]).toString("utf8");
}

/** 读或创建全局密钥文件（懒加载一次）。 */
function loadOrCreateKey(dataDir: string): Buffer {
	const keyFile = join(dataDir, "secrets.key");
	try {
		if (existsSync(keyFile)) return Buffer.from(readFileSync(keyFile).toString("hex").trim(), "hex");
	} catch {
		/* fallthrough → regenerate */
	}
	const key = randomBytes(32);
	atomicWrite(keyFile, `${key.toString("hex")}\n`);
	try {
		chmodSync(keyFile, 0o600); // best-effort（win 无效，不抛错）
	} catch {}
	return key;
}

/** 每插件的加密 KV。所有方法同步；任何读写失败都静默回退（机密丢失优于崩进程）。 */
export class PluginSecrets {
	private store: SecretFile | undefined;
	private readonly file: string;

	constructor(dataDir: string, pluginDir: string) {
		this.file = join(pluginDir, "secrets.bin");
		this.key = PluginSecrets.keyFor(dataDir);
	}

	private key: Buffer;

	private static keys = new Map<string, Buffer>();
	/** 按 dataDir 惰性生成/复用密钥（同进程内共享，避免重复 IO）。 */
	static keyFor(dataDir: string): Buffer {
		let k = PluginSecrets.keys.get(dataDir);
		if (!k) {
			k = loadOrCreateKey(dataDir);
			PluginSecrets.keys.set(dataDir, k);
		}
		return k;
	}

	private load(): SecretFile {
		if (this.store) return this.store;
		try {
			const parsed = JSON.parse(readFileSync(this.file, "utf8")) as SecretFile;
			this.store =
				parsed && parsed.v === 1 && parsed.items && typeof parsed.items === "object" ? parsed : { v: 1, items: {} };
		} catch {
			this.store = { v: 1, items: {} };
		}
		return this.store;
	}

	set(name: string, value: string): void {
		if (!name) throw new Error("secrets.set: name 不能为空");
		const s = this.load();
		s.items[name] = seal(this.key, value);
		try {
			atomicWrite(this.file, JSON.stringify(s));
		} catch (err) {
			console.error("[plugin-secrets] 写入失败:", err);
		}
	}

	get(name: string): string | undefined {
		const blob = this.load().items[name];
		if (!blob) return undefined;
		try {
			return unseal(this.key, blob);
		} catch {
			return undefined; // 换机器 / 密钥轮换 → 解不开返回空（fail closed）
		}
	}

	has(name: string): boolean {
		return name in this.load().items;
	}

	delete(name: string): void {
		const s = this.load();
		if (!(name in s.items)) return;
		delete s.items[name];
		try {
			atomicWrite(this.file, JSON.stringify(s));
		} catch (err) {
			console.error("[plugin-secrets] 写入失败:", err);
		}
	}

	list(): string[] {
		return Object.keys(this.load().items);
	}
}

// ---------------------------------------------------------------------------
// deps（宿主代插件自动补装运行时依赖）
// ---------------------------------------------------------------------------

const DEP_TIMEOUT_MS = 180_000; // 慢网安装兜底（含第一次拉取包元数据）

/** 从插件目录出发能否解析到这个模块（模拟插件自身 import() 的查找链）。 */
export function isDepAvailable(pluginDir: string, spec: string): boolean {
	try {
		createRequire(join(pluginDir, "index.mjs")).resolve(spec);
		return true;
	} catch {
		return false;
	}
}

const depInstallLocks = new Map<string, Promise<boolean>>();

/** 确保依赖就绪：先逐个解析，缺了才一次性 `npm install` 补装，装完复查。
 *  返回 true = 全部可用；false = 安装失败或超时。同目录并发调用单飞合并。
 *
 *  这是 webmail / db-client / vscode-editor 三家手搓 ensureXxxMod 的上收——
 *  之前每家都自己拼 spawn 参数、自己处理 win32 的 npm.cmd、自己等 install 完成。 */
export function ensurePluginDeps(
	pluginDir: string,
	specs: string[],
	onProgress?: (msg: string) => void,
): Promise<boolean> {
	if (specs.length === 0) return Promise.resolve(true);
	const missing = specs.filter((s) => !isDepAvailable(pluginDir, s));
	if (missing.length === 0) return Promise.resolve(true);

	const lockKey = join(pluginDir, missing.sort().join("|"));
	const inflight = depInstallLocks.get(lockKey);
	if (inflight) return inflight;

	const run = async (): Promise<boolean> => {
		// 无 package.json 时 npm 会沿目录树向上找最近一个，可能把依赖装进父目录——
		// 先落一个最小 package.json 钉住安装位置。
		if (!existsSync(join(pluginDir, "package.json"))) {
			try {
				atomicWrite(
					join(pluginDir, "package.json"),
					JSON.stringify({ name: "plugin-runtime-deps", private: true }, null, 2),
				);
			} catch {}
		}
		onProgress?.(`正在安装依赖：${missing.join(", ")}…（首次约需几分钟）`);
		// win32 的 npm 是 .cmd——spawnSync 直接跑会被 EINVAL 拒绝，必须走 shell；
		// posix 不用 shell（路径不含空格假设成立，与宿主其它 spawn 一致）。
		const res = spawnSync(
			process.platform === "win32" ? "npm.cmd" : "npm",
			["install", "--no-audit", "--no-fund", ...missing],
			{ cwd: pluginDir, timeout: DEP_TIMEOUT_MS, shell: process.platform === "win32", encoding: "utf8" },
		);
		if (res.error || res.status !== 0) {
			console.error(`[plugin-deps] ${join(pluginDir)} npm install 失败:`, res.error ?? res.stderr?.slice(0, 500));
			return false;
		}
		const stillMissing = specs.filter((s) => !isDepAvailable(pluginDir, s));
		if (stillMissing.length) {
			console.error(`[plugin-deps] 安装完成但仍缺：${stillMissing.join(", ")}`);
			return false;
		}
		onProgress?.("依赖安装完成");
		return true;
	};
	const p = run().finally(() => depInstallLocks.delete(lockKey));
	depInstallLocks.set(lockKey, p);
	return p;
}

// ---------------------------------------------------------------------------
// WorkspaceFS —— 受限工作区文件访问（host.fs，能力 "fs" 门控）
//
// 与插件自己 import node:fs 的本质区别：路径解析永远锚定「当前工作区根」
// （活值，跟随主应用 set_cwd），越界一律拒绝。这是宿主能真正强制执行的那层。
// ---------------------------------------------------------------------------

/** host.fs.list 返回的目录条目。 */
export interface WsEntry {
	name: string;
	type: "file" | "dir";
}

export class WorkspaceFS {
	/** root 是活值 getter（返回当前工作区绝对路径），跟随 set_cwd。 */
	constructor(private readonly root: () => string) {}

	/** 相对路径 → 活根下的绝对路径；越界抛错。空串 = 根本身。 */
	private abs(rel: unknown): string {
		const rootDir = resolve(this.root());
		const target = resolve(rootDir, typeof rel === "string" ? rel : "");
		if (target !== rootDir && !target.startsWith(rootDir + sepOf())) {
			throw new Error(`路径越界：${String(rel)}`);
		}
		return target;
	}

	/** 单层目录列表（浅层；深度遍历请插件自行递归）。 */
	async list(relDir = ""): Promise<WsEntry[]> {
		try {
			const dirents = await fspReaddir(this.abs(relDir), { withFileTypes: true });
			return dirents
				.slice(0, 2000)
				.map((d) => ({ name: d.name, type: d.isDirectory() ? ("dir" as const) : ("file" as const) }));
		} catch (err) {
			throw new Error(`读取目录失败：${(err as Error).message}`);
		}
	}

	/** 读文件（二进制）。声明为 async：路径校验失败以 rejected promise 表达
	 * （非 async 版本会同步 throw，破坏调用方 .catch/.rejects 契约）。 */
	async read(relPath: string): Promise<Buffer> {
		return fspReadFile(this.abs(relPath));
	}

	/** 读文本（默认上限 512KB，超出截断——预览同款约定）。 */
	async readText(relPath: string, maxBytes = 512 * 1024): Promise<string> {
		const buf = await this.read(relPath);
		return buf.subarray(0, maxBytes).toString("utf8");
	}

	/** 写文件（自动补父目录；注意相对路径锚定当前项目——切换 cwd 后写进新项目）。 */
	async write(relPath: string, data: string | Uint8Array): Promise<void> {
		const target = this.abs(relPath);
		await fspMkdir(dirname(target), { recursive: true });
		await fspWriteFile(target, data);
	}

	/** 删除文件/目录（递归；只允许删工作区内的路径）。 */
	async remove(relPath: string): Promise<void> {
		await fspRm(this.abs(relPath), { recursive: true, force: false });
	}
}

function sepOf(): string {
	return process.platform === "win32" ? "\\" : "/";
}
