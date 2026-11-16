import { useEffect, useState } from "react";

/**
 * 触控布局断点——与 `styles.css` 里设备面板（`.dp-*`）的媒体查询必须保持一致：
 * 窄屏或粗指针（手机 / 平板 / 触屏本）走「底部抽屉 + 44px 触控块」，
 * 其余走桌面浮层（行 30px、图标 24px）。
 */
export const COARSE_POINTER_QUERY = "(max-width: 640px), (pointer: coarse)";

function matches(): boolean {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
	return window.matchMedia(COARSE_POINTER_QUERY).matches;
}

/** 是否按触控布局渲染（首次同步求值，避免第一帧用桌面浮层闪一下）。 */
export function useCoarsePointer(): boolean {
	const [coarse, setCoarse] = useState(matches);
	useEffect(() => {
		if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
		const query = window.matchMedia(COARSE_POINTER_QUERY);
		const onChange = () => setCoarse(query.matches);
		onChange();
		query.addEventListener("change", onChange);
		return () => query.removeEventListener("change", onChange);
	}, []);
	return coarse;
}
