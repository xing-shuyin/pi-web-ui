import { Fragment, useState } from "react";
import { FiEdit2, FiSliders } from "react-icons/fi";
import { useT } from "../../i18n";
import type { UiAlign, UiLayoutPrefs, UiSlotId } from "../../types";
import { ICON_EDIT_ALIGNS, alignLabel } from "../../ui-layout-edit";
import {
	HIDDEN_FROM_LAYOUT_ITEM_IDS,
	REQUIRED_TOPBAR_ITEM_IDS,
	restoreAllUi,
	restoreUiItem,
	type UiDiagnostic,
	type UiSlotEntry,
} from "../../ui-slots";

const UI_LAYOUT_SECTIONS: { slot: UiSlotId; labelKey: string }[] = [
	{ slot: "topbar.primary", labelKey: "uiLayoutTopbar" },
	{ slot: "topbar.overflow", labelKey: "uiLayoutTopbarOverflow" },
	{ slot: "notice.actions", labelKey: "uiLayoutNotice" },
	{ slot: "leftpanel.sections", labelKey: "uiLayoutLeftSections" },
	{ slot: "leftpanel.projects.actions", labelKey: "uiLayoutLeftProjectsActions" },
	{ slot: "leftpanel.project", labelKey: "uiLayoutLeftProject" },
	{ slot: "leftpanel.running.actions", labelKey: "uiLayoutLeftRunningActions" },
	{ slot: "leftpanel.running", labelKey: "uiLayoutLeftRunning" },
	{ slot: "leftpanel.history.actions", labelKey: "uiLayoutLeftHistoryActions" },
	{ slot: "leftpanel.history", labelKey: "uiLayoutLeftHistory" },
	{ slot: "leftpanel.sessions", labelKey: "uiLayoutLeftSessions" },
	{ slot: "chat.header", labelKey: "uiLayoutChatHeader" },
	{ slot: "chat.empty", labelKey: "uiLayoutChatEmpty" },
	{ slot: "message.actions", labelKey: "uiLayoutMessage" },
	{ slot: "goalbar.actions", labelKey: "uiLayoutGoalbar" },
	{ slot: "composer.leading", labelKey: "uiLayoutComposerLeading" },
	{ slot: "composer.actions", labelKey: "uiLayoutComposer" },
	{ slot: "rightpanel.tabs", labelKey: "uiLayoutRightPanel" },
	{ slot: "bottomdock.tabs", labelKey: "uiLayoutBottomDock" },
	{ slot: "terminal.toolbar", labelKey: "uiLayoutTerminal" },
	{ slot: "scm.toolbar", labelKey: "uiLayoutScm" },
	{ slot: "bottombar", labelKey: "uiLayoutBottombar" },
	{ slot: "file.preview.toolbar", labelKey: "uiLayoutFilePreview" },
	{ slot: "contextmenu.topbar", labelKey: "uiLayoutContextTopbar" },
	{ slot: "contextmenu.message", labelKey: "uiLayoutContextMessage" },
	{ slot: "contextmenu.session", labelKey: "uiLayoutContextSession" },
	{ slot: "contextmenu.project", labelKey: "uiLayoutContextProject" },
	{ slot: "contextmenu.file", labelKey: "uiLayoutContextFile" },
	{ slot: "contextmenu.search", labelKey: "uiLayoutContextSearch" },
	{ slot: "contextmenu.toolcall", labelKey: "uiLayoutContextToolcall" },
	{ slot: "tool.card.footer", labelKey: "uiLayoutToolCardFooter" },
	{ slot: "settings.pages", labelKey: "uiLayoutSettingsPages" },
	{ slot: "tasks.panel", labelKey: "uiLayoutTasksPanel" },
	{ slot: "modal.dialog", labelKey: "uiLayoutModal" },
	{ slot: "sidebar.left", labelKey: "uiLayoutSidebarLeft" },
	{ slot: "sidebar.right", labelKey: "uiLayoutSidebarRight" },
];

const UI_ALIGN_SLOTS: UiSlotId[] = ["bottombar", "composer.actions", "topbar.primary", "sidebar.left", "sidebar.right"];
const UI_POSITION_SLOTS: UiSlotId[] = ["topbar.primary", "bottombar", "sidebar.left", "sidebar.right"];
const verticalAlignSlot = (slot: string) => slot === "sidebar.left" || slot === "sidebar.right";

/** 设置页「界面布局」Tab：管理各插槽可见性、位置、对齐、排序与自定义标签。 */
export function LayoutTab({
	layout,
	uiSlots,
	uiDiagnostics,
	isDsh,
	onUpdateLayout,
	onOpenIconEdit,
}: {
	layout?: UiLayoutPrefs;
	uiSlots: Record<UiSlotId, UiSlotEntry[]>;
	uiDiagnostics: UiDiagnostic[];
	isDsh: boolean;
	onUpdateLayout: (next: UiLayoutPrefs) => void;
	onOpenIconEdit?: () => void;
}) {
	const t = useT();
	const [uiLayoutFilter, setUiLayoutFilter] = useState("");

	const uiSlotTitle = (slot: UiSlotId): string => {
		const found = UI_LAYOUT_SECTIONS.find((s) => s.slot === slot);
		return found ? t(found.labelKey as Parameters<typeof t>[0]) : slot;
	};

	const setLayout = (patch: UiLayoutPrefs) => onUpdateLayout({ ...layout, ...patch });

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

	const moveUiEntry = (allEntries: UiSlotEntry[], rowItems: UiSlotEntry[], id: string, delta: number) => {
		const groupKeys = rowItems.map((e) => e.id);
		const idx = groupKeys.indexOf(id);
		const target = idx + delta;
		if (idx < 0 || target < 0 || target >= groupKeys.length) return;
		const nextGroup = [...groupKeys];
		const [moved] = nextGroup.splice(idx, 1);
		if (moved === undefined) return;
		nextGroup.splice(target, 0, moved);
		const groupSet = new Set(groupKeys);
		const queue = [...nextGroup];
		const next = allEntries.map((e) => (groupSet.has(e.id) ? (queue.shift() as string) : e.id));
		const inSlot = new Set(allEntries.map((e) => e.id));
		const others = (layout?.order ?? []).filter((x) => !inSlot.has(x));
		setLayout({ order: [...others, ...next] });
	};

	const setUiAlign = (id: string, align: string) => {
		if (align !== "start" && align !== "center" && align !== "end") return;
		setLayout({ align: { ...layout?.align, [id]: align } });
	};

	const setUiSlot = (id: string, targetSlot: UiSlotId) => {
		const slots = { ...layout?.slots, [id]: targetSlot };
		setLayout({ slots });
	};

	const setUiLabel = (id: string, label: string) => {
		const labels = { ...layout?.labels };
		const name = label.trim().slice(0, 60);
		if (!name) delete labels[id];
		else labels[id] = name;
		setLayout({ labels });
	};

	const restoreUi = (id: string) => onUpdateLayout(restoreUiItem(layout, id));
	const restoreUiAll = () => onUpdateLayout(restoreAllUi());

	return (
		<div className="set-section">
			<div className="set-section-title">
				<FiSliders className="set-section-icon" />
				{t("uiLayoutTitle")}
				{onOpenIconEdit && (
					<button
						type="button"
						className="set-uninstall"
						style={{ marginLeft: "auto" }}
						title={t("uiIconEditHint")}
						onClick={onOpenIconEdit}
					>
						<FiEdit2 />
						{t("uiIconEdit")}
					</button>
				)}
				<button
					type="button"
					className="set-uninstall"
					style={onOpenIconEdit ? undefined : { marginLeft: "auto" }}
					onClick={restoreUiAll}
				>
					{t("uiLayoutRestoreAll")}
				</button>
			</div>
			<div className="set-note">{t("uiLayoutHint")}</div>
			<label className="set-toggle" title="sideDockFloat">
				<input
					type="checkbox"
					checked={layout?.sideDockFloat === true}
					onChange={(e) => setLayout({ sideDockFloat: e.target.checked })}
				/>
				<span>{t("uiLayoutSideDockFloat")}</span>
			</label>
			{uiDiagnostics.length > 0 &&
				(() => {
					const hasIssues = uiDiagnostics.some((d) => d.level === "warn" || d.level === "error");
					return (
						<details
							className={`set-ui-diag${hasIssues ? "" : " info-only"}`}
							open={uiDiagnostics.some((d) => d.level === "error")}
						>
							<summary>
								{hasIssues ? "⚠ " : "ℹ "}
								{t("uiLayoutDiagTitle", { n: uiDiagnostics.length })}
							</summary>
							<ul className="set-ui-diag-list">
								{uiDiagnostics.map((d, i) => (
									<li key={`${d.pluginId ?? "host"}:${d.entryId ?? i}`} className={`set-ui-diag-item ${d.level}`}>
										{d.pluginId ? <code>{d.pluginId}</code> : null}
										{d.entryId ? <code>{d.entryId}</code> : null}
										<span>{d.message}</span>
									</li>
								))}
							</ul>
							<div className="set-ui-diag-hint">{t("uiLayoutDiagHint")}</div>
						</details>
					);
				})()}
			<input
				className="set-ui-filter"
				value={uiLayoutFilter}
				placeholder={t("uiLayoutSearch")}
				aria-label={t("uiLayoutSearch")}
				onChange={(e) => setUiLayoutFilter(e.target.value)}
			/>
			{UI_LAYOUT_SECTIONS.map(({ slot, labelKey }) => {
				const entries = (uiSlots[slot] ?? []).filter(
					(e) =>
						(isDsh ||
							(e.id !== "host:composer-dsh-perm" &&
								e.id !== "host:composer-dsh-preset" &&
								e.id !== "host:goal-plan")) &&
						!HIDDEN_FROM_LAYOUT_ITEM_IDS.has(e.id),
				);
				const q = uiLayoutFilter.trim().toLowerCase();
				const grouped = !q && UI_ALIGN_SLOTS.includes(slot);
				const segments: { align: string | null; items: UiSlotEntry[] }[] = grouped
					? (["start", "center", "end"] as const)
							.map((align) => ({ align, items: entries.filter((e) => e.align === align) }))
							.filter((g) => g.items.length > 0)
					: [
							{
								align: null,
								items: q ? entries.filter((e) => `${e.label} ${e.id} ${e.source}`.toLowerCase().includes(q)) : entries,
							},
						];
				const total = segments.reduce((n, g) => n + g.items.length, 0);
				if (q && total === 0) return null;
				const renderRow = (it: UiSlotEntry, rowItems: UiSlotEntry[]) => {
					const idx = rowItems.findIndex((e) => e.id === it.id);
					const required = REQUIRED_TOPBAR_ITEM_IDS.has(it.id);
					return (
						<div key={it.id} className="set-row">
							<label className="set-toggle" title={required ? t("uiLayoutRequired") : it.id}>
								<input type="checkbox" checked={!it.hidden} disabled={required} onChange={() => toggleUiHidden(it)} />
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
								{UI_POSITION_SLOTS.includes(slot) && (
									<label className="set-ui-align" title={t("uiLayoutPosition")}>
										<select
											value={slot}
											onChange={(e) => setUiSlot(it.id, e.target.value as UiSlotId)}
											aria-label={t("uiLayoutPosition")}
										>
											<option value="topbar.primary">{t("uiLayoutPosTop")}</option>
											<option value="bottombar">{t("uiLayoutPosBottom")}</option>
											<option value="sidebar.left">{t("uiLayoutPosLeft")}</option>
											<option value="sidebar.right">{t("uiLayoutPosRight")}</option>
										</select>
									</label>
								)}
								{UI_ALIGN_SLOTS.includes(slot) && (
									<label className="set-ui-align" title={t("uiLayoutAlign")}>
										<select
											value={it.align}
											onChange={(e) => setUiAlign(it.id, e.target.value)}
											aria-label={t("uiLayoutAlign")}
										>
											{ICON_EDIT_ALIGNS.map((al) => (
												<option key={al} value={al}>
													{alignLabel(t, al, verticalAlignSlot(slot))}
												</option>
											))}
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
										if (e.key === "Enter" && !e.nativeEvent.isComposing) (e.target as HTMLInputElement).blur();
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
									{seg.align && (
										<div className="set-ui-slot-title set-ui-seg">
											{alignLabel(t, seg.align as UiAlign, verticalAlignSlot(slot))}
										</div>
									)}
									{seg.items.map((it) => renderRow(it, seg.items))}
								</Fragment>
							))
						)}
					</div>
				);
			})}
		</div>
	);
}
