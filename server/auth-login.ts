/**
 * 未登录页（`server/unauthorized-page.ts`）的登录表单后端契约。
 *
 * 口令表单走**原生 POST 提交**（而不是 JS 拼 `?token=` 再跳转），浏览器密码
 * 管理器（Chrome / Safari / Firefox）只在这两种条件下弹出「是否保存密码」：
 *   1. 表单里有 `autocomplete="username"` 的账号域 + `autocomplete="current-password"` 的密码域；
 *   2. 提交被浏览器识别为一次真实导航（POST → 3xx → GET）。
 * JS 里 `preventDefault()` + `location.href = "?token=…"` 两条都不满足，所以永远不弹。
 *
 * 安全约束（改这里前先读）：
 * - 回跳地址只允许**同源绝对路径**，禁 `//host`、禁 `\`、禁控制字符（避免开放重定向）；
 * - 回跳地址必须剔除 `token` 等口令参数（避免口令经 Location 头/历史记录外泄）；
 * - 校验仍是常量时间比较（调用方传入 `sameSecret`），本模块不碰 AUTH_TOKEN。
 */
export const AUTH_LOGIN_PATH = "/__pi/auth";
export const AUTH_ERROR_PARAM = "auth_error";

const STRIP_PARAMS = ["token", "__tried_cached_token", AUTH_ERROR_PARAM];

/** 清洗登录成功后的回跳目标：只允许同源路径，且剔除口令相关查询参数。 */
export function sanitizeNextPath(raw: unknown): string {
	if (typeof raw !== "string") return "/";
	const value = raw.trim();
	if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
	// 控制字符（含 `\0`/换行）一律拒绝
	if (/[\u0000-\u001f\u007f]/.test(value)) return "/";
	try {
		const url = new URL(value, "http://pi-web-ui.invalid");
		for (const key of STRIP_PARAMS) url.searchParams.delete(key);
		const path = `${url.pathname}${url.search}${url.hash}`;
		return path.startsWith("/") && !path.startsWith("//") ? path : "/";
	} catch {
		return "/";
	}
}

/** 登录失败后的回跳地址：回到原目标并带上失败标记，由未登录页渲染错误提示。 */
export function loginFailureLocation(next: unknown): string {
	const path = sanitizeNextPath(next);
	const url = new URL(path, "http://pi-web-ui.invalid");
	url.searchParams.set(AUTH_ERROR_PARAM, "1");
	return `${url.pathname}${url.search}${url.hash}`;
}
