import { useEffect, useRef, useState } from "react";
import { appUrl } from "../base-url";
import { withToken } from "../auth-token";
import { isZhLocale, useI18n } from "../i18n";
import { randomUuid } from "../uuid";
import { groupAttention, groupAttentionLabel } from "../group-attention";
import type { GroupBotConversation, GroupDevice } from "../device-group-messages";
import type { DeviceDelivery, DeviceReview, DeviceReviewRequest } from "../types";
import { GroupIntegration } from "./GroupIntegration";

async function request<T>(path: string, signal: AbortSignal, body?: object): Promise<T> {
	const response = await fetch(withToken(appUrl(`/api/device-center/${path}`)), {
		method: body ? "POST" : "GET",
		credentials: "same-origin",
		signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
		...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
	});
	const data = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(data.error || String(response.status));
	return data;
}

export function GroupDeliveries({
	roomId,
	conversations,
	bots,
	disabled,
	error,
}: {
	roomId: string;
	conversations: GroupBotConversation[];
	bots: GroupDevice[];
	disabled?: boolean;
	error?: string;
}) {
	const { locale } = useI18n();
	const zh = isZhLocale(locale);
	const [attentionOnly, setAttentionOnly] = useState(true);
	const attentionCount = conversations.filter((conversation) => groupAttention(conversation)).length;
	const visible = attentionOnly ? conversations.filter((conversation) => groupAttention(conversation)) : conversations;
	return (
		<details className="gd-panel">
			<summary>
				{zh ? "需要我处理" : "Needs attention"} · {attentionCount} · {zh ? "全部对话" : "All conversations"}{" "}
				{conversations.length}
			</summary>
			<div className="gd-content">
				{error && <p role="alert">{error}</p>}
				<label>
					<input type="checkbox" checked={attentionOnly} onChange={(event) => setAttentionOnly(event.target.checked)} />
					{zh ? "仅显示需要处理的事项" : "Show only items needing attention"}
				</label>
				{!visible.length && (
					<p>
						{attentionOnly
							? zh
								? "当前没有需要处理的事项。"
								: "Nothing needs attention right now."
							: zh
								? "暂无 Bot 对话。"
								: "No Bot conversations yet."}
					</p>
				)}
				{visible.map((conversation) => (
					<ConversationDelivery
						key={`${roomId}:${conversation.id}`}
						roomId={roomId}
						conversation={conversation}
						bot={bots.find((bot) => bot.id === conversation.botId)?.name ?? conversation.botId}
						bots={bots}
						disabled={disabled || !!error}
						zh={zh}
					/>
				))}
			</div>
		</details>
	);
}

function ConversationDelivery({
	roomId,
	conversation,
	bot,
	bots = [],
	disabled,
	zh,
}: {
	roomId: string;
	conversation: GroupBotConversation;
	bot: string;
	bots?: GroupDevice[];
	disabled?: boolean;
	zh: boolean;
}) {
	const attention = groupAttention(conversation);
	const [history, setHistory] = useState<{ deliveries: DeviceDelivery[]; reviews: DeviceReview[] } | null>(null);
	const [historyError, setHistoryError] = useState("");
	const [historyOpen, setHistoryOpen] = useState(false);
	const [loading, setLoading] = useState(false);
	const loaded = useRef(false);
	useEffect(() => {
		controller.current?.abort();
		controller.current = null;
		loaded.current = false;
		setHistory(null);
		setLoading(false);
	}, [conversation.latestDelivery?.id, conversation.reviewCount]);
	const controller = useRef<AbortController | null>(null);
	useEffect(() => () => controller.current?.abort(), []);
	useEffect(() => {
		if (disabled) controller.current?.abort();
	}, [disabled]);
	const deliveries = conversation.deliveries ?? (conversation.latestDelivery ? [conversation.latestDelivery] : []);
	const reviews = conversation.reviews ?? (conversation.latestReview ? [conversation.latestReview] : []);
	const latest = deliveries[deliveries.length - 1];
	const base = `rooms/${encodeURIComponent(roomId)}/conversations/${encodeURIComponent(conversation.id)}`;
	async function loadHistory() {
		if (loaded.current || disabled || (controller.current && !controller.current.signal.aborted)) return;
		const pending = new AbortController();
		controller.current = pending;
		setLoading(true);
		try {
			const data = await request<{ deliveries: DeviceDelivery[]; reviews: DeviceReview[] }>(base, pending.signal);
			if (pending.signal.aborted) return;
			loaded.current = true;
			setHistory(data);
			setHistoryError("");
		} catch (cause) {
			if (!pending.signal.aborted) setHistoryError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			if (!pending.signal.aborted) setLoading(false);
			if (controller.current === pending) controller.current = null;
		}
	}
	useEffect(() => {
		if (historyOpen) void loadHistory();
	}, [historyOpen, conversation.latestDelivery?.id, conversation.reviewCount, disabled]);
	return (
		<section className="gd-conversation" aria-label={`${bot} · ${conversation.name}`}>
			<strong>
				{bot} · {conversation.name || (zh ? "未命名对话" : "Untitled conversation")}
			</strong>
			<p>
				{zh ? "执行状态" : "Execution status"}: {conversation.status}
			</p>
			{attention && <p role="status">{groupAttentionLabel(attention, zh)}</p>}
			{conversation.attention && (
				<HumanAnswer
					key={conversation.attention.id}
					roomId={roomId}
					conversation={conversation}
					disabled={disabled}
					zh={zh}
				/>
			)}
			{(attention === "failed" || attention === "interrupted" || attention === "changes_requested") && (
				<p>
					{zh
						? "在输入框输入 @，选择此 Bot 的原对话补充要求或继续处理。"
						: "Type @ in the composer and select this Bot's existing conversation to continue."}
				</p>
			)}
			{conversation.deliverySummaryTruncated && !history && (
				<p>{zh ? "当前为摘要，请展开完整交付后验收。" : "Summary only. Load the full delivery before reviewing."}</p>
			)}
			{latest ? (
				<DeliveryCard
					key={latest.id}
					roomId={roomId}
					conversationId={conversation.id}
					bots={bots}
					delivery={history?.deliveries.find((d) => d.id === latest.id) ?? latest}
					reviews={[...(history?.reviews ?? []), ...reviews]}
					base={base}
					disabled={disabled || (!!conversation.deliverySummaryTruncated && !history)}
					zh={zh}
				/>
			) : (
				<p>{zh ? "未交付（执行结束不代表已交付）" : "Not delivered (execution ending does not imply delivery)"}</p>
			)}
			{latest && (
				<details
					className="gd-history"
					onToggle={(event) => {
						setHistoryOpen(event.currentTarget.open);
					}}
				>
					<summary>
						{zh ? "完整交付与历史" : "Full delivery & history"} · {conversation.deliveryCount ?? deliveries.length}
					</summary>
					{loading && <p role="status">{zh ? "加载中…" : "Loading…"}</p>}
					{historyError && (
						<p role="alert">
							{historyError}{" "}
							<button type="button" className="btn" onClick={() => void loadHistory()}>
								{zh ? "重试" : "Retry"}
							</button>
						</p>
					)}
					{(conversation.deliveries ?? history?.deliveries ?? [])
						.filter((d) => d.id !== latest?.id)
						.map((delivery) => (
							<DeliveryCard
								key={delivery.id}
								delivery={delivery}
								reviews={conversation.reviews ?? history?.reviews ?? []}
								base={base}
								disabled={disabled}
								readOnly
								zh={zh}
							/>
						))}
				</details>
			)}
		</section>
	);
}

function HumanAnswer({
	roomId,
	conversation,
	disabled,
	zh,
}: {
	roomId: string;
	conversation: GroupBotConversation;
	disabled?: boolean;
	zh: boolean;
}) {
	const [answer, setAnswer] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [sent, setSent] = useState(false);
	const controller = useRef<AbortController | null>(null);
	const retry = useRef<{ text: string; key: string } | null>(null);
	useEffect(() => () => controller.current?.abort(), []);
	useEffect(() => {
		if (disabled) controller.current?.abort();
	}, [disabled]);
	async function submit() {
		if (disabled || busy || sent || !answer.trim() || !conversation.attention) return;
		const pending = new AbortController();
		controller.current = pending;
		if (retry.current?.text !== answer.trim()) retry.current = { text: answer.trim(), key: randomUuid() };
		setBusy(true);
		try {
			await request(
				`rooms/${encodeURIComponent(roomId)}/conversations/${encodeURIComponent(conversation.id)}/messages`,
				pending.signal,
				{
					text: retry.current.text,
					attentionId: conversation.attention.id,
					idempotencyKey: retry.current.key,
				},
			);
			if (!pending.signal.aborted) {
				setSent(true);
				setError("");
			}
		} catch (cause) {
			if (!pending.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			if (controller.current === pending) {
				controller.current = null;
				setBusy(false);
			}
		}
	}
	return (
		<div>
			<p>{conversation.attention?.question}</p>
			{sent ? (
				<p role="status">{zh ? "已回复，原会话将继续。" : "Answer sent. The original conversation will continue."}</p>
			) : (
				<form
					onSubmit={(event) => {
						event.preventDefault();
						void submit();
					}}
				>
					<label>
						{zh ? "你的答复" : "Your answer"}
						<textarea
							value={answer}
							maxLength={8000}
							disabled={disabled || busy}
							onChange={(event) => setAnswer(event.target.value)}
						/>
					</label>
					<button
						type="submit"
						className="btn"
						disabled={disabled || busy || !answer.trim() || conversation.status === "closed"}
					>
						{zh ? "回复并继续" : "Answer & continue"}
					</button>
					{error && <p role="alert">{error}</p>}
				</form>
			)}
		</div>
	);
}

function DeliveryCard({
	delivery,
	reviews,
	base,
	roomId,
	conversationId,
	bots = [],
	disabled,
	readOnly = false,
	zh,
}: {
	delivery: DeviceDelivery;
	reviews: DeviceReview[];
	base: string;
	roomId?: string;
	conversationId?: string;
	bots?: GroupDevice[];
	disabled?: boolean;
	readOnly?: boolean;
	zh: boolean;
}) {
	const [saved, setSaved] = useState<DeviceReview | null>(null);
	const [summary, setSummary] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState("");
	const controller = useRef<AbortController | null>(null);
	const retry = useRef<{ fingerprint: string; key: string } | null>(null);
	useEffect(() => () => controller.current?.abort(), []);
	useEffect(() => {
		if (disabled) controller.current?.abort();
	}, [disabled]);
	const matching = [...reviews, ...(saved ? [saved] : [])].filter(
		(r) => r.deliveryId === delivery.id && r.commit === delivery.commit,
	);
	const review = matching.sort((a, b) => b.createdAt - a.createdAt)[0];
	async function submit(verdict: DeviceReviewRequest["verdict"]) {
		if (readOnly || disabled || controller.current || !summary.trim()) return;
		const fingerprint = JSON.stringify([delivery.id, delivery.commit, verdict, summary.trim()]);
		if (retry.current?.fingerprint !== fingerprint) retry.current = { fingerprint, key: randomUuid() };
		const current = new AbortController();
		controller.current = current;
		setPending(true);
		setError("");
		try {
			const data = await request<{ review: DeviceReview }>(`${base}/reviews`, current.signal, {
				deliveryId: delivery.id,
				commit: delivery.commit,
				verdict,
				summary: summary.trim(),
				idempotencyKey: retry.current.key,
			});
			if (current.signal.aborted) return;
			setSaved(data.review);
			setSummary("");
			retry.current = null;
		} catch (cause) {
			if (!current.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			if (controller.current === current) {
				controller.current = null;
				setPending(false);
			}
		}
	}
	return (
		<article className="gd-delivery">
			<p className="gd-status" role="status">
				{review
					? review.verdict === "accepted"
						? zh
							? "验收通过"
							: "Accepted"
						: zh
							? "需返工"
							: "Changes requested"
					: zh
						? "已交付 · 待验收"
						: "Delivered · Awaiting review"}
			</p>
			<dl>
				<dt>{zh ? "交付版本 ID" : "Delivery version ID"}</dt>
				<dd>{delivery.id}</dd>
				<dt>{zh ? "仓库" : "Repository"}</dt>
				<dd>{delivery.repository}</dd>
				<dt>Commit SHA</dt>
				<dd>
					<code>{delivery.commit}</code>
				</dd>
				<dt>{zh ? "基线 SHA" : "Base SHA"}</dt>
				<dd>
					<code>{delivery.baseCommit}</code>
				</dd>
				{delivery.branch && (
					<>
						<dt>{zh ? "分支" : "Branch"}</dt>
						<dd>{delivery.branch}</dd>
					</>
				)}
				<dt>{zh ? "交付摘要" : "Summary"}</dt>
				<dd>{delivery.summary}</dd>
				<dt>{zh ? "限制与未完成项" : "Limitations"}</dt>
				<dd>
					{delivery.limitations.length
						? delivery.limitations.join("\n")
						: zh
							? "Bot 未报告限制"
							: "No limitations reported by Bot"}
				</dd>
			</dl>
			<p>
				{zh
					? "检查来源：Bot 自报，未经宿主或 CI 验证。"
					: "Checks source: Bot self-report; not verified by host or CI."}
			</p>
			{delivery.checks.length ? (
				<ul>
					{delivery.checks.map((check, index) => (
						<li key={index}>
							<code>{check.command}</code> · {check.status} · {check.result}
							{check.exitCode !== undefined && ` (exit ${check.exitCode})`}
						</li>
					))}
				</ul>
			) : (
				<p>{zh ? "Bot 未报告检查" : "No checks reported by Bot"}</p>
			)}
			{review && (
				<p>
					{zh ? "验收意见" : "Review"} ({review.reviewer.type === "human" ? (zh ? "人工" : "Human") : "Bot"}) ·{" "}
					{review.summary}
				</p>
			)}
			{!readOnly && (
				<form onSubmit={(event) => event.preventDefault()}>
					<label>
						{zh
							? "人工验收意见（绑定以上交付版本与 SHA）"
							: "Human review (bound to the delivery version and SHA above)"}
						<textarea
							value={summary}
							onChange={(event) => setSummary(event.target.value)}
							disabled={disabled || pending}
							rows={2}
							required
						/>
					</label>
					<div className="gd-actions">
						<button
							type="button"
							className="btn"
							disabled={disabled || pending || !summary.trim()}
							onClick={() => void submit("accepted")}
						>
							{zh ? "验收通过" : "Accept delivery"}
						</button>
						<button
							type="button"
							className="btn"
							disabled={disabled || pending || !summary.trim()}
							onClick={() => void submit("changes_requested")}
						>
							{zh ? "需返工" : "Request changes"}
						</button>
					</div>
					{pending && <p role="status">{zh ? "提交中…" : "Submitting…"}</p>}
					{error && <p role="alert">{error}</p>}
				</form>
			)}
			{review && review.verdict === "accepted" && roomId && conversationId && (
				<GroupIntegration
					key={`${roomId}:${conversationId}:${delivery.id}:${review.id}`}
					roomId={roomId}
					conversationId={conversationId}
					delivery={delivery}
					review={review}
					bots={bots}
					disabled={disabled}
					zh={zh}
				/>
			)}
		</article>
	);
}
