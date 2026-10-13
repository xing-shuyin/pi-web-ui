import { useState, useRef } from "react";
import { FiChevronLeft, FiChevronRight } from "react-icons/fi";
import type { ChatState } from "../use-chat";
import { groupByAlign, type UiSlotEntry } from "../ui-slots";
import { ICON_EDIT_ALIGNS } from "../ui-layout-edit";
import { useI18n } from "../i18n";
import { BarItem } from "./BarItem";

interface SideDockProps {
	side: "left" | "right";
	items: UiSlotEntry[];
	chat: ChatState;
	view: "chat" | "terminal" | "git" | `plugin:${string}`;
	onViewChange: (view: "chat" | "terminal" | "git" | `plugin:${string}`) => void;
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
}

/**
 * 屏幕边缘图标停靠栏（SideDock）。
 *
 * 贴在屏幕左侧或右侧边缘（默认在流内占一条窄边，可切成悬浮浮层），
 * 渲染被分配到 sidebar.left 或 sidebar.right 的所有条目，点击触发对应操作；
 * 右键弹出上下文菜单支持自由移到上下两侧任意位置。
 *
 * **竖向三段**：条目的 `align` 在这里读作竖轴（start = 靠上 / center = 居中 / end = 靠下）——
 * 与顶栏的横轴是同一套取值、同一份偏好（设置 → 界面布局的「对齐」下拉、图标编辑器拖放），
 * 只是渲染出来是上下叠而不是左右排。折叠按钮**只在悬浮模式**提供（见 render 里的注释）。
 */
export function SideDock({
	side,
	items,
	chat,
	view,
	onViewChange,
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
}: SideDockProps) {
	const { t } = useI18n();
	const [collapsed, setCollapsed] = useState(false);
	const dockRef = useRef<HTMLDivElement>(null);

	const layout = chat.settings?.uiLayout;
	/** 悬浮模式（设置 → 界面布局 → 侧边图标悬浮显示）：回到旧的 fixed 贴边浮层 ——
	 *  不占布局宽，但会盖在面板上面（相应地 CSS 把它从 .layout 的 flex 流里摘出去）。 */
	const floating = layout?.sideDockFloat === true;
	const floatCls = floating ? " side-dock-float" : "";

	const visibleItems = items.filter((e) => !e.hidden);

	// 该侧没有分配任何图标：整条不渲染 —— 停靠栏现在是**在流内**的贴边槽位，留空会白白挤走
	// 面板与主区的横向空间。
	if (visibleItems.length === 0) {
		return null;
	}

	// 收起 = 只留一个展开按钮，**仅对悬浮浮层有意义**
	if (floating && collapsed) {
		return (
			<div ref={dockRef} className={`side-dock side-dock-${side} side-dock-collapsed${floatCls}`}>
				<button
					type="button"
					className="side-dock-btn side-dock-toggle-btn"
					data-tip={`${t("sideDockExpand")} (${visibleItems.length})`}
					onClick={() => setCollapsed(false)}
					aria-label={t("sideDockExpand")}
				>
					{side === "left" ? <FiChevronRight /> : <FiChevronLeft />}
				</button>
			</div>
		);
	}

	// 竖向三段（与顶栏同一套 align 取值，只是轴换了）：start = 靠上、center = 居中、end = 靠下。
	// 每段是一个「弹性格子」（.side-dock-slot，始终存在，靠它把上下两段等分剩余高度）
	// 加一颗**内容高**的贴边小药丸（.side-dock-seg，空段不画）—— 药丸不能跟着弹性格子
	// 一起被拉高，否则一个图标会拓成一整条竖色块。
	const groups = groupByAlign(visibleItems);

	const renderDockItem = (item: UiSlotEntry) => (
		<BarItem
			key={item.id}
			entry={item}
			bar={side}
			chat={chat}
			view={view}
			onViewChange={onViewChange}
			onOpenPanel={onOpenPanel}
			onOpenSettings={onOpenSettings}
			onOpenGlobalSearch={onOpenGlobalSearch}
			onOpenBgTasks={onOpenBgTasks}
			onOpenProjectPicker={onOpenProjectPicker}
			onUiAction={onUiAction}
			uiContextEntries={uiContextTopbar}
			zenMode={zenMode}
			onToggleZenMode={onToggleZenMode}
		/>
	);

	return (
		<div ref={dockRef} className={`side-dock side-dock-${side}${floatCls}`}>
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
		</div>
	);
}
