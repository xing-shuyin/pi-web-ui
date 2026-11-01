import { randomBytes, randomUUID } from "node:crypto";
import { parseReportMetadata } from "./report-metadata.js";
import { integrationErrorFromCode } from "./integration-errors.js";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";

import { capabilityBase, createPortalResponse, parseDevicePath, portalHeaders, wrapperHtml } from "./path-portal.js";

export const RELAY_LIMITS = {
	frame: 128 * 1024,
	chunk: 32 * 1024,
	queue: 2 * 1024 * 1024,
	body: 64 * 1024 * 1024,
	streams: 32,
	cancellations: 16,
	devices: 128,
	sessions: 2048,
};
export type RelayFrame = { type: string; id?: string; [key: string]: unknown };
export function loopback(host: string) {
	return host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "[::1]";
}
export function checkedUrl(value: string) {
	const url = new URL(value);
	if (
		url.username ||
		url[("pass" + "word") as keyof URL] ||
		url.hash ||
		!["https:", "wss:", "http:", "ws:"].includes(url.protocol)
	)
		throw new Error("HTTP(S) or WS(S) URL required, without credentials or fragment");
	return url;
}
export function sendFrame(ws: WebSocket, frame: RelayFrame): boolean {
	const data = JSON.stringify(frame);
	if (ws.readyState !== WebSocket.OPEN) return false;
	if (
		Buffer.byteLength(data) > RELAY_LIMITS.frame ||
		ws.bufferedAmount + Buffer.byteLength(data) > RELAY_LIMITS.queue
	) {
		ws.terminate();
		return false;
	}
	ws.send(data, (error) => {
		if (error) ws.terminate();
	});
	return true;
}
export function parseFrame(data: Buffer): RelayFrame {
	if (data.length > RELAY_LIMITS.frame) throw new Error("Frame too large");
	const frame = JSON.parse(data.toString());
	if (!frame || typeof frame !== "object" || typeof frame.type !== "string") throw new Error("Invalid frame");
	return frame;
}
export function decodeChunk(value: unknown): Buffer {
	if (
		typeof value !== "string" ||
		value.length > Math.ceil(RELAY_LIMITS.chunk / 3) * 4 ||
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
	)
		throw new Error("Invalid chunk");
	return Buffer.from(value, "base64");
}
export function sendChunks(ws: WebSocket, type: string, id: string, data: Buffer, extra: Record<string, unknown> = {}) {
	for (let offset = 0; offset < data.length; offset += RELAY_LIMITS.chunk)
		if (
			!sendFrame(ws, {
				type,
				id,
				data: data.subarray(offset, offset + RELAY_LIMITS.chunk).toString("base64"),
				...extra,
			})
		)
			return false;
	return true;
}
const blocked =
	/^(host|cookie|authorization|proxy-.*|origin|referer|forwarded|x-forwarded-.*|connection|upgrade|keep-alive|transfer-encoding|te|trailer|sec-websocket-.*|set-cookie)$/i;
export function cleanHeaders(headers: Record<string, unknown>): Record<string, string> {
	const result: Record<string, string> = {};
	const connection = String(headers.connection || "")
		.toLowerCase()
		.split(",")
		.map((x) => x.trim());
	for (const [key, value] of Object.entries(headers))
		if (
			!blocked.test(key) &&
			!connection.includes(key.toLowerCase()) &&
			typeof value === "string" &&
			!/[\r\n]/.test(value)
		)
			result[key.toLowerCase()] = value;
	return result;
}
export function safePath(path: unknown, method = "GET"): path is string {
	if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || /[\r\n\\]/.test(path)) return false;
	try {
		let decoded = path.split("?")[0];
		for (let i = 0; i < 8; i++) {
			const next = decodeURIComponent(decoded);
			if (next === decoded) break;
			decoded = next;
		}
		if (/%|[\\\x00-\x20]/.test(decoded)) return false;
		const normalized = new URL(decoded, "http://local").pathname.toLowerCase();
		// OS authorization is initiated only on the device itself, never through a Hub portal.
		if (normalized === "/api/device-desktop/local" || normalized.startsWith("/api/device-desktop/local/")) return false;
		if (normalized === "/api/device-center" || normalized.startsWith("/api/device-center/")) {
			// Only account-scoped chat routes may cross a device portal.
			if (method === "GET") {
				return /^\/api\/device-center\/(chat-status|devices|bots|rooms(?:\/[^/]+(?:\/(?:events|interactions|conversations(?:\/[^/]+)?))?)?)$/.test(
					normalized,
				);
			}
			if (method === "POST")
				return /^\/api\/device-center\/rooms(?:\/[^/]+\/(messages|rename|members|clear|delete|interactions|conversations(?:\/[^/]+\/(messages|stop|deliveries|reviews))?))?$/.test(
					normalized,
				);
			return false;
		}
		return !["/devices", "/setup", "/api/setup"].some(
			(prefix) => normalized === prefix || normalized.startsWith(prefix + "/"),
		);
	} catch {
		return false;
	}
}

export const COMMANDS = [
	"transfer_stage",
	"transfer_preview",
	"transfer_apply",
	"transfer_init",
	"transfer_chunk",
	"transfer_status",
	"transfer_abort",
	"transfer_prepare_export",
	"transfer_read_chunk",
	"transfer_fence",
	"integration_prepare",
	"integration_verify",
	"integration_confirm",
	"integration_cancel",
] as const;
export type DeviceCommand = (typeof COMMANDS)[number];
const RPC_BYTES = 12 * 1024 * 1024;
/** Bounded chunked RPC, scoped to exactly one authenticated connection. */
export function createCommandChannel(
	ws: WebSocket,
	handler?: (action: DeviceCommand, payload: unknown, signal: AbortSignal) => Promise<unknown>,
) {
	const pending = new Map<
		string,
		{
			chunks: Buffer[];
			bytes: number;
			incoming: boolean;
			executing?: boolean;
			cancelling?: boolean;
			action?: DeviceCommand;
			controller: AbortController;
			timer: NodeJS.Timeout;
			resolve?: (value: unknown) => void;
			reject?: (error: Error) => void;
			detach?: () => void;
		}
	>();
	let ended = false;
	function remove(id: string, error?: Error) {
		const item = pending.get(id);
		if (!item) return;
		pending.delete(id);
		clearTimeout(item.timer);
		item.detach?.();
		item.controller.abort();
		if (error) item.reject?.(error);
	}
	function add(id: string, incoming: boolean) {
		if (ended || pending.size >= 4 || pending.has(id)) throw new Error("Command capacity exceeded");
		const timer = setTimeout(() => {
			sendFrame(ws, { type: "rpc_cancel", id });
			const err = Object.assign(new Error("Command timed out"), { stopUnconfirmed: true });
			remove(id, err);
		}, 60_000);
		timer.unref();
		const item = {
			chunks: [] as Buffer[],
			bytes: 0,
			incoming,
			controller: new AbortController(),
			timer,
		} as NonNullable<ReturnType<typeof pending.get>>;
		pending.set(id, item);
		return item;
	}
	async function transmit(id: string, type: string, value: unknown, signal: AbortSignal) {
		const json = JSON.stringify(value ?? null);
		if (json.length > RPC_BYTES) throw new Error("Command payload too large");
		const bytes = Buffer.from(json);
		if (bytes.length > RPC_BYTES) throw new Error("Command payload too large");
		for (let offset = 0; offset < bytes.length; offset += RELAY_LIMITS.chunk) {
			while (ws.bufferedAmount > RELAY_LIMITS.queue / 2) {
				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, 5);
					timer.unref();
				});
				if (signal.aborted || ended || ws.readyState !== WebSocket.OPEN) throw new Error("Command cancelled");
			}
			if (
				signal.aborted ||
				ended ||
				!sendFrame(ws, {
					type: `${type}_chunk`,
					id,
					data: bytes.subarray(offset, offset + RELAY_LIMITS.chunk).toString("base64"),
				})
			)
				throw new Error("Command cancelled");
		}
		if (!sendFrame(ws, { type: `${type}_end`, id })) throw new Error("Command disconnected");
	}
	return {
		call(action: DeviceCommand, payload: unknown, options: { signal?: AbortSignal } = {}): Promise<unknown> {
			if (!COMMANDS.includes(action)) return Promise.reject(new Error("Command forbidden"));
			if (options.signal?.aborted) return Promise.reject(new Error("Command cancelled"));
			return new Promise((resolve, reject) => {
				const id = randomUUID();
				let item: ReturnType<typeof add>;
				try {
					item = add(id, false);
				} catch (error) {
					reject(error);
					return;
				}
				item.resolve = resolve;
				item.reject = reject;
				item.action = action;
				const abort = () => {
					if (item.cancelling) return;
					item.cancelling = true;
					sendFrame(ws, { type: "rpc_cancel", id });
					clearTimeout(item.timer);
					item.timer = setTimeout(() => {
						const err = Object.assign(new Error("Command cancellation unconfirmed: timeout"), {
							stopUnconfirmed: true,
						});
						remove(id, err);
					}, 30_000);
					item.timer.unref();
				};
				options.signal?.addEventListener("abort", abort, { once: true });
				item.detach = () => options.signal?.removeEventListener("abort", abort);
				if (!sendFrame(ws, { type: "rpc_start", id, action })) {
					remove(id, new Error("Command disconnected"));
					return;
				}
				void transmit(id, "rpc_request", payload, item.controller.signal).catch((error) => {
					if (!item.cancelling) {
						sendFrame(ws, { type: "rpc_cancel", id });
						remove(id, error);
					}
				});
			});
		},
		handle(frame: RelayFrame): boolean {
			if (!frame.type.startsWith("rpc_")) return false;
			const id = frame.id;
			if (typeof id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id))
				throw new Error("Invalid command id");
			if (frame.type === "rpc_start") {
				if (!handler || !COMMANDS.includes(frame.action as DeviceCommand)) {
					sendFrame(ws, { type: "rpc_error", id });
					return true;
				}
				const item = add(id, true);
				item.action = frame.action as DeviceCommand;
				return true;
			}
			const item = pending.get(id);
			if (!item) return true;
			if (frame.type === "rpc_cancel") {
				if (item.incoming && item.executing) {
					item.controller.abort();
					return true;
				}
				remove(id, new Error("Remote command rejected"));
				return true;
			}
			if (frame.type === "rpc_cancel_ack") {
				remove(id, new Error("Remote command cancelled"));
				return true;
			}
			if (frame.type === "rpc_error") {
				const safeError = item.action?.startsWith("integration_") ? integrationErrorFromCode(frame.code) : undefined;
				remove(id, safeError ?? new Error("Remote command rejected"));
				return true;
			}
			if (item.executing) throw new Error("Command already executing");
			const prefix = item.incoming ? "rpc_request" : "rpc_response";
			if (frame.type === `${prefix}_chunk`) {
				const data = decodeChunk(frame.data);
				item.bytes += data.length;
				if (!data.length || item.bytes > RPC_BYTES || item.chunks.length >= Math.ceil(RPC_BYTES / RELAY_LIMITS.chunk))
					throw new Error("Command too large");
				item.chunks.push(data);
				return true;
			}
			if (frame.type !== `${prefix}_end`) throw new Error("Invalid command frame");
			const value = JSON.parse(Buffer.concat(item.chunks, item.bytes).toString("utf8"));
			item.chunks = [];
			item.bytes = 0;
			if (!item.incoming) {
				item.resolve?.(value);
				remove(id);
				return true;
			}
			item.executing = true;
			const run = async () => {
				let wasAborted = false;
				const onAbort = () => {
					wasAborted = true;
				};
				item.controller.signal.addEventListener("abort", onAbort, { once: true });
				try {
					const result = await handler!(item.action!, value, item.controller.signal);
					if (pending.get(id) !== item) return;
					if (wasAborted || item.controller.signal.aborted) return;
					await transmit(id, "rpc_response", result, item.controller.signal);
				} catch (error) {
					if (!wasAborted && !item.controller.signal.aborted && pending.get(id) === item) {
						const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
						const safeError = item.action?.startsWith("integration_") ? integrationErrorFromCode(code) : undefined;
						sendFrame(ws, { type: "rpc_error", id, ...(safeError ? { code } : {}) });
					}
				} finally {
					item.controller.signal.removeEventListener("abort", onAbort);
					if (wasAborted || item.controller.signal.aborted) {
						sendFrame(ws, { type: "rpc_cancel_ack", id });
					}
					remove(id);
				}
			};
			void run();
			return true;
		},
		close() {
			ended = true;
			for (const [id, item] of pending.entries()) {
				const err = Object.assign(
					new Error(
						item.cancelling
							? "Command cancellation unconfirmed: device disconnected"
							: "Device disconnected before command completed",
					),
					{ stopUnconfirmed: true },
				);
				remove(id, err);
			}
		},
	};
}

export const WS_MESSAGE_BYTES = 16 * 1024 * 1024;
/** Connection-scoped, bounded message assembly and outbound queue. */
export function createWsMessageChannel(transport: WebSocket) {
	const assemblies = new Map<
		string,
		{ messageId: string; binary: boolean; chunks: Buffer[]; bytes: number; timer: NodeJS.Timeout }
	>();
	let aggregate = 0;
	let queued = 0;
	let queuedMessages = 0;
	let ended = false;
	let tail = Promise.resolve();
	function discard(id: string) {
		const item = assemblies.get(id);
		if (item) {
			clearTimeout(item.timer);
			aggregate -= item.bytes;
			assemblies.delete(id);
		}
	}
	return {
		send(id: string, data: Buffer, binary: boolean): boolean {
			if (
				ended ||
				queuedMessages >= 128 ||
				data.length > WS_MESSAGE_BYTES ||
				queued + data.length > 2 * WS_MESSAGE_BYTES
			)
				return false;
			queuedMessages++;
			queued += Math.max(1, data.length);
			tail = tail
				.then(async () => {
					const messageId = randomUUID();
					for (let offset = 0; offset < data.length; offset += RELAY_LIMITS.chunk) {
						while (transport.bufferedAmount > RELAY_LIMITS.queue / 2) {
							await new Promise<void>((resolve) => {
								const timer = setTimeout(resolve, 5);
								timer.unref();
							});
							if (ended || transport.readyState !== WebSocket.OPEN) throw new Error("Disconnected");
						}
						if (
							ended ||
							!sendFrame(transport, {
								type: "ws_chunk",
								id,
								messageId,
								binary,
								data: data.subarray(offset, offset + RELAY_LIMITS.chunk).toString("base64"),
							})
						)
							throw new Error("Disconnected");
					}
					if (ended || !sendFrame(transport, { type: "ws_end", id, messageId, binary }))
						throw new Error("Disconnected");
				})
				.catch(() => transport.terminate())
				.finally(() => {
					queued -= Math.max(1, data.length);
					queuedMessages--;
				});
			return true;
		},
		receive(frame: RelayFrame, target: WebSocket) {
			const id = frame.id!;
			if (typeof frame.messageId !== "string" || frame.messageId.length > 64 || typeof frame.binary !== "boolean")
				throw new Error("Invalid WS message");
			let item = assemblies.get(id);
			if (!item) {
				if (assemblies.size >= RELAY_LIMITS.streams) throw new Error("Too many WS messages");
				const timer = setTimeout(() => {
					discard(id);
					target.terminate();
				}, 60_000);
				timer.unref();
				item = { messageId: frame.messageId, binary: frame.binary, chunks: [], bytes: 0, timer };
				assemblies.set(id, item);
			}
			if (item.messageId !== frame.messageId || item.binary !== frame.binary) throw new Error("Interleaved WS message");
			if (frame.type === "ws_chunk") {
				const data = decodeChunk(frame.data);
				if (
					!data.length ||
					item.bytes + data.length > WS_MESSAGE_BYTES ||
					aggregate + data.length > 2 * WS_MESSAGE_BYTES ||
					item.chunks.length >= WS_MESSAGE_BYTES / RELAY_LIMITS.chunk
				)
					throw new Error("WS assembly exceeded");
				item.chunks.push(data);
				item.bytes += data.length;
				aggregate += data.length;
				return;
			}
			if (frame.type !== "ws_end") throw new Error("Invalid WS frame");
			const data = Buffer.concat(item.chunks, item.bytes);
			discard(id);
			if (target.readyState !== WebSocket.OPEN || target.bufferedAmount + data.length > 2 * WS_MESSAGE_BYTES)
				throw new Error("WS target queue exceeded");
			target.send(data, { binary: item.binary }, (error) => {
				if (error) target.terminate();
			});
		},
		discard,
		close() {
			ended = true;
			for (const id of assemblies.keys()) discard(id);
		},
	};
}

export interface DeviceRelayOptions {
	server: Server;
	publicUrl: string;
	deviceDomain?: string;
	pathAccess?: boolean;
	deviceOrigins?: () => ReadonlyMap<string, string>;
	authenticateDevice: (deviceId: string, credential: string) => boolean | Promise<boolean>;
	getAccount: (
		req: IncomingMessage,
	) => string | { id: string } | null | undefined | Promise<string | { id: string } | null | undefined>;
	ownsDevice: (accountId: string, deviceId: string) => boolean | Promise<boolean>;
	getDeviceName?: (deviceId: string) => string | undefined;
	onTaskEvent?: (deviceId: string, event: any) => void | Promise<void>;
	onTaskProgress?: (deviceId: string, event: any) => void | Promise<void>;
	onTaskInteractions?: (deviceId: string, event: any) => void | Promise<void>;
	onTaskClaim?: (
		deviceId: string,
		claim: import("../protocol.js").DeviceTaskClaim,
	) => Promise<import("../protocol.js").DeviceTaskClaimResult> | import("../protocol.js").DeviceTaskClaimResult;
	onTaskLeaseRenew?: (
		deviceId: string,
		renew: import("../protocol.js").DeviceTaskLeaseRenew,
	) => Promise<import("../protocol.js").DeviceTaskLeaseResult> | import("../protocol.js").DeviceTaskLeaseResult;
	onTaskToolLifecycle?: (
		deviceId: string,
		lifecycle: import("../protocol.js").DeviceTaskToolLifecycleFrame,
	) => Promise<void> | void;
	onTaskPlanReady?: (
		deviceId: string,
		frame: import("../protocol.js").DeviceTaskPlanReadyFrame,
	) => Promise<boolean> | boolean;
	onTaskDisconnect?: (deviceId: string, taskId: string, attemptId: string) => void | Promise<void>;
}
export interface RelayTaskBinding {
	attemptId: string;
	botId: string;
	hasLease?: boolean;
}

export function createDeviceRelay(options: DeviceRelayOptions) {
	const hub = checkedUrl(options.publicUrl);
	const domain = options.deviceDomain?.toLowerCase();
	if (domain !== undefined) {
		if (!/^[a-z0-9.-]+(?::\d+)?$/.test(domain)) throw new Error("Invalid device domain");
		const parsed = new URL(`${hub.protocol}//${domain}`);
		if (parsed.host !== domain) throw new Error("Invalid device domain");
		const domainHost = parsed.hostname;
		if (
			hub.hostname === domainHost ||
			hub.hostname.endsWith(`.${domainHost}`) ||
			domainHost.endsWith(`.${hub.hostname}`)
		)
			throw new Error("Device domain must be independent of hub domain");
	}
	if (!["http:", "https:"].includes(hub.protocol) || hub.pathname !== "/" || hub.search)
		throw new Error("publicUrl must be an HTTP(S) root origin");
	const interactionAcks = new Map<string, { ws: WebSocket; finish: (ok: boolean) => void }>();
	const deviceGenerations = new Map<string, number>();
	const devices = new Map<
		string,
		{
			generation: number;
			ws: WebSocket;
			streams: Map<
				string,
				{
					res?: ServerResponse;
					ws?: WebSocket;
					portal?: ReturnType<typeof createPortalResponse>;
					bytes: number;
					timer: NodeJS.Timeout;
				}
			>;
			tasks: Map<string, RelayTaskBinding>;
			cancellations: Map<string, { taskId: string; attemptId: string; finish: (stopped: boolean) => void }>;
			rpc: ReturnType<typeof createCommandChannel>;
			messages: ReturnType<typeof createWsMessageChannel>;
		}
	>();
	// Slow browser responses apply transport backpressure instead of losing resource bodies.
	const stalledResponses = new WeakMap<WebSocket, Set<ServerResponse>>();
	function pauseForResponse(ws: WebSocket, res: ServerResponse) {
		let stalled = stalledResponses.get(ws);
		if (!stalled) stalledResponses.set(ws, (stalled = new Set()));
		if (stalled.has(res)) return;
		stalled.add(res);
		ws.pause();
		const resume = () => {
			res.off("drain", resume);
			res.off("close", resume);
			stalled.delete(res);
			if (!stalled.size && ws.readyState === WebSocket.OPEN) ws.resume();
		};
		res.once("drain", resume);
		res.once("close", resume);
	}
	const tickets = new Map<string, { deviceId: string; accountId: string; generation: number; expiresAt: number }>();
	const sessions = new Map<string, { deviceId: string; expiresAt: number }>();
	const capabilities = new Map<string, { deviceId: string; accountId: string; expiresAt: number }>();
	const pathRequest = (req: IncomingMessage) => {
		if (req.headers.host?.toLowerCase() !== hub.host.toLowerCase()) return null;
		const path = parseDevicePath(req.url);
		// Desktop embedding uses an opaque capability on the Hub even with legacy device origins.
		return options.pathAccess || path?.tail === "/__open" || (path?.token && capabilities.has(path.token))
			? path
			: null;
	};
	function pathAuthorized(req: IncomingMessage, id: string, websocket = false) {
		const path = pathRequest(req);
		const session = path?.token ? capabilities.get(path.token) : undefined;
		return !!(
			session &&
			session.deviceId === id &&
			session.expiresAt > Date.now() &&
			path?.path &&
			(!websocket || safePath(path.path, "WS")) &&
			(!req.headers.origin || req.headers.origin === "null") &&
			(!websocket || req.headers.origin === "null")
		);
	}
	const wss = new WebSocketServer({ noServer: true, maxPayload: RELAY_LIMITS.frame, perMessageDeflate: false });
	const browserWss = new WebSocketServer({ noServer: true, maxPayload: WS_MESSAGE_BYTES, perMessageDeflate: false });
	let closed = false;
	let revision = 0;
	let authenticating = 0;
	const alive = new WeakSet<WebSocket>();
	const origin = (id: string) =>
		options.deviceOrigins?.().get(id) ?? (domain ? `${hub.protocol}//${id}.${domain}` : undefined);
	const deviceCookie = (id: string) =>
		`${hub.protocol === "https:" ? "__Host-device" : "device"}${options.deviceOrigins?.().has(id) ? `-${new URL(origin(id)!).port}-${id}` : ""}`;
	const deviceId = (req: IncomingMessage) => {
		const path = pathRequest(req);
		if (path) return path.id;
		for (const [id, value] of options.deviceOrigins?.() ?? []) {
			if (req.headers.host?.toLowerCase() === new URL(value).host.toLowerCase()) return id;
		}
		if (!domain) return null;
		const host = req.headers.host?.toLowerCase() || "";
		const suffix = `.${domain}`;
		if (!host.endsWith(suffix)) return null;
		const id = host.slice(0, -suffix.length);
		return /^[a-z0-9][a-z0-9-]{0,62}$/.test(id) ? id : null;
	};
	function authorized(req: IncomingMessage, id: string, websocket = false) {
		const cookieName = deviceCookie(id);
		const cookie = req.headers.cookie
			?.split(";")
			.map((x) => x.trim())
			.find((x) => x.startsWith(`${cookieName}=`))
			?.slice(cookieName.length + 1);
		const session = cookie ? sessions.get(cookie) : undefined;
		if (!session || session.deviceId !== id || session.expiresAt <= Date.now()) return false;
		if (req.headers.origin && req.headers.origin !== origin(id)) return false;
		if (websocket && req.headers.origin !== origin(id)) return false;
		if (!["GET", "HEAD", "OPTIONS"].includes(req.method || "GET") && req.headers.origin !== origin(id)) return false;
		return true;
	}
	function drop(
		id: string,
		entry: typeof devices extends Map<string, infer T> ? T : never,
		optionsDrop?: { isRevoke?: boolean },
	) {
		for (const pending of interactionAcks.values()) if (pending.ws === entry.ws) pending.finish(false);
		for (const pending of entry.cancellations.values()) pending.finish(false);
		entry.rpc.close();
		entry.messages.close();
		for (const [taskId, { attemptId, botId, hasLease }] of entry.tasks) {
			if (optionsDrop?.isRevoke || !hasLease) {
				Promise.resolve()
					.then(() =>
						options.onTaskEvent?.(id, {
							taskId,
							botId,
							attemptId,
							status: "interrupted",
							report: optionsDrop?.isRevoke
								? "Device revoked; task interrupted."
								: "Device connection lost; task is not replayed",
						}),
					)
					.catch(() => {});
			} else {
				// Retain recovery grace window on Hub for tasks with active lease!
				Promise.resolve()
					.then(() => options.onTaskDisconnect?.(id, taskId, attemptId))
					.catch(() => {});
			}
		}
		entry.tasks.clear();
		for (const stream of entry.streams.values()) {
			clearTimeout(stream.timer);
			stream.res?.destroy();
			stream.ws?.terminate();
		}
		entry.streams.clear();
		if (devices.get(id) === entry) devices.delete(id);
	}
	function addStream(
		entry: typeof devices extends Map<string, infer T> ? T : never,
		id: string,
		stream: { res?: ServerResponse; ws?: WebSocket; portal?: ReturnType<typeof createPortalResponse> },
	) {
		const timer = setTimeout(() => {
			stream.res?.destroy();
			stream.ws?.terminate();
			entry.streams.delete(id);
			sendFrame(entry.ws, { type: "cancel", id });
		}, 30 * 60_000);
		timer.unref();
		const item = { ...stream, bytes: 0, timer };
		entry.streams.set(id, item);
		return item;
	}
	async function handleOpen(req: IncomingMessage, res: ServerResponse, id: string, redirect = false) {
		const generation = revision;
		const account = await options.getAccount(req);
		const accountId = typeof account === "string" ? account : account?.id;
		if (
			closed ||
			(redirect ? req.method !== "GET" : req.method !== "POST") ||
			req.headers.host !== hub.host ||
			(!redirect && req.headers.origin !== hub.origin) ||
			!accountId ||
			!(await options.ownsDevice(accountId, id))
		) {
			res.writeHead(403).end();
			return;
		}
		if (!options.pathAccess && !origin(id)) {
			res.writeHead(409, { "content-type": "application/json", "cache-control": "no-store" }).end(
				JSON.stringify({
					error: "Device web access requires an independent origin",
					code: "DEVICE_WEB_ORIGIN_REQUIRED",
				}),
			);
			return;
		}
		if (generation !== revision || closed || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(id) || !devices.has(id)) {
			res.writeHead(409).end();
			return;
		}
		if (tickets.size >= RELAY_LIMITS.sessions) {
			res.writeHead(503).end();
			return;
		}
		const ticket = randomBytes(32).toString("hex");
		const expiresAt = Date.now() + 30_000;
		tickets.set(ticket, { deviceId: id, accountId, generation, expiresAt });
		const url = options.pathAccess
			? `${hub.origin}/device/${id}/__open?ticket=${ticket}`
			: `${origin(id)}/__device/open?ticket=${ticket}`;
		if (redirect)
			res.writeHead(302, { location: url, "cache-control": "no-store", "referrer-policy": "no-referrer" }).end();
		else
			res
				.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
				.end(JSON.stringify({ url, expiresAt }));
	}
	function sendWrapper(res: ServerResponse, id: string, accountId: string, initialPath = "") {
		if (closed || !devices.has(id)) {
			res.writeHead(503).end();
			return;
		}
		if (capabilities.size >= RELAY_LIMITS.sessions) {
			res.writeHead(503).end();
			return;
		}
		const token = randomBytes(32).toString("hex");
		capabilities.set(token, { deviceId: id, accountId, expiresAt: Date.now() + 8 * 60 * 60_000 });
		const name = options.getDeviceName?.(id)?.trim();
		const label = name && name !== id ? `${name} (${id})` : id;
		const wrapper = wrapperHtml(
			capabilityBase(id, token),
			initialPath,
			initialPath === "desktop" ? hub : undefined,
			label,
		);
		res
			.writeHead(200, {
				"content-type": "text/html; charset=utf-8",
				"content-security-policy": wrapper.csp,
				"cache-control": "no-store",
				"referrer-policy": "no-referrer",
				"x-content-type-options": "nosniff",
			})
			.end(wrapper.html);
	}
	async function accountWrapper(req: IncomingMessage, res: ServerResponse, id: string) {
		const generation = revision;
		try {
			if (
				req.headers.origin === "null" ||
				req.headers["sec-fetch-dest"] === "iframe" ||
				(req.headers.origin && req.headers.origin !== hub.origin)
			) {
				res.writeHead(401).end();
				return;
			}
			const account = await options.getAccount(req);
			const accountId = typeof account === "string" ? account : account?.id;
			if (!accountId || !(await options.ownsDevice(accountId, id))) {
				res.writeHead(401).end();
				return;
			}
			if (generation !== revision || closed || res.destroyed) {
				res.writeHead(403).end();
				return;
			}
			sendWrapper(res, id, accountId);
		} catch {
			if (!res.headersSent) res.writeHead(401).end();
			else res.destroy();
		}
	}
	function handleRequest(req: IncomingMessage, res: ServerResponse): boolean {
		const id = deviceId(req);
		if (!id) {
			if (domain && req.headers.host?.toLowerCase().endsWith(`.${domain}`)) {
				res.writeHead(403).end();
				return true;
			}
			return false;
		}
		res.setHeader("Cache-Control", "no-store");
		res.setHeader("Referrer-Policy", "no-referrer");
		const path = pathRequest(req);
		const url = new URL(req.url || "/", path ? hub.origin : origin(id)!);
		if (path && !path.token && path.tail !== "/__open") {
			if (path.tail !== "/" || req.method !== "GET") res.writeHead(404).end();
			else void accountWrapper(req, res, id);
			return true;
		}
		if ((path && path.tail === "/__open") || (!path && url.pathname === "/__device/open")) {
			const key = url.searchParams.get("ticket") || "";
			const ticket = tickets.get(key);
			if (
				req.method !== "GET" ||
				!ticket ||
				ticket.deviceId !== id ||
				ticket.generation !== revision ||
				ticket.expiresAt <= Date.now() ||
				!devices.has(id) ||
				sessions.size >= RELAY_LIMITS.sessions
			) {
				res.writeHead(403).end();
				return true;
			}
			tickets.delete(key);
			if (url.searchParams.get("next") === "/desktop" && !path) {
				// Exchange the one-use legacy ticket for a fresh one on the Hub origin.
				const desktopTicket = randomBytes(32).toString("hex");
				tickets.set(desktopTicket, ticket);
				res
					.writeHead(302, {
						location: `${hub.origin}/device/${id}/__open?ticket=${desktopTicket}&next=/desktop`,
						"cache-control": "no-store",
						"referrer-policy": "no-referrer",
					})
					.end();
				return true;
			}
			if (path) {
				sendWrapper(res, id, ticket.accountId, url.searchParams.get("next") === "/desktop" ? "desktop" : "");
				return true;
			}
			const token = randomBytes(32).toString("hex");
			sessions.set(token, { deviceId: id, expiresAt: Date.now() + 15 * 60_000 });
			res
				.writeHead(302, {
					"set-cookie": `${deviceCookie(id)}=${token}; Path=/; Max-Age=900;${hub.protocol === "https:" ? " Secure;" : ""} HttpOnly; SameSite=Lax`,
					location: url.searchParams.get("next") === "/desktop" ? "/desktop" : "/",
				})
				.end();
			return true;
		}
		if (!(path ? pathAuthorized(req, id) : authorized(req, id))) {
			res.writeHead(403).end();
			return true;
		}
		if (path && req.method === "OPTIONS") {
			res.writeHead(204, portalHeaders(hub, capabilityBase(id, path.token!))).end();
			return true;
		}
		// Only authenticated capability requests receive opaque-origin response headers.
		if (path) {
			for (const [key, value] of Object.entries(portalHeaders(hub, capabilityBase(id, path.token!))))
				res.setHeader(key, value);
		}
		const forwardPath = path ? path.path! : req.url;
		// Serve account binding at the Hub, including compatibility for older device UIs.
		// Never forward the local management status endpoint or expose its settings.
		if (
			path &&
			req.method === "GET" &&
			["/api/device-center/chat-status", "/api/device-center/status"].includes(forwardPath?.split("?")[0] ?? "")
		) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ hubUrl: hub.origin, deviceId: id }));
			return true;
		}
		const entry = devices.get(id);
		if (!entry || entry.streams.size >= RELAY_LIMITS.streams) {
			res.writeHead(503).end();
			return true;
		}
		if (!safePath(forwardPath, req.method)) {
			res.writeHead(400).end();
			return true;
		}
		// Only entry documents are rewritten; preserve negotiated compression for assets.
		const rewriteHtml = !!path && ["/", "/desktop"].includes(path.path!.split("?")[0]);
		const streamId = randomBytes(12).toString("hex");
		addStream(entry, streamId, {
			res,
			...(path
				? {
						portal: createPortalResponse(res, hub, capabilityBase(id, path.token!), rewriteHtml),
					}
				: {}),
		});
		let bytes = 0;
		sendFrame(entry.ws, {
			type: "request",
			id: streamId,
			method: req.method,
			path: forwardPath,
			headers: { ...cleanHeaders(req.headers), ...(rewriteHtml ? { "accept-encoding": "identity" } : {}) },
		});
		req.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > RELAY_LIMITS.body || !sendChunks(entry.ws, "request_body", streamId, chunk)) {
				sendFrame(entry.ws, { type: "cancel", id: streamId });
				req.destroy();
			}
		});
		req.on("end", () => sendFrame(entry.ws, { type: "request_end", id: streamId }));
		res.on("close", () => {
			const item = entry.streams.get(streamId);
			if (item) {
				clearTimeout(item.timer);
				entry.streams.delete(streamId);
				sendFrame(entry.ws, { type: "cancel", id: streamId });
			}
		});
		req.on("error", () => res.destroy());
		req.on("aborted", () => res.destroy());
		return true;
	}
	async function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
		const id = deviceId(req);
		if (!id && domain && req.headers.host?.toLowerCase().endsWith(`.${domain}`)) {
			socket.destroy();
			return;
		}
		if (id) {
			const path = pathRequest(req);
			const entry = devices.get(id);
			if (
				!entry ||
				!(path ? pathAuthorized(req, id, true) : authorized(req, id, true)) ||
				entry.streams.size >= RELAY_LIMITS.streams ||
				!safePath(path ? path.path : req.url, "WS")
			) {
				socket.destroy();
				return;
			}
			browserWss.handleUpgrade(req, socket, head, (ws) => {
				const streamId = randomBytes(12).toString("hex");
				addStream(entry, streamId, { ws });
				ws.pause();
				sendFrame(entry.ws, {
					type: "ws_open",
					id: streamId,
					path: path ? path.path : req.url,
					headers: cleanHeaders(req.headers),
					protocols: req.headers["sec-websocket-protocol"],
				});
				ws.on("message", (data, binary) => {
					const buffer = Buffer.from(data as Buffer);
					if (!entry.messages.send(streamId, buffer, binary)) ws.terminate();
				});
				ws.on("close", () => {
					const item = entry.streams.get(streamId);
					if (item) {
						clearTimeout(item.timer);
						entry.messages.discard(streamId);
						entry.streams.delete(streamId);
						sendFrame(entry.ws, { type: "ws_close", id: streamId });
					}
				});
				ws.on("error", () => ws.terminate());
			});
			return;
		}
		let url: URL;
		try {
			url = new URL(req.url || "/", hub);
		} catch {
			socket.destroy();
			return;
		}
		if (url.pathname !== "/device-connect") return;
		const device = url.searchParams.get("deviceId") || "";
		const credential = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
		if (authenticating >= RELAY_LIMITS.devices) {
			socket.destroy();
			return;
		}
		authenticating++;
		const generation = revision;
		try {
			if (
				closed ||
				req.headers.host !== hub.host ||
				req.headers.origin ||
				!/^[a-z0-9][a-z0-9-]{0,62}$/.test(device) ||
				!credential ||
				credential.length > 4096 ||
				!(await options.authenticateDevice(device, credential)) ||
				(devices.size >= RELAY_LIMITS.devices && !devices.has(device)) ||
				socket.destroyed ||
				generation !== revision ||
				closed
			) {
				socket.destroy();
				return;
			}
			wss.handleUpgrade(req, socket, head, (ws) => {
				const old = devices.get(device);
				if (old) {
					drop(device, old);
					old.ws.terminate();
				}
				const gen = (deviceGenerations.get(device) ?? 0) + 1;
				deviceGenerations.set(device, gen);
				const entry = {
					generation: gen,
					ws,
					streams: new Map(),
					tasks: new Map<string, RelayTaskBinding>(),
					cancellations: new Map<string, { taskId: string; attemptId: string; finish: (stopped: boolean) => void }>(),
					rpc: createCommandChannel(ws),
					messages: createWsMessageChannel(ws),
				};
				devices.set(device, entry);
				alive.add(ws);
				ws.on("pong", () => alive.add(ws));
				ws.on("message", (raw) => {
					try {
						if (devices.get(device) !== entry) return;
						const frame = parseFrame(Buffer.from(raw as Buffer));
						if (entry.rpc.handle(frame)) return;
						if (frame.type === "task_cancelled") {
							const pending = typeof frame.id === "string" ? entry.cancellations.get(frame.id) : undefined;
							if (!pending) return;
							if (
								pending.taskId !== frame.taskId ||
								pending.attemptId !== frame.attemptId ||
								typeof frame.stopped !== "boolean"
							)
								throw new Error("Invalid task cancellation acknowledgement");
							pending.finish(frame.stopped);
							return;
						}
						if (frame.type === "task_interaction_result") {
							const pending = typeof frame.id === "string" ? interactionAcks.get(frame.id) : undefined;
							if (pending?.ws === ws) pending.finish(frame.accepted === true);
							return;
						}
						if (frame.type === "task_interactions") {
							if (typeof frame.taskId !== "string") return;
							const task = entry.tasks.get(frame.taskId);
							if (!task || task.attemptId !== frame.attemptId || task.botId !== frame.botId) return;
							Promise.resolve()
								.then(() => options.onTaskInteractions?.(device, frame))
								.catch(() => {});
							return;
						}
						if (frame.type === "task_tool_lifecycle") {
							if (typeof frame.taskId !== "string") return;
							const task = entry.tasks.get(frame.taskId);
							if (!task || task.attemptId !== frame.attemptId || task.botId !== frame.botId) return;
							Promise.resolve()
								.then(() =>
									options.onTaskToolLifecycle?.(
										device,
										frame as unknown as import("../protocol.js").DeviceTaskToolLifecycleFrame,
									),
								)
								.catch(() => {});
							return;
						}
						if (frame.type === "task_plan_ready") {
							if (typeof frame.taskId !== "string") return;
							const task = entry.tasks.get(frame.taskId);
							const authorized = task && task.attemptId === frame.attemptId && task.botId === frame.botId;
							Promise.resolve()
								.then(() =>
									authorized
										? options.onTaskPlanReady?.(
												device,
												frame as unknown as import("../protocol.js").DeviceTaskPlanReadyFrame,
											)
										: false,
								)
								.catch(() => false)
								.then((accepted) => {
									if (ws.readyState === WebSocket.OPEN)
										sendFrame(ws, {
											type: "task_plan_ack",
											taskId: frame.taskId,
											botId: frame.botId,
											attemptId: frame.attemptId,
											accepted: accepted === true,
										});
								});
							return;
						}
						if (frame.type === "task_progress") {
							if (typeof frame.taskId !== "string") return;
							const task = entry.tasks.get(frame.taskId);
							if (!task || task.attemptId !== frame.attemptId || task.botId !== frame.botId) return;
							Promise.resolve()
								.then(() => options.onTaskProgress?.(device, frame))
								.catch(() => {});
							return;
						}
						if (frame.type === "task_event") {
							const taskId = frame.taskId;
							const botId = frame.botId;
							const attemptId = frame.attemptId;
							if (
								typeof taskId !== "string" ||
								typeof botId !== "string" ||
								typeof attemptId !== "string" ||
								!["running", "completed", "failed", "interrupted"].includes(String(frame.status))
							)
								throw new Error("Unknown task");
							if (frame.reportMetadata !== undefined) frame.reportMetadata = parseReportMetadata(frame.reportMetadata);
							const current = entry.tasks.get(taskId);
							if (current && (current.attemptId !== attemptId || current.botId !== botId))
								throw new Error("Unknown task");
							Promise.resolve()
								.then(() => options.onTaskEvent?.(device, frame))
								.then(() => {
									if (devices.get(device) === entry) {
										const postCheck = entry.tasks.get(taskId);
										if (postCheck && postCheck.attemptId === attemptId && postCheck.botId === botId) {
											if (frame.status === "completed" || frame.status === "failed" || frame.status === "interrupted") {
												entry.tasks.delete(taskId);
											}
										}
										if (frame.status === "completed" || frame.status === "failed" || frame.status === "interrupted") {
											sendFrame(ws, {
												type: "task_result_ack",
												taskId: frame.taskId,
												attemptId: frame.attemptId,
												status: frame.status,
												...(typeof frame.fingerprint === "string" ? { fingerprint: frame.fingerprint } : {}),
											});
										}
									}
								})
								.catch(() => ws.terminate());
							return;
						}
						// === Task Recovery / Reconnect Claim / Lease Renewal ===
						if (frame.type === "task_claim") {
							const rawClaim = (frame as { claim?: unknown }).claim ?? frame;
							if (
								!rawClaim ||
								typeof rawClaim !== "object" ||
								typeof (rawClaim as Record<string, unknown>).taskId !== "string" ||
								((rawClaim as Record<string, unknown>).taskId as string).length > 128 ||
								typeof (rawClaim as Record<string, unknown>).attemptId !== "string" ||
								((rawClaim as Record<string, unknown>).attemptId as string).length > 128 ||
								typeof (rawClaim as Record<string, unknown>).botId !== "string" ||
								((rawClaim as Record<string, unknown>).botId as string).length > 128
							)
								return;
							const claim = rawClaim as import("../protocol.js").DeviceTaskClaim;
							Promise.resolve()
								.then(() => options.onTaskClaim?.(device, claim))
								.then((result) => {
									if (devices.get(device) !== entry) return;
									const accepted = result?.accepted === true;
									if (accepted) {
										entry.tasks.set(claim.taskId, {
											attemptId: claim.attemptId,
											botId: claim.botId,
											hasLease: true,
										});
									}
									sendFrame(ws, {
										type: "task_claim_result",
										taskId: claim.taskId,
										attemptId: claim.attemptId,
										accepted,
										reason: result?.reason,
									});
								})
								.catch(() => {
									if (devices.get(device) === entry) {
										sendFrame(ws, {
											type: "task_claim_result",
											taskId: claim.taskId,
											attemptId: claim.attemptId,
											accepted: false,
											reason: "Claim rejected",
										});
									}
								});
							return;
						}
						if (frame.type === "task_lease_renew") {
							const rawRenew = (frame as { renew?: unknown }).renew;
							if (
								!rawRenew ||
								typeof rawRenew !== "object" ||
								typeof (rawRenew as Record<string, unknown>).taskId !== "string" ||
								((rawRenew as Record<string, unknown>).taskId as string).length > 128 ||
								typeof (rawRenew as Record<string, unknown>).attemptId !== "string" ||
								((rawRenew as Record<string, unknown>).attemptId as string).length > 128
							)
								return;
							const renew = rawRenew as import("../protocol.js").DeviceTaskLeaseRenew;
							Promise.resolve()
								.then(() => options.onTaskLeaseRenew?.(device, renew))
								.then((result) => {
									if (devices.get(device) !== entry) return;
									sendFrame(ws, {
										type: "task_lease_result",
										taskId: renew.taskId,
										attemptId: renew.attemptId,
										accepted: result?.accepted === true,
										reason: result?.reason,
									});
								})
								.catch(() => {});
							return;
						}
						// ========================================================
						const item = entry.streams.get(frame.id);
						if (!item) return;
						if (frame.type === "response") {
							const status = Number(frame.status);
							if (!Number.isInteger(status) || status < 200 || status > 599 || !item.res || item.res.headersSent)
								throw new Error("Invalid response");
							const headers = cleanHeaders((frame.headers || {}) as Record<string, unknown>);
							if (item.portal) item.portal.start(status, headers);
							else {
								item.res.writeHead(status, headers);
								item.res.flushHeaders();
							}
						} else if (frame.type === "response_body") {
							const data = decodeChunk(frame.data);
							item.bytes += data.length;
							if (item.bytes <= RELAY_LIMITS.body) {
								if (item.portal) item.portal.write(data);
								else if (item.res?.headersSent) item.res.write(data);
							}
							if (item.bytes > RELAY_LIMITS.body || (!item.portal && !item.res?.headersSent)) {
								item.res?.destroy();
								sendFrame(ws, { type: "cancel", id: frame.id });
							} else if (item.res && item.res.writableLength > RELAY_LIMITS.queue / 2) {
								pauseForResponse(ws, item.res);
							}
						} else if (frame.type === "response_end" || frame.type === "error") {
							if (frame.type === "error") item.res?.destroy();
							else if (item.portal) item.portal.end();
							else item.res?.end();
							item.ws?.terminate();
							clearTimeout(item.timer);
							entry.streams.delete(frame.id);
						} else if (frame.type === "ws_ready") {
							item.ws?.resume();
						} else if (frame.type === "ws_chunk" || frame.type === "ws_end") {
							if (!item.ws) throw new Error("Missing WS stream");
							entry.messages.receive(frame, item.ws);
						} else if (frame.type === "ws_close") item.ws?.close();
					} catch {
						ws.terminate();
					}
				});
				ws.on("close", () => drop(device, entry));
				ws.on("error", () => ws.terminate());
			});
		} catch {
			socket.destroy();
		} finally {
			authenticating--;
		}
	}
	const upgradeListener = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
		void upgrade(req, socket, head);
	};
	options.server.on("upgrade", upgradeListener);
	const heartbeat = setInterval(() => {
		const now = Date.now();
		for (const map of [tickets, sessions, capabilities])
			for (const [key, value] of map) if (value.expiresAt <= now) map.delete(key);
		for (const entry of devices.values()) {
			if (!alive.has(entry.ws)) {
				entry.ws.terminate();
				continue;
			}
			alive.delete(entry.ws);
			entry.ws.ping();
		}
	}, 15_000);
	heartbeat.unref();
	return {
		async answerInteraction(deviceId: string, answer: import("../protocol.js").DeviceTaskInteractionAnswer) {
			const entry = devices.get(deviceId);
			if (
				!entry ||
				entry.ws.readyState !== WebSocket.OPEN ||
				entry.tasks.get(answer.taskId)?.attemptId !== answer.attemptId
			)
				return false;
			if (interactionAcks.size >= 128) return false;
			const id = randomUUID();
			return new Promise<boolean>((resolve) => {
				const finish = (ok: boolean) => {
					if (!interactionAcks.delete(id)) return;
					clearTimeout(timer);
					resolve(ok);
				};
				const timer = setTimeout(() => finish(false), 5000);
				timer.unref();
				interactionAcks.set(id, { ws: entry.ws, finish });
				if (!sendFrame(entry.ws, { type: "task_interaction_answer", id, answer })) finish(false);
			});
		},
		cancelTask(deviceId: string, taskId: string, attemptId: string): Promise<{ stopped: boolean }> {
			const entry = devices.get(deviceId);
			if (
				!entry ||
				entry.ws.readyState !== WebSocket.OPEN ||
				entry.tasks.get(taskId)?.attemptId !== attemptId ||
				entry.cancellations.size >= RELAY_LIMITS.cancellations
			)
				return Promise.resolve({ stopped: false });
			const id = randomUUID();
			return new Promise((resolve) => {
				const finish = (stopped: boolean) => {
					if (!entry.cancellations.delete(id)) return;
					clearTimeout(timer);
					if (stopped && entry.tasks.get(taskId)?.attemptId === attemptId) entry.tasks.delete(taskId);
					resolve({ stopped });
				};
				const timer = setTimeout(() => finish(false), 10_000);
				timer.unref();
				entry.cancellations.set(id, { taskId, attemptId, finish });
				if (!sendFrame(entry.ws, { type: "task_cancel", id, taskId, attemptId })) finish(false);
			});
		},
		callDevice(id: string, action: DeviceCommand, payload: unknown, options?: { signal?: AbortSignal }) {
			const entry = devices.get(id);
			return entry ? entry.rpc.call(action, payload, options) : Promise.reject(new Error("Device offline"));
		},
		handleRequest,
		handleOpen,
		handleAliasOpen: (req: IncomingMessage, res: ServerResponse, id: string) => handleOpen(req, res, id, true),
		handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => {
			if (!deviceId(req)) {
				socket.destroy();
				return;
			}
			void upgrade(req, socket, head);
		},
		isDeviceRequest: (req: IncomingMessage) =>
			!!deviceId(req) || !!(domain && req.headers.host?.toLowerCase().endsWith(`.${domain}`)),
		isOnline: (id: string) => devices.get(id)?.ws.readyState === WebSocket.OPEN,
		getDeviceGeneration: (id: string) => devices.get(id)?.generation,
		sendTask(id: string, task: any) {
			const entry = devices.get(id);
			if (
				!entry ||
				typeof task?.id !== "string" ||
				typeof task.attemptId !== "string" ||
				typeof task.botId !== "string" ||
				!task.botId ||
				task.deviceId !== id ||
				!Number.isSafeInteger(task.botRevision) ||
				task.botRevision < 1 ||
				entry.tasks.has(task.id) ||
				entry.tasks.size >= RELAY_LIMITS.streams
			)
				return false;
			entry.tasks.set(task.id, {
				attemptId: task.attemptId,
				botId: task.botId,
				hasLease: typeof task.leaseToken === "string" && !!task.leaseToken,
			});
			if (!sendFrame(entry.ws, { type: "task", task })) {
				entry.tasks.delete(task.id);
				return false;
			}
			return true;
		},
		revoke(id: string) {
			revision++;
			for (const map of [tickets, sessions, capabilities])
				for (const [key, value] of map) if (value.deviceId === id) map.delete(key);
			const entry = devices.get(id);
			if (entry) {
				drop(id, entry, { isRevoke: true });
				entry.ws.terminate();
			}
		},
		close() {
			closed = true;
			clearInterval(heartbeat);
			options.server.off("upgrade", upgradeListener);
			for (const [id, entry] of devices) {
				drop(id, entry);
				entry.ws.terminate();
			}
			tickets.clear();
			sessions.clear();
			capabilities.clear();
			wss.close();
			browserWss.close();
		},
	};
}
export type DeviceRelay = ReturnType<typeof createDeviceRelay>;
