import { useEffect, useRef, useState } from "react";
import {
	FiPlus,
	FiCopy,
	FiCheck,
	FiRefreshCw,
	FiTrash2,
	FiEdit2,
	FiSend,
	FiArrowDownCircle,
	FiArrowUpCircle,
	FiAlertCircle,
	FiGlobe,
	FiSliders,
} from "react-icons/fi";
import { appUrl } from "../base-url";
import { withToken } from "../auth-token";
import { useT } from "../i18n";
import type { MessageKey } from "../i18n/catalog";
import type { GroupWebhook, GroupWebhookEventType } from "../device-group-messages";

interface GroupWebhooksProps {
	roomId: string;
	disabled?: boolean;
}

const ALL_EVENTS: { id: GroupWebhookEventType; key: MessageKey }[] = [
	{ id: "message", key: "groupWebhooksEventMessage" },
	{ id: "task_completed", key: "groupWebhooksEventTaskCompleted" },
	{ id: "task_failed", key: "groupWebhooksEventTaskFailed" },
	{ id: "delivery", key: "groupWebhooksEventDelivery" },
];

export function GroupWebhooks({ roomId, disabled = false }: GroupWebhooksProps) {
	const t = useT();

	const [webhooks, setWebhooks] = useState<GroupWebhook[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [modalOpen, setModalOpen] = useState(false);
	const [editingHook, setEditingHook] = useState<GroupWebhook | null>(null);

	const [hubStatusUrl, setHubStatusUrl] = useState("");
	const [customRelayUrl, setCustomRelayUrl] = useState("");
	const [showRelayConfig, setShowRelayConfig] = useState(false);
	const [relayConfigInput, setRelayConfigInput] = useState("");
	const [savingRelay, setSavingRelay] = useState(false);
	const [incomingUrlMode, setIncomingUrlMode] = useState<"hub" | "direct">("hub");

	const [copiedKey, setCopiedKey] = useState<string | null>(null);
	const [testingId, setTestingId] = useState<string | null>(null);
	const [testResult, setTestResult] = useState<{ id: string; success: boolean; message: string } | null>(null);

	const abortRef = useRef<AbortController | null>(null);

	const fetchWebhooks = async () => {
		if (abortRef.current) abortRef.current.abort();
		const controller = new AbortController();
		abortRef.current = controller;
		try {
			setError("");
			const [webhooksRes, roomRes, statusRes] = await Promise.all([
				fetch(withToken(appUrl(`/api/device-center/rooms/${encodeURIComponent(roomId)}/webhooks`)), {
					signal: controller.signal,
				}),
				fetch(withToken(appUrl(`/api/device-center/rooms/${encodeURIComponent(roomId)}`)), {
					signal: controller.signal,
				}).catch(() => null),
				fetch(withToken(appUrl("/api/device-center/status")), {
					signal: controller.signal,
				}).catch(() => null),
			]);

			if (!webhooksRes.ok) {
				const err = await webhooksRes.json().catch(() => ({}));
				throw new Error(err.error || `HTTP ${webhooksRes.status}`);
			}
			const data = await webhooksRes.json();
			setWebhooks(data.webhooks || []);

			if (roomRes && roomRes.ok) {
				const rData = await roomRes.json();
				const savedBase = rData.room?.hubRelayBaseUrl || "";
				setCustomRelayUrl(savedBase);
				setRelayConfigInput(savedBase);
			}

			if (statusRes && statusRes.ok) {
				const sData = await statusRes.json();
				if (sData.hubUrl) {
					setHubStatusUrl(sData.hubUrl);
				}
			}
		} catch (err: any) {
			if (!controller.signal.aborted) {
				setError(err?.message || t("groupWebhooksLoadFailed"));
			}
		} finally {
			if (!controller.signal.aborted) {
				setLoading(false);
			}
		}
	};

	useEffect(() => {
		setLoading(true);
		void fetchWebhooks();
		return () => {
			if (abortRef.current) abortRef.current.abort();
		};
	}, [roomId]);

	const effectiveHubBase = customRelayUrl || hubStatusUrl || window.location.origin;

	const handleSaveHubRelay = async () => {
		setSavingRelay(true);
		setError("");
		try {
			const res = await fetch(withToken(appUrl(`/api/device-center/rooms/${encodeURIComponent(roomId)}/hub-relay`)), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ hubRelayBaseUrl: relayConfigInput.trim() || null }),
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data.error || t("groupWebhooksRelayUpdateFailed"));
			}
			setCustomRelayUrl(relayConfigInput.trim());
			setShowRelayConfig(false);
		} catch (err: any) {
			setError(err?.message || t("groupWebhooksRelaySaveFailed"));
		} finally {
			setSavingRelay(false);
		}
	};

	const copyText = (text: string, key: string) => {
		void navigator.clipboard.writeText(text);
		setCopiedKey(key);
		setTimeout(() => setCopiedKey(null), 2000);
	};

	const handleToggleEnabled = async (hook: GroupWebhook) => {
		try {
			const res = await fetch(
				withToken(
					appUrl(`/api/device-center/rooms/${encodeURIComponent(roomId)}/webhooks/${encodeURIComponent(hook.id)}`),
				),
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ enabled: !hook.enabled }),
				},
			);
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				throw new Error(err.error || t("groupWebhooksToggleFailed"));
			}
			await fetchWebhooks();
		} catch (err: any) {
			setError(err?.message || t("groupWebhooksToggleError"));
		}
	};

	const handleDelete = async (id: string) => {
		if (!window.confirm(t("groupWebhooksDeleteConfirm"))) return;
		try {
			const res = await fetch(
				withToken(
					appUrl(`/api/device-center/rooms/${encodeURIComponent(roomId)}/webhooks/${encodeURIComponent(id)}/delete`),
				),
				{ method: "POST" },
			);
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				throw new Error(err.error || t("groupWebhooksDeleteFailed"));
			}
			await fetchWebhooks();
		} catch (err: any) {
			setError(err?.message || t("groupWebhooksDeleteError"));
		}
	};

	const handleRegenerateToken = async (id: string) => {
		if (!window.confirm(t("groupWebhooksRegenerateConfirm"))) {
			return;
		}
		try {
			const res = await fetch(
				withToken(
					appUrl(
						`/api/device-center/rooms/${encodeURIComponent(roomId)}/webhooks/${encodeURIComponent(id)}/regenerate-token`,
					),
				),
				{ method: "POST" },
			);
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				throw new Error(err.error || t("groupWebhooksRegenerateFailed"));
			}
			await fetchWebhooks();
		} catch (err: any) {
			setError(err?.message || t("groupWebhooksRegenerateError"));
		}
	};

	const handleTest = async (hook: GroupWebhook) => {
		setTestingId(hook.id);
		setTestResult(null);
		try {
			const res = await fetch(
				withToken(
					appUrl(`/api/device-center/rooms/${encodeURIComponent(roomId)}/webhooks/${encodeURIComponent(hook.id)}/test`),
				),
				{ method: "POST" },
			);
			const data = await res.json().catch(() => ({}));
			if (res.ok && data.success) {
				const relayNotice = hook.relayViaHub !== false ? t("groupWebhooksViaHubSuffix") : "";
				setTestResult({
					id: hook.id,
					success: true,
					message: t("groupWebhooksTestSuccess", { relay: relayNotice, status: data.status ?? 200 }),
				});
			} else {
				setTestResult({
					id: hook.id,
					success: false,
					message: data.error || t("groupWebhooksTestFailed"),
				});
			}
		} catch (err: any) {
			setTestResult({
				id: hook.id,
				success: false,
				message: err?.message || t("groupWebhooksNetworkFailed"),
			});
		} finally {
			setTestingId(null);
		}
	};

	const incomingHooks = webhooks.filter((w) => w.type === "incoming");
	const outgoingHooks = webhooks.filter((w) => w.type === "outgoing");

	return (
		<div className="group-webhooks-container">
			<div className="group-webhooks-header">
				<div className="group-webhooks-desc">
					<p>{t("groupWebhooksDesc")}</p>
				</div>
				<button
					type="button"
					className="btn primary group-webhooks-add-btn"
					disabled={disabled}
					onClick={() => {
						setEditingHook(null);
						setModalOpen(true);
					}}
				>
					<FiPlus />
					<span>{t("groupWebhooksAdd")}</span>
				</button>
			</div>

			{error && (
				<div className="group-webhooks-error-banner" role="alert">
					<FiAlertCircle />
					<span>{error}</span>
				</div>
			)}

			<div className="group-webhook-relay-bar">
				<div className="group-webhook-relay-info">
					<FiGlobe className="icon-hub" />
					<div className="group-webhook-relay-text">
						<strong>{t("groupWebhooksHubBaseLabel")}</strong>
						<code>{effectiveHubBase}</code>
						{customRelayUrl && <span className="badge-custom">{t("groupWebhooksCustom")}</span>}
					</div>
				</div>
				<button
					type="button"
					className="btn secondary sm"
					onClick={() => setShowRelayConfig(!showRelayConfig)}
					title={t("groupWebhooksRelayUrlHint")}
				>
					<FiSliders />
					<span>{t("groupWebhooksRelayUrl")}</span>
				</button>
			</div>

			{showRelayConfig && (
				<div className="group-webhook-relay-config-box">
					<div className="group-webhook-relay-config-fields">
						<label>{t("groupWebhooksHubBaseHint")}</label>
						<div className="group-webhook-relay-input-row">
							<input
								type="url"
								className="input"
								placeholder="https://hub.example.com"
								value={relayConfigInput}
								onChange={(e) => setRelayConfigInput(e.target.value)}
							/>
							<button type="button" className="btn primary sm" disabled={savingRelay} onClick={handleSaveHubRelay}>
								{savingRelay ? t("groupWebhooksSaving") : t("groupWebhooksSaveRelay")}
							</button>
							{customRelayUrl && (
								<button
									type="button"
									className="btn secondary sm"
									disabled={savingRelay}
									onClick={() => {
										setRelayConfigInput("");
										void handleSaveHubRelay();
									}}
								>
									{t("groupWebhooksReset")}
								</button>
							)}
						</div>
					</div>
				</div>
			)}

			{loading ? (
				<div className="group-webhooks-loading">{t("groupWebhooksLoading")}</div>
			) : webhooks.length === 0 ? (
				<div className="group-webhooks-empty">
					<div className="group-webhooks-empty-icon">🔗</div>
					<h4>{t("groupWebhooksEmptyTitle")}</h4>
					<p>{t("groupWebhooksEmptyDesc")}</p>
				</div>
			) : (
				<div className="group-webhooks-list">
					{incomingHooks.length > 0 && (
						<div className="group-webhooks-section">
							<div className="group-webhooks-section-header">
								<h4 className="group-webhooks-section-title">
									<FiArrowDownCircle className="icon-incoming" />
									<span>{t("groupWebhooksIncomingTitle")}</span>
									<span className="badge">{incomingHooks.length}</span>
								</h4>
								<div className="group-webhook-mode-toggle" title={t("groupWebhooksModeHint")}>
									<button
										type="button"
										className={`mode-btn ${incomingUrlMode === "hub" ? "active" : ""}`}
										onClick={() => setIncomingUrlMode("hub")}
									>
										🌐 {t("groupWebhooksModeHub")}
									</button>
									<button
										type="button"
										className={`mode-btn ${incomingUrlMode === "direct" ? "active" : ""}`}
										onClick={() => setIncomingUrlMode("direct")}
									>
										💻 {t("groupWebhooksModeDirect")}
									</button>
								</div>
							</div>

							<div className="group-webhooks-cards">
								{incomingHooks.map((hook) => {
									const baseUrl = incomingUrlMode === "hub" ? effectiveHubBase : window.location.origin;
									const hookUrl = `${baseUrl}/api/rooms/${roomId}/webhooks/incoming/${hook.id}?token=${hook.token}`;
									const curlSnippet = `curl -X POST "${hookUrl}" -H "Content-Type: application/json" -d '{"text":"Hello from Webhook","senderName":"${hook.name}"}'`;
									return (
										<div key={hook.id} className={`group-webhook-card ${hook.enabled ? "enabled" : "disabled"}`}>
											<div className="group-webhook-card-header">
												<div className="group-webhook-name-box">
													<strong className="group-webhook-name">{hook.name}</strong>
													<span className={`group-webhook-badge ${hook.enabled ? "badge-active" : "badge-inactive"}`}>
														{hook.enabled ? t("groupWebhooksActive") : t("groupWebhooksDisabled")}
													</span>
													<span className="group-webhook-badge badge-relay">
														{incomingUrlMode === "hub"
															? t("groupWebhooksBadgeHubRelay")
															: t("groupWebhooksBadgeDirect")}
													</span>
													{hook.allowBotTrigger !== false && (
														<span className="group-webhook-badge badge-info" title={t("groupWebhooksTriggerHint")}>
															{t("groupWebhooksTriggerBadge")}
														</span>
													)}
												</div>
												<div className="group-webhook-actions">
													<button
														type="button"
														className="btn-icon-subtle"
														title={t("groupWebhooksEdit")}
														disabled={disabled}
														onClick={() => {
															setEditingHook(hook);
															setModalOpen(true);
														}}
													>
														<FiEdit2 />
													</button>
													<button
														type="button"
														className="btn-icon-subtle danger"
														title={t("groupWebhooksDelete")}
														disabled={disabled}
														onClick={() => handleDelete(hook.id)}
													>
														<FiTrash2 />
													</button>
													<button
														type="button"
														role="switch"
														aria-checked={hook.enabled}
														className={`set-switch ${hook.enabled ? "on" : ""}`}
														disabled={disabled}
														onClick={() => handleToggleEnabled(hook)}
														title={t("groupWebhooksToggleHint")}
													>
														<span className="set-switch-knob" />
													</button>
												</div>
											</div>

											<div className="group-webhook-field">
												<label>
													{t("groupWebhooksIncomingUrlLabel")}
													<span className="mode-indicator">
														(
														{incomingUrlMode === "hub"
															? t("groupWebhooksForwardedViaHub")
															: t("groupWebhooksDirectAccess")}
														)
													</span>
												</label>
												<div className="group-webhook-url-row">
													<code className="group-webhook-code">{hookUrl}</code>
													<button
														type="button"
														className="btn secondary sm"
														title={t("groupWebhooksCopyUrlHint")}
														onClick={() => copyText(hookUrl, `url-${hook.id}`)}
													>
														{copiedKey === `url-${hook.id}` ? <FiCheck /> : <FiCopy />}
														<span>
															{copiedKey === `url-${hook.id}` ? t("groupWebhooksCopied") : t("groupWebhooksCopy")}
														</span>
													</button>
													<button
														type="button"
														className="btn secondary sm"
														title={t("groupWebhooksRegenerateHint")}
														disabled={disabled}
														onClick={() => handleRegenerateToken(hook.id)}
													>
														<FiRefreshCw />
													</button>
												</div>
											</div>

											<div className="group-webhook-field">
												<label>{t("groupWebhooksCurlLabel")}</label>
												<div className="group-webhook-curl-box">
													<code>{curlSnippet}</code>
													<button
														type="button"
														className="btn-icon-subtle"
														title={t("groupWebhooksCopyCurlHint")}
														onClick={() => copyText(curlSnippet, `curl-${hook.id}`)}
													>
														{copiedKey === `curl-${hook.id}` ? <FiCheck /> : <FiCopy />}
													</button>
												</div>
											</div>
										</div>
									);
								})}
							</div>
						</div>
					)}

					{outgoingHooks.length > 0 && (
						<div className="group-webhooks-section">
							<h4 className="group-webhooks-section-title">
								<FiArrowUpCircle className="icon-outgoing" />
								<span>{t("groupWebhooksOutgoingTitle")}</span>
								<span className="badge">{outgoingHooks.length}</span>
							</h4>
							<div className="group-webhooks-cards">
								{outgoingHooks.map((hook) => {
									const isTesting = testingId === hook.id;
									const result = testResult?.id === hook.id ? testResult : null;
									const isRelayed = hook.relayViaHub !== false;
									return (
										<div key={hook.id} className={`group-webhook-card ${hook.enabled ? "enabled" : "disabled"}`}>
											<div className="group-webhook-card-header">
												<div className="group-webhook-name-box">
													<strong className="group-webhook-name">{hook.name}</strong>
													<span className={`group-webhook-badge ${hook.enabled ? "badge-active" : "badge-inactive"}`}>
														{hook.enabled ? t("groupWebhooksActive") : t("groupWebhooksDisabled")}
													</span>
													<span
														className={`group-webhook-badge ${isRelayed ? "badge-relay" : "badge-direct"}`}
														title={isRelayed ? t("groupWebhooksRelayedHint") : t("groupWebhooksDirectOutboundHint")}
													>
														{isRelayed ? t("groupWebhooksBadgeRelayed") : t("groupWebhooksBadgeDirectOutbound")}
													</span>
													{hook.secret ? (
														<span className="group-webhook-badge badge-secret" title={t("groupWebhooksSignedHint")}>
															{t("groupWebhooksSigned")}
														</span>
													) : null}
												</div>
												<div className="group-webhook-actions">
													<button
														type="button"
														className="btn secondary sm"
														disabled={disabled || isTesting}
														onClick={() => handleTest(hook)}
														title={t("groupWebhooksTestHint")}
													>
														<FiSend />
														<span>{isTesting ? t("groupWebhooksTesting") : t("groupWebhooksTest")}</span>
													</button>
													<button
														type="button"
														className="btn-icon-subtle"
														title={t("groupWebhooksEdit")}
														disabled={disabled}
														onClick={() => {
															setEditingHook(hook);
															setModalOpen(true);
														}}
													>
														<FiEdit2 />
													</button>
													<button
														type="button"
														className="btn-icon-subtle danger"
														title={t("groupWebhooksDelete")}
														disabled={disabled}
														onClick={() => handleDelete(hook.id)}
													>
														<FiTrash2 />
													</button>
													<button
														type="button"
														role="switch"
														aria-checked={hook.enabled}
														className={`set-switch ${hook.enabled ? "on" : ""}`}
														disabled={disabled}
														onClick={() => handleToggleEnabled(hook)}
														title={t("groupWebhooksToggleHint")}
													>
														<span className="set-switch-knob" />
													</button>
												</div>
											</div>

											<div className="group-webhook-field">
												<label>{t("groupWebhooksTargetUrlLabel")}</label>
												<code className="group-webhook-code">{hook.url}</code>
											</div>

											<div className="group-webhook-field">
												<label>{t("groupWebhooksEventsLabel")}</label>
												<div className="group-webhook-event-chips">
													{(
														hook.events ||
														(["message", "task_completed", "task_failed", "delivery"] as GroupWebhookEventType[])
													).map((ev: GroupWebhookEventType) => {
														const def = ALL_EVENTS.find((e) => e.id === ev);
														return (
															<span key={ev} className="group-webhook-event-chip">
																{def ? t(def.key) : ev}
															</span>
														);
													})}
												</div>
											</div>

											{result && (
												<div className={`group-webhook-test-result ${result.success ? "success" : "failed"}`}>
													{result.success ? <FiCheck /> : <FiAlertCircle />}
													<span>{result.message}</span>
												</div>
											)}
										</div>
									);
								})}
							</div>
						</div>
					)}
				</div>
			)}

			{modalOpen && (
				<WebhookEditModal
					roomId={roomId}
					webhook={editingHook}
					onClose={() => {
						setModalOpen(false);
						setEditingHook(null);
					}}
					onSaved={async () => {
						setModalOpen(false);
						setEditingHook(null);
						await fetchWebhooks();
					}}
				/>
			)}
		</div>
	);
}

function WebhookEditModal({
	roomId,
	webhook,
	onClose,
	onSaved,
}: {
	roomId: string;
	webhook: GroupWebhook | null;
	onClose(): void;
	onSaved(): void;
}) {
	const t = useT();

	const isEditing = Boolean(webhook);
	const [name, setName] = useState(webhook?.name || "");
	const [type, setType] = useState<"incoming" | "outgoing">(webhook?.type || "incoming");
	const [enabled, setEnabled] = useState(webhook ? webhook.enabled : true);
	const [allowBotTrigger, setAllowBotTrigger] = useState(webhook ? webhook.allowBotTrigger !== false : true);
	const [relayViaHub, setRelayViaHub] = useState(webhook ? webhook.relayViaHub !== false : true);
	const [url, setUrl] = useState(webhook?.url || "");
	const [secret, setSecret] = useState(webhook?.secret || "");
	const [events, setEvents] = useState<GroupWebhookEventType[]>(
		webhook?.events || ["message", "task_completed", "task_failed", "delivery"],
	);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState("");

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!name.trim()) {
			setError(t("groupWebhooksNameRequired"));
			return;
		}
		if (type === "outgoing" && (!url.trim() || !/^https?:\/\/.+/i.test(url.trim()))) {
			setError(t("groupWebhooksUrlRequired"));
			return;
		}

		setSubmitting(true);
		setError("");
		try {
			const body: Record<string, unknown> = {
				name: name.trim(),
				enabled,
			};
			if (!isEditing) {
				body.type = type;
			}
			if (type === "incoming") {
				body.allowBotTrigger = allowBotTrigger;
			} else {
				body.url = url.trim();
				body.secret = secret.trim() || undefined;
				body.events = events;
				body.relayViaHub = relayViaHub;
			}

			const endpoint = isEditing
				? `/api/device-center/rooms/${encodeURIComponent(roomId)}/webhooks/${encodeURIComponent(webhook!.id)}`
				: `/api/device-center/rooms/${encodeURIComponent(roomId)}/webhooks`;

			const res = await fetch(withToken(appUrl(endpoint)), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});

			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data.error || t("groupWebhooksSaveFailed"));
			}
			onSaved();
		} catch (err: any) {
			setError(err?.message || t("groupWebhooksSaveError"));
		} finally {
			setSubmitting(false);
		}
	};

	const toggleEvent = (ev: GroupWebhookEventType) => {
		if (events.includes(ev)) {
			if (events.length === 1) return;
			setEvents(events.filter((item) => item !== ev));
		} else {
			setEvents([...events, ev]);
		}
	};

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="group-webhook-modal-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
				<div className="gwm-header">
					<div className="gwm-title-box">
						<h3>
							<span className="gwm-title-icon">🔗</span>{" "}
							{isEditing ? t("groupWebhooksModalEditTitle") : t("groupWebhooksModalNewTitle")}
						</h3>
						<p className="gwm-subtitle">{t("groupWebhooksModalSubtitle")}</p>
					</div>
					<button
						type="button"
						className="gwm-close-btn"
						onClick={onClose}
						aria-label={t("groupWebhooksClose")}
						title={t("groupWebhooksClose")}
					>
						✕
					</button>
				</div>

				<form onSubmit={handleSubmit}>
					<div className="gwm-body">
						{error && (
							<div className="group-webhooks-error-banner" role="alert">
								<FiAlertCircle />
								<span>{error}</span>
							</div>
						)}

						{!isEditing && (
							<div className="gwm-form-group">
								<label className="gwm-label">{t("groupWebhooksTypeLabel")}</label>
								<div className="gwm-type-cards">
									<div
										className={`gwm-type-card ${type === "incoming" ? "selected" : ""}`}
										onClick={() => setType("incoming")}
										role="button"
										tabIndex={0}
									>
										<span className="gwm-type-check">✓</span>
										<div className="gwm-type-card-head">
											<span className="gwm-type-icon incoming">📥</span>
											<span className="gwm-type-name">{t("groupWebhooksIncomingName")}</span>
										</div>
										<p className="gwm-type-desc">{t("groupWebhooksIncomingDesc")}</p>
									</div>

									<div
										className={`gwm-type-card ${type === "outgoing" ? "selected" : ""}`}
										onClick={() => setType("outgoing")}
										role="button"
										tabIndex={0}
									>
										<span className="gwm-type-check">✓</span>
										<div className="gwm-type-card-head">
											<span className="gwm-type-icon outgoing">📤</span>
											<span className="gwm-type-name">{t("groupWebhooksOutgoingName")}</span>
										</div>
										<p className="gwm-type-desc">{t("groupWebhooksOutgoingDesc")}</p>
									</div>
								</div>
							</div>
						)}

						<div className="gwm-form-group">
							<label htmlFor="webhook-name" className="gwm-label">
								{t("groupWebhooksNameLabel")}
							</label>
							<input
								id="webhook-name"
								type="text"
								className="gwm-input"
								placeholder={t("groupWebhooksNamePlaceholder")}
								value={name}
								maxLength={80}
								onChange={(e) => setName(e.target.value)}
								autoFocus
							/>
						</div>

						{type === "incoming" ? (
							<div className="gwm-switch-row" onClick={() => setAllowBotTrigger(!allowBotTrigger)}>
								<div className="gwm-switch-text">
									<span className="gwm-switch-title">{t("groupWebhooksAllowTriggerTitle")}</span>
									<span className="gwm-switch-desc">{t("groupWebhooksAllowTriggerDesc")}</span>
								</div>
								<button
									type="button"
									role="switch"
									aria-checked={allowBotTrigger}
									className={`set-switch ${allowBotTrigger ? "on" : ""}`}
									onClick={(e) => {
										e.stopPropagation();
										setAllowBotTrigger(!allowBotTrigger);
									}}
								>
									<span className="set-switch-knob" />
								</button>
							</div>
						) : (
							<>
								<div className="gwm-form-group">
									<label htmlFor="webhook-url" className="gwm-label">
										{t("groupWebhooksTargetEndpointLabel")}
									</label>
									<input
										id="webhook-url"
										type="url"
										className="gwm-input"
										placeholder="https://example.com/webhook/endpoint"
										value={url}
										onChange={(e) => setUrl(e.target.value)}
									/>
									<span className="gwm-field-hint">{t("groupWebhooksTargetEndpointHint")}</span>
								</div>

								<div className="gwm-switch-row" onClick={() => setRelayViaHub(!relayViaHub)}>
									<div className="gwm-switch-text">
										<span className="gwm-switch-title">{t("groupWebhooksRelayTitle")}</span>
										<span className="gwm-switch-desc">{t("groupWebhooksRelayDesc")}</span>
									</div>
									<button
										type="button"
										role="switch"
										aria-checked={relayViaHub}
										className={`set-switch ${relayViaHub ? "on" : ""}`}
										onClick={(e) => {
											e.stopPropagation();
											setRelayViaHub(!relayViaHub);
										}}
									>
										<span className="set-switch-knob" />
									</button>
								</div>

								<div className="gwm-form-group">
									<label htmlFor="webhook-secret" className="gwm-label">
										{t("groupWebhooksSecretLabel")}
									</label>
									<input
										id="webhook-secret"
										type="text"
										className="gwm-input"
										placeholder={t("groupWebhooksSecretPlaceholder")}
										value={secret}
										maxLength={256}
										onChange={(e) => setSecret(e.target.value)}
									/>
								</div>

								<div className="gwm-form-group">
									<label className="gwm-label">{t("groupWebhooksEventsTitle")}</label>
									<div className="gwm-events-grid">
										{ALL_EVENTS.map((item) => (
											<div
												key={item.id}
												className={`gwm-event-chip ${events.includes(item.id) ? "active" : ""}`}
												onClick={() => toggleEvent(item.id)}
											>
												<span className="gwm-chip-box">{events.includes(item.id) ? "✓" : ""}</span>
												<span>{t(item.key)}</span>
											</div>
										))}
									</div>
								</div>
							</>
						)}

						<div className="gwm-switch-row" onClick={() => setEnabled(!enabled)}>
							<div className="gwm-switch-text">
								<span className="gwm-switch-title">{t("groupWebhooksEnabledTitle")}</span>
								<span className="gwm-switch-desc">{t("groupWebhooksEnabledDesc")}</span>
							</div>
							<button
								type="button"
								role="switch"
								aria-checked={enabled}
								className={`set-switch ${enabled ? "on" : ""}`}
								onClick={(e) => {
									e.stopPropagation();
									setEnabled(!enabled);
								}}
							>
								<span className="set-switch-knob" />
							</button>
						</div>
					</div>

					<div className="gwm-footer">
						<button type="button" className="btn secondary" onClick={onClose} disabled={submitting}>
							{t("groupWebhooksCancel")}
						</button>
						<button type="submit" className="btn primary" disabled={submitting}>
							{submitting
								? t("groupWebhooksSaving")
								: isEditing
									? t("groupWebhooksSaveChanges")
									: t("groupWebhooksCreate")}
						</button>
					</div>
				</form>
			</div>
		</div>
	);
}
