import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	UniversalSessionStore,
	UniversalSession,
	UniversalAgentService,
	type UniversalConversation,
} from "../../server/universal/index.js";
import "../../server/markers/index.js";
import { MessageWindowTap } from "../../server/message-window.js";
import type { ServerMessage, UiMessage } from "../../server/protocol.js";

function makeMessages(count: number): UiMessage[] {
	return Array.from({ length: count }, (_, i) => ({
		id: `msg-${i}`,
		role: i % 2 === 0 ? "user" : "assistant",
		content: [{ type: "text", text: `message ${i}` }],
		timestamp: 1000 + i,
	}));
}

describe("UniversalSession + MessageWindowTap 历史窗口与按需翻页", () => {
	let tempDir: string;
	let cwd: string;
	let dataDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-universal-window-"));
		cwd = join(tempDir, "workspace");
		dataDir = join(tempDir, "data");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(dataDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(tempDir)) {
			try {
				rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
			} catch {}
		}
	});

	it("getMessagesOfConversation 在 UniversalSession 与 UniversalAgentService 上暴露完整消息，未知会话返回 undefined", async () => {
		const store = new UniversalSessionStore(dataDir, "claude");
		const conv: UniversalConversation = {
			id: "conv-long",
			title: "长对话",
			createdAt: 1000,
			updatedAt: 2000,
			messages: makeMessages(20),
		};
		await store.saveConversation(cwd, conv);

		const service = new UniversalAgentService({ cwd, dataDir, engine: "claude" });
		// 未 attach 时也可通过 store 回退读取
		expect(service.getMessagesOfConversation("conv-long")?.map((m) => m.id)).toEqual(conv.messages.map((m) => m.id));
		expect(service.getMessagesOfConversation("nonexistent")).toBeUndefined();
		expect(service.getMessagesOfConversation("")).toBeUndefined();

		const emitted: ServerMessage[] = [];
		const session = (await service.attach("client-1", (msg) => emitted.push(msg))) as UniversalSession;

		expect(session.getMessagesOfConversation("conv-long")?.length).toBe(20);
		expect(session.getMessagesOfConversation("nonexistent")).toBeUndefined();
		expect(session.getMessagesOfConversation("")).toBeUndefined();

		// 切到该会话后，内存中的 conversations 也应能返回完整消息列表
		await session.switchConversation("conv-long");
		const fullFromSession = session.getMessagesOfConversation("conv-long");
		const fullFromService = service.getMessagesOfConversation("conv-long");
		expect(fullFromSession?.length).toBe(20);
		expect(fullFromService?.length).toBe(20);

		await service.disposeAll();
	});

	it("经由 MessageWindowTap 截断初始快照后，可通过 getMessagesOfConversation + rehydrate 向上翻页", async () => {
		const store = new UniversalSessionStore(dataDir, "claude");
		const conv: UniversalConversation = {
			id: "conv-window",
			title: "窗口分页测试",
			createdAt: 1000,
			updatedAt: 2000,
			messages: makeMessages(20),
		};
		await store.saveConversation(cwd, conv);

		const delivered: ServerMessage[] = [];
		const tap = new MessageWindowTap(
			(msg) => {
				delivered.push(msg);
			},
			{ windowSize: 5, charBudget: 0, pageSize: 4 },
		);
		tap.setScope("local:client-1");

		const service = new UniversalAgentService({ cwd, dataDir, engine: "claude" });
		const session = (await service.attach("client-1", (msg) => tap.accept(msg))) as UniversalSession;

		await session.switchConversation("conv-window");

		const snapshots = delivered.filter((m): m is Extract<ServerMessage, { type: "snapshot" }> => m.type === "snapshot");
		const lastSnapshot = snapshots[snapshots.length - 1];
		expect(lastSnapshot).toBeDefined();
		expect(lastSnapshot.state.conversationId).toBe("conv-window");
		expect(lastSnapshot.state.messages.map((m) => m.id)).toEqual(["msg-15", "msg-16", "msg-17", "msg-18", "msg-19"]);
		expect(lastSnapshot.state.historyStart).toBe(15);
		expect(lastSnapshot.state.historyTotal).toBe(20);
		expect(lastSnapshot.state.historyGeneration).toBeTruthy();

		// 模拟新连接/缓存失效后的新 tap，使用 getMessagesOfConversation + rehydrate 响应 load_earlier_messages
		const freshDelivered: ServerMessage[] = [];
		const freshTap = new MessageWindowTap(
			(msg) => {
				freshDelivered.push(msg);
			},
			{ windowSize: 5, charBudget: 0, pageSize: 4 },
		);
		freshTap.setScope("local:client-1");

		expect(freshTap.loadEarlier({ conversationId: "conv-window", before: 15, count: 4 })).toBe(false);

		const full = session.getMessagesOfConversation("conv-window");
		expect(full).toBeDefined();
		freshTap.rehydrate("conv-window", full!, 15);
		expect(freshTap.loadEarlier({ conversationId: "conv-window", before: 15, count: 4 })).toBe(true);

		const earlier = freshDelivered.find(
			(m): m is Extract<ServerMessage, { type: "earlier_messages" }> => m.type === "earlier_messages",
		);
		expect(earlier).toBeDefined();
		expect(earlier!.messages.map((m) => m.id)).toEqual(["msg-11", "msg-12", "msg-13", "msg-14"]);
		expect(earlier!.historyStart).toBe(11);
		expect(earlier!.historyTotal).toBe(20);
		expect(earlier!.before).toBe(15);

		await service.disposeAll();
	});
});
