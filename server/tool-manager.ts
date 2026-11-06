import type { UiAgentPreset, DshPermissionOption } from "./protocol.js";

export const CANVAS_TOOL_NAME = "canvas";
export const TERMINAL_TOOL_NAME = "terminal";
export const TERMINAL_TOOL_NAMES = [TERMINAL_TOOL_NAME] as const;
export const LEGACY_TERMINAL_TOOL_NAMES = [
	"terminal_create",
	"terminal_list",
	"terminal_close",
	"terminal_input",
	"terminal_key",
	"terminal_read",
	"terminal_wait",
] as const;

export const CONVERSATION_TOOL_NAME = "conversation";
export const COMMUNICATE_TOOL_NAME = "communicate";
export const SUBAGENT_TOOL_NAME = "subagent";
export const SUBAGENT_TOOL_NAMES = [CONVERSATION_TOOL_NAME, SUBAGENT_TOOL_NAME] as const;

export const LEGACY_SUBAGENT_TOOL_NAMES = [
	"subagent_spawn",
	"subagent_get_result",
	"subagent_steer",
	"subagent_list",
	"subagent_stop",
	"subagent_wait_all",
	"subagent_templates",
	"subagent_handoff",
] as const;

export const EDIT_SOFT_TOOL_NAME = "edit_soft";
export const DELEGATE_TASK_TOOL_NAME = "delegate_task";
export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";
export const BROWSER_PAGE_TOOL_NAME = "browser_page";
export const CONVERSATION_READ_TOOL_NAME = CONVERSATION_TOOL_NAME;
export const SKILL_TOOL_NAME = "skill";
export const SCHEDULE_TOOL_NAME = "schedule";
export const LEGACY_SCHEDULE_TOOL_NAMES = ["schedule_task", "schedule_list", "schedule_cancel"] as const;
export const EVAL_TOOL_NAME = "eval";
export const PRESENT_FILES_TOOL_NAME = "present_files";
export const CLAIM_FILES_TOOL_NAME = "claim_files";
export const PLAN_UPDATE_TOOL_NAME = "plan_update";
export const COMPACT_CONTEXT_TOOL_NAME = "compact_context";
export const PATCH_TOOL_NAME = "patch";
export const LSP_TOOL_NAME = "lsp";
export const MCP_MANAGE_TOOL_NAME = "mcp_manage";
export const SANDBOX_TOOL_NAME = "sandbox";
export const WORKTREE_TOOL_NAME = "worktree";
export const DEVICE_COLLAB_TOOL_NAME = "device_collab";
export const CODEMODE_TOOL_NAME = "codemode";
export const TOOL_SEARCH_TOOL_NAME = "tool_search";
export const LOAD_TOOLS_TOOL_NAME = "load_tools";
export const LAZY_CORE_TOOL_NAMES = ["bash", "read", "edit", "write"] as const;

export type AgentToolGroup = "core" | "terminal" | "subagent" | "other";

export interface AgentToolEntry {
	name: string;
	group: AgentToolGroup;
	defaultOn: boolean;
	platform?: "win32" | "posix";
	allowAgentToggle?: boolean;
	dshVisible: boolean;
	descKey?: string;
	offHintKey?: string;
}

export const AGENT_TOOL_CATALOG: AgentToolEntry[] = [
	...TERMINAL_TOOL_NAMES.map((name): AgentToolEntry => ({
		name,
		group: "terminal",
		defaultOn: false,
		dshVisible: true,
	})),
	...SUBAGENT_TOOL_NAMES.map((name): AgentToolEntry => ({
		name,
		group: "subagent",
		defaultOn: true,
		dshVisible: false,
	})),
	{
		name: COMMUNICATE_TOOL_NAME,
		group: "subagent",
		defaultOn: true,
		dshVisible: false,
		descKey: "communicateEnabledDesc",
		offHintKey: "communicateOffHint",
	},
	{
		name: EDIT_SOFT_TOOL_NAME,
		group: "other",
		defaultOn: false,
		dshVisible: false,
		descKey: "editSoftEnabledDesc",
		offHintKey: "editSoftOffHint",
	},
	{
		name: DELEGATE_TASK_TOOL_NAME,
		group: "other",
		defaultOn: true,
		dshVisible: false,
		descKey: "delegateTaskEnabledDesc",
		offHintKey: "delegateTaskOffHint",
	},
	{
		name: ASK_USER_QUESTION_TOOL_NAME,
		group: "other",
		defaultOn: true,
		dshVisible: true,
		descKey: "questionnaireEnabledDesc",
		offHintKey: "questionnaireOffHint",
	},
	{
		name: BROWSER_PAGE_TOOL_NAME,
		group: "other",
		defaultOn: false,
		dshVisible: false,
		descKey: "browserPageEnabledDesc",
		offHintKey: "browserPageOffHint",
	},
	{
		name: CLAIM_FILES_TOOL_NAME,
		group: "other",
		defaultOn: true,
		dshVisible: false,
		descKey: "claimFilesEnabledDesc",
		offHintKey: "claimFilesOffHint",
	},
	{
		name: PLAN_UPDATE_TOOL_NAME,
		group: "other",
		defaultOn: true,
		dshVisible: true,
		descKey: "planUpdateEnabledDesc",
		offHintKey: "planUpdateOffHint",
	},
	{
		name: PATCH_TOOL_NAME,
		group: "other",
		defaultOn: true,
		dshVisible: false,
		descKey: "patchToolEnabledDesc",
		offHintKey: "patchToolOffHint",
	},
	{
		name: LSP_TOOL_NAME,
		group: "other",
		defaultOn: false,
		dshVisible: false,
		descKey: "lspToolEnabledDesc",
		offHintKey: "lspToolOffHint",
	},
	{
		name: PRESENT_FILES_TOOL_NAME,
		group: "other",
		defaultOn: true,
		dshVisible: false,
		descKey: "presentFilesEnabledDesc",
		offHintKey: "presentFilesOffHint",
	},
	{
		name: SKILL_TOOL_NAME,
		group: "other",
		defaultOn: true,
		dshVisible: false,
		descKey: "skillEnabledDesc",
		offHintKey: "skillOffHint",
	},
	{
		name: EVAL_TOOL_NAME,
		group: "other",
		defaultOn: false,
		dshVisible: false,
		descKey: "evalEnabledDesc",
		offHintKey: "evalOffHint",
	},
	{
		name: CODEMODE_TOOL_NAME,
		group: "other",
		defaultOn: false,
		dshVisible: false,
		descKey: "codemodeEnabledDesc",
		offHintKey: "codemodeOffHint",
	},
	{
		name: TOOL_SEARCH_TOOL_NAME,
		group: "other",
		defaultOn: false,
		dshVisible: false,
		descKey: "toolSearchEnabledDesc",
		offHintKey: "toolSearchOffHint",
	},
	{
		name: SCHEDULE_TOOL_NAME,
		group: "other",
		defaultOn: true,
		dshVisible: false,
		descKey: "scheduleTaskEnabledDesc",
		offHintKey: "scheduleTaskOffHint",
	},
	{
		name: COMPACT_CONTEXT_TOOL_NAME,
		group: "other",
		defaultOn: true,
		dshVisible: false,
		descKey: "compactContextEnabledDesc",
		offHintKey: "compactContextOffHint",
	},
	{
		name: MCP_MANAGE_TOOL_NAME,
		group: "other",
		defaultOn: false,
		dshVisible: false,
		descKey: "mcpManageEnabledDesc",
		offHintKey: "mcpManageOffHint",
	},
	{
		name: SANDBOX_TOOL_NAME,
		group: "other",
		defaultOn: true,
		dshVisible: false,
		descKey: "sandboxEnabledDesc",
		offHintKey: "sandboxOffHint",
	},
	{
		name: WORKTREE_TOOL_NAME,
		group: "other",
		defaultOn: true,
		dshVisible: false,
		descKey: "toolsWorktreeDesc",
		offHintKey: "toolsWorktreeOffHint",
	},
	{
		name: CANVAS_TOOL_NAME,
		group: "other",
		defaultOn: true,
		dshVisible: false,
		descKey: "canvasToolEnabledDesc",
		offHintKey: "canvasToolOffHint",
	},
];

export const GROUP_BOT_TOOL_CATALOG: readonly AgentToolEntry[] = [
	{
		name: DEVICE_COLLAB_TOOL_NAME,
		group: "other",
		defaultOn: false,
		allowAgentToggle: false,
		dshVisible: false,
		descKey: "toolsDeviceCollabDesc",
		offHintKey: "toolsDeviceCollabOffHint",
	},
] as const;

export const CORE_BUILTIN_TOOL_NAMES = ["bash", "read", "edit", "write", "powershell", "ls", "grep", "find"] as const;

export type CoreBuiltinToolName = (typeof CORE_BUILTIN_TOOL_NAMES)[number];

export interface CoreToolEntry {
	name: CoreBuiltinToolName;
	group: "core";
	defaultOn: boolean;
	platform?: "win32" | "posix";
	allowAgentToggle?: boolean;
	descKey: string;
}

export const CORE_TOOL_CATALOG: readonly CoreToolEntry[] = [
	{ name: "bash", group: "core", defaultOn: true, allowAgentToggle: false, descKey: "toolCoreBashDesc" },
	{ name: "read", group: "core", defaultOn: true, allowAgentToggle: false, descKey: "toolCoreReadDesc" },
	{ name: "edit", group: "core", defaultOn: true, allowAgentToggle: false, descKey: "toolCoreEditDesc" },
	{ name: "write", group: "core", defaultOn: true, allowAgentToggle: false, descKey: "toolCoreWriteDesc" },
	{
		name: "powershell",
		group: "core",
		defaultOn: false,
		platform: "win32",
		allowAgentToggle: false,
		descKey: "toolCorePowershellDesc",
	},
	{ name: "ls", group: "core", defaultOn: true, allowAgentToggle: false, descKey: "toolCoreLsDesc" },
	{ name: "grep", group: "core", defaultOn: true, allowAgentToggle: false, descKey: "toolCoreGrepDesc" },
	{ name: "find", group: "core", defaultOn: true, allowAgentToggle: false, descKey: "toolCoreFindDesc" },
] as const;

export const ALL_AGENT_TOOL_ENTRIES: readonly AgentToolEntry[] = [
	...CORE_TOOL_CATALOG.map((c): AgentToolEntry => ({
		name: c.name,
		group: "core",
		defaultOn: c.defaultOn,
		platform: c.platform,
		allowAgentToggle: c.allowAgentToggle,
		dshVisible: false,
		descKey: c.descKey,
	})),
	...AGENT_TOOL_CATALOG,
	...GROUP_BOT_TOOL_CATALOG,
];

const ALL_AGENT_TOOL_MAP = new Map<string, AgentToolEntry>(ALL_AGENT_TOOL_ENTRIES.map((t) => [t.name, t]));

export function getAgentToolEntry(name: string): AgentToolEntry | undefined {
	return ALL_AGENT_TOOL_MAP.get(name);
}

export function isToolSupportedOnPlatform(name: string, platform: NodeJS.Platform = process.platform): boolean {
	const entry = ALL_AGENT_TOOL_MAP.get(name);
	if (!entry?.platform) return true;
	if (entry.platform === "win32") return platform === "win32";
	if (entry.platform === "posix") return platform !== "win32";
	return true;
}

export function isCoreBuiltinTool(name: string): name is CoreBuiltinToolName {
	return (CORE_BUILTIN_TOOL_NAMES as readonly string[]).includes(name);
}

const ALL_KNOWN_SET = new Set(ALL_AGENT_TOOL_ENTRIES.map((t) => t.name));

export const ALL_KNOWN_AGENT_TOOL_NAMES: readonly string[] = ALL_AGENT_TOOL_ENTRIES.map((t) => t.name);

export function isKnownAgentTool(name: string): boolean {
	const entry = ALL_AGENT_TOOL_MAP.get(name);
	return Boolean(entry && entry.allowAgentToggle !== false);
}

export function isHostManagedTool(name: string): boolean {
	return ALL_KNOWN_SET.has(name);
}

export function isConfigurableAgentTool(name: string): boolean {
	return isHostManagedTool(name);
}

export function resolveEnabledAgentTools(disabled: readonly string[]): string[] {
	const disabledSet = new Set(normalizeDisabledAgentTools(disabled));
	return ALL_KNOWN_AGENT_TOOL_NAMES.filter((name) => !disabledSet.has(name));
}

export function resolveDisabledAgentToolsFromEnabled(enabled: readonly string[]): string[] {
	const enabledSet = new Set(enabled);
	if (LEGACY_TERMINAL_TOOL_NAMES.every((name) => enabledSet.has(name))) enabledSet.add(TERMINAL_TOOL_NAME);
	return ALL_KNOWN_AGENT_TOOL_NAMES.filter((name) => !enabledSet.has(name));
}

export function normalizeDisabledAgentTools(v: unknown): string[] {
	if (!Array.isArray(v)) return defaultDisabledAgentTools();
	const out: string[] = [];
	for (const x of v) {
		let name = x;
		if (typeof name === "string" && (LEGACY_TERMINAL_TOOL_NAMES as readonly string[]).includes(name)) {
			name = TERMINAL_TOOL_NAME;
		}
		if (typeof name === "string" && (LEGACY_SUBAGENT_TOOL_NAMES as readonly string[]).includes(name)) {
			name = CONVERSATION_TOOL_NAME;
		}
		if (name === "conversation_read") name = CONVERSATION_TOOL_NAME;
		if (typeof name === "string" && (SUBAGENT_TOOL_NAMES as readonly string[]).includes(name)) {
			for (const alias of SUBAGENT_TOOL_NAMES) if (!out.includes(alias)) out.push(alias);
			continue;
		}
		if (typeof name === "string" && (LEGACY_SCHEDULE_TOOL_NAMES as readonly string[]).includes(name)) {
			name = SCHEDULE_TOOL_NAME;
		}
		if (typeof name === "string" && ALL_KNOWN_SET.has(name) && !out.includes(name)) {
			out.push(name);
		}
	}
	return out;
}

export function defaultDisabledAgentTools(): string[] {
	return ALL_AGENT_TOOL_ENTRIES.filter((t) => !t.defaultOn).map((t) => t.name);
}

export function isAgentToolEnabled(name: string, disabled: readonly string[]): boolean {
	return !disabled.includes(name);
}

export interface ActiveToolSet {
	getActiveToolNames(): string[];
	setActiveToolsByName(names: string[]): void;
	getAllTools(): Array<{
		name: string;
		namespace?: { name?: string };
		exposure?: string;
	}>;
}

export function setAgentToolEnabled(session: ActiveToolSet, name: string, on: boolean): boolean {
	if (!isKnownAgentTool(name)) return false;
	try {
		const names = new Set(session.getActiveToolNames());
		if (on) names.add(name);
		else names.delete(name);
		session.setActiveToolsByName([...names]);
		return true;
	} catch {
		return false;
	}
}

export function setAgentToolsEnabled(session: ActiveToolSet, names: readonly string[], on: boolean): number {
	const known = names.filter(isKnownAgentTool);
	if (known.length === 0) return 0;
	try {
		const active = new Set(session.getActiveToolNames());
		for (const n of known) {
			if (on) active.add(n);
			else active.delete(n);
		}
		session.setActiveToolsByName([...active]);
		return known.length;
	} catch {
		return 0;
	}
}

export function applyAgentToolsGating(
	session: ActiveToolSet,
	disabled: readonly string[],
	preset?: string,
	options?: {
		forceActive?: readonly string[];
	},
): void {
	try {
		const off = new Set(disabled);
		const allNames = session.getAllTools().map((t) => t.name);
		const initialActiveNames = new Set(session.getActiveToolNames());

		const names = new Set<string>();
		for (const name of allNames) {
			if (isHostManagedTool(name)) {
				names.add(name);
			} else if (initialActiveNames.has(name) && !off.has(name)) {
				names.add(name);
			}
		}

		for (const t of AGENT_TOOL_CATALOG) {
			if (off.has(t.name)) {
				const isShadowedCustomTool = (SUBAGENT_TOOL_NAMES as readonly string[]).includes(t.name);
				const hasExtensionTool =
					isShadowedCustomTool &&
					Boolean(
						(
							session as {
								extensionRunner?: { getAllRegisteredTools?: () => Array<{ definition?: { name?: string } }> };
							}
						)?.extensionRunner
							?.getAllRegisteredTools?.()
							?.some((tool) => tool.definition?.name === t.name),
					);
				if (!hasExtensionTool) {
					names.delete(t.name);
				}
			} else {
				names.add(t.name);
			}
		}
		for (const core of CORE_BUILTIN_TOOL_NAMES) {
			if (off.has(core)) names.delete(core);
			else if (allNames.includes(core)) names.add(core);
		}
		names.delete(LOAD_TOOLS_TOOL_NAME);
		const allToolsSnapshot = session.getAllTools?.() ?? [];
		let hasDeferredMcp = false;
		for (const t of allToolsSnapshot) {
			const ns = t?.namespace?.name ?? "";
			if (typeof ns !== "string" || !ns.startsWith("mcp__")) continue;
			const exp = t.exposure ?? "codemode";
			if (exp === "direct" || exp === "model-only") continue;
			names.delete(t.name);
			if (exp === "deferred") hasDeferredMcp = true;
		}
		if (hasDeferredMcp && allNames.includes("tool_search") && !off.has("tool_search")) names.add("tool_search");
		const filtered = filterToolsByPreset(names, preset);
		const active = new Set(filtered);
		const baseline = new Set(allNames);
		for (const name of options?.forceActive ?? []) {
			if (baseline.has(name) && !off.has(name)) active.add(name);
		}
		session.setActiveToolsByName([...active]);
	} catch {}
}

export function lazyLoadingDisabledTools(
	allNames: readonly string[],
	loaded: Iterable<string>,
	core: readonly string[] = LAZY_CORE_TOOL_NAMES,
): string[] {
	const keep = new Set<string>([...core, LOAD_TOOLS_TOOL_NAME, ...loaded]);
	return allNames.filter((n) => !keep.has(n));
}

export const PI_AGENT_PRESETS: UiAgentPreset[] = [
	{
		id: "standard",
		trust: "system",
		isDefault: true,
		name: "全功能",
		nameEn: "Full access",
		description: "提供全部可用工具与扩展能力（默认）",
		descriptionEn: "All available tools and extension capabilities (default)",
		order: 0,
	},
	{
		id: "minimal",
		trust: "system",
		isDefault: false,
		name: "极简模式",
		nameEn: "Minimal",
		description: "仅保留 bash 与 read；插件工具、技能名录与终端引导同步隐藏",
		descriptionEn: "Keeps only bash and read; plugin tools, skill catalog and terminal guidance are hidden too",
		order: 1,
	},
	{
		id: "code",
		trust: "system",
		isDefault: false,
		name: "代码开发",
		nameEn: "Code development",
		description: "专注于代码读写与执行（bash, read, edit, write, edit_soft）；插件工具与技能名录同步隐藏",
		descriptionEn:
			"Focused on reading, writing and running code (bash, read, edit, write, edit_soft); plugin tools and skill catalog are hidden too",
		order: 2,
	},
	{
		id: "reader",
		trust: "system",
		isDefault: false,
		name: "只读分析",
		nameEn: "Read-only analysis",
		description: "仅保留只读工具，禁止写操作；插件工具同步隐藏（读写未知，保守处理）",
		descriptionEn:
			"Keeps only read-only tools and forbids writes; plugin tools are hidden too (read/write unknown, handled conservatively)",
		order: 3,
	},
	{
		id: "ask",
		trust: "system",
		isDefault: false,
		name: "纯对话",
		nameEn: "Chat only",
		description: "无工具问答模式，模型不调用任何工具；插件工具与技能名录同步隐藏",
		descriptionEn: "No-tools Q&A: the model never calls a tool; plugin tools and skill catalog are hidden too",
		order: 4,
	},
];

export const PI_PERMISSION_OPTIONS: DshPermissionOption[] = [
	{
		value: "read-only",
		name: "只读模式",
		nameEn: "Read Only",
		description: "禁止所有文件修改（write/edit/edit_soft）及任何非只读操作",
		descriptionEn: "Forbids all file modification (write/edit/edit_soft) and any non-read-only operation",
	},
	{
		value: "workspace-write-never",
		name: "工作区内修改",
		nameEn: "Workspace Write",
		description: "仅允许在当前工作区目录下修改文件，工作区外写操作一律拒绝",
		descriptionEn: "Only files under the current workspace may be modified; writes outside it are always denied",
	},
	{
		value: "danger-full-access",
		name: "完全权限",
		nameEn: "Full access",
		description: "允许修改任意目录文件及执行全量操作（需要二次确认）",
		descriptionEn: "Allows modifying files anywhere and running any operation (needs a second confirmation)",
	},
];

export function localizedName(
	item: { name?: string; nameEn?: string } | undefined,
	lang: string,
	fallback = "",
): string {
	if (!item) return fallback;
	return lang === "zh" ? (item.name ?? item.nameEn ?? fallback) : (item.nameEn ?? item.name ?? fallback);
}

export function localizedDescription(
	item: { description?: string; descriptionEn?: string } | undefined,
	lang: string,
): string | undefined {
	if (!item) return undefined;
	return lang === "zh" ? (item.description ?? item.descriptionEn) : (item.descriptionEn ?? item.description);
}

export function filterToolsByPreset(tools: Iterable<string>, preset?: string): string[] {
	const all = Array.from(tools);
	if (!preset || preset === "standard") return all;
	if (preset === "ask") return [];
	if (preset === "minimal") {
		return all.filter((n) => n === "bash" || n === "read");
	}
	if (preset === "code") {
		const codeSet = new Set(["bash", "read", "edit", "write", "edit_soft"]);
		return all.filter((n) => codeSet.has(n));
	}
	if (preset === "reader") {
		const writeTools = new Set([
			"write",
			"edit",
			"edit_soft",
			"bash",
			"powershell",
			"terminal_create",
			"terminal_input",
			"terminal_close",
			"terminal_key",
			"codemode",
		]);
		return all.filter((n) => !writeTools.has(n));
	}
	return all;
}

export function presetAllowsPluginTools(preset?: string): boolean {
	if (!preset || preset === "standard") return true;
	return !PI_AGENT_PRESETS.some((p) => p.id === preset);
}

export function presetShowsSkillCatalog(preset?: string): boolean {
	return filterToolsByPreset([SKILL_TOOL_NAME], preset).includes(SKILL_TOOL_NAME);
}

export function presetHasQuestionnaire(preset?: string): boolean {
	return filterToolsByPreset([ASK_USER_QUESTION_TOOL_NAME], preset).includes(ASK_USER_QUESTION_TOOL_NAME);
}

export interface LegacyToolSwitches {
	terminalToolsEnabled?: boolean;
	editSoftEnabled?: boolean;
	questionnaireEnabled?: boolean;
	disabledAgentTools?: unknown;
}

export function legacyToDisabled(s: LegacyToolSwitches): string[] {
	if (Array.isArray(s.disabledAgentTools)) return normalizeDisabledAgentTools(s.disabledAgentTools);
	const off = new Set(defaultDisabledAgentTools());
	if (s.terminalToolsEnabled === true) {
		for (const n of TERMINAL_TOOL_NAMES) off.delete(n);
	}
	if (s.editSoftEnabled === true) off.delete(EDIT_SOFT_TOOL_NAME);
	if (s.questionnaireEnabled === false) off.add(ASK_USER_QUESTION_TOOL_NAME);
	return normalizeDisabledAgentTools([...off]);
}

export function deriveLegacy(disabled: readonly string[]): {
	terminalToolsEnabled: boolean;
	editSoftEnabled: boolean;
	questionnaireEnabled: boolean;
} {
	const off = new Set(disabled);
	return {
		terminalToolsEnabled: TERMINAL_TOOL_NAMES.every((n) => !off.has(n)),
		editSoftEnabled: !off.has(EDIT_SOFT_TOOL_NAME),
		questionnaireEnabled: !off.has(ASK_USER_QUESTION_TOOL_NAME),
	};
}

export function foldLegacyIntoDisabled(
	current: readonly string[],
	legacy: Pick<LegacyToolSwitches, "terminalToolsEnabled" | "editSoftEnabled" | "questionnaireEnabled">,
): string[] {
	const next = new Set(normalizeDisabledAgentTools(current));
	const applyGroup = (names: readonly string[], v: boolean | undefined) => {
		if (v === undefined) return;
		for (const n of names) {
			if (v) next.delete(n);
			else next.add(n);
		}
	};
	applyGroup(TERMINAL_TOOL_NAMES, legacy.terminalToolsEnabled);
	applyGroup([EDIT_SOFT_TOOL_NAME], legacy.editSoftEnabled);
	applyGroup([ASK_USER_QUESTION_TOOL_NAME], legacy.questionnaireEnabled);
	return [...next];
}

export function effectiveDisabledAgentTools(s: LegacyToolSwitches): string[] {
	const next = new Set(legacyToDisabled({ ...s, disabledAgentTools: s.disabledAgentTools }));
	if (s.questionnaireEnabled === false) next.add(ASK_USER_QUESTION_TOOL_NAME);
	return [...next];
}

export function isTerminalGuidanceOn(disabled: readonly string[], preset?: string): boolean {
	const on = TERMINAL_TOOL_NAMES.filter((n) => !disabled.includes(n));
	if (on.length === 0) return false;
	if (!preset || preset === "standard") return true;
	return filterToolsByPreset(on, preset).length > 0;
}
