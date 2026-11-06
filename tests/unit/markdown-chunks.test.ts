import { describe, expect, it } from "vitest";
import { chunkMarkdownText, safeSliceIndex } from "../../plugins/feishu/markdown-chunks.mjs";

describe("Markdown 结构感知分块测试 (chunkMarkdownText)", () => {
	it("空文本或短文本直接返回原数组", () => {
		expect(chunkMarkdownText("")).toEqual([]);
		expect(chunkMarkdownText(null as unknown as string)).toEqual([]);
		expect(chunkMarkdownText("Hello world", 100)).toEqual(["Hello world"]);
	});

	it("长纯文本按行与自然段切分，不超过 limit", () => {
		const longText = Array.from({ length: 20 }, (_, i) => `Paragraph line ${i + 1} with some text content.`).join("\n");
		const chunks = chunkMarkdownText(longText, 150);

		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(160);
		}
		expect(chunks.join("\n")).toContain("Paragraph line 1");
		expect(chunks.join("\n")).toContain("Paragraph line 20");
	});

	it("跨边界的代码块自动闭合并在下一段重新开启", () => {
		const codeText = [
			"Here is some code:",
			"```typescript",
			"const a = 1;",
			"const b = 2;",
			"const c = a + b;",
			"console.log(c);",
			"```",
			"End of section.",
		].join("\n");

		const chunks = chunkMarkdownText(codeText, 60);
		expect(chunks.length).toBeGreaterThan(1);

		const first = chunks[0];
		expect(first).toContain("```typescript");
		expect(first.endsWith("```") || first.includes("```\n")).toBe(true);

		const second = chunks[1];
		expect(second.startsWith("```typescript")).toBe(true);
	});

	it("safeSliceIndex 避免切断代理对 (Surrogate Pairs 如 Emoji)", () => {
		const emojiText = "Hello 😊 World";
		const emojiIdx = emojiText.indexOf("😊");
		const safeIdx = safeSliceIndex(emojiText, emojiIdx + 1);
		expect(safeIdx).toBe(emojiIdx);
	});
});
