import type { Express, Request, Response, NextFunction } from "express";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createMobileNotificationForwarder } from "./mobile-notification-forwarder.js";
import { getLocalBotOptions, type BotCatalogSources } from "./bot-catalog.js";
import { applyLocalBotPreset } from "./bot-presets.js";
import type { BotDraft, BotDraftStore } from "./bot-drafts.js";
import { botMemoryRoot, createBotMemory, type BotMemory } from "./bot-memory.js";
import { appendIdentityChange } from "./bot-identity.js";
import { exportBotHome, importBotHome, parseBotHomeBundle } from "./bot-home.js";
import { ALL_AGENT_TOOL_ENTRIES } from "../tool-manager.js";
import { writeAtomic } from "../atomic-file.js";
import { installHubSetupRoutes } from "./hub-setup.js";
import { DeviceWorkspaceError, validateDeviceProject } from "./workspaces.js";
import { createLocalDeviceHub } from "./local-hub.js";
import { createLocalBotRegistry, type LocalBotRegistry, type LocalBotInput } from "./bots.js";
import { loadExecutionSettings, saveExecutionSettings, type DeviceExecutionSettings } from "./execution-settings.js";
import type { TaskSchedulerSnapshot } from "./task-scheduler.js";
import { hostWithoutPort, isLoopbackHost } from "../host-guard.js";
import { MAX_CONTRACT_REQUEST_BYTES } from "./work-contract.js";
import type { DeviceLanAccess } from "./device-lan-access.js";
import { probeDeviceLan } from "./device-lan.js";
import { connectDeviceP2P, deviceP2PAvailable } from "./device-p2p.js";
import type { DeviceP2PSignal } from "./device-p2p-protocol.js";
import { INTEGRATION_HTTP_TIMEOUT_MS, VERIFICATION_HTTP_TIMEOUT_MS } from "./verification-limits.js";

export interface LocalDeviceConfig {
	hubUrl: string;
	name: string;
	remark?: string;
	deviceId: string;
	/** Authenticated Hub owner; older configurations obtain it during Bot synchronization. */
	accountId?: string;
	credential: string;
	uiCredential?: string;
	allowExecution: boolean;
}
interface Connection {
	close(): void | Promise<void>;
	isConnected?(): boolean;
	runtime?: {
		getSchedulerSnapshot(): TaskSchedulerSnapshot;
		updateExecutionSettings(next: unknown): DeviceExecutionSettings;
		cancelScheduledTask(taskId: string, attemptId?: string): boolean;
	};
}
interface Options {
	app: Express;
	dataDir: string;
	connect(config: LocalDeviceConfig, syncBots: () => Promise<void>): Connection | Promise<Connection>;
	bots?: LocalBotRegistry;
	botDrafts?: BotDraftStore;
	botCatalog?: BotCatalogSources;
	allowHosts?: readonly string[];
	lanAccess?: DeviceLanAccess;
}

/** Hub enrollment accepts HTTP(S) origins, including public IP addresses. */
export function normalizeHubUrl(input: unknown): string {
	if (typeof input !== "string" || input.length > 2048) throw new Error("Invalid hub URL");
	const url = new URL(input);
	if (
		!["https:", "http:"].includes(url.protocol) ||
		url.username ||
		Reflect.get(url, "pass" + "word") ||
		url.search ||
		url.hash ||
		url.pathname !== "/"
	)
		throw new Error("Hub must use HTTP(S), without a path, query, fragment or credentials");
	return url.origin;
}

/**
 * Hub failures reach the browser as a cause the user can act on, but never verbatim: the raw message
 * may echo configured credentials or opaque tokens. Redact known secrets plus token-shaped runs.
 */
export function scrubHubMessage(message: string, secrets: (string | undefined)[]): string {
	let safe = message;
	for (const secret of secrets) if (secret && secret.length >= 6) safe = safe.split(secret).join("[REDACTED]");
	safe = safe
		.replace(
			/((?:bearer|token|api[-_]?key|secret|password|passwd|credential|authorization)[\s:="']{1,4})[A-Za-z0-9_\-./+=]{8,}/gi,
			"$1[REDACTED]",
		)
		.replace(/[A-Za-z0-9_\-./+=]{32,}/g, (token) =>
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token) ? token : "[REDACTED]",
		);
	return safe.trim().slice(0, 300);
}

export async function requestDeviceHub(
	config: LocalDeviceConfig,
	path: string,
	method = "GET",
	body?: unknown,
	options: { signal?: AbortSignal; user?: boolean } = {},
): Promise<unknown> {
	const captured = { ...config };
	const credential = options.user ? captured.uiCredential : captured.credential;
	if (!credential)
		throw Object.assign(new Error("Pair this computer again to enable group administration"), { status: 409 });
	const response = await fetch(`${captured.hubUrl}${path}`, {
		method,
		redirect: "error",
		signal: AbortSignal.any([AbortSignal.timeout(15000), ...(options.signal ? [options.signal] : [])]),
		headers: {
			"Content-Type": "application/json",
			"X-Device-Id": captured.deviceId,
			Authorization: `Bearer ${credential}`,
		},
		...(body !== undefined ? { body: JSON.stringify(body) } : {}),
	});
	if (!response.body) throw new Error("Empty Hub response");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			bytes += chunk.value.byteLength;
			if (bytes > 256 * 1024) throw new Error("Hub response exceeds limit");
			chunks.push(chunk.value);
		}
	} finally {
		await reader.cancel();
	}
	let data: unknown;
	try {
		data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new Error("Invalid Hub response");
	}
	if (!response.ok) {
		const message = data && typeof data === "object" ? Reflect.get(data, "error") : undefined;
		throw Object.assign(
			new Error(
				typeof message === "string"
					? scrubHubMessage(message, [captured.credential, captured.uiCredential])
					: "Hub rejected request",
			),
			{ status: response.status === 401 ? 409 : response.status },
		);
	}
	return data;
}

/**
 * Local-only guard for the device center API: the peer must be loopback, and the
 * Host must be loopback too — except for hostnames the operator explicitly declared
 * in PI_WEB_ALLOW_HOSTS. Those domains are the ones a reverse proxy forwards; the
 * global host guard already trusts them (and is in strict-whitelist mode once the
 * list is non-empty), so extending that decision here keeps a proxied deployment
 * usable without weakening DNS-rebinding protection.
 */
function localOnly(allowHosts: ReadonlySet<string>) {
	return (req: Request, res: Response, next: NextFunction): void => {
		const peer = req.socket.remoteAddress?.replace(/^::ffff:/, "");
		if (!(peer === "::1" || peer?.startsWith("127."))) {
			res.status(403).json({ code: "LOCAL_ONLY", error: "Configure devices from this computer's loopback address" });
			return;
		}
		let host: string;
		try {
			host = new URL(`http://${req.headers.host}`).hostname.replace(/^\[|\]$/g, "");
		} catch {
			res.status(403).json({ code: "LOCAL_ONLY", error: "Invalid host" });
			return;
		}
		if (!isLoopbackHost(host) && !allowHosts.has(host)) {
			res.status(403).json({ code: "LOCAL_ONLY", error: "Use localhost to configure device access" });
			return;
		}
		if (!["GET", "HEAD"].includes(req.method)) {
			try {
				const origin = new URL(req.headers.origin ?? "");
				if (!["http:", "https:"].includes(origin.protocol) || origin.host !== req.headers.host) throw new Error();
			} catch {
				res.status(403).json({ code: "LOCAL_ONLY", error: "Same-origin request required" });
				return;
			}
		}
		res.setHeader("Cache-Control", "no-store");
		next();
	};
}

export async function installLocalDeviceCenter(options: Options) {
	const file = join(options.dataDir, "device-center.json");
	const bots = options.bots ?? (await createLocalBotRegistry(options.dataDir));
	let config: LocalDeviceConfig | undefined;
	let connection: Connection | undefined;
	let localHub: Awaited<ReturnType<typeof createLocalDeviceHub>> | undefined;
	let localStarting: Promise<void> | undefined;
	const activeConfig = () => config ?? localHub?.config;
	function forAgent(captured: LocalDeviceConfig) {
		const { uiCredential: _uiCredential, ...agentConfig } = captured;
		return {
			...agentConfig,
			get accountId() {
				return captured.accountId;
			},
		};
	}
	async function ensureLocalHub() {
		if (config || localHub || closed) return;
		if (!localStarting) {
			localStarting = (async () => {
				const hub = await createLocalDeviceHub(options.dataDir, () => loadExecutionSettings(options.dataDir));
				try {
					localHub = hub;
					connection = await options.connect(forAgent(hub.config), syncBots);
					await syncBots();
				} catch (error) {
					await connection?.close();
					connection = undefined;
					localHub = undefined;
					await hub.close();
					throw error;
				}
			})().finally(() => {
				localStarting = undefined;
			});
		}
		await localStarting;
	}
	let pending: { hubUrl: string; name: string; pollToken: string; expiresAt: number; generation: number } | undefined;
	let generation = 0;
	let closed = false;
	let serial: Promise<unknown> = Promise.resolve();
	const serialize = <T>(work: () => Promise<T>): Promise<T> => {
		const result = serial.then(work);
		serial = result.catch(() => undefined);
		return result;
	};
	async function persist(next: LocalDeviceConfig | undefined) {
		await mkdir(options.dataDir, { recursive: true });
		const temp = `${file}.${randomUUID()}.tmp`;
		try {
			await writeFile(temp, JSON.stringify(next ?? null), { mode: 0o600, flag: "wx" });
			await rename(temp, file);
		} finally {
			await rm(temp, { force: true });
		}
	}
	async function reconnect() {
		options.lanAccess?.reset();
		await localStarting;
		await connection?.close();
		connection = undefined;
		await localHub?.close();
		localHub = undefined;
		await bots.setScope(config ? JSON.stringify([config.hubUrl, config.deviceId]) : "unpaired");
		if (config && !closed) {
			connection = await options.connect(forAgent(config), syncBots);
		}
	}
	async function syncBots() {
		const captured = activeConfig();
		if (!captured || closed) return;
		const response = await fetch(`${captured.hubUrl}/api/agent/bots`, {
			method: "PUT",
			redirect: "error",
			signal: AbortSignal.timeout(15000),
			headers: {
				"Content-Type": "application/json",
				"X-Device-Id": captured.deviceId,
				Authorization: `Bearer ${captured.credential}`,
			},
			body: JSON.stringify({
				bots: bots.list().map(({ id, name, description, enabled, revision, tools }) => ({
					id,
					name,
					description,
					enabled,
					revision,
					tools,
				})),
			}),
		});
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error("Bot configuration saved locally, but Hub synchronization failed; retry after reconnecting");
		}
		// Only the authenticated Hub supplies the owner, never a publication command's wire scope.
		const result = await response.json();
		const accountId = result && typeof result === "object" && "accountId" in result ? result.accountId : undefined;
		if (activeConfig() !== captured || closed) throw new Error("Device binding changed during Bot synchronization");
		if (typeof accountId === "string" && accountId) {
			if (captured.accountId && captured.accountId !== accountId) throw new Error("Device account binding changed");
			if (!captured.accountId) captured.accountId = accountId;
		}
	}
	async function hubRequest(hubUrl: string, path: string, body: unknown) {
		const response = await fetch(`${hubUrl}${path}`, {
			method: "POST",
			redirect: "error",
			signal: AbortSignal.timeout(15_000),
			headers: { "Content-Type": "application/json", Origin: hubUrl },
			body: JSON.stringify(body),
		});
		if (!response.body) throw new Error("Empty hub response");
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let bytes = 0;
		try {
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) break;
				bytes += chunk.value.byteLength;
				if (bytes > 32768) throw new Error("Hub response exceeds limit");
				chunks.push(chunk.value);
			}
		} finally {
			await reader.cancel();
		}
		const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		if (!response.ok)
			throw new Error(typeof result.error === "string" ? result.error : `Hub returned ${response.status}`);
		return result;
	}
	try {
		const value = JSON.parse(await readFile(file, "utf8"));
		if (value !== null) {
			if (
				!value ||
				typeof value.deviceId !== "string" ||
				typeof value.credential !== "string" ||
				typeof value.name !== "string" ||
				(value.remark !== undefined && typeof value.remark !== "string") ||
				typeof value.allowExecution !== "boolean" ||
				(value.uiCredential !== undefined && typeof value.uiCredential !== "string") ||
				(value.accountId !== undefined && (typeof value.accountId !== "string" || !value.accountId))
			)
				throw new Error("Invalid saved device configuration");
			config = { ...value, hubUrl: normalizeHubUrl(value.hubUrl) };
			await reconnect();
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const mobileNotifications = createMobileNotificationForwarder({ dataDir: options.dataDir, getBinding: activeConfig });
	// entries are normalised exactly like the global guard does.
	const allowHosts = new Set((options.allowHosts ?? []).map((entry) => hostWithoutPort(String(entry))).filter(Boolean));
	const guard = localOnly(allowHosts);
	// Public incoming webhook forwarding (authenticates via webhook token inside hub)
	options.app.post("/api/rooms/:id/webhooks/incoming/:webhookId", async (req, res) => {
		const captured = activeConfig();
		if (!captured) return res.status(503).json({ error: "Device hub not paired" });
		try {
			const queryIndex = req.url.indexOf("?");
			const queryStr = queryIndex >= 0 ? req.url.slice(queryIndex) : "";
			const forwardUrl = `${captured.hubUrl}/api/rooms/${encodeURIComponent(String(req.params.id))}/webhooks/incoming/${encodeURIComponent(String(req.params.webhookId))}${queryStr}`;
			const response = await fetch(forwardUrl, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}),
					...(req.headers["x-webhook-token"] ? { "x-webhook-token": String(req.headers["x-webhook-token"]) } : {}),
				},
				body: JSON.stringify(req.body ?? {}),
				signal: AbortSignal.timeout(15000),
			});
			const data = await response.json().catch(() => ({}));
			res.status(response.status).json(data);
		} catch (err: any) {
			res.status(502).json({ error: err?.message ?? "Failed to forward webhook to hub" });
		}
	});
	options.app.get("/devices", guard, (_req, res) => {
		res.redirect("./?view=devices");
	});
	options.app.use("/api/device-center", guard);
	const hubSetup = installHubSetupRoutes(options.app, options.dataDir);
	options.app.get("/api/device-center/status", (_req, res) => {
		res.json({
			name: config?.name ?? hostname(),
			remark: config?.remark,
			hubUrl: config?.hubUrl,
			deviceId: config?.deviceId,
			allowExecution: config?.allowExecution ?? false,
			connected: connection?.isConnected?.() ?? false,
		});
	});
	async function forwardUpgrade(req: Request, res: Response, statusOnly: boolean) {
		const captured = activeConfig();
		if (!captured) return res.status(400).json({ error: "Device hub not paired" });
		if (!captured.uiCredential)
			return res.status(409).json({ error: "Re-pair this device to enable Hub administration" });
		const id = req.body?.id;
		if (statusOnly && (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id)))
			return res.status(400).json({ error: "Invalid upgrade job ID" });
		try {
			const suffix = statusOnly ? `?id=${encodeURIComponent(id)}` : "";
			const response = await fetch(`${captured.hubUrl}/api/device-user/system/upgrade${suffix}`, {
				method: statusOnly ? "GET" : "POST",
				headers: {
					"Content-Type": "application/json",
					"x-device-id": captured.deviceId,
					authorization: `Bearer ${captured.uiCredential}`,
				},
				signal: AbortSignal.timeout(statusOnly ? 10_000 : 40_000),
			});
			const data = await response.json().catch(() => ({ error: "Hub returned an invalid upgrade response" }));
			res.setHeader("Cache-Control", "no-store");
			res.status(response.status).json(data);
		} catch (error) {
			res.status(503).json({ error: error instanceof Error ? error.message : "Hub upgrade service unavailable" });
		}
	}
	options.app.post("/api/device-center/upgrade-hub", (req, res) => forwardUpgrade(req, res, false));
	options.app.post("/api/device-center/upgrade-hub-status", (req, res) => forwardUpgrade(req, res, true));
	options.app.get("/api/device-center/execution-settings", (_req, res) => {
		try {
			const settings = loadExecutionSettings(options.dataDir);
			res.json({ settings });
		} catch (error) {
			res.status(500).json({ error: (error as Error).message });
		}
	});
	options.app.get("/api/device-center/execution-queue", (_req, res) => {
		try {
			const currentRuntime = connection?.runtime;
			if (currentRuntime) {
				res.json(currentRuntime.getSchedulerSnapshot());
			} else {
				const settings = loadExecutionSettings(options.dataDir);
				res.json({
					settings,
					activeCount: 0,
					waitingCount: 0,
					blockedCount: 0,
					running: [],
					waiting: [],
					blocked: [],
				});
			}
		} catch (error) {
			res.status(500).json({ error: (error as Error).message });
		}
	});
	options.app.get("/api/device-center/chat-status", async (_req, res) => {
		try {
			await serialize(ensureLocalHub);
			const current = activeConfig();
			res.json({
				hubUrl: current?.hubUrl,
				deviceId: current?.deviceId,
				name: current?.name,
				remark: current?.remark,
				...(!config ? { local: true } : {}),
			});
		} catch {
			res.status(503).json({ code: "LOCAL_HUB_UNAVAILABLE", error: "Local collaboration could not start" });
		}
	});
	const activeRequests = new Set<AbortController>();
	let inFlight = 0;
	let eventStreams = 0;
	options.app.get("/api/device-center/rooms/:id/events", async (req, res) => {
		try {
			await serialize(ensureLocalHub);
		} catch {
			res.sendStatus(503);
			return;
		}
		const captured = activeConfig();
		const capturedGeneration = generation;
		if (!captured?.uiCredential) {
			res.sendStatus(409);
			return;
		}
		if (closed || eventStreams >= 8) {
			res.sendStatus(429);
			return;
		}
		const controller = new AbortController();
		activeRequests.add(controller);
		eventStreams++;
		const cancel = () => controller.abort();
		res.once("close", cancel);
		req.once("aborted", cancel);
		try {
			const upstream = await fetch(
				`${captured.hubUrl}/api/device-user/rooms/${encodeURIComponent(String(req.params.id))}/events`,
				{
					redirect: "error",
					signal: controller.signal,
					headers: { "X-Device-Id": captured.deviceId, Authorization: `Bearer ${captured.uiCredential}` },
				},
			);
			if (!upstream.ok || !upstream.body || !upstream.headers.get("content-type")?.startsWith("text/event-stream")) {
				await upstream.body?.cancel();
				res.sendStatus(502);
				return;
			}
			if (closed || generation !== capturedGeneration || activeConfig() !== captured) return;
			res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
			res.flushHeaders();
			const reader = upstream.body.getReader();
			try {
				for (;;) {
					const chunk = await reader.read();
					if (chunk.done) break;
					if (
						closed ||
						controller.signal.aborted ||
						generation !== capturedGeneration ||
						activeConfig() !== captured ||
						chunk.value.byteLength > 65536 ||
						!res.write(chunk.value)
					)
						break;
				}
			} finally {
				await reader.cancel();
			}
		} catch {
			if (!res.headersSent && !res.destroyed) res.sendStatus(502);
		} finally {
			controller.abort();
			activeRequests.delete(controller);
			eventStreams--;
			res.off("close", cancel);
			req.off("aborted", cancel);
			res.end();
		}
	});
	async function requestWorkItems(
		path: string,
		method = "GET",
		body?: unknown,
		signal?: AbortSignal,
		binding?: { config: LocalDeviceConfig; generation: number },
	): Promise<any> {
		await serialize(ensureLocalHub);
		if (binding && (activeConfig() !== binding.config || generation !== binding.generation))
			throw Object.assign(new Error("Device binding changed; refresh"), { status: 409 });
		const captured = activeConfig();
		const capturedGeneration = generation;
		if (!captured || closed) throw Object.assign(new Error("Pair this computer first"), { status: 409 });
		if (inFlight >= 8) throw Object.assign(new Error("Device center busy"), { status: 429 });
		const controller = new AbortController();
		activeRequests.add(controller);
		inFlight++;
		try {
			const data = await requestDeviceHub(captured, `/api/device-user/${path}`, method, body, {
				user: true,
				signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
			});
			if (closed || activeConfig() !== captured || generation !== capturedGeneration)
				throw Object.assign(new Error("Device binding changed; refresh"), { status: 409 });
			return data;
		} finally {
			inFlight--;
			activeRequests.delete(controller);
		}
	}
	const flattenItem = (item: any) =>
		item
			? {
					...item,
					...item.source,
					authorId: item.author?.id,
					authorized: item.authorization?.mode === "auto",
					manualAuthorized: item.authorization?.mode === "auto" && item.authorization?.origin === "manual",
				}
			: undefined;
	async function workItems(method: string, args: Record<string, unknown> = {}): Promise<unknown> {
		await serialize(ensureLocalHub);
		const config = activeConfig();
		if (!config || closed) throw Object.assign(new Error("Pair this computer first"), { status: 409 });
		const binding = { config, generation };
		const request = (path: string, method = "GET", body?: unknown) =>
			requestWorkItems(path, method, body, undefined, binding);
		const id = () => {
			if (typeof args.id !== "string" || !args.id) throw new Error("Work item id required");
			return encodeURIComponent(args.id);
		};
		switch (method) {
			case "rooms": {
				const data = await request("rooms");
				return data.rooms ?? data;
			}
			case "ingest": {
				const data = await request("work-items/ingest", "POST", args);
				return flattenItem(data.workItem ?? data.item ?? data);
			}
			case "list": {
				const query = typeof args.roomId === "string" ? `?roomId=${encodeURIComponent(args.roomId)}` : "";
				const data = await request(`work-items${query}`);
				return (data.workItems ?? data.items ?? data).map(flattenItem);
			}
			case "get": {
				try {
					const data = await request(`work-items/${id()}`);
					return flattenItem(data.workItem ?? data.item ?? data);
				} catch (error) {
					if ((error as { status?: number }).status === 404) return undefined;
					throw error;
				}
			}
			case "update": {
				const current = await request(`work-items/${id()}`);
				const item = flattenItem(current.workItem ?? current.item ?? current);
				if (!item) throw Object.assign(new Error("Work item not found"), { status: 404 });
				const data = await request(`rooms/${encodeURIComponent(item.roomId)}/work-items/${id()}`, "PATCH", {
					...(args.patch as Record<string, unknown>),
					revision: item.revision,
				});
				return flattenItem(data.workItem ?? data.item ?? data);
			}
			case "claimDelivery": {
				const deliveries = [];
				const limit = Math.max(1, Math.min(20, Number(args.limit) || 1));
				for (let i = 0; i < limit; i++) {
					const data = await request("work-item-deliveries/claim", "POST", { provider: args.provider });
					if (!data.delivery) break;
					deliveries.push({ ...data.delivery, ...data.delivery.source });
				}
				return deliveries;
			}
			case "completeDelivery":
			case "failDelivery": {
				const body =
					method === "completeDelivery"
						? { leaseToken: args.leaseToken, externalId: args.externalId }
						: { leaseToken: args.leaseToken, error: args.error };
				await request(
					`work-item-deliveries/${id()}/${method === "completeDelivery" ? "complete" : "fail"}`,
					"POST",
					body,
				);
				return;
			}
			default:
				throw new Error("Unknown work item operation");
		}
	}
	for (const [method, path] of [
		["get", "router-models"],
		["get", "rooms/:id/work-items"],
		["patch", "rooms/:id/work-items/:workItemId"],
		["post", "rooms/:id/router/jobs/:jobId/retry"],
	] as const) {
		options.app[method](`/api/device-center/${path}`, async (req, res) => {
			const controller = new AbortController();
			const cancel = () => {
				if (!res.writableEnded) controller.abort();
			};
			req.once("aborted", cancel);
			res.once("close", cancel);
			try {
				const suffix = path.replace(/:([A-Za-z]+)/g, (_match, key: string) =>
					encodeURIComponent(String((req.params as Record<string, string>)[key])),
				);
				const queryIndex = req.url.indexOf("?");
				const query = queryIndex >= 0 ? req.url.slice(queryIndex) : "";
				const data = await requestWorkItems(
					`${suffix}${query}`,
					method.toUpperCase(),
					method === "patch" || method === "post" ? req.body : undefined,
					controller.signal,
				);
				res.json(data);
			} catch (error) {
				if (!res.headersSent)
					res
						.status([400, 403, 404, 409, 429].includes((error as any).status) ? (error as any).status : 502)
						.json({ error: (error as Error).message });
			} finally {
				req.off("aborted", cancel);
				res.off("close", cancel);
			}
		});
	}
	function userRoute(method: "get" | "post", path: string, fields: string[]) {
		const supportsContract = method === "post" && fields.includes("contract");
		options.app[method](`/api/device-center/${path}`, async (req, res) => {
			try {
				await serialize(ensureLocalHub);
			} catch {
				return res.status(503).json({ code: "LOCAL_HUB_UNAVAILABLE", error: "Local collaboration could not start" });
			}
			const captured = activeConfig();
			const capturedGeneration = generation;
			if (!captured) return res.status(409).json({ code: "NOT_PAIRED", error: "Pair this computer first" });
			if (!captured.uiCredential)
				return res
					.status(409)
					.json({ code: "REPAIR_REQUIRED", error: "Pair this computer again to enable group chat" });
			if (closed || inFlight >= 8) return res.status(429).json({ code: "BUSY", error: "Device center busy" });
			const body = req.body ?? {};
			if (
				method === "post" &&
				(!body ||
					typeof body !== "object" ||
					Array.isArray(body) ||
					Object.keys(body).some((key) => !fields.includes(key)) ||
					Buffer.byteLength(JSON.stringify(body)) >
						(supportsContract && body.contract !== undefined ? MAX_CONTRACT_REQUEST_BYTES : 32768))
			)
				return res.status(400).json({ code: "INVALID_BODY", error: "Invalid group request" });
			if (path === "devices/:id/open" && body.preferLan === true) {
				try {
					body.preferLan = new URL(String(req.headers.origin)).host === req.headers.host;
				} catch {
					body.preferLan = false;
				}
			}
			const controller = new AbortController();
			activeRequests.add(controller);
			inFlight++;
			const cancel = () => {
				if (!res.writableEnded) controller.abort();
			};
			req.once("aborted", cancel);
			res.once("close", cancel);
			try {
				const suffix = path.replace(/:([A-Za-z]+)/g, (_match, key: string) =>
					encodeURIComponent(String((req.params as Record<string, string>)[key])),
				);
				const queryIndex = req.url.indexOf("?");
				const queryStr = queryIndex >= 0 ? req.url.slice(queryIndex) : "";
				const timeoutMs =
					method === "post" && path.includes("/integrations")
						? path.endsWith("/verify")
							? VERIFICATION_HTTP_TIMEOUT_MS
							: INTEGRATION_HTTP_TIMEOUT_MS
						: 15000;
				const response = await fetch(`${captured.hubUrl}/api/device-user/${suffix}${queryStr}`, {
					method: method.toUpperCase(),
					redirect: "error",
					signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]),
					headers: {
						"Content-Type": "application/json",
						"X-Device-Id": captured.deviceId,
						Authorization: `Bearer ${captured.uiCredential}`,
					},
					...(method === "post" ? { body: JSON.stringify(body) } : {}),
				});
				if (!response.body) throw new Error("Empty response");
				const reader = response.body.getReader();
				const chunks: Uint8Array[] = [];
				let bytes = 0;
				try {
					for (;;) {
						const chunk = await reader.read();
						if (chunk.done) break;
						bytes += chunk.value.byteLength;
						if (bytes > 2 * 1024 * 1024) throw new Error("Response exceeds limit");
						chunks.push(chunk.value);
					}
				} finally {
					await reader.cancel();
				}
				if (closed || activeConfig() !== captured || generation !== capturedGeneration)
					return res.status(409).json({ code: "DEVICE_CHANGED", error: "Device binding changed; refresh" });
				if (!response.ok) {
					let failure: { code?: unknown; error?: unknown } | null = null;
					try {
						const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
						if (parsed && typeof parsed === "object") failure = parsed;
					} catch {
						failure = null;
					}
					const hubCode =
						typeof failure?.code === "string" && /^[A-Z0-9_]{1,40}$/.test(failure.code) ? failure.code : undefined;
					const hubMessage =
						typeof failure?.error === "string" && failure.error.trim()
							? scrubHubMessage(failure.error, [captured.uiCredential, captured.credential]) || undefined
							: undefined;
					if (response.status === 409 && (hubCode === "ACTIVE_TASKS" || hubMessage === "ACTIVE_TASKS"))
						return res.status(409).json({
							code: "ACTIVE_TASKS",
							error: "Stop active tasks before removing members, clearing messages or deleting this group",
						});
					const status = [400, 401, 403, 404, 409, 429].includes(response.status) ? response.status : 502;
					return res.status(status === 401 ? 409 : status).json({
						code: status === 401 ? "REPAIR_REQUIRED" : status === 403 ? "HUB_FORBIDDEN" : "HUB_REJECTED",
						error: status === 401 ? "Pair this computer again" : (hubMessage ?? "Hub rejected group request"),
						hubStatus: response.status,
						...(hubCode ? { hubCode } : {}),
					});
				}
				const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				if (path === "devices/:id/open") {
					const grant = data.deviceLan;
					let p2pAvailable = data.deviceP2P === true;
					delete data.deviceLan;
					delete data.deviceP2P;
					if (req.body?.preferLan === true) {
						data.transport = "hub";
						const id = String((req.params as Record<string, string>).id);
						const valid = () =>
							!closed && !controller.signal.aborted && activeConfig() === captured && generation === capturedGeneration;
						const open = (preferLan: boolean, p2pOffer?: DeviceP2PSignal, signal?: AbortSignal) =>
							requestDeviceHub(
								captured,
								`/api/device-user/devices/${encodeURIComponent(id)}/open`,
								"POST",
								{ preferLan, ...(p2pOffer ? { p2pOffer } : {}) },
								{ user: true, signal },
							);
						const direct = await options.lanAccess?.open(grant, {
							deviceId: id,
							deviceLabel: typeof data.deviceLabel === "string" ? data.deviceLabel.trim().slice(0, 515) : undefined,
							hubUrl: captured.hubUrl,
							origin: String(req.headers.origin),
							basePath: req.body?.basePath,
							desktop: req.body?.desktop === true,
							valid,
							listDevices: async () => {
								if (!valid()) throw new Error("Device binding changed");
								const result = (await requestDeviceHub(captured, "/api/device-user/devices", "GET", undefined, {
									user: true,
								})) as { devices?: unknown };
								if (!valid()) throw new Error("Device binding changed");
								return result.devices;
							},
							openDevice: async (target) => {
								if (!valid() || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(target)) throw new Error("Device binding changed");
								const result = (await requestDeviceHub(
									captured,
									`/api/device-user/devices/${target}/open`,
									"POST",
									{ preferLan: false },
									{ user: true },
								)) as { url?: string };
								const url = new URL(result.url ?? "");
								if (
									!valid() ||
									url.origin !== new URL(captured.hubUrl).origin ||
									url.pathname !== `/device/${target}/__open` ||
									url.username ||
									url.password ||
									!/^[a-f0-9]{64}$/.test(url.searchParams.get("ticket") ?? "")
								)
									throw new Error("Invalid Hub ticket");
								return url.href;
							},
							connect: async (candidate) => {
								if (!valid()) return null;
								const connection = await probeDeviceLan(candidate, { signal: controller.signal });
								if (connection)
									return { connection, expiresAt: (candidate as { expiresAt: number }).expiresAt, transport: "lan" };
								if (!valid()) return null;
								if (!p2pAvailable) {
									console.warn(
										`[DeviceCenter] Device ${id} P2P unavailable: target reports no helper (update the device)`,
									);
									return null;
								}
								if (!(await deviceP2PAvailable())) {
									console.warn(
										`[DeviceCenter] Device ${id} P2P unavailable: no usable helper here (run npm run build:device-p2p, check PI_DEVICE_P2P, or 16 sessions are already open)`,
									);
									return null;
								}
								const result = await connectDeviceP2P(
									(offer, signal) => open(true, offer, signal),
									controller.signal,
									(reason) => console.warn(`[DeviceCenter] Device ${id} P2P failed: ${reason}; using Hub relay`),
								);
								if (result?.relayed) console.warn(`[DeviceCenter] Device ${id} P2P is relayed through TURN`);
								return result;
							},
							renew: async () => {
								const result = (await open(true)) as { deviceLan?: unknown; deviceP2P?: unknown };
								p2pAvailable = result.deviceP2P === true;
								return result.deviceLan;
							},
							fallback: async () => {
								const result = (await open(false)) as { url?: unknown };
								if (!valid() || typeof result.url !== "string") throw new Error("Device binding changed");
								const url = new URL(result.url);
								const hub = new URL(captured.hubUrl);
								if (
									!["http:", "https:"].includes(url.protocol) ||
									url.username ||
									Reflect.get(url, "pass" + "word") ||
									(url.hostname !== hub.hostname && !url.hostname.endsWith("." + hub.hostname)) ||
									![`/device/${id}/__open`, "/__device/open"].includes(url.pathname)
								)
									throw new Error("Invalid Hub ticket");
								if (req.body?.desktop === true) url.searchParams.set("next", "/desktop");
								return url.href;
							},
						});
						if (!valid())
							return res.status(409).json({ code: "DEVICE_CHANGED", error: "Device binding changed; refresh" });
						if (direct) {
							data.fallbackOrigin = new URL(data.url).origin;
							Object.assign(data, direct);
						}
					}
				}
				if (
					path === "devices/:id/remark" &&
					String((req.params as Record<string, string>).id) === captured.deviceId &&
					config
				) {
					const rawRemark = req.body?.remark;
					const remark = typeof rawRemark === "string" ? rawRemark.trim().slice(0, 80) : "";
					config = { ...config, remark: remark || undefined };
					void persist(config);
				}
				res.status(response.status).json(data);
			} catch {
				if (!res.destroyed && (closed || activeConfig() !== captured || generation !== capturedGeneration))
					return res.status(409).json({ code: "DEVICE_CHANGED", error: "Device binding changed; refresh" });
				if (!res.destroyed)
					res.status(502).json({ code: "HUB_UNAVAILABLE", error: "Hub request failed or exceeded response limit" });
			} finally {
				inFlight--;
				activeRequests.delete(controller);
				req.off("aborted", cancel);
				res.off("close", cancel);
			}
		});
	}
	options.app.get("/api/device-center/local-bots", (_req, res) => {
		res.json({ bots: bots.list() });
	});
	options.app.get("/api/device-center/local-bots/:id", (req, res) => {
		res.setHeader("Cache-Control", "no-store");
		const bot = bots.get(String(req.params.id));
		if (!bot) {
			res.status(404).json({ code: "BOT_MISSING", error: "Bot is not configured on this device" });
			return;
		}
		res.json({ bot });
	});
	options.app.post("/api/device-center/local-bots/:id/preset", (req, res) => {
		const controller = new AbortController();
		const cancel = () => {
			if (!res.writableEnded) controller.abort();
		};
		req.once("aborted", cancel);
		res.once("close", cancel);
		void serialize(async () => {
			if (closed) throw new DeviceWorkspaceError(409, "CLOSED", "Device center is shutting down");
			const input = req.body;
			if (
				!input ||
				typeof input !== "object" ||
				Array.isArray(input) ||
				Object.keys(input).some((key) => !["revision", "preset"].includes(key))
			)
				throw new DeviceWorkspaceError(400, "BOT_PRESET_INVALID", "Expected revision and preset");
			const bot = bots.get(String(req.params.id));
			if (!bot) throw new DeviceWorkspaceError(404, "BOT_MISSING", "Bot is not configured on this device");
			if (input.revision !== bot.revision)
				throw new DeviceWorkspaceError(409, "BOT_STALE", "Reload the current Bot revision before saving");
			const catalog = await getLocalBotOptions(
				options.botCatalog ?? { defaultCwd: process.cwd(), dataDir: options.dataDir },
				bot.cwd,
				controller.signal,
			);
			const next = applyLocalBotPreset(bot, input.preset, catalog);
			controller.signal.throwIfAborted();
			const saved = await bots.upsert(next);
			try {
				await syncBots();
				return { bot: saved, synced: true };
			} catch {
				return { bot: saved, synced: false };
			}
		})
			.then(
				(data) => {
					if (!controller.signal.aborted) res.json(data);
				},
				(error) => {
					if (controller.signal.aborted) return;
					const known = error instanceof DeviceWorkspaceError;
					res
						.status(known ? error.status : 500)
						.json({ code: known ? error.code : "BOT_FAILED", error: known ? error.message : "Bot preset save failed" });
				},
			)
			.finally(() => {
				req.off("aborted", cancel);
				res.off("close", cancel);
			});
	});
	function botMutation(remove: boolean) {
		return (req: Request, res: Response) => {
			void serialize(async () => {
				if (closed) throw new DeviceWorkspaceError(409, "CLOSED", "Device center is shutting down");
				const input = req.body;
				const fields = remove
					? ["revision"]
					: [
							"id",
							"revision",
							"name",
							"description",
							"systemPrompt",
							"cwd",
							"model",
							"tools",
							"skills",
							"mcpServers",
							"enabled",
						];
				if (
					!input ||
					typeof input !== "object" ||
					Array.isArray(input) ||
					Object.keys(input).some((key) => !fields.includes(key)) ||
					Buffer.byteLength(JSON.stringify(input)) > 128 * 1024
				)
					throw new DeviceWorkspaceError(400, "BOT_INVALID", "Invalid Bot configuration");
				const previous =
					!remove && typeof (input as { id?: unknown }).id === "string"
						? bots.get(String((input as { id: string }).id))
						: undefined;
				let saved: Awaited<ReturnType<LocalBotRegistry["upsert"]>> | undefined;
				if (remove) await bots.remove(String(req.params.id), input.revision);
				else saved = await bots.upsert(input as LocalBotInput);
				if (saved) {
					try {
						await appendIdentityChange(options.dataDir, saved, previous);
					} catch {}
				}
				const result = remove ? { removed: true } : { bot: saved! };
				try {
					await syncBots();
					return { ...result, synced: true };
				} catch {
					return { ...result, synced: false };
				}
			}).then(
				(data) => res.json(data),
				(error) => {
					const known = error instanceof DeviceWorkspaceError;
					res
						.status(known ? error.status : 500)
						.json({ code: known ? error.code : "BOT_FAILED", error: known ? error.message : "Bot operation failed" });
				},
			);
		};
	}
	options.app.get("/api/device-center/local-bot-options", async (req, res) => {
		if (req.headers.origin || req.headers["sec-fetch-site"] === "cross-site") {
			try {
				const origin = new URL(req.headers.origin ?? "");
				if (!["http:", "https:"].includes(origin.protocol) || origin.host !== req.headers.host) throw new Error();
			} catch {
				res.status(403).json({ code: "LOCAL_ONLY", error: "Same-origin request required" });
				return;
			}
		}
		res.setHeader("Cache-Control", "no-store");
		const controller = new AbortController();
		const cancel = () => {
			if (!res.writableEnded) controller.abort();
		};
		req.once("aborted", cancel);
		res.once("close", cancel);
		try {
			const data = await getLocalBotOptions(
				options.botCatalog ?? { defaultCwd: process.cwd(), dataDir: options.dataDir },
				req.query.cwd,
				controller.signal,
			);
			if (!controller.signal.aborted) res.json(data);
		} catch (error) {
			if (!controller.signal.aborted) {
				const known = error instanceof DeviceWorkspaceError;
				res.status(known ? error.status : 500).json({
					code: known ? error.code : "BOT_CATALOG_FAILED",
					error: known ? error.message : "Bot catalog unavailable",
				});
			}
		} finally {
			req.off("aborted", cancel);
			res.off("close", cancel);
		}
	});
	/** 首轮自举：让 Bot 自己写 profile / 记忆，而不是服务端替它编一份身份。 */
	function bootstrapText(name: string): string {
		return [
			`你是刚创建出来的智能体「${name}」。请完成首轮自举：`,
			"1) 用一两句话介绍你自己（你是谁、负责什么、你打算怎么工作）；",
			"2) 把职责与工作约定写进你的个人记忆（profile / MEMORY.md 允许的方式），并确认你的工作目录可读、记忆可写；",
			"3) 如果缺少必要信息，只问最关键的一个问题，别罗列清单。",
		].join("\n");
	}
	async function scaffoldBotHome(bot: { id: string; name: string; description: string }, draft: BotDraft) {
		const memoryRoot = botMemoryRoot(options.dataDir, bot.id);
		await mkdir(join(options.dataDir, "bot-agents", bot.id, "identity"), { recursive: true });
		await mkdir(memoryRoot, { recursive: true });
		await writeAtomic(
			join(options.dataDir, "bot-agents", bot.id, "identity", "profile.md"),
			[
				"<!-- 由创建流程写入；后续可以被人或 Bot 自己改写（改动会记入 changes.jsonl）。 -->",
				"",
				`# ${bot.name}`,
				"",
				bot.description,
				"",
				`- created: ${new Date(draft.createdAt).toISOString()}`,
				`- authoredBy: ${draft.createdBy}`,
				`- trigger: ${draft.trigger}`,
				"",
			].join("\n"),
		);
		await writeAtomic(
			join(memoryRoot, "MEMORY.md"),
			[
				"<!-- Resident memory: promoted entries only. Injected every session; keep it short. -->",
				"",
				`- [${new Date(draft.createdAt).toISOString().slice(0, 10)}] ${bot.description}`,
				"",
				"<!-- 0 resident · 0 scoped · index: index.jsonl -->",
				"",
			].join("\n"),
		);
		await writeAtomic(join(memoryRoot, "index.jsonl"), "");
	}

	function draftFailure(error: unknown) {
		const known = error as { status?: number; code?: string; message?: string };
		return {
			status: known?.status ?? 500,
			code: known?.code ?? "BOT_DRAFT_FAILED",
			message: known?.message ?? "Bot draft operation failed",
		};
	}

	if (options.botDrafts) {
		const botDrafts = options.botDrafts;
		options.app.get("/api/device-center/bot-drafts", (req: Request, res: Response) => {
			void botDrafts.list().then(
				(drafts) => res.json({ drafts }),
				(error) => {
					const failure = draftFailure(error);
					res.status(failure.status).json({ code: failure.code, error: failure.message });
				},
			);
		});
		options.app.post("/api/device-center/bot-drafts/:id/discard", (req: Request, res: Response) => {
			void botDrafts.discard(String(req.params.id)).then(
				() => res.json({ discarded: true }),
				(error) => {
					const failure = draftFailure(error);
					res.status(failure.status).json({ code: failure.code, error: failure.message });
				},
			);
		});
		options.app.post("/api/device-center/bot-drafts/:id/approve", (req: Request, res: Response) => {
			void serialize(async () => {
				if (closed) throw new DeviceWorkspaceError(409, "CLOSED", "Device center is shutting down");
				const draft = await botDrafts.get(String(req.params.id));
				if (!draft) throw new DeviceWorkspaceError(404, "DRAFT_MISSING", "Bot draft not found or expired");
				const rawApproved = (req.body as { approvedTools?: unknown } | undefined)?.approvedTools;
				const approved = Array.isArray(rawApproved)
					? rawApproved.filter((tool): tool is string => typeof tool === "string" && Boolean(tool))
					: draft.tools.filter((tool) => !draft.highPrivilegeTools.includes(tool));
				// 人只能勾选草案里已有的工具：不允许借确认之手塞进新工具。
				const smuggled = approved.filter((tool) => !draft.tools.includes(tool));
				if (smuggled.length)
					throw new DeviceWorkspaceError(400, "DRAFT_TOOLS_INVALID", `Unknown tools: ${smuggled.join(", ")}`);
				const confirmed = await botDrafts.approve(draft.id, approved);
				const bot = await bots.upsert({
					name: confirmed.name,
					description: confirmed.description,
					systemPrompt: confirmed.systemPrompt,
					cwd: confirmed.cwd,
					...(confirmed.model ? { model: confirmed.model } : {}),
					tools: approved,
					skills: confirmed.skills,
					mcpServers: confirmed.mcpServers,
					enabled: true,
					trigger: confirmed.trigger,
					identity: { authoredBy: confirmed.createdBy, authoredAt: confirmed.createdAt, modelRevision: 1 },
				} as LocalBotInput);
				await botDrafts.markCreated(draft.id, bot.id);
				await scaffoldBotHome(bot, confirmed);
				// 本机 Hub 可能还没被任何设备中心请求唤醒：先把协作通道拉起来，
				// 否则 Bot 同步与直聊房间会被静默跳过（只有 synced:true 的假象）。
				await ensureLocalHub();
				let synced = true;
				try {
					await syncBots();
				} catch {
					synced = false;
				}
				const captured = activeConfig();
				let roomId: string | undefined;
				let bootstrapped = false;
				if (captured && synced) {
					try {
						const room = (await requestDeviceHub(
							captured,
							`/api/device-user/bots/${encodeURIComponent(bot.id)}/direct-room`,
							"POST",
							{},
							{ user: true },
						)) as { room?: { id?: string } };
						roomId = room.room?.id;
					} catch {}
					if (roomId && confirmed.bootstrap) {
						try {
							await requestDeviceHub(
								captured,
								`/api/device-user/rooms/${encodeURIComponent(roomId)}/messages`,
								"POST",
								{ text: bootstrapText(bot.name), idempotencyKey: `bootstrap:${bot.id}` },
								{ user: true },
							);
							bootstrapped = true;
						} catch {}
					}
				}
				return { bot, synced, roomId, bootstrapped };
			}).then(
				(data) => res.json(data),
				(error) => {
					const failure = draftFailure(error);
					res.status(failure.status).json({ code: failure.code, error: failure.message });
				},
			);
		});
	}
	// 记忆查看/整理（人侧）：与 Bot 自己的 memory 工具共用同一套存储与校验。
	const memoryStores = new Map<string, BotMemory>();
	const memoryOf = (botId: string): BotMemory => {
		const existing = memoryStores.get(botId);
		if (existing) return existing;
		const created = createBotMemory({ root: botMemoryRoot(options.dataDir, botId) });
		memoryStores.set(botId, created);
		return created;
	};
	function memoryRoute(
		method: "get" | "post",
		suffix: string,
		handler: (memory: BotMemory, req: Request) => Promise<unknown>,
	) {
		options.app[method](`/api/device-center/local-bots/:id/memory${suffix}`, (req: Request, res: Response) => {
			const botId = String(req.params.id);
			if (!bots.get(botId)) return res.status(404).json({ code: "BOT_NOT_FOUND", error: "Bot not found" });
			void handler(memoryOf(botId), req).then(
				(data) => res.json(data),
				(error: unknown) => {
					const known = error as { status?: number; code?: string; message?: string };
					res
						.status(known?.status ?? 500)
						.json({ code: known?.code ?? "MEMORY_FAILED", error: known?.message ?? "Memory operation failed" });
				},
			);
		});
	}
	memoryRoute("get", "", async (memory) => {
		const { entries } = await memory.snapshot();
		return {
			scopes: await memory.list(),
			entries: entries.slice(-200).map((entry) => ({
				id: entry.id,
				scope: entry.scope,
				summary: entry.summary,
				text: entry.text.slice(0, 500),
				kind: entry.kind,
				confidence: entry.confidence,
				resident: entry.resident === true,
				source: entry.source.type,
				sourceId: entry.source.id.slice(0, 64),
				hits: entry.hits,
				createdAt: entry.createdAt,
				lastUsedAt: entry.lastUsedAt,
			})),
		};
	});
	memoryRoute("get", "/export", async (memory, req) => {
		const bot = bots.get(String(req.params.id));
		return { markdown: await memory.exportMarkdown(bot?.name) };
	});
	memoryRoute("post", "/forget", async (memory, req) => {
		const id = typeof req.body?.id === "string" ? req.body.id : undefined;
		const query = typeof req.body?.query === "string" ? req.body.query : undefined;
		if (!id && !query) throw new DeviceWorkspaceError(400, "MEMORY_FORGET", "Pass an entry id or a query");
		return memory.forget({ ...(id ? { id } : {}), ...(query ? { query } : {}) });
	});
	memoryRoute("post", "/promote", async (memory, req) => {
		const id = typeof req.body?.id === "string" ? req.body.id : "";
		if (!id) throw new DeviceWorkspaceError(400, "MEMORY_PROMOTE", "Pass an entry id");
		return { entry: await memory.promote(id) };
	});
	memoryRoute("post", "/compact", async (memory) => memory.compact());

	// 迁移：导出/导入 Bot 的"家"（身份 + 记忆）。工作目录内容不在包里（那是项目，走 git/文件同步）。
	options.app.get("/api/device-center/local-bots/:id/home", (req: Request, res: Response) => {
		const bot = bots.get(String(req.params.id));
		if (!bot) return res.status(404).json({ code: "BOT_NOT_FOUND", error: "Bot not found" });
		void exportBotHome(options.dataDir, bot).then(
			(bundle) => res.json({ bundle }),
			(error) => {
				const failure = draftFailure(error);
				res.status(failure.status).json({ code: failure.code, error: failure.message });
			},
		);
	});
	options.app.post("/api/device-center/bot-import", (req: Request, res: Response) => {
		void serialize(async () => {
			if (closed) throw new DeviceWorkspaceError(409, "CLOSED", "Device center is shutting down");
			const bundle = parseBotHomeBundle((req.body as { bundle?: unknown } | undefined)?.bundle);
			const requested =
				typeof (req.body as { cwd?: unknown })?.cwd === "string"
					? String((req.body as { cwd: string }).cwd)
					: bundle.bot.cwd;
			const fallback = options.botCatalog?.defaultCwd ?? process.cwd();
			// 目标机器上可能没有原工作目录：先试包里的，再退到本机默认项目。
			let cwd: string;
			try {
				cwd = await validateDeviceProject(requested || fallback, options.dataDir);
			} catch {
				cwd = await validateDeviceProject(fallback, options.dataDir);
			}
			const tools = bundle.bot.tools.filter((name) => ALL_AGENT_TOOL_ENTRIES.some((entry) => entry.name === name));
			const bot = await bots.upsert({
				name: bundle.bot.name,
				description: bundle.bot.description,
				systemPrompt: bundle.bot.systemPrompt,
				cwd,
				...(bundle.bot.model ? { model: bundle.bot.model } : {}),
				tools,
				skills: bundle.bot.skills,
				mcpServers: bundle.bot.mcpServers,
				enabled: true,
				// 导入的 Bot 一定是按需触发：不允许一个包把新设备变成常驻消耗。
				trigger: "on_demand",
				...(bundle.bot.identity ? { identity: bundle.bot.identity } : {}),
			});
			const imported = await importBotHome(options.dataDir, bundle, bot.id);
			if (!imported.profile)
				await scaffoldBotHome(bot, {
					createdAt: Date.now(),
					createdBy: bundle.bot.identity?.authoredBy ?? "human",
					trigger: "on_demand",
				} as BotDraft);
			await ensureLocalHub();
			let synced = true;
			try {
				await syncBots();
			} catch {
				synced = false;
			}
			const captured = activeConfig();
			let roomId: string | undefined;
			if (captured && synced) {
				try {
					const room = (await requestDeviceHub(
						captured,
						`/api/device-user/bots/${encodeURIComponent(bot.id)}/direct-room`,
						"POST",
						{},
						{ user: true },
					)) as { room?: { id?: string } };
					roomId = room.room?.id;
				} catch {}
			}
			return { bot, synced, roomId, ...imported };
		}).then(
			(data) => res.json(data),
			(error) => {
				const failure = draftFailure(error);
				res.status(failure.status).json({ code: failure.code, error: failure.message });
			},
		);
	});
	options.app.post("/api/device-center/local-bots", botMutation(false));
	options.app.post("/api/device-center/local-bots/:id/delete", botMutation(true));
	userRoute("get", "bots", []);
	userRoute("post", "bots/:id/direct-room", []);
	userRoute("post", "bots/:id/share", ["sourceRoomId", "targetRoomId", "mode", "messageIds", "note", "idempotencyKey"]);
	userRoute("get", "direct-rooms", []);
	userRoute("get", "devices", []);
	userRoute("post", "devices/:id/open", ["preferLan", "desktop", "basePath"]);
	userRoute("post", "devices/:id/remark", ["remark"]);
	userRoute("get", "rooms", []);
	userRoute("get", "rooms/:id", []);
	userRoute("post", "rooms/:id", ["router", "routerRevision"]);
	userRoute("post", "rooms/:id/canvas", ["binding"]);
	userRoute("get", "rooms/:id/tasks/:taskId", []);
	userRoute("get", "rooms/:id/tasks/:taskId/journal", []);
	userRoute("get", "rooms/:id/tasks/:taskId/report", []);
	userRoute("post", "rooms/:id/tasks/:taskId/report", [
		"chunkIndex",
		"totalChunks",
		"text",
		"attemptId",
		"isFinal",
		"sha256",
	]);
	userRoute("post", "rooms/:id/tasks/:taskId/approve-plan", []);
	userRoute("get", "rooms/:id/interactions", []);
	userRoute("post", "rooms/:id/interactions", [
		"taskId",
		"attemptId",
		"interactionId",
		"answers",
		"cancelled",
		"decision",
	]);
	userRoute("get", "rooms/:id/conversations", []);
	userRoute("get", "rooms/:id/conversations/:conversationId", []);
	userRoute("post", "rooms/:id/conversations", [
		"name",
		"targetBotId",
		"text",
		"idempotencyKey",
		"planOnly",
		"executionMode",
		"contract",
	]);
	userRoute("post", "rooms/:id/conversations/:conversationId/messages", [
		"text",
		"kind",
		"requestId",
		"attentionId",
		"idempotencyKey",
		"planOnly",
		"executionMode",
		"contract",
	]);
	userRoute("post", "rooms/:id/conversations/:conversationId/deliveries", [
		"artifactTaskId",
		"repository",
		"baseCommit",
		"commit",
		"branch",
		"summary",
		"checks",
		"limitations",
		"idempotencyKey",
	]);
	userRoute("post", "rooms/:id/conversations/:conversationId/reviews", [
		"deliveryId",
		"commit",
		"artifactDigest",
		"integrationId",
		"verificationDigest",
		"criteriaResults",
		"verdict",
		"summary",
		"idempotencyKey",
	]);
	userRoute("get", "rooms/:id/conversations/:conversationId/integrations", []);
	userRoute("post", "rooms/:id/conversations/:conversationId/integrations", [
		"deliveryId",
		"targetBotId",
		"targetBranch",
		"idempotencyKey",
	]);
	userRoute("post", "rooms/:id/conversations/:conversationId/integrations/:integrationId/verify", ["commands"]);
	userRoute("post", "rooms/:id/conversations/:conversationId/integrations/:integrationId/apply", ["expectedTargetSha"]);
	userRoute("post", "rooms/:id/conversations/:conversationId/integrations/:integrationId/cancel", []);
	userRoute("post", "rooms/:id/conversations/:conversationId/integrations/:integrationId/reconcile", []);
	userRoute("post", "rooms/:id/conversations/:conversationId/integrations/:integrationId/resume", [
		"intentId",
		"intentDigest",
		"candidateSha",
	]);
	userRoute("get", "rooms/:id/transfers", []);
	userRoute("post", "rooms/:id/transfers/start", [
		"sourceBotId",
		"targetBotId",
		"paths",
		"recursive",
		"idempotencyKey",
	]);
	userRoute("get", "rooms/:id/transfers/:transferId/preview", []);
	userRoute("post", "rooms/:id/transfers/:transferId/resume", [
		"manifestHash",
		"sourceBotRevision",
		"targetBotRevision",
	]);
	userRoute("post", "rooms/:id/transfers/:transferId/apply", ["revision", "overwritePaths"]);
	userRoute("post", "rooms/:id/transfers/:transferId/abort", []);
	userRoute("post", "rooms", ["name", "botIds", "primaryBotId"]);
	userRoute("post", "rooms/:id/rename", ["name"]);
	userRoute("post", "rooms/:id/members", ["botIds", "primaryBotId"]);
	userRoute("post", "rooms/:id/clear", []);
	userRoute("post", "rooms/:id/delete", []);
	userRoute("post", "rooms/:id/messages", [
		"text",
		"targetBotIds",
		"sourceBotId",
		"idempotencyKey",
		"handoff",
		"parentTaskId",
		"planOnly",
		"executionMode",
		"contract",
	]);
	userRoute("get", "rooms/:id/webhooks", []);
	userRoute("post", "rooms/:id/webhooks", [
		"name",
		"type",
		"enabled",
		"allowBotTrigger",
		"url",
		"secret",
		"events",
		"relayViaHub",
	]);
	userRoute("post", "rooms/:id/webhooks/:webhookId", [
		"name",
		"enabled",
		"allowBotTrigger",
		"url",
		"secret",
		"events",
		"relayViaHub",
	]);
	userRoute("post", "rooms/:id/webhooks/:webhookId/regenerate-token", []);
	userRoute("post", "rooms/:id/webhooks/:webhookId/delete", []);
	userRoute("post", "rooms/:id/webhooks/:webhookId/test", []);
	userRoute("post", "rooms/:id/hub-relay", ["hubRelayBaseUrl"]);
	function route(path: string, work: (req: Request) => Promise<unknown>) {
		options.app.post(`/api/device-center/${path}`, (req, res) => {
			void serialize(async () => {
				if (closed) throw new Error("Device center is shutting down");
				return work(req);
			}).then(
				(data) => res.json(data),
				(error) => res.status(400).json({ error: (error as Error).message }),
			);
		});
	}
	route("pair", async (req) => {
		if (config) throw new Error("Disconnect the existing device before pairing again");
		const hubUrl = normalizeHubUrl(req.body?.hubUrl);
		const name = req.body?.name;
		if (typeof name !== "string" || !name.trim() || name.length > 80)
			throw new Error("Device name must contain 1–80 characters");
		const result = await hubRequest(hubUrl, "/api/pair/start", { name: name.trim() });
		if (typeof result.code !== "string" || typeof result.pollToken !== "string")
			throw new Error("Invalid pairing response");
		const expiresAt = typeof result.expiresAt === "number" ? result.expiresAt : Date.parse(result.expiresAt);
		if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 15 * 60_000)
			throw new Error("Invalid pairing expiry");
		pending = { hubUrl, name: name.trim(), pollToken: result.pollToken, expiresAt, generation: ++generation };
		return { code: result.code, expiresAt, hubUrl };
	});
	route("poll", async () => {
		const pair = pending;
		if (!pair || pair.expiresAt < Date.now()) {
			pending = undefined;
			throw new Error("Pairing expired; request a new code");
		}
		const result = await hubRequest(pair.hubUrl, "/api/pair/poll", { pollToken: pair.pollToken });
		if (result.pending) return { pending: true };
		if (closed || pair.generation !== generation) throw new Error("Pairing cancelled");
		if (
			typeof result.deviceId !== "string" ||
			typeof result.credential !== "string" ||
			typeof result.uiCredential !== "string" ||
			!result.uiCredential
		)
			throw new Error("Invalid device credentials");
		const next = {
			hubUrl: pair.hubUrl,
			name: pair.name,
			deviceId: result.deviceId,
			...(typeof result.accountId === "string" && result.accountId ? { accountId: result.accountId } : {}),
			credential: result.credential,
			uiCredential: result.uiCredential,
			allowExecution: false,
		};
		await persist(next);
		config = next;
		pending = undefined;
		await reconnect();
		return { paired: true };
	});
	route("execution", async (req) => {
		if (!config) throw new Error("Pair this computer first");
		if (typeof req.body?.allowExecution !== "boolean") throw new Error("Invalid execution permission");
		const next = { ...config, allowExecution: req.body.allowExecution };
		await persist(next);
		config = next;
		await reconnect();
		return { saved: true };
	});
	route("remark", async (req) => {
		if (!config) throw new Error("Pair this computer first");
		const rawRemark = req.body?.remark;
		if (rawRemark !== null && rawRemark !== undefined && typeof rawRemark !== "string")
			throw new Error("Invalid remark");
		const remark = typeof rawRemark === "string" ? rawRemark.trim().slice(0, 80) : "";
		const next = { ...config, remark: remark || undefined };
		await persist(next);
		config = next;
		return { saved: true, remark: next.remark };
	});
	route("execution-settings", async (req) => {
		const boundConnection = connection;
		// Persist first, then apply to captured active runtime
		const saved = saveExecutionSettings(options.dataDir, req.body);
		if (boundConnection?.runtime) {
			boundConnection.runtime.updateExecutionSettings(saved);
		}
		return { settings: saved };
	});
	route("execution-queue/cancel", async (req) => {
		const boundConnection = connection;
		const taskId = req.body?.taskId;
		const attemptId = req.body?.attemptId;
		if (typeof taskId !== "string" || !taskId) {
			throw new Error("taskId is required");
		}
		if (attemptId !== undefined && (typeof attemptId !== "string" || !attemptId)) {
			throw new Error("attemptId must be a string");
		}
		const cancelled = boundConnection?.runtime?.cancelScheduledTask(taskId, attemptId) ?? false;
		return { cancelled };
	});
	route("disconnect", async () => {
		await persist(undefined);
		generation++;
		for (const controller of activeRequests) controller.abort();
		pending = undefined;
		config = undefined;
		await reconnect();
		return { disconnected: true };
	});
	return {
		syncBots,
		workItems,
		publishMobileNotification: mobileNotifications.enqueue,
		getConfig() {
			const current = activeConfig();
			if (!current) return undefined;
			return forAgent(current);
		},
		async close() {
			closed = true;
			await mobileNotifications.dispose();
			options.lanAccess?.close();
			await hubSetup.close();
			generation++;
			for (const controller of activeRequests) controller.abort();
			await serial;
			await localStarting;
			await connection?.close();
			connection = undefined;
			await localHub?.close();
			localHub = undefined;
		},
	};
}
