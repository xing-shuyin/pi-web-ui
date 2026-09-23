import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
	FiCheck,
	FiChevronRight,
	FiChevronsRight,
	FiClipboard,
	FiCopy,
	FiDownload,
	FiFile,
	FiFolder,
	FiLink,
	FiMaximize2,
	FiPlus,
	FiX,
} from "react-icons/fi";
import type { ClientMessage, FileListing, UiPluginInfo } from "../types";
import { useT } from "../i18n";
import { useAppField } from "../app-globals";
import { downloadFile, DOWNLOAD_FILE_NOT_FOUND } from "../download";
import { HintTip } from "./HintTip";
import { FileTransferDialog, type FileTransferRequest } from "./FileTransferDialog";
import { isExtractableArchive } from "../file-transfer";
import { applySashDrag, parseWeights } from "../panel-sash";
// 宿主 UI 扩展点（issue #146）：右栏的 tab 条与文件右键菜单都走「slot 条目」这一条通道。
import type { UiSlotEntry } from "../ui-slots";
import { contextMenuItems, openContextMenu } from "../context-menu-state";
import { SlotTabs, type SlotTab } from "./SlotTabs";

/** 机器根（此电脑/盘符列表）wire 字面量 —— 与 server/files-service.ts 的 MACHINE_ROOT 同值。 */
const MACHINE_ROOT = "@root";

/** 右栏纵向分割（文件区 ↔ widgets）的默认权重与最小高度 —— 与左栏同一套权重模型。 */
const LS_RP_SIZES = "pi-web-ui:rp-sizes";
type RpWeights = { files: number; widgets: number };
const DEFAULT_RP_WEIGHTS: RpWeights = { files: 4, widgets: 1 };
const RP_MIN_FILES_PX = 120;
const RP_MIN_WIDGETS_PX = 56;

/** 分割区上边界相对面板顶部的偏移（px）：拖动时换算「可用高度」用。
 *  旧实现用面包屑高度硬推，加了 tab 条之后不再成立（tab 条也在文件区之上）——
 *  改成实测分割容器相对面板顶部的偏移，文件 tab / 插件 tab 激活时都正确。
 *  测不到元素（极端时序）时退回 32px 的老近似值：宁可差几像素，也不要算出 NaN。 */
function splitTopPx(panel: HTMLElement, split: HTMLElement | null): number {
	if (!split) return 32;
	return Math.max(0, split.getBoundingClientRect().top - panel.getBoundingClientRect().top);
}

type AttachMode = "inline" | "reference";

/** 打开 `contextmenu.file` 菜单时记下的「右键上下文」（见下面的 fileMenuRef）。
 *  菜单本体在 App 里渲染，点击回到本组件时，只有这份记录知道该操作谁。 */
interface FileMenuCtx {
	/** 右键的对象：kind="dir" 目录行 / "file" 文件行 / "list" 列表空白处。 */
	target: { id: string; kind: "file" | "dir" | "list"; label: string };
	/** 上传落点目录：目录行 = 该目录；文件行 / 列表空白 = 当前列出的目录。 */
	dir: string;
	/** 「以项目打开」的目标（机器根 / 工作区根不可作项目 → null → 条目不显示）。 */
	project: { path: string; name: string } | null;
}

/** 内置「文件」tab 的 tab id（SlotTabs 拿它做 localStorage 选中态 key）。
 *  刻意不带冒号：插件 tab 的 id 是 `<pluginId>:<itemId>`、一定含冒号，两者永不撞车。 */
const FILES_TAB_ID = "files";

/** 未接线时的稳定回退（空插件清单 / 空发送器）：避免每次渲染新建引用喂给下游比较。 */
const EMPTY_PLUGINS: UiPluginInfo[] = [];
const NOOP_SEND = (): void => {};

/** wire 路径的父目录（与服务端 wireParent 同口径，供「创建副本」算落点目录）。 */
function parentWireOf(p: string): string {
	const w = p.endsWith("/") && p !== "/" ? p.slice(0, -1) : p;
	const i = w.lastIndexOf("/");
	if (i < 0) return "";
	if (i === 0) return "/";
	return w.slice(0, i);
}

/** 机器根 / 盘符根 / posix 根：只能在里面新建，不可重命名/删除/复制/剪切的对象。 */
function isProtectedRoot(p: string): boolean {
	return p === MACHINE_ROOT || p === "/" || /^[A-Za-z]:$/.test(p);
}

/** 绝对 wire 路径（机器浏览）：工作区相对路径那套逻辑（复制相对路径）不适用。 */
function isAbsoluteWire(p: string): boolean {
	return p.startsWith("/") || /^[A-Za-z]:([/]|$)/.test(p);
}

/** Props are deliberately NARROW (no whole-ChatState object): every field is
 *  stable while tokens stream in, so the shallow-compared memo() below skips
 *  re-reconciling the file tree on every delta. */
interface RightPanelProps {
	files: FileListing | null;
	/** Last dir-changed push (path = listed directory) — triggers a refresh. */
	fileChanged: { path: string } | null;
	widgets: { key: string; lines: string[] }[];
	panelSend: (msg: ClientMessage) => boolean;
	/** Called when the user clicks an attach button on a file or folder. */
	onAttach: (path: string, name: string, mode: AttachMode, isDir?: boolean) => void;
	/** Called when the user clicks a file to open the preview modal. */
	onPreview: (path: string, name: string) => void;
	/** Show a transient toast (download errors etc.). */
	onNotice: (level: "info" | "warning" | "error", text: string) => void;
	/** Desktop: show the collapse button (mobile drawers close via the topbar). */
	collapsible?: boolean;
	/** Fired when the user clicks the collapse button. */
	onToggleCollapse?: () => void;

	// ---- 宿主 UI 扩展点（issue #146）：一律由 App 用 buildUiSlots() 算好后传进来 ----
	/** `rightpanel.tabs` 槽位的最终条目：内置「文件」tab 固定排第一，其后按此顺序排。 */
	uiRightPanelTabs?: UiSlotEntry[];
	/** `contextmenu.file` 槽位的最终条目（host 内置 + 插件贡献）。右栏只负责**打开**菜单
	 *  （openContextMenu），菜单本身由 App 全局渲染；host 条目的实现就在本组件里
	 *  （见 dispatchHostFileEntry），插件条目才交回 App 分发给插件。 */
	uiContextFile?: UiSlotEntry[];
	/** 已安装插件清单：为插件 tab 查 `UiPluginInfo`（UiSlotEntry 里没有插件页信息）。 */
	plugins?: UiPluginInfo[];
	/** 插件重载纪元：透传给 PluginPage，作为客户端 bundle 的缓存击穿参数。 */
	pluginsEpoch?: number;
	/** 插件 tab 内插件上行消息（App 注入；与 PluginPage / PluginView 的 send 同形）。 */
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
	plugins,
	pluginsEpoch,
	send,
}: RightPanelProps) {
	const t = useT();
	/** 插件清单回退：未接线时查找只在空数组里跑，不会抛。 */
	const pluginList = plugins ?? EMPTY_PLUGINS;
	// 当前工作目录：走全局（web/src/app-globals.ts），不再从 App 传。
	const cwd = useAppField("cwd");
	// 额外工作区根（宿主侧多根，见 server/protocol.ts 的 set_workspace_roots）：
	// 也是快照里的值（use-chat 镜像进 app-globals），空数组 = 单根。
	const workspaceRoots = useAppField("workspaceRoots");
	// 用户主目录（快照 UiState.homeDir 的镜像）：空串 = 旧服务不提供 → 🏠 不渲染。
	const homeDir = useAppField("homeDir");
	const desktopDir = useAppField("desktopDir");
	const [currentPath, setCurrentPath] = useState<string>("");
	// 点击放大的 widget（居中浮层展示完整宽度输出）。
	const [expandedWidget, setExpandedWidget] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);

	// ---- 文件区 ↔ widgets 的纵向分割（与左栏 VSCode 风格分割同款：拖动改权重、双击复位） ----
	const panelRef = useRef<HTMLElement>(null);
	/** tab 容器（= 文件树/widgets 分割区的上边界）：拖动时按它算可用高度，见 splitTopPx。 */
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
		} catch {
			// Storage may be disabled; the current in-memory layout remains usable.
		}
	}, [rpWeights]);
	const hasWidgets = widgets.some((w) => w.lines.length > 0);
	const onSashDown = useCallback(
		(e: React.PointerEvent<HTMLDivElement>) => {
			e.preventDefault();
			const panel = panelRef.current;
			if (!panel) return;
			const target = e.currentTarget;
			const startY = e.clientY;
			const start = { above: rpWeights.files, below: rpWeights.widgets };
			// 分割区上方是固定高的头部（tab 条 + 面包屑，都不参与权重）：可用高度扣掉它。
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

	// ---- 文件列表的滚动位置保持 ---------------------------------------
	/** 文件列表容器（`.panel-body`）：拖放落点高亮、下拉目标判定、滚动位置都靠它。
	 *  类型用 `| null` 而不是 `useRef<HTMLDivElement>(null)`：后者在 React 18 的类型里是
	 *  RefObject（current 只读），而这里要交给自己的 ref 回调 attachBody 写回滚动位置。 */
	const bodyRef = useRef<HTMLDivElement | null>(null);
	/** SlotTabs 只挂载当前选中的 tab：切到插件 tab 时整棵文件树会**卸载**，切回来是全新
	 *  DOM（浏览器不会替我们记住 scrollTop）。目录/列表内容这些状态本来就在组件里
	 *  （currentPath / App 传进来的 files），不受卸载影响；只有滚动位置需要自己兜一手：
	 *  滚动时记进 ref，重新挂载时在 ref 回调里还原。 */
	const bodyScrollRef = useRef(0);
	const attachBody = useCallback((el: HTMLDivElement | null) => {
		bodyRef.current = el;
		if (el) el.scrollTop = bodyScrollRef.current;
	}, []);

	// ---- 复制名称 / 复制路径（hover 显示，点后 ✓ 1.2s 回显） ----
	const [copiedKey, setCopiedKey] = useState<string | null>(null);
	const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => {
		// 卸载时清掉回显 timer，避免 setState 落到已卸载组件。
		return () => {
			if (copyTimer.current) clearTimeout(copyTimer.current);
		};
	}, []);

	const markCopied = useCallback((key: string) => {
		setCopiedKey(key);
		if (copyTimer.current) clearTimeout(copyTimer.current);
		copyTimer.current = setTimeout(() => setCopiedKey(null), 1200);
	}, []);

	/** 非安全上下文（http）下 navigator.clipboard 可能缺失，走 textarea 兜底。 */
	const fallbackCopy = (text: string): boolean => {
		try {
			const ta = document.createElement("textarea");
			ta.value = text;
			ta.style.position = "fixed";
			ta.style.opacity = "0";
			document.body.appendChild(ta);
			ta.select();
			const ok = document.execCommand("copy");
			document.body.removeChild(ta);
			return ok;
		} catch {
			return false;
		}
	};

	const copyText = useCallback(
		(text: string, key: string) => {
			if (!text) return;
			const done = () => markCopied(key);
			const fail = () => onNotice("error", t("slashCopyFailed"));
			const nav = navigator as Navigator & { clipboard?: Clipboard };
			if (nav.clipboard?.writeText) {
				void nav.clipboard.writeText(text).then(done, () => {
					if (fallbackCopy(text)) done();
					else fail();
				});
			} else if (fallbackCopy(text)) done();
			else fail();
		},
		[markCopied, onNotice, t],
	);

	/** 复制用的绝对路径：机器浏览已是绝对路径直接用；工作区相对路径拼上 cwd。 */
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

	/** 文件夹行 → set_cwd 可用的绝对路径：机器浏览（绝对 wire 路径）直接用；
	 *  工作区相对路径拼上 cwd；机器根本身不能作项目。 */
	const toProjectPath = useCallback(
		(p: string): string | null => {
			if (!p || p === MACHINE_ROOT) return null;
			if (p.startsWith("/") || /^[A-Za-z]:([/]|$)/.test(p)) return p;
			const root = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
			return `${root}/${p}`;
		},
		[cwd],
	);

	/** 与服务端 files-service.ts 的 MAX_UPLOAD_BYTES 对齐：超限帧到不了 handler，前端先拦给中文提示。 */
	const WS_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;
	/** 把一批 File 上传到指定目录（文件右键菜单的「上传文件」与窗口拖放共用）。 */
	const uploadFilesTo = useCallback(
		(dir: string, files: File[]) => {
			for (const f of files) {
				if (f.size > WS_UPLOAD_MAX_BYTES) {
					onNotice("warning", t("fileTooLarge", { name: f.name, size: WS_UPLOAD_MAX_BYTES / 1024 / 1024 }));
					continue;
				}
				const fr = new FileReader();
				fr.onload = () => {
					const dataUrl = fr.result as string;
					const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
					if (b64) panelSend({ type: "upload_file", dirPath: dir, name: f.name, data: b64 });
				};
				fr.readAsDataURL(f);
			}
		},
		[panelSend, onNotice, t],
	);

	// ---- 文件右键菜单（contextmenu.file 槽位） -------------------------
	/** 打开菜单时记下的右键上下文（= 老实现的 ctxDir / ctxProject 两个 ref 合并成这一份）。
	 *  菜单本体在 App 里渲染（ContextMenu 是全局唯一的那个实例），点击回到本组件时，
	 *  靠它才知道该操作谁。 */
	const fileMenuRef = useRef<FileMenuCtx | null>(null);
	const [transfer, setTransfer] = useState<FileTransferRequest | null>(null);
	/** 隐藏的文件选择器：「上传文件」条目点它，选中的文件落到 fileMenuRef.dir。 */
	const fileInput = useRef<HTMLInputElement>(null);

	/** 目录行的「以项目打开」→ 整个工作区切过去（set_cwd）；文件行/空白处没有 project。 */
	const openAsProject = useCallback(() => {
		const p = fileMenuRef.current?.project;
		if (p) panelSend({ type: "set_cwd", path: p.path });
	}, [panelSend]);

	/** 打开隐藏的文件选择器；每次清空 value，同一个文件连选两次也要触发 change。 */
	const pickFiles = useCallback(() => {
		if (fileInput.current) fileInput.current.value = "";
		fileInput.current?.click();
	}, []);

	/** 剪贴板（复制/剪切供粘贴用）：只在右栏挂载期间有效，跨标签页不同步。 */
	const [clipboard, setClipboard] = useState<{ src: string; cut: boolean } | null>(null);
	/** 行内重命名：目标 wire 路径 + 草稿（Enter 提交 / Esc 或失焦取消）。 */
	const [renamingPath, setRenamingPath] = useState<string | null>(null);
	const [renameDraft, setRenameDraft] = useState("");
	/** 行内新建：落点目录 + 种类 + 草稿（渲染在列表顶部，见 files.entries 上方）。 */
	const [creating, setCreating] = useState<{ dir: string; kind: "file" | "dir" } | null>(null);
	const [createDraft, setCreateDraft] = useState("");

	/** 菜单「下载文件」（行内下载按钮的逻辑抽出来共用，见下）。 */
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

	/** 菜单「重命名」→ 打开行内输入框（草稿预填原名）。 */
	const startRename = useCallback(() => {
		const tg = fileMenuRef.current?.target;
		if (!tg || tg.kind === "list" || isProtectedRoot(tg.id)) return;
		setCreating(null);
		setRenameDraft(tg.label);
		setRenamingPath(tg.id);
	}, []);

	/** 行内重命名提交（空名 = 取消，不发协议）。 */
	const submitRename = useCallback(() => {
		if (!renamingPath) return;
		const name = renameDraft.trim();
		setRenamingPath(null);
		if (name) panelSend({ type: "file_rename", path: renamingPath, newName: name });
	}, [renamingPath, renameDraft, panelSend]);

	/** 菜单「新建文件/文件夹」→ 列表顶部行内输入框，落点为右键时的目录。 */
	const startCreate = useCallback(
		(kind: "file" | "dir") => {
			const dir = fileMenuRef.current?.dir ?? currentPath;
			setRenamingPath(null);
			setCreateDraft("");
			setCreating({ dir, kind });
		},
		[currentPath],
	);

	/** 行内新建提交（空名 = 取消，不发协议）。 */
	const submitCreate = useCallback(() => {
		if (!creating) return;
		const name = createDraft.trim();
		setCreating(null);
		if (name) panelSend({ type: "file_create", dir: creating.dir, name, kind: creating.kind });
	}, [creating, createDraft, panelSend]);

	/** 行内输入框（重命名/新建共用）：键位口径照抄 LeftPanel 会话改名。 */
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

	/** 菜单「删除」→ window.confirm 二次确认（与 ModelConfigModal 同口径）。 */
	const deleteTarget = useCallback(() => {
		const tg = fileMenuRef.current?.target;
		if (!tg || tg.kind === "list" || isProtectedRoot(tg.id)) return;
		if (!window.confirm(t("fileDeleteConfirm", { name: tg.label }))) return;
		if (clipboard?.src === tg.id) setClipboard(null);
		if (renamingPath === tg.id) setRenamingPath(null);
		panelSend({ type: "file_delete", path: tg.id });
	}, [panelSend, t, clipboard, renamingPath]);

	/** 菜单「创建副本」→ 同目录 file_copy（重名后缀由服务端加）。 */
	const duplicateTarget = useCallback(() => {
		const tg = fileMenuRef.current?.target;
		if (!tg || tg.kind === "list" || isProtectedRoot(tg.id)) return;
		panelSend({ type: "file_copy", src: tg.id, destDir: parentWireOf(tg.id) });
	}, [panelSend]);

	/** 菜单「复制/剪切」→ 进剪贴板（cut 那一行加 `.cut` 半透明，见 styles.css）。 */
	const markClipboard = useCallback((cut: boolean) => {
		const tg = fileMenuRef.current?.target;
		if (!tg || tg.kind === "list" || isProtectedRoot(tg.id)) return;
		setClipboard({ src: tg.id, cut });
	}, []);

	/** 菜单「粘贴」→ 落点为目录行即该目录，否则当前目录；剪切粘贴后清空剪贴板。 */
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

	/** 菜单「刷新列表」→ 静默重拉当前目录（不闪 loading 占位）。 */
	const refreshList = useCallback(() => {
		panelSend({ type: "list_files", path: currentPath === "" ? undefined : currentPath });
	}, [panelSend, currentPath]);

	// ---- 额外工作区根（宿主侧多根，见 server/protocol.ts 的 set_workspace_roots） ----
	/** 根选择器弹层开合（无根时不渲染，所以也不必持久化）。 */
	const [rootsOpen, setRootsOpen] = useState(false);
	/** 弹层外的点击/ Esc 关闭：监听挂在 window 上（弹层在面板内、点击不冒泡到行）。 */
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

	/** 写入整份根列表（服务端归一化 + 按项目持久化 + 推快照回显）。
	 *  传空数组 = 回到单根。增删都走这一条：服务端的值是唯一事实源。 */
	const setRoots = useCallback(
		(next: string[]) => {
			panelSend({ type: "set_workspace_roots", roots: next });
		},
		[panelSend],
	);

	/** 把一个目录加成工作区根（右键菜单条目）：已在列就不重复加。
	 *  目录不存在/不是绝对路径由服务端丢弃，前端不多判（避免两处口径）。 */
	const addWorkspaceRoot = useCallback(() => {
		const dir = fileMenuRef.current?.target;
		if (!dir || dir.kind !== "dir") return;
		const abs = toProjectPath(dir.id);
		if (!abs || workspaceRoots.includes(abs)) return;
		setRoots([...workspaceRoots, abs]);
	}, [workspaceRoots, toProjectPath, setRoots]);

	/** 文件选择器 change → 上传到「打开菜单时」记下的那个落点目录。 */
	const uploadPicked = useCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			uploadFilesTo(fileMenuRef.current?.dir ?? currentPath, Array.from(e.target.files ?? []));
		},
		[uploadFilesTo, currentPath],
	);

	/** host 内置条目的分派：`host:*` 的实现住在**本组件**（App 只分发插件动作），
	 *  按 entry.id 落到上面的本地实现；目标对象取 fileMenuRef 那份右键上下文。
	 *  openDir 在下方定义（闭包延迟执行，运行时已初始化）。 */
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
						path: absPathOf(tg.id),
						dir: absPathOf(action === "upload" ? (fileMenuRef.current?.dir ?? currentPath) : parentWireOf(tg.id)),
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
					if (tg && (tg.kind !== "list" || tg.id !== MACHINE_ROOT)) panelSend({ type: "file_reveal", path: tg.id });
					break;
				case "host:file-open-default":
					if (tg?.kind === "file") panelSend({ type: "file_open_default", path: tg.id });
					break;
				case "host:file-attach-inline":
					if (tg?.kind === "file") onAttach(tg.id, tg.label, "inline");
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
			// openDir 在下方才定义：deps 数组在渲染时求值不能引用它（TDZ），
			// 但分派闭包执行时它早已初始化；本仓未启用 exhaustive-deps，这里不列。
		],
	);

	/** 右键文件/目录/列表空白 → 打开 contextmenu.file 的**全局**菜单：条目与渲染都在 App，
	 *  右栏只报「在哪儿、右键了谁」，并把 host 内置条目的分派器一起交出去
	 *  （见 dispatchHostFileEntry）。内置条目与插件贡献的条目同排，谁都不再各自弹一套
	 *  菜单（两套菜单同时开着是老的坑，见 context-menu-state.ts 的取舍说明）。
	 *
	 *  target.kind 的三个取值："dir" 目录行 / "file" 文件行 / "list" 列表空白处（老菜单里
	 *  空白处只能「上传到当前目录」，故 kind 单列一个值，好把「以项目打开」隐掉）。 */
	const openFileMenu = useCallback(
		(e: React.MouseEvent, target: FileMenuCtx["target"]) => {
			// 右键上下文（= 老实现的 ctxDir / ctxProject）：点击回到本组件时用它。
			const projectPath = target.kind === "dir" ? toProjectPath(target.id) : null;
			const ctx: FileMenuCtx = {
				target,
				dir: target.kind === "dir" ? target.id : currentPath,
				project: projectPath ? { path: projectPath, name: target.label } : null,
			};
			// 内置条目的文案/可见性按当前右键对象重写：上传落点是「当前目录」
			// 还是「某个文件夹」；各条目按 kind（file/dir/list）与保护根取舍——
			// 保护根（机器根/盘符根/posix 根）只能在里面新建，不可改名/删除/复制；
			// 机器根本体（@root）连新建/上传/粘贴/刷新都没有（刷新机器根无意义）。
			const kind = target.kind;
			const isFile = kind === "file";
			const isDir = kind === "dir";
			const isList = kind === "list";
			const protectedRoot = !isList && isProtectedRoot(target.id);
			const absolute = !isList && isAbsoluteWire(target.id);
			const onMachineRoot = currentPath === MACHINE_ROOT;
			const entries = (uiContextFile ?? []).map((entry) => {
				if (entry.source !== "host") return entry;
				switch (entry.id) {
					case "host:file-upload-folder":
						return !onMachineRoot ? entry : { ...entry, hidden: true };
					case "host:file-compress":
					case "host:file-compress-download":
						return !isList && !protectedRoot ? entry : { ...entry, hidden: true };
					case "host:file-extract":
						return isFile && isExtractableArchive(target.label) ? entry : { ...entry, hidden: true };
					case "host:file-upload":
						// 文件行**也**给：上传落点是它所在的目录（ctx.dir），标签会变成「上传文件到当前目录」。
						// 只有机器根（不能往盘符根写）才隐。
						if (onMachineRoot) return { ...entry, hidden: true };
						return { ...entry, label: ctx.dir === currentPath ? t("uploadToCurrentDir") : t("uploadToFolder") };
					case "host:file-open-project":
						return projectPath ? entry : { ...entry, hidden: true };
					// 「添加为工作区根」：只对目录行有意义（文件/空白处没有项目可言），
					// 已是根或就在主工作区里（主根本身就是工作区）时也不显示。
					case "host:file-add-root": {
						const addable = Boolean(projectPath) && projectPath !== cwd && !workspaceRoots.includes(projectPath!);
						return addable ? entry : { ...entry, hidden: true };
					}
					case "host:file-open":
					case "host:file-download":
					case "host:file-open-default":
					case "host:file-attach-inline":
					case "host:file-attach-ref":
						return isFile ? entry : { ...entry, hidden: true };
					case "host:file-reveal":
						return !onMachineRoot ? entry : { ...entry, hidden: true };
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
			// 一条可见条目都没有（内置条目被布局页隐藏、插件也没贡献）→ 别抢浏览器菜单：
			// 弹个空菜单比不弹更糟，还会顺手废掉「检查元素 / 下载」（口径同 Message.tsx）。
			if (contextMenuItems(entries).length === 0) return;
			e.preventDefault();
			// 行上的处理器必须拦冒泡：.panel-body 上还有一个「列表空白处」的处理器，
			// 不拦的话它会后执行并把目标覆盖成「当前列出的目录」。
			e.stopPropagation();
			fileMenuRef.current = ctx;
			openContextMenu({
				x: e.clientX,
				y: e.clientY,
				slot: "contextmenu.file",
				target,
				entries,
				onHostAction: dispatchHostFileEntry,
			});
		},
		[uiContextFile, currentPath, toProjectPath, t, dispatchHostFileEntry, cwd, workspaceRoots, clipboard],
	);

	// ---- 拖拽上传（类 VSCode：文件夹行→该文件夹；文件行→其所在目录；空白→当前目录） ----
	// 高亮用命令式 DOM class（不触发 React 重渲染），与逐行 data-path 配合（bodyRef 见上）。

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

	/** 拖拽落点目录：命中文件夹行→该文件夹；文件行/未知行/空白→当前列表目录。 */
	const dropDirFor = (target: EventTarget | null): string => {
		const el = target instanceof Element ? (target.closest(".file-item") as HTMLElement | null) : null;
		if (el?.dataset.type === "dir") return el.dataset.path ?? currentPath;
		return currentPath;
	};

	/** 主应用把全窗口当拖放目标（拖文件即「附加到对话」）；面板自己处理时要
	 *  清掉它的全屏 📎 提示，避免盖在上传落点上方造成歧义（纯视觉清理）。 */
	const clearAppDrop = useCallback(() => {
		const appEl = document.querySelector(".app");
		if (appEl) appEl.dispatchEvent(new DragEvent("dragleave", { bubbles: true }));
	}, []);

	/** How often to silently re-poll the current directory (ms). */
	const AUTO_REFRESH_MS = 10_000;

	// Monotonic request id — responses are only trusted if they match the latest
	// requested path (guards against out-of-order responses when navigating fast).
	const reqSeq = useRef(0);

	// Last cwd we listed — when the workspace switches, jump back to its root.
	const lastCwd = useRef<string | undefined>(undefined);

	const request = useCallback(
		(path: string, opts?: { silent?: boolean }) => {
			const seq = ++reqSeq.current;
			setCurrentPath(path);
			// Silent refreshes (polling / cwd switch) keep the current listing on
			// screen instead of flashing the loading placeholder.
			if (!opts?.silent) setLoading(true);
			const ok = panelSend({
				type: "list_files",
				path: path === "" ? undefined : path,
			});
			if (!ok) {
				// Not connected — nothing will arrive; back off the spinner.
				if (reqSeq.current === seq) setLoading(false);
			}
		},
		[panelSend],
	);

	/** 去掉一个根。 */
	const removeWorkspaceRoot = useCallback(
		(root: string) => {
			const next = workspaceRoots.filter((x) => x !== root);
			setRoots(next);
			// 正在浏览那个被移除的根 → 回主根（否则停在树枝外的目录、 crumbs 也断链）。
			if (currentPath === root || currentPath.startsWith(`${root}/`)) request("");
		},
		[workspaceRoots, setRoots, currentPath, request],
	);

	// The server response arrives via chat.files; only treat it as the answer to
	// the current navigation if its path matches (stale/out-of-order responses
	// for other directories keep the spinner up).
	useEffect(() => {
		if (files && files.path === currentPath) setLoading(false);
	}, [files, currentPath]);

	// Auto-refresh: when the cwd changes (project switch / set_cwd) re-list its
	// root; otherwise poll the current directory silently so the tree stays fresh
	// without a manual refresh button.
	useEffect(() => {
		if (cwd !== lastCwd.current) {
			lastCwd.current = cwd;
			request("", { silent: true });
			return;
		}
		const timer = setInterval(() => {
			if (document.visibilityState === "hidden") return;
			request(currentPath, { silent: true });
		}, AUTO_REFRESH_MS);
		return () => clearInterval(timer);
	}, [cwd, currentPath, request]);
	// The server fs.watches the listed directory and pushes `file_changed` on any
	// change — refresh right away instead of waiting for the 10s poll. The path
	// guard drops events for a directory the user has already navigated away from.
	useEffect(() => {
		if (fileChanged && fileChanged.path === currentPath) request(currentPath, { silent: true });
	}, [fileChanged, currentPath, request]);

	// Enter a directory.
	const openDir = (path: string) => request(path);
	// Go back to the parent.
	const goUp = () => {
		if (files?.parent !== null && files?.parent !== undefined) {
			request(files.parent);
		}
	};

	// 面包屑：工作区相对路径按 "/" 逐级；Windows 绝对路径（C:/a/b）首级就是盘符；
	// posix 绝对路径补 "/" 根；机器根（@root）不进面包屑（有专门的 💻 按钮）。
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

	/** 插件贡献的 tab（`rightpanel.tabs` 里非 host 的条目）：UiSlotEntry 里没有插件页信息，
	 *  得按 source 的 `plugin:<id>` 回插件清单查 UiPluginInfo。查不到（清单还没推来 /
	 *  插件刚被卸载 / 被禁用）、被用户或插件隐藏、或是插件塞进来的分隔线 → 跳过这一条：
	 *  宁可少一个 tab，也不要点开才发现报错。 */
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

	/** 内置「文件」tab 要不要画：**尊重条目自己的 hidden**（用户可在设置面板「界面布局」里
	 *  取消勾选，插件也能经 arrange 把它藏起来）—— 否则布局页那个勾选框就是个摆设，
	 *  「设置里看到的 == 界面上看到的」这条 #146 的核心不变量当场破产。
	 *  全藏光时右栏就是空的：那是用户/插件的明确意愿，布局页的「恢复」一键可退回。 */
	const filesTabHidden = (uiRightPanelTabs ?? []).some((e) => e.id === "host:right-files" && e.hidden);
	/** tab 顺序统一走 slot（含文件 tab 的位置，不再固定第一；未接线时保持旧顺序）。 */
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
					<FiChevronsRight />
				</button>
			)}
			{/* tab 容器：SlotTabs 自带 flex:1（styles.css 的 .slot-tabs），这层 div 只把
 「文件区 ↔ widgets」的权重接回来 —— 权重原本挂在 .panel-body 上，而 .panel-body
 现在被挪进了 tab 内容区，改由这层承担（内联写，不新增 CSS 类）。 */}
			<div
				ref={splitRef}
				style={{
					display: "flex",
					flexDirection: "column",
					flex: hasWidgets ? `${rpWeights.files} 1 0` : "1 1 0",
					minHeight: hasWidgets ? RP_MIN_FILES_PX : 0,
				}}
			>
				{/* 内置「文件」tab 的位置同样走 slot 顺序（orderTabs），不再固定第一；隐藏逻辑见 filesTabHidden。
 插件 tab 的内容交给 PluginPage 渲染（只挂当前选中项，切走即 cleanup）。全被隐藏时 SlotTabs 自己返回 null。 */}
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
													<button
														type="button"
														className={`crumb ${currentPath === MACHINE_ROOT ? "active" : ""}`}
														title={t("computer")}
														onClick={() => request(MACHINE_ROOT)}
													>
														💻
													</button>
													{/* 🏠 用户目录：快照直给的绝对路径，当普通目录请求（与 💻 / 面包屑同一条路）。旧服务不带 homeDir 时整个按钮不渲染。 */}
													{homeDir !== "" && (
														<button
															type="button"
															className={`crumb ${currentPath === homeDir || currentPath.startsWith(`${homeDir}/`) ? "active" : ""}`}
															title={t("homeDir")}
															onClick={() => request(homeDir)}
														>
															🏠
														</button>
													)}
													{/* 🖥️ 桌面：快照直给的绝对路径（不存在/旧服务则不渲染），与 🏠 同一条路。 */}
													{desktopDir !== "" && (
														<button
															type="button"
															className={`crumb ${currentPath === desktopDir || currentPath.startsWith(`${desktopDir}/`) ? "active" : ""}`}
															title={t("desktopDir")}
															onClick={() => request(desktopDir)}
														>
															🖥️
														</button>
													)}
													<HintTip text={t("filesHelp")} />
													{/* 额外工作区根（宿主侧多根，见 protocol 的 set_workspace_roots）：有根才渲染根选择器，
											    没根时 crumbs 与以前一模一样（不多一个空按钮）。文件树一次只展一个根（不做合并视图），
											    选中即把 currentPath 切到那个绝对路径 —— 树本来就支持任意绝对路径（同 💻 机器浏览）。 */}
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
																	{/* 主根 = 当前工作区（cwd）：不能“移除”，它由项目决定。 */}
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
														// 只记数不改状态：滚动不该触发右栏重渲染（文件多的时候很贵）。
														bodyScrollRef.current = e.currentTarget.scrollTop;
													}}
													onContextMenu={(e) =>
														openFileMenu(e, {
															id: currentPath,
															// 列表空白处 = 当前列出的目录，与逐行右键走同一个槽位（"两份菜单合并"的诉求
															// 就是这么来的：以前这里是面板自己的 .ctx-menu）。
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
														e.preventDefault(); // 声明合法落点，否则浏览器默认禁止 drop
														e.stopPropagation(); // 主应用全窗口「附加到对话」不参与
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
													{/* 隐藏的文件选择器：右键菜单的「上传文件」用它（每次清空 value，选同一个
										    文件两次也会触发 change；落点目录见 uploadPicked）。 */}
													<input ref={fileInput} type="file" multiple hidden onChange={uploadPicked} />
													{transfer && (
														<FileTransferDialog
															request={transfer}
															onClose={() => setTransfer(null)}
															onComplete={refreshList}
														/>
													)}
													{/* 行内新建（右键菜单「新建文件/文件夹」）：落点目录见 creating.dir。 */}
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
															{files.entries.map((e) =>
																e.type === "dir" ? (
																	<div
																		key={e.path}
																		className={`file-item dir${clipboard?.cut && clipboard.src === e.path ? " cut" : ""}`}
																		data-type="dir"
																		data-path={e.path}
																		onContextMenu={(ev) => openFileMenu(ev, { id: e.path, kind: "dir", label: e.name })}
																	>
																		{renamingPath === e.path ? (
																			renderNameInput(renameDraft, setRenameDraft, submitRename, () =>
																				setRenamingPath(null),
																			)
																		) : (
																			<button type="button" className="file-dir-main" onClick={() => openDir(e.path)}>
																				<FiFolder className="file-icon" />
																				<span className="file-name">{e.name}</span>
																			</button>
																		)}
																		<button
																			type="button"
																			className="file-attach ref"
																			data-tip={t("linkFolderTip")}
																			aria-label={t("linkFolderTip")}
																			onClick={() => onAttach(e.path, e.name, "reference", true)}
																		>
																			<FiLink />
																		</button>
																		<button
																			type="button"
																			className={`file-attach copy${copiedKey === `name:${e.path}` ? " copied" : ""}`}
																			data-tip={t("copyName")}
																			aria-label={t("copyName")}
																			onClick={() => copyText(e.name, `name:${e.path}`)}
																		>
																			{copiedKey === `name:${e.path}` ? <FiCheck /> : <FiCopy />}
																		</button>
																		<button
																			type="button"
																			className={`file-attach copy${copiedKey === `path:${e.path}` ? " copied" : ""}`}
																			data-tip={t("copyPath")}
																			aria-label={t("copyPath")}
																			onClick={() => copyText(absPathOf(e.path), `path:${e.path}`)}
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
																				onClick={() => onPreview(e.path, e.name)}
																			>
																				<FiFile className="file-icon" />
																				<span className="file-name-text">{e.name}</span>
																			</button>
																		)}
																		{/* Download: any file, previewable or not (binary/archives
									too). Fetched as a blob so Safe Browsing can't block the
									HTTP download and failures show a readable error. */}
																		<button
																			type="button"
																			className="file-attach download"
																			data-tip={t("downloadFile")}
																			onClick={() => downloadEntry(e.path, e.name)}
																		>
																			<FiDownload />
																		</button>
																		<button
																			type="button"
																			className="file-attach inline"
																			data-tip={t("attachInlineTip")}
																			onClick={() => onAttach(e.path, e.name, "inline")}
																		>
																			<FiPlus />
																		</button>
																		<button
																			type="button"
																			className="file-attach ref"
																			data-tip={t("referenceTip")}
																			aria-label={t("referenceTip")}
																			onClick={() => onAttach(e.path, e.name, "reference")}
																		>
																			<FiLink />
																		</button>
																		<button
																			type="button"
																			className={`file-attach copy${copiedKey === `name:${e.path}` ? " copied" : ""}`}
																			data-tip={t("copyName")}
																			aria-label={t("copyName")}
																			onClick={() => copyText(e.name, `name:${e.path}`)}
																		>
																			{copiedKey === `name:${e.path}` ? <FiCheck /> : <FiCopy />}
																		</button>
																		<button
																			type="button"
																			className={`file-attach copy${copiedKey === `path:${e.path}` ? " copied" : ""}`}
																			data-tip={t("copyPath")}
																			aria-label={t("copyPath")}
																			onClick={() => copyText(absPathOf(e.path), `path:${e.path}`)}
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
