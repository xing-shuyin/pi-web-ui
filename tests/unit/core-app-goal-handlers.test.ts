import { describe, expect, it } from "vitest";
import { ClientRuntime } from "../../packages/keel/src/app/client-runtime.js";
import { CoreEngineNotReadyError } from "../../packages/keel/src/contracts/core-engine-errors.js";
import type { TransportPort } from "../../packages/keel/src/contracts/ports.js";
import type { ServerMessage } from "../../packages/keel/src/protocol.js";
import { createFakeSettingsStore, type FakeSettingsStore } from "../helpers/fake-settings-store.js";

function makeRuntime(): {
	runtime: ClientRuntime;
	sent: ServerMessage[];
	store: FakeSettingsStore;
	feeds: unknown[];
} {
	const sent: ServerMessage[] = [];
	const feeds: unknown[] = [];
	const store = createFakeSettingsStore();
	store.saveSettings("c1", { goalModeEnabled: true });
	const transport: TransportPort = { send: (msg) => void sent.push(msg), isClosed: () => false };
	const runtime = new ClientRuntime({
		clientId: "c1",
		cwd: "/work",
		env: { settingsVersion: 1, piConfigured: true, piAgentInstalled: true },
		clock: { now: () => 1, after: () => () => {} },
		transport,
		stateStore: () => store,
		// 没有会话注册表：喂轮那条会走「会话没接」的失败分支（正好用来证明交接确实过喂轮出口）。
		onTurnError: (_conversationId, error) => void feeds.push(error),
	});
	runtime.attachFrames({
		pushSettings: () => {},
		refreshSessions: async () => {},
		pushProjects: async () => {},
		listModels: () => {},
		pushDefaultModel: () => {},
	});
	return { runtime, sent, store, feeds };
}

describe("目标 / 计划 / 委派 handler 的接线（B7）", () => {
	it("计划写入口走通：plan_updated 帧里带状态，快照闸门也真的被请求过", () => {
		const { runtime, sent } = makeRuntime();
		runtime.createConversation({ kind: "user" });
		runtime.handlers().updatePlan?.([{ id: "a", title: "A", status: "pending" }], "a");
		const frame = sent.find((msg) => msg.type === "plan_updated");
		expect(frame).toMatchObject({ type: "plan_updated", plan: { activeStepId: "a" } });
	});

	it("目标偏好落到设置存储（`client-state.json` 的唯一写者）", async () => {
		const { runtime, sent, store } = makeRuntime();
		await runtime.handlers().setGoalPrefs?.({ reviewModel: "rv", maxRounds: 9, locked: true });
		expect(store.getGoalPrefs("c1")).toMatchObject({ reviewModel: "rv", maxRounds: 9, locked: true });
		expect(sent.some((msg) => msg.type === "goal_status")).toBe(true);
	});

	it("计划交接：新对话接盘并走喂轮出口（会话没接就报 onTurnError，不吞成成功）", async () => {
		const { runtime, sent, feeds } = makeRuntime();
		const before = runtime.registry.activeId();
		await runtime.handlers().planCleanHandoff?.([{ id: "a", title: "A", status: "pending" }], "接着做");
		expect(runtime.registry.activeId()).not.toBe(before);
		expect(sent.filter((msg) => msg.type === "plan_updated").at(-1)).toMatchObject({
			conversationId: runtime.registry.activeId(),
		});
		expect(feeds).toHaveLength(1);
	});

	it("宿主端口未注入：目标运行 / 模式开关同步抛（不再是「surface 占位」而是明确的 goals.* / planMode.*）", () => {
		const { runtime } = makeRuntime();
		runtime.createConversation({ kind: "user" });
		const handlers = runtime.handlers();
		expect(() => handlers.setGoal("做完它")).toThrow(CoreEngineNotReadyError);
		expect(() => handlers.setGoal("做完它")).toThrow(/goals\.setGoal/);
		expect(() => handlers.clearGoal()).toThrow(/goals\.clearGoal/);
		expect(() => handlers.startGoalWizard("调研")).toThrow(/goals\.startGoalWizard/);
		expect(() => handlers.setPlanMode?.(true)).toThrow(/planMode\.set/);
		expect(() => handlers.setDelegateMode?.(true)).toThrow(/delegateMode\.set/);
	});
});
