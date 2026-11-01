import { useEffect, useState, useRef } from "react";
import { appUrl } from "../base-url";
import { withToken } from "../auth-token";
import { isZhLocale, useI18n } from "../i18n";
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
	const { locale } = useI18n();
	const zh = isZhLocale(locale);

	const [details, setDetails] = useState<DeviceTaskDetails | null>(null);
	const [journal, setJournal] = useState<DeviceTaskJournalEntry[]>([]);
	const [journalPage, setJournalPage] = useState<DeviceTaskJournalPage | null>(null);
	const [loading, setLoading] = useState(true);
	const [loadingMore, setLoadingMore] = useState(false);
	const [error, setError] = useState("");
	const [journalError, setJournalError] = useState("");
	const [activeTab, setActiveTab] = useState<"journal" | "tools" | "report">("journal");

	// Full report slices state
	const [reportMeta, setReportMeta] = useState<DeviceTaskReportMeta | null>(null);
	const [fullReportText, setFullReportText] = useState<string>("");
	const [reportHasMore, setReportHasMore] = useState(false);
	const [reportNextOffset, setReportNextOffset] = useState<number | undefined>(undefined);
	const [loadingReport, setLoadingReport] = useState(false);
	const [copied, setCopied] = useState(false);

	// Managed lifecycle controllers and timers
	const lifecycleAbortRef = useRef<AbortController | null>(null);
	const copyTimeoutRef = useRef<number | null>(null);
	const panelRef = useRef<HTMLDivElement>(null);
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	// Escape key listener and auto focus
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") onCloseRef.current();
		};
		window.addEventListener("keydown", handleKeyDown);
		panelRef.current?.focus();
		return () => {
			window.removeEventListener("keydown", handleKeyDown);
		};
	}, []);

	// Reset state and fetch initial data only when task or room identity changes
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
			// Details and journal are independent resources: an empty/missing audit trail must not
			// blank out the task overview (and vice versa).
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
				setError((detailsResult.reason as any)?.message || "Failed to load task details");
			}
			if (journalResult.status === "fulfilled") {
				setJournal(journalResult.value.items);
				setJournalPage(journalResult.value);
			} else {
				setJournalError((journalResult.reason as any)?.message || (zh ? "加载事件流失败" : "Failed to load journal"));
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
				setJournalError(cause?.message || (zh ? "分页加载日志失败" : "Failed to load more journal events"));
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
				setError(zh ? `加载报告分片失败: ${cause.message}` : `Failed to load report slice: ${cause.message}`);
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
				setError(zh ? "复制报告失败，请手动选择复制" : "Failed to copy report to clipboard");
			});
	}

	const toolEntries = journal.filter(
		(e) =>
			e.toolName || e.type.startsWith("tool_") || (e.parametersPreview && Object.keys(e.parametersPreview).length > 0),
	);

	const task = details?.task;

	function statusBadge(status?: string) {
		const s = status || "queued";
		const labels: Record<string, { zh: string; en: string; cls: string }> = {
			queued: { zh: "排队中", en: "Queued", cls: "gtd-badge-queued" },
			running: { zh: "运行中", en: "Running", cls: "gtd-badge-running" },
			completed: { zh: "已完成", en: "Completed", cls: "gtd-badge-completed" },
			failed: { zh: "失败", en: "Failed", cls: "gtd-badge-failed" },
			interrupted: { zh: "已中断", en: "Interrupted", cls: "gtd-badge-interrupted" },
		};
		const info = labels[s] || { zh: s, en: s, cls: "gtd-badge-queued" };
		return <span className={`gtd-badge ${info.cls}`}>{zh ? info.zh : info.en}</span>;
	}

	return (
		<div className="gtd-overlay" role="dialog" aria-modal="true" aria-label={zh ? "任务详情" : "Task Details"}>
			<div className="gtd-panel" ref={panelRef} tabIndex={-1}>
				<div className="gtd-header">
					<div className="gtd-header-title">
						<h3>{zh ? "群任务详情与操作审计" : "Group Task Details & Audit Log"}</h3>
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
					<div className="gtd-loading">{zh ? "加载任务详情中..." : "Loading task details..."}</div>
				) : (
					<div className="gtd-body">
						{/* Overview Card */}
						{task && (
							<div className="gtd-overview-card">
								<div className="gtd-field">
									<span className="gtd-label">{zh ? "目标内容:" : "Objective:"}</span>
									<span className="gtd-value gtd-task-text">{task.text}</span>
								</div>
								<div className="gtd-meta-row">
									<div className="gtd-field">
										<span className="gtd-label">{zh ? "执行 Bot:" : "Bot:"}</span>
										<span className="gtd-value">{task.botName || task.botId}</span>
									</div>
									{task.deviceName && (
										<div className="gtd-field">
											<span className="gtd-label">{zh ? "运行设备:" : "Device:"}</span>
											<span className="gtd-value">{task.deviceName}</span>
										</div>
									)}
									<div className="gtd-field">
										<span className="gtd-label">{zh ? "创建时间:" : "Created:"}</span>
										<span className="gtd-value">{new Date(task.createdAt).toLocaleTimeString()}</span>
									</div>
								</div>

								{task.queuedReason && (
									<div className="gtd-callout gtd-callout-info">
										<strong>{zh ? "排队原因:" : "Queued Reason:"}</strong> {task.queuedReason}
									</div>
								)}
								{task.interruptedReason && (
									<div className="gtd-callout gtd-callout-warning">
										<strong>{zh ? "中断原因:" : "Interruption Reason:"}</strong> {task.interruptedReason}
									</div>
								)}
							</div>
						)}

						{/* Associated Interactions */}
						{details && details.interactions.length > 0 && (
							<div className="gtd-section">
								<h4>{zh ? "关联人工审批与问卷" : "Associated Human Interactions"}</h4>
								<div className="gtd-interaction-list">
									{details.interactions.map((it) => (
										<div key={it.id} className="gtd-interaction-item">
											<div className="gtd-interaction-header">
												<span className="gtd-interaction-kind">{it.kind}</span>
												<span className={it.resolved ? "gtd-badge-completed" : "gtd-badge-queued"}>
													{it.resolved ? (zh ? "已裁决" : "Resolved") : zh ? "待处理" : "Pending"}
												</span>
											</div>
											{it.question && <div className="gtd-interaction-q">{it.question}</div>}
											{it.decision && (
												<div className="gtd-interaction-ans">
													{zh ? "裁决结论: " : "Decision: "} {it.decision}
												</div>
											)}
										</div>
									))}
								</div>
							</div>
						)}

						{/* Associated Deliveries */}
						{details && details.deliveries.length > 0 && (
							<div className="gtd-section">
								<h4>{zh ? "关联代码交付" : "Associated Code Deliveries"}</h4>
								<div className="gtd-delivery-list">
									{details.deliveries.map((del) => (
										<div key={del.id} className="gtd-delivery-item">
											<div className="gtd-delivery-header">
												<span className="gtd-commit-sha">{del.commit.slice(0, 8)}</span>
												{del.branch && <span className="gtd-branch-chip">{del.branch}</span>}
												<span className={del.passed ? "gtd-badge-completed" : "gtd-badge-failed"}>
													{del.passed ? (zh ? "自检通过" : "Passed") : zh ? "自检未通过" : "Failed"}
												</span>
											</div>
											<div className="gtd-delivery-summary">{del.summary}</div>
										</div>
									))}
								</div>
							</div>
						)}

						{/* Tabs navigation */}
						<div className="gtd-tabs">
							<button
								type="button"
								className={`gtd-tab ${activeTab === "journal" ? "active" : ""}`}
								onClick={() => setActiveTab("journal")}
							>
								{zh ? "事件与审计流" : "Journal Events"} ({journal.length})
							</button>
							<button
								type="button"
								className={`gtd-tab ${activeTab === "tools" ? "active" : ""}`}
								onClick={() => setActiveTab("tools")}
							>
								{zh ? "工具调用卡片" : "Tool Lifecycles"} ({toolEntries.length})
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
								{zh ? "任务完整报告" : "Full Report Log"}
							</button>
						</div>

						{/* Tab 1: Journal Events */}
						{activeTab === "journal" && (
							<div className="gtd-tab-content">
								{journalPage?.truncated && (
									<div className="gtd-truncation-notice">
										⚠️{" "}
										{zh
											? `由于日志保留配额，最早的 ${journalPage.droppedCount} 条事件已自动淘汰。系统明确标记并不伪装历史完整。`
											: `The earliest ${journalPage.droppedCount} events were pruned due to journal retention quota. History is not disguised as complete.`}
									</div>
								)}

								{journalPage?.cursorExpired && (
									<div className="gtd-callout gtd-callout-warning">
										{zh
											? "游标所在的分段已淘汰，显示当前保留的最旧事件。"
											: "The requested cursor was pruned from disk; showing oldest retained segments."}
									</div>
								)}

								{journalPage?.corrupted && (
									<div className="gtd-callout gtd-callout-warning">
										{zh ? "部分分段可能存在损坏行，已保留损坏证据。" : "Corrupted lines detected and flagged."}
									</div>
								)}

								{journalError && (
									<div className="gtd-callout gtd-callout-warning" role="alert">
										{journalError}
									</div>
								)}

								{journalPage?.journalUnavailable && (
									<div className="gtd-callout gtd-callout-warning">
										{zh
											? "事件日志写入失败或被降级，审计流可能不完整。"
											: "Journal persistence failed or degraded; the audit trail may be incomplete."}
									</div>
								)}

								{journal.length === 0 ? (
									<div className="gtd-empty">{zh ? "暂无事件记录" : "No journal events recorded."}</div>
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
											{loadingMore
												? zh
													? "加载中..."
													: "Loading..."
												: zh
													? "加载更多历史事件"
													: "Load more journal events"}
										</button>
									</div>
								)}
							</div>
						)}

						{/* Tab 2: Tool Lifecycle Cards */}
						{activeTab === "tools" && (
							<div className="gtd-tab-content">
								{journalError && (
									<div className="gtd-callout gtd-callout-warning" role="alert">
										{journalError}
									</div>
								)}
								{toolEntries.length === 0 ? (
									<div className="gtd-empty">{zh ? "本任务暂无工具调用记录" : "No tool invocations recorded."}</div>
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
														<span className="gtd-label">{zh ? "安全参数摘要:" : "Parameters:"}</span>
														<pre>{JSON.stringify(tool.parametersPreview, null, 2)}</pre>
													</div>
												)}
												{tool.output && (
													<div className="gtd-tool-output">
														<span className="gtd-label">{zh ? "增量安全输出:" : "Output Snippet:"}</span>
														<pre>{tool.output}</pre>
													</div>
												)}
											</div>
										))}
									</div>
								)}
							</div>
						)}

						{/* Tab 3: Full Report */}
						{activeTab === "report" && (
							<div className="gtd-tab-content">
								{reportMeta && (
									<div className="gtd-report-meta-box">
										<div>
											<span className="gtd-label">{zh ? "存储位置:" : "Storage:"}</span>{" "}
											<code>
												{reportMeta.storageLocation.role}::{reportMeta.storageLocation.reportRef}
											</code>
										</div>
										<div>
											<span className="gtd-label">{zh ? "报告总大小:" : "Total Size:"}</span>{" "}
											<span>{reportMeta.totalBytes} bytes</span>
										</div>
										{reportMeta.sha256 && (
											<div>
												<span className="gtd-label">{zh ? "完整性 SHA256:" : "SHA256:"}</span>{" "}
												<code>{reportMeta.sha256.slice(0, 16)}...</code>
											</div>
										)}
										<div>
											<span className="gtd-label">{zh ? "当前已加载:" : "Loaded Size:"}</span>{" "}
											<span>{new TextEncoder().encode(fullReportText).length} bytes</span>
										</div>
										{reportMeta.quotaExceeded && (
											<div className="gtd-callout gtd-callout-warning">
												⚠️{" "}
												{zh
													? `报告超过配额硬限制 (${reportMeta.quotaLimit} bytes)，系统明确拒绝接收超额部分，绝不伪装完整。`
													: `Report exceeded quota limit (${reportMeta.quotaLimit} bytes) and was rejected without partial truncation disguise.`}
											</div>
										)}
										{reportMeta.uploadPending && (
											<div className="gtd-callout gtd-callout-info">
												⏳ {zh ? "完整报告正在由执行设备分块同步中..." : "Full report chunk sync in progress..."}
											</div>
										)}
										{reportMeta.missing && !reportMeta.uploadPending && (
											<div className="gtd-callout gtd-callout-warning">
												⚠️ {zh ? "执行设备尚未上传完整报告原文。" : "Full report has not yet been uploaded by device."}
											</div>
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
											{loadingReport ? (zh ? "加载中..." : "Loading...") : zh ? "加载更多报告内容" : "Load more report"}
										</button>
									)}
									<button
										type="button"
										className="btn"
										disabled={loadingReport || !fullReportText}
										onClick={copyReport}
									>
										{copied ? (zh ? "已复制" : "Copied!") : zh ? "复制报告全文" : "Copy Report"}
									</button>
								</div>

								{loadingReport && !fullReportText ? (
									<div className="gtd-loading">{zh ? "正在读取报告文件..." : "Loading report file..."}</div>
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
