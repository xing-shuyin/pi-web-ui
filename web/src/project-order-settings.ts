/// <reference lib="dom" />

import { useSyncExternalStore } from "react";

const MANUAL_KEY = "pi-web-ui:project-order-manual";
const ORDER_KEY = "pi-web-ui:lp-project-order";
/** 首次出现时间的记忆上限：只用于「没聊过天的项目」排序，超出就丢最久未出现的。 */
const FIRST_SEEN_MAX = 400;

const listeners = new Set<() => void>();

function emit(): void {
	for (const l of listeners) l();
}

function subscribe(onStoreChange: () => void): () => void {
	listeners.add(onStoreChange);
	return () => {
		listeners.delete(onStoreChange);
	};
}

interface PersistedOrder {
	/** 当前展示顺序（归一化路径）。手动模式下它是排序权威，自动模式下是当前顺序的镜像。 */
	order: string[];
	/** 项目第一次出现在本浏览器的时刻（毫秒），用于「从未对话过」的项目排序。 */
	firstSeen: Record<string, number>;
}

function readOrderState(): PersistedOrder {
	try {
		const raw = localStorage.getItem(ORDER_KEY);
		if (raw) {
			const parsed = JSON.parse(raw) as Partial<PersistedOrder>;
			const order = Array.isArray(parsed.order)
				? parsed.order.filter((key): key is string => typeof key === "string" && key.length > 0)
				: [];
			const firstSeen: Record<string, number> = {};
			const rawFirstSeen = parsed.firstSeen;
			if (rawFirstSeen && typeof rawFirstSeen === "object") {
				for (const [key, value] of Object.entries(rawFirstSeen)) {
					if (typeof value === "number" && Number.isFinite(value) && value > 0) firstSeen[key] = value;
				}
			}
			return { order, firstSeen };
		}
	} catch {}
	return { order: [], firstSeen: {} };
}

function writeOrderState(next: PersistedOrder): void {
	try {
		localStorage.setItem(ORDER_KEY, JSON.stringify(next));
	} catch {}
}

/**
 * true = 项目顺序全靠手动（拖拽 + 添加顺序，新项目置顶）。
 * false = 按最近真实对话时间自动排序（默认）。
 */
export function useProjectOrderManual(): boolean {
	return useSyncExternalStore(subscribe, loadProjectOrderManual);
}

export function loadProjectOrderManual(): boolean {
	try {
		return localStorage.getItem(MANUAL_KEY) === "1";
	} catch {
		return false;
	}
}

export function saveProjectOrderManual(on: boolean): void {
	try {
		localStorage.setItem(MANUAL_KEY, on ? "1" : "0");
	} catch {}
	emit();
}

export function loadProjectOrder(): string[] {
	return readOrderState().order;
}

/** 只在顺序真的变化时写盘（自动模式每次重排都会调用）。 */
export function saveProjectOrder(order: readonly string[]): void {
	const current = readOrderState();
	if (current.order.length === order.length && current.order.every((key, i) => key === order[i])) return;
	writeOrderState({ ...current, firstSeen: current.firstSeen, order: [...order] });
}

/** 为首次见到的项目盖上时间戳；返回「路径 → 首次出现时间」。 */
export function projectFirstSeen(paths: readonly string[]): Map<string, number> {
	const current = readOrderState();
	const map = new Map(Object.entries(current.firstSeen));
	const now = Date.now();
	let added = false;
	for (const path of paths) {
		if (map.has(path)) continue;
		map.set(path, now);
		added = true;
	}
	if (!added) return map;
	const kept = [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, FIRST_SEEN_MAX);
	writeOrderState({ ...current, firstSeen: Object.fromEntries(kept) });
	return new Map(kept);
}
