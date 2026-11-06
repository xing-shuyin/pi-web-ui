import type { UiAlign, UiLayoutPrefs, UiSlotId } from "./types";
import type { UiSlotEntry } from "./ui-slots";

interface IconEditZone {
	slot: UiSlotId;
	labelKey: string;
	alignable: boolean;
	vertical: boolean;
}

export const ICON_EDIT_ZONES: readonly IconEditZone[] = [
	{ slot: "topbar.primary", labelKey: "uiLayoutTopbar", alignable: true, vertical: false },
	{ slot: "bottombar", labelKey: "uiLayoutBottombar", alignable: true, vertical: false },
	{ slot: "sidebar.left", labelKey: "uiLayoutSidebarLeft", alignable: true, vertical: true },
	{ slot: "sidebar.right", labelKey: "uiLayoutSidebarRight", alignable: true, vertical: true },
];

export const ICON_EDIT_TRAY = "__tray";

export const ICON_EDIT_ALIGNS: readonly UiAlign[] = ["start", "center", "end"];

export function sideAlignLabel(
	t: (key: "uiLayoutAlignTop" | "uiLayoutAlignMiddle" | "uiLayoutAlignBottom") => string,
	align: UiAlign,
): string {
	return t(align === "start" ? "uiLayoutAlignTop" : align === "end" ? "uiLayoutAlignBottom" : "uiLayoutAlignMiddle");
}

interface IconDrop {
	id: string;
	slot: UiSlotId;
	align?: UiAlign;
	index: number;
}

interface IconEditBuckets {
	zones: Record<string, UiSlotEntry[]>;
	tray: UiSlotEntry[];
}

export function collectIconEditItems(
	slots: Record<string, UiSlotEntry[] | undefined>,
	exclude: ReadonlySet<string> = new Set(),
): IconEditBuckets {
	const zones: Record<string, UiSlotEntry[]> = {};
	const tray: UiSlotEntry[] = [];
	const inTray = new Set<string>();
	for (const zone of ICON_EDIT_ZONES) {
		const list = (slots[zone.slot] ?? []).filter((e) => !exclude.has(e.id));
		zones[zone.slot] = list;
		for (const entry of list) {
			if (entry.hidden) {
				tray.push(entry);
				inTray.add(entry.id);
			}
		}
	}
	for (const entry of slots["topbar.overflow"] ?? []) {
		if (exclude.has(entry.id) || inTray.has(entry.id)) continue;
		tray.push(entry);
		inTray.add(entry.id);
	}
	return { zones, tray };
}

export function findIconEditEntry(buckets: IconEditBuckets, id: string): UiSlotEntry | undefined {
	for (const list of Object.values(buckets.zones)) {
		const hit = list.find((e) => e.id === id);
		if (hit) return hit;
	}
	return buckets.tray.find((e) => e.id === id);
}

export function visibleZoneEntries(entries: readonly UiSlotEntry[] | undefined): UiSlotEntry[] {
	return (entries ?? []).filter((e) => !e.hidden);
}

export function zoneEntriesForAlign(
	entries: readonly UiSlotEntry[] | undefined,
	align: UiAlign | undefined,
): UiSlotEntry[] {
	const visible = visibleZoneEntries(entries);
	if (align === undefined) return visible;
	return visible.filter((e) => (e.align ?? "start") === align);
}

function uniq(list: readonly string[]): string[] {
	return [...new Set(list)];
}

export function applyIconDrop(
	layout: UiLayoutPrefs | undefined,
	buckets: IconEditBuckets,
	drop: IconDrop,
): UiLayoutPrefs {
	const src = layout ?? {};
	const dragged = findIconEditEntry(buckets, drop.id);
	if (!dragged) return src;

	const next: UiLayoutPrefs = { ...src };

	if (dragged.hidden) {
		next.hidden = (src.hidden ?? []).filter((x) => x !== drop.id);
		next.shown = uniq([...(src.shown ?? []), drop.id]);
	}

	if (dragged.slot !== drop.slot) {
		next.slots = { ...src.slots, [drop.id]: drop.slot };
	}

	const align = drop.align;
	if (align !== undefined && (dragged.align ?? "start") !== align) {
		next.align = { ...src.align, [drop.id]: align };
	}

	const zone = buckets.zones[drop.slot] ?? [];
	const visible = visibleZoneEntries(zone);
	const inGroup = (e: UiSlotEntry): boolean => (align === undefined ? true : (e.align ?? "start") === align);
	const groupIds = visible.filter((e) => e.id !== drop.id && inGroup(e)).map((e) => e.id);
	const at = Math.max(0, Math.min(Math.trunc(drop.index) || 0, groupIds.length));
	groupIds.splice(at, 0, drop.id);
	const otherIds = align === undefined ? [] : visible.filter((e) => e.id !== drop.id && !inGroup(e)).map((e) => e.id);
	const zoneIds = new Set(zone.map((e) => e.id));
	const others = (src.order ?? []).filter((x) => !zoneIds.has(x) && x !== drop.id);
	next.order = uniq([...others, ...groupIds, ...otherIds]);

	return next;
}

export function applyIconHide(layout: UiLayoutPrefs | undefined, id: string): UiLayoutPrefs {
	const src = layout ?? {};
	return {
		...src,
		hidden: uniq([...(src.hidden ?? []), id]),
		shown: (src.shown ?? []).filter((x) => x !== id),
	};
}
