/**
 * model-admin — 模型/服务商配置管理，从 agent-service.ts 抽出。
 *
 * 职责：auth.json 的 provider api-key 存取（set/clear）、models.json 读写
 * （listModelsConfig/saveModelConfig/deleteModelConfig）、自定义服务商「自动获取
 * 模型列表」（fetch_models：服务端探测 OpenAI 兼容 /models 端点，绕开 CORS；
 * anthropic/google 鉴权头各不同；裸 /models 404 回退 /v1/models）与已保存供应商
 * 的一键刷新（refresh_provider_models，凭据不出浏览器）。改动后热更新 runtime
 * （refresh/setRuntimeApiKey）并推 models/models_config。
 *
 * 经 ModelAdminHost 与 ClientSession 解耦（同 settings/goal/slash 服务模式）。
 * UI 文案直接中文（服务端 notice 约定）。apiKey/headers 绝不下发浏览器。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeJsonAtomicSync } from "./atomic-file.js";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type {
	ServerMessage,
	UiModelConfigEntry,
	UiProviderConfig,
	ProviderKeyInfo,
	UiEnrichResult,
} from "./protocol.js";
import { enrichBatch, type EnrichLang } from "./model-enrich.js";
import { pick, type ServerLang } from "./i18n.js";
import { ProviderOAuthFlowManager } from "./provider-oauth-flow.js";

/** ClientSession 提供给本服务的宿主能力（窄接口）。 */
export interface ModelAdminHost {
	agentDir: string;
	emit: (msg: ServerMessage) => void;
	flushSnapshot: () => void;
	isDisposed: () => boolean;
	/** 共享 ModelRuntime（所有对话共用），改动后需 refresh/热更新。非 pi 引擎时可缺省。 */
	modelRuntime?: () => ModelRuntime;
	/** auth/models 变更后 pi 配置检测缓存失效（piConfigured 可能翻转）。 */
	invalidatePiConfig?: () => void;
	/** 变更后重推顶栏模型下拉。 */
	pushModels: () => Promise<void>;
	/** OAuth becomes authoritative, so project-scoped API-key choices must not restore over it. */
	onOAuthActivated?: (provider: string) => void;
}

/** One models.json overlay row graduated to the official catalog. */
export interface OverlayGraduation {
	providerId: string;
	modelId: string;
}

/** Drop provisional overlay rows once the official catalog lists the same id.
 *
 *  Background: a hand-appended row SHADOWS the official row at compose time
 *  (applyModelsJson rebuilds the entry from the definition, so official
 *  name/vision/contextWindow/etc. are lost and only api/baseUrl are
 *  inherited). While pi.dev doesn't list the id the shadow is the whole
 *  point; once it does, the shadow becomes stale metadata. `official` maps
 *  provider → model id → the official row's api (undefined when unknown).
 *  A row graduates when the official catalog lists its id AND the row
 *  carries no deliberate routing of its own: no baseUrl, and either no api
 *  or the same api the official row uses. A row with its own baseUrl or a
 *  differing api is a customization, not a provisional — it stays. When an
 *  entry's models become empty and it carries no other keys, the whole entry
 *  is removed so it also leaves the "custom providers" list; entries with
 *  other keys (baseUrl/apiKey/headers/…) are kept. Mutates `providers` in
 *  place and returns what was graduated. Pure + unit-tested. */
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

/** 原子写凭据 JSON 并修权限 0600（port from fork 50e723f，保留上游原子写语义）。
 *  chmod 覆盖已存在文件（mode 选项只对新建有效）。Windows 下尽力而为。 */
function atomicWriteCredentialJson(path: string, data: unknown): void {
	writeJsonAtomicSync(path, data);
	try {
		chmodSync(path, CREDENTIAL_FILE_MODE);
	} catch {
		/* best-effort (win) */
	}
}

/** Strip // and /* *\/ comments without touching string literals (URLs contain //). */
function stripJsonComments(src: string): string {
	let out = "";
	let inString = false;
	let i = 0;
	while (i < src.length) {
		const c = src[i];
		const next = src[i + 1];
		if (inString) {
			out += c;
			if (c === "\\") {
				out += next ?? "";
				i += 2;
				continue;
			}
			if (c === '"') inString = false;
			i++;
			continue;
		}
		if (c === '"') {
			inString = true;
			out += c;
			i++;
			continue;
		}
		if (c === "/" && next === "/") {
			while (i < src.length && src[i] !== "\n") i++;
			continue;
		}
		if (c === "/" && next === "*") {
			i += 2;
			while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
			i += 2;
			continue;
		}
		out += c;
		i++;
	}
	return out;
}

/** Merge a UI-submitted provider config into the existing models.json entry.
 *
 * 表单（`UiProviderConfig`）只承载 UI 认识的字段：provider 级 name/api/baseUrl/
 * hasApiKey/authHeader，模型级 id/name/reasoning/input/contextWindow/maxTokens。
 * models.json 里还可能有 UI 不认识的字段——provider 级 headers（浏览器拿不到，
 * 见 listModelsConfig）、模型级 api/baseUrl/cost/compat/thinkingLevelMap（手写或
 * 脚本写入，pi-ai 靠它们决定请求地址与推理格式）。按表单整体重建条目会把这些字段
 * 静默抹掉，可能把可用的配置改坏：模型级 baseUrl 丢失后会回退到对该 api 适配器
 * 无效的地址（例如 opencode-go 的 anthropic baseUrl），请求直接打到不存在的路径。
 *
 * 所以这里以已有条目为底、表单字段覆盖：表单没提到的字段原样保留，表单清空的可选
 * 字段才真正删除；`models` 仍是「表单即全集」——表单里删掉的 id 会被移除。
 *
 * apiKey 例外：浏览器不再持有明文（只见 hasApiKey），**缺字段 = 保留旧值**；显式
 * 空串才清除（协议级"空=清除"语义保留，但 Web 表单留空时整字段不传）。这样
 * refresh_provider_models 等不带 apiKey 的内部保存路径也绝不会把密钥抹掉。
 */
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
		// 旧条目同 id 的字段（api/baseUrl/cost/compat/…）先铺底，表单字段覆盖。
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
		// 表单没带 apiKey（留空/内部路径）→ 保留旧值，绝不清除。
	} else {
		apply("apiKey", config.apiKey.trim() || undefined);
	}
	apply("authHeader", config.authHeader ? true : undefined);
	mergedEntry.models = mergedModels;
	return mergedEntry;
}

/** Numeric metadata value (NaN/string "unknown" → undefined). */
function numMeta(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function boolMeta(v: unknown): boolean | undefined {
	return typeof v === "boolean" ? v : undefined;
}

function strArrMeta(v: unknown): string[] | undefined {
	return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
}

/**
 * 体系化启发式推断模型是否具备推理/深度思考能力：
 * 1. 显式端点元数据优先（reasoning / supports_reasoning / modalities 包含 reasoning）；
 * 2. 业界主流推理模型命名特征正则库：
 *    - thinking / reasoner / reasoning 显式词
 *    - OpenAI o1 / o3 / o4 系列（如 o1, o1-mini, o1-preview, o3-mini, o3-high, o4 等）
 *    - DeepSeek R1 / Reasoner 系列（如 deepseek-r1, r1-distill 等）
 *    - 阿里千问 QwQ 系列（如 qwq-32b, qwq-32b-preview）
 *    - 智谱 GLM-Zero 系列（如 glm-4-zero, glm-zero）
 *    - CoT (Chain of Thought) 显式标记
 */
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

/** Best-effort extraction of model metadata from an OpenAI-compatible
 *  /models `data[]` item. Most endpoints only return `{ id }` — the extra
 *  fields (context_window / max_model_len / modalities / supports_vision /
 *  reasoning / display_name) come from vLLM and other extended
 *  implementations, and are filled into the form when present. */
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
	// 名字与元数据兜底：端点未提供 reasoning 时通过通用推理模型特征推断。
	// 只增不减：取消勾选靠手填（编辑页/刷新合并都只补缺）。
	const reasoning = detectReasoningCapability(id, r);
	const contextWindow =
		numMeta(r.context_window) ?? numMeta(r.context_length) ?? numMeta(r.max_model_len) ?? numMeta(r.max_context_length);
	const maxTokens = numMeta(r.max_tokens) ?? numMeta(r.max_output_tokens) ?? numMeta(r.max_completion_tokens);
	return {
		id,
		...(name ? { name } : {}),
		...(reasoning ? { reasoning: true } : {}),
		...(vision ? { input: ["text", "image"] } : {}),
		...(contextWindow ? { contextWindow } : {}),
		...(maxTokens ? { maxTokens } : {}),
	};
}

/** google-generative-ai /models shape:
 *  { models: [{ name: "models/gemini-flash", displayName, inputTokenLimit,
 *               outputTokenLimit, supportedGenerationMethods }] } */
function parseGoogleModel(m: unknown): UiModelConfigEntry {
	const r = (m ?? {}) as Record<string, unknown>;
	const rawName = typeof r.name === "string" ? r.name : "";
	const id = rawName.replace(/^models\//, "");
	const displayName = typeof r.displayName === "string" ? r.displayName : undefined;
	// 与 OpenAI 形状同口径的推断兜底（见 detectReasoningCapability）。
	const reasoning = detectReasoningCapability(id, r);
	return {
		id,
		...(displayName && displayName !== id ? { name: displayName } : {}),
		...(reasoning ? { reasoning: true } : {}),
		...(numMeta(r.inputTokenLimit) ? { contextWindow: numMeta(r.inputTokenLimit) } : {}),
		...(numMeta(r.outputTokenLimit) ? { maxTokens: numMeta(r.outputTokenLimit) } : {}),
	};
}

/** Persisted shape of <agentDir>/provider-keys.json (one entry per provider). */
export interface ProviderKeysData {
	activeKeyName: string | null;
	keys: { name: string; apiKey: string }[];
}

/** Credential files hold raw provider API keys — always mode 0600.
 *  models.json can hold per-provider apiKey/headers, so it gets the same treatment. */
export const CREDENTIAL_FILE_MODE = 0o600;

/** Write a credential file (provider-keys.json / auth.json / models.json) with mode 0600.
 *  The `mode` option covers creation; the chmod covers pre-existing files
 *  (mode is ignored when the file already exists). Best-effort on Windows. */
export function writeCredentialFile(path: string, data: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, data, { mode: CREDENTIAL_FILE_MODE });
	try {
		chmodSync(path, CREDENTIAL_FILE_MODE);
	} catch {
		/* best-effort (win) */
	}
}

/** Startup repair: chmod existing credential files to 0600 (best-effort). */
export function ensureCredentialFilePermissions(agentDir: string): void {
	for (const name of ["provider-keys.json", "auth.json", "models.json"]) {
		try {
			chmodSync(join(agentDir, name), CREDENTIAL_FILE_MODE);
		} catch {
			/* missing / win — ignore */
		}
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

	// ---------------------------------------------------------------------------
	// Built-in provider multiple key store (one provider, several API keys).
	// Persisted as <agentDir>/provider-keys.json:
	//   { "<providerId>": { activeKeyName: string|null, keys: [{name,apiKey}] } }
	// The frontend only ever sees NAMES (no value, no masked fragment). The key
	// value travels to the server ONCE on add and is stored (like auth.json); the
	// server resolves + switches the active key by NAME.
	// ---------------------------------------------------------------------------

	private providerKeysPath(): string {
		return join(this.host.agentDir, "provider-keys.json");
	}

	/** Read + parse provider-keys.json. */
	private readProviderKeys(): Record<string, ProviderKeysData> {
		let raw: string;
		try {
			raw = readFileSync(this.providerKeysPath(), "utf8");
		} catch {
			return {}; // 文件不存在 = 首次引导
		}
		let parsed: Record<string, { activeKeyName?: string | null; keys?: { name: string; apiKey: string }[] }>;
		try {
			parsed = JSON.parse(raw) as Record<
				string,
				{ activeKeyName?: string | null; keys?: { name: string; apiKey: string }[] }
			>;
		} catch (err) {
			// 坏文件改名留存：里面可能有全部备用密钥，绝不能被后续种子/空表整份覆盖。
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
		// Keep the sibling credential file at 0600 too (e.g. adding an
		// inactive key rewrites provider-keys.json but not auth.json).
		try {
			chmodSync(join(this.host.agentDir, "auth.json"), CREDENTIAL_FILE_MODE);
		} catch {
			/* missing / win — ignore */
		}
	}

	/** 解析失败的配置文件改名留存为 <name>.corrupt-<timestamp>。改名失败（占用/
	 *  跨盘等）也不抛——留存是尽力而为，绝不能阻塞主流程。 */
	private quarantineCorruptFile(path: string, err: unknown): void {
		try {
			renameSync(path, `${path}.corrupt-${Date.now()}`);
			console.warn(`[model-admin] 配置文件解析失败，已改名留存：${path}（${(err as Error).message}）`);
		} catch {
			console.warn(`[model-admin] 配置文件解析失败且无法留存：${path}（${(err as Error).message}）`);
		}
	}

	/** Default name "密钥 N" for a provider's Nth key. */
	private defaultKeyName(keys: { name: string; apiKey: string }[]): string {
		return `密钥 ${keys.length + 1}`;
	}

	/** Resolve a user-supplied (or default) name into a UNIQUE one (append
	 *  " (2)", " (3)", … on collision) so a name is a reliable switch key. */
	private uniqueKeyName(entry: { keys: { name: string; apiKey: string }[] }, wanted: string | undefined): string {
		const base = (wanted?.trim() || this.defaultKeyName(entry.keys)).trim() || this.defaultKeyName(entry.keys);
		const taken = new Set(entry.keys.map((k) => k.name));
		let name = base;
		let n = 2;
		while (taken.has(name)) name = `${base} (${n++})`;
		return name;
	}

	/** Build the name-only ProviderKeyInfo list for a provider (no value/mask). */
	private providerKeysInfo(data: Record<string, ProviderKeysData>): { keys: Record<string, ProviderKeyInfo[]> } {
		const keys: Record<string, ProviderKeyInfo[]> = {};
		for (const [pid, entry] of Object.entries(data)) {
			keys[pid] = entry.keys.map((k) => ({ name: k.name, active: entry.activeKeyName === k.name }));
		}
		return { keys };
	}

	/** Get the currently active key name for a provider, or null. */
	getActiveKeyName(provider: string): string | null {
		const data = this.readProviderKeys();
		return data[provider]?.activeKeyName ?? null;
	}

	/** Whether a named key still exists for a provider (no side effects, no
	 *  notices). Restore paths use this to drop stale per-project references
	 *  silently instead of going through activate (which notifies). */
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

	/** Seed a provider's key list from an EXISTING auth.json credential (legacy
	 *  configs written before the multi-key store existed) so the store stays
	 *  authoritative and the UI shows the current active key immediately even
	 *  before the user adds a second key. Idempotent — does nothing if the
	 *  provider already has a store entry. */
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
		} catch {
			// no auth.json / unparsable — nothing to seed
		}
	}

	/** Push the masked provider-keys map to the client. Seeds the store from any
	 *  auth.json credentials so legacy single-key setups show up immediately.
	 *  只在文件不存在（首次引导）时才落盘种子；文件存在（含空表）绝不整份写回
	 *  ——写回的来源永远是读盘结果，避免任何竞态把用户密钥覆盖掉。 */
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

	/** Candidate built-in provider ids whose keys we track: those with a store
	 *  entry plus every provider actually registered in the runtime (seed reads
	 *  auth.json per id, so only real providers with a credential get seeded —
	 *  unrelated auth.json entries like "main" are ignored). */
	private builtinProviderIds(): string[] {
		const data = this.readProviderKeys();
		const ids = new Set(Object.keys(data));
		try {
			const mr = this.host.modelRuntime?.();
			if (mr) {
				for (const p of mr.getProviders()) ids.add(p.id);
			}
		} catch {
			// runtime not ready
		}
		for (const id of ["anthropic", "openai", "google", "deepseek", "groq", "mistral", "openrouter", "ollama"]) {
			ids.add(id);
		}
		return [...ids];
	}

	/** Persist the ACTIVE key's apiKey into auth.json + runtime override + refresh. */
	private async applyActiveKey(pid: string, apiKey: string): Promise<void> {
		const authPath = join(this.host.agentDir, "auth.json");
		let data: Record<string, unknown> = {};
		try {
			data = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
		} catch {
			// no file yet / unparsable — start fresh
		}
		data[pid] = { type: "api_key", key: apiKey };
		atomicWriteCredentialJson(authPath, data);
		try {
			chmodSync(this.providerKeysPath(), CREDENTIAL_FILE_MODE);
		} catch {
			/* missing / win — ignore */
		}
		const mr = this.host.modelRuntime?.();
		if (mr) {
			await mr.setRuntimeApiKey(pid, apiKey);
			await mr.refresh({ allowNetwork: true, providers: [pid] });
		}
		this.host.invalidatePiConfig?.();
	}

	/** Persist an api-key credential for a provider (auth.json) and apply it now.
	 *  Also records the key in provider-keys.json (as the active key), so it shows
	 *  in the multi-key list too. */
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
			// Preserve a legacy auth.json key as the first (active) entry so adding
			// a new key stacks alongside it instead of clobbering it.
			if (!data[pid]) this.seedProviderKeysFromAuth(pid, data);
			let entry = data[pid];
			if (!entry) entry = data[pid] = { activeKeyName: null, keys: [] };
			const existing = entry.keys.find((k) => k.apiKey === key);
			let name: string;
			if (existing) {
				// Same key value already in the list → just make it active.
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

	/** Add a SECONDARY API key to a built-in provider's key list. `name` is the
	 *  only thing the frontend ever sees (auto-generated when blank, deduped on
	 *  collision). The added key stays INACTIVE unless it is the provider's first
	 *  key; the user switches to it by name or by clicking a model under it. */
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
			// Preserve a legacy auth.json key (active) so the new key stacks as a
			// SECONDARY inactive key rather than replacing the current one.
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
			// First key becomes active (provider had none usable yet).
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

	/** Make a stored API key the ACTIVE one for a built-in provider by NAME (the
	 *  server resolves the stored value from the name). Returns true when the
	 *  key is (now) active, false when it doesn't exist or the switch failed.
	 *  `silent` suppresses all notices — for automatic project restores, which
	 *  must self-heal stale references without spamming the user. */
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

	/** Remove a stored API key by NAME. If it was active, the first remaining key
	 *  becomes active (or the provider returns to unconfigured when no key is left). */
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
				// Drop auth.json entry + runtime override so the provider returns
				// to unconfigured (its stored keys are gone too).
				const authPath = join(this.host.agentDir, "auth.json");
				let auth: Record<string, unknown> = {};
				try {
					auth = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
				} catch {
					// no file yet — nothing to clean
				}
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

	/**
	 * Clear a built-in provider's stored API key (auth.json entry + runtime
	 * override) so it returns to the unconfigured state — its models disappear
	 * from the picker until a key is set again. Only meaningful for keys that
	 * were stored via set_provider_api_key (source "stored"); env-var sourced
	 * credentials can't be cleared from here.
	 */
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
			// Remove from auth.json ({ <provider>: { type: "api_key", key } }).
			const authPath = join(this.host.agentDir, "auth.json");
			let data: Record<string, unknown> = {};
			try {
				data = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
			} catch {
				// no file yet / unparsable — nothing stored to clear
			}
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
			// Clear every stored key so the provider returns to unconfigured.
			delete keyData[pid];
			this.writeProviderKeys(keyData);
			// Drop the runtime override too, then re-read credentials so the
			// provider goes back to unconfigured and its models leave the list.
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

	/**
	 * Copy a BUILT-IN provider (baseUrl + current model catalog) into an
	 * editable custom-provider draft and return it via clone_provider_result.
	 * Nothing is persisted — the user renames the draft, pastes a DIFFERENT
	 * API key in the form, then saves via save_model_config. Credentials are
	 * never copied: the whole point is running a second key alongside the
	 * built-in one without touching it.
	 */
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
			// Map runtime models → models.json rows; dynamic providers ship an
			// empty catalog until refreshed over the network.
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
			// 供应商级 api 取占比最高，模型保留全量去重（避免 muse-spark 被过滤）
			// 多 key 场景：复制一次即得到 opencode1/opencode2 两组，界面按供应商分组，选模型即切 key
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

	/**
	 * Enrich custom-provider DRAFT rows with public catalog params
	 * (OpenRouter primary, models.dev secondary) — enrich_models_result.
	 * Nothing is saved here; the UI fills blanks from the result.
	 */
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

	/** Enumerate pi's built-in providers with auth capabilities and status. */
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
						// One odd provider must not blank the whole list.
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
			// 非 pi 引擎：根据 models.json + auth.json + provider-keys.json + 常见官方列表综合列出
			let auth: Record<string, unknown> = {};
			try {
				auth = JSON.parse(readFileSync(join(this.host.agentDir, "auth.json"), "utf8")) as Record<string, unknown>;
			} catch {
				/* ignore */
			}
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
					(b.id === "google" && (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)),
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

	// ---------------------------------------------------------------------------
	// Custom model config (agentDir/models.json)
	// ---------------------------------------------------------------------------

	private modelsConfigPath(): string {
		return join(this.host.agentDir, "models.json");
	}

	/** Strip // and /* *\/ comments without touching string literals (URLs contain //). */
	private static stripJsonComments(src: string): string {
		let out = "";
		let inString = false;
		let i = 0;
		while (i < src.length) {
			const c = src[i];
			const next = src[i + 1];
			if (inString) {
				out += c;
				if (c === "\\") {
					out += next ?? "";
					i += 2;
					continue;
				}
				if (c === '"') inString = false;
				i++;
				continue;
			}
			if (c === '"') {
				inString = true;
				out += c;
				i++;
				continue;
			}
			if (c === "/" && next === "/") {
				while (i < src.length && src[i] !== "\n") i++;
				continue;
			}
			if (c === "/" && next === "*") {
				i += 2;
				while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
				i += 2;
				continue;
			}
			out += c;
			i++;
		}
		return out;
	}

	/** Read + parse models.json (tolerating // and /* *\/ comments like the SDK). */
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

	/** Send the current models.json custom providers to the client. */
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
					}))
				: [];
			return {
				providerId,
				name: p.name as string | undefined,
				api: p.api as string | undefined,
				baseUrl: p.baseUrl as string | undefined,
				// apiKey 明文绝不下发浏览器，只报有无；表单留空 = 保持不变。
				hasApiKey: typeof p.apiKey === "string" && p.apiKey.trim() !== "",
				authHeader: p.authHeader as boolean | undefined,
				// headers are intentionally NOT sent to the browser — they may
				// contain Authorization / API-key values; kept server-side only.
				models,
			};
		});
		this.host.emit({ type: "models_config", providers: list });
	}

	/** Re-read models.json from disk (hand/script edits outside the UI) and
	 *  repush — same refresh tail that save_model_config runs. */
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

	/** Numeric metadata value (NaN/string "unknown" → undefined). */
	private static numMeta(v: unknown): number | undefined {
		return typeof v === "number" && Number.isFinite(v) ? v : undefined;
	}

	private static boolMeta(v: unknown): boolean | undefined {
		return typeof v === "boolean" ? v : undefined;
	}

	private static strArrMeta(v: unknown): string[] | undefined {
		return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
	}

	/** Best-effort extraction of model metadata from an OpenAI-compatible
	 *  /models `data[]` item. Most endpoints only return `{ id }` — the extra
	 *  fields (context_window / max_model_len / modalities / supports_vision /
	 *  reasoning / display_name) come from vLLM and other extended
	 *  implementations, and are filled into the form when present. */
	private static parseOpenAiModel(m: unknown): UiModelConfigEntry {
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
		// 名字与元数据兜底：端点未提供 reasoning 时通过通用推理模型特征推断。
		const reasoning = detectReasoningCapability(id, r);
		const contextWindow =
			numMeta(r.context_window) ??
			numMeta(r.context_length) ??
			numMeta(r.max_model_len) ??
			numMeta(r.max_context_length);
		const maxTokens = numMeta(r.max_tokens) ?? numMeta(r.max_output_tokens) ?? numMeta(r.max_completion_tokens);
		return {
			id,
			...(name ? { name } : {}),
			...(reasoning ? { reasoning: true } : {}),
			...(vision ? { input: ["text", "image"] } : {}),
			...(contextWindow ? { contextWindow } : {}),
			...(maxTokens ? { maxTokens } : {}),
		};
	}

	/** google-generative-ai /models shape:
	 *  { models: [{ name: "models/gemini-flash", displayName, inputTokenLimit,
	 *               outputTokenLimit, supportedGenerationMethods }] } */
	private static parseGoogleModel(m: unknown): UiModelConfigEntry {
		const r = (m ?? {}) as Record<string, unknown>;
		const rawName = typeof r.name === "string" ? r.name : "";
		const id = rawName.replace(/^models\//, "");
		const displayName = typeof r.displayName === "string" ? r.displayName : undefined;
		// 与 OpenAI 形状同口径的推断兜底（见 detectReasoningCapability）。
		const reasoning = detectReasoningCapability(id, r);
		return {
			id,
			...(displayName && displayName !== id ? { name: displayName } : {}),
			...(reasoning ? { reasoning: true } : {}),
			...(numMeta(r.inputTokenLimit) ? { contextWindow: numMeta(r.inputTokenLimit) } : {}),
			...(numMeta(r.outputTokenLimit) ? { maxTokens: numMeta(r.outputTokenLimit) } : {}),
		};
	}

	/** Probe a custom provider's OpenAI-compatible /models endpoint (server-side
	 *  because the baseUrl is often a LAN/loopback host the browser can't reach
	 *  cross-origin) and return the advertised models. reqId is echoed back
	 *  in fetch_models_result so the UI can match concurrent requests. */
	/** 编辑表单的探测（fetch_models / test_model_connection）没带明文 apiKey 时，
	 *  按 providerId 回落到 models.json 里已保存的密钥——编辑存量服务商时表单
	 *  一律留空（明文不再回传浏览器），没有这个回落「测试连接」就会 401。 */
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
		/** 探测抛错文案语言（默认英文）；调用方可传 () => getLang() 实现跟随。 */
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

	/**
	 * Lightweight connectivity and auth probe for a provider endpoint.
	 * Measures latency in ms and returns ok/error.
	 */
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

	/**
	 * Probe a custom provider's model-list endpoint (OpenAI-compatible /models
	 * with a /v1 retry; Google {models:[…]} shape supported). Throws Error with
	 * a user-facing message on any failure; returns deduped+sorted entries.
	 * Shared by the edit-form "auto fetch" and the saved-provider refresh.
	 */
	static async probeModelsEndpoint(
		baseUrl: string,
		apiKey?: string,
		authHeader?: boolean,
		api?: string,
		extraHeaders?: Record<string, string>,
		/** 抛错文案语言（默认英文）；调用方可传 () => getLang() 实现跟随。 */
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
		// Per-api auth conventions (mirror pi's built-in provider configs):
		//   openai-*:      Authorization: Bearer <key>
		//   anthropic:     x-api-key + anthropic-version
		//   google:        x-goog-api-key
		// authHeader=false → no auth header at all (custom gateways).
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
		// BaseUrls that omit the /v1 prefix (e.g. https://api.openai.com) 404 on
		// the bare path — retry under /v1.
		if (res && res.status === 404 && !/\/v\d+[a-z-]*$/.test(base)) {
			res = await tryFetch(`${base}/v1/models`);
		}
		if (!res) throw new Error(pick(l, "请求失败", "Request failed", "models.fetch.request.failed"));
		if (!res.ok) {
			let detail = "";
			try {
				detail = (await res.text()).slice(0, 200);
			} catch {
				// response body already consumed / not text — ignore
			}
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
				// OpenAI-compatible: { data: [{ id, context_window, modalities, … }] }
				models = data.map((m) => parseOpenAiModel(m)).filter((m) => m.id);
			} else if (Array.isArray(json.models)) {
				// Google: { models: [{ name: "models/…", displayName, … }] }
				models = (json.models as unknown[]).map((m) => parseGoogleModel(m)).filter((m) => m.id);
			}
		} catch {
			throw new Error(pick(l, "响应不是有效的 JSON", "Response is not valid JSON", "models.fetch.invalid.json"));
		}
		// Dedupe by id (keep the first, most complete entry) and sort by id.
		const seen = new Set<string>();
		models = models
			.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)))
			.sort((a, b) => a.id.localeCompare(b.id));
		if (models.length === 0)
			throw new Error(pick(l, "接口未返回任何模型", "The endpoint returned no models", "models.fetch.no.models"));
		return models;
	}

	/**
	 * Re-probe a SAVED custom provider's model list and merge it into its
	 * models.json entry — credentials never leave the server (unlike the
	 * edit-form fetch, which sends whatever the browser typed). Merge rules:
	 * existing ids keep all manually-entered fields and only gain metadata
	 * they were missing; brand-new ids are appended. Hot-reloads the runtime.
	 */
	async refreshProviderModels(providerId: string, reqId: number, lang?: () => ServerLang): Promise<void> {
		const done = (ok: boolean, extra: { added?: number; total?: number; error?: string } = {}) =>
			this.host.emit({ type: "refresh_provider_result", reqId, ok, ...extra });
		try {
			const pid = providerId.trim();
			const { providers } = this.readModelsConfig();
			// models.json 原始形状是 Record<string, unknown>——按已保存条目的结构断言
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
			// 纯覆盖条目（只改 models，没有 provider 级 baseUrl）回退到运行时
			// 已知的地址——内置 provider 的 baseUrl 本来就不在 models.json 里。
			// 注意只拿来探测用，不写回磁盘：保持条目仍是纯覆盖。
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

			// Merge: manual values win; fetched fills blanks and appends new ids.
			// #486：probe 是数秒级网络 await，期间用户可能已在设置面板编辑同一服务商——
			// 以盘上最新条目为合并基准（旧快照 saved 只提供探测参数），否则刷新会用
			// 旧快照整表覆盖，静默回滚并发编辑（删除的模型复活、手动新增丢失）。
			const fresh = this.readModelsConfig().providers[pid] as NonNullable<typeof saved> | undefined;
			if (!fresh) {
				// probe 期间服务商被删除：不再写回，避免用旧快照复活已删除的条目。
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
					...cur, // 手填字段优先：cur 覆盖 f 的同名字段
				});
			}
			const merged = [...prev.values()].sort((a, b) => a.id.localeCompare(b.id));
			await this.saveModelConfig(pid, {
				providerId: pid,
				name: fresh.name,
				api: fresh.api,
				baseUrl: fresh.baseUrl,
				// apiKey/headers 不回传浏览器——saveModelConfig 会保留旧值
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

	/** Force-refresh BUILT-IN providers' official pi.dev catalogs, bypassing
	 *  the SDK's 4h freshness window (`force: true`). Without force, refresh
	 *  inside the window is a silent no-op against models-store.json — which
	 *  is why a newly-published cheap model can sit on pi.dev for hours while
	 *  the picker still shows the old list. Afterwards the picker + provider
	 *  status are repushed. Per-provider fetch failures don't fail the whole
	 *  run (those providers keep their cached catalog) but are surfaced in
	 *  the result + a warning notice. */
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
			// Provisional overlay rows (append_builtin_model) shadow the official
			// row once pi.dev lists the id — graduate them so official
			// name/vision/limits take over. Only rows without their own
			// api/baseUrl are provisional; deliberate customizations stay.
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

	/** Graduate provisional overlay rows against the freshly force-refreshed
	 *  official catalog (models-store.json next to models.json). Persists the
	 *  pruned models.json only when something actually graduated; a missing
	 *  or unparsable store is a silent no-op (never fail the refresh). */
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

	/** Normalize one UI-submitted model row into models.json shape (same rules
	 *  as save_model_config: blank optionals dropped, numbers coerced).
	 *  Per-model api/baseUrl overrides pass through (validated by callers —
	 *  toModelRow itself only trims); absent values keep being inherited
	 *  from sibling models at compose time. */
	private static toModelRow(m: UiModelConfigEntry): UiModelConfigEntry {
		return {
			id: m.id.trim(),
			...(m.name?.trim() ? { name: m.name.trim() } : {}),
			...(m.reasoning ? { reasoning: true } : {}),
			...(m.input?.length ? { input: m.input } : {}),
			...(m.contextWindow ? { contextWindow: Number(m.contextWindow) } : {}),
			...(m.maxTokens ? { maxTokens: Number(m.maxTokens) } : {}),
			...(m.api?.trim() ? { api: m.api.trim() } : {}),
			...(m.baseUrl?.trim() ? { baseUrl: m.baseUrl.trim() } : {}),
		};
	}

	/** Known per-model api types (same list as the custom-provider form). */
	private static readonly MODEL_APIS = new Set([
		"openai-completions",
		"openai-responses",
		"anthropic-messages",
		"google-generative-ai",
	]);

	/** Write models.json and hot-reload the model runtime (shared tail of
	 *  save_model_config / append_builtin_model). Reuses the provider
	 *  credential already in auth.json for the runtime, then repushes the
	 *  config list + the picker. Callers emit their own notice. */
	private async writeModelsConfigAndReload(
		providers: Record<string, Record<string, unknown>>,
		pid: string,
	): Promise<void> {
		mkdirSync(this.host.agentDir, { recursive: true });
		atomicWriteCredentialJson(this.modelsConfigPath(), { providers });

		// Allow a models.json entry to reuse the provider credential already
		// stored in auth.json. Seed the shared runtime too, because older pi-ai
		// versions did not always fall back to stored credentials for a
		// newly-created custom provider. Never copy the secret into models.json.
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
		} catch {
			// auth.json is optional; models.json can still use its own apiKey.
		}
		await this.host.modelRuntime?.()?.refresh();
		this.host.invalidatePiConfig?.();
		await this.listModelsConfig();
		await this.host.pushModels();
	}

	/** Append ONE model to a BUILT-IN provider's models.json overlay entry
	 *  (append_builtin_result). Pure overlay: when the provider has no entry
	 *  yet, a `{ models: [row] }` entry is created — no baseUrl/api — so
	 *  api/baseUrl keep being inherited from the provider's own models at
	 *  compose time and later official catalog refreshes never drop the row.
	 *  Existing entry fields are left byte-for-byte alone (append-only, even
	 *  safer than save_model_config's merge). Duplicate id is an idempotent
	 *  no-op (info notice, ok:true). The row shows up under "custom
	 *  providers" (same id) for edit/remove. */
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
			// 手填行只带用户给的字段（通常只有 id，也许有名），api/baseUrl
			// 由 compose 时从同供应商现有模型继承——这正是纯 overlay 能工作的原因。
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

	/** Upsert one provider into models.json and hot-reload the model runtime. */
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
			// 合并而不是重建：UI 认识之外的字段（provider 级 headers、模型级 api/
			// baseUrl/cost/compat/thinkingLevelMap）必须原样保留，见 mergeProviderConfigEntry。
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

	/** Remove a provider from models.json and hot-reload. */
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
