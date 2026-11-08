import { useSyncExternalStore } from "react";

/**
 * 底栏「内置状态槽」：插件把自己的一小段状态文本放进宿主内置条目（`host:quota` 这类），
 * 由宿主决定位置与样式 —— 与插件自己声明的 `ui.bottombar` 条目不同，它排在宿主的内置流里
 * （例如紧跟「当前对话费用」后面，用斜杠接续），不占一个独立 chip、也不带插件图标。
 *
 * 数据只存在浏览器内存里：谁注册谁负责刷新，插件卸载/停用即自动消失。
 */
/**
 * 槽位的跟随浮层内容。**只填内容，不做外壳**：锚点、上下翻转、滚动跟随、
 * 点外部 / Esc 关闭、层级与主题全部归宿主（`components/FooterSlotPopover.tsx`）。
 */
export interface FooterStatusContent {
	/** 渲染进宿主给的容器；返回清理函数（关闭 / 卸载时调用）。 */
	render(container: HTMLElement): void | (() => void);
}

export interface FooterStatus {
	/** 显示在斜杠后面的文本（如 `DS ¥15.82 · AG 100%`）。 */
	text: string;
	/** 悬停提示（多行）。 */
	tip?: string;
	/** 点击时把动作派发给哪个插件（无 `content` 时用）。 */
	pluginId?: string;
	/** 点击派发的动作名（无 `content` 时由插件用 `onUiAction` 接管）。 */
	action?: string;
	/** 有它 → 点这段文字时**宿主**弹跟随浮层，插件只往容器里画内容。 */
	content?: FooterStatusContent;
}

const statuses = new Map<string, FooterStatus>();
const listeners = new Set<() => void>();
let snapshot: ReadonlyMap<string, FooterStatus> = new Map();

function rebuild(): void {
	snapshot = new Map(statuses);
	for (const listener of listeners) {
		try {
			listener();
		} catch {}
	}
}

/**
 * 写入/更新一个状态槽；传 `null` 清除。
 * @returns 是否真的改变了（避免无谓重渲染）
 */
export function setFooterStatus(key: string, value: FooterStatus | null): boolean {
	const id = String(key ?? "").trim();
	if (!id) return false;
	const prev = statuses.get(id);
	if (value === null) {
		if (!prev) return false;
		statuses.delete(id);
		rebuild();
		return true;
	}
	const text = String(value.text ?? "").trim();
	if (!text) {
		if (!prev) return false;
		statuses.delete(id);
		rebuild();
		return true;
	}
	const next: FooterStatus = {
		text,
		...(value.tip ? { tip: value.tip } : {}),
		...(value.pluginId ? { pluginId: value.pluginId } : {}),
		...(value.action ? { action: value.action } : {}),
		// 只收真能渲染的内容：半成品（缺 render）当「没有浮层」，点击回落到 action
		...(typeof value.content?.render === "function" ? { content: value.content } : {}),
	};
	if (
		prev &&
		prev.text === next.text &&
		prev.tip === next.tip &&
		prev.action === next.action &&
		// 同一个 render 引用才算没变：插件换了实现就重挂
		prev.content?.render === next.content?.render
	)
		return false;
	statuses.set(id, next);
	rebuild();
	return true;
}

/** 清除某个状态槽（插件卸载时调用）。 */
export function clearFooterStatus(key: string): void {
	setFooterStatus(key, null);
}

/** 批量清除某插件写入的所有槽（插件停用 / 重载时兜底）。 */
export function clearFooterStatusesOf(pluginId: string): void {
	let changed = false;
	for (const [key, value] of statuses) {
		if (value.pluginId !== pluginId) continue;
		statuses.delete(key);
		changed = true;
	}
	if (changed) rebuild();
}

/** 按 key 取一段状态（内置条目的渲染用）。 */
export function getFooterStatus(key?: string): FooterStatus | null {
	if (key) return snapshot.get(key) ?? null;
	for (const value of snapshot.values()) return value;
	return null;
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** React 订阅：任意状态变化都会重渲染调用方。 */
export function useFooterStatuses(): ReadonlyMap<string, FooterStatus> {
	return useSyncExternalStore(
		subscribe,
		() => snapshot,
		() => snapshot,
	);
}

/** React 订阅单个 key。 */
export function useFooterStatus(key?: string): FooterStatus | null {
	const all = useFooterStatuses();
	if (key) return all.get(key) ?? null;
	for (const value of all.values()) return value;
	return null;
}

/** 测试用：清空所有槽。 */
export function resetFooterStatuses(): void {
	statuses.clear();
	rebuild();
}
