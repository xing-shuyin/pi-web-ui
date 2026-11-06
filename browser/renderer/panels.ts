import {
	call,
	element,
	button,
	iconButton,
	input,
	label,
	empty,
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
import type { BrowserState } from "../contracts.js";
export type Panel = "bookmarks" | "history" | "settings" | "downloads";
let dialog: HTMLDialogElement | undefined;
let overlayOwned = false;
let release: Promise<unknown> = Promise.resolve();
let activePanel: Panel | undefined;
let currentState: BrowserState | undefined;
let revision = 0;
export function setPanelState(state: BrowserState): void {
	currentState = state;
}
export function panelIsOpen(): boolean {
	return !!dialog?.open;
}
export async function closePanel(): Promise<void> {
	revision++;
	const closing = dialog;
	dialog = undefined;
	activePanel = undefined;
	closing?.close();
	closing?.remove();
	if (overlayOwned) {
		overlayOwned = false;
		release = call("overlay", { open: false });
		await release;
	}
}
let pendingPanel: Promise<void> = Promise.resolve();
export function showPanel(panel: Panel): Promise<void> {
	const opening = pendingPanel.then(() => openPanel(panel));
	pendingPanel = opening.catch(() => {});
	return opening;
}
async function openPanel(panel: Panel): Promise<void> {
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
	const node = element("dialog", "pb-dialog");
	dialog = node;
	node.setAttribute("aria-labelledby", "pb-panel-heading");
	const header = element("header", "pb-dialog-header");
	const title = element("h2", "", t(panel));
	title.id = "pb-panel-heading";
	header.append(title, iconButton("×", t("close"), closePanel));
	const content = element("div", "pb-dialog-content");
	content.append(empty(t("loading")));
	node.append(header, content);
	node.addEventListener("cancel", (event) => {
		event.preventDefault();
		void closePanel().catch(reportError);
	});
	node.addEventListener("click", (event) => {
		if (event.target === node) {
			const r = node.getBoundingClientRect();
			if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom)
				void closePanel().catch(reportError);
		}
	});
	document.body.append(node);
	node.showModal();
	try {
		if (panel === "bookmarks") await bookmarksPanel(content);
		if (panel === "history") await historyPanel(content);
		if (panel === "settings") await settingsPanel(content);
		if (panel === "downloads") await downloadsPanel(content);
	} catch (error) {
		if (!node.isConnected) return;
		content.replaceChildren(
			empty(error instanceof Error ? error.message : t("error")),
			button(t("retry"), () => showPanelAgain(panel)),
		);
	}
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
	await closePanel();
	await openUrl(url, newTab);
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
		window.dispatchEvent(new Event("pb-bookmarks-changed"));
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
			opener.append(
				element(
					"span",
					"pb-item-symbol",
					item.type === "folder" ? "▰" : item.char || item.name.slice(0, 1).toUpperCase(),
				),
				details(
					item.name,
					item.type === "folder" ? `${item.children?.length || 0} · ${t("bookmarks")}` : item.url || "",
				),
			);
			row.append(
				opener,
				iconButton("✎", t("edit"), () => showEditor(item)),
				iconButton("×", t("delete"), async () => {
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
	form.append(
		label(t("searchEngine"), engine),
		element("p", "pb-muted", t("engineHelp")),
		label(t("openMode"), openMode),
		permissions,
		save,
	);
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		void call("settings.save", {
			settings: {
				searchEngine: engine.value,
				newTabOpenMode: openMode.value,
				...Object.fromEntries([...switches].map(([key, control]) => [key, control.checked])),
			},
		})
			.then(() => {
				window.dispatchEvent(new Event("pb-settings-changed"));
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
			await closePanel();
			const result = await call("data.import");
			if (result !== false && result !== null) {
				window.dispatchEvent(new Event("pb-bookmarks-changed"));
				window.dispatchEvent(new Event("pb-settings-changed"));
				notify(t("imported"));
			}
		}),
	);
	const vault = element("section", "pb-section");
	const extensions = element("section", "pb-section");
	container.replaceChildren(
		form,
		agentSection,
		vault,
		extensions,
		importing,
		element("p", "pb-muted", t("shortcuts")),
		element("small", "pb-muted", t("language")),
	);
	await Promise.all([vaultSection(vault), extensionsSection(extensions)]);
}
interface Credential {
	id: string;
	name: string;
	url: string;
	username: string;
	password: string;
	createdAt: string;
}
async function vaultSection(container: HTMLElement): Promise<void> {
	container.replaceChildren(element("h3", "", t("vault")));
	try {
		if (!(await call<boolean>("passwords.available"))) {
			container.append(element("p", "pb-muted", t("vaultUnavailable")));
			return;
		}
		let entries = await call<Credential[]>("passwords.list");
		const list = element("div", "pb-list");
		const editor = element("form", "pb-form pb-editor-inline");
		editor.hidden = true;
		const name = input();
		const url = input("", "url");
		const username = input();
		const secret = input("", "password");
		secret.autocomplete = "new-password";
		username.autocomplete = "off";
		const submit = button(t("save"), () => {}, "pb-primary");
		submit.type = "submit";
		const showSecret = button(t("showPassword"), () => {
			secret.type = secret.type === "password" ? "text" : "password";
			showSecret.textContent = t(secret.type === "password" ? "showPassword" : "hidePassword");
		});
		editor.append(
			label(t("name"), name),
			label(t("url"), url),
			label(t("username"), username),
			label(t("password"), secret),
			toolbar(
				showSecret,
				submit,
				button(t("cancel"), () => {
					editor.reset();
					secret.value = "";
					editor.hidden = true;
				}),
			),
		);
		function render(): void {
			list.replaceChildren();
			for (const entry of entries) {
				const row = element("div", "pb-list-item");
				row.append(
					details(entry.name, `${entry.username} · ${hostName(entry.url)}`),
					button(t("fillCredential"), async () => {
						await call("passwords.fill", { id: entry.id });
						await closePanel();
						notify(t("credentialFilled"));
					}),
					iconButton("×", t("removeCredential"), async () => {
						const next = entries.filter((value) => value.id !== entry.id);
						await call("passwords.save", { entries: next });
						entries = next;
						render();
					}),
				);
				list.append(row);
			}
			if (!entries.length) list.append(empty(t("noCredentials")));
		}
		editor.addEventListener("submit", (event) => {
			event.preventDefault();
			void (async () => {
				const valid = webUrl(url.value.trim());
				if (!name.value.trim() || !valid || !username.value.trim() || !secret.value)
					throw new Error(t("credentialRequired"));
				const next = [
					...entries,
					{
						id: crypto.randomUUID(),
						name: name.value.trim(),
						url: valid,
						username: username.value.trim(),
						password: secret.value,
						createdAt: new Date().toISOString(),
					},
				];
				await call("passwords.save", { entries: next });
				entries = next;
				editor.reset();
				secret.value = "";
				editor.hidden = true;
				render();
				notify(t("saved"));
			})().catch(reportError);
		});
		container.append(
			element("p", "pb-muted", t("security")),
			button(t("addCredential"), () => {
				editor.hidden = false;
				name.focus();
			}),
			editor,
			list,
		);
		render();
	} catch (error) {
		container.append(element("p", "pb-muted", error instanceof Error ? error.message : t("vaultUnavailable")));
	}
}
async function extensionsSection(container: HTMLElement): Promise<void> {
	container.replaceChildren(element("h3", "", t("extensions")), element("p", "pb-muted", t("extensionHelp")));
	const list = element("div", "pb-list");
	const refresh = async (): Promise<void> => {
		const entries = await call<{ id: string; name: string; version: string }[]>("extensions.list");
		list.replaceChildren(
			...entries.map((entry) => {
				const row = element("div", "pb-list-item");
				row.append(details(entry.name, `${entry.version} · ${entry.id}`));
				return row;
			}),
		);
		if (!entries.length) list.append(empty());
	};
	const load = button(t("loadExtension"), async () => {
		load.disabled = true;
		try {
			await call("extensions.load");
			await refresh();
		} finally {
			load.disabled = false;
		}
	});
	container.append(load, list);
	try {
		await refresh();
	} catch (error) {
		list.replaceChildren(empty(error instanceof Error ? error.message : t("error")));
	}
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
export async function addCurrentBookmark(): Promise<void> {
	const state = currentState || (await call<BrowserState>("state"));
	const tab = state.tabs.find((tab) => tab.id === state.activeTabId);
	if (!tab || !webUrl(tab.url)) {
		await showPanel("bookmarks");
		return;
	}
	const bookmarks = normalizeBookmarks(await call("bookmarks.list"));
	if (flattenBookmarks(bookmarks).some((item) => item.url === tab.url)) {
		notify(t("bookmarkExists"));
		return;
	}
	bookmarks.push({ name: tab.title || hostName(tab.url), type: "link", url: tab.url });
	await call("bookmarks.save", { bookmarks });
	window.dispatchEvent(new Event("pb-bookmarks-changed"));
	notify(t("bookmarkSaved"));
}
