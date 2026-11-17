import { useEffect, useRef } from "react";
import { makePluginContext, preparePluginMountContainer, type LoadedPluginView } from "../plugin-loader";
import { useI18n } from "../i18n";
import { pluginDisplayName } from "../plugin-name";
import { appSend } from "../app-globals";

interface PluginViewProps {
	entry: LoadedPluginView;
}

export function PluginView({ entry }: PluginViewProps) {
	const ref = useRef<HTMLDivElement>(null);
	const { t, locale } = useI18n();
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const isIsolated = Boolean(entry.info.isolated || entry.module.isolated || entry.module.shadow);
		const { container, cleanup: containerCleanup } = preparePluginMountContainer(el, { isolated: isIsolated });
		let cleanup: void | (() => void);
		try {
			cleanup = entry.module.mount(
				container,
				makePluginContext(entry.info.id, (msg) => appSend(msg)),
			);
		} catch (err) {
			console.error(`[plugin:${entry.info.id}] mount failed:`, err);
			container.textContent = t("pluginMountFailed", { name: pluginDisplayName(entry.info, locale) });
		}
		return () => {
			if (typeof cleanup === "function") {
				try {
					cleanup();
				} catch (err) {
					console.error(`[plugin:${entry.info.id}] cleanup failed:`, err);
				}
			}
			containerCleanup();
		};
	}, [entry]);
	return <div className="plugin-view" ref={ref} />;
}
