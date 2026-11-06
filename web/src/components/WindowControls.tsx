import { useEffect, useState } from "react";
import { getDesktopPlatform, getDesktopWindowBridge, isDesktopShell } from "../desktop";
import { isZhLocale, useI18n } from "../i18n";

export function WindowControls() {
	const { locale } = useI18n();
	const [isMaximized, setIsMaximized] = useState(false);
	const [mounted, setMounted] = useState(() => typeof window !== "undefined");

	useEffect(() => {
		setMounted(true);
		const bridge = getDesktopWindowBridge();
		if (!bridge) return;

		void bridge.isMaximized().then(setIsMaximized);

		const cleanup = bridge.onMaximizedChange((max) => {
			setIsMaximized(max);
		});
		return () => cleanup();
	}, []);

	if (!mounted || !isDesktopShell()) return null;
	const platform = getDesktopPlatform();
	if (platform === "darwin") return null;

	const bridge = getDesktopWindowBridge();
	if (!bridge) return null;

	const isZh = isZhLocale(locale);

	return (
		<div className="window-controls" aria-label="Window controls">
			<button
				type="button"
				className="win-ctrl-btn"
				onClick={() => void bridge.minimize()}
				title={isZh ? "最小化" : "Minimize"}
				aria-label={isZh ? "最小化" : "Minimize"}
			>
				<svg width="11" height="11" viewBox="0 0 11 11" fill="none">
					<path d="M1.5 5.5H9.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
				</svg>
			</button>
			<button
				type="button"
				className="win-ctrl-btn"
				onClick={() => void bridge.toggleMaximize()}
				title={isMaximized ? (isZh ? "向下还原" : "Restore") : isZh ? "最大化" : "Maximize"}
				aria-label={isMaximized ? (isZh ? "向下还原" : "Restore") : isZh ? "最大化" : "Maximize"}
			>
				{isMaximized ? (
					<svg width="11" height="11" viewBox="0 0 11 11" fill="none">
						<path
							d="M3 3V1.5C3 1.22 3.22 1 3.5 1H9.5C9.78 1 10 1.22 10 1.5V7.5C10 7.78 9.78 8 9.5 8H8"
							stroke="currentColor"
							strokeWidth="1.1"
						/>
						<rect x="1" y="3" width="7" height="7" rx="0.5" stroke="currentColor" strokeWidth="1.1" />
					</svg>
				) : (
					<svg width="11" height="11" viewBox="0 0 11 11" fill="none">
						<rect x="1.5" y="1.5" width="8" height="8" rx="0.5" stroke="currentColor" strokeWidth="1.1" />
					</svg>
				)}
			</button>
			<button
				type="button"
				className="win-ctrl-btn win-ctrl-close"
				onClick={() => void bridge.close()}
				title={isZh ? "关闭" : "Close"}
				aria-label={isZh ? "关闭" : "Close"}
			>
				<svg width="11" height="11" viewBox="0 0 11 11" fill="none">
					<path d="M2 2L9 9M9 2L2 9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
				</svg>
			</button>
		</div>
	);
}
