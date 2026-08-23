import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { TopBar } from "./components/TopBar";
import { LeftPanel } from "./components/LeftPanel";
import { RightPanel } from "./components/RightPanel";
import { MessageList } from "./components/MessageList";
import { ChatInput } from "./components/ChatInput";
import { GoalBar } from "./components/GoalBar";
import { FooterBar } from "./components/FooterBar";
import { Dialog } from "./components/Dialog";
// 终端视图懒加载：xterm.js 体积大且只在切到终端时才需要，拆出主包
const TerminalPanel = lazy(() =>
	import("./components/TerminalPanel").then((m) => ({ default: m.TerminalPanel })),
);
import { ScmPanel } from "./components/SCMPanel";
import { PiSetupModal } from "./components/PiSetupModal";
import { ModelConfigModal } from "./components/ModelConfigModal";

import { SettingsModal } from "./components/SettingsModal";
import { BgTasksModal } from "./components/BgTasksModal";
import { FilePreview, type PreviewFile } from "./components/FilePreview";
import { useChat } from "./use-chat";
import type { ClientMessage } from "./types";
import { useT } from "./i18n";
import { FiAlertCircle, FiAlertTriangle, FiInfo, FiX } from "react-icons/fi";
import type { Notice } from "./use-chat";
import { fileToProcessedImage, isRasterImage, type ProcessedImage } from "./image-paste";
import { randomUuid } from "./uuid";
import {
	loadSoundSettings,
	playSound,
	saveSoundSettings,
	type SoundKind,
	type SoundSettings,
} from "./sounds";
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
function NoticeToast({
	notice,
	onDismiss,
}: {
	notice: Notice;
	onDismiss: (id: number) => void;
}) {
	const t = useT();
	const [paused, setPaused] = useState(false);
	useEffect(() => {
		if (paused) return;
		const t = setTimeout(
			() => onDismiss(notice.id),
			notice.level === "error" ? 12000 : 7000,
		);
		return () => clearTimeout(t);
	}, [paused, notice.id, notice.level, onDismiss]);
	const Icon =
		notice.level === "error"
			? FiAlertCircle
			: notice.level === "warning"
				? FiAlertTriangle
				: FiInfo;
	return (
		<div
			className={`notice notice-${notice.level}${paused ? " paused" : ""}`}
			role="status"
			onMouseEnter={() => setPaused(true)}
			onMouseLeave={() => setPaused(false)}
		>
			<Icon className="notice-icon" />
			<span className="notice-text">{notice.text}</span>
			<button
				type="button"
				className="notice-close"
				title={t("close")}
				onClick={() => onDismiss(notice.id)}
			>
				<FiX />
			</button>
		</div>
	);
}
export function App() {
	const t = useT();
	const { chat, send, dismissNotice, pushNotice, terminal } = useChat();
	const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
	const [previewFile, setPreviewFile] = useState<PreviewFile | null>(null);
	const [view, setView] = useState<"chat" | "terminal" | "git">("chat");
	// Mobile: which side panel is open as a drawer (null = both closed).
	const [drawer, setDrawer] = useState<"left" | "right" | null>(null);
	// Viewport class: ≤768px turns the side panels into sliding drawers
	// (matches the CSS breakpoint) — used to lazy-load panel data only when
	// a drawer is actually open on mobile.
	const [isMobile, setIsMobile] = useState(
		() => window.matchMedia("(max-width: 768px)").matches,
	);
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

	// -- sound notifications --------------------------------------------------
	const [sound, setSound] = useState<SoundSettings>(loadSoundSettings);
	// -- theme (whole stylesheet swap) ---------------------------------------
	const { themes, theme, switchTheme } = useTheme();
	const prevStreaming = useRef<boolean | null>(null);
	const prevDialogId = useRef<number | null>(null);
	const lastErrorNotice = useRef(0);
	// Remembers a terminal-view click made before the WebSocket is ready.
	const terminalOpenRequested = useRef(false);

	useEffect(() => {
		saveSoundSettings(sound);
	}, [sound]);

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
			prev.some(
				(a) =>
					`${a.path}|${a.mode}|${a.lines ? `${a.lines.start}-${a.lines.end}` : ""}` ===
					key,
			)
				? prev
				: [...prev, { path, name, mode, isDir, ...(lines ? { lines } : {}) }],
		);
	};
	const removeAttachment = (pathOrKey: string) =>
		setAttachments((prev) =>
			prev.filter((a) => (a.key ? a.key !== pathOrKey : a.path !== pathOrKey)),
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
			if (
				!msg.type.startsWith("list_") &&
				!msg.type.startsWith("get_")
			) {
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
			pushNotice(
				"warning",
				t("fileTooLarge", { name: f.name, size: MAX_UPLOAD_BYTES / 1024 / 1024 }),
			);
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
	// the edited text there (stable callback — Message is memoized).
	const onEditMessage = useCallback(
		(messageId: string, text: string) => {
			send({ type: "edit_message", messageId, text });
		},
		[send],
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
		// Swallowing page-level drops prevents the browser from navigating away
		// when a file is dropped outside the input bar (the input bar has its
		// own handlers that stop propagation and process images).
		<div
			className="app"
			onDragOver={(e) => e.preventDefault()}
			onDrop={(e) => e.preventDefault()}
		>
			<TopBar
				chat={chat}
				send={send}
				view={view}
				onViewChange={(v) => {
					// The terminal panel stays mounted while hidden. Create the first
					// shell on the user's terminal-view click, not on initial mount.
					terminalOpenRequested.current =
						v === "terminal" && chat.terminals.length === 0;
					if (terminalOpenRequested.current && createShell()) {
						terminalOpenRequested.current = false;
					}
					setView(v);
					setDrawer(null);
				}}
				onOpenPanel={setDrawer}
				onManageModels={() => setManageModelsOpen(true)}
				onOpenSettings={() => setSettingsOpen(true)}
				onOpenBgTasks={() => setBgTasksOpen(true)}
				sound={sound}
				onSoundChange={setSound}
				onSoundPreview={(kind: SoundKind) => playSound(kind, sound)}
				themes={themes}
				theme={theme}
				onThemeChange={switchTheme}
			/>
			<div className="notices">
				{chat.notices.map((n) => (
					<NoticeToast key={n.id} notice={n} onDismiss={dismissNotice} />
				))}
			</div>
			<div className="layout">
				{drawer && (
					<div className="drawer-backdrop" onClick={() => setDrawer(null)} />
				)}
				<div className={`view-pane ${view === "chat" ? "" : "hidden"}`}>
					<div
						className={`panel-drawer drawer-left ${drawer === "left" ? "open" : ""}`}
					>
						<LeftPanel chat={chat} send={panelSend} active={!isMobile || drawer === "left"} />
					</div>
					<main className="main">
						{chat.state ? (
							<MessageList
								key={chat.state.conversationId ?? "boot"}
								state={chat.state}
								liveOutputs={chat.liveOutputs}
								toolStatuses={chat.toolStatuses}
								onEdit={onEditMessage}
								onKillBash={() => send({ type: "abort_bash" })}
								onFetchMessage={(id) => send({ type: "get_message", id })}
							/>
						) : (
							<div className="boot-wait">
								{chat.ready ? t("loadingSession") : t("connectingServer")}
							</div>
						)}
						<GoalBar chat={chat} send={send} />
						<ChatInput
							chat={chat}
							send={send}
							attachments={attachments}
							onRemoveAttachment={removeAttachment}
							onAddImageFiles={addImageFiles}
							onAddLocalFiles={addLocalFiles}
							onNotice={pushNotice}
							onManageModels={() => setManageModelsOpen(true)}
							onSent={() => setAttachments([])}
						/>
					</main>
					<div
						className={`panel-drawer drawer-right ${drawer === "right" ? "open" : ""}`}
					>
						<RightPanel
							chat={chat}
							send={panelSend}
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
			</div>
			<FooterBar chat={chat} send={send} />
			{chat.dialog && <Dialog dialog={chat.dialog} send={send} />}
			{previewFile && (
				<FilePreview
					file={previewFile}
					content={chat.fileContent}
					send={send}
					onAddLines={(path, name, start, end) =>
						attach(path, name, "lines", false, { start, end })
					}
					onAttach={(path, name, mode) => attach(path, name, mode)}
					onClose={() => setPreviewFile(null)}
				/>
			)}
			{chat.ready &&
				chat.state &&
				chat.state.piConfigured === false &&
				!setupDismissed &&
				!manageModelsOpen && (
					<PiSetupModal
						send={send}
						piConfigured={chat.state.piConfigured}
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
					fetchModelsResult={chat.fetchModelsResult}
					onClose={() => setManageModelsOpen(false)}
				/>
			)}
			{settingsOpen && (
				<SettingsModal
					chat={chat}
					send={send}
					onClose={() => setSettingsOpen(false)}
				/>
			)}
			{bgTasksOpen && (
				<BgTasksModal
					servers={chat.bgServers}
					send={send}
					onClose={() => setBgTasksOpen(false)}
				/>
			)}
		</div>
	);
}
