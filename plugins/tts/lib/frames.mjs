import { FRAME_HEADER_BYTES, WS_ENDPOINT, WS_MODE } from "./constants.mjs";
import { transportError, usageError } from "./errors.mjs";

function asByteView(input) {
	if (input instanceof ArrayBuffer) {
		return { buffer: input, byteOffset: 0, byteLength: input.byteLength };
	}
	if (ArrayBuffer.isView(input)) {
		return { buffer: input.buffer, byteOffset: input.byteOffset, byteLength: input.byteLength };
	}
	throw usageError("帧数据必须是 ArrayBuffer 或 TypedArray，收到了 " + typeof input);
}

export function parseAudioFrame(input) {
	const view = asByteView(input);
	if (view.byteLength < FRAME_HEADER_BYTES) {
		throw transportError(`二进制帧只有 ${view.byteLength} 字节，连 4 字节的 seq 头都不够`);
	}
	const dv = new DataView(view.buffer, view.byteOffset, view.byteLength);
	const seq = dv.getUint32(0, false);
	const payload = new Uint8Array(
		view.buffer,
		view.byteOffset + FRAME_HEADER_BYTES,
		view.byteLength - FRAME_HEADER_BYTES,
	);
	return { seq, payload };
}

function encodeAudioFrame(seq, payload) {
	const body = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
	const out = new Uint8Array(FRAME_HEADER_BYTES + body.length);
	new DataView(out.buffer).setUint32(0, seq >>> 0, false);
	out.set(body, FRAME_HEADER_BYTES);
	return out;
}

export function buildTtsUrl({
	endpoint = WS_ENDPOINT,
	sessionId,
	messageId,
	ticket,
	mode = WS_MODE,
	format = "pcm",
	resume,
} = {}) {
	if (!sessionId) throw usageError("buildTtsUrl 缺 sessionId");
	if (!messageId) throw usageError("buildTtsUrl 缺 messageId");
	if (!ticket) throw usageError("buildTtsUrl 缺 ticket");

	const qs = new URLSearchParams();
	qs.set("chat_session_id", String(sessionId));
	qs.set("message_id", String(messageId));
	qs.set("ticket", String(ticket));
	qs.set("mode", mode);
	qs.set("format", format);

	if (resume) {
		qs.set("audio_id", String(resume.audioId));
		qs.set("received_seq", String(resume.receivedSeq));
		qs.set("played_seq", String(resume.playedSeq));
	}

	const sep = endpoint.includes("?") ? "&" : "?";
	return `${endpoint}${sep}${qs.toString()}`;
}

export class FrameAssembler {
	#baseline = null;
	#emitNext = null;

	constructor() {
		this.frames = new Map();
		this.pending = new Map();
		this.duplicates = 0;
		this.outOfOrder = 0;
		this.emittedCount = 0;
		this.maxSeq = -1;
		this.minSeq = null;
	}

	get receivedCount() {
		return this.frames.size;
	}

	get receivedBytes() {
		let n = 0;
		for (const b of this.frames.values()) n += b.length;
		return n;
	}

	push(seq, payload) {
		if (!Number.isInteger(seq) || seq < 0) {
			throw transportError(`非法 seq: ${String(seq)}`);
		}
		if (this.maxSeq >= 0 && seq < this.maxSeq) this.outOfOrder++;

		if (this.frames.has(seq)) {
			this.duplicates++;
			return { accepted: false, reason: "duplicate", emitted: [] };
		}

		const buf = Buffer.isBuffer(payload)
			? payload
			: Buffer.from(payload.buffer ?? payload, payload.byteOffset ?? 0, payload.byteLength ?? payload.length);

		this.frames.set(seq, buf);
		this.pending.set(seq, buf);

		if (this.#baseline === null) {
			this.#baseline = seq;
			this.#emitNext = seq;
		} else if (this.emittedCount === 0 && seq < this.#baseline) {
			this.#baseline = seq;
			this.#emitNext = seq;
		}

		if (seq > this.maxSeq) this.maxSeq = seq;
		if (this.minSeq === null || seq < this.minSeq) this.minSeq = seq;

		const emitted = [];
		while (this.pending.has(this.#emitNext)) {
			emitted.push(this.pending.get(this.#emitNext));
			this.pending.delete(this.#emitNext);
			this.#emitNext++;
			this.emittedCount++;
		}

		return { accepted: true, reason: null, emitted };
	}

	assemble() {
		const seqs = [...this.frames.keys()].sort((a, b) => a - b);
		let total = 0;
		for (const s of seqs) total += this.frames.get(s).length;
		const audio = Buffer.allocUnsafe(total);
		let off = 0;
		for (const s of seqs) {
			const b = this.frames.get(s);
			b.copy(audio, off);
			off += b.length;
		}
		return { audio, seqs };
	}

	audit() {
		const { audio, seqs } = this.assemble();
		const missing = [];
		for (let i = 1; i < seqs.length; i++) {
			if (seqs[i] !== seqs[i - 1] + 1) {
				for (let s = seqs[i - 1] + 1; s < seqs[i]; s++) missing.push(s);
			}
		}
		return {
			audio,
			seqs,
			missing,
			duplicates: this.duplicates,
			outOfOrder: this.outOfOrder,
			receivedCount: this.frames.size,
			emittedCount: this.emittedCount,
			contiguous: missing.length === 0,
			fullyEmitted: this.pending.size === 0,
			pendingSeqs: [...this.pending.keys()].sort((a, b) => a - b),
			firstSeq: seqs.length ? seqs[0] : null,
			lastSeq: seqs.length ? seqs[seqs.length - 1] : null,
		};
	}
}

function assembleFrames(entries) {
	const asm = new FrameAssembler();
	for (const e of entries) asm.push(e.seq, e.payload);
	return asm.audit();
}
