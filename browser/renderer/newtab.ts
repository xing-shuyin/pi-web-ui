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
	folderIcon,
	gearIcon,
	hostName,
	input,
	listenPanelEvents,
	listenState,
	normalizeBookmarks,
	openUrl,
	plusIcon,
	reportError,
	starIcon,
	applySettings,
	type Bookmark,
	type Settings,
} from "./common.js";
import { t, tf } from "./i18n.js";
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

// 面板按钮兼作开关：再点一下收起（面板点外部也会收起，见 panels.ts 的 handleOutsidePointer）
const tools = element("nav", "pb-toolbar");
tools.append(
	button([starIcon(13), element("span", "", t("bookmarks"))], () => showPanel("bookmarks"), "pb-panel-toggle"),
	button([downloadIcon(13), element("span", "", t("downloads"))], () => showPanel("downloads"), "pb-panel-toggle"),
	button([clockIcon(13), element("span", "", t("history"))], () => showPanel("history"), "pb-panel-toggle"),
	button([gearIcon(13), element("span", "", t("settings"))], () => showPanel("settings"), "pb-panel-toggle"),
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

engineWrapper.append(engineTrigger, engineMenu);

const query = input("", "search", "输入网址或搜索关键词…");
query.setAttribute("aria-label", t("address"));
query.autocomplete = "off";

/**
 * 新标签页的唯一入口就是这根输入框：开页就把光标放进去，用户不用先点一下再打字。
 * 只动本页 DOM 的焦点，不碰主进程的键盘焦点——真正的键盘焦点另走 `call("focus")`（见文件末尾），
 * 否则在地址浮层里打字的用户会被这里抢走。
 * 另一个输入框正拿着焦点（面板 / 表单）时不动它：那时用户已经在打字了。
 */
function focusQuery(): void {
	const active = document.activeElement;
	if ((active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) && active !== query) return;
	query.focus({ preventScroll: true });
}

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

/**
 * 首页导航就是书签树本身，排成网格、像文件管理器一样一层层进：
 * 文件夹 = 可进入的目录，书签 = 可直接打开的条目；面包屑点任意一级就退回那一层。
 * 与书签面板（`panels.ts` 的 `bookmarksPanel`）读同一棵树、同一套 type 语义，不另开数据源。
 * 层级只记「文件夹名链」：刷新后重走一遍，被删 / 改名的楼层自动退到最近还能走到的一层。
 */
const nav = element("nav", "unified-nav");
nav.setAttribute("aria-label", t("bookmarks"));
const crumbs = element("div", "unified-nav-crumbs");
const grid = element("div", "unified-nav-grid");
const navEmpty = element("p", "unified-nav-empty", t("empty"));
nav.append(crumbs, grid, navEmpty);

let tree: Bookmark[] = [];
let trail: string[] = [];

/** 沿名字链走到那一层；走不到（文件夹被删 / 改名）就返回 undefined，由调用方退回上一层。 */
function folderAt(names: string[]): Bookmark[] | undefined {
	let nodes = tree;
	for (const name of names) {
		const folder = nodes.find((node) => node.type === "folder" && node.name === name);
		if (!folder) return undefined;
		nodes = folder.children ||= [];
	}
	return nodes;
}

function currentFolder(): Bookmark[] {
	return folderAt(trail) ?? tree;
}

function openFolder(name: string): void {
	trail = [...trail, name];
	renderNav();
}

function goUp(): void {
	if (!trail.length) return;
	trail = trail.slice(0, -1);
	renderNav();
}

/** 一格导航条目：图标 + 名称 + 一行小字（文件夹是条数，书签是域名）。 */
function tile(
	symbol: string | Node,
	name: string,
	detail: string,
	onOpen: () => void | Promise<unknown>,
	extra = "",
): HTMLButtonElement {
	const node = button("", onOpen, `unified-tile ${extra}`.trim());
	const icon = element("span", "unified-tile-icon");
	if (typeof symbol === "string") icon.textContent = symbol;
	else icon.append(symbol);
	icon.setAttribute("aria-hidden", "true");
	node.append(icon, element("span", "unified-tile-name", name));
	if (detail) node.append(element("span", "unified-tile-detail", detail));
	node.title = detail ? `${name}\n${detail}` : name;
	return node;
}

const addTile = tile(plusIcon(14), t("add"), "", () => showPanel("bookmarks"), "unified-tile-add pb-panel-toggle");
addTile.title = t("bookmarkHelp");

function folderTile(folder: Bookmark): HTMLButtonElement {
	const count = (folder.children || []).length;
	return tile(
		folderIcon(15),
		folder.name,
		tf(count === 1 ? "navItemOne" : "navItems", { count }),
		() => openFolder(folder.name),
		"unified-tile-folder",
	);
}

function linkTile(link: Bookmark): HTMLButtonElement {
	return tile(
		link.char || link.name.slice(0, 1).toUpperCase(),
		link.name,
		hostName(link.url || ""),
		() => openUrl(addressUrl(link.url || "", settings.searchEngine), openInNewTab()),
		"unified-tile-link",
	);
}

function renderNav(): void {
	const nodes = currentFolder();
	// 面包屑只在进入文件夹后出现：点根或任意一级都直接跳回那一层
	crumbs.replaceChildren();
	if (trail.length) {
		crumbs.append(
			button(
				t("root"),
				() => {
					trail = [];
					renderNav();
				},
				"unified-crumb",
			),
		);
		for (const [index, name] of trail.entries()) {
			crumbs.append(element("span", "unified-crumb-sep", "/"));
			const jump = () => {
				trail = trail.slice(0, index + 1);
				renderNav();
			};
			crumbs.append(
				index === trail.length - 1
					? element("span", "unified-crumb-current", name)
					: button(name, jump, "unified-crumb"),
			);
		}
	}
	crumbs.hidden = trail.length === 0;
	grid.replaceChildren(...nodes.map((node) => (node.type === "folder" ? folderTile(node) : linkTile(node))), addTile);
	// 空文件夹要说清为什么是空的；根目录为空时只留「添加」这一格
	navEmpty.textContent = trail.length ? t("bookmarkFolderEmpty") : t("empty");
	navEmpty.hidden = nodes.length > 0;
}

async function refreshBookmarks(): Promise<void> {
	try {
		tree = normalizeBookmarks(await call("bookmarks.list"));
		// 刷新后重走名字链：删掉 / 改名的文件夹不会再把人卡在一个不存在的楼层
		while (trail.length && folderAt(trail) === undefined) trail = trail.slice(0, -1);
		renderNav();
	} catch (err) {
		reportError(err);
	}
}

unifiedContainer.append(hero, search, nav);

const footer = element("footer", "pb-start-footer unified-footer pb-muted", "按 / 键快速搜索 · 回车直达");

main.append(top, unifiedContainer, footer);
app.append(main);

// 光标直接落在输入框里，并且请宿主把键盘焦点交过来：只做 DOM 聚焦的话，按键还是进外壳页
focusQuery();
void call("focus").catch(() => {});

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
const refreshers = [
	["pb-bookmarks-changed", refreshBookmarks],
	["pb-settings-changed", refreshSettings],
] as const;
for (const [event, refresh] of refreshers)
	window.addEventListener(event, () => {
		void refresh().catch(reportError);
	});
// 面板开在自己的视图里，那里的改动只能由宿主转发过来
listenPanelEvents((name) => {
	const found = refreshers.find(([event]) => event === name);
	if (found) void found[1]().catch(reportError);
});

window.addEventListener("focus", () => {
	focusQuery();
	void Promise.all([refreshSettings(), refreshBookmarks()]).catch(reportError);
});

// 从 bfcache 退回这个标签时也是一样的道理：光标回输入框
window.addEventListener("pageshow", focusQuery);

window.addEventListener("keydown", (event) => {
	// Esc 先收搜索引擎菜单；不在菜单里时，它和 Backspace 一样退出一层文件夹（像文件管理器）
	if (event.key === "Escape" && !engineMenu.hidden) {
		closeEngineMenu();
		return;
	}
	if (
		trail.length &&
		(event.key === "Escape" || (event.key === "Backspace" && !(event.target instanceof HTMLInputElement)))
	) {
		event.preventDefault();
		goUp();
		return;
	}
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
