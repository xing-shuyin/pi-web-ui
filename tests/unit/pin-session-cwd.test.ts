import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientSession, pinnedPathsOwnedBy, sessionOwnerCwd } from "../../server/agent-service.js";
import { ClientStateStore } from "../../server/client-state.js";
import { fakeClientSession } from "../helpers/fake-session.js";

type AnySession = Record<string, (...args: unknown[]) => unknown>;

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

/** 造一个只有 header 的会话文件（readCwdFromSessionHeader 只读首行）。 */
function writeSession(dir: string, name: string, cwd: string | null): string {
	mkdirSync(dir, { recursive: true });
	const file = join(dir, name);
	writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, cwd })}\n`);
	return file;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("sessionOwnerCwd", () => {
	it("取会话 header 里的 cwd", async () => {
		const dir = tempDir("pi-pin-owner-");
		const file = writeSession(dir, "s.jsonl", "E:\\work\\project-b");
		await expect(sessionOwnerCwd(file, "E:\\work\\project-a")).resolves.toBe("E:\\work\\project-b");
	});

	it("文件不存在 / header 读不出来 → 回落到调用方给的 cwd", async () => {
		const dir = tempDir("pi-pin-owner-");
		await expect(sessionOwnerCwd(join(dir, "missing.jsonl"), "E:\\work\\project-a")).resolves.toBe(
			"E:\\work\\project-a",
		);
		const broken = join(dir, "broken.jsonl");
		writeFileSync(broken, "not json\n");
		await expect(sessionOwnerCwd(broken, "E:\\work\\project-a")).resolves.toBe("E:\\work\\project-a");
	});
});

describe("pinnedPathsOwnedBy", () => {
	it("只留属于当前项目的置顶路径；归属读不出来的保留", async () => {
		const dir = tempDir("pi-pin-filter-");
		const own = writeSession(dir, "own.jsonl", "E:\\work\\project-b");
		const foreign = writeSession(dir, "foreign.jsonl", "E:\\work\\project-a");
		const unreadable = join(dir, "gone.jsonl");

		const kept = await pinnedPathsOwnedBy([own, foreign, unreadable], "E:\\work\\project-b");
		expect(kept).toEqual([own, unreadable]);
	});

	it("大小写 / 分隔符差异不影响归属判定", async () => {
		const dir = tempDir("pi-pin-filter-");
		const file = writeSession(dir, "s.jsonl", "E:\\Work\\Project-B");
		await expect(pinnedPathsOwnedBy([file], "e:/work/project-b")).resolves.toEqual([file]);
	});
});

describe("pinSession：置顶按会话自身 cwd 记账", () => {
	it("在 A 项目里钉住 B 的会话 → 记在 B 名下，A 看不到", async () => {
		const dir = tempDir("pi-pin-session-");
		const projectA = join(dir, "project-a");
		const projectB = join(dir, "project-b");
		const store = new ClientStateStore(join(dir, "client-state.json"));
		const file = writeSession(join(dir, "sessions"), "b.jsonl", projectB);

		const cs = fakeClientSession({
			cwd: projectA,
			stateStore: store,
			convs: new Map(),
			emitConversations: vi.fn(),
			flushSnapshot: vi.fn(),
			refreshSessions: vi.fn(async () => {}),
		});

		await (ClientSession.prototype as unknown as AnySession).pinSession.call(cs, file, true);

		expect(store.isSessionPinned(projectB, file)).toBe(true);
		expect(store.isSessionPinned(projectA, file)).toBe(false);
	});

	it("取消置顶同样从会话自身项目里摘掉（在 A 视图下取消 B 的钉住）", async () => {
		const dir = tempDir("pi-pin-session-");
		const projectA = join(dir, "project-a");
		const projectB = join(dir, "project-b");
		const store = new ClientStateStore(join(dir, "client-state.json"));
		const file = writeSession(join(dir, "sessions"), "b.jsonl", projectB);
		store.setSessionPinned(projectB, file, true);

		const cs = fakeClientSession({
			cwd: projectA,
			stateStore: store,
			convs: new Map(),
			emitConversations: vi.fn(),
			flushSnapshot: vi.fn(),
			refreshSessions: vi.fn(async () => {}),
		});

		await (ClientSession.prototype as unknown as AnySession).pinSession.call(cs, file, false);
		expect(store.isSessionPinned(projectB, file)).toBe(false);
	});

	it("同一会话的对话被标记钉住并入列", async () => {
		const dir = tempDir("pi-pin-session-");
		const projectA = join(dir, "project-a");
		const file = writeSession(join(dir, "sessions"), "b.jsonl", projectA);
		const conv: Record<string, unknown> = {
			id: "c1",
			isSubagent: false,
			listed: false,
			goal: { reviewing: false },
			session: { isStreaming: false, isCompacting: false, sessionFile: file },
		};
		const cs = fakeClientSession({
			cwd: projectA,
			stateStore: new ClientStateStore(join(dir, "client-state.json")),
			convs: new Map([["c1", conv]]),
			emitConversations: vi.fn(),
			flushSnapshot: vi.fn(),
			refreshSessions: vi.fn(async () => {}),
		});

		await (ClientSession.prototype as unknown as AnySession).pinSession.call(cs, file, true);
		expect(conv.pinned).toBe(true);
		expect(conv.listed).toBe(true);
	});
});
