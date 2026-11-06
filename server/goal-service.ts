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
import type { ClientStateStore } from "./client-state.js";
import { getServerString, pick, type ServerLang } from "./i18n.js";
import { parseModelSpec } from "./attachments.js";
import type { WebUIContext } from "./webui-context.js";

export interface GoalConversation {
	id: string;
	title: string;
	cwd: string;
	session: AgentSession;
	wizardRunning: boolean;
	goalGeneration: number;
	goal: GoalStatus;
	stagnantRounds?: number;
	failedRounds?: number;
	execUsageBefore?: { input: number; output: number };
	reviewUsageBefore?: { input: number; output: number };
	goalUsage?: { input: number; output: number };
	goalHistory?: GoalHistoryEntry[];
	lastDiff?: string;
	lastErrorSnippet?: string;
	sameErrorRounds?: number;
	roleExec?: { convId: string; generation: number };
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

function allBalancedJsonObjects(raw: string): string[] {
	const src = raw.length > 32768 ? raw.slice(-32768) : raw;
	const out: string[] = [];
	for (let start = src.indexOf("{", 0); start >= 0; start = src.indexOf("{", start + 1)) {
		let depth = 0;
		let inString = false;
		let escaped = false;
		for (let i = start; i < src.length; i++) {
			const ch = src[i];
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
				if (depth === 0) {
					out.push(src.slice(start, i + 1));
					break;
				}
			}
		}
	}
	return out;
}

export function stripGoalDraftPrefix(raw: string): string {
	return (raw ?? "")
		.trim()
		.replace(/^(?:(?:🎯\s*)?(?:Initial goal draft|原始目标草案)\s*[:：]\s*)+/i, "")
		.trim();
}

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

export function parseReviewerVerdict(raw: string): { verdict: "pass" | "fail"; feedback: string } | undefined {
	let found: { verdict: "pass" | "fail"; feedback: string } | undefined;
	for (const json of allBalancedJsonObjects(raw)) {
		try {
			const value = JSON.parse(json) as { verdict?: unknown; feedback?: unknown };
			if (value && typeof value === "object" && !Array.isArray(value)) {
				if (value.verdict === "pass" || value.verdict === "fail") {
					found = { verdict: value.verdict, feedback: typeof value.feedback === "string" ? value.feedback : "" };
				}
			}
		} catch {}
	}
	if (found) return found;
	const re = /\{\s*"verdict"\s*:\s*"(pass|fail)"[^}]*\}/g;
	let m: RegExpExecArray | null;
	let last: { verdict: "pass" | "fail"; feedback: string } | undefined;
	while ((m = re.exec(raw)) !== null) {
		const block = m[0];
		const fm = block.match(/"feedback"\s*:\s*"([^"]*)"/);
		last = { verdict: m[1] as "pass" | "fail", feedback: fm?.[1] ?? "" };
	}
	return last;
}

export const GIT_DIFF_CAP = 60_000;

export function buildDiffFingerprint(diffOut: string, statusOut: string): string {
	let status = "";
	if (statusOut.trim() !== "") {
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

export function extractErrorSnippetFromSession(session: unknown, text: string): string | undefined {
	try {
		const messages = (session as AgentSession | undefined)?.agent?.state?.messages;
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
	} catch {}
	const errMatch = text.match(/(?:(?:Error|Exception|Fail|Fatal):[^\n]+)/i);
	if (errMatch) {
		return errMatch[0].trim().slice(0, 300);
	}
	return undefined;
}

export function lastToolNameOfSession(session: unknown): string | undefined {
	try {
		const messages = (session as AgentSession | undefined)?.agent?.state?.messages;
		if (!Array.isArray(messages)) return undefined;
		for (let i = messages.length - 1; i >= 0 && i >= messages.length - 6; i--) {
			const m = messages[i] as { role?: unknown; content?: unknown };
			if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
			for (let j = m.content.length - 1; j >= 0; j--) {
				const b = m.content[j] as { type?: unknown; name?: unknown };
				if (b?.type === "toolCall" && typeof b.name === "string" && b.name.trim() !== "") {
					return b.name.trim();
				}
			}
		}
	} catch {}
	return undefined;
}

export function parseWizardOutput(raw: string): { goal: string; steps: PlanStep[] } {
	const trimmed = (raw ?? "").trim();
	if (!trimmed) return { goal: "", steps: [] };

	let goalText = "";
	let stepsPart = "";

	const stepsHeaderMatch = trimmed.match(/\n\s*(?:STEPS|PLAN|TASKS)\s*[:：]\s*([\s\S]*)/i);
	let preSteps = trimmed;
	if (stepsHeaderMatch) {
		preSteps = trimmed.slice(0, stepsHeaderMatch.index).trim();
		stepsPart = stepsHeaderMatch[1].trim();
	}

	const goalMatch = preSteps.match(/GOAL\s*[:：]\s*([\s\S]*)/i);
	if (goalMatch) {
		goalText = goalMatch[1].trim();
	} else {
		const lines = preSteps.split("\n").filter((l) => l.trim());
		if (lines.length > 1 && !/[。.!?？]\s*$/.test(lines[0])) {
			goalText = lines.slice(1).join(" ").trim();
		} else {
			goalText = preSteps;
		}
	}

	const steps: PlanStep[] = [];
	if (stepsPart) {
		const stepLines = stepsPart
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean);
		let stepIdx = 1;
		for (const line of stepLines) {
			if (line.startsWith("(") && line.endsWith(")")) continue;
			const itemMatch = line.match(/^(?:(?:\d+[.、)]|-|\*|\[\s*\])\s*)*(?:(?:Step\s*\d+|步骤\s*\d+)[:：\s]*)?(.+)$/i);
			if (!itemMatch) continue;
			const content = itemMatch[1].trim();
			if (!content) continue;

			let title = content;
			let description: string | undefined;
			const splitIdx = content.indexOf("|");
			if (splitIdx > 0) {
				title = content.slice(0, splitIdx).trim();
				description = content.slice(splitIdx + 1).trim();
			} else {
				const colonIdx = content.indexOf("：") !== -1 ? content.indexOf("：") : content.indexOf(":");
				if (colonIdx > 0 && colonIdx < 40) {
					title = content.slice(0, colonIdx).trim();
					description = content.slice(colonIdx + 1).trim();
				}
			}

			steps.push({
				id: `step-${stepIdx}`,
				title: title.slice(0, 200),
				status: "pending",
				...(description ? { description: description.slice(0, 1000) } : {}),
			});
			stepIdx++;
			if (steps.length >= 10) break;
		}
	}

	return {
		goal: goalText,
		steps,
	};
}

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
		`STEPS:`,
		`1. <first step title> | <brief description / acceptance check>`,
		`2. <second step title> | <brief description / acceptance check>`,
		`(include 2 to 6 concrete, sequential steps for executing the goal)`,
		`If the user cancels or stops answering (the tool reports a cancellation), still produce a sensible best-effort goal from what you already know.`, // eslint-disable-line max-len
	].join("\n");
}

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
	private static readonly WIZARD_IDLE_TIMEOUT_MS = 5 * 60_000;
	private static readonly WIZARD_MAX_TOTAL_MS = 20 * 60_000;
	private static readonly EXEC_FAILED_ROUNDS_LIMIT = 2;

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
		return {
			conversationId: null,
			goal: null,
			reviewModel: this.prefs.reviewModel,
			maxRounds: this.prefs.maxRounds,
			locked: this.prefs.locked,
			execModel: this.prefs.execModel,
			phase: "idle",
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
			await wizard.bindExtensions({ mode: "rpc", uiContext: this.host.webUi });

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

			try {
				await wizard.prompt(wizardPrompt(draft, contextSummary));
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
		conv.stagnantRounds = 0;
		conv.failedRounds = 0;
		conv.execUsageBefore = undefined;
		conv.reviewUsageBefore = undefined;
		conv.goalUsage = undefined;
		conv.lastDiff = undefined;
		conv.lastErrorSnippet = undefined;
		conv.sameErrorRounds = 0;
	}

	private clearGoalFields(conv: GoalConversation): void {
		const goal = conv.goal;
		goal.reviewing = false;
		goal.conversationId = null;
		goal.goal = null;
		goal.verdict = "pending";
		goal.feedback = undefined;
		goal.status = "";
		goal.statusEn = "";
		goal.phase = "idle";
		goal.roles = {};
		goal.wizard.active = false;
		goal.wizard.status = "";
		goal.wizard.statusEn = "";
	}

	private roundBudget(goal: GoalStatus): number {
		return goal.locked ? (goal.maxRounds > 0 ? Math.min(goal.maxRounds, 50) : Number.POSITIVE_INFINITY) : 1;
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
		return budget > 0 && Number.isFinite(budget) ? `/${budget}` : "";
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

			const execId = await this.dispatchExecutor(conv, goalGeneration, goalText, round, budget, feedback);
			if (!execId) return;
			if (!this.isCurrentDelegated(conv, goalGeneration)) return;

			const outcome = await this.host.waitRoleAgent!(execId, this.roleDeadline());
			if (!this.isCurrentDelegated(conv, goalGeneration)) return;

			const sample = await this.sampleRound(conv, execId);
			if (!this.isCurrentDelegated(conv, goalGeneration)) return;

			if (
				(conv.sameErrorRounds ?? 0) >= 2 ||
				(conv.stagnantRounds ?? 0) >= 2 ||
				(conv.failedRounds ?? 0) >= GoalService.EXEC_FAILED_ROUNDS_LIMIT
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
				if (conv.failedRounds >= GoalService.EXEC_FAILED_ROUNDS_LIMIT) {
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
			const verdict = await this.askDelegatedReview(conv, goalGeneration, round, budget, sample.output, execId);
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
				this.executorRoundPrompt(goalText, round, budget, feedback),
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
				prompt: this.executorRoundPrompt(goalText, round, budget, ""),
				cwd: conv.cwd,
				model: g.execModel ?? null,
				parentId: conv.id,
				title: this.roleConvTitle(goalText),
			});
			if (conv.goalGeneration !== goalGeneration) {
				void host.stopRoleAgent?.(convId).catch(() => {});
				return undefined;
			}
			conv.roleExec = { convId, generation: (conv.roleExec?.generation ?? 0) + 1 };
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
		let repoAvailable = true;
		try {
			if (this.host.isGitRepo) repoAvailable = await this.host.isGitRepo(conv.cwd);
		} catch {
			repoAvailable = true;
		}
		if (repoAvailable) {
			const trimmed = diffOut.trim();
			const prevDiff = conv.lastDiff;
			const noChange = trimmed === "" || (prevDiff !== undefined && trimmed === prevDiff);
			conv.stagnantRounds = noChange ? (conv.stagnantRounds ?? 0) + 1 : 0;
			conv.lastDiff = trimmed;
		}
		const after = read?.usage;
		const before = conv.execUsageBefore;
		if (after && before) {
			const dIn = Math.max(0, after.input - before.input);
			const dOut = Math.max(0, after.output - before.output);
			conv.goalUsage = {
				input: (conv.goalUsage?.input ?? 0) + dIn,
				output: (conv.goalUsage?.output ?? 0) + dOut,
			};
		}
		conv.execUsageBefore = undefined;
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
		const fb = feedback.trim();
		if (fb) return fb;
		if (verdict === "pass") {
			return pick(this.lang(), "（审查者未附说明）", "(the reviewer gave no note)", "goal.role.review.feedback.pass");
		}
		const prev = prevFeedback.trim();
		if (prev) {
			return pick(
				this.lang(),
				`（审查者本轮未给出新意见，沿用上一轮意见）\n${prev}`,
				`(the reviewer gave no new feedback this round — carrying the previous round's over)\n${prev}`,
				"goal.role.review.feedback.prev",
				{ prev },
			);
		}
		return pick(
			this.lang(),
			"审查者判 fail 但未给出说明。请复核目标的每一条要求，补齐尚未完成或尚未验证的部分，并在自述里给出可核验的证据（跑过的命令与输出）。",
			"The reviewer returned fail without a note. Re-check every requirement in the goal, finish what is unfinished or unverified, and back it up with verifiable evidence (the commands you ran and their output).",
			"goal.role.review.feedback.empty",
		);
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
		conv.goalHistory = [
			{
				goal: text.slice(0, 200),
				verdict,
				rounds,
				feedback: feedback.trim().replace(/\s+/g, " ").slice(0, 200),
				finishedAt: Date.now(),
			},
			...(conv.goalHistory ?? []),
		].slice(0, 20);
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
				await conv.session.sendUserMessage(passText, {
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
				await conv.session.sendUserMessage(
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
			await conv.session.sendUserMessage(
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
		const brief = goalText.replace(/\s+/g, " ").trim().slice(0, 40);
		const withTail = goalText.trim().length > 40 ? "…" : "";
		return pick(
			this.lang(),
			`[目标执行] ${brief}${withTail}`,
			`[Goal executor] ${brief}${withTail}`,
			"goal.role.conv_title",
			{ brief, withTail },
		);
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

	private executorRoundPrompt(goalText: string, round: number, budget: number, feedback: string): string {
		const rounds = this.roundsLabel(budget);
		const prev = feedback.trim();
		return pick(
			this.lang(),
			`【目标 · 第 ${round}${rounds} 轮】\n\n${goalText}\n\n${prev ? `上一轮审查意见：\n${prev}\n\n` : ""}要求：\n- 直接修改工作区（不要只在回复里描述改动），做完用一段话说明「改了什么、怎么验证的」。\n- 禁止向用户提问（本对话由服务端自动驱动，弹窗会被按取消返回）。\n- 禁止派生或等待其他子代理（轮次由服务端控制，你只负责这一轮）。`,
			`[Goal · round ${round}${rounds}]\n\n${goalText}\n\n${prev ? `Review feedback from the previous round:\n${prev}\n\n` : ""}Requirements:\n- Change the workspace directly (don't just describe it), then summarize in one paragraph what you changed and how you verified it.\n- Do NOT ask the user anything (this conversation is server-driven; dialogs are auto-cancelled).\n- Do NOT spawn or wait for other subagents (the server owns the rounds; you own this one only).`,
			"goal.role.exec",
			{ round, rounds, goalText, prev },
		);
	}

	private reviewCardText(kind: "start" | "pass" | "fail", round: number, budget: number, feedback: string): string {
		const rounds = this.roundsLabel(budget);
		const fb = feedback.trim().replace(/\s+/g, " ").slice(0, 300);
		if (kind === "start") {
			return pick(
				this.lang(),
				`🔍 第 ${round}${rounds} 轮审查开始（本回合只回 verdict JSON；审查进行中发消息会自动排队，不用等）`,
				`🔍 Review round ${round}${rounds} started (reply with only the verdict JSON this round; messages sent mid-review are queued automatically)`,
				"goal.role.card.start",
				{ round, rounds },
			);
		}
		const specificKey = kind === "pass" ? "goal.role.card.pass" : "goal.role.card.fail";
		const key = getServerString(this.lang(), specificKey) ? specificKey : "goal.role.card.result";
		const fbZh = fb ? `：${fb}` : "";
		const fbEn = fb ? `: ${fb}` : "";
		return pick(
			this.lang(),
			kind === "pass" ? `✅ 第 ${round}${rounds} 轮审查通过${fbZh}` : `❌ 第 ${round}${rounds} 轮未通过${fbZh}`,
			kind === "pass"
				? `✅ Review round ${round}${rounds} passed${fbEn}`
				: `❌ Review round ${round}${rounds} failed${fbEn}`,
			key,
			{ round, rounds, fb: fbEn, fbZh, fbEn, feedback: fb },
		);
	}

	private reviewerRoundPrompt(
		goalText: string,
		round: number,
		budget: number,
		execOutput: string,
		planDesc = "",
		evidence = "",
	): string {
		const rounds = this.roundsLabel(budget);
		const out = execOutput.trim().slice(0, 4000);
		const planBlockZh =
			planDesc && planDesc !== "No active plan."
				? `\n\n【任务计划看板当前状态】\n${planDesc}\n核验时请同时核实上述计划步骤的推进与完成状态是否真实。`
				: "";
		const planBlockEn =
			planDesc && planDesc !== "No active plan."
				? `\n\n# Task Plan Board\n${planDesc}\nWhen verifying, also check whether the above plan steps have been legitimately advanced or completed.`
				: "";
		const ev = evidence.trim();
		const evidenceBlockZh = ev
			? `\n\n【执行者最近的工具与命令证据（服务端自动采集，只保留输出尾部，可能被截断）】\n${ev}`
			: "";
		const evidenceBlockEn = ev
			? `\n\n# Executor's recent tool & command evidence (auto-collected, output tails only, may be truncated)\n${ev}`
			: "";
		return pick(
			this.lang(),
			`你是严格、独立的验收者。只判断目标是否被完全满足：不要相信描述，去看工作区的实际状态。\n\n【目标】\n${goalText}\n\n【这是第 ${round}${rounds} 轮】${planBlockZh}\n\n【执行者本轮自述】\n${out || "（执行者本轮没有给出自述）"}${evidenceBlockZh}\n\n你可以用只读手段核实：read / grep / scm（只读 git）/ 只读 bash（跑测试）。\n\n判定口径：\n- 只判【执行者本轮自述】里**声称已完成**的条目；本轮没声称完成的后续阶段不构成 fail 理由（目标写成「完成阶段 3 并收尾后续」也不代表这一轮要做完所有阶段）。\n- 忽略与目标无关的本地改动（其它项目的补丁、工具/模型配置、临时文件）。\n- 声称完成但自述与证据里都没有对应命令输出或文件证据的，必须 fail，并点名缺哪条命令的输出。\n- feedback 不得为空：fail 时必须给出可以直接动手改的具体待改项。\n\n只输出一个 JSON 对象，不要有任何其他文本、不要代码围栏、不要复述下面的形状示例。本回合写类与派发类工具会被服务端直接拒绝（不要试）。字段：verdict 只能填 pass（目标已完全满足，一句话说明满足了什么）或 fail（未满足，给出可以直接动手改的具体待改项）；feedback 是一句话说明。形状示例（不要照抄尖括号里的占位符）：\n{"verdict":"<pass|fail>","feedback":"<一句话说明>"}\n[goal-review]`,
			`You are a strict, independent acceptor. Judge only whether the goal is fully satisfied: do not trust the summary — inspect the actual workspace state.\n\n# Goal\n${goalText}\n\n# This is round ${round}${rounds}${planBlockEn}\n\n# Executor's summary this round\n${out || "(the executor produced no summary)"}${evidenceBlockEn}\n\nYou may verify with read-only means: read / grep / scm (read-only git) / read-only bash (run tests).\n\nJudging rules:\n- Judge only the items the executor's summary **claims to have completed this round**; later phases it did not claim this round are NOT grounds for fail (a goal phrased as "finish phase 3 and wrap up the rest" does not mean all phases must land this round).\n- Ignore local changes unrelated to the goal (other projects' patches, tool/model settings, scratch files).\n- If a claimed item has no matching command output or file evidence in the summary or the evidence above, you MUST fail and name which command's output is missing.\n- feedback must not be empty: on fail, give concrete items the executor can act on directly.\n\nReply with ONLY one JSON object — no other text, no code fences, do not echo the shape example below. Write and dispatch tools are blocked by the server during this round — do not try them. Fields: verdict must be pass (goal fully satisfied, say what in one sentence) or fail (not satisfied, give concrete items the executor must fix); feedback is one short sentence. Shape example (do not copy the placeholders in angle brackets):\n{"verdict":"<pass|fail>","feedback":"<one sentence>"}\n[goal-review]`,
			"goal.role.review",
			{
				goalText,
				round,
				rounds,
				out: out || "(the executor produced no summary)",
				planBlockEn,
				evidenceBlockEn,
				planBlockZh,
				evidenceBlockZh,
			},
		);
	}

	private verdictRetryPrompt(): string {
		return pick(
			this.lang(),
			`你上一条回复没有给出约定的 JSON。现在只回一个 JSON 对象，不要有任何其他文本或代码围栏：\n{"verdict":"pass|fail","feedback":"…"}\n[goal-review]`,
			`Your last reply did not contain the required JSON. Reply with ONLY one JSON object now — no other text, no code fences:\n{"verdict":"pass|fail","feedback":"..."}\n[goal-review]`,
			"goal.role.review.retry",
		);
	}

	private roleFailureText(kind: string, detail = ""): string {
		const detailZh = detail ? `（${detail.slice(0, 160)}）` : "";
		const detailEn = detail ? ` (${detail.slice(0, 160)})` : "";
		const zh: Record<string, string> = {
			timeout: `上一轮执行超时，未完成既定改动${detailZh}。请拆成更小的步骤完成。`,
			"timeout-repeat": `执行连续 ${GoalService.EXEC_FAILED_ROUNDS_LIMIT} 轮超时未完成${detailZh}，目标循环已暂停（不会自己重新派活）。请检查执行环境后重新设定目标。`,
			canceled: `执行被手动中止${detailZh}，目标循环已暂停（不会自己重新派活）。`,
			error: `上一轮执行报错${detailZh}。请先排查错误再继续。`,
			"error-repeat": `执行连续 ${GoalService.EXEC_FAILED_ROUNDS_LIMIT} 轮报错${detailZh}，目标循环已暂停（不会自己重新派活）。请先排查错误再重新设定目标。`,
			"exec-gone": "执行对话已被移出或服务重启，执行者记忆已丢失，目标循环已暂停（不会自己重新派活）。",
			quiesce:
				"服务器正在排空存量工作（quiesce），不再派发新一轮，目标循环已暂停。用 pi-web-ui server unquiesce 恢复后可重新设定目标继续。",
			"review-timeout": "审查回合超时，未收到结论。",
			"review-gone": "审查对话已不可用，未收到结论。",
			"review-invalid": "审查回合没有给出约定的 JSON 结论（重试一次仍未通过）。",
		};
		const en: Record<string, string> = {
			timeout: `The previous execution round timed out before finishing the work${detailEn}. Please split it into smaller steps.`,
			"timeout-repeat": `The executor has timed out for ${GoalService.EXEC_FAILED_ROUNDS_LIMIT} consecutive rounds${detailEn}; the goal loop is paused (it will not dispatch again by itself). Check the environment, then set the goal again.`,
			canceled: `The execution was aborted manually${detailEn}; the goal loop is paused (it will not dispatch again by itself).`,
			error: `The previous execution round hit an error${detailEn}. Please investigate before continuing.`,
			"error-repeat": `The executor has errored for ${GoalService.EXEC_FAILED_ROUNDS_LIMIT} consecutive rounds${detailEn}; the goal loop is paused (it will not dispatch again by itself). Please investigate, then set the goal again.`,
			"exec-gone":
				"The executor conversation is gone (dismissed or the server restarted); its memory is lost and the loop is paused (it will not dispatch again by itself).",
			quiesce:
				"The server is draining (quiesce); no new rounds will be dispatched and the goal loop is paused. Resume with pi-web-ui server unquiesce, then set the goal again to continue.",
			"review-timeout": "The review round timed out without a verdict.",
			"review-gone": "The reviewer conversation is unavailable; no verdict was received.",
			"review-invalid": "The review round did not produce the required JSON verdict (still missing after one retry).",
		};
		return pick(this.lang(), zh[kind] ?? kind, en[kind] ?? kind, `goal.role.failure.${kind}`);
	}
}
