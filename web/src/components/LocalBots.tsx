import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { appUrl } from "../base-url";
import { withToken } from "../auth-token";
import { useT } from "../i18n";
import { openBotChat } from "../bot-chat";
import { importBotBundle } from "../bot-import";
import { useEscapeKey } from "../shortcut-stack";
import type { ModelInfo } from "../types";
import { resolveBotCwd } from "../local-bot-path";
import { UniversalPathPicker } from "./UniversalPathPicker";
import { UniversalModelPicker } from "./UniversalModelPicker";
import { LocalBotCatalogPicker, type BotCatalogEntry } from "./LocalBotCatalogPicker";
import "./agent-bots.css";

export type Bot = {
	id: string;
	revision: number;
	name: string;
	description: string;
	systemPrompt: string;
	cwd: string;
	model?: { provider: string; modelId: string };
	tools: string[];
	skills: string[];
	mcpServers: string[];
	enabled: boolean;
};
type Options = {
	cwd: string;
	defaultCwd: string;
	defaultModel?: string;
	defaultTools?: string[];
	models: ModelInfo[];
	tools: BotCatalogEntry[];
	skills: BotCatalogEntry[];
	mcpServers: BotCatalogEntry[];
	projects: { path: string }[];
};
const modelId = (model: ModelInfo) =>
	model.id.startsWith(`${model.provider}/`) ? model.id.slice(model.provider.length + 1) : model.id;
const blank = (cwd = ""): Omit<Bot, "id" | "revision"> => ({
	name: "",
	description: "",
	systemPrompt: "",
	cwd,
	tools: [],
	skills: [],
	mcpServers: [],
	enabled: true,
});
// 与左栏「智能体」区对称：设备中心是管理入口，Bot 行上的「私聊」只负责跳回对话入口。
async function request(path: string, signal: AbortSignal, body?: object) {
	const response = await fetch(withToken(appUrl(`/api/device-center/${path}`)), {
		method: body ? "POST" : "GET",
		credentials: "same-origin",
		signal,
		...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
	});
	const data = await response.json();
	if (!response.ok) throw new Error(data.error || String(response.status));
	return data;
}
export function LocalBots({
	pathCompletions = [],
	createOnly = false,
	initialCwd,
	editBot,
	onCreated,
	onFinished,
	onCancel,
}: {
	pathCompletions?: { name: string; path: string; type: "dir" | "file" }[];
	createOnly?: boolean;
	/** 新建时预填的工作目录（当前项目）：不填会退回服务端默认工作区。 */
	initialCwd?: string;
	/** 编辑模式：直接打开这个 Bot 的编辑器（左栏右键「编辑 Bot」就地弹窗）。 */
	editBot?: Bot;
	onCreated?: (bot: Bot, synced: boolean) => void;
	/** 保存 / 删除完成后的收尾：编辑弹窗据此关掉自己。 */
	onFinished?: () => void;
	onCancel?: () => void;
}) {
	const t = useT();
	const [bots, setBots] = useState<Bot[]>([]);
	const [chatPending, setChatPending] = useState<string | null>(null);
	const [draft, setDraft] = useState<(ReturnType<typeof blank> & Partial<Pick<Bot, "id" | "revision">>) | null>(() =>
		editBot ? structuredClone(editBot) : createOnly ? blank(initialCwd ?? "") : null,
	);
	const closeDraft = () => {
		setDraft(null);
		onCancel?.();
	};
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [options, setOptions] = useState<Options | null>(null);
	const [optionsError, setOptionsError] = useState("");
	const [loading, setLoading] = useState(false);
	const [reload, setReload] = useState(0);
	const [modelOpen, setModelOpen] = useState(false);
	const [importing, setImporting] = useState(false);
	const importInput = useRef<HTMLInputElement | null>(null);
	const [catalogTab, setCatalogTab] = useState<"tools" | "skills" | "mcpServers">("tools");
	const [tab, setTab] = useState<"identity" | "runtime" | "permissions">("identity");
	const controller = useRef<AbortController | null>(null);
	// 就地弹窗形态（`BotCreateDialog` / `BotEditDialog` 复用本编辑器）：只渲染编辑器，不渲染列表。
	const solo = createOnly;
	const baseCwd = useRef("");
	const drawer = useRef<HTMLDialogElement>(null);
	const drawerOpen = draft !== null;
	const toolsInitialized = useRef(false);
	useEffect(() => {
		toolsInitialized.current = false;
		if (!drawerOpen) return;
		const panel = drawer.current;
		const previousFocus = document.activeElement as HTMLElement | null;
		const previousOverflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		setTab("identity");
		panel?.showModal?.();
		return () => {
			panel?.close?.();
			document.body.style.overflow = previousOverflow;
			previousFocus?.focus();
		};
	}, [drawerOpen]);
	// 卡片的列表只在常驻模式拉：弹窗里不需要，也不应因为列表接口失败拖住编辑器。
	useEffect(() => {
		if (solo) return;
		const current = new AbortController();
		void request("local-bots", current.signal)
			.then((data) => {
				if (current.signal.aborted) return;
				if (!Array.isArray(data.bots)) throw new Error("Invalid Bot list");
				setBots(data.bots);
			})
			.catch((cause) => {
				if (!current.signal.aborted) setError(String(cause));
			});
		return () => current.abort();
	}, [solo]);
	// 卸载时中止还没回来的保存请求（列表请求由上面的 effect 自己管）。
	useEffect(() => () => controller.current?.abort(), []);
	const importBundle = async (file: File) => {
		setImporting(true);
		setError("");
		try {
			const result = await importBotBundle(file);
			// 回执带上服务端真实写入/跳过的条数：同一迁移包重复导入时能看出“其实没新增”。
			setNotice(
				t("agentBotsImportReceipt", {
					name: result.name,
					imported: result.imported,
					skipped: result.skipped,
				}),
			);
			setReload((value) => value + 1);
			void request("local-bots", new AbortController().signal)
				.then((data) => {
					if (Array.isArray(data.bots)) setBots(data.bots);
				})
				.catch(() => {});
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("localBotImportFailed"));
		} finally {
			setImporting(false);
		}
	};
	const cwd = draft?.cwd;
	useEffect(() => {
		if (cwd === undefined) return;
		const current = new AbortController();
		setLoading(true);
		setOptionsError("");
		setOptions(null);
		void request(cwd ? `local-bot-options?cwd=${encodeURIComponent(cwd)}` : "local-bot-options", current.signal)
			.then((data: Options) => {
				if (current.signal.aborted) return;
				if (
					![data.models, data.tools, data.skills, data.mcpServers, data.projects].every(Array.isArray) ||
					!data.defaultCwd ||
					!data.cwd
				)
					throw new Error(t("localBotOptionsInvalid"));
				baseCwd.current = data.defaultCwd;
				setOptions(data);
				const initializeTools = !toolsInitialized.current;
				toolsInitialized.current = true;
				setDraft((old) =>
					old
						? {
								...old,
								...(!old.cwd ? { cwd: data.cwd } : {}),
								...(initializeTools && !old.id ? { tools: [...(data.defaultTools ?? [])] } : {}),
							}
						: old,
				);
			})
			.catch((cause) => {
				if (!current.signal.aborted) setOptionsError(String(cause));
			})
			.finally(() => {
				if (!current.signal.aborted) setLoading(false);
			});
		return () => current.abort();
	}, [cwd, reload]);
	useEscapeKey(() => setModelOpen(false), modelOpen);
	async function mutate(remove = false) {
		if (!draft || busy) return;
		const current = new AbortController();
		controller.current = current;
		setBusy(true);
		setError("");
		setNotice("");
		try {
			const data = await request(
				remove ? `local-bots/${encodeURIComponent(draft.id!)}/delete` : "local-bots",
				current.signal,
				remove ? { revision: draft.revision } : draft,
			);
			if (current.signal.aborted) return;
			setBots((old) =>
				remove ? old.filter((b) => b.id !== draft.id) : [...old.filter((b) => b.id !== data.bot.id), data.bot],
			);
			setDraft(null);
			setModelOpen(false);
			setNotice(data.synced === false ? t("localBotSyncFailed") : t("localBotSaved"));
			if (!remove) onCreated?.(data.bot, data.synced !== false);
			// 编辑弹窗（`editBot`）保存/删除后就地关掉，不留一个已提交的空对话框。
			onFinished?.();
			// 左栏「智能体」区据此重新拉取：Bot 增删改后无需刷新页面就能直接对话。
			window.dispatchEvent(new CustomEvent("pi-web-ui:device-bots-changed"));
		} catch (cause) {
			if (!current.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			if (!current.signal.aborted) setBusy(false);
		}
	}
	async function startChat(botId: string) {
		if (chatPending) return;
		setChatPending(botId);
		setError("");
		try {
			openBotChat(botId);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setChatPending(null);
		}
	}
	const chosenModel = options?.models.find(
		(model) => model.provider === draft?.model?.provider && modelId(model) === draft?.model?.modelId,
	);
	return (
		<section className={`dc-card dc-bots${solo ? " is-solo" : ""}`} aria-label={t("localBotTitle")}>
			<div className="dg-heading">
				<h2>{t("localBotTitle")}</h2>
				<div className="dc-bots-actions">
					<button
						className="dc-button"
						type="button"
						disabled={busy}
						onClick={() => {
							setDraft(blank());
							setError("");
							setModelOpen(false);
						}}
					>
						{t("localBotCreate")}
					</button>
					<button
						className="dc-button"
						type="button"
						disabled={busy || importing}
						title={t("localBotImportTip")}
						onClick={() => importInput.current?.click()}
					>
						{importing ? t("localBotImporting") : t("localBotImport")}
					</button>
					<input
						ref={importInput}
						type="file"
						accept="application/json,.json"
						hidden
						onChange={(event) => {
							const file = event.target.files?.[0];
							event.target.value = "";
							if (file) void importBundle(file);
						}}
					/>
				</div>
			</div>
			<p>{t("localBotHint")}</p>
			{error && !draft && <p role="alert">{error}</p>}
			{notice && <p role="status">{notice}</p>}
			<div className={`dc-bot-workspace${draft ? " is-editing" : ""}`}>
				<div className="dc-bot-list" aria-label={t("localBotTitle")}>
					{bots.map((bot) => (
						<div className="dc-bot-entry" key={bot.id}>
							<button
								className={`dc-button dc-bot-item${draft?.id === bot.id ? " is-selected" : ""}`}
								aria-pressed={draft?.id === bot.id}
								disabled={busy}
								onClick={() => {
									setDraft(structuredClone(bot));
									setError("");
									setModelOpen(false);
								}}
							>
								<span className="dc-bot-avatar" aria-hidden="true">
									{bot.name.slice(0, 2).toUpperCase()}
								</span>
								<span className="dc-bot-item-copy">
									<strong>{bot.name}</strong>
									<small className={bot.enabled ? "is-enabled" : ""}>
										{bot.enabled ? t("localBotEnabled") : t("localBotDisabled")} · r{bot.revision}
									</small>
									{bot.cwd.startsWith("ssh://") && (
										<small title={bot.cwd}>
											{t("nativeCliRemoteLocation", {
												host: bot.cwd.replace(/^ssh:\/\/([^@]+)@([^:/]+).*$/, "$1@$2"),
											})}
										</small>
									)}
								</span>
							</button>
							<button
								type="button"
								className="dc-bot-chat"
								title={t("botChat", { name: bot.name })}
								aria-label={t("botChat", { name: bot.name })}
								disabled={busy || chatPending !== null}
								onClick={() => void startChat(bot.id)}
							>
								{chatPending === bot.id ? "…" : t("botChatShort")}
							</button>
						</div>
					))}
				</div>
				{draft && (
					<dialog
						ref={drawer}
						className="dc-bot-drawer"
						aria-label={t("localBotTitle")}
						onCancel={(event) => {
							event.preventDefault();
							if (!busy && !modelOpen) closeDraft();
						}}
						onClick={(event) => {
							if (event.target !== event.currentTarget || busy) return;
							const bounds = event.currentTarget.getBoundingClientRect();
							if (
								event.clientX < bounds.left ||
								event.clientX > bounds.right ||
								event.clientY < bounds.top ||
								event.clientY > bounds.bottom
							)
								closeDraft();
						}}
					>
						<form
							className="dc-bot-editor"
							onSubmit={(event) => {
								event.preventDefault();
								void mutate();
							}}
						>
							<header className="dc-bot-editor-head">
								<span className="dc-bot-avatar" aria-hidden="true">
									{draft.name.slice(0, 2).toUpperCase() || "B"}
								</span>
								<div>
									<h3>{draft.name || t("localBotCreate")}</h3>
									{draft.id && (
										<small>
											{draft.id} · r{draft.revision}
										</small>
									)}
								</div>
								<label className="dc-bot-enabled">
									<input
										type="checkbox"
										role="switch"
										disabled={busy}
										checked={draft.enabled}
										onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
									/>
									{t("localBotEnable")}
								</label>
								<button
									className="dc-button dc-bot-drawer-close"
									type="button"
									aria-label={t("localBotCancel")}
									disabled={busy}
									onClick={closeDraft}
								>
									×
								</button>
							</header>
							<div className="dc-bot-tabs" role="tablist" aria-label={t("localBotTitle")}>
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
										id={`bot-tab-${key}`}
										aria-controls={`bot-panel-${key}`}
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
											document.getElementById(`bot-tab-${tabs[next][0]}`)?.focus();
										}}
									>
										{label}
									</button>
								))}
							</div>
							<div className="dc-bot-editor-body">
								{error && (
									<p className="dc-bot-error" role="alert">
										{error}
									</p>
								)}
								<div
									role="tabpanel"
									id="bot-panel-identity"
									aria-labelledby="bot-tab-identity"
									hidden={tab !== "identity"}
								>
									<p className="dc-bot-section-intro">{t("localBotIdentityHint")}</p>
									<fieldset className="dc-bot-section" disabled={busy}>
										<legend>{t("localBotIdentity")}</legend>
										<label className="dc-field">
											{t("localBotName")}
											<input
												required
												value={draft.name}
												onChange={(e) => setDraft({ ...draft, name: e.target.value })}
											/>
										</label>
										<label className="dc-field">
											{t("localBotDescription")}
											<textarea
												rows={2}
												value={draft.description}
												onChange={(e) => setDraft({ ...draft, description: e.target.value })}
											/>
										</label>
										<label className="dc-field">
											{t("localBotSystemPrompt")}
											<textarea
												rows={9}
												className="dc-bot-prompt"
												spellCheck={false}
												value={draft.systemPrompt}
												onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })}
											/>
										</label>
									</fieldset>
									<p className="dc-bot-local-note">{t("localBotPrivatePrompt")}</p>
								</div>
								<div
									role="tabpanel"
									id="bot-panel-runtime"
									aria-labelledby="bot-tab-runtime"
									hidden={tab !== "runtime"}
								>
									<p className="dc-bot-section-intro">{t("localBotRuntimeHint")}</p>
									<fieldset className="dc-bot-section" disabled={busy}>
										<legend>{t("localBotRuntime")}</legend>
										<div className="dc-field">
											<label htmlFor="local-bot-cwd">{t("localBotCwd")}</label>
											<UniversalPathPicker
												inputId="local-bot-cwd"
												commitOnBlur
												pathCompletions={pathCompletions}
												cwd={draft.cwd}
												baseCwd={baseCwd.current || draft.cwd}
												projects={options?.projects.map((project) => ({ ...project, lastUsed: 0 })) ?? []}
												disabled={busy}
												onSelectCwd={(value) =>
													setDraft({ ...draft, cwd: resolveBotCwd(value, baseCwd.current || draft.cwd) })
												}
											/>
										</div>
										<div className="dc-field">
											<span>{t("localBotModel")}</span>
											<div className="dc-actions">
												<button
													className="dc-button"
													type="button"
													aria-haspopup="dialog"
													onClick={() => setModelOpen(true)}
												>
													{draft.model
														? (chosenModel?.name ?? `${draft.model.provider}/${draft.model.modelId}`)
														: t("localBotInheritModel")}
												</button>
												{draft.model && (
													<button
														className="dc-button"
														type="button"
														onClick={() => setDraft({ ...draft, model: undefined })}
													>
														{t("localBotInheritModel")}
													</button>
												)}
											</div>
											{draft.model && !chosenModel && (
												<small>{loading ? t("localBotUnverified") : t("localBotUnavailable")}</small>
											)}
										</div>
									</fieldset>
								</div>
								<div
									role="tabpanel"
									id="bot-panel-permissions"
									aria-labelledby="bot-tab-permissions"
									hidden={tab !== "permissions"}
								>
									<p className="dc-bot-section-intro">{t("localBotPermissionsHint")}</p>
									<div className="dc-bot-options-status" aria-live="polite">
										{loading && <span>{t("localBotOptionsLoading")}</span>}
										{optionsError && <span role="alert">{optionsError}</span>}
										<button
											className="dc-button"
											type="button"
											disabled={loading || busy}
											onClick={() => setReload((value) => value + 1)}
										>
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
												id={`bot-catalog-tab-${key}`}
												aria-controls={`bot-catalog-${key}`}
												aria-selected={catalogTab === key}
												onClick={() => setCatalogTab(key)}
											>
												{title}
												<span>{draft[key].length}</span>
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
												id={`bot-catalog-${key}`}
												aria-labelledby={`bot-catalog-tab-${key}`}
												hidden={catalogTab !== key}
											>
												<LocalBotCatalogPicker
													title={title}
													entries={options?.[key] ?? []}
													selected={draft[key]}
													disabled={busy}
													pending={loading || !!optionsError}
													onChange={(ids) => {
														if (key === "tools") toolsInitialized.current = true;
														setDraft({ ...draft, [key]: ids });
													}}
												/>
											</div>
										))}
									</div>
								</div>
							</div>
							<footer className="dc-actions dc-bot-editor-footer">
								<button className="dc-button dc-bot-save" disabled={busy || !draft.cwd || !draft.name.trim()}>
									{t("localBotSave")}
								</button>
								<button
									className="dc-button"
									type="button"
									disabled={busy}
									onClick={() => {
										closeDraft();
										setModelOpen(false);
									}}
								>
									{t("localBotCancel")}
								</button>
								{draft.id && (
									<button
										className="dc-button is-danger"
										type="button"
										disabled={busy}
										onClick={() => {
											if (window.confirm(t("localBotDeleteConfirm"))) void mutate(true);
										}}
									>
										{t("localBotDelete")}
									</button>
								)}
							</footer>
						</form>
					</dialog>
				)}
			</div>
			{draft &&
				modelOpen &&
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
								modelsLoading={loading}
								defaultModel={options?.defaultModel}
								currentModelId={draft.model ? `${draft.model.provider}/${draft.model.modelId}` : null}
								active
								onEnsureModels={() => {}}
								onRefresh={() => setReload((value) => value + 1)}
								onPickModel={(model) => {
									setDraft({ ...draft, model: { provider: model.provider, modelId: modelId(model) } });
									setModelOpen(false);
								}}
								isRowActive={(model) =>
									model.provider === draft.model?.provider && modelId(model) === draft.model.modelId
								}
								extraTopRow={
									<button
										type="button"
										className="dc-button"
										onClick={() => {
											setDraft({ ...draft, model: undefined });
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
					drawer.current ?? document.body,
				)}
		</section>
	);
}
