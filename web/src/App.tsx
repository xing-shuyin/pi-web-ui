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
import { FiRefreshCw } from "react-icons/fi";

import { FooterBar } from "./components/FooterBar";
import { formatSessionHash, parseSessionHash } from "./session-url";
import { SideDock } from "./components/SideDock";
import { Dialog } from "./components/Dialog";
import { DshQuestionDialog } from "./components/DshQuestionDialog";
import { presetText } from "./components/DshPresetBar";
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
	emitPluginHostModel,
	installPluginHostApi,
	triggerPluginUiAction,
} from "./plugin-host";
import {
	buildUiSlots,
	withPluginViewItems,
	HIDDEN_FROM_LAYOUT_ITEM_IDS,
	type UiDiagnostic,
	type UiSlotEntry,
} from "./ui-slots";
import { renderSlotToolbar } from "./slot-toolbar";
import { ContextMenu } from "./components/ContextMenu";
import { BannerContainer } from "./components/BannerContainer";
import { IconEditor } from "./components/IconEditor";
import { showBanner, dismissBanner, dismissBannersWhere } from "./banner-notice";
import { ensurePluginViewLoaded } from "./plugin-loader";
import { registerAttachmentSink, insertTextAtCursor, removeMentionFromComposer } from "./composer-bridge";
import { appendDraftAttachments } from "./composer-draft";
import { useComposerSessionReset } from "./use-composer-session";
import { splitQuotedPrompt } from "../../server/text-quote.js";
import {
	syncPluginViews,
	subscribeLoadedPluginViews,
	subscribePluginLoadFailed,
	type LoadedPluginView,
} from "./plugin-loader";
import { setFenceSend, syncFenceRenderers, syncMessageWidgets } from "./plugin-fence";
import { findFileHandler, syncFileHandlers, type FileHandlerPlugin } from "./plugin-file-handlers";
import { PiSetupModal } from "./components/PiSetupModal";
import { ModelConfigModal } from "./components/ModelConfigModal";

import { SettingsModal } from "./components/SettingsModal";
import { BgTasksModal } from "./components/BgTasksModal";
import { PluginPage } from "./components/PluginPage";
import { RollbackDialog } from "./components/RollbackDialog";
import { openRollbackDialog } from "./rollback-state";
import { ToolApprovalDialog } from "./components/ToolApprovalDialog";
import { PlanBoard } from "./components/PlanBoard";
// 工具定义说明弹窗（工具卡右键 → 「显示工具详细信息」）：状态在 tool-info-state.ts 的模块级 store 里，
// 这里只挂一份渲染（触发点在消息流里的每张工具卡）。
import { ToolInfoDialog } from "./components/ToolInfoDialog";
import { GlobalSearchModal } from "./components/GlobalSearchModal";
import { PluginModal } from "./components/PluginModal";
import { TemplateProvider } from "./components/PromptTemplates";
import { FilePreview, type PreviewFile } from "./components/FilePreview";
import { PluginFilePreview } from "./components/PluginFilePreview";
import { useChat } from "./use-chat";
import { useSwipeDrawer } from "./use-swipe-drawer";
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
import { assistantPlainText, loadTtsSettings, saveTtsSettings, speak, type TtsSettings } from "./tts";
import { shouldSuppressNotify, currentPresence } from "./notify";
import { useWideChat } from "./chat-width-settings";
import { registerFilePreviewHost } from "./file-preview-bridge";
import { projectNameFromCwd, useProjectTitle } from "./title-settings";
import { notify } from "./notify";
import { diffStreamingCues } from "./streaming-cues";
import { useTheme } from "./theme";
import { useWallpaperEffect } from "./wallpaper";

export interface PendingAttachment {
	path: string;
	name: string;
	/** "page" = 已授权给 AI 的网页（page-picker 扩展）：path 是页面 origin，
	 *  name 是页面标题，不会被当工作区路径处理。
	 *  "conversation" = 引用的另一个对话：path 不用，引用走 conversationId
	 *  （运行中，含子代理）或 sessionPath（历史转录），AI 经 conversation_read 读取。
	 *  "reference"/"lines" = 工作区路径引用（文件内容不进 prompt）。
	 *  "inline" = 旧版「全文注入」的遗留值（服务端按 reference 处理）；粘贴图片 /
	 *  上传文件没有 mode（path 为空，模式对它们无意义）。 */
	mode?: "inline" | "reference" | "lines" | "page" | "conversation" | "quote";
	quote?: import("./types").TextQuote;
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
	try {
		const v = Number(localStorage.getItem(panelWidthKey(side)));
		return Number.isFinite(v) && v >= PANEL_MIN && v <= PANEL_MAX ? v : PANEL_DEFAULT;
	} catch {
		// storage 不可用（隐私模式等）：回默认宽度。这两个读在 useState 初始化器里，
		// 抛错会让整个 App 首帧白屏 —— 与 use-chat.ts/theme.ts 的兜底风格一致。
		return PANEL_DEFAULT;
	}
}
const panelCollapsedKey = (side: PanelSide) => `pi-web-ui:${side}-panel-collapsed`;
function readPanelCollapsed(side: PanelSide): boolean {
	try {
		return localStorage.getItem(panelCollapsedKey(side)) === "1";
	} catch {
		return false;
	}
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
				try {
					localStorage.setItem(panelWidthKey(side), String(last));
				} catch {
					/* storage 不可用：本次拖拽照常生效，只是不持久化 */
				}
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
 *
 * 键按插件隔离：旧版所有插件共用一个全局键，A 插件拿到的授权对 B 插件天然生效（一次
 * 确认全网通行）。带 pluginId 的读写走 `pi-web-ui:plugin-path-grants:<pluginId>`；
 * 该插件首读且只有旧全局键时，把旧记录**迁移**到它名下（保住升级前「确认过不再问」的
 * 体验，之后各插件的授权各自演化）；宿主桥归因不了调用方时回退旧全局键（见
 * plugin-host.ts 的 pluginApiCaller）。
 */
const PLUGIN_PATH_GRANTS_KEY = "pi-web-ui:plugin-path-grants";
const pluginPathGrantsKey = (pluginId?: string) =>
	pluginId ? `${PLUGIN_PATH_GRANTS_KEY}:${pluginId}` : PLUGIN_PATH_GRANTS_KEY;

function parseGrants(raw: string | null): string[] {
	if (raw === null) return [];
	try {
		const arr = JSON.parse(raw) as unknown;
		return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
	} catch {
		return [];
	}
}

function readPluginPathGrants(pluginId?: string): string[] {
	try {
		const key = pluginPathGrantsKey(pluginId);
		if (localStorage.getItem(key) !== null) return parseGrants(localStorage.getItem(key));
		if (!pluginId) return [];
		// 迁移：该插件还没有自己的授权记录时，接管旧全局键（升级前所有插件共用），
		// 用户在旧版确认过的目录不因升级重新弹框。
		const grants = parseGrants(localStorage.getItem(PLUGIN_PATH_GRANTS_KEY));
		localStorage.setItem(key, JSON.stringify(grants));
		return grants;
	} catch {
		return [];
	}
}

function addPluginPathGrant(path: string, pluginId?: string): void {
	try {
		const next = [...new Set([...readPluginPathGrants(pluginId), path])];
		localStorage.setItem(pluginPathGrantsKey(pluginId), JSON.stringify(next));
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
	const [pluginFile, setPluginFile] = useState<{
		file: PreviewFile;
		plugin: FileHandlerPlugin;
		declaration: import("./plugin-file-handlers").FileHandlerDeclaration;
	} | null>(null);
	// 文件预览桥（present_files 卡片 → 预览弹窗）：弹窗的开关状态在本组件，
	// 而调用方在消息流最深处的工具卡片，中间隔好几层。同 composer-bridge 的做法，
	// 只走一个模块级 sink；ref 给 isOpen 用，避免 effect 依赖 previewFile 而反复重注册。
	const previewOpenRef = useRef(false);
	const pluginFileOpenRef = useRef<typeof pluginFile>(null);
	useEffect(() => {
		previewOpenRef.current = previewFile !== null;
		pluginFileOpenRef.current = pluginFile;
	}, [previewFile, pluginFile]);
	const openFile = useCallback((path: string, name: string) => {
		const entry = findFileHandler(name);
		if (entry) {
			setPreviewFile(null);
			setPluginFile({ file: { path, name }, plugin: entry.plugin, declaration: entry.declaration });
			return;
		}
		setPluginFile(null);
		setPreviewFile({ path, name });
	}, []);
	useEffect(() => {
		registerFilePreviewHost({
			open: (f) => openFile(f.path, f.name),
			isOpen: () => previewOpenRef.current || pluginFileOpenRef.current !== null,
		});
		return () => registerFilePreviewHost(null);
	}, [openFile]);
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
	const uiSlots = useMemo(() => {
		// 合并诊断（P0-1：失败不许静默）：未知 slot / 未知 kind / arrange 目标不存在 /
		// 插件被禁用或激活失败 → 带归因的 diagnostics，这里 console.warn 一条，
		// 设置面板「界面布局」页再展示给用户（同一份数据，两处都不吞）。
		const diagnostics: UiDiagnostic[] = [];
		const slots = buildUiSlots(withPluginViewItems(chat.plugins), {
			locale,
			// Translate 的 key 是字面量联合类型，ui-slots 收的是 (key: string) => string
			t: (key: string) => t(key as Parameters<typeof t>[0]),
			disabledPlugins: chat.settings?.disabledPlugins ?? [],
			layout: chat.settings?.uiLayout,
			diagnostics,
		});
		for (const d of diagnostics) console.warn(`[ui-slot] ${d.pluginId ? `[${d.pluginId}] ` : ""}${d.message}`);
		return slots;
	}, [chat.plugins, chat.settings?.disabledPlugins, chat.settings?.uiLayout, locale, t]);
	// 顶栏：主栏 = 非 hidden 的 topbar.primary；溢出 = hidden 的 primary + topbar.overflow。
	// 这样插件把宿主条目 hide 掉之后，它仍在溢出菜单/布局页里找得回来（锁不死用户）。
	const uiPrimary = useMemo(() => uiSlots["topbar.primary"].filter((e) => !e.hidden), [uiSlots]);
	const uiOverflow = useMemo(
		() => [...uiSlots["topbar.primary"].filter((e) => e.hidden), ...uiSlots["topbar.overflow"]],
		[uiSlots],
	);
	// 面板槽位（收尾接线）：非 hidden 条目直传面板，空数组时面板返回 null，DOM 与旧版一致。
	const uiLeftSessions = useMemo(() => uiSlots["leftpanel.sessions"].filter((e) => !e.hidden), [uiSlots]);
	// 左栏 P1 挂载点（项目 / 运行 / 历史三个分区标题栏 + 项目行）：hidden 滤掉，无条目时 LeftPanel 不画。
	const uiLeftProjectsActions = useMemo(
		() => uiSlots["leftpanel.projects.actions"].filter((e) => !e.hidden),
		[uiSlots],
	);
	const uiLeftProject = useMemo(() => uiSlots["leftpanel.project"].filter((e) => !e.hidden), [uiSlots]);
	const uiLeftRunningActions = useMemo(() => uiSlots["leftpanel.running.actions"].filter((e) => !e.hidden), [uiSlots]);
	const uiLeftHistoryActions = useMemo(() => uiSlots["leftpanel.history.actions"].filter((e) => !e.hidden), [uiSlots]);
	// P2：分区本身不滤 hidden（隐藏也要在布局页里找得回来），由 LeftPanel 按 hidden 计划。
	const uiLeftSections = uiSlots["leftpanel.sections"];
	const uiLeftRunning = useMemo(() => uiSlots["leftpanel.running"].filter((e) => !e.hidden), [uiSlots]);
	const uiLeftHistory = useMemo(() => uiSlots["leftpanel.history"].filter((e) => !e.hidden), [uiSlots]);
	const uiTerminalToolbar = useMemo(() => uiSlots["terminal.toolbar"].filter((e) => !e.hidden), [uiSlots]);
	const uiScmToolbar = useMemo(() => uiSlots["scm.toolbar"].filter((e) => !e.hidden), [uiSlots]);
	const uiGoalbarActions = useMemo(() => uiSlots["goalbar.actions"].filter((e) => !e.hidden), [uiSlots]);
	// P0 幽灵槽位接线：纯插件新增位，无条目时各渲染层返回 null，DOM 与旧版一致。
	const uiChatHeader = useMemo(() => uiSlots["chat.header"].filter((e) => !e.hidden), [uiSlots]);
	const uiChatEmpty = useMemo(() => uiSlots["chat.empty"].filter((e) => !e.hidden), [uiSlots]);
	const uiFilePreviewToolbar = useMemo(() => uiSlots["file.preview.toolbar"].filter((e) => !e.hidden), [uiSlots]);
	// 预设名录 id→显示名（左栏徽标；dshPresets 对象不变时引用稳定，不破坏 LeftPanel memo）。
	// 徽标文案随界面语言定（内置五档走 i18n，其余取服务端 nameEn ?? name）——locale 进
	// 依赖：切语言要重算，否则徽标留着上一种语言的文案。
	const presetNames = useMemo(
		() => Object.fromEntries((chat.dshPresets?.presets ?? []).map((p) => [p.id, presetText(p, locale, t).name])),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[chat.dshPresets, locale],
	);
	const uiNoticeActions = useMemo(() => uiSlots["notice.actions"].filter((e) => !e.hidden), [uiSlots]);
	const uiSidebarLeft = useMemo(() => uiSlots["sidebar.left"] ?? [], [uiSlots]);
	const uiSidebarRight = useMemo(() => uiSlots["sidebar.right"] ?? [], [uiSlots]);
	/** 点一个插件顶栏条目：缺省 action（或 "view"）由宿主切成插件视图；其余交给插件
	 *  （按需加载它的客户端 bundle；没人接管就提示一句，不让按钮看起来"点了没用"）。
	 *  kind="select" 的渲染层把选中的 value 经第二个参数传进来，转给插件 handler。 */
	const onUiAction = useCallback(
		(item: UiSlotEntry, value?: string, target?: { id: string; kind?: string; label?: string }) => {
			if (item.id === "host:msg-fork") {
				if (target?.id) {
					send({ type: "fork_session", messageId: target.id, position: "before" });
				}
				return;
			}
			if (item.id === "host:msg-rollback") {
				if (target?.id) {
					openRollbackDialog({ messageId: target.id });
				}
				return;
			}
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
	/** P4：左栏插件自定义分区的正文：由 PluginPage 挂插件 bundle（与后台任务面板同口径）。
	 *  插件不存在 / 无客户端脚本时返回 null（PluginPage 自己会给出明确占位）。 */
	const renderLeftPluginSectionBody = useCallback(
		(entry: UiSlotEntry) => {
			const plugin = chat.plugins.find((p) => p.id === entry.source.slice("plugin:".length));
			if (!plugin) return null;
			return <PluginPage plugin={plugin} epoch={chat.pluginsEpoch} send={send} className="lp-plugin-page" />;
		},
		[chat.plugins, chat.pluginsEpoch, send],
	);
	/** P3：点左栏「运行的对话」里的插件运行条目 → 交给贡献它的插件 bundle（与 onUiAction 同通道；
	 *  target 带条目 id/标题，kind="plugin-running"）。没有 action 的条目点击无效果。 */
	const onPluginRunningAction = useCallback(
		(group: { pluginId: string }, item: { id: string; title: string; action?: string }) => {
			if (!item.action) return;
			void triggerPluginUiAction(group.pluginId, item.action, item.id, {
				target: { id: item.id, kind: "plugin-running", label: item.title },
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
		syncFileHandlers(enabledPlugins, chat.pluginsEpoch);
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
				getCurrentModelId: () => {
					const m = chatRefForPlugins.current.state?.model;
					return m ? `${m.provider}/${m.id}` : null;
				},
				// #146：目录授权（最近项目 = 用户已知；其余弹一次确认）+ 顶栏动作按需加载
				listProjects: () => chatRefForPlugins.current.projects.map((p) => p.path),
				grantedPaths: readPluginPathGrants,
				grantPath: addPluginPathGrant,
				confirm: (opts) =>
					new Promise<boolean>((resolve) => {
						if (pluginPathConfirmRef.current) {
							resolve(false);
							return;
						}
						const req = { path: opts.path, resolve };
						pluginPathConfirmRef.current = req;
						setPluginPathConfirm(req);
					}),
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
			try {
				localStorage.setItem(panelCollapsedKey("left"), v ? "0" : "1");
			} catch {
				/* storage 不可用（隐私模式等）：折叠照常，只是不持久化 */
			}
			return !v;
		});
	}, []);
	const toggleRight = useCallback(() => {
		setRightCollapsed((v) => {
			try {
				localStorage.setItem(panelCollapsedKey("right"), v ? "0" : "1");
			} catch {
				/* storage 不可用（隐私模式等）：折叠照常，只是不持久化 */
			}
			return !v;
		});
	}, []);
	// Mobile: which side panel is open as a drawer (null = both closed).
	const [drawer, setDrawer] = useState<"left" | "right" | null>(null);
	// 抽屉手势的监听容器（移动端 `.layout` 整屏）。
	const layoutRef = useRef<HTMLDivElement | null>(null);
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
	// 手机端侧栏手势：从左右边缘往里横滑 = 拉出该侧列表，列表开着时往外横滑 = 收回去。
	// 只在 chat 视图挂（左右面板就长在这个 view-pane 里；终端视图的抽屉是另一套）。
	// 判定纯函数见 `swipe-drawer.ts`，DOM 粘合见 `use-swipe-drawer.ts`。
	useSwipeDrawer({
		enabled: isMobile && view === "chat",
		open: drawer,
		onOpenChange: setDrawer,
		container: layoutRef,
		// 必须点名 `.persistent`：终端视图的抽屉也用 `.drawer-backdrop`（常驻但 display:none
		// 的 pane 里照样能被 querySelector 查到），不加限定会去改那道看不见的遮罩。
		backdropSelector: ".drawer-backdrop.persistent",
	});
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
	const pluginPathConfirmRef = useRef<typeof pluginPathConfirm>(null);
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
	// 图标编辑模式（顶栏「⋯」→ 编辑图标）：直接拖图标改四个栏的位置。
	const [iconEditOpen, setIconEditOpen] = useState(false);
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

	// ---- 会话与消息 URL 深链（#s=<sessionId>&m=<messageId>，issue #587）----
	const [urlJump, setUrlJump] = useState<{ sessionId: string; messageId: string } | null>(null);
	const pendingHashSessionRef = useRef<string | null>(null);
	const awaitingHashSessionRef = useRef<string | null>(null);
	const activeSessionId = chat.state?.sessionId ?? "";
	const activeSessionIdRef = useRef(activeSessionId);
	activeSessionIdRef.current = activeSessionId;
	const readyRef = useRef(chat.ready);
	readyRef.current = chat.ready;

	useEffect(() => {
		const applyFromLocation = () => {
			const parsed = parseSessionHash(window.location.hash);
			if (!parsed) return;
			if (parsed.messageId) {
				setUrlJump({ sessionId: parsed.sessionId, messageId: parsed.messageId });
			} else {
				setUrlJump(null);
			}
			if (!readyRef.current || !activeSessionIdRef.current) {
				pendingHashSessionRef.current = parsed.sessionId;
				return;
			}
			if (activeSessionIdRef.current !== parsed.sessionId) {
				awaitingHashSessionRef.current = parsed.sessionId;
				setView("chat");
				send({ type: "switch_session", path: "", sessionId: parsed.sessionId });
			}
		};
		applyFromLocation();
		window.addEventListener("hashchange", applyFromLocation);
		window.addEventListener("popstate", applyFromLocation);
		return () => {
			window.removeEventListener("hashchange", applyFromLocation);
			window.removeEventListener("popstate", applyFromLocation);
		};
	}, [send]);

	// 当请求的目标会话不存在（服务端返回 warning notice）或超时时，解除 awaiting 状态并回退到当前会话 URL。
	useEffect(() => {
		const awaiting = awaitingHashSessionRef.current;
		if (!awaiting) return;
		const notFound = chat.notices.some(
			(n) => n.text.includes(awaiting) && (n.text.includes("未找到会话") || n.text.includes("Session not found")),
		);
		if (notFound) {
			awaitingHashSessionRef.current = null;
			setUrlJump(null);
			if (activeSessionId) {
				const nextHash = formatSessionHash({ sessionId: activeSessionId });
				if (window.location.hash !== nextHash) {
					window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${nextHash}`);
				}
			}
		}
	}, [chat.notices, activeSessionId]);

	// 首载连接就绪后：若 URL hash 指定了目标会话则切过去；否则保持地址栏 hash 跟随当前活跃会话。
	useEffect(() => {
		if (!chat.ready || !activeSessionId) return;
		if (pendingHashSessionRef.current) {
			const wantSid = pendingHashSessionRef.current;
			pendingHashSessionRef.current = null;
			if (wantSid !== activeSessionId) {
				awaitingHashSessionRef.current = wantSid;
				setView("chat");
				send({ type: "switch_session", path: "", sessionId: wantSid });
				return;
			}
		}
		if (awaitingHashSessionRef.current) {
			if (activeSessionId === awaitingHashSessionRef.current) {
				awaitingHashSessionRef.current = null;
			} else {
				return;
			}
		}
		const currentParsed = parseSessionHash(window.location.hash);
		const keepMsgId = currentParsed?.sessionId === activeSessionId ? currentParsed.messageId : undefined;
		const nextHash = formatSessionHash({
			sessionId: activeSessionId,
			...(keepMsgId ? { messageId: keepMsgId } : {}),
		});
		if (window.location.hash !== nextHash) {
			window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${nextHash}`);
		}
	}, [chat.ready, activeSessionId, send]);

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
	// -- local TTS announcements (Settings → Sound & Voice) -------------------
	const [tts, setTts] = useState<TtsSettings>(loadTtsSettings);
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
	useEffect(() => {
		try {
			const m = chat.state?.model;
			const mid = m ? `${m.provider}/${m.id}` : null;
			if (typeof emitPluginHostModel === "function") emitPluginHostModel(mid);
		} catch {
			/* 插件监听抛错不影响宿主 */
		}
	}, [chat.state?.model?.provider, chat.state?.model?.id]);
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
	const prevStreamingMapRef = useRef<Map<string, boolean> | null>(null);
	const prevActiveIdRef = useRef<string | null>(null);
	const latestMessagesRef = useRef(chat.state?.messages);
	latestMessagesRef.current = chat.state?.messages;
	const notifiedDialogIds = useRef<Set<number>>(new Set());
	const notifiedQuestionIds = useRef<Set<string>>(new Set());
	const notifiedApprovalIds = useRef<Set<string>>(new Set());
	const lastErrorNotice = useRef(0);
	// Remembers a terminal-view click made before the WebSocket is ready.
	const terminalOpenRequested = useRef(false);
	// Previous terminal list — drives the uninstall-finished watcher below.
	const prevTerminalsRef = useRef(chat.terminals);

	useEffect(() => {
		saveSoundSettings(sound);
	}, [sound]);

	useEffect(() => {
		saveTtsSettings(tts);
	}, [tts]);

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
	// 按会话 id 独立跟踪状态跳变，彻底杜绝切换对话时将其他会话的状态误判为本会话的 start/done，
	// 并在后台对话完成时及时提示（issue：切换对话误报完成、后台对话延迟到切换才提醒）。
	useEffect(() => {
		const activeId = chat.state?.conversationId ?? null;
		const cues = diffStreamingCues(
			prevStreamingMapRef.current,
			activeId,
			chat.state?.isStreaming ?? false,
			chat.conversations,
			prevActiveIdRef.current,
		);
		prevStreamingMapRef.current = cues.nextMap;
		prevActiveIdRef.current = activeId;

		if (cues.startCue) {
			playSound("start", sound);
		}

		if (cues.finishedConvs.length > 0) {
			playSound("done", sound);

			const activeFinished = cues.finishedConvs.find((c) => c.isActive);
			if (activeFinished) {
				// 前台活动对话完成
				void notify(t("notifyDoneTitle"), t("notifyDoneBody"));
				if (tts.enabled && !shouldSuppressNotify(currentPresence())) {
					if (tts.readReplies) {
						const body = assistantPlainText(latestMessagesRef.current);
						if (body) speak(body, tts);
						else if (tts.announce) speak(t("ttsAnnounceDone"), tts);
					} else if (tts.announce) {
						speak(t("ttsAnnounceDone"), tts);
					}
				}
			}
			// 后台对话完成（可能与其他会话同批）：逐条弹通知带标题；TTS 只播报一次，
			// 且前台完成时让位给正文朗读，不叠加固定句。
			for (const bg of cues.finishedConvs.filter((c) => !c.isActive)) {
				const body = bg.title ? `${bg.title}：${t("notifyDoneBody")}` : t("notifyDoneBody");
				void notify(t("notifyDoneTitle"), body);
			}
			if (!activeFinished && tts.enabled && tts.announce && !shouldSuppressNotify(currentPresence())) {
				speak(t("ttsAnnounceDone"), tts);
			}
		}
	}, [chat.state?.conversationId, chat.state?.isStreaming, chat.conversations, sound, tts, t]);

	// Questionnaire cue — each new dialog id + each new DSH question id.
	// dialog = 扩展 select/confirm/input；question = ask_user_question 问卷。
	// 按 ID 集合去重，彻底避免在不同对话间切换时重复响铃和弹通知。
	useEffect(() => {
		const id = chat.dialog?.id ?? null;
		if (id !== null && !notifiedDialogIds.current.has(id)) {
			notifiedDialogIds.current.add(id);
			if (notifiedDialogIds.current.size > 64) {
				const oldest = notifiedDialogIds.current.values().next().value;
				if (oldest !== undefined) notifiedDialogIds.current.delete(oldest);
			}
			playSound("question", sound);
			void notify(t("notifyQuestionTitle"), t("notifyQuestionBody"));
			if (tts.enabled && tts.announce && !shouldSuppressNotify(currentPresence())) speak(t("ttsAnnounceQuestion"), tts);
		}
	}, [chat.dialog, sound, tts, t]);

	useEffect(() => {
		const qid = chat.question?.id ?? null;
		const rid = chat.remoteQuestion ? `${chat.remoteQuestion.owner}:${chat.remoteQuestion.id}` : null;
		let shouldCue = false;

		if (qid !== null && !notifiedQuestionIds.current.has(qid)) {
			notifiedQuestionIds.current.add(qid);
			shouldCue = true;
		}
		if (rid !== null && !notifiedQuestionIds.current.has(rid)) {
			notifiedQuestionIds.current.add(rid);
			shouldCue = true;
		}

		// 后台会话的问卷：弹窗不跨会话打扰，但提示音与系统通知照旧（避免只剩静默角标）。
		// 遇到新的后台问卷时，将其 ID 记入已提醒 Set，防止用户切入该会话时二次响铃。
		for (const c of chat.conversations) {
			if (!c.hasQuestion) continue;
			const qKey = c.questionId ? `q:${c.questionId}` : `conv-q:${c.id}`;
			if (!notifiedQuestionIds.current.has(qKey)) {
				notifiedQuestionIds.current.add(qKey);
				if (c.questionId) notifiedQuestionIds.current.add(c.questionId);
				if (qid !== c.questionId) {
					shouldCue = true;
				}
			}
		}

		if (notifiedQuestionIds.current.size > 64) {
			const oldest = notifiedQuestionIds.current.values().next().value;
			if (oldest !== undefined) notifiedQuestionIds.current.delete(oldest);
		}

		if (shouldCue) {
			playSound("question", sound);
			void notify(t("notifyQuestionTitle"), t("notifyQuestionBody"));
			if (tts.enabled && tts.announce && !shouldSuppressNotify(currentPresence())) speak(t("ttsAnnounceQuestion"), tts);
		}
	}, [chat.question, chat.remoteQuestion, chat.conversations, sound, tts, t]);

	// Tool-approval cue (issue #288)：高危操作等待用户批准 —— 此前是唯一静默的
	// 拦截事件（done/question/error 都有提示音 + 桌面通知，唯独审批没有），AI 会
	// 在后台干等。补齐同款三通道：提示音 + 桌面通知 + TTS 播报。
	// 按 ID 集合去重，切换会话核对代码后再切回时绝不重复响铃。
	useEffect(() => {
		const approval = chat.approval;
		const id = approval?.id ?? null;
		if (id !== null && !notifiedApprovalIds.current.has(id)) {
			notifiedApprovalIds.current.add(id);
			if (notifiedApprovalIds.current.size > 64) {
				const oldest = notifiedApprovalIds.current.values().next().value;
				if (oldest !== undefined) notifiedApprovalIds.current.delete(oldest);
			}
			playSound("approval", sound);
			const tool = typeof approval?.toolName === "string" ? approval.toolName : "";
			void notify(t("notifyApprovalTitle"), tool ? t("notifyApprovalBodyTool", { tool }) : t("notifyApprovalBody"));
			if (tts.enabled && tts.announce && !shouldSuppressNotify(currentPresence())) speak(t("ttsAnnounceApproval"), tts);
		}
	}, [chat.approval, sound, tts, t]);

	// Error cue — new error notices only.
	useEffect(() => {
		const err = [...chat.notices].reverse().find((n) => n.level === "error");
		if (err && err.id !== lastErrorNotice.current) {
			lastErrorNotice.current = err.id;
			playSound("error", sound);
			void notify(t("notifyErrorTitle"), t("notifyErrorBody"));
			if (tts.enabled && tts.announce && !shouldSuppressNotify(currentPresence())) speak(t("ttsAnnounceError"), tts);
		}
	}, [chat.notices, sound, tts, t]);
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
				// (\/(?!\/) 拒绝 // 开头：协议相对 URL（//evil.com/x）会被浏览器按当前
				// 协议解析成站外地址，根部署下 appUrl 又原样返回，挡不住跳站外。
				const hit = /🔗 已自动在浏览器打开\]\((\/(?!\/)[^)\s]+)\)/.exec((b as { text?: string }).text ?? "");
				if (hit?.[1]) {
					url = hit[1];
					break;
				}
			}
			if (!url) continue;
			let opened: Window | null = null;
			try {
				// 打开前再校验最终 URL 与应用同源（第二道闸）：不同源一律不自动开，
				// 只推带地址的 notice —— 聊天里的链接照样可点，用户自己决定去不去。
				const finalUrl = new URL(appUrl(url), window.location.href);
				if (finalUrl.origin === window.location.origin && document.hasFocus()) {
					opened = window.open(finalUrl.href, "_blank", "noopener");
				}
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
		silent = false,
	) => {
		// Dedupe on path + mode + line range so the same file can be attached
		// multiple ways (e.g. full content AND a line range) without doubling.
		const key = `${path}|${mode}|${lines ? `${lines.start}-${lines.end}` : ""}`;
		setAttachments((prev) =>
			prev.some((a) => `${a.path}|${a.mode}|${a.lines ? `${a.lines.start}-${a.lines.end}` : ""}` === key)
				? prev
				: [...prev, { path, name, mode, isDir, ...(lines ? { lines } : {}) }],
		);
		// 联动在输入框光标处插入 @提及（文件/目录/页签等所有带名引用统一行为）。
		// silent（@ 选单 acceptAt）：正文已由 ChatInput 亲自插好，这里不再插；
		// 重复点同一文件：ChatInput 的 insert sink 会判正文已有该 @提及而跳过。
		// 文件/目录类引用正文写相对路径而非 basename：同名条目（根目录 报告/ 与
		// 方案/报告/）靠路径才能区分，linkify 也按相对路径渲染文件药丸；
		// page 无文件路径语义，保持标题形式。
		const mention = mode === "page" ? name : path;
		if (!silent && mention) {
			insertTextAtCursor(`@${mention} `);
		}
	};
	const removeAttachment = (pathOrKey: string) => {
		let removedName = "";
		setAttachments((prev) =>
			prev.filter((a) => {
				const isHit = a.key
					? a.key === pathOrKey
					: a.mode === "conversation"
						? `conv|${a.conversationId ?? ""}|${a.sessionPath ?? ""}` === pathOrKey
						: a.path === pathOrKey;
				// 移除口径与 attach 插入一致：文件类提及正文是相对路径，page/conversation 是标题。
				if (isHit && !removedName) removedName = a.mode === "page" || a.mode === "conversation" ? a.name : a.path;
				return !isHit;
			}),
		);
		if (removedName) {
			removeMentionFromComposer(`@${removedName}`);
		}
	};

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
			if (msg.type === "new_chat" || msg.type === "switch_conversation" || msg.type === "switch_session") {
				setView((prev) => (prev !== "chat" ? "chat" : prev));
			}
			return send(msg);
		},
		[send],
	);

	// 后台会话问卷的右上角常驻横幅通知：展示 对话名字 + 问卷名字，点击切换到对应会话，对应横幅消失，其他对话横幅不变。
	const dismissedQuestionIdsRef = useRef<Set<string>>(new Set());
	const activeConvId = chat.activeConversationId || chat.state?.conversationId || "";

	useEffect(() => {
		const convsWithQuestion = chat.conversations.filter((c) => c.hasQuestion);
		const currentQuestionConvIds = new Set(convsWithQuestion.map((c) => c.id));
		const currentQuestionIds = new Set(convsWithQuestion.map((c) => c.questionId).filter(Boolean) as string[]);

		// 清理已解决问卷的 dismissed 标记（同会话未来新问卷可再次弹出）
		for (const qid of dismissedQuestionIdsRef.current) {
			if (!currentQuestionIds.has(qid)) {
				dismissedQuestionIdsRef.current.delete(qid);
			}
		}

		// 后台会话的问卷弹常驻横幅
		for (const c of convsWithQuestion) {
			const bannerId = `question-${c.id}`;
			// 当前激活的会话不显示后台横幅（它由中央模态对话框处理）
			if (c.id === activeConvId) {
				dismissBanner(bannerId, { silent: true });
				continue;
			}
			// 已被用户主动关闭的该次问卷不再重复弹出
			if (c.questionId && dismissedQuestionIdsRef.current.has(c.questionId)) {
				continue;
			}
			showBanner({
				id: bannerId,
				type: "question",
				title: c.title || t("chat"),
				message: c.questionTitle || t("waitingQuestionBadge"),
				persistent: true,
				dismissible: true,
				data: { conversationId: c.id, questionId: c.questionId },
				onClose: () => {
					if (c.questionId) dismissedQuestionIdsRef.current.add(c.questionId);
				},
				onClick: () => {
					panelSend({ type: "switch_conversation", id: c.id });
					dismissBanner(bannerId, { silent: true });
				},
			});
		}

		// 会话已无问卷或已被移除时，自动收起对应横幅
		dismissBannersWhere(
			(b) => {
				const convId = b.data?.conversationId as string | undefined;
				if (!convId) return false;
				return !currentQuestionConvIds.has(convId) || convId === activeConvId;
			},
			{ silent: true },
		);
	}, [chat.conversations, activeConvId, panelSend, t]);

	// -- pasted / dropped / uploaded images (no workspace path) ---------------
	const pasteImageId = useRef(0);
	const lastVisionWarn = useRef(0);
	// 以下四个函数都要作为 props 传给 memo 化的 ChatInput：流式重渲染期间引用必须
	// 稳定，否则 shallow 比较失效、输入框整棵重渲染。之前用 useCallback(fn, [fn])
	// 包普通函数 —— 依赖每次渲染都是新的，包装形同虚设；这里改成依赖正确的
	// useCallback（deps 里的 chat.state?.model 是服务端跨快照复用的稳定引用）。
	const attachImage = useCallback(
		(img: ProcessedImage) => {
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
					imageData: img.data,
					mimeType: img.mimeType,
				},
			]);
		},
		[chat.state?.model, pushNotice, t],
	);
	const addImageFiles = useCallback(
		async (files: File[]) => {
			for (const f of files) {
				const img = await fileToProcessedImage(f);
				if (!img) {
					pushNotice("error", t("imageLoadFailed", { name: f.name }));
					continue;
				}
				attachImage(img);
			}
		},
		[attachImage, pushNotice, t],
	);

	// -- dropped / uploaded files (any type, no workspace path) ---------------
	/** Keep in sync with MAX_UPLOAD_BYTES in agent-service.ts. */
	const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
	const uploadId = useRef(0);
	const attachLocalFile = useCallback(
		async (f: File) => {
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
					fileData: base64,
					size: f.size,
					mimeType: f.type || undefined,
				},
			]);
		},
		[MAX_UPLOAD_BYTES, pushNotice, t],
	);
	const addLocalFiles = useCallback(
		async (files: File[]) => {
			for (const f of files) {
				// Raster images go through the resize/encode pipeline (vision content);
				// everything else — including SVG — is uploaded raw and attached by path.
				if (isRasterImage(f.type)) {
					await addImageFiles([f]);
				} else {
					await attachLocalFile(f);
				}
			}
		},
		[addImageFiles, attachLocalFile],
	);

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
			const parsed = splitQuotedPrompt(text);
			const item = { text: parsed.text, seq: recallSeqRef.current };
			if (parsed.quotes.length)
				setAttachments((prev) =>
					appendDraftAttachments(
						prev,
						parsed.quotes.map((quote) => ({ path: "", name: "", mode: "quote", quote, key: randomUuid() })),
					),
				);
			setRecallDrafts((prev) => [...prev.slice(-9), item]);
		},
		[send],
	);

	// Stable callbacks for memoized panels (LeftPanel/RightPanel/ChatInput/
	// GoalBar skip re-render while tokens stream in — inline closures here
	// would break their shallow prop comparison every render).
	const openManageModels = useCallback(() => setManageModelsOpen(true), []);
	const clearAttachments = useCallback(() => setAttachments([]), []);
	// 待发附件跟会话走：会话身份一变（新建对话 / 切对话 / 过户 / 切项目）就清空，
	// 与正文草稿同口径 —— 正文是按 sessionId 存的（切会话即清空再恢复该会话的草稿），
	// 附件只在内存里；不清就会「正文已被新对话清掉、chips 还挂着旧对话的文件」，
	// 且那排 chips 会随下一条消息一起发出去。
	// 判定：composer-draft.ts 的 advanceComposerSession；接线：use-composer-session.ts
	//（两者都有单测，空 sessionId 的瞬时态不清）。
	useComposerSessionReset(chat.state?.sessionId ?? "", clearAttachments);
	const removeAttachmentCb = useCallback(removeAttachment, []);
	// addImageFiles/addLocalFiles 本体已是依赖正确的 useCallback（见上），引用在
	// 流式重渲染期间稳定，直接传给 memo 化的 ChatInput，无需再包一层。
	const addImageFilesCb = addImageFiles;
	const addLocalFilesCb = addLocalFiles;
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
			silent?: boolean;
		}) => attach(a.path, a.name, a.mode ?? "reference", a.isDir ?? false, a.lines, a.silent ?? false),
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
				onOpenIconEdit={() => setIconEditOpen(true)}
				sound={sound}
				onSoundChange={setSound}
				onSoundPreview={(kind: SoundKind) => playSound(kind, sound)}
				themes={themes}
				theme={theme}
				onThemeChange={switchTheme}
				reloadThemes={reloadThemes}
			/>
			{iconEditOpen && (
				<IconEditor
					slots={uiSlots}
					layout={chat.settings?.uiLayout}
					exclude={HIDDEN_FROM_LAYOUT_ITEM_IDS}
					onClose={() => setIconEditOpen(false)}
				/>
			)}
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
					ref={layoutRef}
					className="layout"
					style={{ "--left-w": `${leftWidth}px`, "--right-w": `${rightWidth}px` } as CSSProperties}
				>
					{/* 遮罩：移动端**常驻**（否则关着的抽屉被手势拉出来时没有可渐变的遮罩，见
					    `use-swipe-drawer.ts`），靠 `.on` 类控制显隐与可点；桌面端仍按需挂载。 */}
					{isMobile ? (
						<div className={`drawer-backdrop persistent${drawer ? " on" : ""}`} onClick={() => setDrawer(null)} />
					) : (
						drawer && <div className="drawer-backdrop" onClick={() => setDrawer(null)} />
					)}
					{/* 悬浮停靠栏是**布局内的贴边槽位**（不再是覆盖一切的 fixed 浮层）：夹在屏幕边缘与
					    面板之间，面板与主区自动向内让出它的宽度 —— 面板里的按钮再也不会被压住；该侧没有
					    图标时整条不渲染，连宽度都不占。 */}
					<SideDock
						side="left"
						items={uiSidebarLeft}
						chat={chat}
						view={view}
						onViewChange={(v: ViewName) => {
							terminalOpenRequested.current = v === "terminal" && chat.terminals.length === 0;
							if (terminalOpenRequested.current && createShell()) {
								terminalOpenRequested.current = false;
							}
							setView(v);
							setDrawer(null);
						}}
						onOpenPanel={setDrawer}
						onOpenSettings={(sec) => {
							setSettingsInitialSection(sec as any);
							setSettingsOpen(true);
						}}
						onOpenBgTasks={() => setBgTasksOpen(true)}
						onOpenGlobalSearch={() => setGlobalSearchOpen(true)}
						onUiAction={onUiAction}
						uiContextTopbar={uiSlots["contextmenu.topbar"]}
						onThemeToggle={() => switchTheme(theme === "light" ? null : "light")}
						onSoundToggle={() => setSound({ ...sound, enabled: !sound.enabled })}
					/>
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
								uiContextProject={uiSlots["contextmenu.project"]}
								uiProjectsActions={uiLeftProjectsActions}
								uiLeftProject={uiLeftProject}
								uiRunningActions={uiLeftRunningActions}
								uiHistoryActions={uiLeftHistoryActions}
								uiSections={uiLeftSections}
								renderPluginSectionBody={renderLeftPluginSectionBody}
								uiLeftRunning={uiLeftRunning}
								uiLeftHistory={uiLeftHistory}
								uiPluginRunning={chat.pluginPanelGroups}
								onPluginRunningAction={onPluginRunningAction}
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
								<>
									{chat.state.isEphemeral && (
										<div className="ephemeral-banner">
											<span>🎭 {t("ephemeralBannerText")}</span>
											<button
												type="button"
												className="ephemeral-save"
												onClick={() => send({ type: "persist_conversation", id: activeConvId })}
											>
												💾 {t("saveEphemeral")}
											</button>
										</div>
									)}
									<MessageList
										uiMessageActions={uiSlots["message.actions"]}
										uiContextMessage={uiSlots["contextmenu.message"]}
										/* 工具调用卡片的工具名右键菜单（contextmenu.toolcall）：条目已合并好，
										   工具卡只管开菜单 + 分派它自己的 host:tool-info。 */
										uiContextToolCall={uiSlots["contextmenu.toolcall"]}
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
										toolImages={chat.settings?.toolImagesEnabled ?? true}
										keepRecent={chat.settings?.keepRecentMessages}
										jumpTarget={searchJump}
										onJumpDone={() => setSearchJump(null)}
										urlJumpMessageId={urlJump && urlJump.sessionId === chat.state.sessionId ? urlJump.messageId : null}
										onUrlJumpDone={() => setUrlJump(null)}
									/>
								</>
							) : (
								<div className="boot-wait">{chat.ready ? t("loadingSession") : t("connectingServer")}</div>
							)}

							{/* 目标条宿主槽：只包 GoalBar。折叠态时槽高 0（药丸脱离文档流），
							    展开态就是原来那一条（.goalbar 自带 margin）。 */}
							{chat.settings?.goalModeEnabled !== false && (
								<div className="goalbar-slot">
									<GoalBar
										goal={chat.goal}
										models={chat.models}
										modelsLoading={chat.modelsLoading}
										activeConversationId={chat.activeConversationId}
										uiGoalbarActions={uiGoalbarActions}
										onUiAction={onUiAction}
									/>
								</div>
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
							{chat.question && (
								<DshQuestionDialog
									question={chat.question}
									conversationTitle={
										chat.question.conversationTitle ||
										chat.conversations.find((c) => c.id === (chat.question?.conversationId || activeConvId))?.title
									}
								/>
							)}
							{/* 跨页作答：别处会话的问卷在本页弹框（id 对方会话作用域，提交带 owner）。 */}
							{chat.remoteQuestion && (
								<DshQuestionDialog
									question={chat.remoteQuestion}
									owner={chat.remoteQuestion.owner}
									conversationTitle={
										chat.remoteQuestion.conversationTitle ||
										chat.conversations.find((c) => c.id === chat.remoteQuestion?.convId)?.title
									}
								/>
							)}
							{/* 任务执行看板 (Plan Mode) */}
							<PlanBoard
								plan={
									chat.activeConversationId && chat.state?.conversationId !== chat.activeConversationId
										? null
										: chat.state?.plan
								}
							/>
							<ChatInput
								composerLeading={uiSlots["composer.leading"]}
								composerActions={uiSlots["composer.actions"]}
								onUiAction={onUiAction}
								streaming={chat.state?.isStreaming ?? false}
								planMode={chat.state?.planMode ?? false}
								messages={chat.state?.messages ?? EMPTY_MESSAGES}
								slashCommands={chat.slashCommands}
								modelState={modelState}
								models={chat.models}
								modelsLoading={chat.modelsLoading}
								providerKeys={chat.providerKeys}
								defaultModel={chat.engine === "pi" ? chat.defaultModel : undefined}
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
								dshPermCurrent={chat.state?.permission ?? null}
								dshPermOptions={chat.dshPermission?.options ?? undefined}
								dshPermDefault={chat.dshPermission?.defaultPreset}
								dshPreset={chat.state?.agentPreset ?? null}
								dshPresets={chat.dshPresets?.presets ?? undefined}
								dshPresetDefault={chat.dshPresets?.defaultPreset}
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
									openFile(path, name);
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
					<SideDock
						side="right"
						items={uiSidebarRight}
						chat={chat}
						view={view}
						onViewChange={(v: ViewName) => {
							terminalOpenRequested.current = v === "terminal" && chat.terminals.length === 0;
							if (terminalOpenRequested.current && createShell()) {
								terminalOpenRequested.current = false;
							}
							setView(v);
							setDrawer(null);
						}}
						onOpenPanel={setDrawer}
						onOpenSettings={(sec) => {
							setSettingsInitialSection(sec as any);
							setSettingsOpen(true);
						}}
						onOpenBgTasks={() => setBgTasksOpen(true)}
						onOpenGlobalSearch={() => setGlobalSearchOpen(true)}
						onUiAction={onUiAction}
						uiContextTopbar={uiSlots["contextmenu.topbar"]}
						onThemeToggle={() => switchTheme(theme === "light" ? null : "light")}
						onSoundToggle={() => setSound({ ...sound, enabled: !sound.enabled })}
					/>
				</div>
			</TemplateProvider>
			<FooterBar
				chat={chat}
				bottombarItems={uiSlots["bottombar"]}
				onUiAction={onUiAction}
				onOpenSettings={() => {
					setSettingsInitialSection(undefined);
					setSettingsOpen(true);
				}}
				onViewChange={(v: ViewName) => {
					terminalOpenRequested.current = v === "terminal" && chat.terminals.length === 0;
					if (terminalOpenRequested.current && createShell()) {
						terminalOpenRequested.current = false;
					}
					setView(v);
					setDrawer(null);
				}}
				onOpenGlobalSearch={() => setGlobalSearchOpen(true)}
				onOpenBgTasks={() => setBgTasksOpen(true)}
			/>
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
			{pluginFile && (
				<PluginFilePreview
					file={pluginFile.file}
					plugin={pluginFile.plugin}
					declaration={pluginFile.declaration}
					epoch={chat.pluginsEpoch}
					send={send}
					onClose={() => setPluginFile(null)}
					onFallback={() => {
						setPluginFile(null);
						setPreviewFile(pluginFile.file);
					}}
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
					testModelConnectionResult={chat.testModelConnectionResult}
					enrichModelsResult={chat.enrichModelsResult}
					enrichModelsProgress={chat.enrichModelsProgress}
					refreshBuiltinResult={chat.refreshBuiltinResult}
					refreshProviderResult={chat.refreshProviderResult}
					appendBuiltinResult={chat.appendBuiltinResult}
					cloneProviderResult={chat.cloneProviderResult}
					defaultModel={chat.defaultModel}
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
					onOpenIconEdit={() => setIconEditOpen(true)}
					sound={sound}
					onSoundChange={setSound}
					tts={tts}
					onTtsChange={setTts}
				/>
			)}
			{bgTasksOpen && (
				<BgTasksModal
					servers={chat.bgServers}
					plugins={chat.plugins}
					epoch={chat.pluginsEpoch}
					send={send}
					onUiAction={onUiAction}
					autoCleanupMin={chat.settings?.bgAutoCleanupMin ?? 0}
					onClose={() => setBgTasksOpen(false)}
				/>
			)}
			{/* 工具定义说明弹窗（工具卡右键菜单 host:tool-info）：自己订阅 store，无 props。 */}
			<ToolInfoDialog />
			{/* 会话回滚确认弹窗（Dual-State Rollback） */}
			<RollbackDialog />
			{/* 人机协同拦截与「改写执行」审批弹窗 */}
			<ToolApprovalDialog approval={chat.approval} />
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
					openFile(path, name);
				}}
			/>
			{/* 插件能力授权 / 目录访问确认顶层浮层：必须高于设置等弹窗（z-index > 300），确保安装插件或跨视图调用时无需叉掉设置页 */}
			{(pendingPermRequest || pendingPathRequest || pluginPathConfirm) && (
				<div className="modal-backdrop perm-modal-backdrop">
					{pendingPermRequest && (
						<div className="dialog-inline perm-dialog-card" data-dialog-kind="confirm">
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
									<button type="button" className="btn" onClick={() => answerPermRequest(pendingPermRequest.id, false)}>
										{t("pluginGrantDeny")}
									</button>
									<button type="button" className="btn" onClick={() => answerPermRequest(pendingPermRequest.id, true)}>
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
						<div className="dialog-inline perm-dialog-card" data-dialog-kind="confirm">
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
									<button type="button" className="btn" onClick={() => answerPathRequest(pendingPathRequest.id, false)}>
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
						<div className="dialog-inline perm-dialog-card" data-dialog-kind="confirm">
							<div className="dialog-head">
								<span className="dialog-badge">{t("pluginRequest")}</span>
								<span className="dialog-title">{t("pluginSessionGrantTitle")}</span>
								<button
									type="button"
									className="dialog-dismiss"
									title={t("cancel")}
									onClick={() => {
										pluginPathConfirmRef.current = null;
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
											pluginPathConfirmRef.current = null;
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
											pluginPathConfirmRef.current = null;
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
				</div>
			)}
			{/* 当设置面板关闭但在后台有插件正在安装/更新/卸载时，在界面右上角提示轻量进度条，点击可重新打开设置面板 */}
			{!settingsOpen && Object.values(chat.pluginJobs ?? {}).some((j) => j.phase !== "done") && (
				<div
					className="active-plugin-jobs-bar"
					onClick={() => {
						setSettingsInitialSection("plugins");
						setSettingsOpen(true);
					}}
					title={t("pluginJobRunning")}
				>
					<FiRefreshCw className="spin" />
					<span className="active-plugin-jobs-title">
						{t("pluginJobRunning")}:{" "}
						{Object.values(chat.pluginJobs ?? {})
							.filter((j) => j.phase !== "done")
							.map((j) => j.pluginId)
							.join(", ")}
					</span>
					{(() => {
						const firstRunning = Object.values(chat.pluginJobs ?? {}).find((j) => j.phase !== "done");
						const lastLine = firstRunning?.lines[firstRunning.lines.length - 1];
						return lastLine ? <span className="active-plugin-jobs-line">{lastLine}</span> : null;
					})()}
				</div>
			)}
			<BannerContainer />
		</div>
	);
}
