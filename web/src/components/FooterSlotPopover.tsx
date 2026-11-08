import { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useFloatingPanel } from "../use-floating-panel";
import type { FooterStatusContent } from "../footer-status";

export interface FooterSlotPopoverProps {
	/** 底栏那段文字（锚点） */
	anchor: HTMLElement | null;
	/** 插件内容：宿主给容器，插件只往里画 */
	content: FooterStatusContent;
	onClose: () => void;
}

/**
 * 底栏内置状态槽的跟随浮层**外壳**（宿主所有）。
 *
 * 为什么要宿主来做：层级 / 定位 / 翻转 / 跟随 / 关闭语义属于外壳，属于「谁认识这个锚点」——
 * 锚点是宿主内置的费用格（`BarItem.tsx` 的 `host:cost`）。插件自画浮层会让每个插件各写一套
 * `position: fixed` + z-index + 点外关闭，样式与层级互相踩，且插件能覆蓋任意界面。
 * 所以这里只暴露一个朴素契约：插件拿到 `container` 画内容，其余全归宿主（`use-floating-panel`）。
 *
 * 位置：底栏贴底，所以默认挂在锚点**上方**、右对齐，上方塞不下才翻到下方（`computeFloatingPosition` 负责
 * 钳制与翻转，`floating-panel.test.ts` 覆盖）。
 */
export function FooterSlotPopover({ anchor, content, onClose }: FooterSlotPopoverProps) {
	const bodyRef = useRef<HTMLDivElement>(null);
	const { panelRef, style, measure } = useFloatingPanel({
		anchor,
		side: "top",
		align: "right",
		gap: 6,
		onClose,
	});

	// 挂插件内容：先画、再量（内容宽度由插件自己决定，量完才定位）
	useLayoutEffect(() => {
		const host = bodyRef.current;
		if (!host) return;
		const cleanup = content.render(host);
		measure();
		return () => {
			if (typeof cleanup === "function") cleanup();
			host.innerHTML = "";
		};
		// content 换了实现（插件重载）就重挂；measure 每次渲染都是新函数，不进依赖
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [content]);

	// 插件内容常是异步来的（先骨架后数据），尺寸变了要重新定位
	useEffect(() => {
		const panel = panelRef.current;
		if (!panel || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() => measure());
		observer.observe(panel);
		return () => observer.disconnect();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// 键盘可达：打开时把焦点收进卡片（Tab 能到插件自己的 ⟳），关闭时还给锚点
	useEffect(() => {
		const panel = panelRef.current;
		const label = panel?.querySelector<HTMLElement>("button");
		(label ?? panel)?.focus({ preventScroll: true });
		return () => {
			if (anchor?.isConnected) anchor.focus({ preventScroll: true });
		};
	}, [anchor, panelRef]);

	return createPortal(
		<div
			ref={panelRef}
			className="footer-slot-popover"
			style={style}
			role="dialog"
			aria-modal="false"
			tabIndex={-1}
			data-pi-popover="footer-slot"
		>
			<div ref={bodyRef} className="footer-slot-popover-body" />
		</div>,
		document.body,
	);
}
