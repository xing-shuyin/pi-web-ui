import { useEffect, useRef } from "react";
import {
	makePluginContext,
	type LoadedPluginView,
} from "../plugin-loader";
import { useT } from "../i18n";

interface PluginViewProps {
	entry: LoadedPluginView;
	send: (msg: { type: "plugin_message"; pluginId: string; payload: unknown }) => boolean;
}

/**
 * 插件视图宿主：一个薄 React 壳，把 DOM 容器 + 窄上下文交给插件的
 * mount()。切走时容器整体 display:none（不卸载，插件内部状态保留）；
 * 插件被移除/失败时才真正清理。
 */
export function PluginView({ entry, send }: PluginViewProps) {
	const ref = useRef<HTMLDivElement>(null);
	const t = useT();
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		let cleanup: void | (() => void);
		try {
			cleanup = entry.module.mount(
				el,
				makePluginContext(entry.info.id, (msg) => send(msg)),
			);
		} catch (err) {
			console.error(`[plugin:${entry.info.id}] mount failed:`, err);
			el.textContent = t("pluginMountFailed", { name: entry.info.name });
		}
		return () => {
			if (typeof cleanup === "function") {
				try {
					cleanup();
				} catch (err) {
					console.error(`[plugin:${entry.info.id}] cleanup failed:`, err);
				}
			}
			el.textContent = "";
		};
	}, [entry, send]);
	return <div className="plugin-view" ref={ref} />;
}
