import { describe, expect, it, vi } from "vitest";
import {
	ConversationDelivery,
	MAX_DELIVERY_INTENTS,
	compactionBanner,
	deliveryMode,
	isCompactionRejection,
	queuedCompaction,
	runningCompaction,
	type DeliveryHost,
	type DeliveryIntent,
	type DeliveryMode,
} from "../../server/conversation-delivery.js";

function intent(overrides: Partial<DeliveryIntent> = {}): DeliveryIntent {
	return { tag: overrides.tag ?? "t", kind: overrides.kind ?? "steer", createdAt: 1, ...overrides };
}

function host(
	mode: DeliveryMode,
	deliver?: DeliveryHost["deliver"],
): DeliveryHost & {
	delivered: DeliveryIntent[];
	dropped: { intent: DeliveryIntent; reason: string }[];
} {
	const delivered: DeliveryIntent[] = [];
	const dropped: { intent: DeliveryIntent; reason: string }[] = [];
	return {
		delivered,
		dropped,
		mode: () => mode,
		deliver: deliver ?? (async () => "delivered" as const),
		onDelivered: (i) => delivered.push(i),
		onDropped: (i, reason) => dropped.push({ intent: i, reason }),
		onRetryable: () => {},
	};
}

describe("deliveryMode（issues/929 的唯一判定）", () => {
	const idle = { streaming: false, compacting: false };

	it("空闲 → 开新一轮", () => {
		expect(deliveryMode(idle)).toBe("idle");
	});

	it("跑着一轮 → 投进当前轮", () => {
		expect(deliveryMode({ ...idle, streaming: true })).toBe("live");
	});

	it("这一轮刚要开始（promptInFlight）也算活的：不能再开第二轮", () => {
		expect(deliveryMode({ ...idle, starting: true })).toBe("live");
	});

	it("SDK 压缩中 → 门关（无论是否还看得出来在跑）", () => {
		expect(deliveryMode({ ...idle, compacting: true })).toBe("gated");
	});

	it("已请求压缩但还没开始（比 isCompacting 早的窗口）→ 门关", () => {
		const gate = queuedCompaction({ focus: "", requestedAt: 1 });
		expect(deliveryMode({ ...idle, gate })).toBe("gated");
	});

	it("等回话 / 过户 → 门关", () => {
		expect(deliveryMode({ ...idle, blocked: true })).toBe("gated");
	});

	it("门关优先于「看起来活着」：压缩与 starting 重叠时不许 steer", () => {
		expect(deliveryMode({ streaming: false, starting: true, compacting: true })).toBe("gated");
		expect(deliveryMode({ streaming: true, starting: true, compacting: true })).toBe("gated");
		expect(deliveryMode({ streaming: true, compacting: false, gate: runningCompaction("manual", 5) })).toBe("gated");
	});

	it("对话已移出 → closed，优先于一切", () => {
		expect(deliveryMode({ ...idle, closed: true, gate: runningCompaction("manual", 5) })).toBe("closed");
	});
});

describe("压缩门的纯函数", () => {
	it("queuedCompaction 带上请求体，banner 不显示（与旧 compactionState 等价）", () => {
		const gate = queuedCompaction({ focus: "保持结论", requestedAt: 7 }, 100);
		expect(gate).toMatchObject({ phase: "queued", reason: "manual", startedAt: 100 });
		expect(gate.request).toMatchObject({ focus: "保持结论" });
		expect(compactionBanner(gate)).toBeNull();
	});

	it("runningCompaction 丢弃请求体、banner 可见", () => {
		const gate = runningCompaction("overflow", 42);
		expect(gate).toEqual({ phase: "running", reason: "overflow", startedAt: 42 });
		expect(compactionBanner(gate)).toEqual({ reason: "overflow", startedAt: 42 });
		expect(compactionBanner(null)).toBeNull();
	});

	it("识别 SDK 的压缩拒绝（唯一一处允许按文案判定）", () => {
		expect(
			isCompactionRejection(
				new Error("Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry."),
			),
		).toBe(true);
		expect(isCompactionRejection(new Error("boom"))).toBe(false);
		expect(isCompactionRejection(undefined)).toBe(false);
	});
});

describe("ConversationDelivery（意图队列）", () => {
	it("门关时只入队、不投递；门开后按 FIFO 全部投出并提交", async () => {
		const queue = new ConversationDelivery();
		queue.park(intent({ tag: "a" }));
		queue.park(intent({ tag: "b" }));

		const gated = host("gated");
		await queue.drain(gated);
		expect(gated.delivered).toHaveLength(0);
		expect(queue.size).toBe(2);

		const open = host("idle");
		await queue.drain(open);
		expect(open.delivered.map((i) => i.tag)).toEqual(["a", "b"]);
		expect(queue.size).toBe(0);
	});

	it("同 tag 批量合并（多个子代理完成 → 一条通知），不重复入队", () => {
		const queue = new ConversationDelivery();
		const items: unknown[] = [];
		queue.park(intent({ tag: "subagent-notice", kind: "subagent-notice", merge: true, items: ["sa1"] }));
		queue.park(intent({ tag: "subagent-notice", kind: "subagent-notice", merge: true, items: ["sa2", "sa1"] }));
		expect(queue.size).toBe(1);
		expect(queue.pending[0].items).toEqual(["sa1", "sa2"]);
		expect(items).toHaveLength(0);
	});

	it("非合并意图同 tag 幂等（同一份 steer 只留一条）", () => {
		const queue = new ConversationDelivery();
		expect(queue.park(intent({ tag: "steer-1", text: "改 A" }))).toBe(true);
		expect(queue.park(intent({ tag: "steer-1", text: "改 A" }))).toBe(true);
		expect(queue.size).toBe(1);
	});

	it("队列满了丢新的一条并如实回报（不静默）", () => {
		const queue = new ConversationDelivery();
		for (let i = 0; i < MAX_DELIVERY_INTENTS; i++) expect(queue.park(intent({ tag: `x${i}` }))).toBe(true);
		expect(queue.park(intent({ tag: "overflow" }))).toBe(false);
		expect(queue.size).toBe(MAX_DELIVERY_INTENTS);
	});

	it("投递途中撞上新关上的门 → 意图留在队列里，等下一次门开", async () => {
		const queue = new ConversationDelivery();
		queue.park(intent({ tag: "notice", kind: "subagent-notice" }));
		const racing = host("idle", async () => "gated");
		await queue.drain(racing);
		expect(racing.delivered).toHaveLength(0);
		expect(queue.size).toBe(1);
	});

	it("SDK 的压缩拒绝是「门关」，不是失败：不标记、不丢弃", async () => {
		const queue = new ConversationDelivery();
		queue.park(intent({ tag: "notice", kind: "subagent-notice" }));
		const throwing = host("idle", async () => {
			throw new Error(
				"Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.",
			);
		});
		await queue.drain(throwing);
		expect(throwing.dropped).toHaveLength(0);
		expect(queue.size).toBe(1);
		expect(queue.hasKind("subagent-notice")).toBe(true);
	});

	it("永久失败 → 丢弃并回报，绝不谎报已通知", async () => {
		const queue = new ConversationDelivery();
		queue.park(intent({ tag: "notice", kind: "subagent-notice" }));
		const failing = host("idle", async () => {
			throw new Error("target conversation is gone");
		});
		await queue.drain(failing);
		expect(failing.delivered).toHaveLength(0);
		expect(failing.dropped).toHaveLength(1);
		expect(failing.dropped[0].reason).toBe("failed");
		expect(queue.size).toBe(0);
	});

	it("prepare 返回 false 视为过期：丢弃且不算投递（子代理已重新开工）", async () => {
		const queue = new ConversationDelivery();
		queue.park(intent({ tag: "notice", kind: "subagent-notice", prepare: async () => false }));
		const open = host("idle");
		await queue.drain(open);
		expect(open.delivered).toHaveLength(0);
		expect(open.dropped[0].reason).toBe("superseded");
	});

	it("对话关闭 → 遗留意图全部丢弃并回报", async () => {
		const queue = new ConversationDelivery();
		queue.park(intent({ tag: "a" }));
		queue.park(intent({ tag: "b" }));
		const closed = host("closed");
		await queue.drain(closed);
		expect(closed.dropped.map((d) => d.reason)).toEqual(["closed", "closed"]);
		expect(queue.size).toBe(0);
		expect(queue.park(intent({ tag: "c" }))).toBe(false);
	});

	it("drain 期间新入队的意图在同一轮里被处理（不丢）", async () => {
		const queue = new ConversationDelivery();
		const seen: string[] = [];
		queue.park(intent({ tag: "first" }));
		const open = host("idle", async (current) => {
			seen.push(current.tag);
			if (current.tag === "first") queue.park(intent({ tag: "second" }));
			return "delivered";
		});
		await queue.drain(open);
		expect(seen).toEqual(["first", "second"]);
		expect(queue.size).toBe(0);
	});

	it("重入 drain 直接返回（onDelivered 里再喊一次不会重投）", async () => {
		const queue = new ConversationDelivery();
		queue.park(intent({ tag: "only" }));
		const deliver = vi.fn(async () => "delivered" as const);
		const open: DeliveryHost = {
			...host("idle", deliver),
			onDelivered: () => {
				void queue.drain(open);
			},
		};
		await queue.drain(open);
		expect(deliver).toHaveBeenCalledTimes(1);
	});

	it("removeKind 只撤掉指定类别（父代理自己取走结果时用）", () => {
		const queue = new ConversationDelivery();
		queue.park(intent({ tag: "n1", kind: "subagent-notice" }));
		queue.park(intent({ tag: "s1", kind: "steer" }));
		const removed = queue.removeKind("subagent-notice");
		expect(removed.map((i) => i.tag)).toEqual(["n1"]);
		expect(queue.size).toBe(1);
		expect(queue.hasKind("steer")).toBe(true);
	});
});
