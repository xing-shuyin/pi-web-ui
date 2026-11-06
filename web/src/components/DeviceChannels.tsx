import { useEffect, useMemo, useState } from "react";
import { isZhLocale, useLocale } from "../i18n";
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
	const zh = isZhLocale(useLocale());
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
		<section className="dc-card" aria-label={zh ? "外部渠道配置" : "External channel settings"}>
			<header className="dc-card-header">
				<div>
					<h2>{zh ? "GitHub / 飞书渠道" : "GitHub / Feishu channels"}</h2>
					<p>
						{zh
							? "将外部事件映射到群组，由群组 AI 分派任务并跟进工单。"
							: "Map external events to a group. Its AI delegates tasks and follows up on work items."}
					</p>
				</div>
				<button type="button" className="dc-button" onClick={onManageGroups}>
					{zh ? "管理群组与 AI" : "Manage groups & AI"}
				</button>
			</header>
			{unavailable ? (
				<p role="status">
					{zh
						? "内置渠道模块暂不可用，请重新加载页面或重启主程序。"
						: "The built-in channel module is temporarily unavailable. Reload this page or restart the application."}
				</p>
			) : info.error ? (
				<p className="dc-notice is-error" role="alert">
					{info.error}
				</p>
			) : failed ? (
				<div className="dc-notice is-error" role="alert">
					<span>{zh ? "渠道配置界面加载失败。" : "Channel settings failed to load."}</span>
					<button type="button" className="dc-button" onClick={() => setAttempt((value) => value + 1)}>
						{zh ? "重试" : "Retry"}
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
				<p role="status">{zh ? "正在加载渠道配置…" : "Loading channel settings…"}</p>
			)}
		</section>
	);
}
