/** Serialized into the trusted wrapper and its opaque child; no ambient server state. */
function peerSocketClass(open: any) {
	const win = Reflect.get(globalThis, "window") as any;
	return class PeerSocket extends win.EventTarget {
		static CONNECTING = 0;
		static OPEN = 1;
		static CLOSING = 2;
		static CLOSED = 3;
		CONNECTING = 0;
		OPEN = 1;
		CLOSING = 2;
		CLOSED = 3;
		readyState = 0;
		binaryType = "blob";
		bufferedAmount = 0;
		protocol = "";
		extensions = "";
		onopen: any;
		onmessage: any;
		onerror: any;
		onclose: any;
		url: string;
		bridge: any;
		sending = Promise.resolve();
		constructor(url: string, protocols?: any) {
			super();
			this.url = String(url);
			void open(this.url, protocols, (kind: string, data: any) => {
				if (this.readyState === 3) return;
				if (kind === "open") this.readyState = 1;
				if (kind === "close") this.readyState = 3;
				let event: any;
				if (kind === "message")
					event = new win.MessageEvent(kind, {
						data: typeof data === "string" || this.binaryType === "arraybuffer" ? data : new win.Blob([data]),
					});
				else if (kind === "close")
					event = new win.CloseEvent(kind, { code: data?.code || 1006, wasClean: data?.code === 1000 });
				else event = new win.Event(kind);
				this.dispatchEvent(event);
				(this as any)["on" + kind]?.call(this, event);
			})
				.then((bridge: any) => {
					this.bridge = bridge;
					if (this.readyState >= 2) bridge.close();
				})
				.catch(() => {
					if (this.readyState === 3) return;
					this.readyState = 3;
					const error = new win.Event("error"),
						close = new win.CloseEvent("close", { code: 1006 });
					this.dispatchEvent(error);
					this.onerror?.(error);
					this.dispatchEvent(close);
					this.onclose?.(close);
				});
		}
		send(value: any) {
			if (this.readyState !== 1) throw new win.DOMException("WebSocket is not open", "InvalidStateError");
			const binary = typeof value !== "string";
			const size =
				typeof value === "string" ? new TextEncoder().encode(value).length : (value.size ?? value.byteLength);
			if (!Number.isSafeInteger(size) || this.bufferedAmount + size > 8 * 1024 * 1024) {
				this.close();
				return;
			}
			this.bufferedAmount += size;
			this.sending = this.sending
				.then(async () => {
					const data =
						typeof value === "string"
							? value
							: value instanceof win.Blob
								? await value.arrayBuffer()
								: ArrayBuffer.isView(value)
									? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
									: value;
					await this.bridge.send(data, binary);
					this.bufferedAmount -= size;
				})
				.catch(() => this.close());
		}
		close() {
			if (this.readyState >= 2) return;
			this.readyState = 2;
			this.bridge?.close();
		}
	};
}

function peerParent(config: { base: string; signal: string }, SocketClass: typeof peerSocketClass) {
	const win = Reflect.get(globalThis, "window") as any;
	const nativeFetch = win.fetch.bind(win),
		NativeSocket = win.WebSocket;
	const base = new URL(config.base, win.location.href),
		signalUrl = config.signal;
	let pc: any,
		bootstrap: any,
		key = "",
		active = false,
		serial = 0,
		mode = "hub",
		closing = false;
	const streams = new Set<any>();
	const frame = win.document.querySelector("iframe");
	const badge = win.document.createElement("div");
	badge.id = "browser-route";
	badge.setAttribute("role", "status");
	badge.textContent = "正在尝试浏览器直连… / Connecting directly…";
	win.document.body.prepend(badge);
	const encoder = new TextEncoder(),
		decoder = new TextDecoder();
	const route = (value: any) => {
		try {
			const url = new URL(typeof value === "string" ? value : (value.href ?? value.url), base);
			url.protocol = url.protocol.replace(/^ws/, "http");
			if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return null;
			const path = "/" + url.pathname.slice(base.pathname.length) + url.search;
			if (path.startsWith("/__") || /^\/api\/device-center\/(?:status|chat-status)(?:\?|$)/.test(path)) return null;
			return path;
		} catch {
			return null;
		}
	};
	const announce = () => {
		win.__piBrowserTransport = mode;
		badge.textContent = (
			{
				lan: "局域网直连 / LAN direct",
				p2p: "P2P 直连 / P2P direct",
				turn: "TURN 中转 / TURN relay",
				hub: "服务器中转 / Hub relay",
			} as any
		)[mode];
		const transport = mode === "turn" ? "p2p" : mode;
		frame?.contentWindow?.postMessage({ type: "device-access-transport", transport, relayed: mode === "turn" }, "*");
		if (win.parent !== win)
			win.parent.postMessage({ type: "device-access-transport", transport, relayed: mode === "turn" }, "*");
	};
	const fallback = () => {
		if (closing) return;
		closing = true;
		active = false;
		mode = "hub";
		announce();
		for (const stream of streams) stream.close();
		streams.clear();
		pc?.close();
	};
	const channel = (meta: any, record: (type: number, data: Uint8Array) => void, failed: () => void) => {
		if (!pc || streams.size >= 28) throw new Error("P2P stream limit");
		const dc = pc.createDataChannel("stream-" + ++serial, { ordered: true });
		dc.binaryType = "arraybuffer";
		let buffer = new Uint8Array(0),
			stopped = false,
			queued = 0,
			sending = Promise.resolve();
		const closed = () => {
			if (stopped) return;
			stopped = true;
			streams.delete(stream);
			failed();
		};
		const ready = new Promise<void>((resolve, reject) => {
			const timeout = win.setTimeout(() => {
				reject(new Error("P2P stream timeout"));
				stream.close();
			}, 12000);
			dc.addEventListener(
				"open",
				() => {
					win.clearTimeout(timeout);
					resolve();
				},
				{ once: true },
			);
			dc.addEventListener(
				"close",
				() => {
					win.clearTimeout(timeout);
					reject(new Error("P2P stream closed"));
				},
				{ once: true },
			);
		});
		const send = (type: number, data: Uint8Array = new Uint8Array(0)) => {
			if (data.length > 65536 || queued + data.length > 8 * 1024 * 1024)
				return Promise.reject(new Error("P2P queue full"));
			const bytes = new Uint8Array(data.length + 5);
			bytes[0] = type;
			new DataView(bytes.buffer).setUint32(1, data.length);
			bytes.set(data, 5);
			queued += bytes.length;
			const result = sending.then(async () => {
				await ready;
				const start = Date.now();
				for (let offset = 0; offset < bytes.length; offset += 16384) {
					while (dc.bufferedAmount > 256 * 1024 && dc.readyState === "open") {
						if (Date.now() - start > 30000) throw new Error("P2P send stalled");
						await new Promise((r) => win.setTimeout(r, 10));
					}
					if (dc.readyState !== "open") throw new Error("P2P stream closed");
					dc.send(bytes.subarray(offset, offset + 16384));
				}
				queued -= bytes.length;
			});
			sending = result.catch(() => stream.close());
			return result;
		};
		const stream = {
			send,
			async data(data: Uint8Array) {
				for (let offset = 0; offset < data.length; offset += 32768)
					await send(2, data.subarray(offset, offset + 32768));
			},
			close() {
				dc.close();
				closed();
			},
			finish() {
				void send(6)
					.catch(() => {})
					.finally(() => win.setTimeout(() => stream.close(), 100));
			},
		};
		streams.add(stream);
		dc.onclose = closed;
		dc.onerror = () => stream.close();
		dc.onmessage = (event: any) => {
			try {
				const data = new Uint8Array(event.data),
					next = new Uint8Array(buffer.length + data.length);
				next.set(buffer);
				next.set(data, buffer.length);
				buffer = next;
				while (buffer.length >= 5) {
					const length = new DataView(buffer.buffer, buffer.byteOffset).getUint32(1);
					if (length > 65536) throw new Error("Invalid P2P frame");
					if (buffer.length < length + 5) break;
					const type = buffer[0],
						payload = buffer.slice(5, length + 5);
					buffer = buffer.slice(length + 5);
					record(type, payload);
				}
			} catch {
				stream.close();
			}
		};
		void send(0, encoder.encode(JSON.stringify({ ...meta, key }))).catch(() => stream.close());
		return stream;
	};
	const directFetch = async (input: any, init?: any) => {
		const request = new win.Request(input, init),
			path = route(request);
		if (!path) throw new Error("Invalid P2P request");
		let controller: any,
			header = false,
			ended = false,
			finished = false,
			queue: Uint8Array[] = [],
			stream: any;
		let resolveResponse: any, rejectResponse: any;
		const response = new Promise<any>((resolve, reject) => {
			resolveResponse = resolve;
			rejectResponse = reject;
		});
		const cancel = () => {
			if (finished) return;
			finished = true;
			request.signal.removeEventListener("abort", cancel);
			stream?.close();
			const error = new win.DOMException("Aborted", "AbortError");
			rejectResponse(error);
			controller.error(error);
		};
		const pump = () => {
			while (queue.length && controller.desiredSize > 0) {
				const data = queue.shift()!;
				controller.enqueue(data);
				const ack = new Uint8Array(4);
				new DataView(ack.buffer).setUint32(0, data.length);
				void stream.send(5, ack).catch(() => stream.close());
			}
			if (ended && !queue.length && !finished) {
				finished = true;
				request.signal.removeEventListener("abort", cancel);
				controller.close();
				stream.finish();
			}
		};
		const body = new win.ReadableStream(
			{
				start(value: any) {
					controller = value;
				},
				pull() {
					pump();
				},
				cancel() {
					cancel();
				},
			},
			{ highWaterMark: 65536, size: (chunk: Uint8Array) => chunk.byteLength },
		);
		stream = channel(
			{ kind: "http", path, method: request.method, headers: Object.fromEntries(request.headers) },
			(type, data) => {
				if (type === 1) {
					const value = JSON.parse(decoder.decode(data));
					if (header || value.kind !== "response") throw new Error("Invalid P2P response");
					header = true;
					const result = new win.Response(
						request.method === "HEAD" || [204, 205, 304].includes(value.status) ? null : body,
						{ status: value.status, headers: value.headers },
					);
					Object.defineProperty(result, "url", { value: request.url });
					resolveResponse(result);
				} else if (type === 2 && header && !ended) {
					queue.push(data);
					pump();
				} else if (type === 3 && header) {
					ended = true;
					pump();
				} else throw new Error("Invalid P2P response frame");
			},
			() => {
				if (finished) return;
				finished = true;
				request.signal.removeEventListener("abort", cancel);
				const error = new Error("Direct connection lost; retry the operation");
				rejectResponse(error);
				controller.error(error);
				fallback();
			},
		);
		if (request.signal.aborted) cancel();
		else request.signal.addEventListener("abort", cancel, { once: true });
		void (async () => {
			if (request.body) {
				const reader = request.body.getReader();
				for (;;) {
					const item = await reader.read();
					if (item.done) break;
					await stream.data(item.value);
				}
			}
			await stream.send(3);
		})().catch(() => stream.close());
		return response;
	};
	const openSocket = async (url: string, protocols: any, event: any) => {
		if (protocols?.length) throw new Error("P2P WebSocket subprotocol unsupported");
		let parts: Uint8Array[] = [],
			bytes = 0,
			ended = false;
		const stream = channel(
			{ kind: "ws", path: route(url), method: "GET", headers: {} },
			(type, data) => {
				if (type === 1) {
					const value = JSON.parse(decoder.decode(data));
					if (value.kind === "close") {
						ended = true;
						stream.finish();
					}
					event(value.kind, value);
				} else if (type === 2) {
					bytes += data.length;
					if (bytes > 16 * 1024 * 1024) throw new Error("P2P message too large");
					parts.push(data);
				} else if (type === 4) {
					const message = new Uint8Array(bytes);
					let offset = 0;
					for (const part of parts) {
						message.set(part, offset);
						offset += part.length;
					}
					parts = [];
					bytes = 0;
					event("message", data[0] === 49 ? message.buffer : decoder.decode(message));
				} else throw new Error("Invalid P2P socket frame");
			},
			() => {
				if (!ended) {
					ended = true;
					event("close", { code: 1006 });
					fallback();
				}
			},
		);
		return {
			async send(data: any, binary: boolean) {
				await stream.data(binary ? new Uint8Array(data) : encoder.encode(data));
				await stream.send(4, encoder.encode(binary ? "1" : "0"));
			},
			close() {
				ended = true;
				stream.finish();
				event("close", { code: 1000 });
			},
		};
	};
	const DirectSocket = SocketClass(openSocket);
	win.fetch = (input: any, init: any) => (active && route(input) ? directFetch(input, init) : nativeFetch(input, init));
	win.WebSocket = class extends NativeSocket {
		constructor(url: string, protocols: any) {
			if (active && route(url)) return new DirectSocket(url, protocols) as any;
			super(url, protocols);
		}
	};
	win.addEventListener("message", (event: any) => {
		if (
			event.source !== frame?.contentWindow ||
			event.origin !== "null" ||
			event.data?.type !== "pi-browser-peer" ||
			event.ports.length !== 1
		)
			return;
		const port = event.ports[0],
			data = event.data;
		if (!active || !route(data.url) || !["fetch", "ws"].includes(data.kind)) {
			port.postMessage({ type: "fallback" });
			port.close();
			return;
		}
		port.postMessage({ type: "direct" });
		if (data.kind === "ws") {
			let ws: any;
			try {
				ws = new DirectSocket(data.url, data.protocols);
				ws.binaryType = "arraybuffer";
			} catch {
				port.postMessage({ type: "error" });
				port.close();
				return;
			}
			ws.onopen = () => port.postMessage({ type: "open" });
			ws.onmessage = (e: any) => port.postMessage({ type: "message", data: e.data });
			ws.onclose = (e: any) => {
				port.postMessage({ type: "close", code: e.code });
				port.close();
			};
			port.onmessage = (e: any) => {
				if (e.data?.type === "close") ws.close();
				else if (e.data?.type === "send" && ws.readyState === 1) ws.send(e.data.data);
			};
			return;
		}
		const controller = new win.AbortController();
		let reader: any,
			pulling = false;
		port.onmessage = async (e: any) => {
			if (e.data?.type === "cancel") {
				controller.abort();
				void reader?.cancel().catch(() => {});
				port.close();
				return;
			}
			if (e.data?.type !== "pull" || !reader || pulling) return;
			pulling = true;
			try {
				const item = await reader.read();
				port.postMessage(item.done ? { type: "end" } : { type: "data", data: item.value });
				if (item.done) port.close();
			} catch {
				port.postMessage({ type: "error" });
				port.close();
			} finally {
				pulling = false;
			}
		};
		void directFetch(data.url, {
			method: data.method,
			headers: data.headers,
			body: data.body,
			signal: controller.signal,
			credentials: "omit",
		})
			.then((response: any) => {
				reader = response.body?.getReader();
				port.postMessage({
					type: "response",
					status: response.status,
					headers: Object.fromEntries(response.headers),
					body: !!reader,
				});
				if (!reader) port.close();
			})
			.catch(() => {
				port.postMessage({ type: "error" });
				port.close();
			});
	});
	const waitState = (test: () => boolean, ms: number) =>
		new Promise<void>((resolve, reject) => {
			const start = Date.now();
			const timer = win.setInterval(() => {
				if (test()) {
					win.clearInterval(timer);
					resolve();
				} else if (Date.now() - start > ms) {
					win.clearInterval(timer);
					reject(new Error("P2P connection timeout"));
				}
			}, 25);
		});
	const negotiate = async () => {
		if (!win.RTCPeerConnection) {
			fallback();
			return;
		}
		pc = new win.RTCPeerConnection({
			iceServers: ["stun:stun.miwifi.com:3478", "stun:stun.cloudflare.com:3478"].map((urls) => ({ urls })),
		});
		bootstrap = pc.createDataChannel("bootstrap", { ordered: true });
		pc.onconnectionstatechange = () => {
			if (["failed", "closed"].includes(pc.connectionState)) fallback();
		};
		await pc.setLocalDescription(await pc.createOffer());
		await waitState(() => pc.iceGatheringState === "complete", 7000).catch(() => {});
		const response = await nativeFetch(signalUrl, {
			method: "POST",
			credentials: "omit",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ version: 1, sdp: pc.localDescription.sdp }),
			signal: win.AbortSignal.timeout(15000),
		});
		if (!response.ok) throw new Error("Device browser P2P unavailable");
		const answer = await response.json();
		if (answer.version !== 1 || !/^[a-f0-9]{64}$/.test(answer.key) || typeof answer.signal?.sdp !== "string")
			throw new Error("Invalid browser P2P answer");
		key = answer.key;
		await pc.setRemoteDescription({ type: "answer", sdp: answer.signal.sdp });
		await waitState(() => bootstrap.readyState === "open", 12000);
		const health = await directFetch(new URL("api/health", base).href, { signal: win.AbortSignal.timeout(8000) });
		if (!health.ok) throw new Error("P2P health failed");
		await health.arrayBuffer();
		active = true;
		mode = "p2p";
		const stats = await pc.getStats();
		for (const item of stats.values())
			if (item.type === "candidate-pair" && item.state === "succeeded" && item.nominated) {
				const remote = stats.get(item.remoteCandidateId),
					local = stats.get(item.localCandidateId);
				if (remote?.candidateType === "relay" || local?.candidateType === "relay") mode = "turn";
				else if (
					remote?.candidateType === "host" &&
					/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|127\.|f[cd][\da-f]{2}:)/i.test(
						remote.address || remote.ip || "",
					)
				)
					mode = "lan";
			}
		announce();
	};
	win.__piBrowserPeerReady = negotiate().catch((error: any) => {
		win.console.warn("[browser-p2p]", error.message);
		fallback();
	});
	win.addEventListener("message", (event: any) => {
		if (event.source === frame?.contentWindow && event.data?.type === "device-portal-ready") announce();
	});
	win.addEventListener("pagehide", () => {
		fallback();
		void nativeFetch(signalUrl, {
			method: "POST",
			credentials: "omit",
			keepalive: true,
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ close: true, session: key }),
		}).catch(() => {});
	});
}

function peerChild(basePath: string, SocketClass: typeof peerSocketClass) {
	const win = Reflect.get(globalThis, "window") as any;
	if (win.parent === win) return;
	const base = new URL(basePath, win.location.href),
		nativeFetch = win.fetch.bind(win),
		NativeSocket = win.WebSocket;
	const route = (value: any) => {
		try {
			const url = new URL(typeof value === "string" ? value : (value.href ?? value.url), base);
			url.protocol = url.protocol.replace(/^ws/, "http");
			return url.origin === base.origin && url.pathname.startsWith(base.pathname);
		} catch {
			return false;
		}
	};
	const connect = (data: any, receive: any) => {
		const channel = new win.MessageChannel();
		channel.port1.onmessage = (event: any) => receive(event.data, channel.port1);
		win.parent.postMessage({ type: "pi-browser-peer", ...data }, "*", [channel.port2]);
		return channel.port1;
	};
	win.fetch = async (input: any, init?: any) => {
		if (!route(input)) return nativeFetch(input, init);
		const request = new win.Request(input, init),
			body = request.body ? await request.clone().arrayBuffer() : undefined;
		if (body && body.byteLength > 64 * 1024 * 1024) throw new Error("Request too large");
		return new Promise((resolve, reject) => {
			let controller: any,
				received = false,
				port: any;
			const cancel = () => {
				request.signal.removeEventListener("abort", cancel);
				port?.postMessage({ type: "cancel" });
				port?.close();
				const error = new win.DOMException("Aborted", "AbortError");
				reject(error);
				controller?.error(error);
			};
			const done = () => {
				request.signal.removeEventListener("abort", cancel);
				port.close();
			};
			port = connect(
				{ kind: "fetch", url: request.url, method: request.method, headers: Object.fromEntries(request.headers), body },
				(message: any) => {
					if (message.type === "fallback") {
						done();
						resolve(nativeFetch(request));
					} else if (message.type === "response") {
						received = true;
						const stream = message.body
							? new win.ReadableStream({
									start(value: any) {
										controller = value;
									},
									pull() {
										port.postMessage({ type: "pull" });
									},
									cancel() {
										cancel();
									},
								})
							: null;
						const response = new win.Response(stream, { status: message.status, headers: message.headers });
						Object.defineProperty(response, "url", { value: request.url });
						resolve(response);
						if (!stream) done();
					} else if (message.type === "data") controller.enqueue(message.data);
					else if (message.type === "end") {
						controller.close();
						done();
					} else if (message.type === "error") {
						const error = new Error("Direct request failed; retry after reconnecting");
						if (received) controller?.error(error);
						else reject(error);
						done();
					}
				},
			);
			if (request.signal.aborted) cancel();
			else request.signal.addEventListener("abort", cancel, { once: true });
		});
	};
	const BridgedSocket = SocketClass(
		(url: string, protocols: any, event: any) =>
			new Promise((resolve) => {
				let socket: any;
				const port = connect({ kind: "ws", url, protocols }, (data: any) => {
					if (data.type === "fallback") {
						port.close();
						socket = new NativeSocket(url, protocols);
						socket.binaryType = "arraybuffer";
						socket.onopen = () => event("open");
						socket.onmessage = (e: any) => event("message", e.data);
						socket.onerror = () => event("error");
						socket.onclose = (e: any) => event("close", { code: e.code });
						resolve({ send: (value: any) => socket.send(value), close: () => socket.close() });
					} else if (data.type === "direct")
						resolve({
							send: (value: any) => port.postMessage({ type: "send", data: value }),
							close: () => {
								port.postMessage({ type: "close" });
							},
						});
					else if (data.type === "message") event("message", data.data);
					else if (["open", "close", "error"].includes(data.type)) {
						event(data.type, data);
						if (data.type === "close") port.close();
					}
				});
			}),
	);
	win.WebSocket = class extends NativeSocket {
		constructor(url: string, protocols: any) {
			if (route(url)) return new BridgedSocket(url, protocols) as any;
			super(url, protocols);
		}
	};
}

export function browserPeerParentScript(base: string, signal: string) {
	return `{const __name=(value)=>value;(${peerParent.toString()})(${JSON.stringify({ base, signal })},${peerSocketClass.toString()});}`;
}
export function browserPeerChildScript(base: string) {
	return `{const __name=(value)=>value;(${peerChild.toString()})(${JSON.stringify(base)},${peerSocketClass.toString()});}`;
}
