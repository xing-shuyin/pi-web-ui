// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { LeftPanel } from "../../web/src/components/LeftPanel.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import { resetAppGlobals, setAppGlobals } from "../../web/src/app-globals.js";
import { closeContextMenu } from "../../web/src/context-menu-state.js";

vi.mock("../../web/src/components/DeviceGroupSection.js", () => ({
	DeviceGroupSection: () => createElement("div", { className: "lp-section dg-side-section" }),
}));

let root: Root | null = null;
let container: HTMLDivElement;
let sent: unknown[] = [];
let baseProps: Record<string, unknown> = {};

function stubStorage() {
	const store = new Map<string, string>();
	vi.stubGlobal("localStorage", {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
		clear: () => store.clear(),
	} as unknown as Storage);
	localStorage.setItem("pi-web-ui:lang", "zh");
}

function render(overrides: Record<string, unknown> = {}) {
	baseProps = { ...baseProps, ...overrides };
	act(() => {
		root!.render(
			createElement(
				LanguageProvider,
				null,
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				createElement(LeftPanel as any, baseProps),
			),
		);
	});
}

function mount(overrides: Record<string, unknown> = {}) {
	stubStorage();
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	sent = [];
	baseProps = {
		active: true,
		sessionFile: null,
		conversations: [],
		elsewhere: [],
		sessions: [],
		projects: [],
		activeConversationId: "",
		panelSend: (msg: unknown) => {
			sent.push(msg);
			return true;
		},
	};
	render(overrides);
}

const projectOrder = () =>
	[...container.querySelectorAll<HTMLElement>("[data-project-path]")].map((el) => el.getAttribute("data-project-path"));

function typeInto(input: HTMLInputElement, value: string) {
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
	act(() => {
		setter.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

function key(el: Element, k: string, init: KeyboardEventInit = {}) {
	act(() => {
		el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
	resetAppGlobals();
	closeContextMenu();
	if (root) act(() => root!.unmount());
	root = null;
	document.body.innerHTML = "";
});

describe("项目排序", () => {
	it("首次加载按最近使用排序；页面打开期间稳定，新项目追加到末尾", () => {
		setAppGlobals({ cwd: "", ready: true, status: "open", workspaceRoots: [] });
		mount({
			projects: [
				{ path: "/w/old", lastUsed: 1000 },
				{ path: "/w/new", lastUsed: 3000 },
				{ path: "/w/mid", lastUsed: 2000 },
			],
		});
		expect(projectOrder()).toEqual(["/w/new", "/w/mid", "/w/old"]);

		render({
			projects: [
				{ path: "/w/old", lastUsed: 9000 },
				{ path: "/w/new", lastUsed: 3000 },
				{ path: "/w/mid", lastUsed: 2000 },
				{ path: "/w/added", lastUsed: 99999 },
			],
		});
		expect(projectOrder()).toEqual(["/w/new", "/w/mid", "/w/old", "/w/added"]);
	});

	it("Alt+↓ / Alt+↑ 在项目头上调整顺序", () => {
		setAppGlobals({ cwd: "", ready: true, status: "open", workspaceRoots: [] });
		mount({
			projects: [
				{ path: "/w/a", lastUsed: 3 },
				{ path: "/w/b", lastUsed: 2 },
				{ path: "/w/c", lastUsed: 1 },
			],
		});
		const head = () => container.querySelector<HTMLElement>('[data-project-path="/w/a"]')!;
		key(head(), "ArrowDown", { altKey: true });
		expect(projectOrder()).toEqual(["/w/b", "/w/a", "/w/c"]);
		key(head(), "ArrowDown", { altKey: true });
		expect(projectOrder()).toEqual(["/w/b", "/w/c", "/w/a"]);
		key(head(), "ArrowUp", { altKey: true });
		expect(projectOrder()).toEqual(["/w/b", "/w/a", "/w/c"]);
		expect(
			sent.filter(
				(m) => (m as { type: string }).type !== "list_sessions" && (m as { type: string }).type !== "list_projects",
			),
		).toEqual([]);
	});

	it("拖拽项目到另一个项目之后", () => {
		setAppGlobals({ cwd: "", ready: true, status: "open", workspaceRoots: [] });
		mount({
			projects: [
				{ path: "/w/a", lastUsed: 3 },
				{ path: "/w/b", lastUsed: 2 },
				{ path: "/w/c", lastUsed: 1 },
			],
		});
		const nodeOf = (p: string) =>
			container.querySelector(`[data-project-path="${p}"]`)!.closest<HTMLElement>(".lp-project-node")!;
		const headRowOf = (p: string) => nodeOf(p).querySelector<HTMLElement>(".lp-project-head-row")!;
		const dt = { effectAllowed: "", dropEffect: "", setData: vi.fn() };
		const fire = (el: Element, type: string, clientY = 100) => {
			const ev = new Event(type, { bubbles: true, cancelable: true });
			Object.assign(ev, { dataTransfer: dt, clientY });
			act(() => {
				el.dispatchEvent(ev);
			});
		};
		fire(headRowOf("/w/a"), "dragstart");
		fire(nodeOf("/w/c"), "dragover");
		fire(nodeOf("/w/c"), "drop");
		expect(projectOrder()).toEqual(["/w/b", "/w/c", "/w/a"]);
	});
});

describe("过滤框", () => {
	const sessions = [
		{ path: "/w/a/s1.jsonl", name: "alpha design", modified: 3, messageCount: 1 },
		{ path: "/w/a/s2.jsonl", name: "beta release", modified: 2, messageCount: 1 },
	];

	it("按对话标题过滤；项目名命中时照常显示；无匹配时给出提示", () => {
		setAppGlobals({ cwd: "/w/a", ready: true, status: "open", workspaceRoots: [] });
		mount({
			projects: [
				{ path: "/w/a", lastUsed: 2 },
				{ path: "/w/zeta", lastUsed: 1 },
			],
			sessions,
		});
		const input = container.querySelector<HTMLInputElement>(".lp-filter input")!;
		expect(input).not.toBeNull();
		const titles = () => [...container.querySelectorAll(".conv-title-text")].map((e) => e.textContent);

		typeInto(input, "beta");
		expect(projectOrder()).toEqual(["/w/a"]);
		expect(titles()).toEqual(["beta release"]);

		typeInto(input, "zeta");
		expect(projectOrder()).toEqual(["/w/zeta"]);

		typeInto(input, "no-such-thing");
		expect(projectOrder()).toEqual([]);
		expect(container.querySelector(".lp-filter-empty")).not.toBeNull();

		key(input, "Escape");
		expect(input.value).toBe("");
		expect(projectOrder()).toEqual(["/w/a", "/w/zeta"]);
	});
});

describe("键盘导航", () => {
	it("↓ 在行间移动焦点，← 从会话行回到所属项目头", () => {
		setAppGlobals({ cwd: "/w/a", ready: true, status: "open", workspaceRoots: [] });
		mount({
			projects: [{ path: "/w/a", lastUsed: 2 }],
			sessions: [{ path: "/w/a/s1.jsonl", name: "one", modified: 3, messageCount: 1 }],
		});
		const head = container.querySelector<HTMLElement>('[data-project-path="/w/a"]')!;
		head.focus();
		key(head, "ArrowDown");
		const row = document.activeElement as HTMLElement;
		expect(row).not.toBe(head);
		expect(row.classList.contains("session-item")).toBe(true);
		key(row, "ArrowLeft");
		expect(document.activeElement).toBe(head);
	});

	it("树容器与项目节点带 tree / treeitem 语义", () => {
		setAppGlobals({ cwd: "/w/a", ready: true, status: "open", workspaceRoots: [] });
		mount({ projects: [{ path: "/w/a", lastUsed: 2 }] });
		expect(container.querySelector('[role="tree"]')).not.toBeNull();
		const item = container.querySelector('[role="treeitem"]')!;
		expect(item.getAttribute("aria-expanded")).toBe("true");
	});
});

describe("重命名", () => {
	const sessions = [{ path: "/w/a/s1.jsonl", name: "old name", modified: 3, messageCount: 1 }];

	function startRename() {
		const btn = container.querySelector<HTMLButtonElement>(".lp-tree-session-item ~ .lp-rename, .lp-rename")!;
		act(() => btn.click());
		return container.querySelector<HTMLInputElement>(".session-rename-input")!;
	}

	it("失焦即提交，只发一次，并立即乐观显示新名字；输入框不嵌在 button 内", () => {
		setAppGlobals({ cwd: "/w/a", ready: true, status: "open", workspaceRoots: [] });
		mount({ projects: [{ path: "/w/a", lastUsed: 2 }], sessions });
		const input = startRename();
		expect(input).not.toBeNull();
		expect(input.closest("button")).toBeNull();
		typeInto(input, "new name");
		act(() => {
			input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
			input.blur();
		});
		const renames = sent.filter((m) => (m as { type: string }).type === "rename_session");
		expect(renames).toEqual([{ type: "rename_session", path: "/w/a/s1.jsonl", name: "new name" }]);
		expect(container.querySelector(".session-rename-input")).toBeNull();
		expect([...container.querySelectorAll(".conv-title-text")].map((e) => e.textContent)).toContain("new name");
	});

	it("Enter 提交后卸载触发的 blur 不会重复发送；Escape 取消不发送", () => {
		setAppGlobals({ cwd: "/w/a", ready: true, status: "open", workspaceRoots: [] });
		mount({ projects: [{ path: "/w/a", lastUsed: 2 }], sessions });
		let input = startRename();
		typeInto(input, "via enter");
		key(input, "Enter");
		act(() => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
		expect(sent.filter((m) => (m as { type: string }).type === "rename_session")).toHaveLength(1);

		input = startRename();
		typeInto(input, "discarded");
		key(input, "Escape");
		act(() => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
		expect(sent.filter((m) => (m as { type: string }).type === "rename_session")).toHaveLength(1);
	});
});

describe("B5：显示更多向服务端翻页", () => {
	const mk = (n: number) =>
		Array.from({ length: n }, (_, i) => ({
			path: `/w/a/s${i}.jsonl`,
			name: `s${i}`,
			modified: 1000 - i,
			messageCount: 1,
		}));

	it("本地已下发的用完且服务端还有更多：请求更大的 limit，显示加载态；新数据到达后恢复", () => {
		setAppGlobals({ cwd: "/w/a", ready: true, status: "open", workspaceRoots: [] });
		mount({ projects: [{ path: "/w/a", lastUsed: 2 }], sessions: mk(8), projectSessionsHasMore: { "/w/a": true } });
		const more = () => container.querySelector<HTMLButtonElement>(".lp-show-more-row");
		expect(more()).not.toBeNull();
		sent.length = 0;
		act(() => more()!.click());
		expect(sent).toContainEqual({ type: "list_sessions", path: "/w/a", limit: 400 });
		expect(more()!.disabled).toBe(true);
		render({ sessions: mk(40), projectSessionsHasMore: {} });
		expect(more()!.disabled).toBe(false);
		expect(container.querySelectorAll(".lp-tree-session-item").length).toBe(28);
	});

	it("本地还有余量时只在本地展开，不请求服务端", () => {
		setAppGlobals({ cwd: "/w/a", ready: true, status: "open", workspaceRoots: [] });
		mount({ projects: [{ path: "/w/a", lastUsed: 2 }], sessions: mk(100), projectSessionsHasMore: { "/w/a": true } });
		sent.length = 0;
		act(() => container.querySelector<HTMLButtonElement>(".lp-show-more-row")!.click());
		expect(sent.filter((m) => (m as { type: string }).type === "list_sessions")).toEqual([]);
		expect(container.querySelectorAll(".lp-tree-session-item").length).toBe(28);
	});

	it("展开条数持久化，重新挂载时按此前条数请求列表", () => {
		setAppGlobals({ cwd: "/w/a", ready: true, status: "open", workspaceRoots: [] });
		mount({ projects: [{ path: "/w/a", lastUsed: 2 }], sessions: mk(10) });
		localStorage.setItem("pi-web-ui:lp-visible-counts", JSON.stringify({ "/w/a": 450 }));
		act(() => root!.unmount());
		root = createRoot(container);
		sent.length = 0;
		render();
		expect(sent).toContainEqual({ type: "list_sessions", limit: 600 });
	});
});
