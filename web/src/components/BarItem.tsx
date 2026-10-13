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
	FiVolume2,
} from "react-icons/fi";
import { LuMessageSquareDashed } from "react-icons/lu";
import type { UiSlotEntry, UiSlotId } from "../ui-slots";
import type { ChatState } from "../use-chat";
import { useFormattedCost } from "../cost-format";
import { isZhLocale, useT, useI18n } from "../i18n";
import { useAppGlobals, appSend } from "../app-globals";
import { PluginIcon } from "../plugin-icon";
import { focusComposer } from "../composer-bridge";
import { openContextMenu } from "../context-menu-state";
import { cacheMetrics, estimateStreamTokens, streamRate, trimRateSamples, type RateSample } from "../cache-stats";
import { Dropdown, DropdownItem } from "./Dropdown";
import { SoundSettingsPanel } from "./SoundSettings";
import { NotifyToggle } from "./NotifyToggle";
import { BrowserControl } from "./BrowserControl";
import { BROWSER_PAGE_TOOL_NAME } from "../../../server/tool-manager.js";
import type { SoundKind, SoundSettings } from "../sounds";
import { EnginePicker } from "./EnginePicker";

export type ViewName = "chat" | "terminal" | "git" | `plugin:${string}`;

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
	dropdownProps?: {
		sound?: SoundSettings;
		onSoundChange?: (settings: SoundSettings) => void;
		onSoundPreview?: (kind: SoundKind) => void;
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

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`;
	return String(n);
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

/**
 * 通用条目组件（BarItem）：
 * 统一服务于顶栏（topbar.primary）、底栏（bottombar）、左侧栏（sidebar.left）、右侧栏（sidebar.right）。
 * 统一采用【图标 + 文字】的形式展现（特殊条目保留其环形进度、状态指示灯等特色结构），
 * 支持跨栏拖动后在任意位置正常渲染与交互，右键菜单支持在四个栏之间自由互移。
 */
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
}: BarItemProps) {
	const t = useT();
	const { locale, packs, setLocale } = useI18n();
	const { engine } = useAppGlobals();
	const isDsh = engine === "dsh";

	const [soundOpen, setSoundOpen] = useState(false);
	const [langOpen, setLangOpen] = useState(false);
	const [themeOpen, setThemeOpen] = useState(false);
	const [updateOpen, setUpdateOpen] = useState(false);

	const layout = chat.settings?.uiLayout;
	const state = chat.state;
	const stats = state?.stats;
	const isStreaming = state?.isStreaming ?? false;
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

	const handleContextMenu = (e: ReactMouseEvent) => {
		e.preventDefault();
		e.stopPropagation();

		const setItemSlot = (targetSlot: UiSlotId) => {
			const slots = { ...layout?.slots, [entry.id]: targetSlot };
			appSend({ type: "set_settings", uiLayout: { ...layout, slots } });
		};
		const hideItem = () => {
			const hidden = new Set(layout?.hidden ?? []);
			hidden.add(entry.id);
			appSend({ type: "set_settings", uiLayout: { ...layout, hidden: [...hidden] } });
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
		menuEntries.push({
			id: "host:hide-item",
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
			},
		});
	};

	const id = entry.id;
	/** 显式文案（用户布局页改名 / 插件 arrange 改名，见 UiSlotEntry.labelExplicit）。内置条目一直画
	 *  的是自己写死的 i18n 文案与实时数值，所以只有文案被显式指定时才让位 —— 不然布局页的改名
	 *  框就是「假承诺」：改了没人理（issue #555）。没置旗时渲染结果与旧版逐字节一致。 */
	const custom = entry.labelExplicit ? entry.label : "";
	/** 名字型条目：显式文案顶掉内置文案。 */
	const named = (fallback: string) => custom || fallback;
	/** 数值型条目：`名字 数值`（名字只为显式文案而存在），没指定时就是原来的数值。 */
	const withName = (value: string) => (custom ? `${custom} ${value}` : value);

	// 下拉选择类型插件条目
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

	// 1. 特殊条目：品牌（唯品牌徽标例外，不加 data-tip）
	if (id === "host:brand") {
		return (
			<span
				className="bar-item brand bar-item-brand"
				title={t("brand")}
				onContextMenu={handleContextMenu}
				data-bar-item={id}
			>
				<span className="brand-logo bar-item-brand-logo">π</span>
				<span className="brand-name bar-item-text">{named("pi-web-ui")}</span>
			</span>
		);
	}

	// 2. 特殊条目：连接状态（已连接时附带实时网络延迟 ms）
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
				{/* 连接态常驻「指示灯 + 文字」：只留圆点虽然紧凑，但底栏缺少一处明文的健康状态，
				 * 用户看不出「亮着的是绿灯还是黄灯」，所以文字保留（窄屏≤768px 由 CSS 单独隐藏文字）。 */}
				<span className="status-conn-label bar-item-text">{withName(connLabel)}</span>
				{latencyText && <span className={`status-latency ${latencyClass}`}>{latencyText}</span>}
			</span>
		);
	}

	// 3. 特殊条目：引擎选择器（常驻显示下拉胶囊，支持任意多引擎扩展）
	if (id === "host:engine") {
		return (
			<span
				onContextMenu={handleContextMenu}
				data-bar-item={id}
				className="bar-item-engine-wrap"
				style={{ display: "inline-flex", alignItems: "center" }}
			>
				<EnginePicker
					direction={bar === "bottom" ? "up" : "down"}
					align={bar === "right" ? "right" : "left"}
					caret={false}
					bar={bar}
					label={entry.labelExplicit ? entry.label : undefined}
				/>
			</span>
		);
	}

	// 4. 特殊条目：上下文进度环
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
			<span
				className="bar-item status-item status-ctx bar-item-ctx"
				title={ctxTitle}
				data-tip={ctxTitle}
				onContextMenu={handleContextMenu}
				data-bar-item={id}
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
			</span>
		);
	}

	// 5. 特殊条目：缓存命中率
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

	// 5.5 特殊条目：累计成本（与 ctx / cache 同级的纯状态指标，无按钮行为；支持配置货币符号或插件接管格式化 #607）
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
				{/* 名字落在货币符号前面：`.status-cost` 默认 gap:0 让符号紧贴数字，有名字时靠 .has-name 把间距还给条目。 */}
				{custom ? <span className="bar-item-text">{custom}</span> : null}
				{costDisplay.symbol ? <span className="bar-item-char">{costDisplay.symbol}</span> : null}
				<span className="bar-item-text">{costDisplay.value}</span>
			</span>
		);
	}

	// 5.6 特殊条目：消息数（纯图标 + 数字，去掉了文字和 #）
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

	// 6. 特殊条目：运行状态
	if (id === "host:working") {
		if (!isStreaming) return null;
		const queueTotal = (state?.queue?.steering?.length ?? 0) + (state?.queue?.followUp?.length ?? 0);
		return (
			<span
				className="bar-item status-item working bar-item-working"
				title={t("working")}
				data-tip={t("working")}
				onContextMenu={handleContextMenu}
				data-bar-item={id}
			>
				<span className="working-spin" />
				<span className="bar-item-text">
					{named(t("working"))}
					{queueTotal > 0 && ` ⏳ ${queueTotal}`}
				</span>
				<span className="status-rate bar-item-rate" title={t("rateTip")}>
					{rate > 0 ? `${Math.round(rate)}${t("tps")}` : "…"}
				</span>
			</span>
		);
	}

	// 7. 特殊条目：审查者模式
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

	// 8. 特殊条目：主机资源占用
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

	// 浏览器控制条目
	if (id === "host:browser") {
		if (chat.settings?.disabledAgentTools?.includes(BROWSER_PAGE_TOOL_NAME)) return null;
		return (
			<span className="bar-item-wrap" onContextMenu={handleContextMenu} data-bar-item={id}>
				<BrowserControl />
			</span>
		);
	}

	// 9. 下拉面板类条目
	if (id === "host:sound") {
		return (
			<Dropdown
				direction={bar === "bottom" ? "up" : "down"}
				align={bar === "right" ? "right" : "left"}
				open={soundOpen}
				onOpenChange={setSoundOpen}
				tip={named(t("sound"))}
				caret={false}
				triggerClassName="bar-item chip"
				onContextMenu={handleContextMenu}
				dataBarItem={id}
				trigger={
					<>
						<FiVolume2 className="bar-item-icon" />
						<span className="chip-sub bar-item-text">{named(t("sound"))}</span>
					</>
				}
			>
				{dropdownProps?.sound && dropdownProps?.onSoundChange ? (
					<SoundSettingsPanel
						settings={dropdownProps.sound}
						onChange={dropdownProps.onSoundChange}
						onPreview={dropdownProps.onSoundPreview ?? (() => {})}
					/>
				) : null}
				<NotifyToggle />
			</Dropdown>
		);
	}

	if (id === "host:language") {
		return (
			<Dropdown
				direction={bar === "bottom" ? "up" : "down"}
				align={bar === "right" ? "right" : "left"}
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
				direction={bar === "bottom" ? "up" : "down"}
				align={bar === "right" ? "right" : "left"}
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
				direction={bar === "bottom" ? "up" : "down"}
				align={bar === "right" ? "right" : "left"}
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

	// 10. 标准【图标 + 文字】各类按钮
	let iconNode: ReactNode = null;
	let labelText = entry.label;
	let badgeNode: ReactNode = null;
	let isActive = false;
	let isTab = false;
	let extraClasses = "";
	let tipOverride: string | undefined = undefined;
	let onClick: ((e: ReactMouseEvent<HTMLButtonElement>) => void) | undefined = undefined;

	switch (id) {
		case "host:chat":
			iconNode = <FiMessageSquare className="bar-item-icon" />;
			labelText = named(t("chat"));
			isActive = view === "chat";
			isTab = true;
			onClick = () => onViewChange?.("chat");
			break;
		case "host:terminal":
			iconNode = <FiTerminal className="bar-item-icon" />;
			labelText = named(t("terminal"));
			isActive = view === "terminal";
			isTab = true;
			onClick = () => onViewChange?.("terminal");
			break;
		case "host:git":
			iconNode = <FiGitBranch className="bar-item-icon" />;
			labelText = named(t("scmTab"));
			isActive = view === "git";
			isTab = true;
			onClick = () => onViewChange?.("git");
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
			onClick = () => onOpenProjectPicker?.();
			break;
		case "host:plugin-status":
			if (chat.statuses.length === 0) return null;
			iconNode = <FiActivity className="bar-item-icon" />;
			labelText = withName(chat.statuses.map((st) => st.text).join(" · "));
			extraClasses = "status-item ext-status";
			break;
		default:
			// 插件视图（kind === "view"）或常规插件 action
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
				// 优先展示插件定义的线性矢量 SVG 图标（iconSvg），无 SVG 时才回退到 emoji（icon）
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

	return (
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
			onContextMenu={handleContextMenu}
			data-bar-item={id}
		>
			{iconNode}
			<span className="bar-item-text">{labelText}</span>
			{badgeNode}
		</button>
	);
}
