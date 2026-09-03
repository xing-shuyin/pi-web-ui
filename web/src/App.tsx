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
import { syncPluginViews, subscribeLoadedPluginViews, type LoadedPluginView } from "./plugin-loader";
import { PiSetupModal } from "./components/PiSetupModal";
import { ModelConfigModal } from "./components/ModelConfigModal";

import { SettingsModal } from "./components/SettingsModal";
import { BgTasksModal } from "./components/BgTasksModal";
import { GlobalSearchModal } from "./components/GlobalSearchModal";
import { TemplateProvider } from "./components/PromptTemplates";
import { FilePreview, type PreviewFile } from "./components/FilePreview";
import { useChat } from "./use-chat";
import type { ClientMessage, CommandDef, PromptAttachment, UiMessage } from "./types";
import { useT, useI18n } from "./i18n";
import { FiAlertCircle, FiAlertTriangle, FiChevronsLeft, FiChevronsRight, FiInfo, FiX } from "react-icons/fi";
import type { Notice } from "./use-chat";
import { fileToProcessedImage, isRasterImage, type ProcessedImage } from "./image-paste";
import { randomUuid } from "./uuid";
import { loadSoundSettings, playSound, saveSoundSettings, type SoundKind, type SoundSettings } from "./sounds";
import { useTheme } from "./theme";

export interface PendingAttachment {
	path: string;
	name: string;
	mode: "inline" | "reference" | "lines";
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
	const text = locale === "en" && notice.textEn ? notice.textEn : notice.text;
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

export function App() {
	const t = useT();
	const { chat, send, dismissNotice, pushNotice, terminal } = useChat();
	const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
	const [previewFile, setPreviewFile] = useState<PreviewFile | null>(null);
	/** Full-window file drag in progress (issue #19) — shows the app-wide
	 *  drop overlay; drop anywhere attaches, the input bar keeps priority via
	 *  its own stopPropagation handlers. */
	const [appDragOver, setAppDragOver] = useState(false);
	const [view, setView] = useState<ViewName>("chat");
	// 已安装且未在设置面板禁用的插件（决定 tab 与视图加载）。
	const enabledPlugins = useMemo(
		() => chat.plugins.filter((p) => !chat.settings?.disabledPlugins?.includes(p.id)),
		[chat.plugins, chat.settings?.disabledPlugins],
	);
	// 已加载的插件视图（bundle 动态 import 完成后出现）。
	const [pluginViews, setPluginViews] = useState<LoadedPluginView[]>([]);
	useEffect(() => subscribeLoadedPluginViews(setPluginViews), []);
	// 目录清单/禁用集合/epoch 变化 → 同步注册表：新增的拉取、消失的清理
	// （React 卸载对应 PluginView 时调用插件的 cleanup）、服务端 reload 后重拉。
	useEffect(() => {
		void syncPluginViews(enabledPlugins, chat.pluginsEpoch);
	}, [enabledPlugins, chat.pluginsEpoch]);
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
		return () => window.removeEventListener("pi-web-ui:plugin-run-command", onPluginRunCommand);
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
	const { themes, theme, switchTheme } = useTheme();
	const prevStreaming = useRef<boolean | null>(null);
	const prevDialogId = useRef<number | null>(null);
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
		else if (prev && !streaming) playSound("done", sound);
	}, [chat.state?.isStreaming, sound]);

	// Questionnaire cue — each new dialog id.
	useEffect(() => {
		const id = chat.dialog?.id ?? null;
		if (id !== null && id !== prevDialogId.current) {
			playSound("question", sound);
		}
		prevDialogId.current = id;
	}, [chat.dialog, sound]);

	// Error cue — new error notices only.
	useEffect(() => {
		const err = [...chat.notices].reverse().find((n) => n.level === "error");
		if (err && err.id !== lastErrorNotice.current) {
			lastErrorNotice.current = err.id;
			playSound("error", sound);
		}
	}, [chat.notices, sound]);

	const attach = (
		path: string,
		name: string,
		mode: "inline" | "reference" | "lines",
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
		setAttachments((prev) => prev.filter((a) => (a.key ? a.key !== pathOrKey : a.path !== pathOrKey)));

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

	// Remove one queued prompt (the ✕ on a pending bubble).
	const onRemoveQueued = useCallback(
		(kind: "steer" | "followUp", text: string) => {
			send({ type: "queue_remove", kind, text });
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
				send={send}
				terminal={terminal}
				view={view}
				plugins={enabledPlugins}
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
				onOpenSettings={() => setSettingsOpen(true)}
				onOpenBgTasks={() => setBgTasksOpen(true)}
				onOpenGlobalSearch={() => setGlobalSearchOpen(true)}
				sound={sound}
				onSoundChange={setSound}
				onSoundPreview={(kind: SoundKind) => playSound(kind, sound)}
				themes={themes}
				theme={theme}
				onThemeChange={switchTheme}
			/>
			{chat.protocolMismatch && <div className="protocol-banner">⚠ {t("protocolMismatch")}</div>}
			<div className="notices">
				{chat.notices.map((n) => (
					<NoticeToast key={n.id} notice={n} onDismiss={dismissNotice} />
				))}
			</div>
			<TemplateProvider send={send}>
				<div
					className="layout"
					style={{ "--left-w": `${leftWidth}px`, "--right-w": `${rightWidth}px` } as CSSProperties}
				>
					{drawer && <div className="drawer-backdrop" onClick={() => setDrawer(null)} />}
					<div className={`view-pane ${view === "chat" ? "" : "hidden"}`}>
						{!isMobile && leftCollapsed && <PanelRail side="left" onClick={toggleLeft} />}
						<div
							className={`panel-drawer drawer-left ${drawer === "left" ? "open" : ""}${isMobile ? "" : leftCollapsed ? " hidden" : ""}`}
						>
							<LeftPanel
								collapsible={!isMobile}
								onToggleCollapse={toggleLeft}
								send={panelSend}
								active={!isMobile || drawer === "left"}
								ready={chat.ready}
								status={chat.status}
								cwd={chat.state?.cwd ?? ""}
								sessionFile={chat.state?.sessionFile ?? null}
								conversations={chat.conversations}
								sessions={chat.sessions}
								projects={chat.projects}
								activeConversationId={chat.activeConversationId}
							/>
						</div>
						{!isMobile && <ResizeHandle side="left" width={leftWidth} onResize={resizeLeft} />}
						<main className="main">
							{chat.state ? (
								<MessageList
									key={chat.state.conversationId ?? "boot"}
									state={chat.state}
									liveOutputs={chat.liveOutputs}
									toolStatuses={chat.toolStatuses}
									onEdit={onEditMessage}
									onKillBash={() => send({ type: "abort_bash" })}
									onRemoveQueued={onRemoveQueued}
									thinkingWrap={chat.settings?.thinkingWrap ?? true}
									toolsWrap={chat.settings?.toolsWrap ?? true}
									jumpTarget={searchJump}
									onJumpDone={() => setSearchJump(null)}
								/>
							) : (
								<div className="boot-wait">{chat.ready ? t("loadingSession") : t("connectingServer")}</div>
							)}
							<GoalBar
								send={send}
								goal={chat.goal}
								models={chat.models}
								modelsLoading={chat.modelsLoading}
								activeConversationId={chat.activeConversationId}
								engine={chat.engine}
							/>
							{/* 扩展问卷：非模态内联面板，插在输入框上方，对话内容保持可见 */}
							{chat.dialog && <Dialog dialog={chat.dialog} send={send} />}
							{chat.question && <DshQuestionDialog question={chat.question} send={send} />}
							<ChatInput
								send={send}
								ready={chat.ready}
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
								onNotice={pushNotice}
								onManageModels={openManageModels}
								onSent={clearAttachments}
							/>
						</main>
						{!isMobile && <ResizeHandle side="right" width={rightWidth} onResize={resizeRight} />}
						<div
							className={`panel-drawer drawer-right ${drawer === "right" ? "open" : ""}${isMobile ? "" : rightCollapsed ? " hidden" : ""}`}
						>
							<RightPanel
								collapsible={!isMobile}
								onToggleCollapse={toggleRight}
								send={panelSend}
								files={chat.files}
								fileChanged={chat.fileChanged}
								widgets={chat.widgets}
								cwd={chat.state?.cwd ?? ""}
								onAttach={(path, name, mode, isDir) => {
									setDrawer(null);
									attach(path, name, mode, isDir);
								}}
								onPreview={(path, name) => {
									setDrawer(null);
									setPreviewFile({ path, name });
								}}
								onNotice={(level, text) => pushNotice(level, text)}
							/>
						</div>
						{!isMobile && rightCollapsed && <PanelRail side="right" onClick={toggleRight} />}
					</div>
					<div className={`view-pane ${view === "terminal" ? "" : "hidden"}`}>
						<Suspense fallback={null}>
							<TerminalPanel chat={chat} send={send} terminal={terminal} />
						</Suspense>
					</div>
					<div className={`view-pane ${view === "git" ? "" : "hidden"}`}>
						<ScmPanel
							chat={chat}
							send={send}
							terminal={terminal}
							active={view === "git"}
							onSwitchToTerminal={() => setView("terminal")}
						/>
					</div>
					{pluginViews.map((entry) => {
						const name = `plugin:${entry.info.id}` as ViewName;
						return (
							<div key={entry.info.id} className={`view-pane ${view === name ? "" : "hidden"}`}>
								<PluginView entry={entry} send={send} />
							</div>
						);
					})}
				</div>
			</TemplateProvider>
			<FooterBar chat={chat} send={send} />
			{previewFile && (
				<FilePreview
					file={previewFile}
					content={chat.fileContent}
					send={send}
					onAddLines={(path, name, start, end) => attach(path, name, "lines", false, { start, end })}
					onAttach={(path, name, mode) => attach(path, name, mode)}
					onClose={() => setPreviewFile(null)}
				/>
			)}
			{chat.ready && chat.state && chat.state.piConfigured === false && !setupDismissed && !manageModelsOpen && (
				<PiSetupModal
					send={send}
					piConfigured={chat.state.piConfigured}
					piAgentInstalled={chat.state.piAgentInstalled}
					providers={chat.providers}
					installResult={chat.installResult}
					onClose={() => setSetupDismissed(true)}
				/>
			)}
			{manageModelsOpen && (
				<ModelConfigModal
					send={send}
					providers={chat.modelsConfig}
					providerStatus={chat.providers}
					providerKeys={chat.providerKeys}
					fetchModelsResult={chat.fetchModelsResult}
					refreshProviderResult={chat.refreshProviderResult}
					cloneProviderResult={chat.cloneProviderResult}
					onClose={() => setManageModelsOpen(false)}
				/>
			)}
			{settingsOpen && (
				<SettingsModal
					chat={chat}
					send={send}
					terminal={terminal}
					onSwitchToTerminal={() => setView("terminal")}
					onClose={() => setSettingsOpen(false)}
				/>
			)}
			{bgTasksOpen && <BgTasksModal servers={chat.bgServers} send={send} onClose={() => setBgTasksOpen(false)} />}
			<GlobalSearchModal
				open={globalSearchOpen}
				send={send}
				projects={chat.projects}
				cwd={chat.state?.cwd ?? ""}
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
