import {
	call,
	element,
	button,
	iconButton,
	closeIcon,
	editIcon,
	folderIcon,
	input,
	label,
	empty,
	moreIcon,
	normalizeBookmarks,
	flattenBookmarks,
	webUrl,
	hostName,
	dateTime,
	notify,
	reportError,
	openUrl,
	type Bookmark,
	type HistoryEntry,
	type Settings,
} from "./common.js";
import { t, type MessageKey } from "./i18n.js";
import { vaultPanel, type VaultTab } from "./vault.js";
import type { BrowserPanel, BrowserPanelEvent, BrowserState } from "../contracts.js";
export type Panel = BrowserPanel;
let dialog: HTMLDialogElement | undefined;
let overlayOwned = false;
let release: Promise<unknown> = Promise.resolve();
let activePanel: Panel | undefined;
let currentState: BrowserState | undefined;
let revision = 0;
/**
 * 浮层视图模式（`panel.html`）：本页只装一块面板，由宿主摆成盖在页面之上的一块矩形，
 * 页面在它周围照常可见。所以这里既不铺遮罩、也不隐藏内容区，只把面板自己要的尺寸报给宿主。
 */
let layered = false;
let layerSize: { width: number; height: number } | undefined;
let layerObserver: ResizeObserver | undefined;
export function setPanelState(state: BrowserState): void {
	currentState = state;
}
export function panelIsOpen(): boolean {
	return !!dialog?.open;
}
/** 切到浮层视图模式（`panel.ts` 启动时调一次，早于任何 `showPanel`）。 */
export function usePanelLayer(): void {
	layered = true;
}
export async function closePanel(): Promise<void> {
	revision++;
	activePanel = undefined;
	document.removeEventListener("pointerdown", handleOutsidePointer, true);
	document.removeEventListener("keydown", handlePanelEscape, true);
	layerObserver?.disconnect();
	layerObserver = undefined;
	layerSize = undefined;
	const closing = dialog;
	dialog = undefined;
	closing?.close();
	closing?.remove();
	// 浮层视图由宿主销毁：视图没了，页面自然完整露出来。回复可能到不了已销毁的渲染进程，不 await
	if (layered) {
		void call("panel", { open: false }).catch(() => undefined);
		return;
	}
	if (overlayOwned) {
		overlayOwned = false;
		release = call("overlay", { open: false });
		await release;
	}
}
/** 面板是浮层不是模态：点面板外任何地方都收起，工具栏照常可点（Chrome 的扩展菜单同语义）。 */
function handleOutsidePointer(event: PointerEvent): void {
	const node = dialog;
	if (!node) return;
	const target = event.target instanceof Node ? event.target : null;
	if (target && node.contains(target)) return;
	// 打开面板的工具栏按钮自己就是开关：pointerdown 先收起，紧接着的 click 又会把它打开一遍
	if (target instanceof Element && target.closest(".pb-panel-toggle")) return;
	void closePanel().catch(reportError);
}
/** 非模态 dialog 不再收到 `cancel`（Esc 只对模态生效），自己接一层。 */
function handlePanelEscape(event: KeyboardEvent): void {
	if (event.key !== "Escape" || !dialog) return;
	event.preventDefault();
	event.stopPropagation();
	void closePanel().catch(reportError);
}
let pendingPanel: Promise<void> = Promise.resolve();
export function showPanel(panel: Panel, options?: { tab?: VaultTab }): Promise<void> {
	const opening = pendingPanel.then(() => (layered ? renderLayer(panel, options) : openPanel(panel, options)));
	pendingPanel = opening.catch(() => {});
	return opening;
}
/** 外壳窗口：面板开在宿主的面板浮层里（`panel.html`），内容区不再被隐藏。 */
export function showShellPanel(panel: Panel, tab?: VaultTab): Promise<void> {
	return call("panel", { open: true, panel, tab });
}
export function closeShellPanel(): Promise<void> {
	return call("panel", { open: false }).then(() => undefined);
}
/**
 * 面板里的改动要通知别处的视图（顶栏设置、新标签页书签、扩展计数）：
 * 本页先发一次；浮层是独立视图，再让宿主转发给外壳与内部标签页。
 */
function panelEvent(name: BrowserPanelEvent): void {
	window.dispatchEvent(new Event(name));
	if (layered) void call("panel", { event: name }).catch(() => undefined);
}
/** 面板骨架：标题栏（带关闭键）+ 内容区；外壳浮层与内部页共用。
 * 标题栏还预留一个动作槽（`.pb-dialog-actions`）：面板把工具图标挂到这里，
 * 于是一行里就是「标题 — 图标工具条 — 关闭」（TOTP 面板即此形态）。 */
function createDialog(panel: Panel): { node: HTMLDialogElement; content: HTMLElement; actions: HTMLElement } {
	const compact = panel === "extensions";
	const node = element("dialog", `pb-dialog${compact ? " pb-dialog-compact" : ""}${layered ? " pb-dialog-layer" : ""}`);
	node.tabIndex = -1;
	node.setAttribute("aria-labelledby", "pb-panel-heading");
	const header = element("header", "pb-dialog-header");
	const title = element("h2", "", t(panel));
	title.id = "pb-panel-heading";
	const actions = element("div", "pb-dialog-actions");
	header.append(title, actions, iconButton(closeIcon(10), t("close"), closePanel));
	const content = element("div", "pb-dialog-content");
	content.append(empty(t("loading")));
	node.append(header, content);
	return { node, content, actions };
}
async function fillDialog(
	panel: Panel,
	content: HTMLElement,
	node: HTMLDialogElement,
	actions: HTMLElement,
	tab?: VaultTab,
): Promise<void> {
	// 动作槽跟着面板走：切面板先清空，避免上一个面板的工具图标留下来
	actions.replaceChildren();
	try {
		if (panel === "bookmarks") await bookmarksPanel(content);
		if (panel === "history") await historyPanel(content);
		if (panel === "settings") await settingsPanel(content);
		if (panel === "downloads") await downloadsPanel(content);
		if (panel === "extensions") await extensionsPanel(content);
		if (panel === "vault") await vaultPanel(content, () => panelEvent("pb-vault-changed"), actions, { tab });
	} catch (error) {
		if (!node.isConnected) return;
		content.replaceChildren(
			empty(error instanceof Error ? error.message : t("error")),
			button(t("retry"), () => showPanelAgain(panel)),
		);
	}
	reportLayerSize();
}
/**
 * 浮层尺寸由宿主管：面板量出自己多大就报一次，宿主按这块矩形摆视图。
 * 量的是当前视图里的实际盒子，所以两端很快就会收敛（视图缩小→内容改滚动→高度不再变）。
 */
function reportLayerSize(): void {
	if (!layered || !dialog) return;
	const box = dialog.getBoundingClientRect();
	const width = Math.ceil(box.width);
	const height = Math.ceil(box.height);
	if (width <= 0 || height <= 0) return;
	if (layerSize && layerSize.width === width && layerSize.height === height) return;
	layerSize = { width, height };
	void call("panel", { size: layerSize }).catch(() => undefined);
}
/** 浮层视图里画一块面板：换面板只换本页这块，不通知宿主销毁视图。 */
async function renderLayer(panel: Panel, options?: { tab?: VaultTab }): Promise<void> {
	layerObserver?.disconnect();
	layerObserver = undefined;
	dialog?.close();
	dialog?.remove();
	activePanel = panel;
	const { node, content, actions } = createDialog(panel);
	dialog = node;
	node.addEventListener("cancel", (event) => {
		event.preventDefault();
		void closePanel().catch(reportError);
	});
	document.addEventListener("keydown", handlePanelEscape, true);
	document.body.append(node);
	// 视图本身就是这块面板：不铺遮罩、不接管整窗，面板里面正常滚动
	node.show();
	node.focus({ preventScroll: true });
	layerObserver = new ResizeObserver(() => reportLayerSize());
	layerObserver.observe(node);
	await fillDialog(panel, content, node, actions, options?.tab);
}
async function openPanel(panel: Panel, options?: { tab?: VaultTab }): Promise<void> {
	if (dialog?.open && activePanel === panel) {
		await closePanel();
		return;
	}
	await closePanel();
	await release;
	const version = ++revision;
	await call("overlay", { open: true });
	if (version !== revision) {
		await call("overlay", { open: false });
		return;
	}
	overlayOwned = true;
	activePanel = panel;
	const { node, content, actions } = createDialog(panel);
	dialog = node;
	node.addEventListener("cancel", (event) => {
		event.preventDefault();
		void closePanel().catch(reportError);
	});
	document.addEventListener("pointerdown", handleOutsidePointer, true);
	document.addEventListener("keydown", handlePanelEscape, true);
	document.body.append(node);
	// show() 而不是 showModal()：不要遮罩，也不把整窗变成 inert
	node.show();
	node.focus({ preventScroll: true });
	await fillDialog(panel, content, node, actions, options?.tab);
}
async function showPanelAgain(panel: Panel): Promise<void> {
	await closePanel();
	await showPanel(panel);
}
function toolbar(...nodes: HTMLElement[]): HTMLElement {
	const row = element("div", "pb-toolbar");
	row.append(...nodes);
	return row;
}
function details(primary: string, secondary: string): HTMLElement {
	const node = element("div", "pb-item-details");
	node.append(element("strong", "", primary), element("span", "pb-muted", secondary));
	return node;
}
async function visit(url: string, newTab = false): Promise<void> {
	if (!webUrl(url)) throw new Error(t("invalidUrl"));
	// 先导航再收面板：浮层是独立视图，先销毁视图会把这次导航的 IPC 一起带走
	await openUrl(url, newTab);
	await closePanel();
}
async function bookmarksPanel(container: HTMLElement): Promise<void> {
	let bookmarks = normalizeBookmarks(await call("bookmarks.list"));
	let path: Bookmark[] = [];
	let query = "";
	const list = element("div", "pb-list");
	const editor = element("section", "pb-editor-inline");
	editor.hidden = true;
	const search = input("", "search", t("filter"));
	search.setAttribute("aria-label", t("filter"));
	const crumb = element("div", "pb-breadcrumb");
	const current = (): Bookmark[] => (path.length ? (path[path.length - 1].children ||= []) : bookmarks);
	async function persist(): Promise<void> {
		await call("bookmarks.save", { bookmarks });
		panelEvent("pb-bookmarks-changed");
	}
	function showEditor(item?: Bookmark, folder = false): void {
		editor.hidden = false;
		editor.replaceChildren();
		const name = input(item?.name || "");
		name.required = true;
		const url = input(
			item?.url || currentState?.tabs.find((tab) => tab.id === currentState?.activeTabId)?.url || "",
			"url",
		);
		const form = element("form", "pb-form");
		const isFolder = item?.type === "folder" || folder;
		form.append(label(t("name"), name));
		if (!isFolder) form.append(label(t("url"), url));
		const save = button(t("save"), () => {}, "pb-primary");
		save.type = "submit";
		form.append(
			toolbar(
				save,
				button(t("cancel"), () => {
					editor.hidden = true;
				}),
			),
		);
		form.addEventListener("submit", (event) => {
			event.preventDefault();
			void (async () => {
				if (!name.value.trim() || (!isFolder && !webUrl(url.value.trim()))) {
					notify(t("required"), true);
					return;
				}
				const previous = structuredClone(bookmarks);
				if (item) {
					item.name = name.value.trim();
					if (!isFolder) item.url = webUrl(url.value.trim())!;
				} else
					current().push({
						name: name.value.trim(),
						type: isFolder ? "folder" : "link",
						...(isFolder ? { children: [] } : { url: webUrl(url.value.trim())! }),
					});
				try {
					await persist();
					editor.hidden = true;
					render();
				} catch (error) {
					bookmarks = previous;
					path = [];
					render();
					throw error;
				}
			})().catch(reportError);
		});
		editor.append(form);
		name.focus();
	}
	function render(): void {
		list.replaceChildren();
		crumb.replaceChildren();
		crumb.append(
			button(t("root"), () => {
				path = [];
				query = "";
				search.value = "";
				render();
			}),
		);
		path.forEach((folder, index) =>
			crumb.append(
				element("span", "", "/"),
				button(folder.name, () => {
					path = path.slice(0, index + 1);
					render();
				}),
			),
		);
		const source = query
			? flattenBookmarks(bookmarks).filter((item) => `${item.name} ${item.url}`.toLocaleLowerCase().includes(query))
			: current();
		if (!source.length) list.append(empty(query ? t("empty") : t("bookmarkFolderEmpty")));
		for (const item of source) {
			const row = element("div", "pb-list-item");
			const opener = button(
				"",
				async () => {
					if (item.type === "folder") {
						path.push(item);
						render();
					} else await visit(item.url || "");
				},
				"pb-item-open",
			);
			const symbol = element("span", "pb-item-symbol");
			if (item.type === "folder") {
				symbol.append(folderIcon(14));
			} else {
				symbol.textContent = item.char || item.name.slice(0, 1).toUpperCase();
			}
			opener.append(
				symbol,
				details(
					item.name,
					item.type === "folder" ? `${item.children?.length || 0} · ${t("bookmarks")}` : item.url || "",
				),
			);
			row.append(
				opener,
				iconButton(editIcon(12), t("edit"), () => showEditor(item)),
				iconButton(closeIcon(8), t("delete"), async () => {
					const confirmation = element("div", "pb-confirm");
					confirmation.append(
						element("span", "", t("confirmDelete")),
						button(t("yesDelete"), async () => {
							const previous = structuredClone(bookmarks);
							const remove = (items: Bookmark[]): boolean => {
								const index = items.indexOf(item);
								if (index >= 0) {
									items.splice(index, 1);
									return true;
								}
								return items.some((node) => node.children && remove(node.children));
							};
							remove(bookmarks);
							try {
								await persist();
								render();
							} catch (error) {
								bookmarks = previous;
								path = [];
								render();
								throw error;
							}
						}),
						button(t("cancel"), render),
					);
					row.replaceChildren(confirmation);
				}),
			);
			list.append(row);
		}
	}
	search.addEventListener("input", () => {
		query = search.value.trim().toLocaleLowerCase();
		render();
	});
	container.replaceChildren(
		element("p", "pb-muted", t("bookmarkHelp")),
		toolbar(
			search,
			button(t("add"), () => showEditor()),
			button(t("newFolder"), () => showEditor(undefined, true)),
		),
		crumb,
		editor,
		list,
	);
	render();
}
async function historyPanel(container: HTMLElement): Promise<void> {
	const history = await call<HistoryEntry[]>("history.list");
	const search = input("", "search", t("filter"));
	search.setAttribute("aria-label", t("filter"));
	const list = element("div", "pb-list");
	function render(): void {
		list.replaceChildren();
		const query = search.value.toLocaleLowerCase();
		const entries = history.filter((item) => `${item.title} ${item.url}`.toLocaleLowerCase().includes(query));
		for (const entry of entries) {
			const row = button("", () => visit(entry.url), "pb-list-item pb-history-item");
			row.append(
				details(entry.title || hostName(entry.url), entry.url),
				element("time", "pb-muted", dateTime(entry.visitedAt)),
			);
			list.append(row);
		}
		if (!entries.length) list.append(empty(t("noHistory")));
	}
	search.addEventListener("input", render);
	container.replaceChildren(search, list);
	render();
}
async function settingsPanel(container: HTMLElement): Promise<void> {
	const settings = await call<Settings>("settings.get");
	const form = element("form", "pb-form");
	const engine = element("select", "pb-input");
	for (const [value, text] of [
		["bing", "Bing"],
		["google", "Google"],
		["baidu", "Baidu"],
		["duckduckgo", "DuckDuckGo"],
	]) {
		const option = element("option", "", text);
		option.value = value;
		engine.append(option);
	}
	engine.value = settings.searchEngine || "bing";
	const openMode = element("select", "pb-input");
	for (const [value, text] of [
		["current", t("currentTab")],
		["new", t("anotherTab")],
	]) {
		const option = element("option", "", text);
		option.value = value;
		openMode.append(option);
	}
	openMode.value = settings.newTabOpenMode === "current" ? "current" : "new";
	const startupMode = element("select", "pb-input");
	for (const value of ["agent", "browser", "split"] as const) {
		const option = element("option", "", t(value));
		option.value = value;
		startupMode.append(option);
	}
	startupMode.value =
		settings.defaultMode === "browser" || settings.defaultMode === "split" ? settings.defaultMode : "agent";
	const agentUrl = input(settings.agentUrl || currentState?.agentUrl || "", "url", "http://127.0.0.1:3000");
	const connection = element(
		"p",
		"pb-muted",
		currentState?.agentError || t(currentState?.agentReady ? "connected" : "disconnected"),
	);
	const save = button(t("save"), () => {}, "pb-primary");
	save.type = "submit";
	const permissions = element("section", "pb-section");
	permissions.append(element("h3", "", t("aiAccess")), element("p", "pb-muted", t("aiAccessHelp")));
	const switches = new Map<string, HTMLInputElement>();
	for (const key of ["aiControl", "allowShot", "allowEval"] as const) {
		const control = input("", "checkbox");
		control.checked = settings[key] !== false;
		const row = element("label", "pb-switch");
		row.append(control, element("span", "", t(key)));
		permissions.append(row);
		switches.set(key, control);
	}
	const pageScripts = element("section", "pb-section");
	const allowScripts = input("", "checkbox");
	allowScripts.checked = settings.allowScripts !== false;
	const allowScriptsRow = element("label", "pb-switch");
	allowScriptsRow.append(allowScripts, element("span", "", t("allowScripts")));
	const scriptList = element("div", "pb-list");
	pageScripts.append(
		element("h3", "", t("pageScripts")),
		element("p", "pb-muted", t("pageScriptsHelp")),
		allowScriptsRow,
		scriptList,
	);
	form.append(
		label(t("searchEngine"), engine),
		element("p", "pb-muted", t("engineHelp")),
		label(t("openMode"), openMode),
		label(t("startupMode"), startupMode),
		element("p", "pb-muted", t("startupModeHelp")),
		permissions,
		pageScripts,
		save,
	);
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		void call("settings.save", {
			settings: {
				searchEngine: engine.value,
				newTabOpenMode: openMode.value,
				defaultMode: startupMode.value,
				allowScripts: allowScripts.checked,
				...Object.fromEntries([...switches].map(([key, control]) => [key, control.checked])),
			},
		})
			.then(() => {
				panelEvent("pb-settings-changed");
				notify(t("saved"));
			})
			.catch(reportError);
	});
	const agentSection = element("section", "pb-section");
	agentSection.append(
		element("h3", "", t("agent")),
		element("p", "pb-muted", t("agentHelp")),
		label(t("agentAddress"), agentUrl),
		toolbar(
			button(t("connect"), async () => {
				const url = webUrl(agentUrl.value.trim());
				if (!url) throw new Error(t("invalidAgent"));
				connection.textContent = t("connecting");
				try {
					await call("agent.connect", { url });
					connection.textContent = t("connected");
				} catch (error) {
					connection.textContent = error instanceof Error ? error.message : t("disconnected");
					throw error;
				}
			}),
		),
		connection,
	);
	const importing = element("section", "pb-section");
	importing.append(
		element("h3", "", t("importData")),
		element("p", "pb-muted", t("importHelp")),
		button(t("importData"), async () => {
			// 导入完就地提示：浮层是独立视图，先收起面板会把提示一起带走
			const result = await call("data.import");
			if (result !== false && result !== null) {
				panelEvent("pb-bookmarks-changed");
				panelEvent("pb-settings-changed");
				notify(t("imported"));
			}
		}),
	);
	const vault = element("section", "pb-section");
	const extensions = element("section", "pb-section");
	extensions.append(
		element("h3", "", t("extensions")),
		element("p", "pb-muted", t("extensionHelp")),
		button(t("manageExtensions"), () => showPanel("extensions")),
	);
	container.replaceChildren(
		form,
		agentSection,
		vault,
		extensions,
		importing,
		element("p", "pb-muted", t("shortcuts")),
		element("small", "pb-muted", t("language")),
	);
	await Promise.all([vaultSection(vault), pageScriptsSection(scriptList)]);
}
/** 页面脚本条目：字段与内核 scripts.list 的返回契约对齐。 */
interface PageScript {
	id: string;
	name: string;
	matches: string[];
	code: string;
	css: string;
	runAt: "document-start" | "dom-ready";
	world: "main" | "isolated";
	spa: boolean;
	enabled: boolean;
	persistent: boolean;
	createdBy: "agent" | "user";
	createdAt: string;
	updatedAt: string;
}
async function pageScriptsSection(list: HTMLElement): Promise<void> {
	let scripts: PageScript[];
	try {
		scripts = await call<PageScript[]>("scripts.list");
	} catch (error) {
		list.replaceChildren(element("p", "pb-muted", error instanceof Error ? error.message : t("error")));
		return;
	}
	if (!list.isConnected) return;
	const render = (): void => {
		list.replaceChildren();
		for (const script of scripts)
			list.append(
				pageScriptRow(script, () => {
					scripts = scripts.filter((entry) => entry.id !== script.id);
					render();
				}),
			);
		if (!scripts.length) list.append(empty(t("pageScriptsEmpty")));
	};
	render();
}
function pageScriptRow(script: PageScript, onRemoved: () => void): HTMLElement {
	const row = element("div", "pb-list-item pb-script-item");
	const tags = element("div", "pb-script-tags");
	tags.append(
		element("span", "pb-badge", t(script.persistent ? "pageScriptPermanent" : "pageScriptTemporary")),
		element("span", "pb-badge", t(script.createdBy === "agent" ? "pageScriptSourceAgent" : "pageScriptSourceUser")),
	);
	if (script.runAt === "document-start") tags.append(element("span", "pb-badge", "document-start"));
	if (script.world === "isolated") tags.append(element("span", "pb-badge", "isolated"));
	const control = input("", "checkbox");
	control.checked = script.enabled;
	control.setAttribute("aria-label", script.name);
	control.title = script.name;
	control.addEventListener("change", () => {
		const enabled = control.checked;
		void call<boolean>("scripts.toggle", { id: script.id, enabled })
			.then((ok) => {
				if (!ok) throw new Error(t("error"));
				script.enabled = enabled;
			})
			.catch((error: unknown) => {
				control.checked = !enabled;
				reportError(error);
			});
	});
	const toggle = element("label", "pb-switch");
	toggle.append(control);
	const code = element("details", "pb-script-code-block");
	code.append(element("summary", "", t("showCode")));
	if (script.code) code.append(element("pre", "pb-script-code", script.code));
	if (script.css)
		code.append(element("div", "pb-muted", t("pageScriptCss")), element("pre", "pb-script-code", script.css));
	if (!script.code && !script.css) code.append(element("p", "pb-muted", t("empty")));
	row.append(
		details(script.name, script.matches.length ? script.matches.join(", ") : "*"),
		tags,
		toggle,
		iconButton(closeIcon(8), t("delete"), async () => {
			if (!(await call<boolean>("scripts.remove", { id: script.id }))) throw new Error(t("error"));
			onRemoved();
			notify(t("pageScriptRemoved"));
		}),
		code,
	);
	return row;
}
interface Credential {
	id: string;
	name: string;
	url: string;
	username: string;
	password: string;
	createdAt: string;
}
/**
 * 设置里的「密码库」段：真正的增删改查已经搬进 `vault` 面板（密码 + TOTP 同一块）。
 * 这里只留一句说明和一个入口，免得两处各维护一套列表。
 */
async function vaultSection(container: HTMLElement): Promise<void> {
	container.replaceChildren(
		element("h3", "", t("vault")),
		element("p", "pb-muted", t("vaultMovedHint")),
		button(t("openVault"), () => void showPanel("vault", { tab: "passwords" })),
	);
}
/** 扩展管理项：与内核 extensions.list 的返回契约对齐（停用未加载的项没有 id/name/version）。 */
interface ExtensionEntry {
	path: string;
	enabled: boolean;
	id: string;
	name: string;
	version: string;
	/** 工具栏弹窗页（没有弹窗就是空串） */
	popup?: string;
	/** 选项页（没有选项页就是空串） */
	options?: string;
}
/** 停用项的 name 可能为空（manifest 读不到），退化成目录名。 */
function directoryName(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).pop() || path;
}
/**
 * 扩展管理面板：Chrome 扩展菜单那一份——一行一个扩展、点整行直接开它自己的页面，
 * 启停/重载/选项/移除收进行尾菜单。启停与移除都只改主进程的「已装清单」，目录本身不删。
 */
async function extensionsPanel(container: HTMLElement): Promise<void> {
	const list = element("div", "pb-list");
	async function refresh(): Promise<void> {
		const entries = await call<ExtensionEntry[]>("extensions.list");
		if (!list.isConnected) return;
		list.replaceChildren(...entries.map((entry) => extensionRow(entry, refresh)));
		if (!entries.length) list.append(empty(t("extensionEmpty")));
	}
	const install = async (kind: "load" | "crx", trigger: HTMLButtonElement): Promise<void> => {
		trigger.disabled = true;
		try {
			const installed = await call<{ name: string; version: string } | null>(
				kind === "load" ? "extensions.load" : "extensions.installCrx",
			);
			if (!installed) return;
			panelEvent("pb-extensions-changed");
			notify(`${t("crxInstalled")}: ${installed.name} ${installed.version}`);
			await refresh();
		} finally {
			// 选目录的对话框是原生模态的：装完（含取消）必须把按钮还回来
			trigger.disabled = false;
		}
	};
	const footer = element("div", "pb-extension-install");
	const loadBtn = button(t("loadExtension"), () => install("load", loadBtn));
	const crxBtn = button(t("installCrx"), () => install("crx", crxBtn));
	footer.append(loadBtn, crxBtn);
	container.replaceChildren(list, footer);
	await refresh();
}

/**
 * 整行的主动作：开扩展自己声明的页面（`default_popup`，没有就退到选项页），
 * 等同于在工具栏上点它的动作图标。先开页再收面板：浮层是独立视图，先收会把这次调用的 IPC 一起带走。
 */
async function openExtensionEntry(entry: ExtensionEntry, anchor: { x: number; y: number }): Promise<void> {
	if (!entry.enabled) {
		notify(t("extensionDisabledHint"), true);
		return;
	}
	if (!entry.popup && !entry.options) {
		notify(t("extensionPopupUnavailable"), true);
		return;
	}
	await openExtensionPage(entry, entry.popup ? "popup" : "options", anchor);
	await closePanel();
}

/** 扩展自己声明的页面：`popup` = 工具栏弹窗（失焦即关），`options` = 选项页（普通窗口）。 */
async function openExtensionPage(
	entry: ExtensionEntry,
	kind: "popup" | "options",
	anchor: { x: number; y: number },
): Promise<void> {
	const opened = await call<boolean>(kind === "popup" ? "extensions.openPopup" : "extensions.openOptions", {
		path: entry.path,
		anchor,
	});
	if (opened) return;
	notify(t(kind === "popup" ? "extensionPopupUnavailable" : "extensionOptionsUnavailable"), true);
}

/** 屏幕坐标锚点：调用方给视口坐标，这里换成主进程能用的绝对坐标。 */
function screenPoint(clientX: number, clientY: number): { x: number; y: number } {
	return { x: Math.round(window.screenX + clientX), y: Math.round(window.screenY + clientY) };
}

async function setExtensionEnabled(
	entry: ExtensionEntry,
	enabled: boolean,
	onChanged: () => Promise<void>,
): Promise<void> {
	await call<boolean>("extensions.toggle", { path: entry.path, enabled });
	panelEvent("pb-extensions-changed");
	notify(t(enabled ? "extensionEnabled" : "extensionDisabled"));
	await onChanged();
}

async function reloadExtension(entry: ExtensionEntry, onChanged: () => Promise<void>): Promise<void> {
	await call("extensions.reload", { path: entry.path });
	panelEvent("pb-extensions-changed");
	notify(t("extensionReloaded"));
	await onChanged();
}

async function removeExtension(entry: ExtensionEntry, onChanged: () => Promise<void>): Promise<void> {
	await call("extensions.remove", { path: entry.path });
	panelEvent("pb-extensions-changed");
	notify(t("extensionRemoved"));
	await onChanged();
}

/** 行右键菜单：菜单项在这里拼（文案跟着界面语言），主进程只负责弹原生菜单。 */
async function extensionRowMenu(
	entry: ExtensionEntry,
	point: { x: number; y: number },
	onChanged: () => Promise<void>,
): Promise<void> {
	type MenuItem = {
		id?: string;
		label?: string;
		type?: "separator" | "checkbox";
		checked?: boolean;
	};
	const items: MenuItem[] = [];
	// 「打开弹窗 / 选项」只对已加载的扩展有意义：停用的扩展连会话都没有，更跑不了自己的页面
	if (entry.id) {
		if (entry.popup) items.push({ id: "popup", label: t("openExtensionPopup") });
		if (entry.options) items.push({ id: "options", label: t("extensionOptions") });
		if (items.length) items.push({ type: "separator" });
	}
	items.push({
		id: "toggle",
		label: t(entry.enabled ? "disableExtension" : "enableExtension"),
		type: "checkbox",
		checked: entry.enabled,
	});
	if (entry.id) items.push({ id: "reload", label: t("reloadExtension") });
	items.push({ type: "separator" }, { id: "remove", label: t("removeExtension") });
	const choice = await call<string | null>("extensions.menu", { items, anchor: point });
	if (!choice) return;
	// 与点整行一致：先把网页还给窗口，再收起面板
	if (choice === "popup" || choice === "options") {
		await openExtensionPage(entry, choice, point);
		return await closePanel();
	}
	if (choice === "toggle") return await setExtensionEnabled(entry, !entry.enabled, onChanged);
	if (choice === "reload") return await reloadExtension(entry, onChanged);
	if (choice === "remove") return await removeExtension(entry, onChanged);
}

function extensionRow(entry: ExtensionEntry, onChanged: () => Promise<void>): HTMLElement {
	const row = element("div", "pb-list-item pb-extension-item");
	const name = entry.name || directoryName(entry.path);
	if (!entry.enabled) row.classList.add("pb-extension-off");
	const toggle = input("", "checkbox");
	toggle.checked = entry.enabled;
	toggle.setAttribute("aria-label", `${t(entry.enabled ? "disableExtension" : "enableExtension")}: ${name}`);
	toggle.addEventListener("change", () => {
		const enabled = toggle.checked;
		toggle.disabled = true;
		void setExtensionEnabled(entry, enabled, onChanged)
			.catch((error) => {
				// 加载失败就恢复勾选，界面不能谎报状态
				toggle.checked = !enabled;
				reportError(error);
			})
			.finally(() => {
				toggle.disabled = false;
			});
	});
	const control = element("label", "pb-switch");
	control.append(toggle);
	// 弹窗跟着鼠标点：记下按下时的视口坐标，开窗拿它当锚点（键盘回车 / 鼠标点不在行内时回退到行右下角）
	let pressed: { x: number; y: number } | null = null;
	row.addEventListener("pointerdown", (event) => {
		pressed = event.button === 0 ? { x: event.clientX, y: event.clientY } : null;
	});
	const takeAnchor = (fallback: { x: number; y: number }): { x: number; y: number } => {
		const point = pressed;
		pressed = null;
		return point ? screenPoint(point.x, point.y) : fallback;
	};
	// 整行的主动作就是把这一行点开——和 Chrome 里点动作图标一样开它自己的页面
	const opener = button(
		[
			element("strong", "pb-extension-name", name),
			element("span", "pb-extension-meta", entry.id ? entry.version : t("extensionNotLoaded")),
		],
		() => {
			const box = row.getBoundingClientRect();
			return openExtensionEntry(entry, takeAnchor(screenPoint(box.right, box.bottom + 4)));
		},
		"pb-extension-open",
	);
	opener.title = `${name}\n${entry.path}`;
	const more = iconButton(moreIcon(13), t("extensionActions"), () => {
		const box = more.getBoundingClientRect();
		return extensionRowMenu(entry, screenPoint(box.left, box.bottom + 4), onChanged);
	});
	more.classList.add("pb-extension-more");
	row.append(control, opener, more);
	// 右键也是同一张菜单（弹窗 / 选项 / 启停 / 重载 / 移除，原生菜单不做 DOM 浮层）
	row.addEventListener("contextmenu", (event) => {
		event.preventDefault();
		void extensionRowMenu(entry, screenPoint(event.clientX, event.clientY), onChanged).catch(reportError);
	});
	return row;
}
interface DownloadEntry {
	id: string;
	name?: string;
	filename?: string;
	path: string;
	url: string;
	receivedBytes: number;
	totalBytes: number;
	state: string;
}
async function downloadsPanel(container: HTMLElement): Promise<void> {
	const list = element("div", "pb-list");
	const render = async (): Promise<void> => {
		const entries = await call<DownloadEntry[]>("downloads.list");
		if (!container.isConnected) return;
		list.replaceChildren();
		for (const entry of entries) {
			const status: MessageKey =
				entry.state === "completed"
					? "complete"
					: entry.state === "cancelled"
						? "downloadCancelled"
						: entry.state === "interrupted"
							? "downloadFailed"
							: "downloading";
			const total = entry.totalBytes > 0 ? ` / ${Math.round(entry.totalBytes / 1024)} KB` : "";
			const row = element("div", "pb-list-item");
			row.append(
				details(
					entry.filename || entry.name || t("untitled"),
					`${t(status)} · ${Math.round(entry.receivedBytes / 1024)} KB${total}`,
				),
			);
			if (entry.state === "completed") row.append(button(t("open"), () => call("download.open", { id: entry.id })));
			list.append(row);
		}
		if (!entries.length) list.append(empty(t("noDownloads")));
	};
	container.replaceChildren(element("p", "pb-muted", t("downloadHelp")), button(t("reload"), render), list);
	await render();
}
/** 顶栏的收藏动作（只在外壳里用）：没有可收藏的地址时改开书签面板，面板同样开在浮层里。 */
export async function addCurrentBookmark(): Promise<void> {
	const state = currentState || (await call<BrowserState>("state"));
	const tab = state.tabs.find((tab) => tab.id === state.activeTabId);
	if (!tab || !webUrl(tab.url)) {
		await showShellPanel("bookmarks");
		return;
	}
	const bookmarks = normalizeBookmarks(await call("bookmarks.list"));
	if (flattenBookmarks(bookmarks).some((item) => item.url === tab.url)) {
		notify(t("bookmarkExists"));
		return;
	}
	bookmarks.push({ name: tab.title || hostName(tab.url), type: "link", url: tab.url });
	await call("bookmarks.save", { bookmarks });
	panelEvent("pb-bookmarks-changed");
	notify(t("bookmarkSaved"));
}
