import { useEffect, useMemo, useRef, useState } from "react";
import { syncModelDraft } from "../model-config-sync";
import {
	FiActivity,
	FiCheck,
	FiCopy,
	FiCpu,
	FiDownload,
	FiPlus,
	FiRefreshCw,
	FiSearch,
	FiSliders,
	FiTrash2,
	FiX,
	FiZap,
} from "react-icons/fi";
import { THINKING_VALUES, THINKING_PRESET_PROFILES, THINKING_FORMAT_OPTIONS, PRESET_BUDGETS } from "../thinking-levels";
import type {
	ProviderKeyInfo,
	ProviderOAuthFlowState,
	ProviderStatus,
	UiEnrichResult,
	UiModelConfigEntry,
	UiProviderConfig,
	UiThinkingLevelMap,
} from "../types";
import { useT } from "../i18n";
import { appSend } from "../app-globals";
import { ProviderOAuthControls } from "./ProviderOAuthControls";

interface ModelConfigModalProps {
	providers: UiProviderConfig[];
	providerStatus: ProviderStatus[];
	providerKeys: Record<string, ProviderKeyInfo[]>;
	providerOAuthFlows: ProviderOAuthFlowState[];
	providerOAuthResults: Record<string, { ok: boolean; cancelled?: boolean; error?: string }>;
	fetchModelsResult?: {
		reqId: number;
		ok: boolean;
		models?: UiModelConfigEntry[];
		error?: string;
	} | null;
	testModelConnectionResult?: {
		reqId: number;
		ok: boolean;
		latencyMs?: number;
		error?: string;
	} | null;
	enrichModelsResult?: {
		reqId: number;
		ok: boolean;
		results?: UiEnrichResult[];
		error?: string;
	} | null;
	enrichModelsProgress?: {
		reqId: number;
		phase: "catalog" | "page" | "matching" | "aborted";
		current?: number;
		total?: number;
		message?: string;
	} | null;
	refreshBuiltinResult?: {
		reqId: number;
		ok: boolean;
		error?: string;
	} | null;
	refreshProviderResult?: {
		reqId: number;
		ok: boolean;
		added?: number;
		total?: number;
		error?: string;
	} | null;
	appendBuiltinResult?: {
		reqId: number;
		ok: boolean;
		error?: string;
	} | null;
	cloneProviderResult?: {
		reqId: number;
		ok: boolean;
		config?: UiProviderConfig;
		configs?: UiProviderConfig[];
		error?: string;
	} | null;
	defaultModel?: string | null;
	onClose: () => void;
}

const API_TYPES = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"];

let lastFetchModelsReqId = 0;

interface QuickProviderPreset {
	id: string;
	name: string;
	api: string;
	baseUrl: string;
	authHeader: boolean;
	apiKey?: string;
	tag?: string;
}

const QUICK_PRESETS: QuickProviderPreset[] = [
	{
		id: "openai",
		name: "OpenAI",
		api: "openai-responses",
		baseUrl: "https://api.openai.com/v1",
		authHeader: true,
		tag: "官方",
	},
	{
		id: "anthropic",
		name: "Anthropic",
		api: "anthropic-messages",
		baseUrl: "https://api.anthropic.com",
		authHeader: true,
		tag: "官方",
	},
	{
		id: "google",
		name: "Google Gemini",
		api: "google-generative-ai",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
		authHeader: true,
		tag: "官方",
	},
	{
		id: "dashscope",
		name: "Alibaba Cloud Bailian (CN)",
		api: "openai-completions",
		baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
		authHeader: true,
		tag: "官方",
	},
	{
		id: "dashscope-intl",
		name: "Alibaba Cloud Bailian (Singapore)",
		api: "openai-completions",
		baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
		authHeader: true,
		tag: "官方",
	},
	{
		id: "minimax-cn",
		name: "MiniMax (CN)",
		api: "anthropic-messages",
		baseUrl: "https://api.minimax.cn/anthropic",
		authHeader: true,
		tag: "官方",
	},
	{
		id: "minimax",
		name: "MiniMax (International)",
		api: "anthropic-messages",
		baseUrl: "https://api.minimax.io/anthropic",
		authHeader: true,
		tag: "官方",
	},
	{
		id: "mistral",
		name: "Mistral",
		api: "openai-completions",
		baseUrl: "https://api.mistral.ai/v1",
		authHeader: true,
		tag: "官方",
	},
	{
		id: "groq",
		name: "Groq",
		api: "openai-completions",
		baseUrl: "https://api.groq.com/openai/v1",
		authHeader: true,
		tag: "官方",
	},
	{
		id: "xai",
		name: "xAI",
		api: "openai-completions",
		baseUrl: "https://api.x.ai/v1",
		authHeader: true,
		tag: "官方",
	},
	{
		id: "magpie",
		name: "Magpie",
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:3425/v1",
		authHeader: true,
		apiKey: "magpie",
	},
	{
		id: "deepseek",
		name: "DeepSeek",
		api: "openai-completions",
		baseUrl: "https://api.deepseek.com/v1",
		authHeader: true,
		tag: "官方",
	},
	{
		id: "openrouter",
		name: "OpenRouter",
		api: "openai-completions",
		baseUrl: "https://openrouter.ai/api/v1",
		authHeader: true,
		tag: "聚合",
	},
	{
		id: "moonshot",
		name: "Moonshot (Kimi)",
		api: "openai-completions",
		baseUrl: "https://api.moonshot.cn/v1",
		authHeader: true,
		tag: "官方",
	},
	{
		id: "zhipu",
		name: "智谱 GLM",
		api: "openai-completions",
		baseUrl: "https://open.bigmodel.cn/api/paas/v4",
		authHeader: true,
		tag: "官方",
	},
	{
		id: "siliconflow",
		name: "硅基流动",
		api: "openai-completions",
		baseUrl: "https://api.siliconflow.cn/v1",
		authHeader: true,
		tag: "云端",
	},
	{
		id: "ollama",
		name: "Ollama",
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:11434/v1",
		authHeader: true,
		tag: "本地",
	},
	{
		id: "vllm",
		name: "vLLM / LM Studio",
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:8000/v1",
		authHeader: true,
		tag: "本地",
	},
	{
		id: "antigravity",
		name: "Antigravity (OpenAI)",
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:8045/v1",
		authHeader: true,
		tag: "反代",
	},
	{
		id: "antigravity-anthropic",
		name: "Antigravity (Anthropic)",
		api: "anthropic-messages",
		baseUrl: "http://127.0.0.1:8045",
		authHeader: true,
		tag: "反代",
	},
];

const CTX_PRESETS = [
	{ label: "8K", value: "8192" },
	{ label: "16K", value: "16384" },
	{ label: "32K", value: "32768" },
	{ label: "64K", value: "65536" },
	{ label: "128K", value: "131072" },
	{ label: "200K", value: "200000" },
	{ label: "1M", value: "1000000" },
];

const MAX_TOKENS_PRESETS = [
	{ label: "2K", value: "2048" },
	{ label: "4K", value: "4096" },
	{ label: "8K", value: "8192" },
	{ label: "16K", value: "16384" },
	{ label: "32K", value: "32768" },
	{ label: "64K", value: "65536" },
];

function getPresetTagLabel(tag: string, t: (k: any) => string): string {
	switch (tag) {
		case "官方":
			return t("presetTagOfficial");
		case "聚合":
			return t("presetTagAggregator");
		case "云端":
			return t("presetTagCloud");
		case "本地":
			return t("presetTagLocal");
		case "反代":
			return t("presetTagProxy");
		default:
			return tag;
	}
}

const CUSTOM_THINKING_PRESETS_KEY = "pi_web_ui_thinking_custom_presets";

export interface CustomThinkingPreset {
	id: string;
	name: string;
	thinkingFormat?: string;
	customExtraBody?: string;
	map: UiThinkingLevelMap;
}

function loadCustomThinkingPresets(): CustomThinkingPreset[] {
	if (typeof localStorage === "undefined") return [];
	try {
		const raw = localStorage.getItem(CUSTOM_THINKING_PRESETS_KEY);
		return raw ? JSON.parse(raw) : [];
	} catch {
		return [];
	}
}

function saveCustomThinkingPresets(presets: CustomThinkingPreset[]): void {
	if (typeof localStorage === "undefined") return;
	try {
		localStorage.setItem(CUSTOM_THINKING_PRESETS_KEY, JSON.stringify(presets));
	} catch {}
}

function validateJsonString(str: string): { valid: boolean; error?: string } {
	if (!str.trim()) return { valid: true };
	try {
		const parsed = JSON.parse(str.trim());
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { valid: false, error: "必须是 JSON 对象 (以 { 开头)" };
		}
		return { valid: true };
	} catch (e) {
		return { valid: false, error: (e as Error).message };
	}
}

interface DraftModel {
	id: string;
	name: string;
	reasoning: boolean;
	input: "text" | "text-image";
	contextWindow: string;
	maxTokens: string;
	thinkingLevelMap?: UiThinkingLevelMap;
	compat?: Record<string, unknown>;
	customExtraBody?: string;
	src?: string;
}

interface Draft {
	providerId: string;
	name: string;
	api: string;
	baseUrl: string;
	apiKey: string;
	hasApiKey: boolean;
	authHeader: boolean;
	models: DraftModel[];
}

const emptyModel = (): DraftModel => ({
	id: "",
	name: "",
	reasoning: false,
	input: "text",
	contextWindow: "",
	maxTokens: "",
});

const emptyDraft = (): Draft => ({
	providerId: "",
	name: "",
	api: "openai-completions",
	baseUrl: "",
	apiKey: "",
	hasApiKey: false,
	authHeader: true,
	models: [emptyModel()],
});

function toDraft(p: UiProviderConfig): Draft {
	return {
		providerId: p.providerId,
		name: p.name ?? "",
		api: p.api ?? "openai-completions",
		baseUrl: p.baseUrl ?? "",
		apiKey: "",
		hasApiKey: p.hasApiKey ?? false,
		authHeader: p.authHeader ?? false,
		models: (p.models.length ? p.models : [emptyModel()]).map((m) => ({
			id: m.id,
			name: m.name ?? "",
			reasoning: m.reasoning ?? false,
			input: m.input?.includes("image") ? "text-image" : "text",
			contextWindow: m.contextWindow ? String(m.contextWindow) : "",
			maxTokens: m.maxTokens ? String(m.maxTokens) : "",
			...(m.thinkingLevelMap ? { thinkingLevelMap: m.thinkingLevelMap } : {}),
			...(m.compat ? { compat: m.compat } : {}),
			...(m.customExtraBody ? { customExtraBody: m.customExtraBody } : {}),
		})),
	};
}

function parseEnrichHints(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of text.split("\n")) {
		const i = line.indexOf("=");
		if (i <= 0) continue;
		const k = line.slice(0, i).trim();
		const v = line.slice(i + 1).trim();
		if (k && v) out[k] = v;
	}
	return out;
}

function CandidatePickerModal({
	candidates,
	preselectedIds,
	onAdopt,
	onClose,
}: {
	candidates: UiModelConfigEntry[];
	preselectedIds?: string[];
	onAdopt: (selected: UiModelConfigEntry[]) => void;
	onClose: () => void;
}) {
	const t = useT();
	const [search, setSearch] = useState("");
	const [selectedIds, setSelectedIds] = useState<Set<string>>(() => {
		const all = new Set(candidates.map((c) => c.id));
		const preset = (preselectedIds ?? []).map((id) => id.trim()).filter((id) => all.has(id));
		if (preset.length > 0) return new Set(preset);
		const set = new Set<string>();
		for (const c of candidates) {
			const lower = c.id.toLowerCase();
			if (
				!lower.includes("embed") &&
				!lower.includes("audio") &&
				!lower.includes("tts") &&
				!lower.includes("whisper")
			) {
				set.add(c.id);
			}
		}
		if (set.size === 0) {
			for (const c of candidates) set.add(c.id);
		}
		return set;
	});

	const filtered = useMemo(() => {
		const q = search.trim().toLowerCase();
		if (!q) return candidates;
		return candidates.filter((c) => c.id.toLowerCase().includes(q) || (c.name && c.name.toLowerCase().includes(q)));
	}, [candidates, search]);

	const toggleSelect = (id: string) => {
		setSelectedIds((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	const selectAll = () => {
		setSelectedIds(new Set(filtered.map((c) => c.id)));
	};

	const deselectAll = () => {
		setSelectedIds(new Set());
	};

	const handleAdopt = () => {
		const selected = candidates.filter((c) => selectedIds.has(c.id));
		onAdopt(selected);
	};

	return (
		<div className="candidate-picker-backdrop" onClick={onClose}>
			<div className="candidate-picker-modal" onClick={(e) => e.stopPropagation()}>
				<div className="candidate-header">
					<div className="candidate-title-group">
						<span className="candidate-title">{t("candidatePickerTitle")}</span>
						<span className="candidate-subtitle">{t("candidatePickerSubtitle", { n: candidates.length })}</span>
					</div>
					<button type="button" className="iconbtn" onClick={onClose} aria-label={t("close")}>
						<FiX />
					</button>
				</div>

				<div className="candidate-filter-bar">
					<FiSearch style={{ color: "var(--text-faint)", flexShrink: 0 }} />
					<input
						type="text"
						className="candidate-search-input"
						placeholder={t("searchCandidatePlaceholder")}
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						autoFocus
					/>
					<div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
						<button type="button" className="btn sm" onClick={selectAll}>
							{t("selectAll")}
						</button>
						<button type="button" className="btn sm" onClick={deselectAll}>
							{t("deselectAll")}
						</button>
					</div>
				</div>

				<div className="candidate-list-scroll">
					{filtered.length === 0 && (
						<div style={{ padding: "32px 0", textAlign: "center", color: "var(--text-faint)", fontSize: 13 }}>
							{t("noCandidateMatches")}
						</div>
					)}
					{filtered.map((c) => {
						const isSelected = selectedIds.has(c.id);
						return (
							<div
								key={c.id}
								className={`candidate-item-card ${isSelected ? "selected" : ""}`}
								onClick={() => toggleSelect(c.id)}
							>
								<div className="candidate-item-left">
									<input
										type="checkbox"
										className="candidate-checkbox"
										checked={isSelected}
										onChange={() => {}}
										onClick={(e) => e.stopPropagation()}
									/>
									<div className="candidate-id-info">
										<span className="candidate-id-name">{c.id}</span>
										{c.name && c.name !== c.id && (
											<span style={{ fontSize: 11.5, color: "var(--text-dim)" }}>{c.name}</span>
										)}
									</div>
								</div>
								<div className="candidate-item-meta">
									{c.contextWindow && (
										<span className="spec-badge ctx" title={t("contextWindowTooltip")}>
											{c.contextWindow >= 1000000
												? `${Math.round(c.contextWindow / 1000000)}M`
												: `${Math.round(c.contextWindow / 1024)}K`}
										</span>
									)}
									{c.reasoning && (
										<span className="spec-badge reasoning" title={t("reasoningTooltip")}>
											<FiZap /> {t("reasoning")}
										</span>
									)}
									{c.input?.includes("image") && (
										<span className="spec-badge vision" title={t("visionTooltip")}>
											{t("vision")}
										</span>
									)}
								</div>
							</div>
						);
					})}
				</div>

				<div className="candidate-actions-footer">
					<span className="candidate-select-summary">
						{t("selectedCandidatesCount", { count: selectedIds.size, total: candidates.length })}
					</span>
					<div style={{ display: "flex", gap: 8 }}>
						<button type="button" className="btn" onClick={onClose}>
							{t("cancel")}
						</button>
						<button type="button" className="btn primary" disabled={selectedIds.size === 0} onClick={handleAdopt}>
							{t("adoptSelectedModels", { count: selectedIds.size })}
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}

export function ModelConfigModal({
	providers,
	providerStatus,
	providerKeys,
	providerOAuthFlows,
	providerOAuthResults,
	fetchModelsResult,
	testModelConnectionResult,
	enrichModelsResult,
	enrichModelsProgress: _enrichModelsProgress,
	cloneProviderResult,
	refreshBuiltinResult,
	refreshProviderResult,
	appendBuiltinResult,
	defaultModel,
	onClose,
}: ModelConfigModalProps) {
	const t = useT();

	const [activeNav, setActiveNav] = useState<{ type: "builtin" | "custom"; id: string }>(() => {
		if (providers.length > 0) return { type: "custom", id: providers[0].providerId };
		if (providerStatus.length > 0) return { type: "builtin", id: providerStatus[0].id };
		return { type: "custom", id: "" };
	});

	const [editing, setEditing] = useState<Draft | null>(() => {
		if (providers.length > 0) return toDraft(providers[0]);
		if (providerStatus.length > 0) return null;
		return emptyDraft();
	});

	const previousProviders = useRef(providers);
	useEffect(() => {
		const previous = previousProviders.current;
		previousProviders.current = providers;
		setEditing((draft) => {
			if (!draft) return draft;
			const incoming = providers.find((p) => p.providerId === draft.providerId);
			const old = previous.find((p) => p.providerId === draft.providerId);
			if (!incoming || incoming === old) return draft;
			return {
				...draft,
				hasApiKey: incoming.hasApiKey ?? false,
				models: syncModelDraft(draft.models, old ? toDraft(old).models : [], toDraft(incoming).models),
			};
		});
	}, [providers]);

	const [candidateList, setCandidateList] = useState<UiModelConfigEntry[] | null>(null);

	const [testingConn, setTestingConn] = useState(false);
	const [connReqId, setConnReqId] = useState(0);
	const [connFeedback, setConnFeedback] = useState<{ ok: boolean; latencyMs?: number; error?: string } | null>(null);
	const handledConnReq = useRef(0);

	const [addKeys, setAddKeys] = useState<Record<string, string>>({});
	const [addKeyNames, setAddKeyNames] = useState<Record<string, string>>({});
	const [addKeyBusy, setAddKeyBusy] = useState<string | null>(null);
	const addKeyPrevKeysRef = useRef(providerKeys);
	const addKeyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => {
		const busy = addKeyBusy;
		if (busy && providerKeys[busy] !== addKeyPrevKeysRef.current[busy]) {
			setAddKeyBusy(null);
			setAddKeys((k) => ({ ...k, [busy]: "" }));
			setAddKeyNames((n) => ({ ...n, [busy]: "" }));
			if (addKeyTimerRef.current) clearTimeout(addKeyTimerRef.current);
		}
		addKeyPrevKeysRef.current = providerKeys;
	}, [providerKeys, addKeyBusy]);
	useEffect(
		() => () => {
			if (addKeyTimerRef.current) clearTimeout(addKeyTimerRef.current);
		},
		[],
	);

	const [fetching, setFetching] = useState(false);
	const pendingFetchReq = useRef<number | null>(null);
	const [fetchMsg, setFetchMsg] = useState<{ ok: boolean; text: string } | null>(null);

	const [enriching, setEnriching] = useState(false);
	const [enrichCancelling, setEnrichCancelling] = useState(false);
	const [enrichReqId, setEnrichReqId] = useState(0);
	const [enrichMsg, setEnrichMsg] = useState<{ ok: boolean; text: string } | null>(null);
	const [_enrichRest, setEnrichRest] = useState<{ id: string; suggestions: string[]; note?: string }[]>([]);
	const [hintText] = useState("");
	const handledEnrichReq = useRef(0);

	const [expandedThinkingIdx, setExpandedThinkingIdx] = useState<number | null>(null);
	const [userPresets, setUserPresets] = useState<CustomThinkingPreset[]>(loadCustomThinkingPresets);
	const [presetNameInput, setPresetNameInput] = useState("");
	const [savingPresetForIdx, setSavingPresetForIdx] = useState<number | null>(null);

	const handleSaveAsUserPreset = (idx: number) => {
		const name = presetNameInput.trim();
		if (!name || !editing) return;
		const m = editing.models[idx];
		if (!m) return;
		const newPreset: CustomThinkingPreset = {
			id: `preset-${Date.now()}`,
			name,
			thinkingFormat: (m.compat?.thinkingFormat as string) || undefined,
			customExtraBody: m.customExtraBody?.trim() || undefined,
			map: m.thinkingLevelMap ?? {},
		};
		const updated = [...userPresets, newPreset];
		setUserPresets(updated);
		saveCustomThinkingPresets(updated);
		setPresetNameInput("");
		setSavingPresetForIdx(null);
	};

	const handleDeleteUserPreset = (id: string, e: React.MouseEvent) => {
		e.stopPropagation();
		const updated = userPresets.filter((p) => p.id !== id);
		setUserPresets(updated);
		saveCustomThinkingPresets(updated);
	};

	const [builtinBusy, setBuiltinBusy] = useState(false);
	const [builtinReqId, setBuiltinReqId] = useState(0);
	const [builtinMsg, setBuiltinMsg] = useState<{ ok: boolean; text: string } | null>(null);
	const handledBuiltinReq = useRef(0);

	const [appendingFor, setAppendingFor] = useState<string | null>(null);
	const [appendId, setAppendId] = useState("");
	const [appendName, setAppendName] = useState("");
	const [appendApi, setAppendApi] = useState("");
	const [appendBaseUrl, setAppendBaseUrl] = useState("");
	const [appendBusy, setAppendBusy] = useState(false);
	const [appendReqId, setAppendReqId] = useState(0);
	const [appendMsg, setAppendMsg] = useState<{ ok: boolean; text: string } | null>(null);
	const handledAppendReq = useRef(0);

	const [_batch, setBatch] = useState<Draft[] | null>(null);
	const [_batchKey, setBatchKey] = useState("");
	const [_addKeyDraft, setAddKeyDraft] = useState<Draft | null>(null);

	const [refreshing, setRefreshing] = useState<Record<string, boolean>>({});
	const refreshReqId = useRef(0);
	const handledRefreshReq = useRef(0);
	const [cloning, setCloning] = useState<string | null>(null);
	const cloneReqId = useRef(0);
	const handledCloneReq = useRef(0);

	const refreshProvider = (providerId: string) => {
		if (refreshing[providerId]) return;
		const reqId = ++refreshReqId.current + Date.now();
		setRefreshing((m) => ({ ...m, [providerId]: true }));
		appSend({ type: "refresh_provider_models", providerId, reqId });
	};

	useEffect(() => {
		if (!refreshProviderResult || refreshProviderResult.reqId === handledRefreshReq.current) return;
		handledRefreshReq.current = refreshProviderResult.reqId;
		setRefreshing({});
	}, [refreshProviderResult]);

	const cloneBuiltin = (p: ProviderStatus) => {
		if (cloning) return;
		setCloning(p.id);
		const reqId = ++cloneReqId.current + Date.now();
		const ok = appSend({ type: "clone_provider", provider: p.id, reqId });
		if (!ok) {
			setCloning(null);
		}
	};

	useEffect(() => {
		appSend({ type: "list_models_config" });
		appSend({ type: "list_providers" });
		appSend({ type: "list_provider_keys" });
		appSend({ type: "list_provider_oauth_flows" });
	}, []);

	useEffect(() => {
		if (!testModelConnectionResult || testModelConnectionResult.reqId === handledConnReq.current) return;
		handledConnReq.current = testModelConnectionResult.reqId;
		setTestingConn(false);
		setConnFeedback({
			ok: testModelConnectionResult.ok,
			latencyMs: testModelConnectionResult.latencyMs,
			error: testModelConnectionResult.error,
		});
	}, [testModelConnectionResult]);

	useEffect(() => {
		if (!fetchModelsResult || fetchModelsResult.reqId !== pendingFetchReq.current) return;
		pendingFetchReq.current = null;
		setFetching(false);
		if (fetchModelsResult.ok && fetchModelsResult.models?.length) {
			setCandidateList(fetchModelsResult.models);
			setFetchMsg({ ok: true, text: t("fetchModelsOk", { n: fetchModelsResult.models.length }) });
		} else {
			setFetchMsg({
				ok: false,
				text: fetchModelsResult.error || t("fetchModelsEmpty"),
			});
		}
	}, [fetchModelsResult, t]);

	useEffect(() => {
		if (!enrichModelsResult || enrichModelsResult.reqId === handledEnrichReq.current) return;
		handledEnrichReq.current = enrichModelsResult.reqId;
		setEnriching(false);
		setEnrichCancelling(false);
		if (enrichModelsResult.ok && enrichModelsResult.results?.length) {
			const res = enrichModelsResult.results;
			const byId = new Map(res.map((r) => [r.id.trim(), r]));
			setEditing((prev) => {
				if (!prev) return prev;
				return {
					...prev,
					models: prev.models.map((m) => {
						const match = byId.get(m.id.trim());
						if (!match || match.status !== "matched") return m;
						return {
							...m,
							name: m.name || match.name || "",
							contextWindow: m.contextWindow || (match.contextWindow ? String(match.contextWindow) : ""),
							maxTokens: m.maxTokens || (match.maxTokens ? String(match.maxTokens) : ""),
							input: m.input === "text" && match.input?.includes("image") ? "text-image" : m.input,
							reasoning: m.reasoning || (match.reasoning ?? false),
							thinkingLevelMap: m.thinkingLevelMap || match.thinkingLevelMap,
							src: match.source,
						};
					}),
				};
			});
			const matched = res.filter((r) => r.status === "matched").length;
			const unmatched = res.length - matched;
			setEnrichMsg({ ok: true, text: t("enrichModelsOk", { n: matched, m: unmatched }) });
			const rest = res
				.filter((r) => r.status !== "matched" && (r.suggestions?.length || r.note))
				.map((r) => ({ id: r.id, suggestions: r.suggestions ?? [], note: r.note }));
			setEnrichRest(rest);
		} else {
			setEnrichMsg({ ok: false, text: enrichModelsResult.error || t("enrichModelsErr", { msg: "" }) });
		}
	}, [enrichModelsResult, t]);

	useEffect(() => {
		if (!refreshBuiltinResult || refreshBuiltinResult.reqId === handledBuiltinReq.current) return;
		handledBuiltinReq.current = refreshBuiltinResult.reqId;
		setBuiltinBusy(false);
		if (refreshBuiltinResult.ok) {
			setBuiltinMsg({ ok: true, text: t("refreshBuiltinOk") });
		} else {
			setBuiltinMsg({ ok: false, text: refreshBuiltinResult.error || t("refreshBuiltinFail") });
		}
	}, [refreshBuiltinResult, t]);

	useEffect(() => {
		if (!appendBuiltinResult || appendBuiltinResult.reqId === handledAppendReq.current) return;
		handledAppendReq.current = appendBuiltinResult.reqId;
		setAppendBusy(false);
		if (appendBuiltinResult.ok) {
			setAppendMsg({ ok: true, text: t("appendModelOk") });
			setAppendId("");
			setAppendName("");
			setAppendApi("");
			setAppendBaseUrl("");
			setAppendingFor(null);
			appSend({ type: "list_models_config" });
		} else {
			setAppendMsg({ ok: false, text: appendBuiltinResult.error || t("appendModelFail") });
		}
	}, [appendBuiltinResult, t]);

	useEffect(() => {
		if (!cloneProviderResult || cloneProviderResult.reqId === handledCloneReq.current) return;
		handledCloneReq.current = cloneProviderResult.reqId;
		setCloning(null);
		if (cloneProviderResult.ok) {
			const cs = (cloneProviderResult as { configs?: UiProviderConfig[] }).configs;
			if (cs && cs.length > 1) {
				setBatch(cs.map((c) => toDraft(c)));
				setBatchKey("");
				return;
			}
			if (cloneProviderResult.config) {
				setAddKeyDraft(toDraft(cloneProviderResult.config));
			}
		}
	}, [cloneProviderResult]);

	const runTestConnection = () => {
		if (!editing) return;
		const base = editing.baseUrl.trim();
		if (!base) {
			setConnFeedback({ ok: false, error: t("fetchModelsNeedBaseUrl") });
			return;
		}
		setTestingConn(true);
		setConnFeedback(null);
		const reqId = connReqId + 1;
		setConnReqId(reqId);
		appSend({
			type: "test_model_connection",
			reqId,
			baseUrl: base,
			apiKey: editing.apiKey.trim() || undefined,
			...(editing.apiKey.trim() ? {} : editing.hasApiKey ? { providerId: editing.providerId.trim() } : {}),
			authHeader: editing.authHeader,
			api: editing.api,
		});
	};

	const fetchModels = () => {
		if (!editing) return;
		const base = editing.baseUrl.trim();
		if (!base) {
			setFetchMsg({ ok: false, text: t("fetchModelsNeedBaseUrl") });
			return;
		}
		if (fetching) return;
		setFetching(true);
		setFetchMsg(null);
		const reqId = Math.max(Date.now(), lastFetchModelsReqId + 1);
		lastFetchModelsReqId = reqId;
		pendingFetchReq.current = reqId;
		appSend({
			type: "fetch_models",
			reqId,
			baseUrl: base,
			apiKey: editing.apiKey.trim() || undefined,
			...(editing.apiKey.trim() ? {} : editing.hasApiKey ? { providerId: editing.providerId.trim() } : {}),
			authHeader: editing.authHeader,
			api: editing.api,
		});
	};

	const adoptSelectedModels = (selected: UiModelConfigEntry[]) => {
		if (!editing) return;
		setEditing((prev) => {
			if (!prev) return prev;
			const existing = prev.models.filter((m) => m.id.trim());
			const have = new Set(existing.map((m) => m.id.trim()));
			const adopted: DraftModel[] = selected
				.filter((s) => !have.has(s.id))
				.map((s) => ({
					id: s.id,
					name: s.name ?? "",
					reasoning: s.reasoning ?? false,
					input: s.input?.includes("image") ? "text-image" : "text",
					contextWindow: s.contextWindow ? String(s.contextWindow) : "",
					maxTokens: s.maxTokens ? String(s.maxTokens) : "",
					...(s.thinkingLevelMap ? { thinkingLevelMap: s.thinkingLevelMap } : {}),
				}));
			return {
				...prev,
				models: existing.length === 0 ? adopted : [...existing, ...adopted],
			};
		});
		setCandidateList(null);
	};

	const sendEnrich = () => {
		if (!editing || enriching) return;
		const ids = editing.models.map((m) => m.id.trim()).filter(Boolean);
		if (ids.length === 0) {
			setEnrichMsg({ ok: false, text: t("enrichModelsNeedIds") });
			return;
		}
		setEnriching(true);
		setEnrichCancelling(false);
		setEnrichMsg(null);
		setEnrichRest([]);
		const reqId = enrichReqId + 1;
		setEnrichReqId(reqId);
		appSend({ type: "enrich_models", reqId, ids, hints: parseEnrichHints(hintText) });
	};

	const abortEnrich = () => {
		if (!enriching || enrichCancelling) return;
		setEnrichCancelling(true);
		appSend({ type: "abort_enrich_models", reqId: enrichReqId });
	};

	const applyQuickPreset = (preset: QuickProviderPreset) => {
		setEditing((prev) => {
			const pid = prev?.providerId.trim() || preset.id;
			return {
				providerId: pid,
				name: prev?.name.trim() || preset.name,
				api: preset.api,
				baseUrl: preset.baseUrl,
				apiKey: prev?.apiKey || (prev?.hasApiKey ? "" : preset.apiKey) || "",
				hasApiKey: prev?.hasApiKey ?? false,
				authHeader: preset.authHeader,
				models: prev?.models.length ? prev.models : [emptyModel()],
			};
		});
		setConnFeedback(null);
		setFetchMsg(null);
	};

	const saveCustomProvider = () => {
		if (!editing) return;
		const providerId = editing.providerId.trim();
		if (!providerId) return;
		const models: UiModelConfigEntry[] = editing.models
			.filter((m) => m.id.trim())
			.map((m) => ({
				id: m.id.trim(),
				name: m.name.trim() || undefined,
				reasoning: m.reasoning || undefined,
				input: m.input === "text-image" ? ["text", "image"] : undefined,
				contextWindow: m.contextWindow ? Number(m.contextWindow) : undefined,
				maxTokens: m.maxTokens ? Number(m.maxTokens) : undefined,
				...(m.thinkingLevelMap ? { thinkingLevelMap: m.thinkingLevelMap } : {}),
				...(m.compat ? { compat: m.compat } : {}),
				...(m.customExtraBody?.trim() ? { customExtraBody: m.customExtraBody.trim() } : {}),
			}));
		const config: UiProviderConfig = {
			providerId,
			name: editing.name.trim() || undefined,
			api: editing.api.trim() || undefined,
			baseUrl: editing.baseUrl.trim() || undefined,
			...(editing.apiKey.trim() ? { apiKey: editing.apiKey.trim() } : {}),
			authHeader: editing.authHeader || undefined,
			models,
		};
		appSend({ type: "save_model_config", providerId, config });
		onClose();
	};

	const setModelRow = (i: number, patch: Partial<DraftModel>) => {
		if (!editing) return;
		setEditing({
			...editing,
			models: editing.models.map((m, j) => (j === i ? { ...m, ...patch } : m)),
		});
	};

	const addModelRow = () => {
		if (!editing) return;
		setEditing({
			...editing,
			models: [...editing.models, emptyModel()],
		});
	};

	const removeModelRow = (i: number) => {
		if (!editing) return;
		setEditing({
			...editing,
			models: editing.models.filter((_, j) => j !== i),
		});
	};

	const addKey = (p: ProviderStatus) => {
		const key = (addKeys[p.id] ?? "").trim();
		if (!key || addKeyBusy) return;
		setAddKeyBusy(p.id);
		appSend({
			type: "add_provider_key",
			provider: p.id,
			apiKey: key,
			name: (addKeyNames[p.id] ?? "").trim() || undefined,
		});
		if (addKeyTimerRef.current) clearTimeout(addKeyTimerRef.current);
		addKeyTimerRef.current = setTimeout(() => {
			setAddKeyBusy((cur) => (cur === p.id ? null : cur));
		}, 10000);
	};

	const activateKey = (providerId: string, keyName: string) => {
		appSend({ type: "activate_provider_key", provider: providerId, keyName });
		appSend({ type: "list_provider_keys" });
	};

	const removeKey = (providerId: string, keyName: string) => {
		if (!window.confirm(t("removeKeyConfirm"))) return;
		appSend({ type: "remove_provider_key", provider: providerId, keyName });
		appSend({ type: "list_provider_keys" });
	};

	const clearBuiltinKey = (id: string) => {
		if (window.confirm(t("clearKeyConfirm", { id }))) {
			appSend({ type: "clear_provider_api_key", provider: id });
		}
	};

	const removeProvider = (p: UiProviderConfig) => {
		if (
			window.confirm(
				t("deleteProviderConfirm", {
					id: p.providerId,
					n: p.models.length,
				}),
			)
		) {
			appSend({ type: "delete_model_config", providerId: p.providerId });
			if (activeNav.type === "custom" && activeNav.id === p.providerId) {
				const remaining = providers.filter((x) => x.providerId !== p.providerId);
				if (remaining.length > 0) {
					setActiveNav({ type: "custom", id: remaining[0].providerId });
					setEditing(toDraft(remaining[0]));
				} else {
					setActiveNav({ type: "custom", id: "" });
					setEditing(emptyDraft());
				}
			}
		}
	};

	const submitAppend = (providerId: string) => {
		const id = appendId.trim();
		if (!id || appendBusy) return;
		setAppendBusy(true);
		setAppendMsg(null);
		const reqId = appendReqId + 1;
		setAppendReqId(reqId);
		appSend({
			type: "append_builtin_model",
			providerId,
			model: {
				id,
				...(appendName.trim() ? { name: appendName.trim() } : {}),
				...(appendApi ? { api: appendApi } : {}),
				...(appendBaseUrl.trim() ? { baseUrl: appendBaseUrl.trim() } : {}),
			},
			reqId,
		});
	};

	const refreshBuiltin = () => {
		if (builtinBusy) return;
		setBuiltinBusy(true);
		setBuiltinMsg(null);
		const reqId = builtinReqId + 1;
		setBuiltinReqId(reqId);
		appSend({ type: "refresh_builtin_models", reqId });
	};

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal model-studio-modal" onClick={(e) => e.stopPropagation()}>
				<div className="studio-header">
					<div className="studio-header-left">
						<div className="studio-header-icon-box">
							<FiCpu />
						</div>
						<div className="studio-header-title-wrap">
							<h2 className="studio-header-title">{t("modelManagementTitle")}</h2>
							<span className="studio-header-badge">Studio</span>
						</div>
					</div>
					<div className="studio-header-actions">
						{defaultModel !== undefined && defaultModel && (
							<div
								style={{
									display: "inline-flex",
									alignItems: "center",
									gap: 5,
									padding: "3px 8px",
									borderRadius: 6,
									background: "rgba(251, 191, 36, 0.08)",
									border: "1px solid rgba(251, 191, 36, 0.3)",
									fontSize: 11.5,
									color: "var(--amber)",
								}}
								title={t("defaultModelLabel", { model: defaultModel })}
							>
								<span>★</span>
								<span
									style={{
										maxWidth: 120,
										overflow: "hidden",
										textOverflow: "ellipsis",
										whiteSpace: "nowrap",
										fontFamily: "var(--mono)",
									}}
								>
									{defaultModel.split("/").slice(1).join("/")}
								</span>
								<button
									type="button"
									style={{
										background: "transparent",
										border: "none",
										color: "var(--amber)",
										cursor: "pointer",
										fontSize: 10,
										padding: "0 2px",
										opacity: 0.7,
									}}
									title={t("clearDefaultModel")}
									onClick={() => appSend({ type: "clear_default_model" })}
								>
									✕
								</button>
							</div>
						)}
						<button
							type="button"
							className="studio-header-btn"
							title={t("refreshBuiltinHint")}
							disabled={builtinBusy}
							onClick={refreshBuiltin}
						>
							<FiDownload />
							<span>{builtinBusy ? t("refreshBuiltinBusy") : t("refreshBuiltinCatalog")}</span>
						</button>
						<button
							type="button"
							className="studio-header-iconbtn"
							title={t("reloadModelsHint")}
							onClick={() => appSend({ type: "reload_models_config" })}
						>
							<FiRefreshCw />
						</button>
						<button type="button" className="studio-header-iconbtn close-btn" aria-label={t("close")} onClick={onClose}>
							<FiX />
						</button>
					</div>
				</div>
				{builtinMsg && (
					<div
						style={{
							padding: "6px 20px",
							background: "var(--bg-elev2)",
							fontSize: 12,
							borderBottom: "1px solid var(--border-soft)",
						}}
					>
						<span className={`fetch-msg ${builtinMsg.ok ? "ok" : "err"}`}>{builtinMsg.text}</span>
					</div>
				)}

				<div className="model-studio-body">
					<div className="model-studio-sidebar">
						<div style={{ padding: "12px 10px 6px" }}>
							<button
								type="button"
								className="btn primary sm"
								style={{ width: "100%", justifyContent: "center" }}
								onClick={() => {
									setActiveNav({ type: "custom", id: "" });
									setEditing(emptyDraft());
									setConnFeedback(null);
									setFetchMsg(null);
								}}
							>
								<FiPlus /> {t("addCustomProvider")}
							</button>
						</div>

						<div className="studio-sidebar-section">
							<span className="studio-sidebar-title">{t("customProvidersCount", { n: providers.length })}</span>
							{providers.length === 0 && (
								<div style={{ fontSize: 11.5, color: "var(--text-faint)", padding: "6px 8px" }}>
									{t("noCustomProviders")}
								</div>
							)}
							{providers.map((p) => {
								const active = activeNav.type === "custom" && activeNav.id === p.providerId;
								return (
									<div
										key={p.providerId}
										className={`studio-nav-item ${active ? "active" : ""}`}
										onClick={() => {
											setActiveNav({ type: "custom", id: p.providerId });
											setEditing(toDraft(p));
											setConnFeedback(null);
											setFetchMsg(null);
										}}
									>
										<span className="studio-nav-label">
											<span className="studio-nav-dot configured" />
											<span>{p.name || p.providerId}</span>
										</span>
										<span style={{ fontSize: 10.5, color: "var(--text-faint)", fontFamily: "var(--mono)" }}>
											{p.models.length}m
										</span>
									</div>
								);
							})}
						</div>

						<div className="studio-sidebar-section">
							<span className="studio-sidebar-title">{t("builtinProvidersCount", { n: providerStatus.length })}</span>
							{providerStatus.map((p) => {
								const active = activeNav.type === "builtin" && activeNav.id === p.id;
								const pkeys = providerKeys[p.id] ?? [];
								return (
									<div
										key={p.id}
										className={`studio-nav-item ${active ? "active" : ""}`}
										onClick={() => {
											setActiveNav({ type: "builtin", id: p.id });
											setEditing(null);
										}}
									>
										<span className="studio-nav-label">
											<span className={`studio-nav-dot ${p.configured ? "configured" : ""}`} />
											<span>{p.name}</span>
										</span>
										{pkeys.length > 0 && (
											<span style={{ fontSize: 10.5, color: "var(--text-faint)", fontFamily: "var(--mono)" }}>
												{pkeys.length}k
											</span>
										)}
									</div>
								);
							})}
						</div>
					</div>

					<div className="model-studio-main">
						{editing && (
							<div className="studio-card">
								<div className="studio-card-head">
									<div className="studio-card-title">
										<span>
											{editing.providerId
												? t("editProviderTitle", { id: editing.providerId })
												: t("newCustomProviderTitle")}
										</span>
										{editing.providerId && providers.some((p) => p.providerId === editing.providerId) && (
											<>
												<button
													type="button"
													className="iconbtn sm"
													title={t("refreshModels")}
													disabled={refreshing[editing.providerId]}
													onClick={() => refreshProvider(editing.providerId)}
												>
													<FiRefreshCw className={refreshing[editing.providerId] ? "spin" : ""} />
												</button>
												<button
													type="button"
													className="iconbtn danger sm"
													title={t("deleteProviderTooltip")}
													onClick={() => {
														const target = providers.find((p) => p.providerId === editing.providerId);
														if (target) removeProvider(target);
													}}
												>
													<FiTrash2 />
												</button>
											</>
										)}
									</div>
									<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
										<div className="conn-test-box">
											<button
												type="button"
												className="conn-test-btn"
												disabled={testingConn || !editing.baseUrl.trim()}
												onClick={runTestConnection}
											>
												<FiActivity /> {testingConn ? t("testingConnection") : t("testConnection")}
											</button>
											{connFeedback && (
												<span className={`ping-indicator ${connFeedback.ok ? "ok" : "err"}`}>
													<span className="ping-dot" />
													<span>
														{connFeedback.ok
															? t("connSuccess", { latency: connFeedback.latencyMs ?? 0 })
															: t("connFailed")}
													</span>
												</span>
											)}
										</div>
										<button type="button" className="btn primary sm" onClick={saveCustomProvider}>
											{t("save")}
										</button>
									</div>
								</div>

								<div className="quick-chips-wrapper">
									<span className="quick-chips-label">{t("quickPresetsLabel")}</span>
									<div className="quick-chips-grid">
										{QUICK_PRESETS.map((preset) => (
											<button
												type="button"
												key={preset.id}
												className="quick-chip"
												onClick={() => applyQuickPreset(preset)}
											>
												<span className="quick-chip-name">{preset.name}</span>
												{preset.tag && <span className="quick-chip-tag">{getPresetTagLabel(preset.tag, t)}</span>}
											</button>
										))}
									</div>
								</div>

								<div className="form-grid">
									<label className="field">
										<span className="field-label">
											{t("providerId")} <em>{t("providerIdHint")}</em>
										</span>
										<input
											type="text"
											value={editing.providerId}
											disabled={providers.some((p) => p.providerId === editing.providerId)}
											onChange={(e) => setEditing({ ...editing, providerId: e.target.value })}
											placeholder={t("providerIdPlaceholder")}
										/>
									</label>
									<label className="field">
										<span className="field-label">{t("displayName")}</span>
										<input
											type="text"
											value={editing.name}
											onChange={(e) => setEditing({ ...editing, name: e.target.value })}
											placeholder={t("displayNamePh")}
										/>
									</label>
									<label className="field">
										<span className="field-label">{t("apiType")}</span>
										<select value={editing.api} onChange={(e) => setEditing({ ...editing, api: e.target.value })}>
											{API_TYPES.map((a) => (
												<option key={a} value={a}>
													{a}
												</option>
											))}
										</select>
									</label>
									<label className="field">
										<span className="field-label">
											baseUrl <em>{t("baseUrlHint")}</em>
										</span>
										<input
											type="text"
											value={editing.baseUrl}
											onChange={(e) => setEditing({ ...editing, baseUrl: e.target.value })}
											placeholder="https://api.deepseek.com/v1"
										/>
									</label>
									<label className="field">
										<span className="field-label">{t("apiKey")}</span>
										<input
											type="password"
											value={editing.apiKey}
											onChange={(e) => setEditing({ ...editing, apiKey: e.target.value })}
											placeholder={editing.hasApiKey ? t("apiKeySavedHint") : t("apiKeyHint")}
										/>
									</label>
									<label className="field check" style={{ alignSelf: "center", paddingTop: 16 }}>
										<input
											type="checkbox"
											checked={editing.authHeader}
											onChange={(e) => setEditing({ ...editing, authHeader: e.target.checked })}
										/>
										<span>{t("authHeader")}</span>
									</label>
								</div>

								<div style={{ marginTop: 8 }}>
									<div className="model-section-head">
										<span className="form-section-title" style={{ fontSize: 13, fontWeight: 600 }}>
											{t("modelMatrixCount", { n: editing.models.filter((m) => m.id.trim()).length })}
										</span>
										<div className="model-section-actions">
											{fetchMsg && (
												<span className={`fetch-msg ${fetchMsg.ok ? "ok" : "err"}`} title={fetchMsg.text}>
													{fetchMsg.text}
												</span>
											)}
											{enrichMsg && (
												<span className={`fetch-msg ${enrichMsg.ok ? "ok" : "err"}`} title={enrichMsg.text}>
													{enrichMsg.text}
												</span>
											)}
											<button
												type="button"
												className="btn sm"
												disabled={fetching || !editing.baseUrl.trim()}
												title={t("fetchModelsHint")}
												onClick={fetchModels}
											>
												<FiDownload /> {fetching ? t("fetchingModels") : t("autoFetchAndAdopt")}
											</button>
											<button
												type="button"
												className="btn sm"
												disabled={enriching}
												title={t("enrichModelsHint")}
												onClick={sendEnrich}
											>
												<FiDownload /> {enriching ? t("enrichingModels") : t("enrichModels")}
											</button>
											{enriching && (
												<button
													type="button"
													className="btn sm"
													disabled={enrichCancelling}
													title={t("enrichModelsAbort")}
													onClick={abortEnrich}
													style={{ color: "var(--red)" }}
												>
													<FiX /> {enrichCancelling ? t("enrichCancelling") : t("enrichModelsCancel")}
												</button>
											)}
										</div>
									</div>

									<div className="model-matrix-list">
										{editing.models.map((m, idx) => (
											<div key={idx} className="model-matrix-card">
												<div className="matrix-main-row">
													<div className="matrix-input-group id-group">
														<span className="matrix-input-prefix">
															<FiCpu /> ID
														</span>
														<input
															type="text"
															className="matrix-input-field mono"
															value={m.id}
															onChange={(e) => setModelRow(idx, { id: e.target.value })}
															placeholder={t("modelIdPlaceholder")}
														/>
													</div>

													<div className="matrix-input-group name-group">
														<span className="matrix-input-prefix">{t("modelAliasPrefix")}</span>
														<input
															type="text"
															className="matrix-input-field"
															value={m.name}
															onChange={(e) => setModelRow(idx, { name: e.target.value })}
															placeholder={t("modelAliasPlaceholder")}
														/>
													</div>

													<div className="matrix-toggles">
														<button
															type="button"
															className={`matrix-toggle-tag ${m.input === "text-image" ? "active vision" : ""}`}
															onClick={() =>
																setModelRow(idx, { input: m.input === "text-image" ? "text" : "text-image" })
															}
															title={t("visionCheckboxTitle")}
														>
															{t("visionCheckboxLabel")}
														</button>
														<button
															type="button"
															className={`matrix-toggle-tag ${m.reasoning ? "active reasoning" : ""}`}
															onClick={() => setModelRow(idx, { reasoning: !m.reasoning })}
															title={t("reasoningCheckboxTitle")}
														>
															{t("reasoningCheckboxLabel")}
														</button>
														{m.reasoning && (
															<button
																type="button"
																className={`matrix-toggle-tag ${expandedThinkingIdx === idx ? "active thinking-config" : ""}`}
																onClick={() => setExpandedThinkingIdx(expandedThinkingIdx === idx ? null : idx)}
																title={t("thinkingConfigTitle")}
															>
																<FiSliders /> {t("thinkingConfigBtn")}{" "}
																{m.thinkingLevelMap ? `(${t("thinkingCustomized")})` : ""}
															</button>
														)}
														{defaultModel !== undefined &&
															m.id.trim() &&
															(() => {
																const fullId = `${editing.providerId}/${m.id.trim()}`;
																const isDefault = defaultModel === fullId || defaultModel === m.id.trim();
																return (
																	<button
																		type="button"
																		className={`matrix-star-btn ${isDefault ? "active" : ""}`}
																		title={isDefault ? t("cancelDefaultTooltip") : t("setDefaultTooltip")}
																		onClick={() => {
																			if (isDefault) {
																				appSend({ type: "clear_default_model" });
																			} else {
																				appSend({ type: "set_default_model", modelId: fullId });
																			}
																		}}
																	>
																		<span className="matrix-star-icon">{isDefault ? "★" : "☆"}</span>
																		<span>{isDefault ? t("defaultModelBadge") : t("setDefaultModelBtn")}</span>
																	</button>
																);
															})()}
														<button
															type="button"
															className="matrix-delete-btn"
															title={t("delete")}
															onClick={() => removeModelRow(idx)}
														>
															<FiTrash2 />
														</button>
													</div>
												</div>

												<div className="matrix-spec-bar">
													<div className="spec-combobox">
														<span className="spec-combobox-label">{t("contextWindowLabel")}</span>
														<select
															className="spec-combobox-select"
															value={CTX_PRESETS.some((p) => p.value === m.contextWindow) ? m.contextWindow : "custom"}
															onChange={(e) => {
																if (e.target.value !== "custom") {
																	setModelRow(idx, { contextWindow: e.target.value });
																}
															}}
														>
															{CTX_PRESETS.map((p) => (
																<option key={p.value} value={p.value}>
																	{p.label} ({Math.round(Number(p.value) / 1024)}K)
																</option>
															))}
															<option value="custom">{t("customOption")}</option>
														</select>
														{(!CTX_PRESETS.some((p) => p.value === m.contextWindow) || m.contextWindow === "") && (
															<input
																type="text"
																className="spec-combobox-custom-input"
																value={m.contextWindow}
																onChange={(e) => setModelRow(idx, { contextWindow: e.target.value })}
																placeholder={t("contextPlaceholder")}
															/>
														)}
													</div>

													<div className="spec-combobox">
														<span className="spec-combobox-label">{t("maxOutputLabel")}</span>
														<select
															className="spec-combobox-select"
															value={MAX_TOKENS_PRESETS.some((p) => p.value === m.maxTokens) ? m.maxTokens : "custom"}
															onChange={(e) => {
																if (e.target.value !== "custom") {
																	setModelRow(idx, { maxTokens: e.target.value });
																}
															}}
														>
															{MAX_TOKENS_PRESETS.map((p) => (
																<option key={p.value} value={p.value}>
																	{p.label} ({Math.round(Number(p.value) / 1024)}K)
																</option>
															))}
															<option value="custom">{t("customOption")}</option>
														</select>
														{(!MAX_TOKENS_PRESETS.some((p) => p.value === m.maxTokens) || m.maxTokens === "") && (
															<input
																type="text"
																className="spec-combobox-custom-input"
																value={m.maxTokens}
																onChange={(e) => setModelRow(idx, { maxTokens: e.target.value })}
																placeholder={t("maxOutputPlaceholder")}
															/>
														)}
													</div>

													<div className="matrix-spec-quick-pills">
														{["32K", "128K", "200K"].map((lbl) => {
															const match = CTX_PRESETS.find((p) => p.label === lbl);
															if (!match) return null;
															return (
																<button
																	type="button"
																	key={lbl}
																	className={`param-pill ${m.contextWindow === match.value ? "active" : ""}`}
																	onClick={() => setModelRow(idx, { contextWindow: match.value })}
																	title={t("contextPresetTooltip", { label: lbl })}
																>
																	{lbl}
																</button>
															);
														})}
													</div>
												</div>

												{m.reasoning && expandedThinkingIdx === idx && (
													<div className="matrix-thinking-config-drawer">
														<div className="thinking-drawer-header">
															<div className="thinking-drawer-title">
																<FiSliders />
																<span>{t("thinkingConfigBtn") || "思考配置"}</span>
															</div>
															<div className="thinking-drawer-actions">
																<button
																	type="button"
																	className="btn xs text-btn"
																	style={{ whiteSpace: "nowrap" }}
																	onClick={() =>
																		setModelRow(idx, {
																			thinkingLevelMap: undefined,
																			compat: undefined,
																			customExtraBody: "",
																		})
																	}
																	title={t("thinkingResetDefault")}
																>
																	{t("thinkingResetDefault")}
																</button>
															</div>
														</div>

														<div className="thinking-presets-row">
															<span className="thinking-presets-label">{t("thinkingQuickApply")}</span>
															<div className="thinking-preset-pills">
																{THINKING_PRESET_PROFILES.map((profile) => (
																	<button
																		key={profile.id}
																		type="button"
																		className="param-pill"
																		onClick={() => {
																			const currentCompat = { ...(m.compat ?? {}) };
																			if (profile.thinkingFormat) {
																				currentCompat.thinkingFormat = profile.thinkingFormat;
																			} else if (profile.id === "fixed-deepseek" || profile.id === "claude-budget") {
																				delete currentCompat.thinkingFormat;
																			}
																			setModelRow(idx, {
																				thinkingLevelMap: profile.map,
																				compat: Object.keys(currentCompat).length ? currentCompat : undefined,
																			});
																		}}
																		title={profile.desc}
																	>
																		{profile.name}
																	</button>
																))}

																{userPresets.map((preset) => (
																	<span key={preset.id} className="param-pill user-preset-pill">
																		<button
																			type="button"
																			className="user-preset-btn"
																			onClick={() => {
																				const currentCompat = { ...(m.compat ?? {}) };
																				if (preset.thinkingFormat) {
																					currentCompat.thinkingFormat = preset.thinkingFormat;
																				} else {
																					delete currentCompat.thinkingFormat;
																				}
																				setModelRow(idx, {
																					thinkingLevelMap: preset.map,
																					compat: Object.keys(currentCompat).length ? currentCompat : undefined,
																					customExtraBody: preset.customExtraBody ?? "",
																				});
																			}}
																			title={`套用自定义预设：${preset.name}`}
																		>
																			🏷️ {preset.name}
																		</button>
																		<button
																			type="button"
																			className="user-preset-del"
																			onClick={(e) => handleDeleteUserPreset(preset.id, e)}
																			title="删除此预设"
																		>
																			×
																		</button>
																	</span>
																))}
															</div>
														</div>

														<div className="thinking-advanced-row">
															<div className="thinking-advanced-head">
																<div className="thinking-format-selector">
																	<span className="spec-combobox-label">{t("thinkingFormatLabel")}</span>
																	<select
																		className="spec-combobox-select"
																		value={(m.compat?.thinkingFormat as string) ?? ""}
																		onChange={(e) => {
																			const fmt = e.target.value.trim();
																			const currentCompat = { ...(m.compat ?? {}) };
																			if (fmt) {
																				currentCompat.thinkingFormat = fmt;
																			} else {
																				delete currentCompat.thinkingFormat;
																			}
																			setModelRow(idx, {
																				compat: Object.keys(currentCompat).length ? currentCompat : undefined,
																			});
																		}}
																	>
																		{THINKING_FORMAT_OPTIONS.map((opt) => (
																			<option key={opt.value} value={opt.value}>
																				{opt.label}
																			</option>
																		))}
																	</select>
																</div>

																{savingPresetForIdx === idx ? (
																	<div className="save-preset-inline">
																		<input
																			type="text"
																			className="spec-combobox-custom-input"
																			style={{ width: 130, textAlign: "left" }}
																			placeholder="预设名称 (如: 16K模版)"
																			value={presetNameInput}
																			onChange={(e) => setPresetNameInput(e.target.value)}
																			onKeyDown={(e) => {
																				if (e.key === "Enter") handleSaveAsUserPreset(idx);
																			}}
																		/>
																		<button
																			type="button"
																			className="btn xs"
																			onClick={() => handleSaveAsUserPreset(idx)}
																		>
																			保存
																		</button>
																		<button
																			type="button"
																			className="btn xs text-btn"
																			onClick={() => setSavingPresetForIdx(null)}
																		>
																			取消
																		</button>
																	</div>
																) : (
																	<button
																		type="button"
																		className="btn xs"
																		onClick={() => {
																			setSavingPresetForIdx(idx);
																			setPresetNameInput("");
																		}}
																		title="将当前模型的思考配置、协议与 JSON 存为一个命名的预设模板"
																	>
																		<FiPlus /> 存为我的预设
																	</button>
																)}
															</div>

															<div className="thinking-raw-body-block">
																<div
																	style={{
																		display: "flex",
																		justifyContent: "space-between",
																		alignItems: "center",
																	}}
																>
																	<span className="spec-combobox-label">{t("thinkingRawBodyLabel")}</span>
																	{m.customExtraBody && (
																		<span
																			style={{
																				fontSize: "10.5px",
																				color: validateJsonString(m.customExtraBody).valid
																					? "var(--green, #22c55e)"
																					: "var(--red, #ef4444)",
																			}}
																		>
																			{validateJsonString(m.customExtraBody).valid
																				? "✓ JSON语法有效（保存后自动无损合入请求 body）"
																				: `✕ ${validateJsonString(m.customExtraBody).error}`}
																		</span>
																	)}
																</div>
																<textarea
																	className="thinking-raw-body-textarea"
																	placeholder='{"thinking": {"type": "enabled", "budget_tokens": 16000}}'
																	rows={2}
																	value={m.customExtraBody ?? ""}
																	onChange={(e) => setModelRow(idx, { customExtraBody: e.target.value })}
																/>
															</div>
														</div>

														<div className="thinking-levels-grid">
															{THINKING_VALUES.map((lvl) => {
																const map = m.thinkingLevelMap;
																const isNull = map && map[lvl] === null;
																const isEnabled = !isNull;
																const customVal =
																	map && map[lvl] !== null && map[lvl] !== undefined ? String(map[lvl]) : "";
																const defaultBudget = PRESET_BUDGETS[lvl];
																const placeholder =
																	defaultBudget !== undefined && defaultBudget !== null ? String(defaultBudget) : lvl;

																return (
																	<div key={lvl} className={`thinking-level-col ${isEnabled ? "enabled" : "disabled"}`}>
																		<div className="level-col-head">
																			<label className="level-check-label">
																				<input
																					type="checkbox"
																					checked={isEnabled}
																					onChange={(e) => {
																						const currentMap = { ...(m.thinkingLevelMap ?? {}) };
																						if (e.target.checked) {
																							delete currentMap[lvl];
																						} else {
																							currentMap[lvl] = null;
																						}
																						setModelRow(idx, { thinkingLevelMap: currentMap });
																					}}
																				/>
																				<span className="level-name">{t(`thinking.${lvl}`) || lvl}</span>
																			</label>
																		</div>
																		{isEnabled && (
																			<input
																				type="text"
																				className="level-val-input"
																				value={customVal}
																				placeholder={placeholder}
																				title="自定义发送给模型/网关的字面量或 Token 数（留空为默认）"
																				onChange={(e) => {
																					const currentMap = { ...(m.thinkingLevelMap ?? {}) };
																					const val = e.target.value.trim();
																					if (!val) {
																						delete currentMap[lvl];
																					} else {
																						currentMap[lvl] = val;
																					}
																					setModelRow(idx, { thinkingLevelMap: currentMap });
																				}}
																			/>
																		)}
																	</div>
																);
															})}
														</div>
													</div>
												)}
											</div>
										))}

										<button
											type="button"
											className="btn sm"
											style={{ alignSelf: "flex-start", marginTop: 4 }}
											onClick={addModelRow}
										>
											<FiPlus /> {t("addModelRow")}
										</button>
									</div>
								</div>
							</div>
						)}

						{activeNav.type === "builtin" &&
							(() => {
								const p = providerStatus.find((x) => x.id === activeNav.id);
								if (!p) return null;
								const pkeys = providerKeys[p.id] ?? [];
								return (
									<div className="studio-card">
										<div className="studio-card-head">
											<div className="studio-card-title">
												<span>{t("builtinProviderTitle", { name: p.name })}</span>
												{p.configured && <span className="auth-badge">{t("configuredBadge")}</span>}
												{p.source && !p.configured && <span className="auth-badge dim">{p.source}</span>}
											</div>
											<div style={{ display: "flex", alignItems: "center", gap: 6 }}>
												<button
													type="button"
													className="btn sm"
													title={t("cloneProvider")}
													disabled={cloning === p.id}
													onClick={() => cloneBuiltin(p)}
												>
													<FiCopy /> {t("cloneProvider")}
												</button>
												<button
													type="button"
													className="btn sm"
													onClick={() => {
														setAppendingFor(appendingFor === p.id ? null : p.id);
														setAppendMsg(null);
													}}
												>
													<FiPlus /> {t("appendModel")}
												</button>
												{p.supportsApiKey && p.source === "stored" && !p.usingOAuth && (
													<button
														type="button"
														className="btn sm danger"
														title={t("clearKeyTitle")}
														onClick={() => clearBuiltinKey(p.id)}
													>
														<FiTrash2 /> {t("clearKey")}
													</button>
												)}
											</div>
										</div>

										{p.supportsOAuth && (
											<ProviderOAuthControls
												provider={p}
												flow={providerOAuthFlows.find((f) => f.provider === p.id)}
												result={providerOAuthResults[p.id]}
											/>
										)}

										{p.supportsApiKey && (
											<div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
												<span style={{ fontSize: 12.5, fontWeight: 600 }}>{t("apiKeyManagement")}</span>
												<div className="provider-keys">
													{pkeys.length === 0 && <div className="provider-key-empty">{t("noKeyYet")}</div>}
													{pkeys.map((k) => (
														<div className={`provider-key-item ${k.active ? "active" : ""}`} key={k.name}>
															<span className="provider-key-dot">{k.active ? "●" : "○"}</span>
															<span className="provider-key-label">{k.name}</span>
															{!k.active && (
																<button
																	type="button"
																	className="iconbtn"
																	title={t("activateKey")}
																	onClick={() => activateKey(p.id, k.name)}
																>
																	<FiCheck />
																</button>
															)}
															<button
																type="button"
																className="iconbtn danger"
																title={t("removeKey")}
																onClick={() => removeKey(p.id, k.name)}
															>
																<FiTrash2 />
															</button>
														</div>
													))}
												</div>

												<div className="provider-add-key" style={{ marginTop: 6 }}>
													<input
														type="text"
														className="key-input key-input-name"
														placeholder={t("keyNamePh")}
														value={addKeyNames[p.id] ?? ""}
														onChange={(e) => setAddKeyNames((k) => ({ ...k, [p.id]: e.target.value }))}
													/>
													<input
														type="password"
														className="key-input key-input-value"
														placeholder={t("addKeyPlaceholder")}
														value={addKeys[p.id] ?? ""}
														onChange={(e) => setAddKeys((k) => ({ ...k, [p.id]: e.target.value }))}
													/>
													<button
														type="button"
														className="btn primary sm"
														disabled={!(addKeys[p.id] ?? "").trim() || addKeyBusy === p.id}
														onClick={() => addKey(p)}
													>
														<FiPlus /> {addKeyBusy === p.id ? t("savingKey") : t("addKey")}
													</button>
												</div>
											</div>
										)}

										{appendingFor === p.id && (
											<div
												style={{
													marginTop: 12,
													padding: 12,
													background: "var(--bg)",
													borderRadius: 8,
													border: "1px dashed var(--border-soft)",
												}}
											>
												<span style={{ fontSize: 12, fontWeight: 600, display: "block", marginBottom: 8 }}>
													{t("addBuiltinOverlay")}
												</span>
												<div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
													<input
														type="text"
														className="key-input"
														placeholder={t("overlayModelIdPlaceholder")}
														value={appendId}
														onChange={(e) => setAppendId(e.target.value)}
													/>
													<input
														type="text"
														className="key-input"
														placeholder={t("overlayModelNamePlaceholder")}
														value={appendName}
														onChange={(e) => setAppendName(e.target.value)}
													/>
													<button
														type="button"
														className="btn primary sm"
														disabled={!appendId.trim() || appendBusy}
														onClick={() => submitAppend(p.id)}
													>
														<FiPlus /> {t("submitOverlayBtn")}
													</button>
												</div>
												{appendMsg && (
													<span
														style={{ fontSize: 12, color: appendMsg.ok ? "var(--green)" : "var(--red)", marginTop: 6 }}
													>
														{appendMsg.text}
													</span>
												)}
											</div>
										)}
									</div>
								);
							})()}
					</div>
				</div>

				{candidateList && (
					<CandidatePickerModal
						candidates={candidateList}
						preselectedIds={editing?.models.map((m) => m.id.trim()).filter(Boolean) ?? []}
						onAdopt={adoptSelectedModels}
						onClose={() => setCandidateList(null)}
					/>
				)}
			</div>
		</div>
	);
}
