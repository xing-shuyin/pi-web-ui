import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { apiFetch } from "../api-client";
import { useT } from "../i18n";
import { useEscapeKey } from "../shortcut-stack";
import type { ModelInfo } from "../types";
import { resolveBotCwd } from "../local-bot-path";
import { UniversalPathPicker } from "./UniversalPathPicker";
import { UniversalModelPicker } from "./UniversalModelPicker";
import { LocalBotCatalogPicker, type BotCatalogEntry } from "./LocalBotCatalogPicker";

export interface BotFormData {
	name: string;
	description: string;
	systemPrompt: string;
	cwd: string;
	model?: { provider: string; modelId: string };
	tools: string[];
	skills: string[];
	mcpServers: string[];
}

export interface BotOptions {
	cwd: string;
	defaultCwd: string;
	defaultModel?: string;
	defaultTools?: string[];
	models: ModelInfo[];
	tools: BotCatalogEntry[];
	skills: BotCatalogEntry[];
	mcpServers: BotCatalogEntry[];
	projects: { path: string }[];
}

const modelIdOf = (model: ModelInfo) =>
	model.id.startsWith(`${model.provider}/`) ? model.id.slice(model.provider.length + 1) : model.id;

export function useBotOptions(enabled: boolean) {
	const [options, setOptions] = useState<BotOptions | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");
	const [reloadSeq, setReloadSeq] = useState(0);

	useEffect(() => {
		if (!enabled) return;
		const controller = new AbortController();
		setLoading(true);
		setError("");
		void apiFetch("/api/device-center/local-bot-options", {
			method: "GET",
			credentials: "same-origin",
			signal: controller.signal,
		})
			.then(async (res) => {
				const data = await res.json();
				if (!res.ok) throw new Error(data.error || String(res.status));
				return data as BotOptions;
			})
			.then((data) => {
				if (controller.signal.aborted) return;
				setOptions(data);
				setLoading(false);
			})
			.catch((cause) => {
				if (controller.signal.aborted) return;
				setError(cause instanceof Error ? cause.message : String(cause));
				setLoading(false);
			});
		return () => controller.abort();
	}, [enabled, reloadSeq]);

	const reload = useCallback(() => setReloadSeq((v) => v + 1), []);
	return { options, loading, error, reload };
}

export function BotEditorForm({
	value,
	onChange,
	options,
	optionsLoading,
	optionsError,
	onReloadOptions,
	busy = false,
	baseCwd = "",
	variant = "dialog",
	modelPortalTarget,
	modelOpen: controlledModelOpen,
	onModelOpenChange,
}: {
	value: BotFormData;
	onChange: (next: BotFormData) => void;
	options: BotOptions | null;
	optionsLoading: boolean;
	optionsError: string;
	onReloadOptions: () => void;
	busy?: boolean;
	baseCwd?: string;
	variant?: "dialog" | "inline";
	modelPortalTarget?: HTMLElement | null;
	modelOpen?: boolean;
	onModelOpenChange?: (open: boolean) => void;
}) {
	const t = useT();
	const uid = useId();
	const [tab, setTab] = useState<"identity" | "runtime" | "permissions">("identity");
	const [catalogTab, setCatalogTab] = useState<"tools" | "skills" | "mcpServers">("tools");
	const [internalModelOpen, setInternalModelOpen] = useState(false);
	const modelOpen = controlledModelOpen ?? internalModelOpen;
	const setModelOpen = useCallback(
		(next: boolean) => {
			if (onModelOpenChange) onModelOpenChange(next);
			else setInternalModelOpen(next);
		},
		[onModelOpenChange],
	);
	const cwdRef = useRef(baseCwd || value.cwd);
	if (baseCwd) cwdRef.current = baseCwd;

	useEscapeKey(() => setModelOpen(false), modelOpen);

	const chosenModel = options?.models.find(
		(model) => model.provider === value.model?.provider && modelIdOf(model) === value.model?.modelId,
	);
	const isInline = variant === "inline";
	const prefix = isInline ? uid : "bot";
	const cwdId = isInline ? `${uid}-cwd` : "local-bot-cwd";
	const promptRows = isInline ? 5 : 9;

	return (
		<div className={`bot-form${isInline ? " is-inline" : ""}`}>
			<div className={isInline ? "bot-form-tabs" : "dc-bot-tabs"} role="tablist" aria-label={t("localBotTitle")}>
				{(
					[
						["identity", t("localBotIdentity")],
						["runtime", t("localBotRuntime")],
						["permissions", t("localBotPermissions")],
					] as const
				).map(([key, label], index, tabs) => (
					<button
						key={key}
						type="button"
						role="tab"
						id={`${prefix}-tab-${key}`}
						aria-controls={`${prefix}-panel-${key}`}
						aria-selected={tab === key}
						tabIndex={tab === key ? 0 : -1}
						onClick={() => setTab(key)}
						onKeyDown={(event) => {
							let next = index;
							if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
							else if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
							else if (event.key === "Home") next = 0;
							else if (event.key === "End") next = tabs.length - 1;
							else return;
							event.preventDefault();
							setTab(tabs[next][0]);
							document.getElementById(`${prefix}-tab-${tabs[next][0]}`)?.focus();
						}}
					>
						{label}
					</button>
				))}
			</div>

			<div className={isInline ? "bot-form-body" : undefined}>
				<div
					role="tabpanel"
					id={`${prefix}-panel-identity`}
					aria-labelledby={`${prefix}-tab-identity`}
					hidden={tab !== "identity"}
				>
					{!isInline && <p className="dc-bot-section-intro">{t("localBotIdentityHint")}</p>}
					<div className={isInline ? "bot-form-stack" : "dc-bot-section"}>
						<label className={isInline ? "bot-form-field" : "dc-field"}>
							<span>{t("localBotName")}</span>
							<input
								required
								disabled={busy}
								value={value.name}
								onChange={(e) => onChange({ ...value, name: e.target.value })}
							/>
						</label>
						<label className={isInline ? "bot-form-field" : "dc-field"}>
							<span>{t("localBotDescription")}</span>
							<textarea
								rows={2}
								disabled={busy}
								value={value.description}
								onChange={(e) => onChange({ ...value, description: e.target.value })}
							/>
						</label>
						<label className={isInline ? "bot-form-field" : "dc-field"}>
							<span>{t("localBotSystemPrompt")}</span>
							<textarea
								rows={promptRows}
								className={isInline ? "bot-form-prompt" : "dc-bot-prompt"}
								spellCheck={false}
								disabled={busy}
								value={value.systemPrompt}
								onChange={(e) => onChange({ ...value, systemPrompt: e.target.value })}
							/>
						</label>
					</div>
					{!isInline && <p className="dc-bot-local-note">{t("localBotPrivatePrompt")}</p>}
				</div>

				<div
					role="tabpanel"
					id={`${prefix}-panel-runtime`}
					aria-labelledby={`${prefix}-tab-runtime`}
					hidden={tab !== "runtime"}
				>
					{!isInline && <p className="dc-bot-section-intro">{t("localBotRuntimeHint")}</p>}
					<div className={isInline ? "bot-form-stack" : "dc-bot-section"}>
						<div className={isInline ? "bot-form-field" : "dc-field"}>
							<label htmlFor={cwdId}>{t("localBotCwd")}</label>
							<UniversalPathPicker
								inputId={cwdId}
								commitOnBlur
								cwd={value.cwd}
								baseCwd={cwdRef.current || value.cwd}
								projects={options?.projects.map((project) => ({ ...project, lastUsed: 0 })) ?? []}
								disabled={busy}
								onSelectCwd={(nextCwd) =>
									onChange({ ...value, cwd: resolveBotCwd(nextCwd, cwdRef.current || value.cwd) })
								}
							/>
						</div>
						<div className={isInline ? "bot-form-field" : "dc-field"}>
							<span>{t("localBotModel")}</span>
							<div className="dc-actions">
								<button
									className="dc-button"
									type="button"
									disabled={busy}
									aria-haspopup="dialog"
									onClick={() => setModelOpen(true)}
								>
									{value.model
										? (chosenModel?.name ?? `${value.model.provider}/${value.model.modelId}`)
										: t("localBotInheritModel")}
								</button>
								{value.model && (
									<button
										className="dc-button"
										type="button"
										disabled={busy}
										onClick={() => onChange({ ...value, model: undefined })}
									>
										{t("localBotInheritModel")}
									</button>
								)}
							</div>
							{value.model && !chosenModel && (
								<small>{optionsLoading ? t("localBotUnverified") : t("localBotUnavailable")}</small>
							)}
						</div>
					</div>
				</div>

				<div
					role="tabpanel"
					id={`${prefix}-panel-permissions`}
					aria-labelledby={`${prefix}-tab-permissions`}
					hidden={tab !== "permissions"}
				>
					{!isInline && <p className="dc-bot-section-intro">{t("localBotPermissionsHint")}</p>}
					<div className="dc-bot-options-status" aria-live="polite">
						{optionsLoading && <span>{t("localBotOptionsLoading")}</span>}
						{optionsError && <span role="alert">{optionsError}</span>}
						<button className="dc-button" type="button" disabled={optionsLoading || busy} onClick={onReloadOptions}>
							{optionsError ? t("deviceHubRetry") : t("localBotReload")}
						</button>
					</div>
					<div className="dc-bot-catalog-tabs" role="tablist" aria-label={t("localBotPermissions")}>
						{(
							[
								["tools", t("localBotTools")],
								["skills", t("localBotSkills")],
								["mcpServers", t("localBotMcpServers")],
							] as const
						).map(([key, title]) => (
							<button
								key={key}
								type="button"
								role="tab"
								id={`${uid}-catalog-tab-${key}`}
								aria-controls={`${uid}-catalog-${key}`}
								aria-selected={catalogTab === key}
								onClick={() => setCatalogTab(key)}
							>
								{title}
								<span>{value[key].length}</span>
							</button>
						))}
					</div>
					<div className="dc-bot-permissions">
						{(
							[
								["tools", t("localBotTools")],
								["skills", t("localBotSkills")],
								["mcpServers", t("localBotMcpServers")],
							] as const
						).map(([key, title]) => (
							<div
								key={key}
								role="tabpanel"
								id={`${uid}-catalog-${key}`}
								aria-labelledby={`${uid}-catalog-tab-${key}`}
								hidden={catalogTab !== key}
							>
								<LocalBotCatalogPicker
									title={title}
									entries={options?.[key] ?? []}
									selected={value[key]}
									disabled={busy}
									pending={optionsLoading || !!optionsError}
									onChange={(ids) => onChange({ ...value, [key]: ids })}
								/>
							</div>
						))}
					</div>
				</div>
			</div>

			{modelOpen &&
				createPortal(
					<div
						className="modal-backdrop dc-bot-model-backdrop"
						onClick={(event) => {
							if (event.target === event.currentTarget) setModelOpen(false);
						}}
					>
						<div
							className="dc-bot-model-modal dd-menu-model"
							role="dialog"
							aria-modal="true"
							aria-label={t("localBotModel")}
						>
							<div className="dg-heading">
								<h3>{t("localBotModel")}</h3>
								<button type="button" className="dc-button" onClick={() => setModelOpen(false)}>
									{t("localBotCancel")}
								</button>
							</div>
							<UniversalModelPicker
								models={options?.models ?? []}
								modelsLoading={optionsLoading}
								defaultModel={options?.defaultModel}
								currentModelId={value.model ? `${value.model.provider}/${value.model.modelId}` : null}
								active
								onEnsureModels={() => {}}
								onRefresh={onReloadOptions}
								onPickModel={(model) => {
									onChange({ ...value, model: { provider: model.provider, modelId: modelIdOf(model) } });
									setModelOpen(false);
								}}
								isRowActive={(model) =>
									model.provider === value.model?.provider && modelIdOf(model) === value.model.modelId
								}
								extraTopRow={
									<button
										type="button"
										className="dc-button"
										onClick={() => {
											onChange({ ...value, model: undefined });
											setModelOpen(false);
										}}
									>
										{t("localBotInheritModel")}
									</button>
								}
								autoFocusSearch
								hideTitle
								bodyStyle={{ flex: 1, minHeight: 0 }}
								scrollStyle={{ overflowY: "auto", minHeight: 0 }}
							/>
							{optionsError && <p role="alert">{optionsError}</p>}
						</div>
					</div>,
					modelPortalTarget ?? document.body,
				)}
		</div>
	);
}
