/// <reference lib="dom" />
/**
 * ```mermaid 图表渲染开关（纯前端 localStorage，不经过 server）。
 *
 * - 默认开启：mermaid 本身是懒加载——只有遇到 mermaid 围栏时才下载引擎 chunk，
 *   所以日常聊天没有额外开销；关闭后则完全不触达图表引擎。
 * - 关闭时：mermaid 围栏始终按普通代码块显示。
 * - 变更广播：保存后通知所有已挂载的 Markdown 组件即时切换，无需刷新页面。
 * - normalize/load 为纯函数，可单测（tests/unit/mermaid-settings.test.ts）。
 */

import { useSyncExternalStore } from "react";

export const MERMAID_SETTINGS_KEY = "pi-web-ui:mermaid-render";

export interface MermaidSettings {
	/** 是否将 ```mermaid 围栏渲染为图表（false = 始终按代码块显示） */
	enabled: boolean;
}

export const DEFAULT_MERMAID_SETTINGS: MermaidSettings = { enabled: true };

/** 规整设置值：非对象 / 字段类型错误一律回退默认值。 */
export function normalizeMermaidSettings(raw: unknown): MermaidSettings {
	if (!raw || typeof raw !== "object") return { ...DEFAULT_MERMAID_SETTINGS };
	const o = raw as Record<string, unknown>;
	return {
		enabled: typeof o.enabled === "boolean" ? o.enabled : DEFAULT_MERMAID_SETTINGS.enabled,
	};
}

/** 读取持久化的开关（localStorage 不可用 / 数据损坏时回退默认开启）。 */
export function loadMermaidSettings(): MermaidSettings {
	try {
		const raw = localStorage.getItem(MERMAID_SETTINGS_KEY);
		if (!raw) return { ...DEFAULT_MERMAID_SETTINGS };
		return normalizeMermaidSettings(JSON.parse(raw));
	} catch {
		return { ...DEFAULT_MERMAID_SETTINGS };
	}
}

/** 保存并广播变更（localStorage 不可写时静默忽略）。 */
export function saveMermaidSettings(s: MermaidSettings): void {
	const norm = normalizeMermaidSettings(s);
	try {
		localStorage.setItem(MERMAID_SETTINGS_KEY, JSON.stringify(norm));
	} catch {
		/* ignore */
	}
	cached = norm;
	for (const l of listeners) l();
}

// ---- 订阅：单例 listener 集合（任意数目的 Markdown 组件共享一份，避免
//      每个 <pre> 都挂一个 window listener）。--------------------------------

let cached: MermaidSettings | null = null;
const listeners = new Set<() => void>();

function subscribe(onStoreChange: () => void): () => void {
	listeners.add(onStoreChange);
	return () => {
		listeners.delete(onStoreChange);
	};
}

function getSnapshot(): boolean {
	if (!cached) cached = loadMermaidSettings();
	return cached.enabled;
}

/** 当前是否启用 mermaid 渲染（设置面板切换后所有已渲染消息即时生效）。 */
export function useMermaidEnabled(): boolean {
	return useSyncExternalStore(subscribe, getSnapshot);
}
