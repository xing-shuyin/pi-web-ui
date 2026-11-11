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
 * 完成证据角标：只标「没核对通过」的裁决（unverified / partial / blocked），
 * `pass` 与无裁决都不占位——别让「没验证」看起来像「已验证」。
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

function stubZhStorage() {
	const store = new Map<string, string>();
	Object.defineProperty(window, "localStorage", {
		value: {
			getItem: (k: string) => store.get(k) ?? null,
			setItem: (k: string, v: string) => store.set(k, String(v)),
			removeItem: (k: string) => void store.delete(k),
			clear: () => void store.clear(),
		} as unknown as Storage,
		writable: true,
	});
	localStorage.setItem("pi-web-ui:lang", "zh");
	localStorage.setItem("pi-web-ui:lp-expanded-projects", JSON.stringify([CWD]));
}

function mount(conversation: Record<string, unknown>) {
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
					sessionFile: null,
					conversations: [conversation],
					elsewhere: [],
					sessions: [],
					projects: [{ path: CWD, lastUsed: Date.now() }],
					activeConversationId: conversation.id,
					panelSend: () => true,
				}),
			),
		);
	});
	return container;
}

const subagentConv = {
	id: "sa-1",
	title: "重构解析器",
	cwd: CWD,
	messageCount: 3,
	isStreaming: false,
	isSubagent: true,
	rowKind: "open",
	parentId: "c1",
};

const verdictBadges = (container: HTMLElement) =>
	[...container.querySelectorAll(".category-badge-pill")]
		.filter((el) => [...el.classList].some((c) => c.startsWith("evidence-")))
		.map((el) => ({
			kind: [...el.classList].find((c) => c.startsWith("evidence-"))!,
			text: el.textContent?.trim(),
			title: el.getAttribute("title") ?? "",
		}));

describe("子代理完成证据角标", () => {
	it("unverified 标出「未验证」并带解释 tooltip", () => {
		const c = mount({ ...subagentConv, subagentVerdict: "unverified" });
		const badges = verdictBadges(c);
		expect(badges).toHaveLength(1);
		expect(badges[0]!.kind).toBe("evidence-unverified");
		expect(badges[0]!.text).toBe("未验证");
		expect(badges[0]!.title).toContain("证据");
	});

	it("partial / blocked 各有自己的角标", () => {
		expect(verdictBadges(mount({ ...subagentConv, subagentVerdict: "partial" }))[0]).toMatchObject({
			kind: "evidence-partial",
			text: "部分核对",
		});
		expect(verdictBadges(mount({ ...subagentConv, subagentVerdict: "blocked" }))[0]).toMatchObject({
			kind: "evidence-blocked",
			text: "受阻",
		});
	});

	it("pass 与无裁决不占位", () => {
		expect(verdictBadges(mount({ ...subagentConv, subagentVerdict: "pass" }))).toEqual([]);
		expect(verdictBadges(mount({ ...subagentConv }))).toEqual([]);
	});
});
