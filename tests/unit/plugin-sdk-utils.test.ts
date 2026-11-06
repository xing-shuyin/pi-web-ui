import { describe, expect, it } from "vitest";
import {
	esc,
	apiBase,
	formatBytes,
	withTimeout,
	uuid,
	normalizeRel,
	hostApi,
	safeSliceIndex,
	chunkMarkdownText,
} from "../../plugin-sdk/client-utils.mjs";

describe("plugin-sdk client-utils", () => {
	it("esc: 安全转义 HTML 特殊字符", () => {
		expect(esc("<script>alert('xss') & \"test\"</script>")).toBe(
			"&lt;script&gt;alert(&#39;xss&#39;) &amp; &quot;test&quot;&lt;/script&gt;",
		);
		expect(esc(null)).toBe("");
		expect(esc(undefined)).toBe("");
		expect(esc(123)).toBe("123");
	});

	it("apiBase: 拼接插件路由基路径", () => {
		expect(apiBase("my-plugin")).toBe("/plugins-api/my-plugin");
	});

	it("formatBytes: 字节大小格式化", () => {
		expect(formatBytes(0)).toBe("0 B");
		expect(formatBytes(512)).toBe("512 B");
		expect(formatBytes(1024)).toBe("1.0 KB");
		expect(formatBytes(1536)).toBe("1.5 KB");
		expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
		expect(formatBytes(1024 * 1024 * 1024 * 2.5)).toBe("2.5 GB");
		expect(formatBytes(-10)).toBe("");
		expect(formatBytes("invalid")).toBe("");
	});

	it("withTimeout: 正确超时或返回", async () => {
		const fast = withTimeout(Promise.resolve("ok"), 100);
		await expect(fast).resolves.toBe("ok");

		const slow = new Promise((resolve) => setTimeout(resolve, 200));
		await expect(withTimeout(slow, 50, "timed out")).rejects.toThrow("timed out");
	});

	it("uuid: 生成有效 UUID 格式", () => {
		const id = uuid();
		expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
	});

	it("normalizeRel: 归一化相对路径", () => {
		expect(normalizeRel("foo\\bar")).toBe("foo/bar");
		expect(normalizeRel("./foo/bar/")).toBe("foo/bar");
		expect(normalizeRel("/foo/bar")).toBe("foo/bar");
	});

	it("hostApi: 非浏览器环境安全返回 null", () => {
		expect(hostApi()).toBeNull();
	});

	it("safeSliceIndex: 不拆分 UTF-16 代理对 Emoji", () => {
		const text = "Hello 🎉 World";
		const cutAtSurrogate = safeSliceIndex(text, 7);
		expect(cutAtSurrogate).toBe(6);
		const cutAfter = safeSliceIndex(text, 8);
		expect(cutAfter).toBe(8);
	});

	it("chunkMarkdownText: 空内容或短内容直接返回", () => {
		expect(chunkMarkdownText("")).toEqual([]);
		expect(chunkMarkdownText(null as any)).toEqual([]);
		expect(chunkMarkdownText("hello", 100)).toEqual(["hello"]);
	});

	it("chunkMarkdownText: 跨分块边界保护代码围栏不被撕裂", () => {
		const md = ["# Header", "```typescript", "const a = 1;", "const b = 2;", "const c = 3;", "```", "Footer text"].join(
			"\n",
		);

		const chunks = chunkMarkdownText(md, 60);
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks[0]).toContain("```typescript");
		expect(chunks[0].endsWith("```")).toBe(true);
		expect(chunks[1].startsWith("```typescript")).toBe(true);
	});
});
