import { isLoopbackHost } from "./host-guard.js";

export interface StartupBannerParams {
	port: number;
	host: string;
	token?: string;
	cwd: string;
	sessionDir: string;
	version: string;
	sdkNote?: string | null;
}

/**
 * 计算服务对外展示的主入口 URL。
 * - 当配置了 token 时，自动追加 `/?token=...`，确保用户从控制台或脚本直达 Web 界面并完成认证；
 * - 回环地址与 0.0.0.0 归一化为 localhost，保证浏览器直接点击可达。
 */
export function buildMainUrl(port: number, host: string, token?: string): string {
	const trimmedToken = token?.trim() ?? "";
	const urlHost = isLoopbackHost(host) || host === "0.0.0.0" ? "localhost" : host;
	const tokenQuery = trimmedToken ? `/?token=${encodeURIComponent(trimmedToken)}` : "";
	return `http://${urlHost}:${port}${tokenQuery}`;
}

/**
 * 格式化启动横幅日志文本行列表。
 */
export function formatStartupBannerLines(params: StartupBannerParams): string[] {
	const mainUrl = buildMainUrl(params.port, params.host, params.token);
	const lines = [
		"",
		"  ⚡ pi-web-ui — web chat for the pi coding agent",
		`    ${mainUrl}`,
		`    workspace   : ${params.cwd}`,
		`    session dir : ${params.sessionDir}`,
		`    pi SDK      : v${params.version}`,
	];
	if (params.sdkNote) {
		lines.push(`    pi SDK note : ${params.sdkNote}`);
	}
	lines.push(`    bind        : ${params.host}:${params.port}`);
	if (params.token?.trim()) {
		lines.push(`    token       : ${params.token.trim()}`);
	}
	lines.push(`    setup       : http://127.0.0.1:${params.port}/setup （仅本机：配 token/监听/白名单）`);
	return lines;
}
