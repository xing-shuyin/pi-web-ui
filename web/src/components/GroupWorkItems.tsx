import { useEffect, useRef, useState } from "react";
import { appUrl } from "../base-url";
import { withToken } from "../auth-token";
import { useT } from "../i18n";
import type { MessageKey } from "../i18n/catalog";
import type { GroupTask } from "../device-group-messages";

type WorkStatus = "open" | "running" | "waiting" | "blocked" | "completed" | "cancelled";
interface WorkItem {
	id: string;
	title: string;
	text: string;
	source: { provider: string; channelId: string; threadId: string };
	author?: { id: string; name?: string };
	sourceTrust?: { verified: boolean };
	authorization?: { mode: "auto" | "observe"; authorizedBy?: string };
	authorized?: boolean;
	manualAuthorized?: boolean;
	pendingAuthorization?: boolean;
	latestEvent?: {
		id: string;
		kind?: string;
		text: string;
		author?: { id: string; name?: string };
		authorized: boolean;
	};
	status: WorkStatus;
	summary?: string;
	revision: number;
	taskIds: string[];
	updatedAt: number;
	createdAt?: number;
}
interface WorkItemsPage {
	workItems: WorkItem[];
	routerJobs?: RouterJob[];
	nextCursor?: string | null;
}
function mergeWorkItems(previous: WorkItem[], incoming: WorkItem[]) {
	const merged = new Map(previous.map((item) => [item.id, item]));
	for (const item of incoming) {
		if ((merged.get(item.id)?.revision ?? -1) <= item.revision) merged.set(item.id, item);
	}
	return [...merged.values()].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || b.id.localeCompare(a.id));
}
const WORK_ITEM_STATUS_KEYS: Record<string, MessageKey> = {
	open: "groupWorkItemsStatusOpen",
	queued: "groupWorkItemsStatusQueued",
	running: "groupWorkItemsStatusRunning",
	waiting: "groupWorkItemsStatusWaiting",
	blocked: "groupWorkItemsStatusBlocked",
	completed: "groupWorkItemsStatusCompleted",
	cancelled: "groupWorkItemsStatusCancelled",
	failed: "groupWorkItemsStatusFailed",
	interrupted: "groupWorkItemsStatusInterrupted",
};
interface RouterJob {
	id: string;
	status: "queued" | "running" | "completed" | "failed";
	trigger?: { type: string; workItemId?: string; taskId?: string; messageId?: string };
	attempts?: number;
	error?: string;
	updatedAt: number;
}
async function workRequest<T>(
	path: string,
	signal: AbortSignal,
	body?: object,
	method: "PATCH" | "POST" = "PATCH",
): Promise<T> {
	const response = await fetch(withToken(appUrl(`/api/device-center/${path}`)), {
		method: body ? method : "GET",
		signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
		credentials: "same-origin",
		...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
	});
	const data = await response.json();
	if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
	return data;
}

export function GroupWorkItems({
	roomId,
	tasks = [],
	disabled = false,
	onChanged,
}: {
	roomId: string;
	tasks?: GroupTask[];
	disabled?: boolean;
	onChanged?: () => void;
}) {
	const t = useT();
	const [items, setItems] = useState<WorkItem[]>([]);
	const [jobs, setJobs] = useState<RouterJob[]>([]);
	const [error, setError] = useState("");
	const [actionError, setActionError] = useState("");
	const [loading, setLoading] = useState(true);
	const [pending, setPending] = useState("");
	const [refresh, setRefresh] = useState(0);
	const [nextCursor, setNextCursor] = useState<string | null>(null);
	const [loadingMore, setLoadingMore] = useState(false);
	const loadedOlder = useRef(false);
	const olderRequest = useRef<AbortController | null>(null);
	const operation = useRef<AbortController | null>(null);
	const mutation = useRef<AbortController | null>(null);
	useEffect(() => {
		const controller = new AbortController();
		operation.current = controller;
		setItems([]);
		setJobs([]);
		setLoading(true);
		setError("");
		setActionError("");
		setPending("");
		setNextCursor(null);
		setLoadingMore(false);
		loadedOlder.current = false;
		return () => {
			controller.abort();
			olderRequest.current?.abort();
			olderRequest.current = null;
			mutation.current?.abort();
			mutation.current = null;
		};
	}, [roomId]);
	useEffect(() => {
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout>;
		async function load() {
			try {
				const data = await workRequest<WorkItemsPage>(
					`rooms/${encodeURIComponent(roomId)}/work-items`,
					controller.signal,
				);
				if (controller.signal.aborted) return;
				if (!Array.isArray(data.workItems)) throw new Error(t("groupWorkItemsInvalidResponse"));
				setItems((previous) => mergeWorkItems(previous, data.workItems));
				if (!loadedOlder.current) setNextCursor(data.nextCursor ?? null);
				setJobs(data.routerJobs ?? []);
				setError("");
			} catch (cause) {
				if (!controller.signal.aborted) setError((cause as Error).message);
			} finally {
				if (!controller.signal.aborted) {
					setLoading(false);
					timer = setTimeout(() => void load(), 5000);
				}
			}
		}
		void load();
		return () => {
			controller.abort();
			clearTimeout(timer);
		};
	}, [roomId, refresh, t]);
	async function loadMore() {
		if (!nextCursor || olderRequest.current || !operation.current || operation.current.signal.aborted) return;
		const controller = new AbortController();
		olderRequest.current = controller;
		setLoadingMore(true);
		setActionError("");
		try {
			const data = await workRequest<WorkItemsPage>(
				`rooms/${encodeURIComponent(roomId)}/work-items?before=${encodeURIComponent(nextCursor)}`,
				controller.signal,
			);
			if (controller.signal.aborted) return;
			if (!Array.isArray(data.workItems)) throw new Error(t("groupWorkItemsInvalidResponse"));
			loadedOlder.current = true;
			setItems((previous) => mergeWorkItems(previous, data.workItems));
			setNextCursor(data.nextCursor ?? null);
		} catch (cause) {
			if (!controller.signal.aborted) setActionError((cause as Error).message);
		} finally {
			if (olderRequest.current === controller) {
				olderRequest.current = null;
				setLoadingMore(false);
			}
		}
	}
	async function update(item: WorkItem, status: WorkStatus, authorize = false) {
		if (disabled || mutation.current || !operation.current || operation.current.signal.aborted) return;
		const controller = new AbortController();
		mutation.current = controller;
		setPending(item.id);
		setActionError("");
		try {
			const data = await workRequest<{ workItem: WorkItem }>(
				`rooms/${encodeURIComponent(roomId)}/work-items/${encodeURIComponent(item.id)}`,
				controller.signal,
				{
					revision: item.revision,
					status,
					...(authorize ? { authorize: true } : {}),
				},
			);
			if (controller.signal.aborted) return;
			setItems((previous) => previous.map((value) => (value.id === item.id ? data.workItem : value)));
			onChanged?.();
			setRefresh((n) => n + 1);
		} catch (cause) {
			if (!controller.signal.aborted) setActionError((cause as Error).message);
		} finally {
			if (mutation.current === controller) {
				mutation.current = null;
				setPending("");
			}
		}
	}
	async function retryJob(job: RouterJob) {
		if (disabled || mutation.current || !operation.current || operation.current.signal.aborted) return;
		const controller = new AbortController();
		mutation.current = controller;
		setPending(job.id);
		setActionError("");
		try {
			await workRequest(
				`rooms/${encodeURIComponent(roomId)}/router/jobs/${encodeURIComponent(job.id)}/retry`,
				controller.signal,
				{},
				"POST",
			);
			if (controller.signal.aborted) return;
			setRefresh((n) => n + 1);
			onChanged?.();
		} catch (cause) {
			if (!controller.signal.aborted) setActionError((cause as Error).message);
		} finally {
			if (mutation.current === controller) {
				mutation.current = null;
				setPending("");
			}
		}
	}
	const statusLabel = (status: string) => {
		const key = WORK_ITEM_STATUS_KEYS[status];
		return key ? t(key) : status;
	};
	const sortedJobs = [...jobs].sort((a, b) => b.updatedAt - a.updatedAt);
	return (
		<section
			className="group-members-overview"
			style={{ minWidth: 0, maxWidth: "100%", overflowWrap: "anywhere" }}
			aria-label={t("groupWorkItemsAriaLabel")}
		>
			<div className="grp-section-title">
				<span>
					{t("groupWorkItemsTitle")} ({items.length})
				</span>
				<button type="button" className="btn" disabled={!!pending} onClick={() => setRefresh((n) => n + 1)}>
					{t("groupWorkItemsRefresh")}
				</button>
			</div>
			<p>{t("groupWorkItemsDescription")}</p>
			{(actionError || error) && (
				<p className="dc-bot-error" role="alert">
					{actionError || error}
				</p>
			)}
			{loading && <p role="status">{t("groupWorkItemsLoading")}</p>}
			{!loading && !items.length && <p>{t("groupWorkItemsEmpty")}</p>}
			<div className="grp-bot-list">
				{items.map((item) => {
					const authorized = item.authorized ?? item.authorization?.mode === "auto";
					const settled = item.status === "completed" || item.status === "cancelled";
					const relatedJobs = sortedJobs.filter(
						(job) =>
							job.trigger?.workItemId === item.id ||
							(!!job.trigger?.taskId && item.taskIds.includes(job.trigger.taskId)),
					);
					return (
						<article key={item.id} className="grp-bot-card" aria-label={item.title}>
							<div className="grp-bot-card-top">
								<strong>{item.title}</strong>
								<span className="grp-bot-status-text">{statusLabel(item.status)}</span>
							</div>
							<div className="grp-bot-info">
								<p>
									{t("groupWorkItemsSource")}:{" "}
									<code>
										{item.source.provider} / {item.source.channelId} / {item.source.threadId}
									</code>
								</p>
								{item.author && (
									<p>
										{t("groupWorkItemsAuthor")}: {item.author.name ?? item.author.id}
									</p>
								)}
								<p>
									{t("groupWorkItemsAuthorization")}:{" "}
									{authorized ? t("groupWorkItemsModeAuto") : t("groupWorkItemsModeObserve")}
									{item.manualAuthorized ? t("groupWorkItemsManualAuthorized") : ""}
									{item.authorization?.authorizedBy ? ` · ${item.authorization.authorizedBy}` : ""}
								</p>
								{item.sourceTrust?.verified === false && <p>{t("groupWorkItemsUnverifiedSource")}</p>}
								{item.pendingAuthorization && <p role="status">{t("groupWorkItemsPendingAuthorization")}</p>}
								{item.latestEvent && (
									<details open={item.pendingAuthorization}>
										<summary>
											{t("groupWorkItemsLatestEvent")}
											{item.latestEvent.kind ? ` · ${item.latestEvent.kind}` : ""}
										</summary>
										<p>{item.latestEvent.author?.name ?? item.latestEvent.author?.id}</p>
										<p>{item.latestEvent.text}</p>
									</details>
								)}
								{item.summary && <p>{item.summary}</p>}
								<details>
									<summary>{t("groupWorkItemsContentAndIds")}</summary>
									<p>{item.text}</p>
									<p>
										<code>{item.id}</code> · {t("groupWorkItemsRevision")} {item.revision}
									</p>
								</details>
								<details open={item.taskIds.length > 0}>
									<summary>
										{t("groupWorkItemsLinkedExecutions")} ({item.taskIds.length})
									</summary>
									{!item.taskIds.length && <p>{t("groupWorkItemsNoExecutions")}</p>}
									<ul>
										{item.taskIds.map((id, index) => {
											const task = tasks.find((candidate) => candidate.id === id);
											return (
												<li key={id}>
													#{index + 1} · <code>{id}</code>
													{task && (
														<>
															{" "}
															· {task.botId} · {statusLabel(task.status)}
															{task.report && <p>{task.report}</p>}
														</>
													)}
												</li>
											);
										})}
									</ul>
								</details>
								{relatedJobs.map((job) => (
									<p key={job.id} role={job.error ? "alert" : undefined}>
										Router · {statusLabel(job.status)} · <code>{job.id}</code>
										{job.error ? ` · ${job.error}` : ""}
									</p>
								))}
							</div>
							<div className="dc-actions">
								{(!authorized || item.pendingAuthorization) && !settled && (
									<button
										type="button"
										className="btn primary"
										disabled={disabled || !!pending || item.sourceTrust?.verified === false}
										onClick={() => void update(item, item.status, true)}
									>
										{pending === item.id
											? t("groupWorkItemsUpdating")
											: authorized && item.pendingAuthorization
												? t("groupWorkItemsAuthorizeLatest")
												: t("groupWorkItemsAuthorize")}
									</button>
								)}
								{!settled && item.status !== "blocked" && (
									<button
										type="button"
										className="btn"
										disabled={disabled || !!pending}
										onClick={() => void update(item, "blocked")}
									>
										{t("groupWorkItemsPause")}
									</button>
								)}
								{(item.status === "blocked" || settled) && (
									<button
										type="button"
										className="btn"
										disabled={disabled || !!pending}
										onClick={() => void update(item, "open")}
									>
										{settled ? t("groupWorkItemsReopen") : t("groupWorkItemsResume")}
									</button>
								)}
								{!settled && (
									<button
										type="button"
										className="btn"
										disabled={disabled || !!pending}
										onClick={() => void update(item, "completed")}
									>
										{t("groupWorkItemsComplete")}
									</button>
								)}
							</div>
						</article>
					);
				})}
			</div>
			{nextCursor && (
				<button type="button" className="btn" disabled={loadingMore || !!pending} onClick={() => void loadMore()}>
					{loadingMore ? t("loading") : t("groupWorkItemsLoadMore")}
				</button>
			)}
			<details className="group-ecosystem-panel" open={sortedJobs.some((job) => job.status === "failed")}>
				<summary>
					{t("groupWorkItemsRouterRecent")} ({jobs.length})
				</summary>
				{!jobs.length && <p>{t("groupWorkItemsRouterEmpty")}</p>}
				{sortedJobs.map((job) => (
					<div key={job.id} className="grp-bot-card">
						<strong>{statusLabel(job.status)}</strong> · <code>{job.id}</code>
						<p>
							{job.trigger?.type} · {t("groupWorkItemsAttempts")}: {job.attempts ?? 0}
						</p>
						{job.error && (
							<p className="dc-bot-error" role="alert">
								{job.error}
							</p>
						)}
						{job.status === "failed" && (
							<button type="button" className="btn" disabled={disabled || !!pending} onClick={() => void retryJob(job)}>
								{pending === job.id ? t("groupWorkItemsRetrying") : t("groupWorkItemsRetryRouter")}
							</button>
						)}
					</div>
				))}
			</details>
		</section>
	);
}
