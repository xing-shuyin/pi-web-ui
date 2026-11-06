/**
 * 安全 HTML 实体转义。
 * @param {unknown} s 待转义内容
 * @returns {string} 转义后的 HTML 字符串
 */
export function esc(s) {
	return String(s ?? "").replace(
		/[&<>"']/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
	);
}

/**
 * 安全取用 window.__piWebUiHost 宿主桥接 API。
 * @returns {any} 宿主 API 对象或 null
 */
export function hostApi() {
	return typeof window !== "undefined" ? (window.__piWebUiHost ?? null) : null;
}

/**
 * 获取插件服务端路由的统一根路径。
 * @param {string} pluginId 插件 id
 * @returns {string} 路由根路径，如 "/plugins-api/my-plugin"
 */
export function apiBase(pluginId) {
	return `/plugins-api/${pluginId}`;
}

/**
 * 格式化字节大小为人类可读字符串（B / KB / MB / GB）。
 * @param {number|unknown} bytes 字节大小
 * @param {number} [decimals=1] 小数位数
 * @returns {string}
 */
export function formatBytes(bytes, decimals = 1) {
	const n = Number(bytes);
	if (!Number.isFinite(n) || n < 0) return "";
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(decimals)} KB`;
	if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(decimals)} MB`;
	return `${(n / (1024 * 1024 * 1024)).toFixed(decimals)} GB`;
}

/**
 * 为异步操作施加超时限制。
 * @template T
 * @param {Promise<T>} promise 目标 Promise
 * @param {number} timeoutMs 超时时间（毫秒）
 * @param {string} [errorMsg="Operation timed out"] 超时提示文案
 * @returns {Promise<T>}
 */
export function withTimeout(promise, timeoutMs, errorMsg = "Operation timed out") {
	return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(errorMsg)), timeoutMs))]);
}

/**
 * 生成随机 UUID（浏览器优先使用 crypto.randomUUID，提供纯 JS 降级）。
 * @returns {string}
 */
export function uuid() {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		const v = c === "x" ? r : (r & 0x3) | 0x8;
		return v.toString(16);
	});
}

/**
 * 归一化相对路径（反斜杠转斜杠、去除首尾多余斜杠与 "./"）。
 * @param {string} p
 * @returns {string}
 */
export function normalizeRel(p) {
	return String(p ?? "")
		.replace(/\\/g, "/")
		.replace(/^\.?\/+/, "")
		.replace(/\/+$/, "");
}
