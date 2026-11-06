import { useEffect, useRef, useState } from "react";
import { artifactRefsMatch, deliveryReviewMatches } from "../../../server/device-center/delivery-subject";
import {
	INTEGRATION_UI_TIMEOUT_MS,
	VERIFICATION_UI_TIMEOUT_MS,
} from "../../../server/device-center/verification-limits";
import { appUrl } from "../base-url";
import { withToken } from "../auth-token";
import type { GroupDevice } from "../device-group-messages";
import type { DeviceDelivery, DeviceIntegration, DeviceIntegrationListResponse, DeviceReview } from "../types";

function publicationPending(integration: DeviceIntegration | null | undefined): boolean {
	return (
		!!integration?.publishIntent &&
		((!!integration.publishStop && !integration.publishStop.stopConfirmed) ||
			(!integration.publishReceipt && !(integration.publishStop?.closed && integration.publishStop.stopConfirmed)))
	);
}

async function request<T>(path: string, signal: AbortSignal, body?: object, timeoutMs = 30000): Promise<T> {
	const response = await fetch(withToken(appUrl(`/api/device-center/${path}`)), {
		method: body ? "POST" : "GET",
		credentials: "same-origin",
		signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
		...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
	});
	const data = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(data.error || String(response.status));
	return data;
}

export interface GroupIntegrationProps {
	roomId: string;
	conversationId: string;
	delivery: DeviceDelivery;
	review?: DeviceReview;
	onIntegrationChange?: (integration: DeviceIntegration | null) => void;
	bots: GroupDevice[];
	disabled?: boolean;
	zh: boolean;
}

export function GroupIntegration({
	roomId,
	conversationId,
	delivery,
	review,
	onIntegrationChange,
	bots,
	disabled = false,
	zh,
}: GroupIntegrationProps) {
	const [, setIntegrations] = useState<DeviceIntegration[]>([]);
	const [activeIntegration, setActiveIntegration] = useState<DeviceIntegration | null>(null);
	const [canResumePublication, setCanResumePublication] = useState(false);
	const [targetBotId, setTargetBotId] = useState<string>(delivery.botId || bots[0]?.id || "");
	const [targetBranch, setTargetBranch] = useState<string>(delivery.branch || "main");
	const [selectedCommands, setSelectedCommands] = useState<string[]>([]);
	const [customCommand, setCustomCommand] = useState<string>("");
	const [authorizedCommands, setAuthorizedCommands] = useState<string[] | null>(null);
	useEffect(() => setAuthorizedCommands(null), [activeIntegration?.id]);
	const [busy, setBusy] = useState<boolean>(false);
	const [error, setError] = useState<string>("");
	const [isOpen, setIsOpen] = useState<boolean>(false);

	const controllerRef = useRef<AbortController | null>(null);
	const generationRef = useRef(0);

	const basePath = `rooms/${encodeURIComponent(roomId)}/conversations/${encodeURIComponent(conversationId)}/integrations`;

	useEffect(() => {
		onIntegrationChange?.(activeIntegration);
	}, [activeIntegration, onIntegrationChange]);

	useEffect(() => {
		generationRef.current++;
		controllerRef.current?.abort();
		setActiveIntegration(null);
		setCanResumePublication(false);
		setTargetBotId(delivery.botId || bots[0]?.id || "");
		setTargetBranch(delivery.branch || "main");
		setSelectedCommands([]);
		setCustomCommand("");
		setBusy(false);
		setError("");
	}, [roomId, conversationId, delivery.id, delivery.artifactRef?.artifactDigest, delivery.commit]);

	useEffect(() => {
		if (disabled) {
			generationRef.current++;
			controllerRef.current?.abort();
			setBusy(false);
		}
	}, [disabled]);

	useEffect(() => {
		if (!isOpen) return;
		const generation = ++generationRef.current;
		controllerRef.current?.abort();
		const ctrl = new AbortController();
		controllerRef.current = ctrl;

		setError("");
		setCanResumePublication(false);

		async function load() {
			try {
				const res = await request<DeviceIntegrationListResponse>(basePath, ctrl.signal, undefined, 15000);
				if (ctrl.signal.aborted || generation !== generationRef.current) return;
				setCanResumePublication(res.canResumePublication === true);
				const list = res.integrations || [];
				setIntegrations(list);
				const current = list.filter((it) => it.deliveryId === delivery.id).sort((a, b) => b.createdAt - a.createdAt)[0];
				setActiveIntegration(current || null);
			} catch (cause) {
				if (!ctrl.signal.aborted && generation === generationRef.current) {
					setError(cause instanceof Error ? cause.message : String(cause));
				}
			}
		}

		void load();

		return () => {
			generationRef.current++;
			controllerRef.current?.abort();
			setBusy(false);
		};
	}, [isOpen, roomId, conversationId, delivery.id, delivery.commit, delivery.artifactRef?.artifactDigest]);

	const pendingPublication = publicationPending(activeIntegration);
	useEffect(() => {
		if (
			!isOpen ||
			disabled ||
			busy ||
			!activeIntegration ||
			(activeIntegration.status !== "verifying" && !pendingPublication) ||
			activeIntegration.deliveryId !== delivery.id
		)
			return;
		const integrationId = activeIntegration.id;
		const generation = generationRef.current;
		const ctrl = new AbortController();
		const intervalMs = 5000;
		const budgetMs = pendingPublication ? INTEGRATION_UI_TIMEOUT_MS : VERIFICATION_UI_TIMEOUT_MS;
		const deadline = Date.now() + budgetMs;
		const maxAttempts = Math.ceil(budgetMs / intervalMs);
		let attempts = 0;
		let timer: ReturnType<typeof setTimeout>;
		const current = () => !ctrl.signal.aborted && generation === generationRef.current;
		const exhausted = () =>
			setError(
				pendingPublication
					? activeIntegration.publishReceipt
						? zh
							? "已记录发布效果，原进程停止仍未确认。请稍后回查。"
							: "Publication effect is recorded; original process stop remains unconfirmed. Reconcile later."
						: zh
							? "发布结果仍未知。稍后手动回查；不会自动重发写入。"
							: "Publication outcome remains unknown. Reconcile later; writes are never retried automatically."
					: zh
						? "验证仍在运行，稍后关闭并重新打开此面板以刷新状态。"
						: "Verification is still running. Close and reopen this panel later to refresh its status.",
			);
		async function refresh() {
			if (!current()) return;
			if (Date.now() >= deadline || attempts >= maxAttempts) {
				exhausted();
				return;
			}
			attempts++;
			try {
				let integration: DeviceIntegration | undefined;
				if (pendingPublication) {
					const res = await request<{ integration: DeviceIntegration }>(
						`${basePath}/${encodeURIComponent(integrationId)}/reconcile`,
						ctrl.signal,
						{},
						Math.min(INTEGRATION_UI_TIMEOUT_MS, deadline - Date.now()),
					);
					integration = res.integration;
				} else {
					const res = await request<DeviceIntegrationListResponse>(
						basePath,
						ctrl.signal,
						undefined,
						Math.min(15000, deadline - Date.now()),
					);
					if (!current()) return;
					setCanResumePublication(res.canResumePublication === true);
					integration = res.integrations.find((item) => item.id === integrationId && item.deliveryId === delivery.id);
				}
				if (!current()) return;
				if (integration?.id === integrationId && integration.deliveryId === delivery.id) {
					setActiveIntegration(integration);
					if (integration.status !== "verifying" && !publicationPending(integration)) {
						setError(integration.error ?? "");
						return;
					}
				}
			} catch (cause) {
				if (!current()) return;
				setError(cause instanceof Error ? cause.message : String(cause));
			}
			if (Date.now() >= deadline || attempts >= maxAttempts) {
				exhausted();
				return;
			}
			timer = setTimeout(() => void refresh(), Math.min(intervalMs, deadline - Date.now()));
		}
		timer = setTimeout(() => void refresh(), intervalMs);
		return () => {
			ctrl.abort();
			clearTimeout(timer);
		};
	}, [
		isOpen,
		disabled,
		busy,
		activeIntegration?.id,
		activeIntegration?.status,
		pendingPublication,
		delivery.id,
		basePath,
		zh,
	]);

	async function handlePrepare() {
		if (disabled || busy || !targetBotId || !canStartNew) return;
		const generation = ++generationRef.current;
		controllerRef.current?.abort();
		const ctrl = new AbortController();
		controllerRef.current = ctrl;

		setBusy(true);
		setError("");
		try {
			const res = await request<{ integration: DeviceIntegration }>(
				basePath,
				ctrl.signal,
				{
					deliveryId: delivery.id,
					targetBotId,
					targetBranch: targetBranch.trim() || "main",
				},
				INTEGRATION_UI_TIMEOUT_MS,
			);
			if (ctrl.signal.aborted || generation !== generationRef.current) return;
			setActiveIntegration(res.integration);
			setIntegrations((prev) => [res.integration, ...prev.filter((it) => it.id !== res.integration.id)]);
		} catch (err) {
			if (!ctrl.signal.aborted && generation === generationRef.current) {
				setError(err instanceof Error ? err.message : String(err));
			}
		} finally {
			if (generation === generationRef.current) {
				setBusy(false);
			}
		}
	}

	async function handleVerify() {
		if (disabled || busy || !activeIntegration || !canVerify) return;
		const commandsToRun = [...(activeIntegration.verificationPlan?.commands ?? authorizedCommands ?? selectedCommands)];
		if (
			!activeIntegration.verificationPlan &&
			!authorizedCommands &&
			customCommand.trim() &&
			!commandsToRun.includes(customCommand.trim())
		) {
			commandsToRun.push(customCommand.trim());
		}
		if (commandsToRun.length === 0) {
			setError(zh ? "请勾选或输入至少一条验证命令" : "Select or enter at least one validation command");
			return;
		}

		setAuthorizedCommands(commandsToRun);
		const generation = ++generationRef.current;
		controllerRef.current?.abort();
		const ctrl = new AbortController();
		controllerRef.current = ctrl;

		setBusy(true);
		setError("");
		try {
			const res = await request<{ integration: DeviceIntegration }>(
				`${basePath}/${encodeURIComponent(activeIntegration.id)}/verify`,
				ctrl.signal,
				{ commands: commandsToRun },
				VERIFICATION_UI_TIMEOUT_MS,
			);
			if (ctrl.signal.aborted || generation !== generationRef.current) return;
			setActiveIntegration(res.integration);
			setIntegrations((prev) => prev.map((it) => (it.id === res.integration.id ? res.integration : it)));
		} catch (err) {
			if (!ctrl.signal.aborted && generation === generationRef.current) {
				setError(err instanceof Error ? err.message : String(err));
				try {
					const refreshed = await request<{ integrations: DeviceIntegration[] }>(
						basePath,
						ctrl.signal,
						undefined,
						15000,
					);
					if (!ctrl.signal.aborted && generation === generationRef.current) {
						const current = refreshed.integrations.find((item) => item.id === activeIntegration.id);
						if (current) setActiveIntegration(current);
					}
				} catch (refreshError) {
					if (!ctrl.signal.aborted && generation === generationRef.current) {
						setError(
							`${err instanceof Error ? err.message : String(err)} · ${refreshError instanceof Error ? refreshError.message : String(refreshError)}`,
						);
					}
				}
			}
		} finally {
			if (generation === generationRef.current) {
				setBusy(false);
			}
		}
	}

	async function handleApply() {
		if (disabled || busy || !activeIntegration || !canApply) return;
		const generation = ++generationRef.current;
		controllerRef.current?.abort();
		const ctrl = new AbortController();
		controllerRef.current = ctrl;

		setBusy(true);
		setError("");
		try {
			const res = await request<{ integration: DeviceIntegration }>(
				`${basePath}/${encodeURIComponent(activeIntegration.id)}/apply`,
				ctrl.signal,
				{ expectedTargetSha: activeIntegration.expectedTargetSha },
				INTEGRATION_UI_TIMEOUT_MS,
			);
			if (ctrl.signal.aborted || generation !== generationRef.current) return;
			setActiveIntegration(res.integration);
			setIntegrations((prev) => prev.map((it) => (it.id === res.integration.id ? res.integration : it)));
		} catch (err) {
			if (!ctrl.signal.aborted && generation === generationRef.current) {
				setError(err instanceof Error ? err.message : String(err));
				await refreshAfterPublicationError(activeIntegration.id, ctrl, generation);
			}
		} finally {
			if (generation === generationRef.current) setBusy(false);
		}
	}

	async function refreshAfterPublicationError(id: string, ctrl: AbortController, generation: number) {
		try {
			const res = await request<DeviceIntegrationListResponse>(basePath, ctrl.signal, undefined, 15000);
			if (ctrl.signal.aborted || generation !== generationRef.current) return;
			setCanResumePublication(res.canResumePublication === true);
			const current = res.integrations.find((item) => item.id === id && item.deliveryId === delivery.id);
			if (current) {
				setActiveIntegration(current);
				if (current.publishReceipt || (current.publishStop?.closed && current.publishStop.stopConfirmed))
					setError(current.error ?? "");
			}
		} catch {}
	}

	async function handlePublicationAction(action: "reconcile" | "resume") {
		if (disabled || busy || !activeIntegration?.publishIntent || (action === "resume" && !canResume)) return;
		const integration = activeIntegration;
		const intent = integration.publishIntent!;
		const generation = ++generationRef.current;
		controllerRef.current?.abort();
		const ctrl = new AbortController();
		controllerRef.current = ctrl;
		setBusy(true);
		setError("");
		try {
			const res = await request<{ integration: DeviceIntegration }>(
				`${basePath}/${encodeURIComponent(integration.id)}/${action}`,
				ctrl.signal,
				action === "resume"
					? { intentId: intent.id, intentDigest: intent.digest, candidateSha: intent.candidateSha }
					: {},
				INTEGRATION_UI_TIMEOUT_MS,
			);
			if (ctrl.signal.aborted || generation !== generationRef.current) return;
			setActiveIntegration(res.integration);
			setIntegrations((prev) => prev.map((item) => (item.id === res.integration.id ? res.integration : item)));
		} catch (cause) {
			if (!ctrl.signal.aborted && generation === generationRef.current) {
				setError(cause instanceof Error ? cause.message : String(cause));
				await refreshAfterPublicationError(integration.id, ctrl, generation);
			}
		} finally {
			if (generation === generationRef.current) setBusy(false);
		}
	}

	async function handleCancel() {
		if (disabled || busy || !activeIntegration) return;
		const generation = ++generationRef.current;
		controllerRef.current?.abort();
		const ctrl = new AbortController();
		controllerRef.current = ctrl;

		setBusy(true);
		setError("");
		try {
			const res = await request<{ integration: DeviceIntegration }>(
				`${basePath}/${encodeURIComponent(activeIntegration.id)}/cancel`,
				ctrl.signal,
				{},
				INTEGRATION_UI_TIMEOUT_MS,
			);
			if (ctrl.signal.aborted || generation !== generationRef.current) return;
			setActiveIntegration(res.integration);
			setIntegrations((prev) => prev.map((it) => (it.id === res.integration.id ? res.integration : it)));
		} catch (err) {
			if (!ctrl.signal.aborted && generation === generationRef.current) {
				setError(err instanceof Error ? err.message : String(err));
				await refreshAfterPublicationError(activeIntegration.id, ctrl, generation);
			}
		} finally {
			if (generation === generationRef.current) setBusy(false);
		}
	}

	const isApplied = !!activeIntegration?.publishReceipt || activeIntegration?.status === "applied";
	const closedPublication = !!activeIntegration?.publishStop?.closed && activeIntegration.publishStop.stopConfirmed;
	const legacyUnknown =
		!!activeIntegration &&
		!activeIntegration.publishIntent &&
		(["applying", "cancelling"].includes(activeIntegration.status) ||
			(activeIntegration.status === "failed" &&
				/Apply failed; check target outcome|Publication outcome unknown/.test(activeIntegration.error ?? "")));
	const publicationUnknown =
		!isApplied &&
		((!!activeIntegration?.publishIntent &&
			!(closedPublication && activeIntegration.publishStop?.pastEffect === "not_applied")) ||
			legacyUnknown);
	const canResume =
		canResumePublication &&
		!!activeIntegration?.publishIntent &&
		activeIntegration.publishObservation?.intentId === activeIntegration.publishIntent.id &&
		activeIntegration.publishObservation?.intentDigest === activeIntegration.publishIntent.digest &&
		activeIntegration.publishObservation?.candidateSha === activeIntegration.publishIntent.candidateSha &&
		activeIntegration.publishObservation?.retryable === true &&
		["prepared", "cas_rejected"].includes(activeIntegration.publishObservation.phase) &&
		!activeIntegration.publishStop?.closed &&
		!activeIntegration.publishReceipt &&
		activeIntegration.status !== "cancelling";
	const canStartNew = (!!delivery.artifactRef || acceptedForDelivery()) && !pendingPublication && !legacyUnknown;
	function acceptedForDelivery() {
		return review?.verdict === "accepted" && deliveryReviewMatches(delivery, review);
	}
	const isConflict = activeIntegration?.status === "conflict";
	const isCancelled =
		activeIntegration?.status === "cancelled" &&
		(!activeIntegration.publishIntent ||
			(closedPublication && activeIntegration.publishStop?.pastEffect === "not_applied"));
	const canVerify =
		!activeIntegration?.verification &&
		!activeIntegration?.publishIntent &&
		(activeIntegration?.status === "prepared" ||
			(activeIntegration?.status === "failed" && !!activeIntegration.verificationPlan));
	const planLocked = !!activeIntegration?.verificationPlan || !!authorizedCommands;
	const accepted = review?.verdict === "accepted" && deliveryReviewMatches(delivery, review);
	const canApply =
		activeIntegration?.status === "verified" &&
		!activeIntegration.publishIntent &&
		!!activeIntegration.verification?.digest &&
		accepted &&
		(!delivery.artifactRef
			? activeIntegration.reviewId === review.id
			: artifactRefsMatch(delivery.artifactRef, activeIntegration.artifactRef) &&
				review.integrationId === activeIntegration.id &&
				review.verificationDigest === activeIntegration.verification.digest &&
				Array.isArray(delivery.acceptanceCriteria) &&
				review.criteriaResults?.length === delivery.acceptanceCriteria.length &&
				delivery.acceptanceCriteria.every((_, index) =>
					review.criteriaResults!.some(
						(result) => result.criterionIndex === index && result.verdict === "met" && !!result.evidence.trim(),
					),
				));

	return (
		<details
			className="gi-panel"
			onToggle={(e) => setIsOpen(e.currentTarget.open)}
			style={{ marginTop: "1rem", borderTop: "1px solid var(--border)", paddingTop: "0.75rem" }}
		>
			<summary style={{ cursor: "pointer", fontWeight: 600, fontSize: "0.95rem" }}>
				{zh ? "验证与合并" : "Verify & merge"} ·{" "}
				{isApplied
					? zh
						? "已合并"
						: "Merged"
					: publicationUnknown
						? zh
							? "发布结果未知"
							: "Publication outcome unknown"
						: activeIntegration
							? activeIntegration.status
							: zh
								? "待集成"
								: "Ready to integrate"}
			</summary>
			<div style={{ marginTop: "0.5rem" }}>
				<p style={{ margin: "0 0 0.5rem 0", fontSize: "0.85rem", color: "var(--text-faint)" }}>
					{zh
						? `先在独立工作区验证此交付${delivery.commit ? ` (${delivery.commit.slice(0, 8)})` : ""}，验收通过并确认后才写入目标分支。`
						: `Verify this delivery${delivery.commit ? ` (${delivery.commit.slice(0, 8)})` : ""} in a separate workspace. The target branch changes only after acceptance and your confirmation.`}
				</p>

				{error && (
					<p role="alert" style={{ color: "var(--red, #f43f5e)", fontSize: "0.85rem", margin: "0.25rem 0" }}>
						{error}
					</p>
				)}

				{activeIntegration?.publishIntent && (
					<div className="gi-publication" style={{ overflowWrap: "anywhere", wordBreak: "break-word", minWidth: 0 }}>
						<p role="status">
							{isApplied
								? zh
									? `已记录发布效果（证据：${activeIntegration.publishReceipt?.proof ?? "legacy"}）。`
									: `Publication effect recorded (proof: ${activeIntegration.publishReceipt?.proof ?? "legacy"}).`
								: publicationUnknown
									? zh
										? "发布结果未知。回查只读取证据，不会自动重新写入分支。"
										: "Publication outcome unknown. Reconciliation observes evidence and never retries branch writes."
									: zh
										? "已确认在发布前取消。"
										: "Cancellation before publication is confirmed."}
						</p>
						<div>
							{zh ? "发布意图：" : "Intent: "}
							<code>{activeIntegration.publishIntent.id}</code>
						</div>
						<div>
							{zh ? "候选提交：" : "Candidate: "}
							<code>{activeIntegration.publishIntent.candidateSha}</code>
						</div>
						<p>
							{zh ? "当前目标观察：" : "Current target observation: "}
							{activeIntegration.publishObservation ? (
								<>
									{activeIntegration.publishObservation.target} · {activeIntegration.publishObservation.phase}{" "}
									<code>{activeIntegration.publishObservation.targetSha}</code>
								</>
							) : zh ? (
								"未知（尚未观察）"
							) : (
								"Unknown (not yet observed)"
							)}
						</p>
						{activeIntegration.publishStop && (
							<p>
								{!activeIntegration.publishStop.stopConfirmed
									? zh
										? "已封闭未来写入；原发布进程停止尚未确认，仍保持隔离。"
										: "Future writes are fenced; the original publication process has not been confirmed stopped and remains isolated."
									: activeIntegration.publishStop.pastEffect === "unknown"
										? zh
											? "已封闭写入并确认进程停止；历史发布结果仍未知。"
											: "Writes are fenced and process stop is confirmed; historical publication outcome remains unknown."
										: zh
											? "已确认封闭并停止发布操作。"
											: "Publication operation is fenced and confirmed stopped."}
							</p>
						)}
						<button
							type="button"
							className="btn"
							disabled={disabled || busy}
							onClick={() => void handlePublicationAction("reconcile")}
						>
							{zh ? "回查发布证据" : "Reconcile publication"}
						</button>
						{canResume && (
							<button
								type="button"
								className="btn"
								disabled={disabled || busy}
								onClick={() => void handlePublicationAction("resume")}
							>
								{zh ? "恢复同一发布意图" : "Resume same publication intent"}
							</button>
						)}
					</div>
				)}
				{isApplied && !activeIntegration?.publishReceipt && (
					<p role="status">
						{zh ? "旧记录标记已应用；没有持久发布回执。" : "Legacy applied record; no durable publication receipt."}
					</p>
				)}
				{legacyUnknown && (
					<p role="status">
						{zh
							? "旧发布记录缺少持久意图，历史结果未知。需本机核查；不会自动重试。"
							: "Legacy publication has no durable intent; its historical outcome is unknown. Local inspection is required; it will not retry automatically."}
					</p>
				)}
				{!activeIntegration || isCancelled ? (
					<div className="gi-prepare-form" style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
						<div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
							<label style={{ fontSize: "0.85rem" }}>
								{zh ? "目标工作区 (Bot):" : "Target Bot Workspace:"}
								<select
									value={targetBotId}
									onChange={(e) => setTargetBotId(e.target.value)}
									disabled={disabled || busy}
									style={{ marginLeft: "0.25rem" }}
								>
									{bots.map((b) => (
										<option key={b.id} value={b.id}>
											{b.name || b.id}
										</option>
									))}
								</select>
							</label>

							<label style={{ fontSize: "0.85rem" }}>
								{zh ? "目标分支:" : "Target Branch:"}
								<input
									type="text"
									value={targetBranch}
									onChange={(e) => setTargetBranch(e.target.value)}
									disabled={disabled || busy}
									style={{ marginLeft: "0.25rem", width: "120px" }}
								/>
							</label>

							<button
								type="button"
								className="btn primary"
								disabled={disabled || busy || !targetBotId || !canStartNew}
								onClick={() => void handlePrepare()}
							>
								{busy ? (zh ? "准备中…" : "Preparing…") : zh ? "准备隔离集成" : "Prepare Isolated Integration"}
							</button>
						</div>
					</div>
				) : (
					<div className="gi-active-task" style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
						<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
							<span style={{ fontSize: "0.85rem", fontWeight: 600 }}>
								{zh ? "集成状态: " : "Status: "}
								<span
									style={{
										color: isApplied ? "var(--green, #10b981)" : isConflict ? "var(--red, #f43f5e)" : "var(--accent)",
									}}
								>
									{publicationUnknown
										? zh
											? "发布结果未知"
											: "Publication outcome unknown"
										: activeIntegration.status}
								</span>
							</span>
							{(!isApplied || pendingPublication) && !isCancelled && !closedPublication && (
								<button
									type="button"
									className="btn danger"
									disabled={disabled || busy}
									onClick={() => void handleCancel()}
									style={{ fontSize: "0.75rem", padding: "0.2rem 0.5rem" }}
								>
									{isApplied
										? zh
											? "封闭写入并确认进程停止"
											: "Fence writes & confirm process stop"
										: zh
											? "取消集成"
											: "Cancel"}
								</button>
							)}
						</div>

						<div style={{ fontSize: "0.8rem", color: "var(--text-faint)" }}>
							<span>
								{zh ? "目标分支: " : "Target Branch: "}
								<code>{activeIntegration.targetBranch}</code>
							</span>
							{activeIntegration.expectedTargetSha && (
								<span style={{ marginLeft: "1rem" }}>
									{zh ? "基线 SHA: " : "Target SHA: "}
									<code>{activeIntegration.expectedTargetSha.slice(0, 8)}</code>
								</span>
							)}
							{activeIntegration.newCommitSha && (
								<span style={{ marginLeft: "1rem" }}>
									{zh ? "新提交 SHA: " : "New Commit SHA: "}
									<code>{activeIntegration.newCommitSha.slice(0, 8)}</code>
								</span>
							)}
						</div>

						{isConflict && activeIntegration.conflicts && (
							<div style={{ background: "rgba(244, 63, 94, 0.1)", padding: "0.5rem", borderRadius: "4px" }}>
								<strong style={{ color: "var(--red, #f43f5e)", fontSize: "0.85rem" }}>
									{zh ? "检测到合并冲突！无法自动合并：" : "Merge conflicts detected:"}
								</strong>
								<ul style={{ margin: "0.25rem 0", paddingLeft: "1.2rem", fontSize: "0.8rem" }}>
									{activeIntegration.conflicts.map((file, i) => (
										<li key={i}>
											<code>{file}</code>
										</li>
									))}
								</ul>
								{activeIntegration.diff && (
									<details style={{ marginTop: "0.25rem", fontSize: "0.8rem" }}>
										<summary>{zh ? "查看冲突 Diff" : "View Conflict Diff"}</summary>
										<pre style={{ maxHeight: "150px", overflow: "auto", fontSize: "0.75rem" }}>
											{activeIntegration.diff}
										</pre>
									</details>
								)}
							</div>
						)}

						{activeIntegration.diff && !isConflict && (
							<details style={{ fontSize: "0.85rem", margin: "0.25rem 0" }}>
								<summary>{zh ? "集成 Diff 预览" : "Integration Diff Preview"}</summary>
								<pre
									style={{
										maxHeight: "200px",
										overflow: "auto",
										fontSize: "0.75rem",
										background: "var(--code-bg, rgba(0,0,0,0.2))",
										padding: "0.5rem",
										borderRadius: "4px",
									}}
								>
									{activeIntegration.diff}
								</pre>
							</details>
						)}

						{canVerify && (
							<div
								style={{
									border: "1px solid var(--border)",
									borderRadius: "4px",
									padding: "0.5rem",
									background: "var(--bg-elev2)",
								}}
							>
								<div style={{ fontSize: "0.85rem", fontWeight: 600, marginBottom: "0.25rem" }}>
									{zh ? "验证命令" : "Verification commands"}
								</div>
								<p style={{ fontSize: "0.75rem", color: "var(--text-faint)", margin: "0 0 0.25rem 0" }}>
									{zh
										? planLocked
											? "命令已锁定。重试会运行相同命令；更换命令需要新建验证。"
											: "请由账户所有者选择或填写命令。点击验证即授权执行并锁定这些命令。"
										: planLocked
											? "Commands are locked. A retry runs the same commands; start a new verification to change them."
											: "As the account owner, select or enter commands. Clicking Verify authorizes execution and locks these commands."}
								</p>

								{planLocked && (
									<pre>{(activeIntegration.verificationPlan?.commands ?? authorizedCommands ?? []).join("\n")}</pre>
								)}
								{!planLocked && delivery.checks.length > 0 && (
									<div style={{ display: "flex", flexDirection: "column", gap: "0.25rem", margin: "0.25rem 0" }}>
										{delivery.checks.map((c, i) => (
											<label
												key={i}
												style={{ fontSize: "0.8rem", display: "flex", alignItems: "center", gap: "0.25rem" }}
											>
												<input
													type="checkbox"
													checked={selectedCommands.includes(c.command)}
													disabled={disabled || busy || planLocked}
													onChange={(e) => {
														if (e.target.checked) setSelectedCommands((prev) => [...prev, c.command]);
														else setSelectedCommands((prev) => prev.filter((cmd) => cmd !== c.command));
													}}
												/>
												<code>{c.command}</code>
												<span style={{ color: "var(--text-faint)", fontSize: "0.75rem" }}>
													({zh ? "Bot 自述结果:" : "Bot claimed:"} {c.status})
												</span>
											</label>
										))}
									</div>
								)}

								<div style={{ display: "flex", gap: "0.5rem", marginTop: "0.25rem" }}>
									<input
										type="text"
										placeholder={zh ? "自定义验证命令，如 npm test" : "Custom command, e.g. npm test"}
										value={customCommand}
										onChange={(e) => setCustomCommand(e.target.value)}
										disabled={disabled || busy || planLocked}
										style={{ flex: 1, fontSize: "0.8rem" }}
									/>
									<button
										type="button"
										className="btn"
										disabled={
											disabled || busy || (!planLocked && selectedCommands.length === 0 && !customCommand.trim())
										}
										onClick={() => void handleVerify()}
										style={{ fontSize: "0.8rem" }}
									>
										{busy && activeIntegration.status === "verifying"
											? zh
												? "验证中…"
												: "Verifying…"
											: zh
												? "验证"
												: "Verify"}
									</button>
								</div>

								{activeIntegration.validationCommands.length > 0 && (
									<div style={{ marginTop: "0.5rem" }}>
										<div style={{ fontSize: "0.8rem", fontWeight: 600 }}>
											{zh ? "验证结果：" : "Validation Results:"}
										</div>
										{activeIntegration.validationCommands.map((v, i) => (
											<div key={i} style={{ fontSize: "0.75rem", margin: "0.25rem 0" }}>
												<code>{v.command}</code>:{" "}
												<span
													style={{
														color: v.status === "passed" ? "var(--green, #10b981)" : "var(--red, #f43f5e)",
														fontWeight: 600,
													}}
												>
													{v.status}
												</span>
												{v.exitCode !== undefined && ` (exit ${v.exitCode})`}
												{v.output && (
													<pre
														style={{
															maxHeight: "100px",
															overflow: "auto",
															margin: "0.1rem 0",
															padding: "0.25rem",
															background: "rgba(0,0,0,0.15)",
														}}
													>
														{v.output}
													</pre>
												)}
											</div>
										))}
									</div>
								)}
							</div>
						)}

						{activeIntegration.verification && (
							<div>
								<p role="status">
									{zh
										? "验证已成功并锁定。重新验证请新建整合。"
										: "Verification succeeded and is locked. Start a new integration to verify again."}
								</p>
								<details>
									<summary>{zh ? "验证结果" : "Verification results"}</summary>
									{activeIntegration.verification.results.map((result, index) => (
										<div key={index}>
											<code>{result.command}</code> · {result.status} (exit {result.exitCode})
											<pre style={{ maxHeight: "150px", overflow: "auto" }}>{result.outputPreview}</pre>
										</div>
									))}
								</details>
							</div>
						)}
						{activeIntegration.verification && !canApply && !isApplied && !activeIntegration.publishIntent && (
							<p>
								{zh
									? "请完成与本次验证对应的独立验收，再确认合并。"
									: "Complete an independent review for this verification before confirming the merge."}
							</p>
						)}
						{!isApplied && canStartNew && (
							<button type="button" className="btn" disabled={disabled || busy} onClick={() => void handlePrepare()}>
								{zh ? "新建整合与验证" : "Start a new integration & verification"}
							</button>
						)}

						{canApply && (
							<div style={{ marginTop: "0.5rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
								<button
									type="button"
									className="btn primary"
									disabled={disabled || busy}
									onClick={() => void handleApply()}
									style={{ fontSize: "0.85rem" }}
								>
									{busy && activeIntegration.status === "applying"
										? zh
											? "正在写入目标分支…"
											: "Writing to target branch…"
										: zh
											? `确认合并写入 ${activeIntegration.targetBranch}`
											: `Confirm & Merge into ${activeIntegration.targetBranch}`}
								</button>
								<span style={{ fontSize: "0.75rem", color: "var(--text-faint)" }}>
									{zh
										? "（点击即确认合并，绝不强制覆盖或自动推送）"
										: "(Explicit confirmation; never forces or pushes)"}
								</span>
							</div>
						)}

						{isApplied && (
							<div
								style={{ color: "var(--green, #10b981)", fontSize: "0.85rem", fontWeight: 600, marginTop: "0.25rem" }}
							>
								✓{" "}
								{zh
									? `已记录分支 ${activeIntegration.targetBranch} 的历史发布结果；当前分支状态以上方观察为准。`
									: `Historical publication recorded for branch ${activeIntegration.targetBranch}; see the current target observation above.`}
							</div>
						)}
					</div>
				)}
			</div>
		</details>
	);
}
