/**
 * PI_WEB_TOKEN 客户端配合逻辑。
 *
 * 服务端设置 PI_WEB_TOKEN 后，所有 HTTP/WS 请求必须携带口令。浏览器导航
 * 无法带自定义头，所以约定：首次经 `?token=xxx` 进入 → 存入 localStorage →
 * 从地址栏移除（避免链接分享/历史记录泄露）→ 之后所有请求统一追加查询参数，
 * 服务端同时下发 HttpOnly cookie 兜底后续导航。
 *
 * cookie 生命周期（服务端，见 server/index.ts）：每次请求携带有效 token 即把
 * cookie 刷新为当前 PI_WEB_TOKEN；服务端改口令后旧的失效 cookie 会在 401 时
 * 被自动清除——再经一次正确的 `?token=` 进入即永久恢复，不需手动清缓存。
 * 注意 `?token=` 仅负责引导建立 cookie；已建立后仅凭 cookie 即可导航，
 * 地址栏 token 自然不再产生可见作用（issue #71）。
 */
import { getMobileRuntime, isMobileServerUrl } from "./mobile-runtime";

const KEY = "pi-web-ui:token";

/** 应用启动时调用一次：吸收 URL 里的 ?token= 并清洗地址栏。 */
export function initAuthToken(): void {
	if (getMobileRuntime()) return;
	try {
		const url = new URL(window.location.href);
		const t = url.searchParams.get("token");
		if (t) {
			localStorage.setItem(KEY, t.trim());
			url.searchParams.delete("token");
			url.searchParams.delete("__tried_cached_token");
			window.history.replaceState(null, "", url.toString());
		}
	} catch {}
}

/** 当前持久化的 token（未设置时为空串）。 */
function authToken(): string {
	try {
		return localStorage.getItem(KEY) ?? "";
	} catch {
		return "";
	}
}

/** 给相对路径 URL 追加 token 查询参数（已带 query 的用 & 连接）。 */
export function withToken(url: string): string {
	const mobile = getMobileRuntime();
	if (mobile) {
		if (!mobile.token || !isMobileServerUrl(url)) return url;
		const authenticated = new URL(url);
		authenticated.searchParams.set("token", mobile.token);
		return authenticated.href;
	}
	const t = authToken();
	if (!t) return url;
	return `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(t)}`;
}
