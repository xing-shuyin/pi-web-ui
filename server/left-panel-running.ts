import type { PluginPanelGroup, PluginPanelItem } from "./protocol.js";

export const PANEL_ITEM_CAP = 50;
export const PANEL_TTL_DEFAULT_MS = 60_000;
export const PANEL_TTL_MIN_MS = 5_000;
export const PANEL_TTL_MAX_MS = 3_600_000;

const ID_MAX = 96;
const TITLE_MAX = 200;
const HINT_MAX = 200;
const ICON_MAX = 8;
const ACTION_MAX = 96;
const STATUSES: ReadonlySet<string> = new Set(["running", "done", "error"]);

export interface PanelSanitizeResult {
	items: PluginPanelItem[];
	diags: string[];
}

export function sanitizePanelItems(raw: unknown): PanelSanitizeResult {
	const diags: string[] = [];
	const items: PluginPanelItem[] = [];
	if (!Array.isArray(raw)) {
		diags.push("setRunning: items must be an array — ignored");
		return { items, diags };
	}
	const seen = new Set<string>();
	raw.forEach((rawItem, idx) => {
		if (!rawItem || typeof rawItem !== "object") {
			diags.push(`setRunning[#${idx}]: not an object — dropped`);
			return;
		}
		const o = rawItem as Record<string, unknown>;
		const id = typeof o.id === "string" ? o.id.trim().slice(0, ID_MAX) : "";
		if (!id) {
			diags.push(`setRunning[#${idx}]: missing id — dropped`);
			return;
		}
		if (seen.has(id)) {
			diags.push(`setRunning: duplicate id "${id}" — later one dropped`);
			return;
		}
		if (items.length >= PANEL_ITEM_CAP) {
			diags.push(`setRunning: capped at ${PANEL_ITEM_CAP} items — "${id}" and later dropped`);
			return;
		}
		seen.add(id);
		const title = typeof o.title === "string" && o.title.trim() ? o.title.trim().slice(0, TITLE_MAX) : id;
		let status: PluginPanelItem["status"] = "running";
		if (o.status !== undefined) {
			if (typeof o.status === "string" && STATUSES.has(o.status)) status = o.status as PluginPanelItem["status"];
			else diags.push(`setRunning["${id}"]: unknown status — treated as "running"`);
		}
		const item: PluginPanelItem = { id, title, status };
		if (typeof o.hint === "string" && o.hint.trim()) item.hint = o.hint.trim().slice(0, HINT_MAX);
		if (typeof o.icon === "string" && o.icon.trim()) item.icon = o.icon.trim().slice(0, ICON_MAX);
		if (typeof o.action === "string" && o.action.trim()) item.action = o.action.trim().slice(0, ACTION_MAX);
		items.push(item);
	});
	return { items, diags };
}

export function clampPanelTtl(raw: unknown): number {
	const n = typeof raw === "number" && Number.isFinite(raw) ? raw : PANEL_TTL_DEFAULT_MS;
	return Math.min(PANEL_TTL_MAX_MS, Math.max(PANEL_TTL_MIN_MS, Math.round(n)));
}

interface PluginPanelSlot {
	pluginName: string;
	items: PluginPanelItem[];
	ttlMs: number;
	touchedAt: number;
}

export interface PanelSetOutcome {
	count: number;
	changed: boolean;
	diags: string[];
}

export class LeftPanelRunningStore {
	private readonly slots = new Map<string, PluginPanelSlot>();

	constructor(private readonly now: () => number = Date.now) {}

	set(pluginId: string, pluginName: string, raw: unknown, opts?: { ttlMs?: unknown }): PanelSetOutcome {
		const { items, diags } = sanitizePanelItems(raw);
		if (items.length === 0) {
			const had = this.slots.delete(pluginId);
			return { count: 0, changed: had, diags };
		}
		const ttlMs = clampPanelTtl(opts?.ttlMs);
		const prev = this.slots.get(pluginId);
		const changed = !prev || prev.pluginName !== pluginName || JSON.stringify(prev.items) !== JSON.stringify(items);
		this.slots.set(pluginId, { pluginName, items, ttlMs, touchedAt: this.now() });
		return { count: items.length, changed, diags };
	}

	clear(pluginId: string): boolean {
		return this.slots.delete(pluginId);
	}

	sweep(): string[] {
		const t = this.now();
		const expired: string[] = [];
		for (const [pluginId, slot] of this.slots) {
			if (t - slot.touchedAt > slot.ttlMs) {
				this.slots.delete(pluginId);
				expired.push(pluginId);
			}
		}
		return expired;
	}

	groups(): PluginPanelGroup[] {
		return [...this.slots.entries()]
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([pluginId, slot]) => ({
				pluginId,
				pluginName: slot.pluginName,
				items: slot.items.map((it) => ({ ...it })),
			}));
	}

	get size(): number {
		return this.slots.size;
	}
}
