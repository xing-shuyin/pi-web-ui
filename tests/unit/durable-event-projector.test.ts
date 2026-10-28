import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	contentToText,
	DurableEventProjector,
	readToolEnd,
	type DurableSinkLike,
} from "../../server/durable/durable-event-projector.js";

/** 录下所有投影结果的 sink（模拟宿主 AgentEventSink）。 */
function recordingSink() {
	const calls: Array<[string, ...unknown[]]> = [];
	const sink: DurableSinkLike = {
		onTextDelta: (delta) => calls.push(["text", delta]),
		onThinkingDelta: (delta) => calls.push(["thinking", delta]),
		onToolStart: (callId, toolName, args) => calls.push(["toolStart", callId, toolName, args]),
		onToolUpdate: (callId, delta) => calls.push(["toolUpdate", callId, delta]),
		onToolEnd: (callId, result) => calls.push(["toolEnd", callId, result]),
	};
	return { sink, calls };
}

/** 工具回执条目（`tool_execution_end.entry`，`model[0]` 为 ToolResultMessage）。 */
function resultEntry(text: string, isError = false) {
	return {
		id: 18,
		kind: "pi.tool-result",
		model: [{ role: "toolResult", content: [{ type: "text", text }], isError }],
	};
}

describe("DurableEventProjector — 事件流投影（issue #774）", () => {
	it("工具入参取自 tool_execution_start.args，不再从 pi.live 槽位猜", () => {
		const { sink, calls } = recordingSink();
		new DurableEventProjector().project(
			[
				{
					type: "tool_execution_start",
					toolCallId: "chatcmpl-tool-8534",
					toolName: "bash",
					taskId: 7,
					args: { command: "pwd && ls -la" },
				},
			],
			sink,
		);
		expect(calls).toEqual([["toolStart", "chatcmpl-tool-8534", "bash", { command: "pwd && ls -la" }]]);
	});

	it("工具回执取自 tool_execution_end.entry，输出与错误标记都还原", () => {
		const projector = new DurableEventProjector();
		const { sink, calls } = recordingSink();
		projector.project(
			[
				{ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "pwd" } },
				{ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", entry: resultEntry("/home/user/project\n") },
			],
			sink,
		);
		expect(calls[1]).toEqual(["toolEnd", "c1", { output: "/home/user/project\n" }]);

		const failing = recordingSink();
		projector.project(
			[
				{ type: "tool_execution_start", toolCallId: "c2", toolName: "read", args: {} },
				{ type: "tool_execution_end", toolCallId: "c2", toolName: "read", entry: resultEntry("ENOENT", true) },
			],
			failing.sink,
		);
		// 失败只带 error，宿主据其置 isError 并把文本落到结果正文
		expect(failing.calls[1]).toEqual(["toolEnd", "c2", { error: "ENOENT" }]);
	});

	it("嵌套调用（parentToolCallId）不单独出卡片，避免父调用内部步骤刷屏", () => {
		const { sink, calls } = recordingSink();
		new DurableEventProjector().project(
			[
				{
					type: "tool_execution_start",
					toolCallId: "parent/1",
					toolName: "read",
					parentToolCallId: "parent",
					args: { path: "a.ts" },
				},
				{
					type: "tool_execution_end",
					toolCallId: "parent/1",
					toolName: "read",
					parentToolCallId: "parent",
					entry: resultEntry("x"),
				},
			],
			sink,
		);
		expect(calls).toEqual([]);
	});

	it("正文/思考流式增量与整段回执不重复、不丢字", () => {
		const projector = new DurableEventProjector();
		const { sink, calls } = recordingSink();
		projector.project(
			[
				{ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "" }] } },
				{
					type: "message_update",
					changes: [
						{ type: "thinking_delta", contentIndex: 0, delta: "想一想" },
						{ type: "text_delta", contentIndex: 1, delta: "你好" },
						{ type: "text_delta", contentIndex: 1, delta: "，世界" },
					],
				},
				// 等到提交后的完整消息（含落盘补齐），尾部不应重复
				{
					type: "message_end",
					entry: {
						id: 9,
						model: [
							{
								role: "assistant",
								content: [
									{ type: "thinking", thinking: "想一想" },
									{ type: "text", text: "你好，世界" },
								],
							},
						],
					},
				},
			],
			sink,
		);
		expect(calls).toEqual([
			["thinking", "想一想"],
			["text", "你好"],
			["text", "，世界"],
		]);
	});

	it("多条助手消息（工具轮次之间）记账互不串味", () => {
		const projector = new DurableEventProjector();
		const { sink, calls } = recordingSink();
		projector.project(
			[
				{ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "第一段" }] } },
				{
					type: "message_end",
					entry: { id: 1, model: [{ role: "assistant", content: [{ type: "text", text: "第一段" }] }] },
				},
				{ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "第二段" }] } },
			],
			sink,
		);
		expect(calls).toEqual([
			["text", "第一段"],
			["text", "第二段"],
		]);
	});

	it("运行期进度输出：append 换算为增量，set 只在纯追加时补差", () => {
		const projector = new DurableEventProjector();
		const { sink, calls } = recordingSink();
		projector.project(
			[
				{ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: {} },
				{ type: "tool_execution_update", toolCallId: "c1", output: { append: "line1\n" } },
				{ type: "tool_execution_update", toolCallId: "c1", output: { trimStart: 6, append: "line2\n" } },
				{ type: "tool_execution_update", toolCallId: "c1", output: { set: "line2\nline3\n" } },
			],
			sink,
		);
		const updates = calls.filter((c) => c[0] === "toolUpdate").map((c) => c[2]);
		expect(updates).toEqual(["line1\n", "line2\n", "line3\n"]);
	});

	it("同一批里工具开始推迟到批末：正文永远在工具卡之前", () => {
		const { sink, calls } = recordingSink();
		new DurableEventProjector().project(
			[
				{ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } },
				{ type: "tool_execution_update", toolCallId: "c1", output: { append: "partial" } },
				{ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "我先看下目录" }] } },
			],
			sink,
		);
		expect(calls.map((c) => c[0])).toEqual(["text", "toolStart", "toolUpdate"]);
	});

	it("挂接时已有在飞回复：快照先补齐，随后的增量不丢头", () => {
		const projector = new DurableEventProjector();
		const { sink, calls } = recordingSink();
		projector.primeSnapshot({ generation: { message: { content: [{ type: "text", text: "前半" }] } } }, sink);
		projector.project(
			[{ type: "message_update", changes: [{ type: "text_delta", contentIndex: 0, delta: "后半" }] }],
			sink,
		);
		expect(calls).toEqual([
			["text", "前半"],
			["text", "后半"],
		]);
	});

	it("快照溢出后只补在飞消息剩余正文，不重放历史", () => {
		const projector = new DurableEventProjector();
		const { sink, calls } = recordingSink();
		projector.project(
			[
				{ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "ab" }] } },
				{ type: "snapshot", generation: { message: { role: "assistant", content: [{ type: "text", text: "abcd" }] } } },
			],
			sink,
		);
		expect(calls).toEqual([
			["text", "ab"],
			["text", "cd"],
		]);
	});
});

describe("DurableEventProjector — 字段解析工具", () => {
	it("contentToText 兼容字符串与内容块数组", () => {
		expect(contentToText("hi")).toBe("hi");
		expect(contentToText([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }])).toBe("a\nb");
		expect(contentToText(undefined)).toBe("");
	});

	it("readToolEnd 兼容嵌套调用 result（结构化输出 / 诊断）", () => {
		expect(readToolEnd({ result: { isError: false, structuredOutput: "ok", diagnostics: [] } })).toEqual({
			output: "ok",
		});
		expect(readToolEnd({ result: { isError: true, diagnostics: [{ severity: "error", message: "boom" }] } })).toEqual({
			error: "boom",
		});
	});
});

describe("durable-driver 回归守卫（issue #774）", () => {
	it("驱动不得再从 pi.live 槽位读取 input / output", () => {
		const source = readFileSync(join(process.cwd(), "server/durable/durable-driver.ts"), "utf8");
		expect(source).not.toMatch(/slot\.input/);
		expect(source).not.toMatch(/slot\.output/);
		expect(source).toMatch(/DurableEventProjector/);
	});
});
