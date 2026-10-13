/**
 * 插件自定义页宿主（宿主 UI 扩展点的 `settings.pages` 槽位渲染层）。
 *
 * 与 PluginView 的关系：**同一套窄通道，不同的生命周期**。
 *   - PluginView（顶栏视图 tab）：切走时 `display:none` 保状态，插件被移除才卸载。
 *   - PluginPage（设置面板里的一整页）：随选中项挂载/卸载，切走即调 cleanup —— 设置页
 *     是「一次性看完就走」的场景，留在 DOM 里既占内存又会一直跑插件的定时器。
 *
 * 为什么自己再 import 一次 bundle（而不是只等 ensurePluginViewLoaded）：
 *   `ensurePluginViewLoaded` 把视图登记进 plugin-loader 的模块级注册表（epoch 切换统一
 *   丢弃、坏 bundle 不无限重试），但**不返回模块本身**；这里需要 `default.mount` 才能挂载。
 *   两次 import 的 URL 完全相同 → 命中 ESM 模块缓存，不会二次下载，只是拿到同一个模块对象。
 *   import 同样用 `withPluginScopeAsync` 包住：插件 bundle 顶层若调 `host.onUiAction` 等
 *   注册接口，才能绑到它自己名下（与 loader 内部口径一致）。
 *
 * React 与插件 DOM 的边界：容器 div（`.plugin-page-host`）的子节点**永远只由插件写**，
 * React 一个子节点都不往里渲染 —— 混着来会在 React 插入/删除自己的节点时踩到插件塞进去
 * 的元素。失败提示因此是**兄弟节点**（`.plugin-page-error`），不是容器的子节点。
 */
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { ensurePluginViewLoaded, makePluginContext, pluginEntryUrl, type PluginViewModule } from "../plugin-loader";
import { withPluginScopeAsync } from "../plugin-host";
import { isZhLocale, useI18n, useT, type Translate } from "../i18n";
import type { UiPluginInfo } from "../types";

interface PluginPageProps {
	/** 贡献这个页的插件。 */
	plugin: UiPluginInfo;
	/** 服务端重载纪元（作为 bundle URL 的 ?e= 缓存击穿参数）。 */
	epoch: number;
	/** 上行一条 plugin_message 给插件服务端（App 注入；与 PluginView 的 ctx.send 同形）。 */
	send: (msg: { type: "plugin_message"; pluginId: string; payload: unknown }) => void;
	className?: string;
}

/**
 * 页面级失败原因。存**结构化数据**而不是成品文案：语言切换时在渲染期重算即可，
 * 不必为了换一句提示把插件重挂一遍。
 */
type PageFailure =
	/** 插件压根没带 client/entry.mjs（`hasClient=false`）。 */
	| { kind: "no-client" }
	/** bundle 拿不到 / 解析失败 / 没有 default.mount。 */
	| { kind: "load"; detail: string }
	/** bundle 拿到了、mount() 自己抛错（插件的 bug）。 */
	| { kind: "mount"; detail: string };

/** 错误对象 → 可显示的一行文本（非 Error 的抛出值也要能显示）。 */
function failureDetail(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

/**
 * 失败文案：宿主 i18n 里已有 `pluginMountFailed`（挂载失败）就直接复用，其余情况
 * **没有对应 key**（也不打算为一个宿主内部兜底提示去动 i18n 表）——中文界面写中文、
 * 其它语言回落英文，与「缺表回落英文」的 i18n 语义保持一致。
 */
function failureText(failure: PageFailure, name: string, locale: string, t: Translate): string {
	const zh = isZhLocale(locale);
	switch (failure.kind) {
		case "no-client":
			return zh
				? `插件 ${name} 没有客户端脚本（client/entry.mjs），无法显示这一页。`
				: `Plugin ${name} ships no client bundle (client/entry.mjs), so this page cannot be shown.`;
		case "load":
			return zh
				? `插件 ${name} 的页面脚本加载失败：${failure.detail}`
				: `Failed to load plugin ${name}'s page bundle: ${failure.detail}`;
		case "mount":
			// zh: 插件 {name} 挂载失败 / en: Plugin {name} failed to mount —— 后面补上底层错误。
			return `${t("pluginMountFailed", { name })}：${failure.detail}`;
	}
}

export function PluginPage({ plugin, epoch, send, className }: PluginPageProps): JSX.Element {
	const ref = useRef<HTMLDivElement>(null);
	const { locale } = useI18n();
	const t = useT();
	const [failure, setFailure] = useState<PageFailure | null>(null);

	/**
	 * send 由 App 注入，可能是每次渲染都新建的内联箭头函数。若把它挂进 effect 依赖，
	 * 快照（60ms 节流）每推一次就可能让插件**重挂一次** —— 所以只存最新引用，effect
	 * 只认「插件身份 + 纪元」这两个真正的重挂条件。
	 */
	const sendRef = useRef(send);
	useEffect(() => {
		sendRef.current = send;
	}, [send]);

	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		/** 卸载/换插件/换纪元后 import 才 resolve 的竞态：直接放弃挂载，不留野 DOM。 */
		let disposed = false;
		let cleanup: void | (() => void);
		/** 区分「加载阶段抛错」与「mount() 自己抛错」——两者对用户的含义完全不同。 */
		let mounting = false;
		setFailure(null);

		if (!plugin.hasClient) {
			setFailure({ kind: "no-client" });
			return;
		}

		void (async () => {
			try {
				// 先登记进 loader 注册表：失败会被记下（同一 epoch 不再重试），服务端重载
				// （epoch 变）时统一清空重拉。返回值是「注册表里有没有」，这里不需要——
				// 真正的判断在下面的 import 上（hasClient 为真但文件缺失时它才会报错）。
				await ensurePluginViewLoaded(plugin, epoch);
				if (disposed) return;
				// @vite-ignore：URL 运行时才知道；?e=<epoch> 是缓存击穿；appUrl 补应用根前缀
				// （nginx 子路径反代下必须是 /pi/plugins/... 才被转发规则命中）。
				// 重试盐在 loader 里：求值失败的模块会被 ESM 模块表记住，同一 URL 重导照挂。
				const mod = (await withPluginScopeAsync(
					plugin.id,
					() => import(/* @vite-ignore */ pluginEntryUrl(plugin.id, epoch)),
				)) as { default?: PluginViewModule };
				if (disposed) return;
				const m = mod.default;
				if (!m || typeof m.mount !== "function") {
					throw new Error("client/entry.mjs 没有导出 default.mount()");
				}
				mounting = true;
				cleanup = m.mount(
					el,
					makePluginContext(plugin.id, (msg) => sendRef.current(msg)),
				);
			} catch (err) {
				if (disposed) return;
				console.error(`[plugin:${plugin.id}] 页面${mounting ? "挂载" : "加载"}失败:`, err);
				setFailure({ kind: mounting ? "mount" : "load", detail: failureDetail(err) });
			}
		})();

		return () => {
			disposed = true;
			if (typeof cleanup === "function") {
				try {
					cleanup();
				} catch (err) {
					// 插件 cleanup 抛错不该拖垮宿主：只记日志（与 PluginView 同口径）。
					console.error(`[plugin:${plugin.id}] cleanup 失败:`, err);
				}
			}
			// 容器归宿主管：下次 mount 前清干净，避免残留节点闪一下旧界面。
			el.textContent = "";
		};
		// 依赖故意只取身份与纪元：plugin 对象来自快照，每次推送都可能是新对象，
		// 按对象身份做依赖会让插件被反复重挂（见上面 sendRef 的说明）。
	}, [plugin.id, plugin.hasClient, epoch]);

	const cls = className ? `plugin-page ${className}` : "plugin-page";
	return (
		<div className={cls}>
			{/* 插件画布：子节点只由插件写，React 不往里渲染任何东西。 */}
			<div className="plugin-page-host" ref={ref} />
			{failure && (
				<div className="plugin-page-error" role="alert">
					{failureText(failure, plugin.name, locale, t)}
				</div>
			)}
		</div>
	);
}
