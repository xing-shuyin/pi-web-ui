import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { getAppVersion } from "./pkg-info.js";
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
import { FetchUrlError, readBeforeAbort, safeFetch, validateFetchUrl, type LookupAllFn } from "./net-guard.js";
import { PRESET_FIELD_NAMES, normalizePresetFieldSelection } from "./preset-fields.js";
import { defaultFetcher } from "./update-check.js";
import { normalizePresetPlugins } from "./preset-plugin-dependencies.js";

const execFileAsync = promisify(execFile);

const PREVIEW_TEXT_MAX = 400;

export const PRESET_SHARE_FORMAT = "pi-web-ui-preset";
export const PRESET_SHARE_VERSION = 1;
export const DEFAULT_PRESET_REPO = "xing-shuyin/pi-web-ui-presets";
export const PRESET_JSON_MAX_BYTES = 512 * 1024;
export const PRESET_TEXT_MAX_LEN = 100_000;
export const PRESET_LIST_MAX = 500;
export const PRESET_LIST_ITEM_MAX = 200;
export const PRESET_MAP_MAX = 200;
export const PRESET_SHORT_STR_MAX = 300;

const FETCH_TIMEOUT_MS = 10_000;
const CATALOG_MAX_BYTES = 512 * 1024;
const CATALOG_MAX_ENTRIES = 500;
export const PRESET_CATALOG_TTL_MS = 5 * 60_000;
const NAME_MAX = 60;
const DESCRIPTION_MAX = 500;
const AUTHOR_MAX = 80;
const TAG_MAX = 24;
const TAG_COUNT_MAX = 8;

export function packageVersion(): string {
	return getAppVersion();
}

export type TextFetcher = (
	url: string,
	init?: {
		signal?: AbortSignal;
		headers?: Record<string, string>;
		method?: string;
		body?: string;
		redirect?: "follow" | "error" | "manual";
	},
) => Promise<{
	ok: boolean;
	status: number;
	statusText?: string;
	headers?: { get(name: string): string | null };
	text: () => Promise<string>;
	body?: {
		getReader(): {
			read(): Promise<{ done: boolean; value?: Uint8Array }>;
			cancel(): Promise<void>;
			releaseLock?(): void;
		};
	} | null;
}>;

export const defaultTextFetcher: TextFetcher = defaultFetcher as unknown as TextFetcher;

export function presetShareRepo(): string {
	const raw = process.env.PI_WEB_PRESET_REPO?.trim();
	if (raw === undefined || raw === "") return DEFAULT_PRESET_REPO;
	if (/^(0|off|false|no)$/i.test(raw)) return "";
	return raw
		.replace(/^https?:\/\/(www\.)?github\.com\//i, "")
		.replace(/\.git$/i, "")
		.replace(/\/+$/, "");
}

export function presetCatalogUrl(repo = presetShareRepo()): string {
	const raw = process.env.PI_WEB_PRESET_CATALOG_URL?.trim();
	if (raw !== undefined && raw !== "") {
		if (/^(0|off|false|no)$/i.test(raw)) return "";
		return raw;
	}
	if (!repo) return "";
	return `https://raw.githubusercontent.com/${repo}/main/index.json`;
}

export function presetRepoUrl(repo = presetShareRepo()): string {
	return repo ? `https://github.com/${repo}` : "";
}

export function presetShareToken(): string {
	return (process.env.PI_WEB_PRESET_TOKEN ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? "").trim();
}

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

export function presetShortHash(text: string): string {
	let h = 5381;
	for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
	return h.toString(16).padStart(8, "0").slice(-7);
}

export function presetFileName(name: string): string {
	return `${slugifyPresetName(name)}-${presetShortHash(name)}.json`;
}

export interface PresetShareDoc {
	format: string;
	version: number;
	name: string;
	description: string;
	author: string;
	tags: string[];
	createdAt: string;
	appVersion: string;
	enabledTools?: string[];
	plugins?: import("./protocol.js").UiPresetPluginDependency[];
	settings: Record<string, unknown>;
}

export interface PresetShareMeta {
	plugins?: import("./protocol.js").UiPresetPluginDependency[];
	description?: string;
	author?: string;
	tags?: string[];
	appVersion?: string;
	createdAt?: string;
}

function clampText(v: unknown, max: number): string {
	return typeof v === "string" ? v.trim().slice(0, max) : "";
}

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

export function normalizePresetName(v: unknown): string {
	return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, NAME_MAX) : "";
}

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
	const plugins = normalizePresetPlugins(meta.plugins);
	if (plugins.length) doc.plugins = plugins;
	if (Array.isArray(settings["disabledAgentTools"])) {
		doc.enabledTools = resolveEnabledAgentTools(settings["disabledAgentTools"] as string[]);
	}
	return doc;
}

export function serializeShareDoc(doc: PresetShareDoc): string {
	return JSON.stringify(doc, null, "\t") + "\n";
}

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

const PRESET_FIELD_KINDS = {
	promptMode: "promptMode",
	customSystemPrompt: "text",
	promptTemplate: "text",
	promptOverrides: "textMap",
	promptDisabled: "list",
	reviewPrompt: "text",
	reviewDisabledSkills: "list",
	disabledAgentTools: "list",
	disabledPluginTools: "list",
	toolPromptOverrides: "toolPromptOverrides",
	toolLazyLoading: "bool",
	codemodeMode: "codemodeMode",
	codemodeInlineBudget: "number",
	readDirEnabled: "bool",
	chatUploadMaxMb: "number",
	workspaceUploadMaxMb: "number",
	folderUploadMaxMb: "number",
	bgAutoCleanupMin: "number",
	toolApprovalEnabled: "bool",
	toolWatchdogTimeoutMs: "number",
	questionnaireEnabled: "bool",
	questionPresentation: "questionPresentation",
	toolApprovalPresentation: "questionPresentation",
	questionTimeoutSeconds: "questionTimeout",
	editSoftEnabled: "bool",
	terminalToolsEnabled: "bool",
	terminalBash: "bool",
	terminalBashIdleMs: "number",
	terminalBashMaxForegroundMs: "number",
	disabledSkills: "list",
	disabledExtensions: "list",
	skillsFullText: "list",
	skillsCatalogMaxDesc: "number",
	skillsCatalogShowLocation: "bool",
	skillsCatalogBudget: "number",
	skillsMaxFileBytes: "number",
	skillsFullTextMaxBytes: "number",
	steeringMode: "queueMode",
	followUpMode: "queueMode",
	retryMaxAttempts: "retry",
	softCapTokens: "softCap",
	softCapByModel: "softCapByModel",
	autoCompactionInstructions: "text",
	subagentDefaultModel: "nullableString",
	subagentMaxDepth: "number",
	subagentAutoWakeMaxTurns: "number",
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
	uiLayout: "uiLayout",
	disabledPlugins: "list",
	thinkingWrap: "bool",
	toolsWrap: "bool",
	toolImagesEnabled: "bool",
	keepRecentMessages: "number",
	reversePagination: "bool",
	showForkedParentSessions: "bool",
	retainFinishedConversations: "bool",
	openRecentSessionOnProjectSwitch: "bool",
	quickPhrases: "list",
	quickPhrasesEnabled: "bool",
	minimalNewChat: "bool",
	preserveDraftAcrossConversations: "bool",
	devNoCache: "bool",
	autoReload: "bool",
	defaultAgentPreset: "shortString",
	defaultPermissionPreset: "shortString",
} as const satisfies Record<string, string>;

export const PRESET_FIELD_KIND_NAMES = Object.keys(PRESET_FIELD_KINDS);
export const PRESET_FIELD_NAMES_SORTED = [...PRESET_FIELD_NAMES].sort();

export { PRESET_FIELD_NAMES };

export interface SanitizeResult {
	settings: Record<string, unknown>;
	fields: string[];
	ignored: string[];
	rejected: string[];
}

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
					for (const item of raw) {
						if (typeof item === "string" && !isConfigurableAgentTool(item)) {
							ignored.push(`disabledAgentTools.${item}`);
						}
					}
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
			case "questionPresentation":
				if (raw === "queue" || raw === "all" || raw === "manual") settings[key] = raw;
				else rejected.push(key);
				break;
			case "questionTimeout":
				if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 && raw <= 86400) settings[key] = raw;
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
			case "queueMode":
				if (raw === "all" || raw === "one-at-a-time") settings[key] = raw;
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
				if (raw === null) settings[key] = null;
				else if (typeof raw === "string" && raw.length <= PRESET_SHORT_STR_MAX) settings[key] = raw;
				else rejected.push(key);
				break;
			case "shortString":
				if (typeof raw === "string" && raw.length <= PRESET_SHORT_STR_MAX) settings[key] = raw;
				else rejected.push(key);
				break;
			case "toolPromptOverrides":
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

export function toSettingsPreset(name: string, settings: Record<string, unknown>): SettingsPreset {
	return { name: normalizePresetName(name), ...(settings as Partial<SettingsPreset>) };
}

export type PresetParseFailure = { ok: false; error: string; errorKey: string };
export type PresetParseSuccess = { ok: true; doc: PresetShareDoc; sanitized: SanitizeResult };
export type PresetParseResult = PresetParseSuccess | PresetParseFailure;

function fail(lang: ServerLang, key: string, zh: string, en: string): PresetParseFailure {
	return { ok: false, error: pick(lang, zh, en, key), errorKey: key };
}

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
			plugins: normalizePresetPlugins(doc["plugins"]),
			settings: sanitized.settings,
		},
		sanitized,
	};
}

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

export async function fetchText(
	url: string,
	opts: {
		fetcher?: TextFetcher;
		lookup?: LookupAllFn;
		timeoutMs?: number;
		maxBytes?: number;
		maxRedirects?: number;
	} = {},
): Promise<{ ok: true; text: string } | { ok: false; error: string; errorKey: string }> {
	const maxBytes = opts.maxBytes ?? PRESET_JSON_MAX_BYTES;
	const signal = AbortSignal.timeout(opts.timeoutMs ?? FETCH_TIMEOUT_MS);
	let res: Awaited<ReturnType<TextFetcher>>;
	try {
		res = await safeFetch(
			url,
			{ signal },
			{
				lookup: opts.lookup,
				maxRedirects: opts.maxRedirects,
				timeoutMs: opts.timeoutMs ?? FETCH_TIMEOUT_MS,
				// Only explicit injection selects a mock transport; global fetch does not affect policy.
				fetcher: opts.fetcher
					? (u, init) => opts.fetcher!(u, init as Parameters<TextFetcher>[1]) as Promise<Response>
					: undefined,
			},
		);
	} catch (error) {
		if (error instanceof FetchUrlError) {
			return {
				ok: false,
				errorKey: error.reason === "scheme" ? "presets.url.scheme" : "presets.url.host",
				error: error.message,
			};
		}
		if (error instanceof Error && error.message.startsWith("Too many redirects")) {
			return { ok: false, errorKey: "presets.fetch.status", error: error.message };
		}
		throw error;
	}
	if (!res.ok) {
		if (res.body) await res.body.getReader().cancel();
		return {
			ok: false,
			errorKey: "presets.fetch.status",
			error: `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`,
		};
	}
	const body = res.body;
	if (body) {
		const reader = body.getReader();
		const decoder = new TextDecoder();
		let received = 0;
		const chunks: Uint8Array[] = [];
		try {
			for (;;) {
				const { done, value } = await readBeforeAbort(reader.read(), signal);
				if (done) break;
				if (!value) continue;
				received += value.byteLength;
				if (received > maxBytes) {
					try {
						await reader.cancel();
					} catch {}
					return {
						ok: false,
						errorKey: "presets.fetch.tooLarge",
						error: `Content too large (> ${Math.round(maxBytes / 1024)} KB)`,
					};
				}
				chunks.push(value);
			}
		} finally {
			void reader.cancel().catch(() => {});
			reader.releaseLock?.();
		}
		const merged = new Uint8Array(received);
		let offset = 0;
		for (const chunk of chunks) {
			merged.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return { ok: true, text: decoder.decode(merged) };
	}
	const text = await readBeforeAbort(res.text(), signal);
	if (Buffer.byteLength(text, "utf8") > maxBytes) {
		return {
			ok: false,
			errorKey: "presets.fetch.tooLarge",
			error: `Content too large (> ${Math.round(maxBytes / 1024)} KB)`,
		};
	}
	return { ok: true, text };
}

export function catalogBaseUrl(catalogUrl: string): string {
	return catalogUrl.replace(/\/[^/]*$/, "");
}

export function normalizeCatalogEntry(raw: unknown, base: string, repoUrl: string): UiPresetCatalogEntry | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const e = raw as Record<string, unknown>;
	const id = clampText(e["id"], 80);
	const name = normalizePresetName(e["name"]);
	const file = clampText(e["file"], 200);
	if (!id || !name || !file) return null;
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
	entries.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
	return { ok: true, entries };
}

export interface CatalogResult {
	ok: boolean;
	entries: UiPresetCatalogEntry[];
	source: string;
	cached: boolean;
	fetchedAt: number;
	error?: string;
	errorKey?: string;
}

export async function fetchPresetCatalog(
	opts: {
		url?: string;
		repo?: string;
		fetcher?: TextFetcher;
		refresh?: boolean;
		timeoutMs?: number;
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

export interface PresetCatalogCache {
	get(url: string): { entries: UiPresetCatalogEntry[]; fetchedAt: number } | undefined;
	set(url: string, value: { entries: UiPresetCatalogEntry[]; fetchedAt: number }): void;
	clear(): void;
}

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

export function clearPresetCatalogCache(): void {
	sharedCatalogCache.clear();
}

export function presetIssueTitle(name: string): string {
	return `[preset] ${name}`;
}

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

export const PRESET_ISSUE_URL_MAX = 7_000;

export function presetIssueWebUrl(repo: string, name: string, body?: string): string {
	const title = presetIssueTitle(name);
	if (body) {
		const withBody = `https://github.com/${repo}/issues/new?${new URLSearchParams({ title, body })}`;
		if (withBody.length <= PRESET_ISSUE_URL_MAX) return withBody;
	}
	return `https://github.com/${repo}/issues/new?${new URLSearchParams({ title, template: "share-preset.yml" })}`;
}

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
			let detail = `HTTP ${res.status}`;
			try {
				const parsed = JSON.parse(text) as { message?: string };
				if (parsed.message) detail = `HTTP ${res.status}: ${parsed.message}`;
			} catch {}
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

export async function createPresetIssue(opts: {
	repo: string;
	name: string;
	body: string;
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
		} catch {}
	}
}

export interface PresetSharePort {
	lang(): ServerLang;
	appVersion(): string;
	presets(): SettingsPreset[];
	currentSettings(): Record<string, unknown>;
	upsertPreset(preset: SettingsPreset): void;
	applyPreset(name: string): Promise<void>;
	isApplyPending?: () => boolean;
	pushSettings(): void;
	emit(msg: ServerMessage): void;
}

type ExportMsg = Extract<ClientMessage, { type: "preset_export" }>;
type ShareMsg = Extract<ClientMessage, { type: "preset_share" }>;
type ImportMsg = Extract<ClientMessage, { type: "preset_import" }>;
type ImportUrlMsg = Extract<ClientMessage, { type: "preset_import_url" }>;
type CatalogMsg = Extract<ClientMessage, { type: "preset_catalog" }>;

function buildDocFromPort(
	port: PresetSharePort,
	opts: { source?: "preset" | "current"; name?: string } & PresetShareMeta,
): { ok: true; doc: PresetShareDoc; json: string; fileName: string } | { ok: false; error: string } {
	const lang = port.lang();
	const current = opts.source === "current";
	const n = (opts.name ?? "").trim();
	let settings: Record<string, unknown>;
	let name: string;
	let savedPlugins: import("./protocol.js").UiPresetPluginDependency[] | undefined;
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
		const { name: _drop, plugins, ...rest } = hit as SettingsPreset & Record<string, unknown>;
		savedPlugins = plugins;
		settings = { ...rest };
		name = hit.name;
	}
	const doc = buildShareDoc(name, sanitizePresetSettings(settings).settings, {
		plugins: opts.plugins ?? savedPlugins,
		description: opts.description,
		author: opts.author,
		tags: opts.tags,
		appVersion: port.appVersion(),
	});
	return { ok: true, doc, json: serializeShareDoc(doc), fileName: presetFileName(doc.name) };
}

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
		plugins: normalizePresetPlugins(doc.plugins),
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
		promptDisabled: preset.promptDisabled ?? [],
	};
}

async function applyImport(
	port: PresetSharePort,
	parsed: PresetParseSuccess,
	opts: { dryRun?: boolean; name?: string; apply?: boolean; requestId?: string; fields?: unknown },
): Promise<void> {
	const lang = port.lang();
	const name = normalizePresetName(opts.name) || parsed.doc.name;
	const replaces = port.presets().some((p) => p.name === name);
	const preview = buildImportPreview(name, parsed.doc, parsed.sanitized, replaces);
	if (opts.dryRun) {
		port.emit({ type: "preset_import_result", requestId: opts.requestId, ok: true, dryRun: true, preview });
		return;
	}
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
	const plugins = normalizePresetPlugins(parsed.doc.plugins);
	try {
		port.upsertPreset({ ...toSettingsPreset(name, settings), ...(plugins.length ? { plugins } : {}) });
	} catch (error) {
		port.emit({
			type: "preset_import_result",
			requestId: opts.requestId,
			ok: false,
			dryRun: false,
			error: error instanceof Error ? error.message : String(error),
		});
		return;
	}
	port.pushSettings();
	let applyError: string | undefined;
	if (opts.apply) {
		try {
			await port.applyPreset(name);
		} catch (error) {
			applyError = error instanceof Error ? error.message : String(error);
		}
	}
	port.emit({
		type: "preset_import_result",
		requestId: opts.requestId,
		ok: true,
		dryRun: false,
		preview: { ...preview, fields: applied },
		applied: opts.apply === true && !applyError && !port.isApplyPending?.(),
		...(opts.apply && !applyError && port.isApplyPending?.() ? { applyDeferred: true } : {}),
		...(applyError ? { applyError } : {}),
	});
	port.emit({
		type: "notice",
		level: "info",
		text: replaces ? `预设已更新：${name}` : `预设已导入：${name}`,
		textEn: replaces ? `Preset updated: ${name}` : `Preset imported: ${name}`,
	});
}

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

export function diagnoseShareFailure(opts: {
	ghError?: string;
	ghErrorKey?: string;
	apiError?: string;
	apiErrorKey?: string;
	hasToken?: boolean;
	lang: ServerLang;
}): string {
	const { ghError = "", ghErrorKey, apiError = "", hasToken, lang } = opts;

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

	if (ghErrorKey === "presets.share.ghMissing" || /ENOENT|not found/i.test(ghError)) {
		return pick(
			lang,
			"未检测到 GitHub CLI (gh)。可安装 gh（如 winget install --id GitHub.cli 或 brew install gh）并执行 gh auth login；或配置环境变量 PI_WEB_PRESET_TOKEN；也可直接在网页提交。",
			"GitHub CLI (gh) not found. Install it (e.g. winget install --id GitHub.cli or brew install gh) and run 'gh auth login'; or set the PI_WEB_PRESET_TOKEN env var; or submit via the web link below.",
			"presets.share.ghMissingHint",
		);
	}

	if (/auth|login|credential|not logged in/i.test(ghError)) {
		return pick(
			lang,
			"GitHub CLI (gh) 尚未登录。请在终端执行 gh auth login 登录，或配置环境变量 PI_WEB_PRESET_TOKEN；也可直接在网页提交。",
			"GitHub CLI (gh) is not logged in. Run 'gh auth login' in terminal, or set the PI_WEB_PRESET_TOKEN env var; or submit via the web link below.",
			"presets.share.ghNotLoggedInHint",
		);
	}

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
