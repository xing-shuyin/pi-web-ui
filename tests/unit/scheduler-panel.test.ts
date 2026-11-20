import { describe, expect, it } from "vitest";
import type { CanvasGraphSummary, SchedulerTaskView } from "../../web/src/types";
import {
	blankDraft,
	canSaveDraft,
	draftFromTask,
	runOpenMessage,
	taskInputFromDraft,
	viewableRun,
} from "../../web/src/components/SchedulerPanel";

const graphs = [{ id: "graph-1", name: "Daily workflow" }] as CanvasGraphSummary[];
const canvasDraft = () => ({ ...blankDraft("/project"), name: "Daily", target: "canvas" as const, graphId: "graph-1" });

function existingTask(overrides: Partial<SchedulerTaskView> = {}): SchedulerTaskView {
	return {
		id: "task-1",
		name: "Daily",
		description: "",
		cwd: "/project",
		kind: "cron",
		spec: "0 9 * * *",
		prompt: "",
		model: "provider/model",
		thinkingLevel: "high",
		enabled: true,
		catchUp: "skip",
		conversationId: "",
		sessionFile: "",
		oneShot: false,
		createdAt: 1,
		updatedAt: 1,
		nextFire: null,
		lastRun: null,
		history: [],
		running: false,
		...overrides,
	};
}

describe("scheduler panel targets", () => {
	it("preserves canvas targets and graph IDs when editing existing tasks", () => {
		const draft = draftFromTask(existingTask({ target: "canvas", graphId: "graph-1" }));
		const input = taskInputFromDraft(draft);
		expect(input).toMatchObject({ id: "task-1", target: "canvas", graphId: "graph-1", cwd: "/project", prompt: "" });
		expect(input).not.toHaveProperty("model");
		expect(input).not.toHaveProperty("thinkingLevel");
	});

	it("keeps legacy conversation tasks as conversations", () => {
		const draft = draftFromTask(existingTask({ prompt: "Inspect dependencies" }));
		expect(draft.target).toBe("conversation");
		expect(taskInputFromDraft(draft)).toMatchObject({
			target: "conversation",
			model: "provider/model",
			thinkingLevel: "high",
		});
		expect(canSaveDraft(draft, [], false)).toBe(true);
		expect(canSaveDraft({ ...draft, prompt: "  " }, [], false)).toBe(false);
	});

	it("accepts blank canvas input but requires a loaded, valid graph and run base", () => {
		const draft = canvasDraft();
		expect(canSaveDraft(draft, graphs, false)).toBe(true);
		expect(canSaveDraft(draft, graphs, true)).toBe(false);
		expect(canSaveDraft(draft, [], false)).toBe(false);
		expect(canSaveDraft({ ...draft, graphId: "" }, graphs, false)).toBe(false);
		expect(canSaveDraft({ ...draft, cwd: " " }, graphs, false)).toBe(false);
	});

	it("retains an unavailable graph ID for display while refusing to save it", () => {
		const draft = draftFromTask(existingTask({ target: "canvas", graphId: "deleted-graph" }));
		expect(draft.graphId).toBe("deleted-graph");
		expect(canSaveDraft(draft, graphs, false)).toBe(false);
	});

	it("drops the canvas graph when switching to a conversation and restores conversation overrides", () => {
		const draft = {
			...canvasDraft(),
			target: "conversation" as const,
			prompt: "Inspect",
			model: "p/m",
			thinkingLevel: "low",
		};
		expect(taskInputFromDraft(draft)).toMatchObject({ target: "conversation", model: "p/m", thinkingLevel: "low" });
		expect(taskInputFromDraft(draft)).not.toHaveProperty("graphId");
	});
});

describe("scheduler panel: 打开某次运行的对话", () => {
	it("取最近一次能打开的运行（会话 id 或会话文件任一有就行）", () => {
		const task = existingTask({
			history: [
				{ at: 300, ok: true, durationMs: 1000 },
				{ at: 200, ok: true, durationMs: 1000, sessionFile: "/sessions/a.jsonl" },
				{ at: 100, ok: true, durationMs: 1000, conversationId: "c1" },
			],
		});
		expect(viewableRun(task)?.at).toBe(200);
		expect(viewableRun(existingTask({ history: [{ at: 1, ok: true, durationMs: 1 }] }))).toBeNull();
	});

	it("画布任务不给对话入口", () => {
		const task = existingTask({
			target: "canvas",
			graphId: "graph-1",
			history: [{ at: 1, ok: true, durationMs: 1, conversationId: "c1" }],
		});
		expect(viewableRun(task)).toBeNull();
	});

	it("消息带上会话 id 与会话文件（缺哪个就不带哪个）", () => {
		expect(
			runOpenMessage("task-1", { at: 1, ok: true, durationMs: 1, conversationId: "c1", sessionFile: "/a.jsonl" }),
		).toEqual({
			type: "open_scheduled_conversation",
			taskId: "task-1",
			conversationId: "c1",
			sessionFile: "/a.jsonl",
		});
		expect(runOpenMessage("task-1", { at: 1, ok: true, durationMs: 1 })).toEqual({
			type: "open_scheduled_conversation",
			taskId: "task-1",
		});
	});
});
