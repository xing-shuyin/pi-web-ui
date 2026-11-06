import { memo, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";

interface LazyMountProps {
	id: string;
	show: boolean;
	height: number;
	containerRef: RefObject<HTMLDivElement | null>;
	onMeasured?: (id: string, height: number) => void;
	lazyRef?: (el: HTMLDivElement | null) => void;
	children: ReactNode;
}

export const LazyMount = memo(function LazyMount({
	id,
	show,
	height,
	containerRef: _containerRef,
	onMeasured,
	lazyRef,
	children,
}: LazyMountProps) {
	const innerRef = useRef<HTMLDivElement>(null);

	useLayoutEffect(() => {
		if (!show) return;
		const inner = innerRef.current;
		if (!inner) return;
		const h = inner.offsetHeight;
		if (h > 0) onMeasured?.(id, h);
	}, [show, id, onMeasured]);

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
