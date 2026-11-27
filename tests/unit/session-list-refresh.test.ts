import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClientRuntime } from "../../packages/keel/src/app/client-runtime.js";
import { buildClientFrames } from "../../packages/keel/src/app/host-frames.js";
import type { ClockPort } from "../../packages/keel/src/contracts/ports.js";
import type { TurnCapableSession } from "../../packages/keel/src/contracts/session.js";
import { feedTurn } from "../../packages/keel/src/domains/turns/feed.js";
import type { ServerMessage } from "../../packages/keel/src/protocol.js";

vi.mock("../../packages/keel/src/domains/turns/feed.js", () => ({ feedTurn: vi.fn(), feedSteer: vi.fn() }));

const feedTurnMock = vi.mocked(feedTurn);

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
		advance(ms) {
			now += ms;
			for (const timer of timers.slice()) {
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
	return {
		sent,
		port: {
			send: (msg: ServerMessage) => void sent.push(msg),
			isClosed: () => false,
		},
	};
}

function makeRuntime(
	requested: string[] = [],
	turnEvents?: ConstructorParameters<typeof ClientRuntime>[0]["turnEvents"],
) {
	const clock = fakeClock();
	const transport = fakeTransport();
	const refreshSessionsFor = vi.fn(async (_cwd: string) => {});
	const runtime = new ClientRuntime({
		clientId: "client-1",
		cwd: "/work/current",
		env: () => ({ settingsVersion: 1, piConfigured: true, piAgentInstalled: false }),
		clock,
		transport: transport.port,
		turnEvents,
	});
	runtime.attachFrames({
		pushSettings: () => {},
		pushDefaultModel: () => {},
		refreshSessions: async () => {},
		refreshSessionsFor,
		pushProjects: async () => {},
		listModels: () => {},
	});
	for (const cwd of requested) runtime.noteSessionsRequested(cwd);
	return { runtime, clock, transport, refreshSessionsFor };
}

function session(): TurnCapableSession {
	return { dispose: vi.fn() };
}

async function finishTurn(runtime: ClientRuntime, id: string, cwd: string): Promise<void> {
	const conv = runtime.createConversation({ id, cwd, createdAt: 1 });
	await runtime.turns.start(conv, session(), "hello");
}

beforeEach(() => {
	vi.clearAllMocks();
	feedTurnMock.mockResolvedValue(undefined);
});

describe("回合收尾补推会话列表", () => {
	it("首轮立即推会话自己的 cwd，600ms 后再补一次尾部扫描", async () => {
		const { runtime, clock, refreshSessionsFor } = makeRuntime(["/work/other"]);

		await finishTurn(runtime, "c1", "/work/other");
		expect(refreshSessionsFor).toHaveBeenCalledTimes(1);
		expect(refreshSessionsFor).toHaveBeenLastCalledWith("/work/other");

		clock.advance(599);
		expect(refreshSessionsFor).toHaveBeenCalledTimes(1);
		clock.advance(1);
		expect(refreshSessionsFor).toHaveBeenCalledTimes(2);
	});

	it("600ms 内的后续轮次合并成一次尾部推送，路径归一后不重复首推", async () => {
		const { runtime, clock, refreshSessionsFor } = makeRuntime(["/work/other"]);

		await finishTurn(runtime, "c1", "/work/other");
		clock.advance(200);
		await finishTurn(runtime, "c2", "/work/other/");
		expect(refreshSessionsFor).toHaveBeenCalledTimes(1);

		clock.advance(599);
		expect(refreshSessionsFor).toHaveBeenCalledTimes(1);
		clock.advance(1);
		expect(refreshSessionsFor).toHaveBeenCalledTimes(2);
	});

	it("不同项目各自立即补推", async () => {
		const { runtime, refreshSessionsFor } = makeRuntime(["/work/a", "/work/b"]);

		await finishTurn(runtime, "a1", "/work/a");
		await finishTurn(runtime, "b1", "/work/b");
		expect(refreshSessionsFor.mock.calls.map(([cwd]) => cwd)).toEqual(["/work/a", "/work/b"]);
	});

	it("客户端没有请求过列表的项目不推", async () => {
		const { runtime, clock, refreshSessionsFor } = makeRuntime(["/work/a"]);

		await finishTurn(runtime, "b1", "/work/b");
		clock.advance(600);
		expect(refreshSessionsFor).not.toHaveBeenCalled();
	});

	it("先启动历史刷新，再通知宿主把运行行交给历史行", async () => {
		const order: string[] = [];
		const { runtime, refreshSessionsFor } = makeRuntime(["/work/other"], {
			onStreamingChanged: (_id, streaming) => {
				if (!streaming) order.push("conversations");
			},
		});
		refreshSessionsFor.mockImplementation(async () => {
			order.push("sessions");
		});

		await finishTurn(runtime, "c1", "/work/other");
		expect(order).toEqual(["sessions", "conversations"]);
	});

	it("失败轮次也会补推已写入的部分会话", async () => {
		feedTurnMock.mockRejectedValueOnce(new Error("boom"));
		const { runtime, refreshSessionsFor } = makeRuntime(["/work/other"]);
		const conv = runtime.createConversation({ id: "c1", cwd: "/work/other", createdAt: 1 });

		await expect(runtime.turns.start(conv, session(), "hello")).rejects.toThrow("boom");
		expect(refreshSessionsFor).toHaveBeenCalledWith("/work/other");
	});

	it("运行时销毁时取消尾部推送", async () => {
		const { runtime, clock, refreshSessionsFor } = makeRuntime(["/work/other"]);

		await finishTurn(runtime, "c1", "/work/other");
		expect(refreshSessionsFor).toHaveBeenCalledTimes(1);
		runtime.dispose();
		clock.advance(600);
		expect(refreshSessionsFor).toHaveBeenCalledTimes(1);
	});
});

describe("会话列表请求登记", () => {
	it("连接期或前端请求过历史列表后，回合收尾自动补推同一项目", async () => {
		const clock = fakeClock();
		const transport = fakeTransport();
		const runtime = new ClientRuntime({
			clientId: "client-1",
			cwd: "/work/current",
			env: () => ({ settingsVersion: 1, piConfigured: true, piAgentInstalled: false }),
			clock,
			transport: transport.port,
		});
		vi.spyOn(runtime, "historyRoot").mockReturnValue(undefined);
		vi.spyOn(runtime, "historyRootFor").mockReturnValue(undefined);
		const frames = buildClientFrames({
			transport: transport.port,
			stateStore: {
				isSessionPinned: () => false,
				getDefaultModel: () => undefined,
			} as never,
			clientId: "client-1",
			runtime,
			projectSource: {} as never,
			modelPusher: { push: async () => {} } as never,
		});
		runtime.attachFrames(frames);

		await frames.refreshSessions();
		transport.sent.length = 0;
		await finishTurn(runtime, "c1", "/work/current");
		expect(transport.sent.filter((msg) => msg.type === "sessions" && msg.cwd === "/work/current")).toHaveLength(1);
		clock.advance(600);
		expect(transport.sent.filter((msg) => msg.type === "sessions" && msg.cwd === "/work/current")).toHaveLength(2);
	});
});
