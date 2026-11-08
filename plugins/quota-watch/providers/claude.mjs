import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	decodeJwtPayload,
	errorText,
	expiryMs,
	isNetworkError,
	makeProvider,
	makeWindow,
	needsReauth,
	readJson,
	requestJson,
} from "./util.mjs";

export const ID = "claude";
export const NAME = "Claude Code";
export const NAME_EN = "Claude Code";

/** Claude Code 的公开 OAuth 客户端（用于给过期的登录态续期）。 */
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
/** 官方 CLI 现在走 platform.claude.com；旧域名留作回落。 */
const TOKEN_URLS = ["https://platform.claude.com/v1/oauth/token", "https://console.anthropic.com/v1/oauth/token"];
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const BETA = "oauth-2025-04-20";

/** 5 小时 / 7 天 / 分模型 / 分产品窗口（键名取自官方 usage 响应）。 */
const WINDOWS = [
	{ key: "five_hour", zh: "5 小时窗口", en: "5-hour window" },
	{ key: "seven_day", zh: "每周窗口", en: "Weekly window" },
	{ key: "seven_day_opus", zh: "每周 Opus", en: "Weekly Opus" },
	{ key: "seven_day_sonnet", zh: "每周 Sonnet", en: "Weekly Sonnet" },
	{ key: "seven_day_oauth_apps", zh: "每周 App 调用", en: "Weekly app usage" },
	{ key: "seven_day_routines", zh: "每周 Routines", en: "Weekly routines" },
	{ key: "seven_day_cowork", zh: "每周 Cowork", en: "Weekly cowork" },
];

/** @type {Map<string, { access: string, expiresAt: number }>} */
const tokenCache = new Map();

/**
 * @param {string} home
 */
function readCredentials(home) {
	// CLAUDE_CONFIG_DIR 优先（官方支持的自定义配置目录），否则默认 ~/.claude
	const dirs = [process.env.CLAUDE_CONFIG_DIR, join(home, ".claude")].filter((dir) => typeof dir === "string" && dir);
	for (const dir of dirs) {
		const file = join(dir, ".credentials.json");
		const data = readJson(file);
		const oauth = data?.claudeAiOauth ?? data?.claudeAiOauthV2 ?? null;
		if (!oauth || typeof oauth !== "object") continue;
		return {
			file,
			access: String(oauth.accessToken ?? ""),
			refresh: String(oauth.refreshToken ?? ""),
			expiresAt: expiryMs(oauth.expiresAt),
			subscription: String(oauth.subscriptionType ?? oauth.rateLimitTier ?? ""),
		};
	}
	// 环境变量直给的长时 token（CI / 手配场景）
	const envToken = String(process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "").trim();
	if (envToken) {
		return { file: "env:CLAUDE_CODE_OAUTH_TOKEN", access: envToken, refresh: "", expiresAt: 0, subscription: "" };
	}
	return null;
}

/**
 * @param {any} host
 * @param {{ file: string, access: string, refresh: string, expiresAt: number }} cred
 */
async function ensureAccessToken(host, cred) {
	const cached = tokenCache.get(cred.file);
	const now = Date.now();
	if (cached && cached.expiresAt - 60_000 > now) return cached.access;
	if (cred.access && (!cred.expiresAt || cred.expiresAt - 60_000 > now)) {
		tokenCache.set(cred.file, { access: cred.access, expiresAt: cred.expiresAt || now + 10 * 60_000 });
		return cred.access;
	}
	if (!cred.refresh) {
		if (cred.access) return cred.access;
		throw new Error("登录态缺少 refresh_token");
	}
	// 官方 CLI 用 form-urlencoded，且只带 grant_type / refresh_token / client_id（无 client_secret）
	const body = new URLSearchParams({
		grant_type: "refresh_token",
		refresh_token: cred.refresh,
		client_id: OAUTH_CLIENT_ID,
	}).toString();
	let lastError = null;
	for (const url of TOKEN_URLS) {
		try {
			const data = await requestJson(host, url, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
				body,
			});
			const access = String(data?.access_token ?? "");
			if (!access) throw new Error("刷新登录态失败（未返回 access_token）");
			tokenCache.set(cred.file, { access, expiresAt: now + (Number(data?.expires_in) || 3600) * 1000 });
			return access;
		} catch (error) {
			lastError = error;
			// 只有“换域名也许就好了”的情况才继续试下一个；invalid_grant 换域名也没用
			if (
				!/invalid_grant|token_expired/i.test(String(/** @type {any} */ (error)?.code ?? "")) &&
				Number(/** @type {any} */ (error)?.status) >= 500
			)
				continue;
			break;
		}
	}
	throw lastError instanceof Error ? lastError : new Error("刷新登录态失败");
}

/**
 * @param {any} host
 * @param {string} access
 */
async function fetchUsage(host, access) {
	return requestJson(host, USAGE_URL, {
		headers: {
			authorization: `Bearer ${access}`,
			"anthropic-beta": BETA,
			"content-type": "application/json",
		},
	});
}

/**
 * @param {any} data
 */
function toWindows(data) {
	const windows = [];
	for (const def of WINDOWS) {
		const win = data?.[def.key];
		if (!win || typeof win !== "object") continue;
		const utilization = Number(win.utilization);
		if (!Number.isFinite(utilization)) continue;
		windows.push(
			makeWindow({
				id: def.key,
				label: def.zh,
				labelEn: def.en,
				usedPercent: utilization,
				resetAt: win.resets_at,
			}),
		);
	}
	return windows;
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
			hint: "未检测到 Claude Code 登录态（~/.claude/.credentials.json）。在终端跑一次 claude 并登录后即可自动出现。",
			hintEn: "No Claude Code login found (~/.claude/.credentials.json). Run claude once in a terminal and sign in.",
		});
	}
	try {
		const access = await ensureAccessToken(host, cred);
		const data = await fetchUsage(host, access);
		const windows = toWindows(data);
		const extra = [];
		const extraBudget = data?.extra_usage;
		if (extraBudget?.is_enabled) {
			const used = Number(extraBudget.used_credits);
			const limit = Number(extraBudget.monthly_limit);
			if (Number.isFinite(used) && Number.isFinite(limit) && limit > 0) {
				extra.push({
					label: "额外用量",
					labelEn: "Extra usage",
					value: `${used.toFixed(2)} / ${limit.toFixed(2)}`,
				});
			}
		}
		const account = String(decodeJwtPayload(cred.access)?.email ?? "");
		return makeProvider(ID, {
			name: NAME,
			status: windows.length ? "ok" : "empty",
			account,
			plan: cred.subscription,
			source: cred.file.replace(/^.*[\\/](?=[^\\/]+$)/, "…/"),
			windows,
			extra,
			hint: windows.length ? "" : "接口没有返回用量窗口，可能是纯 API Key 账号（无订阅额度）。",
			hintEn: windows.length
				? ""
				: "No usage window returned — likely a pure API-key account without subscription quota.",
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
				? "连不上 Anthropic（网络不可达），开代理/VPN 后点刷新。"
				: expired
					? "登录态已失效，在终端跑一次 claude 并重新登录。"
					: "查询用量失败，稍后重试。",
			hintEn: network
				? "Cannot reach Anthropic (network unreachable). Turn on your proxy/VPN and refresh."
				: expired
					? "Login expired. Run claude again to sign in."
					: "Failed to query usage; retry later.",
		});
	}
}
