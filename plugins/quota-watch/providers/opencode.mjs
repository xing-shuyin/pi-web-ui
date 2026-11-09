import { join } from "node:path";
import { errorText, isNetworkError, makeProvider, makeWindow, needsReauth, readJson, requestJson } from "./util.mjs";

export const ID = "opencode";
export const NAME = "OpenCode";
export const NAME_EN = "OpenCode";

/**
 * Console 网页右上角 Billing 抽屉背后调的同一批接口。
 * Bearer 推理 Key（`oc_sk_...`）可直接调用，无需浏览器登录态 cookie。
 */
const STATUS_URL = "https://opencode.ai/console/api/go/status";

const PLAN_LABEL = { go: "Go", "go-plus": "Go Plus", "go-teams": "Go Teams" };

/**
 * OpenCode 的 auth.json 候选位置（按优先级）：
 * 1. $OPENCODE_DATA_DIR/auth.json（显式覆盖，含 XDG 场景）
 * 2. $XDG_DATA_HOME/opencode/auth.json
 * 3. ~/.local/share/opencode/auth.json（Linux 默认）
 * 4. ~/Library/Application Support/opencode/auth.json（macOS 默认）
 * 5. %APPDATA%/opencode/auth.json（Windows 默认，home 下拼接）
 * @param {string} home
 * @returns {string[]}
 */
function candidates(home) {
	const list = [];
	const envDir = String(process.env.OPENCODE_DATA_DIR ?? "").trim();
	if (envDir) list.push(join(envDir, "auth.json"));
	const xdg = String(process.env.XDG_DATA_HOME ?? "").trim();
	if (xdg) list.push(join(xdg, "opencode", "auth.json"));
	list.push(join(home, ".local", "share", "opencode", "auth.json"));
	list.push(join(home, "Library", "Application Support", "opencode", "auth.json"));
	list.push(join(home, "AppData", "Roaming", "opencode", "auth.json"));
	const appData = String(process.env.APPDATA ?? "").trim();
	if (appData) list.push(join(appData, "opencode", "auth.json"));
	return list;
}

/**
 * @param {string} home
 * @returns {{ file: string, data: Record<string, any> } | null}
 */
function readAuth(home) {
	for (const file of candidates(home)) {
		const data = readJson(file);
		if (data && typeof data === "object" && !Array.isArray(data)) return { file, data };
	}
	return null;
}

/**
 * 单个条目的展示：API Key 只报存在性（不回显、不算长度），OAuth 看是否过期。
 * auth.json 形状随版本变化：{ type: "api", key } / { type: "oauth", access, refresh, expires }。
 * @param {string} id
 * @param {any} entry
 */
function describeEntry(id, entry) {
	if (typeof entry === "string") return entry.trim() ? "API Key 已配置" : "";
	if (!entry || typeof entry !== "object") return "";
	const type = String(entry.type ?? "").toLowerCase();
	if (type === "oauth") {
		const access = String(entry.access ?? entry.accessToken ?? "").trim();
		const refresh = String(entry.refresh ?? entry.refreshToken ?? "").trim();
		const expiresRaw = entry.expires ?? entry.expiresAt ?? entry.expiry;
		const expiresMs =
			typeof expiresRaw === "number" && Number.isFinite(expiresRaw)
				? expiresRaw < 1e12
					? expiresRaw * 1000
					: expiresRaw
				: Date.parse(String(expiresRaw ?? ""));
		if (!access && !refresh) return "";
		if (Number.isFinite(expiresMs) && expiresMs > 0 && expiresMs <= Date.now()) return "OAuth 已过期";
		return "OAuth 已登录";
	}
	for (const field of ["key", "apiKey", "api_key", "token", "access", "accessToken"]) {
		const value = entry[field];
		if (typeof value === "string" && value.trim()) return "API Key 已配置";
	}
	if (type === "api") return "API Key 已配置";
	return "";
}

/**
 * 从一个 pi provider 条目里挖出 API Key（形状随版本变化：{key} / {apiKey} / {keys:[{name,apiKey}], activeKeyName}）。
 * @param {any} entry
 * @returns {string}
 */
function keyFromPiEntry(entry) {
	if (typeof entry === "string") return entry.trim();
	if (!entry || typeof entry !== "object") return "";
	for (const field of ["key", "apiKey", "api_key"]) {
		const value = entry[field];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	const list = Array.isArray(entry.keys) ? entry.keys : [];
	if (list.length) {
		const active = list.find((item) => item && item.name === entry.activeKeyName);
		const picked = keyFromPiEntry(active ?? list[0]);
		if (picked) return picked;
	}
	return "";
}

/**
 * OpenCode Key 的取值顺序：设置里填的（含加密机密）→ 环境变量 → 本机 pi 已存的 provider 凭据。
 * 目标是「本机登录/配置过就不用再填」——用量接口认的是 Console 推理 Key（`oc_sk_...`），
 * 它就躺在 `~/.pi/agent/auth.json` / `provider-keys.json` 的 opencode 条目里。
 * @param {any} host
 * @param {Record<string, unknown>} settings
 * @param {string} home
 */
function resolveKey(host, settings, home) {
	const direct = settings?.opencodeKey;
	if (typeof direct === "string" && direct.trim()) return direct.trim();
	try {
		const secret = host.secrets?.get?.("setting:opencodeKey");
		if (typeof secret === "string" && secret.trim()) return secret.trim();
	} catch {
		/* secrets 不可用就往下走 */
	}
	const env = process.env.OPENCODE_API_KEY;
	if (typeof env === "string" && env.trim()) return env.trim();
	for (const file of ["auth.json", "provider-keys.json"]) {
		const data = readJson(join(home, ".pi", "agent", file));
		if (!data || typeof data !== "object") continue;
		for (const [name, value] of Object.entries(data)) {
			if (!/opencode/i.test(name)) continue;
			const found = keyFromPiEntry(value);
			if (found) return found;
		}
	}
	return "";
}

/**
 * 一档用量计（5 小时 / 每周 / 每月）→ 卡片窗口。
 * Console 给的是微美分（1 美元 = 1e8 microcents）：limitMicroCents 为 0/缺失 = 免费不限量，不画窗口。
 * @param {string} id
 * @param {string} label
 * @param {string} labelEn
 * @param {any} meter
 */
function meterWindow(id, label, labelEn, meter) {
	const limit = Number(meter?.limitMicroCents);
	if (!Number.isFinite(limit) || limit <= 0) return null;
	const usedRaw = Number(meter?.usedMicroCents);
	const used = Number.isFinite(usedRaw) && usedRaw > 0 ? usedRaw : 0;
	const remaining = Math.min(100, Math.max(0, (1 - used / limit) * 100));
	return makeWindow({ id, label, labelEn, remainingPercent: remaining, resetAt: meter?.resetsAt ?? "" });
}

/**
 * @param {any} status
 */
function planOf(status) {
	const product = String(status?.product ?? "")
		.trim()
		.toLowerCase();
	return PLAN_LABEL[product] ?? (product || "OpenCode");
}

/**
 * OpenCode 额度 = Go 订阅的三档用量计（5 小时 / 每周 / 每月）+ 本机 auth.json 的登录态列表。
 *
 * 免费模型（Iceman Contributor Free 等）在 Go 表里是 Unlimited，不占用订阅窗口 ——
 * 卡片照样显示订阅剩余额度（这正是账号维度的数字，和当前用不用免费模型无关）。
 * @param {{ host: any, settings?: Record<string, unknown>, home: string }} ctx
 */
export async function collect({ host, settings = {}, home }) {
	const found = readAuth(home);
	const extra = [];
	if (found) {
		for (const [id, entry] of Object.entries(found.data)) {
			if (id.startsWith("_") || id.startsWith("$")) continue;
			const value = describeEntry(id, entry);
			if (!value) continue;
			extra.push({ label: id, labelEn: id, value });
		}
		// "opencode" 条目（Zen 订阅）优先排前面
		extra.sort((a, b) => (a.label === "opencode" ? -1 : b.label === "opencode" ? 1 : 0));
	}
	const source = found?.file ?? "";
	/** 不出网的降级形态：只有本机登录态列表，窗口为空。 */
	const localOnly = (patch = {}) => makeProvider(ID, { name: NAME, status: "ok", source, extra, ...patch });

	const key = resolveKey(host, settings, home);
	if (!key) {
		if (!extra.length) {
			return makeProvider(ID, {
				name: NAME,
				status: "signed-out",
				hint: "未检测到 OpenCode 登录态（auth.json）与 API Key。在终端跑一次 opencode 并登录 / 配置模型 Key 后即可自动出现。",
				hintEn: "No OpenCode auth found (auth.json) and no API key. Run opencode once and sign in first.",
			});
		}
		return localOnly({
			hint: "未找到 OpenCode API Key（本机 pi 凭据或插件设置），只显示本机登录态；订阅剩余额度需要 Key 才能查询。",
			hintEn: "No OpenCode API key found; showing local login state only.",
		});
	}

	let status;
	try {
		status = await requestJson(host, STATUS_URL, {
			headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
		});
	} catch (error) {
		const message = errorText(error);
		if (needsReauth(error)) {
			return makeProvider(ID, {
				name: NAME,
				status: "expired",
				source,
				extra,
				error: message,
				hint: "OpenCode Key 已失效：去 Console 重新生成一把，更新本机 pi 凭据或插件设置里的 Key。",
				hintEn: "OpenCode key expired. Regenerate one in the Console and update it.",
			});
		}
		const network = isNetworkError(error);
		return makeProvider(ID, {
			name: NAME,
			status: network ? "network" : "error",
			source,
			extra,
			error: message,
			hint: network ? "网络不可达：开代理 / 换网络后重试。" : "查询额度失败，稍后重试。",
			hintEn: network ? "Network unreachable: retry behind a proxy." : "Quota request failed; retry later.",
		});
	}

	const meters = status?.access?.meters ?? {};
	const windows = [
		meterWindow("five-hour", "5 小时窗口", "5-hour window", meters.fiveHour),
		meterWindow("weekly", "每周窗口", "Weekly window", meters.week),
		meterWindow("monthly", "每月窗口", "Monthly window", meters.month),
	].filter(Boolean);
	const plan = planOf(status);
	if (!windows.length) {
		// 该账号没有 Go 订阅窗口：免费模型不限量，订阅额度无从谈起
		return localOnly({
			plan,
			hint: "该账号没有 Go 订阅用量窗口（免费模型不限量）。订阅 Go 后这里会显示 5 小时 / 每周 / 每月剩余额度。",
			hintEn: "No Go subscription windows on this account (free models are unlimited).",
		});
	}
	const endsAt = String(status?.access?.endsAt ?? "");
	const renewal = endsAt.length >= 10 ? ` · ${endsAt.slice(5, 10)} 续期` : "";
	host.log?.(
		"info",
		`[quota-watch] OpenCode ${plan}：${windows.map((w) => `${w.label}剩 ${Number(w.remainingPercent).toFixed(1)}%`).join(" / ")}`,
	);
	return makeProvider(ID, {
		name: NAME,
		status: "ok",
		plan: `${plan}${renewal}`,
		source,
		windows,
		extra,
		hint: "",
		hintEn: "",
	});
}
