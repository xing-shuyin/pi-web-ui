import type { McpScope, UiMcpServer } from "./types";

export interface McpDraft {
	name: string;
	scope: McpScope;
	transport: "stdio" | "http";
	command: string;
	args: string[];
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
	original?: UiMcpServer;
}

export function createMcpDraft(server: UiMcpServer): McpDraft {
	return {
		name: server.name,
		scope: server.scope,
		transport: server.url || server.type === "http" || server.type === "streamable-http" ? "http" : "stdio",
		command: server.command ?? "",
		args: [...(server.args ?? [])],
		cwd: server.cwd ?? "",
		env: Object.entries(server.env ?? {}).map(([key, value]) => ({ key, value })),
		url: server.url ?? "",
		headers: Object.entries(server.headers ?? {}).map(([key, value]) => ({ key, value })),
		timeout: server.timeout !== undefined ? String(server.timeout) : "",
		description: server.description ?? "",
		enabled: server.enabled !== false,
		isNew: false,
		prevName: server.name,
		prevScope: server.scope,
		original: {
			...server,
			args: server.args ? [...server.args] : undefined,
			env: server.env ? { ...server.env } : undefined,
			headers: server.headers ? { ...server.headers } : undefined,
		},
	};
}

export function getMcpServerDisplayState(server: UiMcpServer) {
	const status = server.overriddenBy ? "stopped" : (server.status ?? "stopped");
	return {
		status,
		label: server.overriddenBy
			? ("mcpStatusOverridden" as const)
			: server.usingPreviousConfig
				? ("mcpStatusPreviousConfig" as const)
				: status === "running"
					? ("mcpStatusRunning" as const)
					: status === "error"
						? ("mcpStatusError" as const)
						: ("mcpStatusStopped" as const),
		toolsCount: server.overriddenBy ? 0 : (server.tools?.length ?? 0),
	};
}

function draftFields(draft: McpDraft): UiMcpServer {
	const toMap = (items: McpDraft["env"]) => {
		const entries = items.filter((item) => item.key.trim()).map(({ key, value }) => [key.trim(), value]);
		return entries.length ? Object.fromEntries(entries) : undefined;
	};
	const timeout = Number(draft.timeout);
	return {
		name: draft.name.trim(),
		scope: draft.scope,
		type: draft.transport,
		command: draft.transport === "stdio" ? draft.command.trim() || undefined : undefined,
		args: draft.transport === "stdio" ? [...draft.args] : undefined,
		cwd: draft.transport === "stdio" ? draft.cwd.trim() || undefined : undefined,
		env: draft.transport === "stdio" ? toMap(draft.env) : undefined,
		url: draft.transport === "http" ? draft.url.trim() || undefined : undefined,
		headers: draft.transport === "http" ? toMap(draft.headers) : undefined,
		timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : undefined,
		description: draft.description.trim() || undefined,
		enabled: draft.enabled,
	};
}

export function serializeMcpDraft(draft: McpDraft): UiMcpServer {
	const fields = draftFields(draft);
	if (!draft.original) return fields;
	const {
		status: _status,
		error: _error,
		tools: _tools,
		overriddenBy: _overriddenBy,
		usingPreviousConfig: _usingPreviousConfig,
		...config
	} = draft.original;
	const baseline = draftFields(createMcpDraft(draft.original));
	const transportChanged = baseline.type !== fields.type;
	const transportFields = new Set(["type", "command", "args", "cwd", "env", "url", "headers"]);
	for (const key of Object.keys(fields) as Array<keyof UiMcpServer>) {
		if (
			(transportChanged && transportFields.has(key)) ||
			JSON.stringify(fields[key]) !== JSON.stringify(baseline[key])
		) {
			Object.assign(config, { [key]: fields[key] });
		}
	}
	return config;
}
