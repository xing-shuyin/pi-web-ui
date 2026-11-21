/**
 * 从桌面壳「一键把当前内核装成系统服务」（细则见 `docs/architecture-kernel.md`）。
 *
 * 分工照抄仓库里已经跑通的同类实现 `server/device-center/hub-setup.ts`：
 * 渲染层只按按钮 → 主进程 spawn 本包 CLI（**不经 shell**）→ 拿结构化回执/退出码 → 面板刷新状态。
 * 这里只管"参数怎么拼"和"怎么起子进程"，不判断该不该装（那是 `kernel-mode.ts` 的事）。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface KernelServicePlanInput {
	port: number;
	dataDir: string;
	cwd: string;
	engine?: string | null;
	name?: string | null;
}

/** 服务名只允许 CLI 接受的那套字符（`bin/pi-web-ui.mjs` 的 serviceName 校验）。 */
export function normalizeServiceName(name: string | null | undefined): string | null {
	const trimmed = (name ?? "").trim();
	if (!trimmed) return null;
	return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(trimmed) ? trimmed : null;
}

/**
 * `server install` 的参数：端口/数据目录/工作目录一律取**当前内核正在用的那份**，
 * 这样"装成服务"之后用户看到的就是同一批会话、同一批插件配置，不需要再填表。
 */
export function buildServiceInstallArgs(input: KernelServicePlanInput): string[] {
	const args = ["server", "install", "--port", String(input.port), "--data-dir", input.dataDir, "--cwd", input.cwd];
	const name = normalizeServiceName(input.name);
	if (name) args.push("--name", name);
	const engine = (input.engine ?? "").trim();
	if (engine && engine !== "pi" && /^[a-z-]+$/.test(engine)) args.push("--engine", engine);
	return args;
}

/**
 * 生命周期动作的参数。
 * **必须带上 --data-dir / --port**：CLI 的 restart/stop 走数据目录里的控制通道，
 * 不带就默认指向 ~/.pi-web + 8787 —— 那会去重启"另一个内核"（或者什么都没发生）。
 * `start` 只认服务名（Windows 上就是启动那个 vbs 看门狗），多余的参数与默认值一致，不影响行为。
 */
export function buildServiceLifecycleArgs(
	action: "status" | "restart" | "stop" | "start",
	options: { name?: string | null; dataDir?: string; port?: number | null } = {},
): string[] {
	const args = ["server", action];
	if (typeof options.port === "number" && Number.isInteger(options.port) && options.port > 0)
		args.push("--port", String(options.port));
	if (options.dataDir?.trim()) args.push("--data-dir", options.dataDir.trim());
	const normalized = normalizeServiceName(options.name);
	if (normalized) args.push("--name", normalized);
	return args;
}

/** 本包 CLI 入口：与内核同一份代码，避免"壳版本里的 install 逻辑"和"内核版本"分叉。 */
export function kernelCliPath(pkgRoot: string): string {
	return join(pkgRoot, "bin", "pi-web-ui.mjs");
}

export interface KernelCliResult {
	code: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

const KERNEL_CLI_TIMEOUT_MS = 120_000;

/**
 * 跑一次内核 CLI。硬超时后连同子进程树一起杀（Windows 上 `server install` 会再拉 sudo/ps1，
 * 只杀直接子进程会留下孤儿），与 `hub-setup` 的 45s 兜底同一思路。
 */
export function runKernelCli(
	args: string[],
	options: {
		pkgRoot: string;
		nodePath?: string;
		timeoutMs?: number;
		spawnImpl?: typeof spawn;
	},
): Promise<KernelCliResult> {
	const cli = kernelCliPath(options.pkgRoot);
	if (!existsSync(cli)) {
		return Promise.resolve({
			code: -1,
			stdout: "",
			stderr: `找不到内核 CLI：${cli}`,
			timedOut: false,
		});
	}
	const spawnImpl = options.spawnImpl ?? spawn;
	const timeoutMs = options.timeoutMs ?? KERNEL_CLI_TIMEOUT_MS;
	return new Promise<KernelCliResult>((resolvePromise) => {
		const child = spawnImpl(options.nodePath ?? process.execPath, [cli, ...args], {
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", PI_WEB_LAUNCHED_BY: "desktop" },
			windowsHide: true,
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
		}, timeoutMs);
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout = (stdout + chunk.toString("utf8")).slice(-64 * 1024);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString("utf8")).slice(-64 * 1024);
		});
		child.on("error", (error: Error) => {
			stderr = `${stderr}\n${error.message}`;
			finish(-1);
		});
		child.on("close", (code: number | null) => finish(code ?? -1));
	});
}

/** 「安装为系统服务」该不该动手：判定集中在这里，main.ts 只负责按结论说话。 */
export type ServiceInstallDecision =
	| { kind: "install" }
	| { kind: "already"; supervisor: string; serviceName: string | null }
	| { kind: "terminal"; command: string }
	/** 连的是别人机器上的内核（external 且没有本机托管者）：本机不知道它的数据目录，装只会装错。 */
	| { kind: "foreign" };

export function decideServiceInstall(input: {
	mode: "external" | "local";
	supervisor: string | null;
	serviceName?: string | null;
	platform: NodeJS.Platform;
}): ServiceInstallDecision {
	if (input.mode === "external" && input.supervisor)
		return { kind: "already", supervisor: input.supervisor, serviceName: input.serviceName ?? null };
	// Linux 上装服务要写 /etc/systemd/system（root），GUI 里没有 TTY，sudo 必然失败 → 只给命令。
	if (input.platform === "linux") return { kind: "terminal", command: "pi-web-ui server install" };
	if (input.mode === "external") return { kind: "foreign" };
	return { kind: "install" };
}
