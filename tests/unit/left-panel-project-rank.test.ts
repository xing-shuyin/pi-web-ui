// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { LeftPanel } from "../../web/src/components/LeftPanel.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import { resetAppGlobals, setAppGlobals } from "../../web/src/app-globals.js";
import { normalizeSessionPathKey } from "../../web/src/use-chat.js";

const RANK_KEY = "pi-web-ui:lp-project-rank";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function stubStorage(seed: Record<string, string> = {}) {
	const store = new Map<string, string>(Object.entries(seed));
	vi.stubGlobal("localStorage", {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
		clear: () => store.clear(),
	} as unknown as Storage);
	localStorage.setItem("pi-web-ui:lang", "zh");
	return store;
}

function mount(projects: { path: string; lastUsed: number }[], seed: Record<string, string>) {
	const store = stubStorage(seed);
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	setAppGlobals({ cwd: projects[0]?.path ?? "/w", ready: true, status: "open" });
	const props = {
		active: true,
		sessionFile: null,
		conversations: [],
		elsewhere: [],
		sessions: [],
		projects,
		activeConversationId: "",
		panelSend: () => true,
	};
	act(() => {
		root!.render(createElement(LanguageProvider, null, createElement(LeftPanel as any, props)));
	});
	return { store };
}

function projectTitles(): string[] {
	return [...container!.querySelectorAll(".projects-scroll .project-item .lp-project-name")].map((el) =>
		(el.textContent ?? "").trim(),
	);
}

afterEach(() => {
	if (root && container) {
		act(() => root!.unmount());
		container.remove();
	}
	root = null;
	container = null;
	resetAppGlobals();
	vi.restoreAllMocks();
});

describe("项目排位持久化", () => {
	it("有持久化排位时按排位渲染，不按 lastUsed 重排", () => {
		const projects = [
			{ path: "/project-new", lastUsed: 2000 },
			{ path: "/project-old", lastUsed: 1000 },
		];
		const ranks = [
			[normalizeSessionPathKey("/project-old"), 1],
			[normalizeSessionPathKey("/project-new"), 2],
		];
		mount(projects, { [RANK_KEY]: JSON.stringify(ranks) });

		// lastUsed 说 project-new 更新，但排位里 project-old 在前：以排位为准。
		expect(projectTitles().map((t) => t.split("\n")[0])).toEqual(["project-old", "project-new"]);
	});

	it("没有持久化排位时按 lastUsed 排，并把结果落盘", () => {
		const projects = [
			{ path: "/project-old", lastUsed: 1000 },
			{ path: "/project-new", lastUsed: 2000 },
		];
		const { store } = mount(projects, {});

		expect(projectTitles().map((t) => t.split("\n")[0])).toEqual(["project-new", "project-old"]);
		const saved = store.get(RANK_KEY);
		expect(saved).toBeTruthy();
		const parsed = JSON.parse(saved!) as [string, number][];
		expect(parsed.map(([path]) => path)).toEqual([
			normalizeSessionPathKey("/project-new"),
			normalizeSessionPathKey("/project-old"),
		]);
	});

	it("坏数据不影响渲染：解析失败时退化成按 lastUsed 排", () => {
		const projects = [
			{ path: "/a", lastUsed: 1000 },
			{ path: "/b", lastUsed: 2000 },
		];
		mount(projects, { [RANK_KEY]: "{oops" });
		expect(projectTitles()).toHaveLength(2);
	});
});
