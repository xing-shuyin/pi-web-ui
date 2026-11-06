import { useEffect, useMemo, useState } from "react";
import { randomUuid } from "../uuid";
import {
	FiAlertTriangle,
	FiCheck,
	FiChevronDown,
	FiChevronUp,
	FiEdit2,
	FiExternalLink,
	FiFolder,
	FiGlobe,
	FiLayers,
	FiPlus,
	FiRefreshCw,
	FiSearch,
	FiServer,
	FiShare2,
	FiShoppingBag,
	FiTerminal,
	FiTrash2,
	FiX,
} from "react-icons/fi";
import { appSend } from "../app-globals";
import { CopyButton } from "./copy-button";
import { HintTip } from "./HintTip";
import { isZhLocale, useI18n, useT } from "../i18n";
import type { McpScope, UiMcpServer, UiMcpToolInfo, UiSettingsState } from "../types";
import { MCP_MARKETS } from "../mcp-catalog";
import { createMcpDraft, getMcpServerDisplayState, serializeMcpDraft, type McpDraft } from "../mcp-server-draft";

export type McpMarketCategoryFilter = "all" | "cn" | "marketplace" | "community" | "official";

export interface McpServersPanelProps {
	settings: UiSettingsState;
	chat?: {
		mcpOAuthResult?: Extract<import("../types").ServerMessage, { type: "mcp_oauth_result" }> | null;
		mcpMarketResult?: {
			ok: boolean;
			servers?: unknown[];
			total?: number;
			source?: string;
			error?: string;
		} | null;
	};
}

interface McpPresetTemplate {
	id: string;
	label: string;
	description: string;
	transport: "stdio" | "http";
	command?: string;
	args?: string[];
	env?: Array<{ key: string; value: string }>;
	url?: string;
}

const MCP_PRESETS: McpPresetTemplate[] = [
	{
		id: "custom",
		label: "mcpPresetCustom",
		description: "mcpPresetCustomDesc",
		transport: "stdio",
	},
	{
		id: "filesystem",
		label: "mcpPresetFilesystem",
		description: "mcpPresetFilesystemDesc",
		transport: "stdio",
		command: "npx",
		args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
	},
	{
		id: "fetch",
		label: "mcpPresetFetch",
		description: "mcpPresetFetchDesc",
		transport: "stdio",
		command: "uvx",
		args: ["mcp-server-fetch"],
	},
	{
		id: "memory",
		label: "mcpPresetMemory",
		description: "mcpPresetMemoryDesc",
		transport: "stdio",
		command: "npx",
		args: ["-y", "@modelcontextprotocol/server-memory"],
	},
	{
		id: "github",
		label: "mcpPresetGithub",
		description: "mcpPresetGithubDesc",
		transport: "stdio",
		command: "npx",
		args: ["-y", "@modelcontextprotocol/server-github"],
		env: [{ key: "GITHUB_PERSONAL_ACCESS_TOKEN", value: "" }],
	},
	{
		id: "sqlite",
		label: "mcpPresetSqlite",
		description: "mcpPresetSqliteDesc",
		transport: "stdio",
		command: "uvx",
		args: ["mcp-server-sqlite", "--db-path", "./app.db"],
	},
];

export function McpServersPanel({ settings, chat }: McpServersPanelProps) {
	const t = useT();
	const [login, setLogin] = useState<{ reqId: string; name: string } | null>(null);
	const [redirectUrl, setRedirectUrl] = useState("");
	const [finishing, setFinishing] = useState(false);
	const result = chat?.mcpOAuthResult?.reqId === login?.reqId ? chat?.mcpOAuthResult : null;
	useEffect(() => {
		if (!login) return;
		return () => {
			appSend({ type: "mcp_oauth_cancel", reqId: login.reqId });
		};
	}, [login]);
	useEffect(() => {
		if (!login || !result?.id || result.status !== "pending") return;
		const id = result.id;
		const timer = window.setInterval(() => appSend({ type: "mcp_oauth_status", reqId: login.reqId, id }), 1500);
		return () => window.clearInterval(timer);
	}, [login, result?.id, result?.status]);
	useEffect(() => {
		if (result?.status === "complete" || result?.status === "error" || result?.error) {
			setFinishing(false);
			setRedirectUrl("");
		}
	}, [result]);
	const closeLogin = () => {
		setLogin(null);
		setRedirectUrl("");
		setFinishing(false);
	};
	const startLogin = (server: UiMcpServer) => {
		const reqId = randomUuid();
		setLogin({ reqId, name: server.name });
		setRedirectUrl("");
		setFinishing(false);
		appSend({ type: "mcp_oauth_start", reqId, name: server.name, scope: server.scope });
	};
	const { locale } = useI18n();
	const [viewMode, setViewMode] = useState<"configured" | "market">("configured");
	const [scopeFilter, setScopeFilter] = useState<"all" | McpScope>("all");
	const [marketCategory, setMarketCategory] = useState<McpMarketCategoryFilter>("all");
	const [marketSearch, setMarketSearch] = useState<string>("");
	const [copiedMarketId, setCopiedMarketId] = useState<string | null>(null);
	const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({});
	const [reloading, setReloading] = useState(false);
	const [draft, setDraft] = useState<McpDraft | null>(null);
	const [deleteConfirm, setDeleteConfirm] = useState<{ name: string; scope: McpScope } | null>(null);
	const [selectedPresetId, setSelectedPresetId] = useState<string>("custom");

	const servers: UiMcpServer[] = settings.mcpServers ?? [];
	const globalPath = settings.mcpGlobalConfigPath || "";
	const projectPath = settings.mcpProjectConfigPath || "";

	const filteredServers = useMemo(() => {
		if (scopeFilter === "all") return servers;
		return servers.filter((s) => s.scope === scopeFilter);
	}, [servers, scopeFilter]);

	const handleCopyMarketUrl = (id: string, url: string) => {
		navigator.clipboard.writeText(url).then(
			() => {
				setCopiedMarketId(id);
				setTimeout(() => setCopiedMarketId(null), 1500);
			},
			() => {},
		);
	};

	const filteredMcpMarkets = useMemo(() => {
		const q = marketSearch.trim().toLowerCase();
		return MCP_MARKETS.filter((item) => {
			if (marketCategory === "cn" && item.region !== "cn") return false;
			if (marketCategory === "marketplace" && item.category !== "marketplace") return false;
			if (marketCategory === "community" && item.category !== "community") return false;
			if (marketCategory === "official" && item.category !== "official" && item.category !== "directory") {
				return false;
			}

			if (!q) return true;
			const matchName = item.name.toLowerCase().includes(q) || item.nameZh.toLowerCase().includes(q);
			const matchDesc = item.description.toLowerCase().includes(q) || item.descriptionZh.toLowerCase().includes(q);
			const matchUrl = item.url.toLowerCase().includes(q);
			const matchTags = item.tags?.some((t) => t.toLowerCase().includes(q));
			return matchName || matchDesc || matchUrl || matchTags;
		});
	}, [marketCategory, marketSearch]);

	const globalCount = useMemo(() => servers.filter((s) => s.scope === "global").length, [servers]);
	const projectCount = useMemo(() => servers.filter((s) => s.scope === "project").length, [servers]);

	const handleReload = () => {
		setReloading(true);
		appSend({ type: "reload_mcp" });
		setTimeout(() => setReloading(false), 800);
	};

	const handleToggle = (s: UiMcpServer) => {
		appSend({
			type: "toggle_mcp_server",
			name: s.name,
			scope: s.scope,
			enabled: !s.enabled,
		});
	};

	const handleDelete = (name: string, scope: McpScope) => {
		appSend({
			type: "delete_mcp_server",
			name,
			scope,
		});
		setDeleteConfirm(null);
	};

	const toggleToolsExpand = (key: string) => {
		setExpandedTools((prev) => ({ ...prev, [key]: !prev[key] }));
	};

	const openNewServerModal = (scope: McpScope = "global", presetId = "custom") => {
		const preset = MCP_PRESETS.find((p) => p.id === presetId) || MCP_PRESETS[0];
		setSelectedPresetId(preset.id);
		setDraft({
			name: preset.id === "custom" ? "" : preset.id,
			scope,
			transport: preset.transport,
			command: preset.command ?? "",
			args: [...(preset.args ?? [])],
			cwd: "",
			env: preset.env ? [...preset.env] : [],
			url: preset.url ?? "",
			headers: [],
			timeout: "",
			description: "",
			enabled: true,
			isNew: true,
		});
	};

	const openEditServerModal = (s: UiMcpServer) => {
		setSelectedPresetId("custom");
		setDraft(createMcpDraft(s));
	};

	const handleApplyPreset = (presetId: string) => {
		setSelectedPresetId(presetId);
		const preset = MCP_PRESETS.find((p) => p.id === presetId);
		if (!preset || !draft) return;
		if (presetId === "custom") return;
		setDraft((d) => {
			if (!d) return null;
			return {
				...d,
				name: d.name ? d.name : preset.id,
				transport: preset.transport,
				command: preset.command ?? d.command,
				args: preset.args ? [...preset.args] : d.args,
				env: preset.env ? [...preset.env] : d.env,
				url: preset.url ?? d.url,
			};
		});
	};

	const handleSaveDraft = () => {
		if (!draft) return;
		const name = draft.name.trim();
		if (!name) return;

		const server = serializeMcpDraft(draft);

		appSend({
			type: "save_mcp_server",
			server,
			prevName: draft.isNew ? undefined : draft.prevName,
			prevScope: draft.isNew ? undefined : draft.prevScope,
		});

		setDraft(null);
	};

	return (
		<div className="set-section mcp-section">
			<div className="set-section-title">
				<FiServer className="set-section-icon" />
				{t("settingsMcp")}
				<HintTip text={t("settingsMcpDesc")} />
				<span className="set-count">{servers.length}</span>
				<div className="mcp-title-actions">
					<button
						type="button"
						className={`set-save-btn mcp-reload-btn${reloading ? " spinning" : ""}`}
						title={t("mcpReload")}
						onClick={handleReload}
					>
						<FiRefreshCw />
						<span>{t("mcpReload")}</span>
					</button>
					<button
						type="button"
						className="set-save-btn mcp-add-btn"
						title={t("mcpAddServer")}
						onClick={() => openNewServerModal(scopeFilter === "project" ? "project" : "global")}
					>
						<FiPlus />
						<span>{t("mcpAddServer")}</span>
					</button>
				</div>
			</div>

			<div className="mcp-tab-bar">
				<button
					type="button"
					className={`mcp-tab-btn${viewMode === "configured" ? " active" : ""}`}
					onClick={() => setViewMode("configured")}
				>
					<FiServer />
					<span>{t("mcpTabConfigured")}</span>
					<span className="set-count">{servers.length}</span>
				</button>
				<button
					type="button"
					className={`mcp-tab-btn${viewMode === "market" ? " active" : ""}`}
					onClick={() => setViewMode("market")}
				>
					<FiShoppingBag />
					<span>{t("mcpTabMarket")}</span>
					<span className="set-count">{MCP_MARKETS.length}</span>
				</button>
			</div>

			{viewMode === "configured" && (
				<>
					<div className="mcp-meta-card">
						<div className="mcp-scope-filter">
							<button
								type="button"
								className={`mcp-scope-btn${scopeFilter === "all" ? " active" : ""}`}
								onClick={() => setScopeFilter("all")}
							>
								{t("mcpFilterAll")}
								<span className="mcp-filter-count">{servers.length}</span>
							</button>
							<button
								type="button"
								className={`mcp-scope-btn${scopeFilter === "global" ? " active" : ""}`}
								onClick={() => setScopeFilter("global")}
							>
								{t("mcpFilterGlobal")}
								<span className="mcp-filter-count">{globalCount}</span>
							</button>
							<button
								type="button"
								className={`mcp-scope-btn${scopeFilter === "project" ? " active" : ""}`}
								onClick={() => setScopeFilter("project")}
							>
								{t("mcpFilterProject")}
								<span className="mcp-filter-count">{projectCount}</span>
							</button>
						</div>
						<div className="mcp-paths-summary">
							{globalPath && (
								<div className="mcp-path-row">
									<span className="mcp-path-label">{t("mcpGlobalPath")}:</span>
									<code className="mcp-path-text" title={globalPath}>
										{globalPath}
									</code>
									<CopyButton text={globalPath} />
								</div>
							)}
							{projectPath && (
								<div className="mcp-path-row">
									<span className="mcp-path-label">{t("mcpProjectPath")}:</span>
									<code className="mcp-path-text" title={projectPath}>
										{projectPath}
									</code>
									<CopyButton text={projectPath} />
								</div>
							)}
						</div>
					</div>

					{filteredServers.length === 0 ? (
						<div className="mcp-empty-card">
							<div className="mcp-empty-icon">
								<FiServer />
							</div>
							<div className="mcp-empty-title">{t("mcpEmptyTitle")}</div>
							<div className="mcp-empty-desc">{t("mcpEmptyDesc")}</div>
							<div className="mcp-empty-quick-presets">
								<button type="button" className="mcp-goto-market-btn" onClick={() => setViewMode("market")}>
									<FiShoppingBag />
									{t("mcpBrowseMarket")}
								</button>
								<span className="mcp-quick-label">{t("mcpQuickAdd")}:</span>
								{MCP_PRESETS.filter((p) => p.id !== "custom").map((p) => (
									<button
										key={p.id}
										type="button"
										className="mcp-quick-btn"
										onClick={() => openNewServerModal("global", p.id)}
									>
										<FiPlus />
										{t(p.label as Parameters<typeof t>[0])}
									</button>
								))}
							</div>
						</div>
					) : (
						<div className="mcp-servers-list">
							{filteredServers.map((s) => {
								const cardKey = `${s.scope}:${s.name}`;
								const isExpanded = !!expandedTools[cardKey];
								const { status, label, toolsCount } = getMcpServerDisplayState(s);
								return (
									<div key={cardKey} className={`mcp-server-card${s.enabled ? "" : " disabled"}`}>
										<div className="mcp-card-head">
											<div className="mcp-card-title-group">
												<span className="mcp-server-name">{s.name}</span>
												<span className={`mcp-scope-badge scope-${s.scope}`}>
													{s.scope === "global" ? t("mcpScopeGlobal") : t("mcpScopeProject")}
												</span>
												<span className="mcp-transport-badge">{s.url ? "HTTP" : "stdio"}</span>
												<span className={`mcp-status-pill status-${status}`}>
													<span className="mcp-status-dot" />
													{t(label)}
													{status === "running" && toolsCount > 0 ? ` (${toolsCount})` : ""}
												</span>
											</div>
											<div className="mcp-card-actions">
												{s.url && (
													<button
														type="button"
														className="mcp-quick-btn"
														disabled={!!login}
														onClick={() => startLogin(s)}
													>
														{t("mcpOAuthLogin")}
													</button>
												)}
												<button
													type="button"
													role="switch"
													aria-checked={s.enabled}
													className={`set-switch${s.enabled ? " on" : ""}`}
													title={s.enabled ? t("mcpDisableHint") : t("mcpEnableHint")}
													onClick={() => handleToggle(s)}
												>
													<span className="set-switch-knob" />
												</button>
												<button
													type="button"
													className="icon-btn mcp-action-btn"
													title={t("edit")}
													onClick={() => openEditServerModal(s)}
												>
													<FiEdit2 />
												</button>
												<button
													type="button"
													className="icon-btn mcp-action-btn delete-btn"
													title={t("delete")}
													onClick={() => setDeleteConfirm({ name: s.name, scope: s.scope })}
												>
													<FiTrash2 />
												</button>
											</div>
										</div>

										<div className="mcp-card-body">
											{s.description && <div className="mcp-server-desc">{s.description}</div>}

											<div className="mcp-spec-line">
												{s.url ? (
													<div className="mcp-spec-http">
														<FiGlobe className="mcp-spec-icon" />
														<code className="mcp-spec-code">{s.url}</code>
													</div>
												) : (
													<div className="mcp-spec-cmd">
														<FiTerminal className="mcp-spec-icon" />
														<code className="mcp-spec-code">
															{s.command} {s.args?.join(" ")}
														</code>
													</div>
												)}
											</div>

											{s.cwd && (
												<div className="mcp-spec-detail">
													<FiFolder className="mcp-detail-icon" />
													<span className="mcp-detail-label">cwd:</span>
													<code>{s.cwd}</code>
												</div>
											)}

											{s.env && Object.keys(s.env).length > 0 && (
												<div className="mcp-spec-detail">
													<span className="mcp-detail-label">env:</span>
													<span className="mcp-env-tags">
														{Object.keys(s.env).map((k) => (
															<span key={k} className="mcp-env-tag">
																{k}
															</span>
														))}
													</span>
												</div>
											)}

											{s.error && (
												<div className="mcp-error-box">
													<FiAlertTriangle className="mcp-error-icon" />
													<div className="mcp-error-text">{s.error}</div>
												</div>
											)}

											{toolsCount > 0 && (
												<div className="mcp-tools-accordion">
													<button type="button" className="mcp-tools-toggle" onClick={() => toggleToolsExpand(cardKey)}>
														<FiLayers className="mcp-tools-icon" />
														<span>{t("mcpToolsCount", { count: toolsCount })}</span>
														{isExpanded ? <FiChevronUp /> : <FiChevronDown />}
													</button>
													{isExpanded && (
														<div className="mcp-tools-content">
															{s.tools?.map((tool: UiMcpToolInfo) => (
																<div key={tool.name} className="mcp-tool-item">
																	<span className="mcp-tool-name">{tool.name}</span>
																	{tool.description && <span className="mcp-tool-desc">{tool.description}</span>}
																</div>
															))}
														</div>
													)}
												</div>
											)}
										</div>
									</div>
								);
							})}
						</div>
					)}
				</>
			)}

			{viewMode === "market" && (
				<div className="mcp-market-view skill-market-view">
					<div className="mcp-market-toolbar">
						<div className="mcp-search-wrap">
							<FiSearch className="mcp-search-icon" />
							<input
								type="text"
								className="set-input mcp-search-input"
								placeholder={t("mcpMarketSearchPlaceholder")}
								value={marketSearch}
								onChange={(e) => setMarketSearch(e.target.value)}
							/>
							{marketSearch && (
								<button type="button" className="mcp-search-clear" onClick={() => setMarketSearch("")}>
									<FiX />
								</button>
							)}
						</div>
						<div className="mcp-category-chips">
							{[
								{ id: "all", label: `${t("mcpCatAll")} (${MCP_MARKETS.length})` },
								{
									id: "cn",
									label: `${t("mcpCatCn")} (${MCP_MARKETS.filter((m) => m.region === "cn").length})`,
								},
								{
									id: "marketplace",
									label: `${t("mcpCatMarketplace")} (${MCP_MARKETS.filter((m) => m.category === "marketplace").length})`,
								},
								{
									id: "community",
									label: `${t("mcpCatCommunity")} (${MCP_MARKETS.filter((m) => m.category === "community").length})`,
								},
								{
									id: "official",
									label: `${t("mcpCatOfficial")} (${MCP_MARKETS.filter((m) => m.category === "official" || m.category === "directory").length})`,
								},
							].map((cat) => (
								<button
									key={cat.id}
									type="button"
									className={`mcp-cat-chip${marketCategory === cat.id ? " active" : ""}`}
									onClick={() => setMarketCategory(cat.id as McpMarketCategoryFilter)}
								>
									{cat.label}
								</button>
							))}
						</div>
					</div>

					{filteredMcpMarkets.length === 0 ? (
						<div className="mcp-empty-card">
							<div className="mcp-empty-icon">
								<FiSearch />
							</div>
							<div className="mcp-empty-title">{t("mcpMarketEmpty")}</div>
							<button
								type="button"
								className="mcp-mini-btn"
								onClick={() => {
									setMarketSearch("");
									setMarketCategory("all");
								}}
							>
								{t("mcpMarketEmptyClear")}
							</button>
						</div>
					) : (
						<div className="mcp-market-grid">
							{filteredMcpMarkets.map((market) => {
								const descText = isZhLocale(locale) ? market.descriptionZh : market.description;
								const badgeText = isZhLocale(locale) ? market.badgeZh || market.badge : market.badge || market.badgeZh;

								return (
									<div key={market.id} className="mcp-market-card skill-market-card">
										<div className="mcp-market-card-head">
											<div className="mcp-market-title-wrap">
												<span className="mcp-market-name">{market.name}</span>
												{isZhLocale(locale) && market.nameZh !== market.name && (
													<span className="mcp-market-subname">({market.nameZh})</span>
												)}
											</div>
											{badgeText && <span className="mcp-badge-official">{badgeText}</span>}
										</div>

										<p className="mcp-market-desc">{descText}</p>

										<div className="skill-market-url-row" title={market.url}>
											<FiGlobe className="skill-market-url-icon" />
											<span className="skill-market-url-text">{market.url}</span>
										</div>

										{market.tags && market.tags.length > 0 && (
											<div className="skill-market-tags">
												{market.tags.map((tag) => (
													<span key={tag} className="skill-market-tag-chip">
														#{tag}
													</span>
												))}
											</div>
										)}

										<div className="skill-market-card-actions">
											<button
												type="button"
												className="skill-market-copy-btn"
												title={market.url}
												onClick={() => handleCopyMarketUrl(market.id, market.url)}
											>
												{copiedMarketId === market.id ? (
													<>
														<FiCheck />
														<span>{t("mcpMarketCopied")}</span>
													</>
												) : (
													<>
														<FiShare2 />
														<span>{t("mcpMarketCopyLink")}</span>
													</>
												)}
											</button>
											<a
												href={market.url}
												target="_blank"
												rel="noopener noreferrer"
												className="skill-market-open-btn"
												title={t("mcpMarketVisit")}
											>
												<span>{t("mcpMarketVisit")}</span>
												<FiExternalLink />
											</a>
										</div>
									</div>
								);
							})}
						</div>
					)}
				</div>
			)}

			{login && (
				<div className="modal-backdrop sub-modal" onClick={closeLogin}>
					<div
						className="modal mcp-edit-modal"
						role="dialog"
						aria-modal="true"
						aria-labelledby="mcp-oauth-title"
						onClick={(e) => e.stopPropagation()}
						onKeyDown={(e) => {
							if (e.key === "Escape") {
								e.stopPropagation();
								closeLogin();
							}
						}}
					>
						<div className="modal-head">
							<h3 id="mcp-oauth-title">
								{t("mcpOAuthLogin")} · {login.name}
							</h3>
						</div>
						<div className="modal-body">
							{!result && <p role="status">{t("mcpOAuthStarting")}</p>}
							{result?.status === "complete" && <p role="status">{t("mcpOAuthComplete")}</p>}
							{result?.status === "error" && <p role="alert">{t("mcpOAuthError")}</p>}
							{result?.status === "pending" && (
								<>
									<p>{t("mcpOAuthInstructions")}</p>
									{result.authorizationUrl && (
										<a
											className="mcp-quick-btn"
											href={result.authorizationUrl}
											target="_blank"
											rel="noopener noreferrer"
										>
											{t("mcpOAuthOpen")} <FiExternalLink />
										</a>
									)}
									<p role="status">{finishing ? t("mcpOAuthFinishing") : t("mcpOAuthWaiting")}</p>
									{result.error && <p role="alert">{t("mcpOAuthInvalidRedirect")}</p>}
									<label htmlFor="mcp-oauth-redirect">{t("mcpOAuthRedirect")}</label>
									<input
										id="mcp-oauth-redirect"
										className="set-input"
										type="url"
										autoComplete="off"
										spellCheck={false}
										value={redirectUrl}
										disabled={finishing}
										onChange={(e) => setRedirectUrl(e.target.value)}
									/>
								</>
							)}
						</div>
						<div className="modal-actions">
							<button type="button" className="set-cancel-btn" onClick={closeLogin}>
								{result?.status === "complete" || result?.status === "error" ? t("close") : t("cancel")}
							</button>
							{result?.status === "pending" && (
								<button
									type="button"
									className="btn primary"
									disabled={finishing || !redirectUrl.trim() || !result.id}
									onClick={() => {
										if (!result.id) return;
										setFinishing(true);
										appSend({
											type: "mcp_oauth_finish",
											reqId: login.reqId,
											id: result.id,
											redirectUrl: redirectUrl.trim(),
										});
										setRedirectUrl("");
									}}
								>
									{t("mcpOAuthFinish")}
								</button>
							)}
						</div>
					</div>
				</div>
			)}
			{deleteConfirm && (
				<div className="modal-backdrop sub-modal" onClick={() => setDeleteConfirm(null)}>
					<div className="modal confirm-modal" onClick={(e) => e.stopPropagation()}>
						<div className="modal-head">
							<FiAlertTriangle className="modal-head-icon" />
							<h3>{t("mcpDeleteConfirmTitle")}</h3>
						</div>
						<div className="modal-body">
							<p>
								{t("mcpDeleteConfirmDesc", {
									name: deleteConfirm.name,
									scope: deleteConfirm.scope === "global" ? t("mcpScopeGlobal") : t("mcpScopeProject"),
								})}
							</p>
						</div>
						<div className="modal-actions">
							<button type="button" className="set-cancel-btn" onClick={() => setDeleteConfirm(null)}>
								{t("cancel")}
							</button>
							<button
								type="button"
								className="btn-danger"
								onClick={() => handleDelete(deleteConfirm.name, deleteConfirm.scope)}
							>
								{t("delete")}
							</button>
						</div>
					</div>
				</div>
			)}

			{draft && (
				<div className="modal-backdrop sub-modal" onClick={() => setDraft(null)}>
					<div className="modal mcp-edit-modal" onClick={(e) => e.stopPropagation()}>
						<button type="button" className="modal-close" aria-label={t("close")} onClick={() => setDraft(null)}>
							<FiX />
						</button>
						<div className="modal-head">
							<FiServer className="modal-head-icon" />
							<h3>{draft.isNew ? t("mcpAddModalTitle") : t("mcpEditModalTitle")}</h3>
						</div>

						<div className="modal-body mcp-form-body">
							{draft.isNew && (
								<div className="set-field">
									<label className="set-field-label">{t("mcpPresetSelect")}</label>
									<select
										className="set-select"
										value={selectedPresetId}
										onChange={(e) => handleApplyPreset(e.target.value)}
									>
										{MCP_PRESETS.map((p) => (
											<option key={p.id} value={p.id}>
												{t(p.label as Parameters<typeof t>[0])}
											</option>
										))}
									</select>
								</div>
							)}

							<div className="set-field">
								<label className="set-field-label">
									{t("mcpScopeLabel")}
									<span className="field-required">*</span>
								</label>
								<div className="mcp-scope-selector">
									<label className={`mcp-scope-radio${draft.scope === "global" ? " selected" : ""}`}>
										<input
											type="radio"
											name="scope"
											checked={draft.scope === "global"}
											onChange={() => setDraft((d) => (d ? { ...d, scope: "global" } : null))}
										/>
										<div className="mcp-radio-content">
											<div className="mcp-radio-title">{t("mcpScopeGlobal")}</div>
											<div className="mcp-radio-hint">{t("mcpScopeGlobalHint")}</div>
										</div>
									</label>
									<label className={`mcp-scope-radio${draft.scope === "project" ? " selected" : ""}`}>
										<input
											type="radio"
											name="scope"
											checked={draft.scope === "project"}
											onChange={() => setDraft((d) => (d ? { ...d, scope: "project" } : null))}
										/>
										<div className="mcp-radio-content">
											<div className="mcp-radio-title">{t("mcpScopeProject")}</div>
											<div className="mcp-radio-hint">{t("mcpScopeProjectHint")}</div>
										</div>
									</label>
								</div>
							</div>

							<div className="set-field">
								<label className="set-field-label">
									{t("mcpNameLabel")}
									<span className="field-required">*</span>
								</label>
								<input
									type="text"
									className="set-input"
									placeholder={t("mcpNamePlaceholder")}
									value={draft.name}
									onChange={(e) => setDraft((d) => (d ? { ...d, name: e.target.value } : null))}
								/>
							</div>

							<div className="set-field">
								<label className="set-field-label">{t("mcpTransportLabel")}</label>
								<div className="mcp-transport-selector">
									<button
										type="button"
										className={`mcp-transport-btn${draft.transport === "stdio" ? " active" : ""}`}
										onClick={() => setDraft((d) => (d ? { ...d, transport: "stdio" } : null))}
									>
										<FiTerminal />
										stdio ({t("mcpTransportStdio")})
									</button>
									<button
										type="button"
										className={`mcp-transport-btn${draft.transport === "http" ? " active" : ""}`}
										onClick={() => setDraft((d) => (d ? { ...d, transport: "http" } : null))}
									>
										<FiGlobe />
										HTTP ({t("mcpTransportHttp")})
									</button>
								</div>
							</div>

							{draft.transport === "stdio" ? (
								<>
									<div className="set-field">
										<label className="set-field-label">
											{t("mcpCommandLabel")}
											<span className="field-required">*</span>
										</label>
										<input
											type="text"
											className="set-input"
											placeholder={t("mcpCommandPlaceholder")}
											value={draft.command}
											onChange={(e) => setDraft((d) => (d ? { ...d, command: e.target.value } : null))}
										/>
									</div>

									<div className="set-field">
										<div className="mcp-field-header">
											<label className="set-field-label">{t("mcpArgsLabel")}</label>
											<button
												type="button"
												className="mcp-mini-btn"
												aria-label={`${t("mcpArgsLabel")} +`}
												onClick={() => setDraft((d) => (d ? { ...d, args: [...d.args, ""] } : null))}
											>
												<FiPlus />
											</button>
										</div>
										{draft.args.map((arg, index) => (
											<div className="mcp-kv-row" key={index}>
												<textarea
													className="set-input"
													rows={1}
													aria-label={`${t("mcpArgsLabel")} ${index + 1}`}
													value={arg}
													onChange={(e) =>
														setDraft((d) =>
															d
																? { ...d, args: d.args.map((value, i) => (i === index ? e.target.value : value)) }
																: null,
														)
													}
												/>
												<button
													type="button"
													className="mcp-mini-btn"
													aria-label={`${t("delete")} ${t("mcpArgsLabel")} ${index + 1}`}
													onClick={() =>
														setDraft((d) => (d ? { ...d, args: d.args.filter((_, i) => i !== index) } : null))
													}
												>
													<FiX />
												</button>
											</div>
										))}
									</div>

									<div className="set-field">
										<label className="set-field-label">{t("mcpCwdLabel")}</label>
										<input
											type="text"
											className="set-input"
											placeholder={t("mcpCwdPlaceholder")}
											value={draft.cwd}
											onChange={(e) => setDraft((d) => (d ? { ...d, cwd: e.target.value } : null))}
										/>
									</div>

									<div className="set-field">
										<div className="mcp-field-header">
											<label className="set-field-label">{t("mcpEnvLabel")}</label>
											<button
												type="button"
												className="mcp-mini-btn"
												onClick={() => setDraft((d) => (d ? { ...d, env: [...d.env, { key: "", value: "" }] } : null))}
											>
												<FiPlus />
												{t("mcpAddEnv")}
											</button>
										</div>
										{draft.env.map((item, idx) => (
											<div key={idx} className="mcp-kv-row">
												<input
													type="text"
													className="set-input mcp-kv-key"
													placeholder={t("mcpEnvKeyPlaceholder")}
													value={item.key}
													onChange={(e) => {
														const next = [...draft.env];
														next[idx].key = e.target.value;
														setDraft((d) => (d ? { ...d, env: next } : null));
													}}
												/>
												<input
													type="text"
													className="set-input mcp-kv-val"
													placeholder={t("mcpEnvValuePlaceholder")}
													value={item.value}
													onChange={(e) => {
														const next = [...draft.env];
														next[idx].value = e.target.value;
														setDraft((d) => (d ? { ...d, env: next } : null));
													}}
												/>
												<button
													type="button"
													className="icon-btn delete-btn"
													onClick={() => {
														const next = draft.env.filter((_, i) => i !== idx);
														setDraft((d) => (d ? { ...d, env: next } : null));
													}}
												>
													<FiTrash2 />
												</button>
											</div>
										))}
									</div>
								</>
							) : (
								<>
									<div className="set-field">
										<label className="set-field-label">
											{t("mcpUrlLabel")}
											<span className="field-required">*</span>
										</label>
										<input
											type="text"
											className="set-input"
											placeholder={t("mcpUrlPlaceholder")}
											value={draft.url}
											onChange={(e) => setDraft((d) => (d ? { ...d, url: e.target.value } : null))}
										/>
									</div>

									<div className="set-field">
										<div className="mcp-field-header">
											<label className="set-field-label">{t("mcpHeadersLabel")}</label>
											<button
												type="button"
												className="mcp-mini-btn"
												onClick={() =>
													setDraft((d) => (d ? { ...d, headers: [...d.headers, { key: "", value: "" }] } : null))
												}
											>
												<FiPlus />
												{t("mcpAddHeader")}
											</button>
										</div>
										{draft.headers.map((item, idx) => (
											<div key={idx} className="mcp-kv-row">
												<input
													type="text"
													className="set-input mcp-kv-key"
													placeholder={t("mcpHeaderKeyPlaceholder")}
													value={item.key}
													onChange={(e) => {
														const next = [...draft.headers];
														next[idx].key = e.target.value;
														setDraft((d) => (d ? { ...d, headers: next } : null));
													}}
												/>
												<input
													type="text"
													className="set-input mcp-kv-val"
													placeholder={t("mcpHeaderValuePlaceholder")}
													value={item.value}
													onChange={(e) => {
														const next = [...draft.headers];
														next[idx].value = e.target.value;
														setDraft((d) => (d ? { ...d, headers: next } : null));
													}}
												/>
												<button
													type="button"
													className="icon-btn delete-btn"
													onClick={() => {
														const next = draft.headers.filter((_, i) => i !== idx);
														setDraft((d) => (d ? { ...d, headers: next } : null));
													}}
												>
													<FiTrash2 />
												</button>
											</div>
										))}
									</div>
								</>
							)}

							<div className="set-field">
								<label className="set-field-label">{t("mcpDescriptionLabel")}</label>
								<input
									type="text"
									className="set-input"
									placeholder={t("mcpDescriptionPlaceholder")}
									value={draft.description}
									onChange={(e) => setDraft((d) => (d ? { ...d, description: e.target.value } : null))}
								/>
							</div>

							<div className="set-row">
								<div className="set-row-text">
									<div className="set-row-label">{t("mcpEnabledLabel")}</div>
									<div className="set-row-desc">{t("mcpEnabledDesc")}</div>
								</div>
								<button
									type="button"
									role="switch"
									aria-checked={draft.enabled}
									className={`set-switch${draft.enabled ? " on" : ""}`}
									onClick={() => setDraft((d) => (d ? { ...d, enabled: !d.enabled } : null))}
								>
									<span className="set-switch-knob" />
								</button>
							</div>
						</div>

						<div className="modal-actions">
							<button type="button" className="set-cancel-btn" onClick={() => setDraft(null)}>
								{t("cancel")}
							</button>
							<button
								type="button"
								className="set-save-btn"
								disabled={
									!draft.name.trim() ||
									(draft.transport === "stdio" && !draft.command.trim()) ||
									(draft.transport === "http" && !draft.url.trim())
								}
								onClick={handleSaveDraft}
							>
								<FiCheck />
								<span>{t("save")}</span>
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
