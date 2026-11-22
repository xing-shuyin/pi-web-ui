/**
 * 出口三：**系统外壳委派**——把路径交给操作系统的桌面外壳（资源管理器 / 访达 / 桌面默认应用）。
 *
 * 为什么不走 `spawnChild`：那个出口是「常驻 / 受监护子进程」——我们拥有它的生命周期、收场必须
 * `stop()` 杀整棵进程树、且**总是 `windowsHide: true`**。这里发生的是**委派**：动作真正的发起者是目标
 * 外壳，我们起的进程只是「发给桌面外壳的一条消息」，火并即忘、永不收回，也没有任何可等待的回执。
 *
 * 所以本模块的 `windowsHide` 必须是 `false`，理由不是「怕弹黑窗」而是相反：Windows 上
 * `windowsHide: true` 会给子进程带 `STARTF_USESHOWWINDOW + SW_HIDE`（libuv `src/win/process.c` 的
 * `UV_PROCESS_WINDOWS_HIDE` 分支）。`explorer.exe` 收到 `/n,<dir>` 后把请求转交给已在运行的 shell
 * 去建窗口，新窗口**沿用这条隐藏的 show 状态** —— 用户看到的是「点了没反应」，而窗口其实存在
 * （`IsWindowVisible = false`，还会越积越多）。把这条委派塞进 `spawnChild` 就是这个后果（#960）。
 *
 * 三条边界：
 * - **不复用监护策略**：不建进程组、不注入 `NO_COLOR`、不返回 `stop()`（杀 explorer 毫无意义）。
 * - **`windowsHide: false` 是语义而不是疏忽**：POSIX 上它是 no-op，写出来是把「窗口才是产品」钉在代码里；
 *   显式值会压过进程级开关（`shared/hide-console-windows.ts` 的 `{ windowsHide: true, ...options }`），
 *   所以在装了那个开关的进程里也照样可见。
 * - **平台 argv 表只在这里**：调用方不要自己拼 `explorer.exe /select,` 之类，也不要再判断 `process.platform`。
 */
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { dirname } from "node:path";

/** 实际被委派的外壳：调用方拿它选提示文案，不必重复判断平台。 */
export type ShellName = "explorer" | "finder" | "xdg-open";

export interface ShellLaunch {
	cmd: string;
	args: string[];
	shell: ShellName;
}

export interface ShellLaunchResult {
	ok: boolean;
	/** `ok === false` 时的原因（直接进用户可见的失败提示）。 */
	reason?: string;
}

/**
 * 「在文件管理器中显示某个路径」的平台 argv。
 * `xdg-open` 没有「选中某个文件」的通用语义，文件退化成打开所在目录（与 0.120.0 行为一致）。
 */
export function revealArgv(absPath: string, isDir: boolean, platform: NodeJS.Platform = process.platform): ShellLaunch {
	if (platform === "win32")
		return { cmd: "explorer.exe", args: isDir ? ["/n,", absPath] : ["/select,", absPath], shell: "explorer" };
	if (platform === "darwin") return { cmd: "open", args: isDir ? [absPath] : ["-R", absPath], shell: "finder" };
	return { cmd: "xdg-open", args: [isDir ? absPath : dirname(absPath)], shell: "xdg-open" };
}

/** 「用系统默认应用打开某个文件」的平台 argv。 */
export function openArgv(absPath: string, platform: NodeJS.Platform = process.platform): ShellLaunch {
	if (platform === "win32") return { cmd: "explorer.exe", args: [absPath], shell: "explorer" };
	if (platform === "darwin") return { cmd: "open", args: [absPath], shell: "finder" };
	return { cmd: "xdg-open", args: [absPath], shell: "xdg-open" };
}

export interface LaunchOptions {
	/** 等 `spawn` 事件的上限；超时按「已交出去」处理（外壳转发没有可观测回执，只能靠时序兜底）。 */
	timeoutMs?: number;
	/** 测试注入点；默认 `node:child_process` 的 `spawn`。 */
	spawnImpl?: (cmd: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
}

/**
 * 委派一次「交给系统外壳」。返回 `{ ok: false, reason }` 而不是抛错：失败要变成用户可见的提示，
 * 而不是静默（「进程起来了」不等于「外壳接受了」）。
 */
export async function launchShell(
	cmd: string,
	args: readonly string[],
	options: LaunchOptions = {},
): Promise<ShellLaunchResult> {
	const spawnImpl = options.spawnImpl ?? ((c: string, a: readonly string[], o: SpawnOptions) => spawn(c, [...a], o));
	let child: ChildProcess;
	try {
		child = spawnImpl(cmd, args, { detached: true, stdio: "ignore", windowsHide: false });
	} catch (e) {
		return { ok: false, reason: (e as Error).message };
	}
	try {
		child.unref();
	} catch {}
	return new Promise<ShellLaunchResult>((resolve) => {
		let settled = false;
		let timer: NodeJS.Timeout | undefined;
		const settle = (result: ShellLaunchResult) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve(result);
		};
		child.once("spawn", () => settle({ ok: true }));
		child.once("error", (e) => settle({ ok: false, reason: e.message }));
		timer = setTimeout(() => settle({ ok: true }), options.timeoutMs ?? 3000);
		// 兜底定时器不该把进程留住：调用方等的是这次委派，不是一条 3 秒的尾巴。
		timer.unref?.();
	});
}
