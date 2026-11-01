/**
 * `deleteSession` 的「持有者」判定回归（issue 复盘：`listed` 被当成运行态）。
 *
 * 场景：删除**当前对话**持有的转录。`deleteSession` 会先切走（这里用 newChat 代替），
 * 再复检「这份转录是否还被某个对话持有」。位移可能把旧对话**保留**下来（`listed`），
 * 而 `listed` 是左侧栏运行列表的**展示口径**，不是运行态。历史实现把它当运行态：
 *   → 删除唯一会话必然收到「对话仍在后台运行，已停止删除」，转录永远留在磁盘。
 *   （冒烟 left-panel-delete-test 自 2026-10-31 起一直红，因为 unit 先红把 smoke 跳过了。）
 *
 * 口径（本测试锁住）：
 *   1. 空闲但被保留的持有者 → 放掉它、删掉转录（用户点的是删除）；
 *   2. 真在跑（streaming / compacting）→ 拒绝删除并保留转录；
 *   3. 放不掉（仍被持有）→ 拒绝删除并提示，绝不硬删活 writer 身下的文件。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeClientSession } from "../helpers/fake-session.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** 造一个在 `<agentDir>/sessions/…` 下的转录文件（deleteSession 只允许删这里的）。 */
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

/**
 * 造「当前对话持有转录、切走后被保留」的最小宿主。
 * 只替换与本行为无关的副作用（会话列表 / 磁盘刷新 / 钉住与草稿清理），
 * 保留 `deleteSession` 自己的判定链路。
 */
function harness(opts: { streaming?: boolean; compacting?: boolean; releaseable?: boolean } = {}): Harness {
	const { agentDir, file } = seedTranscript();
	const emit = vi.fn();
	const conv: Record<string, unknown> = {
		id: "c-held",
		title: "持有转录的对话",
		isSubagent: false,
		listed: true, // ← 展示口径：在运行列表里，但没在跑
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
		// 切走：用 newChat 代替（真实实现会新建空白对话，旧对话按位移规则保留或释放）
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
		// 不得再误报「仍在后台运行」
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
