import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { desktopPage } from "../../server/device-center/desktop-page.js";

function viewer(hardware = true, runtimeFailure = false, wait?: Promise<boolean>) {
	const probes: string[] = [],
		configured: string[] = [],
		instances: any[] = [];
	class Decoder {
		state = "unconfigured";
		decodeQueueSize = 0;
		static async isConfigSupported(config: any) {
			probes.push(config.hardwareAcceleration);
			return { supported: config.hardwareAcceleration === "prefer-hardware" ? (wait ? await wait : hardware) : true };
		}
		constructor(public callbacks: any) {
			instances.push(this);
		}
		configure(config: any) {
			configured.push(config.hardwareAcceleration);
			this.state = "configured";
			if (runtimeFailure && config.hardwareAcceleration === "prefer-hardware")
				queueMicrotask(() => {
					this.state = "closed";
					this.callbacks.error(new Error("GPU initialization failed"));
				});
		}
		close() {
			this.state = "closed";
		}
		decode(chunk: any) {
			this.callbacks.output({
				timestamp: chunk.value.timestamp,
				displayWidth: 1280,
				displayHeight: 720,
				close: vi.fn(),
			});
		}
	}
	const context: any = {
		VideoDecoder: Decoder,
		EncodedVideoChunk: class {
			constructor(public value: any) {}
		},
		Uint8Array,
		Promise,
		performance,
		socket: { readyState: 1, send: vi.fn() },
		videoMode: false,
		videoSupported: true,
		videoCodec: "",
		videoDecoder: null,
		videoState: null,
		videoAcceleration: "",
		videoTime: 0,
		videoDecodeAt: 0,
		disposed: false,
		zh: false,
		canvas: {},
		context: { drawImage: vi.fn() },
		hasFrame: false,
		rendered: 0,
		decodeMs: 0,
		connectionViewOnly: true,
		t: (s: string) => s,
		status: vi.fn(),
		controls: vi.fn(),
		fail: vi.fn(),
	};
	const page = desktopPage(),
		start = page.indexOf("function startVideo("),
		end = page.indexOf("function connect()", start);
	expect(start).toBeGreaterThan(0);
	expect(end).toBeGreaterThan(start);
	runInNewContext(page.slice(start, end), context);
	return { context, probes, configured, instances };
}
const key = new Blob([new Uint8Array([0, 0, 1, 5, 128])]);
it("acknowledges the newest JPEG cumulatively after replacing pending frames", async () => {
	const socket = { readyState: 1, send: vi.fn() },
		paints: (() => void)[] = [];
	const c: any = {
		decoding: false,
		pendingFrame: null,
		disposed: false,
		generation: 1,
		socket,
		WebSocket: { OPEN: 1 },
		canvas: { width: 1280, height: 720 },
		context: { drawImage: vi.fn() },
		hasFrame: true,
		rendered: 0,
		performance,
		document: { hidden: false },
		createImageBitmap: async () => ({ width: 1280, height: 720, close: vi.fn() }),
		requestAnimationFrame: (paint: () => void) => paints.push(paint),
		fail: vi.fn(),
	};
	const page = desktopPage(),
		start = page.indexOf("async function decodeFrames()"),
		end = page.indexOf("function startVideo(", start);
	runInNewContext(page.slice(start, end), c);
	const frame = (id: number) => ({ blob: new Blob(), generation: 1, socket, ack: { type: "jpeg_ack", id } });
	c.pendingFrame = frame(1);
	const decoding = c.decodeFrames();
	await vi.waitFor(() => expect(paints).toHaveLength(1));
	c.pendingFrame = frame(2);
	c.pendingFrame = frame(3);
	c.pendingFrame = frame(4);
	paints.shift()!();
	await vi.waitFor(() => expect(paints).toHaveLength(1));
	paints.shift()!();
	await decoding;
	expect(socket.send.mock.calls.map((call) => JSON.parse(call[0]))).toEqual([
		{ type: "jpeg_ack", id: 1 },
		{ type: "jpeg_ack", id: 4 },
	]);
	expect(c.rendered).toBe(2);
	expect(c.fail).not.toHaveBeenCalled();
});
it("keeps the previous desktop visible until the resized JPEG can be painted, and ignores stale frames", async () => {
	for (const stale of [false, true]) {
		let paint: (() => void) | undefined;
		const socket = { readyState: 1, send: vi.fn() },
			bitmap = { width: 1280, height: 720, close: vi.fn() },
			draw = vi.fn();
		const c: any = {
			decoding: false,
			pendingFrame: { blob: new Blob(), generation: 1, socket },
			createImageBitmap: async () => bitmap,
			disposed: false,
			generation: 1,
			socket,
			WebSocket: { OPEN: 1 },
			canvas: { width: 640, height: 480 },
			context: { drawImage: draw },
			hasFrame: true,
			rendered: 0,
			performance,
			document: { hidden: false },
			requestAnimationFrame: (callback: () => void) => {
				paint = callback;
			},
			status: vi.fn(),
			controls: vi.fn(),
			fail: vi.fn(),
		};
		const page = desktopPage(),
			start = page.indexOf("async function decodeFrames()"),
			end = page.indexOf("function startVideo(", start);
		runInNewContext(page.slice(start, end), c);
		const decoding = c.decodeFrames();
		await vi.waitFor(() => expect(paint).toBeTypeOf("function"));
		expect(c.canvas).toEqual({ width: 640, height: 480 });
		expect(draw).not.toHaveBeenCalled();
		if (stale) c.generation++;
		paint!();
		await decoding;
		expect(c.canvas).toEqual(stale ? { width: 640, height: 480 } : { width: 1280, height: 720 });
		expect(draw).toHaveBeenCalledTimes(stale ? 0 : 1);
		expect(bitmap.close).toHaveBeenCalledOnce();
		expect(c.fail).not.toHaveBeenCalled();
	}
});
describe("browser hardware decoder selection", () => {
	it("acknowledges complete video only after drawing and preserves the source timestamp", async () => {
		const { context: c } = viewer();
		c.startVideo("avc1.42001f", false, true);
		await c.videoState.ready;
		const h = Buffer.alloc(20);
		h.write("PIV1");
		h.writeUInt32BE(17, 4);
		h.writeDoubleBE(123.5, 8);
		h.writeUInt32BE(1, 16);
		c.decodeVideo(new Blob([h, await key.arrayBuffer()]));
		await c.videoState.queue;
		expect(c.videoTime).toBe(123500);
		expect(c.context.drawImage).toHaveBeenCalledOnce();
		expect(c.socket.send).toHaveBeenCalledWith(JSON.stringify({ type: "video_ack", id: 17, queue: 0 }));
		expect(c.videoState.frames.size).toBe(0);
	});
	it("selects supported hardware before software and renders its frames", async () => {
		const { context: c, probes, configured } = viewer();
		expect(c.startVideo("avc1.42001f")).toBe(true);
		await c.videoState.ready;
		expect(probes).toEqual(["prefer-hardware"]);
		expect(configured).toEqual(["prefer-hardware"]);
		c.decodeVideo(key);
		await c.videoState.queue;
		expect(c.rendered).toBe(1);
		expect(c.videoAcceleration).toBe("hardware decode");
	});
	it("falls back only when the requested hardware configuration is unsupported", async () => {
		const { context: c, probes, configured } = viewer(false);
		c.startVideo("avc1.42001f");
		await c.videoState.ready;
		expect(probes).toEqual(["prefer-hardware", "prefer-software"]);
		expect(configured).toEqual(["prefer-software"]);
		c.decodeVideo(key);
		await c.videoState.queue;
		expect(c.rendered).toBe(1);
	});
	it("recovers a real initialization failure through software without closing the connection", async () => {
		const { context: c, configured } = viewer(true, true);
		c.startVideo("avc1.42001f");
		await vi.waitFor(() => expect(configured).toEqual(["prefer-hardware", "prefer-software"]));
		c.decodeVideo(key);
		await c.videoState.queue;
		expect(c.rendered).toBe(1);
		expect(c.fail).not.toHaveBeenCalled();
	});
	it("ignores a delayed capability response after disconnect", async () => {
		let resolve!: (value: boolean) => void;
		const { context: c, configured } = viewer(true, false, new Promise((r) => (resolve = r)));
		c.startVideo("avc1.42001f");
		const ready = c.videoState.ready;
		c.videoState = null;
		c.videoMode = false;
		resolve(true);
		await ready;
		expect(configured).toEqual([]);
	});
	it("replaces same-codec decoders on stream reset and discards old output", async () => {
		const { context: c, instances } = viewer();
		c.startVideo("avc1.42001f");
		await c.videoState.ready;
		c.startVideo("avc1.42001f", true);
		await c.videoState.ready;
		const close = vi.fn();
		instances[0].callbacks.output({ close });
		expect(close).toHaveBeenCalledOnce();
		expect(c.rendered).toBe(0);
		c.decodeVideo(key);
		await c.videoState.queue;
		expect(c.rendered).toBe(1);
	});
});
