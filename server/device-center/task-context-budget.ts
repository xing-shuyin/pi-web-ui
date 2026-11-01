import type { DeviceTaskState } from "../protocol.js";

export interface TaskContextSelection {
	budgetBytes: number;
	/** UTF-8 bytes of JSON.stringify({ taskState, taskStateSelection }), including this metadata. */
	bytes: number;
	/** 1 when essential context exceeds budget; numeric for stable JSON byte width. */
	overflow: 0 | 1;
	omitted: {
		decisions: number;
		artifacts: number;
		latestRequest: number;
		lastOutcome: number;
		reported: number;
		reportedConstraints: number;
		reportedProgress: number;
		reportedBlockers: number;
		reportedNextSteps: number;
	};
	/** No text is shortened here; counts expose truncation already present in canonical decisions. */
	textTruncated: { objective: false; blocker: false; decisionQuestions: number; decisionAnswers: number };
	lookup: string;
}

/** Select optional reference data only. Current task text, handoff and runtime state never pass through here. */
export function selectTaskContext(
	source: DeviceTaskState,
	budget = 12 * 1024,
): { state: DeviceTaskState; selection: TaskContextSelection } {
	if (!Number.isSafeInteger(budget) || budget < 0)
		throw new RangeError("Task context budget must be a nonnegative safe integer");
	const state: DeviceTaskState = {
		revision: source.revision,
		objective: source.objective,
		currentTaskId: source.currentTaskId,
		phase: source.phase,
		...(source.blocker
			? {
					blocker: {
						attentionId: source.blocker.attentionId,
						taskId: source.blocker.taskId,
						question: source.blocker.question,
					},
				}
			: {}),
		decisions: [],
		artifacts: [],
	};
	const selection: TaskContextSelection = {
		budgetBytes: budget,
		bytes: 0,
		overflow: 0,
		omitted: {
			decisions: source.decisions.length,
			artifacts: source.artifacts.length,
			latestRequest: Number(!!source.latestRequest),
			lastOutcome: Number(!!source.lastOutcome),
			reported: Number(!!source.reported),
			reportedConstraints: source.reported?.constraints.length ?? 0,
			reportedProgress: Number(!!source.reported?.progress),
			reportedBlockers: source.reported?.blockers.length ?? 0,
			reportedNextSteps: source.reported?.nextSteps.length ?? 0,
		},
		textTruncated: {
			objective: false,
			blocker: false,
			decisionQuestions: source.decisions.filter((d) => d.questionTruncated).length,
			decisionAnswers: source.decisions.filter((d) => d.answerTruncated).length,
		},
		lookup:
			"Optional reference snapshot. Use device_collab task_state for full canonical state, omitted constraints/decisions and current revision before acting.",
	};
	const measure = () => {
		// bytes counts itself, so settle its decimal width before comparing the budget.
		let bytes: number;
		do {
			bytes = selection.bytes;
			selection.bytes = Buffer.byteLength(JSON.stringify({ taskState: state, taskStateSelection: selection }), "utf8");
		} while (bytes !== selection.bytes);
	};
	measure();
	if (selection.bytes > budget) {
		selection.overflow = 1;
		measure();
		return { state, selection };
	}
	const admit = (apply: () => void, undo: () => void) => {
		apply();
		measure();
		if (selection.bytes <= budget) return true;
		undo();
		measure();
		return false;
	};
	// Newest human decisions first; each question/answer pair is indivisible.
	for (const d of [...source.decisions].reverse()) {
		const decision: DeviceTaskState["decisions"][number] = {
			attentionId: d.attentionId,
			messageId: d.messageId,
			taskId: d.taskId,
			...(d.question !== undefined ? { question: d.question } : {}),
			...(d.answer !== undefined ? { answer: d.answer } : {}),
			...(d.questionTruncated !== undefined ? { questionTruncated: d.questionTruncated } : {}),
			...(d.answerTruncated !== undefined ? { answerTruncated: d.answerTruncated } : {}),
		};
		admit(
			() => {
				state.decisions.unshift(decision);
				selection.omitted.decisions--;
			},
			() => {
				state.decisions.shift();
				selection.omitted.decisions++;
			},
		);
	}
	const report = source.reported;
	if (report) {
		const included = admit(
			() => {
				state.reported = {
					taskId: report.taskId,
					botId: report.botId,
					updatedAt: report.updatedAt,
					provenance: report.provenance,
					constraints: [],
					progress: "",
					blockers: [],
					nextSteps: [],
				};
				selection.omitted.reported--;
			},
			() => {
				delete state.reported;
				selection.omitted.reported++;
			},
		);
		if (included) {
			const selected = state.reported!;
			for (const key of ["constraints", "blockers", "nextSteps"] as const) {
				const count = {
					constraints: "reportedConstraints",
					blockers: "reportedBlockers",
					nextSteps: "reportedNextSteps",
				}[key] as "reportedConstraints" | "reportedBlockers" | "reportedNextSteps";
				for (const text of report[key])
					admit(
						() => {
							selected[key].push(text);
							selection.omitted[count]--;
						},
						() => {
							selected[key].pop();
							selection.omitted[count]++;
						},
					);
			}
			if (report.progress)
				admit(
					() => {
						selected.progress = report.progress;
						selection.omitted.reportedProgress--;
					},
					() => {
						selected.progress = "";
						selection.omitted.reportedProgress++;
					},
				);
		}
	}
	if (source.latestRequest) {
		const { taskId, sourceId, text } = source.latestRequest;
		admit(
			() => {
				state.latestRequest = { taskId, sourceId, text };
				selection.omitted.latestRequest--;
			},
			() => {
				delete state.latestRequest;
				selection.omitted.latestRequest++;
			},
		);
	}
	if (source.lastOutcome) {
		const { taskId, status, text } = source.lastOutcome;
		admit(
			() => {
				state.lastOutcome = { taskId, status, ...(text !== undefined ? { text } : {}) };
				selection.omitted.lastOutcome--;
			},
			() => {
				delete state.lastOutcome;
				selection.omitted.lastOutcome++;
			},
		);
	}
	for (const { deliveryId, taskId } of source.artifacts)
		admit(
			() => {
				state.artifacts.push({ deliveryId, taskId });
				selection.omitted.artifacts--;
			},
			() => {
				state.artifacts.pop();
				selection.omitted.artifacts++;
			},
		);
	return { state, selection };
}
