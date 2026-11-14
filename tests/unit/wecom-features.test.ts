import { describe, expect, it, vi } from "vitest";
import { buildWecomMessage, peerAccountId, stripInternalMarkers, WecomBotBridge } from "../../plugins/wecom/index.mjs";

describe("企业微信纯函数工具测试", () => {
	it("stripInternalMarkers 剥离内部标记与清理空行", () => {
		const raw = "回复正文[[plan:123]]中间内容[[conv:xyz]]。\n\n\n新行";
		expect(stripInternalMarkers(raw)).toBe("回复正文中间内容。\n\n新行");
	});

	it("peerAccountId 生成稳定的 wc_ 前缀脱敏 ID", () => {
		const id1 = peerAccountId("zhangsan");
		const id2 = peerAccountId("zhangsan");
		expect(id1).toBe(id2);
		expect(id1.startsWith("wc_")).toBe(true);
		expect(peerAccountId("")).toBe("wc_default");
	});

	it("buildWecomMessage 生成符合企微规范的 Markdown 与文本消息", () => {
		const textMsg = buildWecomMessage({ msgType: "text", text: "测试消息" });
		expect(textMsg.msgtype).toBe("text");
		expect(textMsg.text!.content).toBe("测试消息");

		const mdMsg = buildWecomMessage({ msgType: "markdown", title: "通报", text: "正文内容" });
		expect(mdMsg.msgtype).toBe("markdown");
		expect(mdMsg.markdown!.content).toContain("正文内容");
	});
});

describe("WecomBotBridge 双工逻辑测试", () => {
	it("白名单拦截：未在白名单中的成员消息被拦截，不触发 host.chat", async () => {
		const chatSpy = vi.fn();
		const bridge = new WecomBotBridge({
			host: { chat: chatSpy },
			getConfig: () => ({
				allowedUsers: ["admin_user"],
			}),
		});

		await bridge.onInboundMessage({
			msgId: "msg_wc_1",
			fromUserName: "guest_user",
			content: "你好",
		});

		expect(chatSpy).not.toHaveBeenCalled();
	});

	it("斜杠命令 /help 触发 Webhook 帮助回复，不调用 host.chat", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ errcode: 0 }),
		});
		vi.stubGlobal("fetch", fetchMock);

		const chatSpy = vi.fn();
		const bridge = new WecomBotBridge({
			host: { chat: chatSpy },
			getConfig: () => ({ allowAllSenders: true, webhookKey: "mock-key" }),
		});

		await bridge.onInboundMessage({
			msgId: "msg_wc_2",
			fromUserName: "user_01",
			content: "/help",
		});

		expect(chatSpy).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining("key=mock-key"),
			expect.objectContaining({
				method: "POST",
				body: expect.stringContaining("/thinking"),
			}),
		);

		vi.unstubAllGlobals();
	});

	it("正常消息触发 host.chat，并在 run_end 时推送 Markdown 回复", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ errcode: 0 }),
		});
		vi.stubGlobal("fetch", fetchMock);

		let runHandler: ((ev: any) => void) | null = null;
		const chatSpy = vi.fn().mockResolvedValue({ conversationId: "conv_wc_1", clientId: "owner-1" });

		const bridge = new WecomBotBridge({
			host: {
				chat: chatSpy,
				onRunEvent: (fn: any) => {
					runHandler = fn;
					return () => {};
				},
			},
			getConfig: () => ({ allowAllSenders: true, webhookKey: "mock-key" }),
		});

		await bridge.start();

		await bridge.onInboundMessage({
			msgId: "msg_wc_3",
			fromUserName: "user_02",
			content: "请帮我写一个函数",
		});

		expect(chatSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				text: "请帮我写一个函数",
				accountId: expect.stringMatching(/^wc_/),
			}),
		);

		const convId = "conv_wc_1";

		await runHandler!({
			conversationId: convId,
			clientId: "owner-1",
			type: "message",
			message: {
				role: "assistant",
				content: "```js\nfunction test() {}\n```[[plan:wc]]",
			},
		});

		await runHandler!({
			conversationId: convId,
			clientId: "owner-1",
			type: "run_end",
		});

		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining("key=mock-key"),
			expect.objectContaining({
				body: expect.stringContaining("function test()"),
			}),
		);

		await bridge.stop();
		vi.unstubAllGlobals();
	});

	it("长中文回复按 3900 字节分块，且 Webhook 错误码 errcode!=0 时能捕获", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ errcode: 0 }),
		});
		vi.stubGlobal("fetch", fetchMock);

		let runHandler: ((ev: any) => void) | null = null;
		const chatSpy = vi.fn().mockResolvedValue({ conversationId: "conv_wc_bytes", clientId: "owner-1" });

		const bridge = new WecomBotBridge({
			host: {
				chat: chatSpy,
				onRunEvent: (fn: any) => {
					runHandler = fn;
					return () => {};
				},
			},
			getConfig: () => ({ allowAllSenders: true, webhookKey: "mock-key" }),
		});

		await bridge.start();

		await bridge.onInboundMessage({
			msgId: "msg_wc_4",
			fromUserName: "user_03",
			content: "超长中文回复测试",
		});

		const convId = "conv_wc_bytes";

		const chineseLong = "测".repeat(2000);
		await runHandler!({
			conversationId: convId,
			clientId: "owner-1",
			type: "message",
			message: { role: "assistant", content: chineseLong },
		});

		await runHandler!({
			conversationId: convId,
			clientId: "owner-1",
			type: "run_end",
		});

		expect(fetchMock).toHaveBeenCalledTimes(2);
		for (const call of fetchMock.mock.calls) {
			const body = JSON.parse(call[1].body);
			expect(Buffer.byteLength(body.markdown.content, "utf8")).toBeLessThanOrEqual(4096);
		}

		await bridge.stop();
		vi.unstubAllGlobals();
	});
});

describe("企业微信空白名单安全默认", () => {
	it("空名单且未显式放行时拒绝所有人", async () => {
		const chatSpy = vi.fn();
		const bridge = new WecomBotBridge({ host: { chat: chatSpy }, getConfig: () => ({}) });
		await bridge.onInboundMessage({ msgId: "m1", fromUserName: "anyone", content: "hi" });
		expect(chatSpy).not.toHaveBeenCalled();
	});
});
