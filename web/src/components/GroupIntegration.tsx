import { useEffect, useRef, useState } from "react";
import { artifactRefsMatch, deliveryReviewMatches } from "../../../server/device-center/delivery-subject";
import {
	INTEGRATION_UI_TIMEOUT_MS,
	VERIFICATION_UI_TIMEOUT_MS,
} from "../../../server/device-center/verification-limits";
import { appUrl } from "../base-url";
import { withToken } from "../auth-token";
import { useT } from "../i18n";
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
	/** Retained for existing callers; this panel resolves text through useT(). */
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
}: GroupIntegrationProps) {
	const t = useT();
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
						? t("groupIntegration.exhaustedReceiptRecorded")
						: t("groupIntegration.exhaustedOutcomeUnknown")
					: t("groupIntegration.exhaustedVerifying"),
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
		t,
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
			setError(t("groupIntegration.selectCommandRequired"));
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
				{t("groupIntegration.title")} ·{" "}
				{isApplied
					? t("groupIntegration.statusMerged")
					: publicationUnknown
						? t("groupIntegration.publicationUnknown")
						: activeIntegration
							? activeIntegration.status
							: t("groupIntegration.statusReady")}
			</summary>
			<div style={{ marginTop: "0.5rem" }}>
				<p style={{ margin: "0 0 0.5rem 0", fontSize: "0.85rem", color: "var(--text-faint)" }}>
					{t("groupIntegration.intro", {
						commit: delivery.commit ? ` (${delivery.commit.slice(0, 8)})` : "",
					})}
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
								? t("groupIntegration.publicationApplied", {
										proof: activeIntegration.publishReceipt?.proof ?? "legacy",
									})
								: publicationUnknown
									? t("groupIntegration.publicationUnknownDetail")
									: t("groupIntegration.publicationCancelledBeforeWrite")}
						</p>
						<div>
							{t("groupIntegration.intentLabel")}
							<code>{activeIntegration.publishIntent.id}</code>
						</div>
						<div>
							{t("groupIntegration.candidateLabel")}
							<code>{activeIntegration.publishIntent.candidateSha}</code>
						</div>
						<p>
							{t("groupIntegration.observationLabel")}
							{activeIntegration.publishObservation ? (
								<>
									{activeIntegration.publishObservation.target} · {activeIntegration.publishObservation.phase}{" "}
									<code>{activeIntegration.publishObservation.targetSha}</code>
								</>
							) : (
								t("groupIntegration.observationUnknown")
							)}
						</p>
						{activeIntegration.publishStop && (
							<p>
								{!activeIntegration.publishStop.stopConfirmed
									? t("groupIntegration.stopUnconfirmed")
									: activeIntegration.publishStop.pastEffect === "unknown"
										? t("groupIntegration.stopConfirmedOutcomeUnknown")
										: t("groupIntegration.stopConfirmed")}
							</p>
						)}
						<button
							type="button"
							className="btn"
							disabled={disabled || busy}
							onClick={() => void handlePublicationAction("reconcile")}
						>
							{t("groupIntegration.reconcile")}
						</button>
						{canResume && (
							<button
								type="button"
								className="btn"
								disabled={disabled || busy}
								onClick={() => void handlePublicationAction("resume")}
							>
								{t("groupIntegration.resumeIntent")}
							</button>
						)}
					</div>
				)}
				{isApplied && !activeIntegration?.publishReceipt && <p role="status">{t("groupIntegration.legacyApplied")}</p>}
				{legacyUnknown && <p role="status">{t("groupIntegration.legacyUnknown")}</p>}
				{!activeIntegration || isCancelled ? (
					<div className="gi-prepare-form" style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
						<div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
							<label style={{ fontSize: "0.85rem" }}>
								{t("groupIntegration.targetBotWorkspace")}
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
								{t("groupIntegration.targetBranchField")}
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
								{busy ? t("groupIntegration.preparing") : t("groupIntegration.prepare")}
							</button>
						</div>
					</div>
				) : (
					<div className="gi-active-task" style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
						<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
							<span style={{ fontSize: "0.85rem", fontWeight: 600 }}>
								{t("groupIntegration.statusLabel")}
								<span
									style={{
										color: isApplied ? "var(--green, #10b981)" : isConflict ? "var(--red, #f43f5e)" : "var(--accent)",
									}}
								>
									{publicationUnknown ? t("groupIntegration.publicationUnknown") : activeIntegration.status}
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
									{isApplied ? t("groupIntegration.fenceWrites") : t("groupIntegration.cancelIntegration")}
								</button>
							)}
						</div>

						<div style={{ fontSize: "0.8rem", color: "var(--text-faint)" }}>
							<span>
								{t("groupIntegration.targetBranch")}
								<code>{activeIntegration.targetBranch}</code>
							</span>
							{activeIntegration.expectedTargetSha && (
								<span style={{ marginLeft: "1rem" }}>
									{t("groupIntegration.targetSha")}
									<code>{activeIntegration.expectedTargetSha.slice(0, 8)}</code>
								</span>
							)}
							{activeIntegration.newCommitSha && (
								<span style={{ marginLeft: "1rem" }}>
									{t("groupIntegration.newCommitSha")}
									<code>{activeIntegration.newCommitSha.slice(0, 8)}</code>
								</span>
							)}
						</div>

						{isConflict && activeIntegration.conflicts && (
							<div style={{ background: "rgba(244, 63, 94, 0.1)", padding: "0.5rem", borderRadius: "4px" }}>
								<strong style={{ color: "var(--red, #f43f5e)", fontSize: "0.85rem" }}>
									{t("groupIntegration.conflictsDetected")}
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
										<summary>{t("groupIntegration.viewConflictDiff")}</summary>
										<pre style={{ maxHeight: "150px", overflow: "auto", fontSize: "0.75rem" }}>
											{activeIntegration.diff}
										</pre>
									</details>
								)}
							</div>
						)}

						{activeIntegration.diff && !isConflict && (
							<details style={{ fontSize: "0.85rem", margin: "0.25rem 0" }}>
								<summary>{t("groupIntegration.diffPreview")}</summary>
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
									{t("groupIntegration.verificationCommands")}
								</div>
								<p style={{ fontSize: "0.75rem", color: "var(--text-faint)", margin: "0 0 0.25rem 0" }}>
									{planLocked ? t("groupIntegration.commandsLocked") : t("groupIntegration.commandsAuthorize")}
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
													{t("groupIntegration.botClaimed", { status: c.status })}
												</span>
											</label>
										))}
									</div>
								)}

								<div style={{ display: "flex", gap: "0.5rem", marginTop: "0.25rem" }}>
									<input
										type="text"
										placeholder={t("groupIntegration.commandPlaceholder")}
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
											? t("groupIntegration.verifying")
											: t("groupIntegration.verify")}
									</button>
								</div>

								{activeIntegration.validationCommands.length > 0 && (
									<div style={{ marginTop: "0.5rem" }}>
										<div style={{ fontSize: "0.8rem", fontWeight: 600 }}>{t("groupIntegration.validationResults")}</div>
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
												{v.exitCode !== undefined && ` ${t("groupIntegration.exitCode", { code: v.exitCode })}`}
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
								<p role="status">{t("groupIntegration.verificationLocked")}</p>
								<details>
									<summary>{t("groupIntegration.verificationResults")}</summary>
									{activeIntegration.verification.results.map((result, index) => (
										<div key={index}>
											<code>{result.command}</code> · {result.status}{" "}
											{t("groupIntegration.exitCode", { code: result.exitCode })}
											<pre style={{ maxHeight: "150px", overflow: "auto" }}>{result.outputPreview}</pre>
										</div>
									))}
								</details>
							</div>
						)}
						{activeIntegration.verification && !canApply && !isApplied && !activeIntegration.publishIntent && (
							<p>{t("groupIntegration.reviewRequired")}</p>
						)}
						{!isApplied && canStartNew && (
							<button type="button" className="btn" disabled={disabled || busy} onClick={() => void handlePrepare()}>
								{t("groupIntegration.newIntegration")}
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
										? t("groupIntegration.applying")
										: t("groupIntegration.confirmMerge", { branch: activeIntegration.targetBranch })}
								</button>
								<span style={{ fontSize: "0.75rem", color: "var(--text-faint)" }}>
									{t("groupIntegration.confirmMergeHint")}
								</span>
							</div>
						)}

						{isApplied && (
							<div
								style={{ color: "var(--green, #10b981)", fontSize: "0.85rem", fontWeight: 600, marginTop: "0.25rem" }}
							>
								✓ {t("groupIntegration.appliedRecorded", { branch: activeIntegration.targetBranch })}
							</div>
						)}
					</div>
				)}
			</div>
		</details>
	);
}
