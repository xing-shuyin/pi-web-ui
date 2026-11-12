import type {
	UiAlign,
	UiArrangeOp,
	UiSlotCardinality,
	UiSlotSpec,
	UiContribution,
	UiItemKind,
	UiLayoutPrefs,
	UiPluginInfo,
	UiSelectOption,
	UiSlotId,
} from "./types";
import { LP_SECTION_ENTRY_ID } from "./left-sections";
import { excludeBuiltinModules } from "../../server/builtin-modules";
import { isZhLocale } from "./pick-locale";

export type {
	UiAlign,
	UiArrangeOp,
	UiSlotCardinality,
	UiSlotSpec,
	UiContribution,
	UiItemKind,
	UiLayoutPrefs,
	UiPluginInfo,
	UiSelectOption,
	UiSlotId,
};

export interface UiDiagnostic {
	level: UiDiagnosticLevel;
	pluginId?: string;
	entryId?: string;
	slot?: UiSlotId;
	message: string;
}

type UiDiagnosticLevel = "info" | "warn" | "error";

const UI_ITEM_KINDS: ReadonlySet<string> = new Set([
	"view",
	"action",
	"badge",
	"menu",
	"page",
	"organizer",
	"divider",
	"toggle",
	"input",
	"progress",
	"select",
]);

const KNOWN_WHEN_VALUES: ReadonlySet<string> = new Set([
	"disabled",
	"always",
	"never",
	"file.isDir",
	"file.isFile",
	"session.isRunning",
	"message.hasSelection",
]);

export interface BuiltinUiItem {
	id: string;
	slot: UiSlotId;
	labelKey: string;
	icon?: string;
	kind: UiItemKind;
	order?: number;
	group?: string;
	hidden?: boolean;
	align?: UiAlign;
	view?: string;
	context?: "message" | "session" | "file" | "topbar" | "toolcall";
}

const SLOT_IDS: UiSlotId[] = [
	"topbar.primary",
	"topbar.overflow",
	"notice.actions",
	"leftpanel.sections",
	"leftpanel.projects.actions",
	"leftpanel.project",
	"leftpanel.running.actions",
	"leftpanel.running",
	"leftpanel.history.actions",
	"leftpanel.history",
	"leftpanel.sessions",
	"chat.header",
	"chat.empty",
	"message.actions",
	"goalbar.actions",
	"composer.leading",
	"composer.actions",
	"rightpanel.tabs",
	"terminal.toolbar",
	"scm.toolbar",
	"bottombar",
	"file.preview.toolbar",
	"contextmenu.topbar",
	"contextmenu.message",
	"contextmenu.session",
	"contextmenu.project",
	"contextmenu.file",
	"contextmenu.toolcall",
	"tool.card.footer",
	"settings.pages",
	"tasks.panel",
	"modal.dialog",
	"sidebar.left",
	"sidebar.right",
	"device.group.header",
	"device.group.actions",
	"device.group.workspace",
];

export const UI_SLOT_SPECS: readonly UiSlotSpec[] = SLOT_IDS.map((slot) => ({
	slot,
	cardinality: "list" as const,
}));

function uiSlotCardinality(slot: UiSlotId): UiSlotCardinality {
	return UI_SLOT_SPECS.find((spec) => spec.slot === slot)?.cardinality ?? "list";
}

export function applyUiSlotCardinality<T extends { id: string; hidden: boolean }>(
	entries: readonly T[],
	cardinality: UiSlotCardinality,
): { entries: T[]; winner?: T; conflicts: T[] } {
	if (cardinality === "list") return { entries: [...entries], conflicts: [] };
	const winnerIndex = entries.findIndex((entry) => !entry.hidden);
	if (winnerIndex < 0) return { entries: [...entries], conflicts: [] };
	const conflicts = entries.filter((entry, index) => index !== winnerIndex && !entry.hidden);
	const resolved = entries.map((entry, index) =>
		index === winnerIndex || entry.hidden ? entry : { ...entry, hidden: true },
	);
	return { entries: resolved, winner: entries[winnerIndex], conflicts };
}

export const BUILTIN_UI_ITEMS: BuiltinUiItem[] = [
	{
		id: "host:lp-projects",
		slot: "leftpanel.sections",
		labelKey: "recentProjects",
		icon: "folder",
		kind: "action",
		order: 10,
	},
	{
		id: "host:lp-groups",
		slot: "leftpanel.sections",
		labelKey: "leftPanelGroups",
		icon: "users",
		kind: "action",
		order: 15,
	},
	{
		id: "host:lp-running",
		slot: "leftpanel.sections",
		labelKey: "runningConversations",
		icon: "activity",
		kind: "action",
		order: 20,
	},
	{
		id: "host:lp-history",
		slot: "leftpanel.sections",
		labelKey: "historySessions",
		icon: "clock",
		kind: "action",
		order: 30,
	},

	{
		id: "host:brand",
		slot: "topbar.primary",
		labelKey: "brand",
		kind: "badge",
		order: 1,
		group: "brand",
	},
	{
		id: "host:open-project",
		slot: "topbar.primary",
		labelKey: "openProject",
		icon: "folder",
		kind: "action",
		order: 3,
		group: "primary",
	},
	{
		id: "host:worktrees",
		slot: "topbar.primary",
		labelKey: "worktreeViewTitle",
		icon: "folders",
		kind: "action",
		order: 4,
		group: "primary",
	},
	{
		id: "host:history",
		slot: "topbar.primary",
		labelKey: "openHistory",
		icon: "menu",
		kind: "action",
		order: 0,
		group: "panels",
	},

	{
		id: "host:files",
		slot: "topbar.primary",
		labelKey: "openFiles",
		icon: "folder",
		kind: "action",
		order: 97,
		group: "panels",
		align: "end",
	},
	{
		id: "host:new-chat",
		slot: "topbar.primary",
		labelKey: "newChat",
		icon: "plus",
		kind: "action",
		order: 96,
		group: "primary",
		align: "end",
	},
	{
		id: "host:new-ephemeral-chat",
		slot: "topbar.primary",
		labelKey: "newChatEphemeral",
		icon: "chat",
		kind: "action",
		order: 96.5,
		group: "primary",
		align: "end",
	},
	{
		id: "host:new-sandbox",
		slot: "topbar.primary",
		labelKey: "newSandbox",
		icon: "sandbox",
		kind: "action",
		order: 96.6,
		group: "primary",
		align: "end",
	},
	{
		id: "host:chat",
		slot: "topbar.primary",
		labelKey: "chat",
		icon: "chat",
		kind: "view",
		view: "chat",
		order: 20,
		group: "views",
		align: "end",
	},
	{
		id: "host:terminal",
		slot: "topbar.primary",
		labelKey: "terminal",
		icon: "terminal",
		kind: "view",
		view: "terminal",
		order: 21,
		group: "views",
		align: "end",
	},
	{
		id: "host:git",
		slot: "topbar.primary",
		labelKey: "scmTab",
		icon: "git",
		kind: "view",
		view: "git",
		order: 22,
		group: "views",
		align: "end",
	},
	{
		id: "host:canvas",
		slot: "topbar.primary",
		labelKey: "canvasTab",
		icon: "share",
		kind: "view",
		view: "canvas",
		order: 22.5,
		group: "views",
		align: "end",
	},
	{
		id: "host:plugins",
		slot: "topbar.primary",
		labelKey: "pluginMenuTitle",
		icon: "🧩",
		kind: "action",
		order: 24,
		group: "views",
		align: "end",
	},
	{
		id: "host:search",
		slot: "topbar.primary",
		labelKey: "searchGlobal",
		icon: "search",
		kind: "action",
		order: 40,
		group: "tools",
		align: "end",
	},
	{
		id: "host:browser",
		slot: "topbar.primary",
		labelKey: "browserControl",
		icon: "browser",
		kind: "action",
		order: 41,
		group: "tools",
		align: "end",
		hidden: true,
	},
	{
		id: "host:tasks",
		slot: "topbar.primary",
		labelKey: "bgTasks",
		icon: "layers",
		kind: "action",
		order: 42,
		group: "tools",
		align: "end",
	},
	{
		id: "host:zen-mode",
		slot: "topbar.primary",
		labelKey: "zenMode",
		icon: "feather",
		kind: "action",
		order: 43,
		group: "tools",
		align: "end",
	},
	{
		id: "host:device-center",
		slot: "topbar.primary",
		labelKey: "deviceCenter",
		icon: "globe",
		kind: "view",
		view: "devices",
		order: 59,
		group: "system",
		align: "end",
	},
	{
		id: "host:settings",
		slot: "topbar.primary",
		labelKey: "settingsTitle",
		icon: "settings",
		kind: "action",
		order: 60,
		group: "system",
		align: "end",
	},
	{
		id: "host:language",
		slot: "topbar.primary",
		labelKey: "language",
		icon: "globe",
		kind: "action",
		order: 80,
		group: "system",
		hidden: true,
		align: "end",
	},
	{
		id: "host:theme",
		slot: "topbar.primary",
		labelKey: "theme",
		icon: "sun",
		kind: "action",
		order: 82,
		group: "system",
		hidden: true,
		align: "end",
	},
	{
		id: "host:update",
		slot: "topbar.primary",
		labelKey: "update",
		icon: "download",
		kind: "action",
		order: 90,
		group: "system",
		align: "end",
		hidden: true,
	},
	{
		id: "host:github",
		slot: "topbar.primary",
		labelKey: "githubRepo",
		icon: "github",
		kind: "action",
		order: 200,
		group: "system",
		align: "end",
		hidden: true,
	},

	{ id: "host:conn", slot: "bottombar", labelKey: "connected", icon: "dot", kind: "badge", order: 5, group: "status" },
	{
		id: "host:engine",
		slot: "bottombar",
		labelKey: "engineBadge",
		icon: "aperture",
		kind: "action",
		order: 6,
		group: "status",
	},
	{ id: "host:ctx", slot: "bottombar", labelKey: "context", icon: "gauge", kind: "badge", order: 10, group: "usage" },
	{
		id: "host:cost",
		slot: "bottombar",
		labelKey: "cumulativeCost",
		icon: "coins",
		kind: "badge",
		order: 11,
		group: "usage",
	},
	{
		id: "host:cache",
		slot: "bottombar",
		labelKey: "cacheHit",
		icon: "database",
		kind: "badge",
		order: 12,
		group: "usage",
	},
	{
		id: "host:msg-count",
		slot: "bottombar",
		labelKey: "messages",
		icon: "message",
		kind: "badge",
		order: 13,
		group: "usage",
	},
	{
		id: "host:plugin-status",
		slot: "bottombar",
		labelKey: "pluginStatus",
		icon: "activity",
		kind: "badge",
		order: 14,
		group: "status",
	},
	{
		id: "host:working",
		slot: "bottombar",
		labelKey: "working",
		icon: "activity",
		kind: "badge",
		order: 15,
		group: "status",
	},
	{
		id: "host:status-delegate",
		slot: "bottombar",
		labelKey: "delegateModeBadge",
		icon: "eye",
		kind: "badge",
		order: 16,
		group: "status",
	},
	{
		id: "host:host-metrics",
		slot: "bottombar",
		labelKey: "hostResources",
		icon: "cpu",
		kind: "badge",
		order: 19,
		group: "host",
		align: "end",
	},
	{
		id: "host:cwd",
		slot: "bottombar",
		labelKey: "cwdTip",
		icon: "folder",
		kind: "action",
		order: 20,
		group: "context",
		align: "end",
	},

	{
		id: "host:msg-reask",
		slot: "message.actions",
		labelKey: "reaskDirectly",
		icon: "refresh",
		kind: "action",
		order: 9,
	},
	{
		id: "host:msg-edit-reask",
		slot: "message.actions",
		labelKey: "editReask",
		icon: "edit",
		kind: "action",
		order: 10,
	},
	{
		id: "host:msg-fork",
		slot: "message.actions",
		labelKey: "forkSession",
		icon: "branch",
		kind: "action",
		order: 15,
	},
	{
		id: "host:msg-rollback",
		slot: "message.actions",
		labelKey: "rollbackSession",
		icon: "undo",
		kind: "action",
		order: 16,
	},
	{ id: "host:msg-copy", slot: "message.actions", labelKey: "copyMessage", icon: "copy", kind: "action", order: 20 },
	{ id: "host:msg-copy-text", slot: "message.actions", labelKey: "copyText", icon: "text", kind: "action", order: 21 },
	{
		id: "host:msg-copy-markdown",
		slot: "message.actions",
		labelKey: "copyMarkdown",
		icon: "markdown",
		kind: "action",
		order: 22,
	},
	{
		id: "host:msg-copy-image",
		slot: "message.actions",
		labelKey: "copyImage",
		icon: "image",
		kind: "action",
		order: 23,
	},
	{
		id: "host:msg-speak",
		slot: "message.actions",
		labelKey: "speakMsg",
		icon: "volume",
		kind: "action",
		order: 24,
	},

	{
		id: "host:msg-delete",
		slot: "message.actions",
		labelKey: "delete",
		icon: "trash",
		kind: "action",
		order: 30,
		hidden: true,
	},

	{
		id: "host:composer-upload",
		slot: "composer.actions",
		labelKey: "uploadFile",
		icon: "upload",
		kind: "action",
		order: 10,
		align: "start",
	},
	{
		id: "host:composer-screenshot",
		slot: "composer.actions",
		labelKey: "screenshotCapture",
		icon: "cut",
		kind: "action",
		// 排在附件与模板之后，输入框工具栏左侧第三个位。
		order: 115,
		align: "start",
	},
	{
		id: "host:composer-templates",
		slot: "composer.actions",
		labelKey: "tpl.openPicker",
		icon: "grid",
		kind: "action",
		order: 110,
		align: "start",
	},
	{
		id: "host:composer-model",
		slot: "composer.actions",
		labelKey: "selectModel",
		icon: "cpu",
		kind: "action",
		order: 120,
		align: "start",
	},
	{
		id: "host:composer-thinking",
		slot: "composer.actions",
		labelKey: "thinkingLevel",
		icon: "zap",
		kind: "action",
		order: 130,
		align: "start",
	},
	{
		id: "host:composer-dsh-perm",
		slot: "composer.actions",
		labelKey: "dshPerm",
		icon: "lock",
		kind: "action",
		order: 140,
		align: "start",
	},
	{
		id: "host:composer-dsh-preset",
		slot: "composer.actions",
		labelKey: "dshPreset",
		icon: "layers",
		kind: "action",
		order: 150,
		align: "start",
	},
	{
		id: "host:composer-send",
		slot: "composer.actions",
		labelKey: "sendTip",
		icon: "send",
		kind: "action",
		order: 200,
		align: "end",
	},

	{
		id: "host:fp-md",
		slot: "file.preview.toolbar",
		labelKey: "showMarkdownPreview",
		icon: "eye",
		kind: "action",
		order: 10,
	},
	{
		id: "host:fp-toc",
		slot: "file.preview.toolbar",
		labelKey: "previewTocLabel",
		icon: "list",
		kind: "action",
		order: 15,
	},
	{
		id: "host:fp-html",
		slot: "file.preview.toolbar",
		labelKey: "showHtmlPreview",
		icon: "code",
		kind: "action",
		order: 20,
	},
	{
		id: "host:fp-external",
		slot: "file.preview.toolbar",
		labelKey: "openInNewTab",
		icon: "open",
		kind: "action",
		order: 25,
	},
	{ id: "host:fp-edit", slot: "file.preview.toolbar", labelKey: "editFile", icon: "edit", kind: "action", order: 30 },
	{ id: "host:fp-wrap", slot: "file.preview.toolbar", labelKey: "enableWrap", icon: "wrap", kind: "action", order: 40 },
	{ id: "host:fp-zoom", slot: "file.preview.toolbar", labelKey: "zoomIn", icon: "zoom", kind: "action", order: 50 },
	{
		id: "host:fp-download",
		slot: "file.preview.toolbar",
		labelKey: "downloadFile",
		icon: "download",
		kind: "action",
		order: 60,
	},
	{
		id: "host:fp-ref",
		slot: "file.preview.toolbar",
		labelKey: "referenceTip",
		icon: "link",
		kind: "action",
		order: 70,
	},
	{
		id: "host:fp-full",
		slot: "file.preview.toolbar",
		labelKey: "fullscreen",
		icon: "maximize",
		kind: "action",
		order: 80,
	},
	{ id: "host:fp-close", slot: "file.preview.toolbar", labelKey: "close", icon: "x", kind: "action", order: 90 },

	{ id: "host:goal-pill", slot: "goalbar.actions", labelKey: "goalBarTitle", icon: "target", kind: "action", order: 5 },
	{ id: "host:goal-set", slot: "goalbar.actions", labelKey: "goalBarSet", icon: "check", kind: "action", order: 10 },
	{
		id: "host:goal-wizard",
		slot: "goalbar.actions",
		labelKey: "goalWizardBtn",
		icon: "search",
		kind: "action",
		order: 20,
	},
	{ id: "host:goal-lock", slot: "goalbar.actions", labelKey: "goalBarLocked", icon: "lock", kind: "action", order: 30 },
	{ id: "host:goal-plan", slot: "goalbar.actions", labelKey: "planMode", icon: "list", kind: "action", order: 25 },
	{
		id: "host:goal-collapse",
		slot: "goalbar.actions",
		labelKey: "collapsePanel",
		icon: "chevron-up",
		kind: "action",
		order: 40,
	},
	{
		id: "host:goal-model",
		slot: "goalbar.actions",
		labelKey: "goalBarReviewModel",
		icon: "cpu",
		kind: "action",
		order: 50,
	},
	{
		id: "host:goal-rounds",
		slot: "goalbar.actions",
		labelKey: "goalBarMaxRounds",
		icon: "hash",
		kind: "action",
		order: 60,
	},
	{
		id: "host:goal-execmodel",
		slot: "goalbar.actions",
		labelKey: "goalBarExecModel",
		icon: "cpu",
		kind: "action",
		order: 55,
	},
	{
		id: "host:goal-openrole",
		slot: "goalbar.actions",
		labelKey: "goalBarOpenExec",
		icon: "search",
		kind: "action",
		order: 65,
	},
	{ id: "host:goal-clear", slot: "goalbar.actions", labelKey: "goalBarClear", icon: "x", kind: "action", order: 70 },

	{ id: "host:scm-changes", slot: "scm.toolbar", labelKey: "scmChanges", icon: "file", kind: "action", order: 10 },
	{ id: "host:scm-history", slot: "scm.toolbar", labelKey: "scmHistory", icon: "clock", kind: "action", order: 20 },
	{
		id: "host:scm-refresh",
		slot: "scm.toolbar",
		labelKey: "scmRefreshTip",
		icon: "refresh",
		kind: "action",
		order: 30,
	},
	{ id: "host:scm-branch", slot: "scm.toolbar", labelKey: "scmSwitchBranch", icon: "git", kind: "action", order: 40 },
	{ id: "host:scm-switch", slot: "scm.toolbar", labelKey: "scmSwitch", icon: "git", kind: "action", order: 50 },
	{ id: "host:scm-push", slot: "scm.toolbar", labelKey: "scmPush", icon: "upload", kind: "action", order: 60 },
	{ id: "host:scm-pull", slot: "scm.toolbar", labelKey: "scmPull", icon: "download", kind: "action", order: 70 },
	{
		id: "host:scm-input",
		slot: "scm.toolbar",
		labelKey: "scmCommitPlaceholder",
		icon: "edit",
		kind: "action",
		order: 80,
	},
	{ id: "host:scm-genmsg", slot: "scm.toolbar", labelKey: "scmGenMsg", icon: "cpu", kind: "action", order: 85 },
	{ id: "host:scm-commit", slot: "scm.toolbar", labelKey: "scmCommit", icon: "check", kind: "action", order: 90 },
	{
		id: "host:scm-commit-all",
		slot: "scm.toolbar",
		labelKey: "scmCommitAll",
		icon: "check",
		kind: "action",
		order: 100,
	},
	{ id: "host:scm-term", slot: "scm.toolbar", labelKey: "terminal", icon: "terminal", kind: "action", order: 110 },

	{
		id: "host:term-cmd-refresh",
		slot: "terminal.toolbar",
		labelKey: "rerun",
		icon: "refresh",
		kind: "action",
		order: 10,
	},
	{
		id: "host:term-cmd-new",
		slot: "terminal.toolbar",
		labelKey: "newCommand",
		icon: "plus",
		kind: "action",
		order: 20,
	},
	{
		id: "host:term-tab-new",
		slot: "terminal.toolbar",
		labelKey: "newTerminal",
		icon: "plus",
		kind: "action",
		order: 30,
	},

	{
		id: "host:right-files",
		slot: "rightpanel.tabs",
		labelKey: "openFiles",
		icon: "folder",
		kind: "view",
		view: "files",
		order: 10,
	},

	{
		id: "host:conv-rename",
		slot: "contextmenu.session",
		labelKey: "renameSession",
		icon: "edit",
		kind: "action",
		context: "session",
		order: 1,
	},
	{
		id: "host:conv-pin",
		slot: "contextmenu.session",
		labelKey: "pinConversation",
		icon: "pin",
		kind: "action",
		context: "session",
		order: 2,
	},
	{
		id: "host:conv-takeover",
		slot: "contextmenu.session",
		labelKey: "takeoverConversation",
		icon: "chat",
		kind: "action",
		context: "session",
		order: 5,
	},
	{
		id: "host:conv-dismiss-subagents",
		slot: "contextmenu.session",
		labelKey: "dismissFinishedSubagents",
		icon: "x",
		kind: "action",
		context: "session",
		order: 10,
	},
	{
		id: "host:conv-force-dismiss",
		slot: "contextmenu.session",
		labelKey: "forceDismissConversation",
		icon: "x",
		kind: "action",
		context: "session",
		order: 20,
	},
	{
		id: "host:conv-persist",
		slot: "contextmenu.session",
		labelKey: "persistSubagent",
		icon: "save",
		kind: "action",
		context: "session",
		order: 25,
	},
	{
		id: "host:conv-copy-id",
		slot: "contextmenu.session",
		labelKey: "copyConversationId",
		icon: "copy",
		kind: "action",
		context: "session",
		order: 30,
	},
	{
		id: "host:conv-copy-path",
		slot: "contextmenu.session",
		labelKey: "copyConversationPath",
		icon: "copy",
		kind: "action",
		context: "session",
		order: 40,
	},
	{
		id: "host:conv-copy-link",
		slot: "contextmenu.session",
		labelKey: "copyConversationLink",
		icon: "link",
		kind: "action",
		context: "session",
		order: 45,
	},
	{
		id: "host:conv-quote",
		slot: "contextmenu.session",
		labelKey: "quoteConversation",
		icon: "chat",
		kind: "action",
		context: "session",
		order: 50,
	},

	{
		id: "host:conv-quick-ask",
		slot: "contextmenu.session",
		labelKey: "quickAskReference",
		icon: "chat",
		kind: "action",
		context: "session",
		order: 55,
	},

	{
		id: "host:file-open",
		slot: "contextmenu.file",
		labelKey: "fileOpenPreview",
		icon: "open",
		kind: "action",
		context: "file",
		order: 11,
		group: "open",
	},
	{
		id: "host:file-enter",
		slot: "contextmenu.file",
		labelKey: "fileEnterDir",
		icon: "folder",
		kind: "action",
		context: "file",
		order: 12,
		group: "open",
	},
	{
		id: "host:file-download",
		slot: "contextmenu.file",
		labelKey: "downloadFile",
		icon: "download",
		kind: "action",
		context: "file",
		order: 13,
		group: "open",
	},
	{
		id: "host:file-compress",
		slot: "contextmenu.file",
		labelKey: "fileCompress",
		icon: "file",
		kind: "action",
		context: "file",
		order: 16,
		group: "archive",
	},
	{
		id: "host:file-extract",
		slot: "contextmenu.file",
		labelKey: "fileExtract",
		icon: "folder",
		kind: "action",
		context: "file",
		order: 17,
		group: "archive",
	},
	{
		id: "host:file-compress-download",
		slot: "contextmenu.file",
		labelKey: "fileCompressDownload",
		icon: "download",
		kind: "action",
		context: "file",
		order: 18,
		group: "archive",
	},
	{
		id: "host:file-upload-folder",
		slot: "contextmenu.file",
		labelKey: "fileUploadFolder",
		icon: "upload",
		kind: "action",
		context: "file",
		order: 25,
		group: "new",
	},
	{
		id: "host:file-open-project",
		slot: "contextmenu.file",
		labelKey: "openAsProject",
		icon: "folder",
		kind: "action",
		context: "file",
		order: 14,
		group: "open",
	},
	{
		id: "host:file-add-root",
		slot: "contextmenu.file",
		labelKey: "addWorkspaceRoot",
		icon: "folder",
		kind: "action",
		context: "file",
		order: 15,
		group: "open",
	},
	{
		id: "host:file-reveal",
		slot: "contextmenu.file",
		labelKey: "fileReveal",
		icon: "folder",
		kind: "action",
		context: "file",
		order: 16,
		group: "open",
	},
	{
		id: "host:file-open-default",
		slot: "contextmenu.file",
		labelKey: "fileOpenDefault",
		icon: "open",
		kind: "action",
		context: "file",
		order: 17,
		group: "open",
	},
	{
		id: "host:file-new-file",
		slot: "contextmenu.file",
		labelKey: "fileNewFile",
		icon: "file",
		kind: "action",
		context: "file",
		order: 21,
		group: "new",
	},
	{
		id: "host:file-new-dir",
		slot: "contextmenu.file",
		labelKey: "fileNewDir",
		icon: "folder",
		kind: "action",
		context: "file",
		order: 22,
		group: "new",
	},
	{
		id: "host:file-upload",
		slot: "contextmenu.file",
		labelKey: "uploadToFolder",
		icon: "upload",
		kind: "action",
		context: "file",
		order: 23,
		group: "new",
	},
	{
		id: "host:file-paste",
		slot: "contextmenu.file",
		labelKey: "filePaste",
		icon: "paste",
		kind: "action",
		context: "file",
		order: 24,
		group: "new",
	},
	{
		id: "host:file-attach-ref",
		slot: "contextmenu.file",
		labelKey: "referenceTip",
		icon: "link",
		kind: "action",
		context: "file",
		order: 32,
		group: "chat",
	},
	{
		id: "host:file-attach-folder",
		slot: "contextmenu.file",
		labelKey: "linkFolderTip",
		icon: "link",
		kind: "action",
		context: "file",
		order: 33,
		group: "chat",
	},
	{
		id: "host:file-quick-ask",
		slot: "contextmenu.file",
		labelKey: "quickAskReference",
		icon: "chat",
		kind: "action",
		context: "file",
		order: 34,
		group: "chat",
	},
	{
		id: "host:file-rename",
		slot: "contextmenu.file",
		labelKey: "fileRename",
		icon: "edit",
		kind: "action",
		context: "file",
		order: 41,
		group: "edit",
	},
	{
		id: "host:file-duplicate",
		slot: "contextmenu.file",
		labelKey: "fileDuplicate",
		icon: "copy",
		kind: "action",
		context: "file",
		order: 42,
		group: "edit",
	},
	{
		id: "host:file-cut",
		slot: "contextmenu.file",
		labelKey: "fileCut",
		icon: "cut",
		kind: "action",
		context: "file",
		order: 43,
		group: "edit",
	},
	{
		id: "host:file-copy",
		slot: "contextmenu.file",
		labelKey: "fileCopyEntry",
		icon: "copy",
		kind: "action",
		context: "file",
		order: 44,
		group: "edit",
	},
	{
		id: "host:file-copy-name",
		slot: "contextmenu.file",
		labelKey: "copyName",
		icon: "copy",
		kind: "action",
		context: "file",
		order: 51,
		group: "clipboard",
	},
	{
		id: "host:file-copy-path",
		slot: "contextmenu.file",
		labelKey: "copyPath",
		icon: "copy",
		kind: "action",
		context: "file",
		order: 52,
		group: "clipboard",
	},
	{
		id: "host:file-copy-rel",
		slot: "contextmenu.file",
		labelKey: "fileCopyRelPath",
		icon: "copy",
		kind: "action",
		context: "file",
		order: 53,
		group: "clipboard",
	},
	{
		id: "host:file-refresh",
		slot: "contextmenu.file",
		labelKey: "fileRefresh",
		icon: "refresh",
		kind: "action",
		context: "file",
		order: 54,
		group: "clipboard",
	},
	{
		id: "host:file-delete",
		slot: "contextmenu.file",
		labelKey: "fileDelete",
		icon: "trash",
		kind: "action",
		context: "file",
		order: 61,
		group: "danger",
	},

	{
		id: "host:msg-ctx-copy-markdown",
		slot: "contextmenu.message",
		labelKey: "copyMarkdown",
		icon: "markdown",
		kind: "action",
		context: "message",
		order: 10,
		group: "copy",
	},
	{
		id: "host:msg-ctx-copy-text",
		slot: "contextmenu.message",
		labelKey: "copyText",
		icon: "text",
		kind: "action",
		context: "message",
		order: 11,
		group: "copy",
	},
	{
		id: "host:msg-ctx-copy-image",
		slot: "contextmenu.message",
		labelKey: "copyImage",
		icon: "image",
		kind: "action",
		context: "message",
		order: 12,
		group: "copy",
	},
	{
		id: "host:msg-ctx-copy-link",
		slot: "contextmenu.message",
		labelKey: "copyMessageLink",
		icon: "link",
		kind: "action",
		context: "message",
		order: 13,
		group: "copy",
	},
	{
		id: "host:msg-ctx-reask",
		slot: "contextmenu.message",
		labelKey: "reaskDirectly",
		icon: "refresh",
		kind: "action",
		context: "message",
		order: 19,
		group: "action",
	},
	{
		id: "host:msg-ctx-edit-reask",
		slot: "contextmenu.message",
		labelKey: "editReask",
		icon: "edit",
		kind: "action",
		context: "message",
		order: 20,
		group: "action",
	},
	{
		id: "host:msg-ctx-fork",
		slot: "contextmenu.message",
		labelKey: "forkSession",
		icon: "branch",
		kind: "action",
		context: "message",
		order: 21,
		group: "action",
	},
	{
		id: "host:msg-ctx-rollback",
		slot: "contextmenu.message",
		labelKey: "rollbackSession",
		icon: "undo",
		kind: "action",
		context: "message",
		order: 22,
		group: "action",
	},
	{
		id: "host:msg-ctx-speak",
		slot: "contextmenu.message",
		labelKey: "speakMsg",
		icon: "volume",
		kind: "action",
		context: "message",
		order: 23,
		group: "action",
	},

	{
		id: "host:msg-ctx-delete",
		slot: "contextmenu.message",
		labelKey: "delete",
		icon: "trash",
		kind: "action",
		context: "message",
		order: 30,
		group: "danger",
	},

	{
		id: "host:tool-info",
		slot: "contextmenu.toolcall",
		labelKey: "toolInfoMenuLabel",
		icon: "info",
		kind: "action",
		context: "toolcall",
		order: 10,
	},
];

export const PLUGIN_VIEW_ITEM_ID = "__view";

export const REQUIRED_TOPBAR_ITEM_IDS: ReadonlySet<string> = new Set(["host:settings", "host:history", "host:files"]);

export const HIDDEN_FROM_LAYOUT_ITEM_IDS: ReadonlySet<string> = new Set([
	"host:history",
	"host:files",
	// 左栏「运行的对话 / 历史」两个分区自左栏改版后已并入「最近项目」树（LeftPanel 的 sectionNodes
	// 里 convs / sessions 恒为 null），布局页再给它们开关只会让用户以为能控制，故不再展示。
	"host:lp-running",
	"host:lp-history",
]);

export function pluginViewItemId(pluginId: string): string {
	return `${pluginId}:${PLUGIN_VIEW_ITEM_ID}`;
}

export function isPluginViewItem(entry: { id: string; source: string }): boolean {
	if (!entry.source.startsWith("plugin:")) return false;
	return entry.id === pluginViewItemId(entry.source.slice("plugin:".length));
}

export function setPluginViewPinned(
	layout: UiLayoutPrefs | undefined,
	pluginId: string,
	pinned: boolean,
): UiLayoutPrefs {
	const id = pluginViewItemId(pluginId);
	const hidden = (layout?.hidden ?? []).filter((x) => x !== id);
	const shown = (layout?.shown ?? []).filter((x) => x !== id);
	if (pinned) shown.push(id);
	else hidden.push(id);
	return { ...layout, hidden, shown };
}

export function setPluginViewOrder(layout: UiLayoutPrefs | undefined, pluginIds: readonly string[]): UiLayoutPrefs {
	const pluginItemIds = pluginIds.map(pluginViewItemId);
	const pluginSet = new Set(pluginItemIds);
	const order = (layout?.order ?? []).filter((id) => !pluginSet.has(id));
	return { ...layout, order: [...order, ...pluginItemIds] };
}

const SCREENSHOT_ITEM_ID = "host:composer-screenshot";

/**
 * 早期布局快照里没有截图按钮，未登记进 `order` 的条目会排在所有已排序条目之后。
 * 把截图按钮锚定在模板（无模板时锚定附件）之后，老用户也能直接拿到左侧第三个位。
 */
function migrateScreenshotOrder<T extends UiLayoutPrefs>(src: T): T {
	const order = src.order ?? [];
	if (order.length === 0 || order.includes(SCREENSHOT_ITEM_ID)) return src;
	const anchor = ["host:composer-templates", "host:composer-upload"]
		.map((id) => order.indexOf(id))
		.find((index) => index >= 0);
	if (anchor === undefined) return src;
	const next = [...order];
	next.splice(anchor + 1, 0, SCREENSHOT_ITEM_ID);
	return { ...src, order: next };
}

const BRAND_ITEM_ID = "host:brand";
const BRAND_OLD_IDS: readonly string[] = ["host:brand-logo", "host:brand-name"];

function migrateBrandLayout<T extends UiLayoutPrefs>(src: T): T {
	const hasOld =
		(src.hidden ?? []).some((id) => BRAND_OLD_IDS.includes(id)) ||
		(src.shown ?? []).some((id) => BRAND_OLD_IDS.includes(id)) ||
		(src.order ?? []).some((id) => BRAND_OLD_IDS.includes(id)) ||
		BRAND_OLD_IDS.some((id) => src.align?.[id] !== undefined) ||
		BRAND_OLD_IDS.some((id) => src.groups?.[id] !== undefined) ||
		BRAND_OLD_IDS.some((id) => src.labels?.[id] !== undefined) ||
		BRAND_OLD_IDS.some((id) => src.slots?.[id] !== undefined);
	if (!hasOld) return src;
	const mapList = (list: string[] | undefined): string[] | undefined => {
		if (!list) return undefined;
		const out: string[] = [];
		for (const id of list) {
			const mapped = BRAND_OLD_IDS.includes(id) ? BRAND_ITEM_ID : id;
			if (!out.includes(mapped)) out.push(mapped);
		}
		return out;
	};
	const foldDict = (
		dict: Record<string, string> | undefined,
		logoFirst: boolean,
	): Record<string, string> | undefined => {
		if (!dict) return undefined;
		const out: Record<string, string> = {};
		for (const [k, v] of Object.entries(dict)) {
			if (BRAND_OLD_IDS.includes(k)) continue;
			out[k] = v;
		}
		if (out[BRAND_ITEM_ID] === undefined) {
			const picked = logoFirst
				? (dict[BRAND_OLD_IDS[0]!] ?? dict[BRAND_OLD_IDS[1]!])
				: (dict[BRAND_OLD_IDS[1]!] ?? dict[BRAND_OLD_IDS[0]!]);
			if (picked !== undefined) out[BRAND_ITEM_ID] = picked;
		}
		return out;
	};
	const foldAlign = (dict: Record<string, UiAlign> | undefined): Record<string, UiAlign> | undefined => {
		if (!dict) return undefined;
		const out: Record<string, UiAlign> = {};
		for (const [k, v] of Object.entries(dict)) {
			if (BRAND_OLD_IDS.includes(k)) continue;
			out[k] = v;
		}
		if (out[BRAND_ITEM_ID] === undefined) {
			const picked = dict[BRAND_OLD_IDS[0]!] ?? dict[BRAND_OLD_IDS[1]!];
			if (picked !== undefined) out[BRAND_ITEM_ID] = picked;
		}
		return out;
	};
	const foldSlots = (dict: Record<string, UiSlotId> | undefined): Record<string, UiSlotId> | undefined => {
		if (!dict) return undefined;
		const out: Record<string, UiSlotId> = {};
		for (const [k, v] of Object.entries(dict)) {
			if (BRAND_OLD_IDS.includes(k)) continue;
			out[k] = v;
		}
		if (out[BRAND_ITEM_ID] === undefined) {
			const picked = dict[BRAND_OLD_IDS[0]!] ?? dict[BRAND_OLD_IDS[1]!];
			if (picked !== undefined) out[BRAND_ITEM_ID] = picked;
		}
		return out;
	};
	return {
		...src,
		...(src.hidden ? { hidden: mapList(src.hidden) } : {}),
		...(src.shown ? { shown: mapList(src.shown) } : {}),
		...(src.order ? { order: mapList(src.order) } : {}),
		...(src.groups ? { groups: foldDict(src.groups, true) } : {}),
		...(src.labels ? { labels: foldDict(src.labels, false) } : {}),
		...(src.align ? { align: foldAlign(src.align) } : {}),
		...(src.slots ? { slots: foldSlots(src.slots) } : {}),
	};
}

export function withPluginViewItems(plugins: UiPluginInfo[]): UiPluginInfo[] {
	return excludeBuiltinModules(plugins).map((p) => {
		if (p.view === false) return p;
		const items = p.ui?.items ?? [];
		if (items.some((it) => it.id === PLUGIN_VIEW_ITEM_ID)) return p;
		const viewItem: UiContribution = {
			id: PLUGIN_VIEW_ITEM_ID,
			slot: "topbar.primary",
			label: p.name,
			...(p.icon ? { icon: p.icon } : {}),
			...(p.iconSvg ? { iconSvg: p.iconSvg } : {}),
			kind: "view",
			view: `plugin:${p.id}`,
			order: 23,
			align: "end",
			hidden: true,
		};
		return {
			...p,
			ui: { items: [...items, viewItem], arrange: p.ui?.arrange ?? [] },
		};
	});
}

export interface UiSlotEntry {
	id: string;
	slot: UiSlotId;
	source: "host" | `plugin:${string}`;
	label: string;
	labelKey?: string;
	labelExplicit?: boolean;
	icon?: string;
	iconSvg?: string;
	hint?: string;
	kind: UiItemKind;
	action?: string;
	view?: string;
	group?: string;
	order: number;
	align: UiAlign;
	hidden: boolean;
	badge?: string;
	checked?: boolean;
	value?: string;
	progress?: number;
	options?: { value: string; label: string }[];
	when?: string[];
	children?: UiSlotEntry[];
	userOverrides: string[];
	arrangedBy: string[];
	movedFrom?: UiSlotId;
}

export function createHostSlotEntry(entry: {
	id: string;
	slot: UiSlotId;
	label: string;
	icon?: string;
	kind?: UiItemKind;
	order?: number;
	when?: string[];
}): UiSlotEntry {
	return {
		id: entry.id,
		slot: entry.slot,
		source: "host",
		label: entry.label,
		icon: entry.icon,
		kind: entry.kind ?? "action",
		order: entry.order ?? 100,
		align: "start",
		hidden: false,
		userOverrides: [],
		arrangedBy: [],
		when: entry.when,
	};
}

interface WorkingEntry extends UiSlotEntry {
	seq: number;
}

type RankMap = Map<string, number>;

function isSlotId(v: unknown): v is UiSlotId {
	return typeof v === "string" && (SLOT_IDS as string[]).includes(v);
}

function pluginLabel(item: UiContribution, zh: boolean): string {
	return zh ? item.label : (item.labelEn ?? item.label);
}

function pluginHint(item: UiContribution, zh: boolean): string | undefined {
	return zh ? (item.hint ?? item.hintEn) : (item.hintEn ?? item.hint);
}

function toChildEntry(
	parentId: string,
	slot: UiSlotId,
	source: `plugin:${string}`,
	item: UiContribution,
	zh: boolean,
): UiSlotEntry {
	const id = `${parentId}#${item.id}`;
	const children = childEntries(id, slot, source, item.children, zh);
	const hint = pluginHint(item, zh);
	const options = toSlotOptions(item.options, zh);
	const progress = clampProgress(item.progress);
	return {
		id,
		slot,
		source,
		label: pluginLabel(item, zh),
		labelExplicit: true,
		...(item.icon ? { icon: item.icon } : {}),
		...(item.iconSvg ? { iconSvg: item.iconSvg } : {}),
		...(hint ? { hint } : {}),
		kind: item.kind ?? "action",
		...(item.action ? { action: item.action } : {}),
		...(item.view ? { view: item.view } : {}),
		...(item.group ? { group: item.group } : {}),
		order: item.order ?? 100,
		align: "start",
		hidden: item.hidden ?? false,
		...(item.badge ? { badge: item.badge } : {}),
		...(typeof item.checked === "boolean" ? { checked: item.checked } : {}),
		...(typeof item.value === "string" ? { value: item.value } : {}),
		...(progress !== undefined ? { progress } : {}),
		...(item.when ? { when: item.when } : {}),
		...(options ? { options } : {}),
		...(children.length > 0 ? { children } : {}),
		userOverrides: [],
		arrangedBy: [],
	};
}

function childEntries(
	parentId: string,
	slot: UiSlotId,
	source: `plugin:${string}`,
	children: UiContribution[] | undefined,
	zh: boolean,
): UiSlotEntry[] {
	if (!children?.length) return [];
	return children
		.map((child, index) => ({ entry: toChildEntry(parentId, slot, source, child, zh), index }))
		.sort((a, b) => (a.entry.order === b.entry.order ? a.index - b.index : a.entry.order - b.entry.order))
		.map((x) => x.entry);
}

function toSlotOptions(
	options: UiSelectOption[] | undefined,
	zh: boolean,
): { value: string; label: string }[] | undefined {
	if (!options?.length) return undefined;
	return options.slice(0, 32).map((o) => ({
		value: o.value,
		label: zh ? (o.label ?? o.labelEn ?? o.value) : (o.labelEn ?? o.label ?? o.value),
	}));
}
function clampProgress(v: unknown): number | undefined {
	if (v === undefined) return undefined;
	const n = Number(v);
	if (!Number.isFinite(n)) return 0;
	return Math.min(100, Math.max(0, n));
}

function toWorkingEntry(
	id: string,
	slot: UiSlotId,
	source: `plugin:${string}`,
	item: UiContribution,
	zh: boolean,
	seq: number,
): WorkingEntry {
	const children = childEntries(id, slot, source, item.children, zh);
	const hint = pluginHint(item, zh);
	const progress = clampProgress(item.progress);
	const options = toSlotOptions(item.options, zh);
	return {
		id,
		slot,
		source,
		label: pluginLabel(item, zh),
		labelExplicit: true,
		...(item.icon ? { icon: item.icon } : {}),
		...(item.iconSvg ? { iconSvg: item.iconSvg } : {}),
		...(hint ? { hint } : {}),
		kind: item.kind ?? (slot === "settings.pages" ? "page" : "action"),
		...(item.action ? { action: item.action } : {}),
		...(item.view ? { view: item.view } : {}),
		...(item.group ? { group: item.group } : {}),
		order: item.order ?? 100,
		align: item.align ?? "start",
		hidden: item.hidden ?? false,
		...(item.badge ? { badge: item.badge } : {}),
		...(typeof item.checked === "boolean" ? { checked: item.checked } : {}),
		...(typeof item.value === "string" ? { value: item.value } : {}),
		...(progress !== undefined ? { progress } : {}),
		...(options ? { options } : {}),
		...(item.when ? { when: item.when } : {}),
		...(children.length > 0 ? { children } : {}),
		userOverrides: [],
		arrangedBy: [],
		seq,
	};
}

function sortEntries(entries: WorkingEntry[], rank: RankMap): WorkingEntry[] {
	return [...entries].sort((a, b) => {
		const ra = rank.get(a.id);
		const rb = rank.get(b.id);
		if (ra !== undefined || rb !== undefined) {
			if (ra !== undefined && rb !== undefined) return ra - rb;
			return ra !== undefined ? -1 : 1;
		}
		if (a.order !== b.order) return a.order - b.order;
		return a.seq - b.seq;
	});
}

function placeTopbarPluginViews(entries: WorkingEntry[], rank: RankMap): WorkingEntry[] {
	const unrankedViews = entries.filter((entry) => isPluginViewItem(entry) && !rank.has(entry.id));
	if (unrankedViews.length === 0) return entries;
	const rest = entries.filter((entry) => !isPluginViewItem(entry) || rank.has(entry.id));
	const anchor =
		["host:git", "host:terminal", "host:chat"]
			.map((id) => rest.findIndex((entry) => entry.id === id))
			.find((index) => index >= 0) ?? -1;
	const panel = rest.findIndex((entry) => entry.id === "host:plugins");
	let insertAt = anchor + 1;
	if (panel >= insertAt) insertAt = panel;
	insertAt = Math.max(0, Math.min(insertAt, rest.length));
	return [...rest.slice(0, insertAt), ...unrankedViews, ...rest.slice(insertAt)];
}

export function buildUiSlots(
	plugins: UiPluginInfo[],
	opts: {
		locale: string;
		t: (key: string) => string;
		disabledPlugins?: string[];
		layout?: UiLayoutPrefs;
		diagnostics?: UiDiagnostic[];
	},
): Record<UiSlotId, UiSlotEntry[]> {
	const zh = isZhLocale(opts.locale);
	const disabled = new Set(opts.disabledPlugins ?? []);
	const layout = migrateScreenshotOrder(migrateBrandLayout(opts.layout ?? {}));
	const diag = (d: Omit<UiDiagnostic, "level"> & { level?: UiDiagnosticLevel }): void => {
		opts.diagnostics?.push({ level: d.level ?? "warn", ...d });
	};

	const byId = new Map<string, WorkingEntry>();
	let seq = 0;

	for (const item of BUILTIN_UI_ITEMS) {
		byId.set(item.id, {
			id: item.id,
			slot: item.slot,
			source: "host",
			label: opts.t(item.labelKey),
			labelKey: item.labelKey,
			...(item.icon ? { icon: item.icon } : {}),
			kind: item.kind,
			...(item.view ? { view: item.view } : {}),
			...(item.group ? { group: item.group } : {}),
			order: item.order ?? 100,
			align: item.align ?? "start",
			hidden: item.hidden ?? false,
			userOverrides: [],
			arrangedBy: [],
			seq: seq++,
		});
	}

	for (const plugin of plugins) {
		if (disabled.has(plugin.id)) {
			const itemCount = plugin.ui?.items?.length ?? 0;
			const arrangeCount = plugin.ui?.arrange?.length ?? 0;
			if (itemCount > 0 || arrangeCount > 0) {
				diag({
					level: "info",
					pluginId: plugin.id,
					message: `plugin "${plugin.id}" is disabled by the user — its ${itemCount} UI item(s) are not rendered`,
				});
			}
			continue;
		}
		if (plugin.error) {
			diag({
				level: "error",
				pluginId: plugin.id,
				message: `plugin "${plugin.id}" failed to activate (${plugin.error}) — its UI items are not rendered`,
			});
			continue;
		}
		const source = `plugin:${plugin.id}` as const;
		for (const item of plugin.ui?.items ?? []) {
			if (!isSlotId(item.slot)) {
				diag({
					pluginId: plugin.id,
					entryId: item.id,
					message: `item "${plugin.id}:${item.id}" declares unknown slot "${String(item.slot)}" — dropped (valid slots: see docs/architecture-plugins.md)`,
				});
				continue;
			}
			if (item.slot === "leftpanel.sections" && item.kind !== "view") {
				diag({
					pluginId: plugin.id,
					entryId: item.id,
					slot: item.slot,
					message: `item "${plugin.id}:${item.id}" targets leftpanel.sections: only kind="view" (a plugin section) is accepted — dropped`,
				});
				continue;
			}
			if (item.kind && !UI_ITEM_KINDS.has(item.kind)) {
				diag({
					pluginId: plugin.id,
					entryId: item.id,
					slot: item.slot,
					message: `item "${plugin.id}:${item.id}" declares unknown kind "${item.kind}" — the render layer falls back to a plain button`,
				});
			}
			if (Array.isArray(item.when)) {
				for (const w of item.when) {
					if (!KNOWN_WHEN_VALUES.has(w))
						diag({
							pluginId: plugin.id,
							entryId: item.id,
							slot: item.slot,
							message: `item "${plugin.id}:${item.id}" declares when:"${w}" which the host does not know — it is ignored (the item still renders)`,
						});
				}
			} else if (item.when !== undefined) {
				diag({
					pluginId: plugin.id,
					entryId: item.id,
					slot: item.slot,
					message: `item "${plugin.id}:${item.id}" has a non-array "when" — ignored`,
				});
			}
			const id = `${plugin.id}:${item.id}`;
			const prev = byId.get(id);
			if (prev) {
				diag({
					pluginId: plugin.id,
					entryId: item.id,
					slot: item.slot,
					message: `item id "${item.id}" is declared more than once — the later declaration wins (order/visibility are inherited from the first)`,
				});
			}
			byId.set(id, toWorkingEntry(id, item.slot, source, item, zh, prev?.seq ?? seq++));
		}
	}

	for (const plugin of plugins) {
		if (plugin.error || disabled.has(plugin.id)) continue;
		for (const op of plugin.ui?.arrange ?? []) {
			const before = byId.get(op.id);
			applyArrange(byId, op, plugin.id);
			if (!before)
				diag({
					pluginId: plugin.id,
					entryId: op.id,
					message: `arrange target "${op.id}" does not exist — op ignored (is the providing plugin installed / not disabled?)`,
				});
		}
	}

	const overrides = new Map<string, string[]>();
	const mark = (id: string, field: string) => {
		const list = overrides.get(id) ?? [];
		if (!list.includes(field)) list.push(field);
		overrides.set(id, list);
	};
	for (const id of layout.hidden ?? []) {
		const entry = byId.get(id);
		if (!entry) continue;
		entry.hidden = true;
		mark(id, "hidden");
	}
	for (const id of layout.shown ?? []) {
		const entry = byId.get(id);
		if (!entry) continue;
		entry.hidden = false;
		mark(id, "hidden");
	}
	for (const [id, group] of Object.entries(layout.groups ?? {})) {
		const entry = byId.get(id);
		if (!entry) continue;
		entry.group = group;
		mark(id, "group");
	}
	for (const [id, align] of Object.entries(layout.align ?? {})) {
		const entry = byId.get(id);
		if (!entry || (align !== "start" && align !== "center" && align !== "end")) continue;
		entry.align = align;
		mark(id, "align");
	}
	for (const [id, label] of Object.entries(layout.labels ?? {})) {
		const entry = byId.get(id);
		if (!entry) continue;
		entry.label = label;
		entry.labelExplicit = true;
		mark(id, "label");
	}
	for (const [id, targetSlot] of Object.entries(layout.slots ?? {})) {
		const entry = byId.get(id);
		if (!entry || !isSlotId(targetSlot)) continue;
		if (entry.slot !== targetSlot) {
			entry.movedFrom = entry.movedFrom ?? entry.slot;
			entry.slot = targetSlot;
			mark(id, "slot");
		}
	}
	for (const id of REQUIRED_TOPBAR_ITEM_IDS) {
		const entry = byId.get(id);
		if (entry) {
			if (!layout.slots?.[id]) {
				entry.slot = "topbar.primary";
			}
			entry.hidden = false;
		}
	}
	const rank: RankMap = new Map();
	(layout.order ?? []).forEach((id, index) => {
		if (!byId.has(id)) return;
		if (!rank.has(id)) rank.set(id, index);
		mark(id, "order");
	});

	for (const id of Object.values(LP_SECTION_ENTRY_ID)) {
		const entry = byId.get(id);
		if (entry && entry.slot !== "leftpanel.sections") {
			diag({ entryId: id, slot: entry.slot, message: `"${id}" must stay in leftpanel.sections — the move is ignored` });
			entry.slot = "leftpanel.sections";
			delete entry.movedFrom;
		}
	}
	const buckets = new Map<UiSlotId, WorkingEntry[]>();
	for (const id of SLOT_IDS) buckets.set(id, []);
	for (const entry of byId.values()) buckets.get(entry.slot)?.push(entry);
	const out = {} as Record<UiSlotId, UiSlotEntry[]>;
	for (const id of SLOT_IDS) {
		const sorted = sortEntries(buckets.get(id) ?? [], rank);
		const placed = id === "topbar.primary" ? placeTopbarPluginViews(sorted, rank) : sorted;
		const resolved = applyUiSlotCardinality(placed, uiSlotCardinality(id));
		if (resolved.winner && resolved.conflicts.length > 0) {
			for (const conflict of resolved.conflicts) {
				diag({
					level: "error",
					pluginId: conflict.source.startsWith("plugin:") ? conflict.source.slice("plugin:".length) : undefined,
					entryId: conflict.id,
					slot: id,
					message: `slot "${id}" is single-cardinality; "${resolved.winner.id}" won and "${conflict.id}" was hidden`,
				});
			}
		}
		out[id] = resolved.entries.map((entry) => toSlotEntry(entry, overrides.get(entry.id) ?? []));
	}
	return out;
}

function toSlotEntry(entry: WorkingEntry, userOverrides: string[]): UiSlotEntry {
	const out: UiSlotEntry = { ...entry, userOverrides };
	delete (out as Partial<WorkingEntry>).seq;
	return out;
}

function applyArrange(byId: Map<string, WorkingEntry>, op: UiArrangeOp, pluginId: string): void {
	const entry = byId.get(op.id);
	if (!entry) return;
	let applied = false;
	if (op.hide !== undefined) {
		entry.hidden = op.hide;
		applied = true;
	}
	if (op.group !== undefined) {
		entry.group = op.group;
		applied = true;
	}
	if (op.order !== undefined) {
		entry.order = op.order;
		applied = true;
	}
	if (op.align !== undefined) {
		entry.align = op.align;
		applied = true;
	}
	if (op.label !== undefined) {
		entry.label = op.label;
		entry.labelExplicit = true;
		applied = true;
	}
	if (op.hint !== undefined) {
		entry.hint = op.hint;
		applied = true;
	}
	if (op.icon !== undefined) {
		entry.icon = op.icon;
		applied = true;
	}
	if (op.iconSvg !== undefined) {
		entry.iconSvg = op.iconSvg || undefined;
		applied = true;
	}
	if (op.slot !== undefined && isSlotId(op.slot) && op.slot !== entry.slot) {
		entry.movedFrom = entry.movedFrom ?? entry.slot;
		entry.slot = op.slot;
		applied = true;
	}
	if (applied && entry.source !== `plugin:${pluginId}` && !entry.arrangedBy.includes(pluginId)) {
		entry.arrangedBy.push(pluginId);
	}
}

export function groupByAlign(entries: UiSlotEntry[]): {
	start: UiSlotEntry[];
	center: UiSlotEntry[];
	end: UiSlotEntry[];
} {
	const start: UiSlotEntry[] = [];
	const center: UiSlotEntry[] = [];
	const end: UiSlotEntry[] = [];
	for (const e of entries) {
		if (e.align === "end") end.push(e);
		else if (e.align === "center") center.push(e);
		else start.push(e);
	}
	return { start, center, end };
}

export function splitOverflow(entries: UiSlotEntry[], max: number): { inline: UiSlotEntry[]; overflow: UiSlotEntry[] } {
	const limit = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 0;
	if (limit >= entries.length) return { inline: [...entries], overflow: [] };
	return { inline: entries.slice(0, limit), overflow: entries.slice(limit) };
}

export function restoreUiItem(layout: UiLayoutPrefs | undefined, id: string): UiLayoutPrefs {
	const src = layout ?? {};
	const next: UiLayoutPrefs = {};
	const dropIds = id === BRAND_ITEM_ID ? [id, ...BRAND_OLD_IDS] : [id];
	const hidden = (src.hidden ?? []).filter((x) => !dropIds.includes(x));
	const shown = (src.shown ?? []).filter((x) => !dropIds.includes(x));
	const order = (src.order ?? []).filter((x) => !dropIds.includes(x));
	if (hidden.length > 0) next.hidden = hidden;
	if (shown.length > 0) next.shown = shown;
	if (order.length > 0) next.order = order;
	let groups = omitKey(src.groups, id);
	let labels = omitKey(src.labels, id);
	let align = omitKey(src.align, id);
	let slots = omitKey(src.slots, id);
	if (id === BRAND_ITEM_ID) {
		for (const old of BRAND_OLD_IDS) {
			groups = omitKey(groups, old);
			labels = omitKey(labels, old);
			align = omitKey(align, old);
			slots = omitKey(slots, old);
		}
	}
	if (groups) next.groups = groups;
	if (labels) next.labels = labels;
	if (align) next.align = align;
	if (slots) next.slots = slots;
	if (src.topbarText !== undefined) next.topbarText = src.topbarText;
	if (src.sideDockFloat !== undefined) next.sideDockFloat = src.sideDockFloat;
	return next;
}

export function restoreAllUi(): UiLayoutPrefs {
	return {};
}

function omitKey<T>(rec: Record<string, T> | undefined, key: string): Record<string, T> | undefined {
	if (!rec) return undefined;
	const out: Record<string, T> = {};
	let kept = false;
	for (const [k, v] of Object.entries(rec)) {
		if (k === key) continue;
		out[k] = v;
		kept = true;
	}
	return kept ? out : undefined;
}
