import { describe, expect, it, vi } from "vitest";
import {
	cleanIMessageText,
	IMessageBotBridge,
	IMESSAGE_BOT_PREFIX,
	peerAccountId,
	stripInternalMarkers,
} from "../../plugins/imessage/index.mjs";

describe("iMessage 纯函数与辅助方法测试", () => {
	it("stripInternalMarkers 剥离内部标记与清理空行", () => {
		const raw = "这是回答[[plan:123]]中间内容[[conv:xyz]]结尾。\n\n\n新行";
		expect(stripInternalMarkers(raw)).toBe("这是回答中间内容结尾。\n\n新行");
	});

	it("peerAccountId 生成稳定的 im_ 前缀脱敏 ID", () => {
		const id1 = peerAccountId("user@example.com");
		const id2 = peerAccountId("user@example.com");
		expect(id1).toBe(id2);
		expect(id1.startsWith("im_")).toBe(true);
		expect(peerAccountId("")).toBe("im_default");
	});

	it("cleanIMessageText 识别并忽略自身机器人的回声回复", () => {
		const botEcho = `${IMESSAGE_BOT_PREFIX}任务完成`;
		expect(cleanIMessageText(botEcho)).toBe("");

		const userMsg = "你好，请写一个函数";
		expect(cleanIMessageText(userMsg)).toBe("你好，请写一个函数");
	});
});

describe("IMessageBotBridge 双工逻辑测试", () => {
	it("白名单模式：不在白名单内的联系人会被拒绝并收到提示信息", async () => {
		const execMock = vi.fn().mockResolvedValue({ stdout: "" });

		const chatSpy = vi.fn();
		const bridge = new IMessageBotBridge({
			host: { chat: chatSpy },
			getConfig: () => ({
				allowedUsers: ["allowed@example.com"],
			}),
			execFileImpl: execMock,
		});

		await bridge.onInboundMessage({
			id: "im_msg_1",
			sender: "stranger@example.com",
			text: "你好",
		});

		expect(chatSpy).not.toHaveBeenCalled();
	});

	it("斜杠命令 /help 应当直接回复帮助说明，不触发 host.chat", async () => {
		const execMock = vi.fn().mockResolvedValue({ stdout: "" });

		const chatSpy = vi.fn();
		const bridge = new IMessageBotBridge({
			host: { chat: chatSpy },
			getConfig: () => ({}),
			execFileImpl: execMock,
		});

		await bridge.onInboundMessage({
			id: "im_msg_2",
			sender: "user@example.com",
			text: "/help",
		});

		expect(chatSpy).not.toHaveBeenCalled();
	});

	it("正常入站消息派发到 host.chat，并在 run_end 时回复 Markdown", async () => {
		const execMock = vi.fn().mockResolvedValue({ stdout: "" });

		let runHandler: ((ev: any) => void) | null = null;
		const chatSpy = vi.fn().mockResolvedValue({ conversationId: "conv_im_1", clientId: "legacy-imessage" });

		const bridge = new IMessageBotBridge({
			host: {
				chat: chatSpy,
				onRunEvent: (fn: any) => {
					runHandler = fn;
					return () => {};
				},
			},
			getConfig: () => ({}),
			execFileImpl: execMock,
		});

		runHandler = (ev: any) => bridge.handleRunEvent(ev);

		await bridge.onInboundMessage({
			id: "im_msg_3",
			sender: "user@example.com",
			text: "帮我写一个函数",
		});

		expect(chatSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				text: "帮我写一个函数",
				accountId: expect.stringMatching(/^im_/),
			}),
		);

		const convId = "conv_im_1";

		runHandler!({
			conversationId: convId,
			clientId: "legacy-imessage",
			type: "message",
			message: {
				role: "assistant",
				content: "```typescript\nfunction test() {}\n```[[plan:im]]",
			},
		});

		await runHandler!({
			conversationId: convId,
			clientId: "legacy-imessage",
			type: "run_end",
		});

		expect(bridge.getStatus().messagesReplied).toBe(1);

		await bridge.stop();
	});

	it("非 macOS 平台且未注入 execFileImpl 时，sendMacOSIMessage 明确抛错，bridge 置为 unsupported", async () => {
		if (process.platform === "darwin") return;

		const { sendMacOSIMessage } = await import("../../plugins/imessage/index.mjs");
		await expect(sendMacOSIMessage("user@example.com", "hello", {})).rejects.toThrow("only available on macOS");

		const bridge = new IMessageBotBridge({
			host: { chat: vi.fn() },
			getConfig: () => ({}),
		});

		await bridge.start();
		const status = bridge.getStatus();
		expect(status.state).toBe("unsupported");
		expect(status.connected).toBe(false);
		expect(status.lastError).toContain("requires macOS");
	});
});
