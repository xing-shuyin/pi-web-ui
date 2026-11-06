// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LeftPanel } from "../../web/src/components/LeftPanel.js";
import { RightPanel } from "../../web/src/components/RightPanel.js";
import { SelectionQuoteButton } from "../../web/src/components/SelectionQuoteButton.js";
import { buildUiSlots } from "../../web/src/ui-slots.js";
import { closeContextMenu, contextMenuItems, getContextMenu } from "../../web/src/context-menu-state.js";
import { resetAppGlobals, setAppGlobals } from "../../web/src/app-globals.js";
import { QUICK_ASK_OPEN_EVENT, type QuickAskOpenRequest } from "../../web/src/quick-ask.js";

vi.mock("../../web/src/components/DeviceGroupSection.js", () => ({ DeviceGroupSection: () => null }));

let root: Root;
let container: HTMLDivElement;
let opened: QuickAskOpenRequest[];
const captureOpen = (event: Event) => opened.push((event as CustomEvent<QuickAskOpenRequest>).detail);
const slots = () => buildUiSlots([], { locale: "zh", t: (key: string) => key });

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const storage = new Map<string, string>();
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => void storage.set(key, value),
		removeItem: (key: string) => void storage.delete(key),
		clear: () => storage.clear(),
	});
	setAppGlobals({ cwd: "/workspace", ready: true });
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	opened = [];
	window.addEventListener(QUICK_ASK_OPEN_EVENT, captureOpen);
});

afterEach(() => {
	act(() => root.unmount());
	window.removeEventListener(QUICK_ASK_OPEN_EVENT, captureOpen);
	window.getSelection()?.removeAllRanges();
	document.body.replaceChildren();
	closeContextMenu();
	resetAppGlobals();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function rightClick(element: Element) {
	const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 40 });
	act(() => element.dispatchEvent(event));
	return event;
}

function selectReference(id: "host:conv-quick-ask" | "host:file-quick-ask") {
	const menu = getContextMenu();
	expect(menu).not.toBeNull();
	const entry = contextMenuItems(menu!.entries).find((item) => item.id === id);
	expect(entry).toBeDefined();
	act(() => menu!.onHostAction?.(entry!, menu!.target));
}

function leftProps(overrides: Partial<ComponentProps<typeof LeftPanel>> = {}): ComponentProps<typeof LeftPanel> {
	return {
		active: false,
		sessionFile: null,
		conversations: [
			{
				id: "running-a",
				title: "running target",
				cwd: "/workspace",
				isStreaming: true,
				sessionFile: "/sessions/running.jsonl",
			} as any,
		],
		elsewhere: [],
		sessions: [
			{
				path: "/sessions/history.jsonl",
				name: "history target",
				firstMessage: "saved text",
				modified: Date.now(),
			} as any,
		],
		projects: [],
		activeConversationId: "running-a",
		panelSend: vi.fn(() => true),
		uiContextSession: slots()["contextmenu.session"].filter((entry) => entry.id === "host:conv-quick-ask"),
		...overrides,
	};
}

function rowWithText(text: string) {
	const row = [...container.querySelectorAll(".lp-row")].find((element) => element.textContent?.includes(text));
	expect(row).toBeDefined();
	return row!;
}

describe("session quick ask reference menus", () => {
	it("keeps the opened running target after switching active conversations", () => {
		const props = leftProps();
		act(() => root.render(createElement(LeftPanel, props)));
		expect(rightClick(rowWithText("running target")).defaultPrevented).toBe(true);
		act(() => root.render(createElement(LeftPanel, { ...props, activeConversationId: "another-conversation" })));
		selectReference("host:conv-quick-ask");
		expect(opened).toEqual([{ reference: { kind: "conversation", conversationId: "running-a" } }]);
		expect(props.panelSend).not.toHaveBeenCalled();
	});

	it("uses the history session file without a conversation id", () => {
		act(() => root.render(createElement(LeftPanel, leftProps())));
		rightClick(rowWithText("history target"));
		selectReference("host:conv-quick-ask");
		expect(opened).toEqual([{ reference: { kind: "conversation", sessionFile: "/sessions/history.jsonl" } }]);
	});

	it("captures the owner and actual conversation id of an elsewhere row", () => {
		const props = leftProps({
			elsewhere: [{ owner: "remote-owner", convId: "remote-conv", title: "remote target", cwd: "/remote" } as any],
		});
		act(() => root.render(createElement(LeftPanel, props)));
		rightClick(rowWithText("remote target"));
		act(() => root.render(createElement(LeftPanel, { ...props, elsewhere: [] })));
		selectReference("host:conv-quick-ask");
		expect(opened).toEqual([
			{ reference: { kind: "conversation", conversationId: "remote-conv", owner: "remote-owner" } },
		]);
	});

	it("leaves the browser menu available for legacy elsewhere rows without a real id", () => {
		act(() =>
			root.render(
				createElement(
					LeftPanel,
					leftProps({ elsewhere: [{ owner: "legacy-owner", title: "legacy target", cwd: "/legacy" } as any] }),
				),
			),
		);
		expect(rightClick(rowWithText("legacy target")).defaultPrevented).toBe(false);
		expect(getContextMenu()).toBeNull();
	});

	it.each(["disabled", "hidden"])("does not create an empty menu when the reference item is %s", (mode) => {
		const props = leftProps({ quickAskReferenceMenus: mode !== "disabled" });
		if (mode === "hidden")
			props.uiContextSession = props.uiContextSession!.map((entry) => ({ ...entry, hidden: true }));
		act(() => root.render(createElement(LeftPanel, props)));
		expect(rightClick(rowWithText("running target")).defaultPrevented).toBe(false);
		expect(getContextMenu()).toBeNull();
	});
});

function rightProps(overrides: Partial<ComponentProps<typeof RightPanel>> = {}): ComponentProps<typeof RightPanel> {
	return {
		files: {
			path: "",
			entries: [
				{ name: "file.txt", path: "src/file.txt", type: "file", size: 1 },
				{ name: "src", path: "src", type: "dir" },
			],
		} as any,
		fileChanged: null,
		widgets: [],
		panelSend: vi.fn(() => true),
		onAttach: vi.fn(),
		onPreview: vi.fn(),
		onNotice: vi.fn(),
		uiContextFile: slots()["contextmenu.file"].filter((entry) => entry.id === "host:file-quick-ask"),
		...overrides,
	};
}

describe("file quick ask reference menus", () => {
	it.each([
		["src/file.txt", "file"],
		["src", "directory"],
	])("captures %s and its cwd before the workspace changes", (path, kind) => {
		const props = rightProps();
		act(() => root.render(createElement(RightPanel, props)));
		const row = container.querySelector(`[data-path="${path}"]`)!;
		expect(row).not.toBeNull();
		rightClick(row);
		const sendCount = vi.mocked(props.panelSend).mock.calls.length;
		act(() => setAppGlobals({ cwd: "/next-workspace" }));
		selectReference("host:file-quick-ask");
		expect(opened).toEqual([{ reference: { kind, path: `/workspace/${path}`, cwd: "/workspace" } }]);
		expect(props.onAttach).not.toHaveBeenCalled();
		expect(props.panelSend).toHaveBeenCalledTimes(sendCount);
	});

	it.each(["disabled", "hidden"])("does not create an empty menu when the reference item is %s", (mode) => {
		const props = rightProps({ quickAskReferenceMenus: mode !== "disabled" });
		if (mode === "hidden") props.uiContextFile = props.uiContextFile!.map((entry) => ({ ...entry, hidden: true }));
		act(() => root.render(createElement(RightPanel, props)));
		expect(rightClick(container.querySelector('[data-path="src/file.txt"]')!).defaultPrevented).toBe(false);
		expect(getContextMenu()).toBeNull();
	});
});

function mountSelection(translateEnabled = true) {
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		callback(0);
		return 1;
	});
	vi.stubGlobal("cancelAnimationFrame", () => undefined);
	const content = document.createElement("div");
	content.innerHTML =
		'<div class="msg" data-msg-id="m1" data-role="assistant"><div class="msg-text">Selected words</div></div>';
	document.body.appendChild(content);
	act(() =>
		root.render(
			createElement(SelectionQuoteButton, {
				rootRef: { current: content },
				sessionId: "selection-session",
				translateEnabled,
			}),
		),
	);
	const range = document.createRange();
	range.selectNodeContents(content.querySelector(".msg-text")!);
	range.getBoundingClientRect = () =>
		({ left: 10, right: 150, top: 70, bottom: 90, width: 140, height: 20 }) as DOMRect;
	window.getSelection()!.addRange(range);
	act(() => document.dispatchEvent(new Event("selectionchange")));
}

describe("selection quick ask translate entry", () => {
	it("opens a translate request with the selected text and leaves quote/explain alongside it", () => {
		mountSelection();
		expect(document.querySelectorAll(".quote-selection-button")).toHaveLength(3);
		act(() => document.querySelector<HTMLButtonElement>(".selection-translate-trigger")!.click());
		expect(opened).toEqual([{ action: "translate", selection: "Selected words", anchor: expect.any(Object) }]);
		expect(window.getSelection()?.toString()).toBe("");
	});

	it("keeps quote and explain when translation is disabled", () => {
		mountSelection(false);
		expect(document.querySelector(".selection-translate-trigger")).toBeNull();
		expect(document.querySelectorAll(".quote-selection-button")).toHaveLength(2);
		expect(document.querySelector(".selection-explain-trigger")).not.toBeNull();
	});
});
