import { randomBytes, constants } from "node:crypto";
import http, { type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import https from "node:https";
import { isIPv4, type Socket } from "node:net";
import { networkInterfaces } from "node:os";
import type { TLSSocket } from "node:tls";
import { Transform } from "node:stream";
import { cleanHeaders, safePath, RELAY_LIMITS, WS_MESSAGE_BYTES } from "./relay.js";
import { WebSocket, WebSocketServer, type RawData } from "ws";

export type DeviceLanGrant = {
	addresses: string[];
	port: number;
	identity: string;
	key: string;
	expiresAt: number;
};
export type DeviceLanConnection = { origin: string; agent: https.Agent; close(): void };

type Options = {
	localOrigin: string;
	localAuthToken?: string;
	addresses?: () => string[];
	enabled?: () => boolean | Promise<boolean>;
};
const CIPHER = "PSK-AES128-GCM-SHA256";
const TTL = 30 * 60_000;
const INPUT = 16 * 1024;
const OUTPUT = 4 * 1024 * 1024;
const STATUS = "/api/health";
const TLS_OPTIONS = {
	minVersion: "TLSv1.2" as const,
	maxVersion: "TLSv1.2" as const,
	ciphers: CIPHER,
	secureOptions: constants.SSL_OP_NO_TICKET,
};

function privateAddress(address: unknown, allowLoopback = false): address is string {
	if (typeof address !== "string" || !isIPv4(address)) return false;
	const [a, b] = address.split(".").map(Number);
	return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (allowLoopback && a === 127);
}
function addresses() {
	return [
		...new Set(
			Object.values(networkInterfaces()).flatMap((entries) =>
				(entries ?? [])
					.filter((entry) => !entry.internal && privateAddress(entry.address))
					.map((entry) => entry.address),
			),
		),
	].slice(0, 16);
}
function validGrant(value: unknown, allowLoopback: boolean): value is DeviceLanGrant {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const g = value as DeviceLanGrant;
	return (
		Object.keys(g).length === 5 &&
		Array.isArray(g.addresses) &&
		g.addresses.length > 0 &&
		g.addresses.length <= 16 &&
		g.addresses.every((a) => privateAddress(a, allowLoopback)) &&
		new Set(g.addresses).size === g.addresses.length &&
		Number.isInteger(g.port) &&
		g.port > 0 &&
		g.port <= 65535 &&
		typeof g.identity === "string" &&
		/^[A-Za-z0-9_-]{22,64}$/.test(g.identity) &&
		typeof g.key === "string" &&
		/^[A-Za-z0-9_-]{43}$/.test(g.key) &&
		Buffer.from(g.key, "base64url").toString("base64url") === g.key &&
		Number.isSafeInteger(g.expiresAt) &&
		g.expiresAt > Date.now() &&
		g.expiresAt <= Date.now() + TTL
	);
}
function httpPath(req: IncomingMessage) {
	return safePath(req.url, req.method);
}
function wsPath(req: IncomingMessage) {
	return req.method === "GET" && safePath(req.url, "GET");
}
function bodyLimit(limit: number) {
	let bytes = 0;
	return new Transform({
		highWaterMark: RELAY_LIMITS.chunk,
		transform(chunk: Buffer, _encoding, callback) {
			bytes += chunk.length;
			if (bytes > limit) callback(new Error("LAN body limit exceeded"));
			else callback(null, chunk);
		},
	});
}
function byteLength(data: RawData) {
	return Array.isArray(data) ? data.reduce((n, chunk) => n + chunk.length, 0) : data.byteLength;
}

export function createDeviceLanServer(options: Options): {
	issueGrant(): Promise<DeviceLanGrant | null>;
	revoke(identity: string): void;
	close(): void;
} {
	const local = new URL(options.localOrigin);
	if (
		!["http:", "https:"].includes(local.protocol) ||
		!["localhost", "127.0.0.1", "[::1]"].includes(local.hostname) ||
		local.username ||
		local.password ||
		local.pathname !== "/" ||
		local.search ||
		local.hash
	) {
		throw new Error("Device LAN requires a fixed loopback origin");
	}
	const hostname = local.hostname === "[::1]" ? "::1" : "127.0.0.1";
	if (options.localAuthToken && /[\r\n]/.test(options.localAuthToken)) throw new Error("Invalid local token");
	const headers = (incoming: IncomingHttpHeaders = {}): Record<string, string> => ({
		...cleanHeaders(incoming),
		host: local.host,
		origin: local.origin,
		...(options.localAuthToken ? { authorization: `Bearer ${options.localAuthToken}` } : {}),
	});
	const localRequest = local.protocol === "https:" ? https.request : http.request;
	type Entry = { grant: DeviceLanGrant; key: Buffer; sockets: Set<TLSSocket> };
	type State = {
		server: https.Server;
		wss: WebSocketServer;
		desktopWss: WebSocketServer;
		grants: Map<string, Entry>;
		authenticated: WeakMap<TLSSocket, Entry>;
		sockets: Set<Socket>;
		tasks: Set<() => void>;
		ready: Promise<boolean>;
		timer?: ReturnType<typeof setTimeout>;
	};
	let state: State | undefined;
	let generation = 0;
	const checking = new Set<() => void>();

	function revoke(s: State, entry: Entry) {
		s.grants.delete(entry.grant.identity);
		entry.key.fill(0);
		for (const socket of entry.sockets) socket.destroy();
	}
	function schedule(s: State) {
		clearTimeout(s.timer);
		for (const entry of s.grants.values()) if (entry.grant.expiresAt <= Date.now()) revoke(s, entry);
		if (!s.grants.size) return;
		const next = Math.min(...[...s.grants.values()].map((e) => e.grant.expiresAt));
		s.timer = setTimeout(() => schedule(s), Math.max(1, next - Date.now()));
		s.timer.unref();
	}
	function authorized(s: State, req: IncomingMessage) {
		const entry = s.authenticated.get(req.socket as TLSSocket);
		return state === s && entry && s.grants.get(entry.grant.identity) === entry && entry.grant.expiresAt > Date.now();
	}
	function start(): State {
		const s: State = {
			server: undefined as unknown as https.Server,
			wss: new WebSocketServer({ noServer: true, maxPayload: WS_MESSAGE_BYTES, perMessageDeflate: false }),
			desktopWss: new WebSocketServer({ noServer: true, maxPayload: INPUT, perMessageDeflate: false }),
			grants: new Map(),
			authenticated: new WeakMap(),
			sockets: new Set(),
			tasks: new Set(),
			ready: Promise.resolve(false),
		};
		s.server = https.createServer(
			{
				...TLS_OPTIONS,
				handshakeTimeout: 3000,
				maxHeaderSize: INPUT,
				pskCallback(socket, identity) {
					const entry = s.grants.get(identity);
					if (!entry || entry.grant.expiresAt <= Date.now() || state !== s) return null;
					s.authenticated.set(socket, entry);
					entry.sockets.add(socket);
					socket.once("close", () => entry.sockets.delete(socket));
					return entry.key;
				},
			},
			(req, res) => {
				res.setHeader("Cache-Control", "no-store");
				if (!authorized(s, req) || !httpPath(req)) {
					res.writeHead(403).end();
					req.resume();
					return;
				}
				const desktop = req.url?.startsWith("/api/device-desktop/");
				const limit = desktop ? INPUT : RELAY_LIMITS.body;
				if (s.tasks.size >= RELAY_LIMITS.streams || Number(req.headers["content-length"] ?? 0) > limit) {
					res.setHeader("Connection", "close");
					res.writeHead(s.tasks.size >= RELAY_LIMITS.streams ? 503 : 413).end();
					req.resume();
					return;
				}
				const input = bodyLimit(limit);
				const output = bodyLimit(RELAY_LIMITS.body);
				let stopped = false;
				const timer = setTimeout(() => cleanup(), 60_000);
				const upstream = localRequest(
					{
						protocol: local.protocol,
						hostname,
						port: local.port || undefined,
						method: req.method,
						path: req.url,
						agent: false,
						headers: headers(req.headers),
					},
					(reply) => {
						reply.on("error", () => cleanup());
						res.writeHead(reply.statusCode ?? 502, cleanHeaders(reply.headers));
						reply.pipe(output).pipe(res);
					},
				);
				const cleanup = () => {
					if (stopped) return;
					stopped = true;
					clearTimeout(timer);
					s.tasks.delete(cleanup);
					req.unpipe(input);
					input.destroy();
					output.destroy();
					upstream.destroy();
					if (!res.writableEnded) res.destroy();
				};
				s.tasks.add(cleanup);
				res.once("close", cleanup);
				req.on("error", cleanup);
				input.on("error", () => {
					if (!res.headersSent) res.writeHead(413, { Connection: "close" }).end();
					cleanup();
				});
				output.on("error", cleanup);
				upstream.on("error", () => {
					if (!res.headersSent) res.writeHead(502).end();
					cleanup();
				});
				req.pipe(input).pipe(upstream);
			},
		);
		s.server.requestTimeout = 60_000;
		s.server.headersTimeout = 5000;
		s.server.keepAliveTimeout = 5000;
		s.server.maxConnections = 64;
		s.server.on("connection", (socket) => {
			s.sockets.add(socket);
			socket.once("close", () => s.sockets.delete(socket));
		});
		s.server.on("tlsClientError", (_error, socket) => socket.destroy());
		s.server.on("secureConnection", (socket) => {
			if (!s.authenticated.has(socket) || socket.getCipher().name !== CIPHER) socket.destroy();
		});
		s.server.on("upgrade", (req, socket, head) => {
			if (!authorized(s, req) || !wsPath(req) || s.tasks.size >= RELAY_LIMITS.streams) {
				socket.destroy();
				return;
			}
			const target = new URL(req.url!, local);
			const desktop = target.pathname === "/desktop-ws";
			if (target.hash || (desktop && s.desktopWss.clients.size >= 4)) {
				socket.destroy();
				return;
			}
			target.protocol = local.protocol === "https:" ? "wss:" : "ws:";
			target.hostname = hostname === "::1" ? "[::1]" : hostname;
			(desktop ? s.desktopWss : s.wss).handleUpgrade(req, socket, head, (ws) => {
				const inputLimit = desktop ? INPUT : WS_MESSAGE_BYTES;
				const outputLimit = desktop ? OUTPUT : WS_MESSAGE_BYTES;
				const upstream = new WebSocket(target, {
					headers: headers(req.headers),
					maxPayload: outputLimit,
					perMessageDeflate: false,
					handshakeTimeout: 5000,
				});
				let stopped = false;
				let pendingBytes = 0;
				const pending: { data: RawData; binary: boolean }[] = [];
				const cleanup = () => {
					if (stopped) return;
					stopped = true;
					pending.length = 0;
					s.tasks.delete(cleanup);
					ws.terminate();
					upstream.terminate();
				};
				const send = (to: WebSocket, data: RawData, binary: boolean, limit: number) => {
					if (to.readyState !== WebSocket.OPEN || to.bufferedAmount + byteLength(data) > limit) return cleanup();
					to.send(data, { binary }, (error) => {
						if (error) cleanup();
					});
				};
				s.tasks.add(cleanup);
				ws.on("error", cleanup);
				upstream.on("error", cleanup);
				ws.on("close", cleanup);
				upstream.on("close", cleanup);
				ws.on("message", (data, binary) => {
					if (byteLength(data) > inputLimit) return cleanup();
					if (upstream.readyState === WebSocket.CONNECTING) {
						pendingBytes += byteLength(data);
						if (pendingBytes > inputLimit || pending.length >= 128) return cleanup();
						pending.push({ data, binary });
					} else send(upstream, data, binary, desktop ? INPUT : 2 * WS_MESSAGE_BYTES);
				});
				upstream.on("open", () => {
					for (const { data, binary } of pending) send(upstream, data, binary, desktop ? INPUT : 2 * WS_MESSAGE_BYTES);
					pending.length = 0;
					pendingBytes = 0;
				});
				upstream.on("message", (data, binary) => send(ws, data, binary, desktop ? OUTPUT : 2 * WS_MESSAGE_BYTES));
			});
		});
		state = s;
		s.ready = new Promise((resolve) => {
			s.server.once("error", () => {
				if (state === s) close();
				resolve(false);
			});
			s.server.once("close", () => resolve(false));
			s.server.listen(0, "0.0.0.0", () => {
				if (state !== s) {
					s.server.close();
					resolve(false);
				} else resolve(true);
			});
		});
		return s;
	}
	async function available() {
		return new Promise<boolean>((resolve) => {
			let finished = false;
			const request = localRequest(
				{
					protocol: local.protocol,
					hostname,
					port: local.port || undefined,
					path: STATUS,
					headers: headers(),
					agent: false,
				},
				(res) => {
					let size = 0;
					res.on("data", (chunk: Buffer) => {
						size += chunk.length;
						if (size > INPUT) finish(false);
					});
					res.on("error", () => finish(false));
					res.on("end", () => finish(res.statusCode === 200));
				},
			);
			const timer = setTimeout(() => finish(false), 800);
			const cancel = () => finish(false);
			const finish = (ok: boolean) => {
				if (finished) return;
				finished = true;
				clearTimeout(timer);
				checking.delete(cancel);
				request.destroy();
				resolve(ok);
			};
			checking.add(cancel);
			request.on("error", () => finish(false));
			request.end();
		});
	}
	async function issueGrant(): Promise<DeviceLanGrant | null> {
		const issuedGeneration = generation;
		try {
			if (checking.size >= 16) return null;
			if (!(await (options.enabled ? options.enabled() : available())) || issuedGeneration !== generation) return null;
			const candidates = [...new Set((options.addresses ?? addresses)())];
			if (
				!candidates.length ||
				candidates.length > 16 ||
				candidates.some((a) => !privateAddress(a, !!options.addresses))
			)
				return null;
			const s = state ?? start();
			if (!(await s.ready) || state !== s || issuedGeneration !== generation) return null;
			schedule(s);
			while (s.grants.size >= 16) revoke(s, s.grants.values().next().value!);
			const key = randomBytes(32);
			const grant: DeviceLanGrant = {
				addresses: candidates,
				port: (s.server.address() as { port: number }).port,
				identity: randomBytes(24).toString("base64url"),
				key: key.toString("base64url"),
				expiresAt: Date.now() + TTL,
			};
			s.grants.set(grant.identity, { grant: { ...grant, addresses: [...candidates] }, key, sockets: new Set() });
			schedule(s);
			return grant;
		} catch {
			return null;
		}
	}
	function close() {
		generation++;
		for (const cancel of checking) cancel();
		const s = state;
		state = undefined;
		if (!s) return;
		clearTimeout(s.timer);
		for (const entry of s.grants.values()) revoke(s, entry);
		for (const cleanup of s.tasks) cleanup();
		for (const socket of s.sockets) socket.destroy();
		s.wss.close();
		s.desktopWss.close();
		s.server.close();
	}
	return {
		issueGrant,
		revoke(identity: string) {
			if (!state) return;
			const entry = state.grants.get(identity);
			if (entry) {
				revoke(state, entry);
				schedule(state);
			}
		},
		close,
	};
}

export async function probeDeviceLan(
	grant: unknown,
	options: { timeoutMs?: number; allowLoopback?: boolean; signal?: AbortSignal } = {},
): Promise<DeviceLanConnection | null> {
	if (!validGrant(grant, options.allowLoopback === true) || options.signal?.aborted) return null;
	const timeout = options.timeoutMs ?? 800;
	if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 30_000) return null;
	return new Promise((resolve) => {
		let settled = false;
		let remaining = grant.addresses.length;
		const candidates = new Set<{ agent: https.Agent; cancel(): void }>();
		const finish = (winner: DeviceLanConnection | null) => {
			if (settled) return;
			settled = true;
			options.signal?.removeEventListener("abort", abort);
			for (const candidate of candidates) if (candidate.agent !== winner?.agent) candidate.cancel();
			resolve(winner);
		};
		const abort = () => finish(null);
		options.signal?.addEventListener("abort", abort, { once: true });
		for (const address of grant.addresses) {
			const agent = new https.Agent({
				...TLS_OPTIONS,
				keepAlive: true,
				maxSockets: 4,
				maxFreeSockets: 1,
				maxCachedSessions: 0,
				pskCallback: () => ({ identity: grant.identity, psk: Buffer.from(grant.key, "base64url") }),
				checkServerIdentity: () => undefined,
			});
			const origin = `https://${address}:${grant.port}`;
			let finished = false;
			const fail = () => {
				if (finished) return;
				finished = true;
				clearTimeout(timer);
				request.destroy();
				agent.destroy();
				candidates.delete(candidate);
				if (--remaining === 0) finish(null);
			};
			const request = https.get(`${origin}${STATUS}`, { agent }, (res) => {
				let size = 0;
				res.on("data", (chunk: Buffer) => {
					size += chunk.length;
					if (size > INPUT) fail();
				});
				res.on("error", fail);
				res.on("end", () => {
					if (finished || settled) return;
					try {
						if (res.statusCode !== 200 || grant.expiresAt <= Date.now()) return fail();
						finished = true;
						clearTimeout(timer);
						finish({ origin, agent, close: () => agent.destroy() });
					} catch {
						fail();
					}
				});
			});
			const candidate = { agent, cancel: fail };
			candidates.add(candidate);
			const timer = setTimeout(fail, Math.min(timeout, grant.expiresAt - Date.now()));
			request.on("error", fail);
		}
	});
}
