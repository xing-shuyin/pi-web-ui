/**
 * Windows 下从「没有控制台」的进程（Electron 主进程、`ELECTRON_RUN_AS_NODE` 起的 server/插件作业、
 * 被 GUI 拉起的 CLI）spawn 控制台程序时，系统会给子进程**新建一个控制台窗口** —— 用户看到的就是
 * 装插件时 git 黑窗闪一下。Node 的 `windowsHide: true` 关掉的就是这扇窗，但它是个「每个调用点都得写」
 * 的逐点开关，漏一处就回归（POSIX 上又是纯 no-op）。
 *
 * 这里把它收敛成一个进程级开关：**在三个进程根各 import 一次**（`server/index.ts`、`bin/pi-web-ui.mjs`、
 * `desktop/main.ts`），之后所有 `spawn` / `spawnSync` / `exec` / `execSync` / `execFile` / `execFileSync` /
 * `fork` 调用（含宿主内经 `import()` 加载的插件代码）自动带 `windowsHide: true`，调用点不必再逐个写。
 *
 * 三条边界：
 * - **只在 Windows 生效**：其他平台的 `windowsHide` 无意义，装上去只会干扰排查。
 * - **显式优先**：调用点自己传了 `windowsHide: false` 的照旧生效（确实需要可见终端的场景用这个逃生口）。
 * - **`PI_WEB_SHOW_CONSOLE=1` 全局关掉本开关**：排查「某子进程在隐藏控制台下行为异常」时用。
 *
 * `bin/lib/hide-console-windows.mjs` 是本文件编译产物的镜像（CLI 不能 import TS），
 * 由 `npm run gen:bin-mirrors` 生成、`tests/unit/bin-mirror.test.ts` 守卫漂移。
 */
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";

const INSTALLED = Symbol.for("pi-web-ui.hide-console-windows");
const PATCHED = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"] as const;

/**
 * 把一次子进程调用的参数补成「隐藏控制台」版本：
 * - `(cmd, options)` / `(cmd, args, options)` 两种形状都能认（`exec`/`execSync` 的第二参就是 options），
 * - options 已存在则合并（调用点显式传的 `windowsHide` 覆盖我们的默认值），
 * - options 位置是回调函数或根本没有，则把默认 options 插进去。
 */
export function hiddenConsoleArgs(name: string, args: readonly unknown[]): unknown[] {
	const result = [...args];
	const index = name === "exec" || name === "execSync" ? 1 : Array.isArray(result[1]) ? 2 : 1;
	const options = result[index];
	if (options !== null && typeof options === "object") result[index] = { windowsHide: true, ...options };
	else result.splice(index, options == null ? 1 : 0, { windowsHide: true });
	return result;
}

export type SpawnLike = ((...a: unknown[]) => unknown) & {
	[promisify.custom]?: (...a: unknown[]) => unknown;
};

/** 把一个子进程 API 换成「总是带 windowsHide」的版本（保留 promisify.custom，否则 `promisify(execFile)` 会退回回调式）。 */
export function wrapForHiddenConsole(apiName: string, original: SpawnLike): SpawnLike {
	const wrapped: SpawnLike = function (this: unknown, ...args: unknown[]): unknown {
		return Reflect.apply(original, this, hiddenConsoleArgs(apiName, args));
	};
	const promisified = original[promisify.custom];
	if (typeof promisified === "function") {
		wrapped[promisify.custom] = function (this: unknown, ...args: unknown[]): unknown {
			return Reflect.apply(promisified, this, hiddenConsoleArgs(apiName, args));
		};
	}
	return wrapped;
}

/** 装上进程级「不弹控制台」开关；返回本次是否真的装上了（已装过 / 非 Windows 返回 false）。 */
export function hideConsoleWindows(): boolean {
	if (process.platform !== "win32") return false;
	const api = childProcess as unknown as Record<string, SpawnLike> & Record<symbol, boolean>;
	if (api[INSTALLED]) return false;
	Object.defineProperty(childProcess, INSTALLED, { value: true });
	for (const name of PATCHED) {
		const original = api[name];
		if (typeof original !== "function") continue;
		api[name] = wrapForHiddenConsole(name, original);
	}
	syncBuiltinESMExports();
	return true;
}

if (process.platform === "win32" && process.env.PI_WEB_SHOW_CONSOLE !== "1") hideConsoleWindows();
