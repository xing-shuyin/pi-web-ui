import { WebSocket } from "ws";
import type { ClipboardBackend } from "./desktop-clipboard-native.js";
import { CLIPBOARD_LIMITS, parseClipboardOffer, type ClipboardOffer } from "./desktop-clipboard-protocol.js";
import {
	bufferClipboardSource,
	memoryClipboardSink,
	type ClipboardSource,
	type ClipboardSink,
} from "./desktop-clipboard-transfer.js";

/** Explicit consent, bounded flow control, and disk-backed file transfers. */
export function clipboardConnection(ws: WebSocket, backend: ClipboardBackend, writable: boolean) {
	let closed = false,
		started = false,
		canRead = false,
		canWrite = false,
		manual = false,
		reading = false,
		dirty = false;
	let stream = false,
		maxBytes: number = CLIPBOARD_LIMITS.bytes,
		window = 1;
	let stopWatch: (() => void) | undefined,
		lastSent = "",
		lastApplied = "";
	const lifetime = new AbortController();
	let incoming: { offer: ClipboardOffer; sink: ClipboardSink; seq: number; bytes: number } | undefined;
	let outgoing:
		| {
				source: ClipboardSource;
				iterator: ReturnType<ClipboardSource["chunks"]>;
				phase: "offer" | "chunks" | "commit";
				seq: number;
				pending: Set<number>;
				pumping: boolean;
				done: boolean;
				bytes: number;
		  }
		| undefined;
	let timer: ReturnType<typeof setTimeout> | undefined, incomingTimer: ReturnType<typeof setTimeout> | undefined;
	let queue = Promise.resolve(),
		queued = 0;
	const ignored = new Set<string>();
	function ignore(id: string) {
		ignored.add(id);
		if (ignored.size > 16) ignored.delete(ignored.values().next().value!);
	}
	const send = (value: object) => {
		if (closed || ws.readyState !== WebSocket.OPEN) return;
		if (ws.bufferedAmount > CLIPBOARD_LIMITS.message * (CLIPBOARD_LIMITS.window + 2)) {
			close();
			return;
		}
		ws.send(JSON.stringify(value));
	};
	function close() {
		if (closed) return;
		closed = true;
		lifetime.abort();
		stopWatch?.();
		clearTimeout(timer);
		clearTimeout(incomingTimer);
		const out = outgoing;
		outgoing = undefined;
		void out?.source.close();
		void queue
			.finally(async () => {
				await incoming?.sink.abort();
				incoming = undefined;
			})
			.catch(() => {});
		ws.close();
	}
	function fatal(code: string) {
		send({ type: "clipboard-error", code });
		close();
	}
	async function cancel(id: string) {
		ignore(id);
		if (outgoing?.source.offer.id === id) {
			const out = outgoing;
			outgoing = undefined;
			clearTimeout(timer);
			await out.source.close();
		}
		if (incoming?.offer.id === id) {
			const current = incoming;
			incoming = undefined;
			clearTimeout(incomingTimer);
			await current.sink.abort();
		}
	}
	function warn(code: string, id?: string) {
		if (id && stream) send({ type: "abort", id });
		send({ type: "clipboard-error", code, recoverable: true });
	}
	async function failed(code: string, id?: string) {
		if (id) await cancel(id);
		warn(code, id);
		if (dirty) void publish();
	}
	const errorCode = (error: unknown, fallback: string) =>
		error instanceof Error && /^clipboard-[a-z]+$/.test(error.message) ? error.message : fallback;
	let lastProgress = 0;
	function progress(direction: "send" | "receive", bytes: number, offer: ClipboardOffer) {
		const total = offer.items.reduce((sum, item) => sum + item.size, 0);
		if (Date.now() - lastProgress < 250 && bytes !== total) return;
		lastProgress = Date.now();
		send({ type: "clipboard-progress", direction, bytes, total });
	}
	function armOutgoing() {
		clearTimeout(timer);
		timer = setTimeout(() => {
			const id = outgoing?.source.offer.id;
			if (id) void failed("clipboard-timeout", id);
		}, CLIPBOARD_LIMITS.timeout);
		timer.unref();
	}
	function armIncoming() {
		clearTimeout(incomingTimer);
		incomingTimer = setTimeout(() => {
			const id = incoming?.offer.id;
			if (id) {
				queue = queue.then(() => failed("clipboard-timeout", id));
			}
		}, CLIPBOARD_LIMITS.timeout);
		incomingTimer.unref();
	}
	function packet(out: NonNullable<typeof outgoing>, value: object) {
		const seq = ++out.seq;
		out.pending.add(seq);
		send({ ...value, ...(stream ? { seq } : {}) });
		armOutgoing();
	}
	async function pump() {
		const out = outgoing;
		if (!out || out.pumping || out.phase !== "chunks" || closed) return;
		out.pumping = true;
		try {
			while (outgoing === out && !closed && out.pending.size < window) {
				if (!out.done) {
					const next = await out.iterator.next();
					if (closed || outgoing !== out) return;
					if (!next.done) {
						packet(out, {
							type: "chunk",
							id: out.source.offer.id,
							...next.value,
							data: next.value.data.toString("base64"),
						});
						out.bytes += next.value.data.length;
						progress("send", out.bytes, out.source.offer);
						continue;
					}
					out.done = true;
				}
				if (!out.pending.size) {
					out.phase = "commit";
					packet(out, { type: "commit", id: out.source.offer.id });
				}
				break;
			}
		} catch (error) {
			if (outgoing === out && !closed) await failed(errorCode(error, "clipboard-read"), out.source.offer.id);
		} finally {
			out.pumping = false;
		}
	}
	async function publish() {
		if (closed || !canRead) return;
		if (outgoing || reading || incoming) {
			dirty = true;
			return;
		}
		dirty = false;
		reading = true;
		send({ type: "clipboard-preparing" });
		let source: ClipboardSource | undefined;
		try {
			if (backend.readSource) source = await backend.readSource(lifetime.signal, maxBytes);
			else {
				const content = await backend.read();
				if (content) source = bufferClipboardSource(content);
			}
			if (closed || !source || source.digest === lastSent || source.digest === lastApplied) {
				await source?.close();
				send({ type: "clipboard-idle" });
				return;
			}
			if (!parseClipboardOffer(source.offer, maxBytes)) throw new Error("clipboard-size");
			outgoing = {
				source,
				iterator: source.chunks(),
				phase: "offer",
				seq: -1,
				pending: new Set(),
				pumping: false,
				done: false,
				bytes: 0,
			};
			packet(outgoing, source.offer);
		} catch (error) {
			await source?.close();
			if (!closed) warn(errorCode(error, "clipboard-read"));
		} finally {
			reading = false;
			if (dirty && !outgoing && !incoming && !closed)
				setTimeout(() => {
					void publish();
				}, 0);
		}
	}
	async function receive(v: Record<string, any>) {
		if (closed) return;
		if (typeof v.id === "string" && ignored.has(v.id)) return;
		if (v.type === "ack") {
			const out = outgoing;
			if (!out || v.id !== out.source.offer.id) throw new Error("clipboard-protocol");
			const seq = stream ? v.seq : out.pending.values().next().value;
			if (!Number.isInteger(seq) || !out.pending.delete(seq)) throw new Error("clipboard-protocol");
			clearTimeout(timer);
			if (out.pending.size) armOutgoing();
			if (out.phase === "offer") out.phase = "chunks";
			else if (out.phase === "commit") {
				lastSent = out.source.digest;
				outgoing = undefined;
				ignore(v.id);
				await out.source.close();
				send({ type: "clipboard-complete" });
				if (dirty) void publish();
				return;
			}
			void pump();
			return;
		}
		if (
			v.type === "abort" &&
			stream &&
			typeof v.id === "string" &&
			(incoming?.offer.id === v.id || outgoing?.source.offer.id === v.id)
		) {
			await cancel(v.id);
			if (dirty) void publish();
			return;
		}
		if (v.type === "start" && !started && typeof v.read === "boolean" && typeof v.write === "boolean") {
			started = true;
			manual = v.manual === true;
			canRead = v.read;
			canWrite = v.write && writable;
			if (v.write && !writable) return fatal("clipboard-readonly");
			stream = !manual && v.streamFiles === true;
			maxBytes =
				stream && Number.isSafeInteger(v.maxBytes)
					? Math.min(CLIPBOARD_LIMITS.fileBytes, Math.max(CLIPBOARD_LIMITS.bytes, v.maxBytes))
					: CLIPBOARD_LIMITS.bytes;
			window = stream ? CLIPBOARD_LIMITS.window : 1;
			send({ type: "clipboard-ready", read: canRead, write: canWrite });
			if (canRead && !manual) {
				try {
					stopWatch = backend.watch(() => {
						dirty = true;
						void publish();
					});
				} catch {
					fatal("clipboard-unavailable");
				}
			}
			return;
		}
		if (started && manual && (v.type === "text-read" || v.type === "text-write")) {
			if ((v.type === "text-read" && !canRead) || (v.type === "text-write" && !canWrite))
				return fatal("clipboard-direction");
			if (v.type === "text-write" && (typeof v.text !== "string" || Buffer.byteLength(v.text) > 16384))
				return fatal("clipboard-size");
			try {
				if (v.type === "text-write") {
					await backend.write({ kind: "text", items: [{ name: "text.txt", data: Buffer.from(v.text) }] });
					send({ type: "text-result", written: true });
				} else {
					const content = await backend.read();
					if (content && content.kind !== "text") return send({ type: "text-result", error: "clipboard-not-text" });
					const data = content?.items[0]?.data;
					if (data && data.length > 16384) return send({ type: "text-result", error: "clipboard-size" });
					send({ type: "text-result", text: data?.toString("utf8") ?? "" });
				}
			} catch {
				send({ type: "text-result", error: "clipboard-unavailable" });
			}
			return;
		}
		if (!started || !canWrite || manual) return fatal("clipboard-direction");
		if (v.type === "offer") {
			const offer = parseClipboardOffer(
				v,
				stream && backend.receiveFiles ? CLIPBOARD_LIMITS.fileBytes : CLIPBOARD_LIMITS.bytes,
			);
			if (!offer || incoming || (stream && v.seq !== 0)) throw new Error("clipboard-protocol");
			const sink =
				offer.kind === "files" && backend.receiveFiles
					? await backend.receiveFiles(offer, lifetime.signal)
					: memoryClipboardSink(offer, (content) => backend.write(content));
			if (closed) {
				await sink.abort();
				return;
			}
			incoming = { offer, sink, seq: 0, bytes: 0 };
			armIncoming();
			send({ type: "ack", id: offer.id, ...(stream ? { seq: 0 } : {}) });
			return;
		}
		const transfer = incoming;
		if (!transfer || v.id !== transfer.offer.id || (stream && v.seq !== transfer.seq + 1))
			throw new Error("clipboard-protocol");
		transfer.seq++;
		if (v.type === "chunk") {
			if (
				typeof v.data !== "string" ||
				v.data.length > Math.ceil(CLIPBOARD_LIMITS.chunk / 3) * 4 ||
				!/^[A-Za-z0-9+/]+={0,2}$/.test(v.data)
			)
				throw new Error("clipboard-protocol");
			const data = Buffer.from(v.data, "base64");
			if (!data.length || data.toString("base64") !== v.data) throw new Error("clipboard-protocol");
			await transfer.sink.write(v.item, v.offset, data);
			transfer.bytes += data.length;
			armIncoming();
			progress("receive", transfer.bytes, transfer.offer);
		} else if (v.type === "commit") {
			clearTimeout(incomingTimer);
			lastApplied = await transfer.sink.finish();
			incoming = undefined;
			send({ type: "clipboard-complete" });
		} else throw new Error("clipboard-protocol");
		send({ type: "ack", id: v.id, ...(stream ? { seq: v.seq } : {}) });
		if (!incoming && dirty) void publish();
	}
	ws.on("message", (raw, binary) => {
		if (closed) return;
		if (
			binary ||
			(Array.isArray(raw) ? raw.reduce((n, b) => n + b.length, 0) : raw.byteLength) > CLIPBOARD_LIMITS.message ||
			queued >= CLIPBOARD_LIMITS.window + 4
		)
			return fatal("clipboard-protocol");
		let value: Record<string, any>;
		try {
			value = JSON.parse(raw.toString());
			if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
		} catch {
			return fatal("clipboard-protocol");
		}
		queued++;
		queue = queue
			.then(() => receive(value))
			.catch(async (error) => {
				const code = errorCode(error, "clipboard-write");
				if (code === "clipboard-protocol" || code === "clipboard-integrity") fatal(code);
				else await failed(code, typeof value.id === "string" ? value.id : undefined);
			})
			.finally(() => {
				queued--;
			});
	});
	ws.once("close", close);
	ws.once("error", close);
	send({
		type: "clipboard-capabilities",
		manualText: true,
		kinds: ["text", "image", "files"],
		maxBytes: CLIPBOARD_LIMITS.bytes,
		maxFiles: CLIPBOARD_LIMITS.files,
		streamFiles: true,
		maxFileBytes: backend.receiveFiles ? CLIPBOARD_LIMITS.fileBytes : CLIPBOARD_LIMITS.bytes,
	});
	return close;
}
