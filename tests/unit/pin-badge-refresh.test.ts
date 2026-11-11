import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientSession } from "../../server/agent-service.js";
import { ClientStateStore } from "../../server/client-state.js";
import { fakeClientSession, protoMethod } from "../helpers/fake-session.js";

type AnySession = Record<string, (...args: unknown[]) => unknown>;

const setConversationPinned = protoMethod(ClientSession.prototype, "setConversationPinned") as unknown as (
	this: unknown,
	id: string,
	pinned: boolean,
) => Promise<void>;
const pinSession = protoMethod(ClientSession.prototype, "pinSession") as unknown as (
	this: unknown,
	path: string,
	pinned: boolean,
) => Promise<void>;

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function writeSession(dir: string, cwd: string): string {
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "s.jsonl");
	writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, cwd })}\n`);
	return file;
}

function conv(id: string, cwd: string, sessionFile: string, pinned = false) {
	return {
		id,
		cwd,
		title: id,
		pinned,
		session: { sessionFile },
		isSubagent: false,
	} as unknown as { id: string; cwd: string; pinned?: boolean; session: { sessionFile: string } };
}

/** 一个只关心「推了哪个项目的列表」的假会话。 */
function fake(overrides: Record<string, unknown>) {
	const pushSessionsForCwd = vi.fn<(cwd: string) => Promise<void>>(async () => {});
	const refreshSessions = vi.fn(async () => {});
	const cs = fakeClientSession({
		cwd: "/project-a",
		convs: new Map(),
		stateStore: { setSessionPinned: vi.fn() },
		pushSessionsForCwd,
		refreshSessions,
		emitConversations: vi.fn(),
		flushSnapshot: vi.fn(),
		emit: vi.fn(),
		...overrides,
	});
	return { cs, pushSessionsForCwd, refreshSessions };
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("取消钉住后历史行的 📌 立即消失", () => {
	it("pin_conversation 取消钉住：推该会话自己 cwd 的列表", async () => {
		const { cs, pushSessionsForCwd } = fake({
			convs: new Map([["conv-b", conv("conv-b", "E:\\work\\project-b", "E:\\s\\b.jsonl", true)]]),
		});

		await setConversationPinned.call(cs, "conv-b", false);
		await vi.waitFor(() => expect(pushSessionsForCwd).toHaveBeenCalledTimes(1));
		expect(pushSessionsForCwd.mock.calls[0][0]).toBe("E:\\work\\project-b");
		expect((cs as unknown as { convs: Map<string, { pinned?: boolean }> }).convs.get("conv-b")?.pinned).toBeUndefined();
	});

	it("钉住时也推：摘要里的 pinned 变 true 同样是这里算出来的", async () => {
		const { cs, pushSessionsForCwd } = fake({
			convs: new Map([["conv-b", conv("conv-b", "E:\\work\\project-b", "E:\\s\\b.jsonl")]]),
		});

		await setConversationPinned.call(cs, "conv-b", true);
		await vi.waitFor(() => expect(pushSessionsForCwd).toHaveBeenCalledTimes(1));
		expect(pushSessionsForCwd.mock.calls[0][0]).toBe("E:\\work\\project-b");
	});

	it("pin_session 取消钉住且会话属于当前项目：刷当前项目的列表", async () => {
		const dir = tempDir("pi-pin-badge-");
		const file = writeSession(dir, "E:\\work\\project-a");
		const store = new ClientStateStore(join(dir, "client-state.json"));
		const { cs, pushSessionsForCwd, refreshSessions } = fake({
			cwd: "E:\\work\\project-a",
			stateStore: store,
			convs: new Map([["conv-a", conv("conv-a", "E:\\work\\project-a", file, true)]]),
		});

		await pinSession.call(cs, file, false);
		expect(refreshSessions).toHaveBeenCalledTimes(1);
		expect(pushSessionsForCwd).not.toHaveBeenCalled();
		expect(store.isSessionPinned("E:\\work\\project-a", file)).toBe(false);
	});

	it("pin_session 取消钉住且会话属于别的项目：推那个项目的列表，不动当前项目", async () => {
		const dir = tempDir("pi-pin-badge-");
		const file = writeSession(dir, "E:\\work\\project-b");
		const store = new ClientStateStore(join(dir, "client-state.json"));
		store.setSessionPinned("E:\\work\\project-b", file, true);
		const { cs, pushSessionsForCwd, refreshSessions } = fake({
			cwd: "E:\\work\\project-a",
			stateStore: store,
			convs: new Map([["conv-b", conv("conv-b", "E:\\work\\project-b", file, true)]]),
		});

		await pinSession.call(cs, file, false);
		await vi.waitFor(() => expect(pushSessionsForCwd).toHaveBeenCalledTimes(1));
		expect(pushSessionsForCwd.mock.calls[0][0]).toBe("E:\\work\\project-b");
		expect(refreshSessions).not.toHaveBeenCalled();
		expect(store.isSessionPinned("E:\\work\\project-b", file)).toBe(false);
		expect((cs as unknown as { convs: Map<string, { pinned?: boolean }> }).convs.get("conv-b")?.pinned).toBeUndefined();
	});
});
