import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DshClientSession } from "../../server/dsh/dsh-agent-service.js";

type MockConv = {
	id: string;
	sessionId: string;
	isStreaming: boolean;
	messages: Array<{ id: string; role: string }>;
	messageIds: Set<string>;
	queue: { followUp: string[] };
	deltaSeq?: number;
};

describe("DshClientSession 核心正确性测试 (Issue #741)", () => {
	it("promptConv 发送失败时回滚乐观消息与排队气泡", async () => {
		const emitted: unknown[] = [];
		const conv: MockConv = {
			id: "c-1",
			sessionId: "sess-1",
			isStreaming: true,
			messages: [],
			messageIds: new Set<string>(),
			queue: { followUp: ["已有的一条排队文本"] },
			deltaSeq: 0,
		};

		const session = Object.assign(Object.create(DshClientSession.prototype), {
			activeId: "c-1",
			convs: new Map([["c-1", conv]]),
			cwd: "/workspace",
			runtime: {
				prompt: vi.fn().mockRejectedValue(new Error("网络断开")),
			},
			appendMessage: (c: MockConv, m: { id: string; role: string }) => {
				c.messages.push(m);
				c.messageIds.add(m.id);
			},
			flushSnapshot: vi.fn(),
			emit: (msg: unknown) => emitted.push(msg),
			emitConversations: vi.fn(),
		});

		await (DshClientSession.prototype as any).promptConv.call(session, conv, "这是一条要失败的消息");

		expect(conv.messages?.length).toBe(0);
		expect(conv.messageIds?.size).toBe(0);

		expect(conv.queue?.followUp).toEqual(["已有的一条排队文本"]);

		const errNotices = emitted.filter(
			(m) => (m as { type?: string }).type === "notice" && (m as { level?: string }).level === "error",
		);
		expect(errNotices.length).toBe(1);
		expect((errNotices[0] as { textEn?: string }).textEn).toContain("Failed to send prompt");
	});

	it("promptConv 成功时单项出队，不误删同名文本排队项", async () => {
		const conv: MockConv = {
			id: "c-1",
			sessionId: "sess-1",
			isStreaming: true,
			messages: [],
			messageIds: new Set<string>(),
			queue: { followUp: ["继续"] },
			deltaSeq: 0,
		};

		const session = Object.assign(Object.create(DshClientSession.prototype), {
			activeId: "c-1",
			convs: new Map([["c-1", conv]]),
			cwd: "/workspace",
			runtime: {
				prompt: vi.fn().mockResolvedValue(undefined),
			},
			appendMessage: (c: MockConv, m: { id: string; role: string }) => {
				c.messages.push(m);
				c.messageIds.add(m.id);
			},
			flushSnapshot: vi.fn(),
			emit: vi.fn(),
			emitConversations: vi.fn(),
		});

		await (DshClientSession.prototype as any).promptConv.call(session, conv, "继续");

		expect(conv.queue?.followUp).toEqual(["继续"]);
	});

	it("cleanupExpiredSessions 清理过期目录并剪枝活跃目录", async () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "pi-dsh-cleanup-test-"));
		try {
			const activeProj = join(tempRoot, "proj1");
			const expiredProj = join(tempRoot, "proj2");
			mkdirSync(activeProj, { recursive: true });
			mkdirSync(expiredProj, { recursive: true });

			const activeDir = join(activeProj, "sess-active");
			const expiredDir = join(expiredProj, "sess-expired");
			mkdirSync(activeDir, { recursive: true });
			mkdirSync(expiredDir, { recursive: true });

			const fActive = join(activeDir, "log.jsonl");
			const fExpired = join(expiredDir, "log.jsonl");
			writeFileSync(fActive, '{"event":"init"}');
			writeFileSync(fExpired, '{"event":"init"}');

			const hundredDaysAgo = (Date.now() - 100 * 24 * 3600_000) / 1000;
			utimesSync(fExpired, hundredDaysAgo, hundredDaysAgo);

			const session = Object.assign(Object.create(DshClientSession.prototype), {
				disposed: false,
				sessionRoot: tempRoot,
				scheduleSessionsRefresh: vi.fn(),
			});

			await (DshClientSession.prototype as any).cleanupExpiredSessions.call(session);

			expect(existsSync(expiredDir)).toBe(false);
			expect(existsSync(activeDir)).toBe(true);
		} finally {
			try {
				rmSync(tempRoot, { recursive: true, force: true });
			} catch {}
		}
	});
});
