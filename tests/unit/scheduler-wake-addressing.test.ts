import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentService } from "../../server/agent-service.js";

/**
 * issue #959：唤醒的**寻址边界**。
 *
 * 这些断言盯的是「报告落到哪条对话」这个决定本身：
 * - 有活持有者 → 投给它，绝不另开一份 runtime；
 * - 没有持有者 → 按转录恢复一份，再投进**同一个**转录；
 * - 老任务只有运行时 id 且当前进程里有同名候选 → 拒绝，而不是猜一个。
 */

let dir: string;
let svc: AgentService;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "sched-wake-addr-"));
	svc = new AgentService(dir, join(dir, "client-state.json"));
});

afterEach(async () => {
	try {
		await svc.disposeAll();
	} catch {}
	rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function fakeSession(over: Record<string, unknown> = {}) {
	const steered: { id: string; text: string }[] = [];
	const opened: string[] = [];
	const convs = new Map<string, any>();
	const cs: any = {
		cwd: dir,
		steered,
		opened,
		flushSnapshot: () => {},
		findConversationBySessionFile: (path: string) => [...convs.values()].find((c) => c.session?.sessionFile === path),
		switchSession: async (path: string) => {
			opened.push(path);
			convs.set("c9", { id: "c9", session: { sessionFile: path } });
		},
		steerOwnConversation: async (id: string, text: string) => {
			steered.push({ id, text });
			return { ok: true };
		},
		getConversation: (id: string) => convs.get(id),
		...over,
	};
	return { cs, steered, opened, convs };
}

describe("wakeConversation 按转录寻址（#959）", () => {
	it("有活持有者：投给持有方，不再另开一份 runtime", async () => {
		const owner = fakeSession();
		owner.convs.set("c5", { id: "c5", session: { sessionFile: join(dir, "a.jsonl") } });
		(svc as any).clients = new Map([["user-1", owner.cs]]);
		vi.spyOn(svc, "findSessionOwner").mockReturnValue({
			clientId: "user-1",
			convId: "c5",
			title: "原对话",
			cwd: dir,
			isStreaming: false,
			connected: true,
		});
		const attach = vi.spyOn(svc as any, "attach");

		const r = await svc.wakeConversation("c2", "报告", {
			sessionFile: join(dir, "a.jsonl"),
			cwd: dir,
			taskId: "task-1",
		});

		expect(r).toMatchObject({ ok: true, conversationId: "c5", clientId: "user-1" });
		expect(owner.steered).toEqual([{ id: "c5", text: "报告" }]);
		expect(attach).not.toHaveBeenCalled();
	});

	it("没有持有者：按转录恢复一份后台持有方，再投进同一份转录", async () => {
		vi.spyOn(svc, "findSessionOwner").mockReturnValue(null);
		const wake = fakeSession();
		const attach = vi.spyOn(svc as any, "attach").mockResolvedValue(wake.cs);
		const file = join(dir, "b.jsonl");

		const r = await svc.wakeConversation("", "报告", { sessionFile: file, cwd: dir, taskId: "task-2" });

		expect(r).toMatchObject({ ok: true, conversationId: "c9", sessionFile: file, resumed: true });
		expect(attach).toHaveBeenCalledWith("scheduler:wake-task-2", expect.any(Function));
		expect(wake.opened).toEqual([file]);
		expect(wake.steered).toEqual([{ id: "c9", text: "报告" }]);
	});

	it("恢复失败：如实失败，绝不改投别的对话", async () => {
		vi.spyOn(svc, "findSessionOwner").mockReturnValue(null);
		const wake = fakeSession({
			switchSession: async () => {
				throw new Error("只能打开会话目录中的对话记录");
			},
		});
		vi.spyOn(svc as any, "attach").mockResolvedValue(wake.cs);

		const r = await svc.wakeConversation("c2", "报告", {
			sessionFile: join(dir, "gone.jsonl"),
			cwd: dir,
			taskId: "task-3",
		});

		expect(r.ok).toBe(false);
		expect(r.conversationId).toBeUndefined();
		expect(r.error).toContain("转录无法恢复");
		expect(wake.steered).toEqual([]);
	});

	it("老任务只有运行时 id：进程里出现同名候选时拒绝，不猜", async () => {
		const a = fakeSession();
		const b = fakeSession();
		a.convs.set("c2", { id: "c2", session: { sessionFile: join(dir, "a.jsonl") }, cwd: dir });
		b.convs.set("c2", { id: "c2", session: { sessionFile: join(dir, "b.jsonl") }, cwd: dir });
		(svc as any).clients = new Map([
			["user-1", a.cs],
			["user-2", b.cs],
		]);

		const r = await svc.wakeConversation("c2", "报告", { cwd: dir });

		expect(r.ok).toBe(false);
		expect(r.error).toContain("无法安全投递");
		expect(a.steered).toEqual([]);
		expect(b.steered).toEqual([]);
	});
});
