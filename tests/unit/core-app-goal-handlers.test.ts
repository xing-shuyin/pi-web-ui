import { describe, expect, it } from "vitest";
import { ClientRuntime } from "../../packages/keel/src/app/client-runtime.js";
import { CoreEngineNotReadyError } from "../../packages/keel/src/contracts/core-engine-errors.js";
import type { ChatModePort } from "../../packages/keel/src/contracts/goals.js";
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

describe("目标运行端口接上后（宿主适配器在位）", () => {
	function makeWiredRuntime(): {
		runtime: ClientRuntime;
		sent: ServerMessage[];
		calls: { method: string; args: unknown[] }[];
		hooks: { setPlan?: (conversationId: string, steps: { id: string; title: string; status: "pending" }[]) => void };
	} {
		const sent: ServerMessage[] = [];
		const calls: { method: string; args: unknown[] }[] = [];
		const hooks: {
			setPlan?: (conversationId: string, steps: { id: string; title: string; status: "pending" }[]) => void;
		} = {};
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
			// 宿主端口：只记录「谁的哪个方法被调到」（真实现见 goal-run-adapter.test.ts）。
			goalRun: (portHooks) => {
				if (portHooks?.setPlan) hooks.setPlan = portHooks.setPlan as typeof hooks.setPlan;
				return {
					setGoal: async (...args: unknown[]) => void calls.push({ method: "setGoal", args }),
					clearGoal: async (...args: unknown[]) => void calls.push({ method: "clearGoal", args }),
					startGoalWizard: async (...args: unknown[]) => void calls.push({ method: "startGoalWizard", args }),
				};
			},
		});
		runtime.attachFrames({
			pushSettings: () => {},
			refreshSessions: async () => {},
			pushProjects: async () => {},
			listModels: () => {},
			pushDefaultModel: () => {},
		});
		return { runtime, sent, calls, hooks };
	}

	it("三个 handler 真的走到宿主端口（端口只建一次，hooks 由域回传）", async () => {
		const { runtime, calls, hooks } = makeWiredRuntime();
		const conv = runtime.createConversation({ kind: "user" });
		await runtime.handlers().setGoal("做完它", { maxRounds: 3, locked: true });
		await runtime.handlers().clearGoal?.();
		await runtime.handlers().startGoalWizard("调研一下");
		expect(calls.map((call) => call.method)).toEqual(["setGoal", "clearGoal", "startGoalWizard"]);
		expect(calls[0].args[0]).toBe("做完它");
		expect(calls[1].args[0]).toBeUndefined();
		expect(calls[2].args[0]).toBe("调研一下");
		expect(typeof hooks.setPlan).toBe("function");
	});

	it("宿主回的 setPlan 落到与 plan_update 同一条链（帧 + 快照），不是第二套计划存储", async () => {
		const { runtime, sent, hooks } = makeWiredRuntime();
		const conv = runtime.createConversation({ kind: "user" });
		await runtime.handlers().clearGoal?.(); // 端口只在使用时建（hooks 才有值）
		hooks.setPlan?.(conv.id, [{ id: "s1", title: "补测试", status: "pending" }]);
		const frame = sent.filter((msg) => msg.type === "plan_updated").at(-1);
		expect(frame).toMatchObject({ conversationId: conv.id, plan: { steps: [{ id: "s1" }] } });
	});
});

describe("模式开关端口接上后（宿主适配器在位）", () => {
	/** 只记录「哪个方法被调到、参数是什么」（真适配器见 `core-chat-mode-adapter.test.ts`）。 */
	function makeModeRuntime(): {
		runtime: ClientRuntime;
		calls: { method: "setPlanMode" | "setDelegateMode"; args: unknown[] }[];
	} {
		const calls: { method: "setPlanMode" | "setDelegateMode"; args: unknown[] }[] = [];
		const port: ChatModePort = {
			setPlanMode: async (...args: unknown[]) => void calls.push({ method: "setPlanMode", args }),
			setDelegateMode: async (...args: unknown[]) => void calls.push({ method: "setDelegateMode", args }),
		};
		const runtime = new ClientRuntime({
			clientId: "c1",
			cwd: "/work",
			env: { settingsVersion: 1, piConfigured: true, piAgentInstalled: true },
			clock: { now: () => 1, after: () => () => {} },
			transport: { send: () => {}, isClosed: () => false },
			stateStore: () => createFakeSettingsStore(),
			// 模式开关的宿主面：装配在替身上（`options.chatMode` → `bindings.options.chatMode`）。
			chatMode: () => port,
		});
		runtime.attachFrames({
			pushSettings: () => {},
			refreshSessions: async () => {},
			pushProjects: async () => {},
			listModels: () => {},
			pushDefaultModel: () => {},
		});
		return { runtime, calls };
	}

	it("两个 handler 真的命中宿主端口（对话 id 原样透传，不自己造一个）", async () => {
		const { runtime, calls } = makeModeRuntime();
		const conv = runtime.createConversation({ kind: "user" });
		await runtime.handlers().setPlanMode?.(true);
		await runtime.handlers().setDelegateMode?.(true, conv.id);
		expect(calls).toStrictEqual([
			{ method: "setPlanMode", args: [true, undefined] },
			{ method: "setDelegateMode", args: [true, conv.id] },
		]);
	});
});
