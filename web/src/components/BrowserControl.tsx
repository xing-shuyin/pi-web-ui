import { useRef, useState } from "react";
import { FiMonitor } from "react-icons/fi";
import { useT } from "../i18n";
import {
	PAGE_PICKER_ZIP_URL,
	compactPage,
	openExtensionOptions,
	pageCitation,
	useBrowserControl,
	type BrowserControlPage,
	type BrowserControlStatus,
} from "../browser-control";
import { composeToComposer } from "../composer-bridge";

export function BrowserControl() {
	const t = useT();
	const { status, refresh } = useBrowserControl();
	const [open, setOpen] = useState(false);
	const [flash, setFlash] = useState<string | null>(null);
	const flashTimer = useRef<number | null>(null);

	const pages = status?.pages ?? [];
	const attention = status?.available === true && (pages.length === 0 || status.aiControl === false);
	const single = compactPage(pages);

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
	};

	return (
		<span className="bc-anchor">
			{single ? (
				<span className="browser-control-split">
					<button
						type="button"
						className={`chip browser-control single${attention ? " attention" : ""}`}
						data-tip={t("browserControlSingleTip", { name: single.title || single.origin })}
						title={t("browserControlSingleTip", { name: single.title || single.origin })}
						onClick={() => cite(single)}
					>
						<FiMonitor size={14} aria-hidden />
						<span className="bc-chip-label">{single.title || single.origin}</span>
					</button>
					<button
						type="button"
						className="chip browser-control caret"
						data-tip={t("browserControlOpenPanel")}
						title={t("browserControlOpenPanel")}
						aria-label={t("browserControlOpenPanel")}
						onClick={openPanel}
					>
						▾
					</button>
				</span>
			) : (
				<button
					type="button"
					className={`chip browser-control${attention ? " attention" : ""}`}
					data-tip={status?.error ?? (attention ? t("browserControlEmpty") : t("browserControlTip"))}
					title={status?.error ?? (attention ? t("browserControlEmpty") : t("browserControlTip"))}
					onClick={openPanel}
				>
					<FiMonitor size={14} aria-hidden />
					<span>
						{t("browserControl")}
						{pages.length > 0 ? ` · ${pages.length}` : ""}
					</span>
				</button>
			)}
			{flash && <span className="bc-flash">{flash}</span>}
			{open && <BrowserControlPanel status={status} onRefresh={refresh} onCite={cite} onClose={() => setOpen(false)} />}
		</span>
	);
}

function BrowserControlPanel({
	status,
	onRefresh,
	onCite,
	onClose,
}: {
	status: BrowserControlStatus | null;
	onRefresh: () => void;
	onCite: (page: BrowserControlPage) => void;
	onClose: () => void;
}) {
	const t = useT();
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

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal browser-control-modal" onClick={(e) => e.stopPropagation()}>
				<button type="button" className="modal-close" aria-label={t("close")} onClick={onClose}>
					✕
				</button>
				<div className="modal-head">
					<FiMonitor size={16} aria-hidden />
					<h2>{t("browserControl")}</h2>
				</div>
				<div className="modal-desc">{t(status?.native ? "browserControlNativeLead" : "browserControlTip")}</div>

				{status === null && <div className="bc-note">{t("browserControlChecking")}</div>}
				{status?.available === false && !status.desktop && (
					<div className="bc-note warn">{t("browserControlOffline")}</div>
				)}
				{status?.desktop === true && (
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
				{status?.available === false && !status.desktop && (
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
				{status?.available === true && pages.length === 0 && (
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

				{status?.desktop !== true && (
					<>
						<div className="bc-section">{t("browserControlExamples")}</div>
						<ul className="bc-examples">
							<li>{t("browserControlExample1")}</li>
							<li>{t("browserControlExample2")}</li>
						</ul>
					</>
				)}

				<div className="bc-actions">
					{status?.desktop !== true && (
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
