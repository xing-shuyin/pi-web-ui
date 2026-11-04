import { memo, useEffect, useState, useCallback, useRef, useMemo, Fragment } from "react";
import { DeviceGroupSection } from "./DeviceGroupSection";
import {
	FiAlertCircle,
	FiCheck,
	FiChevronDown,
	FiChevronLeft,
	FiChevronRight,
	FiChevronUp,
	FiClock,
	FiEdit2,
	FiFolder,
	FiFolderPlus,
	FiGitBranch,
	FiMessageSquare,
	FiMoreVertical,
	FiPlus,
	FiTrash2,
	FiUsers,
	FiX,
	FiZap,
} from "react-icons/fi";
import { LuFlaskConical } from "react-icons/lu";
import type {
	ConversationSummary,
	ElsewhereRunning,
	PluginPanelGroup,
	PluginPanelItem,
	ProjectSummary,
	SessionSummary,
} from "../types";
import { useT } from "../i18n";
import { useAppField, useEngineCapabilities } from "../app-globals";
import { useUnreadConversationKeys, clearConversationUnread } from "../unread-conversations";
import { applySashDrag } from "../panel-sash";
import {
	type LpSectionKey,
	flexSectionKeys,
	parseLpWeights,
	planLeftSections,
	sashPairs,
	withDeviceGroupSection,
} from "../left-sections";
import { buildConversationRows, groupConversations, type ConvRowItem } from "../conv-groups";
import { ProjectPicker } from "./ProjectPicker.js";
// 宿主 UI 扩展点（issue #146）：会话行的右键菜单走「slot 条目」这一条通道。
import { type UiSlotEntry } from "../ui-slots";
import { contextMenuItems, openContextMenu, type ContextMenuRequest } from "../context-menu-state";
import { HalfRingSpinner } from "./HalfRingSpinner";
import { composeToComposer, focusComposer } from "../composer-bridge";
import { buildSessionDeepLink, extractSessionIdFromPath } from "../session-url";
import {
	clearCachedProject,
	clearCachedSession,
	clearLastCwdIfMatches,
	isSessionMatchingProject,
	normalizeSessionPathKey,
	readCachedSessions,
	type WorkspaceTransitionState,
} from "../use-chat";

/** Props are deliberately NARROW (no whole-ChatState object): every field is
 *  stable while tokens stream in, so the shallow-compared memo() below skips
 *  this entire panel during streaming instead of re-reconciling the file tree
 *  and conversation lists on every delta. Add a prop here when adding a chat
 *  field usage — TypeScript enforces it at the call site. */
interface LeftPanelProps {
	sessionFile: string | null;
	conversations: ConversationSummary[];
	/** issue #145：其他客户端正在跑的对话（只读，不可点）。 */
	elsewhere: ElsewhereRunning[];
	sessions: SessionSummary[];
	projects: ProjectSummary[];
	activeConversationId: string;
	sharedConversationOwner?: string;
	activeGroupId?: string | null;
	projectSessions?: Record<string, SessionSummary[]>;
	engine?: string;
	/** 已完成但尚未查看的会话键集合（含 id / sessionId / sessionFile / path）。 */
	unreadConvKeys?: ReadonlySet<string>;
	panelSend: (
		msg:
			| { type: "new_chat" }
			| { type: "list_sessions"; path?: string }
			| { type: "list_projects" }
			| { type: "switch_session"; path: string }
			| { type: "switch_conversation"; id: string }
			| { type: "set_cwd"; path: string }
			| { type: "remove_project"; path: string }
			| { type: "destroy_sandbox"; path: string }
			| { type: "delete_session"; path: string }
			| { type: "rename_session"; path: string; name: string }
			| { type: "rename_conversation"; id: string; name: string }
			| { type: "dismiss_conversation"; id: string; withFinishedSubagents?: boolean; force?: boolean; owner?: string }
			| { type: "dismiss_finished_subagents"; parentId?: string }
			| { type: "persist_conversation"; id: string }
			| { type: "pin_conversation"; id: string; pinned: boolean }
			| { type: "pin_session"; path: string; pinned: boolean }
			| { type: "take_over_conversation"; owner: string; id: string }
			| { type: "open_shared_conversation"; owner: string; id: string }
			| { type: "peek_elsewhere_question"; owner: string; id: string }
			| { type: "make_dir"; path: string; setAsCwd?: boolean },
	) => boolean;
	/** True while the panel is actually on screen (desktop: always; mobile:
	 *  only while the drawer is open). Drives lazy loading of the session
	 *  list + recent projects — both scan session files on disk. */
	active: boolean;
	/** Desktop: show the collapse button (mobile drawers close via the topbar). */
	collapsible?: boolean;
	/** Fired when the user clicks the collapse button. */
	onToggleCollapse?: () => void;

	// ---- 宿主 UI 扩展点（issue #146）：由 App 用 buildUiSlots() 算好后传进来 ----
	/** `contextmenu.session` 槽位的最终条目（host 内置 + 插件贡献）。左栏只负责**打开**
	 *  菜单（openContextMenu），菜单本身由 App 全局渲染；host 条目的实现就在本组件里（见
	 *  dispatchHostSessionEntry），插件条目才交回 App 分发给插件。 */
	uiContextSession?: UiSlotEntry[];
	/** `leftpanel.sessions` 槽位的最终条目（host 内置 + 插件贡献，由 App 算好）。
	 *  不传/空数组 = 不画，会话行 DOM 与旧版一字不差。 */
	uiLeftSessions?: UiSlotEntry[];
	/** P1：`contextmenu.project` 槽位的最终条目（项目行右键；与 uiContextSession 同口径，空 = 不抢浏览器右键）。 */
	uiContextProject?: UiSlotEntry[];
	/** P1：「最近项目」分区标题栏的插件按钮（App 已滤 hidden）。 */
	uiProjectsActions?: UiSlotEntry[];
	/** P1：项目行内嵌区（`leftpanel.project`，App 已滤 hidden）。 */
	uiLeftProject?: UiSlotEntry[];
	/** P1：「运行的对话」分区标题栏的插件按钮。 */
	uiRunningActions?: UiSlotEntry[];
	/** P1：「历史对话」分区标题栏的插件按钮。 */
	uiHistoryActions?: UiSlotEntry[];
	/** 点击一条会话行内嵌条目：交回 App 分发给贡献它的插件（与顶栏 onUiAction 同通道）。
	 *  target 可选：项目行条目带上 `{id: 项目路径, kind: "project"}`，插件据此知道是哪个项目。 */
	onUiAction?: (item: UiSlotEntry, value?: string, target?: { id: string; kind?: string; label?: string }) => void;
	/** P2：`leftpanel.sections` 的全量条目（含 hidden，由 App 算好）。决定三个分区的先后与显隐；不传 = 缺省顺序、全部显示。 */
	uiSections?: UiSlotEntry[];
	/** P4：插件自定义分区的正文渲染（由 App 用 PluginPage 挂插件 bundle；不传 = 空正文）。 */
	renderPluginSectionBody?: (entry: UiSlotEntry) => React.ReactNode;
	/** P3：插件运行条目分组（左栏「运行的对话」末尾；全量，服务端节流推送；不传 = 没有）。 */
	uiPluginRunning?: PluginPanelGroup[];
	/** P3：点插件运行条目（缺省 action 时无效果，由 App 分派给插件 bundle）。 */
	onPluginRunningAction?: (group: PluginPanelGroup, item: PluginPanelItem) => void;
	/** P2：`leftpanel.running` 运行行内嵌区的条目（与 leftpanel.sessions 并集）。 */
	uiLeftRunning?: UiSlotEntry[];
	/** P2：`leftpanel.history` 历史行内嵌区的条目（与 leftpanel.sessions 并集）。 */
	uiLeftHistory?: UiSlotEntry[];
	/** DSH Agent 预设名录（id → 显示名；左栏会话徽标用，缺省显示 id）。 */
	presetNames?: Record<string, string>;
	/** 路径补全（用于项目管理面板的目录浏览与补全）。 */
	pathCompletions?: { name: string; path: string; type: "dir" | "file" }[];
	/** 工作区/历史会话/对话的流式切换状态（用于目标行实时转圈与百分比展示）。 */
	transition?: WorkspaceTransitionState | null;
	/** 打开启动沙盒项目弹窗。 */
	onOpenSandboxModal?: () => void;
}

function formatModified(ts: number): string {
	const d = new Date(ts);
	const now = new Date();
	const sameDay = d.toDateString() === now.toDateString();
	if (sameDay) {
		return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
	}
	return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 打开 `contextmenu.session` 菜单时的被右键对象（kind 决定操作范围：见 showSessionMenu）。
 *  elsewhere = 「另一处」行：id 即对方会话内的 convId，owner 标识持有方（过户目标）。 */
type SessionMenuTarget = {
	id: string;
	kind: "running" | "history" | "section" | "elsewhere";
	label: string;
	owner?: string;
	pseudo?: boolean;
};

/** 右键落点是不是「输入类」元素：重命名输入框里的右键要留给浏览器（复制 / 粘贴 /
 *  拼写检查），宿主的会话菜单不该把它抢掉（同「不抢预览弹窗右键」的口径）。 */
function isEditableTarget(el: EventTarget | null): boolean {
	const node = el instanceof HTMLElement ? el : null;
	if (!node) return false;
	const tag = node.tagName;
	if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
	return node.isContentEditable;
}

const LS_COLLAPSE_PROJECTS = "pi-web-ui:lp-collapse-projects";
const LS_COLLAPSE_CONVS = "pi-web-ui:lp-collapse-convs";
const LS_COLLAPSE_SESSIONS = "pi-web-ui:lp-collapse-sessions";
const LS_COLLAPSE_SUBAGENTS = "pi-web-ui:lp-collapse-subagents";

function useCollapsedSubagents(): [Set<string>, (id: string) => void] {
	const [collapsed, setCollapsed] = useState<Set<string>>(() => {
		try {
			const raw = localStorage.getItem(LS_COLLAPSE_SUBAGENTS);
			if (raw) return new Set(JSON.parse(raw));
		} catch {}
		return new Set();
	});
	const toggle = useCallback((id: string) => {
		setCollapsed((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			try {
				localStorage.setItem(LS_COLLAPSE_SUBAGENTS, JSON.stringify([...next]));
			} catch {}
			return next;
		});
	}, []);
	return [collapsed, toggle];
}

function useCollapsed(key: string, defaultCollapsed = false): [boolean, () => void] {
	const [collapsed, setCollapsed] = useState(() => {
		try {
			const v = localStorage.getItem(key);
			if (v === "1") return true;
			if (v === "0") return false;
		} catch {}
		return defaultCollapsed;
	});
	const toggle = useCallback(() => {
		setCollapsed((prev) => {
			const next = !prev;
			try {
				localStorage.setItem(key, next ? "1" : "0");
			} catch {}
			return next;
		});
	}, [key]);
	return [collapsed, toggle];
}

/* VSCode 风格可拖拽分割：展开区的 flex-grow 权重持久化，折叠区不占空间 */
/** P4：插件自定义分区的折叠态（只记折叠的分区键，JSON 数组）。 */
const LS_COLLAPSE_PLUGIN_SECTIONS = "pi-web-ui:lp-collapse-plugin-sections";
function usePluginSectionCollapse(): [ReadonlySet<string>, (key: string) => void] {
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => {
		try {
			const raw = localStorage.getItem(LS_COLLAPSE_PLUGIN_SECTIONS);
			const arr: unknown = raw ? JSON.parse(raw) : [];
			return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : []);
		} catch {
			return new Set<string>();
		}
	});
	const toggle = useCallback((key: string) => {
		setCollapsed((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			try {
				localStorage.setItem(LS_COLLAPSE_PLUGIN_SECTIONS, JSON.stringify([...next]));
			} catch {}
			return next;
		});
	}, []);
	return [collapsed, toggle];
}
const LS_LP_SIZES = "pi-web-ui:lp-sizes";
/** 分区权重：宿主三键 + 插件自定义分区键（`plugin:…`，缺省 1）。 */
type LpWeights = Record<string, number>;
const DEFAULT_LP_WEIGHTS: LpWeights = { projects: 1, groups: 1, convs: 1, sessions: 1 };
/** 折叠区仅留标题高度（与 styles.css 的 .lp-section.collapsed 对齐）。 */
const LP_COLLAPSED_HEADER_PX = 32;
/** P3：插件运行条目状态 → i18n key（tooltip 文案）。 */
const PLUGIN_STATUS_KEY = {
	running: "pluginRunStatusRunning",
	done: "pluginRunStatusDone",
	error: "pluginRunStatusError",
} as const;
/** 展开区最小高度（≈3 行，与 styles.css 的 .lp-section min-height 对齐）。 */
const LP_MIN_SECTION_PX = 72;
/** 存档解析与拖动换算都是纯函数，与右栏共用（见 `../panel-sash`）。 */
function loadLpWeights(): LpWeights {
	try {
		return parseLpWeights(localStorage.getItem(LS_LP_SIZES), DEFAULT_LP_WEIGHTS);
	} catch {
		// localStorage 不可用（隐私模式/SSR）→ 默认权重
		return { ...DEFAULT_LP_WEIGHTS };
	}
}

const IS_TEST = typeof process !== "undefined" && (Boolean(process.env.VITEST) || process.env.NODE_ENV === "test");

const LS_CONV_TAB = "pi.leftpanel.conv_tab";
type ConvTabMode = "running" | "stream" | "split";

function loadConvTab(): ConvTabMode {
	try {
		const val = localStorage.getItem(LS_CONV_TAB);
		if (val === "running" || val === "stream" || val === "split") return val;
	} catch {}
	return IS_TEST ? "split" : "stream";
}

const LS_WORKSPACE_TAB = "pi.leftpanel.workspace_tab";
type WorkspaceTabMode = "projects" | "groups" | "split";

function loadWorkspaceTab(): WorkspaceTabMode {
	try {
		const val = localStorage.getItem(LS_WORKSPACE_TAB);
		if (val === "projects" || val === "groups" || val === "split") return val;
	} catch {}
	return IS_TEST ? "split" : "projects";
}

interface TimeGroupItem {
	label: string;
	key: string;
	items: SessionSummary[];
}

function groupSessionsByTime(
	list: readonly SessionSummary[],
	labels: { today: string; yesterday: string; pastWeek: string; earlier: string },
): TimeGroupItem[] {
	const now = new Date();
	const todayStr = now.toDateString();
	const yesterday = new Date(now);
	yesterday.setDate(now.getDate() - 1);
	const yesterdayStr = yesterday.toDateString();
	const sevenDaysAgo = now.getTime() - 7 * 86400 * 1000;

	const today: SessionSummary[] = [];
	const yest: SessionSummary[] = [];
	const week: SessionSummary[] = [];
	const earlier: SessionSummary[] = [];

	for (const s of list) {
		const d = new Date(s.modified);
		const dateStr = d.toDateString();
		if (dateStr === todayStr) {
			today.push(s);
		} else if (dateStr === yesterdayStr) {
			yest.push(s);
		} else if (s.modified >= sevenDaysAgo) {
			week.push(s);
		} else {
			earlier.push(s);
		}
	}

	const groups: TimeGroupItem[] = [];
	if (today.length > 0) groups.push({ label: labels.today, key: "today", items: today });
	if (yest.length > 0) groups.push({ label: labels.yesterday, key: "yesterday", items: yest });
	if (week.length > 0) groups.push({ label: labels.pastWeek, key: "week", items: week });
	if (earlier.length > 0) groups.push({ label: labels.earlier, key: "earlier", items: earlier });
	return groups;
}

export const LeftPanel = memo(function LeftPanel({
	sessionFile,
	conversations,
	elsewhere,
	sessions,
	projects,
	activeConversationId,
	sharedConversationOwner,
	activeGroupId,
	projectSessions,
	engine,
	unreadConvKeys,
	panelSend,
	active,
	collapsible,
	onToggleCollapse,
	pathCompletions,
	uiContextSession,
	uiLeftSessions,
	uiContextProject,
	uiProjectsActions,
	uiLeftProject,
	uiRunningActions,
	uiHistoryActions,
	uiSections,
	renderPluginSectionBody,
	uiPluginRunning,
	onPluginRunningAction,
	uiLeftRunning,
	uiLeftHistory,
	onUiAction,
	presetNames,
	transition,
	onOpenSandboxModal,
}: LeftPanelProps) {
	const t = useT();
	const capabilities = useEngineCapabilities();
	const storeUnreadKeys = useUnreadConversationKeys();
	const effectiveUnreadKeys = unreadConvKeys ?? storeUnreadKeys;

	const checkUnread = useCallback(
		(keys: { id?: string; sessionId?: string; sessionFile?: string; path?: string }) => {
			if (!effectiveUnreadKeys || effectiveUnreadKeys.size === 0) return false;
			if (keys.id && (effectiveUnreadKeys.has(keys.id) || effectiveUnreadKeys.has(keys.id.trim().toLowerCase())))
				return true;
			if (
				keys.sessionId &&
				(effectiveUnreadKeys.has(keys.sessionId) || effectiveUnreadKeys.has(keys.sessionId.trim().toLowerCase()))
			)
				return true;
			if (
				keys.sessionFile &&
				(effectiveUnreadKeys.has(keys.sessionFile) || effectiveUnreadKeys.has(keys.sessionFile.trim().toLowerCase()))
			)
				return true;
			if (keys.path && (effectiveUnreadKeys.has(keys.path) || effectiveUnreadKeys.has(keys.path.trim().toLowerCase())))
				return true;
			return false;
		},
		[effectiveUnreadKeys],
	);

	const currentFile = sessionFile;
	// 连接态与当前工作目录走全局（web/src/app-globals.ts），不再从 App 传
	// —— 这三个值整棵树都要，传参只会越传越漏。
	const ready = useAppField("ready");
	const status = useAppField("status");
	const cwd = useAppField("cwd");
	const workspaceRoots = useAppField("workspaceRoots");
	const currentCwd = cwd;
	const [projectPickerOpen, setProjectPickerOpen] = useState(false);
	const [confirmDel, setConfirmDel] = useState<string | null>(null);
	const [confirmTakeover, setConfirmTakeover] = useState<string | null>(null);
	const [renaming, setRenaming] = useState<string | null>(null);
	const [renameDraft, setRenameDraft] = useState("");
	const [collapseProjects, toggleProjects] = useCollapsed(LS_COLLAPSE_PROJECTS, false);
	const [collapseConvs, toggleConvs] = useCollapsed(LS_COLLAPSE_CONVS, false);
	const [collapseSessions, toggleSessions] = useCollapsed(LS_COLLAPSE_SESSIONS, false);
	const [pluginCollapsed, togglePluginCollapsed] = usePluginSectionCollapse();
	const [collapseGroups, setCollapseGroups] = useState(false);
	const [collapsedSubagents, toggleSubagents] = useCollapsedSubagents();
	const [convTab, setConvTab] = useState<ConvTabMode>(() => loadConvTab());
	useEffect(() => {
		try {
			localStorage.setItem(LS_CONV_TAB, convTab);
		} catch {}
	}, [convTab]);
	const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTabMode>(() => loadWorkspaceTab());
	useEffect(() => {
		try {
			localStorage.setItem(LS_WORKSPACE_TAB, workspaceTab);
		} catch {}
	}, [workspaceTab]);
	const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
	const workspaceMenuRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!workspaceMenuOpen) return;
		const handleClickOutside = (e: MouseEvent) => {
			if (workspaceMenuRef.current && !workspaceMenuRef.current.contains(e.target as Node)) {
				setWorkspaceMenuOpen(false);
			}
		};
		window.addEventListener("mousedown", handleClickOutside);
		return () => window.removeEventListener("mousedown", handleClickOutside);
	}, [workspaceMenuOpen]);
	const [groupCount, setGroupCount] = useState<number>(0);
	const [visibleSessionCount, setVisibleSessionCount] = useState(60);
	useEffect(() => {
		setVisibleSessionCount(60);
	}, [currentCwd]);

	// 1. 物理级去重：按 normalizeSessionPathKey 确保每个项目唯一，杜绝重复项
	const deduplicatedProjects = useMemo(() => {
		const seen = new Set<string>();
		const list: ProjectSummary[] = [];
		for (const p of projects) {
			const normP = normalizeSessionPathKey(p.path);
			if (seen.has(normP)) continue;
			seen.add(normP);
			list.push(p);
		}
		// 仅当项目未被登记但存在活跃会话时，作为活动项目安全补入列表末尾，保证运行中对话不丢失，且不扰乱既有项目排序
		for (const c of conversations) {
			if (!c.cwd) continue;
			const normC = normalizeSessionPathKey(c.cwd);
			if (!seen.has(normC)) {
				seen.add(normC);
				list.push({ path: c.cwd, lastUsed: Date.now() });
			}
		}
		for (const e of elsewhere) {
			if (!e.cwd) continue;
			const normC = normalizeSessionPathKey(e.cwd);
			if (!seen.has(normC)) {
				seen.add(normC);
				list.push({ path: e.cwd, lastUsed: Date.now() });
			}
		}
		return list;
	}, [projects, conversations, elsewhere]);

	// 2. 方案 A：会话内位置锁定（Deferred MRU · 稳定空间记忆）
	// 按项目初次呈现时的 Rank 锁定相对排位，用户在当前窗口点击切换时绝对在原地展开，不发生动态瞬移
	const projectRankMapRef = useRef<Map<string, number>>(new Map());

	const stableProjects = useMemo(() => {
		const rankMap = projectRankMapRef.current;

		// 按照服务端推送给出的天然顺序分配初始 Rank（初次到达的项目保持服务端的最近时间排位）
		deduplicatedProjects.forEach((p, index) => {
			const key = normalizeSessionPathKey(p.path);
			if (!rankMap.has(key)) {
				rankMap.set(key, index);
			}
		});

		// 按照锁定的物理排位渲染，操作期间零视觉抖动
		return [...deduplicatedProjects].sort((a, b) => {
			const keyA = normalizeSessionPathKey(a.path);
			const keyB = normalizeSessionPathKey(b.path);
			const rankA = rankMap.get(keyA) ?? 0;
			const rankB = rankMap.get(keyB) ?? 0;
			return rankA - rankB;
		});
	}, [deduplicatedProjects]);

	const effectiveProjects = stableProjects;

	const [expandedOtherProjects, setExpandedOtherProjects] = useState<Set<string>>(() => new Set());
	const [collapsedCurrentProjects, setCollapsedCurrentProjects] = useState<Set<string>>(() => new Set());
	const [projectVisibleCounts, setProjectVisibleCounts] = useState<Record<string, number>>({});
	const [loadingProjects, setLoadingProjects] = useState<Set<string>>(() => new Set());

	const isProjectExpanded = useCallback(
		(projectPath: string) => {
			const normP = normalizeSessionPathKey(projectPath);
			const normCur = normalizeSessionPathKey(currentCwd);
			const isCurrent = normP === normCur;
			if (isCurrent) {
				return !collapsedCurrentProjects.has(normP);
			}
			return expandedOtherProjects.has(normP);
		},
		[currentCwd, collapsedCurrentProjects, expandedOtherProjects],
	);

	const toggleProjectExpand = useCallback(
		(projectPath: string) => {
			const normP = normalizeSessionPathKey(projectPath);
			const normCur = normalizeSessionPathKey(currentCwd);
			const isCurrent = normP === normCur;
			if (isCurrent) {
				setCollapsedCurrentProjects((prev) => {
					const next = new Set(prev);
					if (next.has(normP)) next.delete(normP);
					else next.add(normP);
					return next;
				});
			} else {
				setExpandedOtherProjects((prev) => {
					const next = new Set(prev);
					const willExpand = !next.has(normP);
					if (willExpand) {
						next.add(normP);
						// 展开非当前项目时：主动向后端请求该项目的历史会话列表
						panelSend({ type: "list_sessions", path: projectPath });
						setLoadingProjects((lp) => new Set(lp).add(normP));
					} else {
						next.delete(normP);
					}
					return next;
				});
			}
		},
		[currentCwd, panelSend],
	);

	/** 智能去重：当且仅当 split 模式下运行列表展开且有内容时，已在上方运行列表中展示的本地会话不重复占用下方历史列表视线。 */
	const activeRunningFiles = useMemo(() => {
		if (convTab !== "split" || collapseConvs || conversations.length === 0) return new Set<string>();
		const files = new Set<string>();
		for (const c of conversations) {
			if (c.sessionFile) files.add(normalizeSessionPathKey(c.sessionFile));
		}
		return files;
	}, [convTab, collapseConvs, conversations]);

	const filteredSessions = useMemo(() => {
		if (activeRunningFiles.size === 0) return sessions;
		return sessions.filter((s) => !activeRunningFiles.has(normalizeSessionPathKey(s.path)));
	}, [sessions, activeRunningFiles]);

	const visibleSessions = useMemo(() => {
		if (filteredSessions.length <= visibleSessionCount) return filteredSessions;
		const normCur = normalizeSessionPathKey(currentFile);
		const activeIdx = normCur ? filteredSessions.findIndex((s) => normalizeSessionPathKey(s.path) === normCur) : -1;
		const cap = activeIdx >= visibleSessionCount ? activeIdx + 10 : visibleSessionCount;
		return filteredSessions.slice(0, cap);
	}, [filteredSessions, visibleSessionCount, currentFile]);
	/** 会话右键菜单（`contextmenu.session` 槽位）：见下面的 showSessionMenu / openSessionMenu /
	 *  dispatchHostSessionEntry。宿主自己的两条（关闭已结束子代理 / 强行关闭对话）也在这个槽位里，
	 *  与插件贡献的条目同排 —— 插件条目由 App 分发给插件，host 条目由本组件分派。 */
	/** scope 内已结束（非 streaming、非当前）的子代理数量——后端按同样口径
	 *  批量移出；为 0 时菜单项禁用。 */
	const finishedSubagentCount = useCallback(
		(list: ConversationSummary[], scopeId?: string): number => {
			if (!scopeId) return list.filter((c) => c.isSubagent && !c.isStreaming && c.id !== activeConversationId).length;
			const byId = new Map(list.map((c) => [c.id, c]));
			const inScope = (c: ConversationSummary): boolean => {
				if (c.id === scopeId)
					return (byId.get(scopeId)?.isSubagent ?? false) && !c.isStreaming && c.id !== activeConversationId;
				let cur: ConversationSummary | undefined = c;
				const seen = new Set<string>();
				while (cur?.parentId) {
					if (cur.parentId === scopeId) return true;
					if (seen.has(cur.parentId)) return false;
					seen.add(cur.parentId);
					cur = byId.get(cur.parentId);
					if (!cur) return false;
				}
				return false;
			};
			return list.filter((c) => c.isSubagent && !c.isStreaming && c.id !== activeConversationId && inScope(c)).length;
		},
		[activeConversationId],
	);

	/** scope 内全部子代理后代数量（不限状态：运行中/已结束/保留中都算）——
	 *  强行全关按钮的计数口径；口径与 finishedSubagentCount 的 inScope 一致。 */
	const countScopeSubagents = useCallback((list: ConversationSummary[], scopeId?: string): number => {
		if (!scopeId) return list.filter((c) => c.isSubagent).length;
		const byId = new Map(list.map((c) => [c.id, c]));
		const inScope = (c: ConversationSummary): boolean => {
			if (c.id === scopeId) return byId.get(scopeId)?.isSubagent ?? false;
			let cur: ConversationSummary | undefined = c;
			const seen = new Set<string>();
			while (cur?.parentId) {
				if (cur.parentId === scopeId) return true;
				if (seen.has(cur.parentId)) return false;
				seen.add(cur.parentId);
				cur = byId.get(cur.parentId);
				if (!cur) return false;
			}
			return false;
		};
		return list.filter((c) => c.isSubagent && inScope(c)).length;
	}, []);

	/** scope 下运行中（streaming）的子代理后代数量——混合情况
	 *  （有运行、也有已结束）同样提示连带关闭，但只关不运行的：
	 *  运行中的不受影响、父对话暂留。口径与 finishedSubagentCount 的 inScope 一致。 */
	const countRunningSubagentDescendants = useCallback((list: ConversationSummary[], scopeId?: string): number => {
		if (!scopeId) return 0;
		const byId = new Map(list.map((c) => [c.id, c]));
		const inScope = (c: ConversationSummary): boolean => {
			let cur: ConversationSummary | undefined = c;
			const seen = new Set<string>();
			while (cur?.parentId) {
				if (cur.parentId === scopeId) return true;
				if (seen.has(cur.parentId)) return false;
				seen.add(cur.parentId);
				cur = byId.get(cur.parentId);
				if (!cur) return false;
			}
			return false;
		};
		return list.filter((c) => c.isSubagent && c.isStreaming && inScope(c)).length;
	}, []);

	/** issue #145 行类型：运行的对话 = 本客户端 + 其他标签页/设备（elsewhere 只读行，标“另一处”）。 */
	/** 上次打开会话菜单的坐标 + 目标：强行关闭的两段确认要在**原地**把菜单换成确认文案
	 *  （老实现直接改自己那套菜单的 label；菜单搬到 App 之后只能按同一坐标重开一次）。 */
	const sessionMenuRef = useRef<{ x: number; y: number; target: SessionMenuTarget } | null>(null);
	/** 已 arm 的 scopeId（强行关闭的第一段确认）：点第二次才真关。每次重新打开菜单都复位
	 *  （老实现在关闭菜单时复位）——两段确认不能跨菜单生效。 */
	const forceArmedRef = useRef<string | null>(null);
	/** 菜单要用的 host 分派器（在下面定义）：showSessionMenu 在渲染期就要把它交给菜单，
	 *  而分派器又要反过来用 showSessionMenu 重开菜单 —— 用一个 ref 打破这个循环。 */
	const hostActionRef = useRef<(entry: UiSlotEntry, target: ContextMenuRequest["target"]) => void | boolean>(() => {});

	/** 该槽位当前有没有可显示的东西（host 内置 + 插件贡献，hidden 不算）：一条都没有就别抢
	 *  浏览器菜单——弹个空菜单比不弹更糟，还会顺手废掉「检查元素 / 复制」（口径同 Message.tsx）。 */
	const sessionMenuAvailable = contextMenuItems(uiContextSession ?? []).length > 0;

	/** 组装 contextmenu.session 的条目并推向**全局**菜单（ContextMenu 实例在 App 里，
	 *  条目渲染与点击分发都走 context-menu-state.ts 那条通道）。
	 *
	 *  target 约定（决定操作范围）：
	 *    kind="running"  → id 是运行中对话的 id（含子代理）；
	 *    kind="history"  → id 是历史会话的 session 文件路径（不带 conversation id）；
	 *    kind="section"  → id 为空串，表示「整个运行对话区」= 不限 scope。
	 *
	 *  host 那两条：文案带 `{n}` 占位符（ui-slots.ts 的 BuiltinUiItem 约定：buildUiSlots
	 *  只做无参 t()，占位符要由渲染层自己补参）——所以这里按 scope 的计数重写 label；
	 *  计数为 0 时用 `when: ["disabled"]` 置灰（context-menu-state.ts 约定的置灰标记），
	 *  而不把条目抽掉：用户至少看得见「这里本来有个操作」。「强行关闭」只在对话行出现
	 *  （作用范围就是那条对话），历史行 / 区域空白处 hidden —— 与老菜单一致。 */
	const showSessionMenu = useCallback(
		(x: number, y: number, target: SessionMenuTarget) => {
			sessionMenuRef.current = { x, y, target };
			// scope：只有「运行中对话行」才限定到具体对话；历史行与区域空白处都是全局口径。
			// 「另一处」行：id 即对方会话内的 convId（复制 id / 引用可用它），
			// 但关闭类条目不适用（那是本会话的 dismissal 口径）。
			const scopeId = target.kind === "running" ? target.id : undefined;
			const isElsewhere = target.kind === "elsewhere";
			const takeId = scopeId ?? (isElsewhere ? target.id || undefined : undefined);
			const armedTarget = scopeId ?? (isElsewhere ? takeId : undefined);
			const nFinished = finishedSubagentCount(conversations, scopeId);
			const label =
				nFinished === 0
					? t("noFinishedSubagents")
					: scopeId
						? t("dismissFinishedSubagentsScoped", { n: nFinished })
						: t("dismissFinishedSubagents", { n: nFinished });
			const armed = Boolean(armedTarget) && forceArmedRef.current === armedTarget;
			const entries = (uiContextSession ?? []).map((entry) => {
				// 插件贡献的条目原样透传（点击由 App 分发给插件）。
				if (entry.source !== "host") return entry;
				// 重命名：运行中对话行与历史行才有；区域空白处 /「另一处」行隐藏
				// （与悬停 ✎ 铅笔同一套内嵌输入框，见 dispatchHostSessionEntry）。
				if (entry.id === "host:conv-rename")
					return target.kind === "running" || target.kind === "history" ? entry : { ...entry, hidden: true };
				// 过户：只在「另一处」行出现（无 owner/convId 的旧条目与定时任务 scheduler 条目隐藏；插件会话支持过户）。
				if (entry.id === "host:conv-takeover") {
					const isScheduler = Boolean(target.pseudo && target.owner?.startsWith("scheduler:"));
					const isShared = elsewhere.some(
						(w) => w.owner === target.owner && w.convId === takeId && w.independent === false,
					);
					return isElsewhere && takeId && target.owner && !isScheduler && !isShared
						? entry
						: { ...entry, hidden: true };
				}
				// 关闭子代理只针对本地有后代的运行中对话
				if (isElsewhere && entry.id === "host:conv-dismiss-subagents") return { ...entry, hidden: true };
				if (entry.id === "host:conv-dismiss-subagents")
					return { ...entry, label, ...(nFinished === 0 ? { when: [...(entry.when ?? []), "disabled"] } : {}) };
				if (entry.id === "host:conv-force-dismiss")
					return armedTarget
						? { ...entry, ...(armed ? { label: t("forceDismissConfirm") } : {}) }
						: { ...entry, hidden: true };
				// 钉住 / 取消钉住：在运行中的主对话行或历史行出现（子代理本来就永久保留，钉住无意义；「另一处」行不适用）。
				if (entry.id === "host:conv-pin") {
					if (target.kind === "history") {
						const isPinned = sessions.find((s) => s.path === target.id)?.pinned;
						return isPinned ? { ...entry, label: t("unpinConversation") } : entry;
					}
					if (!scopeId) return { ...entry, hidden: true };
					const pinTarget = conversations.find((c) => c.id === scopeId);
					if (!pinTarget || pinTarget.isSubagent) return { ...entry, hidden: true };
					return pinTarget.pinned ? { ...entry, label: t("unpinConversation") } : entry;
				}
				// 固化子代理/临时对话为普通对话：只在内存会话（未落盘、isSubagent 或临时）行显示
				if (entry.id === "host:conv-persist") {
					if (!scopeId) return { ...entry, hidden: true };
					const targetConv = conversations.find((c) => c.id === scopeId);
					const canPersist = Boolean(targetConv && (targetConv.isSubagent || !targetConv.sessionFile));
					if (!canPersist) return { ...entry, hidden: true };
					// 临时对话用「保存为正式对话」而非「固化子代理」措辞（用户视角不是子代理）。
					return targetConv?.isEphemeral ? { ...entry, label: t("saveEphemeral") } : entry;
				}
				// 对话引用三件套：复制 id 运行中对话行与「另一处」行都有（后者是对方会话内的
				// convId）；复制路径历史行恒有、运行中仅落盘的有（inMemory 子代理没有文件，
				// 「另一处」行没有文件信息 → 上面的 scopeId 分支已隐藏）；引用三者皆可，
				// 区域空白处直接隐藏。
				if (entry.id === "host:conv-copy-id") return takeId ? entry : { ...entry, hidden: true };
				if (entry.id === "host:conv-copy-path") {
					if (target.kind === "history") return entry;
					if (!scopeId) return { ...entry, hidden: true };
					const hasFile = conversations.some((c) => c.id === scopeId && c.sessionFile);
					return hasFile ? entry : { ...entry, when: [...(entry.when ?? []), "disabled"] };
				}
				if (entry.id === "host:conv-copy-link") {
					if (target.kind === "history") {
						const sess = sessions.find((s) => s.path === target.id);
						const sid = sess?.sessionId || extractSessionIdFromPath(target.id);
						return sid ? entry : { ...entry, hidden: true };
					}
					if (!scopeId) return { ...entry, hidden: true };
					const conv = conversations.find((c) => c.id === scopeId);
					const sid = conv?.sessionId || extractSessionIdFromPath(conv?.sessionFile);
					return sid ? entry : { ...entry, when: [...(entry.when ?? []), "disabled"] };
				}
				if (entry.id === "host:conv-quote")
					return capabilities.conversationRef && (takeId || target.kind === "history")
						? entry
						: { ...entry, hidden: true };
				return entry;
			});
			openContextMenu({
				x,
				y,
				slot: "contextmenu.session",
				target,
				entries,
				// host 条目（上面那两条内置项）的分派器：实现就在本组件里，见 dispatchHostSessionEntry。
				onHostAction: (entry, tgt) => hostActionRef.current(entry, tgt),
			});
		},
		[uiContextSession, conversations, elsewhere, finishedSubagentCount, t, capabilities.conversationRef],
	);

	/** host 内置条目的分派：作用范围（scopeId）来自打开菜单时记下的 target。
	 *  强行关闭保留老实现的两段确认：第一次点 = 武装 + 把菜单原地换成「确认强行关闭？」
	 *  （返回 true 让 ContextMenu 先别关，见 ContextMenuRequest.onHostAction），
	 *  第二次点才真发 `dismiss_conversation(force)`。 */
	const dispatchHostSessionEntry = useCallback(
		(entry: UiSlotEntry, target: ContextMenuRequest["target"]): void | boolean => {
			const scopeId = target.kind === "running" ? target.id : undefined;
			// 复制 id / 引用的实际对象：运行中行是本会话 conv，「另一处」行是对方会话 conv。
			const takeId = scopeId ?? (target.kind === "elsewhere" ? target.id || undefined : undefined);
			if (entry.id === "host:conv-takeover") {
				if (target.kind === "elsewhere" && takeId && target.owner) {
					panelSend({ type: "take_over_conversation", owner: target.owner, id: takeId });
				}
				return;
			}
			if (entry.id === "host:conv-dismiss-subagents") {
				// 对话行 = 只关这条对话下的（含嵌套）；区域空白处 = 全部已结束的。
				if (scopeId) panelSend({ type: "dismiss_finished_subagents", parentId: scopeId });
				else panelSend({ type: "dismiss_finished_subagents" });
				return;
			}
			if (entry.id === "host:conv-force-dismiss") {
				const last = sessionMenuRef.current;
				const targetId = scopeId ?? (target.kind === "elsewhere" ? takeId : undefined);
				if (!targetId || !last) return;
				if (forceArmedRef.current !== targetId) {
					forceArmedRef.current = targetId;
					showSessionMenu(last.x, last.y, last.target);
					return true; // 菜单保持打开：它已经被换成「确认强行关闭？」那一版
				}
				forceArmedRef.current = null;
				panelSend({
					type: "dismiss_conversation",
					id: targetId,
					force: true,
					...(target.kind === "elsewhere" && target.owner ? { owner: target.owner } : {}),
				});
				return;
			}
			if (entry.id === "host:conv-persist") {
				if (scopeId) panelSend({ type: "persist_conversation", id: scopeId });
				return;
			}
			// 钉住 / 取消钉住：按当前状态翻转（菜面文案已按状态给过用户正确预期）。
			if (entry.id === "host:conv-pin") {
				if (target.kind === "history") {
					const cur = sessions.find((s) => s.path === target.id);
					panelSend({ type: "pin_session", path: target.id, pinned: !cur?.pinned });
					return;
				}
				if (scopeId) {
					const cur = conversations.find((c) => c.id === scopeId);
					panelSend({ type: "pin_conversation", id: scopeId, pinned: !cur?.pinned });
				}
				return;
			}
			// 对话引用三件套（复制 id / 复制会话文件路径 / 引用到输入框）。
			if (entry.id === "host:conv-copy-id" && takeId) {
				void navigator.clipboard?.writeText(takeId).catch(() => {});
				return;
			}
			if (entry.id === "host:conv-copy-path") {
				const text =
					target.kind === "history"
						? target.id
						: (scopeId && conversations.find((c) => c.id === scopeId)?.sessionFile) || undefined;
				if (text) void navigator.clipboard?.writeText(text).catch(() => {});
				return;
			}
			if (entry.id === "host:conv-copy-link") {
				const sid =
					target.kind === "history"
						? sessions.find((s) => s.path === target.id)?.sessionId || extractSessionIdFromPath(target.id)
						: scopeId
							? conversations.find((c) => c.id === scopeId)?.sessionId ||
								extractSessionIdFromPath(conversations.find((c) => c.id === scopeId)?.sessionFile)
							: null;
				if (sid) {
					const url = buildSessionDeepLink(window.location.href, { sessionId: sid });
					void navigator.clipboard?.writeText(url).catch(() => {});
				}
				return;
			}
			if (entry.id === "host:conv-quote") {
				if (target.kind === "history" && target.id) {
					composeToComposer({
						attachments: [
							{
								path: "",
								key: `conv||${target.id}`,
								name: target.label || target.id,
								mode: "conversation",
								sessionPath: target.id,
							},
						],
					});
				} else if (takeId) {
					composeToComposer({
						attachments: [
							{
								path: "",
								key: `conv|${takeId}|`,
								name: target.label || takeId,
								mode: "conversation",
								conversationId: takeId,
							},
						],
					});
				}
				return;
			}
			// 重命名：切出该行内嵌的重命名输入框（与悬停 ✎ 同一套 renaming state）。
			// 菜单直接关闭（返回 undefined），输入框的 autoFocus 负责聚焦。
			if (entry.id === "host:conv-rename") {
				setConfirmDel(null);
				if (scopeId) {
					const conv = conversations.find((c) => c.id === scopeId);
					setRenameDraft(conv?.title ?? target.label ?? "");
					setRenaming(`conv:${scopeId}`);
				} else if (target.kind === "history" && target.id) {
					const sess = sessions.find((s) => s.path === target.id);
					setRenameDraft(sess?.name ?? target.label ?? "");
					setRenaming(target.id);
				}
				return;
			}
		},
		[panelSend, showSessionMenu, conversations, sessions],
	);
	// 每次渲染把最新闭包挂给菜单用的那个 ref（同 App 的 chatRefForPlugins / ContextMenu 的
	// activateRef：挂在 render 上的 ref，不是副作用）。
	hostActionRef.current = dispatchHostSessionEntry;

	/** `leftpanel.sessions` 会话行内嵌区：每条会话行尾渲染同一组条目（icon button，
	 *  title=hint||label，点击交回 onUiAction；badge kind 只显示 badge 文本）。
	 *  无条目时返回 null —— 会话行 DOM 与旧版一字不差。 */
	/** 内嵌条目通用渲染（会话行 / 项目行 / 分区标题栏共用同一套形状与点击口径）。
	 *  wrapClass 决定外层样式钩子；target 有值时点击按钮把它回传给插件（项目行用）。
	 *  无条目返回 null —— 调用方不留占位，DOM 与旧版一字不差。 */
	const renderInlineEntries = (
		rows: UiSlotEntry[] | undefined,
		wrapClass: string,
		target?: { id: string; kind?: string; label?: string },
	) => {
		if (!rows || rows.length === 0) return null;
		return (
			<span className={wrapClass}>
				{rows.map((entry, i) => {
					const key = `${entry.id}#${i}`;
					const label = entry.label || entry.id;
					const tip = entry.hint || label;
					if (entry.kind === "divider") return <span key={key} className="lp-slot-divider" aria-hidden="true" />;
					if (entry.kind === "badge")
						return (
							<span key={key} className="lp-slot-badge" title={tip}>
								{entry.badge ?? label}
							</span>
						);
					// kind="select"：会话行内嵌小下拉（点行即打开会话，所以要 stopPropagation）。
					if (entry.kind === "select" && entry.options?.length)
						return (
							<select
								key={key}
								className="lp-slot-select"
								title={tip}
								aria-label={label}
								value={
									entry.options.some((o) => o.value === entry.value) ? (entry.value as string) : entry.options[0]!.value
								}
								onClick={(e) => e.stopPropagation()}
								onChange={(e) => {
									e.stopPropagation();
									onUiAction?.(entry, e.target.value);
								}}
							>
								{entry.options.map((o) => (
									<option key={o.value} value={o.value}>
										{o.label}
									</option>
								))}
							</select>
						);
					return (
						<button
							key={key}
							type="button"
							className="lp-slot-btn"
							title={tip}
							aria-label={label}
							onClick={(e) => {
								e.stopPropagation();
								if (target) onUiAction?.(entry, undefined, target);
								else onUiAction?.(entry);
							}}
						>
							{entry.icon ? <span aria-hidden>{entry.icon}</span> : <span>{label}</span>}
						</button>
					);
				})}
			</span>
		);
	};

	/** 会话行 / 运行对话区空白处右键 → 开菜单。每次打开都复位强关的 arm
	 *  （老实现是关闭菜单时复位）：重新打开必须重新确认一次。 */
	const openSessionMenu = useCallback(
		(e: React.MouseEvent, target: SessionMenuTarget) => {
			// 重命名输入框里的右键留给浏览器（见 isEditableTarget）。
			if (isEditableTarget(e.target)) return;
			// 槽位没有可显示的条目（未接线 / 内置两条被隐藏 / 插件也没贡献）→ 交回浏览器。
			if (!sessionMenuAvailable) return;
			e.preventDefault();
			// 行上的处理器要拦冒泡：整个运行对话区（含空白处）也有一个右键处理器。
			e.stopPropagation();
			forceArmedRef.current = null;
			showSessionMenu(e.clientX, e.clientY, target);
		},
		[sessionMenuAvailable, showSessionMenu],
	);

	type RowConv = ConversationSummary & {
		elsewhere?: boolean;
		owner?: string;
		convId?: string;
		hasQuestion?: boolean;
		pseudo?: boolean;
		independent?: boolean;
		/** 持有方页面已断开（标签页/浏览器关了），只剩服务端残留会话：行仍可过户。 */
		ownerOffline?: boolean;
	};
	const panelRef = useRef<HTMLElement>(null);
	const [weights, setWeights] = useState<LpWeights>(() => loadLpWeights());
	useEffect(() => {
		try {
			localStorage.setItem(LS_LP_SIZES, JSON.stringify(weights));
		} catch {}
	}, [weights]);

	/** issue #145：运行的对话 = 本客户端会话 + 其他标签页/设备的运行（后者只读行）。
	 *  防重护栏：
	 *  1) 排除已在本地 conversations 中存在的会话（按 sessionFile 或 cwd+title），避免同一会话既当前又“另一处”；
	 *  2) 针对 elsewhere 条目按 sessionFile / cwd+title 再次做防重，避免多处上报时在左栏堆叠相同行。
	 */
	const runningAll: RowConv[] = useMemo(() => {
		const localFiles = new Set<string>();
		const localCwdTitles = new Set<string>();
		for (const c of conversations) {
			if (c.sessionFile) localFiles.add(c.sessionFile);
			localCwdTitles.add(`${c.cwd}\0${c.title}`);
		}

		const filteredElsewhere: RowConv[] = [];
		const seenKeys = new Set<string>();

		for (const w of elsewhere) {
			if (!w.convId && w.independent !== false) {
				if (w.sessionFile && localFiles.has(w.sessionFile)) continue;
				if (localCwdTitles.has(`${w.cwd}\0${w.title}`)) continue;
			}

			const key = w.convId
				? `conv:${w.owner}:${w.convId}`
				: w.sessionFile
					? `file:${w.sessionFile}`
					: `title:${w.cwd}\0${w.title}`;
			if (seenKeys.has(key)) continue;
			seenKeys.add(key);

			filteredElsewhere.push({
				id:
					w.convId && w.owner
						? `elsewhere:${w.owner}:${w.convId}`
						: w.sessionFile
							? `elsewhere:${w.owner}:${w.cwd}:${w.sessionFile}`
							: `elsewhere:${w.cwd}:${w.title}${w.owner ? `:${w.owner}` : ""}`,
				title: w.title,
				cwd: w.cwd,
				messageCount: 0,
				isStreaming: w.isStreaming,
				isSubagent: false as const,
				elsewhere: true as const,
				pseudo: Boolean(w.pseudo),
				independent: w.independent,
				ownerOffline: Boolean(w.ownerOffline),
				sessionFile: w.sessionFile,
				// 过户目标定位（无则沿用旧行为：只读行，无过户入口）。
				...(w.owner && w.convId ? { owner: w.owner, convId: w.convId } : {}),
				...(w.hasQuestion ? { hasQuestion: true as const } : {}),
			});
		}

		return [...conversations, ...filteredElsewhere];
	}, [conversations, elsewhere]);

	interface HistoryRunningInfo {
		conv: RowConv;
		isStreaming: boolean;
		hasQuestion: boolean;
		hasError: boolean;
		error?: string;
	}

	/** 历史会话运行态索引：以规范化路径/sessionId 快速映射当前处于运行态或运行列表中的对话 */
	const runningInfoBySession = useMemo(() => {
		const byId = new Map<string, RowConv>();
		const kids = new Map<string, RowConv[]>();
		for (const c of runningAll) {
			byId.set(c.id, c);
		}
		for (const c of runningAll) {
			if (c.parentId && byId.has(c.parentId)) {
				const arr = kids.get(c.parentId) ?? [];
				arr.push(c);
				kids.set(c.parentId, arr);
			}
		}

		const getDescendants = (id: string): RowConv[] => {
			const res: RowConv[] = [];
			const queue = [...(kids.get(id) ?? [])];
			const visited = new Set<string>();
			while (queue.length > 0) {
				const item = queue.shift()!;
				if (visited.has(item.id)) continue;
				visited.add(item.id);
				res.push(item);
				const sub = kids.get(item.id);
				if (sub) queue.push(...sub);
			}
			return res;
		};

		const map = new Map<string, HistoryRunningInfo>();

		for (const c of runningAll) {
			const descendants = getDescendants(c.id);
			const hasStreaming = descendants.some((d) => d.isStreaming || d.completionPending);
			const hasQuestion = descendants.some((d) => Boolean(d.hasQuestion));
			const hasError = descendants.some((d) => Boolean(d.error));

			const isStreaming = Boolean(c.isStreaming || c.completionPending || hasStreaming);
			const question = Boolean(c.hasQuestion || hasQuestion);
			const err = Boolean(c.error || hasError);

			const info: HistoryRunningInfo = {
				conv: c,
				isStreaming,
				hasQuestion: question,
				hasError: err,
				error: c.error,
			};

			if (c.sessionFile) {
				const normF = normalizeSessionPathKey(c.sessionFile);
				map.set(`file:${normF}`, info);
				const fn = normF.split("/").pop();
				if (fn) map.set(`fn:${fn}`, info);
				const sidFromF = extractSessionIdFromPath(c.sessionFile);
				if (sidFromF) map.set(`sid:${sidFromF.toLowerCase()}`, info);
			}
			if (c.sessionId) {
				map.set(`sid:${c.sessionId.trim().toLowerCase()}`, info);
			}
			map.set(`conv:${c.id}`, info);
		}

		return map;
	}, [runningAll]);

	const getHistoryRunningInfo = useCallback(
		(s: SessionSummary): HistoryRunningInfo | undefined => {
			if (s.path.startsWith("conv:") && runningInfoBySession.has(s.path)) {
				return runningInfoBySession.get(s.path);
			}
			const normP = normalizeSessionPathKey(s.path);
			if (runningInfoBySession.has(`file:${normP}`)) {
				return runningInfoBySession.get(`file:${normP}`);
			}
			if (s.sessionId && runningInfoBySession.has(`sid:${s.sessionId.trim().toLowerCase()}`)) {
				return runningInfoBySession.get(`sid:${s.sessionId.trim().toLowerCase()}`);
			}
			const fn = normP.split("/").pop();
			if (fn && runningInfoBySession.has(`fn:${fn}`)) {
				return runningInfoBySession.get(`fn:${fn}`);
			}
			const sidFromPath = extractSessionIdFromPath(s.path);
			if (sidFromPath && runningInfoBySession.has(`sid:${sidFromPath.toLowerCase()}`)) {
				return runningInfoBySession.get(`sid:${sidFromPath.toLowerCase()}`);
			}
			return undefined;
		},
		[runningInfoBySession],
	);
	// P2：分区顺序与显隐（宏观来自宿主 leftpanel.sections 的合并结果；布局页可隐藏 / 调序）。
	const sectionPlan = withDeviceGroupSection(planLeftSections(uiSections));
	const shownPlan = sectionPlan.filter((p) => p.shown);

	/**
	 * 实际作为顶层参与纵向排版的分区：
	 * 1) convs 与 sessions 已作为统一对话树整合进 projects，不再作为独立顶层分区展示；
	 * 2) 工作区（projects + groups）：当 projects 可见时，groups 内嵌展示，不作为独立顶层分区；
	 * 3) 插件自定义分区（plugin:*）继续保留在下方，并支持自由折叠与拖动调整大小。
	 */
	const effectivePlan = useMemo(() => {
		return shownPlan.filter((p) => {
			if (p.key === "convs" || p.key === "sessions") return false;
			if (workspaceTab !== "split" && shownPlan.some((x) => x.key === "projects") && p.key === "groups") {
				return false;
			}
			return true;
		});
	}, [shownPlan, workspaceTab]);

	const collapsedOf = useCallback(
		(k: LpSectionKey): boolean =>
			k === "projects"
				? collapseProjects || (workspaceTab === "projects" && projects.length === 0)
				: k === "convs"
					? collapseConvs
					: k === "sessions"
						? collapseSessions
						: k === "groups"
							? collapseGroups
							: pluginCollapsed.has(k),
		[collapseProjects, workspaceTab, projects.length, collapseConvs, collapseSessions, collapseGroups, pluginCollapsed],
	);

	/** 参与权重的分区：显示中且有内容（项目区需有项目/群组，会话区需有会话/运行条目）。 */
	/** P3：运行分区的条目数 = 对话（含另一处）+ 插件运行条目；两者任一有就显示分区。 */
	const pluginItemCount = (uiPluginRunning ?? []).reduce((n, g) => n + g.items.length, 0);
	const runningCount = runningAll.length + pluginItemCount;

	useEffect(() => {
		if (runningCount === 0 && convTab === "running") {
			setConvTab("stream");
		}
	}, [runningCount, convTab]);

	const flexKeys = useMemo(
		() =>
			effectivePlan
				.filter((p) => {
					if (p.key === "projects") {
						return workspaceTab !== "split" ? projects.length > 0 || groupCount > 0 : projects.length > 0;
					}
					if (p.key === "convs" || p.key === "sessions") return false;
					return true;
				})
				.map((p) => p.key),
		[effectivePlan, workspaceTab, projects.length, groupCount],
	);
	/** P3：插件运行条目分组（运行分区列表体末尾）。无条目返回 null，DOM 与改造前一致。 */
	const renderPluginRunning = () => {
		const groups = uiPluginRunning ?? [];
		if (groups.length === 0) return null;
		return groups.map((g) => (
			<div key={`plugin:${g.pluginId}`} className="panel-conv-group lp-plugin-group">
				<div className="panel-conv-group-title" title={g.pluginId}>
					{t("leftPanelPluginGroup")} · {g.pluginName}
				</div>
				{g.items.map((it) => (
					<div key={it.id} className="lp-row lp-plugin-row">
						<button
							type="button"
							className={`session-item lp-plugin-item${it.action ? "" : " is-static"}`}
							title={it.hint ? `${it.title} — ${it.hint}` : it.title}
							onClick={() => onPluginRunningAction?.(g, it)}
						>
							<span className={`lp-plugin-dot st-${it.status}`} title={t(PLUGIN_STATUS_KEY[it.status])} />
							{it.icon ? (
								<span className="lp-plugin-icon" aria-hidden>
									{it.icon}
								</span>
							) : null}
							<span className="session-info">
								<span className="session-title">{it.title}</span>
								{it.hint ? <span className="session-sub">{it.hint}</span> : null}
							</span>
						</button>
					</div>
				))}
			</div>
		));
	};
	/** 行内插件位：运行行 / 历史行各用自己的合并槽位；leftpanel.sessions 是两者的并集。 */
	const runningRowEntries = useMemo(
		() => [...(uiLeftSessions ?? []), ...(uiLeftRunning ?? [])],
		[uiLeftSessions, uiLeftRunning],
	);
	const historyRowEntries = useMemo(
		() => [...(uiLeftSessions ?? []), ...(uiLeftHistory ?? [])],
		[uiLeftSessions, uiLeftHistory],
	);

	const createSashHandler = useCallback(
		(aboveKey: LpSectionKey, belowKey: LpSectionKey) => (e: React.PointerEvent<HTMLDivElement>) => {
			e.preventDefault();
			const target = e.currentTarget;
			const startY = e.clientY;
			const start = { ...weights };
			const panel = panelRef.current;
			if (!panel) return;
			const collapsedCount = flexKeys.filter((k) => collapsedOf(k)).length;
			const expandedKeys = flexKeys.filter((k) => !collapsedOf(k));
			const totalWeight = expandedKeys.reduce((sum, k) => sum + (start[k] ?? 1), 0) || 1;
			const available = Math.max(120, panel.clientHeight - collapsedCount * LP_COLLAPSED_HEADER_PX);
			target.classList.add("dragging");
			document.body.classList.add("lp-resizing");
			const onMove = (ev: PointerEvent) => {
				const { above, below } = applySashDrag({
					start: { above: start[aboveKey] ?? 1, below: start[belowKey] ?? 1 },
					deltaPx: ev.clientY - startY,
					availablePx: available,
					totalWeight,
					minAbovePx: LP_MIN_SECTION_PX,
					minBelowPx: LP_MIN_SECTION_PX,
				});
				setWeights((prev) => ({ ...prev, [aboveKey]: above, [belowKey]: below }));
			};
			const onUp = () => {
				window.removeEventListener("pointermove", onMove);
				window.removeEventListener("pointerup", onUp);
				target.classList.remove("dragging");
				document.body.classList.remove("lp-resizing");
			};
			window.addEventListener("pointermove", onMove);
			window.addEventListener("pointerup", onUp);
		},
		[weights, flexKeys, collapsedOf],
	);

	useEffect(() => {
		if (!active || !ready || status !== "open") return;
		if (!cwd) return;
		panelSend({ type: "list_sessions" });
		panelSend({ type: "list_projects" });
	}, [active, ready, status, cwd, panelSend]);

	const displayName = (s: SessionSummary): string => {
		const title = s.displayName || s.name || s.firstMessage?.trim();
		return title && title.length > 0 ? title : t("emptyChat");
	};

	const projectName = (path: string): string => path.split(/[\\/]/).pop() || path;

	/** `contextmenu.project`：项目行右键（纯插件位，宿主无内置条目）。与会话菜单同口径：
	 *  输入类元素让给浏览器；槽位没有可见条目时不抢右键，交回浏览器（检查元素 / 复制照常）。 */
	const projectMenuAvailable = contextMenuItems(uiContextProject ?? []).length > 0;
	const openProjectMenu = useCallback(
		(e: React.MouseEvent, project: ProjectSummary) => {
			if (isEditableTarget(e.target)) return;
			if (!projectMenuAvailable) return;
			e.preventDefault();
			e.stopPropagation();
			openContextMenu({
				x: e.clientX,
				y: e.clientY,
				slot: "contextmenu.project",
				target: { id: project.path, kind: "project", label: projectName(project.path) },
				entries: uiContextProject ?? [],
			});
		},
		[projectMenuAvailable, uiContextProject],
	);

	const delButton = (key: string, hint: string, confirmHint: string, onConfirm: () => void, icon?: React.ReactNode) => {
		const armed = confirmDel === key;
		return (
			<button
				type="button"
				className={`lp-del ${armed ? "confirm" : ""}`}
				title={armed ? confirmHint : hint}
				onClick={(e) => {
					e.stopPropagation();
					if (armed) {
						setConfirmDel(null);
						onConfirm();
					} else {
						setConfirmDel(key);
					}
				}}
			>
				{armed ? <FiCheck /> : (icon ?? <FiTrash2 />)}
			</button>
		);
	};

	const sectionHeader = (
		title: string,
		collapsed: boolean,
		onToggle: () => void,
		count?: number,
		actions?: React.ReactNode,
		/** 插件追加的标题栏按钮（leftpanel.*.actions）：排在宿主按钮之后；无条目时为 null。 */
		pluginActions?: React.ReactNode,
	) => (
		<div className="lp-section-header">
			<button
				type="button"
				className="lp-section-title panel-section-title"
				onClick={onToggle}
				title={collapsed ? t("expandSection") : t("collapseSection")}
			>
				<span className="lp-section-title-text">
					{title}
					{count !== undefined ? ` (${count})` : ""}
				</span>
				<span className="lp-section-chevron">{collapsed ? <FiChevronDown /> : <FiChevronUp />}</span>
			</button>
			{actions || pluginActions ? (
				<div className="lp-section-actions">
					{actions}
					{pluginActions}
				</div>
			) : null}
		</div>
	);

	// 归一化权重：单展开时强制 flex=1 填满；多展开时按权重比例均值归一，避免 0.539 这类小数导致容器留空
	const expandedForFlex = flexKeys.filter((k) => !collapsedOf(k));
	const totalWeightForFlex = expandedForFlex.reduce((sum, k) => sum + (weights[k] ?? 1), 0) || 1;
	const effFlex = (k: LpSectionKey) => {
		if (expandedForFlex.length <= 1) return 1;
		const w = weights[k] ?? 1;
		return (w / totalWeightForFlex) * expandedForFlex.length;
	};
	/** 相邻两个展开的 flex 分区之间的分隔条（挂在上方分区后面；拖动与双击复位同改造前）。 */
	const sashAfter = new Map<LpSectionKey, React.ReactNode>(
		sashPairs(flexKeys, collapsedOf).map(([above, below]): [LpSectionKey, React.ReactNode] => [
			above,
			<div
				key={`sash-${above}`}
				className="lp-sash"
				role="separator"
				aria-orientation="horizontal"
				onPointerDown={createSashHandler(above, below)}
				onDoubleClick={() => setWeights({ ...DEFAULT_LP_WEIGHTS })}
				title={t("dragToResize")}
			/>,
		]),
	);

	/** 双击左栏各分区列表空白处（非条目行、非交互元素）：快速创建新对话并聚焦输入框 */
	const handleBlankDoubleClick = useCallback(
		(e: React.MouseEvent) => {
			const target = e.target as HTMLElement | null;
			if (!target) return;
			if (target.closest(".lp-row") || target.closest("button, input, select, textarea, a")) {
				return;
			}
			panelSend({ type: "new_chat" });
			focusComposer();
		},
		[panelSend],
	);

	// P2：分区节点（内容与改造前的 JSX 逐字相同，只是改由下面的计划按序挂载）。
	/** P3：渲染历史会话单行（形态 A：左侧文字绝对对齐 + 状态指示器与类别徽标全部右置） */
	const renderHistorySessionRow = (s: SessionSummary, projectPath?: string) => {
		const normCur = normalizeSessionPathKey(currentFile);
		const normPath = normalizeSessionPathKey(s.path);
		const active = Boolean(normCur && normCur === normPath);
		const switching = transition?.kind === "session" && normalizeSessionPathKey(transition.target) === normPath;
		const runInfo = getHistoryRunningInfo(s);
		const isStreaming = Boolean(runInfo?.isStreaming);
		const hasQuestion = Boolean(runInfo?.hasQuestion);
		const hasError = Boolean(runInfo?.hasError || runInfo?.error);
		// 实实在在运行中的判断：必须正在流式输出、等待交互提问或排队补全中；纯点开驻留内存的不算运行
		const isActuallyRunning = Boolean(
			isStreaming || hasQuestion || runInfo?.conv?.completionPending || runInfo?.conv?.isStreaming,
		);
		const isUnread =
			!active &&
			!isActuallyRunning &&
			checkUnread({
				id: runInfo?.conv?.id,
				sessionId: s.sessionId,
				sessionFile: s.path,
				path: s.path,
			});

		// 识别类别信息与清洗标题（形态 A 核心：左侧纯文字对齐，属性在右侧以微胶囊呈现）
		const rawTitle = displayName(s);
		let cleanTitle = rawTitle;
		let categoryTag: { key: string; label: string } | null = null;

		const channelMatch = cleanTitle.match(/^\[(微信|feishu|飞书|dingtalk|钉钉|wechat|qq|telegram)[^\]]*\]\s*(.*)$/i);
		if (channelMatch) {
			const rawCh = channelMatch[1]!.toLowerCase();
			const chLabel =
				rawCh.includes("微信") || rawCh === "wechat"
					? "微信"
					: rawCh.includes("飞书") || rawCh === "feishu"
						? "飞书"
						: rawCh.includes("钉钉") || rawCh === "dingtalk"
							? "钉钉"
							: rawCh.toUpperCase();
			categoryTag = { key: "wechat", label: chLabel };
			if (channelMatch[2]?.trim()) {
				cleanTitle = channelMatch[2].trim();
			}
		} else if (s.parentSessionPath || runInfo?.conv?.forkFrom) {
			categoryTag = { key: "fork", label: "🌿分支" };
		} else if (runInfo?.conv?.elsewhere && runInfo.conv.owner?.startsWith("scheduler:")) {
			categoryTag = { key: "scheduler", label: "调度" };
		} else if (s.source === "tui") {
			categoryTag = { key: "tui", label: "TUI" };
		}

		return (
			<div
				className="lp-row"
				key={s.path}
				onMouseLeave={() => setConfirmDel((k) => (k === `sess:${s.path}` ? null : k))}
				onContextMenu={(e) => openSessionMenu(e, { id: s.path, kind: "history", label: rawTitle })}
			>
				<button
					type="button"
					className={`session-item lp-tree-session-item ${active ? "active" : ""} ${switching ? "switching" : ""}${isActuallyRunning ? " is-running" : ""}${isUnread ? " is-unread" : ""}`}
					title={s.path}
					disabled={switching}
					onClick={() => {
						if (renaming || switching) return;
						clearConversationUnread(s.path);
						if (s.sessionId) clearConversationUnread(s.sessionId);
						if (runInfo?.conv?.id) clearConversationUnread(runInfo.conv.id);
						if (runInfo?.conv?.id && !runInfo.conv.elsewhere) {
							if (!active) panelSend({ type: "switch_conversation", id: runInfo.conv.id });
							return;
						}
						if (!active) panelSend({ type: "switch_session", path: s.path });
					}}
				>
					{/* 形态 A：左侧完全取消前置图标，纯文本绝对垂直基线对齐！ */}
					{renaming === s.path ? (
						<input
							autoFocus
							className="session-rename-input"
							value={renameDraft}
							placeholder={t("renameSessionPlaceholder")}
							onClick={(e) => e.stopPropagation()}
							onChange={(e) => setRenameDraft(e.target.value)}
							onKeyDown={(e) => {
								e.stopPropagation();
								if (e.key === "Enter" && !e.nativeEvent.isComposing) {
									const name = renameDraft.trim();
									if (name) panelSend({ type: "rename_session", path: s.path, name });
									setRenaming(null);
								} else if (e.key === "Escape") {
									setRenaming(null);
								}
							}}
							onBlur={() => setRenaming(null)}
						/>
					) : (
						<span className="conv-title-text" title={rawTitle}>
							{s.pinned && (
								<span className="pin-badge" title={t("pinnedConversation")}>
									📌
								</span>
							)}
							{cleanTitle}
						</span>
					)}

					{/* 形态 A：右侧元数据区（运行态指示器 + 类别微胶囊 + 时间戳全部右置） */}
					<span className="conv-meta-zone">
						{/* 1. 运行态状态指示器 */}
						{switching ? (
							<HalfRingSpinner className="status-spinner-right" />
						) : hasQuestion ? (
							<span className="status-question-right" title={t("waitingQuestionBadge")}>
								?
							</span>
						) : isStreaming ? (
							<div className="status-spinner-right" title={t("streaming")} />
						) : hasError ? (
							<span className="status-error-right" title={runInfo?.error}>
								!
							</span>
						) : isActuallyRunning ? (
							<span className="status-pulse-right" title={t("tabRunning")} />
						) : isUnread ? (
							<span className="status-unread-right" title={t("completedUnreadTooltip")}>
								<span className="status-unread-dot" />
							</span>
						) : null}

						{/* 2. 对话类别微徽标 */}
						{categoryTag && <span className={`category-badge-pill ${categoryTag.key}`}>{categoryTag.label}</span>}

						{/* 3. 时间戳 */}
						<span className={`conv-time ${switching ? "switching-pct" : ""}`}>
							{switching ? `${transition.progress}%` : formatModified(s.modified)}
						</span>
					</span>
				</button>
				{confirmDel !== `sess:${s.path}` && (
					<button
						type="button"
						className="lp-del lp-rename"
						title={t("renameSession")}
						onClick={(e) => {
							e.stopPropagation();
							setConfirmDel(null);
							setRenameDraft(s.name ?? "");
							setRenaming(s.path);
						}}
					>
						<FiEdit2 />
					</button>
				)}
				{!isStreaming &&
					delButton(`sess:${s.path}`, t("deleteSession"), t("deleteSessionConfirm"), () => {
						clearCachedSession(s.path, currentCwd);
						panelSend({ type: "delete_session", path: s.path });
					})}
				{renderInlineEntries(historyRowEntries, "lp-slot-sessions")}
			</div>
		);
	};

	/** P3：按时间轴分组渲染历史会话（方案 3 智能时间流） */
	const renderGroupedHistorySessions = (sessionList: SessionSummary[]) => {
		const groups = groupSessionsByTime(sessionList, {
			today: t("timeGroupToday"),
			yesterday: t("timeGroupYesterday"),
			pastWeek: t("timeGroupPastWeek"),
			earlier: t("timeGroupEarlier"),
		});

		if (groups.length === 0) {
			return <div className="panel-empty">{t("noHistory")}</div>;
		}

		return groups.map((g) => (
			<div key={g.key} className="panel-conv-group">
				<div
					style={{
						padding: "7px 12px 3px",
						fontSize: "10.5px",
						fontWeight: 600,
						color: "var(--text-faint)",
						letterSpacing: "0.3px",
						display: "flex",
						justifyContent: "space-between",
						alignItems: "center",
						userSelect: "none",
					}}
				>
					<span>{g.label}</span>
					<span style={{ fontSize: "10px", opacity: 0.65 }}>{g.items.length}</span>
				</div>
				{g.items.map((s) => renderHistorySessionRow(s))}
			</div>
		));
	};

	/** P3：渲染单个运行中会话条目（含子代理缩进、外部会话、右键菜单等） */
	const renderSingleConvRow = (
		{ c, depth, hasKids, isCollapsed, descendantCount, hasStreaming, hasError, hasQuestion }: ConvRowItem,
		projectPath?: string,
	) => {
		if ((c as RowConv).elsewhere) {
			const elseOwner = (c as RowConv).owner;
			const elseConvId = (c as RowConv).convId;
			const isPseudo = Boolean((c as RowConv).pseudo);
			const isOffline = Boolean((c as RowConv).ownerOffline) && !isPseudo;
			const isScheduler = Boolean(typeof elseOwner === "string" && elseOwner.startsWith("scheduler:"));
			const isShared = (c as RowConv).independent === false;
			const canOpenDirectly = Boolean(elseOwner && elseConvId) && (isShared || isScheduler);
			const canTakeover = Boolean(elseOwner && elseConvId) && !isScheduler && !isShared;
			const canClick = canOpenDirectly || canTakeover;
			const active = sharedConversationOwner === elseOwner && activeConversationId === elseConvId;
			const isActuallyRunning = Boolean(c.isStreaming || hasStreaming || c.completionPending);
			const isUnread =
				!active &&
				!isActuallyRunning &&
				checkUnread({
					id: c.id,
					sessionId: c.sessionId,
					sessionFile: c.sessionFile,
				});
			const confirming = !isShared && !isScheduler && confirmTakeover === c.id;
			const tooltip = isShared
				? c.cwd
				: isScheduler
					? `${t("schedulerViewTip")}\n${c.cwd}`
					: confirming
						? t("takeoverConfirm")
						: isPseudo
							? `点击直接在电脑端打开此对话\n${c.cwd}`
							: `${t(isOffline ? "elsewhereOfflineTip" : "elsewhereTip")}\n${c.cwd}`;
			return (
				<div
					className="lp-row"
					key={c.id}
					onMouseLeave={() => {
						setConfirmTakeover((k) => (k === c.id ? null : k));
						setConfirmDel((k) => (k === `else:${c.id}` ? null : k));
					}}
					onContextMenu={(e) =>
						openSessionMenu(e, {
							id: elseConvId ?? c.id,
							kind: "elsewhere",
							label: c.title,
							...(elseOwner ? { owner: elseOwner } : {}),
							...(isPseudo ? { pseudo: true } : {}),
						})
					}
				>
					<button
						type="button"
						className={`session-item elsewhere-item${active ? " active" : ""}${canClick ? "" : " elsewhere-static"}${confirming ? " confirm" : ""}${isActuallyRunning ? " is-running" : ""}${isUnread ? " is-unread" : ""}`}
						title={tooltip}
						tabIndex={canClick ? 0 : -1}
						onClick={
							canClick
								? () => {
										if (canOpenDirectly) {
											panelSend({
												type: "open_shared_conversation",
												owner: elseOwner as string,
												id: elseConvId as string,
											});
											return;
										}
										if (isPseudo) {
											panelSend({
												type: "take_over_conversation",
												owner: elseOwner as string,
												id: elseConvId as string,
											});
											return;
										}
										if (!confirming) {
											setConfirmTakeover(c.id);
											return;
										}
										setConfirmTakeover(null);
										panelSend({
											type: "take_over_conversation",
											owner: elseOwner as string,
											id: elseConvId as string,
										});
									}
								: undefined
						}
					>
						<span className="session-icon-wrap">
							{c.hasQuestion ? (
								<span
									className="session-icon"
									style={{
										color: "var(--amber)",
										fontWeight: 800,
										fontSize: "12px",
										display: "inline-flex",
										alignItems: "center",
										justifyContent: "center",
									}}
									title={t("takeoverHasQuestion")}
								>
									?
								</span>
							) : c.isStreaming || hasStreaming ? (
								<FiZap
									className="session-icon streaming-pulse"
									style={{ color: "var(--green)" }}
									title={t("streaming")}
								/>
							) : isScheduler ? (
								<FiClock className="session-icon" title={t("scheduledTaskBadge")} />
							) : (
								<FiMessageSquare className="session-icon" />
							)}
						</span>
						<span className="session-info">
							<span className="session-title">
								{isScheduler ? (
									<span className="elsewhere-badge scheduled-badge">{t("scheduledTaskBadge")}</span>
								) : !isShared ? (
									<span className="elsewhere-badge">{isPseudo ? t("elsewherePseudoBadge") : t("elsewhereBadge")}</span>
								) : null}
								{isOffline && (
									<span className="elsewhere-badge offline" title={t("elsewhereOfflineTip")}>
										{t("elsewhereOfflineBadge")}
									</span>
								)}
								{c.hasQuestion && elseOwner && elseConvId && !isPseudo && (
									<span
										className="question-badge clickable"
										title={t("takeoverHasQuestion")}
										onClick={(e) => {
											e.stopPropagation();
											panelSend({
												type: "peek_elsewhere_question",
												owner: elseOwner,
												id: elseConvId,
											});
										}}
									>
										?
									</span>
								)}
								{confirming ? t("takeoverConfirm") : c.title}
							</span>
							<span className="session-sub">
								{c.hasQuestion ? (
									<span style={{ color: "var(--amber)", fontWeight: 600 }}>{t("waitingQuestionShort")} · </span>
								) : c.isStreaming || hasStreaming ? (
									<span style={{ color: "var(--green)", fontWeight: 500 }}>{t("streaming")} · </span>
								) : null}
								{projectName(c.cwd)}
							</span>
						</span>
					</button>
					{sessionMenuAvailable && confirmDel !== `else:${c.id}` && (
						<button
							type="button"
							className="lp-del lp-elsewhere-act"
							style={{ right: 32 }}
							title={t("elsewhereActions")}
							onClick={(e) => {
								e.stopPropagation();
								forceArmedRef.current = null;
								const r = e.currentTarget.getBoundingClientRect();
								showSessionMenu(r.left, r.bottom + 4, {
									id: elseConvId ?? c.id,
									kind: "elsewhere",
									label: c.title,
									...(elseOwner ? { owner: elseOwner } : {}),
									...(isPseudo ? { pseudo: true } : {}),
								});
							}}
						>
							<FiMoreVertical />
						</button>
					)}
					{delButton(
						`else:${c.id}`,
						t("dismissConversation"),
						t("dismissConversationConfirm"),
						() =>
							panelSend({
								type: "dismiss_conversation",
								id: (elseConvId ?? c.id) as string,
								force: true,
								...(elseOwner ? { owner: elseOwner } : {}),
							}),
						<FiX />,
					)}
				</div>
			);
		}
		const active = !sharedConversationOwner && activeConversationId === c.id;
		const isActuallyRunning = Boolean(c.isStreaming || hasStreaming || c.completionPending);
		const isUnread =
			!active &&
			!isActuallyRunning &&
			checkUnread({
				id: c.id,
				sessionId: c.sessionId,
				sessionFile: c.sessionFile,
			});
		const convKey = `conv:${c.id}`;
		const isArmed = confirmDel === convKey;

		// 形态 A：标题清洗与类别微胶囊提取（左侧纯文字绝对对齐，元数据全部右置）
		let cleanTitle = c.title;
		let categoryTag: { key: string; label: string } | null = null;
		const channelMatch = cleanTitle.match(/^\[(微信|feishu|飞书|dingtalk|钉钉|wechat|qq|telegram)[^\]]*\]\s*(.*)$/i);
		if (channelMatch) {
			const rawCh = channelMatch[1]!.toLowerCase();
			const chLabel =
				rawCh.includes("微信") || rawCh === "wechat"
					? "微信"
					: rawCh.includes("飞书") || rawCh === "feishu"
						? "飞书"
						: rawCh.includes("钉钉") || rawCh === "dingtalk"
							? "钉钉"
							: rawCh.toUpperCase();
			categoryTag = { key: "wechat", label: chLabel };
			if (channelMatch[2]?.trim()) cleanTitle = channelMatch[2].trim();
		} else if (c.forkFrom) {
			categoryTag = { key: "fork", label: "🌿分支" };
		} else if ((c as RowConv).elsewhere && (c as RowConv).owner?.startsWith("scheduler:")) {
			categoryTag = { key: "scheduler", label: "调度" };
		}

		return (
			<div
				className={`lp-row${depth > 0 ? " lp-sub" : ""}${hasKids ? " lp-has-kids" : ""}`}
				key={c.id}
				style={depth > 0 ? ({ "--depth": Math.min(depth, 4) } as React.CSSProperties) : undefined}
				onMouseLeave={() => setConfirmDel((k) => (k === convKey ? null : k))}
				onContextMenu={(e) => openSessionMenu(e, { id: c.id, kind: "running", label: c.title })}
			>
				{hasKids && (
					<button
						type="button"
						className="lp-tree-caret"
						title={isCollapsed ? t("expandSubagents") : t("collapseSubagents")}
						aria-label={isCollapsed ? t("expandSubagents") : t("collapseSubagents")}
						onClick={(e) => {
							e.stopPropagation();
							toggleSubagents(c.id);
						}}
					>
						<svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor" style={{ display: "block" }}>
							<path d={isCollapsed ? "M4 2.5v7l5-3.5z" : "M2.5 4h7l-3.5 5z"} />
						</svg>
					</button>
				)}
				<button
					type="button"
					className={`session-item lp-tree-session-item ${active ? "active" : ""}${isActuallyRunning ? " is-running" : ""}${isUnread ? " is-unread" : ""}`}
					title={`${c.title}${projectPath ? "" : ` — ${c.cwd}`}`}
					onClick={() => {
						clearConversationUnread(c.id);
						if (c.sessionId) clearConversationUnread(c.sessionId);
						if (c.sessionFile) clearConversationUnread(c.sessionFile);
						if (!active) panelSend({ type: "switch_conversation", id: c.id });
					}}
				>
					{/* 形态 A：左侧纯文字绝对垂直对齐 */}
					{renaming === `conv:${c.id}` ? (
						<input
							autoFocus
							className="session-rename-input"
							value={renameDraft}
							placeholder={t("renameSessionPlaceholder")}
							onClick={(e) => e.stopPropagation()}
							onChange={(e) => setRenameDraft(e.target.value)}
							onKeyDown={(e) => {
								e.stopPropagation();
								if (e.key === "Enter" && !e.nativeEvent.isComposing) {
									const name = renameDraft.trim();
									if (name) panelSend({ type: "rename_conversation", id: c.id, name });
									setRenaming(null);
								} else if (e.key === "Escape") {
									setRenaming(null);
								}
							}}
							onBlur={() => setRenaming(null)}
						/>
					) : (
						<span className="conv-title-text" title={c.title}>
							{c.pinned && (
								<span className="pin-badge" title={t("pinnedConversation")}>
									📌
								</span>
							)}
							{cleanTitle}
						</span>
					)}

					{/* 形态 A：右侧元数据区（运行态指示器 + 类别微胶囊全部右置） */}
					<span className="conv-meta-zone">
						{hasQuestion || c.hasQuestion ? (
							<span className="status-question-right" title={t("waitingQuestionBadge")}>
								?
							</span>
						) : isActuallyRunning ? (
							<div className="status-spinner-right" title={t("streaming")} />
						) : c.error ? (
							<span className="status-error-right" title={c.error}>
								!
							</span>
						) : isUnread ? (
							<span className="status-unread-right" title={t("completedUnreadTooltip")}>
								<span className="status-unread-dot" />
							</span>
						) : null}

						{categoryTag && <span className={`category-badge-pill ${categoryTag.key}`}>{categoryTag.label}</span>}

						{c.agentPreset && c.agentPreset !== "standard" && (
							<span className="category-badge-pill subagent" title={c.agentPreset}>
								{presetNames?.[c.agentPreset] ?? c.agentPreset}
							</span>
						)}
					</span>
				</button>
				{!isArmed && (
					<button
						type="button"
						className="lp-del lp-rename"
						title={t("renameSession")}
						onClick={(e) => {
							e.stopPropagation();
							setConfirmDel(null);
							setRenameDraft(c.title);
							setRenaming(convKey);
						}}
					>
						<FiEdit2 />
					</button>
				)}
				{(() => {
					const key = convKey;
					const armed = isArmed;
					const nFinished = finishedSubagentCount(conversations, c.id);
					const nRunning = countRunningSubagentDescendants(conversations, c.id);
					const nAll = countScopeSubagents(conversations, c.id);
					if (nAll === 0 && !c.isStreaming) {
						if (c.hasUserTerminals) {
							return delButton(
								key,
								t("dismissConversation"),
								t("dismissTerminalsConfirm"),
								() => panelSend({ type: "dismiss_conversation", id: c.id, force: true }),
								<FiX />,
							);
						}
						return delButton(
							key,
							t("dismissConversation"),
							t("dismissConversationConfirm"),
							() => panelSend({ type: "dismiss_conversation", id: c.id }),
							<FiX />,
						);
					}
					if (nAll === 0) {
						return delButton(
							key,
							t("dismissConversation"),
							t("dismissStreamingConfirm"),
							() => panelSend({ type: "dismiss_conversation", id: c.id, force: true }),
							<FiX />,
						);
					}
					if (!armed) {
						return (
							<button
								type="button"
								className="lp-del"
								title={t("dismissConversation")}
								onClick={(e) => {
									e.stopPropagation();
									setConfirmDel(key);
								}}
							>
								<FiX />
							</button>
						);
					}
					return (
						<span className="lp-del-group">
							<button
								type="button"
								className="lp-del-opt danger"
								title={t("forceDismissTitle", { n: nAll, m: nRunning })}
								onClick={(e) => {
									e.stopPropagation();
									setConfirmDel(null);
									panelSend({ type: "dismiss_conversation", id: c.id, force: true });
								}}
							>
								{t("dismissForceAll")}
							</button>
							<button
								type="button"
								className="lp-del confirm"
								title={
									nRunning > 0
										? nFinished > 0
											? t("dismissFinishedSubagentsScoped", { n: nFinished })
											: t("dismissConversationConfirm")
										: t("dismissConversationConfirm")
								}
								onClick={(e) => {
									e.stopPropagation();
									setConfirmDel(null);
									panelSend({ type: "dismiss_conversation", id: c.id, withFinishedSubagents: true });
								}}
							>
								<FiCheck />
							</button>
						</span>
					);
				})()}
				{renderInlineEntries(runningRowEntries, "lp-slot-sessions")}
			</div>
		);
	};

	/** P3：渲染所有运行中会话与插件运行条目（零占地原位状态展示） */
	const renderRunningConversationsBody = () => (
		<>
			{groupConversations(runningAll, cwd, activeConversationId).map((g) => (
				<div key={g.cwd} className="panel-conv-group">
					{!g.isCurrent && (
						<div
							className="panel-conv-group-title"
							title={g.cwd}
							onContextMenu={(e) => openProjectMenu(e, { path: g.cwd, lastUsed: 0 })}
							onDoubleClick={(e) => {
								e.stopPropagation();
								panelSend({ type: "set_cwd", path: g.cwd });
								panelSend({ type: "new_chat" });
								focusComposer();
							}}
						>
							{projectName(g.cwd)}
						</div>
					)}
					{buildConversationRows(g.convs, collapsedSubagents).map((row) => renderSingleConvRow(row, g.cwd))}
				</div>
			))}
			{renderPluginRunning()}
		</>
	);

	const sectionNodes: Record<"projects" | "convs" | "sessions", React.ReactNode> = {
		projects: (
			<>
				{/* Workspace (Projects + Groups) — single collapsible section, 0 nested headers */}
				<div
					className={`lp-section panel-projects ${collapseProjects || (workspaceTab === "projects" && projects.length === 0) ? "collapsed" : ""}`}
					style={!collapseProjects ? { flex: `${effFlex("projects")} 1 0px` } : undefined}
				>
					<div className="lp-section-header">
						<button
							type="button"
							className="lp-section-title panel-section-title"
							onClick={toggleProjects}
							title={collapseProjects ? t("expandSection") : t("collapseSection")}
						>
							<span className="lp-section-title-text" style={{ display: "inline-flex", alignItems: "center" }}>
								<span style={{ display: "none" }}>{t("recentProjects")}</span>
								<span
									className="lp-conv-tabs"
									style={{
										display: "inline-flex",
										gap: "5px",
										userSelect: "none",
										alignItems: "center",
									}}
									onClick={(e) => e.stopPropagation()}
								>
									<span
										role="button"
										tabIndex={0}
										className={`lp-conv-tab ${workspaceTab !== "groups" ? "active" : ""}`}
										onClick={(e) => {
											e.stopPropagation();
											setWorkspaceTab("projects");
										}}
										onKeyDown={(e) => {
											if (e.key === "Enter" || e.key === " ") {
												e.preventDefault();
												e.stopPropagation();
												setWorkspaceTab("projects");
											}
										}}
										title={t("tabProjects")}
									>
										<FiFolder style={{ fontSize: "12.5px" }} />
										<span>{t("tabProjects")}</span>
										<span style={{ fontSize: "11px", opacity: 0.85 }}>({projects.length})</span>
									</span>
									<span
										role="button"
										tabIndex={0}
										className={`lp-conv-tab ${workspaceTab === "groups" ? "active" : ""}`}
										onClick={(e) => {
											e.stopPropagation();
											setWorkspaceTab("groups");
										}}
										onKeyDown={(e) => {
											if (e.key === "Enter" || e.key === " ") {
												e.preventDefault();
												e.stopPropagation();
												setWorkspaceTab("groups");
											}
										}}
										title={t("deviceGroups")}
									>
										<FiUsers style={{ fontSize: "12.5px" }} />
										<span>{t("deviceGroups")}</span>
										{groupCount > 0 && <span style={{ fontSize: "11px", opacity: 0.85 }}>({groupCount})</span>}
									</span>
								</span>
							</span>
						</button>
						<div className="lp-section-actions" ref={workspaceMenuRef} style={{ position: "relative" }}>
							<button
								type="button"
								className={`lp-section-action lp-project-action ${workspaceMenuOpen ? "active" : ""}`}
								title={workspaceMenuOpen ? undefined : t("openProject")}
								aria-label={t("openProject")}
								aria-expanded={workspaceMenuOpen}
								onClick={(e) => {
									e.stopPropagation();
									setWorkspaceMenuOpen((prev) => !prev);
								}}
							>
								<FiPlus />
							</button>
							{renderInlineEntries(uiProjectsActions, "lp-slot-section")}
							{workspaceMenuOpen && (
								<div className="lp-workspace-menu" role="menu" onClick={(e) => e.stopPropagation()}>
									<button
										type="button"
										className="lp-workspace-menu-item lp-manage-projects-btn"
										onClick={() => {
											setWorkspaceMenuOpen(false);
											setProjectPickerOpen(true);
										}}
									>
										<FiFolder style={{ fontSize: "13px" }} />
										<span>{t("openProject")}</span>
									</button>
									{onOpenSandboxModal && (
										<button
											type="button"
											className="lp-workspace-menu-item"
											onClick={() => {
												setWorkspaceMenuOpen(false);
												onOpenSandboxModal();
											}}
										>
											<LuFlaskConical style={{ fontSize: "13px" }} />
											<span>{t("sandboxNewShort")}</span>
										</button>
									)}
									<div className="lp-workspace-menu-divider" />
									<button
										type="button"
										className="lp-workspace-menu-item"
										onClick={() => {
											setWorkspaceMenuOpen(false);
											window.dispatchEvent(
												new CustomEvent("pi-web-ui:device-group-open", { detail: { create: true } }),
											);
										}}
									>
										<FiUsers style={{ fontSize: "13px" }} />
										<span>{t("createGroup")}</span>
									</button>
								</div>
							)}
						</div>
					</div>
					{!collapseProjects &&
						(workspaceTab === "groups" ? (
							<DeviceGroupSection
								entry={uiSections?.find((entry) => entry.id === "host:lp-groups")}
								active={active}
								selectedRoomId={activeGroupId}
								hideHeader={true}
								onRoomCountChange={setGroupCount}
							/>
						) : effectiveProjects.length > 0 ? (
							<div className="lp-section-body projects-scroll" onDoubleClick={handleBlankDoubleClick}>
								{(() => {
									// 全局跨项目排他认领集合：保证同一个会话文件在整个侧栏中只能且最多归属于一个项目
									const claimedSessionPaths = new Set<string>();
									const claimedSessionIds = new Set<string>();
									return effectiveProjects.map((p) => {
										const pNorm = normalizeSessionPathKey(p.path);
										const curNorm = normalizeSessionPathKey(currentCwd);
										const active = pNorm === curNorm;
										const isExpanded = isProjectExpanded(p.path);
										const isCollapsed = !isExpanded;
										const switching =
											transition?.kind === "cwd" && normalizeSessionPathKey(transition.target) === pNorm;
										const sbx = p.sandbox;
										const dispName = sbx ? sbx.name : projectName(p.path);

										// 1. 归属于该项目的全部活动对话（含主会话与完整子代理树，支持展开/折叠与缩进）
										const pRunningRaw = runningAll.filter((c) => normalizeSessionPathKey(c.cwd) === pNorm);
										const pRunningRows = buildConversationRows(pRunningRaw, collapsedSubagents);

										// 登记活动会话到全局排他集合
										for (const c of pRunningRaw) {
											if (c.sessionFile) claimedSessionPaths.add(normalizeSessionPathKey(c.sessionFile));
											if (c.sessionId) claimedSessionIds.add(c.sessionId.trim().toLowerCase());
										}

										// 2. 基础磁盘历史会话列表（当前项目用 sessions，其他项目优先读 projectSessions 或本地缓存）
										const pStateSessions = projectSessions?.[pNorm];
										const pRawSessions = active
											? sessions
											: (pStateSessions ?? readCachedSessions(p.path, engine) ?? []);
										const isLoadingSessions = loadingProjects.has(pNorm) && pRawSessions.length === 0;

										// 3. 最佳落地实践：物理路径确定性归属过滤 + 全局排他去重
										// 任何物理路径不属于当前项目的会话，一律在物理层被拒收，绝不可能跨项目窜门
										const idleSessions = pRawSessions.filter((s) => {
											if (!isSessionMatchingProject(s.path, p.path)) return false;
											const sNorm = normalizeSessionPathKey(s.path);
											if (sNorm && claimedSessionPaths.has(sNorm)) return false;
											const sId = s.sessionId?.trim().toLowerCase() || extractSessionIdFromPath(s.path)?.toLowerCase();
											if (sId && claimedSessionIds.has(sId)) return false;
											if (sNorm) claimedSessionPaths.add(sNorm);
											if (sId) claimedSessionIds.add(sId);
											return true;
										});

										// 4. 统计真正在跑的任务数量（用于项目头徽标，纯点开的不计入）
										const actuallyRunningCount = pRunningRaw.filter(
											(c) => c.isStreaming || c.hasQuestion || c.completionPending,
										).length;
										const hasRunning = actuallyRunningCount > 0;
										const hasHistory = idleSessions.length > 0;

										// 4.1 统计当前项目下已完成未查看的任务数量
										const unreadRunningCount = pRunningRaw.filter(
											(c) =>
												!c.isStreaming &&
												!c.completionPending &&
												checkUnread({ id: c.id, sessionId: c.sessionId, sessionFile: c.sessionFile }),
										).length;
										const unreadHistoryCount = idleSessions.filter((s) =>
											checkUnread({ sessionId: s.sessionId, sessionFile: s.path, path: s.path }),
										).length;
										const unreadCount = unreadRunningCount + unreadHistoryCount;
										const hasUnread = unreadCount > 0;

										// 5. 数量截断与分页展开
										const maxVisible = projectVisibleCounts[pNorm] ?? 8;
										const visibleIdleSessions = idleSessions.slice(0, maxVisible);
										const hasMore = !isCollapsed && idleSessions.length > maxVisible;

										return (
											<div className="lp-project-node" key={p.path}>
												<div
													className={`lp-row lp-project-head-row${hasRunning ? " has-running" : ""}${hasUnread ? " has-unread" : ""}`}
													onMouseLeave={() => setConfirmDel((k) => (k === `proj:${p.path}` ? null : k))}
													onContextMenu={(e) => openProjectMenu(e, p)}
												>
													<button
														type="button"
														className={`lp-project-header-item project-item ${active ? "active" : ""} ${switching ? "switching" : ""}${hasRunning ? " has-running" : ""}${hasUnread ? " has-unread" : ""}`}
														title={
															sbx?.sourcePath
																? `${dispName}\n${t("sandboxSourceLabel")}: ${sbx.sourcePath}\n${p.path}`
																: p.path
														}
														disabled={switching}
														onClick={() => {
															if (!switching) {
																if (!active) panelSend({ type: "set_cwd", path: p.path });
																toggleProjectExpand(p.path);
															}
														}}
														onDoubleClick={(e) => {
															e.stopPropagation();
															if (switching) return;
															if (active) {
																panelSend({ type: "new_chat" });
															} else {
																panelSend({ type: "set_cwd", path: p.path });
																panelSend({ type: "new_chat" });
															}
															focusComposer();
														}}
													>
														<span
															className="lp-project-chevron"
															onClick={(e) => {
																e.stopPropagation();
																toggleProjectExpand(p.path);
															}}
															title={isCollapsed ? t("expandSection") : t("collapseSection")}
														>
															<svg
																width="11"
																height="11"
																viewBox="0 0 12 12"
																fill="currentColor"
																style={{ display: "block" }}
															>
																<path d={isCollapsed ? "M4 2.5v7l5-3.5z" : "M2.5 4h7l-3.5 5z"} />
															</svg>
														</span>
														{switching ? (
															<HalfRingSpinner className="project-icon spin" />
														) : sbx ? (
															<LuFlaskConical className="project-icon sandbox-icon" />
														) : null}
														<span className="lp-project-name" title={dispName}>
															{dispName}
														</span>
														{sbx && (
															<span className={`lp-sandbox-badge ${sbx.ephemeral ? "ephemeral" : "permanent"}`}>
																{sbx.ephemeral ? t("sandboxBadgeEphemeral") : t("sandboxBadgePermanent")}
															</span>
														)}
														{hasRunning && (
															<span className="lp-project-running-badge" title={t("tabRunning")}>
																<span className="lp-project-running-dot" />
																<span>{actuallyRunningCount}</span>
															</span>
														)}
														{hasUnread && (
															<span className="lp-project-unread-badge" title={t("completedUnreadBadge")}>
																<span className="lp-project-unread-dot" />
																<span>{unreadCount}</span>
															</span>
														)}
														<span className={`project-time ${switching ? "switching-pct" : ""}`}>
															{switching ? `${transition.progress}%` : formatModified(p.lastUsed)}
														</span>
													</button>

													<div className="lp-project-actions">
														<button
															type="button"
															className="lp-project-btn lp-project-new-chat-btn"
															title={t("newChat") || "新建对话"}
															onClick={(e) => {
																e.stopPropagation();
																if (!active) panelSend({ type: "set_cwd", path: p.path });
																panelSend({ type: "new_chat" });
																focusComposer();
															}}
														>
															<FiPlus />
														</button>
														<button
															type="button"
															className={`lp-project-btn lp-project-del-btn ${confirmDel === `proj:${p.path}` ? "confirm danger" : ""}`}
															title={
																confirmDel === `proj:${p.path}`
																	? sbx
																		? t("sandboxActionDestroy")
																		: t("deleteProjectConfirm")
																	: sbx
																		? t("sandboxActionDestroyTip")
																		: t("deleteProject")
															}
															onClick={(e) => {
																e.stopPropagation();
																if (confirmDel === `proj:${p.path}`) {
																	setConfirmDel(null);
																	clearLastCwdIfMatches(p.path);
																	clearCachedProject(p.path);
																	panelSend(
																		sbx
																			? { type: "destroy_sandbox", path: p.path }
																			: { type: "remove_project", path: p.path },
																	);
																} else {
																	setConfirmDel(`proj:${p.path}`);
																}
															}}
														>
															{confirmDel === `proj:${p.path}` ? <FiCheck /> : <FiTrash2 />}
														</button>
														{renderInlineEntries(uiLeftProject, "lp-slot-project", {
															id: p.path,
															kind: "project",
															label: dispName,
														})}
													</div>
												</div>

												{/* 智能半折叠：折叠时仅隐藏历史（有正在运行或完成未查看则常驻可见），展开时始终呈现 */}
												{((isCollapsed && (pRunningRows.length > 0 || hasUnread)) || !isCollapsed) && (
													<div className="lp-project-tree-children">
														{/* 1. 活动对话与完整子代理层级树（带折叠实心三角、深度缩进、子代理徽标） */}
														{pRunningRows.map((row) => renderSingleConvRow(row, p.path))}

														{/* 2. 静态历史记录（仅在项目展开态展示，不与上方活动会话重复） */}
														{!isCollapsed && visibleIdleSessions.map((s) => renderHistorySessionRow(s, p.path))}

														{/* 3. 展开态且无任何会话时的空态/加载提示 */}
														{!isCollapsed && pRunningRows.length === 0 && idleSessions.length === 0 && (
															<div className="lp-project-empty-tip">
																{isLoadingSessions ? (
																	<span>{t("loadingSessions") || "正在读取会话…"}</span>
																) : (
																	<span>{t("noSessionsYet") || "暂无历史会话"}</span>
																)}
															</div>
														)}

														{/* 4. 折叠提示（仅在折叠态且有历史时展示） */}
														{isCollapsed && hasHistory && (
															<div
																className="lp-collapsed-history-tip"
																onClick={(e) => {
																	e.stopPropagation();
																	toggleProjectExpand(p.path);
																}}
																title={t("expandSection")}
															>
																<span>+ 已收起 {idleSessions.length} 条历史</span>
																<span>›</span>
															</div>
														)}

														{/* 5. 显示更多 */}
														{!isCollapsed && hasMore && (
															<div
																className="lp-show-more-row"
																onClick={(e) => {
																	e.stopPropagation();
																	setProjectVisibleCounts((prev) => ({
																		...prev,
																		[pNorm]: (prev[pNorm] ?? 8) + 20,
																	}));
																}}
															>
																<span>显示更多 · {idleSessions.length - maxVisible}</span>
															</div>
														)}
													</div>
												)}
											</div>
										);
									});
								})()}
								{renderPluginRunning()}
							</div>
						) : null)}
				</div>
			</>
		),
		convs: null,
		sessions: null,
	};

	/** P4：插件自定义分区（kind="view"）：标题栏 + 正文由插件 bundle 挂载（渲染函数由 App 注入，同后台任务面板口径）。 */
	const renderPluginSection = (key: LpSectionKey): React.ReactNode => {
		const entry = shownPlan.find((p) => p.key === key)?.entry;
		if (!entry) return null;
		const collapsed = collapsedOf(key);
		return (
			<div
				className={`lp-section lp-section-plugin ${collapsed ? "collapsed" : ""}`}
				style={!collapsed ? { flex: `${effFlex(key)} 1 0px` } : undefined}
			>
				{sectionHeader(entry.label, collapsed, () => togglePluginCollapsed(key))}
				{!collapsed && (
					<div className="lp-section-body lp-plugin-section-body">{renderPluginSectionBody?.(entry) ?? null}</div>
				)}
			</div>
		);
	};
	const renderSection = (key: LpSectionKey): React.ReactNode => {
		if (key === "groups") {
			if (workspaceTab !== "split" && shownPlan.some((p) => p.key === "projects")) {
				return (
					<section className="lp-section dg-side-section" style={{ display: "none" }}>
						<DeviceGroupSection
							entry={uiSections?.find((entry) => entry.id === "host:lp-groups")}
							active={active}
							selectedRoomId={activeGroupId}
							hideHeader={true}
							onRoomCountChange={setGroupCount}
						/>
					</section>
				);
			}
			return (
				<DeviceGroupSection
					entry={uiSections?.find((entry) => entry.id === "host:lp-groups")}
					active={active}
					selectedRoomId={activeGroupId}
					flex={effFlex("groups")}
					onCollapsedChange={setCollapseGroups}
					onRoomCountChange={setGroupCount}
				/>
			);
		}
		return key === "projects" || key === "convs" || key === "sessions" ? sectionNodes[key] : renderPluginSection(key);
	};

	return (
		<aside ref={panelRef as React.RefObject<HTMLDivElement>} className="panel panel-left lp-panel">
			{collapsible && onToggleCollapse && (
				<button type="button" className="panel-collapse-btn" title={t("collapsePanel")} onClick={onToggleCollapse}>
					<FiChevronLeft />
				</button>
			)}
			{effectivePlan.map(({ key }) => (
				<Fragment key={key}>
					{renderSection(key)}
					{sashAfter.get(key) ?? null}
				</Fragment>
			))}
			<ProjectPicker
				open={projectPickerOpen}
				currentCwd={currentCwd}
				pathCompletions={pathCompletions ?? []}
				workspaceRoots={workspaceRoots}
				onClose={() => setProjectPickerOpen(false)}
				onSelectDirectory={(path) => panelSend({ type: "set_cwd", path })}
				onCreateProject={(path) => panelSend({ type: "make_dir", path, setAsCwd: true })}
			/>
		</aside>
	);
});
