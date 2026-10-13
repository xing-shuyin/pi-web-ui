import { describe, expect, it, vi } from "vitest";
import { ClientSession } from "../../server/agent-service.js";

type AnySession = Record<string, (...args: unknown[]) => unknown>;

function priv(name: string): (this: unknown, ...args: unknown[]) => unknown {
	return (ClientSession.prototype as unknown as Record<string, (this: unknown, ...a: unknown[]) => unknown>)[name];
}

function fakeConv(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "c1",
		title: "新对话",
		isSubagent: false,
		pinned: undefined,
		listed: false,
		promptedSinceActive: false,
		goal: { reviewing: false },
		wizardRunning: false,
		session: {
			isStreaming: false,
			isCompacting: false,
			sessionFile: undefined,
			getSessionStats: () => ({ totalMessages: 0 }),
		},
		terminals: { countBlockingLive: () => 0, countUserBlockingLive: () => 0 },
		...overrides,
	};
}

function makeCs(props: Record<string, unknown>): ClientSession {
	const cs = Object.create(ClientSession.prototype);
	for (const [k, v] of Object.entries(props)) {
		Object.defineProperty(cs, k, { value: v, writable: true, configurable: true });
	}
	return cs as unknown as ClientSession;
}

describe("retainFinishedConversations（结束的对话切换时不自动从运行的对话消失）", () => {
	it("开关关闭（默认）：空闲会话切走时被置换移出", () => {
		const conv = fakeConv({
			title: "聊过的对话",
			session: {
				isStreaming: false,
				isCompacting: false,
				sessionFile: undefined,
				getSessionStats: () => ({ totalMessages: 2 }),
			},
		});
		const cs = makeCs({
			conv,
			activeId: "c1",
			convs: new Map([["c1", conv]]),
			settingsSvc: { current: { retainFinishedConversations: false } },
		});

		const displaced = priv("displaceActive").call(cs);
		expect(displaced).toBe(conv);
	});

	it("开关开启：空闲但有消息的会话切走时保留，且 listed 被置位", () => {
		const conv = fakeConv({
			title: "聊过的对话",
			session: {
				isStreaming: false,
				isCompacting: false,
				sessionFile: undefined,
				getSessionStats: () => ({ totalMessages: 2 }),
			},
		});
		const cs = makeCs({
			conv,
			activeId: "c1",
			convs: new Map([["c1", conv]]),
			settingsSvc: { current: { retainFinishedConversations: true } },
		});

		const displaced = priv("displaceActive").call(cs);
		expect(displaced).toBeNull();
		expect(conv.listed).toBe(true);
	});

	it("开关开启：空闲且已在运行列表中（listed=true）的会话，看后切走依然保留", () => {
		const conv = fakeConv({
			title: "已在列表里的会话",
			listed: true,
			promptedSinceActive: false, // 看过但未发新消息
			session: {
				isStreaming: false,
				isCompacting: false,
				sessionFile: undefined,
				getSessionStats: () => ({ totalMessages: 0 }),
			},
		});
		const cs = makeCs({
			conv,
			activeId: "c1",
			convs: new Map([["c1", conv]]),
			settingsSvc: { current: { retainFinishedConversations: true } },
		});

		const displaced = priv("displaceActive").call(cs);
		expect(displaced).toBeNull();
		expect(conv.listed).toBe(true);
	});

	it("开关开启：全新空白且未聊过的会话（无消息、默认标题、未列出）切走时不保留，避免堆满空白对话", () => {
		const conv = fakeConv({
			title: "新对话",
			listed: false,
			session: {
				isStreaming: false,
				isCompacting: false,
				sessionFile: undefined,
				getSessionStats: () => ({ totalMessages: 0 }),
			},
		});
		const cs = makeCs({
			conv,
			activeId: "c1",
			convs: new Map([["c1", conv]]),
			settingsSvc: { current: { retainFinishedConversations: true } },
		});

		const displaced = priv("displaceActive").call(cs);
		expect(displaced).toBe(conv);
	});

	it("开关开启时用户显式 ✕ 移出（dismissConversation）：依然可以正常移出", async () => {
		const conv = fakeConv({
			title: "聊过的对话",
			listed: true,
			session: {
				isStreaming: false,
				isCompacting: false,
				sessionFile: undefined,
				getSessionStats: () => ({ totalMessages: 2 }),
			},
		});
		const convs = new Map([["c1", conv]]);
		const cs = makeCs({
			conv,
			convs,
			activeId: "c2",
			emit: vi.fn(),
			emitConversations: vi.fn(),
			flushSnapshot: vi.fn(),
			shownInRunningList: () => true,
			isDismissableFinishedSubagent: () => false,
			removeConversation: vi.fn((id: string) => {
				convs.delete(id);
			}),
			settingsSvc: { current: { retainFinishedConversations: true } },
		});

		await (ClientSession.prototype as unknown as AnySession).dismissConversation.call(cs, "c1", false, false);
		expect((cs as unknown as { removeConversation: unknown }).removeConversation).toHaveBeenCalledWith("c1");
	});

	it("上限提醒文案随 retainFinishedConversations 切换", () => {
		const csOn = makeCs({
			settingsSvc: { current: { retainFinishedConversations: true } },
		});
		const noticeOn = priv("maxOpenConversationsNotice").call(csOn, 8) as { text: string; textEn: string };
		expect(noticeOn.text).toContain("点击 ✕ 移出");
		expect(noticeOn.textEn).toContain("remove unneeded conversations with ✕");

		const csOff = makeCs({
			settingsSvc: { current: { retainFinishedConversations: false } },
		});
		const noticeOff = priv("maxOpenConversationsNotice").call(csOff, 8) as { text: string; textEn: string };
		expect(noticeOff.text).toContain("打开后离开不继续对话即移出");
		expect(noticeOff.textEn).toContain("Open one and leave it (without continuing) to remove it");
	});
});
