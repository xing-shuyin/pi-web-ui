import type { Express, Request, Response, NextFunction } from "express";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getLocalBotOptions, type BotCatalogSources } from "./bot-catalog.js";
import { applyLocalBotPreset } from "./bot-presets.js";
import { isIP } from "node:net";
import { installHubSetupRoutes } from "./hub-setup.js";
import { DeviceWorkspaceError } from "./workspaces.js";
import { createLocalDeviceHub } from "./local-hub.js";
import { createLocalBotRegistry, type LocalBotRegistry, type LocalBotInput } from "./bots.js";
import { loadExecutionSettings, saveExecutionSettings, type DeviceExecutionSettings } from "./execution-settings.js";
import type { TaskSchedulerSnapshot } from "./task-scheduler.js";

export interface LocalDeviceConfig {
	hubUrl: string;
	name: string;
	deviceId: string;
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
	botCatalog?: BotCatalogSources;
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

function localOnly(req: Request, res: Response, next: NextFunction): void {
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
	if (!(host === "localhost" || host === "::1" || (isIP(host) === 4 && host.startsWith("127.")))) {
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
}

export async function installLocalDeviceCenter(options: Options) {
	const file = join(options.dataDir, "device-center.json");
	const bots = options.bots ?? (await createLocalBotRegistry(options.dataDir));
	let config: LocalDeviceConfig | undefined;
	let connection: Connection | undefined;
	let localHub: Awaited<ReturnType<typeof createLocalDeviceHub>> | undefined;
	let localStarting: Promise<void> | undefined;
	const activeConfig = () => config ?? localHub?.config;
	async function ensureLocalHub() {
		if (config || localHub || closed) return;
		if (!localStarting) {
			localStarting = (async () => {
				const hub = await createLocalDeviceHub(options.dataDir);
				try {
					const { uiCredential: _uiCredential, ...agentConfig } = hub.config;
					localHub = hub;
					connection = await options.connect(agentConfig, syncBots);
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
		await localStarting;
		await connection?.close();
		connection = undefined;
		await localHub?.close();
		localHub = undefined;
		await bots.setScope(config ? JSON.stringify([config.hubUrl, config.deviceId]) : "unpaired");
		if (config && !closed) {
			const { uiCredential: _uiCredential, ...agentConfig } = config;
			connection = await options.connect(agentConfig, syncBots);
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
		await response.body?.cancel();
		if (!response.ok)
			throw new Error("Bot configuration saved locally, but Hub synchronization failed; retry after reconnecting");
		if (activeConfig() !== captured || closed) throw new Error("Device binding changed during Bot synchronization");
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
				typeof value.allowExecution !== "boolean" ||
				(value.uiCredential !== undefined && typeof value.uiCredential !== "string")
			)
				throw new Error("Invalid saved device configuration");
			config = { ...value, hubUrl: normalizeHubUrl(value.hubUrl) };
			await reconnect();
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	// Existing bookmarks now enter the native application view.
	options.app.get("/devices", localOnly, (_req, res) => {
		res.redirect("./?view=devices");
	});
	options.app.use("/api/device-center", localOnly);
	const hubSetup = installHubSetupRoutes(options.app, options.dataDir);
	options.app.get("/api/device-center/status", (_req, res) => {
		res.json({
			name: config?.name ?? hostname(),
			hubUrl: config?.hubUrl,
			deviceId: config?.deviceId,
			allowExecution: config?.allowExecution ?? false,
			connected: connection?.isConnected?.() ?? false,
		});
	});
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
	// Account chat discovery is safe to relay; local settings remain device-only.
	options.app.get("/api/device-center/chat-status", async (_req, res) => {
		try {
			await serialize(ensureLocalHub);
			const current = activeConfig();
			res.json({ hubUrl: current?.hubUrl, deviceId: current?.deviceId, ...(!config ? { local: true } : {}) });
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
	function userRoute(method: "get" | "post", path: string, fields: string[]) {
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
					Buffer.byteLength(JSON.stringify(body)) > 32768)
			)
				return res.status(400).json({ code: "INVALID_BODY", error: "Invalid group request" });
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
				const response = await fetch(`${captured.hubUrl}/api/device-user/${suffix}${queryStr}`, {
					method: method.toUpperCase(),
					redirect: "error",
					signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
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
						// Forward the hub's own diagnosis: a fixed "rejected" string erases the real cause
						// ("Task missing", "Plan conversation unavailable", …) and makes the UI undebuggable.
						error: status === 401 ? "Pair this computer again" : (hubMessage ?? "Hub rejected group request"),
						hubStatus: response.status,
						...(hubCode ? { hubCode } : {}),
					});
				}
				const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
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
				const result = remove
					? (await bots.remove(String(req.params.id), input.revision), { removed: true })
					: { bot: await bots.upsert(input as LocalBotInput) };
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
	options.app.post("/api/device-center/local-bots", botMutation(false));
	options.app.post("/api/device-center/local-bots/:id/delete", botMutation(true));
	userRoute("get", "bots", []);
	userRoute("get", "devices", []);
	userRoute("post", "devices/:id/open", []);
	userRoute("get", "rooms", []);
	userRoute("get", "rooms/:id", []);
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
	userRoute("post", "rooms/:id/conversations", ["name", "targetBotId", "text", "idempotencyKey", "planOnly"]);
	userRoute("post", "rooms/:id/conversations/:conversationId/messages", [
		"text",
		"kind",
		"requestId",
		"attentionId",
		"idempotencyKey",
		"planOnly",
	]);
	userRoute("post", "rooms/:id/conversations/:conversationId/deliveries", [
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
	]);
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
		getConfig() {
			const current = activeConfig();
			if (!current) return undefined;
			const { uiCredential: _uiCredential, ...agentConfig } = current;
			return agentConfig;
		},
		async close() {
			closed = true;
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
