import net, { type Socket } from "node:net";
import https from "node:https";
import type { ClientRequest } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { WebSocket } from "ws";
import { cleanHeaders, RELAY_LIMITS, safePath, WS_MESSAGE_BYTES } from "./relay.js";
import { desktopDownloadLimit } from "./desktop-files-protocol.js";
import type { DeviceLanConnection } from "./device-lan.js";

// Each ordered DataChannel is bridged by the existing helper to one loopback TCP stream.
// The PSK and local pi credential stay in the device process, never in the browser.
export async function createBrowserPeerGateway(connection: DeviceLanConnection) {
	const key = randomBytes(32).toString("hex");
	const sockets = new Set<Socket>();
	let closed = false;
	const server = net.createServer((socket) => {
		if (closed || sockets.size >= 32) return socket.destroy();
		// Frame delimiters and input/ACK records must not wait for Nagle's timer.
		socket.setNoDelay(true);
		sockets.add(socket);
		let buffer = Buffer.alloc(0),
			started = false,
			kind = "",
			ended = false,
			bytes = 0,
			stopped = false;
		let request: ClientRequest | undefined, ws: WebSocket | undefined;
		let chunks: Buffer[] = [],
			messageBytes = 0,
			unacked = 0,
			inputLimit = RELAY_LIMITS.body;
		const wake = new Set<() => void>();
		const timer = setTimeout(() => socket.destroy(), 5000);
		const stop = () => {
			if (stopped) return;
			stopped = true;
			clearTimeout(timer);
			request?.destroy();
			ws?.terminate();
			sockets.delete(socket);
			for (const notify of wake) notify();
			wake.clear();
			socket.destroy();
		};
		socket.on("error", stop);
		socket.on("close", stop);
		const write = async (type: number, data = Buffer.alloc(0)) => {
			if (socket.destroyed || data.length > 65536) throw new Error("Browser peer stream closed");
			const header = Buffer.alloc(5);
			header[0] = type;
			header.writeUInt32BE(data.length, 1);
			if (!socket.write(Buffer.concat([header, data])))
				await new Promise<void>((resolve, reject) => {
					const detach = () => {
						socket.off("drain", drained);
						socket.off("close", closed);
						socket.off("error", closed);
					};
					const drained = () => {
						detach();
						resolve();
					};
					const closed = () => {
						detach();
						reject(new Error("Browser peer stream closed"));
					};
					socket.once("drain", drained);
					socket.once("close", closed);
					socket.once("error", closed);
				});
		};
		const json = (value: object) => write(1, Buffer.from(JSON.stringify(value)));
		const waitCredit = () =>
			new Promise<void>((resolve) => {
				wake.add(resolve);
			});
		const open = (data: Buffer) => {
			if (started || data.length > 16384) throw new Error("Invalid browser peer request");
			const value = JSON.parse(data.toString());
			if (
				typeof value.key !== "string" ||
				value.key.length !== key.length ||
				!timingSafeEqual(Buffer.from(value.key), Buffer.from(key)) ||
				!["http", "ws"].includes(value.kind) ||
				!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(value.method) ||
				typeof value.path !== "string" ||
				value.path.length > 8192 ||
				value.path.includes("#") ||
				!safePath(value.path, value.kind === "ws" ? "WS" : value.method) ||
				value.path.startsWith("/__") ||
				!value.headers ||
				typeof value.headers !== "object" ||
				Array.isArray(value.headers)
			)
				throw new Error("Unauthorized browser peer request");
			started = true;
			kind = value.kind;
			clearTimeout(timer);
			socket.setTimeout(desktopDownloadLimit(value.path, value.method) ? 30 * 60_000 : 60_000, stop);
			const headers = cleanHeaders(value.headers);
			delete headers["content-length"];
			headers["accept-encoding"] = "identity";
			const url = new URL(value.path, connection.origin);
			if (url.origin !== connection.origin) throw new Error("Invalid browser peer destination");
			if (kind === "http") {
				const outputLimit = desktopDownloadLimit(value.path, value.method) ?? RELAY_LIMITS.body;
				request = https.request(url, { method: value.method, headers, agent: connection.agent }, (response) => {
					void (async () => {
						await json({
							kind: "response",
							status: response.statusCode ?? 502,
							headers: cleanHeaders(response.headers),
						});
						let size = 0;
						for await (const raw of response) {
							const data = Buffer.from(raw);
							size += data.length;
							if (size > outputLimit) throw new Error("Browser peer response too large");
							for (let offset = 0; offset < data.length; offset += 32768) {
								while (unacked >= 256 * 1024 && !socket.destroyed) await waitCredit();
								const part = data.subarray(offset, offset + 32768);
								unacked += part.length;
								await write(2, part);
							}
						}
						await write(3);
					})().catch(stop);
				});
				request.on("error", stop);
			} else {
				if (value.method !== "GET") throw new Error("Invalid WebSocket method");
				inputLimit = url.pathname === "/desktop-ws" ? 16384 : WS_MESSAGE_BYTES;
				url.protocol = "wss:";
				ws = new WebSocket(url, {
					agent: connection.agent,
					headers,
					perMessageDeflate: false,
					maxPayload: url.pathname === "/desktop-ws" ? 4 * 1024 * 1024 : WS_MESSAGE_BYTES,
					handshakeTimeout: 8000,
				});
				ws.on("error", stop);
				ws.on("open", () => {
					socket.setTimeout(0);
					void json({ kind: "open" }).catch(stop);
				});
				let sending = Promise.resolve(),
					queued = 0;
				ws.on("message", (raw, binary) => {
					const data = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as Buffer);
					queued += data.length;
					if (queued > 8 * 1024 * 1024) return stop();
					ws!.pause();
					sending = sending
						.then(async () => {
							for (let offset = 0; offset < data.length; offset += 32768)
								await write(2, data.subarray(offset, offset + 32768));
							await write(4, Buffer.from(binary ? "1" : "0"));
							queued -= data.length;
							if (!queued && ws?.readyState === WebSocket.OPEN) ws.resume();
						})
						.catch(stop);
				});
				ws.on("close", (code) => {
					void sending.then(() => json({ kind: "close", code })).catch(stop);
				});
			}
		};
		const record = (type: number, data: Buffer) => {
			if (type === 0) return open(data);
			if (!started) throw new Error("Browser peer request not opened");
			if (type === 6) return stop();
			if (type === 5 && kind === "http") {
				if (data.length !== 4) throw new Error("Invalid browser peer credit");
				const credit = data.readUInt32BE(0);
				if (credit > unacked) throw new Error("Invalid browser peer credit");
				unacked -= credit;
				for (const notify of wake) notify();
				wake.clear();
				return;
			}
			if (type === 2 && !ended) {
				if (kind === "http") {
					bytes += data.length;
					if (bytes > inputLimit) throw new Error("Browser peer body too large");
					if (!request!.write(data)) {
						socket.pause();
						request!.once("drain", () => socket.resume());
					}
				} else {
					messageBytes += data.length;
					if (messageBytes > inputLimit) throw new Error("Browser peer message too large");
					chunks.push(data);
				}
				return;
			}
			if (type === 3 && kind === "http" && !ended && !data.length) {
				ended = true;
				request!.end();
				return;
			}
			if (
				type === 4 &&
				kind === "ws" &&
				data.length === 1 &&
				[48, 49].includes(data[0]) &&
				ws?.readyState === WebSocket.OPEN
			) {
				if (ws.bufferedAmount + messageBytes > RELAY_LIMITS.queue) throw new Error("Browser peer queue full");
				ws.send(Buffer.concat(chunks), { binary: data[0] === 49 });
				chunks = [];
				messageBytes = 0;
				return;
			}
			throw new Error("Invalid browser peer record");
		};
		socket.on("data", (data) => {
			try {
				buffer = Buffer.concat([buffer, Buffer.from(data)]);
				while (buffer.length >= 5) {
					const length = buffer.readUInt32BE(1);
					if (length > 65536) throw new Error("Invalid frame length");
					if (buffer.length < length + 5) break;
					const type = buffer[0],
						payload = Buffer.from(buffer.subarray(5, 5 + length));
					buffer = buffer.subarray(5 + length);
					record(type, payload);
				}
			} catch {
				stop();
			}
		});
	});
	server.maxConnections = 32;
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return {
		key,
		port: (server.address() as net.AddressInfo).port,
		close() {
			closed = true;
			for (const socket of sockets) socket.destroy();
			server.close();
			connection.close();
		},
	};
}
