import { useEffect, useRef, useState, type PointerEvent } from "react";
import { isDesktopShell, type DesktopBrowserBridge, type DesktopShellWindow } from "../desktop";

interface DesktopBrowserState {
	mode?: "browser" | "agent" | "split";
	splitRatio?: number;
}

export function DesktopSplitResizer() {
	const [desktopState, setDesktopState] = useState<DesktopBrowserState | null>(null);
	const [dragging, setDragging] = useState(false);
	const [snapMode, setSnapMode] = useState<"agent" | "browser" | null>(null);
	const [currentRatio, setCurrentRatio] = useState<number>(0.5);

	const startXRef = useRef(0);
	const startWidthRef = useRef(0);
	const totalWidthRef = useRef(0);
	const ratioFrameRef = useRef(0);

	const isDesktop = typeof window !== "undefined" && isDesktopShell();
	const desktop =
		typeof window !== "undefined"
			? ((window as unknown as DesktopShellWindow).piDesktop?.browser as DesktopBrowserBridge | undefined)
			: undefined;

	useEffect(() => {
		if (!desktop || !isDesktop) return;
		void desktop.getState().then((s) => {
			if (s && typeof s === "object") setDesktopState(s as DesktopBrowserState);
		});
		const unsub = desktop.onState((s) => {
			if (s && typeof s === "object") setDesktopState(s as DesktopBrowserState);
		});
		return () => {
			unsub?.();
		};
	}, [desktop, isDesktop]);

	if (!isDesktop || !desktop || desktopState?.mode !== "split") {
		return null;
	}

	const handlePointerDown = (e: PointerEvent<HTMLDivElement>) => {
		if (e.button !== 0) return;
		e.preventDefault();
		e.currentTarget.setPointerCapture(e.pointerId);

		const agentWidth = window.innerWidth;
		const splitRatio = Number(desktopState?.splitRatio) || 0.5;
		const totalWidth = agentWidth > 0 && splitRatio > 0 ? Math.round(agentWidth / splitRatio) : window.screen.width;

		startXRef.current = e.clientX;
		startWidthRef.current = agentWidth;
		totalWidthRef.current = totalWidth;

		setDragging(true);
		setSnapMode(null);
		setCurrentRatio(splitRatio);
		document.body.classList.add("desktop-is-resizing");
	};

	const handlePointerMove = (e: PointerEvent<HTMLDivElement>) => {
		if (!dragging) return;
		const deltaX = e.clientX - startXRef.current;
		const newWidth = startWidthRef.current + deltaX;
		const totalWidth = totalWidthRef.current;
		if (totalWidth <= 0) return;

		const rawRatio = newWidth / totalWidth;

		if (rawRatio > 0.92 || newWidth > totalWidth - 60) {
			setSnapMode("agent");
			setCurrentRatio(1);
		} else if (rawRatio < 0.08 || newWidth < 60) {
			setSnapMode("browser");
			setCurrentRatio(0);
		} else {
			setSnapMode(null);
			const clamped = Math.max(0.2, Math.min(0.8, rawRatio));
			setCurrentRatio(clamped);

			cancelAnimationFrame(ratioFrameRef.current);
			ratioFrameRef.current = requestAnimationFrame(() => {
				void desktop.setSplitRatio?.(clamped);
			});
		}
	};

	const handlePointerUp = (e: PointerEvent<HTMLDivElement>) => {
		if (!dragging) return;
		setDragging(false);
		document.body.classList.remove("desktop-is-resizing");
		try {
			e.currentTarget.releasePointerCapture(e.pointerId);
		} catch {}

		const deltaX = e.clientX - startXRef.current;
		const newWidth = startWidthRef.current + deltaX;
		const totalWidth = totalWidthRef.current;
		const rawRatio = totalWidth > 0 ? newWidth / totalWidth : 0.5;

		if (rawRatio > 0.92 || newWidth > totalWidth - 60) {
			// 拖动至最右侧边缘：隐藏浏览器，只留 Agent 模式
			void desktop.setMode("agent");
		} else if (rawRatio < 0.08 || newWidth < 60) {
			// 拖动至最左侧边缘：隐藏 Agent，只留浏览器模式
			void desktop.setMode("browser");
		} else {
			const clamped = Math.max(0.2, Math.min(0.8, rawRatio));
			void desktop.setSplitRatio?.(clamped);
		}
		setSnapMode(null);
	};

	return (
		<div
			className={`desktop-split-resizer ${dragging ? "dragging" : ""} ${snapMode ? `snap-${snapMode}` : ""}`}
			onPointerDown={handlePointerDown}
			onPointerMove={handlePointerMove}
			onPointerUp={handlePointerUp}
			onPointerCancel={handlePointerUp}
			title="按住拖动调整分栏比例，拖至边缘可隐藏"
		>
			<div className="desktop-split-resizer-line" />
			{dragging && (
				<div className="desktop-split-resizer-badge">
					{snapMode === "agent"
						? "释放隐藏浏览器"
						: snapMode === "browser"
							? "释放隐藏智能体"
							: `${Math.round(currentRatio * 100)}% | ${Math.round((1 - currentRatio) * 100)}%`}
				</div>
			)}
		</div>
	);
}
