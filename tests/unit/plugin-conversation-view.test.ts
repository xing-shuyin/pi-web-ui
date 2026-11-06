import { describe, expect, it } from "vitest";
import {
	modelChangeKey,
	pickClientConversation,
	pickLatestClientSnapshot,
} from "../../server/plugin-conversation-view.js";

const conv = (id: string, lastActiveAt: number, isSubagent = false) => ({ id, lastActiveAt, isSubagent });

describe("pickClientConversation", () => {
	it("给了 active 就返回它，即使它不是最近活跃的（标签页正在看的对话优先）", () => {
		const convs = [conv("a", 100), conv("b", 900)];
		expect(pickClientConversation(convs, { active: convs[0] })?.id).toBe("a");
	});

	it("没有 active 命中时退回归属本客户端的最近活跃会话", () => {
		const convs = [conv("a", 100), conv("b", 900), conv("c", 500)];
		expect(pickClientConversation(convs)?.id).toBe("b");
		expect(pickClientConversation(convs, { active: undefined })?.id).toBe("b");
		expect(pickClientConversation([])).toBeNull();
	});

	it("缺省跳过子代理（含 active 是子代理的情形）——子代理跑得再勤也不挤出用户正看的对话", () => {
		const parent = conv("parent", 100);
		const child = conv("child", 900, true);
		expect(pickClientConversation([parent, child], { active: child })?.id).toBe("parent");
		expect(pickClientConversation([child])).toBeNull();
	});

	it("includeSubagents 时子代理照算（显式按 clientId 取快照走这条）", () => {
		const parent = conv("parent", 100);
		const child = conv("child", 900, true);
		expect(pickClientConversation([parent, child], { includeSubagents: true })?.id).toBe("child");
		expect(pickClientConversation([parent, child], { active: child, includeSubagents: true })?.id).toBe("child");
	});

	it("lastActiveAt 相等时保留先遇到的（不来回跳）", () => {
		expect(pickClientConversation([conv("first", 5), conv("second", 5)])?.id).toBe("first");
	});
});

describe("pickLatestClientSnapshot", () => {
	it("取 at 最大者，跳过子代理与 null/undefined", () => {
		const snaps = [
			{ conversationId: "a", at: 10, isSubagent: false },
			null,
			{ conversationId: "b", at: 99, isSubagent: true },
			undefined,
			{ conversationId: "c", at: 50, isSubagent: false },
		];
		expect(pickLatestClientSnapshot(snaps)?.conversationId).toBe("c");
	});

	it("全是子代理（或全空）→ null", () => {
		expect(pickLatestClientSnapshot([{ conversationId: "b", at: 99, isSubagent: true }])).toBeNull();
		expect(pickLatestClientSnapshot([])).toBeNull();
		expect(pickLatestClientSnapshot([null, undefined])).toBeNull();
	});
});

describe("modelChangeKey", () => {
	it("客户端 / 对话 / 模型任一不同即不同键（A→B→A 能再次触发）", () => {
		const base = { clientId: "t1", conversationId: "c1", model: "openai/gpt-5" };
		expect(modelChangeKey(base)).toBe(modelChangeKey({ ...base }));
		expect(modelChangeKey(base)).not.toBe(modelChangeKey({ ...base, clientId: "t2" }));
		expect(modelChangeKey(base)).not.toBe(modelChangeKey({ ...base, conversationId: "c2" }));
		expect(modelChangeKey(base)).not.toBe(modelChangeKey({ ...base, model: "anthropic/sonnet" }));
	});

	it("没有模型（未选）与空串同键", () => {
		expect(modelChangeKey({ clientId: "t", conversationId: "c" })).toBe(
			modelChangeKey({ clientId: "t", conversationId: "c", model: "" }),
		);
	});
});
