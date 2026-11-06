import { useEffect, useRef, useState } from "react";
import { appUrl } from "../base-url";
import { withToken } from "../auth-token";
import { isZhLocale, useI18n } from "../i18n";
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
	const zh = isZhLocale(useI18n().locale);
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
				if (!Array.isArray(data.workItems)) throw new Error(zh ? "工单列表响应无效" : "Invalid work item response");
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
	}, [roomId, refresh, zh]);
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
			if (!Array.isArray(data.workItems)) throw new Error(zh ? "工单列表响应无效" : "Invalid work item response");
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
		const labels: Record<string, string> = zh
			? {
					open: "待处理",
					queued: "排队中",
					running: "执行中",
					waiting: "等待中",
					blocked: "已暂停",
					completed: "已完成",
					cancelled: "已取消",
					failed: "失败",
					interrupted: "已中断",
				}
			: {
					open: "Open",
					queued: "Queued",
					running: "Running",
					waiting: "Waiting",
					blocked: "Paused",
					completed: "Completed",
					cancelled: "Cancelled",
					failed: "Failed",
					interrupted: "Interrupted",
				};
		return labels[status] ?? status;
	};
	const sortedJobs = [...jobs].sort((a, b) => b.updatedAt - a.updatedAt);
	return (
		<section
			className="group-members-overview"
			style={{ minWidth: 0, maxWidth: "100%", overflowWrap: "anywhere" }}
			aria-label={zh ? "群组工单" : "Group work items"}
		>
			<div className="grp-section-title">
				<span>
					{zh ? "工单" : "Work items"} ({items.length})
				</span>
				<button type="button" className="btn" disabled={!!pending} onClick={() => setRefresh((n) => n + 1)}>
					{zh ? "刷新" : "Refresh"}
				</button>
			</div>
			<p>
				{zh
					? "工单保留外部来源与授权，持续关联多次执行。单次任务结束后，工单仍可继续处理。"
					: "Work items retain their source and authorization across multiple executions. A finished task does not close the work item."}
			</p>
			{(actionError || error) && (
				<p className="dc-bot-error" role="alert">
					{actionError || error}
				</p>
			)}
			{loading && <p role="status">{zh ? "正在加载工单…" : "Loading work items…"}</p>}
			{!loading && !items.length && <p>{zh ? "暂无工单" : "No work items yet"}</p>}
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
									{zh ? "来源" : "Source"}:{" "}
									<code>
										{item.source.provider} / {item.source.channelId} / {item.source.threadId}
									</code>
								</p>
								{item.author && (
									<p>
										{zh ? "发起人" : "Author"}: {item.author.name ?? item.author.id}
									</p>
								)}
								<p>
									{zh ? "授权" : "Authorization"}:{" "}
									{authorized
										? zh
											? "auto · 允许自动执行"
											: "auto · automatic execution authorized"
										: zh
											? "observe · 仅观察"
											: "observe · observation only"}
									{item.manualAuthorized ? (zh ? " · 手动授权" : " · Manually authorized") : ""}
									{item.authorization?.authorizedBy ? ` · ${item.authorization.authorizedBy}` : ""}
								</p>
								{item.sourceTrust?.verified === false && (
									<p>
										{zh
											? "来源未经验证，无法授权自动执行。"
											: "The source is unverified and cannot be authorized for automatic execution."}
									</p>
								)}
								{item.pendingAuthorization && (
									<p role="status">
										{zh
											? "最新事件尚未授权；已有工单授权不会自动覆盖这条留言。"
											: "The latest event needs authorization; earlier approval does not cover this message."}
									</p>
								)}
								{item.latestEvent && (
									<details open={item.pendingAuthorization}>
										<summary>
											{zh ? "最新外部事件" : "Latest external event"}
											{item.latestEvent.kind ? ` · ${item.latestEvent.kind}` : ""}
										</summary>
										<p>{item.latestEvent.author?.name ?? item.latestEvent.author?.id}</p>
										<p>{item.latestEvent.text}</p>
									</details>
								)}
								{item.summary && <p>{item.summary}</p>}
								<details>
									<summary>{zh ? "工单内容与标识" : "Content and identifiers"}</summary>
									<p>{item.text}</p>
									<p>
										<code>{item.id}</code> · {zh ? "版本" : "Revision"} {item.revision}
									</p>
								</details>
								<details open={item.taskIds.length > 0}>
									<summary>
										{zh ? "关联执行" : "Linked executions"} ({item.taskIds.length})
									</summary>
									{!item.taskIds.length && <p>{zh ? "尚未执行" : "No executions yet"}</p>}
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
											? zh
												? "处理中…"
												: "Updating…"
											: authorized && item.pendingAuthorization
												? zh
													? "授权最新事件"
													: "Authorize latest event"
												: zh
													? "手动授权"
													: "Authorize"}
									</button>
								)}
								{!settled && item.status !== "blocked" && (
									<button
										type="button"
										className="btn"
										disabled={disabled || !!pending}
										onClick={() => void update(item, "blocked")}
									>
										{zh ? "暂停" : "Pause"}
									</button>
								)}
								{(item.status === "blocked" || settled) && (
									<button
										type="button"
										className="btn"
										disabled={disabled || !!pending}
										onClick={() => void update(item, "open")}
									>
										{settled ? (zh ? "重新打开" : "Reopen") : zh ? "恢复" : "Resume"}
									</button>
								)}
								{!settled && (
									<button
										type="button"
										className="btn"
										disabled={disabled || !!pending}
										onClick={() => void update(item, "completed")}
									>
										{zh ? "完成工单" : "Complete"}
									</button>
								)}
							</div>
						</article>
					);
				})}
			</div>
			{nextCursor && (
				<button type="button" className="btn" disabled={loadingMore || !!pending} onClick={() => void loadMore()}>
					{loadingMore ? (zh ? "加载中…" : "Loading…") : zh ? "加载更多工单" : "Load more work items"}
				</button>
			)}
			<details className="group-ecosystem-panel" open={sortedJobs.some((job) => job.status === "failed")}>
				<summary>
					{zh ? "Router 最近运行与失败" : "Recent Router runs and failures"} ({jobs.length})
				</summary>
				{!jobs.length && <p>{zh ? "暂无 Router 运行记录" : "No Router runs yet"}</p>}
				{sortedJobs.map((job) => (
					<div key={job.id} className="grp-bot-card">
						<strong>{statusLabel(job.status)}</strong> · <code>{job.id}</code>
						<p>
							{job.trigger?.type} · {zh ? "尝试次数" : "Attempts"}: {job.attempts ?? 0}
						</p>
						{job.error && (
							<p className="dc-bot-error" role="alert">
								{job.error}
							</p>
						)}
						{job.status === "failed" && (
							<button type="button" className="btn" disabled={disabled || !!pending} onClick={() => void retryJob(job)}>
								{pending === job.id ? (zh ? "重试中…" : "Retrying…") : zh ? "重试 Router 运行" : "Retry Router run"}
							</button>
						)}
					</div>
				))}
			</details>
		</section>
	);
}
