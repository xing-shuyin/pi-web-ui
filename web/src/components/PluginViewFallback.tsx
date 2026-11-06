import { useState } from "react";
import type { JSX } from "react";
import { retryPluginViewLoad } from "../plugin-loader";
import { useT } from "../i18n";
import type { UiPluginInfo } from "../types";

interface PluginViewFallbackProps {
	pluginId: string;
	info?: UiPluginInfo;
	epoch: number;
	failed: boolean;
}

export function PluginViewFallback({ pluginId, info, epoch, failed }: PluginViewFallbackProps): JSX.Element {
	const t = useT();
	const [retrying, setRetrying] = useState(false);
	const name = info?.name || pluginId;
	if (!failed) {
		return (
			<div className="view-pane">
				<div className="plugin-view-fallback" role="status">
					{t("pluginViewLoading")}
				</div>
			</div>
		);
	}
	const onRetry = () => {
		if (!info || retrying) return;
		setRetrying(true);
		void retryPluginViewLoad(info, epoch).finally(() => setRetrying(false));
	};
	return (
		<div className="view-pane">
			<div className="plugin-view-fallback" role="alert">
				<div className="plugin-view-fallback-title">
					{t("pluginViewLoadFailed")}：{name}
				</div>
				<div className="plugin-view-fallback-hint">{t("pluginViewLoadFailedHint")}</div>
				{info && (
					<button type="button" className="plugin-view-fallback-retry" onClick={onRetry} disabled={retrying}>
						{retrying ? t("pluginViewLoading") : t("pluginViewRetry")}
					</button>
				)}
			</div>
		</div>
	);
}
