/**
 * 单 sink 出帧闸（issue #965）。
 *
 * 守的是这一条不变式：**一个 sink 只会收到它还不持有的内容**。首屏 2.28MB 空转里
 * 1.42MB 是同一份 state 连发 4 帧全量——原因不是帧胖，而是没有「这帧不用发」的闸。
 */
import { describe, expect, it } from "vitest";
import type { ServerMessage } from "../../server/protocol.js";
import { SnapshotChannel, snapshotContentKey, type SnapshotProduct } from "../../server/snapshot-channel.js";

function light(rev: number, extra: Record<string, unknown> = {}) {
	return {
		rev,
		version: rev * 7,
		clientId: "c",
		cwd: "/w",
		sessionId: "s",
		conversationId: "conv-1",
		tools: ["read"],
		...extra,
	} as unknown as SnapshotProduct["light"];
}

function product(rev: number, ids: string[], extra: Record<string, unknown> = {}): SnapshotProduct {
	const l = light(rev, extra);
	return {
		conversationId: "conv-1",
		rev,
		contentKey: snapshotContentKey(l),
		light: l,
		messages: ids.map((id) => ({ id, role: "user", content: [] }) as never),
		ids,
	};
}

function sink(): { deliver: (msg: ServerMessage) => void; frames: ServerMessage[] } {
	const frames: ServerMessage[] = [];
	return { frames, deliver: (msg) => void frames.push(msg) };
}

describe("snapshotContentKey", () => {
	it("剔掉每帧自增的 rev/version，只按内容判定", () => {
		expect(snapshotContentKey(light(1))).toBe(snapshotContentKey(light(99)));
	});

	it("内容字段变了就不同", () => {
		expect(snapshotContentKey(light(1))).not.toBe(snapshotContentKey(light(1, { isStreaming: true })));
	});
});

describe("SnapshotChannel", () => {
	it("新 sink 的第一帧一定是全量", () => {
		const ch = new SnapshotChannel();
		const out = sink();
		expect(ch.push(product(1, ["a"]), out.deliver)).toBe("full");
		expect(out.frames).toHaveLength(1);
		expect(out.frames[0]?.type).toBe("snapshot");
	});

	it("内容没变就不发（同一份内容连发 4 帧的来源）", () => {
		const ch = new SnapshotChannel();
		const out = sink();
		ch.push(product(1, ["a"]), out.deliver);
		expect(ch.push(product(2, ["a"]), out.deliver)).toBe("skipped");
		expect(ch.push(product(3, ["a"]), out.deliver)).toBe("skipped");
		expect(out.frames).toHaveLength(1);
	});

	it("纯追加走增量，baseRev 是本 sink 上一帧的 rev", () => {
		const ch = new SnapshotChannel();
		const out = sink();
		ch.push(product(1, ["a"]), out.deliver);
		expect(ch.push(product(5, ["a", "b"]), out.deliver)).toBe("delta");
		const delta = out.frames[1] as Extract<ServerMessage, { type: "snapshot_delta" }>;
		expect(delta.baseRev).toBe(1);
		expect(delta.rev).toBe(5);
		expect(delta.appended.map((m) => m.id)).toEqual(["b"]);
	});

	it("非追加变化走全量", () => {
		const ch = new SnapshotChannel();
		const out = sink();
		ch.push(product(1, ["a", "b"]), out.deliver);
		expect(ch.push(product(2, ["a", "c"]), out.deliver)).toBe("full");
	});

	it("换会话走全量", () => {
		const ch = new SnapshotChannel();
		const out = sink();
		ch.push(product(1, ["a"]), out.deliver);
		const other = { ...product(2, ["a"]), conversationId: "conv-2" };
		expect(ch.push(other, out.deliver)).toBe("full");
	});

	it("force 时内容没变也发全量（客户端明说自己没有状态）", () => {
		const ch = new SnapshotChannel();
		const out = sink();
		ch.push(product(1, ["a"]), out.deliver);
		expect(ch.push(product(2, ["a"]), out.deliver, { force: true })).toBe("full");
	});

	it("since 命中本 sink 基线且纯追加 → 增量（重连只补差额）", () => {
		const ch = new SnapshotChannel();
		const out = sink();
		ch.push(product(1, ["a"]), out.deliver);
		ch.push(product(2, ["a", "b"]), out.deliver);
		expect(ch.push(product(3, ["a", "b", "c"]), out.deliver, { since: 2 })).toBe("delta");
	});

	it("since 对不上（客户端落后）→ 全量，永不乱发增量", () => {
		const ch = new SnapshotChannel();
		const out = sink();
		ch.push(product(1, ["a"]), out.deliver);
		ch.push(product(2, ["a", "b"]), out.deliver);
		expect(ch.push(product(3, ["a", "b", "c"]), out.deliver, { since: 1 })).toBe("full");
	});

	it("交付被丢弃（背压）时不提交基线，下一帧补全量", () => {
		const ch = new SnapshotChannel();
		ch.push(product(1, ["a"]), (msg) => void msg);
		const dropped = ch.push(product(2, ["a", "b"]), () => false);
		expect(dropped).toBe("dropped");
		// 基线还是 rev=1：所以下一次是「a → a,b,c」，客户端不会漏掉 b
		const out = sink();
		expect(ch.push(product(3, ["a", "b", "c"]), out.deliver)).toBe("delta");
		const delta = out.frames[0] as Extract<ServerMessage, { type: "snapshot_delta" }>;
		expect(delta.baseRev).toBe(1);
		expect(delta.appended.map((m) => m.id)).toEqual(["b", "c"]);
	});

	it("多 sink 各自独立：落后的那个拿全量，跟上的拿增量", () => {
		const ch1 = new SnapshotChannel();
		const ch2 = new SnapshotChannel();
		const a = sink();
		const b = sink();
		ch1.push(product(1, ["a"]), a.deliver);
		ch2.push(product(1, ["a"]), b.deliver);
		ch1.push(product(2, ["a", "b"]), a.deliver);
		expect(ch1.push(product(3, ["a", "b", "c"]), a.deliver)).toBe("delta");
		// 第二个 sink 中间丢了一帧：(a,b,c) 相对它的基线 (a) 仍是纯追加 → 增量补齐
		expect(ch2.push(product(3, ["a", "b", "c"]), b.deliver)).toBe("delta");
		expect((b.frames[1] as Extract<ServerMessage, { type: "snapshot_delta" }>).appended.map((m) => m.id)).toEqual([
			"b",
			"c",
		]);
	});

	it("reset 后下一帧是全量", () => {
		const ch = new SnapshotChannel();
		const out = sink();
		ch.push(product(1, ["a"]), out.deliver);
		ch.reset();
		expect(ch.current).toBeNull();
		expect(ch.push(product(2, ["a"]), out.deliver)).toBe("full");
	});
});
