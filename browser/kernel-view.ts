/**
 * 内核状态的**渲染层**文案单源（壳的设置面板 + 未来设备页共用）。
 *
 * 状态从哪来（外壳判定 / `/api/health`）是 `desktop/kernel-mode.ts` 的事；
 * 这里只管"怎么把事实说成一句人话"，免得主进程和面板各写一套措辞。
 */
import type { BrowserKernelState } from "./contracts.js";

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
	if (state.mode === "external") return "连的是外部内核：关掉本窗口不影响它，但请确认它自己常驻。";
	return "当前内核随本窗口退出而停止：定时任务与 QQ 等渠道会一起停。";
}
