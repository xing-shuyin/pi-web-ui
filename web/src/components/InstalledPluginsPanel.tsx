import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { FiChevronDown, FiChevronRight, FiRefreshCw, FiSearch, FiPlus, FiTrash2, FiBox } from "react-icons/fi";
import type { UiExtensionInfo, UiExtensionInventoryEntry, UiPluginInfo, UiPluginUpdateInfo } from "../types";
import type { PluginSelectModel } from "../plugin-setting-options";
import { appSend } from "../app-globals";
import { useI18n } from "../i18n";
import { pluginDisplayDescription, pluginDisplayName } from "../plugin-name";
import { PluginIcon } from "../plugin-icon";
import {
	getPluginLogs,
	PLUGIN_LOG_LEVELS,
	pluginLogsClearRequest,
	pluginLogsFetch,
	subscribePluginLogs,
	type PluginLogLevel,
} from "../plugin-logs";
import { PluginSettingsForm } from "./PluginSettingsForm";
import { PluginPage } from "./PluginPage";
import type { UiSlotEntry } from "../ui-slots";

/** `page:<entryId>` = manifest `ui.settings` 里声明的一页；`page` = 没声明页时的通用插件页 */
type DetailTab = "overview" | "config" | "page" | `page:${string}` | "logs" | "caps" | "load";
type KindFilter = "all" | "ui" | "pi";
type Health = "online" | "error" | "warn" | "stopped";

interface Row {
	uid: string;
	kind: "ui" | "pi";
	name: string;
	icon?: string;
	iconSvg?: string;
	desc: string;
	scope: string;
	version?: string;
	enabled: boolean;
	switchable: boolean;
	health: Health;
	error?: string;
	plugin?: UiPluginInfo;
	extension?: UiExtensionInfo;
	inventory?: UiExtensionInventoryEntry;
	updatable?: boolean;
	jobRunning?: boolean;
}

export interface InstalledPluginsPanelProps {
	/** 界面插件（WebUI 插件运行时）。 */
	plugins: UiPluginInfo[];
	/** Pi / agent 会话内的扩展。 */
	extensions: UiExtensionInfo[];
	disabledPlugins: readonly string[];
	disabledExtensions: readonly string[];
	pluginUpdates?: Record<string, UiPluginUpdateInfo> | null;
	pluginJobs?: Record<string, { pluginId?: string; phase?: string; startedAt?: number }>;
	/** #885 服务端统一清单；用于 Pi 扩展的健康、错误原文与工具数。 */
	inventoryEntries?: UiExtensionInventoryEntry[];
	/** `settings.pages` 槽位的工作集（已按界面布局过滤/排序）：插件声明的页在这里变成详情里的标签 */
	pageEntries?: UiSlotEntry[];
	models?: PluginSelectModel[];
	epoch: number;
	onTogglePlugin: (plugin: UiPluginInfo) => void;
	onToggleExtension: (extension: UiExtensionInfo) => void;
	onUpdatePlugin: (id: string, source: string) => void;
	onUninstallPlugin: (id: string) => void;
	onInstallExtension: (spec: string) => void;
	onUninstallExtension: (pkgName: string) => void;
}

function inventoryHealth(entry?: UiExtensionInventoryEntry): Health {
	if (!entry) return "online";
	if (entry.error || entry.health === "error") return "error";
	if (entry.health === "stopped" || entry.enabled === false) return "stopped";
	if (entry.health === "offline") return "warn";
	return "online";
}

/**
 * 「插件 → 安装的插件」：界面插件与 Pi 插件共用一张单列折叠列表。
 * 点行就地展开详情，同时最多展开一项；不设左右分栏。
 * 启停分别写回 disabledPlugins / disabledExtensions，由调用方用 setPartial 保证保存回执。
 */
export function InstalledPluginsPanel({
	plugins,
	extensions,
	disabledPlugins,
	disabledExtensions,
	pluginUpdates,
	pluginJobs,
	inventoryEntries = [],
	pageEntries = [],
	models = [],
	epoch,
	onTogglePlugin,
	onToggleExtension,
	onUpdatePlugin,
	onUninstallPlugin,
	onInstallExtension,
	onUninstallExtension,
}: InstalledPluginsPanelProps): JSX.Element {
	const { t, locale } = useI18n();
	const disabledPluginSet = useMemo(() => new Set(disabledPlugins), [disabledPlugins]);
	const disabledExtensionSet = useMemo(() => new Set(disabledExtensions), [disabledExtensions]);

	const rows = useMemo<Row[]>(() => {
		const out: Row[] = [];
		const cliByName = new Map(inventoryEntries.filter((e) => e.source === "cli").map((e) => [e.name, e]));

		for (const p of plugins) {
			const enabled = !disabledPluginSet.has(p.id);
			const upd = pluginUpdates?.[p.id];
			let jobRunning = false;
			for (const job of Object.values(pluginJobs ?? {})) {
				if (job.pluginId === p.id && job.phase !== "done") jobRunning = true;
			}
			out.push({
				uid: `ui:${p.id}`,
				kind: "ui",
				name: pluginDisplayName(p, locale),
				icon: p.icon,
				iconSvg: p.iconSvg,
				desc: pluginDisplayDescription(p, locale) || p.source || t("uiPluginNoSource"),
				scope: "dataDir",
				version: p.version,
				enabled,
				switchable: true,
				health: p.error ? "error" : enabled ? "online" : "stopped",
				error: p.error,
				plugin: p,
				updatable: upd?.updatable === true,
				jobRunning,
			});
		}

		for (const e of extensions) {
			const inv = cliByName.get(e.id) ?? cliByName.get(e.name);
			out.push({
				uid: `pi:${e.id}`,
				kind: "pi",
				name: e.name || e.id,
				icon: "📦",
				desc: e.path || e.id,
				scope: e.path.includes(".pi") ? t("pluginsScopeProjectPi") : "agentDir",
				enabled: !disabledExtensionSet.has(e.id),
				switchable: true,
				health: inventoryHealth(inv),
				error: inv?.error,
				extension: e,
				inventory: inv,
			});
		}

		// SDK 内置扩展：不在 settings.extensions 里，由统一清单透出；隐藏加载的标为只读。
		const known = new Set(extensions.flatMap((e) => [e.id, e.name]));
		for (const inv of inventoryEntries) {
			if (inv.source !== "cli" || known.has(inv.name)) continue;
			out.push({
				uid: `pi:builtin:${inv.name}`,
				kind: "pi",
				name: inv.name,
				icon: "🧠",
				desc: inv.description || t("pluginsPiNoCaps"),
				scope: "agentDir",
				enabled: inv.enabled !== false,
				switchable: inv.switchable !== false,
				health: inventoryHealth(inv),
				error: inv.error,
				inventory: inv,
			});
		}

		const order = { ui: 0, pi: 1 } as const;
		out.sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name));
		return out;
	}, [
		plugins,
		extensions,
		inventoryEntries,
		disabledPluginSet,
		disabledExtensionSet,
		pluginUpdates,
		pluginJobs,
		t,
		locale,
	]);

	const [expandedUid, setExpandedUid] = useState<string | null>(() => rows[0]?.uid ?? null);
	const [detailTab, setDetailTab] = useState<DetailTab>("overview");
	const [filter, setFilter] = useState<KindFilter>("all");
	const [query, setQuery] = useState("");
	const [showInstall, setShowInstall] = useState(false);
	const [confirmUninstallUid, setConfirmUninstallUid] = useState<string | null>(null);
	const [installSpec, setInstallSpec] = useState("");
	const [logLevel, setLogLevel] = useState<"all" | PluginLogLevel>("all");
	const [, setLogSeq] = useState(0);

	useEffect(() => {
		if (expandedUid && !rows.some((r) => r.uid === expandedUid)) setExpandedUid(null);
	}, [rows, expandedUid]);

	useEffect(() => subscribePluginLogs(() => setLogSeq((n) => n + 1)), []);

	const expanded = rows.find((r) => r.uid === expandedUid) ?? null;
	useEffect(() => {
		if (!expanded || detailTab !== "logs" || !expanded.plugin) return;
		appSend(pluginLogsFetch(expanded.plugin.id));
	}, [expandedUid, detailTab, expanded?.plugin?.id]); // eslint-disable-line react-hooks/exhaustive-deps

	const visible = useMemo(() => {
		const q = query.trim().toLowerCase();
		return rows.filter(
			(r) =>
				(filter === "all" || r.kind === filter) && (!q || `${r.name} ${r.uid} ${r.desc}`.toLowerCase().includes(q)),
		);
	}, [rows, filter, query]);

	const toggleRow = (uid: string) => {
		setExpandedUid((prev) => (prev === uid ? null : uid));
		setDetailTab("overview");
		setConfirmUninstallUid(null);
	};

	// 插件声明的 `ui.settings` 页（已按布局隐藏/排序）→ 详情里的标签；
	// 一页都没声明的插件仍给一个通用「插件页」标签（client/entry.mjs 的 mount 直接渲染）。
	const pageTabsFor = (r: Row): Array<[DetailTab, string]> => {
		if (!r.plugin) return [];
		const declared = pageEntries.filter((e) => e.source === `plugin:${r.plugin!.id}` && !e.hidden);
		if (declared.length > 0) return declared.map((e) => [`page:${e.id}` as DetailTab, e.label] as [DetailTab, string]);
		return r.plugin.hasClient ? [["page", t("pluginsTabPage")]] : [];
	};

	const tabsFor = (r: Row): Array<[DetailTab, string]> =>
		r.kind === "ui"
			? [
					["overview", t("pluginsTabOverview")],
					["config", t("pluginsTabConfig")],
					...pageTabsFor(r),
					["logs", t("pluginLogTitle")],
				]
			: [
					["overview", t("pluginsTabOverview")],
					["caps", t("pluginsTabCaps")],
					["load", t("pluginsTabLoad")],
				];

	const activeTab: DetailTab = tabsFor(expanded ?? rows[0] ?? ({} as Row)).some((x) => x[0] === detailTab)
		? detailTab
		: "overview";

	const renderOverview = (r: Row): JSX.Element => {
		const p = r.plugin;
		const e = r.extension;
		const pkgName = e?.id.startsWith("npm:") ? e.id.slice(4) : null;
		const needConfirm = confirmUninstallUid === r.uid;
		return (
			<>
				<div className="ip-kv">
					<span>UID</span>
					<code>{r.uid}</code>
				</div>
				<div className="ip-kv">
					<span>{t("pluginCatalogSource")}</span>
					<span className="ip-ellipsis">{r.desc}</span>
				</div>
				<div className="ip-kv">
					<span>{t("pluginsScope")}</span>
					<span>{r.scope}</span>
				</div>
				{r.version ? (
					<div className="ip-kv">
						<span>{t("currentVersion")}</span>
						<span>v{r.version}</span>
					</div>
				) : null}
				<div className="ip-kv">
					<span>{t("pluginsStoreLabel")}</span>
					<code>{r.kind === "ui" ? "disabledPlugins" : "disabledExtensions"}</code>
				</div>
				<div className="ip-kv">
					<span>{t("pluginPhaseActive")}</span>
					<span className={r.enabled ? "ip-ok" : "ip-muted"}>
						{r.enabled ? t("pluginPhaseActive") : t("pluginPhaseDisabled")}
					</span>
				</div>
				{r.error ? <div className="ip-note ip-note-error">{r.error}</div> : null}
				{p?.permissions?.length ? (
					<div className="ip-chips">
						{p.permissions.map((perm) => (
							<span key={perm} className="ip-chip">
								{perm}
							</span>
						))}
					</div>
				) : null}
				{p?.diagnostics?.length ? <div className="ip-note">{p.diagnostics.join(" · ")}</div> : null}
				<div className="ip-actions">
					{p && r.updatable && p.source ? (
						<button
							type="button"
							className="ip-btn"
							disabled={r.jobRunning}
							onClick={() => onUpdatePlugin(p.id, p.source!)}
						>
							{t("pluginUpdate")}
						</button>
					) : null}
					{p ? (
						<button
							type="button"
							className="ip-btn ip-btn-danger"
							onClick={() => {
								if (!needConfirm) {
									setConfirmUninstallUid(r.uid);
									return;
								}
								setConfirmUninstallUid(null);
								onUninstallPlugin(p.id);
							}}
						>
							<FiTrash2 aria-hidden /> {needConfirm ? t("uninstallConfirm") : t("uninstallExt")}
						</button>
					) : null}
					{pkgName ? (
						<button
							type="button"
							className="ip-btn ip-btn-danger"
							onClick={() => {
								if (!needConfirm) {
									setConfirmUninstallUid(r.uid);
									return;
								}
								setConfirmUninstallUid(null);
								onUninstallExtension(pkgName);
							}}
						>
							<FiTrash2 aria-hidden /> {needConfirm ? t("uninstallConfirm") : t("pluginsPiUninstall")}
						</button>
					) : null}
					{p?.wantsDom ? (
						<button
							type="button"
							className="ip-btn"
							onClick={() =>
								appSend({
									type: "plugin_dom_consent",
									pluginId: p.id,
									granted: !p.domGranted,
								})
							}
						>
							{p.domGranted ? t("pluginDomGranted") : t("pluginDomNeed")}
						</button>
					) : null}
				</div>
			</>
		);
	};

	const renderDetail = (r: Row): JSX.Element => {
		if (activeTab === "overview") return renderOverview(r);
		if (activeTab === "config") {
			if (!r.plugin?.settingsSchema?.length) {
				return <p className="ip-empty">{t("pluginsNoConfig")}</p>;
			}
			return (
				<div className="ip-form-host">
					<PluginSettingsForm plugin={r.plugin} models={models} />
				</div>
			);
		}
		if (activeTab === "page" || activeTab.startsWith("page:")) {
			if (!r.plugin?.hasClient) return <p className="ip-empty">{t("pluginsNoClient")}</p>;
			// entry.id 是 `<pluginId>:<itemId>`，插件要的是自己声明里的那个 itemId
			const pageId = activeTab === "page" ? undefined : activeTab.slice("page:".length).split(":").slice(1).join(":");
			return (
				<div className="ip-page-host">
					<PluginPage plugin={r.plugin} epoch={epoch} send={appSend} pageId={pageId} />
				</div>
			);
		}
		if (activeTab === "logs" && r.plugin) {
			const all = getPluginLogs(r.plugin.id);
			const entries = logLevel === "all" ? all : all.filter((x) => x.level === logLevel);
			return (
				<div className="ip-logs">
					<div className="ip-logs-head">
						<span>{t("pluginLogLevel")}</span>
						{(["all", ...PLUGIN_LOG_LEVELS] as const).map((lv) => (
							<button
								key={lv}
								type="button"
								className={`ip-tab${logLevel === lv ? " active" : ""}`}
								onClick={() => setLogLevel(lv)}
							>
								{lv === "all" ? t("pluginLogAll") : lv.toUpperCase()}
							</button>
						))}
						<button type="button" className="ip-btn" onClick={() => appSend(pluginLogsClearRequest(r.plugin!.id))}>
							{t("pluginLogClear")}
						</button>
					</div>
					{entries.length === 0 ? (
						<p className="ip-empty">{t("pluginLogEmpty")}</p>
					) : (
						<div className="ip-log">
							{entries.map((entry, i) => (
								<div key={`${entry.ts}-${i}`} className="ip-log-line">
									<span className="ip-log-level">{entry.level.toUpperCase()}</span>
									<span className="ip-ellipsis">{entry.text}</span>
								</div>
							))}
						</div>
					)}
				</div>
			);
		}
		if (activeTab === "caps") {
			return (
				<>
					<div className="ip-kv">
						<span>{t("pluginCatalogSource")}</span>
						<code>resourceLoader.getExtensions()</code>
					</div>
					{typeof r.inventory?.toolCount === "number" ? (
						<div className="ip-kv">
							<span>{t("settingsTools")}</span>
							<span>{r.inventory.toolCount}</span>
						</div>
					) : null}
					<p className="ip-note">{t("pluginsPiNoCaps")}</p>
				</>
			);
		}
		return (
			<>
				<div className="ip-kv">
					<span>{t("pluginCatalogSource")}</span>
					<span className="ip-ellipsis">{r.inventory?.description || r.desc}</span>
				</div>
				<div className="ip-kv">
					<span>{t("pluginPhaseActive")}</span>
					<span>{r.health}</span>
				</div>
				{!r.switchable ? <p className="ip-note">{t("uiLayoutRequired")}</p> : null}
				{r.error ? <div className="ip-note ip-note-error">{r.error}</div> : null}
			</>
		);
	};

	const counts = useMemo(
		() => ({
			total: rows.length,
			enabled: rows.filter((r) => r.enabled).length,
			ui: rows.filter((r) => r.kind === "ui").length,
			pi: rows.filter((r) => r.kind === "pi").length,
			error: rows.filter((r) => r.health === "error").length,
		}),
		[rows],
	);

	return (
		<div className="ip-panel">
			<div className="ip-toolbar">
				<div className="ip-search">
					<FiSearch aria-hidden />
					<input
						type="text"
						aria-label={t("pluginCatalogSearchPlaceholder")}
						placeholder={t("pluginCatalogSearchPlaceholder")}
						value={query}
						onChange={(ev) => setQuery(ev.target.value)}
					/>
				</div>
				<button type="button" className="ip-btn" onClick={() => appSend({ type: "check_plugin_updates" })}>
					<FiRefreshCw aria-hidden /> {t("pluginCheckUpdates")}
				</button>
				<button
					type="button"
					className="ip-btn"
					onClick={() => {
						appSend({ type: "plugins_reload" });
						appSend({ type: "extensions_reload" });
					}}
				>
					<FiRefreshCw aria-hidden /> {t("pluginRescan")}
				</button>
				<button type="button" className="ip-btn ip-btn-primary" onClick={() => setShowInstall((v) => !v)}>
					<FiPlus aria-hidden /> {t("pluginsAddPi")}
				</button>
			</div>

			{showInstall && (
				<div className="ip-install">
					<input
						type="text"
						aria-label={t("pluginsPiSpecHint")}
						placeholder={t("pluginsPiSpecHint")}
						value={installSpec}
						onChange={(ev) => setInstallSpec(ev.target.value)}
						onKeyDown={(ev) => {
							if (ev.key !== "Enter" || !installSpec.trim()) return;
							onInstallExtension(installSpec.trim());
							setInstallSpec("");
							setShowInstall(false);
						}}
					/>
					<button
						type="button"
						className="ip-btn ip-btn-primary"
						disabled={!installSpec.trim()}
						onClick={() => {
							onInstallExtension(installSpec.trim());
							setInstallSpec("");
							setShowInstall(false);
						}}
					>
						{t("pluginInstall")}
					</button>
				</div>
			)}

			<div className="ip-filters">
				{(["all", "ui", "pi"] as const).map((k) => {
					const label =
						k === "all" ? t("pluginCatalogTabAll") : k === "ui" ? t("settingsUiPlugins") : t("pluginKindPi");
					const n = k === "all" ? rows.length : rows.filter((r) => r.kind === k).length;
					return (
						<button
							key={k}
							type="button"
							className={`ip-chip-btn${filter === k ? " active" : ""}`}
							onClick={() => setFilter(k)}
						>
							{label} <span>{n}</span>
						</button>
					);
				})}
			</div>

			<div className="ip-stats">
				<span className="ip-stat">
					<b>{counts.total}</b> {t("pluginsInstalledTab")}
				</span>
				<span className="ip-stat">
					<b>{counts.enabled}</b> {t("pluginPhaseActive")}
				</span>
				<span className="ip-stat">
					<b>{counts.ui}</b> {t("settingsUiPlugins")}
				</span>
				<span className="ip-stat">
					<b>{counts.pi}</b> {t("pluginKindPi")}
				</span>
				<span className="ip-stat">
					<b>{counts.error}</b> {t("pluginPhaseFailed")}
				</span>
			</div>

			<div className="ip-hint">{t("pluginsExpandHint")}</div>

			<div className="ip-list">
				{visible.length === 0 ? (
					<p className="ip-empty">{query.trim() ? t("searchNoResults") : t("noExtensions")}</p>
				) : (
					visible.map((r) => {
						const open = expandedUid === r.uid;
						return (
							<div key={r.uid} className={`ip-item${open ? " open" : ""}`}>
								<div
									className="ip-row"
									role="button"
									tabIndex={0}
									aria-expanded={open}
									onClick={() => toggleRow(r.uid)}
									onKeyDown={(ev) => {
										if (ev.key !== "Enter" && ev.key !== " ") return;
										ev.preventDefault();
										toggleRow(r.uid);
									}}
								>
									<span className="ip-caret" aria-hidden>
										{open ? <FiChevronDown /> : <FiChevronRight />}
									</span>
									{r.iconSvg || r.icon ? (
										<PluginIcon icon={r.icon} iconSvg={r.iconSvg} className="ip-icon" />
									) : (
										<span className="ip-icon" aria-hidden>
											<FiBox />
										</span>
									)}
									<span className="ip-titles">
										<b className="ip-ellipsis">{r.name}</b>
										<small className="ip-ellipsis">{r.uid}</small>
									</span>
									<span className={`ip-kind ip-kind-${r.kind}`}>
										{r.kind === "ui" ? t("settingsUiPlugins") : t("pluginKindPi")}
									</span>
									<span className="ip-scope">{r.scope}</span>
									<span className={`ip-dot ip-dot-${r.health}`} title={r.health} aria-hidden />
									<button
										type="button"
										className={`ip-switch${r.enabled ? " on" : ""}`}
										disabled={!r.switchable}
										aria-label={r.enabled ? t("pluginPhaseDisabled") : t("pluginPhaseActive")}
										title={r.switchable ? t("pluginsStoreLabel") : t("uiLayoutRequired")}
										onClick={(ev) => {
											ev.stopPropagation();
											if (!r.switchable) return;
											if (r.plugin) onTogglePlugin(r.plugin);
											else if (r.extension) onToggleExtension(r.extension);
										}}
									>
										<i />
									</button>
								</div>
								{open && (
									<div className="ip-body">
										<div className="ip-meta">
											<span className={`ip-kind ip-kind-${r.kind}`}>
												{r.kind === "ui" ? t("settingsUiPlugins") : t("pluginKindPi")}
											</span>
											<code className="ip-ellipsis">{r.uid}</code>
											<span className="ip-ellipsis">
												{t("pluginsStoreLabel")}: {r.kind === "ui" ? "disabledPlugins" : "disabledExtensions"}
											</span>
											<button type="button" className="ip-btn" onClick={() => setExpandedUid(null)}>
												{t("pluginsCollapse")} ▲
											</button>
										</div>
										<div className="ip-tabs">
											{tabsFor(r).map(([key, label]) => (
												<button
													key={key}
													type="button"
													data-ip-tab={key}
													className={`ip-tab${activeTab === key ? " active" : ""}`}
													onClick={() => setDetailTab(key)}
												>
													{label}
												</button>
											))}
										</div>
										<div className="ip-panel-body">{renderDetail(r)}</div>
									</div>
								)}
							</div>
						);
					})
				)}
			</div>
		</div>
	);
}
