import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { apiFetch, requestJson } from "../api-client";
import { useT } from "../i18n";
import { useEscapeKey } from "../shortcut-stack";
import type { ModelInfo } from "../types";
import { resolveBotCwd } from "../local-bot-path";
import { UniversalPathPicker } from "./UniversalPathPicker";
import { UniversalModelPicker } from "./UniversalModelPicker";
import { LocalBotCatalogPicker, type BotCatalogEntry } from "./LocalBotCatalogPicker";

export interface BotFormData {
	id?: string;
	name: string;
	description: string;
	systemPrompt: string;
	useGlobalPrompt?: boolean;
	promptSections?: string[];
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

const BOT_PROMPT_SECTION_ORDER = [
	"soul",
	"context",
	"tools",
	"markers",
	"skills",
	"cwd",
	"append",
	"plugin_dev",
	"execution",
	"memory",
] as const;

const GLOBAL_PROMPT_SECTIONS = new Set(["soul", "context", "markers", "append", "plugin_dev"]);
const DEFAULT_WITH_GLOBAL = ["soul", "context", "tools", "skills", "cwd", "append", "execution", "memory"];
const DEFAULT_WITHOUT_GLOBAL = ["tools", "skills", "cwd", "memory"];

interface BotPromptPreviewData {
	full: string;
	sections: { id: string; enabled: boolean; text: string; tokens: number }[];
	selectedSections: string[];
	totalTokens: number;
}

function effectiveSelectedSections(value: Pick<BotFormData, "promptSections" | "useGlobalPrompt">): string[] {
	if (Array.isArray(value.promptSections)) return value.promptSections;
	return value.useGlobalPrompt === false ? [...DEFAULT_WITHOUT_GLOBAL] : [...DEFAULT_WITH_GLOBAL];
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
	dialogChrome,
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
	dialogChrome?: {
		railHeader: ReactNode;
		railFooter: ReactNode;
		closeButton: ReactNode;
		errorBanner?: ReactNode;
		footer: ReactNode;
	};
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

	const [promptPreview, setPromptPreview] = useState<BotPromptPreviewData | null>(null);
	const [previewLoading, setPreviewLoading] = useState(false);
	const [previewError, setPreviewError] = useState("");
	const [copiedPrompt, setCopiedPrompt] = useState(false);
	const selectedSections = effectiveSelectedSections(value);

	useEffect(() => {
		if (tab !== "identity") return;
		const controller = new AbortController();
		const timer = setTimeout(() => {
			setPreviewLoading(true);
			setPreviewError("");
			void requestJson<BotPromptPreviewData>("/api/device-center/local-bot-prompt-preview", {
				body: {
					id: value.id,
					systemPrompt: value.systemPrompt,
					cwd: value.cwd,
					tools: value.tools,
					skills: value.skills,
					promptSections: value.promptSections,
					useGlobalPrompt: value.useGlobalPrompt,
				},
				signal: controller.signal,
			})
				.then((data) => {
					if (controller.signal.aborted) return;
					setPromptPreview(data);
					setPreviewLoading(false);
				})
				.catch((cause) => {
					if (controller.signal.aborted) return;
					setPreviewError(cause instanceof Error ? cause.message : String(cause));
					setPreviewLoading(false);
				});
		}, 220);
		return () => {
			clearTimeout(timer);
			controller.abort();
		};
	}, [
		tab,
		value.id,
		value.systemPrompt,
		value.cwd,
		value.tools,
		value.skills,
		value.promptSections,
		value.useGlobalPrompt,
	]);

	const updateSections = useCallback(
		(nextSections: string[]) => {
			const hasGlobal = nextSections.some((id) => GLOBAL_PROMPT_SECTIONS.has(id));
			onChange({
				...value,
				promptSections: nextSections,
				useGlobalPrompt: hasGlobal,
			});
		},
		[onChange, value],
	);

	useEscapeKey(() => setModelOpen(false), modelOpen);

	const chosenModel = options?.models.find(
		(model) => model.provider === value.model?.provider && modelIdOf(model) === value.model?.modelId,
	);
	const isInline = variant === "inline";
	const useSideRail = !isInline && Boolean(dialogChrome);
	const prefix = isInline ? uid : "bot";
	const cwdId = isInline ? `${uid}-cwd` : "local-bot-cwd";
	const promptRows = isInline ? 5 : 3;

	const tabItems = [
		["identity", t("localBotIdentity"), undefined],
		["runtime", t("localBotRuntime"), undefined],
		["permissions", t("localBotPermissions"), value.tools.length + value.skills.length + value.mcpServers.length],
	] as const;

	const tabListEl = (
		<div
			className={useSideRail ? "dc-bot-b-nav" : isInline ? "bot-form-tabs" : "dc-bot-tabs"}
			role="tablist"
			aria-label={t("localBotTitle")}
		>
			{tabItems.map(([key, label, count], index, tabs) => (
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
						if (event.key === "ArrowRight" || (useSideRail && event.key === "ArrowDown"))
							next = (index + 1) % tabs.length;
						else if (event.key === "ArrowLeft" || (useSideRail && event.key === "ArrowUp"))
							next = (index + tabs.length - 1) % tabs.length;
						else if (event.key === "Home") next = 0;
						else if (event.key === "End") next = tabs.length - 1;
						else return;
						event.preventDefault();
						setTab(tabs[next][0]);
						document.getElementById(`${prefix}-tab-${tabs[next][0]}`)?.focus();
					}}
				>
					<span>{label}</span>
					{count !== undefined && count > 0 && <span style={{ fontSize: "11px", opacity: 0.65 }}>{count}</span>}
				</button>
			))}
		</div>
	);

	const activeTabTitle = tabItems.find(([key]) => key === tab)?.[1] ?? t("localBotIdentity");

	const tabPanelsEl = (
		<div className={isInline ? "bot-form-body" : undefined}>
			<div
				role="tabpanel"
				id={`${prefix}-panel-identity`}
				aria-labelledby={`${prefix}-tab-identity`}
				hidden={tab !== "identity"}
			>
				<div className={isInline ? "bot-form-stack" : "dc-bot-section"} style={!isInline ? { gap: "12px" } : undefined}>
					<div className={!isInline ? "dc-bot-row-2" : undefined}>
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
								rows={isInline ? 2 : 1}
								disabled={busy}
								value={value.description}
								onChange={(e) => onChange({ ...value, description: e.target.value })}
								style={!isInline ? { minHeight: "36px", resize: "none" } : undefined}
							/>
						</label>
					</div>
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
					<div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
						<div
							style={{
								display: "flex",
								alignItems: "center",
								justifyContent: "space-between",
								gap: "8px",
								flexWrap: "wrap",
							}}
						>
							<span style={{ fontSize: "12px", fontWeight: 500, color: "var(--text-dim)" }}>
								{t("localBotPromptComposition")}
							</span>
							<div style={{ display: "inline-flex", gap: "4px", flexWrap: "wrap" }}>
								<button
									type="button"
									className="dc-button"
									style={{ padding: "3px 8px", fontSize: "11px" }}
									disabled={busy}
									onClick={() => updateSections([...BOT_PROMPT_SECTION_ORDER])}
								>
									{t("localBotSelectAll")}
								</button>
								<button
									type="button"
									className="dc-button"
									style={{ padding: "3px 8px", fontSize: "11px" }}
									disabled={busy}
									onClick={() => updateSections([])}
								>
									{t("localBotPromptPureOnly")}
								</button>
								<button
									type="button"
									className="dc-button"
									style={{ padding: "3px 8px", fontSize: "11px" }}
									disabled={busy}
									onClick={() => updateSections([...DEFAULT_WITH_GLOBAL])}
								>
									{t("localBotPromptResetDefault")}
								</button>
							</div>
						</div>
						<div className="dc-bot-chips">
							{BOT_PROMPT_SECTION_ORDER.map((sectionId) => {
								const checked = selectedSections.includes(sectionId);
								const info = promptPreview?.sections.find((s) => s.id === sectionId);
								const labelKey = `promptTok_${sectionId}`;
								const descKey = `promptTok_${sectionId}_desc`;
								return (
									<label
										key={sectionId}
										className={`dc-bot-chip${checked ? " is-on" : ""}`}
										title={t(descKey as never)}
									>
										<input
											type="checkbox"
											disabled={busy}
											checked={checked}
											onChange={(e) => {
												const next = e.target.checked
													? [...selectedSections, sectionId]
													: selectedSections.filter((s) => s !== sectionId);
												updateSections(next);
											}}
										/>
										<span>{t(labelKey as never)}</span>
										{info && <span className="tok dc-bot-chip-tok">{info.tokens}</span>}
									</label>
								);
							})}
						</div>
					</div>
					<div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
						<div
							style={{
								display: "flex",
								alignItems: "center",
								justifyContent: "space-between",
								gap: "8px",
							}}
						>
							<span style={{ fontSize: "12px", fontWeight: 500, color: "var(--text-dim)" }}>
								{t("localBotPromptFullPreview")}
								{promptPreview ? ` (≈${promptPreview.totalTokens} tokens)` : ""}
							</span>
							<button
								type="button"
								className="dc-button"
								style={{ padding: "3px 8px", fontSize: "11px" }}
								disabled={!promptPreview?.full}
								onClick={() => {
									if (!promptPreview?.full) return;
									void navigator.clipboard?.writeText(promptPreview.full).then(() => {
										setCopiedPrompt(true);
										setTimeout(() => setCopiedPrompt(false), 1500);
									});
								}}
							>
								{copiedPrompt ? t("localBotPromptCopied") : t("localBotPromptCopy")}
							</button>
						</div>
						{previewError && (
							<small role="alert" style={{ color: "var(--err-text, #e5534b)" }}>
								{previewError}
							</small>
						)}
						<textarea
							readOnly
							rows={isInline ? 5 : 4}
							className={isInline ? "bot-form-prompt" : "dc-bot-prompt"}
							spellCheck={false}
							value={previewLoading && !promptPreview ? t("localBotPromptPreviewLoading") : (promptPreview?.full ?? "")}
							style={{
								width: "100%",
								minHeight: isInline ? undefined : "88px",
								opacity: previewLoading ? 0.75 : 1,
								fontFamily: "var(--mono)",
								fontSize: "11.5px",
								lineHeight: 1.5,
								padding: "8px 10px",
								background: "var(--bg-elev)",
								border: "1px solid var(--border)",
								borderRadius: "7px",
								color: "var(--text)",
							}}
						/>
					</div>
				</div>
			</div>

			<div
				role="tabpanel"
				id={`${prefix}-panel-runtime`}
				aria-labelledby={`${prefix}-tab-runtime`}
				hidden={tab !== "runtime"}
			>
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
	);

	return (
		<>
			{useSideRail && dialogChrome ? (
				<div className="dc-bot-b-shell">
					<aside className="dc-bot-b-rail">
						{dialogChrome.railHeader}
						{tabListEl}
						{dialogChrome.railFooter}
					</aside>
					<div className="dc-bot-b-main">
						<header className="dc-bot-b-head">
							<strong>{activeTabTitle}</strong>
							{dialogChrome.closeButton}
						</header>
						<div className="dc-bot-b-body">
							{dialogChrome.errorBanner}
							{tabPanelsEl}
						</div>
						<footer className="dc-actions dc-bot-b-foot">{dialogChrome.footer}</footer>
					</div>
				</div>
			) : (
				<div className={`bot-form${isInline ? " is-inline" : ""}`}>
					{tabListEl}
					{tabPanelsEl}
				</div>
			)}

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
		</>
	);
}
