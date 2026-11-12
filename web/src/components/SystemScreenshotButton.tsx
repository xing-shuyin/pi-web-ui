import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FiScissors } from "react-icons/fi";
import { appUrl } from "../base-url";
import { isZhLocale, useI18n, useT } from "../i18n";
import { openImageLightbox } from "../image-lightbox-bridge";
import { useFloatingPanel } from "../use-floating-panel";

/**
 * 剪刀按钮：点击直接「保留当前窗口」截图；鼠标悬停在其上方展开「隐藏当前窗口截图」。
 * 悬停面板只为加速入口，触屏与键盘用户仍有可用的默认点击行为。
 */
export function SystemScreenshotButton({
	onNotice,
}: {
	onNotice: (level: "info" | "warning" | "error", text: string) => void;
}) {
	const t = useT();
	const { locale } = useI18n();
	const [available, setAvailable] = useState(false);
	const [busy, setBusy] = useState(false);
	const [hoverOpen, setHoverOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const active = useRef(false);
	const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const { panelRef, style } = useFloatingPanel({
		open: hoverOpen,
		anchor: triggerRef,
		side: "top",
		align: "left",
		onClose: () => setHoverOpen(false),
	});

	useEffect(() => {
		const controller = new AbortController();
		void fetch(appUrl("/api/system-screenshot"), { signal: controller.signal })
			.then(async (response) => {
				if (response.ok) {
					const result = (await response.json()) as { available?: boolean };
					if (!controller.signal.aborted) setAvailable(result.available === true);
				}
			})
			.catch(() => {});
		return () => controller.abort();
	}, []);

	const cancelClose = () => {
		if (closeTimer.current === null) return;
		clearTimeout(closeTimer.current);
		closeTimer.current = null;
	};
	useEffect(() => cancelClose, []);

	const openOnHover = () => {
		if (!available || busy || active.current) return;
		cancelClose();
		setHoverOpen(true);
	};
	// 面板是 portal 出来的，指针跨过间隙时给一点缓冲再收起。
	const closeAfterHover = () => {
		cancelClose();
		closeTimer.current = setTimeout(() => {
			closeTimer.current = null;
			setHoverOpen(false);
		}, 180);
	};

	const capture = async (hideWindow: boolean) => {
		if (!available || active.current) return;
		active.current = true;
		cancelClose();
		setHoverOpen(false);
		setBusy(true);
		const token = Array.from(crypto.getRandomValues(new Uint8Array(16)), (n) => n.toString(16).padStart(2, "0")).join(
			"",
		);
		const title = document.title;
		if (hideWindow) document.title = `${title} [${token}]`;
		try {
			const response = await fetch(appUrl("/api/system-screenshot"), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ token, locale: isZhLocale(locale) ? "zh" : "en", hideWindow }),
			});
			const result = (await response.json()) as { cancelled?: boolean; dataUrl?: string; error?: string };
			if (!response.ok) {
				if (result.error === "window-not-focused") throw new Error(t("screenshotFocus"));
				if (result.error === "busy") throw new Error(t("screenshotBusy"));
				if (result.error === "local-only" || result.error === "unsupported")
					throw new Error(t("screenshotUnavailable"));
				throw new Error(t("screenshotFailed"));
			}
			if (result.cancelled) return;
			if (
				!result.dataUrl?.startsWith("data:image/png;base64,") ||
				!openImageLightbox({ src: result.dataUrl, alt: `${t("screenshotName")}.png` })
			) {
				throw new Error(t("screenshotFailed"));
			}
		} catch (error) {
			onNotice("error", error instanceof Error ? error.message : t("screenshotFailed"));
		} finally {
			if (hideWindow && document.title.endsWith(`[${token}]`)) document.title = title;
			active.current = false;
			setBusy(false);
		}
	};

	return (
		<>
			<button
				ref={triggerRef}
				type="button"
				className="btn attach-img"
				title={!available ? t("screenshotUnavailable") : busy ? t("screenshotBusy") : t("screenshotKeepWindow")}
				aria-label={t("screenshotCapture")}
				aria-busy={busy}
				aria-expanded={hoverOpen}
				disabled={!available || busy}
				onClick={() => void capture(false)}
				onMouseEnter={openOnHover}
				onMouseMove={openOnHover}
				onMouseLeave={closeAfterHover}
			>
				<FiScissors />
			</button>
			{hoverOpen &&
				createPortal(
					<div
						ref={panelRef}
						className="ctx-menu"
						style={style}
						role="menu"
						aria-label={t("screenshotCapture")}
						onMouseEnter={cancelClose}
						onMouseLeave={closeAfterHover}
					>
						<button type="button" role="menuitem" className="ctx-item" onClick={() => void capture(true)}>
							{t("screenshotHideWindow")}
						</button>
					</div>,
					document.body,
				)}
		</>
	);
}
