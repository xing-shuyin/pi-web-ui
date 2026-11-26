import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { FiChevronDown, FiChevronUp, FiCpu, FiSettings, FiUsers } from "react-icons/fi";
import { useFloatingPanel } from "../use-floating-panel";
import { appSend, useEngineCapabilities, useIsDsh } from "../app-globals";
import { useT, type Translate } from "../i18n";
import { DEVICE_GROUPS_CHANGED, deviceGroupRequest } from "./DeviceGroupSection";
import { openBotChat, openBotManagement } from "../bot-chat";
import { openContextMenu } from "../context-menu-state";
import type { UiSlotEntry } from "../ui-slots";
import { referenceBotInComposer } from "../bot-reference";
import { requestBotAiDraftMode, requestBotCreate, subscribeBotCreateRequest } from "../bot-create";
import { focusComposer } from "../composer-bridge";
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

/** 本区块的文案住在 `web/src/i18n/messages/agent-bots/`，键名统一 `agentBots*` 前缀。 */

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
	botDraftPrompt,
	botDraftDefaultPrompt,
}: {
	active?: boolean;
	/** 当前对话如果是某 Bot 的私聊，这里就是它的 id（私聊 = 普通对话 + Bot 身份）。 */
	activeBotId?: string | null;
	/** 当前项目（工作区）：新建 Bot 默认落在它下面，而不是服务端默认目录。 */
	cwd?: string | null;
	/** 设置中自定义的智能体生成提示词模板。 */
	botDraftPrompt?: string;
	/** 服务端下发的默认智能体生成提示词模板。 */
	botDraftDefaultPrompt?: string;
}) {
	const t = useT();
	const capabilities = useEngineCapabilities();
	const isDsh = useIsDsh();
	const [bots, setBots] = useState<BotRow[] | null>(null);
	const [memoryBot, setMemoryBot] = useState<BotRow | null>(null);
	const [historyBot, setHistoryBot] = useState<BotRow | null>(null);
	// 编辑就地弹窗（复用设备中心那份编辑器）：只存 id，不在左栏拼一份不完整的 Bot。
	const [editBotId, setEditBotId] = useState<string | null>(null);
	const [notice, setNotice] = useState("");
	// 加号 = 新建智能体：下拉选择「AI 创建」（新建临时对话并聚焦输入框）或「手动创建」。
	const [manualOpen, setManualOpen] = useState(false);
	const [createMenuOpen, setCreateMenuOpen] = useState(false);
	const createMenuAnchor = useRef<HTMLButtonElement | null>(null);
	const createMenu = useFloatingPanel({
		open: createMenuOpen,
		anchor: createMenuAnchor,
		onClose: () => setCreateMenuOpen(false),
		side: "top",
		align: "right",
	});
	const [error, setError] = useState("");
	const [collapsed, setCollapsed] = useState(false);
	const [pending, setPending] = useState<string | null>(null);
	const generation = useRef(0);

	// Bot 列表的唯一数据源是服务端本机面板（`/api/device-center/bot-panel`）：Bot 身份
	// 存在本机 `device-bots/`，Hub 只消费这份列表，离线不影响这块列表。
	const load = useCallback(async () => {
		const token = ++generation.current;
		const controller = new AbortController();
		try {
			const panel = await deviceGroupRequest<{
				bots?: BotRow[];
			}>("bot-panel", controller.signal);
			if (token !== generation.current) return;
			setBots((panel.bots ?? []).filter((bot) => bot.enabled).sort((a, b) => a.name.localeCompare(b.name)));
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
		return () => {
			window.removeEventListener(DEVICE_GROUPS_CHANGED, refresh);
			window.removeEventListener("pi-web-ui:device-bots-changed", refresh);
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
					<div className="lp-bots-create-wrap">
						<button
							type="button"
							ref={createMenuAnchor}
							className="lp-bots-import"
							title={t("agentBotsCreateTitle")}
							aria-label={t("agentBotsCreateTitle")}
							aria-expanded={createMenuOpen}
							aria-haspopup="menu"
							onClick={() => setCreateMenuOpen((value) => !value)}
						>
							＋
						</button>
						{createMenuOpen &&
							createPortal(
								<div ref={createMenu.panelRef} className="lp-bots-create-menu" style={createMenu.style} role="menu">
									<button
										type="button"
										role="menuitem"
										onClick={() => {
											setCreateMenuOpen(false);
											const useEphemeral = capabilities.ephemeralChat !== false && !isDsh;
											appSend(useEphemeral ? { type: "new_chat", ephemeral: true } : { type: "new_chat" });
											requestBotAiDraftMode();
											focusComposer();
										}}
									>
										{t("agentBotsCreateAi")}
									</button>
									<button
										type="button"
										role="menuitem"
										onClick={() => {
											setCreateMenuOpen(false);
											requestBotCreate();
										}}
									>
										{t("agentBotsCreateManual")}
									</button>
								</div>,
								document.body,
							)}
					</div>
				</div>
			</div>
			{/* 新建卡片与列表一起滚动：整个区块按内容高度排布，超过上限时只在内部滚。 */}
			<div className="lp-bots-scroll">
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
						{!error && !bots && <p className="lp-bots-empty">{t("agentBotsLoading")}</p>}
						{!error && bots && bots.length === 0 && <p className="lp-bots-empty">{t("agentBotsEmpty")}</p>}
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
