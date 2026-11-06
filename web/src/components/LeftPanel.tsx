import {
	memo,
	useEffect,
	useState,
	useCallback,
	useRef,
	useMemo,
	useLayoutEffect,
	Fragment,
	type ReactNode,
} from "react";
import { DeviceGroupSection } from "./DeviceGroupSection";
import { NativeCliCreateEntry } from "./NativeCliCreateModal";
import {
	FiAlertCircle,
	FiCheck,
	FiChevronDown,
	FiChevronLeft,
	FiChevronRight,
	FiChevronUp,
	FiEdit2,
	FiFolder,
	FiFolderPlus,
	FiGitBranch,
	FiMessageSquare,
	FiMoreVertical,
	FiPlus,
	FiSearch,
	FiTrash2,
	FiTerminal,
	FiUsers,
	FiX,
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
import { useT, type Translate } from "../i18n";
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
import { conversationOrder, conversationOrderScope, useConversationOrderVersion } from "../conversation-order";
import { ProjectPicker } from "./ProjectPicker.js";
import { type UiSlotEntry } from "../ui-slots";
import { contextMenuItems, openContextMenu, type ContextMenuRequest } from "../context-menu-state";
import { HalfRingSpinner } from "./HalfRingSpinner";
import { composeToComposer, focusComposer } from "../composer-bridge";
import { openQuickAsk, type QuickAskReferenceSource } from "../quick-ask";
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

interface LeftPanelProps {
	sessionFile: string | null;
	conversations: ConversationSummary[];
	elsewhere: ElsewhereRunning[];
	sessions: SessionSummary[];
	projects: ProjectSummary[];
	activeConversationId: string;
	sharedConversationOwner?: string;
	activeGroupId?: string | null;
	projectSessions?: Record<string, SessionSummary[]>;
	projectSessionsHasMore?: Record<string, boolean>;
	engine?: string;
	unreadConvKeys?: ReadonlySet<string>;
	panelSend: (
		msg:
			| { type: "new_chat" }
			| { type: "list_sessions"; path?: string; limit?: number }
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
	active: boolean;
	collapsible?: boolean;
	onToggleCollapse?: () => void;

	uiContextSession?: UiSlotEntry[];
	quickAskReferenceMenus?: boolean;
	uiLeftSessions?: UiSlotEntry[];
	uiContextProject?: UiSlotEntry[];
	uiProjectsActions?: UiSlotEntry[];
	uiLeftProject?: UiSlotEntry[];
	uiRunningActions?: UiSlotEntry[];
	uiHistoryActions?: UiSlotEntry[];
	onUiAction?: (item: UiSlotEntry, value?: string, target?: { id: string; kind?: string; label?: string }) => void;
	uiSections?: UiSlotEntry[];
	renderPluginSectionBody?: (entry: UiSlotEntry) => React.ReactNode;
	uiPluginRunning?: PluginPanelGroup[];
	onPluginRunningAction?: (group: PluginPanelGroup, item: PluginPanelItem) => void;
	uiLeftRunning?: UiSlotEntry[];
	uiLeftHistory?: UiSlotEntry[];
	presetNames?: Record<string, string>;
	pathCompletions?: { name: string; path: string; type: "dir" | "file" }[];
	transition?: Pick<WorkspaceTransitionState, "kind" | "target" | "progress"> | null;
	onOpenSandboxModal?: () => void;
	onCreateCli?: (cwd?: string) => void;
}

function RowMain({
	editing,
	children,
	className,
	title,
	...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { editing: boolean }) {
	if (editing)
		return (
			<div className={`${className ?? ""} renaming`} title={title}>
				{children}
			</div>
		);
	return (
		<button type="button" className={className} title={title} {...rest}>
			{children}
		</button>
	);
}

type CategoryTag = { key: string; label: string };
const CHANNEL_PREFIX_RE = /^\[(微信|feishu|飞书|dingtalk|钉钉|wechat|qq|telegram)[^\]]*\]\s*(.*)$/i;

function categorizeTitle(
	rawTitle: string,
	flags: { fork?: boolean; scheduler?: boolean; tui?: boolean },
	t: Translate,
): { cleanTitle: string; categoryTag: CategoryTag | null } {
	const m = rawTitle.match(CHANNEL_PREFIX_RE);
	if (m) {
		const rawCh = m[1]!.toLowerCase();
		const label =
			rawCh.includes("微信") || rawCh === "wechat"
				? t("lpChannelWechat")
				: rawCh.includes("飞书") || rawCh === "feishu"
					? t("lpChannelFeishu")
					: rawCh.includes("钉钉") || rawCh === "dingtalk"
						? t("lpChannelDingtalk")
						: rawCh.toUpperCase();
		return { cleanTitle: m[2]?.trim() || rawTitle, categoryTag: { key: "wechat", label } };
	}
	if (flags.fork) return { cleanTitle: rawTitle, categoryTag: { key: "fork", label: t("lpBadgeFork") } };
	if (flags.scheduler) return { cleanTitle: rawTitle, categoryTag: { key: "scheduler", label: t("lpBadgeScheduler") } };
	if (flags.tui) return { cleanTitle: rawTitle, categoryTag: { key: "tui", label: "TUI" } };
	return { cleanTitle: rawTitle, categoryTag: null };
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

type SessionMenuTarget = {
	id: string;
	kind: "running" | "history" | "section" | "elsewhere";
	label: string;
	owner?: string;
	pseudo?: boolean;
};

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
const LS_VISIBLE_COUNTS = "pi-web-ui:lp-visible-counts";
const SESSION_LIST_DEFAULT = 200;

const LS_PROJECTS_ORDER_KEY = "pi-web-ui:projects-order";
try {
	if (typeof localStorage !== "undefined") localStorage.removeItem(LS_PROJECTS_ORDER_KEY);
} catch {}

const LS_LP_SIZES = "pi-web-ui:lp-sizes";
type LpWeights = Record<string, number>;
const DEFAULT_LP_WEIGHTS: LpWeights = { projects: 1, groups: 1, convs: 1, sessions: 1 };
const LP_COLLAPSED_HEADER_PX = 32;
const PLUGIN_STATUS_KEY = {
	running: "pluginRunStatusRunning",
	done: "pluginRunStatusDone",
	error: "pluginRunStatusError",
} as const;
const LP_MIN_SECTION_PX = 72;
function loadLpWeights(): LpWeights {
	try {
		return parseLpWeights(localStorage.getItem(LS_LP_SIZES), DEFAULT_LP_WEIGHTS);
	} catch {
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

function ConversationRowIndicator({ children, time }: { children: ReactNode; time?: string }) {
	if (children) return <span className="conv-indicator-slot">{children}</span>;
	return time ? <span className="conv-time">{time}</span> : null;
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
	projectSessionsHasMore,
	engine,
	unreadConvKeys,
	panelSend,
	active,
	collapsible,
	onToggleCollapse,
	pathCompletions,
	uiContextSession,
	quickAskReferenceMenus = true,
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
	onCreateCli,
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
	const ready = useAppField("ready");
	const tabs = useAppField("tabs");
	const status = useAppField("status");
	const cwd = useAppField("cwd");
	const workspaceRoots = useAppField("workspaceRoots");
	const currentCwd = cwd;
	const conversationOrderVersion = useConversationOrderVersion();
	const [projectPickerOpen, setProjectPickerOpen] = useState(false);
	const [confirmDel, setConfirmDel] = useState<string | null>(null);
	const [confirmTakeover, setConfirmTakeover] = useState<string | null>(null);
	const [renaming, setRenaming] = useState<string | null>(null);
	const [renameDraft, setRenameDraft] = useState("");
	const [renameOverrides, setRenameOverrides] = useState<Record<string, string>>({});
	const [filterText, setFilterText] = useState("");
	const renameActiveRef = useRef<string | null>(null);
	renameActiveRef.current = renaming;
	const cancelRename = () => {
		renameActiveRef.current = null;
		setRenaming(null);
	};
	const commitRename = (
		rowKey: string,
		msg: { type: "rename_session"; path: string } | { type: "rename_conversation"; id: string },
		overrideKey: string,
		currentTitle: string,
	) => {
		if (renameActiveRef.current !== rowKey) return;
		renameActiveRef.current = null;
		setRenaming(null);
		const name = renameDraft.trim();
		if (!name || name === currentTitle) return;
		panelSend({ ...msg, name });
		setRenameOverrides((prev) => ({ ...prev, [overrideKey]: name }));
		setTimeout(() => {
			setRenameOverrides((prev) => {
				if (prev[overrideKey] !== name) return prev;
				const next = { ...prev };
				delete next[overrideKey];
				return next;
			});
		}, 10_000);
	};
	useEffect(() => {
		setRenameOverrides((prev) => {
			const keys = Object.keys(prev);
			if (keys.length === 0) return prev;
			const next = { ...prev };
			let changed = false;
			const sessionName = (path: string): string | undefined => {
				const hit =
					sessions.find((s) => s.path === path) ??
					Object.values(projectSessions ?? {})
						.flat()
						.find((s) => s.path === path);
				return hit?.name;
			};
			for (const k of keys) {
				const conv = conversations.find((c) => c.id === k);
				if ((conv && conv.title === prev[k]) || sessionName(k) === prev[k]) {
					delete next[k];
					changed = true;
				}
			}
			return changed ? next : prev;
		});
	}, [sessions, projectSessions, conversations]);
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

	const sessionPositionsRef = useRef<Map<string, { top: number; isRunning: boolean }>>(new Map());
	const projectScrollRef = useRef<HTMLDivElement | null>(null);
	const everExpandedRef = useRef<Set<string>>(new Set());

	useLayoutEffect(() => {
		const container = projectScrollRef.current;
		if (!container) return;

		const rows = container.querySelectorAll<HTMLElement>(".lp-row[data-session-key]");
		const currentPositions = new Map<string, { top: number; isRunning: boolean; el: HTMLElement }>();
		const prevPositions = sessionPositionsRef.current;

		rows.forEach((row) => {
			const key = row.getAttribute("data-session-key");
			if (!key) return;
			const isRunning = !row.closest(".lp-history-collapsible");
			const rect = row.getBoundingClientRect();
			currentPositions.set(key, { top: rect.top, isRunning, el: row });
		});

		let promotedKey: string | null = null;
		let promotedDeltaY = 0;

		for (const [key, curr] of currentPositions.entries()) {
			const prev = prevPositions.get(key);
			if (prev && !prev.isRunning && curr.isRunning) {
				const deltaY = prev.top - curr.top;
				if (deltaY > 4) {
					promotedKey = key;
					promotedDeltaY = deltaY;
					break;
				}
			}
		}

		if (promotedKey) {
			const target = currentPositions.get(promotedKey);
			if (target) {
				const el = target.el;
				el.style.transform = `translateY(${promotedDeltaY}px)`;
				el.style.transition = "none";
				el.style.zIndex = "10";
				el.style.willChange = "transform";
				el.classList.add("session-row-promoting");

				void el.offsetHeight;

				requestAnimationFrame(() => {
					el.style.transition = "transform 0.38s cubic-bezier(0.16, 1, 0.3, 1)";
					el.style.transform = "translateY(0)";

					const onEnd = () => {
						el.style.transform = "";
						el.style.transition = "";
						el.style.zIndex = "";
						el.style.willChange = "";
						el.classList.remove("session-row-promoting");
						el.removeEventListener("transitionend", onEnd);
					};
					el.addEventListener("transitionend", onEnd, { once: true });
					setTimeout(onEnd, 420);
				});
			}

			for (const [key, curr] of currentPositions.entries()) {
				if (key === promotedKey) continue;
				const prev = prevPositions.get(key);
				if (prev && !prev.isRunning && !curr.isRunning) {
					const deltaY = prev.top - curr.top;
					if (deltaY > 4 && deltaY < 80) {
						const el = curr.el;
						el.style.transform = `translateY(${deltaY}px)`;
						el.style.transition = "none";
						void el.offsetHeight;
						requestAnimationFrame(() => {
							el.style.transition = "transform 0.32s cubic-bezier(0.16, 1, 0.3, 1)";
							el.style.transform = "translateY(0)";
							const onEnd = () => {
								el.style.transform = "";
								el.style.transition = "";
							};
							el.addEventListener("transitionend", onEnd, { once: true });
							setTimeout(onEnd, 360);
						});
					}
				} else if (prev && prev.isRunning && curr.isRunning) {
					const deltaY = prev.top - curr.top;
					if (Math.abs(deltaY) > 4 && Math.abs(deltaY) < 120) {
						const el = curr.el;
						el.style.transform = `translateY(${deltaY}px)`;
						el.style.transition = "none";
						void el.offsetHeight;
						requestAnimationFrame(() => {
							el.style.transition = "transform 0.32s cubic-bezier(0.16, 1, 0.3, 1)";
							el.style.transform = "translateY(0)";
							const onEnd = () => {
								el.style.transform = "";
								el.style.transition = "";
							};
							el.addEventListener("transitionend", onEnd, { once: true });
							setTimeout(onEnd, 360);
						});
					}
				}
			}
		}

		const nextMap = new Map<string, { top: number; isRunning: boolean }>();
		for (const [key, val] of currentPositions.entries()) {
			nextMap.set(key, { top: val.top, isRunning: val.isRunning });
		}
		sessionPositionsRef.current = nextMap;
	});

	const deduplicatedProjects = useMemo(() => {
		const discoveredAt = Date.now();
		const seen = new Set<string>();
		const list: ProjectSummary[] = [];
		for (const p of projects) {
			const normP = normalizeSessionPathKey(p.path);
			if (seen.has(normP)) continue;
			seen.add(normP);
			list.push(p);
		}
		if (currentCwd && currentCwd !== "@root" && currentCwd !== "machine-root") {
			const normCur = normalizeSessionPathKey(currentCwd);
			if (!seen.has(normCur)) {
				seen.add(normCur);
				list.push({ path: currentCwd, lastUsed: discoveredAt });
			}
		}
		for (const group of groupConversations(conversations, currentCwd, activeConversationId)) {
			if (!group.cwd) continue;
			const normC = normalizeSessionPathKey(group.cwd);
			if (!seen.has(normC)) {
				seen.add(normC);
				list.push({ path: group.cwd, lastUsed: discoveredAt });
			}
		}
		for (const e of elsewhere) {
			if (!e.cwd) continue;
			const normC = normalizeSessionPathKey(e.cwd);
			if (!seen.has(normC)) {
				seen.add(normC);
				list.push({ path: e.cwd, lastUsed: discoveredAt });
			}
		}
		return list;
	}, [projects, currentCwd, conversations, elsewhere, activeConversationId]);

	const projectRankMapRef = useRef<Map<string, number>>(new Map());
	const [projectOrderVersion, setProjectOrderVersion] = useState(0);

	const stableProjects = useMemo(() => {
		const rankMap = projectRankMapRef.current;
		let maxRank = 0;
		for (const r of rankMap.values()) if (r > maxRank) maxRank = r;
		const newcomers = deduplicatedProjects.filter((p) => !rankMap.has(normalizeSessionPathKey(p.path)));
		newcomers.sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0));
		for (const p of newcomers) rankMap.set(normalizeSessionPathKey(p.path), ++maxRank);
		return [...deduplicatedProjects].sort(
			(a, b) =>
				(rankMap.get(normalizeSessionPathKey(a.path)) ?? 0) - (rankMap.get(normalizeSessionPathKey(b.path)) ?? 0),
		);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [deduplicatedProjects, projectOrderVersion]);

	const moveProject = useCallback(
		(fromPath: string, toPath: string, after: boolean) => {
			const from = normalizeSessionPathKey(fromPath);
			const to = normalizeSessionPathKey(toPath);
			if (from === to) return;
			const keys = stableProjects.map((p) => normalizeSessionPathKey(p.path)).filter((k) => k !== from);
			const idx = keys.indexOf(to);
			if (idx < 0) return;
			keys.splice(after ? idx + 1 : idx, 0, from);
			const rankMap = projectRankMapRef.current;
			let r = 0;
			for (const k of keys) rankMap.set(k, ++r);
			for (const [k, v] of rankMap) if (!keys.includes(k)) rankMap.set(k, r + v);
			setProjectOrderVersion((v) => v + 1);
		},
		[stableProjects],
	);
	const [dragProject, setDragProject] = useState<string | null>(null);
	const [dropHint, setDropHint] = useState<{ path: string; after: boolean } | null>(null);

	const effectiveProjects = stableProjects;

	const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => {
		try {
			const raw = localStorage.getItem("pi-web-ui:lp-expanded-projects");
			if (raw) {
				const arr = JSON.parse(raw);
				if (Array.isArray(arr)) {
					const s = new Set<string>(arr);
					const norm = normalizeSessionPathKey(currentCwd);
					if (norm) s.add(norm);
					return s;
				}
			}
		} catch {}
		const s = new Set<string>();
		const norm = normalizeSessionPathKey(currentCwd);
		if (norm) s.add(norm);
		return s;
	});

	useEffect(() => {
		try {
			localStorage.setItem("pi-web-ui:lp-expanded-projects", JSON.stringify([...expandedProjects]));
		} catch {}
	}, [expandedProjects]);

	const [projectVisibleCounts, setProjectVisibleCounts] = useState<Record<string, number>>(() => {
		try {
			const raw = localStorage.getItem(LS_VISIBLE_COUNTS);
			const parsed = raw ? (JSON.parse(raw) as unknown) : null;
			if (parsed && typeof parsed === "object") {
				const out: Record<string, number> = {};
				for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
					if (typeof v === "number" && v > 8) out[k] = Math.min(v, 5000);
				}
				return out;
			}
		} catch {}
		return {};
	});
	useEffect(() => {
		try {
			localStorage.setItem(LS_VISIBLE_COUNTS, JSON.stringify(projectVisibleCounts));
		} catch {}
	}, [projectVisibleCounts]);
	const serverListLimit = useCallback(
		(projectPath: string): number | undefined => {
			const n = projectVisibleCounts[normalizeSessionPathKey(projectPath)];
			return n && n > SESSION_LIST_DEFAULT ? Math.ceil(n / SESSION_LIST_DEFAULT) * SESSION_LIST_DEFAULT : undefined;
		},
		[projectVisibleCounts],
	);
	const [loadingMore, setLoadingMore] = useState<Set<string>>(() => new Set());
	useEffect(() => {
		setLoadingMore((prev) => (prev.size === 0 ? prev : new Set()));
	}, [projectSessions, sessions]);
	const [loadingProjects, setLoadingProjects] = useState<Set<string>>(() => new Set());

	useEffect(() => {
		if (!projectSessions) return;
		setLoadingProjects((prev) => {
			if (prev.size === 0) return prev;
			let changed = false;
			const next = new Set(prev);
			for (const key of prev) {
				if (projectSessions[key] !== undefined) {
					next.delete(key);
					changed = true;
				}
			}
			return changed ? next : prev;
		});
	}, [projectSessions]);

	useEffect(() => {
		const normCur = normalizeSessionPathKey(currentCwd);
		if (normCur) {
			setExpandedProjects((prev) => {
				if (prev.has(normCur)) return prev;
				const next = new Set(prev);
				next.add(normCur);
				return next;
			});
			setLoadingProjects((prev) => {
				if (!prev.has(normCur)) return prev;
				const next = new Set(prev);
				next.delete(normCur);
				return next;
			});
		}
	}, [currentCwd]);

	const initialRequestedRef = useRef<Set<string>>(new Set());
	const toggleProjectExpand = useCallback(
		(projectPath: string) => {
			const normP = normalizeSessionPathKey(projectPath);
			const willExpand = !expandedProjects.has(normP);
			setExpandedProjects((prev) => {
				const next = new Set(prev);
				if (willExpand) next.add(normP);
				else next.delete(normP);
				return next;
			});
			if (willExpand) {
				const limit = serverListLimit(projectPath);
				if (
					ready &&
					status === "open" &&
					panelSend(
						limit ? { type: "list_sessions", path: projectPath, limit } : { type: "list_sessions", path: projectPath },
					)
				) {
					initialRequestedRef.current.add(normP);
					setLoadingProjects((lp) => new Set(lp).add(normP));
				}
			} else {
				setLoadingProjects((lp) => {
					if (!lp.has(normP)) return lp;
					const copy = new Set(lp);
					copy.delete(normP);
					return copy;
				});
			}
		},
		[panelSend, expandedProjects, serverListLimit, ready, status],
	);

	useEffect(() => {
		if (!ready || status !== "open") {
			initialRequestedRef.current.clear();
			return;
		}
		if (effectiveProjects.length === 0) return;
		const curNorm = normalizeSessionPathKey(currentCwd);
		for (const p of effectiveProjects) {
			const pNorm = normalizeSessionPathKey(p.path);
			if (pNorm === curNorm) continue;
			if (expandedProjects.has(pNorm) && !initialRequestedRef.current.has(pNorm)) {
				const limit = serverListLimit(p.path);
				const sent = panelSend(
					limit ? { type: "list_sessions", path: p.path, limit } : { type: "list_sessions", path: p.path },
				);
				if (sent) {
					initialRequestedRef.current.add(pNorm);
					setLoadingProjects((lp) => (lp.has(pNorm) ? lp : new Set(lp).add(pNorm)));
				}
			}
		}
	}, [effectiveProjects, expandedProjects, currentCwd, panelSend, serverListLimit, ready, status]);

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

	const sessionMenuRef = useRef<{ x: number; y: number; target: SessionMenuTarget } | null>(null);
	const forceArmedRef = useRef<string | null>(null);
	const hostActionRef = useRef<(entry: UiSlotEntry, target: ContextMenuRequest["target"]) => void | boolean>(() => {});

	const sessionMenuAvailable =
		contextMenuItems(
			(uiContextSession ?? []).filter((entry) => quickAskReferenceMenus || entry.id !== "host:conv-quick-ask"),
		).length > 0;

	const showSessionMenu = useCallback(
		(x: number, y: number, target: SessionMenuTarget) => {
			sessionMenuRef.current = { x, y, target };
			const scopeId = target.kind === "running" ? target.id : undefined;
			const isElsewhere = target.kind === "elsewhere";
			const takeId = scopeId ?? (isElsewhere ? target.id || undefined : undefined);
			const reference: QuickAskReferenceSource | undefined = scopeId
				? { kind: "conversation", conversationId: scopeId }
				: target.kind === "history" && target.id
					? { kind: "conversation", sessionFile: target.id }
					: isElsewhere &&
						  takeId &&
						  target.owner &&
						  elsewhere.some((w) => w.owner === target.owner && w.convId === takeId)
						? { kind: "conversation", conversationId: takeId, owner: target.owner }
						: undefined;
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
				if (entry.source !== "host") return entry;
				if (entry.id === "host:conv-quick-ask")
					return quickAskReferenceMenus && reference ? entry : { ...entry, hidden: true };
				if (entry.id === "host:conv-rename")
					return target.kind === "running" || target.kind === "history" ? entry : { ...entry, hidden: true };
				if (entry.id === "host:conv-takeover") {
					const isScheduler = Boolean(target.pseudo && target.owner?.startsWith("scheduler:"));
					const isShared = elsewhere.some(
						(w) => w.owner === target.owner && w.convId === takeId && w.independent === false,
					);
					return isElsewhere && takeId && target.owner && !isScheduler && !isShared
						? entry
						: { ...entry, hidden: true };
				}
				if (isElsewhere && entry.id === "host:conv-dismiss-subagents") return { ...entry, hidden: true };
				if (entry.id === "host:conv-dismiss-subagents")
					return { ...entry, label, ...(nFinished === 0 ? { when: [...(entry.when ?? []), "disabled"] } : {}) };
				if (entry.id === "host:conv-force-dismiss")
					return armedTarget
						? { ...entry, ...(armed ? { label: t("forceDismissConfirm") } : {}) }
						: { ...entry, hidden: true };
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
				if (entry.id === "host:conv-persist") {
					if (!scopeId) return { ...entry, hidden: true };
					const targetConv = conversations.find((c) => c.id === scopeId);
					const canPersist = Boolean(targetConv && (targetConv.isSubagent || !targetConv.sessionFile));
					if (!canPersist) return { ...entry, hidden: true };
					return targetConv?.isEphemeral ? { ...entry, label: t("saveEphemeral") } : entry;
				}
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
			if (contextMenuItems(entries).length === 0) return false;
			openContextMenu({
				x,
				y,
				slot: "contextmenu.session",
				target,
				entries,
				onHostAction: (entry, tgt) => {
					if (entry.id === "host:conv-quick-ask") {
						if (reference) openQuickAsk({ reference });
						return;
					}
					return hostActionRef.current(entry, tgt);
				},
			});
			return true;
		},
		[
			uiContextSession,
			quickAskReferenceMenus,
			conversations,
			sessions,
			elsewhere,
			finishedSubagentCount,
			t,
			capabilities.conversationRef,
		],
	);

	const dispatchHostSessionEntry = useCallback(
		(entry: UiSlotEntry, target: ContextMenuRequest["target"]): void | boolean => {
			const scopeId = target.kind === "running" ? target.id : undefined;
			const takeId = scopeId ?? (target.kind === "elsewhere" ? target.id || undefined : undefined);
			if (entry.id === "host:conv-takeover") {
				if (target.kind === "elsewhere" && takeId && target.owner) {
					panelSend({ type: "take_over_conversation", owner: target.owner, id: takeId });
				}
				return;
			}
			if (entry.id === "host:conv-dismiss-subagents") {
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
					return true;
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
	hostActionRef.current = dispatchHostSessionEntry;

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

	const openSessionMenu = useCallback(
		(e: React.MouseEvent, target: SessionMenuTarget) => {
			if (isEditableTarget(e.target)) return;
			if (!sessionMenuAvailable) return;
			forceArmedRef.current = null;
			if (!showSessionMenu(e.clientX, e.clientY, target)) return;
			e.preventDefault();
			e.stopPropagation();
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
		ownerOffline?: boolean;
	};
	const panelRef = useRef<HTMLElement>(null);
	const [weights, setWeights] = useState<LpWeights>(() => loadLpWeights());
	useEffect(() => {
		try {
			localStorage.setItem(LS_LP_SIZES, JSON.stringify(weights));
		} catch {}
	}, [weights]);

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

	const projectTreeModel = useMemo(() => {
		const curNorm = normalizeSessionPathKey(currentCwd);
		const convsByProject = new Map<string, RowConv[]>();
		const parentIds = new Set<string>();
		for (const group of groupConversations(runningAll, currentCwd, activeConversationId)) {
			convsByProject.set(normalizeSessionPathKey(group.cwd), group.convs);
		}
		for (const c of runningAll) if (c.parentId) parentIds.add(c.parentId);
		const claimedSessionPaths = new Set<string>();
		const claimedSessionIds = new Set<string>();
		return effectiveProjects.map((p) => {
			const pNorm = normalizeSessionPathKey(p.path);
			const active = pNorm === curNorm;
			const isCollapsed = !expandedProjects.has(pNorm);

			const pConvsAll = convsByProject.get(pNorm) ?? [];

			const pStateSessions = projectSessions?.[pNorm];
			const propSessionsMatch = Boolean(
				sessions && sessions.length > 0 && isSessionMatchingProject(sessions[0].path, p.path),
			);
			const pCached = readCachedSessions(p.path, engine);
			const pRawSessions = propSessionsMatch
				? sessions
				: (pStateSessions ?? (pCached && pCached.length > 0 ? pCached : undefined) ?? (active ? sessions : []));
			const isLoadingSessions =
				!active && pStateSessions === undefined && loadingProjects.has(pNorm) && pRawSessions.length === 0;

			let diskIds: Set<string> | null = null;
			const getDiskIds = (): Set<string> => {
				if (diskIds) return diskIds;
				const ids = new Set<string>();
				for (const s of pRawSessions) if (s.sessionId) ids.add(s.sessionId.trim().toLowerCase());
				diskIds = ids;
				return ids;
			};

			const orderScope = conversationOrderScope(engine, p.path);
			conversationOrder.observe(
				orderScope,
				[...pConvsAll, ...pRawSessions],
				Boolean(ready && (!projectSessions || pNorm in projectSessions)),
			);
			const orderedConvs = conversationOrder.sort(orderScope, pConvsAll, (c) => c, false);
			const pRunningRaw = orderedConvs.filter((c) => {
				if (c.isStreaming || c.completionPending || c.hasQuestion) return true;
				if (c.isSubagent || Boolean(c.parentId)) return true;
				if (parentIds.has(c.id)) return true;
				if (c.elsewhere) return true;
				if (c.pinned || c.nativeCli) return true;
				if (!c.sessionFile) {
					const matchesDisk = Boolean(c.sessionId && getDiskIds().has(c.sessionId.trim().toLowerCase()));
					if (!matchesDisk) return true;
				}
				return false;
			});

			const pRunningRows = buildConversationRows(pRunningRaw, collapsedSubagents);

			for (const c of pRunningRaw) {
				if (c.sessionFile) claimedSessionPaths.add(normalizeSessionPathKey(c.sessionFile));
				if (c.sessionId) claimedSessionIds.add(c.sessionId.trim().toLowerCase());
			}

			const idleSessions = conversationOrder.sort(
				orderScope,
				pRawSessions.filter((s) => {
					if (!isSessionMatchingProject(s.path, p.path)) return false;
					const sNorm = normalizeSessionPathKey(s.path);
					if (sNorm && claimedSessionPaths.has(sNorm)) return false;
					const sId = s.sessionId?.trim().toLowerCase() || extractSessionIdFromPath(s.path)?.toLowerCase();
					if (sId && claimedSessionIds.has(sId)) return false;
					if (sNorm) claimedSessionPaths.add(sNorm);
					if (sId) claimedSessionIds.add(sId);
					return true;
				}),
				(session) => session,
				false,
			);

			const actuallyRunningCount = pRunningRaw.filter(
				(c) => c.isStreaming || c.hasQuestion || c.completionPending,
			).length;
			const unreadRunningCount = pRunningRaw.filter(
				(c) =>
					!c.isStreaming &&
					!c.completionPending &&
					checkUnread({ id: c.id, sessionId: c.sessionId, sessionFile: c.sessionFile }),
			).length;
			const unreadHistoryCount = idleSessions.filter((s) =>
				checkUnread({ sessionId: s.sessionId, sessionFile: s.path, path: s.path }),
			).length;

			const maxVisible = projectVisibleCounts[pNorm] ?? 8;
			const blocks: (
				| { kind: "conversation"; target: ConversationSummary; rows: ConvRowItem[] }
				| { kind: "session"; target: SessionSummary }
			)[] = [];
			for (const row of pRunningRows) {
				const previous = blocks.at(-1);
				if (row.depth > 0 && previous?.kind === "conversation") previous.rows.push(row);
				else blocks.push({ kind: "conversation", target: row.c, rows: [row] });
			}
			for (const session of idleSessions) blocks.push({ kind: "session", target: session });
			const orderedBlocks = conversationOrder
				.sort(orderScope, blocks, (block) => block.target, false)
				.map((block) => ({
					...block,
					key: conversationOrder.key(orderScope, block.target),
				}));
			const serverHasMore = Boolean(projectSessionsHasMore?.[pNorm]);
			return {
				serverHasMore,
				loadedCount: pRawSessions.length,
				p,
				pNorm,
				active,
				isCollapsed,
				isLoadingSessions,
				pRunningRows,
				idleSessions,
				orderedBlocks,
				maxVisible,
				hasMore: !isCollapsed && (idleSessions.length > maxVisible || serverHasMore),
				actuallyRunningCount,
				unreadCount: unreadRunningCount + unreadHistoryCount,
			};
		});
	}, [
		effectiveProjects,
		currentCwd,
		runningAll,
		expandedProjects,
		projectSessions,
		sessions,
		engine,
		loadingProjects,
		activeConversationId,
		collapsedSubagents,
		checkUnread,
		projectVisibleCounts,
		projectSessionsHasMore,
		conversationOrderVersion,
		ready,
	]);
	const sectionPlan = withDeviceGroupSection(planLeftSections(uiSections));
	const shownPlan = sectionPlan.filter((p) => p.shown);

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
		const limit = serverListLimit(cwd);
		panelSend(limit ? { type: "list_sessions", limit } : { type: "list_sessions" });
		panelSend({ type: "list_projects" });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [active, ready, status, cwd, panelSend]);

	const displayName = (s: SessionSummary): string => {
		const title = s.displayName || s.name || s.firstMessage?.trim();
		return title && title.length > 0 ? title : t("emptyChat");
	};

	const projectName = (path: string): string => path.split(/[\\/]/).pop() || path;

	const treeNavItems = (from: HTMLElement): HTMLElement[] => {
		const tree = from.closest<HTMLElement>('[role="tree"]');
		if (!tree) return [];
		return [...tree.querySelectorAll<HTMLElement>("[data-lp-nav]")].filter(
			(el) => !el.closest(".lp-history-collapsible.collapsed") && !(el as HTMLButtonElement).disabled,
		);
	};
	const focusTreeItem = (from: HTMLElement, delta: number | "first" | "last") => {
		const items = treeNavItems(from);
		if (items.length === 0) return;
		const idx = items.indexOf(from);
		const next =
			delta === "first"
				? 0
				: delta === "last"
					? items.length - 1
					: idx < 0
						? delta > 0
							? 0
							: items.length - 1
						: Math.min(items.length - 1, Math.max(0, idx + delta));
		items[next]?.focus();
	};
	const handleTreeKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
		const el = e.target as HTMLElement;
		if (!el.hasAttribute("data-lp-nav")) return;
		const projectPath = el.getAttribute("data-project-path");
		switch (e.key) {
			case "ArrowDown":
			case "ArrowUp": {
				e.preventDefault();
				if (e.altKey && projectPath) {
					const order = stableProjects.map((p) => p.path);
					const i = order.indexOf(projectPath);
					const j = e.key === "ArrowDown" ? i + 1 : i - 1;
					if (i < 0 || j < 0 || j >= order.length) return;
					moveProject(projectPath, order[j]!, e.key === "ArrowDown");
					requestAnimationFrame(() => {
						const tree = el.closest('[role="tree"]') ?? document;
						for (const h of tree.querySelectorAll<HTMLElement>("[data-project-path]")) {
							if (h.getAttribute("data-project-path") === projectPath) h.focus();
						}
					});
					return;
				}
				focusTreeItem(el, e.key === "ArrowDown" ? 1 : -1);
				return;
			}
			case "Home":
			case "End":
				e.preventDefault();
				focusTreeItem(el, e.key === "Home" ? "first" : "last");
				return;
			case "ArrowRight":
				if (projectPath && !expandedProjects.has(normalizeSessionPathKey(projectPath))) {
					e.preventDefault();
					toggleProjectExpand(projectPath);
				}
				return;
			case "ArrowLeft":
				e.preventDefault();
				if (projectPath) {
					if (expandedProjects.has(normalizeSessionPathKey(projectPath))) toggleProjectExpand(projectPath);
				} else {
					el.closest(".lp-project-node")?.querySelector<HTMLElement>("[data-project-path]")?.focus();
				}
				return;
		}
	};

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

	const delButton = (
		key: string,
		hint: string,
		confirmHint: string,
		onConfirm: () => void,
		icon?: React.ReactNode,
		requiresConfirmation = true,
	) => {
		const armed = confirmDel === key;
		return (
			<button
				type="button"
				className={`lp-del ${armed ? "confirm" : ""}`}
				title={armed ? confirmHint : hint}
				onClick={(e) => {
					e.stopPropagation();
					if (!requiresConfirmation || armed) {
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

	const expandedForFlex = flexKeys.filter((k) => !collapsedOf(k));
	const totalWeightForFlex = expandedForFlex.reduce((sum, k) => sum + (weights[k] ?? 1), 0) || 1;
	const effFlex = (k: LpSectionKey) => {
		if (expandedForFlex.length <= 1) return 1;
		const w = weights[k] ?? 1;
		return (w / totalWeightForFlex) * expandedForFlex.length;
	};
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

	const renderHistorySessionRow = (s: SessionSummary, projectPath?: string) => {
		const normCur = normalizeSessionPathKey(currentFile);
		const normPath = normalizeSessionPathKey(s.path);
		const runInfo = getHistoryRunningInfo(s);
		const active = Boolean(
			(normCur && normCur === normPath) ||
			(!sharedConversationOwner && activeConversationId && runInfo?.conv?.id === activeConversationId),
		);
		const switching = transition?.kind === "session" && normalizeSessionPathKey(transition.target) === normPath;
		const isStreaming = Boolean(runInfo?.isStreaming);
		const hasQuestion = Boolean(runInfo?.hasQuestion);
		const hasError = Boolean(runInfo?.hasError || runInfo?.error);
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

		const rawTitle = renameOverrides[s.path] ?? displayName(s);
		const { cleanTitle, categoryTag } = categorizeTitle(
			rawTitle,
			{
				fork: Boolean(s.parentSessionPath || runInfo?.conv?.forkFrom),
				scheduler: Boolean(runInfo?.conv?.elsewhere && runInfo.conv.owner?.startsWith("scheduler:")),
				tui: s.source === "tui",
			},
			t,
		);

		const sessionKey = normPath || normalizeSessionPathKey(s.sessionId) || s.path;

		return (
			<div
				className="lp-row"
				key={s.path}
				data-session-key={sessionKey}
				onMouseLeave={() => setConfirmDel((k) => (k === `sess:${s.path}` ? null : k))}
				onContextMenu={(e) => openSessionMenu(e, { id: s.path, kind: "history", label: rawTitle })}
			>
				<RowMain
					editing={renaming === s.path}
					className={`session-item lp-tree-session-item ${active ? "active" : ""} ${switching ? "switching" : ""}${isActuallyRunning ? " is-running" : ""}${isUnread ? " is-unread" : ""}`}
					title={s.path}
					disabled={switching}
					aria-current={active ? "true" : undefined}
					data-lp-nav=""
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
					{active && <span className="conv-current-badge">{t("current")}</span>}
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
									commitRename(s.path, { type: "rename_session", path: s.path }, s.path, rawTitle);
								} else if (e.key === "Escape") {
									cancelRename();
								}
							}}
							onBlur={() => commitRename(s.path, { type: "rename_session", path: s.path }, s.path, rawTitle)}
						/>
					) : (
						<span className="conv-title-text" title={rawTitle}>
							{cleanTitle}
						</span>
					)}

					{}
					<span className="conv-meta-zone">
						{s.pinned && (
							<span className="pin-badge" title={t("pinnedConversation")}>
								📌
							</span>
						)}
						{runInfo?.conv?.isEphemeral && (
							<span className="ephemeral-badge" title={t("newChatEphemeralTip")}>
								{t("newChatEphemeral") || "临时"}
							</span>
						)}
						{categoryTag && <span className={`category-badge-pill ${categoryTag.key}`}>{categoryTag.label}</span>}

						<ConversationRowIndicator time={formatModified(s.modified)}>
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
									<FiCheck size={13} strokeWidth={3} aria-hidden="true" />
								</span>
							) : null}
						</ConversationRowIndicator>
					</span>
				</RowMain>
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

	const renderSingleConvRow = (
		{ c, depth, hasKids, isCollapsed, descendantCount, hasStreaming, hasError, hasQuestion }: ConvRowItem,
		projectPath?: string,
	) => {
		const convSessionKey = normalizeSessionPathKey(c.sessionFile || c.sessionId || c.id);
		const matchSess = projectPath
			? (
					projectSessions?.[normalizeSessionPathKey(projectPath)] ??
					(normalizeSessionPathKey(projectPath) === normalizeSessionPathKey(currentCwd) ? sessions : undefined)
				)?.find((s) => {
					if (c.sessionFile && normalizeSessionPathKey(s.path) === normalizeSessionPathKey(c.sessionFile)) return true;
					if (c.sessionId && s.sessionId && s.sessionId.trim().toLowerCase() === c.sessionId.trim().toLowerCase())
						return true;
					return false;
				})
			: undefined;
		const convTime = c.modified ?? matchSess?.modified;

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
							? `${t("lpOpenOnDesktopTip")}\n${c.cwd}`
							: `${t(isOffline ? "elsewhereOfflineTip" : "elsewhereTip")}\n${c.cwd}`;

			const { cleanTitle, categoryTag } = categorizeTitle(
				c.title,
				{ fork: Boolean(c.forkFrom), scheduler: isScheduler },
				t,
			);

			return (
				<div
					className={`lp-row${depth > 0 ? " lp-sub" : ""}${hasKids ? " lp-has-kids" : ""}`}
					key={c.id}
					data-session-key={convSessionKey}
					style={depth > 0 ? ({ "--depth": Math.min(depth, 4) } as React.CSSProperties) : undefined}
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
					{hasKids && (
						<button
							type="button"
							className="lp-tree-caret"
							title={isCollapsed ? t("expandSubagents") : t("collapseSubagents")}
							aria-label={isCollapsed ? t("expandSubagents") : t("collapseSubagents")}
							aria-expanded={!isCollapsed}
							onClick={(e) => {
								e.stopPropagation();
								toggleSubagents(c.id);
							}}
						>
							{isCollapsed ? <FiChevronRight aria-hidden="true" /> : <FiChevronDown aria-hidden="true" />}
						</button>
					)}
					<button
						type="button"
						className={`session-item lp-tree-session-item elsewhere-item${active ? " active" : ""}${canClick ? "" : " elsewhere-static"}${confirming ? " confirm" : ""}${isActuallyRunning ? " is-running" : ""}${isUnread ? " is-unread" : ""}`}
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
						{active && <span className="conv-current-badge">{t("current")}</span>}
						<span className="conv-title-text" title={c.title}>
							{confirming ? t("takeoverConfirm") : cleanTitle}
						</span>

						{}
						<span className="conv-meta-zone">
							{c.pinned && (
								<span className="pin-badge" title={t("pinnedConversation")}>
									📌
								</span>
							)}
							{c.isEphemeral && (
								<span className="ephemeral-badge" title={t("newChatEphemeralTip")}>
									{t("newChatEphemeral") || "临时"}
								</span>
							)}
							{categoryTag && <span className={`category-badge-pill ${categoryTag.key}`}>{categoryTag.label}</span>}

							{isScheduler ? (
								<span className="category-badge-pill scheduler">{t("scheduledTaskBadge")}</span>
							) : !isShared ? (
								<span className="category-badge-pill elsewhere">
									{isPseudo ? t("elsewherePseudoBadge") : t("elsewhereBadge")}
								</span>
							) : null}

							{isOffline && (
								<span className="category-badge-pill elsewhere offline" title={t("elsewhereOfflineTip")}>
									{t("elsewhereOfflineBadge")}
								</span>
							)}

							{c.agentPreset && c.agentPreset !== "standard" && (
								<span className="category-badge-pill subagent" title={c.agentPreset}>
									{presetNames?.[c.agentPreset] ?? c.agentPreset}
								</span>
							)}

							<ConversationRowIndicator time={convTime ? formatModified(convTime) : undefined}>
								{c.hasQuestion ? (
									<span
										className={`status-question-right${elseOwner && elseConvId && !isPseudo ? " clickable" : ""}`}
										style={elseOwner && elseConvId && !isPseudo ? { cursor: "pointer" } : undefined}
										title={t("takeoverHasQuestion")}
										onClick={
											elseOwner && elseConvId && !isPseudo
												? (e) => {
														e.stopPropagation();
														panelSend({
															type: "peek_elsewhere_question",
															owner: elseOwner as string,
															id: elseConvId as string,
														});
													}
												: undefined
										}
									>
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
										<FiCheck size={13} strokeWidth={3} aria-hidden="true" />
									</span>
								) : null}
							</ConversationRowIndicator>
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

		const { cleanTitle, categoryTag } = categorizeTitle(
			renameOverrides[c.id] ?? c.title,
			{
				fork: Boolean(c.forkFrom),
				scheduler: Boolean((c as RowConv).elsewhere && (c as RowConv).owner?.startsWith("scheduler:")),
			},
			t,
		);

		return (
			<div
				className={`lp-row${depth > 0 ? " lp-sub" : ""}${hasKids ? " lp-has-kids" : ""}`}
				key={c.id}
				data-session-key={convSessionKey}
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
						aria-expanded={!isCollapsed}
						onClick={(e) => {
							e.stopPropagation();
							toggleSubagents(c.id);
						}}
					>
						{isCollapsed ? <FiChevronRight aria-hidden="true" /> : <FiChevronDown aria-hidden="true" />}
					</button>
				)}
				<RowMain
					editing={renaming === `conv:${c.id}`}
					className={`session-item lp-tree-session-item ${active ? "active" : ""}${isActuallyRunning ? " is-running" : ""}${isUnread ? " is-unread" : ""}`}
					title={`${c.title}${projectPath ? "" : ` — ${c.cwd}`}`}
					aria-current={active ? "true" : undefined}
					data-lp-nav=""
					onClick={() => {
						clearConversationUnread(c.id);
						if (c.sessionId) clearConversationUnread(c.sessionId);
						if (c.sessionFile) clearConversationUnread(c.sessionFile);
						if (!active) panelSend({ type: "switch_conversation", id: c.id });
					}}
				>
					{}
					{c.nativeCli && (
						<FiTerminal
							size={13}
							className="native-cli-conversation-icon"
							title={t("nativeCli")}
							aria-label={t("nativeCli")}
						/>
					)}
					{active && <span className="conv-current-badge">{t("current")}</span>}
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
									commitRename(`conv:${c.id}`, { type: "rename_conversation", id: c.id }, c.id, c.title);
								} else if (e.key === "Escape") {
									cancelRename();
								}
							}}
							onBlur={() => commitRename(`conv:${c.id}`, { type: "rename_conversation", id: c.id }, c.id, c.title)}
						/>
					) : (
						<span className="conv-title-text" title={c.title}>
							{cleanTitle}
						</span>
					)}

					{}
					<span className="conv-meta-zone">
						{c.pinned && (
							<span className="pin-badge" title={t("pinnedConversation")}>
								📌
							</span>
						)}
						{c.isEphemeral && (
							<span className="ephemeral-badge" title={t("newChatEphemeralTip")}>
								{t("newChatEphemeral") || "临时"}
							</span>
						)}
						{categoryTag && <span className={`category-badge-pill ${categoryTag.key}`}>{categoryTag.label}</span>}

						{c.agentPreset && c.agentPreset !== "standard" && (
							<span className="category-badge-pill subagent" title={c.agentPreset}>
								{presetNames?.[c.agentPreset] ?? c.agentPreset}
							</span>
						)}

						<ConversationRowIndicator time={convTime ? formatModified(convTime) : undefined}>
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
									<FiCheck size={13} strokeWidth={3} aria-hidden="true" />
								</span>
							) : null}
						</ConversationRowIndicator>
					</span>
				</RowMain>
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
							!c.nativeCli,
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
					{buildConversationRows(
						conversationOrder.sort(conversationOrderScope(engine, g.cwd), g.convs, (c) => c, false),
						collapsedSubagents,
					).map((row) => renderSingleConvRow(row, g.cwd))}
				</div>
			))}
			{renderPluginRunning()}
		</>
	);

	const sectionNodes: Record<"projects" | "convs" | "sessions", React.ReactNode> = {
		projects: (
			<>
				{}
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
										className="lp-workspace-menu-item lp-new-chat-btn"
										title={t("newChatInCurrentProjectTip")}
										onClick={() => {
											setWorkspaceMenuOpen(false);
											panelSend({ type: "new_chat" });
											focusComposer();
										}}
									>
										<FiMessageSquare style={{ fontSize: "13px" }} />
										<span>{t("newChatAction")}</span>
									</button>
									{onCreateCli && (!tabs || tabs.includes("terminal")) && (
										<button
											type="button"
											className="lp-workspace-menu-item lp-new-cli-btn"
											onClick={() => {
												setWorkspaceMenuOpen(false);
												onCreateCli(cwd);
											}}
										>
											<FiTerminal style={{ fontSize: "13px" }} />
											<span>{t("nativeCliCreate")}</span>
										</button>
									)}
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
							<div
								className="lp-section-body projects-scroll"
								ref={projectScrollRef}
								onDoubleClick={handleBlankDoubleClick}
								role="tree"
								aria-label={t("lpProjectsTree")}
								onKeyDown={handleTreeKeyDown}
							>
								<div className="lp-filter">
									<FiSearch aria-hidden="true" />
									<input
										type="search"
										value={filterText}
										placeholder={t("lpFilterPlaceholder")}
										aria-label={t("lpFilterPlaceholder")}
										onChange={(e) => setFilterText(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Escape" && filterText) {
												e.stopPropagation();
												setFilterText("");
											} else if (e.key === "ArrowDown") {
												e.preventDefault();
												focusTreeItem(e.currentTarget, 1);
											}
										}}
									/>
									{filterText && (
										<button
											type="button"
											className="lp-filter-clear"
											title={t("lpFilterClear")}
											aria-label={t("lpFilterClear")}
											onClick={() => setFilterText("")}
										>
											<FiX />
										</button>
									)}
								</div>
								{(() => {
									const transitionCwdNorm =
										transition?.kind === "cwd" ? normalizeSessionPathKey(transition.target) : null;
									const q = filterText.trim().toLowerCase();
									const views = projectTreeModel.map((m) => {
										const visibleIdle = new Set(m.idleSessions.slice(0, m.maxVisible));
										const visibleModel = {
											...m,
											orderedBlocks: m.orderedBlocks.filter(
												(block) => block.kind === "conversation" || visibleIdle.has(block.target),
											),
										};
										if (!q) return visibleModel;
										const sbxName = m.p.sandbox?.name;
										const name = (sbxName ?? projectName(m.p.path)).toLowerCase();
										if (name.includes(q) || m.p.path.toLowerCase().includes(q)) return visibleModel;
										const runRows = m.pRunningRows.filter((r) => (r.c.title ?? "").toLowerCase().includes(q));
										const idle = m.idleSessions.filter((s) =>
											(renameOverrides[s.path] ?? displayName(s)).toLowerCase().includes(q),
										);
										if (runRows.length === 0 && idle.length === 0) return null;
										const matchingIds = new Set(runRows.map((row) => row.c.id));
										const matchingIdle = new Set(idle.slice(0, 50));
										const orderedBlocks = m.orderedBlocks
											.map((block) => {
												if (block.kind === "session") return matchingIdle.has(block.target) ? block : null;
												const rows = block.rows.filter((row) => matchingIds.has(row.c.id));
												return rows.length > 0 ? { ...block, rows } : null;
											})
											.filter((block) => block !== null);
										return {
											...m,
											isCollapsed: false,
											pRunningRows: runRows,
											idleSessions: idle,
											orderedBlocks,
											maxVisible: 50,
											hasMore: false,
										};
									});
									if (q && views.every((v) => v === null)) {
										return <div className="lp-filter-empty">{t("lpFilterNoMatch")}</div>;
									}
									return views.map((m) => {
										if (!m) return null;
										const {
											p,
											pNorm,
											active,
											isCollapsed,
											isLoadingSessions,
											pRunningRows,
											idleSessions,
											orderedBlocks,
											maxVisible,
											hasMore,
											actuallyRunningCount,
											unreadCount,
											serverHasMore,
											loadedCount,
										} = m;
										const switching = transitionCwdNorm !== null && transitionCwdNorm === pNorm;
										const sbx = p.sandbox;
										const dispName = sbx ? sbx.name : projectName(p.path);
										const hasRunning = actuallyRunningCount > 0;
										const hasHistory = idleSessions.length > 0;
										const hasUnread = unreadCount > 0;

										if (!isCollapsed) {
											everExpandedRef.current.add(pNorm);
										}
										const shouldMountChildren =
											!isCollapsed ||
											pRunningRows.length > 0 ||
											hasUnread ||
											active ||
											everExpandedRef.current.has(pNorm);

										const dropClass =
											dropHint?.path === p.path && dragProject && dragProject !== p.path
												? dropHint.after
													? " drop-after"
													: " drop-before"
												: "";
										return (
											<div
												className={`lp-project-node${dragProject === p.path ? " dragging" : ""}${dropClass}`}
												key={p.path}
												role="treeitem"
												aria-expanded={!isCollapsed}
												aria-selected={active}
												onDragOver={(e) => {
													if (!dragProject || dragProject === p.path) return;
													e.preventDefault();
													e.dataTransfer.dropEffect = "move";
													const r = e.currentTarget.getBoundingClientRect();
													const after = e.clientY > r.top + Math.min(r.height, 32) / 2;
													if (dropHint?.path !== p.path || dropHint.after !== after)
														setDropHint({ path: p.path, after });
												}}
												onDrop={(e) => {
													if (!dragProject) return;
													e.preventDefault();
													const r = e.currentTarget.getBoundingClientRect();
													moveProject(dragProject, p.path, e.clientY > r.top + Math.min(r.height, 32) / 2);
													setDragProject(null);
													setDropHint(null);
												}}
											>
												<div
													className={`lp-row lp-project-head-row${active ? " active" : ""}${switching ? " switching" : ""}${isCollapsed ? " is-collapsed" : " is-expanded"}${hasRunning ? " has-running" : ""}${hasUnread ? " has-unread" : ""}`}
													draggable={!switching}
													onDragStart={(e) => {
														e.dataTransfer.effectAllowed = "move";
														e.dataTransfer.setData("text/plain", p.path);
														setDragProject(p.path);
													}}
													onDragEnd={() => {
														setDragProject(null);
														setDropHint(null);
													}}
													onMouseLeave={() => setConfirmDel((k) => (k === `proj:${p.path}` ? null : k))}
													onContextMenu={(e) => openProjectMenu(e, p)}
												>
													<button
														type="button"
														className={`lp-project-header-item project-item ${active ? "active" : ""} ${switching ? "switching" : ""}${hasRunning ? " has-running" : ""}${hasUnread ? " has-unread" : ""}`}
														title={`${
															sbx?.sourcePath
																? `${dispName}\n${t("sandboxSourceLabel")}: ${sbx.sourcePath}\n${p.path}`
																: p.path
														}\n${t("lpDragToReorder")}`}
														disabled={switching}
														data-lp-nav=""
														data-project-path={p.path}
														aria-current={active ? "true" : undefined}
														aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
														onClick={() => {
															if (!switching) {
																if (!active) {
																	panelSend({ type: "set_cwd", path: p.path });
																	setExpandedProjects((prev) => {
																		const norm = normalizeSessionPathKey(p.path);
																		if (prev.has(norm)) return prev;
																		const next = new Set(prev);
																		next.add(norm);
																		return next;
																	});
																} else {
																	toggleProjectExpand(p.path);
																}
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
															aria-hidden="true"
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
																<path d="M2.5 4h7l-3.5 5z" />
															</svg>
														</span>
														{sbx && <LuFlaskConical className="project-icon sandbox-icon" />}
														<span className="lp-project-name" title={dispName}>
															{dispName}
														</span>
														{sbx && (
															<span className={`lp-sandbox-badge ${sbx.ephemeral ? "ephemeral" : "permanent"}`}>
																{sbx.ephemeral ? t("sandboxBadgeEphemeral") : t("sandboxBadgePermanent")}
															</span>
														)}
														<span className="conv-meta-zone">
															{switching && <HalfRingSpinner className="status-spinner-right" />}
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
																{switching ? `${transition?.progress ?? 0}%` : formatModified(p.lastUsed)}
															</span>
														</span>
													</button>

													<div className="lp-project-actions">
														<NativeCliCreateEntry cwd={p.path} onCreateCli={onCreateCli}>
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
														</NativeCliCreateEntry>
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

												{}
												{shouldMountChildren && (
													<div
														className={`lp-project-tree-children${isCollapsed ? " is-collapsed" : " is-expanded"}${pRunningRows.length > 0 ? " has-running-rows" : ""}`}
													>
														{}
														{orderedBlocks.map((block) => (
															<Fragment key={block.key}>
																{block.kind === "conversation" ? (
																	block.rows.map((row) => renderSingleConvRow(row, p.path))
																) : (
																	<div className={`lp-history-collapsible${isCollapsed ? " collapsed" : " expanded"}`}>
																		<div className="lp-history-collapsible-inner">
																			{renderHistorySessionRow(block.target, p.path)}
																		</div>
																	</div>
																)}
															</Fragment>
														))}

														{}
														<div className={`lp-history-collapsible${isCollapsed ? " collapsed" : " expanded"}`}>
															<div className="lp-history-collapsible-inner">
																{}
																{pRunningRows.length === 0 && idleSessions.length === 0 && (
																	<div className="lp-project-empty-tip">
																		{isLoadingSessions ? (
																			<span>{t("loadingSessions") || "正在读取会话…"}</span>
																		) : (
																			<span>{t("noSessionsYet") || "暂无历史会话"}</span>
																		)}
																	</div>
																)}

																{}
																{hasMore && (
																	<button
																		type="button"
																		className="lp-show-more-row"
																		data-lp-nav=""
																		disabled={loadingMore.has(pNorm)}
																		onClick={(e) => {
																			e.stopPropagation();
																			const nextVisible = maxVisible + 20;
																			setProjectVisibleCounts((prev) => ({
																				...prev,
																				[pNorm]: nextVisible,
																			}));
																			if (serverHasMore && nextVisible >= idleSessions.length) {
																				const limit =
																					Math.ceil((loadedCount + 1) / SESSION_LIST_DEFAULT) * SESSION_LIST_DEFAULT +
																					SESSION_LIST_DEFAULT;
																				panelSend({ type: "list_sessions", path: p.path, limit });
																				setLoadingMore((prev) => new Set(prev).add(pNorm));
																			}
																		}}
																	>
																		<span>
																			{loadingMore.has(pNorm)
																				? t("loadingSessions")
																				: t("lpShowMore", {
																						n:
																							idleSessions.length > maxVisible
																								? `${idleSessions.length - maxVisible}${serverHasMore ? "+" : ""}`
																								: "…",
																					})}
																		</span>
																	</button>
																)}
															</div>
														</div>

														{}
														{isCollapsed && hasHistory && (pRunningRows.length > 0 || hasUnread) && (
															<button
																type="button"
																className="lp-collapsed-history-tip"
																data-lp-nav=""
																onClick={(e) => {
																	e.stopPropagation();
																	toggleProjectExpand(p.path);
																}}
																title={t("expandSection")}
															>
																<span>{t("lpCollapsedHistory", { n: idleSessions.length })}</span>
																<span aria-hidden="true">›</span>
															</button>
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
