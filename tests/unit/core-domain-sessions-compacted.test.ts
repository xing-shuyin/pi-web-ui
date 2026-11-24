import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isShim } from "../helpers/guard-roots.js";
import { createCompactedMessagesHandlers } from "../../packages/keel/src/domains/sessions/index.js";
import type {
	SessionEntryLike,
	SessionManagerLike,
} from "../../packages/keel/src/domains/sessions/compacted-history.js";
import { Conversation, ConversationRegistry } from "../../packages/keel/src/kernel/conversation/index.js";
import type { ServerMessage } from "../../server/protocol.js";
import type { AgentMessage } from "../../server/serialize.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function fakeTransport() {
	const sent: ServerMessage[] = [];
	return { sent, emit: (msg: ServerMessage) => void sent.push(msg) };
}

function conversation(id = "c1"): Conversation {
	return new Conversation({ id, clientId: "cl-1", cwd: "/w", kind: "user", createdAt: 1 });
}

/** 一段「两次压缩」的条目树：`cmp-1` 折掉 m1，`cmp-2` 折掉 m3（保留 m4）。 */
function branch(): SessionEntryLike[] {
	const user = (id: string, content: string, timestamp: number): SessionEntryLike => ({
		id,
		parentId: null,
		type: "message",
		message: { role: "user", content, timestamp } as unknown as AgentMessage,
	});
	return [
		user("m1", "历史问题", 1700000000000),
		{
			id: "a1",
			parentId: "m1",
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "历史回答" }],
				timestamp: 1700000000500,
			} as unknown as AgentMessage,
		},
		{
			id: "cmp-1",
			parentId: "a1",
			type: "compaction",
			firstKeptEntryId: "a1",
			timestamp: new Date(1700000001000).toISOString(),
			summary: "第一次压缩",
			tokensBefore: 1000,
		},
	];
}

function fakeManager(entries: SessionEntryLike[]): SessionManagerLike {
	return {
		getEntries: () => entries,
		getBranch: () => entries,
		buildContextEntries: () => entries,
		getEntry: (id) => entries.find((entry) => entry.id === id),
	};
}

describe("domains/sessions · get_compacted_messages（帧生产者）", () => {
	it("命中压缩条目 → 一帧 compacted_messages_result（带 conversationId 与折叠消息）", () => {
		const entries = branch();
		const { sent, emit } = fakeTransport();
		const registry = new ConversationRegistry<Conversation>();
		const conv = conversation();
		registry.add(conv);
		registry.activate(conv.id);
		const handlers = createCompactedMessagesHandlers({
			registry,
			managerOf: (id) => (id === conv.id ? fakeManager(entries) : undefined),
			emit,
		});

		// 前端发来的就是压缩条目 id（与 `tests/unit/compacted-history.test.ts` 同口径）。
		handlers.getCompactedMessages("cmp-1");

		expect(sent).toHaveLength(1);
		const frame = sent[0] as Extract<ServerMessage, { type: "compacted_messages_result" }>;
		expect(frame.type).toBe("compacted_messages_result");
		expect(frame.conversationId).toBe(conv.id);
		expect(frame.error).toBeUndefined();
		expect(frame.messages.map((message) => message.role)).toEqual(["user"]);
	});

	it("对话关了 / 会话没开 → 也出帧（前端靠这一帧从 loading 转 error）", () => {
		const { sent, emit } = fakeTransport();
		const registry = new ConversationRegistry<Conversation>();
		const handlers = createCompactedMessagesHandlers({
			registry,
			managerOf: () => undefined,
			emit,
		});

		handlers.getCompactedMessages("cmp-1", "c-gone");

		expect(sent).toEqual([
			{
				type: "compacted_messages_result",
				compactionMessageId: "cmp-1",
				conversationId: "c-gone",
				messages: [],
				error: "compactedHistoryNotFound",
			},
		]);
	});
});

describe("domains/sessions · 压缩历史是单源（搬家不留第二套）", () => {
	it("老的 server/compacted-history.ts 只剩 re-export shim", () => {
		const source = readFileSync(join(root, "server", "compacted-history.ts"), "utf8");
		expect(isShim(source)).toBe(true);
		expect(source).toContain('"../packages/keel/src/domains/sessions/compacted-history.js"');
	});

	it("keel 那份是真实现（shim 不成立），且老位置引到的就是它", async () => {
		const keelPath = join(root, "packages", "keel", "src", "domains", "sessions", "compacted-history.ts");
		expect(isShim(readFileSync(keelPath, "utf8"))).toBe(false);
		const legacy = await import("../../server/compacted-history.js");
		const keel = await import("../../packages/keel/src/domains/sessions/compacted-history.js");
		// 同一个函数对象 = 老位置真的在转引，不是各有一份实现。
		expect(legacy.getCompactedMessages).toBe(keel.getCompactedMessages);
		expect(legacy.walkAncestors).toBe(keel.walkAncestors);
	});
});
