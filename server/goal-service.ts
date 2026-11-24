import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	defineTool,
	ModelRuntime,
	SessionManager,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { GoalHistoryEntry, GoalStatus, PlanState, PlanStep, ServerMessage } from "./protocol.js";
import { promptSession } from "./session-turns.js";
import type { ClientStateStore } from "./client-state.js";
import { pick, type ServerLang } from "./i18n.js";
import { parseModelSpec } from "./attachments.js";
import type { MaterialBlob } from "./material.js";
import type { WebUIContext } from "./webui-context.js";
import {
	applyGoalMaterialBlobs,
	createGoalMaterialReporter,
	goalMaterialOverflowText,
	planGoalRoundMaterials,
	type GoalMaterialNotice,
} from "./goal-run-materials.js";
import {
	GOAL_EXEC_FAILED_ROUNDS_LIMIT,
	buildWizardConversationContext,
	extractErrorSnippetFromSession,
	goalRoundBudget,
	parseReviewerVerdict,
	parseWizardOutput,
	recordGoalHistory,
	resetGoalRoundCounters,
	sampleGoalRound,
	stripGoalDraftPrefix,
} from "./goal-run-rounds.js";
import {
	goalCardText,
	goalExecutorPrompt,
	goalFailureText,
	goalMaterialRefs,
	goalReviewerFeedback,
	goalReviewerPrompt,
	goalRoleTitle,
	goalScopePrompt,
	roundsSuffix,
	goalVerdictRetryPrompt,
} from "./goal-run-prompts.js";
import { goalStatusOfPrefs } from "../packages/keel/src/domains/goals/index.js";

/**
 * 目标记录：`GoalStatus`（快照 / 回显字段）+ 材料指针。
 *
 * 材料只存路径字符串（R1：禁 MaterialRef[] / 禁 JSON / 禁 base64）；
 * 老目标没有该字段 ≡ `[]`（R9），且为空时**不写字段**，
 * 让无材料的快速照与今天逐字节一致（R10）。
 */
export type GoalRecord = GoalStatus & { materials?: string[] };

export interface GoalConversation {
	id: string;
	title: string;
	cwd: string;
	session: AgentSession;
	wizardRunning: boolean;
	goalGeneration: number;
	goal: GoalRecord;
	stagnantRounds?: number;
	failedRounds?: number;
	execUsageBefore?: { input: number; output: number };
	reviewUsageBefore?: { input: number; output: number };
	goalUsage?: { input: number; output: number };
	goalHistory?: GoalHistoryEntry[];
	lastDiff?: string;
	lastErrorSnippet?: string;
	sameErrorRounds?: number;
	/** `cwd` 是执行对话建立时的工作区：与 goal 的 cwd 不同时材料必须先 stage（R7）。 */
	roleExec?: { convId: string; generation: number; cwd?: string };
	awaitingVerdict?: { round: number };
	deferredPrompts?: string[];
	promptInFlight?: boolean;
	preemptingMainRun?: boolean;
	preemptedGoalGen?: number;
}

export interface RoleAgentRead {
	text: string;
	errorSnippet?: string;
	streaming?: boolean;
	lastTool?: string;
	usage?: { input: number; output: number };
}

export type RoleWaitOutcome = "done" | "error" | "canceled" | "timeout" | "gone";

type DelegatedVerdict = { verdict: "pass" | "fail"; feedback: string } | "invalid" | "timeout" | "gone";

export interface GoalHost {
	clientId: string;
	agentDir: string;
	stateStore: ClientStateStore;
	webUi: WebUIContext;
	emit: (msg: ServerMessage) => void;
	flushSnapshot: () => void;
	isDisposed: () => boolean;
	quiesceBlocked: () => boolean;
	activeConvId: () => string;
	activeConv: () => GoalConversation;
	getConv: (id: string) => GoalConversation | undefined;
	cwd: () => string;
	gitDiff: (cwd: string) => Promise<string>;
	lang?: () => ServerLang;
	goalModeEnabled: () => boolean;
	getPlan?: (convId: string) => PlanState | null;
	describePlan?: (convId: string) => string;
	setPlan?: (convId: string, steps: PlanStep[]) => void;
	spawnRoleAgent?: (opts: {
		role: "executor" | "reviewer";
		prompt: string;
		cwd: string;
		model?: string | null;
		parentId?: string;
		title?: string;
	}) => Promise<string>;
	waitRoleAgent?: (convId: string, timeoutMs: number) => Promise<RoleWaitOutcome>;
	sendRoleAgent?: (convId: string, message: string, deliverAs?: "steer" | "followUp") => Promise<boolean>;
	readRoleAgent?: (convId: string) => RoleAgentRead | undefined;
	readRoleEvidence?: (convId: string) => string | undefined;
	stopRoleAgent?: (convId: string) => Promise<void>;
	interruptMainConv?: (convId: string) => Promise<void>;
	dismissRoleAgent?: (convId: string) => Promise<void>;
	hasConv?: (convId: string) => boolean;
	isGitRepo?: (cwd: string) => Promise<boolean>;
	roleDeadlineMs?: () => number;
}

/**
 * 纯逻辑已搬到两个叶子（这里是**旧入口的同名再导出**，同一个函数，不是第二套实现）：
 * - `goal-run-rounds.ts`：一轮的量与判定（git 指纹 / 错误片段 / verdict 解析 / 调研输出解析）；
 * - `goal-run-prompts.ts`：prompt 与回执文案（执行 / 审查 / 调研 / 重试 / 受阻原因）。
 * 宿主适配器 `core-goal-run-adapter.ts` 与本文件引用的是同一份。
 */
export {
	stripGoalDraftPrefix,
	buildWizardConversationContext,
	parseReviewerVerdict,
	buildDiffFingerprint,
	GIT_DIFF_CAP,
	extractErrorSnippetFromSession,
	lastToolNameOfSession,
	parseWizardOutput,
} from "./goal-run-rounds.js";
export {
	withMaterialBlock,
	goalMaterialRefs,
	composeGoalMaterials,
	goalExecutorPrompt,
	goalReviewerPrompt,
	type GoalMaterialsComposition,
} from "./goal-run-prompts.js";

export class GoalService {
	private prefs = {
		reviewModel: null as string | null,
		maxRounds: 0,
		locked: true,
		execModel: null as string | null,
	};
	private wizardAbort: AbortController | null = null;
	private wizardSession: AgentSession | null = null;
	private wizardOwnerId: string | null = null;
	private wizardCancelled = false;
	private verdictWaiters = new Map<string, (v: DelegatedVerdict) => void>();
	private verdictSignals = new Map<string, Set<() => void>>();
	private delegatedLoops = new Map<string, Promise<void>>();
	private delegatedPending = new Map<string, { goalGeneration: number; goalText: string }>();
	/** 已告知过用户的材料账（避免每轮刷屏）；同一份账只报一次（报送口径在 `goal-run-materials`）。 */
	private readonly reportMaterialNotice = createGoalMaterialReporter((msg) => this.host.emit(msg));
	private static readonly WIZARD_IDLE_TIMEOUT_MS = 5 * 60_000;
	private static readonly WIZARD_MAX_TOTAL_MS = 20 * 60_000;

	constructor(private readonly host: GoalHost) {
		const gPrefs = host.stateStore.getGoalPrefs(host.clientId);
		if (gPrefs) {
			this.prefs = {
				reviewModel: gPrefs.reviewModel,
				maxRounds: gPrefs.maxRounds,
				locked: gPrefs.locked,
				execModel: gPrefs.execModel ?? null,
			};
		}
	}

	private lang(): ServerLang {
		return this.host.lang?.() ?? "en";
	}

	private goalEnabled(): boolean {
		return this.host.goalModeEnabled();
	}

	makeGoalStatus(): GoalStatus {
		return goalStatusOfPrefs(this.prefs);
	}

	emitGoalStatus(): void {
		const conv = this.host.activeConv();
		const goal = conv.goal;
		if (conv.goalUsage) {
			goal.usage = { inputTokens: conv.goalUsage.input, outputTokens: conv.goalUsage.output };
		} else {
			goal.usage = undefined;
		}
		goal.history = conv.goalHistory && conv.goalHistory.length > 0 ? [...conv.goalHistory] : undefined;
		if (!goal.goal && !goal.reviewing && !goal.wizard.active) {
			goal.reviewModel = this.prefs.reviewModel;
			goal.maxRounds = this.prefs.maxRounds;
			goal.locked = this.prefs.locked;
			goal.execModel = this.prefs.execModel;
		}
		this.host.emit({ type: "goal_status", status: { ...goal } });
	}

	async setGoal(
		goalText: string,
		opts?: {
			reviewModel?: string;
			maxRounds?: number;
			locked?: boolean;
			execModel?: string;
			targetConvId?: string;
			autoStart?: boolean;
			/** 材料指针（工作区相对 / 绝对路径 / URI）；只存字符串（R1） */
			materials?: string[];
			materialBlobs?: MaterialBlob[];
		},
	): Promise<void> {
		await this.commitGoal(goalText, opts);
	}

	private async commitGoal(
		goalText: string,
		opts?: NonNullable<Parameters<GoalService["setGoal"]>[1]>,
	): Promise<{ conv: GoalConversation; generation: number } | undefined> {
		const text = (goalText ?? "").trim();
		if (!text) {
			await this.clearGoal(opts?.targetConvId);
			return;
		}
		if (!this.goalEnabled()) {
			this.host.emit({
				type: "notice",
				level: "warning",
				text: "目标模式已关闭：请先在设置「目标审查」中启用目标模式。",
				textEn: "Goal mode is off: enable it under Settings → Goal review first.",
			});
			return;
		}
		if (this.host.quiesceBlocked()) return;
		if (!this.roleBridgeReady()) {
			this.host.emit({
				type: "notice",
				level: "warning",
				text: "目标模式需要支持「执行对话」的引擎（当前引擎不支持，目标未设置）。",
				textEn:
					"Goal mode requires an engine that supports executor conversations (unsupported here; the goal was not set).",
			});
			return;
		}
		const targetConv = opts?.targetConvId ? this.host.getConv(opts.targetConvId) : undefined;
		if (opts?.targetConvId && !targetConv) {
			this.host.emit({
				type: "notice",
				level: "warning",
				text: `目标未设置：发起目标调研的对话已关闭。`,
				textEn: `Goal not set: the conversation that started the survey is gone.`,
			});
			return;
		}
		const conv = targetConv ?? this.host.activeConv();
		const goalConversationId = conv.id;
		const gen = ++conv.goalGeneration;
		await this.stopDelegated(conv);
		if (!this.isCurrentGoalRequest(conv, gen)) return;
		const goal = conv.goal;
		goal.reviewing = false;
		goal.conversationId = goalConversationId;
		goal.goal = text;
		goal.materials = await this.applyMaterialBlobs(conv, goalMaterialRefs(opts?.materials), opts?.materialBlobs);
		if (opts?.reviewModel !== undefined) goal.reviewModel = opts.reviewModel || null;
		if (typeof opts?.maxRounds === "number") {
			const mr = Math.round(opts.maxRounds);
			goal.maxRounds = mr >= 1 ? Math.min(mr, 50) : 0;
		}
		if (opts?.locked !== undefined) goal.locked = opts.locked;
		if (opts?.execModel !== undefined) goal.execModel = opts.execModel || null;
		this.prefs = {
			reviewModel: goal.reviewModel,
			maxRounds: goal.maxRounds,
			locked: goal.locked,
			execModel: goal.execModel ?? null,
		};
		this.host.stateStore.saveGoalPrefs(this.host.clientId, {
			reviewModel: goal.reviewModel,
			maxRounds: goal.maxRounds,
			locked: goal.locked,
			execModel: this.prefs.execModel,
		});
		this.resetLoopCounters(conv);
		conv.awaitingVerdict = undefined;
		goal.round = 0;
		goal.reviewing = false;
		goal.verdict = "pending";
		goal.feedback = undefined;
		goal.phase = "idle";
		goal.roles = {};
		goal.wizard.active = false;
		goal.wizard.status = "";
		goal.wizard.statusEn = "";
		goal.status = "目标已设，等待生成…";
		goal.statusEn = "Goal set, waiting to generate…";
		this.emitGoalStatus();
		this.host.emit({
			type: "notice",
			level: "info",
			text: `🎯 已设目标：${text.slice(0, 80)}${text.length > 80 ? "…" : ""}`,
			textEn: `🎯 Goal set: ${text.slice(0, 80)}${text.length > 80 ? "…" : ""}`,
		});
		if (opts?.autoStart !== false) {
			await this.preemptMainRunForGoal(conv, gen);
			if (!this.isCurrentDelegated(conv, gen)) return;
			this.startDelegatedLoop(conv, gen, text);
			this.host.flushSnapshot();
		}
		return { conv, generation: gen };
	}

	async startGoalWizard(
		text: string,
		opts?: {
			wizardModel?: string;
			maxRounds?: number;
			locked?: boolean;
			materials?: string[];
			materialBlobs?: MaterialBlob[];
		},
		target?: GoalConversation,
	): Promise<void> {
		if (this.host.quiesceBlocked()) return;
		if (!this.goalEnabled()) {
			this.host.emit({
				type: "notice",
				level: "warning",
				text: "目标模式已关闭：请先在设置「目标审查」中启用目标模式。",
				textEn: "Goal mode is off: enable it under Settings → Goal review first.",
			});
			return;
		}
		const draft = stripGoalDraftPrefix(text);
		if (!draft) return;

		const wizardConversation = target ?? this.host.activeConv();
		if (this.host.getConv(wizardConversation.id) !== wizardConversation) return;
		const wizardConversationId = wizardConversation.id;
		const wizardGeneration = wizardConversation.goalGeneration;
		const wizardConversationTitle = wizardConversation.title;
		if (wizardConversation.wizardRunning || this.wizardOwnerId !== null) {
			this.host.emit({
				type: "notice",
				level: "warning",
				text: "已有目标调研进行中，请等它完成…",
				textEn: "A goal survey is already running — wait for it to finish…",
			});
			return;
		}
		if (wizardConversation.goal.reviewing) {
			this.host.emit({
				type: "notice",
				level: "warning",
				text: "正在审查中，无法开始目标调研，请稍等…",
				textEn: "A review is running; cannot start a goal survey yet…",
			});
			return;
		}

		const maxSteps = 20;
		wizardConversation.wizardRunning = true;
		this.wizardOwnerId = wizardConversationId;
		this.wizardCancelled = false;
		this.wizardAbort = new AbortController();
		this.wizardSession = null;
		const wgoal = wizardConversation.goal;
		// 材料在**提炼阶段**就参与（wizard 是普通会话，能看到图 / 文档）：
		// 先落到规格里，让向导与后续执行用同一份清单（R1：只存路径）。
		wgoal.materials = await this.applyMaterialBlobs(
			wizardConversation,
			goalMaterialRefs(opts?.materials),
			opts?.materialBlobs,
		);
		wgoal.wizard.active = true;
		wgoal.wizard.draft = draft;
		wgoal.wizard.model = opts?.wizardModel ?? null;
		// Remember the model choice (and persist rounds/lock) — global memory.
		if (opts?.wizardModel !== undefined && opts.wizardModel !== null) wgoal.reviewModel = opts.wizardModel || null;
		if (typeof opts?.maxRounds === "number") {
			const mr = Math.round(opts.maxRounds);
			wgoal.maxRounds = mr >= 1 ? Math.min(mr, 50) : 0;
		}
		if (opts?.locked !== undefined) wgoal.locked = opts.locked;
		this.prefs = {
			reviewModel: wgoal.reviewModel,
			maxRounds: wgoal.maxRounds,
			locked: wgoal.locked,
			execModel: wgoal.execModel ?? null,
		};
		this.host.stateStore.saveGoalPrefs(this.host.clientId, {
			reviewModel: wgoal.reviewModel,
			maxRounds: wgoal.maxRounds,
			locked: wgoal.locked,
			execModel: wgoal.execModel ?? null,
		});
		wgoal.wizard.step = 0;
		wgoal.wizard.maxSteps = maxSteps;
		wgoal.wizard.status = "调研中…";
		wgoal.wizard.statusEn = "Scoping…";
		wgoal.status = "目标调研中…";
		wgoal.statusEn = "Scoping the goal…";
		this.emitGoalStatus();
		const ac = this.wizardAbort;
		let idleTimer: ReturnType<typeof setTimeout> | null = null;
		const armIdle = () => {
			if (idleTimer) clearTimeout(idleTimer);
			idleTimer = setTimeout(() => {
				if (!ac.signal.aborted) {
					this.wizardCancelled = true;
					ac.abort(
						new Error(
							pick(
								this.lang(),
								"目标调研超时（等待回答过久）",
								"Goal survey timed out (waited too long for an answer)",
								"goal.wizard.idle.timeout",
							),
						),
					);
				}
			}, GoalService.WIZARD_IDLE_TIMEOUT_MS);
			idleTimer.unref?.();
		};
		const clearIdle = () => {
			if (idleTimer) {
				clearTimeout(idleTimer);
				idleTimer = null;
			}
		};
		const totalTimer = setTimeout(() => {
			if (!ac.signal.aborted) {
				this.wizardCancelled = true;
				ac.abort(
					new Error(
						pick(
							this.lang(),
							"目标调研超过总时长上限",
							"Goal survey exceeded the total time limit",
							"goal.wizard.total.timeout",
						),
					),
				);
			}
		}, GoalService.WIZARD_MAX_TOTAL_MS);
		totalTimer.unref?.();
		this.host.emit({
			type: "notice",
			level: "info",
			text: `🔍 正在围绕需求展开调研：${draft.slice(0, 60)}${draft.length > 60 ? "…" : ""}`,
			textEn: `🔍 Surveying the requirement: ${draft.slice(0, 60)}${draft.length > 60 ? "…" : ""}`,
		});

		const mainSession = wizardConversation.session;
		await this.pushWizardCard(
			mainSession,
			pick(this.lang(), `🎯 原始目标草案：${draft}`, `🎯 Initial goal draft: ${draft}`, "goal.wizard.draft.card", {
				draft,
			}),
			{ draft },
		);

		let refinedGoal = "";
		let parsedSteps: PlanStep[] = [];
		let goalEphemeralDir: string | undefined;
		let srvSession: AgentSession | undefined;
		try {
			const wmSpec = opts?.wizardModel ? parseModelSpec(opts.wizardModel) : null;
			const services = await createAgentSessionServices({
				cwd: wizardConversation.cwd,
				agentDir: this.host.agentDir,
				resourceLoaderOptions: {
					skillsOverride: (res) => ({ ...res, skills: [] }),
				},
				modelRuntime: await ModelRuntime.create({
					authPath: join(this.host.agentDir, "auth.json"),
					modelsPath: join(this.host.agentDir, "models.json"),
				}),
			});

			let model;
			if (wmSpec) model = services.modelRuntime.getModel(wmSpec.provider, wmSpec.id);
			if (!model) {
				const mainModel = mainSession.model as
					| {
							provider?: string;
							id?: string;
					  }
					| undefined;
				if (mainModel?.provider && mainModel.id)
					model = services.modelRuntime.getModel(mainModel.provider, mainModel.id);
			}

			let qStep = 0;
			const goalAsk = defineTool({
				name: "goal_ask",
				label: "Ask the user",
				description:
					"Ask the user ONE focused question at a time to scope down the goal. " +
					"Provide 2-4 mutually exclusive options with the recommended option first, " +
					"briefly noting its impact or tradeoff; or ask an open question. Returns the user's chosen answer.",
				parameters: Type.Object({
					question: Type.String({ description: "The question to ask" }),
					options: Type.Optional(
						Type.Array(Type.String(), {
							description: "2-4 mutually exclusive options (recommended option first)",
						}),
					),
				}),
				executionMode: "sequential",
				execute: async (_id, params, _sig, _onUpdate, ctx) => {
					const lang = this.lang();
					qStep += 1;
					if (qStep > maxSteps) {
						return {
							content: [
								{
									type: "text",
									text: pick(
										lang,
										"(达到最大提问数，请直接给出收敛后的目标文本作为最终答案)",
										"(Max questions reached — stop asking and reply with the converged goal text as your final answer)",
										"goal.wizard.max.questions",
									),
								},
							],
							details: {},
						};
					}
					wgoal.wizard.step = qStep;
					wgoal.wizard.status = `调研中：请回答第 ${qStep} 题`;
					wgoal.wizard.statusEn = `Scoping: please answer question ${qStep}`;
					this.emitGoalStatus();
					try {
						armIdle();
						const isChoice = !!(params.options && params.options.length > 0);
						const qTitle = pick(
							lang,
							`🔍 第 ${qStep} 题：${params.question}`,
							`🔍 Question ${qStep}: ${params.question}`,
							"goal.wizard.question.title",
							{ qStep: qStep, "params.question": params.question },
						);
						const optionsJoined = isChoice ? params.options!.join(" / ") : "";
						const choiceSuffixZh = isChoice ? `【${optionsJoined}】` : "";
						const choiceSuffixEn = isChoice ? ` [${optionsJoined}]` : "";
						await this.pushWizardCard(
							mainSession,
							pick(
								lang,
								`🔍 第 ${qStep} 题：${params.question}${choiceSuffixZh}`,
								`🔍 Question ${qStep}: ${params.question}${choiceSuffixEn}`,
								"goal.wizard.question.card",
								{
									qStep: qStep,
									"params.question": params.question,
									choiceSuffixZh: choiceSuffixZh,
									choiceSuffixEn: choiceSuffixEn,
								},
							),
							{ question: params.question },
						);
						let aborted = false;
						const onAbort = () => {
							aborted = true;
						};
						ac.signal.addEventListener("abort", onAbort, { once: true });
						let ans: string | boolean | undefined;
						try {
							const choose = isChoice ? ctx.ui.select(qTitle, params.options!) : ctx.ui.input(qTitle);
							ans = (await choose) as string | boolean | undefined;
						} finally {
							ac.signal.removeEventListener("abort", onAbort);
							clearIdle();
						}
						if (aborted || ac.signal.aborted) {
							return {
								content: [
									{
										type: "text",
										text: pick(
											lang,
											"(调研已取消，请不要继续提问，直接结束对话)",
											"(The survey was cancelled — stop asking and end the conversation)",
											"goal.wizard.cancelled.stop",
										),
									},
								],
								details: {},
							};
						}
						if (ans === undefined || ans === null || ans === false || ans === "") {
							return {
								content: [
									{
										type: "text",
										text: pick(
											lang,
											"(用户已取消调研，请直接给出你当前收敛的目标文本作为最终答案)",
											"(The user cancelled the survey — reply with your best-effort goal text as the final answer)",
											"goal.wizard.cancelled.best",
										),
									},
								],
								details: {},
							};
						}
						await this.pushWizardCard(
							mainSession,
							pick(lang, `↳ 您的回答：${ans}`, `↳ Your answer: ${ans}`, "goal.wizard.answer.card", { ans: ans }),
							{
								question: params.question,
								answer: String(ans),
							},
						);
						return {
							content: [
								{
									type: "text",
									text: pick(lang, `用户回答：${ans}`, `User answer: ${ans}`, "goal.wizard.answer.return", {
										ans: ans,
									}),
								},
							],
							details: {},
						};
					} catch (err) {
						const errMsg = (err as Error).message;
						return {
							content: [
								{
									type: "text",
									text: ac.signal.aborted
										? pick(
												lang,
												"(调研已取消，请不要继续提问，直接结束对话)",
												"(The survey was cancelled — stop asking and end the conversation)",
												"goal.wizard.cancelled.aborted",
											)
										: pick(lang, `提问失败：${errMsg}`, `Failed to ask: ${errMsg}`, "goal.wizard.ask.failed", {
												errMsg: errMsg,
											}),
								},
							],
							details: {},
						};
					}
				},
			});

			const sm = SessionManager.inMemory(this.host.cwd());
			goalEphemeralDir = join(services.agentDir, "goal-sessions", `wizard-${Date.now()}`);
			try {
				mkdirSync(goalEphemeralDir, { recursive: true });
				(sm as unknown as { sessionDir: string }).sessionDir = goalEphemeralDir;
			} catch {}

			const srv = await createAgentSessionFromServices({
				services,
				sessionManager: sm,
				customTools: [goalAsk],
				tools: ["goal_ask", "read", "ls", "find", "grep"],
				...(model ? { model } : {}),
			});
			srvSession = srv.session;
			const wizard = srv.session;
			this.wizardSession = wizard;
			await wizard.bindExtensions({
				mode: "rpc",
				// 向导 widget 属于发起它的那个对话：打上固定归属，用户中途切到别的对话也不会混过去
				uiContext: this.host.webUi.forConversation(wizardConversationId),
			});

			const unsubscribe = wizard.subscribe((event) => {
				if (event.type === "tool_execution_start" && event.toolName !== "goal_ask") {
					const argHint =
						typeof event.args === "object" && event.args !== null
							? String(
									(event.args as Record<string, unknown>).path ||
										(event.args as Record<string, unknown>).file_path ||
										(event.args as Record<string, unknown>).pattern ||
										(event.args as Record<string, unknown>).query ||
										"",
								).slice(0, 30)
							: "";
					const toolLabelZh =
						event.toolName === "read"
							? "正在查阅文件"
							: event.toolName === "grep"
								? "正在检索内容"
								: event.toolName === "find"
									? "正在查找文件"
									: event.toolName === "ls"
										? "正在浏览目录"
										: "正在查阅上下文";
					wgoal.wizard.status = `调研中：${toolLabelZh}${argHint ? ` ${argHint}` : "…"}`;
					wgoal.wizard.statusEn = `Scoping: checking ${event.toolName}${argHint ? ` ${argHint}` : "…"}`;
					this.emitGoalStatus();
				}
			});

			if (!model) {
				if (wmSpec) model = services.modelRuntime.getModel(wmSpec.provider, wmSpec.id);
				if (!model) {
					const mainModel = mainSession.model as { provider?: string; id?: string } | undefined;
					if (mainModel?.provider && mainModel.id) {
						model = services.modelRuntime.getModel(mainModel.provider, mainModel.id);
					}
				}
				if (model) {
					try {
						await wizard.setModel(model);
					} catch {}
				}
			}
			if (!ac.signal.aborted) {
				ac.signal.addEventListener(
					"abort",
					() => {
						void wizard.abort().catch(() => {});
						this.host.webUi.cancelPendingDialogs();
					},
					{ once: true },
				);
			}

			const mainMessages =
				(
					mainSession as unknown as { sessionManager?: { buildSessionContext?: () => { messages?: unknown[] } } }
				).sessionManager?.buildSessionContext?.()?.messages ??
				(mainSession as unknown as { messages?: unknown[] }).messages ??
				[];
			const contextSummary = buildWizardConversationContext(mainMessages);
			// 清单拼进 wizard 输入文本（R3/R5：形式由 planMaterialDelivery 决定，文案由 describeMaterials 产出）。
			const wizardMaterials = await this.planRoundMaterials(wizardConversation, wizardConversation.cwd);

			try {
				await wizard.prompt([goalScopePrompt({ draft, contextSummary }), wizardMaterials].filter(Boolean).join("\n\n"));
			} finally {
				unsubscribe();
			}
			const rawAssistantText = wizard.getLastAssistantText()?.trim() ?? "";
			const parsed = parseWizardOutput(rawAssistantText);
			refinedGoal = parsed.goal;
			parsedSteps = parsed.steps;
		} catch (err) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: `目标调研失败：${(err as Error).message}`,
				textEn: `Goal survey failed: ${(err as Error).message}`,
			});
		} finally {
			clearIdle();
			clearTimeout(totalTimer);
			wizardConversation.wizardRunning = false;
			if (this.wizardOwnerId === wizardConversationId) this.wizardOwnerId = null;
			wgoal.wizard.active = false;
			wgoal.wizard.step = 0;
			wgoal.wizard.status = "";
			wgoal.wizard.statusEn = "";
			this.wizardSession = null;
			this.wizardAbort = null;
			if (srvSession) {
				try {
					await srvSession.dispose();
				} catch {}
			}
			if (goalEphemeralDir) {
				try {
					rmSync(goalEphemeralDir, { recursive: true, force: true });
				} catch {}
			}
			this.emitGoalStatus();
		}

		if (ac.signal.aborted || this.wizardCancelled) {
			this.host.emit({
				type: "notice",
				level: "info",
				text:
					`目标调研已取消${ac.signal.reason ? `：${String((ac.signal.reason as Error)?.message ?? ac.signal.reason)}` : ""}` +
					`。原始目标草案已保留在会话「${wizardConversationTitle}」的消息流中，可复制后重新发起。`,
				textEn:
					`Goal survey cancelled${ac.signal.reason ? `: ${String((ac.signal.reason as Error)?.message ?? ac.signal.reason)}` : ""}` +
					`. The initial goal draft is preserved in the conversation "${wizardConversationTitle}" — copy it and start over.`,
			});
			return;
		}
		if (!refinedGoal.trim()) {
			this.host.emit({
				type: "notice",
				level: "warning",
				text: `调研未产出有效目标，请重试（原始目标草案在会话「${wizardConversationTitle}」的消息流中）`,
				textEn: `The survey produced no usable goal — retry (the initial draft is in the conversation "${wizardConversationTitle}")`,
			});
			return;
		}
		const targetConv = this.host.getConv(wizardConversationId);
		if (!targetConv) {
			this.host.emit({
				type: "notice",
				level: "warning",
				text: `目标调研完成，但发起会话「${wizardConversationTitle}」已关闭，结果未应用（可在新会话里重新发起）。`,
				textEn: `The survey finished, but the conversation that started it ("${wizardConversationTitle}") is gone — the result was not applied. Start a new survey.`,
			});
			return;
		}
		if (targetConv !== wizardConversation || !this.isCurrentGoalRequest(wizardConversation, wizardGeneration)) {
			return;
		}
		const switchedAway = this.host.activeConvId() !== wizardConversationId;
		const wantLocked = opts?.locked === undefined ? true : opts.locked;
		const committed = await this.commitGoal(refinedGoal, {
			reviewModel: wgoal.reviewModel ?? undefined,
			maxRounds: opts?.maxRounds,
			locked: wantLocked,
			execModel: wgoal.execModel ?? undefined,
			materials: wgoal.materials,
			targetConvId: wizardConversationId,
			autoStart: false,
		});
		if (!committed || !this.isCurrentDelegated(committed.conv, committed.generation)) return;
		if (parsedSteps.length > 0) {
			this.host.setPlan?.(wizardConversationId, parsedSteps);
		}
		if (!this.isCurrentDelegated(committed.conv, committed.generation)) return;
		await this.preemptMainRunForGoal(committed.conv, committed.generation);
		if (!this.isCurrentDelegated(committed.conv, committed.generation)) return;
		this.startDelegatedLoop(committed.conv, committed.generation, refinedGoal);
		this.host.flushSnapshot();
		this.wizardCancelled = false;
		this.host.emit({
			type: "notice",
			level: "info",
			text: switchedAway
				? `🎯 会话「${wizardConversationTitle}」目标调研完成，目标已设为：${refinedGoal.slice(0, 80)}${refinedGoal.length > 80 ? "…" : ""}（已切回该会话开始生成）`
				: `🎯 调研完成，目标已设为：${refinedGoal.slice(0, 80)}${refinedGoal.length > 80 ? "…" : ""}`,
			textEn: switchedAway
				? `🎯 Survey done in "${wizardConversationTitle}", goal set: ${refinedGoal.slice(0, 80)}${refinedGoal.length > 80 ? "…" : ""} (switch back to that conversation to watch it generate)`
				: `🎯 Survey done, goal set: ${refinedGoal.slice(0, 80)}${refinedGoal.length > 80 ? "…" : ""}`,
		});
	}

	async setGoalPrefs(
		opts?: {
			reviewModel?: string;
			maxRounds?: number;
			locked?: boolean;
			execModel?: string;
		},
		target?: GoalConversation,
	): Promise<void> {
		if (!this.goalEnabled()) return;
		const conv = target ?? this.host.activeConv();
		if (this.host.getConv(conv.id) !== conv) return;
		const goal = conv.goal;
		if (opts?.reviewModel !== undefined) goal.reviewModel = opts?.reviewModel || null;
		if (typeof opts?.maxRounds === "number") {
			const mr = Math.round(opts.maxRounds);
			goal.maxRounds = mr >= 1 ? Math.min(mr, 50) : 0;
		}
		if (opts?.locked !== undefined) goal.locked = opts.locked;
		const hasExecOpt = opts?.execModel !== undefined;
		if (goal.goal && hasExecOpt) {
			this.host.emit({
				type: "notice",
				level: "info",
				text: "执行模型将在下一个目标生效（当前目标继续用启动时的模型跑完）。",
				textEn: "The executor model applies to the next goal (the current one keeps the model it started with).",
			});
		} else if (hasExecOpt) {
			goal.execModel = opts?.execModel || null;
		}
		this.prefs = {
			reviewModel: goal.reviewModel,
			maxRounds: goal.maxRounds,
			locked: goal.locked,
			execModel: hasExecOpt ? opts?.execModel || null : this.prefs.execModel,
		};
		this.host.stateStore.saveGoalPrefs(this.host.clientId, {
			reviewModel: goal.reviewModel,
			maxRounds: goal.maxRounds,
			locked: goal.locked,
			execModel: this.prefs.execModel,
		});
		this.emitGoalStatus();
	}

	async clearGoal(target?: GoalConversation | string): Promise<void> {
		const conv = typeof target === "string" ? this.host.getConv(target) : (target ?? this.host.activeConv());
		if (!conv || this.host.isDisposed() || this.host.getConv(conv.id) !== conv) return;
		const gen = ++conv.goalGeneration;
		await this.stopDelegated(conv);
		if (!this.isCurrentGoalRequest(conv, gen)) return;
		this.resetLoopCounters(conv);
		this.clearGoalFields(conv);
		this.emitGoalStatus();
		if (this.wizardOwnerId === conv.id) {
			await this.abortWizard();
		}
	}

	private async abortWizard(): Promise<boolean> {
		if (this.wizardOwnerId === null) return false;
		this.wizardCancelled = true;
		this.host.webUi.cancelPendingDialogs();
		this.wizardAbort?.abort();
		const ws2 = this.wizardSession;
		this.wizardSession = null;
		if (ws2) {
			await ws2.abort().catch(() => {});
			ws2.dispose();
		}
		this.wizardAbort = null;
		return true;
	}

	async stopAllGoals(): Promise<void> {
		let stopped = 0;
		for (const convId of Array.from(this.delegatedLoops.keys())) {
			const conv = this.host.getConv(convId);
			if (!conv) continue;
			const gen = ++conv.goalGeneration;
			await this.stopDelegated(conv);
			if (!this.isCurrentGoalRequest(conv, gen)) continue;
			this.resetLoopCounters(conv);
			this.clearGoalFields(conv);
			stopped++;
		}
		const wizardAborted = await this.abortWizard();
		if (stopped > 0 || wizardAborted) {
			this.emitGoalStatus();
			this.host.emit({
				type: "notice",
				level: "warning",
				text: "目标模式已关闭，在飞的目标/调研已停止（执行对话已移出左栏）。",
				textEn: "Goal mode is off; running goals/surveys were stopped (executor conversations removed).",
			});
			this.host.flushSnapshot();
		}
	}

	onAgentEnd(conv: GoalConversation, aborted: boolean): { text: string; textEn: string } | null {
		const g = conv.goal;
		if (aborted) {
			if (conv.preemptingMainRun) {
				conv.preemptingMainRun = false;
				return null;
			}
			if (g.goal && g.conversationId === conv.id) {
				if (conv.awaitingVerdict) {
					const settle = this.verdictWaiters.get(conv.id);
					this.verdictWaiters.delete(conv.id);
					conv.awaitingVerdict = undefined;
					settle?.("invalid");
					this.emitGoalStatus();
					return {
						text: "⏹ 审查回合已中止（目标保留，将重新审查这一轮）",
						textEn: "⏹ Review round aborted (the goal is kept and this round will be reviewed again)",
					};
				}
				conv.goalGeneration += 1;
				this.stopDelegated(conv);
				this.resetLoopCounters(conv);
				g.conversationId = null;
				g.goal = null;
				g.reviewing = false;
				g.verdict = "pending";
				g.feedback = undefined;
				g.phase = "idle";
				g.status = "已手动停止，目标审查已中止";
				g.statusEn = "Stopped manually, goal review aborted";
				this.emitGoalStatus();
				return {
					text: "⏹ 已手动停止，目标审查已中止（想继续可重新设定目标）",
					textEn: "⏹ Stopped manually, goal review aborted (set a new goal to continue)",
				};
			}
			return null;
		}
		if (g.goal && g.conversationId === conv.id && conv.awaitingVerdict) {
			this.deliverDelegatedVerdict(conv);
		}
		return null;
	}

	private async pushWizardCard(
		sess: AgentSession,
		text: string,
		details?: { question?: string; answer?: string; draft?: string },
	): Promise<void> {
		try {
			await sess.sendCustomMessage({
				customType: "goal-wizard",
				content: [{ type: "text", text }],
				display: true,
				details: { type: "goal-wizard", ...details },
			});
		} catch {}
	}

	private roleBridgeReady(): boolean {
		const h = this.host;
		return !!(h.spawnRoleAgent && h.waitRoleAgent && h.sendRoleAgent && h.readRoleAgent && h.hasConv);
	}

	private roleDeadline(): number {
		const v = this.host.roleDeadlineMs?.();
		return typeof v === "number" && v > 0 ? v : 20 * 60_000;
	}

	private isCurrentGoalRequest(conv: GoalConversation, goalGeneration: number): boolean {
		return !this.host.isDisposed() && this.host.getConv(conv.id) === conv && conv.goalGeneration === goalGeneration;
	}

	private isCurrentDelegated(conv: GoalConversation, goalGeneration: number): boolean {
		return this.isCurrentGoalRequest(conv, goalGeneration) && conv.goal.conversationId === conv.id && !!conv.goal.goal;
	}

	private isConvStreaming(conv: GoalConversation): boolean {
		try {
			if (conv.promptInFlight) return true;
			if (conv.session?.isStreaming === true) return true;
			if (typeof (conv.session as { isIdle?: unknown } | undefined)?.isIdle === "boolean" && !conv.session.isIdle) {
				return true;
			}
			return false;
		} catch {
			return false;
		}
	}

	private async preemptMainRunForGoal(conv: GoalConversation, goalGeneration: number): Promise<void> {
		if (!this.isCurrentDelegated(conv, goalGeneration)) return;
		if (!this.isConvStreaming(conv)) return;
		if (conv.preemptedGoalGen === goalGeneration) return;
		conv.preemptedGoalGen = goalGeneration;
		conv.preemptingMainRun = true;
		try {
			if (this.host.interruptMainConv) {
				await this.host.interruptMainConv(conv.id);
			} else {
				await this.host.stopRoleAgent?.(conv.id);
			}
		} catch {
		} finally {
			conv.preemptingMainRun = false;
		}
		if (!this.isCurrentDelegated(conv, goalGeneration)) return;
		this.host.emit({
			type: "notice",
			level: "info",
			text: "🎯 目标已设：主对话当前的运行已停止，接下来由目标执行者接手",
			textEn: "🎯 Goal set: stopped the main conversation's current run so the goal executor can take over",
		});
	}

	private startDelegatedLoop(conv: GoalConversation, goalGeneration: number, goalText: string): void {
		if (!this.isCurrentDelegated(conv, goalGeneration)) return;
		if (this.delegatedLoops.has(conv.id)) {
			this.delegatedPending.set(conv.id, { goalGeneration, goalText });
			return;
		}
		const convId = conv.id;
		const loop = this.runDelegatedLoop(conv, goalGeneration, goalText)
			.catch((err) => {
				void this.finishDelegated(
					conv,
					goalGeneration,
					"blocked",
					conv.goal.round,
					`循环内部错误：${err instanceof Error ? err.message : String(err)}`,
					goalText,
				);
			})
			.finally(() => {
				if (this.delegatedLoops.get(convId) === loop) this.delegatedLoops.delete(convId);
				const pending = this.delegatedPending.get(convId);
				if (pending) {
					this.delegatedPending.delete(convId);
					const target = this.host.getConv(convId);
					if (target) this.startDelegatedLoop(target, pending.goalGeneration, pending.goalText);
				}
			});
		this.delegatedLoops.set(conv.id, loop);
	}

	whenAwaitingVerdict(convId: string, timeoutMs = 5000): Promise<boolean> {
		if (this.verdictWaiters.has(convId)) return Promise.resolve(true);
		return new Promise<boolean>((resolve) => {
			const set = this.verdictSignals.get(convId) ?? new Set<() => void>();
			this.verdictSignals.set(convId, set);
			let done = false;
			const fire = (): void => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				set.delete(fire);
				if (set.size === 0) this.verdictSignals.delete(convId);
				resolve(true);
			};
			const timer = setTimeout(() => {
				if (done) return;
				done = true;
				set.delete(fire);
				if (set.size === 0) this.verdictSignals.delete(convId);
				resolve(false);
			}, timeoutMs);
			timer.unref?.();
			set.add(fire);
		});
	}

	async whenDelegatedSettled(convId: string): Promise<void> {
		const loop = this.delegatedLoops.get(convId);
		if (loop) await loop.catch(() => {});
	}

	private signalAwaitingVerdict(convId: string): void {
		const set = this.verdictSignals.get(convId);
		if (!set) return;
		for (const fn of set) fn();
	}

	private resetLoopCounters(conv: GoalConversation): void {
		resetGoalRoundCounters(conv);
	}

	private clearGoalFields(conv: GoalConversation): void {
		const goal = conv.goal;
		goal.reviewing = false;
		goal.conversationId = null;
		goal.goal = null;
		goal.materials = undefined;
		goal.verdict = "pending";
		goal.feedback = undefined;
		goal.status = "";
		goal.statusEn = "";
		goal.phase = "idle";
		goal.roles = {};
		goal.wizard.active = false;
		goal.wizard.status = "";
		goal.wizard.statusEn = "";
		this.reportMaterialNotice(conv.id, null);
	}

	private roundBudget(goal: GoalStatus): number {
		return goalRoundBudget(goal);
	}

	private detachRoleExec(conv: GoalConversation): string | undefined {
		const exec = conv.roleExec;
		conv.roleExec = undefined;
		conv.goal.roles = {};
		return exec?.convId;
	}

	private stopInflight = new Map<string, Promise<void>>();

	private stopDelegated(conv: GoalConversation): Promise<void> {
		const prev = this.stopInflight.get(conv.id);
		const run = prev ? prev.catch(() => {}).then(() => this.stopDelegatedNow(conv)) : this.stopDelegatedNow(conv);
		this.stopInflight.set(conv.id, run);
		void run.finally(() => {
			if (this.stopInflight.get(conv.id) === run) this.stopInflight.delete(conv.id);
		});
		return run;
	}

	private async stopDelegatedNow(conv: GoalConversation): Promise<void> {
		const gen = conv.goalGeneration;
		this.delegatedPending.delete(conv.id);
		conv.awaitingVerdict = undefined;
		void this.flushDeferredPrompts(conv);
		const settle = this.verdictWaiters.get(conv.id);
		if (settle) {
			this.verdictWaiters.delete(conv.id);
			settle("gone");
		}
		const execId = this.detachRoleExec(conv);
		if (execId) {
			try {
				await this.host.stopRoleAgent?.(execId);
			} catch {}
			try {
				await this.host.dismissRoleAgent?.(execId);
			} catch {}
		}
		if (this.isCurrentGoalRequest(conv, gen)) conv.goal.phase = "idle";
	}

	notifyTakeover(conv: GoalConversation): void {
		conv.goalGeneration = (conv.goalGeneration ?? 0) + 1;
		conv.goal.reviewing = false;
		this.resetLoopCounters(conv);
		this.delegatedPending.delete(conv.id);
		conv.awaitingVerdict = undefined;
		void this.flushDeferredPrompts(conv);
		const settle = this.verdictWaiters.get(conv.id);
		if (settle) {
			this.verdictWaiters.delete(conv.id);
			settle("gone");
		}
		const execId = this.detachRoleExec(conv);
		if (execId) {
			void this.host.stopRoleAgent?.(execId).catch(() => {});
			void this.host.dismissRoleAgent?.(execId).catch(() => {});
		}
		conv.goal.phase = "idle";
	}

	notifyConversationRemoved(conv: GoalConversation): void {
		this.notifyTakeover(conv);
		if (this.wizardOwnerId === conv.id) {
			void this.abortWizard();
		}
	}

	private sessionUsage(session: GoalConversation["session"]): { input: number; output: number } | undefined {
		try {
			const t = session.getSessionStats()?.tokens as { input?: unknown; output?: unknown } | undefined;
			if (t && typeof t.input === "number" && typeof t.output === "number") {
				return { input: t.input, output: t.output };
			}
		} catch {}
		return undefined;
	}

	private addGoalUsage(conv: GoalConversation, before: { input: number; output: number } | undefined): void {
		const after = this.sessionUsage(conv.session);
		if (!after || !before) return;
		conv.goalUsage = {
			input: (conv.goalUsage?.input ?? 0) + Math.max(0, after.input - before.input),
			output: (conv.goalUsage?.output ?? 0) + Math.max(0, after.output - before.output),
		};
	}

	private roundsLabel(budget: number): string {
		return roundsSuffix(budget);
	}

	/**
	 * 一轮的材料：归一（记 goal 的 cwd）→ 必要时 stage 到执行侧 cwd → 清单（执行者与审查者共用）。
	 *
	 * 无材料时**不做任何 IO**、不产生 notice（R10）；不可归一的项一律记账（R6）。
	 */
	/**
	 * 把随消息上传的内联材料落盘成内容寻址路径，并入规格（契约 R1：规格只存字符串）。
	 * 落盘失败/超大只记账，不阻断设目标（R6 不静默、R10 不改变无材料时的行为）。
	 */
	private async applyMaterialBlobs(
		conv: GoalConversation,
		base: string[] | undefined,
		blobs: MaterialBlob[] | undefined,
	): Promise<string[] | undefined> {
		const result = await applyGoalMaterialBlobs(base, blobs);
		if (result.dropped.length > 0) {
			console.warn(`[goal] material blobs dropped (${conv.id}): ${result.dropped.map((d) => d.value).join("、")}`);
			this.host.emit({ type: "notice", level: "warning", ...goalMaterialOverflowText(result.dropped) });
		}
		return result.refs;
	}

	private planRoundMaterials(conv: GoalConversation, targetCwd: string): string | Promise<string> {
		// 无材料：不做 IO、不产生 notice，也不改变轮转次数（R10；首轮派发的时序是既有契约）。
		if ((conv.goal.materials ?? []).length === 0) return "";
		return planGoalRoundMaterials({ refs: conv.goal.materials, goalCwd: conv.cwd, execCwd: targetCwd }).then((plan) => {
			this.reportGoalMaterials(conv, plan.notice);
			return plan.block;
		});
	}

	/** R6：材料账不静默——日志 + 用户可见 notice（同一份账只报一次）。 */
	private reportGoalMaterials(conv: GoalConversation, notice: GoalMaterialNotice | null): void {
		this.reportMaterialNotice(conv.id, notice);
	}

	private async runDelegatedLoop(conv: GoalConversation, goalGeneration: number, goalText: string): Promise<void> {
		let feedback = "";
		for (;;) {
			if (!this.isCurrentDelegated(conv, goalGeneration)) return;
			const g = conv.goal;
			if (this.host.quiesceBlocked()) {
				await this.finishDelegated(conv, goalGeneration, "blocked", g.round, this.roleFailureText("quiesce"), goalText);
				return;
			}
			const budget = this.roundBudget(g);
			if (g.round >= budget) {
				await this.finishDelegated(conv, goalGeneration, "exhausted", g.round, feedback, goalText);
				return;
			}
			const round = g.round + 1;
			g.round = round;
			g.reviewing = true;
			g.verdict = "pending";
			g.feedback = undefined;
			g.phase = "executing";
			g.status = `执行中（第 ${round}${this.roundsLabel(budget)} 轮）…`;
			g.statusEn = `Executing (round ${round}${this.roundsLabel(budget)})…`;
			this.emitGoalStatus();

			// 一轮一份清单：执行者与审查者拿到的必须是**同一份**（执行会话可被重建）。
			const materialsBlock = await this.planRoundMaterials(conv, conv.roleExec?.cwd ?? conv.cwd);
			if (!this.isCurrentDelegated(conv, goalGeneration)) return;

			const execId = await this.dispatchExecutor(
				conv,
				goalGeneration,
				goalText,
				round,
				budget,
				feedback,
				materialsBlock,
			);
			if (!execId) return;
			if (!this.isCurrentDelegated(conv, goalGeneration)) return;

			const outcome = await this.host.waitRoleAgent!(execId, this.roleDeadline());
			if (!this.isCurrentDelegated(conv, goalGeneration)) return;

			const sample = await this.sampleRound(conv, execId);
			if (!this.isCurrentDelegated(conv, goalGeneration)) return;

			if (
				(conv.sameErrorRounds ?? 0) >= 2 ||
				(conv.stagnantRounds ?? 0) >= 2 ||
				(conv.failedRounds ?? 0) >= GOAL_EXEC_FAILED_ROUNDS_LIMIT
			) {
				await this.finishDelegated(conv, goalGeneration, "blocked", round, "", goalText);
				return;
			}

			if (outcome !== "done") {
				if (outcome === "gone" || outcome === "canceled") {
					const reason =
						outcome === "gone"
							? this.roleFailureText("exec-gone")
							: this.roleFailureText("canceled", sample.errorSnippet ?? "");
					await this.finishDelegated(conv, goalGeneration, "blocked", round, reason, goalText);
					return;
				}
				conv.failedRounds = (conv.failedRounds ?? 0) + 1;
				if (conv.failedRounds >= GOAL_EXEC_FAILED_ROUNDS_LIMIT) {
					await this.finishDelegated(
						conv,
						goalGeneration,
						"blocked",
						round,
						this.roleFailureText(outcome === "timeout" ? "timeout-repeat" : "error-repeat", sample.errorSnippet ?? ""),
						goalText,
					);
					return;
				}
				feedback = this.roleFailureText(outcome === "timeout" ? "timeout" : "error", sample.errorSnippet ?? "");
				if (outcome === "timeout") await this.host.stopRoleAgent?.(execId).catch(() => {});
				continue;
			}
			conv.failedRounds = 0;

			g.phase = "reviewing";
			g.reviewing = true;
			g.status = `审查中（第 ${round}${this.roundsLabel(budget)} 轮）…`;
			g.statusEn = `Reviewing (round ${round}${this.roundsLabel(budget)})…`;
			this.emitGoalStatus();
			const verdict = await this.askDelegatedReview(
				conv,
				goalGeneration,
				round,
				budget,
				sample.output,
				execId,
				materialsBlock,
			);
			if (!this.isCurrentDelegated(conv, goalGeneration)) return;
			if (verdict === "invalid" || verdict === "timeout" || verdict === "gone") {
				await this.finishDelegated(
					conv,
					goalGeneration,
					"blocked",
					round,
					this.roleFailureText(`review-${verdict}`),
					goalText,
				);
				return;
			}
			const verdictFeedback = this.ensureReviewerFeedback(verdict.verdict, verdict.feedback, feedback);
			if (this.isCurrentDelegated(conv, goalGeneration)) {
				await this.pushReviewCard(conv, this.reviewCardText(verdict.verdict, round, budget, verdictFeedback), {
					phase: "result",
					round,
					verdict: verdict.verdict,
				});
			}
			if (!this.isCurrentDelegated(conv, goalGeneration)) return;
			if (verdict.verdict === "pass") {
				await this.finishDelegated(conv, goalGeneration, "pass", round, verdictFeedback, goalText);
				return;
			}
			feedback = verdictFeedback;
		}
	}

	private async dispatchExecutor(
		conv: GoalConversation,
		goalGeneration: number,
		goalText: string,
		round: number,
		budget: number,
		feedback: string,
		materialsBlock = "",
	): Promise<string | undefined> {
		const host = this.host;
		const g = conv.goal;
		const existing = conv.roleExec;
		if (existing) {
			const alive = host.hasConv ? host.hasConv(existing.convId) : true;
			if (!alive) {
				await this.finishDelegated(conv, goalGeneration, "blocked", round, this.roleFailureText("exec-gone"), goalText);
				return undefined;
			}
			const sent = await host.sendRoleAgent!(
				existing.convId,
				this.executorRoundPrompt(goalText, round, budget, feedback, materialsBlock),
			);
			if (!sent) {
				await this.finishDelegated(conv, goalGeneration, "blocked", round, this.roleFailureText("exec-gone"), goalText);
				return undefined;
			}
			this.beginRoundVitals(conv, existing.convId);
			return existing.convId;
		}
		await this.preemptMainRunForGoal(conv, goalGeneration);
		if (!this.isCurrentDelegated(conv, goalGeneration)) return undefined;
		try {
			const convId = await host.spawnRoleAgent!({
				role: "executor",
				prompt: this.executorRoundPrompt(goalText, round, budget, "", materialsBlock),
				cwd: conv.cwd,
				model: g.execModel ?? null,
				parentId: conv.id,
				title: this.roleConvTitle(goalText),
			});
			if (conv.goalGeneration !== goalGeneration) {
				void host.stopRoleAgent?.(convId).catch(() => {});
				return undefined;
			}
			// 记下执行对话的 cwd：与 goal 的 cwd 不同轮次里的材料必须先 stage 到执行侧（R7）。
			conv.roleExec = { convId, generation: (conv.roleExec?.generation ?? 0) + 1, cwd: conv.cwd };
			g.roles = { ...g.roles, executor: { convId, spawned: true } };
			this.beginRoundVitals(conv, convId);
			this.emitGoalStatus();
			return convId;
		} catch (err) {
			await this.abortOnSpawnFailure(conv, goalGeneration, goalText, err instanceof Error ? err.message : String(err));
			return undefined;
		}
	}

	private beginRoundVitals(conv: GoalConversation, execId: string): void {
		let read: RoleAgentRead | undefined;
		try {
			read = this.host.readRoleAgent?.(execId);
		} catch {
			read = undefined;
		}
		conv.execUsageBefore = read?.usage;
		this.snapshotExecutor(conv, execId, read);
	}

	private snapshotExecutor(conv: GoalConversation, execId: string, read?: RoleAgentRead): void {
		const g = conv.goal;
		const role = g.roles?.executor;
		if (!role || role.convId !== execId) return;
		const streaming = read?.streaming;
		let activity: string | undefined;
		let activityEn: string | undefined;
		if (streaming && read?.lastTool) {
			activity = `${read.lastTool} 运行中`;
			activityEn = `${read.lastTool} running`;
		} else if (read?.text?.trim()) {
			const head = read.text.trim().replace(/\s+/g, " ").slice(0, 60);
			activity = head;
			activityEn = head;
		}
		g.roles = { ...g.roles, executor: { ...role, streaming, activity, activityEn } };
	}

	private async sampleRound(
		conv: GoalConversation,
		execId: string,
	): Promise<{ output: string; errorSnippet?: string }> {
		const read = this.host.readRoleAgent?.(execId);
		const output = read?.text ?? "";
		let diffOut = "";
		try {
			diffOut = await this.host.gitDiff(conv.cwd);
		} catch {
			diffOut = "";
		}
		const currentError = read?.errorSnippet ?? extractErrorSnippetFromSession(undefined, output);
		let repoAvailable = true;
		try {
			if (this.host.isGitRepo) repoAvailable = await this.host.isGitRepo(conv.cwd);
		} catch {
			repoAvailable = true;
		}
		sampleGoalRound(conv, {
			errorSnippet: currentError,
			diffFingerprint: diffOut,
			repoAvailable,
			usageAfter: read?.usage,
		});
		this.snapshotExecutor(conv, execId, read);
		return { output, errorSnippet: currentError };
	}

	private async askDelegatedReview(
		conv: GoalConversation,
		goalGeneration: number,
		round: number,
		budget: number,
		execOutput: string,
		execId: string,
		materialsBlock = "",
	): Promise<DelegatedVerdict> {
		for (let attempt = 0; attempt < 2; attempt++) {
			const idle = await this.waitMainIdle(conv);
			if (!this.isCurrentDelegated(conv, goalGeneration)) return "gone";
			if (!idle) return "timeout";
			const planDesc = this.host.describePlan?.(conv.id) ?? "";
			const text =
				attempt === 0
					? this.reviewerRoundPrompt(
							conv.goal.goal ?? "",
							round,
							budget,
							execOutput,
							planDesc,
							this.readExecutorEvidence(execId),
							materialsBlock,
						)
					: this.verdictRetryPrompt();
			const verdict = await this.deliverAndWait(conv, round, text);
			if (verdict !== "invalid") return verdict;
		}
		return "invalid";
	}

	private readExecutorEvidence(execId: string): string {
		try {
			return this.host.readRoleEvidence?.(execId)?.trim() ?? "";
		} catch {
			return "";
		}
	}

	private ensureReviewerFeedback(verdict: "pass" | "fail", feedback: string, prevFeedback: string): string {
		return goalReviewerFeedback(this.lang(), verdict, feedback, prevFeedback);
	}

	private async waitMainIdle(conv: GoalConversation): Promise<boolean> {
		const end = Date.now() + this.roleDeadline();
		for (;;) {
			if (!this.isConvStreaming(conv)) return true;
			if (Date.now() >= end) return false;
			const r = await this.host.waitRoleAgent?.(conv.id, Math.min(30_000, end - Date.now()));
			if (r === "gone") return false;
		}
	}

	private async pushReviewCard(
		conv: GoalConversation,
		text: string,
		details: { phase: "start" | "result"; round: number; verdict?: string },
	): Promise<void> {
		try {
			await conv.session.sendCustomMessage({
				customType: "goal-review",
				content: [{ type: "text", text }],
				display: true,
				details: { type: "goal-review", ...details },
			});
		} catch {}
	}

	private async flushDeferredPrompts(conv: GoalConversation): Promise<void> {
		const queued = conv.deferredPrompts;
		conv.deferredPrompts = undefined;
		if (!queued || queued.length === 0) return;
		for (const text of queued) {
			try {
				const ok = await this.host.sendRoleAgent!(conv.id, text, "followUp");
				if (!ok) break;
			} catch {
				break;
			}
		}
		this.host.flushSnapshot();
	}

	private async deliverAndWait(conv: GoalConversation, round: number, text: string): Promise<DelegatedVerdict> {
		const host = this.host;
		conv.awaitingVerdict = { round };
		conv.reviewUsageBefore = this.sessionUsage(conv.session);
		await this.pushReviewCard(conv, this.reviewCardText("start", round, this.roundBudget(conv.goal), ""), {
			phase: "start",
			round,
		});
		if (!conv.awaitingVerdict || conv.awaitingVerdict.round !== round) {
			return "gone";
		}
		const verdict = await new Promise<DelegatedVerdict>((resolve) => {
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const settle = (v: DelegatedVerdict): void => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				if (this.verdictWaiters.get(conv.id) === settle) this.verdictWaiters.delete(conv.id);
				resolve(v);
			};
			this.verdictWaiters.set(conv.id, settle);
			timer = setTimeout(() => settle("timeout"), this.roleDeadline());
			timer.unref?.();
			this.signalAwaitingVerdict(conv.id);
			void host.sendRoleAgent!(conv.id, text, "followUp")
				.then((ok) => {
					if (!ok) settle("gone");
				})
				.catch(() => settle("gone"));
		});
		if (conv.awaitingVerdict?.round === round) conv.awaitingVerdict = undefined;
		await this.flushDeferredPrompts(conv);
		return verdict;
	}

	private deliverDelegatedVerdict(conv: GoalConversation): void {
		const settle = this.verdictWaiters.get(conv.id);
		if (!settle) return;
		this.verdictWaiters.delete(conv.id);
		conv.awaitingVerdict = undefined;
		this.addGoalUsage(conv, conv.reviewUsageBefore);
		conv.reviewUsageBefore = undefined;
		let text = "";
		try {
			text = conv.session.getLastAssistantText() ?? "";
		} catch {
			text = "";
		}
		settle(parseReviewerVerdict(text) ?? "invalid");
	}

	private recordHistory(
		conv: GoalConversation,
		verdict: GoalHistoryEntry["verdict"],
		rounds: number,
		feedback: string,
	): void {
		const text = (conv.goal.goal ?? "").trim();
		if (!text) return;
		conv.goalHistory = recordGoalHistory(conv.goalHistory, {
			goal: text.slice(0, 200),
			verdict,
			rounds,
			feedback: feedback.trim().replace(/\s+/g, " ").slice(0, 200),
		});
	}

	private async finishDelegated(
		conv: GoalConversation,
		goalGeneration: number,
		kind: "pass" | "blocked" | "exhausted",
		round: number,
		feedback: string,
		goalText: string,
	): Promise<void> {
		if (!this.isCurrentDelegated(conv, goalGeneration)) return;
		const g = conv.goal;
		this.recordHistory(conv, kind === "pass" ? "pass" : kind === "exhausted" ? "fail" : "blocked", round, feedback);
		if (conv.awaitingVerdict) {
			const settle = this.verdictWaiters.get(conv.id);
			this.verdictWaiters.delete(conv.id);
			conv.awaitingVerdict = undefined;
			settle?.("gone");
		}
		const budget = g.locked ? (g.maxRounds > 0 ? Math.min(g.maxRounds, 50) : 0) : 1;
		const roundsZh = budget > 0 ? `第 ${round}/${budget} 轮` : `第 ${round} 轮（不限）`;
		const roundsEn = budget > 0 ? `Round ${round}/${budget}` : `Round ${round} (unlimited)`;
		g.reviewing = false;
		const execId = this.detachRoleExec(conv);
		if (execId) {
			await this.host.stopRoleAgent?.(execId).catch(() => {});
			await this.host.dismissRoleAgent?.(execId).catch(() => {});
		}

		if (kind === "pass") {
			g.verdict = "pass";
			g.feedback = feedback;
			g.phase = "idle";
			g.status = "✅ 已通过目标审查";
			g.statusEn = "✅ Goal review passed";
			g.conversationId = null;
			g.goal = null;
			// 目标已结束：材料指针一齐清掉，不留下一个已无目标的清单（R9）。
			g.materials = undefined;
			this.host.emit({ type: "notice", level: "info", text: "✅ 目标已通过审查", textEn: "✅ Goal passed review" });
			this.emitGoalStatus();
			try {
				const passText = pick(
					this.lang(),
					`✅ 目标已达成并通过审查（第 ${round} 轮）。\n\n目标：${goalText}\n\n${feedback}\n\n（目标模式已解除，接下来按你的普通指令响应。）`,
					`✅ Goal achieved and passed review (round ${round}).\n\nGoal: ${goalText}\n\n${feedback}\n\n(Goal mode is off — respond to further instructions normally.)`,
					"goal.review.pass",
					{ round: round, goalText: goalText, feedback: feedback },
				);
				await promptSession(conv.session, passText, {
					deliverAs: conv.session.isStreaming ? "steer" : "followUp",
				});
			} catch {}
			this.host.flushSnapshot();
			return;
		}

		if (kind === "exhausted") {
			g.verdict = "fail";
			g.feedback = feedback;
			g.phase = "idle";
			if (g.locked && g.maxRounds > 0) {
				g.status = `已达最大轮数（${g.maxRounds}），目标仍未通过`;
				g.statusEn = `Max rounds reached (${g.maxRounds}), goal still failing`;
			} else {
				g.status = `目标未通过（${roundsZh}）`;
				g.statusEn = `Goal failed (${roundsEn})`;
			}
			this.host.emit({
				type: "notice",
				level: "warning",
				text: "目标未通过审查（已达最大轮数）",
				textEn: "Goal failed review (max rounds reached)",
			});
			try {
				const capped = budget > 0 ? budget : "不限";
				const cappedEn = budget > 0 ? budget : "unlimited";
				await promptSession(
					conv.session,
					pick(
						this.lang(),
						`❌ 目标未通过审查（第 ${round}/${capped} 轮）。\n\n目标：${goalText}\n\n审查意见：${feedback}`,
						`❌ Goal failed review (round ${round}/${cappedEn}).\n\nGoal: ${goalText}\n\nFeedback: ${feedback}`,
						"goal.review.fail",
						{ round: round, capped: capped, goalText: goalText, feedback: feedback, cappedEn: cappedEn },
					),
					{ deliverAs: conv.session.isStreaming ? "steer" : "followUp" },
				);
			} catch {}
			g.reviewing = false;
			this.emitGoalStatus();
			this.host.flushSnapshot();
			return;
		}

		const reason =
			feedback.trim() !== ""
				? feedback.trim()
				: (conv.sameErrorRounds ?? 0) >= 2
					? `连续 ${conv.sameErrorRounds} 轮出现相同错误：${conv.lastErrorSnippet ?? ""}`
					: `连续 ${conv.stagnantRounds} 轮未检测到有效文件修改或实质进展`;
		g.verdict = "blocked";
		g.feedback = reason;
		g.phase = "blocked";
		g.status = "⚠️ 目标受阻（委托执行已暂停）";
		g.statusEn = "⚠️ Goal blocked (delegated execution paused)";
		this.host.emit({
			type: "notice",
			level: "warning",
			text: "⚠️ 目标执行受阻：委托执行已暂停（可在目标条重新设定目标继续）",
			textEn: "⚠️ Goal blocked: delegated execution paused (set the goal again to continue)",
		});
		try {
			await promptSession(
				conv.session,
				pick(
					this.lang(),
					`⚠️ 目标执行受阻（${roundsZh}）。\n\n目标：${goalText}\n\n原因：${reason}\n\n（委托执行已暂停，不会自己重新派活。要彻底退出目标模式：点目标条右侧的 ■ 停止目标（取消）；想继续就重新设定目标。）`,
					`⚠️ Goal execution blocked (${roundsEn}).\n\nGoal: ${goalText}\n\nReason: ${reason}\n\n(Delegated execution is paused and will not dispatch again by itself. To leave goal mode entirely, press ■ Stop goal (cancel) in the goal bar; to resume, set the goal again.)`,
					"goal.role.blocked",
					{ round, goalText, reason, rounds: roundsEn, roundsZh, roundsEn },
				),
				{ deliverAs: conv.session.isStreaming ? "steer" : "followUp" },
			);
		} catch {}
		this.emitGoalStatus();
		this.host.flushSnapshot();
	}

	private roleConvTitle(goalText: string): string {
		return goalRoleTitle(this.lang(), goalText);
	}

	private async abortOnSpawnFailure(
		conv: GoalConversation,
		goalGeneration: number,
		goalText: string,
		reason: string,
	): Promise<void> {
		const g = conv.goal;
		this.recordHistory(conv, "blocked", conv.goal.round, reason);
		g.verdict = "blocked";
		g.phase = "blocked";
		g.feedback = reason;
		g.status = "执行对话创建失败，目标未开始";
		g.statusEn = "Failed to create the executor conversation; the goal did not start";
		this.emitGoalStatus();
		this.host.emit({
			type: "notice",
			level: "warning",
			text: `无法创建执行对话，目标未开始：${reason}`,
			textEn: `Could not create the executor conversation; the goal did not start: ${reason}`,
		});
		if (/上限|limit/i.test(reason)) {
			this.host.emit({
				type: "notice",
				level: "warning",
				text: "提示：执行对话会占用本项目显式配置的普通对话名额，可在左栏移出不需要的对话后重新设定目标。",
				textEn:
					"Tip: the executor conversation counts toward the project's configured open-conversation limit. Remove unneeded conversations in the left panel, then set the goal again.",
			});
		}
		this.host.flushSnapshot();
	}

	private executorRoundPrompt(
		goalText: string,
		round: number,
		budget: number,
		feedback: string,
		materialsBlock = "",
	): string {
		return goalExecutorPrompt(this.lang(), { goalText, round, budget, feedback, materialsBlock });
	}

	private reviewCardText(kind: "start" | "pass" | "fail", round: number, budget: number, feedback: string): string {
		return goalCardText(this.lang(), kind, round, budget, feedback);
	}

	private reviewerRoundPrompt(
		goalText: string,
		round: number,
		budget: number,
		execOutput: string,
		planDesc = "",
		evidence = "",
		materialsBlock = "",
	): string {
		return goalReviewerPrompt(this.lang(), { goalText, round, budget, execOutput, planDesc, evidence, materialsBlock });
	}

	private verdictRetryPrompt(): string {
		return goalVerdictRetryPrompt(this.lang());
	}

	private roleFailureText(kind: string, detail = ""): string {
		return goalFailureText(this.lang(), kind, detail);
	}
}
