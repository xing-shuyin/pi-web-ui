/**
 * 复制为图片的模块级状态：同一时刻只有一个导出面板。
 * 勾选集合始终按对话时间线排（早 → 晚），预览/导出从上到下就是从旧到新。
 */
import { useSyncExternalStore } from "react";
import { messageMarkdown } from "./copy-text";

export interface ExportableMsg {
	id: string;
	role: string;
	content: Array<{ type: string; text?: unknown }>;
}

export interface ExportImageState {
	open: boolean;
	triggerId: string;
	/** 已按对话时间线排好（早 → 晚）。 */
	selectedIds: string[];
	/** 默认关：关着时导出图里去掉工具卡；开着时强制展开再拍。 */
	includeTools: boolean;
	/** 默认关：关着时导出图里去掉思考块；开着时强制展开再拍。 */
	includeThinking: boolean;
}

const EMPTY: ExportImageState = {
	open: false,
	triggerId: "",
	selectedIds: [],
	includeTools: false,
	includeThinking: false,
};

let cached: ExportImageState = EMPTY;
let catalog: ExportableMsg[] = [];
const listeners = new Set<() => void>();

function notify(): void {
	for (const l of listeners) l();
}

export function isExportableMessage(m: ExportableMsg): boolean {
	return (m.role === "user" || m.role === "assistant") && messageMarkdown(m.content).length > 0;
}

/** 按 catalog 时间线排序并去重；不在 catalog 里的丢掉。 */
export function sortIdsByCatalog(ids: readonly string[], messages: readonly ExportableMsg[] = catalog): string[] {
	const order = new Map(messages.map((m, i) => [m.id, i]));
	return [...new Set(ids)].filter((id) => order.has(id)).sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
}

export function setExportMessageCatalog(msgs: ExportableMsg[]): void {
	catalog = msgs;
	if (cached.open) {
		const next = sortIdsByCatalog(cached.selectedIds, catalog);
		if (next.join("\0") !== cached.selectedIds.join("\0")) {
			cached = { ...cached, selectedIds: next };
			notify();
		}
	}
}

export function getExportMessageCatalog(): ExportableMsg[] {
	return catalog;
}

export function getExportImage(): ExportImageState {
	return cached;
}

export function subscribeExportImage(cb: () => void): () => void {
	listeners.add(cb);
	return () => {
		listeners.delete(cb);
	};
}

export function useExportImage(): ExportImageState {
	return useSyncExternalStore(subscribeExportImage, getExportImage, getExportImage);
}

export function closeExportImage(): void {
	if (!cached.open) return;
	cached = EMPTY;
	notify();
}

export function openExportImage(triggerId: string): void {
	const trigger = catalog.find((m) => m.id === triggerId);
	if (!trigger || !isExportableMessage(trigger)) return;

	if (cached.open) {
		cached = {
			...cached,
			selectedIds: sortIdsByCatalog([...cached.selectedIds, triggerId]),
		};
		notify();
		return;
	}

	cached = {
		open: true,
		triggerId,
		selectedIds: [triggerId],
		includeTools: false,
		includeThinking: false,
	};
	notify();
}

export function setExportImageIncludes(partial: { includeTools?: boolean; includeThinking?: boolean }): void {
	if (!cached.open) return;
	cached = {
		...cached,
		includeTools: partial.includeTools ?? cached.includeTools,
		includeThinking: partial.includeThinking ?? cached.includeThinking,
	};
	notify();
}

export function toggleExportImageSelect(id: string): void {
	if (!cached.open) return;
	const ordered = catalog.filter(isExportableMessage).map((m) => m.id);
	if (!ordered.includes(id)) return;

	const next = cached.selectedIds.includes(id)
		? cached.selectedIds.filter((x) => x !== id)
		: sortIdsByCatalog([...cached.selectedIds, id]);

	cached = { ...cached, selectedIds: next };
	notify();
}

/** 单测用：清空状态，不通知。 */
export function resetExportImage(): void {
	cached = EMPTY;
	catalog = [];
}
