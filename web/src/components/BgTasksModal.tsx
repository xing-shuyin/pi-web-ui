import { useEffect, useMemo, useState } from "react";
import { FiLayers, FiRefreshCw, FiSquare, FiTerminal, FiTrash2, FiX } from "react-icons/fi";
import type { BgServer, UiPluginInfo } from "../types";
import { useI18n, useT } from "../i18n";
import { appSend } from "../app-globals";
import { buildUiSlots, withPluginViewItems, type UiSlotEntry } from "../ui-slots";
import { Modal } from "./Modal";
import { PluginPage } from "./PluginPage";

interface BgTasksModalProps {
	servers: BgServer[];
	onClose: () => void;
	plugins?: UiPluginInfo[];
	epoch?: number;
	send?: (msg: { type: "plugin_message"; pluginId: string; payload: unknown }) => void;
	onUiAction?: (item: UiSlotEntry) => void;
	autoCleanupMin?: number;
}

function formatSince(since: number, t: ReturnType<typeof useT>): string {
	const ms = Math.max(0, Date.now() - since);
	const min = Math.floor(ms / 60_000);
	if (min < 1) return t("bgTaskJustNow");
	if (min < 60) return t("bgTaskMinutes", { n: min });
	const hr = Math.floor(min / 60);
	if (hr < 24) return t("bgTaskHours", { n: hr });
	return t("bgTaskDays", { n: Math.floor(hr / 24) });
}

export function BgTasksModal({
	servers,
	onClose,
	plugins = [],
	epoch = 0,
	send,
	onUiAction,
	autoCleanupMin = 0,
}: BgTasksModalProps) {
	const t = useT();
	const { locale } = useI18n();
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const toggleCmd = (key: string) =>
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});

	useEffect(() => {
		appSend({ type: "list_bg_servers" });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const pluginPanels = useMemo(() => {
		const slots = buildUiSlots(withPluginViewItems(plugins), {
			locale,
			t: (key: string) => t(key as Parameters<typeof t>[0]),
		});
		return (slots["tasks.panel"] ?? []).filter((e) => !e.hidden && e.source !== "host" && e.kind !== "divider");
	}, [plugins, locale, t]);

	return (
		<Modal className="bg-task-modal" onClose={onClose} showCloseButton={false}>
			<div className="bg-task-head">
				<span className="bg-task-title">
					<FiLayers /> {t("bgTasks")}
					{servers.length > 0 && <em className="bg-task-count">{servers.length}</em>}
				</span>
				<div className="bg-task-head-actions">
					<button
						type="button"
						className="btn bg-task-head-btn"
						title={t("bgTaskRefresh")}
						onClick={() => appSend({ type: "list_bg_servers" })}
					>
						<FiRefreshCw />
					</button>
					<button type="button" className="btn bg-task-head-btn" title={t("close")} onClick={onClose}>
						<FiX />
					</button>
				</div>
			</div>

			{servers.length === 0 ? (
				<div className="bg-task-empty">
					<FiLayers />
					<span>{t("bgTasksEmpty")}</span>
					<small>{t("bgTasksDesc")}</small>
				</div>
			) : (
				<ul className="bg-task-list">
					{servers.map((s) => {
						const isPlugin = !!s.taskId;
						const key = s.taskId ?? String(s.port);
						return (
							<li key={key} className="bg-task-item">
								<span className="bg-task-icon" title={isPlugin ? s.plugin : t("bgTaskPort")} />
								<div className="bg-task-info">
									<div className="bg-task-line1">
										{isPlugin ? (
											<span className="bg-task-port" title={s.taskId}>
												🧩 {s.plugin}
											</span>
										) : (
											<span className="bg-task-port">:{s.port}</span>
										)}
										{s.name && <span className="bg-task-name">{s.name}</span>}
									</div>
									<div className="bg-task-line2">
										{!isPlugin && (
											<span>
												{t("bgTaskPid")} {s.pid}
											</span>
										)}
										<span>
											{t("bgTaskSince")} {formatSince(s.since, t)}
										</span>
										{isPlugin && s.status && <span className="bg-task-status">{s.status}</span>}
									</div>
									{s.command && (
										<button
											type="button"
											className={`bg-task-cmd ${expanded.has(key) ? "open" : ""}`}
											title={`${t("bgTaskCommand")}: ${s.command}`}
											onClick={() => toggleCmd(key)}
										>
											<FiTerminal />
											<code>{s.command}</code>
										</button>
									)}
								</div>
								{!isPlugin && (
									<button
										type="button"
										className="btn bg-task-keep"
										title={s.keep ? t("bgTaskKeepOn") : t("bgTaskKeep")}
										aria-pressed={!!s.keep}
										onClick={() => appSend({ type: "set_bg_keep", port: s.port ?? 0, keep: !s.keep })}
									>
										{s.keep ? "📌" : "📍"}
									</button>
								)}
								<button
									type="button"
									className="btn bg-task-stop"
									title={t("bgTaskStop")}
									onClick={() =>
										isPlugin
											? appSend({ type: "kill_background_server", taskId: s.taskId })
											: appSend({ type: "kill_background_server", port: s.port })
									}
								>
									<FiSquare />
									<span>{t("bgTaskStop")}</span>
								</button>
							</li>
						);
					})}
				</ul>
			)}

			{pluginPanels.map((entry) => {
				const plugin = plugins.find((p) => p.id === entry.source.slice("plugin:".length));
				if (entry.kind === "view") {
					if (!plugin) return null;
					return (
						<div key={entry.id}>
							<PluginPage plugin={plugin} epoch={epoch} send={send ?? (() => {})} />
						</div>
					);
				}
				return (
					<button
						key={entry.id}
						type="button"
						className="btn"
						title={entry.hint ?? entry.label}
						onClick={() => onUiAction?.(entry)}
					>
						{entry.label}
					</button>
				);
			})}

			<div className="bg-task-foot">
				<div className="bg-task-cleanup-bar">
					<label className="bg-task-cleanup-field" title={t("bgTaskCleanupHint")}>
						<span className="bg-task-cleanup-label">{t("bgTaskCleanup")}</span>
						<select
							className="bg-task-cleanup-select"
							value={String(autoCleanupMin)}
							onChange={(e) =>
								appSend({
									type: "set_settings",
									bgAutoCleanupMin: Number(e.target.value),
								})
							}
						>
							<option value="0">{t("bgTaskCleanupOff")}</option>
							{[15, 30, 60, 120].map((m) => (
								<option key={m} value={String(m)}>
									{t("bgTaskCleanupMinutes", { n: m })}
								</option>
							))}
						</select>
					</label>
					<button
						type="button"
						className="btn bg-task-clean-btn"
						title={t("bgTaskCleanNowHint")}
						onClick={() => appSend({ type: "clean_bg_leftovers" })}
					>
						<FiTrash2 />
						<span>{t("bgTaskCleanNow")}</span>
					</button>
				</div>
				<div className="bg-task-actions-bar">
					<button
						type="button"
						className="btn bg-task-refresh-btn"
						title={t("bgTaskRefresh")}
						onClick={() => appSend({ type: "list_bg_servers" })}
					>
						<FiRefreshCw />
						<span>{t("bgTaskRefresh")}</span>
					</button>
					<button
						type="button"
						className="btn bg-task-stopall"
						disabled={servers.length === 0}
						title={t("bgTaskStopAll")}
						onClick={() => appSend({ type: "kill_background_servers" })}
					>
						<FiSquare />
						<span>{t("bgTaskStopAll")}</span>
					</button>
				</div>
			</div>
		</Modal>
	);
}
