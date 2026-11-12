import "../../web/src/styles.css";
import "./browser.css";
import type { BrowserPanelEvent, BrowserShellAction, BrowserState } from "../contracts.js";
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
	/** 启动模式：agent（默认）/ browser / split */
	defaultMode?: string;
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
	call<T = unknown>(action: BrowserShellAction, args?: Record<string, unknown>): Promise<T>;
	onState(callback: (state: BrowserState) => void): (() => void) | void;
	/** 面板视图里的改动（书签 / 设置 / 扩展）：面板是独立视图，window 事件跨不过去，由宿主转发 */
	onPanelEvent?(callback: (name: BrowserPanelEvent) => void): (() => void) | void;
	onOpenOptions?(callback: () => void): (() => void) | void;
	onFocusAddress?(callback: () => void): (() => void) | void;
	/** 拖入文件的真实路径（preload 用 webUtils 取，渲染层拿不到） */
	filePath?(file: File): string;
}
declare global {
	interface Window {
		piBrowserShell?: ShellBridge;
		piDesktop?: {
			platform?: string;
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
export async function call<T = unknown>(action: BrowserShellAction, args?: Record<string, unknown>): Promise<T> {
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
export function button(
	label: string | Node | Array<string | Node>,
	onClick: () => void | Promise<unknown>,
	className = "",
): HTMLButtonElement {
	const node = element("button", `pb-button ${className}`);
	node.type = "button";
	if (typeof label === "string") {
		if (label) node.textContent = label;
	} else if (Array.isArray(label)) {
		node.append(...label);
	} else if (label) {
		node.append(label);
	}
	node.addEventListener("click", () => {
		Promise.resolve().then(onClick).catch(reportError);
	});
	return node;
}
export function iconButton(
	icon: string | Node,
	label: string,
	onClick: () => void | Promise<unknown>,
): HTMLButtonElement {
	const node = button(icon, onClick, "pb-icon-button");
	node.title = label;
	node.setAttribute("aria-label", label);
	return node;
}

export function createSvg(width: number, height: number, viewBox: string, paths: SVGElement[]): SVGSVGElement {
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("width", String(width));
	svg.setAttribute("height", String(height));
	svg.setAttribute("viewBox", viewBox);
	svg.setAttribute("fill", "none");
	svg.setAttribute("aria-hidden", "true");
	for (const el of paths) svg.appendChild(el);
	return svg;
}

export function svgPath(
	d: string,
	strokeWidth = "1.2",
	strokeLinecap: "round" | "butt" | "square" = "round",
	strokeLinejoin: "round" | "bevel" | "miter" = "round",
): SVGPathElement {
	const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
	path.setAttribute("d", d);
	path.setAttribute("stroke", "currentColor");
	path.setAttribute("stroke-width", strokeWidth);
	if (strokeLinecap) path.setAttribute("stroke-linecap", strokeLinecap);
	if (strokeLinejoin) path.setAttribute("stroke-linejoin", strokeLinejoin);
	return path;
}

export function svgRect(
	x: number,
	y: number,
	width: number,
	height: number,
	rx = 0,
	strokeWidth = "1.2",
	fill = "none",
	fillOpacity?: string,
): SVGRectElement {
	const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
	rect.setAttribute("x", String(x));
	rect.setAttribute("y", String(y));
	rect.setAttribute("width", String(width));
	rect.setAttribute("height", String(height));
	if (rx > 0) rect.setAttribute("rx", String(rx));
	rect.setAttribute("stroke", "currentColor");
	rect.setAttribute("stroke-width", strokeWidth);
	rect.setAttribute("fill", fill);
	if (fillOpacity) rect.setAttribute("fill-opacity", fillOpacity);
	return rect;
}

export function svgCircle(cx: number, cy: number, r: number, strokeWidth = "1.2", fill = "none"): SVGCircleElement {
	const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
	circle.setAttribute("cx", String(cx));
	circle.setAttribute("cy", String(cy));
	circle.setAttribute("r", String(r));
	if (fill !== "none") {
		circle.setAttribute("fill", fill);
	} else {
		circle.setAttribute("stroke", "currentColor");
		circle.setAttribute("stroke-width", strokeWidth);
		circle.setAttribute("fill", "none");
	}
	return circle;
}

export function svgEllipse(cx: number, cy: number, rx: number, ry: number, strokeWidth = "1.2"): SVGEllipseElement {
	const ellipse = document.createElementNS("http://www.w3.org/2000/svg", "ellipse");
	ellipse.setAttribute("cx", String(cx));
	ellipse.setAttribute("cy", String(cy));
	ellipse.setAttribute("rx", String(rx));
	ellipse.setAttribute("ry", String(ry));
	ellipse.setAttribute("stroke", "currentColor");
	ellipse.setAttribute("stroke-width", strokeWidth);
	ellipse.setAttribute("fill", "none");
	return ellipse;
}

export function closeIcon(size = 8): SVGSVGElement {
	return createSvg(size, size, "0 0 8 8", [svgPath("M1.5 1.5l5 5M6.5 1.5l-5 5", "1.2", "round")]);
}

export function plusIcon(size = 12): SVGSVGElement {
	return createSvg(size, size, "0 0 12 12", [svgPath("M6 2v8M2 6h8", "1.3", "round")]);
}

export function searchIcon(size = 15): SVGSVGElement {
	return createSvg(size, size, "0 0 16 16", [svgCircle(7, 7, 4.5, "1.3"), svgPath("M10.5 10.5L14 14", "1.3", "round")]);
}

export function splitModeIcon(size = 15): SVGSVGElement {
	return createSvg(size, size, "0 0 16 16", [
		svgRect(1.5, 2, 13, 12, 2, "1.2"),
		svgPath("M6.5 2v12", "1.2", "butt"),
		svgRect(2.5, 3, 3, 10, 1, "0", "currentColor", "0.3"),
	]);
}

export function browserModeIcon(size = 15): SVGSVGElement {
	return createSvg(size, size, "0 0 16 16", [
		svgCircle(8, 8, 6, "1.2"),
		svgEllipse(8, 8, 2.5, 6, "1.2"),
		svgPath("M2.2 8h11.6", "1.2", "butt"),
	]);
}

export function agentModeIcon(size = 15): SVGSVGElement {
	return createSvg(size, size, "0 0 16 16", [
		svgRect(2.5, 4.5, 11, 8.5, 2, "1.2"),
		svgCircle(5.8, 8.5, 1, "0", "currentColor"),
		svgCircle(10.2, 8.5, 1, "0", "currentColor"),
		svgPath("M8 1.5v3M6 1.5h4", "1.2", "round"),
		svgPath("M5.5 11h5", "1.1", "round"),
	]);
}

export function arrowTopRightIcon(size = 12): SVGSVGElement {
	return createSvg(size, size, "0 0 12 12", [svgPath("M3 9L9 3M4.5 3H9v4.5", "1.2", "round", "round")]);
}

export function spinnerIcon(size = 12): SVGSVGElement {
	return createSvg(size, size, "0 0 12 12", [svgPath("M6 1.5a4.5 4.5 0 1 1-4.5 4.5", "1.3", "round")]);
}

export function globeIcon(size = 12): SVGSVGElement {
	return createSvg(size, size, "0 0 12 12", [
		svgCircle(6, 6, 4.5, "1.1"),
		svgEllipse(6, 6, 2, 4.5, "1.1"),
		svgPath("M1.8 6h8.4", "1.1", "butt"),
	]);
}

export function starIcon(size = 13): SVGSVGElement {
	return createSvg(size, size, "0 0 16 16", [
		svgPath("M8 1.5l2 4 4.5.7-3.3 3.2.8 4.6L8 11.8 3.9 14l.8-4.6L1.5 6.2l4.5-.7 2-4z", "1.2", "round", "round"),
	]);
}

export function downloadIcon(size = 13): SVGSVGElement {
	return createSvg(size, size, "0 0 16 16", [
		svgPath("M8 2v8M4.5 7.5L8 11l3.5-3.5", "1.3", "round", "round"),
		svgPath("M2.5 13.5h11", "1.3", "round"),
	]);
}

export function clockIcon(size = 13): SVGSVGElement {
	return createSvg(size, size, "0 0 16 16", [
		svgCircle(8, 8, 6, "1.3"),
		svgPath("M8 4.5V8l2.5 1.5", "1.3", "round", "round"),
	]);
}

export function gearIcon(size = 13): SVGSVGElement {
	return createSvg(size, size, "0 0 16 16", [
		svgCircle(8, 8, 2.8, "1.3"),
		svgPath(
			"M8 1.5v1.5M8 13v1.5M1.5 8h1.5M13 8h1.5M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1",
			"1.3",
			"round",
		),
	]);
}

export function chevronDownIcon(size = 10): SVGSVGElement {
	return createSvg(size, size, "0 0 10 10", [svgPath("M2.5 4L5 6.5L7.5 4", "1.3", "round", "round")]);
}

export function checkIcon(size = 12): SVGSVGElement {
	return createSvg(size, size, "0 0 12 12", [svgPath("M2.5 6.5l2.5 2.5 4.5-5.5", "1.4", "round", "round")]);
}

export function editIcon(size = 12): SVGSVGElement {
	return createSvg(size, size, "0 0 14 14", [
		svgPath("M10 2a1.5 1.5 0 0 1 2 2L4.5 11.5 2 12l.5-2.5L10 2z", "1.2", "round", "round"),
		svgPath("M8.5 3.5l2 2", "1.2", "round", "round"),
	]);
}

export function folderIcon(size = 13): SVGSVGElement {
	return createSvg(size, size, "0 0 16 16", [
		svgPath(
			"M1.5 3.5a1 1 0 0 1 1-1h3.2l1.6 1.8H13.5a1 1 0 0 1 1 1v7.2a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-9z",
			"1.2",
			"round",
			"round",
		),
	]);
}

/** 三个点：行尾「更多动作」（右键菜单的可见入口）。 */
export function moreIcon(size = 13): SVGSVGElement {
	return createSvg(size, size, "0 0 13 13", [
		svgCircle(3, 6.5, 1, "0", "currentColor"),
		svgCircle(6.5, 6.5, 1, "0", "currentColor"),
		svgCircle(10, 6.5, 1, "0", "currentColor"),
	]);
}

/** 拼图块：工具栏的扩展入口（等同 Chrome 的扩展图标）。 */
export function extensionIcon(size = 13): SVGSVGElement {
	return createSvg(size, size, "0 0 12 12", [
		svgPath("M1.5 1.5h2.7a1.2 1.2 0 0 1 2.4 0H9v2.7a1.2 1.2 0 0 1 0 2.4V9H1.5z", "1.1", "round", "round"),
	]);
}
/** 钥匙：TOTP 验证器入口（工具栏）。 */
export function keyIcon(size = 13): SVGSVGElement {
	return createSvg(size, size, "0 0 16 16", [
		svgCircle(5.5, 5.5, 3, "1.3"),
		svgPath("M7.8 7.8L13.5 13.5", "1.3", "round"),
		svgPath("M11.2 11.2l1.6-1.6", "1.3", "round"),
	]);
}
export function reloadIcon(size = 12): SVGSVGElement {
	return createSvg(size, size, "0 0 16 16", [
		svgPath("M13 8a5 5 0 1 1-1.7-3.7", "1.4", "round"),
		svgPath("M13 1.6v3.6h-3.6", "1.4", "round", "round"),
	]);
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
	const theme = settings.theme === "light" ? "light" : settings.theme === "midnight" ? "midnight" : "dark";
	document.documentElement.style.colorScheme = theme === "light" ? "light" : "dark";
	document.documentElement.setAttribute("data-theme", theme);
}
let dropHint: HTMLElement | undefined;
function showDropHint(visible: boolean): void {
	if (!visible) {
		dropHint?.remove();
		dropHint = undefined;
		return;
	}
	if (dropHint) return;
	dropHint = element("div", "pb-drop-hint", t("crxDropHint"));
	document.body.append(dropHint);
}
/**
 * 把 .crx 拖到浏览器任意内部页就装：路径只能由 preload 的 webUtils 取（渲染层拿不到），
 * 拿不到时明确报错，不要静默吞掉。
 */
export function enableCrxDropTarget(): void {
	const pathOf = (file: File | undefined): string => {
		if (!file) return "";
		const bridge = window.piBrowserShell;
		const fromBridge = bridge?.filePath?.(file);
		return fromBridge || (file as File & { path?: string }).path || "";
	};
	const hasFiles = (event: DragEvent): boolean => Array.from(event.dataTransfer?.types ?? []).includes("Files");
	document.addEventListener("dragover", (event) => {
		if (!hasFiles(event)) return;
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
		showDropHint(true);
	});
	// relatedTarget 为空 = 真的离开窗口（逐元素 dragleave 抖动很常见，不能据此收起提示）
	document.addEventListener("dragleave", (event) => {
		if (!event.relatedTarget) showDropHint(false);
	});
	document.addEventListener("dragend", () => showDropHint(false));
	document.addEventListener(
		"drop",
		(event) => {
			if (!hasFiles(event)) return;
			event.preventDefault();
			showDropHint(false);
			const file = event.dataTransfer?.files?.[0];
			void (async () => {
				const path = pathOf(file);
				if (!path) throw new Error(t("crxDropNoPath"));
				if (!/\.crx$/i.test(path)) throw new Error(t("crxDropOnly"));
				const installed = await call<{ name: string; version: string } | null>("extensions.installCrx", { path });
				if (installed) window.dispatchEvent(new Event("pb-extensions-changed"));
				notify(installed ? `${t("crxInstalled")}: ${installed.name} ${installed.version}` : t("crxInstalled"));
			})().catch(reportError);
		},
		true,
	);
}
export function listenState(callback: (state: BrowserState) => void): void {
	void bridgeReady()
		.then((bridge) => {
			const dispose = bridge.onState(callback);
			if (dispose) window.addEventListener("pagehide", dispose, { once: true });
		})
		.catch(reportError);
}
/**
 * 面板视图里的改动（书签 / 设置 / 扩展）由宿主转发过来。
 * 面板现在开在自己的视图里，`window` 事件跨不过去，所以外壳与内部标签页都得用这条路刷新。
 */
export function listenPanelEvents(callback: (name: BrowserPanelEvent) => void): void {
	void bridgeReady()
		.then((bridge) => {
			const dispose = bridge.onPanelEvent?.(callback);
			if (dispose) window.addEventListener("pagehide", dispose, { once: true });
		})
		.catch(reportError);
}
export const brand = (): HTMLElement => element("span", "pb-brand", "π");
