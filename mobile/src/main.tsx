import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Capacitor } from "@capacitor/core";
import { App as NativeApp } from "@capacitor/app";
import { Network } from "@capacitor/network";
import { PiCredentials } from "@pi-mobile/native-push";
import { configureMobileRuntime, openMobileNotificationTarget } from "../../web/src/mobile-runtime";
import { normalizeServerUrl, readServerStatus, type MobileConnection, type NotificationTarget } from "./connection";
import {
	authenticateConnection,
	notificationDestination,
	restoreConnection,
	restorePendingTarget,
	savePendingTarget,
	type ConnectionInput,
	type SavedConnection,
} from "./connections";
import { ConnectionScreen } from "./ConnectionScreen";
import { accessHubDevice, listHubDevices, type HubDevice } from "./hub";
import { mobileRequest } from "./connection";
import { PushController } from "./push-controller";
import { NotificationSettings } from "./Settings";
import "../../web/src/styles.css";
import "./styles.css";

const onboardingRoot = createRoot(document.getElementById("root")!);
const settingsRoot = createRoot(document.getElementById("mobile-settings")!);
const native = Capacitor.isNativePlatform();
const PENDING_TARGET = "pi-mobile:notification-target";
let settingsOpen = false;
let controller: PushController | null = null;
let hubConnection: MobileConnection | null = null;
let activeConnection: SavedConnection | null = null;
let devices: HubDevice[] = [];
let activeDevice: HubDevice | null = null;
let sharedUiStarted = false;
let initializing = true;
let pendingTarget: NotificationTarget | null = null;
let capabilityCreatedAt = 0;

function deviceId(): string {
	const key = "pi-mobile:installation-id";
	let id = localStorage.getItem(key);
	if (!id || !/^[a-f0-9-]{36}$/i.test(id)) {
		id = crypto.randomUUID();
		localStorage.setItem(key, id);
	}
	return id;
}
const installationId = deviceId();
const selectedKey = () => `pi-mobile:selected-device:${hubConnection!.serverUrl}`;

function DevicePicker({ embedded = false, error = "" }: { embedded?: boolean; error?: string }) {
	const [rows, setRows] = useState(devices);
	const [busy, setBusy] = useState("");
	const [message, setMessage] = useState(error);
	const refresh = async () => {
		setBusy("refresh");
		try {
			devices = await listHubDevices(hubConnection!);
			setRows(devices);
			setMessage("");
		} catch (cause) {
			setMessage(cause instanceof Error ? cause.message : "设备列表暂时无法刷新。");
		} finally {
			setBusy("");
		}
	};
	return (
		<main className={embedded ? "mobile-device-picker" : "mobile-connect-screen"}>
			<div className="mobile-connect-content">
				<p className="mobile-eyebrow">DEVICE CENTER</p>
				<h1>选择工作设备</h1>
				<p className="mobile-connect-description">切换设备后，任务仍在原设备运行。所有设备的通知会汇集到这部手机。</p>
				<div className="mobile-device-list">
					{rows.map((device) => (
						<button
							className="mobile-device-item"
							key={device.id}
							disabled={Boolean(busy) || !device.online}
							onClick={() => {
								setBusy(device.id);
								setMessage("");
								void selectDevice(device.id).catch((cause) => {
									setMessage(cause instanceof Error ? cause.message : "无法连接设备。");
									setBusy("");
								});
							}}
						>
							<span className="mobile-device-icon" aria-hidden="true">
								⌘
							</span>
							<span className="mobile-device-name">
								<strong>{device.name}</strong>
								<small>{device.remark || device.id}</small>
							</span>
							<span className="mobile-device-state">
								{busy === device.id
									? "连接中…"
									: activeDevice?.id === device.id
										? "当前设备"
										: device.online
											? "在线 →"
											: "离线"}
							</span>
						</button>
					))}
					{rows.length === 0 && <p className="mobile-hint">还没有已绑定的设备。请先在电脑的设备中心完成绑定。</p>}
				</div>
				{message && (
					<p className="mobile-error" role="alert">
						{message}
					</p>
				)}
				<div className="mobile-settings-actions">
					<button className="btn" disabled={Boolean(busy)} onClick={() => void refresh()}>
						刷新设备
					</button>
					<button className="btn" onClick={openSettings}>
						通知设置
					</button>
					{embedded && (
						<button className="btn" onClick={closeSettings}>
							返回会话
						</button>
					)}
				</div>
			</div>
		</main>
	);
}

function closeSettings(): void {
	settingsOpen = false;
	settingsRoot.render(null);
}

function openDeviceCenter(): void {
	if (activeConnection?.mode !== "hub") {
		openSettings();
		return;
	}
	settingsOpen = true;
	settingsRoot.render(
		<div className="mobile-settings-backdrop" onClick={closeSettings}>
			<section
				className="mobile-settings-panel"
				role="dialog"
				aria-modal="true"
				aria-label="选择工作设备"
				onClick={(event) => event.stopPropagation()}
			>
				<DevicePicker embedded />
			</section>
		</div>,
	);
}

function openSettings(): void {
	if (!controller || !activeConnection) return;
	settingsOpen = true;
	settingsRoot.render(
		<NotificationSettings
			controller={controller}
			connection={activeConnection}
			onClose={closeSettings}
			onChooseDevice={activeConnection.mode === "hub" ? openDeviceCenter : undefined}
			deviceName={activeDevice?.name}
			onDisconnect={async () => {
				await controller!.disconnect();
				if (activeConnection!.mode === "hub")
					await mobileRequest(activeConnection!, "/api/mobile-hub/logout", { method: "POST" });
				sessionStorage.removeItem(PENDING_TARGET);
				if (native) await PiCredentials.clear();
				window.history.replaceState(null, "", window.location.pathname);
				window.location.reload();
			}}
		/>,
	);
}

function flushTarget(): void {
	if (!pendingTarget) return;
	openMobileNotificationTarget(pendingTarget);
	pendingTarget = null;
}

function openTarget(target: NotificationTarget): void {
	if (!activeConnection) return;
	const destination = notificationDestination(activeConnection.mode, target);
	if (destination === "settings") {
		openSettings();
		return;
	}
	pendingTarget = target;
	if (initializing) return;
	if (destination === "conversation" || (sharedUiStarted && activeDevice?.id === target.deviceId)) {
		if (sharedUiStarted) flushTarget();
		return;
	}
	void selectDevice(target.deviceId!).catch((error) => {
		if (sharedUiStarted) openDeviceCenter();
		else
			onboardingRoot.render(
				<DevicePicker error={error instanceof Error ? error.message : "通知对应的设备暂不可用。"} />,
			);
	});
}

async function connect(input: ConnectionInput): Promise<void> {
	const connection = await authenticateConnection(input, installationId);
	if (native) await PiCredentials.set(connection);
	await enterConnection(connection);
}

async function enterConnection(connection: SavedConnection): Promise<void> {
	initializing = true;
	if (connection.mode === "hub") devices = await listHubDevices(connection);
	else await readServerStatus(connection, installationId);
	activeConnection = connection;
	hubConnection = connection.mode === "hub" ? connection : null;
	activeDevice = null;
	pendingTarget = null;
	if (controller) await controller.dispose();
	controller = new PushController(connection, installationId, openTarget, openSettings);
	try {
		await controller.initialize();
	} catch {}
	const savedTarget = sessionStorage.getItem(PENDING_TARGET);
	sessionStorage.removeItem(PENDING_TARGET);
	pendingTarget = restorePendingTarget(savedTarget, connection, controller.getDetails().instanceId) ?? pendingTarget;
	initializing = false;
	if (connection.mode === "direct") {
		await startSharedUi(connection);
		return;
	}
	const preferred = pendingTarget?.deviceId ?? localStorage.getItem(selectedKey());
	if (preferred && devices.some((device) => device.id === preferred && device.online)) await selectDevice(preferred);
	else
		onboardingRoot.render(<DevicePicker error={pendingTarget ? "通知对应的设备当前离线或已解绑，请稍后重试。" : ""} />);
}

async function selectDevice(id: string): Promise<void> {
	let device = devices.find((entry) => entry.id === id);
	if (!device?.online) {
		devices = await listHubDevices(hubConnection!);
		device = devices.find((entry) => entry.id === id);
	}
	if (!device?.online) throw new Error("这台设备离线或已解绑，请刷新设备列表。");
	if (sharedUiStarted) {
		if (activeDevice?.id === id) {
			closeSettings();
			if (pendingTarget) {
				openMobileNotificationTarget(pendingTarget);
				pendingTarget = null;
			}
			return;
		}
		await accessHubDevice(hubConnection!, id);
		localStorage.setItem(selectedKey(), id);
		if (pendingTarget) sessionStorage.setItem(PENDING_TARGET, savePendingTarget(activeConnection!, pendingTarget));
		window.history.replaceState(null, "", window.location.pathname);
		window.location.reload();
		return;
	}
	const access = await accessHubDevice(hubConnection!, id);
	activeDevice = device;
	capabilityCreatedAt = Date.now();
	localStorage.setItem(selectedKey(), id);
	await startSharedUi(access);
}

async function startSharedUi(connection: MobileConnection): Promise<void> {
	configureMobileRuntime({
		serverUrl: connection.serverUrl,
		token: connection.token,
		pushAdapter: controller!,
		deviceAdapter: {
			openDevice: async (deviceId, requestedHubUrl) => {
				if (!hubConnection || normalizeServerUrl(requestedHubUrl) !== hubConnection.serverUrl) {
					openSettings();
					throw new Error("请先切换为对应的设备中心登录，再打开其他设备。");
				}
				await selectDevice(deviceId);
			},
			openDeviceCenter,
		},
	});
	if (pendingTarget) {
		openMobileNotificationTarget(pendingTarget);
		pendingTarget = null;
	}
	closeSettings();
	onboardingRoot.unmount();
	await import("../../web/src/main");
	sharedUiStarted = true;
	flushTarget();
	installLifecycle();
}

function installLifecycle(): void {
	if (native) {
		let refreshing: Promise<void> | null = null;
		const resume = () => {
			// Capabilities expire; renew them through the authenticated hub, never retain one as a saved password.
			if (activeConnection?.mode === "hub" && Date.now() - capabilityCreatedAt > 7.5 * 60 * 60 * 1000) {
				window.location.reload();
				return;
			}
			window.dispatchEvent(new Event("focus"));
			if (!refreshing)
				refreshing = controller!.refresh().finally(() => {
					refreshing = null;
				});
		};
		void NativeApp.addListener("appStateChange", ({ isActive }) => {
			if (isActive) resume();
		});
		void Network.addListener("networkStatusChange", ({ connected }) => {
			window.dispatchEvent(new Event(connected ? "online" : "offline"));
			if (connected) resume();
		});
		if (Capacitor.getPlatform() === "android")
			void NativeApp.addListener("backButton", ({ canGoBack }) => {
				if (settingsOpen) closeSettings();
				else if (canGoBack) window.history.back();
				else void NativeApp.minimizeApp();
			});
	}
	window.addEventListener("keydown", (event) => {
		if (event.key === "Escape") closeSettings();
	});
}

function showConnectionScreen(saved?: SavedConnection, initialError?: string): void {
	onboardingRoot.render(
		<ConnectionScreen saved={saved} initialError={initialError} onConnect={connect} onRetry={enterConnection} />,
	);
}

async function boot(): Promise<void> {
	onboardingRoot.render(
		<main className="mobile-restore-screen">
			<div className="mobile-logo" aria-hidden="true">
				π
			</div>
			<p>正在恢复连接…</p>
		</main>,
	);
	if (native) {
		let saved: SavedConnection | undefined;
		try {
			const credentials = await PiCredentials.get();
			if (credentials) {
				saved = restoreConnection(credentials);
				await enterConnection(saved);
				return;
			}
		} catch (cause) {
			showConnectionScreen(saved, cause instanceof Error ? cause.message : "暂时无法恢复连接，请重试。");
			return;
		}
	}
	showConnectionScreen();
}
void boot();
