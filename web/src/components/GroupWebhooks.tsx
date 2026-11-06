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
import { isZhLocale, useI18n } from "../i18n";
import type { GroupWebhook, GroupWebhookEventType } from "../device-group-messages";

interface GroupWebhooksProps {
	roomId: string;
	disabled?: boolean;
}

const ALL_EVENTS: { id: GroupWebhookEventType; zh: string; en: string }[] = [
	{ id: "message", zh: "新群聊消息", en: "New message" },
	{ id: "task_completed", zh: "Bot 任务成功完成", en: "Task completed" },
	{ id: "task_failed", zh: "Bot 任务执行失败", en: "Task failed" },
	{ id: "delivery", zh: "Bot 代码交付提交", en: "Code delivery" },
];

export function GroupWebhooks({ roomId, disabled = false }: GroupWebhooksProps) {
	const { locale } = useI18n();
	const zh = isZhLocale(locale);

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
				setError(err?.message || (zh ? "加载 Webhooks 失败" : "Failed to load webhooks"));
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
				throw new Error(data.error || "Failed to update Hub relay base URL");
			}
			setCustomRelayUrl(relayConfigInput.trim());
			setShowRelayConfig(false);
		} catch (err: any) {
			setError(err?.message || "Failed to save Hub relay URL");
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
				throw new Error(err.error || "Update failed");
			}
			await fetchWebhooks();
		} catch (err: any) {
			setError(err?.message || "Failed to update webhook");
		}
	};

	const handleDelete = async (id: string) => {
		if (!window.confirm(zh ? "确定要删除该 Webhook 吗？" : "Are you sure you want to delete this webhook?")) return;
		try {
			const res = await fetch(
				withToken(
					appUrl(`/api/device-center/rooms/${encodeURIComponent(roomId)}/webhooks/${encodeURIComponent(id)}/delete`),
				),
				{ method: "POST" },
			);
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				throw new Error(err.error || "Delete failed");
			}
			await fetchWebhooks();
		} catch (err: any) {
			setError(err?.message || "Failed to delete webhook");
		}
	};

	const handleRegenerateToken = async (id: string) => {
		if (
			!window.confirm(
				zh
					? "重新生成 Token 将使旧 Token 立即失效，依赖此 URL 的外部服务需要同步更新。确定重新生成？"
					: "Regenerating the token will invalidate the old one immediately. Continue?",
			)
		) {
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
				throw new Error(err.error || "Regenerate failed");
			}
			await fetchWebhooks();
		} catch (err: any) {
			setError(err?.message || "Failed to regenerate token");
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
				const relayNotice = hook.relayViaHub !== false ? (zh ? " [Hub中转]" : " [via Hub]") : "";
				setTestResult({
					id: hook.id,
					success: true,
					message: zh
						? `推送成功${relayNotice} (HTTP ${data.status ?? 200})`
						: `Delivered successfully${relayNotice} (HTTP ${data.status ?? 200})`,
				});
			} else {
				setTestResult({
					id: hook.id,
					success: false,
					message: data.error || (zh ? "推送测试失败" : "Test failed"),
				});
			}
		} catch (err: any) {
			setTestResult({
				id: hook.id,
				success: false,
				message: err?.message || "Network request failed",
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
					<p>
						{zh
							? "群组 Webhook 支持双向通信与可选 Hub 中转：入站可使用公网 Hub 中转地址接收外部事件唤醒 Bot；出站通知可选由 Hub 服务端中转代发。"
							: "Two-way Webhooks with optional Hub relay: incoming uses Hub public relay endpoints, outgoing supports relaying via Hub."}
					</p>
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
					<span>{zh ? "新建 Webhook" : "Add Webhook"}</span>
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
						<strong>{zh ? "Hub 中转基准地址：" : "Hub Relay Base URL:"}</strong>
						<code>{effectiveHubBase}</code>
						{customRelayUrl && <span className="badge-custom">{zh ? "自定义" : "Custom"}</span>}
					</div>
				</div>
				<button
					type="button"
					className="btn secondary sm"
					onClick={() => setShowRelayConfig(!showRelayConfig)}
					title={zh ? "配置自定义 Hub 中转基准域名" : "Configure Hub relay base URL"}
				>
					<FiSliders />
					<span>{zh ? "设置中转域名" : "Relay URL"}</span>
				</button>
			</div>

			{showRelayConfig && (
				<div className="group-webhook-relay-config-box">
					<div className="group-webhook-relay-config-fields">
						<label>
							{zh
								? "若 Hub 位于公网反向代理或具有独立域名，请输入对外公开的完整基准地址（如 https://hub.example.com）："
								: "Specify the public Hub URL (e.g. https://hub.example.com) if behind a reverse proxy:"}
						</label>
						<div className="group-webhook-relay-input-row">
							<input
								type="url"
								className="input"
								placeholder="https://hub.example.com"
								value={relayConfigInput}
								onChange={(e) => setRelayConfigInput(e.target.value)}
							/>
							<button type="button" className="btn primary sm" disabled={savingRelay} onClick={handleSaveHubRelay}>
								{savingRelay ? (zh ? "保存中…" : "Saving...") : zh ? "保存中转地址" : "Save"}
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
									{zh ? "重置" : "Reset"}
								</button>
							)}
						</div>
					</div>
				</div>
			)}

			{loading ? (
				<div className="group-webhooks-loading">{zh ? "正在加载 Webhook 列表…" : "Loading webhooks..."}</div>
			) : webhooks.length === 0 ? (
				<div className="group-webhooks-empty">
					<div className="group-webhooks-empty-icon">🔗</div>
					<h4>{zh ? "暂未配置群组 Webhook" : "No Webhooks Configured"}</h4>
					<p>
						{zh
							? "点击上方「新建 Webhook」创建入站或出站自动化集成。"
							: "Click 'Add Webhook' above to create incoming or outgoing automations."}
					</p>
				</div>
			) : (
				<div className="group-webhooks-list">
					{incomingHooks.length > 0 && (
						<div className="group-webhooks-section">
							<div className="group-webhooks-section-header">
								<h4 className="group-webhooks-section-title">
									<FiArrowDownCircle className="icon-incoming" />
									<span>{zh ? "入站 Webhook (Incoming)" : "Incoming Webhooks"}</span>
									<span className="badge">{incomingHooks.length}</span>
								</h4>
								<div
									className="group-webhook-mode-toggle"
									title={zh ? "选择生成中转还是直连地址" : "Select address mode"}
								>
									<button
										type="button"
										className={`mode-btn ${incomingUrlMode === "hub" ? "active" : ""}`}
										onClick={() => setIncomingUrlMode("hub")}
									>
										🌐 {zh ? "Hub 中转地址" : "Hub Relay"}
									</button>
									<button
										type="button"
										className={`mode-btn ${incomingUrlMode === "direct" ? "active" : ""}`}
										onClick={() => setIncomingUrlMode("direct")}
									>
										💻 {zh ? "本地直连地址" : "Direct"}
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
														{hook.enabled ? (zh ? "已启用" : "Active") : zh ? "已暂停" : "Disabled"}
													</span>
													<span className="group-webhook-badge badge-relay">
														{incomingUrlMode === "hub"
															? zh
																? "🌐 Hub中转"
																: "🌐 Hub Relay"
															: zh
																? "💻 本机直连"
																: "💻 Direct"}
													</span>
													{hook.allowBotTrigger !== false && (
														<span
															className="group-webhook-badge badge-info"
															title={zh ? "收到外部消息时自动触发群主管或被 @ 的 Bot" : "Triggers Bot execution"}
														>
															{zh ? "可唤醒 Bot" : "Triggers Bot"}
														</span>
													)}
												</div>
												<div className="group-webhook-actions">
													<button
														type="button"
														className="btn-icon-subtle"
														title={zh ? "编辑" : "Edit"}
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
														title={zh ? "删除" : "Delete"}
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
														title={zh ? "启用/禁用切换" : "Toggle status"}
													>
														<span className="set-switch-knob" />
													</button>
												</div>
											</div>

											<div className="group-webhook-field">
												<label>
													{zh ? "Webhook 入站地址：" : "Webhook URL:"}
													<span className="mode-indicator">
														(
														{incomingUrlMode === "hub"
															? zh
																? "外部经 Hub 中转打入"
																: "Forwarded via Hub"
															: zh
																? "本地端口直通"
																: "Direct access"}
														)
													</span>
												</label>
												<div className="group-webhook-url-row">
													<code className="group-webhook-code">{hookUrl}</code>
													<button
														type="button"
														className="btn secondary sm"
														title={zh ? "复制 URL" : "Copy URL"}
														onClick={() => copyText(hookUrl, `url-${hook.id}`)}
													>
														{copiedKey === `url-${hook.id}` ? <FiCheck /> : <FiCopy />}
														<span>
															{copiedKey === `url-${hook.id}` ? (zh ? "已复制" : "Copied") : zh ? "复制" : "Copy"}
														</span>
													</button>
													<button
														type="button"
														className="btn secondary sm"
														title={zh ? "重新生成安全凭证 Token" : "Regenerate Token"}
														disabled={disabled}
														onClick={() => handleRegenerateToken(hook.id)}
													>
														<FiRefreshCw />
													</button>
												</div>
											</div>

											<div className="group-webhook-field">
												<label>{zh ? "调用示例 (cURL)：" : "cURL Example:"}</label>
												<div className="group-webhook-curl-box">
													<code>{curlSnippet}</code>
													<button
														type="button"
														className="btn-icon-subtle"
														title={zh ? "复制 cURL" : "Copy cURL"}
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
								<span>{zh ? "出站 Webhook (Outgoing)" : "Outgoing Webhooks"}</span>
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
														{hook.enabled ? (zh ? "已启用" : "Active") : zh ? "已暂停" : "Disabled"}
													</span>
													<span
														className={`group-webhook-badge ${isRelayed ? "badge-relay" : "badge-direct"}`}
														title={
															isRelayed
																? zh
																	? "由 Hub 服务器统一代理出网外发"
																	: "Relayed via Hub server"
																: zh
																	? "由本地设备节点直连外发"
																	: "Direct connection from device"
														}
													>
														{isRelayed
															? zh
																? "🌐 Hub中转代发"
																: "🌐 Hub Relay"
															: zh
																? "💻 本地直连外发"
																: "💻 Direct Outbound"}
													</span>
													{hook.secret ? (
														<span
															className="group-webhook-badge badge-secret"
															title={zh ? "已配置 HMAC-SHA256 签名校验密钥" : "HMAC secret configured"}
														>
															{zh ? "带签名" : "Signed"}
														</span>
													) : null}
												</div>
												<div className="group-webhook-actions">
													<button
														type="button"
														className="btn secondary sm"
														disabled={disabled || isTesting}
														onClick={() => handleTest(hook)}
														title={zh ? "向目标地址发送一条测试 Ping" : "Send test ping"}
													>
														<FiSend />
														<span>{isTesting ? (zh ? "测试中…" : "Testing...") : zh ? "测试" : "Test"}</span>
													</button>
													<button
														type="button"
														className="btn-icon-subtle"
														title={zh ? "编辑" : "Edit"}
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
														title={zh ? "删除" : "Delete"}
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
														title={zh ? "启用/禁用切换" : "Toggle status"}
													>
														<span className="set-switch-knob" />
													</button>
												</div>
											</div>

											<div className="group-webhook-field">
												<label>{zh ? "目标推送 URL：" : "Target URL:"}</label>
												<code className="group-webhook-code">{hook.url}</code>
											</div>

											<div className="group-webhook-field">
												<label>{zh ? "订阅事件：" : "Subscribed Events:"}</label>
												<div className="group-webhook-event-chips">
													{(
														hook.events ||
														(["message", "task_completed", "task_failed", "delivery"] as GroupWebhookEventType[])
													).map((ev: GroupWebhookEventType) => {
														const def = ALL_EVENTS.find((e) => e.id === ev);
														return (
															<span key={ev} className="group-webhook-event-chip">
																{def ? (zh ? def.zh : def.en) : ev}
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
	const { locale } = useI18n();
	const zh = isZhLocale(locale);

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
			setError(zh ? "请输入 Webhook 名称" : "Name is required");
			return;
		}
		if (type === "outgoing" && (!url.trim() || !/^https?:\/\/.+/i.test(url.trim()))) {
			setError(zh ? "请输入有效的 http:// 或 https:// 目标地址" : "Valid HTTP/HTTPS URL is required");
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
				throw new Error(data.error || "Save failed");
			}
			onSaved();
		} catch (err: any) {
			setError(err?.message || "Failed to save webhook");
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
							{isEditing ? (zh ? "编辑 Webhook" : "Edit Webhook") : zh ? "新建 Webhook" : "New Webhook"}
						</h3>
						<p className="gwm-subtitle">
							{zh
								? "配置入站自动化触发或出站事件广播通知"
								: "Configure incoming automations or outgoing event notifications"}
						</p>
					</div>
					<button
						type="button"
						className="gwm-close-btn"
						onClick={onClose}
						aria-label={zh ? "关闭" : "Close"}
						title={zh ? "关闭" : "Close"}
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
								<label className="gwm-label">{zh ? "集成类型" : "Integration Type"}</label>
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
											<span className="gwm-type-name">{zh ? "入站 Webhook" : "Incoming Webhook"}</span>
										</div>
										<p className="gwm-type-desc">
											{zh
												? "外部系统推送消息进群，可自动指派或唤醒群内 Bot 执行任务"
												: "External services push messages to this group & trigger Bots"}
										</p>
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
											<span className="gwm-type-name">{zh ? "出站 Webhook" : "Outgoing Webhook"}</span>
										</div>
										<p className="gwm-type-desc">
											{zh
												? "将新消息、任务完成、失败或交付等事件实时推送至外部服务"
												: "Forward messages, task completions, and deliveries to external endpoints"}
										</p>
									</div>
								</div>
							</div>
						)}

						<div className="gwm-form-group">
							<label htmlFor="webhook-name" className="gwm-label">
								{zh ? "Webhook 名称" : "Webhook Name"}
							</label>
							<input
								id="webhook-name"
								type="text"
								className="gwm-input"
								placeholder={
									zh ? "例如：GitHub Actions CI、监控告警、飞书群通知" : "e.g. GitHub Actions CI, Sentry Alerts"
								}
								value={name}
								maxLength={80}
								onChange={(e) => setName(e.target.value)}
								autoFocus
							/>
						</div>

						{type === "incoming" ? (
							<div className="gwm-switch-row" onClick={() => setAllowBotTrigger(!allowBotTrigger)}>
								<div className="gwm-switch-text">
									<span className="gwm-switch-title">
										{zh ? "收到外部推送时唤醒 Bot 执行任务" : "Allow incoming messages to trigger Bots"}
									</span>
									<span className="gwm-switch-desc">
										{zh
											? "检测到消息包含 @Bot 或群组设有群主管时，自动生成任务派发"
											: "Triggers coordinator or mentioned Bots automatically"}
									</span>
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
										{zh ? "目标推送 URL" : "Target Endpoint URL"}
									</label>
									<input
										id="webhook-url"
										type="url"
										className="gwm-input"
										placeholder="https://example.com/webhook/endpoint"
										value={url}
										onChange={(e) => setUrl(e.target.value)}
									/>
									<span className="gwm-field-hint">
										{zh
											? "事件触发时，系统将以 HTTP POST 发送 JSON 格式载荷至此地址。"
											: "Delivered as HTTP POST with JSON content."}
									</span>
								</div>

								<div className="gwm-switch-row" onClick={() => setRelayViaHub(!relayViaHub)}>
									<div className="gwm-switch-text">
										<span className="gwm-switch-title">
											{zh ? "通过 Hub 服务端中转代发 (Relay via Hub)" : "Relay via Hub Server"}
										</span>
										<span className="gwm-switch-desc">
											{zh
												? "由 Hub 服务器统一作为代理外发通知（固定出口 IP）；若目标是局域网私有地址请关闭"
												: "Dispatched centrally by Hub. Uncheck if target is internal LAN address."}
										</span>
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
										{zh ? "签名密钥 Secret（可选）" : "HMAC Secret (Optional)"}
									</label>
									<input
										id="webhook-secret"
										type="text"
										className="gwm-input"
										placeholder={
											zh
												? "可选密钥，用于生成 X-Pi-Signature 请求头防篡改校验"
												: "Optional secret used for X-Pi-Signature header"
										}
										value={secret}
										maxLength={256}
										onChange={(e) => setSecret(e.target.value)}
									/>
								</div>

								<div className="gwm-form-group">
									<label className="gwm-label">{zh ? "订阅事件" : "Subscribed Events"}</label>
									<div className="gwm-events-grid">
										{ALL_EVENTS.map((item) => (
											<div
												key={item.id}
												className={`gwm-event-chip ${events.includes(item.id) ? "active" : ""}`}
												onClick={() => toggleEvent(item.id)}
											>
												<span className="gwm-chip-box">{events.includes(item.id) ? "✓" : ""}</span>
												<span>{zh ? item.zh : item.en}</span>
											</div>
										))}
									</div>
								</div>
							</>
						)}

						<div className="gwm-switch-row" onClick={() => setEnabled(!enabled)}>
							<div className="gwm-switch-text">
								<span className="gwm-switch-title">{zh ? "立即启用该 Webhook" : "Enable this Webhook"}</span>
								<span className="gwm-switch-desc">
									{zh ? "创建完成后立即生效并接受/分发事件" : "Active immediately upon save"}
								</span>
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
							{zh ? "取消" : "Cancel"}
						</button>
						<button type="submit" className="btn primary" disabled={submitting}>
							{submitting
								? zh
									? "保存中…"
									: "Saving..."
								: isEditing
									? zh
										? "保存修改"
										: "Save Changes"
									: zh
										? "创建 Webhook"
										: "Create Webhook"}
						</button>
					</div>
				</form>
			</div>
		</div>
	);
}
