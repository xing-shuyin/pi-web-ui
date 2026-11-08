import { describe, expect, it } from "vitest";
import { ClientSession } from "../../server/agent-service.js";
import { fakeClientSession, protoMethod } from "../helpers/fake-session.js";

/**
 * pi 引擎（ClientSession）必须给每条对话裁定左栏行归属（`rowKind`）：
 * - 落盘的静态对话 → history（由历史行代表）
 * - 运行中 / 子代理 / 固定 / 原生 CLI / 未落盘 → open（自占一行）
 * 客户端不再按字段猜，猜错就是左栏重复行。
 */

const FILE = "/w/.sessions/2026-11-05T07-06-40-090Z_01a1aa87-f85a-73f5-895d-f444ccb37fb1.jsonl";

function fakeConv(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "c1",
		title: "会话",
		cwd: "/w",
		isSubagent: false,
		listed: true,
		pinned: undefined,
		terminals: { countBlockingLive: () => 0, countUserBlockingLive: () => 0 },
		session: {
			isStreaming: false,
			getSessionStats: () => ({ totalMessages: 3 }),
			sessionId: "sid-1",
			sessionFile: FILE,
		},
		...overrides,
	};
}

function emitFor(convs: Record<string, unknown>[]): Record<string, unknown>[] {
	const emitted: unknown[] = [];
	const cs = fakeClientSession({
		cwd: "/w",
		activeId: "c1",
		convs: new Map(convs.map((conv) => [conv.id as string, conv])),
		emit: (msg: unknown) => emitted.push(msg),
		listExternalRunning: () => [],
	});
	protoMethod(ClientSession.prototype, "emitConversations").call(cs);
	const message = emitted.find((m) => (m as { type?: string }).type === "conversations") as
		{ conversations: Record<string, unknown>[] } | undefined;
	if (!message) throw new Error("no conversations message");
	return message.conversations;
}

describe("ClientSession 宣告左栏行归属", () => {
	it("已落盘的静态对话交给历史行", () => {
		expect(emitFor([fakeConv()])[0]?.rowKind).toBe("history");
	});

	it("流式 / 固定 / 子代理 / 未落盘 自占一行", () => {
		const rows = emitFor([
			fakeConv({ id: "a", session: { ...(fakeConv().session as object), isStreaming: true } }),
			fakeConv({ id: "b", pinned: true }),
			fakeConv({ id: "c", isSubagent: true }),
			fakeConv({
				id: "d",
				session: { getSessionStats: () => ({ totalMessages: 0 }), isStreaming: false },
			}),
		]);
		expect(rows.map((row) => row.rowKind)).toEqual(["open", "open", "open", "open"]);
	});

	it("原生 CLI 对话自占一行（终端要留在活动行）", () => {
		const rows = emitFor([
			fakeConv({ nativeCli: { config: { preset: "claude" }, terminalId: "cli-1", status: { phase: "running" } } }),
		]);
		expect(rows[0]?.rowKind).toBe("open");
	});

	it("未列出且无内容的对话不入列表", () => {
		const rows = emitFor([
			fakeConv({
				id: "x",
				listed: false,
				session: { isStreaming: false, getSessionStats: () => ({ totalMessages: 0 }) },
			}),
		]);
		expect(rows).toEqual([]);
	});

	it("每条下发的对话都带 rowKind（客户端不再做启发式）", () => {
		const rows = emitFor([fakeConv({ id: "a" }), fakeConv({ id: "b", pinned: true })]);
		for (const row of rows) expect(typeof row.rowKind).toBe("string");
	});
});
