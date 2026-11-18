import { describe, expect, it } from "vitest";
import {
	BOOKMARK_MAX_NODES,
	decodeEntities,
	mergeBookmarks,
	parseBookmarks,
	parseJsonBookmarks,
	parseNetscapeBookmarks,
} from "../../browser/runtime/bookmarks-import.js";
import type { Bookmark } from "../../browser/storage/index.js";

/** Chrome / Edge / Firefox 导出格式的最小真实样本（大小写与属性写法都照抄各家的实际输出）。 */
const CHROME_HTML = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file. -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1700000000" LAST_MODIFIED="1700000100" PERSONAL_TOOLBAR_FOLDER="true">书签栏</H3>
    <DL><p>
        <DT><A HREF="https://example.com/?a=1&amp;b=2" ADD_DATE="1700000001" ICON="data:image/png;base64,iVBORw0KGgo=">Example &amp; Co</A>
        <DT><H3 ADD_DATE="1700000002">Docs</H3>
        <DL><p>
            <DT><A HREF='https://docs.example.com/guide'>Guide &#39;25</A>
            <DD>a description that must be ignored
            <DT><A HREF="javascript:alert(1)">Bad script</A>
            <DT><A HREF="https://user:pass@secret.example.com/">Credentialed</A>
            <DT><A>No href</A>
        </DL><p>
        <DT><H3>Empty folder</H3>
        <DL><p>
        </DL><p>
    </DL><p>
    <DT><A HREF="https://blog.example.com">Blog</A>
</DL><p>
`;

describe("decodeEntities", () => {
	it("decodes named and numeric entities, keeps unknown ones", () => {
		expect(decodeEntities("a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &#x4E2D; &bogus;")).toBe(
			"a & b <c> \"d\" 'e' 中 &bogus;",
		);
		expect(decodeEntities("no entities")).toBe("no entities");
		expect(decodeEntities("&#0; &#x110000;")).toBe("&#0; &#x110000;");
	});
});

describe("parseNetscapeBookmarks", () => {
	it("rebuilds the folder tree, decodes entities and skips unusable links", () => {
		const parsed = parseNetscapeBookmarks(CHROME_HTML);
		expect(parsed.nodes).toEqual([
			{
				name: "书签栏",
				type: "folder",
				children: [
					{ name: "Example & Co", type: "link", url: "https://example.com/?a=1&b=2" },
					{
						name: "Docs",
						type: "folder",
						children: [{ name: "Guide '25", type: "link", url: "https://docs.example.com/guide" }],
					},
				],
			},
			{ name: "Blog", type: "link", url: "https://blog.example.com" },
		]);
		// javascript: / 带账号密码 / 没有 href 的三条算 skipped，空文件夹直接丢掉不计数
		expect(parsed.skipped).toBe(3);
	});

	it("tolerates unclosed tags and attribute values with spaces", () => {
		const parsed = parseNetscapeBookmarks(
			`<DL><DT><H3>Tools</H3><DL><DT><A TITLE="a b c" HREF = "https://tools.example.com/">Tool</A></DL>`,
		);
		expect(parsed.nodes).toEqual([
			{
				name: "Tools",
				type: "folder",
				children: [{ name: "Tool", type: "link", url: "https://tools.example.com/" }],
			},
		]);
	});

	it("falls back to the URL when a title is empty and truncates a runaway title", () => {
		const parsed = parseNetscapeBookmarks(`<DL><DT><A HREF="https://a.example.com"></A></DL>`);
		expect(parsed.nodes).toEqual([{ name: "https://a.example.com", type: "link", url: "https://a.example.com" }]);
		// 截断的导出文件里 `</A>` 可能整个缺失：名字不能因此变成文件剩下的一半
		const runaway = parseNetscapeBookmarks(`<DL><DT><A HREF="https://b.example.com">${"x".repeat(4000)}</A></DL>`);
		expect(runaway.nodes[0].name).toHaveLength(512);
	});

	it("caps the node count instead of trusting the file", () => {
		const many = Array.from(
			{ length: BOOKMARK_MAX_NODES + 5 },
			(_, index) => `<DT><A HREF="https://x${index}.example.com">x${index}</A>`,
		);
		const parsed = parseNetscapeBookmarks(`<DL>${many.join("")}</DL>`);
		expect(parsed.nodes).toHaveLength(BOOKMARK_MAX_NODES);
		expect(parsed.skipped).toBe(5);
	});

	it("returns nothing for text that is not a bookmark file", () => {
		expect(parseNetscapeBookmarks("just text, no bookmarks")).toEqual({ nodes: [], skipped: 0 });
	});
});

describe("parseJsonBookmarks", () => {
	it("reads the browser's own tree shape", () => {
		const parsed = parseJsonBookmarks({
			name: "全部收藏",
			type: "folder",
			children: [
				{ name: "Work", type: "folder", children: [{ name: "W", type: "link", url: "https://w.example.com" }] },
				{ name: "Broken", type: "link", url: "chrome://settings" },
			],
		});
		expect(parsed.nodes).toEqual([
			{ name: "Work", type: "folder", children: [{ name: "W", type: "link", url: "https://w.example.com" }] },
		]);
		expect(parsed.skipped).toBe(1);
	});

	it("reads Chrome's Bookmarks data file", () => {
		const parsed = parseJsonBookmarks({
			checksum: "x",
			roots: {
				bookmark_bar: {
					children: [{ type: "url", name: "Bar", url: "https://bar.example.com/" }],
					name: "Bookmarks bar",
					type: "folder",
				},
				other: {
					children: [{ type: "url", name: "Other", url: "https://other.example.com/" }],
					name: "Other bookmarks",
					type: "folder",
				},
			},
		});
		expect(parsed.nodes).toEqual([
			{
				name: "Bookmarks bar",
				type: "folder",
				children: [{ name: "Bar", type: "link", url: "https://bar.example.com/" }],
			},
			{
				name: "Other bookmarks",
				type: "folder",
				children: [{ name: "Other", type: "link", url: "https://other.example.com/" }],
			},
		]);
	});

	it("reads Firefox's JSON backup (uri + text/x-moz-place types)", () => {
		const parsed = parseJsonBookmarks({
			type: "text/x-moz-place-container",
			title: "",
			children: [
				{
					type: "text/x-moz-place-container",
					title: "Mobile",
					children: [
						{ type: "text/x-moz-place", title: "Firefox", uri: "https://firefox.example.com" },
						{ type: "text/x-moz-place-separator" },
					],
				},
			],
		});
		expect(parsed.nodes).toEqual([
			{
				name: "Mobile",
				type: "folder",
				children: [{ name: "Firefox", type: "link", url: "https://firefox.example.com" }],
			},
		]);
		expect(parsed.skipped).toBe(1);
	});
});

describe("parseBookmarks", () => {
	it("dispatches on the first character and tolerates a BOM", () => {
		expect(parseBookmarks(`\uFEFF[{"name":"A","url":"https://a.example.com"}]`).nodes).toEqual([
			{ name: "A", type: "link", url: "https://a.example.com" },
		]);
		expect(parseBookmarks(CHROME_HTML).nodes).toHaveLength(2);
	});

	it("rejects a broken JSON file instead of silently reading nothing", () => {
		expect(() => parseBookmarks(`{"roots": `)).toThrow(/not valid JSON/i);
	});
});

describe("mergeBookmarks", () => {
	const existing: Bookmark[] = [
		{ name: "Work", type: "folder", children: [{ name: "A", type: "link", url: "https://a.example.com/" }] },
	];

	it("merges into the root directly when the tree is empty", () => {
		const result = mergeBookmarks([], [{ name: "A", type: "link", url: "https://a.example.com" }]);
		expect(result).toEqual({
			children: [{ name: "A", type: "link", url: "https://a.example.com" }],
			imported: 1,
			duplicate: 0,
			skipped: 0,
		});
	});

	it("wraps into one dated folder, ignoring trailing slashes and in-file repeats", () => {
		const result = mergeBookmarks(
			existing,
			[
				{ name: "A again", type: "link", url: "https://a.example.com" },
				{ name: "B", type: "link", url: "https://b.example.com" },
				{ name: "B dup", type: "link", url: "https://b.example.com/" },
				{
					name: "Folder",
					type: "folder",
					children: [
						{ name: "C", type: "link", url: "https://c.example.com" },
						{ name: "Empty", type: "folder", children: [] },
					],
				},
			],
			{ folderName: " 导入的书签 2026/2/3 " },
		);
		expect(result.children).toEqual([
			...existing,
			{
				name: "导入的书签 2026/2/3",
				type: "folder",
				children: [
					{ name: "B", type: "link", url: "https://b.example.com" },
					{
						name: "Folder",
						type: "folder",
						children: [{ name: "C", type: "link", url: "https://c.example.com" }],
					},
				],
			},
		]);
		expect(result.imported).toBe(2);
		expect(result.duplicate).toBe(2);
		expect(result.skipped).toBe(0);
	});

	it("leaves the tree untouched when nothing can be added", () => {
		const result = mergeBookmarks(existing, [{ name: "A", type: "link", url: "https://a.example.com" }], {
			folderName: "导入的书签",
		});
		expect(result.children).toEqual(existing);
		expect(result.imported).toBe(0);
		expect(result.duplicate).toBe(1);
	});

	it("counts invalid links as skipped and never mutates the input", () => {
		const snapshot = structuredClone(existing);
		const result = mergeBookmarks(existing, [{ name: "Bad", type: "link", url: "place:sort=8" }]);
		expect(result.imported).toBe(0);
		expect(result.skipped).toBe(1);
		expect(existing).toEqual(snapshot);
	});
});
