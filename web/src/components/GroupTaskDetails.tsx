import { useEffect, useState, useRef } from "react";
import { appUrl } from "../base-url";
import { withToken } from "../auth-token";
import { useT } from "../i18n";
import type {
	DeviceTaskDetails,
	DeviceTaskJournalEntry,
	DeviceTaskJournalPage,
	DeviceTaskReportMeta,
} from "../../../server/protocol";

export interface GroupTaskDetailsProps {
	roomId: string;
	taskId: string;
	onClose: () => void;
}

async function fetchJson<T>(path: string, signal: AbortSignal): Promise<T> {
	const res = await fetch(withToken(appUrl(`/api/device-center/${path}`)), {
		method: "GET",
		credentials: "same-origin",
		signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		throw new Error(data.error || `HTTP ${res.status}`);
	}
	return data as T;
}

export function GroupTaskDetails({ roomId, taskId, onClose }: GroupTaskDetailsProps) {
	const t = useT();

	const [details, setDetails] = useState<DeviceTaskDetails | null>(null);
	const [journal, setJournal] = useState<DeviceTaskJournalEntry[]>([]);
	const [journalPage, setJournalPage] = useState<DeviceTaskJournalPage | null>(null);
	const [loading, setLoading] = useState(true);
	const [loadingMore, setLoadingMore] = useState(false);
	const [error, setError] = useState("");
	const [journalError, setJournalError] = useState("");
	const [activeTab, setActiveTab] = useState<"journal" | "tools" | "report">("journal");

	const [reportMeta, setReportMeta] = useState<DeviceTaskReportMeta | null>(null);
	const [fullReportText, setFullReportText] = useState<string>("");
	const [reportHasMore, setReportHasMore] = useState(false);
	const [reportNextOffset, setReportNextOffset] = useState<number | undefined>(undefined);
	const [loadingReport, setLoadingReport] = useState(false);
	const [copied, setCopied] = useState(false);

	const lifecycleAbortRef = useRef<AbortController | null>(null);
	const copyTimeoutRef = useRef<number | null>(null);
	const panelRef = useRef<HTMLDivElement>(null);
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				onCloseRef.current();
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		panelRef.current?.focus();
		return () => {
			window.removeEventListener("keydown", handleKeyDown);
		};
	}, []);

	useEffect(() => {
		lifecycleAbortRef.current?.abort();
		const controller = new AbortController();
		lifecycleAbortRef.current = controller;

		setDetails(null);
		setJournal([]);
		setJournalPage(null);
		setFullReportText("");
		setReportMeta(null);
		setReportHasMore(false);
		setReportNextOffset(undefined);
		setCopied(false);
		setError("");
		setJournalError("");
		setLoading(true);

		async function loadInitial() {
			const [detailsResult, journalResult] = await Promise.allSettled([
				fetchJson<DeviceTaskDetails>(
					`rooms/${encodeURIComponent(roomId)}/tasks/${encodeURIComponent(taskId)}`,
					controller.signal,
				),
				fetchJson<DeviceTaskJournalPage>(
					`rooms/${encodeURIComponent(roomId)}/tasks/${encodeURIComponent(taskId)}/journal?limit=25&direction=forward`,
					controller.signal,
				),
			]);
			if (controller.signal.aborted) return;
			if (detailsResult.status === "fulfilled") {
				const detailsData = detailsResult.value;
				setDetails(detailsData);
				if (detailsData.reportMeta) setReportMeta(detailsData.reportMeta);
			} else {
				setError((detailsResult.reason as any)?.message || t("groupTaskDetails.loadFailed"));
			}
			if (journalResult.status === "fulfilled") {
				setJournal(journalResult.value.items);
				setJournalPage(journalResult.value);
			} else {
				setJournalError((journalResult.reason as any)?.message || t("groupTaskDetails.journalLoadFailed"));
			}
			setLoading(false);
		}

		void loadInitial();

		return () => {
			controller.abort();
			if (copyTimeoutRef.current !== null) {
				clearTimeout(copyTimeoutRef.current);
				copyTimeoutRef.current = null;
			}
		};
	}, [roomId, taskId]);

	async function loadMore() {
		if (!journalPage?.nextCursor || loadingMore) return;
		const controller = lifecycleAbortRef.current ?? new AbortController();
		setLoadingMore(true);
		try {
			const nextData = await fetchJson<DeviceTaskJournalPage>(
				`rooms/${encodeURIComponent(roomId)}/tasks/${encodeURIComponent(taskId)}/journal?limit=25&direction=forward&cursor=${encodeURIComponent(journalPage.nextCursor)}`,
				controller.signal,
			);
			if (controller.signal.aborted) return;
			setJournal((prev) => [...prev, ...nextData.items]);
			setJournalPage(nextData);
		} catch (cause: any) {
			if (!controller.signal.aborted) {
				setJournalError(cause?.message || t("groupTaskDetails.journalMoreFailed"));
			}
		} finally {
			if (!controller.signal.aborted) setLoadingMore(false);
		}
	}

	async function loadReportSlice(offset?: number) {
		const controller = lifecycleAbortRef.current ?? new AbortController();
		setLoadingReport(true);
		try {
			const query = offset !== undefined ? `?offset=${offset}&limit=262144` : "?offset=0&limit=262144";
			const res = await fetchJson<{
				meta: DeviceTaskReportMeta;
				text?: string;
				hasMore?: boolean;
				nextOffset?: number | null;
			}>(`rooms/${encodeURIComponent(roomId)}/tasks/${encodeURIComponent(taskId)}/report${query}`, controller.signal);
			if (controller.signal.aborted) return;
			setReportMeta(res.meta);
			const chunk = res.text ?? "";
			setFullReportText((prev) => (offset === undefined || offset === 0 ? chunk : prev + chunk));
			setReportHasMore(!!res.hasMore);
			setReportNextOffset(res.nextOffset ?? undefined);
		} catch (cause: any) {
			if (!controller.signal.aborted) {
				setError(t("groupTaskDetails.reportSliceFailed", { error: cause?.message ?? "" }));
			}
		} finally {
			if (!controller.signal.aborted) setLoadingReport(false);
		}
	}

	function copyReport() {
		if (!fullReportText) return;
		navigator.clipboard
			.writeText(fullReportText)
			.then(() => {
				setCopied(true);
				if (copyTimeoutRef.current !== null) clearTimeout(copyTimeoutRef.current);
				copyTimeoutRef.current = window.setTimeout(() => {
					setCopied(false);
					copyTimeoutRef.current = null;
				}, 2000);
			})
			.catch(() => {
				setError(t("groupTaskDetails.copyFailed"));
			});
	}

	const toolEntries = journal.filter(
		(e) =>
			e.toolName || e.type.startsWith("tool_") || (e.parametersPreview && Object.keys(e.parametersPreview).length > 0),
	);

	const task = details?.task;

	function statusBadge(status?: string) {
		const s = status || "queued";
		const labels: Record<string, { label: string; cls: string }> = {
			queued: { label: t("toolQueued"), cls: "gtd-badge-queued" },
			running: { label: t("tabRunning"), cls: "gtd-badge-running" },
			completed: { label: t("planBoardCompleted"), cls: "gtd-badge-completed" },
			failed: { label: t("planBoardFailed"), cls: "gtd-badge-failed" },
			interrupted: { label: t("groupTaskDetails.statusInterrupted"), cls: "gtd-badge-interrupted" },
		};
		const info = labels[s] || { label: s, cls: "gtd-badge-queued" };
		return <span className={`gtd-badge ${info.cls}`}>{info.label}</span>;
	}

	return (
		<div className="gtd-overlay" role="dialog" aria-modal="true" aria-label={t("groupTaskDetails.dialogLabel")}>
			<div className="gtd-panel" ref={panelRef} tabIndex={-1}>
				<div className="gtd-header">
					<div className="gtd-header-title">
						<h3>{t("groupTaskDetails.heading")}</h3>
						{task && <span className="gtd-task-id">#{task.id.slice(0, 8)}</span>}
						{task && statusBadge(task.status)}
					</div>
					<button type="button" className="btn gtd-close-btn gtd-close" onClick={onClose}>
						✕
					</button>
				</div>

				{error && (
					<div className="gtd-error-banner" role="alert">
						{error}
					</div>
				)}

				{loading ? (
					<div className="gtd-loading">{t("groupTaskDetails.loading")}</div>
				) : (
					<div className="gtd-body">
						{task && (
							<div className="gtd-overview-card">
								<div className="gtd-field">
									<span className="gtd-label">{t("groupTaskDetails.objective")}</span>
									<span className="gtd-value gtd-task-text">{task.text}</span>
								</div>
								<div className="gtd-meta-row">
									<div className="gtd-field">
										<span className="gtd-label">{t("groupTaskDetails.bot")}</span>
										<span className="gtd-value">{task.botName || task.botId}</span>
									</div>
									{task.deviceName && (
										<div className="gtd-field">
											<span className="gtd-label">{t("groupTaskDetails.device")}</span>
											<span className="gtd-value">{task.deviceName}</span>
										</div>
									)}
									<div className="gtd-field">
										<span className="gtd-label">{t("groupTaskDetails.createdAt")}</span>
										<span className="gtd-value">{new Date(task.createdAt).toLocaleTimeString()}</span>
									</div>
								</div>

								{task.queuedReason && (
									<div className="gtd-callout gtd-callout-info">
										<strong>{t("groupTaskDetails.queuedReason")}</strong> {task.queuedReason}
									</div>
								)}
								{task.interruptedReason && (
									<div className="gtd-callout gtd-callout-warning">
										<strong>{t("groupTaskDetails.interruptedReason")}</strong> {task.interruptedReason}
									</div>
								)}
							</div>
						)}

						{details && details.interactions.length > 0 && (
							<div className="gtd-section">
								<h4>{t("groupTaskDetails.interactions")}</h4>
								<div className="gtd-interaction-list">
									{details.interactions.map((it) => (
										<div key={it.id} className="gtd-interaction-item">
											<div className="gtd-interaction-header">
												<span className="gtd-interaction-kind">{it.kind}</span>
												<span className={it.resolved ? "gtd-badge-completed" : "gtd-badge-queued"}>
													{it.resolved ? t("groupTaskDetails.resolved") : t("groupTaskDetails.pending")}
												</span>
											</div>
											{it.question && <div className="gtd-interaction-q">{it.question}</div>}
											{it.decision && (
												<div className="gtd-interaction-ans">
													{t("groupTaskDetails.decision")} {it.decision}
												</div>
											)}
										</div>
									))}
								</div>
							</div>
						)}

						{details && details.deliveries.length > 0 && (
							<div className="gtd-section">
								<h4>{t("groupTaskDetails.deliveries")}</h4>
								<div className="gtd-delivery-list">
									{details.deliveries.map((del) => (
										<div key={del.id} className="gtd-delivery-item">
											<div className="gtd-delivery-header">
												{del.commit && <span className="gtd-commit-sha">{del.commit.slice(0, 8)}</span>}
												{del.branch && <span className="gtd-branch-chip">{del.branch}</span>}
												<span
													className={
														del.reportedCheckCount === 0
															? "gtd-badge-queued"
															: del.passed
																? "gtd-badge-completed"
																: "gtd-badge-failed"
													}
												>
													{del.reportedCheckCount === 0
														? t("groupTaskDetails.noReportedChecks")
														: del.passed
															? t("groupTaskDetails.checksPassed")
															: t("groupTaskDetails.checksFailed")}
												</span>
											</div>
											<div className="gtd-delivery-summary">{del.summary}</div>
											{del.artifactRef && (
												<>
													<div className="gtd-field">
														<span className="gtd-label">{t("groupTaskDetails.deliveryVersionId")}</span>
														<span className="gtd-value">{del.id}</span>
													</div>
													<div className="gtd-field">
														<span className="gtd-label">{t("groupTaskDetails.artifact")}</span>
														<span className="gtd-value">{del.artifactRef.artifactId}</span>
													</div>
													<div className="gtd-field">
														<span className="gtd-label">{t("groupTaskDetails.sourceTask")}</span>
														<span className="gtd-value">{del.artifactRef.artifactTaskId}</span>
													</div>
													<div className="gtd-field">
														<span className="gtd-label">{t("groupTaskDetails.contentDigest")}</span>
														<span className="gtd-value">{del.artifactRef.artifactDigest}</span>
													</div>
													<div className="gtd-field">
														<span className="gtd-label">{t("groupTaskDetails.fileTreeVersion")}</span>
														<span className="gtd-value">{del.artifactRef.outputTree}</span>
													</div>
												</>
											)}
										</div>
									))}
								</div>
							</div>
						)}

						<div className="gtd-tabs">
							<button
								type="button"
								className={`gtd-tab ${activeTab === "journal" ? "active" : ""}`}
								onClick={() => setActiveTab("journal")}
							>
								{t("groupTaskDetails.tabJournal")} ({journal.length})
							</button>
							<button
								type="button"
								className={`gtd-tab ${activeTab === "tools" ? "active" : ""}`}
								onClick={() => setActiveTab("tools")}
							>
								{t("groupTaskDetails.tabTools")} ({toolEntries.length})
							</button>
							<button
								type="button"
								className={`gtd-tab ${activeTab === "report" ? "active" : ""}`}
								onClick={() => {
									setActiveTab("report");
									if (!fullReportText) {
										setLoadingReport(true);
										void loadReportSlice();
									}
								}}
							>
								{t("groupTaskDetails.tabReport")}
							</button>
						</div>

						{activeTab === "journal" && (
							<div className="gtd-tab-content">
								{journalPage?.truncated && (
									<div className="gtd-truncation-notice">
										⚠️ {t("groupTaskDetails.journalTruncated", { count: journalPage.droppedCount })}
									</div>
								)}

								{journalPage?.cursorExpired && (
									<div className="gtd-callout gtd-callout-warning">{t("groupTaskDetails.cursorExpired")}</div>
								)}

								{journalPage?.corrupted && (
									<div className="gtd-callout gtd-callout-warning">{t("groupTaskDetails.corrupted")}</div>
								)}

								{journalError && (
									<div className="gtd-callout gtd-callout-warning" role="alert">
										{journalError}
									</div>
								)}

								{journalPage?.journalUnavailable && (
									<div className="gtd-callout gtd-callout-warning">{t("groupTaskDetails.journalUnavailable")}</div>
								)}

								{journal.length === 0 ? (
									<div className="gtd-empty">{t("groupTaskDetails.journalEmpty")}</div>
								) : (
									<div className="gtd-journal-list">
										{journal.map((entry) => (
											<div key={entry.id} className="gtd-journal-entry">
												<div className="gtd-entry-meta">
													<span className="gtd-entry-seq">#{entry.sequence}</span>
													<span className="gtd-entry-type">{entry.type}</span>
													<span className="gtd-entry-time">{new Date(entry.timestamp).toLocaleTimeString()}</span>
												</div>
												{entry.summary && <div className="gtd-entry-summary">{entry.summary}</div>}
												{entry.output && <pre className="gtd-entry-output">{entry.output}</pre>}
												{entry.reason && <div className="gtd-entry-reason">{entry.reason}</div>}
											</div>
										))}
									</div>
								)}

								{journalPage?.hasMore && (
									<div className="gtd-load-more-row">
										<button type="button" className="btn gtd-load-more-btn" disabled={loadingMore} onClick={loadMore}>
											{loadingMore ? t("loading") : t("groupTaskDetails.loadMoreJournal")}
										</button>
									</div>
								)}
							</div>
						)}

						{activeTab === "tools" && (
							<div className="gtd-tab-content">
								{journalError && (
									<div className="gtd-callout gtd-callout-warning" role="alert">
										{journalError}
									</div>
								)}
								{toolEntries.length === 0 ? (
									<div className="gtd-empty">{t("groupTaskDetails.toolsEmpty")}</div>
								) : (
									<div className="gtd-tool-cards">
										{toolEntries.map((tool) => (
											<div key={tool.id} className="gtd-tool-card">
												<div className="gtd-tool-card-head">
													<strong>{tool.toolName || "tool"}</strong>
													<span className="gtd-tool-phase">{tool.type}</span>
												</div>
												{tool.parametersPreview && (
													<div className="gtd-tool-params">
														<span className="gtd-label">{t("groupTaskDetails.parameters")}</span>
														<pre>{JSON.stringify(tool.parametersPreview, null, 2)}</pre>
													</div>
												)}
												{tool.output && (
													<div className="gtd-tool-output">
														<span className="gtd-label">{t("groupTaskDetails.output")}</span>
														<pre>{tool.output}</pre>
													</div>
												)}
											</div>
										))}
									</div>
								)}
							</div>
						)}

						{activeTab === "report" && (
							<div className="gtd-tab-content">
								{reportMeta && (
									<div className="gtd-report-meta-box">
										<div>
											<span className="gtd-label">{t("groupTaskDetails.storage")}</span>{" "}
											<code>
												{reportMeta.storageLocation.role}::{reportMeta.storageLocation.reportRef}
											</code>
										</div>
										<div>
											<span className="gtd-label">{t("groupTaskDetails.totalSize")}</span>{" "}
											<span>{reportMeta.totalBytes} bytes</span>
										</div>
										{reportMeta.sha256 && (
											<div>
												<span className="gtd-label">{t("groupTaskDetails.sha256")}</span>{" "}
												<code>{reportMeta.sha256.slice(0, 16)}...</code>
											</div>
										)}
										<div>
											<span className="gtd-label">{t("groupTaskDetails.loadedSize")}</span>{" "}
											<span>{new TextEncoder().encode(fullReportText).length} bytes</span>
										</div>
										{reportMeta.quotaExceeded && (
											<div className="gtd-callout gtd-callout-warning">
												⚠️ {t("groupTaskDetails.quotaExceeded", { limit: reportMeta.quotaLimit })}
											</div>
										)}
										{reportMeta.uploadPending && (
											<div className="gtd-callout gtd-callout-info">⏳ {t("groupTaskDetails.uploadPending")}</div>
										)}
										{reportMeta.missing && !reportMeta.uploadPending && (
											<div className="gtd-callout gtd-callout-warning">⚠️ {t("groupTaskDetails.missing")}</div>
										)}
									</div>
								)}

								<div className="gtd-report-actions">
									{reportHasMore && (
										<button
											type="button"
											className="btn"
											disabled={loadingReport}
											onClick={() => loadReportSlice(reportNextOffset)}
										>
											{loadingReport ? t("loading") : t("groupTaskDetails.loadMoreReport")}
										</button>
									)}
									<button
										type="button"
										className="btn"
										disabled={loadingReport || !fullReportText}
										onClick={copyReport}
									>
										{copied ? t("copied") : t("groupTaskDetails.copyReport")}
									</button>
								</div>

								{loadingReport && !fullReportText ? (
									<div className="gtd-loading">{t("groupTaskDetails.reportLoading")}</div>
								) : (
									<pre className="gtd-report-viewer gtd-report-text">{fullReportText}</pre>
								)}
							</div>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
