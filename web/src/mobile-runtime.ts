export type MobilePushPermission = "default" | "granted" | "denied";

export interface MobilePushState {
	supported: boolean;
	permission: MobilePushPermission;
	enabled: boolean;
	kinds?: MobileNotifyKind[];
}

export type MobileNotifyKind = "question" | "done" | "subagentDone" | "start" | "error" | "approval";

export interface MobilePushAdapter {
	getState(): MobilePushState;
	subscribe(listener: () => void): () => void;
	requestPermission(): Promise<MobilePushPermission>;
	setEnabled(enabled: boolean): Promise<void>;
	setKinds?(kinds: MobileNotifyKind[]): Promise<void>;
	openSettings?(): void;
}

export interface MobileDeviceAdapter {
	openDevice(deviceId: string, hubUrl: string): Promise<void>;
	openDeviceCenter(): void;
}

export interface MobileRuntimeConfig {
	serverUrl: string;
	/** Kept in memory; the shell owns secure persistence. */
	token: string;
	pushAdapter?: MobilePushAdapter;
	deviceAdapter?: MobileDeviceAdapter;
}

export interface MobileNotificationTarget {
	eventId: string;
	instanceId: string;
	sessionId: string;
	clientId?: string;
	conversationId?: string;
}

export function mobileNotificationRequest(target: MobileNotificationTarget, currentClientId: string) {
	if (!target || typeof target.clientId !== "string" || typeof target.conversationId !== "string") return null;
	if (!target.clientId || !target.conversationId) return null;
	return target.clientId === currentClientId
		? { type: "switch_conversation" as const, id: target.conversationId }
		: { type: "open_shared_conversation" as const, owner: target.clientId, id: target.conversationId, readOnly: true };
}

export const MOBILE_NOTIFICATION_OPEN = "pi-mobile:notification-open";
let pendingNotification: Readonly<MobileNotificationTarget> | null = null;

export function openMobileNotificationTarget(target: MobileNotificationTarget): void {
	if (!runtime) return;
	pendingNotification = Object.freeze({ ...target });
	const browser = (globalThis as unknown as { window?: { dispatchEvent(event: Event): boolean } }).window;
	browser?.dispatchEvent(new CustomEvent(MOBILE_NOTIFICATION_OPEN, { detail: pendingNotification }));
}

export function hasPendingMobileNotificationTarget(): boolean {
	return pendingNotification !== null;
}

export function consumeMobileNotificationTarget(): Readonly<MobileNotificationTarget> | null {
	const target = pendingNotification;
	pendingNotification = null;
	return target;
}

let runtime: Readonly<MobileRuntimeConfig> | null = null;
let installedFetch: typeof globalThis.fetch | null = null;

export function getMobileRuntime(): Readonly<MobileRuntimeConfig> | null {
	return runtime;
}

export function isMobileRuntime(): boolean {
	return runtime !== null;
}

/** Match the configured service origin and path boundary, including WebSockets. */
export function isMobileServerUrl(input: string | URL): boolean {
	if (!runtime) return false;
	try {
		const url = new URL(input);
		if (url.protocol === "wss:") url.protocol = "https:";
		else if (url.protocol === "ws:") url.protocol = "http:";
		const base = new URL(`${runtime.serverUrl}/`);
		return (
			!url.username &&
			!url.password &&
			url.origin === base.origin &&
			(url.pathname === base.pathname.slice(0, -1) || url.pathname.startsWith(base.pathname))
		);
	} catch {
		return false;
	}
}

/** Only service fetches receive the bearer token. Redirects cannot forward it elsewhere. */
export function configureMobileRuntime(config: MobileRuntimeConfig): void {
	const base = new URL(config.serverUrl.trim());
	if (
		!["http:", "https:"].includes(base.protocol) ||
		base.username ||
		base.password ||
		base.search ||
		base.hash ||
		/[\r\n]/.test(config.token)
	) {
		throw new Error("Invalid mobile service configuration");
	}
	const serverUrl = base.href.replace(/\/+$/, "");
	if (runtime && runtime.serverUrl !== serverUrl) pendingNotification = null;
	runtime = Object.freeze({ ...config, serverUrl, token: config.token.trim() });
	if (globalThis.fetch === installedFetch) return;
	const fetchService = globalThis.fetch.bind(globalThis);
	installedFetch = (input, init) => {
		const request = typeof Request !== "undefined" && input instanceof Request ? input : null;
		const url = request ? request.url : String(input);
		if (!runtime?.token || !isMobileServerUrl(url)) return fetchService(input, init);
		const headers = new Headers(init?.headers ?? request?.headers);
		headers.set("Authorization", `Bearer ${runtime.token}`);
		return fetchService(input, { ...init, headers, credentials: "omit", redirect: "error" });
	};
	globalThis.fetch = installedFetch;
}
