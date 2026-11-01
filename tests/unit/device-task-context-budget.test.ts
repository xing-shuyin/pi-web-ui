import { describe, expect, it } from "vitest";
import type { DeviceTaskState } from "../../server/protocol.js";
import { selectTaskContext } from "../../server/device-center/task-context-budget.js";
import { taskPrompt } from "../../server/device-center/executor.js";

const base = (): DeviceTaskState => ({
	revision: 42,
	objective: "保留用户目标 🧭",
	currentTaskId: "task-current",
	phase: "waiting",
	blocker: { attentionId: "attention", taskId: "task-current", question: "需要人工确认 — 승인" },
	decisions: [],
	artifacts: [],
});
const bytes = (result: ReturnType<typeof selectTaskContext>) =>
	Buffer.byteLength(JSON.stringify({ taskState: result.state, taskStateSelection: result.selection }), "utf8");

describe("bounded task context", () => {
	it("preserves essential state and counts the full UTF-8 envelope exactly", () => {
		const source = base();
		const result = selectTaskContext(source);
		expect(result.state).toEqual(source);
		expect(result.selection.bytes).toBe(bytes(result));
		expect(result.selection.bytes).toBeLessThanOrEqual(12 * 1024);
		expect(result.selection.overflow).toBe(0);
		let exact = selectTaskContext(source, result.selection.bytes);
		while (exact.selection.bytes !== exact.selection.budgetBytes)
			exact = selectTaskContext(source, exact.selection.bytes);
		expect(exact.selection.bytes).toBe(exact.selection.budgetBytes);
		expect(exact.selection.overflow).toBe(0);
		const over = selectTaskContext(source, exact.selection.bytes - 1);
		expect(over.selection.overflow).toBe(1);
		expect(over.selection.bytes).toBe(bytes(over));
		expect(over.selection.bytes).toBeGreaterThan(over.selection.budgetBytes);
	});

	it("selects multilingual human decisions before reports without shortening any text", () => {
		const source = base();
		source.decisions = Array.from({ length: 20 }, (_, i) => ({
			attentionId: `a${i}`,
			messageId: `m${i}`,
			taskId: `t${i}`,
			question: "确认吗？😀".repeat(60),
			answer: `决定${i}: 保留约束 한국어 العربية `.repeat(50),
			...(i === 0 ? { questionTruncated: true, answerTruncated: true } : {}),
		}));
		source.reported = {
			taskId: "task-current",
			botId: "bot",
			updatedAt: 1,
			provenance: "bot_reported",
			constraints: ["约束".repeat(9000)],
			progress: "进展".repeat(9000),
			blockers: ["阻塞".repeat(9000)],
			nextSteps: ["后续".repeat(9000)],
		};
		const original = structuredClone(source);
		const result = selectTaskContext(source);
		expect(result.selection.bytes).toBe(bytes(result));
		expect(result.selection.bytes).toBeLessThanOrEqual(12 * 1024);
		expect(result.state.decisions.length).toBeGreaterThan(0);
		expect(result.state.decisions.at(-1)).toEqual(source.decisions.at(-1));
		for (const decision of result.state.decisions) expect(source.decisions).toContainEqual(decision);
		expect(result.selection.omitted.decisions).toBe(20 - result.state.decisions.length);
		expect(result.selection.omitted.decisions).toBeGreaterThan(0);
		expect(result.selection.omitted.reportedConstraints).toBe(1);
		expect(result.selection.omitted.reportedProgress).toBe(1);
		expect(result.selection.omitted.reportedBlockers).toBe(1);
		expect(result.selection.omitted.reportedNextSteps).toBe(1);
		expect(result.selection.textTruncated).toEqual({
			objective: false,
			blocker: false,
			decisionQuestions: 1,
			decisionAnswers: 1,
		});
		expect(result.selection.lookup).toContain("task_state");
		expect(source).toEqual(original);
	});

	it("retains essentials on overflow, including a zero budget", () => {
		const source = base();
		source.objective = "目".repeat(2000);
		source.blocker!.question = "😀".repeat(1000);
		for (const budget of [0, 100, 12 * 1024]) {
			const result = selectTaskContext(source, budget);
			expect(result.state).toEqual(source);
			expect(result.selection.bytes).toBe(bytes(result));
			expect(result.selection.overflow).toBe(Number(result.selection.bytes > budget));
		}
	});

	it("allows only named shared fields, admits whole constraints and exposes omitted optional records", () => {
		const source = Object.assign(base(), { secret: "must not leak" });
		source.latestRequest = Object.assign(
			{ taskId: "old", sourceId: "human", text: "old request" },
			{ secret: "hidden" },
		);
		source.lastOutcome = { taskId: "old", status: "completed", text: "outcome" };
		source.artifacts = [{ deliveryId: "delivery", taskId: "old" }];
		source.reported = {
			taskId: "old",
			botId: "bot",
			updatedAt: 1,
			provenance: "bot_reported",
			constraints: ["Always ask before publishing", "Do not delete data"],
			progress: "ready",
			blockers: [],
			nextSteps: ["verify"],
		};
		const full = selectTaskContext(source);
		expect(JSON.stringify(full)).not.toContain("secret");
		expect(full.state.reported?.constraints).toEqual(source.reported.constraints);
		expect(Object.values(full.selection.omitted).every((n) => n === 0)).toBe(true);
		const small = selectTaskContext(source, 800);
		expect(small.selection.omitted.latestRequest).toBe(1);
		expect(small.selection.omitted.lastOutcome).toBe(1);
		expect(small.selection.omitted.artifacts).toBe(source.artifacts.length - small.state.artifacts.length);
		expect(small.selection.bytes).toBeLessThanOrEqual(800);
	});

	it("keeps current task text and handoff unchanged while bounding optional JSON context", () => {
		const source = base();
		source.decisions = [
			{ attentionId: "a", messageId: "m", taskId: "t", question: "q".repeat(20000), answer: "answer" },
		];
		const text = "用户约束：不得删除数据。😀".repeat(5000);
		const handoff = { text: "handoff constraints".repeat(5000) };
		const task = {
			id: "task",
			attemptId: "attempt",
			botId: "bot",
			botRevision: 1,
			deviceId: "device",
			text,
			handoff,
			taskState: source,
		};
		const before = structuredClone(task);
		// Use the actual executor envelope builder; the handoff shape is irrelevant to selection.
		const prompt = taskPrompt(task as unknown as Parameters<typeof taskPrompt>[0]);
		const envelope = JSON.parse(prompt.split("\n\n").at(-1)!);
		expect(envelope.text).toBe(text);
		expect(envelope.handoff).toEqual(handoff);
		expect(envelope.taskStateSelection.omitted.decisions).toBe(1);
		expect(
			Buffer.byteLength(
				JSON.stringify({ taskState: envelope.taskState, taskStateSelection: envelope.taskStateSelection }),
			),
		).toBe(envelope.taskStateSelection.bytes);
		expect(task).toEqual(before);
	});

	it("rejects invalid budgets", () => {
		for (const budget of [-1, 1.5, NaN, Infinity]) expect(() => selectTaskContext(base(), budget)).toThrow(RangeError);
	});
});
