/**
 * preset-share — 设置预设的导入 / 导出 / 分享 / 社区目录（共享仓库）。
 *
 * 一条预设要能离线传、能贴到 issue 里、能按网址导入、能一键发到社区仓库，
 * 所以这里统一定义**交换格式**（`pi-web-ui-preset` v1）并给出四种路径：
 *
 *   导出 preset_export      → 保序的 JSON 文本（复制 / 下载 / 交给别人）
 *   导入 preset_import      → 解析 + 白名单净化 + （dryRun 时只预览）
 *   网址 preset_import_url  → 服务端抓取（避开浏览器 CORS），再走导入
 *   分享 preset_share       → gh CLI 开 issue（失败时回落预填的网页）
 *   目录 preset_catalog     → 拉共享仓库的 index.json，列出可浏览/可导入的预设
 *
 * 纪律（和 plugin-catalog-sync 一致）：
 *   1. **只信白名单**：导入的 settings 只按已知字段与类型取值，未知字段丢弃并在
 *      预览里列出来；任何类型不符的字段也丢弃（绝不把外部 JSON 直接摊进设置）；
 *   2. **有上限**：文档、单字段、列表长度都有硬上限，一条超大 JSON 不能顶爆内存；
 *   3. **抓取收口**：只用注入的 Fetcher，带超时与大小上限；拒绝内网/回环地址
 *      （SSRF 收口），http/https 之外一律不抓。
 *
 * 纯函数（slugify / parseShareDoc / sanitizePresetSettings / normalizeCatalog …）
 * 与副作用（createPresetIssue / fetchPresetCatalog）分开，便于单测。
 */
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
	normalizeDisabledPluginTools,
	normalizeRetryMaxAttempts,
	normalizeSkillList,
	normalizeUiLayout,
	type SettingsPreset,
} from "./client-state.js";
import { pick, type ServerLang } from "./i18n.js";
import type { ClientMessage, ServerMessage, UiPresetCatalogEntry, UiPresetImportPreview } from "./protocol.js";
import { normalizeSoftCapByModel, normalizeSoftCapTokens } from "./soft-cap.js";
import {
	ALL_KNOWN_AGENT_TOOL_NAMES,
	isConfigurableAgentTool,
	normalizeDisabledAgentTools,
	resolveDisabledAgentToolsFromEnabled,
	resolveEnabledAgentTools,
} from "./tool-manager.js";
import { normalizeToolPromptOverrides } from "./tool-prompt-overrides.js";
import { PRESET_FIELD_NAMES, normalizePresetFieldSelection } from "./preset-fields.js";
import { defaultFetcher } from "./update-check.js";

const execFileAsync = promisify(execFile);

/** 预览文本的截断长度（设置面板展示用）。 */
const PREVIEW_TEXT_MAX = 400;

/** 交换格式标识与版本（仓库 scripts/ingest-preset.mjs 里同名常量必须一致）。 */
export const PRESET_SHARE_FORMAT = "pi-web-ui-preset";
export const PRESET_SHARE_VERSION = 1;
/** 社区共享仓库（可用 PI_WEB_PRESET_REPO 换成自己的 fork）。 */
export const DEFAULT_PRESET_REPO = "xing-shuyin/pi-web-ui-presets";
/** 单个导入文档上限（字节）——与仓库收录脚本一致。 */
export const PRESET_JSON_MAX_BYTES = 512 * 1024;
/** 单个大文本字段上限（自定义系统提示词/模板/审查提示词）。 */
export const PRESET_TEXT_MAX_LEN = 100_000;
/** 列表字段条数上限与单条长度上限。 */
export const PRESET_LIST_MAX = 500;
export const PRESET_LIST_ITEM_MAX = 200;
/** 映射字段（promptOverrides / softCapByModel）条目上限。 */
export const PRESET_MAP_MAX = 200;
/** 短字符串字段（模型 id / 预设 id）长度上限。 */
export const PRESET_SHORT_STR_MAX = 300;

const FETCH_TIMEOUT_MS = 10_000;
const CATALOG_MAX_BYTES = 512 * 1024;
const CATALOG_MAX_ENTRIES = 500;
/** 目录缓存有效期（刷新按钮可绕过）。 */
export const PRESET_CATALOG_TTL_MS = 5 * 60_000;
const NAME_MAX = 60;
const DESCRIPTION_MAX = 500;
const AUTHOR_MAX = 80;
const TAG_MAX = 24;
const TAG_COUNT_MAX = 8;

/* ------------------------------------------------------------------ */
/* 配置（env 在调用时读取，便于测试与热改）                            */
/* ------------------------------------------------------------------ */

/** 本包版本（写进交换文档的 appVersion；读不到就空串）。首次调用时读一次。 */
let cachedPackageVersion: string | null = null;
export function packageVersion(): string {
	if (cachedPackageVersion === null) {
		try {
			const pkg = JSON.parse(
				readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
			) as {
				version?: string;
			};
			cachedPackageVersion = pkg.version ?? "";
		} catch {
			cachedPackageVersion = "";
		}
	}
	return cachedPackageVersion;
}

/** 只需要读到「文本响应」的抓取器形状（比 update-check 的 Fetcher 多 text()）。
 *  取值仍复用 defaultFetcher，测试注入假件即可。 */
export type TextFetcher = (
	url: string,
	init?: {
		signal?: AbortSignal;
		headers?: Record<string, string>;
		method?: string;
		body?: string;
	},
) => Promise<{ ok: boolean; status: number; statusText?: string; text: () => Promise<string> }>;

/** 真实网络的抓取器（与 update-check 的 defaultFetcher 同一个实现）。 */
export const defaultTextFetcher: TextFetcher = defaultFetcher as unknown as TextFetcher;

/** 共享仓库 `owner/name`（PI_WEB_PRESET_REPO；off/0/false/no = 关闭分享）。 */
export function presetShareRepo(): string {
	const raw = process.env.PI_WEB_PRESET_REPO?.trim();
	// 未设/空串 = 用官方仓库；显式 off/0/false/no = 关掉分享。
	if (raw === undefined || raw === "") return DEFAULT_PRESET_REPO;
	if (/^(0|off|false|no)$/i.test(raw)) return "";
	return raw
		.replace(/^https?:\/\/(www\.)?github\.com\//i, "")
		.replace(/\.git$/i, "")
		.replace(/\/+$/, "");
}

/** 仓库目录地址（PI_WEB_PRESET_CATALOG_URL；显式空/off = 关闭浏览）。 */
export function presetCatalogUrl(repo = presetShareRepo()): string {
	const raw = process.env.PI_WEB_PRESET_CATALOG_URL?.trim();
	if (raw !== undefined && raw !== "") {
		if (/^(0|off|false|no)$/i.test(raw)) return "";
		return raw;
	}
	if (!repo) return "";
	return `https://raw.githubusercontent.com/${repo}/main/index.json`;
}

/** 仓库页面地址（issue 落点、目录来源展示）。 */
export function presetRepoUrl(repo = presetShareRepo()): string {
	return repo ? `https://github.com/${repo}` : "";
}

/** 分享用的 GitHub 令牌（无 gh 时的直连 API 路径）：
 *  `PI_WEB_PRESET_TOKEN`（显式）> `GH_TOKEN` > `GITHUB_TOKEN`；空串 = 不启用。 */
export function presetShareToken(): string {
	return (process.env.PI_WEB_PRESET_TOKEN ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? "").trim();
}

/* ------------------------------------------------------------------ */
/* 纯函数：格式化与净化                                                */
/* ------------------------------------------------------------------ */

/**
 * 预设名 → 文件名 slug。必须与共享仓库 scripts/ingest-preset.mjs 的 slugify 同源
 * （非 ASCII 名字（中文）会退化成 "preset"，靠短哈希区分）。
 */
export function slugifyPresetName(name: string): string {
	const ascii = String(name ?? "")
		.normalize("NFKD")
		// eslint-disable-next-line no-control-regex
		.replace(/[^\x00-\x7F]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return ascii || "preset";
}

/** 短哈希（文件名去重 + 内容指纹）。取 djb2 的**低位**（高位对短字符串变化很慢，
 *  截前 7 位会撞）；共享仓库那边用 sha1 前 7 位，这里只需稳定且足够散。 */
export function presetShortHash(text: string): string {
	let h = 5381;
	for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
	return h.toString(16).padStart(8, "0").slice(-7);
}

/** 分享文件名（下载时用；导入不依赖文件名）。 */
export function presetFileName(name: string): string {
	return `${slugifyPresetName(name)}-${presetShortHash(name)}.json`;
}

/** 交换文档（导出/分享的顶层结构）。 */
export interface PresetShareDoc {
	format: string;
	version: number;
	name: string;
	description: string;
	author: string;
	tags: string[];
	createdAt: string;
	appVersion: string;
	/** 预设显式启用的工具白名单（默认没开的工具就是关，跨版本防错）。 */
	enabledTools?: string[];
	settings: Record<string, unknown>;
}

export interface PresetShareMeta {
	description?: string;
	author?: string;
	tags?: string[];
	appVersion?: string;
	createdAt?: string;
}

/** 用户可见/模型可见文案的短上限裁剪（去首尾空白 + 截断）。 */
function clampText(v: unknown, max: number): string {
	return typeof v === "string" ? v.trim().slice(0, max) : "";
}

/** 标签归一化：去空白、去重、单条 ≤ TAG_MAX、最多 TAG_COUNT_MAX 条。 */
export function normalizeTags(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	const out: string[] = [];
	for (const item of v) {
		const t = clampText(item, TAG_MAX);
		if (t && !out.includes(t)) out.push(t);
		if (out.length >= TAG_COUNT_MAX) break;
	}
	return out;
}

/** 预设名归一化：压缩空白 + 截断；空名返回 ""（调用方决定是否报错）。 */
export function normalizePresetName(v: unknown): string {
	return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, NAME_MAX) : "";
}

/**
 * 组装交换文档。settings 必须是**已净化**的对象（见 sanitizePresetSettings）；
 * 这里只负责外壳字段的裁剪与默认值。
 */
export function buildShareDoc(
	name: string,
	settings: Record<string, unknown>,
	meta: PresetShareMeta = {},
): PresetShareDoc {
	const doc: PresetShareDoc = {
		format: PRESET_SHARE_FORMAT,
		version: PRESET_SHARE_VERSION,
		name: normalizePresetName(name),
		description: clampText(meta.description, DESCRIPTION_MAX),
		author: clampText(meta.author, AUTHOR_MAX),
		tags: normalizeTags(meta.tags),
		createdAt: typeof meta.createdAt === "string" && meta.createdAt ? meta.createdAt : new Date().toISOString(),
		appVersion: clampText(meta.appVersion, 40),
		settings,
	};
	if (Array.isArray(settings["disabledAgentTools"])) {
		doc.enabledTools = resolveEnabledAgentTools(settings["disabledAgentTools"] as string[]);
	}
	return doc;
}

/** 交换文档 → JSON 文本（Tab 缩进，和仓库里的收录文件一致，diff 友好）。 */
export function serializeShareDoc(doc: PresetShareDoc): string {
	return JSON.stringify(doc, null, "\t") + "\n";
}

/** 字符串列表净化（去空白/去重/上限）。 */
function sanitizeStringList(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	const out: string[] = [];
	for (const item of v) {
		const s = typeof item === "string" ? item.trim() : "";
		if (!s || s.length > PRESET_LIST_ITEM_MAX) continue;
		if (!out.includes(s)) out.push(s);
		if (out.length >= PRESET_LIST_MAX) break;
	}
	return out;
}

/** 长文本映射净化（key ≤ 100，value ≤ PRESET_TEXT_MAX_LEN）。 */
function sanitizeTextMap(v: unknown): Record<string, string> {
	if (!v || typeof v !== "object" || Array.isArray(v)) return {};
	const out: Record<string, string> = {};
	for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
		if (Object.keys(out).length >= PRESET_MAP_MAX) break;
		const key = k.trim().slice(0, 100);
		if (!key || typeof val !== "string") continue;
		out[key] = val.slice(0, PRESET_TEXT_MAX_LEN);
	}
	return out;
}

/**
 * 预设字段白名单：字段名 → 取值方式。**与 ClientSettings 一一对应**（含界面偏好与
 * 逐工具文案），字段清单与分组在 `server/preset-fields.ts`（零依赖，前端也用）。
 * 单测 `tests/unit/preset-share.test.ts` 守卫两边一致（漏字段/多字段均失败）。
 */
const PRESET_FIELD_KINDS = {
	// -- prompt ----------------------------------------------------------
	promptMode: "promptMode",
	customSystemPrompt: "text",
	promptTemplate: "text",
	promptOverrides: "textMap",
	reviewPrompt: "text",
	reviewDisabledSkills: "list",
	// -- tools -----------------------------------------------------------
	disabledAgentTools: "list",
	disabledPluginTools: "list",
	toolPromptOverrides: "toolPromptOverrides",
	toolLazyLoading: "bool",
	codemodeMode: "codemodeMode",
	codemodeInlineBudget: "number",
	readDirEnabled: "bool",
	bgAutoCleanupMin: "number",
	toolApprovalEnabled: "bool",
	toolWatchdogTimeoutMs: "number",
	questionnaireEnabled: "bool",
	editSoftEnabled: "bool",
	terminalToolsEnabled: "bool",
	// -- terminal --------------------------------------------------------
	terminalBash: "bool",
	terminalBashIdleMs: "number",
	terminalBashMaxForegroundMs: "number",
	// -- skills ----------------------------------------------------------
	disabledSkills: "list",
	disabledExtensions: "list",
	skillsFullText: "list",
	// -- ai --------------------------------------------------------------
	retryMaxAttempts: "retry",
	softCapTokens: "softCap",
	softCapByModel: "softCapByModel",
	subagentDefaultModel: "nullableString",
	visionBridgeEnabled: "bool",
	visionBridgeModel: "nullableString",
	visionBridgePromptMode: "promptMode",
	visionBridgePrompt: "text",
	scmCommitMsgPromptMode: "promptMode",
	scmCommitMsgPrompt: "text",
	planModePromptMode: "promptMode",
	planModePrompt: "text",
	goalModeEnabled: "bool",
	parallelReminderEnabled: "bool",
	// -- ui --------------------------------------------------------------
	uiLayout: "uiLayout",
	disabledPlugins: "list",
	thinkingWrap: "bool",
	toolsWrap: "bool",
	toolImagesEnabled: "bool",
	keepRecentMessages: "number",
	quickPhrases: "list",
	quickPhrasesEnabled: "bool",
	devNoCache: "bool",
	autoReload: "bool",
	// -- engine ----------------------------------------------------------
	defaultAgentPreset: "shortString",
	defaultPermissionPreset: "shortString",
} as const satisfies Record<string, string>;

/** 已知字段名（预览/勾选/测试用；顺序 = preset-fields 的分组顺序）。 */
export const PRESET_FIELD_KIND_NAMES = Object.keys(PRESET_FIELD_KINDS);
/** 已排序的字段名（净化回执/测试用）；顺序版在 `preset-fields.ts`。 */
export const PRESET_FIELD_NAMES_SORTED = [...PRESET_FIELD_NAMES].sort();

/** 已知字段名（预览与测试用）。 */
export { PRESET_FIELD_NAMES };

export interface SanitizeResult {
	/** 只含白名单字段的净化结果。 */
	settings: Record<string, unknown>;
	/** 实际保留下来的字段名（排序）。 */
	fields: string[];
	/** 被丢弃的未知字段名（排序）——含拼错的字段，预览里提示用户。 */
	ignored: string[];
	/** 类型不符被丢弃的已知字段名（排序）。 */
	rejected: string[];
}

/**
 * 把任意来源的 settings 对象净化成「可安全写入预设存储」的形状：
 * 只认识白名单字段，类型不符/超限的字段丢弃（而不是抛错），未知字段记录下来。
 * 贯彻「默认没有开的工具就是关，只取可用的配置，后期发生变化也防止出错」原则。
 */
export function sanitizePresetSettings(input: unknown, opts?: { enabledTools?: unknown }): SanitizeResult {
	const src = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
	const settings: Record<string, unknown> = {};
	const ignored: string[] = [];
	const rejected: string[] = [];
	for (const key of Object.keys(src)) {
		if (!(key in PRESET_FIELD_KINDS)) ignored.push(key);
	}
	for (const [key, kind] of Object.entries(PRESET_FIELD_KINDS)) {
		if (!(key in src)) continue;
		const raw = src[key];
		switch (kind) {
			case "promptMode":
				if (raw === "append" || raw === "replace") settings[key] = raw;
				else rejected.push(key);
				break;
			case "text": {
				if (typeof raw !== "string") {
					rejected.push(key);
					break;
				}
				if (raw.length > PRESET_TEXT_MAX_LEN) {
					rejected.push(key);
					break;
				}
				settings[key] = raw;
				break;
			}
			case "textMap":
				if (!raw || typeof raw !== "object" || Array.isArray(raw)) rejected.push(key);
				else settings[key] = sanitizeTextMap(raw);
				break;
			case "list": {
				if (!Array.isArray(raw)) {
					rejected.push(key);
					break;
				}
				if (key === "disabledAgentTools") {
					// 只取可用配置：清洗掉不在当前系统已知工具清单中的未知工具名并提示用户
					for (const item of raw) {
						if (typeof item === "string" && !isConfigurableAgentTool(item)) {
							ignored.push(`disabledAgentTools.${item}`);
						}
					}
					// 默认没有开的工具就是关：若声明了显式开启白名单，以开启集合为准收敛
					if (Array.isArray(opts?.enabledTools)) {
						const enabled = opts!.enabledTools.filter((x): x is string => typeof x === "string");
						settings[key] = resolveDisabledAgentToolsFromEnabled(enabled);
					} else {
						settings[key] = normalizeDisabledAgentTools(raw);
					}
				} else if (key === "disabledPluginTools") {
					settings[key] = normalizeDisabledPluginTools(raw);
				} else if (key === "skillsFullText") {
					settings[key] = normalizeSkillList(raw);
				} else {
					settings[key] = sanitizeStringList(raw);
				}
				break;
			}
			case "bool":
				if (typeof raw === "boolean") settings[key] = raw;
				else rejected.push(key);
				break;
			case "codemodeMode":
				if (raw === "on" || raw === "only") settings[key] = raw;
				else rejected.push(key);
				break;
			case "number":
				if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) settings[key] = Math.floor(raw);
				else rejected.push(key);
				break;
			case "retry":
				if (typeof raw === "number" && Number.isFinite(raw)) settings[key] = normalizeRetryMaxAttempts(raw);
				else rejected.push(key);
				break;
			case "softCap":
				if (typeof raw === "number" && Number.isFinite(raw)) settings[key] = normalizeSoftCapTokens(raw);
				else rejected.push(key);
				break;
			case "softCapByModel":
				if (raw && typeof raw === "object" && !Array.isArray(raw)) {
					settings[key] = normalizeSoftCapByModel(raw);
				} else rejected.push(key);
				break;
			case "nullableString":
				// 约定：null / 空串 = 自动（如 visionBridgeModel / subagentDefaultModel）。
				if (raw === null) settings[key] = null;
				else if (typeof raw === "string" && raw.length <= PRESET_SHORT_STR_MAX) settings[key] = raw;
				else rejected.push(key);
				break;
			case "shortString":
				if (typeof raw === "string" && raw.length <= PRESET_SHORT_STR_MAX) settings[key] = raw;
				else rejected.push(key);
				break;
			case "toolPromptOverrides":
				// 只取可用的配置：清洗掉当前系统未知的工具覆盖，丢弃并回报 ignored，防后期漂移
				if (raw && typeof raw === "object" && !Array.isArray(raw)) {
					for (const toolName of Object.keys(raw as Record<string, unknown>)) {
						if (!isConfigurableAgentTool(toolName)) {
							ignored.push(`toolPromptOverrides.${toolName}`);
						}
					}
					settings[key] = normalizeToolPromptOverrides(raw, ALL_KNOWN_AGENT_TOOL_NAMES);
				} else {
					rejected.push(key);
				}
				break;
			case "uiLayout":
				// 界面布局：normalizeUiLayout 本身就只认已知键 + 长度/条数上限。
				if (raw && typeof raw === "object" && !Array.isArray(raw)) settings[key] = normalizeUiLayout(raw);
				else rejected.push(key);
				break;
		}
	}
	return {
		settings,
		fields: Object.keys(settings).sort(),
		ignored: ignored.sort(),
		rejected: rejected.sort(),
	};
}

/** 把交换文档的 settings 补全成预设对象。
 *
 * 只带回文档里**实际存在**的字段（缺失的由 `applyPreset` 回落当前值）——旧版文档、
 * 以及导入时按勾选过滤后的子集都能原样落盘；规范化已在 `sanitizePresetSettings` 做过了。
 */
export function toSettingsPreset(name: string, settings: Record<string, unknown>): SettingsPreset {
	return { name: normalizePresetName(name), ...(settings as Partial<SettingsPreset>) };
}

/* ------------------------------------------------------------------ */
/* 纯函数：解析（外部 JSON → 交换文档）                                */
/* ------------------------------------------------------------------ */

export type PresetParseFailure = { ok: false; error: string; errorKey: string };
export type PresetParseSuccess = { ok: true; doc: PresetShareDoc; sanitized: SanitizeResult };
export type PresetParseResult = PresetParseSuccess | PresetParseFailure;

function fail(lang: ServerLang, key: string, zh: string, en: string): PresetParseFailure {
	return { ok: false, error: pick(lang, zh, en, key), errorKey: key };
}

/**
 * 从粘贴/文件文本里取出 JSON：优先第一个 ```json 代码块（issue 正文/README 里
 * 直接复制的那种），否则整段当 JSON。前后多余文字不参与解析。
 */
export function extractJsonPayload(raw: string): { text: string } | { error: string } {
	const text = String(raw ?? "")
		.replace(/^\uFEFF/, "")
		.trim();
	if (!text) return { error: "empty" };
	const fence = /```(?:json|JSON)?\s*\n([\s\S]*?)```/.exec(text);
	const body = (fence ? fence[1] : text).trim();
	if (!body) return { error: "empty" };
	return { text: body };
}

/**
 * 解析交换文档：形状校验（format/version/name/settings）→ settings 白名单净化。
 * 失败时给出**已本地化**的 error 与稳定的 errorKey（测试与埋点用）。
 */
export function parseShareDoc(raw: string, lang: ServerLang = "en"): PresetParseResult {
	const extracted = extractJsonPayload(raw);
	if ("error" in extracted) {
		return fail(
			lang,
			"presets.import.empty",
			"没有可解析的内容（粘贴 JSON 或选择文件）",
			"Nothing to parse (paste JSON or pick a file)",
		);
	}
	const text = extracted.text;
	if (Buffer.byteLength(text, "utf8") > PRESET_JSON_MAX_BYTES) {
		return fail(
			lang,
			"presets.import.tooLarge",
			`内容过大（上限 ${Math.round(PRESET_JSON_MAX_BYTES / 1024)} KB）`,
			`Content too large (limit ${Math.round(PRESET_JSON_MAX_BYTES / 1024)} KB)`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		return fail(
			lang,
			"presets.import.parse",
			`JSON 解析失败：${err instanceof Error ? err.message : String(err)}`,
			`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (Array.isArray(parsed)) {
		// 有人会把多个预设打包成一个数组发出来：取第一个（单个元素时就是它本身）。
		if (parsed.length === 0) return fail(lang, "presets.import.empty", "数组里没有预设", "The array has no presets");
		parsed = parsed[0];
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return fail(lang, "presets.import.shape", "JSON 顶层必须是一个对象", "The JSON root must be an object");
	}
	const doc = parsed as Record<string, unknown>;
	if (doc["format"] !== PRESET_SHARE_FORMAT) {
		return fail(
			lang,
			"presets.import.format",
			`不是 pi-web-ui 预设（format 应为 "${PRESET_SHARE_FORMAT}"）`,
			`Not a pi-web-ui preset (format must be "${PRESET_SHARE_FORMAT}")`,
		);
	}
	if (doc["version"] !== PRESET_SHARE_VERSION) {
		return fail(
			lang,
			"presets.import.version",
			`不支持的预设版本：${JSON.stringify(doc["version"])}（本版只认 ${PRESET_SHARE_VERSION}）`,
			`Unsupported preset version: ${JSON.stringify(doc["version"])} (this build reads ${PRESET_SHARE_VERSION})`,
		);
	}
	const name = normalizePresetName(doc["name"]);
	if (!name) {
		return fail(lang, "presets.import.name", "预设名不能为空", "The preset name cannot be empty");
	}
	if (!doc["settings"] || typeof doc["settings"] !== "object" || Array.isArray(doc["settings"])) {
		return fail(lang, "presets.import.settings", "缺少 settings 对象", "Missing the settings object");
	}
	const rawEnabled = Array.isArray(doc["enabledTools"])
		? (doc["enabledTools"] as unknown[]).filter((x): x is string => typeof x === "string")
		: undefined;
	const sanitized = sanitizePresetSettings(doc["settings"], { enabledTools: rawEnabled });
	if (sanitized.fields.length === 0) {
		return fail(
			lang,
			"presets.import.noFields",
			"settings 里没有可识别的字段（可能不是本工具的预设）",
			"No recognized settings fields (this may not be a pi-web-ui preset)",
		);
	}
	return {
		ok: true,
		doc: {
			format: PRESET_SHARE_FORMAT,
			version: PRESET_SHARE_VERSION,
			name,
			description: clampText(doc["description"], DESCRIPTION_MAX),
			author: clampText(doc["author"], AUTHOR_MAX),
			tags: normalizeTags(doc["tags"]),
			createdAt: clampText(doc["createdAt"], 40),
			appVersion: clampText(doc["appVersion"], 40),
			...(rawEnabled ? { enabledTools: rawEnabled } : {}),
			settings: sanitized.settings,
		},
		sanitized,
	};
}

/** 列表展示摘要（与仓库脚本 summarize 同义）。 */
export function presetSummary(settings: Record<string, unknown>): NonNullable<UiPresetCatalogEntry["summary"]> {
	const len = (v: unknown) => (Array.isArray(v) ? v.length : 0);
	return {
		promptMode: settings["promptMode"] === "replace" ? "replace" : "append",
		skills: len(settings["disabledSkills"]) + len(settings["reviewDisabledSkills"]),
		agentTools: len(settings["disabledAgentTools"]) + len(settings["disabledPluginTools"]),
		hasTemplate: typeof settings["promptTemplate"] === "string" && settings["promptTemplate"].trim().length > 0,
		hasReviewPrompt: typeof settings["reviewPrompt"] === "string" && settings["reviewPrompt"].trim().length > 0,
	};
}

/* ------------------------------------------------------------------ */
/* 抓取（目录 / 网址导入）                                             */
/* ------------------------------------------------------------------ */

/** SSRF 收口：内网/回环/链路本地地址一律拒绝（预设来源只该是公网）。 */
export function isBlockedHost(hostname: string): boolean {
	const host = hostname
		.trim()
		.toLowerCase()
		.replace(/^\[|\]$/g, "");
	if (!host) return true;
	if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
		return true;
	}
	if (host === "::1" || host === "::" || host.startsWith("fe80:") || /^f[cd][0-9a-f]{2}:/.test(host)) return true;
	const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (!m) return false;
	const [a, b] = [Number(m[1]), Number(m[2])];
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		a >= 224
	);
}

/** 校验一个可抓取地址：只允许 http/https 且非内网。 */
export function validateFetchUrl(raw: string): { ok: true; url: string } | { ok: false; reason: "scheme" | "host" } {
	let u: URL;
	try {
		u = new URL(String(raw ?? "").trim());
	} catch {
		return { ok: false, reason: "scheme" };
	}
	if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, reason: "scheme" };
	if (isBlockedHost(u.hostname)) return { ok: false, reason: "host" };
	return { ok: true, url: u.toString() };
}

/** 带超时与大小上限的抓取（只走注入的 Fetcher）。 */
export async function fetchText(
	url: string,
	opts: { fetcher?: TextFetcher; timeoutMs?: number; maxBytes?: number } = {},
): Promise<{ ok: true; text: string } | { ok: false; error: string; errorKey: string }> {
	const fetcher = opts.fetcher ?? defaultTextFetcher;
	const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
	const maxBytes = opts.maxBytes ?? PRESET_JSON_MAX_BYTES;
	const res = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs) });
	if (!res.ok) {
		return {
			ok: false,
			errorKey: "presets.fetch.status",
			error: `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`,
		};
	}
	const text = await res.text();
	if (Buffer.byteLength(text, "utf8") > maxBytes) {
		return {
			ok: false,
			errorKey: "presets.fetch.tooLarge",
			error: `Content too large (> ${Math.round(maxBytes / 1024)} KB)`,
		};
	}
	return { ok: true, text };
}

/** 目录地址 → 仓库 raw 基址（`…/main/index.json` → `…/main`），用于拼预设文件地址。 */
export function catalogBaseUrl(catalogUrl: string): string {
	return catalogUrl.replace(/\/[^/]*$/, "");
}

/** index.json 条目 → 协议条目（形状不符返回 null，调用方丢弃）。 */
export function normalizeCatalogEntry(raw: unknown, base: string, repoUrl: string): UiPresetCatalogEntry | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const e = raw as Record<string, unknown>;
	const id = clampText(e["id"], 80);
	const name = normalizePresetName(e["name"]);
	const file = clampText(e["file"], 200);
	if (!id || !name || !file) return null;
	// file 只能是仓库内的相对路径：挡掉 ../ 与绝对地址（目录是外部数据）。
	if (file.startsWith("/") || file.includes("..") || /^[a-z]+:/i.test(file)) return null;
	const issue = typeof e["issue"] === "number" && Number.isFinite(e["issue"]) ? Math.floor(e["issue"]) : 0;
	const summary =
		e["summary"] && typeof e["summary"] === "object" ? (e["summary"] as Record<string, unknown>) : undefined;
	return {
		id,
		name,
		description: clampText(e["description"], DESCRIPTION_MAX),
		author: clampText(e["author"], AUTHOR_MAX),
		tags: normalizeTags(e["tags"]),
		url: `${base}/${file}`,
		issueUrl: issue > 0 && repoUrl ? `${repoUrl}/issues/${issue}` : "",
		updatedAt: clampText(e["updatedAt"], 40),
		summary: summary
			? {
					promptMode: summary["promptMode"] === "replace" ? "replace" : "append",
					skills: typeof summary["skills"] === "number" ? summary["skills"] : 0,
					agentTools: typeof summary["agentTools"] === "number" ? summary["agentTools"] : 0,
					hasTemplate: summary["hasTemplate"] === true,
					hasReviewPrompt: summary["hasReviewPrompt"] === true,
				}
			: undefined,
	};
}

/** index.json 文本 → 目录条目（形状不符 = 目录坏了，返回错误而不是空列表）。 */
export function parseCatalog(
	text: string,
	opts: { base: string; repoUrl?: string },
): { ok: true; entries: UiPresetCatalogEntry[] } | { ok: false; error: string; errorKey: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { ok: false, errorKey: "presets.catalog.parse", error: "Catalog JSON is invalid" };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { ok: false, errorKey: "presets.catalog.shape", error: "Catalog root must be an object" };
	}
	const list = (parsed as { presets?: unknown }).presets;
	if (!Array.isArray(list)) {
		return { ok: false, errorKey: "presets.catalog.shape", error: "Catalog is missing the presets array" };
	}
	const seen = new Set<string>();
	const entries: UiPresetCatalogEntry[] = [];
	for (const item of list) {
		if (entries.length >= CATALOG_MAX_ENTRIES) break;
		const entry = normalizeCatalogEntry(item, opts.base, opts.repoUrl ?? "");
		if (!entry || seen.has(entry.id)) continue;
		seen.add(entry.id);
		entries.push(entry);
	}
	// 最近更新的排在前面（没有时间戳的保持仓库顺序）。
	entries.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
	return { ok: true, entries };
}

export interface CatalogResult {
	ok: boolean;
	entries: UiPresetCatalogEntry[];
	/** 数据来源（目录地址；关闭时为 ""）。 */
	source: string;
	cached: boolean;
	fetchedAt: number;
	error?: string;
	errorKey?: string;
}

/**
 * 拉取社区目录（带进程内缓存：5 分钟 TTL，refresh 时绕过）。
 * 失败时**保留上一次成功的列表**（cached=true），这样离线也只是列表变旧。
 */
export async function fetchPresetCatalog(
	opts: {
		url?: string;
		repo?: string;
		fetcher?: TextFetcher;
		refresh?: boolean;
		timeoutMs?: number;
		/** 缓存注入（测试用）。 */
		cache?: PresetCatalogCache;
		lang?: ServerLang;
	} = {},
): Promise<CatalogResult> {
	const repo = opts.repo ?? presetShareRepo();
	const url = opts.url ?? presetCatalogUrl(repo);
	const lang = opts.lang ?? "en";
	const cache = opts.cache ?? sharedCatalogCache;
	if (!url) {
		return {
			ok: false,
			entries: [],
			source: "",
			cached: false,
			fetchedAt: 0,
			error: pick(
				lang,
				"未配置共享预设目录（PI_WEB_PRESET_CATALOG_URL）",
				"No shared preset catalog configured (PI_WEB_PRESET_CATALOG_URL)",
				"presets.catalog.disabled",
			),
			errorKey: "presets.catalog.disabled",
		};
	}
	const hit = cache.get(url);
	const now = Date.now();
	if (!opts.refresh && hit && now - hit.fetchedAt < PRESET_CATALOG_TTL_MS) {
		return { ok: true, entries: hit.entries, source: url, cached: true, fetchedAt: hit.fetchedAt };
	}
	const valid = validateFetchUrl(url);
	if (!valid.ok) {
		return {
			ok: false,
			entries: hit?.entries ?? [],
			source: url,
			cached: !!hit,
			fetchedAt: hit?.fetchedAt ?? 0,
			error: pick(lang, "目录地址不合法", "Invalid catalog URL", "presets.catalog.url"),
			errorKey: "presets.catalog.url",
		};
	}
	try {
		const res = await fetchText(valid.url, {
			fetcher: opts.fetcher,
			timeoutMs: opts.timeoutMs ?? FETCH_TIMEOUT_MS,
			maxBytes: CATALOG_MAX_BYTES,
		});
		if (!res.ok) throw new Error(res.error);
		const parsed = parseCatalog(res.text, { base: catalogBaseUrl(valid.url), repoUrl: presetRepoUrl(repo) });
		if (!parsed.ok) throw new Error(parsed.error);
		cache.set(url, { entries: parsed.entries, fetchedAt: now });
		return { ok: true, entries: parsed.entries, source: valid.url, cached: false, fetchedAt: now };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			entries: hit?.entries ?? [],
			source: valid.url,
			cached: !!hit,
			fetchedAt: hit?.fetchedAt ?? 0,
			error: pick(
				lang,
				`拉取共享预设目录失败：${message}`,
				`Failed to fetch the shared preset catalog: ${message}`,
				"presets.catalog.failed",
				{ message },
			),
			errorKey: "presets.catalog.failed",
		};
	}
}

/** 目录缓存接口（测试可注入假件）。 */
export interface PresetCatalogCache {
	get(url: string): { entries: UiPresetCatalogEntry[]; fetchedAt: number } | undefined;
	set(url: string, value: { entries: UiPresetCatalogEntry[]; fetchedAt: number }): void;
	clear(): void;
}

/** 进程内目录缓存（单进程服务；重启即失效）。 */
export const sharedCatalogCache: PresetCatalogCache = (() => {
	const map = new Map<string, { entries: UiPresetCatalogEntry[]; fetchedAt: number }>();
	return {
		get: (url) => map.get(url),
		set: (url, value) => {
			map.clear();
			map.set(url, value);
		},
		clear: () => map.clear(),
	};
})();

/** 测试用：清掉目录缓存。 */
export function clearPresetCatalogCache(): void {
	sharedCatalogCache.clear();
}

/* ------------------------------------------------------------------ */
/* 分享（gh issue create，失败回落预填网页）                           */
/* ------------------------------------------------------------------ */

/** 一键分享的 issue 标题前缀（仓库 Action 按此前缀触发收录）。 */
export function presetIssueTitle(name: string): string {
	return `[preset] ${name}`;
}

/** issue 正文：```json 代码块 + 一点说明（Action 只取第一个代码块）。 */
export function presetIssueBody(doc: PresetShareDoc, repoUrl: string): string {
	return [
		"由 pi-web-ui「设置 → 预设 → 分享」生成。",
		"",
		"```json",
		serializeShareDoc(doc).trimEnd(),
		"```",
		"",
		`(自动收录脚本会校验并写入 presets/，格式见 ${repoUrl}#readme)`,
	].join("\n");
}

/** 网页回落链接的长度上限（GitHub 对建 Issue 页的 URL 长度约 8K；留足余量，
 *  因为非 ASCII 正文 URL 编码后会膨胀最多 9 倍）。 */
export const PRESET_ISSUE_URL_MAX = 7_000;

/** 网页回落：优先**预填正文**（点一下 Submit 就行，不用粘贴）；正文太大才退回模板页
 *  （模板里就是那个 JSON 输入框，用户自己粘）。
 *
 *  为什么要二选一：GitHub 在带 `template=` 时会**忽略 `body=`**，两个一起给反而要手动粘。 */
export function presetIssueWebUrl(repo: string, name: string, body?: string): string {
	const title = presetIssueTitle(name);
	if (body) {
		const withBody = `https://github.com/${repo}/issues/new?${new URLSearchParams({ title, body })}`;
		if (withBody.length <= PRESET_ISSUE_URL_MAX) return withBody;
	}
	return `https://github.com/${repo}/issues/new?${new URLSearchParams({ title, template: "share-preset.yml" })}`;
}

/**
 * 无 gh 时的直连 API 分享：`POST /repos/{owner}/{repo}/issues`。
 *
 * 有令牌就不需要 gh 可执行文件（容器/CI 里常见）。令牌无效/无权/网络失败 → 调用方
 * 继续回落到预填网页（用户手动点 Submit）。只走注入的 Fetcher，与抓取同一套代理。
 */
export async function createPresetIssueViaApi(opts: {
	repo: string;
	name: string;
	body: string;
	token: string;
	fetcher?: TextFetcher;
	timeoutMs?: number;
}): Promise<{ ok: true; url: string } | { ok: false; error: string; errorKey: string }> {
	const fetcher = opts.fetcher ?? defaultTextFetcher;
	try {
		const res = await fetcher(`https://api.github.com/repos/${opts.repo}/issues`, {
			signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
			headers: {
				accept: "application/vnd.github+json",
				authorization: `Bearer ${opts.token}`,
				"content-type": "application/json",
				"user-agent": "pi-web-ui",
				"x-github-api-version": "2022-11-28",
			},
			method: "POST",
			body: JSON.stringify({ title: presetIssueTitle(opts.name), body: opts.body }),
		});
		const text = await res.text();
		if (!res.ok) {
			// 401/403/404：令牌无效 / 无 repo 权限 / 仓库看不到。带上一段 message 给用户。
			let detail = `HTTP ${res.status}`;
			try {
				const parsed = JSON.parse(text) as { message?: string };
				if (parsed.message) detail = `HTTP ${res.status}: ${parsed.message}`;
			} catch {
				/* 非 JSON 错误体：用状态码 */
			}
			return { ok: false, errorKey: "presets.share.apiFailed", error: detail };
		}
		const parsed = JSON.parse(text) as { html_url?: string };
		const url = typeof parsed.html_url === "string" ? parsed.html_url : "";
		if (!url) return { ok: false, errorKey: "presets.share.noUrl", error: "GitHub API returned no issue URL" };
		return { ok: true, url };
	} catch (err) {
		return {
			ok: false,
			errorKey: "presets.share.apiFailed",
			error: (err instanceof Error ? err.message : String(err)).slice(0, 500),
		};
	}
}

/**
 * 用 gh CLI 开一条收录 issue。gh 不存在/未登录/仓库无权限时返回失败，
 * 由调用方回落到 presetIssueWebUrl（用户自己贴）。
 */
export async function createPresetIssue(opts: {
	repo: string;
	name: string;
	body: string;
	/** gh 可执行文件（默认 PI_WEB_PRESET_GH 或 "gh"）。 */
	ghPath?: string;
	timeoutMs?: number;
}): Promise<{ ok: true; url: string } | { ok: false; error: string; errorKey: string }> {
	const dir = mkdtempSync(join(tmpdir(), "pi-preset-"));
	const bodyFile = join(dir, "body.md");
	const gh = opts.ghPath ?? process.env.PI_WEB_PRESET_GH?.trim() ?? "gh";
	try {
		writeFileSync(bodyFile, opts.body, "utf8");
		const { stdout } = await execFileAsync(
			gh,
			["issue", "create", "--repo", opts.repo, "--title", presetIssueTitle(opts.name), "--body-file", bodyFile],
			{ timeout: opts.timeoutMs ?? 60_000, windowsHide: true, maxBuffer: 1024 * 1024 },
		);
		const url = stdout
			.split(/\r?\n/)
			.map((l) => l.trim())
			.find((l) => /^https?:\/\/\S+\/issues\/\d+$/.test(l));
		if (!url)
			return { ok: false, errorKey: "presets.share.noUrl", error: `gh did not report an issue URL: ${stdout.trim()}` };
		return { ok: true, url };
	} catch (err) {
		const e = err as { stderr?: string; message?: string; code?: string };
		const message = (e.stderr || e.message || String(err)).trim().slice(0, 500);
		return {
			ok: false,
			errorKey: e.code === "ENOENT" ? "presets.share.ghMissing" : "presets.share.ghFailed",
			error: message,
		};
	} finally {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* 临时目录清不掉不影响结果 */
		}
	}
}

/* ------------------------------------------------------------------ */
/* 服务编排（引擎无关）：两个引擎（pi / DSH）各实现一个 PresetSharePort */
/* ------------------------------------------------------------------ */

/**
 * 分享功能需要宿主提供的最小能力集合。两个引擎（agent-service 的
 * SettingsService、DSH 的 DshClientSession）各自实现，编排逻辑只在下面一份。
 */
export interface PresetSharePort {
	/** 服务端语言（错误文案）。 */
	lang(): ServerLang;
	/** 本包版本（写进交换文档的 appVersion；读不到返回 ""）。 */
	appVersion(): string;
	/** 当前预设列表（判断「预设不存在」与重名覆盖）。 */
	presets(): SettingsPreset[];
	/** 当前设置快照（不含 name）——source=current 的导出来源。 */
	currentSettings(): Record<string, unknown>;
	/** 落盘一条预设（同名覆盖 / 追加），由调用方负责推送。 */
	upsertPreset(preset: SettingsPreset): void;
	/** 应用预设（import 的 apply=true）。 */
	applyPreset(name: string): Promise<void>;
	/** 推送设置状态（presets 列表跟着走）。 */
	pushSettings(): void;
	/** 发协议消息。 */
	emit(msg: ServerMessage): void;
}

type ExportMsg = Extract<ClientMessage, { type: "preset_export" }>;
type ShareMsg = Extract<ClientMessage, { type: "preset_share" }>;
type ImportMsg = Extract<ClientMessage, { type: "preset_import" }>;
type ImportUrlMsg = Extract<ClientMessage, { type: "preset_import_url" }>;
type CatalogMsg = Extract<ClientMessage, { type: "preset_catalog" }>;

/** 取导出来源并组装交换文档（预设 or 当前设置）。 */
function buildDocFromPort(
	port: PresetSharePort,
	opts: { source?: "preset" | "current"; name?: string } & PresetShareMeta,
): { ok: true; doc: PresetShareDoc; json: string; fileName: string } | { ok: false; error: string } {
	const lang = port.lang();
	const current = opts.source === "current";
	const n = (opts.name ?? "").trim();
	let settings: Record<string, unknown>;
	let name: string;
	if (current) {
		settings = port.currentSettings();
		name = n || pick(lang, "当前设置", "Current settings", "presets.share.currentName");
	} else {
		const hit = port.presets().find((p) => p.name === n);
		if (!hit) {
			return {
				ok: false,
				error: pick(lang, `预设不存在：${n}`, `Preset does not exist: ${n}`, "presets.share.missing", { name: n }),
			};
		}
		const { name: _drop, ...rest } = hit as SettingsPreset & Record<string, unknown>;
		settings = { ...rest };
		name = hit.name;
	}
	const doc = buildShareDoc(name, settings, {
		description: opts.description,
		author: opts.author,
		tags: opts.tags,
		appVersion: port.appVersion(),
	});
	return { ok: true, doc, json: serializeShareDoc(doc), fileName: presetFileName(doc.name) };
}

/** 内置的导入预览组装（两个引擎共用）。 */
export function buildImportPreview(
	name: string,
	doc: PresetShareDoc,
	sanitized: SanitizeResult,
	replaces: boolean,
): UiPresetImportPreview {
	const preset = toSettingsPreset(name, sanitized.settings);
	return {
		name,
		description: doc.description,
		author: doc.author,
		tags: doc.tags,
		format: doc.format,
		version: doc.version,
		fields: sanitized.fields,
		ignored: sanitized.ignored,
		rejected: sanitized.rejected,
		replaces,
		summary: presetSummary(sanitized.settings),
		settings: sanitized.settings,
		customSystemPrompt: (preset.customSystemPrompt ?? "").slice(0, PREVIEW_TEXT_MAX),
		promptTemplate: (preset.promptTemplate ?? "").slice(0, PREVIEW_TEXT_MAX),
		reviewPrompt: (preset.reviewPrompt ?? "").slice(0, PREVIEW_TEXT_MAX),
		disabledSkills: preset.disabledSkills ?? [],
		disabledExtensions: preset.disabledExtensions ?? [],
	};
}

/** preset_import / preset_import_url 的共同后段：预览 →（非 dryRun）落盘 →（可选）应用。 */
async function applyImport(
	port: PresetSharePort,
	parsed: PresetParseSuccess,
	opts: { dryRun?: boolean; name?: string; apply?: boolean; requestId?: string; fields?: unknown },
): Promise<void> {
	const lang = port.lang();
	const name = (opts.name ?? "").trim() || parsed.doc.name;
	const replaces = port.presets().some((p) => p.name === name);
	const preview = buildImportPreview(name, parsed.doc, parsed.sanitized, replaces);
	if (opts.dryRun) {
		port.emit({ type: "preset_import_result", requestId: opts.requestId, ok: true, dryRun: true, preview });
		return;
	}
	// 可选导入：客户端可只带一部分字段名（导入预览里的按组/按字段勾选）。
	// 只认白名单里存在的名字；给了名单但一个都没命中 = 用户全取消了，不写任何东西。
	const selection = normalizePresetFieldSelection(opts.fields);
	const settings = selection
		? Object.fromEntries(Object.entries(parsed.sanitized.settings).filter(([k]) => selection.includes(k)))
		: parsed.sanitized.settings;
	if (selection && Object.keys(settings).length === 0) {
		port.emit({
			type: "preset_import_result",
			requestId: opts.requestId,
			ok: false,
			dryRun: false,
			error: pick(lang, "没有勾选任何要导入的字段", "No fields selected to import", "presets.import.noneSelected"),
		});
		return;
	}
	const applied: string[] = Object.keys(settings).sort();
	port.upsertPreset(toSettingsPreset(name, settings));
	port.pushSettings();
	port.emit({
		type: "preset_import_result",
		requestId: opts.requestId,
		ok: true,
		dryRun: false,
		preview: { ...preview, fields: applied },
	});
	port.emit({
		type: "notice",
		level: "info",
		text: replaces ? `预设已更新：${name}` : `预设已导入：${name}`,
		textEn: replaces ? `Preset updated: ${name}` : `Preset imported: ${name}`,
	});
	if (opts.apply) await port.applyPreset(name);
}

/** preset_export：把预设（或当前设置）导成可复制/可下载的 JSON 文本。 */
export function exportPresetVia(port: PresetSharePort, msg: ExportMsg): void {
	const built = buildDocFromPort(port, msg);
	if (!built.ok) {
		port.emit({ type: "preset_export_result", requestId: msg.requestId, ok: false, error: built.error });
		return;
	}
	port.emit({
		type: "preset_export_result",
		requestId: msg.requestId,
		ok: true,
		name: built.doc.name,
		fileName: built.fileName,
		json: built.json,
	});
}

/** preset_import：解析粘贴/文件内容（dryRun = 只预览，不落盘）。 */
export async function importPresetVia(port: PresetSharePort, msg: ImportMsg): Promise<void> {
	const parsed = parseShareDoc(msg.json, port.lang());
	if (!parsed.ok) {
		port.emit({
			type: "preset_import_result",
			requestId: msg.requestId,
			ok: false,
			dryRun: !!msg.dryRun,
			error: parsed.error,
		});
		return;
	}
	await applyImport(port, parsed, msg);
}

/** preset_import_url：服务端抓取（内网地址拦截 + 超时 + 大小上限）后再导入。 */
export async function importPresetFromUrlVia(port: PresetSharePort, msg: ImportUrlMsg): Promise<void> {
	const lang = port.lang();
	const valid = validateFetchUrl(msg.url);
	if (!valid.ok) {
		port.emit({
			type: "preset_import_result",
			requestId: msg.requestId,
			ok: false,
			dryRun: !!msg.dryRun,
			error:
				valid.reason === "host"
					? pick(
							lang,
							"不支持的地址（内网/本地地址已拦截）",
							"Unsupported URL (local/private hosts are blocked)",
							"presets.import.url.host",
						)
					: pick(
							lang,
							"地址必须以 http:// 或 https:// 开头",
							"The URL must start with http:// or https://",
							"presets.import.url.scheme",
						),
		});
		return;
	}
	let text: string;
	try {
		const res = await fetchText(valid.url);
		if (!res.ok) throw new Error(res.error);
		text = res.text;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		port.emit({
			type: "preset_import_result",
			requestId: msg.requestId,
			ok: false,
			dryRun: !!msg.dryRun,
			error: pick(lang, `下载失败：${message}`, `Download failed: ${message}`, "presets.import.fetch.failed", {
				message,
			}),
		});
		return;
	}
	const parsed = parseShareDoc(text, port.lang());
	if (!parsed.ok) {
		port.emit({
			type: "preset_import_result",
			requestId: msg.requestId,
			ok: false,
			dryRun: !!msg.dryRun,
			error: parsed.error,
		});
		return;
	}
	await applyImport(port, parsed, msg);
}

/**
 * 将 gh 或 API 失败原因转化为用户友好的指导文案（含安装提示、登录提示或令牌说明）。
 */
export function diagnoseShareFailure(opts: {
	ghError?: string;
	ghErrorKey?: string;
	apiError?: string;
	apiErrorKey?: string;
	hasToken?: boolean;
	lang: ServerLang;
}): string {
	const { ghError = "", ghErrorKey, apiError = "", hasToken, lang } = opts;

	// 1. 如果配置了 Token 且通过 API 请求失败：
	if (hasToken && apiError) {
		if (/401|bad credentials/i.test(apiError)) {
			return pick(
				lang,
				"GitHub 令牌无效或已过期（PI_WEB_PRESET_TOKEN）。请检查令牌有效性；也可直接在网页提交。",
				"GitHub token is invalid or expired (PI_WEB_PRESET_TOKEN). Check token validity; or submit via the web link below.",
				"presets.share.apiTokenInvalid",
			);
		}
		if (/403|404|permission|resource not accessible/i.test(apiError)) {
			return pick(
				lang,
				"GitHub 令牌无权在此仓库创建 Issue（需要 issues: write 权限）。请更新权限；也可直接在网页提交。",
				"GitHub token lacks permission to create issues here (issues: write required). Update permissions; or submit via the web link below.",
				"presets.share.apiTokenPermission",
			);
		}
		return pick(
			lang,
			`GitHub API 提交失败（${apiError}）。已回落到网页提交方式。`,
			`GitHub API submission failed (${apiError}). Falling back to web submission.`,
			"presets.share.apiGeneralFailed",
			{ error: apiError },
		);
	}

	// 2. 如果 gh CLI 缺失（ENOENT 或明确的 ghMissing）：
	if (ghErrorKey === "presets.share.ghMissing" || /ENOENT|not found/i.test(ghError)) {
		return pick(
			lang,
			"未检测到 GitHub CLI (gh)。可安装 gh（如 winget install --id GitHub.cli 或 brew install gh）并执行 gh auth login；或配置环境变量 PI_WEB_PRESET_TOKEN；也可直接在网页提交。",
			"GitHub CLI (gh) not found. Install it (e.g. winget install --id GitHub.cli or brew install gh) and run 'gh auth login'; or set the PI_WEB_PRESET_TOKEN env var; or submit via the web link below.",
			"presets.share.ghMissingHint",
		);
	}

	// 3. 如果 gh CLI 未登录/未认证：
	if (/auth|login|credential|not logged in/i.test(ghError)) {
		return pick(
			lang,
			"GitHub CLI (gh) 尚未登录。请在终端执行 gh auth login 登录，或配置环境变量 PI_WEB_PRESET_TOKEN；也可直接在网页提交。",
			"GitHub CLI (gh) is not logged in. Run 'gh auth login' in terminal, or set the PI_WEB_PRESET_TOKEN env var; or submit via the web link below.",
			"presets.share.ghNotLoggedInHint",
		);
	}

	// 4. 其他通用错误：
	if (ghError) {
		return pick(
			lang,
			`自动提交遇到问题（${ghError}）。已回落到网页提交方式。`,
			`Automatic submission encountered an issue (${ghError}). Falling back to web submission.`,
			"presets.share.fallbackHint",
			{ error: ghError },
		);
	}

	return "";
}

/** preset_share：一键发到社区共享仓库（gh issue create；失败回落预填网页）。 */
export async function sharePresetVia(port: PresetSharePort, msg: ShareMsg): Promise<void> {
	const built = buildDocFromPort(port, msg);
	if (!built.ok) {
		port.emit({ type: "preset_share_result", requestId: msg.requestId, ok: false, error: built.error });
		return;
	}
	const repo = presetShareRepo();
	if (!repo) {
		port.emit({
			type: "preset_share_result",
			requestId: msg.requestId,
			ok: false,
			name: built.doc.name,
			json: built.json,
			error: pick(
				port.lang(),
				"分享已关闭（PI_WEB_PRESET_REPO）",
				"Sharing is disabled (PI_WEB_PRESET_REPO)",
				"presets.share.disabled",
			),
		});
		return;
	}
	const body = presetIssueBody(built.doc, presetRepoUrl(repo));
	// 三条落地路径，按「用户需要动手的程度」排序：
	//   1) gh CLI（装了且已登录）—— 全自动；
	//   2) GitHub API + 令牌（PI_WEB_PRESET_TOKEN / GH_TOKEN / GITHUB_TOKEN）—— 无 gh 也能全自动；
	//   3) 预填网页 —— 不需要任何凭据，前端复制 JSON 后打开链接，**大多数情况点一下 Submit 即可**。
	const gh = await createPresetIssue({ repo, name: built.doc.name, body });
	const token = gh.ok ? "" : presetShareToken();
	const viaApi = !gh.ok && token ? await createPresetIssueViaApi({ repo, name: built.doc.name, body, token }) : null;
	if (gh.ok || (viaApi && viaApi.ok)) {
		port.emit({
			type: "preset_share_result",
			requestId: msg.requestId,
			ok: true,
			method: gh.ok ? "gh" : "api",
			url: gh.ok ? gh.url : viaApi && viaApi.ok ? viaApi.url : "",
			name: built.doc.name,
			json: built.json,
		});
		port.emit({
			type: "notice",
			level: "info",
			text: `已提交分享：${built.doc.name}（仓库机器人会自动收录）`,
			textEn: `Shared: ${built.doc.name} (the repo bot will ingest it automatically)`,
		});
		return;
	}
	// 服务端两条路都不通：回落预填网页，json 一起交回前端（前端复制后打开链接）。
	const friendlyError = diagnoseShareFailure({
		ghError: gh.error,
		ghErrorKey: gh.errorKey,
		apiError: viaApi && !viaApi.ok ? viaApi.error : "",
		apiErrorKey: viaApi && !viaApi.ok ? viaApi.errorKey : undefined,
		hasToken: !!token,
		lang: port.lang(),
	});
	port.emit({
		type: "preset_share_result",
		requestId: msg.requestId,
		ok: false,
		method: "browser",
		url: presetIssueWebUrl(repo, built.doc.name, body),
		name: built.doc.name,
		json: built.json,
		error: friendlyError || (viaApi && !viaApi.ok ? viaApi.error : "") || gh.error,
	});
}

/** preset_catalog：拉社区目录（5 分钟缓存；失败保留上一次成功的列表）。 */
export async function pushPresetCatalogVia(port: PresetSharePort, msg: CatalogMsg): Promise<void> {
	const res = await fetchPresetCatalog({
		refresh: msg.refresh,
		repo: presetShareRepo(),
		url: presetCatalogUrl(),
		lang: port.lang(),
	});
	port.emit({
		type: "preset_catalog_result",
		requestId: msg.requestId,
		ok: res.ok,
		entries: res.entries,
		source: res.source,
		cached: res.cached,
		fetchedAt: res.fetchedAt,
		error: res.error,
	});
}
