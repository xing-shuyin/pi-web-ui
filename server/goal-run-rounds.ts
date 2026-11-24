import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { GoalHistoryEntry, PlanStep } from "./protocol.js";
import { runGit } from "./git-run.js";

/**
 * 目标一轮的「量」与「判」：git 指纹、错误片段、审查结论解析、停滞/同错计数、轮数预算、历史记账、
 * 调研产出的结构化解析。
 *
 * 老实现全在 `server/goal-service.ts` 的类里；宿主适配器（`core-goal-run-adapter.ts`）要跑同一台
 * 循环，所以判定口径**只此一份**：两侧都调这里的纯函数，禁各写一套不等式。
 */

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
/** 一轮的指纹读数：`diff HEAD` + `status --porcelain`，只在 `buildDiffFingerprint` 里合成。 */
export async function goalGitDiff(cwd: string): Promise<string> {
	try {
		const diff = await runGit(["diff", "HEAD"], { cwd, timeoutMs: 10_000 });
		if (!diff.ok) return "";
		const st = await runGit(["status", "--porcelain"], { cwd, timeoutMs: 10_000 });
		return buildDiffFingerprint(diff.stdout, st.ok ? st.stdout : "");
	} catch {
		return "";
	}
}

/** 这个 cwd 是不是 git 仓库（不是仓库时「diff 没变」不能算停滞）。 */
export async function goalIsGitRepo(cwd: string): Promise<boolean> {
	const result = await runGit(["rev-parse", "--is-inside-work-tree"], { cwd, timeoutMs: 5_000 });
	return result.ok;
}

/** 轮数预算（老实现 `roundBudget` 逐字同款）：锁住才认 `maxRounds`，未锁 = 只跑一轮。 */
export function goalRoundBudget(prefs: { locked: boolean; maxRounds: number }): number {
	return prefs.locked ? (prefs.maxRounds > 0 ? Math.min(prefs.maxRounds, 50) : Number.POSITIVE_INFINITY) : 1;
}

/** 执行连续失败到这个数就熔断（老实现 `GoalService.EXEC_FAILED_ROUNDS_LIMIT`）。 */
export const GOAL_EXEC_FAILED_ROUNDS_LIMIT = 2;

export interface GoalRoundCounters {
	stagnantRounds?: number;
	failedRounds?: number;
	sameErrorRounds?: number;
	lastDiff?: string;
	lastErrorSnippet?: string;
	execUsageBefore?: { input: number; output: number };
	reviewUsageBefore?: { input: number; output: number };
	goalUsage?: { input: number; output: number };
}

/** 换目标 / 停止时归零的账：与新一轮进度无关的累计量全清。 */
export function resetGoalRoundCounters(counters: GoalRoundCounters): void {
	counters.stagnantRounds = 0;
	counters.failedRounds = 0;
	counters.execUsageBefore = undefined;
	counters.reviewUsageBefore = undefined;
	counters.goalUsage = undefined;
	counters.lastDiff = undefined;
	counters.lastErrorSnippet = undefined;
	counters.sameErrorRounds = 0;
}

export interface GoalRoundSample {
	/** 本轮读到的错误片段（判「同一错误连续几轮」用） */
	errorSnippet?: string;
	/** `diff HEAD` 的指纹（`goalGitDiff()` 的产物；空串 = 没读到） */
	diffFingerprint?: string;
	/** cwd 是不是 git 仓库：不是就不判停滞（否则非仓库永远「没改动」） */
	repoAvailable: boolean;
	usageAfter?: { input: number; output: number };
	usageBefore?: { input: number; output: number };
}

/**
 * 采样一轮：同错计数、停滞计数、目标 token 账。
 *
 * 纯函数（只改传进来的计数器），不等式口径与老实现逐字一致：同错 = 相等或互相包含；
 * 停滞 = diff 指纹为空或与上一轮相同。宿主只负责把读数递进来。
 */
export function sampleGoalRound(counters: GoalRoundCounters, sample: GoalRoundSample): void {
	const currentError = sample.errorSnippet;
	const prevError = counters.lastErrorSnippet;
	if (
		currentError &&
		prevError &&
		(currentError === prevError || currentError.includes(prevError) || prevError.includes(currentError))
	) {
		counters.sameErrorRounds = (counters.sameErrorRounds ?? 0) + 1;
	} else {
		counters.sameErrorRounds = currentError ? 1 : 0;
	}
	counters.lastErrorSnippet = currentError;
	if (sample.repoAvailable) {
		const trimmed = (sample.diffFingerprint ?? "").trim();
		const prevDiff = counters.lastDiff;
		const noChange = trimmed === "" || (prevDiff !== undefined && trimmed === prevDiff);
		counters.stagnantRounds = noChange ? (counters.stagnantRounds ?? 0) + 1 : 0;
		counters.lastDiff = trimmed;
	}
	const after = sample.usageAfter;
	const before = sample.usageBefore ?? counters.execUsageBefore;
	if (after && before) {
		counters.goalUsage = {
			input: (counters.goalUsage?.input ?? 0) + Math.max(0, after.input - before.input),
			output: (counters.goalUsage?.output ?? 0) + Math.max(0, after.output - before.output),
		};
	}
	counters.execUsageBefore = undefined;
}

/** 目标历史只留最近 20 条（老实现 `recordHistory` 同口径）。 */
export const GOAL_HISTORY_LIMIT = 20;

export function recordGoalHistory(
	history: GoalHistoryEntry[] | undefined,
	entry: Omit<GoalHistoryEntry, "finishedAt"> & { finishedAt?: number },
): GoalHistoryEntry[] {
	return [{ ...entry, finishedAt: entry.finishedAt ?? Date.now() }, ...(history ?? [])].slice(0, GOAL_HISTORY_LIMIT);
}
