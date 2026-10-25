import { describe, expect, it } from "vitest";
import { StreamSentenceExtractor } from "../../web/src/tts.js";

describe("StreamSentenceExtractor — 响应式流式断句管道", () => {
	it("逐步 feed 能准确定位句末标点并输出句子", () => {
		const sentences: string[] = [];
		const extractor = new StreamSentenceExtractor((s) => sentences.push(s));

		extractor.feed("你好，");
		expect(sentences).toHaveLength(0); // 逗号未超过 25 字符阈值，不断句

		extractor.feed("你好，这是一个完整的句子。后续文本");
		expect(sentences).toHaveLength(1);
		expect(sentences[0]).toBe("你好，这是一个完整的句子。");

		extractor.feed("你好，这是一个完整的句子。后续文本已经结束！");
		expect(sentences).toHaveLength(2);
		expect(sentences[1]).toBe("后续文本已经结束！");
	});

	it("流式结束时 flush 输出尾部残余未闭合句子", () => {
		const sentences: string[] = [];
		const extractor = new StreamSentenceExtractor((s) => sentences.push(s));

		extractor.feed("第一句已闭合。未闭合的结尾");
		expect(sentences).toEqual(["第一句已闭合。"]);

		extractor.flush("第一句已闭合。未闭合的结尾");
		expect(sentences).toEqual(["第一句已闭合。", "未闭合的结尾"]);
	});

	it("自动剥离句子内的 Markdown 语法", () => {
		const sentences: string[] = [];
		const extractor = new StreamSentenceExtractor((s) => sentences.push(s));

		extractor.feed("这里包含 `code` 与 **粗体** 内容。");
		expect(sentences).toEqual(["这里包含 code 与 粗体 内容。"]);
	});
});
