/**
 * CanvasTypes.ts — 画布协作前端通用辅助函数与视觉配置。
 *
 * 对标 LangGraph / n8n / Dify / Coze 的前沿工作流范式：
 * 触发 → 规划 → 执行(Agent群) → 工具/知识 → 条件/循环 → 人工审批 → 汇聚 → 评估 → 结束。
 */
import type { CanvasEngineId, CanvasNodeRole, CanvasNodeStatus } from "../../types";
import type { Translate } from "../../i18n";
import { getPstackSkills } from "./pstack-skills-data";

const untranslated: Translate = (key) => key;

export interface EngineMeta {
	id: CanvasEngineId;
	name: string;
	badge: string;
	color: string;
	bgColor: string;
	desc: string;
}

export function getEngineMetas(t: Translate): Record<CanvasEngineId, EngineMeta> {
	return {
		pi: {
			id: "pi",
			name: t("canvas.metadata.engine.pi.name"),
			badge: t("canvas.metadata.engine.pi.badge"),
			color: "var(--accent, #a855f7)",
			bgColor: "color-mix(in srgb, var(--accent, #a855f7) 15%, transparent)",
			desc: t("canvas.metadata.engine.pi.desc"),
		},
		dsh: {
			id: "dsh",
			name: t("canvas.metadata.engine.dsh.name"),
			badge: t("canvas.metadata.engine.dsh.badge"),
			color: "var(--info-blue, #38bdf8)",
			bgColor: "color-mix(in srgb, var(--info-blue, #38bdf8) 15%, transparent)",
			desc: t("canvas.metadata.engine.dsh.desc"),
		},
		codex: {
			id: "codex",
			name: t("canvas.metadata.engine.codex.name"),
			badge: t("canvas.metadata.engine.codex.badge"),
			color: "var(--green, #22c55e)",
			bgColor: "color-mix(in srgb, var(--green, #22c55e) 15%, transparent)",
			desc: t("canvas.metadata.engine.codex.desc"),
		},
		claude: {
			id: "claude",
			name: t("canvas.metadata.engine.claude.name"),
			badge: t("canvas.metadata.engine.claude.badge"),
			color: "var(--amber, #f97316)",
			bgColor: "color-mix(in srgb, var(--amber, #f97316) 15%, transparent)",
			desc: t("canvas.metadata.engine.claude.desc"),
		},
		durable: {
			id: "durable",
			name: t("canvas.metadata.engine.durable.name"),
			badge: t("canvas.metadata.engine.durable.badge"),
			color: "var(--green, #22c55e)",
			bgColor: "color-mix(in srgb, var(--green, #22c55e) 15%, transparent)",
			desc: t("canvas.metadata.engine.durable.desc"),
		},
	};
}

interface RoleMeta {
	role: CanvasNodeRole;
	label: string;

	icon: string;
	/** 节点分组：trigger=触发输入 agent=智能体 logic=逻辑控制 data=工具数据 output=收尾输出 */
	group: "trigger" | "agent" | "logic" | "data" | "output";
	blurb: string;
	defaultInstruction: string;
	needsLlm: boolean;
}

export function getRoleMetas(t: Translate): Record<CanvasNodeRole, RoleMeta> {
	return {
		trigger: {
			role: "trigger",
			label: t("canvas.metadata.role.trigger.label"),

			icon: "📋",
			group: "trigger",
			blurb: t("canvas.metadata.role.trigger.blurb"),
			defaultInstruction: "",
			needsLlm: LLM_ROLES.has("trigger"),
		},
		cron: {
			role: "cron",
			label: t("canvas.metadata.role.cron.label"),

			icon: "⏰",
			group: "trigger",
			blurb: t("canvas.metadata.role.cron.blurb"),
			defaultInstruction: "",
			needsLlm: LLM_ROLES.has("cron"),
		},
		webhook: {
			role: "webhook",
			label: t("canvas.metadata.role.webhook.label"),

			icon: "🪝",
			group: "trigger",
			blurb: t("canvas.metadata.role.webhook.blurb"),
			defaultInstruction: "",
			needsLlm: LLM_ROLES.has("webhook"),
		},
		transform: {
			role: "transform",
			label: t("canvas.metadata.role.transform.label"),

			icon: "🔄",
			group: "data",
			blurb: t("canvas.metadata.role.transform.blurb"),
			defaultInstruction: "",
			needsLlm: LLM_ROLES.has("transform"),
		},
		architect: {
			role: "architect",
			label: t("canvas.metadata.role.architect.label"),

			icon: "🏛️",
			group: "agent",
			blurb: t("canvas.metadata.role.architect.blurb"),
			defaultInstruction:
				"Break down the requirements into clear frontend and backend specifications and data contracts, then hand them off to downstream engineers.",
			needsLlm: LLM_ROLES.has("architect"),
		},
		planner: {
			role: "planner",
			label: t("canvas.metadata.role.planner.label"),

			icon: "🗺️",
			group: "agent",
			blurb: t("canvas.metadata.role.planner.blurb"),
			defaultInstruction:
				"Break the goal into 3–7 actionable steps. Specify each step's inputs, outputs, and acceptance criteria, then hand the task list downstream.",
			needsLlm: LLM_ROLES.has("planner"),
		},
		coder: {
			role: "coder",
			label: t("canvas.metadata.role.coder.label"),

			icon: "💻",
			group: "agent",
			blurb: t("canvas.metadata.role.coder.blurb"),
			defaultInstruction:
				"Implement high-quality code from the upstream contract. Keep changes minimal and ensure the result runs.",
			needsLlm: LLM_ROLES.has("coder"),
		},
		researcher: {
			role: "researcher",
			label: t("canvas.metadata.role.researcher.label"),

			icon: "🌐",
			group: "agent",
			blurb: t("canvas.metadata.role.researcher.blurb"),
			defaultInstruction:
				"Research the task online and collect supporting materials. Hand off structured findings covering the current state, alternatives, and recommendations.",
			needsLlm: LLM_ROLES.has("researcher"),
		},
		writer: {
			role: "writer",
			label: t("canvas.metadata.role.writer.label"),

			icon: "✍️",
			group: "agent",
			blurb: t("canvas.metadata.role.writer.blurb"),
			defaultInstruction:
				"Write clear documentation from the upstream deliverables, covering background, changes, usage, and caveats.",
			needsLlm: LLM_ROLES.has("writer"),
		},
		analyst: {
			role: "analyst",
			label: t("canvas.metadata.role.analyst.label"),

			icon: "📊",
			group: "agent",
			blurb: t("canvas.metadata.role.analyst.blurb"),
			defaultInstruction:
				"Analyze the input data and logs. Provide quantitative findings and actionable optimization recommendations.",
			needsLlm: LLM_ROLES.has("analyst"),
		},
		reviewer: {
			role: "reviewer",
			label: t("canvas.metadata.role.reviewer.label"),

			icon: "🔍",
			group: "agent",
			blurb: t("canvas.metadata.role.reviewer.blurb"),
			defaultInstruction:
				"Review the upstream code for correctness, edge cases, security, and style. Return an approval or rejection with a list of required changes.",
			needsLlm: LLM_ROLES.has("reviewer"),
		},
		tester: {
			role: "tester",
			label: t("canvas.metadata.role.tester.label"),

			icon: "🧪",
			group: "agent",
			blurb: t("canvas.metadata.role.tester.blurb"),
			defaultInstruction:
				"Write and run relevant tests. Report actual results, failure evidence, and unverified areas.",
			needsLlm: LLM_ROLES.has("tester"),
		},
		devops: {
			role: "devops",
			label: t("canvas.metadata.role.devops.label"),

			icon: "🚀",
			group: "agent",
			blurb: t("canvas.metadata.role.devops.blurb"),
			defaultInstruction:
				"Validate builds and manage the release process. Ensure artifacts can be deployed and rolled back.",
			needsLlm: LLM_ROLES.has("devops"),
		},
		evaluator: {
			role: "evaluator",
			label: t("canvas.metadata.role.evaluator.label"),

			icon: "⚖️",
			group: "output",
			blurb: t("canvas.metadata.role.evaluator.blurb"),
			defaultInstruction:
				"Act as a quality judge. Score correctness, completeness, and compliance from 0 to 100. Give reasons for rejection when the score is below 80.",
			needsLlm: LLM_ROLES.has("evaluator"),
		},
		custom: {
			role: "custom",
			label: t("canvas.metadata.role.custom.label"),

			icon: "🤖",
			group: "agent",
			blurb: t("canvas.metadata.role.custom.blurb"),
			defaultInstruction: "",
			needsLlm: LLM_ROLES.has("custom"),
		},
		// —— 逻辑控制（弱 LLM / 无需独立会话，直通或轻量判定）——
		condition: {
			role: "condition",
			label: t("canvas.metadata.role.condition.label"),

			icon: "🔀",
			group: "logic",
			blurb: t("canvas.metadata.role.condition.blurb"),
			defaultInstruction: "",
			needsLlm: LLM_ROLES.has("condition"),
		},
		ai_judge: {
			role: "ai_judge",
			label: t("canvas.metadata.role.ai_judge.label"),

			icon: "🧠",
			group: "logic",
			blurb: t("canvas.metadata.role.ai_judge.blurb"),
			defaultInstruction: "",
			needsLlm: LLM_ROLES.has("ai_judge"),
		},
		loop: {
			role: "loop",
			label: t("canvas.metadata.role.loop.label"),

			icon: "🔁",
			group: "logic",
			blurb: t("canvas.metadata.role.loop.blurb"),
			defaultInstruction: "",
			needsLlm: LLM_ROLES.has("loop"),
		},
		human: {
			role: "human",
			label: t("canvas.metadata.role.human.label"),

			icon: "🧑‍⚖️",
			group: "logic",
			blurb: t("canvas.metadata.role.human.blurb"),
			defaultInstruction: "",
			needsLlm: LLM_ROLES.has("human"),
		},
		merge: {
			role: "merge",
			label: t("canvas.metadata.role.merge.label"),

			icon: "🔗",
			group: "logic",
			blurb: t("canvas.metadata.role.merge.blurb"),
			defaultInstruction: "",
			needsLlm: LLM_ROLES.has("merge"),
		},
		subflow: {
			role: "subflow",
			label: t("canvas.metadata.role.subflow.label"),

			icon: "📦",
			group: "logic",
			blurb: t("canvas.metadata.role.subflow.blurb"),
			defaultInstruction: "Summarize the upstream deliverables into an input brief for the subflow.",
			needsLlm: LLM_ROLES.has("subflow"),
		},
		// —— 工具与数据 ——
		tool: {
			role: "tool",
			label: t("canvas.metadata.role.tool.label"),

			icon: "🛠️",
			group: "data",
			blurb: t("canvas.metadata.role.tool.blurb"),
			defaultInstruction:
				"Follow the tool invocation contract: state the purpose, run the tool, then summarize the result for downstream nodes.",
			needsLlm: LLM_ROLES.has("tool"),
		},
		knowledge: {
			role: "knowledge",
			label: t("canvas.metadata.role.knowledge.label"),

			icon: "📚",
			group: "data",
			blurb: t("canvas.metadata.role.knowledge.blurb"),
			defaultInstruction:
				"Answer using knowledge retrieval. List the retrieved evidence first, then synthesize an answer with sources.",
			needsLlm: LLM_ROLES.has("knowledge"),
		},
		code: {
			role: "code",
			label: t("canvas.metadata.role.code.label"),

			icon: "🧩",
			group: "data",
			blurb: t("canvas.metadata.role.code.blurb"),
			defaultInstruction:
				"Write and run the scripts needed to process the data, then hand a summary of the results downstream.",
			needsLlm: LLM_ROLES.has("code"),
		},
		api: {
			role: "api",
			label: t("canvas.metadata.role.api.label"),

			icon: "🌍",
			group: "data",
			blurb: t("canvas.metadata.role.api.blurb"),
			defaultInstruction:
				"Call the external API in the configuration, clean up its response, and hand a summary downstream.",
			needsLlm: LLM_ROLES.has("api"),
		},
		memory: {
			role: "memory",
			label: t("canvas.metadata.role.memory.label"),

			icon: "🧠",
			group: "data",
			blurb: t("canvas.metadata.role.memory.blurb"),
			defaultInstruction: "",
			needsLlm: LLM_ROLES.has("memory"),
		},
		end: {
			role: "end",
			label: t("canvas.metadata.role.end.label"),

			icon: "🏁",
			group: "output",
			blurb: t("canvas.metadata.role.end.blurb"),
			defaultInstruction: "",
			needsLlm: LLM_ROLES.has("end"),
		},
		pstack: {
			role: "pstack",
			label: t("canvas.metadata.role.pstack.label"),

			icon: "🥔",
			group: "agent",
			blurb: t("canvas.metadata.role.pstack.blurb"),
			defaultInstruction:
				"Follow the selected Pstack skill's rules and principles. Avoid superficial fixes and AI filler. Prove the delivery with execution evidence.",
			needsLlm: LLM_ROLES.has("pstack"),
		},
		skill: {
			role: "skill",
			label: t("canvas.metadata.role.skill.label"),

			icon: "✨",
			group: "agent",
			blurb: t("canvas.metadata.role.skill.blurb"),
			defaultInstruction:
				"Use the specified skill's professional rules as your operating guide. Follow its steps and standards strictly when executing the task.",
			needsLlm: LLM_ROLES.has("skill"),
		},
	};
}

interface NodeGroupMeta {
	id: RoleMeta["group"];
	label: string;
}

export function getRoleGroups(t: Translate): NodeGroupMeta[] {
	return [
		{ id: "trigger", label: t("canvas.metadata.group.trigger") },
		{ id: "agent", label: t("canvas.metadata.group.agent") },
		{ id: "logic", label: t("canvas.metadata.group.logic") },
		{ id: "data", label: t("canvas.metadata.group.data") },
		{ id: "output", label: t("canvas.metadata.group.output") },
	];
}

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
const LLM_ROLES: ReadonlySet<CanvasNodeRole> = new Set([
	"architect",
	"planner",
	"coder",
	"researcher",
	"writer",
	"analyst",
	"reviewer",
	"tester",
	"devops",
	"evaluator",
	"custom",
	"ai_judge",
	"subflow",
	"tool",
	"knowledge",
	"code",
	"api",
	"pstack",
	"skill",
]);

export function roleNeedsInstruction(role: CanvasNodeRole): boolean {
	return isRoleImplemented(role) && LLM_ROLES.has(role);
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

export function getStatusMetas(
	t: Translate,
): Record<CanvasNodeStatus, { label: string; text: string; bg: string; dot: string }> {
	return {
		skipped: { ...STATUS_COLORS.skipped, label: t("canvas.metadata.status.skipped") },
		cancelled: { ...STATUS_COLORS.cancelled, label: t("canvas.metadata.status.cancelled") },
		idle: { ...STATUS_COLORS.idle, label: t("canvas.metadata.status.idle") },
		queued: { ...STATUS_COLORS.queued, label: t("canvas.metadata.status.queued") },
		running: { ...STATUS_COLORS.running, label: t("canvas.metadata.status.running") },
		waiting_approval: { ...STATUS_COLORS.waiting_approval, label: t("canvas.metadata.status.waiting_approval") },
		done: { ...STATUS_COLORS.done, label: t("canvas.metadata.status.done") },
		error: { ...STATUS_COLORS.error, label: t("canvas.metadata.status.error") },
		paused: { ...STATUS_COLORS.paused, label: t("canvas.metadata.status.paused") },
	};
}

/** 字段级端子目录：端口不再是整卡一进一出，而是绑定卡片内具体数值。
 *  - 输入端（左侧）：contract=任务契约（主输入） instruction=AI指令 system=角色规约 config=控制参数
 *  - 输出端（右侧）：result=交付产物（主输出） true/false=条件分支 approve/reject=审批裁决
 *  位置由卡片 DOM 实测（offsetTop）上报，SvgEdges 按实测 Y 绘制，历史无端口边回退 PORT_Y_OFFSET。 */
interface CanvasPortDef {
	key: string;
	label: string;
	desc: string;
}

export function getInPortDefs(t: Translate): CanvasPortDef[] {
	return [
		{ key: "contract", label: t("canvas.metadata.port.contract.label"), desc: t("canvas.metadata.port.contract.desc") },
		{
			key: "instruction",
			label: t("canvas.metadata.port.instruction.label"),
			desc: t("canvas.metadata.port.instruction.desc"),
		},
		{ key: "system", label: t("canvas.metadata.port.system.label"), desc: t("canvas.metadata.port.system.desc") },
		{ key: "config", label: t("canvas.metadata.port.config.label"), desc: t("canvas.metadata.port.config.desc") },
	];
}

export function getOutPortDefsBase(t: Translate): CanvasPortDef[] {
	return [
		{ key: "result", label: t("canvas.metadata.port.result.label"), desc: t("canvas.metadata.port.result.desc") },
	];
}

/** 按角色追加分支输出端子（条件 / 人工 / 评估 / 审查）。 */
export function outPortsForRole(role: CanvasNodeRole, t: Translate = untranslated): CanvasPortDef[] {
	const extra: CanvasPortDef[] = [];
	if (role === "condition" || role === "ai_judge") {
		extra.push(
			{
				key: "true",
				label: t("canvas.metadata.port.condition.true.label"),
				desc: t("canvas.metadata.port.condition.true.desc"),
			},
			{
				key: "false",
				label: t("canvas.metadata.port.condition.false.label"),
				desc: t("canvas.metadata.port.condition.false.desc"),
			},
		);
	}
	if (role === "human") {
		extra.push(
			{
				key: "approve",
				label: t("canvas.metadata.port.human.approve.label"),
				desc: t("canvas.metadata.port.human.approve.desc"),
			},
			{
				key: "reject",
				label: t("canvas.metadata.port.human.reject.label"),
				desc: t("canvas.metadata.port.human.reject.desc"),
			},
		);
	}
	if (role === "evaluator" || role === "reviewer") {
		extra.push(
			{
				key: "approve",
				label: t("canvas.metadata.port.review.approve.label"),
				desc: t("canvas.metadata.port.review.approve.desc"),
			},
			{
				key: "reject",
				label: t("canvas.metadata.port.review.reject.label"),
				desc: t("canvas.metadata.port.review.reject.desc"),
			},
		);
	}
	return [...getOutPortDefsBase(t), ...extra];
}

export function inPortLabel(key: string | undefined, t: Translate = untranslated): string {
	if (!key || key === "contract") return t("canvas.metadata.port.contract.label");
	return getInPortDefs(t).find((d) => d.key === key)?.label ?? key;
}

export function outPortLabel(key: string | undefined, t: Translate = untranslated): string {
	if (!key || key === "result") return t("canvas.metadata.port.result.label");
	const labels: Record<string, string> = {
		true: t("canvas.metadata.port.condition.true.label"),
		false: t("canvas.metadata.port.condition.false.label"),
		approve: t("canvas.metadata.port.approve.label"),
		reject: t("canvas.metadata.port.review.reject.label"),
	};
	return labels[key] ?? key;
}

/** 按角色分型的专属参数表：每个角色只露自己的配置，不再所有节点一个样。
 *  - 卡片：Agent 类渲染为「角色专属参数」组；纯代码类渲染为 utility 专属区（含 config 端子）
 *  - 抽屉：控制参数区同表驱动，保持两端一致
 *  - 调度器：Agent 节点的非空配置会拼入提示词「本节点专属参数」，所见即所得 */
type RoleFieldKind = "text" | "textarea" | "number" | "select" | "hint" | "boolean";

export interface RoleField {
	key: string;
	label: string;
	kind: RoleFieldKind;
	placeholder?: string;
	options?: { value: string; label: string }[];
	min?: number;
	max?: number;
	default?: string | number | boolean;
	rows?: number;
	hint?: string;
	showIf?: { key: string; value: string | number | boolean };
}

export function getRoleFields(t: Translate): Record<CanvasNodeRole, RoleField[]> {
	return {
		trigger: [
			{
				key: "payload",
				label: t("canvas.metadata.field.trigger.payload.label"),
				kind: "textarea",
				rows: 4,
				placeholder: t("canvas.metadata.field.trigger.payload.placeholder"),
			},
		],
		cron: [
			{
				key: "cron",
				label: t("canvas.metadata.field.cron.cron.label"),
				kind: "text",
				default: "*/30 * * * *",
				placeholder: t("canvas.metadata.field.cron.cron.placeholder"),
				hint: t("canvas.metadata.field.cron.cron.hint"),
			},
		],
		webhook: [
			{
				key: "path",
				label: t("canvas.metadata.field.webhook.path.label"),
				kind: "text",
				default: "/hook/demo",
				placeholder: t("canvas.metadata.field.webhook.path.placeholder"),
			},
			{
				key: "method",
				label: t("canvas.metadata.field.webhook.method.label"),
				kind: "select",
				default: "POST",
				options: [
					{ value: "GET", label: t("canvas.metadata.field.webhook.method.option0") },
					{ value: "POST", label: t("canvas.metadata.field.webhook.method.option1") },
				],
				hint: t("canvas.metadata.field.webhook.method.hint"),
			},
		],
		transform: [
			{
				key: "mode",
				label: t("canvas.metadata.field.transform.mode.label"),
				kind: "select",
				default: "text2json",
				options: [
					{ value: "text2json", label: t("canvas.metadata.field.transform.mode.option0") },
					{ value: "json2text", label: t("canvas.metadata.field.transform.mode.option1") },
					{ value: "template", label: t("canvas.metadata.field.transform.mode.option2") },
				],
			},
			{
				key: "template",
				label: t("canvas.metadata.field.transform.template.label"),
				kind: "textarea",
				rows: 3,
				default: "{{input}}",
				placeholder: t("canvas.metadata.field.transform.template.placeholder"),
				showIf: { key: "mode", value: "template" },
			},
		],
		architect: [],
		planner: [
			{
				key: "maxSteps",
				label: t("canvas.metadata.field.planner.maxSteps.label"),
				kind: "number",
				min: 2,
				max: 12,
				default: 5,
			},
		],
		coder: [],
		researcher: [
			{
				key: "depth",
				label: t("canvas.metadata.field.researcher.depth.label"),
				kind: "select",
				default: "标准",
				options: [
					{ value: "快速", label: t("canvas.metadata.field.researcher.depth.option0") },
					{ value: "标准", label: t("canvas.metadata.field.researcher.depth.option1") },
					{ value: "深度", label: t("canvas.metadata.field.researcher.depth.option2") },
				],
			},
			{
				key: "maxSources",
				label: t("canvas.metadata.field.researcher.maxSources.label"),
				kind: "number",
				min: 1,
				max: 20,
				default: 5,
			},
		],
		writer: [],
		analyst: [],
		reviewer: [
			{
				key: "strictness",
				label: t("canvas.metadata.field.reviewer.strictness.label"),
				kind: "select",
				default: "标准",
				options: [
					{ value: "宽松", label: t("canvas.metadata.field.reviewer.strictness.option0") },
					{ value: "标准", label: t("canvas.metadata.field.reviewer.strictness.option1") },
					{ value: "严格", label: t("canvas.metadata.field.reviewer.strictness.option2") },
				],
			},
		],
		tester: [
			{
				key: "testCommand",
				label: t("canvas.metadata.field.tester.testCommand.label"),
				kind: "text",
				default: "npm test",
				placeholder: t("canvas.metadata.field.tester.testCommand.placeholder"),
			},
		],
		devops: [
			{
				key: "environment",
				label: t("canvas.metadata.field.devops.environment.label"),
				kind: "select",
				default: "预发",
				options: [
					{ value: "预发", label: t("canvas.metadata.field.devops.environment.option0") },
					{ value: "生产", label: t("canvas.metadata.field.devops.environment.option1") },
				],
			},
		],
		evaluator: [
			{
				key: "threshold",
				label: t("canvas.metadata.field.evaluator.threshold.label"),
				kind: "number",
				min: 0,
				max: 100,
				default: 80,
				hint: t("canvas.metadata.field.evaluator.threshold.hint"),
			},
		],
		custom: [],
		condition: [
			{
				key: "condition",
				label: t("canvas.metadata.field.condition.condition.label"),
				kind: "text",
				default: "reject/fail",
				placeholder: t("canvas.metadata.field.condition.condition.placeholder"),
			},
		],
		ai_judge: [
			{
				key: "judge",
				label: t("canvas.metadata.field.ai_judge.judge.label"),
				kind: "textarea",
				rows: 2,
				placeholder: t("canvas.metadata.field.ai_judge.judge.placeholder"),
				hint: t("canvas.metadata.field.ai_judge.judge.hint"),
			},
		],
		loop: [
			{
				key: "loopCount",
				label: t("canvas.metadata.field.loop.loopCount.label"),
				kind: "number",
				min: 1,
				max: 10,
				default: 3,
				hint: t("canvas.metadata.field.loop.loopCount.hint"),
			},
		],
		human: [
			{
				key: "approvalHint",
				label: t("canvas.metadata.field.human.approvalHint.label"),
				kind: "text",
				default: "Check that the deliverable meets the acceptance criteria before approving",
				placeholder: t("canvas.metadata.field.human.approvalHint.placeholder"),
			},
		],
		knowledge: [
			{
				key: "topK",
				label: t("canvas.metadata.field.knowledge.topK.label"),
				kind: "number",
				min: 1,
				max: 20,
				default: 5,
			},
			{
				key: "baseId",
				label: t("canvas.metadata.field.knowledge.baseId.label"),
				kind: "text",
				placeholder: t("canvas.metadata.field.knowledge.baseId.placeholder"),
			},
		],
		tool: [
			{
				key: "toolName",
				label: t("canvas.metadata.field.tool.toolName.label"),
				kind: "text",
				default: "bash",
				placeholder: t("canvas.metadata.field.tool.toolName.placeholder"),
			},
		],
		code: [
			{
				key: "language",
				label: t("canvas.metadata.field.code.language.label"),
				kind: "select",
				default: "TypeScript",
				options: [
					{ value: "TypeScript", label: t("canvas.metadata.field.code.language.option0") },
					{ value: "Python", label: t("canvas.metadata.field.code.language.option1") },
					{ value: "Bash", label: t("canvas.metadata.field.code.language.option2") },
				],
			},
			{
				key: "entry",
				label: t("canvas.metadata.field.code.entry.label"),
				kind: "textarea",
				rows: 3,
				placeholder: t("canvas.metadata.field.code.entry.placeholder"),
			},
		],
		api: [
			{
				key: "apiUrl",
				label: t("canvas.metadata.field.api.apiUrl.label"),
				kind: "text",
				default: "https://",
				placeholder: t("canvas.metadata.field.api.apiUrl.placeholder"),
			},
			{
				key: "apiMethod",
				label: t("canvas.metadata.field.api.apiMethod.label"),
				kind: "select",
				default: "POST",
				options: [
					{ value: "GET", label: t("canvas.metadata.field.api.apiMethod.option0") },
					{ value: "POST", label: t("canvas.metadata.field.api.apiMethod.option1") },
					{ value: "PUT", label: t("canvas.metadata.field.api.apiMethod.option2") },
					{ value: "DELETE", label: t("canvas.metadata.field.api.apiMethod.option3") },
				],
			},
		],
		merge: [],
		memory: [
			{
				key: "memoryKey",
				label: t("canvas.metadata.field.memory.memoryKey.label"),
				kind: "text",
				default: "shared_memory",
				placeholder: t("canvas.metadata.field.memory.memoryKey.placeholder"),
			},
		],
		end: [],
		subflow: [
			{
				key: "subflowId",
				label: t("canvas.metadata.field.subflow.subflowId.label"),
				kind: "text",
				placeholder: t("canvas.metadata.field.subflow.subflowId.placeholder"),
			},
		],
		pstack: [
			{
				key: "skill",
				label: t("canvas.metadata.field.pstack.skill.label"),
				kind: "select",
				default: "poteto-mode",
				options: getPstackSkills(t).map((s) => ({ value: s.id, label: `${s.icon} ${s.name} (${s.id})` })),
				hint: t("canvas.metadata.field.pstack.skill.hint"),
			},
		],
		skill: [
			{
				key: "skillName",
				label: t("canvas.metadata.field.skill.skillName.label"),
				kind: "select",
				default: "",
				options: [
					{
						value: "",
						label: t("canvas.metadata.field.skill.skillName.option0"),
					},
				],
				hint: t("canvas.metadata.field.skill.skillName.hint"),
			},
		],
	};
}

/** 每个角色的输入输出速查（卡片 ? 提示用）：输入要什么 / 输出给什么 / 一句话用法 */
interface RoleIoHelp {
	input: string;
	output: string;
	usage: string;
}

export function getRoleIoHelp(t: Translate): Record<CanvasNodeRole, RoleIoHelp> {
	return {
		trigger: {
			input: t("canvas.metadata.io.trigger.input"),
			output: t("canvas.metadata.io.trigger.output"),
			usage: t("canvas.metadata.io.trigger.usage"),
		},
		cron: {
			input: t("canvas.metadata.io.cron.input"),
			output: t("canvas.metadata.io.cron.output"),
			usage: t("canvas.metadata.io.cron.usage"),
		},
		webhook: {
			input: t("canvas.metadata.io.webhook.input"),
			output: t("canvas.metadata.io.webhook.output"),
			usage: t("canvas.metadata.io.webhook.usage"),
		},
		transform: {
			input: t("canvas.metadata.io.transform.input"),
			output: t("canvas.metadata.io.transform.output"),
			usage: t("canvas.metadata.io.transform.usage"),
		},
		architect: {
			input: t("canvas.metadata.io.architect.input"),
			output: t("canvas.metadata.io.architect.output"),
			usage: t("canvas.metadata.io.architect.usage"),
		},
		planner: {
			input: t("canvas.metadata.io.planner.input"),
			output: t("canvas.metadata.io.planner.output"),
			usage: t("canvas.metadata.io.planner.usage"),
		},
		coder: {
			input: t("canvas.metadata.io.coder.input"),
			output: t("canvas.metadata.io.coder.output"),
			usage: t("canvas.metadata.io.coder.usage"),
		},
		researcher: {
			input: t("canvas.metadata.io.researcher.input"),
			output: t("canvas.metadata.io.researcher.output"),
			usage: t("canvas.metadata.io.researcher.usage"),
		},
		writer: {
			input: t("canvas.metadata.io.writer.input"),
			output: t("canvas.metadata.io.writer.output"),
			usage: t("canvas.metadata.io.writer.usage"),
		},
		analyst: {
			input: t("canvas.metadata.io.analyst.input"),
			output: t("canvas.metadata.io.analyst.output"),
			usage: t("canvas.metadata.io.analyst.usage"),
		},
		reviewer: {
			input: t("canvas.metadata.io.reviewer.input"),
			output: t("canvas.metadata.io.reviewer.output"),
			usage: t("canvas.metadata.io.reviewer.usage"),
		},
		tester: {
			input: t("canvas.metadata.io.tester.input"),
			output: t("canvas.metadata.io.tester.output"),
			usage: t("canvas.metadata.io.tester.usage"),
		},
		devops: {
			input: t("canvas.metadata.io.devops.input"),
			output: t("canvas.metadata.io.devops.output"),
			usage: t("canvas.metadata.io.devops.usage"),
		},
		evaluator: {
			input: t("canvas.metadata.io.evaluator.input"),
			output: t("canvas.metadata.io.evaluator.output"),
			usage: t("canvas.metadata.io.evaluator.usage"),
		},
		custom: {
			input: t("canvas.metadata.io.custom.input"),
			output: t("canvas.metadata.io.custom.output"),
			usage: t("canvas.metadata.io.custom.usage"),
		},
		condition: {
			input: t("canvas.metadata.io.condition.input"),
			output: t("canvas.metadata.io.condition.output"),
			usage: t("canvas.metadata.io.condition.usage"),
		},
		ai_judge: {
			input: t("canvas.metadata.io.ai_judge.input"),
			output: t("canvas.metadata.io.ai_judge.output"),
			usage: t("canvas.metadata.io.ai_judge.usage"),
		},
		loop: {
			input: t("canvas.metadata.io.loop.input"),
			output: t("canvas.metadata.io.loop.output"),
			usage: t("canvas.metadata.io.loop.usage"),
		},
		human: {
			input: t("canvas.metadata.io.human.input"),
			output: t("canvas.metadata.io.human.output"),
			usage: t("canvas.metadata.io.human.usage"),
		},
		merge: {
			input: t("canvas.metadata.io.merge.input"),
			output: t("canvas.metadata.io.merge.output"),
			usage: t("canvas.metadata.io.merge.usage"),
		},
		subflow: {
			input: t("canvas.metadata.io.subflow.input"),
			output: t("canvas.metadata.io.subflow.output"),
			usage: t("canvas.metadata.io.subflow.usage"),
		},
		tool: {
			input: t("canvas.metadata.io.tool.input"),
			output: t("canvas.metadata.io.tool.output"),
			usage: t("canvas.metadata.io.tool.usage"),
		},
		knowledge: {
			input: t("canvas.metadata.io.knowledge.input"),
			output: t("canvas.metadata.io.knowledge.output"),
			usage: t("canvas.metadata.io.knowledge.usage"),
		},
		code: {
			input: t("canvas.metadata.io.code.input"),
			output: t("canvas.metadata.io.code.output"),
			usage: t("canvas.metadata.io.code.usage"),
		},
		api: {
			input: t("canvas.metadata.io.api.input"),
			output: t("canvas.metadata.io.api.output"),
			usage: t("canvas.metadata.io.api.usage"),
		},
		memory: {
			input: t("canvas.metadata.io.memory.input"),
			output: t("canvas.metadata.io.memory.output"),
			usage: t("canvas.metadata.io.memory.usage"),
		},
		end: {
			input: t("canvas.metadata.io.end.input"),
			output: t("canvas.metadata.io.end.output"),
			usage: t("canvas.metadata.io.end.usage"),
		},
		pstack: {
			input: t("canvas.metadata.io.pstack.input"),
			output: t("canvas.metadata.io.pstack.output"),
			usage: t("canvas.metadata.io.pstack.usage", { count: getPstackSkills(t).length }),
		},
		skill: {
			input: t("canvas.metadata.io.skill.input"),
			output: t("canvas.metadata.io.skill.output"),
			usage: t("canvas.metadata.io.skill.usage"),
		},
	};
}

/** 取某角色可见的字段（含 showIf 联动显隐） */
export function visibleRoleFields(
	role: CanvasNodeRole,
	config: Record<string, string | number | boolean | undefined> | undefined,
	t: Translate = untranslated,
): RoleField[] {
	if (!isRoleImplemented(role)) return [{ key: "capability", kind: "hint", label: roleCapabilityNotice(role, t) }];
	return (getRoleFields(t)[role] ?? []).filter(
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
export function roleCapabilityNotice(role: CanvasNodeRole, t: Translate = untranslated): string {
	if (!isRoleImplemented(role)) return t("canvas.metadata.capability.descriptionOnly");
	if (["tool", "code", "api", "knowledge"].includes(role)) return t("canvas.metadata.capability.agentInstruction");
	return "";
}

export const runtimeCapabilityNote = roleCapabilityNotice;
