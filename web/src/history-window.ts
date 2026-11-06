import type { UiMessage, UiState } from "./types";

export interface EarlierPage {
	messages: UiMessage[];
	historyStart: number;
	historyTotal: number;
	historyGeneration?: string;
	beforeId?: string;
	before?: number;
	resyncRequired?: boolean;
}

export function earlierPageNeedsResync(ui: UiState, page: EarlierPage): boolean {
	const start = ui.historyStart ?? 0;
	return (
		page.resyncRequired === true ||
		page.historyGeneration !== ui.historyGeneration ||
		page.historyStart + page.messages.length !== start ||
		(page.before !== undefined && page.before !== start) ||
		(page.historyGeneration !== undefined && (page.before !== start || page.beforeId !== ui.messages[0]?.id))
	);
}

export function mergeEarlierPage(ui: UiState, page: EarlierPage): UiState | null {
	if (earlierPageNeedsResync(ui, page)) return null;
	const curStart = ui.historyStart ?? 0;
	const curTotal = ui.historyTotal ?? ui.messages.length;
	if (page.messages.length === 0) {
		if (page.historyStart === curStart && page.historyTotal === curTotal) return null;
		return { ...ui, historyStart: page.historyStart, historyTotal: page.historyTotal };
	}
	return {
		...ui,
		messages: [...page.messages, ...ui.messages],
		historyStart: page.historyStart,
		historyTotal: page.historyTotal,
	};
}

export function computeEarlierCount(opts: {
	isPagingActive: boolean;
	totalMessages: number;
	visibleCount: number;
	historyStart?: number;
}): number {
	const serverEarlier = Math.max(0, opts.historyStart ?? 0);
	if (!opts.isPagingActive) {
		return serverEarlier;
	}
	const localEarlier = Math.max(0, opts.totalMessages - Math.min(opts.totalMessages, opts.visibleCount));
	return localEarlier + serverEarlier;
}
