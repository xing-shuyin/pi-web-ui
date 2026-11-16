// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import {
	buildSearchMenuEntries,
	GlobalSearchModal,
	type SearchMenuTarget,
} from "../../web/src/components/GlobalSearchModal.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import { zh } from "../../web/src/i18n/catalog.js";
import type { Translate } from "../../web/src/i18n.js";
import { buildUiSlots, type UiSlotEntry } from "../../web/src/ui-slots.js";
import type { FileSearchResult, SessionSearchResult } from "../../web/src/types.js";
import { resetAppGlobals, setAppGlobals, setAppSend } from "../../web/src/app-globals.js";
import { closeContextMenu, getContextMenu } from "../../web/src/context-menu-state.js";

vi.mock("../../web/src/search-req-id.js", () => ({ nextSearchReqId: () => 2 }));

const REQ_ID = 2;

const lookup = (key: string) => (zh as Record<string, string>)[key] ?? key;
const t = lookup as Translate;

const entries = buildUiSlots([], { locale: "zh", t: lookup })["contextmenu.search"];

function visible(target: SearchMenuTarget, opts: { conversationRef?: boolean; quickAskReferenceMenus?: boolean } = {}) {
	return buildSearchMenuEntries(entries, target, {
		t,
		conversationRef: opts.conversationRef ?? true,
		quickAskReferenceMenus: opts.quickAskReferenceMenus ?? true,
	})
		.filter((entry) => !entry.hidden)
		.map((entry) => entry.id);
}

function labelOf(target: SearchMenuTarget, id: string): string | undefined {
	const found = buildSearchMenuEntries(entries, target, {
		t,
		conversationRef: true,
		quickAskReferenceMenus: true,
	}).find((entry) => entry.id === id);
	return found?.label;
}

const session: SearchMenuTarget = {
	kind: "session",
	path: "/sessions/one.jsonl",
	title: "第一个对话",
	anchors: [],
	pinned: false,
	sessionId: "sid-1",
};
const project: SearchMenuTarget = { kind: "project", path: "/workspace/demo" };
const file: SearchMenuTarget = { kind: "file", path: "src/foo.ts", name: "foo.ts" };
const folder: SearchMenuTarget = { kind: "folder", path: "src/lib", name: "lib" };
const plugin: SearchMenuTarget = {
	kind: "plugin",
	providerId: "mail",
	providerLabel: "邮箱",
	title: "收件箱",
	action: "mail:inbox",
};

describe("搜索结果右键菜单条目（contextmenu.search）", () => {
	it("会话命中拿到打开/定位/钉住/引用/复制全套", () => {
		expect(visible(session)).toEqual([
			"host:search-open",
			"host:search-reveal",
			"host:search-pin",
			"host:search-quote",
			"host:search-quick-ask",
			"host:search-copy-name",
			"host:search-copy-path",
			"host:search-copy-id",
		]);
	});

	it("缺少会话 ID 时不展示复制 ID；已钉住时标签翻转", () => {
		expect(visible({ ...session, sessionId: undefined })).not.toContain("host:search-copy-id");
		expect(labelOf(session, "host:search-pin")).toBe(zh.pinConversation);
		expect(labelOf({ ...session, pinned: true }, "host:search-pin")).toBe(zh.unpinConversation);
	});

	it("项目命中可按项目切换/进文件面板，但没有相对路径与 ID", () => {
		const ids = visible(project);
		expect(ids).toContain("host:search-open-folder");
		expect(ids).not.toContain("host:search-copy-rel");
		expect(ids).not.toContain("host:search-copy-id");
		expect(ids).not.toContain("host:search-pin");
		expect(labelOf(project, "host:search-open")).toBe(zh.searchMenuSwitchProject);
	});

	it("文件与文件夹：有相对路径、无钉住/引用/ID，打开文案按类型区分", () => {
		for (const target of [file, folder]) {
			const ids = visible(target);
			expect(ids).toContain("host:search-copy-rel");
			expect(ids).not.toContain("host:search-copy-id");
			expect(ids).not.toContain("host:search-pin");
			expect(ids).not.toContain("host:search-quote");
			expect(ids).not.toContain("host:search-open-folder");
		}
		expect(labelOf(file, "host:search-open")).toBe(zh.fileOpenPreview);
		expect(labelOf(folder, "host:search-open")).toBe(zh.fileEnterDir);
	});

	it("插件命中只剩打开与复制名称", () => {
		expect(visible(plugin)).toEqual(["host:search-open", "host:search-copy-name"]);
	});

	it("随手问引用入口与对话引用能力各自独立开关", () => {
		expect(visible(session, { quickAskReferenceMenus: false })).not.toContain("host:search-quick-ask");
		expect(visible(session, { conversationRef: false })).not.toContain("host:search-quote");
	});

	it("插件贡献的条目原样透传，不被宿主规则改写", () => {
		const contributed: UiSlotEntry = {
			id: "mail:send-hit",
			slot: "contextmenu.search",
			source: "plugin:mail",
			label: "发到邮箱",
			kind: "action",
			order: 5,
			align: "start",
			hidden: false,
			userOverrides: [],
			arrangedBy: [],
			when: ["search.isFile"],
		};
		for (const target of [session, file, plugin]) {
			const kept = buildSearchMenuEntries([contributed], target, {
				t,
				conversationRef: true,
				quickAskReferenceMenus: true,
			});
			expect(kept).toEqual([contributed]);
		}
	});
});

let root: Root | null = null;

afterEach(() => {
	vi.unstubAllGlobals();
	resetAppGlobals();
	setAppSend(null);
	closeContextMenu();
	if (root) act(() => root!.unmount());
	root = null;
	document.body.innerHTML = "";
});

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

interface HitPayload {
	sessions: SessionSearchResult[];
	files: FileSearchResult[];
}

const HITS: HitPayload = {
	sessions: [
		{
			path: "/sessions/one.jsonl",
			sessionId: "sid-1",
			name: "对话一",
			firstMessage: "hello one",
			messageCount: 2,
			modified: 1,
			anchors: [],
			pinned: false,
		},
	],
	files: [{ path: "src/foo.ts", name: "foo.ts", type: "file" }],
};

async function mountSearchModal(overrides: { quickAskReferenceMenus?: boolean } = {}) {
	stubZhStorage();
	setAppGlobals({ cwd: "/workspace/demo" });
	const sent: { type: string }[] = [];
	setAppSend((msg) => {
		sent.push(msg as { type: string });
		return true;
	});
	const switched: string[] = [];
	const closed: number[] = [];
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	const element = (hits: HitPayload) =>
		createElement(
			LanguageProvider,
			null,
			createElement(GlobalSearchModal, {
				open: true,
				projects: [{ path: "/workspace/demo", lastUsed: 1 }],
				fileSearch: { reqId: REQ_ID, ok: true, results: hits.files },
				sessionSearch: { reqId: REQ_ID, ok: true, results: hits.sessions },
				uiContextSearch: entries,
				quickAskReferenceMenus: overrides.quickAskReferenceMenus ?? true,
				onClose: () => closed.push(1),
				onSwitchSession: (path: string) => switched.push(path),
				onSwitchProject: () => {},
				onPreviewFile: () => {},
				onOpenFolder: () => {},
			}),
		);
	act(() => root!.render(element({ sessions: [], files: [] })));
	const input = container.querySelector(".gs-input-row input") as HTMLInputElement;
	const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
	act(() => {
		setValue.call(input, "one");
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 360));
	});
	// 结果由服务端在请求之后回来，用二次渲染模拟（组件按 reqId 对齐后才展示命中）
	act(() => root!.render(element(HITS)));
	return { container, sent, switched, closed };
}

function rightClick(el: Element) {
	act(() => {
		el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 12, clientY: 34 }));
	});
}

describe("搜索结果右键菜单（DOM 交互）", () => {
	it("右键会话命中：打开 contextmenu.search，会话专属条目可见", async () => {
		const { container } = await mountSearchModal();
		const row = container.querySelector(".gs-item-wrap");
		expect(row, "会话行应已渲染").toBeTruthy();
		rightClick(row!);
		const menu = getContextMenu();
		expect(menu?.slot).toBe("contextmenu.search");
		expect(menu?.target).toMatchObject({ id: "/sessions/one.jsonl", kind: "session" });
		const visibleIds = (menu?.entries ?? []).filter((entry) => !entry.hidden).map((entry) => entry.id);
		expect(visibleIds).toContain("host:search-pin");
		expect(visibleIds).toContain("host:search-copy-id");
	});

	it("菜单打开时 Esc 归菜单，不会顺手关掉搜索框", async () => {
		const { container, closed } = await mountSearchModal();
		rightClick(container.querySelector(".gs-item-wrap")!);
		expect(getContextMenu()).not.toBeNull();
		act(() => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		});
		expect(closed).toHaveLength(0);
	});

	it("右键文件命中：预览文案 + 相对路径复制可用、钉住隐藏", async () => {
		const { container } = await mountSearchModal();
		const fileRow = Array.from(container.querySelectorAll(".gs-item")).find((el) => el.textContent?.includes("foo.ts"));
		expect(fileRow, "文件行应已渲染").toBeTruthy();
		rightClick(fileRow!);
		const menu = getContextMenu();
		expect(menu?.target).toMatchObject({ id: "src/foo.ts", kind: "file" });
		const byId = new Map((menu?.entries ?? []).map((entry) => [entry.id, entry]));
		expect(byId.get("host:search-open")?.label).toBe(zh.fileOpenPreview);
		expect(byId.get("host:search-copy-rel")?.hidden).toBe(false);
		expect(byId.get("host:search-pin")?.hidden).toBe(true);
	});

	it("宿主动作真正落到服务端：钉住会话", async () => {
		const { container, sent } = await mountSearchModal();
		rightClick(container.querySelector(".gs-item-wrap")!);
		const menu = getContextMenu()!;
		const pin = menu.entries.find((entry) => entry.id === "host:search-pin");
		expect(pin).toBeTruthy();
		act(() => {
			menu.onHostAction!(pin!, menu.target);
		});
		expect(sent).toContainEqual({ type: "pin_session", path: "/sessions/one.jsonl", pinned: true });
	});

	it("宿主动作真正落地：打开对话调用 switch_session 回调", async () => {
		const { container, switched } = await mountSearchModal();
		rightClick(container.querySelector(".gs-item-wrap")!);
		const menu = getContextMenu()!;
		const open = menu.entries.find((entry) => entry.id === "host:search-open");
		expect(open).toBeTruthy();
		act(() => {
			menu.onHostAction!(open!, menu.target);
		});
		expect(switched).toEqual(["/sessions/one.jsonl"]);
	});
});
