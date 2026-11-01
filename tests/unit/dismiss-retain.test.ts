import { describe, expect, it, vi } from "vitest";
import { ClientSession } from "../../server/agent-service.js";
import { fakeClientSession } from "../helpers/fake-session.js";

/* #579：用户显式 ✕ 移出「刚聊过、现已空闲」的对话不得被 promptedSinceActive
 * 拦下（那是 displaceActive 自动置换的保留依据，不是移出意图的否决）。
 * 真正的保留态（投递中 / 后台任务 / 审查等）仍须拦截。 */

type AnySession = Record<string, (...args: unknown[]) => unknown>;

function fakeCs(conv: Record<string, unknown>) {
	const emitted: Array<{ type?: string; text?: string }> = [];
	const convs = new Map<string, Record<string, unknown>>([[conv.id as string, conv]]);
	// 实例字段（parentExecutionKey 之类）由 fake-session 从生产源码推导 + 原型真方法继承；
	// 这里只覆写这条用例关心的行为。
	const cs = fakeClientSession({
		convs,
		activeId: "some-other-conv",
		emit: (msg: { type?: string; text?: string }) => emitted.push(msg),
		emitConversations: vi.fn(),
		flushSnapshot: vi.fn(),
		shownInRunningList: () => true,
		isDismissableFinishedSubagent: () => false,
		removeConversation: vi.fn((id: string) => {
			convs.delete(id);
		}),
	});
	return { cs, emitted };
}

function idleChat(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "c1",
		title: "聊过的对话",
		isSubagent: false,
		parentId: undefined,
		pinned: undefined,
		listed: true,
		promptedSinceActive: true,
		promptInFlight: false,
		goal: { reviewing: false },
		wizardRunning: false,
		session: { isStreaming: false, isCompacting: false, sessionFile: undefined },
		terminals: { countBlockingLive: () => 0, countUserBlockingLive: () => 0 },
		...overrides,
	};
}

const dismiss = (cs: unknown, id: string, force?: boolean) =>
	(ClientSession.prototype as unknown as AnySession).dismissConversation.call(cs, id, false, force);

describe("显式 ✕ 移出（dismissConversation）保留判定 (#579)", () => {
	it("空闲且刚聊过（promptedSinceActive）的对话：可以直接移出，不得报「暂时无法移出」", async () => {
		const conv = idleChat();
		const { cs, emitted } = fakeCs(conv);
		await dismiss(cs, "c1");
		expect(cs.removeConversation).toHaveBeenCalledWith("c1");
		expect(emitted.some((m) => m.text?.includes("暂时无法移出"))).toBe(false);
	});

	it("投递中（promptInFlight）仍是真保留态：拦截并提示", async () => {
		const conv = idleChat({ promptInFlight: true });
		const { cs, emitted } = fakeCs(conv);
		await dismiss(cs, "c1");
		expect(cs.removeConversation).not.toHaveBeenCalled();
		expect(emitted.some((m) => m.text?.includes("暂时无法移出"))).toBe(true);
	});

	it("审查中（goal.reviewing）仍是真保留态：拦截并提示", async () => {
		const conv = idleChat({ goal: { reviewing: true } });
		const { cs, emitted } = fakeCs(conv);
		await dismiss(cs, "c1");
		expect(cs.removeConversation).not.toHaveBeenCalled();
		expect(emitted.some((m) => m.text?.includes("暂时无法移出"))).toBe(true);
	});
});
