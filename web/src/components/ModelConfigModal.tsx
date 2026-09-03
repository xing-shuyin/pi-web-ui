import { useEffect, useRef, useState } from "react";
import {
	FiCheck,
	FiCopy,
	FiDownload,
	FiEdit2,
	FiKey,
	FiPlus,
	FiRefreshCw,
	FiTrash2,
	FiX,
} from "react-icons/fi";
import type {
	ClientMessage,
	ProviderKeyInfo,
	ProviderStatus,
	UiModelConfigEntry,
	UiProviderConfig,
} from "../types";
import { useT } from "../i18n";

interface ModelConfigModalProps {
	send: (msg: ClientMessage) => boolean;
	/** Custom providers from agentDir/models.json. */
	providers: UiProviderConfig[];
	/** Built-in providers with auth status (key-only config). */
	providerStatus: ProviderStatus[];
	/** Stored API keys per built-in provider (masked). */
	providerKeys: Record<string, ProviderKeyInfo[]>;
	/** Last fetch_models probe result (matched by reqId, see useChat). */
	fetchModelsResult?: {
		reqId: number;
		ok: boolean;
		models?: UiModelConfigEntry[];
		error?: string;
	} | null;
	/** Last refresh_provider_models result (saved-provider list refresh). */
	refreshProviderResult?: {
		reqId: number;
		ok: boolean;
		added?: number;
		total?: number;
		error?: string;
	} | null;
	/** Last clone_provider result (built-in → custom draft). */
	cloneProviderResult?: {
		reqId: number;
		ok: boolean;
		config?: UiProviderConfig;
		configs?: UiProviderConfig[];
		error?: string;
	} | null;
	onClose: () => void;
}

const API_TYPES = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
];

interface DraftModel {
	id: string;
	name: string;
	reasoning: boolean;
	input: "text" | "text-image";
	contextWindow: string;
	maxTokens: string;
}

interface Draft {
	providerId: string;
	name: string;
	api: string;
	baseUrl: string;
	apiKey: string;
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
	authHeader: true,
	models: [emptyModel()],
});

function toDraft(p: UiProviderConfig): Draft {
	return {
		providerId: p.providerId,
		name: p.name ?? "",
		api: p.api ?? "openai-completions",
		baseUrl: p.baseUrl ?? "",
		apiKey: p.apiKey ?? "",
		authHeader: p.authHeader ?? false,
		models: (p.models.length ? p.models : [emptyModel()]).map((m) => ({
			id: m.id,
			name: m.name ?? "",
			reasoning: m.reasoning ?? false,
			input: m.input?.includes("image") ? "text-image" : "text",
			contextWindow: m.contextWindow ? String(m.contextWindow) : "",
			maxTokens: m.maxTokens ? String(m.maxTokens) : "",
		})),
	};
}

export function ModelConfigModal({
	send,
	providers,
	providerStatus,
	providerKeys,
	fetchModelsResult,
	refreshProviderResult,
	cloneProviderResult,
	onClose,
}: ModelConfigModalProps) {
	const t = useT();
	const [editing, setEditing] = useState<Draft | null>(null);
	/** Inline "add key" input per built-in provider (secondary key value). */
	const [addKeys, setAddKeys] = useState<Record<string, string>>({});
	const [addKeyNames, setAddKeyNames] = useState<Record<string, string>>({});
	const [addKeyBusy, setAddKeyBusy] = useState<string | null>(null);
	/** Auto-fetch of the /models endpoint: in-flight flag + monotonically
	 *  increasing reqId (echoed back by the server) + last result message. */
	const [fetching, setFetching] = useState(false);
	const [fetchReqId, setFetchReqId] = useState(0);
	const [fetchMsg, setFetchMsg] = useState<{ ok: boolean; text: string } | null>(null);
	const handledReq = useRef(0);
	/** Saved-provider list refresh: in-flight flags per providerId + reqId echo. */
	const [refreshing, setRefreshing] = useState<Record<string, boolean>>({});
	const refreshReqId = useRef(0);
	const handledRefreshReq = useRef(0);
	/** Clone built-in → custom draft: in-flight flag + reqId echo. */
	const [cloning, setCloning] = useState<string | null>(null);
	const [cloneMsg, setCloneMsg] = useState<{ ok: boolean; text: string } | null>(null);
	const cloneReqId = useRef(0);
	const handledCloneReq = useRef(0);
	/** Multi-api batch clone */
	const [batch, setBatch] = useState<Draft[] | null>(null);
	const [batchKey, setBatchKey] = useState("");
	const [addKeyDraft, setAddKeyDraft] = useState<Draft | null>(null);

	// Fresh config when the modal opens.
	useEffect(() => {
		send({ type: "list_models_config" });
		send({ type: "list_providers" });
		send({ type: "list_provider_keys" });
	}, [send]);

	/** Probe the custom provider's /models endpoint and merge the advertised
	 *  models into the draft: rows whose id already exists keep their settings
	 *  (blank fields get filled from the endpoint metadata); new ids are
	 *  appended with whatever metadata the endpoint provided (contextWindow /
	 *  vision input / reasoning / name / maxTokens). */
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
		const reqId = fetchReqId + 1;
		setFetchReqId(reqId);
		send({
			type: "fetch_models",
			reqId,
			baseUrl: base,
			apiKey: editing.apiKey.trim() || undefined,
			authHeader: editing.authHeader,
			api: editing.api,
		});
	};

	// Apply the server's fetch_models_result to the draft once per request.
	useEffect(() => {
		if (!fetchModelsResult || fetchModelsResult.reqId === handledReq.current) return;
		handledReq.current = fetchModelsResult.reqId;
		setFetching(false);
		if (fetchModelsResult.ok && fetchModelsResult.models?.length) {
			const fetched = fetchModelsResult.models;
			setEditing((prev) => {
				if (!prev) return prev;
				// Fill blank fields of rows whose id was fetched back (keeps any
				// user-typed values); append ids the endpoint knows but the form
				// doesn't yet.
				const rows = prev.models.map((m) => {
					if (!m.id.trim()) return m;
					const f = fetched.find((fm) => fm.id === m.id.trim());
					if (!f) return m;
					const next = { ...m };
					if (!next.name && f.name) next.name = f.name;
					if (!next.contextWindow && f.contextWindow)
						next.contextWindow = String(f.contextWindow);
					if (!next.maxTokens && f.maxTokens) next.maxTokens = String(f.maxTokens);
					if (next.input === "text" && f.input?.includes("image"))
						next.input = "text-image";
					if (!next.reasoning && f.reasoning) next.reasoning = true;
					return next;
				});
				const have = new Set(rows.map((m) => m.id.trim()).filter(Boolean));
				const extra: DraftModel[] = fetched
					.filter((fm) => !have.has(fm.id))
					.map((fm) => ({
						id: fm.id,
						name: fm.name ?? "",
						reasoning: fm.reasoning ?? false,
						input: fm.input?.includes("image") ? "text-image" : "text",
						contextWindow: fm.contextWindow ? String(fm.contextWindow) : "",
						maxTokens: fm.maxTokens ? String(fm.maxTokens) : "",
					}));
				const merged = [...rows, ...extra];
				// Drop leftover blank rows once real models exist (re-addable).
				return merged.some((m) => m.id.trim())
					? { ...prev, models: merged.filter((m) => m.id.trim()) }
					: prev;
			});
			setFetchMsg({ ok: true, text: t("fetchModelsOk", { n: fetched.length }) });
		} else {
			setFetchMsg({
				ok: false,
				text: fetchModelsResult.error || t("fetchModelsEmpty"),
			});
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [fetchModelsResult]);

	/** Add an API key to a built-in provider's key list (the first key added
	 *  becomes active; further ones stay inactive until a model under that key
	 *  is clicked in the picker). No model list is ever copied. */
	const addKey = (p: ProviderStatus) => {
		const key = (addKeys[p.id] ?? "").trim();
		if (!key || addKeyBusy) return;
		setAddKeyBusy(p.id);
		send({
			type: "add_provider_key",
			provider: p.id,
			apiKey: key,
			name: (addKeyNames[p.id] ?? "").trim() || undefined,
		});
		setTimeout(() => {
			setAddKeyBusy(null);
			setAddKeys((k) => ({ ...k, [p.id]: "" }));
			setAddKeyNames((n) => ({ ...n, [p.id]: "" }));
			send({ type: "list_providers" });
			send({ type: "list_provider_keys" });
		}, 1500);
	};

	/** Make a stored API key the ACTIVE one for a built-in provider, by NAME. */
	const activateKey = (providerId: string, keyName: string) => {
		send({ type: "activate_provider_key", provider: providerId, keyName });
		send({ type: "list_provider_keys" });
	};

	/** Remove a stored API key by NAME; if it was active, the first remaining key takes over. */
	const removeKey = (providerId: string, keyName: string) => {
		if (!window.confirm(t("removeKeyConfirm"))) return;
		send({ type: "remove_provider_key", provider: providerId, keyName });
		send({ type: "list_provider_keys" });
	};

	const saveAddKey = () => {
		if (!addKeyDraft) return;
		const pid = addKeyDraft.providerId.trim();
		if (!pid || !addKeyDraft.apiKey.trim()) return;
		const models: UiModelConfigEntry[] = addKeyDraft.models
			.filter((m) => m.id.trim())
			.map((m) => ({
				id: m.id.trim(),
				name: m.name.trim() || undefined,
				reasoning: m.reasoning || undefined,
				input: m.input === "text-image" ? ["text", "image"] : undefined,
				contextWindow: m.contextWindow ? Number(m.contextWindow) : undefined,
				maxTokens: m.maxTokens ? Number(m.maxTokens) : undefined,
			}));
		const config: UiProviderConfig = {
			providerId: pid,
			name: addKeyDraft.name.trim() || undefined,
			api: addKeyDraft.api.trim() || undefined,
			baseUrl: addKeyDraft.baseUrl.trim() || undefined,
			apiKey: addKeyDraft.apiKey.trim() || undefined,
			authHeader: addKeyDraft.authHeader || undefined,
			models,
		};
		send({ type: "save_model_config", providerId: pid, config });
		setAddKeyDraft(null);
		onClose();
	};

	const save = () => {
		if (!editing) return;
		const providerId = editing.providerId.trim();
		const models: UiModelConfigEntry[] = editing.models
			.filter((m) => m.id.trim())
			.map((m) => ({
				id: m.id.trim(),
				name: m.name.trim() || undefined,
				reasoning: m.reasoning || undefined,
				input: m.input === "text-image" ? ["text", "image"] : undefined,
				contextWindow: m.contextWindow ? Number(m.contextWindow) : undefined,
				maxTokens: m.maxTokens ? Number(m.maxTokens) : undefined,
			}));
		const config: UiProviderConfig = {
			providerId,
			name: editing.name.trim() || undefined,
			api: editing.api.trim() || undefined,
			baseUrl: editing.baseUrl.trim() || undefined,
			apiKey: editing.apiKey.trim() || undefined,
			authHeader: editing.authHeader || undefined,
			models,
		};
		send({ type: "save_model_config", providerId, config });
		onClose();
	};

	/** Re-fetch the SAVED provider's model list server-side (credentials stay
	 *  on the server) and merge into its models.json entry. */
	const refreshProvider = (providerId: string) => {
		if (refreshing[providerId]) return;
		const reqId = ++refreshReqId.current + Date.now();
		setRefreshing((m) => ({ ...m, [providerId]: true }));
		send({ type: "refresh_provider_models", providerId, reqId });
	};

	// Refresh results clear the per-provider spinner; the server also emits a
	// notice with the added/total counts.
	useEffect(() => {
		if (!refreshProviderResult || refreshProviderResult.reqId === handledRefreshReq.current)
			return;
		handledRefreshReq.current = refreshProviderResult.reqId;
		setRefreshing({});
	}, [refreshProviderResult]);

	/** Ask the server to copy a built-in provider (baseUrl + model catalog)
	 *  into an editable custom draft — lets a second API key coexist with the
	 *  built-in one. The result opens the edit form pre-filled. */
	const cloneBuiltin = (p: ProviderStatus) => {
		if (cloning) return;
		setCloning(p.id);
		setCloneMsg(null);
		const reqId = ++cloneReqId.current + Date.now();
		const ok = send({ type: "clone_provider", provider: p.id, reqId });
		if (!ok) {
			setCloning(null);
			setCloneMsg({ ok: false, text: t("netDisconnected") });
		}
	};

	// Apply the clone result once: open the edit form pre-filled (apiKey left
	// empty for the user's second key). Errors surface via server notice + inline.
	// 多 api 供应商返回 configs（按 api 拆分），单 api 仍走 config
	useEffect(() => {
		if (!cloneProviderResult || cloneProviderResult.reqId === handledCloneReq.current) return;
		handledCloneReq.current = cloneProviderResult.reqId;
		setCloning(null);
		if (cloneProviderResult.ok) {
			const cs = (cloneProviderResult as { configs?: UiProviderConfig[] }).configs;
			if (cs && cs.length > 1) {
				setBatch(cs.map((c) => toDraft({ ...c, apiKey: "" })));
				setBatchKey("");
				setCloneMsg(null);
				return;
			}
			if (cloneProviderResult.config) {
				setAddKeyDraft(toDraft({ ...cloneProviderResult.config, apiKey: "" }));
				setCloneMsg(null);
				return;
			}
		}
		if (cloneProviderResult.error) {
			setCloneMsg({ ok: false, text: cloneProviderResult.error });
		}
	}, [cloneProviderResult]);

	/** Clear a built-in provider's STORED key (source "stored") — the provider
	 *  returns to unconfigured and its models leave the picker. */
	const clearBuiltinKey = (id: string) => {
		if (window.confirm(t("clearKeyConfirm", { id }))) {
			send({ type: "clear_provider_api_key", provider: id });
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
			send({ type: "delete_model_config", providerId: p.providerId });
		}
	};

	const setModel = (i: number, patch: Partial<DraftModel>) => {
		if (!editing) return;
		setEditing({
			...editing,
			models: editing.models.map((m, j) => (j === i ? { ...m, ...patch } : m)),
		});
	};

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal model-modal" onClick={(e) => e.stopPropagation()}>
				<button
					type="button"
					className="modal-close"
					aria-label={t("close")}
					onClick={onClose}
				>
					<FiX />
				</button>
				<div className="modal-head">
					<h2>
						{addKeyDraft
							? t("addKey")
							: batch
								? t("batchCreateProviders", { n: batch.length })
								: editing
									? t("editProvider")
									: t("manageModelsTitle")}
					</h2>
				</div>

				{addKeyDraft ? (
					<>
						<div className="model-modal-body">
							<div className="provider-form">
								<p className="modal-desc" style={{ marginBottom: 12 }}>
									{t("secondKeyTitle", { api: addKeyDraft.api, baseUrl: addKeyDraft.baseUrl || t("noBaseUrlShort"), n: addKeyDraft.models.length })}
								</p>
								<div className="form-grid">
									<label className="field">
										<span className="field-label">{t("providerNameLabel")} <em>{t("providerNameHint")}</em></span>
										<input type="text" value={addKeyDraft.providerId} onChange={(e) => setAddKeyDraft({ ...addKeyDraft, providerId: e.target.value })} placeholder="opencode-2" />
									</label>
									<label className="field">
										<span className="field-label">{t("apiKeyLabel")}</span>
										<input type="password" value={addKeyDraft.apiKey} onChange={(e) => setAddKeyDraft({ ...addKeyDraft, apiKey: e.target.value })} placeholder={t("secondKeyPlaceholder")} />
									</label>
								</div>
								<div style={{ fontSize: 12, opacity: 0.6, marginTop: 8 }}>
									{addKeyDraft.models.slice(0, 5).map((m) => m.id).join(", ")}{addKeyDraft.models.length > 5 ? ` … +${addKeyDraft.models.length - 5}` : ""}
								</div>
							</div>
						</div>
						<div className="modal-actions">
							<button type="button" className="btn" onClick={() => setAddKeyDraft(null)}>
								{t("cancel")}
							</button>
							<button type="button" className="btn" onClick={() => { const d = addKeyDraft; setAddKeyDraft(null); setEditing(d); }}>
								{t("advancedEdit")}
							</button>
							<button type="button" className="btn primary" disabled={!addKeyDraft.providerId.trim() || !addKeyDraft.apiKey.trim()} onClick={saveAddKey}>
								{t("save")}
							</button>
						</div>
					</>
				) : batch ? (
					<>
						<div className="model-modal-body">
							<div className="provider-form">
								<p className="modal-desc" style={{ marginBottom: 12 }}>
									{t("batchDesc", { apis: batch.map((b) => b.api).join("、"), n: batch.length })}
								</p>
								<label className="field" style={{ marginBottom: 16 }}>
									<span className="field-label">{t("batchKeyLabel", { n: batch.length })}</span>
									<input type="password" value={batchKey} onChange={(e) => setBatchKey(e.target.value)} placeholder={t("secondKeyPlaceholder")} />
								</label>
								<div className="provider-list" style={{ marginBottom: 16 }}>
									{batch.map((d, idx) => (
										<div className="provider-row" key={idx} style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
											<div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
												<strong>{d.providerId}</strong>
												<span style={{ opacity: 0.7 }}>{d.api}</span>
											</div>
											<div className="provider-sub" style={{ fontSize: 12, opacity: 0.7 }}>
												{d.baseUrl || t("noBaseUrlShort")} · {t("modelsCountShort", { n: d.models.length })}{d.models.slice(0, 3).map((m) => m.id).join(", ")}{d.models.length > 3 ? ` … +${d.models.length - 3}` : ""}
											</div>
											<input
												type="text"
												value={d.providerId}
												onChange={(e) => setBatch((prev) => prev!.map((x, i) => (i === idx ? { ...x, providerId: e.target.value } : x)))}
												placeholder={t("providerIdPlaceholder")}
												style={{ fontSize: 12 }}
											/>
											<input
												type="text"
												value={d.baseUrl}
												onChange={(e) => setBatch((prev) => prev!.map((x, i) => (i === idx ? { ...x, baseUrl: e.target.value } : x)))}
												placeholder={t("baseUrlExamplePh")}
												style={{ fontSize: 12 }}
											/>
										</div>
									))}
								</div>
							</div>
						</div>
						<div className="modal-actions">
							<button type="button" className="btn" onClick={() => setBatch(null)}>
								{t("cancel")}
							</button>
							<button
								type="button"
								className="btn primary"
								disabled={!batchKey.trim()}
								onClick={() => {
									for (const d of batch) {
										const pid = d.providerId.trim();
										if (!pid) continue;
										const models: UiModelConfigEntry[] = d.models
											.filter((m) => m.id.trim())
											.map((m) => ({
												id: m.id.trim(),
												name: m.name.trim() || undefined,
												reasoning: m.reasoning || undefined,
												input: m.input === "text-image" ? ["text", "image"] : undefined,
												contextWindow: m.contextWindow ? Number(m.contextWindow) : undefined,
												maxTokens: m.maxTokens ? Number(m.maxTokens) : undefined,
											}));
										const config: UiProviderConfig = {
											providerId: pid,
											name: d.name.trim() || undefined,
											api: d.api.trim() || undefined,
											baseUrl: d.baseUrl.trim() || undefined,
											apiKey: batchKey.trim() || undefined,
											authHeader: d.authHeader || undefined,
											models,
										};
										send({ type: "save_model_config", providerId: pid, config });
									}
									setBatch(null);
									onClose();
								}}
							>
								{t("saveAllBatch", { n: batch.length })}
							</button>
						</div>
					</>
				) : !editing ? (
					<>
						<div className="model-modal-fixed-hint">
							<div className="form-section-title">
								{t("builtinProviders")}{" "}
								<em className="section-hint">{t("hintKeyOnly")}</em>
							</div>
						</div>
						<div className="model-modal-body">
							<div className="provider-list">
							{providerStatus.length === 0 && (
								<div className="dd-loading">{t("loading")}</div>
							)}
							{providerStatus.map((p) => {
								const pkeys = providerKeys[p.id] ?? [];
								return (
									<div className="provider-row provider-key-row" key={p.id}>
										<div className="provider-key-head">
											<div className="provider-info">
												<span className="provider-name">{p.name}</span>
												<span className="provider-sub">
													{p.id}
													{p.configured && (
														<span className="auth-badge">
															{t("configuredBadge")}
														</span>
													)}
													{p.source && !p.configured && (
														<span className="auth-badge dim">{p.source}</span>
													)}
												</span>
											</div>
											{p.source === "stored" && (
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
										<div className="provider-keys">
											{pkeys.length === 0 && (
												<div className="provider-key-empty">{t("noKeyYet")}</div>
											)}
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
											<div className="provider-add-key">
												<input
													type="text"
													className="key-input key-input-name"
													placeholder={t("keyNamePh")}
													value={addKeyNames[p.id] ?? ""}
													onChange={(e) =>
														setAddKeyNames((k) => ({ ...k, [p.id]: e.target.value }))
													}
												/>
												<input
													type="password"
													className="key-input key-input-value"
													placeholder={t("addKeyPlaceholder")}
													value={addKeys[p.id] ?? ""}
													onChange={(e) =>
														setAddKeys((k) => ({ ...k, [p.id]: e.target.value }))
													}
												/>
												<button
													type="button"
													className="btn primary sm"
													disabled={!(addKeys[p.id] ?? "").trim() || addKeyBusy === p.id}
													onClick={() => addKey(p)}
												>
													<FiPlus />{" "}
													{addKeyBusy === p.id ? t("savingKey") : t("addKey")}
												</button>
											</div>
										</div>
									</div>
								);
							})}
						</div>

						<div className="form-section-title">{t("customProviders")}</div>
						<p className="modal-desc">{t("customDesc")}</p>
						{providers.length === 0 && (
							<div className="dd-loading">{t("noCustomProviders")}</div>
						)}
						<div className="provider-list">
							{providers.map((p) => (
								<div className="provider-row" key={p.providerId}>
									<div className="provider-info">
										<span className="provider-name">{p.providerId}</span>
										<span className="provider-sub">
											{p.api ?? "—"}
											{p.baseUrl ? ` · ${p.baseUrl}` : ""}
											{p.models.length > 0 &&
												` · ${t("modelsCount", { n: p.models.length })}`}
										</span>
									</div>
									<div className="provider-actions">
										<button
											type="button"
											className="iconbtn"
											title={t("edit")}
											onClick={() => setEditing(toDraft(p))}
										>
											<FiEdit2 />
										</button>
										<button
											type="button"
											className="iconbtn danger"
											title={t("delete")}
											onClick={() => removeProvider(p)}
										>
											<FiTrash2 />
										</button>
									</div>
								</div>
							))}
						</div>
						</div>
						<div className="modal-actions">
							<button
								type="button"
								className="btn primary"
								onClick={() => setEditing(emptyDraft())}
							>
								<FiPlus /> {t("addProvider")}
							</button>
						</div>
					</>
				) : (
					<>
						<div className="model-modal-body">
							<div className="provider-form">
						<div className="form-grid">
							<label className="field">
								<span className="field-label">
									{t("providerId")} <em>{t("providerIdHint")}</em>
								</span>
								<input
									type="text"
									value={editing.providerId}
									disabled={providers.some(
										(p) => p.providerId === editing.providerId,
									)}
									onChange={(e) =>
										setEditing({ ...editing, providerId: e.target.value })
									}
									placeholder="my-proxy"
								/>
							</label>
							<label className="field">
								<span className="field-label">{t("displayName")}</span>
								<input
									type="text"
									value={editing.name}
									onChange={(e) =>
										setEditing({ ...editing, name: e.target.value })
									}
									placeholder={t("displayNamePh")}
								/>
							</label>
							<label className="field">
								<span className="field-label">{t("apiType")}</span>
								<select
									value={editing.api}
									onChange={(e) =>
										setEditing({ ...editing, api: e.target.value })
									}
								>
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
									onChange={(e) =>
										setEditing({ ...editing, baseUrl: e.target.value })
									}
									placeholder="http://localhost:11434/v1"
								/>
							</label>
							<label className="field">
								<span className="field-label">{t("apiKey")}</span>
								<input
									type="password"
									value={editing.apiKey}
									onChange={(e) =>
										setEditing({ ...editing, apiKey: e.target.value })
									}
									placeholder={t("apiKeyHint")}
								/>
							</label>
							<label className="field check">
								<input
									type="checkbox"
									checked={editing.authHeader}
									onChange={(e) =>
										setEditing({ ...editing, authHeader: e.target.checked })
									}
								/>
								<span>{t("authHeader")}</span>
							</label>
						</div>

						<div className="model-section-head">
							<span className="form-section-title">{t("modelsTitle")}</span>
							<span className="model-section-actions">
								{fetchMsg && (
									<span
										className={`fetch-msg ${fetchMsg.ok ? "ok" : "err"}`}
										title={fetchMsg.text}
									>
										{fetchMsg.text}
									</span>
								)}
								<button
									type="button"
									className="btn sm"
									disabled={fetching || !editing.baseUrl.trim()}
									title={t("fetchModelsHint")}
									onClick={fetchModels}
								>
									<FiDownload />{" "}
									{fetching ? t("fetchingModels") : t("fetchModels")}
								</button>
							</span>
						</div>
						{editing.models.map((m, i) => (
							<div className="model-row" key={i}>
								<input
									type="text"
									value={m.id}
									onChange={(e) => setModel(i, { id: e.target.value })}
									placeholder={t("modelIdReq")}
								/>
								<input
									type="text"
									value={m.name}
									onChange={(e) => setModel(i, { name: e.target.value })}
									placeholder={t("displayName")}
								/>
								<select
									value={m.input}
									onChange={(e) =>
										setModel(i, {
											input: e.target.value as DraftModel["input"],
										})
									}
								>
									<option value="text">{t("text")}</option>
									<option value="text-image">{t("textImage")}</option>
								</select>
								<label className="check">
									<input
										type="checkbox"
										checked={m.reasoning}
										onChange={(e) =>
											setModel(i, { reasoning: e.target.checked })
										}
									/>
									<span>{t("reasoning")}</span>
								</label>
								<input
									type="number"
									value={m.contextWindow}
									onChange={(e) =>
										setModel(i, { contextWindow: e.target.value })
									}
									placeholder={t("contextWindow")}
									title="contextWindow"
								/>
								<input
									type="number"
									value={m.maxTokens}
									onChange={(e) => setModel(i, { maxTokens: e.target.value })}
									placeholder={t("maxOutput")}
									title="maxTokens"
								/>
								<button
									type="button"
									className="iconbtn danger"
									title={t("removeModel")}
									onClick={() =>
										setEditing({
											...editing,
											models: editing.models.filter((_, j) => j !== i),
										})
									}
								>
									<FiTrash2 />
								</button>
							</div>
						))}
						<button
							type="button"
							className="btn"
							onClick={() =>
								setEditing({
									...editing,
									models: [...editing.models, emptyModel()],
								})
							}
						>
							<FiPlus /> {t("addModel")}
						</button>
						</div>
					</div>
						<div className="modal-actions">
							<button
								type="button"
								className="btn"
								onClick={() => setEditing(null)}
							>
								{t("cancel")}
							</button>
							<button
								type="button"
								className="btn primary"
								disabled={
									!editing.providerId.trim() ||
									!editing.models.some((m) => m.id.trim())
								}
								onClick={save}
							>
								{t("save")}
							</button>
						</div>
					</>
				)}
			</div>
		</div>
	);
}
