import { describe, expect, it } from "vitest";
import { fakeClientSession } from "../helpers/fake-session.js";

const user = (text: string, ts: number) => ({ role: "user", content: [{ type: "text", text }], timestamp: ts });
const assistant = (text: string, ts: number, calls: string[] = []) => ({
	role: "assistant",
	content: [{ type: "text", text }, ...calls.map((id) => ({ type: "toolCall", id, name: "bash", arguments: {} }))],
	timestamp: ts,
});
const toolResult = (id: string, ts: number) => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "bash",
	content: [{ type: "text", text: "ok" }],
	isError: false,
	timestamp: ts,
});

function fixture() {
	const messages = [
		{ role: "compactionSummary", summary: "earlier work", tokensBefore: 100, timestamp: 10 },
		user("first", 100),
		user("aside one", 200),
		user("aside two", 200),
		assistant("working", 300, ["c1"]),
		toolResult("c1", 301),
		{ role: "system", content: "", timestamp: 302 },
		assistant("done", 400),
		user("next", 500),
		user("next aside", 500),
		assistant("final", 600),
	];
	const branch = [
		{ type: "compaction", summary: "older work", tokensBefore: 50, timestamp: "1970-01-01T00:00:00.005Z" },
		{ type: "compaction", summary: "earlier work", tokensBefore: 100, timestamp: "1970-01-01T00:00:00.010Z" },
		...messages.filter((m) => m.role !== "compactionSummary").map((m) => ({ type: "message", message: m })),
	];
	const manager = {
		getBranch: () => branch,
		buildSessionContext: () => ({ messages }),
	};
	return { messages, manager };
}

function freshConv(messages: unknown[], manager: unknown): any {
	return {
		msgIds: new Map(),
		nextMsgId: 1,
		userSeqByTs: new Map(),
		uiMessageCache: new Map(),
		session: { agent: { state: { messages } }, sessionManager: manager },
	};
}

describe("previewWithSnapshotIds", () => {
	it("预览尾部消息的 id 与首个快照对应消息完全一致", () => {
		const cs = fakeClientSession() as any;
		const { messages, manager } = fixture();
		for (const n of [1, 3, 5, 16]) {
			const preview = cs.extractTranscriptPreview(manager, n);
			expect(preview.idSeed).toBeDefined();
			const conv = freshConv(messages, manager);
			cs.seedConversationIds(conv, preview.idSeed);
			const snapshot = cs.messagesOf(conv) as { id: string }[];
			const previewIds = preview.previewMessages.map((m: { id: string }) => m.id);
			expect(snapshot.slice(-previewIds.length).map((m) => m.id)).toEqual(previewIds);
		}
	});

	it("种子不改变任何消息 id：与未种子的新对话首个快照逐条相同", () => {
		const cs = fakeClientSession() as any;
		const { messages, manager } = fixture();
		const baseline = (cs.messagesOf(freshConv(messages, manager)) as { id: string }[]).map((m) => m.id);
		expect(baseline).toContain("u-200-1");
		expect(baseline).toContain("u-200-2");
		expect(baseline).toContain("u-500-2");
		for (const n of [1, 2, 4, 7, 16]) {
			const preview = cs.extractTranscriptPreview(manager, n);
			const conv = freshConv(messages, manager);
			cs.seedConversationIds(conv, preview.idSeed);
			expect((cs.messagesOf(conv) as { id: string }[]).map((m) => m.id)).toEqual(baseline);
		}
	});

	it("预览对象直接复用为快照里的缓存对象（不重复序列化）", () => {
		const cs = fakeClientSession() as any;
		const { messages, manager } = fixture();
		const preview = cs.extractTranscriptPreview(manager, 3);
		const conv = freshConv(messages, manager);
		cs.seedConversationIds(conv, preview.idSeed);
		const snapshot = cs.messagesOf(conv);
		expect(snapshot.slice(-3)).toEqual(preview.previewMessages);
		expect(snapshot[snapshot.length - 1]).toBe(preview.previewMessages[preview.previewMessages.length - 1]);
	});

	it("不支持 buildSessionContext 的管理器：回退旧预览，不下发种子", () => {
		const cs = fakeClientSession() as any;
		const { manager } = fixture();
		const preview = cs.extractTranscriptPreview({ getBranch: manager.getBranch }, 2);
		expect(preview.idSeed).toBeUndefined();
		expect(preview.previewMessages).toHaveLength(2);
	});

	it("对话已有 id 状态时不覆盖", () => {
		const cs = fakeClientSession() as any;
		const { messages, manager } = fixture();
		const preview = cs.extractTranscriptPreview(manager, 3);
		const conv = freshConv(messages, manager);
		conv.msgIds.set("x", 7);
		conv.nextMsgId = 8;
		cs.seedConversationIds(conv, preview.idSeed);
		expect(conv.nextMsgId).toBe(8);
		expect(conv.uiMessageCache.size).toBe(0);
	});
});
