import { useEffect, useRef, useState, type ReactNode, type MouseEvent as ReactMouseEvent } from "react";
import {
	FiActivity,
	FiBox,
	FiCpu,
	FiDatabase,
	FiDownload,
	FiFeather,
	FiFolder,
	FiFolderPlus,
	FiGitBranch,
	FiGithub,
	FiGlobe,
	FiLayers,
	FiMenu,
	FiMessageSquare,
	FiPlus,
	FiSearch,
	FiSettings,
	FiSun,
	FiTerminal,
} from "react-icons/fi";
import { LuFlaskConical, LuFolders, LuMessageSquareDashed, LuWorkflow } from "react-icons/lu";
import { REQUIRED_TOPBAR_ITEM_IDS, restoreUiItem, type UiSlotEntry, type UiSlotId } from "../ui-slots";
import type { ChatState } from "../use-chat";
import { useFormattedCost } from "../cost-format";
import { isZhLocale, useT, useI18n } from "../i18n";
import { useAppGlobals, appSend } from "../app-globals";
import { PluginIcon } from "../plugin-icon";
import { BrandDeviceMenu } from "./BrandDeviceMenu";
import { focusComposer } from "../composer-bridge";
import { openContextMenu } from "../context-menu-state";
import { cacheMetrics, estimateStreamTokens, streamRate, trimRateSamples, type RateSample } from "../cache-stats";
import { Dropdown, DropdownItem } from "./Dropdown";
import { BrowserControl } from "./BrowserControl";
import { BROWSER_PAGE_TOOL_NAME } from "../../../server/tool-manager.js";
import { EnginePicker } from "./EnginePicker";
import { NativeCliCreateEntry } from "./NativeCliCreateModal";
import { ContextUsage } from "./ContextUsage";
import { formatTokens } from "../format-tokens";

export type ViewName =
	"chat" | "native-cli" | "terminal" | "git" | "canvas" | "devices" | "worktrees" | `plugin:${string}`;

export interface BarItemTheme {
	id: string;
	name: string;
	builtin: boolean;
	nameEn?: string;
	group?: "classic" | "builtin";
	scheme?: "dark" | "light";
}

export interface BarItemProps {
	entry: UiSlotEntry;
	bar: "top" | "bottom" | "left" | "right";
	chat: ChatState;
	view?: ViewName;
	plugins?: { id: string; name?: string; error?: string; icon?: string; iconSvg?: string }[];
	onViewChange?: (view: ViewName) => void;
	onOpenPanel?: (side: "left" | "right") => void;
	onOpenSettings?: (initialSection?: string) => void;
	onOpenGlobalSearch?: () => void;
	onOpenBgTasks?: () => void;
	onOpenProjectPicker?: () => void;
	onOpenPluginMenu?: (el: HTMLElement) => void;
	isPluginMenuOpen?: boolean;
	isProjectPickerOpen?: boolean;
	onUiAction?: (item: UiSlotEntry, value?: string) => void;
	uiContextEntries?: UiSlotEntry[];
	zenMode?: boolean;
	onToggleZenMode?: () => void;
	onOpenSandboxModal?: () => void;
	onCreateCli?: (cwd?: string) => void;
	dropdownProps?: {
		theme?: string | null;
		themes?: BarItemTheme[];
		onThemeChange?: (themeId: string | null) => void;
		reloadThemes?: () => void;
		onLocaleModalOpen?: () => void;
		renderUpdateBody?: () => ReactNode;
		renderAllUpdatesBody?: () => ReactNode;
		updatesCount?: number;
		managed?: boolean;
		appVersion?: string;
	};
}

function localeShort(code: string): string {
	if (code === "zh-TW") return "TW";
	if (code.startsWith("zh")) return "ZH";
	if (code.startsWith("ja")) return "JA";
	if (code.startsWith("ko")) return "KO";
	if (code.startsWith("fr")) return "FR";
	if (code.startsWith("de")) return "DE";
	if (code.startsWith("es")) return "ES";
	if (code.startsWith("ru")) return "RU";
	if (code.startsWith("pt")) return "PT";
	if (code.startsWith("it")) return "IT";
	return "EN";
}

export function BarItem({
	entry,
	bar,
	chat,
	view,
	plugins,
	onViewChange,
	onOpenPanel,
	onOpenSettings,
	onOpenGlobalSearch,
	onOpenBgTasks,
	onOpenProjectPicker,
	onOpenPluginMenu,
	isPluginMenuOpen,
	isProjectPickerOpen,
	onUiAction,
	uiContextEntries,
	dropdownProps,
	zenMode,
	onToggleZenMode,
	onOpenSandboxModal,
	onCreateCli,
}: BarItemProps) {
	const t = useT();
	const { locale, packs, setLocale } = useI18n();
	const { engine } = useAppGlobals();
	const isDsh = engine === "dsh";

	const [langOpen, setLangOpen] = useState(false);
	const [themeOpen, setThemeOpen] = useState(false);
	const [updateOpen, setUpdateOpen] = useState(false);

	const layout = chat.settings?.uiLayout;
	const state = chat.state;
	const stats = state?.stats;
	const isStreaming = state?.isStreaming ?? false;
	const timing = state?.turnTiming;
	const timingRunning = !!timing && timing.finishedAt === undefined;
	const [clockNow, setClockNow] = useState(Date.now);
	useEffect(() => {
		if (entry.id !== "host:working" || !timingRunning) return;
		setClockNow(Date.now());
		const timer = window.setInterval(() => setClockNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [entry.id, timingRunning, timing?.startedAt]);
	const costDisplay = useFormattedCost(stats?.cost ?? 0);

	const samplesRef = useRef<RateSample[]>([]);
	const streamEst = state?.streamingMessage ? estimateStreamTokens(state.streamingMessage.content) : 0;
	useEffect(() => {
		if (!isStreaming) {
			samplesRef.current = [];
			return;
		}
		const now = Date.now();
		const prev = samplesRef.current;
		const last = prev[prev.length - 1];
		if (last && now - last.t < 250) return;
		samplesRef.current = trimRateSamples([...prev, { t: now, out: streamEst }], now);
	}, [isStreaming, streamEst]);

	const rate = isStreaming ? streamRate(samplesRef.current) : 0;

	const cwdClickTimerRef = useRef<number | null>(null);
	useEffect(() => {
		return () => {
			if (cwdClickTimerRef.current !== null) {
				window.clearTimeout(cwdClickTimerRef.current);
			}
		};
	}, []);

	const handleContextMenu = (e: ReactMouseEvent) => {
		e.preventDefault();
		e.stopPropagation();

		const setItemSlot = (targetSlot: UiSlotId) => {
			const slots = { ...layout?.slots, [entry.id]: targetSlot };
			const align = { ...layout?.align };
			if ((targetSlot === "sidebar.left" || targetSlot === "sidebar.right") && !align[entry.id]) {
				align[entry.id] = "center";
			}
			appSend({ type: "set_settings", uiLayout: { ...layout, slots, ...(align[entry.id] ? { align } : {}) } });
		};
		const hideItem = () => {
			const hidden = new Set(layout?.hidden ?? []);
			hidden.add(entry.id);
			const shown = (layout?.shown ?? []).filter((x) => x !== entry.id);
			appSend({ type: "set_settings", uiLayout: { ...layout, hidden: [...hidden], shown } });
		};
		const restoreItem = () => {
			appSend({ type: "set_settings", uiLayout: restoreUiItem(layout, entry.id) });
		};

		const menuEntries: UiSlotEntry[] = [];
		if (bar !== "top") {
			menuEntries.push({
				id: "host:move-top",
				slot: "contextmenu.topbar",
				source: "host",
				label: t("moveToTop"),
				kind: "action",
				order: 10,
				align: "start",
				hidden: false,
				userOverrides: [],
				arrangedBy: [],
			});
		}
		if (bar !== "bottom") {
			menuEntries.push({
				id: "host:move-bottom",
				slot: "contextmenu.topbar",
				source: "host",
				label: t("moveToBottom"),
				kind: "action",
				order: 20,
				align: "start",
				hidden: false,
				userOverrides: [],
				arrangedBy: [],
			});
		}
		if (bar !== "left") {
			menuEntries.push({
				id: "host:move-left",
				slot: "contextmenu.topbar",
				source: "host",
				label: t("moveToLeft"),
				kind: "action",
				order: 30,
				align: "start",
				hidden: false,
				userOverrides: [],
				arrangedBy: [],
			});
		}
		if (bar !== "right") {
			menuEntries.push({
				id: "host:move-right",
				slot: "contextmenu.topbar",
				source: "host",
				label: t("moveToRight"),
				kind: "action",
				order: 40,
				align: "start",
				hidden: false,
				userOverrides: [],
				arrangedBy: [],
			});
		}
		if (!REQUIRED_TOPBAR_ITEM_IDS.has(entry.id)) {
			menuEntries.push({
				id: "host:hide-item",
				slot: "contextmenu.topbar",
				source: "host",
				label: t("uiLayoutHide"),
				kind: "action",
				order: 50,
				align: "start",
				hidden: false,
				userOverrides: [],
				arrangedBy: [],
			});
		}
		const hasOverrides =
			(entry.userOverrides && entry.userOverrides.length > 0) ||
			Boolean(
				layout?.slots?.[entry.id] ||
				layout?.labels?.[entry.id] ||
				layout?.align?.[entry.id] ||
				layout?.order?.includes(entry.id),
			);
		if (hasOverrides) {
			menuEntries.push({
				id: "host:restore-item",
				slot: "contextmenu.topbar",
				source: "host",
				label: t("uiLayoutRestore"),
				kind: "action",
				order: 60,
				align: "start",
				hidden: false,
				userOverrides: [],
				arrangedBy: [],
			});
		}
		if (uiContextEntries && uiContextEntries.length > 0) {
			menuEntries.push(...uiContextEntries);
		}

		openContextMenu({
			x: e.clientX,
			y: e.clientY,
			slot: "contextmenu.topbar",
			target: { id: entry.id, label: entry.label },
			entries: menuEntries,
			onHostAction: (actionEntry) => {
				if (actionEntry.id === "host:move-top") setItemSlot("topbar.primary");
				else if (actionEntry.id === "host:move-bottom") setItemSlot("bottombar");
				else if (actionEntry.id === "host:move-left") setItemSlot("sidebar.left");
				else if (actionEntry.id === "host:move-right") setItemSlot("sidebar.right");
				else if (actionEntry.id === "host:hide-item") hideItem();
				else if (actionEntry.id === "host:restore-item") restoreItem();
			},
		});
	};

	const id = entry.id;
	const custom = entry.labelExplicit ? entry.label : "";
	const named = (fallback: string) => custom || fallback;
	const withName = (value: string) => (custom ? `${custom} ${value}` : value);

	if (entry.kind === "select" && entry.options?.length) {
		const val = entry.options.some((o) => o.value === entry.value) ? (entry.value as string) : entry.options[0]!.value;
		return (
			<select
				className="bar-item bar-item-select"
				title={entry.hint ?? entry.label}
				data-tip={entry.hint ?? entry.label}
				aria-label={entry.label}
				value={val}
				onChange={(e) => onUiAction?.(entry, e.target.value)}
				onContextMenu={handleContextMenu}
				data-bar-item={id}
			>
				{entry.options.map((o) => (
					<option key={o.value} value={o.value}>
						{o.label}
					</option>
				))}
			</select>
		);
	}

	if (id === "host:brand") {
		return <BrandDeviceMenu label={named("pi-web-ui")} barItem onContextMenu={handleContextMenu} />;
	}

	if (id === "host:conn") {
		const connClass = chat.ready ? "ok" : chat.status === "closed" ? "error" : "busy";
		const connLabel = chat.ready ? t("connected") : chat.status === "closed" ? t("reconnecting") : t("connecting");
		const hasLatency =
			chat.ready && typeof chat.latencyMs === "number" && Number.isFinite(chat.latencyMs) && chat.latencyMs >= 0;
		const latencyVal = hasLatency ? Math.round(chat.latencyMs as number) : null;
		const latencyText = latencyVal !== null ? `${latencyVal}ms` : null;
		const latencyClass = latencyVal === null ? "" : latencyVal < 100 ? "ok" : latencyVal < 300 ? "mid" : "warn";
		const connTitle = latencyText ? `${connLabel} · ${t("networkLatency")}: ${latencyText}` : connLabel;
		return (
			<span
				className={`bar-item status-item status-conn ${connClass} bar-item-conn`}
				title={connTitle}
				data-tip={connTitle}
				onContextMenu={handleContextMenu}
				data-bar-item={id}
			>
				<span className={`status-dot ${connClass}`} />
				<span className="status-conn-label bar-item-text">{withName(connLabel)}</span>
				{latencyText && <span className={`status-latency ${latencyClass}`}>{latencyText}</span>}
			</span>
		);
	}

	if (id === "host:engine") {
		return (
			<span
				onContextMenu={handleContextMenu}
				data-bar-item={id}
				className="bar-item-engine-wrap"
				style={{ display: "inline-flex", alignItems: "center" }}
			>
				<EnginePicker
					direction={bar === "bottom" ? "up" : bar === "left" ? "right" : bar === "right" ? "left" : "down"}
					align={entry.align === "end" || bar === "right" ? "right" : "left"}
					caret={false}
					bar={bar}
					portal={true}
					label={entry.labelExplicit ? entry.label : undefined}
				/>
			</span>
		);
	}

	if (id === "host:ctx") {
		const context = stats?.contextUsage;
		const cap = context?.softCap ?? null;
		const hasCap = cap !== null && cap > 0 && cap < (context?.contextWindow ?? 0);
		const effectiveMax = hasCap ? cap : (context?.contextWindow ?? 0);
		const ctxPercent =
			context?.tokens !== null && context?.tokens !== undefined && effectiveMax > 0
				? Math.min(100, Math.round((context.tokens / effectiveMax) * 100))
				: null;
		const usedFormatted =
			context?.tokens !== null && context?.tokens !== undefined ? formatTokens(context.tokens) : null;
		const maxFormatted = effectiveMax > 0 ? formatTokens(effectiveMax) : null;
		const ctxText =
			usedFormatted !== null && maxFormatted !== null && ctxPercent !== null
				? `${usedFormatted} / ${maxFormatted}`
				: "—";
		const ctxRingClass = ctxPercent === null ? "" : ctxPercent >= 80 ? "warn" : ctxPercent >= 50 ? "mid" : "ok";
		const ctxTitle = hasCap
			? `${t("contextUsage")}: ${formatTokens(context?.tokens ?? 0)} / ${formatTokens(cap)} (${t("softCapMarker")}, max ${formatTokens(context?.contextWindow ?? 0)})`
			: cap !== null && cap > 0
				? `${t("contextUsage")}: ${ctxText} · ${t("softCapMarker")}: ${formatTokens(cap)}`
				: `${t("contextUsage")}: ${ctxText}`;
		const strokeDashoffset =
			ctxPercent !== null && ctxPercent > 0 ? +(31.42 * (1 - Math.min(ctxPercent, 100) / 100)).toFixed(2) : 31.42;

		return (
			<ContextUsage
				key={`${chat.engine}:${state?.conversationId ?? state?.sessionId ?? ""}`}
				context={context}
				bar={bar}
				title={ctxTitle}
				onContextMenu={handleContextMenu}
			>
				<svg className={`ctx-ring ${ctxRingClass}`} viewBox="0 0 14 14" width="13" height="13" aria-hidden="true">
					<circle className="ctx-ring-bg" cx="7" cy="7" r="5" />
					{ctxPercent !== null && ctxPercent > 0 && (
						<circle
							className="ctx-ring-fill"
							cx="7"
							cy="7"
							r="5"
							strokeDasharray={31.42}
							strokeDashoffset={strokeDashoffset}
							data-percent={ctxPercent}
						/>
					)}
				</svg>
				<span className="bar-item-text">
					{custom ? `${custom} ` : ""}
					{usedFormatted !== null && maxFormatted !== null ? (
						<>
							<span className="ctx-val">{usedFormatted}</span>
							<span className="status-sep">/</span>
							<span className="ctx-max">{maxFormatted}</span>
						</>
					) : (
						ctxText
					)}
				</span>
			</ContextUsage>
		);
	}

	if (id === "host:cache") {
		const cache = cacheMetrics(stats?.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
		const hitPct = cache.hitRate * 100;
		const hitClass = cache.totalInput === 0 ? "" : cache.hitRate >= 0.7 ? "ok" : cache.hitRate >= 0.4 ? "mid" : "warn";
		const hitText = cache.totalInput > 0 ? `${hitPct.toFixed(1)}%` : "—";
		const cacheTip = t("cacheHitTip", {
			read: formatTokens(cache.read),
			write: formatTokens(cache.write),
			miss: formatTokens(cache.miss),
			input: formatTokens(cache.totalInput),
		});
		const cacheTitle = cache.totalInput > 0 ? `${t("cacheHit")}: ${hitText} · ${cacheTip}` : t("cacheHit");
		const isZero = cache.totalInput === 0;

		return (
			<span
				className={`bar-item status-item status-cache bar-item-cache${isZero ? " is-zero" : ""}`}
				title={cacheTitle}
				data-tip={cacheTitle}
				onContextMenu={handleContextMenu}
				data-bar-item={id}
			>
				<FiDatabase className="bar-item-icon" />
				<span className="bar-item-text">
					{custom ? `${custom} ` : ""}
					<b className={`cache-pct ${hitClass}`}>{hitText}</b>
				</span>
			</span>
		);
	}

	if (id === "host:cost") {
		const cost = stats?.cost ?? 0;
		const costTip = costDisplay.tooltip || t("cumulativeCost");
		const isZero = cost <= 0;
		return (
			<span
				className={`bar-item status-item status-cost bar-item-cost${isZero ? " is-zero" : ""}${custom ? " has-name" : ""}`}
				title={costTip}
				data-tip={costTip}
				onContextMenu={handleContextMenu}
				data-bar-item={id}
			>
				{custom ? <span className="bar-item-text">{custom}</span> : null}
				{costDisplay.symbol ? <span className="bar-item-char">{costDisplay.symbol}</span> : null}
				<span className="bar-item-text">{costDisplay.value}</span>
			</span>
		);
	}

	if (id === "host:msg-count") {
		const count = stats?.totalMessages ?? 0;
		const tip = `${t("sessionMessages")}: ${count}`;
		const isZero = count === 0;
		return (
			<span
				className={`bar-item status-item status-msg-count bar-item-msg-count${isZero ? " is-zero" : ""}`}
				title={tip}
				data-tip={tip}
				onContextMenu={handleContextMenu}
				data-bar-item={id}
			>
				<FiMessageSquare className="bar-item-icon" />
				<span className="bar-item-text">{withName(String(count))}</span>
			</span>
		);
	}

	if (id === "host:working") {
		if (!isStreaming && !timing) return null;
		const working = isStreaming || timingRunning;
		const label = working ? t("working") : t("done");
		const seconds = timing ? Math.max(0, Math.floor(((timing.finishedAt ?? clockNow) - timing.startedAt) / 1000)) : 0;
		const duration =
			seconds < 3600
				? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
				: `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
		const queueTotal = (state?.queue?.steering?.length ?? 0) + (state?.queue?.followUp?.length ?? 0);
		return (
			<span
				className={`bar-item status-item bar-item-working${working ? " working" : ""}`}
				title={`${label}${timing ? ` · ${duration}` : ""}`}
				data-tip={`${label}${timing ? ` · ${duration}` : ""}`}
				onContextMenu={handleContextMenu}
				data-bar-item={id}
			>
				{working && <span className="working-spin" />}
				<span className="bar-item-text">
					{named(label)}
					{queueTotal > 0 && ` ⏳ ${queueTotal}`}
				</span>
				{timing && <span className="bar-item-duration">{duration}</span>}
				{working && rate > 0 && (
					<span className="status-rate bar-item-rate" title={t("rateTip")}>
						{`${Math.round(rate)}${t("tps")}`}
					</span>
				)}
			</span>
		);
	}

	if (id === "host:status-delegate") {
		if (!state?.delegateMode) return null;
		return (
			<span
				className="bar-item status-item delegate-badge bar-item-delegate"
				title={state.delegateConvId ? t("delegateModeOpenTip") : t("delegateModeBadgeTip")}
				data-tip={state.delegateConvId ? t("delegateModeOpenTip") : t("delegateModeBadgeTip")}
				onContextMenu={handleContextMenu}
				data-bar-item={id}
			>
				<span className="bar-item-icon">🔎</span>
				<span className="bar-item-text">{named(t("delegateModeBadge"))}</span>
				{state.delegateConvId ? (
					<button
						type="button"
						className="delegate-badge-open"
						title={t("delegateModeOpenTip")}
						onClick={() => appSend({ type: "switch_conversation", id: state.delegateConvId as string })}
					>
						↗
					</button>
				) : null}
			</span>
		);
	}

	if (id === "host:host-metrics") {
		const metrics = chat.hostMetrics;
		if (!metrics) return null;
		const cpu =
			metrics.cpuPercent === null || !Number.isFinite(metrics.cpuPercent) ? "—" : `${Math.round(metrics.cpuPercent)}%`;
		const memory = Number.isFinite(metrics.memoryPercent) ? `${Math.round(metrics.memoryPercent)}%` : "—";
		return (
			<span
				className="bar-item status-item status-host-metrics bar-item-host-metrics"
				title={`${t("hostResourcesTip")}\n${t("hostProcessor")}: ${cpu} · ${t("hostMemory")}: ${memory}`}
				data-tip={`${t("hostResourcesTip")}\n${t("hostProcessor")}: ${cpu} · ${t("hostMemory")}: ${memory}`}
				onContextMenu={handleContextMenu}
				data-bar-item={id}
			>
				<FiCpu className="bar-item-icon" />
				<span className="bar-item-text">{withName(`${cpu} · ${memory}`)}</span>
			</span>
		);
	}

	if (id === "host:browser") {
		if (chat.settings?.disabledAgentTools?.includes(BROWSER_PAGE_TOOL_NAME)) return null;
		return (
			<span className="bar-item-wrap" onContextMenu={handleContextMenu} data-bar-item={id}>
				<BrowserControl />
			</span>
		);
	}

	const dropdownDirection: "down" | "up" | "left" | "right" =
		bar === "bottom" ? "up" : bar === "left" ? "right" : bar === "right" ? "left" : "down";
	const shouldPortalDropdown = true;

	if (id === "host:language") {
		return (
			<Dropdown
				direction={dropdownDirection}
				align={bar === "right" ? "right" : "left"}
				portal={true}
				open={langOpen}
				onOpenChange={setLangOpen}
				tip={named(t("language"))}
				caret={false}
				triggerClassName="bar-item chip"
				onContextMenu={handleContextMenu}
				dataBarItem={id}
				trigger={
					<>
						<FiGlobe className="bar-item-icon" />
						<span className="chip-sub bar-item-text">{withName(localeShort(locale))}</span>
					</>
				}
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
				{dropdownProps?.onLocaleModalOpen ? (
					<DropdownItem
						onClick={() => {
							setLangOpen(false);
							dropdownProps.onLocaleModalOpen?.();
						}}
					>
						<FiDownload /> {t("localeGetMore")}
					</DropdownItem>
				) : null}
			</Dropdown>
		);
	}

	if (id === "host:theme") {
		const themes = dropdownProps?.themes ?? [];
		const currentTheme = dropdownProps?.theme ?? null;
		return (
			<Dropdown
				direction={dropdownDirection}
				align={bar === "right" ? "right" : "left"}
				portal={true}
				open={themeOpen}
				onOpenChange={(v) => {
					setThemeOpen(v);
					if (v && themes.length === 0) dropdownProps?.reloadThemes?.();
				}}
				tip={named(t("theme"))}
				caret={false}
				triggerClassName="bar-item chip"
				onContextMenu={handleContextMenu}
				dataBarItem={id}
				trigger={
					<>
						<FiSun className="bar-item-icon" />
						<span className="chip-sub bar-item-text">{named(t("theme"))}</span>
					</>
				}
			>
				{(() => {
					const classics = themes.filter((th) => th.group === "classic");
					const builtins = themes.filter((th) => th.group !== "classic");
					const themeLabel = (th: BarItemTheme) => {
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
											active={currentTheme === th.id}
											onClick={() => {
												dropdownProps?.onThemeChange?.(th.id);
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
								active={currentTheme === null}
								onClick={() => {
									dropdownProps?.onThemeChange?.(null);
									setThemeOpen(false);
								}}
							>
								{t("themeDefault")}
							</DropdownItem>
							{builtins.map((th) => (
								<DropdownItem
									key={th.id}
									active={currentTheme === th.id}
									onClick={() => {
										dropdownProps?.onThemeChange?.(th.id);
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
		);
	}

	if (id === "host:update") {
		const updatesCount = dropdownProps?.updatesCount ?? 0;
		return dropdownProps?.managed ? (
			<span
				className="bar-item chip"
				title={t("updatesManaged")}
				data-tip={t("updatesManaged")}
				onContextMenu={handleContextMenu}
				data-bar-item={id}
			>
				<FiDownload className="bar-item-icon" />
				<span className="chip-sub bar-item-text">
					{withName(`v${dropdownProps?.appVersion ?? chat.update?.current ?? "…"}`)}
				</span>
			</span>
		) : (
			<Dropdown
				direction={dropdownDirection}
				align={bar === "right" ? "right" : "left"}
				portal={shouldPortalDropdown}
				open={updateOpen}
				onOpenChange={(v) => {
					setUpdateOpen(v);
					if (v) {
						appSend({ type: "check_update" });
						appSend({ type: "check_updates_all" });
					}
				}}
				tip={named(t("update"))}
				fit
				caret={false}
				triggerClassName="bar-item chip"
				onContextMenu={handleContextMenu}
				dataBarItem={id}
				trigger={
					<>
						<FiDownload className="bar-item-icon" />
						<span className="chip-sub bar-item-text">{withName(`v${chat.update?.current ?? "…"}`)}</span>
						{chat.update && !chat.update.upToDate && <span className="update-dot" />}
						{updatesCount > 0 && <span className="update-badge">{updatesCount}</span>}
					</>
				}
			>
				<div className="dd-header">{t("update")}</div>
				{dropdownProps?.renderUpdateBody?.()}
				{dropdownProps?.renderAllUpdatesBody?.()}
			</Dropdown>
		);
	}

	let iconNode: ReactNode = null;
	let labelText = entry.label;
	let badgeNode: ReactNode = null;
	let isActive = false;
	let isTab = false;
	let extraClasses = "";
	let tipOverride: string | undefined = undefined;
	let onClick: ((e: ReactMouseEvent<HTMLButtonElement>) => void) | undefined = undefined;
	let onDoubleClick: ((e: ReactMouseEvent<HTMLButtonElement>) => void) | undefined = undefined;

	switch (id) {
		case "host:chat":
			if (!view || view === "chat" || view === "native-cli") return null;
			iconNode = <FiMessageSquare className="bar-item-icon" />;
			labelText = named(t("chat"));
			isTab = true;
			onClick = () => onViewChange?.("chat");
			break;
		case "host:native-cli":
			return null;
		case "host:terminal":
			iconNode = <FiTerminal className="bar-item-icon" />;
			labelText = named(t("terminal"));
			isActive = view === "terminal";
			isTab = true;
			onClick = () => onViewChange?.("terminal");
			break;
		case "host:worktrees": {
			const worktree = chat.state?.worktree;
			if (!worktree) return null;
			const paths = new Set(worktree.linkedWorktrees.map((row) => row.path));
			if (worktree.isLinkedWorktree) paths.add(worktree.currentPath);
			iconNode = <LuFolders className="bar-item-icon" />;
			labelText = named(t("worktreeViewTitle"));
			extraClasses = "chip worktree-entry";
			isActive = view === "worktrees";
			isTab = true;
			tipOverride = t("worktreeEntryTip", { count: paths.size });
			badgeNode = (
				<>
					<span className="worktree-count bar-item-badge">{paths.size}</span>
					{worktree.linkedWorktrees.some((row) => row.isDirty) && (
						<span className="worktree-dirty-dot" aria-label={t("worktreeHasChanges")} />
					)}
				</>
			);
			onClick = () => onViewChange?.(view === "worktrees" ? "chat" : "worktrees");
			break;
		}
		case "host:git":
			iconNode = <FiGitBranch className="bar-item-icon" />;
			labelText = named(t("scmTab"));
			isActive = view === "git";
			isTab = true;
			onClick = () => onViewChange?.("git");
			break;
		case "host:canvas":
			iconNode = <LuWorkflow className="bar-item-icon" />;
			labelText = named(t("canvasTab"));
			isActive = view === "canvas";
			isTab = true;
			onClick = () => onViewChange?.("canvas");
			break;
		case "host:new-chat":
			iconNode = <FiPlus className="bar-item-icon" />;
			labelText = named(t("newChat"));
			extraClasses = "chip newchat";
			onClick = () => {
				onViewChange?.("chat");
				appSend({ type: "new_chat" });
				focusComposer();
			};
			break;
		case "host:new-ephemeral-chat":
			if (isDsh) return null;
			iconNode = <LuMessageSquareDashed className="bar-item-icon" />;
			labelText = named(t("newChatEphemeral"));
			extraClasses = "chip newchat ephemeral-chat-btn";
			onClick = () => {
				onViewChange?.("chat");
				appSend({ type: "new_chat", ephemeral: true });
				focusComposer();
			};
			break;
		case "host:new-sandbox":
			iconNode = <LuFlaskConical className="bar-item-icon" />;
			labelText = named(t("newSandbox"));
			extraClasses = "chip newchat sandbox-chip";
			onClick = () => onOpenSandboxModal?.();
			break;
		case "host:history":
			if (view && view !== "chat") return null;
			iconNode = <FiMenu className="bar-item-icon" />;
			labelText = named(t("openHistory"));
			extraClasses = "panel-toggle";
			onClick = () => onOpenPanel?.("left");
			break;
		case "host:files":
			if (view && view !== "chat") return null;
			iconNode = <FiFolder className="bar-item-icon" />;
			labelText = named(t("openFiles"));
			extraClasses = "panel-toggle has-label";
			onClick = () => onOpenPanel?.("right");
			break;
		case "host:open-project":
			iconNode = <FiFolderPlus className="bar-item-icon" />;
			labelText = named(t("openProject"));
			extraClasses = "chip open-project";
			isActive = Boolean(isProjectPickerOpen);
			onClick = () => onOpenProjectPicker?.();
			break;
		case "host:search":
			iconNode = <FiSearch className="bar-item-icon" />;
			labelText = named(t("searchGlobal"));
			extraClasses = "chip";
			onClick = () => onOpenGlobalSearch?.();
			break;
		case "host:tasks":
			iconNode = <FiLayers className="bar-item-icon" />;
			labelText = named(t("bgTasks"));
			extraClasses = "chip bg-task-chip";
			if (chat.bgServers.length > 0) {
				badgeNode = <span className="bg-task-badge bar-item-badge">{chat.bgServers.length}</span>;
			}
			onClick = () => onOpenBgTasks?.();
			break;
		case "host:zen-mode":
			iconNode = <FiFeather className="bar-item-icon" />;
			labelText = named(t("zenMode"));
			extraClasses = "chip chip-zen";
			isActive = Boolean(zenMode);
			tipOverride = t("zenModeTip");
			onClick = () => onToggleZenMode?.();
			break;
		case "host:device-center":
			iconNode = <FiGlobe className="bar-item-icon" />;
			labelText = named(t("deviceCenter"));
			extraClasses = "chip";
			tipOverride = t("deviceCenterTip");
			isTab = true;
			isActive = view === "devices";
			onClick = () => onViewChange?.("devices");
			break;
		case "host:settings":
			iconNode = <FiSettings className="bar-item-icon" />;
			labelText = named(t("settings"));
			extraClasses = "chip";
			onClick = () => onOpenSettings?.();
			break;
		case "host:plugins":
			iconNode = <FiBox className="bar-item-icon" />;
			labelText = named(t("pluginMenuTitle"));
			extraClasses = "chip";
			onClick = (e) => {
				if (onOpenPluginMenu) onOpenPluginMenu(e.currentTarget);
				else onOpenSettings?.("plugins");
			};
			break;
		case "host:github":
			iconNode = <FiGithub className="bar-item-icon" />;
			labelText = named("GitHub");
			extraClasses = "chip github";
			onClick = () => window.open("https://github.com/xing-shuyin/pi-web-ui", "_blank", "noreferrer,noopener");
			break;
		case "host:cwd":
			iconNode = <FiFolder className="bar-item-icon" />;
			labelText = withName(state?.cwd ? state.cwd.split(/[/\\]/).pop() || state.cwd : t("openProject"));
			extraClasses = "status-item status-cwd";
			isActive = Boolean(isProjectPickerOpen);
			onClick = () => {
				if (cwdClickTimerRef.current !== null) {
					window.clearTimeout(cwdClickTimerRef.current);
					cwdClickTimerRef.current = null;
				}
				cwdClickTimerRef.current = window.setTimeout(() => {
					onOpenProjectPicker?.();
					cwdClickTimerRef.current = null;
				}, 220);
			};
			onDoubleClick = (e) => {
				e.preventDefault();
				e.stopPropagation();
				if (cwdClickTimerRef.current !== null) {
					window.clearTimeout(cwdClickTimerRef.current);
					cwdClickTimerRef.current = null;
				}
				appSend({ type: "new_chat" });
				focusComposer();
			};
			break;
		case "host:plugin-status":
			if (chat.statuses.length === 0) return null;
			iconNode = <FiActivity className="bar-item-icon" />;
			labelText = withName(chat.statuses.map((st) => st.text).join(" · "));
			extraClasses = "status-item ext-status";
			break;
		default:
			if (entry.kind === "view") {
				const target = entry.view ?? "";
				isActive = view === target;
				isTab = true;
				const pluginList = plugins ?? chat.plugins ?? [];
				const meta = pluginList.find((p) => `plugin:${p.id}` === entry.source);
				const isBroken = Boolean(meta?.error);
				extraClasses = `plugin-tab${isBroken ? " broken" : ""}`;
				if (meta?.error) {
					tipOverride = `${entry.label}: ${meta.error}`;
				}
				const svg = entry.iconSvg || meta?.iconSvg;
				const glyph = entry.icon || meta?.icon;
				iconNode = svg ? (
					<PluginIcon icon={glyph} iconSvg={svg} className="bar-item-icon plugin-icon-svg" />
				) : glyph ? (
					<span className="bar-item-icon bar-item-glyph">{glyph}</span>
				) : null;
				onClick = () => onViewChange?.(target as ViewName);
			} else {
				const svg = entry.iconSvg;
				const glyph = entry.icon;
				extraClasses = bar === "bottom" ? "status-item status-action chip" : "chip";
				iconNode = svg ? (
					<PluginIcon icon={glyph} iconSvg={svg} className="bar-item-icon plugin-icon-svg" />
				) : glyph ? (
					<span className="bar-item-icon bar-item-glyph">{glyph}</span>
				) : null;
				if (entry.badge) {
					badgeNode = <span className="bar-item-badge">{entry.badge}</span>;
				}
				onClick = () => onUiAction?.(entry);
			}
			break;
	}

	const tip = tipOverride ?? entry.hint ?? labelText;
	const tabClass = isTab ? `tb-tab${isActive ? " active" : ""}` : "";
	const combinedClass = ["bar-item", tabClass, extraClasses, isActive && !isTab ? "active" : ""]
		.filter(Boolean)
		.join(" ");

	const button = (
		<button
			type="button"
			role={isTab ? "tab" : undefined}
			aria-selected={isTab ? isActive : undefined}
			aria-haspopup={id === "host:plugins" ? "menu" : undefined}
			aria-expanded={id === "host:plugins" ? Boolean(isPluginMenuOpen) : undefined}
			className={combinedClass}
			title={tip}
			data-tip={tip}
			aria-label={labelText}
			onClick={onClick}
			onDoubleClick={onDoubleClick}
			onContextMenu={handleContextMenu}
			data-bar-item={id}
		>
			{iconNode}
			{!(id === "host:worktrees" && bar === "top" && !entry.labelExplicit) && (
				<span className="bar-item-text">{labelText}</span>
			)}
			{badgeNode}
		</button>
	);
	return id === "host:new-chat" ? (
		<NativeCliCreateEntry onCreateCli={onCreateCli}>{button}</NativeCliCreateEntry>
	) : (
		button
	);
}
