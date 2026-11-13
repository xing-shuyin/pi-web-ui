// #885 统一清单展示：健康 + 搜索过滤（纯前端，不过滤即全量）
// 中英双语直写（避开 884 正在改的 i18n 文件），挂在设置页 extensions tab 顶部。
// - 来源徽标：CLI / WebUI / 外部，启用状态，健康状态（在线/异常/离线/已停用/未知），描述
// - 统一启停：WebUI 走 disabledPlugins；CLI 走 disabledExtensions（内置隐藏置灰+说明原因）；MCP 走 toggle_mcp_server
// - 错误详情：展示 error 原文 + 刷新按钮（extensions_reload / plugins_reload / reload_mcp），无需重装
// - 搜索过滤：文本匹配 name/description/error/version；来源筛选 cli/webui/外部/异常（纯前端 useMemo）
// - 防覆盖小字：继承只读、Web 专属可写、覆盖须显式可逆

import { useMemo, useState } from "react";
import type { UiExtensionInventoryEntry } from "../types";

interface Props {
	entries: UiExtensionInventoryEntry[];
	onToggleCli: (entry: UiExtensionInventoryEntry) => void;
	onToggleWebui: (entry: UiExtensionInventoryEntry) => void;
	onToggleExternal: (entry: UiExtensionInventoryEntry) => void;
	onRefreshAll: () => void;
}

type SourceFilter = "all" | "cli" | "webui" | "external" | "abnormal";

function sourceBadge(source: UiExtensionInventoryEntry["source"]): { label: string; bg: string; fg: string } {
	if (source === "cli") return { label: "CLI", bg: "#1d4ed8", fg: "#fff" };
	if (source === "webui") return { label: "WebUI", bg: "#15803d", fg: "#fff" };
	return { label: "外部 External", bg: "#c2410c", fg: "#fff" };
}

function healthBadge(health: UiExtensionInventoryEntry["health"]): { label: string; bg: string; fg: string } | null {
	if (!health) return null;
	if (health === "online") return { label: "在线 Online", bg: "#dcfce7", fg: "#166534" };
	if (health === "error") return { label: "异常 Error", bg: "#fee2e2", fg: "#991b1b" };
	if (health === "stopped") return { label: "已停用 Stopped", bg: "#f3f4f6", fg: "#4b5563" };
	if (health === "offline") return { label: "离线 Offline", bg: "#ffedd5", fg: "#9a3412" };
	return { label: "未知 Unknown", bg: "#f3f4f6", fg: "#4b5563" };
}

function isAbnormal(e: UiExtensionInventoryEntry): boolean {
	if (e.error && e.error.trim()) return true;
	return e.health === "error";
}

function shortMcpName(name: string): { scope: string; base: string } {
	const m = /^mcp:(global|project):(.+)$/.exec(name);
	if (m) return { scope: m[1], base: m[2] };
	return { scope: "", base: name };
}

export default function ExtensionInventory({
	entries,
	onToggleCli,
	onToggleWebui,
	onToggleExternal,
	onRefreshAll,
}: Props) {
	const [query, setQuery] = useState("");
	const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		return entries.filter((e) => {
			if (sourceFilter === "cli" && e.source !== "cli") return false;
			if (sourceFilter === "webui" && e.source !== "webui") return false;
			if (sourceFilter === "external" && e.source !== "external") return false;
			if (sourceFilter === "abnormal" && !isAbnormal(e)) return false;
			if (!q) return true;
			const hay = `${e.name} ${e.description ?? ""} ${e.error ?? ""} ${e.version ?? ""}`.toLowerCase();
			return hay.includes(q);
		});
	}, [entries, query, sourceFilter]);

	const cli = filtered.filter((e) => e.source === "cli");
	const webui = filtered.filter((e) => e.source === "webui");
	const external = filtered.filter((e) => e.source === "external");
	const abnormalCount = useMemo(() => entries.filter(isAbnormal).length, [entries]);
	const filtering = query.trim() !== "" || sourceFilter !== "all";

	const renderRow = (e: UiExtensionInventoryEntry) => {
		const badge = sourceBadge(e.source);
		const health = healthBadge(e.health);
		const switchable = e.switchable !== false && !e.name.startsWith("__load_error__");
		const toggle = () => {
			if (!switchable) return;
			if (e.source === "cli") onToggleCli(e);
			else if (e.source === "webui") onToggleWebui(e);
			else onToggleExternal(e);
		};
		const mcp = e.source === "external" ? shortMcpName(e.name) : null;
		return (
			<div key={`${e.source}:${e.name}`} className="set-list-item" style={{ alignItems: "flex-start" }}>
				<div style={{ flex: 1, minWidth: 0 }}>
					<div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
						<span
							style={{
								fontSize: 11,
								fontWeight: 700,
								padding: "1px 7px",
								borderRadius: 999,
								background: badge.bg,
								color: badge.fg,
								whiteSpace: "nowrap",
							}}
						>
							{badge.label}
						</span>
						<strong style={{ overflowWrap: "anywhere" }}>{mcp ? mcp.base : e.name}</strong>
						<span
							style={{
								fontSize: 11,
								padding: "1px 7px",
								borderRadius: 999,
								background: e.enabled ? "#dcfce7" : "#fee2e2",
								color: e.enabled ? "#166534" : "#991b1b",
								whiteSpace: "nowrap",
							}}
						>
							{e.enabled ? "已启用 Enabled" : "已停用 Disabled"}
						</span>
						{health ? (
							<span
								style={{
									fontSize: 11,
									padding: "1px 7px",
									borderRadius: 999,
									background: health.bg,
									color: health.fg,
									whiteSpace: "nowrap",
								}}
							>
								{health.label}
							</span>
						) : null}
						{mcp?.scope ? <span style={{ fontSize: 11, opacity: 0.65 }}>MCP · {mcp.scope}</span> : null}
						{e.version ? <span style={{ fontSize: 11, opacity: 0.65 }}>v{e.version}</span> : null}
						{typeof e.toolCount === "number" ? (
							<span style={{ fontSize: 11, opacity: 0.65 }}>{e.toolCount} 工具 tools</span>
						) : null}
					</div>
					{e.description ? (
						<div style={{ fontSize: 12, opacity: 0.75, marginTop: 3, overflowWrap: "anywhere" }}>{e.description}</div>
					) : null}
					{e.error ? (
						<div
							style={{
								fontSize: 12,
								marginTop: 4,
								padding: "6px 8px",
								borderRadius: 6,
								background: "#fef2f2",
								color: "#991b1b",
								overflowWrap: "anywhere",
								whiteSpace: "pre-wrap",
							}}
						>
							<div style={{ fontWeight: 700, marginBottom: 2 }}>加载失败 Load failed（原文 error）：</div>
							<div>{e.error}</div>
						</div>
					) : null}
					{!switchable && !e.name.startsWith("__load_error__") ? (
						<div style={{ fontSize: 12, opacity: 0.65, marginTop: 3 }}>
							SDK 不支持单独启停，仅展示 / Not switchable via SDK, display only
						</div>
					) : null}
				</div>
				<div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
					<button
						type="button"
						className="set-toggle"
						disabled={!switchable}
						title={
							switchable
								? e.enabled
									? "停用 Disable"
									: "启用 Enable"
								: "SDK 不支持单独启停，仅展示 / Not switchable via SDK, display only"
						}
						onClick={toggle}
						style={!switchable ? { opacity: 0.45, cursor: "not-allowed" } : undefined}
					>
						{e.enabled ? "停用 Disable" : "启用 Enable"}
					</button>
				</div>
			</div>
		);
	};

	return (
		<div className="set-section" style={{ border: "1px dashed var(--border, #e5e7eb)", borderRadius: 10, padding: 12 }}>
			<div className="set-section-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
				<span>扩展统一清单 Extension Inventory</span>
				<span className="set-count">{entries.length}</span>
				<span style={{ flex: 1 }} />
				<button type="button" className="set-uninstall" title="一键刷新 Refresh all" onClick={onRefreshAll}>
					<span>一键刷新 Refresh</span>
				</button>
			</div>
			<p className="set-desc" style={{ marginTop: 4, marginBottom: 10 }}>
				继承的只读展示，Web 专属才可写；必须覆盖时显式标注可逆 / Inherited entries are read-only; only WebUI-specific
				entries are writable. Overrides must be explicitly marked reversible.
			</p>
			<div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
				<input
					type="text"
					value={query}
					onChange={(ev) => setQuery(ev.target.value)}
					placeholder="搜索名称 / 描述 / 错误 Search name, description, error"
					style={{ flex: "1 1 200px", minWidth: 0 }}
				/>
				<select value={sourceFilter} onChange={(ev) => setSourceFilter(ev.target.value as SourceFilter)}>
					<option value="all">全部 All ({entries.length})</option>
					<option value="cli">CLI ({entries.filter((e) => e.source === "cli").length})</option>
					<option value="webui">WebUI ({entries.filter((e) => e.source === "webui").length})</option>
					<option value="external">外部 External ({entries.filter((e) => e.source === "external").length})</option>
					<option value="abnormal">异常 Abnormal ({abnormalCount})</option>
				</select>
				{filtering ? (
					<button
						type="button"
						className="set-uninstall"
						onClick={() => {
							setQuery("");
							setSourceFilter("all");
						}}
					>
						<span>清除 Clear</span>
					</button>
				) : null}
			</div>
			{entries.length === 0 ? (
				<p className="set-empty">暂无扩展数据，点击右上刷新获取 / No inventory yet, click Refresh above</p>
			) : filtered.length === 0 ? (
				<p className="set-empty">无匹配结果，换个关键词或来源 / No matches, try another keyword or source</p>
			) : (
				<>
					<div style={{ fontSize: 12, fontWeight: 700, margin: "8px 0 4px" }}>
						CLI 继承（{cli.length}）/ Inherited from Pi CLI
					</div>
					<div className="set-list">{cli.length === 0 ? <p className="set-empty">无 None</p> : cli.map(renderRow)}</div>
					<div style={{ fontSize: 12, fontWeight: 700, margin: "8px 0 4px" }}>
						WebUI 专属（{webui.length}）/ WebUI-specific
					</div>
					<div className="set-list">
						{webui.length === 0 ? <p className="set-empty">无 None</p> : webui.map(renderRow)}
					</div>
					<div style={{ fontSize: 12, fontWeight: 700, margin: "8px 0 4px" }}>
						外部 MCP（{external.length}）/ External MCP
					</div>
					<div className="set-list">
						{external.length === 0 ? <p className="set-empty">无 None</p> : external.map(renderRow)}
					</div>
				</>
			)}
		</div>
	);
}
