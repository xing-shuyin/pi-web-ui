import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TransportPort } from "../../packages/keel/src/contracts/ports.js";
import type { ServerMessage } from "../../server/protocol.js";
import type { SessionListScanState } from "../../server/session-list-scan.js";
import {
	buildSessionsFrame,
	type HistoryEntry,
	refreshSessions,
	scanHistory,
} from "../../packages/keel/src/domains/history/index.js";

const CWD = "/p/demo";

class FakeTransport implements TransportPort {
	readonly sent: ServerMessage[] = [];
	closed = false;

	send(msg: ServerMessage): void {
		this.sent.push(msg);
	}

	isClosed(): boolean {
		return this.closed;
	}
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

function sessionsDir(): string {
	return mkdtempSync(join(tmpdir(), "core-sessions-frame-"));
}

function transcript(opts: { id: string; cwd?: string; texts?: string[]; at?: number }): string {
	const at = opts.at ?? 1_700_000_000_000;
	const lines = [
		JSON.stringify({
			type: "session",
			id: opts.id,
			cwd: opts.cwd ?? CWD,
			timestamp: "2026-01-02T03:04:05.000Z",
		}),
	];
	(opts.texts ?? []).forEach((text, index) => {
		lines.push(
			JSON.stringify({
				type: "message",
				id: `m${index}`,
				parentId: index === 0 ? null : `m${index - 1}`,
				timestamp: new Date(at).toISOString(),
				message: { role: "user", content: text, timestamp: at },
			}),
		);
	});
	return lines.join("\n") + "\n";
}

describe("buildSessionsFrame：帧形状", () => {
	it("出 type: sessions，cwd 原样回显，sessions 顺序与入参一致", () => {
		const frame = buildSessionsFrame({
			cwd: CWD,
			entries: [entry({ id: "a", updatedAt: 900 }), entry({ id: "b", updatedAt: 100 })],
		});
		expect(frame.type).toBe("sessions");
		expect(frame).toMatchObject({ type: "sessions", cwd: CWD });
		expect(frame.type === "sessions" && frame.sessions.map((s) => s.path)).toEqual([
			"/sessions/a.jsonl",
			"/sessions/b.jsonl",
		]);
	});

	it("空列表也出合法帧：sessions 为 [] 但保留 cwd", () => {
		const frame = buildSessionsFrame({ cwd: CWD, entries: [] });
		expect(frame).toMatchObject({ type: "sessions", sessions: [], cwd: CWD });
	});

	it("不给 hasMore 时帧里根本没有这个字段", () => {
		const frame = buildSessionsFrame({ cwd: CWD, entries: [entry({ id: "a" })] });
		expect("hasMore" in frame).toBe(false);
	});

	it("hasMore: true 原样透传", () => {
		const frame = buildSessionsFrame({ cwd: CWD, entries: [entry({ id: "a" })], hasMore: true });
		expect(frame).toMatchObject({ hasMore: true });
	});

	it("hasMore: false 与不给等价：不写这个字段", () => {
		const frame = buildSessionsFrame({ cwd: CWD, entries: [], hasMore: false });
		expect("hasMore" in frame).toBe(false);
	});
});

describe("buildSessionsFrame：HistoryEntry → SessionSummary", () => {
	it("字段逐项映射：path / name / displayName / firstMessage / messageCount / modified / cwd", () => {
		const frame = buildSessionsFrame({
			cwd: CWD,
			entries: [
				entry({
					id: "a",
					title: "会话标题",
					cwd: "/p/demo",
					updatedAt: 1_700_000_000_123,
					sessionFile: "/sessions/a.jsonl",
					messageCount: 7,
				}),
			],
		});
		expect(frame.type === "sessions" && frame.sessions[0]).toEqual({
			path: "/sessions/a.jsonl",
			name: "会话标题",
			displayName: "会话标题",
			firstMessage: "会话标题",
			messageCount: 7,
			modified: 1_700_000_000_123,
			cwd: "/p/demo",
		});
	});

	it("控件字段（sessionId / source / pinned / nativeCli / parentSessionPath）一个都不编造", () => {
		const frame = buildSessionsFrame({ cwd: CWD, entries: [entry({ id: "a" })] });
		const summary = frame.type === "sessions" ? frame.sessions[0] : undefined;
		expect(Object.keys(summary ?? {}).sort()).toEqual([
			"cwd",
			"displayName",
			"firstMessage",
			"messageCount",
			"modified",
			"name",
			"path",
		]);
	});

	it("messageCount 为 0 时照写 0（不是省略字段）", () => {
		const frame = buildSessionsFrame({ cwd: CWD, entries: [entry({ id: "a", messageCount: 0 })] });
		const summary = frame.type === "sessions" ? frame.sessions[0] : undefined;
		expect(summary?.messageCount).toBe(0);
		expect(summary !== undefined && "messageCount" in summary).toBe(true);
	});

	it("不改动入参（同一份 entries 连出两帧结果相同）", () => {
		const entries = [entry({ id: "a", messageCount: 3 })];
		const snapshot = structuredClone(entries);
		const first = buildSessionsFrame({ cwd: CWD, entries });
		const second = buildSessionsFrame({ cwd: CWD, entries });
		expect(entries).toEqual(snapshot);
		expect(second).toEqual(first);
	});
});

describe("refreshSessions：扫目录 → 推一帧", () => {
	it("真实目录：发一帧且与 buildSessionsFrame(scanHistory) 完全一致", async () => {
		const dir = sessionsDir();
		writeFileSync(join(dir, "a.jsonl"), transcript({ id: "sess-a", texts: ["你好", "再说一句"] }), "utf8");
		const transport = new FakeTransport();

		const result = await refreshSessions({ root: dir, cwd: CWD, transport });

		expect(transport.sent).toHaveLength(1);
		expect(transport.sent[0]).toEqual(buildSessionsFrame({ cwd: CWD, entries: result.entries, hasMore: false }));
		expect(result.entries).toHaveLength(1);
		expect(result.states.has(join(dir, "a.jsonl"))).toBe(true);
	});

	it("通道已关闭：一帧都不发，但条目与续扫状态照常交回", async () => {
		const dir = sessionsDir();
		writeFileSync(join(dir, "a.jsonl"), transcript({ id: "sess-a", texts: ["内容"] }), "utf8");
		const transport = new FakeTransport();
		transport.closed = true;

		const result = await refreshSessions({ root: dir, cwd: CWD, transport });

		expect(transport.sent).toEqual([]);
		expect(result.entries.map((e) => e.id)).toEqual(["sess-a"]);
		expect(result.states.size).toBe(1);
	});

	it("目录不存在：不抛，发一帧空列表", async () => {
		const transport = new FakeTransport();
		const result = await refreshSessions({ root: join(sessionsDir(), "no-such-dir"), cwd: CWD, transport });

		expect(result.entries).toEqual([]);
		expect(result.states.size).toBe(0);
		expect(transport.sent).toEqual([{ type: "sessions", sessions: [], cwd: CWD }]);
	});

	it("states 能续用：第二轮扫到中途新增的文件，老条目也不丢", async () => {
		const dir = sessionsDir();
		writeFileSync(join(dir, "old.jsonl"), transcript({ id: "old", texts: ["旧会话"], at: 1_600_000_000_000 }), "utf8");
		const transport = new FakeTransport();
		const first = await refreshSessions({ root: dir, cwd: CWD, transport });

		writeFileSync(join(dir, "new.jsonl"), transcript({ id: "new", texts: ["新会话"], at: 1_700_000_000_000 }), "utf8");
		const second = await refreshSessions({ root: dir, cwd: CWD, transport, state: first.states });

		expect(first.entries.map((e) => e.id)).toEqual(["old"]);
		expect(second.entries.map((e) => e.id)).toEqual(["new", "old"]);
		expect(second.states.size).toBe(2);
		expect(transport.sent).toHaveLength(2);
		const frame = transport.sent[1];
		expect(frame?.type === "sessions" ? frame.sessions.map((s) => s.path) : []).toEqual([
			join(dir, "new.jsonl"),
			join(dir, "old.jsonl"),
		]);
	});

	it("limit 截断：帧里带 hasMore: true，续扫状态仍覆盖全部文件", async () => {
		const dir = sessionsDir();
		writeFileSync(join(dir, "old.jsonl"), transcript({ id: "old", texts: ["旧"], at: 1_600_000_000_000 }), "utf8");
		writeFileSync(join(dir, "new.jsonl"), transcript({ id: "new", texts: ["新"], at: 1_700_000_000_000 }), "utf8");
		const transport = new FakeTransport();

		const result = await refreshSessions({ root: dir, cwd: CWD, transport, limit: 1 });

		expect(result.entries.map((e) => e.id)).toEqual(["new"]);
		expect(result.states.size).toBe(2);
		expect(transport.sent[0]).toMatchObject({ hasMore: true });
	});

	it("没截断时帧里不带 hasMore", async () => {
		const dir = sessionsDir();
		writeFileSync(join(dir, "a.jsonl"), transcript({ id: "sess-a", texts: ["一"] }), "utf8");
		const transport = new FakeTransport();

		await refreshSessions({ root: dir, cwd: CWD, transport, limit: 5 });

		expect("hasMore" in (transport.sent[0] ?? {})).toBe(false);
	});
});

describe("messageCount：透传与回落", () => {
	it("两条消息的会话透传 2，并出现在帧里", async () => {
		const dir = sessionsDir();
		writeFileSync(join(dir, "a.jsonl"), transcript({ id: "sess-a", texts: ["一", "二"] }), "utf8");
		const transport = new FakeTransport();

		const result = await refreshSessions({ root: dir, cwd: CWD, transport });

		expect(result.entries[0]?.messageCount).toBe(2);
		expect(transport.sent[0]?.type === "sessions" ? transport.sent[0].sessions[0]?.messageCount : undefined).toBe(2);
	});

	it("空会话（只有 header）是 0 条", async () => {
		const dir = sessionsDir();
		writeFileSync(join(dir, "empty.jsonl"), transcript({ id: "sess-empty" }), "utf8");

		const result = await scanHistory({ root: dir });

		expect(result.entries[0]?.messageCount).toBe(0);
	});

	it("老索引状态缺 messageCount 时回落 0（不出 undefined）", async () => {
		const dir = sessionsDir();
		const file = join(dir, "a.jsonl");
		writeFileSync(file, transcript({ id: "sess-a", texts: ["内容"] }), "utf8");
		const first = await scanHistory({ root: dir });

		const legacy: Record<string, unknown> = { ...first.states.get(file) };
		delete legacy.messageCount;
		const states = new Map([[file, legacy as unknown as SessionListScanState]]);

		const second = await scanHistory({ root: dir, state: states });

		expect(second.entries[0]?.messageCount).toBe(0);
	});
});
