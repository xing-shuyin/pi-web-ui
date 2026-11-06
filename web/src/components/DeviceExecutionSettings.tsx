import { useState, useEffect, useCallback, useRef } from "react";
import {
	FiRefreshCw,
	FiAlertTriangle,
	FiCheck,
	FiX,
	FiClock,
	FiPlayCircle,
	FiShield,
	FiCpu,
	FiShare2,
	FiMessageSquare,
	FiFolder,
	FiLock,
	FiRotateCcw,
} from "react-icons/fi";
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
	starvationThresholdMs: 8000,
	maxSkipsBeforeStarvation: 3,
	maxDispatchDepth: 8,
	maxDispatchBudget: 16,
	allowBotMentions: false,
	groupContextBytes: 262144,
	groupRetentionLimit: 2000,
	fileSyncMaxBytes: 104857600,
	fileSyncMaxFiles: 1000,
	fileSyncStagedBytes: 1073741824,
	resourceLockDefaultTtlMs: 1800000,
	blackboardMaxBytes: 262144,
	taskReportExcerptBytes: 131072,
	maxResourceLocksPerTask: 128,
	botMentionBudgetPerTurn: 3,
};

function clampNumber(val: unknown, min: number, max: number, fallback: number): number {
	if (typeof val === "number" && Number.isFinite(val)) {
		return Math.max(min, Math.min(max, Math.round(val)));
	}
	return fallback;
}

function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
	const units = ["B", "KiB", "MiB", "GiB"];
	let i = 0;
	let val = bytes;
	while (val >= 1024 && i < units.length - 1) {
		val /= 1024;
		i++;
	}
	return `${Number.isInteger(val) ? val : val.toFixed(1)} ${units[i]}`;
}

function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "0 ms";
	if (ms < 1000) return `${ms} ms`;
	if (ms < 60000) return `${Math.round(ms / 1000)} s`;
	return `${(ms / 60000).toFixed(1)} min`;
}

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

	const normalizedSettings: SettingsType = {
		maxActiveTasks: clampNumber(rawSettings.maxActiveTasks, 1, 64, DEFAULT_SETTINGS.maxActiveTasks),
		maxWaitingTasks: clampNumber(rawSettings.maxWaitingTasks, 0, 1024, DEFAULT_SETTINGS.maxWaitingTasks),
		starvationThresholdMs: clampNumber(
			rawSettings.starvationThresholdMs,
			1000,
			60000,
			DEFAULT_SETTINGS.starvationThresholdMs,
		),
		maxSkipsBeforeStarvation: clampNumber(
			rawSettings.maxSkipsBeforeStarvation,
			1,
			20,
			DEFAULT_SETTINGS.maxSkipsBeforeStarvation,
		),
		maxDispatchDepth: clampNumber(rawSettings.maxDispatchDepth, 1, 64, DEFAULT_SETTINGS.maxDispatchDepth),
		maxDispatchBudget: clampNumber(rawSettings.maxDispatchBudget, 1, 256, DEFAULT_SETTINGS.maxDispatchBudget),
		allowBotMentions:
			typeof rawSettings.allowBotMentions === "boolean"
				? rawSettings.allowBotMentions
				: DEFAULT_SETTINGS.allowBotMentions,
		groupContextBytes: clampNumber(rawSettings.groupContextBytes, 4096, 2097152, DEFAULT_SETTINGS.groupContextBytes),
		groupRetentionLimit: clampNumber(rawSettings.groupRetentionLimit, 50, 20000, DEFAULT_SETTINGS.groupRetentionLimit),
		fileSyncMaxBytes: clampNumber(
			rawSettings.fileSyncMaxBytes,
			1048576,
			10737418240,
			DEFAULT_SETTINGS.fileSyncMaxBytes,
		),
		fileSyncMaxFiles: clampNumber(rawSettings.fileSyncMaxFiles, 10, 10000, DEFAULT_SETTINGS.fileSyncMaxFiles),
		fileSyncStagedBytes: clampNumber(
			rawSettings.fileSyncStagedBytes,
			4194304,
			53687091200,
			DEFAULT_SETTINGS.fileSyncStagedBytes,
		),
		resourceLockDefaultTtlMs: clampNumber(
			rawSettings.resourceLockDefaultTtlMs,
			60000,
			86400000,
			DEFAULT_SETTINGS.resourceLockDefaultTtlMs,
		),
		blackboardMaxBytes: clampNumber(rawSettings.blackboardMaxBytes, 4096, 4194304, DEFAULT_SETTINGS.blackboardMaxBytes),
		...(typeof rawSettings.taskReportExcerptBytes === "number"
			? { taskReportExcerptBytes: rawSettings.taskReportExcerptBytes }
			: {}),
		...(typeof rawSettings.maxResourceLocksPerTask === "number"
			? { maxResourceLocksPerTask: rawSettings.maxResourceLocksPerTask }
			: {}),
		...(typeof rawSettings.botMentionBudgetPerTurn === "number"
			? { botMentionBudgetPerTurn: rawSettings.botMentionBudgetPerTurn }
			: {}),
	};

	const running = Array.isArray(d.running) ? (d.running as SnapshotType["running"]) : [];
	const waiting = Array.isArray(d.waiting) ? (d.waiting as SnapshotType["waiting"]) : [];
	const blocked = Array.isArray(d.blocked) ? (d.blocked as SnapshotType["blocked"]) : [];

	return {
		settings: normalizedSettings,
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
	const [draft, setDraft] = useState<SettingsType>(DEFAULT_SETTINGS);
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
					setDraft({ ...normalized.settings });
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

	useEffect(() => {
		alive.current = true;
		generation.current++;
		for (const c of controllers.current) c.abort();
		controllers.current.clear();
		inFlightPoll.current = false;
		initialSynced.current = false;
		setSnapshot(null);
		setDraft({ ...DEFAULT_SETTINGS });
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

	const updateNumberField = (key: keyof Omit<SettingsType, "allowBotMentions">, value: number) => {
		setDraft((prev) => ({ ...prev, [key]: value }));
	};

	const updateBoolField = (key: "allowBotMentions", value: boolean) => {
		setDraft((prev) => ({ ...prev, [key]: value }));
	};

	const handleResetDefaults = () => {
		setDraft({ ...DEFAULT_SETTINGS });
	};

	const handleDiscardChanges = () => {
		if (snapshot?.settings) {
			setDraft({ ...snapshot.settings });
		} else {
			setDraft({ ...DEFAULT_SETTINGS });
		}
	};

	const handleSave = async (e: React.FormEvent) => {
		e.preventDefault();
		const currentGen = generation.current;
		setSaving(true);
		setError(null);
		setSuccessMsg(null);

		const payload: SettingsType = {
			maxActiveTasks: clampNumber(draft.maxActiveTasks, 1, 64, DEFAULT_SETTINGS.maxActiveTasks),
			maxWaitingTasks: clampNumber(draft.maxWaitingTasks, 0, 1024, DEFAULT_SETTINGS.maxWaitingTasks),
			starvationThresholdMs: clampNumber(
				draft.starvationThresholdMs,
				1000,
				60000,
				DEFAULT_SETTINGS.starvationThresholdMs,
			),
			maxSkipsBeforeStarvation: clampNumber(
				draft.maxSkipsBeforeStarvation,
				1,
				20,
				DEFAULT_SETTINGS.maxSkipsBeforeStarvation,
			),
			maxDispatchDepth: clampNumber(draft.maxDispatchDepth, 1, 64, DEFAULT_SETTINGS.maxDispatchDepth),
			maxDispatchBudget: clampNumber(draft.maxDispatchBudget, 1, 256, DEFAULT_SETTINGS.maxDispatchBudget),
			allowBotMentions: Boolean(draft.allowBotMentions),
			groupContextBytes: clampNumber(draft.groupContextBytes, 4096, 2097152, DEFAULT_SETTINGS.groupContextBytes),
			groupRetentionLimit: clampNumber(draft.groupRetentionLimit, 50, 20000, DEFAULT_SETTINGS.groupRetentionLimit),
			fileSyncMaxBytes: clampNumber(draft.fileSyncMaxBytes, 1048576, 10737418240, DEFAULT_SETTINGS.fileSyncMaxBytes),
			fileSyncMaxFiles: clampNumber(draft.fileSyncMaxFiles, 10, 10000, DEFAULT_SETTINGS.fileSyncMaxFiles),
			fileSyncStagedBytes: clampNumber(
				draft.fileSyncStagedBytes,
				4194304,
				53687091200,
				DEFAULT_SETTINGS.fileSyncStagedBytes,
			),
			resourceLockDefaultTtlMs: clampNumber(
				draft.resourceLockDefaultTtlMs,
				60000,
				86400000,
				DEFAULT_SETTINGS.resourceLockDefaultTtlMs,
			),
			blackboardMaxBytes: clampNumber(draft.blackboardMaxBytes, 4096, 4194304, DEFAULT_SETTINGS.blackboardMaxBytes),
			...(draft.taskReportExcerptBytes !== undefined ? { taskReportExcerptBytes: draft.taskReportExcerptBytes } : {}),
			...(draft.maxResourceLocksPerTask !== undefined
				? { maxResourceLocksPerTask: draft.maxResourceLocksPerTask }
				: {}),
			...(draft.botMentionBudgetPerTurn !== undefined
				? { botMentionBudgetPerTurn: draft.botMentionBudgetPerTurn }
				: {}),
		};

		try {
			const res = await request<{ settings?: SettingsType }>("execution-settings", payload);
			if (!alive.current || currentGen !== generation.current) return;
			if (res?.settings) {
				setDraft({ ...res.settings });
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

			<form className="des-form-card" onSubmit={(e) => void handleSave(e)}>
				<div className="des-form-header">
					<h4 className="des-form-title">{t("deviceExecQuotaTitle")}</h4>
					<div className="des-form-header-actions">
						<button
							type="button"
							className="des-btn des-btn-secondary des-btn-sm"
							disabled={saving}
							onClick={handleResetDefaults}
							title={t("deviceExecResetDefaultsTip")}
						>
							<FiRotateCcw className="des-btn-icon" />
							{t("deviceExecResetDefaults")}
						</button>
					</div>
				</div>

				<div className="des-group">
					<div className="des-group-header">
						<FiCpu className="des-group-icon" />
						<span className="des-group-title">{t("deviceExecSchedulingTitle")}</span>
					</div>
					<div className="des-fields-row">
						<div className="des-field">
							<label htmlFor="des-max-active" className="des-label">
								{t("deviceExecMaxActive")}
							</label>
							<input
								id="des-max-active"
								type="number"
								min={1}
								max={64}
								step={1}
								className="des-input"
								value={draft.maxActiveTasks}
								onChange={(e) => updateNumberField("maxActiveTasks", parseInt(e.target.value, 10) || 1)}
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
								max={1024}
								step={1}
								className="des-input"
								value={draft.maxWaitingTasks}
								onChange={(e) => updateNumberField("maxWaitingTasks", parseInt(e.target.value, 10) || 0)}
								required
							/>
							<span className="des-hint">{t("deviceExecMaxWaitingHint")}</span>
						</div>

						<div className="des-field">
							<label htmlFor="des-starvation-ms" className="des-label">
								{t("deviceExecStarvationMs")}
							</label>
							<div className="des-input-with-badge">
								<input
									id="des-starvation-ms"
									type="number"
									min={1000}
									max={60000}
									step={500}
									className="des-input"
									value={draft.starvationThresholdMs}
									onChange={(e) => updateNumberField("starvationThresholdMs", parseInt(e.target.value, 10) || 1000)}
									required
								/>
								<span className="des-input-badge">{formatDuration(draft.starvationThresholdMs)}</span>
							</div>
							<span className="des-hint">{t("deviceExecStarvationMsHint")}</span>
						</div>

						<div className="des-field">
							<label htmlFor="des-max-skips" className="des-label">
								{t("deviceExecMaxSkips")}
							</label>
							<input
								id="des-max-skips"
								type="number"
								min={1}
								max={20}
								step={1}
								className="des-input"
								value={draft.maxSkipsBeforeStarvation}
								onChange={(e) => updateNumberField("maxSkipsBeforeStarvation", parseInt(e.target.value, 10) || 1)}
								required
							/>
							<span className="des-hint">{t("deviceExecMaxSkipsHint")}</span>
						</div>
					</div>
				</div>

				<div className="des-group">
					<div className="des-group-header">
						<FiShare2 className="des-group-icon" />
						<span className="des-group-title">{t("deviceExecDispatchTitle")}</span>
					</div>
					<div className="des-fields-row">
						<div className="des-field">
							<label htmlFor="des-max-depth" className="des-label">
								{t("deviceExecMaxDepth")}
							</label>
							<input
								id="des-max-depth"
								type="number"
								min={1}
								max={64}
								step={1}
								className="des-input"
								value={draft.maxDispatchDepth}
								onChange={(e) => updateNumberField("maxDispatchDepth", parseInt(e.target.value, 10) || 1)}
								required
							/>
							<span className="des-hint">{t("deviceExecMaxDepthHint")}</span>
						</div>

						<div className="des-field">
							<label htmlFor="des-max-budget" className="des-label">
								{t("deviceExecMaxBudget")}
							</label>
							<input
								id="des-max-budget"
								type="number"
								min={1}
								max={256}
								step={1}
								className="des-input"
								value={draft.maxDispatchBudget}
								onChange={(e) => updateNumberField("maxDispatchBudget", parseInt(e.target.value, 10) || 1)}
								required
							/>
							<span className="des-hint">{t("deviceExecMaxBudgetHint")}</span>
						</div>

						<div className="des-field des-field-checkbox">
							<label htmlFor="des-allow-bot-mentions" className="des-checkbox-container">
								<input
									id="des-allow-bot-mentions"
									type="checkbox"
									className="des-checkbox"
									checked={draft.allowBotMentions}
									onChange={(e) => updateBoolField("allowBotMentions", e.target.checked)}
								/>
								<span className="des-label">{t("deviceExecAllowBotMentions")}</span>
							</label>
							<span className="des-hint">{t("deviceExecAllowBotMentionsHint")}</span>
						</div>
					</div>
				</div>

				<div className="des-group">
					<div className="des-group-header">
						<FiMessageSquare className="des-group-icon" />
						<span className="des-group-title">{t("deviceExecContextTitle")}</span>
					</div>
					<div className="des-fields-row">
						<div className="des-field">
							<label htmlFor="des-group-context-bytes" className="des-label">
								{t("deviceExecContextBytes")}
							</label>
							<div className="des-input-with-badge">
								<input
									id="des-group-context-bytes"
									type="number"
									min={4096}
									max={2097152}
									step={1024}
									className="des-input"
									value={draft.groupContextBytes}
									onChange={(e) => updateNumberField("groupContextBytes", parseInt(e.target.value, 10) || 4096)}
									required
								/>
								<span className="des-input-badge">{formatBytes(draft.groupContextBytes)}</span>
							</div>
							<span className="des-hint">{t("deviceExecContextBytesHint")}</span>
						</div>

						<div className="des-field">
							<label htmlFor="des-group-retention" className="des-label">
								{t("deviceExecRetention")}
							</label>
							<input
								id="des-group-retention"
								type="number"
								min={50}
								max={20000}
								step={10}
								className="des-input"
								value={draft.groupRetentionLimit}
								onChange={(e) => updateNumberField("groupRetentionLimit", parseInt(e.target.value, 10) || 50)}
								required
							/>
							<span className="des-hint">{t("deviceExecRetentionHint")}</span>
						</div>
					</div>
				</div>

				<div className="des-group">
					<div className="des-group-header">
						<FiFolder className="des-group-icon" />
						<span className="des-group-title">{t("deviceExecFileSyncTitle")}</span>
					</div>
					<div className="des-fields-row">
						<div className="des-field">
							<label htmlFor="des-file-sync-bytes" className="des-label">
								{t("deviceExecFileSyncBytes")}
							</label>
							<div className="des-input-with-badge">
								<input
									id="des-file-sync-bytes"
									type="number"
									min={1048576}
									max={10737418240}
									step={1048576}
									className="des-input"
									value={draft.fileSyncMaxBytes}
									onChange={(e) => updateNumberField("fileSyncMaxBytes", parseInt(e.target.value, 10) || 1048576)}
									required
								/>
								<span className="des-input-badge">{formatBytes(draft.fileSyncMaxBytes)}</span>
							</div>
							<span className="des-hint">{t("deviceExecFileSyncBytesHint")}</span>
						</div>

						<div className="des-field">
							<label htmlFor="des-file-sync-files" className="des-label">
								{t("deviceExecFileSyncFiles")}
							</label>
							<input
								id="des-file-sync-files"
								type="number"
								min={10}
								max={10000}
								step={1}
								className="des-input"
								value={draft.fileSyncMaxFiles}
								onChange={(e) => updateNumberField("fileSyncMaxFiles", parseInt(e.target.value, 10) || 10)}
								required
							/>
							<span className="des-hint">{t("deviceExecFileSyncFilesHint")}</span>
						</div>

						<div className="des-field">
							<label htmlFor="des-file-sync-staged-bytes" className="des-label">
								{t("deviceExecFileSyncStagedBytes")}
							</label>
							<div className="des-input-with-badge">
								<input
									id="des-file-sync-staged-bytes"
									type="number"
									min={4194304}
									max={53687091200}
									step={1048576}
									className="des-input"
									value={draft.fileSyncStagedBytes}
									onChange={(e) => updateNumberField("fileSyncStagedBytes", parseInt(e.target.value, 10) || 4194304)}
									required
								/>
								<span className="des-input-badge">{formatBytes(draft.fileSyncStagedBytes)}</span>
							</div>
							<span className="des-hint">{t("deviceExecFileSyncStagedBytesHint")}</span>
						</div>
					</div>
				</div>

				<div className="des-group">
					<div className="des-group-header">
						<FiLock className="des-group-icon" />
						<span className="des-group-title">{t("deviceExecLocksTitle")}</span>
					</div>
					<div className="des-fields-row">
						<div className="des-field">
							<label htmlFor="des-resource-lock-ttl" className="des-label">
								{t("deviceExecLockTtl")}
							</label>
							<div className="des-input-with-badge">
								<input
									id="des-resource-lock-ttl"
									type="number"
									min={60000}
									max={86400000}
									step={60000}
									className="des-input"
									value={draft.resourceLockDefaultTtlMs}
									onChange={(e) => updateNumberField("resourceLockDefaultTtlMs", parseInt(e.target.value, 10) || 60000)}
									required
								/>
								<span className="des-input-badge">{formatDuration(draft.resourceLockDefaultTtlMs)}</span>
							</div>
							<span className="des-hint">{t("deviceExecLockTtlHint")}</span>
						</div>

						<div className="des-field">
							<label htmlFor="des-blackboard-bytes" className="des-label">
								{t("deviceExecBlackboardBytes")}
							</label>
							<div className="des-input-with-badge">
								<input
									id="des-blackboard-bytes"
									type="number"
									min={4096}
									max={4194304}
									step={1024}
									className="des-input"
									value={draft.blackboardMaxBytes}
									onChange={(e) => updateNumberField("blackboardMaxBytes", parseInt(e.target.value, 10) || 4096)}
									required
								/>
								<span className="des-input-badge">{formatBytes(draft.blackboardMaxBytes)}</span>
							</div>
							<span className="des-hint">{t("deviceExecBlackboardBytesHint")}</span>
						</div>
					</div>
				</div>

				<div className="des-form-actions">
					<button type="button" className="des-btn des-btn-secondary" disabled={saving} onClick={handleResetDefaults}>
						{t("deviceExecResetDefaults")}
					</button>
					<button type="button" className="des-btn des-btn-secondary" disabled={saving} onClick={handleDiscardChanges}>
						{t("deviceExecReset")}
					</button>
					<button type="submit" className="des-btn des-btn-primary" disabled={saving}>
						{saving ? t("deviceExecSaving") : t("deviceExecSave")}
					</button>
				</div>
			</form>

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
