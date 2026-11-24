import { describe, expect, it, vi } from "vitest";
import { ClientRuntime, type ClientRuntimeOptions } from "../../packages/keel/src/app/client-runtime.js";
import { CoreEngineNotReadyError } from "../../packages/keel/src/app/core-engine.js";
import type { ClockPort } from "../../packages/keel/src/contracts/ports.js";
import type { ServerMessage } from "../../server/protocol.js";
import type { SnapshotBuilders } from "../../packages/keel/src/domains/snapshots/index.js";

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

function makeRuntime(overrides: Partial<ClientRuntimeOptions> = {}) {
	const clock = fakeClock();
	const transport = fakeTransport();
	const build = builders();
	const runtime = new ClientRuntime({
		clientId: "client-1",
		cwd: "/work",
		workspaceRoots: ["/work"],
		env: () => ({ settingsVersion: 1, piConfigured: true, piAgentInstalled: false }),
		clock,
		transport: transport.port,
		builders: build,
		...overrides,
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
	});

	it("没接 session registry 时 prompt 不抛：只上报错误", async () => {
		const errors: unknown[] = [];
		const clock = fakeClock();
		const transport = fakeTransport();
		const runtime = new ClientRuntime({
			clientId: "c1",
			cwd: "/work",
			env: () => ({ settingsVersion: 0, piConfigured: false, piAgentInstalled: false }),
			clock,
			transport: transport.port,
			onTurnError: (_id, err) => void errors.push(err),
		});
		runtime.handlers().prompt("hi");
		// prompt 现在要先过「斜杠命令」与「附件」两道闸（都是 async）：等那条链走完再断言。
		await new Promise((r) => setTimeout(r, 0));
		expect(errors).toHaveLength(1);
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
			env: () => ({ settingsVersion: 7, piConfigured: true, piAgentInstalled: false }),
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
			env: () => ({ settingsVersion: 1, piConfigured: true, piAgentInstalled: true }),
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

describe("app · 连接期帧", () => {
	function withFrames() {
		const clock = fakeClock();
		const transport = fakeTransport();
		const calls: string[] = [];
		const runtime = new ClientRuntime({
			clientId: "c1",
			cwd: "/work",
			env: () => ({ settingsVersion: 1, piConfigured: true, piAgentInstalled: true }),
			clock,
			transport: transport.port,
		});
		runtime.attachFrames({
			pushSettings: () => void calls.push("settings"),
			refreshSessions: async () => void calls.push("sessions"),
			pushProjects: async () => void calls.push("projects"),
			listModels: () => void calls.push("models"),
			pushDefaultModel: () => void calls.push("defaultModel"),
		});
		return { runtime, calls, transport };
	}

	it("四个连接期 handler 都转发给装配好的帧", async () => {
		const { runtime, calls } = withFrames();
		const cs = runtime.handlers();
		cs.pushSettings();
		cs.pushProjects();
		cs.listModels();
		await cs.refreshSessions();
		expect(calls).toEqual(["settings", "projects", "models", "sessions"]);
	});

	it("没装配帧时这四个 handler 明确报未就绪", () => {
		const clock = fakeClock();
		const transport = fakeTransport();
		const runtime = new ClientRuntime({
			clientId: "c1",
			cwd: "/work",
			env: () => ({ settingsVersion: 1, piConfigured: true, piAgentInstalled: true }),
			clock,
			transport: transport.port,
		});
		const cs = runtime.handlers();
		expect(() => cs.pushSettings()).toThrow(CoreEngineNotReadyError);
		expect(() => cs.listModels()).toThrow(CoreEngineNotReadyError);
	});

	it("会话文件路径喂进 history 根，续扫状态复用同一份", () => {
		const { runtime } = withFrames();
		runtime.noteSessionFile("/agent/sessions/--c--/s1.jsonl");
		expect(runtime.historyRoot()).toBe("/agent/sessions/--c--");
		expect(runtime.historyState()).toBe(runtime.historyState());
	});
});

describe("app · 会话管理 handler", () => {
	function adminRuntime() {
		const clock = fakeClock();
		const transport = fakeTransport();
		const runtime = new ClientRuntime({
			clientId: "c1",
			cwd: "/work",
			env: () => ({ settingsVersion: 1, piConfigured: true, piAgentInstalled: true }),
			clock,
			transport: transport.port,
			isAllowedPath: () => false,
		});
		return { runtime, transport };
	}

	it("renameConversation 改标题并触碰活跃时间", async () => {
		const { runtime } = adminRuntime();
		const conv = runtime.createConversation({ id: "c1", kind: "user", createdAt: 1 });
		await runtime.handlers().renameConversation("c1", "  新标题 ");
		expect(conv.meta.title).toBe("新标题");
		expect(conv.meta.lastActiveAt).toBe(1000);
	});

	it("renameConversation 对未知对话不抛", async () => {
		const { runtime } = adminRuntime();
		await expect(runtime.handlers().renameConversation("nope", "x")).resolves.toBeUndefined();
	});

	it("dismissConversation 退役并从注册表摘除，幂等", async () => {
		const { runtime } = adminRuntime();
		runtime.createConversation({ id: "c1", kind: "user", createdAt: 1 });
		const cs = runtime.handlers();
		await cs.dismissConversation("c1");
		expect(runtime.registry.has("c1")).toBe(false);
		await expect(cs.dismissConversation("c1")).resolves.toBeUndefined();
	});

	it("deleteSession 在路径不被允许时不动注册表", async () => {
		const { runtime } = adminRuntime();
		runtime.createConversation({ id: "c1", kind: "user", createdAt: 1, sessionFile: "/agent/sessions/x.jsonl" });
		await runtime.handlers().deleteSession("/agent/sessions/x.jsonl");
		expect(runtime.registry.has("c1")).toBe(true);
		expect(runtime.registry.bySessionFile("/agent/sessions/x.jsonl")?.id).toBe("c1");
	});
});

describe("app · 前端回包 handler", () => {
	it("审批 / 问卷回包转给注入的回调，缺省返回 false 而不是抛", async () => {
		const calls: string[] = [];
		const clock = fakeClock();
		const transport = fakeTransport();
		const runtime = new ClientRuntime({
			clientId: "c1",
			cwd: "/work",
			env: () => ({ settingsVersion: 1, piConfigured: true, piAgentInstalled: false }),
			clock,
			transport: transport.port,
			resolveToolApproval: (id) => {
				calls.push(`approval:${id}`);
				return true;
			},
			resolveQuestion: (id) => {
				calls.push(`question:${id}`);
				return true;
			},
			answerQuestion: async (id) => {
				calls.push(`answer:${id}`);
			},
		});
		const cs = runtime.handlers();
		expect(cs.resolveToolApproval?.("a1", "approve")).toBe(true);
		expect(cs.resolveQuestion?.("q1", [])).toBe(true);
		await cs.answerQuestion?.("q2", []);
		expect(calls).toEqual(["approval:a1", "question:q1", "answer:q2"]);

		const bare = new ClientRuntime({
			clientId: "c2",
			cwd: "/work",
			env: () => ({ settingsVersion: 1, piConfigured: false, piAgentInstalled: false }),
			clock,
			transport: transport.port,
		}).handlers();
		expect(bare.resolveToolApproval?.("x", "deny")).toBe(false);
		expect(bare.resolveQuestion?.("x", [])).toBe(false);
	});
});

describe("app · 三个连接期零碎 handler", () => {
	it("respondWithSnapshot：没报 since 就强制全量，报了 since 走闸门", () => {
		const clock = fakeClock();
		const transport = fakeTransport();
		const runtime = new ClientRuntime({
			clientId: "c1",
			cwd: "/work",
			env: () => ({ settingsVersion: 1, piConfigured: true, piAgentInstalled: false }),
			clock,
			transport: transport.port,
		});
		const cs = runtime.handlers();
		cs.respondWithSnapshot?.(transport.port.send);
		expect(transport.sent.filter((m) => m.type === "snapshot").length).toBe(1);
	});

	it("getLang / emitNotice 有缺省值，不发未定义", () => {
		const clock = fakeClock();
		const transport = fakeTransport();
		const runtime = new ClientRuntime({
			clientId: "c1",
			cwd: "/work",
			env: () => ({ settingsVersion: 1, piConfigured: true, piAgentInstalled: false }),
			clock,
			transport: transport.port,
			getLang: () => "en",
		});
		const cs = runtime.handlers();
		expect(cs.getLang()).toBe("en");
		cs.emitNotice("warning", "hello", "hello-en");
		const notice = transport.sent.find((m) => m.type === "notice") as { text: string; textEn?: string } | undefined;
		expect(notice?.text).toBe("hello");
		expect(notice?.textEn).toBe("hello-en");
	});
});

describe("app · 斜杠命令（D）：命中就不进模型", () => {
	function slashRuntime(handled: boolean) {
		const exec = vi.fn(async () => handled);
		const feedTurn = vi.fn(async () => {});
		const { runtime, transport } = makeRuntime({ slashCommands: () => ({ push: () => {}, exec }) });
		// 喂轮出口只许走 `TurnRunner`：这里直接盯「有没有真的喂进去」。
		runtime.feedTurn = feedTurn;
		return { runtime, transport, exec, feedTurn };
	}

	it("命令命中：出帧口 flushed，文本不进模型", async () => {
		const { runtime, transport, exec, feedTurn } = slashRuntime(true);
		await runtime.handlers().prompt("/cwd /work");
		expect(exec).toHaveBeenCalledTimes(1);
		// 命令解析与语义都在宿主端口：内核把原文和动作一起递过去。
		const [text, actions] = exec.mock.calls[0] as unknown as [string, { clientId: string }];
		expect(text).toBe("/cwd /work");
		expect(actions.clientId).toBe("client-1");
		expect(feedTurn).not.toHaveBeenCalled();
	});

	it("不是命令：原样喂给模型", async () => {
		const { runtime, exec, feedTurn } = slashRuntime(false);
		await runtime.handlers().prompt("你好");
		expect(exec).toHaveBeenCalledTimes(1);
		expect(feedTurn).toHaveBeenCalledWith("你好", undefined);
	});

	it("端口没接：文本照常喂给模型（不静默吞消息）", async () => {
		const { runtime } = makeRuntime();
		const feedTurn = vi.fn(async () => {});
		runtime.feedTurn = feedTurn;
		await runtime.handlers().prompt("/help");
		expect(feedTurn).toHaveBeenCalledWith("/help", undefined);
	});
});
