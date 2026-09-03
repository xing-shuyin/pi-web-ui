import { useEffect, useState } from "react";
import { FiLayers, FiRefreshCw, FiSquare, FiTerminal, FiX } from "react-icons/fi";
import type { BgServer, ClientMessage } from "../types";
import { useT } from "../i18n";

interface BgTasksModalProps {
	servers: BgServer[];
	send: (msg: ClientMessage) => boolean;
	onClose: () => void;
}

/** Relative time for a bg task's `since` stamp (ms epoch). */
function formatSince(since: number, t: ReturnType<typeof useT>): string {
	const ms = Math.max(0, Date.now() - since);
	const min = Math.floor(ms / 60_000);
	if (min < 1) return t("bgTaskJustNow");
	if (min < 60) return t("bgTaskMinutes", { n: min });
	const hr = Math.floor(min / 60);
	if (hr < 24) return t("bgTaskHours", { n: hr });
	return t("bgTaskDays", { n: Math.floor(hr / 24) });
}

/**
 * 后台任务面板 — the AI-started background servers (detected via listening-port
 * diffs around bash tool runs). Each task can be stopped individually, or all
 * at once. The list lives on the CLIENT (not a conversation), so it survives
 * conversation ends and reconnects — it only empties when tasks are stopped or
 * their processes exit on their own.
 */
export function BgTasksModal({ servers, send, onClose }: BgTasksModalProps) {
	const t = useT();
	// Which tasks have their command line expanded (default: one truncated line
	// + hover tooltip; click toggles full wrap so long commands stay readable).
	// 插件任务无 port——用 taskId 作展开键。
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const toggleCmd = (key: string) =>
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});

	// Ask the server for a fresh list (it prunes dead entries) on open.
	useEffect(() => {
		send({ type: "list_bg_servers" });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="bg-task-modal" onClick={(e) => e.stopPropagation()}>
				<div className="bg-task-head">
					<span className="bg-task-title">
						<FiLayers /> {t("bgTasks")}
						{servers.length > 0 && <em className="bg-task-count">{servers.length}</em>}
					</span>
					<button type="button" className="btn" title={t("close")} onClick={onClose}>
						<FiX />
					</button>
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
							// 插件任务（registerBackgroundTask）没有端口/pid——键与展示按 taskId。
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
									<button
										type="button"
										className="btn bg-task-stop"
										title={t("bgTaskStop")}
										onClick={() =>
											isPlugin
												? send({ type: "kill_background_server", taskId: s.taskId })
												: send({ type: "kill_background_server", port: s.port })
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

				<div className="bg-task-foot">
					<button
						type="button"
						className="btn"
						title={t("bgTaskRefresh")}
						onClick={() => send({ type: "list_bg_servers" })}
					>
						<FiRefreshCw />
						<span>{t("bgTaskRefresh")}</span>
					</button>
					<button
						type="button"
						className="btn bg-task-stopall"
						disabled={servers.length === 0}
						title={t("bgTaskStopAll")}
						onClick={() => send({ type: "kill_background_servers" })}
					>
						<FiSquare />
						<span>{t("bgTaskStopAll")}</span>
					</button>
				</div>
			</div>
		</div>
	);
}
