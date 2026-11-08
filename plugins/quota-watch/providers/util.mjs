import { existsSync, readFileSync } from "node:fs";

/**
 * 读 JSON 文件：缺失或损坏一律返回 null。
 * 额度探测不该因为一个坏文件崩掉整张看板。
 * @param {string} file
 * @returns {any}
 */
export function readJson(file) {
	try {
		if (!existsSync(file)) return null;
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

/**
 * 把各种时间写法统一成 ISO 字符串：ISO / epoch 秒 / epoch 毫秒都收。
 * @param {unknown} value
 * @returns {string}
 */
export function toIso(value) {
	if (value == null || value === "") return "";
	const asNumber = typeof value === "number" ? value : Number(value);
	if (Number.isFinite(asNumber) && asNumber > 0) {
		const ms = asNumber < 1e12 ? asNumber * 1000 : asNumber;
		const date = new Date(ms);
		return Number.isNaN(date.getTime()) ? "" : date.toISOString();
	}
	const parsed = Date.parse(String(value));
	return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

/**
 * 过期时间统一成毫秒时间戳（0 表示未知）。
 * @param {unknown} value
 * @returns {number}
 */
export function expiryMs(value) {
	const iso = toIso(value);
	if (!iso) return 0;
	const ms = Date.parse(iso);
	return Number.isFinite(ms) ? ms : 0;
}

/**
 * 百分比收敛到 0–100，非法值返回 null。
 * 注意：null / undefined / "" 必须回 null —— `Number(null)` 是 0，会把「没有数据」
 * 变成看似确定的「0% 剩余」，在底栏与告警上都是假信号。
 * @param {unknown} value 0–100 或 0–1 的分数
 * @param {{ fraction?: boolean }} [opts]
 * @returns {number|null}
 */
export function percent(value, opts = {}) {
	if (value === null || value === undefined || value === "") return null;
	if (typeof value === "string" && !value.trim()) return null;
	const n = Number(value);
	if (!Number.isFinite(n)) return null;
	const scaled = opts.fraction ? n * 100 : n;
	return Math.min(100, Math.max(0, scaled));
}

/**
 * 解 JWT payload（不验签，只取 email 之类的展示信息）。
 * @param {unknown} token
 * @returns {any}
 */
export function decodeJwtPayload(token) {
	const parts = String(token ?? "").split(".");
	if (parts.length < 2) return null;
	try {
		const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
		return JSON.parse(Buffer.from(base64, "base64").toString("utf8"));
	} catch {
		return null;
	}
}

/**
 * 短错误文案：截断 + 去掉可能的令牌字符，避免把敏感串带进 UI / 日志。
 * @param {unknown} error
 * @returns {string}
 */
export function errorText(error) {
	const raw = error instanceof Error ? error.message : String(error ?? "");
	return raw.replace(/(sk-[A-Za-z0-9_-]{8,}|ey[A-Za-z0-9_-]{20,})/g, "***").slice(0, 300);
}

/**
 * 带超时的 JSON 请求，走宿主 host.net.fetch（受 manifest.netAllowlist 约束）。
 * 失败时抛的 Error 带上 `status` 与厂商的 `code`（如 invalid_grant / token_expired / invalid_client），
 * 上层据此区分「登录态过期」与「网络/服务故障」。
 * @param {{ net: { fetch: (url: string, init?: any) => Promise<any> } }} host
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string, string>, body?: string, timeoutMs?: number }} [init]
 * @returns {Promise<any>}
 */
export async function requestJson(host, url, init = {}) {
	const { timeoutMs = 12_000, ...rest } = init;
	let timer = null;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(`请求超时：${new URL(url).host}`)), timeoutMs);
	});
	try {
		const res = await Promise.race([host.net.fetch(url, rest), timeout]);
		const status = Number(res?.status) || 0;
		const text = typeof res?.text === "string" ? res.text : "";
		let data = null;
		if (text) {
			try {
				data = JSON.parse(text);
			} catch {
				data = null;
			}
		}
		if (res?.error) throw new Error(String(res.error));
		if (!res?.ok) {
			const err = /** @type {Error & { status?: number, code?: string }} */ (new Error(""));
			err.status = status;
			const inner = data?.error;
			// 各种厂商错误形状：{error:{message,code}} / {error:"invalid_grant",error_description} / {detail}
			const message =
				(typeof inner === "object" ? inner?.message : "") ||
				data?.error_description ||
				(typeof inner === "string" ? inner : "") ||
				(typeof data?.detail === "string" ? data.detail : "") ||
				(typeof data?.message === "string" ? data.message : "") ||
				text.slice(0, 200) ||
				`HTTP ${status || "?"}`;
			const code =
				(typeof inner === "object" ? inner?.code : "") ||
				(typeof data?.code === "string" ? data.code : "") ||
				(typeof data?.error === "string" ? data.error : "") ||
				"";
			err.message = String(message);
			err.code = String(code);
			throw err;
		}
		return data ?? {};
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/**
 * 判断是不是网络层失败（DNS / TLS / 连接被断 / 超时）。
 * 这类失败换账号重试毫无意义，必须立刻停手并说清是网络问题 ——
 * 否则用户会看到「请重新登录」，而真正该做的是开代理。
 * @param {unknown} error
 * @returns {boolean}
 */
export function isNetworkError(error) {
	const e = /** @type {{ message?: string, code?: string, cause?: { code?: string, message?: string } }} */ (
		error ?? {}
	);
	const text = [e.message, e.code, e.cause?.message, e.cause?.code].filter(Boolean).join(" ");
	if (/invalid_grant|invalid_client|token_expired|authentication_error|unauthenticated/i.test(text)) return false;
	return /fetch failed|请求超时|timeout|timed out|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|TLS|network|aborted/i.test(
		text,
	);
}

/**
 * 判断一个错误是不是「登录态失效/需要重新登录」——厂商给的 code 比猜状态码可靠。
 * @param {unknown} error
 * @returns {boolean}
 */
export function needsReauth(error) {
	const e = /** @type {{ status?: number, code?: string, message?: string }} */ (error ?? {});
	const code = String(e.code ?? "").toLowerCase();
	if (
		[
			"invalid_grant",
			"invalid_client",
			"token_expired",
			"unauthenticated",
			"authentication_error",
			"expired_token",
		].includes(code)
	)
		return true;
	if (e.status === 401) return true;
	return /invalid_grant|token_expired|unauthenticated|authentication_error|invalid token|not logged in/i.test(
		String(e.message ?? ""),
	);
}

/**
 * 统一的窗口数据结构。
 * @param {{ id: string, label: string, labelEn: string, usedPercent?: number|null, remainingPercent?: number|null, resetAt?: string, note?: string }} input
 */
export function makeWindow(input) {
	const used = percent(input.usedPercent);
	const remaining = input.remainingPercent != null ? percent(input.remainingPercent) : used != null ? 100 - used : null;
	return {
		id: input.id,
		label: input.label,
		labelEn: input.labelEn,
		usedPercent: used,
		remainingPercent: remaining,
		resetAt: input.resetAt ? toIso(input.resetAt) : "",
		note: input.note ?? "",
	};
}

/**
 * 统一的 provider 结果。
 * @param {string} id
 * @param {Record<string, any>} patch
 */
export function makeProvider(id, patch) {
	return {
		id,
		name: patch.name ?? id,
		status: patch.status ?? "ok",
		account: patch.account ?? "",
		plan: patch.plan ?? "",
		source: patch.source ?? "",
		windows: Array.isArray(patch.windows) ? patch.windows : [],
		balance: patch.balance ?? null,
		extra: Array.isArray(patch.extra) ? patch.extra : [],
		error: patch.error ?? "",
		hint: patch.hint ?? "",
		checkedAt: new Date().toISOString(),
	};
}
