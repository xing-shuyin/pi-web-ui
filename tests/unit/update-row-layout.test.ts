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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CSS = readFileSync(join(ROOT, "web", "src", "styles.css"), "utf8");

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

const findInstallBtn = (container: HTMLElement) =>
	Array.from(container.querySelectorAll("button.dd-refresh")).find((b) =>
		b.textContent?.includes("Install global engine"),
	);

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
	act(() => {
		for (const chip of Array.from(
			container.querySelectorAll<HTMLButtonElement>('button.chip[aria-expanded="false"]'),
		)) {
			chip.click();
		}
	});
	return container;
}

afterEach(() => {
	if (root) act(() => root!.unmount());
	root = null;
	document.body.innerHTML = "";
});

describe("w10 update row layout", () => {
	it("outdated row: update button is the leftmost (first) DOM child", () => {
		const container = mount();
		const rows = Array.from(container.querySelectorAll("li.dd-all-item.warn")).filter((li) =>
			li.querySelector("button.dd-update-btn"),
		);
		expect(rows.length).toBeGreaterThan(0);
		for (const li of rows) {
			expect(li.firstElementChild?.tagName).toBe("BUTTON");
			expect(li.firstElementChild?.classList.contains("dd-update-btn")).toBe(true);
		}
	});

	it("outdated row child order: button, name, meta(kind, version)", () => {
		const container = mount();
		const row = Array.from(container.querySelectorAll("li.dd-all-item.warn")).find((li) =>
			li.querySelector("button.dd-update-btn"),
		)!;
		const order = Array.from(row.children).map((el) =>
			el.classList.contains("dd-update-btn") ? "button" : el.className.split(" ").find((c) => c.startsWith("dd-all-")),
		);
		expect(order).toEqual(["button", "dd-all-name", "dd-all-meta"]);
		const meta = row.querySelector(":scope > .dd-all-meta")!;
		const metaOrder = Array.from(meta.children).map((el) =>
			el.className.split(" ").find((c) => c.startsWith("dd-all-")),
		);
		expect(metaOrder).toEqual(["dd-all-kind", "dd-all-vers"]);
	});

	it("accessible DOM order stays button, name, kind, version", () => {
		const container = mount();
		const row = Array.from(container.querySelectorAll("li.dd-all-item.warn")).find((li) =>
			li.querySelector("button.dd-update-btn"),
		)!;
		const flat = Array.from(row.querySelectorAll("button.dd-update-btn, .dd-all-name, .dd-all-kind, .dd-all-vers"));
		expect(
			flat.map((el) =>
				el.tagName === "BUTTON"
					? "button"
					: (el as HTMLElement).className.split(" ").find((c) => c.startsWith("dd-all-")),
			),
		).toEqual(["button", "dd-all-name", "dd-all-kind", "dd-all-vers"]);
	});

	it("no CSS pushes the row button right (order / margin-left / float / absolute)", () => {
		const btnBlock = CSS.match(/\.dd-update-btn\s*\{[^}]*\}/s)?.[0] ?? "";
		expect(btnBlock).not.toMatch(/^\s*order\s*:/m);
		expect(btnBlock).not.toMatch(/margin-left\s*:\s*auto/);
		expect(btnBlock).not.toMatch(/float\s*:/);
		expect(btnBlock).not.toMatch(/position\s*:\s*(absolute|fixed)/);
	});

	it("warn rows wrap so the meta drops to a second line, name keeps a floor width", () => {
		const warnBlock = CSS.match(/\.dd-all-item\.warn\s*\{[^}]*\}/s)?.[0] ?? "";
		expect(warnBlock).toMatch(/flex-wrap\s*:\s*wrap/);
		const nameBlock = CSS.match(/\.dd-all-item\.warn\s+\.dd-all-name\s*\{[^}]*\}/s)?.[0] ?? "";
		expect(nameBlock).toMatch(/min-width\s*:/);
	});

	it("wrapped second line: kind first, kind + version right-aligned via meta", () => {
		const metaBlock = CSS.match(/\.dd-all-meta\s*\{[^}]*\}/s)?.[0] ?? "";
		expect(metaBlock).toMatch(/display\s*:\s*flex/);
		expect(metaBlock).toMatch(/flex-shrink\s*:\s*0/);
		expect(metaBlock).not.toMatch(/position\s*:\s*(absolute|fixed)/);
		expect(metaBlock).not.toMatch(/^\s*order\s*:/m);
		const warnMetaBlock = CSS.match(/\.dd-all-item\.warn\s+\.dd-all-meta\s*\{[^}]*\}/s)?.[0] ?? "";
		expect(warnMetaBlock).toMatch(/margin-left\s*:\s*auto/);
		expect(warnMetaBlock).not.toMatch(/position\s*:\s*(absolute|fixed)/);
	});
});

describe("issue #321 pi SDK split surfacing", () => {
	it("up-to-date pi-core row still reads warn when the service runs an older bundled SDK", () => {
		const container = mount(splitChatStub);
		const row = container.querySelector("li.dd-all-item")!;
		expect(row.classList.contains("warn")).toBe(true);
		expect(row.querySelector(".dd-split-run")?.textContent).toContain(SPLIT.running);
	});

	it("no update button on that row: `npm i -g pi@latest` would not fix the service", () => {
		const container = mount(splitChatStub);
		const row = container.querySelector("li.dd-all-item")!;
		expect(row.querySelector("button.dd-update-btn")).toBeNull();
	});

	it("the panel explains the split (versions + both ways out) in a warn note", () => {
		const container = mount(splitChatStub);
		const note = container.querySelector(".dd-note.warn")!;
		expect(note.textContent).toContain(SPLIT.running);
		expect(note.textContent).toContain(SPLIT.newerInstalled);
		expect(note.textContent).toContain("PI_WEB_SDK=bundled");
	});

	it("no split → no note, no suffix (normal panel stays untouched)", () => {
		const container = mount();
		expect(container.querySelector(".dd-note.warn")).toBeNull();
		expect(container.querySelector(".dd-split-run")).toBeNull();
	});
});

describe("issue #321 bundled engine surfacing", () => {
	it("bundled engine → info note with the running version + install button", () => {
		const container = mount(bundledChatStub);
		const note = container.querySelector(".dd-note:not(.warn)")!;
		expect(note.textContent).toContain("0.87.1");
		expect(findInstallBtn(container)).toBeTruthy();
	});

	it("bundled + global same version and both latest → fully quiet (no note, no button)", () => {
		const container = mount(bundledCurrentStub);
		expect(container.querySelector(".dd-note:not(.warn)")).toBeNull();
		expect(findInstallBtn(container)).toBeUndefined();
	});

	it("bundled + global older than npm latest → note for context, no duplicate button", () => {
		const container = mount(bundledStaleStub);
		const note = container.querySelector(".dd-note:not(.warn)")!;
		expect(note.textContent).toContain("0.87.1");
		expect(findInstallBtn(container)).toBeUndefined();
		expect(container.querySelector("button.dd-update-btn")).toBeTruthy();
	});

	it("not bundled (following a global copy) → no install entry", () => {
		const container = mount(followingChatStub);
		expect(findInstallBtn(container)).toBeUndefined();
		expect(container.querySelector(".dd-note:not(.warn)")).toBeNull();
	});
});
