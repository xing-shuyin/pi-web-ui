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
import { useI18n, useT, type Translate } from "../i18n";
import type { UiPluginInfo } from "../types";
import { pluginDisplayName } from "../plugin-name";

interface PluginPageProps {
	plugin: UiPluginInfo;
	epoch: number;
	send: (msg: { type: "plugin_message"; pluginId: string; payload: unknown }) => void;
	/** 要渲染的插件页 id（`ui.settings[].id`）；不给就是通用「插件页」（ctx.page === undefined） */
	pageId?: string;
	className?: string;
}

type PageFailure = { kind: "no-client" } | { kind: "load"; detail: string } | { kind: "mount"; detail: string };

// The thrown error and console.error lines below are developer diagnostics (data); only the panel
// text a user sees goes through the dictionary.

function failureDetail(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

function failureText(failure: PageFailure, name: string, t: Translate): string {
	switch (failure.kind) {
		case "no-client":
			return t("pluginPageNoClient", { name });
		case "load":
			return t("pluginPageLoadFailed", { name, detail: failure.detail });
		case "mount":
			return t("pluginPageMountFailed", { name, detail: failure.detail });
	}
}

export function PluginPage({ plugin, epoch, send, pageId, className }: PluginPageProps): JSX.Element {
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
					makePluginContext(plugin.id, (msg) => sendRef.current(msg), pageId ? { page: pageId } : undefined),
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
	}, [plugin.id, plugin.hasClient, epoch, pageId]);

	const cls = className ? `plugin-page ${className}` : "plugin-page";
	return (
		<div className={cls}>
			<div className="plugin-page-host" ref={ref} />
			{failure && (
				<div className="plugin-page-error" role="alert">
					{failureText(failure, pluginDisplayName(plugin, locale), t)}
				</div>
			)}
		</div>
	);
}
