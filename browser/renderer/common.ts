import "../../web/src/styles.css";
import "./browser.css";
import type { BrowserShellAction, BrowserState } from "../contracts.js";
import { t } from "./i18n.js";

export interface Bookmark {
	name: string;
	type: "folder" | "link";
	url?: string;
	children?: Bookmark[];
	bg?: string;
	char?: string;
}
export interface HistoryEntry {
	url: string;
	title: string;
	visitedAt: number;
}
export interface Settings {
	searchEngine?: string;
	newTabOpenMode?: string;
	agentUrl?: string;
	theme?: string;
	[key: string]: unknown;
}
export interface FileResult {
	path: string;
	name?: string;
	content: string;
	mimeType?: string;
	encoding?: string;
}
export interface ShellBridge {
	call<T = unknown>(action: BrowserShellAction | "overlay", args?: Record<string, unknown>): Promise<T>;
	onState(callback: (state: BrowserState) => void): (() => void) | void;
	onOpenOptions?(callback: () => void): (() => void) | void;
	onFocusAddress?(callback: () => void): (() => void) | void;
}
declare global {
	interface Window {
		piBrowserShell?: ShellBridge;
		piDesktop?: {
			window: {
				minimize(): void;
				toggleMaximize(): void;
				close(): void;
				isMaximized(): Promise<boolean>;
				onMaximizedChange(callback: (maximized: boolean) => void): (() => void) | void;
			};
		};
	}
}
let bridgePromise: Promise<ShellBridge> | undefined;
export function bridgeReady(): Promise<ShellBridge> {
	if (window.piBrowserShell) return Promise.resolve(window.piBrowserShell);
	return (bridgePromise ||= new Promise((resolve, reject) => {
		const started = Date.now();
		const timer = setInterval(() => {
			if (window.piBrowserShell) {
				clearInterval(timer);
				resolve(window.piBrowserShell);
			} else if (Date.now() - started >= 3000) {
				clearInterval(timer);
				bridgePromise = undefined;
				reject(new Error(t("unavailable")));
			}
		}, 50);
	}));
}
export async function call<T = unknown>(
	action: BrowserShellAction | "overlay",
	args?: Record<string, unknown>,
): Promise<T> {
	return (await bridgeReady()).call<T>(action, args);
}
export function element<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className = "",
	text?: string,
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}
export function button(label: string, onClick: () => void | Promise<unknown>, className = ""): HTMLButtonElement {
	const node = element("button", `pb-button ${className}`, label);
	node.type = "button";
	node.addEventListener("click", () => {
		Promise.resolve().then(onClick).catch(reportError);
	});
	return node;
}
export function iconButton(icon: string, label: string, onClick: () => void | Promise<unknown>): HTMLButtonElement {
	const node = button(icon, onClick, "pb-icon-button");
	node.title = label;
	node.setAttribute("aria-label", label);
	return node;
}
let toastTimer: ReturnType<typeof setTimeout>;
export function notify(message: string, error = false): void {
	let node = document.querySelector<HTMLElement>(".pb-toast");
	if (!node) {
		node = element("div", "pb-toast");
		node.setAttribute("role", "status");
	}
	const host = document.querySelector<HTMLDialogElement>("dialog[open]") || document.body;
	if (node.parentElement !== host) host.append(node);
	node.textContent = message;
	node.classList.toggle("pb-error", error);
	node.hidden = false;
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => {
		if (node) node.hidden = true;
	}, 5000);
}
export function reportError(error: unknown): void {
	notify(`${t("error")}: ${error instanceof Error ? error.message : String(error)}`, true);
}
export function label(text: string, input: HTMLElement): HTMLLabelElement {
	const node = element("label", "pb-field");
	node.append(element("span", "pb-field-label", text), input);
	return node;
}
export function input(value = "", type = "text", placeholder = ""): HTMLInputElement {
	const node = element("input", "pb-input");
	node.type = type;
	node.value = value;
	node.placeholder = placeholder;
	return node;
}
export function empty(text = t("empty")): HTMLElement {
	return element("p", "pb-empty", text);
}
export function webUrl(value: string): string | null {
	try {
		const u = new URL(value);
		return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password ? u.href : null;
	} catch {
		return null;
	}
}
const engines: Record<string, string> = {
	bing: "https://www.bing.com/search?q=",
	google: "https://www.google.com/search?q=",
	baidu: "https://www.baidu.com/s?wd=",
	duckduckgo: "https://duckduckgo.com/?q=",
};
export function addressUrl(value: string, searchEngine = "bing"): string {
	const query = value.trim();
	if (!query) return "newtab";
	if (/^(newtab|search|office|workspace):?$/.test(query)) return query.replace(/:$/, "");
	const explicit = webUrl(query);
	if (explicit) return explicit;
	if (/^[a-z][\w+.-]*:/i.test(query) && !/^localhost:\d/i.test(query) && !/^[\w.-]+:\d+([/?#]|$)/.test(query))
		throw new Error(t("invalidUrl"));
	if (!/\s/.test(query) && /^(localhost|(?:\d{1,3}\.){3}\d{1,3}|[\w-]+(?:\.[\w-]+)+)(:\d+)?([/?#].*)?$/i.test(query)) {
		return new URL(`${/^(localhost|127\.)/.test(query) ? "http" : "https"}://${query}`).href;
	}
	return `${engines[searchEngine] || engines.bing}${encodeURIComponent(query)}`;
}
export async function openUrl(url: string, newTab = false): Promise<void> {
	await call(newTab ? "tabs.create" : "navigate", { url });
}
export function flattenBookmarks(nodes: Bookmark[]): Bookmark[] {
	return nodes.flatMap((node) => (node.type === "folder" ? flattenBookmarks(node.children || []) : [node]));
}
export function normalizeBookmarks(value: unknown): Bookmark[] {
	const list = Array.isArray(value)
		? value
		: value && typeof value === "object" && "children" in value
			? (value as Bookmark).children
			: [];
	if (!Array.isArray(list)) return [];
	return list
		.filter(
			(v): v is Bookmark =>
				!!v && typeof v === "object" && typeof v.name === "string" && (v.type === "folder" || v.type === "link"),
		)
		.map((v) => ({ ...v, ...(v.type === "folder" ? { children: normalizeBookmarks(v.children) } : {}) }));
}
export function hostName(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return url;
	}
}
export function dateTime(value: number): string {
	return Number.isFinite(value) ? new Date(value).toLocaleString() : "";
}
export function applySettings(settings: Settings): void {
	document.documentElement.style.colorScheme = settings.theme === "light" ? "light" : "dark";
}
export function listenState(callback: (state: BrowserState) => void): void {
	void bridgeReady()
		.then((bridge) => {
			const dispose = bridge.onState(callback);
			if (dispose) window.addEventListener("pagehide", dispose, { once: true });
		})
		.catch(reportError);
}
export const brand = (): HTMLElement => element("span", "pb-brand", "π");
