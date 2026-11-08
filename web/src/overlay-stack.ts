/// <reference lib="dom" />
import { useEffect, useRef, useState } from "react";

/**
 * 浮层叠栈（overlay stack）—— 解决「后打开的浮层反而被先打开的压住」。
 *
 * 背景：`styles.css` 里每个浮层各自写死 z-index，于是「谁能盖住谁」只能靠人工挑数字。
 * 一旦 A 能盖住 B、B 又能从里面再打开 C（工具详情 → 图片预览、文件预览 → 图片预览），
 * 就得给 C 再挑一个更大的数字，越叠越乱（100000 / 100001 / 100005 就是这么来的）。
 *
 * 规则：**能盖在另一个浮层之上的浮层，z-index 从 `useOverlayZIndex()` 取，不要写死。**
 * 入栈顺序就是打开顺序，先开的在下、后开的在上；某个浮层关掉后，剩下的自动往上收，
 * 不会再出现「关掉中间那层之后，上面那层反而变低」的空洞。
 *
 * 数值区间：静态浮层最高到 10000（提示气泡一类），叠栈从 100000 起；
 * 临时通知/横幅固定在 `--z-notice`（100050），永远压在叠栈之上。
 */

/** 叠栈第一层：必须高于 styles.css 里所有静态浮层。 */
export const OVERLAY_STACK_BASE = 100000;
/** 相邻两层的间距，留出空位方便临时插值。 */
export const OVERLAY_STACK_STEP = 10;
/** 最高可发放的一层：临时通知（100050）必须仍在叠栈之上。 */
export const OVERLAY_STACK_MAX = 100040;

/** 打开顺序表，元素是每个浮层自己的 token（不放组件引用，避免泄漏）。 */
const order: object[] = [];
const listeners = new Set<() => void>();

function notify(): void {
	for (const listener of listeners) listener();
}

/** 第 depth 层（0 = 最底）该拿到的 z-index。 */
export function overlayZIndexAt(depth: number): number {
	const safeDepth = Number.isFinite(depth) ? Math.max(0, Math.floor(depth)) : 0;
	return Math.min(OVERLAY_STACK_MAX, OVERLAY_STACK_BASE + safeDepth * OVERLAY_STACK_STEP);
}

/** token 当前所处层深；未入栈时排在末尾（等于「刚打开」）。 */
function depthOf(token: object): number {
	const index = order.indexOf(token);
	return index < 0 ? order.length : index;
}

/** 入栈，返回出栈函数（幂等）。 */
export function acquireOverlaySlot(token: object): () => void {
	if (!order.includes(token)) {
		order.push(token);
		notify();
	}
	let released = false;
	return () => {
		if (released) return;
		released = true;
		const index = order.indexOf(token);
		if (index < 0) return;
		order.splice(index, 1);
		notify();
	};
}

/** 当前叠栈层数（含正在打开的这一层），用于测试与诊断。 */
export function overlayStackSize(): number {
	return order.length;
}

/** 单测用：清空叠栈。 */
export function resetOverlayStack(): void {
	order.length = 0;
	notify();
}

/**
 * 取一个叠栈层号。`active=false` 时不占层（浮层没显示，不该把别的浮层顶上去）。
 * 返回值直接塞进浮层的 `style.zIndex`（内联样式压过主题里的写死值）。
 */
export function useOverlayZIndex(active = true): number {
	const token = useRef<object>({});
	const [zIndex, setZIndex] = useState(() => overlayZIndexAt(order.length));

	useEffect(() => {
		if (!active) return;
		const self = token.current;
		const sync = () => setZIndex(overlayZIndexAt(depthOf(self)));
		const release = acquireOverlaySlot(self);
		sync();
		listeners.add(sync);
		return () => {
			listeners.delete(sync);
			release();
		};
	}, [active]);

	return zIndex;
}
