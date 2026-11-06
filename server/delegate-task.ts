/**
 * delegate_task —— 结构化派单工具（oh-my-pi 委派协议的代码级硬化）。
 *
 * 背景：单纯靠提示词要求模型“派单写详细”是没有强制力的——模型糊弄也不会有
 * 任何后果。本工具把六段式派单格式写进参数 schema + 服务端校验：缺段/太短/
 * 模板不可用直接报错打回（错误文本留在上下文里，模型补全后重试）。
 *
 * 与 subagent_spawn 的关系：并存。subagent_spawn 是通用自由派单；delegate_task
 * 是走 specialist 模板的结构化派单（agent 必填且必须是启用的模板）。执行体复用
 * 同一条 spawn 通道（SubagentToolHost.spawnSubagent）：真子代理会话、白名单、
 * 模型优先级、左栏徽标、等待/改向/停止全套机制都不用重写。
 *
 * 纯函数（validateDelegation / buildDelegationPrompt）可单测；语言按 ServerLang
 * 切中英（section 头固定英文——子代理侧各模板早已习惯英文段头；面向派单者的
 * 错误文本走 pick，key 缺失时自动回落英文，见 server/i18n.ts）。
 */
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { pick, type ServerLang } from "./i18n.js";
import { DELEGATE_TASK_TOOL_NAME } from "./tool-manager.js";
import { subagentTitle, type SubagentToolHost } from "./subagents.js";
import { parseRequiredTools, resolveSecurityMode, type SubagentSpawnExtra } from "./subagent-security-gate.js";

/** 工具名（唯一值在 tool-manager.ts；本别名保留：前端派单卡片与旧导入沿用它）。 */
export const DELEGATE_TOOL_NAME = DELEGATE_TASK_TOOL_NAME;

/** 各段最小长度（trim 后字符数）：TASK 必须具体，OUTCOME 必须可验收，其余段不许空着。 */
const MIN_TASK = 20;
const MIN_OUTCOME = 10;

/** 六段的固定英文名（校验报错与拼装 prompt 共用，子代理侧无需翻译）。 */
const SECTIONS = ["TASK", "EXPECTED OUTCOME", "REQUIRED TOOLS", "MUST DO", "MUST NOT DO", "CONTEXT"] as const;

/** 归一化后的派单输入（执行前把脏参数洗成字符串；非字符串一律按缺失处理）。 */
export interface DelegationInput {
	agent: string;
	task: string;
	expected_outcome: string;
	required_tools: string;
	must_do: string;
	must_not_do: string;
	context: string;
	model?: string;
	persist?: boolean;
}

function str(v: unknown): string {
	return typeof v === "string" ? v : "";
}

/** 把模型传进来的脏参数归一化（缺字段/错类型不抛错，交给校验报错）。 */
export function normalizeDelegation(params: unknown): DelegationInput {
	const p = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
	return {
		agent: str(p.agent).trim(),
		task: str(p.task),
		expected_outcome: str(p.expected_outcome),
		required_tools: str(p.required_tools),
		must_do: str(p.must_do),
		must_not_do: str(p.must_not_do),
		context: str(p.context),
		model: str(p.model).trim() || undefined,
		persist: typeof p.persist === "boolean" ? p.persist : undefined,
	};
}

/**
 * 校验派单输入；通过返回 null，否则返回直接回给模型的错误文本（已按 lang 选好语言）。
 * `usableNames` = 当前可用模板名（host.listTemplates()，只含 enabled 的）。
 */
export function validateDelegation(
	input: DelegationInput,
	usableNames: string[],
	lang: ServerLang = "en",
): string | null {
	if (!input.agent || !usableNames.includes(input.agent)) {
		const shown = usableNames.slice(0, 12).join(" · ") + (usableNames.length > 12 ? " · …" : "");
		return pick(
			lang,
			`派单被驳回：模板 "${input.agent || "(空)"}" 不可用（不存在或已停用）。可用模板：${shown || "(无)"}。用 subagent(action="templates") 查简介再选；不要编造模板名。`,
			`Delegation rejected: template "${input.agent || "(empty)"}" is unavailable (missing or disabled). Available templates: ${shown || "(none)"}. Use subagent(action="templates") for descriptions; do not invent template names.`,
			"delegate.validate.agent",
			{ agent: input.agent, available: shown },
		);
	}
	const checks: { section: (typeof SECTIONS)[number]; text: string; min: number }[] = [
		{ section: "TASK", text: input.task, min: MIN_TASK },
		{ section: "EXPECTED OUTCOME", text: input.expected_outcome, min: MIN_OUTCOME },
		{ section: "REQUIRED TOOLS", text: input.required_tools, min: 1 },
		{ section: "MUST DO", text: input.must_do, min: 1 },
		{ section: "MUST NOT DO", text: input.must_not_do, min: 1 },
		{ section: "CONTEXT", text: input.context, min: 1 },
	];
	for (const c of checks) {
		if (c.text.trim().length < c.min) {
			return pick(
				lang,
				`派单被驳回：${c.section} 段太短（至少 ${c.min} 字，当前 ${c.text.trim().length} 字）。六段缺一不可、含糊不得：补全后重试，不要改用 subagent(action="spawn") 绕过校验。`,
				`Delegation rejected: section ${c.section} is too short (minimum ${c.min} chars, got ${c.text.trim().length}). All six sections are mandatory and vague prompts fail: complete it and retry; do not bypass validation via subagent(action="spawn").`,
				"delegate.validate.short",
				{ section: c.section, min: c.min },
			);
		}
	}
	return null;
}

/** 拼装发给子代理的标准六段 prompt（段头固定英文；收尾一行为汇报纪律）。 */
export function buildDelegationPrompt(input: DelegationInput, lang: ServerLang = "en"): string {
	const firstLine = input.task.split("\n")[0]?.trim().slice(0, 80) || input.agent;
	const closer =
		lang === "zh"
			? "汇报要简洁：做了什么、证据（路径/行号/输出）、遇到的问题、下一步建议。不扩大范围。"
			: "Report back concisely: what was done, evidence (paths/line numbers/output), problems, suggested next steps. Do not expand scope.";
	return [
		`# ${input.agent}: ${firstLine}`,
		``,
		`## TASK`,
		input.task.trim(),
		``,
		`## EXPECTED OUTCOME`,
		input.expected_outcome.trim(),
		``,
		`## REQUIRED TOOLS`,
		input.required_tools.trim(),
		``,
		`## MUST DO`,
		input.must_do.trim(),
		``,
		`## MUST NOT DO`,
		input.must_not_do.trim(),
		``,
		`## CONTEXT`,
		input.context.trim(),
		``,
		`---`,
		closer,
	].join("\n");
}

const delegateSchema = Type.Object({
	agent: Type.String({
		description:
			"Specialist template to delegate to (e.g. oracle, explore, review, librarian). " +
			"Must be enabled — use subagent (action='templates') to list them and pick the domain match.",
	}),
	task: Type.String({
		description: "Atomic, specific goal: ONE action per delegation. Vague tasks are rejected.",
	}),
	expected_outcome: Type.String({
		description: "Concrete deliverables with done criteria.",
	}),
	required_tools: Type.String({
		description: "Explicit tool whitelist for the subagent (prevents tool sprawl).",
	}),
	must_do: Type.String({
		description: "Exhaustive requirements — leave NOTHING implicit.",
	}),
	must_not_do: Type.String({
		description: "Forbidden actions — anticipate and block rogue behavior.",
	}),
	context: Type.String({
		description: "File paths, existing patterns, constraints the subagent must know.",
	}),
	model: Type.Optional(
		Type.String({
			description:
				'Optional model "provider/id" for this delegation; ' +
				"omit = template model → panel default → follow the main conversation model.",
		}),
	),
	persist: Type.Optional(
		Type.Boolean({
			description:
				"Persist as a regular session saved in history (default false = lightweight in-memory subagent); " +
				"use for tasks needing long-term retention.",
		}),
	),
});

/** 结构化派单工具：校验六段 → 拼装标准 prompt → 走 host.spawnSubagent 真子代理。 */
export function makeDelegateTaskTool(host: SubagentToolHost, lang?: () => ServerLang): ToolDefinition {
	const getLang: () => ServerLang = lang ?? host.lang ?? (() => "en");
	const text = (t: string, details: unknown = {}): { content: { type: "text"; text: string }[]; details: unknown } => ({
		content: [{ type: "text", text: t }],
		details,
	});
	return defineTool({
		name: DELEGATE_TOOL_NAME,
		label: "Delegate task",
		description:
			"Delegate ONE well-defined task to a specialist template via a six-section brief (TASK / EXPECTED OUTCOME / REQUIRED TOOLS / MUST DO / MUST NOT DO / CONTEXT). " +
			"Vague sections are rejected server-side — fill every one concretely. Prefer it over subagent (action='spawn'). Spawns a real subagent conversation; " +
			"follow up with subagent (action='wait_all' | 'get_result' | 'steer' | 'stop'), continuing the SAME session rather than delegating again.",
		promptSnippet: "hand a well-scoped task to a specialist template",
		promptGuidelines: [
			"Before delegating, declare which template you chose and WHY its description matches the task",
			"After delegation ALWAYS verify the result: " +
				"does it work, does it follow codebase patterns, did it respect MUST DO / MUST NOT DO",
			"Never start implementing work that a pending delegated result was asked to decide",
		],
		parameters: delegateSchema,
		execute: async (_id, params, _signal, _onUpdate, ctx) => {
			const input = normalizeDelegation(params);
			const usable = host.listTemplates().map((t) => t.name);
			const err = validateDelegation(input, usable, getLang());
			if (err) return text(err, { delegated: false, agent: input.agent });
			const prompt = buildDelegationPrompt(input, getLang());
			const parsedTools = parseRequiredTools(input.required_tools);
			const matchedTemplate = host.listTemplates().find((t) => t.name === input.agent);
			let securityMode = resolveSecurityMode(input.agent, matchedTemplate);
			if (parsedTools.requestedReadOnly && securityMode === "normal") {
				securityMode = "readonly";
			}
			const extra: SubagentSpawnExtra = {
				allowedTools: parsedTools.allowedTools,
				securityMode,
			};
			// 与 subagent_spawn 同理：spawn 通道是唯一的失败面（数量上限 / runtime
			// 创建失败都经由 host 抛错），转成返回文本让 AI 能读到原因并修正重试。
			let convId: string;
			try {
				convId = await host.spawnSubagent(
					prompt,
					"delegate",
					ctx.cwd,
					input.agent,
					input.model,
					undefined,
					input.persist,
					undefined,
					undefined,
					undefined,
					extra,
				);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return text(
					pick(getLang(), `派单启动失败：${msg}`, `Failed to start delegation: ${msg}`, "delegate.start.failed", {
						error: msg,
					}),
					{ delegated: false, agent: input.agent },
				);
			}
			const title = subagentTitle(prompt);
			const modelLineZh = input.model ? `\n模型：${input.model}` : "";
			const modelLineEn = input.model ? `\nModel: ${input.model}` : "";
			const toolsLineZh = parsedTools.allowedTools ? `\n工具白名单：${parsedTools.allowedTools.join(", ")}` : "";
			const toolsLineEn = parsedTools.allowedTools ? `\nAllowed tools: ${parsedTools.allowedTools.join(", ")}` : "";
			const securityLineZh =
				securityMode !== "normal" ? `\n安全模式：${securityMode === "readonly" ? "严格只读" : "审查验证"}` : "";
			const securityLineEn = securityMode !== "normal" ? `\nSecurity mode: ${securityMode}` : "";
			return text(
				pick(
					getLang(),
					`已派单：${convId}\n模板：${input.agent} · 标题：${title}${modelLineZh}${toolsLineZh}${securityLineZh}` +
						`\n子代理已在左栏运行列表中。用 subagent(action="wait_all") 一次等全部完成（不用轮询）、subagent(action="get_result") 取单个结果；` +
						`追问请在同一子代理会话里继续（subagent(action="steer")），不要重复派单。拿到结果后必须验证再汇报。`,
					`Delegated: ${convId}\nTemplate: ${input.agent} · Title: ${title}${modelLineEn}${toolsLineEn}${securityLineEn}` +
						`\nThe subagent is in the left running list. Use subagent(action="wait_all") to wait for all at once (no polling), ` +
						`subagent(action="get_result") for a single result; continue follow-ups in the SAME subagent session (subagent(action="steer")), ` +
						`do not delegate again. Verify the result before reporting.`,
					"delegate.started",
					{
						convId: convId,
						agent: input.agent,
						title: title,
						"input.model": input.model,
						modelLine: modelLineEn,
						modelLineZh,
						modelLineEn,
						toolsLineEn,
						securityLineEn,
					},
				),
				{ convId, agent: input.agent, template: input.agent, model: input.model },
			);
		},
	});
}
