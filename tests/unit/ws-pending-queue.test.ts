import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	MAX_PENDING_WS_MESSAGES,
	MAX_PENDING_WS_BYTES,
	MAX_PRE_HELLO_WS_BYTES,
	MAX_CONTROL_WS_BYTES,
	MAX_ATTACHMENT_WS_BYTES,
	PendingCommandQueue,
	clientMessageByteLimit,
	isClientMessageEnvelope,
	isClientMessageWithinByteLimit,
	resetPendingDropWarn,
} from "../../server/ws-pending-queue.js";
import { WS_MAX_PAYLOAD_BYTES } from "../../server/payload-limits.js";

const msg = (n: number) =>
	({ type: "get_state" as const, seq: n }) as unknown as Parameters<PendingCommandQueue["push"]>[0];

beforeEach(() => {
	resetPendingDropWarn();
	vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("attach-time pending command queue", () => {
	it("defaults to 256 messages and 8MiB", () => {
		const q = new PendingCommandQueue();
		expect(q.cap).toBe(MAX_PENDING_WS_MESSAGES);
		expect(q.cap).toBe(256);
		expect(q.byteCap).toBe(MAX_PENDING_WS_BYTES);
		expect(q.byteCap).toBe(8 * 1024 * 1024);
	});

	it("rejects new commands at the count limit without evicting business operations", () => {
		const q = new PendingCommandQueue(2);
		const first = msg(1);
		const second = msg(2);
		expect(q.push(first)).toBe(true);
		expect(q.push(second)).toBe(true);
		const bytes = q.bytes;
		expect(q.push(msg(3))).toBe(false);
		expect(q.bytes).toBe(bytes);
		expect(q.size).toBe(2);
		expect(q.dropped).toBe(1);
		expect(q.drain()).toEqual([first, second]);
		expect(q.size).toBe(0);
		expect(q.bytes).toBe(0);
		expect(q.drain()).toEqual([]);
	});

	it("enforces cumulative bytes inclusively and leaves room after rejecting an oversized message", () => {
		const q = new PendingCommandQueue(10, 100);
		expect(q.push(msg(1), 60)).toBe(true);
		expect(q.push(msg(2), 41)).toBe(false);
		expect(q.bytes).toBe(60);
		expect(q.push(msg(3), 40)).toBe(true);
		expect(q.push(msg(4), 1)).toBe(false);
		expect(q.drain()).toEqual([msg(1), msg(3)]);
		expect(q.bytes).toBe(0);
		expect(q.push(msg(5), 100)).toBe(true);
		q.clear();
		expect(q.size).toBe(0);
		expect(q.bytes).toBe(0);
		expect(q.dropped).toBe(2);
		expect(q.push(msg(6), 100)).toBe(true);
	});

	it("uses UTF-8 byte length for legacy push(msg) calls", () => {
		const command = { type: "prompt" as const, text: "你好🌍" };
		const bytes = Buffer.byteLength(JSON.stringify(command), "utf8");
		const q = new PendingCommandQueue(10, bytes);
		expect(q.push(command)).toBe(true);
		expect(q.bytes).toBe(bytes);
		expect(q.push(msg(1))).toBe(false);
	});

	it("does not stringify when raw wire bytes are supplied or the count budget is full", () => {
		const command = msg(1);
		Object.defineProperty(command, "toJSON", {
			value: () => {
				throw new Error("must not serialize");
			},
		});
		const q = new PendingCommandQueue(1, 100);
		expect(q.push(command, 30)).toBe(true);
		expect(q.bytes).toBe(30);
		expect(q.push(command)).toBe(false);
		expect(q.drain()).toEqual([command]);
	});

	it.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid wire byte count %s", (bytes) => {
		const q = new PendingCommandQueue();
		expect(q.push(msg(1), bytes)).toBe(false);
		expect(q.size).toBe(0);
		expect(q.bytes).toBe(0);
	});

	it("rejects unserializable messages without mutating the queue", () => {
		const command = msg(1);
		Object.assign(command, { circular: command });
		const q = new PendingCommandQueue();
		expect(q.push(command)).toBe(false);
		expect(q.bytes).toBe(0);
	});

	it.each([-1, NaN, Infinity, 0.5])("rejects invalid constructor budgets %s", (cap) => {
		expect(() => new PendingCommandQueue(cap)).toThrow(RangeError);
		expect(() => new PendingCommandQueue(1, cap)).toThrow(RangeError);
	});

	it("supports zero capacity and throttles rejection warnings", () => {
		vi.spyOn(Date, "now").mockReturnValue(0);
		const q = new PendingCommandQueue(0);
		expect(q.push(msg(1))).toBe(false);
		expect(q.push(msg(2))).toBe(false);
		expect(console.warn).toHaveBeenCalledTimes(1);
		expect(console.warn).toHaveBeenLastCalledWith(expect.stringContaining("拒绝新消息"));
		vi.mocked(Date.now).mockReturnValue(60_000);
		q.push(msg(3));
		expect(console.warn).toHaveBeenCalledTimes(2);
	});
});

describe("client message envelope and type budgets", () => {
	it.each([null, undefined, true, 1, "hello", [], ["hello"], {}, { type: 1 }, { type: "" }, { type: "x".repeat(129) }])(
		"rejects malformed envelope %j",
		(value) => expect(isClientMessageEnvelope(value)).toBe(false),
	);

	it("requires an own type and accepts unknown string types for existing unknown-type handling", () => {
		expect(isClientMessageEnvelope(Object.create({ type: "hello" }))).toBe(false);
		expect(isClientMessageEnvelope({ type: "future_command", arbitrary: true })).toBe(true);
		expect(isClientMessageEnvelope(Object.assign(Object.create(null), { type: "hello" }))).toBe(true);
		expect(isClientMessageEnvelope({ type: "prompt" })).toBe(true);
	});

	it("limits every pre-hello message and hello itself to the handshake budget", () => {
		for (const type of ["hello", "prompt", "upload_file", "get_state", "unknown"]) {
			expect(clientMessageByteLimit(type, false)).toBe(MAX_PRE_HELLO_WS_BYTES);
		}
		expect(clientMessageByteLimit("hello")).toBe(MAX_PRE_HELLO_WS_BYTES);
		expect(clientMessageByteLimit("get_state")).toBe(MAX_CONTROL_WS_BYTES);
		expect(clientMessageByteLimit("unknown")).toBe(MAX_CONTROL_WS_BYTES);
	});

	it.each(["upload_file", "prompt", "edit_message"])("preserves the 100MiB upload wire budget for %s", (type) => {
		const wireBytes = 4 * Math.ceil((100 * 1024 * 1024) / 3) + 1024;
		expect(MAX_ATTACHMENT_WS_BYTES).toBe(WS_MAX_PAYLOAD_BYTES);
		expect(clientMessageByteLimit(type)).toBe(MAX_ATTACHMENT_WS_BYTES);
		expect(isClientMessageWithinByteLimit(type, wireBytes)).toBe(true);
		expect(isClientMessageWithinByteLimit(type, wireBytes, false)).toBe(false);
		expect(isClientMessageWithinByteLimit("get_state", wireBytes)).toBe(false);
	});

	it.each(["hello", "get_state", "upload_file", "prompt", "edit_message"])("checks the exact %s boundary", (type) => {
		const limit = clientMessageByteLimit(type);
		expect(isClientMessageWithinByteLimit(type, limit)).toBe(true);
		expect(isClientMessageWithinByteLimit(type, limit + 1)).toBe(false);
		for (const invalid of [-1, NaN, Infinity, 1.5]) {
			expect(isClientMessageWithinByteLimit(type, invalid)).toBe(false);
		}
	});
});
