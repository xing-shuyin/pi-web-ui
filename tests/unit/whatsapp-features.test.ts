import { describe, expect, it, vi } from "vitest";
import {
	buildWhatsappPayload,
	extractWhatsappText,
	peerAccountId,
	stripInternalMarkers,
	WhatsappBotBridge,
} from "../../plugins/whatsapp/index.mjs";

describe("WhatsApp 纯函数与辅助方法测试", () => {
	it("stripInternalMarkers 剥离内部标记与清理空行", () => {
		const raw = "这是回答[[plan:123]]中间内容[[conv:xyz]]结尾。\n\n\n新行";
		expect(stripInternalMarkers(raw)).toBe("这是回答中间内容结尾。\n\n新行");
	});

	it("peerAccountId 生成稳定的 wa_ 前缀脱敏 ID", () => {
		const id1 = peerAccountId("8613800000000");
		const id2 = peerAccountId("8613800000000");
		expect(id1).toBe(id2);
		expect(id1.startsWith("wa_")).toBe(true);
		expect(peerAccountId("")).toBe("wa_default");
	});

	it("extractWhatsappText 正确提取文本或交互式回复文本", () => {
		const msg1 = { type: "text", text: { body: "Hello WhatsApp" } };
		expect(extractWhatsappText(msg1)).toBe("Hello WhatsApp");

		const msg2 = { type: "interactive", interactive: { button_reply: { title: "Confirm" } } };
		expect(extractWhatsappText(msg2)).toBe("Confirm");
	});

	it("buildWhatsappPayload 构造标准 WhatsApp Cloud API 请求载荷", () => {
		const payload = buildWhatsappPayload("+86 138-0000-0000", "Hello world");
		expect(payload.messaging_product).toBe("whatsapp");
		expect(payload.to).toBe("8613800000000");
		expect(payload.text.body).toBe("Hello world");
	});
});

describe("WhatsappBotBridge 双工逻辑测试", () => {
	it("白名单模式：不在白名单内的号码会被拒绝并收到提示信息", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ messages: [{ id: "wam_1" }] }),
		});
		vi.stubGlobal("fetch", fetchMock);

		const chatSpy = vi.fn();
		const bridge = new WhatsappBotBridge({
			host: { chat: chatSpy },
			getConfig: () => ({
				accessToken: "mock_token",
				phoneNumberId: "mock_phone_id",
				allowedUsers: ["8613800000000"],
			}),
		});

		await bridge.onInboundMessage({
			id: "wam_in_1",
			from: "8613999999999",
			type: "text",
			text: { body: "你好机器人" },
		});

		expect(chatSpy).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining("/mock_phone_id/messages"),
			expect.objectContaining({
				method: "POST",
				body: expect.stringContaining("Access Restricted"),
			}),
		);

		vi.unstubAllGlobals();
	});

	it("斜杠命令 /help 应当直接回复帮助说明，不触发 host.chat", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ messages: [{ id: "wam_2" }] }),
		});
		vi.stubGlobal("fetch", fetchMock);

		const chatSpy = vi.fn();
		const bridge = new WhatsappBotBridge({
			host: { chat: chatSpy },
			getConfig: () => ({
				accessToken: "mock_token",
				phoneNumberId: "mock_phone_id",
			}),
		});

		await bridge.onInboundMessage({
			id: "wam_in_2",
			from: "8613800000000",
			type: "text",
			text: { body: "/help" },
		});

		expect(chatSpy).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining("/mock_phone_id/messages"),
			expect.objectContaining({
				body: expect.stringContaining("WhatsApp Bot Help"),
			}),
		);

		vi.unstubAllGlobals();
	});

	it("正常入站消息派发到 host.chat，并在 run_end 时回复 Markdown", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ messages: [{ id: "wam_3" }] }),
		});
		vi.stubGlobal("fetch", fetchMock);

		let runHandler: ((ev: any) => void) | null = null;
		const chatSpy = vi.fn().mockResolvedValue({ conversationId: "conv_wa_1", runId: "run_wa_1" });

		const bridge = new WhatsappBotBridge({
			host: {
				chat: chatSpy,
				onRunEvent: (fn: any) => {
					runHandler = fn;
					return () => {};
				},
			},
			getConfig: () => ({
				accessToken: "mock_token",
				phoneNumberId: "mock_phone_id",
			}),
		});

		await bridge.start();

		await bridge.onInboundMessage({
			id: "wam_in_3",
			from: "8613800000000",
			type: "text",
			text: { body: "帮我写一个函数" },
		});

		expect(chatSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				text: "帮我写一个函数",
				accountId: expect.stringMatching(/^wa_/),
			}),
		);

		const convId = "conv_wa_1";

		runHandler!({
			runId: "run_wa_1",
			conversationId: convId,
			type: "message",
			message: {
				role: "assistant",
				content: "```typescript\nfunction test() {}\n```[[plan:wa]]",
			},
		});

		await runHandler!({
			runId: "run_wa_1",
			conversationId: convId,
			type: "run_end",
		});

		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining("/mock_phone_id/messages"),
			expect.objectContaining({
				body: expect.stringContaining("function test()"),
			}),
		);

		await bridge.stop();
		vi.unstubAllGlobals();
	});
});
