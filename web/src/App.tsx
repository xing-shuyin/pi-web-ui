import { createPortal } from "react-dom";
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
import { RemoteDesktopWindow } from "./components/RemoteDesktopWindow";
import { LeftPanel } from "./components/LeftPanel";
import { RightPanel } from "./components/RightPanel";
import { MessageList } from "./components/MessageList";
import { ChatInput } from "./components/ChatInput";
import { GoalBar } from "./components/GoalBar";
import { SandboxModal } from "./components/SandboxModal";
import { DesktopSplitResizer } from "./components/DesktopSplitResizer";
import { WorktreeView, useWorktreeRefresh } from "./components/WorktreeBanner";
import { FiRefreshCw, FiFeather } from "react-icons/fi";
import { useEscapeKey } from "./shortcut-stack";
import { useOverlayZIndex } from "./overlay-stack";

import { FooterBar } from "./components/FooterBar";
import { formatSessionHash, parseSessionHash } from "./session-url";
import { SideDock } from "./components/SideDock";
import { Dialog } from "./components/Dialog";
import { QuestionQueue } from "./components/QuestionQueue";
import { resolveQuestionQueue, mergeOwnedPending } from "./question-queue";
import { presetText } from "./components/DshPresetBar";
const TerminalPanel = lazy(() => import("./components/TerminalPanel").then((m) => ({ default: m.TerminalPanel })));
const NativeCliPanel = lazy(() => import("./components/NativeCliPanel").then((m) => ({ default: m.NativeCliPanel })));
import "./native-cli.css";
import { NativeCliCreateModal } from "./components/NativeCliCreateModal";
import { requestNativeCliChat } from "./new-chat-request";
const ScmPanel = lazy(() => import("./components/SCMPanel").then((m) => ({ default: m.ScmPanel })));
const DeviceCenter = lazy(() => import("./components/DeviceCenter").then((m) => ({ default: m.DeviceCenter })));
const DeviceGroupCreateDialog = lazy(() =>
	import("./components/DeviceGroups").then((m) => ({ default: m.DeviceGroupCreateDialog })),
);
const CanvasStudio = lazy(() => import("./components/canvas/CanvasStudio").then((m) => ({ default: m.CanvasStudio })));
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
import { contextMenuItems, openContextMenu } from "./context-menu-state";
import { isExtractableArchive } from "./file-transfer";
import { BannerContainer } from "./components/BannerContainer";
import { QuickAskPopover } from "./components/QuickAskPopover";
import { openQuickAsk, type QuickAskReferenceSource } from "./quick-ask";
import { IconEditor } from "./components/IconEditor";
import { showBanner, dismissBanner, dismissBannersWhere } from "./banner-notice";
import { setFooterStatus as setFooterStatusStore } from "./footer-status";
import { ensurePluginViewLoaded } from "./plugin-loader";
import {
	registerAttachmentSink,
	registerSessionSwitchSink,
	composeToComposer,
	getComposerTarget,
	insertTextAtCursor,
	removeMentionFromComposer,
	focusComposer,
} from "./composer-bridge";
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
const PiSetupModal = lazy(() => import("./components/PiSetupModal").then((m) => ({ default: m.PiSetupModal })));
import { isDesktopShell } from "./desktop";
const ModelConfigModal = lazy(() =>
	import("./components/ModelConfigModal").then((m) => ({ default: m.ModelConfigModal })),
);
import { DirectoryBrowser } from "./components/DirectoryBrowser";
import { ModelPickerModal } from "./components/ModelPickerModal";

const SettingsModal = lazy(() => import("./components/SettingsModal").then((m) => ({ default: m.SettingsModal })));
const BgTasksModal = lazy(() => import("./components/BgTasksModal").then((m) => ({ default: m.BgTasksModal })));
import { PluginPage } from "./components/PluginPage";
import { RollbackDialog } from "./components/RollbackDialog";
import { openRollbackDialog } from "./rollback-state";
import { ToolApprovalDialog } from "./components/ToolApprovalDialog";
const TuiOverlayModal = lazy(() =>
	import("./components/TuiOverlayModal").then((m) => ({ default: m.TuiOverlayModal })),
);
import { PlanBoard } from "./components/PlanBoard";
import { ToolInfoDialog } from "./components/ToolInfoDialog";
import { ToolInspectorModal } from "./components/ToolInspectorModal";
const GlobalSearchModal = lazy(() =>
	import("./components/GlobalSearchModal").then((m) => ({ default: m.GlobalSearchModal })),
);
import { PluginModal } from "./components/PluginModal";
import { TemplateProvider } from "./components/PromptTemplates";
import type { PreviewFile } from "./components/FilePreview";
const FilePreview = lazy(() => import("./components/FilePreview").then((m) => ({ default: m.FilePreview })));
import { DeferredMount } from "./components/DeferredMount";
import { PluginFilePreview } from "./components/PluginFilePreview";
import { getClientId, useChat } from "./use-chat";
import { useAppField } from "./app-globals";
import { useSwipeDrawer } from "./use-swipe-drawer";
import { appUrl } from "./base-url";
import { openDeviceGroup } from "./device-group-navigation";
const GroupConversation = lazy(() =>
	import("./components/GroupConversation").then((m) => ({ default: m.GroupConversation })),
);
import type {
	ClientMessage,
	CommandDef,
	NativeCliConfig,
	NativeCliConversation,
	PromptAttachment,
	UiMessage,
	UiTextBlock,
} from "./types";
import { isZhLocale, useT, useI18n } from "./i18n";
import { QUICK_PHRASE_DEFAULTS } from "./quick-phrases";
import {
	FiAlertCircle,
	FiAlertTriangle,
	FiBookmark,
	FiCheck,
	FiChevronLeft,
	FiChevronRight,
	FiInfo,
	FiTrash2,
	FiUpload,
	FiX,
} from "react-icons/fi";
import { LuFlaskConical } from "react-icons/lu";
import type { Notice } from "./use-chat";
import { fileToProcessedImage, isRasterImage, type ProcessedImage } from "./image-paste";
import { randomUuid } from "./uuid";
import { recordModelUsage } from "./model-usage";
import { loadSoundSettings, playSound, saveSoundSettings, type SoundSettings } from "./sounds";
import {
	assistantPlainText,
	StreamSentenceExtractor,
	loadTtsSettings,
	saveTtsSettings,
	speak,
	startStreamSpeech,
	type StreamSpeechQueue,
	type TtsSettings,
} from "./tts";
import { shouldSuppressNotify, currentPresence } from "./notify";
import { useWideChat, useHideModelRow } from "./chat-width-settings";
import { registerFilePreviewHost } from "./file-preview-bridge";
import { registerImageLightboxHost, type ImageLightboxTarget } from "./image-lightbox-bridge";
import { ImageLightbox } from "./components/ImageLightbox";
import { registerImageOcrInstaller, setImageOcrInstallState } from "./image-ocr-install";
import { listImageOcrProviders, subscribeImageOcrProviders } from "./image-ocr-providers";
import { projectNameFromCwd, useProjectTitle } from "./title-settings";
import { useFaviconSettings, resolveInstanceName, syncServerFaviconConfig } from "./favicon-settings";
import { notify, subscribeNotificationClicks } from "./notify";
import {
	consumeMobileNotificationTarget,
	hasPendingMobileNotificationTarget,
	isMobileRuntime,
	MOBILE_NOTIFICATION_OPEN,
	mobileNotificationRequest,
	type MobileNotificationTarget,
} from "./mobile-runtime";
import { diffStreamingCues } from "./streaming-cues";
import { markConversationsUnread, clearConversationUnread, useUnreadConversationKeys } from "./unread-conversations";
import { getNoticeDurationMs } from "./notice-policy";
import { useTheme } from "./theme";
import { useWallpaperEffect } from "./wallpaper";

export interface PendingAttachment {
	path: string;
	name: string;
	mode?: "inline" | "reference" | "lines" | "page" | "conversation" | "quote" | "canvas";
	quote?: import("./types").TextQuote;
	conversationId?: string;
	sessionPath?: string;
	isDir?: boolean;
	lines?: { start: number; end: number };
	imageData?: string;
	mimeType?: string;
	fileData?: string;
	size?: number;
	key?: string;
}

function NoticeToast({ notice, onDismiss }: { notice: Notice; onDismiss: (id: number) => void }) {
	const t = useT();
	const { locale } = useI18n();
	const text = !isZhLocale(locale) && notice.textEn ? notice.textEn : notice.text;
	const [paused, setPaused] = useState(false);
	useEffect(() => {
		if (paused) return;
		const timer = setTimeout(() => onDismiss(notice.id), getNoticeDurationMs(notice.level));
		return () => clearTimeout(timer);
	}, [paused, notice.id, notice.level, onDismiss]);
	const Icon = notice.level === "error" ? FiAlertCircle : notice.level === "warning" ? FiAlertTriangle : FiInfo;
	return (
		<div
			className={`notice notice-${notice.level}${paused ? " paused" : ""}`}
			role="status"
			onMouseEnter={() => setPaused(true)}
			onMouseLeave={() => setPaused(false)}
			onClick={() => {
				if (window.getSelection?.()?.toString()) return;
				onDismiss(notice.id);
			}}
		>
			<Icon className="notice-icon" />
			<span className="notice-text">{text}</span>
			<button
				type="button"
				className="notice-close"
				title={t("close")}
				onClick={(e) => {
					e.stopPropagation();
					onDismiss(notice.id);
				}}
			>
				<FiX />
			</button>
		</div>
	);
}
const EMPTY_MESSAGES: UiMessage[] = [];

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

function ResizeHandle({ side, width, onResize }: { side: PanelSide; width: number; onResize: (w: number) => void }) {
	const t = useT();
	const onPointerDown = useCallback(
		(e: ReactPointerEvent<HTMLDivElement>) => {
			e.preventDefault();
			const startX = e.clientX;
			const startW = width;
			let last = startW;
			const move = (ev: PointerEvent) => {
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
				} catch {}
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

function PanelRail({ side, onClick }: { side: PanelSide; onClick: () => void }) {
	const t = useT();
	return (
		<button type="button" className={`panel-rail panel-rail-${side}`} title={t("expandPanel")} onClick={onClick}>
			{side === "left" ? <FiChevronRight /> : <FiChevronLeft />}
		</button>
	);
}

type ViewName = import("./components/BarItem").ViewName;

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
	} catch {}
}

export function App() {
	const t = useT();
	const { locale } = useI18n();
	const { chat, send, dismissNotice, pushNotice, terminal } = useChat();
	const sharedReadOnly = chat.state?.sharedConversation?.readOnly === true;
	const quickSeedRef = useRef(false);
	// 插件通用 toast：plugin-host 会在无 notifyAction 依赖时 dispatch "pi-web-ui:toast"，接到全局 NoticeToast
	useEffect(() => {
		const onPluginToast = (event: Event) => {
			const detail = (event as CustomEvent).detail as { text?: unknown; level?: unknown } | undefined;
			const text = typeof detail?.text === "string" ? detail.text.trim() : "";
			if (!text) return;
			const level = detail?.level === "warning" || detail?.level === "error" ? detail.level : "info";
			pushNotice(level, text);
		};
		window.addEventListener("pi-web-ui:toast", onPluginToast);
		return () => window.removeEventListener("pi-web-ui:toast", onPluginToast);
	}, [pushNotice]);
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
	const cwd = chat.state?.cwd ?? "";
	const projectTitle = useProjectTitle();
	const faviconSettings = useFaviconSettings();
	const instanceName = resolveInstanceName(faviconSettings);

	useEffect(() => {
		void syncServerFaviconConfig();
	}, []);

	useEffect(() => {
		const name = projectTitle ? projectNameFromCwd(cwd) : "";
		const base = name ? `${name} — pi-web-ui` : t("docTitle");
		document.title = instanceName ? `[${instanceName}] ${base}` : base;
	}, [cwd, projectTitle, instanceName, t]);
	const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
	useEffect(() => {
		registerAttachmentSink((items) => setAttachments((prev) => appendDraftAttachments(prev, items)));
		return () => registerAttachmentSink(null);
	}, []);
	const [previewFiles, setPreviewFiles] = useState<PreviewFile[] | null>(null);
	const [previewIndex, setPreviewIndex] = useState(0);
	const previewFile = previewFiles ? (previewFiles[previewIndex] ?? previewFiles[0] ?? null) : null;
	const [pluginFile, setPluginFile] = useState<{
		file: PreviewFile;
		plugin: FileHandlerPlugin;
		declaration: import("./plugin-file-handlers").FileHandlerDeclaration;
	} | null>(null);
	const previewOpenRef = useRef(false);
	const pluginFileOpenRef = useRef<typeof pluginFile>(null);
	useEffect(() => {
		previewOpenRef.current = previewFiles !== null;
		pluginFileOpenRef.current = pluginFile;
	}, [previewFiles, pluginFile]);
	const openFile = useCallback((path: string, name: string) => {
		const entry = findFileHandler(name);
		if (entry) {
			setPreviewFiles(null);
			setPluginFile({ file: { path, name }, plugin: entry.plugin, declaration: entry.declaration });
			return;
		}
		setPluginFile(null);
		setPreviewFiles([{ path, name }]);
		setPreviewIndex(0);
	}, []);
	const openFileList = useCallback((files: PreviewFile[], initialIndex = 0) => {
		const list = (Array.isArray(files) ? files : []).filter((f) => f && typeof f.path === "string" && f.path);
		if (list.length === 0) return;
		const clamped = Math.min(Math.max(0, initialIndex | 0), list.length - 1);
		const first = list[clamped] ?? list[0];
		const entry = first ? findFileHandler(first.name) : null;
		if (entry && first) {
			setPreviewFiles(null);
			setPluginFile({
				file: { path: first.path, name: first.name },
				plugin: entry.plugin,
				declaration: entry.declaration,
			});
			return;
		}
		setPluginFile(null);
		setPreviewFiles(list.map((f) => ({ path: f.path, name: f.name })));
		setPreviewIndex(clamped);
	}, []);
	useEffect(() => {
		registerFilePreviewHost({
			open: (f) => openFile(f.path, f.name),
			openList: (files, initialIndex) => openFileList(files, initialIndex ?? 0),
			isOpen: () => previewOpenRef.current || pluginFileOpenRef.current !== null,
		});
		return () => registerFilePreviewHost(null);
	}, [openFile]);
	const [lightboxImage, setLightboxImage] = useState<ImageLightboxTarget | null>(null);
	const lightboxOpenRef = useRef(false);
	useEffect(() => {
		lightboxOpenRef.current = lightboxImage !== null;
	}, [lightboxImage]);
	useEffect(() => {
		registerImageLightboxHost({
			open: (target) => setLightboxImage(target),
			close: () => setLightboxImage(null),
			isOpen: () => lightboxOpenRef.current,
		});
		return () => registerImageLightboxHost(null);
	}, []);
	const [appDragOver, setAppDragOver] = useState(false);
	useEffect(() => {
		const clear = () => setAppDragOver(false);
		window.addEventListener("drop", clear, true);
		return () => window.removeEventListener("drop", clear, true);
	}, []);
	const [viewChosen, setView] = useState<ViewName>(() =>
		new URLSearchParams(window.location.search).get("view") === "devices" ? "devices" : "chat",
	);
	const [nativeCliCreateCwd, setNativeCliCreateCwd] = useState<string | null>(null);
	const [nativeCliCreating, setNativeCliCreating] = useState(false);
	const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
	const [deviceGroupCreateOpen, setDeviceGroupCreateOpen] = useState(false);
	useEffect(() => {
		registerSessionSwitchSink(() => {
			setActiveGroupId(null);
			setView("chat");
		});
		return () => registerSessionSwitchSink(null);
	}, []);
	useEffect(() => {
		const open = (event: Event) => {
			const detail = (event as CustomEvent).detail;
			if (!detail || typeof detail !== "object") return;
			if (detail.create === true) {
				setDeviceGroupCreateOpen(true);
				return;
			}
			openDeviceGroup({
				roomId: typeof detail.roomId === "string" ? detail.roomId : undefined,
				create: detail.create === true,
				manage: detail.manage === true,
			});
			if (typeof detail.roomId === "string" && !detail.manage && !detail.create) {
				setActiveGroupId(detail.roomId);
				setView("chat");
			} else {
				setActiveGroupId(null);
				setView("devices");
			}
		};
		window.addEventListener("pi-web-ui:device-group-open", open);
		return () => window.removeEventListener("pi-web-ui:device-group-open", open);
	}, []);
	const tabOn = (tab: string) =>
		!chat.tabs || tab === "chat" || tab === "devices" || tab === "worktrees" || chat.tabs.includes(tab);
	const viewTab = viewChosen.startsWith("plugin:") ? "plugins" : viewChosen;
	const view: ViewName =
		tabOn(viewTab) &&
		viewChosen !== "native-cli" &&
		(!sharedReadOnly || viewChosen === "chat" || viewChosen === "devices")
			? viewChosen
			: "chat";
	const isNativeCliConversation = Boolean(chat.state?.nativeCli) && !activeGroupId && !sharedReadOnly;
	const [cachedNativeClis, setCachedNativeClis] = useState<
		Record<string, { nativeCli: NativeCliConversation; cwd: string }>
	>({});

	useEffect(() => {
		if (isNativeCliConversation && chat.state?.nativeCli && chat.state.conversationId) {
			const id = chat.state.conversationId;
			const nativeCli = chat.state.nativeCli;
			const cwd = chat.state.cwd;
			setCachedNativeClis((prev) => {
				const current = prev[id];
				if (current && current.nativeCli === nativeCli && current.cwd === cwd) return prev;
				return { ...prev, [id]: { nativeCli, cwd } };
			});
		}
	}, [isNativeCliConversation, chat.state?.nativeCli, chat.state?.conversationId, chat.state?.cwd]);

	useEffect(() => {
		const liveConvIds = new Set(chat.conversations.map((c) => c.id));
		setCachedNativeClis((prev) => {
			let changed = false;
			const next: typeof prev = {};
			for (const [id, val] of Object.entries(prev)) {
				if (liveConvIds.has(id)) {
					next[id] = val;
				} else {
					changed = true;
				}
			}
			return changed ? next : prev;
		});
	}, [chat.conversations]);

	const nativeCliViewRef = useRef(false);
	nativeCliViewRef.current = view === "chat" && isNativeCliConversation;
	const refreshWorktrees = useCallback(() => send({ type: "refresh_worktrees" }), [send]);
	useWorktreeRefresh(chat.state?.worktree?.mainPath, refreshWorktrees);
	const pendingWorktreeSwitch = useRef<{ source: string; target: string } | null>(null);
	useEffect(() => {
		const pending = pendingWorktreeSwitch.current;
		if (!pending || !chat.state?.cwd) return;
		if (view !== "worktrees") {
			pendingWorktreeSwitch.current = null;
			return;
		}
		if (chat.state.cwd === pending.target || chat.state.worktree?.currentPath === pending.target) {
			pendingWorktreeSwitch.current = null;
			setView("chat");
			focusComposer();
		} else if (chat.state.cwd !== pending.source) {
			pendingWorktreeSwitch.current = null;
		}
	}, [chat.state?.cwd, chat.state?.worktree?.currentPath, view]);
	const enabledPlugins = useMemo(
		() => chat.plugins.filter((p) => !chat.settings?.disabledPlugins?.includes(p.id)),
		[chat.plugins, chat.settings?.disabledPlugins],
	);
	const [uiSlots, uiDiagnostics] = useMemo(() => {
		const diagnostics: UiDiagnostic[] = [];
		const slots = buildUiSlots(withPluginViewItems(chat.plugins), {
			locale,
			t: (key: string) => t(key as Parameters<typeof t>[0]),
			disabledPlugins: chat.settings?.disabledPlugins ?? [],
			layout: chat.settings?.uiLayout,
			diagnostics,
		});
		return [slots, diagnostics] as const;
	}, [chat.plugins, chat.settings?.disabledPlugins, chat.settings?.uiLayout, locale, t]);

	const lastUiDiagFingerprintRef = useRef("");
	useEffect(() => {
		const fp = uiDiagnostics.map((d) => `${d.level}:${d.pluginId ?? ""}:${d.entryId ?? ""}:${d.message}`).join("\n");
		if (fp === lastUiDiagFingerprintRef.current) return;
		lastUiDiagFingerprintRef.current = fp;
		for (const d of uiDiagnostics) {
			const prefix = `[ui-slot] ${d.pluginId ? `[${d.pluginId}] ` : ""}`;
			if (d.level === "error") {
				console.error(`${prefix}${d.message}`);
			} else if (d.level === "warn") {
				console.warn(`${prefix}${d.message}`);
			} else {
				console.debug(`${prefix}${d.message}`);
			}
		}
	}, [uiDiagnostics]);
	const uiPrimary = useMemo(() => uiSlots["topbar.primary"].filter((e) => !e.hidden), [uiSlots]);
	const uiOverflow = useMemo(
		() => [...uiSlots["topbar.primary"].filter((e) => e.hidden), ...uiSlots["topbar.overflow"]],
		[uiSlots],
	);
	const uiLeftSessions = useMemo(() => uiSlots["leftpanel.sessions"].filter((e) => !e.hidden), [uiSlots]);
	const uiLeftProjectsActions = useMemo(
		() => uiSlots["leftpanel.projects.actions"].filter((e) => !e.hidden),
		[uiSlots],
	);
	const uiLeftProject = useMemo(() => uiSlots["leftpanel.project"].filter((e) => !e.hidden), [uiSlots]);
	const uiLeftRunningActions = useMemo(() => uiSlots["leftpanel.running.actions"].filter((e) => !e.hidden), [uiSlots]);
	const uiLeftHistoryActions = useMemo(() => uiSlots["leftpanel.history.actions"].filter((e) => !e.hidden), [uiSlots]);
	const uiLeftSections = uiSlots["leftpanel.sections"];
	const uiLeftRunning = useMemo(() => uiSlots["leftpanel.running"].filter((e) => !e.hidden), [uiSlots]);
	const uiLeftHistory = useMemo(() => uiSlots["leftpanel.history"].filter((e) => !e.hidden), [uiSlots]);
	const uiTerminalToolbar = useMemo(() => uiSlots["terminal.toolbar"].filter((e) => !e.hidden), [uiSlots]);
	const uiScmToolbar = useMemo(() => uiSlots["scm.toolbar"].filter((e) => !e.hidden), [uiSlots]);
	const uiGoalbarActions = useMemo(() => uiSlots["goalbar.actions"].filter((e) => !e.hidden), [uiSlots]);
	const uiChatHeader = useMemo(() => uiSlots["chat.header"].filter((e) => !e.hidden), [uiSlots]);
	const uiChatEmpty = useMemo(() => uiSlots["chat.empty"].filter((e) => !e.hidden), [uiSlots]);
	const uiFilePreviewToolbar = useMemo(() => uiSlots["file.preview.toolbar"].filter((e) => !e.hidden), [uiSlots]);
	const presetNames = useMemo(
		() => Object.fromEntries((chat.dshPresets?.presets ?? []).map((p) => [p.id, presetText(p, locale, t).name])),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[chat.dshPresets, locale],
	);
	const uiNoticeActions = useMemo(() => uiSlots["notice.actions"].filter((e) => !e.hidden), [uiSlots]);
	const uiSidebarLeft = useMemo(() => uiSlots["sidebar.left"] ?? [], [uiSlots]);
	const uiSidebarRight = useMemo(() => uiSlots["sidebar.right"] ?? [], [uiSlots]);
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
	const renderLeftPluginSectionBody = useCallback(
		(entry: UiSlotEntry) => {
			const plugin = chat.plugins.find((p) => p.id === entry.source.slice("plugin:".length));
			if (!plugin) return null;
			return <PluginPage plugin={plugin} epoch={chat.pluginsEpoch} send={send} className="lp-plugin-page" />;
		},
		[chat.plugins, chat.pluginsEpoch, send],
	);
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
	const [pluginViews, setPluginViews] = useState<LoadedPluginView[]>([]);
	useEffect(() => subscribeLoadedPluginViews(setPluginViews), []);
	const [failedPluginViews, setFailedPluginViews] = useState<string[]>([]);
	useEffect(() => subscribePluginLoadFailed(setFailedPluginViews), []);
	const [openModalId, setOpenModalId] = useState<string | null>(null);
	const [pluginDirPicker, setPluginDirPicker] = useState<{
		initialPath?: string;
		resolve: (res: { ok: boolean; path?: string; canceled?: boolean }) => void;
	} | null>(null);
	const [pluginModelPicker, setPluginModelPicker] = useState<{
		currentModelId?: string | null;
		resolve: (res: { ok: boolean; modelId?: string; name?: string; provider?: string; canceled?: boolean }) => void;
	} | null>(null);
	const openModalEntry = openModalId
		? uiSlots["modal.dialog"].find((e) => e.id === openModalId && !e.hidden)
		: undefined;
	const openModalPluginId = useMemo(() => {
		if (!openModalEntry || openModalEntry.kind !== "view") return "";
		const view = openModalEntry.view ?? "";
		if (view.startsWith("plugin:")) return view.slice("plugin:".length);
		if (openModalEntry.source.startsWith("plugin:")) return openModalEntry.source.slice("plugin:".length);
		return "";
	}, [openModalEntry]);
	useEffect(() => {
		if (!openModalEntry || !openModalPluginId) return;
		if (pluginViews.some((v) => v.info.id === openModalPluginId)) return;
		const info = chatRefForPlugins.current.plugins.find((x) => x.id === openModalPluginId);
		if (!info) return;
		void ensurePluginViewLoaded(info, chatRefForPlugins.current.pluginsEpoch);
	}, [openModalEntry, openModalPluginId, pluginViews, chat.pluginsEpoch]);
	useEffect(() => {
		setFenceSend(send);
		syncFenceRenderers(enabledPlugins, chat.pluginsEpoch);
		syncMessageWidgets(enabledPlugins, chat.pluginsEpoch);
		syncFileHandlers(enabledPlugins, chat.pluginsEpoch);
		void syncPluginViews(enabledPlugins, chat.pluginsEpoch);
	}, [enabledPlugins, chat.pluginsEpoch, send]);
	const chatRefForPlugins = useRef(chat);
	const ocrInstallJobRef = useRef<string | null>(null);
	chatRefForPlugins.current = chat;
	useEffect(() => {
		registerImageOcrInstaller(() => {
			const c = chatRefForPlugins.current;
			if (!c.ready) throw new Error(t("imageOcrInstallFailed"));
			const installed = c.plugins.find((plugin) => plugin.id === "image-ocr");
			if (installed?.error) throw new Error(installed.error);
			ocrInstallJobRef.current = null;
			const disabledPlugins = c.settings?.disabledPlugins ?? [];
			const disabled = disabledPlugins.includes("image-ocr");
			if (disabled) {
				send({ type: "set_settings", disabledPlugins: disabledPlugins.filter((id) => id !== "image-ocr") });
			}
			if (installed) {
				if (!disabled) send({ type: "plugins_reload" });
			} else {
				const running = Object.values(c.pluginJobs).find((job) => job.pluginId === "image-ocr" && job.phase !== "done");
				const jobId = running?.jobId ?? randomUuid();
				ocrInstallJobRef.current = jobId;
				if (!running)
					send({
						type: "plugin_job",
						jobId,
						action: "install",
						id: "image-ocr",
						source: "xing-shuyin/pi-web-ui/plugins/image-ocr",
					});
			}
		});
		const unsubscribe = subscribeImageOcrProviders(() => {
			if (listImageOcrProviders().length) setImageOcrInstallState(false);
		});
		const unsubscribeFailures = subscribePluginLoadFailed((ids) => {
			if (ids.includes("image-ocr")) setImageOcrInstallState(false, t("imageOcrInstallFailed"));
		});
		return () => {
			registerImageOcrInstaller(null);
			unsubscribe();
			unsubscribeFailures();
		};
	}, [send, t]);
	useEffect(() => {
		if (!chat.ready) {
			setImageOcrInstallState(false);
			return;
		}
		const job = ocrInstallJobRef.current ? chat.pluginJobs[ocrInstallJobRef.current] : undefined;
		if (job)
			setImageOcrInstallState(
				job.phase !== "done",
				job.phase === "done" && !job.ok ? job.error || t("imageOcrInstallFailed") : "",
			);
	}, [chat.pluginJobs, chat.ready, t]);
	const setViewRefForPlugins = useRef(setView);
	setViewRefForPlugins.current = setView;
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
						...(c.elsewhere ?? [])
							.filter((w) => Boolean(w.convId && w.owner))
							.map((w) => ({
								id: JSON.stringify([w.owner, w.convId]),
								conversationId: w.convId!,
								title: w.title,
								cwd: w.cwd || cwd,
								kind: "elsewhere" as const,
								owner: w.owner,
								independent: w.independent,
								isStreaming: w.isStreaming,
							})),
						...c.sessions.map((s) => ({
							id: s.path,
							title: s.displayName || s.name || s.firstMessage?.trim() || s.path,
							cwd,
							kind: "history" as const,
						})),
					];
				},
				getConversationId: () => chatRefForPlugins.current.state?.conversationId ?? null,
				getConversationOwner: () => chatRefForPlugins.current.state?.sharedConversation?.owner ?? null,
				isConversationBlank: () => (chatRefForPlugins.current.state?.messages.length ?? 0) === 0,
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
				openModal: (id) => {
					const target = String(id ?? "").trim();
					if (!target) return false;
					const entry = uiSlotsRef.current["modal.dialog"].find((e) => e.id === target);
					if (!entry || entry.hidden) return false;
					setOpenModalId(target);
					return true;
				},
				closeModal: () => setOpenModalId(null),
				setFooterStatus: (key, value) => setFooterStatusStore(key, value ? { ...value } : null),
				pickDirectory: (opts) =>
					new Promise((resolve) => {
						setPluginDirPicker({ initialPath: opts?.initialPath, resolve });
					}),
				pickModel: (opts) =>
					new Promise((resolve) => {
						setPluginModelPicker({ currentModelId: opts?.currentModelId, resolve });
					}),
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
				notifyAction: (opts) =>
					new Promise<string | null>((resolve) => {
						try {
							const prev = pluginNotifyRef.current;
							pluginNotifyRef.current = null;
							setPluginNotify(null);
							try {
								prev?.resolve(null);
							} catch {}
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
				openFileContextMenu: (opts) => {
					const cleanPath = String(opts.path ?? "")
						.replace(/\\/g, "/")
						.replace(/^\/+|\/+$/g, "");
					const isRoot = !cleanPath;
					const kind = opts.kind ?? (opts.path.endsWith("/") || isRoot ? "dir" : "file");
					const label = opts.label ?? (cleanPath ? (cleanPath.split("/").pop() ?? cleanPath) : "workspace");
					const target = { id: cleanPath, kind, label };

					const isFile = kind === "file";
					const isDir = kind === "dir" || isRoot;
					const isList = kind === "list";
					const referenceCwd = chatRefForPlugins.current.state?.cwd ?? "";
					const sourcePath = String(opts.path ?? "").replace(/\\/g, "/");
					const referencePath = /^[A-Za-z]:$/.test(sourcePath)
						? `${sourcePath}/`
						: sourcePath.startsWith("/") || /^[A-Za-z]:\//.test(sourcePath) || !referenceCwd
							? sourcePath
							: `${referenceCwd.replace(/\\/g, "/").replace(/\/+$/, "")}/${sourcePath}`;
					const reference: QuickAskReferenceSource | undefined =
						!isList &&
						referencePath &&
						(referenceCwd || referencePath.startsWith("/") || /^[A-Za-z]:\//.test(referencePath))
							? { kind: isDir ? "directory" : "file", path: referencePath, cwd: referenceCwd || undefined }
							: undefined;

					const entries = (uiSlotsRef.current["contextmenu.file"] ?? []).map((entry) => {
						if (entry.source !== "host") {
							if (isDir && entry.when?.includes("file.isFile")) return { ...entry, hidden: true };
							if (isFile && entry.when?.includes("file.isDir")) return { ...entry, hidden: true };
							return entry;
						}
						switch (entry.id) {
							case "host:file-quick-ask":
								return chatRefForPlugins.current.settings?.quickAskReferenceMenus !== false && reference
									? entry
									: { ...entry, hidden: true };
							case "host:file-compress":
							case "host:file-compress-download":
								return !isList ? entry : { ...entry, hidden: true };
							case "host:file-extract":
								return isFile && isExtractableArchive(label) ? entry : { ...entry, hidden: true };
							case "host:file-upload":
								return isDir || isList ? { ...entry, label: t("uploadToFolder") } : { ...entry, hidden: true };
							case "host:file-upload-folder":
								return isDir || isList ? entry : { ...entry, hidden: true };
							case "host:file-open":
							case "host:file-download":
							case "host:file-open-default":
								return isFile ? entry : { ...entry, hidden: true };
							case "host:file-attach-ref":
								return isFile ? entry : { ...entry, hidden: true };
							case "host:file-attach-folder":
								return isDir ? entry : { ...entry, hidden: true };
							case "host:file-reveal":
								return !isList ? entry : { ...entry, hidden: true };
							case "host:file-enter":
							case "host:file-open-project":
							case "host:file-add-root":
								return { ...entry, hidden: true };
							case "host:file-new-file":
							case "host:file-new-dir":
							case "host:file-paste":
								return isDir || isList ? entry : { ...entry, hidden: true };
							case "host:file-rename":
							case "host:file-duplicate":
							case "host:file-cut":
							case "host:file-copy":
							case "host:file-delete":
								return !isList && !isRoot ? entry : { ...entry, hidden: true };
							case "host:file-copy-name":
							case "host:file-copy-path":
							case "host:file-copy-rel":
								return !isList ? entry : { ...entry, hidden: true };
							case "host:file-refresh":
								return isList ? entry : { ...entry, hidden: true };
							default:
								return entry;
						}
					});
					if (contextMenuItems(entries).length === 0) return;

					openContextMenu({
						x: opts.x,
						y: opts.y,
						slot: "contextmenu.file",
						target,
						entries,
						onHostAction: (entry, tg) => {
							if (entry.id === "host:file-quick-ask") {
								if (reference) openQuickAsk({ reference });
								return;
							}
							if (opts.onHostAction) {
								const res = opts.onHostAction(entry.id, tg);
								if (res !== undefined) return res;
							}
							switch (entry.id) {
								case "host:file-reveal":
									send({ type: "file_reveal", path: tg.id });
									break;
								case "host:file-open-default":
									if (tg.kind === "file") send({ type: "file_open_default", path: tg.id });
									break;
								case "host:file-copy-name":
									void navigator.clipboard?.writeText(tg.label ?? tg.id);
									pushNotice("info", t("copied"));
									break;
								case "host:file-copy-rel":
									void navigator.clipboard?.writeText(tg.id);
									pushNotice("info", t("copied"));
									break;
								case "host:file-copy-path": {
									const cwd = chatRefForPlugins.current.state?.cwd ?? "";
									const full = cwd ? `${cwd.replace(/\\/g, "/").replace(/\/+$/, "")}/${tg.id}` : tg.id;
									void navigator.clipboard?.writeText(full);
									pushNotice("info", t("copied"));
									break;
								}
							}
						},
					});
				},
			}),
		);
		return () => installPluginHostApi(null);
	}, [send]);
	const [leftWidth, setLeftWidth] = useState(() => readPanelWidth("left"));
	const [rightWidth, setRightWidth] = useState(() => readPanelWidth("right"));
	const resizeLeft = useCallback((w: number) => setLeftWidth(w), []);
	const resizeRight = useCallback((w: number) => setRightWidth(w), []);
	const [leftCollapsed, setLeftCollapsed] = useState(() => readPanelCollapsed("left"));
	const [rightCollapsed, setRightCollapsed] = useState(() => readPanelCollapsed("right"));
	const toggleLeft = useCallback(() => {
		setLeftCollapsed((v) => {
			try {
				localStorage.setItem(panelCollapsedKey("left"), v ? "0" : "1");
			} catch {}
			return !v;
		});
	}, []);
	const toggleRight = useCallback(() => {
		setRightCollapsed((v) => {
			try {
				localStorage.setItem(panelCollapsedKey("right"), v ? "0" : "1");
			} catch {}
			return !v;
		});
	}, []);
	const [drawer, setDrawer] = useState<"left" | "right" | null>(null);
	const unreadConvKeys = useUnreadConversationKeys();
	const layoutRef = useRef<HTMLDivElement | null>(null);
	const [isMobile, setIsMobile] = useState(() => window.matchMedia("(max-width: 768px)").matches);
	useEffect(() => {
		const mq = window.matchMedia("(max-width: 768px)");
		const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
		mq.addEventListener("change", onChange);
		return () => mq.removeEventListener("change", onChange);
	}, []);
	useSwipeDrawer({
		enabled: isMobile && view === "chat",
		open: drawer,
		onOpenChange: setDrawer,
		container: layoutRef,
		backdropSelector: ".drawer-backdrop.persistent",
	});
	const [setupDismissed, setSetupDismissed] = useState(() => {
		try {
			return localStorage.getItem("pi_web_setup_dismissed") === "1";
		} catch {
			return false;
		}
	});
	const dismissSetup = () => {
		setSetupDismissed(true);
		try {
			localStorage.setItem("pi_web_setup_dismissed", "1");
		} catch {}
	};
	const [manageModelsOpen, setManageModelsOpen] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [settingsInitialSection, setSettingsInitialSection] = useState<"plugins" | undefined>();
	const [sandboxModalMode, setSandboxModalMode] = useState<"create" | "promote" | "apply" | null>(null);
	const openSandboxCreateModal = useCallback(() => setSandboxModalMode("create"), []);
	const transitionKind = chat.transition?.kind;
	const transitionTarget = chat.transition?.target;
	const transitionProgress = chat.transition?.progress;
	const leftPanelTransition = useMemo(
		() =>
			transitionKind && transitionTarget !== undefined
				? { kind: transitionKind, target: transitionTarget, progress: transitionProgress ?? 0 }
				: null,
		[transitionKind, transitionTarget, transitionProgress],
	);
	const [pluginPathConfirm, setPluginPathConfirm] = useState<{ path: string; resolve: (ok: boolean) => void } | null>(
		null,
	);
	const pluginPathConfirmRef = useRef<typeof pluginPathConfirm>(null);
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
	const [pluginNotify, setPluginNotify] = useState<{
		text: string;
		actions: { id: string; label: string }[];
		resolve: (v: string | null) => void;
	} | null>(null);
	const pluginNotifyRef = useRef<typeof pluginNotify>(null);
	const [answeredPathRequests, setAnsweredPathRequests] = useState<Set<string>>(() => new Set());
	const answerPathRequest = (id: string, ok: boolean) => {
		send({ type: "plugin_path_response", id, ok });
		setAnsweredPathRequests((prev) => new Set(prev).add(id));
	};
	const pendingPathRequest = chat.pathRequests.find((r) => !answeredPathRequests.has(r.id)) ?? null;
	const [answeredPermRequests, setAnsweredPermRequests] = useState<Set<string>>(() => new Set());
	const answerPermRequest = (id: string, ok: boolean, remember = false) => {
		send({ type: "plugin_permission_response", id, ok, ...(remember ? { remember: true } : {}) });
		setAnsweredPermRequests((prev) => new Set(prev).add(id));
	};
	const pendingPermRequest = chat.permRequests.find((r) => !answeredPermRequests.has(r.id)) ?? null;
	// 插件授权/路径请求是打断式浮层：层级跟着叠栈走，才能盖住已打开的预览/详情
	const permOverlayZIndex = useOverlayZIndex(!!(pendingPermRequest || pendingPathRequest || pluginPathConfirm));
	const wide = useWideChat();
	const hideModelRow = useHideModelRow();
	const isMinimalEmpty =
		!isNativeCliConversation &&
		!!chat.settings?.minimalNewChat &&
		(chat.state?.messages?.length ?? 0) === 0 &&
		!chat.state?.streamingMessage;
	const [bgTasksOpen, setBgTasksOpen] = useState(false);
	// Global search panel (sessions / projects / workspace files).
	const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
	const [iconEditOpen, setIconEditOpen] = useState(false);
	const [searchJump, setSearchJump] = useState<{
		path: string;
		role: string;
		timestamp: number;
	} | null>(null);
	useEffect(() => {
		if (!searchJump) return;
		const t = setTimeout(() => setSearchJump(null), 15_000);
		return () => clearTimeout(t);
	}, [searchJump]);

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
			if (hasPendingMobileNotificationTarget()) return;
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
			const isAlreadyActive =
				activeSessionIdRef.current === parsed.sessionId ||
				(activeSessionIdRef.current &&
					parsed.sessionId &&
					(activeSessionIdRef.current.includes(parsed.sessionId) ||
						parsed.sessionId.includes(activeSessionIdRef.current)));
			if (!isAlreadyActive) {
				awaitingHashSessionRef.current = parsed.sessionId;
				setView("chat");
				send({ type: "switch_session", path: "", sessionId: parsed.sessionId });
			}
		};
		applyFromLocation();
		window.addEventListener("hashchange", applyFromLocation);
		window.addEventListener("popstate", applyFromLocation);
		const unsubscribeNotifications = subscribeNotificationClicks((url) => {
			window.history.replaceState(null, "", url);
			setActiveGroupId(null);
			setView("chat");
			applyFromLocation();
		});
		return () => {
			window.removeEventListener("hashchange", applyFromLocation);
			window.removeEventListener("popstate", applyFromLocation);
			unsubscribeNotifications();
		};
	}, [send]);

	const lastMobileNotificationRef = useRef<string | null>(null);
	useEffect(() => {
		if (!isMobileRuntime() || !chat.ready) return;
		const open = (event?: Event) => {
			const target =
				consumeMobileNotificationTarget() ??
				((event as CustomEvent | undefined)?.detail as MobileNotificationTarget | undefined);
			if (!target || (target.eventId && target.eventId === lastMobileNotificationRef.current)) return;
			const request = mobileNotificationRequest(target, getClientId());
			if (!request) {
				pushNotice("warning", "The notification no longer identifies an open conversation.");
				return;
			}
			lastMobileNotificationRef.current = target.eventId;
			pendingHashSessionRef.current = null;
			awaitingHashSessionRef.current = null;
			setUrlJump(null);
			setActiveGroupId(null);
			setView("chat");
			const localUrl = new URL(window.location.href);
			localUrl.searchParams.delete("token");
			localUrl.searchParams.delete("view");
			localUrl.hash = "";
			window.history.replaceState(null, "", localUrl.href);
			send(request);
		};
		window.addEventListener(MOBILE_NOTIFICATION_OPEN, open);
		open();
		return () => window.removeEventListener(MOBILE_NOTIFICATION_OPEN, open);
	}, [chat.ready, pushNotice, send]);

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

	useEffect(() => {
		if (!chat.ready || !activeSessionId) return;
		if (pendingHashSessionRef.current) {
			const wantSid = pendingHashSessionRef.current;
			pendingHashSessionRef.current = null;
			const isAlreadyActive =
				wantSid === activeSessionId ||
				(wantSid && activeSessionId && (wantSid.includes(activeSessionId) || activeSessionId.includes(wantSid)));
			setActiveGroupId(null);
			setView("chat");
			if (!isAlreadyActive) {
				awaitingHashSessionRef.current = wantSid;
				send({ type: "switch_session", path: "", sessionId: wantSid });
				return;
			}
		}
		if (awaitingHashSessionRef.current) {
			const matchesAwaiting =
				activeSessionId === awaitingHashSessionRef.current ||
				(activeSessionId &&
					awaitingHashSessionRef.current &&
					(activeSessionId.includes(awaitingHashSessionRef.current) ||
						awaitingHashSessionRef.current.includes(activeSessionId)));
			if (matchesAwaiting) {
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

	useEffect(() => {
		const onPluginRunCommand = (e: Event) => {
			const detail = (e as CustomEvent<{ title?: string; command?: string }>).detail;
			const title = detail?.title || t("pluginCommandFallback");
			const command = detail?.command;
			if (!command || !chat.ready) return;
			const def: CommandDef = { name: title, command, cwd: "${pwd}" };
			const existing = chat.terminals.find((tm) => tm.title === title);
			let targetId: string;
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
				targetId = existing.id;
			} else {
				targetId = randomUuid();
				terminal.create({
					id: targetId,
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
			terminal.select(targetId);
			setView("terminal");
		};
		window.addEventListener("pi-web-ui:plugin-run-command", onPluginRunCommand);
		window.addEventListener("pi-web-ui:run-command", onPluginRunCommand);
		const onSwitchConversation = (e: Event) => {
			const id = (e as CustomEvent<string>).detail;
			if (typeof id === "string" && id) {
				setView((prev) => (prev !== "chat" ? "chat" : prev));
				send({ type: "switch_conversation", id });
				focusComposer();
			}
		};
		window.addEventListener("pi-web-ui:switch-conversation", onSwitchConversation);
		return () => {
			window.removeEventListener("pi-web-ui:plugin-run-command", onPluginRunCommand);
			window.removeEventListener("pi-web-ui:run-command", onPluginRunCommand);
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

	const [zenMode, setZenMode] = useState<boolean>(() => {
		try {
			return localStorage.getItem("pi_zen_mode") === "1";
		} catch {
			return false;
		}
	});

	useEffect(() => {
		try {
			if (zenMode) {
				localStorage.setItem("pi_zen_mode", "1");
			} else {
				localStorage.removeItem("pi_zen_mode");
			}
		} catch {}
	}, [zenMode]);

	const toggleZenMode = useCallback(() => {
		setZenMode((prev) => {
			const next = !prev;
			if (next && view !== "chat") {
				setView("chat");
			}
			return next;
		});
	}, [view]);

	useEscapeKey(() => {
		if (zenMode) {
			setZenMode(false);
			return true;
		}
		return false;
	}, zenMode);

	// 手机端子抽屉是主导航：返回键/ESC 逐层退出的第一层就是它（联开后注册，所以优先于其他浮层被消费）。
	useEscapeKey(() => {
		if (!drawer) return false;
		setDrawer(null);
		return true;
	}, drawer !== null);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const isAltZ = e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === "z";
			const isCtrlShiftF = (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "f";
			if (isAltZ || isCtrlShiftF) {
				e.preventDefault();
				toggleZenMode();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [toggleZenMode]);

	const [sound, setSound] = useState<SoundSettings>(loadSoundSettings);
	const [tts, setTts] = useState<TtsSettings>(loadTtsSettings);
	const { themes, theme, switchTheme, reloadThemes } = useTheme();
	useWallpaperEffect();
	useEffect(() => {
		try {
			if (typeof emitPluginHostTheme === "function") emitPluginHostTheme(theme ?? "");
		} catch {}
	}, [theme]);
	useEffect(() => {
		try {
			if (typeof emitPluginHostLocale === "function") emitPluginHostLocale(locale);
		} catch {}
	}, [locale]);
	useEffect(() => {
		try {
			if (typeof emitPluginHostView === "function") emitPluginHostView(view);
		} catch {}
	}, [view]);
	useEffect(() => {
		try {
			const m = chat.state?.model;
			const mid = m ? `${m.provider}/${m.id}` : null;
			if (typeof emitPluginHostModel === "function") emitPluginHostModel(mid);
		} catch {}
	}, [chat.state?.model?.provider, chat.state?.model?.id]);
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
			} catch {}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [pluginDialog]);
	useEffect(() => {
		if (!pluginNotify) return;
		const timer = setTimeout(() => {
			const cur = pluginNotifyRef.current;
			pluginNotifyRef.current = null;
			setPluginNotify(null);
			try {
				cur?.resolve(null);
			} catch {}
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
	const terminalOpenRequested = useRef(false);
	const prevTerminalsRef = useRef(chat.terminals);

	useEffect(() => {
		saveSoundSettings(sound);
	}, [sound]);

	useEffect(() => {
		saveTtsSettings(tts);
	}, [tts]);

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
				send({ type: "extensions_reload" });
				send({ type: "plugins_reload" });
				send({ type: "check_updates_all", force: true });
				send({ type: "check_engines", force: true });
			}
		}
	}, [chat.terminals, send]);

	useEffect(() => {
		const activeId = chat.state?.conversationId ?? null;
		const cues = diffStreamingCues(
			prevStreamingMapRef.current,
			activeId,
			chat.state?.isStreaming ?? false,
			chat.conversations,
			prevActiveIdRef.current,
			!!chat.state?.completionPending || !!chat.state?.queue?.steering.length || !!chat.state?.queue?.followUp.length,
		);
		prevStreamingMapRef.current = cues.nextMap;
		prevActiveIdRef.current = activeId;

		for (const [id, isStreaming] of cues.nextMap.entries()) {
			if (isStreaming) {
				clearConversationUnread(id);
			}
		}

		if (cues.startCue) {
			playSound("start", sound);
			void notify(t("notifyStartTitle"), t("notifyStartBody"), "start", activeSessionId);
		}

		if (cues.finishedConvs.length > 0) {
			const isWindowFocused = typeof document !== "undefined" && document.hasFocus ? document.hasFocus() : true;
			const toMarkUnread: Array<{ id: string; sessionId?: string; sessionFile?: string }> = [];
			for (const finished of cues.finishedConvs) {
				if (!finished.isActive || !isWindowFocused) {
					const conv = chat.conversations.find((c) => c.id === finished.id);
					toMarkUnread.push({
						id: finished.id,
						sessionId: conv?.sessionId,
						sessionFile: conv?.sessionFile,
					});
				}
			}
			if (toMarkUnread.length > 0) {
				markConversationsUnread(toMarkUnread);
			}

			if (cues.finishedConvs.some((c) => !c.isSubagent && sound.done)) {
				playSound("done", sound);
			} else if (cues.finishedConvs.some((c) => c.isSubagent)) {
				playSound("subagentDone", sound);
			}

			const activeFinished = cues.finishedConvs.find((c) => c.isActive);
			if (activeFinished) {
				void notify(
					t("notifyDoneTitle"),
					t("notifyDoneBody"),
					activeFinished.isSubagent ? "subagentDone" : "done",
					activeSessionId,
				);
				if (tts.enabled) {
					if (tts.readReplies) {
						if (!tts.streamReplies) {
							const body = assistantPlainText(latestMessagesRef.current);
							if (body) speak(body, tts);
							else if (tts.announce && !shouldSuppressNotify(currentPresence())) speak(t("ttsAnnounceDone"), tts);
						}
					} else if (tts.announce && !shouldSuppressNotify(currentPresence())) {
						speak(t("ttsAnnounceDone"), tts);
					}
				}
			}
			for (const bg of cues.finishedConvs.filter((c) => !c.isActive)) {
				const body = bg.title ? `${bg.title}：${t("notifyDoneBody")}` : t("notifyDoneBody");
				const sessionId = chat.conversations.find((c) => c.id === bg.id)?.sessionId;
				void notify(t("notifyDoneTitle"), body, bg.isSubagent ? "subagentDone" : "done", sessionId);
			}
			if (!activeFinished && tts.enabled && tts.announce && !shouldSuppressNotify(currentPresence())) {
				speak(t("ttsAnnounceDone"), tts);
			}
		}
	}, [
		chat.state?.conversationId,
		activeSessionId,
		chat.state?.isStreaming,
		chat.state?.completionPending,
		chat.state?.queue,
		chat.conversations,
		sound,
		tts,
		t,
	]);

	useEffect(() => {
		const activeId = chat.state?.conversationId ?? null;
		if (activeId) {
			clearConversationUnread(activeId);
			if (chat.state?.sessionId) clearConversationUnread(chat.state.sessionId);
			if (chat.state?.sessionFile) clearConversationUnread(chat.state.sessionFile);
		}
	}, [chat.state?.conversationId, chat.state?.sessionId, chat.state?.sessionFile]);

	useEffect(() => {
		const onFocus = () => {
			const activeId = chat.state?.conversationId;
			if (activeId) {
				clearConversationUnread(activeId);
				if (chat.state?.sessionId) clearConversationUnread(chat.state.sessionId);
				if (chat.state?.sessionFile) clearConversationUnread(chat.state.sessionFile);
			}
		};
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [chat.state?.conversationId, chat.state?.sessionId, chat.state?.sessionFile]);

	const streamSpeechQueueRef = useRef<StreamSpeechQueue | null>(null);
	const streamExtractorRef = useRef<StreamSentenceExtractor | null>(null);
	const streamLastScanTimeRef = useRef(0);

	useEffect(() => {
		const isStreaming = chat.state?.isStreaming ?? false;
		const conversationId = chat.state?.conversationId;
		const canStreamTts = tts.enabled && tts.readReplies && tts.streamReplies;

		if (!canStreamTts || !isStreaming) {
			if (streamSpeechQueueRef.current) {
				const msgs = latestMessagesRef.current;
				const lastMsg = Array.isArray(msgs) && msgs.length > 0 ? msgs[msgs.length - 1] : null;
				if (lastMsg && lastMsg.role === "assistant" && streamExtractorRef.current) {
					const text = (lastMsg.content ?? [])
						.filter((b): b is UiTextBlock => b.type === "text")
						.map((b) => b.text ?? "")
						.join("\n");
					streamExtractorRef.current.flush(text);
				}
				streamSpeechQueueRef.current.finish();
				streamSpeechQueueRef.current = null;
				streamExtractorRef.current = null;
				streamLastScanTimeRef.current = 0;
			}
			return;
		}

		const msgs = chat.state?.messages;
		const lastMsg = Array.isArray(msgs) && msgs.length > 0 ? msgs[msgs.length - 1] : null;
		if (!lastMsg || lastMsg.role !== "assistant") return;

		const now = Date.now();
		if (now - streamLastScanTimeRef.current < 150) {
			return;
		}
		streamLastScanTimeRef.current = now;

		if (!streamSpeechQueueRef.current) {
			const queue = startStreamSpeech(tts, conversationId);
			streamSpeechQueueRef.current = queue;
			streamExtractorRef.current = new StreamSentenceExtractor((cleanSentence) => {
				queue.push(cleanSentence);
			});
		}

		const rawText = (lastMsg.content ?? [])
			.filter((b): b is UiTextBlock => b.type === "text")
			.map((b) => b.text ?? "")
			.join("\n");

		streamExtractorRef.current?.feed(rawText);
	}, [chat.state?.messages, chat.state?.isStreaming, chat.state?.conversationId, tts]);

	useEffect(() => {
		const id = chat.dialog?.id ?? null;
		if (id !== null && !notifiedDialogIds.current.has(id)) {
			notifiedDialogIds.current.add(id);
			if (notifiedDialogIds.current.size > 64) {
				const oldest = notifiedDialogIds.current.values().next().value;
				if (oldest !== undefined) notifiedDialogIds.current.delete(oldest);
			}
			playSound("question", sound);
			void notify(t("notifyQuestionTitle"), t("notifyQuestionBody"), "question");
			if (tts.enabled && tts.announce && !shouldSuppressNotify(currentPresence())) speak(t("ttsAnnounceQuestion"), tts);
		}
	}, [chat.dialog, sound, tts, t]);

	useEffect(() => {
		const qid = chat.question?.id ?? null;
		const rid = chat.remoteQuestion ? `${chat.remoteQuestion.owner}:${chat.remoteQuestion.id}` : null;
		const notificationSessions = new Set<string | undefined>();

		if (qid !== null && !notifiedQuestionIds.current.has(qid)) {
			notifiedQuestionIds.current.add(qid);
			notificationSessions.add(activeSessionId);
		}
		if (rid !== null && !notifiedQuestionIds.current.has(rid)) {
			notifiedQuestionIds.current.add(rid);
			notificationSessions.add(undefined);
		}

		for (const c of chat.conversations) {
			if (!c.hasQuestion) continue;
			const qKey = c.questionId ? `q:${c.questionId}` : `conv-q:${c.id}`;
			if (!notifiedQuestionIds.current.has(qKey)) {
				notifiedQuestionIds.current.add(qKey);
				if (c.questionId) notifiedQuestionIds.current.add(c.questionId);
				if (qid !== c.questionId) {
					notificationSessions.add(c.sessionId);
				}
			}
		}

		if (notifiedQuestionIds.current.size > 64) {
			const oldest = notifiedQuestionIds.current.values().next().value;
			if (oldest !== undefined) notifiedQuestionIds.current.delete(oldest);
		}

		if (notificationSessions.size > 0) {
			playSound("question", sound);
			for (const sessionId of notificationSessions) {
				void notify(t("notifyQuestionTitle"), t("notifyQuestionBody"), "question", sessionId);
			}
			if (tts.enabled && tts.announce && !shouldSuppressNotify(currentPresence())) speak(t("ttsAnnounceQuestion"), tts);
		}
	}, [chat.question, chat.remoteQuestion, chat.conversations, activeSessionId, sound, tts, t]);

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
			void notify(
				t("notifyApprovalTitle"),
				tool ? t("notifyApprovalBodyTool", { tool }) : t("notifyApprovalBody"),
				"approval",
			);
			if (tts.enabled && tts.announce && !shouldSuppressNotify(currentPresence())) speak(t("ttsAnnounceApproval"), tts);
		}
	}, [chat.approval, sound, tts, t]);

	useEffect(() => {
		const err = [...chat.notices].reverse().find((n) => n.level === "error");
		if (err && err.id !== lastErrorNotice.current) {
			lastErrorNotice.current = err.id;
			playSound("error", sound);
			void notify(t("notifyErrorTitle"), t("notifyErrorBody"), "error");
			if (tts.enabled && tts.announce && !shouldSuppressNotify(currentPresence())) speak(t("ttsAnnounceError"), tts);
		}
	}, [chat.notices, sound, tts, t]);
	const openedPreviewIds = useRef<Set<string>>(new Set());
	useEffect(() => {
		const msgs = chat.state?.messages ?? [];
		for (const m of msgs) {
			if (m.toolName !== "live_preview" || openedPreviewIds.current.has(m.id)) continue;
			openedPreviewIds.current.add(m.id);
			let url = "";
			for (const b of m.content ?? []) {
				if ((b as { type?: string }).type !== "text") continue;
				const hit = /🔗 已自动在浏览器打开\]\((\/(?!\/)[^)\s]+)\)/.exec((b as { text?: string }).text ?? "");
				if (hit?.[1]) {
					url = hit[1];
					break;
				}
			}
			if (!url) continue;
			let opened: Window | null = null;
			try {
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
		mode: "inline" | "reference" | "lines" | "page" | "canvas",
		isDir = false,
		lines?: { start: number; end: number },
		silent = false,
	) => {
		if (nativeCliViewRef.current) {
			if (!composeToComposer({ attachments: [{ path, name, mode, isDir, ...(lines ? { lines } : {}) }] }))
				pushNotice("warning", t("nativeCliDisconnected"));
			return;
		}
		const key = `${path}|${mode}|${lines ? `${lines.start}-${lines.end}` : ""}`;
		setAttachments((prev) =>
			prev.some((a) => `${a.path}|${a.mode}|${a.lines ? `${a.lines.start}-${a.lines.end}` : ""}` === key)
				? prev
				: [...prev, { path, name, mode, isDir, ...(lines ? { lines } : {}) }],
		);
		const mention = mode === "page" || mode === "canvas" ? name : path;
		if (!silent && mention && !nativeCliViewRef.current) {
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
				if (isHit && !removedName)
					removedName = a.mode === "page" || a.mode === "conversation" || a.mode === "canvas" ? a.name : a.path;
				return !isHit;
			}),
		);
		if (removedName) {
			removeMentionFromComposer(`@${removedName}`);
		}
	};

	const panelSend = useCallback(
		(msg: ClientMessage) => {
			if (!msg.type.startsWith("list_") && !msg.type.startsWith("get_")) {
				setDrawer(null);
			}
			return send(msg);
		},
		[send],
	);

	const dismissedQuestionIdsRef = useRef<Set<string>>(new Set());
	const activeConvId = chat.activeConversationId || chat.state?.conversationId || "";

	useEffect(() => {
		const convsWithQuestion = chat.conversations.filter((c) => c.hasQuestion);
		const currentQuestionConvIds = new Set(convsWithQuestion.map((c) => c.id));
		const currentQuestionIds = new Set(convsWithQuestion.map((c) => c.questionId).filter(Boolean) as string[]);

		for (const qid of dismissedQuestionIdsRef.current) {
			if (!currentQuestionIds.has(qid)) {
				dismissedQuestionIdsRef.current.delete(qid);
			}
		}

		for (const c of convsWithQuestion) {
			const bannerId = `question-${c.id}`;
			if (c.id === activeConvId) {
				dismissBanner(bannerId, { silent: true });
				continue;
			}
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

		dismissBannersWhere(
			(b) => {
				const convId = b.data?.conversationId as string | undefined;
				if (!convId) return false;
				return !currentQuestionConvIds.has(convId) || convId === activeConvId;
			},
			{ silent: true },
		);
	}, [chat.conversations, activeConvId, panelSend, t]);

	const chatUploadMaxMb = useAppField("chatUploadMaxMb");
	const [attachmentProgress, setAttachmentProgress] = useState<Record<string, { name: string; percent?: number }>>({});
	const preparationId = useRef(0);
	const pasteImageId = useRef(0);
	const lastVisionWarn = useRef(0);
	const attachImage = useCallback(
		(img: ProcessedImage) => {
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
				if (f.size > chatUploadMaxMb * 1024 * 1024) {
					pushNotice("warning", t("fileTooLarge", { name: f.name, size: chatUploadMaxMb }));
					continue;
				}
				const id = String(++preparationId.current);
				setAttachmentProgress((prev) => ({ ...prev, [id]: { name: f.name } }));
				try {
					const img = await fileToProcessedImage(f);
					if (!img) pushNotice("error", t("imageLoadFailed", { name: f.name }));
					else attachImage(img);
				} catch {
					pushNotice("error", t("imageLoadFailed", { name: f.name }));
				} finally {
					setAttachmentProgress((prev) => {
						const next = { ...prev };
						delete next[id];
						return next;
					});
				}
			}
		},
		[attachImage, pushNotice, t, chatUploadMaxMb],
	);

	const MAX_UPLOAD_BYTES = chatUploadMaxMb * 1024 * 1024;
	const uploadId = useRef(0);
	const attachLocalFile = useCallback(
		async (f: File) => {
			if (f.size > MAX_UPLOAD_BYTES) {
				pushNotice("warning", t("fileTooLarge", { name: f.name, size: MAX_UPLOAD_BYTES / 1024 / 1024 }));
				return;
			}
			const id = String(++preparationId.current);
			setAttachmentProgress((prev) => ({ ...prev, [id]: { name: f.name, percent: 0 } }));
			let base64: string;
			try {
				const dataUrl = await new Promise<string>((res, rej) => {
					const r = new FileReader();
					r.onprogress = (event) => {
						if (event.lengthComputable)
							setAttachmentProgress((prev) => ({
								...prev,
								[id]: { name: f.name, percent: Math.round((event.loaded / event.total) * 100) },
							}));
					};
					r.onload = () => res(r.result as string);
					r.onerror = () => rej(r.error ?? new Error("read failed"));
					r.onabort = () => rej(new Error("read aborted"));
					r.readAsDataURL(f);
				});
				base64 = dataUrl.replace(/^data:[^;]*;base64,/, "");
			} catch {
				pushNotice("error", t("fileLoadFailed", { name: f.name }));
				return;
			} finally {
				setAttachmentProgress((prev) => {
					const next = { ...prev };
					delete next[id];
					return next;
				});
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
				if (isRasterImage(f.type)) {
					await addImageFiles([f]);
				} else {
					await attachLocalFile(f);
				}
			}
		},
		[addImageFiles, attachLocalFile],
	);

	const addNativeCliFiles = useCallback(
		async (files: File[]) => {
			const target = getComposerTarget();
			if (!target) {
				pushNotice("warning", t("nativeCliDisconnected"));
				return;
			}
			for (const file of files) {
				if (file.size > MAX_UPLOAD_BYTES) {
					pushNotice("warning", t("fileTooLarge", { name: file.name, size: chatUploadMaxMb }));
					continue;
				}
				try {
					const fileData = await new Promise<string>((resolve, reject) => {
						const reader = new FileReader();
						reader.onload = () => resolve(String(reader.result).replace(/^data:[^;]*;base64,/, ""));
						reader.onerror = () => reject(reader.error);
						reader.onabort = () => reject(new Error("read aborted"));
						reader.readAsDataURL(file);
					});
					if (
						!target.compose({
							attachments: [{ path: "", name: file.name, fileData, size: file.size, mimeType: file.type || undefined }],
						})
					)
						pushNotice("error", t("fileLoadFailed", { name: file.name }));
				} catch {
					pushNotice("error", t("fileLoadFailed", { name: file.name }));
				}
			}
		},
		[MAX_UPLOAD_BYTES, chatUploadMaxMb, pushNotice, t],
	);
	useEffect(() => {
		const result = chat.nativeCliPasteResult;
		if (result && !result.ok) pushNotice("error", t("nativeCliPasteFailed", { error: result.error ?? "" }));
	}, [chat.nativeCliPasteResult, pushNotice, t]);

	const onEditMessage = useCallback(
		(messageId: string, text: string, attachments?: PromptAttachment[]) => {
			send({ type: "edit_message", messageId, text, attachments });
		},
		[send],
	);

	const onRemoveQueued = useCallback(
		(kind: "steer" | "followUp", text: string, index: number, id?: string) => {
			send({ type: "queue_remove", kind, text, index, id });
		},
		[send],
	);

	const [recallDrafts, setRecallDrafts] = useState<{ text: string; seq: number }[]>([]);
	const recallSeqRef = useRef(0);
	const onRecallQueued = useCallback(
		(kind: "steer" | "followUp", text: string, index: number, id?: string) => {
			send({ type: "queue_remove", kind, text, index, id });
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
			if (parsed.attachments?.length) {
				const restored = parsed.attachments
					.filter((att) => att.type !== "vision-bridge")
					.map((att) => ({
						path: att.path || att.url || "",
						name: att.name,
						mode: (att.type === "page"
							? "page"
							: att.type === "canvas"
								? "canvas"
								: att.type === "conversation"
									? "conversation"
									: att.lines
										? "lines"
										: "reference") as PromptAttachment["mode"],
						lines: att.lines,
						key: randomUuid(),
					}));
				if (restored.length) {
					setAttachments((prev) => appendDraftAttachments(prev, restored));
				}
			}
			setRecallDrafts((prev) => [...prev.slice(-9), item]);
		},
		[send],
	);

	const openManageModels = useCallback(() => setManageModelsOpen(true), []);
	const clearAttachments = useCallback(() => setAttachments([]), []);
	const [userPromptNonce, setUserPromptNonce] = useState(0);
	const handleSent = useCallback(() => {
		clearAttachments();
		setUserPromptNonce((n) => n + 1);
	}, [clearAttachments]);
	const handleAbort = useCallback(() => {
		const queuedSteer = chat.state?.queue?.steering ?? [];
		const queuedFollow = chat.state?.queue?.followUp ?? [];
		const allQueued = [...queuedSteer, ...queuedFollow];
		for (const q of allQueued) {
			recallSeqRef.current += 1;
			const parsed = splitQuotedPrompt(q);
			if (parsed.quotes?.length) {
				setAttachments((prev) =>
					appendDraftAttachments(
						prev,
						parsed.quotes.map((quote) => ({ path: "", name: "", mode: "quote", quote, key: randomUuid() })),
					),
				);
			}
			if (parsed.attachments?.length) {
				const restored = parsed.attachments
					.filter((att) => att.type !== "vision-bridge")
					.map((att) => ({
						path: att.path || att.url || "",
						name: att.name,
						mode: (att.type === "page"
							? "page"
							: att.type === "canvas"
								? "canvas"
								: att.type === "conversation"
									? "conversation"
									: att.lines
										? "lines"
										: "reference") as PromptAttachment["mode"],
						lines: att.lines,
						key: randomUuid(),
					}));
				if (restored.length) setAttachments((prev) => appendDraftAttachments(prev, restored));
			}
			setRecallDrafts((prev) => [...prev.slice(-9), { text: parsed.text, seq: recallSeqRef.current }]);
		}
		send({ type: "abort" });
	}, [chat.state?.queue?.steering, chat.state?.queue?.followUp, send]);
	useComposerSessionReset(chat.state?.sessionId ?? "", clearAttachments);
	const removeAttachmentCb = useCallback(removeAttachment, []);
	const annotateImageCb = useCallback(async (target: PendingAttachment, dataUrl: string) => {
		if (!dataUrl.startsWith("data:image/png;base64,")) throw new Error("Invalid annotated image");
		const blob = await (await fetch(dataUrl)).blob();
		const name = `${target.name.replace(/\.[^.]+$/, "").replace(/-annotated$/, "")}-annotated`;
		const processed = await fileToProcessedImage(new File([blob], `${name}.png`, { type: "image/png" }));
		if (!processed || processed.size > 2 * 1024 * 1024) throw new Error("Annotated image exceeds the attachment limit");
		const ext = processed.mimeType === "image/jpeg" ? "jpg" : processed.mimeType === "image/webp" ? "webp" : "png";
		const replacement: PendingAttachment = {
			path: "",
			name: `${name}.${ext}`,
			key: target.key || randomUuid(),
			imageData: processed.data,
			mimeType: processed.mimeType,
			size: processed.size,
		};
		setAttachments((prev) => prev.map((item) => (item === target ? replacement : item)));
	}, []);
	const addImageFilesCb = addImageFiles;
	const addLocalFilesCb = addLocalFiles;
	const searchFilesCb = useCallback(
		(reqId: number, query: string) => send({ type: "search_files", reqId, query }),
		[send],
	);
	const addPathAttachmentCb = useCallback(
		(a: {
			path: string;
			name: string;
			mode?: "inline" | "reference" | "lines" | "page" | "canvas";
			isDir?: boolean;
			lines?: { start: number; end: number };
			silent?: boolean;
		}) => attach(a.path, a.name, a.mode ?? "reference", a.isDir ?? false, a.lines, a.silent ?? false),
		// eslint-disable-next-line react-hooks/exhaustive-deps -- attach 只用 setAttachments（稳定），跟随其余 Cb 同口径
		[],
	);

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
		[model, thinkingLevel, availableThinkingLevels],
	);

	const shellTerminalCount = chat.terminals.filter(
		(item) =>
			!item.nativeCli &&
			((item.ownerKind ?? "client") === "client" ||
				item.conversationId === (chat.activeConversationId || chat.state?.conversationId || "")),
	).length;
	const createShell = useCallback(() => {
		if (!chat.ready || shellTerminalCount !== 0) return false;
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
	}, [chat.ready, chat.state?.cwd, shellTerminalCount, t, terminal]);

	useEffect(() => {
		if (!terminalOpenRequested.current) return;
		if (view !== "terminal" || shellTerminalCount !== 0) {
			terminalOpenRequested.current = false;
			return;
		}
		if (createShell()) terminalOpenRequested.current = false;
	}, [shellTerminalCount, createShell, view]);

	const handleViewChange = useCallback(
		(v: ViewName, opts?: { skipAutoCreate?: boolean }) => {
			if (sharedReadOnly && v !== "chat" && v !== "devices") {
				pushNotice("info", "This conversation is open in read-only mode.");
				return;
			}
			if (v === "native-cli") {
				setNativeCliCreateCwd(cwd);
				return;
			}
			if (opts?.skipAutoCreate) {
				terminalOpenRequested.current = false;
			} else {
				terminalOpenRequested.current = v === "terminal" && shellTerminalCount === 0;
				if (terminalOpenRequested.current && createShell()) {
					terminalOpenRequested.current = false;
				}
			}
			setView(v);
			setDrawer(null);
		},
		[shellTerminalCount, createShell, cwd, sharedReadOnly, pushNotice],
	);
	const openNativeCliCreate = useCallback(
		(projectCwd?: string) => {
			if (sharedReadOnly) return;
			setNativeCliCreateCwd(projectCwd ?? cwd);
			setDrawer(null);
		},
		[cwd, sharedReadOnly],
	);
	const createNativeCliConversation = async (config: NativeCliConfig) => {
		if (nativeCliCreating || nativeCliCreateCwd === null) return;
		setNativeCliCreating(true);
		const id = await requestNativeCliChat(send, config, nativeCliCreateCwd);
		setNativeCliCreating(false);
		if (id) setNativeCliCreateCwd(null);
		else pushNotice("error", t("nativeCliCreateFailed"));
	};

	return (
		<div
			className={`app${zenMode ? " zen-mode" : ""}`}
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
				if (nativeCliViewRef.current) {
					void addNativeCliFiles(files);
					return;
				}
				const images = files.filter((f) => isRasterImage(f.type));
				const others = files.filter((f) => !isRasterImage(f.type));
				if (images.length > 0) void addImageFiles(images);
				if (others.length > 0) void addLocalFiles(others);
			}}
		>
			<RemoteDesktopWindow />
			{zenMode && (
				<button
					type="button"
					className="zen-exit-pill"
					onClick={toggleZenMode}
					title={t("zenModeExitTip")}
					aria-label={t("zenModeExit")}
				>
					<FiFeather />
					<span>{t("zenModeExit")}</span>
				</button>
			)}
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
				onCreateCli={openNativeCliCreate}
				onUiAction={onUiAction}
				zenMode={zenMode}
				onToggleZenMode={toggleZenMode}
				onViewChange={handleViewChange}
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
				onOpenSandboxModal={() => setSandboxModalMode("create")}
				themes={themes}
				theme={theme}
				onThemeChange={switchTheme}
				reloadThemes={reloadThemes}
			/>
			{nativeCliCreateCwd !== null && (
				<NativeCliCreateModal
					cwd={nativeCliCreateCwd}
					disabled={nativeCliCreating}
					onClose={() => {
						if (!nativeCliCreating) setNativeCliCreateCwd(null);
					}}
					onCreate={createNativeCliConversation}
				/>
			)}
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
									} catch {}
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
								} catch {}
							}}
						>
							<FiX />
						</button>
					</div>
				)}
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
				<ContextMenu onAction={(entry, target, value) => onUiAction(entry, value, target)} />
				<div
					ref={layoutRef}
					className="layout"
					style={{ "--left-w": `${leftWidth}px`, "--right-w": `${rightWidth}px` } as CSSProperties}
				>
					{isMobile ? (
						<div className={`drawer-backdrop persistent${drawer ? " on" : ""}`} onClick={() => setDrawer(null)} />
					) : (
						drawer && <div className="drawer-backdrop" onClick={() => setDrawer(null)} />
					)}
					<SideDock
						side="left"
						onCreateCli={openNativeCliCreate}
						items={uiSidebarLeft}
						chat={chat}
						view={view}
						plugins={enabledPlugins}
						dropdownProps={{
							theme,
							themes,
							onThemeChange: switchTheme,
							reloadThemes,
						}}
						onViewChange={handleViewChange}
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
						zenMode={zenMode}
						onToggleZenMode={toggleZenMode}
					/>
					<div className={`view-pane ${view === "chat" ? "" : "hidden"}`}>
						{!isMobile && leftCollapsed && <PanelRail side="left" onClick={toggleLeft} />}
						<div
							className={`panel-drawer drawer-left ${drawer === "left" ? "open" : ""}${
								isMobile ? "" : leftCollapsed ? " hidden" : ""
							}`}
						>
							<LeftPanel
								quickAskReferenceMenus={chat.settings?.quickAskReferenceMenus !== false}
								collapsible={!isMobile}
								onToggleCollapse={toggleLeft}
								panelSend={panelSend}
								onCreateCli={openNativeCliCreate}
								active={!isMobile || drawer === "left"}
								unreadConvKeys={unreadConvKeys}
								sessionFile={activeGroupId ? null : (chat.state?.sessionFile ?? null)}
								conversations={chat.conversations}
								elsewhere={chat.elsewhere}
								sessions={chat.sessions}
								projects={chat.projects}
								projectSessions={chat.projectSessions}
								projectSessionsHasMore={chat.projectSessionsHasMore}
								engine={chat.engine}
								pathCompletions={chat.pathCompletions}
								activeConversationId={activeGroupId ? "" : chat.activeConversationId}
								sharedConversationOwner={chat.state?.sharedConversation?.owner}
								activeGroupId={activeGroupId}
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
								transition={leftPanelTransition}
								onOpenSandboxModal={openSandboxCreateModal}
							/>
						</div>
						{!isMobile && !leftCollapsed && <ResizeHandle side="left" width={leftWidth} onResize={resizeLeft} />}
						<main
							className={`${wide ? "main wide-chat" : "main"}${hideModelRow ? " hide-model-row" : ""}${
								chat.transition && !chat.transition.previewMessages?.length ? " main-transitioning" : ""
							}${isMinimalEmpty ? " main-minimal-empty" : ""}`}
						>
							{Object.entries(cachedNativeClis).map(([id, info]) => {
								const isCurrent = isNativeCliConversation && chat.state?.conversationId === id;
								const active = isCurrent && view === "chat" && !chat.transition;
								return (
									<Suspense key={id} fallback={null}>
										<div className={`native-cli-main ${isCurrent ? "" : "hidden"}`}>
											<NativeCliPanel
												chat={chat}
												terminal={terminal}
												send={send}
												conversationId={id}
												nativeCli={isCurrent && chat.state?.nativeCli ? chat.state.nativeCli : info.nativeCli}
												active={active}
												cwd={info.cwd}
												onAddFiles={addNativeCliFiles}
												pushNotice={pushNotice}
											/>
										</div>
									</Suspense>
								);
							})}
							{isNativeCliConversation && chat.state?.nativeCli && !cachedNativeClis[chat.state.conversationId] && (
								<Suspense fallback={null}>
									<div className="native-cli-main">
										<NativeCliPanel
											chat={chat}
											terminal={terminal}
											send={send}
											conversationId={chat.state.conversationId}
											nativeCli={chat.state.nativeCli}
											active={view === "chat" && !chat.transition}
											cwd={chat.state.cwd}
											onAddFiles={addNativeCliFiles}
											pushNotice={pushNotice}
										/>
									</div>
								</Suspense>
							)}
							{!isNativeCliConversation && (
								<div className="native-cli-chat-content">
									{activeGroupId ? (
										<Suspense fallback={null}>
											<GroupConversation
												key={activeGroupId}
												roomId={activeGroupId}
												active={view === "chat"}
												onBack={() => setActiveGroupId(null)}
											/>
										</Suspense>
									) : (
										<>
											{chat.transition && (
												<div
													className={`workspace-transition-bar phase-${chat.transition.phase}`}
													role="status"
													aria-live="polite"
												>
													<div className="workspace-transition-track">
														<div
															className="workspace-transition-fill"
															style={{ width: `${Math.min(100, Math.max(8, chat.transition.progress))}%` }}
														/>
													</div>
													<div className="workspace-transition-pill">
														<span className="workspace-transition-spinner" aria-hidden="true" />
														<span className="workspace-transition-text">
															{!isZhLocale(locale) && chat.transition.textEn
																? chat.transition.textEn
																: chat.transition.text}
														</span>
														<span className="workspace-transition-pct">{chat.transition.progress}%</span>
													</div>
												</div>
											)}
											{uiChatHeader.length > 0 && (
												<div className="chat-header" role="toolbar">
													{renderSlotToolbar(uiChatHeader, onUiAction)}
												</div>
											)}
											{chat.state ? (
												<>
													{!sharedReadOnly && chat.state.sandbox && (
														<div className="sandbox-banner" role="region" aria-label={chat.state.sandbox.name}>
															<div className="sandbox-banner-info">
																<span className="sandbox-banner-title">
																	<LuFlaskConical className="sandbox-banner-icon" aria-hidden />
																	{t("sandboxBannerTitle", { name: chat.state.sandbox.name })}
																	<span
																		className={`lp-sandbox-badge ${chat.state.sandbox.ephemeral ? "ephemeral" : "permanent"}`}
																	>
																		{chat.state.sandbox.ephemeral
																			? t("sandboxBadgeEphemeral")
																			: t("sandboxBadgePermanent")}
																	</span>
																</span>
																<span className="sandbox-banner-desc">
																	{chat.state.sandbox.sourcePath
																		? t("sandboxBannerSourceDesc", { source: chat.state.sandbox.sourcePath })
																		: t("sandboxBannerBlankDesc")}
																</span>
															</div>
															<div className="sandbox-banner-actions">
																{chat.state.sandbox.ephemeral && (
																	<button
																		type="button"
																		className="sandbox-banner-btn"
																		title={t("sandboxActionPersistTip")}
																		onClick={() => send({ type: "persist_sandbox", path: chat.state?.sandbox?.path })}
																	>
																		<FiBookmark aria-hidden /> {t("sandboxActionPersist")}
																	</button>
																)}
																{chat.state.sandbox.sourcePath && (
																	<button
																		type="button"
																		className="sandbox-banner-btn primary"
																		title={t("sandboxActionApplySourceTip")}
																		onClick={() => setSandboxModalMode("apply")}
																	>
																		<FiCheck aria-hidden /> {t("sandboxActionApplySource")}
																	</button>
																)}
																<button
																	type="button"
																	className="sandbox-banner-btn"
																	title={t("sandboxActionPromoteTip")}
																	onClick={() => setSandboxModalMode("promote")}
																>
																	<FiUpload aria-hidden /> {t("sandboxActionPromote")}
																</button>
																<button
																	type="button"
																	className="sandbox-banner-btn"
																	title={t("sandboxActionResetTip")}
																	onClick={() => {
																		const sbx = chat.state?.sandbox;
																		if (!sbx) return;
																		if (window.confirm(t("sandboxActionResetConfirm", { name: sbx.name }))) {
																			send({ type: "reset_sandbox", path: sbx.path });
																		}
																	}}
																>
																	<FiRefreshCw aria-hidden /> {t("sandboxActionReset")}
																</button>
																<button
																	type="button"
																	className="sandbox-banner-btn danger"
																	title={t("sandboxActionDestroyTip")}
																	onClick={() => {
																		const sbx = chat.state?.sandbox;
																		if (!sbx) return;
																		if (window.confirm(t("sandboxActionDestroyConfirm", { name: sbx.name }))) {
																			send({ type: "destroy_sandbox", path: sbx.path });
																		}
																	}}
																>
																	<FiTrash2 aria-hidden /> {t("sandboxActionDestroy")}
																</button>
															</div>
														</div>
													)}

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
														quickAskTranslateEnabled={chat.settings?.quickAskTranslateEnabled !== false}
														uiMessageActions={uiSlots["message.actions"]}
														uiContextMessage={uiSlots["contextmenu.message"]}
														uiContextToolCall={uiSlots["contextmenu.toolcall"]}
														uiToolCardFooter={uiSlots["tool.card.footer"]}
														uiChatEmpty={uiChatEmpty}
														onUiAction={onUiAction}
														key={
															chat.transition?.previewMessages?.length
																? (chat.transition.previewConversationId ?? chat.transition.target)
																: (chat.state.conversationId ?? "boot")
														}
														preview={Boolean(chat.transition?.previewMessages?.length)}
														state={
															chat.transition?.previewMessages?.length
																? {
																		...chat.state,
																		conversationId: chat.transition.previewConversationId ?? chat.transition.target,
																		sessionFile: chat.transition.previewSessionFile,
																		historyStart: 0,
																		historyTotal: chat.transition.previewMessages.length,
																		messages: chat.transition.previewMessages,
																		streamingMessage: null,
																		isStreaming: false,
																		pendingQuestion: null,
																		pendingApproval: null,
																	}
																: chat.state
														}
														liveOutputs={chat.liveOutputs}
														toolStatuses={chat.toolStatuses}
														onEdit={onEditMessage}
														onKillBash={() => {
															const conversationId = chat.state?.conversationId;
															if (conversationId && !chat.transition) send({ type: "abort_bash", conversationId });
														}}
														onRetry={() => {
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
														reversePagination={chat.settings?.reversePagination ?? false}
														minimalNewChat={chat.settings?.minimalNewChat ?? false}
														jumpTarget={searchJump}
														onJumpDone={() => setSearchJump(null)}
														urlJumpMessageId={
															urlJump && urlJump.sessionId === chat.state.sessionId ? urlJump.messageId : null
														}
														onUrlJumpDone={() => setUrlJump(null)}
														userPromptNonce={userPromptNonce}
													/>
												</>
											) : (
												<div className="boot-wait">{chat.ready ? t("loadingSession") : t("connectingServer")}</div>
											)}

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
											{chat.dialog && <Dialog dialog={chat.dialog} />}
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
																} catch {}
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
																			} catch {}
																		}}
																	>
																		{opt.label}
																		{opt.description && <span className="dialog-hint">{opt.description}</span>}
																	</button>
																);
															})}
															{(pluginDialog.options ?? []).length === 0 && (
																<div className="dialog-hint">{t("noOptions")}</div>
															)}
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
																			} catch {}
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
																		} catch {}
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
																		} catch {}
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
																		} catch {}
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
																		} catch {}
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
																		} catch {}
																	}}
																>
																	{t("ok")}
																</button>
															</div>
														</div>
													)}
												</div>
											)}
											<QuestionQueue
												questions={resolveQuestionQueue(
													chat.questionQueue,
													chat.question,
													chat.remoteQuestion,
													chat.globalQuestions,
													chat.state?.sharedConversation?.owner,
												)}
												activeConversationId={activeConvId}
												mode={chat.settings?.questionPresentation ?? "queue"}
											/>
											<ToolApprovalDialog
												approvals={mergeOwnedPending(
													chat.approvals,
													chat.globalApprovals,
													chat.state?.sharedConversation?.owner,
												)}
												activeConversationId={activeConvId}
												mode={chat.settings?.toolApprovalPresentation ?? "all"}
											/>
											<PlanBoard
												plan={
													chat.activeConversationId && chat.state?.conversationId !== chat.activeConversationId
														? null
														: chat.state?.plan
												}
											/>
											{Object.entries(attachmentProgress).map(([id, item]) => (
												<div key={id} role="status">
													{item.percent === undefined
														? t("uploadPreparing", { name: item.name })
														: t("uploadReading", { name: item.name, percent: item.percent })}
													<progress max={100} value={item.percent} aria-label={item.name} />
												</div>
											))}
											{sharedReadOnly ? (
												<div className="sound-hint" role="status">
													Read-only conversation. Questions and approvals remain available above.
												</div>
											) : (
												<ChatInput
													composerLeading={uiSlots["composer.leading"]}
													composerActions={uiSlots["composer.actions"]}
													onUiAction={onUiAction}
													streaming={chat.state?.isStreaming ?? false}
													onAbort={handleAbort}
													planMode={chat.state?.planMode ?? false}
													messages={chat.state?.messages ?? EMPTY_MESSAGES}
													slashCommands={chat.slashCommands}
													modelState={modelState}
													models={chat.models}
													modelsLoading={chat.modelsLoading}
													providerKeys={chat.providerKeys}
													providers={chat.providers}
													defaultModel={chat.defaultModel ?? undefined}
													attachments={attachments}
													onRemoveAttachment={removeAttachmentCb}
													onAnnotateImage={annotateImageCb}
													onAddImageFiles={addImageFilesCb}
													onAddLocalFiles={addLocalFilesCb}
													onAddPathAttachment={addPathAttachmentCb}
													fileSearch={chat.fileSearch}
													onSearchFiles={searchFilesCb}
													onNotice={pushNotice}
													onManageModels={openManageModels}
													onSent={handleSent}
													quickPhrases={chat.settings?.quickPhrases ?? []}
													quickPhrasesEnabled={
														zenMode
															? false
															: (chat.settings?.quickPhrasesEnabled ?? true) &&
																(!chat.settings?.minimalNewChat ||
																	(chat.state?.messages?.length ?? 0) > 0 ||
																	!!chat.state?.streamingMessage)
													}
													recallDrafts={recallDrafts}
													dshPermCurrent={chat.state?.permission ?? null}
													dshPermOptions={chat.dshPermission?.options ?? undefined}
													dshPermDefault={chat.dshPermission?.defaultPreset}
													dshPreset={chat.state?.agentPreset ?? null}
													dshPresets={chat.dshPresets?.presets ?? undefined}
													dshPresetDefault={chat.dshPresets?.defaultPreset}
													dshBlank={(chat.state?.messages?.length ?? 0) === 0}
													conversationId={chat.activeConversationId || chat.state?.conversationId || ""}
													sessionDraft={chat.state?.draft ?? null}
													sessionId={chat.state?.sessionId ?? ""}
													preserveDraftAcrossConversations={chat.settings?.preserveDraftAcrossConversations ?? false}
												/>
											)}
										</>
									)}
								</div>
							)}
						</main>
						{!isMobile && !rightCollapsed && <ResizeHandle side="right" width={rightWidth} onResize={resizeRight} />}
						<div
							className={`panel-drawer drawer-right ${drawer === "right" ? "open" : ""}${
								isMobile ? "" : rightCollapsed ? " hidden" : ""
							}`}
						>
							<RightPanel
								quickAskReferenceMenus={chat.settings?.quickAskReferenceMenus !== false}
								collapsible={!isMobile}
								onToggleCollapse={toggleRight}
								panelSend={panelSend}
								files={chat.files}
								fileSearch={chat.fileSearch}
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
						<DeferredMount active={view === "terminal"}>
							<TerminalPanel
								chat={chat}
								terminal={terminal}
								uiTerminalToolbar={uiTerminalToolbar}
								onUiAction={onUiAction}
							/>
						</DeferredMount>
					</div>
					<div className={`view-pane ${view === "git" ? "" : "hidden"}`}>
						<DeferredMount active={view === "git"}>
							<ScmPanel
								chat={chat}
								terminal={terminal}
								active={view === "git"}
								onSwitchToTerminal={() => setView("terminal")}
								uiScmToolbar={uiScmToolbar}
								onUiAction={onUiAction}
							/>
						</DeferredMount>
					</div>
					<div className={`view-pane ${view === "canvas" ? "" : "hidden"}`}>
						<DeferredMount active={view === "canvas"}>
							<CanvasStudio
								send={send}
								active={view === "canvas"}
								models={chat.models}
								defaultModel={chat.defaultModel}
								installedSkills={chat.settings?.skills}
								projects={chat.projects}
								workspaceRoots={chat.state?.workspaceRoots ?? []}
								pathCompletions={chat.pathCompletions}
								currentCwd={chat.state?.cwd || "."}
							/>
						</DeferredMount>
					</div>
					{view === "worktrees" && (
						<div className="view-pane">
							<WorktreeView
								worktree={chat.state?.worktree}
								onRefresh={refreshWorktrees}
								onSwitch={(path) => {
									pendingWorktreeSwitch.current = { source: chat.state?.cwd ?? "", target: path };
									send({ type: "switch_worktree", path });
								}}
								onRemove={(path) => send({ type: "remove_worktree", path })}
								onBack={() => {
									setView("chat");
									focusComposer();
								}}
							/>
						</div>
					)}
					<div className={`view-pane ${view === "devices" ? "" : "hidden"}`}>
						<DeferredMount active={view === "devices"}>
							<DeviceCenter
								pathCompletions={chat.pathCompletions}
								plugins={chat.plugins}
								pluginsEpoch={chat.pluginsEpoch}
							/>
						</DeferredMount>
					</div>
					{pluginViews.map((entry) => {
						const name = `plugin:${entry.info.id}` as ViewName;
						return (
							<div key={entry.info.id} className={`view-pane ${view === name ? "" : "hidden"}`}>
								<PluginView entry={entry} />
							</div>
						);
					})}
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
						onCreateCli={openNativeCliCreate}
						items={uiSidebarRight}
						chat={chat}
						view={view}
						plugins={enabledPlugins}
						dropdownProps={{
							theme,
							themes,
							onThemeChange: switchTheme,
							reloadThemes,
						}}
						onViewChange={handleViewChange}
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
						zenMode={zenMode}
						onToggleZenMode={toggleZenMode}
					/>
				</div>
			</TemplateProvider>
			<FooterBar
				onCreateCli={openNativeCliCreate}
				chat={chat}
				bottombarItems={uiSlots["bottombar"]}
				onUiAction={onUiAction}
				onOpenSettings={() => {
					setSettingsInitialSection(undefined);
					setSettingsOpen(true);
				}}
				onViewChange={handleViewChange}
				onOpenGlobalSearch={() => setGlobalSearchOpen(true)}
				onOpenBgTasks={() => setBgTasksOpen(true)}
			/>
			{previewFile && previewFiles && (
				<Suspense fallback={null}>
					<FilePreview
						file={previewFile}
						files={previewFiles}
						activeIndex={previewIndex}
						onSelectFile={setPreviewIndex}
						composerSessionId={chat.state?.sessionId}
						content={chat.fileContent}
						onAddLines={(path, name, start, end) => attach(path, name, "lines", false, { start, end })}
						onAttach={(path, name, mode) => attach(path, name, mode)}
						onClose={() => setPreviewFiles(null)}
						uiFilePreviewToolbar={uiFilePreviewToolbar}
						onUiAction={onUiAction}
					/>
				</Suspense>
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
						setPreviewFiles([pluginFile.file]);
						setPreviewIndex(0);
					}}
				/>
			)}
			{lightboxImage && (
				<ImageLightbox
					{...lightboxImage}
					composerSessionId={chat.state?.sessionId}
					onClose={() => setLightboxImage(null)}
				/>
			)}
			{chat.ready &&
				chat.state &&
				chat.state.piConfigured === false &&
				!isNativeCliConversation &&
				!setupDismissed &&
				!manageModelsOpen &&
				!isDesktopShell() && (
					<Suspense fallback={null}>
						<PiSetupModal
							piConfigured={chat.state.piConfigured}
							piAgentInstalled={chat.state.piAgentInstalled}
							providers={chat.providers}
							providerOAuthFlows={chat.providerOAuthFlows}
							providerOAuthResults={chat.providerOAuthResults}
							installResult={chat.installResult}
							onClose={dismissSetup}
						/>
					</Suspense>
				)}
			{manageModelsOpen && !sharedReadOnly && (
				<Suspense fallback={null}>
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
				</Suspense>
			)}
			{settingsOpen && !sharedReadOnly && (
				<Suspense fallback={null}>
					<SettingsModal
						chat={chat}
						terminal={terminal}
						initialSection={settingsInitialSection}
						onSwitchToTerminal={() => setView("terminal")}
						onClose={() => setSettingsOpen(false)}
						onOpenIconEdit={() => setIconEditOpen(true)}
						onOpenManageModels={() => {
							setSettingsOpen(false);
							setManageModelsOpen(true);
						}}
						sound={sound}
						onSoundChange={setSound}
						tts={tts}
						onTtsChange={setTts}
					/>
				</Suspense>
			)}
			{bgTasksOpen && (
				<Suspense fallback={null}>
					<BgTasksModal
						servers={chat.bgServers}
						projectScripts={chat.projectScripts}
						plugins={chat.plugins}
						epoch={chat.pluginsEpoch}
						send={send}
						onUiAction={onUiAction}
						autoCleanupMin={chat.settings?.bgAutoCleanupMin ?? 0}
						onClose={() => setBgTasksOpen(false)}
					/>
				</Suspense>
			)}
			<ToolInfoDialog />
			<ToolInspectorModal />
			<RollbackDialog />
			{chat.tuiOverlay && (
				<Suspense fallback={null}>
					<TuiOverlayModal overlay={chat.tuiOverlay} />
				</Suspense>
			)}
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
			<DeferredMount active={globalSearchOpen}>
				<GlobalSearchModal
					open={globalSearchOpen}
					projects={chat.projects}
					fileSearch={chat.fileSearch}
					sessionSearch={chat.sessionSearch}
					onClose={() => setGlobalSearchOpen(false)}
					onSwitchSession={(path, anchors) => {
						void send({ type: "switch_session", path });
						const a = anchors && anchors[0];
						setSearchJump(a ? { path, role: a.role, timestamp: a.timestamp } : null);
					}}
					onSwitchProject={(path) => {
						void send({ type: "set_cwd", path });
					}}
					onPreviewFile={(path, name) => {
						openFile(path, name);
					}}
					onOpenFolder={(path) => {
						setGlobalSearchOpen(false);
						setRightCollapsed((v) => {
							if (v) {
								try {
									localStorage.setItem(panelCollapsedKey("right"), "0");
								} catch {}
							}
							return false;
						});
						setDrawer(null);
						window.setTimeout(() => {
							window.dispatchEvent(new CustomEvent("pi:open-folder", { detail: { path } }));
						}, 0);
					}}
				/>
			</DeferredMount>
			{pluginDirPicker && (
				<DirectoryBrowser
					currentCwd={pluginDirPicker.initialPath || chat.state?.cwd || ""}
					pathCompletions={chat.pathCompletions}
					workspaceRoots={chat.state?.workspaceRoots ?? []}
					onClose={() => {
						pluginDirPicker.resolve({ ok: false, canceled: true });
						setPluginDirPicker(null);
					}}
					onSelectDirectory={(path) => {
						pluginDirPicker.resolve({ ok: true, path });
						setPluginDirPicker(null);
					}}
					onCreateProject={(path) => {
						void send({ type: "make_dir", path });
						pluginDirPicker.resolve({ ok: true, path });
						setPluginDirPicker(null);
					}}
					mode="project"
					className="project-picker"
					backdropClassName="project-picker-backdrop"
					role="dialog"
					ariaLabel={t("projectPickerTitle")}
				/>
			)}
			{pluginModelPicker && (
				<ModelPickerModal
					currentModelId={pluginModelPicker.currentModelId}
					models={chat.models}
					modelsLoading={chat.modelsLoading}
					providerKeys={chat.providerKeys}
					providers={chat.providers}
					onManageModels={() => setManageModelsOpen(true)}
					defaultModel={chat.defaultModel}
					onClose={() => {
						pluginModelPicker.resolve({ ok: false, canceled: true });
						setPluginModelPicker(null);
					}}
					onSelect={(modelId, model) => {
						pluginModelPicker.resolve({
							ok: true,
							modelId,
							name: model?.name,
							provider: model?.provider,
						});
						setPluginModelPicker(null);
					}}
				/>
			)}
			{deviceGroupCreateOpen && (
				<Suspense fallback={null}>
					<DeviceGroupCreateDialog onClose={() => setDeviceGroupCreateOpen(false)} />
				</Suspense>
			)}
			{(pendingPermRequest || pendingPathRequest || pluginPathConfirm) &&
				createPortal(
					<div className="modal-backdrop perm-modal-backdrop" style={{ zIndex: permOverlayZIndex }}>
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
					</div>,
					document.body,
				)}
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
			{sandboxModalMode && (
				<SandboxModal
					mode={sandboxModalMode}
					currentCwd={chat.state?.cwd}
					currentSandbox={chat.state?.sandbox}
					sandboxDiff={chat.sandboxDiff}
					projects={chat.projects}
					send={send}
					onClose={() => setSandboxModalMode(null)}
				/>
			)}
			<QuickAskPopover
				settings={chat.settings}
				clientId={getClientId()}
				currentConversation={
					chat.activeConversationId || chat.state?.conversationId
						? {
								kind: "conversation",
								conversationId: chat.activeConversationId || chat.state!.conversationId,
							}
						: undefined
				}
				fallbackModel={chat.state?.model ? `${chat.state.model.provider}/${chat.state.model.id}` : undefined}
			/>
			<DesktopSplitResizer />
			<BannerContainer />
		</div>
	);
}
