import { describe, expect, it } from "vitest";
import {
	formatTextQuote,
	parseTextQuote,
	readTextQuote,
	formatQuotedPrompt,
	formatStreamingPrompt,
	splitQuotedPrompt,
	messageTextWithQuotes,
} from "../../server/text-quote.js";
import { userMessageEventToUiMessage } from "../../server/dsh/dsh-serialize.js";
import { serializeMessage } from "../../server/serialize.js";

const quote = {
	text: "  const value = '</quoted-text>';\n第二行  ",
	messageId: "a1",
	role: "assistant",
	sessionId: "s1",
};

describe("文字引用", () => {
	it("排队内容拆分保留多条引用与提问原文", () => {
		const second = { ...quote, messageId: "a2", text: "另一段" };
		expect(splitQuotedPrompt(formatQuotedPrompt("问题\n", [quote, second]))).toEqual({
			text: "问题\n",
			quotes: [quote, second],
		});
		expect(splitQuotedPrompt("普通问题\n\n<quoted-text>\n损坏内容\n</quoted-text>")).toEqual({
			text: "普通问题\n\n<quoted-text>\n损坏内容\n</quoted-text>",
			quotes: [],
		});
	});
	it("历史转上下文保留已展示为卡片的引用", () => {
		const message = userMessageEventToUiMessage({
			id: "u1",
			content: [
				{ type: "text", text: "解释这段" },
				{ type: "text", text: formatTextQuote(quote) },
			],
		});
		expect(messageTextWithQuotes(message)).toBe(`解释这段\n\n${formatTextQuote(quote)}`);
	});
	it("仅有引用的乐观消息与持久事件具有相同且非空的识别文本", () => {
		const optimistic = { content: [{ type: "text", text: "" }], details: { quotes: [quote] } };
		const persisted = userMessageEventToUiMessage({
			id: "u1",
			content: [
				{ type: "text", text: "" },
				{ type: "text", text: formatTextQuote(quote) },
			],
		});
		expect(messageTextWithQuotes(optimistic)).toBe(`\n\n${formatTextQuote(quote)}`);
		expect(messageTextWithQuotes(persisted)).toBe(messageTextWithQuotes(optimistic));
		expect(splitQuotedPrompt(messageTextWithQuotes(persisted))).toEqual({ text: "", quotes: [quote] });
	});
	it("排队消息原文中的引用还原为卡片，不混入提问正文", () => {
		const message = serializeMessage(
			{ role: "user", timestamp: 1, content: [{ type: "text", text: `解释这段\n\n${formatTextQuote(quote)}` }] },
			0,
		)!;
		expect(message.content).toEqual([{ type: "text", text: "解释这段" }]);
		expect(message.details).toEqual({ quotes: [quote] });
	});
	it("保留包含标记、换行和缩进的原文", () => {
		expect(parseTextQuote(formatTextQuote(quote))).toEqual(quote);
	});
	it.each([null, {}, { ...quote, text: " \n " }, { ...quote, messageId: "" }, { ...quote, text: 1 }])(
		"拒绝无效引用 %j",
		(value) => {
			expect(readTextQuote(value)).toBeNull();
		},
	);
	it.each(["普通消息", "<quoted-text>\n错误数据\n</quoted-text>"])("普通文字或损坏标记不解析为引用", (text) => {
		expect(parseTextQuote(text)).toBeNull();
	});
	it("DeepSeek 引擎历史回放还原引用卡片，提问正文不混入引用标记", () => {
		const message = userMessageEventToUiMessage({
			id: "u1",
			content: [
				{ type: "text", text: "解释这段" },
				{ type: "text", text: formatTextQuote(quote) },
			],
		});
		expect(message.content).toEqual([{ type: "text", text: "解释这段" }]);
		expect(message.details).toEqual({ quotes: [quote] });
	});
	it("流式排队提示词格式化与拆分：附件标记与引用完整提取且正文保持纯净", () => {
		const formatted = formatStreamingPrompt(
			"请检查这些内容",
			[
				'<file path="src/main.ts" lines="1-20" />',
				'<folder path="docs" />',
				'<browser-page url="https://example.com" title="Example Page">\nPage Content\n</browser-page>',
				'<conversation-ref id="c1" title="历史对话">\nRef\n</conversation-ref>',
				"<vision-bridge>\n图表转写结果\n</vision-bridge>",
			],
			[quote],
			["screenshot.png"],
		);
		const parsed = splitQuotedPrompt(formatted);
		expect(parsed.text).toBe("请检查这些内容");
		expect(parsed.quotes).toEqual([quote]);
		expect(parsed.attachments).toEqual([
			{ type: "image", name: "screenshot.png" },
			{ type: "file", name: "main.ts", path: "src/main.ts", lines: { start: 1, end: 20 } },
			{ type: "folder", name: "docs", path: "docs" },
			{ type: "page", name: "Example Page", url: "https://example.com" },
			{ type: "conversation", name: "历史对话" },
			{ type: "vision-bridge", name: "视觉转写" },
		]);
	});
});
