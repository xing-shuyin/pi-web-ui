import express, { type NextFunction, type Request, type Response } from "express";
import {
	createNativeAccountAuth,
	nativeOrigin,
	SESSION_TTL,
	verifyPassword,
	type HubRateLimiter,
	type NativeOrigin,
} from "./hub-auth.js";
import { hashSecret, type DeviceHubStore } from "./store.js";
import type { MobilePushService } from "../mobile-push.js";
import type { MobileNotificationEvent } from "../mobile-notification-events.js";

export type NativeCapabilityRequest = {
	deviceId: string;
	accountId: string;
	nativeOrigin: NativeOrigin;
	isSessionActive: () => boolean;
};
interface HubMobileOptions {
	store: DeviceHubStore;
	publicUrl: string;
	loginLimit: HubRateLimiter;
	mobilePush: MobilePushService;
	isOnline: (deviceId: string) => boolean;
	createCapability: (request: NativeCapabilityRequest) => Promise<string | null>;
}
class MobileError extends Error {
	constructor(
		public status: number,
		message: string,
	) {
		super(message);
	}
}
function fail(status: number, message: string): never {
	throw new MobileError(status, message);
}
function text(value: unknown, max: number): string {
	if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > max) fail(400, "Invalid text");
	return value;
}

/** Own middleware boundary: native bearer never enters the cookie-authenticated Hub routes. */
export function createHubMobileApp(options: HubMobileOptions) {
	const app = express();
	app.disable("x-powered-by");
	const host = new URL(options.publicUrl).host;
	const auth = createNativeAccountAuth(options.store);
	const sessions = new WeakMap<Request, NonNullable<ReturnType<typeof auth.getSession>>>();
	app.use((req, res, next) => {
		if (!/^\/api\/(?:mobile-hub|mobile-push)(?:\/|$)/.test(req.path)) return next("router");
		if (req.headers.host !== host) return res.status(421).json({ error: "Host rejected" });
		if (!nativeOrigin(req.headers.origin)) return res.status(403).json({ error: "Origin rejected" });
		res.set({
			"access-control-allow-origin": req.headers.origin,
			"access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
			"access-control-allow-headers": "content-type, authorization",
			"cache-control": "no-store",
			vary: "Origin",
		});
		if (req.method === "OPTIONS") return res.sendStatus(204);
		if (req.method === "POST" && req.path === "/api/mobile-hub/login") return next();
		const session = auth.getSession(req);
		if (!session) return res.status(401).json({ error: "Native authentication required" });
		sessions.set(req, session);
		next();
	});
	app.use(express.json({ limit: "32kb", strict: true }));
	app.post("/api/mobile-hub/login", async (req, res) => {
		if (!options.loginLimit.allow(req.socket.remoteAddress ?? "unknown")) fail(429, "Too many attempts");
		const username = text(req.body?.username, 64).trim().toLowerCase();
		const password = text(req.body?.["pass" + "word"], 1024);
		const entry = options.store.snapshot().accounts.find((account) => account.username === username);
		if (
			!(await verifyPassword(password, entry?.passwordHash ?? `scrypt:${"0".repeat(32)}:${"0".repeat(128)}`)) ||
			!entry
		)
			fail(401, "Invalid credentials");
		const token = auth.createToken();
		await options.store.transact((draft) => {
			draft.sessions = draft.sessions.filter((session) => session.expiresAt > Date.now());
			if (draft.sessions.filter((session) => session.accountId === entry.id).length >= 100)
				fail(429, "Session capacity reached");
			draft.sessions.push({ accountId: entry.id, hash: hashSecret(token), expiresAt: Date.now() + SESSION_TTL });
		});
		res.json({ token, account: { id: entry.id, username: entry.username } });
	});
	app.get("/api/mobile-hub/devices", (req, res) => {
		const accountId = sessions.get(req)!.account.id;
		res.json({
			devices: options.store
				.snapshot()
				.devices.filter((device) => device.accountId === accountId)
				.map((device) => ({
					id: device.id,
					name: device.name,
					...(device.remark ? { remark: device.remark } : {}),
					online: options.isOnline(device.id),
				})),
		});
	});
	app.post("/api/mobile-hub/devices/:id/access", async (req, res) => {
		const session = sessions.get(req)!;
		const device = options.store.getDevice(String(req.params.id));
		if (!device || device.accountId !== session.account.id) fail(404, "Device not found");
		if (!options.isOnline(device.id)) fail(503, "Device offline");
		const base = await options.createCapability({
			deviceId: device.id,
			accountId: session.account.id,
			nativeOrigin: req.headers.origin as NativeOrigin,
			isSessionActive: () => auth.isActive(session.hash, session.account.id),
		});
		if (!base) fail(503, "Device access unavailable");
		res.json({ device: { id: device.id, name: device.name }, serverUrl: base.replace(/\/$/, ""), token: "" });
	});
	app.post("/api/mobile-hub/logout", async (req, res) => {
		const session = sessions.get(req)!;
		await options.store.transact((draft) => {
			draft.sessions = draft.sessions.filter((entry) => entry.hash !== session.hash);
		});
		res.json({ ok: true });
	});
	options.mobilePush.registerRoutes(app, {
		getScope: (req) => sessions.get(req)?.account.id ?? fail(401, "Native authentication required"),
	});
	app.use((_req, res) => res.status(404).json({ error: "Mobile route missing" }));
	app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
		const status = error instanceof MobileError ? error.status : ((error as { status?: number })?.status ?? 500);
		res
			.status(status)
			.json({ error: status < 500 && error instanceof Error ? error.message : "Mobile request failed" });
	});
	return app;
}

/** Device identity and account scope are supplied exclusively by authenticated Hub middleware. */
export async function acceptMobileNotification(
	body: unknown,
	device: { id: string; name: string; accountId: string },
	mobilePush: MobilePushService,
) {
	if (!body || typeof body !== "object" || Array.isArray(body)) fail(400, "Invalid notification event");
	const event = body as Record<string, unknown>;
	const allowed = new Set(["eventId", "kind", "clientId", "sessionId", "conversationId", "occurredAt"]);
	if (Object.keys(event).some((key) => !allowed.has(key))) fail(400, "Unknown notification field");
	const identifier = (value: unknown): value is string =>
		typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
	if (
		!identifier(event.eventId) ||
		!identifier(event.clientId) ||
		!identifier(event.sessionId) ||
		(event.conversationId !== undefined && !identifier(event.conversationId)) ||
		!["done", "error", "question", "approval", "subagentDone"].includes(event.kind as string) ||
		typeof event.occurredAt !== "number" ||
		!Number.isFinite(event.occurredAt) ||
		event.occurredAt < 0
	)
		fail(400, "Invalid notification event");
	await mobilePush.handleEvent(
		{
			eventId: event.eventId,
			kind: event.kind as MobileNotificationEvent["kind"],
			clientId: event.clientId,
			sessionId: event.sessionId,
			...(event.conversationId !== undefined ? { conversationId: event.conversationId as string } : {}),
			occurredAt: event.occurredAt,
			deviceId: device.id,
			deviceName: device.name,
		},
		device.accountId,
	);
}
