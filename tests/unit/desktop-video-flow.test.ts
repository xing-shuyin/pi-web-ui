import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { WebSocket } from "ws";
import { expect, it, vi } from "vitest";
import type { startEncodedServiceDesktop } from "../../server/device-center/desktop-video-encoder.js";
const mocks = vi.hoisted(() => ({ start: vi.fn(), nativeStart: vi.fn(), nativeVideo: false }));
vi.mock("../../server/device-center/desktop-native.js", async (original) => ({
	...(await original<typeof import("../../server/device-center/desktop-native.js")>()),
	startNativeDesktop: mocks.nativeStart,
}));
vi.mock("../../server/device-center/desktop-video-encoder.js", () => ({ startEncodedServiceDesktop: mocks.start }));
vi.mock("../../server/device-center/windows-desktop-service.js", () => ({
	windowsDesktopServicePath: () => "C:/protected/PiDesktopService.exe",
	windowsDesktopServiceProfiles: (_path: string, capability?: string) => capability !== "video-v1" || mocks.nativeVideo,
	startWindowsServiceDesktop: vi.fn(),
}));
import { createDeviceDesktop, DESKTOP_LIMITS } from "../../server/device-center/desktop.js";

it("paces negotiated H264 from drawn-frame feedback without granting control to a viewer", async () => {
	mocks.nativeVideo = true;
	mocks.nativeStart.mockReset();
	vi.spyOn(process, "platform", "get").mockReturnValue("win32");
	const dataDir = await mkdtemp(join(tmpdir(), "pi-video-feedback-")),
		app = express();
	const desktop = createDeviceDesktop({ app, dataDir, env: { PI_DEVICE_DESKTOP: "1" }, authorize: () => true });
	const server = createServer(app);
	server.on("upgrade", (req, socket, head) => desktop.handleUpgrade(req, socket, head));
	let captureOptions: any;
	const capture = {
		input: vi.fn(),
		configure: vi.fn(),
		close: vi.fn(),
		videoFeedback: vi.fn(),
		requestKeyframe: vi.fn(),
	};
	mocks.nativeStart.mockImplementation((options) => {
		captureOptions = options;
		return capture;
	});
	let client: WebSocket | undefined;
	try {
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const port = (server.address() as { port: number }).port;
		expect(port).toBeGreaterThanOrEqual(8900);
		client = new WebSocket(`ws://127.0.0.1:${port}/desktop-ws?viewOnly=1&video=1&videoFeedback=1`, {
			origin: `http://127.0.0.1:${port}`,
		});
		const frames: Buffer[] = [];
		client.on("message", (data, binary) => {
			if (binary) frames.push(Buffer.from(data as Buffer));
		});
		await once(client, "open");
		for (let i = 0; i < 6; i++)
			captureOptions.onVideo({ data: Buffer.from([0, 0, 1, 5, 128]), key: true, timestampMs: i * 10 });
		await vi.waitFor(() => expect(frames).toHaveLength(6));
		expect(frames[5].toString("ascii", 0, 4)).toBe("PIV1");
		expect(frames[5].readDoubleBE(8)).toBe(50);
		expect(capture.videoFeedback).toHaveBeenLastCalledWith(true);
		client.send(JSON.stringify({ type: "video_ack", id: frames[5].readUInt32BE(4), queue: 0 }));
		await vi.waitFor(() => expect(capture.videoFeedback).toHaveBeenLastCalledWith(false));
		client.send(JSON.stringify({ type: "text", text: "viewers cannot type" }));
		client.send(JSON.stringify({ type: "video_recover" }));
		await vi.waitFor(() => expect(capture.requestKeyframe).toHaveBeenCalledOnce());
		expect(capture.input).not.toHaveBeenCalled();
		expect(captureOptions.readOnly).toBe(true);
	} finally {
		client?.terminate();
		desktop.close();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(dataDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	}
});

it.each([false, true])(
	"bounds video queues and resumes at a keyframe (native capture+encoding: %s)",
	async (nativeVideo) => {
		mocks.start.mockReset();
		mocks.nativeStart.mockReset();
		mocks.nativeVideo = nativeVideo;
		vi.spyOn(process, "platform", "get").mockReturnValue("win32");
		let queued = 0;
		vi.spyOn(WebSocket.prototype, "bufferedAmount", "get").mockImplementation(() => queued);
		const dataDir = await mkdtemp(join(tmpdir(), "pi-video-flow-"));
		const app = express();
		const desktop = createDeviceDesktop({ app, dataDir, env: { PI_DEVICE_DESKTOP: "1" }, authorize: () => true });
		const server = createServer(app);
		server.on("upgrade", (req, socket, head) => desktop.handleUpgrade(req, socket, head));
		let options: Parameters<typeof startEncodedServiceDesktop>[0];
		const capture = { input: vi.fn(), configure: vi.fn(), close: vi.fn() };
		const start = nativeVideo ? mocks.nativeStart : mocks.start;
		start.mockImplementation((value) => {
			options = value;
			return capture;
		});
		let client: WebSocket | undefined;
		try {
			server.listen(0, "127.0.0.1");
			await once(server, "listening");
			const port = (server.address() as { port: number }).port;
			expect(port).toBeGreaterThanOrEqual(8900);
			client = new WebSocket(`ws://127.0.0.1:${port}/desktop-ws?viewOnly=1&video=1`, {
				origin: `http://127.0.0.1:${port}`,
			});
			const binary: Buffer[] = [];
			const declarations: { type: string; reset?: boolean }[] = [];
			client.on("message", (bytes, isBinary) => {
				if (isBinary) binary.push(Buffer.from(bytes as Buffer));
				else {
					const value = JSON.parse(bytes.toString());
					if (value.type === "video") declarations.push(value);
				}
			});
			await once(client, "open");
			expect(start).toHaveBeenCalledOnce();
			if (nativeVideo) {
				expect(mocks.start).not.toHaveBeenCalled();
				expect(start.mock.calls[0][0]).toMatchObject({ video: true, readOnly: true });
			}
			const key = { data: Buffer.from([0, 0, 1, 5, 128]), key: true };
			options!.onVideo(key);
			await vi.waitFor(() => expect(binary).toHaveLength(1));
			queued = DESKTOP_LIMITS.queue;
			options!.onVideo(key);
			queued = 0;
			options!.onVideo({ data: Buffer.from([0, 0, 1, 1, 128]), key: false });
			await new Promise((resolve) => setImmediate(resolve));
			expect(binary).toHaveLength(1);
			options!.onVideo(key);
			await vi.waitFor(() => expect(binary).toHaveLength(2));
			options!.onVideo({ ...key, reset: true });
			await vi.waitFor(() => expect(binary).toHaveLength(3));
			expect(declarations).toHaveLength(2);
			expect(declarations[1]).toMatchObject({ type: "video", reset: true });
		} finally {
			client?.terminate();
			desktop.close();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(dataDir, { recursive: true, force: true });
			vi.restoreAllMocks();
		}
	},
);
