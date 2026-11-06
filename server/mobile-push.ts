import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Express, Request, Response } from "express";
import type { MobileNotificationEvent } from "./mobile-notification-events.js";

const KINDS = ["done", "error", "question", "approval", "subagentDone"] as const;
const DAY = 86_400_000;
const DEVICE_TTL = 30 * DAY;
const EVENT_TTL = DAY;
const MAX_DEVICES = 1_000;
const MAX_OUTBOX = 2_000;
const MAX_SEEN = 4_096;
const MAX_ATTEMPTS = 5;
const REQUEST_TIMEOUT = 10_000;
const ANDROID_CHANNELS = { attention: "pi_attention", task: "pi_tasks" } as const;
const HOUR = 3_600_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REGISTRATION_ID = /^[a-zA-Z0-9_-]{8,256}$/;
type Kind = MobileNotificationEvent["kind"];
type Device = {
	scopeId: string;
	deviceId: string;
	registrationId: string;
	platform: "android" | "ios";
	enabled: boolean;
	kinds: Kind[];
	preview: "generic";
	watchClientIds?: string[];
	updatedAt: number;
	revision: string;
};
type Pending = {
	scopeId: string;
	id: string;
	deviceId: string;
	event: MobileNotificationEvent;
	test: boolean;
	attempts: number;
	nextAttemptAt: number;
	expiresAt: number;
};
type State = {
	version: 1;
	instanceId: string;
	devices: Device[];
	seen: { scopeId: string; eventId: string; sourceDeviceId?: string; expiresAt: number }[];
	outbox: Pending[];
};
export type MobilePushDevice = Omit<Device, "registrationId" | "revision" | "scopeId">;
export interface MobilePushRouteOptions {
	/** Account identity from authenticated middleware; never from request body/query. */
	getScope?: (req: Request) => string;
}
export interface MobilePushStatus {
	configured: boolean;
	enabled: boolean;
	instanceId: string;
	channel: {
		provider: "jpush";
		android: { configured: boolean; channelIds: typeof ANDROID_CHANNELS };
		ios: { configured: boolean; apnsProduction: boolean | null };
	};
	device?: MobilePushDevice | null;
}
export interface MobilePushOptions {
	dataDir: string;
	env?: NodeJS.ProcessEnv;
	fetch?: typeof globalThis.fetch;
	now?: () => number;
}
export interface MobilePushService {
	handleEvent(event: MobileNotificationEvent, scopeId?: string): Promise<void>;
	/** Mount only after the existing token authentication middleware. */
	registerRoutes(app: Express, options?: MobilePushRouteOptions): void;
	dispose(): Promise<void>;
}
class PushError extends Error {
	constructor(
		public status: number,
		message: string,
	) {
		super(message);
	}
}
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new PushError(400, "Invalid request");
	return value as Record<string, unknown>;
}
function identifier(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
}
function scopeValue(value: unknown): string {
	if (!identifier(value) || value.trim().length === 0) throw new PushError(401, "Mobile push account required");
	return value;
}
function eventValue(value: unknown): MobileNotificationEvent {
	const e = object(value);
	if (
		!identifier(e.eventId) ||
		!KINDS.includes(e.kind as Kind) ||
		!identifier(e.clientId) ||
		!identifier(e.sessionId) ||
		(e.conversationId !== undefined && !identifier(e.conversationId)) ||
		(e.deviceId !== undefined && !identifier(e.deviceId)) ||
		(e.deviceName !== undefined && !identifier(e.deviceName)) ||
		typeof e.occurredAt !== "number" ||
		!Number.isFinite(e.occurredAt) ||
		e.occurredAt < 0
	)
		throw new PushError(400, "Invalid notification event");
	return {
		eventId: e.eventId,
		kind: e.kind as Kind,
		clientId: e.clientId,
		sessionId: e.sessionId,
		...(e.conversationId !== undefined ? { conversationId: e.conversationId as string } : {}),
		...(e.deviceId !== undefined ? { deviceId: e.deviceId as string } : {}),
		...(e.deviceName !== undefined ? { deviceName: e.deviceName as string } : {}),
		occurredAt: e.occurredAt,
	};
}
function deviceValue(value: unknown, previous: Device | undefined, at: number, scopeId = "local"): Device {
	const b = object(value);
	const allowed = new Set(["deviceId", "registrationId", "platform", "enabled", "kinds", "preview", "watchClientIds"]);
	if (Object.keys(b).some((key) => !allowed.has(key))) throw new PushError(400, "Unknown device setting");
	const merged = { ...previous, ...b };
	if (typeof merged.deviceId !== "string" || !UUID.test(merged.deviceId)) throw new PushError(400, "Invalid deviceId");
	if (typeof merged.registrationId !== "string" || !REGISTRATION_ID.test(merged.registrationId))
		throw new PushError(400, "Invalid registrationId");
	if (merged.platform !== "android" && merged.platform !== "ios") throw new PushError(400, "Invalid platform");
	if (merged.enabled !== undefined && typeof merged.enabled !== "boolean") throw new PushError(400, "Invalid enabled");
	const kinds = merged.kinds === undefined ? [...KINDS] : merged.kinds;
	if (!Array.isArray(kinds) || kinds.length > KINDS.length || kinds.some((kind) => !KINDS.includes(kind as Kind)))
		throw new PushError(400, "Invalid kinds");
	if (merged.preview !== undefined && merged.preview !== "generic") throw new PushError(400, "Invalid preview");
	const watch = merged.watchClientIds === null ? undefined : merged.watchClientIds;
	if (watch !== undefined && (!Array.isArray(watch) || watch.length > 100 || !watch.every(identifier)))
		throw new PushError(400, "Invalid watchClientIds");
	return {
		scopeId,
		deviceId: merged.deviceId.toLowerCase(),
		registrationId: merged.registrationId,
		platform: merged.platform,
		enabled: merged.enabled ?? true,
		kinds: [...new Set(kinds)] as Kind[],
		preview: "generic",
		...(watch !== undefined ? { watchClientIds: [...new Set(watch)] as string[] } : {}),
		updatedAt: at,
		revision: previous?.revision ?? randomUUID(),
	};
}
function publicDevice(device: Device): MobilePushDevice {
	const { registrationId: _token, revision: _revision, scopeId: _scope, ...visible } = device;
	return visible;
}
function restore(value: unknown): State {
	const raw = object(value);
	if (
		raw.version !== 1 ||
		typeof raw.instanceId !== "string" ||
		!UUID.test(raw.instanceId) ||
		!Array.isArray(raw.devices) ||
		raw.devices.length > MAX_DEVICES ||
		!Array.isArray(raw.seen) ||
		raw.seen.length > MAX_SEEN ||
		!Array.isArray(raw.outbox) ||
		raw.outbox.length > MAX_OUTBOX
	)
		throw new Error("Invalid push state");
	const number = (v: unknown): number => {
		if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error("Invalid push state");
		return v;
	};
	const devices = raw.devices.map((v) => {
		const d = object(v);
		const { updatedAt, revision, scopeId, ...settings } = d;
		if (typeof revision !== "string" || !UUID.test(revision)) throw new Error("Invalid push state");
		return {
			...deviceValue(settings, undefined, number(updatedAt), scopeValue(scopeId === undefined ? "local" : scopeId)),
			revision,
		};
	});
	if (
		new Set(devices.map((d) => d.deviceId)).size !== devices.length ||
		new Set(devices.map((d) => d.registrationId)).size !== devices.length
	)
		throw new Error("Invalid push state");
	return {
		version: 1,
		instanceId: raw.instanceId,
		devices,
		seen: raw.seen.map((v) => {
			const s = object(v);
			if (!identifier(s.eventId)) throw new Error("Invalid push state");
			if (s.sourceDeviceId !== undefined && !identifier(s.sourceDeviceId)) throw new Error("Invalid push state");
			return {
				scopeId: scopeValue(s.scopeId === undefined ? "local" : s.scopeId),
				eventId: s.eventId,
				...(s.sourceDeviceId !== undefined ? { sourceDeviceId: s.sourceDeviceId as string } : {}),
				expiresAt: number(s.expiresAt),
			};
		}),
		outbox: raw.outbox.map((v) => {
			const p = object(v);
			if (
				typeof p.id !== "string" ||
				!UUID.test(p.id) ||
				typeof p.deviceId !== "string" ||
				!UUID.test(p.deviceId) ||
				typeof p.test !== "boolean" ||
				!Number.isInteger(p.attempts) ||
				Number(p.attempts) < 0 ||
				Number(p.attempts) > MAX_ATTEMPTS
			)
				throw new Error("Invalid push state");
			return {
				scopeId: scopeValue(p.scopeId === undefined ? "local" : p.scopeId),
				id: p.id,
				deviceId: p.deviceId,
				event: eventValue(p.event),
				test: p.test,
				attempts: Number(p.attempts),
				nextAttemptAt: number(p.nextAttemptAt),
				expiresAt: number(p.expiresAt),
			};
		}),
	};
}

/** JPush acceptance is not a device delivery receipt. No credentials are persisted or returned. */
export function createMobilePushService(options: MobilePushOptions): MobilePushService {
	const env = options.env ?? process.env;
	const key = env.PI_WEB_JPUSH_APP_KEY?.trim();
	const secret = env.PI_WEB_JPUSH_MASTER_SECRET?.trim();
	const configured = Boolean(key && secret);
	const apns = env.PI_WEB_JPUSH_APNS_PRODUCTION;
	const apnsProduction = apns === "true" ? true : apns === "false" ? false : null;
	const authorization = configured ? `Basic ${Buffer.from(`${key}:${secret}`).toString("base64")}` : "";
	const fetchPush = options.fetch ?? globalThis.fetch;
	const now = options.now ?? Date.now;
	const file = join(options.dataDir, "mobile-push.json");
	let state: State = { version: 1, instanceId: randomUUID(), devices: [], seen: [], outbox: [] };
	let persisted = false;
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let controller: AbortController | undefined;
	let worker: Promise<void> | undefined;
	let tail: Promise<unknown> = Promise.resolve();
	const ready = readFile(file, "utf8")
		.then((text) => {
			const parsed = JSON.parse(text);
			state = restore(parsed);
			persisted = JSON.stringify(parsed) === JSON.stringify(state);
		})
		.catch((error) => {
			if (error?.code !== "ENOENT") throw new Error("Mobile push storage unavailable");
		});
	void ready.catch(() => {});
	function channelReady(device: Device) {
		return configured && (device.platform === "android" || apnsProduction !== null);
	}
	function matches(device: Device, event: MobileNotificationEvent, test = false) {
		return (
			device.enabled &&
			channelReady(device) &&
			(test ||
				(device.kinds.includes(event.kind) &&
					(device.watchClientIds === undefined || device.watchClientIds.includes(event.clientId))))
		);
	}
	function prune(draft: State) {
		const at = now();
		draft.devices = draft.devices.filter((d) => d.updatedAt + DEVICE_TTL > at);
		draft.seen = draft.seen.filter((s) => s.expiresAt > at).slice(-MAX_SEEN);
		draft.outbox = draft.outbox.filter(
			(p) =>
				p.expiresAt > at &&
				(p.attempts < MAX_ATTEMPTS || p.nextAttemptAt > at) &&
				draft.devices.some((d) => d.deviceId === p.deviceId && d.scopeId === p.scopeId && matches(d, p.event, p.test)),
		);
	}
	async function save(draft: State) {
		await mkdir(options.dataDir, { recursive: true });
		const temporary = `${file}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporary, JSON.stringify(draft), { mode: 0o600, flag: "wx" });
			await rename(temporary, file);
		} finally {
			await rm(temporary, { force: true }).catch(() => {});
		}
	}
	function transaction<T>(action: (draft: State) => T): Promise<T> {
		const result = tail.then(async () => {
			await ready;
			const draft = structuredClone(state);
			prune(draft);
			const value = action(draft);
			if (!persisted || JSON.stringify(draft) !== JSON.stringify(state)) await save(draft);
			state = draft;
			persisted = true;
			return value;
		});
		tail = result.catch(() => {});
		return result;
	}
	function checkRunning() {
		if (stopped) throw new PushError(503, "Mobile push service stopped");
	}
	function schedule(delay = 0) {
		if (stopped) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = undefined;
			if (worker || stopped) return;
			worker = runWorker()
				.catch(() => {
					// Storage/network details can contain tokens. Retry without logging raw errors.
				})
				.finally(() => {
					worker = undefined;
					if (!stopped) {
						const due = state.outbox.reduce((min, p) => Math.min(min, p.nextAttemptAt), now() + HOUR);
						schedule(Math.max(1_000, Math.min(HOUR, due - now())));
					}
				});
		}, delay);
		timer.unref?.();
	}
	function payload(pending: Pending, device: Device) {
		const attention = ["error", "question", "approval"].includes(pending.event.kind);
		const titles: Record<Kind, string> = {
			done: "任务已完成",
			error: "任务需要关注",
			question: "有问题等待回答",
			approval: "有操作等待审批",
			subagentDone: "子任务已完成",
		};
		const deviceName = pending.event.deviceName?.trim();
		const prefix = deviceName ? `${Array.from(deviceName).slice(0, 24).join("")} · ` : "";
		const title = prefix + (pending.test ? "推送测试" : titles[pending.event.kind]);
		const alert = pending.test ? "手机系统通知已配置，请返回应用查看。" : "请打开应用查看最新状态。";
		const { occurredAt: _at, deviceName: _name, ...identifiers } = pending.event;
		const extras = { ...identifiers, instanceId: state.instanceId };
		return {
			platform: [device.platform],
			audience: { registration_id: [device.registrationId] },
			notification:
				device.platform === "android"
					? {
							android: {
								title,
								alert,
								extras,
								priority: 2,
								channel_id: attention ? ANDROID_CHANNELS.attention : ANDROID_CHANNELS.task,
							},
						}
					: { ios: { alert: { title, body: alert }, sound: "default", extras } },
			options: {
				time_to_live: Math.max(0, Math.min(86_400, Math.floor((pending.expiresAt - now()) / 1000))),
				...(device.platform === "ios" ? { apns_production: apnsProduction } : {}),
			},
		};
	}
	async function runWorker() {
		while (!stopped) {
			// Reserve an attempt durably before sending; crashes cannot cause unlimited retries.
			const job = await transaction((draft) => {
				const pending = draft.outbox.find((p) => p.nextAttemptAt <= now());
				if (!pending || !configured || stopped) return undefined;
				const device = draft.devices.find((d) => d.deviceId === pending.deviceId && d.scopeId === pending.scopeId)!;
				pending.attempts++;
				pending.nextAttemptAt = now() + REQUEST_TIMEOUT + Math.min(60_000, 1000 * 2 ** (pending.attempts - 1));
				return { pending: structuredClone(pending), device: structuredClone(device) };
			});
			if (!job || stopped) return;
			const requestController = new AbortController();
			controller = requestController;
			const timeout = setTimeout(() => requestController.abort(), REQUEST_TIMEOUT);
			let responseReceived = false;
			let retry = true;
			let retryAfter = 0;
			try {
				const response = await fetchPush("https://api.jpush.cn/v3/push", {
					method: "POST",
					redirect: "error",
					signal: requestController.signal,
					headers: { Authorization: authorization, "Content-Type": "application/json" },
					body: JSON.stringify(payload(job.pending, job.device)),
				});
				responseReceived = true;
				// Only retry rate limits and server failures. Never describe 2xx as delivered.
				retry = response.status === 429 || response.status >= 500;
				const header = response.headers.get("retry-after");
				if (header) {
					const seconds = Number(header);
					retryAfter = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now();
					if (!Number.isFinite(retryAfter)) retryAfter = 0;
				}
				await response.body?.cancel().catch(() => {});
			} catch {
				// Includes AbortError; the bounded outbox retries without persisting raw provider errors.
			} finally {
				clearTimeout(timeout);
				controller = undefined;
			}
			// Persist a known acceptance even if shutdown started while fetch was settling.
			if (stopped && !responseReceived) return;
			await transaction((draft) => {
				const pending = draft.outbox.find((p) => p.id === job.pending.id && p.scopeId === job.pending.scopeId);
				const device = draft.devices.find(
					(d) => d.deviceId === job.device.deviceId && d.scopeId === job.pending.scopeId,
				);
				// A token rotation during fetch has already reset the pending attempt for the new token.
				if (!pending || !device || device.revision !== job.device.revision) return;
				if (!retry || pending.attempts >= MAX_ATTEMPTS)
					draft.outbox = draft.outbox.filter((p) => p.id !== pending.id || p.scopeId !== pending.scopeId);
				else
					pending.nextAttemptAt =
						now() + Math.max(1000, Math.min(HOUR, retryAfter), Math.min(60_000, 1000 * 2 ** (pending.attempts - 1)));
			});
		}
	}
	function enqueue(draft: State, event: MobileNotificationEvent, devices: Device[], test: boolean, scopeId: string) {
		if (draft.outbox.length + devices.length > MAX_OUTBOX) throw new PushError(503, "Mobile push queue full");
		for (const device of devices)
			draft.outbox.push({
				scopeId,
				id: randomUUID(),
				deviceId: device.deviceId,
				event,
				test,
				attempts: 0,
				nextAttemptAt: now(),
				expiresAt: Math.min(now() + EVENT_TTL, event.occurredAt + EVENT_TTL),
			});
	}
	async function handleEvent(value: MobileNotificationEvent, requestedScope = "local") {
		checkRunning();
		const scopeId = scopeValue(requestedScope);
		if (!configured) return;
		const event = eventValue(value);
		if (event.occurredAt + EVENT_TTL <= now() || event.occurredAt > now() + 60_000) return;
		await transaction((draft) => {
			if (
				draft.seen.some(
					(s) => s.scopeId === scopeId && s.eventId === event.eventId && s.sourceDeviceId === event.deviceId,
				) ||
				draft.outbox.some(
					(p) => p.scopeId === scopeId && p.event.eventId === event.eventId && p.event.deviceId === event.deviceId,
				)
			)
				return;
			enqueue(
				draft,
				event,
				draft.devices.filter((d) => d.scopeId === scopeId && matches(d, event)),
				false,
				scopeId,
			);
			draft.seen.push({
				scopeId,
				eventId: event.eventId,
				...(event.deviceId !== undefined ? { sourceDeviceId: event.deviceId } : {}),
				expiresAt: now() + EVENT_TTL,
			});
			draft.seen = draft.seen.slice(-MAX_SEEN);
		});
		schedule();
	}
	function registerRoutes(app: Express, routeOptions: MobilePushRouteOptions = {}) {
		const route =
			(handler: (req: Request, res: Response, scopeId: string) => Promise<unknown>) =>
			(req: Request, res: Response) => {
				void Promise.resolve()
					.then(() => {
						checkRunning();
						return handler(req, res, scopeValue(routeOptions.getScope ? routeOptions.getScope(req) : "local"));
					})
					.catch((error) => {
						if (!res.headersSent)
							res.status(error instanceof PushError ? error.status : 503).json({
								error: error instanceof PushError ? error.message : "Mobile push storage unavailable",
							});
					});
			};
		app.get(
			"/api/mobile-push/status",
			route(async (req, res, scopeId) => {
				const deviceId = req.query?.deviceId;
				if (deviceId !== undefined && (typeof deviceId !== "string" || !UUID.test(deviceId)))
					throw new PushError(400, "Invalid deviceId");
				await transaction(() => {});
				const device =
					deviceId === undefined
						? undefined
						: state.devices.find((d) => d.deviceId === deviceId.toLowerCase() && d.scopeId === scopeId);
				const status: MobilePushStatus = {
					configured,
					enabled: state.devices.some((d) => d.scopeId === scopeId && d.enabled && channelReady(d)),
					instanceId: state.instanceId,
					...(deviceId !== undefined ? { device: device ? publicDevice(device) : null } : {}),
					channel: {
						provider: "jpush",
						android: { configured, channelIds: ANDROID_CHANNELS },
						ios: { configured: configured && apnsProduction !== null, apnsProduction },
					},
				};
				res.json(status);
			}),
		);
		app.post(
			"/api/mobile-push/devices",
			route(async (req, res, scopeId) => {
				const input = deviceValue(req.body, undefined, now());
				const device = await transaction((draft) => {
					const previous = draft.devices.find((d) => d.deviceId === input.deviceId);
					if (previous && previous.scopeId !== scopeId) throw new PushError(409, "Device already registered");
					const next = deviceValue(req.body, previous, now(), scopeId);
					if (!previous && draft.devices.length >= MAX_DEVICES)
						throw new PushError(503, "Mobile push device limit reached");
					if (draft.devices.some((d) => d.deviceId !== next.deviceId && d.registrationId === next.registrationId))
						throw new PushError(409, "Registration already belongs to another device");
					if (previous && (previous.registrationId !== next.registrationId || previous.platform !== next.platform)) {
						next.revision = randomUUID();
						for (const pending of draft.outbox.filter((p) => p.deviceId === next.deviceId && p.scopeId === scopeId)) {
							pending.attempts = 0;
							pending.nextAttemptAt = now();
						}
					}
					draft.devices = draft.devices.filter((d) => d.deviceId !== next.deviceId);
					draft.devices.push(next);
					prune(draft);
					return publicDevice(next);
				});
				schedule();
				res.json({ device });
			}),
		);
		app.patch(
			"/api/mobile-push/devices/:deviceId",
			route(async (req, res, scopeId) => {
				const patch = object(req.body);
				if (Object.keys(patch).some((k) => !["enabled", "kinds", "preview", "watchClientIds"].includes(k)))
					throw new PushError(400, "Unknown device setting");
				const device = await transaction((draft) => {
					const previous = draft.devices.find(
						(d) => d.deviceId === String(req.params.deviceId).toLowerCase() && d.scopeId === scopeId,
					);
					if (!previous) throw new PushError(404, "Device not found");
					const next = deviceValue(patch, previous, now(), scopeId);
					draft.devices[draft.devices.indexOf(previous)] = next;
					prune(draft);
					return publicDevice(next);
				});
				schedule();
				res.json({ device });
			}),
		);
		app.delete(
			"/api/mobile-push/devices/:deviceId",
			route(async (req, res, scopeId) => {
				await transaction((draft) => {
					draft.devices = draft.devices.filter(
						(d) => d.deviceId !== String(req.params.deviceId).toLowerCase() || d.scopeId !== scopeId,
					);
					prune(draft);
				});
				res.json({ ok: true });
			}),
		);
		app.post(
			"/api/mobile-push/devices/:deviceId/test",
			route(async (req, res, scopeId) => {
				await transaction((draft) => {
					const device = draft.devices.find(
						(d) => d.deviceId === String(req.params.deviceId).toLowerCase() && d.scopeId === scopeId,
					);
					if (!device) throw new PushError(404, "Device not found");
					if (!device.enabled || !channelReady(device)) throw new PushError(409, "Device push channel unavailable");
					enqueue(
						draft,
						{
							eventId: randomUUID(),
							kind: "done",
							clientId: "mobile-push-test",
							sessionId: "mobile-push-test",
							occurredAt: now(),
						},
						[device],
						true,
						scopeId,
					);
				});
				schedule();
				res.status(202).json({ queued: true });
			}),
		);
	}
	async function dispose() {
		stopped = true;
		if (timer) clearTimeout(timer);
		controller?.abort();
		await worker;
		await tail;
		await ready.catch(() => {});
	}
	void ready.then(
		() => schedule(),
		() => {},
	);
	return { handleEvent, registerRoutes, dispose };
}
