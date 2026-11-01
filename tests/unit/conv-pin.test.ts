import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientSession } from "../../server/agent-service.js";
import { ClientStateStore } from "../../server/client-state.js";
import { fakeClientSession } from "../helpers/fake-session.js";

/* 钉住（常驻运行列表）只走两处接线：setConversationPinned 改标记，
 * displaceActive 把标记喂给 shouldRetainActive。决策真值由
 * wait-subscription-scan.test.ts 覆盖；这里只验证「钉住 → 切走不释放」
 * 这条端到端路径真的被接上了。 */

type AnySession = Record<string, (...args: unknown[]) => unknown>;

function fakeConv(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "c1",
		isSubagent: false,
		pinned: undefined,
		listed: false,
		promptedSinceActive: false,
		goal: { reviewing: false },
		wizardRunning: false,
		session: { isStreaming: false, isCompacting: false, sessionFile: undefined },
		terminals: { countBlockingLive: () => 0, countUserBlockingLive: () => 0 },
		...overrides,
	};
}

function priv(name: string): (this: unknown, ...args: unknown[]) => unknown {
	return (ClientSession.prototype as unknown as Record<string, (this: unknown, ...a: unknown[]) => unknown>)[name];
}

describe("钉住（pinned）会话", () => {
	it("空闲、无终端、未继续对话：未钉住 → 可置换；钉住 → 保留并置 listed", () => {
		const conv = fakeConv();
		const cs = fakeClientSession({ conv, convs: new Map([["c1", conv]]) });

		// 未钉住：全部保留判据都不命中 → 返回待移除对象。
		const displaced = priv("displaceActive").call(cs);
		expect(displaced).toBe(conv);

		// 钉住后同样的空闲态 → 保留，且 listed 被置位（左栏立刻可见）。
		conv.pinned = true as boolean;
		expect(priv("displaceActive").call(cs)).toBeNull();
		expect(conv.listed).toBe(true);
	});

	it("displaceActive 把 pinned 喂进决策：子代理行不受钉住影响（本来就保留）", () => {
		const conv = fakeConv({ isSubagent: true, pinned: true });
		const cs = fakeClientSession({ conv, convs: new Map([["c1", conv]]) });
		expect(priv("displaceActive").call(cs)).toBeNull();
		expect(conv.listed).toBe(true);
	});

	it("setConversationPinned：钉住立即入列、取消钉住只清标记不移出", async () => {
		const emitted: unknown[] = [];
		const conv = fakeConv({ title: "我的对话" });
		let emitCalls = 0;
		const cs = {
			emit: (msg: unknown) => emitted.push(msg),
			flushSnapshot: vi.fn(),
			emitConversations: () => {
				emitCalls++;
			},
			convs: new Map([["c1", conv]]),
		} as unknown as ClientSession;

		await (ClientSession.prototype as unknown as AnySession).setConversationPinned.call(cs, "c1", true);
		expect(conv.pinned).toBe(true);
		expect(conv.listed).toBe(true);
		expect(emitCalls).toBeGreaterThanOrEqual(1);

		// 取消钉住：清掉标记，但不移出（下次自然置换时按常规规则处理）。
		await (ClientSession.prototype as unknown as AnySession).setConversationPinned.call(cs, "c1", false);
		expect(conv.pinned).toBeUndefined();
		expect((cs as unknown as { convs: Map<string, unknown> }).convs.get("c1")).toBe(conv);
		expect(emitCalls).toBe(2);
	});

	it("setConversationPinned：不存在的对话 / 子代理 / 重复请求均安全", async () => {
		const emitted: unknown[] = [];
		const cs = {
			emit: (msg: unknown) => emitted.push(msg),
			flushSnapshot: vi.fn(),
			emitConversations: vi.fn(),
			convs: new Map(),
		} as unknown as ClientSession;

		await (ClientSession.prototype as unknown as AnySession).setConversationPinned.call(cs, "nope", true);
		expect(emitted).toContainEqual(expect.objectContaining({ level: "warning" }));

		const sub = fakeConv({ isSubagent: true });
		const cs2 = {
			emit: (msg: unknown) => emitted.push(msg),
			flushSnapshot: vi.fn(),
			emitConversations: vi.fn(),
			convs: new Map([["s1", sub]]),
		} as unknown as ClientSession;
		await (ClientSession.prototype as unknown as AnySession).setConversationPinned.call(cs2, "s1", true);
		expect(sub.pinned).toBeUndefined();
		expect(sub.listed).toBe(false);

		// 已是该状态时不改动、只重推一次列表。
		const pinned = fakeConv({ pinned: true, listed: true });
		const emitSpy = vi.fn();
		const cs3 = {
			emit: () => {},
			flushSnapshot: vi.fn(),
			emitConversations: emitSpy,
			convs: new Map([["c3", pinned]]),
		} as unknown as ClientSession;
		await (ClientSession.prototype as unknown as AnySession).setConversationPinned.call(cs3, "c3", true);
		expect(emitSpy).toHaveBeenCalledTimes(1);
	});

	it("ClientStateStore：已钉住会话持久化与清理 (issue #433)", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-pin-test-"));
		const store = new ClientStateStore(join(dir, "client-state.json"));
		const cwd = join(dir, "project1");
		const sess1 = join(dir, "session-1.jsonl");
		const sess2 = join(dir, "session-2.jsonl");

		expect(store.getPinnedSessions(cwd)).toEqual([]);
		expect(store.isSessionPinned(cwd, sess1)).toBe(false);

		// 钉住 session 1
		store.setSessionPinned(cwd, sess1, true);
		expect(store.isSessionPinned(cwd, sess1)).toBe(true);
		expect(store.isSessionPinned(cwd, sess2)).toBe(false);
		expect(store.getPinnedSessions(cwd).length).toBe(1);

		// 钉住 session 2
		store.setSessionPinned(cwd, sess2, true);
		expect(store.getPinnedSessions(cwd).length).toBe(2);

		// 重新加载（跨实例模拟服务重启）
		const store2 = new ClientStateStore(join(dir, "client-state.json"));
		expect(store2.isSessionPinned(cwd, sess1)).toBe(true);
		expect(store2.isSessionPinned(cwd, sess2)).toBe(true);

		// 取消钉住 session 1
		store2.setSessionPinned(cwd, sess1, false);
		expect(store2.isSessionPinned(cwd, sess1)).toBe(false);
		expect(store2.isSessionPinned(cwd, sess2)).toBe(true);

		// 会话文件删除时自动清理
		store2.cleanPinnedSession(sess2);
		expect(store2.isSessionPinned(cwd, sess2)).toBe(false);
		expect(store2.getPinnedSessions(cwd)).toEqual([]);

		rmSync(dir, { recursive: true, force: true });
	});
});
