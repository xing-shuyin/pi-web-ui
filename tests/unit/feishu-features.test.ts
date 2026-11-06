import { describe, expect, it, vi } from "vitest";
import {
	buildMessageContent,
	formatMessageItem,
	parseFeishuMessageContent,
	protectUrls,
	restoreProtectedUrls,
	signWebhook,
} from "../../plugins/feishu/index.mjs";

describe("Feishu 纯函数工具库测试", () => {
	it("signWebhook 计算合法的 HMAC-SHA256 签名，空密钥返回空串", () => {
		expect(signWebhook(1700000000, "")).toBe("");
		expect(signWebhook(1700000000, null)).toBe("");

		const sig = signWebhook(1700000000, "my-secret-key");
		expect(sig).toBeTruthy();
		expect(typeof sig).toBe("string");
		const sig2 = signWebhook(1700000000, "my-secret-key");
		expect(sig).toBe(sig2);
	});

	it("parseFeishuMessageContent 正确解析文本、富文本 post 与交互卡片 interactive", () => {
		const resText = parseFeishuMessageContent("text", JSON.stringify({ text: "Hello Feishu" }));
		expect(resText.text).toBe("Hello Feishu");
		expect(resText.subject).toBe("Hello Feishu");

		const postPayload = {
			zh_cn: {
				title: "项目进展通报",
				content: [
					[
						{ tag: "text", text: "任务一已完成，详情参见 " },
						{ tag: "a", text: "文档链接", href: "https://example.com/doc" },
						{ tag: "at", user_name: "张三" },
					],
				],
			},
		};
		const resPost = parseFeishuMessageContent("post", JSON.stringify(postPayload));
		expect(resPost.subject).toBe("项目进展通报");
		expect(resPost.text).toContain("任务一已完成");
		expect(resPost.text).toContain("[文档链接](https://example.com/doc)");
		expect(resPost.text).toContain("@张三");

		const cardPayload = {
			header: { title: { content: "构建状态更新" } },
			elements: [{ tag: "markdown", content: "**Build succeeded** on branch `main`" }],
		};
		const resCard = parseFeishuMessageContent("interactive", JSON.stringify(cardPayload));
		expect(resCard.subject).toBe("构建状态更新");
		expect(resCard.text).toContain("**Build succeeded**");

		const resImg = parseFeishuMessageContent("image", JSON.stringify({ image_key: "img_v2_123" }));
		expect(resImg.subject).toBe("[图片消息]");

		const resFile = parseFeishuMessageContent("file", JSON.stringify({ file_name: "report.pdf" }));
		expect(resFile.subject).toBe("[文件] report.pdf");
	});

	it("buildMessageContent 生成符合飞书开放平台标准的 JSON payload", () => {
		const bText = buildMessageContent({ msgType: "text", text: "测试文本消息" });
		expect(bText.msg_type).toBe("text");
		const parsedText = JSON.parse(bText.content);
		expect(parsedText.text).toBe("测试文本消息");

		const bPost = buildMessageContent({ msgType: "post", title: "通报", text: "第一行\n第二行" });
		expect(bPost.msg_type).toBe("post");
		const parsedPost = JSON.parse(bPost.content);
		expect(parsedPost.zh_cn.title).toBe("通报");
		expect(parsedPost.zh_cn.content.length).toBe(2);

		const bCard = buildMessageContent({
			msgType: "interactive",
			title: "卡片标题",
			text: "**Markdown 内容**",
			cardTemplate: "green",
		});
		expect(bCard.msg_type).toBe("interactive");
		const parsedCard = JSON.parse(bCard.content);
		expect(parsedCard.header.template).toBe("green");
		expect(parsedCard.header.title.content).toBe("卡片标题");
		expect(parsedCard.elements[0].content).toBe("**Markdown 内容**");
	});

	it("formatMessageItem 正确格式化消息并识别未读/已读状态", () => {
		const raw = {
			message_id: "om_test_123",
			chat_id: "oc_chat_456",
			msg_type: "text",
			create_time: "1700000000000",
			sender: { id: "ou_user_789", sender_type: "user", sender_name: "李四" },
			body: { content: JSON.stringify({ text: "你好呀" }) },
		};

		const seenSet = new Set(["om_test_123"]);
		const formattedSeen = formatMessageItem(raw, seenSet);
		expect(formattedSeen.id).toBe("om_test_123");
		expect(formattedSeen.senderName).toBe("李四");
		expect(formattedSeen.seen).toBe(true);

		const formattedUnseen = formatMessageItem(raw, new Set());
		expect(formattedUnseen.seen).toBe(false);
	});

	it("protectUrls 与 restoreProtectedUrls 准确保护网址免受机器翻译干扰", () => {
		const original = "请访问 https://open.feishu.cn/document 查看文档，或者访问 https://github.com 获取源码。";
		const { protectedText, urls } = protectUrls(original);
		expect(protectedText).toContain("__URL_0__");
		expect(protectedText).toContain("__URL_1__");
		expect(urls[0]).toBe("https://open.feishu.cn/document");
		expect(urls[1]).toBe("https://github.com");

		const restored = restoreProtectedUrls(protectedText, urls);
		expect(restored).toBe(original);
	});
});

describe("Feishu 插件激活与 AI 工具集成", () => {
	it("激活插件后成功向 host 注册 feishu 工具并能响应 Webhook 发送", async () => {
		const pluginMod = await import("../../plugins/feishu/index.mjs");
		const activate = pluginMod.default;

		const registeredTools: Array<{
			name: string;
			description: string;
			parameters: Record<string, unknown>;
			execute: (args: Record<string, unknown>) => Promise<string>;
		}> = [];

		let clientMessageHandler: ((msg: Record<string, unknown>, reply: (res: unknown) => void) => void) | null = null;

		const storageData = new Map<string, unknown>();
		storageData.set("config", {
			webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/mock-hook",
			webhookSecret: "mock-secret",
		});

		const originalFetch = globalThis.fetch;
		const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
			if (String(url).includes("/hook/mock-hook")) {
				return {
					ok: true,
					json: async () => ({ code: 0, msg: "success" }),
				};
			}
			return { ok: false, status: 404 };
		});
		globalThis.fetch = mockFetch as unknown as typeof fetch;

		try {
			const mockHost = {
				storage: {
					get: async (k: string) => storageData.get(k),
					set: async (k: string, v: unknown) => storageData.set(k, v),
				},
				secrets: {
					getAll: async () => ({}),
					set: async () => {},
					delete: async () => {},
				},
				ui: {
					patch: vi.fn(),
				},
				registerBackgroundTask: vi.fn(),
				registerTool: (tool: any) => {
					registeredTools.push(tool);
				},
				onClientMessage: (handler: any) => {
					clientMessageHandler = handler;
				},
				log: vi.fn(),
				notify: vi.fn(),
			};

			await activate(mockHost);

			const tool = registeredTools.find((t) => t.name === "feishu");
			expect(tool).toBeDefined();
			expect(tool?.description).toContain("Feishu (Lark)");

			const webhookRes = await tool!.execute({
				action: "webhook",
				msg_type: "interactive",
				title: "部署完成",
				text: "v1.2.0 已顺利上线",
			});
			const parsedRes = JSON.parse(webhookRes);
			expect(parsedRes.success).toBe(true);

			expect(mockFetch).toHaveBeenCalled();
			const callBody = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
			expect(callBody.timestamp).toBeTruthy();
			expect(callBody.sign).toBeTruthy();
			expect(callBody.msg_type).toBe("interactive");

			expect(clientMessageHandler).toBeDefined();
			const stateReply = await new Promise<any>((resolve) => {
				clientMessageHandler!({ type: "get_state" }, (res) => resolve(res));
			});
			expect(stateReply.type).toBe("state");
			expect(stateReply.config).toBeDefined();
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("客户端 entry.mjs 语法合法且导出 activate 函数注册视图", async () => {
		const clientMod = await import("../../plugins/feishu/client/entry.mjs");
		expect(typeof clientMod.default).toBe("function");

		let registeredView: any = null;
		const mockCtx = {
			ui: {
				registerView: (view: any) => {
					registeredView = view;
				},
			},
		};

		clientMod.default(mockCtx);
		expect(registeredView).toBeDefined();
		expect(registeredView.id).toBe("feishu");
		expect(registeredView.label).toBe("飞书");
		expect(typeof registeredView.render).toBe("function");
	});
});

describe("Feishu 轮询调度（0.103 审计修复）", () => {
	it("轮询由插件自建 setInterval 调度，面板任务带 stop，deactivate 停轮询", async () => {
		const pluginMod = await import("../../plugins/feishu/index.mjs");
		vi.useFakeTimers();
		const storageData = new Map<string, unknown>([["config", { appId: "cli_x", appSecret: "s", pollSec: 15 }]]);
		const bgTaskHandle = { update: vi.fn(), unregister: vi.fn() };
		const registerBackgroundTask = vi.fn(() => bgTaskHandle);
		const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
		const originalFetch = globalThis.fetch;
		globalThis.fetch = mockFetch as unknown as typeof fetch;
		try {
			const deactivate = await (pluginMod.default as unknown as (h: unknown) => Promise<unknown>)({
				storage: {
					get: async (k: string) => storageData.get(k),
					set: async () => {},
				},
				secrets: { getAll: async () => ({}), set: async () => {}, delete: async () => {} },
				ui: { patch: vi.fn() },
				registerBackgroundTask,
				log: vi.fn(),
				notify: vi.fn(),
			} as any);
			await vi.advanceTimersByTimeAsync(1);
			expect(mockFetch).toHaveBeenCalled();
			const afterFirst = mockFetch.mock.calls.length;
			expect(registerBackgroundTask).toHaveBeenCalledWith(
				expect.objectContaining({ id: "feishu-poll", status: "每 15s" }),
			);
			await vi.advanceTimersByTimeAsync(15_000);
			expect(mockFetch.mock.calls.length).toBeGreaterThan(afterFirst);
			expect(typeof deactivate).toBe("function");
			(deactivate as () => void)();
			const beforeStop = mockFetch.mock.calls.length;
			await vi.advanceTimersByTimeAsync(60_000);
			expect(mockFetch.mock.calls.length).toBe(beforeStop);
		} finally {
			vi.useRealTimers();
			globalThis.fetch = originalFetch;
		}
	});
});
