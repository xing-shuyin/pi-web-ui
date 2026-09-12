/**
 * 扩展设置（纯逻辑：默认值 + 脏数据兜底 + 地址归一，可在单测里钉住）。
 *
 * 存储用 `chrome.storage.sync`（用户在 options 页改），读取一律过 `normalizeSettings` ——
 * 用户手输的地址、别处导入的旧配置都可能缺字段或类型不对，**绝不能因为一个错配置
 * 就让拾取整条链挂掉**（回落到默认值继续工作）。
 */

import { isDetailLevel, type DetailLevel } from "./contract.js";

export interface PickerSettings {
	/** pi-web-ui 服务地址（含协议，末尾不带 /）。 */
	serverUrl: string;
	/** PI_WEB_TOKEN（服务端开了口令时必填）。 */
	token: string;
	/** 默认详细度档位。 */
	detail: DetailLevel;
	/** 注入 pi-web-ui 输入框的同时，也把 Markdown 复制到剪贴板（兜底：注入失败时可以手贴）。 */
	copyToClipboard: boolean;
	/** 是否采集元素截图（走附件）。 */
	screenshots: boolean;
	/** 注入成功后是否把浏览器切到 pi-web-ui 标签页。 */
	focusTarget: boolean;
}

export const DEFAULT_SERVER_URL = "http://127.0.0.1:8787";

export const DEFAULT_SETTINGS: PickerSettings = {
	serverUrl: DEFAULT_SERVER_URL,
	token: "",
	detail: "standard",
	copyToClipboard: true,
	screenshots: true,
	focusTarget: false,
};

/**
 * 地址归一：
 * - 去首尾空白、补 `http://`（用户习惯只打 `localhost:8787`）；
 * - 去掉末尾斜杠（拼 `/ws` 之类时才不会出双斜杠）；
 * - 解析不出 origin 就回落到默认地址（宁可打不开也不要一个畸形 URL 到处传）。
 */
export function normalizeServerUrl(raw: unknown): string {
	const text = typeof raw === "string" ? raw.trim() : "";
	if (!text) return DEFAULT_SERVER_URL;
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
	try {
		const url = new URL(withScheme);
		if (!url.hostname) return DEFAULT_SERVER_URL;
		// 只保留 origin + 路径前缀（有些用户把 pi-web-ui 挂在子路径反代下）
		const path = url.pathname.replace(/\/+$/, "");
		return `${url.protocol}//${url.host}${path}`;
	} catch {
		return DEFAULT_SERVER_URL;
	}
}

/** 任意来源的对象 → 合法设置（缺项/类型错一律回落默认值）。 */
export function normalizeSettings(raw: unknown): PickerSettings {
	const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	return {
		serverUrl: normalizeServerUrl(src.serverUrl ?? DEFAULT_SETTINGS.serverUrl),
		token: typeof src.token === "string" ? src.token.trim() : DEFAULT_SETTINGS.token,
		detail: isDetailLevel(src.detail) ? src.detail : DEFAULT_SETTINGS.detail,
		copyToClipboard: bool(src.copyToClipboard, DEFAULT_SETTINGS.copyToClipboard),
		screenshots: bool(src.screenshots, DEFAULT_SETTINGS.screenshots),
		focusTarget: bool(src.focusTarget, DEFAULT_SETTINGS.focusTarget),
	};
}

function bool(v: unknown, fallback: boolean): boolean {
	return typeof v === "boolean" ? v : fallback;
}

/**
 * 该地址对应的 host 权限模式（`https://pi.example.com/*`）。
 *
 * 远程部署的关键：manifest 只预置了 localhost/127.0.0.1，其它地址必须由用户显式授权
 * （`chrome.permissions.request`）—— 否则 `chrome.tabs.query({url})` 的过滤会被**静默忽略**，
 * 返回一堆无关标签页，我们就可能把内容注入到别的页面上去。
 */
export function originPattern(rawUrl: string): string {
	try {
		return `${new URL(normalizeServerUrl(rawUrl)).origin}/*`;
	} catch {
		return `${DEFAULT_SERVER_URL}/*`;
	}
}

/**
 * 这个标签页是不是我们要找的 pi-web-ui（按地址前缀严格复核）。
 *
 * 为什么不能只信 `tabs.query({url})`：权限缺失时那个过滤条件会被忽略，返回全部标签页；
 * 只按「有 id 就算」挑第一个，会把内容注入到毫不相干的页面（比如你正在调试的站点本身）。
 * 子路径部署（`https://host/pi/`）也要认，但 `https://host/pi-other` 不算。
 */
export function tabMatchesBase(tabUrl: string | undefined, base: string): boolean {
	if (!tabUrl) return false;
	const normalized = normalizeServerUrl(base);
	if (tabUrl === normalized) return true;
	if (tabUrl.startsWith(`${normalized}/`)) return true;
	// 带查询串（?token=… 首次进入）也算同一个页面
	return tabUrl.startsWith(`${normalized}?`);
}

/** 拼服务端地址（子路径部署也能用；path 以 / 开头）。 */
export function serverUrl(settings: PickerSettings, path = "/"): string {
	const base = normalizeServerUrl(settings.serverUrl);
	const suffix = path.startsWith("/") ? path : `/${path}`;
	return `${base}${suffix}`;
}

/**
 * Chrome 的 match pattern 校验（够用版）。
 *
 * 为什么要有这个函数：`chrome.tabs.query({ url: [...] })` 的过滤器必须是合法 match pattern，
 * 而 **裸 origin（`http://localhost:8787`，没有路径）会被直接抛异常**
 * （`Invalid url pattern 'http://localhost:8787'`）。这个异常很容易被 catch 成「没找到页面」，
 * 于是「页明明开着但投不过去」—— 0.2.0 真的踩了这个坑（假 chrome 不校验模式，测试全绿）。
 *
 * 所以：所有要交给 chrome.* 的模式都过 `originPattern()`；而测试里的假 chrome 也用这个
 * 函数校验入参，把这类坑钉在单测里（见 tests/unit/page-picker*.test.ts）。
 */
export function isValidMatchPattern(pattern: unknown): boolean {
	if (typeof pattern !== "string") return false;
	// `<scheme>://<host>/<path…>`：path 可以只是一个 `/`，但不能缺
	const m = /^(https?):\/\/([^/]*)\/(.*)$/.exec(pattern);
	if (!m) return false;
	const host = m[2];
	if (!host) return false;
	return host === "*" || /^(\*\.)?[a-z0-9.-]+(:\d+|:\*)?$/i.test(host) || /^\[[0-9a-f:.]+\](:\d+)?$/i.test(host);
}
