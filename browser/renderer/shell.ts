import {
	addressUrl,
	agentModeIcon,
	applySettings,
	arrowTopRightIcon,
	bridgeReady,
	browserModeIcon,
	button,
	call,
	closeIcon,
	createSvg,
	element,
	enableCrxDropTarget,
	extensionIcon,
	globeIcon,
	iconButton,
	input,
	listenPanelEvents,
	listenState,
	plusIcon,
	reportError,
	searchIcon,
	spinnerIcon,
	splitModeIcon,
	svgPath,
	svgRect,
	type Settings,
} from "./common.js";
import { t } from "./i18n.js";
import { addCurrentBookmark, closeShellPanel, showShellPanel } from "./panels.js";
import type { BrowserMode, BrowserState } from "../contracts.js";
import { BROWSER_EXTENSION_PARTITION } from "../contracts.js";

document.body.classList.add("pb-shell");
enableCrxDropTarget();
let state: BrowserState | undefined;
let settings: Settings = {};
let searchOpen = false;

async function browserAction(
	action: "navigate" | "back" | "forward" | "reload" | "tabs.activate" | "tabs.create",
	args?: Record<string, unknown>,
): Promise<void> {
	await closeShellPanel();
	if (searchOpen) await hideSearch();
	if (state?.mode === "agent") await call("mode", { mode: "browser" });
	await call(action, args);
}

const app = document.querySelector<HTMLElement>("#app")!;
const chrome = element("header", "pb-chrome");
const titlebar = element("div", "pb-chrome-row pb-tab-row");

const tabs = element("div", "pb-tabs");
tabs.setAttribute("role", "tablist");
tabs.setAttribute("aria-label", t("browser"));
const create = iconButton(plusIcon(12), `${t("newTab")} (Ctrl+T)`, () => browserAction("tabs.create"));
create.classList.add("pb-new-tab-btn");

const dragArea = element("div", "pb-drag-area");

// Agent 未就绪时（默认就是 Agent 启动）覆盖窗口，避免空白等待；失败时给出切换浏览器的出口
const boot = element("div", "pb-boot");
const bootIcon = element("div", "pb-boot-icon pb-spinning");
bootIcon.append(spinnerIcon(18));
const bootText = element("p", "pb-boot-text", t("bootingAgent"));
const bootError = element("p", "pb-boot-error", "");
const bootAction = button(t("switchToBrowser"), () => call("mode", { mode: "browser" }).then(() => {}, reportError));
bootAction.classList.add("pb-boot-action");
boot.append(bootIcon, bootText, bootError, bootAction);
app.append(boot);

function renderBoot(next: BrowserState, left: number): void {
	const waiting = next.mode !== "browser" && !next.agentReady;
	boot.classList.toggle("pb-hidden", !waiting);
	if (!waiting) return;
	boot.style.left = "0px";
	boot.style.width = next.mode === "split" ? `${Math.max(0, left)}px` : "100%";
	boot.classList.toggle("pb-boot-failed", Boolean(next.agentError));
	bootIcon.style.display = next.agentError ? "none" : "";
	bootText.textContent = next.agentError ? t("agentUnavailable") : t("bootingAgent");
	bootError.textContent = next.agentError || "";
}

const modeBtn = iconButton(splitModeIcon(13), "模式切换 (Ctrl+Alt+M)", async () => {
	await closeShellPanel();
	if (searchOpen) await hideSearch();
	const nextMode: BrowserMode = state?.mode === "browser" ? "split" : state?.mode === "split" ? "agent" : "browser";
	await call("mode", { mode: nextMode });
});
modeBtn.classList.add("pb-tool-btn");

const searchBtn = iconButton(searchIcon(13), "搜索或输入网址 (Ctrl+L)", () => {
	if (searchOpen) void hideSearch();
	else void openSearch();
});
searchBtn.classList.add("pb-tool-btn");

// 扩展入口：点开就是扩展面板（点行开扩展页面 / 行尾菜单启停、重载、移除），徽标只报「已启用」数量
const extensionsBtn = iconButton(extensionIcon(13), t("extensions"), () => showShellPanel("extensions"));
extensionsBtn.classList.add("pb-tool-btn");
const extensionsCount = element("span", "pb-tool-btn-count");
extensionsCount.hidden = true;
extensionsBtn.append(extensionsCount);

async function refreshExtensionsCount(): Promise<void> {
	try {
		const entries = await call<{ enabled: boolean }[]>("extensions.list");
		const enabled = entries.filter((entry) => entry.enabled).length;
		extensionsCount.textContent = String(enabled);
		extensionsCount.hidden = enabled === 0;
	} catch {
		// 面板自己能报错，工具栏上的计数静默降级
		extensionsCount.hidden = true;
	}
}

const MIN_SPLIT_RATIO = 0.2;
const MAX_SPLIT_RATIO = 0.8;
const SNAP_THRESHOLD_PX = 60;

const controls = element("div", "pb-window-controls");

const minBtn = element("button", "pb-win-btn pb-win-min");
minBtn.type = "button";
minBtn.title = t("minimize") || "最小化";
minBtn.setAttribute("aria-label", t("minimize") || "最小化");
// 10 单位画布按 13px 显示（见 .pb-chrome-row 的 --pb-ctl-icon），描边按比例调到 ~1.1px
minBtn.append(createSvg(13, 13, "0 0 10 10", [svgPath("M1 5.5h8", "0.85")]));
minBtn.addEventListener("click", () => window.piDesktop?.window.minimize());

const maxBtn = element("button", "pb-win-btn pb-win-max");
maxBtn.type = "button";
function updateMaxBtn(maximized: boolean): void {
	maxBtn.replaceChildren(
		maximized
			? createSvg(13, 13, "0 0 10 10", [
					svgPath("M3 3V1.5C3 1.22 3.22 1 3.5 1H9.5C9.78 1 10 1.22 10 1.5V7.5C10 7.78 9.78 8 9.5 8H8", "0.85", "butt"),
					svgRect(1, 3, 7, 7, 0.5, "0.85"),
				])
			: createSvg(13, 13, "0 0 10 10", [svgRect(1, 1, 8, 8, 0.5, "0.85")]),
	);
	const tip = maximized ? t("restore") || "向下还原" : t("maximize") || "最大化";
	maxBtn.title = tip;
	maxBtn.setAttribute("aria-label", tip);
}
updateMaxBtn(false);
void window.piDesktop?.window
	.isMaximized()
	.then(updateMaxBtn)
	.catch(() => {});
window.piDesktop?.window.onMaximizedChange?.(updateMaxBtn);
maxBtn.addEventListener("click", () => window.piDesktop?.window.toggleMaximize());

const closeBtn = element("button", "pb-win-btn pb-win-close");
closeBtn.type = "button";
closeBtn.title = t("closeWindow") || "关闭";
closeBtn.setAttribute("aria-label", t("closeWindow") || "关闭");
closeBtn.append(createSvg(13, 13, "0 0 10 10", [svgPath("M1.5 1.5l7 7M8.5 1.5l-7 7", "0.85", "round")]));
closeBtn.addEventListener("click", () => window.piDesktop?.window.close());

if (window.piDesktop?.platform === "darwin") {
	controls.style.display = "none";
}

controls.append(minBtn, maxBtn, closeBtn);

// 扩展动作：Electron 不渲染 chrome.action 的图标/badge，electron-chrome-extensions 的
// <browser-action-list> 把它们变成工具栏上真实的按钮（点击就是 Chrome 的 popup / onClicked）。
// 必须用 JS 建：库在 preload 里定义自定义元素，HTML 里的静态标签会在升级前就被解析。
const actionList = document.createElement("browser-action-list");
actionList.className = "pb-action-list";
actionList.setAttribute("partition", BROWSER_EXTENSION_PARTITION);
actionList.setAttribute("alignment", "bottom left");

const items = element("div", "pb-tool-items");
items.append(actionList);

titlebar.append(tabs, create, dragArea, modeBtn, searchBtn, items, extensionsBtn, controls);

// 中间可拖拽分栏线 (Direct Draggable Split Divider)
const divider = element("div", "pb-split-divider");
const dividerLine = element("div", "pb-split-divider-line");
const dividerBadge = element("div", "pb-split-divider-badge");
divider.append(dividerLine, dividerBadge);
app.append(divider);

let isDraggingDivider = false;
let ratioFrame = 0;

divider.addEventListener("pointerdown", (event) => {
	if (event.button !== 0) return;
	event.preventDefault();
	isDraggingDivider = true;
	divider.setPointerCapture(event.pointerId);
	divider.classList.add("pb-dragging");
	document.body.classList.add("pb-is-resizing");
});

divider.addEventListener("pointermove", (event) => {
	if (!isDraggingDivider) return;
	const width = window.innerWidth;
	if (width <= 0) return;
	const x = event.clientX;
	const r = x / width;

	if (r > 0.92 || x > width - SNAP_THRESHOLD_PX) {
		divider.classList.add("pb-snap-agent");
		divider.classList.remove("pb-snap-browser");
		dividerBadge.textContent = "释放隐藏浏览器";
		const left = Math.floor(width * MAX_SPLIT_RATIO);
		chrome.style.left = `${left}px`;
		chrome.style.width = `${Math.max(0, width - left)}px`;
		divider.style.left = `${left - 3}px`;
	} else if (r < 0.08 || x < SNAP_THRESHOLD_PX) {
		divider.classList.add("pb-snap-browser");
		divider.classList.remove("pb-snap-agent");
		dividerBadge.textContent = "释放隐藏智能体";
		const left = Math.floor(width * MIN_SPLIT_RATIO);
		chrome.style.left = `${left}px`;
		chrome.style.width = `${Math.max(0, width - left)}px`;
		divider.style.left = `${left - 3}px`;
	} else {
		divider.classList.remove("pb-snap-agent", "pb-snap-browser");
		const clamped = Math.max(MIN_SPLIT_RATIO, Math.min(MAX_SPLIT_RATIO, r));
		const left = Math.floor(width * clamped);
		const right = Math.max(0, width - left);
		chrome.style.left = `${left}px`;
		chrome.style.width = `${right}px`;
		divider.style.left = `${left - 3}px`;
		dividerBadge.textContent = `${Math.round(clamped * 100)}% | ${Math.round((1 - clamped) * 100)}%`;
		cancelAnimationFrame(ratioFrame);
		ratioFrame = requestAnimationFrame(() => {
			void call("splitRatio", { ratio: clamped }).catch(reportError);
		});
	}
});

function finishDividerDrag(event: PointerEvent): void {
	if (!isDraggingDivider) return;
	isDraggingDivider = false;
	divider.classList.remove("pb-dragging", "pb-snap-agent", "pb-snap-browser");
	document.body.classList.remove("pb-is-resizing");
	try {
		divider.releasePointerCapture(event.pointerId);
	} catch {}

	const width = window.innerWidth;
	if (width <= 0) return;
	const x = event.clientX;
	const r = x / width;

	if (r > 0.92 || x > width - SNAP_THRESHOLD_PX) {
		void call("mode", { mode: "agent" }).catch(reportError);
	} else if (r < 0.08 || x < SNAP_THRESHOLD_PX) {
		void call("mode", { mode: "browser" }).catch(reportError);
	} else {
		const clamped = Math.max(MIN_SPLIT_RATIO, Math.min(MAX_SPLIT_RATIO, r));
		void call("splitRatio", { ratio: clamped }).catch(reportError);
	}
}

divider.addEventListener("pointerup", finishDividerDrag);
divider.addEventListener("pointercancel", finishDividerDrag);

const progressBarWrap = element("div", "pb-progress-bar-wrap");
const progressBar = element("div", "pb-progress-bar");
progressBarWrap.append(progressBar);

chrome.append(titlebar, progressBarWrap);
app.append(chrome);

// 极简搜索浮层 (参照 E:\ai-browser\src\search.html)
const searchOverlay = element("div", "pb-search-overlay");
const searchCard = element("div", "pb-search-card");
const searchForm = element("form", "pb-search-form");
const searchIconEl = element("span", "pb-search-icon");
searchIconEl.append(searchIcon(16));
const searchInput = input("", "text");
searchInput.classList.add("pb-search-input");
searchInput.placeholder = t("addressHint") || "输入网址或搜索关键词…";
searchInput.autocomplete = "off";
searchInput.spellcheck = false;
const searchSubmit = iconButton(arrowTopRightIcon(12), t("search"), () => {});
searchSubmit.type = "submit";
searchSubmit.classList.add("pb-search-submit");
const searchEsc = element("span", "pb-search-esc", "ESC");
searchForm.append(searchIconEl, searchInput, searchSubmit, searchEsc);

const searchActions = element("div", "pb-search-actions");
const aiAction = button(
	[agentModeIcon(13), element("span", "", t("agent") || "AI 智能体")],
	async () => {
		await hideSearch();
		await call("mode", { mode: "split" });
	},
	"pb-action-chip",
);
const newTabAction = button(
	[plusIcon(11), element("span", "", t("newTab") || "新建标签")],
	async () => {
		await hideSearch();
		await browserAction("tabs.create");
	},
	"pb-action-chip",
);
searchActions.append(aiAction, newTabAction);

searchCard.append(searchForm, searchActions);
searchOverlay.append(searchCard);
document.body.append(searchOverlay);

async function openSearch(): Promise<void> {
	if (searchOpen) return;
	await closeShellPanel();
	searchOpen = true;
	await call("overlay", { open: true });
	searchOverlay.classList.add("pb-open");
	const currentTab = state?.tabs.find((tab) => tab.id === state?.activeTabId);
	searchInput.value = !currentTab || currentTab.internal ? "" : currentTab.url;
	setTimeout(() => {
		searchInput.focus();
		searchInput.select();
	}, 60);
}

async function hideSearch(): Promise<void> {
	if (!searchOpen) return;
	searchOpen = false;
	searchOverlay.classList.remove("pb-open");
	await call("overlay", { open: false });
}

searchForm.addEventListener("submit", (event) => {
	event.preventDefault();
	const val = searchInput.value.trim();
	if (!val) {
		void hideSearch();
		return;
	}
	void (async () => {
		await hideSearch();
		const url = addressUrl(val, settings.searchEngine);
		await browserAction("navigate", { url });
	})().catch(reportError);
});

searchEsc.addEventListener("click", () => void hideSearch());
searchOverlay.addEventListener("click", (event) => {
	if (event.target === searchOverlay) void hideSearch();
});
searchInput.addEventListener("keydown", (event) => {
	if (event.key === "Escape") {
		event.preventDefault();
		void hideSearch();
	}
});

function updateProgress(next: BrowserState): void {
	const tab = next.tabs.find((tab) => tab.id === next.activeTabId);
	if (tab?.loading) {
		progressBar.style.width = "75%";
		progressBar.style.opacity = "1";
	} else {
		progressBar.style.width = "100%";
		setTimeout(() => {
			const current = state?.tabs.find((t) => t.id === state?.activeTabId);
			if (!current?.loading) {
				progressBar.style.opacity = "0";
				setTimeout(() => {
					progressBar.style.width = "0%";
				}, 250);
			}
		}, 180);
	}
}

function render(next: BrowserState): void {
	const previous = state;
	state = next;
	tabs.replaceChildren();
	for (const tab of next.tabs) {
		const row = element("div", `pb-tab${tab.id === next.activeTabId ? " pb-active" : ""}`);
		const activate = button("", () => browserAction("tabs.activate", { id: tab.id }), "pb-tab-activate");
		activate.setAttribute("role", "tab");
		activate.setAttribute("aria-selected", String(tab.id === next.activeTabId));
		activate.title = tab.url;
		const mark = element("span", tab.loading ? "pb-tab-mark pb-spinning" : "pb-tab-mark");
		if (tab.loading) {
			mark.append(spinnerIcon(12));
		} else if (tab.internal) {
			mark.textContent = "π";
		} else {
			mark.append(globeIcon(12));
		}
		activate.append(mark, element("span", "pb-tab-title", tab.title || t("newTab")));
		const close = iconButton(closeIcon(8), `${t("closeTab")}: ${tab.title || t("newTab")}`, () =>
			call("tabs.close", { id: tab.id }),
		);
		close.classList.add("pb-tab-close");
		row.addEventListener("auxclick", (event) => {
			if (event.button === 1) {
				event.preventDefault();
				void call("tabs.close", { id: tab.id }).catch(reportError);
			}
		});
		row.append(activate, close);
		tabs.append(row);
	}
	if (previous?.activeTabId !== next.activeTabId || previous?.tabs.length !== next.tabs.length)
		tabs.querySelector(".pb-active")?.scrollIntoView({ block: "nearest", inline: "nearest" });

	const modeConfig: Record<BrowserMode, { icon: () => SVGSVGElement; title: string }> = {
		browser: { icon: () => browserModeIcon(15), title: "当前：浏览器模式 (点击切换为分栏协作)" },
		split: { icon: () => splitModeIcon(15), title: "当前：分栏协作模式 (点击切换为智能体模式)" },
		agent: { icon: () => agentModeIcon(15), title: "当前：智能体模式 (点击切换为浏览器模式)" },
	};
	const cfg = modeConfig[next.mode] || modeConfig.browser;
	modeBtn.replaceChildren(cfg.icon());
	modeBtn.title = `${cfg.title} (Ctrl+Alt+M)`;

	updateProgress(next);
	updateChromePosition(next);
}

function updateChromePosition(next: BrowserState): void {
	const split = Number.isFinite(next.splitRatio)
		? Math.max(MIN_SPLIT_RATIO, Math.min(MAX_SPLIT_RATIO, next.splitRatio))
		: 0.5;
	const left = next.mode === "split" ? Math.floor(window.innerWidth * split) : 0;
	if (next.mode === "split") {
		const right = Math.max(0, window.innerWidth - left);
		chrome.style.display = "";
		chrome.style.left = `${left}px`;
		chrome.style.width = `${right}px`;
		chrome.style.borderLeft = "";

		divider.style.display = "flex";
		divider.style.left = `${left - 3}px`;
	} else {
		chrome.style.display = next.mode === "browser" ? "" : "none";
		chrome.style.left = "0px";
		chrome.style.width = "100%";
		chrome.style.borderLeft = "";
		divider.style.display = "none";
	}
	renderBoot(next, left);
}

window.addEventListener("resize", () => {
	if (state) updateChromePosition(state);
});

listenState(render);

void bridgeReady()
	.then((bridge) => {
		const dispose = bridge.onOpenOptions?.(() => {
			void showShellPanel("settings").catch(reportError);
		});
		if (dispose) window.addEventListener("pagehide", dispose, { once: true });
		const focusDispose = bridge.onFocusAddress?.(() => {
			void openSearch().catch(reportError);
		});
		if (focusDispose) window.addEventListener("pagehide", focusDispose, { once: true });
	})
	.catch(reportError);

async function loadSettings(): Promise<void> {
	settings = await call<Settings>("settings.get");
	applySettings(settings);
}

window.addEventListener("pb-settings-changed", () => {
	void loadSettings().catch(reportError);
});
window.addEventListener("pb-extensions-changed", () => void refreshExtensionsCount());
// 面板开在自己的视图里，那里的改动只能由宿主转发过来
listenPanelEvents((name) => {
	if (name === "pb-settings-changed") void loadSettings().catch(reportError);
	if (name === "pb-extensions-changed") void refreshExtensionsCount();
});
window.addEventListener("focus", () => {
	void loadSettings().catch(reportError);
});

window.addEventListener("keydown", (event) => {
	if (event.key === "Escape" && searchOpen) {
		event.preventDefault();
		void hideSearch();
		return;
	}
	if (event.altKey && (event.key === "ArrowLeft" || event.key === "Left")) {
		event.preventDefault();
		void browserAction("back").catch(reportError);
		return;
	}
	if (event.altKey && (event.key === "ArrowRight" || event.key === "Right")) {
		event.preventDefault();
		void browserAction("forward").catch(reportError);
		return;
	}
	if (event.altKey && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "m") {
		event.preventDefault();
		const nextMode: BrowserMode = state?.mode === "browser" ? "split" : state?.mode === "split" ? "agent" : "browser";
		void call("mode", { mode: nextMode }).catch(reportError);
		return;
	}
	if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
	const key = event.key.toLowerCase();
	if (key === "l" || key === "k") {
		event.preventDefault();
		if (searchOpen) void hideSearch();
		else void openSearch();
	}
	if (key === "t") {
		event.preventDefault();
		void browserAction("tabs.create").catch(reportError);
	}
	if (key === "w" && state?.activeTabId) {
		event.preventDefault();
		void call("tabs.close", { id: state.activeTabId }).catch(reportError);
	}
	if (key === "r") {
		event.preventDefault();
		void browserAction("reload").catch(reportError);
	}
	if (key === "d") {
		event.preventDefault();
		void addCurrentBookmark().catch(reportError);
	}
});

void Promise.all([call<BrowserState>("state").then(render), loadSettings(), refreshExtensionsCount()]).catch(
	reportError,
);
