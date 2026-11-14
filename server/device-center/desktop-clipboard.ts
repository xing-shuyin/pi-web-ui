import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { CLIPBOARD_LIMITS } from "./desktop-clipboard-protocol.js";
import { createNativeClipboard, type ClipboardBackend } from "./desktop-clipboard-native.js";

/** Independent endpoint: clipboard transfers cannot fill the video/input queue. */
export { clipboardConnection } from "./desktop-clipboard-connection.js";
import { clipboardConnection } from "./desktop-clipboard-connection.js";

export function createDesktopClipboard(options: {
	allowed: (req: IncomingMessage) => boolean;
	enabled: () => boolean;
	backend?: () => Promise<ClipboardBackend>;
}) {
	const wss = new WebSocketServer({ noServer: true, maxPayload: CLIPBOARD_LIMITS.message, perMessageDeflate: false });
	const clients = new Set<WebSocket>();
	let native: Promise<ClipboardBackend> | undefined;
	return {
		handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
			const url = new URL(req.url ?? "/", "http://local");
			const viewer = url.pathname === "/api/device-desktop/local/clipboard-ws";
			if (!viewer && url.pathname !== "/desktop-clipboard-ws") return false;
			if (!options.allowed(req) || !req.headers.origin || (!viewer && !options.enabled()) || clients.size >= 4) {
				socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
				return true;
			}
			wss.handleUpgrade(req, socket, head, (ws) => {
				clients.add(ws);
				ws.once("close", () => clients.delete(ws));
				ws.on("error", () => {});
				let alive = true;
				ws.on("pong", () => {
					alive = true;
				});
				const heartbeat = setInterval(() => {
					if (!alive) ws.terminate();
					else {
						alive = false;
						if (ws.readyState === WebSocket.OPEN) ws.ping();
					}
				}, 30_000);
				heartbeat.unref();
				ws.once("close", () => clearInterval(heartbeat));
				native ??= (options.backend ?? createNativeClipboard)();
				void native
					.then((backend) => {
						if (ws.readyState === WebSocket.OPEN)
							clipboardConnection(ws, backend, viewer || url.searchParams.get("viewOnly") === "0");
					})
					.catch(() => {
						native = undefined;
						if (ws.readyState === WebSocket.OPEN)
							ws.send(JSON.stringify({ type: "clipboard-error", code: "clipboard-unavailable" }));
						ws.close();
					});
			});
			return true;
		},
		reset() {
			for (const ws of clients) ws.close();
		},
		close() {
			for (const ws of clients) ws.terminate();
			wss.close();
		},
	};
}
