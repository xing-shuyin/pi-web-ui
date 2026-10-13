import { useEffect, useMemo, useState } from "react";
import {
	FiAlertTriangle,
	FiCheck,
	FiChevronDown,
	FiChevronUp,
	FiEdit2,
	FiExternalLink,
	FiFolder,
	FiGlobe,
	FiKey,
	FiLayers,
	FiPlus,
	FiRefreshCw,
	FiSearch,
	FiServer,
	FiShoppingBag,
	FiTerminal,
	FiTrash2,
	FiX,
} from "react-icons/fi";
import { appSend } from "../app-globals";
import { CopyButton } from "./copy-button";
import { HintTip } from "./HintTip";
import { isZhLocale, useI18n, useT } from "../i18n";
import type { McpScope, RemoteMcpServer, UiMcpServer, UiMcpToolInfo, UiSettingsState } from "../types";
import type { ChatState } from "../use-chat";
import { PUBLIC_MCP_SERVERS, type PublicMcpServer } from "../mcp-catalog";

export interface McpServersPanelProps {
	settings: UiSettingsState;
	chat: {
		mcpMarketResult?: {
			ok: boolean;
			servers: RemoteMcpServer[];
			total?: number;
			source: string;
			error?: string;
		} | null;
	};
}

interface McpDraft {
	name: string;
	scope: McpScope;
	transport: "stdio" | "http";
	command: string;
	args: string;
	cwd: string;
	env: Array<{ key: string; value: string }>;
	url: string;
	headers: Array<{ key: string; value: string }>;
	timeout: string;
	description: string;
	enabled: boolean;
	isNew: boolean;
	prevName?: string;
	prevScope?: McpScope;
}

interface McpPresetTemplate {
	id: string;
	label: string;
	description: string;
	transport: "stdio" | "http";
	command?: string;
	args?: string;
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
		args: "-y @modelcontextprotocol/server-filesystem .",
	},
	{
		id: "fetch",
		label: "mcpPresetFetch",
		description: "mcpPresetFetchDesc",
		transport: "stdio",
		command: "uvx",
		args: "mcp-server-fetch",
	},
	{
		id: "memory",
		label: "mcpPresetMemory",
		description: "mcpPresetMemoryDesc",
		transport: "stdio",
		command: "npx",
		args: "-y @modelcontextprotocol/server-memory",
	},
	{
		id: "github",
		label: "mcpPresetGithub",
		description: "mcpPresetGithubDesc",
		transport: "stdio",
		command: "npx",
		args: "-y @modelcontextprotocol/server-github",
		env: [{ key: "GITHUB_PERSONAL_ACCESS_TOKEN", value: "" }],
	},
	{
		id: "sqlite",
		label: "mcpPresetSqlite",
		description: "mcpPresetSqliteDesc",
		transport: "stdio",
		command: "uvx",
		args: "mcp-server-sqlite --db-path ./app.db",
	},
];

export function McpServersPanel({ settings, chat }: McpServersPanelProps) {
	const t = useT();
	const { locale } = useI18n();
	const [viewMode, setViewMode] = useState<"configured" | "market">("configured");
	const [scopeFilter, setScopeFilter] = useState<"all" | McpScope>("all");
	const [marketSource, setMarketSource] = useState<string>("smithery");
	const [customSourceUrl, setCustomSourceUrl] = useState<string>("");
	const [marketSearch, setMarketSearch] = useState<string>("");
	const [marketLoading, setMarketLoading] = useState<boolean>(false);
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

	const configuredServerIds = useMemo(() => {
		return new Set(servers.map((s) => s.name.toLowerCase()));
	}, [servers]);

	const fetchMarket = (refresh = false) => {
		const source = marketSource === "custom" ? customSourceUrl.trim() : marketSource;
		if (!source) return;
		setMarketLoading(true);
		appSend({
			type: "fetch_mcp_market",
			source,
			query: marketSearch.trim() || undefined,
			refresh,
		});
	};

	useEffect(() => {
		if (viewMode !== "market") return;
		const source = marketSource === "custom" ? customSourceUrl.trim() : marketSource;
		if (!source) return;
		setMarketLoading(true);
		const timer = setTimeout(() => {
			appSend({
				type: "fetch_mcp_market",
				source,
				query: marketSearch.trim() || undefined,
			});
		}, 350);
		return () => clearTimeout(timer);
	}, [viewMode, marketSource, marketSearch, customSourceUrl]);

	useEffect(() => {
		if (chat.mcpMarketResult) {
			setMarketLoading(false);
		}
	}, [chat.mcpMarketResult]);

	const remoteServers: RemoteMcpServer[] = useMemo(() => {
		if (chat.mcpMarketResult?.ok && chat.mcpMarketResult.servers?.length > 0) {
			return chat.mcpMarketResult.servers;
		}
		// 回退至内置预备列表
		return PUBLIC_MCP_SERVERS.map((s) => ({
			id: s.id,
			name: s.name,
			displayName: isZhLocale(locale) ? s.nameZh : s.name,
			description: isZhLocale(locale) ? s.descriptionZh : s.description,
			homepage: s.homepage,
			package: s.package,
			command: s.command,
			args: s.args,
			transport: s.transport,
			source: "builtin",
			verified: s.official,
		}));
	}, [chat.mcpMarketResult, locale]);

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
			args: preset.args ?? "",
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

	const openFromRemoteMarket = (srv: RemoteMcpServer, scope: McpScope) => {
		const envList: Array<{ key: string; value: string }> = [];
		if (srv.env) {
			for (const [k, v] of Object.entries(srv.env)) {
				envList.push({ key: k, value: String(v) });
			}
		}
		setSelectedPresetId("custom");
		setDraft({
			name: srv.id,
			scope,
			transport: srv.transport || (srv.url ? "http" : "stdio"),
			command: srv.command || (srv.package ? "npx" : "npx"),
			args: srv.args?.length ? srv.args.join(" ") : srv.package ? `-y ${srv.package}` : "",
			cwd: "",
			env: envList,
			url: srv.url || "",
			headers: [],
			timeout: "",
			description: srv.description || "",
			enabled: true,
			isNew: true,
		});
	};

	const openEditServerModal = (s: UiMcpServer) => {
		const envList: Array<{ key: string; value: string }> = [];
		if (s.env) {
			for (const [k, v] of Object.entries(s.env)) {
				envList.push({ key: k, value: String(v) });
			}
		}
		const headerList: Array<{ key: string; value: string }> = [];
		if (s.headers) {
			for (const [k, v] of Object.entries(s.headers)) {
				headerList.push({ key: k, value: String(v) });
			}
		}
		setSelectedPresetId("custom");
		setDraft({
			name: s.name,
			scope: s.scope,
			transport: s.url ? "http" : "stdio",
			command: s.command ?? "",
			args: Array.isArray(s.args) ? s.args.join(" ") : "",
			cwd: s.cwd ?? "",
			env: envList,
			url: s.url ?? "",
			headers: headerList,
			timeout: s.timeout !== undefined ? String(s.timeout) : "",
			description: s.description ?? "",
			enabled: s.enabled !== false,
			isNew: false,
			prevName: s.name,
			prevScope: s.scope,
		});
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
				args: preset.args ?? d.args,
				env: preset.env ? [...preset.env] : d.env,
				url: preset.url ?? d.url,
			};
		});
	};

	const handleSaveDraft = () => {
		if (!draft) return;
		const name = draft.name.trim();
		if (!name) return;

		const envMap: Record<string, string> = {};
		for (const item of draft.env) {
			const k = item.key.trim();
			if (k) envMap[k] = item.value;
		}

		const headerMap: Record<string, string> = {};
		for (const item of draft.headers) {
			const k = item.key.trim();
			if (k) headerMap[k] = item.value;
		}

		const argsArr = draft.args
			.trim()
			.split(/\s+/)
			.filter((x) => x.length > 0);
		const timeoutNum = Number(draft.timeout);

		const server: UiMcpServer = {
			name,
			scope: draft.scope,
			type: draft.transport,
			command: draft.transport === "stdio" ? draft.command.trim() || undefined : undefined,
			args: draft.transport === "stdio" && argsArr.length > 0 ? argsArr : undefined,
			cwd: draft.transport === "stdio" && draft.cwd.trim() ? draft.cwd.trim() : undefined,
			env: draft.transport === "stdio" && Object.keys(envMap).length > 0 ? envMap : undefined,
			url: draft.transport === "http" && draft.url.trim() ? draft.url.trim() : undefined,
			headers: draft.transport === "http" && Object.keys(headerMap).length > 0 ? headerMap : undefined,
			timeout: !isNaN(timeoutNum) && timeoutNum > 0 ? timeoutNum : undefined,
			description: draft.description.trim() || undefined,
			enabled: draft.enabled,
		};

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
			{/* 标题栏 */}
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

			{/* 子页签切换：已配置 vs MCP 市场 */}
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
					<span className="set-count">{PUBLIC_MCP_SERVERS.length}</span>
				</button>
			</div>

			{/* ========================================================= */}
			{/* 1. 已配置服务器视图                                        */}
			{/* ========================================================= */}
			{viewMode === "configured" && (
				<>
					{/* 路径与作用域概览 */}
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

					{/* 服务器卡片列表 */}
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
								const toolsCount = s.tools?.length ?? 0;
								return (
									<div key={cardKey} className={`mcp-server-card${s.enabled ? "" : " disabled"}`}>
										<div className="mcp-card-head">
											<div className="mcp-card-title-group">
												<span className="mcp-server-name">{s.name}</span>
												<span className={`mcp-scope-badge scope-${s.scope}`}>
													{s.scope === "global" ? t("mcpScopeGlobal") : t("mcpScopeProject")}
												</span>
												<span className="mcp-transport-badge">{s.url ? "HTTP" : "stdio"}</span>
												<span className={`mcp-status-pill status-${s.status ?? (s.enabled ? "running" : "stopped")}`}>
													<span className="mcp-status-dot" />
													{s.status === "error"
														? t("mcpStatusError")
														: s.enabled
															? `${t("mcpStatusRunning")}${toolsCount > 0 ? ` (${toolsCount})` : ""}`
															: t("mcpStatusStopped")}
												</span>
											</div>
											<div className="mcp-card-actions">
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

										{/* 命令 / 端点与配置说明 */}
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

											{/* 错误提示 */}
											{s.status === "error" && s.error && (
												<div className="mcp-error-box">
													<FiAlertTriangle className="mcp-error-icon" />
													<div className="mcp-error-text">{s.error}</div>
												</div>
											)}

											{/* 工具列表抽屉 */}
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

			{/* ========================================================= */}
			{/* 2. MCP 市场视图（支持远程 Smithery / GitHub / 自定义 API 源） */}
			{/* ========================================================= */}
			{viewMode === "market" && (
				<div className="mcp-market-view">
					<div className="mcp-market-toolbar">
						{/* 源选择器与自定义输入 */}
						<div className="mcp-market-source-row">
							<div className="mcp-source-select-wrap">
								<label className="mcp-source-label">{t("mcpSourceSelectLabel")}:</label>
								<select
									className="set-select mcp-source-select"
									value={marketSource}
									onChange={(e) => setMarketSource(e.target.value)}
								>
									<option value="smithery">{t("mcpSourceSmithery")}</option>
									<option value="github">{t("mcpSourceGithub")}</option>
									<option value="custom">{t("mcpSourceCustom")}</option>
								</select>
							</div>
							<button
								type="button"
								className={`set-save-btn mcp-sync-btn${marketLoading ? " spinning" : ""}`}
								title={t("mcpReload")}
								onClick={() => fetchMarket(true)}
							>
								<FiRefreshCw />
								<span>{t("mcpReload")}</span>
							</button>
						</div>

						{marketSource === "custom" && (
							<div className="mcp-custom-source-row">
								<input
									type="text"
									className="set-input mcp-custom-input"
									placeholder={t("mcpSourceCustomPlaceholder")}
									value={customSourceUrl}
									onChange={(e) => setCustomSourceUrl(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === "Enter") fetchMarket(true);
									}}
								/>
							</div>
						)}

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
					</div>

					{/* 错误提示 */}
					{chat.mcpMarketResult?.error && (
						<div className="mcp-error-box">
							<FiAlertTriangle className="mcp-error-icon" />
							<div className="mcp-error-text">{chat.mcpMarketResult.error}</div>
							<button type="button" className="mcp-mini-btn" onClick={() => fetchMarket(true)}>
								{t("mcpMarketRetry")}
							</button>
						</div>
					)}

					{/* 加载指示器 */}
					{marketLoading && (
						<div className="mcp-market-loading">
							<FiRefreshCw className="spinning" />
							<span>{t("mcpMarketLoading")}</span>
						</div>
					)}

					{/* 市场服务器卡片网格 */}
					<div className="mcp-market-grid">
						{remoteServers.map((srv) => {
							const isConfigured = configuredServerIds.has(srv.id.toLowerCase());
							return (
								<div key={`${srv.source}-${srv.id}`} className="mcp-market-card">
									<div className="mcp-market-card-head">
										<div className="mcp-market-title-wrap">
											{srv.iconUrl ? (
												<img src={srv.iconUrl} alt="" className="mcp-market-icon-img" />
											) : (
												<FiServer className="mcp-market-icon-fallback" />
											)}
											<span className="mcp-market-name">{srv.displayName || srv.name}</span>
											{srv.displayName && srv.displayName !== srv.name && (
												<span className="mcp-market-subname">({srv.name})</span>
											)}
											{srv.verified && <span className="mcp-badge-official">{t("mcpBadgeOfficial")}</span>}
										</div>
										{srv.homepage && (
											<a
												href={srv.homepage}
												target="_blank"
												rel="noreferrer"
												className="mcp-market-link"
												title={srv.homepage}
											>
												<FiExternalLink />
											</a>
										)}
									</div>

									<p className="mcp-market-desc">{srv.description}</p>

									<div className="mcp-market-pkg">
										<code className="mcp-market-pkg-code">{srv.package || srv.id}</code>
										{typeof srv.downloads === "number" && srv.downloads > 0 && (
											<span className="mcp-downloads-tag">{srv.downloads.toLocaleString()} downloads</span>
										)}
									</div>

									<div className="mcp-market-card-actions">
										{isConfigured && (
											<span className="mcp-market-configured-badge">
												<FiCheck />
												{t("mcpConfigured")}
											</span>
										)}
										<div className="mcp-market-add-btns">
											<button
												type="button"
												className="mcp-btn-add global"
												title={t("mcpAddGlobalHint")}
												onClick={() => openFromRemoteMarket(srv, "global")}
											>
												<FiPlus />
												{t("mcpAddGlobal")}
											</button>
											<button
												type="button"
												className="mcp-btn-add project"
												title={t("mcpAddProjectHint")}
												onClick={() => openFromRemoteMarket(srv, "project")}
											>
												<FiPlus />
												{t("mcpAddProject")}
											</button>
										</div>
									</div>
								</div>
							);
						})}
					</div>
				</div>
			)}

			{/* ========================================================= */}
			{/* 3. 删除确认弹窗                                           */}
			{/* ========================================================= */}
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

			{/* ========================================================= */}
			{/* 4. 新增 / 编辑弹窗                                        */}
			{/* ========================================================= */}
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
							{/* 预设模板选择（仅新建时快捷填入） */}
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

							{/* 作用域选择 */}
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

							{/* 服务器名称 */}
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

							{/* 传输协议 */}
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

							{/* stdio 表单字段 */}
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
										<label className="set-field-label">{t("mcpArgsLabel")}</label>
										<textarea
											className="set-input mcp-args-input"
											rows={2}
											placeholder={t("mcpArgsPlaceholder")}
											value={draft.args}
											onChange={(e) => setDraft((d) => (d ? { ...d, args: e.target.value } : null))}
										/>
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
								/* HTTP 表单字段 */
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

							{/* 描述与说明 */}
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

							{/* 启用开关 */}
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
