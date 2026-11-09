/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LanguageProvider } from "../../web/src/i18n.js";
import { LeftPanel } from "../../web/src/components/LeftPanel.js";
import { setAppGlobals } from "../../web/src/app-globals.js";
import { clearAllUnread } from "../../web/src/unread-conversations.js";
import { conversationOrder } from "../../web/src/conversation-order.js";

/**
 * 左栏行归属：客户端完全听引擎的 `rowKind`。
 * - open：对话自占一行，同身份的历史行让位。
 * - history：由历史行代表（活动行里不再出现）。
 * - 缺省：旧服务端兼容分支（启发式），新版本发布后可删。
 */

let root: Root | null = null;
afterEach(() => {
	if (root) {
		act(() => root!.unmount());
		root = null;
	}
	document.body.innerHTML = "";
	clearAllUnread();
	conversationOrder.clear();
});

const CWD = "/w";
const FILE = "/w/.sessions/2026-11-05T07-06-40-090Z_01a1aa87-f85a-73f5-895d-f444ccb37fb1.jsonl";
const SID = "01a1aa87-f85a-73f5-895d-f444ccb37fb1";

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
	localStorage.setItem("pi-web-ui:lp-expanded-projects", JSON.stringify([CWD]));
}

function mount(conversations: unknown[], sessions: unknown[], elsewhere: unknown[] = []) {
	stubZhStorage();
	setAppGlobals({ cwd: CWD, ready: true, status: "open", workspaceRoots: [] });
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	act(() => {
		root!.render(
			createElement(
				LanguageProvider,
				null,
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				createElement(LeftPanel as any, {
					active: true,
					sessionFile: FILE,
					conversations,
					elsewhere,
					sessions,
					projects: [{ path: CWD, lastUsed: Date.now() }],
					activeConversationId: "c1",
					panelSend: () => true,
				}),
			),
		);
	});
	return container;
}

const baseSession = {
	path: FILE,
	sessionId: SID,
	cwd: CWD,
	name: "历史标题",
	displayName: "历史标题",
	firstMessage: "历史标题",
	messageCount: 2,
	modified: Date.now(),
};
const baseConv = {
	id: "c1",
	title: "对话标题",
	cwd: CWD,
	messageCount: 2,
	isStreaming: false,
	isSubagent: false,
	sessionId: SID,
	sessionFile: FILE,
};

const rowTitles = (container: HTMLElement) =>
	[...container.querySelectorAll(".conv-title-text")].map((el) => el.textContent?.trim());

const forkBadges = (container: HTMLElement) =>
	[...container.querySelectorAll(".category-badge-pill.fork")].map((el) => el.textContent?.trim());

describe("左栏行归属（rowKind）", () => {
	it("history：只剩历史行，标题取历史行", () => {
		const c = mount([{ ...baseConv, rowKind: "history" }], [baseSession]);
		expect(rowTitles(c)).toEqual(["历史标题"]);
	});

	it("open：只剩活动行，标题取对话", () => {
		const c = mount([{ ...baseConv, rowKind: "open" }], [baseSession]);
		expect(rowTitles(c)).toEqual(["对话标题"]);
	});

	it("open + 流式：仍只有一行（不会被历史行再补一行）", () => {
		const c = mount([{ ...baseConv, rowKind: "open", isStreaming: true }], [baseSession]);
		expect(rowTitles(c)).toEqual(["对话标题"]);
	});

	it("缺省 rowKind：旧服务端退回启发式（已落盘的空闲对话不占活动行）", () => {
		const c = mount([baseConv], [baseSession]);
		expect(rowTitles(c)).toEqual(["历史标题"]);
	});

	it("缺省 rowKind：固定 / 流式的对话仍自占一行", () => {
		const c = mount([{ ...baseConv, pinned: true }], [baseSession]);
		expect(rowTitles(c)).toEqual(["对话标题"]);
	});
});

describe("分叉角标", () => {
	it("open 行只有引擎的 forked 标记（重启后 forkFrom 丢了）也出分支角标", () => {
		const c = mount([{ ...baseConv, rowKind: "open", forked: true }], [baseSession]);
		expect(forkBadges(c)).toEqual(["🌿分支"]);
	});

	it("open 行落回匹配的历史行 parentSessionPath 也认得分叉", () => {
		const c = mount(
			[{ ...baseConv, rowKind: "open" }],
			[{ ...baseSession, parentSessionPath: "/w/.sessions/parent.jsonl" }],
		);
		expect(forkBadges(c)).toEqual(["🌿分支"]);
	});

	it("elsewhere 行带 forked 时同样出分支角标（不再只有“别处”角标）", () => {
		const elsewhere = [
			{
				convId: "c2",
				owner: "other-client",
				title: "别处分叉会话",
				cwd: CWD,
				isStreaming: false,
				forked: true,
			},
		];
		const c = mount([], [baseSession], elsewhere);
		expect(forkBadges(c)).toEqual(["🌿分支"]);
	});
});
