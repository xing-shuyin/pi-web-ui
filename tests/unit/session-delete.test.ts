import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Conversation, ConversationRegistry } from "../../packages/keel/src/kernel/conversation/index.js";
import { deleteProjectSessions, deleteSession } from "../../packages/keel/src/app/session-delete.js";
import type { ServerMessage } from "../../packages/keel/src/protocol.js";

function seedTranscript(root: string, cwd: string, name: string): string {
	const dir = join(root, "sessions", "proj");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${name}.jsonl`);
	writeFileSync(
		file,
		JSON.stringify({ type: "session", version: 3, id: name, timestamp: "2026-08-04T00:00:00.000Z", cwd }) + "\n",
	);
	return file;
}

describe("session-delete", () => {
	it("跨项目删除时向 refreshSessions 传入转录所属的 cwd 并等待刷新完成", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-session-del-unit-"));
		const otherCwd = join(root, "other-proj");
		const file = seedTranscript(root, otherCwd, "other-1");
		const registry = new ConversationRegistry<Conversation>();
		const sent: ServerMessage[] = [];
		const refreshed: Array<string | undefined> = [];
		let refreshDone = false;

		await deleteSession(
			{
				registry,
				transport: () => ({ send: (m) => sent.push(m), isClosed: () => false }),
				historyRoot: () => join(root, "sessions", "proj"),
				historyState: () => new Map(),
				switchSessionTo: async () => {},
				createBlankConversation: () => {},
				isAllowedPath: () => true,
				now: () => 1000,
				refreshSessions: async (targetCwd?: string) => {
					await new Promise((r) => setTimeout(r, 10));
					refreshed.push(targetCwd);
					refreshDone = true;
				},
			},
			file,
		);

		expect(existsSync(file)).toBe(false);
		expect(refreshDone).toBe(true);
		expect(refreshed).toEqual([otherCwd]);
		expect(sent).toEqual([]);
	});

	it("文件已不存在时仍清理钉子、刷新目标项目列表并发送提示", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-session-del-missing-"));
		const missing = join(root, "sessions", "proj", "gone.jsonl");
		const registry = new ConversationRegistry<Conversation>();
		const sent: ServerMessage[] = [];
		const clearPinnedSession = vi.fn();
		const refreshSessions = vi.fn();

		await deleteSession(
			{
				registry,
				transport: () => ({ send: (m) => sent.push(m), isClosed: () => false }),
				historyRoot: () => undefined,
				historyState: () => new Map(),
				switchSessionTo: async () => {},
				createBlankConversation: () => {},
				isAllowedPath: () => true,
				now: () => 1000,
				refreshSessions,
				clearPinnedSession,
			},
			missing,
		);

		expect(clearPinnedSession).toHaveBeenCalledWith(missing);
		expect(refreshSessions).toHaveBeenCalledTimes(1);
		expect(sent.some((m) => m.type === "notice" && m.level === "error" && m.text.includes("已不存在"))).toBe(true);
	});

	it("后台占用拒绝删除时刷新列表以回滚前端乐观状态", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-session-del-bg-"));
		const bgCwd = join(root, "bg-proj");
		const file = seedTranscript(root, bgCwd, "bg-1");
		const registry = new ConversationRegistry<Conversation>();
		const c1 = new Conversation({
			id: "c1",
			kind: "user",
			clientId: "test",
			cwd: bgCwd,
			createdAt: 1,
			sessionFile: file,
		});
		const c2 = new Conversation({ id: "c2", kind: "user", clientId: "test", cwd: bgCwd, createdAt: 2 });
		registry.add(c1);
		registry.add(c2);
		registry.activate("c2");

		const sent: ServerMessage[] = [];
		const refreshSessions = vi.fn();

		await deleteSession(
			{
				registry,
				transport: () => ({ send: (m) => sent.push(m), isClosed: () => false }),
				historyRoot: () => undefined,
				historyState: () => new Map(),
				switchSessionTo: async () => {},
				createBlankConversation: () => {},
				isAllowedPath: () => true,
				now: () => 1000,
				refreshSessions,
			},
			file,
		);

		expect(existsSync(file)).toBe(true);
		expect(refreshSessions).toHaveBeenCalledWith(bgCwd);
		expect(sent.some((m) => m.type === "notice" && m.level === "warning" && m.text.includes("后台运行"))).toBe(true);
	});

	it("deleteProjectSessions 批量删除项目内所有非后台对话并刷新目标项目列表", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-proj-del-unit-"));
		const projCwd = join(root, "target-proj");
		const f1 = seedTranscript(root, projCwd, "s1");
		const f2 = seedTranscript(root, projCwd, "s2");
		const fBg = seedTranscript(root, projCwd, "sbg");
		const registry = new ConversationRegistry<Conversation>();
		const cActive = new Conversation({
			id: "c1",
			kind: "user",
			clientId: "test",
			cwd: projCwd,
			createdAt: 1,
			sessionFile: f1,
		});
		const cBg = new Conversation({
			id: "c2",
			kind: "user",
			clientId: "test",
			cwd: projCwd,
			createdAt: 2,
			sessionFile: fBg,
		});
		registry.add(cActive);
		registry.add(cBg);
		registry.activate("c1");

		const sent: ServerMessage[] = [];
		const refreshed: Array<string | undefined> = [];
		let blankCreated = false;

		await deleteProjectSessions(
			{
				registry,
				transport: () => ({ send: (m) => sent.push(m), isClosed: () => false }),
				historyRootFor: () => join(root, "sessions", "proj"),
				historyState: () => new Map(),
				createBlankConversation: () => {
					blankCreated = true;
				},
				isAllowedPath: () => true,
				now: () => 1000,
				refreshSessions: async (targetCwd?: string) => {
					refreshed.push(targetCwd);
				},
			},
			projCwd,
		);

		expect(blankCreated).toBe(true);
		expect(registry.has("c1")).toBe(false);
		expect(existsSync(f1)).toBe(false);
		expect(existsSync(f2)).toBe(false);
		expect(existsSync(fBg)).toBe(true);
		expect(refreshed).toEqual([projCwd]);
		expect(sent.some((m) => m.type === "notice" && m.level === "warning")).toBe(true);
	});
});
