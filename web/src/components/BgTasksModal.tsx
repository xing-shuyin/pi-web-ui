import { useEffect, useMemo, useState } from "react";
import { FiLayers, FiPlay, FiRefreshCw, FiSquare, FiX } from "react-icons/fi";
import type { BgServer, UiPluginInfo } from "../types";
import { useI18n, useT } from "../i18n";
import { appSend } from "../app-globals";
import { buildUiSlots, withPluginViewItems, type UiSlotEntry } from "../ui-slots";
import { Modal } from "./Modal";
import { PluginPage } from "./PluginPage";

interface BgTasksModalProps {
	servers: BgServer[];
	projectScripts?: { cwd: string; scripts: Record<string, string> } | null;
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
	projectScripts,
	onClose,
	plugins = [],
	epoch = 0,
	send,
	onUiAction,
	autoCleanupMin = 0,
}: BgTasksModalProps) {
	const t = useT();
	const { locale } = useI18n();

	useEffect(() => {
		appSend({ type: "list_bg_servers" });
		appSend({ type: "project_scripts" });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const jobs = useMemo(() => servers.filter((s) => (s.kind ?? (s.taskId ? "plugin" : "port")) === "job"), [servers]);
	const runningScripts = useMemo(() => {
		const set = new Set<string>();
		for (const j of jobs) {
			const m = /npm run ([A-Za-z0-9 _.:-]+)/.exec(j.command ?? "");
			if (m) set.add(m[1]);
		}
		return set;
	}, [jobs]);
	const scriptEntries = useMemo(() => Object.entries(projectScripts?.scripts ?? {}), [projectScripts]);

	const pluginPanels = useMemo(() => {
		const slots = buildUiSlots(withPluginViewItems(plugins), {
			locale,
			t: (key: string) => t(key as Parameters<typeof t>[0]),
		});
		return (slots["tasks.panel"] ?? []).filter((e) => !e.hidden && e.source !== "host" && e.kind !== "divider");
	}, [plugins, locale, t]);

	const [stopping, setStopping] = useState<Set<string>>(new Set());
	const stopServer = (s: BgServer) => {
		const key = s.taskId ?? String(s.port);
		setStopping((prev) => new Set(prev).add(key));
		const kind = s.kind ?? (s.taskId ? "plugin" : "port");
		if (kind === "plugin" || kind === "job") appSend({ type: "kill_background_server", taskId: s.taskId });
		else appSend({ type: "kill_background_server", port: s.port });
		// 后端杀进程是异步的（等 taskkill + close），立即重刷一次 + 延迟再刷一次，
		// 否则列表不变，看着像“点击停止无效”。
		appSend({ type: "list_bg_servers" });
		setTimeout(() => appSend({ type: "list_bg_servers" }), 1500);
		setTimeout(() => appSend({ type: "list_bg_servers" }), 4000);
		// 8 秒后还没消失（杀失败）就恢复按钮，让用户能再点一次
		setTimeout(() => {
			setStopping((prev) => {
				const next = new Set(prev);
				next.delete(key);
				return next;
			});
		}, 8000);
	};

	return (
		<Modal className="bg-task-modal bg-task-modal-a" onClose={onClose} showCloseButton={false}>
			<div className="bg-task-head">
				<div className="bg-task-title">
					<FiLayers aria-hidden />
					<span>{t("bgTasks")}</span>
					{servers.length > 0 && <em className="bg-task-count">{servers.length} 运行</em>}
				</div>
				<div className="bg-task-head-actions">
					<button
						type="button"
						className="bg-task-icon-btn"
						title={t("bgTaskRefresh")}
						onClick={() => {
							appSend({ type: "list_bg_servers" });
							appSend({ type: "project_scripts" });
						}}
					>
						<FiRefreshCw />
					</button>
					<button type="button" className="bg-task-icon-btn" title={t("close")} onClick={onClose}>
						<FiX />
					</button>
				</div>
			</div>

			<div className="bg-task-body">
				{servers.length === 0 && scriptEntries.length === 0 ? (
					<div className="bg-task-empty">
						<FiLayers />
						<span>{t("bgTasksEmpty")}</span>
						<small>{t("bgTasksDesc")}</small>
					</div>
				) : null}

				{servers.length > 0 && (
					<div className="bg-task-running">
						{servers.map((s) => {
							const kind = s.kind ?? (s.taskId ? "plugin" : "port");
							const isPlugin = kind === "plugin";
							const isJob = kind === "job";
							const key = s.taskId ?? String(s.port);
							const label = isPlugin ? s.plugin : isJob ? s.name || t("bgTaskJobKind") : `:${s.port}`;
							const meta = [
								s.name && !isJob ? s.name : null,
								isPlugin && s.status ? s.status : null,
								t("bgTaskSince") + " " + formatSince(s.since, t),
								!isPlugin && s.pid ? `${t("bgTaskPid")} ${s.pid}` : null,
							]
								.filter(Boolean)
								.join(" · ");
							return (
								<div key={key} className="bg-task-run-card" title={s.command || undefined}>
									<span className="bg-task-dot" aria-hidden />
									<div className="bg-task-run-main">
										<div className="bg-task-run-name">{label}</div>
										<div className="bg-task-run-sub">{meta}</div>
									</div>
									<div className="bg-task-run-actions">
										{kind === "port" && (
											<button
												type="button"
												className={`bg-task-icon-btn ${s.keep ? "active" : ""}`}
												title={s.keep ? t("bgTaskKeepOn") : t("bgTaskKeep")}
												aria-pressed={!!s.keep}
												onClick={() => appSend({ type: "set_bg_keep", port: s.port ?? 0, keep: !s.keep })}
											>
												📌
											</button>
										)}
										{isJob && (
											<button
												type="button"
												className="bg-task-icon-btn"
												title={t("bgTaskRestart")}
												onClick={() => appSend({ type: "restart_bg_job", taskId: s.taskId ?? "" })}
											>
												<FiRefreshCw />
											</button>
										)}
										<button
											type="button"
											className="btn bg-task-btn danger sm"
											disabled={stopping.has(s.taskId ?? String(s.port))}
											onClick={() => stopServer(s)}
										>
											{stopping.has(s.taskId ?? String(s.port)) ? t("bgTaskStopping") : t("bgTaskStop")}
										</button>
									</div>
								</div>
							);
						})}
					</div>
				)}

				{scriptEntries.length > 0 && (
					<div className="bg-task-scripts">
						<div className="bg-task-kicker">
							<span>{t("bgTaskQuickStart")}</span>
							{projectScripts?.cwd ? (
								<span className="bg-task-cwd mono" title={projectScripts.cwd}>
									{projectScripts.cwd}
								</span>
							) : null}
						</div>
						<div className="bg-task-script-list">
							{scriptEntries.map(([name, cmd]) => {
								const running = runningScripts.has(name);
								return (
									<div key={name} className="bg-task-script-row" title={cmd}>
										<div className="bg-task-script-cmd mono">
											<span className="bg-task-npm">npm run </span>
											<span className="bg-task-script-name">{name}</span>
										</div>
										<button
											type="button"
											className={`btn bg-task-btn sm ${running ? "" : "primary"}`}
											disabled={running}
											onClick={() => appSend({ type: "start_bg_script", script: name })}
										>
											{running ? (
												t("bgTaskRunning")
											) : (
												<>
													<FiPlay aria-hidden /> {t("bgTaskStart")}
												</>
											)}
										</button>
									</div>
								);
							})}
						</div>
					</div>
				)}

				{pluginPanels.map((entry) => {
					const plugin = plugins.find((p) => p.id === entry.source.slice("plugin:".length));
					if (entry.kind === "view") {
						if (!plugin) return null;
						return (
							<div key={entry.id} className="bg-task-plugin-panel">
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
			</div>

			<div className="bg-task-foot">
				<label className="bg-task-cleanup" title={t("bgTaskCleanupHint")}>
					<span>{t("bgTaskCleanup")}</span>
					<select
						className="bg-task-select"
						value={String(autoCleanupMin)}
						onChange={(e) => appSend({ type: "set_settings", bgAutoCleanupMin: Number(e.target.value) })}
					>
						<option value="0">{t("bgTaskCleanupOff")}</option>
						{[15, 30, 60, 120].map((m) => (
							<option key={m} value={String(m)}>
								{t("bgTaskCleanupMinutes", { n: m })}
							</option>
						))}
					</select>
				</label>
				<span className="sp" />
				<button
					type="button"
					className="btn bg-task-btn ghost danger sm"
					disabled={servers.length === 0}
					title={t("bgTaskStopAll")}
					onClick={() => appSend({ type: "kill_background_servers" })}
				>
					<FiSquare aria-hidden /> {t("bgTaskStopAll")}
				</button>
			</div>
		</Modal>
	);
}
