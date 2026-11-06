import { canvasText } from "./canvas-i18n";

/**
 * CanvasTypes.ts — 画布协作前端通用辅助函数与视觉配置。
 *
 * 对标 LangGraph / n8n / Dify / Coze 的前沿工作流范式：
 * 触发 → 规划 → 执行(Agent群) → 工具/知识 → 条件/循环 → 人工审批 → 汇聚 → 评估 → 结束。
 */
import type { CanvasEngineId, CanvasNodeRole, CanvasNodeStatus } from "../../types";
import { PSTACK_SKILLS } from "./pstack-skills-data";

export interface EngineMeta {
	id: CanvasEngineId;
	name: string;
	badge: string;
	color: string;
	bgColor: string;
	desc: string;
}

export const ENGINE_METAS: Record<CanvasEngineId, EngineMeta> = {
	pi: {
		id: "pi",
		name: "Pi 原生",
		badge: "PI",
		color: "var(--accent, #a855f7)",
		bgColor: "color-mix(in srgb, var(--accent, #a855f7) 15%, transparent)",
		desc: "支持完整插件生态、工具延迟加载与全局子代理编排",
	},
	dsh: {
		id: "dsh",
		name: "DSH 极速",
		badge: "DSH",
		color: "var(--info-blue, #38bdf8)",
		bgColor: "color-mix(in srgb, var(--info-blue, #38bdf8) 15%, transparent)",
		desc: "基于 Hashline 补丁引擎，擅长极速高频代码重构与打补丁",
	},
	codex: {
		id: "codex",
		name: "Codex",
		badge: "CODEX",
		color: "var(--green, #22c55e)",
		bgColor: "color-mix(in srgb, var(--green, #22c55e) 15%, transparent)",
		desc: "OpenAI Codex CLI",
	},
	claude: {
		id: "claude",
		name: "Claude Code",
		badge: "CLAUDE",
		color: "var(--amber, #f97316)",
		bgColor: "color-mix(in srgb, var(--amber, #f97316) 15%, transparent)",
		desc: "Anthropic 官方基座，擅长跨模块复杂逻辑与疑难排错",
	},
	durable: {
		id: "durable",
		name: "Durable 自愈",
		badge: "DURABLE",
		color: "var(--green, #22c55e)",
		bgColor: "color-mix(in srgb, var(--green, #22c55e) 15%, transparent)",
		desc: "事务化长任务自愈引擎，专攻端到端自动化测试与自愈修复",
	},
};

interface RoleMeta {
	role: CanvasNodeRole;
	labelZh: string;
	labelEn: string;
	icon: string;
	/** 节点分组：trigger=触发输入 agent=智能体 logic=逻辑控制 data=工具数据 output=收尾输出 */
	group: "trigger" | "agent" | "logic" | "data" | "output";
	blurb: string;
	blurbEn: string;
	defaultInstruction: string;
	needsLlm: boolean;
}

export const ROLE_METAS: Record<CanvasNodeRole, RoleMeta> = {
	trigger: {
		role: "trigger",
		labelZh: "业务需求输入 (Input)",
		labelEn: "Task Input / Trigger",
		icon: "📋",
		group: "trigger",
		blurb: "流水线入口：填写本次业务需求或启动输入，触发全队流转",
		blurbEn: "Pipeline entry: paste the business requirement once and let the whole team flow",
		defaultInstruction: "",
		needsLlm: false,
	},
	cron: {
		role: "cron",
		labelZh: "定时触发 (Cron)",
		labelEn: "Schedule / Cron",
		icon: "⏰",
		group: "trigger",
		blurb: "按 Cron 表达式定时启动（外部调度拉起）",
		blurbEn: "Starts on a Cron schedule (launched by an external scheduler)",
		defaultInstruction: "",
		needsLlm: false,
	},
	webhook: {
		role: "webhook",
		labelZh: "Webhook 触发",
		labelEn: "Webhook Trigger",
		icon: "🪝",
		group: "trigger",
		blurb: "外部系统回调启动（预留接入点）",
		blurbEn: "Starts on an inbound callback from another system (wiring point reserved)",
		defaultInstruction: "",
		needsLlm: false,
	},
	transform: {
		role: "transform",
		labelZh: "格式转换 (Map)",
		labelEn: "Transform / Map",
		icon: "🔄",
		group: "data",
		blurb: "文本↔JSON / 模板渲染，本地确定性执行",
		blurbEn: "Text <-> JSON and template rendering, executed locally and deterministically",
		defaultInstruction: "",
		needsLlm: false,
	},
	architect: {
		role: "architect",
		labelZh: "架构总指挥 (Lead)",
		labelEn: "Lead Architect",
		icon: "🏛️",
		group: "agent",
		blurb: "需求拆解、技术选型与任务派发",
		blurbEn: "Breaks down the requirement, picks the stack and dispatches the work",
		defaultInstruction: "把业务需求拆解为前后端清晰的技术规约与数据契约，派发给下游工程师。",
		needsLlm: true,
	},
	planner: {
		role: "planner",
		labelZh: "任务规划 (Planner)",
		labelEn: "Task Planner",
		icon: "🗺️",
		group: "agent",
		blurb: "Chain-of-Thought 拆解为可执行步骤清单",
		blurbEn: "Chain-of-Thought breakdown into an actionable step list",
		defaultInstruction: "将目标拆解为 3-7 个可执行步骤，明确每步输入输出与验收标准，输出任务清单交接下游。",
		needsLlm: true,
	},
	coder: {
		role: "coder",
		labelZh: "研发工程师 (Coder)",
		labelEn: "Software Engineer",
		icon: "💻",
		group: "agent",
		blurb: "代码编写、重构与功能实现",
		blurbEn: "Writes code, refactors and implements features",
		defaultInstruction: "根据上游契约编写高质量代码，保持最小改动并保证可运行。",
		needsLlm: true,
	},
	researcher: {
		role: "researcher",
		labelZh: "联网调研 (Research)",
		labelEn: "Researcher",
		icon: "🌐",
		group: "agent",
		blurb: "联网搜索 + 文档研读 + 竞品分析",
		blurbEn: "Web search + document study + competitor analysis",
		defaultInstruction: "针对任务做联网调研与资料搜集，输出结构化调研结论（现状/方案对比/推荐）交接下游。",
		needsLlm: true,
	},
	writer: {
		role: "writer",
		labelZh: "文档写作 (Writer)",
		labelEn: "Writer",
		icon: "✍️",
		group: "agent",
		blurb: "需求文档 / README / 变更说明",
		blurbEn: "Requirements docs / README / change notes",
		defaultInstruction: "根据上游交付物编写清晰文档：背景、变更点、使用方式、注意事项。",
		needsLlm: true,
	},
	analyst: {
		role: "analyst",
		labelZh: "数据分析 (Analyst)",
		labelEn: "Data Analyst",
		icon: "📊",
		group: "agent",
		blurb: "日志 / 数据 / 性能分析与洞察",
		blurbEn: "Log, data and performance analysis with insights",
		defaultInstruction: "分析输入的数据与日志，给出量化结论与可执行优化建议。",
		needsLlm: true,
	},
	reviewer: {
		role: "reviewer",
		labelZh: "代码审查员 (Reviewer)",
		labelEn: "Code Reviewer",
		icon: "🔍",
		group: "agent",
		blurb: "质量门禁：审查、打分与修改建议",
		blurbEn: "Quality gate: review, scoring and change requests",
		defaultInstruction: "审查上游代码：正确性、边界、安全与风格，给出通过/驳回结论与修改清单。",
		needsLlm: true,
	},
	tester: {
		role: "tester",
		labelZh: "测试与运维 (DevOps)",
		labelEn: "QA & DevOps",
		icon: "🧪",
		group: "agent",
		blurb: "编写并运行测试，报告结果与失败证据",
		blurbEn: "Writes and runs tests, reports results and failure evidence",
		defaultInstruction: "编写并运行相关测试，报告真实结果、失败证据与未验证范围。",
		needsLlm: true,
	},
	devops: {
		role: "devops",
		labelZh: "运维与发布 (Deploy)",
		labelEn: "Deploy & Release",
		icon: "🚀",
		group: "agent",
		blurb: "构建、部署与发布运维",
		blurbEn: "Build, deploy and release operations",
		defaultInstruction: "负责构建验证与发布流程，确保产物可部署、可回滚。",
		needsLlm: true,
	},
	evaluator: {
		role: "evaluator",
		labelZh: "质量评估 (Judge)",
		labelEn: "LLM-as-Judge",
		icon: "⚖️",
		group: "output",
		blurb: "LLM-as-Judge 打分，不达标走驳回边",
		blurbEn: "LLM-as-Judge scoring; below the threshold takes the reject edge",
		defaultInstruction: "作为质量裁判，按正确性/完整性/规范性逐项打分（0-100），低于 80 分给出驳回理由。",
		needsLlm: true,
	},
	custom: {
		role: "custom",
		labelZh: "自定义数字员工",
		labelEn: "Custom Teammate",
		icon: "🤖",
		group: "agent",
		blurb: "完全自定义的 AI 队友",
		blurbEn: "A fully custom AI teammate",
		defaultInstruction: "",
		needsLlm: true,
	},
	// —— 逻辑控制（弱 LLM / 无需独立会话，直通或轻量判定）——
	condition: {
		role: "condition",
		labelZh: "条件分支 (If/Else)",
		labelEn: "Condition Branch",
		icon: "🔀",
		group: "logic",
		blurb: "按表达式走 true / false 两条边",
		blurbEn: "Splits the flow into true / false edges by expression",
		defaultInstruction: "",
		needsLlm: false,
	},
	ai_judge: {
		role: "ai_judge",
		labelZh: "AI 裁决",
		labelEn: "AI Judge",
		icon: "🧠",
		group: "logic",
		blurb: "模型语义判定走通过 / 打回两条边",
		blurbEn: "Model-level semantic verdict: pass / send-back edges",
		defaultInstruction: "",
		needsLlm: true,
	},
	loop: {
		role: "loop",
		labelZh: "循环重试 (Loop)",
		labelEn: "Loop / Retry",
		icon: "🔁",
		group: "logic",
		blurb: "限定次数内重复执行下游（防死循环熔断）",
		blurbEn: "Repeats the downstream within a bounded count (loop breaker included)",
		defaultInstruction: "",
		needsLlm: false,
	},
	human: {
		role: "human",
		labelZh: "人工审批 (Human)",
		labelEn: "Human-in-the-loop",
		icon: "🧑‍⚖️",
		group: "logic",
		blurb: "暂停等待人工批准/驳回（Review Gate）",
		blurbEn: "Pauses and waits for human approve / reject (Review Gate)",
		defaultInstruction: "",
		needsLlm: false,
	},
	merge: {
		role: "merge",
		labelZh: "汇聚合并 (Join)",
		labelEn: "Merge / Join",
		icon: "🔗",
		group: "logic",
		blurb: "多条并行分支在此汇总后再往下走",
		blurbEn: "Joins parallel branches before continuing downstream",
		defaultInstruction: "",
		needsLlm: false,
	},
	subflow: {
		role: "subflow",
		labelZh: "子工作流 (Subflow)",
		labelEn: "Sub-workflow",
		icon: "📦",
		group: "logic",
		blurb: "未实现：说明节点，不执行嵌套工作流",
		blurbEn: "Not implemented: descriptive node, does not run a nested workflow",
		defaultInstruction: "汇总上游产物，形成给子流程的输入摘要。",
		needsLlm: true,
	},
	// —— 工具与数据 ——
	tool: {
		role: "tool",
		labelZh: "工具调用 (Tool)",
		labelEn: "Tool Call",
		icon: "🛠️",
		group: "data",
		blurb: "bash / 文件 / 搜索等原子工具",
		blurbEn: "Atomic tools such as bash / files / search",
		defaultInstruction: "按工具调用规约执行：先说明调用目的，再执行，最后汇总结果交接下游。",
		needsLlm: true,
	},
	knowledge: {
		role: "knowledge",
		labelZh: "知识检索 (RAG)",
		labelEn: "Knowledge Retrieval",
		icon: "📚",
		group: "data",
		blurb: "智能体按指令检索文件；无独立知识库索引",
		blurbEn: "The agent searches files by instruction; no dedicated knowledge index",
		defaultInstruction: "基于知识库检索回答：先列出检索到依据，再综合作答并标注来源。",
		needsLlm: true,
	},
	code: {
		role: "code",
		labelZh: "代码执行 (Code)",
		labelEn: "Code Execution",
		icon: "🧩",
		group: "data",
		blurb: "智能体按指令编写和运行脚本；依赖可用工具",
		blurbEn: "The agent writes and runs scripts by instruction; depends on available tools",
		defaultInstruction: "编写并执行必要的脚本完成数据加工，把运行结果摘要交接下游。",
		needsLlm: true,
	},
	api: {
		role: "api",
		labelZh: "API 调用 (HTTP)",
		labelEn: "HTTP Request",
		icon: "🌍",
		group: "data",
		blurb: "智能体按指令请求 HTTP 接口；依赖可用工具",
		blurbEn: "The agent calls HTTP endpoints by instruction; depends on available tools",
		defaultInstruction: "调用配置中的外部 API，把返回结果清洗为摘要后交接下游。",
		needsLlm: true,
	},
	memory: {
		role: "memory",
		labelZh: "记忆读写 (Memory)",
		labelEn: "Memory Read/Write",
		icon: "🧠",
		group: "data",
		blurb: "未实现：说明节点，无持久记忆存储",
		blurbEn: "Not implemented: descriptive node, no persistent memory store",
		defaultInstruction: "",
		needsLlm: false,
	},
	end: {
		role: "end",
		labelZh: "结束输出 (End)",
		labelEn: "End / Output",
		icon: "🏁",
		group: "output",
		blurb: "汇总所有上游产物形成最终交付",
		blurbEn: "Aggregates every upstream deliverable into the final output",
		defaultInstruction: "",
		needsLlm: false,
	},
	pstack: {
		role: "pstack",
		labelZh: "Pstack 专家 (Pstack)",
		labelEn: "Pstack Rigorous Agent",
		icon: "🥔",
		group: "agent",
		blurb: "基于 Cursor 核心工程实践：深度优先、直击根因、去 AI 味、严谨实证",
		blurbEn: "Built on Cursor's core engineering practice: depth first, root cause, no AI slop, evidence over claims",
		defaultInstruction: "遵循所选 Pstack Skill 规约与准则开展工作，拒绝表面修补与 AI 废话，用运行证据证明交付。",
		needsLlm: true,
	},
	skill: {
		role: "skill",
		labelZh: "技能注入 (Skill)",
		labelEn: "Skill / Soul Agent",
		icon: "✨",
		group: "agent",
		blurb: "以安装的 Skill 作为智能体灵魂：注入技能指令、行为模式与领域专长",
		blurbEn: "Uses an installed Skill as the agent's soul: its instructions, behaviour and domain expertise",
		defaultInstruction: "以指定 Skill 的专业技能规约为灵魂，严格遵循其步骤与标准执行任务。",
		needsLlm: true,
	},
};

interface NodeGroupMeta {
	id: RoleMeta["group"];
	labelZh: string;
	labelEn: string;
}

export const NODE_GROUPS: NodeGroupMeta[] = [
	{ id: "trigger", labelZh: "触发与输入", labelEn: "Trigger & Input" },
	{ id: "agent", labelZh: "AI 智能体", labelEn: "AI Agents" },
	{ id: "logic", labelZh: "逻辑控制", labelEn: "Logic Control" },
	{ id: "data", labelZh: "工具与数据", labelEn: "Tools & Data" },
	{ id: "output", labelZh: "评估与收尾", labelEn: "Evaluate & Finish" },
];

/** 纯透传控制节点：无需启动 LLM 会话，直接标记完成并向下游透传摘要 */
const PASSTHROUGH_ROLES: ReadonlySet<CanvasNodeRole> = new Set([
	"condition",
	"loop",
	"human",
	"merge",
	"memory",
	"end",
	"trigger",
	"cron",
	"webhook",
]);

export function isPassthroughRole(role: CanvasNodeRole): boolean {
	return PASSTHROUGH_ROLES.has(role);
}

/** 该角色是否展示「任务指令」输入框（LLM 型节点展示，纯控制节点展示配置项） */
export function roleNeedsInstruction(role: CanvasNodeRole): boolean {
	return isRoleImplemented(role) && (ROLE_METAS[role]?.needsLlm ?? true);
}

export const STATUS_COLORS: Record<CanvasNodeStatus, { text: string; bg: string; dot: string }> = {
	skipped: { text: "var(--text-faint)", bg: "var(--bg-elev)", dot: "var(--text-faint)" },
	cancelled: { text: "var(--text-faint)", bg: "var(--bg-elev)", dot: "var(--text-faint)" },
	idle: { text: "var(--text-faint)", bg: "var(--bg-elev)", dot: "#94a3b8" },
	queued: { text: "var(--amber-text)", bg: "color-mix(in srgb, var(--amber) 12%, transparent)", dot: "var(--amber)" },
	running: {
		text: "var(--info-blue)",
		bg: "color-mix(in srgb, var(--info-blue) 12%, transparent)",
		dot: "var(--info-blue)",
	},
	waiting_approval: {
		text: "var(--amber-text)",
		bg: "color-mix(in srgb, var(--amber) 20%, transparent)",
		dot: "var(--amber)",
	},
	done: { text: "var(--green)", bg: "color-mix(in srgb, var(--green) 12%, transparent)", dot: "var(--green)" },
	error: { text: "var(--err-text)", bg: "color-mix(in srgb, var(--red) 12%, transparent)", dot: "var(--red)" },
	paused: { text: "var(--text-faint)", bg: "var(--bg-elev)", dot: "#647b8b" },
};

/** 字段级端子目录：端口不再是整卡一进一出，而是绑定卡片内具体数值。
 *  - 输入端（左侧）：contract=任务契约（主输入） instruction=AI指令 system=角色规约 config=控制参数
 *  - 输出端（右侧）：result=交付产物（主输出） true/false=条件分支 approve/reject=审批裁决
 *  位置由卡片 DOM 实测（offsetTop）上报，SvgEdges 按实测 Y 绘制，历史无端口边回退 PORT_Y_OFFSET。 */
interface CanvasPortDef {
	key: string;
	labelZh: string;
	labelEn: string;
	desc: string;
	descEn: string;
}

export const IN_PORT_DEFS: CanvasPortDef[] = [
	{
		key: "contract",
		labelZh: "任务契约",
		desc: "主输入：上游交付产物作为任务契约注入",
		labelEn: "Task contract",
		descEn: "Primary input: the upstream deliverable is injected as the task contract",
	},
	{
		key: "instruction",
		labelZh: "AI指令",
		desc: "定向写入本轮 AI 指令（配合 {{上游摘要}} 变量）",
		labelEn: "AI instruction",
		descEn: "Writes this round's AI instruction (pairs with the {{上游摘要}} variable)",
	},
	{
		key: "system",
		labelZh: "角色规约",
		desc: "以上游产物补充基座人设",
		labelEn: "Role contract",
		descEn: "Augments the base persona with the upstream deliverable",
	},
	{
		key: "config",
		labelZh: "控制参数",
		desc: "写入条件表达式 / 循环次数等控制参数上下文",
		labelEn: "Control params",
		descEn: "Context for control parameters such as condition expressions or loop counts",
	},
];

const OUT_PORT_DEFS_BASE: CanvasPortDef[] = [
	{
		key: "result",
		labelZh: "交付产物",
		desc: "主输出：本节点交付摘要",
		labelEn: "Deliverable",
		descEn: "Primary output: this node's delivery summary",
	},
];

/** 按角色追加分支输出端子（条件 / 人工 / 评估 / 审查）。 */
export function outPortsForRole(role: CanvasNodeRole): CanvasPortDef[] {
	const extra: CanvasPortDef[] = [];
	if (role === "condition" || role === "ai_judge") {
		extra.push(
			{
				key: "true",
				labelZh: "成立",
				desc: "条件成立走这条边（condition_true）",
				labelEn: "True",
				descEn: "Taken when the condition holds (condition_true)",
			},
			{
				key: "false",
				labelZh: "不成立",
				desc: "条件不成立走这条边（condition_false）",
				labelEn: "False",
				descEn: "Taken when the condition does not hold (condition_false)",
			},
		);
	}
	if (role === "human") {
		extra.push(
			{
				key: "approve",
				labelZh: "批准",
				desc: "人工批准后走这条边（approve）",
				labelEn: "Approve",
				descEn: "Taken after a human approves (approve)",
			},
			{
				key: "reject",
				labelZh: "驳回返工",
				desc: "人工驳回后走这条边（reject）",
				labelEn: "Reject / rework",
				descEn: "Taken after a human rejects (reject)",
			},
		);
	}
	if (role === "evaluator" || role === "reviewer") {
		extra.push(
			{
				key: "approve",
				labelZh: "通过",
				desc: "评估通过走这条边（approve）",
				labelEn: "Pass",
				descEn: "Taken when the evaluation passes (approve)",
			},
			{
				key: "reject",
				labelZh: "驳回",
				desc: "评估驳回走这条边（reject / loop_back）",
				labelEn: "Reject",
				descEn: "Taken when the evaluation rejects (reject / loop_back)",
			},
		);
	}
	return [...OUT_PORT_DEFS_BASE, ...extra];
}

export function inPortLabel(key: string | undefined, locale = "zh"): string {
	const def = key ? IN_PORT_DEFS.find((d) => d.key === key) : undefined;
	return canvasText(locale, def?.labelZh ?? "任务契约", def?.labelEn ?? "Task contract");
}

export function outPortLabel(key: string | undefined, locale = "zh"): string {
	const all: CanvasPortDef[] = [
		...OUT_PORT_DEFS_BASE,
		{ key: "true", labelZh: "成立", labelEn: "True", desc: "", descEn: "" },
		{ key: "false", labelZh: "不成立", labelEn: "False", desc: "", descEn: "" },
		{ key: "approve", labelZh: "批准/通过", labelEn: "Approve / pass", desc: "", descEn: "" },
		{ key: "reject", labelZh: "驳回", labelEn: "Reject", desc: "", descEn: "" },
	];
	const def = key ? all.find((d) => d.key === key) : undefined;
	return canvasText(locale, def?.labelZh ?? "交付产物", def?.labelEn ?? "Deliverable");
}

/** 按角色分型的专属参数表：每个角色只露自己的配置，不再所有节点一个样。
 *  - 卡片：Agent 类渲染为「角色专属参数」组；纯代码类渲染为 utility 专属区（含 config 端子）
 *  - 抽屉：控制参数区同表驱动，保持两端一致
 *  - 调度器：Agent 节点的非空配置会拼入提示词「本节点专属参数」，所见即所得 */
type RoleFieldKind = "text" | "textarea" | "number" | "select" | "hint" | "boolean";

export interface RoleField {
	key: string;
	labelZh: string;
	kind: RoleFieldKind;
	placeholder?: string;
	options?: { value: string; labelZh: string }[];
	min?: number;
	max?: number;
	default?: string | number | boolean;
	rows?: number;
	hint?: string;
	showIf?: { key: string; value: string | number | boolean };
}

export const ROLE_FIELDS: Record<CanvasNodeRole, RoleField[]> = {
	trigger: [
		{
			key: "payload",
			labelZh: "业务需求 / 任务输入",
			kind: "textarea",
			rows: 4,
			placeholder: "在此输入本次要实现的功能需求、修改目标或业务背景（例如：实现深色模式切换并记住用户偏好）…",
		},
	],
	cron: [
		{
			key: "cron",
			labelZh: "Cron 表达式",
			kind: "text",
			default: "*/30 * * * *",
			placeholder: "*/30 * * * *（分 时 日 月 周）",
			hint: "由外部调度按计划拉起，触发后向下游透传。",
		},
	],
	webhook: [
		{ key: "path", labelZh: "回调路径", kind: "text", default: "/hook/demo", placeholder: "/hook/order-created" },
		{
			key: "method",
			labelZh: "方法",
			kind: "select",
			default: "POST",
			options: [
				{ value: "GET", labelZh: "GET" },
				{ value: "POST", labelZh: "POST" },
			],
			hint: "外部系统回调此接入点即启动（预留接入，当前版本手动触发）。",
		},
	],
	transform: [
		{
			key: "mode",
			labelZh: "转换模式（本地执行）",
			kind: "select",
			default: "text2json",
			options: [
				{ value: "text2json", labelZh: "文本 → JSON" },
				{ value: "json2text", labelZh: "JSON → 文本" },
				{ value: "template", labelZh: "模板渲染" },
			],
		},
		{
			key: "template",
			labelZh: "渲染模板",
			kind: "textarea",
			rows: 3,
			default: "{{input}}",
			placeholder: "模板，{{input}} 会被上游产物替换",
			showIf: { key: "mode", value: "template" },
		},
	],
	architect: [],
	planner: [{ key: "maxSteps", labelZh: "拆解步骤上限", kind: "number", min: 2, max: 12, default: 5 }],
	coder: [],
	researcher: [
		{
			key: "depth",
			labelZh: "调研深度",
			kind: "select",
			default: "标准",
			options: [
				{ value: "快速", labelZh: "快速（要点速览）" },
				{ value: "标准", labelZh: "标准（多源对比）" },
				{ value: "深度", labelZh: "深度（溯源研读）" },
			],
		},
		{ key: "maxSources", labelZh: "引用来源上限", kind: "number", min: 1, max: 20, default: 5 },
	],
	writer: [],
	analyst: [],
	reviewer: [
		{
			key: "strictness",
			labelZh: "审查严格度",
			kind: "select",
			default: "标准",
			options: [
				{ value: "宽松", labelZh: "宽松（只拦硬伤）" },
				{ value: "标准", labelZh: "标准（正确性+规范）" },
				{ value: "严格", labelZh: "严格（逐行挑刺）" },
			],
		},
	],
	tester: [
		{
			key: "testCommand",
			labelZh: "测试命令",
			kind: "text",
			default: "npm test",
			placeholder: "npm test / pytest / go test …",
		},
	],
	devops: [
		{
			key: "environment",
			labelZh: "发布环境",
			kind: "select",
			default: "预发",
			options: [
				{ value: "预发", labelZh: "预发" },
				{ value: "生产", labelZh: "生产" },
			],
		},
	],
	evaluator: [
		{
			key: "threshold",
			labelZh: "通过分数线",
			kind: "number",
			min: 0,
			max: 100,
			default: 80,
			hint: "低于该分走驳回边。",
		},
	],
	custom: [],
	condition: [
		{
			key: "condition",
			labelZh: "条件表达式",
			kind: "text",
			default: "上游产物包含 驳回/失败 关键词",
			placeholder: "例：上游产物包含 成功 关键词",
		},
	],
	ai_judge: [
		{
			key: "judge",
			labelZh: "裁决问题",
			kind: "textarea",
			rows: 2,
			placeholder: "例：回归摘要是否证明偶发不再复现？",
			hint: "为空则读 AI 指令；都没有才按默认提问。无上游时直接答题，有上游以上游为据。模型只回结论通过/不通过。",
		},
	],
	loop: [
		{
			key: "loopCount",
			labelZh: "最大循环次数",
			kind: "number",
			min: 1,
			max: 10,
			default: 3,
			hint: "熔断保护，超限暂停等人工。",
		},
	],
	human: [
		{
			key: "approvalHint",
			labelZh: "审批提示",
			kind: "text",
			default: "检查产物是否符合验收标准再批准",
			placeholder: "例：检查产物是否符合验收标准再批准",
		},
	],
	knowledge: [
		{ key: "topK", labelZh: "检索 TopK", kind: "number", min: 1, max: 20, default: 5 },
		{ key: "baseId", labelZh: "知识库标识", kind: "text", placeholder: "缺省用工作区全文检索" },
	],
	tool: [{ key: "toolName", labelZh: "工具名", kind: "text", default: "bash", placeholder: "bash / read / 搜索…" }],
	code: [
		{
			key: "language",
			labelZh: "脚本语言",
			kind: "select",
			default: "TypeScript",
			options: [
				{ value: "TypeScript", labelZh: "TypeScript" },
				{ value: "Python", labelZh: "Python" },
				{ value: "Bash", labelZh: "Bash" },
			],
		},
		{ key: "entry", labelZh: "入口/说明", kind: "textarea", rows: 3, placeholder: "要完成的数据加工说明，或入口函数…" },
	],
	api: [
		{ key: "apiUrl", labelZh: "API 地址", kind: "text", default: "https://", placeholder: "https://" },
		{
			key: "apiMethod",
			labelZh: "方法",
			kind: "select",
			default: "POST",
			options: [
				{ value: "GET", labelZh: "GET" },
				{ value: "POST", labelZh: "POST" },
				{ value: "PUT", labelZh: "PUT" },
				{ value: "DELETE", labelZh: "DELETE" },
			],
		},
	],
	merge: [],
	memory: [
		{ key: "memoryKey", labelZh: "记忆键", kind: "text", default: "shared_memory", placeholder: "shared_memory" },
	],
	end: [],
	subflow: [{ key: "subflowId", labelZh: "子流程 ID", kind: "text", placeholder: "目标画布工程 id" }],
	pstack: [
		{
			key: "skill",
			labelZh: "选择工作依据 Skill",
			kind: "select",
			default: "poteto-mode",
			options: PSTACK_SKILLS.map((s) => ({
				value: s.id,
				labelZh: `${s.icon} ${s.nameZh} (${s.id})`,
			})),
			hint: "选择该 Skill 作为本节点的核心描述、思考准则与工程工作依据",
		},
	],
	skill: [
		{
			key: "skillName",
			labelZh: "注入的技能灵魂 (Skill)",
			kind: "select",
			default: "",
			options: [
				{
					value: "",
					labelZh: "📦 选择已安装的技能...",
				},
			],
			hint: "以此 Skill 作为本节点的灵魂规约与行动标准（仅展示本机已安装技能）",
		},
	],
};

/** 每个角色的输入输出速查（卡片 ? 提示用）：输入要什么 / 输出给什么 / 一句话用法 */
interface RoleIoHelp {
	input: string;
	output: string;
	usage: string;
}

export const ROLE_IO_HELP: Record<CanvasNodeRole, RoleIoHelp> = {
	trigger: {
		input: "无需上游；启动弹窗的输入会自动并入",
		output: "启动载荷全文，原样透传下游",
		usage: "载荷写好任务再点直接启动，下游用 {{上游摘要}} 引用",
	},
	cron: {
		input: "无需上游，到点自动拉起",
		output: "Cron 配置 + 空载荷透传",
		usage: "定时流水线入口，后接触发执行节点",
	},
	webhook: { input: "外部 HTTP 回调", output: "回调 Body 原样透传", usage: "预留外部系统触发，当前版本手动触发" },
	transform: {
		input: "上游产物文本",
		output: "按模式转换：文本↔JSON / 模板渲染结果",
		usage: "Agent 干活前先清洗格式，模板里用 {{input}} 占位",
	},
	architect: {
		input: "需求描述 / 上游摘要",
		output: "技术规约 + 拆解后的任务清单",
		usage: "放最前当总指挥，后接 planner / coder",
	},
	planner: {
		input: "目标 / 需求摘要",
		output: "3-7 步可执行清单（含验收标准）",
		usage: "大任务先拆解，再扇出给多个 coder",
	},
	coder: {
		input: "任务契约 + AI 指令（可用 {{上游摘要}}）",
		output: "代码变更摘要 + git diff 统计",
		usage: "核心干活节点：指令写清文件范围与验收标准",
	},
	researcher: {
		input: "调研主题",
		output: "现状 / 方案对比 / 推荐结论",
		usage: "选型前先调研，结果交 architect / coder",
	},
	writer: { input: "上游交付物", output: "文档正文（背景/变更/用法）", usage: "收尾写 README / 变更说明，接 end" },
	analyst: { input: "数据 / 日志文本", output: "量化结论 + 可执行优化建议", usage: "性能故障分析，结果回给 coder 修" },
	reviewer: {
		input: "待审代码摘要",
		output: "通过走 approve，驳回走 reject + 修改清单",
		usage: "接 coder 后当质量门禁，严格度在参数里调",
	},
	tester: {
		input: "待测代码 / 需求",
		output: "测试报告：通过或失败 + 自动修复",
		usage: "配好测试命令，失败会自动修到通过",
	},
	devops: { input: "可发布产物", output: "构建 / 发布结果", usage: "流水线尾端做构建验证与发布" },
	evaluator: {
		input: "待评分产物",
		output: "0-100 打分；低于阈值走驳回边",
		usage: "当裁判打分，阈值在角色专属参数里调",
	},
	custom: { input: "上游摘要 + AI 指令", output: "自定义交付摘要", usage: "人设写在角色规约里，指令写任务" },
	condition: {
		input: "上游产物文本",
		output: "关键词或 AI 裁决结论走成立 / 不成立边",
		usage: "默认关键词包含；开 AI 裁决后按模型结论分流",
	},
	ai_judge: { input: "上游产物文本", output: "模型结论走通过 / 打回边", usage: "写裁决问题，模型与思考强度走节点配置" },
	loop: { input: "上游产物", output: "原样透传，循环 N 次调下游", usage: "重试 / 批量用，次数防熔断" },
	human: { input: "待审产物", output: "批准后透传，驳回则暂停", usage: "高危操作前加人工确认" },
	merge: { input: "多条分支产物", output: "汇总后透传下游", usage: "并行扇出后在此 Join 再往下走" },
	subflow: { input: "上游摘要", output: "子流程最终交付", usage: "填子流程 ID，复用另一个画布" },
	tool: { input: "工具参数 / 上游摘要", output: "工具执行结果摘要", usage: "配工具名如 bash，先说目的再执行" },
	knowledge: { input: "问题 / 关键词", output: "检索依据 + 综合答案", usage: "配 TopK，先建好本地知识库" },
	code: { input: "待加工数据", output: "脚本运行结果摘要", usage: "选语言 + 写入口说明做加工校验" },
	api: { input: "上游参数", output: "HTTP 返回清洗后的摘要", usage: "配 URL + 方法调外部接口" },
	memory: { input: "写入：上游产物；读取：无", output: "记忆键对应快照", usage: "跨分支共享变量，键名保持一致" },
	end: { input: "所有上游汇总", output: "最终交付（流程结束）", usage: "放最后汇总展示" },
	pstack: {
		input: "业务需求 / 架构规约 / 上游产物",
		output: "高质量工程交付 + 验证证据（无 AI 废话/无表象修补）",
		usage: "选择 58 个 Pstack Skill 之一作为角色准则，如 poteto-mode、fix-root-causes、unslop 等",
	},
	skill: {
		input: "业务需求 / 任务契约",
		output: "严格依据注入技能规约的交付产物",
		usage: "以已安装技能作为智能体灵魂，继承其专属方法论与领域规约",
	},
};

/** 取某角色可见的字段（含 showIf 联动显隐） */
export function visibleRoleFields(
	role: CanvasNodeRole,
	config: Record<string, string | number | boolean | undefined> | undefined,
): RoleField[] {
	if (!isRoleImplemented(role)) return [{ key: "capability", kind: "hint", labelZh: roleCapabilityNotice(role) }];
	return (ROLE_FIELDS[role] ?? []).filter(
		(f) => !f.showIf || String(config?.[f.showIf.key] ?? "") === String(f.showIf.value),
	);
}

/** 节点输入与输出端口相对于节点顶部的 Y 轴圆心位置（单位 px） */
export const PORT_Y_OFFSET = 72;

/** These legacy roles only pass text through; no scheduler, endpoint or store exists. */
export const UNIMPLEMENTED_ROLES: ReadonlySet<CanvasNodeRole> = new Set(["cron", "webhook", "memory", "subflow"]);
export function isRoleImplemented(role: CanvasNodeRole): boolean {
	return !UNIMPLEMENTED_ROLES.has(role);
}
export function roleCapabilityNotice(role: CanvasNodeRole, english = false): string {
	if (!isRoleImplemented(role))
		return english
			? "Description only: scheduled execution, webhook endpoints, persistent memory and nested workflows are not implemented. Execution is disabled for this description node."
			: "仅说明节点：尚未实现定时调度、Webhook 接入、持久记忆或嵌套工作流；此说明节点已禁用运行。";
	if (["tool", "code", "api", "knowledge"].includes(role))
		return english
			? "Agent instruction: execution depends on the model and its enabled tools; no dedicated runtime is provided."
			: "由智能体按指令执行，依赖当前模型及已启用工具；没有独立的专用运行时。";
	return "";
}
