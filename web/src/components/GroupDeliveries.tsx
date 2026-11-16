import { useEffect, useRef, useState } from "react";
import { artifactRefsMatch, deliveryReviewMatches } from "../../../server/device-center/delivery-subject";
import { appUrl } from "../base-url";
import { withToken } from "../auth-token";
import { isZhLocale, useI18n, useT } from "../i18n";
import { randomUuid } from "../uuid";
import { groupAttention, groupAttentionKey } from "../group-attention";
import type { GroupBotConversation, GroupDevice } from "../device-group-messages";
import type { DeviceDelivery, DeviceIntegration, DeviceReview, DeviceReviewRequest } from "../types";
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
	onRefresh,
}: {
	roomId: string;
	conversations: GroupBotConversation[];
	bots: GroupDevice[];
	disabled?: boolean;
	error?: string;
	onRefresh?: () => void;
}) {
	const { locale } = useI18n();
	const t = useT();
	const zh = isZhLocale(locale);
	const [attentionOnly, setAttentionOnly] = useState(true);
	const attentionCount = conversations.filter((conversation) => groupAttention(conversation)).length;
	const visible = attentionOnly ? conversations.filter((conversation) => groupAttention(conversation)) : conversations;
	return (
		<details className="gd-panel">
			<summary>
				{t("groupDeliveriesNeedsAttention")} · {attentionCount} · {t("groupDeliveriesAllConversations")}{" "}
				{conversations.length}
			</summary>
			<div className="gd-content">
				{error && <p role="alert">{error}</p>}
				<label>
					<input type="checkbox" checked={attentionOnly} onChange={(event) => setAttentionOnly(event.target.checked)} />
					{t("groupDeliveriesAttentionOnly")}
				</label>
				{!visible.length && (
					<p>{attentionOnly ? t("groupDeliveriesNothingPending") : t("groupDeliveriesNoConversations")}</p>
				)}
				{visible.map((conversation) => (
					<ConversationDelivery
						key={`${roomId}:${conversation.id}`}
						roomId={roomId}
						conversation={conversation}
						bot={bots.find((bot) => bot.id === conversation.botId)?.name ?? conversation.botId}
						bots={bots}
						disabled={disabled || !!error}
						onRefresh={onRefresh}
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
	onRefresh,
	zh,
}: {
	roomId: string;
	conversation: GroupBotConversation;
	bot: string;
	bots?: GroupDevice[];
	disabled?: boolean;
	onRefresh?: () => void;
	zh: boolean;
}) {
	const t = useT();
	const attention = groupAttention(conversation);
	const [deleting, setDeleting] = useState(false);
	const [deleteError, setDeleteError] = useState("");
	const [stopping, setStopping] = useState(false);
	const [stopError, setStopError] = useState("");
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
				{bot} · {conversation.name || t("groupDeliveriesUntitledConversation")}
			</strong>
			<p>
				{t("groupDeliveriesExecutionStatus")}: {conversation.status}
			</p>
			{conversation.closedReason && (
				<p role="status">
					{conversation.closedReason === "device_revoked"
						? t("groupDeliveriesDeviceRevoked")
						: t("groupDeliveriesConversationStopped")}
				</p>
			)}
			{conversation.stale && <p role="status">{t("groupDeliveriesStale")}</p>}
			{conversation.status !== "closed" && !conversation.stale && (
				<>
					<button
						type="button"
						className="btn"
						disabled={disabled || stopping}
						onClick={async () => {
							if (disabled || stopping) return;
							setStopping(true);
							setStopError("");
							try {
								await request(
									`rooms/${encodeURIComponent(roomId)}/conversations/${encodeURIComponent(conversation.id)}/stop`,
									AbortSignal.timeout(15000),
									{},
								);
								onRefresh?.();
							} catch (cause) {
								setStopError(cause instanceof Error ? cause.message : String(cause));
							} finally {
								setStopping(false);
							}
						}}
					>
						{t("groupDeliveriesCloseConversation")}
					</button>
					{stopError && <p role="alert">{stopError}</p>}
				</>
			)}
			{(conversation.status === "closed" || conversation.stale) && !conversation.deliveryCount && (
				<>
					<button
						type="button"
						className="btn"
						disabled={disabled || deleting}
						onClick={async () => {
							if (disabled || deleting) return;
							setDeleting(true);
							setDeleteError("");
							try {
								await request(
									`rooms/${encodeURIComponent(roomId)}/conversations/${encodeURIComponent(conversation.id)}/delete`,
									AbortSignal.timeout(15000),
									{},
								);
								onRefresh?.();
							} catch (cause) {
								setDeleteError(cause instanceof Error ? cause.message : String(cause));
							} finally {
								setDeleting(false);
							}
						}}
					>
						{t("groupDeliveriesDeleteConversation")}
					</button>
					{deleteError && <p role="alert">{deleteError}</p>}
				</>
			)}
			{attention && <p role="status">{t(groupAttentionKey(attention))}</p>}
			{conversation.attention && (
				<HumanAnswer key={conversation.attention.id} roomId={roomId} conversation={conversation} disabled={disabled} />
			)}
			{(attention === "failed" || attention === "interrupted" || attention === "changes_requested") && (
				<p>{t("groupDeliveriesContinueHint")}</p>
			)}
			{conversation.deliverySummaryTruncated && !history && <p>{t("groupDeliveriesSummaryOnly")}</p>}
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
				<p>{t("groupDeliveriesNotDelivered")}</p>
			)}
			{latest && (
				<details
					className="gd-history"
					onToggle={(event) => {
						setHistoryOpen(event.currentTarget.open);
					}}
				>
					<summary>
						{t("groupDeliveriesFullHistory")} · {conversation.deliveryCount ?? deliveries.length}
					</summary>
					{loading && <p role="status">{t("loading")}</p>}
					{historyError && (
						<p role="alert">
							{historyError}{" "}
							<button type="button" className="btn" onClick={() => void loadHistory()}>
								{t("groupDeliveriesRetry")}
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
}: {
	roomId: string;
	conversation: GroupBotConversation;
	disabled?: boolean;
}) {
	const t = useT();
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
				<p role="status">{t("groupDeliveriesAnswerSent")}</p>
			) : (
				<form
					onSubmit={(event) => {
						event.preventDefault();
						void submit();
					}}
				>
					<label>
						{t("groupDeliveriesYourAnswer")}
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
						{t("groupDeliveriesAnswerContinue")}
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
	const t = useT();
	const [saved, setSaved] = useState<DeviceReview | null>(null);
	const [integration, setIntegration] = useState<DeviceIntegration | null>(null);
	const [criteria, setCriteria] = useState<{ met: boolean; evidence: string }[]>([]);
	useEffect(() => {
		setCriteria([]);
	}, [integration?.id, integration?.verification?.digest]);
	const [summary, setSummary] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState("");
	const controller = useRef<AbortController | null>(null);
	const retry = useRef<{ fingerprint: string; key: string } | null>(null);
	useEffect(() => () => controller.current?.abort(), []);
	useEffect(() => {
		if (disabled) controller.current?.abort();
	}, [disabled]);
	const matching = [...reviews, ...(saved ? [saved] : [])].filter((r) => deliveryReviewMatches(delivery, r));
	const verified =
		integration?.deliveryId === delivery.id &&
		integration.status === "verified" &&
		!!integration.verification?.digest &&
		artifactRefsMatch(delivery.artifactRef, integration.artifactRef);
	const criteriaComplete =
		Array.isArray(delivery.acceptanceCriteria) &&
		delivery.acceptanceCriteria!.every((_, index) => criteria[index]?.met && criteria[index]?.evidence.trim());
	const canAccept = !delivery.artifactRef || (verified && criteriaComplete);
	const review = matching.sort((a, b) => b.createdAt - a.createdAt)[0];
	async function submit(verdict: DeviceReviewRequest["verdict"]) {
		if (readOnly || disabled || controller.current || !summary.trim() || (verdict === "accepted" && !canAccept)) return;
		const evidence = delivery.artifactRef
			? {
					artifactDigest: delivery.artifactRef.artifactDigest,
					...(verdict === "accepted"
						? {
								integrationId: integration!.id,
								verificationDigest: integration!.verification!.digest,
								criteriaResults: delivery.acceptanceCriteria!.map((_, criterionIndex) => ({
									criterionIndex,
									verdict: "met" as const,
									evidence: criteria[criterionIndex].evidence.trim(),
								})),
							}
						: {}),
				}
			: { commit: delivery.commit };
		const fingerprint = JSON.stringify([delivery.id, evidence, verdict, summary.trim()]);
		if (retry.current?.fingerprint !== fingerprint) retry.current = { fingerprint, key: randomUuid() };
		const current = new AbortController();
		controller.current = current;
		setPending(true);
		setError("");
		try {
			const data = await request<{ review: DeviceReview }>(`${base}/reviews`, current.signal, {
				deliveryId: delivery.id,
				...evidence,
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
						? t("groupDeliveriesAccepted")
						: t("groupDeliveriesChangesRequested")
					: t("groupDeliveriesAwaitingReview")}
			</p>
			<dl>
				<dt>{t("groupDeliveriesDeliveryId")}</dt>
				<dd>{delivery.id}</dd>
				<dt>{t("groupDeliveriesRepository")}</dt>
				<dd>{delivery.repository}</dd>
				{delivery.commit && (
					<>
						<dt>Commit SHA</dt>
						<dd>
							<code>{delivery.commit}</code>
						</dd>
					</>
				)}
				{delivery.artifactRef && (
					<>
						<dt>{t("groupDeliveriesArtifact")}</dt>
						<dd>{delivery.artifactRef.artifactId}</dd>
						<dt>{t("groupDeliveriesSourceTask")}</dt>
						<dd>{delivery.artifactRef.artifactTaskId}</dd>
						<dt>{t("groupDeliveriesContentDigest")}</dt>
						<dd>
							<code>{delivery.artifactRef.artifactDigest}</code>
						</dd>
						<dt>{t("groupDeliveriesFileTree")}</dt>
						<dd>
							<code>{delivery.artifactRef.outputTree}</code>
						</dd>
					</>
				)}
				<dt>{t("groupDeliveriesBaseSha")}</dt>
				<dd>
					<code>{delivery.baseCommit}</code>
				</dd>
				{delivery.branch && (
					<>
						<dt>{t("groupDeliveriesBranch")}</dt>
						<dd>{delivery.branch}</dd>
					</>
				)}
				<dt>{t("groupDeliveriesSummary")}</dt>
				<dd>{delivery.summary}</dd>
				<dt>{t("groupDeliveriesLimitations")}</dt>
				<dd>{delivery.limitations.length ? delivery.limitations.join("\n") : t("groupDeliveriesNoLimitations")}</dd>
			</dl>
			<p>{t("groupDeliveriesChecksSource")}</p>
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
				<p>{t("groupDeliveriesNoChecks")}</p>
			)}
			{review && (
				<p>
					{t("groupDeliveriesReview")} ({review.reviewer.type === "human" ? t("groupDeliveriesHuman") : "Bot"}) ·{" "}
					{review.summary}
				</p>
			)}
			{!readOnly && (
				<form onSubmit={(event) => event.preventDefault()}>
					<label>
						{t("groupDeliveriesHumanReview")}
						<textarea
							value={summary}
							onChange={(event) => setSummary(event.target.value)}
							disabled={disabled || pending}
							rows={2}
							required
						/>
					</label>
					{delivery.artifactRef && (
						<fieldset disabled={disabled || pending || !verified}>
							<legend>{t("groupDeliveriesCriteria")}</legend>
							<p>
								{verified
									? t("groupDeliveriesReviewingVerification", { id: integration!.id })
									: t("groupDeliveriesVerifyFirst")}
							</p>
							{delivery.acceptanceCriteria?.map((criterion, index) => (
								<div key={index}>
									<label>
										<input
											type="checkbox"
											checked={criteria[index]?.met ?? false}
											onChange={(event) =>
												setCriteria((prev) => {
													const next = [...prev];
													next[index] = { evidence: prev[index]?.evidence ?? "", met: event.target.checked };
													return next;
												})
											}
										/>
										{criterion}
									</label>
									<label>
										{t("groupDeliveriesEvidence")}
										<textarea
											value={criteria[index]?.evidence ?? ""}
											maxLength={2000}
											onChange={(event) =>
												setCriteria((prev) => {
													const next = [...prev];
													next[index] = { met: prev[index]?.met ?? false, evidence: event.target.value };
													return next;
												})
											}
										/>
									</label>
								</div>
							))}
						</fieldset>
					)}
					<div className="gd-actions">
						<button
							type="button"
							className="btn"
							disabled={disabled || pending || !summary.trim() || !canAccept}
							onClick={() => void submit("accepted")}
						>
							{t("groupDeliveriesAccept")}
						</button>
						<button
							type="button"
							className="btn"
							disabled={disabled || pending || !summary.trim()}
							onClick={() => void submit("changes_requested")}
						>
							{t("groupDeliveriesRequestChanges")}
						</button>
					</div>
					{pending && <p role="status">{t("groupDeliveriesSubmitting")}</p>}
					{error && <p role="alert">{error}</p>}
				</form>
			)}
			{!readOnly && roomId && conversationId && (
				<GroupIntegration
					key={`${roomId}:${conversationId}:${delivery.id}`}
					roomId={roomId}
					conversationId={conversationId}
					delivery={delivery}
					review={review}
					onIntegrationChange={setIntegration}
					bots={bots}
					disabled={disabled}
					zh={zh}
				/>
			)}
		</article>
	);
}
