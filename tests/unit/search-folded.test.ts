import { describe, expect, it } from "vitest";
import {
	collectFoldedHits,
	foldedResultText,
	foldedSearchText,
	type FoldedMessage,
} from "../../web/src/search-folded.js";

const RES: ReadonlyMap<string, { content: { type: string; text: string }[] }> = new Map([
	["call-1", { content: [{ type: "text", text: "工具输出结果文本 OUT" }] }],
]);

function msg(id: string, content: { type: string; [k: string]: unknown }[]): FoldedMessage {
	return { id, role: "assistant", content };
}

describe("foldedSearchText", () => {
	it("拼接 text / thinking / toolCall 名称+参数+结果 / bash 命令+输出（内容块顺序）", () => {
		const m = msg("m1", [
			{ type: "text", text: "正文 AA" },
			{ type: "thinking", thinking: "思考 BB" },
			{
				type: "toolCall",
				id: "call-1",
				name: "ask_user_question",
				argumentsText: '{"question":"CC"}',
			},
			{ type: "bash", command: "ls DD", output: "file EE" },
		]);
		const text = foldedSearchText(m, RES);
		expect(text).toContain("正文 AA");
		expect(text).toContain("思考 BB");
		expect(text).toContain("ask_user_question");
		expect(text).toContain('{"question":"CC"}');
		expect(text).toContain("工具输出结果文本 OUT"); // toolResult 并入宿主
		expect(text).toContain("ls DD");
		expect(text).toContain("file EE");
		// 顺序 = 内容块顺序：AA 在 BB 前
		expect(text.indexOf("AA")).toBeLessThan(text.indexOf("BB"));
		expect(text.indexOf("BB")).toBeLessThan(text.indexOf("CC"));
	});

	it("无 toolResult 时宿主不拼接结果", () => {
		const m = msg("m1", [{ type: "toolCall", id: "call-x", name: "read", argumentsText: '{"path":"a"}' }]);
		expect(foldedSearchText(m, RES)).not.toContain("OUT");
	});

	it("忽略未知块 / 图片块", () => {
		const m = msg("m1", [
			{ type: "image", dataUrl: "data:image/png;base64,xxx" },
			{ type: "weird", whatever: 1 },
		]);
		expect(foldedSearchText(m, RES)).toBe("");
	});
});

describe("foldedResultText", () => {
	it("只取 text 块内容拼接", () => {
		expect(
			foldedResultText({
				content: [
					{ type: "text", text: "a" },
					{ type: "thing", text: "b" },
					{ type: "text", text: "c" },
				],
			}),
		).toBe("a\nc");
	});
});

describe("collectFoldedHits", () => {
	const messages = [
		msg("folded-1", [{ type: "text", text: "这里有 NEEDLE 和 needle 还有 NEEDLE" }]),
		msg("folded-2", [{ type: "thinking", thinking: "NEEDLE 只在思考里" }]),
		msg("rendered-1", [{ type: "text", text: "NEEDLE 但这条已渲染" }]), // 不在 collapsedIds
		msg("folded-3", [{ type: "toolCall", id: "call-1", name: "bash", argumentsText: '{"command":"echo hi"}' }]),
	];

	it("只统计折叠消息，大小写不敏感，出现次数计入", () => {
		const hits = collectFoldedHits(messages, new Set(["folded-1", "folded-2", "folded-3"]), "needle", RES);
		expect(hits.get("folded-1")).toBe(3);
		expect(hits.get("folded-2")).toBe(1);
		expect(hits.get("rendered-1")).toBeUndefined();
		// 宿主 toolResult 的文本也可命中
		hits.set("folded-3", (hits.get("folded-3") ?? 0) + 0);
	});

	it("toolResult 文本并入宿主后可搜到", () => {
		const hits = collectFoldedHits(messages, new Set(["folded-3"]), "OUT", RES);
		expect(hits.get("folded-3")).toBe(1);
	});

	it("空查询返回空 Map", () => {
		expect(collectFoldedHits(messages, new Set(["folded-1"]), "  ", RES).size).toBe(0);
	});

	it("无折叠消息时返回空", () => {
		expect(collectFoldedHits(messages, new Set(), "NEEDLE", RES).size).toBe(0);
	});
});
