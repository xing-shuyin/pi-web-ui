import { getGlobalMcpPath, getProjectMcpPath, readMcpConfigFile } from "../mcp-manager.js";
import type { McpServerSpec } from "../mcp-bridge.js";
import { isRemoteWorkspaceUri } from "../remote-ssh-service.js";

/**
 * Bridges the MCP servers configured in pi-web-ui (`<agentDir>/mcp.json` + `<cwd>/.pi/mcp.json`)
 * into the native CLI engines. The CLIs keep loading their own MCP config as well; this only adds
 * pi's servers on top so a server configured in the web UI is visible to every engine.
 */

const SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export function collectEnabledMcpServers(opts: {
	cwd: string;
	agentDir?: string;
	dataDir?: string;
}): Record<string, McpServerSpec> {
	const global = readMcpConfigFile(getGlobalMcpPath(opts.agentDir, opts.dataDir || undefined)).servers;
	const project = isRemoteWorkspaceUri(opts.cwd) ? {} : readMcpConfigFile(getProjectMcpPath(opts.cwd)).servers;
	const merged: Record<string, McpServerSpec> = { ...global, ...project };
	const out: Record<string, McpServerSpec> = {};
	for (const [name, spec] of Object.entries(merged)) {
		if (!SERVER_NAME.test(name) || !spec || spec.enabled === false) continue;
		if (spec.url ? !/^https?:\/\//i.test(spec.url) : !spec.command) continue;
		out[name] = spec;
	}
	return out;
}

function isRemoteSpec(spec: McpServerSpec): boolean {
	return Boolean(spec.url) && spec.type !== "stdio";
}

/** Claude Code `--mcp-config` file body. Only fields Claude's schema knows are emitted. */
export function toClaudeMcpConfig(servers: Record<string, McpServerSpec>): {
	mcpServers: Record<string, Record<string, unknown>>;
} {
	const mcpServers: Record<string, Record<string, unknown>> = {};
	for (const [name, spec] of Object.entries(servers)) {
		if (isRemoteSpec(spec)) {
			mcpServers[name] = {
				type: "http",
				url: spec.url,
				...(spec.headers && Object.keys(spec.headers).length ? { headers: spec.headers } : {}),
			};
		} else if (spec.command) {
			mcpServers[name] = {
				type: "stdio",
				command: spec.command,
				args: spec.args ?? [],
				...(spec.env && Object.keys(spec.env).length ? { env: spec.env } : {}),
			};
		}
	}
	return { mcpServers };
}

/** TOML literal for a `codex -c key=value` override (JSON strings/arrays are valid TOML). */
function tomlValue(value: unknown): string {
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	if (typeof value === "boolean") return String(value);
	if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
	if (value && typeof value === "object")
		return `{ ${Object.entries(value)
			.map(([k, v]) => `${JSON.stringify(k)} = ${tomlValue(v)}`)
			.join(", ")} }`;
	throw new Error(`Unsupported MCP config value: ${String(value)}`);
}

/**
 * `-c mcp_servers.<name>.<key>=<toml>` overrides for `codex exec`. HTTP header values (usually
 * bearer tokens) travel through `env_http_headers` + the returned env so they stay out of argv.
 */
export function toCodexMcpOverrides(servers: Record<string, McpServerSpec>): {
	args: string[];
	env: Record<string, string>;
} {
	const args: string[] = [];
	const env: Record<string, string> = {};
	const push = (name: string, key: string, value: unknown) => {
		args.push("-c", `mcp_servers.${name}.${key}=${tomlValue(value)}`);
	};
	for (const [name, spec] of Object.entries(servers)) {
		if (isRemoteSpec(spec)) {
			push(name, "url", spec.url);
			const headers = Object.entries(spec.headers ?? {});
			if (headers.length) {
				const envHeaders: Record<string, string> = {};
				headers.forEach(([header, value], i) => {
					const envName = `PI_MCP_${name.replace(/-/g, "_").toUpperCase()}_H${i}`;
					env[envName] = value;
					envHeaders[header] = envName;
				});
				push(name, "env_http_headers", envHeaders);
			}
		} else if (spec.command) {
			push(name, "command", spec.command);
			if (spec.args?.length) push(name, "args", spec.args);
			if (spec.env && Object.keys(spec.env).length) push(name, "env", spec.env);
			if (spec.cwd) push(name, "cwd", spec.cwd);
		} else continue;
		if (typeof spec.timeout === "number" && spec.timeout > 0) push(name, "tool_timeout_sec", spec.timeout);
		// The driver runs `--ask-for-approval never`; Codex rejects MCP calls that would need a
		// prompt ("requires approval, but approval policy is never"), so servers the user enabled
		// in pi are pre-approved — same trust level as Claude's --dangerously-skip-permissions.
		push(name, "default_tools_approval_mode", "approve");
	}
	return { args, env };
}
