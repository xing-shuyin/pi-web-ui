import { useEffect, useState } from "react";
import { getDesktopPlatform, getDesktopWindowBridge, isDesktopShell } from "../desktop";
import { useT } from "../i18n";

export function WindowControls() {
	const t = useT();
	const [isMaximized, setIsMaximized] = useState(false);
	const [mounted, setMounted] = useState(() => typeof window !== "undefined");
	const [browserMode, setBrowserMode] = useState<string | null>(null);

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

	useEffect(() => {
		const b = (
			window as unknown as {
				piDesktop?: {
					browser?: {
						getState?: () => Promise<unknown>;
						onState?: (cb: (s: unknown) => void) => () => void;
					};
				};
			}
		).piDesktop?.browser;
		if (!b) return;
		void b.getState?.().then((s) => {
			if (s && typeof s === "object" && "mode" in s && typeof s.mode === "string") {
				setBrowserMode(s.mode);
			}
		});
		const unsub = b.onState?.((s) => {
			if (s && typeof s === "object" && "mode" in s && typeof s.mode === "string") {
				setBrowserMode(s.mode);
			}
		});
		return () => unsub?.();
	}, []);

	if (!mounted || !isDesktopShell() || browserMode === "split") return null;
	const platform = getDesktopPlatform();
	if (platform === "darwin") return null;

	const bridge = getDesktopWindowBridge();
	if (!bridge) return null;

	return (
		<div className="window-controls" aria-label={t("windowControls")}>
			<button
				type="button"
				className="win-ctrl-btn"
				onClick={() => void bridge.minimize()}
				title={t("windowMinimize")}
				aria-label={t("windowMinimize")}
			>
				<svg width="11" height="11" viewBox="0 0 11 11" fill="none">
					<path d="M1.5 5.5H9.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
				</svg>
			</button>
			<button
				type="button"
				className="win-ctrl-btn"
				onClick={() => void bridge.toggleMaximize()}
				title={isMaximized ? t("windowRestore") : t("windowMaximize")}
				aria-label={isMaximized ? t("windowRestore") : t("windowMaximize")}
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
				title={t("close")}
				aria-label={t("close")}
			>
				<svg width="11" height="11" viewBox="0 0 11 11" fill="none">
					<path d="M2 2L9 9M9 2L2 9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
				</svg>
			</button>
		</div>
	);
}
