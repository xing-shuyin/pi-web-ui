import { useEffect, useRef, useState, type MouseEvent } from "react";
import { FiExternalLink, FiMaximize2, FiPlus, FiSidebar, FiUser } from "react-icons/fi";
import { LuCompass } from "react-icons/lu";
import { isZhLocale, useI18n, useT } from "../i18n";
import {
	PAGE_PICKER_ZIP_URL,
	openExtensionOptions,
	pageCitation,
	useBrowserControl,
	type BrowserControlPage,
	type BrowserControlStatus,
} from "../browser-control";
import { composeToComposer } from "../composer-bridge";
import type { DesktopBrowserBridge, DesktopShellWindow } from "../desktop";

interface DesktopBrowserTab {
	id: string;
	url: string;
	title: string;
}

interface DesktopBrowserState {
	mode?: "browser" | "agent" | "split";
	splitRatio?: number;
	tabs?: DesktopBrowserTab[];
	activeTabId?: string | null;
}

export function BrowserControl() {
	const t = useT();
	const { locale } = useI18n();
	const isZh = isZhLocale(locale);
	const { status, refresh } = useBrowserControl();
	const [open, setOpen] = useState(false);
	const [flash, setFlash] = useState<string | null>(null);
	const flashTimer = useRef<number | null>(null);

	const [desktopState, setDesktopState] = useState<DesktopBrowserState | null>(null);
	const desktop =
		typeof window !== "undefined"
			? ((window as unknown as DesktopShellWindow).piDesktop?.browser as DesktopBrowserBridge | undefined)
			: undefined;

	useEffect(() => {
		if (!desktop) return;
		void desktop.getState().then((s) => {
			if (s && typeof s === "object") setDesktopState(s as DesktopBrowserState);
		});
		const unsub = desktop.onState((s) => {
			if (s && typeof s === "object") setDesktopState(s as DesktopBrowserState);
		});
		return () => {
			unsub?.();
		};
	}, [desktop]);

	const say = (text: string): void => {
		setFlash(text);
		if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
		flashTimer.current = window.setTimeout(() => setFlash(null), 2600);
	};

	const cite = (page: BrowserControlPage): void => {
		const ok = composeToComposer({ attachments: [pageCitation(page)] });
		say(ok ? t("browserControlCited") : t("browserControlCiteFailed"));
	};

	const openPanel = (): void => {
		setOpen(true);
		refresh();
		if (desktop) {
			void desktop.getState().then((s) => {
				if (s && typeof s === "object") setDesktopState(s as DesktopBrowserState);
			});
		}
	};

	if (desktop) {
		const isSplit = desktopState?.mode === "split";
		const isBrowser = desktopState?.mode === "browser";
		const toggleMode = () => {
			const nextMode = isSplit || isBrowser ? "agent" : "split";
			void desktop.setMode(nextMode);
		};
		const tip = isSplit
			? isZh
				? "收起浏览器分栏 (Ctrl+Shift+2) · 右键打开选项"
				: "Collapse browser split (Ctrl+Shift+2) · Right-click for options"
			: isZh
				? "打开浏览器分栏 (Ctrl+Shift+3) · 右键打开选项"
				: "Open browser split (Ctrl+Shift+3) · Right-click for options";

		const handleContextMenu = (e: MouseEvent) => {
			e.preventDefault();
			e.stopPropagation();
			openPanel();
		};

		return (
			<span className="bc-anchor">
				<button
					type="button"
					className={`chip browser-control${isSplit ? " active" : ""}`}
					data-tip={tip}
					title={tip}
					onClick={toggleMode}
					onContextMenu={handleContextMenu}
				>
					<LuCompass size={14} aria-hidden />
					<span>{t("browserControl")}</span>
				</button>
				{flash && <span className="bc-flash">{flash}</span>}
				{open && (
					<BrowserControlPanel
						status={status}
						desktop={desktop}
						desktopState={desktopState}
						onRefresh={refresh}
						onCite={cite}
						onClose={() => setOpen(false)}
					/>
				)}
			</span>
		);
	}

	const pages = status?.pages ?? [];
	const attention = status?.available === true && (pages.length === 0 || status.aiControl === false);

	return (
		<span className="bc-anchor">
			<button
				type="button"
				className={`chip browser-control${attention ? " attention" : ""}`}
				data-tip={status?.error ?? (attention ? t("browserControlEmpty") : t("browserControlTip"))}
				title={status?.error ?? (attention ? t("browserControlEmpty") : t("browserControlTip"))}
				onClick={openPanel}
			>
				<LuCompass size={14} aria-hidden />
				<span>
					{t("browserControl")}
					{pages.length > 0 ? ` · ${pages.length}` : ""}
				</span>
			</button>
			{flash && <span className="bc-flash">{flash}</span>}
			{open && (
				<BrowserControlPanel
					status={status}
					desktop={desktop}
					desktopState={desktopState}
					onRefresh={refresh}
					onCite={cite}
					onClose={() => setOpen(false)}
				/>
			)}
		</span>
	);
}

function BrowserControlPanel({
	status,
	desktop,
	desktopState,
	onRefresh,
	onCite,
	onClose,
}: {
	status: BrowserControlStatus | null;
	desktop?: DesktopBrowserBridge;
	desktopState?: DesktopBrowserState | null;
	onRefresh: () => void;
	onCite: (page: BrowserControlPage) => void;
	onClose: () => void;
}) {
	const t = useT();
	const { locale } = useI18n();
	const isZh = isZhLocale(locale);
	const [busy, setBusy] = useState(false);
	const pages = status?.pages ?? [];

	const openOptions = async (): Promise<void> => {
		setBusy(true);
		try {
			const ok = await openExtensionOptions();
			if (!ok) onRefresh();
		} finally {
			setBusy(false);
		}
	};

	const setMode = async (mode: "browser" | "agent" | "split") => {
		if (!desktop) return;
		await desktop.setMode(mode);
		onClose();
	};

	const createTab = async () => {
		if (!desktop) return;
		await desktop.createTab();
		onClose();
	};

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal browser-control-modal" onClick={(e) => e.stopPropagation()}>
				<button type="button" className="modal-close" aria-label={t("close")} onClick={onClose}>
					✕
				</button>
				<div className="modal-head">
					<LuCompass size={16} aria-hidden />
					<h2>{t("browserControl")}</h2>
				</div>
				<div className="modal-desc">
					{desktop
						? isZh
							? "桌面内置浏览器已就绪，可在右侧并列分栏浏览网页，或切换到独立浏览器。"
							: "Desktop browser ready: view web pages side-by-side in split view or switch to full browser."
						: t(status?.native ? "browserControlNativeLead" : "browserControlTip")}
				</div>

				{desktop && (
					<>
						<div className="bc-section">{isZh ? "视图模式" : "View Mode"}</div>
						<div className="bc-actions" style={{ marginTop: 0, marginBottom: 12 }}>
							<button
								type="button"
								className={desktopState?.mode === "split" ? "primary" : ""}
								onClick={() => void setMode("split")}
							>
								<FiSidebar size={14} style={{ marginRight: 6 }} />
								{isZh ? "并列分栏 (Split)" : "Split View"}
							</button>
							<button
								type="button"
								className={desktopState?.mode === "browser" ? "primary" : ""}
								onClick={() => void setMode("browser")}
							>
								<FiMaximize2 size={14} style={{ marginRight: 6 }} />
								{isZh ? "完整浏览器 (Browser)" : "Full Browser"}
							</button>
							<button
								type="button"
								className={desktopState?.mode === "agent" ? "primary" : ""}
								onClick={() => void setMode("agent")}
							>
								<FiUser size={14} style={{ marginRight: 6 }} />
								{isZh ? "仅 Agent 模式" : "Agent Only"}
							</button>
						</div>
						<div className="bc-actions" style={{ marginTop: 0, marginBottom: 12 }}>
							<button type="button" onClick={() => void createTab()}>
								<FiPlus size={14} style={{ marginRight: 6 }} />
								{isZh ? "新建网页标签" : "New Browser Tab"}
							</button>
						</div>
					</>
				)}

				{desktop && desktopState?.tabs && desktopState.tabs.length > 0 && (
					<>
						<div className="bc-section">{isZh ? "已打开的网页标签" : "Open Browser Tabs"}</div>
						<ul className="bc-pages">
							{desktopState.tabs.map((tab) => (
								<li key={tab.id}>
									<span className="bc-title" title={tab.title || tab.url}>
										{tab.title || (isZh ? "新标签页" : "New Tab")}
									</span>
									<span className="bc-origin" title={tab.url}>
										{tab.url}
									</span>
									{tab.id === desktopState.activeTabId && <span className="bc-open current">{t("current")}</span>}
									<button
										type="button"
										className="bc-cite"
										onClick={() => {
											void setMode("split");
										}}
									>
										{isZh ? "跳转" : "Open"}
									</button>
								</li>
							))}
						</ul>
					</>
				)}

				{!desktop && status === null && <div className="bc-note">{t("browserControlChecking")}</div>}
				{!desktop && status?.available === false && !status.desktop && (
					<div className="bc-note warn">{t("browserControlOffline")}</div>
				)}
				{!desktop && status?.desktop === true && (
					<>
						<div className="bc-note warn">{t("browserControlDesktop")}</div>
						<div className="bc-note">{t("browserControlDesktopLead")}</div>
						<div className="bc-actions" style={{ marginTop: 0 }}>
							<a className="btn primary" href={window.location.href} target="_blank" rel="noreferrer noopener">
								{t("browserControlOpenInBrowser")}
							</a>
						</div>
					</>
				)}
				{!desktop && status?.available === false && !status.desktop && (
					<>
						<div className="bc-section">{t("browserControlInstall")}</div>
						<div className="bc-note">{t("browserControlInstallLead")}</div>
						<div className="bc-actions" style={{ marginTop: 0 }}>
							<a className="btn primary" href={PAGE_PICKER_ZIP_URL} target="_blank" rel="noreferrer noopener">
								{t("browserControlInstallDownload")}
							</a>
						</div>
						<ol className="bc-steps">
							<li>{t("browserControlInstallStep1")}</li>
							<li>{t("browserControlInstallStep2")}</li>
							<li>{t("browserControlInstallStep3")}</li>
							<li>{t("browserControlInstallStep4")}</li>
						</ol>
					</>
				)}
				{status?.available === true && status.aiControl === false && (
					<div className="bc-note warn">
						{t(status.native ? "browserControlNativeDisabled" : "browserControlDisabled")}
					</div>
				)}
				{status?.available === true && pages.length === 0 && !desktop && (
					<div className="bc-note warn">{t(status.native ? "browserControlNativeEmpty" : "browserControlEmpty")}</div>
				)}

				{pages.length > 0 && (
					<>
						<div className="bc-section">{t("browserControlPages")}</div>
						<ul className="bc-pages">
							{pages.map((page) => (
								<li key={page.tabId ?? page.origin}>
									<span className="bc-title" title={page.title}>
										{page.title}
									</span>
									<span className="bc-origin" title={page.origin}>
										{page.origin}
									</span>
									<span className={`bc-open${page.open ? " on" : ""}`}>
										{page.open ? t("browserControlPageOpen") : t("browserControlPageClosed")}
									</span>
									{page.active === true && <span className="bc-open current">{t("current")}</span>}
									<button
										type="button"
										className="bc-cite"
										title={t("browserControlCiteTip", { name: page.title || page.origin })}
										onClick={() => onCite(page)}
									>
										{t("browserControlCite")}
									</button>
								</li>
							))}
						</ul>
						<div className="bc-note">{t("browserControlCiteNote")}</div>
					</>
				)}

				<div className="bc-actions">
					{!desktop && status?.desktop !== true && (
						<button type="button" className="primary" disabled={busy} onClick={() => void openOptions()}>
							{t(status?.native ? "settings" : "browserControlOpenOptions")}
						</button>
					)}
					<button type="button" onClick={onRefresh}>
						{t("browserControlRefresh")}
					</button>
				</div>
			</div>
		</div>
	);
}
