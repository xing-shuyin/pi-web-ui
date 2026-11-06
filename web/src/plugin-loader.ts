import type { UiPluginInfo } from "./types";
import { appUrl } from "./base-url";
import { isMobileRuntime } from "./mobile-runtime";
import { withPluginScopeAsync } from "./plugin-host";
import { clearImageOcrProviders, syncImageOcrProviderOwners } from "./image-ocr-providers";

export interface PluginViewContext {
	pluginId: string;
	send: (payload: unknown) => void;
	onData: (cb: (payload: unknown) => void) => () => void;
}

export interface FenceRenderContext {
	pluginId: string;
	send: (payload: unknown) => void;
	onData: (cb: (payload: unknown) => void) => () => void;
}

export type FenceRenderer = (code: string, ctx: FenceRenderContext) => HTMLElement | null | Promise<HTMLElement | null>;

export interface PluginFile {
	path: string;
	name: string;
}

export interface PluginFileHandlerContext extends PluginViewContext {
	file: PluginFile;
	apiUrl: (path: string, params?: Record<string, string | number | boolean | undefined>) => string;
}

export interface PluginFileHandler {
	id?: string;
	mount(container: HTMLElement, file: PluginFile, ctx: PluginFileHandlerContext): void | (() => void);
}

export interface PluginFileHandlerModule {
	fileHandlers?: PluginFileHandler[] | Record<string, PluginFileHandler>;
}

export interface PluginViewModule extends PluginFileHandlerModule {
	mount(container: HTMLElement, ctx: PluginViewContext): void | (() => void);
	dispose?(): void;
	isolated?: boolean;
	shadow?: boolean;
	renderers?: Record<string, FenceRenderer>;
}

export interface LoadedPluginView {
	info: UiPluginInfo;
	module: PluginViewModule;
}

export function preparePluginMountContainer(
	hostEl: HTMLElement,
	options?: { isolated?: boolean },
): { container: HTMLElement; isShadow: boolean; cleanup: () => void } {
	if (!options?.isolated) {
		return {
			container: hostEl,
			isShadow: false,
			cleanup: () => {
				hostEl.replaceChildren();
			},
		};
	}

	let shadow = hostEl.shadowRoot;
	if (!shadow) {
		try {
			shadow = hostEl.attachShadow({ mode: "open" });
		} catch {
			shadow = hostEl.shadowRoot;
		}
	}
	if (!shadow) {
		return {
			container: hostEl,
			isShadow: false,
			cleanup: () => {
				hostEl.replaceChildren();
			},
		};
	}

	shadow.replaceChildren();
	const style = document.createElement("style");
	style.textContent = `
		:host {
			display: block;
			width: 100%;
			height: 100%;
			box-sizing: border-box;
			color: var(--text, inherit);
			font-family: inherit;
			font-size: var(--text-base, 13.5px);
			line-height: 1.5;
		}
		*, *::before, *::after {
			box-sizing: inherit;
		}
	`;
	shadow.appendChild(style);

	const root = document.createElement("div");
	root.className = "plugin-isolated-root";
	root.style.cssText = "width:100%;height:100%;display:flex;flex-direction:column;";
	shadow.appendChild(root);

	return {
		container: root,
		isShadow: true,
		cleanup: () => {
			root.replaceChildren();
			shadow?.replaceChildren();
		},
	};
}

const PLUGIN_DATA_EVENT = "pi-web-ui:plugin-data";

export function emitPluginData(pluginId: string, payload: unknown): void {
	window.dispatchEvent(new CustomEvent(PLUGIN_DATA_EVENT, { detail: { pluginId, payload } }));
}

function subscribeAll(cb: (pluginId: string, payload: unknown) => void): () => void {
	const handler = (e: Event) => {
		const d = (e as CustomEvent).detail as {
			pluginId: string;
			payload: unknown;
		};
		cb(d.pluginId, d.payload);
	};
	window.addEventListener(PLUGIN_DATA_EVENT, handler);
	return () => window.removeEventListener(PLUGIN_DATA_EVENT, handler);
}

const loaded = new Map<string, LoadedPluginView>();
const preloaded = new Map<string, (() => void) | undefined>();

function disposePreloaded(id: string): void {
	const dispose = preloaded.get(id);
	preloaded.delete(id);
	try {
		dispose?.();
	} catch (err) {
		console.error(`[plugin:${id}] preload cleanup failed:`, err);
	}
}
const listeners = new Set<(views: LoadedPluginView[]) => void>();
const failed = new Set<string>();
const failedListeners = new Set<(ids: string[]) => void>();
let lastEpoch = -1;
let activePluginIds: ReadonlySet<string> | null = null;

function snapshot(): LoadedPluginView[] {
	return [...loaded.values()];
}

function notify(): void {
	const snap = snapshot();
	for (const l of listeners) l(snap);
}

function notifyFailed(): void {
	const snap = [...failed];
	for (const l of failedListeners) l(snap);
}

export function subscribePluginLoadFailed(cb: (ids: string[]) => void): () => void {
	failedListeners.add(cb);
	cb([...failed]);
	return () => failedListeners.delete(cb);
}

export async function retryPluginViewLoad(p: UiPluginInfo, epoch: number): Promise<boolean> {
	failed.delete(p.id);
	retrySalt.set(p.id, (retrySalt.get(p.id) ?? 0) + 1);
	notifyFailed();
	const ok = await loadOne(p, epoch);
	notify();
	return ok;
}

export function subscribeLoadedPluginViews(cb: (views: LoadedPluginView[]) => void): () => void {
	listeners.add(cb);
	cb(snapshot());
	return () => listeners.delete(cb);
}

const retrySalt = new Map<string, number>();

export function pluginEntryUrl(pluginId: string, epoch: number): string {
	const salt = retrySalt.get(pluginId) ?? 0;
	return appUrl(`/plugins/${encodeURIComponent(pluginId)}/client/entry.mjs?e=${epoch}${salt > 0 ? `&r=${salt}` : ""}`);
}

export function createScopedImporter(importFn: (url: string) => Promise<unknown>) {
	let gate: Promise<unknown> = Promise.resolve();
	return (pluginId: string, url: string): Promise<unknown> => {
		if (isMobileRuntime()) return Promise.reject(new Error("Remote plugin clients are unavailable in the native app"));
		const run = gate.then(() => withPluginScopeAsync(pluginId, () => importFn(url)));
		gate = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	};
}

const importPluginBundle = createScopedImporter((url) => import(/* @vite-ignore */ url));

export async function loadPluginBundleModule(
	p: UiPluginInfo,
	epoch: number,
	options?: { retry?: boolean },
): Promise<PluginFileHandlerModule | null> {
	if (isMobileRuntime() || !p.hasClient || p.error) return null;
	if (options?.retry) retrySalt.set(p.id, (retrySalt.get(p.id) ?? 0) + 1);
	try {
		const mod = (await importPluginBundle(p.id, pluginEntryUrl(p.id, epoch))) as PluginFileHandlerModule & {
			default?: PluginFileHandlerModule;
		};
		const candidate = mod.default ?? mod;
		return {
			...candidate,
			fileHandlers: candidate.fileHandlers ?? mod.fileHandlers,
		};
	} catch (err) {
		console.error(`[plugin:${p.id}] 客户端 bundle 加载失败:`, err);
		return null;
	}
}

async function loadOne(p: UiPluginInfo, epoch: number): Promise<boolean> {
	if (isMobileRuntime()) return false;
	try {
		// @vite-ignore：URL 运行时才知道，Vite 不要试图打包它。
		const mod = (await importPluginBundle(p.id, pluginEntryUrl(p.id, epoch))) as {
			default?: PluginViewModule;
		};
		if ((lastEpoch !== -1 && epoch !== lastEpoch) || (activePluginIds && !activePluginIds.has(p.id))) {
			try {
				mod.default?.dispose?.();
			} catch (err) {
				console.error(`[plugin:${p.id}] stale bundle cleanup failed:`, err);
			}
			clearImageOcrProviders(p.id);
			return false;
		}
		const m = mod.default;
		if (m && typeof m.mount === "function") {
			loaded.set(p.id, { info: p, module: m });
			return true;
		}
		if (p.preload) {
			preloaded.set(p.id, typeof m?.dispose === "function" ? () => m.dispose?.() : undefined);
			return true;
		}
		clearImageOcrProviders(p.id);
		failed.add(p.id);
		notifyFailed();
		console.error(`[plugin:${p.id}] entry.mjs 缺少 default.mount`);
		return false;
	} catch (err) {
		clearImageOcrProviders(p.id);
		failed.add(p.id);
		notifyFailed();
		console.error(`[plugin:${p.id}] 客户端加载失败:`, err);
		return false;
	}
}

export async function ensurePluginViewLoaded(p: UiPluginInfo, epoch: number): Promise<boolean> {
	if (isMobileRuntime()) return false;
	if (loaded.has(p.id) || preloaded.has(p.id)) return true;
	if (failed.has(p.id) || !p.hasClient) return false;
	const ok = await loadOne(p, epoch);
	notify();
	return ok;
}

export async function syncPluginViews(plugins: UiPluginInfo[], epoch: number): Promise<void> {
	if (isMobileRuntime()) return;
	activePluginIds = new Set(plugins.filter((plugin) => !plugin.error).map((plugin) => plugin.id));
	syncImageOcrProviderOwners(activePluginIds);
	if (epoch !== lastEpoch) {
		lastEpoch = epoch;
		clearImageOcrProviders();
		loaded.clear();
		// eslint-disable-next-line unicorn/no-useless-spread -- snapshot: cleanup may change the registry
		for (const id of [...preloaded.keys()]) disposePreloaded(id);
		failed.clear();
		retrySalt.clear();
		notifyFailed();
	}
	const active = new Set(plugins.map((p) => p.id));
	// eslint-disable-next-line unicorn/no-useless-spread -- snapshot: handlers may unsubscribe mid-emit
	for (const id of [...loaded.keys()]) {
		if (!active.has(id) || plugins.find((p) => p.id === id)?.error) {
			clearImageOcrProviders(id);
			loaded.delete(id);
			retrySalt.set(id, (retrySalt.get(id) ?? 0) + 1);
		}
	}
	// eslint-disable-next-line unicorn/no-useless-spread -- snapshot: handlers may unsubscribe mid-emit
	for (const id of [...preloaded.keys()]) {
		if (!active.has(id) || plugins.find((p) => p.id === id)?.error) {
			clearImageOcrProviders(id);
			disposePreloaded(id);
			retrySalt.set(id, (retrySalt.get(id) ?? 0) + 1);
		}
	}
	// eslint-disable-next-line unicorn/no-useless-spread -- snapshot: handlers may unsubscribe mid-emit
	for (const id of [...failed]) {
		if (!active.has(id)) failed.delete(id);
	}
	notifyFailed();
	await Promise.all(
		plugins
			.filter(
				(p) =>
					p.hasClient &&
					(p.view !== false || p.preload) &&
					!p.error &&
					!loaded.has(p.id) &&
					!preloaded.has(p.id) &&
					!failed.has(p.id),
			)
			.map((p) => loadOne(p, epoch)),
	);
	notify();
}

export function makePluginContext(
	pluginId: string,
	send: (msg: { type: "plugin_message"; pluginId: string; payload: unknown }) => void,
): PluginViewContext {
	return {
		pluginId,
		send: (payload) => send({ type: "plugin_message", pluginId, payload }),
		onData: (cb) =>
			subscribeAll((pid, payload) => {
				if (pid === pluginId) cb(payload);
			}),
	};
}
