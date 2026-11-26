import { useCallback, useEffect, useMemo, useState } from "react";
import { FiCheck, FiDownload, FiExternalLink, FiRefreshCw, FiSearch, FiTrash2, FiX } from "react-icons/fi";
import { isZhLocale, useI18n } from "../i18n";
import {
	fetchThemeCatalog,
	installCommunityTheme,
	syncThemeCatalog,
	uninstallCommunityTheme,
	type CommunityThemeEntry,
	type ThemeInfo,
} from "../theme";
import { OFFICIAL_PLUGINS_REPO_URL } from "./SettingsModal";

export interface CommunityThemesSectionProps {
	themes: ThemeInfo[];
	currentTheme: string | null;
	onThemeChange: (id: string | null) => void;
	onReloadThemes: () => void;
}

export function CommunityThemesSection({
	themes,
	currentTheme,
	onThemeChange,
	onReloadThemes,
}: CommunityThemesSectionProps) {
	const { t, locale } = useI18n();
	const isZh = isZhLocale(locale);
	const [entries, setEntries] = useState<CommunityThemeEntry[]>([]);
	const [loading, setLoading] = useState(false);
	const [syncing, setSyncing] = useState(false);
	const [busyId, setBusyId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [search, setSearch] = useState("");
	const [schemeFilter, setSchemeFilter] = useState<"all" | "dark" | "light">("all");

	const installedMap = useMemo(() => new Map(themes.map((th) => [th.id, th])), [themes]);

	const loadCatalog = useCallback(async () => {
		setLoading(true);
		try {
			const res = await fetchThemeCatalog();
			setEntries(Array.isArray(res.entries) ? res.entries : []);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void loadCatalog();
	}, [loadCatalog]);

	const handleSync = async () => {
		setSyncing(true);
		setError(null);
		try {
			const res = await syncThemeCatalog();
			setEntries(Array.isArray(res.entries) ? res.entries : []);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSyncing(false);
		}
	};

	const handleInstall = async (entry: CommunityThemeEntry) => {
		setBusyId(entry.id);
		setError(null);
		try {
			await installCommunityTheme(entry.id, entry.resolvedCssUrl);
			onReloadThemes();
			onThemeChange(entry.id);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusyId(null);
		}
	};

	const handleUninstall = async (id: string) => {
		setBusyId(id);
		setError(null);
		try {
			await uninstallCommunityTheme(id);
			onReloadThemes();
			if (currentTheme === id) onThemeChange("flow-zurich");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusyId(null);
		}
	};

	const filtered = useMemo(() => {
		const q = search.trim().toLowerCase();
		return entries.filter((e) => {
			if (schemeFilter !== "all" && e.scheme !== schemeFilter) return false;
			if (!q) return true;
			return (
				e.id.toLowerCase().includes(q) ||
				e.name.toLowerCase().includes(q) ||
				(e.nameEn ?? "").toLowerCase().includes(q) ||
				e.author.toLowerCase().includes(q) ||
				e.description.toLowerCase().includes(q) ||
				(e.descriptionEn ?? "").toLowerCase().includes(q) ||
				(e.tags ?? []).some((tag) => tag.toLowerCase().includes(q))
			);
		});
	}, [entries, search, schemeFilter]);

	return (
		<div className="set-section theme-market-section">
			<div className="theme-market-header">
				<div>
					<div className="set-section-title" style={{ marginBottom: 4 }}>
						{t("themeMarketTitle")}
					</div>
					<div className="set-note">{t("themeMarketDesc")}</div>
				</div>
				<div className="theme-market-actions">
					<button type="button" className="smart-tool-btn" disabled={syncing} onClick={() => void handleSync()}>
						<FiRefreshCw className={syncing ? "spin" : undefined} />
						<span>{syncing ? t("themeMarketSyncing") : t("themeMarketSync")}</span>
					</button>
					<a href={OFFICIAL_PLUGINS_REPO_URL} target="_blank" rel="noreferrer noopener" className="smart-tool-link">
						<FiExternalLink />
						<span>{t("themeMarketSubmit")}</span>
					</a>
				</div>
			</div>

			{error && <div className="set-catalog-job error">{error}</div>}

			<div className="theme-market-toolbar">
				<div className="smart-tab-pills" role="tablist">
					{(["all", "dark", "light"] as const).map((mode) => (
						<button
							key={mode}
							type="button"
							role="tab"
							aria-selected={schemeFilter === mode}
							className={`smart-tab-pill${schemeFilter === mode ? " active" : ""}`}
							onClick={() => setSchemeFilter(mode)}
						>
							{mode === "all" ? t("themeMarketAll") : mode === "dark" ? t("themeDark") : t("themeLight")}
						</button>
					))}
				</div>
				<div className="smart-search-wrap" style={{ flex: 1 }}>
					<FiSearch className="smart-search-icon" />
					<input
						type="text"
						className="smart-search-input"
						placeholder={t("themeMarketSearchPh")}
						value={search}
						onChange={(e) => setSearch(e.target.value)}
					/>
					{search && (
						<button type="button" className="smart-search-clear" onClick={() => setSearch("")}>
							<FiX />
						</button>
					)}
				</div>
			</div>

			{loading && entries.length === 0 ? (
				<p className="set-empty">{t("themeMarketSyncing")}</p>
			) : filtered.length === 0 ? (
				<p className="set-empty">{entries.length === 0 ? t("themeMarketEmpty") : t("searchNoResults")}</p>
			) : (
				<div className="theme-market-grid">
					{filtered.map((entry) => {
						const installed = installedMap.get(entry.id);
						const isActive = currentTheme === entry.id;
						const isBusy = busyId === entry.id;
						const title = isZh ? entry.name : (entry.nameEn ?? entry.name);
						const desc = isZh ? entry.description : (entry.descriptionEn ?? entry.description);
						const swatches =
							entry.palette.swatches && entry.palette.swatches.length > 0
								? entry.palette.swatches
								: [entry.palette.bg, entry.palette.accent, entry.palette.text];

						return (
							<div key={entry.id} className={`theme-market-card${isActive ? " active" : ""}`}>
								<div className="theme-market-card-top">
									<div className="theme-market-card-title" title={title}>
										{title}
									</div>
									<span className="theme-market-scheme">
										{entry.scheme === "light" ? t("themeLight") : t("themeDark")}
									</span>
								</div>
								<div className="theme-market-swatches">
									{swatches.map((hex, i) => (
										<span key={`${hex}-${i}`} className="theme-market-swatch" style={{ background: hex }} title={hex} />
									))}
								</div>
								{desc && <div className="theme-market-desc">{desc}</div>}
								<div className="theme-market-card-footer">
									<span className="theme-market-author">@{entry.author}</span>
									<div className="theme-market-btns">
										{installed ? (
											<>
												{isActive ? (
													<span className="theme-market-badge-active">
														<FiCheck />
														{t("themeMarketActive")}
													</span>
												) : (
													<button
														type="button"
														className="smart-tool-btn"
														disabled={isBusy}
														onClick={() => onThemeChange(entry.id)}
													>
														{t("themeMarketApply")}
													</button>
												)}
												{!installed.builtin && (
													<button
														type="button"
														className="smart-tool-btn danger"
														disabled={isBusy}
														title={t("themeMarketUninstall")}
														onClick={() => void handleUninstall(entry.id)}
													>
														<FiTrash2 />
													</button>
												)}
											</>
										) : (
											<button
												type="button"
												className="smart-tool-btn"
												disabled={isBusy}
												onClick={() => void handleInstall(entry)}
											>
												<FiDownload />
												<span>{isBusy ? t("themeMarketInstalling") : t("themeMarketInstall")}</span>
											</button>
										)}
									</div>
								</div>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}
