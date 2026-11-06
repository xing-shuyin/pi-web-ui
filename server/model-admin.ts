import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeJsonAtomicSync } from "./atomic-file.js";
import { stripJsonComments } from "./json-utils.js";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type {
	ServerMessage,
	UiEnrichResult,
	UiModelConfigEntry,
	UiProviderConfig,
	UiThinkingLevelMap,
	ProviderKeyInfo,
} from "./protocol.js";
import { enrichBatch, type EnrichLang } from "./model-enrich.js";
import { resolveModelReasoningSpec } from "./reasoning-registry.js";
import { pick, type ServerLang } from "./i18n.js";
import { ProviderOAuthFlowManager } from "./provider-oauth-flow.js";

export interface ModelAdminHost {
	agentDir: string;
	emit: (msg: ServerMessage) => void;
	flushSnapshot: () => void;
	isDisposed: () => boolean;
	modelRuntime?: () => ModelRuntime;
	invalidatePiConfig?: () => void;
	pushModels: () => Promise<void>;
	onOAuthActivated?: (provider: string) => void;
}

export interface OverlayGraduation {
	providerId: string;
	modelId: string;
}

export function graduateOverlayModels(
	providers: Record<string, Record<string, unknown>>,
	official: Record<string, Record<string, string | undefined>>,
): OverlayGraduation[] {
	const graduated: OverlayGraduation[] = [];
	for (const [pid, entry] of Object.entries(providers)) {
		if (!entry || typeof entry !== "object" || !Array.isArray(entry.models)) continue;
		const officialModels = official[pid];
		if (!officialModels || Object.keys(officialModels).length === 0) continue;
		const kept: unknown[] = [];
		for (const row of entry.models as unknown[]) {
			const r = (row ?? {}) as Record<string, unknown>;
			const id = typeof r.id === "string" ? r.id.trim() : "";
			const listed = id !== "" && Object.hasOwn(officialModels, id);
			const officialApi = listed ? officialModels[id] : undefined;
			const rowApi = typeof r.api === "string" && r.api.trim() ? r.api.trim() : undefined;
			const provisional =
				listed && r.baseUrl == null && (rowApi === undefined || (officialApi !== undefined && rowApi === officialApi));
			if (provisional) {
				graduated.push({ providerId: pid, modelId: id });
				continue;
			}
			kept.push(row);
		}
		if (kept.length === (entry.models as unknown[]).length) continue;
		if (kept.length === 0 && Object.keys(entry).every((k) => k === "models")) {
			delete providers[pid];
		} else {
			entry.models = kept;
		}
	}
	return graduated;
}

function atomicWriteCredentialJson(path: string, data: unknown): void {
	writeJsonAtomicSync(path, data);
	try {
		chmodSync(path, CREDENTIAL_FILE_MODE);
	} catch {}
}

export function mergeProviderConfigEntry(
	prevEntry: Record<string, unknown> | undefined,
	config: UiProviderConfig,
	models: UiModelConfigEntry[],
): Record<string, unknown> {
	const prevModels = new Map<string, Record<string, unknown>>();
	if (Array.isArray(prevEntry?.models)) {
		for (const entry of prevEntry.models) {
			if (!entry || typeof entry !== "object") continue;
			const id = (entry as { id?: unknown }).id;
			if (typeof id === "string" && id.trim()) prevModels.set(id.trim(), entry as Record<string, unknown>);
		}
	}
	const mergedModels = models.map((model) => {
		const merged: Record<string, unknown> = { ...prevModels.get(model.id), id: model.id };
		if (model.name?.trim()) merged.name = model.name.trim();
		else delete merged.name;
		if (model.reasoning) merged.reasoning = true;
		else delete merged.reasoning;
		if (model.input?.length) merged.input = model.input;
		else delete merged.input;
		if (model.contextWindow) merged.contextWindow = Number(model.contextWindow);
		else delete merged.contextWindow;
		if (model.maxTokens) merged.maxTokens = Number(model.maxTokens);
		else delete merged.maxTokens;
		const thinkingLevelMap = sanitizeThinkingLevelMap(model.thinkingLevelMap);
		if (thinkingLevelMap) merged.thinkingLevelMap = thinkingLevelMap;
		if (model.compat && typeof model.compat === "object") merged.compat = model.compat;
		if (model.samplingParams && typeof model.samplingParams === "object") merged.samplingParams = model.samplingParams;
		if (typeof model.customExtraBody === "string") {
			if (model.customExtraBody.trim()) {
				merged.customExtraBody = model.customExtraBody.trim();
				try {
					const parsed = JSON.parse(model.customExtraBody.trim());
					if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
						merged.samplingParams = {
							...((merged.samplingParams as Record<string, unknown>) ?? {}),
							...parsed,
						};
					}
				} catch {}
			} else {
				delete merged.customExtraBody;
			}
		}
		return merged;
	});

	const mergedEntry: Record<string, unknown> = { ...prevEntry };
	const apply = (key: string, value: unknown): void => {
		if (value === undefined) delete mergedEntry[key];
		else mergedEntry[key] = value;
	};
	apply("name", config.name?.trim() || undefined);
	apply("api", config.api?.trim() || undefined);
	apply("baseUrl", config.baseUrl?.trim() || undefined);
	if (config.apiKey === undefined) {
	} else {
		apply("apiKey", config.apiKey.trim() || undefined);
	}
	apply("authHeader", config.authHeader ? true : undefined);
	mergedEntry.models = mergedModels;
	return mergedEntry;
}

function numMeta(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function boolMeta(v: unknown): boolean | undefined {
	return typeof v === "boolean" ? v : undefined;
}

function strArrMeta(v: unknown): string[] | undefined {
	return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
}

export function detectReasoningCapability(id: string, rawMeta?: Record<string, unknown>): boolean {
	if (!id) return false;
	const r = rawMeta ?? {};
	const modalities = strArrMeta(r.modalities) ?? strArrMeta(r.input_modalities);
	if (
		boolMeta(r.reasoning) === true ||
		boolMeta(r.supports_reasoning) === true ||
		modalities?.includes("reasoning") === true
	) {
		return true;
	}

	const lower = id.toLowerCase();
	const REASONING_PATTERNS = [
		/thinking|reasoner|reasoning/i,
		/(?:^|[-_/])o[134](?:[-_](?:mini|preview|high|low|medium|max))?(?:[-_/]|$)/i,
		/(?:^|[-_/])(?:deepseek[-_])?r1(?:[-_/]|$)/i,
		/(?:^|[-_/])qwq(?:[-_]\d+b)?(?:[-_/]|$)/i,
		/(?:^|[-_/])(?:glm[-_]4[-_]?zero|glm[-_]?zero)(?:[-_/]|$)/i,
		/(?:^|[-_/])cot(?:[-_/]|$)/i,
	];

	return REASONING_PATTERNS.some((pattern) => pattern.test(lower));
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];

const DEFAULT_THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];

const THINKING_LEVEL_ALIASES: Record<string, ThinkingLevel> = {
	off: "off",
	none: "off",
	no: "off",
	"none-thinking": "off",
	nothink: "off",
	"no-think": "off",
	disabled: "off",
	disable: "off",
	minimal: "minimal",
	min: "minimal",
	minimum: "minimal",
	low: "low",
	medium: "medium",
	med: "medium",
	mid: "medium",
	middle: "medium",
	high: "high",
	xhigh: "xhigh",
	"x-high": "xhigh",
	"extra-high": "xhigh",
	"very-high": "xhigh",
	max: "max",
	maximum: "max",
	ultra: "max",
};

const THINKING_LEVEL_META_KEYS = [
	"reasoning_levels",
	"reasoningLevels",
	"supported_reasoning_levels",
	"supportedReasoningLevels",
	"thinking_levels",
	"supported_thinking_levels",
	"supportedThinkingLevels",
] as const;

function normalizeLevelToken(token: string): string {
	return token
		.trim()
		.toLowerCase()
		.replace(/[\s_]+/g, "-");
}

function collectLevelTokens(value: unknown, out: string[], depth = 0): void {
	if (depth > 2 || value === null || value === undefined) return;
	if (typeof value === "string") {
		for (const part of value.split(/[,;|]/)) if (part.trim()) out.push(part);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			if (typeof item === "string") {
				out.push(item);
				continue;
			}
			if (item && typeof item === "object") {
				const row = item as Record<string, unknown>;
				for (const key of ["effort", "level", "name", "id", "value", "type"]) {
					if (typeof row[key] === "string") {
						out.push(row[key] as string);
						break;
					}
				}
			}
		}
		return;
	}
	if (typeof value === "object") {
		const row = value as Record<string, unknown>;
		for (const key of ["levels", "values", "supported"]) {
			if (key in row) {
				collectLevelTokens(row[key], out, depth + 1);
				return;
			}
		}
		for (const [key, val] of Object.entries(row)) {
			if (val === false || val === null || val === undefined) continue;
			out.push(key);
		}
	}
}

export function buildThinkingLevelMapFromMeta(raw?: Record<string, unknown>): UiThinkingLevelMap | undefined {
	const meta = raw ?? {};
	const tokens: string[] = [];
	for (const key of THINKING_LEVEL_META_KEYS) {
		if (key in meta) collectLevelTokens(meta[key], tokens);
	}
	if (tokens.length === 0) return undefined;

	const advertised = new Map<ThinkingLevel, string>();
	for (const token of tokens) {
		const level = THINKING_LEVEL_ALIASES[normalizeLevelToken(token)];
		if (level && !advertised.has(level)) advertised.set(level, token.trim());
	}
	if (![...advertised.keys()].some((level) => level !== "off")) return undefined;

	const map: UiThinkingLevelMap = {};
	for (const level of THINKING_LEVELS) {
		if (level === "off") {
			const offLiteral = advertised.get("off");
			if (offLiteral) map.off = offLiteral;
			continue;
		}
		map[level] = advertised.get(level) ?? null;
	}

	const enabled = THINKING_LEVELS.filter((level) => map[level] !== null);
	const sameAsDefault =
		enabled.length === DEFAULT_THINKING_LEVELS.length &&
		enabled.every((level, i) => level === DEFAULT_THINKING_LEVELS[i]);
	if (sameAsDefault && map.off === undefined) return undefined;
	return map;
}

export function sanitizeThinkingLevelMap(value: unknown): UiThinkingLevelMap | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const src = value as Record<string, unknown>;
	const out: UiThinkingLevelMap = {};
	for (const level of THINKING_LEVELS) {
		const raw = src[level];
		if (raw === null) out[level] = null;
		else if (typeof raw === "string" && raw.trim()) out[level] = raw.trim();
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function parseOpenAiModel(m: unknown): UiModelConfigEntry {
	const r = (m ?? {}) as Record<string, unknown>;
	const id = typeof r.id === "string" ? r.id : "";
	const name =
		(typeof r.name === "string" && r.name.trim() ? r.name : undefined) ??
		(typeof r.display_name === "string" && r.display_name.trim() ? r.display_name : undefined);
	const modalities = strArrMeta(r.modalities) ?? strArrMeta(r.input_modalities);
	const vision =
		modalities?.includes("image") === true ||
		boolMeta(r.supports_vision) === true ||
		boolMeta(r.vision) === true ||
		strArrMeta(r.input)?.includes("image") === true;
	const knownSpec = resolveModelReasoningSpec(id, r);
	const thinkingLevelMap = buildThinkingLevelMapFromMeta(r) ?? knownSpec?.thinkingLevelMap;
	const reasoning = detectReasoningCapability(id, r) || thinkingLevelMap !== undefined || Boolean(knownSpec);
	const contextWindow =
		numMeta(r.context_window) ?? numMeta(r.context_length) ?? numMeta(r.max_model_len) ?? numMeta(r.max_context_length);
	const maxTokens = numMeta(r.max_tokens) ?? numMeta(r.max_output_tokens) ?? numMeta(r.max_completion_tokens);
	return {
		id,
		...(name ? { name } : {}),
		...(reasoning ? { reasoning: true } : {}),
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
		...(vision ? { input: ["text", "image"] } : {}),
		...(contextWindow ? { contextWindow } : {}),
		...(maxTokens ? { maxTokens } : {}),
	};
}

function parseGoogleModel(m: unknown): UiModelConfigEntry {
	const r = (m ?? {}) as Record<string, unknown>;
	const rawName = typeof r.name === "string" ? r.name : "";
	const id = rawName.replace(/^models\//, "");
	const displayName = typeof r.displayName === "string" ? r.displayName : undefined;
	const knownGoogleSpec = resolveModelReasoningSpec(id, r);
	const thinkingLevelMap = buildThinkingLevelMapFromMeta(r) ?? knownGoogleSpec?.thinkingLevelMap;
	const reasoning = detectReasoningCapability(id, r) || thinkingLevelMap !== undefined || Boolean(knownGoogleSpec);
	return {
		id,
		...(displayName && displayName !== id ? { name: displayName } : {}),
		...(reasoning ? { reasoning: true } : {}),
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
		...(numMeta(r.inputTokenLimit) ? { contextWindow: numMeta(r.inputTokenLimit) } : {}),
		...(numMeta(r.outputTokenLimit) ? { maxTokens: numMeta(r.outputTokenLimit) } : {}),
	};
}

export interface ProviderKeysData {
	activeKeyName: string | null;
	keys: { name: string; apiKey: string }[];
}

export const CREDENTIAL_FILE_MODE = 0o600;

export function writeCredentialFile(path: string, data: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, data, { mode: CREDENTIAL_FILE_MODE });
	try {
		chmodSync(path, CREDENTIAL_FILE_MODE);
	} catch {}
}

export function ensureCredentialFilePermissions(agentDir: string): void {
	for (const name of ["provider-keys.json", "auth.json", "models.json"]) {
		try {
			chmodSync(join(agentDir, name), CREDENTIAL_FILE_MODE);
		} catch {}
	}
}

export class ModelAdminService {
	private readonly oauthFlows: ProviderOAuthFlowManager;
	private readonly activeEnrichAbort = new Map<number, AbortController>();

	constructor(private readonly host: ModelAdminHost) {
		ensureCredentialFilePermissions(host.agentDir);
		this.oauthFlows = new ProviderOAuthFlowManager({
			modelRuntime:
				host.modelRuntime ??
				(() => {
					throw new Error("OAuth not supported without ModelRuntime");
				}),
			emit: host.emit,
			isDisposed: host.isDisposed,
			onLoginSuccess: (provider) => this.onOAuthLoginSuccess(provider),
		});
	}

	startProviderOAuth(provider: string): string | null {
		return this.oauthFlows.start(provider);
	}

	replyProviderOAuth(flowId: string, promptId: string, value: string): void {
		this.oauthFlows.reply(flowId, promptId, value);
	}

	cancelProviderOAuth(flowId: string): void {
		this.oauthFlows.cancel(flowId);
	}

	listProviderOAuthFlows(): void {
		this.oauthFlows.list();
	}

	dispose(): void {
		this.oauthFlows.dispose();
		for (const ac of this.activeEnrichAbort.values()) {
			ac.abort();
		}
		this.activeEnrichAbort.clear();
	}

	abortEnrichModels(reqId?: number): void {
		if (reqId !== undefined) {
			const ac = this.activeEnrichAbort.get(reqId);
			if (ac) {
				ac.abort();
				this.activeEnrichAbort.delete(reqId);
			}
		} else {
			for (const ac of this.activeEnrichAbort.values()) {
				ac.abort();
			}
			this.activeEnrichAbort.clear();
		}
	}

	async logoutProviderOAuth(provider: string): Promise<void> {
		const providerId = provider.trim();
		try {
			const runtime = this.host.modelRuntime?.();
			if (!runtime || !providerId || !runtime.getProvider(providerId)?.auth.oauth) {
				throw new Error("该服务商不支持 OAuth 登录");
			}
			await runtime.logout(providerId);
			this.host.invalidatePiConfig?.();
			await this.host.pushModels();
			await this.listProviders();
			this.host.emit({ type: "provider_oauth_logout_result", provider: providerId, ok: true });
		} catch (error) {
			this.host.emit({
				type: "provider_oauth_logout_result",
				provider: providerId,
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			this.host.flushSnapshot();
		}
	}

	private async onOAuthLoginSuccess(provider: string): Promise<void> {
		const keys = this.readProviderKeys();
		if (keys[provider]) {
			keys[provider].activeKeyName = null;
			this.writeProviderKeys(keys);
		}
		this.host.onOAuthActivated?.(provider);
		this.host.invalidatePiConfig?.();
		await this.host.pushModels();
		await this.listProviders();
		this.listProviderKeys();
		this.host.flushSnapshot();
	}

	private providerKeysPath(): string {
		return join(this.host.agentDir, "provider-keys.json");
	}

	private readProviderKeys(): Record<string, ProviderKeysData> {
		let raw: string;
		try {
			raw = readFileSync(this.providerKeysPath(), "utf8");
		} catch {
			return {};
		}
		let parsed: Record<string, { activeKeyName?: string | null; keys?: { name: string; apiKey: string }[] }>;
		try {
			parsed = JSON.parse(raw) as Record<
				string,
				{ activeKeyName?: string | null; keys?: { name: string; apiKey: string }[] }
			>;
		} catch (err) {
			this.quarantineCorruptFile(this.providerKeysPath(), err);
			return {};
		}
		const out: Record<string, ProviderKeysData> = {};
		for (const [pid, entry] of Object.entries(parsed)) {
			const keys = Array.isArray(entry?.keys) ? entry.keys.filter((k) => k?.name && k?.apiKey) : [];
			if (!pid || keys.length === 0) continue;
			const activeKeyName =
				entry.activeKeyName === null
					? null
					: entry.activeKeyName && keys.some((k) => k.name === entry.activeKeyName)
						? entry.activeKeyName
						: keys[0].name;
			out[pid] = { activeKeyName, keys };
		}
		return out;
	}

	private writeProviderKeys(data: Record<string, ProviderKeysData>): void {
		atomicWriteCredentialJson(this.providerKeysPath(), data);
		try {
			chmodSync(join(this.host.agentDir, "auth.json"), CREDENTIAL_FILE_MODE);
		} catch {}
	}

	private quarantineCorruptFile(path: string, err: unknown): void {
		try {
			renameSync(path, `${path}.corrupt-${Date.now()}`);
			console.warn(`[model-admin] 配置文件解析失败，已改名留存：${path}（${(err as Error).message}）`);
		} catch {
			console.warn(`[model-admin] 配置文件解析失败且无法留存：${path}（${(err as Error).message}）`);
		}
	}

	private defaultKeyName(keys: { name: string; apiKey: string }[]): string {
		return `密钥 ${keys.length + 1}`;
	}

	private uniqueKeyName(entry: { keys: { name: string; apiKey: string }[] }, wanted: string | undefined): string {
		const base = (wanted?.trim() || this.defaultKeyName(entry.keys)).trim() || this.defaultKeyName(entry.keys);
		const taken = new Set(entry.keys.map((k) => k.name));
		let name = base;
		let n = 2;
		while (taken.has(name)) name = `${base} (${n++})`;
		return name;
	}

	private providerKeysInfo(data: Record<string, ProviderKeysData>): { keys: Record<string, ProviderKeyInfo[]> } {
		const keys: Record<string, ProviderKeyInfo[]> = {};
		for (const [pid, entry] of Object.entries(data)) {
			keys[pid] = entry.keys.map((k) => ({ name: k.name, active: entry.activeKeyName === k.name }));
		}
		return { keys };
	}

	getActiveKeyName(provider: string): string | null {
		const data = this.readProviderKeys();
		return data[provider]?.activeKeyName ?? null;
	}

	hasProviderKey(provider: string, keyName: string): boolean {
		const pid = provider.trim();
		const targetName = keyName.trim();
		if (!pid || !targetName) return false;
		try {
			return this.readProviderKeys()[pid]?.keys.some((k) => k.name === targetName) ?? false;
		} catch {
			return false;
		}
	}

	private seedProviderKeysFromAuth(pid: string, data: Record<string, ProviderKeysData>): void {
		if (data[pid]) return;
		try {
			const auth = JSON.parse(readFileSync(join(this.host.agentDir, "auth.json"), "utf8")) as Record<
				string,
				{ key?: string; type?: string; [k: string]: unknown }
			>;
			const cred = auth[pid];
			if (cred && typeof cred.key === "string" && cred.key.trim()) {
				data[pid] = {
					activeKeyName: "密钥 1",
					keys: [{ name: "密钥 1", apiKey: cred.key.trim() }],
				};
			}
		} catch {}
	}

	listProviderKeys(): void {
		const path = this.providerKeysPath();
		const data = this.readProviderKeys();
		if (!existsSync(path)) {
			for (const pid of this.builtinProviderIds()) this.seedProviderKeysFromAuth(pid, data);
			this.writeProviderKeys(data);
		}
		this.host.emit({ type: "provider_keys", ...this.providerKeysInfo(data) });
		this.host.flushSnapshot();
	}

	private builtinProviderIds(): string[] {
		const data = this.readProviderKeys();
		const ids = new Set(Object.keys(data));
		try {
			const mr = this.host.modelRuntime?.();
			if (mr) {
				for (const p of mr.getProviders()) ids.add(p.id);
			}
		} catch {}
		for (const id of [
			"anthropic",
			"openai",
			"google",
			"deepseek",
			"groq",
			"mistral",
			"openrouter",
			"ollama",
			"llama.cpp",
		]) {
			ids.add(id);
		}
		return [...ids];
	}

	private async applyActiveKey(pid: string, apiKey: string): Promise<void> {
		const authPath = join(this.host.agentDir, "auth.json");
		let data: Record<string, unknown> = {};
		try {
			data = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
		} catch {}
		if (pid === "llama.cpp") {
			const prevLlama = (data[pid] ?? {}) as { env?: { LLAMA_BASE_URL?: string } };
			const baseUrl = prevLlama.env?.LLAMA_BASE_URL || process.env.LLAMA_BASE_URL || "http://127.0.0.1:8080";
			data[pid] = {
				type: "api_key",
				key: apiKey || "local",
				env: { LLAMA_BASE_URL: baseUrl },
			};
		} else {
			data[pid] = { type: "api_key", key: apiKey };
		}
		atomicWriteCredentialJson(authPath, data);
		try {
			chmodSync(this.providerKeysPath(), CREDENTIAL_FILE_MODE);
		} catch {}
		const mr = this.host.modelRuntime?.();
		if (mr) {
			await mr.setRuntimeApiKey(pid, apiKey);
			await mr.refresh({ allowNetwork: true, providers: [pid] });
		}
		this.host.invalidatePiConfig?.();
	}

	async setProviderApiKey(provider: string, apiKey: string): Promise<void> {
		const pid = provider.trim();
		const key = apiKey.trim();
		if (!pid) {
			this.host.emit({ type: "notice", level: "error", text: "请填写服务商 ID", textEn: "Enter a provider ID" });
			return;
		}
		if (!key) {
			this.host.emit({ type: "notice", level: "error", text: "请填写 API 密钥", textEn: "Enter an API key" });
			return;
		}
		try {
			const data = this.readProviderKeys();
			if (!data[pid]) this.seedProviderKeysFromAuth(pid, data);
			let entry = data[pid];
			if (!entry) entry = data[pid] = { activeKeyName: null, keys: [] };
			const existing = entry.keys.find((k) => k.apiKey === key);
			let name: string;
			if (existing) {
				entry.activeKeyName = existing.name;
				name = existing.name;
			} else {
				name = this.uniqueKeyName(entry, undefined);
				entry.keys.push({ name, apiKey: key });
				entry.activeKeyName = name;
			}
			this.writeProviderKeys(data);
			await this.applyActiveKey(pid, key);
			this.host.emit({
				type: "notice",
				level: "info",
				text: `✅ 已保存 ${pid} 的密钥「${name}」并刷新模型列表`,
				textEn: `✅ Saved key "${name}" for ${pid} and refreshed the model list`,
			});
			await this.host.pushModels();
			await this.listProviders();
			this.listProviderKeys();
		} catch (err) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: `保存 API 密钥失败：${(err as Error).message}`,
				textEn: `Failed to save API key: ${(err as Error).message}`,
			});
		}
		this.host.flushSnapshot();
	}

	async addProviderKey(provider: string, apiKey: string, name?: string): Promise<void> {
		const pid = provider.trim();
		const key = apiKey.trim();
		if (!pid) {
			this.host.emit({ type: "notice", level: "error", text: "请填写服务商 ID", textEn: "Enter a provider ID" });
			return;
		}
		if (!key) {
			this.host.emit({ type: "notice", level: "error", text: "请填写 API 密钥", textEn: "Enter an API key" });
			return;
		}
		try {
			const data = this.readProviderKeys();
			if (!data[pid]) this.seedProviderKeysFromAuth(pid, data);
			let entry = data[pid];
			if (!entry) entry = data[pid] = { activeKeyName: null, keys: [] };
			const dup = entry.keys.find((k) => k.apiKey === key);
			if (dup) {
				this.host.emit({
					type: "notice",
					level: "info",
					text: `${pid} 已存在该密钥`,
					textEn: `${pid} already has this key`,
				});
				return;
			}
			const keyName = this.uniqueKeyName(entry, name);
			entry.keys.push({ name: keyName, apiKey: key });
			if (!entry.activeKeyName) entry.activeKeyName = keyName;
			this.writeProviderKeys(data);
			const isActive = entry.activeKeyName === keyName;
			if (isActive) {
				await this.applyActiveKey(pid, key);
				this.host.emit({
					type: "notice",
					level: "info",
					text: `🔑 已添加 ${pid} 的密钥「${keyName}」并设为当前`,
					textEn: `🔑 Added key "${keyName}" for ${pid} and set it active`,
				});
			} else {
				this.host.emit({
					type: "notice",
					level: "info",
					text: `🔑 已添加 ${pid} 的密钥「${keyName}」，点击模型时可切换使用`,
					textEn: `🔑 Added key "${keyName}" for ${pid}; click a model to switch to it`,
				});
			}
			await this.host.pushModels();
			await this.listProviders();
			this.listProviderKeys();
		} catch (err) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: `添加密钥失败：${(err as Error).message}`,
				textEn: `Failed to add key: ${(err as Error).message}`,
			});
		}
		this.host.flushSnapshot();
	}

	async activateProviderKey(provider: string, keyName: string, opts?: { silent?: boolean }): Promise<boolean> {
		const pid = provider.trim();
		const targetName = keyName.trim();
		const silent = opts?.silent === true;
		const notice = (msg: ServerMessage) => {
			if (!silent) this.host.emit(msg);
		};
		try {
			const data = this.readProviderKeys();
			const entry = data[pid];
			const target = entry?.keys.find((k) => k.name === targetName);
			if (!target) {
				notice({
					type: "notice",
					level: "error",
					text: `${pid} 的密钥「${targetName}」不存在`,
					textEn: `Key "${targetName}" for ${pid} does not exist`,
				});
				return false;
			}
			if (entry.activeKeyName === targetName) {
				notice({
					type: "notice",
					level: "info",
					text: `「${targetName}」已是当前密钥`,
					textEn: `"${targetName}" is already the active key`,
				});
				return true;
			}
			entry.activeKeyName = targetName;
			this.writeProviderKeys(data);
			await this.applyActiveKey(pid, target.apiKey);
			notice({
				type: "notice",
				level: "info",
				text: `⚡ 已切换到 ${pid} 的「${targetName}」`,
				textEn: `⚡ Switched to "${targetName}" for ${pid}`,
			});
			await this.host.pushModels();
			await this.listProviders();
			this.listProviderKeys();
			return true;
		} catch (err) {
			notice({
				type: "notice",
				level: "error",
				text: `切换密钥失败：${(err as Error).message}`,
				textEn: `Failed to switch key: ${(err as Error).message}`,
			});
			return false;
		} finally {
			if (!silent) this.host.flushSnapshot();
		}
	}

	async removeProviderKey(provider: string, keyName: string): Promise<void> {
		const pid = provider.trim();
		const targetName = keyName.trim();
		try {
			const data = this.readProviderKeys();
			const entry = data[pid];
			if (!entry || !entry.keys.some((k) => k.name === targetName)) {
				this.host.emit({
					type: "notice",
					level: "error",
					text: `${pid} 的密钥「${targetName}」不存在`,
					textEn: `Key "${targetName}" for ${pid} does not exist`,
				});
				return;
			}
			const wasActive = entry.activeKeyName === targetName;
			entry.keys = entry.keys.filter((k) => k.name !== targetName);
			if (entry.keys.length === 0) {
				delete data[pid];
				this.writeProviderKeys(data);
				const authPath = join(this.host.agentDir, "auth.json");
				let auth: Record<string, unknown> = {};
				try {
					auth = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
				} catch {}
				delete auth[pid];
				atomicWriteCredentialJson(authPath, auth);
				const mr = this.host.modelRuntime?.();
				if (mr) {
					await mr.removeRuntimeApiKey(pid);
					await mr.refresh({ providers: [pid] });
				}
				this.host.invalidatePiConfig?.();
				this.host.emit({
					type: "notice",
					level: "info",
					text: `🗑  已移除 ${pid} 的密钥「${targetName}」，该服务商回到未配置状态`,
					textEn: `🗑  Removed key "${targetName}" for ${pid}; provider is now unconfigured`,
				});
			} else {
				if (wasActive) {
					entry.activeKeyName = entry.keys[0].name;
					this.writeProviderKeys(data);
					await this.applyActiveKey(pid, entry.keys[0].apiKey);
				} else {
					this.writeProviderKeys(data);
				}
				this.host.emit({
					type: "notice",
					level: "info",
					text: wasActive
						? `🗑  已移除「${targetName}」，已切换到 ${entry.keys[0].name}`
						: `🗑  已移除 ${pid} 的密钥「${targetName}」`,
					textEn: wasActive
						? `🗑  Removed "${targetName}", switched to ${entry.keys[0].name}`
						: `🗑  Removed key "${targetName}" for ${pid}`,
				});
			}
			await this.host.pushModels();
			await this.listProviders();
			this.listProviderKeys();
		} catch (err) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: `移除密钥失败：${(err as Error).message}`,
				textEn: `Failed to remove key: ${(err as Error).message}`,
			});
		}
		this.host.flushSnapshot();
	}

	async clearProviderApiKey(provider: string): Promise<void> {
		const pid = provider.trim();
		if (!pid) {
			this.host.emit({ type: "notice", level: "error", text: "请填写服务商 ID", textEn: "Enter a provider ID" });
			return;
		}
		if (this.host.modelRuntime?.()?.isUsingOAuth(pid)) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: "请使用 OAuth 登出操作清除当前登录",
				textEn: "Use the OAuth sign-out action to clear the current login",
			});
			this.host.flushSnapshot();
			return;
		}
		try {
			const authPath = join(this.host.agentDir, "auth.json");
			let data: Record<string, unknown> = {};
			try {
				data = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
			} catch {}
			const keyData = this.readProviderKeys();
			const hasStoredKeys = (keyData[pid]?.keys.length ?? 0) > 0;
			if (!(pid in data) && !hasStoredKeys) {
				this.host.emit({
					type: "notice",
					level: "info",
					text: `${pid} 没有已保存的密钥`,
					textEn: `${pid} has no saved key`,
				});
				return;
			}
			delete data[pid];
			atomicWriteCredentialJson(authPath, data);
			delete keyData[pid];
			this.writeProviderKeys(keyData);
			const mr = this.host.modelRuntime?.();
			if (mr) {
				await mr.removeRuntimeApiKey(pid);
				await mr.refresh({ providers: [pid] });
			}
			this.host.invalidatePiConfig?.();
			this.host.emit({
				type: "notice",
				level: "info",
				text: `🗑  已清除 ${pid} 的密钥，该服务商回到未配置状态`,
				textEn: `🗑  Cleared keys for ${pid}; provider is now unconfigured`,
			});
			await this.host.pushModels();
			await this.listProviders();
			this.listProviderKeys();
		} catch (err) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: `清除密钥失败：${(err as Error).message}`,
				textEn: `Failed to clear key: ${(err as Error).message}`,
			});
		}
		this.host.flushSnapshot();
	}

	async cloneProvider(providerId: string, reqId: number): Promise<void> {
		const pid = providerId.trim();
		const fail = (error: string, errorEn?: string) => {
			this.host.emit({ type: "notice", level: "error", text: error, textEn: errorEn });
			this.host.emit({ type: "clone_provider_result", reqId, ok: false, error });
		};
		try {
			if (!pid) {
				fail("请填写服务商 ID", "Enter a provider ID");
				return;
			}
			const mr = this.host.modelRuntime?.();
			const p = mr?.getProvider(pid);
			if (!mr || !p) {
				const { providers } = this.readModelsConfig();
				const saved = providers[pid];
				if (!saved) {
					fail(`供应商 ${pid} 不存在`, `Provider ${pid} does not exist`);
					return;
				}
				this.host.emit({
					type: "clone_provider_result",
					reqId,
					ok: true,
					config: {
						providerId: `${pid}-clone`,
						name: `${(saved.name as string) ?? pid} (副本)`,
						baseUrl: saved.baseUrl as string | undefined,
						api: saved.api as string | undefined,
						hasApiKey: false,
						models: Array.isArray(saved.models) ? (saved.models as any) : [],
					},
				});
				return;
			}
			const noBaseUrl = !p.baseUrl;
			const readModels = (): { api: string; entry: UiModelConfigEntry }[] => {
				try {
					return mr.getModels(pid).map((m) => ({
						api: m.api,
						entry: {
							id: m.id,
							...(m.name && m.name !== m.id ? { name: m.name } : {}),
							...(m.reasoning ? { reasoning: true } : {}),
							...(m.input?.includes("image") ? { input: ["text", "image"] } : {}),
							...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
							...(m.maxTokens ? { maxTokens: m.maxTokens } : {}),
						},
					}));
				} catch {
					return [];
				}
			};
			let models = readModels();
			if (models.length === 0) {
				await mr.refresh({ allowNetwork: true });
				models = readModels();
			}
			if (models.length === 0) {
				fail(
					`${pid} 的模型列表为空，无法复制（请稍后重试）`,
					`Model list for ${pid} is empty, cannot clone (retry later)`,
				);
				return;
			}
			const counts = new Map<string, number>();
			for (const m of models) counts.set(m.api, (counts.get(m.api) ?? 0) + 1);
			let api = models[0].api;
			for (const [k, v] of counts) if (v > (counts.get(api) ?? 0)) api = k;
			const keptMap = new Map<string, UiModelConfigEntry>();
			for (const m of models) if (!keptMap.has(m.entry.id)) keptMap.set(m.entry.id, m.entry);
			const kept = [...keptMap.values()].sort((a, b) => a.id.localeCompare(b.id));
			const taken = new Set([...Object.keys(this.readModelsConfig().providers), ...mr.getRegisteredProviderIds()]);
			let newId = `${pid}-2`;
			for (let n = 2; taken.has(newId); n++) newId = `${pid}-${n}`;
			const defaultBaseUrl =
				noBaseUrl && (pid === "opencode-go" || pid === "opencode") ? "http://127.0.0.1:4096" : undefined;
			const config: UiProviderConfig = {
				providerId: newId,
				name: p.name,
				api,
				...(p.baseUrl ? { baseUrl: p.baseUrl } : defaultBaseUrl ? { baseUrl: defaultBaseUrl } : {}),
				models: kept,
			};
			this.host.emit({
				type: "notice",
				level: noBaseUrl ? "warning" : "info",
				text: noBaseUrl
					? `📋 已复制 ${pid} → ${newId}（${kept.length} 个模型），该供应商无远程 baseUrl，已生成模板请手动填写 baseUrl 和新的 API 密钥后保存`
					: `📋 已复制 ${pid} → ${newId}（${kept.length} 个模型），请填入新的 API 密钥后保存`,
				textEn: noBaseUrl
					? `📋 Cloned ${pid} → ${newId} (${kept.length} models); this provider has no remote baseUrl — template generated, fill in baseUrl and a new API key, then save`
					: `📋 Cloned ${pid} → ${newId} (${kept.length} models); fill in the new API key, then save`,
			});
			this.host.emit({ type: "clone_provider_result", reqId, ok: true, config, configs: [config] });
		} catch (err) {
			fail(`复制服务商失败：${(err as Error).message}`, `Failed to clone provider: ${(err as Error).message}`);
		}
		this.host.flushSnapshot();
	}

	async enrichModels(
		reqId: number,
		ids: string[],
		hints: Record<string, string> | undefined,
		lang?: () => ServerLang,
	): Promise<void> {
		const l = lang?.() ?? "en";
		const ac = new AbortController();
		this.activeEnrichAbort.set(reqId, ac);
		try {
			const cleanIds = [...new Set((ids ?? []).map((s) => (s ?? "").trim()).filter(Boolean))].slice(0, 100);
			if (cleanIds.length === 0) {
				throw new Error(pick(l, "没有可补的模型 id", "No model ids to enrich", "models.enrich.empty"));
			}
			const cleanHints: Record<string, string> = {};
			for (const [k, v] of Object.entries(hints ?? {})) {
				if (k.trim() && (v ?? "").trim()) cleanHints[k.trim()] = (v ?? "").trim();
			}
			const results = await enrichBatch(cleanIds, cleanHints, {
				lang: (l === "zh" ? "zh" : "en") as EnrichLang,
				signal: ac.signal,
				onProgress: (p) => {
					this.host.emit({
						type: "enrich_models_progress",
						reqId,
						phase: p.phase,
						current: p.current,
						total: p.total,
						message: p.message,
					});
				},
			});
			const matched = results.filter((r) => r.status === "matched").length;
			const suggested = results.filter((r) => r.status === "suggested").length;
			this.host.emit({ type: "enrich_models_result", reqId, ok: true, results });
			this.host.emit({
				type: "notice",
				level: "info",
				text: `🔍 已补 ${matched} 个${suggested ? `，另有 ${suggested} 个只找到相近家族（见建议）` : ""}，共 ${results.length} 个`,
				textEn: `🔍 Enriched ${matched}${suggested ? `, ${suggested} with family suggestions` : ""} of ${results.length}`,
			});
		} catch (err) {
			const isAbort = (err as Error).message === "aborted" || ac.signal.aborted;
			const partial = (err as unknown as { partialResults?: UiEnrichResult[] }).partialResults;
			if (isAbort) {
				const hasPartial = Array.isArray(partial) && partial.length > 0;
				if (hasPartial) {
					const matched = partial.filter((r) => r.status === "matched").length;
					this.host.emit({ type: "enrich_models_result", reqId, ok: true, results: partial });
					this.host.emit({
						type: "notice",
						level: "warning",
						text: `⏹ 已中断补参数（已保留中断前匹配的 ${matched} 个模型）`,
						textEn: `⏹ Model enrichment aborted (kept ${matched} models matched before abort)`,
					});
				} else {
					this.host.emit({
						type: "enrich_models_result",
						reqId,
						ok: false,
						error: pick(l, "已取消补参数", "Model enrichment cancelled", "models.enrich.cancelled"),
					});
					this.host.emit({
						type: "notice",
						level: "warning",
						text: pick(l, "已取消补参数", "Model enrichment cancelled", "models.enrich.cancelled"),
					});
				}
			} else {
				const error = (err as Error).message;
				this.host.emit({ type: "enrich_models_result", reqId, ok: false, error });
				this.host.emit({
					type: "notice",
					level: "error",
					text: `补参数失败：${error}`,
					textEn: `Enrich failed: ${error}`,
				});
			}
		} finally {
			this.activeEnrichAbort.delete(reqId);
		}
		this.host.flushSnapshot();
	}

	async listProviders(): Promise<void> {
		const mr = this.host.modelRuntime?.();
		let providers;
		if (mr) {
			try {
				providers = mr.getProviders().map((p) => {
					const supportsApiKey = p.auth.apiKey !== undefined;
					const supportsOAuth = p.auth.oauth !== undefined;
					const oauthName = p.auth.oauth?.name;
					try {
						const st = mr.getProviderAuthStatus(p.id);
						return {
							id: p.id,
							name: p.name,
							configured: st?.configured ?? false,
							source: st?.source,
							supportsApiKey,
							supportsOAuth,
							oauthName,
							usingOAuth: mr.isUsingOAuth(p.id),
						};
					} catch {
						return {
							id: p.id,
							name: p.name,
							configured: false,
							supportsApiKey,
							supportsOAuth,
							oauthName,
							usingOAuth: false,
						};
					}
				});
			} catch (err) {
				this.host.emit({
					type: "notice",
					level: "error",
					text: `获取服务商列表失败：${(err as Error).message}`,
					textEn: `Failed to fetch provider list: ${(err as Error).message}`,
				});
				return;
			}
		} else {
			let auth: Record<string, unknown> = {};
			try {
				auth = JSON.parse(readFileSync(join(this.host.agentDir, "auth.json"), "utf8")) as Record<string, unknown>;
			} catch {}
			const keyData = this.readProviderKeys();
			const { providers: custom } = this.readModelsConfig();
			const builtins = [
				{ id: "anthropic", name: "Anthropic" },
				{ id: "openai", name: "OpenAI" },
				{ id: "deepseek", name: "DeepSeek" },
				{ id: "google", name: "Google Gemini" },
				{ id: "openrouter", name: "OpenRouter" },
				{ id: "groq", name: "Groq" },
				{ id: "mistral", name: "Mistral" },
				{ id: "ollama", name: "Ollama" },
				{ id: "llama.cpp", name: "llama.cpp" },
			];
			const allIds = new Set<string>();
			providers = [];
			for (const b of builtins) {
				allIds.add(b.id);
				const hasStored = Boolean(auth[b.id] || (keyData[b.id]?.keys.length ?? 0) > 0);
				const hasEnv = Boolean(
					(b.id === "anthropic" && process.env.ANTHROPIC_API_KEY) ||
					(b.id === "deepseek" && process.env.DEEPSEEK_API_KEY) ||
					(b.id === "openai" && process.env.OPENAI_API_KEY) ||
					(b.id === "openrouter" && process.env.OPENROUTER_API_KEY) ||
					(b.id === "google" && (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)) ||
					(b.id === "llama.cpp" && process.env.LLAMA_BASE_URL),
				);
				providers.push({
					id: b.id,
					name: b.name,
					configured: hasStored || hasEnv,
					source: (hasStored ? "stored" : hasEnv ? "environment" : undefined) as "stored" | "environment" | undefined,
					supportsApiKey: true,
					supportsOAuth: false,
					usingOAuth: false,
				});
			}
			for (const [cid, c] of Object.entries(custom)) {
				if (!allIds.has(cid)) {
					allIds.add(cid);
					const hasKey = typeof c.apiKey === "string" && c.apiKey.trim() !== "";
					const hasStored = Boolean(auth[cid] || (keyData[cid]?.keys.length ?? 0) > 0);
					providers.push({
						id: cid,
						name: (c.name as string) || cid,
						configured: hasKey || hasStored,
						source: (hasKey ? "stored" : hasStored ? "stored" : undefined) as "stored" | "environment" | undefined,
						supportsApiKey: true,
						supportsOAuth: false,
						usingOAuth: false,
					});
				}
			}
		}
		if (providers.length === 0) {
			this.host.emit({
				type: "notice",
				level: "warning",
				text: "服务商列表为空——pi 运行时未注册任何提供商",
				textEn: "Provider list is empty — the pi runtime registered no providers",
			});
		}
		this.host.emit({ type: "providers_status", providers });
	}

	private modelsConfigPath(): string {
		return join(this.host.agentDir, "models.json");
	}

	private readModelsConfig(): {
		providers: Record<string, Record<string, unknown>>;
	} {
		const path = this.modelsConfigPath();
		try {
			const raw = readFileSync(path, "utf8");
			const parsed = JSON.parse(stripJsonComments(raw)) as {
				providers?: Record<string, Record<string, unknown>>;
			};
			return { providers: parsed?.providers ?? {} };
		} catch {
			return { providers: {} };
		}
	}

	async listModelsConfig(): Promise<void> {
		const { providers } = this.readModelsConfig();
		const list: UiProviderConfig[] = Object.entries(providers).map(([providerId, p]) => {
			const models = Array.isArray(p.models)
				? (p.models as Record<string, unknown>[]).map((m) => ({
						id: String(m.id ?? ""),
						name: m.name as string | undefined,
						reasoning: m.reasoning as boolean | undefined,
						input: Array.isArray(m.input) ? (m.input as string[]) : undefined,
						contextWindow: m.contextWindow as number | undefined,
						maxTokens: m.maxTokens as number | undefined,
						thinkingLevelMap: sanitizeThinkingLevelMap(m.thinkingLevelMap),
					}))
				: [];
			return {
				providerId,
				name: p.name as string | undefined,
				api: p.api as string | undefined,
				baseUrl: p.baseUrl as string | undefined,
				hasApiKey: typeof p.apiKey === "string" && p.apiKey.trim() !== "",
				authHeader: p.authHeader as boolean | undefined,
				models,
			};
		});
		this.host.emit({ type: "models_config", providers: list });
	}

	async reloadModelsConfig(): Promise<void> {
		try {
			await this.host.modelRuntime?.()?.refresh();
			this.host.invalidatePiConfig?.();
			await this.listModelsConfig();
			await this.host.pushModels();
			this.host.emit({
				type: "notice",
				level: "info",
				text: "🔄 已从磁盘重新加载模型配置",
				textEn: "🔄 Reloaded model config from disk",
			});
		} catch (err) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: `重新加载模型配置失败：${(err as Error).message}`,
				textEn: `Failed to reload model config: ${(err as Error).message}`,
			});
		}
		this.host.flushSnapshot();
	}

	private savedProviderApiKey(providerId: string | undefined): string | undefined {
		const pid = providerId?.trim();
		if (!pid) return undefined;
		const saved = this.readModelsConfig().providers[pid] as { apiKey?: unknown } | undefined;
		return typeof saved?.apiKey === "string" && saved.apiKey.trim() ? saved.apiKey : undefined;
	}

	async fetchModelsList(
		reqId: number,
		baseUrl: string,
		apiKey?: string,
		authHeader?: boolean,
		api?: string,
		lang?: () => ServerLang,
		providerId?: string,
	): Promise<void> {
		const emitError = (error: string) => this.host.emit({ type: "fetch_models_result", reqId, ok: false, error });
		try {
			const key = apiKey?.trim() || this.savedProviderApiKey(providerId);
			const models = await ModelAdminService.probeModelsEndpoint(baseUrl, key, authHeader, api, undefined, lang);
			this.host.emit({ type: "fetch_models_result", reqId, ok: true, models });
		} catch (err) {
			emitError((err as Error).message);
		}
	}

	async testConnection(
		reqId: number,
		baseUrl: string,
		apiKey?: string,
		authHeader?: boolean,
		api?: string,
		lang?: () => ServerLang,
		providerId?: string,
	): Promise<void> {
		const start = Date.now();
		try {
			const key = apiKey?.trim() || this.savedProviderApiKey(providerId);
			await ModelAdminService.probeModelsEndpoint(baseUrl, key, authHeader, api, undefined, lang);
			const latencyMs = Date.now() - start;
			this.host.emit({ type: "test_model_connection_result", reqId, ok: true, latencyMs });
		} catch (err) {
			this.host.emit({
				type: "test_model_connection_result",
				reqId,
				ok: false,
				error: (err as Error).message,
			});
		}
	}

	static async probeModelsEndpoint(
		baseUrl: string,
		apiKey?: string,
		authHeader?: boolean,
		api?: string,
		extraHeaders?: Record<string, string>,
		lang?: () => ServerLang,
	): Promise<UiModelConfigEntry[]> {
		const l = lang?.() ?? "en";
		const base = (baseUrl ?? "").trim().replace(/\/+$/, "");
		if (!base) throw new Error(pick(l, "请先填写 baseUrl", "Enter the baseUrl first", "models.fetch.baseurl.missing"));
		let url: URL;
		try {
			url = new URL(base);
		} catch {
			throw new Error(
				pick(l, `baseUrl 无效：${base}`, `Invalid baseUrl: ${base}`, "models.fetch.baseurl.invalid", { base }),
			);
		}
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			throw new Error(
				pick(l, "baseUrl 仅支持 http/https", "baseUrl supports http/https only", "models.fetch.baseurl.protocol"),
			);
		}

		const headers: Record<string, string> = {
			...extraHeaders,
		};
		if (apiKey?.trim() && authHeader !== false) {
			const key = apiKey.trim();
			if (api === "anthropic-messages") {
				headers["x-api-key"] = key;
				headers["anthropic-version"] = "2023-06-01";
			} else if (api === "google-generative-ai") {
				headers["x-goog-api-key"] = key;
			} else {
				headers["Authorization"] = `Bearer ${key}`;
			}
		}

		const tryFetch = async (u: string): Promise<Response | null> => {
			const ac = new AbortController();
			const timer = setTimeout(() => ac.abort(), 15000);
			try {
				return await fetch(u, { headers, signal: ac.signal });
			} catch (err) {
				if ((err as Error).name === "AbortError") {
					throw new Error(pick(l, "请求超时（15 秒）", "Request timed out (15s)", "models.fetch.timeout"));
				}
				const errMessage = (err as Error).message;
				throw new Error(
					pick(l, `请求失败：${errMessage}`, `Request failed: ${errMessage}`, "models.fetch.request.error", {
						errMessage,
					}),
				);
			} finally {
				clearTimeout(timer);
			}
		};

		let res = await tryFetch(`${base}/models`);
		if (res && res.status === 404 && !/\/v\d+[a-z-]*$/.test(base)) {
			res = await tryFetch(`${base}/v1/models`);
		}
		if (!res) throw new Error(pick(l, "请求失败", "Request failed", "models.fetch.request.failed"));
		if (!res.ok) {
			let detail = "";
			try {
				detail = (await res.text()).slice(0, 200);
			} catch {}
			const detailSuffixZh = detail ? `：${detail}` : "";
			const detailSuffixEn = detail ? `: ${detail}` : "";
			throw new Error(
				pick(
					l,
					`接口返回 HTTP ${res.status}${detailSuffixZh}`,
					`Upstream returned HTTP ${res.status}${detailSuffixEn}`,
					"models.fetch.upstream.http",
					{ "res.status": res.status, detailSuffixZh, detailSuffixEn },
				),
			);
		}
		let models: UiModelConfigEntry[] = [];
		try {
			const json = (await res.json()) as Record<string, unknown>;
			const data = Array.isArray(json.data) ? json.data : null;
			if (data) {
				models = data.map((m) => parseOpenAiModel(m)).filter((m) => m.id);
			} else if (Array.isArray(json.models)) {
				models = (json.models as unknown[]).map((m) => parseGoogleModel(m)).filter((m) => m.id);
			}
		} catch {
			throw new Error(pick(l, "响应不是有效的 JSON", "Response is not valid JSON", "models.fetch.invalid.json"));
		}
		const seen = new Set<string>();
		models = models
			.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)))
			.sort((a, b) => a.id.localeCompare(b.id));
		if (models.length === 0)
			throw new Error(pick(l, "接口未返回任何模型", "The endpoint returned no models", "models.fetch.no.models"));
		return models;
	}

	async refreshProviderModels(providerId: string, reqId: number, lang?: () => ServerLang): Promise<void> {
		const done = (ok: boolean, extra: { added?: number; total?: number; error?: string } = {}) =>
			this.host.emit({ type: "refresh_provider_result", reqId, ok, ...extra });
		try {
			const pid = providerId.trim();
			const { providers } = this.readModelsConfig();
			const saved = providers[pid] as
				| {
						name?: string;
						api?: string;
						baseUrl?: string;
						apiKey?: string;
						authHeader?: boolean;
						headers?: Record<string, string>;
						models?: UiModelConfigEntry[];
				  }
				| undefined;
			const baseUrl =
				saved?.baseUrl?.trim() || (this.host.modelRuntime?.()?.getProvider(pid)?.baseUrl ?? "").trim() || undefined;
			if (!saved || !baseUrl) {
				this.host.emit({
					type: "notice",
					level: "warning",
					text: `服务商 ${pid} 不存在或未配置 baseUrl，无法刷新`,
					textEn: `Provider ${pid} does not exist or has no baseUrl; cannot refresh`,
				});
				return done(false, { error: "provider missing or no baseUrl" });
			}
			const fetched = await ModelAdminService.probeModelsEndpoint(
				baseUrl,
				saved.apiKey,
				saved.authHeader === true ? true : undefined,
				saved.api,
				saved.headers as Record<string, string> | undefined,
				lang,
			);

			const fresh = this.readModelsConfig().providers[pid] as NonNullable<typeof saved> | undefined;
			if (!fresh) {
				return done(false, { error: "provider deleted during refresh" });
			}
			const prev = new Map((fresh.models ?? []).map((m) => [m.id, m]));
			let added = 0;
			for (const f of fetched) {
				const cur = prev.get(f.id);
				if (!cur) {
					prev.set(f.id, f);
					added += 1;
					continue;
				}
				prev.set(f.id, {
					...f,
					...cur,
				});
			}
			const merged = [...prev.values()].sort((a, b) => a.id.localeCompare(b.id));
			await this.saveModelConfig(pid, {
				providerId: pid,
				name: fresh.name,
				api: fresh.api,
				baseUrl: fresh.baseUrl,
				authHeader: fresh.authHeader === true ? true : undefined,
				models: merged,
			});

			this.host.emit({
				type: "notice",
				level: "info",
				text:
					added > 0
						? `🔄 已刷新 ${pid}：新增 ${added} 个模型，共 ${merged.length} 个`
						: `🔄 已刷新 ${pid}：无新增模型（共 ${merged.length} 个）`,
				textEn:
					added > 0
						? `🔄 Refreshed ${pid}: ${added} new models, ${merged.length} total`
						: `🔄 Refreshed ${pid}: no new models (${merged.length} total)`,
			});
			return done(true, { added, total: merged.length });
		} catch (err) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: `刷新模型列表失败：${(err as Error).message}`,
				textEn: `Failed to refresh model list: ${(err as Error).message}`,
			});
			return done(false, { error: (err as Error).message });
		}
	}

	async refreshBuiltinModels(reqId: number): Promise<void> {
		const done = (ok: boolean, error?: string) =>
			this.host.emit({ type: "refresh_builtin_result", reqId, ok, ...(error ? { error } : {}) });
		try {
			const mr = this.host.modelRuntime?.();
			if (!mr) {
				await this.listProviders();
				await this.host.pushModels();
				return done(true);
			}
			const res = await mr.refresh({
				allowNetwork: true,
				force: true,
				signal: AbortSignal.timeout(90_000),
			});
			const graduated = this.graduateProvisionalOverlays();
			if (graduated.length > 0) {
				await mr.refresh();
			}
			this.host.invalidatePiConfig?.();
			await this.host.pushModels();
			await this.listProviders();
			const failures = [...res.errors.entries()].map(([pid, err]) => `${pid} (${err.message})`);
			if (failures.length > 0) {
				const detail = failures.join("; ");
				this.host.emit({
					type: "notice",
					level: "warning",
					text: `⚠️ 官方模型目录已强制刷新，但 ${failures.length} 个供应商拉取失败（沿用缓存）：${detail}`,
					textEn: `⚠️ Official model catalogs force-refreshed, but ${failures.length} provider(s) failed (cached catalog kept): ${detail}`,
				});
				return done(true, detail);
			}
			this.host.emit({
				type: "notice",
				level: "info",
				text: "🔄 已强制刷新官方模型目录（绕过 4 小时缓存），模型下拉已更新",
				textEn: "🔄 Official model catalogs force-refreshed (4h cache bypassed); the model picker is up to date",
			});
			if (graduated.length > 0) {
				const names = graduated.map((g) => `${g.providerId}/${g.modelId}`).join("、");
				this.host.emit({
					type: "notice",
					level: "info",
					text: `🎓 ${names} 官方已收录，手工条目已移除并转用官方配置`,
					textEn: `${names} graduated to the official catalog; provisional rows removed`,
				});
			}
			return done(true);
		} catch (err) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: `强制刷新官方模型目录失败：${(err as Error).message}`,
				textEn: `Failed to force-refresh official model catalogs: ${(err as Error).message}`,
			});
			return done(false, (err as Error).message);
		} finally {
			this.host.flushSnapshot();
		}
	}

	private graduateProvisionalOverlays(): OverlayGraduation[] {
		let official: Record<string, Record<string, string | undefined>> = {};
		try {
			const storePath = join(dirname(this.modelsConfigPath()), "models-store.json");
			const stored = JSON.parse(readFileSync(storePath, "utf8")) as Record<
				string,
				{ models?: { id?: unknown; api?: unknown }[] }
			>;
			for (const [pid, entry] of Object.entries(stored ?? {})) {
				if (!Array.isArray(entry?.models)) continue;
				const byId: Record<string, string | undefined> = {};
				for (const m of entry.models) {
					if (typeof m?.id !== "string" || !(m.id as string).trim()) continue;
					byId[(m.id as string).trim()] = typeof m.api === "string" ? (m.api as string) : undefined;
				}
				official[pid] = byId;
			}
		} catch {
			return [];
		}
		const { providers } = this.readModelsConfig();
		const graduated = graduateOverlayModels(providers, official);
		if (graduated.length === 0) return graduated;
		try {
			atomicWriteCredentialJson(this.modelsConfigPath(), { providers });
		} catch {
			return [];
		}
		return graduated;
	}

	private static toModelRow(m: UiModelConfigEntry): UiModelConfigEntry {
		const thinkingLevelMap = sanitizeThinkingLevelMap(m.thinkingLevelMap);
		let samplingParams = m.samplingParams;
		if (typeof m.customExtraBody === "string" && m.customExtraBody.trim()) {
			try {
				const parsed = JSON.parse(m.customExtraBody.trim());
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
					samplingParams = { ...(samplingParams ?? {}), ...parsed };
				}
			} catch {}
		}
		return {
			id: m.id.trim(),
			...(m.name?.trim() ? { name: m.name.trim() } : {}),
			...(m.reasoning ? { reasoning: true } : {}),
			...(thinkingLevelMap ? { thinkingLevelMap } : {}),
			...(m.compat && typeof m.compat === "object" ? { compat: m.compat } : {}),
			...(samplingParams && typeof samplingParams === "object" ? { samplingParams } : {}),
			...(m.customExtraBody?.trim() ? { customExtraBody: m.customExtraBody.trim() } : {}),
			...(m.input?.length ? { input: m.input } : {}),
			...(m.contextWindow ? { contextWindow: Number(m.contextWindow) } : {}),
			...(m.maxTokens ? { maxTokens: Number(m.maxTokens) } : {}),
			...(m.api?.trim() ? { api: m.api.trim() } : {}),
			...(m.baseUrl?.trim() ? { baseUrl: m.baseUrl.trim() } : {}),
		};
	}

	private static readonly MODEL_APIS = new Set([
		"openai-completions",
		"openai-responses",
		"anthropic-messages",
		"google-generative-ai",
	]);

	private async writeModelsConfigAndReload(
		providers: Record<string, Record<string, unknown>>,
		pid: string,
	): Promise<void> {
		mkdirSync(this.host.agentDir, { recursive: true });
		atomicWriteCredentialJson(this.modelsConfigPath(), { providers });

		try {
			const auth = JSON.parse(readFileSync(join(this.host.agentDir, "auth.json"), "utf8")) as Record<string, unknown>;
			const credential = auth[pid];
			if (
				credential &&
				typeof credential === "object" &&
				"key" in credential &&
				typeof credential.key === "string" &&
				credential.key.trim()
			) {
				await this.host.modelRuntime?.()?.setRuntimeApiKey(pid, credential.key);
			}
		} catch {}
		await this.host.modelRuntime?.()?.refresh();
		this.host.invalidatePiConfig?.();
		await this.listModelsConfig();
		await this.host.pushModels();
	}

	async appendBuiltinModel(providerId: string, model: UiModelConfigEntry, reqId: number): Promise<void> {
		const done = (ok: boolean, error?: string) =>
			this.host.emit({ type: "append_builtin_result", reqId, ok, ...(error ? { error } : {}) });
		const pid = providerId.trim();
		const mid = model?.id?.trim() ?? "";
		const fail = (text: string, textEn: string) => {
			this.host.emit({ type: "notice", level: "error", text, textEn });
			return done(false, text);
		};
		try {
			if (!pid) return fail("请填写服务商 ID", "Enter a provider ID");
			if (!mid) return fail("请填写模型 ID", "Enter a model ID");
			const api = model?.api?.trim() ? model.api.trim() : undefined;
			if (api && !ModelAdminService.MODEL_APIS.has(api)) {
				return fail(
					`接口类型无效：${api}（仅支持 ${[...ModelAdminService.MODEL_APIS].join(" / ")}，留空则自动继承）`,
					`Invalid api type: ${api} (supported: ${[...ModelAdminService.MODEL_APIS].join(" / ")}; leave blank to inherit)`,
				);
			}
			const baseUrl = model?.baseUrl?.trim() ? model.baseUrl.trim() : undefined;
			if (baseUrl) {
				let url: URL | undefined;
				try {
					url = new URL(baseUrl);
				} catch {
					url = undefined;
				}
				if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
					return fail(
						`接口地址无效：${baseUrl}（仅支持 http/https，留空则自动继承）`,
						`Invalid baseUrl: ${baseUrl} (http/https only; leave blank to inherit)`,
					);
				}
			}
			if (this.host.modelRuntime && !this.host.modelRuntime().getProvider(pid)) {
				return fail(`供应商 ${pid} 不存在`, `Provider ${pid} does not exist`);
			}
			const { providers } = this.readModelsConfig();
			const prev = providers[pid];
			const prevModels = Array.isArray(prev?.models) ? [...(prev.models as unknown[])] : [];
			if (
				prevModels.some(
					(m) => typeof (m as { id?: unknown })?.id === "string" && ((m as { id: string }).id as string).trim() === mid,
				)
			) {
				this.host.emit({
					type: "notice",
					level: "info",
					text: `${pid} 已有模型 ${mid}，无需重复添加`,
					textEn: `${pid} already has model ${mid}; nothing to add`,
				});
				return done(true);
			}
			const row = ModelAdminService.toModelRow({ ...model, id: mid });
			providers[pid] = { ...prev, models: [...prevModels, row] };
			await this.writeModelsConfigAndReload(providers, pid);
			this.host.emit({
				type: "notice",
				level: "info",
				text: `✅ 已给 ${pid} 添加模型 ${mid}，模型下拉已更新（该条目同时列在「自定义服务商」下，可编辑/删除）`,
				textEn: `✅ Added model ${mid} to ${pid}; the picker is updated (the entry is also listed under custom providers for edit/remove)`,
			});
			return done(true);
		} catch (err) {
			return fail(`添加模型失败：${(err as Error).message}`, `Failed to add model: ${(err as Error).message}`);
		} finally {
			this.host.flushSnapshot();
		}
	}

	async saveModelConfig(providerId: string, config: UiProviderConfig): Promise<void> {
		const pid = providerId.trim();
		if (!pid || !/^[\w.-]+$/.test(pid)) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: "服务商 ID 无效（仅字母/数字/._-）",
				textEn: "Invalid provider ID (letters/digits/._- only)",
			});
			return;
		}
		const models = (config.models ?? []).filter((m) => m.id && m.id.trim()).map((m) => ModelAdminService.toModelRow(m));
		if (models.length === 0) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: "至少需要一个模型",
				textEn: "At least one model is required",
			});
			return;
		}
		try {
			const { providers } = this.readModelsConfig();
			providers[pid] = mergeProviderConfigEntry(providers[pid], config, models);
			await this.writeModelsConfigAndReload(providers, pid);
			this.host.emit({
				type: "notice",
				level: "info",
				text: `✅ 已保存服务商 ${pid}（${models.length} 个模型）并刷新模型列表`,
				textEn: `✅ Saved provider ${pid} (${models.length} models) and refreshed the model list`,
			});
		} catch (err) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: `保存模型配置失败：${(err as Error).message}`,
				textEn: `Failed to save model config: ${(err as Error).message}`,
			});
		}
		this.host.flushSnapshot();
	}

	async deleteModelConfig(providerId: string): Promise<void> {
		try {
			const { providers } = this.readModelsConfig();
			if (!(providerId in providers)) {
				this.host.emit({
					type: "notice",
					level: "info",
					text: `服务商 ${providerId} 不存在`,
					textEn: `Provider ${providerId} does not exist`,
				});
				return;
			}
			delete providers[providerId];
			atomicWriteCredentialJson(this.modelsConfigPath(), { providers });
			await this.host.modelRuntime?.()?.refresh();
			this.host.invalidatePiConfig?.();
			await this.listModelsConfig();
			await this.host.pushModels();
			this.host.emit({
				type: "notice",
				level: "info",
				text: `🗑  已删除服务商 ${providerId}`,
				textEn: `🗑  Deleted provider ${providerId}`,
			});
		} catch (err) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: `删除模型配置失败：${(err as Error).message}`,
				textEn: `Failed to delete model config: ${(err as Error).message}`,
			});
		}
		this.host.flushSnapshot();
	}
}
