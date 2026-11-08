import { join } from "node:path";
import { errorText, isNetworkError, makeProvider, makeWindow, needsReauth, readJson, requestJson } from "./util.mjs";

export const ID = "codex";
export const NAME = "Codex（ChatGPT）";
export const NAME_EN = "Codex (ChatGPT)";

/** Codex CLI 的公开 OAuth 客户端。 */
const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const USAGE_URLS = ["https://chatgpt.com/backend-api/wham/usage", "https://chatgpt.com/backend-api/codex/usage"];

/** @type {Map<string, { access: string, expiresAt: number }>} */
const tokenCache = new Map();

/**
 * @param {string} home
 */
function readCredentials(home) {
	// CODEX_HOME（官方支持的自定义目录）优先，否则 ~/.codex
	const dirs = [process.env.CODEX_HOME, join(home, ".codex")].filter((dir) => typeof dir === "string" && dir);
	for (const dir of dirs) {
		const file = join(dir, "auth.json");
		const data = readJson(file);
		if (!data || typeof data !== "object") continue;
		const tokens = data.tokens && typeof data.tokens === "object" ? data.tokens : {};
		const apiKey = String(data.OPENAI_API_KEY ?? "");
		const access = String(tokens.access_token ?? "");
		if (!access && !apiKey) continue;
		return {
			file,
			access,
			refresh: String(tokens.refresh_token ?? ""),
			accountId: String(tokens.account_id ?? ""),
			apiKey,
		};
	}
	return null;
}

/**
 * @param {any} host
 * @param {{ file: string, access: string, refresh: string }} cred
 */
async function refreshAccessToken(host, cred) {
	if (!cred.refresh) return "";
	const data = await requestJson(host, OAUTH_TOKEN_URL, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			client_id: OAUTH_CLIENT_ID,
			grant_type: "refresh_token",
			refresh_token: cred.refresh,
			scope: "openid profile email",
		}),
	});
	const access = String(data?.access_token ?? "");
	if (!access) return "";
	tokenCache.set(cred.file, { access, expiresAt: Date.now() + (Number(data?.expires_in) || 3600) * 1000 });
	return access;
}

/**
 * @param {any} host
 * @param {{ file: string, access: string, accountId: string }} cred
 */
async function fetchUsage(host, cred) {
	const headers = {
		authorization: `Bearer ${cred.access}`,
		"user-agent": "codex_cli_rs/0.50.0",
		originator: "codex_cli_rs",
		"content-type": "application/json",
	};
	if (cred.accountId) headers["chatgpt-account-id"] = cred.accountId;
	/** @type {Error|null} */
	let lastError = null;
	for (const url of USAGE_URLS) {
		try {
			return await requestJson(host, url, { headers });
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
			if (lastError.status && lastError.status !== 404) break;
		}
	}
	throw lastError ?? new Error("用量接口不可用");
}

/**
 * @param {number} seconds
 */
function windowLabels(seconds) {
	if (seconds >= 6 * 24 * 3600) return { zh: "每周窗口", en: "Weekly window" };
	if (seconds >= 23 * 3600) return { zh: "每日窗口", en: "Daily window" };
	if (seconds >= 4 * 3600) return { zh: "5 小时窗口", en: "5-hour window" };
	if (seconds > 0)
		return { zh: `${Math.round(seconds / 3600)} 小时窗口`, en: `${Math.round(seconds / 3600)}-hour window` };
	return { zh: "额度窗口", en: "Quota window" };
}

/**
 * 窗口长度既可能是 `limit_window_seconds`，也可能（历史/变体）是 `window_minutes`。
 * @param {any} win
 */
function windowSeconds(win) {
	const seconds = Number(win?.limit_window_seconds ?? win?.limitWindowSeconds ?? win?.window_seconds);
	if (Number.isFinite(seconds) && seconds > 0) return seconds;
	const minutes = Number(win?.window_minutes ?? win?.limit_window_minutes);
	return Number.isFinite(minutes) && minutes > 0 ? minutes * 60 : 0;
}

/**
 * 结构漂移兜底：厂商改字段名时（历史上就从 window_minutes 改成了 limit_window_seconds），
 * 至少按「任意 window 对象里带 used_percent」扫出来，不至于整张卡片空白。
 * 限深度 3、最多 4 个窗口，避免把奇怪结构读成假数据。
 * @param {any} data
 */
function scavengeWindows(data) {
	const found = [];
	const seen = new Set();
	const walk = (node, depth) => {
		if (!node || typeof node !== "object" || depth > 3 || found.length >= 4) return;
		if (Array.isArray(node)) {
			for (const item of node) walk(item, depth + 1);
			return;
		}
		for (const [key, raw] of Object.entries(node)) {
			if (!raw || typeof raw !== "object") continue;
			const value = /** @type {any} */ (raw);
			const used = Number(value.used_percent ?? value.usedPercent);
			if (/window/i.test(key) && Number.isFinite(used) && !seen.has(key)) {
				seen.add(key);
				const labels = windowLabels(windowSeconds(value));
				found.push(
					makeWindow({
						id: key,
						label: labels.zh,
						labelEn: labels.en,
						usedPercent: used,
						resetAt: value.reset_at ?? value.resetAt,
					}),
				);
				continue;
			}
			walk(value, depth + 1);
		}
	};
	walk(data, 0);
	return found;
}

/**
 * @param {any} data
 */
function toWindows(data) {
	const rateLimit = data?.rate_limit ?? data?.rate_limit_status ?? data?.rateLimits ?? null;
	const windows = [];
	/** @type {Array<[string, any]>} */
	const entries = [
		["primary", rateLimit?.primary_window ?? rateLimit?.primary ?? null],
		["secondary", rateLimit?.secondary_window ?? rateLimit?.secondary ?? null],
	];
	for (const [slot, win] of entries) {
		if (!win || typeof win !== "object") continue;
		const used = Number(win.used_percent ?? win.usedPercent);
		if (!Number.isFinite(used)) continue;
		const labels = windowLabels(windowSeconds(win));
		windows.push(
			makeWindow({
				id: slot,
				label: labels.zh,
				labelEn: labels.en,
				usedPercent: used,
				resetAt: win.reset_at ?? win.resetAt,
			}),
		);
	}
	if (!windows.length) return scavengeWindows(data);
	return windows;
}

/**
 * 模型专属限额（`additional_rate_limits[]`，例如某个特定 Codex 型号的独立窗口）。
 * @param {any} data
 */
function toAdditionalWindows(data) {
	const list = Array.isArray(data?.additional_rate_limits) ? data.additional_rate_limits : [];
	const out = [];
	for (const entry of list.slice(0, 4)) {
		const name = String(entry?.limit_name ?? entry?.metered_feature ?? "").trim();
		const rateLimit = entry?.rate_limit ?? entry;
		for (const [slot, win] of [
			["primary", rateLimit?.primary_window],
			["secondary", rateLimit?.secondary_window],
		]) {
			if (!win || typeof win !== "object") continue;
			const used = Number(win.used_percent ?? win.usedPercent);
			if (!Number.isFinite(used)) continue;
			const labels = windowLabels(windowSeconds(win));
			out.push(
				makeWindow({
					id: `extra:${name}:${slot}`,
					label: name ? `${name} · ${labels.zh}` : labels.zh,
					labelEn: name ? `${name} · ${labels.en}` : labels.en,
					usedPercent: used,
					resetAt: win.reset_at ?? win.resetAt,
				}),
			);
		}
	}
	return out;
}

/**
 * @param {{ host: any, home: string }} ctx
 */
export async function collect({ host, home }) {
	const cred = readCredentials(home);
	if (!cred) {
		return makeProvider(ID, {
			name: NAME,
			status: "signed-out",
			hint: "未检测到 Codex 登录态（~/.codex/auth.json）。在终端跑一次 codex 并登录后即可自动出现。",
			hintEn: "No Codex login found (~/.codex/auth.json). Run codex once in a terminal and sign in.",
		});
	}

	if (!cred.access) {
		return makeProvider(ID, {
			name: NAME,
			status: "empty",
			source: cred.file,
			hint: "本机 Codex 用的是 API Key 计费（无 ChatGPT 订阅），所以没有订阅窗口。",
			hintEn: "This Codex install uses an API key (no ChatGPT subscription), so there are no subscription windows.",
		});
	}

	/** @type {string} */
	let access = cred.access;
	const cached = tokenCache.get(cred.file);
	if (cached && cached.expiresAt - 60_000 > Date.now()) access = cached.access;

	try {
		let data = null;
		try {
			data = await fetchUsage(host, { ...cred, access });
		} catch (error) {
			const status = Number(/** @type {any} */ (error)?.status);
			if (status !== 401 && status !== 403) throw error;
			access = await refreshAccessToken(host, cred);
			if (!access) throw error;
			data = await fetchUsage(host, { ...cred, access });
		}
		const windows = [...toWindows(data), ...toAdditionalWindows(data)];
		const extra = [];
		const credits = data?.credits;
		if (credits && (credits.has_credits === false || credits.unlimited || credits.balance != null)) {
			extra.push({
				label: "赠送额度",
				labelEn: "Credits",
				value: credits.unlimited ? "不限" : String(credits.balance ?? (credits.has_credits ? "可用" : "0")),
			});
		}
		// 个人花费上限（credit 上限）：root → rate_limit → spend_control 三级取第一个
		const spend =
			data?.individual_limit ??
			data?.individualLimit ??
			data?.rate_limit?.individual_limit ??
			data?.spend_control?.individual_limit ??
			null;
		const spendLimit = Number(spend?.limit ?? spend?.credit_limit ?? spend?.max_credits);
		const spendUsed = Number(spend?.used ?? spend?.used_credits ?? spend?.consumed);
		if (Number.isFinite(spendLimit) && spendLimit > 0) {
			extra.push({
				label: "花费上限",
				labelEn: "Spend limit",
				value: Number.isFinite(spendUsed) ? `${spendUsed.toFixed(2)} / ${spendLimit.toFixed(2)}` : String(spendLimit),
			});
		}
		const plan = String(data?.plan_type ?? data?.planType ?? "");
		return makeProvider(ID, {
			name: NAME,
			status: windows.length ? "ok" : "empty",
			account: "",
			plan,
			source: cred.file,
			windows,
			extra,
			hint: windows.length ? "" : "接口没有返回用量窗口（可能用的是 API Key 计费而非订阅）。",
			hintEn: windows.length ? "" : "No usage window returned (likely API-key billing instead of a subscription).",
		});
	} catch (error) {
		const message = errorText(error);
		const network = isNetworkError(error);
		const expired = !network && needsReauth(error);
		return makeProvider(ID, {
			name: NAME,
			status: network ? "network" : expired ? "expired" : "error",
			error: message,
			hint: network
				? "连不上 ChatGPT（网络不可达），开代理/VPN 后点刷新。"
				: expired
					? "登录态已失效，在终端跑一次 codex 并重新登录。"
					: "查询用量失败，稍后重试。",
			hintEn: network
				? "Cannot reach ChatGPT (network unreachable). Turn on your proxy/VPN and refresh."
				: expired
					? "Login expired. Run codex again to sign in."
					: "Failed to query usage; retry later.",
		});
	}
}
