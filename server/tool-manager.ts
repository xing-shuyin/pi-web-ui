/**
 * tool-manager.ts — Agent 工具开关的唯一事实源 + 统一出入口（tool_manage）。
 *
 * 背景：工具启用散在 4 种写法里——applyToolGating 只会 terminal_* + edit_soft、
 * “子代理系列”/delegate_task/ask_user_question/markers_list 注册即常驻（无开关）、
 * skills/extensions 走 resourceLoader 过滤（要 reload）、terminalBash 等是行为
 * 分支。本模块只收 **ActiveSet 层**（SDK customTools 经
 * getActiveToolNames/setActiveToolsByName 的启用/禁用，live 生效、无需 reload）；
 * skills/extensions（资源过滤，另一生命周期）与行为开关不进此表。
 *
 * 持久化只有 `ClientSettings.disabledAgentTools: string[]`（禁用的工具名）；
 * 旧的 terminalToolsEnabled/editSoftEnabled/questionnaireEnabled 作为遗留别名
 * 保留（协议兼容），由本模块的 legacy*  helper 双向同步。
 *
 * 纯模块：零 node 依赖（不 import 任何 server 模块），前端可直接 import
 * （vite 构建不断），单测零开销。
 */

/** 持久终端工具（定义见 terminals.ts，工具名在此唯一登记）。 */
export const TERMINAL_TOOL_NAMES = [
	"terminal_create",
	"terminal_list",
	"terminal_close",
	"terminal_input",
	"terminal_key",
	"terminal_read",
	"terminal_wait",
] as const;

/** 第一方子代理工具（定义见 subagents.ts，逐个可关）。 */
export const SUBAGENT_TOOL_NAMES = [
	"subagent_spawn",
	"subagent_get_result",
	"subagent_steer",
	"subagent_list",
	"subagent_stop",
	"subagent_wait_all",
	"subagent_templates",
] as const;

/** 独立宽松编辑工具（定义见 edit-soft-tool.ts）。 */
export const EDIT_SOFT_TOOL_NAME = "edit_soft";
/** 结构化派单工具（定义见 delegate-task.ts，执行体复用子代理 spawn 通道）。 */
export const DELEGATE_TASK_TOOL_NAME = "delegate_task";
/** 问卷提问工具（定义见 agent-service.ts makeAskUserQuestionTool）。 */
export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";
/** 任务列表只读查询工具（定义见 agent-service.ts makeMarkersListTool；只服务 todo）。
 * 曾用名 markers_list（名过其实，已迁移，见 normalizeDisabledAgentTools）。 */
export const MARKERS_LIST_TOOL_NAME = "todo_list";
/** 浏览器页面操作工具（定义见 agent-service.ts makeBrowserPageTool）：模型经
 *  page-picker 浏览器扩展读/操作用户已授权的页面。 */
export const BROWSER_PAGE_TOOL_NAME = "browser_page";
/** 别的对话读取工具（定义见 conversation-read-tool.ts）：运行中对话（含子代理）+
 *  历史会话转录，只读。 */
export const CONVERSATION_READ_TOOL_NAME = "conversation_read";
/** 技能全文按名加载工具（定义见 skill-tool.ts）：名录见 {{skills}} 段，
 *  全文走本工具按需取，不再让模型拼路径调 read。 */
export const SKILL_TOOL_NAME = "skill";
/** 定时任务工具（定义见 schedule-agent-tool.ts）：创建/查看/取消内置调度任务，
 *  到期自动唤醒发起对话执行 prompt 并汇报。 */
export const SCHEDULE_TASK_TOOL_NAME = "schedule_task";
export const SCHEDULE_LIST_TOOL_NAME = "schedule_list";
export const SCHEDULE_CANCEL_TOOL_NAME = "schedule_cancel";
/** 持久代码求值沙箱工具（定义见 eval-tool.ts）：在受控持久内核中执行 Python 或 JS/TS 代码。 */
export const EVAL_TOOL_NAME = "eval";
/** 展示文件工具（定义见 present-files-tool.ts）：把图片/视频/文本作为预览卡片
 *  推到对话里，卡片带预览/本地打开/在文件夹中显示/下载/复制路径。 */
export const PRESENT_FILES_TOOL_NAME = "present_files";
/** 文件认领工具（定义见 claim-files-tool.ts）：声明要改哪些文件，让同项目的
 *  并行对话绕行（纯建议，不拦编辑）。 */
export const CLAIM_FILES_TOOL_NAME = "claim_files";
/** 旧工具名（持久化迁移用；新代码一律用 MARKERS_LIST_TOOL_NAME）。 */
export const LEGACY_MARKERS_LIST_TOOL_NAME = "markers_list";

export type AgentToolGroup = "terminal" | "subagent" | "other";

export interface AgentToolEntry {
	name: string;
	group: AgentToolGroup;
	/** 默认开关（终端组/edit_soft/browser_page 默认关，其余默认开：AI 动用户浏览器须 opt-in）。 */
	defaultOn: boolean;
	/** DSH 引擎是否展示（DSH 无子代理/edit_soft 概念；目前 DSH 不用本表，预留）。 */
	dshVisible: boolean;
	/**
	 * 设置页「其他」组开关行的文案 key（SettingsModal 用 tt 按名取；缺失回落工具名）。
	 * 终端/子代理组走各自的通用文案不用填；「其他」组必填（单测强制），否则新工具
	 * 的行就没有说明。顺序即设置页渲染顺序（todo_list 例外，见下）。
	 */
	descKey?: string;
	offHintKey?: string;
}

/** 可开关的 Agent 工具总目录（共 27 个；bash 本体与 SDK 内置 edit/read
 *  不进目录——关了 agent 就残了，不给关）。 */
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
	// 默认关（AI 动用户浏览器，opt-in 才开）且 dshVisible=false：DSH 引擎没有页面桥
	// （page_request 由 pi 引擎的 customTool 发出），列在那里只会让用户关一个不存在的工具。
	{
		name: BROWSER_PAGE_TOOL_NAME,
		group: "other",
		defaultOn: false,
		dshVisible: false,
		descKey: "browserPageEnabledDesc",
		offHintKey: "browserPageOffHint",
	},
	// 只读别的对话（含子代理实时消息与历史转录），默认开；DSH 引擎没有该 customTool。
	{
		name: CONVERSATION_READ_TOOL_NAME,
		group: "other",
		defaultOn: true,
		dshVisible: false,
		descKey: "conversationReadEnabledDesc",
		offHintKey: "conversationReadOffHint",
	},
	// 文件认领（事前打招呼，纯 advisory）：默认开，不打开 AI 不知道能认领；
	// 关掉只少一路提醒（事后触碰集照常工作）；DSH 引擎没有该 customTool
	// （走 goal-rpc，无 customTool 注册面），提醒是服务端算的、DSH 照样能看到。
	{
		name: CLAIM_FILES_TOOL_NAME,
		group: "other",
		defaultOn: true,
		dshVisible: false,
		descKey: "claimFilesEnabledDesc",
		offHintKey: "claimFilesOffHint",
	},
	// 展示文件给用户（图片/视频内联、文本开预览弹窗、本地打开按钮）：默认开，
	// 不打开模型根本不知道能“给用户看”；DSH 引擎没有该 customTool（走 shipped preset）。
	{
		name: PRESENT_FILES_TOOL_NAME,
		group: "other",
		defaultOn: true,
		dshVisible: false,
		descKey: "presentFilesEnabledDesc",
		offHintKey: "presentFilesOffHint",
	},
	// 技能全文按名加载（名录仍在 {{skills}} 段），默认开；DSH 引擎没有该 customTool
	// （走 goal-rpc，无 customTool 注册面）。
	{
		name: SKILL_TOOL_NAME,
		group: "other",
		defaultOn: true,
		dshVisible: false,
		descKey: "skillEnabledDesc",
		offHintKey: "skillOffHint",
	},
	// 持久代码求值沙箱（Python / Node.js）：默认关（opt-in，防工具挤占）；
	// DSH 引擎没有该 customTool。
	{
		name: EVAL_TOOL_NAME,
		group: "other",
		defaultOn: false,
		dshVisible: false,
		descKey: "evalEnabledDesc",
		offHintKey: "evalOffHint",
	},
	// 定时/延时唤醒：默认开（不打开 AI 根本不知道能定时；60s 间隔底线＋面板可随时取消），
	// DSH 引擎没有该 customTool（走 goal-rpc，无 customTool 注册面）。
	{
		name: SCHEDULE_TASK_TOOL_NAME,
		group: "other",
		defaultOn: true,
		dshVisible: false,
		descKey: "scheduleTaskEnabledDesc",
		offHintKey: "scheduleTaskOffHint",
	},
	{
		name: SCHEDULE_LIST_TOOL_NAME,
		group: "other",
		defaultOn: true,
		dshVisible: false,
		descKey: "scheduleTaskEnabledDesc",
		offHintKey: "scheduleTaskOffHint",
	},
	{
		name: SCHEDULE_CANCEL_TOOL_NAME,
		group: "other",
		defaultOn: true,
		dshVisible: false,
		descKey: "scheduleTaskEnabledDesc",
		offHintKey: "scheduleTaskOffHint",
	},
	// todo_list 唯一例外：行不在「其他」组，固定在上面的 markers 分区（设置页循环
	// 跳过它，见 OTHER_AGENT_TOOLS；文案 key 照给，万一哪天搬家不用补）。
	{
		name: MARKERS_LIST_TOOL_NAME,
		group: "other",
		defaultOn: true,
		dshVisible: true,
		descKey: "todoListEnabledDesc",
		offHintKey: "todoListOffHint",
	},
];

const KNOWN_NAMES = new Set(AGENT_TOOL_CATALOG.map((t) => t.name));

/** 是否为本表登记的可开关工具（未知名一律 false，不抛错）。 */
export function isKnownAgentTool(name: string): boolean {
	return KNOWN_NAMES.has(name);
}

/** 归一化禁用名单：非数组回落默认（= 默认关的那些）；数组则只保留已知工具名
 *  （去重；未知名丢弃，防旧文件/手写脏数据污染）。 */
export function normalizeDisabledAgentTools(v: unknown): string[] {
	if (!Array.isArray(v)) return defaultDisabledAgentTools();
	const out: string[] = [];
	for (const x of v) {
		// 旧名迁移：markers_list → todo_list（改名前已关闭的用户保持关闭）。
		const name = x === LEGACY_MARKERS_LIST_TOOL_NAME ? MARKERS_LIST_TOOL_NAME : x;
		if (typeof name === "string" && KNOWN_NAMES.has(name) && !out.includes(name)) out.push(name);
	}
	return out;
}

/** 默认禁用名单（= 目录里 defaultOn=false 的那些）。 */
export function defaultDisabledAgentTools(): string[] {
	return AGENT_TOOL_CATALOG.filter((t) => !t.defaultOn).map((t) => t.name);
}

/** 单个工具是否启用（禁用名单里没有 = 启用）。 */
export function isAgentToolEnabled(name: string, disabled: readonly string[]): boolean {
	return !disabled.includes(name);
}

/** ActiveSet 子集（SDK AgentSession 的门控面；结构化类型便于单测传假对象）。 */
export interface ActiveToolSet {
	getActiveToolNames(): string[];
	setActiveToolsByName(names: string[]): void;
}

/**
 * 统一出入口 tool_manage：开关任意一个已登记的工具（live 生效，无需 reload；
 * 工具仍留在注册表，重开可直接加回）。未知工具名返回 false（不抛错，
 * 调用方据此给 AI/用户报错）；session 未就绪同样返回 false。
 */
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

/** 批量版（组头全开/全关用；含未知名时照常处理已知部分，返回实际处理数）。 */
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

/**
 * 全量重放（创建会话 / reload 后 / 设置变更后调）：按禁用名单把目录内工具
 * 逐个加回或剔除；目录外的工具（bash/SDK 内置/插件工具）原样不动。
 * Session 未就绪时静默跳过（下次创建/reload 会再应用）。
 */
export function applyAgentToolsGating(session: ActiveToolSet, disabled: readonly string[]): void {
	try {
		const off = new Set(disabled);
		const names = new Set(session.getActiveToolNames());
		for (const t of AGENT_TOOL_CATALOG) {
			if (off.has(t.name)) names.delete(t.name);
			else names.add(t.name);
		}
		session.setActiveToolsByName([...names]);
	} catch {
		// Session 未就绪——下次创建/reload 会再应用。
	}
}

// ---------------------------------------------------------------------------
// 遗留别名同步（terminalToolsEnabled / editSoftEnabled / questionnaireEnabled）
// ---------------------------------------------------------------------------

/** 遗留三开关的结构视图（client-state / settings-service 共用，避免循环 import）。 */
export interface LegacyToolSwitches {
	terminalToolsEnabled?: boolean;
	editSoftEnabled?: boolean;
	questionnaireEnabled?: boolean;
	disabledAgentTools?: unknown;
}

/**
 * 旧存档迁移：已有新字段直接归一化；否则按遗留三开关折算
 * （语义与改动前一致：terminal/edit 未设/关 = 禁用对应组；问卷未设/开 = 启用）。
 */
export function legacyToDisabled(s: LegacyToolSwitches): string[] {
	if (Array.isArray(s.disabledAgentTools)) return normalizeDisabledAgentTools(s.disabledAgentTools);
	const off: string[] = [];
	if (s.terminalToolsEnabled !== true) off.push(...TERMINAL_TOOL_NAMES);
	if (s.editSoftEnabled !== true) off.push(EDIT_SOFT_TOOL_NAME);
	if (s.questionnaireEnabled === false) off.push(ASK_USER_QUESTION_TOOL_NAME);
	return normalizeDisabledAgentTools(off);
}

/** 由禁用名单推导遗留三开关（协议兼容用；终端组按“全开才算开”的全有/全无视图）。 */
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

/**
 * 遗留单开关写入时折回新字段（只动开关覆盖的组，其余条目原样保留）：
 * 传 true = 把该组从禁用名单移除，false = 加入，未传 = 不动。
 */
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

/**
 * 门控实效名单：新字段 + 问卷别名合并（问卷关 = ask 工具必关，双保险；
 * 两处平时由 set() 同步一致，合并只防陈旧会话/旧客户端的半边状态）。
 */
export function effectiveDisabledAgentTools(s: LegacyToolSwitches): string[] {
	const next = new Set(legacyToDisabled({ ...s, disabledAgentTools: s.disabledAgentTools }));
	if (s.questionnaireEnabled === false) next.add(ASK_USER_QUESTION_TOOL_NAME);
	return [...next];
}

/** 终端使用引导是否注入（组内有任一工具启用才教 AI 用，否则就是教不存在的工具）。 */
export function isTerminalGuidanceOn(disabled: readonly string[]): boolean {
	return TERMINAL_TOOL_NAMES.some((n) => !disabled.includes(n));
}
