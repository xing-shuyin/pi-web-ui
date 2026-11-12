import { deviceLabel } from "../../server/device-center/device-label";
import { appBase, appUrl } from "./base-url";
import { withToken } from "./auth-token";
import { getMobileRuntime } from "./mobile-runtime";
import { randomUuid } from "./uuid";

export type DesktopTransport = "lan" | "p2p" | "hub" | "current";

export function pageDeviceId(): string | undefined {
	return appBase().match(/\/(?:device|device-lan)\/([a-z0-9][a-z0-9-]{0,62})\/__relay\/[a-f0-9]{64}\/$/)?.[1];
}

export async function openPageDesktop(zh: boolean, name: string, signal?: AbortSignal) {
	const id = pageDeviceId();
	if (!id) return;
	const response = await fetch(withToken(appUrl("/api/device-center/chat-status")), {
		credentials: "same-origin",
		signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
	});
	if (!response.ok) throw new Error("Device status unavailable");
	const status = await response.json();
	if (signal?.aborted) return;
	await openDeviceAccess(
		id,
		typeof status.hubUrl === "string" ? status.hubUrl : "",
		true,
		zh,
		false,
		deviceLabel(status.name, status.remark, name),
	);
}

export type DesktopAccess = {
	id: string;
	hubUrl: string;
	zh: boolean;
	name?: string;
	revision: number;
	mode: "preview" | "live";
};
let desktopAccess: DesktopAccess | null = null;
let revision = 0;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
export const subscribeDesktopAccess = (listener: () => void) => {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
};
export const getDesktopAccess = () => desktopAccess;
export function closeDesktopAccess(expected: DesktopAccess) {
	if (desktopAccess?.revision !== expected.revision) return;
	desktopAccess = null;
	notify();
}
export function setDesktopMode(expected: DesktopAccess, mode: DesktopAccess["mode"]) {
	if (desktopAccess?.revision !== expected.revision) return;
	desktopAccess = { ...desktopAccess, mode };
	notify();
	if (mode === "preview") window.dispatchEvent(new Event("pi:desktop-open"));
}
export async function requestDeviceAccessUrl(
	id: string,
	hubUrl: string,
	desktop: boolean,
	zh: boolean,
	preview = false,
	signal?: AbortSignal,
) {
	if (desktop && id === pageDeviceId()) {
		return {
			url: new URL(withToken(appUrl(preview ? "/desktop-preview" : "/desktop")), window.location.href).href,
			transport: "current" as const,
			fallbackOrigin: undefined,
		};
	}
	const response = await fetch(withToken(appUrl(`/api/device-center/devices/${encodeURIComponent(id)}/open`)), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ preferLan: true, desktop, basePath: new URL(appUrl("/"), window.location.href).pathname }),
		credentials: "same-origin",
		signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
	});
	if (!response.ok)
		throw new Error(
			zh
				? "无法打开设备，请确认设备在线且本机绑定有效。"
				: "Could not open the device. Check connectivity and local pairing.",
		);
	const data = await response.json();
	const direct = data.transport === "lan" || data.transport === "p2p";
	const url = direct ? new URL(appUrl(data.url), window.location.href) : new URL(data.url);
	const hub = new URL(hubUrl);
	const directEndpoint = new URL(appUrl(`/device-lan/${id}/__open`), window.location.href);
	const allowedLocation = direct
		? typeof data.url === "string" &&
			/^\/device-lan\/[a-z0-9][a-z0-9-]{0,62}\/__open\?ticket=[a-f0-9]{64}$/.test(data.url) &&
			url.origin === directEndpoint.origin &&
			url.pathname === directEndpoint.pathname
		: url.hostname === hub.hostname &&
			(url.pathname === "/__device/open" ||
				(url.origin === hub.origin && url.pathname === `/device/${encodeURIComponent(id)}/__open`));
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !allowedLocation)
		throw new Error("Invalid device access URL");
	url.searchParams.delete("next");
	if (desktop) url.searchParams.set("next", preview ? "/desktop-preview" : "/desktop");
	return {
		url: url.href,
		transport: data.transport === "p2p" ? ("p2p" as const) : direct ? ("lan" as const) : ("hub" as const),
		fallbackOrigin: data.fallbackOrigin,
	};
}

export async function openDeviceAccess(
	id: string,
	hubUrl: string,
	desktop: boolean,
	zh: boolean,
	detached = false,
	name?: string,
) {
	const mobile = getMobileRuntime();
	if (mobile) {
		if (!mobile.deviceAdapter) throw new Error("Native device access is unavailable");
		await mobile.deviceAdapter.openDevice(id, hubUrl);
		return;
	}
	if (desktop && !detached) {
		desktopAccess = { id, hubUrl, zh, name, revision: ++revision, mode: "preview" };
		notify();
		window.dispatchEvent(new Event("pi:desktop-open"));
		return;
	}
	if (desktop && detached && id === pageDeviceId() && window.parent !== window) {
		await openPortalDesktop(zh);
		return;
	}
	const shell = (window as unknown as { piDesktop?: { openHub?: (url: string) => Promise<boolean> } }).piDesktop;
	const tab = shell?.openHub ? null : window.open("about:blank", "_blank");
	if (!shell?.openHub && !tab) throw new Error(zh ? "请允许弹出窗口后重试。" : "Allow popups and try again.");
	if (tab) tab.opener = null;
	try {
		const target = await requestDeviceAccessUrl(id, hubUrl, desktop, zh);
		const url = new URL(target.url);
		if (shell?.openHub) {
			if (target.transport !== "hub") {
				url.searchParams.set("hub", new URL(hubUrl).origin);
				if (typeof target.fallbackOrigin === "string") url.searchParams.set("portal", target.fallbackOrigin);
			}
			if (!(await shell.openHub(url.href)))
				throw new Error(zh ? "无法打开设备窗口。" : "Could not open device window.");
		} else if (tab) tab.location.replace(url.href);
	} catch (error) {
		tab?.close();
		throw error;
	}
}

function openPortalDesktop(zh: boolean): Promise<void> {
	const requestId = randomUuid();
	const origin = new URL(appUrl("/"), window.location.href).origin;
	return new Promise((resolve, reject) => {
		const finish = (error?: string) => {
			clearTimeout(timer);
			window.removeEventListener("message", receive);
			if (error) reject(new Error(error));
			else resolve();
		};
		const unavailable = zh
			? "无法打开独立标签，请更新本机和 Hub 后重试。"
			: "Could not open a tab. Update this computer and the Hub, then retry.";
		const receive = (event: MessageEvent) => {
			if (
				event.source !== window.parent ||
				event.origin !== origin ||
				event.data?.type !== "device-desktop-open-result" ||
				event.data.requestId !== requestId
			)
				return;
			finish(
				event.data.ok === true
					? undefined
					: event.data.error === "popup"
						? zh
							? "请允许弹出窗口后重试。"
							: "Allow popups and try again."
						: unavailable,
			);
		};
		const timer = setTimeout(() => finish(unavailable), 30000);
		window.addEventListener("message", receive);
		window.parent.postMessage({ type: "device-desktop-open", requestId }, origin);
	});
}
