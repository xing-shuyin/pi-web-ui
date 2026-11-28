import { isLoopbackHost } from "./host-guard.js";

export interface StartupBannerParams {
	port: number;
	host: string;
	/**
	 * 口令来源的**描述**（`env PI_WEB_TOKEN` / `file <path>` / `generated → <path>`）。
	 * 横幅永不打印口令本身（issue #969）：stdout 会进日志、CI、截图与工单。
	 */
	tokenSource?: string | null;
	cwd: string;
	sessionDir: string;
	version: string;
	sdkNote?: string | null;
	/** 内核形态行（“全局 npm 包 · systemd · 锁 held”），见 server/kernel-identity.ts。 */
	kernelNote?: string | null;
}

export function buildMainUrl(port: number, host: string): string {
	const urlHost = isLoopbackHost(host) || host === "0.0.0.0" ? "localhost" : host;
	return `http://${urlHost}:${port}`;
}

export function formatStartupBannerLines(params: StartupBannerParams): string[] {
	const mainUrl = buildMainUrl(params.port, params.host);
	const lines = [
		"",
		"  ⚡ keel — web chat for the pi coding agent",
		`    ${mainUrl}`,
		`    workspace   : ${params.cwd}`,
		`    session dir : ${params.sessionDir}`,
		`    pi SDK      : v${params.version}`,
	];
	if (params.sdkNote) {
		lines.push(`    pi SDK note : ${params.sdkNote}`);
	}
	lines.push(`    bind        : ${params.host}:${params.port}`);
	if (params.kernelNote) {
		lines.push(`    kernel      : ${params.kernelNote}`);
	}
	if (params.tokenSource?.trim()) {
		lines.push(`    token       : ${params.tokenSource.trim()}`);
	}
	lines.push(`    setup       : http://127.0.0.1:${params.port}/setup （仅本机：配 token/监听/白名单）`);
	return lines;
}
