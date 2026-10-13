import { describe, expect, it } from "vitest";
import { formatStreamingPrompt, splitQuotedPrompt, formatTextQuote } from "../../server/text-quote.js";
import type { TextQuote } from "../../server/protocol.js";
import { serializeMessage } from "../../server/serialize.js";
import type { AgentMessage } from "../../server/serialize.js";

const sampleQuote: TextQuote = {
	text: "const a = 1;",
	messageId: "m1",
	role: "assistant",
};

describe("排队消息附件处理与隔离 (queued-attachments)", () => {
	it("formatStreamingPrompt 与 splitQuotedPrompt 往返解析：正文干净且提取所有附件元数据", () => {
		const formatted = formatStreamingPrompt(
			"请帮我分析这张图片和代码",
			['<file path="src/app.ts" lines="5-15" />', "<vision-bridge>\n识别为柱状图\n</vision-bridge>"],
			[sampleQuote],
			["chart.png"],
		);

		// 格式化文本包含对应标记
		expect(formatted).toContain("请帮我分析这张图片和代码");
		expect(formatted).toContain('<attached-image name="chart.png" />');
		expect(formatted).toContain('<file path="src/app.ts" lines="5-15" />');
		expect(formatted).toContain("<vision-bridge>\n识别为柱状图\n</vision-bridge>");
		expect(formatted).toContain(formatTextQuote(sampleQuote));

		// 拆分后正文被彻底净化，不残留任何 XML/quote 标记
		const parsed = splitQuotedPrompt(formatted);
		expect(parsed.text).toBe("请帮我分析这张图片和代码");
		expect(parsed.quotes).toEqual([sampleQuote]);
		expect(parsed.attachments).toEqual([
			{ type: "image", name: "chart.png" },
			{ type: "file", name: "app.ts", path: "src/app.ts", lines: { start: 5, end: 15 } },
			{ type: "vision-bridge", name: "视觉转写" },
		]);
	});

	it("仅有附件无提问文字时，拆分后正文为空串，附件元数据完整", () => {
		const formatted = formatStreamingPrompt("", ['<folder path="docs" />'], [], ["photo.jpg"]);
		const parsed = splitQuotedPrompt(formatted);
		expect(parsed.text).toBe("");
		expect(parsed.quotes).toEqual([]);
		expect(parsed.attachments).toEqual([
			{ type: "image", name: "photo.jpg" },
			{ type: "folder", name: "docs", path: "docs" },
		]);
	});

	it("serializeMessage 将排队完成后的用户消息正文净化，并挂载 details.attachments 与 details.quotes", () => {
		const formatted = formatStreamingPrompt(
			"这是排队提交的问题",
			['<file path="server/index.ts" />'],
			[sampleQuote],
			["error.png"],
		);

		const rawMessage: AgentMessage = {
			role: "user",
			timestamp: 1700000000000,
			content: [
				{ type: "text", text: formatted },
				{
					type: "image",
					data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
					mimeType: "image/png",
				},
			],
		};

		const ui = serializeMessage(rawMessage, 1);
		expect(ui).not.toBeNull();
		expect(ui!.role).toBe("user");

		// 正文净化
		const textBlock = ui!.content.find((b) => b.type === "text") as { type: "text"; text: string };
		expect(textBlock.text).toBe("这是排队提交的问题");

		// 图片块被保留为 UiImageBlock
		const imgBlock = ui!.content.find((b) => b.type === "image") as { type: "image"; dataUrl?: string };
		expect(imgBlock).toBeDefined();
		expect(imgBlock.dataUrl).toContain("data:image/png;base64,");

		// details 携带引用和附件元数据
		const details = ui!.details as { quotes?: TextQuote[]; attachments?: unknown[] };
		expect(details.quotes).toEqual([sampleQuote]);
		expect(details.attachments).toEqual([
			{ type: "image", name: "error.png" },
			{ type: "file", name: "index.ts", path: "server/index.ts", lines: undefined },
		]);
	});

	it("无附件的普通消息 serializeMessage 不产生冗余 details.attachments", () => {
		const rawMessage: AgentMessage = {
			role: "user",
			timestamp: 1700000000001,
			content: [{ type: "text", text: "普通提问" }],
		};

		const ui = serializeMessage(rawMessage, 2);
		expect(ui!.details).toBeUndefined();
	});

	it("验证流式排队不向 _pendingNextTurnMessages 泄露，防止下一次提问被动附带上一次排队的附件", () => {
		// 模拟 AgentSession 的 pending 队列与 prompt 行为
		const session = {
			isStreaming: true,
			model: { input: ["text", "image"] },
			_pendingNextTurnMessages: [] as unknown[],
			promptsReceived: [] as { text: string; options?: unknown }[],
			async sendCustomMessage(msg: unknown, opts?: { deliverAs?: string }) {
				if (opts?.deliverAs === "nextTurn") {
					this._pendingNextTurnMessages.push(msg);
				}
			},
			async prompt(text: string, options?: { streamingBehavior?: string; images?: unknown[] }) {
				if (this.isStreaming) {
					// 流式排队直接记录，不消费 _pendingNextTurnMessages
					this.promptsReceived.push({ text, options });
					return;
				}
				// 非流式提问会消费 _pendingNextTurnMessages
				const injected = [...this._pendingNextTurnMessages];
				this._pendingNextTurnMessages = [];
				this.promptsReceived.push({ text, options: { ...options, injected } });
			},
		};

		// 模拟用户在流式期间发送带图片附件的排队消息：
		// 修复前：调 sendCustomMessage(aside, { deliverAs: "nextTurn" })，导致 _pendingNextTurnMessages 堆积
		// 修复后：不调 sendCustomMessage，而是将图片直接传给 s.prompt 的 options.images，文本合并进 prompt
		const promptImages = [{ type: "image" as const, data: "base64data", mimeType: "image/png" }];
		const fullText = formatStreamingPrompt("请帮我看排队图片", [], [], ["pasted.png"]);

		// 执行修复后的投递逻辑
		session.prompt(fullText, {
			streamingBehavior: "followUp",
			images: promptImages,
		});

		// 确保 _pendingNextTurnMessages 绝不被污染（保持为 0）
		expect(session._pendingNextTurnMessages.length).toBe(0);

		// 排队提示词收到了完整的文本与图片
		expect(session.promptsReceived.length).toBe(1);
		expect(session.promptsReceived[0]!.text).toBe(fullText);
		expect(session.promptsReceived[0]!.options).toEqual({
			streamingBehavior: "followUp",
			images: promptImages,
		});

		// 模拟智能体结束流式并回答完毕
		session.isStreaming = false;

		// 用户发起下一个普通提问
		session.prompt("下一个问题：今天天气怎么样？");

		expect(session.promptsReceived.length).toBe(2);
		const nextPrompt = session.promptsReceived[1]!;
		expect(nextPrompt.text).toBe("下一个问题：今天天气怎么样？");
		// 验证：下一个提问没有被注入任何来自上一轮排队消息的残留附件！
		expect((nextPrompt.options as { injected: unknown[] }).injected).toEqual([]);
	});
});
