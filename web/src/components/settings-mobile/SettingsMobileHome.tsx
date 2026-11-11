import type { ReactNode } from "react";
import { FiChevronRight, FiSearch, FiX } from "react-icons/fi";
import { useT } from "../../i18n";
import type { SettingsSaveStatus } from "../../settings-sync";

export interface MobileSettingsTab {
	id: string;
	icon: ReactNode;
	label: string;
	/** 与桌面侧栏一致的计数徽标（页签内的条目数量）。 */
	count?: number;
	/** 与桌面侧栏一致的状态点（插件有更新 / MCP 异常）。 */
	dot?: boolean;
	/** 简短当前值，只用于「不点进去也能确认」的项；没有就不显示。 */
	value?: string;
}

export interface MobileSettingsGroup {
	key: string;
	label: string;
	tabs: MobileSettingsTab[];
}

interface SettingsMobileHomeProps {
	groups: MobileSettingsGroup[];
	/** 搜索命中的页签（扁平，带所属分组标签）。 */
	results: Array<MobileSettingsTab & { group: string }>;
	query: string;
	onQueryChange: (value: string) => void;
	onOpen: (id: string) => void;
	onClose: () => void;
	saveStatus: SettingsSaveStatus;
	onRetrySave: () => void;
}

/**
 * 移动端设置首页：标题 + 搜索 + 分组卡列表。
 * 只承载「入口」，不复制二级页里的任何表单 —— 点行进入的仍是桌面版同一份渲染。
 */
export function SettingsMobileHome({
	groups,
	results,
	query,
	onQueryChange,
	onOpen,
	onClose,
	saveStatus,
	onRetrySave,
}: SettingsMobileHomeProps) {
	const t = useT();
	const searching = query.trim().length > 0;
	const visibleGroups = groups.filter((group) => group.tabs.length > 0);
	const saveText =
		saveStatus === "saving"
			? t("settingsSaveSaving")
			: saveStatus === "failed"
				? t("settingsSaveFailed")
				: t("settingsSaveSaved");

	return (
		<div className="sm-home">
			<div className="sm-head">
				<h1 className="sm-title">{t("settingsTitle")}</h1>
				<button
					type="button"
					className="settings-live-pill sm-save"
					data-state={saveStatus}
					title={saveStatus === "failed" ? t("settingsSaveFailed") : t("settingsAutoSavedTip")}
					onClick={saveStatus === "failed" ? onRetrySave : undefined}
					aria-live="polite"
				>
					<span className="settings-live-dot" aria-hidden="true" />
					<span className="settings-live-text">{saveText}</span>
				</button>
				<button type="button" className="sm-close" onClick={onClose} aria-label={t("close")}>
					<FiX aria-hidden="true" />
				</button>
			</div>

			<div className="sm-search" role="search">
				<FiSearch className="sm-search-icon" aria-hidden="true" />
				<input
					type="search"
					className="sm-search-input"
					value={query}
					placeholder={t("settingsSearchPlaceholder")}
					aria-label={t("settingsSearchPlaceholder")}
					autoComplete="off"
					onChange={(e) => onQueryChange(e.target.value)}
				/>
				{searching && (
					<button
						type="button"
						className="sm-search-clear"
						aria-label={t("clearSelection")}
						onClick={() => onQueryChange("")}
					>
						<FiX aria-hidden="true" />
					</button>
				)}
			</div>

			<div className="sm-scroll">
				{searching ? (
					results.length > 0 ? (
						<div className="sm-card">
							{results.map((tab) => (
								<MobileRow key={tab.id} tab={tab} group={tab.group} onOpen={onOpen} />
							))}
						</div>
					) : (
						<div className="sm-empty" role="status">
							<span className="sm-empty-title">{t("settingsSearchEmpty")}</span>
							<button type="button" className="sm-empty-btn" onClick={() => onQueryChange("")}>
								{t("clearSelection")}
							</button>
						</div>
					)
				) : (
					visibleGroups.map((group) => (
						<section className="sm-group" key={group.key} aria-labelledby={`sm-group-${group.key}`}>
							<h2 className="sm-group-title" id={`sm-group-${group.key}`}>
								{group.label}
							</h2>
							<div className="sm-card">
								{group.tabs.map((tab) => (
									<MobileRow key={tab.id} tab={tab} onOpen={onOpen} />
								))}
							</div>
						</section>
					))
				)}
			</div>
		</div>
	);
}

function MobileRow({ tab, group, onOpen }: { tab: MobileSettingsTab; group?: string; onOpen: (id: string) => void }) {
	return (
		<button type="button" className="sm-row" onClick={() => onOpen(tab.id)}>
			<span className="sm-row-icon" aria-hidden="true">
				{tab.icon}
			</span>
			<span className="sm-row-main">
				<span className="sm-row-label">{tab.label}</span>
				{group && <span className="sm-row-crumb">{group}</span>}
			</span>
			{tab.value && <span className="sm-row-value">{tab.value}</span>}
			{tab.count !== undefined && <span className="sm-count">{tab.count}</span>}
			{tab.dot && <span className="sm-dot" aria-hidden="true" />}
			<FiChevronRight className="sm-chev" aria-hidden="true" />
		</button>
	);
}
