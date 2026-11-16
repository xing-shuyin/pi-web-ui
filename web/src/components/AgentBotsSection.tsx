import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { FiChevronDown, FiChevronRight, FiCpu, FiSettings } from "react-icons/fi";
import { useT } from "../i18n";
import { DEVICE_GROUPS_CHANGED, deviceGroupRequest } from "./DeviceGroupSection";
import { openBotChat, openBotManagement } from "../bot-chat";
import { openContextMenu } from "../context-menu-state";
import type { UiSlotEntry } from "../ui-slots";
import { referenceBotInComposer } from "../bot-reference";
import { requestBotEdit } from "../bot-edit";
import { createBotDraft, requestBotCreate, subscribeBotCreateRequest } from "../bot-create";
import { copyTextToClipboard } from "../use-copy-feedback";
import { BotMemoryDialog } from "./BotMemoryDialog";
import { BotCreateDialog } from "./BotCreateDialog";
import "./agent-bots.css";

/**
 * 左栏「智能体」区 = 对话入口：把 Bot 当一等对话对象。
 *
 * 点开 = `open_bot_chat`（普通对话 + Bot 身份，见 ../bot-chat.ts）：默认回到**同一个**私聊，
 * 不建房间、不派任务。右键菜单的「新开对话」才是另起一条（旧记录保留）。
 * 这里只负责列表与状态：**加号 = 新建智能体**（AI 起草优先、手动填写就地弹窗），
 * 草案确认也在这一块；导入迁移包在设备中心的 Bot 管理页（本区块不再挂导入）。
 */

type BotRow = {
	id: string;
	name: string;
	enabled: boolean;
	deviceName?: string;
	online?: boolean;
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

export function AgentBotsSection({
	active = true,
	activeBotId,
}: {
	active?: boolean;
	/** 当前对话如果是某 Bot 的私聊，这里就是它的 id（私聊 = 普通对话 + Bot 身份）。 */
	activeBotId?: string | null;
}) {
	const t = useT();
	const [bots, setBots] = useState<BotRow[] | null>(null);
	const [drafts, setDrafts] = useState<BotDraft[]>([]);
	const [grants, setGrants] = useState<Record<string, string[]>>({});
	const [approving, setApproving] = useState<string | null>(null);
	const [memoryBot, setMemoryBot] = useState<BotRow | null>(null);
	const [notice, setNotice] = useState("");
	// 加号 = 新建智能体：一句话交给服务端 AI 起草（产草案），或切到设备中心手动填写。
	const [creating, setCreating] = useState(false);
	const [createText, setCreateText] = useState("");
	// 手动填写：就地弹窗（复用设备中心那份编辑器），不切视图。
	const [manualOpen, setManualOpen] = useState(false);
	const [createBusy, setCreateBusy] = useState(false);
	const [createError, setCreateError] = useState("");
	const [error, setError] = useState("");
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
			setCreateError(t("agentBots.createEmpty"));
			return;
		}
		const controller = new AbortController();
		setCreateBusy(true);
		setCreateError("");
		try {
			const draft = await createBotDraft(sentence, controller.signal);
			setNotice(t("agentBots.createDone", { name: draft.name }));
			setCreating(false);
			setCreateText("");
			await load();
		} catch (cause) {
			setCreateError(cause instanceof Error ? cause.message : t("agentBots.createFailed"));
		} finally {
			setCreateBusy(false);
		}
	}, [createText, load, t]);

	const confirmDraft = useCallback(
		async (draft: BotDraft) => {
			const approved = grants[draft.id] ?? [];
			if (draft.highPrivilegeTools.some((tool) => !approved.includes(tool))) return;
			const controller = new AbortController();
			setApproving(draft.id);
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
				setError(cause instanceof Error ? cause.message : String(cause));
			} finally {
				setApproving(null);
			}
		},
		[grants, load],
	);
	const discardDraft = useCallback(
		async (draft: BotDraft) => {
			const controller = new AbortController();
			setApproving(draft.id);
			try {
				await deviceGroupRequest(`bot-drafts/${encodeURIComponent(draft.id)}/discard`, controller.signal, {});
				await load();
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : String(cause));
			} finally {
				setApproving(null);
			}
		},
		[load],
	);

	// 右键菜单：Bot 行本身是「对话入口」，不做成编辑表单的入口。
	// 菜单只放跳转与轻量动作（开私聊 / @ 引用 / 编辑与权限跳设备中心 / 记忆 / 复制 ID），
	// 避免左栏和设备中心各写一套 Bot 编辑器。
	const openBotMenu = useCallback(
		(event: ReactMouseEvent, bot: BotRow) => {
			event.preventDefault();
			event.stopPropagation();
			const items = [
				{ action: "chat", label: t("agentBots.menuChat"), hint: undefined },
				{ action: "new-chat", label: t("agentBots.menuNewChat"), hint: t("agentBots.menuNewChatTip") },
				{ action: "reference", label: t("agentBots.menuReference"), hint: undefined },
				{ action: "edit", label: t("agentBots.menuEdit"), hint: undefined },
				{ action: "manage", label: t("agentBots.menuManage"), hint: undefined },
				{ action: "memory", label: t("agentBots.menuMemory"), hint: undefined },
				{ action: "copy-id", label: t("agentBots.menuCopyId"), hint: undefined },
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
					else if (entry.action === "edit") requestBotEdit(bot.id);
					else if (entry.action === "manage") openBotManagement();
					else if (entry.action === "memory") setMemoryBot(bot);
					else if (entry.action === "copy-id") void copyTextToClipboard(bot.id);
				},
			});
		},
		[startChat, t],
	);

	if (!bots && !error) {
		return (
			<section className="lp-bots-section" aria-busy="true">
				<div className="lp-bots-header">
					<span className="lp-bots-title">
						<FiCpu aria-hidden="true" />
						{t("agentBots.title")}
					</span>
					<span className="lp-bots-loading">{t("agentBots.loading")}</span>
				</div>
			</section>
		);
	}

	return (
		<section className="lp-bots-section" aria-label={t("agentBots.title")}>
			<div className="lp-bots-header">
				<button
					type="button"
					className="lp-bots-toggle"
					aria-expanded={!collapsed}
					aria-label={collapsed ? t("agentBots.expand") : t("agentBots.collapse")}
					onClick={() => setCollapsed((value) => !value)}
				>
					{collapsed ? <FiChevronRight aria-hidden="true" /> : <FiChevronDown aria-hidden="true" />}
					<FiCpu aria-hidden="true" />
					<span className="lp-bots-title">{t("agentBots.title")}</span>
					{botCount(bots) > 0 && <span className="lp-bots-count">{botCount(bots)}</span>}
				</button>
				<div className="lp-bots-actions">
					<button
						type="button"
						className="lp-bots-manage"
						title={t("agentBots.manageTip")}
						aria-label={t("agentBots.manageTip")}
						onClick={openBotManagement}
					>
						<FiSettings aria-hidden="true" />
						<span>{t("agentBots.manage")}</span>
					</button>
					<button
						type="button"
						className="lp-bots-import"
						title={t("agentBots.createTitle")}
						aria-label={t("agentBots.createTitle")}
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
			{creating && (
				<form
					className="lp-bots-create"
					onSubmit={(event) => {
						event.preventDefault();
						void draftWithAi();
					}}
				>
					<label className="lp-bots-create-title" htmlFor="lp-bots-create-input">
						{t("agentBots.createTitle")}
					</label>
					<textarea
						id="lp-bots-create-input"
						className="lp-bots-create-input"
						value={createText}
						rows={2}
						placeholder={t("agentBots.createPlaceholder")}
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
							{createBusy ? t("agentBots.creating") : t("agentBots.createAi")}
						</button>
						<button
							type="button"
							className="lp-bots-create-secondary"
							disabled={createBusy}
							title={t("agentBots.createManual")}
							onClick={() => {
								// 手动兜底：就地弹「新建智能体」表单（不跳设备中心）。
								setCreating(false);
								setCreateText("");
								requestBotCreate();
							}}
						>
							{t("agentBots.createManual")}
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
							{t("agentBots.createCancel")}
						</button>
					</div>
				</form>
			)}
			{!collapsed && (
				<div className="lp-bots-body">
					{notice && <p className="lp-bots-notice">{notice}</p>}
					{error && (
						<div className="lp-bots-error">
							<span>{t("agentBots.failed")}</span>
							<button type="button" onClick={() => void load()}>
								{t("agentBots.retry")}
							</button>
						</div>
					)}
					{drafts.length > 0 && (
						<div className="lp-bot-drafts">
							<p className="lp-bot-drafts-title">{t("agentBots.drafts")}</p>
							<p className="lp-bot-drafts-hint">{t("agentBots.draftHint")}</p>
							{drafts.map((draft) => {
								const granted = grants[draft.id] ?? [];
								const ready = draft.highPrivilegeTools.every((tool) => granted.includes(tool));
								const busy = approving === draft.id;
								return (
									<div key={draft.id} className="lp-bot-draft">
										<div className="lp-bot-draft-head">
											<strong>{draft.name}</strong>
											<span className="lp-bot-draft-badge">
												{draft.trigger === "on_demand" ? t("agentBots.triggerOnDemand") : t("agentBots.triggerReserved")}
											</span>
										</div>
										<p className="lp-bot-draft-desc">{draft.description}</p>
										{draft.trigger !== "on_demand" && (
											<p className="lp-bot-draft-meta">{t("agentBots.triggerReservedHint", { trigger: draft.trigger })}</p>
										)}
										<p className="lp-bot-draft-meta" title={draft.cwd}>
											{t("agentBots.workspace")}: {draft.cwd}
										</p>
										{draft.rationale && <p className="lp-bot-draft-meta">{draft.rationale}</p>}
										{draft.tools.length > 0 && (
											<p className="lp-bot-draft-meta" title={draft.tools.join(", ")}>
												{t("agentBots.tools")}: {draft.tools.join(", ")}
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
										{draft.bootstrap && <p className="lp-bot-draft-meta">✓ {t("agentBots.bootstrap")}</p>}
										<div className="lp-bot-draft-actions">
											<button
												type="button"
												className="lp-bot-draft-primary"
												disabled={!ready || busy}
												onClick={() => void confirmDraft(draft)}
											>
												{busy ? t("agentBots.approving") : t("agentBots.approve")}
											</button>
											<button type="button" disabled={busy} onClick={() => void discardDraft(draft)}>
												{t("agentBots.discard")}
											</button>
										</div>
									</div>
								);
							})}
						</div>
					)}
					{!error && (!bots || bots.length === 0) && <p className="lp-bots-empty">{t("agentBots.empty")}</p>}
					{(bots ?? []).map((bot) => {
						// 高亮跟着"当前对话是不是这个 Bot 的私聊"走（普通会话 + Bot 绑定）。
						const isActive = activeBotId === bot.id;
						return (
							<div key={bot.id} className="lp-bot-item" onContextMenu={(event) => openBotMenu(event, bot)}>
								<button
									type="button"
									className={`lp-bot-row${isActive ? " is-active" : ""}`}
									title={t("agentBots.open", { name: bot.name })}
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
											{pending === bot.id ? t("agentBots.starting") : bot.online === false ? t("agentBots.offline") : (bot.deviceName ?? "Bot")}
										</span>
									</span>
								</button>
								<button
									type="button"
									className="lp-bot-memory"
									title={t("agentBots.memoryOpen")}
									aria-label={t("botMemory.title")}
									onClick={() => setMemoryBot(bot)}
								>
									🧠
								</button>
							</div>
						);
					})}
				</div>
			)}
			{memoryBot && (
				<BotMemoryDialog botId={memoryBot.id} botName={memoryBot.name} onClose={() => setMemoryBot(null)} />
			)}
			{manualOpen && <BotCreateDialog onClose={() => setManualOpen(false)} />}
		</section>
	);
}

function botCount(bots: BotRow[] | null): number {
	return bots?.length ?? 0;
}
