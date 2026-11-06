export type SubagentNotifyMode = boolean | "manual";

export interface SubagentTaskState {
	mode: SubagentNotifyMode;
	completionRequested: boolean;
	summary?: string;
	generation: number;
}

export interface SubagentTaskActivity {
	streaming: boolean;
	activeChildren?: boolean;
	pendingQuestions?: boolean;
	pendingCommunications?: boolean;
	error?: boolean | string;
	canceled?: boolean;
}

export function createSubagentTask(mode: SubagentNotifyMode = true): SubagentTaskState {
	return { mode, completionRequested: false, generation: 0 };
}

export function restartSubagentTask(task: SubagentTaskState): SubagentTaskState {
	return { mode: task.mode, completionRequested: false, generation: task.generation + 1 };
}

export function requestSubagentCompletion(
	task: SubagentTaskState,
	summary: string,
	generation = task.generation,
): SubagentTaskState {
	if (generation !== task.generation) return task;
	return { ...task, completionRequested: true, summary: summary.trim() };
}

export function isSubagentTaskPending(task: SubagentTaskState, activity: SubagentTaskActivity): boolean {
	if (activity.error || activity.canceled) return false;
	if (activity.streaming) return true;
	return (
		task.mode === "manual" && !!(activity.activeChildren || activity.pendingQuestions || activity.pendingCommunications)
	);
}
