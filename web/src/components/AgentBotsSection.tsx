import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { FiChevronDown, FiChevronUp, FiCpu, FiSettings, FiUsers } from "react-icons/fi";
import { useT, type Translate } from "../i18n";
import { DEVICE_GROUPS_CHANGED, deviceGroupRequest } from "./DeviceGroupSection";
import { openBotChat, openBotManagement } from "../bot-chat";
import { openContextMenu } from "../context-menu-state";
import type { UiSlotEntry } from "../ui-slots";
import { referenceBotInComposer } from "../bot-reference";
import {
	botDraftFailureText,
	createBotDraft,
	requestBotCreate,
	subscribeBotCreateRequest,
	type BotDraftFailure,
} from "../bot-create";
import { botDraftActionErrorText, type BotDraftActionFailure } from "../bot-draft-action";
import { copyTextToClipboard } from "../use-copy-feedback";
import { BotMemoryDialog } from "./BotMemoryDialog";
import { BotChatHistoryDialog } from "./BotChatHistoryDialog";
import { BotCreateDialog } from "./BotCreateDialog";
import { BotEditDialog } from "./BotEditDialog";
import "./agent-bots.css";

/**
 * 左栏「智能体」区 = 对话入口：把 Bot 当一等对话对象。
 *
 * 点开 = `open_bot_chat`（普通对话 + Bot 身份，见 ../bot-chat.ts）：默认回到**同一个**私聊，
 * 不建房间、不派任务。右键菜单的「新开对话」才是另起一条（旧记录保留）。
 * 这里只负责列表与状态：**加号 = 新建智能体**（AI 起草优先、手动填写就地弹窗），
 * 草案确认也在这一块；导入迁移包在设备中心的 Bot 管理页（本区块不再挂导入）。
 * **建群也在这一行**：「群组」区块空时整块隐藏（`hideWhenEmpty`），入口不能只住在那里。
 */

type BotRow = {
	id: string;
	name: string;
	enabled: boolean;
	deviceName?: string;
	online?: boolean;
	/** Bot 绑定的工作目录（服务端 `bot-panel` 的投影）；缺失时行提示里不提。 */
	cwd?: string;
	/** 正在执行任务；缺失或 false = 空闲（服务端可选投影）。 */
	busy?: boolean;
	/** 本机注册表（`device-bots/`）的 Bot；false = 其它设备登记在 Hub 上的 Bot。 */
	local?: boolean;
};

type BotDraft = {
	id: string;
	name: string;
	description: string;
	systemPrompt: string;
	cwd: string;
	tools: string[];
	trigger: "on_demand" | "always_on" | "scheduled";
	rationale?: string;
	bootstrap: boolean;
	highPrivilegeTools: string[];
	createdBy: "model" | "human";
	createdAt: number;
};

/** 本区块的文案住在 `web/src/i18n/messages/agent-bots/`，键名统一 `agentBots*` 前缀。 */
/** 起草失败的文案表：`botDraftFailureText` 只认这五个类别。 */
function draftWordTable(t: Translate): Record<BotDraftFailure, string> {
	return {
		"no-model": t("agentBotsDraftErrorNoModel"),
		unparsable: t("agentBotsDraftErrorUnparsable"),
		timeout: t("agentBotsDraftErrorTimeout"),
		request: t("agentBotsDraftErrorRequest"),
		workspace: t("agentBotsDraftWorkspaceError"),
		failed: t("agentBotsDraftErrorFailed"),
	};
}

/** 确认/取消失败的文案表：`botDraftActionErrorText` 只在没有 `detail` 时才用它。 */
function draftActionWordTable(t: Translate): Record<BotDraftActionFailure, string> {
	return {
		"needs-approval": t("agentBotsDraftNeedsApproval"),
		"cwd-invalid": t("agentBotsDraftCwdInvalid"),
		busy: t("agentBotsDraftBusy"),
		missing: t("agentBotsDraftMissing"),
		failed: t("agentBotsDraftActionFailed"),
	};
}

/** 行提示里的路径只留尾部：完整路径在设备中心，这里只需要知道它绑在哪个目录。 */
function shortPath(path: string, max = 36): string {
	const value = path.replace(/[\\/]+$/, "");
	return value.length <= max ? value : `…${value.slice(1 - max)}`;
}

/** 行 title：私聊动词 + 执行中 + 工作目录，后两段可缺省。 */
function rowHint(bot: BotRow, t: Translate): string {
	const parts = [t("agentBotsOpen", { name: bot.name })];
	if (bot.busy === true) parts.push(t("agentBotsBusyTip"));
	if (bot.cwd) parts.push(`${t("agentBotsWorkspace")}: ${shortPath(bot.cwd)}`);
	return parts.join("\n");
}

/**
 * 建群入口挂在「智能体」标题行（不是「群组」区块）：群组一条都没有时那个区块整块隐藏，
 * 入口跟着消失的话就再也建不出群了。事件链路由 `App.tsx` 统一受理。
 */
function openGroupCreate(): void {
	window.dispatchEvent(new CustomEvent("pi-web-ui:device-group-open", { detail: { create: true } }));
}

export function AgentBotsSection({
	active = true,
	activeBotId,
	cwd,
}: {
	active?: boolean;
	/** 当前对话如果是某 Bot 的私聊，这里就是它的 id（私聊 = 普通对话 + Bot 身份）。 */
	activeBotId?: string | null;
	/** 当前项目（工作区）：新建 Bot 默认落在它下面，而不是服务端默认目录。 */
	cwd?: string | null;
}) {
	const t = useT();
	const [bots, setBots] = useState<BotRow[] | null>(null);
	const [drafts, setDrafts] = useState<BotDraft[]>([]);
	const [grants, setGrants] = useState<Record<string, string[]>>({});
	const [approving, setApproving] = useState<string | null>(null);
	const [memoryBot, setMemoryBot] = useState<BotRow | null>(null);
	const [historyBot, setHistoryBot] = useState<BotRow | null>(null);
	// 编辑就地弹窗（复用设备中心那份编辑器）：只存 id，不在左栏拼一份不完整的 Bot。
	const [editBotId, setEditBotId] = useState<string | null>(null);
	const [notice, setNotice] = useState("");
	// 加号 = 新建智能体：一句话交给服务端 AI 起草（产草案），或切到设备中心手动填写。
	const [creating, setCreating] = useState(false);
	const [createText, setCreateText] = useState("");
	// 手动填写：就地弹窗（复用设备中心那份编辑器），不切视图。
	const [manualOpen, setManualOpen] = useState(false);
	const [createBusy, setCreateBusy] = useState(false);
	const [createError, setCreateError] = useState("");
	const [error, setError] = useState("");
	// 确认/取消失败：与列表加载错误（`error`）分开——草案仍在待确认区，原因要贴在那里并可直接重试。
	const [draftError, setDraftError] = useState<{ id: string; action: "confirm" | "discard"; text: string } | null>(
		null,
	);
	const [collapsed, setCollapsed] = useState(false);
	const [pending, setPending] = useState<string | null>(null);
	const generation = useRef(0);

	// Bot 列表的唯一数据源是服务端本机面板（`/api/device-center/bot-panel`）：Bot 身份与草案
	// 都存在本机 `device-bots/`，Hub 只消费这份列表，离线不影响这块列表。
	const load = useCallback(async () => {
		const token = ++generation.current;
		const controller = new AbortController();
		try {
			const panel = await deviceGroupRequest<{
				bots?: BotRow[];
				drafts?: BotDraft[];
			}>("bot-panel", controller.signal);
			if (token !== generation.current) return;
			setBots((panel.bots ?? []).filter((bot) => bot.enabled).sort((a, b) => a.name.localeCompare(b.name)));
			setDrafts(panel.drafts ?? []);
			setError("");
		} catch (cause) {
			if (token !== generation.current) return;
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}, []);

	useEffect(() => {
		if (!active) return;
		void load();
		const refresh = () => void load();
		window.addEventListener(DEVICE_GROUPS_CHANGED, refresh);
		window.addEventListener("pi-web-ui:device-bots-changed", refresh);
		// 草案由主对话里的 agent_bot 工具产生（没有前端事件），这里低频轮询兜底：
		// 5s 一次只读本地文件，比让用户"刷新页面才看到确认卡"更合理。
		const timer = window.setInterval(refresh, 5000);
		return () => {
			window.removeEventListener(DEVICE_GROUPS_CHANGED, refresh);
			window.removeEventListener("pi-web-ui:device-bots-changed", refresh);
			window.clearInterval(timer);
		};
	}, [active, load]);

	useEffect(() => subscribeBotCreateRequest(() => setManualOpen(true)), []);

	// 私聊 = 开一条普通对话并绑定这个 Bot（角色/工具/模型/记忆都在会话上），
	// 不再建房间、也不再产生任务。群聊才需要房间与 @ 路由。
	const startChat = useCallback((bot: BotRow, opts?: { fresh?: boolean }) => {
		setPending(bot.id);
		openBotChat(bot.id, opts);
		// 打开是同步派发，给一拍反馈就复位（会话真正就绪由快照驱动高亮）。
		window.setTimeout(() => setPending(null), 400);
	}, []);

	// 一句话 → 草案（服务端跑一次模型，不占会话）；草案落到下方「待确认的新智能体」。
	const draftWithAi = useCallback(async () => {
		const sentence = createText.trim();
		if (!sentence) {
			setCreateError(t("agentBotsCreateEmpty"));
			return;
		}
		const controller = new AbortController();
		setCreateBusy(true);
		setCreateError("");
		try {
			const draft = await createBotDraft(sentence, controller.signal, cwd ?? undefined);
			setNotice(t("agentBotsCreateDone", { name: draft.name }));
			setCreating(false);
			setCreateText("");
			await load();
		} catch (cause) {
			setCreateError(botDraftFailureText(cause, draftWordTable(t)));
		} finally {
			setCreateBusy(false);
		}
	}, [createText, cwd, load, t]);

	const confirmDraft = useCallback(
		async (draft: BotDraft) => {
			const approved = grants[draft.id] ?? [];
			if (draft.highPrivilegeTools.some((tool) => !approved.includes(tool))) {
				setDraftError({ id: draft.id, action: "confirm", text: t("agentBotsDraftNeedsApproval") });
				return;
			}
			const controller = new AbortController();
			setApproving(draft.id);
			setDraftError(null);
			try {
				const result = await deviceGroupRequest<{ bot?: { id: string } }>(
					`bot-drafts/${encodeURIComponent(draft.id)}/approve`,
					controller.signal,
					{
						approvedTools: [
							...new Set([...draft.tools.filter((tool) => !draft.highPrivilegeTools.includes(tool)), ...approved]),
						],
					},
				);
				window.dispatchEvent(new CustomEvent("pi-web-ui:device-bots-changed"));
				await load();
				if (result.bot?.id) openBotChat(result.bot.id);
			} catch (cause) {
				setDraftError({
					id: draft.id,
					action: "confirm",
					text: botDraftActionErrorText(cause, draftActionWordTable(t)),
				});
				// 服务端失败后草案仍留在待确认列表：重新拉一次，「重试」才有真实草案可点。
				await load();
			} finally {
				setApproving(null);
			}
		},
		[grants, load, t],
	);
	const discardDraft = useCallback(
		async (draft: BotDraft) => {
			const controller = new AbortController();
			setApproving(draft.id);
			setDraftError(null);
			try {
				await deviceGroupRequest(`bot-drafts/${encodeURIComponent(draft.id)}/discard`, controller.signal, {});
				await load();
			} catch (cause) {
				setDraftError({
					id: draft.id,
					action: "discard",
					text: botDraftActionErrorText(cause, draftActionWordTable(t)),
				});
				await load();
			} finally {
				setApproving(null);
			}
		},
		[load, t],
	);

	// 右键菜单：Bot 行本身是「对话入口」，不做成编辑表单的入口。
	// 菜单只放跳转与轻量动作（开私聊 / @ 引用 / 编辑就地弹窗 / 设备中心 / 记忆 / 复制 ID），
	// 编辑器只留 `LocalBots` 一份（`BotEditDialog` 复用它），左栏不另写一套表单。
	const openBotMenu = useCallback(
		(event: ReactMouseEvent, bot: BotRow) => {
			event.preventDefault();
			event.stopPropagation();
			const items = [
				{ action: "chat", label: t("agentBotsMenuChat"), hint: undefined },
				{ action: "new-chat", label: t("agentBotsMenuNewChat"), hint: t("agentBotsMenuNewChatTip") },
				{ action: "reference", label: t("agentBotsMenuReference"), hint: t("agentBotsMenuReferenceTip") },
				{ action: "history", label: t("agentBotsMenuHistory"), hint: t("agentBotsMenuHistoryTip") },
				{ action: "edit", label: t("agentBotsMenuEdit"), hint: undefined },
				{ action: "manage", label: t("agentBotsMenuManage"), hint: undefined },
				{ action: "memory", label: t("agentBotsMenuMemory"), hint: undefined },
				{ action: "copy-id", label: t("agentBotsMenuCopyId"), hint: undefined },
			] as const;
			const entries: UiSlotEntry[] = items.map((item, index) => ({
				id: `host:bot-${item.action}`,
				slot: "contextmenu.bot",
				source: "host",
				label: item.label,
				...(item.hint ? { hint: item.hint } : {}),
				kind: "action",
				action: item.action,
				order: (index + 1) * 10,
				align: "start",
				hidden: false,
				userOverrides: [],
				arrangedBy: [],
			}));
			openContextMenu({
				x: event.clientX,
				y: event.clientY,
				slot: "contextmenu.bot",
				target: { id: bot.id, kind: "agent-bot", label: bot.name },
				entries,
				onHostAction: (entry) => {
					if (entry.action === "chat") void startChat(bot);
					else if (entry.action === "new-chat") void startChat(bot, { fresh: true });
					else if (entry.action === "reference") referenceBotInComposer({ botId: bot.id, name: bot.name });
					else if (entry.action === "edit") setEditBotId(bot.id);
					else if (entry.action === "manage") openBotManagement();
					else if (entry.action === "memory") setMemoryBot(bot);
					else if (entry.action === "history") setHistoryBot(bot);
					else if (entry.action === "copy-id") void copyTextToClipboard(bot.id);
				},
			});
		},
		[startChat, t],
	);

	// 失败后草案仍在（服务端保留）：重试按钮要按 id 找回当前这份草案再重发。
	const failedDraft = draftError ? drafts.find((draft) => draft.id === draftError.id) : undefined;

	return (
		<section className="lp-bots-section" aria-label={t("agentBotsTitle")} aria-busy={!bots && !error}>
			<div className="lp-bots-header">
				<button
					type="button"
					className="lp-bots-toggle"
					aria-expanded={!collapsed}
					aria-label={collapsed ? t("agentBotsExpand") : t("agentBotsCollapse")}
					onClick={() => setCollapsed((value) => !value)}
				>
					<FiCpu aria-hidden="true" />
					<span className="lp-bots-title">{t("agentBotsTitle")}</span>
					{botCount(bots) > 0 && <span className="lp-bots-count">{botCount(bots)}</span>}
					{/* 与项目 / 群组区块同形：折叠箭头统一在标题尾巴上。 */}
					<span className="lp-section-chevron" aria-hidden="true">
						{collapsed ? <FiChevronDown /> : <FiChevronUp />}
					</span>
				</button>
				<div className="lp-bots-actions">
					<button
						type="button"
						className="lp-bots-group"
						title={t("createGroup")}
						aria-label={t("createGroup")}
						onClick={openGroupCreate}
					>
						<FiUsers aria-hidden="true" />
					</button>
					<button
						type="button"
						className="lp-bots-manage"
						title={t("agentBotsManageTip")}
						aria-label={t("agentBotsManage")}
						onClick={openBotManagement}
					>
						<FiSettings aria-hidden="true" />
					</button>
					<button
						type="button"
						className="lp-bots-import"
						title={t("agentBotsCreateTitle")}
						aria-label={t("agentBotsCreateTitle")}
						aria-expanded={creating}
						onClick={() => {
							setCreating((value) => !value);
							setCreateError("");
						}}
					>
						＋
					</button>
				</div>
			</div>
			{/* 新建卡片与列表一起滚动：整个区块按内容高度排布，超过上限时只在内部滚。 */}
			<div className="lp-bots-scroll">
				{creating && (
					<form
						className="lp-bots-create"
						onSubmit={(event) => {
							event.preventDefault();
							void draftWithAi();
						}}
					>
						<label className="lp-bots-create-title" htmlFor="lp-bots-create-input">
							{t("agentBotsCreateTitle")}
						</label>
						<textarea
							id="lp-bots-create-input"
							className="lp-bots-create-input"
							value={createText}
							rows={2}
							placeholder={t("agentBotsCreatePlaceholder")}
							disabled={createBusy}
							onChange={(event) => setCreateText(event.target.value)}
						/>
						{createError && (
							<p className="lp-bots-create-error" role="alert">
								{createError}
							</p>
						)}
						<div className="lp-bots-create-actions">
							<button type="submit" className="lp-bots-create-primary" disabled={createBusy}>
								{createBusy ? t("agentBotsCreating") : t("agentBotsCreateAi")}
							</button>
							<button
								type="button"
								className="lp-bots-create-secondary"
								disabled={createBusy}
								title={t("agentBotsCreateManual")}
								onClick={() => {
									// 手动兜底：就地弹「新建智能体」表单（不跳设备中心）。
									setCreating(false);
									setCreateText("");
									requestBotCreate();
								}}
							>
								{t("agentBotsCreateManual")}
							</button>
							<button
								type="button"
								className="lp-bots-create-cancel"
								disabled={createBusy}
								onClick={() => {
									setCreating(false);
									setCreateText("");
									setCreateError("");
								}}
							>
								{t("agentBotsCreateCancel")}
							</button>
						</div>
					</form>
				)}
				{!collapsed && (
					<div className="lp-bots-body">
						{notice && <p className="lp-bots-notice">{notice}</p>}
						{error && (
							<div className="lp-bots-error">
								<span>{t("agentBotsFailed")}</span>
								<button type="button" onClick={() => void load()}>
									{t("agentBotsRetry")}
								</button>
							</div>
						)}
						{(drafts.length > 0 || draftError) && (
							<div className="lp-bot-drafts">
								{drafts.length > 0 && (
									<>
										<p className="lp-bot-drafts-title">{t("agentBotsDrafts")}</p>
										<p className="lp-bot-drafts-hint">{t("agentBotsDraftHint")}</p>
									</>
								)}
								{draftError && (
									<div className="lp-bot-drafts-error" role="alert">
										<span>{draftError.text}</span>
										<div className="lp-bot-drafts-error-actions">
											{failedDraft && (
												<button
													type="button"
													disabled={approving !== null}
													onClick={() =>
														void (draftError.action === "confirm"
															? confirmDraft(failedDraft)
															: discardDraft(failedDraft))
													}
												>
													{t("agentBotsRetry")}
												</button>
											)}
											<button type="button" onClick={() => setDraftError(null)}>
												{t("agentBotsDraftErrorDismiss")}
											</button>
										</div>
									</div>
								)}
								{drafts.map((draft) => {
									const granted = grants[draft.id] ?? [];
									const ready = draft.highPrivilegeTools.every((tool) => granted.includes(tool));
									const busy = approving === draft.id;
									return (
										<div key={draft.id} className="lp-bot-draft">
											<div className="lp-bot-draft-head">
												<strong>{draft.name}</strong>
												<span className="lp-bot-draft-badge">
													{draft.trigger === "on_demand"
														? t("agentBotsTriggerOnDemand")
														: t("agentBotsTriggerReserved")}
												</span>
											</div>
											<p className="lp-bot-draft-desc">{draft.description}</p>
											{draft.trigger !== "on_demand" && (
												<p className="lp-bot-draft-meta">
													{t("agentBotsTriggerReservedHint", { trigger: draft.trigger })}
												</p>
											)}
											<p className="lp-bot-draft-meta" title={draft.cwd}>
												{t("agentBotsWorkspace")}: {shortPath(draft.cwd)}
											</p>
											{draft.rationale && (
												<details className="lp-bot-draft-why">
													<summary>{t("agentBotsDraftWhy")}</summary>
													<p>{draft.rationale}</p>
												</details>
											)}
											{draft.tools.length > 0 && (
												<p className="lp-bot-draft-meta" title={draft.tools.join(", ")}>
													{t("agentBotsTools")}: {draft.tools.length} · {draft.tools.slice(0, 4).join("、")}
													{draft.tools.length > 4 ? "…" : ""}
												</p>
											)}
											{draft.highPrivilegeTools.length > 0 && (
												<div className="lp-bot-draft-grants">
													{draft.highPrivilegeTools.map((tool) => (
														<label key={tool} className="lp-bot-draft-grant">
															<input
																type="checkbox"
																checked={granted.includes(tool)}
																onChange={(event) =>
																	setGrants((current) => ({
																		...current,
																		[draft.id]: event.target.checked
																			? [...new Set([...(current[draft.id] ?? []), tool])]
																			: (current[draft.id] ?? []).filter((item) => item !== tool),
																	}))
																}
															/>
															<span>{tool}</span>
														</label>
													))}
												</div>
											)}
											<div className="lp-bot-draft-actions">
												<button
													type="button"
													className="lp-bot-draft-primary"
													disabled={!ready || busy}
													onClick={() => void confirmDraft(draft)}
												>
													{busy ? t("agentBotsApproving") : t("agentBotsApprove")}
												</button>
												<button type="button" disabled={busy} onClick={() => void discardDraft(draft)}>
													{t("agentBotsDiscard")}
												</button>
											</div>
										</div>
									);
								})}
							</div>
						)}
						{!error && !bots && <p className="lp-bots-empty">{t("agentBotsLoading")}</p>}
						{!error && bots && bots.length === 0 && drafts.length === 0 && (
							<p className="lp-bots-empty">{t("agentBotsEmpty")}</p>
						)}
						{(bots ?? []).map((bot) => {
							// 高亮跟着"当前对话是不是这个 Bot 的私聊"走（普通会话 + Bot 绑定）。
							const isActive = activeBotId === bot.id;
							return (
								<div key={bot.id} className="lp-bot-item" onContextMenu={(event) => openBotMenu(event, bot)}>
									<button
										type="button"
										className={`lp-bot-row${isActive ? " is-active" : ""}`}
										title={rowHint(bot, t)}
										aria-pressed={isActive}
										disabled={pending !== null}
										onClick={() => void startChat(bot)}
									>
										<span className={`lp-bot-avatar${bot.online ? " is-online" : ""}`} aria-hidden="true">
											{bot.name.slice(0, 1).toUpperCase()}
										</span>
										<span className="lp-bot-meta">
											<span className="lp-bot-name">{bot.name}</span>
											<span className="lp-bot-sub">
												{pending === bot.id
													? t("agentBotsStarting")
													: bot.online === false
														? t("agentBotsOffline")
														: (bot.deviceName ?? "Bot")}
											</span>
										</span>
										{bot.busy === true && (
											<span className="lp-bot-busy" title={t("agentBotsBusyTip")}>
												{t("agentBotsBusy")}
											</span>
										)}
									</button>
									<button
										type="button"
										className="lp-bot-memory"
										title={t("agentBotsMemoryTip")}
										aria-label={t("agentBotsMemory")}
										onClick={() => setMemoryBot(bot)}
									>
										🧠
									</button>
								</div>
							);
						})}
					</div>
				)}
			</div>
			{historyBot && (
				<BotChatHistoryDialog botId={historyBot.id} botName={historyBot.name} onClose={() => setHistoryBot(null)} />
			)}
			{memoryBot && (
				<BotMemoryDialog botId={memoryBot.id} botName={memoryBot.name} onClose={() => setMemoryBot(null)} />
			)}
			{editBotId && <BotEditDialog botId={editBotId} onClose={() => setEditBotId(null)} />}
			{manualOpen && <BotCreateDialog cwd={cwd} onClose={() => setManualOpen(false)} />}
		</section>
	);
}

function botCount(bots: BotRow[] | null): number {
	return bots?.length ?? 0;
}
