import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { QuestionAnswer, UiQuestion } from "./protocol.js";
import { pick, type ServerLang } from "./i18n.js";
import { type SubagentSpawnExtra, resolveSecurityMode } from "./subagent-security-gate.js";
import { THINKING_LEVELS } from "./subagent-templates.js";
import {
	evidenceVerdictLabel,
	formatEvidenceSummary,
	normalizeEvidenceInput,
	type SubagentEvidence,
	type SubagentEvidenceInput,
} from "./subagent-evidence.js";
import type { SettleWakeReason } from "./subagent-settle.js";
import type { LedgerEvent, LedgerRunRecord, LedgerRunState } from "./subagent-ledger.js";
import { CONVERSATION_TOOL_NAME } from "./tool-manager.js";
import { richQuestionsSchema } from "./question-params.js";
import { questionsFromMessage } from "./conversation-communication.js";
import { Value } from "typebox/value";
export { CONVERSATION_TOOL_NAME } from "./tool-manager.js";

export type SubagentState = "running" | "queued" | "done" | "canceled";

/** 单次派发的扇出上限：超过就分多次调用，避免一次调用把并发预算挤爆。 */
export const SUBAGENT_FANOUT_MAX = 16;

/** 运行键长度与形状：模型给的短名，映射到真实运行身份。 */
export const SUBAGENT_KEY_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,39}$/;

/** 一次派发请求（单发与 `tasks[]` 扇出共用同一份归一化结果）。 */
export interface SubagentSpawnRequest {
	key?: string;
	prompt?: string;
	type?: string;
	template?: string;
	model?: string;
	thinking?: string;
	isolation?: string;
	persist?: boolean;
	notifyOnDone?: boolean | "manual";
}

export interface NormalizedSpawnSpec {
	key?: string;
	prompt: string;
	type: string;
	templateName?: string;
	model?: string;
	thinking?: string;
	isolationMode?: "worktree" | "none";
	persist?: boolean;
	notifyOnDone?: boolean | "manual";
}

/** 运行中改指令的回执：告诉父代理这次 steer 到底落在哪里。 */
export type SubagentSteerState = "delivered" | "queued" | "restarted" | "missed";

export interface SubagentSteerReceipt {
	state: SubagentSteerState;
}

/** 子代理本次运行的用量（输入/输出 token）。 */
export interface SubagentUsage {
	input: number;
	output: number;
	total: number;
}

export interface SubagentCompletionRecord {
	ok: boolean;
	error?: string;
	issues?: string[];
	evidence?: SubagentEvidence;
}

/** 续跑结果：进程内子代理会话不落盘，所以续跑是「带上下文重派」，不是假装接上原转录。 */
export type SubagentResumeResult =
	| {
			ok: true;
			runId: string;
			convId: string;
			executionId?: string;
			mode: "relaunch";
			previousState: LedgerRunState;
			sessionFile?: string;
	  }
	| { ok: false; error: string; runId?: string };

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
	evidence?: SubagentEvidence;
	usage?: SubagentUsage;
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
	completeSubagent?(
		selfId: string,
		summary: string,
		evidence?: SubagentEvidenceInput,
	): SubagentCompletionRecord | Promise<SubagentCompletionRecord>;
	/** 运行账本（重启后可读）：只支持持久化的引擎提供；缺省时工具降级为只看活运行。 */
	listLedgerRuns?(opts?: { limit?: number }): Promise<LedgerRunRecord[]>;
	getLedgerRun?(runId: string): Promise<LedgerRunRecord | undefined>;
	getLedgerEvents?(runId: string, limit?: number): Promise<LedgerEvent[]>;
	resumeLedgerRun?(selfId: string, runId: string, message?: string): Promise<SubagentResumeResult>;
	/**
	 * 等待 `ids` 里任意一个发生可观察变化（回合结束、停止、移出、问卷/请示、通知状态）。
	 * 返回 `timeout` 表示这段等待到点，调用方自己判断是否继续等；返回 `aborted` 表示外部取消。
	 */
	waitForSubagentSettle(ids: string[], opts: { timeoutMs: number; signal?: AbortSignal }): Promise<SettleWakeReason>;
	consultParent?(selfConvId: string, questions: UiQuestion[], signal?: AbortSignal): Promise<unknown>;
	answerConsult?(
		selfConvId: string,
		runId: string,
		requestId: string,
		answers?: QuestionAnswer[],
		message?: string,
	): unknown;
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
	steerSubagent(convId: string, message: string): Promise<SubagentSteerReceipt | void>;
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
	"resume",
] as const;

export type SubagentAction = (typeof SUBAGENT_ACTIONS)[number];

/** Compact action signature: the single place documenting parameters, so field schemas stay prose-free. */
export const MANAGEMENT_ACTION_SIGNATURE =
	"spawn(prompt,type?,key? | tasks[{key,prompt,type?,template?,model?,thinking?,isolation?,persist?,notifyOnDone?}]) | " +
	"steer/answer(runId,message,requestId?) | complete(summary,evidence{files[],commands[],none?,blocked?}) | consult(message) | " +
	"escalate(runId,requestId) | get_result/stop/resume(runId,message?) | wait_all/dismiss(runIds? keys accepted) | " +
	"handoff(toRunId,payload) | list(kind?) | templates";

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

	// 扇出键表：模型给短 key，工具映射成稳定运行身份（有界，旧的先丢）。
	const RUN_KEY_CAP = 256;
	const runKeys = new Map<string, string>();
	const rememberRunKey = (key: string | undefined, convId: string): void => {
		if (!key) return;
		runKeys.delete(key);
		runKeys.set(key, convId);
		while (runKeys.size > RUN_KEY_CAP) {
			const oldest = runKeys.keys().next().value;
			if (oldest === undefined) break;
			runKeys.delete(oldest);
		}
	};
	/** `key` 与真实 id 都接受：命中键表就换成运行身份，否则原样返回。 */
	const resolveRunRef = (ref: string): string => runKeys.get(ref.trim()) ?? ref;

	const normalizeSpawnRequest = (
		request: SubagentSpawnRequest,
		ordinal: number,
	): { spec: NormalizedSpawnSpec } | { error: string } => {
		const lang = getLang();
		const zh = lang === "zh";
		const rawKey = typeof request.key === "string" ? request.key.trim() : "";
		const label = rawKey ? `[${rawKey}]` : zh ? `[第 ${ordinal} 项]` : `[task ${ordinal}]`;
		const prompt = typeof request.prompt === "string" ? request.prompt : "";
		if (!prompt.trim()) {
			return {
				error: pick(
					lang,
					`${label} 缺少 prompt。`,
					`${label} is missing a prompt.`,
					"subagents.spawn.task.missing.prompt",
					{ label },
				),
			};
		}
		if (rawKey && !SUBAGENT_KEY_PATTERN.test(rawKey)) {
			return {
				error: pick(
					lang,
					`${label} 的 key 不合法：只用字母/数字/下划线/点/横线，最长 40 字符。`,
					`${label} has an invalid key: use letters/digits/\`_.-\`, max 40 chars.`,
					"subagents.spawn.task.bad.key",
					{ label },
				),
			};
		}
		const type = typeof request.type === "string" && request.type.trim() ? request.type.trim() : "general";
		const requestedTemplate =
			typeof request.template === "string" && request.template.trim() ? request.template.trim() : undefined;
		let templateName: string | undefined;
		if (requestedTemplate) {
			if (!host.isTemplateUsable(requestedTemplate)) {
				return {
					error: pick(
						lang,
						`${label} 的子代理模板不可用：${requestedTemplate}（不存在或已停用）。用 conversation(action="templates") 看清单。`,
						`${label} requests an unavailable template: ${requestedTemplate} (missing or disabled). Use conversation(action="templates") to list them.`,
						"subagents.spawn.template.unavailable",
						{ label, "p.template": requestedTemplate },
					),
				};
			}
			templateName = requestedTemplate;
		} else if (host.isTemplateUsable(type)) {
			templateName = type;
		}
		const thinking =
			typeof request.thinking === "string" && request.thinking.trim() ? request.thinking.trim() : undefined;
		if (thinking && !THINKING_LEVELS.includes(thinking as (typeof THINKING_LEVELS)[number])) {
			return {
				error: pick(
					lang,
					`${label} 非法思考强度：${thinking}。可选档位：${THINKING_LEVELS.join(", ")}。`,
					`${label} has an invalid thinking level: ${thinking}. Allowed levels: ${THINKING_LEVELS.join(", ")}.`,
					"subagents.spawn.thinking.invalid",
					{ label, thinking, levels: THINKING_LEVELS.join(", ") },
				),
			};
		}
		const rawIsolation = typeof request.isolation === "string" ? request.isolation.trim().toLowerCase() : "";
		if (rawIsolation && rawIsolation !== "worktree" && rawIsolation !== "none") {
			return {
				error: pick(
					lang,
					`${label} 不支持的隔离模式：${rawIsolation}（可选 worktree / none）。`,
					`${label} uses an unsupported isolation mode: ${rawIsolation} (worktree / none).`,
					"subagents.spawn.isolation.invalid",
					{ label, isolation: rawIsolation },
				),
			};
		}
		const model = typeof request.model === "string" && request.model.trim() ? request.model.trim() : undefined;
		return {
			spec: {
				key: rawKey || undefined,
				prompt,
				type,
				templateName,
				model,
				thinking,
				isolationMode: rawIsolation === "worktree" || rawIsolation === "none" ? rawIsolation : undefined,
				persist: request.persist,
				notifyOnDone: request.notifyOnDone,
			},
		};
	};

	/** 单次启动：校验完的 spec → 真实子代理。错误以结果返回，不抛（扇出时其它项照常跑）。 */
	const spawnSpec = async (
		spec: NormalizedSpawnSpec,
		cwd: string,
		signal: AbortSignal | undefined,
	): Promise<{ ok: true; convId: string; executionId?: string } | { ok: false; error: string }> => {
		const matchedTemplate = spec.templateName
			? host.listTemplates().find((t) => t.name === spec.templateName)
			: undefined;
		const securityMode = resolveSecurityMode(spec.type, matchedTemplate);
		const extra: SubagentSpawnExtra | undefined = securityMode !== "normal" ? { securityMode } : undefined;
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
			spec.prompt,
			spec.type,
			cwd,
			spec.templateName,
			spec.model,
			undefined,
			spec.persist,
			spec.thinking,
			spec.notifyOnDone,
		];
		if (spec.isolationMode === "worktree" || extra !== undefined || signal !== undefined) {
			spawnArgs.push(spec.isolationMode === "worktree" ? "worktree" : undefined);
		}
		if (extra !== undefined || signal !== undefined) spawnArgs.push(extra);
		if (signal !== undefined) spawnArgs.push(signal);
		try {
			signal?.throwIfAborted();
			const convId = await host.spawnSubagent(...spawnArgs);
			rememberRunKey(spec.key, convId);
			return { ok: true, convId, executionId: host.getSubagent(convId)?.executionId };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	};

	/** 扇出时的有限并发：避免与并发上限抢名额，又不至于串行等每个子代理初始化完。 */
	const SPAWN_FANOUT_CONCURRENCY = 4;
	const mapLimited = async <T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> => {
		const out = new Array<R>(items.length);
		let cursor = 0;
		const worker = async (): Promise<void> => {
			while (cursor < items.length) {
				const index = cursor++;
				out[index] = await fn(items[index]!);
			}
		};
		await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
		return out;
	};

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

	return defineTool({
		name: CONVERSATION_TOOL_NAME,
		label: "Conversation collaboration",
		description:
			"Create and manage collaborative conversations, including temporary subagents and persistent sessions, for delegation, research, and execution.",
		promptSnippet: "Delegate tasks, inspect results, or request task completion.",
		promptGuidelines: ["Prefer communicate; consult/answer/escalate/handoff stay supported as legacy routes."],
		parameters: Type.Object({
			action: Type.Unsafe<SubagentAction>({
				type: "string",
				enum: [...SUBAGENT_ACTIONS],
				description: MANAGEMENT_ACTION_SIGNATURE,
			}),
			prompt: Type.Optional(Type.String()),
			key: Type.Optional(Type.String()),
			tasks: Type.Optional(
				Type.Array(
					Type.Object({
						key: Type.Optional(Type.String()),
						prompt: Type.Optional(Type.String()),
						type: Type.Optional(Type.String()),
						template: Type.Optional(Type.String()),
						model: Type.Optional(Type.String()),
						thinking: Type.Optional(Type.String({ enum: [...THINKING_LEVELS] })),
						isolation: Type.Optional(Type.String({ enum: ["worktree", "none"] })),
						persist: Type.Optional(Type.Boolean()),
						notifyOnDone: Type.Optional(
							Type.Unsafe<boolean | "manual">({ type: ["boolean", "string"], enum: [true, false, "manual"] }),
						),
					}),
				),
			),
			message: Type.Optional(Type.String({ description: "Steer instruction, consult question, or answer text." })),
			summary: Type.Optional(Type.String()),
			evidence: Type.Optional(
				Type.Object({
					files: Type.Optional(Type.Array(Type.String())),
					commands: Type.Optional(Type.Array(Type.String())),
					none: Type.Optional(Type.Boolean()),
					blocked: Type.Optional(Type.String()),
				}),
			),
			payload: Type.Optional(Type.String()),
			runId: Type.Optional(Type.String()),
			runIds: Type.Optional(Type.Array(Type.String())),
			toRunId: Type.Optional(Type.String()),
			requestId: Type.Optional(Type.String()),
			type: Type.Optional(Type.String({ description: "Role/template (explore, implement, review, general)." })),
			model: Type.Optional(Type.String()),
			thinking: Type.Optional(Type.String({ enum: [...THINKING_LEVELS] })),
			notifyOnDone: Type.Optional(
				Type.Unsafe<boolean | "manual">({ type: ["boolean", "string"], enum: [true, false, "manual"] }),
			),
			cwd: Type.Optional(Type.String()),
			persist: Type.Optional(Type.Boolean()),
			isolation: Type.Optional(Type.String({ enum: ["worktree", "none"] })),
			kind: Type.Optional(Type.String({ enum: ["all", "subagent", "persistent"] })),
			scope: Type.Optional(Type.String({ enum: ["finished_all"] })),
			force: Type.Optional(Type.Boolean()),
			includePersisted: Type.Optional(Type.Boolean()),
			timeoutSeconds: Type.Optional(Type.Integer()),
		}),
		execute: async (_id, p, signal, _onUpdate, ctx) => {
			const action = (p.action ?? "").trim().toLowerCase();
			// Text-first compatibility: the schema exposes `message` only; legacy/undocumented fields pass through.
			const legacy = p as typeof p & {
				questions?: UiQuestion[];
				answers?: QuestionAnswer[];
				template?: string;
				fromRunId?: string;
			};
			if (!action) {
				return text(
					pick(
						getLang(),
						`conversation 工具缺少 action 参数（可选：${SUBAGENT_ACTIONS.join(", ")}）。`,
						`conversation tool requires an action parameter (one of: ${SUBAGENT_ACTIONS.join(", ")}).`,
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
					const normalized = normalizeEvidenceInput(p.evidence);
					if (!normalized.ok) {
						return text(
							pick(
								getLang(),
								'evidence 形状不对：要么给 {files:[], commands:[]}，要么 {none:true}（只读任务），要么 {blocked:"原因"}；空对象不算证据。',
								'Malformed evidence: pass {files:[], commands:[]}, {none:true} for read-only work, or {blocked:"reason"}. An empty object is not evidence.',
								"subagents.complete.evidence.invalid",
							),
							{ status: "evidence_invalid" },
						);
					}
					const result = await host.completeSubagent(selfId, summary, normalized.value);
					if (result.ok === false) {
						const issues = result.issues && result.issues.length > 0 ? result.issues : [result.error ?? "unspecified"];
						throw new Error(
							pick(
								getLang(),
								`完成被驳回：证据与本会话转录不符。\n- ${issues.join("\n- ")}\n先修正再 complete：声称跑过的命令必须真的在本会话里跑过且成功；没改文件就写 {none:true}；做不完就写 {blocked:"原因"}。不要把口供改成能过的样子。`,
								`Completion rejected: the evidence does not match this session's transcript.\n- ${issues.join("\n- ")}\nFix the work, then complete again: commands must actually have run and succeeded; use {none:true} if you changed no files; use {blocked:"reason"} if you could not finish. Do not restate claims just to pass.`,
								"subagents.complete.rejected",
							),
						);
					}
					const evidence = result.evidence;
					const evidenceLine = evidence ? formatEvidenceSummary(evidence, getLang()) : "";
					return text(
						evidence
							? pick(
									getLang(),
									`完成意图已登记。证据：${evidenceLine}\n结算会等空闲与依赖收口。`,
									`Completion intent recorded. Evidence: ${evidenceLine}\nSettlement waits for idle state and pending dependencies.`,
									"subagents.complete.recorded",
									{ evidence: evidenceLine },
								)
							: "Completion intent recorded; settlement waits for idle state and pending dependencies.",
						{
							status: "completion_requested",
							runId: selfId,
							verdict: evidence?.verdict,
							evidence,
						},
					);
				}
				case "consult": {
					signal?.throwIfAborted();
					const selfId = selfIdOf();
					if (!selfId || !host.consultParent) throw new Error("Parent consultation is unavailable.");
					const questions = legacy.questions ?? questionsFromMessage(p.message);
					if (
						!Array.isArray(questions) ||
						questions.length < 1 ||
						questions.length > 3 ||
						questions.some(
							(q) =>
								!q || typeof q.id !== "string" || !q.id.trim() || typeof q.question !== "string" || !q.question.trim(),
						) ||
						new Set(questions.map((q) => q.id)).size !== questions.length
					) {
						throw new Error("consult requires a nonempty message (or 1-3 legacy questions with unique IDs).");
					}
					// schema 只下发展开档，富字段（options/optionsMap/dependsOn）的校验在这里补上，否则会把残缺选项透给 UI。
					const questionErrors = Value.Errors(richQuestionsSchema(), questions);
					if (questionErrors.length) {
						throw new Error(
							`Invalid consult questions: ${questionErrors
								.map((error) => `${error.instancePath || "/"}: ${error.message}`)
								.join("; ")}`,
						);
					}
					const result = await host.consultParent(selfId, questions, signal);
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
						const answers = legacy.answers;
						const answerText = typeof p.message === "string" ? p.message.trim() : "";
						if (answers !== undefined) {
							if (
								!Array.isArray(answers) ||
								answers.length === 0 ||
								answers.some(
									(a) =>
										!a ||
										typeof a.id !== "string" ||
										!a.id.trim() ||
										!Array.isArray(a.selected) ||
										a.selected.some((s) => typeof s !== "string") ||
										(a.custom !== undefined && typeof a.custom !== "string"),
								)
							) {
								throw new Error("answer requires structured answers with unique IDs.");
							}
							result = await host.answerConsult(selfId, p.runId, p.requestId, answers);
						} else if (answerText) {
							result = await host.answerConsult(selfId, p.runId, p.requestId, undefined, answerText);
						} else {
							throw new Error("answer requires a nonempty message (or legacy structured answers).");
						}
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
					const batchTasks = Array.isArray(p.tasks) && p.tasks.length > 0 ? p.tasks : undefined;
					if (!batchTasks && (!p.prompt || typeof p.prompt !== "string" || !p.prompt.trim())) {
						return text(
							pick(
								getLang(),
								'conversation(action="spawn") 缺少 prompt 参数（也可用 tasks[] 一次派多个）。',
								'conversation(action="spawn") requires prompt (or tasks[] for a fan-out).',
								"subagents.spawn.missing.prompt",
							),
						);
					}
					const requests: SubagentSpawnRequest[] = batchTasks
						? batchTasks.map((task) => ({ ...(task as SubagentSpawnRequest) }))
						: [
								{
									key: p.key,
									prompt: p.prompt,
									type: p.type,
									template: legacy.template,
									model: p.model,
									thinking: p.thinking,
									isolation: p.isolation,
									persist: p.persist,
									notifyOnDone: p.notifyOnDone,
								},
							];
					if (requests.length > SUBAGENT_FANOUT_MAX) {
						return text(
							pick(
								getLang(),
								`一次最多派发 ${SUBAGENT_FANOUT_MAX} 个（收到 ${requests.length} 个）。分批调用或先等一批收口。`,
								`At most ${SUBAGENT_FANOUT_MAX} tasks per call (got ${requests.length}). Split the batch or wait for a round to settle first.`,
								"subagents.spawn.batch.too.many",
								{ limit: SUBAGENT_FANOUT_MAX, count: requests.length },
							),
							{ status: "rejected", reason: "fanout_limit", limit: SUBAGENT_FANOUT_MAX },
						);
					}
					// 整批先校验再启动：一个不合法就一个都不启动，避免半批运行后预算/工作树无法回收。
					const prepared: NormalizedSpawnSpec[] = [];
					const problems: string[] = [];
					const usedKeys = new Set<string>();
					requests.forEach((request, index) => {
						const normalized = normalizeSpawnRequest(request, index + 1);
						if ("error" in normalized) {
							problems.push(normalized.error);
							return;
						}
						const key = normalized.spec.key;
						if (key && usedKeys.has(key)) {
							problems.push(
								pick(
									getLang(),
									`key 重复：${key}（同一批里必须唯一）。`,
									`Duplicate key: ${key} (keys must be unique within a batch).`,
									"subagents.spawn.batch.duplicate.key",
									{ key },
								),
							);
							return;
						}
						if (key) usedKeys.add(key);
						prepared.push(normalized.spec);
					});
					if (problems.length > 0) {
						const head = pick(
							getLang(),
							"派发被驳回（整批都未启动）：\n",
							"Fan-out rejected (nothing launched):\n",
							"subagents.spawn.batch.rejected",
						);
						return text(`${head}${problems.map((problem) => `- ${problem}`).join("\n")}`, {
							status: "rejected",
							problems,
						});
					}
					if (batchTasks) {
						const results = await mapLimited(prepared, SPAWN_FANOUT_CONCURRENCY, (spec) =>
							spawnSpec(spec, p.cwd ?? ctx.cwd, signal),
						);
						const lines = results.map((result, index) => {
							const spec = prepared[index]!;
							const label = spec.key ?? `#${index + 1}`;
							if (!result.ok) return `- ${label} ✗ ${result.error}`;
							const address = result.executionId ? ` · runId: ${result.executionId}` : "";
							const tpl = spec.templateName ? ` · ${spec.templateName}` : "";
							return `- ${label} → ${result.convId}${address} · ${spec.type}${tpl}`;
						});
						const startedKeys = prepared
							.filter((spec, index) => spec.key && results[index]?.ok)
							.map((spec) => spec.key);
						const okCount = results.filter((result) => result.ok).length;
						const head = pick(
							getLang(),
							`已派发 ${okCount}/${results.length} 个（key → 运行）：\n`,
							`Started ${okCount}/${results.length} task(s) (key → run):\n`,
							"subagents.spawn.batch.started",
							{ okCount, "results.length": results.length },
						);
						const keyHint =
							startedKeys.length > 0
								? pick(
										getLang(),
										`\n用 conversation(action="wait_all", runIds=${JSON.stringify(startedKeys)}) 一次等这批收口（key 与 runId 都接受）。`,
										`\nUse conversation(action="wait_all", runIds=${JSON.stringify(startedKeys)}) to collect this batch (keys and runIds both work).`,
										"subagents.spawn.batch.wait.hint",
										{ keys: JSON.stringify(startedKeys) },
									)
								: "";
						return text(`${head}${lines.join("\n")}${keyHint}`, {
							status: "spawned",
							tasks: results.map((result, index) => ({
								key: prepared[index]!.key,
								ok: result.ok,
								convId: result.ok ? result.convId : undefined,
								executionId: result.ok ? result.executionId : undefined,
								error: result.ok ? undefined : result.error,
							})),
						});
					}
					const single = prepared[0]!;
					const templateName = single.templateName;
					const isolationMode = single.isolationMode;
					let convId: string;
					const subagentType = single.type;
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
							single.prompt,
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
					rememberRunKey(single.key, convId);
					const executionId = host.getSubagent(convId)?.executionId;
					const keyLineZh = single.key ? `\nkey：${single.key}` : "";
					const keyLineEn = single.key ? `\nkey: ${single.key}` : "";
					const addressLine = executionId ? `\nrunId: ${executionId}` : "";
					const subagentTitleText = subagentTitle(single.prompt);
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
							`${kindLabelZh}已启动（运行列表可见）：${convId}\n类型：${subagentType} · 标题：${subagentTitleText}${keyLineZh}${templateLineZh}${modelLineZh}${thinkingLineZh}${notifyLineZh}${isolationLineZh}${addressLine}` +
								`\n用 conversation(action="wait_all") 一次等全部完成（事件驱动，不再轮询），conversation(action="get_result") 取单个结果，conversation(action="list") 看运行态，conversation(action="steer") 改向，conversation(action="stop") 停止。`,
							`${kindLabelEn} started (visible in the running list): ${convId}\nType: ${subagentType} · Title: ${subagentTitleText}${keyLineEn}${templateLineEn}${modelLineEn}${thinkingLineEn}${notifyLineEn}${isolationLineEn}${addressLine}` +
								`\nUse conversation(action="wait_all") to wait for all at once (event-driven, no polling), conversation(action="get_result") for a single result, conversation(action="list") for live status, conversation(action="steer") to redirect, conversation(action="stop") to stop.`,
							"subagents.spawn.started",
							{
								convId,
								subagentType,
								subagentTitleText,
								"p.template": legacy.template,
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
							key: single.key,
							template: templateName,
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
								'conversation(action="get_result") 缺少 runId 参数。',
								'conversation(action="get_result") requires runId parameter.',
								"subagents.get.missing.runId",
							),
						);
					}
					const requestedRun = resolveRunRef(p.runId);
					let r = host.getSubagent(requestedRun);
					const missingId = shortId(p.runId);
					if (!r && host.getLedgerRun) {
						// 进程里没有 → 回落运行账本：重启/移出后仍能拿回结论、证据与工作树。
						const recorded = await host.getLedgerRun(requestedRun).catch(() => undefined);
						if (recorded) {
							const timeline = (await host.getLedgerEvents?.(requestedRun, 8).catch(() => [])) ?? [];
							const formatted = formatLedgerRunResult(recorded, getLang(), timeline);
							return text(formatted, { ...recorded, timeline });
						}
					}
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
					const usageTag = formatUsageTag(r.usage, getLang());
					const evidenceLine = r.evidence
						? pick(
								getLang(),
								`\n证据：${formatEvidenceSummary(r.evidence, getLang())}`,
								`\nEvidence: ${formatEvidenceSummary(r.evidence, getLang())}`,
								"subagents.get.evidence",
								{ evidence: formatEvidenceSummary(r.evidence, getLang()) },
							)
						: "";
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
							`子代理 ${doneId}（${r.type}${modelTag}${usageTag}）状态：${verdict}\n${doneDetail}${evidenceLine}\n${doneOutput}${worktreeDetail}`,
							`Subagent ${doneId} (${r.type}${modelTag}${usageTag}) status: ${verdict}\n${doneDetail}${evidenceLine}\n${doneOutput}${worktreeDetail}`,
							"subagents.get.done",
							{
								doneId,
								"r.type": r.type,
								modelTag,
								verdict,
								doneDetail,
								evidenceLine,
								doneOutput: `${doneOutput}${worktreeDetail}`,
							},
						),
						r,
					);
				}

				case "resume": {
					if (!host.resumeLedgerRun) throw new Error("Run resume is unavailable on this engine.");
					if (!p.runId || typeof p.runId !== "string" || !p.runId.trim()) {
						return text(
							pick(
								getLang(),
								'conversation(action="resume") 缺少 runId 参数。',
								'conversation(action="resume") requires runId parameter.',
								"subagents.resume.missing.runId",
							),
						);
					}
					const resumeSelf = selfIdOf();
					if (!resumeSelf) throw new Error("Resume requires a verified conversation identity.");
					const resumeTarget = resolveRunRef(p.runId);
					const resumeExtra = typeof p.message === "string" && p.message.trim() ? p.message.trim() : undefined;
					const result = await host.resumeLedgerRun(resumeSelf, resumeTarget, resumeExtra);
					if (!result.ok) {
						const resumedId = result.runId ? shortId(result.runId) : "";
						const reasons: Record<string, [string, string]> = {
							not_found: [
								'账本里没有这个运行（可能已被清理）。用 conversation(action="list") 看现有记录。',
								'Not in the run ledger (it may have been pruned). Use conversation(action="list") to inspect records.',
							],
							running: [
								"这个运行还在进程里跑着：先 wait_all / get_result，别重复派发。",
								"This run is still live: use wait_all / get_result instead of relaunching it.",
							],
							already_resumed: [
								`已经续跑过了${resumedId ? `（新运行 ${resumedId}）` : ""}，别重复续跑。`,
								`It was already resumed${resumedId ? ` (new run ${resumedId})` : ""}; do not resume twice.`,
							],
							parent_missing: [
								"原父对话已不可用，续跑挂不回去。请直接在当前对话里 spawn 一次。",
								"The original parent is gone, so the relaunch cannot attach to it. Spawn from this conversation instead.",
							],
						};
						const [zhReason, enReason] = reasons[result.error] ?? [
							`续跑失败：${result.error}`,
							`Resume failed: ${result.error}`,
						];
						return text(
							pick(getLang(), zhReason, enReason, "subagents.resume.failed", { reason: result.error }),
							result,
						);
					}
					const newRunId = result.executionId ?? result.convId;
					const transcript = result.sessionFile
						? pick(
								getLang(),
								`旧会话记录 ${result.sessionFile} 可在历史对话里回看。`,
								`The old transcript ${result.sessionFile} stays readable from History.`,
								"subagents.resume.transcript",
								{ file: result.sessionFile },
							)
						: pick(
								getLang(),
								"旧会话没有落盘，接不上原转录：这次是带上原任务与已知进度的重派。",
								"The old in-memory session was never persisted, so this is a relaunch carrying the original task and known progress.",
								"subagents.resume.no.transcript",
							);
					return text(
						pick(
							getLang(),
							`已续跑：旧运行 ${shortId(result.runId)}（${result.previousState}）→ 新运行 ${newRunId}。${transcript}`,
							`Resumed: ${shortId(result.runId)} (${result.previousState}) → new run ${newRunId}. ${transcript}`,
							"subagents.resume.ok",
							{ oldId: shortId(result.runId), state: result.previousState, newId: newRunId, transcript },
						),
						result,
					);
				}

				case "steer": {
					if (!p.runId || typeof p.runId !== "string" || !p.runId.trim()) {
						return text(
							pick(
								getLang(),
								'conversation(action="steer") 缺少 runId 参数。',
								'conversation(action="steer") requires runId parameter.',
								"subagents.steer.missing.runId",
							),
						);
					}
					if (typeof p.message !== "string" || !p.message.trim()) {
						return text(
							pick(
								getLang(),
								'conversation(action="steer") 缺少 message 参数。',
								'conversation(action="steer") requires message parameter.',
								"subagents.steer.missing.message",
							),
						);
					}
					const steerTarget = resolveRunRef(p.runId);
					if (!host.getSubagent(steerTarget)) {
						const missingSteerId = shortId(p.runId);
						return text(
							pick(
								getLang(),
								`未找到子代理 ${missingSteerId}（可能已移出），消息未注入。请用 conversation(action="list") 确认仍在运行的子代理。`,
								`Subagent ${missingSteerId} not found (may have been dismissed); message not injected. Use conversation(action="list") to confirm running subagents.`,
								"subagents.steer.not.found",
								{ missingSteerId },
							),
						);
					}
					const receipt = await host.steerSubagent(executionOfId(steerTarget), p.message);
					const steerState: SubagentSteerState = receipt && "state" in receipt ? receipt.state : "delivered";
					const steerId = shortId(p.runId);
					const stateText =
						steerState === "queued"
							? pick(
									getLang(),
									"已排队，等当前回合结束再送。",
									"Queued; delivered when the current turn ends.",
									"subagents.steer.queued",
								)
							: steerState === "restarted"
								? pick(
										getLang(),
										"它当时已空闲，已在同一会话里开新一轮。",
										"It was idle; a new round started in the same session.",
										"subagents.steer.restarted",
									)
								: steerState === "missed"
									? pick(
											getLang(),
											"没能送达（运行已结束无可投递通道）。",
											"Not delivered (the run ended with no live route).",
											"subagents.steer.missed",
										)
									: pick(
											getLang(),
											"已送进当前回话上下文。",
											"Delivered into the live turn.",
											"subagents.steer.delivered",
										);
					return text(
						pick(
							getLang(),
							`已向子代理 ${steerId} 注入消息（${steerState}）：${stateText}`,
							`Message injected into subagent ${steerId} (${steerState}): ${stateText}`,
							"subagents.steer.injected",
							{ steerId, steerState, stateText },
						),
						{ steerId, state: steerState },
					);
				}

				case "list": {
					const list = host.listSubagents(p.kind as "all" | "subagent" | "persistent" | undefined, selfIdOf());
					const tLang = getLang();
					// 账本追加：活运行永远以内存快照为准，账本只补「已经不在进程里」的那些。
					const ledgerLines: string[] = [];
					if (host.listLedgerRuns) {
						try {
							const recorded = await host.listLedgerRuns({ limit: 32 });
							for (const rec of recorded) {
								if (rec.state === "dismissed") continue;
								if (host.getSubagent(rec.runId)) continue;
								const tag = rec.evidence ? ` · ${formatLedgerEvidence(rec, tLang)}` : "";
								const resumed = rec.resumedBy
									? pick(
											tLang,
											`，已续跑→${shortId(rec.resumedBy)}`,
											`, resumed→${shortId(rec.resumedBy)}`,
											"subagents.list.ledger.resumed",
											{ id: shortId(rec.resumedBy) },
										)
									: "";
								ledgerLines.push(
									pick(
										tLang,
										`- 账本 ${shortId(rec.runId)} · ${rec.type} · ${rec.state} · ${rec.title}${tag}${resumed}`,
										`- ledger ${shortId(rec.runId)} · ${rec.type} · ${rec.state} · ${rec.title}${tag}${resumed}`,
										"subagents.list.ledger.item",
										{ id: shortId(rec.runId), type: rec.type, state: rec.state, title: rec.title, tag, resumed },
									),
								);
								if (ledgerLines.length >= 10) break;
							}
						} catch {
							// 账本读失败不影响活运行列表。
						}
					}
					if (list.length === 0 && ledgerLines.length === 0)
						return text(
							pick(
								getLang(),
								"当前没有运行中的对话/子代理（运行账本里也没有记录）。",
								"No managed conversations or subagents running (the run ledger is empty too).",
								"subagents.list.empty",
							),
						);
					const lines = list.map((r) => {
						const tag = r.persisted
							? tLang === "zh"
								? "持久化"
								: "persistent"
							: tLang === "zh"
								? "子代理"
								: "subagent";
						const modelTag = r.model ? ` · ${r.model}${r.thinkingLevel ? `:${r.thinkingLevel}` : ""}` : "";
						const evidenceTag = r.evidence ? ` · ${formatEvidenceSummary(r.evidence, tLang)}` : "";
						return (
							`- ${r.convId}${r.executionId ? ` (runId: ${r.executionId})` : ""} · ${r.type}${modelTag} · ${subagentVerdict(r, tLang)} · ${r.title}` +
							(tLang === "zh" ? `（${tag} · msg: ${r.messageCount}）` : ` (${tag} · msg: ${r.messageCount})`) +
							evidenceTag
						);
					});
					const ledgerHead =
						ledgerLines.length > 0
							? pick(
									tLang,
									"\n\n运行账本（不在进程里：get_result 取已产出的结论/证据，resume 续跑）：\n",
									"\n\nRun ledger (no longer in-process; get_result for the recorded result, resume to relaunch):\n",
									"subagents.list.ledger.head",
								)
							: "";
					return text(`${lines.join("\n")}${ledgerHead}${ledgerLines.join("\n")}`);
				}

				case "stop": {
					if (!p.runId || typeof p.runId !== "string" || !p.runId.trim()) {
						return text(
							pick(
								getLang(),
								'conversation(action="stop") 缺少 runId 参数。',
								'conversation(action="stop") requires runId parameter.',
								"subagents.stop.missing.runId",
							),
						);
					}
					const stopTarget = resolveRunRef(p.runId);
					if (!host.getSubagent(stopTarget)) {
						const missingStopId = shortId(p.runId);
						return text(
							pick(
								getLang(),
								`未找到子代理 ${missingStopId}（可能已移出或已结束），无需停止。请用 conversation(action="list") 确认仍在运行的子代理。`,
								`Subagent ${missingStopId} not found (may have been dismissed or already finished); nothing to stop. Use conversation(action="list") to confirm running subagents.`,
								"subagents.stop.not.found",
								{ missingStopId },
							),
						);
					}
					await host.stopSubagent(stopTarget);
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
							const id = executionOfId(resolveRunRef(requestedId));
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
					// 已收口单源：`getSubagent` 拿不到（已移出/已结束并回收）与显式终态都算收口，
					// 等待与「还剩谁」必须用同一判据，否则会出现「全都完成了却报还有人在跑」。
					const isSettled = (id: string): boolean => {
						const r = host.getSubagent(id);
						return r === undefined || isSubagentTerminal(r);
					};
					const startedAt = Date.now();
					// 单次等待切片：上游在真实事件上唤醒；到点只是重新算一遍（新派生的后代、问卷），
					// 不再用固定轮询去抢快照。
					const SETTLE_SLICE_MS = 30_000;

					try {
						const waitingParentId = selfIdOf();
						if (waitingParentId) host.setConsultWaiting?.(waitingParentId, true);
						while (!signal?.aborted) {
							const remainingMs = timeoutMs - (Date.now() - startedAt);
							if (remainingMs <= 0) break;
							for (const descId of expandDescendants(wanted)) {
								if (selfId && descId === selfId) continue;
								if (selfAncestorIds.has(descId)) continue;
								wanted.add(descId);
							}
							const consults = collectConsults();
							if (consults) return consults;
							const allDone = Array.from(wanted).every(isSettled);
							if (allDone) break;
							const wake = await host.waitForSubagentSettle(Array.from(wanted), {
								timeoutMs: Math.min(remainingMs, SETTLE_SLICE_MS),
								signal,
							});
							if (wake === "aborted") break;
						}
					} finally {
						const waitingParentId = selfIdOf();
						if (waitingParentId) host.setConsultWaiting?.(waitingParentId, false);
					}

					const tLang = getLang();
					const waitedSecs = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
					const timeoutSecs = Math.round(timeoutMs / 1000);

					const finishedIds = Array.from(wanted).filter(isSettled);
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
							const usageTag = formatUsageTag(r.usage, tLang);
							const evidenceTag = r.evidence ? ` · ${formatEvidenceSummary(r.evidence, tLang)}` : "";
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
							return `- ${sId}（${r.type} · ${verdict} · ${r.title}${wtTag}${usageTag}）${detail ? ` · ${detail}` : ""}${evidenceTag}:\n${out}${wtPathInfo}`;
						})
						.join("\n\n");

					const remaining = Array.from(wanted).filter((id) => !isSettled(id));

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
							`可用的子代理模板（subagent 的 template 参数传名字，如 conversation(action="spawn", template="${firstTemplateName}"))：\n${templateLines}`,
							`Available subagent templates (pass the name as subagent's template param, e.g. conversation(action="spawn", template="${firstTemplateName}")):\n${templateLines}`,
							"subagents.templates.list",
							{ firstTemplateName, templateLines },
						),
					);
				}

				case "handoff": {
					signal?.throwIfAborted();
					const fromId = selfIdOf();
					if (!fromId) throw new Error("Handoff requires a verified conversation identity.");
					if (legacy.fromRunId && legacy.fromRunId !== fromId) {
						throw new Error("Handoff source must match the calling conversation.");
					}
					if (!p.toRunId || typeof p.toRunId !== "string" || !p.toRunId.trim()) {
						return text(
							pick(
								getLang(),
								'conversation(action="handoff") 缺少 toRunId 参数。',
								'conversation(action="handoff") requires toRunId parameter.',
								"subagents.handoff.missing.toRunId",
							),
						);
					}
					if (typeof p.payload !== "string" || !p.payload.trim()) {
						return text(
							pick(
								getLang(),
								'conversation(action="handoff") 缺少 payload 参数。',
								'conversation(action="handoff") requires payload parameter.',
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
								`未找到目标子代理 ${missingId}（可能已移出或不存在）。请用 conversation(action="list") 确认可用的子代理。`,
								`Target subagent ${missingId} not found (may have been dismissed or non-existent). Use conversation(action="list") to check available subagents.`,
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
								'conversation(action="dismiss") 缺少目标参数：请指定 runId、runIds 或 scope="finished_all"。',
								'conversation(action="dismiss") requires target parameter: specify runId, runIds, or scope="finished_all".',
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
									`子代理 ${runningId} 仍在运行中（状态：${snapshot.state}）。请等待其完成、调用 conversation(action="stop")，或指定 force=true 强行中止并移出。`,
									`Subagent ${runningId} is still running (state: ${snapshot.state}). Wait for it to finish, call conversation(action="stop"), or specify force=true to force abort and dismiss.`,
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
								`已移出子代理 ${doneId}。移出后不可逆（会话已从左栏移除并释放运行时与临时数据）。提示：如需获取产物，请在移出前调用 conversation(action="get_result")。`,
								`Dismissed subagent ${doneId}. Dismissal is irreversible (session removed from panel, runtime and temporary data released). Note: call conversation(action="get_result") before dismissal if you need its output.`,
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
							`已成功移出 ${dismissed.length} 个子代理${skippedZh}。移出后不可逆（会话已从左栏移除并释放运行时与临时数据）。提示：如需获取产物，请在移出前调用 conversation(action="get_result")。`,
							`Successfully dismissed ${dismissed.length} subagent(s)${skippedEn}. Dismissal is irreversible (sessions removed from panel, runtimes and temporary data released). Note: call conversation(action="get_result") before dismissal if you need their outputs.`,
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
	return [makeSubagentTool(host, lang, selfConvId)];
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

/** 账本证据摘要（记录里只有计数与裁决，没有原始 claims）。 */
function formatLedgerEvidence(record: LedgerRunRecord, lang: ServerLang): string {
	const ev = record.evidence;
	if (!ev) return "";
	const zh = lang === "zh";
	const label = evidenceVerdictLabel(ev.verdict, lang);
	const parts: string[] = [];
	if (ev.files > 0) parts.push(zh ? `${ev.matchedFiles}/${ev.files} 文件` : `${ev.matchedFiles}/${ev.files} files`);
	if (ev.commands > 0) {
		parts.push(zh ? `${ev.matchedCommands}/${ev.commands} 命令` : `${ev.matchedCommands}/${ev.commands} commands`);
	}
	if (ev.none) parts.push(zh ? "声明无改动" : "declared no changes");
	if (ev.blocked) parts.push(zh ? `受阻：${ev.blocked}` : `blocked: ${ev.blocked}`);
	if (parts.length === 0) return label;
	return `${label}${zh ? "（" : " ("}${parts.join(zh ? "、" : ", ")}${zh ? "）" : ")"}`;
}

/** `get_result` 的账本回落：进程里已经没有这个运行了，只能给出落盘的结论与证据。 */
function formatLedgerRunResult(
	record: LedgerRunRecord,
	lang: ServerLang,
	timeline: readonly LedgerEvent[] = [],
): string {
	const zh = lang === "zh";
	const id = shortId(record.runId);
	const lines: string[] = [
		zh
			? `运行 ${id}（${record.type}）已不在进程里；账本状态：${record.state}`
			: `Run ${id} (${record.type}) is no longer in process; ledger state: ${record.state}`,
	];
	if (record.title) lines.push(zh ? `目标：${record.title}` : `Goal: ${record.title}`);
	if (record.evidence)
		lines.push(zh ? `证据：${formatLedgerEvidence(record, lang)}` : `Evidence: ${formatLedgerEvidence(record, lang)}`);
	if (record.error) lines.push(zh ? `错误：${record.error}` : `Error: ${record.error}`);
	if (record.worktree) {
		const wt = record.worktree;
		lines.push(
			zh
				? `工作树：${wt.path}（分支 ${wt.branch}${wt.cleanedUp ? " · 已清理" : ""}）`
				: `Worktree: ${wt.path} (branch ${wt.branch}${wt.cleanedUp ? " · cleaned" : ""})`,
		);
	}
	if (record.sessionFile) {
		lines.push(
			zh
				? `会话记录：${record.sessionFile}（可在历史对话里打开回看）`
				: `Session file: ${record.sessionFile} (openable from History)`,
		);
	}
	if (record.outputTail) {
		lines.push(zh ? `最后输出（尾部）：\n${record.outputTail}` : `Last output (tail):\n${record.outputTail}`);
	}
	if (timeline.length > 0) {
		lines.push(zh ? `生命周期（最近 ${timeline.length} 条）：` : `Lifecycle (last ${timeline.length}):`);
		for (const event of timeline) {
			const at = new Date(event.ts);
			const when = Number.isFinite(at.getTime()) ? at.toISOString().slice(11, 19) : "--:--:--";
			lines.push(`- ${when} ${event.event}`);
		}
	}
	if (record.resumedBy) {
		lines.push(zh ? `已续跑为：${record.resumedBy}` : `Resumed as: ${record.resumedBy}`);
	} else if (record.state === "running" || record.state === "interrupted") {
		lines.push(
			zh
				? `继续：conversation(action="resume", runId="${record.runId}")（带已知进度重派；旧会话不落盘，接不上原转录）`
				: `Continue: conversation(action="resume", runId="${record.runId}") (relaunch with known progress; the old in-memory session cannot be reattached)`,
		);
	}
	return lines.join("\n");
}

function formatUsageTag(usage: SubagentSnapshot["usage"], lang: ServerLang): string {
	if (!usage) return "";
	const zh = lang === "zh";
	const short = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
	return zh
		? ` · ${short(usage.input)}↓${short(usage.output)}↑`
		: ` · ${short(usage.input)}in/${short(usage.output)}out`;
}

function promptRemaining(remaining: string[], lang: ServerLang = "en"): string {
	if (remaining.length === 0) return "";
	const pendingIds = remaining.map(shortId).join(", ");
	return pick(
		lang,
		`\n未完成：${pendingIds}。可再次调用 subagent（action="wait_all"）继续等待耗时任务，或使用 steer 补充指令 / stop 中止。`,
		`\nPending: ${pendingIds}. You may call conversation(action="wait_all") again to continue waiting for long tasks, or use steer to add instructions / stop to abort.`,
		"subagents.wait.pending",
		{ pendingIds: pendingIds },
	);
}
