import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { isPersistedSession, persistSessionFile } from "../../packages/keel/src/adapters/sdk/session-persist.js";
import {
	createPersistConversationHandlers,
	type SessionPersistPort,
} from "../../packages/keel/src/domains/sessions/index.js";
import { Conversation, ConversationRegistry } from "../../packages/keel/src/kernel/conversation/index.js";

function conversation(id = "c1"): Conversation {
	return new Conversation({ id, clientId: "cl-1", cwd: "/w", title: "子任务", kind: "user", createdAt: 1 });
}

function runtime(over: { session?: unknown; persist?: SessionPersistPort; conversation?: boolean } = {}) {
	const registry = new ConversationRegistry<Conversation>();
	const conv = conversation();
	if (over.conversation !== false) registry.add(conv);
	const notices: Array<{ level: string; text: string }> = [];
	const events: string[] = [];
	return {
		notices,
		events,
		registry,
		handlers: createPersistConversationHandlers({
			registry,
			sessionOf: () => over.session,
			sessionBaseDirOf: (c) => c.meta.cwd,
			pushConversations: () => void events.push("conversations"),
			pushProjects: () => void events.push("projects"),
			flushSnapshot: () => void events.push("flush"),
			notice: (level, text) => void notices.push({ level, text }),
			...(over.persist ? { sessionPersist: over.persist } : {}),
		}),
	};
}

/** 一个未落盘的 SDK 会话：`persist = false`，条目树里已有一问一答。 */
function memorySession() {
	const manager = SessionManager.inMemory("/w");
	manager.appendMessage({ role: "user", content: "hi", timestamp: 1 } as never);
	manager.appendMessage({ role: "assistant", content: "yo", timestamp: 2 } as never);
	return { sessionFile: undefined, sessionManager: manager };
}

const sdkPort: SessionPersistPort = {
	isPersisted: (session) => isPersistedSession(session),
	persist: (input) => persistSessionFile(input),
};

describe("domains/sessions · persist_conversation", () => {
	it("未落盘的会话 → 写新转录、对话改指向它、出帧 + 回执", async () => {
		const dir = mkdtempSync(join(tmpdir(), "keel-persist-"));
		try {
			const session = memorySession();
			const { notices, events, registry, handlers } = runtime({ session, persist: sdkPort });
			await handlers.persistConversation("c1");
			// 会话目录 = `<sessionBaseDir>/.pi/agent/sessions/<encoded cwd>` 之下由 SDK 决定；只验它与 manager 一致。
			const file = session.sessionManager.getSessionFile();
			expect(file).toBeTruthy();
			expect(existsSync(file!)).toBe(true);
			expect(file!.endsWith(".jsonl")).toBe(true);
			expect(readFileSync(file!, "utf8")).toContain('"role":"user"');
			expect(session.sessionManager.isPersisted()).toBe(true);
			// 聚合根与「转录 → 对话」索引都改指向新文件（`bySessionFile` 是索引唯一的维护者）。
			expect(registry.bySessionFile(file as never)?.id).toBe("c1");
			expect(events).toEqual(["conversations", "projects", "flush"]);
			expect(notices).toEqual([{ level: "info", text: expect.stringContaining("保存为正式对话") }]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("已经落盘 → info 回执，一个字节都不写、不出帧", async () => {
		const session = memorySession();
		let writes = 0;
		const { notices, events, handlers } = runtime({
			session,
			persist: {
				isPersisted: () => true,
				persist: async () => {
					writes += 1;
					return "/never";
				},
			},
		});
		await handlers.persistConversation("c1");
		expect(writes).toBe(0);
		expect(events).toEqual([]);
		expect(notices).toEqual([{ level: "info", text: expect.stringContaining("已是持久化对话") }]);
	});

	it("会话还没开 → warning 回执，不写空文件", async () => {
		const { notices, events, handlers } = runtime({ session: undefined, persist: sdkPort });
		await handlers.persistConversation("c1");
		expect(events).toEqual([]);
		expect(notices).toEqual([{ level: "warning", text: expect.stringContaining("会话尚未打开") }]);
	});

	it("对话不存在 → warning 回执", async () => {
		const { notices, handlers } = runtime({ conversation: false, persist: sdkPort });
		await handlers.persistConversation("c-gone");
		expect(notices).toEqual([{ level: "warning", text: expect.stringContaining("不存在或已关闭") }]);
	});

	it("未注入 SDK 窄口 → 同步抛 CoreEngineNotReadyError（不是 rejected promise）", () => {
		const { notices, handlers } = runtime({ session: memorySession() });
		expect(() => handlers.persistConversation("c1")).toThrow(/core engine: persistConversation/);
		expect(notices).toEqual([]);
	});

	it("落盘抛错 → error 回执，不假装成功", async () => {
		const { notices, events, handlers } = runtime({
			session: memorySession(),
			persist: {
				isPersisted: () => false,
				persist: async () => {
					throw new Error("磁盘满了");
				},
			},
		});
		await handlers.persistConversation("c1");
		expect(events).toEqual([]);
		expect(notices).toEqual([{ level: "error", text: expect.stringContaining("磁盘满了") }]);
	});
});
