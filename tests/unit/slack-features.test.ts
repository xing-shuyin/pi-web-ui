import { describe, expect, it, vi } from "vitest";
import { extractSlackText, peerAccountId, SlackBotBridge, stripInternalMarkers } from "../../plugins/slack/index.mjs";

describe("Slack 纯函数与辅助方法测试", () => {
	it("stripInternalMarkers 剥离内部标记与清理空行", () => {
		const raw = "这是回答[[plan:123]]中间内容[[conv:xyz]]结尾。\n\n\n新行";
		expect(stripInternalMarkers(raw)).toBe("这是回答中间内容结尾。\n\n新行");
	});

	it("peerAccountId 生成稳定的 sl_ 前缀脱敏 ID", () => {
		const id1 = peerAccountId("U12345678");
		const id2 = peerAccountId("U12345678");
		expect(id1).toBe(id2);
		expect(id1.startsWith("sl_")).toBe(true);
		expect(peerAccountId("")).toBe("sl_default");
	});

	it("extractSlackText 剥离机器人 <@U123456> 提及标签", () => {
		const text = "<@U_BOT_123> 帮我写一个快速排序算法 <@U_BOT_123>";
		expect(extractSlackText(text, "U_BOT_123")).toBe("帮我写一个快速排序算法");
	});
});

describe("SlackBotBridge 双工逻辑测试", () => {
	it("白名单模式：不在白名单内的用户会被拒绝并收到提示信息", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ ok: true }),
		});
		vi.stubGlobal("fetch", fetchMock);

		const chatSpy = vi.fn();
		const bridge: any = new SlackBotBridge({
			host: { chat: chatSpy },
			getConfig: () => ({
				botToken: "xoxb-mock",
				appToken: "xapp-mock",
				allowedUsers: ["U_ALLOWED_1", "U_ALLOWED_2"],
			}),
		});

		await bridge.onInboundEvent({
			user: "U_STRANGER",
			channel: "C_123",
			channel_type: "im",
			text: "你好",
			ts: "123456.789",
		});

		expect(chatSpy).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining("/chat.postMessage"),
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
			json: async () => ({ ok: true }),
		});
		vi.stubGlobal("fetch", fetchMock);

		const chatSpy = vi.fn();
		const bridge: any = new SlackBotBridge({
			host: { chat: chatSpy },
			getConfig: () => ({ allowAllSenders: true, botToken: "xoxb-mock", appToken: "xapp-mock" }),
		});

		await bridge.onInboundEvent({
			user: "U_ALLOWED_1",
			channel: "C_123",
			channel_type: "im",
			text: "/help",
			ts: "123456.789",
		});

		expect(chatSpy).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining("/chat.postMessage"),
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
			json: async () => ({ ok: true }),
		});
		vi.stubGlobal("fetch", fetchMock);

		let runHandler: ((ev: any) => void) | null = null;
		const chatSpy = vi.fn().mockResolvedValue({ conversationId: "conv_sl_1", runId: "sl-run" });

		const bridge: any = new SlackBotBridge({
			host: {
				chat: chatSpy,
				onRunEvent: (fn: any) => {
					runHandler = fn;
					return () => {};
				},
			},
			getConfig: () => ({ allowAllSenders: true, botToken: "xoxb-mock", appToken: "xapp-mock" }),
		});

		await bridge.start();

		await bridge.onInboundEvent({
			user: "U_ALLOWED_1",
			channel: "C_123",
			channel_type: "im",
			text: "帮我写一个函数",
			ts: "123456.789",
		});

		expect(chatSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				text: "帮我写一个函数",
				accountId: expect.stringMatching(/^slack_/),
			}),
		);

		const convId = "conv_sl_1";

		runHandler!({
			conversationId: convId,
			runId: "sl-run",
			type: "message",
			message: {
				role: "assistant",
				content: "```typescript\nfunction test() {}\n```[[plan:sl]]",
			},
		});

		await runHandler!({
			conversationId: convId,
			runId: "sl-run",
			type: "run_end",
		});

		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining("/chat.postMessage"),
			expect.objectContaining({
				body: expect.stringContaining("function test()"),
			}),
		);

		await bridge.stop();
		vi.unstubAllGlobals();
	});

	it("Slack 频道门控：非私聊频道下，未 @ 机器人的消息被忽略，@ 机器人的消息正常触发", async () => {
		const chatSpy = vi.fn().mockResolvedValue({ conversationId: "conv_sl_channel", runId: "channel-run" });
		const bridge: any = new SlackBotBridge({
			host: { chat: chatSpy },
			getConfig: () => ({ allowAllSenders: true, botToken: "xoxb-mock", appToken: "xapp-mock" }),
		});
		(bridge as any).botUser = { user_id: "B_BOT_999" };

		await bridge.onInboundEvent({
			user: "U_USER_1",
			channel: "C_PUBLIC_1",
			channel_type: "channel",
			text: "大家好，今天天气不错",
			ts: "123.456",
		});
		expect(chatSpy).not.toHaveBeenCalled();

		await bridge.onInboundEvent({
			user: "U_USER_1",
			channel: "C_PUBLIC_1",
			channel_type: "channel",
			text: "<@B_BOT_999> 你好，帮我查个数据",
			ts: "123.457",
		});
		expect(chatSpy).toHaveBeenCalledTimes(1);

		await bridge.onInboundEvent({
			user: "U_USER_1",
			channel: "D_DM_1",
			channel_type: "im",
			text: "私聊直接问问题",
			ts: "123.458",
		});
		expect(chatSpy).toHaveBeenCalledTimes(2);
	});
});

describe("Slack 空白名单安全默认", () => {
	it("空名单且未显式放行时拒绝所有人", async () => {
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
		vi.stubGlobal("fetch", fetchMock);
		const chatSpy = vi.fn();
		const bridge: any = new SlackBotBridge({
			host: { chat: chatSpy },
			getConfig: () => ({ botToken: "xoxb-mock", appToken: "xapp-mock" }),
		});
		await bridge.onInboundEvent({ user: "U1", channel: "C1", channel_type: "im", text: "hi", ts: "1.1" });
		expect(chatSpy).not.toHaveBeenCalled();
		vi.unstubAllGlobals();
	});
});
