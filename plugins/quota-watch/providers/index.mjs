import { homedir } from "node:os";
import { join } from "node:path";
import * as antigravity from "./antigravity.mjs";
import * as claude from "./claude.mjs";
import * as codex from "./codex.mjs";
import * as deepseek from "./deepseek.mjs";
import { errorText, isNetworkError, makeProvider, readJson } from "./util.mjs";

const PER_PROVIDER_TIMEOUT_MS = 30_000;

/**
 * @typedef {object} CollectContext
 * @property {any} host 插件宿主（只用 net.fetch / secrets / log）
 * @property {Record<string, unknown>} settings getSettings() 的结果
 * @property {string} home 用户主目录
 */

/**
 * @param {Record<string, unknown>} settings
 * @param {string} key
 */
function flag(settings, key) {
	const value = settings?.[key];
	return value === undefined ? true : value !== false && value !== "false";
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
 * DeepSeek Key 的取值顺序：设置里填的（含加密机密）→ 环境变量 → 本机 pi 已存的 provider 凭据。
 * 目标是「用户本机登录/配置过就不用再填」。
 * @param {any} host
 * @param {Record<string, unknown>} settings
 * @param {string} home
 */
function resolveDeepSeekKey(host, settings, home) {
	const direct = settings?.deepseekKey;
	if (typeof direct === "string" && direct.trim()) return direct.trim();
	try {
		const secret = host.secrets?.get?.("setting:deepseekKey");
		if (typeof secret === "string" && secret.trim()) return secret.trim();
	} catch {
		/* secrets 不可用就往下走 */
	}
	const env = process.env.DEEPSEEK_API_KEY;
	if (typeof env === "string" && env.trim()) return env.trim();
	for (const file of ["auth.json", "provider-keys.json"]) {
		const data = readJson(join(home, ".pi", "agent", file));
		if (!data || typeof data !== "object") continue;
		for (const [name, value] of Object.entries(data)) {
			if (!/deepseek/i.test(name)) continue;
			const found = keyFromPiEntry(value);
			if (found) return found;
		}
	}
	return "";
}

/**
 * 单个 provider 超时兜底：厂商接口卡住不该拖垮整张看板。
 * 30s 是留给「刷新 token + 两跳域名回落 + 查档位」串起来用的；单请求各自另有更短的超时。
 * @template T
 * @param {Promise<T>} promise
 * @param {string} id
 * @returns {Promise<T>}
 */
function withTimeout(promise, id) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${id} 查询超时`)), PER_PROVIDER_TIMEOUT_MS);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

/**
 * 四个额度来源 → 采集器。与 `badge.mjs` 的 MODEL_RULES 一一对应：
 * 模型认出哪家，就只查哪家（见 collectActive）。
 * @type {Array<{ id: string, name: string, setting: string, kind: "balance" | "subscription", run: (ctx: CollectContext) => Promise<any> }>}
 */
const SOURCES = [
	{
		id: antigravity.ID,
		name: antigravity.NAME,
		setting: "antigravityEnabled",
		kind: "subscription",
		run: ({ host, home }) => antigravity.collect({ host, home }),
	},
	{
		id: claude.ID,
		name: claude.NAME,
		setting: "claudeEnabled",
		kind: "subscription",
		run: ({ host, home }) => claude.collect({ host, home }),
	},
	{
		id: codex.ID,
		name: codex.NAME,
		setting: "codexEnabled",
		kind: "subscription",
		run: ({ host, home }) => codex.collect({ host, home }),
	},
	{
		id: deepseek.ID,
		name: deepseek.NAME,
		setting: "deepseekEnabled",
		// 余额型：没有订阅窗口，数字随一次请求就变 —— 缓存该短得多（见 index.mjs 的 TTL 分档）
		kind: "balance",
		run: ({ host, settings, home }) => deepseek.collect({ host, apiKey: resolveDeepSeekKey(host, settings, home) }),
	},
];

/**
 * 这家是不是「余额型」来源（只有 DeepSeek）。TTL 分档与卡片形态都看它。
 * @param {string} id
 */
export function isBalanceSource(id) {
	const wanted = String(id ?? "").trim();
	return SOURCES.some((entry) => entry.id === wanted && entry.kind === "balance");
}

/** 空快照：认不出当前供应商时底栏整段隐藏，不做无谓出网。 */
function emptySnapshot() {
	return { providers: [], updatedAt: new Date().toISOString() };
}

/**
 * 采集**当前供应商**的额度 —— 底栏、看板、AI 工具共用这一份数据。
 *
 * 只查当前那一家是刻意的：底栏每 60s 轮询一次，为「其它三家」出网既慢又容易撞厂商限流，
 * 而用户真正要看的永远是当前模型对应的那家。开关（`*Enabled`）关掉即视为没有这个来源。
 *
 * @param {CollectContext & { id: string }} ctx
 */
export async function collectActive({ host, settings, home = homedir(), id }) {
	const wanted = String(id ?? "").trim();
	const source = SOURCES.find((entry) => entry.id === wanted);
	if (!source || !flag(settings, source.setting)) return emptySnapshot();

	const provider = await withTimeout(source.run({ host, settings, home }), source.id).catch((error) => {
		const message = errorText(error);
		host.log?.("warn", `[quota-watch] ${source.id} 查询失败：${message}`);
		const network = isNetworkError(error);
		return makeProvider(source.id, {
			name: source.name,
			status: network ? "network" : "error",
			error: message,
			hint: network ? "网络不可达：开代理 / 换网络后重试。" : "查询额度失败，稍后重试。",
			hintEn: network ? "Network unreachable: retry behind a proxy." : "Quota request failed; retry later.",
		});
	});

	return { providers: [provider], updatedAt: new Date().toISOString() };
}

/**
 * 给 AI 读的纯文本摘要（只有当前供应商）。
 * @param {any} snapshot
 */
export function toText(snapshot) {
	const lines = [];
	const providers = Array.isArray(snapshot?.providers) ? snapshot.providers : [];
	if (!providers.length) return "当前模型没有对应的额度来源（额度看板只查当前供应商）。";
	for (const provider of providers) {
		const head = [provider.name, provider.plan, provider.account].filter(Boolean).join(" · ");
		if (provider.status === "signed-out") {
			lines.push(`- ${head}: 未登录 / 未配置（${provider.hint || "无提示"}）`);
			continue;
		}
		if (provider.status === "error" || provider.status === "expired") {
			lines.push(`- ${head}: 查询失败（${provider.error || provider.hint}）`);
			continue;
		}
		const parts = [];
		for (const win of provider.windows ?? []) {
			const remaining = Number(win.remainingPercent);
			const pct = Number.isFinite(remaining) ? `${remaining.toFixed(remaining < 10 ? 1 : 0)}%` : "未知";
			const reset = win.resetAt ? `，${win.resetAt} 重置` : "";
			parts.push(`${win.label} 剩余 ${pct}${reset}`);
		}
		if (provider.balance) {
			const amount =
				provider.balance.text || `${provider.balance.currency} ${Number(provider.balance.amount).toFixed(2)}`;
			parts.push(`余额 ${amount}`);
		}
		if (Array.isArray(provider.extra)) {
			for (const item of provider.extra) {
				if (item?.label && item?.value) parts.push(`${item.label} ${item.value}`);
			}
		}
		lines.push(`- ${head}: ${parts.length ? parts.join("；") : "无窗口数据"}`);
	}
	return lines.length ? lines.join("\n") : "没有可用的额度来源。";
}
