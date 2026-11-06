import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { DefaultPackageManager, getAgentDir, loadSkills, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ModelInfo } from "../protocol.js";
import { ALL_AGENT_TOOL_ENTRIES, isToolSupportedOnPlatform } from "../tool-manager.js";
import { discoverDiskSkills, mergeSkillCollections } from "../skill-discovery.js";
import { listAllMcpServers } from "../mcp-manager.js";
import { getMcpToolServer, type McpBridge } from "../mcp-bridge.js";
import { isBotToolHighPrivilege } from "./bot-execution.js";
import { DeviceWorkspaceError } from "./workspaces.js";

export interface BotToolOption {
	id: string;
	name: string;
	description?: string;
	source?: string;
	warning?: "high_privilege" | "unsupported_platform";
}
export interface LocalBotOptions {
	cwd: string;
	defaultCwd: string;
	defaultModel?: string;
	defaultTools: string[];
	projects: { path: string }[];
	models: ModelInfo[];
	tools: BotToolOption[];
	skills: { id: string; name: string; description?: string; path?: string }[];
	mcpServers: {
		id: string;
		name: string;
		scope: "global" | "project";
		status: "ready" | "not_loaded" | "disabled";
		tools: BotToolOption[];
	}[];
}
export interface BotCatalogSources {
	defaultCwd: string;
	dataDir: string;
	agentDir?: string;
	models?: (signal: AbortSignal) => Promise<ModelInfo[]>;
	projects?: () => { path: string }[] | Promise<{ path: string }[]>;
	defaultModel?: () => string | undefined;
	defaultTools?: () => string[];
	peekMcpBridge?: (cwd: string) => McpBridge | undefined;
}

export async function getLocalBotOptions(
	sources: BotCatalogSources,
	requestedCwd: unknown,
	signal: AbortSignal,
): Promise<LocalBotOptions> {
	signal.throwIfAborted();
	if (requestedCwd !== undefined && (typeof requestedCwd !== "string" || !isAbsolute(requestedCwd)))
		throw new DeviceWorkspaceError(400, "BOT_CWD_INVALID", "Project path must be absolute");
	const cwd = resolve((requestedCwd as string | undefined) ?? sources.defaultCwd);
	if (!(await stat(cwd).catch(() => undefined))?.isDirectory())
		throw new DeviceWorkspaceError(400, "BOT_CWD_INVALID", "Project directory does not exist");
	signal.throwIfAborted();
	const defaultTools = [...(sources.defaultTools?.() ?? [])];
	const agentDir = sources.agentDir ?? getAgentDir();
	const settings = SettingsManager.create(cwd, agentDir);
	const resources = await new DefaultPackageManager({ cwd, agentDir, settingsManager: settings }).resolve(async () => {
		signal.throwIfAborted();
		return "skip";
	});
	signal.throwIfAborted();
	const sdkSkills = loadSkills({
		cwd,
		agentDir,
		skillPaths: resources.skills.filter((resource) => resource.enabled).map((resource) => resource.path),
		includeDefaults: false,
	}).skills;
	const skills = mergeSkillCollections(sdkSkills, discoverDiskSkills({ cwd, agentDir }));
	const bridge = sources.peekMcpBridge?.(cwd);
	const definitions = bridge?.getTools() ?? [];
	const counts = new Map<string, number>();
	for (const tool of definitions) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
	const reserved = new Set(ALL_AGENT_TOOL_ENTRIES.map((tool) => tool.name));
	const mcpServers = listAllMcpServers({ cwd, agentDir, dataDir: sources.dataDir, bridge })
		.servers.filter(
			(server) => !server.overriddenBy && Array.isArray(server.tools) && ["global", "project"].includes(server.scope),
		)
		.map((server): LocalBotOptions["mcpServers"][number] => ({
			id: server.name,
			name: server.name,
			scope: server.scope as "global" | "project",
			status: !server.enabled
				? "disabled"
				: server.status === "running" && !server.usingPreviousConfig
					? "ready"
					: "not_loaded",
			tools:
				!server.enabled || server.status !== "running" || server.usingPreviousConfig
					? []
					: definitions
							.filter(
								(tool) =>
									getMcpToolServer(tool) === server.name && counts.get(tool.name) === 1 && !reserved.has(tool.name),
							)
							.map((tool) => ({
								id: tool.name,
								name: tool.name,
								description: tool.description,
								source: server.name,
								...(isBotToolHighPrivilege(tool.name) ? { warning: "high_privilege" as const } : {}),
							})),
		}));
	const models = (await sources.models?.(signal)) ?? [];
	signal.throwIfAborted();
	const defaultModel = sources.defaultModel?.();
	const projects = (await sources.projects?.()) ?? [{ path: sources.defaultCwd }];
	signal.throwIfAborted();
	return {
		cwd,
		defaultCwd: sources.defaultCwd,
		defaultTools,
		...(defaultModel ? { defaultModel } : {}),
		projects,
		models: models.map(({ id, name, provider, reasoning, vision, enabled }) => ({
			id,
			name,
			provider,
			reasoning,
			vision,
			...(enabled === undefined ? {} : { enabled }),
		})),
		tools: ALL_AGENT_TOOL_ENTRIES.map(({ name }) => ({
			id: name,
			name,
			source: "builtin",
			...(!isToolSupportedOnPlatform(name)
				? { warning: "unsupported_platform" as const }
				: isBotToolHighPrivilege(name)
					? { warning: "high_privilege" as const }
					: {}),
		})),
		skills: skills.map((skill) => ({
			id: skill.name,
			name: skill.name,
			description: skill.description,
			path: skill.filePath,
		})),
		mcpServers,
	};
}
