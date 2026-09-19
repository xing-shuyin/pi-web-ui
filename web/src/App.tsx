import {
	lazy,
	Suspense,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type CSSProperties,
	type PointerEvent as ReactPointerEvent,
} from "react";
import { TopBar } from "./components/TopBar";
import { LeftPanel } from "./components/LeftPanel";
import { RightPanel } from "./components/RightPanel";
import { MessageList } from "./components/MessageList";
import { ChatInput } from "./components/ChatInput";
import { GoalBar } from "./components/GoalBar";

import { FooterBar } from "./components/FooterBar";
import { Dialog } from "./components/Dialog";
import { DshQuestionDialog } from "./components/DshQuestionDialog";
// 终端视图懒加载：xterm.js 体积大且只在切到终端时才需要，拆出主包
const TerminalPanel = lazy(() => import("./components/TerminalPanel").then((m) => ({ default: m.TerminalPanel })));
import { ScmPanel } from "./components/SCMPanel";
import { PluginView } from "./components/PluginView";
import { PluginViewFallback } from "./components/PluginViewFallback";
import {
	createPluginHostApi,
	emitPluginHostLocale,
	emitPluginHostTheme,
	emitPluginHostView,
	installPluginHostApi,
	triggerPluginUiAction,
} from "./plugin-host";
import { buildUiSlots, withPluginViewItems, type UiSlotEntry } from "./ui-slots";
import { renderSlotToolbar } from "./slot-toolbar";
import { ContextMenu } from "./components/ContextMenu";
import { ensurePluginViewLoaded } from "./plugin-loader";
import { registerAttachmentSink } from "./composer-bridge";
import { appendDraftAttachments } from "./composer-draft";
import {
	syncPluginViews,
	subscribeLoadedPluginViews,
	subscribePluginLoadFailed,
	type LoadedPluginView,
} from "./plugin-loader";
import { setFenceSend, syncFenceRenderers, syncMessageWidgets } from "./plugin-fence";
import { PiSetupModal } from "./components/PiSetupModal";
import { ModelConfigModal } from "./components/ModelConfigModal";

import { SettingsModal } from "./components/SettingsModal";
import { BgTasksModal } from "./components/BgTasksModal";
import { GlobalSearchModal } from "./components/GlobalSearchModal";
import { PluginModal } from "./components/PluginModal";
import { TemplateProvider } from "./components/PromptTemplates";
import { FilePreview, type PreviewFile } from "./components/FilePreview";
import { useChat } from "./use-chat";
import { appUrl } from "./base-url";
import type { ClientMessage, CommandDef, PromptAttachment, UiMessage } from "./types";
import { useT, useI18n } from "./i18n";
import { QUICK_PHRASE_DEFAULTS } from "./quick-phrases";
import { FiAlertCircle, FiAlertTriangle, FiChevronsLeft, FiChevronsRight, FiInfo, FiX } from "react-icons/fi";
import type { Notice } from "./use-chat";
import { fileToProcessedImage, isRasterImage, type ProcessedImage } from "./image-paste";
import { randomUuid } from "./uuid";
import { recordModelUsage } from "./model-usage";
import { loadSoundSettings, playSound, saveSoundSettings, type SoundKind, type SoundSettings } from "./sounds";
import { useWideChat } from "./chat-width-settings";
import { projectNameFromCwd, useProjectTitle } from "./title-settings";
import { notify } from "./notify";
import { useTheme } from "./theme";
import { useWallpaperEffect } from "./wallpaper";

export interface PendingAttachment {
	path: string;
	name: string;
	/** "page" = 已授权给 AI 的网页（page-picker 扩展）：path 是页面 origin，
	 *  name 是页面标题，不会被当工作区路径处理。
	 *  "conversation" = 引用的另一个对话：path 不用，引用走 conversationId
	 *  （运行中，含子代理）或 sessionPath（历史转录），AI 经 conversation_read 读取。 */
	mode: "inline" | "reference" | "lines" | "page" | "conversation";
	/** mode "conversation" + 引用运行中对话的 id（如 "c3"）。 */
	conversationId?: string;
	/** mode "conversation" + 引用历史会话的转录文件 path。 */
	sessionPath?: string;
	/** Folder path link (always reference mode). */
	isDir?: boolean;
	/** 1-based inclusive line range (mode "lines" only). */
	lines?: { start: number; end: number };
	/** Raw pasted/dropped/uploaded image (no workspace path — `path` is ""). */
	imageData?: string;
	mimeType?: string;
	/** Raw uploaded file bytes (no workspace path — `path` is ""). */
	fileData?: string;
	size?: number;
	/** Stable dedupe/removal key for pasted images. */
	key?: string;
}

/** A single notice toast. Auto-dismisses after a level-dependent delay, but
 *  hovering PAUSES the timer (stays visible as long as the pointer is over it),
 *  resuming when the pointer leaves. Clicking the toast body does NOT hide it —
 *  only the × button dismisses (and the auto timer). */
function NoticeToast({ notice, onDismiss }: { notice: Notice; onDismiss: (id: number) => void }) {
	const t = useT();
	const { locale } = useI18n();
	const text = locale !== "zh" && notice.textEn ? notice.textEn : notice.text;
	const [paused, setPaused] = useState(false);
	useEffect(() => {
		if (paused) return;
		const t = setTimeout(() => onDismiss(notice.id), notice.level === "error" ? 12000 : 7000);
		return () => clearTimeout(t);
	}, [paused, notice.id, notice.level, onDismiss]);
	const Icon = notice.level === "error" ? FiAlertCircle : notice.level === "warning" ? FiAlertTriangle : FiInfo;
	return (
		<div
			className={`notice notice-${notice.level}${paused ? " paused" : ""}`}
			role="status"
			onMouseEnter={() => setPaused(true)}
			onMouseLeave={() => setPaused(false)}
		>
			<Icon className="notice-icon" />
			<span className="notice-text">{text}</span>
			<button type="button" className="notice-close" title={t("close")} onClick={() => onDismiss(notice.id)}>
				<FiX />
			</button>
		</div>
	);
}
/** Stable empty messages array — keeps the memoized ChatInput prop comparison
 *  cheap before the first snapshot arrives. */
const EMPTY_MESSAGES: UiMessage[] = [];

// ---- 可拖拽面板宽度（桌面端；≤768px 抽屉模式固定宽度不受影响）----
const PANEL_MIN = 180;
const PANEL_MAX = 520;
const PANEL_DEFAULT = 240;
type PanelSide = "left" | "right";
const panelWidthKey = (side: PanelSide) => `pi-web-ui:${side}-panel-width`;
function readPanelWidth(side: PanelSide): number {
	const v = Number(localStorage.getItem(panelWidthKey(side)));
	return Number.isFinite(v) && v >= PANEL_MIN && v <= PANEL_MAX ? v : PANEL_DEFAULT;
}
const panelCollapsedKey = (side: PanelSide) => `pi-web-ui:${side}-panel-collapsed`;
function readPanelCollapsed(side: PanelSide): boolean {
	return localStorage.getItem(panelCollapsedKey(side)) === "1";
}

/** 面板与主区之间的拖拽分隔条：拖动改宽度，双击复位。 */
function ResizeHandle({ side, width, onResize }: { side: PanelSide; width: number; onResize: (w: number) => void }) {
	const t = useT();
	const onPointerDown = useCallback(
		(e: ReactPointerEvent<HTMLDivElement>) => {
			e.preventDefault();
			const startX = e.clientX;
			const startW = width;
			let last = startW;
			const move = (ev: PointerEvent) => {
				// 左侧手柄向右拖变宽，右侧相反
				const delta = side === "left" ? ev.clientX - startX : startX - ev.clientX;
				last = Math.min(PANEL_MAX, Math.max(PANEL_MIN, Math.round(startW + delta)));
				onResize(last);
			};
			const up = () => {
				window.removeEventListener("pointermove", move);
				window.removeEventListener("pointerup", up);
				document.body.classList.remove("panel-resizing");
				localStorage.setItem(panelWidthKey(side), String(last));
			};
			window.addEventListener("pointermove", move);
			window.addEventListener("pointerup", up);
			document.body.classList.add("panel-resizing");
		},
		[side, width, onResize],
	);
	return (
		<div
			className={`resize-handle resize-${side}`}
			title={t("dragToResize")}
			onPointerDown={onPointerDown}
			onDoubleClick={() => onResize(PANEL_DEFAULT)}
		/>
	);
}

/** 面板折叠后留在原位置的展开条：贴在主区边缘，点击恢复面板。
 *  只在桌面端出现（移动端抽屉由顶栏按钮控制）。 */
function PanelRail({ side, onClick }: { side: PanelSide; onClick: () => void }) {
	const t = useT();
	return (
		<button type="button" className={`panel-rail panel-rail-${side}`} title={t("expandPanel")} onClick={onClick}>
			{side === "left" ? <FiChevronsRight /> : <FiChevronsLeft />}
		</button>
	);
}

/** 顶栏视图：内置三个 + 每个已装插件一个 `plugin:<id>`。 */
type ViewName = "chat" | "terminal" | "git" | `plugin:${string}`;

/**
 * 插件项目会话的目录授权（issue #146）：插件经 host.openSession 打开一个新目录的会话前，
 * 宿主必须先让用户点头；确认过的目录记在这里（localStorage，按浏览器），下次不再问。
 * 已在「最近项目」里的目录视为用户自己用过的，也不问。
 */
const PLUGIN_PATH_GRANTS_KEY = "pi-web-ui:plugin-path-grants";

function readPluginPathGrants(): string[] {
	try {
		const raw = localStorage.getItem(PLUGIN_PATH_GRANTS_KEY);
		const arr = raw ? (JSON.parse(raw) as unknown) : [];
		return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
	} catch {
		return [];
	}
}

function addPluginPathGrant(path: string): void {
	try {
		const next = [...new Set([...readPluginPathGrants(), path])];
		localStorage.setItem(PLUGIN_PATH_GRANTS_KEY, JSON.stringify(next));
	} catch {
		/* 隐私模式等：授权只在本次会话内有效 */
	}
}

export function App() {
	const t = useT();
	const { locale } = useI18n();
	const { chat, send, dismissNotice, pushNotice, terminal } = useChat();
	// 快捷短语 seeding：首次看到空列表 → 按界面语言填一批内置常用短语，之后即为用户
	// 数据（增删改/恢复默认/关闭都在设置里）。「已 seed」标记存服务端全局
	// （settings.quickPhrasesSeeded，非浏览器 localStorage）——clientId 在
	// sessionStorage、每次新会话都是新 id，若按浏览器记 seed，重启后删掉的默认
	// 短语又会被填回默认；存服务端则跨会话/跨浏览器一致。
	const quickSeedRef = useRef(false);
	useEffect(() => {
		if (!chat.ready || !chat.settings) return;
		if (quickSeedRef.current || chat.settings.quickPhrasesSeeded) return;
		quickSeedRef.current = true;
		if (chat.settings.quickPhrases.length === 0) {
			send({
				type: "set_settings",
				quickPhrases: QUICK_PHRASE_DEFAULTS[locale] ?? QUICK_PHRASE_DEFAULTS.en,
				quickPhrasesSeeded: true,
			});
		}
	}, [chat.ready, chat.settings, send, locale]);
	// 浏览器标题：开关开启时显示当前项目（工作目录文件夹名），否则固定应用名。
	const cwd = chat.state?.cwd ?? "";
	const projectTitle = useProjectTitle();
	useEffect(() => {
		const name = projectTitle ? projectNameFromCwd(cwd) : "";
		document.title = name ? `${name} — pi-web-ui` : t("docTitle");
	}, [cwd, projectTitle, t]);
	const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
	// 宿主注入的待发附件（浏览器元素拾取扩展的截图 → window.__piWebUiHost.compose）：
	// 只追加不覆盖，判重口径与下面的 attach() 一致（见 composer-draft.ts）。
	useEffect(() => {
		registerAttachmentSink((items) => setAttachments((prev) => appendDraftAttachments(prev, items)));
		return () => registerAttachmentSink(null);
	}, []);
	const [previewFile, setPreviewFile] = useState<PreviewFile | null>(null);
	/** Full-window file drag in progress (issue #19) — shows the app-wide
	 *  drop overlay; drop anywhere attaches, the input bar keeps priority via
	 *  its own stopPropagation handlers. */
	const [appDragOver, setAppDragOver] = useState(false);
	// 嵌套落点（输入条 / 消息编辑器）的 onDrop 会 stopPropagation（保优先级），
	// 父级 onDrop 就收不到 → 全屏遮罩会一直挂着。在 window 捕获阶段兜底复位：
	// 捕获先于任何子 handler 执行，只清提示、不碰落点处理。
	useEffect(() => {
		const clear = () => setAppDragOver(false);
		window.addEventListener("drop", clear, true);
		return () => window.removeEventListener("drop", clear, true);
	}, []);
	const [viewChosen, setView] = useState<ViewName>("chat");
	/* PI_WEB_TABS: a tab this instance does not offer cannot be shown, even if
	   something else asks for it — a plugin firing pi-web-ui:plugin-run-command,
	   or a panel's "open this in a terminal" button. The server refuses those
	   messages anyway, so the pane would sit there empty. No list means every
	   tab, which is the default. */
	const tabOn = (tab: string) => !chat.tabs || tab === "chat" || chat.tabs.includes(tab);
	const viewTab = viewChosen.startsWith("plugin:") ? "plugins" : viewChosen;
	const view: ViewName = tabOn(viewTab) ? viewChosen : "chat";
	// 已安装且未在设置面板禁用的插件（决定 tab 与视图加载）。
	const enabledPlugins = useMemo(
		() => chat.plugins.filter((p) => !chat.settings?.disabledPlugins?.includes(p.id)),
		[chat.plugins, chat.settings?.disabledPlugins],
	);
	// 插件贡献的顶栏条目（issue #146）：插件只声明，宿主渲染/排序/溢出；用户可在设置
	// 面板隐藏或调序（偏好 per-client 持久化）。顺序与设置面板里看到的一致。
	// 宿主 UI 扩展点全量计算（issue #146 完整版）：内置条目 + 插件贡献 + 插件 arrange
	// + 用户偏好（最高优先级）→ 每个 slot 的最终条目。渲染层只负责摆位置。
	const uiSlots = useMemo(
		() =>
			buildUiSlots(withPluginViewItems(chat.plugins), {
				locale,
				// Translate 的 key 是字面量联合类型，ui-slots 收的是 (key: string) => string
				t: (key: string) => t(key as Parameters<typeof t>[0]),
				disabledPlugins: chat.settings?.disabledPlugins ?? [],
				layout: chat.settings?.uiLayout,
			}),
		[chat.plugins, chat.settings?.disabledPlugins, chat.settings?.uiLayout, locale, t],
	);
	// 顶栏：主栏 = 非 hidden 的 topbar.primary；溢出 = hidden 的 primary + topbar.overflow。
	// 这样插件把宿主条目 hide 掉之后，它仍在溢出菜单/布局页里找得回来（锁不死用户）。
	const uiPrimary = useMemo(() => uiSlots["topbar.primary"].filter((e) => !e.hidden), [uiSlots]);
	const uiOverflow = useMemo(
		() => [...uiSlots["topbar.primary"].filter((e) => e.hidden), ...uiSlots["topbar.overflow"]],
		[uiSlots],
	);
	// 面板槽位（收尾接线）：非 hidden 条目直传面板，空数组时面板返回 null，DOM 与旧版一致。
	const uiLeftSessions = useMemo(() => uiSlots["leftpanel.sessions"].filter((e) => !e.hidden), [uiSlots]);
	const uiTerminalToolbar = useMemo(() => uiSlots["terminal.toolbar"].filter((e) => !e.hidden), [uiSlots]);
	const uiScmToolbar = useMemo(() => uiSlots["scm.toolbar"].filter((e) => !e.hidden), [uiSlots]);
	const uiGoalbarActions = useMemo(() => uiSlots["goalbar.actions"].filter((e) => !e.hidden), [uiSlots]);
	// P0 幽灵槽位接线：纯插件新增位，无条目时各渲染层返回 null，DOM 与旧版一致。
	const uiChatHeader = useMemo(() => uiSlots["chat.header"].filter((e) => !e.hidden), [uiSlots]);
	const uiChatEmpty = useMemo(() => uiSlots["chat.empty"].filter((e) => !e.hidden), [uiSlots]);
	const uiFilePreviewToolbar = useMemo(() => uiSlots["file.preview.toolbar"].filter((e) => !e.hidden), [uiSlots]);
	// DSH 预设名录 id→显示名（左栏徽标；dshPresets 对象不变时引用稳定，不破坏 LeftPanel memo）。
	const presetNames = useMemo(
		() => Object.fromEntries((chat.dshPresets?.presets ?? []).map((p) => [p.id, p.name ?? p.id])),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[chat.dshPresets],
	);
	const uiNoticeActions = useMemo(() => uiSlots["notice.actions"].filter((e) => !e.hidden), [uiSlots]);
	/** 点一个插件顶栏条目：缺省 action（或 "view"）由宿主切成插件视图；其余交给插件
	 *  （按需加载它的客户端 bundle；没人接管就提示一句，不让按钮看起来"点了没用"）。
	 *  kind="select" 的渲染层把选中的 value 经第二个参数传进来，转给插件 handler。 */
	const onUiAction = useCallback(
		(item: UiSlotEntry, value?: string, target?: { id: string; kind?: string; label?: string }) => {
			const action = (item.action ?? "").trim();
			// kind="view"（或缺省 action）：宿主自己切视图。
			if (item.kind === "view" || ((!action || action === "view") && item.source !== "host")) {
				setView((item.view ?? `plugin:${item.source.startsWith("plugin:") ? item.source.slice(7) : ""}`) as ViewName);
				return;
			}
			if (!action) return;
			const pluginId = item.source.startsWith("plugin:") ? item.source.slice(7) : "";
			void triggerPluginUiAction(pluginId, action, item.id, {
				...(value !== undefined ? { value } : {}),
				...(target !== undefined ? { target } : {}),
				loadBundle: async (pid) => {
					const info = chatRefForPlugins.current.plugins.find((x) => x.id === pid);
					if (!info) return false;
					return ensurePluginViewLoaded(info, chatRefForPlugins.current.pluginsEpoch);
				},
			}).then((handled) => {
				if (!handled) pushNotice("info", t("pluginUiNoHandler"));
			});
		},
		[t, pushNotice],
	);
	// 已加载的插件视图（bundle 动态 import 完成后出现）。
	const [pluginViews, setPluginViews] = useState<LoadedPluginView[]>([]);
	useEffect(() => subscribeLoadedPluginViews(setPluginViews), []);
	// issue #225：加载失败的插件视图 id —— 当前视图是没加载出来的插件时给明确占位，不再静默空白。
	const [failedPluginViews, setFailedPluginViews] = useState<string[]>([]);
	useEffect(() => subscribePluginLoadFailed(setFailedPluginViews), []);
	/** 插件弹窗（modal.dialog 槽位）：打开中的条目全局 id，同一时刻只开一个。
	 *  条目被隐藏/卸载后 openModalEntry 即 undefined，弹窗自动消失。 */
	const [openModalId, setOpenModalId] = useState<string | null>(null);
	/** 当前打开的弹窗条目：id 对不上 / 被隐藏后即 undefined，弹窗自动消失。 */
	const openModalEntry = openModalId
		? uiSlots["modal.dialog"].find((e) => e.id === openModalId && !e.hidden)
		: undefined;
	/** 弹窗条目归属的插件 id（view 显式指定优先，否则取贡献方）。 */
	const openModalPluginId = useMemo(() => {
		if (!openModalEntry || openModalEntry.kind !== "view") return "";
		const view = openModalEntry.view ?? "";
		if (view.startsWith("plugin:")) return view.slice("plugin:".length);
		if (openModalEntry.source.startsWith("plugin:")) return openModalEntry.source.slice("plugin:".length);
		return "";
	}, [openModalEntry]);
	// 弹窗里的 kind="view"：复用顶栏动作的按需加载（bundle 没进来先拉，好了重渲染即挂上）。
	useEffect(() => {
		if (!openModalEntry || !openModalPluginId) return;
		if (pluginViews.some((v) => v.info.id === openModalPluginId)) return;
		const info = chatRefForPlugins.current.plugins.find((x) => x.id === openModalPluginId);
		if (!info) return;
		void ensurePluginViewLoaded(info, chatRefForPlugins.current.pluginsEpoch);
	}, [openModalEntry, openModalPluginId, pluginViews, chat.pluginsEpoch]);
	// 目录清单/禁用集合/epoch 变化 → 同步注册表：新增的拉取、消失的清理
	// （React 卸载对应 PluginView 时调用插件的 cleanup）、服务端 reload 后重拉。
	// fenced-code 渲染插件：注入底层 send + 同步「语言→插件」注册表（renderer
	// 插件是命中了才懒加载，见 plugin-fence.ts / PluginFenceBlock.tsx）。
	useEffect(() => {
		setFenceSend(send);
		syncFenceRenderers(enabledPlugins, chat.pluginsEpoch);
		syncMessageWidgets(enabledPlugins, chat.pluginsEpoch);
		void syncPluginViews(enabledPlugins, chat.pluginsEpoch);
	}, [enabledPlugins, chat.pluginsEpoch, send]);
	// 插件宿主动作桥（window.__piWebUiHost）：插件 client bundle 拿不到 React 实例，
	// 需要「切视图 / 新建对话 + 自动发一段话」这类动作时走它（见 plugin-host.ts）。
	// deps 读的是 ref（挂载时装一次，不能把每次渲染的闭包困在里面）。
	const chatRefForPlugins = useRef(chat);
	chatRefForPlugins.current = chat;
	const setViewRefForPlugins = useRef(setView);
	setViewRefForPlugins.current = setView;
	// modal.dialog 的 openModal 校验要读最新合并结果（bridge deps 只装一次，走 ref）。
	const uiSlotsRef = useRef(uiSlots);
	uiSlotsRef.current = uiSlots;
	useEffect(() => {
		installPluginHostApi(
			createPluginHostApi({
				send,
				isReady: () => Boolean(chatRefForPlugins.current.state),
				setView: (v) => setViewRefForPlugins.current(v as ViewName),
				getCwd: () => chatRefForPlugins.current.state?.cwd ?? "",
				getWorkspaceRoots: () => chatRefForPlugins.current.state?.workspaceRoots ?? [],
				// host.sessions.list：只报「本会话现在能打开的东西」——运行中的对话 + 当前项目的历史会话。
				// 历史会话的 cwd 就是当前 cwd（服务端的 session 列表是按 cwd 扫的，见 sessions 快照）。
				listSessions: () => {
					const c = chatRefForPlugins.current;
					const cwd = c.state?.cwd ?? "";
					return [
						...c.conversations.map((x) => ({
							id: x.id,
							title: x.title,
							cwd: x.cwd || cwd,
							kind: "running" as const,
							isStreaming: x.isStreaming,
						})),
						...c.sessions.map((s) => ({
							id: s.path,
							title: s.name || s.firstMessage || s.path,
							cwd,
							kind: "history" as const,
						})),
					];
				},
				getConversationId: () => chatRefForPlugins.current.state?.conversationId ?? null,
				isConversationBlank: () => (chatRefForPlugins.current.state?.messages.length ?? 0) === 0,
				// issue #188：浏览器插件的模型目录 + 当前模型（startChat/openSession 的 model 选项用）。
				listModels: () =>
					chatRefForPlugins.current.models.map((m) => ({
						id: m.id,
						provider: m.provider,
						name: m.name,
						vision: m.vision,
						reasoning: m.reasoning,
					})),
				getCurrentModelId: () => chatRefForPlugins.current.state?.model?.id ?? null,
				// #146：目录授权（最近项目 = 用户已知；其余弹一次确认）+ 顶栏动作按需加载
				listProjects: () => chatRefForPlugins.current.projects.map((p) => p.path),
				grantedPaths: readPluginPathGrants,
				grantPath: addPluginPathGrant,
				confirm: (opts) => new Promise<boolean>((resolve) => setPluginPathConfirm({ path: opts.path, resolve })),
				// 宿主 API v10 弹窗（modal.dialog 槽位）：条目必须存在且未被隐藏，否则拒绝。
				openModal: (id) => {
					const target = String(id ?? "").trim();
					if (!target) return false;
					const entry = uiSlotsRef.current["modal.dialog"].find((e) => e.id === target);
					if (!entry || entry.hidden) return false;
					setOpenModalId(target);
					return true;
				},
				closeModal: () => setOpenModalId(null),
				// 宿主 API v8 对话框（本地插件对话框态撑起；已有未决直接回绝，不排队）。
				dialogConfirm: (opts) =>
					new Promise<boolean>((resolve) => {
						if (pluginDialogRef.current) {
							resolve(false);
							return;
						}
						const d = { kind: "confirm" as const, title: opts.title, resolve: resolve as (v: any) => void };
						pluginDialogRef.current = d;
						setPluginDialog(d);
					}),
				select: (opts) =>
					new Promise<{ ok: boolean; selected?: string[]; error?: string }>((resolve) => {
						if (pluginDialogRef.current) {
							resolve({ ok: false, error: "busy" });
							return;
						}
						const d = {
							kind: "select" as const,
							title: opts.title,
							options: opts.options,
							...(opts.multi ? { multi: true as const } : {}),
							resolve: resolve as (v: any) => void,
						};
						pluginDialogRef.current = d;
						setPluginDialogSel([]);
						setPluginDialog(d);
					}),
				input: (opts) =>
					new Promise<{ ok: boolean; value?: string; error?: string }>((resolve) => {
						if (pluginDialogRef.current) {
							resolve({ ok: false, error: "busy" });
							return;
						}
						const d = {
							kind: "input" as const,
							title: opts.title,
							...(typeof opts.placeholder === "string" ? { placeholder: opts.placeholder } : {}),
							...(typeof opts.initial === "string" ? { initial: opts.initial } : {}),
							resolve: resolve as (v: any) => void,
						};
						pluginDialogRef.current = d;
						setPluginDialogInput(opts.initial ?? "");
						setPluginDialog(d);
					}),
				// 宿主 API v8 动作通知（notice 区里多一行按钮；抛错一律 resolve null，不阻塞）。
				notifyAction: (opts) =>
					new Promise<string | null>((resolve) => {
						try {
							const prev = pluginNotifyRef.current;
							pluginNotifyRef.current = null;
							setPluginNotify(null);
							try {
								prev?.resolve(null);
							} catch {
								/* 忽略 */
							}
							const row = { text: opts.text, actions: opts.actions, resolve };
							pluginNotifyRef.current = row;
							setPluginNotify(row);
						} catch {
							resolve(null);
						}
					}),
				loadPluginBundle: (pluginId) => {
					const info = chatRefForPlugins.current.plugins.find((x) => x.id === pluginId);
					if (!info) return Promise.resolve(false);
					return ensurePluginViewLoaded(info, chatRefForPlugins.current.pluginsEpoch);
				},
			}),
		);
		return () => installPluginHostApi(null);
	}, [send]);
	// 左右面板可拖拽宽度（桌面端）：localStorage 持久化，双击手柄复位。
	const [leftWidth, setLeftWidth] = useState(() => readPanelWidth("left"));
	const [rightWidth, setRightWidth] = useState(() => readPanelWidth("right"));
	const resizeLeft = useCallback((w: number) => setLeftWidth(w), []);
	const resizeRight = useCallback((w: number) => setRightWidth(w), []);
	// 左右面板折叠状态（桌面端）：localStorage 持久化，点击面板内收起按钮折叠，
	// 靠边缘的展开条恢复；移动端抽屉不受影响（始终由顶栏按钮开关）。
	const [leftCollapsed, setLeftCollapsed] = useState(() => readPanelCollapsed("left"));
	const [rightCollapsed, setRightCollapsed] = useState(() => readPanelCollapsed("right"));
	const toggleLeft = useCallback(() => {
		setLeftCollapsed((v) => {
			localStorage.setItem(panelCollapsedKey("left"), v ? "0" : "1");
			return !v;
		});
	}, []);
	const toggleRight = useCallback(() => {
		setRightCollapsed((v) => {
			localStorage.setItem(panelCollapsedKey("right"), v ? "0" : "1");
			return !v;
		});
	}, []);
	// Mobile: which side panel is open as a drawer (null = both closed).
	const [drawer, setDrawer] = useState<"left" | "right" | null>(null);
	// Viewport class: ≤768px turns the side panels into sliding drawers
	// (matches the CSS breakpoint) — used to lazy-load panel data only when
	// a drawer is actually open on mobile.
	const [isMobile, setIsMobile] = useState(() => window.matchMedia("(max-width: 768px)").matches);
	useEffect(() => {
		const mq = window.matchMedia("(max-width: 768px)");
		const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
		mq.addEventListener("change", onChange);
		return () => mq.removeEventListener("change", onChange);
	}, []);
	// Setup modal: one-time prompt when the pi agent config is missing.
	const [setupDismissed, setSetupDismissed] = useState(false);
	// Custom model config panel (model dropdown → 管理模型).
	const [manageModelsOpen, setManageModelsOpen] = useState(false);
	// Settings panel (system prompt / skills / extensions / presets).
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [settingsInitialSection, setSettingsInitialSection] = useState<"plugins" | undefined>();
	// 插件请求目录授权时的确认（host.openSession，issue #146）——非模态 inline 面板。
	const [pluginPathConfirm, setPluginPathConfirm] = useState<{ path: string; resolve: (ok: boolean) => void } | null>(
		null,
	);
	// 插件宿主对话框（host.dialogs.*，API v8）：同一时刻只允许一个，
	// 已有未决时新请求直接回绝（confirm 回 false，select/input 回 {ok:false,error:"busy"}）。
	const [pluginDialog, setPluginDialog] = useState<{
		kind: "select" | "confirm" | "input";
		title: string;
		options?: { label: string; description?: string }[];
		multi?: boolean;
		placeholder?: string;
		initial?: string;
		resolve: (v: any) => void;
	} | null>(null);
	const pluginDialogRef = useRef<typeof pluginDialog>(null);
	const [pluginDialogSel, setPluginDialogSel] = useState<number[]>([]);
	const [pluginDialogInput, setPluginDialogInput] = useState("");
	// 插件动作通知（host.notifyAction，API v8）：notice 区追加一行动作按钮，
	// 点谁 resolve 谁的 id，8s 超时 resolve null；新通知挤掉旧未决（旧的 resolve null）。
	const [pluginNotify, setPluginNotify] = useState<{
		text: string;
		actions: { id: string; label: string }[];
		resolve: (v: string | null) => void;
	} | null>(null);
	const pluginNotifyRef = useRef<typeof pluginNotify>(null);
	// 服务端驱动的目录授权请求（host.fs.requestAccess / host.project）已在本地答过的 id：
	// 答完就地隐藏，服务端那边由它自己的 pending 表收尾（不需要额外回包）。
	const [answeredPathRequests, setAnsweredPathRequests] = useState<Set<string>>(() => new Set());
	const answerPathRequest = (id: string, ok: boolean) => {
		send({ type: "plugin_path_response", id, ok });
		setAnsweredPathRequests((prev) => new Set(prev).add(id));
	};
	const pendingPathRequest = chat.pathRequests.find((r) => !answeredPathRequests.has(r.id)) ?? null;
	// 服务端驱动的能力授权请求（host.requestPermission）：同目录授权的问答口径，
	// 多一个“记住”档（remember=true 落盘，否则只记内存本次有效）。
	const [answeredPermRequests, setAnsweredPermRequests] = useState<Set<string>>(() => new Set());
	const answerPermRequest = (id: string, ok: boolean, remember = false) => {
		send({ type: "plugin_permission_response", id, ok, ...(remember ? { remember: true } : {}) });
		setAnsweredPermRequests((prev) => new Set(prev).add(id));
	};
	const pendingPermRequest = chat.permRequests.find((r) => !answeredPermRequests.has(r.id)) ?? null;
	// Wide chat column (client-local, default off).
	const wide = useWideChat();
	// Background-task panel (AI-started servers — stop individually or all).
	const [bgTasksOpen, setBgTasksOpen] = useState(false);
	// Global search panel (sessions / projects / workspace files).
	const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
	/** 全局搜索「会话」结果点击后的跳转目标：切到该会话并定位到命中消息。
	 *  由 MessageList 消费（消息载入即跳转+高亮），跳完后置空。 */
	const [searchJump, setSearchJump] = useState<{
		path: string;
		role: string;
		timestamp: number;
	} | null>(null);
	// 兜底：跳转请求应在下次快照载入时即被 MessageList 消费；超过 15s 未消费
	//（用户中途切走会话等）则清空，避免陈旧目标挂起、日后误触发。
	useEffect(() => {
		if (!searchJump) return;
		const t = setTimeout(() => setSearchJump(null), 15_000);
		return () => clearTimeout(t);
	}, [searchJump]);

	// 插件视图桥：插件无 chat 上下文，通过窗口事件请求在可见终端执行命令
	// （与 SCM 面板同款：已有同名 tab 原地重跑，否则新建并自动切到终端视图）。
	useEffect(() => {
		const onPluginRunCommand = (e: Event) => {
			const detail = (e as CustomEvent<{ title?: string; command?: string }>).detail;
			const title = detail?.title || t("pluginCommandFallback");
			const command = detail?.command;
			if (!command || !chat.ready) return;
			const def: CommandDef = { name: title, command, cwd: "${pwd}" };
			const existing = chat.terminals.find((tm) => tm.title === title);
			if (existing) {
				terminal.restart(existing.id);
				send({
					type: "run_command",
					terminalId: existing.id,
					conversationId: existing.conversationId,
					command: def,
					cols: 80,
					rows: 24,
				});
			} else {
				const id = randomUuid();
				terminal.create({
					id,
					conversationId: chat.activeConversationId || chat.state?.conversationId || "",
					title,
					cwd: chat.state?.cwd ?? "",
					cols: 80,
					rows: 24,
					running: true,
					exitCode: null,
					command: def,
				});
			}
			setView("terminal");
		};
		window.addEventListener("pi-web-ui:plugin-run-command", onPluginRunCommand);
		// 派单卡片的「查看子代理」按钮：切到对应的子代理对话（与左栏点击同效果）。
		const onSwitchConversation = (e: Event) => {
			const id = (e as CustomEvent<string>).detail;
			if (typeof id === "string" && id) send({ type: "switch_conversation", id });
		};
		window.addEventListener("pi-web-ui:switch-conversation", onSwitchConversation);
		return () => {
			window.removeEventListener("pi-web-ui:plugin-run-command", onPluginRunCommand);
			window.removeEventListener("pi-web-ui:switch-conversation", onSwitchConversation);
		};
	}, [chat, terminal, send]);

	// Ctrl+K / Cmd+K opens global search (also reachable via the topbar button).
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "k") return;
			e.preventDefault();
			setGlobalSearchOpen((v) => !v);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	// -- sound notifications --------------------------------------------------
	const [sound, setSound] = useState<SoundSettings>(loadSoundSettings);
	// -- theme (whole stylesheet swap) ---------------------------------------
	const { themes, theme, switchTheme, reloadThemes } = useTheme();
	// -- chat wallpaper (message-list background image, issue #100) -------------
	useWallpaperEffect();
	// 插件宿主桥 v8：主题/语言/视图变化通知插件（各是独立 effect，按值触发；
	// 无订阅者时零开销，单个监听抛错不影响其余——见 plugin-host.ts 的 emit*）。
	useEffect(() => {
		try {
			if (typeof emitPluginHostTheme === "function") emitPluginHostTheme(theme ?? "");
		} catch {
			/* 插件监听抛错不影响宿主 */
		}
	}, [theme]);
	useEffect(() => {
		try {
			if (typeof emitPluginHostLocale === "function") emitPluginHostLocale(locale);
		} catch {
			/* 插件监听抛错不影响宿主 */
		}
	}, [locale]);
	useEffect(() => {
		try {
			if (typeof emitPluginHostView === "function") emitPluginHostView(view);
		} catch {
			/* 插件监听抛错不影响宿主 */
		}
	}, [view]);
	// 插件对话框 Esc 取消（按 kind 回取消值，绝不悬挂未决 promise）。
	useEffect(() => {
		if (!pluginDialog) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			const cur = pluginDialogRef.current;
			pluginDialogRef.current = null;
			setPluginDialog(null);
			try {
				if (!cur) return;
				if (cur.kind === "confirm") cur.resolve(false);
				else cur.resolve({ ok: false });
			} catch {
				/* 忽略 */
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [pluginDialog]);
	// 动作通知 8s 超时：无人点就 resolve null 并撤下（绝不阻塞插件）。
	useEffect(() => {
		if (!pluginNotify) return;
		const timer = setTimeout(() => {
			const cur = pluginNotifyRef.current;
			pluginNotifyRef.current = null;
			setPluginNotify(null);
			try {
				cur?.resolve(null);
			} catch {
				/* 忽略 */
			}
		}, 8000);
		return () => clearTimeout(timer);
	}, [pluginNotify]);
	const prevStreaming = useRef<boolean | null>(null);
	const prevDialogId = useRef<number | null>(null);
	const prevQuestionId = useRef<string | null>(null);
	const prevRemoteQuestionId = useRef<string | null>(null);
	const lastErrorNotice = useRef(0);
	// Remembers a terminal-view click made before the WebSocket is ready.
	const terminalOpenRequested = useRef(false);
	// Previous terminal list — drives the uninstall-finished watcher below.
	const prevTerminalsRef = useRef(chat.terminals);

	useEffect(() => {
		saveSoundSettings(sound);
	}, [sound]);

	// Maintenance watcher: when a `pi remove …` / `pi-web-ui install|uninstall …`
	// command tab transitions running → exited, re-discover extensions/skills
	// (extensions_reload) or re-scan the UI-plugin dir (plugins_reload).
	useEffect(() => {
		const prev = prevTerminalsRef.current;
		prevTerminalsRef.current = chat.terminals;
		for (const tm of chat.terminals) {
			const cmd = tm.command?.command ?? "";
			const before = prev.find((p) => p.id === tm.id);
			if (!before?.running || tm.running) continue;
			if (cmd.startsWith("pi remove ")) {
				send({ type: "extensions_reload" });
			} else if (cmd.startsWith("pi-web-ui install ") || cmd.startsWith("pi-web-ui uninstall ")) {
				send({ type: "plugins_reload" });
			} else if (cmd.startsWith("npm i -g ")) {
				// A component update ran in the visible terminal (per-row "更新"
				// or "全部更新" buttons): re-discover extensions + UI plugins and
				// re-check versions so the dropdown reflects the new state.
				send({ type: "extensions_reload" });
				send({ type: "plugins_reload" });
				send({ type: "check_updates_all", force: true });
			}
		}
	}, [chat.terminals, send]);

	// Run start / end cues (streaming edge transitions).
	useEffect(() => {
		const streaming = chat.state?.isStreaming ?? false;
		const prev = prevStreaming.current;
		prevStreaming.current = streaming;
		if (prev === null) return; // first observation — don't cue
		if (!prev && streaming) playSound("start", sound);
		else if (prev && !streaming) {
			playSound("done", sound);
			// OS/PWA notification for when the user stepped away (not focused).
			void notify(t("notifyDoneTitle"), t("notifyDoneBody"));
		}
	}, [chat.state?.isStreaming, sound]);

	// Questionnaire cue — each new dialog id + each new DSH question id.
	// dialog = 扩展 select/confirm/input；question = ask_user_question 问卷。
	// 之前只监听了 dialog，问卷出来没有提示音（issue：当前问卷出来没有问卷的提示音）。
	useEffect(() => {
		const id = chat.dialog?.id ?? null;
		if (id !== null && id !== prevDialogId.current) {
			playSound("question", sound);
			void notify(t("notifyQuestionTitle"), t("notifyQuestionBody"));
		}
		prevDialogId.current = id;
	}, [chat.dialog, sound]);

	useEffect(() => {
		const qid = chat.question?.id ?? null;
		const rid = chat.remoteQuestion ? `${chat.remoteQuestion.owner}:${chat.remoteQuestion.id}` : null;
		if (qid !== null && qid !== prevQuestionId.current) {
			playSound("question", sound);
			void notify(t("notifyQuestionTitle"), t("notifyQuestionBody"));
		}
		if (rid !== null && rid !== prevRemoteQuestionId.current) {
			// 跨页问卷到了本页：同样响铃 + 通知（这正是手机端要的提醒）。
			playSound("question", sound);
			void notify(t("notifyQuestionTitle"), t("notifyQuestionBody"));
		}
		prevQuestionId.current = qid;
		prevRemoteQuestionId.current = rid;
	}, [chat.question, chat.remoteQuestion, sound]);

	// Error cue — new error notices only.
	useEffect(() => {
		const err = [...chat.notices].reverse().find((n) => n.level === "error");
		if (err && err.id !== lastErrorNotice.current) {
			lastErrorNotice.current = err.id;
			playSound("error", sound);
			void notify(t("notifyErrorTitle"), t("notifyErrorBody"));
		}
	}, [chat.notices, sound]);
	// live-preview 工具的自动开页：工具结果末尾的确定性链接行即标记（渲染出来本身
	// 也是可点兜底）。消息 id 去重（重连重放不二次开）；多标签页只让当前聚焦的开，
	// 没焦点/弹窗被拦时推一条带地址的 notice（聊天里的链接照样可点）。
	const openedPreviewIds = useRef<Set<string>>(new Set());
	useEffect(() => {
		const msgs = chat.state?.messages ?? [];
		for (const m of msgs) {
			if (m.toolName !== "live_preview" || openedPreviewIds.current.has(m.id)) continue;
			openedPreviewIds.current.add(m.id);
			let url = "";
			for (const b of m.content ?? []) {
				if ((b as { type?: string }).type !== "text") continue;
				const hit = /🔗 已自动在浏览器打开\]\((\/[^)\s]+)\)/.exec((b as { text?: string }).text ?? "");
				if (hit?.[1]) {
					url = hit[1];
					break;
				}
			}
			if (!url) continue;
			let opened: Window | null = null;
			try {
				if (document.hasFocus()) opened = window.open(appUrl(url), "_blank", "noopener");
			} catch {
				opened = null;
			}
			if (!opened) pushNotice("info", url);
		}
	}, [chat.state?.messages, pushNotice]);

	const attach = (
		path: string,
		name: string,
		mode: "inline" | "reference" | "lines" | "page",
		isDir = false,
		lines?: { start: number; end: number },
	) => {
		// Dedupe on path + mode + line range so the same file can be attached
		// multiple ways (e.g. full content AND a line range) without doubling.
		const key = `${path}|${mode}|${lines ? `${lines.start}-${lines.end}` : ""}`;
		setAttachments((prev) =>
			prev.some((a) => `${a.path}|${a.mode}|${a.lines ? `${a.lines.start}-${a.lines.end}` : ""}` === key)
				? prev
				: [...prev, { path, name, mode, isDir, ...(lines ? { lines } : {}) }],
		);
	};
	const removeAttachment = (pathOrKey: string) =>
		setAttachments((prev) =>
			prev.filter((a) => {
				if (a.key) return a.key !== pathOrKey;
				// 对话引用 chip 的 path 为空：按引用身份比对（与 ChatInput 的 key 口径一致）。
				if (a.mode === "conversation") return `conv|${a.conversationId ?? ""}|${a.sessionPath ?? ""}` !== pathOrKey;
				return a.path !== pathOrKey;
			}),
		);

	// Side panels live in mobile drawers — any action inside them (session
	// switch, cwd change, file list…) should close the drawer. Stable wrapper
	// so RightPanel's polling effect doesn't churn (send is stable).
	const panelSend = useCallback(
		(msg: ClientMessage) => {
			// Only close the mobile drawer on an explicit navigation/action. Mounting
			// LeftPanel fires read-only list_* probes that must NOT collapse the
			// freshly-opened drawer (they run through panelSend too). Otherwise the
			// drawer opens and immediately snaps shut.
			if (!msg.type.startsWith("list_") && !msg.type.startsWith("get_")) {
				setDrawer(null);
			}
			return send(msg);
		},
		[send],
	);

	// -- pasted / dropped / uploaded images (no workspace path) ---------------
	const pasteImageId = useRef(0);
	const lastVisionWarn = useRef(0);
	const attachImage = (img: ProcessedImage) => {
		// Warn when the current model can't see images — the image would still
		// be attached but silently ignored by the provider. Throttled so adding
		// several images at once produces one notice, not a stack.
		const now = Date.now();
		if (chat.state?.model && !chat.state.model.vision) {
			if (now - lastVisionWarn.current > 10000) {
				lastVisionWarn.current = now;
				pushNotice("warning", t("imageNotSupported"));
			}
		}
		const key = `paste-${++pasteImageId.current}`;
		setAttachments((prev) => [
			...prev,
			{
				path: "",
				key,
				name: img.name,
				mode: "inline",
				imageData: img.data,
				mimeType: img.mimeType,
			},
		]);
	};
	const addImageFiles = async (files: File[]) => {
		for (const f of files) {
			const img = await fileToProcessedImage(f);
			if (!img) {
				pushNotice("error", t("imageLoadFailed", { name: f.name }));
				continue;
			}
			attachImage(img);
		}
	};

	// -- dropped / uploaded files (any type, no workspace path) ---------------
	/** Keep in sync with MAX_UPLOAD_BYTES in agent-service.ts. */
	const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
	const uploadId = useRef(0);
	const attachLocalFile = async (f: File) => {
		if (f.size > MAX_UPLOAD_BYTES) {
			pushNotice("warning", t("fileTooLarge", { name: f.name, size: MAX_UPLOAD_BYTES / 1024 / 1024 }));
			return;
		}
		let base64: string;
		try {
			const dataUrl = await new Promise<string>((res, rej) => {
				const r = new FileReader();
				r.onload = () => res(r.result as string);
				r.onerror = () => rej(r.error ?? new Error("read failed"));
				r.readAsDataURL(f);
			});
			base64 = dataUrl.replace(/^data:[^;]*;base64,/, "");
		} catch {
			pushNotice("error", t("fileLoadFailed", { name: f.name }));
			return;
		}
		const key = `upload-${++uploadId.current}`;
		setAttachments((prev) => [
			...prev,
			{
				path: "",
				key,
				name: f.name,
				mode: "inline",
				fileData: base64,
				size: f.size,
				mimeType: f.type || undefined,
			},
		]);
	};
	const addLocalFiles = async (files: File[]) => {
		for (const f of files) {
			// Raster images go through the resize/encode pipeline (vision content);
			// everything else — including SVG — is uploaded raw and attached by path.
			if (isRasterImage(f.type)) {
				await addImageFiles([f]);
			} else {
				await attachLocalFile(f);
			}
		}
	};

	// Edit-and-re-ask: the server forks a new session at that message and re-asks
	// the edited text there (stable callback — Message is memoized). Attachments
	// carry the question's original images (fork drops their aside cards) plus
	// any newly pasted/dropped ones — same pipeline as a normal prompt.
	const onEditMessage = useCallback(
		(messageId: string, text: string, attachments?: PromptAttachment[]) => {
			send({ type: "edit_message", messageId, text, attachments });
		},
		[send],
	);

	// Remove one queued prompt (the ✕ on a pending bubble). `index` = bubble position.
	const onRemoveQueued = useCallback(
		(kind: "steer" | "followUp", text: string, index: number) => {
			send({ type: "queue_remove", kind, text, index });
		},
		[send],
	);

	// 撤回一条排队/插队消息：先从队列移除（同 ✕ 的协议），再把文字放回输入框。
	// ChatInput 内部持有 text state，这里用数组递过去（seq 递增；数组保证连续点两条不丢第一条）。
	const [recallDrafts, setRecallDrafts] = useState<{ text: string; seq: number }[]>([]);
	const recallSeqRef = useRef(0);
	const onRecallQueued = useCallback(
		(kind: "steer" | "followUp", text: string, index: number) => {
			send({ type: "queue_remove", kind, text, index });
			recallSeqRef.current += 1;
			const item = { text, seq: recallSeqRef.current };
			setRecallDrafts((prev) => [...prev.slice(-9), item]);
		},
		[send],
	);

	// Stable callbacks for memoized panels (LeftPanel/RightPanel/ChatInput/
	// GoalBar skip re-render while tokens stream in — inline closures here
	// would break their shallow prop comparison every render).
	const openManageModels = useCallback(() => setManageModelsOpen(true), []);
	const clearAttachments = useCallback(() => setAttachments([]), []);
	const removeAttachmentCb = useCallback(removeAttachment, []);
	const addImageFilesCb = useCallback(addImageFiles, [addImageFiles]);
	const addLocalFilesCb = useCallback(addLocalFiles, [addLocalFiles]);
	const searchFilesCb = useCallback(
		(reqId: number, query: string) => send({ type: "search_files", reqId, query }),
		[send],
	);
	// `@` 提及命中带的路径附件（mode 缺省 reference；去重由 attach 内处理）。
	const addPathAttachmentCb = useCallback(
		(a: {
			path: string;
			name: string;
			mode?: "inline" | "reference" | "lines" | "page";
			isDir?: boolean;
			lines?: { start: number; end: number };
		}) => attach(a.path, a.name, a.mode ?? "reference", a.isDir ?? false, a.lines),
		// eslint-disable-next-line react-hooks/exhaustive-deps -- attach 只用 setAttachments（稳定），跟随其余 Cb 同口径
		[],
	);

	// Narrow snapshot of the model/thinking fields for the memoized ChatInput →
	// ModelThinking chain; identity is stable while tokens stream in.
	const model = chat.state?.model;
	const thinkingLevel = chat.state?.thinkingLevel;
	const availableThinkingLevels = chat.state?.availableThinkingLevels;
	const modelState = useMemo(
		() =>
			model
				? {
						model,
						thinkingLevel: thinkingLevel ?? "off",
						availableThinkingLevels: availableThinkingLevels ?? [],
					}
				: null,
		// Deps are the STABLE inner refs (server reuses them across snapshots),
		// so the object identity survives token deltas and ChatInput's memo holds.
		[model, thinkingLevel, availableThinkingLevels],
	);

	const createShell = useCallback(() => {
		if (!chat.ready || chat.terminals.length !== 0) return false;
		terminal.create({
			id: randomUuid(),
			conversationId: chat.activeConversationId || chat.state?.conversationId || "",
			title: t("terminalTitle", { n: 1 }),
			cwd: chat.state?.cwd ?? "",
			cols: 80,
			rows: 24,
			running: true,
			exitCode: null,
		});
		return true;
	}, [chat.ready, chat.state?.cwd, chat.terminals.length, t, terminal]);

	// If the user clicked Terminal while the initial connection was still
	// loading, complete that request as soon as the session becomes ready.
	useEffect(() => {
		if (!terminalOpenRequested.current) return;
		if (view !== "terminal" || chat.terminals.length !== 0) {
			terminalOpenRequested.current = false;
			return;
		}
		if (createShell()) terminalOpenRequested.current = false;
	}, [chat.terminals.length, createShell, view]);

	return (
		// Whole window is a drop target (issue #19): dragover highlights + any
		// drop attaches. The plain preventDefault used to merely stop the browser
		// navigating away; children with their own handlers (input bar / edit
		// composer) call stopPropagation and keep priority.
		<div
			className="app"
			data-pi-anchor="app"
			onDragOver={(e) => {
				if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
				e.preventDefault();
				setAppDragOver(true);
			}}
			onDragLeave={(e) => {
				if (!e.currentTarget.contains(e.relatedTarget as Node)) setAppDragOver(false);
			}}
			onDrop={(e) => {
				setAppDragOver(false);
				if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
				e.preventDefault();
				const files = Array.from(e.dataTransfer?.files ?? []);
				if (files.length === 0) {
					pushNotice("warning", t("foldersNotSupported"));
					return;
				}
				// Same split as ChatInput.handleFiles: raster images go through
				// the vision pipeline, everything else uploads as a raw file.
				const images = files.filter((f) => isRasterImage(f.type));
				const others = files.filter((f) => !isRasterImage(f.type));
				if (images.length > 0) void addImageFiles(images);
				if (others.length > 0) void addLocalFiles(others);
			}}
		>
			{appDragOver && (
				<div className="app-drop-overlay" aria-hidden>
					<span>📎 {t("dropHereToAttach")}</span>
				</div>
			)}
			<TopBar
				chat={chat}
				terminal={terminal}
				view={view}
				plugins={enabledPlugins}
				uiPrimary={uiPrimary}
				uiOverflow={uiOverflow}
				uiContextTopbar={uiSlots["contextmenu.topbar"]}
				onUiAction={onUiAction}
				onViewChange={(v: ViewName) => {
					// The terminal panel stays mounted while hidden. Create the first
					// shell on the user's terminal-view click, not on initial mount.
					terminalOpenRequested.current = v === "terminal" && chat.terminals.length === 0;
					if (terminalOpenRequested.current && createShell()) {
						terminalOpenRequested.current = false;
					}
					setView(v);
					setDrawer(null);
				}}
				onOpenPanel={setDrawer}
				onOpenSettings={() => {
					setSettingsInitialSection(undefined);
					setSettingsOpen(true);
				}}
				onManagePlugins={() => {
					setSettingsInitialSection("plugins");
					setSettingsOpen(true);
				}}
				onOpenBgTasks={() => setBgTasksOpen(true)}
				onOpenGlobalSearch={() => setGlobalSearchOpen(true)}
				sound={sound}
				onSoundChange={setSound}
				onSoundPreview={(kind: SoundKind) => playSound(kind, sound)}
				themes={themes}
				theme={theme}
				onThemeChange={switchTheme}
				reloadThemes={reloadThemes}
			/>
			{chat.protocolMismatch && <div className="protocol-banner">⚠ {t("protocolMismatch")}</div>}
			<div className="notices">
				{chat.notices.map((n) => (
					<NoticeToast key={n.id} notice={n} onDismiss={dismissNotice} />
				))}
				{/* 插件动作通知（host.notifyAction）：复用 notice 渲染位置，点谁 resolve 谁的 id */}
				{pluginNotify && (
					<div className="notice notice-info" role="status">
						<span className="notice-text">{pluginNotify.text}</span>
						{pluginNotify.actions.map((a) => (
							<button
								key={a.id}
								type="button"
								className="btn"
								onClick={() => {
									const cur = pluginNotifyRef.current;
									pluginNotifyRef.current = null;
									setPluginNotify(null);
									try {
										cur?.resolve(a.id);
									} catch {
										/* 忽略 */
									}
								}}
							>
								{a.label}
							</button>
						))}
						<button
							type="button"
							className="notice-close"
							title={t("close")}
							onClick={() => {
								const cur = pluginNotifyRef.current;
								pluginNotifyRef.current = null;
								setPluginNotify(null);
								try {
									cur?.resolve(null);
								} catch {
									/* 忽略 */
								}
							}}
						>
							<FiX />
						</button>
					</div>
				)}
				{/* 插件通知条目（notice.actions 槽位）：常驻快捷按钮，无条目时不渲染。select 落成小下拉。 */}
				{uiNoticeActions.length > 0 && (
					<div className="notice-actions" role="toolbar">
						{uiNoticeActions.map((entry) =>
							entry.kind === "select" && entry.options?.length ? (
								<select
									key={entry.id}
									className="btn btn-slot notice-select"
									title={entry.hint ?? entry.label}
									aria-label={entry.label}
									value={
										entry.options.some((o) => o.value === entry.value)
											? (entry.value as string)
											: entry.options[0]!.value
									}
									onChange={(e) => onUiAction(entry, e.target.value)}
								>
									{entry.options.map((o) => (
										<option key={o.value} value={o.value}>
											{o.label}
										</option>
									))}
								</select>
							) : (
								<button
									key={entry.id}
									type="button"
									className="btn btn-slot"
									title={entry.hint ?? entry.label}
									onClick={() => onUiAction(entry)}
								>
									{entry.icon ? `${entry.icon} ` : ""}
									{entry.badge ?? entry.label}
								</button>
							),
						)}
					</div>
				)}
			</div>
			<TemplateProvider currentModelId={model ? `${model.provider}/${model.id}` : null}>
				<div
					className="layout"
					style={{ "--left-w": `${leftWidth}px`, "--right-w": `${rightWidth}px` } as CSSProperties}
				>
					{drawer && <div className="drawer-backdrop" onClick={() => setDrawer(null)} />}
					<div className={`view-pane ${view === "chat" ? "" : "hidden"}`}>
						{!isMobile && leftCollapsed && <PanelRail side="left" onClick={toggleLeft} />}
						<div
							className={`panel-drawer drawer-left ${drawer === "left" ? "open" : ""}${
								isMobile ? "" : leftCollapsed ? " hidden" : ""
							}`}
						>
							<LeftPanel
								collapsible={!isMobile}
								onToggleCollapse={toggleLeft}
								panelSend={panelSend}
								active={!isMobile || drawer === "left"}
								sessionFile={chat.state?.sessionFile ?? null}
								conversations={chat.conversations}
								elsewhere={chat.elsewhere}
								sessions={chat.sessions}
								projects={chat.projects}
								pathCompletions={chat.pathCompletions}
								activeConversationId={chat.activeConversationId}
								/* 宿主 UI 扩展点（contextmenu.session）：条目由 buildUiSlots 算好，左栏只管开菜单 +
								   分派它自己的两条内置项（host:conv-dismiss-subagents / host:conv-force-dismiss）。 */
								uiContextSession={uiSlots["contextmenu.session"]}
								uiLeftSessions={uiLeftSessions}
								onUiAction={onUiAction}
								presetNames={presetNames}
							/>
						</div>
						{!isMobile && <ResizeHandle side="left" width={leftWidth} onResize={resizeLeft} />}
						<main className={wide ? "main wide-chat" : "main"}>
							{/* 对话头部条（chat.header 槽位）：纯插件新增位，无条目时不渲染。 */}
							{uiChatHeader.length > 0 && (
								<div className="chat-header" role="toolbar">
									{renderSlotToolbar(uiChatHeader, onUiAction)}
								</div>
							)}
							{chat.state ? (
								<MessageList
									uiMessageActions={uiSlots["message.actions"]}
									uiContextMessage={uiSlots["contextmenu.message"]}
									uiChatEmpty={uiChatEmpty}
									onUiAction={onUiAction}
									key={chat.state.conversationId ?? "boot"}
									state={chat.state}
									liveOutputs={chat.liveOutputs}
									toolStatuses={chat.toolStatuses}
									onEdit={onEditMessage}
									onKillBash={() => send({ type: "abort_bash" })}
									onRetry={() => {
										// 重试沿用当前模型续跑上一轮请求，同样算一次模型使用（下拉按次数排序）。
										if (send({ type: "retry_last" })) {
											const m = chat.state?.model;
											if (m) recordModelUsage(`${m.provider}/${m.id}`);
										}
									}}
									onRemoveQueued={onRemoveQueued}
									onRecallQueued={onRecallQueued}
									thinkingWrap={chat.settings?.thinkingWrap ?? true}
									toolsWrap={chat.settings?.toolsWrap ?? true}
									jumpTarget={searchJump}
									onJumpDone={() => setSearchJump(null)}
								/>
							) : (
								<div className="boot-wait">{chat.ready ? t("loadingSession") : t("connectingServer")}</div>
							)}

							{chat.settings?.goalModeEnabled !== false && (
								<GoalBar
									goal={chat.goal}
									models={chat.models}
									modelsLoading={chat.modelsLoading}
									activeConversationId={chat.activeConversationId}
									uiGoalbarActions={uiGoalbarActions}
									onUiAction={onUiAction}
								/>
							)}
							{/* 扩展问卷：非模态内联面板，插在输入框上方，对话内容保持可见 */}
							{/* 通用右键菜单（contextmenu.* 槽位）：各处的 onContextMenu 打开它。 */}
							<ContextMenu onAction={(entry, target, value) => onUiAction(entry, value, target)} />
							{chat.dialog && <Dialog dialog={chat.dialog} />}
							{/* 本地插件对话框（host.dialogs.*）：复用 .dialog-inline 样式，按钮 resolve 后清态 */}
							{pluginDialog && (
								<div className="dialog-inline" data-dialog-kind={pluginDialog.kind}>
									<div className="dialog-head">
										<span className="dialog-badge">{t("pluginRequest")}</span>
										{pluginDialog.title && <span className="dialog-title">{pluginDialog.title}</span>}
										<button
											type="button"
											className="dialog-dismiss"
											title={t("cancel")}
											onClick={() => {
												const cur = pluginDialogRef.current;
												pluginDialogRef.current = null;
												setPluginDialog(null);
												try {
													if (cur?.kind === "confirm") cur.resolve(false);
													else cur?.resolve({ ok: false });
												} catch {
													/* 忽略 */
												}
											}}
										>
											✕
										</button>
									</div>
									{pluginDialog.kind === "select" && (
										<div className="dialog-options">
											{(pluginDialog.options ?? []).map((opt, i) => {
												const sel = pluginDialog.multi ? pluginDialogSel.includes(i) : false;
												return (
													<button
														type="button"
														key={i}
														className={`dialog-option ${sel ? "sel" : ""}`}
														title={opt.description}
														onClick={() => {
															if (pluginDialog.multi) {
																setPluginDialogSel((prev) =>
																	prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i],
																);
																return;
															}
															const cur = pluginDialogRef.current;
															pluginDialogRef.current = null;
															setPluginDialog(null);
															try {
																cur?.resolve({ ok: true, selected: [opt.label] });
															} catch {
																/* 忽略 */
															}
														}}
													>
														{opt.label}
														{opt.description && <span className="dialog-hint">{opt.description}</span>}
													</button>
												);
											})}
											{(pluginDialog.options ?? []).length === 0 && <div className="dialog-hint">{t("noOptions")}</div>}
											{pluginDialog.multi && (
												<div className="dialog-actions">
													<button
														type="button"
														className="btn primary"
														onClick={() => {
															const cur = pluginDialogRef.current;
															const labels = (cur?.options ?? [])
																.filter((_, idx) => pluginDialogSel.includes(idx))
																.map((o) => o.label);
															pluginDialogRef.current = null;
															setPluginDialog(null);
															try {
																cur?.resolve({ ok: true, selected: labels });
															} catch {
																/* 忽略 */
															}
														}}
													>
														{t("ok")}
													</button>
												</div>
											)}
										</div>
									)}
									{pluginDialog.kind === "confirm" && (
										<div className="dialog-body">
											<div className="dialog-actions">
												<button
													type="button"
													className="btn"
													onClick={() => {
														const cur = pluginDialogRef.current;
														pluginDialogRef.current = null;
														setPluginDialog(null);
														try {
															cur?.resolve(false);
														} catch {
															/* 忽略 */
														}
													}}
												>
													{t("cancel")}
												</button>
												<button
													type="button"
													className="btn primary"
													onClick={() => {
														const cur = pluginDialogRef.current;
														pluginDialogRef.current = null;
														setPluginDialog(null);
														try {
															cur?.resolve(true);
														} catch {
															/* 忽略 */
														}
													}}
												>
													{t("ok")}
												</button>
											</div>
										</div>
									)}
									{pluginDialog.kind === "input" && (
										<div className="dialog-body">
											<input
												className="dialog-input"
												value={pluginDialogInput}
												placeholder={pluginDialog.placeholder || t("inputPlaceholder")}
												autoFocus
												onChange={(e) => setPluginDialogInput(e.target.value)}
												onKeyDown={(e) => {
													if (e.key === "Enter" && !e.nativeEvent.isComposing) {
														const cur = pluginDialogRef.current;
														pluginDialogRef.current = null;
														setPluginDialog(null);
														try {
															cur?.resolve({ ok: true, value: pluginDialogInput });
														} catch {
															/* 忽略 */
														}
													}
												}}
											/>
											<div className="dialog-actions">
												<button
													type="button"
													className="btn"
													onClick={() => {
														const cur = pluginDialogRef.current;
														pluginDialogRef.current = null;
														setPluginDialog(null);
														try {
															cur?.resolve({ ok: false });
														} catch {
															/* 忽略 */
														}
													}}
												>
													{t("cancel")}
												</button>
												<button
													type="button"
													className="btn primary"
													onClick={() => {
														const cur = pluginDialogRef.current;
														pluginDialogRef.current = null;
														setPluginDialog(null);
														try {
															cur?.resolve({ ok: true, value: pluginDialogInput });
														} catch {
															/* 忽略 */
														}
													}}
												>
													{t("ok")}
												</button>
											</div>
										</div>
									)}
								</div>
							)}
							{pendingPermRequest && (
								<div className="dialog-inline" data-dialog-kind="confirm">
									<div className="dialog-head">
										<span className="dialog-badge">{t("pluginRequest")}</span>
										<span className="dialog-title">{t("pluginPermTitle")}</span>
										<button
											type="button"
											className="dialog-dismiss"
											title={t("cancel")}
											onClick={() => answerPermRequest(pendingPermRequest.id, false)}
										>
											✕
										</button>
									</div>
									<div className="dialog-body">
										{pendingPermRequest.family === "net"
											? t("pluginPermBodyNet")
													.replace("{plugin}", pendingPermRequest.pluginId)
													.replace("{hosts}", (pendingPermRequest.hosts ?? []).join(", "))
											: t("pluginPermBodyLlm")
													.replace("{plugin}", pendingPermRequest.pluginId)
													.replace(
														"{models}",
														(pendingPermRequest.models ?? []).length > 0
															? ` ${(pendingPermRequest.models ?? []).join(", ")}`
															: "",
													)}
										{pendingPermRequest.reason && <div className="dialog-hint">{pendingPermRequest.reason}</div>}
										<div className="dialog-actions">
											<button
												type="button"
												className="btn"
												onClick={() => answerPermRequest(pendingPermRequest.id, false)}
											>
												{t("pluginGrantDeny")}
											</button>
											<button
												type="button"
												className="btn"
												onClick={() => answerPermRequest(pendingPermRequest.id, true)}
											>
												{t("pluginPermOnce")}
											</button>
											<button
												type="button"
												className="btn primary"
												onClick={() => answerPermRequest(pendingPermRequest.id, true, true)}
											>
												{t("pluginPermAlways")}
											</button>
										</div>
									</div>
								</div>
							)}
							{pendingPathRequest && (
								<div className="dialog-inline" data-dialog-kind="confirm">
									<div className="dialog-head">
										<span className="dialog-badge">{t("pluginRequest")}</span>
										<span className="dialog-title">{t("pluginGrantRequestTitle")}</span>
										<button
											type="button"
											className="dialog-dismiss"
											title={t("cancel")}
											onClick={() => answerPathRequest(pendingPathRequest.id, false)}
										>
											✕
										</button>
									</div>
									<div className="dialog-body">
										{t("pluginGrantRequestBody")
											.replace("{plugin}", pendingPathRequest.pluginId)
											.replace("{path}", pendingPathRequest.path)}
										{pendingPathRequest.reason && <div className="dialog-hint">{pendingPathRequest.reason}</div>}
										<div className="dialog-actions">
											<button
												type="button"
												className="btn"
												onClick={() => answerPathRequest(pendingPathRequest.id, false)}
											>
												{t("pluginGrantDeny")}
											</button>
											<button
												type="button"
												className="btn primary"
												onClick={() => answerPathRequest(pendingPathRequest.id, true)}
											>
												{t("pluginGrantAllow")}
											</button>
										</div>
									</div>
								</div>
							)}
							{pluginPathConfirm && (
								<div className="dialog-inline" data-dialog-kind="confirm">
									<div className="dialog-head">
										<span className="dialog-badge">{t("pluginRequest")}</span>
										<span className="dialog-title">{t("pluginSessionGrantTitle")}</span>
										<button
											type="button"
											className="dialog-dismiss"
											title={t("cancel")}
											onClick={() => {
												pluginPathConfirm.resolve(false);
												setPluginPathConfirm(null);
											}}
										>
											✕
										</button>
									</div>
									<div className="dialog-body">
										{t("pluginSessionGrantBody").replace("{path}", pluginPathConfirm.path)}
										<div className="dialog-actions">
											<button
												type="button"
												className="btn"
												onClick={() => {
													pluginPathConfirm.resolve(false);
													setPluginPathConfirm(null);
												}}
											>
												{t("cancel")}
											</button>
											<button
												type="button"
												className="btn primary"
												onClick={() => {
													pluginPathConfirm.resolve(true);
													setPluginPathConfirm(null);
												}}
											>
												{t("ok")}
											</button>
										</div>
									</div>
								</div>
							)}
							{chat.question && <DshQuestionDialog question={chat.question} />}
							{/* 跨页作答：别处会话的问卷在本页弹框（id 对方会话作用域，提交带 owner）。 */}
							{chat.remoteQuestion && (
								<DshQuestionDialog question={chat.remoteQuestion} owner={chat.remoteQuestion.owner} />
							)}
							<ChatInput
								composerLeading={uiSlots["composer.leading"]}
								composerActions={uiSlots["composer.actions"]}
								onUiAction={onUiAction}
								streaming={chat.state?.isStreaming ?? false}
								messages={chat.state?.messages ?? EMPTY_MESSAGES}
								slashCommands={chat.slashCommands}
								modelState={modelState}
								models={chat.models}
								modelsLoading={chat.modelsLoading}
								providerKeys={chat.providerKeys}
								attachments={attachments}
								onRemoveAttachment={removeAttachmentCb}
								onAddImageFiles={addImageFilesCb}
								onAddLocalFiles={addLocalFilesCb}
								onAddPathAttachment={addPathAttachmentCb}
								fileSearch={chat.fileSearch}
								onSearchFiles={searchFilesCb}
								onNotice={pushNotice}
								onManageModels={openManageModels}
								onSent={clearAttachments}
								quickPhrases={chat.settings?.quickPhrases ?? []}
								quickPhrasesEnabled={chat.settings?.quickPhrasesEnabled ?? true}
								recallDrafts={recallDrafts}
								dshPermCurrent={chat.engine === "dsh" ? (chat.state?.permission ?? null) : undefined}
								dshPermOptions={chat.engine === "dsh" ? (chat.dshPermission?.options ?? undefined) : undefined}
								dshPermDefault={chat.engine === "dsh" ? chat.dshPermission?.defaultPreset : undefined}
								dshPreset={chat.engine === "dsh" ? (chat.state?.agentPreset ?? null) : undefined}
								dshPresets={chat.engine === "dsh" ? (chat.dshPresets?.presets ?? undefined) : undefined}
								dshPresetDefault={chat.engine === "dsh" ? chat.dshPresets?.defaultPreset : undefined}
								dshBlank={(chat.state?.messages?.length ?? 0) === 0}
								conversationId={chat.activeConversationId || chat.state?.conversationId || ""}
								sessionDraft={chat.engine === "pi" ? (chat.state?.draft ?? null) : null}
								sessionId={chat.state?.sessionId ?? ""}
							/>
						</main>
						{!isMobile && <ResizeHandle side="right" width={rightWidth} onResize={resizeRight} />}
						<div
							className={`panel-drawer drawer-right ${drawer === "right" ? "open" : ""}${
								isMobile ? "" : rightCollapsed ? " hidden" : ""
							}`}
						>
							<RightPanel
								collapsible={!isMobile}
								onToggleCollapse={toggleRight}
								panelSend={panelSend}
								files={chat.files}
								fileChanged={chat.fileChanged}
								widgets={chat.widgets}
								onAttach={(path, name, mode, isDir) => {
									setDrawer(null);
									attach(path, name, mode, isDir);
								}}
								onPreview={(path, name) => {
									setDrawer(null);
									setPreviewFile({ path, name });
								}}
								onNotice={(level, text) => pushNotice(level, text)}
								/* 宿主 UI 扩展点（issue #146）：右栏 tab 条（插件 tab）、文件右键菜单条目
								   （contextmenu.file：host 内置条目由右栏自己分派）与插件配置。 */
								uiRightPanelTabs={uiSlots["rightpanel.tabs"]}
								uiContextFile={uiSlots["contextmenu.file"]}
								plugins={enabledPlugins}
								pluginsEpoch={chat.pluginsEpoch}
								send={send}
							/>
						</div>
						{!isMobile && rightCollapsed && <PanelRail side="right" onClick={toggleRight} />}
					</div>
					<div className={`view-pane ${view === "terminal" ? "" : "hidden"}`}>
						<Suspense fallback={null}>
							<TerminalPanel
								chat={chat}
								terminal={terminal}
								uiTerminalToolbar={uiTerminalToolbar}
								onUiAction={onUiAction}
							/>
						</Suspense>
					</div>
					<div className={`view-pane ${view === "git" ? "" : "hidden"}`}>
						<ScmPanel
							chat={chat}
							terminal={terminal}
							active={view === "git"}
							onSwitchToTerminal={() => setView("terminal")}
							uiScmToolbar={uiScmToolbar}
							onUiAction={onUiAction}
						/>
					</div>
					{pluginViews.map((entry) => {
						const name = `plugin:${entry.info.id}` as ViewName;
						return (
							<div key={entry.info.id} className={`view-pane ${view === name ? "" : "hidden"}`}>
								<PluginView entry={entry} />
							</div>
						);
					})}
					{/* issue #225：当前视图是没加载出来的插件 → 明确占位（加载中/失败+重试），不再整片空白。 */}
					{view.startsWith("plugin:") && !pluginViews.some((v) => `plugin:${v.info.id}` === view) && (
						<PluginViewFallback
							pluginId={view.slice("plugin:".length)}
							info={chat.plugins.find((p) => `plugin:${p.id}` === view)}
							epoch={chat.pluginsEpoch}
							failed={failedPluginViews.includes(view.slice("plugin:".length))}
						/>
					)}
				</div>
			</TemplateProvider>
			<FooterBar chat={chat} bottombarItems={uiSlots["bottombar"]} onUiAction={onUiAction} />
			{previewFile && (
				<FilePreview
					file={previewFile}
					content={chat.fileContent}
					onAddLines={(path, name, start, end) => attach(path, name, "lines", false, { start, end })}
					onAttach={(path, name, mode) => attach(path, name, mode)}
					onClose={() => setPreviewFile(null)}
					uiFilePreviewToolbar={uiFilePreviewToolbar}
					onUiAction={onUiAction}
				/>
			)}
			{chat.ready && chat.state && chat.state.piConfigured === false && !setupDismissed && !manageModelsOpen && (
				<PiSetupModal
					piConfigured={chat.state.piConfigured}
					piAgentInstalled={chat.state.piAgentInstalled}
					providers={chat.providers}
					providerOAuthFlows={chat.providerOAuthFlows}
					providerOAuthResults={chat.providerOAuthResults}
					installResult={chat.installResult}
					onClose={() => setSetupDismissed(true)}
				/>
			)}
			{manageModelsOpen && (
				<ModelConfigModal
					providers={chat.modelsConfig}
					providerStatus={chat.providers}
					providerKeys={chat.providerKeys}
					providerOAuthFlows={chat.providerOAuthFlows}
					providerOAuthResults={chat.providerOAuthResults}
					fetchModelsResult={chat.fetchModelsResult}
					refreshBuiltinResult={chat.refreshBuiltinResult}
					appendBuiltinResult={chat.appendBuiltinResult}
					cloneProviderResult={chat.cloneProviderResult}
					onClose={() => setManageModelsOpen(false)}
				/>
			)}
			{settingsOpen && (
				<SettingsModal
					chat={chat}
					terminal={terminal}
					initialSection={settingsInitialSection}
					onSwitchToTerminal={() => setView("terminal")}
					onClose={() => setSettingsOpen(false)}
				/>
			)}
			{bgTasksOpen && <BgTasksModal servers={chat.bgServers} onClose={() => setBgTasksOpen(false)} />}
			{/* 插件弹窗（modal.dialog 槽位）：action 点即分发 + 关弹窗，view 挂插件视图。 */}
			{openModalEntry && (
				<PluginModal
					entry={openModalEntry}
					pluginView={openModalPluginId ? pluginViews.find((v) => v.info.id === openModalPluginId) : undefined}
					onUiAction={(item, value) => {
						onUiAction(item, value);
						setOpenModalId(null);
					}}
					onClose={() => setOpenModalId(null)}
				/>
			)}
			<GlobalSearchModal
				open={globalSearchOpen}
				projects={chat.projects}
				fileSearch={chat.fileSearch}
				sessionSearch={chat.sessionSearch}
				onClose={() => setGlobalSearchOpen(false)}
				onSwitchSession={(path, anchors) => {
					void send({ type: "switch_session", path });
					// 跳到命中消息位置（锚点取自服务端返回；无锚点则只切换会话）
					const a = anchors && anchors[0];
					setSearchJump(a ? { path, role: a.role, timestamp: a.timestamp } : null);
				}}
				onSwitchProject={(path) => {
					void send({ type: "set_cwd", path });
				}}
				onPreviewFile={(path, name) => {
					setPreviewFile({ path, name });
				}}
			/>
		</div>
	);
}
