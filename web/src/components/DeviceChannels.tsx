import { useEffect, useMemo, useState } from "react";
import { useT } from "../i18n";
import type { UiPluginInfo } from "../types";
import {
	loadPluginBundleModule,
	type LoadedPluginView,
	type PluginFileHandlerModule,
	type PluginViewModule,
} from "../plugin-loader";
import { PluginView } from "./PluginView";

function hasView(module: PluginFileHandlerModule | null): module is PluginViewModule {
	return !!module && "mount" in module && typeof module.mount === "function";
}

export function DeviceChannels({
	plugin,
	epoch,
	onManageGroups,
}: {
	plugin?: UiPluginInfo;
	epoch: number;
	onManageGroups(): void;
}) {
	const t = useT();
	const [entry, setEntry] = useState<LoadedPluginView | null>(null);
	const [failed, setFailed] = useState(false);
	const [attempt, setAttempt] = useState(0);
	const { id, name, version, hasClient, error, isolated } = plugin ?? {};
	const info = useMemo<UiPluginInfo | undefined>(
		() =>
			id
				? {
						id,
						name: name ?? id,
						version,
						hasClient: hasClient ?? false,
						error,
						isolated,
					}
				: undefined,
		[id, name, version, hasClient, error, isolated],
	);
	useEffect(() => {
		let cancelled = false;
		setEntry(null);
		setFailed(false);
		if (!info || info.error || !info.hasClient) return;
		void loadPluginBundleModule(info, epoch, { retry: attempt > 0 }).then((module) => {
			if (cancelled) return;
			if (hasView(module)) setEntry({ info, module });
			else setFailed(true);
		});
		return () => {
			cancelled = true;
		};
	}, [info, epoch, attempt]);
	const unavailable = !info || !info.hasClient;
	return (
		<section className="dc-card" aria-label={t("deviceChannelsLabel")}>
			<header className="dc-card-header">
				<div>
					<h2>{t("deviceChannelsTitle")}</h2>
					<p>{t("deviceChannelsDesc")}</p>
				</div>
				<button type="button" className="dc-button" onClick={onManageGroups}>
					{t("deviceChannelsManage")}
				</button>
			</header>
			{unavailable ? (
				<p role="status">{t("deviceChannelsUnavailable")}</p>
			) : info.error ? (
				<p className="dc-notice is-error" role="alert">
					{info.error}
				</p>
			) : failed ? (
				<div className="dc-notice is-error" role="alert">
					<span>{t("deviceChannelsLoadFailed")}</span>
					<button type="button" className="dc-button" onClick={() => setAttempt((value) => value + 1)}>
						{t("retryNow")}
					</button>
				</div>
			) : entry ? (
				<div
					style={{
						display: "flex",
						flexDirection: "column",
						minWidth: 0,
						height: "min(72vh, 900px)",
						minHeight: "360px",
					}}
				>
					<PluginView entry={entry} />
				</div>
			) : (
				<p role="status">{t("deviceChannelsLoading")}</p>
			)}
		</section>
	);
}
