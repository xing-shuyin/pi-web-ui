import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
	FiCheck,
	FiChevronRight,
	FiClipboard,
	FiCopy,
	FiDownload,
	FiEye,
	FiEyeOff,
	FiFile,
	FiFolder,
	FiHardDrive,
	FiHome,
	FiLink,
	FiMaximize2,
	FiMonitor,
	FiX,
} from "react-icons/fi";
import type { ClientMessage, FileListing, UiPluginInfo } from "../types";
import { useT } from "../i18n";
import { useAppField } from "../app-globals";
import { downloadFile, DOWNLOAD_FILE_NOT_FOUND } from "../download";
import { HintTip, TipButton } from "./HintTip";
import { FileTransferDialog, type FileTransferRequest } from "./FileTransferDialog";
import { isExtractableArchive } from "../file-transfer";
import { applySashDrag, parseWeights } from "../panel-sash";
import { visibleTreeEntries } from "../file-tree-hidden";
import type { UiSlotEntry } from "../ui-slots";
import { contextMenuItems, openContextMenu } from "../context-menu-state";
import { openQuickAsk, type QuickAskReferenceSource } from "../quick-ask";
import { SlotTabs, type SlotTab } from "./SlotTabs";
import { copyTextToClipboard } from "../use-copy-feedback";
import { isRemoteWorkspaceUri, parseRemoteWorkspaceUri } from "../remote-ssh-client";

const MACHINE_ROOT = "@root";

const LS_RP_SIZES = "pi-web-ui:rp-sizes";
const LS_FILES_SHOW_HIDDEN = "pi-web-ui:files-show-hidden";
type RpWeights = { files: number; widgets: number };
const DEFAULT_RP_WEIGHTS: RpWeights = { files: 4, widgets: 1 };
const RP_MIN_FILES_PX = 120;
const RP_MIN_WIDGETS_PX = 56;

function splitTopPx(panel: HTMLElement, split: HTMLElement | null): number {
	if (!split) return 32;
	return Math.max(0, split.getBoundingClientRect().top - panel.getBoundingClientRect().top);
}

type AttachMode = "reference";

interface FileMenuCtx {
	target: { id: string; kind: "file" | "dir" | "list"; label: string };
	dir: string;
	project: { path: string; name: string } | null;
}

const FILES_TAB_ID = "files";

const EMPTY_PLUGINS: UiPluginInfo[] = [];
const NOOP_SEND = (): void => {};

function parentWireOf(p: string): string {
	const w = p.endsWith("/") && p !== "/" ? p.slice(0, -1) : p;
	const i = w.lastIndexOf("/");
	if (i < 0) return "";
	if (i === 0) return "/";
	return w.slice(0, i);
}

function isProtectedRoot(p: string): boolean {
	return p === MACHINE_ROOT || p === "/" || /^[A-Za-z]:$/.test(p);
}

function isAbsoluteWire(p: string): boolean {
	return p.startsWith("/") || /^[A-Za-z]:([/]|$)/.test(p);
}

interface FileUploadProgress {
	id: string;
	name: string;
	dir: string;
	phase: "reading" | "waiting" | "unknown" | "success" | "error";
	percent: number;
	error?: string;
}

interface RightPanelProps {
	files: FileListing | null;
	fileChanged: { path: string } | null;
	widgets: { key: string; lines: string[] }[];
	panelSend: (msg: ClientMessage) => boolean;
	onAttach: (path: string, name: string, mode: AttachMode, isDir?: boolean) => void;
	onPreview: (path: string, name: string) => void;
	onNotice: (level: "info" | "warning" | "error", text: string) => void;
	collapsible?: boolean;
	onToggleCollapse?: () => void;

	uiRightPanelTabs?: UiSlotEntry[];
	uiContextFile?: UiSlotEntry[];
	quickAskReferenceMenus?: boolean;
	plugins?: UiPluginInfo[];
	pluginsEpoch?: number;
	send?: (msg: { type: "plugin_message"; pluginId: string; payload: unknown }) => void;
}

export const RightPanel = memo(function RightPanel({
	files,
	fileChanged,
	widgets,
	panelSend,
	onAttach,
	onPreview,
	onNotice,
	collapsible,
	onToggleCollapse,
	uiRightPanelTabs,
	uiContextFile,
	quickAskReferenceMenus = true,
	plugins,
	pluginsEpoch,
	send,
}: RightPanelProps) {
	const t = useT();
	const pluginList = plugins ?? EMPTY_PLUGINS;
	const cwd = useAppField("cwd");
	const workspaceRoots = useAppField("workspaceRoots");
	const homeDir = useAppField("homeDir");
	const desktopDir = useAppField("desktopDir");
	const [currentPath, setCurrentPath] = useState<string>("");
	const [expandedWidget, setExpandedWidget] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);

	const panelRef = useRef<HTMLElement>(null);
	const splitRef = useRef<HTMLDivElement>(null);
	const [rpWeights, setRpWeights] = useState<RpWeights>(() => {
		try {
			return parseWeights(localStorage.getItem(LS_RP_SIZES), DEFAULT_RP_WEIGHTS);
		} catch {
			return { ...DEFAULT_RP_WEIGHTS };
		}
	});
	useEffect(() => {
		try {
			localStorage.setItem(LS_RP_SIZES, JSON.stringify(rpWeights));
		} catch {}
	}, [rpWeights]);

	const [showHiddenFiles, setShowHiddenFiles] = useState(() => {
		try {
			return localStorage.getItem(LS_FILES_SHOW_HIDDEN) === "1";
		} catch {
			return false;
		}
	});
	useEffect(() => {
		try {
			localStorage.setItem(LS_FILES_SHOW_HIDDEN, showHiddenFiles ? "1" : "0");
		} catch {}
	}, [showHiddenFiles]);
	const hasWidgets = widgets.some((w) => w.lines.length > 0);
	const onSashDown = useCallback(
		(e: React.PointerEvent<HTMLDivElement>) => {
			e.preventDefault();
			const panel = panelRef.current;
			if (!panel) return;
			const target = e.currentTarget;
			const startY = e.clientY;
			const start = { above: rpWeights.files, below: rpWeights.widgets };
			const available = Math.max(120, panel.clientHeight - splitTopPx(panel, splitRef.current));
			target.classList.add("dragging");
			document.body.classList.add("rp-resizing");
			const onMove = (ev: PointerEvent) => {
				const { above, below } = applySashDrag({
					start,
					deltaPx: ev.clientY - startY,
					availablePx: available,
					totalWeight: start.above + start.below,
					minAbovePx: RP_MIN_FILES_PX,
					minBelowPx: RP_MIN_WIDGETS_PX,
				});
				setRpWeights({ files: above, widgets: below });
			};
			const onUp = () => {
				window.removeEventListener("pointermove", onMove);
				window.removeEventListener("pointerup", onUp);
				target.classList.remove("dragging");
				document.body.classList.remove("rp-resizing");
			};
			window.addEventListener("pointermove", onMove);
			window.addEventListener("pointerup", onUp);
		},
		[rpWeights.files, rpWeights.widgets],
	);

	const bodyRef = useRef<HTMLDivElement | null>(null);
	const bodyScrollRef = useRef(0);
	const attachBody = useCallback((el: HTMLDivElement | null) => {
		bodyRef.current = el;
		if (el) el.scrollTop = bodyScrollRef.current;
	}, []);

	const [copiedKey, setCopiedKey] = useState<string | null>(null);
	const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => {
		return () => {
			if (copyTimer.current) clearTimeout(copyTimer.current);
		};
	}, []);

	const markCopied = useCallback((key: string) => {
		setCopiedKey(key);
		if (copyTimer.current) clearTimeout(copyTimer.current);
		copyTimer.current = setTimeout(() => setCopiedKey(null), 1200);
	}, []);

	const copyText = useCallback(
		(text: string, key: string) => {
			if (!text) return;
			void copyTextToClipboard(text).then((ok) => {
				if (ok) markCopied(key);
				else onNotice("error", t("slashCopyFailed"));
			});
		},
		[markCopied, onNotice, t],
	);

	const absPathOf = useCallback(
		(p: string): string => {
			if (!p) return cwd;
			if (/^[A-Za-z]:$/.test(p)) return `${p}/`;
			if (p.startsWith("/") || /^[A-Za-z]:([/]|$)/.test(p)) return p;
			const root = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
			return root ? `${root}/${p}` : p;
		},
		[cwd],
	);

	const transferAbsPathOf = useCallback(
		(p: string): string => {
			if (isRemoteWorkspaceUri(cwd)) {
				const parsed = parseRemoteWorkspaceUri(cwd);
				const root = parsed ? parsed.remotePath : "/";
				if (!p) return root;
				if (p.startsWith("/")) return p;
				const cleanRoot = root.replace(/\/+$/, "") || "/";
				return cleanRoot === "/" ? `/${p}` : `${cleanRoot}/${p}`;
			}
			return absPathOf(p);
		},
		[cwd, absPathOf],
	);

	const toProjectPath = useCallback(
		(p: string): string | null => {
			if (!p || p === MACHINE_ROOT) return null;
			if (p.startsWith("/") || /^[A-Za-z]:([/]|$)/.test(p)) return p;
			const root = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
			return `${root}/${p}`;
		},
		[cwd],
	);

	const workspaceUploadMaxMb = useAppField("workspaceUploadMaxMb");
	const WS_UPLOAD_MAX_BYTES = workspaceUploadMaxMb * 1024 * 1024;
	const [fileUploads, setFileUploads] = useState<FileUploadProgress[]>([]);
	const connectionStatus = useAppField("status");
	useEffect(() => {
		if (connectionStatus === "open") return;
		setFileUploads((rows) =>
			rows.some((row) => row.phase === "waiting")
				? rows.map((row) => (row.phase === "waiting" ? { ...row, phase: "unknown" } : row))
				: rows,
		);
	}, [connectionStatus]);
	const uploadReaders = useRef(new Map<string, FileReader>());
	useEffect(() => {
		const onResult = (event: Event) => {
			const result = (event as CustomEvent<unknown>).detail;
			if (!result || typeof result !== "object") return;
			const { uploadId, ok, error } = result as Record<string, unknown>;
			if (typeof uploadId !== "string" || typeof ok !== "boolean") return;
			setFileUploads((rows) =>
				rows.map((row) =>
					row.id === uploadId && (row.phase === "waiting" || row.phase === "unknown")
						? { ...row, phase: ok ? "success" : "error", error: typeof error === "string" ? error : undefined }
						: row,
				),
			);
		};
		window.addEventListener("pi:file-upload-result", onResult);
		const readers = uploadReaders.current;
		return () => {
			window.removeEventListener("pi:file-upload-result", onResult);
			for (const reader of readers.values()) {
				reader.onload = reader.onprogress = reader.onerror = reader.onabort = null;
				reader.abort();
			}
			readers.clear();
		};
	}, []);
	const uploadFilesTo = useCallback(
		(dir: string, files: File[]) => {
			for (const f of files) {
				if (f.size > WS_UPLOAD_MAX_BYTES) {
					onNotice("warning", t("fileTooLarge", { name: f.name, size: WS_UPLOAD_MAX_BYTES / 1024 / 1024 }));
					continue;
				}
				const id = crypto.randomUUID();
				const update = (patch: Partial<FileUploadProgress>) =>
					setFileUploads((rows) => rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
				setFileUploads((rows) => [...rows, { id, name: f.name, dir, phase: "reading", percent: 0 }]);
				const fr = new FileReader();
				uploadReaders.current.set(id, fr);
				const readFailed = () => {
					uploadReaders.current.delete(id);
					update({ phase: "error", error: t("fileUploadReadFailed", { name: f.name }) });
				};
				fr.onprogress = (event) => {
					if (event.lengthComputable && event.total > 0) {
						update({ percent: Math.min(100, Math.floor((event.loaded / event.total) * 100)) });
					}
				};
				fr.onerror = readFailed;
				fr.onabort = readFailed;
				fr.onload = () => {
					uploadReaders.current.delete(id);
					if (typeof fr.result !== "string" || !fr.result.includes(",")) {
						readFailed();
						return;
					}
					const b64 = fr.result.slice(fr.result.indexOf(",") + 1);
					update({ phase: "waiting", percent: 100 });
					try {
						if (panelSend({ type: "upload_file", dirPath: dir, name: f.name, data: b64, uploadId: id })) return;
					} catch {}
					update({ phase: "error", error: t("fileUploadSendFailed", { name: f.name }) });
				};
				try {
					fr.readAsDataURL(f);
				} catch {
					readFailed();
				}
			}
		},
		[panelSend, onNotice, t, WS_UPLOAD_MAX_BYTES],
	);

	const fileMenuRef = useRef<FileMenuCtx | null>(null);
	const [transfer, setTransfer] = useState<FileTransferRequest | null>(null);
	const fileInput = useRef<HTMLInputElement>(null);

	const openAsProject = useCallback(() => {
		const p = fileMenuRef.current?.project;
		if (p) panelSend({ type: "set_cwd", path: p.path });
	}, [panelSend]);

	const pickFiles = useCallback(() => {
		if (fileInput.current) fileInput.current.value = "";
		fileInput.current?.click();
	}, []);

	const [clipboard, setClipboard] = useState<{ src: string; cut: boolean } | null>(null);
	const [renamingPath, setRenamingPath] = useState<string | null>(null);
	const [renameDraft, setRenameDraft] = useState("");
	const [creating, setCreating] = useState<{ dir: string; kind: "file" | "dir" } | null>(null);
	const [createDraft, setCreateDraft] = useState("");

	const downloadEntry = useCallback(
		(path: string, name: string) => {
			void downloadFile(path, name).then((r) => {
				if (r.ok || r.cancelled) return;
				onNotice(
					"error",
					t("downloadFailed", {
						error: r.error === DOWNLOAD_FILE_NOT_FOUND ? t("fileNotFoundShort") : r.error,
					}),
				);
			});
		},
		[onNotice, t],
	);

	const startRename = useCallback(() => {
		const tg = fileMenuRef.current?.target;
		if (!tg || tg.kind === "list" || isProtectedRoot(tg.id)) return;
		setCreating(null);
		setRenameDraft(tg.label);
		setRenamingPath(tg.id);
	}, []);

	const submitRename = useCallback(() => {
		if (!renamingPath) return;
		const name = renameDraft.trim();
		setRenamingPath(null);
		if (name) panelSend({ type: "file_rename", path: renamingPath, newName: name });
	}, [renamingPath, renameDraft, panelSend]);

	const startCreate = useCallback(
		(kind: "file" | "dir") => {
			const dir = fileMenuRef.current?.dir ?? currentPath;
			setRenamingPath(null);
			setCreateDraft("");
			setCreating({ dir, kind });
		},
		[currentPath],
	);

	const submitCreate = useCallback(() => {
		if (!creating) return;
		const name = createDraft.trim();
		setCreating(null);
		if (name) panelSend({ type: "file_create", dir: creating.dir, name, kind: creating.kind });
	}, [creating, createDraft, panelSend]);

	const renderNameInput = (
		value: string,
		setValue: (v: string) => void,
		onSubmit: () => void,
		onCancel: () => void,
	) => (
		<input
			autoFocus
			className="session-rename-input"
			value={value}
			placeholder={t("fileNamePlaceholder")}
			onClick={(ev) => ev.stopPropagation()}
			onChange={(ev) => setValue(ev.target.value)}
			onKeyDown={(ev) => {
				ev.stopPropagation();
				if (ev.key === "Enter" && !ev.nativeEvent.isComposing) onSubmit();
				else if (ev.key === "Escape") onCancel();
			}}
			onBlur={onCancel}
		/>
	);

	const deleteTarget = useCallback(() => {
		const tg = fileMenuRef.current?.target;
		if (!tg || tg.kind === "list" || isProtectedRoot(tg.id)) return;
		if (!window.confirm(t("fileDeleteConfirm", { name: tg.label }))) return;
		if (clipboard?.src === tg.id) setClipboard(null);
		if (renamingPath === tg.id) setRenamingPath(null);
		panelSend({ type: "file_delete", path: tg.id });
	}, [panelSend, t, clipboard, renamingPath]);

	const duplicateTarget = useCallback(() => {
		const tg = fileMenuRef.current?.target;
		if (!tg || tg.kind === "list" || isProtectedRoot(tg.id)) return;
		panelSend({ type: "file_copy", src: tg.id, destDir: parentWireOf(tg.id) });
	}, [panelSend]);

	const markClipboard = useCallback((cut: boolean) => {
		const tg = fileMenuRef.current?.target;
		if (!tg || tg.kind === "list" || isProtectedRoot(tg.id)) return;
		setClipboard({ src: tg.id, cut });
	}, []);

	const pasteClipboard = useCallback(() => {
		if (!clipboard) return;
		const destDir = fileMenuRef.current?.dir ?? currentPath;
		if (clipboard.cut) {
			panelSend({ type: "file_copy", src: clipboard.src, destDir, move: true });
			setClipboard(null);
		} else {
			panelSend({ type: "file_copy", src: clipboard.src, destDir });
		}
	}, [clipboard, panelSend, currentPath]);

	const refreshList = useCallback(() => {
		panelSend({ type: "list_files", path: currentPath === "" ? undefined : currentPath });
	}, [panelSend, currentPath]);

	const [rootsOpen, setRootsOpen] = useState(false);
	useEffect(() => {
		if (!rootsOpen) return;
		const onDown = (e: MouseEvent) => {
			if ((e.target as Element | null)?.closest(".root-picker")) return;
			setRootsOpen(false);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setRootsOpen(false);
		};
		window.addEventListener("mousedown", onDown, true);
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("mousedown", onDown, true);
			window.removeEventListener("keydown", onKey);
		};
	}, [rootsOpen]);

	const setRoots = useCallback(
		(next: string[]) => {
			panelSend({ type: "set_workspace_roots", roots: next });
		},
		[panelSend],
	);

	const addWorkspaceRoot = useCallback(() => {
		const dir = fileMenuRef.current?.target;
		if (!dir || dir.kind !== "dir") return;
		const abs = toProjectPath(dir.id);
		if (!abs || workspaceRoots.includes(abs)) return;
		setRoots([...workspaceRoots, abs]);
	}, [workspaceRoots, toProjectPath, setRoots]);

	const uploadPicked = useCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			uploadFilesTo(fileMenuRef.current?.dir ?? currentPath, Array.from(e.target.files ?? []));
		},
		[uploadFilesTo, currentPath],
	);

	const dispatchHostFileEntry = useCallback(
		(entry: UiSlotEntry) => {
			const tg = fileMenuRef.current?.target;
			switch (entry.id) {
				case "host:file-compress":
				case "host:file-extract":
				case "host:file-compress-download":
				case "host:file-upload-folder": {
					if (!tg) break;
					const action =
						entry.id === "host:file-compress"
							? "compress"
							: entry.id === "host:file-extract"
								? "extract"
								: entry.id === "host:file-compress-download"
									? "download"
									: "upload";
					setTransfer({
						action,
						path: transferAbsPathOf(tg.id),
						dir: transferAbsPathOf(
							action === "upload" ? (fileMenuRef.current?.dir ?? currentPath) : parentWireOf(tg.id),
						),
					});
					break;
				}
				case "host:file-open-project":
					openAsProject();
					break;
				case "host:file-upload":
					pickFiles();
					break;
				case "host:file-add-root":
					addWorkspaceRoot();
					break;
				case "host:file-open":
					if (tg?.kind === "file") onPreview(tg.id, tg.label);
					break;
				case "host:file-enter":
					if (tg?.kind === "dir") openDir(tg.id);
					break;
				case "host:file-download":
					if (tg?.kind === "file") downloadEntry(tg.id, tg.label);
					break;
				case "host:file-reveal":
					if (tg) panelSend({ type: "file_reveal", path: tg.id });
					break;
				case "host:file-open-default":
					if (tg?.kind === "file") panelSend({ type: "file_open_default", path: tg.id });
					break;
				case "host:file-attach-ref":
					if (tg?.kind === "file") onAttach(tg.id, tg.label, "reference");
					break;
				case "host:file-attach-folder":
					if (tg?.kind === "dir") onAttach(tg.id, tg.label, "reference", true);
					break;
				case "host:file-new-file":
					startCreate("file");
					break;
				case "host:file-new-dir":
					startCreate("dir");
					break;
				case "host:file-paste":
					pasteClipboard();
					break;
				case "host:file-rename":
					startRename();
					break;
				case "host:file-duplicate":
					duplicateTarget();
					break;
				case "host:file-cut":
					markClipboard(true);
					break;
				case "host:file-copy":
					markClipboard(false);
					break;
				case "host:file-copy-name":
					if (tg && tg.kind !== "list") copyText(tg.label, `name:${tg.id}`);
					break;
				case "host:file-copy-path":
					if (tg && tg.kind !== "list") copyText(absPathOf(tg.id), `path:${tg.id}`);
					break;
				case "host:file-copy-rel":
					if (tg && tg.kind !== "list") copyText(tg.id, `rel:${tg.id}`);
					break;
				case "host:file-refresh":
					refreshList();
					break;
				case "host:file-delete":
					deleteTarget();
					break;
			}
		},
		[
			openAsProject,
			currentPath,
			pickFiles,
			addWorkspaceRoot,
			onPreview,
			onAttach,
			copyText,
			absPathOf,
			downloadEntry,
			startCreate,
			pasteClipboard,
			startRename,
			duplicateTarget,
			markClipboard,
			refreshList,
			deleteTarget,
		],
	);

	const openFileMenu = useCallback(
		(e: React.MouseEvent, target: FileMenuCtx["target"]) => {
			const projectPath = target.kind === "dir" ? toProjectPath(target.id) : null;
			const ctx: FileMenuCtx = {
				target,
				dir: target.kind === "dir" ? target.id : currentPath,
				project: projectPath ? { path: projectPath, name: target.label } : null,
			};
			const kind = target.kind;
			const isFile = kind === "file";
			const isDir = kind === "dir";
			const isList = kind === "list";
			const protectedRoot = !isList && isProtectedRoot(target.id);
			const absolute = !isList && isAbsoluteWire(target.id);
			const onMachineRoot = currentPath === MACHINE_ROOT;
			const reference: QuickAskReferenceSource | undefined =
				!isList && target.id !== MACHINE_ROOT && (cwd || absolute)
					? { kind: isDir ? "directory" : "file", path: absPathOf(target.id), cwd }
					: undefined;
			const entries = (uiContextFile ?? []).map((entry) => {
				if (entry.source !== "host") return entry;
				switch (entry.id) {
					case "host:file-quick-ask":
						return quickAskReferenceMenus && reference ? entry : { ...entry, hidden: true };
					case "host:file-upload-folder":
						return !onMachineRoot ? entry : { ...entry, hidden: true };
					case "host:file-compress":
					case "host:file-compress-download":
						return !isList && !protectedRoot ? entry : { ...entry, hidden: true };
					case "host:file-extract":
						return isFile && isExtractableArchive(target.label) ? entry : { ...entry, hidden: true };
					case "host:file-upload":
						if (onMachineRoot) return { ...entry, hidden: true };
						return { ...entry, label: ctx.dir === currentPath ? t("uploadToCurrentDir") : t("uploadToFolder") };
					case "host:file-open-project":
						return projectPath ? entry : { ...entry, hidden: true };
					case "host:file-add-root": {
						const addable = Boolean(projectPath) && projectPath !== cwd && !workspaceRoots.includes(projectPath!);
						return addable ? entry : { ...entry, hidden: true };
					}
					case "host:file-open":
					case "host:file-download":
					case "host:file-open-default":
					case "host:file-attach-ref":
						return isFile ? entry : { ...entry, hidden: true };
					case "host:file-reveal":
						return !onMachineRoot && target.id !== MACHINE_ROOT ? entry : { ...entry, hidden: true };
					case "host:file-enter":
					case "host:file-attach-folder":
						return isDir ? entry : { ...entry, hidden: true };
					case "host:file-new-file":
					case "host:file-new-dir":
						return !isFile && !onMachineRoot ? entry : { ...entry, hidden: true };
					case "host:file-paste":
						return !isFile && !onMachineRoot && clipboard ? entry : { ...entry, hidden: true };
					case "host:file-rename":
					case "host:file-duplicate":
					case "host:file-cut":
					case "host:file-copy":
					case "host:file-delete":
						return !isList && !protectedRoot ? entry : { ...entry, hidden: true };
					case "host:file-copy-name":
					case "host:file-copy-path":
						return !isList ? entry : { ...entry, hidden: true };
					case "host:file-copy-rel":
						return !isList && !absolute ? entry : { ...entry, hidden: true };
					case "host:file-refresh":
						return isList ? entry : { ...entry, hidden: true };
					default:
						return entry;
				}
			});
			if (contextMenuItems(entries).length === 0) return;
			e.preventDefault();
			e.stopPropagation();
			fileMenuRef.current = ctx;
			openContextMenu({
				x: e.clientX,
				y: e.clientY,
				slot: "contextmenu.file",
				target,
				entries,
				onHostAction: (entry) => {
					if (entry.id === "host:file-quick-ask") {
						if (reference) openQuickAsk({ reference });
						return;
					}
					dispatchHostFileEntry(entry);
				},
			});
		},
		[
			uiContextFile,
			quickAskReferenceMenus,
			currentPath,
			toProjectPath,
			absPathOf,
			t,
			dispatchHostFileEntry,
			cwd,
			workspaceRoots,
			clipboard,
		],
	);

	const isFileDrag = (e: React.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");

	const clearDropHl = useCallback(() => {
		bodyRef.current?.querySelectorAll(".file-item.drop-target").forEach((el) => el.classList.remove("drop-target"));
		bodyRef.current?.classList.remove("drop-root");
	}, []);

	const setDropHl = useCallback(
		(dir: string | null) => {
			clearDropHl();
			if (dir == null) return;
			const row = bodyRef.current?.querySelector(`.file-item[data-path="${CSS.escape(dir)}"]`);
			if (row) row.classList.add("drop-target");
			else bodyRef.current?.classList.add("drop-root");
		},
		[clearDropHl],
	);

	const dropDirFor = (target: EventTarget | null): string => {
		const el = target instanceof Element ? (target.closest(".file-item") as HTMLElement | null) : null;
		if (el?.dataset.type === "dir") return el.dataset.path ?? currentPath;
		return currentPath;
	};

	const clearAppDrop = useCallback(() => {
		const appEl = document.querySelector(".app");
		if (appEl) appEl.dispatchEvent(new DragEvent("dragleave", { bubbles: true }));
	}, []);

	const AUTO_REFRESH_MS = 10_000;

	const reqSeq = useRef(0);

	const lastCwd = useRef<string | undefined>(undefined);

	const request = useCallback(
		(path: string, opts?: { silent?: boolean }) => {
			const seq = ++reqSeq.current;
			setCurrentPath(path);
			if (!opts?.silent) setLoading(true);
			const ok = panelSend({
				type: "list_files",
				path: path === "" ? undefined : path,
			});
			if (!ok) {
				if (reqSeq.current === seq) setLoading(false);
			}
		},
		[panelSend],
	);

	const removeWorkspaceRoot = useCallback(
		(root: string) => {
			const next = workspaceRoots.filter((x) => x !== root);
			setRoots(next);
			if (currentPath === root || currentPath.startsWith(`${root}/`)) request("");
		},
		[workspaceRoots, setRoots, currentPath, request],
	);

	useEffect(() => {
		if (files && files.path === currentPath) setLoading(false);
	}, [files, currentPath]);

	useEffect(() => {
		if (cwd !== lastCwd.current) {
			const isInitialMount = lastCwd.current === undefined;
			lastCwd.current = cwd;
			if (isInitialMount) {
				request("", { silent: true });
			} else {
				setCurrentPath("");
			}
			return;
		}
		const timer = setInterval(() => {
			if (document.visibilityState === "hidden") return;
			request(currentPath, { silent: true });
		}, AUTO_REFRESH_MS);
		return () => clearInterval(timer);
	}, [cwd, currentPath, request]);
	useEffect(() => {
		if (fileChanged && fileChanged.path === currentPath) request(currentPath, { silent: true });
	}, [fileChanged, currentPath, request]);

	const openDir = (path: string) => request(path);
	const goUp = () => {
		if (files?.parent !== null && files?.parent !== undefined) {
			request(files.parent);
		}
	};

	const crumbs = (() => {
		if (currentPath === "" || currentPath === MACHINE_ROOT) return [];
		const parts = currentPath.split("/").filter((c) => Boolean(c) && c !== MACHINE_ROOT);
		if (currentPath.startsWith("/")) {
			return [
				{ label: "/", path: "/" },
				...parts.map((p, i) => ({
					label: p,
					path: "/" + parts.slice(0, i + 1).join("/"),
				})),
			];
		}
		return parts.map((_p, i) => ({ label: parts[i], path: parts.slice(0, i + 1).join("/") }));
	})();

	const pluginTabs: SlotTab[] = [];
	for (const entry of uiRightPanelTabs ?? []) {
		if (entry.source === "host" || entry.hidden || entry.kind === "divider") continue;
		const plugin = pluginList.find((p) => p.id === entry.source.slice("plugin:".length));
		if (!plugin) continue;
		pluginTabs.push({
			id: entry.id,
			label: entry.label,
			icon: entry.icon,
			...(entry.iconSvg ? { iconSvg: entry.iconSvg } : {}),
			hint: entry.hint,
			pluginPage: { plugin, entry },
		});
	}

	const filesTabHidden = (uiRightPanelTabs ?? []).some((e) => e.id === "host:right-files" && e.hidden);
	const orderTabs = (tabs: SlotTab[]): SlotTab[] => {
		const visible = (uiRightPanelTabs ?? []).filter((e) => !e.hidden);
		if (visible.length === 0) return tabs;
		const rank = new Map(visible.map((e, i) => [e.id, i] as const));
		const key = (id: string) => rank.get(id === FILES_TAB_ID ? "host:right-files" : id) ?? 1e9;
		return [...tabs].sort((a, b) => key(a.id) - key(b.id));
	};

	return (
		<aside className="panel panel-right" ref={panelRef}>
			{collapsible && onToggleCollapse && (
				<button type="button" className="panel-collapse-btn" title={t("collapsePanel")} onClick={onToggleCollapse}>
					<FiChevronRight />
				</button>
			)}
			<div
				ref={splitRef}
				style={{
					display: "flex",
					flexDirection: "column",
					flex: hasWidgets ? `${rpWeights.files} 1 0` : "1 1 0",
					minHeight: hasWidgets ? RP_MIN_FILES_PX : 0,
				}}
			>
				<SlotTabs
					storageKey="rightpanel"
					epoch={pluginsEpoch ?? 0}
					send={send ?? NOOP_SEND}
					tabs={orderTabs([
						...(filesTabHidden
							? []
							: [
									{
										id: FILES_TAB_ID,
										label: t("openFiles"),
										element: (
											<>
												<div className="panel-crumbs">
													<button
														type="button"
														className={`crumb ${currentPath === "" ? "active" : ""}`}
														onClick={() => request("")}
													>
														{t("rootDir")}
													</button>
													<TipButton
														className={`crumb ${currentPath === MACHINE_ROOT ? "active" : ""}`}
														tip={t("computer")}
														onClick={() => request(MACHINE_ROOT)}
													>
														<FiHardDrive />
													</TipButton>
													{homeDir !== "" && (
														<TipButton
															className={`crumb ${currentPath === homeDir || currentPath.startsWith(`${homeDir}/`) ? "active" : ""}`}
															tip={t("homeDir")}
															onClick={() => request(homeDir)}
														>
															<FiHome />
														</TipButton>
													)}
													{desktopDir !== "" && (
														<TipButton
															className={`crumb ${currentPath === desktopDir || currentPath.startsWith(`${desktopDir}/`) ? "active" : ""}`}
															tip={t("desktopDir")}
															onClick={() => request(desktopDir)}
														>
															<FiMonitor />
														</TipButton>
													)}
													<TipButton
														className={`crumb ${showHiddenFiles ? "active" : ""}`}
														tip={showHiddenFiles ? t("filesHideHidden") : t("filesShowHidden")}
														aria-pressed={showHiddenFiles}
														onClick={() => setShowHiddenFiles((v) => !v)}
													>
														{showHiddenFiles ? <FiEye /> : <FiEyeOff />}
													</TipButton>
													<HintTip text={t("filesHelp")} />
													{workspaceRoots.length > 0 && (
														<div className="root-picker">
															<button
																type="button"
																className="crumb root-picker-trigger"
																aria-haspopup="menu"
																aria-expanded={rootsOpen}
																title={t("workspaceRoots")}
																onClick={() => setRootsOpen((v) => !v)}
															>
																<FiFolder />
																<span className="root-picker-label">{t("workspaceRoots")}</span>
																<span className="set-count">{workspaceRoots.length + 1}</span>▾
															</button>
															{rootsOpen && (
																<div className="root-picker-menu" role="menu">
																	<div className="root-picker-row">
																		<button
																			type="button"
																			role="menuitem"
																			className={currentPath === "" ? "root-picker-item active" : "root-picker-item"}
																			title={cwd}
																			onClick={() => {
																				setRootsOpen(false);
																				request("");
																			}}
																		>
																			{t("rootDir")}
																			<span className="root-picker-path">{cwd}</span>
																		</button>
																	</div>
																	{workspaceRoots.map((r) => (
																		<div className="root-picker-row" key={r}>
																			<button
																				type="button"
																				role="menuitem"
																				className={currentPath === r ? "root-picker-item active" : "root-picker-item"}
																				title={r}
																				onClick={() => {
																					setRootsOpen(false);
																					request(r);
																				}}
																			>
																				<span className="root-picker-path">{r}</span>
																			</button>
																			<button
																				type="button"
																				className="root-picker-remove"
																				title={t("removeWorkspaceRoot")}
																				aria-label={t("removeWorkspaceRoot")}
																				onClick={() => removeWorkspaceRoot(r)}
																			>
																				<FiX />
																			</button>
																		</div>
																	))}
																	<div className="root-picker-hint">{t("workspaceRootsHint")}</div>
																</div>
															)}
														</div>
													)}
													{crumbs.map((c) => (
														<span key={c.path} className="crumb-seg">
															<FiChevronRight />
															<button
																type="button"
																className={`crumb ${c.path === currentPath ? "active" : ""}`}
																onClick={() => request(c.path)}
															>
																{c.label}
															</button>
														</span>
													))}
												</div>
												<div
													ref={attachBody}
													className="panel-body"
													onScroll={(e) => {
														bodyScrollRef.current = e.currentTarget.scrollTop;
													}}
													onContextMenu={(e) =>
														openFileMenu(e, {
															id: currentPath,
															kind: "list",
															label:
																currentPath === ""
																	? t("rootDir")
																	: currentPath === MACHINE_ROOT
																		? t("computer")
																		: currentPath,
														})
													}
													onDragOver={(e) => {
														if (!isFileDrag(e)) return;
														e.preventDefault();
														e.stopPropagation();
														e.dataTransfer.dropEffect = "copy";
														clearAppDrop();
														setDropHl(dropDirFor(e.target));
													}}
													onDragLeave={(e) => {
														if (e.relatedTarget && e.currentTarget.contains(e.relatedTarget as Node)) return;
														clearDropHl();
													}}
													onDrop={(e) => {
														clearDropHl();
														if (!isFileDrag(e)) return;
														e.preventDefault();
														e.stopPropagation();
														clearAppDrop();
														const files = Array.from(e.dataTransfer?.files ?? []);
														if (files.length === 0) {
															onNotice("warning", t("foldersNotSupported"));
															return;
														}
														uploadFilesTo(dropDirFor(e.target), files);
													}}
													onDragEnd={clearDropHl}
												>
													<input ref={fileInput} type="file" multiple hidden onChange={uploadPicked} />
													{fileUploads.length > 0 && (
														<div style={{ minWidth: 0, maxWidth: "100%", padding: "4px 8px" }}>
															{fileUploads.map((upload) => {
																const status =
																	upload.phase === "reading"
																		? t("fileUploadReading", { name: upload.name, percent: upload.percent })
																		: upload.phase === "waiting"
																			? t("fileUploadWaiting", { name: upload.name })
																			: upload.phase === "success"
																				? t("fileUploadConfirmed")
																				: upload.phase === "unknown"
																					? t("fileUploadOutcomeUnknown")
																					: t("fileUploadFailed", { error: upload.error || upload.name });
																return (
																	<div
																		key={upload.id}
																		style={{ minWidth: 0, maxWidth: "100%", padding: "3px 0", fontSize: 12 }}
																	>
																		<div
																			style={{
																				display: "flex",
																				alignItems: "center",
																				gap: 4,
																				minWidth: 0,
																				maxWidth: "100%",
																			}}
																		>
																			<span
																				title={`${upload.dir}/${upload.name}`}
																				style={{
																					minWidth: 0,
																					overflow: "hidden",
																					textOverflow: "ellipsis",
																					whiteSpace: "nowrap",
																					flex: 1,
																				}}
																			>
																				{upload.name}
																			</span>
																			{upload.phase !== "reading" && (
																				<button
																					type="button"
																					className="btn"
																					aria-label={`${t("fileUploadDismiss")}: ${upload.name}`}
																					title={t("fileUploadDismiss")}
																					onClick={() =>
																						setFileUploads((rows) => rows.filter((row) => row.id !== upload.id))
																					}
																					style={{ flex: "none", padding: 2 }}
																				>
																					<FiX aria-hidden="true" />
																				</button>
																			)}
																		</div>
																		{upload.phase === "reading" && (
																			<progress
																				max={100}
																				value={upload.percent}
																				aria-label={t("fileUploadReading", {
																					name: upload.name,
																					percent: upload.percent,
																				})}
																				style={{ width: "100%", height: 4, display: "block" }}
																			/>
																		)}
																		<div
																			role="status"
																			aria-live="polite"
																			aria-atomic="true"
																			style={{
																				overflowWrap: "anywhere",
																				wordBreak: "break-word",
																				color: upload.phase === "error" ? "var(--err-text)" : "var(--text-dim)",
																			}}
																		>
																			{status}
																		</div>
																	</div>
																);
															})}
														</div>
													)}
													{transfer && (
														<FileTransferDialog
															request={transfer}
															onClose={() => setTransfer(null)}
															onComplete={refreshList}
														/>
													)}
													{creating && (
														<div className="file-item dir">
															{creating.kind === "dir" ? (
																<FiFolder className="file-icon" />
															) : (
																<FiFile className="file-icon" />
															)}
															{renderNameInput(createDraft, setCreateDraft, submitCreate, () => setCreating(null))}
														</div>
													)}
													{loading && <div className="panel-empty">{t("loading")}</div>}
													{!loading && files && files.path === currentPath && (
														<>
															{files.parent != null && (
																<button type="button" className="file-item dir" onClick={goUp}>
																	<FiFolder className="file-icon" />
																	<span className="file-name">..</span>
																</button>
															)}
															{visibleTreeEntries(files.entries, showHiddenFiles).map((e) =>
																e.type === "dir" ? (
																	<div
																		key={e.path}
																		className={`file-item dir${clipboard?.cut && clipboard.src === e.path ? " cut" : ""}`}
																		data-type="dir"
																		data-path={e.path}
																		onClick={(ev) => {
																			if (renamingPath === e.path) return;
																			if ((ev.target as HTMLElement).closest(".file-attach")) return;
																			openDir(e.path);
																		}}
																		onContextMenu={(ev) => openFileMenu(ev, { id: e.path, kind: "dir", label: e.name })}
																	>
																		{renamingPath === e.path ? (
																			renderNameInput(renameDraft, setRenameDraft, submitRename, () =>
																				setRenamingPath(null),
																			)
																		) : (
																			<button
																				type="button"
																				className="file-dir-main"
																				onClick={(ev) => {
																					ev.stopPropagation();
																					openDir(e.path);
																				}}
																			>
																				<FiFolder className="file-icon" />
																				<span className="file-name">{e.name}</span>
																			</button>
																		)}
																		<button
																			type="button"
																			className="file-attach ref"
																			data-tip={t("linkFolderTip")}
																			aria-label={t("linkFolderTip")}
																			onClick={(ev) => {
																				ev.stopPropagation();
																				onAttach(e.path, e.name, "reference", true);
																			}}
																		>
																			<FiLink />
																		</button>
																		<button
																			type="button"
																			className={`file-attach copy${copiedKey === `name:${e.path}` ? " copied" : ""}`}
																			data-tip={t("copyName")}
																			aria-label={t("copyName")}
																			onClick={(ev) => {
																				ev.stopPropagation();
																				copyText(e.name, `name:${e.path}`);
																			}}
																		>
																			{copiedKey === `name:${e.path}` ? <FiCheck /> : <FiCopy />}
																		</button>
																		<button
																			type="button"
																			className={`file-attach copy${copiedKey === `path:${e.path}` ? " copied" : ""}`}
																			data-tip={t("copyPath")}
																			aria-label={t("copyPath")}
																			onClick={(ev) => {
																				ev.stopPropagation();
																				copyText(absPathOf(e.path), `path:${e.path}`);
																			}}
																		>
																			{copiedKey === `path:${e.path}` ? <FiCheck /> : <FiClipboard />}
																		</button>
																	</div>
																) : (
																	<div
																		key={e.path}
																		className={`file-item file${clipboard?.cut && clipboard.src === e.path ? " cut" : ""}`}
																		data-type="file"
																		data-path={e.path}
																		onClick={(ev) => {
																			if (renamingPath === e.path) return;
																			if ((ev.target as HTMLElement).closest(".file-attach")) return;
																			onPreview(e.path, e.name);
																		}}
																		onContextMenu={(ev) =>
																			openFileMenu(ev, { id: e.path, kind: "file", label: e.name })
																		}
																	>
																		{renamingPath === e.path ? (
																			renderNameInput(renameDraft, setRenameDraft, submitRename, () =>
																				setRenamingPath(null),
																			)
																		) : (
																			<button
																				type="button"
																				className="file-name"
																				title={`${e.path} — ${t("previewFile")}`}
																				onClick={(ev) => {
																					ev.stopPropagation();
																					onPreview(e.path, e.name);
																				}}
																			>
																				<FiFile className="file-icon" />
																				<span className="file-name-text">{e.name}</span>
																			</button>
																		)}
																		<button
																			type="button"
																			className="file-attach download"
																			data-tip={t("downloadFile")}
																			onClick={(ev) => {
																				ev.stopPropagation();
																				downloadEntry(e.path, e.name);
																			}}
																		>
																			<FiDownload />
																		</button>
																		<button
																			type="button"
																			className="file-attach ref"
																			data-tip={t("referenceTip")}
																			aria-label={t("referenceTip")}
																			onClick={(ev) => {
																				ev.stopPropagation();
																				onAttach(e.path, e.name, "reference");
																			}}
																		>
																			<FiLink />
																		</button>
																		<button
																			type="button"
																			className={`file-attach copy${copiedKey === `name:${e.path}` ? " copied" : ""}`}
																			data-tip={t("copyName")}
																			aria-label={t("copyName")}
																			onClick={(ev) => {
																				ev.stopPropagation();
																				copyText(e.name, `name:${e.path}`);
																			}}
																		>
																			{copiedKey === `name:${e.path}` ? <FiCheck /> : <FiCopy />}
																		</button>
																		<button
																			type="button"
																			className={`file-attach copy${copiedKey === `path:${e.path}` ? " copied" : ""}`}
																			data-tip={t("copyPath")}
																			aria-label={t("copyPath")}
																			onClick={(ev) => {
																				ev.stopPropagation();
																				copyText(absPathOf(e.path), `path:${e.path}`);
																			}}
																		>
																			{copiedKey === `path:${e.path}` ? <FiCheck /> : <FiClipboard />}
																		</button>
																	</div>
																),
															)}
															{files.truncated && (
																<div className="panel-empty files-truncated">{t("filesTruncated")}</div>
															)}
														</>
													)}
													{!loading && !files && <div className="panel-empty">{t("noFiles")}</div>}
												</div>
											</>
										),
									},
								]),
						...pluginTabs,
					])}
				/>
			</div>
			{hasWidgets && (
				<div
					className="rp-sash"
					onPointerDown={onSashDown}
					onDoubleClick={() => setRpWeights({ ...DEFAULT_RP_WEIGHTS })}
					title={t("dragToResize")}
				/>
			)}
			{hasWidgets && (
				<div className="panel-widgets" style={{ flexGrow: rpWeights.widgets, minHeight: RP_MIN_WIDGETS_PX }}>
					{widgets
						.filter((w) => w.lines.length > 0)
						.map((w) => (
							<div key={w.key} className="widget">
								<button
									type="button"
									className="widget-title widget-title-btn"
									title={t("widgetExpand")}
									onClick={() => setExpandedWidget(w.key)}
								>
									<span>{w.key}</span>
									<FiMaximize2 />
								</button>
								<pre className="widget-lines">{w.lines.join("\n")}</pre>
							</div>
						))}
				</div>
			)}
			{expandedWidget &&
				(() => {
					const w = widgets.find((x) => x.key === expandedWidget);
					if (!w) return null;
					return (
						<div className="modal-backdrop" onClick={() => setExpandedWidget(null)}>
							<div className="widget-expand" onClick={(e) => e.stopPropagation()}>
								<div className="widget-expand-head">
									<span className="widget-expand-title">{w.key}</span>
									<button type="button" className="btn" title={t("close")} onClick={() => setExpandedWidget(null)}>
										<FiX />
									</button>
								</div>
								<pre className="widget-expand-lines">{w.lines.join("\n")}</pre>
							</div>
						</div>
					);
				})()}
		</aside>
	);
});
