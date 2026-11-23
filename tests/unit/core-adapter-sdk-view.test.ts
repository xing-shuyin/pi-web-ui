import { describe, expect, it, vi } from "vitest";
import {
	conversationViewFromSession,
	projectSessionMessages,
	projectStreamingMessage,
	subscribeSession,
	toWireModel,
} from "../../server/core/adapters/sdk/view.js";
import { Conversation } from "../../server/core/kernel/conversation/index.js";
import type { TurnCapableSession } from "../../server/core/contracts/session.js";

function makeConv() {
	return new Conversation({ id: "c1", clientId: "client-1", cwd: "/work", kind: "user", createdAt: 1 });
}

function makeSession(overrides: Partial<TurnCapableSession> = {}): TurnCapableSession {
	return {
		sessionId: "s1",
		sessionFile: "/agent/sessions/--w--/s1.jsonl",
		messages: [
			{ role: "user", content: "你好", timestamp: 1_000 },
			{ role: "assistant", content: [{ type: "text", text: "在的" }], timestamp: 2_000 },
		],
		isStreaming: false,
		thinkingLevel: "medium",
		model: { id: "m1", name: "Model One", provider: "p", input: ["text", "image"] },
		dispose: () => {},
		getAvailableThinkingLevels: () => ["off", "medium"],
		...overrides,
	};
}

describe("adapters/sdk · 会话 → 对话可见面", () => {
	it("消息按 serialize.ts 投影，数量与角色对齐", () => {
		const messages = projectSessionMessages(makeSession());
		expect(messages).toHaveLength(2);
		expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
	});

	it("同一份消息两次投影 id 稳定", () => {
		const session = makeSession();
		expect(projectSessionMessages(session).map((m) => m.id)).toEqual(projectSessionMessages(session).map((m) => m.id));
	});

	it("没有会话 / 没有消息时给空数组，不抛", () => {
		expect(projectSessionMessages(undefined)).toEqual([]);
		expect(projectSessionMessages(makeSession({ messages: [] }))).toEqual([]);
	});

	it("流式消息只在 isStreaming 时给", () => {
		expect(projectStreamingMessage(makeSession({ isStreaming: false }))).toBeNull();
		expect(projectStreamingMessage(undefined)).toBeNull();
	});

	it("模型字段按 SDK 实际字段映射，缺 id 返回 null", () => {
		expect(toWireModel({ id: "m1", name: "M", provider: "p", input: ["image"] })).toEqual({
			id: "m1",
			name: "M",
			provider: "p",
			vision: true,
		});
		expect(toWireModel({ id: "m1", input: ["text"] })?.vision).toBe(false);
		expect(toWireModel({})).toBeNull();
		expect(toWireModel(null)).toBeNull();
		expect(toWireModel({ id: "" })).toBeNull();
	});

	it("会话可见面把 sessionId/sessionFile/model/思考档位都带出来", () => {
		const conv = makeConv();
		const view = conversationViewFromSession(conv, makeSession(), ["read", "bash"]);
		expect(view.conversationId).toBe("c1");
		expect(view.sessionId).toBe("s1");
		expect(view.sessionFile).toBe("/agent/sessions/--w--/s1.jsonl");
		expect(view.messages).toHaveLength(2);
		expect(view.isStreaming).toBe(false);
		expect(view.thinkingLevel).toBe("medium");
		expect(view.availableThinkingLevels).toEqual(["off", "medium"]);
		expect(view.model).toMatchObject({ id: "m1", vision: true });
		expect(view.tools).toEqual(["read", "bash"]);
	});

	it("没有会话时回落到聚合状态（相位、排队、null 模型）", () => {
		const conv = makeConv();
		conv.queues.enqueue("steer", "排队一");
		conv.beginTurn(10);
		const view = conversationViewFromSession(conv, undefined);
		expect(view.messages).toEqual([]);
		expect(view.isStreaming).toBe(true);
		expect(view.model).toBeNull();
		expect(view.thinkingLevel).toBe("off");
		expect(view.steering).toEqual(["排队一"]);
		expect(view.sessionId).toBe("c1");
	});

	it("订阅会话事件：回调被转成 onChange，取消后不再触发", () => {
		const listeners: Array<(ev: unknown) => void> = [];
		const session = makeSession({
			subscribe: (listener) => {
				listeners.push(listener);
				return () => {
					const idx = listeners.indexOf(listener);
					if (idx >= 0) listeners.splice(idx, 1);
				};
			},
		});
		const onChange = vi.fn();
		const off = subscribeSession(session, onChange);
		listeners.forEach((l) => l({ type: "delta" }));
		expect(onChange).toHaveBeenCalledTimes(1);
		off();
		expect(listeners).toHaveLength(0);
	});

	it("会话不支持订阅时给空取消函数", () => {
		const off = subscribeSession(makeSession(), () => {});
		expect(() => off()).not.toThrow();
		expect(() => subscribeSession(undefined, () => {})()).not.toThrow();
	});
});
