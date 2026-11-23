// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { TopBar } from "../../web/src/components/TopBar.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import type { ChatState } from "../../web/src/use-chat.js";

/**
 * 更新中心的布局与 issue #321 的 SDK 分叉提示。
 *
 * 旧版这些断言绑在 `.dd-all-item` 下拉上；面板改成居中模态后（`web/src/components/UpdateModal.tsx`），
 * 语义一样、DOM 变了，所以断言跟着 DOM 走：
 * - 组件行的信息顺序（名称 → 类型 → 版本 → 动作）
 * - 窄屏下通道卡从两列变一列（动作换行，不再和版本号抢宽度）
 * - 「装了更新的全局 pi」只提示、不给假按钮；「随包自带」才给安装入口
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const UPDATE_CSS = readFileSync(join(ROOT, "web", "src", "components", "update-center.css"), "utf8");

const chatStub = {
	status: "open",
	ready: true,
	state: null,
	activeConversationId: "",
	terminals: [],
	bgServers: [],
	tabs: undefined,
	update: null,
	updatesSdk: null,
	updatesAll: [
		{ name: "demo-ext", kind: "package", current: "123", latest: "125", upToDate: false },
		{ name: "steady-ext", kind: "package", current: "10", latest: "10", upToDate: true },
		{ name: "broken-ext", kind: "package", current: "1", latest: null, upToDate: false, error: "nope" },
	],
} as unknown as ChatState;

const SPLIT = { running: "0.85.1", bundledInUse: true, newerInstalled: "0.95.0" };
const splitChatStub = {
	...chatStub,
	updatesSdk: SPLIT,
	updatesAll: [
		{ name: "@earendil-works/pi-coding-agent", kind: "pi-core", current: "0.95.0", latest: "0.95.0", upToDate: true },
	],
} as unknown as ChatState;

const bundledChatStub = {
	...chatStub,
	updatesSdk: { running: "0.87.1", bundledInUse: true, newerInstalled: null },
	updatesAll: [{ name: "steady-ext", kind: "package", current: "10", latest: "10", upToDate: true }],
} as unknown as ChatState;

const followingChatStub = {
	...chatStub,
	updatesSdk: { running: "0.95.0", bundledInUse: false, newerInstalled: null },
	updatesAll: [{ name: "steady-ext", kind: "package", current: "10", latest: "10", upToDate: true }],
} as unknown as ChatState;

const bundledCurrentStub = {
	...chatStub,
	updatesSdk: { running: "0.87.1", bundledInUse: true, newerInstalled: null },
	updatesAll: [
		{ name: "@earendil-works/pi-coding-agent", kind: "pi-core", current: "0.87.1", latest: "0.87.1", upToDate: true },
	],
} as unknown as ChatState;

const bundledStaleStub = {
	...chatStub,
	updatesSdk: { running: "0.87.1", bundledInUse: true, newerInstalled: null },
	updatesAll: [
		{ name: "@earendil-works/pi-coding-agent", kind: "pi-core", current: "0.85.0", latest: "0.95.0", upToDate: false },
	],
} as unknown as ChatState;

const findInstallBtn = (scope: ParentNode = document) =>
	Array.from(scope.querySelectorAll("button.uc-btn")).find((b) => b.textContent?.includes("Install global engine"));

let root: Root | null = null;

function mount(chat: ChatState = chatStub) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	act(() => {
		root!.render(
			createElement(
				LanguageProvider,
				null,
				createElement(TopBar, {
					chat,
					terminal: {
						create: () => {},
						close: () => {},
						register: () => () => {},
						restart: () => {},
						select: () => {},
					},
					view: "chat",
					plugins: [],
					onViewChange: () => {},
					onOpenPanel: () => {},
					onOpenSettings: () => {},
					onOpenBgTasks: () => {},
					onOpenGlobalSearch: () => {},
					sound: { enabled: false, volume: 0.5, kinds: {} },
					onSoundChange: () => {},
					onSoundPreview: () => {},
					themes: [],
					theme: null,
					onThemeChange: () => {},
					reloadThemes: () => {},
				} as unknown as Parameters<typeof TopBar>[0]),
			),
		);
	});
	openCenter();
	return container;
}

/** 点顶栏的更新 chip，弹出更新中心（portal 到 body，所以断言用 document 查）。 */
function openCenter() {
	const chip = document.querySelector<HTMLButtonElement>('button.chip[aria-haspopup="dialog"]');
	expect(chip, "顶栏应有更新 chip").toBeTruthy();
	act(() => chip!.click());
	expect(document.querySelector(".uc-sheet"), "应打开更新中心").toBeTruthy();
}

afterEach(() => {
	if (root) act(() => root!.unmount());
	root = null;
	document.body.innerHTML = "";
});

describe("更新中心：组件行布局", () => {
	it("可更新行给出动作按钮，且信息顺序是 名称 → 类型 → 版本 → 按钮", () => {
		mount();
		const row = Array.from(document.querySelectorAll(".uc-row")).find((li) => li.querySelector("button.uc-btn"))!;
		const flat = Array.from(row.querySelectorAll("button.uc-btn, .uc-row-name, .uc-pill, .uc-row-vers"));
		const order = flat.map((el) => (el.tagName === "BUTTON" ? "button" : (el.className.split(" ")[0] ?? "")));
		expect(order[0]).toBe("uc-row-name");
		expect(order[order.length - 1]).toBe("button");
	});

	it("名称有最小宽度 + 省略号（长包名不把按钮挤出屏幕）", () => {
		const nameBlock = UPDATE_CSS.match(/\.uc-row-name\s*\{[^}]*\}/s)?.[0] ?? "";
		expect(nameBlock).toMatch(/min-width\s*:\s*0/);
		expect(nameBlock).toMatch(/text-overflow\s*:\s*ellipsis/);
	});

	it("窄屏：通道卡从两列变一列，动作换行而不是绝对定位", () => {
		const mobile = UPDATE_CSS.slice(UPDATE_CSS.indexOf("@media (max-width: 640px)"));
		expect(mobile).toMatch(/\.uc-axis\s*\{[^}]*grid-template-columns\s*:\s*minmax\(0,\s*1fr\)/s);
		expect(mobile).toMatch(/\.uc-axis-act\s*\{[^}]*grid-column\s*:\s*1/s);
		expect(mobile).not.toMatch(/position\s*:\s*absolute/);
	});
});

describe("issue #321 pi SDK split surfacing", () => {
	it("服务跑的比机器上装的旧：引擎轴标 warn 并写出两个版本", () => {
		mount(splitChatStub);
		const axis = Array.from(document.querySelectorAll(".uc-axis")).find((li) => li.textContent?.includes("pi engine"))!;
		expect(axis.classList.contains("tone-warn")).toBe(true);
		expect(axis.textContent).toContain(SPLIT.running);
		expect(axis.textContent).toContain(SPLIT.newerInstalled);
		expect(axis.textContent).toContain("PI_WEB_SDK=bundled");
	});

	it("这条轴不给更新按钮（npm i -g pi@latest 修不了正在跑的那份）", () => {
		mount(splitChatStub);
		const axis = Array.from(document.querySelectorAll(".uc-axis")).find((li) => li.textContent?.includes("pi engine"))!;
		expect(axis.querySelector("button.uc-btn")).toBeNull();
	});

	it("没有分叉 → 不出现 PI_WEB_SDK 说明", () => {
		mount();
		expect(document.querySelector(".uc-sheet")!.textContent).not.toContain("PI_WEB_SDK");
	});
});

describe("issue #321 bundled engine surfacing", () => {
	it("随包自带（清单里没有引擎行）→ 说明 + 安装入口", () => {
		mount(bundledChatStub);
		expect(document.querySelector(".uc-sheet")!.textContent).toContain("0.87.1");
		expect(findInstallBtn()).toBeTruthy();
	});

	it("自带 + 全局同版本且都是最新 → 安静（不提示、不按钮）", () => {
		mount(bundledCurrentStub);
		const axis = Array.from(document.querySelectorAll(".uc-axis")).find((li) => li.textContent?.includes("pi engine"))!;
		expect(axis.querySelector(".uc-hint")).toBeNull();
		expect(findInstallBtn()).toBeUndefined();
	});

	it("自带 + 全局比 npm 最新旧 → 有更新入口，不重复给安装按钮", () => {
		mount(bundledStaleStub);
		const sheet = document.querySelector(".uc-sheet")!;
		expect(sheet.textContent).toContain("0.87.1");
		expect(findInstallBtn()).toBeUndefined();
		const axis = Array.from(document.querySelectorAll(".uc-axis")).find((li) => li.textContent?.includes("pi engine"))!;
		expect(axis.querySelector("button.uc-btn")).toBeTruthy();
	});

	it("跟随全局副本（非 bundled）→ 没有安装入口", () => {
		mount(followingChatStub);
		expect(findInstallBtn()).toBeUndefined();
	});
});
