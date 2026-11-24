import { describe, expect, it, vi } from "vitest";
import type { ClockPort } from "../../packages/keel/src/contracts/ports.js";
import type { TurnCapableSession } from "../../packages/keel/src/contracts/session.js";
import { feedTurn } from "../../packages/keel/src/domains/turns/feed.js";
import { TurnRunner } from "../../packages/keel/src/domains/turns/index.js";
import { Conversation } from "../../packages/keel/src/kernel/conversation/index.js";

vi.mock("../../packages/keel/src/domains/turns/feed.js", () => ({ feedSteer: vi.fn(), feedTurn: vi.fn() }));

const feedTurnMock = vi.mocked(feedTurn);

const clock: ClockPort = { now: () => 1_000, after: () => () => {} };

function makeConversation(): Conversation {
	return new Conversation({ id: "c1", clientId: "cl", cwd: "/w", kind: "user", createdAt: 1_000 });
}

function makeSession(): TurnCapableSession {
	return { dispose: () => {}, isStreaming: false };
}

describe("TurnRunner.whenIdle", () => {
	it("没在跑的一轮：立刻完成", async () => {
		const runner = new TurnRunner({ clock });
		await expect(runner.whenIdle("c1")).resolves.toBeUndefined();
	});

	it("正在跑：等于那一轮喂轮 promise 收尾之后（编辑重问前的相位回收窗口）", async () => {
		let finish: () => void = () => {};
		feedTurnMock.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
		const runner = new TurnRunner({ clock });
		const conv = makeConversation();

		const turn = runner.start(conv, makeSession(), "hi");
		expect(runner.isStreaming("c1")).toBe(true);

		let settled = false;
		const idle = runner.whenIdle("c1").then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(conv.phase).toBe("running");

		finish();
		await turn;
		await idle;

		expect(settled).toBe(true);
		expect(conv.phase).toBe("idle");
		expect(runner.isStreaming("c1")).toBe(false);
	});

	it("同一对话的第二轮：等的是新注册的那一个", async () => {
		const finishes: Array<() => void> = [];
		feedTurnMock.mockImplementation(() => new Promise<void>((resolve) => finishes.push(resolve)));
		const runner = new TurnRunner({ clock });
		const conv = makeConversation();

		const first = runner.start(conv, makeSession(), "one");
		finishes[0]();
		await first;

		const second = runner.start(conv, makeSession(), "two");
		const idle = vi.fn();
		void runner.whenIdle("c1").then(idle);

		await Promise.resolve();
		expect(idle).not.toHaveBeenCalled();

		finishes[1]();
		await second;
		await Promise.resolve();
		expect(idle).toHaveBeenCalled();
	});
});
