import { useEffect, useRef, useState } from "react";
import {
	FiCheck,
	FiCopy,
	FiExternalLink,
	FiHelpCircle,
	FiLink,
	FiMessageSquare,
	FiMonitor,
	FiRefreshCw,
	FiShield,
} from "react-icons/fi";
import { appUrl } from "../base-url";
import { withToken } from "../auth-token";
import { useLocale, useT } from "../i18n";
import { DeviceGroups } from "./DeviceGroups";
import { LocalBots } from "./LocalBots";
import { HubLink } from "./HubLink";
import { DeviceCenterSetup } from "./DeviceCenterSetup";
import { DeviceDirectory } from "./DeviceDirectory";
import { DeviceExecutionSettings } from "./DeviceExecutionSettings";
import { useDeviceGroupNavigation } from "../device-group-navigation";

type DeviceStatus = { name: string; hubUrl?: string; deviceId?: string; allowExecution: boolean; connected: boolean };
type Pairing = { code: string; expiresAt: number; hubUrl: string };
class DeviceRequestError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}
function safeHub(value: string): string | null {
	try {
		const url = new URL(value);
		return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
	} catch {
		return null;
	}
}

type LocalDesktopStatus = {
	os: string;
	enabled: boolean;
	environmentEnabled: boolean;
	supported: boolean;
	backend: string;
	reason?: string;
	permissions?: { supported: boolean; screen?: boolean; accessibility?: boolean };
};

function LocalDesktopSettings() {
	const t = useT();
	const zh = useLocale().startsWith("zh");
	const [status, setStatus] = useState<LocalDesktopStatus | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState(false);
	const [localOnly, setLocalOnly] = useState(false);
	const [requested, setRequested] = useState(false);
	const generation = useRef(0);
	const controller = useRef<AbortController | null>(null);

	async function load(path: "status" | "enable" | "permissions", body?: object) {
		if (controller.current) return;
		const token = ++generation.current;
		const pending = new AbortController();
		controller.current = pending;
		setBusy(true);
		setError(false);
		try {
			const response = await fetch(withToken(appUrl(`/api/device-desktop/local/${path}`)), {
				method: body ? "POST" : "GET",
				credentials: "same-origin",
				signal: pending.signal,
				...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
			});
			if (generation.current !== token || pending.signal.aborted) return;
			if (response.status === 403) {
				setLocalOnly(true);
				setStatus(null);
				return;
			}
			if (!response.ok) throw new Error("Request failed");
			const next = await response.json();
			if (generation.current !== token || pending.signal.aborted) return;
			if (path === "permissions") {
				if (typeof next?.screen !== "boolean" || typeof next?.accessibility !== "boolean")
					throw new Error("Invalid permission status");
				setStatus((previous) =>
					previous
						? { ...previous, permissions: { supported: true, screen: next.screen, accessibility: next.accessibility } }
						: previous,
				);
				setRequested(true);
			} else {
				if (
					typeof next?.os !== "string" ||
					typeof next.enabled !== "boolean" ||
					typeof next.environmentEnabled !== "boolean" ||
					typeof next.supported !== "boolean"
				)
					throw new Error("Invalid desktop status");
				setStatus(next);
			}
		} catch {
			if (generation.current === token && !pending.signal.aborted) setError(true);
		} finally {
			if (generation.current === token && !pending.signal.aborted) {
				controller.current = null;
				setBusy(false);
			}
		}
	}

	useEffect(() => {
		void load("status");
		return () => {
			generation.current++;
			controller.current?.abort();
			controller.current = null;
		};
	}, []);

	return (
		<section className="dc-card" aria-label={zh ? "本机远程桌面" : "Local remote desktop"} aria-busy={busy}>
			<div className="dc-card-header">
				<span className="dc-icon">
					<FiMonitor aria-hidden />
				</span>
				<div>
					<h2>{zh ? "本机远程桌面" : "Local remote desktop"}</h2>
					<p>
						{zh
							? "管理这台设备的远程桌面与系统权限，无需连接设备中心。"
							: "Manage remote desktop and system permissions on this device, even while the device center is offline."}
					</p>
				</div>
			</div>
			{localOnly ? (
				<p role="status">
					{zh
						? "请在设备本机打开此页面以管理远程桌面权限。"
						: "Open this page on the device itself to manage remote desktop permissions."}
				</p>
			) : (
				<>
					{status && (
						<>
							<div className="dc-permission-row">
								<div>
									<h3 id="dc-desktop-label">{zh ? "启用远程桌面" : "Enable remote desktop"}</h3>
									<p>{status.enabled ? (zh ? "已启用" : "Enabled") : zh ? "未启用" : "Disabled"}</p>
								</div>
								<button
									type="button"
									className={`dc-toggle${status.enabled ? " is-on" : ""}`}
									role="switch"
									aria-checked={status.enabled}
									aria-labelledby="dc-desktop-label"
									disabled={busy || status.environmentEnabled || (!status.supported && !status.enabled)}
									onClick={() => void load("enable", { enabled: !status.enabled })}
								>
									<span className="dc-toggle-thumb" />
								</button>
							</div>
							{!status.supported && (
								<p>{zh ? "这台设备暂不支持远程桌面。" : "Remote desktop is currently unavailable on this device."}</p>
							)}
							{status.environmentEnabled && (
								<p>
									{zh
										? "远程桌面由本机服务设置保持启用。"
										: "Remote desktop is kept enabled by the service settings on this device."}
								</p>
							)}
							{status.os === "darwin" && (
								<>
									<p>
										{zh
											? "点击下方按钮发起系统授权，请在这台 Mac 的系统设置中确认。授权后可能需要重启服务。"
											: "Use the buttons below to request system permission, then confirm in System Settings on this Mac. You may need to restart the service afterward."}
									</p>
									<div className="dc-actions">
										<button
											type="button"
											className="dc-button"
											disabled={busy || status.permissions?.supported === false}
											onClick={() => void load("permissions", { kind: "screen" })}
										>
											{zh ? "授予屏幕录制权限" : "Grant screen recording permission"}
										</button>
										<button
											type="button"
											className="dc-button"
											disabled={busy || status.permissions?.supported === false}
											onClick={() => void load("permissions", { kind: "control" })}
										>
											{zh ? "授予远程控制权限" : "Grant remote control permission"}
										</button>
									</div>
									{status.permissions?.screen === true && (
										<p>{zh ? "屏幕录制：已授权" : "Screen recording: granted"}</p>
									)}
									{status.permissions?.accessibility === true && (
										<p>{zh ? "远程控制：已授权" : "Remote control: granted"}</p>
									)}
									{requested && (
										<p role="status">
											{zh
												? "已发起授权请求，请确认系统设置后刷新状态。"
												: "Permission requested. Confirm in System Settings, then refresh the status."}
										</p>
									)}
								</>
							)}
						</>
					)}
					{error && (
						<p className="dc-notice is-error" role="alert">
							{zh
								? "无法更新本机远程桌面设置，请重试。"
								: "Unable to update local remote desktop settings. Please retry."}
						</p>
					)}
					<button type="button" className="dc-button" disabled={busy} onClick={() => void load("status")}>
						<FiRefreshCw aria-hidden />
						{busy ? t("deviceHubWorking") : zh ? "刷新远程桌面状态" : "Refresh remote desktop status"}
					</button>
				</>
			)}
		</section>
	);
}

export function DeviceCenter({
	pathCompletions = [],
}: {
	pathCompletions?: { name: string; path: string; type: "dir" | "file" }[];
}) {
	const t = useT();
	const navigation = useDeviceGroupNavigation();
	const [view, setView] = useState<"overview" | "groups" | "settings">(navigation.revision ? "groups" : "overview");
	useEffect(() => {
		if (navigation.revision) setView("groups");
	}, [navigation.revision]);
	const [status, setStatus] = useState<DeviceStatus | null>(null);
	const [hubUrl, setHubUrl] = useState("");
	const [name, setName] = useState("");
	const [pairing, setPairing] = useState<Pairing | null>(null);
	const [now, setNow] = useState(Date.now());
	const [busy, setBusy] = useState<"pair" | "permission" | "disconnect" | null>(null);
	const [error, setError] = useState("");
	const [statusError, setStatusError] = useState("");
	const [notice, setNotice] = useState("");
	const [localOnly, setLocalOnly] = useState(false);
	const [loading, setLoading] = useState(true);
	const alive = useRef(false);
	const generation = useRef(0);
	const controllers = useRef(new Set<AbortController>());
	const action = useRef(false);
	const dirty = useRef(false);
	const currentStatus = useRef<DeviceStatus | null>(null);
	const translate = useRef(t);
	translate.current = t;

	async function request<T>(path: string, body?: object): Promise<T> {
		const controller = new AbortController();
		controllers.current.add(controller);
		try {
			const response = await fetch(withToken(appUrl(`/api/device-center/${path}`)), {
				method: body ? "POST" : "GET",
				credentials: "same-origin",
				signal: controller.signal,
				...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
			});
			const data = await response.json().catch(() => ({}));
			if (!response.ok)
				throw new DeviceRequestError(
					response.status,
					typeof data.error === "string"
						? data.error
						: translate.current("deviceHubRequestFailed", { status: response.status }),
				);
			return data as T;
		} finally {
			controllers.current.delete(controller);
		}
	}
	function valid(token: number) {
		return alive.current && generation.current === token;
	}
	function explain(cause: unknown): string {
		if (cause instanceof DeviceRequestError && cause.status === 403) {
			setLocalOnly(true);
			return translate.current("deviceHubLocalOnly");
		}
		return cause instanceof Error ? cause.message : translate.current("deviceHubNetworkError");
	}
	function applyStatus(next: DeviceStatus) {
		currentStatus.current = next;
		setStatus(next);
		if (!dirty.current) {
			setName(next.name);
			setHubUrl(next.hubUrl ?? "");
		}
	}
	async function refresh() {
		const token = generation.current;
		try {
			const next = await request<DeviceStatus>("status");
			if (!valid(token) || action.current) return;
			applyStatus(next);
			setStatusError("");
			setLocalOnly(false);
		} catch (cause) {
			if (valid(token)) setStatusError(explain(cause));
		} finally {
			if (valid(token)) setLoading(false);
		}
	}
	useEffect(() => {
		alive.current = true;
		let stopped = false;
		let timer: ReturnType<typeof setTimeout>;
		const tick = async () => {
			await refresh();
			if (!stopped && alive.current) timer = setTimeout(tick, 5000);
		};
		void tick();
		return () => {
			stopped = true;
			alive.current = false;
			generation.current++;
			clearTimeout(timer);
			for (const controller of controllers.current) controller.abort();
		};
	}, []);
	useEffect(() => {
		if (!pairing) return;
		const token = generation.current;
		let stopped = false;
		let timer: ReturnType<typeof setTimeout>;
		const clock = setInterval(() => setNow(Date.now()), 1000);
		const poll = async () => {
			if (stopped || !valid(token) || Date.now() >= pairing.expiresAt) return;
			try {
				const result = await request<{ pending?: boolean; paired?: boolean }>("poll", {});
				if (stopped || !valid(token)) return;
				if (result.paired) {
					const next = await request<DeviceStatus>("status");
					if (stopped || !valid(token)) return;
					dirty.current = false;
					applyStatus(next);
					setPairing(null);
					setError("");
					setNotice("");
					return;
				}
				setError("");
			} catch (cause) {
				if (!stopped && valid(token)) setError(`${translate.current("deviceHubPollError")} ${explain(cause)}`);
			}
			if (!stopped && valid(token)) timer = setTimeout(poll, 2000);
		};
		timer = setTimeout(poll, 2000);
		return () => {
			stopped = true;
			clearTimeout(timer);
			clearInterval(clock);
		};
	}, [pairing]);
	async function pair() {
		if (action.current) return;
		const url = safeHub(hubUrl.trim());
		if (!url) {
			setError(t("deviceHubInvalidUrl"));
			return;
		}
		if (!name.trim() || name.trim().length > 80) {
			setError(t("deviceHubInvalidName"));
			return;
		}
		const token = ++generation.current;
		action.current = true;
		setBusy("pair");
		setError("");
		setNotice("");
		setPairing(null);
		try {
			const result = await request<Pairing>("pair", { hubUrl: url, name: name.trim() });
			if (!valid(token)) return;
			if (!result.code || !Number.isFinite(result.expiresAt) || !safeHub(result.hubUrl))
				throw new Error(t("deviceHubPairError"));
			setNow(Date.now());
			setPairing(result);
		} catch (cause) {
			if (valid(token)) setError(`${t("deviceHubPairError")} ${explain(cause)}`);
		} finally {
			if (valid(token)) {
				action.current = false;
				setBusy(null);
			}
		}
	}
	async function togglePermission() {
		const captured = currentStatus.current;
		if (!captured?.deviceId || action.current) return;
		const token = ++generation.current;
		action.current = true;
		setBusy("permission");
		setError("");
		setNotice("");
		applyStatus({ ...captured, allowExecution: !captured.allowExecution });
		try {
			await request("execution", { allowExecution: !captured.allowExecution });
			if (valid(token)) setNotice(t("deviceHubSaved"));
		} catch (cause) {
			if (valid(token)) {
				applyStatus(captured);
				setError(`${t("deviceHubPermissionError")} ${explain(cause)}`);
			}
		} finally {
			if (valid(token)) {
				action.current = false;
				setBusy(null);
			}
		}
	}
	async function disconnect() {
		const captured = currentStatus.current;
		if (
			!captured?.deviceId ||
			action.current ||
			!window.confirm(t("deviceHubDisconnectConfirm", { name: captured.name }))
		)
			return;
		const token = ++generation.current;
		action.current = true;
		setBusy("disconnect");
		setError("");
		setNotice("");
		try {
			await request("disconnect", {});
			if (!valid(token)) return;
			dirty.current = false;
			applyStatus({ name: captured.name, allowExecution: false, connected: false });
			setPairing(null);
		} catch (cause) {
			if (valid(token)) setError(`${t("deviceHubDisconnectError")} ${explain(cause)}`);
		} finally {
			if (valid(token)) {
				action.current = false;
				setBusy(null);
			}
		}
	}
	async function copyCode() {
		if (!pairing) return;
		const token = generation.current;
		try {
			await navigator.clipboard.writeText(pairing.code);
			if (valid(token)) setNotice(t("deviceHubCopied"));
		} catch {
			if (valid(token)) setError(t("deviceHubCopyFailed"));
		}
	}
	const bound = !!status?.deviceId;
	const link = safeHub(bound ? (status?.hubUrl ?? "") : (pairing?.hubUrl ?? ""));
	const seconds = Math.max(0, Math.ceil(((pairing?.expiresAt ?? 0) - now) / 1000));
	const remaining = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
	const hubLink = link ? (
		<HubLink href={link}>
			<FiExternalLink aria-hidden />
			{t("deviceHubOpenHub")}
		</HubLink>
	) : null;

	return (
		<section className="dc-page" aria-label={t("deviceHubTitle")}>
			<header className="dc-header">
				<div className="dc-heading">
					<span className="dc-eyebrow">
						<FiMonitor aria-hidden />
						{t("deviceHubTitle")}
					</span>
					<h1>{t("deviceHubTitle")}</h1>
					<p>{t("deviceHubSubtitle")}</p>
				</div>
				<div className="dc-actions">
					{bound && hubLink}
					<span className={`dc-status ${bound ? (status?.connected ? "is-online" : "is-offline") : "is-unpaired"}`}>
						<span className="dc-status-dot" />
						{t(bound ? (status?.connected ? "deviceHubOnline" : "deviceHubOffline") : "deviceHubUnpaired")}
					</span>
				</div>
			</header>
			<div className="dc-layout">
				<nav className="dc-sidebar" aria-label={t("deviceHubTitle")}>
					<button
						type="button"
						className={`dc-nav-item${view === "overview" ? " is-active" : ""}`}
						aria-current={view === "overview" ? "page" : undefined}
						onClick={() => setView("overview")}
					>
						<FiMonitor aria-hidden />
						{t("deviceHubOverview")}
					</button>
					<button
						type="button"
						className={`dc-nav-item${view === "groups" ? " is-active" : ""}`}
						aria-current={view === "groups" ? "page" : undefined}
						onClick={() => setView("groups")}
					>
						<FiMessageSquare aria-hidden />
						{t("deviceHubGroups")}
					</button>
					<button
						type="button"
						className={`dc-nav-item${view === "settings" ? " is-active" : ""}`}
						aria-current={view === "settings" ? "page" : undefined}
						onClick={() => setView("settings")}
					>
						<FiLink aria-hidden />
						{t("deviceHubSettings")}
					</button>
				</nav>
				<main className="dc-content">
					{loading && (
						<div className="dc-loading" role="status">
							<FiRefreshCw aria-hidden />
							{t("deviceHubLoading")}
						</div>
					)}
					{(localOnly || statusError) && (
						<div className="dc-notice is-error" role="alert">
							<span>{localOnly ? t("deviceHubLocalOnly") : `${t("deviceHubStatusError")} ${statusError}`}</span>
							<button type="button" className="dc-button" onClick={() => void refresh()}>
								<FiRefreshCw aria-hidden />
								{t("deviceHubRetry")}
							</button>
						</div>
					)}
					{error && !localOnly && (
						<div className="dc-notice is-error" role="alert">
							{error}
						</div>
					)}
					{notice && (
						<div className="dc-notice is-success" role="status">
							<FiCheck aria-hidden />
							{notice}
						</div>
					)}
					{!bound && (status || localOnly) && view === "overview" && (
						<DeviceCenterSetup
							initialHubUrl={hubUrl}
							onConnect={(url) => {
								if (localOnly) {
									setNotice(t("deviceHubLocalOnly"));
									return;
								}
								dirty.current = true;
								setHubUrl(url);
								setView("settings");
							}}
						/>
					)}
					{!localOnly && view === "overview" && (
						<section className="dc-card">
							<h3>{t("deviceSetupNext")}</h3>
							<p>{t("deviceSetupNextHint")}</p>
							<button className="dc-button is-primary" onClick={() => setView("groups")}>
								{t("deviceSetupManage")}
							</button>
						</section>
					)}
					{view === "settings" && <LocalDesktopSettings />}
					{status && !localOnly && !bound && view === "settings" && (
						<section className="dc-card">
							<div className="dc-card-header">
								<span className="dc-icon">
									<FiLink aria-hidden />
								</span>
								<div>
									<h2>{t("deviceHubPairTitle")}</h2>
									<p>{t("deviceHubPairHint")}</p>
								</div>
							</div>
							<ol className="dc-steps">
								{["deviceHubStepDetails", "deviceHubStepApprove", "deviceHubStepWait"].map((key, index) => (
									<li
										key={key}
										className={pairing ? (index === 0 ? "is-complete" : "is-active") : index === 0 ? "is-active" : ""}
									>
										<span className="dc-step-number">
											{pairing && index === 0 ? <FiCheck aria-hidden /> : index + 1}
										</span>
										<span>{t(key as "deviceHubStepDetails")}</span>
									</li>
								))}
							</ol>
							<form
								className="dc-form"
								onSubmit={(event) => {
									event.preventDefault();
									void pair();
								}}
							>
								<div className="dc-field">
									<label htmlFor="dc-hub-url">{t("deviceHubHubUrl")}</label>
									<input
										id="dc-hub-url"
										type="url"
										autoComplete="url"
										required
										placeholder={t("deviceHubHubPlaceholder")}
										value={hubUrl}
										disabled={!!pairing || !!busy}
										onChange={(event) => {
											dirty.current = true;
											setHubUrl(event.target.value);
										}}
									/>
								</div>
								<div className="dc-field">
									<label htmlFor="dc-device-name">{t("deviceHubName")}</label>
									<input
										id="dc-device-name"
										maxLength={80}
										required
										autoComplete="off"
										placeholder={t("deviceHubNamePlaceholder")}
										value={name}
										disabled={!!pairing || !!busy}
										onChange={(event) => {
											dirty.current = true;
											setName(event.target.value);
										}}
									/>
								</div>
								{!pairing && (
									<div className="dc-actions">
										<button className="dc-button is-primary" type="submit" disabled={!!busy}>
											<FiLink aria-hidden />
											{t(busy ? "deviceHubWorking" : "deviceHubGetCode")}
										</button>
									</div>
								)}
							</form>
							{pairing && (
								<div className="dc-pairing">
									<span className="dc-code-label">{t("deviceHubCode")}</span>
									<div className="dc-code-row">
										<code className="dc-code">{pairing.code}</code>
										<button
											className="dc-icon-button"
											type="button"
											aria-label={t("deviceHubCopy")}
											onClick={() => void copyCode()}
										>
											<FiCopy aria-hidden />
										</button>
									</div>
									<div className="dc-pair-meta">
										{t(seconds ? "deviceHubExpires" : "deviceHubExpired", { time: remaining })}
									</div>
									<div className="dc-actions">
										{hubLink}
										<button
											type="button"
											className="dc-button"
											disabled={!!busy}
											onClick={() => {
												++generation.current;
												setPairing(null);
												setError("");
												setNotice("");
											}}
										>
											<FiRefreshCw aria-hidden />
											{t("deviceHubNewCode")}
										</button>
									</div>
									{seconds > 0 && (
										<p className="dc-progress" role="status">
											<FiRefreshCw aria-hidden />
											{t("deviceHubWaiting")}
										</p>
									)}
								</div>
							)}
						</section>
					)}
					{bound && status && !localOnly && (
						<>
							{view === "overview" && (
								<section className="dc-card">
									<div className="dc-device-summary">
										<span className="dc-device-icon">
											<FiMonitor aria-hidden />
										</span>
										<div>
											<h2>{status.name}</h2>
											<p>{t("deviceHubDeviceTitle")}</p>
										</div>
									</div>
									<dl className="dc-details">
										<div>
											<dt>{t("deviceHubDeviceId")}</dt>
											<dd>{status.deviceId}</dd>
										</div>
										<div>
											<dt>{t("deviceHubHubUrl")}</dt>
											<dd>{status.hubUrl}</dd>
										</div>
									</dl>
								</section>
							)}
							{view === "settings" && (
								<section className="dc-card">
									<div className="dc-card-header">
										<span className="dc-icon">
											<FiShield aria-hidden />
										</span>
										<div>
											<h2>{t("deviceHubPermissions")}</h2>
										</div>
									</div>
									<div className="dc-permission-row">
										<div>
											<h3 id="dc-permission-label">{t("deviceHubPermissionLabel")}</h3>
											<p id="dc-permission-hint">{t("deviceHubPermissionHint")}</p>
										</div>
										<button
											type="button"
											className={`dc-toggle${status.allowExecution ? " is-on" : ""}`}
											role="switch"
											aria-checked={status.allowExecution}
											aria-labelledby="dc-permission-label"
											aria-describedby="dc-permission-hint"
											disabled={!!busy}
											onClick={() => void togglePermission()}
										>
											<span className="dc-toggle-thumb" />
										</button>
									</div>
									<p className="dc-permission-state" role="status">
										{t(
											busy === "permission"
												? "deviceHubSaving"
												: status.allowExecution
													? "deviceHubEnabled"
													: "deviceHubReadOnly",
										)}
									</p>
								</section>
							)}
							{view === "settings" && (
								<details className="dc-advanced">
									<summary>{t("deviceHubAdvanced")}</summary>
									<div className="dc-danger-zone">
										<h3>{t("deviceHubDisconnect")}</h3>
										<p>{t("deviceHubDisconnectHint")}</p>
										<button
											type="button"
											className="dc-button is-danger"
											disabled={!!busy}
											onClick={() => void disconnect()}
										>
											{t(busy === "disconnect" ? "deviceHubWorking" : "deviceHubDisconnect")}
										</button>
									</div>
								</details>
							)}
						</>
					)}
					{bound && status?.hubUrl && status.deviceId && !localOnly && view !== "groups" && (
						<DeviceDirectory
							key={`directory:${status.hubUrl}:${status.deviceId}`}
							hubUrl={status.hubUrl}
							currentDeviceId={status.deviceId}
						/>
					)}
					{!localOnly && (view === "settings" || view === "groups") && (
						<LocalBots
							key={`bots:${status?.hubUrl ?? ""}:${status?.deviceId ?? "unpaired"}`}
							pathCompletions={pathCompletions}
						/>
					)}
					{view === "settings" && (
						<DeviceExecutionSettings hubUrl={status?.hubUrl} deviceId={status?.deviceId} onNotice={setNotice} />
					)}
					{view === "groups" && <DeviceGroups navigation={navigation} />}
					<aside className="dc-help">
						<FiHelpCircle className="dc-help-icon" aria-hidden />
						<div>
							<h3>{t("deviceHubHelpTitle")}</h3>
							<p>{t("deviceHubHelpText")}</p>
						</div>
					</aside>
				</main>
			</div>
		</section>
	);
}
