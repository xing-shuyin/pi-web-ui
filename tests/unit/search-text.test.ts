import { describe, expect, it } from "vitest";
import { buildSearchHits, countOccurrences, messageSearchText, type SearchMessage } from "../../web/src/search-text.js";

function msg(partial: Partial<SearchMessage> & Pick<SearchMessage, "id" | "role">): SearchMessage {
	return { content: [], ...partial };
}

describe("messageSearchText", () => {
	it("拼接 text / thinking / toolCall / bash 各块", () => {
		const m = msg({
			id: "a1",
			role: "assistant",
			content: [
				{ type: "text", text: "你好世界" },
				{ type: "thinking", thinking: "内部推理" },
				{
					type: "toolCall",
					id: "t1",
					name: "read",
					argumentsText: '{"path":"src/app.ts"}',
				},
				{ type: "bash", command: "ls -la", output: "total 0" },
			] as SearchMessage["content"],
		});
		const text = messageSearchText(m);
		expect(text).toContain("你好世界");
		expect(text).toContain("内部推理");
		expect(text).toContain("read");
		expect(text).toContain("src/app.ts");
		expect(text).toContain("ls -la");
		expect(text).toContain("total 0");
	});

	it("toolResult 消息不进索引（无 DOM 跳转目标）", () => {
		const m = msg({
			id: "t-1",
			role: "toolResult",
			content: [{ type: "text", text: "工具输出内容" }],
		});
		expect(messageSearchText(m)).toBe("");
	});

	it("errorMessage 也参与搜索", () => {
		const m = msg({
			id: "a2",
			role: "assistant",
			errorMessage: "boom 爆炸",
		});
		expect(messageSearchText(m)).toContain("爆炸");
	});
});

describe("countOccurrences", () => {
	it("大小写不敏感且统计重叠外的全部出现", () => {
		expect(countOccurrences("Ab ab AB", "ab")).toBe(3);
		expect(countOccurrences("aaaa", "aa")).toBe(2);
	});
	it("空 needle 返回 0", () => {
		expect(countOccurrences("abc", "")).toBe(0);
	});
});

describe("buildSearchHits", () => {
	it("按对话顺序展开为每处命中一个条目", () => {
		const messages = [
			msg({ id: "u1", role: "user", content: [{ type: "text", text: "foo bar foo" }] }),
			msg({ id: "a1", role: "assistant", content: [{ type: "text", text: "no match" }] }),
			msg({ id: "u2", role: "user", content: [{ type: "text", text: "FOO here" }] }),
		];
		const hits = buildSearchHits(messages, "foo");
		expect(hits).toEqual([
			{ messageId: "u1", occurrence: 0 },
			{ messageId: "u1", occurrence: 1 },
			{ messageId: "u2", occurrence: 0 },
		]);
	});

	it("空查询返回空列表；前后空白忽略", () => {
		const messages = [msg({ id: "u1", role: "user", content: [{ type: "text", text: "abc" }] })];
		expect(buildSearchHits(messages, "")).toEqual([]);
		expect(buildSearchHits(messages, "  ")).toEqual([]);
		expect(buildSearchHits(messages, " abc ")).toHaveLength(1);
	});

	it("跳过 toolResult 与无内容消息", () => {
		const messages = [
			msg({ id: "t1", role: "toolResult", content: [{ type: "text", text: "abc abc" }] }),
			msg({ id: "a1", role: "assistant", content: [] }),
			msg({ id: "u1", role: "user", content: [{ type: "text", text: "ABC" }] }),
		];
		expect(buildSearchHits(messages, "abc")).toEqual([{ messageId: "u1", occurrence: 0 }]);
	});
});
