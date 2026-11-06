import { Buffer } from "node:buffer";
import type { ClientMessage } from "./protocol.js";
import { WS_MAX_PAYLOAD_BYTES } from "./payload-limits.js";

export const MAX_PENDING_WS_MESSAGES = 256;
export const MAX_PENDING_WS_BYTES = 8 * 1024 * 1024;
export const MAX_PRE_HELLO_WS_BYTES = 16 * 1024;
export const MAX_CONTROL_WS_BYTES = 1024 * 1024;
export const MAX_ATTACHMENT_WS_BYTES = WS_MAX_PAYLOAD_BYTES;

export function isClientMessageEnvelope(value: unknown): value is { type: string } {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return false;
	return (
		Object.hasOwn(value, "type") &&
		"type" in value &&
		typeof value.type === "string" &&
		value.type.length > 0 &&
		value.type.length <= 128
	);
}

export function clientMessageByteLimit(type: string, helloReceived = true): number {
	if (!helloReceived || type === "hello") return MAX_PRE_HELLO_WS_BYTES;
	switch (type) {
		case "upload_file":
		case "prompt":
		case "edit_message":
			return MAX_ATTACHMENT_WS_BYTES;
		default:
			return MAX_CONTROL_WS_BYTES;
	}
}

export function isClientMessageWithinByteLimit(type: string, wireBytes: number, helloReceived = true): boolean {
	return Number.isSafeInteger(wireBytes) && wireBytes >= 0 && wireBytes <= clientMessageByteLimit(type, helloReceived);
}

export const PENDING_DROP_WARN_INTERVAL_MS = 60_000;
let lastWarnAt = Number.NEGATIVE_INFINITY;

export function warnPendingDrop(totalDropped: number, log: (line: string) => void): void {
	const now = Date.now();
	if (now - lastWarnAt < PENDING_DROP_WARN_INTERVAL_MS) return;
	lastWarnAt = now;
	log(`[ws] attach 未完成，命令队列超限拒绝新消息（累计 ${totalDropped} 条）`);
}

export function resetPendingDropWarn(): void {
	lastWarnAt = Number.NEGATIVE_INFINITY;
}

export class PendingCommandQueue {
	private items: ClientMessage[] = [];
	private droppedTotal = 0;
	private queuedBytes = 0;

	constructor(
		readonly cap: number = MAX_PENDING_WS_MESSAGES,
		readonly byteCap: number = MAX_PENDING_WS_BYTES,
	) {
		if (!Number.isSafeInteger(cap) || cap < 0 || !Number.isSafeInteger(byteCap) || byteCap < 0) {
			throw new RangeError("Pending queue limits must be non-negative safe integers");
		}
	}

	push(msg: ClientMessage, wireBytes?: number): boolean {
		if (this.items.length >= this.cap) return this.reject();
		let bytes: number;
		try {
			bytes = wireBytes ?? Buffer.byteLength(JSON.stringify(msg), "utf8");
		} catch {
			return this.reject();
		}
		if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.byteCap - this.queuedBytes) return this.reject();
		this.items.push(msg);
		this.queuedBytes += bytes;
		return true;
	}

	private reject(): false {
		this.droppedTotal++;
		warnPendingDrop(this.droppedTotal, (line) => console.warn(line));
		return false;
	}

	drain(): ClientMessage[] {
		const out = this.items;
		this.clear();
		return out;
	}

	clear(): void {
		this.items = [];
		this.queuedBytes = 0;
	}

	get dropped(): number {
		return this.droppedTotal;
	}

	get bytes(): number {
		return this.queuedBytes;
	}

	get size(): number {
		return this.items.length;
	}
}
