/**
 * 内核状态的**渲染层**文案单源（壳的设置面板 + 未来设备页共用）。
 *
 * 状态从哪来（外壳判定 / `/api/health`）是 `desktop/kernel-mode.ts` 的事；
 * 这里只管"怎么把事实说成一句人话"，免得主进程和面板各写一套措辞。
 */
import type { BrowserKernelState, KernelEnvironmentView } from "./contracts.js";

export function formatUptime(ms: number): string {
	const totalMinutes = Math.floor(ms / 60_000);
	if (totalMinutes < 1) return "不到 1 分钟";
	if (totalMinutes < 60) return `${totalMinutes} 分钟`;
	const hours = Math.floor(totalMinutes / 60);
	if (hours < 24) return `${hours} 小时 ${totalMinutes % 60} 分钟`;
	return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
}

/**
 * `v0.121.3 · 全局 npm 包 · systemd 托管 · 已运行 3 小时 7 分钟`。
 * 关键信息是**"关掉本窗口它还在不在"**，所以没有托管者时也要明说。
 */
export function describeKernelState(state: BrowserKernelState): string {
	const parts: string[] = [];
	if (state.version) parts.push(`v${state.version}`);
	if (state.installKind === "global-npm") parts.push("全局 npm 包");
	else if (state.installKind === "packaged") parts.push("桌面安装包内置");
	else if (state.installKind === "source") parts.push("源码");
	if (!state.reachable) parts.push("未连接");
	else if (state.supervisor) parts.push(`${state.supervisor} 托管`);
	else parts.push("独立进程");
	if (state.reachable && typeof state.uptimeMs === "number" && state.uptimeMs > 0)
		parts.push(`已运行 ${formatUptime(state.uptimeMs)}`);
	return parts.join(" · ");
}

/** 面板上的一句话结论：告诉用户"关掉壳之后还会不会跑"。 */
export function kernelPersistenceHint(state: BrowserKernelState): string {
	if (!state.reachable) return state.error ? `内核未连通：${state.error}` : "内核未连通";
	if (state.mode === "external" && state.supervisor)
		return "已由系统托管：关掉本窗口与浏览器，定时任务与渠道仍继续运行。";
	if (state.mode === "external")
		return "连的是外部内核：关掉本窗口不影响它，但请确认它自己常驻（重启请到它所在的机器上执行）。";
	return "当前内核随本窗口退出而停止：定时任务与 QQ 等渠道会一起停。";
}

/**
 * 壳能力的渲染层副本：必须等于 `desktop/runtime-config.ts` 的 `SHELL_CAPABILITY_VERSION`
 * （渲染层不许 import `desktop/**`，所以复制一份，并由 `kernel-panel-state.test.ts` 守住相等）。
 */
export const SHELL_CAPABILITY = 1;

/** Linux 上装服务要 root（systemd 系统单元）：GUI 里没有 TTY，只能把命令交给用户去终端跑。 */
export const KERNEL_LINUX_INSTALL_COMMAND = "pi-web-ui server install";

export interface KernelActions {
	install: { kind: "enabled" | "hidden" | "terminal"; command?: string };
	restart: { kind: "enabled" | "hidden" };
	/** 内核要求的最低壳能力高于本壳：先更新桌面应用，而不是继续点按钮。 */
	warning?: "min-shell-above";
}

/**
 * 按钮该不该给、给了能不能点。判定集中在这里，面板只负责渲染 ——
 * 否则"已托管还显示安装""Linux 上点了必然失败"这类事会各写一遍再各错一遍。
 */
export function kernelActions(input: {
	state: BrowserKernelState | null;
	platform: string;
	shellCapability: number;
}): KernelActions {
	const { state, platform, shellCapability } = input;
	const warning =
		state && typeof state.minShell === "number" && state.minShell > shellCapability ? "min-shell-above" : undefined;
	let install: KernelActions["install"] = { kind: "hidden" };
	if (state) {
		// 已经由系统托管 = 已经满足"关掉客户端也继续跑"，不需要再装一次。
		const supervised = state.mode === "external" && Boolean(state.supervisor);
		if (supervised) install = { kind: "hidden" };
		else if (platform === "linux") install = { kind: "terminal", command: KERNEL_LINUX_INSTALL_COMMAND };
		else if (platform === "darwin" || platform === "win32") install = { kind: "enabled" };
	}
	// 重启只对本壳自己拉起的 sidecar、或由系统托管的内核有意义；
	// 连的是别人的裸内核（external + 无托管者）时本壳没有任何手段重启它，点按钮只会白点。
	const canRestart = Boolean(state) && (state!.mode === "local" || Boolean(state!.supervisor));
	return { install, restart: { kind: canRestart ? "enabled" : "hidden" }, ...(warning ? { warning } : {}) };
}

/** 环境一行的摘要：`node v26.13.1 · 全局包 v0.121.3（可升到 0.121.4） · 服务配置：已安装`。 */
export function describeKernelEnvironment(env: KernelEnvironmentView | null): string {
	if (!env) return "";
	const parts: string[] = [];
	parts.push(env.node.ok ? `node v${env.node.version}` : "未检测到可用 node");
	const g = env.global;
	if (!g.installed) parts.push("未装全局包");
	else if (g.canUpgrade && g.latest && g.version) parts.push(`全局包 v${g.version} → v${g.latest}`);
	else parts.push(`全局包 v${g.version ?? "?"}`);
	parts.push(
		env.service.state === "installed"
			? "服务配置：已安装"
			: env.service.state === "absent"
				? "服务配置：未安装"
				: "服务配置：未知",
	);
	return parts.join(" · ");
}

/** 环境区两个按钮该不该出现：只在真能改善的时候给，点了没意义就不显示。 */
export function kernelEnvironmentActions(env: KernelEnvironmentView | null): {
	upgrade: boolean;
	installNode: boolean;
} {
	if (!env) return { upgrade: false, installNode: false };
	return { upgrade: env.global.canUpgrade, installNode: !env.node.ok && env.nodeInstall.canRun };
}

/**
 * 「升级内核」按钮该不该给：除了“注册表有新版”，还有一个更硬的理由——
 * **壳与内核协议不匹配**（纯壳包下两者独立安装，不匹配是常态）。
 * 只看注册表会把“本地包就是最新版、但与壳不兼容”这种情形藏成一个点不动的按钮。
 */
export function shouldOfferKernelUpgrade(
	env: KernelEnvironmentView | null,
	state: { compat?: { kind: string } } | null,
): boolean {
	const compat = state?.compat?.kind;
	if (compat === "upgrade-kernel" || compat === "unknown-kernel") return true;
	return kernelEnvironmentActions(env).upgrade;
}
