import {
	addressUrl,
	button,
	call,
	checkIcon,
	chevronDownIcon,
	clockIcon,
	downloadIcon,
	element,
	enableCrxDropTarget,
	gearIcon,
	input,
	listenState,
	normalizeBookmarks,
	flattenBookmarks,
	openUrl,
	plusIcon,
	reportError,
	starIcon,
	applySettings,
	type Bookmark,
	type Settings,
} from "./common.js";
import { t } from "./i18n.js";
import { setPanelState, showPanel } from "./panels.js";

document.body.classList.add("pb-internal");
document.title = t("newTab");
enableCrxDropTarget();

let settings: Settings = {};

interface SearchEngineOption {
	id: string;
	name: string;
	icon: string;
}

const SEARCH_ENGINES: readonly SearchEngineOption[] = [
	{ id: "bing", name: "Bing", icon: "🔍" },
	{ id: "google", name: "Google", icon: "🌐" },
	{ id: "baidu", name: "百度", icon: "🐾" },
	{ id: "duckduckgo", name: "DuckDuckGo", icon: "🦆" },
] as const;

/** 设置还没加载完时按默认「当前标签」打开：否则首帧点搜索会被误判成「新标签」。 */
function openInNewTab(): boolean {
	return (settings.newTabOpenMode || "current") !== "current";
}

function getEngineConfig(id?: string): SearchEngineOption {
	const key = (id || "bing").toLowerCase();
	return SEARCH_ENGINES.find((e) => e.id === key) || SEARCH_ENGINES[0];
}

const app = document.querySelector<HTMLElement>("#app")!;
const main = element("main", "pb-start pb-unified-flow-page");

// 顶部极简导航栏（左上角不再显示品牌标识，只保留右侧工具栏）
const top = element("header", "pb-start-top");

const tools = element("nav", "pb-toolbar");
tools.append(
	button([starIcon(13), element("span", "", t("bookmarks"))], () => showPanel("bookmarks")),
	button([downloadIcon(13), element("span", "", t("downloads"))], () => showPanel("downloads")),
	button([clockIcon(13), element("span", "", t("history"))], () => showPanel("history")),
	button([gearIcon(13), element("span", "", t("settings"))], () => showPanel("settings")),
);
top.append(tools);

// 方案4 居中一体化流线容器
const unifiedContainer = element("div", "unified-container");

// 极简时钟与日期
const hero = element("section", "pb-hero unified-hero");
const clock = element("time", "pb-clock");
const date = element("div", "pb-date");
hero.append(clock, date);

// 一体化胶囊搜索条 (左侧包含搜索引擎切换)
const search = element("form", "unified-bar pb-search");
search.setAttribute("role", "search");

const engineWrapper = element("div", "unified-engine-wrapper");
const engineTrigger = element("button", "unified-engine-trigger");
engineTrigger.type = "button";
engineTrigger.setAttribute("aria-haspopup", "true");
engineTrigger.setAttribute("aria-expanded", "false");
engineTrigger.setAttribute("title", "切换搜索引擎");

const engineIcon = element("span", "unified-engine-icon", "🔍");
const engineLabel = element("span", "unified-engine-name", "Bing");
const engineArrow = element("span", "unified-engine-arrow");
engineArrow.append(chevronDownIcon(10));
engineTrigger.append(engineIcon, engineLabel, engineArrow);

const engineMenu = element("div", "unified-engine-menu");
engineMenu.hidden = true;

function renderEngineMenu(): void {
	engineMenu.replaceChildren();
	const currentEngineId = (settings.searchEngine || "bing").toLowerCase();
	for (const item of SEARCH_ENGINES) {
		const opt = element("button", "unified-engine-item");
		opt.type = "button";
		if (item.id === currentEngineId) {
			opt.classList.add("active");
		}
		const optIcon = element("span", "engine-opt-icon", item.icon);
		const optName = element("span", "engine-opt-name", item.name);
		opt.append(optIcon, optName);
		if (item.id === currentEngineId) {
			const checkEl = element("span", "engine-opt-check");
			checkEl.append(checkIcon(12));
			opt.append(checkEl);
		}
		opt.addEventListener("click", (e) => {
			e.stopPropagation();
			void selectSearchEngine(item.id);
		});
		engineMenu.append(opt);
	}
}

async function selectSearchEngine(engineId: string): Promise<void> {
	settings.searchEngine = engineId;
	updateEngineDisplay();
	closeEngineMenu();
	query.focus();
	try {
		await call("settings.save", { settings: { searchEngine: engineId } });
	} catch (err) {
		reportError(err);
	}
}

function updateEngineDisplay(): void {
	const current = getEngineConfig(settings.searchEngine);
	engineIcon.textContent = current.icon;
	engineLabel.textContent = current.name;
	renderEngineMenu();
}

function toggleEngineMenu(): void {
	if (engineMenu.hidden) {
		renderEngineMenu();
		engineMenu.hidden = false;
		engineTrigger.setAttribute("aria-expanded", "true");
	} else {
		closeEngineMenu();
	}
}

function closeEngineMenu(): void {
	engineMenu.hidden = true;
	engineTrigger.setAttribute("aria-expanded", "false");
}

engineTrigger.addEventListener("click", (e) => {
	e.stopPropagation();
	toggleEngineMenu();
});

window.addEventListener("click", (e) => {
	if (!engineMenu.hidden && !engineTrigger.contains(e.target as Node) && !engineMenu.contains(e.target as Node)) {
		closeEngineMenu();
	}
});

window.addEventListener("keydown", (e) => {
	if (e.key === "Escape" && !engineMenu.hidden) {
		closeEngineMenu();
	}
});

engineWrapper.append(engineTrigger, engineMenu);

const query = input("", "search", "输入网址或搜索关键词…");
query.setAttribute("aria-label", t("address"));
query.autocomplete = "off";

const submit = button("", () => {}, "unified-submit");
submit.type = "submit";
submit.setAttribute("aria-label", t("search"));
submit.setAttribute("title", t("search"));
submit.innerHTML = `
<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="11" cy="11" r="8"></circle>
  <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
</svg>
`;

search.append(engineWrapper, query, submit);

search.addEventListener("submit", (event) => {
	event.preventDefault();
	const val = query.value.trim();
	if (!val) return;
	void openUrl(addressUrl(val, settings.searchEngine), openInNewTab()).catch(reportError);
});

// 单行紧凑流线胶囊
const flowRow = element("div", "unified-flow-row");

function linkPill(bookmark: Bookmark): HTMLElement {
	const pill = button(
		"",
		() => openUrl(addressUrl(bookmark.url || "", settings.searchEngine), openInNewTab()),
		"flow-pill",
	);
	pill.title = bookmark.url || bookmark.name;
	pill.append(
		element("span", "flow-pill-icon", bookmark.char || bookmark.name.slice(0, 1).toUpperCase()),
		element("span", "flow-pill-name", bookmark.name),
	);
	return pill;
}

const addPill = button(
	[plusIcon(11), element("span", "", "添加")],
	() => showPanel("bookmarks"),
	"flow-pill flow-pill-add",
);
addPill.title = "管理或添加收藏书签";

async function refreshBookmarks(): Promise<void> {
	try {
		// 只展示真实收藏夹；为空时整行隐藏，不再回退到写死的示例图标
		const bookmarks = flattenBookmarks(normalizeBookmarks(await call("bookmarks.list"))).slice(0, 8);
		flowRow.replaceChildren(...bookmarks.map(linkPill), addPill);
		flowRow.hidden = bookmarks.length === 0;
	} catch (err) {
		reportError(err);
	}
}

unifiedContainer.append(hero, search, flowRow);

const footer = element("footer", "pb-start-footer unified-footer pb-muted", "按 / 键快速搜索 · 回车直达");

main.append(top, unifiedContainer, footer);
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

async function refreshSettings(): Promise<void> {
	settings = await call<Settings>("settings.get");
	applySettings(settings);
	updateEngineDisplay();
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
	void Promise.all([refreshSettings(), refreshBookmarks()]).catch(reportError);
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
]).catch(reportError);
