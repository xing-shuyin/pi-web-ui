import { describe, expect, it } from "vitest";
import type { UiMessage } from "../../server/protocol.js";
import {
	projectTranscriptEntries,
	projectTranscriptText,
	type ProjectionResult,
} from "../../packages/keel/src/domains/history/transcript.js";

/**
 * 转录投影（历史域）：条目一律来自 `server/session-projection.ts`，序列化一律来自
 * `server/serialize.ts`。用例固定手写的最小 jsonl，验行为而不验解法。
 */

const HEADER = { type: "session", version: 3, id: "s1", cwd: "/w", timestamp: "2024-01-01T00:00:00Z" };

function userLine(id: string, parentId: string | null, text: string, ts: number) {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(ts).toISOString(),
		message: { role: "user", content: text, timestamp: ts },
	};
}

function assistantLine(id: string, parentId: string | null, text: string, ts: number) {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(ts).toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "openai-responses",
			provider: "openai",
			model: "test-model",
			stopReason: "stop",
			timestamp: ts,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		},
	};
}

/** 原样拼接：对象按 jsonl 序列化，字符串当作「已经是原始文本的行」（坏行用例靠它）。 */
function jsonl(...lines: unknown[]): string {
	return lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n");
}

const TS = 1_700_000_000_000;

function texts(messages: readonly UiMessage[]): string[] {
	return messages.map((m) => m.content.map((b) => (b.type === "text" ? b.text : "")).join(""));
}

function idsOf(result: ProjectionResult): string[] {
	return result.projection.messages.map((m) => m.id);
}

const ONE_USER = jsonl(HEADER, userLine("m1", null, "你好", TS + 1_000));

const USER_AND_ASSISTANT = jsonl(
	HEADER,
	userLine("m1", null, "问题", TS + 1_000),
	assistantLine("m2", "m1", "回答", TS + 2_000),
);

describe("projectTranscriptText：整份 jsonl → 已序列化消息", () => {
	it("单条用户消息：一条 user 消息、id 带时间戳与 seq", () => {
		const result = projectTranscriptText(ONE_USER);
		expect(result.projection.messages).toHaveLength(1);
		const [message] = result.projection.messages;
		expect(message?.role).toBe("user");
		expect(message?.id).toBe(`u-${TS + 1_000}-0`);
		expect(texts(result.projection.messages)).toEqual(["你好"]);
	});

	it("user + assistant 按条目顺序出场，模型与用量一起带出", () => {
		const result = projectTranscriptText(USER_AND_ASSISTANT);
		expect(result.projection.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
		expect(texts(result.projection.messages)).toEqual(["问题", "回答"]);
		const assistant = result.projection.messages[1];
		expect(assistant?.model).toBe("test-model");
		expect(assistant?.provider).toBe("openai");
		expect(assistant?.stopReason).toBe("stop");
	});

	it("空文本出空投影：没有消息、没有叶、不算跳过", () => {
		const result = projectTranscriptText("");
		expect(result.projection.messages).toEqual([]);
		expect(result.leafId).toBeNull();
		expect(result.skippedLines).toBe(0);
	});

	it("只有 session 头：没有条目，出空投影且不算跳过", () => {
		const result = projectTranscriptText(jsonl(HEADER));
		expect(result.projection.messages).toEqual([]);
		expect(result.leafId).toBeNull();
		expect(result.skippedLines).toBe(0);
	});

	it("空白行不是坏行：不计数", () => {
		const text = [jsonl(HEADER), "", JSON.stringify(userLine("m1", null, "你好", TS + 1_000)), "   "].join("\n");
		const result = projectTranscriptText(text);
		expect(result.projection.messages).toHaveLength(1);
		expect(result.skippedLines).toBe(0);
	});

	it("leafId 非 null：等于叶链最后一条可见条目（消息本身不是 id 来源）", () => {
		const result = projectTranscriptText(USER_AND_ASSISTANT);
		expect(result.leafId).toBe("m2");
	});
});

describe("projectTranscriptText：坏行不得整份失败", () => {
	it("截断的 json 行不抛：好行照出，坏行计进 skippedLines", () => {
		const text = jsonl(HEADER, userLine("m1", null, "你好", TS + 1_000), '{"type":"message","id":"m2"');
		const result = projectTranscriptText(text);
		expect(result.projection.messages).toHaveLength(1);
		expect(texts(result.projection.messages)).toEqual(["你好"]);
		expect(result.leafId).toBe("m1");
		expect(result.skippedLines).toBe(1);
	});

	it("坏行夹在中间也不影响后面的好行", () => {
		const text = jsonl(
			HEADER,
			userLine("m1", null, "前", TS + 1_000),
			"{oops",
			assistantLine("m3", "m1", "后", TS + 3_000),
		);
		const result = projectTranscriptText(text);
		expect(texts(result.projection.messages)).toEqual(["前", "后"]);
		expect(result.skippedLines).toBe(1);
		expect(result.leafId).toBe("m3");
	});

	it("合法 JSON 但条目形状坏（缺 message）：不抛，退化成空投影并计入跳过", () => {
		const text = jsonl(
			HEADER,
			userLine("m1", null, "你好", TS + 1_000),
			'{"type":"message","id":"m2","parentId":"m1"}',
		);
		expect(() => projectTranscriptText(text)).not.toThrow();
		const result = projectTranscriptText(text);
		expect(result.projection.messages).toEqual([]);
		expect(result.leafId).toBeNull();
		expect(result.skippedLines).toBe(3);
	});

	it("解析器认行但不认条目（json null）：同样退化成空投影", () => {
		const result = projectTranscriptText("null");
		expect(result.projection.messages).toEqual([]);
		expect(result.leafId).toBeNull();
		expect(result.skippedLines).toBe(1);
	});
});

describe("projectTranscriptText：id 稳定与 seq", () => {
	it("同一份文本两次投影得到同一串 id", () => {
		const first = projectTranscriptText(USER_AND_ASSISTANT);
		const second = projectTranscriptText(USER_AND_ASSISTANT);
		expect(idsOf(first)).toEqual(idsOf(second));
		expect(idsOf(first)).toEqual([`u-${TS + 1_000}-0`, `a-${TS + 2_000}-1`]);
	});

	it("seq 从 0 起逐条递增；opts.seq 决定起点", () => {
		const fromZero = projectTranscriptText(USER_AND_ASSISTANT);
		expect(idsOf(fromZero)).toEqual([`u-${TS + 1_000}-0`, `a-${TS + 2_000}-1`]);
		const fromTen = projectTranscriptText(USER_AND_ASSISTANT, { seq: 10 });
		expect(idsOf(fromTen)).toEqual([`u-${TS + 1_000}-10`, `a-${TS + 2_000}-11`]);
	});
});

describe("projectTranscriptText：可见面由投影决定，本域不另判", () => {
	it("被 context_edit 抹掉的条目不出消息（成员判据仍在投影里）", () => {
		const text = jsonl(
			HEADER,
			userLine("m1", null, "保留", TS + 1_000),
			assistantLine("m2", "m1", "要被删的回答", TS + 2_000),
			{
				type: "context_edit",
				id: "e1",
				parentId: "m2",
				timestamp: "2024-01-01T00:00:03Z",
				targetId: "m2",
				replacement: null,
			},
			userLine("m3", "e1", "收尾", TS + 4_000),
		);
		const result = projectTranscriptText(text);
		expect(texts(result.projection.messages)).toEqual(["保留", "收尾"]);
		expect(result.leafId).toBe("m3");
	});

	it("弃用分支不出消息：只出叶链", () => {
		const text = jsonl(
			HEADER,
			userLine("m1", null, "起点", TS + 1_000),
			userLine("m2", "m1", "主线提问", TS + 2_000),
			userLine("m3", "m1", "弃用分支", TS + 3_000),
			assistantLine("m4", "m2", "主线续答", TS + 4_000),
		);
		const result = projectTranscriptText(text);
		expect(texts(result.projection.messages)).toEqual(["起点", "主线提问", "主线续答"]);
		expect(result.leafId).toBe("m4");
	});

	it("老转录（条目没有 id/parentId）整份可见：按文件顺序当单链", () => {
		const text = jsonl(
			{ type: "message", message: { role: "user", content: "第一句", timestamp: TS + 1_000 } },
			{ type: "message", message: { role: "user", content: "第二句", timestamp: TS + 2_000 } },
		);
		const result = projectTranscriptText(text);
		expect(texts(result.projection.messages)).toEqual(["第一句", "第二句"]);
		expect(result.leafId).toBe("legacy-2");
	});

	it("序列化为 null 的消息（custom_message display:false）跳过并计数，seq 不为它空转", () => {
		const text = jsonl(
			HEADER,
			userLine("m1", null, "前", TS + 1_000),
			{
				type: "custom_message",
				id: "c1",
				parentId: "m1",
				timestamp: "2024-01-01T00:00:02Z",
				customType: "note",
				content: "隐藏备注",
				display: false,
			},
			userLine("m2", "c1", "后", TS + 3_000),
		);
		const result = projectTranscriptText(text);
		expect(texts(result.projection.messages)).toEqual(["前", "后"]);
		expect(result.skippedLines).toBe(1);
		expect(idsOf(result)).toEqual([`u-${TS + 1_000}-0`, `u-${TS + 3_000}-1`]);
	});
});

describe("projectTranscriptEntries：已解析条目 → 投影", () => {
	it("与文本入口同结果（同一份条目不再回读文件）", () => {
		const entries = [HEADER, userLine("m1", null, "问题", TS + 1_000), assistantLine("m2", "m1", "回答", TS + 2_000)];
		expect(projectTranscriptEntries(entries)).toEqual(projectTranscriptText(jsonl(...entries)));
	});

	it("空条目数组出空投影", () => {
		const result = projectTranscriptEntries([]);
		expect(result.projection.messages).toEqual([]);
		expect(result.leafId).toBeNull();
		expect(result.skippedLines).toBe(0);
	});

	it("坏条目（null / 数字）不抛：退化成空投影并计入跳过", () => {
		expect(() => projectTranscriptEntries([null, 5])).not.toThrow();
		const result = projectTranscriptEntries([null, 5]);
		expect(result.projection.messages).toEqual([]);
		expect(result.leafId).toBeNull();
		expect(result.skippedLines).toBe(2);
	});
});
