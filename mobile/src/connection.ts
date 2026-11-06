export interface MobileConnection {
	serverUrl: string;
	token: string;
}

export const PUSH_KINDS = ["done", "error", "question", "approval", "subagentDone"] as const;
export type PushKind = (typeof PUSH_KINDS)[number];

export interface ServerPushStatus {
	configured: boolean;
	instanceId: string;
	device?: { enabled: boolean; kinds: PushKind[] } | null;
}

function localHttpHost(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (host === "localhost" || host === "::1" || host.endsWith(".local")) return true;
	if (/^(?:fc|fd)[0-9a-f]{2}:|^fe[89ab][0-9a-f]:/.test(host)) return true;
	const parts = host.split(".");
	if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
	const [a, b] = parts.map(Number);
	return (
		a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254)
	);
}

export function normalizeServerUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		throw new Error("请输入完整的服务器地址，例如 https://pi.example.com。");
	}
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
		throw new Error("服务器地址不能包含账号、口令、查询参数或会话链接。");
	}
	if (url.protocol === "http:" && !localHttpHost(url.hostname)) {
		throw new Error("公网连接请使用 HTTPS；局域网地址可以使用 HTTP。");
	}
	return url.href.replace(/\/+$/, "");
}

export function serverEndpoint(connection: MobileConnection, path: string): string {
	if (
		(!path.startsWith("/api/mobile-push/") && !path.startsWith("/api/mobile-hub/")) ||
		path.includes("..") ||
		path.includes("\\")
	) {
		throw new Error("Invalid mobile endpoint");
	}
	return `${connection.serverUrl}${path}`;
}

export async function mobileRequest<T>(
	connection: MobileConnection,
	path: string,
	init: RequestInit = {},
	fetcher: typeof fetch = fetch,
): Promise<T> {
	const headers = new Headers(init.headers);
	if (connection.token) headers.set("Authorization", `Bearer ${connection.token}`);
	if (init.body) headers.set("Content-Type", "application/json");
	const timeout = AbortSignal.timeout(12_000);
	const response = await fetcher(serverEndpoint(connection, path), {
		...init,
		headers,
		credentials: "omit",
		redirect: "error",
		signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
	});
	if (response.status === 401)
		throw new Error(
			path.startsWith("/api/mobile-hub/")
				? "账号密码不正确或登录已过期，请重新登录设备中心。"
				: "访问凭据无效或已过期，请检查令牌或重新登录。",
		);
	if (response.status === 404) throw new Error("当前服务尚未支持此手机版功能，请先更新 pi-web-ui。");
	if (!response.ok) {
		let message = "";
		try {
			const body = (await response.json()) as { error?: unknown };
			if (typeof body.error === "string") message = body.error.slice(0, 240);
		} catch {}
		throw new Error(message || `服务器暂时不可用（${response.status}）。`);
	}
	if (response.status === 204) return undefined as T;
	return (await response.json()) as T;
}

export async function readServerStatus(connection: MobileConnection, deviceId: string): Promise<ServerPushStatus> {
	const status = await mobileRequest<ServerPushStatus>(
		connection,
		`/api/mobile-push/status?deviceId=${encodeURIComponent(deviceId)}`,
	);
	if (
		!status ||
		typeof status.instanceId !== "string" ||
		!status.instanceId ||
		typeof status.configured !== "boolean"
	) {
		throw new Error("服务端通知协议不兼容，请更新 pi-web-ui。");
	}
	return status;
}

export interface NotificationTarget {
	eventId: string;
	instanceId: string;
	sessionId: string;
	clientId?: string;
	conversationId?: string;
	deviceId?: string;
}

/** Treat pushes as routing data, never as arbitrary URLs or executable content. */
export function notificationTarget(extras: unknown, instanceId: string): NotificationTarget | null {
	if (!extras || typeof extras !== "object" || Array.isArray(extras)) return null;
	const data = extras as Record<string, unknown>;
	const validId = (value: unknown): value is string =>
		typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value);
	if (
		typeof data.eventId !== "string" ||
		!data.eventId ||
		data.eventId.length > 768 ||
		data.instanceId !== instanceId ||
		(data.deviceId !== undefined &&
			(typeof data.deviceId !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(data.deviceId))) ||
		!validId(data.sessionId)
	) {
		return null;
	}
	return {
		eventId: data.eventId,
		instanceId,
		sessionId: data.sessionId,
		...(validId(data.clientId) ? { clientId: data.clientId } : {}),
		...(validId(data.conversationId) ? { conversationId: data.conversationId } : {}),
		...(typeof data.deviceId === "string" && /^[a-z0-9][a-z0-9-]{0,62}$/.test(data.deviceId)
			? { deviceId: data.deviceId }
			: {}),
	};
}

export function notificationLocalUrl(currentHref: string, target: NotificationTarget): string {
	const url = new URL(currentHref);
	url.search = "";
	url.hash = `s=${encodeURIComponent(target.sessionId)}`;
	return url.href;
}
