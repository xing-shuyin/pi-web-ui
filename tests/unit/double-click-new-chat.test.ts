// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { LeftPanel } from "../../web/src/components/LeftPanel.js";
import { BarItem } from "../../web/src/components/BarItem.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import { resetAppGlobals, setAppGlobals, setAppSend } from "../../web/src/app-globals.js";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function stubZhStorage() {
	const store = new Map<string, string>();
	vi.stubGlobal("localStorage", {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
		clear: () => store.clear(),
	} as unknown as Storage);
	localStorage.setItem("pi-web-ui:lang", "zh");
}

beforeEach(() => {
	stubZhStorage();
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	if (root && container) {
		act(() => root!.unmount());
		container.remove();
	}
	root = null;
	container = null;
	setAppSend(null);
	resetAppGlobals();
	vi.restoreAllMocks();
});

describe("双击项目名字与运行的对话空白处新建对话", () => {
	it("双击运行对话列表空白处（projects-scroll）触发 new_chat", () => {
		const sent: unknown[] = [];
		const panelSend = (msg: unknown) => {
			sent.push(msg);
			return true;
		};

		setAppGlobals({ cwd: "/workspace/proj-a" });

		const props = {
			active: true,
			sessionFile: null,
			conversations: [
				{
					id: "conv-1",
					title: "Running 1",
					cwd: "/workspace/proj-a",
					messageCount: 3,
					lastActiveAt: Date.now(),
				},
			],
			elsewhere: [],
			sessions: [],
			projects: [],
			activeConversationId: "conv-1",
			panelSend,
		};

		act(() => {
			root!.render(createElement(LanguageProvider, null, createElement(LeftPanel as any, props)));
		});

		const convsScroll = container!.querySelector(".projects-scroll");
		expect(convsScroll).not.toBeNull();

		act(() => {
			convsScroll!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
		});

		expect(sent).toEqual([{ type: "new_chat" }]);
	});

	it("双击运行对话中的具体条目（.session-item）不触发 new_chat", () => {
		const sent: unknown[] = [];
		const panelSend = (msg: unknown) => {
			sent.push(msg);
			return true;
		};

		setAppGlobals({ cwd: "/workspace/proj-a" });

		const props = {
			active: true,
			sessionFile: null,
			conversations: [
				{
					id: "conv-1",
					title: "Running 1",
					cwd: "/workspace/proj-a",
					messageCount: 3,
					lastActiveAt: Date.now(),
				},
			],
			elsewhere: [],
			sessions: [],
			projects: [],
			activeConversationId: "conv-1",
			panelSend,
		};

		act(() => {
			root!.render(createElement(LanguageProvider, null, createElement(LeftPanel as any, props)));
		});

		const sessionItem = container!.querySelector(".projects-scroll .session-item");
		expect(sessionItem).not.toBeNull();

		act(() => {
			sessionItem!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
		});

		expect(sent.filter((m: any) => m.type === "new_chat")).toHaveLength(0);
	});

	it("双击最近项目中的当前活跃项目触发 new_chat", () => {
		const sent: unknown[] = [];
		const panelSend = (msg: unknown) => {
			sent.push(msg);
			return true;
		};

		setAppGlobals({ cwd: "/workspace/proj-a" });

		const props = {
			active: true,
			sessionFile: null,
			conversations: [],
			elsewhere: [],
			sessions: [],
			projects: [
				{ path: "/workspace/proj-a", lastUsed: Date.now() },
				{ path: "/workspace/proj-b", lastUsed: Date.now() - 1000 },
			],
			activeConversationId: "",
			panelSend,
		};

		act(() => {
			root!.render(createElement(LanguageProvider, null, createElement(LeftPanel as any, props)));
		});

		const projButtons = container!.querySelectorAll(".projects-scroll .project-item");
		expect(projButtons.length).toBe(2);

		act(() => {
			projButtons[0].dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
		});

		expect(sent).toEqual([{ type: "new_chat" }]);
	});

	it("双击最近项目中的非当前项目触发 set_cwd 与 new_chat", () => {
		const sent: unknown[] = [];
		const panelSend = (msg: unknown) => {
			sent.push(msg);
			return true;
		};

		setAppGlobals({ cwd: "/workspace/proj-a" });

		const props = {
			active: true,
			sessionFile: null,
			conversations: [],
			elsewhere: [],
			sessions: [],
			projects: [
				{ path: "/workspace/proj-a", lastUsed: Date.now() },
				{ path: "/workspace/proj-b", lastUsed: Date.now() - 1000 },
			],
			activeConversationId: "",
			panelSend,
		};

		act(() => {
			root!.render(createElement(LanguageProvider, null, createElement(LeftPanel as any, props)));
		});

		const projButtons = container!.querySelectorAll(".projects-scroll .project-item");
		expect(projButtons.length).toBe(2);

		act(() => {
			projButtons[1].dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
		});

		expect(sent).toContainEqual({ type: "set_cwd", path: "/workspace/proj-b" });
		expect(sent).toContainEqual({ type: "new_chat" });
	});

	it("双击跨项目的项目标题（.project-item）触发 set_cwd 与 new_chat", () => {
		const sent: unknown[] = [];
		const panelSend = (msg: unknown) => {
			sent.push(msg);
			return true;
		};

		setAppGlobals({ cwd: "/workspace/proj-a" });

		const props = {
			active: true,
			sessionFile: null,
			conversations: [
				{
					id: "conv-1",
					title: "Running 1",
					cwd: "/workspace/proj-a",
					messageCount: 3,
					lastActiveAt: Date.now(),
				},
				{
					id: "conv-2",
					title: "Running 2",
					cwd: "/workspace/proj-other",
					messageCount: 2,
					lastActiveAt: Date.now(),
				},
			],
			elsewhere: [],
			sessions: [],
			projects: [],
			activeConversationId: "conv-1",
			panelSend,
		};

		act(() => {
			root!.render(createElement(LanguageProvider, null, createElement(LeftPanel as any, props)));
		});

		const projButtons = container!.querySelectorAll(".projects-scroll .project-item");
		expect(projButtons.length).toBe(2);
		expect(projButtons[1].textContent).toContain("proj-other");

		act(() => {
			projButtons[1].dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
		});

		expect(sent).toContainEqual({ type: "set_cwd", path: "/workspace/proj-other" });
		expect(sent).toContainEqual({ type: "new_chat" });
	});

	it("双击 BarItem 中的 host:cwd 触发 new_chat", () => {
		const sent: unknown[] = [];
		let pickerOpened = false;

		setAppSend((msg: any) => {
			sent.push(msg);
			return true;
		});

		const entry = {
			id: "host:cwd",
			slot: "topbar.primary" as const,
			source: "host" as const,
			label: "工作区",
			kind: "action" as const,
			order: 10,
			align: "start" as const,
			hidden: false,
			userOverrides: [],
			arrangedBy: [],
		};

		const chat: any = {
			state: { cwd: "/workspace/my-app", stats: null },
			settings: null,
			statuses: [],
		};

		act(() => {
			root!.render(
				createElement(
					LanguageProvider,
					null,
					createElement(BarItem, {
						entry,
						bar: "top",
						chat,
						onOpenProjectPicker: () => {
							pickerOpened = true;
						},
					}),
				),
			);
		});

		const btn = container!.querySelector("button[data-bar-item='host:cwd']");
		expect(btn).not.toBeNull();

		act(() => {
			btn!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
		});

		expect(sent).toEqual([{ type: "new_chat" }]);
		expect(pickerOpened).toBe(false);
	});

	it("双击历史会话列表空白处（projects-scroll）触发 new_chat", () => {
		const sent: unknown[] = [];
		const panelSend = (msg: unknown) => {
			sent.push(msg);
			return true;
		};

		setAppGlobals({ cwd: "/workspace/proj-a" });

		const props = {
			active: true,
			sessionFile: null,
			conversations: [],
			elsewhere: [],
			sessions: [
				{
					path: "session-1.jsonl",
					name: "Session 1",
					firstMessage: "Hello",
					modified: Date.now(),
					messageCount: 1,
				},
			],
			projects: [{ path: "/workspace/proj-a", lastUsed: Date.now() }],
			activeConversationId: "",
			panelSend,
		};

		act(() => {
			root!.render(createElement(LanguageProvider, null, createElement(LeftPanel as any, props)));
		});

		const sessionsScroll = container!.querySelector(".projects-scroll");
		expect(sessionsScroll).not.toBeNull();

		act(() => {
			sessionsScroll!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
		});

		expect(sent).toEqual([{ type: "new_chat" }]);
	});

	it("双击最近项目列表空白处（projects-scroll）触发 new_chat", () => {
		const sent: unknown[] = [];
		const panelSend = (msg: unknown) => {
			sent.push(msg);
			return true;
		};

		setAppGlobals({ cwd: "/workspace/proj-a" });

		const props = {
			active: true,
			sessionFile: null,
			conversations: [],
			elsewhere: [],
			sessions: [],
			projects: [{ path: "/workspace/proj-a", lastUsed: Date.now() }],
			activeConversationId: "",
			panelSend,
		};

		act(() => {
			root!.render(createElement(LanguageProvider, null, createElement(LeftPanel as any, props)));
		});

		const projectsScroll = container!.querySelector(".projects-scroll");
		expect(projectsScroll).not.toBeNull();

		act(() => {
			projectsScroll!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
		});

		expect(sent).toEqual([{ type: "new_chat" }]);
	});

	it("单击 BarItem 中的 host:cwd 并在 220ms 后触发 onOpenProjectPicker", () => {
		vi.useFakeTimers();
		const sent: unknown[] = [];
		let pickerOpened = false;

		setAppSend((msg: any) => {
			sent.push(msg);
			return true;
		});

		const entry = {
			id: "host:cwd",
			slot: "topbar.primary" as const,
			source: "host" as const,
			label: "工作区",
			kind: "action" as const,
			order: 10,
			align: "start" as const,
			hidden: false,
			userOverrides: [],
			arrangedBy: [],
		};

		const chat: any = {
			state: { cwd: "/workspace/my-app", stats: null },
			settings: null,
			statuses: [],
		};

		act(() => {
			root!.render(
				createElement(
					LanguageProvider,
					null,
					createElement(BarItem, {
						entry,
						bar: "top",
						chat,
						onOpenProjectPicker: () => {
							pickerOpened = true;
						},
					}),
				),
			);
		});

		const btn = container!.querySelector("button[data-bar-item='host:cwd']");
		expect(btn).not.toBeNull();

		act(() => {
			btn!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		});

		expect(pickerOpened).toBe(false);

		act(() => {
			vi.advanceTimersByTime(230);
		});

		expect(pickerOpened).toBe(true);
		expect(sent).toEqual([]);
		vi.useRealTimers();
	});
});
