import type { Express, Request, Response, NextFunction } from "express";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createMobileNotificationForwarder } from "./mobile-notification-forwarder.js";
import { getLocalBotOptions, type BotCatalogSources } from "./bot-catalog.js";
import { applyLocalBotPreset } from "./bot-presets.js";
import { listBotChatTranscripts } from "./bot-chat.js";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { BotDraft, BotDraftStore } from "./bot-drafts.js";
import { botMemoryRoot, createBotMemory, type BotMemory } from "./bot-memory.js";
import { appendIdentityChange } from "./bot-identity.js";
import { exportBotHome, importBotHome, parseBotHomeBundle } from "./bot-home.js";
import { ALL_AGENT_TOOL_ENTRIES } from "../tool-manager.js";
import { writeAtomic } from "../atomic-file.js";
import { installHubSetupRoutes } from "./hub-setup.js";
import { DeviceWorkspaceError, validateDeviceProject } from "./workspaces.js";
import { createLocalDeviceHub } from "./local-hub.js";
import { isLocalTaskRuntime } from "./local-task-bridge.js";
import { createLocalBotRegistry, type LocalBotRegistry, type LocalBotInput } from "./bots.js";
import { installSharedRoomRoutes } from "./shared-rooms.js";
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
	/**
	 * 稳定的引擎身份串（只有本机 loopback Hub 会设）。本机 Hub 每次启动换随机端口，
	 * `hubUrl` 不能当持久化作用域键：会话恢复、任务恢复、报告 outbox、文件同步目录、
	 * 工作区锁都按它分桶。见 `server/device-center/runtime.ts` 的 `hubKey`。
	 */
	hubIdentity?: string;
}
interface Connection {
	close(): void | Promise<void>;
	isConnected?(): boolean;
	/**
	 * 设备运行时：`getSchedulerSnapshot` 等三个是设备中心 UI 必需；
	 * 其余为实现"本机任务直调"才需要——缺失时 installLocalDeviceCenter 会继续走 relay。
	 */
	runtime?: {
		getSchedulerSnapshot(): TaskSchedulerSnapshot;
		updateExecutionSettings(next: unknown): DeviceExecutionSettings;
		cancelScheduledTask(taskId: string, attemptId?: string): boolean;
		onTask?: import("./local-task-bridge.js").LocalTaskRuntime["onTask"];
		steerTask?: import("./local-task-bridge.js").LocalTaskRuntime["steerTask"];
		answerTaskInteraction?: import("./local-task-bridge.js").LocalTaskRuntime["answerTaskInteraction"];
		recovery?: import("./local-task-bridge.js").LocalTaskRuntime["recovery"];
		reportOutbox?: import("./local-task-bridge.js").LocalTaskRuntime["reportOutbox"];
	};
}
interface Options {
	app: Express;
	dataDir: string;
	connect(config: LocalDeviceConfig, syncBots: () => Promise<void>): Connection | Promise<Connection>;
	bots?: LocalBotRegistry;
	botDrafts?: BotDraftStore;
	/**
	 * 「一句话建 Bot」的服务端执行者：跑一次模型调用产出草案（不占会话）。
	 * 由宿主注入（需要 agentDir / 工具白名单 / 模型），设备中心本身不碰模型。
	 */
	draftBotFromRequest?: (request: string, signal?: AbortSignal, cwd?: string) => Promise<BotDraft>;
	botCatalog?: BotCatalogSources;
	allowHosts?: readonly string[];
	/** 显式声明的同源例外（dev 的 Vite 代理：页面 origin 与后端 Host 不同）。 */
	allowOrigins?: readonly string[];
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
/**
 * 写请求的 origin 判定（单源）：
 * - 常规：Origin 与 Host 同源（浏览器直连、反向代理都成立）；
 * - 例外：运维在 PI_WEB_ALLOW_ORIGINS 里显式声明的 origin（dev 的 Vite 代理会改写 Host）。
 * 放行的只是"这个声明过的页面"，不改变同源判定本身。
 */
export function allowsLocalWriteOrigin(
	originHeader: string | undefined,
	hostHeader: string | undefined,
	allowOrigins: ReadonlySet<string>,
): boolean {
	try {
		const origin = new URL(originHeader ?? "");
		if (!["http:", "https:"].includes(origin.protocol)) return false;
		return allowOrigins.has(origin.origin) || origin.host === hostHeader;
	} catch {
		return false;
	}
}

function localOnly(allowHosts: ReadonlySet<string>, allowOrigins: ReadonlySet<string>) {
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
		if (
			!["GET", "HEAD"].includes(req.method) &&
			!allowsLocalWriteOrigin(req.headers.origin, req.headers.host, allowOrigins)
		) {
			res.status(403).json({ code: "LOCAL_ONLY", error: "Same-origin request required" });
			return;
		}
		res.setHeader("Cache-Control", "no-store");
		next();
	};
}

export async function installLocalDeviceCenter(options: Options) {
	const file = join(options.dataDir, "device-center.json");
	const bots = options.bots ?? (await createLocalBotRegistry(options.dataDir));
	const botDrafts = options.botDrafts;
	const draftBotFromRequest = options.draftBotFromRequest;
	let config: LocalDeviceConfig | undefined;
	let connection: Connection | undefined;
	let localHub: Awaited<ReturnType<typeof createLocalDeviceHub>> | undefined;
	let localStarting: Promise<void> | undefined;
	const activeConfig = () => config ?? localHub?.config;
	/**
	 * 房间引擎（直聊 + 群组）的**唯一权威**：永远是本机 local hub。
	 *
	 * Bot 在本机跑、历史在本机落盘，房间就不该寄居在远端 Hub 上（它一旧/一断，侧栏就整块“加载失败”）。
	 * 远端配对（`config`）现在只剩两件事：设备级功能（设备列表/打开设备/LAN/P2P/升级），
	 * 以及把 Bot 列表镜像过去（阶段二才用它跑远程群组/Bot）。
	 */
	const roomConfig = () => localHub?.config;
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
		// 房间引擎永远本机：配对与否都起，不再“配对后就把房间交给远端”。
		if (localHub || closed) return;
		if (!localStarting) {
			localStarting = (async () => {
				const hub = await createLocalDeviceHub(options.dataDir, () => loadExecutionSettings(options.dataDir));
				try {
					localHub = hub;
					connection = await connectRuntime(hub);
					// 本机设备：任务直调（不绕 WS + 本地调度）。远程设备仍然走 relay。
					if (connection.runtime && isLocalTaskRuntime(connection.runtime))
						hub.attachLocalDeviceRuntime(connection.runtime);
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
	/**
	 * 拉起运行时并把「本机」接到它该接的那台 Hub 上。
	 *
	 * 已配对 → 必须用**配对得来的设备身份**（`config`）接远端 Hub：设备在线表、任务投递、
	 * LAN/P2P/升级都按那个 deviceId 认人；拿本机 Hub 的占位身份（`local-device`）去接，
	 * 远端永远看到“设备不在线”，派出去的任务直接判失败。
	 * 未配对 → 接本机 Hub（只为了让房间引擎拿到运行时，不涉及任何远端协作）。
	 */
	async function connectRuntime(hub: { config: LocalDeviceConfig }) {
		const paired = config;
		if (!paired) return options.connect(forAgent(hub.config), syncBots);
		try {
			// 身份给远端（设备在线表/投递按它认人），但**分桶身份**仍用本机引擎的：
			// 会话/恢复/锁的键不能跟着远端 URL 或本机随机端口漂（重启后 resume 才不会全丢）。
			return await options.connect(forAgent({ ...paired, hubIdentity: hub.config.hubIdentity }), syncBots);
		} catch (error) {
			// 远端 Hub 暂时连不上不该把本机房间一起拖下水：先用本机身份把运行时拉起来，
			// 下次 `reconnect()`（轮询/配对/执行开关变化）会再试一次真实身份。
			console.warn("[device-center] Hub connection failed; local rooms stay available", error);
			return options.connect(forAgent(hub.config), syncBots);
		}
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
		if (closed) return;
		// Bot 身份是本机的（`LOCAL_BOT_SCOPE`），不再跟着配对重算；房间引擎也永远本机。
		await ensureLocalHub();
	}
	/**
	 * 把本机 Bot 列表推给一台 Hub（`PUT /api/agent/bots`）。被认证的 Hub 才能确认 owner。
	 * 抛出（非 2xx）就是“这台 Hub 没登记成功”，调用方自己决定是不是致命。
	 */
	async function pushBots(target: LocalDeviceConfig) {
		const response = await fetch(`${target.hubUrl}/api/agent/bots`, {
			method: "PUT",
			redirect: "error",
			signal: AbortSignal.timeout(15000),
			headers: {
				"Content-Type": "application/json",
				"X-Device-Id": target.deviceId,
				Authorization: `Bearer ${target.credential}`,
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
		if (typeof accountId === "string" && accountId) {
			if (target.accountId && target.accountId !== accountId)
				throw Object.assign(new Error("Device account binding changed"), { code: "ACCOUNT_BINDING_CHANGED" });
			if (!target.accountId) target.accountId = accountId;
		}
	}
	/**
	 * Bot 列表同步：本机房间引擎是权威（推进去失败就算保存失败），远端配对 Hub 只是镜像
	 * （阶段二才用它跑远程群组；镜像失败不能拖死本地保存）。
	 */
	async function syncBots() {
		if (closed) return;
		const engine = roomConfig();
		if (!engine) return;
		await pushBots(engine);
		const remote = config;
		if (remote && remote !== engine)
			await pushBots(remote).catch((error) => {
				// 账号被换绑是安全信号，不能当“镜像失败”吞掉；其余镜像失败不该拖死本地保存。
				if ((error as { code?: string })?.code === "ACCOUNT_BINDING_CHANGED") throw error;
			});
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
	const allowOrigins = new Set(
		(options.allowOrigins ?? [])
			.map((entry) => {
				try {
					return new URL(String(entry)).origin;
				} catch {
					return "";
				}
			})
			.filter(Boolean),
	);
	const guard = localOnly(allowHosts, allowOrigins);
	// Public incoming webhook forwarding (authenticates via webhook token inside hub)
	options.app.post("/api/rooms/:id/webhooks/incoming/:webhookId", async (req, res) => {
		// 房间引擎在本机，webhook 也只能落到本机这套房间上。
		const captured = roomConfig();
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
				// 房间引擎永远在本机：远端配对与否都不影响侧栏能不能列房间。
				roomsReady: !!roomConfig(),
			});
		} catch {
			res.status(503).json({ code: "LOCAL_HUB_UNAVAILABLE", error: "Local collaboration could not start" });
		}
	});
	// 跨设备共享群组：成员含其他设备时走配对远端 Hub（显式 shared-* 接口，不动本地链路）。
	installSharedRoomRoutes(options.app, {
		getPaired: () => config,
		ensureReady: () => serialize(ensureLocalHub),
		isClosed: () => closed,
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
		const captured = roomConfig();
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
			// 房间事件流只打本机引擎：跨设备共享群组走显式 `shared-rooms/:id/events`（shared-rooms.ts），
			// 这里不做透明回退——否则 local-first 会被「本机 404 就转发远端」破穿，本地流量也外泄。
			const upstream = await fetch(
				`${captured.hubUrl}/api/device-user/rooms/${encodeURIComponent(String(req.params.id))}/events`,
				{
					redirect: "error",
					signal: controller.signal,
					headers: { "X-Device-Id": captured.deviceId, Authorization: `Bearer ${captured.uiCredential}` },
				},
			);
			if (!upstream.ok || !upstream.body) {
				await upstream.body?.cancel();
				res.sendStatus(502);
				return;
			}
			if (closed || generation !== capturedGeneration || roomConfig() !== captured) return;
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
						roomConfig() !== captured ||
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
		if (binding && (roomConfig() !== binding.config || generation !== binding.generation))
			throw Object.assign(new Error("Device binding changed; refresh"), { status: 409 });
		const captured = roomConfig();
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
			if (closed || roomConfig() !== captured || generation !== capturedGeneration)
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
		const config = roomConfig();
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
	function userRoute(
		method: "get" | "post" | "put",
		path: string,
		fields: string[],
		limits: { maxBytes?: number } = {},
	) {
		const writes = method !== "get";
		const supportsContract = method === "post" && fields.includes("contract");
		const maxBytes = limits.maxBytes ?? 32768;
		options.app[method](`/api/device-center/${path}`, async (req, res) => {
			try {
				await serialize(ensureLocalHub);
			} catch {
				return res.status(503).json({ code: "LOCAL_HUB_UNAVAILABLE", error: "Local collaboration could not start" });
			}
			// 房间/Bot 类路径落到本机引擎；只有设备级路径（`devices*`）才回远端配对。
			// 房间在本机 = 侧栏/对话不再受 Hub 版本与在线状态影响（阶段二再把远程群组接回来）。
			const currentTarget = () => (path.startsWith("devices") ? (config ?? roomConfig()) : roomConfig());
			const captured = currentTarget();
			const capturedGeneration = generation;
			if (!captured) return res.status(409).json({ code: "NOT_PAIRED", error: "Pair this computer first" });
			if (!captured.uiCredential)
				return res
					.status(409)
					.json({ code: "REPAIR_REQUIRED", error: "Pair this computer again to enable group chat" });
			if (closed || inFlight >= 8) return res.status(429).json({ code: "BUSY", error: "Device center busy" });
			const body = req.body ?? {};
			if (
				writes &&
				(!body ||
					typeof body !== "object" ||
					Array.isArray(body) ||
					Object.keys(body).some((key) => !fields.includes(key)) ||
					Buffer.byteLength(JSON.stringify(body)) >
						(supportsContract && body.contract !== undefined ? MAX_CONTRACT_REQUEST_BYTES : maxBytes))
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
					...(writes ? { body: JSON.stringify(body) } : {}),
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
				if (closed || currentTarget() !== captured || generation !== capturedGeneration)
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
							!closed &&
							!controller.signal.aborted &&
							currentTarget() === captured &&
							generation === capturedGeneration;
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
								if (connection) return { connection, expiresAt: connection.expiresAt, transport: "lan" };
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
				if (!res.destroyed && (closed || currentTarget() !== captured || generation !== capturedGeneration))
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
	/**
	 * 左栏「智能体」区的唯一读取入口：Bot 身份、草案、直聊房间**全部读本机**。
	 *
	 * Bot 在本机跑、房间引擎也是本机的，所以 Hub 旧版本 / 离线 / 未配对都只影响
	 * `roomsAvailable`（本机引擎异常时的降级位），不会让整块列表变成「加载失败」。
	 * 远端配对只负责把这份列表镜像过去（`syncBots()`），阶段二才用它跑远程群组。
	 */
	options.app.get("/api/device-center/bot-panel", (req, res) => {
		const controller = new AbortController();
		const cancel = () => {
			if (!res.writableEnded) controller.abort();
		};
		req.once("aborted", cancel);
		res.once("close", cancel);
		void (async () => {
			await serialize(ensureLocalHub);
			const engine = roomConfig();
			if (!engine) throw new Error("Local room engine is unavailable");
			const drafts = botDrafts ? await botDrafts.list().catch(() => []) : [];
			if (controller.signal.aborted) return;
			const deviceName = config?.name ?? hostname();
			// 忙碌来自本机 Hub 的任务视图：左栏据此显示"执行中"，用户不会在 Bot 跑任务时以为它空闲。
			const busy = localHub?.busyBots?.() ?? new Set<string>();
			const bots_ = bots.list().map(({ id, name, enabled, cwd }) => ({
				id,
				name,
				enabled,
				cwd,
				busy: busy.has(id),
				deviceName,
				online: true,
				local: true,
			}));
			res.json({ bots: bots_, drafts });
		})()
			.catch(() => {
				if (!res.destroyed && !res.headersSent)
					res.status(500).json({ code: "BOT_PANEL_FAILED", error: "Bot list could not be read from this device" });
			})
			.finally(() => {
				req.off("aborted", cancel);
				res.off("close", cancel);
			});
	});
	// 这个 Bot 的历史私聊：默认入口只回最近一份，改成“新开对话”后旧记录也要有地方打开。
	// 打开仍走既有 `switch_session`（bot-sessions 在允许目录里），绑定由转录锚点重建。
	options.app.get("/api/device-center/local-bots/:id/sessions", (req: Request, res: Response) => {
		const botId = String(req.params.id);
		if (!bots.get(botId)) return res.status(404).json({ code: "BOT_NOT_FOUND", error: "Bot not found" });
		res.setHeader("Cache-Control", "no-store");
		const agentDir = options.botCatalog?.agentDir ?? getAgentDir();
		res.json({ sessions: listBotChatTranscripts(agentDir, botId) });
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
							// GET 会回传这两个字段（身份台账 / 存量元数据），编辑时必须允许原样带回：
							// 客户端把读到的 Bot 改一改再 POST 是正常用法。写入时身份由服务端重盖。
							"identity",
							"trigger",
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
				if (remove) {
					const botId = String(req.params.id);
					await bots.remove(botId, input.revision);
					// 删 Bot 连带删它的"家"（身份 + 记忆）：只删注册表会留下永远读不到的孤儿记忆，
					// 用户以为删干净了、磁盘上却还在。工作目录属于项目，不动。
					memoryStores.delete(botId);
					await rm(join(options.dataDir, "bot-agents", botId), { recursive: true, force: true }).catch(() => {});
				} else {
					const next = { ...(input as LocalBotInput) };
					// 这条路由是人工编辑（本机设备中心）：身份账本必须记下人改的，
					// 不能沿用草案留下的 "model"  authorship。触发形态不在可改字段里，按原值保留。
					next.identity = {
						authoredBy: "human",
						authoredAt: Date.now(),
						modelRevision: previous?.identity?.modelRevision ?? 0,
					};
					if (next.trigger === undefined && previous?.trigger) next.trigger = previous.trigger;
					saved = await bots.upsert(next);
				}
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
		if (
			(req.headers.origin || req.headers["sec-fetch-site"] === "cross-site") &&
			!allowsLocalWriteOrigin(req.headers.origin, req.headers.host, allowOrigins)
		) {
			res.status(403).json({ code: "LOCAL_ONLY", error: "Same-origin request required" });
			return;
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
		// MEMORY.md 是 index 的投影：初始化就写一行“描述”既不在索引里，也会被下一次渲染覆盖。
		// 描述属于身份（profile.md）；常驻区空着，等 promote 进来。
		await writeAtomic(
			join(memoryRoot, "MEMORY.md"),
			[
				"<!-- Resident memory: promoted entries only. Injected every session; keep it short. -->",
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
	/**
	 * 草案失败时给界面一段**可以展示**的原因（例如“套餐不含这个模型”）。
	 * 为什么另开字段而不让前端直接用 `error`：那条通道是给 Hub 上游用的，上游文本可能带凭据，
	 * 前端（`deviceGroupRequest`）故意只读 `code`。`detail` 只由本地草案接口写，前端也只对 `bot-drafts` 路径读它。
	 */
	/**
	 * 草案的落地项目：优先用请求里带的当前项目；默认工作区是主目录 / 卷根 / 数据目录内时退回最近项目。
	 * （dev 从 home 启动是常态；不这样兜底，"一句话建 Bot"会在确认阶段才炸。）
	 */
	async function resolveBotProjectCwd(requested?: string): Promise<string> {
		// 当前工作区可能是主目录 / 数据目录内（dev 从 home 启动很常见）：逐个候选试，
		// 第一个能作为项目的胜出。草案卡会把最终目录显示出来，确认前人能看到落在哪。
		const candidates = [
			requested,
			options.botCatalog?.defaultCwd ?? process.cwd(),
			...((await options.botCatalog?.projects?.()) ?? []).map((project) => project.path),
		].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);
		for (const candidate of new Set(candidates)) {
			try {
				return await validateDeviceProject(candidate, options.dataDir);
			} catch {}
		}
		throw new DeviceWorkspaceError(
			400,
			"WORKSPACE_INVALID",
			"Pick a concrete project directory; home and volume roots cannot host a Bot",
		);
	}
	function draftDetail(message: string) {
		const flat = message.replace(/\s+/g, " ").trim();
		return flat.length > 300 ? `${flat.slice(0, 297)}...` : flat;
	}

	if (botDrafts) {
		options.app.get("/api/device-center/bot-drafts", (req: Request, res: Response) => {
			void botDrafts.list().then(
				(drafts) => res.json({ drafts }),
				(error) => {
					const failure = draftFailure(error);
					res.status(failure.status).json({ code: failure.code, error: failure.message });
				},
			);
		});
		// 一句话建 Bot：AI 只产出草案，创建仍走 approve（人按一次确认）。
		if (draftBotFromRequest)
			options.app.post("/api/device-center/bot-drafts", (req: Request, res: Response) => {
				const request =
					typeof (req.body as { request?: unknown } | undefined)?.request === "string"
						? ((req.body as { request: string }).request as string)
						: "";
				const rawCwd =
					typeof (req.body as { cwd?: unknown } | undefined)?.cwd === "string"
						? ((req.body as { cwd: string }).cwd as string)
						: undefined;
				const controller = new AbortController();
				res.once("close", () => controller.abort());
				void resolveBotProjectCwd(rawCwd)
					.then((cwd) => draftBotFromRequest(request, controller.signal, cwd))
					.then(
						(draft) => res.json({ draft }),
						(error) => {
							const failure = draftFailure(error);
							if (!res.headersSent)
								res.status(failure.status).json({
									code: failure.code,
									error: failure.message,
									detail: draftDetail(failure.message),
								});
						},
					);
			});
		options.app.post("/api/device-center/bot-drafts/:id/discard", (req: Request, res: Response) => {
			void botDrafts.discard(String(req.params.id)).then(
				() => res.json({ discarded: true }),
				(error) => {
					const failure = draftFailure(error);
					res.status(failure.status).json({
						code: failure.code,
						error: failure.message,
						detail: draftDetail(failure.message),
					});
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
				// 只校验、不落状态：upsert 失败时草案仍是 pending，用户可以直接重试或取消。
				const confirmed = await botDrafts.assertApprovable(draft.id, approved);
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
					// 模型起草 + 人工确认的工具清单：注册表据此再校验一次高权限项（不落库）。
					approvedTools: approved,
				} as LocalBotInput);
				await botDrafts.markCreated(draft.id, bot.id, approved);
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
				return { bot, synced };
			}).then(
				(data) => res.json(data),
				(error) => {
					const failure = draftFailure(error);
					res.status(failure.status).json({
						code: failure.code,
						error: failure.message,
						// 草案接口专用的可展示原因（前端只对 bot-drafts 路径读 detail）。
						detail: draftDetail(failure.message),
					});
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
		// 人在这里点'晋升'就是显式确认：未确认条目先转 confirmed 再进常驻区。
		return { entry: await memory.promote(id, { confirm: req.body?.confirm === true }) };
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
				// 导入是人的显式动作：身份盖成 human（保留原 modelRevision 供追溯），
				// 并把包里的工具全部当作已确认——否则模型起草的包会在新设备上被高权限校验拦住。
				identity: {
					authoredBy: "human",
					authoredAt: Date.now(),
					modelRevision: bundle.bot.identity?.modelRevision ?? 0,
				},
				approvedTools: tools,
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
			return { bot, synced, ...imported };
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
	// 群黑板：UI 用 PUT 保存（`GroupBlackboardView`），Hub 侧上限 512kb，代理照抄同一档。
	userRoute("get", "rooms/:id/blackboard", []);
	userRoute("put", "rooms/:id/blackboard", ["content", "expectedVersion", "title", "sections"], {
		maxBytes: 512 * 1024,
	});
	userRoute("put", "rooms/:id/blackboard/sections/:sectionId", ["content", "expectedVersion", "title"], {
		maxBytes: 512 * 1024,
	});
	userRoute("get", "rooms/:id/locks", []);
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
