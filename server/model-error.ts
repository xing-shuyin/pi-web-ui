/**
 * 模型错误分类单源（issue #978）。
 *
 * SDK 把 HTTP 状态码、响应正文、文案拼成**一个非结构化字符串**塞进 `errorMessage`
 * （非 2xx 时正文被原样当成错误消息），所以网关错误页、鉴权失败、配额不足、模型拒答
 * 在 UI 上长得一模一样。本模块是唯一的翻译点：气泡（serialize → UiMessage.errorInfo）、
 * 子代理通知、`conversation(status/wait_all)` 的 verdict 都只消费 `classifyModelError`
 * 的输出，禁止在别处再写一份状态码提取或 HTML 判定。
 *
 * 原则：认不出就是 `unknown`（不猜），`raw` 原样保留，`summary` 只做清洗与截断。
 */
import { pick, type ServerLang } from "./i18n.js";

export type ModelErrorKind = "gateway" | "auth" | "quota" | "model" | "unknown";

export interface ModelErrorInfo {
	/** 分类：网关/代理、鉴权、配额、模型侧拒绝、认不出。 */
	kind: ModelErrorKind;
	/** 从文本里提取到的 HTTP 状态码（认不出就没有）。 */
	status?: number;
	/** 去掉 HTML 标签、折叠空白、截断后的可读摘要；清洗后为空就是空串（原文仍可从 raw 展开）。 */
	summary: string;
	/** 原始错误文本，原样保留（气泡的「查看原始响应」用它）。 */
	raw: string;
}

export const MODEL_ERROR_SUMMARY_CAP = 200;

/** 自动重试次数（对齐 SDK `auto_retry_start/end` 的 attempt / maxAttempts）。 */
export interface ModelRetrySummary {
	attempt: number;
	maxAttempts: number;
}

/** 会话内的收尾记录：重试次数 + 那一轮最终失败的原文（只给身份对得上的错误气泡认领）。 */
export interface ModelRetryRecord extends ModelRetrySummary {
	errorMessage: string;
}

/** 快照/UI 投影：分类结果（不带 raw——原文已经在 `errorMessage` 上）+ 收尾时固定下来的重试次数。 */
export interface ModelErrorReport {
	kind: ModelErrorKind;
	status?: number;
	summary: string;
	retries?: ModelRetrySummary;
}

/**
 * 配额/计费耗尽的措辞。对齐 `@earendil-works/pi-ai` `utils/retry.js` 的
 * `NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN`：这些错误重试也没用，必须归到 quota。
 */
const QUOTA_PATTERN =
	/(?:insufficient[_\s-]?quota|quota[_\s-]?exceeded|exceeded (?:your|the) current quota|out of budget|billing|monthly usage limit|available balance|usage[_\s-]?limit|GoUsageLimitError|FreeUsageLimitError|"code"\s*:\s*"?1308(?![0-9]))/i;

/** 鉴权/凭据/权限：换 Key、重登录能解决，跟重试无关。 */
const AUTH_PATTERN =
	/(?:invalid[_\s-]?api[_\s-]?key|incorrect api key|api[_\s-]?key[^.]{0,40}(?:invalid|missing|not (?:set|configured|valid))|unauthorized|unauthenticated|authentication|forbidden|permission denied|invalid (?:token|credentials)|token (?:is )?expired)/i;

/** 网关/代理/上游传输层状态码：408 = 网关没等到完整请求，52x = Cloudflare 系。 */
const GATEWAY_STATUS = new Set([408, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527]);

const GATEWAY_PATTERN =
	/(?:bad gateway|gateway time-?out|request time-?out|upstream|cloudflare|nginx|proxy error|service (?:is )?temporarily unavailable|rate.?limit|too many requests)/i;

/** 响应正文是 HTML 错误页（nginx/Apache 默认页），不是模型 API 的 JSON。 */
const HTML_PATTERN = /<!doctype|<html[\s>]|<body[\s>]|<head[\s>]|<\/(?:html|body|head)>/i;

/** 模型侧明确拒绝：模型不存在/不支持、上下文超限、内容策略。 */
const MODEL_PATTERN =
	/(?:model[_\s-]?not[_\s-]?found|no such model|model[_\s-]?not[_\s-]?supported|does not support (?:the )?model|context[_\s-]?length|maximum context|context window|invalid[_\s-]?request[_\s-]?error|content[_\s-]?policy|safety[_\s-]?system|unsupported (?:model|parameter))/i;

/** 状态码提取：前缀 → `HTTP xxx` → `status/code` 字段 → JSON 正文。先命中先用。 */
const STATUS_PATTERNS: readonly RegExp[] = [
	/^\s*(\d{3})(?!\d)/,
	/\bhttp(?:\/\s*[\d.]+)?\s*(?:status\s*(?:code)?\s*)?[:=]?\s*(\d{3})\b/i,
	/\bstatus(?:[_\s-]?code)?\s*[:=]\s*(\d{3})\b/i,
	/\b(?:error[_\s-]?)?code\s*[:=]\s*(\d{3})\b/i,
	/"(?:status|statusCode|code)"\s*:\s*(\d{3})\b/i,
];

const HTML_ENTITY_PATTERN = /&(?:nbsp|lt|gt|quot|apos|amp|#0*39|#x27);/gi;

const HTML_ENTITIES: Readonly<Record<string, string>> = {
	"&nbsp;": " ",
	"&lt;": "<",
	"&gt;": ">",
	"&quot;": '"',
	"&apos;": "'",
	"&#39;": "'",
	"&#x27;": "'",
	"&amp;": "&",
};

function collapseWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function clipSummary(text: string): string {
	if (text.length <= MODEL_ERROR_SUMMARY_CAP) return text;
	return `${text.slice(0, MODEL_ERROR_SUMMARY_CAP - 1).trimEnd()}…`;
}

/** 提取 HTTP 状态码；没有合法状态码（100-599）返回 undefined。 */
export function extractModelErrorStatus(text: string): number | undefined {
	for (const pattern of STATUS_PATTERNS) {
		const hit = pattern.exec(text);
		if (!hit) continue;
		const value = Number(hit[1]);
		if (Number.isInteger(value) && value >= 100 && value <= 599) return value;
	}
	return undefined;
}

/** 错误文本 → 一行可读摘要：去标签、还原常见实体、折叠空白、截断。 */
export function summarizeModelErrorText(text: string): string {
	const stripped = String(text ?? "")
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]*>/g, " ")
		.replace(HTML_ENTITY_PATTERN, (entity) => HTML_ENTITIES[entity.toLowerCase()] ?? " ");
	return clipSummary(collapseWhitespace(stripped));
}

function detectKind(text: string, status?: number): ModelErrorKind {
	if (QUOTA_PATTERN.test(text)) return "quota";
	if (AUTH_PATTERN.test(text) || status === 401 || status === 403) return "auth";
	if (HTML_PATTERN.test(text) || GATEWAY_PATTERN.test(text)) return "gateway";
	if (status !== undefined && GATEWAY_STATUS.has(status)) return "gateway";
	if (MODEL_PATTERN.test(text)) return "model";
	// 4xx（408/409/429 归网关侧瞬态）说明服务端读懂了请求并拒绝：算模型侧拒绝。
	if (status !== undefined && status >= 400 && status < 500 && status !== 409 && status !== 429) return "model";
	return "unknown";
}

/** 摘要开头重复的状态码去掉（状态码另有单独字段展示，不重复念两遍）。 */
function stripLeadingStatus(summary: string, status: number): string {
	const hit = new RegExp(`^${status}(?![0-9])\\s*[:.\\-–—]?\\s*`).exec(summary);
	return hit ? summary.slice(hit[0].length) : summary;
}

/** 唯一的错误分类入口：同一段错误文本永远得到同一份分类结果（纯函数）。 */
export function classifyModelError(text: string): ModelErrorInfo {
	const raw = typeof text === "string" ? text : String(text ?? "");
	const status = extractModelErrorStatus(raw);
	const cleaned = summarizeModelErrorText(raw);
	const info: ModelErrorInfo = {
		kind: detectKind(raw, status),
		summary: status === undefined ? cleaned : stripLeadingStatus(cleaned, status),
		raw,
	};
	if (status !== undefined) info.status = status;
	return info;
}

/** 分类结果 → 线上投影：原文已经在 `errorMessage` 上，不再重复传一份 raw。 */
export function modelErrorReport(info: ModelErrorInfo): ModelErrorReport {
	const report: ModelErrorReport = { kind: info.kind, summary: info.summary };
	if (info.status !== undefined) report.status = info.status;
	return report;
}

/** 分类的人读短标签（服务端文案：子代理通知 / verdict 共用一份）。 */
export function modelErrorKindLabel(kind: ModelErrorKind, lang: ServerLang = "en"): string {
	switch (kind) {
		case "gateway":
			return pick(lang, "网关/代理错误", "Gateway/proxy error", "modelError.kind.gateway");
		case "auth":
			return pick(lang, "鉴权失败", "Authentication failed", "modelError.kind.auth");
		case "quota":
			return pick(lang, "配额不足", "Quota exhausted", "modelError.kind.quota");
		case "model":
			return pick(lang, "模型拒绝请求", "Model rejected the request", "modelError.kind.model");
		default:
			return pick(lang, "模型调用失败", "Model call failed", "modelError.kind.unknown");
	}
}

/** 分类 → 一行简报，口径与 UI 气泡一致：`网关/代理错误 · HTTP 408 · 408 Request Time-out …`。 */
export function formatModelErrorBrief(info: ModelErrorInfo, lang: ServerLang = "en"): string {
	const parts = [modelErrorKindLabel(info.kind, lang)];
	if (info.status !== undefined) parts.push(`HTTP ${info.status}`);
	if (info.summary) parts.push(info.summary);
	return parts.join(" · ");
}
