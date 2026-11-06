import type { UiPluginInfo } from "./types";
import type { FenceRenderContext, FenceRenderer, PluginViewModule } from "./plugin-loader";
import { appUrl } from "./base-url";
import { isMobileRuntime } from "./mobile-runtime";

const PLUGIN_DATA_EVENT = "pi-web-ui:plugin-data";

interface RendererEntry {
	pluginId: string;
	renderer: FenceRenderer;
}

let registry = new Map<string, string>();
let cache = new Map<string, RendererEntry>();
let failed = new Set<string>();
let lastEpoch = -1;

let registryVersion = 0;
const registryListeners = new Set<() => void>();
function notifyRegistry(): void {
	registryVersion++;
	for (const l of registryListeners) l();
}

export function subscribeFenceRegistry(cb: () => void): () => void {
	registryListeners.add(cb);
	return () => {
		registryListeners.delete(cb);
	};
}

export function getFenceRegistryVersion(): number {
	return registryVersion;
}

let wsSend: ((msg: { type: "plugin_message"; pluginId: string; payload: unknown }) => boolean) | null = null;

export function setFenceSend(
	send: (msg: { type: "plugin_message"; pluginId: string; payload: unknown }) => boolean,
): void {
	wsSend = send;
}

export function syncFenceRenderers(plugins: UiPluginInfo[], epoch: number): void {
	if (isMobileRuntime()) plugins = [];
	if (epoch !== lastEpoch) {
		lastEpoch = epoch;
		cache.clear();
		failed.clear();
	}
	const next = new Map<string, string>();
	for (const p of plugins) {
		if (p.error || !p.renderers) continue;
		for (const lang of p.renderers) {
			if (!next.has(lang)) next.set(lang, p.id);
		}
	}
	let changed = next.size !== registry.size;
	if (!changed) {
		for (const [k, v] of next) {
			if (registry.get(k) !== v) {
				changed = true;
				break;
			}
		}
	}
	if (!changed) return;
	for (const lang of cache.keys()) {
		if (!next.has(lang)) cache.delete(lang);
	}
	for (const lang of failed) {
		if (!next.has(lang)) failed.delete(lang);
	}
	registry = next;
	notifyRegistry();
}

export async function renderFence(lang: string, code: string): Promise<HTMLElement | null> {
	if (isMobileRuntime()) return null;
	const pluginId = registry.get(lang);
	if (!pluginId) return null;

	let entry = cache.get(lang);
	if (!entry && !failed.has(lang)) {
		try {
			// @vite-ignore：URL 运行时才知道。?e=<epoch> 缓存击穿。
			const mod = (await import(
				/* @vite-ignore */ appUrl(`/plugins/${encodeURIComponent(pluginId)}/client/entry.mjs?e=${lastEpoch}`)
			)) as { default?: PluginViewModule };
			const renderer = mod.default?.renderers?.[lang];
			if (typeof renderer === "function") {
				entry = { pluginId, renderer };
				cache.set(lang, entry);
			} else {
				failed.add(lang);
				console.error(`[plugin:${pluginId}] entry.mjs 未提供 renderers["${lang}"]`);
			}
		} catch (err) {
			failed.add(lang);
			console.error(`[plugin:${pluginId}] renderer 加载失败（${lang}）:`, err);
		}
	}
	if (!entry) return null;

	const ctx: FenceRenderContext = {
		pluginId: entry.pluginId,
		send: (payload) => {
			wsSend?.({ type: "plugin_message", pluginId: entry!.pluginId, payload });
		},
		onData: (cb) => {
			const handler = (e: Event) => {
				const d = (e as CustomEvent).detail as { pluginId?: unknown; payload?: unknown };
				if (d.pluginId === entry!.pluginId) cb(d.payload);
			};
			window.addEventListener(PLUGIN_DATA_EVENT, handler);
			return () => window.removeEventListener(PLUGIN_DATA_EVENT, handler);
		},
	};

	try {
		const result = await entry.renderer(code, ctx);
		return result instanceof HTMLElement ? result : null;
	} catch (err) {
		console.error(`[plugin:${entry.pluginId}] renderer("${lang}") 执行失败:`, err);
		return null;
	}
}

export function hasFenceRenderer(lang: string): boolean {
	return registry.has(lang);
}

export const widgetRegistry = new Map<string, string>();
const widgetCache = new Map<string, RendererEntry>();
const widgetFailed = new Set<string>();
let lastWidgetEpoch = -1;

export function syncMessageWidgets(plugins: UiPluginInfo[], epoch: number): void {
	if (isMobileRuntime()) plugins = [];
	if (epoch !== lastWidgetEpoch) {
		lastWidgetEpoch = epoch;
		widgetCache.clear();
		widgetFailed.clear();
	}
	const next = new Map<string, string>();
	for (const p of plugins) {
		if (p.error) continue;
		const types = (p as unknown as { messageWidgets?: unknown }).messageWidgets;
		if (!Array.isArray(types)) continue;
		for (const t of types) {
			if (typeof t !== "string" || !t) continue;
			if (!next.has(t)) next.set(t, p.id);
		}
	}
	for (const type of Array.from(widgetRegistry.keys())) {
		if (!next.has(type)) widgetRegistry.delete(type);
	}
	for (const [type, pluginId] of next) widgetRegistry.set(type, pluginId);
	for (const type of widgetCache.keys()) {
		if (!next.has(type)) widgetCache.delete(type);
	}
	for (const type of widgetFailed) {
		if (!next.has(type)) widgetFailed.delete(type);
	}
}

export function hasMessageWidget(type: string): boolean {
	return widgetRegistry.has(type);
}

export async function loadMessageWidget(type: string): Promise<FenceRenderer | null> {
	if (isMobileRuntime()) return null;
	const pluginId = widgetRegistry.get(type);
	if (!pluginId) return null;

	let entry = widgetCache.get(type);
	if (!entry && !widgetFailed.has(type)) {
		try {
			// @vite-ignore：URL 运行时才知道。?e=<epoch> 缓存击穿。
			const mod = (await import(
				/* @vite-ignore */ appUrl(`/plugins/${encodeURIComponent(pluginId)}/client/entry.mjs?e=${lastWidgetEpoch}`)
			)) as { default?: PluginViewModule & { messageWidgets?: Record<string, FenceRenderer> } };
			const renderer = mod.default?.messageWidgets?.[type];
			if (typeof renderer === "function") {
				entry = { pluginId, renderer };
				widgetCache.set(type, entry);
			} else {
				widgetFailed.add(type);
				console.error(`[plugin:${pluginId}] entry.mjs 未提供 messageWidgets["${type}"]`);
			}
		} catch (err) {
			widgetFailed.add(type);
			console.error(`[plugin:${pluginId}] messageWidget 加载失败（${type}）:`, err);
		}
	}
	return entry?.renderer ?? null;
}
