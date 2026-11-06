import express, { type Express } from "express";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { desktopPage } from "./desktop-page.js";
import { createDesktopSetup } from "./desktop-setup.js";
import {
	nativeDesktopStatus,
	startNativeDesktop,
	requestNativeDesktopPermissions,
	type NativeDesktopInput,
} from "./desktop-native.js";
import { linuxDesktopStatus, startLinuxDesktop } from "./desktop-linux.js";

export const DESKTOP_LIMITS = Object.freeze({
	frame: 4 * 1024 * 1024,
	input: 16 * 1024,
	queue: 4 * 1024 * 1024,
	connections: 4,
	connectMs: 60_000,
	idleMs: 30 * 60_000,
});
const loopback = (host: string) => ["127.0.0.1", "::1", "[::1]", "localhost"].includes(host);

export function desktopLocalRequest(req: IncomingMessage): boolean {
	if (!loopback(req.socket.remoteAddress?.replace(/^::ffff:/, "") ?? "")) return false;
	try {
		const host = new URL(`http://${req.headers.host ?? ""}`);
		if (!loopback(host.hostname) || host.username || Reflect.get(host, "pass" + "word") || host.pathname !== "/")
			return false;
		if (req.headers.origin) {
			const origin = new URL(req.headers.origin);
			if (
				!["http:", "https:"].includes(origin.protocol) ||
				origin.host !== host.host ||
				!loopback(origin.hostname) ||
				origin.origin !== req.headers.origin
			)
				return false;
		}
		return true;
	} catch {
		return false;
	}
}

type CaptureOptions = {
	onFrame: (jpeg: Buffer) => void;
	onError: (message: string) => void;
	onClose: () => void;
	readOnly?: boolean;
};
type Capture = { input: (event: NativeDesktopInput) => void; close: () => void };
export interface DeviceDesktopOptions {
	app: Express;
	authorize: (req: IncomingMessage) => boolean;
	env?: NodeJS.ProcessEnv;
	dataDir?: string;
	native?: {
		status: () => { supported: boolean; backend: string; reason?: string };
		start: (options: CaptureOptions) => Capture;
		permissions?: (
			kind: "screen" | "control",
			signal?: AbortSignal,
		) => Promise<{ screen: boolean; accessibility: boolean }>;
	};
}

export function parseDesktopInput(value: unknown): NativeDesktopInput | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const v = value as Record<string, unknown>;
	const only = (...keys: string[]) => Object.keys(v).every((key) => keys.includes(key));
	const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
	if (v.type === "release" && only("type")) return { type: "release" };
	if (
		v.type === "pointer" &&
		only("type", "x", "y", "action", "button") &&
		finite(v.x) &&
		finite(v.y) &&
		v.x >= 0 &&
		v.x <= 1 &&
		v.y >= 0 &&
		v.y <= 1 &&
		["move", "down", "up"].includes(String(v.action)) &&
		(v.button === undefined || [0, 1, 2].includes(v.button as number))
	) {
		if (v.action !== "move" && v.button === undefined) return;
		return v as NativeDesktopInput;
	}
	if (v.type === "wheel" && only("type", "deltaY") && finite(v.deltaY) && Math.abs(v.deltaY) <= 10000)
		return v as NativeDesktopInput;
	if (
		v.type === "key" &&
		only("type", "code", "action") &&
		typeof v.code === "string" &&
		/^[A-Za-z][A-Za-z0-9]{0,39}$/.test(v.code) &&
		["down", "up"].includes(String(v.action))
	)
		return v as NativeDesktopInput;
	if (
		v.type === "text" &&
		only("type", "text") &&
		typeof v.text === "string" &&
		v.text.length > 0 &&
		v.text.length <= 2048 &&
		!v.text.includes("\0")
	)
		return v as NativeDesktopInput;
}

export function createDeviceDesktop({ app, authorize, env = process.env, dataDir, native }: DeviceDesktopOptions) {
	const setup = createDesktopSetup({ dataDir, environmentEnabled: env.PI_DEVICE_DESKTOP === "1" });
	const backend =
		native ??
		(process.platform === "linux"
			? { status: linuxDesktopStatus, start: startLinuxDesktop }
			: { status: nativeDesktopStatus, start: startNativeDesktop });
	const requestPermissions = native?.permissions ?? requestNativeDesktopPermissions;
	const permissionControllers = new Set<AbortController>();
	const installation = {
		state: "not-required",
		log: "Native desktop capture does not require browser component installation.",
	};
	const status = () => {
		const platform = backend.status();
		return {
			...platform,
			os: process.platform,
			enabled: setup.enabled,
			environmentEnabled: env.PI_DEVICE_DESKTOP === "1",
			available: setup.enabled && platform.supported,
			readOnlyEnforcement: "server",
			clientViewOnlyIsPermission: true,
			installation,
		};
	};
	let closed = false;
	const bridges = new Set<() => void>();
	const wss = new WebSocketServer({ noServer: true, maxPayload: DESKTOP_LIMITS.input, perMessageDeflate: false });
	const allowed = (req: IncomingMessage) => {
		try {
			return !closed && desktopLocalRequest(req) && authorize(req);
		} catch {
			return false;
		}
	};
	app.use((req, res, next) => {
		if (req.path !== "/desktop" && !req.path.startsWith("/api/device-desktop/")) return next();
		res.setHeader("Cache-Control", "no-store");
		res.setHeader("X-Content-Type-Options", "nosniff");
		res.setHeader("Referrer-Policy", "no-referrer");
		if (!allowed(req)) {
			res.status(403).end("Desktop authorization required");
			return;
		}
		if (req.path.startsWith("/api/device-desktop/local/") || req.path.startsWith("/api/device-desktop/setup/"))
			return next();
		if (req.method !== "GET") {
			res.status(405).end();
			return;
		}
		if (req.path === "/api/device-desktop/status") {
			res.json(status());
			return;
		}
		if (req.path === "/desktop") {
			res.setHeader(
				"Content-Security-Policy",
				"default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
			);
			res.type("html").send(desktopPage());
			return;
		}
		res.status(404).end();
	});
	app.get("/api/device-desktop/setup/status", (_req, res) => res.json(status()));
	const setupGuard: express.RequestHandler = (req, res, next) => {
		if (!allowed(req) || !req.headers.origin) {
			res.status(403).end("Desktop authorization and Origin required");
			return;
		}
		next();
	};
	const localGuard: express.RequestHandler = (req, res, next) => {
		if (!allowed(req) || req.headers["sec-fetch-site"] === "cross-site") {
			res.status(403).json({ error: "Open Device Center on this device to manage desktop permissions." });
			return;
		}
		next();
	};
	app.get("/api/device-desktop/local/status", localGuard, (_req, res) =>
		res.json({ ...status(), permissions: { supported: process.platform === "darwin" } }),
	);
	app.post(
		"/api/device-desktop/local/permissions",
		localGuard,
		setupGuard,
		express.json({ limit: 256 }),
		async (req, res) => {
			if (!req.body || !["screen", "control"].includes(req.body.kind) || Object.keys(req.body).length !== 1) {
				res.status(400).json({ error: "Expected screen or control permission kind" });
				return;
			}
			if (process.platform !== "darwin" && !native?.permissions) {
				res.status(400).json({ error: "System permission requests are available on macOS only." });
				return;
			}
			if (permissionControllers.size) {
				res.status(409).json({ error: "A system permission request is already running." });
				return;
			}
			const controller = new AbortController();
			permissionControllers.add(controller);
			const abort = () => {
				if (!res.writableEnded) controller.abort();
			};
			res.on("close", abort);
			try {
				const permissions = await requestPermissions(req.body.kind, controller.signal);
				if (!controller.signal.aborted && !closed) res.json(permissions);
			} catch (error) {
				if (!controller.signal.aborted && !closed)
					res
						.status(500)
						.json({ error: error instanceof Error ? error.message : "Could not request system permissions." });
			} finally {
				res.off("close", abort);
				permissionControllers.delete(controller);
			}
		},
	);
	app.post("/api/device-desktop/local/enable", localGuard, setupGuard, express.json({ limit: 256 }), (req, res) => {
		if (!req.body || typeof req.body.enabled !== "boolean" || Object.keys(req.body).length !== 1) {
			res.status(400).json({ error: "Expected only enabled boolean" });
			return;
		}
		try {
			setup.setEnabled(req.body.enabled);
			if (!setup.enabled) for (const cleanup of bridges) cleanup();
			res.json(status());
		} catch {
			res.status(500).json({ error: "Could not save desktop settings" });
		}
	});
	app.post("/api/device-desktop/setup/install", setupGuard, (_req, res) => res.json({ installation }));
	app.post("/api/device-desktop/setup/enable", setupGuard, express.json({ limit: 256 }), (req, res) => {
		if (!req.body || typeof req.body.enabled !== "boolean" || Object.keys(req.body).length !== 1) {
			res.status(400).json({ error: "Expected only enabled boolean" });
			return;
		}
		try {
			setup.setEnabled(req.body.enabled);
			if (!setup.enabled) for (const cleanup of bridges) cleanup();
			res.json(status());
		} catch {
			res.status(500).json({ error: "Could not save desktop settings" });
		}
	});
	function bridge(ws: WebSocket, readOnly: boolean) {
		let ended = false;
		let capture: Capture | undefined;
		let alive = true;
		let lastActivity = Date.now();
		let queued = 0;
		let sending = false;
		let awaitingAck = false;
		let started = false;
		let failing = false;
		let closeTimer: ReturnType<typeof setTimeout> | undefined;
		let captureClosed = false;
		const stopCapture = () => {
			if (!capture || captureClosed) return;
			captureClosed = true;
			capture.close();
		};
		const cleanup = () => {
			if (ended) return;
			ended = true;
			clearTimeout(connectTimer);
			clearInterval(heartbeat);
			clearTimeout(closeTimer);
			bridges.delete(cleanup);
			stopCapture();
			ws.terminate();
		};
		const fail = (message: string) => {
			if (ended || failing) return;
			failing = true;
			stopCapture();
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify({ type: "error", message: message.slice(0, 2048) }));
				ws.close(1011, "Desktop capture failed");
				closeTimer = setTimeout(cleanup, 2000);
				closeTimer.unref();
			} else cleanup();
		};
		const connectTimer = setTimeout(
			() => fail("Desktop capture timed out. Check screen capture permissions and the active graphical session."),
			DESKTOP_LIMITS.connectMs,
		);
		connectTimer.unref();
		const heartbeat = setInterval(() => {
			if (!alive || Date.now() - lastActivity > DESKTOP_LIMITS.idleMs) return cleanup();
			alive = false;
			if (ws.readyState === WebSocket.OPEN) ws.ping();
		}, 30_000);
		heartbeat.unref();
		bridges.add(cleanup);
		ws.on("pong", () => {
			alive = true;
		});
		ws.on("close", cleanup);
		ws.on("error", cleanup);
		ws.on("message", (raw, binary) => {
			if (ended) return;
			if (binary) return cleanup();
			let input: NativeDesktopInput | undefined;
			try {
				const value = JSON.parse(raw.toString());
				if (value?.type === "ack" && Object.keys(value).length === 1) {
					awaitingAck = false;
					return;
				}
				input = parseDesktopInput(value);
			} catch {}
			if (!input) return cleanup();
			lastActivity = Date.now();
			if (!readOnly) {
				try {
					capture?.input(input);
				} catch {
					fail("Could not send desktop input.");
				}
			}
		});
		try {
			capture = backend.start({
				readOnly,
				onFrame: (jpeg) => {
					if (ended || failing || ws.readyState !== WebSocket.OPEN) return;
					if (!jpeg.length || jpeg.length > DESKTOP_LIMITS.frame)
						return fail("Desktop frame exceeds the capture size limit.");
					if (!started) {
						started = true;
						clearTimeout(connectTimer);
						ws.send(JSON.stringify({ type: "ready" }));
					}
					if (
						sending ||
						awaitingAck ||
						queued + jpeg.length > DESKTOP_LIMITS.queue ||
						ws.bufferedAmount + jpeg.length > DESKTOP_LIMITS.queue
					)
						return;
					sending = true;
					awaitingAck = true;
					queued += jpeg.length;
					ws.send(jpeg, { binary: true }, (error) => {
						sending = false;
						queued -= jpeg.length;
						if (error) cleanup();
					});
				},
				onError: fail,
				onClose: () => fail("Desktop capture stopped. Check the active desktop session and system permissions."),
			});
			if (ended || failing) stopCapture();
		} catch (error) {
			fail(error instanceof Error ? error.message : "Could not start desktop capture.");
		}
	}
	return {
		handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
			let url: URL;
			try {
				url = new URL(req.url ?? "/", "http://local");
			} catch {
				return false;
			}
			if (url.pathname !== "/desktop-ws") return false;
			const reject = (code: number, reason: string) =>
				socket.end(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
			if (!allowed(req)) reject(403, "Forbidden");
			else if (!setup.enabled || !backend.status().supported) reject(503, "Unavailable");
			else if (bridges.size >= DESKTOP_LIMITS.connections) reject(429, "Too Many Requests");
			else wss.handleUpgrade(req, socket, head, (ws) => bridge(ws, url.searchParams.get("viewOnly") !== "0"));
			return true;
		},
		close() {
			if (closed) return;
			closed = true;
			setup.close();
			for (const controller of permissionControllers) controller.abort();
			for (const cleanup of bridges) cleanup();
			wss.close();
		},
	};
}
