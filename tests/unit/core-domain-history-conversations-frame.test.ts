import { describe, expect, it } from "vitest";
import type { TransportPort } from "../../packages/keel/src/contracts/ports.js";
import {
	buildConversationsFrame,
	pushConversations,
	type ConversationFrameFact,
	type ConversationsFrameInput,
} from "../../packages/keel/src/domains/history/frame.js";
import type { ServerMessage } from "../../server/protocol.js";

const CWD = "/p/demo";

class FakeTransport implements TransportPort {
	readonly sent: ServerMessage[] = [];
	closed = false;

	send(msg: ServerMessage): void {
		this.sent.push(msg);
	}

	isClosed(): boolean {
		return this.closed;
	}
}

function fact(over: Partial<ConversationFrameFact> & { id: string }): ConversationFrameFact {
	return {
		title: `对话 ${over.id}`,
		cwd: CWD,
		kind: "user",
		messageCount: 2,
		isStreaming: false,
		hasHistoryRow: true,
		...over,
	};
}

function summaries(input: ConversationsFrameInput) {
	const frame = buildConversationsFrame(input);
	return frame.type === "conversations" ? frame.conversations : [];
}

describe("buildConversationsFrame · 帧形状", () => {
	it("出 type: conversations，activeId 原样回显，顺序与入参一致", () => {
		const frame = buildConversationsFrame({
			activeId: "a",
			conversations: [fact({ id: "a" }), fact({ id: "b" })],
			stateOf: () => ({ pinned: false, listed: true }),
		});
		expect(frame.type).toBe("conversations");
		expect(frame).toMatchObject({ type: "conversations", activeId: "a" });
		expect(
			summaries({
				activeId: "a",
				conversations: [fact({ id: "a" }), fact({ id: "b" })],
				stateOf: () => ({ pinned: false, listed: true }),
			}).map((s) => s.id),
		).toEqual(["a", "b"]);
	});

	it("一个都不该显示时也出合法帧：conversations 为 []", () => {
		const frame = buildConversationsFrame({ activeId: "", conversations: [] });
		expect(frame).toMatchObject({ type: "conversations", conversations: [], activeId: "" });
	});

	it("elsewhere 不给就不出键，给了原样透传", () => {
		expect("elsewhere" in buildConversationsFrame({ activeId: "", conversations: [], elsewhere: [] })).toBe(false);
		const frame = buildConversationsFrame({
			activeId: "",
			conversations: [],
			elsewhere: [{ title: "别的设备", cwd: CWD, isStreaming: true }],
		});
		expect(frame.type === "conversations" && frame.elsewhere).toEqual([
			{ title: "别的设备", cwd: CWD, isStreaming: true },
		]);
	});
});

describe("buildConversationsFrame · 钉住 / listed 语义", () => {
	it("钉住：进帧、带 pinned、行归属 open（已落盘也一样）", () => {
		const [summary] = summaries({
			activeId: "",
			conversations: [fact({ id: "a", hasHistoryRow: true })],
			stateOf: () => ({ pinned: true, listed: true }),
		});

		expect(summary).toMatchObject({ id: "a", pinned: true, rowKind: "open", messageCount: 2 });
		expect(summary !== undefined && "sessionFile" in summary).toBe(false);
	});

	it("只 listed 未钉住：仍在帧里，但不写 pinned；已落盘的行归属交给历史行", () => {
		const [summary] = summaries({
			activeId: "",
			conversations: [fact({ id: "a", hasHistoryRow: true })],
			stateOf: () => ({ pinned: false, listed: true }),
		});

		expect(summary).toMatchObject({ id: "a", rowKind: "history" });
		expect(summary !== undefined && "pinned" in summary).toBe(false);
	});

	it("已取消钉住（内存态 pinned=false）：钉子真的消失，但不会因为切走而丢行（listed 还在）", () => {
		const before = summaries({
			activeId: "",
			conversations: [fact({ id: "a" })],
			stateOf: () => ({ pinned: true, listed: true }),
		});
		const after = summaries({
			activeId: "",
			conversations: [fact({ id: "a" })],
			stateOf: () => ({ pinned: false, listed: true }),
		});

		expect(before[0]?.pinned).toBe(true);
		expect(after.map((s) => s.id)).toEqual(["a"]);
		expect(after[0]?.pinned).toBeUndefined();
	});

	it("没记过状态：既不钉住也不 listed —— 不编造 pinned 键", () => {
		const [summary] = summaries({ activeId: "a", conversations: [fact({ id: "a" })] });
		expect(summary !== undefined && "pinned" in summary).toBe(false);
	});
});

describe("buildConversationsFrame · 入选判定（老 shownInRunningList）", () => {
	it("未 listed、非活动、没在跑：不进帧", () => {
		expect(summaries({ activeId: "other", conversations: [fact({ id: "a" })] })).toEqual([]);
	});

	it("正在生成的对话即使没 listed 也进帧（行归属 open）", () => {
		const [summary] = summaries({
			activeId: "other",
			conversations: [fact({ id: "a", isStreaming: true })],
		});
		expect(summary).toMatchObject({ id: "a", isStreaming: true, rowKind: "open" });
	});

	it("等你回话的对话（hasQuestion / completionPending）也进帧", () => {
		expect(
			summaries({ activeId: "other", conversations: [fact({ id: "a", hasQuestion: true })] }).map((s) => s.id),
		).toEqual(["a"]);
		expect(
			summaries({ activeId: "other", conversations: [fact({ id: "b", completionPending: true })] }).map((s) => s.id),
		).toEqual(["b"]);
	});

	it("活动对话：改过标题就进帧；仍是默认标题且没内容就不进", () => {
		expect(summaries({ activeId: "a", conversations: [fact({ id: "a" })] }).map((s) => s.id)).toEqual(["a"]);
		expect(summaries({ activeId: "a", conversations: [fact({ id: "a", title: "新对话", messageCount: 0 })] })).toEqual(
			[],
		);
		expect(
			summaries({
				activeId: "a",
				conversations: [fact({ id: "a", title: "新对话", messageCount: 1, hasHistoryRow: true })],
			}).map((s) => s.id),
		).toEqual(["a"]);
	});

	it("子代理行挂父行：子代理进帧时父行也出一行（forceOpen 强制 open）", () => {
		const rows = summaries({
			activeId: "",
			conversations: [
				fact({ id: "parent", hasHistoryRow: true, messageCount: 4 }),
				fact({ id: "kid", kind: "subagent", parentId: "parent", hasHistoryRow: false, messageCount: 1 }),
			],
			stateOf: (id) => (id === "kid" ? { pinned: false, listed: true } : undefined),
		});

		expect(rows.map((s) => s.id)).toEqual(["parent", "kid"]);
		expect(rows[0]).toMatchObject({ id: "parent", rowKind: "open" });
		expect(rows[1]).toMatchObject({ id: "kid", isSubagent: true, parentId: "parent", rowKind: "open" });
	});

	it("字段逐项映射：messageCount / isStreaming / sessionId / sessionFile / thinkingLevel / modified", () => {
		const [summary] = summaries({
			activeId: "",
			conversations: [
				fact({
					id: "a",
					messageCount: 7,
					isStreaming: true,
					sessionId: "sess-1",
					sessionFile: "/sessions/a.jsonl",
					thinkingLevel: "high",
					updatedAt: 1_700_000_000_123,
					title: "会话标题",
				}),
			],
			stateOf: () => ({ pinned: true, listed: true }),
		});

		expect(summary).toMatchObject({
			id: "a",
			title: "会话标题",
			cwd: CWD,
			messageCount: 7,
			isStreaming: true,
			isSubagent: false,
			sessionId: "sess-1",
			sessionFile: "/sessions/a.jsonl",
			thinkingLevel: "high",
			modified: 1_700_000_000_123,
			pinned: true,
			rowKind: "open",
		});
	});

	it("不改动入参（同一份入参连出两帧结果相同）", () => {
		const input: ConversationsFrameInput = {
			activeId: "a",
			conversations: [fact({ id: "a" }), fact({ id: "b", kind: "subagent", parentId: "a" })],
			stateOf: () => ({ pinned: true, listed: true }),
		};
		const snapshot = structuredClone(input.conversations);

		expect(buildConversationsFrame(input)).toEqual(buildConversationsFrame(input));
		expect(input.conversations).toEqual(snapshot);
	});
});

describe("pushConversations · 通道口径", () => {
	it("通道通着：真的发一帧，内容与 buildConversationsFrame 一致", () => {
		const transport = new FakeTransport();
		const input = {
			activeId: "a",
			conversations: [fact({ id: "a" })],
			stateOf: () => ({ pinned: true, listed: true }),
		};

		pushConversations({ ...input, transport });

		expect(transport.sent).toEqual([buildConversationsFrame(input)]);
	});

	it("通道已关：一帧都不发，但照样把该发的帧交回去", () => {
		const transport = new FakeTransport();
		transport.closed = true;

		const frame = pushConversations({ activeId: "a", conversations: [fact({ id: "a" })], transport });

		expect(transport.sent).toEqual([]);
		expect(frame.type).toBe("conversations");
	});
});
