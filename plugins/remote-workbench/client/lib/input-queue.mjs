import { decodeBytes, encodeInput } from "./workbench-state.mjs";

export function createInputQueue(send, onError, limit = 65536) {
	const chunks = [];
	const queueId = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);
	let bytes = 0,
		pending = null,
		blocked = false,
		disposed = false,
		counter = 0,
		drainVersion = 0;
	function pump() {
		if (disposed || blocked || pending || !chunks.length) return;
		pending = { reqId: `input_${queueId}_${++counter}`, chunk: chunks[0], drainVersion };
		send(pending.reqId, btoa(Array.from(pending.chunk, (v) => String.fromCharCode(v)).join("")));
	}
	return {
		enqueue(text) {
			const data = decodeBytes(encodeInput(text));
			if (disposed) return false;
			if (bytes + data.length > limit) {
				onError(`输入队列超过 ${limit} 字节，请等待后再发送；此次输入未发送`);
				return false;
			}
			for (let offset = 0; offset < data.length; offset += 16384) chunks.push(data.slice(offset, offset + 16384));
			bytes += data.length;
			pump();
			return true;
		},
		reply(msg) {
			if (!pending || msg.reqId !== pending.reqId) return false;
			const attempt = pending;
			pending = null;
			if (msg.ok && msg.accepted) {
				chunks.shift();
				bytes -= attempt.chunk.length;
				blocked = msg.writable === false && drainVersion === attempt.drainVersion;
			} else {
				blocked = true;
				onError(msg.error || "输入尚未接受，已保留等待恢复");
			}
			pump();
			return true;
		},
		drain() {
			drainVersion++;
			blocked = false;
			pump();
		},
		dispose() {
			disposed = true;
			chunks.length = 0;
			bytes = 0;
			pending = null;
		},
		get bytes() {
			return bytes;
		},
	};
}
