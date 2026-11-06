import { describe, expect, it } from "vitest";
import {
	getCompactedMessages,
	serializeCompactedEntries,
	sliceCompactedEntries,
	walkAncestors,
	type SessionEntryLike,
	type SessionManagerLike,
} from "../../server/compacted-history.js";
import type { AgentMessage } from "../../server/serialize.js";

describe("compacted-history", () => {
	describe("walkAncestors", () => {
		it("顺着 parentId 从 target 准确回溯到根节点并正序返回", () => {
			const entries: SessionEntryLike[] = [
				{ id: "e1", parentId: null, type: "session" },
				{ id: "e2", parentId: "e1", type: "message" },
				{ id: "e3", parentId: "e2", type: "message" },
				{ id: "e4", parentId: "e3", type: "compaction" },
			];

			const res = walkAncestors("e4", entries);
			expect(res.map((e) => e.id)).toEqual(["e1", "e2", "e3", "e4"]);
		});

		it("遇到循环引用或断链时安全截断，不陷入死循环", () => {
			const loopEntries: SessionEntryLike[] = [
				{ id: "e1", parentId: "e2", type: "message" },
				{ id: "e2", parentId: "e1", type: "message" },
			];
			const res = walkAncestors("e1", loopEntries);
			expect(res.length).toBe(2);
		});
	});

	describe("sliceCompactedEntries", () => {
		it("首次压缩：准确提取从起点到 firstKeptEntryId 之前的折叠条目", () => {
			const branch: SessionEntryLike[] = [
				{ id: "s0", parentId: null, type: "session" },
				{ id: "m1", parentId: "s0", type: "message" },
				{ id: "m2", parentId: "m1", type: "message" },
				{ id: "m3", parentId: "m2", type: "message" },
				{ id: "m4", parentId: "m3", type: "message" },
				{
					id: "c1",
					parentId: "m4",
					type: "compaction",
					firstKeptEntryId: "m3",
				},
			];

			const folded = sliceCompactedEntries(branch[5], branch);
			expect(folded.map((e) => e.id)).toEqual(["s0", "m1", "m2"]);
		});

		it("连续多次压缩：准确从前序压缩保留点开始切分，两次压缩内容不重叠", () => {
			const branch: SessionEntryLike[] = [
				{ id: "s0", parentId: null, type: "session" },
				{ id: "m1", parentId: "s0", type: "message" },
				{ id: "m2", parentId: "m1", type: "message" },
				{
					id: "c1",
					parentId: "m2",
					type: "compaction",
					firstKeptEntryId: "m2",
				},
				{ id: "m3", parentId: "c1", type: "message" },
				{ id: "m4", parentId: "m3", type: "message" },
				{ id: "m5", parentId: "m4", type: "message" },
				{
					id: "c2",
					parentId: "m5",
					type: "compaction",
					firstKeptEntryId: "m5",
				},
			];

			const folded1 = sliceCompactedEntries(branch[3], branch);
			expect(folded1.map((e) => e.id)).toEqual(["s0", "m1"]);

			const folded2 = sliceCompactedEntries(branch[7], branch);
			expect(folded2.map((e) => e.id)).toEqual(["m2", "c1", "m3", "m4"]);
		});

		it("retain-none 模式：firstKeptEntryId 等于自身 id 时折叠到该节点前全部内容", () => {
			const branch: SessionEntryLike[] = [
				{ id: "m1", parentId: null, type: "message" },
				{ id: "m2", parentId: "m1", type: "message" },
				{
					id: "c1",
					parentId: "m2",
					type: "compaction",
					firstKeptEntryId: "c1",
				},
			];

			const folded = sliceCompactedEntries(branch[2], branch);
			expect(folded.map((e) => e.id)).toEqual(["m1", "m2"]);
		});
	});

	describe("serializeCompactedEntries", () => {
		it("过滤内部 system 消息并正确序列化 user / assistant 消息", () => {
			const entries: SessionEntryLike[] = [
				{
					id: "e1",
					parentId: null,
					type: "message",
					message: {
						role: "system",
						content: "internal prompt sections",
					} as unknown as AgentMessage,
				},
				{
					id: "e2",
					parentId: "e1",
					type: "message",
					message: {
						role: "user",
						content: "用户提问 1",
						timestamp: 1700000000000,
					} as unknown as AgentMessage,
				},
				{
					id: "e3",
					parentId: "e2",
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "模型回答 1" }],
						timestamp: 1700000001000,
					} as unknown as AgentMessage,
				},
			];

			const msgs = serializeCompactedEntries(entries);
			expect(msgs.length).toBe(2);
			expect(msgs[0].role).toBe("user");
			expect(msgs[0].content).toEqual([{ type: "text", text: "用户提问 1" }]);
			expect(msgs[1].role).toBe("assistant");
			expect(msgs[1].content).toEqual([{ type: "text", text: "模型回答 1", truncated: false }]);

			const msgsWithSeq = serializeCompactedEntries(entries, () => 42);
			expect(msgsWithSeq[0].id).toContain("-42");
			expect(msgsWithSeq[1].id).toContain("-42");
		});
	});

	describe("getCompactedMessages 综合接口", () => {
		it("根据前端 compactionMessageId 成功定位并返回历史 UiMessage[]", () => {
			const branch: SessionEntryLike[] = [
				{
					id: "m1",
					parentId: null,
					type: "message",
					message: {
						role: "user",
						content: "历史问题",
						timestamp: 1700000000000,
					} as unknown as AgentMessage,
				},
				{
					id: "m2",
					parentId: "m1",
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "历史回答" }],
						timestamp: 1700000001000,
					} as unknown as AgentMessage,
				},
				{
					id: "m3",
					parentId: "m2",
					type: "message",
					message: {
						role: "user",
						content: "保留的近期问题",
						timestamp: 1700000002000,
					} as unknown as AgentMessage,
				},
				{
					id: "cmp-node",
					parentId: "m3",
					type: "compaction",
					firstKeptEntryId: "m3",
					timestamp: new Date(1700000003000).toISOString(),
					summary: "压缩摘要",
					tokensBefore: 45000,
				},
			];

			const mockSm: SessionManagerLike = {
				getEntries: () => branch,
				getBranch: () => branch,
				buildContextEntries: () => [branch[3]],
				getEntry: (id) => branch.find((e) => e.id === id),
			};

			const result = getCompactedMessages(mockSm, "cmp-node");
			expect(result.error).toBeUndefined();
			expect(result.messages.length).toBe(2);
			expect(result.messages[0].role).toBe("user");
			expect(result.messages[1].role).toBe("assistant");
		});

		it("查询不存在的 compaction 时返回错误", () => {
			const mockSm: SessionManagerLike = {
				getEntries: () => [],
				buildContextEntries: () => [],
			};

			const result = getCompactedMessages(mockSm, "non-existent-id");
			expect(result.error).toBe("compactedHistoryNotFound");
			expect(result.messages).toEqual([]);
		});
	});
});
