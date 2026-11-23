import { describe, expect, it, vi } from "vitest";
import { ClientRuntime } from "../../server/core/app/client-runtime.js";
import { CoreEngineNotReadyError } from "../../server/core/app/core-engine.js";
import type { ClockPort } from "../../server/core/contracts/ports.js";
import type { ServerMessage } from "../../server/protocol.js";
import type { SnapshotBuilders } from "../../server/core/domains/snapshots/index.js";

function fakeClock(): ClockPort & { advance(ms: number): void } {
	let now = 1_000;
	const timers: Array<{ at: number; fn: () => void }> = [];
	return {
		now: () => now,
		after: (ms, fn) => {
			const entry = { at: now + ms, fn };
			timers.push(entry);
			return () => {
				const idx = timers.indexOf(entry);
				if (idx >= 0) timers.splice(idx, 1);
			};
		},
		advance(ms: number) {
			now += ms;
			for (const timer of [...timers]) {
				if (timer.at <= now) {
					timer.fn();
					const idx = timers.indexOf(timer);
					if (idx >= 0) timers.splice(idx, 1);
				}
			}
		},
	};
}

function fakeTransport() {
	const sent: ServerMessage[] = [];
	let closed = false;
	return {
		sent,
		close: () => {
			closed = true;
		},
		port: {
			send: (msg: ServerMessage) => void sent.push(msg),
			isClosed: () => closed,
		},
	};
}

function builders(): SnapshotBuilders & { full: ReturnType<typeof vi.fn>; delta: ReturnType<typeof vi.fn> } {
	const full = vi.fn(() => ({ type: "notice", level: "info", text: "full" }) as unknown as ServerMessage);
	const delta = vi.fn(() => ({ type: "notice", level: "info", text: "delta" }) as unknown as ServerMessage);
	return { full, delta } as never;
}

function makeRuntime(overrides: Partial<Parameters<typeof ClientRuntime.prototype.constructor>[0]> = {}) {
	const clock = fakeClock();
	const transport = fakeTransport();
	const build = builders();
	const runtime = new ClientRuntime({
		clientId: "client-1",
		cwd: "/work",
		workspaceRoots: ["/work"],
		clock,
		transport: transport.port,
		builders: build,
		...(overrides as object),
	});
	return { runtime, clock, transport, build };
}

describe("app · ClientRuntime 组合根", () => {
	it("建档即激活，activeConversationId 透出给 DispatchSession", () => {
		const { runtime } = makeRuntime();
		expect(runtime.activeConversationId()).toBeUndefined();
		const conv = runtime.createConversation({ id: "c1", kind: "user", createdAt: 10 });
		expect(conv.meta.clientId).toBe("client-1");
		expect(conv.meta.cwd).toBe("/work");
		expect(runtime.activeConversationId()).toBe("c1");
		const cs = runtime.handlers();
		expect(cs.activeConversationId?.()).toBe("c1");
		expect(cs.cwd).toBe("/work");
		expect(cs.workspaceRoots).toEqual(["/work"]);
	});

	it("streaming / pending 计数来自聚合自身状态", () => {
		const { runtime } = makeRuntime();
		const a = runtime.createConversation({ id: "a", kind: "user", createdAt: 1 });
		const b = runtime.createConversation({ id: "b", kind: "user", createdAt: 2 });
		expect(runtime.streamingCount()).toBe(0);
		a.beginTurn(50);
		expect(runtime.streamingCount()).toBe(1);
		b.queues.enqueue("steer", "排队一");
		b.queues.enqueue("followUp", "排队二");
		expect(runtime.pendingCount()).toBe(2);
		a.endTurn(60);
		expect(runtime.streamingCount()).toBe(0);
	});

	it("handlers 幂等：同一运行时只造一个适配器", () => {
		const { runtime } = makeRuntime();
		expect(runtime.handlers()).toBe(runtime.handlers());
	});

	it("未实现的成员调用即抛，不会静默什么都不做", () => {
		const { runtime } = makeRuntime();
		const cs = runtime.handlers();
		expect(() => cs.refreshSessions()).toThrow(CoreEngineNotReadyError);
		expect(() => (cs.prompt as unknown as (t: string) => unknown)("hi")).toThrow(CoreEngineNotReadyError);
	});

	it("flushSnapshot 经出帧闸门，dispose 之后不再发帧", () => {
		const { runtime, transport, build } = makeRuntime();
		const cs = runtime.handlers();
		cs.flushSnapshot(true);
		expect(build.full).toHaveBeenCalledTimes(1);
		expect(transport.sent).toHaveLength(1);
		runtime.dispose();
		cs.flushSnapshot(true);
		expect(build.full).toHaveBeenCalledTimes(1);
		expect(transport.sent).toHaveLength(1);
	});

	it("dispose 把在册对话全部推到终态，并清空活动对话", () => {
		const { runtime } = makeRuntime();
		const running = runtime.createConversation({ id: "r", kind: "user", createdAt: 1 });
		const idle = runtime.createConversation({ id: "i", kind: "user", createdAt: 2 });
		running.beginTurn(10);
		runtime.dispose();
		expect(running.phase).toBe("retired");
		expect(idle.phase).toBe("retired");
		expect(runtime.activeConversationId()).toBeUndefined();
		expect(runtime.streamingCount()).toBe(0);
	});

	it("dispose 幂等", () => {
		const { runtime } = makeRuntime();
		runtime.createConversation({ id: "c", kind: "user", createdAt: 1 });
		expect(() => {
			runtime.dispose();
			runtime.dispose();
		}).not.toThrow();
	});

	it("子代理对话可以带 parentId，cwd 可覆盖", () => {
		const { runtime } = makeRuntime();
		runtime.createConversation({ id: "parent", kind: "user", createdAt: 1 });
		const sub = runtime.createConversation({
			id: "sub",
			kind: "subagent",
			createdAt: 2,
			parentId: "parent",
			cwd: "/work/branch",
		});
		expect(sub.meta.parentId).toBe("parent");
		expect(sub.meta.cwd).toBe("/work/branch");
	});
});

describe("app · 默认快照帧", () => {
	function bareRuntime() {
		const clock = fakeClock();
		const transport = fakeTransport();
		const runtime = new ClientRuntime({
			clientId: "c1",
			cwd: "/work",
			workspaceRoots: ["/work"],
			env: { settingsVersion: 7, piConfigured: true, piAgentInstalled: false },
			clock,
			transport: transport.port,
		});
		return { runtime, transport, clock };
	}

	it("空对话也能出协议合法的 snapshot 帧", () => {
		const { runtime, transport } = bareRuntime();
		const conv = runtime.createConversation({ id: "c1", kind: "user", createdAt: 1 });
		runtime.handlers().flushSnapshot(true);
		expect(transport.sent).toHaveLength(1);
		const frame = transport.sent[0] as unknown as { type: string; state: Record<string, unknown> };
		expect(frame.type).toBe("snapshot");
		expect(frame.state.clientId).toBe("c1");
		expect(frame.state.cwd).toBe("/work");
		expect(frame.state.conversationId).toBe(conv.id);
		expect(frame.state.sessionId).toBe(conv.id);
		expect(frame.state.messages).toEqual([]);
		expect(frame.state.isStreaming).toBe(false);
		expect(frame.state.version).toBe(7);
		expect(frame.state.piConfigured).toBe(true);
		expect(frame.state.queue).toEqual({ steering: [], followUp: [] });
	});

	it("没有活动对话时给空字段而不是省字段", () => {
		const { runtime, transport } = bareRuntime();
		runtime.handlers().flushSnapshot(true);
		const frame = transport.sent[0] as unknown as { state: Record<string, unknown> };
		expect(frame.state.conversationId).toBe("");
		expect(frame.state.sessionId).toBe("");
		expect(frame.state.messages).toEqual([]);
	});

	it("视图注入后帧带上消息与排队的字符串副本", () => {
		const clock = fakeClock();
		const transport = fakeTransport();
		const runtime = new ClientRuntime({
			clientId: "c1",
			cwd: "/work",
			env: { settingsVersion: 1, piConfigured: true, piAgentInstalled: true },
			clock,
			transport: transport.port,
			viewOf: (conv) => ({
				conversationId: conv.id,
				sessionId: "s1",
				messages: [{ id: "m1", role: "user", content: [] }],
				streamingMessage: null,
				isStreaming: true,
				model: { id: "m", name: "M", provider: "p", vision: false },
				thinkingLevel: "high",
				availableThinkingLevels: ["off", "high"],
				tools: ["read", "bash"],
				steering: ["排队一"],
				followUp: [],
			}),
		});
		runtime.createConversation({ id: "c1", kind: "user", createdAt: 1 });
		runtime.handlers().flushSnapshot(true);
		const frame = transport.sent[0] as unknown as { state: Record<string, unknown> };
		expect(frame.state.sessionId).toBe("s1");
		expect((frame.state.messages as unknown[]).length).toBe(1);
		expect(frame.state.isStreaming).toBe(true);
		expect(frame.state.thinkingLevel).toBe("high");
		expect(frame.state.tools).toEqual(["read", "bash"]);
		expect(frame.state.queue).toMatchObject({ steering: ["排队一"], followUp: [] });
	});
});
