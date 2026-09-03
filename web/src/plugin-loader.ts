/**
 * 插件视图加载器：把 <dataDir>/plugins/<id>/client/entry.mjs 动态加载进页面。
 *
 * 插件客户端模块的约定（ESM，默认导出）：
 *   export default {
 *     // 挂载到宿主给的 DOM 容器；返回清理函数（可选），切走/卸载时调用。
 *     mount(container: HTMLElement, ctx: PluginViewContext): void | (() => void)
 *   }
 *
 * 与主应用的通信只有两条窄通道（不共享 React 实例，插件可用任何技术栈）：
 *   ctx.send(payload)   → WS 上行 {type:"plugin_message", pluginId, payload}
 *   ctx.onData(cb)      ← WS 下行 plugin_data（按 pluginId 过滤后回调）
 *
 * plugin_data 的分发走 window CustomEvent（同主题切换的事件模式），
 * use-chat 收到消息后 emitPluginData，这里订阅并按插件扇出。
 */
import type { UiPluginInfo } from "./types";
import { appUrl } from "./base-url";

export interface PluginViewContext {
	pluginId: string;
	/** 上行一条消息给插件的服务端入口（index.mjs 的 onMessage 处理器）。 */
	send: (payload: unknown) => void;
	/** 订阅服务端广播；返回取消订阅函数。 */
	onData: (cb: (payload: unknown) => void) => () => void;
}

export interface PluginViewModule {
	mount(container: HTMLElement, ctx: PluginViewContext): void | (() => void);
}

export interface LoadedPluginView {
	info: UiPluginInfo;
	module: PluginViewModule;
}

const PLUGIN_DATA_EVENT = "pi-web-ui:plugin-data";

/** use-chat 调用：把服务端 plugin_data 消息转成分发事件。 */
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

// ---- 已加载视图注册表（模块级单例；React 只是通过订阅读它） -----------------

const loaded = new Map<string, LoadedPluginView>();
const listeners = new Set<(views: LoadedPluginView[]) => void>();
/** 加载失败的 id——同一 epoch 内不再重试（避免坏 bundle 无限刷错误）；
 *  目录清单变化/服务端重载（epoch 变）后自动清空，给修复后的插件重试机会。 */
const failed = new Set<string>();
/** 上次加载用的服务端重载纪元；变化时丢弃全部已加载视图（bundle URL 带 ?e=
 *  强制浏览器重新拉取）。 */
let lastEpoch = -1;

function snapshot(): LoadedPluginView[] {
	return [...loaded.values()];
}

function notify(): void {
	const snap = snapshot();
	for (const l of listeners) l(snap);
}

/** 订阅当前已加载的插件视图（立即回调一次当前快照）。 */
export function subscribeLoadedPluginViews(cb: (views: LoadedPluginView[]) => void): () => void {
	listeners.add(cb);
	cb(snapshot());
	return () => listeners.delete(cb);
}

/**
 * 把目录清单里应显示的插件同步到注册表：
 * - epoch 变化（服务端 plugins_reload）→ 丢弃全部旧 bundle，用 ?e= 重拉
 * - 清单中消失/被禁用的插件 → 移除已加载视图（React 随之卸载并调 cleanup）
 * - 新出现且未失败过的 → 动态 import
 */
export async function syncPluginViews(plugins: UiPluginInfo[], epoch: number): Promise<void> {
	if (epoch !== lastEpoch) {
		lastEpoch = epoch;
		loaded.clear();
		failed.clear();
	}
	// 清掉清单里不再存在的（被删目录 / 设置面板禁用 / 报错）——包括 failed 记录，
	// 让重新安装的同名插件可以再次尝试。
	const active = new Set(plugins.map((p) => p.id));
	// eslint-disable-next-line unicorn/no-useless-spread -- snapshot: handlers may unsubscribe mid-emit
	for (const id of [...loaded.keys()]) {
		if (!active.has(id)) loaded.delete(id);
	}
	// eslint-disable-next-line unicorn/no-useless-spread -- snapshot: handlers may unsubscribe mid-emit
	for (const id of [...failed]) {
		if (!active.has(id)) failed.delete(id);
	}
	await Promise.all(
		plugins
			.filter((p) => p.hasClient && !p.error && !loaded.has(p.id) && !failed.has(p.id))
			.map(async (p) => {
				try {
					// @vite-ignore：URL 运行时才知道，Vite 不要试图打包它。
					// ?e=<epoch> 作为缓存击穿参数：服务端 reload 后 URL 变化，
					// 浏览器才会真正重新执行改过的 bundle。
					// appUrl 补上应用根前缀：nginx 子路径反代（页面在 /pi/）时插件
					// bundle 必须请求 /pi/plugins/... 才能被转发规则命中。
					const mod = (await import(
						/* @vite-ignore */ appUrl(`/plugins/${encodeURIComponent(p.id)}/client/entry.mjs?e=${epoch}`)
					)) as { default?: PluginViewModule };
					const m = mod.default;
					if (m && typeof m.mount === "function") {
						loaded.set(p.id, { info: p, module: m });
					} else {
						failed.add(p.id);
						console.error(`[plugin:${p.id}] entry.mjs 缺少 default.mount`);
					}
				} catch (err) {
					failed.add(p.id);
					console.error(`[plugin:${p.id}] 客户端加载失败:`, err);
				}
			}),
	);
	notify();
}

/** 组装传给插件 mount() 的上下文（send 由 App 注入真正的 ws 发送函数）。 */
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
