import { Capacitor, type PluginListenerHandle } from "@capacitor/core";
import { PiPush, type PushStatus } from "@pi-mobile/native-push";
import type {
	MobileNotifyKind,
	MobilePushAdapter,
	MobilePushPermission,
	MobilePushState,
} from "../../web/src/mobile-runtime";
import {
	PUSH_KINDS,
	mobileRequest,
	notificationTarget,
	readServerStatus,
	type MobileConnection,
	type NotificationTarget,
	type PushKind,
} from "./connection";

export interface PushDetails extends MobilePushState {
	configured: boolean;
	registrationReady: boolean;
	instanceId: string;
	kinds: PushKind[];
	error: string;
	pendingDisable: boolean;
	testQueued: boolean;
}

/** Background delivery belongs to the server and OS, never a running web view. */
export class PushController implements MobilePushAdapter {
	private state: PushDetails = {
		supported: Capacitor.isNativePlatform(),
		permission: "default",
		enabled: false,
		configured: false,
		registrationReady: false,
		instanceId: "",
		kinds: [...PUSH_KINDS],
		error: "",
		pendingDisable: false,
		testQueued: false,
	};
	private listeners = new Set<() => void>();
	private nativeListeners: PluginListenerHandle[] = [];
	private registrationId = "";
	private enableRequested = false;
	private operations: Promise<unknown> = Promise.resolve();
	private openedEvents = new Set<string>();
	private pendingTap: unknown = null;
	private pendingKey: string;
	private kindsKey: string;

	constructor(
		private connection: MobileConnection,
		readonly deviceId: string,
		private onOpen: (target: NotificationTarget) => void,
		readonly openSettings: () => void,
		/** 前台收到推送时回调：JPush 只负责后台系统通知，前台得自己给应用内提示。 */
		private onForeground?: (extras: Record<string, string>) => void,
	) {
		this.pendingKey = `pi-mobile:unsubscribe:${connection.serverUrl}:${deviceId}`;
		this.kindsKey = `pi-mobile:notify-kinds:${connection.serverUrl}:${deviceId}`;
		this.state.pendingDisable = localStorage.getItem(this.pendingKey) === "1";
		try {
			const kinds = JSON.parse(localStorage.getItem(this.kindsKey) ?? "null") as unknown;
			if (Array.isArray(kinds) && kinds.every((kind) => PUSH_KINDS.includes(kind)))
				this.state.kinds = PUSH_KINDS.filter((kind) => kinds.includes(kind));
		} catch {}
	}

	getState = (): MobilePushState => this.state;
	getDetails = (): PushDetails => this.state;
	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	private update(patch: Partial<PushDetails>): void {
		this.state = { ...this.state, ...patch };
		for (const listener of this.listeners) listener();
	}

	private applyNative(status: PushStatus): void {
		this.registrationId = status.registrationId || "";
		this.update({
			permission: status.permission === "prompt" ? "default" : status.permission,
			registrationReady: Boolean(this.registrationId),
		});
	}

	async initialize(): Promise<void> {
		if (this.state.supported) {
			this.nativeListeners = await Promise.all([
				PiPush.addListener("registration", ({ registrationId }) => {
					this.registrationId = registrationId;
					this.update({ registrationReady: Boolean(registrationId) });
					if (this.enableRequested && registrationId) {
						void this.enqueue(() => this.register()).catch((error) => this.report(error));
					}
				}),
				PiPush.addListener("notificationOpened", ({ extras }) => this.open(extras)),
				PiPush.addListener("notificationReceived", ({ extras }) => this.onForeground?.(extras)),
			]);
			this.applyNative(await PiPush.getStatus());
			const pending = await PiPush.getPendingNotification();
			if (pending) this.pendingTap = pending.extras;
		}
		await this.refresh();
	}

	private report(error: unknown): void {
		this.update({ error: error instanceof Error ? error.message : "通知状态暂时无法同步。" });
	}

	async refresh(): Promise<void> {
		try {
			if (this.state.supported) this.applyNative(await PiPush.getStatus());
			const server = await readServerStatus(this.connection, this.deviceId);
			this.enableRequested = Boolean(server.device?.enabled) && !this.state.pendingDisable;
			this.update({
				configured: server.configured,
				instanceId: server.instanceId,
				enabled: this.enableRequested,
				kinds: server.device?.kinds ?? this.state.kinds,
				error: "",
			});
			if (this.state.pendingDisable) {
				await this.disableRemote();
			} else if (this.enableRequested && this.registrationId && this.state.permission === "granted") {
				await this.enqueue(() => this.register());
			}
			if (this.pendingTap) {
				const tap = this.pendingTap;
				this.pendingTap = null;
				this.open(tap);
			}
		} catch (error) {
			this.report(error);
		}
	}

	private open(extras: unknown): void {
		if (!this.state.instanceId) {
			this.pendingTap = extras;
			return;
		}
		const target = notificationTarget(extras, this.state.instanceId);
		if (!target) {
			this.update({ error: "这条通知无法在当前服务器打开，请检查连接或在会话列表中查找。" });
			return;
		}
		const key = `${target.deviceId ?? "local"}:${target.eventId}`;
		if (this.openedEvents.has(key)) return;
		this.openedEvents.add(key);
		if (this.openedEvents.size > 256) this.openedEvents.delete(this.openedEvents.values().next().value!);
		this.onOpen(target);
	}

	requestPermission = async (): Promise<MobilePushPermission> => {
		if (!this.state.supported) return "denied";
		this.applyNative(await PiPush.enable());
		return this.state.permission;
	};

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const next = this.operations.then(operation, operation);
		this.operations = next.catch(() => undefined);
		return next;
	}

	setEnabled = (enabled: boolean): Promise<void> => this.enqueue(() => this.changeEnabled(enabled));

	private async changeEnabled(enabled: boolean): Promise<void> {
		this.update({ error: "", testQueued: false });
		if (!enabled) {
			this.enableRequested = false;
			localStorage.setItem(this.pendingKey, "1");
			this.update({ enabled: false, pendingDisable: true });
			if (this.state.supported) await PiPush.disable();
			try {
				await this.disableRemote();
			} catch {
				this.update({ error: "本机通知已关闭，恢复连接后会同步服务器。" });
			}
			return;
		}
		if (!this.state.supported) throw new Error("请在 Android 或 iPhone 安装包中开启系统通知。");
		const server = await readServerStatus(this.connection, this.deviceId);
		if (!server.configured) throw new Error("服务端尚未配置推送，请先完成服务器通知设置。");
		this.update({ configured: true, instanceId: server.instanceId });
		this.applyNative(await PiPush.enable());
		if (this.state.permission !== "granted") throw new Error("请在手机系统设置中允许 pi 发送通知。");
		this.enableRequested = true;
		for (let attempt = 0; !this.registrationId && attempt < 20; attempt++) {
			await new Promise<void>((resolve) => setTimeout(resolve, 400));
			this.applyNative(await PiPush.getStatus());
		}
		if (!this.registrationId) {
			this.enableRequested = false;
			throw new Error("正在获取通知标识，请检查网络后重试。");
		}
		localStorage.removeItem(this.pendingKey);
		this.update({ pendingDisable: false });
		await this.register();
	}

	private async register(): Promise<void> {
		if (!this.enableRequested || !this.registrationId || this.state.pendingDisable) return;
		await mobileRequest(this.connection, "/api/mobile-push/devices", {
			method: "POST",
			body: JSON.stringify({
				deviceId: this.deviceId,
				registrationId: this.registrationId,
				platform: Capacitor.getPlatform() === "ios" ? "ios" : "android",
				enabled: true,
				kinds: this.state.kinds,
				preview: "generic",
			}),
		});
		this.update({ enabled: true, error: "" });
	}

	private async disableRemote(): Promise<void> {
		await mobileRequest(this.connection, `/api/mobile-push/devices/${this.deviceId}`, { method: "DELETE" });
		localStorage.removeItem(this.pendingKey);
		this.update({ enabled: false, pendingDisable: false });
	}

	setKinds = (kinds: MobileNotifyKind[]): Promise<void> =>
		this.enqueue(async () => {
			const selected = PUSH_KINDS.filter((kind) => kinds.includes(kind));
			if (this.state.enabled) {
				await mobileRequest(this.connection, `/api/mobile-push/devices/${this.deviceId}`, {
					method: "PATCH",
					body: JSON.stringify({ kinds: selected }),
				});
			}
			localStorage.setItem(this.kindsKey, JSON.stringify(selected));
			this.update({ kinds: selected });
		});

	async sendTest(): Promise<void> {
		this.update({ testQueued: false });
		await mobileRequest(this.connection, `/api/mobile-push/devices/${this.deviceId}/test`, { method: "POST" });
		this.update({ testQueued: true });
	}

	async disconnect(): Promise<void> {
		await this.setEnabled(false);
		if (this.state.pendingDisable) {
			throw new Error("请先恢复服务器连接以解绑通知，再切换服务器。");
		}
	}

	async dispose(): Promise<void> {
		for (const listener of this.nativeListeners) await listener.remove();
		this.nativeListeners = [];
		this.listeners.clear();
	}
}
