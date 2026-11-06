import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { isLoopbackAddress } from "../server-config.js";
import { probeDeviceLan } from "./device-lan.js";
import { cleanHeaders, RELAY_LIMITS, safePath, WS_MESSAGE_BYTES } from "./relay.js";
import { createPortalResponse, parseDevicePath, portalHeaders, wrapperHtml } from "./path-portal.js";

type LanConnection = NonNullable<Awaited<ReturnType<typeof probeDeviceLan>>>;
export interface DeviceLanAccessOptions {
	deviceId: string;
	hubUrl: string;
	origin: string;
	basePath?: string;
	desktop: boolean;
	valid(): boolean;
	renew(): Promise<unknown>;
	fallback(): Promise<string>;
}
interface Access {
	options: DeviceLanAccessOptions;
	origin: URL;
	base: string;
	connection: LanConnection;
	grantExpires: number;
	renewing?: Promise<void>;
	recovering?: Promise<string>;
	expires: number;
	touched: number;
	ticket?: string;
	ticketExpires: number;
	streams: Set<() => void>;
}
const PREFIX = "/device-lan/";
const SESSION_IDLE = 30 * 60_000;

export function createDeviceLanAccess(options: { allowLoopback?: boolean } = {}) {
	const sessions = new Map<string, Access>();
	const browsers = new WebSocketServer({ noServer: true, maxPayload: WS_MESSAGE_BYTES, perMessageDeflate: false });
	let closed = false;
	function dispose(token: string) {
		const access = sessions.get(token);
		if (!access) return;
		sessions.delete(token);
		for (const stop of access.streams) stop();
		access.connection.close();
	}
	function live(token: string, access: Access) {
		return (
			!closed &&
			sessions.get(token) === access &&
			access.options.valid() &&
			access.expires > Date.now() &&
			access.touched + SESSION_IDLE > Date.now()
		);
	}
	const sweep = setInterval(() => {
		for (const [token, access] of sessions)
			if (!live(token, access) || (access.ticket && access.ticketExpires <= Date.now())) dispose(token);
	}, 60_000);
	sweep.unref();
	function parse(req: IncomingMessage) {
		if (!req.url?.startsWith(PREFIX)) return null;
		return parseDevicePath("/device/" + req.url.slice(PREFIX.length));
	}
	function allowed(req: IncomingMessage, access: Access) {
		return isLoopbackAddress(req.socket.remoteAddress) && req.headers.host === access.origin.host;
	}
	function lookup(req: IncomingMessage, websocket = false) {
		const path = parse(req);
		const access = path?.token ? sessions.get(path.token) : undefined;
		if (
			!path?.token ||
			!access ||
			access.options.deviceId !== path.id ||
			!live(path.token, access) ||
			!allowed(req, access)
		)
			return null;
		if (
			!path.path ||
			(req.headers.origin && req.headers.origin !== "null") ||
			(websocket && req.headers.origin !== "null")
		)
			return null;
		access.touched = Date.now();
		return { path, access, token: path.token };
	}
	async function connection(token: string, access: Access) {
		if (!live(token, access)) throw new Error("Device access expired");
		if (access.grantExpires - Date.now() < 60_000) {
			access.renewing ??= (async () => {
				const grant = await access.options.renew();
				const next = await probeDeviceLan(grant, { allowLoopback: options.allowLoopback });
				if (!next) throw new Error("Local network unavailable");
				if (!live(token, access)) {
					next.close();
					throw new Error("Device binding changed");
				}
				access.connection.close();
				access.connection = next;
				access.grantExpires = (grant as { expiresAt: number }).expiresAt;
			})().finally(() => {
				access.renewing = undefined;
			});
			await access.renewing;
		}
		return access.connection;
	}
	function handleRequest(req: IncomingMessage, res: ServerResponse) {
		if (!req.url?.startsWith(PREFIX)) return false;
		res.setHeader("Cache-Control", "no-store");
		res.setHeader("Referrer-Policy", "no-referrer");
		res.setHeader("X-Content-Type-Options", "nosniff");
		const path = parse(req);
		if (path?.tail === "/__open" && req.method === "GET") {
			const ticket = new URL(req.url, "http://local").searchParams.get("ticket");
			const entry = [...sessions].find(([, access]) => access.ticket === ticket && access.options.deviceId === path.id);
			if (
				!entry ||
				!live(...entry) ||
				entry[1].ticketExpires <= Date.now() ||
				!allowed(req, entry[1]) ||
				(req.headers.origin && req.headers.origin !== entry[1].origin.origin && req.headers.origin !== "null")
			) {
				res.writeHead(403).end();
				return true;
			}
			const [, access] = entry;
			access.ticket = undefined;
			access.touched = Date.now();
			res.writeHead(302, { location: access.base + "__lan_view" }).end();
			return true;
		}
		const wrapper = path?.token ? sessions.get(path.token) : undefined;
		if (path?.path === "/__lan_view") {
			if (
				!wrapper ||
				path.id !== wrapper.options.deviceId ||
				req.method !== "GET" ||
				!live(path.token!, wrapper) ||
				!allowed(req, wrapper) ||
				(req.headers.origin && ![wrapper.origin.origin, "null"].includes(req.headers.origin))
			) {
				res.writeHead(403).end();
				return true;
			}
			const access = wrapper;
			access.touched = Date.now();
			const page = wrapperHtml(
				access.base,
				access.options.desktop ? "desktop" : "",
				access.options.desktop ? access.origin : undefined,
				`${access.options.deviceId} · LAN`,
				JSON.stringify([access.options.hubUrl, access.options.deviceId]),
				access.origin.origin + access.base + "__lan_fallback",
			);
			res
				.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": page.csp })
				.end(page.html);
			return true;
		}
		const fallback = path?.token ? sessions.get(path.token) : undefined;
		if (path?.path === "/__lan_fallback") {
			if (
				!fallback ||
				path.id !== fallback.options.deviceId ||
				req.method !== "POST" ||
				!live(path.token!, fallback) ||
				!allowed(req, fallback) ||
				![fallback.origin.origin, "null"].includes(req.headers.origin ?? "")
			) {
				res.writeHead(403).end();
				return true;
			}
			fallback.recovering ??= (async () => {
				let direct: Awaited<ReturnType<typeof open>> = null;
				try {
					direct = await open(await fallback.options.renew(), fallback.options);
				} catch {}
				if (!live(path.token!, fallback)) throw new Error("Device binding changed");
				return direct
					? new URL((fallback.options.basePath ?? "/") + direct.url.slice(1), fallback.origin).href
					: await fallback.options.fallback();
			})().finally(() => {
				fallback.recovering = undefined;
			});
			void fallback.recovering
				.then((url) => {
					if (!live(path.token!, fallback)) throw new Error("Device binding changed");
					res
						.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "null" })
						.end(JSON.stringify({ url }));
					dispose(path.token!);
				})
				.catch(() => {
					if (!res.destroyed && !res.headersSent) res.writeHead(502).end();
				});
			return true;
		}
		const match = lookup(req);
		if (!match) {
			res.writeHead(403).end();
			return true;
		}
		const { access, token } = match;
		const forward = match.path.path!;
		const headers = portalHeaders(access.origin, access.base);
		if (req.method === "OPTIONS") {
			res.writeHead(204, headers).end();
			return true;
		}
		if (
			req.method === "GET" &&
			["/api/device-center/chat-status", "/api/device-center/status"].includes(forward.split("?")[0])
		) {
			res
				.writeHead(200, { ...headers, "content-type": "application/json" })
				.end(JSON.stringify({ hubUrl: access.options.hubUrl, deviceId: access.options.deviceId, transport: "lan" }));
			return true;
		}
		if (!safePath(forward, req.method) || access.streams.size >= RELAY_LIMITS.streams) {
			res.writeHead(403).end();
			return true;
		}
		void proxyHttp(req, res, token, access, forward);
		return true;
	}
	async function proxyHttp(req: IncomingMessage, res: ServerResponse, token: string, access: Access, path: string) {
		let upstream: ReturnType<typeof httpsRequest> | undefined;
		let ended = false;
		let bodyBytes = 0;
		const stop = () => {
			if (ended) return;
			ended = true;
			access.streams.delete(stop);
			upstream?.destroy();
			req.off("aborted", stop);
			res.off("close", stop);
			if (!res.writableEnded && !res.destroyed) {
				if (!res.headersSent) res.writeHead(502);
				res.end();
			}
		};
		access.streams.add(stop);
		req.once("aborted", stop);
		res.once("close", stop);
		try {
			const peer = await connection(token, access);
			if (ended || !live(token, access)) return stop();
			upstream = httpsRequest(
				new URL(path, peer.origin),
				{
					method: req.method,
					agent: peer.agent,
					headers: { ...cleanHeaders(req.headers), "accept-encoding": "identity" },
				},
				(response) => {
					const portal = createPortalResponse(
						res,
						access.origin,
						access.base,
						["/", "/index.html", "/desktop"].includes(path.split("?")[0]),
					);
					try {
						portal.start(response.statusCode ?? 502, cleanHeaders(response.headers));
					} catch {
						response.destroy();
						stop();
						return;
					}
					response.on("data", (data: Buffer) => {
						try {
							portal.write(data);
							access.touched = Date.now();
							if (res.writableLength > RELAY_LIMITS.queue) {
								response.destroy();
								stop();
							} else if (res.writableNeedDrain) {
								response.pause();
								res.once("drain", () => response.resume());
							}
						} catch {
							response.destroy();
							stop();
						}
					});
					response.once("error", stop);
					response.once("end", () => {
						if (ended) return;
						try {
							portal.end();
						} catch {
							stop();
							return;
						}
						ended = true;
						access.streams.delete(stop);
						req.off("aborted", stop);
						res.off("close", stop);
					});
				},
			);
			upstream.setTimeout(30 * 60_000, stop);
			upstream.once("error", stop);
			req.on("data", (chunk: Buffer) => {
				bodyBytes += chunk.length;
				if (ended || bodyBytes > RELAY_LIMITS.body) return stop();
				if (!upstream!.write(chunk)) {
					req.pause();
					upstream!.once("drain", () => req.resume());
				}
			});
			req.once("end", () => upstream?.end());
			if (req.readableEnded) upstream.end();
		} catch {
			stop();
		}
	}
	function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
		if (!req.url?.startsWith(PREFIX)) return false;
		const match = lookup(req, true);
		if (!match || !safePath(match.path.path, "WS") || match.access.streams.size >= RELAY_LIMITS.streams) {
			socket.destroy();
			return true;
		}
		const { access, token } = match;
		let remote: WebSocket | undefined;
		let browser: WebSocket | undefined;
		let ended = false;
		const stop = () => {
			if (ended) return;
			ended = true;
			access.streams.delete(stop);
			remote?.terminate();
			browser?.terminate();
			socket.destroy();
		};
		access.streams.add(stop);
		socket.once("close", stop);
		void connection(token, access)
			.then((peer) => {
				if (ended || !live(token, access)) return stop();
				const endpoint = new URL(match.path.path!, peer.origin);
				endpoint.protocol = "wss:";
				remote = new WebSocket(endpoint, {
					agent: peer.agent,
					maxPayload: WS_MESSAGE_BYTES,
					perMessageDeflate: false,
					handshakeTimeout: 3000,
				});
				remote.once("error", stop);
				remote.once("close", stop);
				remote.once("open", () => {
					if (ended) return stop();
					remote!.pause();
					try {
						browsers.handleUpgrade(req, socket, head, (connected) => {
							browser = connected;
							const forward = (from: WebSocket, to: WebSocket) =>
								from.on("message", (data, binary) => {
									access.touched = Date.now();
									if (
										!Buffer.isBuffer(data) ||
										to.readyState !== WebSocket.OPEN ||
										to.bufferedAmount + data.length > 2 * WS_MESSAGE_BYTES
									)
										return stop();
									to.send(data, { binary }, (error) => {
										if (error) stop();
									});
								});
							forward(connected, remote!);
							forward(remote!, connected);
							connected.once("error", stop);
							connected.once("close", stop);
							remote!.resume();
						});
					} catch {
						stop();
					}
				});
			})
			.catch(stop);
		return true;
	}
	async function open(grant: unknown, accessOptions: DeviceLanAccessOptions) {
		if (closed || sessions.size >= 16 || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(accessOptions.deviceId)) return null;
		const origin = new URL(accessOptions.origin);
		const basePath = accessOptions.basePath ?? "/";
		if (
			!/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(basePath) ||
			!["http:", "https:"].includes(origin.protocol) ||
			origin.origin !== accessOptions.origin
		)
			return null;
		const peer = await probeDeviceLan(grant, { allowLoopback: options.allowLoopback });
		if (!peer) return null;
		if (closed || !accessOptions.valid() || sessions.size >= 16) {
			peer.close();
			return null;
		}
		const token = randomBytes(32).toString("hex");
		const ticket = randomBytes(32).toString("hex");
		sessions.set(token, {
			options: accessOptions,
			origin,
			base: `${basePath}device-lan/${accessOptions.deviceId}/__relay/${token}/`,
			connection: peer,
			grantExpires: (grant as { expiresAt: number }).expiresAt,
			expires: Date.now() + 8 * 60 * 60_000,
			touched: Date.now(),
			ticket,
			ticketExpires: Date.now() + 30_000,
			streams: new Set(),
		});
		return { url: `/device-lan/${accessOptions.deviceId}/__open?ticket=${ticket}`, transport: "lan" as const };
	}
	return {
		open,
		handleRequest,
		handleUpgrade,
		reset() {
			for (const token of sessions.keys()) dispose(token);
		},
		close() {
			closed = true;
			clearInterval(sweep);
			for (const token of sessions.keys()) dispose(token);
			browsers.close();
		},
	};
}
export type DeviceLanAccess = ReturnType<typeof createDeviceLanAccess>;
