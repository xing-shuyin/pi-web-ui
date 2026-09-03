/**
 * goal-service — 目标 / 审查循环 / 调研向导，从 agent-service.ts 抽出。
 *
 * 职责：
 *  - setGoal/clearGoal/setGoalPrefs：目标状态机 + 偏好「全局记忆」（client-state.json）
 *  - runGoalReview：agent_end 后用 ISOLATED 审查会话（独立 ModelRuntime）判定
 *    pass/fail，fail 时把意见作为普通 user 消息注入主会话重改
 *  - startGoalWizard：AI 提炼——独立调研会话经 goal_ask 工具逐题提问（对话框桥接浏览器），
 *    收敛出 GOAL: 后自动设为目标并触发生成
 *
 * 经 GoalHost 窄接口与 ClientSession 解耦（同 settings-service 模式）：对话记录按
 * 结构化子集 GoalConversation 传入（真实 Conversation 满足该结构），会话创建/对话框
 * 取消/git diff 等宿主能力走回调，便于独立测试。UI 文案直接中文（服务端 notice 约定）。
 */
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
import type { GoalStatus, ServerMessage } from "./protocol.js";
import type { ClientStateStore } from "./client-state.js";
import { parseModelSpec } from "./attachments.js";
import type { WebUIContext } from "./webui-context.js";

/** ClientSession 私有 Conversation 中 goal 家族会触碰的字段（结构化子集）。 */
export interface GoalConversation {
	id: string;
	cwd: string;
	session: AgentSession;
	/** 调研进行中（互斥审查触发）。 */
	wizardRunning: boolean;
	/** set/clear/stop 都 +1：作废还在飞的异步审查回调。 */
	goalGeneration: number;
	goalReviewGeneration: number;
	goal: GoalStatus;
}

/** ClientSession 提供给本服务的宿主能力（窄接口）。 */
export interface GoalHost {
	clientId: string;
	agentDir: string;
	stateStore: ClientStateStore;
	webUi: WebUIContext;
	emit: (msg: ServerMessage) => void;
	flushSnapshot: () => void;
	isDisposed: () => boolean;
	/** quiesce 排空中拒绝新调研。 */
	quiesceBlocked: () => boolean;
	activeConvId: () => string;
	activeConv: () => GoalConversation;
	getConv: (id: string) => GoalConversation | undefined;
	/** 客户端工作目录（wizard 的 in-memory session 用）。 */
	cwd: () => string;
	reviewSettings: () => { reviewPrompt: string; reviewDisabledSkills: string[] };
	gitDiff: (cwd: string) => Promise<string>;
}

/** System prompt for the goal-wizard session. The wizard asks the user a few
 *  questions (via its goal_ask tool) to scope a raw requirement into a precise,
 *  reviewable goal, then emits ONLY the final goal text as its last message. */
function wizardPrompt(draft: string): string {
	return [
		`You are a goal-clarification wizard. The user has stated a raw requirement. Your job is to turn it into ONE precise, actionable goal that a coding agent can fully satisfy and that can be strictly reviewed.`, // eslint-disable-line max-len
		``,
		`# User's raw requirement`, // eslint-disable-line no-regex-spaces
		draft,
		``,
		`Use your goal_ask tool to ask the user focused questions to pin down the essential, ambiguous details. Keep it concise — usually 2 to 4 questions: what exactly to build/do, scope boundaries (what NOT to do), acceptance criteria / done-definition, and any constraints (style, performance, environment).`, // eslint-disable-line max-len
		`Prefer multiple-choice (goal_ask with options) when you can offer clear choices; use open questions only for things that genuinely need free text.`, // eslint-disable-line max-len
		`Once you have enough to write an unambiguous, reviewable goal, STOP asking and reply with EXACTLY this format and nothing else (no preamble, no bullets):`, // eslint-disable-line max-len
		`GOAL: <one concrete, verifiable sentence describing the deliverable and its acceptance criteria>`, // eslint-disable-line max-len
		`If the user cancels or stops answering (the tool reports a cancellation), still produce a sensible best-effort goal from what you already know.`, // eslint-disable-line max-len
	].join("\n");
}

export class GoalService {
	/** Defaults remembered for newly-created conversations. Each conversation
	 * receives its own GoalStatus, so reviews can run concurrently. */
	private prefs = {
		reviewModel: null as string | null,
		maxRounds: 0,
		locked: true,
	};
	/** Aborts the currently-running goal wizard (user clicked ✗ / timed out). Drives
	 *  the in-flight goal_ask dialog to resolve as cancelled and (via the run
	 *  signal) stops the wizard session's agent run. Recreated per wizard. */
	private wizardAbort: AbortController | null = null;
	/** The wizard's AgentSession while it runs — lets clearGoal truly terminate it
	 *  (abort the run), not just flip a flag. */
	private wizardSession: AgentSession | null = null;
	/** Conversation that owns the one browser wizard currently in flight. */
	private wizardOwnerId: string | null = null;
	/** True when the wizard was cancelled externally (✗ / clear_goal / timeout) —
	 *  startGoalWizard reads this after the run to avoid setting a goal. */
	private wizardCancelled = false;
	/** Idle-timeout for the wizard: if no answer arrives within this window (a
	 *  dialog is up but the user doesn't respond), the wizard is auto-cancelled. */
	private static readonly WIZARD_IDLE_TIMEOUT_MS = 5 * 60_000;
	/** Absolute deadline for the whole wizard session (model latency guard). */
	private static readonly WIZARD_MAX_TOTAL_MS = 20 * 60_000;

	constructor(private readonly host: GoalHost) {
		// Restore last-used goal/review preferences so model & rounds survive reload.
		const gPrefs = host.stateStore.getGoalPrefs(host.clientId);
		if (gPrefs) {
			this.prefs = {
				reviewModel: gPrefs.reviewModel,
				maxRounds: gPrefs.maxRounds,
				locked: gPrefs.locked,
			};
		}
	}

	/** Remembered defaults (model choice / rounds cap / lock). */
	get reviewPrefs() {
		return this.prefs;
	}

	/** Create independent goal state for one conversation. Preferences are
	 * client-wide defaults, while goal text/review progress is not shared. */
	makeGoalStatus(): GoalStatus {
		return {
			conversationId: null,
			goal: null,
			reviewModel: this.prefs.reviewModel,
			maxRounds: this.prefs.maxRounds,
			locked: this.prefs.locked,
			reviewing: false,
			round: 0,
			status: "",
			verdict: "pending",
			wizard: {
				active: false,
				draft: "",
				model: null,
				step: 0,
				maxSteps: 6,
				status: "",
			},
		};
	}

	/** Push the active conversation's goal status to the client (the goal bar
	 * restores remembered prefs when nothing is active). */
	emitGoalStatus(): void {
		const goal = this.host.activeConv().goal;
		if (!goal.goal && !goal.reviewing && !goal.wizard.active) {
			goal.reviewModel = this.prefs.reviewModel;
			goal.maxRounds = this.prefs.maxRounds;
			goal.locked = this.prefs.locked;
		}
		this.host.emit({ type: "goal_status", status: { ...goal } });
	}

	/**
	 * Set (or clear) the active goal. `goal === ""` clears it. The goal is
	 * applied to the CURRENT active conversation of this project; reviews check
	 * whatever run finishes next (agent_end).
	 */
	async setGoal(
		goalText: string,
		opts?: {
			reviewModel?: string;
			maxRounds?: number;
			locked?: boolean;
			/** Kick the main agent into generating as soon as the goal is set.
			 *  Default true (set from the goal bar). The wizard passes false — it
			 *  kicks off its own generation after auto-setting the refined goal. */
			autoStart?: boolean;
		},
	): Promise<void> {
		const text = (goalText ?? "").trim();
		if (!text) {
			await this.clearGoal();
			return;
		}
		// A goal is scoped to the conversation that is active when it is set.
		// This prevents an agent_end from a newly-created/switched conversation
		// from consuming the previous conversation's goal.
		const conv = this.host.activeConv();
		const goalConversationId = this.host.activeConvId();
		conv.goalGeneration += 1;
		const goal = conv.goal;
		goal.reviewing = false;
		goal.conversationId = goalConversationId;
		goal.goal = text;
		// Model & rounds preference semantics ("全局记忆"):
		//  - reviewModel undefined → keep the remembered choice; empty → main model.
		//  - maxRounds 0 = unlimited (default); >0 = finite cap (clamped to 50).
		if (opts?.reviewModel !== undefined) goal.reviewModel = opts.reviewModel || null;
		if (typeof opts?.maxRounds === "number") {
			const mr = Math.round(opts.maxRounds);
			goal.maxRounds = mr >= 1 ? Math.min(mr, 50) : 0;
		}
		if (opts?.locked !== undefined) goal.locked = opts.locked;
		this.prefs = {
			reviewModel: goal.reviewModel,
			maxRounds: goal.maxRounds,
			locked: goal.locked,
		};
		// Persist the chosen preferences so they survive reload.
		this.host.stateStore.saveGoalPrefs(this.host.clientId, {
			reviewModel: goal.reviewModel,
			maxRounds: goal.maxRounds,
			locked: goal.locked,
		});
		// Reset the loop for a freshly-set goal (single-shot goals start at 0).
		goal.round = 0;
		goal.reviewing = false;
		goal.verdict = "pending";
		goal.feedback = undefined;
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
		// Auto-start generation right after setting the goal (unless this setGoal is
		// the wizard's internal one, which kicks off itself). This makes the direct
		// goal-bar path behave like the AI-提炼 path: set a target → agent begins.
		if (opts?.autoStart !== false) {
			try {
				const s = conv.session;
				await s.sendUserMessage(
					`【目标已设定】\n\n${text}\n\n请现在开始实现这个目标。`,
					{ deliverAs: s.isStreaming ? "steer" : "followUp" },
				);
			} catch {
				// Best-effort; the user can still prompt manually.
			}
			this.host.flushSnapshot();
		}
	}

	/**
	 * Collaborative target wizard. Turns a raw user requirement into a refined
	 * goal by spinning up an ISOLATED wizard session (own fresh ModelRuntime +
	 * in-memory session, so its model choice is its own) that questions the user
	 * via `goal_ask` (multiple-choice + free-text, bridged to the browser through
	 * the existing select/input dialog), converging on a goal, then auto-sets it.
	 * Mutually exclusive with the review loop of the same conversation.
	 */
	async startGoalWizard(
		text: string,
		opts?: {
			wizardModel?: string;
			maxRounds?: number;
			locked?: boolean;
		},
	): Promise<void> {
		if (this.host.quiesceBlocked()) return;
		const draft = (text ?? "").trim();
		if (!draft) return;

		// The wizard and its progress cards belong to the conversation that
		// launched it. If the user switches away, do not later set a goal on the
		// new active conversation while the wizard is still finishing.
		const wizardConversationId = this.host.activeConvId();
		const wizardConversation = this.host.activeConv();
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

		// Questions are NOT capped (调研不限制) — the wizard converges on its own;
		// the idle- and total-timeouts are the only guards. maxSteps is purely a
		// soft UI indicator, not a hard stop.
		const maxSteps = 20;
		wizardConversation.wizardRunning = true;
		this.wizardOwnerId = wizardConversationId;
		this.wizardCancelled = false;
		this.wizardAbort = new AbortController();
		this.wizardSession = null;
		const wgoal = wizardConversation.goal;
		wgoal.wizard.active = true;
		wgoal.wizard.draft = draft;
		wgoal.wizard.model = opts?.wizardModel ?? null;
		// Remember the model choice (and persist rounds/lock) — global memory.
		if (opts?.wizardModel !== undefined && opts.wizardModel !== null)
			wgoal.reviewModel = opts.wizardModel || null;
		if (typeof opts?.maxRounds === "number") {
			const mr = Math.round(opts.maxRounds);
			wgoal.maxRounds = mr >= 1 ? Math.min(mr, 50) : 0;
		}
		if (opts?.locked !== undefined) wgoal.locked = opts.locked;
		this.prefs = {
			reviewModel: wgoal.reviewModel,
			maxRounds: wgoal.maxRounds,
			locked: wgoal.locked,
		};
		this.host.stateStore.saveGoalPrefs(this.host.clientId, {
			reviewModel: wgoal.reviewModel,
			maxRounds: wgoal.maxRounds,
			locked: wgoal.locked,
		});
		wgoal.wizard.step = 0;
		wgoal.wizard.maxSteps = maxSteps;
		wgoal.wizard.status = "调研中…";
		wgoal.wizard.statusEn = "Scoping…";
		wgoal.status = "目标调研中…";
		wgoal.statusEn = "Scoping the goal…";
		this.emitGoalStatus();
		// Idle-timeout: cancel the wizard if no question is answered within the
		// window (a stale dialog with no user response must not run forever). A
		// fresh timer is armed for each question; cleared once the run ends.
		const ac = this.wizardAbort;
		let idleTimer: ReturnType<typeof setTimeout> | null = null;
		const armIdle = () => {
			if (idleTimer) clearTimeout(idleTimer);
			idleTimer = setTimeout(() => {
				if (!ac.signal.aborted) {
					this.wizardCancelled = true;
					ac.abort(new Error("目标调研超时（等待回答过久）"));
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
		armIdle();
		// Total-duration guard: hard cap on the whole wizard session (model
		// latency / unexpected loops must not run forever).
		const totalTimer = setTimeout(() => {
			if (!ac.signal.aborted) {
				this.wizardCancelled = true;
				ac.abort(new Error("目标调研超过总时长上限"));
			}
		}, GoalService.WIZARD_MAX_TOTAL_MS);
		totalTimer.unref?.();
		this.host.emit({
			type: "notice",
			level: "info",
			text: `🔍 正在围绕需求展开调研：${draft.slice(0, 60)}${
				draft.length > 60 ? "…" : ""
			}`,
			textEn: `🔍 Surveying the requirement: ${draft.slice(0, 60)}${
				draft.length > 60 ? "…" : ""
			}`,
		});

		// The main conversation to show wizard progress cards in.
		const mainSession = wizardConversation.session;

		let refinedGoal = "";
		try {
			const wmSpec = opts?.wizardModel
				? this.resolveReviewModel(opts.wizardModel)
				: null; // reuse the honest "provider/id" parser
			const services = await createAgentSessionServices({
				cwd: wizardConversation.cwd,
				agentDir: this.host.agentDir,
				modelRuntime: await ModelRuntime.create({
					authPath: join(this.host.agentDir, "auth.json"),
					modelsPath: join(this.host.agentDir, "models.json"),
				}),
			});

			let model;
			if (wmSpec) model = services.modelRuntime.getModel(wmSpec.provider, wmSpec.id);
			if (!model) {
				const mainModel = mainSession.model as {
					provider?: string;
					id?: string;
				} | undefined;
				if (mainModel?.provider && mainModel.id)
					model = services.modelRuntime.getModel(mainModel.provider, mainModel.id);
			}

			// The wizard asks the user questions via this tool; each call bridges one
			// select/input dialog to the browser and returns the user's answer.
			let qStep = 0;
			const goalAsk = defineTool({
				name: "goal_ask",
				label: "Ask the user",
				description:
					"Ask the user ONE question at a time to scope down the goal. Provide a clear question and 2-4 concise options; or ask an open question. Returns the user's chosen answer.",
				parameters: Type.Object({
					question: Type.String({ description: "The question to ask" }),
					options: Type.Optional(Type.Array(Type.String())),
				}),
				// ONE question at a time. Sequential execution prevents the agent from
				// firing parallel goal_ask calls whose dialogs would overwrite each other
				// in the single browser modal (leaving earlier ones deadlocked — the
				// reported "调研卡住").
				executionMode: "sequential",
				execute: async (_id, params, _sig, _onUpdate, ctx) => {
					qStep += 1;
					if (qStep > maxSteps) {
						return {
							content: [
								{
									type: "text",
									text: "(达到最大提问数，请直接给出收敛后的目标文本作为最终答案)",
								},
							],
							details: {},
						};
					}
					// Show the question in the main flow BEFORE blocking on the dialog, so
					// the user sees the wizard working even before answering.
					wgoal.wizard.step = qStep;
					wgoal.wizard.status = `调研中：请回答第 ${qStep} 题`;
					wgoal.wizard.statusEn = `Scoping: please answer question ${qStep}`;
					this.emitGoalStatus();
					try {
						armIdle();
						const isChoice = !!(params.options && params.options.length > 0);
						await this.pushWizardCard(
							mainSession,
							`🔍 第 ${qStep} 题：${params.question}${
								isChoice ? `【${params.options!.join(" / ")}】` : ""
							}`,
							{ question: params.question },
						);
						// Resolve the pending dialog as cancelled if the wizard is aborted.
						let aborted = false;
						const onAbort = () => {
							aborted = true;
						};
						ac.signal.addEventListener("abort", onAbort, { once: true });
						const choose = isChoice
							? ctx.ui.select(`🔍 第 ${qStep} 题：${params.question}`, params.options!)
							: ctx.ui.input(`🔍 第 ${qStep} 题：${params.question}`);
						const ans = (await choose) as string | boolean | undefined;
						ac.signal.removeEventListener("abort", onAbort);
						if (aborted || ac.signal.aborted) {
							return {
								content: [
									{
										type: "text",
										text: "(调研已取消，请不要继续提问，直接结束对话)",
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
										text: "(用户已取消调研，请直接给出你当前收敛的目标文本作为最终答案)",
									},
								],
								details: {},
							};
						}
						// Record the answer in the flow too (instant append, main session idle).
						await this.pushWizardCard(
							mainSession,
							`↳ 您的回答：${ans}`,
							{ question: params.question, answer: String(ans) },
						);
						return {
							content: [{ type: "text", text: `用户回答：${ans}` }],
							details: {},
						};
					} catch (err) {
						return {
							content: [
								{
									type: "text",
									text: ac.signal.aborted
										? "(调研已取消，请不要继续提问，直接结束对话)"
										: `提问失败：${(err as Error).message}`,
								},
							],
							details: {},
						};
					}
				},
			});

			const srv = await createAgentSessionFromServices({
				services,
				sessionManager: SessionManager.inMemory(this.host.cwd()),
				customTools: [goalAsk],
				...(model ? { model } : {}),
			});
			const wizard = srv.session;
			this.wizardSession = wizard;
			await wizard.bindExtensions({ mode: "rpc", uiContext: this.host.webUi });
			// Cancel watcher: when the user ✗s / idle-timeout fires, truly stop the
			// wizard's agent run (not just mark it).
			if (!ac.signal.aborted) {
				ac.signal.addEventListener(
					"abort",
					() => {
						void wizard.abort().catch(() => {});
						// Close the unanswered browser dialog(s) the wizard may have up.
						this.host.webUi.cancelPendingDialogs();
					},
					{ once: true },
				);
			}
			await wizard.prompt(wizardPrompt(draft));
			refinedGoal = wizard.getLastAssistantText()?.trim() ?? "";
			// The wizard is prompted to emit "GOAL: <text>". Parse past the marker;
			// if it didn't follow, strip a leading preamble line and keep the rest.
			const goalMatch = refinedGoal.match(/GOAL\s*[:：]\s*([\s\S]*)/i);
			if (goalMatch) {
				refinedGoal = goalMatch[1].trim();
			} else {
				const lines = refinedGoal.split("\n").filter((l) => l.trim());
				if (lines.length > 1 && !/[。.!?？]\s*$/.test(lines[0])) {
					// First line looks like preamble (no sentence-ending punctuation).
					refinedGoal = lines.slice(1).join(" ").trim();
				}
			}
			await srv.session.dispose();
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
			this.emitGoalStatus();
		}

		// Aborted externally (✗ / clear_goal / idle-timeout): do NOT set a goal.
		if (ac.signal.aborted || this.wizardCancelled) {
			this.host.emit({
				type: "notice",
				level: "info",
				text: `目标调研已取消${
					ac.signal.reason ? `：${String((ac.signal.reason as Error)?.message ?? ac.signal.reason)}` : ""
				}`,
				textEn: `Goal survey cancelled${
					ac.signal.reason ? `: ${String((ac.signal.reason as Error)?.message ?? ac.signal.reason)}` : ""
				}`,
			});
			this.wizardAbort = null;
			return;
		}
		if (!refinedGoal.trim()) {
			this.host.emit({
				type: "notice",
				level: "warning",
				text: "调研未产出有效目标，请重试",
				textEn: "The survey produced no usable goal — retry",
			});
			return;
		}
		if (this.host.activeConvId() !== wizardConversationId) {
			this.host.emit({
				type: "notice",
				level: "info",
				text: "已切换对话，目标调研结果已丢弃",
				textEn: "Switched conversations; the survey result was discarded",
			});
			return;
		}
		// Auto-set the refined goal. The wizard workflow implies "set a goal and
		// work until it passes", so default LOCKED=true unless the user explicitly
		// turned the lock off (a lock lets the review loop keep revising to pass;
		// without it the review is single-shot).
		const wantLocked = opts?.locked === undefined ? true : opts.locked;
		await this.setGoal(refinedGoal, {
			reviewModel: wgoal.reviewModel ?? undefined,
			maxRounds: opts?.maxRounds,
			locked: wantLocked,
			// The wizard kicks off generation itself below — avoid a double kick.
			autoStart: false,
		});
		this.wizardCancelled = false;
		this.wizardAbort = null;
		this.host.emit({
			type: "notice",
			level: "info",
			text: `🎯 调研完成，目标已设为：${refinedGoal.slice(0, 80)}${
				refinedGoal.length > 80 ? "…" : ""
			}`,
			textEn: `🎯 Survey done, goal set: ${refinedGoal.slice(0, 80)}${
				refinedGoal.length > 80 ? "…" : ""
			}`,
		});
		// Kick the main agent into generating right away (no manual "开始吧").
		// The kick-off is a user message so it appears in the flow and triggers a
		// normal turn; the finishing agent_end then runs the review loop.
		try {
			await mainSession.sendUserMessage(
				`【目标已设定】\n\n${wgoal.goal}\n\n请现在开始实现这个目标。`,
				{ deliverAs: mainSession.isStreaming ? "steer" : "followUp" },
			);
		} catch {
			// Generation kick-off is best-effort; the user can still prompt manually.
		}
	}

	/** Persist goal/review preference defaults (model, rounds cap, locked) without
	 *  touching the active goal — so changes in the goal bar are remembered across
	 *  reloads. maxRounds 0 = unlimited. Emits goal_status so the UI stays synced. */
	async setGoalPrefs(opts?: {
		reviewModel?: string;
		maxRounds?: number;
		locked?: boolean;
	}): Promise<void> {
		const goal = this.host.activeConv().goal;
		if (opts?.reviewModel !== undefined) goal.reviewModel = opts.reviewModel || null;
		if (typeof opts?.maxRounds === "number") {
			const mr = Math.round(opts.maxRounds);
			goal.maxRounds = mr >= 1 ? Math.min(mr, 50) : 0;
		}
		if (opts?.locked !== undefined) goal.locked = opts.locked;
		this.prefs = {
			reviewModel: goal.reviewModel,
			maxRounds: goal.maxRounds,
			locked: goal.locked,
		};
		this.host.stateStore.saveGoalPrefs(this.host.clientId, {
			reviewModel: goal.reviewModel,
			maxRounds: goal.maxRounds,
			locked: goal.locked,
		});
		this.emitGoalStatus();
	}

	/** Clear the active goal (cancels the review loop AND aborts a running
	 *  goal wizard — truly terminating its in-flight dialog + agent run). */
	async clearGoal(): Promise<void> {
		const conv = this.host.activeConv();
		conv.goalGeneration += 1;
		const goal = conv.goal;
		goal.reviewing = false;
		goal.conversationId = null;
		goal.goal = null;
		goal.reviewing = false;
		goal.verdict = "pending";
		goal.feedback = undefined;
		goal.wizard.active = false;
		goal.wizard.status = "";
		goal.wizard.statusEn = "";
		goal.status = "";
		goal.statusEn = "";
		this.emitGoalStatus();
		// Abort a running wizard for real (✗ in the goal bar while scoping).
		if (this.wizardOwnerId === this.host.activeConvId()) {
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
		}
	}

	/**
	 * agent_end hook. `aborted` = the finished run ended by manual stop; in that
	 * case any active goal of THIS conversation is cleared so the review loop
	 * stops too (a half-finished run must not be reviewed — endless loop).
	 * Otherwise, spawn the isolated reviewer if a goal is pending. Returns a
	 * notice text for the host to emit (manual-stop case), or null.
	 */
	onAgentEnd(conv: GoalConversation, aborted: boolean): string | null {
		const g = conv.goal;
		if (aborted) {
			if (g.goal && g.conversationId === conv.id) {
				conv.goalGeneration += 1;
				g.conversationId = null;
				g.goal = null;
				g.reviewing = false;
				g.verdict = "pending";
				g.feedback = undefined;
				g.status = "已手动停止，目标审查已中止";
				g.statusEn = "Stopped manually, goal review aborted";
				this.emitGoalStatus();
				return "⏹ 已手动停止，目标审查已中止（想继续可重新设定目标）";
			}
			return null;
		}
		// Goal review hook: after the run finished normally, if a goal is
		// active (and it belonged to the ACTIVE conversation) and we're not
		// already mid-review, spawn the isolated reviewer.
		if (
			g.goal &&
			g.conversationId === conv.id &&
			!g.reviewing &&
			!conv.wizardRunning &&
			!this.host.isDisposed()
		) {
			void this.runGoalReview(conv);
		}
		return null;
	}

	/** Build a "provider/id" or null for the reviewer model, validating it exists. */
	private resolveReviewModel(spec?: string | null): {
		provider: string;
		id: string;
		spec: string;
	} | null {
		return parseModelSpec(spec);
	}

	/**
	 * The whitelisted reviewer plan — tell the reviewer what to decide and how
	 * to report, regardless of which model it runs on.
	 */
	private reviewerPrompt(
		goal: string,
		round: number,
		maxRounds: number,
		output: string,
		gitDiff: string,
		customPrompt = "",
	): string {
		return [
			`You are a strict, independent goal-reviewer. Your ONLY job is to judge whether the agent's work fully satisfies the stated goal, by checking the agent's final output and, when present, its git diff.`, // eslint-disable-line max-len
			``,
			`# Goal`,                 // eslint-disable-line no-regex-spaces
			goal,
			``,
			`# Agent's final output`,  // eslint-disable-line no-regex-spaces
			output.length > 0 ? output : "(the agent produced no text — inspect the diff)",  // eslint-disable-line max-len
			``,
			`# Git diff (if any)`,     // eslint-disable-line no-regex-spaces
			gitDiff.length > 0 ? gitDiff : "(no staged/committed changes detected)",  // eslint-disable-line max-len
			``,
			`This is review round ${round}${maxRounds > 0 ? ` of up to ${maxRounds}` : " (no round cap — keep revising until it passes)"}.`,   // eslint-disable-line max-len
			...(customPrompt.trim()
				? [``, `# Additional reviewer instructions`, customPrompt.trim()]
				: []),
			``,
			`Decide: does the work satisfy the goal? If yes, respond with ONLY a JSON object with this exact shape (no markdown fences, no extra text):`, // eslint-disable-line max-len
			`{"verdict":"pass","feedback":"<one short sentence: what was satisfied>"}`, // eslint-disable-line max-len
			`If NO, respond with ONLY: {"verdict":"fail","feedback":"<concise, actionable list of what the agent must fix to satisfy the goal>"}`, // eslint-disable-line max-len
			`The feedback for a fail must be specific enough that the agent can act on it directly.`, // eslint-disable-line max-len
		].join("\n");
	}

	/** Insert a wizard progress card into the MAIN conversation flow and render it
	 *  IMMEDIATELY (the main session is idle while the wizard runs in its own
	 *  session, so — unlike nextTurn, which queues until the next user prompt —
	 *  sending without a delivery option appends + persists + emits at once). */
	private async pushWizardCard(
		sess: AgentSession,
		text: string,
		details?: { question?: string; answer?: string },
	): Promise<void> {
		try {
			await sess.sendCustomMessage(
				{
					customType: "goal-wizard",
					content: [{ type: "text", text }],
					display: true,
					details: { type: "goal-wizard", ...details },
				},
			);
		} catch {
			// Card insertion is cosmetic — never block the question flow on it.
		}
	}

	private isCurrentGoalReview(
		conv: GoalConversation,
		goalGeneration: number,
		reviewGeneration: number,
	): boolean {
		return (
			!this.host.isDisposed() &&
			this.host.getConv(conv.id) === conv &&
			conv.goal.conversationId === conv.id &&
			conv.goalGeneration === goalGeneration &&
			conv.goalReviewGeneration === reviewGeneration &&
			!!conv.goal.goal
		);
	}

	/** Drop the result of a review that became stale while it was awaiting the
	 * reviewer model (most commonly because the user switched conversations). */
	private discardStaleGoalReview(
		conv: GoalConversation,
		goalGeneration: number,
		reviewGeneration: number,
	): void {
		if (conv.goalReviewGeneration !== reviewGeneration) return;
		if (
			conv.goalGeneration === goalGeneration &&
			conv.goal.conversationId === conv.id
		) {
			conv.goal.reviewing = false;
			conv.goal.status = "审查已中止，目标已更新或取消";
			conv.goal.statusEn = "Review aborted, goal updated or cleared";
			this.emitGoalStatus();
		}
	}

	private async runGoalReview(conv: GoalConversation): Promise<void> {
		// The review is bound to the conversation that just ran. Capture both the
		// owner and a generation so a later switch/set/clear cannot let an old,
		// asynchronous reviewer mutate the new conversation's goal state.
		const mainConv = this.host.getConv(conv.id) ?? conv;
		const mainSession = mainConv.session;
		const g = conv.goal;
		if (
			!g.goal ||
			g.conversationId !== conv.id ||
			g.reviewing ||
			conv.wizardRunning ||
			this.host.isDisposed()
		)
			return;
		const goalGeneration = conv.goalGeneration;
		const reviewGeneration = ++conv.goalReviewGeneration;
		// Narrowed copy — TS control-flow can't narrow `g.goal` (a mutable shared
		// object field) through the entire async body, so capture it here.
		const goalText: string = g.goal;
		// Capture review-only settings for this run. Changing settings while a
		// review is in flight affects the next review, never this one.
		const reviewPrefs = this.host.reviewSettings();
		const reviewPrompt = reviewPrefs.reviewPrompt;
		const reviewDisabledSkills = new Set(reviewPrefs.reviewDisabledSkills);

		// Cap rounds: single-shot (locked=false) always exactly one review.
		// For locked goals, maxRounds 0 = unlimited (keep revising until pass).
		const budget = g.locked ? (g.maxRounds > 0 ? g.maxRounds : Infinity) : 1;
		if (g.locked && g.maxRounds > 0 && g.round >= budget) {
			g.status = `已达最大轮数（${budget}），停止审查`;
			g.statusEn = `Max rounds reached (${budget}), stopping review`;
			g.reviewing = false;
			this.emitGoalStatus();
			return;
		}

		g.reviewing = true;
		g.round += 1;
		g.verdict = "pending";
		g.feedback = undefined;
		g.status = `审查中（第 ${g.round} 轮）…`;
		g.statusEn = `Reviewing (round ${g.round})…`;
		this.emitGoalStatus();

		// Collect the review inputs.
		let finalText = "";
		try {
			finalText = mainSession.getLastAssistantText() ?? "";
		} catch {
			finalText = "";
		}
		const diff = await this.host.gitDiff(mainConv.cwd);
		if (!this.isCurrentGoalReview(conv, goalGeneration, reviewGeneration)) {
			this.discardStaleGoalReview(conv, goalGeneration, reviewGeneration);
			return;
		}

		let reviewerVerdict: "pass" | "fail" = "fail";
		let reviewerFeedback = "（审查无法完成）";

		try {
			const rmSpec = this.resolveReviewModel(g.reviewModel);
			const services = await createAgentSessionServices({
				cwd: mainConv.cwd,
				agentDir: this.host.agentDir,
				// The reviewer has its own skill allow/deny list. It deliberately does
				// not reuse the main session's disabledSkills setting.
				resourceLoaderOptions: {
					skillsOverride: (res) => ({
						...res,
						skills: res.skills.filter((s) => !reviewDisabledSkills.has(s.name)),
					}),
				},
				// A FRESH ModelRuntime for the reviewer — isolated from the shared
				// one used by the main conversations, so its model choice is its own.
				modelRuntime: await ModelRuntime.create({
					authPath: join(this.host.agentDir, "auth.json"),
					modelsPath: join(this.host.agentDir, "models.json"),
				}),
			});

			// Model resolution: explicit reviewer model, else the main session's
			// current model (so a goal works even when no reviewer model is given).
			let model;
			if (rmSpec) {
				model = services.modelRuntime.getModel(rmSpec.provider, rmSpec.id);
			}
			if (!model) {
				const mainModel = mainSession.model as { provider?: string; id?: string } | undefined;
				if (mainModel?.provider && mainModel.id) {
					model = services.modelRuntime.getModel(mainModel.provider, mainModel.id);
				}
			}

			const srv = await createAgentSessionFromServices({
				services,
				sessionManager: SessionManager.inMemory(mainConv.cwd),
				...(model ? { model } : {}),
			});
			const reviewCap = g.locked && g.maxRounds > 0 ? g.maxRounds : 0; // 0 = no cap
			const reviewer = srv.session;
			await reviewer.prompt(
				this.reviewerPrompt(
					goalText,
					g.round,
					reviewCap,
					finalText,
					diff,
					reviewPrompt,
				),
			);

			// Parse the reviewer's final output (expected to be a JSON object).
			const raw = reviewer.getLastAssistantText() ?? "";
			const m = raw.match(/\{\s*"verdict"\s*:\s*"(pass|fail)"[^}]*\}/);
			if (m) {
				reviewerVerdict = m[1] as "pass" | "fail";
				const fm = raw.match(/"feedback"\s*:\s*"([^"]*)"/);
				reviewerFeedback = fm?.[1] ?? "";
			} else {
				// No JSON — assume fail with the raw output as feedback.
				reviewerVerdict = "fail";
				reviewerFeedback = raw.slice(0, 2000);
			}
			await srv.session.dispose();
		} catch (err) {
			reviewerVerdict = "fail";
			reviewerFeedback = `审查过程中出错：${(err as Error).message}`;
		}

		// The user may have switched chats or replaced/cleared the goal while the
		// isolated reviewer was running. Never apply a stale verdict or inject it
		// into the old session after that point.
		if (!this.isCurrentGoalReview(conv, goalGeneration, reviewGeneration)) {
			this.discardStaleGoalReview(conv, goalGeneration, reviewGeneration);
			return;
		}
		g.reviewing = false;
		g.verdict = reviewerVerdict;
		g.feedback = reviewerFeedback;

		const round = g.round;
		// Display cap: 0 means "unlimited" (keep revising until pass).
		const budgetForCard = g.locked ? (Number.isFinite(budget) ? budget : 0) : 1;
		const verdict = reviewerVerdict;
		const feedback = reviewerFeedback;
		/** Rounds label for the goalStatus* keys — pre-rendered zh + en. */
		const roundsZh =
			budgetForCard > 0 ? `第 ${round}/${budgetForCard} 轮` : `第 ${round} 轮（不限）`;
		const roundsEn =
			budgetForCard > 0 ? `Round ${round}/${budgetForCard}` : `Round ${round} (unlimited)`;

		if (verdict === "pass") {
			g.status = "✅ 已通过目标审查";
			g.statusEn = "✅ Goal review passed";
			this.host.emit({ type: "notice", level: "info", text: "✅ 目标已通过审查",
			textEn: "✅ Goal passed review"
			});
			g.conversationId = null;
			g.goal = null; // a passed goal is done and cleared
			this.emitGoalStatus();
			// Pass = the review result goes straight into the conversation as an
			// ordinary user message (NO separate goal-review card). It both tells the
			// USER the outcome and hands the main agent back out of "goal mode", so a
			// follow-up instruction like "发布" is a normal request — not a confirm echo.
			try {
				await mainSession.sendUserMessage(
					`✅ 目标已达成并通过审查（第 ${round} 轮）。\n\n目标：${goalText}\n\n${feedback}\n\n（目标模式已解除，接下来按你的普通指令响应。）`,
					{ deliverAs: mainSession.isStreaming ? "steer" : "followUp" },
				);
			} catch {
				// Best-effort.
			}
			this.host.flushSnapshot();
			return;
		}

		// Failure: if rounds remain, steer a revision; else report the loop done.
		// For unlimited (budget=0) isLastRound is always false → keeps revising.
		const isLastRound = !g.locked ? true : g.maxRounds > 0 && g.round >= g.maxRounds;
		if (!isLastRound) {
			g.status = `本轮不通过，正在把意见交给 agent 修改（${roundsZh}）…`;
			g.statusEn = `Round failed, sending feedback to the agent (${roundsEn})…`;
			this.host.emit({
				type: "notice",
				level: "warning",
				text: `目标审查第 ${g.round}/${budgetForCard > 0 ? budgetForCard : "不限"} 轮未通过，把意见交给 agent 修改…`,
				textEn: `Goal review round ${g.round}/${budgetForCard > 0 ? budgetForCard : "unlimited"} failed; sending feedback to the agent…`,
			});
			// Inject the reviewer's feedback into the main session to revise (this IS
			// the fail review result, as an ordinary user message — no separate card).
			try {
				const steerText =
					`【目标审查：第 ${g.round}/${budgetForCard > 0 ? budgetForCard : "不限"} 轮未通过】\n\n目标：${goalText}\n\n` +
					`审查意见：${feedback}\n\n请根据以上意见修改你的成果，使其完全满足目标。`;
				await mainSession.sendUserMessage(steerText, {
					deliverAs: mainSession.isStreaming ? "steer" : "followUp",
				});
			} catch (err) {
				g.status = `意见注入失败：${(err as Error).message}`;
				g.statusEn = `Feedback injection failed: ${(err as Error).message}`;
			}
			this.emitGoalStatus();
			this.host.flushSnapshot();
			return;
		}

		// Rounds exhausted (finite cap reached / single-shot failed). Deliver the
		// fail result as an ordinary user message (no separate card), like the pass
		// and revise paths — the review result always lands in the conversation.
		if (g.locked && g.maxRounds > 0) {
			g.status = `已达最大轮数（${g.maxRounds}），目标仍未通过`;
			g.statusEn = `Max rounds reached (${g.maxRounds}), goal still failing`;
		} else {
			g.status = `目标未通过（${roundsZh}）`;
			g.statusEn = `Goal failed (${roundsEn})`;
		}
		try {
			await mainSession.sendUserMessage(
				`❌ 目标未通过审查（第 ${round}/${budgetForCard > 0 ? budgetForCard : "不限"} 轮）。\n\n目标：${goalText}\n\n审查意见：${feedback}`,
				{ deliverAs: mainSession.isStreaming ? "steer" : "followUp" },
			);
		} catch {
			// Best-effort.
		}
		this.host.emit({ type: "notice", level: "warning", text: "目标未通过审查（已达最大轮数）",
		textEn: "Goal failed review (max rounds reached)"
		});
		g.conversationId = null;
		g.goal = null; // loop exhausted — clear the active goal
		this.emitGoalStatus();
		this.host.flushSnapshot();
	}
}
