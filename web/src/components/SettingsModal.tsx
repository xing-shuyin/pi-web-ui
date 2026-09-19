import { Fragment, useEffect, useRef, useState } from "react";
import {
	FiAlertTriangle,
	FiArchive,
	FiBox,
	FiClock,
	FiCpu,
	FiDownload,
	FiEdit3,
	FiEye,
	FiFileText,
	FiFolder,
	FiGitBranch,
	FiHelpCircle,
	FiKey,
	FiMessageSquare,
	FiPackage,
	FiPlus,
	FiRefreshCw,
	FiSend,
	FiSettings,
	FiShield,
	FiSliders,
	FiTool,
	FiTrash2,
	FiUpload,
	FiUsers,
	FiX,
	FiZap,
} from "react-icons/fi";
import { CopyButton } from "./copy-button";
import { PluginIcon } from "../plugin-icon";
import { HintTip } from "./HintTip";
import { sortAgentPresets } from "./DshPresetBar";
import { DSH_PERMISSION_ORDER, permDescKey, permLabelKey } from "./DshPermissionBar";
import { PluginPage } from "./PluginPage";
import { PluginSettingsForm } from "./PluginSettingsForm";
import type {
	CommandDef,
	DshPermissionOption,
	SchedulerTaskView,
	UiAgentPreset,
	UiExtensionInfo,
	UiLayoutPrefs,
	UiSlotId,
	UiPluginCatalogEntry,
	UiPluginInfo,
	UiSettingsState,
	UiSkillInfo,
	UiSubagentTemplate,
} from "../types";
import { SchedulerPanel } from "./SchedulerPanel";
import {
	clearPromptHistory,
	loadPromptHistory,
	loadPromptHistorySettings,
	savePromptHistorySettings,
} from "../prompt-history";
import { randomUuid } from "../uuid";
import { THINKING_VALUES } from "../thinking-levels";
import { useWideChat, saveChatWidthSettings } from "../chat-width-settings";
import { useProjectTitle, saveTitleSettings } from "../title-settings";
import { sanitizeWallpaperUrl, fileToWallpaperUrl, saveWallpaperSettings, useWallpaperSettings } from "../wallpaper";
import { useT, useI18n } from "../i18n";
import {
	buildUiSlots,
	REQUIRED_TOPBAR_ITEM_IDS,
	restoreAllUi,
	restoreUiItem,
	withPluginViewItems,
	type UiSlotEntry,
} from "../ui-slots";
import type { CatalogSyncState, PluginJobState } from "../use-chat";
import { appSend, useAppGlobals } from "../app-globals";
import { countPluginPhases, pluginPhase, type PluginPhase } from "../plugin-phase";
import {
	PLUGIN_LOG_LEVELS,
	getPluginLogs,
	pluginLogsClearRequest,
	pluginLogsFetch,
	subscribePluginLogs,
	type PluginLogLevel,
} from "../plugin-logs";
import { QUICK_PHRASE_DEFAULTS } from "../quick-phrases";
import { DEFAULT_PROMPT_TEMPLATE, PROMPT_TOKENS, isReadonlyPromptSource } from "../../../server/prompt-composer.js";
import {
	ASK_USER_QUESTION_TOOL_NAME,
	BROWSER_PAGE_TOOL_NAME,
	CONVERSATION_READ_TOOL_NAME,
	DELEGATE_TASK_TOOL_NAME,
	EDIT_SOFT_TOOL_NAME,
	MARKERS_LIST_TOOL_NAME,
	SCHEDULE_CANCEL_TOOL_NAME,
	SCHEDULE_LIST_TOOL_NAME,
	SCHEDULE_TASK_TOOL_NAME,
	SUBAGENT_TOOL_NAMES,
	TERMINAL_TOOL_NAMES,
} from "../../../server/tool-manager.js";

/** Minimal terminal-tab bridge (same shape SCMPanel uses). */
interface SettingsTerminalBridge {
	create: (meta: {
		id: string;
		conversationId: string;
		title: string;
		cwd: string;
		cols: number;
		rows: number;
		running: boolean;
		exitCode: number | null;
		command?: CommandDef;
	}) => void;
	restart: (id: string) => void;
	select: (id: string) => void;
}

interface SettingsModalProps {
	/** Optional direct entry used by the top-bar plugin menu. */
	initialSection?: "plugins";
	chat: {
		settings: UiSettingsState | null;
		plugins: UiPluginInfo[];
		/** Installable-plugin list (marketplace) — one-click install candidates. */
		pluginCatalog: UiPluginCatalogEntry[];
		/** 插件后台作业（安装/更新/卸载）的实时状态，key = jobId（issue #152）。 */
		pluginJobs: Record<string, PluginJobState>;
		/** 最近一次目录同步的回执（issue #165「从目录同步」框展示用）。 */
		catalogSync: CatalogSyncState | null;
		/** 插件重载纪元：作为插件 client bundle URL 的 ?e= 缓存击穿参数传给插件页（#146）。 */
		pluginsEpoch: number;
		/** 插件目录授权表（设置面板列出 + 可撤销）。 */
		pluginGrants: { pluginId: string; paths: string[] }[];
		/** 插件能力授权表（动态授权；设置面板列出 + 可撤销）。 */
		pluginPermissions: {
			pluginId: string;
			family: "net" | "llm";
			hosts?: string[];
			models?: string[];
			reason?: string;
			grantedAt: number;
			session?: boolean;
		}[];
		/** DSH engine: <dataDir>/dsh-patches user patch files. */
		dshPatches: { patchDir: string; files: { name: string; path: string; size: number; mtimeMs: number }[] } | null;
		/** DSH engine: Agent 预设名录（null/空 = legacy，隐藏预设区）。 */
		dshPresets: { presets: UiAgentPreset[]; defaultPreset: string } | null;
		/** DSH engine: 权限预设选项表 + 新会话默认（null = 未就绪/legacy，隐藏权限区）。 */
		dshPermission: { options: DshPermissionOption[]; defaultPreset: string } | null;
		/** Engine id ("pi" | "dsh") 与 PI_WEB_MANAGED 已移到全局（web/src/app-globals.ts）。 */
		terminals: {
			id: string;
			title: string;
			conversationId: string;
			running: boolean;
			exitCode: number | null;
			command?: CommandDef;
		}[];
		state?: { cwd: string; conversationId: string } | null;
		activeConversationId?: string | null;
		/** 内置定时任务（issue #184，全局列表；DSH 引擎下为空） */
		schedulerTasks: SchedulerTaskView[];
	};
	terminal: SettingsTerminalBridge;
	/** Switch the top-level view to the terminal (uninstall runs there). */
	onSwitchToTerminal: () => void;
	onClose: () => void;
}

/** A row with an enable/disable switch (skill / extension). */
/** 最近同步过的目录 URL（issue #165：一键重同步）。localStorage 存本浏览器的最近 8 个，
 *  与服务端无关——换浏览器/清缓存只丢掉快捷入口，不影响已同步的列表。 */
const CATALOG_SYNC_RECENT_KEY = "pi-web-ui:catalog-sync-urls";
const CATALOG_SYNC_RECENT_MAX = 8;
function loadCatalogSyncRecent(): string[] {
	try {
		const raw = localStorage.getItem(CATALOG_SYNC_RECENT_KEY);
		if (!raw) return [];
		const arr: unknown = JSON.parse(raw);
		if (!Array.isArray(arr)) return [];
		return arr.filter((s): s is string => typeof s === "string" && s.trim() !== "").slice(0, CATALOG_SYNC_RECENT_MAX);
	} catch {
		return [];
	}
}
function rememberCatalogSyncUrl(url: string): string[] {
	const src = url.trim();
	if (!src) return loadCatalogSyncRecent();
	const next = [src, ...loadCatalogSyncRecent().filter((s) => s !== src)].slice(0, CATALOG_SYNC_RECENT_MAX);
	try {
		localStorage.setItem(CATALOG_SYNC_RECENT_KEY, JSON.stringify(next));
	} catch {
		/* 隐私模式：记不住就记不住 */
	}
	return next;
}

/** 文件大小人类可读（设置面板 DSH 补丁列表用）。 */
function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** 各来源排序权重：append 置顶（最常用），可编辑居中，只读沉底（纯预览）。 */
function rankPromptToken(tk: string): number {
	if (tk === "append") return 0;
	return isReadonlyPromptSource(tk) ? 2 : 1;
}

function ToggleRow({
	title,
	subtitle,
	tip,
	enabled,
	onToggle,
	action,
}: {
	title: React.ReactNode;
	subtitle?: string;
	/** 长解释走「？」悬浮提示，不再平铺（subtitle 与 tip 二选一）。 */
	tip?: string;
	enabled: boolean;
	onToggle: () => void;
	/** Optional extra control rendered left of the switch (e.g. uninstall). */
	action?: React.ReactNode;
}) {
	const t = useT();
	return (
		<div className="set-row">
			<div className="set-row-info">
				<div className="set-row-name">
					{title}
					{tip && <HintTip text={tip} />}
				</div>
				{subtitle && <div className="set-row-desc">{subtitle}</div>}
			</div>
			{action}
			<button
				type="button"
				className={`set-switch ${enabled ? "on" : ""}`}
				role="switch"
				aria-checked={enabled}
				title={enabled ? t("settingsEnabled") : t("settingsDisabled")}
				onClick={onToggle}
			>
				<span className="set-switch-knob" />
			</button>
		</div>
	);
}

/** 相位 → 文案 key（tt 绕行字面量约束，见文件顶部 tt 定义）。 */
function phaseLabelKey(ph: PluginPhase): string {
	if (ph === "active") return "pluginPhaseActive";
	if (ph === "disabled") return "pluginPhaseDisabled";
	if (ph === "failed") return "pluginPhaseFailed";
	return "pluginPhaseIdle";
}
/** 插件运行相位圆点（设置面板清单区 + 列表行标题用；颜色见 styles.css `.inv-dot`）。 */
function InvDot({ phase, label }: { phase: PluginPhase; label: string }) {
	return <span className={`inv-dot inv-dot-${phase}`} title={label} aria-label={label} />;
}

/** 插件清单汇总条（只读）：四相计数 + 各相圆点，明细在下方列表行里看。 */
function PluginInventoryStrip({ plugins, disabledIds }: { plugins: UiPluginInfo[]; disabledIds: ReadonlySet<string> }) {
	const t = useT();
	const counts = countPluginPhases(plugins, disabledIds);
	const labels: Record<PluginPhase, string> = {
		active: t("pluginPhaseActive"),
		disabled: t("pluginPhaseDisabled"),
		failed: t("pluginPhaseFailed"),
		idle: t("pluginPhaseIdle"),
	};
	const order: PluginPhase[] = ["active", "disabled", "failed", "idle"];
	return (
		<div className="set-note inv-strip">
			{order.map((ph) => (
				<span key={ph} className="inv-item" title={labels[ph]}>
					<InvDot phase={ph} label={labels[ph]} />
					{counts[ph]}
				</span>
			))}
		</div>
	);
}

/** 一行式表单行：标签左、控件（数字框/下拉）右，与开关共用右对齐线。 */
function FieldRow({
	label,
	tip,
	htmlFor,
	children,
}: {
	label: string;
	tip?: string;
	htmlFor?: string;
	children: React.ReactNode;
}) {
	return (
		<div className="set-row set-field-row">
			<label className="set-row-name" htmlFor={htmlFor}>
				{label}
				{tip && <HintTip text={tip} />}
			</label>
			{children}
		</div>
	);
}

/** 某插件的运行时日志面板（host.log 环形缓冲：级别过滤 + 清空；数据来自 plugin-logs store）。 */
function PluginLogView({ pluginId }: { pluginId: string }) {
	const t = useT();
	const [level, setLevel] = useState<"all" | PluginLogLevel>("all");
	const all = getPluginLogs(pluginId);
	const shown = level === "all" ? all : all.filter((e) => e.level === level);
	return (
		<>
			<div className="set-log-filter">
				<span className="set-log-filter-label">{t("pluginLogLevel")}</span>
				{(["all", ...PLUGIN_LOG_LEVELS] as const).map((lv) => (
					<button
						key={lv}
						type="button"
						className={`set-log-filter-btn${level === lv ? " on" : ""}`}
						onClick={() => setLevel(lv)}
					>
						{lv === "all" ? t("pluginLogAll") : lv.toUpperCase()}
					</button>
				))}
				<button
					type="button"
					className="set-log-clear"
					title={t("pluginLogClear")}
					onClick={() => appSend(pluginLogsClearRequest(pluginId))}
				>
					<FiTrash2 />
					{t("pluginLogClear")}
				</button>
			</div>
			{shown.length === 0 ? (
				<p className="set-empty">{t("pluginLogEmpty")}</p>
			) : (
				<ul className="set-diag-list set-log-list">
					{shown.map((e, i) => (
						<li key={`${pluginId}-${e.ts}-${i}`}>
							<span className="set-log-time">{new Date(e.ts).toLocaleTimeString()}</span>{" "}
							<span className={`set-log-level lv-${e.level}`}>{e.level.toUpperCase()}</span>{" "}
							<span className="set-log-text">{e.text}</span>
						</li>
					))}
				</ul>
			)}
		</>
	);
}

/** 设置弹窗的左侧分组导航（一次只显示一个区块，消灭长滚动）。
 *  插件自定义页（`settings.pages`）复用同一套导航：id 形如 `plugin-page:<条目全局 id>`
 *  —— 条目全局 id 本身是 `<pluginId>:<itemId>`，所以整串是 `plugin-page:<pluginId>:<itemId>`；
 *  一个插件可以贡献多页，故不用 `plugin-page:<pluginId>`（会撞车）。 */
type SettingsTab =
	| "prompt"
	| "prompt-history"
	| "scheduler"
	| "tools"
	| "question"
	| "display"
	| "quick"
	| "markers"
	| "skills"
	| "extensions"
	| "plugins"
	| "layout"
	| "review"
	| "vision"
	| "presets"
	| "subagent-templates"
	| `plugin-page:${string}`;

export function SettingsModal({ chat, terminal, initialSection, onSwitchToTerminal, onClose }: SettingsModalProps) {
	const t = useT();
	const { locale } = useI18n();
	// {{token}} 元数据文案键是动态的（promptTok_<token>[,_desc]），用 tt 跳过字面量类型。
	const tt = (k: string) => t(k as Parameters<typeof t>[0]);
	const settings = chat.settings;
	// 全局运行态（引擎 / 受管）：不再从 App 一路传进来，见 web/src/app-globals.ts。
	const { engine, managed } = useAppGlobals();
	// DSH 引擎：无 pi 扩展/技能体系与视觉桥概念 —— 隐藏对应分区/改占位说明。
	const isDsh = engine === "dsh";
	// 当前左侧导航选中的分组。
	const [tab, setTab] = useState<SettingsTab>(initialSection ?? "prompt");
	// 界面插件分组内的子页签：市场 / 已安装（一次只看一坨，免得 5 大块堆在一起滚半天；默认进市场，安装一步直达）。
	const [pluginSub, setPluginSub] = useState<"market" | "installed">("market");
	// 内容滚动容器：切换分组后回到顶部（各组高度不同，停留旧滚动位置会像没切换）。
	const bodyRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		bodyRef.current?.scrollTo({ top: 0 });
	}, [tab]);
	// 窄屏横滑导航：切换分组后把当前 chip 滚进可见区。
	const railRef = useRef<HTMLElement>(null);
	useEffect(() => {
		railRef.current?.querySelector(".settings-tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}, [tab]);
	// DSH 引擎：打开插件分组时拉一次用户 patch 列表（pi 引擎忽略该消息）。
	useEffect(() => {
		if (tab === "plugins" && isDsh) {
			appSend({ type: "dsh_patches_list" });
		}
	}, [tab, isDsh]);

	// Compose prompt — 组合模板（{{token}} 自由拼装）+ 各来源覆盖。本地草稿：
	// 模板聚焦中不覆盖；某个来源的覆盖框聚焦中不覆盖该 key（防回显打断输入）。
	const [promptTemplateDraft, setPromptTemplateDraft] = useState("");
	const [promptOverridesDraft, setPromptOverridesDraft] = useState<Record<string, string>>({});
	const templateFocus = useRef(false);
	const overrideFocus = useRef<string | null>(null);
	// 各来源展示顺序：append 置顶，其次可编辑来源，只读来源沉底（组内保持 PROMPT_TOKENS 原序）。
	const orderedPromptTokens = [...PROMPT_TOKENS].sort((a, b) => rankPromptToken(a) - rankPromptToken(b));
	// 未覆盖来源行内默认内容预览：点击预览进入覆盖输入（editingSource）；长文本展开/收起。
	const [editingSource, setEditingSource] = useState<string | null>(null);
	const [defaultOpen, setDefaultOpen] = useState<Record<string, boolean>>({});
	// Vision-bridge prompt draft — same local-edit/re-sync pattern as above.
	const [vbPromptDraft, setVbPromptDraft] = useState("");
	const [vbPromptMode, setVbPromptMode] = useState<"append" | "replace">("append");
	const vbPromptFocus = useRef(false);
	// 「AI 提交信息」提示词草稿（模式 + 文本；replace 且未改动内置默认 → 存空）。
	const [scmMsgDraft, setScmMsgDraft] = useState("");
	const [scmMsgMode, setScmMsgMode] = useState<"append" | "replace">("append");
	const scmMsgFocus = useRef(false);
	// Goal-review prompt is an independent draft: it does not change the main
	// agent system prompt and is only used by the isolated reviewer.
	const [reviewPromptDraft, setReviewPromptDraft] = useState("");
	const reviewPromptFocus = useRef(false);
	const [presetName, setPresetName] = useState("");
	// 正在编辑的子代理模板草稿（新建 = 空模板；null = 关闭编辑表单，表单在独立弹窗里渲染）。
	const [tplDraft, setTplDraft] = useState<UiSubagentTemplate | null>(null);
	// 弹窗标题用：新建 vs 编辑（draft 本身区分不出来）。
	const [tplIsNew, setTplIsNew] = useState(false);
	// 删除子代理模板的两步确认。
	const [confirmTplDelete, setConfirmTplDelete] = useState<string | null>(null);
	// Read-only viewer for the FULL system prompt actually in effect.
	const [showFullPrompt, setShowFullPrompt] = useState(false);
	const [showToolsSchema, setShowToolsSchema] = useState(false);
	// 宽屏聊天列开关（纯前端 localStorage，见 chat-width-settings.ts）。
	const wideChat = useWideChat();
	const projectTitle = useProjectTitle();
	// 聊天背景图（纯前端 localStorage，见 wallpaper.ts）：地址输入框用本地草稿，
	// 失焦/回车才提交（避免边输边校验）；压暗/模糊滑杆直接提交即时预览。
	const wallpaper = useWallpaperSettings();
	const [wallpaperDraft, setWallpaperDraft] = useState(wallpaper.url);
	const wallpaperFocus = useRef(false);
	const wallpaperFileRef = useRef<HTMLInputElement>(null);
	const [wallpaperUploading, setWallpaperUploading] = useState(false);
	const [wallpaperUploadError, setWallpaperUploadError] = useState(false);
	useEffect(() => {
		// data: 图不回填输入框（太长），下方缩略预览即表示生效中。
		if (!wallpaperFocus.current) setWallpaperDraft(wallpaper.url.startsWith("data:") ? "" : wallpaper.url);
	}, [wallpaper.url]);
	const onPickWallpaperFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		e.target.value = "";
		if (!file) return;
		setWallpaperUploading(true);
		setWallpaperUploadError(false);
		try {
			const url = await fileToWallpaperUrl(file);
			const clean = url ? sanitizeWallpaperUrl(url) : "";
			if (!clean) {
				setWallpaperUploadError(true);
				return;
			}
			setWallpaperDraft("");
			saveWallpaperSettings({ ...wallpaper, url: clean });
		} finally {
			setWallpaperUploading(false);
		}
	};
	// Prompt history settings (纯前端 localStorage，不经过 server).
	const [phSettings, setPhSettings] = useState(() => loadPromptHistorySettings());
	const [phCount, setPhCount] = useState(() => {
		try {
			return loadPromptHistory().length;
		} catch {
			return 0;
		}
	});
	const [phClearConfirm, setPhClearConfirm] = useState(false);
	const refreshPhCount = () => {
		try {
			setPhCount(loadPromptHistory().length);
		} catch {
			setPhCount(0);
		}
	};
	useEffect(() => {
		if (tab === "prompt-history") refreshPhCount();
	}, [tab]);
	useEffect(() => {
		if (!phClearConfirm) return;
		const id = window.setTimeout(() => setPhClearConfirm(false), 3000);
		return () => window.clearTimeout(id);
	}, [phClearConfirm]);
	// Two-step uninstall confirm: which extension id is awaiting confirmation.
	const [confirmUninstall, setConfirmUninstall] = useState<string | null>(null);
	// Two-step uninstall confirm for UI plugins (<dataDir>/plugins).
	const [confirmUiUninstall, setConfirmUiUninstall] = useState<string | null>(null);
	/** 界面插件诊断展开态（插件 id → 展开；一次只展开一行）。 */
	const [diagOpen, setDiagOpen] = useState<string | null>(null);
	/** 界面插件运行日志展开态（插件 id → 展开；一次只展开一行，点开即按需拉取）。 */
	const [logOpen, setLogOpen] = useState<string | null>(null);
	/** 日志 store 变化即重渲（拉取/清空回包到达时刷新列表与条数）。 */
	const [, bumpLogSeq] = useState(0);
	useEffect(() => subscribePluginLogs(() => bumpLogSeq((n) => n + 1)), []);
	// "Add to plugin list" form fields (plugin marketplace).
	const [catSource, setCatSource] = useState("");
	const [catId, setCatId] = useState("");
	const [catName, setCatName] = useState("");
	const [catDesc, setCatDesc] = useState("");
	const [catIcon, setCatIcon] = useState("");
	const [showCatAdd, setShowCatAdd] = useState(false);
	/** 市场安装/更新时先做隔离源码构建（等价 CLI --build，issue #150）。
	 *  没勾选也不怕：只有源码没有产物的插件服务端会自动构建（issue #165 的 --build 推断）；
	 *  勾选 = 连产物齐全的也强制重编。 */
	const [catBuild, setCatBuild] = useState(false);
	// 「从目录同步」表单（issue #165）：来源 + 选项 + 等待中的请求 id。
	const [showCatSync, setShowCatSync] = useState(false);
	const [catSyncSource, setCatSyncSource] = useState("");
	const [catSyncInstall, setCatSyncInstall] = useState(false);
	const [catSyncReplace, setCatSyncReplace] = useState(false);
	const [catSyncReq, setCatSyncReq] = useState<string | null>(null);
	const [catSyncSent, setCatSyncSent] = useState("");
	const [catSyncRecent, setCatSyncRecent] = useState<string[]>(() => loadCatalogSyncRecent());
	// 快捷短语新增输入框草稿（Enter / 添加按钮提交）。
	const [quickNew, setQuickNew] = useState("");
	// 快捷短语行内编辑（null = 未在编辑；输入框受控于 value，回显不打断输入）。
	const [quickEdit, setQuickEdit] = useState<{ index: number; value: string } | null>(null);

	useEffect(() => {
		if (!settings) return;
		if (!templateFocus.current) setPromptTemplateDraft(settings.promptTemplate ?? "");
		setPromptOverridesDraft((prev) => {
			const next: Record<string, string> = {};
			for (const [k, v] of Object.entries(settings.promptOverrides ?? {})) next[k] = v ?? "";
			if (overrideFocus.current) next[overrideFocus.current] = prev[overrideFocus.current] ?? "";
			return next;
		});
		setVbPromptMode(settings.visionBridgePromptMode);
		if (vbPromptFocus.current) return;
		setVbPromptDraft(
			vbPromptMode === "append" || settings.visionBridgePrompt
				? settings.visionBridgePrompt
				: settings.visionBridgeDefaultPrompt || "",
		);
		// 「AI 提交信息」提示词：replace 且存的是空（= 内置默认）时预填默认文本。
		setScmMsgMode(settings.scmCommitMsgPromptMode);
		if (!scmMsgFocus.current) {
			setScmMsgDraft(
				settings.scmCommitMsgPromptMode === "append" || settings.scmCommitMsgPrompt
					? settings.scmCommitMsgPrompt
					: settings.scmCommitMsgDefaultPrompt || "",
			);
		}
		if (!reviewPromptFocus.current) setReviewPromptDraft(settings.reviewPrompt);
	}, [settings, vbPromptMode, scmMsgMode]);

	const [idleMsDraft, setIdleMsDraft] = useState<string>(String(settings?.terminalBashIdleMs ?? 15000));
	useEffect(() => {
		setIdleMsDraft(String(settings?.terminalBashIdleMs ?? 15000));
	}, [settings?.terminalBashIdleMs]);
	// 模型报错自动重试次数：本地草稿（失焦/回车提交，0 = 失败即停）。
	const [retryDraft, setRetryDraft] = useState<string>(String(settings?.retryMaxAttempts ?? 6));
	useEffect(() => {
		setRetryDraft(String(settings?.retryMaxAttempts ?? 6));
	}, [settings?.retryMaxAttempts]);
	// 压缩软上限：本地草稿（空 = 关闭；失焦/回车提交）。
	const [softCapDraft, setSoftCapDraft] = useState<string>(
		settings?.softCapTokens && settings.softCapTokens > 0 ? String(settings.softCapTokens) : "",
	);
	useEffect(() => {
		setSoftCapDraft(settings?.softCapTokens && settings.softCapTokens > 0 ? String(settings.softCapTokens) : "");
	}, [settings?.softCapTokens]);
	// 按模型覆盖的新增行草稿。
	const [newCapModel, setNewCapModel] = useState<string>("");
	const [newCapTokens, setNewCapTokens] = useState<string>("");

	/** 宿主 UI 布局（issue #146 完整版）：所有挂载点的最终条目 = 内置 + 插件贡献 +
	 *  插件 arrange + 用户偏好。设置面板与 TopBar 用同一份计算，看到的顺序永远一致。
	 *  刻意放在 tabs 之前（也就跑在上面的 `if (!settings) return null` 之前）：插件自定义页
	 *  （settings.pages）也是导航的一项，得先算出来；而引用它的回落 effect 是 hook，
	 *  不能写在条件 return 之后。 */
	const uiSlots = buildUiSlots(withPluginViewItems(chat.plugins), {
		locale,
		t: (key: string) => t(key as Parameters<typeof t>[0]),
		disabledPlugins: chat.settings?.disabledPlugins ?? [],
		layout: chat.settings?.uiLayout,
	});

	/** `settings.pages` 里可渲染的插件页（导航一项 = 一页）。跳过：宿主条目（该槽位按契约是
	 *  插件专属）、被插件或用户隐藏的、纯分隔线，以及**查不到插件的**（清单还没推来 /
	 *  插件刚被卸载 / 被禁用）—— 宁可少一页，也不要点开才发现白屏（口径同右栏插件 tab）。
	 *  顺序严格按 uiSlots 给的结果（那边已按「插件 → arrange → 用户偏好」排好）。 */
	const pluginPages: { entry: UiSlotEntry; plugin: UiPluginInfo }[] = [];
	for (const entry of uiSlots["settings.pages"]) {
		if (entry.source === "host" || entry.hidden || entry.kind === "divider") continue;
		const plugin = chat.plugins.find((p) => p.id === entry.source.slice("plugin:".length));
		if (!plugin) continue;
		pluginPages.push({ entry, plugin });
	}
	/** 导航 id ↔ 插件页的换算只写这一处（tab 状态、回落 effect、渲染块共用）。 */
	const pluginPageTabId = (entryId: string): SettingsTab => `plugin-page:${entryId}`;

	/** 正在看的插件页消失了（插件被卸载/禁用，或布局页把这条隐藏了）→ 回落到默认分区。
	 *  留着指向不存在的 tab，正文会空白一片，而导航里那项也没了——用户不知道该点哪。
	 *  用 effect 而不是渲染期纠正：纠正要改 state，渲染期不能改。 */
	useEffect(() => {
		if (!tab.startsWith("plugin-page:")) return;
		if (pluginPages.some((p) => pluginPageTabId(p.entry.id) === tab)) return;
		setTab("prompt");
	}, [tab, pluginPages]);

	if (!settings) return null;

	// 统一工具禁用名单（工具 tab 唯一写入口；旧 tab 的遗留单开关已迁入）。
	const disabledTools = new Set(settings.disabledAgentTools ?? []);
	const disabledToolsCount = disabledTools.size;

	const tabs: {
		id: SettingsTab;
		icon: React.ReactNode;
		label: string;
		/** 有计数徽标（与各区块标题里的 set-count 同源）。 */
		count?: number;
		/** 插件自定义页：内容交给 PluginPage 渲染（内置分区没有这一项）。 */
		pluginPage?: { plugin: UiPluginInfo; entry: UiSlotEntry };
		/** 悬浮提示（插件条目的 `hint`）。 */
		hint?: string;
	}[] = [
		{ id: "prompt", icon: <FiFileText />, label: t("settingsSystemPrompt") },
		{
			id: "prompt-history",
			icon: <FiClock />,
			label: t("settingsPromptHistory"),
			count: phCount,
		},
		// 内置定时任务（issue #184）：DSH 引擎无无头执行通道，隐藏该分区。
		...(isDsh
			? []
			: [
					{
						id: "scheduler" as const,
						icon: <FiClock />,
						label: t("settingsScheduler"),
						count: chat.schedulerTasks.length || undefined,
					},
				]),
		// 统一工具开关（tool-manager.ts 目录，逐工具）：DSH 引擎无子代理/edit_soft
		// 概念，隐藏该分区；DSH 的问卷开关仍在“问卷提问”页（走 goal-rpc）。
		...(isDsh
			? [{ id: "question" as const, icon: <FiHelpCircle />, label: t("settingsQuestionnaire") }]
			: [
					{
						id: "tools" as const,
						icon: <FiTool />,
						label: t("settingsTools"),
						count: disabledToolsCount + (settings.disabledMarkers?.length ?? 0) || undefined,
					},
				]),
		{ id: "display", icon: <FiMessageSquare />, label: t("settingsMessageDisplay") },
		{ id: "quick", icon: <FiSend />, label: t("quickPhrases"), count: settings.quickPhrases.length },
		{ id: "skills", icon: <FiCpu />, label: t("settingsSkills"), count: settings.skills.length },
		{ id: "extensions", icon: <FiPackage />, label: t("settingsExtensions"), count: settings.extensions.length },
		{ id: "plugins", icon: <FiBox />, label: t("settingsUiPlugins"), count: chat.plugins.length },
		{ id: "layout", icon: <FiSliders />, label: t("uiLayoutTitle") },
		{ id: "review", icon: <FiZap />, label: t("settingsReview"), count: settings.reviewSkills.length },
		// DSH：无视觉桥概念（真图片直通 vision 模型），隐藏该分区。
		...(isDsh ? [] : [{ id: "vision" as const, icon: <FiEye />, label: t("settingsVisionBridge") }]),
		{ id: "presets", icon: <FiSliders />, label: t("settingsPresets"), count: settings.presets.length },
		// DSH：无子代理概念，隐藏该分区。
		...(isDsh
			? []
			: [
					{
						id: "subagent-templates" as const,
						icon: <FiUsers />,
						label: t("settingsSubagentTemplates"),
						count: settings.subagentTemplates.length,
					},
				]),
		// 插件自定义设置页（settings.pages，issue #146）：排在内置分区之后。内容由
		// PluginPage 挂载插件自己的 client bundle 渲染（设置弹窗不关、主视图不切）。
		...pluginPages.map((p) => ({
			id: pluginPageTabId(p.entry.id),
			// 图标：插件给 emoji/单字符就照原样画；给的是宿主图标词表名（或没给）时用通用盒图标，
			// 绝不把 "folder" 这样的词当文字显出来（口径同 SlotTabs.isGlyphIcon）。
			icon: p.entry.iconSvg ? (
				<PluginIcon iconSvg={p.entry.iconSvg} />
			) : p.entry.icon && !/[a-z]/i.test(p.entry.icon) ? (
				<span>{p.entry.icon}</span>
			) : (
				<FiBox />
			),
			label: p.entry.label,
			pluginPage: { plugin: p.plugin, entry: p.entry },
		})),
	];

	/** 当前选中的插件页（tab 形如 `plugin-page:<条目全局 id>`）。找不到 = null：上面的 effect
	 *  会把 tab 纠回默认分区，这里先什么都不画，免得白屏时还留着上一页的错误提示。 */
	const activePluginPage = tab.startsWith("plugin-page:")
		? (pluginPages.find((p) => pluginPageTabId(p.entry.id) === tab) ?? null)
		: null;

	const disabledSkills = new Set(settings.disabledSkills);
	const disabledExts = new Set(settings.disabledExtensions);

	const setPartial = (patch: {
		promptMode?: "append" | "replace";
		customSystemPrompt?: string;
		promptTemplate?: string;
		promptOverrides?: Record<string, string>;
		disabledSkills?: string[];
		disabledExtensions?: string[];
		disabledPlugins?: string[];
		/** 宿主 UI 布局偏好（插件 UI 贡献 + 内置条目的隐藏/排序/分组；纯 UI，per-client）。 */
		uiLayout?: UiLayoutPrefs;
		/** 统一工具禁用名单（工具 tab 逐工具开关；遗留单开关仍可用，会折回此名单）。 */
		disabledAgentTools?: string[];
		/** 插件 AI 工具禁用名单（工具名；live 生效无需 reload）。 */
		disabledPluginTools?: string[];
		terminalToolsEnabled?: boolean;
		terminalBash?: boolean;
		terminalBashIdleMs?: number;
		editSoftEnabled?: boolean;
		questionnaireEnabled?: boolean;
		goalModeEnabled?: boolean;
		parallelReminderEnabled?: boolean;
		thinkingWrap?: boolean;
		toolsWrap?: boolean;
		devNoCache?: boolean;
		autoReload?: boolean;
		skillsFullText?: string[];
		quickPhrases?: string[];
		quickPhrasesEnabled?: boolean;
		visionBridgeEnabled?: boolean;
		visionBridgeModel?: string | null;
		visionBridgePromptMode?: "append" | "replace";
		visionBridgePrompt?: string;
		scmCommitMsgPromptMode?: "append" | "replace";
		scmCommitMsgPrompt?: string;
		subagentDefaultModel?: string | null;
		retryMaxAttempts?: number;
		softCapTokens?: number;
		softCapByModel?: Record<string, number>;
		reviewPrompt?: string;
		reviewDisabledSkills?: string[];
		markersEnabled?: boolean;
		disabledMarkers?: string[];
	}) => appSend({ type: "set_settings", ...patch });

	/** 提交快捷短语行内编辑（空 = 取消；与原值相同 = 无操作；其余走服务端归一化）。 */
	const commitQuickEdit = () => {
		if (!quickEdit || !settings) return;
		const v = quickEdit.value.trim();
		const i = quickEdit.index;
		setQuickEdit(null);
		if (!v || v === settings.quickPhrases[i]) return;
		const next = [...settings.quickPhrases];
		next[i] = v;
		setPartial({ quickPhrases: next });
	};

	const toggleSkill = (s: UiSkillInfo) => {
		const next = new Set(disabledSkills);
		if (next.has(s.name)) next.delete(s.name);
		else next.add(s.name);
		setPartial({ disabledSkills: [...next] });
	};

	// skill 全文注入名单：按技能单独勾选（空 = 名录模式）。
	const fullTextSkills = new Set(settings.skillsFullText ?? []);
	const toggleSkillFullText = (name: string) => {
		const next = new Set(fullTextSkills);
		if (next.has(name)) next.delete(name);
		else next.add(name);
		setPartial({ skillsFullText: [...next] });
	};

	const disabledPlugins = new Set(settings.disabledPlugins ?? []);
	const installedPluginIds = new Set(chat.plugins.map((p) => p.id));
	const togglePlugin = (p: UiPluginInfo) => {
		const next = new Set(disabledPlugins);
		if (next.has(p.id)) next.delete(p.id);
		else next.add(p.id);
		setPartial({ disabledPlugins: [...next] });
	};

	const toggleExtension = (e: UiExtensionInfo) => {
		const next = new Set(disabledExts);
		if (next.has(e.id)) next.delete(e.id);
		else next.add(e.id);
		setPartial({ disabledExtensions: [...next] });
	};

	// 子代理各工具的「?」说明（key 与 tool-manager.ts 的 SUBAGENT_TOOL_NAMES 对齐）。
	const SUBAGENT_TOOL_TIPS: Record<string, string> = {
		subagent_spawn: t("toolDescSubagentSpawn"),
		subagent_get_result: t("toolDescSubagentGetResult"),
		subagent_steer: t("toolDescSubagentSteer"),
		subagent_list: t("toolDescSubagentList"),
		subagent_stop: t("toolDescSubagentStop"),
		subagent_wait_all: t("toolDescSubagentWaitAll"),
		subagent_templates: t("toolDescSubagentTemplates"),
	};
	// 统一工具开关（工具 tab 逐工具；与 toggleSkill 同模式）。
	const toggleAgentTool = (name: string) => {
		const next = new Set(disabledTools);
		if (next.has(name)) next.delete(name);
		else next.add(name);
		setPartial({ disabledAgentTools: [...next] });
	};
	// 插件 AI 工具开关（插件 tab 按插件分组 + 工具 tab 汇总区共用；live 生效）。
	const disabledPluginTools = new Set(settings.disabledPluginTools ?? []);
	const togglePluginTool = (name: string) => {
		const next = new Set(disabledPluginTools);
		if (next.has(name)) next.delete(name);
		else next.add(name);
		setPartial({ disabledPluginTools: [...next] });
	};
	const pluginToolGroups = chat.plugins
		.map((p) => ({ plugin: p, tools: [...(p.agentTools ?? [])].sort((a, b) => a.name.localeCompare(b.name)) }))
		.filter((g) => g.tools.length > 0);

	// ---- markers ----
	const markersEnabled = settings.markersEnabled ?? true;
	const disabledMarkers = new Set(settings.disabledMarkers ?? []);
	const toggleMarker = (name: string) => {
		const next = new Set(disabledMarkers);
		const currentlyEnabled = !next.has(name);
		if (currentlyEnabled) next.add(name);
		else next.delete(name);
		setPartial({ disabledMarkers: [...next] });
	};

	/** Run a maintenance command (extension uninstall / UI-plugin install or
	 *  uninstall) in a VISIBLE terminal tab (same reuse pattern as SCM write
	 *  ops) so the user sees exactly what happened. On exit the App watcher
	 *  sends extensions_reload / plugins_reload to re-discover the lists. */
	const runTerminalCommand = (title: string, command: string) => {
		const cmd: CommandDef = {
			name: title,
			command,
			cwd: "${pwd}",
		};
		let targetId: string;
		const existing = chat.terminals.find((tm) => tm.title === title);
		if (existing) {
			terminal.restart(existing.id);
			appSend({
				type: "run_command",
				terminalId: existing.id,
				conversationId: existing.conversationId,
				command: cmd,
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
				command: cmd,
			});
		}
		terminal.select(targetId);
		onSwitchToTerminal();
		onClose();
	};

	/** Uninstall a `pi install`-ed package: run `pi remove npm:<pkg>` in a
	 *  visible terminal tab (see runTerminalCommand). */
	const runUninstall = (pkgName: string) => {
		setConfirmUninstall(null);
		runTerminalCommand(`${t("uninstallTitle")} ${pkgName}`, `pi remove npm:${pkgName}`);
	};

	/** 提交一个插件后台作业（安装/更新/卸载，issue #152）：服务端跑 CLI 并把输出按行
	 *  回推，设置面板就地显示——不切视图、不关弹窗、不占用户终端。 */
	const runPluginJob = (action: "install" | "update" | "uninstall", id: string, source?: string) => {
		appSend({
			type: "plugin_job",
			jobId: randomUuid(),
			action,
			id,
			...(source ? { source } : {}),
			...(action !== "uninstall" && catBuild ? { build: true } : {}),
		});
	};

	/** 某个插件最近一次后台作业（按开始时间取最新）。 */
	const jobFor = (pluginId: string): PluginJobState | null => {
		let best: PluginJobState | null = null;
		for (const j of Object.values(chat.pluginJobs ?? {})) {
			if (j.pluginId !== pluginId) continue;
			if (!best || j.startedAt >= best.startedAt) best = j;
		}
		return best;
	};

	/** 就地显示作业状态：进行中（带最后一行输出）/ 成功 / 失败（带输出尾部）。 */
	const renderJobStatus = (pluginId: string) => {
		const job = jobFor(pluginId);
		if (!job) return null;
		if (job.phase !== "done") {
			const last = job.lines[job.lines.length - 1] ?? "";
			return (
				<div className="set-catalog-job running" title={last}>
					<FiRefreshCw className="set-job-spin" />
					{t("pluginJobRunning")}
					<span className="set-catalog-job-line">{last}</span>
				</div>
			);
		}
		if (job.ok) return <div className="set-catalog-job ok">✓ {t("pluginJobDone")}</div>;
		return (
			<div className="set-catalog-job error">
				<span>✗ {job.error || t("pluginJobFailed")}</span>
				{job.output ? <pre className="set-catalog-job-out">{job.output}</pre> : null}
			</div>
		);
	};

	/** 布局页按界面位置分组的挂载点（21 个全量：与 ui-slots.ts 的 SLOT_IDS 同顺序，
	 *  严格按实际界面的 DOM/视觉顺序：顶栏 → 通知 → 左栏 → 主列（头部/空态/消息/目标条/
	 *  输入框） → 右栏 → 终端/Git 视图 → 底栏 → 悬浮层 → 右键菜单 → 设置页 → 对话框）。 */
	const uiLayoutSections: { slot: UiSlotId; labelKey: string }[] = [
		{ slot: "topbar.primary", labelKey: "uiLayoutTopbar" },
		{ slot: "topbar.overflow", labelKey: "uiLayoutTopbarOverflow" },
		{ slot: "notice.actions", labelKey: "uiLayoutNotice" },
		{ slot: "leftpanel.sessions", labelKey: "uiLayoutLeftSessions" },
		{ slot: "chat.header", labelKey: "uiLayoutChatHeader" },
		{ slot: "chat.empty", labelKey: "uiLayoutChatEmpty" },
		{ slot: "message.actions", labelKey: "uiLayoutMessage" },
		{ slot: "goalbar.actions", labelKey: "uiLayoutGoalbar" },
		{ slot: "composer.leading", labelKey: "uiLayoutComposerLeading" },
		{ slot: "composer.actions", labelKey: "uiLayoutComposer" },
		{ slot: "rightpanel.tabs", labelKey: "uiLayoutRightPanel" },
		{ slot: "terminal.toolbar", labelKey: "uiLayoutTerminal" },
		{ slot: "scm.toolbar", labelKey: "uiLayoutScm" },
		{ slot: "bottombar", labelKey: "uiLayoutBottombar" },
		{ slot: "file.preview.toolbar", labelKey: "uiLayoutFilePreview" },
		{ slot: "contextmenu.topbar", labelKey: "uiLayoutContextTopbar" },
		{ slot: "contextmenu.message", labelKey: "uiLayoutContextMessage" },
		{ slot: "contextmenu.session", labelKey: "uiLayoutContextSession" },
		{ slot: "contextmenu.file", labelKey: "uiLayoutContextFile" },
		{ slot: "settings.pages", labelKey: "uiLayoutSettingsPages" },
		{ slot: "modal.dialog", labelKey: "uiLayoutModal" },
	];
	/** 渲染层真正按 align 分区的槽位（其余槽位的 align 存了也无处生效，布局页就不提供了）。
	 *  顶栏与底栏/输入框动作区同口径：顶栏现在**每个**条目的 align 都生效（贴边例外已取消，
	 *  ☰/📁 也是普通条目：顺序、对齐、显隐全部可改，手机上它们默认就是最左/最右）。 */
	const uiAlignSlots: UiSlotId[] = ["bottombar", "composer.actions", "topbar.primary"];
	const [uiLayoutFilter, setUiLayoutFilter] = useState("");
	/** 槽位 id → 布局页分区标题（movedFrom「移自哪」的显示用）。 */
	const uiSlotTitle = (slot: UiSlotId): string => {
		const found = uiLayoutSections.find((s) => s.slot === slot);
		return found ? t(found.labelKey as Parameters<typeof t>[0]) : slot;
	};
	const layout = chat.settings?.uiLayout;
	const setLayout = (patch: UiLayoutPrefs) => setPartial({ uiLayout: { ...layout, ...patch } });
	/** 取消勾选＝用户隐藏；勾回＝用户显式显示（覆盖插件声明的 hidden / arrange 的 hide）。 */
	const toggleUiHidden = (entry: UiSlotEntry) => {
		const hidden = new Set(layout?.hidden ?? []);
		const shown = new Set(layout?.shown ?? []);
		if (entry.hidden) {
			hidden.delete(entry.id);
			shown.add(entry.id);
		} else {
			hidden.add(entry.id);
			shown.delete(entry.id);
		}
		setLayout({ hidden: [...hidden], shown: [...shown] });
	};
	/** ↑/↓：把顺序写进全局 order，同时保留其他槽位已有的自定义顺序。
	 *  layout.order 是跨槽位共享的一维数组（合并引擎按槽位内相对次序用），直接用本槽位
	 *  的全量 id 覆盖它会把其他槽位的调序洗掉 —— 所以先摘掉本槽位的旧痕迹，再把新顺序
	 *  接在其他槽位顺序之后（跨槽位的前后关系不影响渲染，只影响同槽位内的相对次序）。
	 *  顶栏/底栏/输入框动作区在界面上按对齐段分组渲染（左 start → 中 center → 右 end，
	 *  见 TopBar 的 segStart/segCenter/segEnd、FooterBar 的左右分区、ChatInput 的
	 *  composerGroups），布局页同口径按段展示、↑↓ 只在段内移动：调用方传全槽位
	 *  allEntries 与当前段 rowItems，段内新顺序就地写回全槽位顺序（段外条目原位不动 ——
	 *  跨段的前后本来就不影响渲染，换段走对齐下拉）。其余槽位整槽一段，与旧行为一致。 */
	const moveUiEntry = (allEntries: UiSlotEntry[], rowItems: UiSlotEntry[], id: string, delta: number) => {
		const groupKeys = rowItems.map((e) => e.id);
		const idx = groupKeys.indexOf(id);
		const target = idx + delta;
		if (idx < 0 || target < 0 || target >= groupKeys.length) return;
		const nextGroup = [...groupKeys];
		const [moved] = nextGroup.splice(idx, 1);
		if (moved === undefined) return;
		nextGroup.splice(target, 0, moved);
		// 段内新顺序就地写回全槽位顺序：属于本段的位置按新顺序依次填入，段外条目不动。
		const groupSet = new Set(groupKeys);
		const queue = [...nextGroup];
		const next = allEntries.map((e) => (groupSet.has(e.id) ? (queue.shift() as string) : e.id));
		const inSlot = new Set(allEntries.map((e) => e.id));
		const others = (layout?.order ?? []).filter((x) => !inSlot.has(x));
		setLayout({ order: [...others, ...next] });
	};
	/** 对齐：只给渲染层真分区的槽位提供（start/center/end，脏值由合并引擎兜底）。 */
	const setUiAlign = (id: string, align: string) => {
		if (align !== "start" && align !== "center" && align !== "end") return;
		setLayout({ align: { ...layout?.align, [id]: align } });
	};
	/** 改名：空串 = 清掉用户文案、回到合并文案（60 字截断与协议同口径）。 */
	const setUiLabel = (id: string, label: string) => {
		const labels = { ...layout?.labels };
		const name = label.trim().slice(0, 60);
		if (!name) delete labels[id];
		else labels[id] = name;
		setLayout({ labels });
	};
	/** 恢复单条：清掉该条目上的全部用户覆盖（隐藏/显示/顺序/分组/文案）。 */
	const restoreUi = (id: string) => setPartial({ uiLayout: restoreUiItem(layout, id) });
	/** 一键恢复：插件 arrange 与用户偏好全部作废，回到宿主默认布局。 */
	const restoreUiAll = () => setPartial({ uiLayout: restoreAllUi() });

	/** 卸载一个界面插件：后台作业（不占用户终端、不关设置面板，issue #152）。 */
	const runUiPluginUninstall = (id: string) => {
		setConfirmUiUninstall(null);
		runPluginJob("uninstall", id);
	};

	/** 更新一个界面插件：用记录下来的安装来源重装（--force，config.json 保留）。 */
	const runUiPluginUpdate = (id: string, source: string) => {
		runPluginJob("update", id, source);
	};

	/** 从市场一键安装（未装的直接装；已装的按钮走更新）。 */
	const runCatalogInstall = (e: UiPluginCatalogEntry) => {
		runPluginJob("install", e.id, e.source);
	};

	/** Remove a user-added plugin from the marketplace list. */
	const runCatalogRemove = (id: string) => {
		appSend({ type: "plugin_catalog_remove", id });
	};

	/** Submit the "add to plugin list" form (server validates + persists). */
	const submitCatalogAdd = () => {
		const source = catSource.trim();
		if (!source) return;
		appSend({
			type: "plugin_catalog_add",
			entry: {
				source,
				...(catId.trim() ? { id: catId.trim() } : {}),
				...(catName.trim() ? { name: catName.trim() } : {}),
				...(catDesc.trim() ? { description: catDesc.trim() } : {}),
				...(catIcon.trim() ? { icon: catIcon.trim() } : {}),
			},
		});
		setCatSource("");
		setCatId("");
		setCatName("");
		setCatDesc("");
		setCatIcon("");
		setShowCatAdd(false);
	};

	/** 从目录文档同步可安装列表（issue #165）：走服务端现成的 plugin_catalog_sync 通道
	 *  （与插件 host.reloadCatalog 同一条：同校验、同原子写盘、同回执），只是在设置面板里
	 *  给用户一个直接入口 —— 第三方仓库不再需要为此专门发一个“目录同步插件”。 */
	const runCatalogSync = (source: string) => {
		const src = source.trim();
		if (!src) return;
		const requestId = randomUuid();
		setCatSyncReq(requestId);
		setCatSyncSent(src);
		appSend({
			type: "plugin_catalog_sync",
			requestId,
			source: src,
			...(catSyncInstall ? { install: true } : {}),
			...(catSyncReplace ? { replace: true } : {}),
		});
	};

	/** 正在等的那次同步的回执（requestId 对上才展示；别人的/插件的同步不掺和）。 */
	const syncReceipt = chat.catalogSync && chat.catalogSync.requestId === catSyncReq ? chat.catalogSync : null;
	// 同步成功才记住 URL（失败的不进“最近”，免得一键重放一个坏地址）。
	useEffect(() => {
		if (syncReceipt?.ok && catSyncSent) setCatSyncRecent(rememberCatalogSyncUrl(catSyncSent));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [syncReceipt?.requestId, syncReceipt?.ok]);

	const toggleReviewSkill = (s: UiSkillInfo) => {
		const disabled = new Set(settings.reviewSkills.filter((x) => !x.enabled).map((x) => x.name));
		if (disabled.has(s.name)) disabled.delete(s.name);
		else disabled.add(s.name);
		setPartial({ reviewDisabledSkills: [...disabled] });
	};

	const commitTemplate = () => setPartial({ promptTemplate: promptTemplateDraft });

	const commitOverride = (token: string) => {
		setPartial({ promptOverrides: { [token]: promptOverridesDraft[token] ?? "" } });
	};

	const resetOverride = (token: string) => {
		if (overrideFocus.current === token) overrideFocus.current = null;
		setEditingSource(null);
		setPromptOverridesDraft((p) => {
			const n = { ...p };
			delete n[token];
			return n;
		});
		setPartial({ promptOverrides: { [token]: "" } });
	};

	/** 来源默认内容预览的长文本展开/收起。 */
	const toggleDefault = (tk: string) => setDefaultOpen((p) => ({ ...p, [tk]: !p[tk] }));

	/** 覆盖输入时一键把默认（自动）内容填进覆盖框 —— 只想改一小部分时用它打底（填
	 *  入后该来源内容固定，不再随每次对话自动重新生成）。 */
	const seedFromDefault = (tk: string, def: string) => {
		setPromptOverridesDraft((p) => ({ ...p, [tk]: def }));
		setEditingSource(tk);
	};

	const resetAllPrompt = () => {
		templateFocus.current = false;
		overrideFocus.current = null;
		setPromptTemplateDraft(DEFAULT_PROMPT_TEMPLATE);
		setPromptOverridesDraft({});
		setPartial({ promptTemplate: DEFAULT_PROMPT_TEMPLATE, promptOverrides: {} });
	};

	const appendTokenToTemplate = (token: string) => {
		setPromptTemplateDraft((prev) => (prev.trim() ? `${prev}\n\n{{${token}}}` : `{{${token}}}`));
	};

	const hasPromptCustom =
		(promptTemplateDraft.trim() && promptTemplateDraft.trim() !== DEFAULT_PROMPT_TEMPLATE) ||
		Object.values(promptOverridesDraft).some((v) => v.trim());

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
				<button type="button" className="modal-close" aria-label={t("close")} onClick={onClose}>
					<FiX />
				</button>
				<div className="modal-head">
					<FiSettings className="modal-head-icon" />
					<h2>{t("settingsTitle")}</h2>
					{/* 长说明收起为「？」悬浮提示，不再平铺占版面 */}
					<HintTip text={t("settingsDesc")} />
				</div>

				{/* Scrollable body — head above and the actions bar below stay
				    fixed; only these sections scroll. */}
				<div className="settings-layout">
					<nav className="settings-rail" aria-label={t("settingsTitle")} ref={railRef}>
						{tabs.map((tb) => (
							<button
								key={tb.id}
								type="button"
								data-tab={tb.id}
								className={`settings-tab${tab === tb.id ? " active" : ""}`}
								aria-current={tab === tb.id ? "true" : undefined}
								title={tb.hint ?? tb.label}
								onClick={() => setTab(tb.id)}
							>
								<span className="settings-tab-icon">{tb.icon}</span>
								<span className="settings-tab-label">{tb.label}</span>
								{tb.count !== undefined && <span className="set-count">{tb.count}</span>}
							</button>
						))}
					</nav>
					<div className="modal-body" ref={bodyRef}>
						{/* ---- system prompt -------------------------------------------- */}
						{tab === "prompt" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiZap className="set-section-icon" />
									{t("settingsSystemPrompt")}
									<HintTip text={`${t("promptComposeHint")}\n${t("promptComposeDesc")}`} />
								</div>
								<div className="set-field">
									<label className="set-field-label">{t("promptTemplateLabel")}</label>
									<textarea
										className="set-prompt-input"
										rows={6}
										spellCheck={false}
										placeholder={DEFAULT_PROMPT_TEMPLATE}
										value={promptTemplateDraft}
										onFocus={() => (templateFocus.current = true)}
										onBlur={() => {
											templateFocus.current = false;
											commitTemplate();
										}}
										onChange={(e) => setPromptTemplateDraft(e.target.value)}
									/>
									<div className="compose-toolbar">
										<span className="set-field-label set-muted">{t("promptInsertTokens")}</span>
										{orderedPromptTokens.map((tk) => (
											<button
												key={tk}
												type="button"
												className="token-chip"
												title={tt(`promptTok_${tk}_desc`)}
												onClick={() => appendTokenToTemplate(tk)}
											>
												{`{{${tk}}}`}
											</button>
										))}
									</div>
								</div>
								{/* 各来源覆盖：留空 = 用自动内容；未覆盖时行内直接展示该来源当前的默认（自动）内容 */}
								<div className="set-field">
									<label className="set-field-label">{t("promptSourcesLabel")}</label>
									{orderedPromptTokens.map((tk) => {
										const v = promptOverridesDraft[tk] ?? "";
										// 该来源当前默认（自动）内容：会话未就绪时为空对象 → def = ""。
										const def = settings.promptSourceDefaults?.[tk] ?? "";
										const editing = editingSource === tk;
										const isLong = def.split("\n").length > 6 || def.length > 480;
										if (isReadonlyPromptSource(tk)) {
											const shown = v.trim() ? v : def;
											return (
												<div className="override-row readonly" key={tk}>
													<div className="override-row-head">
														{`{{${tk}}}`}
														<span className="set-muted">
															{tt(`promptTok_${tk}`)} <HintTip text={tt(`promptTok_${tk}_desc`)} />
														</span>
														{v.trim() ? (
															<button
																type="button"
																className="set-btn-mini"
																title={t("promptReadonlyLockedHint")}
																onClick={() => resetOverride(tk)}
															>
																{t("promptResetSource")}
															</button>
														) : (
															<span className="set-muted">{t("promptReadonlyBadge")}</span>
														)}
													</div>
													<div
														className={`source-default readonly${shown.trim() ? "" : " empty"}`}
														title={t("promptReadonlyTitle")}
													>
														{shown.trim() ? (
															<>
																<pre
																	className={`source-default-text${
																		isLong ? (defaultOpen[tk] ? " expanded" : " clamped") : ""
																	}`}
																>
																	{shown}
																</pre>
																{isLong && (
																	<span
																		className="source-default-toggle"
																		role="button"
																		tabIndex={0}
																		onClick={(e) => {
																			e.stopPropagation();
																			toggleDefault(tk);
																		}}
																		onKeyDown={(e) => {
																			if (e.key === "Enter" || e.key === " ") {
																				e.preventDefault();
																				e.stopPropagation();
																				toggleDefault(tk);
																			}
																		}}
																	>
																		{defaultOpen[tk] ? t("promptSourceCollapse") : t("promptSourceExpand")}
																	</span>
																)}
															</>
														) : (
															<span className="source-default-empty">{t("promptSourceDefaultEmpty")}</span>
														)}
													</div>
												</div>
											);
										}
										return (
											<div className="override-row" key={tk}>
												<div className="override-row-head">
													{`{{${tk}}}`}
													<span className="set-muted">
														{tt(`promptTok_${tk}`)} <HintTip text={tt(`promptTok_${tk}_desc`)} />
													</span>
													{v.trim() ? (
														<button type="button" className="set-btn-mini" onClick={() => resetOverride(tk)}>
															{t("promptResetSource")}
														</button>
													) : (
														<span className="set-muted">{t("promptAutoBadge")}</span>
													)}
												</div>
												{v.trim() || editing ? (
													<>
														<textarea
															className="set-prompt-input override-input"
															rows={Math.min(10, Math.max(1, v.split("\n").length))}
															autoFocus={editing}
															placeholder={t("promptOverridePlaceholder")}
															value={v}
															onFocus={(e) => {
																overrideFocus.current = tk;
																setEditingSource(tk);
																// 刚点预览载入默认文本时把光标放到末尾，方便直接接着改。
																const el = e.currentTarget as HTMLTextAreaElement;
																if (el.value && el.value === def)
																	el.setSelectionRange(el.value.length, el.value.length);
															}}
															onBlur={() => {
																if (overrideFocus.current === tk) overrideFocus.current = null;
																const val = promptOverridesDraft[tk] ?? "";
																if (val.trim() && val === def) {
																	// 点击预览载入默认后原样失焦（没改任何字）→ 不产生覆盖，仍用自动内容。
																	resetOverride(tk);
																	return;
																}
																commitOverride(tk);
																if (!val.trim()) setEditingSource(null);
															}}
															onChange={(e) => setPromptOverridesDraft((p) => ({ ...p, [tk]: e.target.value }))}
														/>
														{/* 编辑覆盖内容时，下方始终展示该来源的默认（自动）内容，方便对照/复制/只改一小部分。 */}
														<div className="override-edit-foot">
															<div className="override-edit-foot-head">
																<span className="set-muted">{t("promptSourceRefLabel")}</span>
																{isLong && (
																	<button
																		type="button"
																		className="source-default-toggle"
																		onClick={() => toggleDefault(tk)}
																	>
																		{defaultOpen[tk] ? t("promptSourceCollapse") : t("promptSourceExpand")}
																	</button>
																)}
															</div>
															{def.trim() ? (
																<pre
																	className={`source-default-text${
																		isLong ? (defaultOpen[tk] ? " expanded" : " clamped") : ""
																	}`}
																>
																	{def}
																</pre>
															) : (
																<span className="source-default-empty">{t("promptSourceDefaultEmpty")}</span>
															)}
															{!v.trim() && def.trim() && (
																<button
																	type="button"
																	className="override-seed-btn"
																	title={t("promptSourceSeedTip")}
																	onClick={() => seedFromDefault(tk, def)}
																>
																	{t("promptSourceSeedButton")}
																</button>
															)}
														</div>
													</>
												) : (
													// 未覆盖：行内展示默认（自动）内容；点击 = 载入默认文本开始编辑（不改就失焦则回到自动内容）。
													<div
														className="source-default"
														title={t("promptSourceDefaultEditHint")}
														role="button"
														tabIndex={0}
														onClick={() => seedFromDefault(tk, def)}
														onKeyDown={(e) => {
															if (e.key === "Enter" || e.key === " ") {
																e.preventDefault();
																seedFromDefault(tk, def);
															}
														}}
													>
														{def.trim() ? (
															<>
																<pre
																	className={`source-default-text${
																		isLong ? (defaultOpen[tk] ? " expanded" : " clamped") : ""
																	}`}
																>
																	{def}
																</pre>
																{isLong && (
																	<span
																		className="source-default-toggle"
																		role="button"
																		tabIndex={0}
																		onClick={(e) => {
																			e.stopPropagation();
																			toggleDefault(tk);
																		}}
																		onKeyDown={(e) => {
																			if (e.key === "Enter" || e.key === " ") {
																				e.preventDefault();
																				e.stopPropagation();
																				toggleDefault(tk);
																			}
																		}}
																	>
																		{defaultOpen[tk] ? t("promptSourceCollapse") : t("promptSourceExpand")}
																	</span>
																)}
															</>
														) : (
															<span className="source-default-empty">{t("promptSourceDefaultEmpty")}</span>
														)}
													</div>
												)}
											</div>
										);
									})}
									<div className="compose-toolbar">
										<button type="button" className="set-btn" onClick={resetAllPrompt} disabled={!hasPromptCustom}>
											{t("promptResetAll")}
										</button>
									</div>
								</div>
								<button
									type="button"
									className="set-view-prompt-btn"
									aria-expanded={showFullPrompt}
									onClick={() => setShowFullPrompt((v) => !v)}
								>
									{t("settingsViewPrompt")} {showFullPrompt ? "▴" : "▾"}
								</button>
								{showFullPrompt && (
									<div className="set-prompt-view">
										<div className="set-prompt-view-head">
											<span>{t("settingsViewPrompt")}</span>
											<HintTip text={t("settingsViewPromptHint")} />
											<CopyButton text={settings.effectiveSystemPrompt} />
										</div>
										{settings.effectiveSystemPrompt ? (
											<pre className="set-prompt-view-text">{settings.effectiveSystemPrompt}</pre>
										) : (
											<p className="set-empty">{t("settingsViewPromptEmpty")}</p>
										)}
									</div>
								)}
								<button
									type="button"
									className="set-view-prompt-btn"
									aria-expanded={showToolsSchema}
									onClick={() => setShowToolsSchema((v) => !v)}
								>
									{t("settingsViewToolsSchema")} {showToolsSchema ? "▴" : "▾"}
								</button>
								{showToolsSchema && (
									<div className="set-prompt-view">
										<div className="set-prompt-tools">
											<div className="set-prompt-view-head">
												<span>{t("settingsViewToolsSchema")}</span>
												<HintTip text={t("settingsViewToolsSchemaHint")} />
												<CopyButton text={settings.toolsSchema} />
											</div>
											{settings.toolsSchema ? (
												<pre className="set-prompt-view-text">{settings.toolsSchema}</pre>
											) : (
												<p className="set-empty">{t("settingsViewToolsSchemaEmpty")}</p>
											)}
										</div>
									</div>
								)}
							</div>
						)}

						{/* ---- AI 提交信息（SCM 面板的 scm_commitmsg 生成提示词） ---- */}
						{tab === "prompt" && !isDsh && (
							<div className="set-section">
								<div className="set-section-title">
									<FiGitBranch className="set-section-icon" />
									{t("scmCommitMsgSettingsTitle")}
									<HintTip text={t("scmCommitMsgSettingsDesc")} />
								</div>
								<FieldRow label={t("visionBridgePromptMode")}>
									<select
										className="set-select"
										value={scmMsgMode}
										onChange={(e) => {
											const mode = e.target.value as "append" | "replace";
											setScmMsgMode(mode);
											setPartial({ scmCommitMsgPromptMode: mode });
										}}
									>
										<option value="append">{t("promptModeAppend")}</option>
										<option value="replace">{t("promptModeReplace")}</option>
									</select>
								</FieldRow>
								<textarea
									className="set-prompt-input"
									rows={4}
									placeholder={t("scmCommitMsgPromptPlaceholder")}
									value={scmMsgDraft}
									onFocus={() => (scmMsgFocus.current = true)}
									onBlur={() => {
										scmMsgFocus.current = false;
										// 与系统提示词同一契约：replace 下未改动的内置默认存空（用默认）。
										const text =
											scmMsgMode === "replace" &&
											settings.scmCommitMsgDefaultPrompt &&
											scmMsgDraft === settings.scmCommitMsgDefaultPrompt
												? ""
												: scmMsgDraft;
										setPartial({
											scmCommitMsgPromptMode: scmMsgMode,
											scmCommitMsgPrompt: text,
										});
									}}
									onChange={(e) => setScmMsgDraft(e.target.value)}
								/>
								<p className="set-hint">{t("scmCommitMsgSettingsHint")}</p>
							</div>
						)}

						{/* ---- prompt history -------------------------------------------- */}
						{tab === "scheduler" && !isDsh && (
							<SchedulerPanel
								tasks={chat.schedulerTasks}
								cwd={chat.state?.cwd ?? ""}
								models={settings.subagentModels}
							/>
						)}
						{tab === "prompt-history" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiClock className="set-section-icon" />
									{t("settingsPromptHistory")}
									<HintTip text={t("settingsPromptHistoryDesc")} />
									<span className="set-count">{t("promptHistoryCount", { n: String(phCount) })}</span>
								</div>
								{phCount === 0 ? (
									<p className="set-empty">{t("promptHistoryEmpty")}</p>
								) : (
									<p className="set-hint">{t("promptHistoryCount", { n: String(phCount) })}</p>
								)}
								<FieldRow label={t("promptHistoryMax")} tip={t("promptHistoryMaxHint")} htmlFor="ph-max">
									<input
										id="ph-max"
										className="set-input"
										type="number"
										min={1}
										max={500}
										step={1}
										value={String(phSettings.maxEntries)}
										onChange={(e) => {
											const v = Math.floor(Number(e.target.value) || 0);
											const next = { ...phSettings, maxEntries: v };
											setPhSettings(next);
										}}
										onBlur={() => {
											const norm = { ...phSettings };
											if (!Number.isFinite(norm.maxEntries) || norm.maxEntries < 1) norm.maxEntries = 1;
											if (norm.maxEntries > 500) norm.maxEntries = 500;
											norm.maxEntries = Math.floor(norm.maxEntries);
											setPhSettings(norm);
											savePromptHistorySettings(norm);
											refreshPhCount();
										}}
									/>
								</FieldRow>
								<ToggleRow
									title={t("promptHistoryCharLimit")}
									tip={t("promptHistoryCharLimitHint")}
									enabled={phSettings.charLimitEnabled}
									onToggle={() => {
										const next = { ...phSettings, charLimitEnabled: !phSettings.charLimitEnabled };
										setPhSettings(next);
										savePromptHistorySettings(next);
										refreshPhCount();
									}}
								/>
								{phSettings.charLimitEnabled && (
									<FieldRow label={t("promptHistoryCharLimit")} htmlFor="ph-char-limit">
										<input
											id="ph-char-limit"
											className="set-input"
											type="number"
											min={100}
											max={20000}
											step={100}
											placeholder={t("promptHistoryCharLimitPlaceholder")}
											value={String(phSettings.charLimit)}
											onChange={(e) => {
												const v = Math.floor(Number(e.target.value) || 0);
												setPhSettings({ ...phSettings, charLimit: v });
											}}
											onBlur={() => {
												let v = Math.floor(Number(phSettings.charLimit) || 0);
												if (!Number.isFinite(v) || v < 100) v = 100;
												if (v > 20000) v = 20000;
												const norm = { ...phSettings, charLimit: v };
												setPhSettings(norm);
												savePromptHistorySettings(norm);
												refreshPhCount();
											}}
										/>
									</FieldRow>
								)}
								<div className="set-field" style={{ marginTop: 12 }}>
									<button
										type="button"
										className={`set-uninstall${phClearConfirm ? " confirm" : ""}`}
										disabled={phCount === 0}
										title={phCount === 0 ? t("promptHistoryEmpty") : t("promptHistoryClear")}
										onClick={() => {
											if (!phClearConfirm) {
												setPhClearConfirm(true);
												return;
											}
											clearPromptHistory();
											setPhClearConfirm(false);
											refreshPhCount();
										}}
									>
										<FiTrash2 /> {phClearConfirm ? t("promptHistoryClearConfirm") : t("promptHistoryClear")}
									</button>
									{phCount > 0 && (
										<span className="set-hint" style={{ marginLeft: 8 }}>
											{t("promptHistoryCount", { n: String(phCount) })}
										</span>
									)}
								</div>
								<p className="set-hint">
									<FiArchive style={{ verticalAlign: "-2px", marginRight: 4 }} />
									{t("settingsPromptHistoryDesc")}
								</p>
							</div>
						)}

						{/* ---- agent tools (unified tool_manage) ------------------------- */}
						{tab === "tools" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiTool className="set-section-icon" />
									{t("settingsTools")}
								</div>
								<div className="set-field-label">{t("toolsSectionTerminal")}</div>
								{TERMINAL_TOOL_NAMES.map((n) => (
									<ToggleRow
										key={n}
										title={n}
										tip={t("settingsTerminalToolsDesc")}
										enabled={!disabledTools.has(n)}
										onToggle={() => toggleAgentTool(n)}
									/>
								))}
								<ToggleRow
									title={t("terminalBashTakeover")}
									tip={t("terminalBashTakeoverDesc")}
									enabled={settings.terminalBash}
									onToggle={() => setPartial({ terminalBash: !settings.terminalBash })}
								/>
								{settings.terminalBash && (
									<FieldRow label={t("terminalBashIdleMs")} htmlFor="tb-idle-ms">
										<input
											id="tb-idle-ms"
											className="set-input"
											type="number"
											min={0}
											step={1000}
											value={idleMsDraft}
											onChange={(e) => setIdleMsDraft(e.target.value)}
											onBlur={() => {
												const n = Math.max(0, Math.floor(Number(idleMsDraft) || 0));
												setIdleMsDraft(String(n));
												if (n !== settings.terminalBashIdleMs) {
													setPartial({ terminalBashIdleMs: n });
												}
											}}
										/>
									</FieldRow>
								)}
								<div className="set-field-label">
									{t("toolsSectionSubagent")} <HintTip text={t("toolsSubagentDepHint")} />
								</div>
								{SUBAGENT_TOOL_NAMES.map((n) => (
									<ToggleRow
										key={n}
										title={n}
										tip={SUBAGENT_TOOL_TIPS[n]}
										enabled={!disabledTools.has(n)}
										onToggle={() => toggleAgentTool(n)}
									/>
								))}
								<div className="set-field-label">
									{t("settingsMarkers")}
									<HintTip text={`${t("settingsMarkersDesc")}\n${t("markerRenameTip")}`} />
								</div>
								<ToggleRow
									title={t("markersEnabled")}
									tip={`${t("markersEnabledDesc")}\n${t("markersOffHint")}`}
									enabled={markersEnabled}
									onToggle={() => setPartial({ markersEnabled: !markersEnabled })}
								/>
								{markersEnabled && (settings.markers?.length ?? 0) === 0 && (
									<p className="set-empty">{t("loading")}...</p>
								)}
								{markersEnabled &&
									settings.markers &&
									settings.markers.length > 0 &&
									settings.markers.map((m) => (
										<ToggleRow
											key={m.name}
											title={
												m.name === "todo"
													? t("markerGroupTodo")
													: m.name === "notify"
														? t("markerGroupNotify")
														: m.name === "conv"
															? t("markerGroupRename")
															: m.name
											}
											tip={m.guidance.join("\n")}
											enabled={m.enabled}
											onToggle={() => toggleMarker(m.name)}
										/>
									))}
								<ToggleRow
									title={MARKERS_LIST_TOOL_NAME}
									tip={`${t("todoListEnabledDesc")}\n${t("todoListOffHint")}`}
									enabled={!disabledTools.has(MARKERS_LIST_TOOL_NAME)}
									onToggle={() => toggleAgentTool(MARKERS_LIST_TOOL_NAME)}
								/>
								<div className="set-field-label">{t("toolsSectionOther")}</div>
								<ToggleRow
									title={EDIT_SOFT_TOOL_NAME}
									tip={`${t("editSoftEnabledDesc")}\n${t("editSoftOffHint")}`}
									enabled={!disabledTools.has(EDIT_SOFT_TOOL_NAME)}
									onToggle={() => toggleAgentTool(EDIT_SOFT_TOOL_NAME)}
								/>
								<ToggleRow
									title={DELEGATE_TASK_TOOL_NAME}
									tip={`${t("delegateTaskEnabledDesc")}\n${t("delegateTaskOffHint")}`}
									enabled={!disabledTools.has(DELEGATE_TASK_TOOL_NAME)}
									onToggle={() => toggleAgentTool(DELEGATE_TASK_TOOL_NAME)}
								/>
								<ToggleRow
									title={ASK_USER_QUESTION_TOOL_NAME}
									tip={`${t("questionnaireEnabledDesc")}\n${t("questionnaireOffHint")}`}
									enabled={!disabledTools.has(ASK_USER_QUESTION_TOOL_NAME)}
									onToggle={() => toggleAgentTool(ASK_USER_QUESTION_TOOL_NAME)}
								/>
								<ToggleRow
									title={BROWSER_PAGE_TOOL_NAME}
									tip={`${t("browserPageEnabledDesc")}\n${t("browserPageOffHint")}`}
									enabled={!disabledTools.has(BROWSER_PAGE_TOOL_NAME)}
									onToggle={() => toggleAgentTool(BROWSER_PAGE_TOOL_NAME)}
								/>
								<ToggleRow
									title={CONVERSATION_READ_TOOL_NAME}
									tip={`${t("conversationReadEnabledDesc")}\n${t("conversationReadOffHint")}`}
									enabled={!disabledTools.has(CONVERSATION_READ_TOOL_NAME)}
									onToggle={() => toggleAgentTool(CONVERSATION_READ_TOOL_NAME)}
								/>
								<ToggleRow
									title={SCHEDULE_TASK_TOOL_NAME}
									tip={`${t("scheduleTaskEnabledDesc")}\n${t("scheduleTaskOffHint")}`}
									enabled={!disabledTools.has(SCHEDULE_TASK_TOOL_NAME)}
									onToggle={() => toggleAgentTool(SCHEDULE_TASK_TOOL_NAME)}
								/>
								<ToggleRow
									title={SCHEDULE_LIST_TOOL_NAME}
									tip={`${t("scheduleTaskEnabledDesc")}\n${t("scheduleTaskOffHint")}`}
									enabled={!disabledTools.has(SCHEDULE_LIST_TOOL_NAME)}
									onToggle={() => toggleAgentTool(SCHEDULE_LIST_TOOL_NAME)}
								/>
								<ToggleRow
									title={SCHEDULE_CANCEL_TOOL_NAME}
									tip={`${t("scheduleTaskEnabledDesc")}\n${t("scheduleTaskOffHint")}`}
									enabled={!disabledTools.has(SCHEDULE_CANCEL_TOOL_NAME)}
									onToggle={() => toggleAgentTool(SCHEDULE_CANCEL_TOOL_NAME)}
								/>
								<div className="set-field-label">
									{t("toolsSectionPlugin")}
									<HintTip text={t("toolsPluginHint")} />
								</div>
								{pluginToolGroups.length === 0 ? (
									<p className="set-empty">{chat.plugins.length === 0 ? t("noUiPlugins") : t("pluginToolsEmpty")}</p>
								) : (
									pluginToolGroups.map((g) => (
										<div key={g.plugin.id}>
											<div className="set-row-desc">
												{g.plugin.icon ? `${g.plugin.icon} ` : ""}
												{g.plugin.name} · {g.plugin.id}
											</div>
											{g.tools.map((tool) => (
												<ToggleRow
													key={tool.name}
													title={tool.label && tool.label !== tool.name ? `${tool.label} (${tool.name})` : tool.name}
													tip={
														tool.description ? `${tool.description}\n${t("pluginToolOffHint")}` : t("pluginToolOffHint")
													}
													enabled={!disabledPluginTools.has(tool.name)}
													onToggle={() => togglePluginTool(tool.name)}
												/>
											))}
										</div>
									))
								)}
							</div>
						)}

						{/* ---- questionnaire (DSH only; pi moved into Tools) -------------- */}
						{tab === "question" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiHelpCircle className="set-section-icon" />
									{t("settingsQuestionnaire")}
								</div>
								<ToggleRow
									title={t("questionnaireEnabled")}
									tip={`${t("questionnaireEnabledDesc")}\n${t("questionnaireOffHint")}`}
									enabled={settings.questionnaireEnabled}
									onToggle={() => setPartial({ questionnaireEnabled: !settings.questionnaireEnabled })}
								/>
							</div>
						)}

						{/* ---- message display ----------------------------------------- */}
						{tab === "display" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiMessageSquare className="set-section-icon" />
									{t("settingsMessageDisplay")}
								</div>
								<FieldRow label={t("softCapTokens")} tip={t("softCapHint")} htmlFor="soft-cap-max">
									<input
										id="soft-cap-max"
										className="set-input"
										type="number"
										min={0}
										step={1000}
										placeholder={t("softCapOff")}
										value={softCapDraft}
										onChange={(e) => setSoftCapDraft(e.target.value)}
										onBlur={() => {
											const raw = softCapDraft.trim();
											const n = raw === "" ? 0 : Math.max(0, Math.floor(Number(raw) || 0));
											setSoftCapDraft(n > 0 ? String(n) : "");
											if (n !== (settings.softCapTokens ?? 0)) {
												setPartial({ softCapTokens: n });
											}
										}}
										onKeyDown={(e) => {
											if (e.key === "Enter") (e.target as HTMLInputElement).blur();
										}}
									/>
								</FieldRow>
								{/* 按模型覆盖：key = provider/id，优先于全局（issue #229）。 */}
								<div className="set-section-title">
									{t("softCapByModel")}
									<HintTip text={t("softCapByModelHint")} />
								</div>
								<div className="set-preset-save">
									<input
										className="set-input"
										placeholder={t("softCapModelId")}
										value={newCapModel}
										maxLength={200}
										onChange={(e) => setNewCapModel(e.target.value)}
									/>
									<input
										className="set-input"
										type="number"
										min={0}
										step={1000}
										placeholder={t("softCapTokens")}
										value={newCapTokens}
										onChange={(e) => setNewCapTokens(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Enter" && newCapModel.trim() && Math.floor(Number(newCapTokens)) > 0) {
												setPartial({
													softCapByModel: {
														...settings.softCapByModel,
														[newCapModel.trim()]: Math.floor(Number(newCapTokens)),
													},
												});
												setNewCapModel("");
												setNewCapTokens("");
											}
										}}
									/>
									<button
										type="button"
										className="set-save-btn"
										disabled={!newCapModel.trim() || !(Math.floor(Number(newCapTokens)) > 0)}
										onClick={() => {
											const id = newCapModel.trim();
											const n = Math.floor(Number(newCapTokens) || 0);
											if (!id || n <= 0) return;
											setPartial({ softCapByModel: { ...settings.softCapByModel, [id]: n } });
											setNewCapModel("");
											setNewCapTokens("");
										}}
									>
										<FiPlus /> {t("softCapAdd")}
									</button>
								</div>
								<div className="set-list">
									{Object.entries(settings.softCapByModel).map(([model, cap]) => (
										<div className="set-row" key={model}>
											<span className="set-row-name">{model}</span>
											<input
												className="set-input"
												type="number"
												min={0}
												step={1000}
												defaultValue={cap}
												key={`${model}:${cap}`}
												onBlur={(e) => {
													const n = Math.max(0, Math.floor(Number(e.target.value) || 0));
													const next = { ...settings.softCapByModel };
													if (n > 0) next[model] = n;
													else delete next[model];
													setPartial({ softCapByModel: next });
												}}
												onKeyDown={(e) => {
													if (e.key === "Enter") (e.target as HTMLInputElement).blur();
												}}
											/>
											<button
												type="button"
												className="chip"
												title={t("softCapRemove")}
												onClick={() => {
													const next = { ...settings.softCapByModel };
													delete next[model];
													setPartial({ softCapByModel: next });
												}}
											>
												<FiX /> {t("softCapRemove")}
											</button>
										</div>
									))}
								</div>
								<FieldRow label={t("modelRetryAttempts")} tip={t("modelRetryHint")} htmlFor="model-retry-max">
									<input
										id="model-retry-max"
										className="set-input"
										type="number"
										min={0}
										max={100}
										step={1}
										value={retryDraft}
										onChange={(e) => setRetryDraft(e.target.value)}
										onBlur={() => {
											const n = Math.min(100, Math.max(0, Math.floor(Number(retryDraft) || 0)));
											setRetryDraft(String(n));
											if (n !== settings.retryMaxAttempts) {
												setPartial({ retryMaxAttempts: n });
											}
										}}
										onKeyDown={(e) => {
											if (e.key === "Enter") (e.target as HTMLInputElement).blur();
										}}
									/>
								</FieldRow>
								<ToggleRow
									title={t("thinkingWrap")}
									tip={t("thinkingWrapDesc")}
									enabled={settings.thinkingWrap ?? true}
									onToggle={() => setPartial({ thinkingWrap: !(settings.thinkingWrap ?? true) })}
								/>
								<ToggleRow
									title={t("toolsWrap")}
									tip={t("toolsWrapDesc")}
									enabled={settings.toolsWrap ?? true}
									onToggle={() => setPartial({ toolsWrap: !(settings.toolsWrap ?? true) })}
								/>
								<ToggleRow
									title={t("parallelReminderEnabled")}
									tip={`${t("parallelReminderEnabledDesc")}\n${t("parallelReminderOffHint")}`}
									enabled={settings.parallelReminderEnabled ?? true}
									onToggle={() => setPartial({ parallelReminderEnabled: !(settings.parallelReminderEnabled ?? true) })}
								/>
								<ToggleRow
									title={t("devNoCache")}
									tip={t("devNoCacheDesc")}
									enabled={settings.devNoCache ?? true}
									onToggle={() => setPartial({ devNoCache: !(settings.devNoCache ?? true) })}
								/>
								<ToggleRow
									title={t("autoReload")}
									tip={t("autoReloadDesc")}
									enabled={settings.autoReload ?? true}
									onToggle={() => setPartial({ autoReload: !(settings.autoReload ?? true) })}
								/>
								<hr className="set-sep" />
								<ToggleRow
									title={t("wideChat")}
									tip={t("wideChatDesc")}
									enabled={wideChat}
									onToggle={() => saveChatWidthSettings({ wide: !wideChat })}
								/>
								<ToggleRow
									title={t("projectTitle")}
									tip={t("projectTitleDesc")}
									enabled={projectTitle}
									onToggle={() => saveTitleSettings({ projectName: !projectTitle })}
								/>
								<hr className="set-sep" />
								<div className="set-row">
									<div className="set-row-info">
										<div className="set-row-name">
											{t("wallpaperTitle")}
											<HintTip text={t("wallpaperDesc")} />
										</div>
										<div className="wallpaper-url-row">
											<input
												className="set-input wallpaper-url"
												placeholder={t("wallpaperUrlPh")}
												value={wallpaperDraft}
												maxLength={2000}
												spellCheck={false}
												onFocus={() => {
													wallpaperFocus.current = true;
												}}
												onChange={(e) => setWallpaperDraft(e.target.value)}
												onBlur={() => {
													wallpaperFocus.current = false;
													// 已上传的 data: 图不占输入框：空输入 = 未改动，不断然清空。
													if (!wallpaperDraft.trim() && wallpaper.url.startsWith("data:")) {
														setWallpaperDraft("");
														return;
													}
													const url = sanitizeWallpaperUrl(wallpaperDraft);
													setWallpaperDraft(url);
													if (url !== wallpaper.url) saveWallpaperSettings({ ...wallpaper, url });
												}}
												onKeyDown={(e) => {
													if (e.key === "Enter") (e.target as HTMLInputElement).blur();
													else if (e.key === "Escape") {
														setWallpaperDraft(wallpaper.url.startsWith("data:") ? "" : wallpaper.url);
														(e.target as HTMLInputElement).blur();
													}
												}}
											/>
											<button
												type="button"
												className="set-save-btn"
												disabled={wallpaperUploading}
												onClick={() => wallpaperFileRef.current?.click()}
											>
												<FiUpload /> {t("wallpaperUpload")}
											</button>
											<input
												ref={wallpaperFileRef}
												type="file"
												accept="image/*"
												hidden
												onChange={onPickWallpaperFile}
											/>
										</div>
										{wallpaperUploadError && <p className="set-hint">{t("wallpaperUploadFailed")}</p>}
										<div className="wallpaper-sliders">
											<label className="wallpaper-slider">
												<span>{t("wallpaperDim")}</span>
												<input
													type="range"
													min={0}
													max={95}
													step={1}
													value={wallpaper.dim}
													onChange={(e) => saveWallpaperSettings({ ...wallpaper, dim: Number(e.target.value) })}
												/>
												<output>{wallpaper.dim}%</output>
											</label>
											<label className="wallpaper-slider">
												<span>{t("wallpaperBlur")}</span>
												<input
													type="range"
													min={0}
													max={24}
													step={1}
													value={wallpaper.blur}
													onChange={(e) => saveWallpaperSettings({ ...wallpaper, blur: Number(e.target.value) })}
												/>
												<output>{wallpaper.blur}px</output>
											</label>
										</div>
									</div>
									{wallpaper.url && (
										<div className="wallpaper-current">
											<img className="wallpaper-preview" src={wallpaper.url} alt="" />
											<button
												type="button"
												className="wallpaper-clear"
												onClick={() => {
													setWallpaperDraft("");
													saveWallpaperSettings({ ...wallpaper, url: "" });
												}}
											>
												{t("wallpaperClear")}
											</button>
										</div>
									)}
								</div>
							</div>
						)}

						{/* ---- 快捷短语（输入框上方一键发送） ------------------------------ */}
						{tab === "quick" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiSend className="set-section-icon" />
									{t("quickPhrases")}
									<HintTip text={t("quickPhrasesDesc")} />
									<span className="set-count">{settings.quickPhrases.length}</span>
								</div>
								<ToggleRow
									title={t("quickPhrasesEnabled")}
									tip={t("quickPhrasesDesc")}
									enabled={settings.quickPhrasesEnabled}
									onToggle={() => setPartial({ quickPhrasesEnabled: !settings.quickPhrasesEnabled })}
								/>
								{!settings.quickPhrasesEnabled && <p className="set-hint">{t("quickPhrasesOffHint")}</p>}
								<div className="set-preset-save">
									<input
										className="set-input"
										placeholder={t("quickPhrasesPlaceholder")}
										value={quickNew}
										maxLength={200}
										onChange={(e) => setQuickNew(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Enter" && quickNew.trim()) {
												setPartial({ quickPhrases: [...settings.quickPhrases, quickNew.trim()] });
												setQuickNew("");
											}
										}}
									/>
									<button
										type="button"
										className="set-save-btn"
										disabled={!quickNew.trim()}
										onClick={() => {
											setPartial({ quickPhrases: [...settings.quickPhrases, quickNew.trim()] });
											setQuickNew("");
										}}
									>
										<FiPlus /> {t("quickPhrasesAdd")}
									</button>
								</div>
								{settings.quickPhrases.length === 0 ? (
									<p className="set-empty">{t("quickPhrasesEmpty")}</p>
								) : (
									<div className="set-list">
										{settings.quickPhrases.map((p, i) => (
											<div className="set-row" key={`${i}:${p}`}>
												{quickEdit?.index === i ? (
													<div className="set-row-info">
														<input
															className="set-input"
															autoFocus
															value={quickEdit.value}
															maxLength={200}
															placeholder={t("quickPhrasesEditPh")}
															onChange={(e) => setQuickEdit({ index: i, value: e.target.value })}
															onKeyDown={(e) => {
																if (e.key === "Enter") commitQuickEdit();
																else if (e.key === "Escape") setQuickEdit(null);
															}}
															onBlur={commitQuickEdit}
														/>
													</div>
												) : (
													<>
														<div className="set-row-info">
															<div className="set-row-name" title={p}>
																{p}
															</div>
														</div>
														<div className="set-row-actions">
															<button
																type="button"
																className="set-icon-btn"
																title={t("quickPhrasesEdit")}
																onClick={() => setQuickEdit({ index: i, value: p })}
															>
																<FiEdit3 />
															</button>
															<button
																type="button"
																className="set-icon-btn"
																title={t("quickPhrasesMoveUp")}
																disabled={i === 0}
																onClick={() => {
																	const next = [...settings.quickPhrases];
																	[next[i - 1], next[i]] = [next[i], next[i - 1]];
																	setPartial({ quickPhrases: next });
																}}
															>
																↑
															</button>
															<button
																type="button"
																className="set-icon-btn"
																title={t("quickPhrasesMoveDown")}
																disabled={i === settings.quickPhrases.length - 1}
																onClick={() => {
																	const next = [...settings.quickPhrases];
																	[next[i], next[i + 1]] = [next[i + 1], next[i]];
																	setPartial({ quickPhrases: next });
																}}
															>
																↓
															</button>
															<button
																type="button"
																className="set-icon-btn danger"
																title={t("quickPhrasesDelete")}
																onClick={() =>
																	setPartial({ quickPhrases: settings.quickPhrases.filter((_, j) => j !== i) })
																}
															>
																<FiTrash2 />
															</button>
														</div>
													</>
												)}
											</div>
										))}
									</div>
								)}
								<div className="compose-toolbar">
									<button
										type="button"
										className="dd-refresh"
										onClick={() => {
											setQuickEdit(null);
											setPartial({ quickPhrases: QUICK_PHRASE_DEFAULTS[locale] ?? QUICK_PHRASE_DEFAULTS.en });
										}}
									>
										{t("quickPhrasesReset")}
									</button>
								</div>
							</div>
						)}

						{/* ---- skills --------------------------------------------------- */}
						{tab === "skills" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiCpu className="set-section-icon" />
									{t("settingsSkills")}
									<HintTip text={`${t("skillFullTextLabel")}：${t("skillFullTextDesc")}`} />
									<span className="set-count">{settings.skills.length}</span>
								</div>
								{settings.skills.length === 0 ? (
									<p className="set-empty">{isDsh ? t("dshSkillsNote") : t("noSkills")}</p>
								) : (
									<div className="set-list">
										{settings.skills.map((s) => (
											<ToggleRow
												key={s.name}
												title={s.name}
												subtitle={s.description}
												enabled={s.enabled}
												onToggle={() => toggleSkill(s)}
												action={
													<button
														type="button"
														className={`tpl-chip${fullTextSkills.has(s.name) ? " on" : ""}`}
														title={t("skillFullTextDesc")}
														onClick={() => toggleSkillFullText(s.name)}
													>
														{t("skillFullTextShort")}
													</button>
												}
											/>
										))}
									</div>
								)}
							</div>
						)}

						{/* ---- extensions ------------------------------------------------ */}
						{tab === "extensions" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiPackage className="set-section-icon" />
									{t("settingsExtensions")}
									<span className="set-count">{settings.extensions.length}</span>
								</div>
								{settings.extensions.length === 0 ? (
									<p className="set-empty">{isDsh ? t("dshExtensionsNote") : t("noExtensions")}</p>
								) : (
									<div className="set-list">
										{settings.extensions.map((e) => {
											const pkgName = e.id.startsWith("npm:") ? e.id.slice(4) : null;
											return (
												<ToggleRow
													key={e.id}
													title={e.name}
													subtitle={e.path}
													enabled={e.enabled}
													onToggle={() => toggleExtension(e)}
													action={
														pkgName ? (
															confirmUninstall === e.id ? (
																<button
																	type="button"
																	className="set-uninstall confirm"
																	title={t("uninstallConfirmHint")}
																	onClick={() => runUninstall(pkgName)}
																>
																	{t("uninstallConfirm")}
																</button>
															) : (
																<button
																	type="button"
																	className="set-uninstall"
																	title={t("uninstallHint")}
																	onClick={() => setConfirmUninstall(e.id)}
																>
																	<FiTrash2 />
																	{t("uninstallExt")}
																</button>
															)
														) : undefined
													}
												/>
											);
										})}
									</div>
								)}
							</div>
						)}

						{/* ---- 插件市场（可一键安装的插件列表） ------------------------ */}
						{/* A managed instance installs software through its deploy, not
						    through this page: the market would only offer an action the
						    server refuses (server/managed.ts). Plugins already installed
						    keep working and stay listed above. */}
						{/* 界面布局（issue #146）：插件能整理任何条目（含宿主内置入口），但用户随时能改回来 ——
							    隐藏的条目仍可在顶栏溢出菜单里点到，改过的条目会显示「恢复」。 */}
						{tab === "layout" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiSliders className="set-section-icon" />
									{t("uiLayoutTitle")}
									<button type="button" className="set-uninstall" onClick={restoreUiAll}>
										{t("uiLayoutRestoreAll")}
									</button>
								</div>
								<div className="set-note">{t("uiLayoutHint")}</div>
								<input
									className="set-ui-filter"
									value={uiLayoutFilter}
									placeholder={t("uiLayoutSearch")}
									aria-label={t("uiLayoutSearch")}
									onChange={(e) => setUiLayoutFilter(e.target.value)}
								/>
								{uiLayoutSections.map(({ slot, labelKey }) => {
									const entries = (uiSlots[slot] ?? []).filter(
										(e) => isDsh || (e.id !== "host:composer-dsh-perm" && e.id !== "host:composer-dsh-preset"),
									);
									const q = uiLayoutFilter.trim().toLowerCase();
									// 按实际界面分组展示：顶栏/底栏/输入框动作区在界面上按对齐段
									// （左 start → 中 center → 右 end）分段渲染，布局页同口径按段
									// 列出（段头即界面上的段），↑↓ 只在段内移动；搜索时展平
									// （看到的是子集，此时 ↑↓ 禁用，免得挪了看不见的邻居）。
									const grouped = !q && uiAlignSlots.includes(slot);
									const segments: { align: string | null; items: UiSlotEntry[] }[] = grouped
										? (["start", "center", "end"] as const)
												.map((align) => ({ align, items: entries.filter((e) => e.align === align) }))
												.filter((g) => g.items.length > 0)
										: [
												{
													align: null,
													items: q
														? entries.filter((e) => `${e.label} ${e.id} ${e.source}`.toLowerCase().includes(q))
														: entries,
												},
											];
									const total = segments.reduce((n, g) => n + g.items.length, 0);
									// 搜索时藏掉无命中的分区（21 个分区全展开翻不动）。
									if (q && total === 0) return null;
									const renderRow = (it: UiSlotEntry, rowItems: UiSlotEntry[]) => {
										const idx = rowItems.findIndex((e) => e.id === it.id);
										const required = REQUIRED_TOPBAR_ITEM_IDS.has(it.id);
										return (
											<div key={it.id} className="set-row">
												<label className="set-toggle" title={required ? t("uiLayoutRequired") : it.id}>
													<input
														type="checkbox"
														checked={!it.hidden}
														disabled={required}
														onChange={() => toggleUiHidden(it)}
													/>
													<span>
														{it.icon ? `${it.icon} ` : ""}
														{it.label}
													</span>
												</label>
												<div className="set-row-actions">
													{it.arrangedBy.length > 0 && (
														<span className="set-ui-source" title={it.arrangedBy.join(", ")}>
															{t("uiLayoutArranged")}
														</span>
													)}
													{it.movedFrom && (
														<span className="set-ui-source" title={it.id}>
															{t("uiLayoutMovedFrom")}: {uiSlotTitle(it.movedFrom)}
														</span>
													)}
													{uiAlignSlots.includes(slot) && (
														<label className="set-ui-align" title={t("uiLayoutAlign")}>
															<select
																value={it.align}
																onChange={(e) => setUiAlign(it.id, e.target.value)}
																aria-label={t("uiLayoutAlign")}
															>
																<option value="start">start</option>
																<option value="center">center</option>
																<option value="end">end</option>
															</select>
														</label>
													)}
													<input
														key={`${it.id}:${layout?.labels?.[it.id] ?? ""}`}
														className="set-ui-label"
														defaultValue={layout?.labels?.[it.id] ?? ""}
														placeholder={t("uiLayoutRename")}
														title={t("uiLayoutRename")}
														aria-label={t("uiLayoutRename")}
														onBlur={(e) => {
															if (e.target.value !== (layout?.labels?.[it.id] ?? "")) setUiLabel(it.id, e.target.value);
														}}
														onKeyDown={(e) => {
															if (e.key === "Enter" && !e.nativeEvent.isComposing)
																(e.target as HTMLInputElement).blur();
														}}
													/>
													{it.userOverrides.length > 0 && (
														<button type="button" className="set-uninstall" onClick={() => restoreUi(it.id)}>
															{t("uiLayoutRestore")}
														</button>
													)}
													<button
														type="button"
														className="set-uninstall"
														disabled={!!q || idx <= 0}
														onClick={() => moveUiEntry(entries, rowItems, it.id, -1)}
													>
														↑
													</button>
													<button
														type="button"
														className="set-uninstall"
														disabled={!!q || idx < 0 || idx >= rowItems.length - 1}
														onClick={() => moveUiEntry(entries, rowItems, it.id, 1)}
													>
														↓
													</button>
												</div>
											</div>
										);
									};
									return (
										<div key={slot} className="set-ui-slot">
											<div className="set-ui-slot-title">{t(labelKey as Parameters<typeof t>[0])}</div>
											{/* 顶栏按钮文字总开关：关掉后顶栏只剩图标（角标保留，溢出菜单仍带文字）。 */}
											{slot === "topbar.primary" && (
												<label className="set-toggle" title="topbarText">
													<input
														type="checkbox"
														checked={layout?.topbarText !== false}
														onChange={(e) => setLayout({ topbarText: e.target.checked })}
													/>
													<span>{t("uiLayoutTopbarText")}</span>
												</label>
											)}
											{entries.length === 0 ? (
												<div className="set-empty">{t("uiLayoutEmpty")}</div>
											) : (
												segments.map((seg) => (
													<Fragment key={seg.align ?? "all"}>
														{seg.align && <div className="set-ui-slot-title set-ui-seg">{seg.align}</div>}
														{seg.items.map((it) => renderRow(it, seg.items))}
													</Fragment>
												))
											)}
										</div>
									);
								})}
							</div>
						)}
						{/* 插件目录授权（issue #146）：插件访问工作区外目录要经用户确认，
						    这里列出已授权目录并支持逐条撤销（插件自己也能 requestAccess）。 */}
						{tab === "plugins" && !managed && (
							<div className="set-subtabs" role="tablist">
								<button
									type="button"
									role="tab"
									aria-selected={pluginSub === "market"}
									className={`set-subtab${pluginSub === "market" ? " active" : ""}`}
									onClick={() => {
										setPluginSub("market");
										bodyRef.current?.scrollTo({ top: 0 });
									}}
								>
									{t("pluginMarket")}
									<span className="set-count">{chat.pluginCatalog.length}</span>
								</button>
								<button
									type="button"
									role="tab"
									aria-selected={pluginSub === "installed"}
									className={`set-subtab${pluginSub === "installed" ? " active" : ""}`}
									onClick={() => {
										setPluginSub("installed");
										bodyRef.current?.scrollTo({ top: 0 });
									}}
								>
									{t("pluginListTab")}
									<span className="set-count">{chat.plugins.length}</span>
								</button>
							</div>
						)}
						{tab === "plugins" && pluginSub === "installed" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiFolder className="set-section-icon" />
									{t("pluginGrantsTitle")}
									<span className="set-count">{chat.pluginGrants.reduce((n, g) => n + g.paths.length, 0)}</span>
								</div>
								<div className="set-note">{t("pluginGrantsHint")}</div>
								{chat.pluginGrants.length === 0 ? (
									<p className="set-empty">{t("pluginGrantsEmpty")}</p>
								) : (
									<div className="set-list">
										{chat.pluginGrants.map((g) => (
											<div key={g.pluginId} className="set-grant-row">
												<div className="set-catalog-title">
													<span>{g.pluginId}</span>
												</div>
												{g.paths.map((p) => (
													<div key={p} className="set-grant-path">
														<span className="set-catalog-source">{p}</span>
														<button
															type="button"
															className="set-uninstall"
															onClick={() => appSend({ type: "plugin_path_revoke", pluginId: g.pluginId, path: p })}
														>
															{t("pluginGrantsRevoke")}
														</button>
													</div>
												))}
											</div>
										))}
									</div>
								)}
							</div>
						)}
						{tab === "plugins" && pluginSub === "installed" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiKey className="set-section-icon" />
									{t("pluginPermsTitle")}
									<span className="set-count">{(chat.pluginPermissions ?? []).length}</span>
								</div>
								<div className="set-note">{t("pluginPermsHint")}</div>
								{(chat.pluginPermissions ?? []).length === 0 ? (
									<p className="set-empty">{t("pluginPermsEmpty")}</p>
								) : (
									<div className="set-list">
										{(chat.pluginPermissions ?? []).map((g, i) => (
											<div key={`${g.pluginId}|${g.family}|${i}`} className="set-grant-row">
												<div className="set-catalog-title">
													<span>{g.pluginId}</span>
													<span className="set-catalog-source">
														{g.family === "net" ? t("pluginPermNet") : t("pluginPermLlm")}
														{g.session ? ` · ${t("pluginPermSession")}` : ""}
													</span>
												</div>
												{(g.hosts ?? []).map((h) => (
													<div key={h} className="set-grant-path">
														<span className="set-catalog-source">{h}</span>
														<button
															type="button"
															className="set-uninstall"
															onClick={() =>
																appSend({
																	type: "plugin_permission_revoke",
																	pluginId: g.pluginId,
																	family: "net",
																	host: h,
																})
															}
														>
															{t("pluginGrantsRevoke")}
														</button>
													</div>
												))}
												{(g.models ?? []).map((m) => (
													<div key={m} className="set-grant-path">
														<span className="set-catalog-source">{m}</span>
														<button
															type="button"
															className="set-uninstall"
															onClick={() =>
																appSend({
																	type: "plugin_permission_revoke",
																	pluginId: g.pluginId,
																	family: "llm",
																	model: m,
																})
															}
														>
															{t("pluginGrantsRevoke")}
														</button>
													</div>
												))}
												{!(g.hosts ?? []).length && !(g.models ?? []).length && (
													<div className="set-grant-path">
														<span className="set-catalog-source">{g.reason ?? t("pluginPermUnscoped")}</span>
														<button
															type="button"
															className="set-uninstall"
															onClick={() =>
																appSend({ type: "plugin_permission_revoke", pluginId: g.pluginId, family: g.family })
															}
														>
															{t("pluginGrantsRevoke")}
														</button>
													</div>
												)}
												{g.reason && ((g.hosts ?? []).length > 0 || (g.models ?? []).length > 0) && (
													<div className="set-note">{g.reason}</div>
												)}
											</div>
										))}
									</div>
								)}
							</div>
						)}
						{tab === "plugins" && managed && (
							<div className="set-section">
								<div className="set-note">{t("updatesManaged")}</div>
							</div>
						)}
						{tab === "plugins" && !managed && pluginSub === "market" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiPackage className="set-section-icon" />
									{t("pluginMarket")}
									<span className="set-count">{chat.pluginCatalog.length}</span>
								</div>
								<div className="set-toolbar">
									<label className="set-catalog-build" title={t("pluginBuildHint")}>
										<input type="checkbox" checked={catBuild} onChange={(ev) => setCatBuild(ev.target.checked)} />
										{t("pluginBuildSource")}
									</label>
									<button
										type="button"
										className="set-uninstall"
										title={t("pluginCatalogSyncHint")}
										onClick={() => setShowCatSync((v) => !v)}
									>
										<FiRefreshCw />
										{t("pluginCatalogSync")}
									</button>
									<button
										type="button"
										className="set-uninstall"
										title={t("pluginCatalogAddHint")}
										onClick={() => setShowCatAdd((v) => !v)}
									>
										<FiPlus />
										{t("pluginCatalogAdd")}
									</button>
								</div>
								{showCatSync && (
									<div className="set-catalog-add">
										<div className="set-note">{t("pluginCatalogSyncHint")}</div>
										<input
											className="set-input"
											placeholder={t("pluginCatalogSyncSource")}
											value={catSyncSource}
											onChange={(ev) => setCatSyncSource(ev.target.value)}
											onKeyDown={(ev) => {
												if (ev.key === "Enter") runCatalogSync(catSyncSource);
											}}
										/>
										<label className="set-catalog-build" title={t("pluginCatalogSyncInstall")}>
											<input
												type="checkbox"
												checked={catSyncInstall}
												onChange={(ev) => setCatSyncInstall(ev.target.checked)}
											/>
											{t("pluginCatalogSyncInstall")}
										</label>
										<label className="set-catalog-build" title={t("pluginCatalogSyncReplace")}>
											<input
												type="checkbox"
												checked={catSyncReplace}
												onChange={(ev) => setCatSyncReplace(ev.target.checked)}
											/>
											{t("pluginCatalogSyncReplace")}
										</label>
										{catSyncRecent.length > 0 && (
											<div className="set-catalog-recent">
												<span className="set-catalog-recent-label">{t("pluginCatalogSyncRecent")}</span>
												{catSyncRecent.map((u) => (
													<button
														key={u}
														type="button"
														className="set-catalog-recent-item"
														title={u}
														onClick={() => {
															setCatSyncSource(u);
															runCatalogSync(u);
														}}
													>
														{u}
													</button>
												))}
											</div>
										)}
										<div className="set-catalog-add-actions">
											<button
												type="button"
												className="set-uninstall confirm"
												disabled={!catSyncSource.trim()}
												onClick={() => runCatalogSync(catSyncSource)}
											>
												{t("pluginCatalogSyncSubmit")}
											</button>
											<button type="button" className="set-uninstall" onClick={() => setShowCatSync(false)}>
												{t("cancel")}
											</button>
										</div>
										{syncReceipt &&
											(syncReceipt.ok ? (
												<div className="set-catalog-job ok">
													<span>
														✓ {t("pluginCatalogSyncOk", { n: syncReceipt.entryCount ?? 0 })}
														{syncReceipt.installed
															? ` · ${t("pluginCatalogSyncInstalled", {
																	ok: syncReceipt.installed.filter((i) => i.ok).length,
																	fail: syncReceipt.installed.filter((i) => !i.ok).length,
																})}`
															: null}
													</span>
													{syncReceipt.installed?.some((i) => !i.ok) && (
														<pre className="set-catalog-job-out">
															{syncReceipt.installed
																.filter((i) => !i.ok)
																.map((i) => `${i.id}：${i.error ?? "?"}`)
																.join("\n")}
														</pre>
													)}
												</div>
											) : (
												<div className="set-catalog-job error">
													<span>✗ {syncReceipt.error || t("pluginJobFailed")}</span>
												</div>
											))}
									</div>
								)}
								{showCatAdd && (
									<div className="set-catalog-add">
										<input
											className="set-input"
											placeholder={t("pluginCatalogSource")}
											value={catSource}
											onChange={(ev) => setCatSource(ev.target.value)}
										/>
										<input
											className="set-input"
											placeholder={t("pluginCatalogId")}
											value={catId}
											onChange={(ev) => setCatId(ev.target.value)}
										/>
										<input
											className="set-input"
											placeholder={t("pluginCatalogName")}
											value={catName}
											onChange={(ev) => setCatName(ev.target.value)}
										/>
										<input
											className="set-input"
											placeholder={t("pluginCatalogIcon")}
											value={catIcon}
											onChange={(ev) => setCatIcon(ev.target.value)}
										/>
										<textarea
											className="set-input"
											rows={2}
											placeholder={t("pluginCatalogDesc")}
											value={catDesc}
											onChange={(ev) => setCatDesc(ev.target.value)}
										/>
										<div className="set-catalog-add-actions">
											<button
												type="button"
												className="set-uninstall confirm"
												disabled={!catSource.trim()}
												onClick={submitCatalogAdd}
											>
												{t("pluginCatalogAddSubmit")}
											</button>
											<button type="button" className="set-uninstall" onClick={() => setShowCatAdd(false)}>
												{t("cancel")}
											</button>
										</div>
									</div>
								)}
								{chat.pluginCatalog.length === 0 ? (
									<p className="set-empty">{t("noPluginCatalog")}</p>
								) : (
									<div className="set-list set-list-flat">
										{chat.pluginCatalog.map((e) => {
											const installed = installedPluginIds.has(e.id);
											return (
												<div key={e.id} className="set-catalog-row">
													<div className="set-catalog-main">
														<div className="set-catalog-title">
															<span>
																<PluginIcon icon={e.icon} iconSvg={e.iconSvg} /> {e.name}
															</span>
															{installed && <span className="set-catalog-installed">{t("pluginInstalled")}</span>}
															{!e.builtin && <span className="set-catalog-custom">{t("pluginCatalogCustom")}</span>}
														</div>
														{e.description && <div className="set-catalog-desc">{e.description}</div>}
														<div className="set-catalog-source">{e.source}</div>
														{renderJobStatus(e.id)}
													</div>
													<div className="set-row-actions">
														{installed ? (
															<>
																<button
																	type="button"
																	className="set-uninstall"
																	title={t("pluginUpdateHint")}
																	onClick={() => runUiPluginUpdate(e.id, e.source)}
																>
																	<FiRefreshCw />
																	{t("pluginUpdate")}
																</button>
																{confirmUiUninstall === e.id ? (
																	<button
																		type="button"
																		className="set-uninstall confirm"
																		title={t("pluginUninstallHint")}
																		onClick={() => runUiPluginUninstall(e.id)}
																	>
																		{t("uninstallConfirm")}
																	</button>
																) : (
																	<button
																		type="button"
																		className="set-uninstall"
																		title={t("pluginUninstallHint")}
																		onClick={() => setConfirmUiUninstall(e.id)}
																	>
																		<FiTrash2 />
																		{t("uninstallExt")}
																	</button>
																)}
															</>
														) : (
															<button
																type="button"
																className="set-uninstall"
																title={t("pluginInstallHint")}
																onClick={() => runCatalogInstall(e)}
															>
																<FiDownload />
																{t("pluginInstall")}
															</button>
														)}
														{!e.builtin && (
															<button
																type="button"
																className="set-uninstall"
																title={t("pluginCatalogRemoveHint")}
																onClick={() => runCatalogRemove(e.id)}
															>
																<FiX />
															</button>
														)}
													</div>
												</div>
											);
										})}
									</div>
								)}
							</div>
						)}

						{/* ---- UI plugins（<dataDir>/plugins，纯 UI 隐藏） ----------------- */}
						{tab === "plugins" && pluginSub === "installed" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiBox className="set-section-icon" />
									{t("pluginListTab")}
									<span className="set-count">{chat.plugins.length}</span>
									<button
										type="button"
										className="set-uninstall"
										title={t("pluginRescanHint")}
										onClick={() => appSend({ type: "plugins_reload" })}
									>
										<FiRefreshCw />
										{t("pluginRescan")}
									</button>
								</div>
								{chat.plugins.length > 0 && (
									<PluginInventoryStrip plugins={chat.plugins} disabledIds={disabledPlugins} />
								)}
								{chat.plugins.length === 0 ? (
									<p className="set-empty">{t("noUiPlugins")}</p>
								) : (
									<div className="set-list set-list-flat">
										{chat.plugins.map((p) => (
											<>
												<ToggleRow
													key={p.id}
													title={
														<>
															<InvDot
																phase={pluginPhase(p, disabledPlugins.has(p.id))}
																label={tt(phaseLabelKey(pluginPhase(p, disabledPlugins.has(p.id))))}
															/>
															<PluginIcon icon={p.icon} iconSvg={p.iconSvg} /> {p.name}
														</>
													}
													subtitle={
														(p.error
															? `${p.id} · ${p.error}`
															: p.source
																? `${p.id} · ${p.source}`
																: `${p.id} · ${t("uiPluginNoSource")}`) +
														(p.permissions?.length ? ` · ${t("uiPluginPerms")}: ${p.permissions.join(", ")}` : "")
													}
													enabled={!disabledPlugins.has(p.id) && !p.error}
													onToggle={() => !p.error && togglePlugin(p)}
													action={
														<div className="set-row-actions">
															{p.source && (
																<button
																	type="button"
																	className="set-uninstall"
																	title={t("pluginUpdateHint")}
																	onClick={() => runUiPluginUpdate(p.id, p.source!)}
																>
																	<FiRefreshCw />
																	{t("pluginUpdate")}
																</button>
															)}
															{confirmUiUninstall === p.id ? (
																<button
																	type="button"
																	className="set-uninstall confirm"
																	title={t("pluginUninstallHint")}
																	onClick={() => runUiPluginUninstall(p.id)}
																>
																	{t("uninstallConfirm")}
																</button>
															) : (
																<button
																	type="button"
																	className="set-uninstall"
																	title={t("pluginUninstallHint")}
																	onClick={() => setConfirmUiUninstall(p.id)}
																>
																	<FiTrash2 />
																	{t("uninstallExt")}
																</button>
															)}
														</div>
													}
												/>
												{/* 注册的 AI 工具开关统一收口到「工具」tab 汇总区，这里只保留一行入口（免得已装列表太长；DSH 无工具 tab 则不显示） */}
												{p.agentTools && p.agentTools.length > 0 && !isDsh && (
													<div className="set-row" title={t("pluginToolOffHint")}>
														<span className="set-ui-source">
															{t("pluginToolsSection")} ({p.agentTools.length})
															{p.agentTools.some((tool) => disabledPluginTools.has(tool.name))
																? ` · ${t("settingsDisabled")}`
																: ""}
														</span>
														<div className="set-row-actions">
															<button type="button" className="set-uninstall" onClick={() => setTab("tools")}>
																{t("settingsTools")} →
															</button>
														</div>
													</div>
												)}
												{/* 运行时日志：host.log 分级缓冲，按需拉取（不进快照），与诊断互不干扰 */}
												<div className="set-row set-log-row">
													<button
														type="button"
														className="set-diag-toggle"
														onClick={() => {
															if (logOpen === p.id) setLogOpen(null);
															else {
																setLogOpen(p.id);
																appSend(pluginLogsFetch(p.id));
															}
														}}
													>
														<FiFileText />
														{t("pluginLogTitle")} ({getPluginLogs(p.id).length}) ·{" "}
														{logOpen === p.id ? t("pluginLogHide") : t("pluginLogShow")}
													</button>
													{logOpen === p.id && <PluginLogView pluginId={p.id} />}
												</div>
												{/* 诊断记录：manifest/ui 解析丢弃原因 + 运行时 warning/error 摘要 */}
												{p.diagnostics && p.diagnostics.length > 0 && (
													<div className="set-row set-diag-row">
														<button
															type="button"
															className="set-diag-toggle"
															onClick={() => setDiagOpen(diagOpen === p.id ? null : p.id)}
														>
															<FiAlertTriangle />
															{t("pluginDiagTitle")} ({p.diagnostics.length}) ·{" "}
															{diagOpen === p.id ? t("pluginDiagHide") : t("pluginDiagShow")}
														</button>
														{diagOpen === p.id && (
															<ul className="set-diag-list">
																{p.diagnostics.map((d, i) => (
																	<li key={`${p.id}-${i}`}>{d}</li>
																))}
															</ul>
														)}
													</div>
												)}
												{/* 特权 DOM：声明了 dom 能力的插件，bundle 默认 403，需用户逐个授权 */}
												{p.wantsDom && (
													<div className="set-row" title={t("pluginDomDesc")}>
														<span className="set-ui-source">
															{p.domGranted ? t("pluginDomGranted") : t("pluginDomNeed")}
														</span>
														<div className="set-row-actions">
															<button
																type="button"
																className={`set-uninstall${p.domGranted ? "" : " confirm"}`}
																title={t("pluginDomDesc")}
																onClick={() =>
																	appSend({
																		type: "plugin_dom_consent",
																		pluginId: p.id,
																		granted: !p.domGranted,
																	})
																}
															>
																{p.domGranted ? t("pluginDomRevoke") : t("pluginDomGrant")}
															</button>
														</div>
													</div>
												)}
												{/* 声明式设置：manifest settings schema → 自动渲染表单 */}
												{p.settingsSchema && p.settingsSchema.length > 0 && <PluginSettingsForm plugin={p} />}
											</>
										))}
									</div>
								)}
							</div>
						)}

						{/* ---- DSH 用户补丁（<dataDir>/dsh-patches，仅 dsh 引擎） ---------- */}
						{tab === "plugins" && isDsh && pluginSub === "installed" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiBox className="set-section-icon" />
									{t("dshPatches")}
									<HintTip text={t("dshPatchesDesc")} />
									<span className="set-count">{chat.dshPatches?.files.length ?? 0}</span>
									<button
										type="button"
										className="set-uninstall"
										title={t("dshPatchesRescanHint")}
										onClick={() => appSend({ type: "dsh_patches_rescan" })}
									>
										<FiRefreshCw />
										{t("dshPatchesRescan")}
									</button>
								</div>
								{(chat.dshPatches?.files.length ?? 0) === 0 ? (
									<p className="set-empty">{t("dshPatchesEmpty")}</p>
								) : (
									<div className="set-list">
										{chat.dshPatches!.files.map((f) => (
											<div className="set-row" key={f.name}>
												<div className="set-row-info">
													<div className="set-row-name">{f.name}</div>
													<div className="set-row-desc">
														{formatBytes(f.size)} · {new Date(f.mtimeMs).toLocaleString()}
													</div>
												</div>
											</div>
										))}
									</div>
								)}
								<p className="set-hint">
									{t("dshPatchesPath")} {chat.dshPatches?.patchDir ?? ""}
								</p>
							</div>
						)}

						{/* ---- goal review ----------------------------------------------- */}
						{tab === "review" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiZap className="set-section-icon" />
									{t("settingsReview")}
									<HintTip text={t("settingsReviewDesc")} />
									<span className="set-count">{settings.reviewSkills.length}</span>
								</div>
								<ToggleRow
									title={t("goalModeEnabled")}
									tip={`${t("goalModeEnabledDesc")}\n${t("goalModeOffHint")}`}
									enabled={settings.goalModeEnabled}
									onToggle={() => setPartial({ goalModeEnabled: !settings.goalModeEnabled })}
								/>
								<textarea
									className="set-prompt-input"
									rows={5}
									placeholder={t("reviewPromptPlaceholder")}
									value={reviewPromptDraft}
									onFocus={() => (reviewPromptFocus.current = true)}
									onBlur={() => {
										reviewPromptFocus.current = false;
										setPartial({ reviewPrompt: reviewPromptDraft });
									}}
									onChange={(e) => setReviewPromptDraft(e.target.value)}
								/>
								<div className="set-field-label">
									{t("settingsReviewSkills")}
									{isDsh && (
										<>
											{" "}
											<HintTip text={t("dshReviewPromptNote")} />
										</>
									)}
								</div>
								{settings.reviewSkills.length === 0 ? (
									<p className="set-empty">{t("noSkills")}</p>
								) : (
									<div className="set-list">
										{settings.reviewSkills.map((s) => (
											<ToggleRow
												key={`review-${s.name}`}
												title={s.name}
												subtitle={s.description}
												enabled={s.enabled}
												onToggle={() => toggleReviewSkill(s)}
											/>
										))}
									</div>
								)}
							</div>
						)}

						{/* ---- vision bridge ---------------------------------------------- */}
						{tab === "vision" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiEye className="set-section-icon" />
									{t("settingsVisionBridge")}
								</div>
								<ToggleRow
									title={t("visionBridgeEnabled")}
									tip={`${t("settingsVisionBridgeDesc")}\n${t("visionBridgeOffHint")}`}
									enabled={settings.visionBridgeEnabled}
									onToggle={() => setPartial({ visionBridgeEnabled: !settings.visionBridgeEnabled })}
								/>
								{settings.visionBridgeEnabled && (
									<FieldRow label={t("visionBridgeModel")}>
										<select
											className="set-select"
											value={settings.visionBridgeModel ?? ""}
											onChange={(e) => setPartial({ visionBridgeModel: e.target.value || null })}
										>
											<option value="">{t("visionBridgeAuto")}</option>
											{settings.visionModels.map((m) => (
												<option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
													{m.label}
												</option>
											))}
										</select>
									</FieldRow>
								)}
								{settings.visionBridgeEnabled && (
									<FieldRow label={t("visionBridgePromptMode")}>
										<select
											className="set-select"
											value={vbPromptMode}
											onChange={(e) => {
												const mode = e.target.value as "append" | "replace";
												setVbPromptMode(mode);
												setPartial({ visionBridgePromptMode: mode });
											}}
										>
											<option value="append">{t("promptModeAppend")}</option>
											<option value="replace">{t("promptModeReplace")}</option>
										</select>
									</FieldRow>
								)}
								{settings.visionBridgeEnabled && (
									<textarea
										className="set-prompt-input"
										rows={4}
										placeholder={t("visionBridgePromptPlaceholder")}
										value={vbPromptDraft}
										onFocus={() => (vbPromptFocus.current = true)}
										onBlur={() => {
											vbPromptFocus.current = false;
											// Same contract as the system prompt: an unmodified copy of
											// the built-in default is stored as empty (use default).
											const text =
												vbPromptMode === "replace" &&
												settings.visionBridgeDefaultPrompt &&
												vbPromptDraft === settings.visionBridgeDefaultPrompt
													? ""
													: vbPromptDraft;
											setPartial({
												visionBridgePromptMode: vbPromptMode,
												visionBridgePrompt: text,
											});
										}}
										onChange={(e) => setVbPromptDraft(e.target.value)}
									/>
								)}
								{settings.visionBridgeEnabled &&
									(settings.visionModels.length === 0 ? (
										<p className="set-hint">{t("visionBridgeNoModels")}</p>
									) : (
										<p className="set-hint">
											{t("visionBridgeCurrent", {
												model: settings.visionBridgeModel ?? t("visionBridgeAuto"),
											})}
										</p>
									))}
							</div>
						)}

						{tab === "presets" && isDsh && chat.dshPresets && chat.dshPresets.presets.length > 0 && (
							<div className="set-section">
								<div className="set-section-title">
									<FiCpu className="set-section-icon" />
									{t("dshPreset")}
									<HintTip text={t("dshDefaultPresetDesc")} />
									<span className="set-count">{chat.dshPresets.presets.length}</span>
								</div>
								<div className="set-mode-row">
									<label className="set-field-label">{t("dshDefaultPreset")}</label>
									<select
										className="set-select"
										value={chat.dshPresets.defaultPreset}
										onChange={(e) => appSend({ type: "dsh_preset_default", preset: e.target.value })}
									>
										{sortAgentPresets(chat.dshPresets.presets).map((p) => (
											<option key={p.id} value={p.id} disabled={!!p.broken}>
												{p.name ?? p.id}
												{p.trust === "user" ? ` · ${t("dshPresetUser")}` : ""}
											</option>
										))}
									</select>
								</div>
								<div className="set-list">
									{sortAgentPresets(chat.dshPresets.presets).map((p) => (
										<div className="set-row" key={p.id}>
											<div className="set-row-info">
												<div className="set-row-name">
													{p.name ?? p.id}
													{p.trust === "user" && <span className="dd-preset-tag">{t("dshPresetUser")}</span>}
													{p.id === chat.dshPresets!.defaultPreset && (
														<span className="dd-preset-tag">{t("dshPresetDefaultTag")}</span>
													)}
													{p.broken && <span className="dd-preset-tag warn">{t("dshPresetBroken")}</span>}
												</div>
												{p.description && !p.broken && <div className="set-row-desc">{p.description}</div>}
												{p.broken && <div className="set-row-desc">{p.broken}</div>}
											</div>
										</div>
									))}
								</div>
								<p className="set-hint">{t("dshPresetUserNote")}</p>
							</div>
						)}
						{tab === "presets" && isDsh && chat.dshPermission && chat.dshPermission.options.length > 0 && (
							<div className="set-section">
								<div className="set-section-title">
									<FiShield className="set-section-icon" />
									{t("dshPerm")}
									<HintTip text={t("dshPermDefaultDesc")} />
								</div>
								<div className="set-mode-row">
									<label className="set-field-label">{t("dshPermDefault")}</label>
									<select
										className="set-select"
										value={chat.dshPermission.defaultPreset}
										onChange={(e) => appSend({ type: "dsh_permission_default", preset: e.target.value })}
									>
										{DSH_PERMISSION_ORDER.filter((v) => chat.dshPermission!.options.some((o) => o.value === v)).map(
											(v) => (
												<option key={v} value={v}>
													{t(permLabelKey(v))}
												</option>
											),
										)}
									</select>
								</div>
								<div className="set-list">
									{DSH_PERMISSION_ORDER.filter((v) => chat.dshPermission!.options.some((o) => o.value === v)).map(
										(v) => (
											<div className="set-row" key={v}>
												<div className="set-row-info">
													<div className="set-row-name">
														{t(permLabelKey(v))}
														{v === chat.dshPermission!.defaultPreset && (
															<span className="dd-preset-tag">{t("dshPresetDefaultTag")}</span>
														)}
													</div>
													<div className="set-row-desc">{t(permDescKey(v))}</div>
												</div>
											</div>
										),
									)}
								</div>
							</div>
						)}
						{tab === "presets" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiSettings className="set-section-icon" />
									{t("settingsPresets")}
									<span className="set-count">{settings.presets.length}</span>
								</div>
								<div className="set-preset-save">
									<input
										className="set-input"
										placeholder={t("presetNamePlaceholder")}
										value={presetName}
										onChange={(e) => setPresetName(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Enter" && presetName.trim()) {
												appSend({ type: "save_preset", name: presetName.trim() });
												setPresetName("");
											}
										}}
									/>
									<button
										type="button"
										className="set-save-btn"
										disabled={!presetName.trim()}
										onClick={() => {
											appSend({ type: "save_preset", name: presetName.trim() });
											setPresetName("");
										}}
									>
										<FiPlus /> {t("saveAsPreset")}
									</button>
								</div>
								{settings.presets.length === 0 ? (
									<p className="set-empty">{t("noPresets")}</p>
								) : (
									<div className="set-list">
										{settings.presets.map((p) => (
											<div className="set-row" key={p.name}>
												<div className="set-row-info">
													<div className="set-row-name">{p.name}</div>
													<div className="set-row-desc">
														{p.promptMode === "replace" ? t("promptModeReplace") : t("promptModeAppend")}
														{p.disabledSkills.length > 0 && ` · ${t("settingsSkills")} ${p.disabledSkills.length}`}
														{p.disabledExtensions.length > 0 &&
															` · ${t("settingsExtensions")} ${p.disabledExtensions.length}`}
													</div>
												</div>
												<div className="set-row-actions">
													<button
														type="button"
														className="set-uninstall"
														onClick={() => appSend({ type: "apply_preset", name: p.name })}
													>
														{t("applyPreset")}
													</button>
													<button
														type="button"
														className="set-icon-btn danger"
														title={t("deletePreset")}
														onClick={() => appSend({ type: "delete_preset", name: p.name })}
													>
														<FiTrash2 />
													</button>
												</div>
											</div>
										))}
									</div>
								)}
							</div>
						)}

						{/* ---- subagent templates（全局共享；DSH 引擎隐藏该分区） ---------- */}
						{tab === "subagent-templates" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiUsers className="set-section-icon" />
									{t("settingsSubagentTemplates")}
									<HintTip text={t("settingsSubagentTemplatesDesc")} />
									<span className="set-count">{settings.subagentTemplates.length}</span>
									<button
										type="button"
										className="set-save-btn"
										title={t("subagentTemplateNew")}
										onClick={() => {
											setTplDraft({
												name: "",
												description: "",
												promptMode: "replace",
												systemPrompt: "",
												enabledSkills: [],
												enabledExtensions: [],
												model: "",
												thinkingLevel: "",
												enabled: true,
											});
											setTplIsNew(true);
										}}
									>
										<FiPlus /> {t("subagentTemplateNew")}
									</button>
								</div>

								{/* ---- 默认模型：全部子代理的兜底（模板/显式 model 参数优先） ---------- */}
								<FieldRow label={t("subagentDefaultModelLabel")} tip={t("subagentDefaultModelHint")}>
									<select
										className="set-select"
										value={settings.subagentDefaultModel ?? ""}
										onChange={(e) => setPartial({ subagentDefaultModel: e.target.value || null })}
									>
										<option value="">{t("subagentFollowMain")}</option>
										{settings.subagentModels.map((m) => (
											<option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
												{m.label}
											</option>
										))}
									</select>
								</FieldRow>
								{settings.subagentModels.length === 0 && <p className="set-hint">{t("subagentNoModels")}</p>}

								{/* ---- 编辑器：独立弹窗（新建 / 编辑同表单，列表页保持干净） ---------- */}
								{tplDraft && (
									<div className="modal-backdrop tpl-modal-backdrop" onClick={() => setTplDraft(null)}>
										<div className="modal tpl-modal" onClick={(e) => e.stopPropagation()}>
											<button
												type="button"
												className="modal-close"
												aria-label={t("close")}
												onClick={() => setTplDraft(null)}
											>
												<FiX />
											</button>
											<div className="modal-head">
												<FiUsers className="modal-head-icon" />
												<h2>
													{tplIsNew ? t("subagentTemplateNew") : `${t("subagentTemplateEdit")} · ${tplDraft.name}`}
												</h2>
											</div>
											<div className="modal-body">
												<div className="tpl-fields">
													<input
														className="set-input"
														placeholder={t("tplNamePlaceholder")}
														value={tplDraft.name}
														onChange={(e) => setTplDraft({ ...tplDraft, name: e.target.value })}
													/>
													<input
														className="set-input"
														placeholder={t("tplDescriptionPlaceholder")}
														value={tplDraft.description}
														onChange={(e) => setTplDraft({ ...tplDraft, description: e.target.value })}
													/>
													<input
														className="set-input"
														placeholder={t("tplDescriptionEnPlaceholder")}
														value={tplDraft.descriptionEn ?? ""}
														onChange={(e) => setTplDraft({ ...tplDraft, descriptionEn: e.target.value })}
													/>
												</div>
												<div className="set-mode-row">
													<label className="set-field-label">{t("tplPromptModeLabel")}</label>
													<select
														className="set-select"
														value={tplDraft.promptMode}
														onChange={(e) =>
															setTplDraft({ ...tplDraft, promptMode: e.target.value as "append" | "replace" })
														}
													>
														<option value="replace">{t("promptModeReplace")}</option>
														<option value="append">{t("promptModeAppend")}</option>
													</select>
												</div>
												<div className="set-mode-row">
													<label className="set-field-label">{t("tplModelLabel")}</label>
													<select
														className="set-select"
														value={tplDraft.model ?? ""}
														onChange={(e) => setTplDraft({ ...tplDraft, model: e.target.value })}
													>
														<option value="">{t("subagentFollowMain")}</option>
														{settings.subagentModels.map((m) => (
															<option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
																{m.label}
															</option>
														))}
													</select>
												</div>
												<div className="set-mode-row">
													<label className="set-field-label">
														{t("tplThinkingLabel")} <HintTip text={t("tplThinkingHint")} />
													</label>
													<select
														className="set-select"
														value={tplDraft.thinkingLevel ?? ""}
														onChange={(e) => setTplDraft({ ...tplDraft, thinkingLevel: e.target.value })}
													>
														<option value="">{t("tplThinkingFollowMain")}</option>
														{THINKING_VALUES.map((v) => (
															<option key={v} value={v}>
																{t(`thinking.${v}`)}
															</option>
														))}
													</select>
												</div>
												<textarea
													className="set-prompt-input"
													rows={4}
													placeholder={`${t("tplSystemPromptLabel")}${locale === "zh" ? "：" : ": "}${t(
														"tplSystemPromptPlaceholder",
													)}`}
													value={tplDraft.systemPrompt}
													onChange={(e) => setTplDraft({ ...tplDraft, systemPrompt: e.target.value })}
												/>
												<textarea
													className="set-prompt-input"
													rows={4}
													placeholder={`${t("tplSystemPromptLabel")}: ${t("tplSystemPromptEnPlaceholder")}`}
													value={tplDraft.systemPromptEn ?? ""}
													onChange={(e) => setTplDraft({ ...tplDraft, systemPromptEn: e.target.value })}
												/>
												<div className="tpl-pick-block">
													<div className="tpl-pick-head">
														<span>
															{t("tplSkillsLabel")} · {t("tplWhitelistHint")}
														</span>
													</div>
													{settings.skills.length === 0 ? (
														<p className="set-hint">{t("noSkills")}</p>
													) : (
														<div className="tpl-pick">
															{settings.skills.map((s) => (
																<label
																	key={s.name}
																	className={`tpl-chip${tplDraft.enabledSkills.includes(s.name) ? " on" : ""}`}
																>
																	<input
																		type="checkbox"
																		checked={tplDraft.enabledSkills.includes(s.name)}
																		onChange={(e) => {
																			const on = e.target.checked;
																			setTplDraft({
																				...tplDraft,
																				enabledSkills: on
																					? [...tplDraft.enabledSkills, s.name]
																					: tplDraft.enabledSkills.filter((n) => n !== s.name),
																			});
																		}}
																	/>
																	{s.name}
																</label>
															))}
														</div>
													)}
												</div>
												<div className="tpl-pick-block">
													<div className="tpl-pick-head">
														<span>
															{t("tplExtensionsLabel")} · {t("tplWhitelistHint")}
														</span>
													</div>
													{settings.extensions.length === 0 ? (
														<p className="set-hint">{t("noExtensions")}</p>
													) : (
														<div className="tpl-pick">
															{settings.extensions.map((x) => (
																<label
																	key={x.id}
																	className={`tpl-chip${tplDraft.enabledExtensions.includes(x.id) ? " on" : ""}`}
																>
																	<input
																		type="checkbox"
																		checked={tplDraft.enabledExtensions.includes(x.id)}
																		onChange={(e) => {
																			const on = e.target.checked;
																			setTplDraft({
																				...tplDraft,
																				enabledExtensions: on
																					? [...tplDraft.enabledExtensions, x.id]
																					: tplDraft.enabledExtensions.filter((id) => id !== x.id),
																			});
																		}}
																	/>
																	{x.name}
																</label>
															))}
														</div>
													)}
												</div>
											</div>
											<div className="modal-actions">
												<button
													type="button"
													className="set-save-btn"
													disabled={!tplDraft.name.trim()}
													onClick={() => {
														appSend({
															type: "save_subagent_template",
															template: { ...tplDraft, name: tplDraft.name.trim() },
														});
														setTplDraft(null);
													}}
												>
													{t("tplSave")}
												</button>
												<button type="button" className="dd-refresh" onClick={() => setTplDraft(null)}>
													{t("tplCancel")}
												</button>
											</div>
										</div>
									</div>
								)}

								{/* ---- 模板列表 ------------------------------------------------ */}
								{settings.subagentTemplates.length === 0 ? (
									<p className="set-empty">{t("noSubagentTemplates")}</p>
								) : (
									<div className="set-list set-list-flat">
										{settings.subagentTemplates.map((tp) => (
											<div className="set-row" key={tp.name}>
												<div className="set-row-info">
													<div className="set-row-name">
														{tp.name}
														{settings.subagentDefaultTemplates.includes(tp.name) && (
															<span className="tpl-badge default">{t("tplDefaultBadge")}</span>
														)}
														{!tp.enabled && <span className="tpl-badge">{t("subagentTemplateClosed")}</span>}
													</div>
													<div className="set-row-desc">
														{(locale !== "zh" && tp.descriptionEn ? tp.descriptionEn : tp.description) ||
															`${tp.promptMode === "replace" ? t("promptModeReplace") : t("promptModeAppend")}`}
														{tp.model ? ` · ${t("tplModelLabel")} ${tp.model}` : ` · ${t("subagentFollowMain")}`}
														{tp.thinkingLevel
															? ` · ${t("tplThinkingLabel")} ${tt(`thinking.${tp.thinkingLevel}`)}`
															: ""}
														{tp.enabledSkills.length > 0 && ` · ${t("tplSkillsLabel")} ${tp.enabledSkills.length}`}
														{tp.enabledExtensions.length > 0 &&
															` · ${t("tplExtensionsLabel")} ${tp.enabledExtensions.length}`}
														{!tp.description &&
															tp.enabledSkills.length === 0 &&
															tp.enabledExtensions.length === 0 &&
															` · ${t("tplInherit")}`}
													</div>
												</div>
												<div className="set-row-actions">
													<button
														type="button"
														className={`set-switch${tp.enabled ? " on" : ""}`}
														role="switch"
														aria-checked={tp.enabled}
														title={`${tp.enabled ? t("subagentTemplateDisable") : t("subagentTemplateEnable")} · ${t(
															"subagentTemplateOffHint",
														)}`}
														onClick={() =>
															appSend({ type: "save_subagent_template", template: { ...tp, enabled: !tp.enabled } })
														}
													>
														<span className="set-switch-knob" />
													</button>
													<button
														type="button"
														className="set-uninstall"
														title={t("subagentTemplateEdit")}
														onClick={() => {
															setTplDraft({ ...tp });
															setTplIsNew(false);
														}}
													>
														{t("subagentTemplateEdit")}
													</button>
													{confirmTplDelete === tp.name ? (
														<button
															type="button"
															className="set-uninstall confirm"
															title={t("uninstallConfirmHint")}
															onClick={() => {
																appSend({ type: "delete_subagent_template", name: tp.name });
																setConfirmTplDelete(null);
															}}
														>
															{t("uninstallConfirm")}
														</button>
													) : (
														<button
															type="button"
															className="set-icon-btn danger"
															title={t("tplDelete")}
															onClick={() => setConfirmTplDelete(tp.name)}
														>
															<FiTrash2 />
														</button>
													)}
												</div>
											</div>
										))}
									</div>
								)}
							</div>
						)}
						{/* ---- 插件自定义页（settings.pages，issue #146） ------------------- */}
						{activePluginPage && (
							<PluginPage
								plugin={activePluginPage.plugin}
								epoch={chat.pluginsEpoch}
								send={appSend}
								className="set-plugin-page"
							/>
						)}
					</div>
				</div>

				<div className="modal-actions">
					<button type="button" className="dd-refresh" onClick={onClose}>
						{t("close")}
					</button>
				</div>
			</div>
		</div>
	);
}
