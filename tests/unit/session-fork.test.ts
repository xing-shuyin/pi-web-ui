import { describe, it, expect } from "vitest";
import { findTurnBaseEntryId } from "../../server/attachments.js";
import {
	findEntryByUiId,
	serializeMessage,
	uiMessageId,
	type AgentMessage,
	type UiIdEntryLike,
} from "../../server/serialize.js";

interface MockEntry extends UiIdEntryLike {
	id: string;
	parentId: string | null;
	type: string;
	message?: AgentMessage;
}

function makeCounter() {
	let nextN = 1;
	const seqMap = new Map<string, number>();
	const seqOf = (m: AgentMessage) => {
		const content = (m as { content?: unknown }).content;
		const key = `${m.role}:${m.timestamp}:${JSON.stringify(content)}`;
		if (!seqMap.has(key)) seqMap.set(key, nextN++);
		return seqMap.get(key)!;
	};
	return { seqOf };
}

function renderAll(entries: MockEntry[], seqOf: (m: AgentMessage) => number): string[] {
	const userSeqByTs = new Map<number, number>();
	return entries.map((e) => {
		const m = e.message!;
		const n = seqOf(m);
		if (m.role === "user") {
			const ts = m.timestamp ?? 0;
			const seq = (userSeqByTs.get(ts) ?? 0) + 1;
			userSeqByTs.set(ts, seq);
			return uiMessageId(m, seq);
		}
		return uiMessageId(m, n);
	});
}

function msgEntry(id: string, parentId: string | null, message: AgentMessage): MockEntry {
	return { id, parentId, type: "message", message };
}

function user(timestamp: number, text = "q"): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp } as AgentMessage;
}

function assistant(timestamp: number, text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		timestamp,
		stopReason: "stop",
	} as AgentMessage;
}

describe("findEntryByUiId：渲染 id ↔ 解析 id 往返一致（issue #381）", () => {
	it("assistant 气泡：全局第 2/4 条消息（a-<ts>-2 / a-<ts>-4）能解析回 entry", () => {
		const { seqOf } = makeCounter();
		const entries: MockEntry[] = [
			msgEntry("e1", null, user(1000)),
			msgEntry("e2", "e1", assistant(1005, "first reply")),
			msgEntry("e3", "e2", user(2000)),
			msgEntry("e4", "e3", assistant(2005, "second reply")),
		];
		const ids = renderAll(entries, seqOf);
		expect(ids).toEqual(["u-1000-1", "a-1005-2", "u-2000-1", "a-2005-4"]);

		ids.forEach((id, i) => {
			expect(findEntryByUiId(entries, id, seqOf)?.id).toBe(entries[i].id);
		});
	});

	it("fork/rollback 的 before/at 切分：assistant 与 user 均正确", () => {
		const { seqOf } = makeCounter();
		const entries: MockEntry[] = [
			msgEntry("e1", null, user(1000)),
			msgEntry("e2", "e1", assistant(1005, "first reply")),
			msgEntry("e3", "e2", user(2000)),
			msgEntry("e4", "e3", assistant(2005, "second reply")),
		];
		const ids = renderAll(entries, seqOf);

		const entryA2 = findEntryByUiId(entries, ids[1], seqOf)!;
		expect(entryA2.parentId).toBe("e1");
		expect(entryA2.id).toBe("e2");

		const entryU2 = findEntryByUiId(entries, ids[2], seqOf)!;
		expect(entryU2.parentId).toBe("e2");
		expect(entryU2.id).toBe("e3");
	});

	it("toolResult / bashExecution 往返一致", () => {
		const { seqOf } = makeCounter();
		const toolResult = {
			role: "toolResult",
			toolCallId: "call_abc123",
			toolName: "bash",
			content: [{ type: "text", text: "ok" }],
			timestamp: 1010,
		} as AgentMessage;
		const bash = {
			role: "bashExecution",
			command: "ls",
			output: "a",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: 1020,
		} as AgentMessage;
		const entries: MockEntry[] = [
			msgEntry("e1", null, user(1000)),
			msgEntry("e2", "e1", toolResult),
			msgEntry("e3", "e2", bash),
		];
		const ids = renderAll(entries, seqOf);
		expect(ids).toEqual(["u-1000-1", "t-call_abc123", "b-1020-3"]);

		expect(findEntryByUiId(entries, ids[1], seqOf)?.id).toBe("e2");
		expect(findEntryByUiId(entries, ids[2], seqOf)?.id).toBe("e3");
	});

	it("custom_message（含 display:false 跳过）往返一致", () => {
		const { seqOf } = makeCounter();
		const entries = [
			{
				id: "e0",
				parentId: null,
				type: "custom_message",
				timestamp: new Date(900).toISOString(),
				customType: "note",
				content: [{ type: "text", text: "hi" }],
				display: false,
			},
			{
				id: "e1",
				parentId: "e0",
				type: "custom_message",
				timestamp: new Date(1000).toISOString(),
				customType: "note",
				content: [{ type: "text", text: "hi" }],
				display: true,
			},
			msgEntry("e2", "e1", user(2000)),
		] as unknown as MockEntry[];

		const hidden = serializeMessage(
			{ role: "custom", content: [{ type: "text", text: "hi" }], timestamp: 900 } as AgentMessage,
			1,
		);
		expect(hidden?.id).toBe("c-900-1");
		const ids = [
			uiMessageId({ role: "custom", content: [{ type: "text", text: "hi" }], timestamp: 1000 } as AgentMessage, 1),
		];
		expect(ids[0]).toBe("c-1000-1");

		expect(findEntryByUiId(entries, ids[0], seqOf)?.id).toBe("e1");
		expect(findEntryByUiId(entries, "c-900-1", seqOf)).toBeNull();
	});

	it("同时间戳的双 user 消息：同毫秒序号两侧口径一致", () => {
		const { seqOf } = makeCounter();
		const entries: MockEntry[] = [
			msgEntry("e1", null, user(2000, "first question")),
			msgEntry("e2", "e1", assistant(2005, "reply")),
			msgEntry("e3", "e2", user(2000, "edited question")),
		];
		const ids = renderAll(entries, seqOf);
		expect(ids).toEqual(["u-2000-1", "a-2005-2", "u-2000-2"]);

		ids.forEach((id, i) => {
			expect(findEntryByUiId(entries, id, seqOf)?.id).toBe(entries[i].id);
		});
	});

	it("原始 entry id 直接命中（快路径）", () => {
		const { seqOf } = makeCounter();
		const entries: MockEntry[] = [msgEntry("raw-entry-id", null, user(1000))];
		expect(findEntryByUiId(entries, "raw-entry-id", seqOf)?.id).toBe("raw-entry-id");
	});

	it("查不到返回 null（不是抛错）", () => {
		const { seqOf } = makeCounter();
		const entries: MockEntry[] = [msgEntry("e1", null, user(1000))];
		expect(findEntryByUiId(entries, "a-9999-9", seqOf)).toBeNull();
	});

	it("旧解析口径的 assistant id（同时间戳序号）不再撞上错误的 entry", () => {
		const { seqOf } = makeCounter();
		const entries: MockEntry[] = [
			msgEntry("e1", null, user(1000)),
			msgEntry("e2", "e1", assistant(1005, "first reply")),
		];
		renderAll(entries, seqOf);
		expect(findEntryByUiId(entries, "a-1005-1", seqOf)).toBeNull();
		expect(findEntryByUiId(entries, "a-1005-2", seqOf)?.id).toBe("e2");
	});

	it("serializeMessage 与 uiMessageId 出同一 id（防再分叉）", () => {
		const m = assistant(2005, "second reply");
		const ui = serializeMessage(m, 4);
		expect(ui?.id).toBe(uiMessageId(m, 4));
		expect(ui?.id).toBe("a-2005-4");
	});
});

describe("findTurnBaseEntryId：带附件提问重问/分叉时的基准节点定位", () => {
	function makeMockSessionManager(entries: { id: string; parentId: string | null; [key: string]: unknown }[]) {
		const map = new Map(entries.map((e) => [e.id, e]));
		return {
			getEntry: (id: string) => map.get(id),
		};
	}

	it("第一轮提问带单附件（如上传/引用视频）：分叉点回退到会话根（null）", () => {
		const entries = [
			{
				id: "e1",
				parentId: null,
				type: "custom_message",
				customType: "file",
				details: { name: "video.mp4", mode: "reference" },
			},
			{
				id: "e2",
				parentId: "e1",
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "分析这个视频" }] },
			},
			{
				id: "e3",
				parentId: "e2",
				type: "message",
				message: { role: "assistant", content: [{ type: "text", text: "好的" }] },
			},
		];
		const sm = makeMockSessionManager(entries);
		expect(findTurnBaseEntryId(sm, "e2")).toBeNull();
	});

	it("第一轮提问带多附件：跳过全部前置附件卡片，返回 null", () => {
		const entries = [
			{ id: "e1", parentId: null, type: "custom_message", customType: "file" },
			{ id: "e2", parentId: "e1", type: "custom_message", customType: "file" },
			{
				id: "e3",
				parentId: "e2",
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "对比两个文件" }] },
			},
		];
		const sm = makeMockSessionManager(entries);
		expect(findTurnBaseEntryId(sm, "e3")).toBeNull();
	});

	it("多轮对话中带附件提问：回退到上一轮助手的回复，排除本轮附件", () => {
		const entries = [
			{
				id: "e1",
				parentId: null,
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "第1轮" }] },
			},
			{
				id: "e2",
				parentId: "e1",
				type: "message",
				message: { role: "assistant", content: [{ type: "text", text: "第1轮回复" }] },
			},
			{ id: "e3", parentId: "e2", type: "custom_message", customType: "file" },
			{ id: "e4", parentId: "e3", type: "custom_message", customType: "file" },
			{
				id: "e5",
				parentId: "e4",
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "第2轮提问带附件" }] },
			},
		];
		const sm = makeMockSessionManager(entries);
		expect(findTurnBaseEntryId(sm, "e5")).toBe("e2");
	});

	it("真实 SDK 树结构：提问与附件间夹带 SDK system 截面时，跳过 system 与全部附件返回上一轮回复", () => {
		const entries = [
			{
				id: "e1",
				parentId: null,
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "第1轮" }] },
			},
			{
				id: "e2",
				parentId: "e1",
				type: "message",
				message: { role: "assistant", content: [{ type: "text", text: "第1轮回复" }] },
			},
			{ id: "e3", parentId: "e2", type: "custom_message", customType: "file", details: { mode: "conversation" } },
			{ id: "e4", parentId: "e3", type: "custom_message", customType: "file", details: { mode: "image" } },
			{ id: "e5", parentId: "e4", type: "message", message: { role: "system", content: [{ type: "text", text: "" }] } },
			{
				id: "e6",
				parentId: "e5",
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "第2轮提问" }] },
			},
		];
		const sm = makeMockSessionManager(entries);
		expect(findTurnBaseEntryId(sm, "e6")).toBe("e2");
	});

	it("真实 SDK 树结构：首轮提问夹带 model_change、thinking_level_change、附件及 system 截面时，回退到根（null）", () => {
		const entries = [
			{ id: "e1", parentId: null, type: "model_change" },
			{ id: "e2", parentId: "e1", type: "thinking_level_change" },
			{ id: "e3", parentId: "e2", type: "custom_message", customType: "file", details: { mode: "conversation" } },
			{ id: "e4", parentId: "e3", type: "custom_message", customType: "file", details: { mode: "image" } },
			{ id: "e5", parentId: "e4", type: "message", message: { role: "system", content: [{ type: "text", text: "" }] } },
			{
				id: "e6",
				parentId: "e5",
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "首轮提问" }] },
			},
		];
		const sm = makeMockSessionManager(entries);
		expect(findTurnBaseEntryId(sm, "e6")).toBeNull();
	});

	it("多轮对话上一轮以 toolResult 结尾（无最终 assistant 回复）时，回退到 toolResult 节点", () => {
		const entries = [
			{
				id: "e1",
				parentId: null,
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "执行操作" }] },
			},
			{
				id: "e2",
				parentId: "e1",
				type: "message",
				message: { role: "assistant", content: [{ type: "text", text: "好的" }] },
			},
			{
				id: "e3",
				parentId: "e2",
				type: "message",
				message: { role: "toolResult", content: [{ type: "text", text: "错误" }] },
			},
			{ id: "e4", parentId: "e3", type: "custom_message", customType: "file" },
			{ id: "e5", parentId: "e4", type: "message", message: { role: "system" } },
			{
				id: "e6",
				parentId: "e5",
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "重试" }] },
			},
		];
		const sm = makeMockSessionManager(entries);
		expect(findTurnBaseEntryId(sm, "e6")).toBe("e3");
	});

	it("普通提问无附件：第一轮返回 null，后续轮返回前一条 entry", () => {
		const entries = [
			{
				id: "e1",
				parentId: null,
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "首轮" }] },
			},
			{
				id: "e2",
				parentId: "e1",
				type: "message",
				message: { role: "assistant", content: [{ type: "text", text: "回复" }] },
			},
			{
				id: "e3",
				parentId: "e2",
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "次轮" }] },
			},
		];
		const sm = makeMockSessionManager(entries);
		expect(findTurnBaseEntryId(sm, "e1")).toBeNull();
		expect(findTurnBaseEntryId(sm, "e3")).toBe("e2");
	});

	it("非用户消息（如在 assistant 消息上 before 分叉）：保持 parentId 不变", () => {
		const entries = [
			{
				id: "e1",
				parentId: null,
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "首轮" }] },
			},
			{
				id: "e2",
				parentId: "e1",
				type: "message",
				message: { role: "assistant", content: [{ type: "text", text: "回复" }] },
			},
		];
		const sm = makeMockSessionManager(entries);
		expect(findTurnBaseEntryId(sm, "e2")).toBe("e1");
	});
});
