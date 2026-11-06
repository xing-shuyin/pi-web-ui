import { describe, expect, it } from "vitest";
import {
	mapFileHits,
	mapPageHits,
	mapSkillHits,
	matchAtToken,
	mergeAtHits,
	normalizeAtHits,
	type AtHit,
	type SkillCommandLike,
} from "../../web/src/at-mention.js";

describe("matchAtToken", () => {
	it("行首 @ + 空 query 也触发（列出全部）", () => {
		expect(matchAtToken("@", 1)).toEqual({ start: 0, query: "" });
	});

	it("空白后触发，query 取到光标", () => {
		expect(matchAtToken("请看 @文", 5)).toEqual({ start: 3, query: "文" });
	});

	it("CJK 无空格书写可触发（看不是 ASCII 单词字符）", () => {
		expect(matchAtToken("请看@文件", 5)).toEqual({ start: 2, query: "文件" });
	});

	it("邮箱不触发（@ 前是 ASCII 字母）", () => {
		expect(matchAtToken("mail@test", 9)).toBeNull();
		expect(matchAtToken("a@b", 3)).toBeNull();
	});

	it("数字下划线之后不触发", () => {
		expect(matchAtToken("v2@test", 7)).toBeNull();
		expect(matchAtToken("a_@b", 4)).toBeNull();
	});

	it("空白隔开的第二个 @ 只认后一个；紧贴字母的 @ 按邮箱拒", () => {
		expect(matchAtToken("@a @b", 5)).toEqual({ start: 3, query: "b" });
		expect(matchAtToken("@a@b", 4)).toBeNull();
	});

	it("query 含空格即关闭（trailing space 回车发送）", () => {
		expect(matchAtToken("@ab ", 4)).toBeNull();
		expect(matchAtToken("@a b", 4)).toBeNull();
	});

	it("光标不在词元后即无触发", () => {
		expect(matchAtToken("hi @ab", 3)).toBeNull();
		expect(matchAtToken("no at here", 5)).toBeNull();
	});

	it("括号引号后可触发", () => {
		expect(matchAtToken("(@x", 3)).toEqual({ start: 1, query: "x" });
		expect(matchAtToken("「@y」", 3)).toEqual({ start: 1, query: "y" });
		expect(matchAtToken("（@z", 3)).toEqual({ start: 1, query: "z" });
	});

	describe("normalizeAtHits", () => {
		it("坏字段逐条丢弃，好条目保留", () => {
			const out = normalizeAtHits("p", "P", [
				{ title: "a", hint: "h", text: "A ", attachments: [{ path: "/x", mode: "inline" }] },
				{ title: "  " },
				"nope",
				{ title: "b", attachments: [{ nope: 1 }, { path: "/y", mode: "bogus" }] },
			]);
			expect(out).toHaveLength(2);
			expect(out[0]).toMatchObject({ providerId: "p", title: "a", text: "A " });
			expect(out[0]?.attachments).toHaveLength(1);
			expect(out[1]?.attachments?.[0]).toMatchObject({ path: "/y" });
			expect(out[1]?.attachments?.[0]).not.toHaveProperty("mode");
		});

		it("非数组/超限截断", () => {
			expect(normalizeAtHits("p", "P", null)).toEqual([]);
			expect(normalizeAtHits("p", "P", [1, 2, 3], 2)).toEqual([]);
		});
	});

	describe("mapFileHits", () => {
		it("文件/目录映射为引用 chip 命中", () => {
			const out = mapFileHits("文件", [
				{ path: "src/a.ts", name: "a.ts", type: "file" },
				{ path: "src", name: "src", type: "dir" },
				{ path: "", name: "x", type: "file" },
			]);
			expect(out).toHaveLength(2);
			expect(out[0]).toMatchObject({ providerId: "host:files", title: "a.ts", text: "@src/a.ts" });
			expect(out[0]?.attachments?.[0]).toMatchObject({ path: "src/a.ts", mode: "reference" });
			expect(out[0]?.attachments?.[0]).not.toHaveProperty("isDir");
			expect(out[1]?.attachments?.[0]).toMatchObject({ isDir: true });
		});

		it("同名 basename 的两个条目正文互不混淆", () => {
			const out = mapFileHits("文件", [
				{ path: "报告", name: "报告", type: "dir" },
				{ path: "方案/报告", name: "报告", type: "dir" },
			]);
			expect(out[0]?.text).toBe("@报告");
			expect(out[1]?.text).toBe("@方案/报告");
			expect(out[0]?.text).not.toBe(out[1]?.text);
		});
	});

	describe("mapPageHits", () => {
		it("原生同源标签页保持各自tabId，扩展页保留origin", () => {
			const hits = mapPageHits(
				"Browser",
				[
					{ origin: "https://example.com", title: "First", open: true, tabId: "native-one" },
					{ origin: "https://example.com", title: "Second", open: true, tabId: "native-two" },
					{ origin: "https://extension.example", title: "Extension", open: true },
				],
				"",
			);
			expect(hits.map((hit) => hit.attachments?.[0]?.path)).toEqual([
				"native-one",
				"native-two",
				"https://extension.example",
			]);
			expect(hits[0].hint).toBe("https://example.com");
		});

		it("标题/origin 双字段过滤，无标题回落 origin", () => {
			const pages = [
				{ origin: "https://example.com", title: "Example", open: true },
				{ origin: "https://closed.dev", title: "", open: false },
				{ origin: "", title: "坏" },
			];
			const out = mapPageHits("浏览器操作", pages, "exam");
			expect(out).toHaveLength(1);
			expect(out[0]).toMatchObject({ providerId: "host:pages", title: "page · Example", text: "Example" });
			expect(out[0]?.attachments?.[0]).toMatchObject({ path: "https://example.com", mode: "page" });
			const all = mapPageHits("浏览器操作", pages, "");
			expect(all).toHaveLength(1);
			expect(all[0]?.hint).toBe("https://example.com");
			expect(mapPageHits("浏览器操作", pages, "page")).toHaveLength(1);
			expect(mapPageHits("浏览器操作", pages, "页面")).toHaveLength(1);
			expect(mapPageHits("浏览器操作", pages, "pag")).toHaveLength(0);
			expect(mapPageHits("浏览器操作", pages, "CLOSED")).toHaveLength(0);
		});
	});

	describe("mapSkillHits", () => {
		const commands: SkillCommandLike[] = [
			{
				name: "skill:wrapup",
				source: "skill",
				description: "收尾当前会话",
				descriptionEn: "Wrap up the current session",
			},
			{ name: "skill:analyze", source: "skill", description: "深度代码分析", descriptionEn: "Deep repo analysis" },
			{ name: "exit", source: "extension", description: "Exit pi" },
			{ name: "skill:review", source: "skill" },
			{ name: "bare-skill", source: "skill", description: "No prefix skill" },
			{ name: "skill:code-helper", source: "skill", description: "A skill that helps with code" },
			{ name: "skill:helper-with-long-desc", source: "skill", description: "Contains word code in description" },
		];

		it("提取 bareName，生成正确的 @skill:<name> 文本，排除非 skill 命令", () => {
			const out = mapSkillHits("Skills", commands, "");
			expect(out).toHaveLength(6);
			expect(out[0]).toMatchObject({
				providerId: "host:skills",
				providerLabel: "Skills",
				title: "wrapup",
				hint: "收尾当前会话",
				text: "@skill:wrapup",
			});
			expect(out[1]?.title).toBe("analyze");
			expect(out[1]?.text).toBe("@skill:analyze");
			expect(out[2]?.title).toBe("review");
			expect(out[2]?.hint).toBe("Skill review");
			expect(out[3]?.title).toBe("bare-skill");
			expect(out[3]?.text).toBe("@skill:bare-skill");
		});

		it("支持以 skill: 为前缀的 query（含空 cleanQ），正确去除前缀匹配", () => {
			const outPrefix = mapSkillHits("Skills", commands, "skill:ana");
			expect(outPrefix).toHaveLength(1);
			expect(outPrefix[0]?.title).toBe("analyze");

			const outBarePrefix = mapSkillHits("Skills", commands, "skill:");
			expect(outBarePrefix).toHaveLength(6);
		});

		it("相关性排序：名称匹配优先于描述匹配，防止描述泛匹配挤占名称命中", () => {
			const out = mapSkillHits("Skills", commands, "code");
			expect(out.length).toBeGreaterThanOrEqual(2);
			expect(out[0]?.title).toBe("code-helper");
			expect(out[1]?.title).toBe("helper-with-long-desc");
		});

		it("按 bareName 或中英文 description 过滤，短查询仅匹配名称", () => {
			const byName = mapSkillHits("Skills", commands, "wrap");
			expect(byName).toHaveLength(1);
			expect(byName[0]?.title).toBe("wrapup");

			const byDescEn = mapSkillHits("Skills", commands, "repo");
			expect(byDescEn).toHaveLength(1);
			expect(byDescEn[0]?.title).toBe("analyze");

			const byResolver = mapSkillHits("Skills", commands, "session", 15, (c) => c.descriptionEn ?? "");
			expect(byResolver).toHaveLength(1);
			expect(byResolver[0]?.hint).toBe("Wrap up the current session");

			const shortDesc = mapSkillHits("Skills", commands, "se");
			expect(shortDesc).toHaveLength(0);
		});

		it("超出 limit 时正确截断，limit <= 0 返回空数组", () => {
			const out = mapSkillHits("Skills", commands, "", 2);
			expect(out).toHaveLength(2);

			const outZero = mapSkillHits("Skills", commands, "", 0);
			expect(outZero).toEqual([]);
		});
	});

	describe("mergeAtHits", () => {
		const pageHit: AtHit = { providerId: "host:pages", providerLabel: "Pages", title: "page · GitHub" };
		const skillHit: AtHit = {
			providerId: "host:skills",
			providerLabel: "Skills",
			title: "wrapup",
			text: "@skill:wrapup",
		};
		const fileHit: AtHit = { providerId: "host:files", providerLabel: "Files", title: "readme.md" };
		const pluginHit: AtHit = { providerId: "p1", providerLabel: "Plugin", title: "item" };

		it("Rule 1: ALL_PAGES_TRIGGERS 命中时 pages 置顶", () => {
			const merged = mergeAtHits(
				{ pages: [pageHit], skills: [skillHit], files: [fileHit], plugins: [pluginHit] },
				"page",
			);
			expect(merged.map((m) => m.providerId)).toEqual(["host:pages", "host:skills", "host:files", "p1"]);
		});

		it("Rule 2: query 以 skill: 开头时 skills 置顶", () => {
			const merged = mergeAtHits(
				{ pages: [pageHit], skills: [skillHit], files: [fileHit], plugins: [pluginHit] },
				"skill:wr",
			);
			expect(merged.map((m) => m.providerId)).toEqual(["host:skills", "host:pages", "host:files", "p1"]);
		});

		it("Rule 3: 默认顺序 pages -> skills -> files -> plugins，缺省 totalCap 为 30，支持空 bucket", () => {
			const merged = mergeAtHits(
				{ pages: [pageHit], skills: [skillHit], files: [fileHit], plugins: [pluginHit] },
				"test",
			);
			expect(merged).toHaveLength(4);
			expect(merged.map((m) => m.providerId)).toEqual(["host:pages", "host:skills", "host:files", "p1"]);

			const thirtyFiveSkills: AtHit[] = Array.from({ length: 35 }, (_, idx) => ({
				providerId: "host:skills",
				providerLabel: "Skills",
				title: `skill-${idx}`,
			}));
			const defaultCapped = mergeAtHits({ skills: thirtyFiveSkills }, "query");
			expect(defaultCapped).toHaveLength(30);

			const capped = mergeAtHits(
				{ pages: [pageHit], skills: [skillHit], files: [fileHit], plugins: [pluginHit] },
				"test",
				2,
			);
			expect(capped).toHaveLength(2);

			const empty = mergeAtHits({}, "test");
			expect(empty).toHaveLength(0);
		});
	});

	it("cursor 越界钳制不抛错", () => {
		expect(matchAtToken("@ab", 99)).toEqual({ start: 0, query: "ab" });
		expect(matchAtToken("@ab", -5)).toBeNull();
		expect(matchAtToken("", 0)).toBeNull();
	});
});
