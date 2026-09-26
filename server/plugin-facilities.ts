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
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import {
	readFile as fspReadFile,
	readdir as fspReaddir,
	rm as fspRm,
	mkdir as fspMkdir,
	writeFile as fspWriteFile,
	appendFile as fspAppendFile,
	stat as fspStat,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
// 与 plugin-project 共用同一套 realpath 越界复核（isInsideRoot / realPathOfNearest），
// 避免「同一个安全语义、两份实现」漂移。
import { isInsideRoot, realPathOfNearest } from "./plugin-project.js";

/** tmp+rename 原子写（错误由调用方隔离——插件设施的 IO 一律尽力而为）。 */
function atomicWrite(file: string, data: string): void {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	writeFileSync(tmp, data);
	renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// storage.json 的进程内「读-改-写」互斥
// ---------------------------------------------------------------------------

/** 按文件路径的 RMW 互斥链（key = resolve 后的绝对路径）。 */
const rmwChains = new Map<string, Promise<unknown>>();

/**
 * 进程内「读-改-写」互斥（按文件路径的 promise 链锁）。
 *
 * storage.json 有两个读-改-写者：PluginStorage（插件 KV）与宿主 settings 面板的
 * saveSettingsValues（plugins.ts，直写同一文件的 settings 键）。两段 RMW 必须互斥
 * —— 现在两段关键区都是同步的（单线程下本就不会交错），但只要将来任何一处把
 * 「读」和「写」之间插进 await，就会退回「旧快照整份回写、抹掉对方刚写的键」的
 * 丢更新。两处统一收进这把锁：
 *  - 空链 + 同步 fn：原地直跑（不引入微任务延迟，set() 后同步 get() 立即可见，
 *    语义与未加锁完全一致）；fn 若返回 promise（异步写者）则占住链尾，后续排队；
 *  - 链忙：挂到链尾串行（前一个成功/失败都放行下一个）。
 * Map 不主动清理：键数量 = 有 storage.json 的插件数，天然有界。
 */
export function withFileRmwLock<T>(file: string, fn: () => T): T | Promise<T> {
	const key = resolve(file);
	const prev = rmwChains.get(key);
	if (prev) {
		const queued = prev.then(fn, fn) as Promise<T>;
		rmwChains.set(
			key,
			queued.then(
				() => undefined,
				() => undefined,
			),
		);
		return queued;
	}
	const result = fn();
	if (result instanceof Promise) {
		const tail = result.then(
			() => undefined,
			() => undefined,
		);
		rmwChains.set(key, tail);
		void tail.then(() => {
			if (rmwChains.get(key) === tail) rmwChains.delete(key);
		});
	}
	return result;
}

// ---------------------------------------------------------------------------
// storage
// ---------------------------------------------------------------------------

/** 每插件的 JSON 文件 KV。所有方法同步（数据量小，避免并发写乱序）。
 *
 * 缓存按文件 mtimeMs 失效（而非「首次读入后永不失效」）：storage.json 有两个
 * 写入者 —— 本类，以及宿主 settings 面板的 saveSettingsValues（直写磁盘的
 * settings 键，不经过本缓存）。插件长轮询里每隔几秒就 store.set("cursor", …)
 * 一次，若缓存永不失效，set() 会把整份旧快照回写，把面板刚保存的 settings
 * 抹掉 —— 表现为「设置重启即丢」。mtime 失效让下一次 load() 重读，两个写入者
 * 各自保留自己的键。 */
export class PluginStorage {
	private cache: Record<string, unknown> | undefined;
	/** 缓存对应的文件 mtimeMs（undefined = 文件尚不存在或不可 stat）。 */
	private cacheMtimeMs: number | undefined;
	constructor(private readonly file: string) {}

	private mtime(): number | undefined {
		try {
			return statSync(this.file).mtimeMs;
		} catch {
			return undefined; // 不存在 / 不可 stat
		}
	}

	/** 从磁盘重读（不存在 / 损坏 = 空表）并同步缓存与 mtime。 */
	private readFromDisk(mtimeMs: number | undefined = this.mtime()): Record<string, unknown> {
		let parsed: Record<string, unknown> = {};
		if (mtimeMs !== undefined) {
			try {
				const raw = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
				if (raw && typeof raw === "object") parsed = raw as Record<string, unknown>;
			} catch {
				parsed = {}; // 损坏 = 空表（不致命，重新积累）
			}
		}
		this.cache = parsed;
		this.cacheMtimeMs = mtimeMs;
		return parsed;
	}

	private load(): Record<string, unknown> {
		const mtimeMs = this.mtime();
		if (this.cache && this.cacheMtimeMs === mtimeMs) return this.cache;
		return this.readFromDisk(mtimeMs);
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
		// 与宿主 saveSettingsValues 同一把按文件路径的 RMW 锁（见 withFileRmwLock）：
		// 两段「读-改-写」互斥，谁也不会拿旧快照抹掉对方刚写的键。当前关键区是同步的
		// （空链直跑），set() 后同步 get() 立即可见，行为与未加锁一致。
		void withFileRmwLock(this.file, () => {
			// 写前必重读磁盘：宿主 settings 面板的 saveSettingsValues 直写同一文件的
			// settings 键（不经过本缓存），拿旧快照整份回写会把它抹掉。写是低频路径，
			// 重读的代价可忽略；mtime 粒度即使同毫秒也抹不掉（这里是无条件重读）。
			const store = this.readFromDisk();
			store[key] = value;
			try {
				atomicWrite(this.file, JSON.stringify(store));
			} catch (err) {
				console.error(`[plugin-storage] 写入失败 (${this.file}):`, err);
			}
		});
	}

	delete(key: string): void {
		// 同 set：写前重读 + RMW 锁，不拿旧快照回写。
		void withFileRmwLock(this.file, () => {
			const store = this.readFromDisk();
			if (!(key in store)) return;
			delete store[key];
			try {
				atomicWrite(this.file, JSON.stringify(store));
			} catch (err) {
				console.error(`[plugin-storage] 写入失败 (${this.file}):`, err);
			}
		});
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

/** 读或创建全局密钥文件（懒加载一次）。
 *
 * 曾有一个 bug：`readFileSync` 拿到的缓冲直接 `.toString("hex")`（把 hex 文本
 * 又做了一次 hex 编码），导致重启后 key 变成 65 字节，AES-256-GCM 全线报
 * "Invalid key length”。此处按 UTF-8 读 hex 文本再解码，并校验 32 字节——
 * 长度不对即视为损坏，重新生成（旧 secrets.bin 用旧 key 解不开→按 fail closed
 * 丢弃，总比所有机密操作全炸好；见 tests/unit/plugin-facilities.test.ts 回归）。 */
function loadOrCreateKey(dataDir: string): Buffer {
	const keyFile = join(dataDir, "secrets.key");
	try {
		if (existsSync(keyFile)) {
			const loaded = Buffer.from(readFileSync(keyFile, "utf8").trim(), "hex");
			if (loaded.length === 32) return loaded;
			console.warn(`[secrets] ${keyFile} 长度异常（${loaded.length} 字节），重新生成密钥（旧机密将不可读）`);
		}
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

	/** 同一密文文件的跨实例共享缓存（按绝对路径）：设置面板的保存与插件运行时的
	 *  读取走的是两个实例（savePluginSettings 现场 new，host 闭包里一个），实例级缓存
	 *  会让“刚保存完立刻 getSettings”读到旧值。共享后同进程内永远一致；文件被删
	 *  （卸载插件）时重置，避免重装同 id 读到旧机密。 */
	private static shared = new Map<string, SecretFile>();

	private load(): SecretFile {
		if (this.store) return this.store;
		const hit = PluginSecrets.shared.get(this.file);
		if (hit && existsSync(this.file)) {
			this.store = hit;
			return hit;
		}
		try {
			const parsed = JSON.parse(readFileSync(this.file, "utf8")) as SecretFile;
			this.store =
				parsed && parsed.v === 1 && parsed.items && typeof parsed.items === "object" ? parsed : { v: 1, items: {} };
		} catch {
			this.store = { v: 1, items: {} };
		}
		PluginSecrets.shared.set(this.file, this.store);
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

/** spec（`name` / `name@range` / `@scope/name@range`）→ 裸包名。
 *  require.resolve 不认 `@版本号` 后缀（`foo@1.2.3` 会被当成字面目录名，
 *  恒判缺失 → 带版本 pin 的 ensureDeps 永远装完还报缺，voice-input 踩过）。
 *  非标准形状（URL / 本地路径 / tag）原样返回，resolve 失败即判缺失，行为不变。
 *  纯函数，单测覆盖。 */
export function depName(spec: string): string {
	const m = /^(?:(@[^/\s]+\/[^/\s@]+)|([^/\s@:.]+))(?:@[^/\s]*)?$/.exec(str(spec));
	if (!m) return spec;
	return m[1] ?? m[2] ?? spec;
}

function str(v: unknown): string {
	return typeof v === "string" ? v.trim() : "";
}

/** 纯包名（`foo` / `@scope/foo`）：能按 `node_modules/<name>/package.json` 判盘。
 *  `node:path`、URL、相对/绝对路径、git spec 一律 false（交给 resolve 判）。 */
function isPlainPackageName(name: string): boolean {
	return /^(?:@[a-z\d](?:[a-z\d._-]*[a-z\d])?\/)?[a-z\d](?:[a-z\d._-]*[a-z\d])?$/i.test(name);
}

/** 从 fromDir 沿目录树向上找 `node_modules/<name>/package.json` 是否已落盘。 */
function depOnDisk(fromDir: string, name: string): boolean {
	let dir = fromDir;
	for (;;) {
		try {
			if (existsSync(join(dir, "node_modules", ...name.split("/"), "package.json"))) return true;
		} catch {
			/* 权限/坏路径：当作这一层没有，继续往上找 */
		}
		const up = dirname(dir);
		if (!up || up === dir) return false;
		dir = up;
	}
}

/** 从插件目录出发能否解析到这个模块（模拟插件自身 import() 的查找链）。
 *
 *  resolve 失败后再看一眼「文件是否已落盘」，这不是冗余判据而是**修 bug**（issue #383）：
 *  Node 的 CJS 解析会把 `node_modules/<pkg>/package.json` 不存在的**负结果**缓存在
 *  进程内存里（packageJsonReader 的路径缓存）。于是「探测缺失 → npm install 成功 →
 *  复查」这组三连里，最后一次复查永远命中那条负缓存，恒抛
 *  `Cannot find module`，用户看到的是「装成功了却报 npm install 没跑通」，
 *  且非重启整个进程不能恢复。落盘判据不碰 CJS 缓存，天然免疫。
 *
 *  顺序保持「先 resolve 后判盘」：解析成功仍然是最强的信号（含 exports 映射等
 *  盘上判据覆盖不到的形状），判盘只是给解析的假阴性兜底，不会放宽真缺失。 */
export function isDepAvailable(pluginDir: string, spec: string): boolean {
	const name = depName(spec);
	try {
		createRequire(join(pluginDir, "index.mjs")).resolve(name);
		return true;
	} catch {
		return isPlainPackageName(name) && depOnDisk(pluginDir, name);
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

/** host.fs.stat 返回的文件元信息（size/mtime 供插件做同步/缓存判断）。 */
export interface WsStat {
	name: string;
	type: "file" | "dir";
	/** 字节数（目录为 0）。 */
	size: number;
	/** 修改时间毫秒时间戳（取不到为 0）。 */
	mtime: number;
}

/** 深度/条数护栏：glob 递归遍历与结果都封顶，防大仓库扫爆内存。 */
const GLOB_MAX_WALK = 2000;
const GLOB_MAX_RESULTS = 500;

/** 极简 glob 转 RegExp：只支持 `*`（单段任意）/`?`（单字符）/`**`（跨段任意）。
 *  纯函数，单测覆盖。 */
export function globToRegExp(pattern: string): RegExp {
	const src = String(pattern ?? "")
		.trim()
		.replace(/\\/g, "/");
	let re = "";
	for (let i = 0; i < src.length; i++) {
		const c = src[i];
		if (c === "*") {
			if (src[i + 1] === "*") {
				// `**`：跨段；`/**/` 整体可省（根下也命中）。
				if (src[i + 2] === "/") {
					re += "(?:.*/)?";
					i += 2;
				} else {
					re += ".*";
					i += 1;
				}
			} else {
				re += "[^/]*";
			}
		} else if (c === "?") {
			re += "[^/]";
		} else {
			re += c.replace(/[.+^${}()|[\]\\]/, (m) => `\\${m}`);
		}
	}
	return new RegExp(`^${re}$`);
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

	/**
	 * 写类操作（write/append/mkdir/remove）的 realpath 复核：abs() 是纯字符串
	 * 比较，工作区里的符号链接/junction 能把写入（或递归删除）引到工作区之外。
	 * 取目标最近已存在祖先的 realpath，复核它仍在「活根」的 realpath 内。
	 * 读/list/stat/glob 保持字符串校验（高频路径；读不存在「把内容写到别处」
	 * 的风险，性能优先 —— 有意的取舍）。
	 */
	private assertRealInsideRoot(rel: unknown): void {
		const target = this.abs(rel); // 字符串越界先拒绝（错误文案不变）
		const targetReal = realPathOfNearest(target);
		if (!targetReal) throw new Error(`路径越界：无法解析真实路径 ${String(rel)}`);
		const rootDir = resolve(this.root());
		const rootReal = realPathOfNearest(rootDir) ?? rootDir;
		if (!isInsideRoot(rootReal, targetReal)) {
			throw new Error(`路径越界（符号链接指向工作区之外）：${String(rel)}`);
		}
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
		this.assertRealInsideRoot(relPath);
		const target = this.abs(relPath);
		await fspMkdir(dirname(target), { recursive: true });
		await fspWriteFile(target, data);
	}

	/** 追加写文件（日志/队列场景；父目录自动补；越界拒绝与 write 同口径）。 */
	async append(relPath: string, data: string | Uint8Array): Promise<void> {
		this.assertRealInsideRoot(relPath);
		const target = this.abs(relPath);
		await fspMkdir(dirname(target), { recursive: true });
		await fspAppendFile(target, data);
	}

	/** 建目录（递归；已存在幂等成功；越界拒绝与 write 同口径）。 */
	async mkdir(relDir: string): Promise<void> {
		this.assertRealInsideRoot(relDir);
		await fspMkdir(this.abs(relDir), { recursive: true });
	}

	/** 文件元信息（size/mtime 供同步/缓存判断；不存在抛错）。 */
	async stat(relPath: string): Promise<WsStat> {
		const target = this.abs(relPath);
		const st = await fspStat(target);
		const base =
			target
				.replace(/[/\\]+$/, "")
				.split("/")
				.pop() ?? String(relPath);
		return {
			name: base,
			type: st.isDirectory() ? "dir" : "file",
			size: st.isDirectory() ? 0 : st.size,
			mtime: Number(st.mtimeMs) || 0,
		};
	}

	/** 极简 glob 搜索（星号匹配如 `*.json`、双星匹配如 `foo/bar.md` 的父目录任意层）：
	 *  相对路径（`/` 分隔）按 pattern 过滤。walk 与结果双封顶，目录本身也参与
	 *  匹配（`docs*` 能命中目录）。只返回相对路径字符串，调用方再 read/stat。 */
	async glob(pattern: string, relDir = ""): Promise<string[]> {
		const pat = String(pattern ?? "")
			.trim()
			.replace(/\\/g, "/");
		if (!pat) throw new Error("glob: pattern 为空");
		const re = globToRegExp(pat);
		const base = this.abs(relDir);
		const out: string[] = [];
		const stack: string[] = [base];
		let walked = 0;
		while (stack.length && walked < GLOB_MAX_WALK && out.length < GLOB_MAX_RESULTS) {
			const dir = stack.pop()!;
			let ents;
			try {
				ents = await fspReaddir(dir, { withFileTypes: true });
			} catch {
				continue; // 无权限/中途删除：跳过该分支，不整单失败
			}
			for (const e of ents) {
				if (walked++ >= GLOB_MAX_WALK || out.length >= GLOB_MAX_RESULTS) break;
				const abs = join(dir, e.name);
				const rel = relative(base, abs).replace(/\\/g, "/");
				if (e.isDirectory()) {
					if (re.test(rel) || re.test(`${rel}/`)) out.push(rel);
					stack.push(abs);
				} else if (re.test(rel)) {
					out.push(rel);
				}
			}
		}
		return out;
	}

	/** 删除文件/目录（递归；只允许删工作区内的路径）。 */
	async remove(relPath: string): Promise<void> {
		// remove 同样做 realpath 复核：递归删除跟着目录链接走，比写文件更危险。
		this.assertRealInsideRoot(relPath);
		await fspRm(this.abs(relPath), { recursive: true, force: false });
	}
}

function sepOf(): string {
	return process.platform === "win32" ? "\\" : "/";
}
