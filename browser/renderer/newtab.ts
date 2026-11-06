import {
	addressUrl,
	brand,
	button,
	call,
	element,
	empty,
	hostName,
	input,
	listenState,
	normalizeBookmarks,
	flattenBookmarks,
	openUrl,
	reportError,
	applySettings,
	type Bookmark,
	type HistoryEntry,
	type Settings,
} from "./common.js";
import { t } from "./i18n.js";
import { setPanelState, showPanel } from "./panels.js";

document.body.classList.add("pb-internal");
document.title = t("newTab");
let settings: Settings = {};
const app = document.querySelector<HTMLElement>("#app")!;
const main = element("main", "pb-start");
const top = element("header", "pb-start-top");
const identity = element("div", "pb-identity");
identity.append(brand(), element("span", "", "pi Browser"));
const tools = element("nav", "pb-toolbar");
tools.append(
	button(t("bookmarks"), () => showPanel("bookmarks")),
	button(t("history"), () => showPanel("history")),
	button(t("settings"), () => showPanel("settings")),
);
top.append(identity, tools);
const hero = element("section", "pb-hero");
const clock = element("time", "pb-clock");
const date = element("div", "pb-date");
const heading = element("h1", "", t("welcome"));
hero.append(clock, date, heading, element("p", "pb-muted", t("welcomeDetail")));
const search = element("form", "pb-search");
search.setAttribute("role", "search");
const query = input("", "search", t("address"));
query.setAttribute("aria-label", t("address"));
query.autocomplete = "off";
const engine = element("span", "pb-engine", "Bing");
const submit = button("↗", () => {}, "pb-search-submit");
submit.type = "submit";
submit.setAttribute("aria-label", t("search"));
search.append(engine, query, submit);
search.addEventListener("submit", (event) => {
	event.preventDefault();
	void openUrl(addressUrl(query.value, settings.searchEngine), settings.newTabOpenMode !== "current").catch(
		reportError,
	);
});
hero.append(search);
const entryPoints = element("div", "pb-entry-points");
function feature(icon: string, title: string, detail: string, action: () => Promise<unknown>): HTMLElement {
	const node = button("", action, "pb-feature");
	node.append(
		element("span", "pb-feature-symbol", icon),
		element("strong", "", title),
		element("span", "pb-muted", detail),
	);
	return node;
}
entryPoints.append(
	feature("▤", t("office"), t("fileHelp"), () => openUrl("office")),
	feature("▧", t("workspace"), t("workspaceHelp"), () => openUrl("workspace")),
	feature("✳", t("agent"), t("agentHelp"), () => call("mode", { mode: "split" })),
);
const quick = element("section", "pb-start-section");
const quickHeader = element("div", "pb-section-heading");
quickHeader.append(
	element("h2", "", t("quickAccess")),
	button(t("browseBookmarks"), () => showPanel("bookmarks")),
);
const links = element("div", "pb-quick-links");
quick.append(quickHeader, links);
const recent = element("section", "pb-start-section");
const recentHeading = element("div", "pb-section-heading");
recentHeading.append(
	element("h2", "", t("recent")),
	button(t("all"), () => showPanel("history")),
);
const historyList = element("div", "pb-recent-links");
recent.append(recentHeading, historyList);
main.append(top, hero, entryPoints, quick, recent, element("footer", "pb-start-footer pb-muted", t("shortcuts")));
app.append(main);
function updateTime(): void {
	const now = new Date();
	clock.dateTime = now.toISOString();
	clock.textContent = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
	date.textContent = now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
}
updateTime();
const timer = setInterval(updateTime, 30000);
window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
function linkTile(bookmark: Bookmark): HTMLElement {
	const node = button(
		"",
		() => openUrl(addressUrl(bookmark.url || "", settings.searchEngine), settings.newTabOpenMode !== "current"),
		"pb-quick-link",
	);
	node.title = bookmark.url || bookmark.name;
	node.append(
		element("span", "pb-link-monogram", bookmark.char || bookmark.name.slice(0, 1).toUpperCase()),
		element("span", "", bookmark.name),
	);
	return node;
}
async function refreshBookmarks(): Promise<void> {
	const bookmarks = flattenBookmarks(normalizeBookmarks(await call("bookmarks.list"))).slice(0, 10);
	const defaults: Bookmark[] = [
		{ name: "Bing", type: "link", url: "https://www.bing.com" },
		{ name: "GitHub", type: "link", url: "https://github.com" },
		{ name: "Wikipedia", type: "link", url: "https://www.wikipedia.org" },
		{ name: "MDN", type: "link", url: "https://developer.mozilla.org" },
	];
	links.replaceChildren(...(bookmarks.length ? bookmarks : defaults).map(linkTile));
}
async function refreshHistory(): Promise<void> {
	const history = await call<HistoryEntry[]>("history.list");
	const seen = new Set<string>();
	const recent = history
		.filter((entry) => {
			if (seen.has(entry.url)) return false;
			seen.add(entry.url);
			return true;
		})
		.slice(0, 6);
	historyList.replaceChildren();
	for (const entry of recent) {
		const node = button(
			"",
			() => openUrl(addressUrl(entry.url), settings.newTabOpenMode !== "current"),
			"pb-recent-link",
		);
		node.title = entry.url;
		node.append(element("span", "pb-muted", hostName(entry.url)), element("strong", "", entry.title || entry.url));
		historyList.append(node);
	}
	if (!recent.length) historyList.append(empty(t("noHistory")));
}
async function refreshSettings(): Promise<void> {
	settings = await call<Settings>("settings.get");
	applySettings(settings);
	engine.textContent =
		({ bing: "Bing", google: "Google", baidu: "Baidu", duckduckgo: "DuckDuckGo" } as Record<string, string>)[
			settings.searchEngine || "bing"
		] || "Bing";
}
listenState(setPanelState);
for (const [event, refresh] of [
	["pb-bookmarks-changed", refreshBookmarks],
	["pb-settings-changed", refreshSettings],
] as const)
	window.addEventListener(event, () => {
		void refresh().catch(reportError);
	});
window.addEventListener("focus", () => {
	void Promise.all([refreshSettings(), refreshBookmarks(), refreshHistory()]).catch(reportError);
});
window.addEventListener("keydown", (event) => {
	if (event.key === "/" && !(event.target instanceof HTMLInputElement)) {
		event.preventDefault();
		query.focus();
	}
});
void Promise.all([
	call("state").then((state) => setPanelState(state as Parameters<typeof setPanelState>[0])),
	refreshSettings(),
	refreshBookmarks(),
	refreshHistory(),
]).catch(reportError);
