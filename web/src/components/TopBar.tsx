import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
	FiDownload,
	FiFolder,
	FiFolderPlus,
	FiGitBranch,
	FiGithub,
	FiGlobe,
	FiMenu,
	FiMessageSquare,
	FiSearch,
	FiSun,
	FiPlus,
	FiSettings,
	FiLayers,
	FiTerminal,
	FiVolume2,
} from "react-icons/fi";
import type { ChatState, UpdateAllItem } from "../use-chat";
import type { CommandDef } from "../types";
import { buildUpdateCommand } from "../update-command";
import { randomUuid } from "../uuid";
import { Dropdown, DropdownItem } from "./Dropdown";
import { SoundSettingsPanel } from "./SoundSettings";
import { BrowserControl } from "./BrowserControl";
import { BROWSER_PAGE_TOOL_NAME } from "../../../server/tool-manager.js";
import { NotifyToggle } from "./NotifyToggle";
import type { SoundKind, SoundSettings } from "../sounds";
import { PluginIcon } from "../plugin-icon";
import { useI18n, localeShort } from "../i18n";
import { isPluginViewItem, setPluginViewPinned, type UiSlotEntry } from "../ui-slots";
import { fitTopbar, MOBILE_ASIDE_TOPBAR_IDS, sortOverflowMenuItems } from "../topbar-fit";
import { openContextMenu } from "../context-menu-state";
import { appSend, useAppField, useAppGlobals, useIsManaged, useServiceInfo } from "../app-globals";
import { ProjectPicker } from "./ProjectPicker";
import { PluginMenu } from "./PluginMenu";
import { LocaleModal } from "./LocaleModal";
import { isDesktopShell } from "../desktop";
import { desktopReleasesUrl, useDesktopUpdater } from "../desktop-updater";

/**
 * 顶栏「⋯」溢出菜单（issue #162）：portal 到 document.body + `position: fixed`。
 *
 * 为什么：菜单的触发按钮坐在横滑容器里 —— 窄屏（≤768px）的 `.topbar-flow{overflow-x:auto}`
 * 会让纵向也变成裁剪（CSS Overflow 3 §3.1：只写一轴 auto，另一轴的 visible 也算 auto）。
 * 菜单往下展开（`top: 100%+6px`）正好落在被裁剪的轴上，`z-index` 再高也逃不出来。
 * 之前 `ContextMenu.tsx` 已经用同一招（portal + fixed + 实测钳制）解决过右键菜单的裁剪，
 * 这里照抄：视口坐标直接取触发按钮的 `getBoundingClientRect()`，先渲染再实测菜单尺寸后钳制。
 *
 * 行为：点外面 / Esc 关闭（与 Dropdown/ContextMenu 一致）；窗口缩放或滚动时重算锚点
 * （移动端横滑顶栏时菜单跟着走，而不是飘在原地）。
 */
function TopbarOverflowMenu({
	anchorRef,
	open,
	onClose,
	children,
}: {
	anchorRef: React.RefObject<HTMLButtonElement | null>;
	open: boolean;
	onClose: () => void;
	children: ReactNode;
}) {
	const menuRef = useRef<HTMLDivElement>(null);
	// 实测钳制后的最终坐标；null = 还没量过（那一帧先藏起来，不闪一下）。
	const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
	// onClose 是内联箭头（每 render 换身份）：直接进 deps 会让下面的 effect 每次渲染都解绑/重绑
	// 全套 document 监听 —— 离散按键事件若正好落在旧监听已拆、新监听未装的缝里，Esc 就丢了
	// （实测：先开溢出菜单再开内层声音面板，第一次 Esc 只有关掉内层，溢出菜单纹丝不动）。
	// 所以关闭走 ref，effect 只依赖 open：菜单开着期间监听只装一次（与 Dropdown/ContextMenu 同形）。
	const onCloseRef = useRef(onClose);
	useLayoutEffect(() => {
		onCloseRef.current = onClose;
	});

	/** 按触发按钮的当前矩形算出菜单左上角（右对齐 + 上下翻转 + 视口钳制）。 */
	const measure = () => {
		const btn = anchorRef.current?.getBoundingClientRect();
		const el = menuRef.current?.getBoundingClientRect();
		if (!btn || !el) return;
		const MARGIN = 8;
		const GAP = 6;
		const w = el.width;
		const h = el.height;
		// 右对齐到按钮右缘，钳在视口内。
		const x = Math.max(MARGIN, Math.min(btn.right - w, window.innerWidth - w - MARGIN));
		// 默认挂按钮下方；下方放不下就翻到上方；两边都放不下就贴顶并靠 max-height 内滚。
		let y = btn.bottom + GAP;
		if (y + h > window.innerHeight - MARGIN) y = btn.top - h - GAP;
		if (y < MARGIN) y = MARGIN;
		setPos((prev) => (prev?.x === x && prev?.y === y ? prev : { x, y }));
	};

	// 打开后、内容变化后：绘制前实测一次（layout effect，用户看不到中间态）。
	useLayoutEffect(() => {
		if (open) measure();
		else setPos(null);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, children]);

	useEffect(() => {
		if (!open) return;
		const close = () => onCloseRef.current();
		const inside = (target: EventTarget | null) =>
			(target instanceof Node &&
				((menuRef.current && menuRef.current.contains(target)) ||
					(anchorRef.current && anchorRef.current.contains(target)))) ||
			false;
		const onDown = (e: MouseEvent) => {
			if (inside(e.target)) return;
			close();
		};
		// 捕获期：Esc 先到我们 —— 内层 Dropdown 的冒泡监听随后也会关它自己，两边一致收敛到全关；
		// 且不怕冒泡链上有人 stopPropagation（与 ContextMenu 的 mousedown 同款）。
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") close();
		};
		document.addEventListener("mousedown", onDown, true);
		document.addEventListener("keydown", onKey, true);
		// 滚动/缩放只重算锚点不关闭：移动端横滑顶栏时菜单跟着触发按钮走。
		window.addEventListener("resize", measure, true);
		window.addEventListener("scroll", measure, true);
		return () => {
			document.removeEventListener("mousedown", onDown, true);
			document.removeEventListener("keydown", onKey, true);
			window.removeEventListener("resize", measure, true);
			window.removeEventListener("scroll", measure, true);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	if (!open) return null;
	return createPortal(
		<div
			ref={menuRef}
			className="plugin-topbar-menu portal"
			role="menu"
			style={{
				left: pos?.x ?? -9999,
				top: pos?.y ?? -9999,
				visibility: pos ? "visible" : "hidden",
			}}
		>
			{children}
		</div>,
		document.body,
	);
}

/**
 * 手机端断点（与 styles.css 的 mobile ≤768px 同口径）：matchMedia 监听，跨断点实时切换。
 * jsdom / SSR（无 matchMedia）回落 false —— 宁可全画，也不清空顶栏。
 */
function useIsMobileTopbar(): boolean {
	const [isMobile, setIsMobile] = useState(
		() =>
			typeof window !== "undefined" &&
			typeof window.matchMedia !== "undefined" &&
			window.matchMedia("(max-width: 768px)").matches,
	);
	useEffect(() => {
		if (typeof window === "undefined" || typeof window.matchMedia === "undefined") return;
		const mq = window.matchMedia("(max-width: 768px)");
		const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
		if (typeof mq.addEventListener === "function") mq.addEventListener("change", onChange);
		else mq.addListener(onChange);
		return () => {
			if (typeof mq.removeEventListener === "function") mq.removeEventListener("change", onChange);
			else mq.removeListener(onChange);
		};
	}, []);
	return isMobile;
}

interface TopBarProps {
	chat: ChatState;
	/** Minimal terminal-tab bridge (same shape SCMPanel uses) — updates run there. */
	terminal: {
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
	};
	view: "chat" | "terminal" | "git" | `plugin:${string}`;
	onViewChange: (view: "chat" | "terminal" | "git" | `plugin:${string}`) => void;
	/** Installed optional plugins (<dataDir>/plugins) — one view tab each
	 *  (view:false renderer-only plugins are filtered out by the caller). */
	plugins: {
		id: string;
		name: string;
		icon?: string;
		iconSvg?: string;
		version?: string;
		description?: string;
		error?: string;
		view?: boolean;
	}[];
	/** 顶栏主栏条目（内置 + 插件的最终结果，已按用户偏好/插件 arrange 排好；由 App 计算）。 */
	uiPrimary?: UiSlotEntry[];
	/** 溢出菜单条目：被隐藏/被移到 overflow 的条目（用户仍能从这里找回）。 */
	uiOverflow?: UiSlotEntry[];
	/** 点击一个条目：view 由宿主切视图，其余（action/select）交给贡献它的插件
	 *  （select 切选项时第二个参数带选中的 value）。 */
	onUiAction?: (item: UiSlotEntry, value?: string) => void;
	/** 顶栏右键菜单的条目（contextmenu.topbar 槽位；插件可往里加项）。 */
	uiContextTopbar?: UiSlotEntry[];
	/** Open a side panel as a mobile drawer ("left" = history, "right" = files). */
	onOpenPanel: (side: "left" | "right") => void;
	/** Open the settings panel (system prompt / skills / extensions / presets). */
	onOpenSettings: () => void;
	/** Open the background-task panel (AI-started servers — stop individually or all). */
	onOpenBgTasks: () => void;
	/** Open the global search panel (sessions / projects / workspace files). */
	onOpenGlobalSearch: () => void;
	/** Sound notification settings + change handler (owned by App). */
	sound: SoundSettings;
	onSoundChange: (settings: SoundSettings) => void;
	onSoundPreview: (kind: SoundKind) => void;
	/** Theme list + current selection + switch handler (owned by App). */
	themes: { id: string; name: string; builtin: boolean; nameEn?: string }[];
	theme: string | null;
	onThemeChange: (id: string | null) => void;
	/** Re-fetch the theme list (called when a theme menu opens with an empty list). */
	reloadThemes: () => void;
}

export function TopBar({
	chat,
	terminal,
	view,
	plugins,
	uiPrimary,
	uiOverflow,
	uiContextTopbar,
	onUiAction,
	onViewChange,
	onOpenPanel,
	onOpenSettings,
	onOpenBgTasks,
	onOpenGlobalSearch,
	sound,
	onSoundChange,
	onSoundPreview,
	themes,
	theme,
	onThemeChange,
	reloadThemes,
}: TopBarProps) {
	const { locale, setLocale, t, packs } = useI18n();
	// 「⋯」溢出菜单的开关（宿主自己的菜单，插件不碰 DOM；顺序与设置面板里看到的一致）。
	const [topbarMenuOpen, setTopbarMenuOpen] = useState(false);
	/* 「打开项目」按钮（host:open-project）的项目选择器：与左栏 📁+ 同一个组件、同一套行为
	   （浏览磁盘目录 / 选当前目录 / ＋新建项目后切过去）。cwd 与额外工作区根走全局 store
	   （整棵树都要的值，不再从 App 传参）。 */
	const [projectPickerOpen, setProjectPickerOpen] = useState(false);
	/* 插件面板（host:plugins 的 🧩 入口）：锚点是**点击那一刻**的矩形快照 —— 触发器常从「⋯」
	   溢出菜单里被点，那里的 .plugin-topbar-menu-keep 点完即卸载，ref 当场就指不到东西了。
	   面板本身渲染在 header 根上（不在 keep 包装里），否则会跟着 ⋯ 菜单一起被卸载。
	   el 只用来认「再点一次同一个触发器 = 关」（且已被卸载的 el 不影响判断）。 */
	const [pluginMenuAnchor, setPluginMenuAnchor] = useState<{ rect: DOMRect; el: HTMLElement } | null>(null);
	const cwd = useAppField("cwd");
	const workspaceRoots = useAppField("workspaceRoots");
	// 溢出菜单触发按钮：portal 菜单按它的视口矩形锚定（issue #162）。
	const moreBtnRef = useRef<HTMLButtonElement>(null);
	/* PI_WEB_TABS: an instance can be set up to offer only some tabs — the
	   server refuses the messages of the others anyway (server/tabs.ts), so
	   drawing them would only offer an action that comes back refused. No list
	   means every tab, which is the default. */
	const tabOn = (tab: string) => !chat.tabs || tab === "chat" || chat.tabs.includes(tab);
	/** 常驻溢出菜单的条目：「布局页里被隐藏的宿主条目 ＋ topbar.overflow 声明项」。
	 *  品牌（host:brand）没有动作，进菜单会变成死按钮 —— 直接过滤（布局页仍可勾回来）。
	 *  另外还有「本断点放不下」的条目，那是实测出来的（见下面的 fitTopbar），不在这里。 */
	const pinnedOverflowItems = [...(uiOverflow ?? [])].filter(
		(it) => !(it.source === "host" && it.id === "host:brand") && !isPluginViewItem(it),
	);
	/** 已钉在顶栏上的插件 id：直接看槽位结果 —— 钉住 = 条目在 uiPrimary（非 hidden），
	 *  没钉 = 条目在 uiOverflow（hidden）。合成条目（默认 hidden）与插件自声明的 __view
	 *  条目（默认可见）在同一套口径下都读得出来，不需要额外的存储层。 */
	const pinnedPluginIds = new Set(
		[...(uiPrimary ?? []), ...(uiOverflow ?? [])]
			.filter((e) => isPluginViewItem(e) && !e.hidden)
			.map((e) => e.source.slice("plugin:".length)),
	);
	/**
	 * 顶栏统一渲染（方案 A：**完全扁平**，桌面与手机同一份 slot 数据）——
	 * 所有条目都是 `.topbar-flow` 的直接子节点，**没有任何按种类包裹的容器**
	 * （不再有 .brand / .view-switch / .topbar-desktop，也不再有两端贴边的例外）：
	 * 宿主条目查 `hostNodes` 节点工厂，插件条目走 `renderPluginEntry` 通用渲染，
	 * align 只决定它落在两个 spacer 划出的三段（start / center / end）里的哪一段。
	 * 可见性/顺序/对齐/文案对**每一个**条目都生效（布局页勾选框、↑↓、align）。
	 *
	 * `uiPrimary` 完全没给（未接线 / 单测）时回退内置默认顺序、全部落 start 区：
	 * 没拿到 slot 数据就把顶栏清空是最糟的降级（与旧版 hostOn 同口径）。
	 */
	const FALLBACK_TOPBAR_IDS = [
		"host:history",
		"host:brand",
		"host:open-project",
		"host:chat",
		"host:terminal",
		"host:git",
		"host:plugins",
		"host:search",
		"host:browser",
		"host:tasks",
		"host:settings",
		"host:sound",
		"host:language",
		"host:theme",
		"host:update",
		"host:github",
		"host:new-chat",
		"host:files",
	];
	const topEntries: { id: string; entry: UiSlotEntry | null }[] =
		uiPrimary !== undefined
			? uiPrimary.map((e) => ({ id: e.id, entry: e }))
			: FALLBACK_TOPBAR_IDS.map((id) => ({ id, entry: null }));
	/** 报错插件的视图 tab：合并引擎整份丢弃了它们的贡献（含合成的 __view 条目），
	 *  但 tab 本体仍要置灰可点（与旧版 plugins-prop 直画一致）—— 以伪条目补回条目流尾部。 */
	const brokenViewEntries: UiSlotEntry[] = (tabOn("plugins") ? plugins : [])
		.filter((p) => p.view !== false && p.error && !topEntries.some((e) => e.id === `${p.id}:__view`))
		.map(
			(p) =>
				({
					id: `${p.id}:__view`,
					slot: "topbar.primary",
					source: `plugin:${p.id}`,
					label: p.name,
					kind: "view",
					view: `plugin:${p.id}`,
					order: 23,
					align: "end",
					hidden: false,
					userOverrides: [],
					arrangedBy: [],
				}) as UiSlotEntry,
		);
	// 视图门禁 / 白名单门禁在统一的条目流里过滤（见下面的 flowItems）。
	/**
	 * 溢出菜单里的**宿主内置动作**：点下去得真干活。
	 *
	 * 主路径是原样渲染（菜单里直接画 hostNodes 的 chip/tab，点它就是点顶栏本身，
	 * 不需要分派）。这里只服务两条后备：hostNodes 返回 null 的条目
	 * （门禁/条件不满足，如终端视图里的 ☰，扁平行保证找得回来）与 select 行。
	 * 宿主自己的入口实现全在 TopBar 里（与 T1 的教训一致：`host:*` 的实现留在拥有
	 * 它的组件内），所以这里按 id 映射到本地处理器；返回 false = 不认识
	 * 这个 id（比如插件条目、或 kind="view" 的条目）→ 交回 onUiAction。
	 */
	const dispatchHostOverflow = (entry: UiSlotEntry): boolean => {
		if (entry.source !== "host") return false;
		switch (entry.id) {
			case "host:history":
				onOpenPanel("left");
				return true;
			case "host:files":
				onOpenPanel("right");
				return true;
			case "host:new-chat":
				appSend({ type: "new_chat" });
				return true;
			case "host:open-project":
				setProjectPickerOpen(true);
				return true;
			case "host:search":
				onOpenGlobalSearch();
				return true;
			case "host:tasks":
				onOpenBgTasks();
				return true;
			case "host:settings":
				onOpenSettings();
				return true;
			case "host:plugins":
				// 扁平行后备（hostNodes 那条路点不到时，例如插件 tab 被白名单关掉）：
				// 锚到「⋯」按钮自己 —— 至少面板开在用户点的地方。
				setPluginMenuAnchor(
					moreBtnRef.current ? { rect: moreBtnRef.current.getBoundingClientRect(), el: moreBtnRef.current } : null,
				);
				return true;
			default:
				// 视图条目（chat/terminal/git/插件视图）与插件动作交给 App 的 onUiAction
				//（视图由它自己 setView，动作转给贡献插件）；菜单型宿主条目不会走到这里
				//（它们整块搬进菜单，见 OVERFLOW_AS_NODE_IDS）。
				return false;
		}
	};

	/** 右键一个顶栏条目 → 打开 contextmenu.topbar 槽位（插件可往里贡献菜单项）。 */
	const openItemMenu = (e: React.MouseEvent, id: string, label: string) => {
		e.preventDefault();
		openContextMenu({
			x: e.clientX,
			y: e.clientY,
			slot: "contextmenu.topbar",
			target: { id, label },
			entries: uiContextTopbar ?? [],
		});
	};
	// 受管标记与自身版本号：走全局（web/src/app-globals.ts），整个连接内不变。
	const { appVersion } = useAppGlobals();
	const managed = useIsManaged();
	// 由 pi-web-ui 服务启动的实例（launchd/systemd/Windows watchdog）：退出后会被
	// supervisor 拉起，所以更新面板给出「重启服务」按钮；前台/dev 实例没有值。
	const service = useServiceInfo();
	const [restarting, setRestarting] = useState(false);
	// 「重启服务」会断开连接（进程退出→supervisor 拉起）：重新连上（open）后
	// 把按钮恢复可用，否则它会永远停在「重启中…」。
	useEffect(() => {
		if (restarting && chat.status === "open") setRestarting(false);
	}, [restarting, chat.status]);
	const [soundOpen, setSoundOpen] = useState(false);
	const [langOpen, setLangOpen] = useState(false);
	const [themeOpen, setThemeOpen] = useState(false);
	const [updateOpen, setUpdateOpen] = useState(false);
	// 桌面壳（issue #180）：包内服务不受 npm 全局包影响，更新走主进程的
	// electron-updater（preload IPC），npm 那套终端命令在这里不画。
	// hook 必须在组件顶层调用 —— renderUpdateBody 会被调两次（桌面下拉 +
	// 移动端 ⋯ 面板），hook 放闭包里一次渲染就跑两遍了。
	const inDesktopShell = isDesktopShell();
	const desktopUpdater = useDesktopUpdater();
	const [localeModalOpen, setLocaleModalOpen] = useState(false);

	/** Run `npm i -g pi-web-ui@latest` in a visible terminal tab (SCM-style):
	 *  reuse the tab with the same title, otherwise create one; switch to the
	 *  terminal view so the user watches the install live. */
	const runUpdate = () => {
		if (!chat.ready) return;
		const title = t("updateTabTitle");
		const cmd: CommandDef = {
			name: title,
			command: "npm i -g pi-web-ui@latest",
			cwd: "${pwd}",
		};
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
		} else {
			terminal.create({
				id: randomUuid(),
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
		setUpdateOpen(false);
		onViewChange("terminal");
	};

	/** Run the right update command for one or more components in a visible
	 *  terminal tab (same SCM-style pattern as the self-update above): pi
	 *  extensions go through `pi update npm:<name>` (they live under
	 *  <agentDir>/npm), everything globally installed via `npm i -g`.
	 *  Multi-target runs are chained with `;` so one failing step never
	 *  blocks the rest. Reuses the tab with the same title, else creates one. */
	const runPkgUpdate = (items: UpdateAllItem[], title: string) => {
		if (!chat.ready || items.length === 0) return;
		const cmd: CommandDef = {
			name: title,
			command: buildUpdateCommand(items),
			cwd: "${pwd}",
		};
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
		} else {
			terminal.create({
				id: randomUuid(),
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
		setUpdateOpen(false);
		onViewChange("terminal");
	};

	// Shared by the desktop update dropdown and the mobile "⋯" panel.
	const allUpdates = chat.updatesAll ?? [];
	// Pure errors don't count as "updates" — they're shown as failed rows.
	const updatesCount = allUpdates.filter((i) => !i.upToDate && !i.error).length;
	// Packages (+ the pi core) with a real newer version — targets of the
	// per-row and "update all" buttons. The web UI itself is excluded: it has
	// its own dedicated update flow above the all-components section.
	const updatable = allUpdates.filter((i) => !i.upToDate && !i.error && i.kind !== "webui");
	// Git-source rows show `host/path` (what the user put in settings.json and
	// what `pi update` takes) instead of the clone's package.json name, which
	// is often generic and unrecognizable. Full identity stays in the tooltip.
	const gitDisplayName = (item: UpdateAllItem) =>
		item.kind === "git-extension" && item.source ? item.source : item.name;
	const gitNameTitle = (item: UpdateAllItem) =>
		item.kind === "git-extension" && item.source && item.source !== item.name
			? `${item.source} (${item.name})`
			: item.name;
	// Git SHAs carry no signal for users (`0.1.0 (aaa → bbb)`), so they are
	// hidden from the version cell: outdated rows already stand out via the
	// warn highlight + update button. Full values stay in the tooltip.
	const stripGitSha = (v: string) => {
		const s = v.replace(/ \([0-9a-f]{7}\)$/, "");
		return /^[0-9a-f]{7}$/.test(s) ? "" : s;
	};
	const shortGitRange = (current: string, latest: string | null) => {
		if (!latest) return stripGitSha(current);
		const c = stripGitSha(current);
		const l = stripGitSha(latest);
		return c === l ? c : `${c} → ${l}`;
	};
	const renderAllUpdatesBody = () => (
		<div className="dd-updates-all">
			<div className="dd-header">{t("updatesAllTitle")}</div>
			{chat.updatesAll === null ? (
				<div className="dd-note">{t("checkingUpdate")}</div>
			) : allUpdates.length === 0 ? (
				<div className="dd-note">{t("updatesAllUpToDate")}</div>
			) : (
				<ul className="dd-all-list">
					{allUpdates.map((item) => (
						<li
							key={`${item.kind}:${item.name}`}
							className={`dd-all-item${item.error ? " err" : item.upToDate ? "" : " warn"}`}
						>
							{item.kind !== "webui" && !item.upToDate && !item.error && (
								<button
									type="button"
									className="dd-update-btn"
									onClick={() => runPkgUpdate([item], t("updatePkgTabTitle", { name: item.name }))}
								>
									{t("updateBtn")}
								</button>
							)}
							<span className="dd-all-name" title={gitNameTitle(item)}>
								{gitDisplayName(item)}
							</span>
							<span className="dd-all-meta">
								<span className="dd-all-kind">
									{item.kind === "webui"
										? t("kindWebUi")
										: item.kind === "pi-core"
											? t("kindPiCore")
											: item.kind === "git-extension"
												? t("kindGitExtension")
												: t("kindPackage")}
								</span>
								<span
									className="dd-all-vers"
									title={
										item.error
											? item.error
											: item.kind === "git-extension"
												? item.upToDate
													? item.current
													: `${item.current} → ${item.latest}`
												: undefined
									}
								>
									{item.error ? (
										t("updateCheckFailed")
									) : item.kind === "git-extension" ? (
										item.upToDate ? (
											stripGitSha(item.current)
										) : (
											shortGitRange(item.current, item.latest)
										)
									) : item.upToDate ? (
										`v${item.current}`
									) : (
										<>
											v{item.current} → v{item.latest}
										</>
									)}
								</span>
							</span>
						</li>
					))}
				</ul>
			)}
			<div className="dd-actions">
				{updatable.length > 0 && (
					<button
						type="button"
						className="dd-refresh accent"
						style={{ flex: 1 }}
						onClick={() => runPkgUpdate(updatable, t("updateAllTabTitle"))}
					>
						{t("updateAllBtn")}
					</button>
				)}
				<button
					type="button"
					className="dd-refresh"
					style={updatable.length > 0 ? { flex: 1 } : undefined}
					onClick={() => appSend({ type: "check_updates_all", force: true })}
				>
					{t("updatesAllRefresh")}
				</button>
			</div>
		</div>
	);
	/** 桌面壳的更新区：electron-updater 查/下/装 + 永远可点的下载页直链。
	 *  无 hook（状态全在组件顶层的 useDesktopUpdater 里），两处面板复用安全。 */
	const renderDesktopUpdater = () => {
		const manualUrl = desktopReleasesUrl(chat.update?.latest ?? desktopUpdater.version);
		const manual = (
			<a className="dd-refresh dd-more-link" href={manualUrl} target="_blank" rel="noreferrer noopener">
				{t("updateDesktopManual")}
			</a>
		);
		// 旧桌面壳（#180 之前）没有 updater 桥：只给下载页指引，不画更新按钮。
		if (!desktopUpdater.bridge)
			return (
				<>
					<div className="dd-note warn">{t("updateDesktopNoBridge")}</div>
					{manual}
				</>
			);
		switch (desktopUpdater.state) {
			case "checking":
				return (
					<>
						<div className="dd-note">{t("updateDesktopChecking")}</div>
						{manual}
					</>
				);
			case "available":
				return (
					<>
						<div className="dd-note warn">
							{t("updateDesktopAvailable", {
								version: desktopUpdater.version ?? chat.update?.latest ?? "",
							})}
						</div>
						<button type="button" className="dd-refresh accent" onClick={() => desktopUpdater.download()}>
							{t("updateDesktopDownload")}
						</button>
						{manual}
					</>
				);
			case "downloading":
				return (
					<>
						<div className="dd-note">{t("updateDesktopDownloading", { n: desktopUpdater.percent })}</div>
						{manual}
					</>
				);
			case "downloaded":
				return (
					<>
						<div className="dd-note ok">{t("updateDesktopDownloaded")}</div>
						<button type="button" className="dd-refresh accent" onClick={() => desktopUpdater.quitAndInstall()}>
							{t("updateDesktopInstall")}
						</button>
						{manual}
					</>
				);
			case "up-to-date":
				return <div className="dd-note ok">{t("upToDate")}</div>;
			case "error":
				return (
					<>
						<div className="dd-note warn">{t("updateDesktopError", { error: desktopUpdater.message ?? "" })}</div>
						<button type="button" className="dd-refresh" onClick={() => desktopUpdater.check()}>
							{t("updateDesktopCheck")}
						</button>
						{manual}
					</>
				);
			default:
				return (
					<>
						<button type="button" className="dd-refresh accent" onClick={() => desktopUpdater.check()}>
							{t("updateDesktopCheck")}
						</button>
						{manual}
					</>
				);
		}
	};
	const renderUpdateBody = () => (
		<>
			<div className="dd-update">
				<div className="dd-row">
					<span>{t("currentVersion")}</span>
					<b>v{chat.update?.current ?? "…"}</b>
				</div>
				<div className="dd-row">
					<span>{t("latestVersion")}</span>
					<b>
						{chat.update === null
							? t("checkingUpdate")
							: chat.update.error
								? chat.update.error
								: chat.update.latest
									? `v${chat.update.latest}`
									: t("checkingUpdate")}
					</b>
				</div>
				{chat.update && chat.update.upToDate && <div className="dd-note ok">{t("upToDate")}</div>}
				{chat.update && !chat.update.upToDate && chat.update.latest && (
					<div className="dd-note warn">{t("updateAvailable", { version: chat.update.latest })}</div>
				)}
				{chat.update?.latestPublishedAt &&
					Date.now() - new Date(chat.update.latestPublishedAt).getTime() < 30 * 60_000 && (
						<div className="dd-note warn">
							{t("updateJustPublished", {
								version: chat.update.latest ?? "",
							})}
						</div>
					)}
				{/* 浏览器：npm 终端命令；桌面壳：npm 对包内服务无效，走应用内更新 */}
				{chat.update && !chat.update.upToDate && chat.update.latest && !inDesktopShell && (
					<div className="dd-note">{t("updateTerminalHint")}</div>
				)}
				{chat.update && !chat.update.upToDate && chat.update.latest && inDesktopShell && (
					<div className="dd-note">{t("updateDesktopNote")}</div>
				)}
			</div>
			<div className="dd-actions">
				<button type="button" className="dd-refresh" onClick={() => appSend({ type: "check_update" })}>
					{chat.update === null ? t("checkingUpdate") : t("checkUpdate")}
				</button>
				{chat.update && !chat.update.upToDate && chat.update.latest && !inDesktopShell && (
					<button type="button" className="dd-refresh accent" onClick={runUpdate}>
						{t("updateNow")}
					</button>
				)}
				{chat.update && !chat.update.upToDate && chat.update.latest && inDesktopShell && renderDesktopUpdater()}
				{service && (
					<button
						type="button"
						className="dd-refresh accent"
						disabled={restarting}
						title={t("restartServiceTip", { name: service.name })}
						onClick={() => {
							if (restarting) return;
							setRestarting(true);
							appSend({ type: "restart_service" });
						}}
					>
						{restarting ? t("restartingService") : t("restartService")}
					</button>
				)}
			</div>
		</>
	);

	/** 手机端断点（见 useIsMobileTopbar）：旁置/实测按断点切（mobileAsideItems/fitInput）。 */
	const isMobile = useIsMobileTopbar();
	/**
	 * 顶栏宿主内置条目的节点工厂（与 FooterBar 的 hostNodes 同模式）：`renderZoneFlow`
	 * 按 slot 顺序逐条查表，查不到 / 条件不满足（返回 null）即跳过、不占位。
	 * 可见性（slot 显隐）由调用方的条目流决定，TABS 白名单与视图门禁留在各工厂里。
	 */
	const hostNodes: Record<string, ReactNode> = {
		"host:brand": (
			<span className="brand">
				<span className="brand-logo">π</span>
				<span className="brand-name">pi-web-ui</span>
			</span>
		),
		// 打开项目：切整个工作区（set_cwd），与视图无关 —— 终端 / Git / 插件视图里同样常驻可点。
		"host:open-project": (
			<button
				type="button"
				className="chip open-project"
				data-tip={t("openProject")}
				onClick={() => setProjectPickerOpen(true)}
			>
				<FiFolderPlus />
				<span className="chip-sub">{t("openProject")}</span>
			</button>
		),
		// 面板抽屉开关只在 chat 视图渲染：抽屉节点躺在 chat 视图的面板树里
		// （App.tsx 的 .panel-drawer 是 `.view-pane` 的子节点，非 chat 视图整棵
		// display:none），所以终端 / Git / 插件视图里点它只会拉出一层遮罩、
		// 抽屉永远不出现 —— 而且顶栏这个 ☰ 会和终端面板自己的 ☰ 并排成两个。
		"host:history":
			view === "chat" && tabOn("history") ? (
				<button
					type="button"
					className="panel-toggle"
					data-tip={t("openHistory")}
					// 纯图标按钮：可访问名称只能走 aria-label（title 会和 data-tip
					// 的即时气泡叠成双提示，故顶栏直流内一律不用原生 title）。
					aria-label={t("openHistory")}
					onClick={() => onOpenPanel("left")}
				>
					<FiMenu />
				</button>
			) : null,
		"host:files":
			view === "chat" && tabOn("files") ? (
				// 桌面与手机同一节点（带文字）：文字显隐统一走顶栏文字总开关
				// （.topbar.no-labels），不再有手机端独立的纯图标分支；手机端钉在
				// ⋯ 右边最右（见 mobileAsideItems），放不下由实测溢出接管。
				<button
					type="button"
					className="panel-toggle has-label"
					data-tip={t("openFiles")}
					// 文字总开关关掉后 span 会 display:none，可访问名称不能只靠可见文字。
					aria-label={t("openFiles")}
					onClick={() => onOpenPanel("right")}
				>
					<FiFolder />
					<span>{t("openFiles")}</span>
				</button>
			) : null,
		"host:new-chat": tabOn("new-chat") ? (
			<button
				type="button"
				className="chip newchat"
				data-tip={t("newChatTip")}
				onClick={() => appSend({ type: "new_chat" })}
			>
				<FiPlus />
				<span>{t("newChat")}</span>
			</button>
		) : null,
		"host:chat": (
			<button
				type="button"
				role="tab"
				aria-selected={view === "chat"}
				className={`tb-tab${view === "chat" ? " active" : ""}`}
				data-tip={t("chat")}
				onClick={() => onViewChange("chat")}
			>
				<FiMessageSquare />
				<span>{t("chat")}</span>
			</button>
		),
		"host:terminal": tabOn("terminal") ? (
			<button
				type="button"
				role="tab"
				aria-selected={view === "terminal"}
				className={`tb-tab${view === "terminal" ? " active" : ""}`}
				data-tip={t("terminal")}
				onClick={() => onViewChange("terminal")}
			>
				<FiTerminal />
				<span>{t("terminal")}</span>
			</button>
		) : null,
		"host:git": tabOn("git") ? (
			<button
				type="button"
				role="tab"
				aria-selected={view === "git"}
				className={`tb-tab${view === "git" ? " active" : ""}`}
				data-tip={t("scmTab")}
				onClick={() => onViewChange("git")}
			>
				<FiGitBranch />
				<span>{t("scmTab")}</span>
			</button>
		) : null,
		// 插件面板入口（Chrome 扩展图标那个位置）：一个 🧩 列出全部已装插件，每行带「钉到顶栏」
		// 开关。钉住的插件视图 tab 才回到直流里（合成条目默认 hidden，见 withPluginViewItems）。
		// 图标用 emoji（与 BgTasksModal / 插件文档里的通用插件符号一致）：图标词表里没有
		// 「拼图」这个词，而词表外的词会被布局页原样当文字画出来。
		"host:plugins": (
			<button
				type="button"
				className="chip"
				data-tip={t("pluginMenuTitle")}
				aria-haspopup="menu"
				aria-expanded={pluginMenuAnchor !== null}
				onClick={(e) => {
					const el = e.currentTarget;
					setPluginMenuAnchor((prev) => (prev?.el === el ? null : { rect: el.getBoundingClientRect(), el }));
				}}
			>
				<span aria-hidden>🧩</span>
				<span className="chip-sub">{t("pluginMenuTitle")}</span>
			</button>
		),
		"host:search": (
			<button type="button" className="chip" data-tip={t("searchGlobalTip")} onClick={onOpenGlobalSearch}>
				<FiSearch />
				<span className="chip-sub">{t("searchGlobal")}</span>
			</button>
		),
		"host:browser": !(chat.settings?.disabledAgentTools?.includes(BROWSER_PAGE_TOOL_NAME) ?? false) ? (
			<BrowserControl />
		) : null,
		"host:tasks": (
			<button type="button" className="chip bg-task-chip" data-tip={t("bgTasksTip")} onClick={onOpenBgTasks}>
				<FiLayers />
				<span className="chip-sub">{t("bgTasks")}</span>
				{chat.bgServers.length > 0 && <span className="bg-task-badge">{chat.bgServers.length}</span>}
			</button>
		),
		"host:settings": (
			<button type="button" className="chip" data-tip={t("settingsTitle")} onClick={onOpenSettings}>
				<FiSettings />
				<span className="chip-sub">{t("settings")}</span>
			</button>
		),
		"host:sound": (
			<Dropdown
				trigger={
					<>
						<FiVolume2 />
						<span className="chip-sub">{t("sound")}</span>
					</>
				}
				tip={t("sound")}
				open={soundOpen}
				onOpenChange={setSoundOpen}
			>
				<SoundSettingsPanel settings={sound} onChange={onSoundChange} onPreview={onSoundPreview} />
				<NotifyToggle />
			</Dropdown>
		),
		"host:language": (
			<Dropdown
				trigger={
					<>
						<FiGlobe />
						<span className="chip-sub">{localeShort(locale)}</span>
					</>
				}
				tip={t("language")}
				open={langOpen}
				onOpenChange={setLangOpen}
			>
				<div className="dd-header">{t("language")}</div>
				{packs.map((l) => (
					<DropdownItem
						key={l.code}
						active={locale === l.code}
						onClick={() => {
							setLocale(l.code);
							setLangOpen(false);
						}}
					>
						{l.nativeName}
					</DropdownItem>
				))}
				<DropdownItem
					onClick={() => {
						setLangOpen(false);
						setLocaleModalOpen(true);
					}}
				>
					<FiDownload /> {t("localeGetMore")}
				</DropdownItem>
			</Dropdown>
		),
		"host:theme": (
			<Dropdown
				trigger={
					<>
						<FiSun />
						<span className="chip-sub">{t("theme")}</span>
					</>
				}
				tip={t("theme")}
				open={themeOpen}
				onOpenChange={(v) => {
					setThemeOpen(v);
					// 挂载那次拉取若撞上服务端重启会扑空：打开时列表还空就补拉一次
					if (v && themes.length === 0) reloadThemes();
				}}
			>
				<div className="dd-header">{t("theme")}</div>
				<DropdownItem
					active={theme === null}
					onClick={() => {
						onThemeChange(null);
						setThemeOpen(false);
					}}
				>
					{t("themeDefault")}
				</DropdownItem>
				{themes.map((th) => (
					<DropdownItem
						key={th.id}
						active={theme === th.id}
						onClick={() => {
							onThemeChange(th.id);
							setThemeOpen(false);
						}}
					>
						{locale === "zh" ? th.name : (th.nameEn ?? th.name)}
					</DropdownItem>
				))}
			</Dropdown>
		),
		"host:update": managed ? (
			<span className="chip" data-tip={t("updatesManaged")}>
				<FiDownload />
				<span className="chip-sub">v{appVersion ?? chat.update?.current ?? "…"}</span>
			</span>
		) : (
			<Dropdown
				trigger={
					<>
						<FiDownload />
						<span className="chip-sub">v{chat.update?.current ?? "…"}</span>
						{chat.update && !chat.update.upToDate && (
							<span
								className="update-dot"
								title={t("updateAvailable", {
									version: chat.update.latest ?? "",
								})}
							/>
						)}
						{updatesCount > 0 && <span className="update-badge">{t("updatesAllBadge", { n: updatesCount })}</span>}
					</>
				}
				tip={t("update")}
				open={updateOpen}
				onOpenChange={(v) => {
					setUpdateOpen(v);
					if (v) {
						appSend({ type: "check_update" });
						appSend({ type: "check_updates_all" });
					}
				}}
				fit
			>
				<div className="dd-header">{t("update")}</div>
				{renderUpdateBody()}
				{renderAllUpdatesBody()}
			</Dropdown>
		),
		"host:github": (
			<a
				className="chip github"
				href="https://github.com/xing-shuyin/pi-web-ui"
				target="_blank"
				rel="noreferrer noopener"
				data-tip={t("githubRepo")}
			>
				<FiGithub />
			</a>
		),
	};

	/** 桌面工具 chips 的可见性历史口径（不扩大）：只有 search / tasks / settings 这几个成员
	 *  的显隐还受 PI_WEB_TABS 白名单管（服务端会拒绝对应的消息，画出来只会给一个点了没反应用的按钮）。 */
	const TABS_GATED_IDS = new Set(["host:search", "host:tasks", "host:settings", "host:plugins"]);
	/** 溢出菜单里**整块搬进来**的宿主条目（菜单型：下拉/外链/自带面板）。
	 *  其余宿主条目（history / files / new-chat / search / tasks / settings）在菜单里是一条扁平
	 *  菜单项，由 dispatchHostOverflow 分派到本地处理器 —— 扁平的更像菜单，整块的才需要搬组件。 */
	const OVERFLOW_AS_NODE_IDS = new Set(["host:sound", "host:language", "host:theme", "host:update", "host:browser"]);
	/** TABS 白名单门禁（历史口径，不扩大）：search/tasks/settings 的显隐还受白名单管，
	 *  其余宿主入口只看 slot（各节点工厂内部自行判断，见 hostNodes）。 */
	const isTabGatedOff = (id: string) => TABS_GATED_IDS.has(id) && !tabOn(id.slice("host:".length));
	/**
	 * 插件条目的通用渲染（宿主只负责摆位置，插件不碰 DOM）：kind="view" 落成视图 tab，
	 * kind="select" 落成下拉框（切换回插件，附带选中的 value），其余落成按钮。
	 * 条件不满足（插件视图要求 plugins tab 开放）返回 null → 该条目连同位置一起不画。
	 */
	const renderPluginEntry = (entry: UiSlotEntry): ReactNode => {
		if (entry.kind === "view") {
			if (!tabOn("plugins")) return null;
			const target = entry.view ?? "";
			const meta = plugins.find((p) => `plugin:${p.id}` === entry.source);
			const tip = meta?.error ? `${entry.label}: ${meta.error}` : (entry.hint ?? entry.label);
			return (
				<button
					key={entry.id}
					type="button"
					role="tab"
					aria-selected={view === target}
					className={`tb-tab plugin-tab${view === target ? " active" : ""}${meta?.error ? " broken" : ""}`}
					data-tip={tip}
					onClick={() => onViewChange(target as typeof view)}
					onContextMenu={(e) => openItemMenu(e, entry.id, entry.label)}
				>
					<PluginIcon icon={entry.icon} iconSvg={entry.iconSvg} />
					<span>{entry.label}</span>
				</button>
			);
		}
		if (entry.kind === "select" && entry.options?.length) {
			return (
				<select
					key={entry.id}
					className="plugin-topbar-item plugin-topbar-select"
					title={entry.hint ?? entry.label}
					aria-label={entry.label}
					value={entry.options.some((o) => o.value === entry.value) ? (entry.value as string) : entry.options[0]!.value}
					onChange={(e) => onUiAction?.(entry, e.target.value)}
					onContextMenu={(e) => openItemMenu(e, entry.id, entry.label)}
				>
					{entry.options.map((o) => (
						<option key={o.value} value={o.value}>
							{o.label}
						</option>
					))}
				</select>
			);
		}
		return (
			<button
				key={entry.id}
				type="button"
				className="plugin-topbar-item"
				data-tip={entry.hint ?? entry.label}
				onClick={() => onUiAction?.(entry)}
				onContextMenu={(e) => openItemMenu(e, entry.id, entry.label)}
			>
				<PluginIcon icon={entry.icon} iconSvg={entry.iconSvg} />
				<span>{entry.label}</span>
			</button>
		);
	};
	/**
	 * 最终要画的条目，**按 slot 顺序**（= 布局页里看到的顺序）：
	 * 宿主条目查节点工厂、插件条目通用渲染；门禁（TABS 白名单 / 视图门禁）不满足或节点工厂
	 * 返回 null 的条目**不占位**。这就是顶栏的全部内容 —— 没有第二阶段的分组/重排。
	 */
	const flowItems: { id: string; entry: UiSlotEntry | null; node: ReactNode }[] = [];
	for (const it of topEntries) {
		if (it.entry?.hidden) continue; // uiPrimary 已滤过 hidden；这里只防脏数据（插件 arrange 会改）
		if (isTabGatedOff(it.id)) continue;
		const node = it.id.startsWith("host:") ? (hostNodes[it.id] ?? null) : it.entry ? renderPluginEntry(it.entry) : null;
		if (!node) continue;
		flowItems.push({ id: it.id, entry: it.entry, node });
	}
	// 报错插件的视图 tab（合并引擎整份丢弃了它们的贡献）以伪条目补回尾部。
	for (const b of brokenViewEntries) {
		const node = renderPluginEntry(b);
		if (node) flowItems.push({ id: b.id, entry: b, node });
	}
	/** 条目自己的对齐段（脏值回落 start，与合并引擎同口径）。 */
	const zoneOf = (it: { entry: UiSlotEntry | null }): "start" | "center" | "end" => it.entry?.align ?? "start";
	/** 本断点放不下的条目（实测宽度算出来的，见 web/src/topbar-fit.ts）：退进「⋯」菜单。 */
	const [droppedIds, setDroppedIds] = useState<ReadonlySet<string>>(() => new Set<string>());
	const flowRef = useRef<HTMLDivElement>(null);
	/** 条目宽度缓存（id → 实测 px）。被丢进溢出的条目已不在 DOM 里、量不到宽度 —— 用上一次的
	 *  实测值，窗口变宽时它们才能按真实宽度回来（否则会「一旦被丢就再也回不来」）。 */
	const widthCacheRef = useRef(new Map<string, number>());
	/** 桌面与手机同一套实测溢出：放不下的条目（droppedIds）退进「⋯」，放得下全留
	 *  （手机端不再按名单强制折叠 —— 搜索/插件 tab 等能放下就直接显示）。 */
	const keptItems = flowItems.filter((it) => !droppedIds.has(it.id));
	/** 手机端固定位（MOBILE_ASIDE_TOPBAR_IDS）：移出主直流、渲染在 ⋯ 右边最右，
	 *  不参与实测溢出。桌面端为空，直流保持单一扁平（slot 顺序直排，不动）。 */
	const mobileAsideItems = isMobile ? keptItems.filter((it) => MOBILE_ASIDE_TOPBAR_IDS.has(it.id)) : [];
	/** 主直流里实际渲染的条目（手机端 = kept 去掉固定位）。 */
	const flowKeptItems = isMobile ? keptItems.filter((it) => !MOBILE_ASIDE_TOPBAR_IDS.has(it.id)) : keptItems;
	const measure = () => {
		const flow = flowRef.current;
		// jsdom / 未挂载（没有 ResizeObserver）：不丢任何条目 —— 宁可全画，也不清空顶栏。
		if (!flow || typeof ResizeObserver === "undefined") return;
		const kids = Array.from(flow.children).filter((el) => !el.classList.contains("tb-spacer"));
		// 每个条目恰好渲染一个元素（宿主条目都是单根元素）；数量对不上就不猜了 —— 全保留。
		// 手机端固定位（📁）挂在直流外面：只比对直流内的条目数（flowKeptItems）。
		if (kids.length === flowKeptItems.length) {
			flowKeptItems.forEach((it, i) => widthCacheRef.current.set(it.id, (kids[i] as HTMLElement).offsetWidth));
		}
		const gap = Number.parseFloat(getComputedStyle(flow).columnGap) || 0;
		// 「⋯」按钮是流容器的**兄弟**节点：flex 已经把它占的宽度从 clientWidth 里扣掉了，
		// 所以这里不用为它预留（reserve = 0）。没有 slot 元数据的条目（回退模式）不参与溢出
		// （宽度传 0 = 不可丢），否则菜单里会出现画不出来的幽灵项。
		// 手机端固定位（📁 挂在直流外面，不占直流宽度）不参与实测；其余直流内入口做宽度兜底
		// （极窄屏下放不下的尾部条目退进溢出，而不是把顶栏撑成两行）。
		const fitInput = isMobile ? flowItems.filter((it) => !MOBILE_ASIDE_TOPBAR_IDS.has(it.id)) : flowItems;
		const next = fitTopbar(
			fitInput.map((it) => ({ id: it.id, width: it.entry ? (widthCacheRef.current.get(it.id) ?? 0) : 0 })),
			flow.clientWidth,
			gap,
			0,
		);
		setDroppedIds((prev) => (prev.size === next.size && [...next].every((id) => prev.has(id)) ? prev : next));
	};
	// 条目集合 / 文案 / 视图 / 语言 / 断点变了就重算一次（绘制前实测，用户看不到中间态）；窗口尺寸变化由
	// 下面的 ResizeObserver 兜。**不**随快照流每次渲染都量（那会变成 60ms 一次的强制重排）。
	const measureKey = `${keptItems.map((it) => `${it.id}:${it.entry?.label ?? ""}`).join("|")}|${view}|${(chat.tabs ?? []).join(",")}|${isMobile ? "m" : "d"}`;
	useLayoutEffect(measure, [measureKey]); // eslint-disable-line react-hooks/exhaustive-deps
	useEffect(() => {
		const flow = flowRef.current;
		if (!flow || typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(() => measure());
		ro.observe(flow);
		return () => ro.disconnect();
	}, [measureKey]); // eslint-disable-line react-hooks/exhaustive-deps
	/** 三段落位（段内仍是 slot 顺序 → 布局页 ↑↓ 的效果与界面一致；手机端固定位不在直流里）。 */
	const segStart = flowKeptItems.filter((it) => zoneOf(it) === "start");
	const segCenter = flowKeptItems.filter((it) => zoneOf(it) === "center");
	const segEnd = flowKeptItems.filter((it) => zoneOf(it) === "end");
	/** 溢出菜单 = 被隐藏/常驻条目 ＋ 本断点放不下的条目（同一个「⋯」，手机上也只有一个入口）。
	 *  顺序与顶栏视觉一致（左→中→右，段内按 slot 顺序），见 sortOverflowMenuItems。 */
	const droppedEntries = flowItems.filter((it) => droppedIds.has(it.id) && it.entry).map((it) => it.entry!);
	const slotRank = new Map<string, number>();
	[...(uiPrimary ?? []), ...(uiOverflow ?? [])].forEach((e, i) => {
		if (!slotRank.has(e.id)) slotRank.set(e.id, i);
	});
	const overflowMenuItems = sortOverflowMenuItems(
		[...pinnedOverflowItems, ...droppedEntries],
		(id) => slotRank.get(id) ?? 999999,
	);

	// 顶栏按钮文字总开关（设置 → 界面布局 → 顶栏，默认开）：关掉后顶栏只剩图标
	// （数字角标保留；溢出菜单里仍带文字；实现见 styles.css 的 .topbar.no-labels）。
	const hideTopbarText = chat.settings?.uiLayout?.topbarText === false;
	return (
		<header className={`topbar${hideTopbarText ? " no-labels" : ""}`} data-pi-anchor="topbar">
			{/* 单一扁直流：所有条目同级（没有按种类包裹的容器，也没有两端贴边的例外）。
			    两个 spacer 把条目分成 start / center / end 三段 —— 就是布局页里的「对齐方向」。 */}
			<div className="topbar-flow" ref={flowRef} role="toolbar" aria-label={t("viewSwitch")}>
				{segStart.map((it) => (
					<Fragment key={it.id}>{it.node}</Fragment>
				))}
				{(segCenter.length > 0 || segEnd.length > 0) && <span className="tb-spacer" aria-hidden="true" />}
				{segCenter.map((it) => (
					<Fragment key={it.id}>{it.node}</Fragment>
				))}
				{segEnd.length > 0 && <span className="tb-spacer" aria-hidden="true" />}
				{segEnd.map((it) => (
					<Fragment key={it.id}>{it.node}</Fragment>
				))}
			</div>
			{overflowMenuItems.length > 0 && (
				<div className="plugin-topbar-more">
					<button
						ref={moreBtnRef}
						type="button"
						className="plugin-topbar-item"
						aria-haspopup="menu"
						aria-expanded={topbarMenuOpen}
						data-tip={t("pluginTopbarMore")}
						onClick={() => setTopbarMenuOpen((v) => !v)}
					>
						⋯
					</button>
					{/* issue #162：菜单 portal 到 body（fixed），不再挂在会被祖先 overflow 裁剪的容器里。 */}
					<TopbarOverflowMenu anchorRef={moreBtnRef} open={topbarMenuOpen} onClose={() => setTopbarMenuOpen(false)}>
						{overflowMenuItems.map((it) => {
							// 被隐藏的**宿主菜单型**条目（声音/语言/主题/版本/GitHub/浏览器操作）：
							// 它们不是一次性动作，扁平按钮点了没意义 —— 把整块组件搬进溢出菜单，
							// 这样「隐藏」只是换了个位置，功能一点不少（与内建条目的实现留在组件内一致）。
							const asNode = it.source === "host" && OVERFLOW_AS_NODE_IDS.has(it.id) ? hostNodes[it.id] : undefined;
							if (asNode !== undefined) {
								return <Fragment key={it.id}>{asNode}</Fragment>;
							}
							// GitHub 在菜单里同样是 chip 行（图标 + 文字，与其他行同外观）：
							// 顶栏本体是圆形图标按钮（.chip.github），这里另起一行保证有文字可读。
							if (it.source === "host" && it.id === "host:github") {
								return (
									<a
										key={it.id}
										role="menuitem"
										className="chip github"
										href="https://github.com/xing-shuyin/pi-web-ui"
										target="_blank"
										rel="noreferrer noopener"
										title={t("githubRepo")}
										onClick={() => setTopbarMenuOpen(false)}
									>
										<FiGithub />
										<span>GitHub</span>
									</a>
								);
							}
							// 折叠按钮保持折叠前样式（只统一宽度顶满菜单，不重绘成扁平行）：
							// 宿主走 hostNodes（与顶栏同一套 chip/tab/panel-toggle），插件走通用渲染。
							// 包一层关菜单（点后关 ⋯，与扁平行一致）。节点为 null（门禁/条件不满足，
							// 如终端视图里的 ☰）才回落扁平行，保证条目找得回来。
							if (it.source === "host") {
								const node = hostNodes[it.id];
								if (node) {
									return (
										<div key={it.id} className="plugin-topbar-menu-keep" onClick={() => setTopbarMenuOpen(false)}>
											{node}
										</div>
									);
								}
							} else {
								const node = renderPluginEntry(it);
								if (node) {
									return (
										<div key={it.id} className="plugin-topbar-menu-keep" onClick={() => setTopbarMenuOpen(false)}>
											{node}
										</div>
									);
								}
							}
							// kind="select" 在溢出菜单里同样落成下拉（label + select 一行）。
							if (it.kind === "select" && it.options?.length) {
								return (
									<label key={it.id} className="plugin-topbar-overflow-select" title={it.hint ?? it.label}>
										<span>
											{it.icon && !/[a-z]/i.test(it.icon) ? `${it.icon} ` : ""}
											{it.label}
										</span>
										<select
											aria-label={it.label}
											value={it.options.some((o) => o.value === it.value) ? (it.value as string) : it.options[0]!.value}
											onChange={(e) => {
												setTopbarMenuOpen(false);
												if (!dispatchHostOverflow(it)) onUiAction?.(it, e.target.value);
											}}
										>
											{it.options.map((o) => (
												<option key={o.value} value={o.value}>
													{o.label}
												</option>
											))}
										</select>
									</label>
								);
							}
							return (
								<button
									key={it.id}
									type="button"
									role="menuitem"
									title={it.hint ?? it.label}
									onClick={() => {
										setTopbarMenuOpen(false);
										// 宿主内置动作在本地分派（见 dispatchHostOverflow），其余交回 onUiAction。
										if (!dispatchHostOverflow(it)) onUiAction?.(it);
									}}
								>
									{it.icon && !/[a-z]/i.test(it.icon) ? `${it.icon} ` : ""}
									{it.label}
								</button>
							);
						})}
					</TopbarOverflowMenu>
				</div>
			)}

			{/* 手机端固定位：📁 纯图标钉在 ⋯ 右边（整条顶栏最右），直流/溢出都不含它。 */}
			{mobileAsideItems.map((it) => (
				<Fragment key={it.id}>{it.node}</Fragment>
			))}

			{localeModalOpen && <LocaleModal onClose={() => setLocaleModalOpen(false)} />}
			{pluginMenuAnchor && (
				<PluginMenu
					anchorRect={pluginMenuAnchor.rect}
					anchorEl={pluginMenuAnchor.el}
					plugins={plugins}
					pinnedIds={pinnedPluginIds}
					onTogglePin={(id, pinned) =>
						appSend({ type: "set_settings", uiLayout: setPluginViewPinned(chat.settings?.uiLayout, id, pinned) })
					}
					onOpenView={(id) => {
						setPluginMenuAnchor(null);
						onViewChange(`plugin:${id}`);
					}}
					onClose={() => setPluginMenuAnchor(null)}
				/>
			)}
			{projectPickerOpen && (
				<ProjectPicker
					open
					currentCwd={cwd}
					pathCompletions={chat.pathCompletions ?? []}
					workspaceRoots={workspaceRoots}
					onClose={() => setProjectPickerOpen(false)}
					onSelectDirectory={(path) => appSend({ type: "set_cwd", path })}
					onCreateProject={(path) => appSend({ type: "make_dir", path, setAsCwd: true })}
				/>
			)}
		</header>
	);
}
