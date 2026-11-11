// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { LeftPanel } from "../../web/src/components/LeftPanel.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import { resetAppGlobals, setAppGlobals } from "../../web/src/app-globals.js";

vi.mock("../../web/src/components/DeviceGroupSection.js", () => ({
	DeviceGroupSection: () => createElement("div", { className: "lp-section dg-side-section" }),
}));

let root: Root | null = null;

function stubStorage(initial?: Record<string, string>) {
	const store = new Map<string, string>(Object.entries(initial ?? {}));
	vi.stubGlobal("localStorage", {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
		clear: () => void store.clear(),
	} as unknown as Storage);
	localStorage.setItem("pi-web-ui:lang", "zh");
	return store;
}

function renderPanel(container: HTMLElement) {
	return createElement(
		LanguageProvider,
		null,
		createElement(LeftPanel as any, {
			active: true,
			sessionFile: null,
			conversations: [],
			elsewhere: [],
			sessions: [],
			projects: [{ path: "/project-a", lastUsed: Date.now() }],
			activeConversationId: "",
			panelSend: () => true,
		}),
	);
}

function mount(container: HTMLElement) {
	root = createRoot(container);
	act(() => {
		root!.render(renderPanel(container));
	});
}

afterEach(() => {
	root = null;
	resetAppGlobals();
	vi.unstubAllGlobals();
});

describe("项目展开/收起状态的持久化与首帧判据", () => {
	// 真实时序：LeftPanel 挂载时 websocket 快照还没到，cwd 是空的；快照到达后才有了 cwd。
	// 首帧判据必须落在「本地有没有记录」上，不能落在「cwd 有没有到」上。
	it("首次使用且 cwd 延迟到达：当前项目仍然展开，并把展开状态落盘", () => {
		const store = stubStorage();
		setAppGlobals({ ready: false, status: "open", workspaceRoots: [] });
		const container = document.createElement("div");
		document.body.appendChild(container);
		mount(container);

		act(() => {
			setAppGlobals({ cwd: "/project-a", ready: true, status: "open", workspaceRoots: [] });
		});
		act(() => {
			root!.render(renderPanel(container));
		});

		const children = container.querySelector(".lp-project-tree-children");
		expect(children?.classList.contains("is-expanded")).toBe(true);
		expect(JSON.parse(store.get("pi-web-ui:lp-expanded-projects") ?? "[]")).toEqual(["/project-a"]);
		container.remove();
	});

	it("上次收起了当前项目：cwd 延迟到达后仍然是收起的（不自作主张弹开）", () => {
		const store = stubStorage({ "pi-web-ui:lp-expanded-projects": "[]" });
		setAppGlobals({ ready: false, status: "open", workspaceRoots: [] });
		const container = document.createElement("div");
		document.body.appendChild(container);
		mount(container);

		act(() => {
			setAppGlobals({ cwd: "/project-a", ready: true, status: "open", workspaceRoots: [] });
		});
		act(() => {
			root!.render(renderPanel(container));
		});

		const children = container.querySelector(".lp-project-tree-children");
		expect(children?.classList.contains("is-expanded")).toBe(false);
		expect(JSON.parse(store.get("pi-web-ui:lp-expanded-projects") ?? "[]")).toEqual([]);
		container.remove();
	});
});
