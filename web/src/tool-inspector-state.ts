/// <reference lib="dom" />
/**
 * 工具调用与思考流详情检查器（Tool Inspector）的模块级状态 store。
 *
 * 在极简行文（Flow）模式下，工具调用与思考流被收敛为行内微胶囊药丸，
 * 原地展开被样式隐藏，用户点击微胶囊时通过居中检查器弹窗展示完整入参、执行输出与思考链路。
 */
import { useSyncExternalStore } from "react";
import type { ToolArgHints } from "./tool-args";

export interface ToolInspectorItem {
	path: string;
	caption?: string;
}

export interface ToolInspectorPresentData {
	title?: string;
	note?: string;
	items: ToolInspectorItem[];
}

export interface ToolInspectorState {
	isThinking: boolean;
	name?: string;
	title?: string;
	status?: string;
	statusClass?: "ok" | "run" | "err" | "idle";
	duration?: string;
	durationMs?: number;
	exitHint?: string;
	hints?: ToolArgHints;
	args?: string;
	rawOutput?: string;
	output?: string;
	details?: unknown;
	images?: string[];
	isError?: boolean;
	toolCallId?: string;
	resultTimestamp?: number;
	presentData?: ToolInspectorPresentData | null;
	// 思考流专属
	thinking?: string;
	streaming?: boolean;
	/** 终止运行中的 bash 命令 */
	onKillBash?: () => void;
}

let activeState: ToolInspectorState | null = null;
const listeners = new Set<() => void>();

function notify(): void {
	for (const cb of listeners) cb();
}

export function openToolInspector(data: ToolInspectorState): void {
	activeState = data;
	notify();
}

export function closeToolInspector(): void {
	if (activeState === null) return;
	activeState = null;
	notify();
}

/**
 * 实时同步更新当前检查器弹窗数据（仅当当前打开的检查器对应相同 toolCallId 且非思考流时更新）。
 * 用于工具执行过程中的流式增量输出与状态平滑切换，避免弹窗定格在旧快照。
 */
export function updateToolInspectorLive(toolCallId: string, patch: Partial<ToolInspectorState>): void {
	if (!activeState || activeState.isThinking || activeState.toolCallId !== toolCallId) {
		return;
	}
	let changed = false;
	const record = activeState as unknown as Record<string, unknown>;
	for (const [k, v] of Object.entries(patch)) {
		if (record[k] !== v) {
			changed = true;
			break;
		}
	}
	if (changed) {
		activeState = { ...activeState, ...patch };
		notify();
	}
}

export function getToolInspectorState(): ToolInspectorState | null {
	return activeState;
}

export function subscribeToolInspector(cb: () => void): () => void {
	listeners.add(cb);
	return () => {
		listeners.delete(cb);
	};
}

export function useToolInspectorState(): ToolInspectorState | null {
	return useSyncExternalStore(subscribeToolInspector, getToolInspectorState, getToolInspectorState);
}

/**
 * 判断当前是否处于极简行文（Flow）模式或行内微胶囊模式。
 * 在此模式下，工具调用和思考流被压缩为行内紧凑微胶囊，原地展开被 CSS 隐藏，
 * 点击时必须通过居中检查器弹窗（Tool Inspector）展示完整入参、执行输出与思考链路。
 */
export function isFlowMode(el?: HTMLElement | null): boolean {
	if (typeof document === "undefined") return false;
	const docTheme = document.documentElement.dataset.theme || "";
	if (docTheme === "flow" || docTheme === "flow-light" || docTheme === "wallpaper-flow" || docTheme.includes("flow")) {
		return true;
	}
	const link = document.getElementById("theme-stylesheet") as HTMLLinkElement | null;
	const href = link?.getAttribute("href") || "";
	if (href.includes("flow")) {
		return true;
	}
	if (el) {
		const trail = el.closest(".turn-tools-trail");
		if (trail) {
			const cs = window.getComputedStyle(trail);
			if (cs.flexDirection === "row" || cs.flexWrap === "wrap") {
				return true;
			}
		}
		const selfCs = window.getComputedStyle(el);
		if (selfCs.display === "inline-flex" && parseInt(selfCs.height, 10) <= 30) {
			return true;
		}
	}
	return false;
}

// 标记宿主已激活原生工具检查器，避免外部插件重复监听拦截
if (typeof window !== "undefined") {
	(window as unknown as { __piToolInspectorActive?: boolean }).__piToolInspectorActive = true;
}
