import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { QuestionAnswer, UiQuestion } from "./protocol.js";
import { pick, type ServerLang } from "./i18n.js";
import { type SubagentSpawnExtra, resolveSecurityMode } from "./subagent-security-gate.js";
import { THINKING_LEVELS } from "./subagent-templates.js";
import { CONVERSATION_TOOL_NAME, SUBAGENT_TOOL_NAME } from "./tool-manager.js";
export { CONVERSATION_TOOL_NAME, SUBAGENT_TOOL_NAME } from "./tool-manager.js";

export type SubagentState = "running" | "queued" | "done" | "canceled";

export function computeWaitCapMs(watchdogMs?: number): number {
	const customSecs = Number(process.env.PI_WEB_SUBAGENT_WAIT_CAP_SECONDS);
	if (Number.isFinite(customSecs) && customSecs > 0) {
		return Math.max(Math.floor(customSecs * 1000), 5_000);
	}
	const envWatchdog = Number(process.env.PI_WEB_TOOL_TIMEOUT_MS);
	const watchdog =
		typeof watchdogMs === "number" && Number.isFinite(watchdogMs) && watchdogMs > 0
			? watchdogMs
			: Number.isFinite(envWatchdog) && envWatchdog > 0
				? envWatchdog
				: 20 * 60_000;
	return Math.max(Math.floor(watchdog * 0.8), 5_000);
}

export function isSubagentTerminal(r: SubagentSnapshot | undefined): boolean {
	return !!r && !r.streaming && (!r.taskPending || !!r.error || !!r.canceled);
}

export interface SubagentSnapshot {
	convId: string;
	executionId?: string;
	parentExecutionId?: string;
	type: string;
	title: string;
	prompt: string;
	state: SubagentState;
	streaming: boolean;
	taskPending?: boolean;
	error?: string;
	canceled?: boolean;
	messageCount: number;
	model?: string;
	thinkingLevel?: string;
	output: string;
	parentId?: string;
	persisted?: boolean;
	handoffTo?: string[];
	handoffFrom?: string[];
	worktree?: {
		path: string;
		branch: string;
		cleanedUp: boolean;
		isDirty?: boolean;
		uncommittedCount?: number;
		aheadCount?: number;
		error?: string;
	};
}

export interface SubagentToolHost {
	completeSubagent?(selfId: string, summary: string): unknown;
	consultParent?(selfConvId: string, questions: UiQuestion[], signal?: AbortSignal): Promise<unknown>;
	answerConsult?(selfConvId: string, runId: string, requestId: string, answers: QuestionAnswer[]): unknown;
	escalateConsult?(selfConvId: string, runId: string, requestId: string): unknown;
	getPendingConsults?(parentId: string): Array<{ runId: string; requestId: string; questions: UiQuestion[] }>;
	setConsultWaiting?(parentId: string, waiting: boolean): void;
	isRequestSteering?(parentId: string, requestId: string): boolean;
	spawnSubagent(
		prompt: string,
		type: string,
		cwd: string,
		templateName?: string,
		model?: string,
		parentId?: string,
		persist?: boolean,
		thinking?: string,
		notifyOnDone?: boolean | "manual",
		isolation?: string,
		extra?: SubagentSpawnExtra,
		signal?: AbortSignal,
	): Promise<string>;
	getSubagent(convId: string): SubagentSnapshot | undefined;
	resolveConversationId?(id: string): string | undefined;
	listSubagents(scope?: "all" | "subagent" | "persistent", forSelfId?: string): SubagentSnapshot[];
	steerSubagent(convId: string, message: string): Promise<void>;
	stopSubagent(convId: string): Promise<void>;
	listTemplates(): {
		name: string;
		description: string;
		descriptionEn?: string;
		model?: string;
		thinkingLevel?: string;
	}[];
	getWatchdogTimeoutMs?(): number;
	getActiveConversationId?(): string | undefined;
	dismissSubagent?(
		convId: string,
		opts?: { force?: boolean; includePersisted?: boolean },
	): Promise<{ ok: boolean; reason?: string }>;
	isTemplateUsable(name: string): boolean;
	handoffSubagent(fromRunId: string, toRunId: string, payload: string): Promise<void>;
	markSubagentsConsumed?(runIds: string[]): void;
	finalizeSubagentWorktree?(convId: string): Promise<void>;
	lang?: () => ServerLang;
}

export function subagentTitle(prompt: string): string {
	const line = prompt.split("\n")[0]?.trim() ?? "";
	return line.length > 40 ? `${line.slice(0, 40)}…` : line;
}

export function withSubagentOwner(
	host: SubagentToolHost,
	ownerId: string,
	resolveOwner: () => string = () => ownerId,
): SubagentToolHost {
	return {
		...host,
		spawnSubagent: (
			prompt,
			type,
			cwd,
			templateName,
			model,
			_parentId,
			persist,
			thinking,
			notifyOnDone,
			isolation,
			extra,
			signal,
		) => {
			signal?.throwIfAborted();
			const args: unknown[] = [prompt, type, cwd, templateName, model, resolveOwner(), persist, thinking, notifyOnDone];
			if (isolation !== undefined || extra !== undefined || signal !== undefined) {
				args.push(isolation);
			}
			if (extra !== undefined || signal !== undefined) {
				args.push(extra);
			}
			if (signal !== undefined) args.push(signal);
			return host.spawnSubagent(...(args as Parameters<SubagentToolHost["spawnSubagent"]>));
		},
		handoffSubagent: async (fromRunId, toRunId, payload) => {
			const selfId = resolveOwner();
			if (!selfId) throw new Error("Handoff requires a verified conversation identity.");
			if (fromRunId && fromRunId !== selfId) throw new Error("Handoff source must match the calling conversation.");
			return host.handoffSubagent(selfId, toRunId, payload);
		},
		markSubagentsConsumed: (runIds) => host.markSubagentsConsumed?.(runIds),
		finalizeSubagentWorktree: (convId) => host.finalizeSubagentWorktree?.(convId) ?? Promise.resolve(),
		getActiveConversationId: () => host.getActiveConversationId?.(),
		dismissSubagent: (convId, opts) =>
			host.dismissSubagent?.(convId, opts) ?? Promise.resolve({ ok: false, reason: "unsupported" }),
	};
}

export const SUBAGENT_ACTIONS = [
	"spawn",
	"complete",
	"get_result",
	"steer",
	"list",
	"stop",
	"wait_all",
	"templates",
	"handoff",
	"dismiss",
	"consult",
	"answer",
	"escalate",
] as const;

export type SubagentAction = (typeof SUBAGENT_ACTIONS)[number];

export function makeSubagentTool(
	host: SubagentToolHost,
	lang?: () => ServerLang,
	selfConvId?: string | (() => string | undefined),
): ToolDefinition {
	const selfIdOf = (): string | undefined => (typeof selfConvId === "function" ? selfConvId() : selfConvId);
	const executionOf = (snapshot: SubagentSnapshot): string => snapshot.executionId ?? snapshot.convId;
	const executionOfId = (id: string): string => host.getSubagent(id)?.executionId ?? id;
	const parentOf = (snapshot: SubagentSnapshot): string | undefined =>
		snapshot.executionId ? snapshot.parentExecutionId : snapshot.parentId;
	const getLang: () => ServerLang = lang ?? host.lang ?? (() => "en");
	const text = (t: string, details: unknown = {}): { content: { type: "text"; text: string }[]; details: unknown } => ({
		content: [{ type: "text", text: t }],
		details,
	});

	const deliveredConsults = new Set<string>();
	const consultKey = (parentId: string, runId: string, requestId: string) =>
		JSON.stringify([parentId, runId, requestId]);

	const expandDescendants = (roots: Set<string> | string[]): string[] => {
		if (roots instanceof Set ? roots.size === 0 : (roots as string[]).length === 0) return [];
		const rootSet = new Set([...roots].map(executionOfId));
		const all = host.listSubagents(undefined, selfIdOf());
		const out: string[] = [];
		for (const s of all) {
			if (rootSet.has(executionOf(s))) continue;
			let curParent = parentOf(s);
			const seen = new Set<string>();
			while (curParent) {
				if (rootSet.has(executionOfId(curParent))) {
					out.push(executionOf(s));
					break;
				}
				if (seen.has(curParent)) break;
				seen.add(curParent);
				const parent = host.getSubagent(curParent);
				curParent = parent ? parentOf(parent) : undefined;
			}
		}
		return out;
	};

	const isDescendantOf = (targetId: string, rootId: string): boolean => {
		const target = host.getSubagent(targetId);
		if (!target) return false;
		let curParent = parentOf(target);
		const seen = new Set<string>([targetId]);
		while (curParent) {
			if (executionOfId(curParent) === executionOfId(rootId)) return true;
			if (seen.has(curParent)) break;
			seen.add(curParent);
			const parent = host.getSubagent(curParent);
			curParent = parent ? parentOf(parent) : undefined;
		}
		return false;
	};

	const depthOf = (targetId: string): number => {
		let d = 0;
		let cur = host.getSubagent(targetId);
		const seen = new Set<string>([targetId]);
		while (cur && parentOf(cur)) {
			const parentId = parentOf(cur)!;
			if (seen.has(parentId)) break;
			seen.add(parentId);
			d++;
			cur = host.getSubagent(parentId);
			if (!cur) break;
		}
		return d;
	};

	const currentWaitCapMs =
		typeof host.getWatchdogTimeoutMs === "function"
			? computeWaitCapMs(host.getWatchdogTimeoutMs())
			: computeWaitCapMs();
	const capSeconds = Math.floor(currentWaitCapMs / 1000);

	return defineTool({
		name: CONVERSATION_TOOL_NAME,
		label: "Conversation collaboration",
		description:
			"Create and manage collaborative conversations, including temporary subagents and persistent sessions, for delegation, research, and execution. " +
			"Each action's arguments are documented on the parameters below.",
		promptSnippet: "Delegate tasks, inspect results, or request task completion.",
		promptGuidelines: [
			"Prefer communicate for messages and questions; consult/answer/escalate/handoff remain compatible.",
		],
		parameters: Type.Object({
			action: Type.Unsafe<SubagentAction>({
				type: "string",
				enum: [...SUBAGENT_ACTIONS],
				description: "The subagent action to perform.",
			}),
			questions: Type.Optional(
				Type.Array(
					Type.Object({
						id: Type.String({ minLength: 1 }),
						question: Type.String({ minLength: 1 }),
						detail: Type.Optional(Type.String()),
						header: Type.Optional(Type.String()),
						options: Type.Optional(
							Type.Array(
								Type.Object({
									label: Type.String(),
									description: Type.Optional(Type.String()),
									preview: Type.Optional(Type.String()),
									recommended: Type.Optional(Type.Boolean()),
								}),
							),
						),
						multiSelect: Type.Optional(Type.Boolean()),
						dependsOn: Type.Optional(
							Type.Object({
								questionId: Type.String(),
								value: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
							}),
						),
						optionsMap: Type.Optional(
							Type.Record(
								Type.String(),
								Type.Array(
									Type.Object({
										label: Type.String(),
										description: Type.Optional(Type.String()),
										preview: Type.Optional(Type.String()),
										recommended: Type.Optional(Type.Boolean()),
									}),
								),
							),
						),
					}),
					{ description: "consult: ask the parent for a decision.", minItems: 1, maxItems: 3 },
				),
			),
			requestId: Type.Optional(Type.String({ description: "answer/escalate: pending consult request ID." })),
			answers: Type.Optional(
				Type.Array(
					Type.Object({
						id: Type.String(),
						selected: Type.Array(Type.String()),
						custom: Type.Optional(Type.String()),
					}),
					{ description: "answer: responses to the child's consult.", minItems: 1 },
				),
			),
			prompt: Type.Optional(
				Type.String({
					description: "spawn: instructions (goal, constraints, expected output).",
				}),
			),
			runId: Type.Optional(
				Type.String({
					description: "get_result/steer/stop/dismiss/answer/escalate: target conversation ID.",
				}),
			),
			runIds: Type.Optional(
				Type.Array(Type.String(), {
					description: "wait_all/dismiss: conversation IDs to wait for or dismiss.",
				}),
			),
			message: Type.Optional(
				Type.String({
					description: "steer: follow-up instruction; complete: completion summary alias.",
				}),
			),
			summary: Type.Optional(Type.String({ description: "complete: final task summary." })),
			payload: Type.Optional(
				Type.String({
					description: "handoff: what to transfer to the peer.",
				}),
			),
			toRunId: Type.Optional(
				Type.String({
					description: "handoff: target peer ID.",
				}),
			),
			fromRunId: Type.Optional(
				Type.String({
					description: "handoff: optional source ID; must match the calling conversation.",
				}),
			),
			type: Type.Optional(
				Type.String({
					description:
						"spawn: role/type (e.g. explore/implement/review, default: general). When matching a template name, the template and its security profile (e.g. readonly for explore, verify for review) are automatically applied.",
				}),
			),
			template: Type.Optional(
				Type.String({
					description: "spawn: template name (see action=templates).",
				}),
			),
			model: Type.Optional(
				Type.String({
					description: 'spawn: model override "provider/id".',
				}),
			),
			thinking: Type.Optional(
				Type.String({
					enum: [...THINKING_LEVELS],
					description:
						'spawn: thinking budget level ("off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max").',
				}),
			),
			notifyOnDone: Type.Optional(
				Type.Union([Type.Boolean(), Type.Literal("manual")], {
					description:
						"spawn: true wakes parent per turn, false disables wakes, manual waits for task completion (default: true).",
				}),
			),
			cwd: Type.Optional(
				Type.String({
					description: "spawn: working directory (default = current).",
				}),
			),
			persist: Type.Optional(
				Type.Boolean({
					description: "spawn: persist as a regular session (default = ephemeral).",
				}),
			),
			isolation: Type.Optional(
				Type.String({
					enum: ["worktree", "none"],
					description:
						'spawn: workspace isolation mode ("worktree" creates a dedicated git worktree & branch; "none" = shared cwd).',
				}),
			),
			kind: Type.Optional(
				Type.String({
					enum: ["all", "subagent", "persistent"],
					description: "list: filter subagents by kind (default: all).",
				}),
			),
			timeoutSeconds: Type.Optional(
				Type.Integer({
					description: `wait_all: max wait in seconds (default: ${capSeconds}s); returns early for new parent consults.`,
					minimum: 1,
					maximum: capSeconds,
				}),
			),
			scope: Type.Optional(
				Type.String({
					enum: ["finished_all"],
					description: 'dismiss: batch dismissal scope ("finished_all" to dismiss all finished descendant subagents).',
				}),
			),
			force: Type.Optional(
				Type.Boolean({
					description: "dismiss: force abort running subagents before dismissing (default: false).",
				}),
			),
			includePersisted: Type.Optional(
				Type.Boolean({
					description: "dismiss: allow dismissing persisted subagents (default: false).",
				}),
			),
		}),
		execute: async (_id, p, signal, _onUpdate, ctx) => {
			const action = (p.action ?? "").trim().toLowerCase();
			if (!action) {
				return text(
					pick(
						getLang(),
						`subagent 工具缺少 action 参数（可选：${SUBAGENT_ACTIONS.join(", ")}）。`,
						`subagent tool requires an action parameter (one of: ${SUBAGENT_ACTIONS.join(", ")}).`,
						"subagents.action.missing",
					),
				);
			}

			switch (action) {
				case "complete": {
					signal?.throwIfAborted();
					const selfId = selfIdOf();
					if (!selfId || !host.completeSubagent) throw new Error("Task completion is unavailable.");
					const summary = (p.summary ?? p.message ?? "").trim();
					if (!summary) throw new Error("complete requires a nonempty summary or message.");
					const result = await host.completeSubagent(selfId, summary);
					if (result && typeof result === "object" && "ok" in result && result.ok === false) {
						throw new Error(String("error" in result ? result.error : "Completion request rejected."));
					}
					return text("Completion intent recorded; settlement waits for idle state and pending dependencies.", {
						status: "completion_requested",
						runId: selfId,
					});
				}
				case "consult": {
					signal?.throwIfAborted();
					const selfId = selfIdOf();
					if (!selfId || !host.consultParent) throw new Error("Parent consultation is unavailable.");
					if (
						!Array.isArray(p.questions) ||
						p.questions.length < 1 ||
						p.questions.length > 3 ||
						p.questions.some(
							(q) =>
								!q || typeof q.id !== "string" || !q.id.trim() || typeof q.question !== "string" || !q.question.trim(),
						) ||
						new Set(p.questions.map((q) => q.id)).size !== p.questions.length
					) {
						throw new Error("consult requires 1-3 questions with unique IDs and nonempty text.");
					}
					const result = await host.consultParent(selfId, p.questions, signal);
					signal?.throwIfAborted();
					return text(
						`${JSON.stringify(result) ?? "Consult resolved."}\nIf timed_out, do not choose on the parent's behalf. Ask again with only the context needed for the decision.`,
						result,
					);
				}
				case "answer":
				case "escalate": {
					signal?.throwIfAborted();
					const selfId = selfIdOf();
					if (!selfId || !p.runId?.trim() || !p.requestId?.trim()) {
						throw new Error(`${action} requires caller identity, runId and requestId.`);
					}
					let result: unknown;
					if (action === "answer") {
						if (!host.answerConsult) throw new Error("Consult answers are unavailable.");
						if (
							!Array.isArray(p.answers) ||
							p.answers.length === 0 ||
							p.answers.some(
								(a) =>
									!a ||
									typeof a.id !== "string" ||
									!a.id.trim() ||
									!Array.isArray(a.selected) ||
									a.selected.some((s) => typeof s !== "string") ||
									(a.custom !== undefined && typeof a.custom !== "string"),
							)
						) {
							throw new Error("answer requires structured answers.");
						}
						result = await host.answerConsult(selfId, p.runId, p.requestId, p.answers);
					} else {
						if (!host.escalateConsult) throw new Error("Consult escalation is unavailable.");
						result = await host.escalateConsult(selfId, p.runId, p.requestId);
					}
					if (result && typeof result === "object" && "ok" in result && result.ok === false) {
						throw new Error("error" in result ? String(result.error) : `Consult ${action} rejected.`);
					}
					return text(JSON.stringify(result) ?? `Consult ${action} submitted.`, result);
				}
				case "spawn": {
					if (!p.prompt || typeof p.prompt !== "string" || !p.prompt.trim()) {
						return text(
							pick(
								getLang(),
								'subagent(action="spawn") 缺少 prompt 参数。',
								'subagent(action="spawn") requires prompt parameter.',
								"subagents.spawn.missing.prompt",
							),
						);
					}
					let templateName: string | undefined;
					if (p.template) {
						if (!host.isTemplateUsable(p.template)) {
							return text(
								pick(
									getLang(),
									`子代理模板不可用：${p.template}（不存在或已停用）。用 subagent(action="templates") 查看当前可用模板清单；不传 template 则按默认配置运行。`,
									`Subagent template unavailable: ${p.template} (missing or disabled). Use subagent(action="templates") to list available templates; omit template to run with defaults.`,
									"subagents.spawn.template.unavailable",
									{ "p.template": p.template },
								),
							);
						}
						templateName = p.template.trim();
					} else if (p.type && typeof p.type === "string" && host.isTemplateUsable(p.type.trim())) {
						templateName = p.type.trim();
					}
					if (p.thinking && !THINKING_LEVELS.includes(p.thinking as (typeof THINKING_LEVELS)[number])) {
						return text(
							pick(
								getLang(),
								`非法思考强度：${p.thinking}。可选档位：${THINKING_LEVELS.join(", ")}。`,
								`Invalid thinking level: ${p.thinking}. Allowed levels: ${THINKING_LEVELS.join(", ")}.`,
								"subagents.spawn.thinking.invalid",
								{ thinking: p.thinking, levels: THINKING_LEVELS.join(", ") },
							),
						);
					}
					const isolationMode = p.isolation?.trim().toLowerCase();
					if (isolationMode && isolationMode !== "worktree" && isolationMode !== "none") {
						return text(
							pick(
								getLang(),
								`不支持的隔离模式：${p.isolation}。可选模式："worktree"（基于 Git 工作树物理隔离）或 "none"（默认共享工作区）。`,
								`Unsupported isolation mode: ${p.isolation}. Supported modes: "worktree" (git worktree isolation) or "none" (shared workspace).`,
								"subagents.spawn.isolation.invalid",
								{ isolation: p.isolation },
							),
						);
					}
					let convId: string;
					const subagentType = p.type ?? "general";
					const matchedTemplate = templateName ? host.listTemplates().find((t) => t.name === templateName) : undefined;
					const securityMode = resolveSecurityMode(subagentType, matchedTemplate);
					const extra: SubagentSpawnExtra | undefined = securityMode !== "normal" ? { securityMode } : undefined;

					try {
						const spawnArgs: [
							string,
							string,
							string,
							string?,
							string?,
							string?,
							boolean?,
							string?,
							(boolean | "manual")?,
							string?,
							SubagentSpawnExtra?,
							AbortSignal?,
						] = [
							p.prompt,
							subagentType,
							p.cwd ?? ctx.cwd,
							templateName,
							p.model,
							undefined,
							p.persist,
							p.thinking,
							p.notifyOnDone,
						];
						if (isolationMode === "worktree" || extra !== undefined || signal !== undefined) {
							spawnArgs.push(isolationMode === "worktree" ? "worktree" : undefined);
						}
						if (extra !== undefined || signal !== undefined) {
							spawnArgs.push(extra);
						}
						if (signal !== undefined) spawnArgs.push(signal);
						signal?.throwIfAborted();
						convId = await host.spawnSubagent(...spawnArgs);
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						return text(
							pick(getLang(), `子代理启动失败：${msg}`, `Failed to start subagent: ${msg}`, "subagents.spawn.failed", {
								error: msg,
							}),
						);
					}
					const executionId = host.getSubagent(convId)?.executionId;
					const addressLine = executionId ? `\nrunId: ${executionId}` : "";
					const subagentTitleText = subagentTitle(p.prompt);
					const templateLineZh = templateName ? `\n模板：${templateName}` : "";
					const templateLineEn = templateName ? `\nTemplate: ${templateName}` : "";
					const modelLineZh = p.model ? `\n模型：${p.model}` : "";
					const modelLineEn = p.model ? `\nModel: ${p.model}` : "";
					const thinkingLineZh = p.thinking ? `\n思考强度：${p.thinking}` : "";
					const thinkingLineEn = p.thinking ? `\nThinking: ${p.thinking}` : "";
					const notifyLineZh = p.notifyOnDone === false ? "\n自动通知：已关闭" : "";
					const notifyLineEn = p.notifyOnDone === false ? "\nAuto-notify: disabled" : "";
					const isolationLineZh = isolationMode === "worktree" ? "\n工作树隔离：已启用（独立 Git 工作树与分支）" : "";
					const isolationLineEn =
						isolationMode === "worktree" ? "\nWorktree isolation: enabled (dedicated Git worktree & branch)" : "";
					const kindLabelZh = p.persist ? "普通持久化对话" : "子代理";
					const kindLabelEn = p.persist ? "Persistent conversation" : "Subagent";
					return text(
						pick(
							getLang(),
							`${kindLabelZh}已启动（运行列表可见）：${convId}\n类型：${subagentType} · 标题：${subagentTitleText}${templateLineZh}${modelLineZh}${thinkingLineZh}${notifyLineZh}${isolationLineZh}${addressLine}` +
								`\n用 subagent(action="wait_all") 一次等全部完成（不用轮询），subagent(action="get_result") 取单个结果，subagent(action="list") 看运行态，subagent(action="steer") 改向，subagent(action="stop") 停止。`,
							`${kindLabelEn} started (visible in the running list): ${convId}\nType: ${subagentType} · Title: ${subagentTitleText}${templateLineEn}${modelLineEn}${thinkingLineEn}${notifyLineEn}${isolationLineEn}${addressLine}` +
								`\nUse subagent(action="wait_all") to wait for all at once (no polling), subagent(action="get_result") for a single result, subagent(action="list") for live status, subagent(action="steer") to redirect, subagent(action="stop") to stop.`,
							"subagents.spawn.started",
							{
								convId,
								subagentType,
								subagentTitleText,
								"p.template": p.template,
								"p.model": p.model,
								"p.thinking": p.thinking,
								templateLineZh,
								templateLineEn,
								modelLineZh,
								modelLineEn,
								thinkingLineZh,
								thinkingLineEn,
								notifyLineZh,
								notifyLineEn,
								isolationLineZh,
								isolationLineEn,
								kindLabel: kindLabelEn,
								kindLabelEn,
								kindLabelZh,
								addressLine,
							},
						),
						{
							convId,
							executionId,
							template: p.template,
							model: p.model,
							thinking: p.thinking,
							persisted: !!p.persist,
							notifyOnDone: p.notifyOnDone ?? true,
							isolation: isolationMode === "worktree" ? "worktree" : undefined,
						},
					);
				}

				case "get_result": {
					if (!p.runId || typeof p.runId !== "string" || !p.runId.trim()) {
						return text(
							pick(
								getLang(),
								'subagent(action="get_result") 缺少 runId 参数。',
								'subagent(action="get_result") requires runId parameter.',
								"subagents.get.missing.runId",
							),
						);
					}
					let r = host.getSubagent(p.runId);
					const missingId = shortId(p.runId);
					if (!r)
						return text(
							pick(
								getLang(),
								`未找到子代理 ${missingId}（可能已移出）。`,
								`Subagent ${missingId} not found (may have been dismissed).`,
								"subagents.get.not.found",
								{ missingId },
							),
							undefined,
						);
					const verdict = subagentVerdict(r, getLang());
					const doneId = shortId(r.convId);
					const doneDetail = verdictText(r, getLang());
					const doneOutput = r.output || (getLang() === "zh" ? "（无结果）" : "(no result)");
					const modelTag = r.model ? ` · ${r.model}${r.thinkingLevel ? `:${r.thinkingLevel}` : ""}` : "";
					if (!isSubagentTerminal(r)) {
						const runningId = shortId(r.convId);
						const runningOutput = r.output || (getLang() === "zh" ? "（暂无输出）" : "(no output yet)");
						return text(
							pick(
								getLang(),
								`子代理 ${runningId}（${r.type}${modelTag}）仍在运行（状态 ${r.state}）。\n当前输出：\n${runningOutput}`,
								`Subagent ${runningId} (${r.type}${modelTag}) is still running (state ${r.state}).\nCurrent output:\n${runningOutput}`,
								"subagents.get.running",
								{ runningId, "r.type": r.type, modelTag, "r.state": r.state, runningOutput },
							),
							r,
						);
					}
					const targetAddress = executionOf(r);
					host.markSubagentsConsumed?.([targetAddress]);
					if (host.finalizeSubagentWorktree) {
						await host.finalizeSubagentWorktree(targetAddress);
						r = host.getSubagent(targetAddress) ?? r;
					}
					let worktreeDetail = "";
					if (r.worktree) {
						const wt = r.worktree;
						if (wt.cleanedUp) {
							worktreeDetail = pick(
								getLang(),
								"\n\n[工作树隔离] 无文件修改，临时工作树与分支已自动清理。",
								"\n\n[Worktree isolation] No changes made; temporary worktree and branch have been cleaned up automatically.",
								"subagents.get.worktree.cleaned",
							);
						} else {
							worktreeDetail = pick(
								getLang(),
								`\n\n[工作树隔离] 代码改动已保留供审阅：\n- 路径：${wt.path}\n- 分支：${wt.branch}\n- 改动：${wt.uncommittedCount ?? 0} 个未提交文件修改，领先 ${wt.aheadCount ?? 0} 个提交\n（提示：可执行 git merge ${wt.branch} 合并，或调用 worktree(action="remove", path="${wt.path}", force=true) 放弃）`,
								`\n\n[Worktree isolation] Changes preserved for review:\n- Path: ${wt.path}\n- Branch: ${wt.branch}\n- Changes: ${wt.uncommittedCount ?? 0} uncommitted file(s), ${wt.aheadCount ?? 0} commit(s) ahead\n(Note: run git merge ${wt.branch} to merge, or worktree(action="remove", path="${wt.path}", force=true) to discard)`,
								"subagents.get.worktree.preserved",
								{ path: wt.path, branch: wt.branch, uncommitted: wt.uncommittedCount ?? 0, ahead: wt.aheadCount ?? 0 },
							);
						}
					}
					return text(
						pick(
							getLang(),
							`子代理 ${doneId}（${r.type}${modelTag}）状态：${verdict}\n${doneDetail}\n${doneOutput}${worktreeDetail}`,
							`Subagent ${doneId} (${r.type}${modelTag}) status: ${verdict}\n${doneDetail}\n${doneOutput}${worktreeDetail}`,
							"subagents.get.done",
							{ doneId, "r.type": r.type, modelTag, verdict, doneDetail, doneOutput: `${doneOutput}${worktreeDetail}` },
						),
						r,
					);
				}

				case "steer": {
					if (!p.runId || typeof p.runId !== "string" || !p.runId.trim()) {
						return text(
							pick(
								getLang(),
								'subagent(action="steer") 缺少 runId 参数。',
								'subagent(action="steer") requires runId parameter.',
								"subagents.steer.missing.runId",
							),
						);
					}
					if (typeof p.message !== "string" || !p.message.trim()) {
						return text(
							pick(
								getLang(),
								'subagent(action="steer") 缺少 message 参数。',
								'subagent(action="steer") requires message parameter.',
								"subagents.steer.missing.message",
							),
						);
					}
					if (!host.getSubagent(p.runId)) {
						const missingSteerId = shortId(p.runId);
						return text(
							pick(
								getLang(),
								`未找到子代理 ${missingSteerId}（可能已移出），消息未注入。请用 subagent(action="list") 确认仍在运行的子代理。`,
								`Subagent ${missingSteerId} not found (may have been dismissed); message not injected. Use subagent(action="list") to confirm running subagents.`,
								"subagents.steer.not.found",
								{ missingSteerId },
							),
						);
					}
					await host.steerSubagent(executionOfId(p.runId), p.message);
					const steerId = shortId(p.runId);
					return text(
						pick(
							getLang(),
							`已向子代理 ${steerId} 注入消息。`,
							`Message injected into subagent ${steerId}.`,
							"subagents.steer.injected",
							{ steerId },
						),
					);
				}

				case "list": {
					const list = host.listSubagents(p.kind as "all" | "subagent" | "persistent" | undefined, selfIdOf());
					if (list.length === 0)
						return text(
							pick(
								getLang(),
								"当前没有运行中的对话/子代理。",
								"No managed conversations or subagents running.",
								"subagents.list.empty",
							),
						);
					const tLang = getLang();
					const lines = list.map((r) => {
						const tag = r.persisted
							? tLang === "zh"
								? "持久化"
								: "persistent"
							: tLang === "zh"
								? "子代理"
								: "subagent";
						const modelTag = r.model ? ` · ${r.model}${r.thinkingLevel ? `:${r.thinkingLevel}` : ""}` : "";
						return (
							`- ${r.convId}${r.executionId ? ` (runId: ${r.executionId})` : ""} · ${r.type}${modelTag} · ${subagentVerdict(r, tLang)} · ${r.title}` +
							(tLang === "zh" ? `（${tag} · msg: ${r.messageCount}）` : ` (${tag} · msg: ${r.messageCount})`)
						);
					});
					return text(lines.join("\n"));
				}

				case "stop": {
					if (!p.runId || typeof p.runId !== "string" || !p.runId.trim()) {
						return text(
							pick(
								getLang(),
								'subagent(action="stop") 缺少 runId 参数。',
								'subagent(action="stop") requires runId parameter.',
								"subagents.stop.missing.runId",
							),
						);
					}
					if (!host.getSubagent(p.runId)) {
						const missingStopId = shortId(p.runId);
						return text(
							pick(
								getLang(),
								`未找到子代理 ${missingStopId}（可能已移出或已结束），无需停止。请用 subagent(action="list") 确认仍在运行的子代理。`,
								`Subagent ${missingStopId} not found (may have been dismissed or already finished); nothing to stop. Use subagent(action="list") to confirm running subagents.`,
								"subagents.stop.not.found",
								{ missingStopId },
							),
						);
					}
					await host.stopSubagent(p.runId);
					const stopId = shortId(p.runId);
					return text(
						pick(
							getLang(),
							`已请求停止子代理 ${stopId}。`,
							`Stop requested for subagent ${stopId}.`,
							"subagents.stop.requested",
							{ stopId },
						),
					);
				}

				case "wait_all": {
					const selfAddress = selfIdOf();
					const selfId = selfAddress ? executionOfId(selfAddress) : undefined;
					const ancestorIdsOf = (selfId: string): Set<string> => {
						const out = new Set<string>();
						const seen = new Set<string>([selfId]);
						const snapshot = host.getSubagent(selfAddress ?? selfId);
						let cur = snapshot ? parentOf(snapshot) : undefined;
						while (cur && !seen.has(cur)) {
							seen.add(cur);
							out.add(executionOfId(cur));
							const parent = host.getSubagent(cur);
							cur = parent ? parentOf(parent) : undefined;
						}
						return out;
					};

					const explicit = p.runIds && p.runIds.length > 0;
					const wanted = new Set<string>();
					const selfAncestorIds = selfId ? ancestorIdsOf(selfId) : new Set<string>();

					if (explicit) {
						const seedRoots: string[] = [];
						for (const requestedId of p.runIds!) {
							const id = executionOfId(requestedId);
							if (selfId && id === selfId) continue;
							if (selfAncestorIds.has(id)) continue;
							wanted.add(id);
							seedRoots.push(id);
						}
						for (const descId of expandDescendants(seedRoots)) {
							if (selfId && descId === selfId) continue;
							if (selfAncestorIds.has(descId)) continue;
							wanted.add(descId);
						}
					} else if (selfId) {
						for (const descId of expandDescendants(new Set([selfId]))) {
							if (descId === selfId) continue;
							if (selfAncestorIds.has(descId)) continue;
							wanted.add(descId);
						}
					} else {
						for (const r of host.listSubagents()) {
							wanted.add(executionOf(r));
						}
					}
					if (selfId) wanted.delete(selfId);
					for (const ancId of selfAncestorIds) wanted.delete(ancId);

					const collectConsults = () => {
						const parentId = selfIdOf();
						if (!parentId || !host.getPendingConsults || signal?.aborted) return;
						const pending = host.getPendingConsults(parentId);
						const liveKeys = new Set(pending.map((r) => consultKey(parentId, r.runId, r.requestId)));
						for (const key of deliveredConsults) {
							if (!liveKeys.has(key)) deliveredConsults.delete(key);
						}
						const requests = pending.filter(
							(r) =>
								!deliveredConsults.has(consultKey(parentId, r.runId, r.requestId)) &&
								!host.isRequestSteering?.(parentId, r.requestId),
						);
						if (requests.length === 0) return;
						for (const r of requests) deliveredConsults.add(consultKey(parentId, r.runId, r.requestId));
						const result = { status: "needs_input", requests };
						return text(
							`Child consults need your decision. Use answer or escalate before waiting again.\n${JSON.stringify(result)}`,
							result,
						);
					};

					if (wanted.size === 0) {
						const consults = collectConsults();
						if (consults) return consults;
						return text(
							pick(
								getLang(),
								"没有需要等待的子代理（调用者自身与其祖先永不计入等待；子代理无参数调用时只等待属于它自己的后代）。",
								"No subagents to wait for (the calling session itself and its ancestors are never waited on; a subagent without runIds only waits for its own descendants).",
								"subagents.wait.empty",
							),
						);
					}

					const liveWaitCapMs =
						typeof host.getWatchdogTimeoutMs === "function"
							? computeWaitCapMs(host.getWatchdogTimeoutMs())
							: currentWaitCapMs;
					const liveCapSeconds = Math.floor(liveWaitCapMs / 1000);
					const timeoutMs = Math.min(Math.max(p.timeoutSeconds ?? liveCapSeconds, 1), liveCapSeconds) * 1000;
					const startedAt = Date.now();
					const POLL_INTERVAL_MS = 250;

					try {
						const waitingParentId = selfIdOf();
						if (waitingParentId) host.setConsultWaiting?.(waitingParentId, true);
						while (!signal?.aborted && Date.now() - startedAt < timeoutMs) {
							for (const descId of expandDescendants(wanted)) {
								if (selfId && descId === selfId) continue;
								if (selfAncestorIds.has(descId)) continue;
								wanted.add(descId);
							}
							const consults = collectConsults();
							if (consults) return consults;
							const allDone = Array.from(wanted).every((id) => {
								const r = host.getSubagent(id);
								return r === undefined || isSubagentTerminal(r);
							});
							if (allDone) break;
							await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
						}
					} finally {
						const waitingParentId = selfIdOf();
						if (waitingParentId) host.setConsultWaiting?.(waitingParentId, false);
					}

					const tLang = getLang();
					const waitedSecs = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
					const timeoutSecs = Math.round(timeoutMs / 1000);

					const finishedIds = Array.from(wanted).filter((id) => {
						const r = host.getSubagent(id);
						return r === undefined || isSubagentTerminal(r);
					});
					if (finishedIds.length > 0) {
						host.markSubagentsConsumed?.(finishedIds);
						if (host.finalizeSubagentWorktree) {
							await Promise.all(finishedIds.map((id) => host.finalizeSubagentWorktree!(id)));
						}
					}

					const lines = Array.from(wanted)
						.map((id) => {
							const r = host.getSubagent(id);
							const sId = shortId(id);
							if (!r) {
								return pick(
									tLang,
									`- ${sId}：已移出或不存在`,
									`- ${sId}: dismissed or not found`,
									"subagents.wait.item.missing",
									{ sId },
								);
							}
							const verdict = subagentVerdict(r, tLang);
							const detail = verdictText(r, tLang);
							const out = clipSubagentOutput(r.output || (tLang === "zh" ? "（无输出）" : "(no output)"), tLang);
							let wtTag = "";
							let wtPathInfo = "";
							if (r.worktree) {
								if (r.worktree.cleanedUp) {
									wtTag = tLang === "zh" ? " · 工作树已清理" : " · worktree cleaned";
								} else {
									wtTag =
										tLang === "zh"
											? ` · 工作树保留: ${r.worktree.branch} (${r.worktree.uncommittedCount ?? 0} 改动, +${r.worktree.aheadCount ?? 0} 提交)`
											: ` · worktree kept: ${r.worktree.branch} (${r.worktree.uncommittedCount ?? 0} dirty, +${r.worktree.aheadCount ?? 0} commits)`;
									wtPathInfo =
										tLang === "zh" ? `\n  - 工作树路径：${r.worktree.path}` : `\n  - Worktree path: ${r.worktree.path}`;
								}
							}
							return `- ${sId}（${r.type} · ${verdict} · ${r.title}${wtTag}）${detail ? ` · ${detail}` : ""}:\n${out}${wtPathInfo}`;
						})
						.join("\n\n");

					const remaining = Array.from(wanted).filter((id) => {
						const r = host.getSubagent(id);
						return !isSubagentTerminal(r);
					});

					const head =
						remaining.length === 0
							? pick(
									tLang,
									`全部 ${wanted.size} 个子代理已收口：`,
									`All ${wanted.size} subagent(s) collected:`,
									"subagents.wait.collected",
									{ "wanted.size": wanted.size },
								)
							: signal?.aborted
								? pick(
										tLang,
										`本轮被中止，${remaining.length} 个仍在运行：`,
										`This round was aborted, ${remaining.length} still running:`,
										"subagents.wait.aborted",
										{ "remaining.length": remaining.length },
									)
								: pick(
										tLang,
										`等待超过 ${timeoutSecs}s 超时（实际等待 ${waitedSecs}s），${remaining.length} 个仍在运行：`,
										`Wait timed out after ${timeoutSecs}s (actually waited ${waitedSecs}s), ${remaining.length} still running:`,
										"subagents.wait.timeout",
										{ timeoutSecs, waitedSecs, "remaining.length": remaining.length },
									);
					return text(`${head}\n${lines}\n` + promptRemaining(remaining, tLang));
				}

				case "templates": {
					const list = host.listTemplates();
					const tLang = getLang();
					if (list.length === 0) {
						return text(
							pick(
								tLang,
								"当前没有可用的子代理模板（设置面板 → 子代理模板 添加后可用）。子代理默认按主会话配置运行。",
								"No subagent templates available (add some under Settings → Subagent Templates). Subagents run with the main session defaults.",
								"subagents.templates.empty",
							),
						);
					}
					const lines = list.map((t) => {
						const desc = tLang === "zh" ? t.description : t.descriptionEn || t.description;
						const modelPart =
							tLang === "zh"
								? t.model
									? `模型：${t.model}`
									: "跟随主对话模型"
								: t.model
									? `model: ${t.model}`
									: "follows the main conversation model";
						const thinkingPart =
							tLang === "zh"
								? t.thinkingLevel
									? `思考强度：${t.thinkingLevel}`
									: "跟随主对话思考强度"
								: t.thinkingLevel
									? `thinking: ${t.thinkingLevel}`
									: "follows the main conversation thinking level";
						return (
							(tLang === "zh" ? `- ${t.name}${desc ? `：${desc}` : ""}` : `- ${t.name}${desc ? `: ${desc}` : ""}`) +
							(tLang === "zh" ? `（${modelPart}，${thinkingPart}）` : ` (${modelPart}, ${thinkingPart})`)
						);
					});
					const firstTemplateName = list[0]?.name;
					const templateLines = lines.join("\n");
					return text(
						pick(
							getLang(),
							`可用的子代理模板（subagent 的 template 参数传名字，如 subagent(action="spawn", template="${firstTemplateName}"))：\n${templateLines}`,
							`Available subagent templates (pass the name as subagent's template param, e.g. subagent(action="spawn", template="${firstTemplateName}")):\n${templateLines}`,
							"subagents.templates.list",
							{ firstTemplateName, templateLines },
						),
					);
				}

				case "handoff": {
					signal?.throwIfAborted();
					const fromId = selfIdOf();
					if (!fromId) throw new Error("Handoff requires a verified conversation identity.");
					if (p.fromRunId && p.fromRunId !== fromId) {
						throw new Error("Handoff source must match the calling conversation.");
					}
					if (!p.toRunId || typeof p.toRunId !== "string" || !p.toRunId.trim()) {
						return text(
							pick(
								getLang(),
								'subagent(action="handoff") 缺少 toRunId 参数。',
								'subagent(action="handoff") requires toRunId parameter.',
								"subagents.handoff.missing.toRunId",
							),
						);
					}
					if (typeof p.payload !== "string" || !p.payload.trim()) {
						return text(
							pick(
								getLang(),
								'subagent(action="handoff") 缺少 payload 参数。',
								'subagent(action="handoff") requires payload parameter.',
								"subagents.handoff.missing.payload",
							),
						);
					}
					if (fromId === p.toRunId) {
						return text(
							pick(
								getLang(),
								`交接失败：不能交接给自身（${shortId(fromId)}）。请指定其他同行子代理。`,
								`Handoff failed: cannot hand off to oneself (${shortId(fromId)}). Please specify a different peer subagent.`,
								"subagents.handoff.self",
								{ id: shortId(fromId) },
							),
						);
					}
					const target = host.getSubagent(p.toRunId);
					if (!target) {
						const missingId = shortId(p.toRunId);
						return text(
							pick(
								getLang(),
								`未找到目标子代理 ${missingId}（可能已移出或不存在）。请用 subagent(action="list") 确认可用的子代理。`,
								`Target subagent ${missingId} not found (may have been dismissed or non-existent). Use subagent(action="list") to check available subagents.`,
								"subagents.handoff.not.found",
								{ missingId },
							),
						);
					}

					try {
						await host.handoffSubagent(fromId, executionOf(target), p.payload);
						const fromShort = shortId(fromId);
						const toShort = shortId(p.toRunId);
						return text(
							pick(
								getLang(),
								`已成功将产物交接给同行子代理 ${toShort}（${target.type}），协同路由已建立并开始执行。`,
								`Successfully handed off payload to peer subagent ${toShort} (${target.type}); peer routing established and executing.`,
								"subagents.handoff.success",
								{ from: fromShort, to: toShort, type: target.type },
							),
							{ fromRunId: fromId, toRunId: p.toRunId, timestamp: Date.now() },
						);
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						return text(
							pick(getLang(), `交接失败：${msg}`, `Handoff failed: ${msg}`, "subagents.handoff.failed", { error: msg }),
						);
					}
				}

				case "dismiss": {
					if (!host.dismissSubagent) {
						return text(
							pick(
								getLang(),
								"当前引擎不支持子代理移出能力。",
								"Subagent dismissal is not supported by the current engine.",
								"subagents.dismiss.unsupported",
							),
						);
					}

					const explicitIds: string[] = [];
					if (Array.isArray(p.runIds) && p.runIds.length > 0) {
						for (const id of p.runIds) {
							if (typeof id === "string" && id.trim()) {
								explicitIds.push(id.trim());
							}
						}
					} else if (p.runId && typeof p.runId === "string" && p.runId.trim()) {
						explicitIds.push(p.runId.trim());
					}

					const isFinishedAll = p.scope === "finished_all";

					if (explicitIds.length === 0 && !isFinishedAll) {
						return text(
							pick(
								getLang(),
								'subagent(action="dismiss") 缺少目标参数：请指定 runId、runIds 或 scope="finished_all"。',
								'subagent(action="dismiss") requires target parameter: specify runId, runIds, or scope="finished_all".',
								"subagents.dismiss.missing.target",
							),
						);
					}

					const selfId = selfIdOf();
					const activeConvId = host.getActiveConversationId?.();

					let candidateIds: string[] = [];
					if (isFinishedAll) {
						const all = host.listSubagents(undefined, selfId);
						let inScopeList = all;
						if (selfId) {
							const descIds = new Set(expandDescendants(new Set([selfId])));
							inScopeList = all.filter((s) => descIds.has(executionOf(s)));
						}
						candidateIds = inScopeList
							.filter((s) => {
								if (s.streaming || s.state === "running") return false;
								if (selfId && executionOf(s) === executionOfId(selfId)) return false;
								if (activeConvId && executionOf(s) === executionOfId(activeConvId)) return false;
								if (s.persisted && !p.includePersisted) return false;
								return true;
							})
							.map(executionOf);

						if (candidateIds.length === 0) {
							return text(
								pick(
									getLang(),
									"没有可移出的已结束子代理。",
									"No finished subagents to dismiss.",
									"subagents.dismiss.finished_all.empty",
								),
								{ dismissed: [], skipped: [] },
							);
						}
					} else {
						candidateIds = [...new Set(explicitIds.map(executionOfId))];
					}

					const isSingleExplicit = !isFinishedAll && explicitIds.length === 1;
					if (isSingleExplicit) {
						const targetId = candidateIds[0];
						const snapshot = host.getSubagent(targetId);
						if (!snapshot) {
							const missingId = shortId(targetId);
							return text(
								pick(
									getLang(),
									`未找到子代理 ${missingId}（可能已移出或不存在）。`,
									`Subagent ${missingId} not found (may have been dismissed or non-existent).`,
									"subagents.dismiss.not_found",
									{ missingId },
								),
							);
						}
						if (selfId && executionOfId(targetId) === executionOfId(selfId)) {
							return text(
								pick(
									getLang(),
									"拒绝移出：不能移出当前会话自身。",
									"Refused: cannot dismiss the current conversation itself.",
									"subagents.dismiss.self",
								),
							);
						}
						if (activeConvId && executionOfId(targetId) === executionOfId(activeConvId)) {
							const activeId = shortId(targetId);
							return text(
								pick(
									getLang(),
									`子代理 ${activeId} 正在前端处于活动打开状态，无法直接移出。`,
									`Subagent ${activeId} is currently active in the UI and cannot be dismissed.`,
									"subagents.dismiss.active",
									{ activeId },
								),
							);
						}
						if (selfId && !isDescendantOf(targetId, selfId)) {
							const notDescId = shortId(targetId);
							return text(
								pick(
									getLang(),
									`拒绝移出：子代理 ${notDescId} 不属于当前会话的派发族谱（仅允许移出由当前会话派发的子代理）。`,
									`Refused: subagent ${notDescId} does not belong to the descendant hierarchy of this conversation (can only dismiss subagents spawned by this conversation).`,
									"subagents.dismiss.not_descendant",
									{ notDescId },
								),
							);
						}
						if (snapshot.persisted && !p.includePersisted) {
							const persistedId = shortId(targetId);
							return text(
								pick(
									getLang(),
									`子代理 ${persistedId} 为持久化会话（已落盘历史）。如确认需要移出，请传入 includePersisted=true。`,
									`Subagent ${persistedId} is a persistent session. If you are sure you want to dismiss it, pass includePersisted=true.`,
									"subagents.dismiss.persisted",
									{ persistedId },
								),
							);
						}
						const isRunning = snapshot.streaming || snapshot.state === "running";
						if (isRunning && !p.force) {
							const runningId = shortId(targetId);
							return text(
								pick(
									getLang(),
									`子代理 ${runningId} 仍在运行中（状态：${snapshot.state}）。请等待其完成、调用 subagent(action="stop")，或指定 force=true 强行中止并移出。`,
									`Subagent ${runningId} is still running (state: ${snapshot.state}). Wait for it to finish, call subagent(action="stop"), or specify force=true to force abort and dismiss.`,
									"subagents.dismiss.running",
									{ runningId, state: snapshot.state },
								),
							);
						}
						if (host.finalizeSubagentWorktree) {
							await host.finalizeSubagentWorktree(targetId);
						}
						const updated = host.getSubagent(targetId) ?? snapshot;
						if (updated.worktree && !updated.worktree.cleanedUp) {
							const wt = updated.worktree;
							const isDirty = Boolean(wt.isDirty || (wt.uncommittedCount ?? 0) > 0 || (wt.aheadCount ?? 0) > 0);
							if (isDirty) {
								const dirtyId = shortId(targetId);
								return text(
									pick(
										getLang(),
										`子代理 ${dirtyId} 的工作树存在未合并改动，无法移出（静默移出会丢失代码）：\n- 路径：${wt.path}\n- 分支：${wt.branch}\n- 未提交改动：${wt.uncommittedCount ?? 0} 个文件，领先提交：${wt.aheadCount ?? 0} 个\n请先合并分支（git merge ${wt.branch}）或确认放弃后通过 worktree(action="remove", path="${wt.path}", force=true) 清理。`,
										`Subagent ${dirtyId} has unmerged worktree changes and cannot be dismissed (silent dismissal would lose code):\n- Path: ${wt.path}\n- Branch: ${wt.branch}\n- Changes: ${wt.uncommittedCount ?? 0} uncommitted file(s), ${wt.aheadCount ?? 0} commit(s) ahead\nPlease merge the branch (git merge ${wt.branch}) or discard changes via worktree(action="remove", path="${wt.path}", force=true).`,
										"subagents.dismiss.worktree.dirty",
										{
											dirtyId,
											path: wt.path,
											branch: wt.branch,
											uncommitted: wt.uncommittedCount ?? 0,
											ahead: wt.aheadCount ?? 0,
										},
									),
								);
							}
						}

						const res = await host.dismissSubagent(targetId, {
							force: p.force,
							includePersisted: p.includePersisted,
						});
						if (!res.ok) {
							const failedId = shortId(targetId);
							return text(
								pick(
									getLang(),
									`移出子代理 ${failedId} 失败：${res.reason ?? "未知原因"}。`,
									`Failed to dismiss subagent ${failedId}: ${res.reason ?? "unknown reason"}.`,
									"subagents.dismiss.failed",
									{ failedId, reason: res.reason ?? "unknown" },
								),
							);
						}
						const doneId = shortId(targetId);
						return text(
							pick(
								getLang(),
								`已移出子代理 ${doneId}。移出后不可逆（会话已从左栏移除并释放运行时与临时数据）。提示：如需获取产物，请在移出前调用 subagent(action="get_result")。`,
								`Dismissed subagent ${doneId}. Dismissal is irreversible (session removed from panel, runtime and temporary data released). Note: call subagent(action="get_result") before dismissal if you need its output.`,
								"subagents.dismiss.success.single",
								{ doneId },
							),
							{ dismissed: [targetId], skipped: [] },
						);
					}

					candidateIds.sort((a, b) => depthOf(b) - depthOf(a));

					const dismissed: string[] = [];
					const skipped: { runId: string; reason: string }[] = [];

					for (const targetId of candidateIds) {
						const snapshot = host.getSubagent(targetId);
						if (!snapshot) {
							skipped.push({ runId: targetId, reason: "not_found" });
							continue;
						}
						if (selfId && executionOfId(targetId) === executionOfId(selfId)) {
							skipped.push({ runId: targetId, reason: "self" });
							continue;
						}
						if (activeConvId && executionOfId(targetId) === executionOfId(activeConvId)) {
							skipped.push({ runId: targetId, reason: "active" });
							continue;
						}
						if (selfId && !isDescendantOf(targetId, selfId)) {
							skipped.push({ runId: targetId, reason: "not_descendant" });
							continue;
						}
						if (snapshot.persisted && !p.includePersisted) {
							skipped.push({ runId: targetId, reason: "persisted" });
							continue;
						}
						const isRunning = snapshot.streaming || snapshot.state === "running";
						if (isRunning && !p.force) {
							skipped.push({ runId: targetId, reason: "running" });
							continue;
						}
						if (host.finalizeSubagentWorktree) {
							await host.finalizeSubagentWorktree(targetId);
						}
						const updated = host.getSubagent(targetId) ?? snapshot;
						if (updated.worktree && !updated.worktree.cleanedUp) {
							const wt = updated.worktree;
							const isDirty = Boolean(wt.isDirty || (wt.uncommittedCount ?? 0) > 0 || (wt.aheadCount ?? 0) > 0);
							if (isDirty) {
								skipped.push({ runId: targetId, reason: "dirty_worktree" });
								continue;
							}
						}

						const res = await host.dismissSubagent(targetId, {
							force: p.force,
							includePersisted: p.includePersisted,
						});
						if (res.ok) {
							dismissed.push(targetId);
						} else {
							skipped.push({ runId: targetId, reason: res.reason ?? "failed" });
						}
					}

					if (dismissed.length === 0) {
						if (isFinishedAll) {
							return text(
								pick(
									getLang(),
									"没有可移出的已结束子代理。",
									"No finished subagents to dismiss.",
									"subagents.dismiss.finished_all.empty",
								),
								{ dismissed: [], skipped },
							);
						}
						return text(
							pick(getLang(), "没有成功移出任何子代理。", "No subagents were dismissed.", "subagents.dismiss.none"),
							{ dismissed: [], skipped },
						);
					}

					const skippedCount = skipped.length;
					const skippedZh = skippedCount > 0 ? `（${skippedCount} 个已跳过）` : "";
					const skippedEn = skippedCount > 0 ? ` (${skippedCount} skipped)` : "";
					return text(
						pick(
							getLang(),
							`已成功移出 ${dismissed.length} 个子代理${skippedZh}。移出后不可逆（会话已从左栏移除并释放运行时与临时数据）。提示：如需获取产物，请在移出前调用 subagent(action="get_result")。`,
							`Successfully dismissed ${dismissed.length} subagent(s)${skippedEn}. Dismissal is irreversible (sessions removed from panel, runtimes and temporary data released). Note: call subagent(action="get_result") before dismissal if you need their outputs.`,
							"subagents.dismiss.success.batch",
							{ count: dismissed.length, skippedZh, skippedEn },
						),
						{ dismissed, skipped },
					);
				}

				default:
					return text(
						pick(
							getLang(),
							`未知 action：${action}。支持的 action：${SUBAGENT_ACTIONS.join(", ")}。`,
							`Unknown action: ${action}. Supported actions: ${SUBAGENT_ACTIONS.join(", ")}.`,
							"subagents.action.unknown",
							{ action },
						),
					);
			}
		},
	});
}

export function makeSubagentTools(
	host: SubagentToolHost,
	lang?: () => ServerLang,
	selfConvId?: string | (() => string | undefined),
): ToolDefinition[] {
	const primary = makeSubagentTool(host, lang, selfConvId);
	return [
		primary,
		{
			...primary,
			name: SUBAGENT_TOOL_NAME,
			label: "Conversation collaboration (legacy alias)",
			description:
				"Compatibility alias for conversation. Prefer conversation for new calls; parameters and behavior are identical.",
			promptSnippet: "support existing subagent calls; prefer conversation",
		},
	];
}

function shortId(id: string): string {
	return id.slice(0, 8);
}

function clipSubagentOutput(output: string, lang: ServerLang): string {
	const HEAD = 10;
	const TAIL = 30;
	const lines = output.split("\n");
	if (lines.length <= HEAD + TAIL + 5) return output;
	const omitted = lines.length - HEAD - TAIL;
	const marker =
		lang === "zh" ? `… [中间省略 ${omitted} 行，头尾保留] …` : `… [${omitted} lines omitted, head and tail kept] …`;
	return [...lines.slice(0, HEAD), marker, ...lines.slice(-TAIL)].join("\n");
}

export function collectSubagentDescendantIds(
	items: ReadonlyArray<{ id: string; parentId?: string; isSubagent: boolean }>,
	rootId: string,
): string[] {
	const byId = new Map(items.map((c) => [c.id, c]));
	const out: string[] = [];
	for (const c of items) {
		if (!c.isSubagent || c.id === rootId) continue;
		let cur: { id: string; parentId?: string; isSubagent: boolean } | undefined = c;
		const seen = new Set<string>();
		while (cur?.parentId) {
			if (cur.parentId === rootId) {
				out.push(c.id);
				break;
			}
			if (seen.has(cur.parentId)) break;
			seen.add(cur.parentId);
			cur = byId.get(cur.parentId);
			if (!cur) break;
		}
	}
	return out;
}

function subagentVerdict(r: SubagentSnapshot, lang: ServerLang = "en"): string {
	if (r.error) return pick(lang, "error（报错）", "error", "subagents.verdict.error");
	if (r.canceled) return pick(lang, "canceled（已中止）", "canceled", "subagents.verdict.canceled");
	return r.taskPending ? "pending" : r.state;
}

function verdictText(r: SubagentSnapshot, lang: ServerLang = "en"): string {
	if (r.error)
		return pick(lang, `错误：${r.error}`, `Error: ${r.error}`, "subagents.verdict.error.detail", {
			"r.error": r.error,
		});
	if (r.canceled)
		return pick(lang, "（被中止，未产出结论）", "(Aborted, no conclusion produced.)", "subagents.verdict.aborted");
	return "";
}

function promptRemaining(remaining: string[], lang: ServerLang = "en"): string {
	if (remaining.length === 0) return "";
	const pendingIds = remaining.map(shortId).join(", ");
	return pick(
		lang,
		`\n未完成：${pendingIds}。可再次调用 subagent（action="wait_all"）继续等待耗时任务，或使用 steer 补充指令 / stop 中止。`,
		`\nPending: ${pendingIds}. You may call subagent (action="wait_all") again to continue waiting for long tasks, or use steer to add instructions / stop to abort.`,
		"subagents.wait.pending",
		{ pendingIds: pendingIds },
	);
}
