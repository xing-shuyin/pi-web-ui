import { memo, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";

interface LazyMountProps {
	/** 消息 id——占位符带 data-msg-id，问题导航 / 搜索跳转的查询不受影响。 */
	id: string;
	/** false = 渲染固定高度占位符；true = 渲染真实内容。 */
	show: boolean;
	/** 占位高度（上次实测值或角色估算值）。 */
	height: number;
	/** 滚动容器（.messages），用于显示瞬间的 scrollTop 补偿。 */
	containerRef: RefObject<HTMLDivElement | null>;
	/** 真实内容挂载后回报实测高度（父级写入 heights 缓存）。 */
	onMeasured?: (id: string, height: number) => void;
	/** 外层包裹元素 ref 注册（父级 sweep 需要测量所有受管元素）。 */
	lazyRef?: (el: HTMLDivElement | null) => void;
	children: ReactNode;
}

/**
 * 惰性挂载包装：隐藏时渲染一个保留 data-msg-id 的等高占位 div；显示瞬间在
 * layout effect（提交后、绘制前）里实测真实高度，若元素完全位于视口上方，
 * 按「真实 − 占位」差值补偿 scrollTop，抵消向上滚动时的视觉跳动。
 */
export const LazyMount = memo(function LazyMount({
	id,
	show,
	height,
	containerRef,
	onMeasured,
	lazyRef,
	children,
}: LazyMountProps) {
	const innerRef = useRef<HTMLDivElement>(null);
	// 上一帧是否处于显示状态（null = 刚挂载，不做补偿）
	const wasShown = useRef<boolean | null>(null);

	useLayoutEffect(() => {
		const was = wasShown.current;
		wasShown.current = show;
		if (!show || was !== false) return;
		const inner = innerRef.current;
		const root = containerRef.current;
		if (!inner || !root) return;
		const h = inner.offsetHeight;
		onMeasured?.(id, h);
		const delta = h - height;
		if (delta !== 0) {
			const wrap = inner.parentElement;
			if (wrap && wrap.getBoundingClientRect().bottom <= root.getBoundingClientRect().top) {
				// 内容整体在视口上方：占位换真身导致下方内容位移，回滚之。
				root.scrollTop += delta;
			}
		}
		// 仅在显隐切换时测量；height/onMeasured 的变化不重跑
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [show]);

	if (!show) {
		return (
			<div
				ref={lazyRef}
				className="msg-lazy-ph"
				data-msg-id={id}
				data-lazy-id={id}
				style={{ height }}
				aria-hidden="true"
			/>
		);
	}
	return (
		<div ref={lazyRef} data-lazy-id={id}>
			<div ref={innerRef}>{children}</div>
		</div>
	);
});
