/**
 * 内核权威链（细则见 `docs/architecture-kernel.md` §9「还没做」的第一条）。
 *
 * 一个内核只能有一条"这份代码是官方当前版本"的权威链。历史上并存两条：
 * `<userData>/runtime`（签名清单自更新）和全局 npm 包 —— 于是出现"壳把内核更回旧版、
 * npm 那份已经更新"的分叉。本模块把取舍写死成一处：
 *
 *   npm-global（默认）  全局 npm 包是权威；`<userData>/runtime` 降级为离线兜底
 *   bundled-runtime     旧双层模型：运行时自更新是权威（保留开关，便于回退）
 *
 * 解析仍是"哪份最可信就跑哪份"，包内自带永远兜底（设计文档 §一.4 的那条活路）。
 * 纯函数 + 可注入存在性判断，方便单测。
 */
import { join, sep } from "node:path";

export type KernelSource = "global-npm" | "userdata-runtime" | "bundled";

export interface KernelResolution {
	source: KernelSource;
	entry: string;
}

export interface ResolveKernelEntryInput {
	/** 全局 npm 包根的 `dist/server/index.js`（本机没装则为 null）。 */
	globalEntry: string | null;
	/** `<userData>/runtime` 解析出来的入口（没有可用运行时则为 null）。 */
	runtimeEntry: string | null;
	/**
	 * 安装包自带的入口；纯壳包（`desktop/electron-builder.shell.yml`）里不存在 → null。
	 * 这是权威链的末端，null 表示“这台机器上没有任何内核”，由壳提示安装，而不是硬跑一份不存在的入口。
	 */
	bundledEntry: string | null;
}

/**
 * 优先级：全局 npm → 用户目录运行时（离线兜底）→ 包内自带；三者都没有 → `null`（需安装内核）。
 *
 * 为什么不把包内自带排前面：它随壳一起更新，而"内核与壳解耦"正是这套设计的目的；
 * 包内那份只在"这台机器没有任何其它内核"时兜底，保证永远能起来。
 * 纯壳包把这个兜底拿掉了：那时唯一能起来的前提是前面两档里有一档存在，否则必须让用户装（`kernel-authority.md` §纯壳包）。
 */
export function pickKernelSource(input: ResolveKernelEntryInput): KernelResolution | null {
	if (input.globalEntry) return { source: "global-npm", entry: input.globalEntry };
	if (input.runtimeEntry) return { source: "userdata-runtime", entry: input.runtimeEntry };
	if (input.bundledEntry) return { source: "bundled", entry: input.bundledEntry };
	return null;
}

/** 全局 npm 包根下的服务端入口。 */
export function globalKernelEntry(globalRoot: string): string {
	return [globalRoot, "dist", "server", "index.js"].join(sep);
}

/** 权威链缓存文件：`npm prefix -g` 要起子进程（几百毫秒），启动路径上不能每次都问。 */
export const AUTHORITY_CACHE_FILENAME = "kernel-authority.json";

/** 缓存有效期：一天。换了 node 版本/重装全局包最多晚一天被发现。 */
export const AUTHORITY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface AuthorityCache {
	npmPrefix: string;
	at: number;
}

export function buildAuthorityCache(npmPrefix: string, now: number): string {
	const payload: AuthorityCache = { npmPrefix, at: now };
	return `${JSON.stringify(payload)}\n`;
}

/** 读缓存：坏 JSON / 缺字段 / 过期 / 时钟倒流 一律当没有。 */
export function readAuthorityCache(raw: string | null, now: number, ttlMs = AUTHORITY_CACHE_TTL_MS): string | null {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as Partial<AuthorityCache>;
		if (typeof parsed.npmPrefix !== "string" || !parsed.npmPrefix.trim()) return null;
		if (typeof parsed.at !== "number" || !Number.isFinite(parsed.at)) return null;
		if (now < parsed.at || now - parsed.at > ttlMs) return null;
		return parsed.npmPrefix;
	} catch {
		return null;
	}
}

export function authorityCachePath(userDataDir: string): string {
	return join(userDataDir, AUTHORITY_CACHE_FILENAME);
}
