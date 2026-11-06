import { describe, expect, it, vi } from "vitest";
import {
	extractTelegramText,
	peerAccountId,
	stripInternalMarkers,
	TelegramBotBridge,
} from "../../plugins/telegram/index.mjs";

describe("Telegram 纯函数与辅助方法测试", () => {
	it("stripInternalMarkers 剥离内部标记与清理多余空行", () => {
		const raw = "这是回答[[plan:123]]中间内容[[conv:xyz]]结尾。\n\n\n\n新行";
		expect(stripInternalMarkers(raw)).toBe("这是回答中间内容结尾。\n\n新行");
	});

	it("peerAccountId 生成稳定的 tg_ 前缀脱敏 ID", () => {
		const id1 = peerAccountId("987654321");
		const id2 = peerAccountId("987654321");
		expect(id1).toBe(id2);
		expect(id1.startsWith("tg_")).toBe(true);
		expect(peerAccountId("")).toBe("tg_default");
	});

	it("extractTelegramText 剥离机器人 @Username 标记", () => {
		const msg = { text: "@MyAwesomeBot 请帮我写一段 TypeScript 代码 @MyAwesomeBot" };
		const clean = extractTelegramText(msg, "MyAwesomeBot");
		expect(clean).toBe("请帮我写一段 TypeScript 代码");
	});
});

describe("TelegramBotBridge 双工通信流程测试", () => {
	it("白名单模式：不在白名单内的用户会被拒绝并收到提示信息", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ ok: true, result: {} }),
		});
		vi.stubGlobal("fetch", fetchMock);

		const chatSpy = vi.fn();
		const bridge = new TelegramBotBridge({
			host: { chat: chatSpy },
			getConfig: () => ({
				botToken: "123:test_token",
				allowedUsers: ["10001", "10002"],
			}),
		});

		await bridge.onInboundMessage({
			message_id: 1,
			chat: { id: 8888, type: "private" },
			from: { id: 9999, is_bot: false },
			text: "你好机器人",
		});

		expect(chatSpy).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining("/sendMessage"),
			expect.objectContaining({
				method: "POST",
				body: expect.stringContaining("访问受限"),
			}),
		);

		vi.unstubAllGlobals();
	});

	it("斜杠命令 /help 应当直接回复帮助说明，不触发 host.chat", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ ok: true, result: {} }),
		});
		vi.stubGlobal("fetch", fetchMock);

		const chatSpy = vi.fn();
		const bridge = new TelegramBotBridge({
			host: { chat: chatSpy },
			getConfig: () => ({
				botToken: "123:test_token",
			}),
		});

		await bridge.onInboundMessage({
			message_id: 2,
			chat: { id: 8888, type: "private" },
			from: { id: 10001, is_bot: false },
			text: "/help",
		});

		expect(chatSpy).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining("/sendMessage"),
			expect.objectContaining({
				body: expect.stringContaining("Telegram 机器人帮助"),
			}),
		);

		vi.unstubAllGlobals();
	});

	it("正常入站消息派发到 host.chat，并在 run_end 时回复 Markdown", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ ok: true, result: { username: "MyBot" } }),
		});
		vi.stubGlobal("fetch", fetchMock);

		let runHandler: ((ev: any) => void) | null = null;
		const chatSpy = vi.fn().mockResolvedValue({ conversationId: "conv_tg_1", runId: "run_tg_1" });

		const bridge = new TelegramBotBridge({
			host: {
				chat: chatSpy,
				onRunEvent: (fn: any) => {
					runHandler = fn;
					return () => {};
				},
			},
			getConfig: () => ({
				botToken: "123:test_token",
			}),
		});

		await bridge.start();

		await bridge.onInboundMessage({
			message_id: 3,
			chat: { id: 8888, type: "private" },
			from: { id: 10001, is_bot: false },
			text: "帮我写一个快速排序",
		});

		expect(chatSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				text: "帮我写一个快速排序",
				accountId: expect.stringMatching(/^tg_/),
			}),
		);

		const convId = "conv_tg_1";

		runHandler!({
			runId: "run_tg_1",
			conversationId: convId,
			type: "message",
			message: {
				role: "assistant",
				content: "```typescript\nfunction sort() {}\n```[[plan:tg]]",
			},
		});

		await runHandler!({
			runId: "run_tg_1",
			conversationId: convId,
			type: "run_end",
		});

		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining("/sendMessage"),
			expect.objectContaining({
				body: expect.stringContaining("function sort()"),
			}),
		);

		await bridge.stop();
		vi.unstubAllGlobals();
	});

	it("Telegram 群聊门控：@其他人的消息不触发，只有指名道姓 @机器人自身才触发", async () => {
		const chatSpy = vi.fn().mockResolvedValue({ conversationId: "conv_tg_group", runId: "run_tg_group" });
		const bridge = new TelegramBotBridge({
			host: { chat: chatSpy },
			getConfig: () => ({ botToken: "123:test_token" }),
		});
		bridge.status.botUsername = "MyAwesomeBot";

		await bridge.onInboundMessage({
			message_id: 10,
			chat: { id: -100123, type: "supergroup" },
			from: { id: 10001, is_bot: false },
			text: "@OtherUser 你好，看下这个",
			entities: [{ type: "mention", offset: 0, length: 10 }],
		});
		expect(chatSpy).not.toHaveBeenCalled();

		await bridge.onInboundMessage({
			message_id: 11,
			chat: { id: -100123, type: "supergroup" },
			from: { id: 10001, is_bot: false },
			text: "@MyAwesomeBot 帮我写个脚本",
			entities: [{ type: "mention", offset: 0, length: 13 }],
		});
		expect(chatSpy).toHaveBeenCalledTimes(1);

		await bridge.onInboundMessage({
			message_id: 12,
			chat: { id: 8888, type: "private" },
			from: { id: 10001, is_bot: false },
			text: "私聊直接提问",
		});
		expect(chatSpy).toHaveBeenCalledTimes(2);
	});
});
