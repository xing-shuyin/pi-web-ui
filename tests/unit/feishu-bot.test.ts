import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	extractInboundText,
	FeishuBotBridge,
	peerAccountId,
	stripInternalMarkers,
	stripMentions,
} from "../../plugins/feishu/bot-bridge.mjs";

describe("Feishu Bot 纯函数与辅助方法测试", () => {
	it("stripInternalMarkers 剥离内部系统标记与规范换行", () => {
		const raw = "这是正常的回答[[plan:123]]继续内容[[conv:abc]]。\n\n\n结尾";
		const cleaned = stripInternalMarkers(raw);
		expect(cleaned).toBe("这是正常的回答继续内容。\n\n结尾");
	});

	it("peerAccountId 生成稳定的脱敏 accountId", () => {
		const id1 = peerAccountId("ou_123456");
		const id2 = peerAccountId("ou_123456");
		expect(id1).toBe(id2);
		expect(id1.startsWith("fs_")).toBe(true);

		const defaultId = peerAccountId("");
		expect(defaultId).toBe("fs_default");
	});

	it("stripMentions 剥离 @mention 标签", () => {
		const input = "@_user_1 请帮我写一个快速排序 @BotName 谢谢";
		const output = stripMentions(input);
		expect(output).toBe("请帮我写一个快速排序  谢谢");
	});

	it("extractInboundText 能够正确提取 text 与 post 内容", () => {
		expect(extractInboundText(JSON.stringify({ text: "你好机器人" }), "text")).toBe("你好机器人");

		const post = {
			zh_cn: {
				content: [[{ tag: "text", text: "第一行" }], [{ tag: "text", text: "第二行" }]],
			},
		};
		expect(extractInboundText(JSON.stringify(post), "post")).toBe("第一行\n第二行");
	});
});

describe("FeishuBotBridge 双工通信流程测试", () => {
	it("斜杠命令 /help 应当直接回复帮助卡片，不触发 host.chat", async () => {
		const chatSpy = vi.fn();
		const replySpy = vi.fn().mockResolvedValue({ success: true });

		const bridge = new FeishuBotBridge({
			host: { chat: chatSpy },
			getConfig: () => ({ appId: "cli_123", appSecret: "sec_123" }),
			sendMessage: vi.fn(),
			replyMessage: replySpy,
			reactMessage: vi.fn(),
		} as any);

		await bridge.onInboundMessage({
			message: {
				message_id: "om_1",
				chat_id: "oc_1",
				message_type: "text",
				content: JSON.stringify({ text: "/help" }),
			},
			sender: {
				sender_type: "user",
				sender_id: { open_id: "ou_user1" },
			},
		});

		expect(chatSpy).not.toHaveBeenCalled();
		expect(replySpy).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				messageId: "om_1",
				msgType: "interactive",
				title: "飞书机器人帮助",
			}),
		);
	});

	it("白名单模式：不在白名单内的用户会被拒绝并收到提示信息", async () => {
		const chatSpy = vi.fn();
		const replySpy = vi.fn().mockResolvedValue({ success: true });

		const bridge = new FeishuBotBridge({
			host: { chat: chatSpy },
			getConfig: () => ({
				appId: "cli_123",
				appSecret: "sec_123",
				allowedSenders: ["ou_allowed_boss"],
			}),
			sendMessage: vi.fn(),
			replyMessage: replySpy,
			reactMessage: vi.fn(),
		} as any);

		await bridge.onInboundMessage({
			message: {
				message_id: "om_2",
				chat_id: "oc_1",
				message_type: "text",
				content: JSON.stringify({ text: "请帮我查一下数据" }),
			},
			sender: {
				sender_type: "user",
				sender_id: { open_id: "ou_stranger" },
			},
		});

		expect(chatSpy).not.toHaveBeenCalled();
		expect(replySpy).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				messageId: "om_2",
				text: expect.stringContaining("访问受限"),
			}),
		);
	});

	it("正常入站消息派发到 host.chat，并在 run_end 时回发 AI 回复", async () => {
		let registeredRunHandler: ((ev: any) => void) | null = null;
		const chatSpy = vi.fn().mockResolvedValue({ conversationId: "conv_test_1", runId: "run_test_1" });
		const replySpy = vi.fn().mockResolvedValue({ success: true });
		const reactSpy = vi.fn().mockResolvedValue({ success: true });

		const bridge = new FeishuBotBridge({
			host: {
				chat: chatSpy,
				onRunEvent: (fn: any) => {
					registeredRunHandler = fn;
					return () => {};
				},
			},
			getConfig: () => ({ appId: "cli_123", appSecret: "sec_123" }),
			sendMessage: vi.fn(),
			replyMessage: replySpy,
			reactMessage: reactSpy,
		} as any);

		await bridge.start();

		await bridge.onInboundMessage({
			message: {
				message_id: "om_3",
				chat_id: "oc_1",
				message_type: "text",
				content: JSON.stringify({ text: "你好！" }),
			},
			sender: {
				sender_type: "user",
				sender_id: { open_id: "ou_user1" },
			},
		});

		expect(chatSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				text: "你好！",
				accountId: expect.stringMatching(/^fs_/),
			}),
		);
		expect(reactSpy).toHaveBeenCalledWith(expect.anything(), "om_3", "THUMBSUP");

		const convId = (await chatSpy.mock.results[0].value).conversationId;

		registeredRunHandler!({
			conversationId: convId,
			runId: "run_test_1",
			type: "message",
			message: {
				role: "assistant",
				content: "你好！我是你的 AI 助手。[[plan:test]]",
			},
		});

		await registeredRunHandler!({
			conversationId: convId,
			runId: "run_test_1",
			type: "run_end",
		});

		expect(replySpy).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				messageId: "om_3",
				text: "你好！我是你的 AI 助手。",
			}),
		);

		await bridge.stop();
	});

	it("支持配置默认项目根目录 workspace 以及通过 /cwd 指令动态切换工作目录并透传给 host.chat", async () => {
		const configuredWorkspace = join(tmpdir(), "feishu-configured-workspace");
		const customWorkspace = join(tmpdir(), "feishu-custom-user-project");
		const chatSpy = vi.fn().mockResolvedValue({ conversationId: "conv_cwd_1", runId: "run_cwd_1" });
		const replySpy = vi.fn().mockResolvedValue({ success: true });

		const bridge = new FeishuBotBridge({
			host: {
				cwd: join(tmpdir(), "feishu-default-host-cwd"),
				chat: chatSpy,
				onRunEvent: () => () => {},
			},
			getConfig: () => ({
				appId: "cli_123",
				appSecret: "sec_123",
				workspace: configuredWorkspace,
			}),
			sendMessage: vi.fn(),
			replyMessage: replySpy,
			reactMessage: vi.fn(),
		});

		await bridge.start();

		await bridge.onInboundMessage({
			message: {
				message_id: "om_cwd_1",
				chat_id: "oc_1",
				message_type: "text",
				content: JSON.stringify({ text: "/cwd" }),
			},
			sender: {
				sender_type: "user",
				sender_id: { open_id: "ou_user1" },
			},
		});
		expect(chatSpy).not.toHaveBeenCalled();
		expect(replySpy).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				messageId: "om_cwd_1",
				text: expect.stringContaining(configuredWorkspace),
			}),
		);

		await bridge.onInboundMessage({
			message: {
				message_id: "om_cwd_2",
				chat_id: "oc_1",
				message_type: "text",
				content: JSON.stringify({ text: `/cwd ${customWorkspace}` }),
			},
			sender: {
				sender_type: "user",
				sender_id: { open_id: "ou_user1" },
			},
		});
		expect(replySpy).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				messageId: "om_cwd_2",
				text: expect.stringContaining(customWorkspace),
			}),
		);

		await bridge.onInboundMessage({
			message: {
				message_id: "om_cwd_3",
				chat_id: "oc_1",
				message_type: "text",
				content: JSON.stringify({ text: "请列出当前目录下的文件" }),
			},
			sender: {
				sender_type: "user",
				sender_id: { open_id: "ou_user1" },
			},
		});
		expect(chatSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				text: "请列出当前目录下的文件",
				cwd: customWorkspace,
			}),
		);

		await bridge.stop();
	});

	it("飞书 WS 双工失败时如实置 state: error，不再假装已连接空转", async () => {
		const bridge = new FeishuBotBridge({
			host: { chat: vi.fn(), ensureDeps: vi.fn() },
			getConfig: () => ({ appId: "cli_123", appSecret: "sec_123" }),
		} as any);

		await bridge.start();

		const status = bridge.getStatus();
		expect(status.connected).toBe(false);
		expect(status.state).toBe("error");
		expect(status.lastError).toBeTruthy();

		await bridge.stop();
	});
});

describe("飞书：对话被过户（改名 + 换客户端）后仍按 runId 回包", () => {
	it("conversationId 改名、clientId 变成浏览器后，run_end 仍回发 AI 回复", async () => {
		let registeredRunHandler: ((ev: any) => void) | null = null;
		const chatSpy = vi.fn().mockResolvedValue({ conversationId: "c1", clientId: "plugin:feishu:x", runId: "pr-fs-9" });
		const replySpy = vi.fn().mockResolvedValue({ success: true });
		const reactSpy = vi.fn().mockResolvedValue({ success: true });

		const bridge = new FeishuBotBridge({
			host: {
				chat: chatSpy,
				onRunEvent: (fn: any) => {
					registeredRunHandler = fn;
					return () => {};
				},
			},
			getConfig: () => ({ appId: "cli_123", appSecret: "sec_123" }),
			sendMessage: vi.fn(),
			replyMessage: replySpy,
			reactMessage: reactSpy,
		} as any);

		await bridge.start();
		await bridge.onInboundMessage({
			message: {
				message_id: "om_takeover",
				chat_id: "oc_1",
				message_type: "text",
				content: JSON.stringify({ text: "查一下磁盘占用" }),
			},
			sender: { sender_type: "user", sender_id: { open_id: "ou_user1" } },
		});

		registeredRunHandler!({
			conversationId: "c7",
			clientId: "client_browser_tab1",
			runId: "pr-fs-9",
			type: "message",
			message: { role: "assistant", content: "磁盘还剩 42GB。" },
		});
		await registeredRunHandler!({
			conversationId: "c7",
			clientId: "client_browser_tab1",
			runId: "pr-fs-9",
			type: "run_end",
		});

		expect(replySpy).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ messageId: "om_takeover", text: expect.stringContaining("磁盘还剩 42GB") }),
		);

		await bridge.stop();
	});
});
