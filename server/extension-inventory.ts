// #885 T1：扩展统一清单（只读聚合，不改运行时）
// 三类来源：
//  - cli：Pi CLI SDK 内置扩展（getSdkBuiltinExtensionFactories）
//  - webui：WebUI 插件（PluginManager.list → UiPluginInfo）
//  - external：MCP 服务器（global + project，listAllMcpServers）
// 统一 shape：{ name, source, enabled, version?, description?, error?, health?, toolCount? }
// 失败只记录 error 原文，不抛错、不触发重装、不写运行时。
// 健康探测为只读：直接用 listMcpServers 已有 status/error/tools，不新建连接、不 reload；
// 可选 probeMcp 亦只读（失败只记 entry.error，不抛）。

import type { UiExtensionInventoryHealth, UiMcpServer } from "./protocol.js";
import type { UiExtensionInventoryEntry, UiExtensionInventorySource } from "./protocol.js";

export type { UiExtensionInventoryEntry, UiExtensionInventorySource, UiExtensionInventoryHealth };

export interface SdkBuiltinInput {
	name: string;
	replaceable?: boolean;
	hidden?: boolean;
}

export interface WebuiPluginInput {
	id: string;
	name?: string;
	version?: string;
	description?: string;
	error?: string;
	active?: boolean;
}

export interface McpServerInput {
	name: string;
	scope: "global" | "project";
	enabled?: boolean;
	description?: string;
	status?: string;
	error?: string;
	tools?: Array<{ name: string; description?: string }>;
}

export interface ExtensionInventoryInput {
	sdkBuiltins: SdkBuiltinInput[];
	disabledExtensions: readonly string[];
	plugins: WebuiPluginInput[];
	disabledPlugins: readonly string[];
	mcpServers: McpServerInput[];
}

function isCliSwitchable(builtin: SdkBuiltinInput): boolean {
	// SDK 内置隐藏扩展（codemode / tool-search 等）不可单独启停：
	// settings-service 用 isInternalExtension 直接豁免 disabledExtensions。
	// 这里显式标记，前端按钮置灰 + 说明原因，绝不静默跳过（T3）。
	if (builtin.hidden) return false;
	return true;
}

/** #885 健康聚合（纯函数，只读）：status/error/enabled → health。 */
export function resolveMcpHealth(s: Pick<McpServerInput, "enabled" | "status" | "error">): {
	health: UiExtensionInventoryHealth;
	error?: string;
} {
	const err = typeof s.error === "string" && s.error.trim() ? s.error.trim() : undefined;
	if (err) return { health: "error", error: err };
	if (s.enabled === false) return { health: "stopped" };
	const status = typeof s.status === "string" ? s.status.trim() : "";
	if (status === "running") return { health: "online" };
	if (status === "error") return { health: "error" };
	if (status === "stopped") return { health: "offline" };
	return { health: "unknown" };
}

export function buildExtensionInventory(input: ExtensionInventoryInput): UiExtensionInventoryEntry[] {
	const disabledExts = new Set(input.disabledExtensions ?? []);
	const disabledPlugins = new Set(input.disabledPlugins ?? []);
	const out: UiExtensionInventoryEntry[] = [];

	for (const b of input.sdkBuiltins ?? []) {
		const name = String(b.name ?? "").trim();
		if (!name) continue;
		const switchable = isCliSwitchable(b);
		out.push({
			name,
			source: "cli",
			enabled: switchable ? !disabledExts.has(name) : true,
			description: b.hidden
				? `Pi CLI 内置扩展（随 agentDir 继承，隐藏加载） / Built-in Pi CLI extension (inherited via agentDir, hidden)`
				: `Pi CLI 扩展（随 agentDir 继承） / Pi CLI extension (inherited via agentDir)`,
			...(switchable ? {} : { switchable: false as const }),
		});
	}

	for (const p of input.plugins ?? []) {
		const id = String((p as { id?: unknown }).id ?? "").trim();
		if (!id) continue;
		const err = typeof p.error === "string" && p.error.trim() ? p.error.trim() : undefined;
		out.push({
			name: id,
			source: "webui",
			enabled: !disabledPlugins.has(id) && p.active !== false,
			version: typeof p.version === "string" ? p.version : undefined,
			description:
				typeof p.description === "string" && p.description.trim()
					? p.description.trim()
					: typeof p.name === "string" && p.name.trim() && p.name.trim() !== id
						? p.name.trim()
						: `WebUI 专属插件（可写） / WebUI-specific plugin (writable)`,
			...(err ? { error: err, health: "error" as const } : {}),
		});
	}

	for (const s of input.mcpServers ?? []) {
		const rawName = String((s as { name?: unknown }).name ?? "").trim();
		if (!rawName) continue;
		// 配置缺失的错误行（readMcpConfigFile 把 path 当 name 推入）同样透出，error 原文保留。
		const scope = s.scope === "project" ? "project" : "global";
		const { health, error: healthError } = resolveMcpHealth(s);
		const toolCount = Array.isArray(s.tools) ? s.tools.length : undefined;
		out.push({
			name: `mcp:${scope}:${rawName}`,
			source: "external",
			enabled: s.enabled !== false,
			description:
				typeof s.description === "string" && s.description.trim()
					? s.description.trim()
					: `MCP 服务器（${scope}，随 agentDir/cwd 继承） / MCP server (${scope}, inherited via agentDir/cwd)`,
			health,
			...(typeof toolCount === "number" ? { toolCount } : {}),
			...(healthError ? { error: healthError } : {}),
		});
	}

	// 稳定排序：来源 cli → webui → external，同组按 name 排序，保证快照可比。
	const order: Record<UiExtensionInventorySource, number> = { cli: 0, webui: 1, external: 2 };
	out.sort((a, b) => order[a.source] - order[b.source] || a.name.localeCompare(b.name));
	return out;
}

export interface ExtensionInventoryDeps {
	getSdkBuiltins: () => Promise<SdkBuiltinInput[]> | SdkBuiltinInput[];
	getDisabledExtensions: () => readonly string[] | Promise<readonly string[]>;
	getPlugins: () => Promise<WebuiPluginInput[]> | WebuiPluginInput[];
	getDisabledPlugins: () => readonly string[] | Promise<readonly string[]>;
	getMcpServers: () => Promise<McpServerInput[]> | McpServerInput[];
	/**
	 * #885 只读 connect probe（可选）：对单个 MCP 条目做非变更检查，
	 * 返回要合并的局部字段；抛错只记 entry.error，不抛到外层、不触发重装。
	 * 生产默认不传（直接用 listMcpServers 的 status/error/tools，已经是 bridge 连接结果）。
	 */
	probeMcp?: (server: McpServerInput) => Promise<Partial<McpServerInput> | void> | Partial<McpServerInput> | void;
}

/** 只读采集：每类来源独立 try/catch，失败只在条目里记 error，不抛错（T1/T4）。 */
export async function collectExtensionInventory(
	deps: ExtensionInventoryDeps,
): Promise<{ entries: UiExtensionInventoryEntry[]; errors: string[] }> {
	const errors: string[] = [];
	let sdkBuiltins: SdkBuiltinInput[] = [];
	let disabledExtensions: readonly string[] = [];
	let plugins: WebuiPluginInput[] = [];
	let disabledPlugins: readonly string[] = [];
	let mcpServers: McpServerInput[] = [];

	try {
		sdkBuiltins = (await deps.getSdkBuiltins()) ?? [];
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		errors.push(`cli: ${msg}`);
	}
	try {
		disabledExtensions = (await deps.getDisabledExtensions()) ?? [];
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		errors.push(`disabledExtensions: ${msg}`);
	}
	try {
		plugins = (await deps.getPlugins()) ?? [];
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		errors.push(`webui: ${msg}`);
		plugins = [];
	}
	try {
		disabledPlugins = (await deps.getDisabledPlugins()) ?? [];
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		errors.push(`disabledPlugins: ${msg}`);
	}
	try {
		mcpServers = (await deps.getMcpServers()) ?? [];
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		errors.push(`mcp: ${msg}`);
		mcpServers = [];
	}

	// #885 只读 probe：逐条 try/catch，失败只记该条 error，不抛错（connect probe 只读）。
	if (typeof deps.probeMcp === "function" && mcpServers.length > 0) {
		const probed: McpServerInput[] = [];
		for (const s of mcpServers) {
			try {
				const patch = (await deps.probeMcp(s)) as Partial<McpServerInput> | void;
				if (patch && typeof patch === "object") probed.push({ ...s, ...patch });
				else probed.push(s);
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				const prev =
					typeof s.error === "string" && s.error.trim() ? `${s.error.trim()}; probe: ${msg}` : `probe: ${msg}`;
				probed.push({ ...s, error: prev });
			}
		}
		mcpServers = probed;
	}

	const entries = buildExtensionInventory({
		sdkBuiltins,
		disabledExtensions,
		plugins,
		disabledPlugins,
		mcpServers: mcpServers as McpServerInput[],
	});
	// 来源整体加载失败时追加一条 error 占位，保证“坏了不知道找谁”可定位（T4）。
	// 标题由前端 ExtensionInventory 按语言渲染，这里不再挂中文文案（服务端字符串必须是纯英文）。
	for (const e of errors) {
		const [source] = e.split(":");
		const src = source.trim() === "cli" ? "cli" : source.trim() === "webui" ? "webui" : "external";
		entries.push({
			name: `__load_error__:${source.trim()}`,
			source: src as UiExtensionInventorySource,
			enabled: false,
			error: e,
			health: "error",
		});
	}
	return { entries, errors };
}

/** UiMcpServer → McpServerInput 适配（透传 error/status/tools 原文，只读）。 */
export function mcpServersToInput(servers: UiMcpServer[]): McpServerInput[] {
	return (servers ?? []).map((s) => ({
		name: s.name,
		scope: s.scope,
		enabled: s.enabled,
		description: (s as { description?: unknown }).description as string | undefined,
		status: (s as { status?: unknown }).status as string | undefined,
		error: (s as { error?: unknown }).error as string | undefined,
		tools: Array.isArray((s as { tools?: unknown }).tools)
			? ((s as { tools?: Array<{ name?: unknown; description?: unknown }> }).tools ?? []).map((t) => ({
					name: String(t?.name ?? ""),
					...(typeof t?.description === "string" ? { description: t.description } : {}),
				}))
			: undefined,
	}));
}
