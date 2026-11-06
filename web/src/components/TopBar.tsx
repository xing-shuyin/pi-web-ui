import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { BrandDeviceMenu } from "./BrandDeviceMenu";
import {
	FiBox,
	FiDownload,
	FiEdit2,
	FiFeather,
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
} from "react-icons/fi";
import { GoTriangleDown } from "react-icons/go";
import { LuFlaskConical, LuFolders, LuMessageSquareDashed, LuWorkflow } from "react-icons/lu";
import type { ChatState, UpdateAllItem } from "../use-chat";
import type { CommandDef } from "../types";
import { buildUpdateCommand } from "../update-command";
import { randomUuid } from "../uuid";
import { Dropdown, DropdownItem } from "./Dropdown";
import type { ViewName } from "./BarItem";
import { BrowserControl } from "./BrowserControl";
import { BROWSER_PAGE_TOOL_NAME } from "../../../server/tool-manager.js";
import { PluginIcon } from "../plugin-icon";
import { formatCostDisplay } from "../cost-format";
import { isZhLocale, useI18n, localeShort } from "../i18n";
import {
	isPluginViewItem,
	REQUIRED_TOPBAR_ITEM_IDS,
	restoreUiItem,
	setPluginViewOrder,
	setPluginViewPinned,
	type UiSlotEntry,
	type UiSlotId,
} from "../ui-slots";
import { fitTopbar, MOBILE_ASIDE_TOPBAR_IDS, sortOverflowMenuItems } from "../topbar-fit";
import { openContextMenu } from "../context-menu-state";
import {
	appSend,
	useAppField,
	useAppGlobals,
	useEngineCapabilities,
	useIsDsh,
	useIsManaged,
	useServiceInfo,
} from "../app-globals";
import { ProjectPicker } from "./ProjectPicker";
import { PluginMenu } from "./PluginMenu";
import { PluginManagerModal } from "./PluginManagerModal";
import { LocaleModal } from "./LocaleModal";
import { focusComposer } from "../composer-bridge";
import { useFloatingPanel } from "../use-floating-panel";
import { isDesktopShell } from "../desktop";
import { desktopReleasesUrl, useDesktopUpdater } from "../desktop-updater";
import { BarItem } from "./BarItem";
import { EnginePicker } from "./EnginePicker";
import { WindowControls } from "./WindowControls";
import { NativeCliCreateEntry } from "./NativeCliCreateModal";

const PI_CORE_ITEM: UpdateAllItem = {
	name: "@earendil-works/pi-coding-agent",
	kind: "pi-core",
	current: "",
	latest: null,
	upToDate: false,
};

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
	const {
		panelRef: menuRef,
		style,
		measure,
	} = useFloatingPanel({
		open,
		anchor: anchorRef,
		onClose,
	});

	useLayoutEffect(() => {
		if (open) measure();
	}, [open, children, measure]);

	if (!open) return null;
	return createPortal(
		<div ref={menuRef} className="plugin-topbar-menu portal" role="menu" style={style}>
			{children}
		</div>,
		document.body,
	);
}

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
		select?: (id: string) => void;
	};
	view: ViewName;
	onViewChange: (view: ViewName, opts?: { skipAutoCreate?: boolean }) => void;
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
	uiPrimary?: UiSlotEntry[];
	uiOverflow?: UiSlotEntry[];
	onUiAction?: (item: UiSlotEntry, value?: string) => void;
	uiContextTopbar?: UiSlotEntry[];
	onOpenPanel: (side: "left" | "right") => void;
	onOpenSettings: () => void;
	onManagePlugins: () => void;
	onOpenBgTasks: () => void;
	/** Open the global search panel (sessions / projects / workspace files). */
	onOpenGlobalSearch: () => void;
	themes: {
		id: string;
		name: string;
		builtin: boolean;
		nameEn?: string;
		group?: "classic" | "builtin";
		scheme?: "dark" | "light";
	}[];
	theme: string | null;
	onThemeChange: (id: string | null) => void;
	reloadThemes: () => void;
	onOpenIconEdit: () => void;
	zenMode?: boolean;
	onToggleZenMode?: () => void;
	onOpenSandboxModal?: () => void;
	onCreateCli?: (cwd?: string) => void;
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
	onManagePlugins,
	onOpenBgTasks,
	onOpenGlobalSearch,
	themes,
	theme,
	onThemeChange,
	reloadThemes,
	onOpenIconEdit,
	zenMode,
	onToggleZenMode,
	onOpenSandboxModal,
	onCreateCli,
}: TopBarProps) {
	const { locale, setLocale, t, packs } = useI18n();
	const [topbarMenuOpen, setTopbarMenuOpen] = useState(false);
	const [projectPickerOpen, setProjectPickerOpen] = useState(false);
	const [pluginMenuAnchor, setPluginMenuAnchor] = useState<{ rect: DOMRect; el: HTMLElement } | null>(null);
	const [pluginManagerOpen, setPluginManagerOpen] = useState(false);
	const [pluginManagerFocusId, setPluginManagerFocusId] = useState<string | null>(null);
	const cwd = useAppField("cwd");
	const workspaceRoots = useAppField("workspaceRoots");
	const isDsh = useIsDsh();
	const capabilities = useEngineCapabilities();
	const supportsEphemeral = Boolean(capabilities.ephemeralChat !== false && !isDsh);
	const cwdClickTimerRef = useRef<number | null>(null);
	useEffect(() => {
		return () => {
			if (cwdClickTimerRef.current !== null) {
				window.clearTimeout(cwdClickTimerRef.current);
			}
		};
	}, []);
	const moreBtnRef = useRef<HTMLButtonElement>(null);
	const tabOn = (tab: string) => !chat.tabs || tab === "chat" || chat.tabs.includes(tab);
	const pinnedOverflowItems = [...(uiOverflow ?? [])].filter(
		(it) => !(it.source === "host" && it.id === "host:brand") && !isPluginViewItem(it),
	);
	const pinnedPluginIds = new Set(
		[...(uiPrimary ?? []), ...(uiOverflow ?? [])]
			.filter((e) => isPluginViewItem(e) && !e.hidden)
			.map((e) => e.source.slice("plugin:".length)),
	);
	const pluginOrderRank = new Map((chat.settings?.uiLayout?.order ?? []).map((id, index) => [id, index]));
	const orderedPluginIds = plugins
		.map((plugin, index) => ({ id: plugin.id, index }))
		.sort(
			(a, b) =>
				(pluginOrderRank.get(`${a.id}:__view`) ?? 1_000_000 + a.index) -
				(pluginOrderRank.get(`${b.id}:__view`) ?? 1_000_000 + b.index),
		)
		.map((plugin) => plugin.id);
	const FALLBACK_TOPBAR_IDS = [
		"host:history",
		"host:brand",
		"host:worktrees",
		"host:engine",
		"host:open-project",
		"host:chat",
		"host:terminal",
		"host:git",
		"host:canvas",
		"host:plugins",
		"host:search",
		"host:browser",
		"host:tasks",
		"host:zen-mode",
		"host:device-center",
		"host:settings",
		"host:language",
		"host:theme",
		"host:update",
		"host:github",
		"host:new-chat",
		"host:new-ephemeral-chat",
		"host:new-sandbox",
		"host:files",
	];
	const topEntries: { id: string; entry: UiSlotEntry | null }[] =
		uiPrimary !== undefined
			? uiPrimary.map((e) => ({ id: e.id, entry: e }))
			: FALLBACK_TOPBAR_IDS.map((id) => ({ id, entry: null }));
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
				onViewChange("chat");
				appSend({ type: "new_chat" });
				focusComposer();
				return true;
			case "host:new-ephemeral-chat":
				onViewChange("chat");
				appSend({ type: "new_chat", ephemeral: true });
				focusComposer();
				return true;
			case "host:new-sandbox":
				onOpenSandboxModal?.();
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
			case "host:zen-mode":
				onToggleZenMode?.();
				return true;
			case "host:worktrees":
				onViewChange("worktrees");
				return true;
			case "host:device-center":
				onViewChange("devices");
				return true;
			case "host:settings":
				onOpenSettings();
				return true;
			case "host:plugins":
				setPluginMenuAnchor(
					moreBtnRef.current ? { rect: moreBtnRef.current.getBoundingClientRect(), el: moreBtnRef.current } : null,
				);
				return true;
			default:
				return false;
		}
	};

	const openItemMenu = (e: React.MouseEvent, id: string, label: string) => {
		e.preventDefault();
		e.stopPropagation();
		const layout = chat.settings?.uiLayout;
		const setItemSlot = (targetSlot: UiSlotId) => {
			const slots = { ...layout?.slots, [id]: targetSlot };
			const align = { ...layout?.align };
			if ((targetSlot === "sidebar.left" || targetSlot === "sidebar.right") && !align[id]) {
				align[id] = "center";
			}
			appSend({ type: "set_settings", uiLayout: { ...layout, slots, ...(align[id] ? { align } : {}) } });
		};
		const hideItem = () => {
			const hidden = new Set(layout?.hidden ?? []);
			hidden.add(id);
			const shown = (layout?.shown ?? []).filter((x) => x !== id);
			appSend({ type: "set_settings", uiLayout: { ...layout, hidden: [...hidden], shown } });
		};
		const restoreItem = () => {
			appSend({ type: "set_settings", uiLayout: restoreUiItem(layout, id) });
		};
		const menuEntries: UiSlotEntry[] = [
			{
				id: "host:move-bottom",
				slot: "contextmenu.topbar",
				source: "host",
				label: t("moveToBottom"),
				kind: "action",
				order: 10,
				align: "start",
				hidden: false,
				userOverrides: [],
				arrangedBy: [],
			},
			{
				id: "host:move-left",
				slot: "contextmenu.topbar",
				source: "host",
				label: t("moveToLeft"),
				kind: "action",
				order: 20,
				align: "start",
				hidden: false,
				userOverrides: [],
				arrangedBy: [],
			},
			{
				id: "host:move-right",
				slot: "contextmenu.topbar",
				source: "host",
				label: t("moveToRight"),
				kind: "action",
				order: 30,
				align: "start",
				hidden: false,
				userOverrides: [],
				arrangedBy: [],
			},
		];
		if (!REQUIRED_TOPBAR_ITEM_IDS.has(id)) {
			menuEntries.push({
				id: "host:hide-item",
				slot: "contextmenu.topbar",
				source: "host",
				label: t("uiLayoutHide"),
				kind: "action",
				order: 40,
				align: "start",
				hidden: false,
				userOverrides: [],
				arrangedBy: [],
			});
		}
		const hasCustomization = Boolean(
			layout?.slots?.[id] || layout?.labels?.[id] || layout?.align?.[id] || layout?.order?.includes(id),
		);
		if (hasCustomization) {
			menuEntries.push({
				id: "host:restore-item",
				slot: "contextmenu.topbar",
				source: "host",
				label: t("uiLayoutRestore"),
				kind: "action",
				order: 50,
				align: "start",
				hidden: false,
				userOverrides: [],
				arrangedBy: [],
			});
		}
		if (uiContextTopbar && uiContextTopbar.length > 0) {
			menuEntries.push(...uiContextTopbar);
		}
		openContextMenu({
			x: e.clientX,
			y: e.clientY,
			slot: "contextmenu.topbar",
			target: { id, label },
			entries: menuEntries,
			onHostAction: (entry) => {
				if (entry.id === "host:move-bottom") setItemSlot("bottombar");
				else if (entry.id === "host:move-left") setItemSlot("sidebar.left");
				else if (entry.id === "host:move-right") setItemSlot("sidebar.right");
				else if (entry.id === "host:hide-item") hideItem();
				else if (entry.id === "host:restore-item") restoreItem();
			},
		});
	};
	const { appVersion } = useAppGlobals();
	const managed = useIsManaged();
	const service = useServiceInfo();
	const [restarting, setRestarting] = useState(false);
	useEffect(() => {
		if (restarting && chat.status === "open") setRestarting(false);
	}, [restarting, chat.status]);
	const [langOpen, setLangOpen] = useState(false);
	const [themeOpen, setThemeOpen] = useState(false);
	const [updateOpen, setUpdateOpen] = useState(false);
	const inDesktopShell = isDesktopShell();
	const desktopUpdater = useDesktopUpdater();
	const [localeModalOpen, setLocaleModalOpen] = useState(false);

	const updateTermIdsRef = useRef<Set<string>>(new Set());

	useEffect(() => {
		if (updateTermIdsRef.current.size === 0) return;
		let finished = false;
		for (const tid of Array.from(updateTermIdsRef.current)) {
			const tm = chat.terminals.find((t) => t.id === tid);
			if (tm && !tm.running) {
				updateTermIdsRef.current.delete(tid);
				finished = true;
			}
		}
		if (finished && chat.ready) {
			appSend({ type: "check_update" });
			appSend({ type: "check_updates_all", force: true });
		}
	}, [chat.terminals, chat.ready]);

	const runUpdate = () => {
		if (!chat.ready) return;
		const title = t("updateTabTitle");
		const cmd: CommandDef = {
			name: title,
			command: "npm i -g pi-web-ui@latest",
			cwd: "${pwd}",
		};
		const existing = chat.terminals.find((tm) => tm.title === title);
		const targetId = existing ? existing.id : randomUuid();
		if (existing) {
			updateTermIdsRef.current.add(existing.id);
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
			updateTermIdsRef.current.add(targetId);
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
		setUpdateOpen(false);
		terminal.select?.(targetId);
		onViewChange("terminal", { skipAutoCreate: true });
	};

	const runPkgUpdate = (items: UpdateAllItem[], title: string) => {
		if (!chat.ready || items.length === 0) return;
		const cmd: CommandDef = {
			name: title,
			command: buildUpdateCommand(items),
			cwd: "${pwd}",
		};
		const existing = chat.terminals.find((tm) => tm.title === title);
		const targetId = existing ? existing.id : randomUuid();
		if (existing) {
			updateTermIdsRef.current.add(existing.id);
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
			updateTermIdsRef.current.add(targetId);
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
		setUpdateOpen(false);
		terminal.select?.(targetId);
		onViewChange("terminal", { skipAutoCreate: true });
	};

	const allUpdates = chat.updatesAll ?? [];
	const sdkInfo = chat.updatesSdk;
	const sdkSplit =
		sdkInfo && sdkInfo.newerInstalled ? { running: sdkInfo.running, installed: sdkInfo.newerInstalled } : null;
	const bundledInUse = sdkInfo?.bundledInUse === true;
	const coreRow = allUpdates.find((i) => i.kind === "pi-core" && !i.error);
	const bundledRelevant = bundledInUse && (!coreRow || !coreRow.upToDate);
	const bundledButton = bundledRelevant && !coreRow;
	const updatesCount = allUpdates.filter((i) => !i.upToDate && !i.error).length;
	const updatable = allUpdates.filter((i) => !i.upToDate && !i.error && i.kind !== "webui");
	const gitDisplayName = (item: UpdateAllItem) =>
		item.kind === "git-extension" && item.source ? item.source : item.name;
	const gitNameTitle = (item: UpdateAllItem) =>
		item.kind === "git-extension" && item.source && item.source !== item.name
			? `${item.source} (${item.name})`
			: item.name;
	const stripGitSha = (v: string) => {
		const s = v.replace(/ \([0-9a-f]{7}\)$/, "");
		return /^[0-9a-f]{7}$/.test(s) ? "" : s;
	};
	const extractGitSha = (v: string) => {
		const m = v.match(/\(([0-9a-f]{7})\)$/) ?? v.match(/^([0-9a-f]{7})$/);
		return m?.[1] ?? null;
	};
	const shortGitRange = (current: string, latest: string | null) => {
		if (!latest) return stripGitSha(current);
		const c = stripGitSha(current);
		const l = stripGitSha(latest);
		if (c !== l) return `${c} → ${l}`;
		const cSha = extractGitSha(current);
		const lSha = extractGitSha(latest);
		if (cSha && lSha && cSha !== lSha) {
			return c ? `${c} (${cSha} → ${lSha})` : `${cSha} → ${lSha}`;
		}
		return c;
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
					{allUpdates.map((item) => {
						const splitRow = sdkSplit != null && item.kind === "pi-core";
						const warn = !item.error && (!item.upToDate || splitRow);
						return (
							<li
								key={`${item.kind}:${item.name}`}
								className={`dd-all-item${item.error ? " err" : warn ? " warn" : ""}`}
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
												: item.kind === "engine"
													? t("kindEngine")
													: item.kind === "git-extension"
														? t("kindGitExtension")
														: item.kind === "plugin"
															? t("kindPlugin")
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
											item.kind === "pi-core" && item.current === "unknown" ? (
												t("piCoreUndetected")
											) : (
												t("updateCheckFailed")
											)
										) : item.kind === "git-extension" ? (
											item.upToDate ? (
												stripGitSha(item.current)
											) : (
												shortGitRange(item.current, item.latest)
											)
										) : item.kind === "plugin" ? (
											item.upToDate ? (
												item.current.startsWith("v") ? (
													item.current
												) : (
													stripGitSha(item.current)
												)
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
									{splitRow && !item.error && (
										<span className="dd-split-run">{t("piCoreSplitRun", { running: sdkSplit.running })}</span>
									)}
								</span>
							</li>
						);
					})}
				</ul>
			)}
			{sdkSplit && (
				<div className="dd-note warn">
					{t("piSdkSplitNote", { running: sdkSplit.running, installed: sdkSplit.installed })}
				</div>
			)}
			{bundledRelevant && <div className="dd-note">{t("piSdkBundledNote", { running: sdkInfo!.running })}</div>}
			<div className="dd-actions">
				{bundledButton && (
					<button
						type="button"
						className="dd-refresh accent"
						style={{ flex: 1 }}
						onClick={() => runPkgUpdate([PI_CORE_ITEM], t("installGlobalEngineTabTitle"))}
					>
						{t("installGlobalEngineBtn")}
					</button>
				)}
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
	const renderDesktopUpdater = () => {
		const manualUrl = desktopReleasesUrl(chat.update?.latest ?? desktopUpdater.version);
		const manual = (
			<a className="dd-refresh dd-more-link" href={manualUrl} target="_blank" rel="noreferrer noopener">
				{t("updateDesktopManual")}
			</a>
		);
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

	const isMobile = useIsMobileTopbar();
	const hostNodes: Record<string, ReactNode> = {
		"host:brand": <BrandDeviceMenu />,
		"host:worktrees": chat.state?.worktree ? (
			<button
				type="button"
				className={`tb-tab${view === "worktrees" ? " active" : ""}`}
				title={t("worktreeViewTitle")}
				onClick={() => onViewChange("worktrees")}
			>
				<LuFolders />
				<span>{t("worktreeViewTitle")}</span>
			</button>
		) : null,
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
		"host:history":
			view === "chat" && tabOn("history") ? (
				<button
					type="button"
					className="panel-toggle"
					data-tip={t("openHistory")}
					aria-label={t("openHistory")}
					onClick={() => onOpenPanel("left")}
				>
					<FiMenu />
				</button>
			) : null,
		"host:files":
			view === "chat" && tabOn("files") ? (
				<button
					type="button"
					className="panel-toggle has-label"
					data-tip={t("openFiles")}
					aria-label={t("openFiles")}
					onClick={() => onOpenPanel("right")}
				>
					<FiFolder />
					<span>{t("openFiles")}</span>
				</button>
			) : null,
		"host:new-chat": tabOn("new-chat") ? (
			<NativeCliCreateEntry onCreateCli={onCreateCli}>
				<button
					type="button"
					className="chip newchat"
					data-tip={t("newChatTip")}
					onClick={() => {
						onViewChange("chat");
						appSend({ type: "new_chat" });
						focusComposer();
					}}
				>
					<FiPlus />
					<span>{t("newChat")}</span>
				</button>
			</NativeCliCreateEntry>
		) : null,
		"host:new-ephemeral-chat": !supportsEphemeral ? null : (
			<button
				type="button"
				className="chip newchat ephemeral-chat-btn"
				data-tip={t("newChatEphemeralTip")}
				onClick={() => {
					onViewChange("chat");
					appSend({ type: "new_chat", ephemeral: true });
					focusComposer();
				}}
			>
				<LuMessageSquareDashed />
				<span>{t("newChatEphemeral")}</span>
			</button>
		),
		"host:new-sandbox": (
			<button
				type="button"
				className="chip newchat sandbox-chip"
				data-tip={t("newSandboxTip")}
				aria-label={t("newSandboxTip")}
				onClick={() => onOpenSandboxModal?.()}
			>
				<LuFlaskConical />
				<span>{t("newSandbox")}</span>
			</button>
		),
		"host:chat":
			view !== "chat" && view !== "native-cli" ? (
				<button
					type="button"
					role="tab"
					aria-selected={false}
					className="tb-tab"
					data-tip={t("chat")}
					onClick={() => onViewChange("chat")}
				>
					<FiMessageSquare />
					<span>{t("chat")}</span>
				</button>
			) : null,
		"host:native-cli": null,
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
		"host:canvas": tabOn("canvas") ? (
			<button
				type="button"
				role="tab"
				aria-selected={view === "canvas"}
				className={`tb-tab${view === "canvas" ? " active" : ""}`}
				data-tip={t("canvasTab")}
				onClick={() => onViewChange("canvas")}
			>
				<LuWorkflow />
				<span>{t("canvasTab")}</span>
			</button>
		) : null,
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
				<FiBox aria-hidden />
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
		"host:zen-mode": (
			<button
				type="button"
				className={`chip chip-zen${zenMode ? " active" : ""}`}
				data-tip={t("zenModeTip")}
				onClick={onToggleZenMode}
				aria-label={t("zenMode")}
				aria-pressed={zenMode}
			>
				<FiFeather />
				<span className="chip-sub">{t("zenMode")}</span>
			</button>
		),
		"host:device-center": (
			<button
				type="button"
				className="chip"
				data-tip={t("deviceCenterTip")}
				onClick={() => onViewChange("devices")}
				aria-pressed={view === "devices"}
			>
				<FiGlobe />
				<span className="chip-sub">{t("deviceCenter")}</span>
			</button>
		),
		"host:settings": (
			<button type="button" className="chip" data-tip={t("settingsTitle")} onClick={onOpenSettings}>
				<FiSettings />
				<span className="chip-sub">{t("settings")}</span>
			</button>
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
				caret={false}
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
				caret={false}
				onOpenChange={(v) => {
					setThemeOpen(v);
					if (v && themes.length === 0) reloadThemes();
				}}
			>
				{(() => {
					const classics = themes.filter((th) => th.group === "classic");
					const builtins = themes.filter((th) => th.group !== "classic");
					const themeLabel = (th: (typeof themes)[number]) => {
						const base = isZhLocale(locale) ? th.name : (th.nameEn ?? th.name);
						const scheme = th.scheme === "light" ? t("themeLight") : th.scheme === "dark" ? t("themeDark") : "";
						if (!scheme) return base;
						return isZhLocale(locale) ? `${base}（${scheme}）` : `${base} (${scheme})`;
					};
					return (
						<>
							{classics.length > 0 && (
								<>
									<div className="dd-header">{t("themeGroupClassics")}</div>
									{classics.map((th) => (
										<DropdownItem
											key={th.id}
											active={theme === th.id}
											onClick={() => {
												onThemeChange(th.id);
												setThemeOpen(false);
											}}
										>
											{themeLabel(th)}
										</DropdownItem>
									))}
								</>
							)}
							<div className="dd-header">{classics.length > 0 ? t("themeGroupBuiltin") : t("theme")}</div>
							<DropdownItem
								active={theme === null}
								onClick={() => {
									onThemeChange(null);
									setThemeOpen(false);
								}}
							>
								{t("themeDefault")}
							</DropdownItem>
							{builtins.map((th) => (
								<DropdownItem
									key={th.id}
									active={theme === th.id}
									onClick={() => {
										onThemeChange(th.id);
										setThemeOpen(false);
									}}
								>
									{themeLabel(th)}
								</DropdownItem>
							))}
						</>
					);
				})()}
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
				caret={false}
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
		"host:conn": (
			<span className="chip" data-tip={chat.status}>
				<span className={`status-dot ${chat.status === "open" ? "ok" : "busy"}`} />
				<span className="chip-sub">{chat.status}</span>
			</span>
		),
		"host:engine": <EnginePicker direction="down" align="left" caret={false} bar="top" />,
		"host:ctx": (
			<span className="chip" data-tip={t("contextUsage")}>
				<span className="chip-sub">
					{(chat.state?.stats?.contextUsage?.tokens ?? 0) > 0
						? `${chat.state?.stats?.contextUsage?.tokens}`
						: t("contextUsage")}
				</span>
			</span>
		),
		"host:cost": (() => {
			const chipCost = formatCostDisplay(chat.state?.stats?.cost ?? 0, { fixedDigits: 4 });
			return (
				<span className="chip" data-tip={chipCost.tooltip || t("cumulativeCost")}>
					<span className="chip-sub">
						{chipCost.symbol}
						{chipCost.value}
					</span>
				</span>
			);
		})(),
		"host:cwd": (
			<button
				type="button"
				className="chip"
				data-tip={chat.state?.cwd ?? ""}
				onClick={() => {
					if (cwdClickTimerRef.current !== null) {
						window.clearTimeout(cwdClickTimerRef.current);
						cwdClickTimerRef.current = null;
					}
					cwdClickTimerRef.current = window.setTimeout(() => {
						setProjectPickerOpen(true);
						cwdClickTimerRef.current = null;
					}, 220);
				}}
				onDoubleClick={(e) => {
					e.preventDefault();
					e.stopPropagation();
					if (cwdClickTimerRef.current !== null) {
						window.clearTimeout(cwdClickTimerRef.current);
						cwdClickTimerRef.current = null;
					}
					appSend({ type: "new_chat" });
					focusComposer();
				}}
			>
				<FiFolder />
				<span className="chip-sub">{chat.state?.cwd?.split(/[/\\]/).pop() || chat.state?.cwd}</span>
			</button>
		),
	};

	const TABS_GATED_IDS = new Set(["host:search", "host:tasks", "host:settings", "host:plugins"]);
	const OVERFLOW_AS_NODE_IDS = new Set(["host:language", "host:theme", "host:update", "host:browser", "host:engine"]);
	const isTabGatedOff = (id: string) => TABS_GATED_IDS.has(id) && !tabOn(id.slice("host:".length));
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
	const flowItems: { id: string; entry: UiSlotEntry | null; node: ReactNode }[] = [];
	for (const it of topEntries) {
		if (it.id === "host:native-cli" || (it.id === "host:chat" && (view === "chat" || view === "native-cli"))) continue;
		if (it.entry?.hidden) continue;
		if (isTabGatedOff(it.id)) continue;
		if (it.id === "host:worktrees" && !chat.state?.worktree) continue;
		let node: ReactNode = null;
		if (it.entry) {
			node = (
				<BarItem
					key={it.id}
					entry={it.entry}
					bar="top"
					chat={chat}
					view={view}
					plugins={plugins}
					onViewChange={onViewChange}
					onOpenPanel={onOpenPanel}
					onOpenSettings={onOpenSettings}
					onOpenGlobalSearch={onOpenGlobalSearch}
					onOpenBgTasks={onOpenBgTasks}
					onOpenProjectPicker={() => setProjectPickerOpen(true)}
					isProjectPickerOpen={projectPickerOpen}
					onOpenPluginMenu={(el) =>
						setPluginMenuAnchor((prev) => (prev?.el === el ? null : { rect: el.getBoundingClientRect(), el }))
					}
					isPluginMenuOpen={pluginMenuAnchor !== null}
					onUiAction={onUiAction}
					uiContextEntries={uiContextTopbar}
					zenMode={zenMode}
					onToggleZenMode={onToggleZenMode}
					onOpenSandboxModal={onOpenSandboxModal}
					onCreateCli={onCreateCli}
					dropdownProps={{
						theme,
						themes,
						onThemeChange,
						reloadThemes,
						onLocaleModalOpen: () => setLocaleModalOpen(true),
						renderUpdateBody,
						renderAllUpdatesBody,
						updatesCount,
						managed,
						appVersion,
					}}
				/>
			);
		} else if (it.id.startsWith("host:") && hostNodes[it.id]) {
			node = hostNodes[it.id];
		}
		if (!node) continue;
		flowItems.push({ id: it.id, entry: it.entry, node });
	}
	for (const b of brokenViewEntries) {
		const node = (
			<BarItem
				key={b.id}
				entry={b}
				bar="top"
				chat={chat}
				view={view}
				plugins={plugins}
				onViewChange={onViewChange}
				onUiAction={onUiAction}
				uiContextEntries={uiContextTopbar}
			/>
		);
		if (node) flowItems.push({ id: b.id, entry: b, node });
	}
	const zoneOf = (it: { entry: UiSlotEntry | null }): "start" | "center" | "end" => it.entry?.align ?? "start";
	const [droppedIds, setDroppedIds] = useState<ReadonlySet<string>>(() => new Set<string>());
	const flowRef = useRef<HTMLDivElement>(null);
	const widthCacheRef = useRef(new Map<string, number>());
	const keptItems = flowItems.filter((it) => !droppedIds.has(it.id));
	const mobileAsideItems = isMobile ? keptItems.filter((it) => MOBILE_ASIDE_TOPBAR_IDS.has(it.id)) : [];
	const flowKeptItems = isMobile ? keptItems.filter((it) => !MOBILE_ASIDE_TOPBAR_IDS.has(it.id)) : keptItems;
	const fitBase = isMobile ? flowItems.filter((it) => !MOBILE_ASIDE_TOPBAR_IDS.has(it.id)) : flowItems;
	const visualAll = [
		...fitBase.filter((it) => zoneOf(it) === "start"),
		...fitBase.filter((it) => zoneOf(it) === "center"),
		...fitBase.filter((it) => zoneOf(it) === "end"),
	];
	const keptVisual = visualAll.filter((it) => !droppedIds.has(it.id));
	const visualAllRef = useRef(visualAll);
	const keptVisualRef = useRef(keptVisual);
	useLayoutEffect(() => {
		visualAllRef.current = visualAll;
		keptVisualRef.current = keptVisual;
	});
	const measure = () => {
		const flow = flowRef.current;
		if (!flow || typeof ResizeObserver === "undefined") return;
		const kids = Array.from(flow.children).filter((el) => !el.classList.contains("tb-spacer"));
		const kept = keptVisualRef.current;
		if (kids.length === kept.length) {
			kept.forEach((it, i) => widthCacheRef.current.set(it.id, (kids[i] as HTMLElement).offsetWidth));
		}
		for (const child of kids) {
			const el = child as HTMLElement;
			if (
				el.offsetWidth > 0 &&
				flow.clientWidth > 0 &&
				el.offsetLeft + el.offsetWidth / 2 < Math.min(220, flow.clientWidth / 2)
			) {
				el.setAttribute("data-tip-align", "right");
			} else {
				el.removeAttribute("data-tip-align");
			}
		}
		const gap = Number.parseFloat(getComputedStyle(flow).columnGap) || 0;
		const fitInput = visualAllRef.current;
		const next = fitTopbar(
			fitInput.map((it) => ({ id: it.id, width: it.entry ? (widthCacheRef.current.get(it.id) ?? 0) : 0 })),
			flow.clientWidth,
			gap,
			0,
			new Set([...REQUIRED_TOPBAR_ITEM_IDS, "host:worktrees"]),
		);
		setDroppedIds((prev) => (prev.size === next.size && [...next].every((id) => prev.has(id)) ? prev : next));
	};
	const measureKey = `${keptItems.map((it) => `${it.id}:${it.entry?.label ?? ""}`).join("|")}|${view}|${(
		chat.tabs ?? []
	).join(",")}|${isMobile ? "m" : "d"}`;
	useLayoutEffect(measure, [measureKey]); // eslint-disable-line react-hooks/exhaustive-deps
	useEffect(() => {
		const flow = flowRef.current;
		if (!flow || typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(() => measure());
		ro.observe(flow);
		return () => ro.disconnect();
	}, [measureKey]); // eslint-disable-line react-hooks/exhaustive-deps
	const segStart = flowKeptItems.filter((it) => zoneOf(it) === "start");
	const segCenter = flowKeptItems.filter((it) => zoneOf(it) === "center");
	const segEnd = flowKeptItems.filter((it) => zoneOf(it) === "end");
	const droppedEntries = flowItems.filter((it) => droppedIds.has(it.id) && it.entry).map((it) => it.entry!);
	const slotRank = new Map<string, number>();
	[...(uiPrimary ?? []), ...(uiOverflow ?? [])].forEach((e, i) => {
		if (!slotRank.has(e.id)) slotRank.set(e.id, i);
	});
	const overflowMenuItems = sortOverflowMenuItems(
		[...pinnedOverflowItems, ...droppedEntries],
		(id) => slotRank.get(id) ?? 999999,
	);

	const menuIcon = (it: UiSlotEntry): string | null => (it.icon && !/[a-z]/i.test(it.icon) ? it.icon : null);

	const hideTopbarText = chat.settings?.uiLayout?.topbarText === false;
	return (
		<header className={`topbar${hideTopbarText ? " no-labels" : ""}`} data-pi-anchor="topbar">
			<div className="topbar-flow" ref={flowRef} role="toolbar" aria-label={t("viewSwitch")}>
				{segStart.map((it) => (
					<Fragment key={it.id}>{it.node}</Fragment>
				))}
				{(segCenter.length > 0 || segEnd.length > 0) && (
					<span
						className={`tb-spacer${segCenter.length === 0 && segEnd.length > 0 ? " tb-spacer-end" : ""}`}
						aria-hidden="true"
					/>
				)}
				{segCenter.map((it) => (
					<Fragment key={it.id}>{it.node}</Fragment>
				))}
				{segCenter.length > 0 && (
					<span className={`tb-spacer${segEnd.length > 0 ? " tb-spacer-end" : ""}`} aria-hidden="true" />
				)}
				{segEnd.map((it) => (
					<Fragment key={it.id}>{it.node}</Fragment>
				))}
			</div>
			{(overflowMenuItems.length > 0 || flowItems.length > 0) && (
				<div className="plugin-topbar-more">
					<button
						ref={moreBtnRef}
						type="button"
						className="plugin-topbar-item"
						aria-haspopup="menu"
						aria-expanded={topbarMenuOpen}
						aria-label={t("pluginTopbarMore")}
						data-tip={t("pluginTopbarMore")}
						onClick={() => setTopbarMenuOpen((v) => !v)}
					>
						<GoTriangleDown />
					</button>
					<TopbarOverflowMenu anchorRef={moreBtnRef} open={topbarMenuOpen} onClose={() => setTopbarMenuOpen(false)}>
						{overflowMenuItems.map((it) => {
							const asNode = it.source === "host" && OVERFLOW_AS_NODE_IDS.has(it.id) ? hostNodes[it.id] : undefined;
							if (asNode !== undefined) {
								return <Fragment key={it.id}>{asNode}</Fragment>;
							}
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
							if (it.kind === "select" && it.options?.length) {
								return (
									<label key={it.id} className="plugin-topbar-overflow-select tb-row" title={it.hint ?? it.label}>
										{menuIcon(it) ? <span className="plugin-icon-glyph">{menuIcon(it)}</span> : null}
										<span className="tb-row-text">{it.label}</span>
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
									className="tb-row"
									title={it.hint ?? it.label}
									onClick={() => {
										setTopbarMenuOpen(false);
										if (!dispatchHostOverflow(it)) onUiAction?.(it);
									}}
								>
									{menuIcon(it) ? <span className="plugin-icon-glyph">{menuIcon(it)}</span> : null}
									<span className="tb-row-text">{it.label}</span>
								</button>
							);
						})}
						<div className="tb-menu-divider" aria-hidden="true" />
						<button
							type="button"
							role="menuitem"
							className="tb-row"
							onClick={() => {
								setTopbarMenuOpen(false);
								onOpenIconEdit();
							}}
						>
							<FiEdit2 />
							<span className="tb-row-text">{t("uiIconEdit")}</span>
						</button>
					</TopbarOverflowMenu>
				</div>
			)}

			{mobileAsideItems.map((it) => (
				<Fragment key={it.id}>{it.node}</Fragment>
			))}

			<WindowControls />

			{localeModalOpen && <LocaleModal onClose={() => setLocaleModalOpen(false)} />}
			{pluginMenuAnchor && (
				<PluginMenu
					anchorRect={pluginMenuAnchor.rect}
					anchorEl={pluginMenuAnchor.el}
					plugins={plugins.map((p) => {
						const full = (chat.plugins ?? []).find((cp) => cp.id === p.id);
						return {
							...p,
							hasSettings: Boolean(full?.settingsSchema && full.settingsSchema.length > 0),
						};
					})}
					pinnedIds={pinnedPluginIds}
					orderedPluginIds={orderedPluginIds}
					onTogglePin={(id, pinned) =>
						appSend({ type: "set_settings", uiLayout: setPluginViewPinned(chat.settings?.uiLayout, id, pinned) })
					}
					onReorder={(ids) =>
						appSend({ type: "set_settings", uiLayout: setPluginViewOrder(chat.settings?.uiLayout, ids) })
					}
					onOpenView={(id) => {
						setPluginMenuAnchor(null);
						onViewChange(`plugin:${id}`);
					}}
					onOpenPluginSettings={(focusId) => {
						setPluginManagerFocusId(focusId ?? null);
						setPluginManagerOpen(true);
					}}
					onManagePlugins={onManagePlugins}
					onClose={() => setPluginMenuAnchor(null)}
				/>
			)}
			{pluginManagerOpen && (
				<PluginManagerModal
					open={pluginManagerOpen}
					onClose={() => {
						setPluginManagerOpen(false);
						setPluginManagerFocusId(null);
					}}
					focusPluginId={pluginManagerFocusId}
					plugins={chat.plugins ?? []}
					disabledPlugins={chat.settings?.disabledPlugins ?? []}
					models={chat.settings?.subagentModels ?? []}
					onTogglePlugin={(p) => {
						const disabled = new Set(chat.settings?.disabledPlugins ?? []);
						if (disabled.has(p.id)) disabled.delete(p.id);
						else disabled.add(p.id);
						appSend({ type: "set_settings", disabledPlugins: [...disabled] });
					}}
					onOpenView={(id) => {
						setPluginManagerOpen(false);
						onViewChange(`plugin:${id}`);
					}}
					onOpenMarketplace={() => {
						setPluginManagerOpen(false);
						onManagePlugins();
					}}
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
