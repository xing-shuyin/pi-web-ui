import { useEffect, useState } from "react";

/** 与 styles.css 里设置弹窗的移动端断点保持一致。 */
export const NARROW_LAYOUT_QUERY = "(max-width: 640px)";

function matches(): boolean {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
	return window.matchMedia(NARROW_LAYOUT_QUERY).matches;
}

/**
 * 设置弹窗的「窄屏布局」开关。
 * 桌面用左右分栏（rail + body），窄屏改为「首页列表 → 推入二级页」。
 */
export function useNarrowLayout(): boolean {
	const [narrow, setNarrow] = useState(matches);
	useEffect(() => {
		if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
		const mq = window.matchMedia(NARROW_LAYOUT_QUERY);
		const onChange = () => setNarrow(mq.matches);
		onChange();
		mq.addEventListener("change", onChange);
		return () => mq.removeEventListener("change", onChange);
	}, []);
	return narrow;
}
