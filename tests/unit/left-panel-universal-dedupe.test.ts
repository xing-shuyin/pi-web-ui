/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	MockAgentDriver,
	UniversalSession,
	UniversalSessionStore,
	type UniversalConversation,
} from "../../server/universal/index.js";
import type { ConversationSummary, ServerMessage, SessionSummary } from "../../server/protocol.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import { LeftPanel } from "../../web/src/components/LeftPanel.js";
import { setAppGlobals } from "../../web/src/app-globals.js";
import { SessionIdentityIndex } from "../../web/src/session-identity.js";
import { clearAllUnread } from "../../web/src/unread-conversations.js";
import { conversationOrder } from "../../web/src/conversation-order.js";

/**
 * claude / codex（universal 底座）引擎下左栏会话重复的回归守卫。
 *
 * universal 会话服务同时下发 `conversations`（对话行）和 `sessions`（历史行），
 * 客户端靠 sessionId/sessionFile 把两者认成同一条。会话摘要一旦漏掉身份字段，
 * 同一条会话就会在左栏出现两次（「运行中对话行」+「历史行」）。
 */

let root: Root | null = null;
let tempDir = "";

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "pi-universal-lp-dedupe-"));
});

afterEach(() => {
	if (root) {
		act(() => root!.unmount());
		root = null;
	}
	document.body.innerHTML = "";
	clearAllUnread();
	conversationOrder.clear();
	if (existsSync(tempDir)) {
		try {
			rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
		} catch {}
	}
});

function stubZhStorage() {
	const store = new Map<string, string>();
	Object.defineProperty(window, "localStorage", {
		value: {
			getItem: (k: string) => store.get(k) ?? null,
			setItem: (k: string, v: string) => store.set(k, String(v)),
			removeItem: (k: string) => void store.delete(k),
			clear: () => store.clear(),
		} as unknown as Storage,
		writable: true,
	});
	localStorage.setItem("pi-web-ui:lang", "zh");
}

function mountLeftPanel(cwd: string, conversations: ConversationSummary[], sessions: SessionSummary[]) {
	stubZhStorage();
	localStorage.setItem("pi-web-ui:lp-expanded-projects", JSON.stringify([cwd.replace(/\\/g, "/").toLowerCase()]));
	setAppGlobals({ cwd, ready: true, status: "open", workspaceRoots: [] });
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	const props = {
		active: true,
		sessionFile: null,
		conversations,
		elsewhere: [],
		sessions,
		projects: [{ path: cwd, lastUsed: Date.now() }],
		activeConversationId: conversations[0]?.id ?? "",
		engine: "claude",
		panelSend: () => true,
	};
	act(() => {
		root!.render(
			createElement(
				LanguageProvider,
				null,
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				createElement(LeftPanel as any, props),
			),
		);
	});
	return container;
}

function seedConversations(cwd: string, count: number): UniversalConversation[] {
	const store = new UniversalSessionStore(tempDir);
	const convs: UniversalConversation[] = [];
	for (let i = 0; i < count; i++) {
		const conv: UniversalConversation = {
			id: `conv-${i + 1}`,
			title: `会话 ${i + 1}`,
			createdAt: 1_000 - i,
			updatedAt: 2_000 - i,
			messages: [{ id: `m-${i}`, role: "user", content: [{ type: "text", text: `会话 ${i + 1}` }] }],
		};
		store.saveConversation(cwd, conv);
		convs.push(conv);
	}
	return convs;
}

async function captureSessionLists(cwd: string, count: number) {
	const seeded = seedConversations(cwd, count);
	const sent: ServerMessage[] = [];
	const session = new UniversalSession({
		clientId: "test-client-dedupe",
		cwd,
		send: (msg) => sent.push(msg),
		store: new UniversalSessionStore(tempDir),
		driver: new MockAgentDriver(cwd),
	});
	await session.refreshSessions();
	session.dispose();
	const convMsg = sent.filter((m) => m.type === "conversations").at(-1);
	const sessionMsg = sent.filter((m) => m.type === "sessions").at(-1);
	if (convMsg?.type !== "conversations" || sessionMsg?.type !== "sessions") {
		throw new Error("missing conversations/sessions push");
	}
	return { seeded, conversations: convMsg.conversations, sessions: sessionMsg.sessions };
}

describe("universal 引擎左栏会话不重复", () => {
	it("conversations 摘要带会话身份（sessionId / modified）", async () => {
		const cwd = join(tempDir, "ws");
		const { seeded, conversations } = await captureSessionLists(cwd, 3);
		expect(conversations.length).toBe(seeded.length);
		for (const conv of conversations) {
			expect(conv.sessionId).toBe(conv.id);
			expect(typeof conv.modified).toBe("number");
			expect(conv.cwd).toBe(cwd);
		}
	});

	it("同一条会话在左栏只渲染一行", async () => {
		const cwd = join(tempDir, "ws");
		const { seeded, conversations, sessions } = await captureSessionLists(cwd, 3);
		const container = mountLeftPanel(cwd, conversations, sessions);
		const titles = [...container.querySelectorAll(".conv-title-text")].map((el) => el.textContent?.trim());
		expect(titles.length).toBe(seeded.length);
		expect(new Set(titles).size).toBe(seeded.length);
	});

	it("行归属闭环：声明 history 的对话一定真的有一条历史行", async () => {
		const cwd = join(tempDir, "ws");
		const { conversations, sessions } = await captureSessionLists(cwd, 3);
		const sessionIndex = new SessionIdentityIndex<true>();
		for (const s of sessions) sessionIndex.add(s, true);
		for (const conv of conversations) {
			expect(conv.rowKind, `缺 rowKind：${conv.id}`).toBeDefined();
			if (conv.rowKind === "history") {
				expect(sessionIndex.has(conv), `声明 history 却没有历史行：${conv.id}`).toBe(true);
			}
		}
	});

	it("声明 history 的对话不会在活动行里再出现一次", async () => {
		const cwd = join(tempDir, "ws");
		const { seeded, conversations, sessions } = await captureSessionLists(cwd, 3);
		const container = mountLeftPanel(cwd, conversations, sessions);
		const titles = [...container.querySelectorAll(".conv-title-text")].map((el) => el.textContent?.trim());
		expect(titles.length).toBe(seeded.length);
	});

	it("即使引擎漏发 sessionId，靠对话 id 与历史 path 相等也只渲染一行", async () => {
		const cwd = join(tempDir, "ws");
		const { seeded, conversations, sessions } = await captureSessionLists(cwd, 3);
		// 模拟未来引擎只给 id 不给 sessionId：会话身份仍应能对齐（session-identity 单源）
		const idOnly = conversations.map(
			({ sessionId: _sessionId, modified: _modified, ...rest }) => rest,
		) as ConversationSummary[];
		const container = mountLeftPanel(cwd, idOnly, sessions);
		const titles = [...container.querySelectorAll(".conv-title-text")].map((el) => el.textContent?.trim());
		expect(titles.length).toBe(seeded.length);
		expect(new Set(titles).size).toBe(seeded.length);
	});
});
