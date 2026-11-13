import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { CLIPBOARD_LIMITS, parseClipboardOffer, type ClipboardOffer } from "./desktop-clipboard-protocol.js";
import {
	createNativeClipboard,
	clipboardDigest,
	type ClipboardBackend,
	type ClipboardContent,
} from "./desktop-clipboard-native.js";

/** One acknowledged chunk at a time in each direction, independent of video/input. */
export function clipboardConnection(ws: WebSocket, backend: ClipboardBackend, writable: boolean) {
	let closed = false,
		started = false,
		canRead = false,
		canWrite = false,
		manual = false,
		reading = false,
		dirty = false;
	let stopWatch: (() => void) | undefined,
		lastSent = "",
		lastApplied = "";
	let incoming: { offer: ClipboardOffer; content: ClipboardContent; item: number; offset: number } | undefined;
	let outgoing: { id: string; messages: Generator<object>; digest: string } | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let incomingTimer: ReturnType<typeof setTimeout> | undefined;
	const send = (value: object) => {
		if (closed || ws.readyState !== WebSocket.OPEN) return;
		if (ws.bufferedAmount > CLIPBOARD_LIMITS.message * 2) {
			close();
			return;
		}
		ws.send(JSON.stringify(value));
	};
	function close() {
		if (closed) return;
		closed = true;
		stopWatch?.();
		clearTimeout(timer);
		clearTimeout(incomingTimer);
		incoming = outgoing = undefined;
		ws.close();
	}
	const fail = (code: string) => {
		send({ type: "clipboard-error", code });
		close();
	};
	const armIncoming = () => {
		clearTimeout(incomingTimer);
		incomingTimer = setTimeout(() => fail("clipboard-timeout"), CLIPBOARD_LIMITS.timeout);
		incomingTimer.unref();
	};
	function next() {
		if (!outgoing || closed) return;
		const result = outgoing.messages.next();
		if (result.done) {
			lastSent = outgoing.digest;
			outgoing = undefined;
			if (dirty) void publish();
			return;
		}
		send(result.value);
		clearTimeout(timer);
		timer = setTimeout(() => fail("clipboard-timeout"), CLIPBOARD_LIMITS.timeout);
		timer.unref();
	}
	async function publish() {
		if (closed || !canRead) return;
		if (outgoing || reading || incoming) {
			dirty = true;
			return;
		}
		dirty = false;
		reading = true;
		try {
			const content = await backend.read();
			if (closed || !content) return;
			const digest = clipboardDigest(content);
			if (digest === lastSent || digest === lastApplied) return;
			const offer: ClipboardOffer = {
				type: "offer",
				id: randomUUID(),
				kind: content.kind,
				items: content.items.map(({ name, data }) => ({
					name,
					size: data.length,
					sha256: createHash("sha256").update(data).digest("hex"),
				})),
			};
			if (!parseClipboardOffer(offer)) throw new Error("clipboard-size");
			function* packets() {
				yield offer;
				for (let item = 0; item < content!.items.length; item++) {
					const data = content!.items[item].data;
					for (let offset = 0; offset < data.length; offset += CLIPBOARD_LIMITS.chunk)
						yield {
							type: "chunk",
							id: offer.id,
							item,
							offset,
							data: data.subarray(offset, offset + CLIPBOARD_LIMITS.chunk).toString("base64"),
						};
				}
				yield { type: "commit", id: offer.id };
			}
			outgoing = { id: offer.id, messages: packets(), digest };
			next();
		} catch (error) {
			send({
				type: "clipboard-error",
				code: error instanceof Error && /^clipboard-[a-z]+$/.test(error.message) ? error.message : "clipboard-read",
			});
		} finally {
			reading = false;
			if (dirty && !outgoing && !incoming && !closed)
				setTimeout(() => {
					void publish();
				}, 0);
		}
	}
	let processing = false;
	ws.on("message", (raw, binary) => {
		if (closed) return;
		if (
			binary ||
			(Array.isArray(raw) ? raw.reduce((sum, item) => sum + item.length, 0) : raw.byteLength) > CLIPBOARD_LIMITS.message
		)
			return fail("clipboard-protocol");
		let v: Record<string, unknown>;
		try {
			v = JSON.parse(raw.toString());
			if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
		} catch {
			return fail("clipboard-protocol");
		}
		if (v.type === "ack" && v.id === outgoing?.id) {
			clearTimeout(timer);
			next();
			return;
		}
		if (processing) return fail("clipboard-protocol");
		if (started && manual && (v.type === "text-read" || v.type === "text-write")) {
			if ((v.type === "text-read" && !canRead) || (v.type === "text-write" && !canWrite))
				return fail("clipboard-direction");
			if (v.type === "text-write" && (typeof v.text !== "string" || Buffer.byteLength(v.text) > 16384))
				return fail("clipboard-size");
			processing = true;
			void (async () => {
				try {
					if (v.type === "text-write") {
						await backend.write({ kind: "text", items: [{ name: "text.txt", data: Buffer.from(v.text as string) }] });
						send({ type: "text-result", written: true });
					} else {
						const content = await backend.read();
						if (closed) return;
						if (content && content.kind !== "text") return send({ type: "text-result", error: "clipboard-not-text" });
						const data = content?.items[0]?.data;
						if (data && data.length > 16384) return send({ type: "text-result", error: "clipboard-size" });
						send({ type: "text-result", text: data?.toString("utf8") ?? "" });
					}
				} catch {
					send({ type: "text-result", error: "clipboard-unavailable" });
				} finally {
					processing = false;
				}
			})();
			return;
		}
		if (v.type === "start" && !started && typeof v.read === "boolean" && typeof v.write === "boolean") {
			started = true;
			manual = v.manual === true;
			canRead = v.read;
			canWrite = v.write && writable;
			if (v.write && !writable) return fail("clipboard-readonly");
			send({ type: "clipboard-ready", read: canRead, write: canWrite });
			if (canRead && !manual) {
				try {
					stopWatch = backend.watch(() => {
						dirty = true;
						void publish();
					});
				} catch {
					return fail("clipboard-unavailable");
				}
				// Sync only subsequent copies. Enabling both directions must not race two old clipboard values.
			}
			return;
		}
		if (!started || !canWrite) return fail("clipboard-direction");
		if (v.type === "offer") {
			const offer = parseClipboardOffer(v);
			if (!offer || incoming) return fail("clipboard-protocol");
			incoming = {
				offer,
				content: { kind: offer.kind, items: offer.items.map((i) => ({ name: i.name, data: Buffer.alloc(i.size) })) },
				item: 0,
				offset: 0,
			};
			armIncoming();
			send({ type: "ack", id: offer.id });
			return;
		}
		if (!incoming || v.id !== incoming.offer.id) return fail("clipboard-protocol");
		if (v.type === "chunk") {
			while (
				incoming.item < incoming.content.items.length &&
				incoming.offset === incoming.content.items[incoming.item].data.length
			) {
				incoming.item++;
				incoming.offset = 0;
			}
			const item = incoming.content.items[incoming.item];
			if (
				!item ||
				v.item !== incoming.item ||
				v.offset !== incoming.offset ||
				typeof v.data !== "string" ||
				v.data.length > Math.ceil(CLIPBOARD_LIMITS.chunk / 3) * 4 ||
				!/^[A-Za-z0-9+/]+={0,2}$/.test(v.data)
			)
				return fail("clipboard-protocol");
			const data = Buffer.from(v.data, "base64");
			if (!data.length || data.toString("base64") !== v.data || incoming.offset + data.length > item.data.length)
				return fail("clipboard-protocol");
			data.copy(item.data, incoming.offset);
			incoming.offset += data.length;
			armIncoming();
			send({ type: "ack", id: v.id });
			return;
		}
		if (v.type !== "commit") return fail("clipboard-protocol");
		const transfer = incoming;
		while (
			transfer.item < transfer.content.items.length &&
			transfer.offset === transfer.content.items[transfer.item].data.length
		) {
			transfer.item++;
			transfer.offset = 0;
		}
		if (
			transfer.item !== transfer.content.items.length ||
			transfer.content.items.some(
				(item, index) => createHash("sha256").update(item.data).digest("hex") !== transfer.offer.items[index].sha256,
			)
		)
			return fail("clipboard-integrity");
		processing = true;
		clearTimeout(incomingTimer);
		void (async () => {
			try {
				if (closed) return;
				lastApplied = clipboardDigest(transfer.content);
				await backend.write(transfer.content);
				if (!closed) send({ type: "ack", id: transfer.offer.id });
			} catch {
				fail("clipboard-write");
			} finally {
				processing = false;
				incoming = undefined;
				if (dirty && !closed) void publish();
			}
		})();
	});
	ws.once("close", close);
	ws.once("error", close);
	send({
		type: "clipboard-capabilities",
		manualText: true,
		kinds: ["text", "image", "files"],
		maxBytes: CLIPBOARD_LIMITS.bytes,
		maxFiles: CLIPBOARD_LIMITS.files,
	});
	return close;
}

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
