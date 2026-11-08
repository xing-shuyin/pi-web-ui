// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { LeftPanel } from "../../web/src/components/LeftPanel.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import { conversationOrder } from "../../web/src/conversation-order.js";
import { resetAppGlobals, setAppGlobals } from "../../web/src/app-globals.js";
import { closeContextMenu } from "../../web/src/context-menu-state.js";
import type { ConversationSummary, SessionSummary } from "../../server/protocol.js";

vi.mock("../../web/src/components/DeviceGroupSection.js", () => ({
	DeviceGroupSection: () => createElement("div", { className: "lp-section dg-side-section" }),
}));

let root: Root | null = null;

function mount(props: Record<string, unknown>, expanded: string[]) {
	const store = new Map<string, string>([
		["pi-web-ui:lang", "zh"],
		["pi-web-ui:lp-expanded-projects", JSON.stringify(expanded)],
	]);
	vi.stubGlobal("localStorage", {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
		clear: () => store.clear(),
	} as unknown as Storage);
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
					elsewhere: [],
					panelSend: () => true,
					pathCompletions: [],
					...props,
				}),
			),
		);
	});
	return container;
}

afterEach(() => {
	vi.unstubAllGlobals();
	resetAppGlobals();
	closeContextMenu();
	if (root) act(() => root!.unmount());
	root = null;
	document.body.innerHTML = "";
	conversationOrder.clear();
});

const countText = (el: Element | null, text: string) => (el?.textContent?.split(text).length ?? 1) - 1;

function projectBlock(container: HTMLElement, projectName: string): Element | null {
	const blocks = [...container.querySelectorAll(".lp-project-node")];
	return blocks.find((b) => b.querySelector(".lp-project-name")?.textContent?.includes(projectName)) ?? null;
}

describe("LeftPanel with CLI engines (Claude/Codex)", () => {
	it("shows an open conversation once and only under its own project", () => {
		const cwdA = "D:/work/alpha";
		const cwdB = "D:/work/beta";
		setAppGlobals({ cwd: cwdA, ready: true, status: "open", workspaceRoots: [] });
		const conv: ConversationSummary = {
			id: "conv-alpha-1",
			title: "Alpha 对话",
			cwd: cwdA,
			messageCount: 2,
			isStreaming: false,
			isSubagent: false,
			sessionId: "conv-alpha-1",
		};
		const session: SessionSummary = {
			path: "conv-alpha-1",
			sessionId: "conv-alpha-1",
			cwd: cwdA,
			name: "Alpha 对话",
			displayName: "Alpha 对话",
			firstMessage: "hi",
			messageCount: 2,
			modified: Date.now(),
		};
		// The `sessions` prop is the active project's list, but the engine reports every project's rows
		// (bare conversation ids, no slug in `path`). The beta row must not be adopted by alpha.
		const otherProjectSession: SessionSummary = {
			path: "conv-beta-1",
			sessionId: "conv-beta-1",
			cwd: cwdB,
			name: "Beta 对话",
			displayName: "Beta 对话",
			firstMessage: "yo",
			messageCount: 2,
			modified: Date.now() - 500,
		};
		const container = mount(
			{
				engine: "claude",
				sessionFile: "conv-alpha-1",
				conversations: [conv],
				activeConversationId: conv.id,
				sessions: [session, otherProjectSession],
				projects: [
					{ path: cwdA, lastUsed: Date.now() },
					{ path: cwdB, lastUsed: Date.now() - 1000 },
				],
			},
			[cwdA.toLowerCase(), cwdB.toLowerCase()],
		);
		const scroll = container.querySelector(".projects-scroll") ?? container;
		expect(countText(scroll, "Alpha 对话")).toBe(1);
		expect(countText(scroll, "Beta 对话")).toBe(0);
		const beta = projectBlock(container, "beta");
		expect(beta).toBeTruthy();
		expect(beta!.textContent).not.toContain("Alpha 对话");
		expect(projectBlock(container, "alpha")!.textContent).toContain("Alpha 对话");
	});
});
