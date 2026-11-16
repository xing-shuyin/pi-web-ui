import {
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type PointerEvent as ReactPointerEvent,
	type ReactNode,
} from "react";
import { FiX } from "react-icons/fi";
import { useT } from "../i18n";
import { appSend } from "../app-globals";
import type { UiAlign, UiLayoutPrefs, UiSlotId } from "../types";
import { REQUIRED_TOPBAR_ITEM_IDS, type UiSlotEntry } from "../ui-slots";
import { useEscapeKey } from "../shortcut-stack";
import { hostEntryIcon } from "../host-icon";
import {
	ICON_EDIT_ALIGNS,
	ICON_EDIT_TRAY,
	ICON_EDIT_ZONES,
	alignLabel,
	applyIconDrop,
	applyIconHide,
	collectIconEditItems,
	visibleZoneEntries,
	zoneEntriesForAlign,
} from "../ui-layout-edit";

interface IconEditorProps {
	slots: Record<UiSlotId, UiSlotEntry[]>;
	layout: UiLayoutPrefs | undefined;
	exclude?: ReadonlySet<string>;
	onClose: () => void;
}

interface DropTarget {
	slot: string;
	align?: UiAlign;
	index: number;
}

export function IconEditor({ slots, layout, exclude, onClose }: IconEditorProps) {
	const t = useT();
	const [dragId, setDragId] = useState<string | null>(null);
	const [drop, setDrop] = useState<DropTarget | null>(null);
	const buckets = useMemo(() => collectIconEditItems(slots, exclude), [slots, exclude]);

	const dragRef = useRef<string | null>(null);
	const dropRef = useRef<DropTarget | null>(null);
	const bucketsRef = useRef(buckets);
	const layoutRef = useRef(layout);
	const pendingRef = useRef<UiLayoutPrefs | null>(null);
	useLayoutEffect(() => {
		bucketsRef.current = buckets;
		layoutRef.current = layout;
	});
	useEffect(() => {
		pendingRef.current = null;
	}, [layout]);

	const pointToTarget = (x: number, y: number): DropTarget | null => {
		const el = document.elementFromPoint(x, y) as HTMLElement | null;
		const strip = el?.closest<HTMLElement>("[data-drop-slot]");
		if (!strip) return null;
		const slot = strip.dataset.dropSlot;
		if (!slot) return null;
		const align = strip.dataset.dropAlign as UiAlign | undefined;
		const dragging = dragRef.current;
		const chips = Array.from(strip.querySelectorAll<HTMLElement>("[data-chip]")).filter(
			(c) => c.dataset.chip !== dragging,
		);
		let index = chips.length;
		for (let i = 0; i < chips.length; i++) {
			const r = chips[i]!.getBoundingClientRect();
			if (y < r.top) {
				index = i;
				break;
			}
			if (y <= r.bottom + 4 && x < r.left + r.width / 2) {
				index = i;
				break;
			}
		}
		return { slot, align, index };
	};

	/** 所有布局改写都从这里发出：pendingRef 吸收连续操作，避免服务端回执尚未到时互相覆盖。 */
	const setLayout = (next: UiLayoutPrefs) => {
		pendingRef.current = next;
		appSend({ type: "set_settings", uiLayout: next });
	};

	const commitDrop = () => {
		const id = dragRef.current;
		const target = dropRef.current;
		dragRef.current = null;
		dropRef.current = null;
		setDragId(null);
		setDrop(null);
		if (!id || !target) return;
		const base = pendingRef.current ?? layoutRef.current;
		setLayout(
			target.slot === ICON_EDIT_TRAY
				? applyIconHide(base, id)
				: applyIconDrop(base, bucketsRef.current, {
						id,
						slot: target.slot as UiSlotId,
						...(target.align !== undefined ? { align: target.align } : {}),
						index: target.index,
					}),
		);
	};

	/** 右上角 × 一键隐藏，不必再拖到最下面的隐藏区。 */
	const hideEntry = (id: string) => {
		if (dragRef.current) return;
		setLayout(applyIconHide(pendingRef.current ?? layoutRef.current, id));
	};

	useEffect(() => {
		if (!dragId) return;
		const onMove = (e: PointerEvent) => {
			e.preventDefault();
			const target = pointToTarget(e.clientX, e.clientY);
			dropRef.current = target;
			setDrop(target);
		};
		const onUp = () => commitDrop();
		window.addEventListener("pointermove", onMove, { passive: false });
		window.addEventListener("pointerup", onUp);
		window.addEventListener("pointercancel", onUp);
		return () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onUp);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [dragId]);

	useEscapeKey(() => {
		if (dragRef.current) return;
		onClose();
	});

	const startDrag = (e: ReactPointerEvent<HTMLElement>, id: string) => {
		if (e.pointerType === "mouse" && e.button !== 0) return;
		e.preventDefault();
		dragRef.current = id;
		dropRef.current = null;
		setDragId(id);
		setDrop(null);
	};

	const renderChip = (entry: UiSlotEntry, inTray: boolean): ReactNode => {
		// 固定入口（设置 / 历史 / 文件）服务端强制可见，给 × 只会让人以为点了没反应。
		const hideable = !inTray && !REQUIRED_TOPBAR_ITEM_IDS.has(entry.id);
		return (
			<span key={entry.id} className={`icon-editor-chip-wrap${dragId === entry.id ? " dragging" : ""}`}>
				<button
					type="button"
					data-chip={entry.id}
					className="icon-editor-chip"
					title={entry.label}
					onPointerDown={(e) => startDrag(e, entry.id)}
				>
					<span className="icon-editor-chip-icon">{hostEntryIcon(entry)}</span>
					<span className="icon-editor-chip-label">{entry.label}</span>
				</button>
				{hideable && (
					<button
						type="button"
						className="icon-editor-chip-hide"
						title={t("uiLayoutHide")}
						aria-label={`${t("uiLayoutHide")} ${entry.label}`}
						onPointerDown={(e) => e.stopPropagation()}
						onClick={(e) => {
							e.stopPropagation();
							hideEntry(entry.id);
						}}
					>
						<FiX />
					</button>
				)}
			</span>
		);
	};

	const renderStrip = (slot: string, align: UiAlign | undefined, hint: string | null, entries: UiSlotEntry[]) => {
		const active = drop?.slot === slot && (drop.align ?? null) === (align ?? null);
		const inTray = slot === ICON_EDIT_TRAY;
		const children: ReactNode[] = entries.map((entry) => renderChip(entry, inTray));
		if (active && drop) {
			children.splice(
				Math.max(0, Math.min(drop.index, children.length)),
				0,
				<span key="__caret" className="icon-editor-caret" aria-hidden="true" />,
			);
		}
		return (
			<div
				key={align ?? "__all"}
				className={`icon-editor-strip${active ? " drop-over" : ""}${dragId ? " dragging-active" : ""}`}
				data-drop-slot={slot}
				{...(align !== undefined ? { "data-drop-align": align } : {})}
			>
				{hint !== null && <span className="icon-editor-strip-label">{hint}</span>}
				{children}
				{entries.length === 0 && <span className="icon-editor-empty">{t("uiIconEditDropHere")}</span>}
			</div>
		);
	};

	return (
		<>
			<div className="icon-editor-backdrop" onClick={onClose} />
			<div className="icon-editor" role="dialog" aria-modal="true" aria-label={t("uiIconEditTitle")}>
				<div className="icon-editor-head">
					<span className="icon-editor-title">{t("uiIconEditTitle")}</span>
					<span className="icon-editor-hint">{t("uiIconEditHint")}</span>
					<button
						type="button"
						className="icon-editor-close"
						onClick={onClose}
						aria-label={t("close")}
						title={t("close")}
					>
						<FiX />
					</button>
				</div>
				<div className="icon-editor-body">
					{ICON_EDIT_ZONES.map((zone) => {
						const zoneEntries = buckets.zones[zone.slot] ?? [];
						const visible = visibleZoneEntries(zoneEntries);
						return (
							<div className="icon-editor-zone" key={zone.slot}>
								<div className="icon-editor-zone-title">
									{t(zone.labelKey as Parameters<typeof t>[0])}
									{dragId && <span className="icon-editor-zone-count">{visible.length}</span>}
								</div>
								{zone.alignable
									? ICON_EDIT_ALIGNS.map((al) =>
											renderStrip(
												zone.slot,
												al,
												alignLabel(t, al, zone.vertical),
												zoneEntriesForAlign(zoneEntries, al),
											),
										)
									: renderStrip(zone.slot, undefined, null, visible)}
							</div>
						);
					})}
				</div>
				{/* 隐藏区常驻面板底部（不跟滚动区一起滚），随时能把条目拖回任意栏位。 */}
				<div className="icon-editor-tray">
					<div className="icon-editor-tray-head">
						<span className="icon-editor-zone-title">
							{t("uiIconEditTray")}
							<span className="icon-editor-zone-count">{buckets.tray.length}</span>
						</span>
						<span className="icon-editor-tray-hint">{t("uiIconEditTrayHint")}</span>
					</div>
					{renderStrip(ICON_EDIT_TRAY, undefined, null, buckets.tray)}
				</div>
			</div>
		</>
	);
}
