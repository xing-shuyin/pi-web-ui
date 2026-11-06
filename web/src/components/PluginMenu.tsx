import {
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type DragEvent,
	type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { FiBox, FiMenu, FiPackage, FiSliders } from "react-icons/fi";
import { PiPushPinFill, PiPushPinSlash } from "react-icons/pi";
import { PluginIcon } from "../plugin-icon";
import { useI18n } from "../i18n";
import { useFloatingPanel } from "../use-floating-panel";
import { excludeBuiltinModules } from "../../../server/builtin-modules";

export interface PluginMenuRow {
	id: string;
	name: string;
	icon?: string;
	iconSvg?: string;
	error?: string;
	view?: boolean;
	hasSettings?: boolean;
}

export interface PluginMenuProps {
	anchorRect: { left: number; right: number; top: number; bottom: number };
	anchorEl?: HTMLElement | null;
	plugins: PluginMenuRow[];
	pinnedIds: ReadonlySet<string>;
	orderedPluginIds?: readonly string[];
	onTogglePin: (pluginId: string, pinned: boolean) => void;
	onReorder: (pluginIds: string[]) => void;
	onOpenView: (pluginId: string) => void;
	onOpenPluginSettings?: (pluginId?: string) => void;
	onManagePlugins: () => void;
	onClose: () => void;
}

export function PluginMenu({
	anchorRect,
	anchorEl,
	plugins,
	pinnedIds,
	orderedPluginIds,
	onTogglePin,
	onReorder,
	onOpenView,
	onOpenPluginSettings,
	onManagePlugins,
	onClose,
}: PluginMenuProps) {
	const { t } = useI18n();
	const {
		panelRef: menuRef,
		style,
		measure,
	} = useFloatingPanel({
		anchor: anchorRect,
		anchorEl,
		onClose,
	});

	const [, setDraggingId] = useState<string | null>(null);
	const draggingIdRef = useRef<string | null>(null);
	const [dropId, setDropId] = useState<string | null>(null);

	const orderedPlugins = useMemo(() => {
		const rank = new Map((orderedPluginIds ?? []).map((id, index) => [id, index]));
		return excludeBuiltinModules(plugins)
			.map((plugin, index) => ({ plugin, index }))
			.sort((a, b) => (rank.get(a.plugin.id) ?? 1_000_000 + a.index) - (rank.get(b.plugin.id) ?? 1_000_000 + b.index))
			.map(({ plugin }) => plugin);
	}, [plugins, orderedPluginIds]);

	const { viewPlugins, extPlugins } = useMemo(() => {
		const viewList: PluginMenuRow[] = [];
		const extList: PluginMenuRow[] = [];
		for (const p of orderedPlugins) {
			if (p.view !== false && !p.error) {
				viewList.push(p);
			} else {
				extList.push(p);
			}
		}
		return { viewPlugins: viewList, extPlugins: extList };
	}, [orderedPlugins]);

	useLayoutEffect(() => {
		measure();
	}, [orderedPlugins, measure]);

	const movePlugin = (id: string, delta: number) => {
		const ids = orderedPlugins.filter((p) => p.view !== false && !p.error).map((p) => p.id);
		const from = ids.indexOf(id);
		const to = from + delta;
		if (from < 0 || to < 0 || to >= ids.length) return;
		const [moved] = ids.splice(from, 1);
		if (!moved) return;
		ids.splice(to, 0, moved);
		onReorder(ids);
	};

	const dropPlugin = (sourceId: string | null, targetId: string) => {
		if (!sourceId || sourceId === targetId) return;
		const ids = orderedPlugins.filter((p) => p.view !== false && !p.error).map((p) => p.id);
		const from = ids.indexOf(sourceId);
		const to = ids.indexOf(targetId);
		if (from < 0 || to < 0) return;
		const [moved] = ids.splice(from, 1);
		if (!moved) return;
		ids.splice(to, 0, moved);
		onReorder(ids);
	};

	const renderPluginRow = (p: PluginMenuRow, isExtGroup: boolean) => {
		const noView = p.view === false || !!p.error;
		const pinned = !noView && pinnedIds.has(p.id);
		const glyph = p.iconSvg ? undefined : p.icon && !/[a-z]/i.test(p.icon) ? p.icon : undefined;

		return (
			<div
				key={p.id}
				className={`pm-row${dropId === p.id ? " drop-target" : ""}${isExtGroup ? " pm-row-ext" : ""}`}
				role="none"
				onDragOver={(e) => {
					if (noView || !draggingIdRef.current) return;
					e.preventDefault();
					setDropId(p.id);
				}}
				onDrop={(e) => {
					e.preventDefault();
					dropPlugin(e.dataTransfer.getData("text/plain") || draggingIdRef.current, p.id);
					draggingIdRef.current = null;
					setDraggingId(null);
					setDropId(null);
				}}
			>
				{!noView ? (
					<button
						type="button"
						className="pm-drag"
						draggable
						aria-label={t("pluginMenuReorder")}
						title={t("pluginMenuReorderHint")}
						onDragStart={(e: DragEvent<HTMLButtonElement>) => {
							setDraggingId(p.id);
							draggingIdRef.current = p.id;
							e.dataTransfer.effectAllowed = "move";
							e.dataTransfer.setData("text/plain", p.id);
							const ghost = document.createElement("div");
							ghost.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0";
							document.body.appendChild(ghost);
							e.dataTransfer.setDragImage(ghost, 0, 0);
							requestAnimationFrame(() => ghost.remove());
						}}
						onDragEnd={() => {
							draggingIdRef.current = null;
							setDraggingId(null);
							setDropId(null);
						}}
						onKeyDown={(e: ReactKeyboardEvent<HTMLButtonElement>) => {
							if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
							e.preventDefault();
							movePlugin(p.id, e.key === "ArrowUp" ? -1 : 1);
						}}
					>
						<FiMenu aria-hidden />
					</button>
				) : (
					<span className="pm-drag-placeholder" aria-hidden />
				)}

				<button
					type="button"
					role="menuitem"
					className="pm-row-main"
					disabled={noView}
					title={p.error ?? (noView ? t("pluginMenuNoView") : p.name)}
					onClick={() => onOpenView(p.id)}
				>
					{glyph || p.iconSvg ? (
						<PluginIcon icon={glyph} iconSvg={p.iconSvg} className="pm-icon" />
					) : (
						<FiBox className="pm-icon" aria-hidden />
					)}
					<span className="pm-name">{p.name}</span>
					{p.error ? (
						<span className="pm-err-tag" title={p.error}>
							{t("pluginPhaseFailed")}
						</span>
					) : isExtGroup ? (
						<span className="pm-ext-tag" title={t("pluginMenuNoView")}>
							{t("pluginBadgeBg")}
						</span>
					) : null}
				</button>

				<div className="pm-row-actions">
					{p.hasSettings && onOpenPluginSettings && (
						<button
							type="button"
							className="pm-action-btn"
							title={t("pluginQuickSettings")}
							onClick={() => {
								onClose();
								onOpenPluginSettings(p.id);
							}}
						>
							<FiSliders aria-hidden />
						</button>
					)}

					{!noView && (
						<button
							type="button"
							role="menuitemcheckbox"
							aria-checked={pinned}
							aria-label={pinned ? t("pluginMenuUnpin") : t("pluginMenuPin")}
							title={pinned ? t("pluginMenuUnpin") : t("pluginMenuPin")}
							className={`pm-pin${pinned ? " on" : ""}`}
							onClick={() => onTogglePin(p.id, !pinned)}
						>
							{pinned ? <PiPushPinFill aria-hidden /> : <PiPushPinSlash aria-hidden />}
						</button>
					)}
				</div>
			</div>
		);
	};

	return createPortal(
		<div ref={menuRef} className="pm-panel" role="menu" aria-label={t("pluginMenuTitle")} style={style}>
			<div className="pm-head" aria-hidden="true">
				<div className="pm-head-left">
					<FiBox className="pm-head-icon" aria-hidden />
					<span className="pm-head-title">{t("pluginMenuTitle")}</span>
					<span className="pm-head-count">{orderedPlugins.length}</span>
				</div>
				{onOpenPluginSettings && (
					<button
						type="button"
						className="pm-head-btn"
						title={t("pluginManagerDesc")}
						onClick={() => {
							onClose();
							onOpenPluginSettings();
						}}
					>
						<FiSliders aria-hidden />
						<span>{t("pluginMenuSettings")}</span>
					</button>
				)}
			</div>

			<div className="pm-list">
				{orderedPlugins.length === 0 ? (
					<div className="pm-empty">{t("pluginMenuEmpty")}</div>
				) : (
					<>
						{viewPlugins.length > 0 && (
							<div className="pm-group">
								{extPlugins.length > 0 && (
									<div className="pm-section-title">
										<span>{t("pluginGroupViews")}</span>
										<span className="pm-section-count">{viewPlugins.length}</span>
									</div>
								)}
								{viewPlugins.map((p) => renderPluginRow(p, false))}
							</div>
						)}

						{extPlugins.length > 0 && (
							<div className="pm-group">
								{viewPlugins.length > 0 && (
									<div className="pm-section-title">
										<span>{t("pluginGroupExtensions")}</span>
										<span className="pm-section-count">{extPlugins.length}</span>
									</div>
								)}
								{extPlugins.map((p) => renderPluginRow(p, true))}
							</div>
						)}
					</>
				)}
			</div>

			<div className="pm-footer">
				{onOpenPluginSettings && (
					<button
						type="button"
						role="menuitem"
						className="pm-footer-btn primary"
						onClick={() => {
							onClose();
							onOpenPluginSettings();
						}}
					>
						<FiSliders aria-hidden />
						<span>{t("pluginMenuSettings")}</span>
					</button>
				)}
				<button
					type="button"
					role="menuitem"
					className="pm-footer-btn pm-manage"
					onClick={() => {
						onClose();
						onManagePlugins();
					}}
				>
					<FiPackage aria-hidden />
					<span>{t("pluginMenuManage")}</span>
				</button>
			</div>
		</div>,
		document.body,
	);
}
