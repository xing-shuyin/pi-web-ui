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
import type { GoalStatus, ServerMessage } from "./protocol.js";
import type { ClientStateStore } from "./client-state.js";
import { pick, type ServerLang } from "./i18n.js";
import { parseModelSpec } from "./attachments.js";
import type { WebUIContext } from "./webui-context.js";

/** ClientSession 私有 Conversation 中 goal 家族会触碰的字段（结构化子集）。 */
export interface GoalConversation {
	id: string;
	/** Display title (used in notices that name the conversation). */
	title: string;
	cwd: string;
	session: AgentSession;
	/** 调研进行中（互斥审查触发）。 */
	wizardRunning: boolean;
	/** set/clear/stop 都 +1：作废还在飞的异步审查回调。 */
	goalGeneration: number;
	goalReviewGeneration: number;
	goal: GoalStatus;
	/** 连续无文件改动/无进展轮数 */
	stagnantRounds?: number;
	/** 上一轮的 git diff 快照 */
	lastDiff?: string;
	/** 上一轮的错误特征 */
	lastErrorSnippet?: string;
	/** 连续相同错误轮数 */
	sameErrorRounds?: number;
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
	/** 面向模型/工具返回字符串的服务端语言（默认英文）；推给 UI 的 notice 仍走 text+textEn 双字段。 */
	lang?: () => ServerLang;
	/** 目标模式总开关（设置面板「目标审查」页可关）。关 → 拒绝设目标/调研/审查。 */
	goalModeEnabled: () => boolean;
}

/**
 * 自主模式完成标记（与注入对话的【目标…】约定严格一致）：
 *  - 【目标已达成】/【目标完成】/【目标达成】——必须带全角括号；
 *  - GOAL 后必须跟至少一个分隔符（冒号/下划线/空白）且 COMPLETED/PASSED 为整词。
 * 刻意不收裸子串（如「目标已达成」不带括号）：模型在计划、复述目标或假设句里
 * 也会写出这些字样（"如果测试全绿则目标已达成"），裸匹配会把中间轮误判成 pass。
 */
const GOAL_COMPLETION_RE =
	/【目标(?:已)?(?:达成|完成)】|(?<![A-Za-z])GOAL(?:[:：_]|\s+)+(?:IS\s+)?(?:COMPLETED|PASSED)(?![A-Za-z])/i;

/** 自主轮次完成信号判定（纯函数，供 runGoalReview 与单测共用）。 */
export function isGoalCompletionSignal(finalText: string): boolean {
	return GOAL_COMPLETION_RE.test(finalText);
}

/** 剥离复制调研草案卡片时带入的前缀（支持中英文与多层重复，纯函数供单测共用）。 */
export function stripGoalDraftPrefix(raw: string): string {
	return (raw ?? "")
		.trim()
		.replace(/^(?:(?:🎯\s*)?(?:Initial goal draft|原始目标草案)\s*[:：]\s*)+/i, "")
		.trim();
}

/**
 * 从主会话消息列表中提取结构化上下文（压缩摘要 + 近期轮次），注入向导 prompt，
 * 避免向导会话处于无上下文的盲搜状态（借鉴 pi-goal-x / pi-plan 的 warm context 设计）。
 */
export function buildWizardConversationContext(messages: unknown[], maxChars = 16_000): string {
	if (!Array.isArray(messages) || messages.length === 0) return "";
	let summaryPart = "";
	const recentLines: string[] = [];

	for (const m of messages) {
		if (!m || typeof m !== "object") continue;
		const msg = m as {
			role?: string;
			summary?: string;
			content?: unknown;
			toolName?: string;
		};
		if (msg.role === "compactionSummary" && typeof msg.summary === "string" && msg.summary.trim()) {
			const s = msg.summary.trim();
			summaryPart = s.length > 8000 ? s.slice(0, 4000) + "\n...\n" + s.slice(-4000) : s;
		} else if (msg.role === "user" || msg.role === "assistant") {
			const parts: string[] = [];
			if (Array.isArray(msg.content)) {
				for (const c of msg.content) {
					if (!c || typeof c !== "object") continue;
					const block = c as {
						type?: string;
						text?: string;
						name?: string;
						arguments?: Record<string, unknown>;
					};
					if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
						parts.push(block.text.trim());
					} else if (block.type === "toolCall" && block.name) {
						const args = block.arguments;
						const target = args?.path || args?.file_path || args?.pattern || args?.command || args?.query || "";
						parts.push(`[tool:${block.name}${target ? " " + String(target).slice(0, 80) : ""}]`);
					}
				}
			} else if (typeof msg.content === "string" && msg.content.trim()) {
				parts.push(msg.content.trim());
			}
			if (parts.length > 0) {
				const joined = parts.join(" ").slice(0, 2000);
				recentLines.push(`[${msg.role}]: ${joined}`);
			}
		}
	}

	const recentBudget = summaryPart ? Math.max(4000, maxChars - summaryPart.length) : maxChars;
	let recentAcc = "";
	for (let i = recentLines.length - 1; i >= 0; i--) {
		const line = recentLines[i];
		if (recentAcc.length + line.length + 1 > recentBudget) break;
		recentAcc = line + (recentAcc ? "\n" + recentAcc : "");
	}

	const sections: string[] = [];
	if (summaryPart) sections.push(`## Previous Context Summary\n${summaryPart}`);
	if (recentAcc) sections.push(`## Recent Conversation Turns\n${recentAcc}`);
	return sections.join("\n\n").slice(0, maxChars);
}

/** 提取 raw 中第一个括号平衡的 {...} 子串（字符串字面量内的引号/转义/花括号不参与配对）。 */
function firstBalancedJsonObject(raw: string): string | undefined {
	const start = raw.indexOf("{");
	if (start < 0) return undefined;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < raw.length; i++) {
		const ch = raw[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return raw.slice(start, i + 1);
		}
	}
	return undefined;
}

/**
 * 解析审查模型的 verdict 输出（纯函数）。优先取第一个平衡 {...} 做 JSON.parse：
 * 模型常包 markdown 围栏或前后闲话，feedback 里也可能有 \" 转义与嵌套引号，
 * 这些由 JSON 语义天然处理；整体解析失败（单引号/尾逗号等）再退回旧的宽松
 * 正则逐字段抠。两者都失败返回 undefined，调用方按「无 JSON」处理。
 */
export function parseReviewerVerdict(raw: string): { verdict: "pass" | "fail"; feedback: string } | undefined {
	const json = firstBalancedJsonObject(raw);
	if (json !== undefined) {
		try {
			const value = JSON.parse(json) as { verdict?: unknown; feedback?: unknown };
			if (value && typeof value === "object" && !Array.isArray(value)) {
				if (value.verdict === "pass" || value.verdict === "fail") {
					return { verdict: value.verdict, feedback: typeof value.feedback === "string" ? value.feedback : "" };
				}
			}
		} catch {
			// 不是合法 JSON（围栏残留/单引号/尾逗号）→ 落到正则兜底
		}
	}
	const m = raw.match(/\{\s*"verdict"\s*:\s*"(pass|fail)"[^}]*\}/);
	if (m) {
		const fm = raw.match(/"feedback"\s*:\s*"([^"]*)"/);
		return { verdict: m[1] as "pass" | "fail", feedback: fm?.[1] ?? "" };
	}
	return undefined;
}

/** diff 正文进审查 prompt 的截断上限（完整规模信息走 [diff-meta] 尾段）。 */
export const GIT_DIFF_CAP = 60_000;

/**
 * 由 git 原始输出构造「变更指纹」（纯函数，供 AgentService.gitDiff 与单测共用）。
 *  - diff 正文非空 → 截断正文 + [diff-meta] 尾段（完整字符数 + 排序后的 status
 *    指纹）。尾段永不参与截断：大 diff 两轮的前 60_000 字符可能完全相同（改动
 *    落在截断线之后），只比截断正文会把持续推进误判成停滞；对内容变化敏感的
 *    完整字符数让 prevDiff 等值比较能区分「真没变」与「变了但被截断」。
 *  - diff 正文为空 → 排序后的 `git status --porcelain` 指纹（未跟踪文件不进
 *    diff，却是新工作区最常见的实际进展）；两段都空（返回 ""）才算真停滞。
 *  - status 输出为空/拍不到 → 对应段省略，退化为旧版纯 diff 行为。
 */
export function buildDiffFingerprint(diffOut: string, statusOut: string): string {
	let status = "";
	if (statusOut.trim() !== "") {
		// porcelain 不承诺输出有序，显式排序保证指纹逐轮稳定可比。
		status = statusOut
			.split("\n")
			.filter((line) => line.trim() !== "")
			.sort()
			.join("\n")
			.slice(0, 20_000);
	}
	if (diffOut.trim() === "") return status;
	const meta = `\n[diff-meta] chars=${diffOut.length}${status ? `\n[git-status]\n${status}` : ""}`;
	return diffOut.slice(0, GIT_DIFF_CAP) + meta;
}

/** System prompt for the goal-wizard session. The wizard asks the user a few
 *  questions (via its goal_ask tool) to scope a raw requirement into a precise,
 *  reviewable goal, then emits ONLY the final goal text as its last message. */
function wizardPrompt(draft: string, contextSummary = ""): string {
	return [
		`You are a goal-clarification wizard. The user has stated a raw requirement. Your job is to turn it into ONE precise, actionable goal that a coding agent can fully satisfy and that can be strictly reviewed.`, // eslint-disable-line max-len
		...(contextSummary ? [``, `# Current conversation context (background & recent history)`, contextSummary] : []),
		``,
		`# User's raw requirement`, // eslint-disable-line no-regex-spaces
		draft,
		``,
		`Use your goal_ask tool to ask the user focused questions to pin down the essential, ambiguous details.`,
		`Convergence guidelines:`,
		`- Ground your understanding in the conversation context above so you already know what files, models, and prior work the user is referring to. Do NOT re-ask things already clear from context.`, // eslint-disable-line max-len
		`- If you need to verify a specific file or directory in the workspace, do at most 1 to 3 quick read-only checks (read/ls/find/grep), then IMMEDIATELY call goal_ask. Never do exhaustive exploration or attempt the actual task during scoping.`, // eslint-disable-line max-len
		`- Ask ONE question at a time, strictly 1 to 3 questions total: what exactly to build/do, scope boundaries (what NOT to do), acceptance criteria / done-definition, and any constraints (style, performance, environment).`, // eslint-disable-line max-len
		`- Prefer multiple-choice with 2-4 mutually exclusive options and place your recommended choice FIRST.`,
		`- In each option, concisely explain the impact or tradeoff. Use open questions only for things that genuinely need free text.`, // eslint-disable-line max-len
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

	/** 当前服务端语言（英文默认，未接线前保持原有英文行为）。 */
	private lang(): ServerLang {
		return this.host.lang?.() ?? "en";
	}

	/** 目标模式总开关（设置面板可关）。关 → 所有目标入口拒绝、审查不再触发。 */
	private goalEnabled(): boolean {
		return this.host.goalModeEnabled();
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
	 *
	 * `opts.targetConvId` retargets the write to a specific conversation — used by
	 * the goal wizard, which runs in the background while the user may have
	 * switched away: the refined goal must land in the conversation that LAUNCHED
	 * the survey (issue #292), not in whatever conversation happens to be active
	 * and not be thrown away.
	 */
	async setGoal(
		goalText: string,
		opts?: {
			reviewModel?: string;
			maxRounds?: number;
			locked?: boolean;
			/** Apply the goal to this conversation instead of the active one. */
			targetConvId?: string;
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
		if (!this.goalEnabled()) {
			this.host.emit({
				type: "notice",
				level: "warning",
				text: "目标模式已关闭：请先在设置「目标审查」中启用目标模式。",
				textEn: "Goal mode is off: enable it under Settings → Goal review first.",
			});
			return;
		}
		// A goal is scoped to the conversation it is set on (default: the active
		// one). This prevents an agent_end from a newly-created/switched conversation
		// from consuming the previous conversation's goal.
		const targetConv = opts?.targetConvId ? this.host.getConv(opts.targetConvId) : undefined;
		if (opts?.targetConvId && !targetConv) {
			// The targeted conversation is gone (closed / disposed) — refuse loudly
			// instead of silently landing the goal somewhere else.
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
		conv.stagnantRounds = 0;
		conv.lastDiff = undefined;
		conv.lastErrorSnippet = undefined;
		conv.sameErrorRounds = 0;
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
				const kick = pick(
					this.lang(),
					`【目标已设定】\n\n${text}\n\n请现在开始实现这个目标。`,
					`[Goal set]\n\n${text}\n\nStart implementing this goal now.`,
					"goal.set.kick",
					{ text: text },
				);
				await s.sendUserMessage(kick, {
					deliverAs: s.isStreaming ? "steer" : "followUp",
				});
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

		// The wizard and its progress cards belong to the conversation that
		// launched it. If the user switches away, do not later set a goal on the
		// new active conversation while the wizard is still finishing.
		const wizardConversationId = this.host.activeConvId();
		const wizardConversation = this.host.activeConv();
		// Human-readable name for notices that must say WHICH conversation the survey
		// belongs to (issue #292: the user is expected to switch away mid-survey).
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
		// Idle-timeout: cancel the wizard if the user does NOT answer a pending dialog
		// within the window (a stale dialog with no user response must not hang forever).
		// Note: armed strictly while waiting for the user's answer in goal_ask, and
		// cleared once the user answers — model thinking / read-only checks are governed
		// by totalTimer, avoiding false "waited too long for an answer" timeouts.
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
		// Total-duration guard: hard cap on the whole wizard session (model
		// latency / unexpected loops must not run forever).
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

		// The main conversation to show wizard progress cards in.
		const mainSession = wizardConversation.session;
		// The raw draft gets its own read-only card BEFORE the first question, so the
		// flow starts from a visible anchor. If the survey is interrupted (idle/total
		// timeout, ✗, or the user switching away and never coming back), the original
		// requirement is still readable and copyable in THIS conversation instead of
		// having to be retyped (issue #292).
		await this.pushWizardCard(
			mainSession,
			pick(this.lang(), `🎯 原始目标草案：${draft}`, `🎯 Initial goal draft: ${draft}`, "goal.wizard.draft.card", {
				draft,
			}),
			{ draft },
		);

		let refinedGoal = "";
		let goalEphemeralDir: string | undefined;
		try {
			const wmSpec = opts?.wizardModel ? this.resolveReviewModel(opts.wizardModel) : null; // reuse the honest "provider/id" parser
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

			// The wizard asks the user questions via this tool; each call bridges one
			// select/input dialog to the browser and returns the user's answer.
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
				// ONE question at a time. Sequential execution prevents the agent from
				// firing parallel goal_ask calls whose dialogs would overwrite each other
				// in the single browser modal (leaving earlier ones deadlocked — the
				// reported "调研卡住").
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
					// Show the question in the main flow BEFORE blocking on the dialog, so
					// the user sees the wizard working even before answering.
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
						// Resolve the pending dialog as cancelled if the wizard is aborted.
						let aborted = false;
						const onAbort = () => {
							aborted = true;
						};
						ac.signal.addEventListener("abort", onAbort, { once: true });
						const choose = isChoice ? ctx.ui.select(qTitle, params.options!) : ctx.ui.input(qTitle);
						const ans = (await choose) as string | boolean | undefined;
						ac.signal.removeEventListener("abort", onAbort);
						clearIdle();
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
						// Record the answer in the flow too (instant append, main session idle).
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
				// 仅暴露提问工具与只读检索工具：允许向导在提问前查阅工作区文件细节，
				// 但严禁调用 bash/edit/write 等具破坏性或耗时不可控的写/执行工具。
				tools: ["goal_ask", "read", "ls", "find", "grep"],
				...(model ? { model } : {}),
			});
			const wizard = srv.session;
			this.wizardSession = wizard;
			await wizard.bindExtensions({ mode: "rpc", uiContext: this.host.webUi });

			// 实时反馈：向导查阅上下文文件时，在目标栏展示当前动作，告别黑盒等待
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

			// 扩展动态注册的模型（如 cliproxyapi/grok-4.7）在 bindExtensions 后才进入 ModelRuntime，此处兜底补绑
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
					} catch {
						/* best-effort */
					}
				}
			}
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

			// 从发起调研的主会话中提取上下文历史（摘要与近期轮次），避免孤立向导完全失忆
			const mainMessages =
				(
					mainSession as unknown as { sessionManager?: { buildSessionContext?: () => { messages?: unknown[] } } }
				).sessionManager?.buildSessionContext?.()?.messages ??
				(mainSession as unknown as { messages?: unknown[] }).messages ??
				[];
			const contextSummary = buildWizardConversationContext(mainMessages);

			try {
				await wizard.prompt(wizardPrompt(draft, contextSummary));
			} finally {
				unsubscribe();
			}
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
			if (goalEphemeralDir) {
				try {
					rmSync(goalEphemeralDir, { recursive: true, force: true });
				} catch {}
			}
			this.emitGoalStatus();
		}

		// Aborted externally (✗ / clear_goal / idle-timeout): do NOT set a goal. The raw
		// draft card stays in the launching conversation's flow, so the user can read
		// it back (and retry) instead of having to retype it (issue #292).
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
			this.wizardAbort = null;
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
		// The survey belongs to the conversation that launched it. The user is EXPECTED
		// to switch away while the questions are being answered (check code, read docs),
		// so "active ≠ launcher" is the normal case, not an error: land the refined goal
		// on the launcher instead of discarding the work (issue #292).
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
		const switchedAway = this.host.activeConvId() !== wizardConversationId;
		// Auto-set the refined goal. The wizard workflow implies "set a goal and
		// work until it passes", so default LOCKED=true unless the user explicitly
		// turned the lock off (a lock lets the review loop keep revising to pass;
		// without it the review is single-shot).
		const wantLocked = opts?.locked === undefined ? true : opts.locked;
		await this.setGoal(refinedGoal, {
			reviewModel: wgoal.reviewModel ?? undefined,
			maxRounds: opts?.maxRounds,
			locked: wantLocked,
			// Land the goal on the conversation that launched the survey, even if the
			// user is looking at another one right now (issue #292).
			targetConvId: wizardConversationId,
			// The wizard kicks off generation itself below — avoid a double kick.
			autoStart: false,
		});
		this.wizardCancelled = false;
		this.wizardAbort = null;
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
		// Kick the main agent into generating right away (no manual "开始吧").
		// The kick-off is a user message so it appears in the flow and triggers a
		// normal turn; the finishing agent_end then runs the review loop.
		try {
			const wizardKick = pick(
				this.lang(),
				`【目标已设定】\n\n${wgoal.goal}\n\n请现在开始实现这个目标。`,
				`[Goal set]\n\n${wgoal.goal}\n\nStart implementing this goal now.`,
				"goal.wizard.kick",
				{ "wgoal.goal": wgoal.goal },
			);
			await mainSession.sendUserMessage(wizardKick, {
				deliverAs: mainSession.isStreaming ? "steer" : "followUp",
			});
		} catch {
			// Generation kick-off is best-effort; the user can still prompt manually.
		}
	}

	/** Persist goal/review preference defaults (model, rounds cap, locked) without
	 *  touching the active goal — so changes in the goal bar are remembered across
	 *  reloads. maxRounds 0 = unlimited. Emits goal_status so the UI stays synced. */
	async setGoalPrefs(opts?: { reviewModel?: string; maxRounds?: number; locked?: boolean }): Promise<void> {
		if (!this.goalEnabled()) return;
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
		conv.stagnantRounds = 0;
		conv.lastDiff = undefined;
		conv.lastErrorSnippet = undefined;
		conv.sameErrorRounds = 0;
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
	onAgentEnd(conv: GoalConversation, aborted: boolean): { text: string; textEn: string } | null {
		const g = conv.goal;
		if (aborted) {
			if (g.goal && g.conversationId === conv.id) {
				conv.goalGeneration += 1;
				conv.stagnantRounds = 0;
				conv.lastDiff = undefined;
				conv.lastErrorSnippet = undefined;
				conv.sameErrorRounds = 0;
				g.conversationId = null;
				g.goal = null;
				g.reviewing = false;
				g.verdict = "pending";
				g.feedback = undefined;
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
		// Goal review hook: after the run finished normally, if a goal is
		// active (and it belonged to the ACTIVE conversation) and we're not
		// already mid-review, spawn the isolated reviewer.
		// Only run when verdict is pending — failed/blocked terminal goals must not
		// re-trigger reviews on subsequent unrelated conversational turns.
		if (
			g.goal &&
			g.conversationId === conv.id &&
			!g.reviewing &&
			g.verdict === "pending" &&
			!conv.wizardRunning &&
			!this.host.isDisposed() &&
			this.goalEnabled()
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

	/** 提取会话最近产生的错误特征，用于停滞与相同报错检测。 */
	private extractErrorSnippet(session: AgentSession, text: string): string | undefined {
		try {
			const messages = session.agent?.state?.messages;
			if (Array.isArray(messages)) {
				for (let i = messages.length - 1; i >= 0 && i >= messages.length - 6; i--) {
					const m = messages[i];
					if (m.role === "toolResult" && m.isError) {
						const errText = m.content
							?.map((c) => (c.type === "text" ? c.text : ""))
							.join(" ")
							.trim();
						if (errText) return errText.slice(0, 300);
					}
					if (m.role === "bashExecution" && m.exitCode && m.exitCode !== 0) {
						const snippet = m.output?.trim().slice(-300);
						if (snippet) return `bash exit ${m.exitCode}: ${snippet}`;
					}
				}
			}
		} catch {
			// Ignore
		}
		const errMatch = text.match(/(?:(?:Error|Exception|Fail|Fatal):[^\n]+)/i);
		if (errMatch) {
			return errMatch[0].trim().slice(0, 300);
		}
		return undefined;
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
			`# Goal`, // eslint-disable-line no-regex-spaces
			goal,
			``,
			`# Agent's final output`, // eslint-disable-line no-regex-spaces
			output.length > 0 ? output : "(the agent produced no text — inspect the diff)", // eslint-disable-line max-len
			``,
			`# Git diff (if any)`, // eslint-disable-line no-regex-spaces
			gitDiff.length > 0 ? gitDiff : "(no staged/committed changes detected)", // eslint-disable-line max-len
			``,
			`This is review round ${round}${maxRounds > 0 ? ` of up to ${maxRounds}` : " (no round cap — keep revising until it passes)"}.`, // eslint-disable-line max-len
			...(customPrompt.trim() ? [``, `# Additional reviewer instructions`, customPrompt.trim()] : []),
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
		details?: { question?: string; answer?: string; draft?: string },
	): Promise<void> {
		try {
			await sess.sendCustomMessage({
				customType: "goal-wizard",
				content: [{ type: "text", text }],
				display: true,
				details: { type: "goal-wizard", ...details },
			});
		} catch {
			// Card insertion is cosmetic — never block the question flow on it.
		}
	}

	private isCurrentGoalReview(conv: GoalConversation, goalGeneration: number, reviewGeneration: number): boolean {
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
	private discardStaleGoalReview(conv: GoalConversation, goalGeneration: number, reviewGeneration: number): void {
		if (conv.goalReviewGeneration !== reviewGeneration) return;
		if (conv.goalGeneration === goalGeneration && conv.goal.conversationId === conv.id) {
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
		if (!g.goal || g.conversationId !== conv.id || g.reviewing || conv.wizardRunning || this.host.isDisposed()) return;
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

		let reviewerVerdict: "pass" | "fail" | "blocked" = "fail";
		let reviewerFeedback = pick(
			this.lang(),
			"（审查无法完成）",
			"(The review could not be completed)",
			"goal.review.incomplete",
		);

		// 停滞与错误检测分析（DSH 风格防死循环与停滞检测）：
		const currentError = this.extractErrorSnippet(mainSession, finalText);
		const prevError = conv.lastErrorSnippet;
		if (
			currentError &&
			prevError &&
			(currentError === prevError || currentError.includes(prevError) || prevError.includes(currentError))
		) {
			conv.sameErrorRounds = (conv.sameErrorRounds ?? 0) + 1;
		} else {
			conv.sameErrorRounds = currentError ? 1 : 0;
		}
		conv.lastErrorSnippet = currentError;

		const trimmedDiff = diff.trim();
		const prevDiff = conv.lastDiff;
		const isNoDiffChange = trimmedDiff === "" || (prevDiff !== undefined && trimmedDiff === prevDiff);
		if (isNoDiffChange) {
			conv.stagnantRounds = (conv.stagnantRounds ?? 0) + 1;
		} else {
			conv.stagnantRounds = 0;
		}
		conv.lastDiff = trimmedDiff;

		const isAutonomous = !g.reviewModel;
		if (isAutonomous) {
			// DSH 风格自主轮次驱动（免拉起独立审查会话，省 token + 零启动延迟）：
			// 检查模型自身是否在输出中表明目标已达成（只认约定标记，见 GOAL_COMPLETION_RE）
			const isCompleted = isGoalCompletionSignal(finalText);
			if (isCompleted) {
				reviewerVerdict = "pass";
				reviewerFeedback = pick(
					this.lang(),
					"模型自主验证：目标已达成",
					"Model autonomous evaluation: Goal completed",
					"goal.autonomous.pass",
				);
			} else if ((conv.sameErrorRounds ?? 0) >= 2 || (conv.stagnantRounds ?? 0) >= 2) {
				// 触发防死循环与停滞熔断（Blocked）
				reviewerVerdict = "blocked";
				const blockedReason =
					(conv.sameErrorRounds ?? 0) >= 2
						? `连续 ${conv.sameErrorRounds} 轮出现相同错误：${currentError}`
						: `连续 ${conv.stagnantRounds} 轮未检测到有效文件修改或实质进展`;
				const blockedReasonEn =
					(conv.sameErrorRounds ?? 0) >= 2
						? `Identical error across ${conv.sameErrorRounds} consecutive rounds: ${currentError}`
						: `No effective file modifications or progress across ${conv.stagnantRounds} consecutive rounds`;
				reviewerFeedback = pick(
					this.lang(),
					`【目标防死循环保护：执行受阻（Blocked）】\n\n` +
						`• 停滞原因：${blockedReason}\n` +
						`• 当前轮次：第 ${g.round} 轮\n` +
						`• 诊断分析：智能体在自主推进中连续轮次未产生有效进展或反复遭遇相同错误，已自动熔断以防止无谓消耗 token。\n` +
						`• 建议措施：请检查相关代码、工具权限或手动调整提示词，排查阻碍后再继续。`,
					`[Goal Infinite-Loop Protection: Blocked]\n\n` +
						`• Cause: ${blockedReasonEn}\n` +
						`• Current round: Round ${g.round}\n` +
						`• Diagnosis: Agent made no progress or encountered identical errors across consecutive rounds. Circuit breaker tripped to prevent token waste.\n` +
						`• Recommendation: Please check code, tool permissions, or refine prompt before proceeding.`,
					"goal.review.blocked",
					{ blockedReason, blockedReasonEn, round: g.round },
				);
			} else {
				reviewerVerdict = "fail";
				reviewerFeedback = pick(
					this.lang(),
					"目标尚未完成，自主推进下一轮迭代验证。",
					"Goal not yet completed; continuing to next iteration.",
					"goal.autonomous.continue",
				);
			}
		} else {
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
				if (!model) {
					try {
						await reviewer.bindExtensions({ mode: "rpc" });
						if (rmSpec) model = services.modelRuntime.getModel(rmSpec.provider, rmSpec.id);
						if (!model) {
							const mainModel = mainSession.model as { provider?: string; id?: string } | undefined;
							if (mainModel?.provider && mainModel.id) {
								model = services.modelRuntime.getModel(mainModel.provider, mainModel.id);
							}
						}
						if (model) await reviewer.setModel(model);
					} catch {
						/* best-effort */
					}
				}
				await reviewer.prompt(this.reviewerPrompt(goalText, g.round, reviewCap, finalText, diff, reviewPrompt));

				// Parse the reviewer's final output (expected to be a JSON object).
				const raw = reviewer.getLastAssistantText() ?? "";
				const parsed = parseReviewerVerdict(raw);
				if (parsed) {
					reviewerVerdict = parsed.verdict;
					reviewerFeedback = parsed.feedback;
				} else {
					// No JSON — assume fail with the raw output as feedback.
					reviewerVerdict = "fail";
					reviewerFeedback = raw.slice(0, 2000);
				}
				await srv.session.dispose();
			} catch (err) {
				const reviewErrMsg = (err as Error).message;
				reviewerVerdict = "fail";
				reviewerFeedback = pick(
					this.lang(),
					`审查过程中出错：${reviewErrMsg}`,
					`Error during review: ${reviewErrMsg}`,
					"goal.review.error",
					{ reviewErrMsg: reviewErrMsg },
				);
			}
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
		const roundsZh = budgetForCard > 0 ? `第 ${round}/${budgetForCard} 轮` : `第 ${round} 轮（不限）`;
		const roundsEn = budgetForCard > 0 ? `Round ${round}/${budgetForCard}` : `Round ${round} (unlimited)`;

		if (verdict === "pass") {
			g.status = "✅ 已通过目标审查";
			g.statusEn = "✅ Goal review passed";
			this.host.emit({ type: "notice", level: "info", text: "✅ 目标已通过审查", textEn: "✅ Goal passed review" });
			g.conversationId = null;
			g.goal = null; // a passed goal is done and cleared
			this.emitGoalStatus();
			// Pass = the review result goes straight into the conversation as an
			// ordinary user message (NO separate goal-review card). It both tells the
			// USER the outcome and hands the main agent back out of "goal mode", so a
			// follow-up instruction like "发布" is a normal request — not a confirm echo.
			try {
				const passText = pick(
					this.lang(),
					`✅ 目标已达成并通过审查（第 ${round} 轮）。\n\n目标：${goalText}\n\n${feedback}\n\n（目标模式已解除，接下来按你的普通指令响应。）`,
					`✅ Goal achieved and passed review (round ${round}).\n\nGoal: ${goalText}\n\n${feedback}\n\n(Goal mode is off — respond to further instructions normally.)`,
					"goal.review.pass",
					{ round: round, goalText: goalText, feedback: feedback },
				);
				await mainSession.sendUserMessage(passText, { deliverAs: mainSession.isStreaming ? "steer" : "followUp" });
			} catch {
				// Best-effort.
			}
			this.host.flushSnapshot();
			return;
		}

		if (verdict === "blocked") {
			g.status = "⚠️ 目标受阻（停滞熔断）";
			g.statusEn = "⚠️ Goal blocked (stagnation circuit break)";
			this.host.emit({
				type: "notice",
				level: "warning",
				text: "⚠️ 目标执行受阻：检测到停滞或相同报错，已自动暂停",
				textEn: "⚠️ Goal execution blocked: stagnation or repeated error detected, auto-loop paused",
			});
			try {
				const blockedText = pick(
					this.lang(),
					`⚠️ 目标执行受阻（第 ${round} 轮已触发停滞熔断）。\n\n目标：${goalText}\n\n${feedback}\n\n（目标模式已暂停，请在排查问题后重新设定目标或手动继续。）`,
					`⚠️ Goal execution blocked (stagnation circuit breaker at round ${round}).\n\nGoal: ${goalText}\n\n${feedback}\n\n(Goal mode paused — please investigate and reset goal or continue manually.)`,
					"goal.review.blocked_msg",
					{ round, goalText, feedback },
				);
				await mainSession.sendUserMessage(blockedText, {
					deliverAs: mainSession.isStreaming ? "steer" : "followUp",
				});
			} catch {
				// Best-effort.
			}
			g.reviewing = false;
			this.emitGoalStatus();
			this.host.flushSnapshot();
			return;
		}

		// Failure: if rounds remain, steer a revision; else report the loop done.
		// For unlimited (budget=0) isLastRound is always false → keeps revising.
		const isLastRound = !g.locked ? true : g.maxRounds > 0 && g.round >= g.maxRounds;
		if (!isLastRound) {
			g.status = `本轮不通过，正在把意见交给 agent 修改（${roundsZh}）…`;
			g.statusEn = `Round failed, sending feedback to the agent (${roundsEn})…`;
			// 注入修改意见后保持 verdict 为 pending，让 agent 下一次答完后继续下一轮审查
			g.verdict = "pending";
			this.host.emit({
				type: "notice",
				level: "warning",
				text: `目标审查第 ${g.round}/${budgetForCard > 0 ? budgetForCard : "不限"} 轮未通过，把意见交给 agent 修改…`,
				textEn: `Goal review round ${g.round}/${budgetForCard > 0 ? budgetForCard : "unlimited"} failed; sending feedback to the agent…`,
			});
			// Inject the reviewer's feedback into the main session to revise (this IS
			// the fail review result, as an ordinary user message — no separate card).
			try {
				const capped = budgetForCard > 0 ? budgetForCard : "不限";
				const cappedEn = budgetForCard > 0 ? budgetForCard : "unlimited";
				const steerText = pick(
					this.lang(),
					`【目标审查：第 ${g.round}/${capped} 轮未通过】\n\n目标：${goalText}\n\n` +
						`审查意见：${feedback}\n\n请根据以上意见修改你的成果，使其完全满足目标。`,
					`[Goal review: round ${g.round}/${cappedEn} failed]\n\nGoal: ${goalText}\n\n` +
						`Feedback: ${feedback}\n\nRevise your work based on the feedback above so it fully satisfies the goal.`,
					"goal.review.revise",
					{ "g.round": g.round, capped: capped, goalText: goalText, feedback: feedback, cappedEn: cappedEn },
				);
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
			const capped = budgetForCard > 0 ? budgetForCard : "不限";
			const cappedEn = budgetForCard > 0 ? budgetForCard : "unlimited";
			await mainSession.sendUserMessage(
				pick(
					this.lang(),
					`❌ 目标未通过审查（第 ${round}/${capped} 轮）。\n\n目标：${goalText}\n\n审查意见：${feedback}`,
					`❌ Goal failed review (round ${round}/${cappedEn}).\n\nGoal: ${goalText}\n\nFeedback: ${feedback}`,
					"goal.review.fail",
					{ round: round, capped: capped, goalText: goalText, feedback: feedback, cappedEn: cappedEn },
				),
				{ deliverAs: mainSession.isStreaming ? "steer" : "followUp" },
			);
		} catch {
			// Best-effort.
		}
		this.host.emit({
			type: "notice",
			level: "warning",
			text: "目标未通过审查（已达最大轮数）",
			textEn: "Goal failed review (max rounds reached)",
		});
		g.reviewing = false; // 审查结束：保留 g.goal 与 g.conversationId，让用户看到未通过的目标，不丢弃目标文本
		this.emitGoalStatus();
		this.host.flushSnapshot();
	}
}
