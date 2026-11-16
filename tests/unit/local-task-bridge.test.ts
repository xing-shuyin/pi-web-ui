import { describe, expect, it, vi } from "vitest";
import {
	createLocalTaskBridge,
	type LocalTaskHub,
	type LocalTaskRuntime,
} from "../../server/device-center/local-task-bridge.js";
import type { DeviceExecutorTask } from "../../server/device-center/executor.js";

/**
 * 本机设备任务直调：`onTask` 契约必须与 connector 的 WS 任务分支等价——
 * 先认领（running 帧），再把进度/工具/交互/计划/终态写回 Hub，且写回**不依赖任何连接状态**。
 * 这里用假 Hub + 假运行时逐项对照，避免"远程能用、本机静默"这类不对称回归。
 */

const DEVICE = "local-device";

function task(overrides: Partial<DeviceExecutorTask & { roomId: string }> = {}) {
	return {
		id: "task-1",
		attemptId: "attempt-1",
		botId: "bot-1",
		botRevision: 1,
		deviceId: DEVICE,
		roomId: "direct-room",
		text: "hi",
		leaseToken: "lease-1",
		leaseGeneration: 1,
		conversationId: "0f0f0f0f-1111-4222-8333-444444444444",
		resume: false,
		executionMode: "chat" as const,
		...overrides,
	};
}

function fakeHub() {
	const events: { kind: string; value: unknown }[] = [];
	const hub: LocalTaskHub = {
		async acceptTaskEvent(_deviceId, event) {
			events.push({ kind: `event:${(event as { status: string }).status}`, value: event });
			return {};
		},
		acceptTaskProgress(_deviceId, event) {
			events.push({ kind: "progress", value: event });
		},
		async acceptTaskToolLifecycle(_deviceId, frame) {
			events.push({ kind: "tool", value: frame });
		},
		acceptInteractions(_deviceId, event) {
			events.push({ kind: "interactions", value: event });
		},
		async acceptTaskPlanReady() {
			events.push({ kind: "plan", value: null });
			return true;
		},
		async renewTaskLease(_deviceId, renew) {
			events.push({ kind: "renew", value: renew });
			return { accepted: true };
		},
	};
	return { hub, events };
}

function fakeRuntime(run: LocalTaskRuntime["onTask"]) {
	const calls = { onTask: 0, cancel: 0, steer: 0, answer: 0 };
	const runtime: LocalTaskRuntime = {
		onTask: (t, signal, callbacks) => {
			calls.onTask++;
			return run(t, signal, callbacks);
		},
		cancelScheduledTask: () => {
			calls.cancel++;
			return true;
		},
		steerTask: () => {
			calls.steer++;
			return true;
		},
		answerTaskInteraction: () => {
			calls.answer++;
			return true;
		},
	};
	return { runtime, calls };
}

describe("本机任务直调", () => {
	it("只接手自己的 deviceId，其它设备的任务交回 relay", async () => {
		const { hub } = fakeHub();
		const { runtime, calls } = fakeRuntime(async () => "ok");
		const bridge = createLocalTaskBridge({
			deviceId: DEVICE,
			hubUrl: "http://127.0.0.1:1",
			credential: "c",
			hub,
			runtime,
		});
		expect(await bridge.onTask("other-device", task())).toBe(false);
		expect(calls.onTask).toBe(0);
	});

	it("先认领再执行：running 帧在最前，终态带报告写回", async () => {
		const { hub, events } = fakeHub();
		const { runtime } = fakeRuntime(async () => "答案：你好");
		const bridge = createLocalTaskBridge({
			deviceId: DEVICE,
			hubUrl: "http://127.0.0.1:1",
			credential: "c",
			hub,
			runtime,
		});
		expect(await bridge.onTask(DEVICE, task())).toBe(true);
		await vi.waitFor(() => expect(events.some((e) => e.kind === "event:completed")).toBe(true));
		expect(events[0]?.kind).toBe("event:running");
		const completed = events.find((e) => e.kind === "event:completed")?.value as { report?: string };
		expect(completed.report).toBe("答案：你好");
	});

	it("执行失败也写回终态，不静默丢", async () => {
		const { hub, events } = fakeHub();
		const { runtime } = fakeRuntime(async () => {
			throw new Error("boom");
		});
		const bridge = createLocalTaskBridge({
			deviceId: DEVICE,
			hubUrl: "http://127.0.0.1:1",
			credential: "c",
			hub,
			runtime,
		});
		await bridge.onTask(DEVICE, task());
		await vi.waitFor(() => expect(events.some((e) => e.kind === "event:failed")).toBe(true));
		const failed = events.find((e) => e.kind === "event:failed")?.value as { report?: string };
		expect(failed.report).toBeTruthy();
	});

	it("进度/工具/交互/计划写回 Hub，进度按最小间隔节流", async () => {
		const { hub, events } = fakeHub();
		const { runtime } = fakeRuntime(async (_t, _signal, callbacks) => {
			callbacks?.onProgress?.({ phase: "model", text: "思考中" } as never);
			callbacks?.onProgress?.({ phase: "model", text: "思考中" } as never);
			callbacks?.onToolLifecycle?.({
				phase: "start",
				toolName: "read",
				callId: "call-1",
				summary: "read file",
			} as never);
			callbacks?.onInteractions?.([{ id: "i1", taskId: "task-1", attemptId: "attempt-1", question: "?" }] as never);
			expect(await callbacks?.onPlanReady?.("task-1", { state: "ready", steps: [] } as never)).toBe(true);
			return "done";
		});
		const bridge = createLocalTaskBridge({
			deviceId: DEVICE,
			hubUrl: "http://127.0.0.1:1",
			credential: "c",
			hub,
			runtime,
		});
		await bridge.onTask(DEVICE, task());
		await vi.waitFor(() => expect(events.some((e) => e.kind === "event:completed")).toBe(true));
		expect(events.filter((e) => e.kind === "progress")).toHaveLength(1);
		expect(events.some((e) => e.kind === "tool")).toBe(true);
		expect(events.some((e) => e.kind === "interactions")).toBe(true);
		expect(events.some((e) => e.kind === "plan")).toBe(true);
	});

	it("重复投递幂等：已接手就返回 true，不能让 Hub 把在飞任务判成投递失败", async () => {
		const { hub, events } = fakeHub();
		let release!: (value: string) => void;
		const { runtime, calls } = fakeRuntime(
			() =>
				new Promise<string>((resolve) => {
					release = resolve;
				}),
		);
		const bridge = createLocalTaskBridge({
			deviceId: DEVICE,
			hubUrl: "http://127.0.0.1:1",
			credential: "c",
			hub,
			runtime,
		});
		expect(await bridge.onTask(DEVICE, task())).toBe(true);
		expect(await bridge.onTask(DEVICE, task())).toBe(true);
		expect(calls.onTask).toBe(1);
		release("ok");
		await vi.waitFor(() => expect(events.some((e) => e.kind === "event:completed")).toBe(true));
	});

	it('在飞任务自己续租：WS 心跳不通或本地还在排队也不会被当成"没起来"', async () => {
		const { hub, events } = fakeHub();
		let release!: (value: string) => void;
		const { runtime } = fakeRuntime(
			() =>
				new Promise<string>((resolve) => {
					release = resolve;
				}),
		);
		const bridge = createLocalTaskBridge({
			deviceId: DEVICE,
			hubUrl: "http://127.0.0.1:1",
			credential: "c",
			hub,
			runtime,
			renewIntervalMs: 5,
			progressIntervalMs: 0,
		});
		await bridge.onTask(DEVICE, task());
		await vi.waitFor(() => expect(events.filter((e) => e.kind === "renew").length).toBeGreaterThan(0));
		const renew = events.find((e) => e.kind === "renew")?.value as { leaseToken: string; hasActivity: boolean };
		expect(renew.leaseToken).toBe("lease-1");
		expect(renew.hasActivity).toBe(true);
		release("ok");
		await vi.waitFor(() => expect(events.some((e) => e.kind === "event:completed")).toBe(true));
		const before = events.filter((e) => e.kind === "renew").length;
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(events.filter((e) => e.kind === "renew").length).toBe(before);
		expect(bridge.inFlight()).toBe(0);
		bridge.close();
	});

	it("停止/转向/交互应答都落到运行时，外部设备一律不动", async () => {
		const { hub } = fakeHub();
		const { runtime, calls } = fakeRuntime(async () => "ok");
		const bridge = createLocalTaskBridge({
			deviceId: DEVICE,
			hubUrl: "http://127.0.0.1:1",
			credential: "c",
			hub,
			runtime,
		});
		expect(await bridge.cancelTask(DEVICE, "task-1", "attempt-1")).toEqual({ stopped: true });
		expect(await bridge.steerTask(DEVICE, "task-1", "attempt-1", "换个方向")).toEqual({ steered: true });
		expect(
			await bridge.answerInteraction(DEVICE, {
				taskId: "task-1",
				attemptId: "attempt-1",
				interactionId: "i1",
				decision: "approve",
			}),
		).toBe(true);
		expect(calls).toMatchObject({ cancel: 1, steer: 1, answer: 1 });
		expect(await bridge.cancelTask("other-device", "task-1", "attempt-1")).toEqual({ stopped: false });
		expect(await bridge.answerInteraction("other-device", { taskId: "t", attemptId: "a", interactionId: "i" })).toBe(
			false,
		);
	});
});
