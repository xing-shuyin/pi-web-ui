import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import {
	ensurePluginViewLoaded,
	makePluginContext,
	pluginEntryUrl,
	preparePluginMountContainer,
	type PluginViewModule,
} from "../plugin-loader";
import { withPluginScopeAsync } from "../plugin-host";
import { isZhLocale, useI18n, useT, type Translate } from "../i18n";
import type { UiPluginInfo } from "../types";

interface PluginPageProps {
	plugin: UiPluginInfo;
	epoch: number;
	send: (msg: { type: "plugin_message"; pluginId: string; payload: unknown }) => void;
	className?: string;
}

type PageFailure = { kind: "no-client" } | { kind: "load"; detail: string } | { kind: "mount"; detail: string };

function failureDetail(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

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
			return `${t("pluginMountFailed", { name })}：${failure.detail}`;
	}
}

export function PluginPage({ plugin, epoch, send, className }: PluginPageProps): JSX.Element {
	const ref = useRef<HTMLDivElement>(null);
	const { locale } = useI18n();
	const t = useT();
	const [failure, setFailure] = useState<PageFailure | null>(null);

	const sendRef = useRef(send);
	useEffect(() => {
		sendRef.current = send;
	}, [send]);

	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		let disposed = false;
		let cleanup: void | (() => void);
		let mounting = false;
		setFailure(null);

		if (!plugin.hasClient) {
			setFailure({ kind: "no-client" });
			return;
		}

		void (async () => {
			try {
				await ensurePluginViewLoaded(plugin, epoch);
				if (disposed) return;
				// @vite-ignore：URL 运行时才知道；?e=<epoch> 是缓存击穿；appUrl 补应用根前缀
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
				const isIsolated = Boolean(plugin.isolated || m.isolated || m.shadow);
				const { container } = preparePluginMountContainer(el, { isolated: isIsolated });
				cleanup = m.mount(
					container,
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
					console.error(`[plugin:${plugin.id}] cleanup 失败:`, err);
				}
			}
			el.replaceChildren();
		};
	}, [plugin.id, plugin.hasClient, epoch]);

	const cls = className ? `plugin-page ${className}` : "plugin-page";
	return (
		<div className={cls}>
			<div className="plugin-page-host" ref={ref} />
			{failure && (
				<div className="plugin-page-error" role="alert">
					{failureText(failure, plugin.name, locale, t)}
				</div>
			)}
		</div>
	);
}
