import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	FiBox,
	FiCheck,
	FiChevronDown,
	FiChevronRight,
	FiExternalLink,
	FiEye,
	FiLayout,
	FiRefreshCw,
	FiSearch,
	FiSliders,
	FiSliders as FiSettingsSliders,
	FiX,
	FiPackage,
	FiAlertTriangle,
} from "react-icons/fi";
import type { UiPluginInfo } from "../types";
import { type PluginSelectModel } from "../plugin-setting-options";
import { useT } from "../i18n";
import { appSend } from "../app-globals";
import { PluginIcon } from "../plugin-icon";
import { hostEntryIcon } from "../host-icon";
import { Modal } from "./Modal";
import { PluginSettingsForm } from "./PluginSettingsForm";
import { excludeBuiltinModules } from "../../../server/builtin-modules";

export type PluginFilterTab = "all" | "configurable" | "enabled" | "disabled";

function PluginCardIcon({ plugin }: { plugin: UiPluginInfo }) {
	if (plugin.iconSvg) {
		return <PluginIcon iconSvg={plugin.iconSvg} />;
	}
	if (plugin.icon) {
		if (!/[a-z]/i.test(plugin.icon)) {
			return <span className="plugin-icon-glyph">{plugin.icon}</span>;
		}
		const named = hostEntryIcon({ icon: plugin.icon });
		if (named) {
			return <span className="plugin-mgr-named-icon">{named}</span>;
		}
	}
	if (plugin.view !== false) {
		return <FiLayout className="plugin-mgr-fallback-icon" aria-hidden />;
	}
	if (plugin.settingsSchema && plugin.settingsSchema.length > 0) {
		return <FiSliders className="plugin-mgr-fallback-icon" aria-hidden />;
	}
	return <FiBox className="plugin-mgr-fallback-icon" aria-hidden />;
}

export interface PluginManagerModalProps {
	open?: boolean;
	onClose: () => void;
	focusPluginId?: string | null;
	plugins: UiPluginInfo[];
	disabledPlugins: string[];
	models?: PluginSelectModel[];
	onTogglePlugin: (plugin: UiPluginInfo) => void;
	onOpenView?: (pluginId: string) => void;
	onOpenMarketplace?: () => void;
}

export function PluginManagerModal({
	open = true,
	onClose,
	focusPluginId,
	plugins: allPlugins,
	disabledPlugins,
	models = [],
	onTogglePlugin,
	onOpenView,
	onOpenMarketplace,
}: PluginManagerModalProps) {
	const t = useT();
	const plugins = useMemo(() => excludeBuiltinModules(allPlugins), [allPlugins]);
	const [searchQuery, setSearchQuery] = useState("");
	const [filterTab, setFilterTab] = useState<PluginFilterTab>("all");
	const [expandedMap, setExpandedMap] = useState<Record<string, boolean>>({});
	const [highlightedId, setHighlightedId] = useState<string | null>(null);
	const [rescanSpinning, setRescanSpinning] = useState(false);
	const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());

	const disabledSet = useMemo(() => new Set(disabledPlugins), [disabledPlugins]);

	const counts = useMemo(() => {
		let configurable = 0;
		let enabled = 0;
		let disabled = 0;

		for (const p of plugins) {
			const hasSchema = Boolean(p.settingsSchema && p.settingsSchema.length > 0);
			const isDisabled = disabledSet.has(p.id);
			const isError = Boolean(p.error);

			if (hasSchema) configurable++;
			if (!isDisabled && !isError) enabled++;
			if (isDisabled) disabled++;
		}

		return {
			total: plugins.length,
			configurable,
			enabled,
			disabled,
		};
	}, [plugins, disabledSet]);

	useEffect(() => {
		if (!open || !focusPluginId) return;

		setExpandedMap((prev) => ({ ...prev, [focusPluginId]: true }));
		setHighlightedId(focusPluginId);

		const target = plugins.find((p) => p.id === focusPluginId);
		if (target) {
			setFilterTab("all");
		}

		const timer = setTimeout(() => {
			const el = cardRefs.current.get(focusPluginId);
			if (el) {
				el.scrollIntoView({ behavior: "smooth", block: "nearest" });
			}
		}, 120);

		const highlightTimer = setTimeout(() => {
			setHighlightedId(null);
		}, 2600);

		return () => {
			clearTimeout(timer);
			clearTimeout(highlightTimer);
		};
	}, [open, focusPluginId, plugins]);

	const toggleExpand = useCallback((id: string) => {
		setExpandedMap((prev) => ({ ...prev, [id]: !prev[id] }));
	}, []);

	const toggleAllExpand = useCallback(() => {
		const anyCollapsed = plugins.some((p) => p.settingsSchema?.length && !expandedMap[p.id]);
		const next: Record<string, boolean> = {};
		for (const p of plugins) {
			if (p.settingsSchema?.length) {
				next[p.id] = anyCollapsed;
			}
		}
		setExpandedMap(next);
	}, [plugins, expandedMap]);

	const filteredPlugins = useMemo(() => {
		const q = searchQuery.trim().toLowerCase();
		return plugins.filter((p) => {
			const isConfigurable = Boolean(p.settingsSchema && p.settingsSchema.length > 0);
			const isDisabled = disabledSet.has(p.id);
			const isError = Boolean(p.error);

			if (filterTab === "configurable" && !isConfigurable) return false;
			if (filterTab === "enabled" && (isDisabled || isError)) return false;
			if (filterTab === "disabled" && !isDisabled) return false;

			if (q) {
				const matchName = p.name?.toLowerCase().includes(q);
				const matchId = p.id?.toLowerCase().includes(q);
				const matchDesc = p.description?.toLowerCase().includes(q);
				if (!matchName && !matchId && !matchDesc) return false;
			}

			return true;
		});
	}, [plugins, filterTab, searchQuery, disabledSet]);

	const handleRescan = useCallback(() => {
		setRescanSpinning(true);
		appSend({ type: "plugins_reload" });
		setTimeout(() => setRescanSpinning(false), 800);
	}, []);

	return (
		<Modal
			open={open}
			onClose={onClose}
			className="plugin-mgr-modal"
			ariaLabel={t("pluginManagerTitle")}
			showCloseButton={false}
		>
			<div className="plugin-mgr-head">
				<div className="plugin-mgr-title-row">
					<div
						className="plugin-mgr-title-left"
						title={t("pluginCountSummary", {
							total: counts.total,
							enabled: counts.enabled,
							configurable: counts.configurable,
						})}
					>
						<FiBox className="plugin-mgr-title-icon" aria-hidden />
						<h2 className="plugin-mgr-title">{t("pluginManagerTitle")}</h2>
					</div>
					<div className="plugin-mgr-title-actions">
						<button
							type="button"
							className="btn plugin-mgr-btn-subtle"
							title={t("pluginRescanHint")}
							onClick={handleRescan}
							disabled={rescanSpinning}
						>
							<FiRefreshCw className={rescanSpinning ? "spin" : ""} aria-hidden />
							<span>{t("pluginRescan")}</span>
						</button>
						{onOpenMarketplace && (
							<button
								type="button"
								className="btn plugin-mgr-btn-subtle"
								onClick={() => {
									onClose();
									onOpenMarketplace();
								}}
							>
								<FiPackage aria-hidden />
								<span>{t("pluginGoMarket")}</span>
							</button>
						)}
						<button
							type="button"
							className="plugin-mgr-close-btn"
							aria-label={t("close")}
							title={t("close")}
							onClick={onClose}
						>
							<FiX aria-hidden />
						</button>
					</div>
				</div>

				<div className="plugin-mgr-toolbar">
					<div className="plugin-mgr-search-wrap">
						<FiSearch className="plugin-mgr-search-icon" aria-hidden />
						<input
							type="text"
							className="plugin-mgr-search-input"
							placeholder={t("pluginSearchPlaceholder")}
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.target.value)}
						/>
						{searchQuery && (
							<button
								type="button"
								className="plugin-mgr-search-clear"
								onClick={() => setSearchQuery("")}
								aria-label="Clear"
							>
								<FiX aria-hidden />
							</button>
						)}
					</div>

					<div className="plugin-mgr-filters">
						<button
							type="button"
							className={`plugin-mgr-chip${filterTab === "all" ? " active" : ""}`}
							onClick={() => setFilterTab("all")}
						>
							{t("pluginFilterAll")}
							<span className="plugin-mgr-chip-count">{counts.total}</span>
						</button>
						<button
							type="button"
							className={`plugin-mgr-chip${filterTab === "configurable" ? " active" : ""}`}
							onClick={() => setFilterTab("configurable")}
						>
							<FiSliders className="plugin-mgr-chip-icon" aria-hidden />
							{t("pluginFilterConfigurable")}
							<span className="plugin-mgr-chip-count">{counts.configurable}</span>
						</button>
						<button
							type="button"
							className={`plugin-mgr-chip${filterTab === "enabled" ? " active" : ""}`}
							onClick={() => setFilterTab("enabled")}
						>
							<FiCheck className="plugin-mgr-chip-icon" aria-hidden />
							{t("pluginFilterEnabled")}
							<span className="plugin-mgr-chip-count">{counts.enabled}</span>
						</button>
						<button
							type="button"
							className={`plugin-mgr-chip${filterTab === "disabled" ? " active" : ""}`}
							onClick={() => setFilterTab("disabled")}
						>
							{t("pluginFilterDisabled")}
							<span className="plugin-mgr-chip-count">{counts.disabled}</span>
						</button>
					</div>

					{counts.configurable > 0 && (
						<div className="plugin-mgr-expand-action">
							<button type="button" className="plugin-mgr-text-btn" onClick={toggleAllExpand}>
								{plugins.some((p) => p.settingsSchema?.length && !expandedMap[p.id])
									? t("pluginExpandAll")
									: t("pluginCollapseAll")}
							</button>
						</div>
					)}
				</div>
			</div>

			<div className="plugin-mgr-body">
				{filteredPlugins.length === 0 ? (
					<div className="plugin-mgr-empty">
						<FiBox className="plugin-mgr-empty-icon" aria-hidden />
						<p>{searchQuery || filterTab !== "all" ? t("pluginEmptyFilter") : t("pluginMenuEmpty")}</p>
						{(searchQuery || filterTab !== "all") && (
							<button
								type="button"
								className="btn plugin-mgr-btn-subtle"
								onClick={() => {
									setSearchQuery("");
									setFilterTab("all");
								}}
							>
								{t("pluginFilterAll")}
							</button>
						)}
					</div>
				) : (
					<div className="plugin-mgr-list">
						{filteredPlugins.map((p) => {
							const hasSchema = Boolean(p.settingsSchema && p.settingsSchema.length > 0);
							const isDisabled = disabledSet.has(p.id);
							const isError = Boolean(p.error);
							const isExpanded = Boolean(expandedMap[p.id]);
							const isView = p.view !== false && !isError;
							const isHighlighted = highlightedId === p.id;
							const url = p.homepage || (p.source?.startsWith("http") ? p.source : undefined);

							return (
								<div
									key={p.id}
									ref={(el) => {
										if (el) cardRefs.current.set(p.id, el);
										else cardRefs.current.delete(p.id);
									}}
									className={`plugin-mgr-card${isDisabled ? " disabled" : ""}${isError ? " has-error" : ""}${
										isHighlighted ? " highlighted" : ""
									}`}
								>
									<div className="plugin-mgr-card-head">
										<div className="plugin-mgr-card-identity">
											<div className="plugin-mgr-card-icon-wrap">
												<PluginCardIcon plugin={p} />
											</div>
											<div className="plugin-mgr-card-names">
												<div className="plugin-mgr-card-name-row">
													<span className="plugin-mgr-card-name">{p.name}</span>
													{p.version && <span className="plugin-mgr-card-ver">v{p.version}</span>}
													<span className="plugin-mgr-card-id">{p.id}</span>
												</div>
												<div className="plugin-mgr-badges">
													{hasSchema && (
														<span className="plugin-badge config" title={t("pluginBadgeConfig")}>
															<FiSliders aria-hidden />
															{t("pluginBadgeConfig")}
														</span>
													)}
													{isView ? (
														<span className="plugin-badge view">{t("pluginBadgeView")}</span>
													) : (
														<span className="plugin-badge bg">{t("pluginBadgeBg")}</span>
													)}
													{p.agentTools && p.agentTools.length > 0 && (
														<span className="plugin-badge tools">
															{t("pluginBadgeTools", { count: p.agentTools.length })}
														</span>
													)}
													{isError && (
														<span className="plugin-badge error">
															<FiAlertTriangle aria-hidden />
															Error
														</span>
													)}
												</div>
											</div>
										</div>

										<div className="plugin-mgr-card-controls">
											{url && (
												<a
													href={url}
													target="_blank"
													rel="noreferrer noopener"
													className="plugin-mgr-icon-btn"
													title={t("pluginOfficialLink")}
												>
													<FiExternalLink aria-hidden />
												</a>
											)}
											{isView && !isDisabled && onOpenView && (
												<button
													type="button"
													className="btn plugin-mgr-btn-open-view"
													onClick={() => {
														onClose();
														onOpenView(p.id);
													}}
													title={t("pluginOpenView")}
												>
													<FiEye aria-hidden />
													<span>{t("pluginOpenView")}</span>
												</button>
											)}
											<div className="plugin-mgr-toggle-wrap">
												<button
													type="button"
													role="switch"
													aria-checked={!isDisabled && !isError}
													disabled={isError}
													title={isDisabled ? t("pluginToggleEnable") : t("pluginToggleDisable")}
													className={`plugin-mgr-switch${!isDisabled && !isError ? " on" : ""}`}
													onClick={() => onTogglePlugin(p)}
												>
													<span className="plugin-mgr-switch-thumb" />
												</button>
											</div>
										</div>
									</div>

									{p.description && (
										<div className="plugin-mgr-card-desc" title={p.description}>
											{p.description}
										</div>
									)}

									{p.error && (
										<div className="plugin-mgr-card-error">
											<FiAlertTriangle aria-hidden />
											<span>{p.error}</span>
										</div>
									)}

									{hasSchema && (
										<div className="plugin-mgr-settings-section">
											<button
												type="button"
												className="plugin-mgr-settings-toggle"
												onClick={() => toggleExpand(p.id)}
												aria-expanded={isExpanded}
											>
												{isExpanded ? <FiChevronDown aria-hidden /> : <FiChevronRight aria-hidden />}
												<FiSettingsSliders className="plugin-mgr-settings-icon" aria-hidden />
												<span className="plugin-mgr-settings-toggle-title">
													{t("pluginSettingsTitle")} ({p.settingsSchema!.length})
												</span>
												<span className="plugin-mgr-settings-toggle-hint">
													{isExpanded ? t("pluginSettingsHide") : t("pluginSettingsShow")}
												</span>
											</button>
											{isExpanded && (
												<div className="plugin-mgr-settings-content">
													<PluginSettingsForm plugin={p} models={models} />
												</div>
											)}
										</div>
									)}
								</div>
							);
						})}
					</div>
				)}
			</div>
		</Modal>
	);
}
