import { useEffect, useState } from "react";
import { FiDownload, FiGlobe, FiRefreshCw, FiTrash2, FiX } from "react-icons/fi";
import { unregisterLocale, useI18n, useT, type LocalePackStatus } from "../i18n";
import { appUrl } from "../base-url";
import { withToken } from "../auth-token";

export function LocaleModal({ onClose }: { onClose: () => void }) {
	const t = useT();
	const { locale, setLocale, reloadPacks } = useI18n();
	const [packs, setPacks] = useState<LocalePackStatus[] | null>(null);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState("");

	async function load() {
		try {
			const res = await fetch(withToken(appUrl("/api/locales")));
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = (await res.json()) as { packs: LocalePackStatus[] };
			setPacks(data.packs ?? []);
			setError("");
		} catch (e) {
			setError(t("localeListFailed", { error: e instanceof Error ? e.message : String(e) }));
		}
	}

	useEffect(() => {
		void load();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	async function install(code: string) {
		setBusy(code);
		setError("");
		try {
			const res = await fetch(withToken(appUrl(`/api/locales/${code}/install`)), { method: "POST" });
			if (!res.ok) {
				let msg = `HTTP ${res.status}`;
				try {
					msg = ((await res.json()) as { error?: string }).error ?? msg;
				} catch {}
				throw new Error(msg);
			}
			await reloadPacks();
			await load();
		} catch (e) {
			setError(t("localeInstallFailed", { error: e instanceof Error ? e.message : String(e) }));
		} finally {
			setBusy("");
		}
	}

	async function remove(code: string) {
		setBusy(code);
		setError("");
		try {
			const res = await fetch(withToken(appUrl(`/api/locales/${code}`)), { method: "DELETE" });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			unregisterLocale(code);
			if (locale === code) setLocale("zh");
			await reloadPacks();
			await load();
		} catch (e) {
			setError(t("localeInstallFailed", { error: e instanceof Error ? e.message : String(e) }));
		} finally {
			setBusy("");
		}
	}

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="bg-task-modal" onClick={(e) => e.stopPropagation()}>
				<div className="bg-task-head">
					<span className="bg-task-title">
						<FiGlobe /> {t("localePacks")}
					</span>
					<button type="button" className="btn" title={t("close")} onClick={onClose}>
						<FiX />
					</button>
				</div>

				{error && <div className="bg-task-empty">{error}</div>}

				{packs === null && !error ? (
					<div className="bg-task-empty">{t("loading")}</div>
				) : (
					<ul className="bg-task-list">
						{(packs ?? []).map((p) => {
							const working = busy === p.code;
							return (
								<li key={p.code} className="bg-task-item">
									<div className="bg-task-info">
										<div className="bg-task-line1">
											<span className="bg-task-port">{p.nativeName}</span>
											{p.installed && p.version && <span className="bg-task-name">v{p.version}</span>}
										</div>
										<div className="bg-task-line2">
											<span>{p.code}</span>
											{p.installed ? (
												<span>
													{t("localeInstalled")} · {t("localeRemoveHint")}
												</span>
											) : (
												<span>{t("localeGetMore")}</span>
											)}
										</div>
									</div>
									{p.installed ? (
										<button
											type="button"
											className="btn bg-task-stop"
											disabled={working}
											title={t("localeRemove")}
											onClick={() => void remove(p.code)}
										>
											<FiTrash2 />
											<span>{working ? t("localeRemoving") : t("localeRemove")}</span>
										</button>
									) : (
										<button
											type="button"
											className="btn"
											disabled={working}
											title={t("localeInstall")}
											onClick={() => void install(p.code)}
										>
											<FiDownload />
											<span>{working ? t("localeDownloading") : t("localeInstall")}</span>
										</button>
									)}
								</li>
							);
						})}
					</ul>
				)}

				<div className="bg-task-foot">
					<button type="button" className="btn" title={t("bgTaskRefresh")} onClick={() => void load()}>
						<FiRefreshCw />
						<span>{t("bgTaskRefresh")}</span>
					</button>
				</div>
			</div>
		</div>
	);
}
