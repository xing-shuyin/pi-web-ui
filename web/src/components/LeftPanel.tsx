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
import { createPortal } from "react-dom";
import { useFloatingPanel } from "../use-floating-panel";
import { useSessionListRequests } from "../use-session-list-requests";
import { loadProjectClickSwitch } from "../project-click-settings";
import {
	loadProjectOrder,
	loadProjectOrderManual,
	projectFirstSeen,
	saveProjectOrder,
	saveProjectOrderManual,
	useProjectOrderManual,
} from "../project-order-settings";
import { DeviceGroupSection } from "./DeviceGroupSection";
import { AgentBotsSection } from "./AgentBotsSection";
import {
	FiCheck,
	FiChevronDown,
	FiChevronLeft,
	FiChevronUp,
	FiEdit2,
	FiFolder,
	FiHardDrive,
	FiMessageSquare,
	FiMoreVertical,
	FiPlus,
	FiSearch,
	FiServer,
	FiTrash2,
	FiTerminal,
	FiX,
} from "react-icons/fi";
import { LuFlaskConical, LuFolder, LuFolderOpen } from "react-icons/lu";
import type {
	ConversationSummary,
	ElsewhereRunning,
	EngineId,
	NativeCliConfig,
	PluginPanelGroup,
	PluginPanelItem,
	ProjectSummary,
	SessionSummary,
} from "../types";
import { useT, type Translate } from "../i18n";
import { appSend, useAppField, useEngineCapabilities, useEngineStatuses } from "../app-globals";
import { ENGINE_CATALOG } from "../../../server/engine-catalog";
import { SUPPORTED_ENGINES } from "./EnginePicker";
import { useUnreadConversationKeys, clearConversationUnread } from "../unread-conversations";
import { applySashDrag } from "../panel-sash";
import {
	type LpSectionKey,
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
import { nativeCliRowState } from "../native-cli";
import { composeToComposer, focusComposer } from "../composer-bridge";
import { openQuickAsk, type QuickAskReferenceSource } from "../quick-ask";
import { buildSessionDeepLink, extractSessionIdFromPath } from "../session-url";
import { SessionIdentityIndex, sessionLookupKeys } from "../session-identity";
import {
	clearCachedProject,
	clearLastCwdIfMatches,
	isProjectPendingRemoval,
	isSessionMatchingProject,
	markProjectRemoved,
	normalizeSessionPathKey,
	readCachedSessions,
	readRemovedProjectKeys,
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
	/** 当前对话绑定的 Bot（私聊）；用来高亮左栏「智能体」区的那一行。 */
	activeBotId?: string | null;
	projectSessions?: Record<string, SessionSummary[]>;
	projectSessionsHasMore?: Record<string, boolean>;
	engine?: string;
	unreadConvKeys?: ReadonlySet<string>;
	panelSend: (
		msg:
			| { type: "new_chat"; cwd?: string; engine?: EngineId }
			| { type: "new_cli_chat"; config: NativeCliConfig; cwd?: string }
			| { type: "list_sessions"; path?: string; limit?: number }
			| { type: "list_projects" }
			| { type: "switch_session"; path: string; engine?: EngineId }
			| { type: "switch_conversation"; id: string; engine?: EngineId }
			| { type: "set_cwd"; path: string; name?: string }
			| { type: "remove_project"; path: string }
			| { type: "rename_project"; path: string; name: string }
			| { type: "destroy_sandbox"; path: string }
			| { type: "delete_session"; path: string; engine?: EngineId }
			| { type: "delete_project_sessions"; path: string }
			| { type: "rename_session"; path: string; name: string }
			| { type: "rename_conversation"; id: string; name: string }
			| { type: "dismiss_conversation"; id: string; withFinishedSubagents?: boolean; force?: boolean; owner?: string }
			| { type: "dismiss_finished_subagents"; parentId?: string }
			| { type: "persist_conversation"; id: string }
			| { type: "pin_conversation"; id: string; pinned: boolean }
			| { type: "pin_session"; path: string; pinned: boolean }
			| { type: "take_over_conversation"; owner: string; id: string }
			| { type: "open_shared_conversation"; owner: string; id: string; readOnly?: boolean }
			| { type: "peek_elsewhere_question"; owner: string; id: string }
			| { type: "make_dir"; path: string; setAsCwd?: boolean; name?: string },
	) => boolean;
	active: boolean;
	collapsible?: boolean;
	onToggleCollapse?: () => void;

	uiContextSession?: UiSlotEntry[];
	quickAskReferenceMenus?: boolean;
	botDraftPrompt?: string;
	botDraftDefaultPrompt?: string;
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

function SubagentTreeBadge({
	count,
	isCollapsed,
	hasStreaming,
	hasQuestion,
	hasError,
	onToggle,
}: {
	count: number;
	isCollapsed: boolean;
	hasStreaming: boolean;
	hasQuestion: boolean;
	hasError: boolean;
	onToggle: () => void;
}) {
	const t = useT();
	const action = isCollapsed ? t("expandSubagents") : t("collapseSubagents");
	const label = `${count} ${t("subagentBadge")} · ${action}`;
	const statusClass = hasStreaming ? " has-streaming" : hasQuestion ? " has-question" : hasError ? " has-error" : "";
	return (
		<span
			role="button"
			tabIndex={0}
			className={`subagents-toggle-badge${isCollapsed ? " is-collapsed" : ""}${statusClass}`}
			title={label}
			aria-label={label}
			aria-expanded={!isCollapsed}
			onClick={(e) => {
				e.stopPropagation();
				onToggle();
			}}
			onKeyDown={(e) => {
				if (e.key !== "Enter" && e.key !== " ") return;
				e.preventDefault();
				e.stopPropagation();
				onToggle();
			}}
		>
			{hasStreaming ? (
				<span className="subagent-dot streaming" aria-hidden="true" />
			) : hasQuestion ? (
				<span className="subagent-dot question" aria-hidden="true">
					?
				</span>
			) : hasError ? (
				<span className="subagent-dot error" aria-hidden="true" />
			) : null}
			<span className="subagents-count-text">{count}</span>
		</span>
	);
}

type CategoryTag = { key: string; label: string };

function EngineGlyph({
	engine,
	className,
	title,
	ariaLabel,
}: {
	engine?: string;
	className?: string;
	title?: string;
	ariaLabel?: string;
}) {
	const key = (engine ?? "pi").toLowerCase();
	const label = title ?? key.toUpperCase();
	const cls = className ? `lp-engine-glyph ${className}` : "lp-engine-glyph";
	const ariaHidden = ariaLabel ? undefined : true;
	if (key === "claude") {
		// Claude 官方 Logo
		return (
			<span className={cls} data-engine="claude" title={label} aria-label={ariaLabel} aria-hidden={ariaHidden}>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd">
					<path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z" />
				</svg>
			</span>
		);
	}
	if (key === "codex") {
		// OpenAI / Codex 官方 Logo
		return (
			<span className={cls} data-engine="codex" title={label} aria-label={ariaLabel} aria-hidden={ariaHidden}>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd">
					<path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z" />
				</svg>
			</span>
		);
	}
	if (key === "agy") {
		// Antigravity 官方 Logo
		return (
			<span className={cls} data-engine="agy" title={label} aria-label={ariaLabel} aria-hidden={ariaHidden}>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd">
					<path d="M21.751 22.607c1.34 1.005 3.35.335 1.508-1.508C17.73 15.74 18.904 1 12.037 1 5.17 1 6.342 15.74.815 21.1c-2.01 2.009.167 2.511 1.507 1.506 5.192-3.517 4.857-9.714 9.715-9.714 4.857 0 4.522 6.197 9.714 9.715z" />
				</svg>
			</span>
		);
	}
	if (key === "dsh") {
		// DSH / DeepSeek 官方鲸鱼 Logo
		return (
			<span className={cls} data-engine="dsh" title={label} aria-label={ariaLabel} aria-hidden={ariaHidden}>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd">
					<path d="M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 01-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 00-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 01-.465.137 9.597 9.597 0 00-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 001.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 011.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 01.415-.287.302.302 0 01.2.288.306.306 0 01-.31.307.303.303 0 01-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 01-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 01.016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 01-.254-.078c-.11-.054-.2-.19-.114-.358.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z" />
				</svg>
			</span>
		);
	}
	if (key === "durable") {
		// Durable 持久化/工作流盾牌图标
		return (
			<span className={cls} data-engine="durable" title={label} aria-label={ariaLabel} aria-hidden={ariaHidden}>
				<svg
					width="14"
					height="14"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.8"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<path d="M12 3 5 6v6c0 4.5 3 7.8 7 9 4-1.2 7-4.5 7-9V6l-7-3Z" />
					<path d="m9.5 12 1.8 1.8 3.4-3.6" />
				</svg>
			</span>
		);
	}
	// Pi 希腊字母 π 图标
	return (
		<span className={cls} data-engine={key} title={label} aria-label={ariaLabel} aria-hidden={ariaHidden}>
			<svg
				width="14"
				height="14"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<path d="M4.5 7.5c2.2-1 4.5-1 7.5-1h7.5" />
				<path d="M9.5 6.8v10.7c0 .8-.4 1.5-1 1.8" />
				<path d="M15.5 6.8v8.4c0 1.9.9 3.3 2.5 3.3.7 0 1.3-.3 1.7-.8" />
			</svg>
		</span>
	);
}
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

/**
 * 项目收起时，钉住的历史行仍然保持展开：钉住就是让它常驻，
 * 否则一收起项目它就从左栏消失，和没钉一样。
 */
export function isPinnedRowVisible(
	isCollapsed: boolean,
	block: { kind: "conversation" | "session"; target: { pinned?: boolean } },
): boolean {
	return isCollapsed && block.kind === "session" && Boolean(block.target.pinned);
}

type SessionMenuTarget = {
	id: string;
	kind: "running" | "history" | "section" | "elsewhere";
	label: string;
	owner?: string;
	pseudo?: boolean;
	/**
	 * 该行自己的钉住状态。跨项目的历史行不在「当前项目的 sessions」里，
	 * 菜单只能靠它判断该显示「钉住」还是「取消钉住」（否则永远显示「钉住」）。
	 */
	pinned?: boolean;
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
/** 每个项目默认先渲染这么多条历史会话，其余靠「显示更多」逐页展开。 */
const SESSION_ROWS_DEFAULT = 5;
/** 「显示更多」每点一次多渲染的条数。 */
const SESSION_ROWS_STEP = 10;
/**
 * 首屏向服务端要的条数（服务端下限 `SESSION_LIST_MIN` 同值）。
 * 比首屏渲染的 5 条多要一些，多出来的当本地余量：下一次「显示更多」不用再跑一轮网络 + 磁盘扫描。
 * 服务端也只按这个数向前解析（约 80 个文件），不再无脑扫最新的 260 个。
 */
const SESSION_LIST_FIRST_PAGE = 20;
// 旧版本把展开条数写进 localStorage，刷新后会把上次展开的几十上百条原样恢复（阅读压力大）。
// 展开条数现在只活在本页内存里，刷新一律回到 SESSION_ROWS_DEFAULT；顺手清掉历史键。
try {
	if (typeof localStorage !== "undefined") localStorage.removeItem("pi-web-ui:lp-visible-counts");
} catch {}

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

/**
 * 完成证据角标：只标「没核对通过」的三种裁决，`pass` 不占位（免噪声）。
 * 详情（哪些文件/命令没对上）在完成通知与 get_result 里，这里只负责别让未验证看起来像已验证。
 */
function subagentVerdictBadge(c: ConversationSummary, t: Translate) {
	const verdict = c.subagentVerdict;
	if (!verdict || verdict === "pass") return null;
	const meta =
		verdict === "blocked"
			? { kind: "blocked", label: t("subagentVerdictBlocked") }
			: verdict === "partial"
				? { kind: "partial", label: t("subagentVerdictPartial") }
				: { kind: "unverified", label: t("subagentVerdictUnverified") };
	return (
		<span className={`category-badge-pill evidence-${meta.kind}`} title={t("subagentVerdictHint")}>
			{meta.label}
		</span>
	);
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
	activeBotId,
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
	botDraftPrompt,
	botDraftDefaultPrompt,
	uiLeftSessions,
	uiContextProject,
	uiProjectsActions,
	uiLeftProject,
	uiRunningActions: _uiRunningActions,
	uiHistoryActions: _uiHistoryActions,
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
	const [projectPickerInitialTab, setProjectPickerInitialTab] = useState<"local" | "remote" | undefined>(undefined);
	const [confirmDel, setConfirmDel] = useState<string | null>(null);
	const [removedProjectsVersion, setRemovedProjectsVersion] = useState(0);
	const [confirmTakeover, setConfirmTakeover] = useState<string | null>(null);
	const [renaming, setRenaming] = useState<string | null>(null);
	const [renameDraft, setRenameDraft] = useState("");
	const [renameOverrides, setRenameOverrides] = useState<Record<string, string>>({});
	const [filterText, setFilterText] = useState("");
	const [searchOpen, setSearchOpen] = useState(false);
	const [envFilter, setEnvFilter] = useState<"all" | "local" | "remote">("all");
	const filterInputRef = useRef<HTMLInputElement | null>(null);
	const renameActiveRef = useRef<string | null>(null);
	renameActiveRef.current = renaming;
	const cancelRename = () => {
		renameActiveRef.current = null;
		setRenaming(null);
	};
	const commitRename = (
		rowKey: string,
		msg:
			| { type: "rename_session"; path: string }
			| { type: "rename_conversation"; id: string }
			| { type: "rename_project"; path: string },
		overrideKey: string,
		currentTitle: string,
	) => {
		if (renameActiveRef.current !== rowKey) return;
		renameActiveRef.current = null;
		setRenaming(null);
		const name = renameDraft.trim();
		if (msg.type !== "rename_project") {
			if (!name || name === currentTitle) return;
		} else if (name === currentTitle) {
			return;
		}
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
				const proj = projects.find((p) => `proj:${p.path}` === k);
				if ((conv && conv.title === prev[k]) || sessionName(k) === prev[k] || (proj && (proj.name ?? "") === prev[k])) {
					delete next[k];
					changed = true;
				}
			}
			return changed ? next : prev;
		});
	}, [sessions, projectSessions, conversations, projects]);
	const [collapseProjects, toggleProjects] = useCollapsed(LS_COLLAPSE_PROJECTS, false);
	const [collapseConvs] = useCollapsed(LS_COLLAPSE_CONVS, false);
	const [collapseSessions] = useCollapsed(LS_COLLAPSE_SESSIONS, false);
	const [pluginCollapsed, togglePluginCollapsed] = usePluginSectionCollapse();
	const [collapseGroups, setCollapseGroups] = useState(false);
	const [collapsedSubagents, toggleSubagents] = useCollapsedSubagents();
	const [convTab, setConvTab] = useState<ConvTabMode>(() => loadConvTab());
	useEffect(() => {
		try {
			localStorage.setItem(LS_CONV_TAB, convTab);
		} catch {}
	}, [convTab]);
	const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
	// 左栏区块与面板都是 `overflow: hidden`：内联下拉会被裁掉（项目区折叠时整块菜单看不见），
	// 所以菜单经 `useFloatingPanel` 挂到 body，定位/翻转/点外关闭都交给这一条单源。
	const workspaceMenuAnchor = useRef<HTMLButtonElement | null>(null);
	const workspaceMenu = useFloatingPanel({
		open: workspaceMenuOpen,
		anchor: workspaceMenuAnchor,
		onClose: () => setWorkspaceMenuOpen(false),
		side: "bottom",
		align: "right",
	});
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
		const removedKeys = readRemovedProjectKeys();
		const seen = new Set<string>();
		const list: ProjectSummary[] = [];
		for (const p of projects) {
			const normP = normalizeSessionPathKey(p.path);
			if (seen.has(normP) || isProjectPendingRemoval(p.path) || removedKeys.has(normP)) continue;
			seen.add(normP);
			list.push(p);
		}
		if (currentCwd && currentCwd !== "@root" && currentCwd !== "machine-root") {
			const normCur = normalizeSessionPathKey(currentCwd);
			if (!seen.has(normCur) && !removedKeys.has(normCur)) {
				seen.add(normCur);
				list.push({ path: currentCwd, lastUsed: 0 });
			}
		}
		for (const group of groupConversations(conversations, currentCwd, activeConversationId)) {
			if (!group.cwd) continue;
			const normC = normalizeSessionPathKey(group.cwd);
			if (!seen.has(normC) && !removedKeys.has(normC)) {
				seen.add(normC);
				list.push({ path: group.cwd, lastUsed: 0 });
			}
		}
		for (const e of elsewhere) {
			if (!e.cwd) continue;
			const normC = normalizeSessionPathKey(e.cwd);
			if (!seen.has(normC) && !removedKeys.has(normC)) {
				seen.add(normC);
				list.push({ path: e.cwd, lastUsed: 0 });
			}
		}
		return list;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [projects, currentCwd, conversations, elsewhere, activeConversationId, removedProjectsVersion]);

	const projectOrderManual = useProjectOrderManual();
	const [projectOrderVersion, setProjectOrderVersion] = useState(0);

	/**
	 * 项目排序两条路径：
	 * - 手动模式：只认持久化的拖拽/添加顺序，新出现的项目置顶。
	 * - 自动模式：按最近真实对话时间（`lastUsed`）降序；从没对话过的项目用「本浏览器首次出现时间」，
	 *   所以新添加的项目同样在最上方，而查看/切换项目不会改变它们的时间（服务端不再在切项目时刷 lastUsed）。
	 */
	const stableProjects = useMemo(() => {
		const keyOf = (p: ProjectSummary) => normalizeSessionPathKey(p.path);
		const firstSeen = projectFirstSeen(deduplicatedProjects.map(keyOf));
		const sortKey = (p: ProjectSummary) => {
			return p.lastUsed > 0 ? p.lastUsed : (firstSeen.get(keyOf(p)) ?? 0);
		};
		let ordered: ProjectSummary[];
		if (projectOrderManual) {
			const byKey = new Map(deduplicatedProjects.map((p) => [keyOf(p), p]));
			const known: ProjectSummary[] = [];
			for (const key of loadProjectOrder()) {
				const project = byKey.get(key);
				if (!project) continue;
				known.push(project);
				byKey.delete(key);
			}
			// 新出现的项目置顶，其余保持用户排列
			ordered = [...byKey.values(), ...known];
		} else {
			ordered = [...deduplicatedProjects].sort((a, b) => sortKey(b) - sortKey(a) || keyOf(a).localeCompare(keyOf(b)));
		}
		// 镜像当前顺序：切到手动模式时沿用眼前看到的排列，不会突然重排
		saveProjectOrder(ordered.map(keyOf));
		return ordered;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [deduplicatedProjects, projectOrderManual, projectOrderVersion]);

	const moveProject = useCallback(
		(fromPath: string, toPath: string, after: boolean) => {
			const from = normalizeSessionPathKey(fromPath);
			const to = normalizeSessionPathKey(toPath);
			if (from === to) return;
			const keys = stableProjects.map((p) => normalizeSessionPathKey(p.path)).filter((k) => k !== from);
			const idx = keys.indexOf(to);
			if (idx < 0) return;
			keys.splice(after ? idx + 1 : idx, 0, from);
			saveProjectOrder(keys);
			// 手动拖过就算要自己排：切到手动模式，别让下一次对话把顺序抢回去
			if (!loadProjectOrderManual()) saveProjectOrderManual(true);
			setProjectOrderVersion((v) => v + 1);
		},
		[stableProjects],
	);
	const [dragProject, setDragProject] = useState<string | null>(null);
	const [dropHint, setDropHint] = useState<{ path: string; after: boolean } | null>(null);

	const effectiveProjects = stableProjects;

	// 本地有没有「上次的展开/收起记录」：有就按记录恢复（刷新不该自己弹开），
	// 没有就是首次使用（当前项目要展开）。这个判断必须在挂载时定下来 ——
	// `cwd` 来自 websocket 快照，挂载那一刻通常还没到，不能拿它当判据。
	const persistedExpandedRef = useRef<Set<string> | null>(null);
	const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => {
		try {
			const raw = localStorage.getItem("pi-web-ui:lp-expanded-projects");
			if (raw) {
				const arr = JSON.parse(raw);
				if (Array.isArray(arr)) {
					persistedExpandedRef.current = new Set<string>(arr);
					return persistedExpandedRef.current;
				}
			}
		} catch {}
		return new Set<string>();
	});

	useEffect(() => {
		try {
			localStorage.setItem("pi-web-ui:lp-expanded-projects", JSON.stringify([...expandedProjects]));
		} catch {}
	}, [expandedProjects]);

	// 只记在内存里：刷新页面回到 SESSION_ROWS_DEFAULT，不会把上次展开到的大条数带回来。
	const [projectVisibleCounts, setProjectVisibleCounts] = useState<Record<string, number>>({});
	const serverListLimit = useCallback(
		(projectPath: string): number => {
			const visible = projectVisibleCounts[normalizeSessionPathKey(projectPath)] ?? SESSION_ROWS_DEFAULT;
			// 已经展开到很多条的项目重挂载时一次要够，别让列表缩回去。
			return Math.max(SESSION_LIST_FIRST_PAGE, visible + SESSION_ROWS_STEP);
		},
		[projectVisibleCounts],
	);
	const {
		request: requestSessions,
		pending: loadingProjects,
		failed: failedProjects,
	} = useSessionListRequests({
		send: panelSend,
		ready,
		status,
		engine,
		cwd: currentCwd,
		sessions,
		projectSessions,
	});
	const loadingMore = loadingProjects;

	const expandedSeededRef = useRef(false);
	useEffect(() => {
		const normCur = normalizeSessionPathKey(currentCwd);
		if (normCur) {
			// 首个拿到的 cwd：刷新场景保留用户收起的状态（有记录就不动），
			// 首次使用（没有记录）要展开当前项目；之后再切项目一律自动展开。
			if (!expandedSeededRef.current) {
				expandedSeededRef.current = true;
				if (persistedExpandedRef.current) return;
			}
			setExpandedProjects((prev) => {
				if (prev.has(normCur)) return prev;
				const next = new Set(prev);
				next.add(normCur);
				return next;
			});
		}
	}, [currentCwd]);

	const initialRequestedRef = useRef<Set<string>>(new Set());
	const requestedEngine = useRef(engine);
	useEffect(() => {
		if (requestedEngine.current !== engine) initialRequestedRef.current.clear();
		requestedEngine.current = engine;
	}, [engine]);
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
				if (requestSessions({ type: "list_sessions", path: projectPath, limit })) {
					initialRequestedRef.current.add(normP);
				}
			}
		},
		[requestSessions, expandedProjects, serverListLimit],
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
				const sent = requestSessions({ type: "list_sessions", path: p.path, limit });
				if (sent) {
					initialRequestedRef.current.add(pNorm);
				}
			}
		}
	}, [effectiveProjects, expandedProjects, currentCwd, requestSessions, serverListLimit, ready, status, engine]);

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
						const isPinned = target.pinned ?? sessions.find((s) => s.path === target.id)?.pinned;
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
					// 这里的 target 是右键系统的精简对象（没有 pinned），完整目标在 sessionMenuRef 里。
					const pinned = sessionMenuRef.current?.target.pinned ?? sessions.find((s) => s.path === target.id)?.pinned;
					panelSend({ type: "pin_session", path: target.id, pinned: !pinned });
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

			const rowId =
				w.convId && w.owner
					? `elsewhere:${w.owner}:${w.convId}`
					: w.sessionFile
						? `elsewhere:${w.owner}:${w.cwd}:${w.sessionFile}`
						: `elsewhere:${w.cwd}:${w.title}${w.owner ? `:${w.owner}` : ""}`;
			// 子代理行挂到同一持有方的父行下（双方 id 都由 `elsewhere:<owner>:` 拼成）
			const parentRowId = w.isSubagent && w.owner && w.parentId ? `elsewhere:${w.owner}:${w.parentId}` : undefined;

			filteredElsewhere.push({
				id: rowId,
				title: w.title,
				cwd: w.cwd,
				messageCount: 0,
				isStreaming: w.isStreaming,
				isSubagent: Boolean(w.isSubagent),
				...(parentRowId ? { parentId: parentRowId } : {}),
				elsewhere: true as const,
				pseudo: Boolean(w.pseudo),
				independent: w.independent,
				...(w.forked ? { forked: true as const } : {}),
				ownerOffline: Boolean(w.ownerOffline),
				sessionFile: w.sessionFile,
				...(w.owner && w.convId ? { owner: w.owner, convId: w.convId } : {}),
				...(w.hasQuestion ? { hasQuestion: true as const } : {}),
			});
		}

		// 父行没出来（被本地会话去重挡掉，或持有方只丢了子代理）就不留孤儿子代理行，
		// 否则 buildConversationRows 会把它当根行顶到列表最上面。
		const presentRowIds = new Set<string>(conversations.map((c) => c.id));
		for (const c of filteredElsewhere) presentRowIds.add(c.id);
		const keptElsewhere = filteredElsewhere.filter(
			(c) => !c.isSubagent || Boolean(c.parentId && presentRowIds.has(c.parentId)),
		);

		return [...conversations, ...keptElsewhere];
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

		const index = new SessionIdentityIndex<HistoryRunningInfo>();

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
				// 悬停提示优先给可读摘要（issue #978）：原文可能是 `<html>408 Request Time-out</html>`。
				// 线上 `error` 原文不动，摘要由 `server/model-error.ts` 分类产出（单源）。
				error: c.errorInfo?.summary ?? c.error,
			};

			index.add(c, info, sessionLookupKeys(c));
		}

		return index;
	}, [runningAll]);

	const getHistoryRunningInfo = useCallback(
		(s: SessionSummary): HistoryRunningInfo | undefined => {
			if (s.path.startsWith("conv:") && runningInfoBySession.has({ id: s.path })) {
				return runningInfoBySession.get({ id: s.path });
			}
			return runningInfoBySession.get(s, sessionLookupKeys(s));
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
		const claimed = new SessionIdentityIndex<true>();
		return effectiveProjects.map((p) => {
			const pNorm = normalizeSessionPathKey(p.path);
			const active = pNorm === curNorm;
			const isCollapsed = !expandedProjects.has(pNorm);

			const pConvsAll = convsByProject.get(pNorm) ?? [];

			const pStateSessions = projectSessions?.[pNorm];
			const propSessionsMatch = Boolean(
				sessions && sessions.length > 0 && isSessionMatchingProject(sessions[0], p.path),
			);
			const pCached = readCachedSessions(p.path, "all");
			const pRawSessions = propSessionsMatch
				? sessions
				: (pStateSessions ?? (pCached && pCached.length > 0 ? pCached : undefined) ?? (active ? sessions : []));
			const isLoadingSessions =
				!active && pStateSessions === undefined && loadingProjects.has(pNorm) && pRawSessions.length === 0;

			let diskIndex: SessionIdentityIndex<true> | null = null;
			const getDiskIndex = (): SessionIdentityIndex<true> => {
				if (diskIndex) return diskIndex;
				const index = new SessionIdentityIndex<true>();
				for (const s of pRawSessions) index.add(s, true);
				diskIndex = index;
				return index;
			};
			/**
			 * 旧服务端兼容分支：不带 `rowKind` 时只能按字段猜。
			 * 删除条件：移动端/桌面端与服务器最低支持版本都发过带 `rowKind` 的版本（新客户端连旧服）。
			 */
			const legacyOwnsRow = (c: RowConv): boolean => {
				if (c.isStreaming || c.completionPending || c.hasQuestion) return true;
				if (c.isSubagent || Boolean(c.parentId)) return true;
				if (parentIds.has(c.id)) return true;
				if (c.pinned || c.nativeCli) return true;
				if (!c.sessionFile) return !getDiskIndex().has(c);
				return false;
			};

			const orderScope = conversationOrderScope("all", p.path);
			conversationOrder.observe(
				orderScope,
				[...pConvsAll, ...pRawSessions],
				Boolean(ready && (!projectSessions || pNorm in projectSessions)),
			);
			const orderedConvs = conversationOrder.sort(orderScope, pConvsAll, (c) => c, false);
			// 行归属由引擎裁定（`rowKind`）：open = 对话自占一行，history = 交给历史行。
			const engineOwnsRows = pConvsAll.some((c) => c.rowKind !== undefined);
			const ownsRow = (c: RowConv): boolean => {
				if (c.elsewhere) return true;
				if (engineOwnsRows) return c.rowKind !== "history";
				return legacyOwnsRow(c);
			};
			const openRowConvs = orderedConvs.filter(ownsRow);

			const pRunningRows = buildConversationRows(openRowConvs, collapsedSubagents);

			for (const c of openRowConvs) claimed.add(c, true);

			const idleSessions = conversationOrder.sort(
				orderScope,
				pRawSessions.filter((s) => {
					if (!isSessionMatchingProject(s, p.path)) return false;
					// 同一会话已在“运行中对话”行里渲染过就不再进历史行（身份判定单源：session-identity）
					if (claimed.has(s)) return false;
					claimed.add(s, true);
					return true;
				}),
				(session) => session,
				false,
			);

			// 计数必须与「看得见的行」同源（issue #964）：折叠父行后子代理行不渲染，
			// 再用 openRowConvs 数就会“有计数、没行”。
			const actuallyRunningCount = pRunningRows.filter(
				(r) =>
					r.c.isStreaming ||
					r.hasStreaming ||
					r.c.hasQuestion ||
					r.hasQuestion ||
					r.c.completionPending ||
					Boolean(r.c.nativeCli && nativeCliRowState(r.c.nativeCli, r.c.error) === "busy"),
			).length;
			const unreadRunningCount = openRowConvs.filter(
				(c) =>
					!c.isStreaming &&
					!c.completionPending &&
					checkUnread({ id: c.id, sessionId: c.sessionId, sessionFile: c.sessionFile }),
			).length;
			const unreadHistoryCount = idleSessions.filter((s) =>
				checkUnread({ sessionId: s.sessionId, sessionFile: s.path, path: s.path }),
			).length;

			const maxVisible = projectVisibleCounts[pNorm] ?? SESSION_ROWS_DEFAULT;
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
	const hasGroupsSection = shownPlan.some((p) => p.key === "groups");

	// 智能体 / 群组块住在「项目」分区里（三者都是可点开的对象），只有项目分区被 uiSections
	// 隐藏时，群组才退回成一个可拖动分区自己站住。
	const effectivePlan = useMemo(
		() =>
			shownPlan.filter((p) => {
				if (p.key === "convs" || p.key === "sessions") return false;
				if (p.key === "groups" && shownPlan.some((x) => x.key === "projects")) return false;
				return true;
			}),
		[shownPlan],
	);

	const collapsedOf = useCallback(
		(k: LpSectionKey): boolean =>
			k === "projects"
				? collapseProjects
				: k === "convs"
					? collapseConvs
					: k === "sessions"
						? collapseSessions
						: k === "groups"
							? collapseGroups
							: pluginCollapsed.has(k),
		[collapseProjects, collapseConvs, collapseSessions, collapseGroups, pluginCollapsed],
	);

	const pluginItemCount = (uiPluginRunning ?? []).reduce((n, g) => n + g.items.length, 0);
	const runningCount = runningAll.length + pluginItemCount;

	useEffect(() => {
		if (runningCount === 0 && convTab === "running") {
			setConvTab("stream");
		}
	}, [runningCount, convTab]);

	const flexKeys = useMemo(
		() => effectivePlan.filter((p) => p.key !== "convs" && p.key !== "sessions").map((p) => p.key),
		[effectivePlan],
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
		panelSend({ type: "list_sessions", limit });
		panelSend({ type: "list_projects" });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [active, ready, status, cwd, panelSend]);

	const displayName = (s: SessionSummary): string => {
		const title = s.displayName || s.name || s.firstMessage?.trim();
		return title && title.length > 0 ? title : t("emptyChat");
	};

	const projectName = (path: string): string => path.split(/[\\/]/).pop() || path;
	const projectDisplayName = (project: { path: string; name?: string; sandbox?: { name: string } }): string => {
		if (project.sandbox) return project.sandbox.name;
		const override = renameOverrides[`proj:${project.path}`];
		if (override !== undefined) return override || projectName(project.path);
		return project.name?.trim() || projectName(project.path);
	};
	const lookupProjectName = (cwdPath: string): string => {
		const norm = normalizeSessionPathKey(cwdPath);
		const hit = effectiveProjects.find((p) => normalizeSessionPathKey(p.path) === norm);
		return hit ? projectDisplayName(hit) : projectName(cwdPath);
	};

	/** 提炼远程 SSH 工作区名称（如 root_192.168.1.101_22_ → 192.168.1.101 + SSH 徽标），完整路径保留在 title 中。 */
	const parseProjectEnv = (path: string, rawName: string): { label: string; isRemote: boolean; envTag?: string } => {
		const sshMatch = rawName.match(/^[^_]+_((?:\d{1,3}\.){3}\d{1,3}|[a-zA-Z0-9.-]+)_\d+_(.*)$/);
		if (sshMatch) {
			const host = sshMatch[1];
			const rest = sshMatch[2]?.replace(/^_+/, "");
			return { label: rest ? `${host}/${rest}` : host, isRemote: true, envTag: "SSH" };
		}
		if (/^(?:ssh|remote):\/\//i.test(path) || /[\\/]\.pi-web[\\/]ssh[\\/]/i.test(path)) {
			return { label: rawName, isRemote: true, envTag: "SSH" };
		}
		return { label: rawName, isRemote: false };
	};

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

	const projDelArmedRef = useRef<string | null>(null);
	const projectMenuAvailable = contextMenuItems(uiContextProject ?? []).length > 0;
	const openProjectMenuAt = useCallback(
		(x: number, y: number, project: ProjectSummary) => {
			const sbx = Boolean(project.sandbox);
			const armed = projDelArmedRef.current === project.path;
			const entries = (uiContextProject ?? []).map((entry) => {
				if (entry.source !== "host") return entry;
				if (entry.id === "host:proj-rename" && sbx) return { ...entry, hidden: true };
				if (entry.id === "host:proj-delete-all-sessions" && armed) {
					return { ...entry, label: t("deleteAllProjectSessionsConfirm") };
				}
				return entry;
			});
			if (contextMenuItems(entries).length === 0) return;
			openContextMenu({
				x,
				y,
				slot: "contextmenu.project",
				target: { id: project.path, kind: "project", label: projectDisplayName(project) },
				entries,
				onHostAction: (entry, tgt) => {
					if (entry.id === "host:proj-new-chat") {
						projDelArmedRef.current = null;
						panelSend({ type: "new_chat", cwd: tgt.id });
						focusComposer();
						return;
					}
					if (entry.id === "host:proj-rename") {
						projDelArmedRef.current = null;
						setConfirmDel(null);
						setRenameDraft(project.name ?? "");
						setRenaming(`proj:${tgt.id}`);
						return;
					}
					if (entry.id === "host:proj-delete-all-sessions") {
						if (projDelArmedRef.current !== tgt.id) {
							projDelArmedRef.current = tgt.id;
							openProjectMenuAt(x, y, project);
							return true;
						}
						projDelArmedRef.current = null;
						panelSend({ type: "delete_project_sessions", path: tgt.id });
						return;
					}
				},
			});
		},
		[uiContextProject, panelSend, focusComposer, t],
	);
	const openProjectMenu = useCallback(
		(e: React.MouseEvent, project: ProjectSummary) => {
			if (isEditableTarget(e.target)) return;
			if (!projectMenuAvailable) return;
			projDelArmedRef.current = null;
			e.preventDefault();
			e.stopPropagation();
			openProjectMenuAt(e.clientX, e.clientY, project);
		},
		[projectMenuAvailable, openProjectMenuAt],
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

	const renderHistorySessionRow = (s: SessionSummary, _projectPath?: string) => {
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
		const isCli = Boolean(s.nativeCli || runInfo?.conv?.nativeCli);
		const cliPhase = runInfo?.conv?.nativeCli?.status?.phase;
		const cliState = isCli ? nativeCliRowState(runInfo?.conv?.nativeCli, runInfo?.conv?.error) : undefined;
		const isCliRunning = cliState === "busy";
		const isCliWaiting = cliState === "waiting";
		const isCliExited = cliState === "ended";
		const isActuallyRunning = Boolean(
			isStreaming || hasQuestion || runInfo?.conv?.completionPending || runInfo?.conv?.isStreaming || isCliRunning,
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
				fork: Boolean(s.parentSessionPath || runInfo?.conv?.forkFrom || runInfo?.conv?.forked),
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
				onContextMenu={(e) => openSessionMenu(e, { id: s.path, kind: "history", label: rawTitle, pinned: s.pinned })}
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
							if (!active)
								panelSend({
									type: "switch_conversation",
									id: runInfo.conv.id,
									...(runInfo.conv.engine ? { engine: runInfo.conv.engine } : {}),
								});
							return;
						}
						if (!active)
							panelSend({
								type: "switch_session",
								path: s.path,
								...(s.engine ? { engine: s.engine } : {}),
							});
					}}
				>
					<div className="conv-main-col">
						<div className="conv-title-row">
							{active && <span className="conv-current-badge">{t("current")}</span>}
							{isCli ? (
								<EngineGlyph
									engine={s.nativeCli?.preset ?? runInfo?.conv?.nativeCli?.config?.preset ?? s.engine}
									className={`native-cli-conversation-icon${isCliRunning ? " is-running" : isCliWaiting ? " is-waiting" : isCliExited ? " is-exited" : ""}`}
									title={
										cliPhase
											? `${t("nativeCli")} (${t(`nativeCliSession.${cliPhase === "waiting_input" ? "waitingInput" : cliPhase === "waiting_approval" ? "waitingApproval" : cliPhase}`) || cliPhase})`
											: t("nativeCli")
									}
									ariaLabel={t("nativeCli")}
								/>
							) : (
								<EngineGlyph engine={s.engine} />
							)}
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
							{isCli && <span className="lp-cli-badge">CLI</span>}
							<span className="conv-meta-zone">
								<ConversationRowIndicator time={formatModified(s.modified)}>
									{switching ? (
										<HalfRingSpinner className="status-spinner-right" />
									) : hasQuestion || isCliWaiting ? (
										<span
											className="status-question-right"
											title={
												cliPhase === "waiting_approval"
													? t("nativeCliSession.waitingApproval")
													: t("nativeCliSession.waitingInput") || t("waitingQuestionBadge")
											}
										>
											?
										</span>
									) : isStreaming || isCliRunning ? (
										<div className="status-spinner-right" title={t("streaming")} />
									) : hasError || cliPhase === "error" ? (
										<span
											className="status-error-right"
											title={runInfo?.error || runInfo?.conv?.nativeCli?.status?.error || t("nativeCliSession.error")}
										>
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
						</div>
						{(s.pinned || runInfo?.conv?.isEphemeral || categoryTag) && (
							<div className="conv-tags-row">
								{s.pinned && (
									<span className="pin-badge" title={t("pinnedConversation")}>
										📌
									</span>
								)}
								{runInfo?.conv?.isEphemeral && (
									<span className="ephemeral-badge" title={t("newChatEphemeralTip")}>
										{t("newChatEphemeral")}
									</span>
								)}
								{categoryTag && <span className={`category-badge-pill ${categoryTag.key}`}>{categoryTag.label}</span>}
							</div>
						)}
					</div>
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
						panelSend({
							type: "delete_session",
							path: s.path,
							...(s.engine ? { engine: s.engine } : {}),
						});
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
		const cliActivity = c.nativeCli?.status?.lastActivityAt ?? c.nativeCli?.status?.updatedAt;
		const convTime = Math.max(c.modified ?? 0, matchSess?.modified ?? 0, cliActivity ?? 0) || undefined;

		if ((c as RowConv).elsewhere) {
			const elseOwner = (c as RowConv).owner;
			const elseConvId = (c as RowConv).convId;
			const isPseudo = Boolean((c as RowConv).pseudo);
			const isOffline = Boolean((c as RowConv).ownerOffline) && !isPseudo;
			const isScheduler = Boolean(typeof elseOwner === "string" && elseOwner.startsWith("scheduler:"));
			const isShared = (c as RowConv).independent === false;
			const isSubagentRow = Boolean(c.isSubagent);
			// 子代理对话不论持有方是谁都只能只读打开（服务端也只允许 readOnly 共享子代理）
			const canOpenDirectly = Boolean(elseOwner && elseConvId) && (isShared || isScheduler || isSubagentRow);
			const canTakeover = Boolean(elseOwner && elseConvId) && !isScheduler && !isShared && !isSubagentRow;
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
			const confirming = !isShared && !isScheduler && !isSubagentRow && confirmTakeover === c.id;
			const tooltip = isSubagentRow
				? `${t("subagentBadge")}\n${c.cwd}`
				: isShared
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
				{ fork: Boolean(c.forkFrom || c.forked), scheduler: isScheduler },
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
												// 子代理对话只能只看：服务端不允许接管/改写子代理
												...(isSubagentRow ? { readOnly: true } : {}),
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
							{hasKids && (
								<SubagentTreeBadge
									count={descendantCount}
									isCollapsed={isCollapsed}
									hasStreaming={hasStreaming}
									hasQuestion={hasQuestion}
									hasError={hasError}
									onToggle={() => toggleSubagents(c.id)}
								/>
							)}
							{c.pinned && (
								<span className="pin-badge" title={t("pinnedConversation")}>
									📌
								</span>
							)}
							{c.isEphemeral && (
								<span className="ephemeral-badge" title={t("newChatEphemeralTip")}>
									{t("newChatEphemeral")}
								</span>
							)}
							{categoryTag && <span className={`category-badge-pill ${categoryTag.key}`}>{categoryTag.label}</span>}
							{c.engine && c.engine !== "pi" && (
								<span className="category-badge-pill engine">{c.engine.toUpperCase()}</span>
							)}

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

							{isSubagentRow && (
								<span className="category-badge-pill subagent" title={c.title}>
									{t("subagentBadge")}
								</span>
							)}

							{c.agentPreset && c.agentPreset !== "standard" && (
								<span className="category-badge-pill subagent" title={c.agentPreset}>
									{presetNames?.[c.agentPreset] ?? c.agentPreset}
								</span>
							)}

							{subagentVerdictBadge(c, t)}

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
		const isCli = Boolean(c.nativeCli);
		const cliPhase = c.nativeCli?.status?.phase;
		const cliState = isCli ? nativeCliRowState(c.nativeCli, c.error) : undefined;
		const isCliRunning = cliState === "busy";
		const isCliWaiting = cliState === "waiting";
		const isCliExited = cliState === "ended";
		const isActuallyRunning = Boolean(c.isStreaming || hasStreaming || c.completionPending || isCliRunning);
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
				fork: Boolean(c.forkFrom || c.forked || matchSess?.parentSessionPath),
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
						if (!active)
							panelSend({
								type: "switch_conversation",
								id: c.id,
								...(c.engine ? { engine: c.engine } : {}),
							});
					}}
				>
					<div className="conv-main-col">
						<div className="conv-title-row">
							{c.nativeCli ? (
								<EngineGlyph
									engine={c.nativeCli.config?.preset ?? c.engine}
									className={`native-cli-conversation-icon${isCliRunning ? " is-running" : isCliWaiting ? " is-waiting" : isCliExited ? " is-exited" : ""}`}
									title={
										cliPhase
											? `${t("nativeCli")} (${t(`nativeCliSession.${cliPhase === "waiting_input" ? "waitingInput" : cliPhase === "waiting_approval" ? "waitingApproval" : cliPhase}`) || cliPhase})`
											: t("nativeCli")
									}
									ariaLabel={t("nativeCli")}
								/>
							) : (
								<EngineGlyph engine={c.engine} />
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
							{c.nativeCli && <span className="lp-cli-badge">CLI</span>}

							<span className="conv-meta-zone">
								{hasKids && (
									<SubagentTreeBadge
										count={descendantCount}
										isCollapsed={isCollapsed}
										hasStreaming={hasStreaming}
										hasQuestion={hasQuestion}
										hasError={hasError}
										onToggle={() => toggleSubagents(c.id)}
									/>
								)}
								<ConversationRowIndicator time={convTime ? formatModified(convTime) : undefined}>
									{hasQuestion || c.hasQuestion || isCliWaiting ? (
										<span
											className="status-question-right"
											title={
												cliPhase === "waiting_approval"
													? t("nativeCliSession.waitingApproval")
													: t("nativeCliSession.waitingInput") || t("waitingQuestionBadge")
											}
										>
											?
										</span>
									) : isActuallyRunning ? (
										<div className="status-spinner-right" title={t("streaming")} />
									) : c.error || cliPhase === "error" ? (
										<span
											className="status-error-right"
											title={c.error || c.nativeCli?.status?.error || t("nativeCliSession.error")}
										>
											!
										</span>
									) : isUnread ? (
										<span className="status-unread-right" title={t("completedUnreadTooltip")}>
											<FiCheck size={13} strokeWidth={3} aria-hidden="true" />
										</span>
									) : null}
								</ConversationRowIndicator>
							</span>
						</div>
						{(() => {
							const verdict = subagentVerdictBadge(c, t);
							const hasTags =
								c.pinned ||
								c.isEphemeral ||
								categoryTag ||
								(c.agentPreset && c.agentPreset !== "standard") ||
								Boolean(verdict);
							if (!hasTags) return null;
							return (
								<div className="conv-tags-row">
									{c.pinned && (
										<span className="pin-badge" title={t("pinnedConversation")}>
											📌
										</span>
									)}
									{c.isEphemeral && (
										<span className="ephemeral-badge" title={t("newChatEphemeralTip")}>
											{t("newChatEphemeral")}
										</span>
									)}
									{categoryTag && <span className={`category-badge-pill ${categoryTag.key}`}>{categoryTag.label}</span>}
									{c.agentPreset && c.agentPreset !== "standard" && (
										<span className="category-badge-pill subagent" title={c.agentPreset}>
											{presetNames?.[c.agentPreset] ?? c.agentPreset}
										</span>
									)}
									{verdict}
								</div>
							);
						})()}
					</div>
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
								panelSend({ type: "new_chat", cwd: g.cwd });
								focusComposer();
							}}
						>
							{lookupProjectName(g.cwd)}
						</div>
					)}
					{buildConversationRows(
						conversationOrder.sort(conversationOrderScope("all", g.cwd), g.convs, (c) => c, false),
						collapsedSubagents,
					).map((row) => renderSingleConvRow(row, g.cwd))}
				</div>
			))}
			{renderPluginRunning()}
		</>
	);

	const engineStatuses = useEngineStatuses();
	const [newChatEngineOpen, setNewChatEngineOpen] = useState(false);
	const newChatSplitRef = useRef<HTMLDivElement>(null);
	const newChatEngineMenu = useFloatingPanel({
		open: newChatEngineOpen,
		anchor: newChatSplitRef,
		align: "left",
		onClose: () => setNewChatEngineOpen(false),
	});
	const isEngineInstalled = useCallback(
		(id: string) => {
			if (id === "pi") return true;
			const status = engineStatuses.find((s) => s.id === id);
			return status ? status.installed : false;
		},
		[engineStatuses],
	);
	const cliEnginesForNewChat = useMemo(
		() => Object.values(ENGINE_CATALOG).filter((item) => Boolean(item.cliCommand)),
		[],
	);
	const triggerInstallEngine = useCallback(
		(name: string, command?: string | null) => {
			if (!command) return;
			if (/^https?:\/\//i.test(command)) {
				window.open(command, "_blank", "noopener,noreferrer");
				return;
			}
			window.dispatchEvent(
				new CustomEvent("pi-web-ui:plugin-run-command", {
					detail: {
						title: t("installEngineTabTitle", { name }),
						command,
					},
				}),
			);
		},
		[t],
	);

	const sectionNodes: Record<"projects" | "convs" | "sessions", React.ReactNode> = {
		projects: (
			<>
				{hasGroupsSection && (
					<DeviceGroupSection
						entry={uiSections?.find((entry) => entry.id === "host:lp-groups")}
						active={active}
						selectedRoomId={activeGroupId}
						hideWhenEmpty
						autoHeight
					/>
				)}
				<div
					className={`lp-section panel-projects ${collapseProjects ? "collapsed" : ""}`}
					style={!collapseProjects ? { flex: `${effFlex("projects")} 1 0px` } : undefined}
				>
					<div className="lp-c-top-header">
						<div className="lp-new-chat-split" ref={newChatSplitRef}>
							<button
								type="button"
								className="lp-new-chat-primary"
								title={t("newChatInCurrentProjectTip")}
								onClick={() => {
									panelSend({ type: "new_chat" });
									focusComposer();
								}}
							>
								<FiPlus aria-hidden="true" />
								<span>{t("newChatAction")}</span>
								<EngineGlyph engine={engine} className="lp-new-chat-engine-glyph" />
							</button>
							<button
								type="button"
								className="lp-new-chat-engine-btn"
								aria-haspopup="menu"
								aria-expanded={newChatEngineOpen}
								title={t("settingsEngineSection")}
								onClick={() =>
									setNewChatEngineOpen((v) => {
										const next = !v;
										if (next && SUPPORTED_ENGINES.some((item) => !isEngineInstalled(item.id))) {
											appSend({ type: "check_engines", force: true });
										}
										return next;
									})
								}
							>
								<FiChevronDown aria-hidden="true" />
							</button>
							{newChatEngineOpen &&
								createPortal(
									<div
										ref={newChatEngineMenu.panelRef}
										className="lp-new-chat-engine-menu"
										style={newChatEngineMenu.style}
										role="menu"
									>
										<div className="lp-new-chat-engine-head">{t("settingsEngineSection")}</div>
										{SUPPORTED_ENGINES.map((item) => {
											const installed = isEngineInstalled(item.id);
											const catalogEntry = ENGINE_CATALOG[item.id as keyof typeof ENGINE_CATALOG];
											const hasCli = Boolean(onCreateCli && catalogEntry?.cliCommand);
											const installCmd = item.installCommand ?? catalogEntry?.installCommand;
											const isCurrent = engine === item.id;
											const openChat = () => {
												setNewChatEngineOpen(false);
												if (!installed) {
													triggerInstallEngine(item.badge, installCmd);
													return;
												}
												panelSend({ type: "new_chat", engine: item.id as EngineId, cwd: currentCwd });
												focusComposer();
											};
											return (
												<div
													key={item.id}
													role="menuitem"
													tabIndex={0}
													className={`lp-new-chat-engine-row${isCurrent ? " active" : ""}${!installed ? " uninstalled" : ""}`}
													title={!installed ? t("engineInstallTip") : t(item.descKey)}
													onClick={openChat}
													onKeyDown={(e) => {
														if (e.key === "Enter" || e.key === " ") {
															e.preventDefault();
															openChat();
														}
													}}
												>
													<EngineGlyph engine={item.id} />
													<span className="lp-new-chat-engine-name">{t(item.titleKey)}</span>
													{!installed ? (
														<span className="lp-new-chat-engine-install-pill">{t("engineInstall")}</span>
													) : (
														<span className="lp-new-chat-engine-actions">
															{isCurrent && (
																<FiCheck size={12} className="lp-new-chat-engine-check" aria-hidden="true" />
															)}
															{hasCli && (
																<button
																	type="button"
																	className="lp-new-chat-cli-pill"
																	title={`${catalogEntry.name} CLI`}
																	onClick={(e) => {
																		e.stopPropagation();
																		setNewChatEngineOpen(false);
																		panelSend({
																			type: "new_cli_chat",
																			config: { preset: item.id as NativeCliConfig["preset"] },
																			cwd,
																		});
																	}}
																>
																	CLI
																</button>
															)}
														</span>
													)}
												</div>
											);
										})}
										{onCreateCli && (
											<>
												<div className="lp-new-chat-engine-divider" role="separator" />
												<button
													type="button"
													role="menuitem"
													className="lp-new-chat-engine-row lp-new-chat-engine-custom"
													onClick={() => {
														setNewChatEngineOpen(false);
														onCreateCli(cwd);
													}}
												>
													<FiTerminal size={12} className="lp-new-chat-custom-icon" aria-hidden="true" />
													<span className="lp-new-chat-engine-name">{t("nativeCliCreate")}…</span>
												</button>
											</>
										)}
									</div>,
									document.body,
								)}
						</div>
						<button
							type="button"
							className={`lp-section-action lp-c-icon-btn${searchOpen || filterText ? " active" : ""}`}
							title={t("lpFilterPlaceholder")}
							aria-label={t("lpFilterPlaceholder")}
							onClick={() => {
								setSearchOpen((prev) => {
									const next = !prev;
									if (next) setTimeout(() => filterInputRef.current?.focus(), 0);
									else setFilterText("");
									return next;
								});
							}}
						>
							<FiSearch />
						</button>
						<div className="lp-section-actions">
							<button
								type="button"
								ref={workspaceMenuAnchor}
								className={`lp-section-action lp-project-action lp-c-icon-btn ${workspaceMenuOpen ? "active" : ""}`}
								title={workspaceMenuOpen ? undefined : t("openProject")}
								aria-label={t("openProject")}
								aria-expanded={workspaceMenuOpen}
								onClick={(e) => {
									e.stopPropagation();
									setWorkspaceMenuOpen((prev) => !prev);
								}}
							>
								<FiFolder />
							</button>
							{renderInlineEntries(uiProjectsActions, "lp-slot-section")}
						</div>
						{collapsible && onToggleCollapse && (
							<button
								type="button"
								className="lp-section-action lp-c-icon-btn"
								title={t("collapsePanel")}
								aria-label={t("collapsePanel")}
								onClick={onToggleCollapse}
							>
								<FiChevronLeft />
							</button>
						)}
						{workspaceMenuOpen &&
							createPortal(
								<div
									ref={workspaceMenu.panelRef}
									className="lp-workspace-menu"
									style={workspaceMenu.style}
									role="menu"
									onClick={(e) => e.stopPropagation()}
								>
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
											setProjectPickerInitialTab("local");
											setProjectPickerOpen(true);
										}}
									>
										<FiHardDrive style={{ fontSize: "13px" }} />
										<span>{t("openLocalProject")}</span>
									</button>
									<button
										type="button"
										className="lp-workspace-menu-item lp-manage-projects-btn"
										onClick={() => {
											setWorkspaceMenuOpen(false);
											setProjectPickerInitialTab("remote");
											setProjectPickerOpen(true);
										}}
									>
										<FiServer style={{ fontSize: "13px" }} />
										<span>{t("openRemoteProject")}</span>
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
								</div>,
								document.body,
							)}
					</div>
					{!collapseProjects && effectiveProjects.length > 0 && (
						<div
							className="lp-section-body projects-scroll"
							ref={projectScrollRef}
							onDoubleClick={handleBlankDoubleClick}
							role="tree"
							aria-label={t("lpProjectsTree")}
							onKeyDown={handleTreeKeyDown}
						>
							{(searchOpen || filterText) && (
								<div className="lp-filter">
									<FiSearch aria-hidden="true" />
									<input
										ref={filterInputRef}
										type="search"
										value={filterText}
										placeholder={t("lpFilterPlaceholder")}
										aria-label={t("lpFilterPlaceholder")}
										onChange={(e) => setFilterText(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Escape") {
												e.stopPropagation();
												if (filterText) setFilterText("");
												else setSearchOpen(false);
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
							)}
							{effectiveProjects.some((p) => parseProjectEnv(p.path, projectDisplayName(p)).isRemote) && (
								<div className="lp-env-pills" role="tablist" aria-label={t("lpProjectsTree")}>
									{(["all", "local", "remote"] as const).map((mode) => (
										<button
											key={mode}
											type="button"
											role="tab"
											aria-selected={envFilter === mode}
											className={`lp-env-pill${envFilter === mode ? " active" : ""}`}
											onClick={() => setEnvFilter(mode)}
										>
											{mode === "all" ? t("lpEnvAll") : mode === "local" ? t("lpEnvLocal") : t("lpEnvRemote")}
										</button>
									))}
								</div>
							)}
							{(() => {
								const transitionCwdNorm =
									transition?.kind === "cwd" ? normalizeSessionPathKey(transition.target) : null;
								const q = filterText.trim().toLowerCase();
								const views = projectTreeModel.map((m) => {
									const rawName = projectDisplayName(m.p);
									const envInfo = parseProjectEnv(m.p.path, rawName);
									if (envFilter === "local" && envInfo.isRemote) return null;
									if (envFilter === "remote" && !envInfo.isRemote) return null;
									// 钉住的行不受 maxVisible 截断：它常驻，翻页也不能把它藏起来。
									const visibleIdle = new Set([
										...m.idleSessions.slice(0, m.maxVisible),
										...m.idleSessions.filter((s) => s.pinned),
									]);
									const visibleModel = {
										...m,
										orderedBlocks: m.orderedBlocks.filter(
											(block) => block.kind === "conversation" || visibleIdle.has(block.target),
										),
									};
									if (!q) return visibleModel;
									const name = rawName.toLowerCase();
									if (name.includes(q) || envInfo.label.toLowerCase().includes(q) || m.p.path.toLowerCase().includes(q))
										return visibleModel;
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
									} = m;
									const switching = transitionCwdNorm !== null && transitionCwdNorm === pNorm;
									const sbx = p.sandbox;
									const dispName = projectDisplayName(p);
									const projectEnv = sbx
										? { label: dispName, isRemote: false, envTag: undefined }
										: parseProjectEnv(p.path, dispName);
									const hasRunning = actuallyRunningCount > 0;
									const hasHistory = idleSessions.length > 0;
									const hasUnread = unreadCount > 0;

									if (!isCollapsed) {
										everExpandedRef.current.add(pNorm);
									}
									const hasPinnedHistory = idleSessions.some((s) => s.pinned);
									const shouldMountChildren =
										!isCollapsed ||
										pRunningRows.length > 0 ||
										hasUnread ||
										active ||
										// 刷新后一直是收起状态、也没展开过的项目：只要里面有钉住的行，
										// 子节点就得挂上，否则那行永远不出现（要手动展开再收才看得到）。
										hasPinnedHistory ||
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
												if (dropHint?.path !== p.path || dropHint.after !== after) setDropHint({ path: p.path, after });
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
															if (!active && loadProjectClickSwitch()) {
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
														// 目标项目直接写在 new_chat 上：服务端先切工作区、核验后再建会话（#872），
														// 不再发「set_cwd + new_chat」两条各自竞速的消息。
														panelSend({ type: "new_chat", cwd: p.path });
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
														{isCollapsed ? <LuFolder size={14} /> : <LuFolderOpen size={14} />}
													</span>
													{sbx && <LuFlaskConical className="project-icon sandbox-icon" />}
													{renaming === `proj:${p.path}` ? (
														<input
															autoFocus
															className="session-rename-input"
															value={renameDraft}
															placeholder={t("renameProjectPlaceholder")}
															onClick={(e) => e.stopPropagation()}
															onChange={(e) => setRenameDraft(e.target.value)}
															onKeyDown={(e) => {
																e.stopPropagation();
																if (e.key === "Enter" && !e.nativeEvent.isComposing) {
																	commitRename(
																		`proj:${p.path}`,
																		{ type: "rename_project", path: p.path },
																		`proj:${p.path}`,
																		p.name ?? "",
																	);
																} else if (e.key === "Escape") {
																	cancelRename();
																}
															}}
															onBlur={() =>
																commitRename(
																	`proj:${p.path}`,
																	{ type: "rename_project", path: p.path },
																	`proj:${p.path}`,
																	p.name ?? "",
																)
															}
														/>
													) : (
														<span className="lp-project-name" title={p.path}>
															{projectEnv.label}
														</span>
													)}
													<span className="lp-env-tag">{projectEnv.envTag ?? "LOCAL"}</span>
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
															{switching
																? `${transition?.progress ?? 0}%`
																: p.lastUsed > 0
																	? formatModified(p.lastUsed)
																	: ""}
														</span>
													</span>
												</button>

												<div className="lp-project-actions">
													{!sbx && confirmDel !== `proj:${p.path}` && (
														<button
															type="button"
															className="lp-project-btn lp-project-rename-btn"
															title={t("renameProject")}
															onClick={(e) => {
																e.stopPropagation();
																setConfirmDel(null);
																setRenameDraft(p.name ?? "");
																setRenaming(`proj:${p.path}`);
															}}
														>
															<FiEdit2 />
														</button>
													)}
													<button
														type="button"
														className="lp-project-btn lp-project-new-chat-btn"
														title={t("newChat")}
														onClick={(e) => {
															e.stopPropagation();
															panelSend({ type: "new_chat", cwd: p.path });
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
																markProjectRemoved(p.path);
																setRemovedProjectsVersion((v) => v + 1);
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
													{orderedBlocks.map((block) => {
														// 钉住的历史行在项目收起时仍然显示 —— 钉住就是让它常驻，
														// 否则一收起项目它就从左栏消失了，跟没钉一样。
														const pinnedVisible = isPinnedRowVisible(isCollapsed, block);
														return (
															<Fragment key={block.key}>
																{block.kind === "conversation" ? (
																	block.rows.map((row) => renderSingleConvRow(row, p.path))
																) : (
																	<div
																		className={`lp-history-collapsible${isCollapsed && !pinnedVisible ? " collapsed" : " expanded"}${pinnedVisible ? " is-pinned-visible" : ""}`}
																	>
																		<div className="lp-history-collapsible-inner">
																			{renderHistorySessionRow(block.target, p.path)}
																		</div>
																	</div>
																)}
															</Fragment>
														);
													})}

													{}
													<div className={`lp-history-collapsible${isCollapsed ? " collapsed" : " expanded"}`}>
														<div className="lp-history-collapsible-inner">
															{}
															{pRunningRows.length === 0 && idleSessions.length === 0 && !failedProjects.has(pNorm) && (
																<div className="lp-project-empty-tip">
																	{isLoadingSessions ? (
																		<span>{t("loadingSessions")}</span>
																	) : (
																		<span>{t("noSessionsYet")}</span>
																	)}
																</div>
															)}

															{}
															{failedProjects.has(pNorm) && (
																<button
																	type="button"
																	className="lp-show-more-row lp-retry-chip"
																	disabled={!ready || status !== "open"}
																	onClick={() =>
																		requestSessions({
																			type: "list_sessions",
																			path: p.path,
																			limit: serverListLimit(p.path),
																		})
																	}
																>
																	{t("sessionsLoadFailed")}
																</button>
															)}
															{hasMore && (
																<button
																	type="button"
																	className="lp-show-more-row"
																	data-lp-nav=""
																	disabled={loadingMore.has(pNorm)}
																	onClick={(e) => {
																		e.stopPropagation();
																		const nextVisible = maxVisible + SESSION_ROWS_STEP;
																		setProjectVisibleCounts((prev) => ({
																			...prev,
																			[pNorm]: nextVisible,
																		}));
																		if (serverHasMore && nextVisible >= idleSessions.length) {
																			// 多要一页当本地余量；服务端按这个数决定解析多少个文件
																			const limit = Math.max(SESSION_LIST_FIRST_PAGE, nextVisible + SESSION_ROWS_STEP);
																			requestSessions({ type: "list_sessions", path: p.path, limit });
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
					)}
				</div>
				<AgentBotsSection
					active={active}
					activeBotId={activeBotId}
					cwd={cwd}
					botDraftPrompt={botDraftPrompt}
					botDraftDefaultPrompt={botDraftDefaultPrompt}
				/>
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
		// 群组块默认住在「项目」分区里；只有项目分区被隐藏时，它才单独成一个可拖动分区。
		if (key === "groups") {
			return (
				<DeviceGroupSection
					entry={uiSections?.find((entry) => entry.id === "host:lp-groups")}
					active={active}
					selectedRoomId={activeGroupId}
					flex={effFlex("groups")}
					onCollapsedChange={setCollapseGroups}
				/>
			);
		}
		return key === "projects" || key === "convs" || key === "sessions" ? sectionNodes[key] : renderPluginSection(key);
	};

	return (
		<aside ref={panelRef as React.RefObject<HTMLDivElement>} className="panel panel-left lp-panel">
			{effectivePlan.map(({ key }) => (
				<Fragment key={key}>
					{renderSection(key)}
					{sashAfter.get(key) ?? null}
				</Fragment>
			))}
			<ProjectPicker
				open={projectPickerOpen}
				initialTab={projectPickerInitialTab}
				currentCwd={currentCwd}
				pathCompletions={pathCompletions ?? []}
				workspaceRoots={workspaceRoots}
				onClose={() => setProjectPickerOpen(false)}
				onSelectDirectory={(path, name) => panelSend({ type: "set_cwd", path, ...(name ? { name } : {}) })}
				onCreateProject={(path, name) =>
					panelSend({ type: "make_dir", path, setAsCwd: true, ...(name ? { name } : {}) })
				}
			/>
		</aside>
	);
});
