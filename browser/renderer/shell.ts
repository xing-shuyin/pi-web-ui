import {
	addressUrl,
	brand,
	bridgeReady,
	button,
	call,
	element,
	iconButton,
	input,
	listenState,
	reportError,
	applySettings,
	type Settings,
} from "./common.js";
import { t } from "./i18n.js";
import { addCurrentBookmark, closePanel, panelIsOpen, setPanelState, showPanel } from "./panels.js";
import type { BrowserMode, BrowserState } from "../contracts.js";

document.body.classList.add("pb-shell");
let state: BrowserState | undefined;
let settings: Settings = {};
let draggingRatio = false;
async function browserAction(
	action: "navigate" | "back" | "forward" | "reload" | "tabs.activate" | "tabs.create",
	args?: Record<string, unknown>,
): Promise<void> {
	await closePanel();
	if (state?.mode === "agent") await call("mode", { mode: "browser" });
	await call(action, args);
}
const app = document.querySelector<HTMLElement>("#app")!;
const chrome = element("header", "pb-chrome");
const firstRow = element("div", "pb-chrome-row pb-tab-row");
const logo = brand();
logo.title = "pi Browser";
const tabs = element("div", "pb-tabs");
tabs.setAttribute("role", "tablist");
tabs.setAttribute("aria-label", t("browser"));
const create = iconButton("+", t("newTab"), () => browserAction("tabs.create"));
const dragArea = element("div", "pb-drag-area");
const modes = element("div", "pb-modes");
modes.setAttribute("aria-label", t("browser"));
const modeButtons = new Map<BrowserMode, HTMLButtonElement>();
for (const mode of ["browser", "agent", "split"] as const) {
	const node = button(t(mode), async () => {
		await closePanel();
		await call("mode", { mode });
	});
	node.setAttribute("aria-pressed", "false");
	modes.append(node);
	modeButtons.set(mode, node);
}
const controls = element("div", "pb-window-controls");
controls.append(
	iconButton("−", t("minimize"), () => window.piDesktop?.window.minimize()),
	iconButton("□", t("maximize"), () => window.piDesktop?.window.toggleMaximize()),
	iconButton("×", t("closeWindow"), () => window.piDesktop?.window.close()),
);
firstRow.append(logo, tabs, create, dragArea, modes, controls);
const nav = element("div", "pb-chrome-row pb-nav-row");
const back = iconButton("‹", t("back"), () => browserAction("back"));
const forward = iconButton("›", t("forward"), () => browserAction("forward"));
const reload = iconButton("↻", t("reload"), () => browserAction("reload"));
const home = iconButton("⌂", t("home"), () => browserAction("navigate", { url: "newtab" }));
const addressForm = element("form", "pb-address");
const status = element("span", "pb-site-status", "⌕");
status.setAttribute("aria-hidden", "true");
const address = input("", "text", t("address"));
address.setAttribute("aria-label", t("address"));
address.title = t("addressHint");
address.autocomplete = "off";
address.spellcheck = false;
const bookmark = iconButton("☆", t("addBookmark"), addCurrentBookmark);
addressForm.append(status, address, bookmark);
addressForm.addEventListener("submit", (event) => {
	event.preventDefault();
	void (async () => {
		const url = addressUrl(address.value, settings.searchEngine);
		await browserAction("navigate", { url });
		address.blur();
	})().catch(reportError);
});
address.addEventListener("focus", () => address.select());
address.addEventListener("keydown", (event) => {
	if (event.key === "Escape") {
		address.blur();
		if (state) updateAddress(state);
	}
});
const splitControl = element("label", "pb-split-control");
const ratio = input("50", "range");
ratio.min = "20";
ratio.max = "80";
ratio.step = "1";
ratio.setAttribute("aria-label", t("ratio"));
ratio.title = t("ratio");
const ratioValue = element("span", "", "50%");
splitControl.append(ratio, ratioValue);
let ratioFrame = 0;
ratio.addEventListener("pointerdown", () => {
	draggingRatio = true;
});
ratio.addEventListener("input", () => {
	ratioValue.textContent = `${ratio.value}%`;
	cancelAnimationFrame(ratioFrame);
	ratioFrame = requestAnimationFrame(() => {
		void call("splitRatio", { ratio: Number(ratio.value) / 100 }).catch(reportError);
	});
});
ratio.addEventListener("change", () => {
	draggingRatio = false;
	void call("splitRatio", { ratio: Number(ratio.value) / 100 }).catch(reportError);
});
ratio.addEventListener("pointercancel", () => {
	draggingRatio = false;
});
const agentStatus = iconButton("●", t("disconnected"), () => showPanel("settings"));
agentStatus.classList.add("pb-agent-status");
nav.append(
	back,
	forward,
	reload,
	home,
	addressForm,
	splitControl,
	agentStatus,
	iconButton("▰", t("bookmarks"), () => showPanel("bookmarks")),
	iconButton("◷", t("history"), () => showPanel("history")),
	iconButton("↓", t("downloads"), () => showPanel("downloads")),
	iconButton("⚙", t("settings"), () => showPanel("settings")),
);
chrome.append(firstRow, nav);
app.append(chrome);
function updateAddress(next: BrowserState): void {
	const tab = next.tabs.find((tab) => tab.id === next.activeTabId);
	if (document.activeElement !== address) address.value = !tab || tab.internal ? "" : tab.url;
	back.disabled = !tab?.canGoBack;
	forward.disabled = !tab?.canGoForward;
	status.textContent = tab?.loading ? "◌" : tab?.url.startsWith("https:") ? "◇" : "⌕";
	status.classList.toggle("pb-spinning", !!tab?.loading);
}
function render(next: BrowserState): void {
	const previous = state;
	state = next;
	setPanelState(next);
	tabs.replaceChildren();
	for (const tab of next.tabs) {
		const row = element("div", `pb-tab${tab.id === next.activeTabId ? " pb-active" : ""}`);
		const activate = button("", () => browserAction("tabs.activate", { id: tab.id }), "pb-tab-activate");
		activate.setAttribute("role", "tab");
		activate.setAttribute("aria-selected", String(tab.id === next.activeTabId));
		activate.title = tab.url;
		activate.append(
			element(
				"span",
				tab.loading ? "pb-tab-mark pb-spinning" : "pb-tab-mark",
				tab.loading ? "◌" : tab.internal ? "π" : "◇",
			),
			element("span", "pb-tab-title", tab.title || t("newTab")),
		);
		const close = iconButton("×", `${t("closeTab")}: ${tab.title || t("newTab")}`, () =>
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
	for (const [mode, node] of modeButtons) {
		node.classList.toggle("pb-active", mode === next.mode);
		node.setAttribute("aria-pressed", String(mode === next.mode));
	}
	splitControl.hidden = next.mode !== "split";
	if (!draggingRatio) {
		ratio.value = String(Math.round(next.splitRatio * 100));
		ratioValue.textContent = `${ratio.value}%`;
	}
	agentStatus.classList.toggle("pb-ready", next.agentReady);
	agentStatus.classList.toggle("pb-error", !!next.agentError);
	const agentLabel = next.agentError || t(next.agentReady ? "connected" : "disconnected");
	agentStatus.title = agentLabel;
	agentStatus.setAttribute("aria-label", agentLabel);
	updateAddress(next);
}
listenState(render);
void bridgeReady()
	.then((bridge) => {
		const dispose = bridge.onOpenOptions?.(() => {
			void showPanel("settings").catch(reportError);
		});
		if (dispose) window.addEventListener("pagehide", dispose, { once: true });
		const focusDispose = bridge.onFocusAddress?.(() => {
			void closePanel()
				.then(() => {
					address.focus();
					address.select();
				})
				.catch(reportError);
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
window.addEventListener("focus", () => {
	void loadSettings().catch(reportError);
});
window.addEventListener("keydown", (event) => {
	if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
	const key = event.key.toLowerCase();
	if (key === "l") {
		event.preventDefault();
		if (panelIsOpen())
			void closePanel()
				.then(() => {
					address.focus();
					address.select();
				})
				.catch(reportError);
		else {
			address.focus();
			address.select();
		}
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
	if (key === "b") {
		event.preventDefault();
		void showPanel("bookmarks").catch(reportError);
	}
	if (key === "h") {
		event.preventDefault();
		void showPanel("history").catch(reportError);
	}
	if (key === ",") {
		event.preventDefault();
		void showPanel("settings").catch(reportError);
	}
	if (key === "d") {
		event.preventDefault();
		void addCurrentBookmark().catch(reportError);
	}
});
void Promise.all([call<BrowserState>("state").then(render), loadSettings()]).catch(reportError);
