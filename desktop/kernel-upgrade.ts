/**
 * 内核的「装 node / 升级全局包」能力（`docs/architecture-kernel.md` §9.2、§10）。
 *
 * 这里只做三件事，判断全在纯函数里、执行全走 `command-spawn`（不开 shell）：
 * 1. 版本比对（当前装的 vs 注册表最新）
 * 2. 生成要跑的命令（npm 全局升级 / 平台对应的 node 安装）
 * 3. 真跑一条命令并带硬超时
 *
 * 为什么升级要"命令 + 重启"两步：npm 只会换盘的代码，正在跑的内核不会自动换成新代码；
 * 重启交给 `kernel-install.ts`（服务托管 → 服务管理器重启；本地 → 杀重生）。
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { resolveCommandLaunch } from "../server/command-spawn.js";

/** 全局包里的 package.json 路径。 */
export function globalPackageManifestPath(globalRoot: string): string {
	return join(globalRoot, "package.json");
}

/** 从 package.json 文本里取版本；坏 JSON / 缺字段 → null（不抛）。 */
export function parsePackageVersion(raw: string | null): string | null {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as { name?: unknown; version?: unknown };
		if (parsed?.name !== "pi-web-ui") return null;
		return typeof parsed.version === "string" && parsed.version.trim() ? parsed.version.trim() : null;
	} catch {
		return null;
	}
}

/** 读盘版：包根下 package.json 的版本。 */
export function readGlobalPackageVersion(globalRoot: string): string | null {
	try {
		return parsePackageVersion(readFileSync(globalPackageManifestPath(globalRoot), "utf8"));
	} catch {
		return null;
	}
}

function toParts(version: string): number[] {
	return version
		.split("-")[0]!
		.split(".")
		.map((part) => Number.parseInt(part, 10))
		.map((n) => (Number.isFinite(n) ? n : 0));
}

/** 简化 semver 比较：只看数字段，预发布一律算更低（够用且没有依赖）。 */
export function compareVersions(a: string, b: string): number {
	const left = toParts(a);
	const right = toParts(b);
	const length = Math.max(left.length, right.length);
	for (let i = 0; i < length; i++) {
		const diff = (left[i] ?? 0) - (right[i] ?? 0);
		if (diff !== 0) return diff > 0 ? 1 : -1;
	}
	const aPre = a.includes("-");
	const bPre = b.includes("-");
	if (aPre === bPre) return 0;
	return aPre ? -1 : 1;
}

export type UpgradePlan =
	| { kind: "unknown"; reason: "no-current" | "no-latest" }
	| { kind: "up-to-date"; current: string }
	| { kind: "upgrade"; current: string; latest: string; command: string };

/** 该不该升级、升的时候跑哪条命令。 */
export function planUpgrade(input: { current: string | null; latest: string | null }): UpgradePlan {
	if (!input.current) return { kind: "unknown", reason: "no-current" };
	if (!input.latest) return { kind: "unknown", reason: "no-latest" };
	if (compareVersions(input.latest, input.current) <= 0) return { kind: "up-to-date", current: input.current };
	return {
		kind: "upgrade",
		current: input.current,
		latest: input.latest,
		command: "npm i -g pi-web-ui@latest",
	};
}

export const DEFAULT_REGISTRY_LATEST_URL = "https://registry.npmjs.org/pi-web-ui/latest";

/** 向 npm registry 问最新版本；超时/离线/坏 JSON 一律 null（UI 显示"未知"，不报错）。 */
export async function fetchLatestVersion(options: {
	url?: string;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
}): Promise<string | null> {
	const impl = options.fetchImpl ?? fetch;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5000);
	try {
		const response = await impl(options.url ?? DEFAULT_REGISTRY_LATEST_URL, { signal: controller.signal });
		if (!response.ok) return null;
		const body = (await response.json()) as { version?: unknown };
		return typeof body?.version === "string" && body.version.trim() ? body.version.trim() : null;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/** 把命令解析成可 spawn 的 argv（Windows 的 .cmd shim 由 command-spawn 单源还原成 `node <entry>`）。 */
export function resolveLaunch(
	command: string,
	args: readonly string[],
): { file: string; args: string[]; options: { windowsVerbatimArguments?: boolean } } {
	try {
		const launch = resolveCommandLaunch(command, args);
		return {
			file: launch.file,
			args: launch.args,
			// 丢掉这个标志，Node 会给 `cmd /d /s /c "..."` 再套一层引号，命令根本跑不起来（Windows 实测）。
			options: launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {},
		};
	} catch {
		return { file: command, args: [...args], options: {} };
	}
}

export interface CommandRunResult {
	code: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

/**
 * 跑一条命令（`npm` 的 Windows shim 由 `resolveCommandLaunch` 还原成 `node <entry>`）。
 * 硬超时到点杀进程；输出只留尾部 8KB，够面板报错用。
 */
export function runCommand(
	command: string,
	args: readonly string[],
	options: { timeoutMs?: number; spawnImpl?: typeof spawn; env?: NodeJS.ProcessEnv } = {},
): Promise<CommandRunResult> {
	const launch = resolveLaunch(command, args);
	const spawnImpl = options.spawnImpl ?? spawn;
	return new Promise<CommandRunResult>((resolvePromise) => {
		const child = spawnImpl(launch.file, launch.args, {
			stdio: ["ignore", "pipe", "pipe"],
			env: options.env ?? process.env,
			windowsHide: true,
			...launch.options,
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		let timedOut = false;
		const finish = (code: number): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolvePromise({ code, stdout, stderr, timedOut });
		};
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				child.kill("SIGKILL");
			} catch {}
			finish(-1);
		}, options.timeoutMs ?? 180_000);
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout = (stdout + chunk.toString("utf8")).slice(-8 * 1024);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString("utf8")).slice(-8 * 1024);
		});
		child.on("error", (error: Error) => {
			stderr = `${stderr}\n${error.message}`;
			finish(-1);
		});
		child.on("close", (code: number | null) => finish(code ?? -1));
	});
}

/**
 * 装 node 的可执行 argv（与 `kernel-env.ts` 的 `nodeInstallGuide` 文案一一对应）。
 * Linux 返回 null：那要 `sudo` + TTY，GUI 里必然失败，只能把命令交给用户。
 *
 * winget 是 Windows 的 AppExecutionAlias，可能不在 PATH 里、`findNativeCliExecutable` 也找不到；
 * 依次试几个已知落点，全都没有就退回裸 `winget`（由 `runCommand` 报出可读的 ENOENT）。
 */
export function nodeInstallLaunch(
	platform: NodeJS.Platform,
	options: { exists?: (path: string) => boolean; env?: NodeJS.ProcessEnv } = {},
): { command: string; args: string[] } | null {
	if (platform === "win32") {
		const env = options.env ?? process.env;
		const exists = options.exists ?? existsSync;
		const candidates = [
			join(env.LOCALAPPDATA ?? "", "Microsoft", "WindowsApps", "winget.exe"),
			join(env.ProgramFiles ?? "C:/Program Files", "WindowsApps", "winget.exe"),
		].filter((path) => path && exists(path));
		return {
			command: candidates[0] ?? "winget",
			args: ["install", "--id", "OpenJS.NodeJS.LTS", "-e", "--accept-package-agreements", "--accept-source-agreements"],
		};
	}
	if (platform === "darwin") return { command: "brew", args: ["install", "node@22"] };
	return null;
}
