import { getServerString, pick, type ServerLang } from "./i18n.js";
import {
	describeMaterials,
	planMaterialDelivery,
	type DeliveryContext,
	type DroppedMaterial,
	type MaterialRef,
} from "./material.js";
import { GOAL_EXEC_FAILED_ROUNDS_LIMIT } from "./goal-run-rounds.js";

/**
 * 目标回路里所有「给模型看的话」与「给用户看的回执」：执行者每轮、审查者每轮、调研问卷、
 * 结论重试、受阻原因、审查卡片、执行对话标题。
 *
 * 老实现（`server/goal-service.ts`）与宿主适配器（`core-goal-run-adapter.ts`）共用这一份：
 * prompt 措辞与 verdict 契约只此一处，改口径不会只改到一半。
 */

/**
 * 调研问卷 prompt：要求模型先把需求问清楚，最后只回一段 `GOAL:` / `STEPS:` 的固定格式
 * （`parseWizardOutput` 的契约）。
 *
 * `askTool` 是老/新两个引擎问用户的手段：老树是自己的 `goal_ask`，新树是标准 `ask_user_question`
 * （问卷载体不同、产出格式一样——两个入口、一份契约，不是两套 prompt）。
 */
export function goalScopePrompt(input: {
	draft: string;
	contextSummary?: string;
	askTool?: "goal_ask" | "ask_user_question";
}): string {
	const tool = input.askTool ?? "goal_ask";
	const contextSummary = input.contextSummary ?? "";
	const draft = input.draft;
	return [
		`You are a goal-clarification wizard. The user has stated a raw requirement. Your job is to turn it into ONE precise, actionable goal that a coding agent can fully satisfy and that can be strictly reviewed.`, // eslint-disable-line max-len
		...(contextSummary ? [``, `# Current conversation context (background & recent history)`, contextSummary] : []),
		``,
		`# User's raw requirement`, // eslint-disable-line no-regex-spaces
		draft,
		``,
		`Use your ${tool} tool to ask the user focused questions to pin down the essential, ambiguous details.`,
		`Convergence guidelines:`,
		`- Ground your understanding in the conversation context above so you already know what files, models, and prior work the user is referring to. Do NOT re-ask things already clear from context.`, // eslint-disable-line max-len
		`- If you need to verify a specific file or directory in the workspace, do at most 1 to 3 quick read-only checks (read/ls/find/grep), then IMMEDIATELY call ${tool}. Never do exhaustive exploration or attempt the actual task during scoping.`, // eslint-disable-line max-len
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

/** 轮数后缀：`/12`；不限（0 / Infinity）时为空串——状态文案的唯一样式来源。 */
export function roundsSuffix(budget: number): string {
	return budget > 0 && Number.isFinite(budget) ? `/${budget}` : "";
}

/**
 * 把材料清单拼进目标段落。
 *
 * `materialsBlock` 是 `describeMaterials()` 的唯一产物（R3），空/未传时**原样返回**：
 * 无材料的目标 prompt 与今天逐字节一致（R10）。
 */
export function withMaterialBlock(goalText: string, materialsBlock?: string): string {
	const block = (materialsBlock ?? "").trim();
	return block ? `${goalText}\n\n${block}` : goalText;
}

/**
 * 规格里只存字符串（R1）：非字符串项丢弃（脏数据不抛错）；全空 → `undefined`。
 * 缺字段 ≡ `[]`（R9），并让无材料的目标快照与今天逐字节一致（R10）。
 */
export function goalMaterialRefs(raw: unknown): string[] | undefined {
	const items = Array.isArray(raw) ? raw.filter((m): m is string => typeof m === "string") : [];
	return items.length > 0 ? [...items] : undefined;
}

/** 执行侧环境：目标执行者 / 向导都是满血对话（自带 read/bash），材料只会以指针形式下发。 */
const GOAL_EXEC_ENV: DeliveryContext = { hasFs: true, vision: true };

export interface GoalMaterialsComposition {
	/** 给模型的清单文本（`describeMaterials()` 唯一产物）；空串 = 没有材料 */
	block: string;
	pointers: MaterialRef[];
	/** 记账回执（R6 / R7 不许静默）：`null` = 无需告知 */
	notice: { text: string; textEn: string } | null;
}

/**
 * 纯逻辑：已归一的材料 → 投递计划 + 清单 + 记账回执。
 *
 * R5：投递形式（inline / 指针 / 降级）只由 `planMaterialDelivery()` 决定，这里只把执行侧事实递进去；
 * R3：清单文本只由 `describeMaterials()` 产出，本函数不另写材料文案（`notice` 是用户可见回执，不进 prompt）。
 */
export function composeGoalMaterials(
	materials: readonly MaterialRef[],
	failed: ReadonlyArray<{ ref: string; reason: string }> = [],
	dropped: readonly DroppedMaterial[] = [],
): GoalMaterialsComposition {
	const plan = planMaterialDelivery(materials, GOAL_EXEC_ENV);
	const unusable = [
		...dropped.map((d) => `${d.value}(${d.reason})`),
		...failed.map((f) => `${f.ref}(unreachable)`),
		...plan.degraded.map((d) => `${d.ref}(${d.reason})`),
	];
	const notice =
		unusable.length > 0
			? {
					text: `🎯 材料有 ${unusable.length} 项不可用，已跳过：${unusable.join("、")}`,
					textEn: `🎯 ${unusable.length} material(s) unusable and skipped: ${unusable.join(", ")}`,
				}
			: null;
	return { block: describeMaterials(plan.pointers), pointers: plan.pointers, notice };
}

/** 执行者每轮 prompt（纯函数，供回放单测）。 */
export function goalExecutorPrompt(
	lang: ServerLang,
	input: { goalText: string; round: number; budget: number; feedback?: string; materialsBlock?: string },
): string {
	const rounds = roundsSuffix(input.budget);
	const prev = (input.feedback ?? "").trim();
	const goalText = withMaterialBlock(input.goalText, input.materialsBlock);
	return pick(
		lang,
		`【目标 · 第 ${input.round}${rounds} 轮】\n\n${goalText}\n\n${prev ? `上一轮审查意见：\n${prev}\n\n` : ""}要求：\n- 直接修改工作区（不要只在回复里描述改动），做完用一段话说明「改了什么、怎么验证的」。\n- 禁止向用户提问（本对话由服务端自动驱动，弹窗会被按取消返回）。\n- 禁止派生或等待其他子代理（轮次由服务端控制，你只负责这一轮）。`,
		`[Goal · round ${input.round}${rounds}]\n\n${goalText}\n\n${prev ? `Review feedback from the previous round:\n${prev}\n\n` : ""}Requirements:\n- Change the workspace directly (don't just describe it), then summarize in one paragraph what you changed and how you verified it.\n- Do NOT ask the user anything (this conversation is server-driven; dialogs are auto-cancelled).\n- Do NOT spawn or wait for other subagents (the server owns the rounds; you own this one only).`,
		"goal.role.exec",
		{ round: input.round, rounds, goalText, prev },
	);
}

/** 审查者每轮 prompt（纯函数）。与执行者共用**同一份** `materialsBlock`，保证两侧看到同一张清单。 */
export function goalReviewerPrompt(
	lang: ServerLang,
	input: {
		goalText: string;
		round: number;
		budget: number;
		execOutput: string;
		planDesc?: string;
		evidence?: string;
		materialsBlock?: string;
	},
): string {
	const rounds = roundsSuffix(input.budget);
	const out = input.execOutput.trim().slice(0, 4000);
	const goalText = withMaterialBlock(input.goalText, input.materialsBlock);
	const planDesc = input.planDesc ?? "";
	const planBlockZh =
		planDesc && planDesc !== "No active plan."
			? `\n\n【任务计划看板当前状态】\n${planDesc}\n核验时请同时核实上述计划步骤的推进与完成状态是否真实。`
			: "";
	const planBlockEn =
		planDesc && planDesc !== "No active plan."
			? `\n\n# Task Plan Board\n${planDesc}\nWhen verifying, also check whether the above plan steps have been legitimately advanced or completed.`
			: "";
	const ev = (input.evidence ?? "").trim();
	const evidenceBlockZh = ev
		? `\n\n【执行者最近的工具与命令证据（服务端自动采集，只保留输出尾部，可能被截断）】\n${ev}`
		: "";
	const evidenceBlockEn = ev
		? `\n\n# Executor's recent tool & command evidence (auto-collected, output tails only, may be truncated)\n${ev}`
		: "";
	return pick(
		lang,
		`你是严格、独立的验收者。只判断目标是否被完全满足：不要相信描述，去看工作区的实际状态。\n\n【目标】\n${goalText}\n\n【这是第 ${input.round}${rounds} 轮】${planBlockZh}\n\n【执行者本轮自述】\n${out || "（执行者本轮没有给出自述）"}${evidenceBlockZh}\n\n你可以用只读手段核实：read / grep / scm（只读 git）/ 只读 bash（跑测试）。\n\n判定口径：\n- 只判【执行者本轮自述】里**声称已完成**的条目；本轮没声称完成的后续阶段不构成 fail 理由（目标写成「完成阶段 3 并收尾后续」也不代表这一轮要做完所有阶段）。\n- 忽略与目标无关的本地改动（其它项目的补丁、工具/模型配置、临时文件）。\n- 声称完成但自述与证据里都没有对应命令输出或文件证据的，必须 fail，并点名缺哪条命令的输出。\n- feedback 不得为空：fail 时必须给出可以直接动手改的具体待改项。\n\n只输出一个 JSON 对象，不要有任何其他文本、不要代码围栏、不要复述下面的形状示例。本回合写类与派发类工具会被服务端直接拒绝（不要试）。字段：verdict 只能填 pass（目标已完全满足，一句话说明满足了什么）或 fail（未满足，给出可以直接动手改的具体待改项）；feedback 是一句话说明。形状示例（不要照抄尖括号里的占位符）：\n{"verdict":"<pass|fail>","feedback":"<一句话说明>"}\n[goal-review]`,
		`You are a strict, independent acceptor. Judge only whether the goal is fully satisfied: do not trust the summary — inspect the actual workspace state.\n\n# Goal\n${goalText}\n\n# This is round ${input.round}${rounds}${planBlockEn}\n\n# Executor's summary this round\n${out || "(the executor produced no summary)"}${evidenceBlockEn}\n\nYou may verify with read-only means: read / grep / scm (read-only git) / read-only bash (run tests).\n\nJudging rules:\n- Judge only the items the executor's summary **claims to have completed this round**; later phases it did not claim this round are NOT grounds for fail (a goal phrased as "finish phase 3 and wrap up the rest" does not mean all phases must land this round).\n- Ignore local changes unrelated to the goal (other projects' patches, tool/model settings, scratch files).\n- If a claimed item has no matching command output or file evidence in the summary or the evidence above, you MUST fail and name which command's output is missing.\n- feedback must not be empty: on fail, give concrete items the executor can act on directly.\n\nReply with ONLY one JSON object — no other text, no code fences, do not echo the shape example below. Write and dispatch tools are blocked by the server during this round — do not try them. Fields: verdict must be pass (goal fully satisfied, say what in one sentence) or fail (not satisfied, give concrete items the executor must fix); feedback is one short sentence. Shape example (do not copy the placeholders in angle brackets):\n{"verdict":"<pass|fail>","feedback":"<one sentence>"}\n[goal-review]`,
		"goal.role.review",
		{
			goalText,
			round: input.round,
			rounds,
			out: out || "(the executor produced no summary)",
			planBlockEn,
			evidenceBlockEn,
			planBlockZh,
			evidenceBlockZh,
		},
	);
}
/** 审查前的问卷结论重试：只回 JSON（第二次仍未给出就按 invalid 收尾）。 */
export function goalVerdictRetryPrompt(lang: ServerLang): string {
	return pick(
		lang,
		`你上一条回复没有给出约定的 JSON。现在只回一个 JSON 对象，不要有任何其他文本或代码围栏：\n{"verdict":"pass|fail","feedback":"…"}\n[goal-review]`,
		`Your last reply did not contain the required JSON. Reply with ONLY one JSON object now — no other text, no code fences:\n{"verdict":"pass|fail","feedback":"..."}\n[goal-review]`,
		"goal.role.review.retry",
	);
}

/** 审查卡片（`goal-review` 自定义消息）的正文：开始 / 通过 / 未通过三条。 */
export function goalCardText(
	lang: ServerLang,
	kind: "start" | "pass" | "fail",
	round: number,
	budget: number,
	feedback: string,
): string {
	const rounds = roundsSuffix(budget);
	const fb = feedback.trim().replace(/\s+/g, " ").slice(0, 300);
	if (kind === "start") {
		return pick(
			lang,
			`🔍 第 ${round}${rounds} 轮审查开始（本回合只回 verdict JSON；审查进行中发消息会自动排队，不用等）`,
			`🔍 Review round ${round}${rounds} started (reply with only the verdict JSON this round; messages sent mid-review are queued automatically)`,
			"goal.role.card.start",
			{ round, rounds },
		);
	}
	const specificKey = kind === "pass" ? "goal.role.card.pass" : "goal.role.card.fail";
	const key = getServerString(lang, specificKey) ? specificKey : "goal.role.card.result";
	const fbZh = fb ? `：${fb}` : "";
	const fbEn = fb ? `: ${fb}` : "";
	return pick(
		lang,
		kind === "pass" ? `✅ 第 ${round}${rounds} 轮审查通过${fbZh}` : `❌ 第 ${round}${rounds} 轮未通过${fbZh}`,
		kind === "pass"
			? `✅ Review round ${round}${rounds} passed${fbEn}`
			: `❌ Review round ${round}${rounds} failed${fbEn}`,
		key,
		{ round, rounds, fb: fbEn, fbZh, fbEn, feedback: fb },
	);
}

/** 执行对话 / 审查对话的标题（左栏可辨认是哪个目标派出来的）。 */
export function goalRoleTitle(lang: ServerLang, goalText: string): string {
	const brief = goalText.replace(/\s+/g, " ").trim().slice(0, 40);
	const withTail = goalText.trim().length > 40 ? "…" : "";
	return pick(lang, `[目标执行] ${brief}${withTail}`, `[Goal executor] ${brief}${withTail}`, "goal.role.conv_title", {
		brief,
		withTail,
	});
}

/**
 * 受阻/失败原因文案（喂回执行者与写进 `goal_status.feedback` 的同一份口径）。
 * `kind` 见下面的两张表；缺键时原样回显，便于定位新加的口径。
 */
export function goalFailureText(lang: ServerLang, kind: string, detail = ""): string {
	const detailZh = detail ? `（${detail.slice(0, 160)}）` : "";
	const detailEn = detail ? ` (${detail.slice(0, 160)})` : "";
	const zh: Record<string, string> = {
		timeout: `上一轮执行超时，未完成既定改动${detailZh}。请拆成更小的步骤完成。`,
		"timeout-repeat": `执行连续 ${GOAL_EXEC_FAILED_ROUNDS_LIMIT} 轮超时未完成${detailZh}，目标循环已暂停（不会自己重新派活）。请检查执行环境后重新设定目标。`,
		canceled: `执行被手动中止${detailZh}，目标循环已暂停（不会自己重新派活）。`,
		error: `上一轮执行报错${detailZh}。请先排查错误再继续。`,
		"error-repeat": `执行连续 ${GOAL_EXEC_FAILED_ROUNDS_LIMIT} 轮报错${detailZh}，目标循环已暂停（不会自己重新派活）。请先排查错误再重新设定目标。`,
		"exec-gone": "执行对话已被移出或服务重启，执行者记忆已丢失，目标循环已暂停（不会自己重新派活）。",
		quiesce:
			"服务器正在排空存量工作（quiesce），不再派发新一轮，目标循环已暂停。用 pi-web-ui server unquiesce 恢复后可重新设定目标继续。",
		"review-timeout": "审查回合超时，未收到结论。",
		"review-gone": "审查对话已不可用，未收到结论。",
		"review-invalid": "审查回合没有给出约定的 JSON 结论（重试一次仍未通过）。",
	};
	const en: Record<string, string> = {
		timeout: `The previous execution round timed out before finishing the work${detailEn}. Please split it into smaller steps.`,
		"timeout-repeat": `The executor has timed out for ${GOAL_EXEC_FAILED_ROUNDS_LIMIT} consecutive rounds${detailEn}; the goal loop is paused (it will not dispatch again by itself). Check the environment, then set the goal again.`,
		canceled: `The execution was aborted manually${detailEn}; the goal loop is paused (it will not dispatch again by itself).`,
		error: `The previous execution round hit an error${detailEn}. Please investigate before continuing.`,
		"error-repeat": `The executor has errored for ${GOAL_EXEC_FAILED_ROUNDS_LIMIT} consecutive rounds${detailEn}; the goal loop is paused (it will not dispatch again by itself). Please investigate, then set the goal again.`,
		"exec-gone":
			"The executor conversation is gone (dismissed or the server restarted); its memory is lost and the loop is paused (it will not dispatch again by itself).",
		quiesce:
			"The server is draining (quiesce); no new rounds will be dispatched and the goal loop is paused. Resume with pi-web-ui server unquiesce, then set the goal again to continue.",
		"review-timeout": "The review round timed out without a verdict.",
		"review-gone": "The reviewer conversation is unavailable; no verdict was received.",
		"review-invalid": "The review round did not produce the required JSON verdict (still missing after one retry).",
	};
	return pick(lang, zh[kind] ?? kind, en[kind] ?? kind, `goal.role.failure.${kind}`);
}

/**
 * 审查意见兜底：verdict 有结论但 feedback 为空时，按「pass / 沿用上一轮 / 要求补证据」补一句，
 * 保证喂回执行者的永远是可执行的具体要求（老实现 `ensureReviewerFeedback` 同一份口径）。
 */
export function goalReviewerFeedback(
	lang: ServerLang,
	verdict: "pass" | "fail",
	feedback: string,
	prevFeedback: string,
): string {
	const fb = feedback.trim();
	if (fb) return fb;
	if (verdict === "pass") {
		return pick(lang, "（审查者未附说明）", "(the reviewer gave no note)", "goal.role.review.feedback.pass");
	}
	const prev = prevFeedback.trim();
	if (prev) {
		return pick(
			lang,
			`（审查者本轮未给出新意见，沿用上一轮意见）\n${prev}`,
			`(the reviewer gave no new feedback this round — carrying the previous round's over)\n${prev}`,
			"goal.role.review.feedback.prev",
			{ prev },
		);
	}
	return pick(
		lang,
		"审查者判 fail 但未给出说明。请复核目标的每一条要求，补齐尚未完成或尚未验证的部分，并在自述里给出可核验的证据（跑过的命令与输出）。",
		"The reviewer returned fail without a note. Re-check every requirement in the goal, finish what is unfinished or unverified, and back it up with verifiable evidence (the commands you ran and their output).",
		"goal.role.review.feedback.empty",
	);
}
