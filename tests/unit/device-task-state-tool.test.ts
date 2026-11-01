import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeviceCollabService } from "../../server/device-center/collab-service.js";
import {
	makeDeviceCollabTool,
	projectTaskState,
	setDeviceCollabService,
	validateDeviceCollabInput,
	type DeviceCollabExecutionContext,
	type DeviceCollabInput,
} from "../../server/device-center/collab-tool.js";
import type { DeviceTaskState } from "../../server/protocol.js";
import type { DeviceTaskState as WebTaskState } from "../../web/src/types.js";

const state: DeviceTaskState = {
	revision: 3,
	objective: "Original human objective",
	currentTaskId: "task",
	phase: "running",
	decisions: [],
	artifacts: [],
};
const webState: WebTaskState = state;
const context = { cwd: resolve("task-state-project"), sessionId: "session" };
const binding: DeviceCollabExecutionContext = {
	roomId: "room",
	botId: "bot",
	taskId: "task",
	conversationId: "own",
	taskState: state,
};
function fixture(bound: DeviceCollabExecutionContext | undefined = binding) {
	const request = vi.fn(
		async (_url: string | URL | Request, _init?: RequestInit) =>
			new Response(JSON.stringify({ taskState: state, events: [] })),
	);
	const release = vi.fn();
	const service = createDeviceCollabService({
		getConfig: () => ({
			hubUrl: "http://127.0.0.1:8999",
			deviceId: "device",
			credential: "credential-secret",
			allowExecution: true,
		}),
		getExecutionContext: () => bound,
		workspaceResolver: async () => ({ root: context.cwd, files: {} as any, release }),
		fetch: request,
	});
	return { service, request, release };
}
const invoke = (input: DeviceCollabInput) =>
	makeDeviceCollabTool().execute("call", input, undefined, undefined, {
		cwd: context.cwd,
		sessionManager: { getSessionId: () => context.sessionId },
	} as any);
afterEach(() => setDeviceCollabService(undefined));

describe("structured task state tool", () => {
	it("shares frontend protocol types and defaults reads and updates to the bound conversation", async () => {
		expect(webState).toBe(state);
		const f = fixture();
		await f.service.execute("task_state", {}, undefined, context);
		expect(String(f.request.mock.calls[0][0])).toBe(
			"http://127.0.0.1:8999/api/agent/rooms/room/conversations/own/task-state?sourceBotId=bot",
		);
		await f.service.execute(
			"task_update",
			{
				expectedRevision: 3,
				progress: "Checked implementation",
				constraints: [],
				blockers: ["CI pending"],
				nextSteps: ["Run checks"],
			},
			undefined,
			context,
		);
		const init = f.request.mock.calls[1][1]!;
		expect(init.method).toBe("POST");
		expect(JSON.parse(init.body as string)).toEqual({
			sourceBotId: "bot",
			parentTaskId: "task",
			expectedRevision: 3,
			progress: "Checked implementation",
			constraints: [],
			blockers: ["CI pending"],
			nextSteps: ["Run checks"],
		});
		expect(f.release).toHaveBeenCalledTimes(2);
	});

	it("permits explicit same-room read targets while denying update and identity spoofing", async () => {
		const f = fixture();
		await f.service.execute("task_state", { conversationId: "other" }, undefined, context);
		expect(String(f.request.mock.calls[0][0])).toContain("/conversations/other/task-state?");
		for (const args of [
			{ conversationId: "other" },
			{ roomId: "other" },
			{ sourceBotId: "other" },
			{ parentTaskId: "other" },
		])
			await expect(
				f.service.execute("task_update", { expectedRevision: 3, progress: "x", ...args } as any, undefined, context),
			).rejects.toThrow();
		const unbound = fixture({ ...binding, conversationId: undefined });
		await expect(
			unbound.service.execute(
				"task_update",
				{ conversationId: "own", expectedRevision: 3, progress: "x" },
				undefined,
				context,
			),
		).rejects.toThrow();
		expect(f.request).toHaveBeenCalledTimes(1);
		expect(unbound.request).not.toHaveBeenCalled();
	});

	it.each([
		{ progress: "x" },
		{ expectedRevision: -1, progress: "x" },
		{ expectedRevision: 0.5, progress: "x" },
		{ expectedRevision: Number.MAX_SAFE_INTEGER + 1, progress: "x" },
		{ expectedRevision: 0 },
		{ expectedRevision: 0, progress: "x".repeat(2001) },
		{ expectedRevision: 0, constraints: Array(21).fill("x") },
		{ expectedRevision: 0, blockers: ["x".repeat(501)] },
		{ expectedRevision: 0, nextSteps: [" "] },
		{ expectedRevision: 0, objective: "replace human goal", progress: "x" },
		{ expectedRevision: 0, decisions: [], progress: "x" },
		{ expectedRevision: 0, phase: "completed", progress: "x" },
	])("rejects invalid or authoritative update fields %j before network access", async (args) => {
		const f = fixture();
		await expect(f.service.execute("task_update", args as any, undefined, context)).rejects.toThrow();
		expect(f.request).not.toHaveBeenCalled();
	});

	it("accepts boundary values and explicit clearing", () => {
		validateDeviceCollabInput({
			action: "task_update",
			expectedRevision: 0,
			progress: "x".repeat(2000),
			constraints: Array(20).fill("x".repeat(500)),
			blockers: [],
			nextSteps: [],
		});
		validateDeviceCollabInput({ action: "task_update", expectedRevision: 3, progress: "" });
	});

	it("preserves current_task compatibility and projects optional task state", async () => {
		const f = fixture();
		setDeviceCollabService(f.service);
		const result = await invoke({ action: "current_task" });
		expect((result.details as any).summary).toMatchObject({ taskId: "task", taskState: state });
		setDeviceCollabService(fixture({ ...binding, taskState: undefined }).service);
		expect((await invoke({ action: "current_task" })).details).toMatchObject({ summary: { taskId: "task" } });
		expect((await invoke({ action: "current_task" })).details).not.toHaveProperty("summary.taskState");
	});

	it("projects only public state and events with bot provenance and bounded output", async () => {
		const payload = {
			taskState: {
				...state,
				credential: "secret",
				privateRoot: "/private",
				reported: {
					taskId: "task",
					botId: "bot",
					provenance: "human",
					updatedAt: 1,
					progress: "p".repeat(3000),
					blockers: ["b"],
					constraints: [],
					nextSteps: [],
					token: "secret",
				},
			},
			events: Array.from({ length: 100 }, (_, i) => ({
				id: `event${i}`,
				sequence: i,
				type: "task_updated",
				sourceId: "bot",
				createdAt: i,
				text: "t".repeat(3000),
				credential: "secret",
			})),
			credential: "secret",
		};
		const projected = projectTaskState(payload);
		expect(JSON.stringify(projected)).not.toContain("secret");
		expect(JSON.stringify(projected)).not.toContain("/private");
		expect(projected).toMatchObject({
			taskState: { objective: state.objective, reported: { provenance: "bot_reported" } },
			truncated: true,
		});
		expect((projected.events as unknown[]).length).toBeLessThanOrEqual(20);
		expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThan(48000);
		setDeviceCollabService({ execute: async () => payload });
		const result = await invoke({ action: "task_state" });
		expect((result.details as any).summary).toEqual(projected);
	});

	it("keeps multibyte reports within budget without dropping the authoritative state", () => {
		const projected = projectTaskState({
			taskState: {
				...state,
				reported: {
					progress: "进".repeat(2000),
					constraints: Array(20).fill("界".repeat(500)),
					blockers: Array(20).fill("界".repeat(500)),
					nextSteps: Array(20).fill("界".repeat(500)),
				},
			},
		});
		expect(projected).toMatchObject({ taskState: { revision: 3, objective: state.objective }, truncated: true });
		expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThan(40000);
	});

	it("preserves bounded canonical human decision evidence and truncation flags", () => {
		const projected = projectTaskState({
			taskState: {
				...state,
				decisions: [
					{
						attentionId: "attention",
						messageId: "human-message",
						taskId: "task",
						question: "Choose direction",
						answer: "a".repeat(2100),
						questionTruncated: false,
						credential: "secret",
					},
				],
			},
		});
		expect(projected).toMatchObject({
			taskState: {
				decisions: [
					{ question: "Choose direction", answer: "a".repeat(2000), questionTruncated: false, answerTruncated: true },
				],
			},
			truncated: true,
		});
		expect(JSON.stringify(projected)).not.toContain("secret");
	});

	it("propagates cancellation before executing", async () => {
		const f = fixture();
		const abort = new AbortController();
		abort.abort();
		await expect(
			f.service.execute("task_update", { expectedRevision: 3, progress: "x" }, abort.signal, context),
		).rejects.toThrow();
		expect(f.request).not.toHaveBeenCalled();
	});
});
