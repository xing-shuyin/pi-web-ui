import { describe, expect, it, vi } from "vitest";
import {
	DiscordBotBridge,
	extractDiscordText,
	peerAccountId,
	stripInternalMarkers,
} from "../../plugins/discord/index.mjs";

describe("Discord 纯函数与辅助方法测试", () => {
	it("stripInternalMarkers 剥离内部标记与清理空行", () => {
		const raw = "这是回答[[plan:123]]中间内容[[conv:xyz]]结尾。\n\n\n新行";
		expect(stripInternalMarkers(raw)).toBe("这是回答中间内容结尾。\n\n新行");
	});

	it("peerAccountId 生成稳定的 dc_ 前缀脱敏 ID", () => {
		const id1 = peerAccountId("1234567890");
		const id2 = peerAccountId("1234567890");
		expect(id1).toBe(id2);
		expect(id1.startsWith("dc_")).toBe(true);
		expect(peerAccountId("")).toBe("dc_default");
	});

	it("extractDiscordText 剥离机器人 <@botId> 与 <@!botId> 标签", () => {
		const msg1 = { content: "<@9876543210> 帮我写一个快速排序" };
		expect(extractDiscordText(msg1, "9876543210")).toBe("帮我写一个快速排序");

		const msg2 = { content: "<@!9876543210> 帮我写一个快速排序" };
		expect(extractDiscordText(msg2, "9876543210")).toBe("帮我写一个快速排序");
	});
});

describe("DiscordBotBridge 双工逻辑测试", () => {
	it("白名单模式：不在白名单内的用户会被拒绝并收到提示信息", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ id: "m1" }),
		});
		vi.stubGlobal("fetch", fetchMock);

		const chatSpy = vi.fn();
		const bridge: any = new DiscordBotBridge({
			host: { chat: chatSpy },
			getConfig: () => ({
				botToken: "test_bot_token",
				allowedUsers: ["11111", "22222"],
			}),
		});

		await bridge.onInboundMessage({
			id: "m_in_1",
			channel_id: "c_123",
			author: { id: "99999", bot: false },
			content: "你好机器人",
		});

		expect(chatSpy).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining("/channels/c_123/messages"),
			expect.objectContaining({
				method: "POST",
				body: expect.stringContaining("Access restricted"),
			}),
		);

		vi.unstubAllGlobals();
	});

	it("斜杠命令 /help 应当直接回复帮助说明，不触发 host.chat", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ id: "m2" }),
		});
		vi.stubGlobal("fetch", fetchMock);

		const chatSpy = vi.fn();
		const bridge: any = new DiscordBotBridge({
			host: { chat: chatSpy },
			getConfig: () => ({ allowAllSenders: true, botToken: "test_bot_token" }),
		});

		await bridge.onInboundMessage({
			id: "m_in_2",
			channel_id: "c_123",
			author: { id: "11111", bot: false },
			content: "/help",
		});

		expect(chatSpy).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining("/channels/c_123/messages"),
			expect.objectContaining({
				body: expect.stringContaining("/help /new"),
			}),
		);

		vi.unstubAllGlobals();
	});

	it("正常入站消息派发到 host.chat，并在 run_end 时回复 Markdown", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ id: "m3" }),
		});
		vi.stubGlobal("fetch", fetchMock);

		let runHandler: ((ev: any) => void) | null = null;
		const chatSpy = vi.fn().mockResolvedValue({ conversationId: "c1", clientId: "plugin:discord:x", runId: "pr-dc-1" });

		const bridge: any = new DiscordBotBridge({
			host: {
				chat: chatSpy,
				onRunEvent: (fn: any) => {
					runHandler = fn;
					return () => {};
				},
			},
			getConfig: () => ({ allowAllSenders: true, botToken: "test_bot_token" }),
		});

		await bridge.start();

		await bridge.onInboundMessage({
			id: "m_in_3",
			channel_id: "c_123",
			author: { id: "11111", bot: false },
			content: "帮我写一个函数",
		});

		expect(chatSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				text: "帮我写一个函数",
				accountId: expect.stringMatching(/^discord_/),
			}),
		);

		const convId = "c1";

		runHandler!({
			conversationId: convId,
			runId: "pr-dc-1",
			type: "message",
			message: {
				role: "assistant",
				content: "```typescript\nfunction test() {}\n```[[plan:dc]]",
			},
		});

		await runHandler!({
			conversationId: convId,
			runId: "pr-dc-1",
			type: "run_end",
		});

		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining("/channels/c_123/messages"),
			expect.objectContaining({
				body: expect.stringContaining("function test()"),
			}),
		);

		await bridge.stop();
		vi.unstubAllGlobals();
	});
});

describe("Discord：对话被过户（改名 + 换客户端）后仍按 runId 回包", () => {
	it("conversationId 改名、clientId 变成浏览器后，run_end 仍回复到原频道", async () => {
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: "m_1" }) });
		vi.stubGlobal("fetch", fetchMock);

		let runHandler: ((ev: any) => void) | null = null;
		const chatSpy = vi.fn().mockResolvedValue({ conversationId: "c1", clientId: "plugin:discord:x", runId: "pr-dc-9" });

		const bridge: any = new DiscordBotBridge({
			host: {
				chat: chatSpy,
				onRunEvent: (fn: any) => {
					runHandler = fn;
					return () => {};
				},
			},
			getConfig: () => ({ allowAllSenders: true, botToken: "test_bot_token" }),
		});

		await bridge.start();
		await bridge.onInboundMessage({
			id: "m_in_takeover",
			channel_id: "c_123",
			author: { id: "11111", bot: false },
			content: "查一下磁盘占用",
		});

		runHandler!({
			conversationId: "c7",
			clientId: "client_browser_tab1",
			runId: "pr-dc-9",
			type: "message",
			message: { role: "assistant", content: "磁盘还剩 42GB。" },
		});
		await runHandler!({
			conversationId: "c7",
			clientId: "client_browser_tab1",
			runId: "pr-dc-9",
			type: "run_end",
		});

		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining("/channels/c_123/messages"),
			expect.objectContaining({ body: expect.stringContaining("磁盘还剩 42GB") }),
		);

		await bridge.stop();
		vi.unstubAllGlobals();
	});
});

describe("Discord 空白名单安全默认", () => {
	it("空名单且未显式放行时拒绝所有人", async () => {
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: "m1" }) });
		vi.stubGlobal("fetch", fetchMock);
		const chatSpy = vi.fn();
		const bridge: any = new DiscordBotBridge({ host: { chat: chatSpy }, getConfig: () => ({ botToken: "t" }) });
		await bridge.onInboundMessage({ id: "m2", channel_id: "c1", author: { id: "u1", bot: false }, content: "hi" });
		expect(chatSpy).not.toHaveBeenCalled();
		vi.unstubAllGlobals();
	});
});
