import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeClientSession } from "../helpers/fake-session.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function seedTranscript(): { agentDir: string; file: string } {
	const root = mkdtempSync(join(tmpdir(), "pi-del-session-"));
	roots.push(root);
	const agentDir = join(root, "agent");
	const dir = join(agentDir, "sessions", "--proj--");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "2026-01-01T00-00-00-000Z_seed.jsonl");
	writeFileSync(file, '{"type":"session","version":3}\n');
	return { agentDir, file };
}

interface Harness {
	cs: ReturnType<typeof fakeClientSession>;
	file: string;
	emit: ReturnType<typeof vi.fn>;
	removeConversation: ReturnType<typeof vi.fn>;
}

function harness(opts: { streaming?: boolean; compacting?: boolean; releaseable?: boolean } = {}): Harness {
	const { agentDir, file } = seedTranscript();
	const emit = vi.fn();
	const conv: Record<string, unknown> = {
		id: "c-held",
		title: "持有转录的对话",
		isSubagent: false,
		listed: true,
		pinned: false,
		goal: { reviewing: false },
		wizardRunning: false,
		terminals: { countBlockingLive: () => 0, countUserBlockingLive: () => 0, killAll: () => {} },
		session: {
			sessionFile: file,
			isStreaming: opts.streaming === true,
			isCompacting: opts.compacting === true,
		},
	};
	const releaseable = opts.releaseable !== false;
	const removeConversation = vi.fn((id: string) => {
		if (releaseable) cs.convs.delete(id);
	});
	const cs = fakeClientSession({
		agentDir,
		activeId: "c-held",
		convs: new Map([[(conv as { id: string }).id, conv]]),
		emit,
		newChat: vi.fn(async () => {}),
		loadSessionInfos: vi.fn(async () => []),
		switchSession: vi.fn(async () => {}),
		removeConversation,
		findSessionOwner: () => undefined,
		invalidateSessionInfos: () => {},
		refreshSessions: vi.fn(async () => {}),
		stateStore: { cleanPinnedSession: () => {} },
		drafts: { pruneSessionFile: () => {} },
	});
	return { cs, file, emit, removeConversation };
}

describe("deleteSession — 持有者判定（展示口径 vs 运行态）", () => {
	it("空闲但被保留（listed）的持有者 → 放掉并删除转录", async () => {
		const { cs, file, emit, removeConversation } = harness();

		await cs.deleteSession(file);

		expect(removeConversation).toHaveBeenCalledWith("c-held");
		expect(existsSync(file)).toBe(false);
		expect(emit).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: "notice", text: expect.stringContaining("仍在后台运行") }),
		);
	});

	it("真在跑（streaming）→ 拒绝删除、保留转录、放掉动作也不发生", async () => {
		const { cs, file, emit, removeConversation } = harness({ streaming: true });

		await cs.deleteSession(file);

		expect(removeConversation).not.toHaveBeenCalled();
		expect(existsSync(file)).toBe(true);
		expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: "notice", level: "warning" }));
	});

	it("上下文压缩中（compacting）同样算运行态", async () => {
		const { cs, file, removeConversation } = harness({ compacting: true });

		await cs.deleteSession(file);

		expect(removeConversation).not.toHaveBeenCalled();
		expect(existsSync(file)).toBe(true);
	});

	it("放不掉（仍被持有）→ 拒绝删除并提示，绝不硬删", async () => {
		const { cs, file, emit } = harness({ releaseable: false });

		await cs.deleteSession(file);

		expect(existsSync(file)).toBe(true);
		expect(emit).toHaveBeenCalledWith(
			expect.objectContaining({ type: "notice", level: "warning", text: expect.stringContaining("仍被占用") }),
		);
	});
});
