import { appBase, withAppBase } from "./base-url";
import { getMobileRuntime, isMobileRuntime } from "./mobile-runtime";
import { loadSoundSettings, type SoundKind, type SoundSettings } from "./sounds";
import { formatSessionHash } from "./session-url";

const NOTIFICATION_CLICK = "pi-web-ui:notification-click";

export function subscribeNotificationClicks(onClick: (url: string) => void): () => void {
	const handle = (event: Event) => {
		const data = event instanceof CustomEvent ? event.detail : (event as MessageEvent).data;
		if (data?.type !== NOTIFICATION_CLICK || typeof data.url !== "string") return;
		try {
			const url = isMobileRuntime() ? new URL(data.url, window.location.href) : new URL(data.url);
			const localBase = new URL(appBase(), window.location.href);
			if (url.origin !== localBase.origin || !url.pathname.startsWith(localBase.pathname)) return;
			if (isMobileRuntime()) url.searchParams.delete("token");
			onClick(url.href);
		} catch {}
	};
	window.addEventListener(NOTIFICATION_CLICK, handle);
	if (!isMobileRuntime()) navigator.serviceWorker?.addEventListener("message", handle);
	return () => {
		window.removeEventListener(NOTIFICATION_CLICK, handle);
		if (!isMobileRuntime()) navigator.serviceWorker?.removeEventListener("message", handle);
	};
}

export const NOTIFY_EVENTS = ["question", "done", "subagentDone", "start", "error", "approval"] as const;
export type NotifyEventMode = "follow" | "on" | "off";

export interface NotifySettings {
	enabled: boolean;
	events?: Partial<Record<SoundKind, NotifyEventMode>>;
}

export function isNotifyEventEnabled(kind: SoundKind, settings: NotifySettings, sound: SoundSettings): boolean {
	if (!settings.enabled) return false;
	const mode = settings.events?.[kind];
	return mode === "on" || (mode !== "off" && sound[kind]);
}

const STORAGE_KEY = "pi-web-notify";

const DEFAULT_NOTIFY_SETTINGS: NotifySettings = { enabled: false };

export function loadNotifySettings(): NotifySettings {
	const mobile = getMobileRuntime();
	const mobileState = mobile?.pushAdapter?.getState();
	const enabled = mobile ? (mobileState?.enabled ?? false) : undefined;
	if (mobileState?.kinds) {
		return {
			enabled: mobileState.enabled,
			events: Object.fromEntries(NOTIFY_EVENTS.map((kind) => [kind, mobileState.kinds!.includes(kind) ? "on" : "off"])),
		};
	}
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return { enabled: enabled ?? DEFAULT_NOTIFY_SETTINGS.enabled };
		const parsed = JSON.parse(raw) as Partial<NotifySettings>;
		const events: NonNullable<NotifySettings["events"]> = {};
		for (const kind of NOTIFY_EVENTS) {
			const mode = parsed.events?.[kind];
			if (mode === "follow" || mode === "on" || mode === "off") events[kind] = mode;
		}
		return {
			enabled: enabled ?? (typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULT_NOTIFY_SETTINGS.enabled),
			events,
		};
	} catch {
		return { enabled: enabled ?? DEFAULT_NOTIFY_SETTINGS.enabled };
	}
}

export function subscribeNotificationState(listener: () => void): () => void {
	return getMobileRuntime()?.pushAdapter?.subscribe(listener) ?? (() => {});
}

export async function syncMobileNotificationKinds(settings = loadNotifySettings()): Promise<void> {
	const adapter = getMobileRuntime()?.pushAdapter;
	if (!adapter?.setKinds) return;
	const sound = loadSoundSettings();
	const kinds = NOTIFY_EVENTS.filter((kind) => isNotifyEventEnabled(kind, { ...settings, enabled: true }, sound));
	await adapter.setKinds(kinds);
}

export async function setNotificationsEnabled(enabled: boolean): Promise<boolean> {
	const permission = enabled ? await requestNotificationPermission() : notificationPermission();
	const next = enabled && permission === "granted";
	const mobile = getMobileRuntime();
	if (mobile) {
		const adapter = mobile.pushAdapter;
		if (!adapter) return false;
		if (next) await syncMobileNotificationKinds();
		await adapter.setEnabled(next);
		return adapter.getState().enabled;
	}
	return next;
}

export function saveNotifySettings(settings: NotifySettings): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
	} catch {}
	void syncMobileNotificationKinds(settings).catch((error) => console.warn("Push event settings failed:", error));
}

export function notificationsSupported(): boolean {
	if (isMobileRuntime()) return getMobileRuntime()?.pushAdapter?.getState().supported ?? false;
	return typeof window !== "undefined" && "Notification" in window;
}

type NotifyBlockReason = "insecure" | "unsupported";

export function notifyBlockReason(): NotifyBlockReason | null {
	if (notificationsSupported()) return null;
	if (isMobileRuntime()) return "unsupported";
	if (typeof window !== "undefined" && window.isSecureContext === false) return "insecure";
	return "unsupported";
}

interface WindowRect {
	screenX: number;
	screenY: number;
	outerWidth: number;
	outerHeight: number;
}

export const NOTIFY_IDLE_GRACE_MS = 120_000;

export interface PresenceSignals {
	hasFocus: boolean;
	visibility: string;
	minimized: boolean;
	idleMs: number;
	windows: boolean;
}

export function isCollapsedWindow(rect: WindowRect): boolean {
	const { screenX, screenY, outerWidth, outerHeight } = rect;
	if (Number.isFinite(screenX) && offScreen(screenX)) return true;
	if (Number.isFinite(screenY) && offScreen(screenY)) return true;
	return outerWidth > 0 && outerWidth <= 400 && outerHeight > 0 && outerHeight <= 40;
}

function offScreen(coordinate: number): boolean {
	return coordinate <= -10000;
}

export function shouldSuppressNotify(presence: PresenceSignals): boolean {
	if (presence.visibility !== "visible") return false;
	if (presence.minimized) return false;
	if (!presence.hasFocus) return false;
	if (presence.windows && presence.idleMs > NOTIFY_IDLE_GRACE_MS) return false;
	return true;
}

let lastActivityMs = Date.now();
let activityBound = false;

export function markActivity(): void {
	lastActivityMs = Date.now();
}

export function idleSinceLastActivityMs(): number {
	return Math.max(0, Date.now() - lastActivityMs);
}

function bindActivityTracking(): void {
	if (activityBound || typeof window === "undefined") return;
	activityBound = true;
	const options: AddEventListenerOptions = { passive: true, capture: true };
	for (const event of ["pointerdown", "pointermove", "keydown", "wheel", "touchstart", "focus", "scroll"]) {
		window.addEventListener(event, markActivity, options);
	}
	if (typeof document !== "undefined") {
		document.addEventListener("visibilitychange", markActivity, options);
	}
}

export function isWindowsPlatform(): boolean {
	if (typeof navigator === "undefined") return false;
	return /windows/i.test(navigator.userAgent ?? "");
}

export function currentPresence(): PresenceSignals {
	bindActivityTracking();
	if (typeof window === "undefined" || typeof document === "undefined") {
		return { hasFocus: true, visibility: "visible", minimized: false, idleMs: 0, windows: false };
	}
	return {
		hasFocus: typeof document.hasFocus === "function" ? document.hasFocus() : true,
		visibility: document.visibilityState ?? "",
		minimized: isCollapsedWindow({
			screenX: window.screenX,
			screenY: window.screenY,
			outerWidth: window.outerWidth,
			outerHeight: window.outerHeight,
		}),
		idleMs: idleSinceLastActivityMs(),
		windows: isWindowsPlatform(),
	};
}

export function notificationPermission(): NotificationPermission {
	if (isMobileRuntime()) return getMobileRuntime()?.pushAdapter?.getState().permission ?? "denied";
	if (!notificationsSupported()) return "denied";
	return Notification.permission;
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
	if (isMobileRuntime()) return getMobileRuntime()?.pushAdapter?.requestPermission() ?? "denied";
	if (!notificationsSupported()) return "denied";
	try {
		return await Notification.requestPermission();
	} catch {
		return "denied";
	}
}

type NotifyPath = "sw" | "page" | "none";

interface NotifyAttempt {
	path: NotifyPath;
	error?: string;
}

function describeError(err: unknown): string {
	if (err instanceof Error) return `${err.name}: ${err.message}`;
	return String(err);
}

function notificationOptions(body?: string, sticky = false, sessionId?: string): NotificationOptions {
	let target = typeof location !== "undefined" ? location.href : appBase();
	try {
		const url = new URL(target);
		url.searchParams.delete("token");
		url.searchParams.delete("view");
		if (sessionId) url.hash = formatSessionHash({ sessionId });
		target = url.href;
	} catch {}
	return {
		body,
		requireInteraction: sticky,
		icon: withAppBase("/icons/icon-192.png", appBase()),
		badge: withAppBase("/icons/icon-192.png", appBase()),
		data: { url: target },
	};
}

async function showNow(title: string, body?: string, sticky = false, sessionId?: string): Promise<NotifyAttempt> {
	if (isMobileRuntime()) return { path: "none", error: "native push" };
	if (!notificationsSupported()) return { path: "none", error: "unsupported" };
	if (Notification.permission !== "granted") return { path: "none", error: `permission: ${Notification.permission}` };

	const options = notificationOptions(body, sticky, sessionId);
	let swError: string | undefined;
	try {
		const reg = await navigator.serviceWorker?.getRegistration();
		if (reg?.active && typeof reg.showNotification === "function") {
			await reg.showNotification(title, options);
			return { path: "sw" };
		}
		swError = reg ? "service worker not active" : "no service worker registration";
	} catch (err) {
		swError = describeError(err);
	}
	try {
		const notification = new Notification(title, options);
		notification.onclick = () => {
			notification.close();
			window.focus();
			window.dispatchEvent(
				new CustomEvent(NOTIFICATION_CLICK, { detail: { type: NOTIFICATION_CLICK, url: options.data.url } }),
			);
		};
		return { path: "page", error: swError };
	} catch (err) {
		return { path: "none", error: `${swError}; page: ${describeError(err)}` };
	}
}

export async function notify(
	title: string,
	body?: string,
	kind: SoundKind = "done",
	sessionId?: string,
): Promise<void> {
	if (isMobileRuntime() || !notificationsSupported()) return;
	if (shouldSuppressNotify(currentPresence())) return;
	if (!isNotifyEventEnabled(kind, loadNotifySettings(), loadSoundSettings())) return;
	await showNow(title, body, false, sessionId);
}

export interface NotifyDiagnostics extends NotifyAttempt {
	permission: NotificationPermission;
	supported: boolean;
	secureContext: boolean;
	serviceWorker: boolean;
	suppressed: boolean;
	presence: PresenceSignals;
	held: number | null;
}

export async function sendTestNotification(title: string, body?: string): Promise<NotifyDiagnostics> {
	const presence = currentPresence();
	const base = {
		permission: notificationPermission(),
		supported: notificationsSupported(),
		secureContext: typeof window !== "undefined" ? window.isSecureContext !== false : false,
		serviceWorker: false,
		suppressed: shouldSuppressNotify(presence),
		presence,
		held: null as number | null,
	};
	if (isMobileRuntime()) return { ...base, path: "none", error: "native push" };
	if (!base.supported) return { ...base, path: "none", error: "unsupported" };
	let reg: ServiceWorkerRegistration | undefined;
	try {
		reg = await navigator.serviceWorker?.getRegistration();
		base.serviceWorker = !!reg;
	} catch {}
	const attempt = await showNow(title, body, true);
	if (attempt.path === "sw" && reg?.active && typeof reg.getNotifications === "function") {
		try {
			base.held = (await reg.getNotifications()).length;
		} catch {
			base.held = null;
		}
	}
	return { ...base, ...attempt };
}
