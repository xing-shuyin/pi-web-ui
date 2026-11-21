import { describe, expect, it } from "vitest";
import {
	browserReferenceAttachments,
	BROWSER_QUOTE_MAX_CHARS,
	BROWSER_REFERENCE_TITLE_MAX_CHARS,
	cleanSelectedText,
	shortenReferenceTitle,
} from "../../web/src/browser-tab-reference.js";

describe("标签页 → 输入框的引用", () => {
	it("落成页面 chip（不是一段文字），标题进 name、原标签 id 进 path", () => {
		const [page] = browserReferenceAttachments({
			title: "Example",
			url: "https://example.com/a",
			tabId: "tab-1",
		});
		expect(page).toMatchObject({ mode: "page", name: "Example", path: "tab-1", key: "page:tab-1" });
		expect(browserReferenceAttachments({ url: "https://example.com/a" })[0]).toMatchObject({
			mode: "page",
			path: "https://example.com/a",
			name: "https://example.com/a",
		});
	});

	it("内部页 / 相对地址什么都不加", () => {
		expect(browserReferenceAttachments({ title: "新标签页", url: "" })).toEqual([]);
		expect(browserReferenceAttachments({ title: "x", url: "about:blank" })).toEqual([]);
		expect(browserReferenceAttachments({ title: "x", url: "file:///C:/a.html" })).toEqual([]);
	});

	it("标题里的空白压成一行；标题就是地址时当没有标题", () => {
		expect(browserReferenceAttachments({ title: "  a\n b ", url: "https://x.dev" })[0].name).toBe("a b");
		expect(browserReferenceAttachments({ title: "https://x.dev", url: "https://x.dev" })[0].name).toBe("https://x.dev");
	});

	it("页面里选中了文字：页面 chip + 引用 chip（角色 page，卡片显示「网页」）", () => {
		const attachments = browserReferenceAttachments({
			title: "文档",
			url: "https://x.dev/a",
			tabId: "tab-9",
			text: "第一行\n第二行",
		});
		expect(attachments).toHaveLength(2);
		expect(attachments[0]).toMatchObject({ mode: "page", path: "tab-9" });
		expect(attachments[1].mode).toBe("quote");
		expect(attachments[1].quote).toMatchObject({
			text: "第一行\n第二行",
			role: "page",
			messageId: "page:tab-9",
		});
	});

	it("选段去行尾空白与首尾空行；空白选段只留页面 chip", () => {
		expect(cleanSelectedText("  \n第一行   \n\n第二行\n\n")).toBe("第一行\n\n第二行");
		expect(cleanSelectedText("   \n\n ")).toBe("");
		expect(browserReferenceAttachments({ url: "https://x.dev", text: " \n " })).toHaveLength(1);
	});

	it("超长选段按行边界截断并标注，不把半行丢给模型", () => {
		const line = "a".repeat(80);
		const cleaned = cleanSelectedText(Array.from({ length: 200 }, () => line).join("\n"), 200);
		const lines = cleaned.split("\n");
		expect(lines.length).toBeGreaterThan(1);
		// 除最后一行外都是整行（截断只发生在行边界），最后一行是残行 + 截断标注
		expect(lines.slice(0, -1).every((item) => item === line)).toBe(true);
		expect(cleaned.endsWith("…（已截断）")).toBe(true);
		expect(cleaned.length).toBeLessThanOrEqual(200 + "…（已截断）".length);
		expect(BROWSER_QUOTE_MAX_CHARS).toBe(6000);
	});

	it("超长的网页标题按标签长度截断（整条 PR 标题不铺满输入框）", () => {
		const long =
			"fix(bg-servers): 停止后台任务时等待进程真正退出，失败则保留条目并报错 (#974) by JSJ189 · Pull Request #984 · xing-shuyin/pi-web-ui";
		const short = shortenReferenceTitle(long);
		expect(short.length).toBe(BROWSER_REFERENCE_TITLE_MAX_CHARS + 1);
		expect(short.endsWith("…")).toBe(true);
		expect(long.startsWith(short.slice(0, -1))).toBe(true);
		expect(shortenReferenceTitle("简短标题")).toBe("简短标题");
		// 截断后不把结尾的空白 / 分隔符留在省略号前
		expect(shortenReferenceTitle("abcd ,", 3)).toBe("abc…");
		const [page] = browserReferenceAttachments({ title: long, url: "https://github.com/x/y/pull/984", tabId: "t" });
		expect(page.name).toBe(short);
		expect(String(page.path)).toBe("t");
	});
});
