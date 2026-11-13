// #885 T1：扩展统一清单（只读聚合，不改运行时）
// 三类来源：
//  - cli：Pi CLI SDK 内置扩展（getSdkBuiltinExtensionFactories）
//  - webui：WebUI 插件（PluginManager.list → UiPluginInfo）
//  - external：MCP 服务器（global + project，listAllMcpServers）
// 统一 shape：{ name, source, enabled, version?, description?, error? }
// 失败只记录 error 原文，不抛错、不触发重装、不写运行时。

import type { UiMcpServer } from "./protocol.js";
import type { UiExtensionInventoryEntry, UiExtensionInventorySource } from "./protocol.js";

export type { UiExtensionInventoryEntry, UiExtensionInventorySource };

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
			...(err ? { error: err } : {}),
		});
	}

	for (const s of input.mcpServers ?? []) {
		const rawName = String((s as { name?: unknown }).name ?? "").trim();
		if (!rawName) continue;
		// 配置缺失的错误行（readMcpConfigFile 把 path 当 name 推入）同样透出，error 原文保留。
		const scope = s.scope === "project" ? "project" : "global";
		const err = typeof s.error === "string" && s.error.trim() ? s.error.trim() : undefined;
		out.push({
			name: `mcp:${scope}:${rawName}`,
			source: "external",
			enabled: s.enabled !== false,
			description:
				typeof s.description === "string" && s.description.trim()
					? s.description.trim()
					: `MCP 服务器（${scope}，随 agentDir/cwd 继承） / MCP server (${scope}, inherited via agentDir/cwd)`,
			...(err ? { error: err } : {}),
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

	const entries = buildExtensionInventory({
		sdkBuiltins,
		disabledExtensions,
		plugins,
		disabledPlugins,
		mcpServers: mcpServers as McpServerInput[],
	});
	// 来源整体加载失败时追加一条 error 占位，保证“坏了不知道找谁”可定位（T4）。
	for (const e of errors) {
		const [source] = e.split(":");
		const src = source.trim() === "cli" ? "cli" : source.trim() === "webui" ? "webui" : "external";
		entries.push({
			name: `__load_error__:${source.trim()}`,
			source: src as UiExtensionInventorySource,
			enabled: false,
			description: "加载失败（只读展示，无需重装应用） / Load failed (read-only, no reinstall needed)",
			error: e,
		});
	}
	return { entries, errors };
}

/** UiMcpServer → McpServerInput 适配（透传 error 原文）。 */
export function mcpServersToInput(servers: UiMcpServer[]): McpServerInput[] {
	return (servers ?? []).map((s) => ({
		name: s.name,
		scope: s.scope,
		enabled: s.enabled,
		description: (s as { description?: unknown }).description as string | undefined,
		status: (s as { status?: unknown }).status as string | undefined,
		error: (s as { error?: unknown }).error as string | undefined,
	}));
}
