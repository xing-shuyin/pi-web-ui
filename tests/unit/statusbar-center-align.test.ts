// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BROWSER_TEST_TIMEOUT_MS, CHROME_PATH } from "../lib/chrome.mjs";
import { resetAppGlobals, setAppGlobals } from "../../web/src/app-globals.js";
import { FooterBar } from "../../web/src/components/FooterBar.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import type { ChatState } from "../../web/src/use-chat.js";
import type { UiSlotEntry } from "../../web/src/ui-slots.js";

/**
 * 状态栏「搜索」入口（默认 align:center，落在 .statusbar-center）与左右两组状态项
 * 必须坐在同一条水平线上：中间组如果不是 flex 行，里面的 inline-flex 按钮会按行盒
 * 基线落位，整体比相邻状态项高半个像素，看起来图标与文字没垂直居中（issue #918）。
 */

const root0 = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

let root: Root | null = null;

/** 把 styles.css 的 @import 链就地展开，得到能直接塞进页面的完整样式表。 */
function inlineCss(path: string, ancestors = new Set<string>()): string {
	expect(ancestors.has(path), `Circular CSS import: ${path}`).toBe(false);
	const next = new Set([...ancestors, path]);
	return readFileSync(path, "utf8").replace(
		/@import\s+["']([^"']+)["']\s*([^;]*);/g,
		(_, href: string, layer: string) => {
			const css = inlineCss(resolve(dirname(path), href), next);
			const name = /^layer\(([^)]+)\)$/.exec(layer.trim());
			return name ? `@layer ${name[1]} {${css}}` : css;
		},
	);
}

function makeChatState(): ChatState {
	return {
		status: "open",
		ready: true,
		state: {
			cwd: "D:/test-project",
			sessionFile: null,
			conversationId: "conv-1",
			history: [],
			queue: { steering: [], followUp: [] },
			isStreaming: false,
			streamingMessage: null,
			stats: {
				tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				contextUsage: { tokens: 0, contextWindow: 8000, percent: 0, estimated: false },
				cost: 0,
				totalMessages: 0,
			},
		} as unknown as ChatState["state"],
		activeConversationId: "conv-1",
		conversations: [],
		elsewhere: [],
		sessions: [],
		projects: [],
		terminals: [],
		bgServers: [],
		pathCompletions: [],
		notices: [],
		statuses: [],
	} as unknown as ChatState;
}

function entry(over: Partial<UiSlotEntry> & Pick<UiSlotEntry, "id">): UiSlotEntry {
	return {
		slot: "bottombar",
		source: "host",
		label: over.id,
		kind: "action",
		order: 10,
		align: "start",
		hidden: false,
		userOverrides: [],
		arrangedBy: [],
		...over,
	};
}

/** 搜索入口居中、左右各有一个状态项：正是顶栏「搜索」被拖进底栏后的默认形态。 */
const BAR_ITEMS: UiSlotEntry[] = [
	entry({ id: "host:cwd" }),
	entry({ id: "host:search", label: "搜索", align: "center", icon: "search" }),
];

function mountFooter(): { container: HTMLElement } {
	const store = new Map<string, string>();
	vi.stubGlobal("localStorage", {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
		clear: () => void store.clear(),
	} as unknown as Storage);
	localStorage.setItem("pi-web-ui:lang", "zh");
	setAppGlobals({ ready: true, status: "open" });
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	act(() => {
		root!.render(
			createElement(
				LanguageProvider,
				null,
				createElement(FooterBar, { chat: makeChatState(), bottombarItems: BAR_ITEMS }),
			),
		);
	});
	return { container };
}

afterEach(() => {
	vi.unstubAllGlobals();
	resetAppGlobals();
	if (root) act(() => root!.unmount());
	root = null;
	document.body.innerHTML = "";
});

describe("状态栏中间组对齐", () => {
	it("搜索入口落在 .statusbar-center 里，且中间组沿用左右两组的 flex 行布局", () => {
		const { container } = mountFooter();
		const center = container.querySelector(".statusbar-center");
		expect(center).not.toBeNull();
		expect(center?.querySelector('[data-bar-item="host:search"]')).not.toBeNull();
		expect(container.querySelector(".statusbar-left")?.querySelector('[data-bar-item="host:search"]')).toBeNull();

		const css = readFileSync(join(root0, "web/src/styles.css"), "utf8").replace(/^\t/gm, "");
		expect(css).toMatch(/\.statusbar-left,\s*\.statusbar-center,\s*\.statusbar-right\s*\{[^}]*display:\s*flex;/);
		expect(css).toMatch(/\.statusbar-center\s*\{[^}]*flex:\s*0\s+0\s+auto;/);
	});

	it.skipIf(!CHROME_PATH)(
		"搜索的图标与文字和相邻状态项同一条水平线，窄屏下不被压扁或裁切",
		async () => {
			const { container } = mountFooter();
			document.body.innerHTML = "";
			const css = inlineCss(join(root0, "web/src/styles.css"));
			const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true, args: ["--no-sandbox"] });
			try {
				const page = await browser.newPage({ viewport: { width: 1280, height: 300 } });
				await page.setContent(
					`<style>${css}\nhtml,body{margin:0}body{font-family:var(--sans);font-size:14px;line-height:1.6}
					.stage{position:fixed;inset:0;display:flex;flex-direction:column;justify-content:flex-end}</style>
					<div class="stage">${container.innerHTML}</div>`,
				);

				const measure = () =>
					page.evaluate(() => {
						const box = (sel: string) => {
							const el = document.querySelector(sel);
							if (!el) return null;
							const r = el.getBoundingClientRect();
							const style = getComputedStyle(el);
							return {
								top: r.top,
								bottom: r.bottom,
								left: r.left,
								right: r.right,
								width: r.width,
								height: r.height,
								cy: (r.top + r.bottom) / 2,
								color: style.color,
								display: style.display,
								alignItems: style.alignItems,
								flexShrink: style.flexShrink,
							};
						};
						return {
							bar: box(".statusbar"),
							barBorderTop: document.querySelector(".statusbar")
								? parseFloat(getComputedStyle(document.querySelector(".statusbar")!).borderTopWidth)
								: 0,
							center: box(".statusbar-center"),
							search: box('[data-bar-item="host:search"]'),
							icon: box('[data-bar-item="host:search"] .bar-item-icon'),
							label: box('[data-bar-item="host:search"] .bar-item-text'),
							cwd: box('[data-bar-item="host:cwd"]'),
						};
					});

				const wide = await measure();
				expect(wide.center?.display).toBe("flex");
				expect(wide.center?.alignItems).toBe("center");
				expect(wide.center?.flexShrink).toBe("0");
				// 同一行：搜索入口与相邻状态项的上下边一致（旧实现里它整体高 0.55px）。
				expect(Math.abs((wide.search?.top ?? 0) - (wide.cwd?.top ?? 0))).toBeLessThan(0.5);
				expect(Math.abs((wide.search?.bottom ?? 0) - (wide.cwd?.bottom ?? 0))).toBeLessThan(0.5);
				// 并且在状态栏内容区里垂直居中（内容区 = 边框盒去掉上边框）。
				const barContentCenter = ((wide.bar?.top ?? 0) + wide.barBorderTop + (wide.bar?.bottom ?? 0)) / 2;
				expect(Math.abs((wide.search?.cy ?? 0) - barContentCenter)).toBeLessThan(0.5);
				// 图标与文字各自居中于按钮，不是只有其中一个贴中线。
				expect(Math.abs((wide.icon?.cy ?? 0) - (wide.search?.cy ?? 0))).toBeLessThan(0.5);
				expect(Math.abs((wide.label?.cy ?? 0) - (wide.search?.cy ?? 0))).toBeLessThan(0.5);
				// 次级文字颜色保持与相邻状态项一致。
				expect(wide.search?.color).toBe(wide.cwd?.color);

				await page.setViewportSize({ width: 900, height: 300 });
				const narrow = await measure();
				expect(narrow.search?.width).toBe(wide.search?.width);
				expect((narrow.search?.right ?? 0) <= (narrow.bar?.right ?? 0) - 1).toBe(true);
				expect(Math.abs((narrow.search?.cy ?? 0) - (narrow.cwd?.cy ?? 0))).toBeLessThan(0.5);
			} finally {
				await browser.close();
			}
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});
