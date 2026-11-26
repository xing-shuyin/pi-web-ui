/**
 * 「这份安装能不能提供界面」的唯一判据（细则见 `docs/architecture-kernel.md` §界面资源缺失）。
 *
 * 为什么必须单独一层：以前 index.ts 只看 `existsSync(web/dist)`，于是"目录在、入口没装"的
 * 半成品安装（Windows 上内核还在跑时执行 npm 更新，旧文件删不掉、新文件没落地，实机出现过）
 * 会被当成正常安装：进程照常起、`/api/health` 照常 ok，然后**每个页面请求都回 503
 * 「正在更新 pi-web-ui，请稍后刷新…」** —— 既没有在更新，也永远不会变，壳还把错误页当成了正常界面。
 *
 * 这里只做纯推导 + 一段自包含诊断页（诊断页不能依赖 web/dist 里的任何资源，因为缺的就是它）。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

/** 界面入口文件名（`express.static` 的默认 index 也是它）。 */
export const WEB_BUILD_ENTRY = "index.html";

/** 修复命令：与桌面端「升级内核」、文档里给用户的是同一条。 */
export const WEB_BUILD_REPAIR_COMMAND = "npm i -g keel-agent@latest";

/** 诊断页自动重试间隔（秒）：装包被补好后页面自己就该恢复，不需要用户理解发生了什么。 */
export const WEB_BUILD_RETRY_SECONDS = 3;

export type WebBuildReason =
	/** 整个 `web/dist` 目录不在：界面资源一个都没装上。 */
	| "missing-dir"
	/** 目录在但入口不在：装到一半（最常见）。 */
	| "missing-entry";

export type WebBuildState =
	{ ok: true; dir: string; entry: string } | { ok: false; dir: string; entry: string; reason: WebBuildReason };

/** 判定 `web/dist` 是否可用：**只认入口文件**，目录存在不算数。 */
export function resolveWebBuild(webDir: string): WebBuildState {
	const entry = join(webDir, WEB_BUILD_ENTRY);
	if (existsSync(entry)) return { ok: true, dir: webDir, entry };
	return { ok: false, dir: webDir, entry, reason: existsSync(webDir) ? "missing-entry" : "missing-dir" };
}

/** 缺什么（日志/健康检查/诊断页共用同一套措辞；`missing` 只给相对标签，不给本机路径）。 */
export function describeWebBuild(state: WebBuildState): string {
	if (state.ok) return "界面资源可用";
	return state.reason === "missing-dir"
		? "缺少 web/dist（界面资源没装上）"
		: "缺少 web/dist/index.html（界面入口没装上）";
}

/** 缺的那一项的相对路径：`/api/health` 是免鉴权端点，只给文件名不给本机路径。 */
export function missingWebBuildLabel(state: WebBuildState): string | null {
	if (state.ok) return null;
	return state.reason === "missing-dir" ? "web/dist" : "web/dist/index.html";
}

/** `/api/health.web`：客户端（桌面壳/手机/脚本）据此区分"内核活着"和"内核能提供界面"。 */
export type WebBuildHealth = { ok: true } | { ok: false; missing: string };

export function webBuildHealth(state: WebBuildState): WebBuildHealth {
	const missing = missingWebBuildLabel(state);
	return missing === null ? { ok: true } : { ok: false, missing };
}

function escapeHtml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface WebBuildDiagnosticInput {
	version: string;
	/** 安装形态（`server/kernel-identity.ts` 的 `classifyKernelInstall` 结果，已是中文）。 */
	installKind?: string;
	retrySeconds?: number;
	/** 这次判定的时间（页面上的"上次检查"）。 */
	now?: number;
}

/**
 * 自包含诊断页：说清"发生了什么、怎么修、多久重试一次"，而不是一句假的"正在更新"。
 * 内联样式、不引用任何外部资源（缺的正是 web/dist）；`<meta refresh>` 用当前 URL 重试，
 * 查询串（`?token=`）因此原样保留。
 */
export function webBuildDiagnosticHtml(state: WebBuildState, input: WebBuildDiagnosticInput): string {
	const retry = Math.max(1, Math.floor(input.retrySeconds ?? WEB_BUILD_RETRY_SECONDS));
	const missing = missingWebBuildLabel(state) ?? "web/dist/index.html";
	const checked = new Date(input.now ?? Date.now()).toLocaleTimeString("zh-CN", { hour12: false });
	const installKind = input.installKind ? `<li>安装形态：${escapeHtml(input.installKind)}</li>` : "";
	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${retry}">
<title>pi-web-ui 内核安装不完整</title>
<style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:14px/1.7 system-ui,-apple-system,"Segoe UI",sans-serif;background:#0f1116;color:#e6e8ee}
.card{max-width:640px;padding:28px 32px;border:1px solid #2a2c33;border-radius:12px;background:#161920}
h1{margin:0 0 12px;font-size:17px}
ul{margin:12px 0;padding-left:20px;color:#a9b0bd}
code{font-family:ui-monospace,Consolas,monospace;background:#1f2430;border:1px solid #2a2c33;border-radius:6px;padding:2px 6px;color:#e6e8ee}
pre{margin:10px 0;padding:12px 14px;background:#1f2430;border:1px solid #2a2c33;border-radius:8px;overflow:auto}
.fix{margin-top:16px}
.hint{margin-top:14px;color:#8b93a1;font-size:12px}
a{color:#5b8cff}
</style>
</head>
<body>
<div class="card">
<h1>内核在运行，但界面资源缺失：这份安装不完整</h1>
<p>当前缺失 <code>${escapeHtml(missing)}</code>，所以页面打不开。这通常发生在更新被打断时（内核还在跑，旧文件删不掉、新文件没落地）。</p>
<ul>
<li>内核版本：v${escapeHtml(input.version)}</li>${installKind}
</ul>
<p class="fix">修复：在终端执行下面的命令，然后重启内核（或重开桌面端）。</p>
<pre>${escapeHtml(WEB_BUILD_REPAIR_COMMAND)}</pre>
<p class="hint">本页每 ${retry} 秒自动重试一次，装好后会自动进入界面。<a href="">立即重试</a> · 上次检查 ${escapeHtml(checked)}</p>
</div>
</body>
</html>
`;
}
