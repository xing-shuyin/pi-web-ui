import { describe, expect, it } from "vitest";
import {
	buildEvidenceDigest,
	collectToolEvidence,
	formatEvidenceDigest,
	sessionMessagesOf,
} from "../../server/goal-evidence.js";

const bash = (command: string, output: string, exitCode = 0) => ({
	role: "bashExecution",
	command,
	output,
	exitCode,
});
const call = (toolCallId: string, name: string, args: unknown) => ({
	role: "assistant",
	content: [{ type: "toolCall", toolCallId, name, args }],
});
const result = (toolCallId: string, toolName: string, text: string, isError = false) => ({
	role: "toolResult",
	toolCallId,
	toolName,
	isError,
	content: [{ type: "text", text }],
});

describe("collectToolEvidence", () => {
	it("取最近的工具事件并按时间正序返回（命令 + 输出尾部）", () => {
		const msgs = [bash("ls", "a\nb"), bash("npm test", "3 failing", 1)];
		const out = collectToolEvidence(msgs);
		expect(out.map((e) => e.tool)).toEqual(["bash", "bash"]);
		expect(out[0]).toMatchObject({ hint: "ls", tail: "a\nb", error: false });
		expect(out[1]).toMatchObject({ hint: "npm test", tail: "3 failing", error: true });
	});

	it("toolResult 借 toolCallId 找回工具名与参数提示，isError 透传", () => {
		const msgs = [
			call("c1", "read", { path: "src/a.ts" }),
			result("c1", "read", "file body"),
			call("c2", "bash", { command: "df -h" }),
			result("c2", "bash", "exit 1", true),
		];
		const out = collectToolEvidence(msgs);
		expect(out).toHaveLength(2);
		expect(out[0]).toMatchObject({ tool: "read", hint: "src/a.ts", tail: "file body", error: false });
		expect(out[1]).toMatchObject({ tool: "bash", hint: "df -h", error: true });
	});

	it("带 toolCallId 但没有对应调用时仍给出工具名（hint 为空）", () => {
		const out = collectToolEvidence([result("gone", "grep", "hit")]);
		expect(out[0]).toMatchObject({ tool: "grep", hint: "", tail: "hit" });
	});

	it("maxEntries 只保留最新的 N 条（丢的是最早的）", () => {
		const msgs = [bash("one", "1"), bash("two", "2"), bash("three", "3")];
		const out = collectToolEvidence(msgs, { maxEntries: 2 });
		expect(out.map((e) => e.hint)).toEqual(["two", "three"]);
	});

	it("长输出只留尾部并加省略号", () => {
		const out = collectToolEvidence([bash("big", "x".repeat(500))], { maxTailChars: 100 });
		expect(out[0]!.tail!.startsWith("…")).toBe(true);
		expect(out[0]!.tail!.length).toBe(101);
	});

	it("window 只看最近 N 条消息；非数组/空数组 → 空", () => {
		const msgs = [bash("old", "1"), bash("mid", "2"), bash("new", "3")];
		expect(collectToolEvidence(msgs, { window: 2 }).map((e) => e.hint)).toEqual(["mid", "new"]);
		expect(collectToolEvidence(undefined)).toEqual([]);
		expect(collectToolEvidence([])).toEqual([]);
		expect(collectToolEvidence("not an array")).toEqual([]);
	});

	it("坏形状消息不抛错（缺 content / 非对象 / 未知 role 一并跳过）", () => {
		const msgs = [null, 42, { role: "assistant" }, { role: "user", content: "hi" }, bash("ok", "fine")];
		const out = collectToolEvidence(msgs);
		expect(out.map((e) => e.hint)).toEqual(["ok"]);
	});
});

describe("formatEvidenceDigest", () => {
	it("空条目 → 空串（调用方据此跳过整段）", () => {
		expect(formatEvidenceDigest([])).toBe("");
	});

	it("每条一行（失败标注 + 输出行），编号即时间序", () => {
		const text = formatEvidenceDigest([
			{ tool: "read", hint: "src/a.ts", tail: "body" },
			{ tool: "bash", hint: "npm test", tail: "3 failing", error: true },
		]);
		expect(text).toBe("1. read: src/a.ts\n   out: body\n2. bash (failed): npm test\n   out: 3 failing");
	});

	it("总预算超限时从最早的事件开始丢，并标注省略条数", () => {
		const entries = [
			{ tool: "bash", hint: "first", tail: "y".repeat(300) },
			{ tool: "bash", hint: "second", tail: "z".repeat(300) },
		];
		const text = formatEvidenceDigest(entries, { maxTotalChars: 400 });
		expect(text).toContain("(1 earlier event(s) omitted for brevity)");
		expect(text).toContain("1. bash: second");
		expect(text).not.toContain("first");
	});
});

describe("buildEvidenceDigest / sessionMessagesOf", () => {
	it("端到端：会话消息 → 证据文本", () => {
		const text = buildEvidenceDigest([
			call("c1", "bash", { command: "npm run typecheck" }),
			result("c1", "bash", "ok"),
		]);
		expect(text).toBe("1. bash: npm run typecheck\n   out: ok");
		expect(buildEvidenceDigest([])).toBe("");
	});

	it("sessionMessagesOf：session.messages 优先，回落 agent.state.messages，坏对象 → 空数组", () => {
		expect(sessionMessagesOf({ messages: [1, 2] })).toEqual([1, 2]);
		expect(sessionMessagesOf({ agent: { state: { messages: [3] } } })).toEqual([3]);
		expect(sessionMessagesOf({ messages: [1], agent: { state: { messages: [2] } } })).toEqual([1]);
		expect(sessionMessagesOf(undefined)).toEqual([]);
		expect(sessionMessagesOf({})).toEqual([]);
		expect(
			sessionMessagesOf({
				get messages(): unknown {
					throw new Error("boom");
				},
			}),
		).toEqual([]);
	});
});
