import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationId } from "../../server/core/contracts/ids.js";
import type { ClockPort } from "../../server/core/contracts/ports.js";
import type { TurnCapableSession, TurnEvents, TurnOutcome } from "../../server/core/contracts/session.js";
import { feedSteer, feedTurn } from "../../server/core/domains/turns/feed.js";
import { TurnRejectedError, TurnRunner } from "../../server/core/domains/turns/index.js";
import { Conversation } from "../../server/core/kernel/conversation/index.js";
import { guardSession, isRetiredSession, promptSession, SessionRetiredError } from "../../server/session-turns.js";

vi.mock("../../server/core/domains/turns/feed.js", () => ({ feedSteer: vi.fn(), feedTurn: vi.fn() }));

const feedTurnMock = vi.mocked(feedTurn);
const feedSteerMock = vi.mocked(feedSteer);

class FakeClock implements ClockPort {
	current = 1_000;
	reads = 0;

	now(): number {
		this.reads += 1;
		return this.current;
	}

	after(): () => void {
		return () => {};
	}
}

interface StreamingEvent {
	conversationId: ConversationId;
	streaming: boolean;
	at: number;
}

interface SettledEvent {
	conversationId: ConversationId;
	outcome: TurnOutcome;
	at: number;
}

function recordingEvents() {
	const streaming: StreamingEvent[] = [];
	const settled: SettledEvent[] = [];
	const events: TurnEvents = {
		onStreamingChanged: (conversationId, value, at) => streaming.push({ conversationId, streaming: value, at }),
		onTurnSettled: (conversationId, outcome, at) => settled.push({ conversationId, outcome, at }),
	};
	return { events, streaming, settled };
}

function makeConversation(id = "c1"): Conversation {
	return new Conversation({ id, clientId: "client-1", cwd: "/work", kind: "user", createdAt: 1_000 });
}

function makeSession(): TurnCapableSession {
	return { dispose: vi.fn(), isStreaming: false };
}

function makeRunner(clock = new FakeClock(), events?: TurnEvents): TurnRunner {
	return new TurnRunner({ clock, events });
}

beforeEach(() => {
	vi.clearAllMocks();
	feedTurnMock.mockResolvedValue(undefined);
	feedSteerMock.mockResolvedValue(undefined);
});

describe("turn-runner · 正常回合", () => {
	it("start 开一轮：相位回 idle、喂轮一次、返回 done", async () => {
		const clock = new FakeClock();
		const runner = makeRunner(clock);
		const conv = makeConversation();
		const session = makeSession();

		await expect(runner.start(conv, session, "你好")).resolves.toBe("done");

		expect(feedTurnMock).toHaveBeenCalledTimes(1);
		expect(feedTurnMock).toHaveBeenCalledWith(session, "你好");
		expect(conv.phase).toBe("idle");
		expect(conv.meta.lastActiveAt).toBe(clock.current);
		expect(runner.isStreaming("c1")).toBe(false);
	});

	it("streaming 与 settle 事件各按次数发出，done 只在真正 settle 时发", async () => {
		const clock = new FakeClock();
		const { events, streaming, settled } = recordingEvents();
		const runner = makeRunner(clock, events);

		await runner.start(makeConversation(), makeSession(), "hi");

		expect(streaming).toEqual([
			{ conversationId: "c1", streaming: true, at: 1_000 },
			{ conversationId: "c1", streaming: false, at: 1_000 },
		]);
		expect(settled).toEqual([{ conversationId: "c1", outcome: "done", at: 1_000 }]);
	});

	it("时间全取注入 clock：begin 与 settle 各读一次", async () => {
		const clock = new FakeClock();
		const { events, streaming, settled } = recordingEvents();
		const runner = makeRunner(clock, events);
		const conv = makeConversation();
		feedTurnMock.mockImplementation(async () => {
			clock.current = 2_500;
		});

		await runner.start(conv, makeSession(), "hi");

		expect(clock.reads).toBe(2);
		expect(streaming.map((event) => event.at)).toEqual([1_000, 2_500]);
		expect(settled[0].at).toBe(2_500);
		expect(conv.meta.lastActiveAt).toBe(2_500);
	});

	it("喂轮进行中 isStreaming 为 true 且相位 running，settle 后归位", async () => {
		const runner = makeRunner();
		const conv = makeConversation();
		let release: () => void = () => {};
		feedTurnMock.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);

		const pending = runner.start(conv, makeSession(), "hi");
		expect(runner.isStreaming("c1")).toBe(true);
		expect(conv.phase).toBe("running");

		release();
		await expect(pending).resolves.toBe("done");
		expect(runner.isStreaming("c1")).toBe(false);
		expect(conv.phase).toBe("idle");
	});

	it("事件全可不传：没有 events 也能跑完一轮", async () => {
		const runner = makeRunner();
		await expect(runner.start(makeConversation(), makeSession(), "hi")).resolves.toBe("done");
	});
});

describe("turn-runner · 失败回收", () => {
	it("普通错误：相位回 idle、streaming 清、settled=failed、原错误原样 rethrow", async () => {
		const { events, streaming, settled } = recordingEvents();
		const runner = makeRunner(new FakeClock(), events);
		const conv = makeConversation();
		const boom = new Error("boom");
		feedTurnMock.mockRejectedValue(boom);

		await expect(runner.start(conv, makeSession(), "hi")).rejects.toBe(boom);

		expect(conv.phase).toBe("idle");
		expect(runner.isStreaming("c1")).toBe(false);
		expect(streaming.map((event) => event.streaming)).toEqual([true, false]);
		expect(settled).toEqual([{ conversationId: "c1", outcome: "failed", at: 1_000 }]);
	});

	it("会话退役：真 SessionRetiredError 原样透传（同一实例，不改写成 TurnRejectedError）", async () => {
		const { events, settled } = recordingEvents();
		const runner = makeRunner(new FakeClock(), events);
		const conv = makeConversation();
		const session = { dispose: vi.fn(), sendUserMessage: vi.fn(async () => {}) };
		guardSession(session);
		session.dispose();
		expect(isRetiredSession(session)).toBe(true);
		feedTurnMock.mockImplementation((target, text) => promptSession(target as never, text));

		const error = await runner.start(conv, session, "hi").catch((err: unknown) => err);

		expect(error).toBeInstanceOf(SessionRetiredError);
		expect((error as SessionRetiredError).code).toBe("session_retired");
		expect(conv.phase).toBe("idle");
		expect(runner.isStreaming("c1")).toBe(false);
		expect(settled.map((event) => event.outcome)).toEqual(["failed"]);
	});

	it("喂轮期间相位被退役带走（running → retiring）时不让 endTurn 掩盖原错误", async () => {
		const runner = makeRunner();
		const conv = makeConversation();
		const boom = new Error("boom");
		feedTurnMock.mockImplementation(async () => {
			conv.retire();
			throw boom;
		});

		await expect(runner.start(conv, makeSession(), "hi")).rejects.toBe(boom);
		expect(conv.phase).toBe("retiring");
		expect(runner.isStreaming("c1")).toBe(false);
	});

	it("非 Error 的拒绝值也原样上抛（不包装）", async () => {
		const runner = makeRunner();
		const conv = makeConversation();
		feedTurnMock.mockRejectedValue("plain rejection");

		await expect(runner.start(conv, makeSession(), "hi")).rejects.toBe("plain rejection");
		expect(conv.phase).toBe("idle");
	});
});

describe("turn-runner · fail-closed 拒绝", () => {
	it("retiring 相位 start 立即拒，feed 零调用", async () => {
		const { events, streaming, settled } = recordingEvents();
		const runner = makeRunner(new FakeClock(), events);
		const conv = makeConversation();
		conv.retire();

		const error = await runner.start(conv, makeSession(), "hi").catch((err: unknown) => err);

		expect(error).toBeInstanceOf(TurnRejectedError);
		expect((error as TurnRejectedError).code).toBe("turn_rejected");
		expect(feedTurnMock).not.toHaveBeenCalled();
		expect(conv.phase).toBe("retiring");
		expect(streaming).toEqual([]);
		expect(settled).toEqual([]);
	});

	it("retired 相位 steer 立即拒，feedSteer 零调用", async () => {
		const runner = makeRunner();
		const conv = makeConversation();
		conv.retire();
		conv.finishRetire();

		await expect(runner.steer(conv, makeSession(), "hi")).rejects.toBeInstanceOf(TurnRejectedError);
		expect(feedSteerMock).not.toHaveBeenCalled();
	});

	it("running 相位不带 deliverAs 再开一轮被拒（不静默叠一轮）", async () => {
		const runner = makeRunner();
		const conv = makeConversation();
		conv.beginTurn(900);

		await expect(runner.start(conv, makeSession(), "hi")).rejects.toBeInstanceOf(TurnRejectedError);
		expect(feedTurnMock).not.toHaveBeenCalled();
		expect(conv.phase).toBe("running");
	});
});

describe("turn-runner · deliverAs 投递", () => {
	it("running 时直接投递，不重置相位、不发 settle 事件", async () => {
		const { events, streaming, settled } = recordingEvents();
		const runner = makeRunner(new FakeClock(), events);
		const conv = makeConversation();
		conv.beginTurn(900);
		const session = makeSession();

		await expect(runner.start(conv, session, "补充", { deliverAs: "steer" })).resolves.toBe("done");

		expect(feedTurnMock).toHaveBeenCalledWith(session, "补充", "steer");
		expect(conv.phase).toBe("running");
		expect(conv.meta.lastActiveAt).toBe(900);
		expect(streaming).toEqual([]);
		expect(settled).toEqual([]);
	});

	it("deliverAs=followUp 原样透传给 feed", async () => {
		const runner = makeRunner();
		const conv = makeConversation();
		conv.beginTurn(900);
		const session = makeSession();

		await runner.start(conv, session, "等会儿", { deliverAs: "followUp" });

		expect(feedTurnMock).toHaveBeenCalledWith(session, "等会儿", "followUp");
		expect(conv.phase).toBe("running");
	});

	it("idle 相位传 deliverAs 被拒（那一轮并不存在）", async () => {
		const runner = makeRunner();
		const conv = makeConversation();

		await expect(runner.start(conv, makeSession(), "hi", { deliverAs: "steer" })).rejects.toBeInstanceOf(
			TurnRejectedError,
		);
		expect(feedTurnMock).not.toHaveBeenCalled();
		expect(conv.phase).toBe("idle");
	});

	it("deliverAs 的喂轮失败原样上抛，且相位不受影响", async () => {
		const runner = makeRunner();
		const conv = makeConversation();
		conv.beginTurn(900);
		const boom = new Error("deliver boom");
		feedTurnMock.mockRejectedValue(boom);

		await expect(runner.start(conv, makeSession(), "hi", { deliverAs: "steer" })).rejects.toBe(boom);
		expect(conv.phase).toBe("running");
	});
});

describe("turn-runner · steer", () => {
	it("idle 相位 steer 被拒，feedSteer 零调用", async () => {
		const runner = makeRunner();

		await expect(runner.steer(makeConversation(), makeSession(), "hi")).rejects.toBeInstanceOf(TurnRejectedError);
		expect(feedSteerMock).not.toHaveBeenCalled();
	});

	it("running 相位 steer 透传，不 settle、不改相位", async () => {
		const { events, streaming, settled } = recordingEvents();
		const runner = makeRunner(new FakeClock(), events);
		const conv = makeConversation();
		conv.beginTurn(900);
		const session = makeSession();

		await runner.steer(conv, session, "插队");

		expect(feedSteerMock).toHaveBeenCalledWith(session, "插队");
		expect(conv.phase).toBe("running");
		expect(streaming).toEqual([]);
		expect(settled).toEqual([]);
	});

	it("steer 的退役错误原样透传", async () => {
		const runner = makeRunner();
		const conv = makeConversation();
		conv.beginTurn(900);
		const session = { dispose: vi.fn(), sendUserMessage: vi.fn(async () => {}) };
		guardSession(session);
		session.dispose();
		feedSteerMock.mockImplementation((target, text) => promptSession(target as never, text));

		await expect(runner.steer(conv, session, "插队")).rejects.toBeInstanceOf(SessionRetiredError);
		expect(conv.phase).toBe("running");
	});
});

describe("turn-runner · 错误与身份", () => {
	it("TurnRejectedError 带稳定 code 与 name", () => {
		const error = new TurnRejectedError("c1", "phase retired");
		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe("TurnRejectedError");
		expect(error.code).toBe("turn_rejected");
		expect(error.message).toContain("c1");
	});

	it("isStreaming 按会话身份隔离", async () => {
		const runner = makeRunner();
		const first = makeConversation("c1");
		const second = makeConversation("c2");
		let release: () => void = () => {};
		feedTurnMock.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);

		const pending = runner.start(first, makeSession(), "hi");
		expect(runner.isStreaming("c1")).toBe(true);
		expect(runner.isStreaming("c2")).toBe(false);

		release();
		await pending;
		expect(runner.isStreaming("c1")).toBe(false);
	});
});
