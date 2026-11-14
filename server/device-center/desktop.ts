import { DesktopQuality, parseDesktopPreferences, type DesktopProfile } from "./desktop-quality.js";
import { DesktopVideoFlow } from "./desktop-video-flow.js";
import express, { type Express } from "express";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { desktopPage } from "./desktop-page.js";
import { createDesktopClipboard } from "./desktop-clipboard.js";
import { createDesktopFiles } from "./desktop-files.js";
import type { DesktopDisplays } from "./desktop-displays.js";
import { desktopPreviewPage } from "./desktop-preview-page.js";
import { createDesktopPreview } from "./desktop-preview.js";
import { type VideoFrame } from "./desktop-video.js";
import { windowsDesktopServicePath, windowsDesktopServiceProfiles } from "./windows-desktop-service.js";
import { startEncodedServiceDesktop } from "./desktop-video-encoder.js";
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
	ackMs: 15_000,
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
	onVideoAlive?: () => void;
	display?: string;
	onDisplays?: (displays: DesktopDisplays) => void;
	onFrame: (jpeg: Buffer) => void;
	/** H.264 access units; only the video backend calls this instead of `onFrame`. */
	onVideo?: (frame: VideoFrame) => void;
	onError: (message: string) => void;
	onClose: () => void;
	readOnly?: boolean;
	preview?: boolean;
};
/** Video session shape handed to the viewer in the `video` control message. */
const VIDEO_CODEC = process.platform === "darwin" ? "avc1.42E01F" : "avc1.640033";
type Capture = {
	videoFeedback?: (paused: boolean) => void;
	requestKeyframe?: () => void;
	input: (event: NativeDesktopInput) => void;
	configure?: (profile: DesktopProfile) => void;
	close: () => void;
};
export interface DeviceDesktopOptions {
	app: Express;
	authorize: (req: IncomingMessage) => boolean;
	env?: NodeJS.ProcessEnv;
	dataDir?: string;
	/** Optional filesystem root for isolated desktop file-transfer fixtures. */
	fileHome?: string;
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

export function createDeviceDesktop({
	app,
	authorize,
	env = process.env,
	dataDir,
	native,
	fileHome,
}: DeviceDesktopOptions) {
	const setup = createDesktopSetup({ dataDir, environmentEnabled: env.PI_DEVICE_DESKTOP === "1" });
	const backend =
		native ??
		(process.platform === "linux"
			? { status: linuxDesktopStatus, start: startLinuxDesktop }
			: { status: nativeDesktopStatus, start: startNativeDesktop });
	const preview = createDesktopPreview((options) => backend.start(options));
	let primaryDisplay: string | undefined;
	const displayPreviews = new Map<string, ReturnType<typeof createDesktopPreview>>();
	const previewFor = (display?: string) => {
		if (!display || display === primaryDisplay) return preview;
		let selected = displayPreviews.get(display);
		if (!selected) {
			if (displayPreviews.size >= 8) {
				const first = displayPreviews.keys().next().value!;
				displayPreviews.get(first)!.close();
				displayPreviews.delete(first);
			}
			selected = createDesktopPreview((options) => backend.start({ ...options, display }));
			displayPreviews.set(display, selected);
		}
		return selected;
	};
	const resetPreviews = () => {
		preview.reset();
		for (const selected of displayPreviews.values()) selected.close();
		displayPreviews.clear();
	};
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
			preview: true,
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
	const clipboard = createDesktopClipboard({ allowed, enabled: () => setup.enabled && backend.status().supported });
	const fileSessions = new Map<string, { ws: WebSocket; readOnly: boolean }>();
	const files = createDesktopFiles({
		app,
		allowed,
		home: fileHome,
		enabled: () => setup.enabled,
		access: (req) => {
			const key = req.headers["x-pi-desktop-file-session"];
			const session = typeof key === "string" ? fileSessions.get(key) : undefined;
			return session && session.ws.readyState === WebSocket.OPEN ? (session.readOnly ? "read" : "write") : undefined;
		},
	});
	const localFiles = createDesktopFiles({
		app,
		base: "/api/device-desktop/local/files",
		home: fileHome,
		allowed: (req) => allowed(req) && req.headers["x-pi-local-files"] === "1",
		enabled: () => !closed,
	});
	app.use((req, res, next) => {
		if (!["/desktop", "/desktop-preview"].includes(req.path) && !req.path.startsWith("/api/device-desktop/"))
			return next();
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
		if (req.path === "/api/device-desktop/preview") {
			const display = typeof req.query.display === "string" ? req.query.display : undefined;
			if (display && (display.length > 128 || /[\x00-\x1f]/.test(display))) {
				res.status(400).end();
				return;
			}
			if (!setup.enabled || !backend.status().supported) {
				res.status(503).json({ error: "Open the desktop to check sharing settings and system permissions." });
				return;
			}
			const controller = new AbortController();
			const abort = () => controller.abort();
			res.once("close", abort);
			void previewFor(display)
				.read(controller.signal)
				.then(({ jpeg }) => {
					if (!controller.signal.aborted) res.type("image/jpeg").send(jpeg);
				})
				.catch((error: Error) => {
					if (!controller.signal.aborted) res.status(502).json({ error: error.message.slice(0, 2048) });
				})
				.finally(() => res.off("close", abort));
			return;
		}
		if (req.path === "/desktop" || req.path === "/desktop-preview") {
			res.setHeader(
				"Content-Security-Policy",
				"default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
			);
			res.type("html").send(req.path === "/desktop-preview" ? desktopPreviewPage() : desktopPage());
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
			if (!setup.enabled) {
				resetPreviews();
				clipboard.reset();
				files.reset();
			}
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
			if (!setup.enabled) {
				resetPreviews();
				clipboard.reset();
				files.reset();
			}
			if (!setup.enabled) for (const cleanup of bridges) cleanup();
			res.json(status());
		} catch {
			res.status(500).json({ error: "Could not save desktop settings" });
		}
	});
	function bridge(
		ws: WebSocket,
		readOnly: boolean,
		display?: string,
		videoRequested = false,
		videoFeedback = false,
		jpegFeedback = false,
	) {
		let fileSession: string | undefined;
		const preview = previewFor(display);
		const previewKey = {};
		preview.liveStarted(previewKey);
		let ended = false;
		let capture: Capture | undefined;
		let alive = true;
		let lastActivity = Date.now();
		let queued = 0;
		let sending = false;
		const inFlight = new Map<number, number>();
		let inFlightBytes = 0;
		let latestFrame: Buffer | undefined;
		let ackTimer: ReturnType<typeof setTimeout> | undefined;
		let ackMs = 0;
		let hasDisplayAck = false;
		const quality = new DesktopQuality();
		const videoFlow = new DesktopVideoFlow();
		const jpegFlow = new DesktopVideoFlow({ deliveryBudgetMs: 100 });
		let automatic = true,
			flowPaused = false,
			recoveryAt = -Infinity;
		let currentProfile = quality.profile;
		const paceVideo = () => {
			const paused = videoFeedback && videoFlow.blocked(currentProfile.fps);
			if (flowPaused !== paused) {
				flowPaused = paused;
				capture?.videoFeedback?.(paused);
			}
		};
		let appliedProfile = "";
		let lastConfigure = 0;
		let videoDeclared = false;
		let videoCodec = VIDEO_CODEC;
		let videoDropping = false;
		let videoStall: ReturnType<typeof setTimeout> | undefined;
		const armVideoStall = () => {
			clearTimeout(videoStall);
			videoStall = setTimeout(() => fail("Desktop video stream stalled. Reconnect to resume."), 15000);
			videoStall.unref();
		};
		const sendVideo = (frame: VideoFrame) => {
			if (ended || failing || ws.readyState !== WebSocket.OPEN) return;
			if (!videoDeclared || frame.reset || (frame.codec && frame.codec !== videoCodec)) {
				if (frame.reset) {
					videoFlow.reset();
					paceVideo();
				}
				videoDeclared = true;
				videoCodec = frame.codec ?? VIDEO_CODEC;
				ws.send(
					JSON.stringify({
						type: "video",
						codec: videoCodec,
						...(videoFeedback ? { framed: 1 } : {}),
						...(frame.reset ? { reset: true } : {}),
					}),
				);
			}
			if (frame.data.length > DESKTOP_LIMITS.frame) return fail("Desktop frame exceeds the capture size limit.");
			captured++;
			if (ws.bufferedAmount + frame.data.length > DESKTOP_LIMITS.queue || (videoFeedback && videoFlow.count >= 96)) {
				videoDropping = true;
				replaced++;
				return;
			}
			// H.264 frames cannot be replaced like JPEG: skip ahead to the next keyframe instead.
			if (videoDropping) {
				if (!frame.key) {
					replaced++;
					return;
				}
				videoDropping = false;
			}
			sent++;
			armVideoStall();
			if (!started) {
				started = true;
				clearTimeout(connectTimer);
				ws.send(JSON.stringify({ type: "ready", dynamicQuality: Boolean(capture?.configure), video: true }));
			}
			let data = frame.data;
			if (videoFeedback) {
				const header = Buffer.allocUnsafe(20);
				header.write("PIV1", 0, "ascii");
				header.writeUInt32BE(videoFlow.frame(performance.now()), 4);
				header.writeDoubleBE(frame.timestampMs ?? performance.now() - statsStartedAt, 8);
				header.writeUInt32BE(frame.key ? 1 : 0, 16);
				data = Buffer.concat([header, frame.data]);
				paceVideo();
			}
			ws.send(data, { binary: true }, (error) => {
				if (error) cleanup();
			});
		};
		const applyProfile = (profile: DesktopProfile) => {
			currentProfile = profile;
			if (!capture?.configure || ended || failing) return;
			const key = JSON.stringify(profile);
			if (key === appliedProfile) return;
			try {
				capture.configure(profile);
				appliedProfile = key;
			} catch {
				fail("Could not configure desktop capture.");
			}
		};
		let captured = 0;
		let sent = 0;
		let replaced = 0;
		const statsStartedAt = performance.now();
		let started = false;
		let failing = false;
		let closeTimer: ReturnType<typeof setTimeout> | undefined;
		let captureClosed = false;
		const stopCapture = () => {
			if (!capture || captureClosed) return;
			captureClosed = true;
			capture.close();
			preview.liveStopped(previewKey);
		};
		const cleanup = () => {
			if (ended) return;
			ended = true;
			if (fileSession && fileSessions.get(fileSession)?.ws === ws) fileSessions.delete(fileSession);
			clearTimeout(connectTimer);
			clearTimeout(videoStall);
			clearInterval(heartbeat);
			clearTimeout(closeTimer);
			clearTimeout(ackTimer);
			clearInterval(statsTimer);
			latestFrame = undefined;
			bridges.delete(cleanup);
			stopCapture();
			preview.liveStopped(previewKey);
			ws.terminate();
		};
		const fail = (message: string) => {
			if (ended || failing) return;
			failing = true;
			clearTimeout(ackTimer);
			clearTimeout(videoStall);
			latestFrame = undefined;
			stopCapture();
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify({ type: "error", message: message.slice(0, 2048) }));
				ws.close(1011, "Desktop capture failed");
				closeTimer = setTimeout(cleanup, 2000);
				closeTimer.unref();
			} else cleanup();
		};
		const armAck = () => {
			clearTimeout(ackTimer);
			if (jpegFlow.progressAt !== undefined) {
				ackTimer = setTimeout(
					() => fail("Desktop display stopped acknowledging frames. Reconnect to resume."),
					Math.max(1, DESKTOP_LIMITS.ackMs - (performance.now() - jpegFlow.progressAt)),
				);
				ackTimer.unref();
			}
		};
		const flushFrame = () => {
			if (
				ended ||
				failing ||
				sending ||
				(jpegFeedback ? jpegFlow.blocked(currentProfile.fps, latestFrame?.length) : inFlight.size >= 2) ||
				!latestFrame ||
				ws.readyState !== WebSocket.OPEN
			)
				return;
			if (ws.bufferedAmount + latestFrame.length > DESKTOP_LIMITS.queue) return;
			if (jpegFeedback && inFlightBytes + latestFrame.length > DESKTOP_LIMITS.queue) return;
			const jpeg = latestFrame;
			latestFrame = undefined;
			sending = true;
			inFlight.set(jpegFlow.frame(performance.now(), jpeg.length), jpeg.length);
			inFlightBytes += jpeg.length;
			sent++;
			queued += jpeg.length;
			armAck();
			ws.send(jpeg, { binary: true }, (error) => {
				sending = false;
				queued -= jpeg.length;
				if (error) cleanup();
				else flushFrame();
			});
		};
		const sendJpeg = (jpeg: Buffer) => {
			if (ended || failing || ws.readyState !== WebSocket.OPEN) return;
			if (!jpeg.length || jpeg.length > DESKTOP_LIMITS.frame)
				return fail("Desktop frame exceeds the capture size limit.");
			preview.liveFrame(previewKey, jpeg);
			captured++;
			if (!started) {
				started = true;
				clearTimeout(connectTimer);
				ws.send(
					JSON.stringify({
						type: "ready",
						dynamicQuality: Boolean(capture?.configure),
						...(jpegFeedback ? { jpegFeedback: 1 } : {}),
					}),
				);
			}
			if (latestFrame) replaced++;
			latestFrame = jpeg;
			flushFrame();
		};
		const statsTimer = setInterval(() => {
			if (
				videoFeedback &&
				videoFlow.oldest !== undefined &&
				performance.now() - videoFlow.oldest > DESKTOP_LIMITS.ackMs
			)
				return fail("Desktop video receiver stopped responding. Reconnect to resume.");
			if (ended || failing || !started || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 65536) return;
			ws.send(
				JSON.stringify({
					type: "stats",
					elapsedMs: performance.now() - statsStartedAt,
					ackMeasured: videoDeclared ? videoFlow.measured : hasDisplayAck,
					captured,
					sent,
					replaced,
					ackMs: videoDeclared ? Math.round(videoFlow.ackMs) : ackMs,
					videoQueueMs: videoFlow.queueMs,
					videoInFlight: videoFlow.count,
					jpegInFlight: jpegFlow.count,
					jpegInFlightBytes: inFlightBytes,
					queued: Math.max(queued, ws.bufferedAmount),
					profile: capture?.configure ? currentProfile : undefined,
				}),
			);
		}, 2000);
		statsTimer.unref();
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
				if (value?.type === "files_session") {
					if (
						Object.keys(value).length !== 2 ||
						typeof value.key !== "string" ||
						!/^[a-f0-9]{32}$/.test(value.key) ||
						fileSession ||
						fileSessions.has(value.key)
					)
						return cleanup();
					fileSession = value.key;
					fileSessions.set(value.key, { ws, readOnly });
					ws.send(JSON.stringify({ type: "files_session_ready" }));
					return;
				}
				if (videoFeedback && value?.type === "video_ack") {
					if (
						Object.keys(value).length !== 3 ||
						!Number.isSafeInteger(value.id) ||
						!Number.isInteger(value.queue) ||
						value.queue < 0 ||
						value.queue > 128
					)
						return cleanup();
					if (videoFlow.ack(value.id, value.queue, performance.now())) {
						applyProfile(videoFlow.profile(quality.profile, automatic));
						paceVideo();
					}
					return;
				}
				if (videoFeedback && value?.type === "video_recover" && Object.keys(value).length === 1) {
					if (performance.now() - recoveryAt >= 1000) {
						recoveryAt = performance.now();
						videoFlow.reset();
						paceVideo();
						capture?.requestKeyframe?.();
					}
					return;
				}
				if (
					(!jpegFeedback && value?.type === "ack" && Object.keys(value).length === 1) ||
					(jpegFeedback && value?.type === "jpeg_ack")
				) {
					if (jpegFeedback && (Object.keys(value).length !== 2 || !Number.isSafeInteger(value.id))) return cleanup();
					const id = jpegFeedback ? value.id : inFlight.keys().next().value;
					if (id === undefined || !jpegFlow.ack(id, 0, performance.now())) return;
					for (const [key, bytes] of inFlight) {
						if (key <= id) {
							inFlight.delete(key);
							inFlightBytes -= bytes;
						}
					}
					ackMs = Math.round(jpegFlow.ackMs);
					hasDisplayAck = true;
					applyProfile(jpegFlow.profile(quality.profile, automatic));
					armAck();
					flushFrame();
					return;
				}
				if (value?.type === "configure") {
					const preferences = parseDesktopPreferences(value);
					if (!preferences || Object.keys(value).length !== (preferences.colorRange ? 6 : 5)) return cleanup();
					if (Date.now() - lastConfigure < 200) return;
					lastConfigure = Date.now();
					automatic = preferences.mode === "auto";
					const profile = quality.set(preferences);
					applyProfile((videoDeclared ? videoFlow : jpegFlow).profile(profile, automatic));
					paceVideo();
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
		// Wait briefly for the viewer hello so a WebCodecs-capable client can open an H.264 session
		// instead of the JPEG one; fall back to JPEG when the first message never arrives.
		const startCapture = () => {
			if (ended || failing) return;
			// Windows probes vendor/system hardware encoders; macOS uses ScreenCaptureKit + VideoToolbox.
			const useVideo = videoRequested && !native && !ended && !failing && process.platform === "win32";
			const useNativeVideo = videoRequested && !native && !ended && !failing && process.platform === "darwin";
			try {
				const service = windowsDesktopServicePath();
				const useServiceVideo = useVideo && service && windowsDesktopServiceProfiles(service, "video-v1");
				if (useVideo && !useServiceVideo && (!service || windowsDesktopServiceProfiles(service, "raw-v1"))) {
					capture = startEncodedServiceDesktop({
						readOnly,
						display,
						profile: quality.profile,
						onVideo: sendVideo,
						onDisplays: (value) => {
							primaryDisplay = value.displays.find((item) => item.primary)?.id;
							if (!ended && !failing && ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 65536)
								ws.send(JSON.stringify(value));
						},
						onFrame: sendJpeg,
						onError: fail,
						onClose: () => fail("Desktop capture stopped. Check the active desktop session."),
					});
					appliedProfile = JSON.stringify(quality.profile);
					return;
				}
				capture = backend.start({
					onVideoAlive: () => {
						if (started && !ended && !failing) armVideoStall();
					},
					readOnly,
					display,
					...(useNativeVideo || useServiceVideo ? { video: true, onVideo: sendVideo } : {}),
					onDisplays: (value) => {
						primaryDisplay = value.displays.find((item) => item.primary)?.id;
						if (!ended && !failing && ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 65536)
							ws.send(JSON.stringify(value));
					},
					onFrame: sendJpeg,
					onError: fail,
					onClose: () => fail("Desktop capture stopped. Check the active desktop session and system permissions."),
				});
				applyProfile(quality.profile);
				if (ended || failing) stopCapture();
			} catch (error) {
				fail(error instanceof Error ? error.message : "Could not start desktop capture.");
			}
		};
		startCapture();
	}
	return {
		handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
			if (clipboard.handleUpgrade(req, socket, head)) return true;
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
			else if (
				(url.searchParams.get("display")?.length ?? 0) > 128 ||
				/[\x00-\x1f]/.test(url.searchParams.get("display") ?? "")
			)
				reject(400, "Invalid Display");
			else
				wss.handleUpgrade(req, socket, head, (ws) =>
					bridge(
						ws,
						url.searchParams.get("viewOnly") !== "0",
						url.searchParams.get("display") || undefined,
						url.searchParams.get("video") === "1",
						url.searchParams.get("videoFeedback") === "1",
						url.searchParams.get("jpegFeedback") === "1",
					),
				);
			return true;
		},
		close() {
			if (closed) return;
			closed = true;
			setup.close();
			for (const controller of permissionControllers) controller.abort();
			for (const cleanup of bridges) cleanup();
			preview.close();
			for (const selected of displayPreviews.values()) selected.close();
			displayPreviews.clear();
			clipboard.close();
			files.close();
			localFiles.close();
			wss.close();
		},
	};
}
