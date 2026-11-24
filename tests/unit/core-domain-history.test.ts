import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildConversationRows,
	type ConversationRow,
	type HistoryEntry,
	type OpenConversationFact,
	refreshSessions,
	scanHistory,
} from "../../packages/keel/src/domains/history/index.js";
import type { ServerMessage } from "../../packages/keel/src/protocol.js";

const CWD = "/p/demo";
const OTHER_CWD = "/p/other";

function conv(over: Partial<OpenConversationFact> & { id: string }): OpenConversationFact {
	return { title: `mem-${over.id}`, kind: "user", cwd: CWD, isStreaming: false, lastActiveAt: 1_000, ...over };
}

function entry(over: Partial<HistoryEntry> & { id: string }): HistoryEntry {
	return {
		title: `disk-${over.id}`,
		cwd: CWD,
		updatedAt: 1_000,
		sessionFile: `/sessions/${over.id}.jsonl`,
		messageCount: 0,
		...over,
	};
}

function build(over: {
	conversations?: OpenConversationFact[];
	history?: HistoryEntry[];
	cwd?: string;
	openIds?: string[];
}): ConversationRow[] {
	return buildConversationRows({
		conversations: over.conversations ?? [],
		history: over.history,
		cwd: over.cwd ?? CWD,
		openIds: new Set(over.openIds ?? []),
	});
}

function ids(rows: readonly ConversationRow[]): string[] {
	return rows.map((row) => row.identity);
}

describe("buildConversationRows：行归属全交给 conversationRowKind", () => {
	it("空输入出空列表", () => {
		expect(build({ history: [] })).toEqual([]);
		expect(build({})).toEqual([]);
	});

	it("没有历史条目的内存对话自占一行（open）", () => {
		const [row] = build({ conversations: [conv({ id: "a" })] });
		expect(row?.row).toBe("open");
		expect(row?.identity).toBe("a");
	});

	it("idle 内存对话有历史条目时由历史行代表（history），且只出一行", () => {
		const rows = build({ conversations: [conv({ id: "a" })], history: [entry({ id: "a" })] });
		expect(ids(rows)).toEqual(["a"]);
		expect(rows[0]?.row).toBe("history");
	});

	it("正在生成的内存对话即使有历史条目也自占一行（open）", () => {
		const [row] = build({ conversations: [conv({ id: "a", isStreaming: true })], history: [entry({ id: "a" })] });
		expect(row?.row).toBe("open");
	});

	it("子代理对话有历史条目时仍自占一行（open），并带 parentId", () => {
		const rows = build({
			conversations: [conv({ id: "p" }), conv({ id: "s", kind: "subagent", parentId: "p" })],
			history: [entry({ id: "p" }), entry({ id: "s" })],
		});
		expect(rows.find((row) => row.identity === "s")).toMatchObject({ row: "open", parentId: "p", kind: "subagent" });
	});

	it("纯历史条目出 history 行，不带 kind，isStreaming 恒 false", () => {
		const [row] = build({ history: [entry({ id: "h", sessionFile: "/sessions/h.jsonl" })] });
		expect(row).toMatchObject({
			identity: "h",
			row: "history",
			title: "disk-h",
			isStreaming: false,
			sessionFile: "/sessions/h.jsonl",
		});
		expect(row?.kind).toBeUndefined();
		expect(row?.parentId).toBeUndefined();
	});
});

describe("buildConversationRows：去重与项目范围", () => {
	it("同 id 去重时内存优先：标题与活跃时间取内存，会话文件取磁盘", () => {
		const rows = build({
			conversations: [conv({ id: "a", title: "内存标题", lastActiveAt: 9_000 })],
			history: [entry({ id: "a", title: "磁盘标题", updatedAt: 1_000, sessionFile: "/sessions/a.jsonl" })],
		});
		expect(ids(rows)).toEqual(["a"]);
		expect(rows[0]).toMatchObject({ title: "内存标题", lastActiveAt: 9_000, sessionFile: "/sessions/a.jsonl" });
	});

	it("同 id 的多条历史条目只留最新的一条", () => {
		const rows = build({
			history: [
				entry({ id: "a", updatedAt: 1_000, sessionFile: "/sessions/old.jsonl" }),
				entry({ id: "a", updatedAt: 5_000, sessionFile: "/sessions/new.jsonl" }),
			],
		});
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ identity: "a", lastActiveAt: 5_000, sessionFile: "/sessions/new.jsonl" });
	});

	it("openIds 里的会话不再重复出历史行（即使没进 conversations）", () => {
		const rows = build({ history: [entry({ id: "a" }), entry({ id: "b" })], openIds: ["a"] });
		expect(ids(rows)).toEqual(["b"]);
	});

	it("历史行只出当前项目：别的项目与空 cwd 的条目被滤掉", () => {
		const rows = build({
			history: [entry({ id: "mine" }), entry({ id: "other", cwd: OTHER_CWD }), entry({ id: "empty", cwd: "" })],
		});
		expect(ids(rows)).toEqual(["mine"]);
	});

	it("cwd 只筛磁盘历史，内存对话行不按 cwd 过滤", () => {
		const rows = build({ conversations: [conv({ id: "a", cwd: OTHER_CWD })] });
		expect(ids(rows)).toEqual(["a"]);
	});
});

describe("buildConversationRows：排序与子代理剪枝", () => {
	it("按 lastActiveAt 降序", () => {
		const rows = build({
			conversations: [conv({ id: "old", lastActiveAt: 100 }), conv({ id: "new", lastActiveAt: 900 })],
			history: [entry({ id: "mid", updatedAt: 500 })],
		});
		expect(ids(rows)).toEqual(["new", "mid", "old"]);
	});

	it("lastActiveAt 相同时按 identity 升序（稳定，不受输入顺序影响）", () => {
		const rows = build({
			conversations: [conv({ id: "b", lastActiveAt: 500 }), conv({ id: "c", lastActiveAt: 500 })],
			history: [entry({ id: "a", updatedAt: 500 })],
		});
		expect(ids(rows)).toEqual(["a", "b", "c"]);
	});

	it("父行在列表时子代理行保留，并带 parentId", () => {
		const rows = build({
			conversations: [
				conv({ id: "p", lastActiveAt: 100 }),
				conv({ id: "s", kind: "subagent", parentId: "p", lastActiveAt: 900 }),
			],
		});
		expect(ids(rows)).toEqual(["s", "p"]);
		expect(rows[0]).toMatchObject({ row: "open", parentId: "p" });
	});

	it("父行不在列表时孤儿子代理整行过滤（不许顶到顶部）", () => {
		const rows = build({
			conversations: [conv({ id: "s", kind: "subagent", parentId: "gone", lastActiveAt: 9_000 }), conv({ id: "a" })],
		});
		expect(ids(rows)).toEqual(["a"]);
	});

	it("子代理链上父行被剪掉时，孙行跟着整行过滤", () => {
		const rows = build({
			conversations: [
				conv({ id: "s", kind: "subagent", parentId: "gone", lastActiveAt: 900 }),
				conv({ id: "g", kind: "subagent", parentId: "s", lastActiveAt: 800 }),
				conv({ id: "a", lastActiveAt: 100 }),
			],
		});
		expect(ids(rows)).toEqual(["a"]);
	});

	it("子代理行没有 parentId 时也过滤（孤儿不许占顶部）", () => {
		const rows = build({ conversations: [conv({ id: "s", kind: "subagent", lastActiveAt: 9_000 })] });
		expect(rows).toEqual([]);
	});
});

function transcript(opts: { id: string; cwd: string; text: string; at: number; name?: string }): string {
	const lines = [
		JSON.stringify({ type: "session", id: opts.id, cwd: opts.cwd, timestamp: "2026-01-02T03:04:05.000Z" }),
		...(opts.name ? [JSON.stringify({ type: "session_info", name: opts.name })] : []),
		JSON.stringify({
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: new Date(opts.at).toISOString(),
			message: { role: "user", content: opts.text, timestamp: opts.at },
		}),
	];
	return lines.join("\n") + "\n";
}

function sessionsDir(): string {
	return mkdtempSync(join(tmpdir(), "core-history-"));
}

describe("scanHistory：session-list-scan 的薄封装", () => {
	it("真实目录扫描出 1 条：id / 首条用户消息 / cwd / 会话文件 / 更新时间", async () => {
		const dir = sessionsDir();
		const file = join(dir, "a.jsonl");
		writeFileSync(file, transcript({ id: "sess-a", cwd: CWD, text: "你好，世界", at: 1_700_000_000_000 }), "utf8");

		const result = await scanHistory({ root: dir });

		expect(result.skipped).toBe(false);
		expect(result.entries).toEqual([
			{ id: "sess-a", title: "你好，世界", cwd: CWD, updatedAt: 1_700_000_000_000, sessionFile: file, messageCount: 1 },
		]);
		expect(result.states.has(file)).toBe(true);
	});

	it("改名优先于首条消息（空会话标题只透传扫描器的占位）", async () => {
		const dir = sessionsDir();
		writeFileSync(
			join(dir, "named.jsonl"),
			transcript({ id: "sess-named", cwd: CWD, text: "原始消息", at: 1_700_000_000_000, name: " 改名后的会话 " }),
			"utf8",
		);
		writeFileSync(
			join(dir, "bare.jsonl"),
			`${JSON.stringify({ type: "session", id: "sess-bare", cwd: CWD })}\n`,
			"utf8",
		);

		const result = await scanHistory({ root: dir });
		const byId = new Map(result.entries.map((e) => [e.id, e]));
		expect(byId.get("sess-named")?.title).toBe("改名后的会话");
		// 空会话的标题不在这里重写：透传 session-list-scan 的占位（与老列表一致）。
		expect(byId.get("sess-bare")?.title).toBe("(no messages)");
	});

	it("按 updatedAt 降序，limit 只截返回条数", async () => {
		const dir = sessionsDir();
		writeFileSync(
			join(dir, "old.jsonl"),
			transcript({ id: "old", cwd: CWD, text: "旧", at: 1_600_000_000_000 }),
			"utf8",
		);
		writeFileSync(
			join(dir, "new.jsonl"),
			transcript({ id: "new", cwd: CWD, text: "新", at: 1_700_000_000_000 }),
			"utf8",
		);

		const all = await scanHistory({ root: dir });
		expect(all.entries.map((e) => e.id)).toEqual(["new", "old"]);

		const capped = await scanHistory({ root: dir, limit: 1 });
		expect(capped.entries.map((e) => e.id)).toEqual(["new"]);
		// 续扫状态不受 limit 影响：被截掉的另一份文件仍然有状态。
		expect(capped.states.size).toBe(2);
	});

	it("传入上一轮的 states 走增量续扫，结果与首轮一致", async () => {
		const dir = sessionsDir();
		writeFileSync(
			join(dir, "a.jsonl"),
			transcript({ id: "sess-a", cwd: CWD, text: "首轮", at: 1_700_000_000_000 }),
			"utf8",
		);
		const first = await scanHistory({ root: dir });
		const second = await scanHistory({ root: dir, state: first.states });
		expect(second.entries).toEqual(first.entries);
	});

	it("目录不存在时返回空数组 + skipped: true，不抛", async () => {
		const result = await scanHistory({ root: join(sessionsDir(), "no-such-dir") });
		expect(result).toMatchObject({ entries: [], skipped: true });
		expect(result.states.size).toBe(0);
	});

	it("目录里没有 .jsonl 时返回空数组 + skipped: false", async () => {
		const dir = sessionsDir();
		writeFileSync(join(dir, "notes.txt"), "不是会话文件", "utf8");
		await expect(scanHistory({ root: dir })).resolves.toMatchObject({ entries: [], skipped: false });
	});

	it("limit 为 0 时不返回条目但仍给出续扫状态", async () => {
		const dir = sessionsDir();
		writeFileSync(
			join(dir, "a.jsonl"),
			transcript({ id: "sess-a", cwd: CWD, text: "内容", at: 1_700_000_000_000 }),
			"utf8",
		);
		const result = await scanHistory({ root: dir, limit: 0 });
		expect(result.entries).toEqual([]);
		expect(result.states.size).toBe(1);
	});
});

describe("refreshSessions：limit 截断 + hasMore", () => {
	function transport() {
		const sent: ServerMessage[] = [];
		return { sent, port: { send: (msg: ServerMessage) => void sent.push(msg), isClosed: () => false } };
	}

	it("被 limit 截过时帧里带 hasMore: true，返回条目也只剩一页", async () => {
		const dir = sessionsDir();
		writeFileSync(join(dir, "a.jsonl"), transcript({ id: "a", cwd: CWD, text: "甲", at: 1_700_000_000_000 }), "utf8");
		writeFileSync(join(dir, "b.jsonl"), transcript({ id: "b", cwd: CWD, text: "乙", at: 1_600_000_000_000 }), "utf8");
		const t = transport();

		const result = await refreshSessions({ root: dir, cwd: CWD, transport: t.port, limit: 1 });

		expect(result.entries.map((entry) => entry.id)).toEqual(["a"]);
		expect(t.sent).toEqual([
			expect.objectContaining({
				type: "sessions",
				cwd: CWD,
				hasMore: true,
				sessions: [expect.objectContaining({ path: join(dir, "a.jsonl") })],
			}),
		]);
	});

	it("没被截断时不带 hasMore", async () => {
		const dir = sessionsDir();
		writeFileSync(join(dir, "a.jsonl"), transcript({ id: "a", cwd: CWD, text: "甲", at: 1_700_000_000_000 }), "utf8");
		const t = transport();

		await refreshSessions({ root: dir, cwd: CWD, transport: t.port, limit: 5 });

		expect(t.sent).toEqual([expect.objectContaining({ type: "sessions", cwd: CWD })]);
		expect(t.sent[0]).not.toHaveProperty("hasMore");
	});
});
