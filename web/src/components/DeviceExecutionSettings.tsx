import { useState, useEffect, useCallback, useRef } from "react";
import { FiRefreshCw, FiAlertTriangle, FiCheck, FiX, FiClock, FiPlayCircle, FiShield } from "react-icons/fi";
import { appUrl } from "../base-url";
import { withToken } from "../auth-token";
import { useT } from "../i18n";
import type {
	DeviceExecutionSettings as SettingsType,
	DeviceTaskSchedulerSnapshot as SnapshotType,
	DeviceWaitingTaskSnapshot,
} from "../types.js";

interface Props {
	hubUrl?: string;
	deviceId?: string;
	onNotice?: (text: string) => void;
}

const DEFAULT_SETTINGS: SettingsType = {
	maxActiveTasks: 4,
	maxWaitingTasks: 32,
};

function normalizeSnapshot(raw: unknown): SnapshotType {
	const fallback: SnapshotType = {
		settings: { ...DEFAULT_SETTINGS },
		activeCount: 0,
		waitingCount: 0,
		blockedCount: 0,
		running: [],
		waiting: [],
		blocked: [],
	};

	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return fallback;
	}

	const d = raw as Record<string, unknown>;
	const rawSettings =
		d.settings && typeof d.settings === "object" && !Array.isArray(d.settings)
			? (d.settings as Record<string, unknown>)
			: {};

	const maxActive =
		typeof rawSettings.maxActiveTasks === "number" && Number.isFinite(rawSettings.maxActiveTasks)
			? Math.max(1, Math.min(16, rawSettings.maxActiveTasks))
			: DEFAULT_SETTINGS.maxActiveTasks;

	const maxWaiting =
		typeof rawSettings.maxWaitingTasks === "number" && Number.isFinite(rawSettings.maxWaitingTasks)
			? Math.max(0, Math.min(128, rawSettings.maxWaitingTasks))
			: DEFAULT_SETTINGS.maxWaitingTasks;

	const running = Array.isArray(d.running) ? d.running : [];
	const waiting = Array.isArray(d.waiting) ? d.waiting : [];
	const blocked = Array.isArray(d.blocked) ? d.blocked : [];

	return {
		settings: {
			maxActiveTasks: maxActive,
			maxWaitingTasks: maxWaiting,
		},
		activeCount: typeof d.activeCount === "number" ? d.activeCount : running.length,
		waitingCount: typeof d.waitingCount === "number" ? d.waitingCount : waiting.length,
		blockedCount: typeof d.blockedCount === "number" ? d.blockedCount : blocked.length,
		running,
		waiting,
		blocked,
	};
}

export function DeviceExecutionSettings({ hubUrl, deviceId, onNotice }: Props) {
	const t = useT();
	const [snapshot, setSnapshot] = useState<SnapshotType | null>(null);
	const [draftActive, setDraftActive] = useState<number>(DEFAULT_SETTINGS.maxActiveTasks);
	const [draftWaiting, setDraftWaiting] = useState<number>(DEFAULT_SETTINGS.maxWaitingTasks);
	const [loading, setLoading] = useState(false);
	const [saving, setSaving] = useState(false);
	const [cancellingId, setCancellingId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [successMsg, setSuccessMsg] = useState<string | null>(null);

	const alive = useRef(true);
	const generation = useRef(0);
	const controllers = useRef(new Set<AbortController>());
	const inFlightPoll = useRef(false);
	const initialSynced = useRef(false);

	const bindingKey = `${hubUrl ?? ""}:${deviceId ?? ""}`;

	const request = useCallback(async <T,>(path: string, body?: object, externalSignal?: AbortSignal): Promise<T> => {
		const controller = new AbortController();
		controllers.current.add(controller);
		const onExternalAbort = () => controller.abort();
		if (externalSignal) {
			if (externalSignal.aborted) controller.abort();
			else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
		}
		try {
			const response = await fetch(withToken(appUrl(`/api/device-center/${path}`)), {
				method: body ? "POST" : "GET",
				credentials: "same-origin",
				signal: controller.signal,
				headers: body ? { "Content-Type": "application/json" } : undefined,
				body: body ? JSON.stringify(body) : undefined,
			});
			const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
			if (!response.ok) {
				const msg = typeof data.error === "string" ? data.error : `HTTP ${response.status}`;
				throw new Error(msg);
			}
			return data as T;
		} finally {
			if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
			controllers.current.delete(controller);
		}
	}, []);

	const fetchQueue = useCallback(
		async (silent = false) => {
			if (!alive.current) return;
			if (inFlightPoll.current) return;
			inFlightPoll.current = true;
			const currentGen = generation.current;
			if (!silent) setLoading(true);
			try {
				const data = await request<unknown>("execution-queue");
				if (!alive.current || currentGen !== generation.current) return;
				const normalized = normalizeSnapshot(data);
				setSnapshot(normalized);
				setError(null);
				if (!initialSynced.current) {
					setDraftActive(normalized.settings.maxActiveTasks);
					setDraftWaiting(normalized.settings.maxWaitingTasks);
					initialSynced.current = true;
				}
			} catch (err) {
				if (!alive.current || currentGen !== generation.current) return;
				if ((err as Error).name !== "AbortError") {
					setError((err as Error).message);
				}
			} finally {
				inFlightPoll.current = false;
				if (alive.current && currentGen === generation.current && !silent) {
					setLoading(false);
				}
			}
		},
		[request],
	);

	// Reset state and cancel in-flight queries when target binding changes
	useEffect(() => {
		alive.current = true;
		generation.current++;
		for (const c of controllers.current) c.abort();
		controllers.current.clear();
		inFlightPoll.current = false;
		initialSynced.current = false;
		setSnapshot(null);
		setError(null);
		setSuccessMsg(null);

		void fetchQueue(false);

		const timer = setInterval(() => {
			void fetchQueue(true);
		}, 3000);

		return () => {
			alive.current = false;
			generation.current++;
			for (const c of controllers.current) c.abort();
			controllers.current.clear();
			clearInterval(timer);
		};
	}, [bindingKey, fetchQueue]);

	const handleSave = async (e: React.FormEvent) => {
		e.preventDefault();
		const currentGen = generation.current;
		setSaving(true);
		setError(null);
		setSuccessMsg(null);
		try {
			const res = await request<{ settings?: SettingsType }>("execution-settings", {
				maxActiveTasks: Number(draftActive),
				maxWaitingTasks: Number(draftWaiting),
			});
			if (!alive.current || currentGen !== generation.current) return;
			if (res?.settings) {
				setDraftActive(res.settings.maxActiveTasks ?? DEFAULT_SETTINGS.maxActiveTasks);
				setDraftWaiting(res.settings.maxWaitingTasks ?? DEFAULT_SETTINGS.maxWaitingTasks);
			}
			setSuccessMsg(t("deviceExecSavedNotice"));
			onNotice?.(t("deviceExecSavedNotice"));
			await fetchQueue(true);
		} catch (err) {
			if (!alive.current || currentGen !== generation.current) return;
			if ((err as Error).name !== "AbortError") {
				setError((err as Error).message);
			}
		} finally {
			if (alive.current && currentGen === generation.current) {
				setSaving(false);
			}
		}
	};

	const handleCancelTask = async (taskId: string, attemptId: string) => {
		const currentGen = generation.current;
		setCancellingId(taskId);
		setError(null);
		try {
			await request<{ cancelled: boolean }>("execution-queue/cancel", { taskId, attemptId });
			if (!alive.current || currentGen !== generation.current) return;
			onNotice?.(t("deviceExecTaskCancelled"));
			await fetchQueue(true);
		} catch (err) {
			if (!alive.current || currentGen !== generation.current) return;
			if ((err as Error).name !== "AbortError") {
				setError((err as Error).message);
			}
		} finally {
			if (alive.current && currentGen === generation.current) {
				setCancellingId(null);
			}
		}
	};

	const formatReason = (reason: string) => {
		switch (reason) {
			case "max_concurrency_reached":
				return t("deviceExecReasonMaxConcurrency");
			case "bot_busy":
				return t("deviceExecReasonBotBusy");
			case "workspace_conflict":
				return t("deviceExecReasonWorkspaceConflict");
			case "workspace_blocked":
				return t("deviceExecReasonWorkspaceBlocked");
			case "room_fairness_yield":
				return t("deviceExecReasonFairness");
			default:
				return reason;
		}
	};

	const currentMaxActive = snapshot?.settings?.maxActiveTasks ?? DEFAULT_SETTINGS.maxActiveTasks;
	const currentMaxWaiting = snapshot?.settings?.maxWaitingTasks ?? DEFAULT_SETTINGS.maxWaitingTasks;

	return (
		<div className="des-container">
			<div className="des-header">
				<div className="des-header-left">
					<h3 className="des-title">{t("deviceExecTitle")}</h3>
					<p className="des-subtitle">{t("deviceExecSubtitle")}</p>
				</div>
				<button
					type="button"
					className="des-refresh-btn"
					onClick={() => void fetchQueue(false)}
					disabled={loading}
					title={t("deviceExecRefresh")}
				>
					<FiRefreshCw className={loading ? "des-spin" : ""} />
				</button>
			</div>

			{error && (
				<div className="des-alert des-alert-error" role="alert">
					<FiAlertTriangle className="des-alert-icon" />
					<div className="des-alert-text">{error}</div>
					<button type="button" className="des-alert-close" onClick={() => setError(null)}>
						<FiX />
					</button>
				</div>
			)}

			{successMsg && (
				<div className="des-alert des-alert-success" role="status">
					<FiCheck className="des-alert-icon" />
					<div className="des-alert-text">{successMsg}</div>
					<button type="button" className="des-alert-close" onClick={() => setSuccessMsg(null)}>
						<FiX />
					</button>
				</div>
			)}

			{/* 状态统计卡片 */}
			<div className="des-stats-row">
				<div className="des-stat-card">
					<div className="des-stat-label">
						<FiPlayCircle className="des-stat-icon is-running" /> {t("deviceExecRunning")}
					</div>
					<div className="des-stat-value">
						{snapshot?.activeCount ?? 0} <span className="des-stat-sub">/ {currentMaxActive}</span>
					</div>
				</div>

				<div className="des-stat-card">
					<div className="des-stat-label">
						<FiClock className="des-stat-icon is-waiting" /> {t("deviceExecQueued")}
					</div>
					<div className="des-stat-value">
						{snapshot?.waitingCount ?? 0} <span className="des-stat-sub">/ {currentMaxWaiting}</span>
					</div>
				</div>

				<div className="des-stat-card">
					<div className="des-stat-label">
						<FiShield className="des-stat-icon is-blocked" /> {t("deviceExecBlocked")}
					</div>
					<div className={`des-stat-value${(snapshot?.blockedCount ?? 0) > 0 ? " is-warn" : ""}`}>
						{snapshot?.blockedCount ?? 0}
					</div>
				</div>
			</div>

			{/* 配置表单 */}
			<form className="des-form-card" onSubmit={(e) => void handleSave(e)}>
				<h4 className="des-form-title">{t("deviceExecQuotaTitle")}</h4>
				<div className="des-fields-row">
					<div className="des-field">
						<label htmlFor="des-max-active" className="des-label">
							{t("deviceExecMaxActive")}
						</label>
						<input
							id="des-max-active"
							type="number"
							min={1}
							max={16}
							className="des-input"
							value={draftActive}
							onChange={(e) => setDraftActive(parseInt(e.target.value, 10) || 1)}
							required
						/>
						<span className="des-hint">{t("deviceExecMaxActiveHint")}</span>
					</div>

					<div className="des-field">
						<label htmlFor="des-max-waiting" className="des-label">
							{t("deviceExecMaxWaiting")}
						</label>
						<input
							id="des-max-waiting"
							type="number"
							min={0}
							max={128}
							className="des-input"
							value={draftWaiting}
							onChange={(e) => setDraftWaiting(parseInt(e.target.value, 10) || 0)}
							required
						/>
						<span className="des-hint">{t("deviceExecMaxWaitingHint")}</span>
					</div>
				</div>

				<div className="des-form-actions">
					<button
						type="button"
						className="des-btn des-btn-secondary"
						disabled={saving}
						onClick={() => {
							setDraftActive(currentMaxActive);
							setDraftWaiting(currentMaxWaiting);
						}}
					>
						{t("deviceExecReset")}
					</button>
					<button type="submit" className="des-btn des-btn-primary" disabled={saving}>
						{saving ? t("deviceExecSaving") : t("deviceExecSave")}
					</button>
				</div>
			</form>

			{/* 隔离占槽警告 */}
			{snapshot && snapshot.blocked && snapshot.blocked.length > 0 && (
				<div className="des-section des-blocked-section">
					<h4 className="des-section-title is-danger">
						<FiAlertTriangle /> {t("deviceExecBlockedTitle")}
					</h4>
					<p className="des-section-desc">{t("deviceExecBlockedDesc")}</p>
					<div className="des-table-wrap">
						<table className="des-table">
							<thead>
								<tr>
									<th>Task ID</th>
									<th>Room ID</th>
									<th>Bot ID</th>
									<th>{t("deviceExecReason")}</th>
								</tr>
							</thead>
							<tbody>
								{snapshot.blocked.map((b) => (
									<tr key={`${b.taskId}-${b.attemptId}`} className="des-row-blocked">
										<td className="des-mono">{b.taskId.slice(0, 8)}...</td>
										<td>{b.roomId}</td>
										<td>{b.botId}</td>
										<td>
											<span className="des-badge is-danger">{b.reason}</span>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</div>
			)}

			{/* 正在运行的任务 */}
			<div className="des-section">
				<h4 className="des-section-title">
					<FiPlayCircle /> {t("deviceExecActiveTasks")} ({snapshot?.running?.length ?? 0})
				</h4>
				{snapshot && snapshot.running && snapshot.running.length > 0 ? (
					<div className="des-table-wrap">
						<table className="des-table">
							<thead>
								<tr>
									<th>Task ID</th>
									<th>Room ID</th>
									<th>Bot ID</th>
									<th>{t("deviceExecQueuedTime")}</th>
								</tr>
							</thead>
							<tbody>
								{snapshot.running.map((r) => (
									<tr key={`${r.taskId}-${r.attemptId}`}>
										<td className="des-mono" title={r.taskId}>
											{r.taskId.slice(0, 8)}...
										</td>
										<td>{r.roomId}</td>
										<td>{r.botId}</td>
										<td>{new Date(r.startedAt).toLocaleTimeString()}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				) : (
					<div className="des-empty">{t("deviceExecNoActive")}</div>
				)}
			</div>

			{/* 等待队列 */}
			<div className="des-section">
				<h4 className="des-section-title">
					<FiClock /> {t("deviceExecWaitingQueue")} ({snapshot?.waiting?.length ?? 0})
				</h4>
				{snapshot && snapshot.waiting && snapshot.waiting.length > 0 ? (
					<div className="des-table-wrap">
						<table className="des-table">
							<thead>
								<tr>
									<th>{t("deviceExecPosition")}</th>
									<th>Task ID</th>
									<th>Room ID</th>
									<th>Bot ID</th>
									<th>{t("deviceExecReason")}</th>
									<th>{t("deviceExecQueuedTime")}</th>
									<th>{t("deviceExecActions")}</th>
								</tr>
							</thead>
							<tbody>
								{snapshot.waiting.map((w: DeviceWaitingTaskSnapshot) => (
									<tr key={`${w.taskId}-${w.attemptId}`}>
										<td>
											<span className="des-pos-badge">#{w.queuePosition}</span>
										</td>
										<td className="des-mono" title={w.taskId}>
											{w.taskId.slice(0, 8)}...
										</td>
										<td>{w.roomId}</td>
										<td>{w.botId}</td>
										<td>
											<div className="des-reason-cell">
												<span className={`des-badge des-badge-${w.blockReason}`}>{formatReason(w.blockReason)}</span>
												<span className="des-reason-detail">{w.blockReasonDetail}</span>
											</div>
										</td>
										<td>{new Date(w.queuedAt).toLocaleTimeString()}</td>
										<td>
											<button
												type="button"
												className="des-btn des-btn-danger-sm"
												disabled={cancellingId === w.taskId}
												onClick={() => void handleCancelTask(w.taskId, w.attemptId)}
											>
												{cancellingId === w.taskId ? t("deviceExecCancelling") : t("deviceExecCancel")}
											</button>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				) : (
					<div className="des-empty">{t("deviceExecNoWaiting")}</div>
				)}
			</div>
		</div>
	);
}
