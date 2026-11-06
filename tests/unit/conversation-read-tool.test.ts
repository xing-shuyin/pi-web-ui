import { describe, expect, it } from "vitest";
import {
	filterHistory,
	filterRunning,
	formatClaimLines,
	formatTranscript,
	makeConversationReadTool,
	parseTranscriptLines,
	readExtraLines,
	selectReadMessages,
	shortPath,
	summarizeConversation,
	toTranscriptInput,
	transcriptText,
	truncateCounted,
	type ConversationReadHost,
	type TranscriptInputMessage,
} from "../../server/conversation-read-tool.js";

const MSGS: TranscriptInputMessage[] = [
	{ role: "user", content: "看看这个 bug" },
	{ role: "assistant", content: [{ type: "text", text: "好的" }] },
	{
		role: "assistant",
		content: [
			{ type: "toolCall", name: "bash" },
			{ type: "text", text: "跑一下" },
		],
	},
	{ role: "toolResult", toolName: "bash", content: [{ type: "text", text: "ok" }] },
	{ role: "bashExecution", command: "npm test", output: "pass" },
	{ role: "custom", content: [{ type: "text", text: "文件内容" }], details: { name: "a.ts", path: "a.ts" } },
	{ role: "compactionSummary", summary: "摘要" },
];

describe("transcriptText", () => {
	it("字符串内容原样", () => {
		expect(transcriptText(MSGS[0])).toBe("看看这个 bug");
	});
	it("assistant 文本块拼接 + 具名块留名", () => {
		expect(transcriptText(MSGS[1])).toBe("好的");
		expect(transcriptText(MSGS[2])).toBe("[tool call: bash]\n跑一下");
	});
	it("toolResult 带工具名", () => {
		expect(transcriptText(MSGS[3])).toBe("[tool result (bash)]\nok");
	});
	it("bash/摘要/custom 都有可读头", () => {
		expect(transcriptText(MSGS[4])).toContain("[bash $ npm test]");
		expect(transcriptText(MSGS[5])).toContain("[attachment: a.ts]");
		expect(transcriptText(MSGS[6])).toContain("[compaction summary]");
	});
	it("图片块占位不抛错", () => {
		expect(transcriptText({ role: "user", content: [{ type: "image" }] })).toBe("[image]");
	});
});

describe("formatTranscript", () => {
	it("序号 [i/total role] + 默认分页", () => {
		const f = formatTranscript(MSGS);
		expect(f.total).toBe(MSGS.length);
		expect(f.from).toBe(0);
		expect(f.to).toBe(MSGS.length);
		expect(f.truncated).toBe(false);
		expect(f.text).toContain("[1/7 user]");
		expect(f.text).toContain("[4/7 tool result (bash)]");
	});
	it("offset/limit 翻页 + truncated", () => {
		const f = formatTranscript(MSGS, { offset: 5, limit: 1 });
		expect(f.from).toBe(5);
		expect(f.to).toBe(6);
		expect(f.truncated).toBe(true);
		expect(f.text).toContain("[6/7");
		expect(f.text).not.toContain("[1/7");
	});
	it("limit 上限 200，maxChars 截断带标记", () => {
		const big: TranscriptInputMessage[] = Array.from({ length: 300 }, (_, i) => ({
			role: "user",
			content: `m${i}`,
		}));
		const f = formatTranscript(big, { limit: 500 });
		expect(f.to - f.from).toBe(200);
		const c = formatTranscript(big, { limit: 200, maxChars: 1000 });
		expect(c.truncated).toBe(true);
		expect(c.text).toContain("… [truncated]");
	});
	it("空转录", () => {
		const f = formatTranscript([]);
		expect(f.total).toBe(0);
		expect(f.text).toBe("");
		expect(f.truncated).toBe(false);
	});
});

describe("parseTranscriptLines", () => {
	it("message 取 message，compaction/branch 取 summary，坏行跳过", () => {
		const text = [
			JSON.stringify({ type: "session", id: "s1" }),
			JSON.stringify({ type: "message", message: { role: "user", content: "hi", timestamp: 1 } }),
			"not json {",
			"",
			JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "yo" }] } }),
			JSON.stringify({ type: "compaction", summary: "sum" }),
			JSON.stringify({ type: "branch_summary", summary: "b" }),
			JSON.stringify({ type: "thinking_level_change" }),
		].join("\n");
		const out = parseTranscriptLines(text);
		expect(out.map((m) => m.role)).toEqual(["user", "assistant", "compactionSummary", "branchSummary"]);
		expect(out[0].content).toBe("hi");
		expect(out[2].summary).toBe("sum");
	});
});

describe("filterRunning / filterHistory / shortPath", () => {
	it("空 query 全返回，大小写不敏感", () => {
		const list = [
			{ id: "c1", title: "修 Bug", cwd: "/a", messageCount: 3, isStreaming: false, isSubagent: false },
			{ id: "c2", title: "Review", cwd: "/b", messageCount: 1, isStreaming: true, isSubagent: true },
		];
		expect(filterRunning(list, "")).toHaveLength(2);
		expect(filterRunning(list, "review")).toHaveLength(1);
		expect(filterRunning(list, "C1")).toHaveLength(1);
		expect(filterRunning(list, "zzz")).toHaveLength(0);
	});
	it("历史按 path/name/首条过滤", () => {
		const list = [{ path: "/s/1.jsonl", name: "买菜", firstMessage: "", messageCount: 2, modified: 1, cwd: "/a" }];
		expect(filterHistory(list, "买菜")).toHaveLength(1);
		expect(filterHistory(list, "1.jsonl")).toHaveLength(1);
		expect(filterHistory(list, "nope")).toHaveLength(0);
	});
	it("短路径截断", () => {
		expect(shortPath("abc")).toBe("abc");
		expect(shortPath("x".repeat(100), 10)).toBe(`…${"x".repeat(10)}`);
	});
});

describe("toolCalls additive 字段", () => {
	it("toTranscriptInput 与 parseTranscriptLines 都填 toolCalls，且格式化输出不变", () => {
		const live = toTranscriptInput({
			role: "assistant",
			content: [{ type: "toolCall", name: "edit", arguments: { path: "a.ts" } }],
		} as never);
		expect(live.toolCalls).toEqual([{ name: "edit", args: { path: "a.ts" } }]);
		expect(transcriptText(live)).toBe("[tool call: edit]");
		const hist = parseTranscriptLines(JSON.stringify({ type: "message", message: live }) + "\n");
		expect(hist[0].toolCalls).toEqual([{ name: "edit", args: { path: "a.ts" } }]);
		expect(transcriptText(hist[0])).toBe("[tool call: edit]");
	});
	it("无工具调用时不加字段", () => {
		expect(toTranscriptInput({ role: "user", content: "hi" } as never).toolCalls).toBeUndefined();
	});
});

describe("truncateCounted", () => {
	it("不超限原样，超限标剩余字符数", () => {
		expect(truncateCounted("abc", 10)).toBe("abc");
		expect(truncateCounted("abcdef", 4)).toBe("abcd\n… +2 chars");
	});
});

describe("selectReadMessages", () => {
	const MIXED: TranscriptInputMessage[] = [
		{ role: "user", content: "修 a.ts 的 bug" },
		{ role: "assistant", content: [{ type: "text", text: "好的" }] },
		{
			role: "assistant",
			content: [{ type: "toolCall", name: "edit", arguments: { path: "a.ts" } }],
			toolCalls: [{ name: "edit", args: { path: "a.ts" } }],
		},
		{ role: "toolResult", toolName: "edit", content: "ok" },
		{ role: "assistant", content: [{ type: "text", text: "修好了" }] },
	];
	it("默认 chat 视图只留 user/assistant（按角色，不过滤 toolCall 桩行）", () => {
		const sel = selectReadMessages(MIXED, {});
		expect(sel.totalInView).toBe(4);
		expect(sel.selected.map((m) => m.role)).toEqual(["user", "assistant", "assistant", "assistant"]);
	});
	it("full 视图全留", () => {
		const sel = selectReadMessages(MIXED, { view: "full" });
		expect(sel.totalInView).toBe(5);
		expect(sel.selected).toHaveLength(5);
	});
	it("last 取尾部（不用猜 offset）", () => {
		const sel = selectReadMessages(MIXED, { view: "full", last: 2 });
		expect(sel.selected.map((m) => transcriptText(m))).toEqual(["[tool result (edit)]\nok", "修好了"]);
	});
	it("query 只回命中 ±1 上下文并报原序号", () => {
		const sel = selectReadMessages(MIXED, { view: "full", query: "修好了" });
		expect(sel.hitIndices).toEqual([4]);
		expect(sel.selected).toHaveLength(2);
		expect(sel.selected[1]).toBe(MIXED[4]);
	});
	it("query 无命中给空", () => {
		const sel = selectReadMessages(MIXED, { query: "不存在的词串 xyz" });
		expect(sel.hitIndices).toEqual([]);
		expect(sel.selected).toEqual([]);
	});
	it("query 大小写不敏感；脏输入不抛错", () => {
		const sel = selectReadMessages(MIXED, { query: "BUG" });
		expect(sel.hitIndices).toEqual([0]);
		expect(sel.selected).toHaveLength(2);
		expect(selectReadMessages(null as never, {}).selected).toEqual([]);
	});
});

describe("summarizeConversation", () => {
	it("最后工具 + 最后一句 + 触碰走 extract（见 touches 单测）", () => {
		const sum = summarizeConversation([
			{ role: "user", content: "hi" },
			{
				role: "assistant",
				content: [{ type: "toolCall", name: "edit", arguments: { path: "a.ts" } }],
				toolCalls: [{ name: "edit", args: { path: "a.ts" } }],
			},
			{ role: "toolResult", toolName: "edit", content: "ok" },
			{ role: "assistant", content: [{ type: "text", text: "搞定" }] },
		]);
		expect(sum.lastTool).toEqual({ name: "edit", hint: "a.ts" });
		expect(sum.lastAssistant).toBe("搞定");
		expect(sum.waitingQuestion).toBe(false);
	});
	it("问卷调了没回 → waiting；回了 → 不等", () => {
		const asked: TranscriptInputMessage[] = [
			{
				role: "assistant",
				content: [{ type: "toolCall", name: "ask_user_question", arguments: {} }],
				toolCalls: [{ name: "ask_user_question", args: {} }],
			},
		];
		expect(summarizeConversation(asked).waitingQuestion).toBe(true);
		expect(
			summarizeConversation([...asked, { role: "toolResult", toolName: "ask_user_question", content: "a" }])
				.waitingQuestion,
		).toBe(false);
	});
	it("bashExecution 算最后工具；空转录全 undefined", () => {
		const sum = summarizeConversation([{ role: "bashExecution", command: "rm x", output: "" }]);
		expect(sum.lastTool).toEqual({ name: "bash", hint: "rm x" });
		const empty = summarizeConversation([]);
		expect(empty.lastTool).toBeUndefined();
		expect(empty.lastAssistant).toBeUndefined();
		expect(empty.waitingQuestion).toBe(false);
	});
});

describe("formatClaimLines", () => {
	it("bullets 独立成行；inline 行内；超量给计数；脏输入不抛错", () => {
		const claims = [
			{ path: "/r/a.ts", ownerTitle: "B", note: "改登录" },
			{ path: "/r/b.ts", ownerTitle: "C" },
		];
		expect(formatClaimLines(claims)).toEqual(["- /r/a.ts · 「B」 · 改登录", "- /r/b.ts · 「C」"]);
		expect(formatClaimLines(claims, 1, "inline")).toEqual(["/r/a.ts · 「B」 · 改登录", "… (+1)"]);
		expect(formatClaimLines(null as never)).toEqual([]);
	});
});

describe("files/status 认领与 sidecar 接线（execute 级）", () => {
	const MSGS: TranscriptInputMessage[] = [
		{ role: "user", content: "修一下" },
		{
			role: "assistant",
			content: [{ type: "toolCall", name: "edit", arguments: { path: "/r/new.ts" } }],
			toolCalls: [{ name: "edit", args: { path: "/r/new.ts" } }],
		},
	];
	const host: ConversationReadHost = {
		listRunningConversations: () => [],
		readRunningConversation: (id) =>
			id === "c1" ? { title: "T", cwd: "/r", isSubagent: false, messages: MSGS } : undefined,
		listHistorySessions: async () => [],
		readHistorySession: async () => undefined,
		readTouchSidecar: () => [{ path: "/r/old.ts", count: 3, lastTs: 1 }],
	};
	const extras = {
		listClaims: () => [{ path: "/r/x.ts", ownerTitle: "B", note: "n" }],
	};
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const ctx = {} as any;
	it("files 合并 sidecar + 展示认领块", async () => {
		const tool = makeConversationReadTool(host, () => "zh", extras);
		const r = (await tool.execute("t", { action: "files", id: "c1" }, undefined, undefined, ctx)) as {
			content: { type: string; text: string }[];
		};
		const text = r.content[0].text;
		expect(text).toContain("/r/old.ts");
		expect(text).toContain("/r/new.ts");
		expect(text).toContain("认领");
		expect(text).toContain("/r/x.ts");
	});
	it("status 带认领行；无 extras 时不展示也不报错", async () => {
		const tool = makeConversationReadTool(host, () => "zh", extras);
		const r = (await tool.execute("t", { action: "status", id: "c1" }, undefined, undefined, ctx)) as {
			content: { type: string; text: string }[];
		};
		expect(r.content[0].text).toContain("认领：");
		const bare = makeConversationReadTool(host, () => "zh");
		const r2 = (await bare.execute("t", { action: "status", id: "c1" }, undefined, undefined, ctx)) as {
			content: { type: string; text: string }[];
		};
		expect(r2.content[0].text).not.toContain("认领");
	});
});

describe("readExtraLines", () => {
	it("query 命中报原序号；chat 裁剪报 full 指引；都无则空串", () => {
		const sel = selectReadMessages(
			[
				{ role: "user", content: "hello bug" },
				{ role: "toolResult", toolName: "bash", content: "line1" },
				{ role: "assistant", content: [{ type: "text", text: "done" }] },
			],
			{ query: "bug" },
		);
		const lines = readExtraLines("zh", "bug", sel, 3, "chat");
		expect(lines).toContain("选区第");
		expect(lines).toContain('view="full"');
		expect(readExtraLines("en", "", { selected: [], totalInView: 0, hitIndices: [] }, 0, "full")).toBe("");
	});
});
