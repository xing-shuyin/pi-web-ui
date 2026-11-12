/** @vitest-environment jsdom */
import { act, createElement, StrictMode, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppGlobals } from "../../web/src/app-globals.js";
import { LeftPanel } from "../../web/src/components/LeftPanel.js";
import { LanguageProvider } from "../../web/src/i18n.js";

let root: Root;
let container: HTMLDivElement;
let props: ComponentProps<typeof LeftPanel>;
let connected: boolean;
const panelSend = vi.fn((_msg: { type: string; path?: string }) => connected);
const historyRequests = () =>
	panelSend.mock.calls.filter(([msg]) => msg.type === "list_sessions" && msg.path === "/archive");

function render(strict = false) {
	act(() => {
		const panel = createElement(LanguageProvider, null, createElement(LeftPanel, props));
		root.render(strict ? createElement(StrictMode, null, panel) : panel);
	});
}

function connect() {
	connected = true;
	act(() => setAppGlobals({ ready: true, status: "open" }));
}

beforeEach(() => {
	const store = new Map<string, string>();
	Object.defineProperty(window, "localStorage", {
		configurable: true,
		value: {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => store.set(key, String(value)),
			removeItem: (key: string) => store.delete(key),
			clear: () => store.clear(),
		},
	});
	localStorage.setItem("pi-web-ui:lang", "zh");
	localStorage.setItem("pi-web-ui:lp-expanded-projects", JSON.stringify(["/archive"]));
	connected = false;
	panelSend.mockClear();
	setAppGlobals({ cwd: "/current", ready: false, status: "connecting", workspaceRoots: [] });
	props = {
		active: true,
		sessionFile: null,
		conversations: [],
		elsewhere: [],
		sessions: [],
		projects: [
			{ path: "/current", lastUsed: 2 },
			{ path: "/archive", lastUsed: 1 },
		],
		activeConversationId: "",
		panelSend,
	};
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	vi.useRealTimers();
});

describe("restored project session loading", () => {
	it("stops waiting after a timeout, retries on click, and accepts the response", () => {
		vi.useFakeTimers();
		connect();
		render(true);
		act(() => vi.advanceTimersByTime(20001));
		expect(container.textContent).not.toContain("正在读取会话");
		const retry = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
			button.textContent?.includes("点击重试"),
		);
		expect(retry).toBeTruthy();
		act(() => retry!.click());
		expect(historyRequests()).toHaveLength(2);
		expect(container.textContent).toContain("正在读取会话");
		props = { ...props, projectSessions: { "/archive": [] } };
		render();
		expect(container.textContent).not.toContain("点击重试");
		expect(container.textContent).not.toContain("正在读取会话");
	});
	it("requests expanded projects again when the engine changes", () => {
		connect();
		render();
		props = { ...props, engine: "codex", projectSessions: {} };
		render();
		expect(historyRequests()).toHaveLength(2);
		props = { ...props, projectSessions: { "/archive": [] } };
		render();
		expect(container.textContent).not.toContain("正在读取会话");
	});
	it("waits for connection and resolves an empty response without a click", () => {
		render();
		expect(historyRequests()).toHaveLength(0);
		connect();
		expect(historyRequests()).toHaveLength(1);
		expect(container.textContent).toContain("正在读取会话");
		props = { ...props, projectSessions: { "/archive": [] } };
		render();
		expect(container.textContent).not.toContain("正在读取会话");
		expect(container.querySelectorAll(".lp-project-empty-tip")[1]?.textContent).toContain("暂无历史会话");
	});

	it("waits for the handshake even if the socket is already open", () => {
		connected = true;
		setAppGlobals({ status: "open" });
		render();
		expect(historyRequests()).toHaveLength(0);
		act(() => setAppGlobals({ ready: true }));
		expect(historyRequests()).toHaveLength(1);
	});

	it("does not mark a rejected send as loading or suppress the next attempt", () => {
		setAppGlobals({ ready: true, status: "open" });
		render();
		expect(historyRequests()).toHaveLength(1);
		expect(container.textContent).not.toContain("正在读取会话");
		connected = true;
		props = { ...props, projects: [...props.projects] };
		render();
		expect(historyRequests()).toHaveLength(2);
		expect(container.textContent).toContain("正在读取会话");
	});

	it("reissues interrupted requests after reconnecting", () => {
		connect();
		render();
		expect(historyRequests()).toHaveLength(1);
		connected = false;
		act(() => setAppGlobals({ status: "closed" }));
		connect();
		expect(historyRequests()).toHaveLength(2);
		props = { ...props, projectSessions: { "/archive": [] } };
		render();
		expect(container.textContent).not.toContain("正在读取会话");
	});

	it("sends once under StrictMode and does not refetch after an empty response", () => {
		connect();
		render(true);
		expect(historyRequests()).toHaveLength(1);
		props = { ...props, projectSessions: { "/archive": [] }, projects: [...props.projects] };
		render(true);
		expect(historyRequests()).toHaveLength(1);
		expect(container.textContent).not.toContain("正在读取会话");
	});

	it("does not duplicate the request when a project is expanded by clicking", () => {
		localStorage.setItem("pi-web-ui:lp-expanded-projects", "[]");
		connect();
		render();
		expect(historyRequests()).toHaveLength(0);
		const project = [...container.querySelectorAll<HTMLElement>(".lp-project-head-row")].find((row) =>
			row.textContent?.includes("archive"),
		);
		expect(project).toBeTruthy();
		act(() => project!.querySelector<HTMLElement>(".lp-project-chevron")!.click());
		expect(historyRequests()).toHaveLength(1);
	});
});
