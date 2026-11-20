import { isAbsolute, resolve } from "node:path";
import { DefaultPackageManager, getAgentDir, loadSkills, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ModelInfo } from "../protocol.js";
import { ALL_AGENT_TOOL_ENTRIES, BOT_MEMORY_TOOL_NAME, isToolSupportedOnPlatform } from "../tool-manager.js";
import { discoverDiskSkills, mergeSkillCollections } from "../skill-discovery.js";
import { listAllMcpServers } from "../mcp-manager.js";
import { getMcpToolServer, type McpBridge } from "../mcp-bridge.js";
import { isBotToolHighPrivilege } from "./bot-execution.js";
import {
	DeviceWorkspaceError,
	isSshWorkspaceUri,
	normalizeSshWorkspaceUri,
	validateDeviceProject,
} from "./workspaces.js";

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
	if (
		requestedCwd !== undefined &&
		(typeof requestedCwd !== "string" ||
			(!isSshWorkspaceUri(requestedCwd) && !isAbsolute(requestedCwd)) ||
			(isSshWorkspaceUri(requestedCwd) && !normalizeSshWorkspaceUri(requestedCwd)))
	)
		throw new DeviceWorkspaceError(400, "BOT_CWD_INVALID", "Project path must be absolute");
	// SSH 智能体：远端磁盘不可直接读，明确指定就按远端 URI 建 catalog（技能留空，工具/全局 MCP 照常）。
	const sshCwd = isSshWorkspaceUri(requestedCwd) ? (normalizeSshWorkspaceUri(requestedCwd) as string) : null;
	const projectList = (await sources.projects?.()) ?? [];
	signal.throwIfAborted();
	// 明确指定（编辑已有 Bot / 表单选目录）就按它严格校验：选了不可用的目录宁可报错，
	// 也不静默换一个目录，否则保存下去的 Bot 会指向跟用户选择不一致的工作区。
	// 没指定时用默认工作区，但主目录 / 卷根 / 数据目录内不能当项目——
	// dev 从 home 启动是常态，直接报错会让「新建 Bot」永远卡住，所以退回最近项目。
	const cwd = await (async () => {
		if (typeof requestedCwd === "string") return validateDeviceProject(resolve(requestedCwd), sources.dataDir);
		const candidates = [sources.defaultCwd, ...projectList.map((project) => project.path)];
		for (const candidate of new Set(candidates)) {
			try {
				return await validateDeviceProject(resolve(candidate), sources.dataDir);
			} catch {}
		}
		throw new DeviceWorkspaceError(
			400,
			"BOT_CWD_INVALID",
			"Pick a concrete project directory; home and volume roots cannot host a Bot",
		);
	})();
	signal.throwIfAborted();
	// 记忆是 Bot 的私产：新 Bot 默认就带 `memory`（它只碰自己的 <dataDir>/bot-agents/<id>/memory）。
	// 全局设置里没有这个开关（defaultOn:false + 不在用户工具页出现），靠这里给默认值。
	const defaultTools = [...new Set([...(sources.defaultTools?.() ?? []), BOT_MEMORY_TOOL_NAME])];
	const agentDir = sources.agentDir ?? getAgentDir();
	// SSH 智能体的远端技能需连上远端才能发现，catalog 阶段留空（保存/执行不受影响）。
	const skills = sshCwd
		? []
		: await (async () => {
				const settings = SettingsManager.create(cwd, agentDir);
				const resources = await new DefaultPackageManager({ cwd, agentDir, settingsManager: settings }).resolve(
					async () => {
						signal.throwIfAborted();
						return "skip";
					},
				);
				signal.throwIfAborted();
				const sdkSkills = loadSkills({
					cwd,
					agentDir,
					skillPaths: resources.skills.filter((resource) => resource.enabled).map((resource) => resource.path),
					includeDefaults: false,
				}).skills;
				return mergeSkillCollections(sdkSkills, discoverDiskSkills({ cwd, agentDir }));
			})();
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
	const projects = projectList.length > 0 ? projectList : [{ path: cwd }];
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
