import { useEffect, useRef, useState } from "react";
import { appUrl } from "../base-url";
import { withToken } from "../auth-token";
import { useT } from "../i18n";
import { openBotChat } from "../bot-chat";
import { importBotBundle } from "../bot-import";
import type { ModelInfo } from "../types";
import { BotEditorForm, type BotOptions } from "./BotEditorForm";
import { type BotCatalogEntry } from "./LocalBotCatalogPicker";
import "./agent-bots.css";

export type Bot = {
	id: string;
	revision: number;
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
	useGlobalPrompt: true,
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
	createOnly = false,
	initialCwd,
	editBot,
	onCreated,
	onFinished,
	onCancel,
}: {
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
	const [options, setOptions] = useState<BotOptions | null>(null);
	const [optionsError, setOptionsError] = useState("");
	const [loading, setLoading] = useState(false);
	const [reload, setReload] = useState(0);
	const [modelOpen, setModelOpen] = useState(false);
	const [importing, setImporting] = useState(false);
	const importInput = useRef<HTMLInputElement | null>(null);
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
							<BotEditorForm
								variant="dialog"
								value={draft}
								onChange={(next) => setDraft({ ...draft, ...next })}
								options={options}
								optionsLoading={loading}
								optionsError={optionsError}
								onReloadOptions={() => setReload((value) => value + 1)}
								busy={busy}
								baseCwd={baseCwd.current || draft.cwd}
								modelPortalTarget={drawer.current ?? document.body}
								modelOpen={modelOpen}
								onModelOpenChange={setModelOpen}
								dialogChrome={{
									railHeader: (
										<div className="dc-bot-b-badge">
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
										</div>
									),
									railFooter: (
										<div className="dc-bot-b-rail-foot">
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
											{draft.id && (
												<button
													className="dc-button is-danger"
													type="button"
													style={{ width: "100%" }}
													disabled={busy}
													onClick={() => {
														if (window.confirm(t("localBotDeleteConfirm"))) void mutate(true);
													}}
												>
													{t("localBotDelete")}
												</button>
											)}
										</div>
									),
									closeButton: (
										<button
											className="dc-button dc-bot-drawer-close"
											type="button"
											aria-label={t("localBotCancel")}
											disabled={busy}
											onClick={closeDraft}
										>
											×
										</button>
									),
									errorBanner: error ? (
										<p className="dc-bot-error" role="alert">
											{error}
										</p>
									) : undefined,
									footer: (
										<>
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
											<button className="dc-button dc-bot-save" disabled={busy || !draft.cwd || !draft.name.trim()}>
												{t("localBotSave")}
											</button>
										</>
									),
								}}
							/>
						</form>
					</dialog>
				)}
			</div>
		</section>
	);
}
