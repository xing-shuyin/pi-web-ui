import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { clipboardConnection } from "../../server/device-center/desktop-clipboard.js";
import {
	clipboardDigest,
	clipboardPng,
	type ClipboardBackend,
	type ClipboardContent,
} from "../../server/device-center/desktop-clipboard-native.js";
import { CLIPBOARD_LIMITS, parseClipboardOffer } from "../../server/device-center/desktop-clipboard-protocol.js";
import { clipboardBrowserBridge, type ClipboardSocket } from "../../server/device-center/desktop-clipboard-bridge.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
	vi.restoreAllMocks();
});
function memory() {
	let value: ClipboardContent | undefined;
	const listeners = new Set<() => void>();
	const backend: ClipboardBackend = {
		read: async () => value,
		write: vi.fn(async (next) => {
			value = next;
			listeners.forEach((fn) => fn());
		}),
		watch: (fn) => {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
	};
	return {
		backend,
		listeners,
		copy(next: ClipboardContent) {
			value = next;
			listeners.forEach((fn) => fn());
		},
	};
}
async function endpoint(backend: ClipboardBackend, writable = true) {
	const server = createServer(),
		wss = new WebSocketServer({ server, maxPayload: CLIPBOARD_LIMITS.message });
	wss.on("connection", (ws) => clipboardConnection(ws, backend, writable));
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const client = new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}`);
	const packets: Record<string, any>[] = [];
	client.on("message", (data) => packets.push(JSON.parse(data.toString())));
	await once(client, "open");
	cleanup.push(async () => {
		client.terminate();
		for (const ws of wss.clients) ws.terminate();
		wss.close();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	const send = (packet: object) => client.send(JSON.stringify(packet));
	return { client, packets, send };
}
const text = (value: string): ClipboardContent => ({
	kind: "text",
	items: [{ name: "text.txt", data: Buffer.from(value) }],
});
function offer(data = Buffer.from("clipboard"), name = "text.txt") {
	return {
		type: "offer",
		id: randomUUID(),
		kind: "text",
		items: [{ name, size: data.length, sha256: createHash("sha256").update(data).digest("hex") }],
	};
}
describe("native clipboard protocol", () => {
	it("supports explicit browser text transfer without a clipboard watcher", async () => {
		const source = memory(),
			ep = await endpoint(source.backend);
		source.copy(text("existing remote text"));
		ep.send({ type: "start", read: true, write: true, manual: true });
		ep.send({ type: "text-read" });
		await vi.waitFor(() => expect(ep.packets).toContainEqual({ type: "text-result", text: "existing remote text" }));
		expect(source.listeners.size).toBe(0);
		ep.send({ type: "text-write", text: "从浏览器粘贴" });
		await vi.waitFor(() => expect(ep.packets).toContainEqual({ type: "text-result", written: true }));
		expect(await source.backend.read()).toEqual(text("从浏览器粘贴"));
		source.copy({ kind: "image", items: [{ name: "image.png", data: Buffer.from([1]) }] });
		ep.send({ type: "text-read" });
		await vi.waitFor(() => expect(ep.packets).toContainEqual({ type: "text-result", error: "clipboard-not-text" }));
		ep.send({ type: "text-write", text: "x".repeat(16385) });
		await vi.waitFor(() => expect(ep.packets).toContainEqual({ type: "clipboard-error", code: "clipboard-size" }));
	});
	it("refuses browser text writes on read-only connections", async () => {
		const source = memory(),
			ep = await endpoint(source.backend, false);
		ep.send({ type: "start", read: true, write: false, manual: true });
		ep.send({ type: "text-write", text: "must not write" });
		await vi.waitFor(() => expect(ep.packets).toContainEqual({ type: "clipboard-error", code: "clipboard-direction" }));
		expect(source.backend.write).not.toHaveBeenCalled();
	});
	it("copies text, images and multi-chunk files both ways without echoes; stops watching on disconnect", async () => {
		const a = memory(),
			b = memory(),
			left = await endpoint(a.backend),
			right = await endpoint(b.backend);
		for (const [from, to] of [
			[left, right],
			[right, left],
		])
			from.client.on("message", (raw) => {
				const packet = JSON.parse(raw.toString());
				if (["offer", "chunk", "commit", "ack"].includes(packet.type)) to.send(packet);
			});
		left.send({ type: "start", read: true, write: true });
		right.send({ type: "start", read: true, write: true });
		await vi.waitFor(() => expect(a.listeners.size + b.listeners.size).toBe(2));
		a.copy(text("中文 from Windows"));
		await vi.waitFor(() => expect(b.backend.write).toHaveBeenCalledTimes(1));
		expect(clipboardDigest((b.backend.write as any).mock.calls[0][0])).toBe(clipboardDigest(text("中文 from Windows")));
		const image: ClipboardContent = { kind: "image", items: [{ name: "image.png", data: Buffer.alloc(70000, 7) }] };
		b.copy(image);
		await vi.waitFor(() => expect(a.backend.write).toHaveBeenCalledTimes(1));
		const files: ClipboardContent = {
			kind: "files",
			items: [
				{ name: "报告.txt", data: Buffer.alloc(2 * 1024 * 1024, 31) },
				{ name: "empty.txt", data: Buffer.alloc(0) },
			],
		};
		a.copy(files);
		await vi.waitFor(() => expect(b.backend.write).toHaveBeenCalledTimes(2));
		expect(clipboardDigest((b.backend.write as any).mock.calls[1][0])).toBe(clipboardDigest(files));
		expect(a.backend.write).toHaveBeenCalledTimes(1);
		expect(
			left.packets
				.filter((p) => p.type === "chunk")
				.every((p) => Buffer.from(p.data, "base64").length <= CLIPBOARD_LIMITS.chunk),
		).toBe(true);
		left.client.close();
		right.client.close();
		await vi.waitFor(() => expect(a.listeners.size + b.listeners.size).toBe(0));
	});
	it.each([
		{ read: false, write: false },
		{ read: true, write: false },
	])("enforces receive prohibition %j", async (permissions) => {
		const backend = memory(),
			ep = await endpoint(backend.backend);
		ep.send({ type: "start", ...permissions });
		ep.send(offer());
		await vi.waitFor(() => expect(ep.packets.some((p) => p.code === "clipboard-direction")).toBe(true));
		expect(backend.backend.write).not.toHaveBeenCalled();
	});
	it("view-only connections cannot request writes", async () => {
		const backend = memory(),
			ep = await endpoint(backend.backend, false);
		ep.send({ type: "start", read: true, write: true });
		await vi.waitFor(() => expect(ep.packets.some((p) => p.code === "clipboard-readonly")).toBe(true));
		expect(backend.backend.write).not.toHaveBeenCalled();
	});
	it("rejects incomplete or corrupt data before applying the OS clipboard", async () => {
		const backend = memory(),
			ep = await endpoint(backend.backend),
			packet = offer();
		ep.send({ type: "start", read: false, write: true });
		ep.send(packet);
		ep.send({ type: "chunk", id: packet.id, item: 0, offset: 0, data: Buffer.from("corrupted").toString("base64") });
		ep.send({ type: "commit", id: packet.id });
		await vi.waitFor(() => expect(ep.packets.some((p) => p.code === "clipboard-integrity")).toBe(true));
		expect(backend.backend.write).not.toHaveBeenCalled();
	});
	it("bounds file manifests, denies unsafe paths, collisions and oversized images", () => {
		for (const name of ["../x", "C:\\x", "NUL.txt", "a/b", "name."])
			expect(parseClipboardOffer(offer(Buffer.alloc(0), name))).toBeUndefined();
		const packet = { ...offer(), kind: "files" };
		expect(
			parseClipboardOffer({ ...packet, items: [{ ...packet.items[0], size: CLIPBOARD_LIMITS.bytes + 1 }] }),
		).toBeUndefined();
		expect(
			parseClipboardOffer({ ...packet, items: [...packet.items, { ...packet.items[0], name: "TEXT.TXT" }] }),
		).toBeUndefined();
		const png = Buffer.alloc(33);
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
		png.write("IHDR", 12);
		png.writeUInt32BE(1, 16);
		png.writeUInt32BE(1, 20);
		expect(clipboardPng(png)).toBe(true);
		png.writeUInt32BE(20000, 16);
		expect(clipboardPng(png)).toBe(false);
	});
	it("trusted browser bridge ignores unsolicited remote enable and waits for both endpoints", () => {
		const socket: ClipboardSocket = {
			readyState: 1,
			bufferedAmount: 0,
			onmessage: null,
			onclose: null,
			onerror: null,
			send: vi.fn(),
			close: vi.fn(),
		};
		const open = vi.fn(() => socket),
			post = vi.fn(),
			state = vi.fn(),
			id = randomUUID();
		const bridge = clipboardBrowserBridge({ open, post, state, id: () => id });
		cleanup.push(() => bridge.close());
		bridge.receive({ type: "desktop-clipboard", channel: id, payload: { type: "bridge-start", mode: "both" } });
		expect(open).not.toHaveBeenCalled();
		bridge.set("send");
		socket.onmessage!({ data: JSON.stringify({ type: "clipboard-capabilities" }) });
		expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: "start", read: true, write: false }));
		socket.onmessage!({ data: JSON.stringify({ type: "clipboard-ready" }) });
		const pending = offer();
		socket.onmessage!({ data: JSON.stringify(pending) });
		expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ payload: pending }));
		bridge.receive({ type: "desktop-clipboard", channel: id, payload: { type: "clipboard-ready" } });
		expect(post).toHaveBeenCalledWith(expect.objectContaining({ payload: pending }));
		bridge.receive({ type: "desktop-clipboard", channel: id, payload: offer() });
		expect(state).toHaveBeenLastCalledWith("clipboard-direction");
		expect(socket.close).toHaveBeenCalled();
	});
});
