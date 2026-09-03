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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ServerMessage, UiModelConfigEntry, UiProviderConfig, ProviderKeyInfo } from "./protocol.js";

/** ClientSession 提供给本服务的宿主能力（窄接口）。 */
export interface ModelAdminHost {
	agentDir: string;
	emit: (msg: ServerMessage) => void;
	flushSnapshot: () => void;
	isDisposed: () => boolean;
	/** 共享 ModelRuntime（所有对话共用），改动后需 refresh/热更新。 */
	modelRuntime: () => ModelRuntime;
	/** auth/models 变更后 pi 配置检测缓存失效（piConfigured 可能翻转）。 */
	invalidatePiConfig: () => void;
	/** 变更后重推顶栏模型下拉。 */
	pushModels: () => Promise<void>;
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

/** Numeric metadata value (NaN/string "unknown" → undefined). */
function numMeta(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function boolMeta(v: unknown): boolean | undefined {
	return typeof v === "boolean" ? v : undefined;
}

function strArrMeta(v: unknown): string[] | undefined {
	return Array.isArray(v)
		? v.filter((x): x is string => typeof x === "string")
		: undefined;
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
		(typeof r.display_name === "string" && r.display_name.trim()
			? r.display_name
			: undefined);
	const modalities =
		strArrMeta(r.modalities) ??
		strArrMeta(r.input_modalities);
	const vision =
		modalities?.includes("image") === true ||
		boolMeta(r.supports_vision) === true ||
		boolMeta(r.vision) === true ||
		strArrMeta(r.input)?.includes("image") === true;
	const reasoning =
		boolMeta(r.reasoning) === true ||
		boolMeta(r.supports_reasoning) === true ||
		modalities?.includes("reasoning") === true;
	const contextWindow =
		numMeta(r.context_window) ??
		numMeta(r.context_length) ??
		numMeta(r.max_model_len) ??
		numMeta(r.max_context_length);
	const maxTokens =
		numMeta(r.max_tokens) ??
		numMeta(r.max_output_tokens) ??
		numMeta(r.max_completion_tokens);
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
	return {
		id,
		...(displayName && displayName !== id ? { name: displayName } : {}),
		...(numMeta(r.inputTokenLimit)
			? { contextWindow: numMeta(r.inputTokenLimit) }
			: {}),
		...(numMeta(r.outputTokenLimit)
			? { maxTokens: numMeta(r.outputTokenLimit) }
			: {}),
	};
}

/** Persisted shape of <agentDir>/provider-keys.json (one entry per provider). */
export interface ProviderKeysData {
	activeKeyName: string | null;
	keys: { name: string; apiKey: string }[];
}

export class ModelAdminService {
	constructor(private readonly host: ModelAdminHost) {}

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
		try {
			const parsed = JSON.parse(readFileSync(this.providerKeysPath(), "utf8")) as Record<
				string,
				{ activeKeyName?: string | null; keys?: { name: string; apiKey: string }[] }
			>;
			const out: Record<string, ProviderKeysData> = {};
			for (const [pid, entry] of Object.entries(parsed)) {
				const keys = Array.isArray(entry?.keys)
					? entry.keys.filter((k) => k?.name && k?.apiKey)
					: [];
				if (!pid || keys.length === 0) continue;
				const activeKeyName =
					entry.activeKeyName && keys.some((k) => k.name === entry.activeKeyName)
						? entry.activeKeyName
						: keys[0].name;
				out[pid] = { activeKeyName, keys };
			}
			return out;
		} catch {
			return {};
		}
	}

	private writeProviderKeys(data: Record<string, ProviderKeysData>): void {
		mkdirSync(this.host.agentDir, { recursive: true });
		writeFileSync(this.providerKeysPath(), JSON.stringify(data, null, 2) + "\n");
	}

	/** Default name "密钥 N" for a provider's Nth key. */
	private defaultKeyName(keys: { name: string; apiKey: string }[]): string {
		return `密钥 ${keys.length + 1}`;
	}

	/** Resolve a user-supplied (or default) name into a UNIQUE one (append
	 *  " (2)", " (3)", … on collision) so a name is a reliable switch key. */
	private uniqueKeyName(
		entry: { keys: { name: string; apiKey: string }[] },
		wanted: string | undefined,
	): string {
		const base = (wanted?.trim() || this.defaultKeyName(entry.keys)).trim() || this.defaultKeyName(entry.keys);
		const taken = new Set(entry.keys.map((k) => k.name));
		let name = base;
		let n = 2;
		while (taken.has(name)) name = `${base} (${n++})`;
		return name;
	}

	/** Build the name-only ProviderKeyInfo list for a provider (no value/mask). */
	private providerKeysInfo(
		data: Record<string, ProviderKeysData>,
	): { keys: Record<string, ProviderKeyInfo[]> } {
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
	 *  auth.json credentials so legacy single-key setups show up immediately. */
	listProviderKeys(): void {
		const data = this.readProviderKeys();
		for (const pid of this.builtinProviderIds()) this.seedProviderKeysFromAuth(pid, data);
		this.writeProviderKeys(data);
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
			for (const p of this.host.modelRuntime().getProviders()) ids.add(p.id);
		} catch {
			// runtime not ready
		}
		return [...ids];
	}

	/** Persist the ACTIVE key's apiKey into auth.json + runtime override + refresh. */
	private async applyActiveKey(pid: string, apiKey: string): Promise<void> {
		const authPath = join(this.host.agentDir, "auth.json");
		mkdirSync(this.host.agentDir, { recursive: true });
		let data: Record<string, unknown> = {};
		try {
			data = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
		} catch {
			// no file yet / unparsable — start fresh
		}
		data[pid] = { type: "api_key", key: apiKey };
		writeFileSync(authPath, JSON.stringify(data, null, 2) + "\n");
		const mr = this.host.modelRuntime();
		await mr.setRuntimeApiKey(pid, apiKey);
		await mr.refresh({ allowNetwork: true, providers: [pid] });
		this.host.invalidatePiConfig();
	}

	/** Persist an api-key credential for a provider (auth.json) and apply it now.
	 *  Also records the key in provider-keys.json (as the active key), so it shows
	 *  in the multi-key list too. */
	async setProviderApiKey(provider: string, apiKey: string): Promise<void> {
		const pid = provider.trim();
		const key = apiKey.trim();
		if (!pid) {
			this.host.emit({ type: "notice", level: "error", text: "请填写服务商 ID",
			textEn: "Enter a provider ID"
			});
			return;
		}
		if (!key) {
			this.host.emit({ type: "notice", level: "error", text: "请填写 API 密钥",
			textEn: "Enter an API key"
			});
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
			this.host.emit({ type: "notice", level: "error", text: "请填写服务商 ID",
			textEn: "Enter a provider ID"
			});
			return;
		}
		if (!key) {
			this.host.emit({ type: "notice", level: "error", text: "请填写 API 密钥",
			textEn: "Enter an API key"
			});
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
	 *  server resolves the stored value from the name). */
	async activateProviderKey(provider: string, keyName: string): Promise<void> {
		const pid = provider.trim();
		const targetName = keyName.trim();
		try {
			const data = this.readProviderKeys();
			const entry = data[pid];
			const target = entry?.keys.find((k) => k.name === targetName);
			if (!target) {
				this.host.emit({ type: "notice", level: "error", text: `${pid} 的密钥「${targetName}」不存在`,
				textEn: `Key "${targetName}" for ${pid} does not exist`
				});
				return;
			}
			if (entry.activeKeyName === targetName) {
				this.host.emit({ type: "notice", level: "info", text: `「${targetName}」已是当前密钥`,
				textEn: `"${targetName}" is already the active key`
				});
				return;
			}
			entry.activeKeyName = targetName;
			this.writeProviderKeys(data);
			await this.applyActiveKey(pid, target.apiKey);
			this.host.emit({
				type: "notice",
				level: "info",
				text: `⚡ 已切换到 ${pid} 的「${targetName}」`,
				textEn: `⚡ Switched to "${targetName}" for ${pid}`,
			});
			await this.host.pushModels();
			await this.listProviders();
			this.listProviderKeys();
		} catch (err) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: `切换密钥失败：${(err as Error).message}`,
				textEn: `Failed to switch key: ${(err as Error).message}`,
			});
		}
		this.host.flushSnapshot();
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
				this.host.emit({ type: "notice", level: "error", text: `${pid} 的密钥「${targetName}」不存在`,
				textEn: `Key "${targetName}" for ${pid} does not exist`
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
				writeFileSync(authPath, JSON.stringify(auth, null, 2) + "\n");
				const mr = this.host.modelRuntime();
				await mr.removeRuntimeApiKey(pid);
				await mr.refresh({ providers: [pid] });
				this.host.invalidatePiConfig();
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
						: `🗑  Removed key "${targetName}" for ${pid}`
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
			this.host.emit({ type: "notice", level: "error", text: "请填写服务商 ID",
			textEn: "Enter a provider ID"
			});
			return;
		}
		try {
			// Remove from auth.json ({ <provider>: { type: "api_key", key } }).
			const authPath = join(this.host.agentDir, "auth.json");
			let data: Record<string, unknown> = {};
			try {
				data = JSON.parse(readFileSync(authPath, "utf8")) as Record<
					string,
					unknown
				>;
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
			writeFileSync(authPath, JSON.stringify(data, null, 2) + "\n");
			// Clear every stored key so the provider returns to unconfigured.
			delete keyData[pid];
			this.writeProviderKeys(keyData);
			// Drop the runtime override too, then re-read credentials so the
			// provider goes back to unconfigured and its models leave the list.
			const mr = this.host.modelRuntime();
			await mr.removeRuntimeApiKey(pid);
			await mr.refresh({ providers: [pid] });
			this.host.invalidatePiConfig();
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
		const fail = (error: string) => {
			this.host.emit({ type: "notice", level: "error", text: error });
			this.host.emit({ type: "clone_provider_result", reqId, ok: false, error });
		};
		try {
			if (!pid) {
				fail("请填写服务商 ID");
				return;
			}
			const mr = this.host.modelRuntime();
			const p = mr.getProvider(pid);
			if (!p) {
				fail(`供应商 ${pid} 不存在`);
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
							...(m.input?.includes("image")
								? { input: ["text", "image"] }
								: {}),
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
				fail(`${pid} 的模型列表为空，无法复制（请稍后重试）`);
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
			const taken = new Set([
				...Object.keys(this.readModelsConfig().providers),
				...mr.getRegisteredProviderIds(),
			]);
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
			});
			this.host.emit({ type: "clone_provider_result", reqId, ok: true, config, configs: [config] });
		} catch (err) {
			fail(`复制服务商失败：${(err as Error).message}`);
		}
		this.host.flushSnapshot();
	}

	/** Enumerate pi's built-in providers with auth status (key-only config). */
	async listProviders(): Promise<void> {
		const mr = this.host.modelRuntime();
		let providers;
		try {
			providers = mr.getProviders().map((p) => {
				try {
					const st = mr.getProviderAuthStatus(p.id);
					return {
						id: p.id,
						name: p.name,
						configured: st?.configured ?? false,
						source: st?.source,
					};
				} catch {
					// One odd provider must not blank the whole list.
					return { id: p.id, name: p.name, configured: false };
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
		const list: UiProviderConfig[] = Object.entries(providers).map(
			([providerId, p]) => {
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
					apiKey: p.apiKey as string | undefined,
					authHeader: p.authHeader as boolean | undefined,
					// headers are intentionally NOT sent to the browser — they may
					// contain Authorization / API-key values; kept server-side only.
					models,
				};
			},
		);
		this.host.emit({ type: "models_config", providers: list });
	}

	/** Numeric metadata value (NaN/string "unknown" → undefined). */
	private static numMeta(v: unknown): number | undefined {
		return typeof v === "number" && Number.isFinite(v) ? v : undefined;
	}

	private static boolMeta(v: unknown): boolean | undefined {
		return typeof v === "boolean" ? v : undefined;
	}

	private static strArrMeta(v: unknown): string[] | undefined {
		return Array.isArray(v)
			? v.filter((x): x is string => typeof x === "string")
			: undefined;
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
			(typeof r.display_name === "string" && r.display_name.trim()
				? r.display_name
				: undefined);
		const modalities =
			strArrMeta(r.modalities) ??
			strArrMeta(r.input_modalities);
		const vision =
			modalities?.includes("image") === true ||
			boolMeta(r.supports_vision) === true ||
			boolMeta(r.vision) === true ||
			strArrMeta(r.input)?.includes("image") === true;
		const reasoning =
			boolMeta(r.reasoning) === true ||
			boolMeta(r.supports_reasoning) === true ||
			modalities?.includes("reasoning") === true;
		const contextWindow =
			numMeta(r.context_window) ??
			numMeta(r.context_length) ??
			numMeta(r.max_model_len) ??
			numMeta(r.max_context_length);
		const maxTokens =
			numMeta(r.max_tokens) ??
			numMeta(r.max_output_tokens) ??
			numMeta(r.max_completion_tokens);
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
		return {
			id,
			...(displayName && displayName !== id ? { name: displayName } : {}),
			...(numMeta(r.inputTokenLimit)
				? { contextWindow: numMeta(r.inputTokenLimit) }
				: {}),
			...(numMeta(r.outputTokenLimit)
				? { maxTokens: numMeta(r.outputTokenLimit) }
				: {}),
		};
	}

	/** Probe a custom provider's OpenAI-compatible /models endpoint (server-side
	 *  because the baseUrl is often a LAN/loopback host the browser can't reach
	 *  cross-origin) and return the advertised models. reqId is echoed back
	 *  in fetch_models_result so the UI can match concurrent requests. */
	async fetchModelsList(
		reqId: number,
		baseUrl: string,
		apiKey?: string,
		authHeader?: boolean,
		api?: string,
	): Promise<void> {
		const emitError = (error: string) =>
			this.host.emit({ type: "fetch_models_result", reqId, ok: false, error });
		try {
			const models = await ModelAdminService.probeModelsEndpoint(
				baseUrl,
				apiKey,
				authHeader,
				api,
			);
			this.host.emit({ type: "fetch_models_result", reqId, ok: true, models });
		} catch (err) {
			emitError((err as Error).message);
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
	): Promise<UiModelConfigEntry[]> {
		const base = (baseUrl ?? "").trim().replace(/\/+$/, "");
		if (!base) throw new Error("请先填写 baseUrl");
		let url: URL;
		try {
			url = new URL(base);
		} catch {
			throw new Error(`baseUrl 无效：${base}`);
		}
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			throw new Error("baseUrl 仅支持 http/https");
		}

		const headers: Record<string, string> = {
			...(extraHeaders ?? {}),
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
					throw new Error("请求超时（15 秒）");
				}
				throw new Error(`请求失败：${(err as Error).message}`);
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
		if (!res) throw new Error("请求失败");
		if (!res.ok) {
			let detail = "";
			try {
				detail = (await res.text()).slice(0, 200);
			} catch {
				// response body already consumed / not text — ignore
			}
			throw new Error(`接口返回 HTTP ${res.status}${detail ? `：${detail}` : ""}`);
		}
		let models: UiModelConfigEntry[] = [];
		try {
			const json = (await res.json()) as Record<string, unknown>;
			const data = Array.isArray(json.data) ? json.data : null;
			if (data) {
				// OpenAI-compatible: { data: [{ id, context_window, modalities, … }] }
				models = data
					.map((m) => parseOpenAiModel(m))
					.filter((m) => m.id);
			} else if (Array.isArray(json.models)) {
				// Google: { models: [{ name: "models/…", displayName, … }] }
				models = (json.models as unknown[])
					.map((m) => parseGoogleModel(m))
					.filter((m) => m.id);
			}
		} catch {
			throw new Error("响应不是有效的 JSON");
		}
		// Dedupe by id (keep the first, most complete entry) and sort by id.
		const seen = new Set<string>();
		models = models
			.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)))
			.sort((a, b) => a.id.localeCompare(b.id));
		if (models.length === 0) throw new Error("接口未返回任何模型");
		return models;
	}

	/**
	 * Re-probe a SAVED custom provider's model list and merge it into its
	 * models.json entry — credentials never leave the server (unlike the
	 * edit-form fetch, which sends whatever the browser typed). Merge rules:
	 * existing ids keep all manually-entered fields and only gain metadata
	 * they were missing; brand-new ids are appended. Hot-reloads the runtime.
	 */
	async refreshProviderModels(providerId: string, reqId: number): Promise<void> {
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
			if (!saved?.baseUrl?.trim()) {
				this.host.emit({
					type: "notice",
					level: "warning",
					text: `服务商 ${pid} 不存在或未配置 baseUrl，无法刷新`,
					textEn: `Provider ${pid} does not exist or has no baseUrl; cannot refresh`,
				});
				return done(false, { error: "provider missing or no baseUrl" });
			}
			const fetched = await ModelAdminService.probeModelsEndpoint(
				saved.baseUrl,
				saved.apiKey,
				saved.authHeader === true ? true : undefined,
				saved.api,
				saved.headers as Record<string, string> | undefined,
			);

			// Merge: manual values win; fetched fills blanks and appends new ids.
			const prev = new Map((saved.models ?? []).map((m) => [m.id, m]));
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
			const merged = [...prev.values()].sort((a, b) =>
				a.id.localeCompare(b.id),
			);
			await this.saveModelConfig(pid, {
				providerId: pid,
				name: saved.name,
				api: saved.api,
				baseUrl: saved.baseUrl,
				// apiKey/headers 不回传浏览器——saveModelConfig 会保留旧值
				authHeader: saved.authHeader === true ? true : undefined,
				models: merged,
			});

			this.host.emit({
				type: "notice",
				level: "info",
				text:
					added > 0
						? `🔄 已刷新 ${pid}：新增 ${added} 个模型，共 ${merged.length} 个`
						: `🔄 已刷新 ${pid}：无新增模型（共 ${merged.length} 个）`,
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

	/** Upsert one provider into models.json and hot-reload the model runtime. */
	async saveModelConfig(
		providerId: string,
		config: UiProviderConfig,
	): Promise<void> {
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
		const models = (config.models ?? [])
			.filter((m) => m.id && m.id.trim())
			.map((m) => ({
				id: m.id.trim(),
				...(m.name?.trim() ? { name: m.name.trim() } : {}),
				...(m.reasoning ? { reasoning: true } : {}),
				...(m.input?.length ? { input: m.input } : {}),
				...(m.contextWindow ? { contextWindow: Number(m.contextWindow) } : {}),
				...(m.maxTokens ? { maxTokens: Number(m.maxTokens) } : {}),
			}));
		if (models.length === 0) {
			this.host.emit({ type: "notice", level: "error", text: "至少需要一个模型",
			textEn: "At least one model is required"
			});
			return;
		}
		try {
			const { providers } = this.readModelsConfig();
			// headers never reach the browser, so the incoming config can't carry
			// them — preserve the previously stored values when they are absent.
			const prevHeaders = providers[pid]?.headers;
			providers[pid] = {
				...(config.name?.trim() ? { name: config.name.trim() } : {}),
				...(config.api?.trim() ? { api: config.api.trim() } : {}),
				...(config.baseUrl?.trim() ? { baseUrl: config.baseUrl.trim() } : {}),
				...(config.apiKey?.trim() ? { apiKey: config.apiKey.trim() } : {}),
				...(config.authHeader ? { authHeader: true } : {}),
				...(prevHeaders && Object.keys(prevHeaders).length > 0
					? { headers: prevHeaders }
					: {}),
				models,
			};
			mkdirSync(this.host.agentDir, { recursive: true });
			writeFileSync(
				this.modelsConfigPath(),
				JSON.stringify({ providers }, null, 2) + "\n",
			);

			// Allow a custom models.json entry to reuse the provider credential
			// already stored in auth.json.  Seed the shared runtime too, because
			// older pi-ai versions did not always fall back to stored credentials
			// for a newly-created custom provider.  Never copy the secret into
			// models.json.
			try {
				const auth = JSON.parse(
					readFileSync(join(this.host.agentDir, "auth.json"), "utf8"),
				) as Record<string, unknown>;
				const credential = auth[pid];
				if (
					credential &&
					typeof credential === "object" &&
					"key" in credential &&
					typeof credential.key === "string" &&
					credential.key.trim()
				) {
					await this.host.modelRuntime().setRuntimeApiKey(
						pid,
						credential.key,
					);
				}
			} catch {
				// auth.json is optional; models.json can still use its own apiKey.
			}
			await this.host.modelRuntime().refresh();
			this.host.invalidatePiConfig();
			await this.listModelsConfig();
			await this.host.pushModels();
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
			writeFileSync(
				this.modelsConfigPath(),
				JSON.stringify({ providers }, null, 2) + "\n",
			);
			await this.host.modelRuntime().refresh();
			this.host.invalidatePiConfig();
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
