import { describe, expect, it, vi } from "vitest";
import {
	extractMatrixText,
	MatrixBotBridge,
	peerAccountId,
	stripInternalMarkers,
} from "../../plugins/matrix/index.mjs";

describe("Matrix 纯函数与辅助方法测试", () => {
	it("stripInternalMarkers 剥离内部标记与清理空行", () => {
		const raw = "这是回答[[plan:123]]中间内容[[conv:xyz]]结尾。\n\n\n新行";
		expect(stripInternalMarkers(raw)).toBe("这是回答中间内容结尾。\n\n新行");
	});

	it("peerAccountId 生成稳定的 mtx_ 前缀脱敏 ID", () => {
		const id1 = peerAccountId("@alice:matrix.org");
		const id2 = peerAccountId("@alice:matrix.org");
		expect(id1).toBe(id2);
		expect(id1.startsWith("mtx_")).toBe(true);
		expect(peerAccountId("")).toBe("mtx_default");
	});

	it("extractMatrixText 剥离机器人 @botId 标签", () => {
		const content = { body: "@bot:matrix.org 帮我写一个快速排序算法" };
		expect(extractMatrixText(content, "@bot:matrix.org")).toBe("帮我写一个快速排序算法");
	});
});

describe("MatrixBotBridge 双工逻辑测试", () => {
	it("白名单模式：不在白名单内的用户会被拒绝，不触发 host.chat", async () => {
		const chatSpy = vi.fn();
		const bridge = new MatrixBotBridge({
			host: { chat: chatSpy },
			getConfig: () => ({
				homeserverUrl: "https://matrix.org",
				accessToken: "mock_token",
				allowedUsers: ["@alice:matrix.org"],
			}),
		});

		await bridge.onInboundMessage("!room1:matrix.org", {
			event_id: "$ev1",
			sender: "@bob:matrix.org",
			content: { body: "你好" },
		});

		expect(chatSpy).not.toHaveBeenCalled();
	});

	it("斜杠命令 /help 应当直接回复帮助说明，不触发 host.chat", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ event_id: "$reply_1" }),
		});
		vi.stubGlobal("fetch", fetchMock);

		const chatSpy = vi.fn();
		const bridge = new MatrixBotBridge({
			host: { chat: chatSpy },
			getConfig: () => ({
				homeserverUrl: "https://matrix.org",
				accessToken: "mock_token",
			}),
		});

		await bridge.onInboundMessage("!room1:matrix.org", {
			event_id: "$ev2",
			sender: "@alice:matrix.org",
			content: { body: "/help" },
		});

		expect(chatSpy).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining("/send/m.room.message/"),
			expect.objectContaining({
				method: "PUT",
				body: expect.stringContaining("Matrix 机器人帮助"),
			}),
		);

		vi.unstubAllGlobals();
	});

	it("正常入站消息派发到 host.chat，并在 run_end 时回复 Markdown", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ user_id: "@bot:matrix.org", event_id: "$reply_2" }),
		});
		vi.stubGlobal("fetch", fetchMock);

		let runHandler: ((ev: any) => void) | null = null;
		const chatSpy = vi.fn().mockResolvedValue({ conversationId: "conv_mtx_1", runId: "run_mtx_1" });

		const bridge = new MatrixBotBridge({
			host: {
				chat: chatSpy,
				onRunEvent: (fn: any) => {
					runHandler = fn;
					return () => {};
				},
			},
			getConfig: () => ({
				homeserverUrl: "https://matrix.org",
				accessToken: "mock_token",
			}),
		});

		await bridge.start();

		await bridge.onInboundMessage("!room1:matrix.org", {
			event_id: "$ev3",
			sender: "@alice:matrix.org",
			content: { body: "帮我写一个函数" },
		});

		expect(chatSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				text: "帮我写一个函数",
				accountId: expect.stringMatching(/^mtx_/),
			}),
		);

		const convId = "conv_mtx_1";

		runHandler!({
			conversationId: convId,
			runId: "run_mtx_1",
			type: "message",
			message: {
				role: "assistant",
				content: "```typescript\nfunction test() {}\n```[[plan:mtx]]",
			},
		});

		await runHandler!({
			conversationId: "renamed_mtx_1",
			runId: "run_mtx_1",
			type: "run_end",
		});

		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining("/send/m.room.message/"),
			expect.objectContaining({
				method: "PUT",
				body: expect.stringContaining("function test()"),
			}),
		);

		await bridge.stop();
		vi.unstubAllGlobals();
	});

	it("Matrix 门控与防重放：忽略 m.notice 机器人通知消息，且支持游标持久化", async () => {
		const chatSpy = vi.fn().mockResolvedValue({ conversationId: "conv_mtx_test" });
		const storageMap = new Map<string, string>();
		const host = {
			chat: chatSpy,
			storage: {
				get: vi.fn(async (key: string) => storageMap.get(key)),
				set: vi.fn(async (key: string, val: string) => {
					storageMap.set(key, val);
				}),
			},
		};

		const bridge = new MatrixBotBridge({
			host,
			getConfig: () => ({ homeserverUrl: "https://matrix.org", accessToken: "token" }),
		});

		await bridge.onInboundMessage("!room1:matrix.org", {
			event_id: "$ev_notice",
			sender: "@otherbot:matrix.org",
			content: { msgtype: "m.notice", body: "机器人系统通知" },
		});
		expect(chatSpy).not.toHaveBeenCalled();

		await bridge.onInboundMessage("!room1:matrix.org", {
			event_id: "$ev_normal",
			sender: "@alice:matrix.org",
			content: { msgtype: "m.text", body: "用户正常提问" },
		});
		expect(chatSpy).toHaveBeenCalledTimes(1);
	});
});
