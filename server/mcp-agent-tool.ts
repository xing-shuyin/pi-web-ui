import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { pick, type ServerLang } from "./i18n.js";
import { MCP_MANAGE_TOOL_NAME } from "./tool-manager.js";
import type { McpCheckResult, McpInstallResult, McpInstallSpec } from "./mcp-manager.js";
import type { McpScope, UiMcpServer } from "./protocol.js";

export interface McpManageToolHost {
	listServers(): { servers: UiMcpServer[]; globalPath: string; projectPath: string };
	checkServer(query: string): McpCheckResult;
	installServer(spec: McpInstallSpec): Promise<McpInstallResult>;
	removeServer(name: string, scope?: McpScope): Promise<{ ok: boolean; error?: string }>;
	reloadServers(): Promise<{ servers: UiMcpServer[] }>;
}

function formatServerLine(s: UiMcpServer): string {
	const target = s.url ? s.url : [s.command, ...(s.args ?? [])].filter(Boolean).join(" ");
	const toolNames = (s.tools ?? []).map((t) => t.name).join(", ");
	const toolSuffix = toolNames ? ` | tools: ${toolNames}` : "";
	const errSuffix = s.error ? ` | error: ${s.error}` : "";
	return `- ${s.name} [${s.scope}] (${s.status}${s.enabled === false ? ", disabled" : ""}): ${target}${toolSuffix}${errSuffix}`;
}

export function makeMcpManageTool(host: McpManageToolHost, lang?: () => ServerLang): ToolDefinition {
	const getLang: () => ServerLang = lang ?? (() => "en");
	const reply = (
		text: string,
		details: Record<string, unknown> = {},
	): { content: { type: "text"; text: string }[]; details: Record<string, unknown> } => ({
		content: [{ type: "text", text }],
		details,
	});

	return defineTool({
		name: MCP_MANAGE_TOOL_NAME,
		label: "Manage MCP servers",
		description:
			"Inspect, verify, install, remove, or reload Model Context Protocol (MCP) servers in project (.pi/mcp.json) or global (~/.pi/agent/mcp.json) config and sync their tools into the active session.",
		promptSnippet: "check whether an MCP server is installed or install/configure one",
		promptGuidelines: [
			"Run mcp_manage with action='check' before installing an MCP server to avoid duplicate entries.",
			"install refuses to overwrite an existing server with the same name unless overwrite=true (it would replace command/args/env).",
			"Prefer package shorthand (e.g. package='@modelcontextprotocol/server-filesystem') for npm-based stdio MCP servers.",
		],
		parameters: Type.Object({
			action: Type.Union(
				[
					Type.Literal("list"),
					Type.Literal("check"),
					Type.Literal("install"),
					Type.Literal("remove"),
					Type.Literal("reload"),
				],
				{
					description: "Operation to perform: list, check, install, remove, or reload.",
				},
			),
			query: Type.Optional(
				Type.String({
					description: "check: server name, npm package name, command, or URL substring to look up.",
				}),
			),
			name: Type.Optional(
				Type.String({
					description:
						"install/remove: server identifier (letters, digits, underscore, hyphen). Auto-derived from package/url if omitted on install.",
				}),
			),
			package: Type.Optional(
				Type.String({
					description:
						"install: npm package name shorthand (e.g. '@modelcontextprotocol/server-memory'); expands to npx -y <package>.",
				}),
			),
			command: Type.Optional(
				Type.String({
					description: "install: executable for stdio MCP server (e.g. 'npx', 'uvx', 'node', 'python').",
				}),
			),
			args: Type.Optional(
				Type.Array(Type.String(), {
					description: "install: command arguments (appended after package when package is set).",
				}),
			),
			env: Type.Optional(
				Type.Record(Type.String(), Type.String(), {
					description: "install: environment variables passed to the stdio MCP server.",
				}),
			),
			cwd: Type.Optional(
				Type.String({
					description: "install: working directory for the stdio MCP server.",
				}),
			),
			url: Type.Optional(
				Type.String({
					description: "install: endpoint URL for http / streamable-http MCP server.",
				}),
			),
			headers: Type.Optional(
				Type.Record(Type.String(), Type.String(), {
					description: "install: HTTP headers for remote MCP server.",
				}),
			),
			type: Type.Optional(
				Type.Union([Type.Literal("stdio"), Type.Literal("http"), Type.Literal("streamable-http")], {
					description: "install: transport type (defaults to stdio, or streamable-http when url is given).",
				}),
			),
			scope: Type.Optional(
				Type.Union([Type.Literal("project"), Type.Literal("global")], {
					description: "install/remove: config scope ('project' = .pi/mcp.json, 'global' = ~/.pi/agent/mcp.json).",
				}),
			),
			overwrite: Type.Optional(
				Type.Boolean({
					description:
						"install: set true to replace an existing server with the same name (its command/args/env get overwritten).",
				}),
			),
			description: Type.Optional(
				Type.String({
					description: "install: human-readable server note.",
				}),
			),
		}),
		execute: async (_id, params) => {
			const L = getLang();
			const action = params.action;

			if (action === "list") {
				const { servers, globalPath, projectPath } = host.listServers();
				if (servers.length === 0) {
					return reply(
						pick(
							L,
							`当前未配置任何 MCP 服务器。\n项目配置：${projectPath}\n全局配置：${globalPath}`,
							`No MCP servers configured.\nProject config: ${projectPath}\nGlobal config: ${globalPath}`,
							"mcp_manage.list.empty",
							{ projectPath, globalPath },
						),
						{ count: 0 },
					);
				}
				const lines = servers.map(formatServerLine).join("\n");
				return reply(
					pick(
						L,
						`已配置的 MCP 服务器（${servers.length}）：\n${lines}`,
						`Configured MCP servers (${servers.length}):\n${lines}`,
						"mcp_manage.list.ok",
						{ count: servers.length, lines },
					),
					{ count: servers.length, servers: servers.map((s) => ({ name: s.name, scope: s.scope, status: s.status })) },
				);
			}

			if (action === "check") {
				const q = (params.query ?? params.name ?? params.package ?? "").trim();
				if (!q) {
					return reply(
						pick(
							L,
							"请提供 query（或 name / package）以检查对应的 MCP 服务器是否已安装。",
							"Provide query (or name / package) to check whether the MCP server is installed.",
							"mcp_manage.check.missing_query",
						),
						{ installed: false },
					);
				}
				const res = host.checkServer(q);
				if (!res.installed || !res.server) {
					return reply(
						pick(
							L,
							`未找到匹配「${q}」的 MCP 服务器（installed=false）。可使用 action="install" 安装。`,
							`No MCP server matching "${q}" is installed (installed=false). Use action="install" to install it.`,
							"mcp_manage.check.not_installed",
							{ query: q },
						),
						{ query: q, installed: false, running: false },
					);
				}
				const lines = res.matches.map(formatServerLine).join("\n");
				return reply(
					pick(
						L,
						`已找到匹配「${q}」的 MCP 服务器（installed=true, running=${res.running}）：\n${lines}`,
						`Found MCP server matching "${q}" (installed=true, running=${res.running}):\n${lines}`,
						"mcp_manage.check.found",
						{ query: q, running: res.running, lines },
					),
					{
						query: q,
						installed: true,
						running: res.running,
						enabled: res.enabled,
						name: res.server.name,
						scope: res.server.scope,
						status: res.server.status,
						toolCount: res.tools.length,
					},
				);
			}

			if (action === "install") {
				const res = await host.installServer({
					name: params.name,
					package: params.package,
					command: params.command,
					args: params.args,
					env: params.env,
					cwd: params.cwd,
					url: params.url,
					headers: params.headers,
					type: params.type,
					scope: params.scope,
					description: params.description,
				});
				if (!res.ok) {
					const errorText = res.error ?? (L === "zh" ? "未知错误" : "unknown error");
					return reply(
						pick(
							L,
							`MCP 服务器安装失败：${res.error ?? "未知错误"}`,
							`Failed to install MCP server: ${res.error ?? "unknown error"}`,
							"mcp_manage.install.fail",
							{ error: errorText },
						),
						{ ok: false, error: res.error },
					);
				}
				const toolNames = (res.tools ?? []).map((t) => `${res.name}_${t.name}`);
				const toolsJoined = toolNames.join(", ");
				const toolHint =
					toolNames.length > 0
						? pick(
								L,
								`\n已暴露工具（${toolNames.length}）：${toolsJoined}`,
								`\nExposed tools (${toolNames.length}): ${toolsJoined}`,
								"mcp_manage.install.tools",
								{ count: toolNames.length, tools: toolsJoined },
							)
						: res.error
							? `\n⚠️ ${res.error}`
							: "";
				return reply(
					pick(
						L,
						`已安装 MCP 服务器「${res.name}」（作用域：${res.scope}，状态：${res.status}）。${toolHint}`,
						`Installed MCP server "${res.name}" (scope: ${res.scope}, status: ${res.status}).${toolHint}`,
						"mcp_manage.install.ok",
						{ name: res.name ?? "", scope: res.scope ?? "project", status: res.status ?? "stopped", toolHint },
					),
					{
						ok: true,
						name: res.name,
						scope: res.scope,
						status: res.status,
						toolCount: toolNames.length,
						...(res.error ? { error: res.error } : {}),
					},
				);
			}

			if (action === "remove") {
				const name = (params.name ?? params.query ?? "").trim();
				if (!name) {
					return reply(
						pick(
							L,
							"请提供要移除的 MCP 服务器名称（name）。",
							"Provide the MCP server name to remove.",
							"mcp_manage.remove.missing_name",
						),
						{ ok: false },
					);
				}
				const res = await host.removeServer(name, params.scope);
				if (!res.ok) {
					const errorText = res.error ?? (L === "zh" ? "不存在" : "not found");
					return reply(
						pick(
							L,
							`移除 MCP 服务器「${name}」失败：${res.error ?? "不存在"}`,
							`Failed to remove MCP server "${name}": ${res.error ?? "not found"}`,
							"mcp_manage.remove.fail",
							{ name, error: errorText },
						),
						{ ok: false, name, error: res.error },
					);
				}
				return reply(
					pick(
						L,
						`已移除 MCP 服务器「${name}」并同步工具列表。`,
						`Removed MCP server "${name}" and synced tools.`,
						"mcp_manage.remove.ok",
						{ name },
					),
					{ ok: true, name },
				);
			}

			const { servers } = await host.reloadServers();
			const runningCount = servers.filter((s) => s.status === "running").length;
			return reply(
				pick(
					L,
					`已重新加载全部 MCP 服务器（共 ${servers.length} 个，运行中 ${runningCount} 个）。`,
					`Reloaded all MCP servers (${servers.length} total, ${runningCount} running).`,
					"mcp_manage.reload.ok",
					{ count: servers.length, running: runningCount },
				),
				{ count: servers.length, running: runningCount },
			);
		},
	});
}
