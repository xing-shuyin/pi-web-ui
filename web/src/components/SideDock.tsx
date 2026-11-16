import { useEffect, useRef, useState } from "react";
import { FiChevronLeft, FiChevronRight } from "react-icons/fi";
import type { ChatState } from "../use-chat";
import { groupByAlign, type UiSlotEntry } from "../ui-slots";
import { ICON_EDIT_ALIGNS } from "../ui-layout-edit";
import { useI18n } from "../i18n";
import { useOverlayZIndex } from "../overlay-stack";
import { useCoarsePointer } from "../use-coarse-pointer";
import { BarItem, type BarItemProps, type ViewName } from "./BarItem";

interface SideDockProps {
	side: "left" | "right";
	items: UiSlotEntry[];
	chat: ChatState;
	view: ViewName;
	onViewChange: (view: ViewName) => void;
	onCreateCli?: (cwd?: string) => void;
	onOpenPanel: (side: "left" | "right") => void;
	onOpenSettings: (initialSection?: string) => void;
	onOpenBgTasks: () => void;
	onOpenGlobalSearch: () => void;
	onUiAction?: (item: UiSlotEntry, value?: string) => void;
	uiContextTopbar?: UiSlotEntry[];
	onOpenProjectPicker?: () => void;
	onThemeToggle?: () => void;
	onSoundToggle?: () => void;
	zenMode?: boolean;
	onToggleZenMode?: () => void;
	dropdownProps?: BarItemProps["dropdownProps"];
	plugins?: BarItemProps["plugins"];
	onOpenPluginMenu?: (el: HTMLElement) => void;
	isPluginMenuOpen?: boolean;
}

const TIP_DELAY_MS = 220;

/**
 * 侧栏停靠栏（贯通列）。
 *
 * 整列从顶栏下沿一直贯通到底部状态栏：与顶栏/面板同底色，只留一条 1px 发丝线，
 * 不画外框、不画阴影 —— 旧版「贴边胶囊」的两层卡片语言是割裂感的来源。
 *
 * tooltip 走 `.rail-tip` 单例 fixed 浮层，**不**放进 `.side-dock-seg`：
 * 那一层为了容纳超量图标是滚动容器（`overflow-y: auto` 会把横向也算成 `auto`），
 * 伪元素 tooltip 往侧向伸出会直接撑出横向滚动条。
 */
export function SideDock({
	side,
	items,
	chat,
	view,
	onViewChange,
	onCreateCli,
	onOpenPanel,
	onOpenSettings,
	onOpenBgTasks,
	onOpenGlobalSearch,
	onUiAction,
	uiContextTopbar,
	onOpenProjectPicker,
	onThemeToggle: _onThemeToggle,
	onSoundToggle: _onSoundToggle,
	zenMode,
	onToggleZenMode,
	dropdownProps,
	plugins,
	onOpenPluginMenu,
	isPluginMenuOpen,
}: SideDockProps) {
	const { t } = useI18n();
	const [collapsed, setCollapsed] = useState(false);
	const dockRef = useRef<HTMLDivElement>(null);
	const [tip, setTip] = useState<{ label: string; x: number; y: number } | null>(null);
	const tipTimer = useRef<number | null>(null);
	const pendingRef = useRef<HTMLElement | null>(null);
	const tipZIndex = useOverlayZIndex(tip !== null);
	const coarse = useCoarsePointer();

	const layout = chat.settings?.uiLayout;
	const floating = layout?.sideDockFloat === true;
	const floatCls = floating ? " side-dock-float" : "";

	const visibleItems = items.filter((e) => !e.hidden);
	const collapsedFloat = floating && collapsed;

	const clearTip = () => {
		if (tipTimer.current !== null) {
			window.clearTimeout(tipTimer.current);
			tipTimer.current = null;
		}
		pendingRef.current = null;
		setTip(null);
	};

	/** 悬停 220ms 后弹标签；触屏（粗指针）不弹，避免点击后浮层挡在图标上。 */
	const scheduleTip = (el: HTMLElement) => {
		if (coarse) return;
		// 同一按钮内部的移动（图标 → 角标）不重置计时，否则永远弹不出来
		if (pendingRef.current === el) return;
		const label = el.getAttribute("data-tip");
		if (!label) return;
		pendingRef.current = el;
		if (tipTimer.current !== null) window.clearTimeout(tipTimer.current);
		tipTimer.current = window.setTimeout(() => {
			tipTimer.current = null;
			const rect = el.getBoundingClientRect();
			if (rect.width === 0 && rect.height === 0) return;
			const y = Math.min(Math.max(rect.top + rect.height / 2, 24), window.innerHeight - 24);
			setTip({ label, x: side === "left" ? rect.right + 8 : rect.left - 8, y });
		}, TIP_DELAY_MS);
	};

	// 自绘 tooltip 已经承担提示职责，去掉原生 title 免得两个提示先后叠着出现。
	// 触屏没有 hover，保留 title 让长按提示仍然可用。
	// 不带依赖数组：每次渲染后重扫（BarItem 重渲染可能把 title 写回来）。
	useEffect(() => {
		if (coarse) return;
		dockRef.current?.querySelectorAll("[title]").forEach((el) => el.removeAttribute("title"));
	});

	useEffect(() => {
		return () => {
			if (tipTimer.current !== null) window.clearTimeout(tipTimer.current);
		};
	}, []);

	useEffect(() => {
		if (!tip) return;
		const hide = () => setTip(null);
		window.addEventListener("scroll", hide, true);
		window.addEventListener("resize", hide);
		return () => {
			window.removeEventListener("scroll", hide, true);
			window.removeEventListener("resize", hide);
		};
	}, [tip]);

	if (visibleItems.length === 0) {
		return null;
	}

	const groups = groupByAlign(visibleItems);

	const renderDockItem = (item: UiSlotEntry) => (
		<BarItem
			key={item.id}
			entry={item}
			bar={side}
			chat={chat}
			view={view}
			plugins={plugins}
			onViewChange={onViewChange}
			onCreateCli={onCreateCli}
			onOpenPanel={onOpenPanel}
			onOpenSettings={onOpenSettings}
			onOpenGlobalSearch={onOpenGlobalSearch}
			onOpenBgTasks={onOpenBgTasks}
			onOpenProjectPicker={onOpenProjectPicker}
			onOpenPluginMenu={onOpenPluginMenu}
			isPluginMenuOpen={isPluginMenuOpen}
			onUiAction={onUiAction}
			uiContextEntries={uiContextTopbar}
			zenMode={zenMode}
			onToggleZenMode={onToggleZenMode}
			dropdownProps={dropdownProps}
		/>
	);

	return (
		<div
			ref={dockRef}
			className={`side-dock side-dock-${side}${collapsedFloat ? " side-dock-collapsed" : ""}${floatCls}`}
			onPointerOver={(e) => {
				const el = (e.target as HTMLElement).closest?.("[data-tip]");
				if (el instanceof HTMLElement) scheduleTip(el);
			}}
			onPointerOut={(e) => {
				const el = (e.target as HTMLElement).closest?.("[data-tip]");
				if (!el) return;
				// 在同一按钮内部移动（图标 → 角标）不算离开，否则 tooltip 会闪一下
				const next = e.relatedTarget;
				if (next instanceof Node && el.contains(next)) return;
				clearTip();
			}}
			onPointerDown={clearTip}
			onScrollCapture={clearTip}
			onFocusCapture={(e) => {
				const el = e.target as HTMLElement;
				if (el.hasAttribute?.("data-tip")) scheduleTip(el);
			}}
			onBlurCapture={clearTip}
		>
			{collapsedFloat ? (
				<button
					type="button"
					className="side-dock-btn side-dock-toggle-btn"
					data-tip={`${t("sideDockExpand")} (${visibleItems.length})`}
					onClick={() => setCollapsed(false)}
					aria-label={t("sideDockExpand")}
				>
					{side === "left" ? <FiChevronRight /> : <FiChevronLeft />}
				</button>
			) : (
				<>
					{floating && (
						<button
							type="button"
							className="side-dock-btn side-dock-collapse-btn"
							data-tip={t("sideDockCollapse")}
							onClick={() => setCollapsed(true)}
							aria-label={t("sideDockCollapse")}
						>
							{side === "left" ? <FiChevronLeft /> : <FiChevronRight />}
						</button>
					)}
					{ICON_EDIT_ALIGNS.map((align) => (
						<div key={align} className={`side-dock-slot side-dock-slot-${align}`}>
							{groups[align].length > 0 && <div className="side-dock-seg">{groups[align].map(renderDockItem)}</div>}
						</div>
					))}
				</>
			)}
			{tip && (
				<div
					className="rail-tip"
					role="tooltip"
					style={{
						left: tip.x,
						top: tip.y,
						zIndex: tipZIndex,
						transform: side === "right" ? "translate(-100%, -50%)" : "translate(0, -50%)",
					}}
				>
					{tip.label}
				</div>
			)}
		</div>
	);
}
