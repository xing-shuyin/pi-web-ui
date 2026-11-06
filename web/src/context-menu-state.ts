/// <reference lib="dom" />
import { useSyncExternalStore } from "react";
import type { UiSlotEntry } from "./ui-slots";
import type { UiSlotId } from "./types";

type ContextMenuSlot = Extract<UiSlotId, `contextmenu.${string}`>;

export interface ContextMenuRequest {
	x: number;
	y: number;
	slot: ContextMenuSlot;
	target: { id: string; kind?: string; label?: string; owner?: string };
	entries: UiSlotEntry[];
	onHostAction?: (entry: UiSlotEntry, target: ContextMenuRequest["target"]) => void | boolean;
}

let cached: ContextMenuRequest | null = null;

const listeners = new Set<() => void>();

function notify(): void {
	for (const l of listeners) l();
}

export function openContextMenu(req: ContextMenuRequest): void {
	cached = {
		x: Number.isFinite(req.x) ? req.x : 0,
		y: Number.isFinite(req.y) ? req.y : 0,
		slot: req.slot,
		target: req.target ?? { id: "" },
		entries: Array.isArray(req.entries) ? req.entries : [],
		...(typeof req.onHostAction === "function" ? { onHostAction: req.onHostAction } : {}),
	};
	notify();
}

export function closeContextMenu(): void {
	if (cached === null) return;
	cached = null;
	notify();
}

export function subscribeContextMenu(cb: () => void): () => void {
	listeners.add(cb);
	return () => {
		listeners.delete(cb);
	};
}

export function getContextMenu(): ContextMenuRequest | null {
	return cached;
}

export function resetContextMenu(): void {
	cached = null;
}

export function useContextMenu(): ContextMenuRequest | null {
	return useSyncExternalStore(subscribeContextMenu, getContextMenu, getContextMenu);
}

export const MENU_MARGIN = 8;

function finite(v: number): number {
	return Number.isFinite(v) ? v : 0;
}

export function clampMenuPosition(
	x: number,
	y: number,
	w: number,
	h: number,
	vw: number,
	vh: number,
): { x: number; y: number } {
	const width = Math.max(0, finite(w));
	const height = Math.max(0, finite(h));
	const maxX = Math.max(MENU_MARGIN, finite(vw) - width - MENU_MARGIN);
	const maxY = Math.max(MENU_MARGIN, finite(vh) - height - MENU_MARGIN);
	return {
		x: Math.min(Math.max(MENU_MARGIN, finite(x)), maxX),
		y: Math.min(Math.max(MENU_MARGIN, finite(y)), maxY),
	};
}

type WhenContext = Record<string, boolean>;

export function buildWhenContext(slot: ContextMenuSlot, target: ContextMenuRequest["target"] | undefined): WhenContext {
	const kind = String(target?.kind ?? "");
	if (slot === "contextmenu.file") {
		const isDir = kind === "dir" || (kind === "list" && target?.id !== "@root");
		return { "file.isDir": isDir, "file.isFile": kind === "file" };
	}
	if (slot === "contextmenu.session") return { "session.isRunning": kind === "running" };
	if (slot === "contextmenu.message") {
		let hasSelection = false;
		try {
			const sel = window.getSelection?.();
			hasSelection = !!sel && !sel.isCollapsed && sel.toString().trim().length > 0;
		} catch {
			hasSelection = false;
		}
		return { "message.hasSelection": hasSelection };
	}
	return {};
}

export function evaluateWhen(when: string[] | undefined, ctx?: WhenContext): boolean {
	if (!Array.isArray(when) || when.length === 0) return false;
	for (const raw of when) {
		if (typeof raw !== "string" || !raw) continue;
		const c = raw.trim();
		if (c === "disabled" || c === "never") return true;
		if (c === "always") continue;
		if (c.startsWith("!")) {
			const key = c.slice(1).trim();
			if (!key) continue;
			if (!ctx || ctx[key] !== true) return true;
			continue;
		}
		if (ctx && ctx[c] === false) return true;
	}
	return false;
}

export function isContextMenuEntryDisabled(entry: UiSlotEntry | undefined, ctx?: WhenContext): boolean {
	if (!entry) return true;
	return evaluateWhen(entry.when, ctx);
}

export function expandSelectEntries(entries: UiSlotEntry[]): {
	items: UiSlotEntry[];
	selectParents: Map<string, { parent: UiSlotEntry; value: string }>;
} {
	const parents = new Map<string, { parent: UiSlotEntry; value: string }>();
	const items = (Array.isArray(entries) ? entries : []).map((it) => {
		if (!it || it.kind !== "select" || !it.options?.length || it.children?.length) return it;
		const children: UiSlotEntry[] = it.options.map((o, i) => ({
			id: `${it.id}#${i}`,
			slot: it.slot,
			source: it.source,
			label: o.label,
			kind: "action" as const,
			order: 100,
			align: "start" as const,
			hidden: false,
			userOverrides: [],
			arrangedBy: [],
		}));
		children.forEach((c, i) => parents.set(c.id, { parent: it, value: it.options![i]!.value }));
		return { ...it, kind: "menu" as const, children };
	});
	return { items, selectParents: parents };
}

export function contextMenuItems(entries: UiSlotEntry[]): UiSlotEntry[] {
	if (!Array.isArray(entries) || entries.length === 0) return [];
	const kept = entries.filter((e) => e && e.hidden !== true);
	const real = kept.filter((e) => e.kind !== "divider");

	const groupRank = new Map<string, number>();
	const groupMinOrder = new Map<string, number>();
	real.forEach((e, index) => {
		const key = e.group ?? "";
		if (!groupRank.has(key)) groupRank.set(key, index);
		const order = Number.isFinite(e.order) ? e.order : 100;
		const min = groupMinOrder.get(key);
		if (min === undefined || order < min) groupMinOrder.set(key, order);
	});
	const sortedGroups = [...groupRank.keys()].sort((a, b) => {
		const oa = groupMinOrder.get(a) ?? 100;
		const ob = groupMinOrder.get(b) ?? 100;
		if (oa !== ob) return oa - ob;
		return (groupRank.get(a) ?? 0) - (groupRank.get(b) ?? 0);
	});
	const groupPos = new Map(sortedGroups.map((key, i) => [key, i]));

	const seq = new Map<UiSlotEntry, number>();
	real.forEach((e, i) => seq.set(e, i));
	const sorted = [...real].sort((a, b) => {
		const ga = groupPos.get(a.group ?? "") ?? 0;
		const gb = groupPos.get(b.group ?? "") ?? 0;
		if (ga !== gb) return ga - gb;
		const oa = Number.isFinite(a.order) ? a.order : 100;
		const ob = Number.isFinite(b.order) ? b.order : 100;
		if (oa !== ob) return oa - ob;
		return (seq.get(a) ?? 0) - (seq.get(b) ?? 0);
	});

	const anchor = new Map<UiSlotEntry, UiSlotEntry[]>();
	kept.forEach((e, i) => {
		if (e.kind !== "divider") return;
		const next = kept.slice(i + 1).find((x) => x.kind !== "divider");
		if (!next) return;
		const list = anchor.get(next) ?? [];
		list.push(e);
		anchor.set(next, list);
	});

	const out: UiSlotEntry[] = [];
	for (const e of sorted) {
		for (const sep of anchor.get(e) ?? []) out.push(sep);
		out.push(e);
	}
	return out;
}

type ContextMenuRow = { kind: "sep"; key: string } | { kind: "item"; key: string; index: number; entry: UiSlotEntry };

export function contextMenuRows(items: UiSlotEntry[]): ContextMenuRow[] {
	const rows: ContextMenuRow[] = [];
	let prevGroup: string | null = null;
	let pendingSep = false;
	items.forEach((entry, index) => {
		if (!entry || entry.kind === "divider") {
			pendingSep = true;
			return;
		}
		const group = entry.group ?? "";
		if (prevGroup !== null && (pendingSep || group !== prevGroup)) {
			rows.push({ kind: "sep", key: `sep:${index}` });
		}
		rows.push({ kind: "item", key: `${entry.id}#${index}`, index, entry });
		prevGroup = group;
		pendingSep = false;
	});
	return rows;
}

function navigable(entry: UiSlotEntry | undefined, ctx?: WhenContext): boolean {
	if (!entry) return false;
	if (entry.kind === "divider") return false;
	if (entry.hidden === true) return false;
	return !isContextMenuEntryDisabled(entry, ctx);
}

export function nextEnabledIndex(items: UiSlotEntry[], current: number, delta: number, ctx?: WhenContext): number {
	const n = Array.isArray(items) ? items.length : 0;
	if (n === 0) return -1;
	const step = delta >= 0 ? 1 : -1;
	let i = Number.isFinite(current) ? Math.trunc(current) : -1;
	if (i < 0 || i >= n) i = step > 0 ? -1 : n;
	for (let k = 0; k < n; k++) {
		i = (i + step + n) % n;
		if (navigable(items[i], ctx)) return i;
	}
	return -1;
}

const GLYPHS: Record<string, string> = {
	menu: "☰",
	folder: "📁",
	plus: "＋",
	chat: "💬",
	terminal: "▙",
	git: "⎇",
	search: "🔍",
	browser: "🌐",
	layers: "🗂",
	settings: "⚙",
	sound: "🔊",
	globe: "🌍",
	sun: "☀",
	download: "⤓",
	github: "⌗",
	x: "✕",
	upload: "⬆",
	copy: "⧉",
	cut: "✂",
	paste: "📋",
	trash: "🗑",
	file: "📄",
	open: "↗",
	refresh: "⟳",
	link: "🔗",
	edit: "✎",
	dot: "●",
	info: "ⓘ",
	cpu: "▣",
	gauge: "▤",
	coins: "◉",
	database: "▥",
	message: "✉",
	activity: "〜",
	markdown: "📄",
	text: "≡",
	image: "🖼",
	branch: "⚚",
	undo: "↺",
	pin: "📌",
	volume: "🔊",
};

export function contextMenuGlyph(icon?: string): string {
	const s = (icon ?? "").trim();
	if (!s) return "";
	const known = GLYPHS[s.toLowerCase()];
	if (known) return known;
	return /[^\p{L}\p{N}\s]/u.test(s) && s.length <= 4 ? s : "";
}
