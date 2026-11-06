import { useState, useRef } from "react";
import { FiChevronLeft, FiChevronRight } from "react-icons/fi";
import type { ChatState } from "../use-chat";
import { groupByAlign, type UiSlotEntry } from "../ui-slots";
import { ICON_EDIT_ALIGNS } from "../ui-layout-edit";
import { useI18n } from "../i18n";
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

	const layout = chat.settings?.uiLayout;
	const floating = layout?.sideDockFloat === true;
	const floatCls = floating ? " side-dock-float" : "";

	const visibleItems = items.filter((e) => !e.hidden);

	if (visibleItems.length === 0) {
		return null;
	}

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
