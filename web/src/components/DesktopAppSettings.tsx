import { useEffect, useState } from "react";
import { FiMonitor } from "react-icons/fi";
import { getDesktopWindowBridge, isDesktopShell, type DesktopBrowserBridge } from "../desktop";
import type { MessageKey } from "../i18n/catalog";
import { useT } from "../i18n";

type StartupMode = "agent" | "browser" | "split";

const STARTUP_MODES: StartupMode[] = ["agent", "browser", "split"];
const STARTUP_MODE_LABEL: Record<StartupMode, MessageKey> = {
	agent: "settingsStartupModeAgent",
	browser: "settingsStartupModeBrowser",
	split: "settingsStartupModeSplit",
};

function desktopBrowserBridge(): DesktopBrowserBridge | null {
	if (!isDesktopShell()) return null;
	// embedded（浏览器内嵌）视图没有桌面宿主桥，不能改启动模式
	if (getDesktopWindowBridge() === null) return null;
	const bridge = (window as unknown as { piDesktop?: { browser?: DesktopBrowserBridge } }).piDesktop?.browser;
	return bridge?.getStartupMode && bridge?.setStartupMode ? (bridge as DesktopBrowserBridge) : null;
}

/** 应用设置 → 桌面应用：启动模式（与浏览器面板的设置同源，写入 BrowserSettings.defaultMode） */
export function DesktopAppSettings() {
	const t = useT();
	const [bridge] = useState(desktopBrowserBridge);
	const [mode, setMode] = useState<StartupMode | null>(null);
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		if (!bridge?.getStartupMode) return;
		let stopped = false;
		void bridge
			.getStartupMode()
			.then((value) => {
				if (stopped) return;
				setMode(value === "browser" || value === "split" ? value : "agent");
			})
			.catch(() => {
				if (!stopped) setFailed(true);
			});
		return () => {
			stopped = true;
		};
	}, [bridge]);

	if (!bridge) return null;

	const save = (next: StartupMode) => {
		setMode(next);
		setFailed(false);
		void bridge
			.setStartupMode?.(next)
			.then((ok) => {
				if (ok === false) setFailed(true);
			})
			.catch(() => setFailed(true));
	};

	return (
		<div className="set-section">
			<div className="set-section-title">
				<FiMonitor className="set-section-icon" />
				{t("settingsDesktopApp")}
			</div>
			<div className="set-note">{t("settingsStartupModeHint")}</div>
			<div className="set-row set-field-row">
				<label className="set-row-name" htmlFor="set-startup-mode">
					{t("settingsStartupMode")}
				</label>
				<select
					id="set-startup-mode"
					className="set-select"
					value={mode ?? "agent"}
					disabled={mode === null}
					onChange={(e) => save(e.target.value as StartupMode)}
				>
					{STARTUP_MODES.map((value) => (
						<option key={value} value={value}>
							{t(STARTUP_MODE_LABEL[value])}
						</option>
					))}
				</select>
			</div>
			{failed && <div className="set-note">{t("settingsStartupModeFailed")}</div>}
		</div>
	);
}
