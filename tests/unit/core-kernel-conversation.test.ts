import { describe, expect, it } from "vitest";
import {
	acceptsTurns,
	canTransition,
	Conversation,
	ConversationPhaseError,
	ConversationQueues,
	ConversationRegistry,
	normalizeTitle,
	transition,
} from "../../server/core/kernel/conversation/index.js";
import { DEFAULT_CONV_TITLE } from "../../server/agent-formatters.js";

const at = (ms: number) => ms;

function makeConv(id = "c1", extra: { sessionFile?: string; title?: string } = {}) {
	return new Conversation({
		id,
		clientId: "client-1",
		cwd: "/work",
		kind: "user",
		createdAt: 1_000,
		title: extra.title,
		sessionFile: extra.sessionFile,
	});
}

describe("kernel/conversation · 相位状态机", () => {
	it("允许的迁移表之外一律拒绝", () => {
		expect(canTransition("idle", "running")).toBe(true);
		expect(canTransition("running", "idle")).toBe(true);
		expect(canTransition("idle", "retiring")).toBe(true);
		expect(canTransition("running", "retiring")).toBe(true);
		expect(canTransition("retiring", "retired")).toBe(true);
		expect(canTransition("retiring", "idle")).toBe(false);
		expect(canTransition("retired", "idle")).toBe(false);
		expect(canTransition("idle", "retired")).toBe(false);
		expect(() => transition("retired", "running")).toThrow(ConversationPhaseError);
		expect(transition("idle", "idle")).toBe("idle");
	});

	it("退役即 fail-closed：retiring 之后不再接回合", () => {
		expect(acceptsTurns("idle")).toBe(true);
		expect(acceptsTurns("running")).toBe(true);
		expect(acceptsTurns("retiring")).toBe(false);
		expect(acceptsTurns("retired")).toBe(false);
	});
});

describe("kernel/conversation · 聚合不变量", () => {
	it("开/收回合，且触碰 lastActiveAt", () => {
		const conv = makeConv();
		expect(conv.acceptsTurns).toBe(true);
		conv.beginTurn(at(2_000));
		expect(conv.phase).toBe("running");
		expect(conv.meta.lastActiveAt).toBe(2_000);
		conv.endTurn(at(3_000));
		expect(conv.phase).toBe("idle");
		expect(conv.meta.lastActiveAt).toBe(3_000);
	});

	it("退役后开回合直接抛，且排队被清空", () => {
		const conv = makeConv();
		conv.queues.enqueue("steer", "排队中的消息");
		conv.retire();
		expect(conv.phase).toBe("retiring");
		expect(conv.queues.total()).toBe(0);
		expect(conv.acceptsTurns).toBe(false);
		expect(() => conv.beginTurn(5_000)).toThrow(/cannot start a turn in phase retiring/);
		conv.finishRetire();
		expect(conv.phase).toBe("retired");
		// 重复退役幂等：重入的清理路径不该因为“已经退役”而抛。
		conv.finishRetire();
		expect(conv.phase).toBe("retired");
	});

	it("标题归一：空白回到默认标题", () => {
		expect(normalizeTitle("  修 bug  ")).toBe("修 bug");
		expect(normalizeTitle("")).toBe(DEFAULT_CONV_TITLE);
		expect(normalizeTitle(undefined)).toBe(DEFAULT_CONV_TITLE);
		const conv = makeConv("c9", { title: "  " });
		expect(conv.meta.title).toBe(DEFAULT_CONV_TITLE);
		conv.rename("  新标题 ");
		expect(conv.meta.title).toBe("新标题");
		conv.rename("");
		expect(conv.meta.title).toBe(DEFAULT_CONV_TITLE);
	});
});

describe("kernel/conversation · 两条排队", () => {
	it("按 kind 分开持有，出队保序", () => {
		const q = new ConversationQueues();
		q.enqueue("steer", "s1");
		q.enqueue("steer", "s2");
		q.enqueue("followUp", "f1");
		expect(q.texts("steer")).toEqual(["s1", "s2"]);
		expect(q.texts("followUp")).toEqual(["f1"]);
		expect(q.total()).toBe(3);
		expect(q.take("steer").map((e) => e.text)).toEqual(["s1", "s2"]);
		expect(q.texts("steer")).toEqual([]);
		expect(q.texts("followUp")).toEqual(["f1"]);
	});

	it("按 id / 文本 / 下标删除，删不到时不动队列", () => {
		const q = new ConversationQueues();
		const first = q.enqueue("steer", "a");
		q.enqueue("steer", "b");
		q.enqueue("steer", "c");
		expect(q.remove("steer", { id: first.id })?.text).toBe("a");
		expect(q.texts("steer")).toEqual(["b", "c"]);
		// 下标与文本不一致时按文本删（queue-utils.removeQueuedEntry 的历史语义，单源不改）。
		expect(q.remove("steer", { index: 0, text: "c" })?.text).toBe("c");
		expect(q.texts("steer")).toEqual(["b"]);
		expect(q.remove("steer", { index: 5 })).toBeUndefined();
		expect(q.remove("steer", { text: "b" })?.text).toBe("b");
		expect(q.size("steer")).toBe(0);
	});

	it("clear 支持单条与全部", () => {
		const q = new ConversationQueues();
		q.enqueue("steer", "a");
		q.enqueue("followUp", "b");
		q.clear("steer");
		expect(q.total()).toBe(1);
		q.clear();
		expect(q.total()).toBe(0);
	});
});

describe("kernel/conversation · 注册表", () => {
	it("同一 id 不能注册两次", () => {
		const reg = new ConversationRegistry();
		reg.add(makeConv("c1"));
		expect(() => reg.add(makeConv("c1"))).toThrow(/already registered/);
		expect(reg.size()).toBe(1);
	});

	it("会话文件索引唯一：重绑会摘掉旧映射", () => {
		const reg = new ConversationRegistry();
		reg.add(makeConv("c1", { sessionFile: "/s/a.jsonl" }));
		reg.add(makeConv("c2"));
		expect(reg.bySessionFile("/s/a.jsonl")?.meta.id).toBe("c1");
		reg.bindSessionFile("c2", "/s/a.jsonl");
		expect(reg.bySessionFile("/s/a.jsonl")?.meta.id).toBe("c2");
		expect(reg.get("c1")?.meta.sessionFile).toBeUndefined();
		reg.unbindSessionFile("c2");
		expect(reg.bySessionFile("/s/a.jsonl")).toBeUndefined();
	});

	it("活动对话随移除被清空，不能激活不存在的对话", () => {
		const reg = new ConversationRegistry();
		reg.add(makeConv("c1"));
		reg.activate("c1");
		expect(reg.activeId()).toBe("c1");
		expect(reg.activeConv()?.meta.id).toBe("c1");
		reg.remove("c1");
		expect(reg.activeId()).toBe("");
		expect(reg.activeConv()).toBeUndefined();
		expect(() => reg.activate("c1")).toThrow(/not registered/);
	});

	it("seq 单调递增，list 返回快照", () => {
		const reg = new ConversationRegistry();
		expect(reg.nextSeq()).toBe(1);
		expect(reg.nextSeq()).toBe(2);
		reg.add(makeConv("c1"));
		const list = reg.list();
		reg.add(makeConv("c2"));
		expect(list).toHaveLength(1);
		expect(reg.list()).toHaveLength(2);
	});
});
