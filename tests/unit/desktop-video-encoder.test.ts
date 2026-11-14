import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NativeDesktopOptions } from "../../server/device-center/desktop-native.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), capture: vi.fn(), path: vi.fn(), exists: vi.fn() }));
vi.mock("node:fs", () => ({ existsSync: mocks.exists }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("../../server/device-center/desktop-native.js", () => ({ startNativeDesktop: mocks.capture }));
vi.mock("../../server/device-center/ffmpeg-path.js", () => ({ resolveFfmpeg: mocks.path }));
let api: typeof import("../../server/device-center/desktop-video-encoder.js");
const profile = { maxEdge: 1920, quality: 70, fps: 120 };
const source = { input: vi.fn(), configure: vi.fn(), close: vi.fn() };
const options = () => ({
	profile,
	readOnly: true,
	onFrame: vi.fn(),
	onVideo: vi.fn(),
	onError: vi.fn(),
	onClose: vi.fn(),
});
const frame = { width: 4, height: 4, data: Buffer.alloc(64) };
function childFixture() {
	const writes: Array<(error?: Error | null) => void> = [];
	return Object.assign(new EventEmitter(), {
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		kill: vi.fn(),
		writes,
		stdin: new Writable({
			write(_bytes, _encoding, done) {
				writes.push(done);
			},
		}),
	});
}
beforeEach(async () => {
	vi.resetModules();
	vi.clearAllMocks();
	api = await import("../../server/device-center/desktop-video-encoder.js");
	mocks.path.mockReturnValue("/embedded/ffmpeg.exe");
	mocks.exists.mockReturnValue(false);
	mocks.capture.mockReturnValue(source);
	mocks.spawn.mockImplementation((_path, args) => {
		const child = childFixture();
		if (args.includes("lavfi")) queueMicrotask(() => child.emit("exit", args.includes("libx264") ? 0 : 1));
		return child;
	});
});
afterEach(() => {
	vi.useRealTimers();
});
async function activeCapture() {
	await vi.waitFor(() => expect(mocks.capture).toHaveBeenCalledOnce());
	return mocks.capture.mock.calls[0][0] as NativeDesktopOptions;
}
it("probes actual hardware encoders and caches a software fallback", async () => {
	expect(await api.selectDesktopVideoEncoder("/embedded/ffmpeg.exe")).toBe("libx264");
	expect(mocks.spawn).toHaveBeenCalledTimes(5);
	expect(await api.selectDesktopVideoEncoder("/embedded/ffmpeg.exe")).toBe("libx264");
	expect(mocks.spawn).toHaveBeenCalledTimes(5);
});
it.each(["h264_nvenc", "h264_qsv", "h264_amf", "h264_mf"])("selects working %s before CPU", async (encoder) => {
	mocks.spawn.mockImplementation((_path, args) => {
		const child = childFixture();
		queueMicrotask(() => child.emit("exit", args.includes(encoder) ? 0 : 1));
		return child;
	});
	expect(await api.selectDesktopVideoEncoder("/embedded/ffmpeg.exe")).toBe(encoder);
	expect(mocks.spawn.mock.calls.some(([, args]) => args.includes("libx264"))).toBe(false);
	if (encoder === "h264_mf")
		expect(mocks.spawn.mock.calls.at(-1)![1]).toEqual(expect.arrayContaining(["-hw_encoding", "1"]));
});
it.each(["h264_nvenc", "h264_qsv", "h264_amf", "h264_mf"])(
	"prefers the patched embedded runtime for %s",
	async (encoder) => {
		mocks.exists.mockReturnValue(true);
		mocks.spawn.mockImplementation((path, args) => {
			const child = childFixture();
			queueMicrotask(() => child.emit("exit", path.includes("nvenc-compat") && args.includes(encoder) ? 0 : 1));
			return child;
		});
		expect(await api.selectDesktopVideoRuntime("/embedded/ffmpeg.exe")).toEqual({
			path: expect.stringContaining("nvenc-compat"),
			encoder,
		});
		expect(mocks.spawn.mock.calls.at(-1)![0]).toContain("nvenc-compat");
	},
);
it("falls back to the default hardware build when the patched build is incompatible", async () => {
	mocks.exists.mockReturnValue(true);
	mocks.spawn.mockImplementation((path, args) => {
		const child = childFixture();
		queueMicrotask(() => child.emit("exit", !path.includes("nvenc-compat") && args.includes("h264_nvenc") ? 0 : 1));
		return child;
	});
	expect(await api.selectDesktopVideoRuntime("/embedded/ffmpeg.exe")).toEqual({
		path: "/embedded/ffmpeg.exe",
		encoder: "h264_nvenc",
	});
	expect(mocks.spawn).toHaveBeenCalledTimes(2);
});
it("expires cached probes so driver changes can be detected", async () => {
	vi.useFakeTimers();
	await api.selectDesktopVideoEncoder("/embedded/ffmpeg.exe");
	await vi.advanceTimersByTimeAsync(60_001);
	await api.selectDesktopVideoEncoder("/embedded/ffmpeg.exe");
	expect(mocks.spawn).toHaveBeenCalledTimes(10);
});
it("replaces a hardware encoder that fails on actual desktop pixels without closing capture", async () => {
	mocks.spawn.mockImplementation((_path, args) => {
		const child = childFixture();
		if (args.includes("lavfi"))
			queueMicrotask(() => child.emit("exit", args.includes("h264_amf") || args.includes("libx264") ? 0 : 1));
		return child;
	});
	const opts = options(),
		handle = api.startEncodedServiceDesktop(opts),
		capture = await activeCapture();
	const ack = vi.fn();
	capture.onRawFrame!(frame, ack);
	const failed = mocks.spawn.mock.results.at(-1)!.value as ReturnType<typeof childFixture>;
	failed.emit("exit", 1);
	await vi.waitFor(() =>
		expect(mocks.spawn.mock.calls.some(([, args]) => args.includes("lavfi") && args.includes("libx264"))).toBe(true),
	);
	expect(ack).toHaveBeenCalledOnce();
	expect(source.close).not.toHaveBeenCalled();
	capture.onRawFrame!(frame, vi.fn());
	expect(mocks.spawn.mock.calls.at(-1)![1]).toContain("libx264");
	expect(opts.onError).not.toHaveBeenCalled();
	handle.close();
});
it("validates frame geometry and uses the requested FPS without a 30 FPS cap", () => {
	for (const fps of [60, 120, 240]) {
		const args = api.rawVideoArguments("libx264", 1920, 1080, { ...profile, fps });
		expect(args[args.indexOf("-framerate") + 1]).toBe(String(fps));
		expect(args).toContain("zerolatency");
	}
	for (const width of [1, 2561, Infinity, 3.5])
		expect(() => api.rawVideoArguments("libx264", width, 1080, profile)).toThrow();
	expect(api.h264Codec(Buffer.from([0, 0, 0, 1, 0x67, 0x64, 0, 0x2a]))).toBe("avc1.64002a");
});
it("uses JPEG when no embedded encoder exists", async () => {
	mocks.path.mockReturnValue(undefined);
	const opts = options(),
		handle = api.startEncodedServiceDesktop(opts);
	const capture = await activeCapture();
	expect(capture.onRawFrame).toBeUndefined();
	expect(capture.readOnly).toBe(true);
	handle.close();
	expect(source.close).toHaveBeenCalledOnce();
});
it("does not start a capture after the viewer closes during probing", async () => {
	const handle = api.startEncodedServiceDesktop(options());
	handle.close();
	await api.selectDesktopVideoEncoder("/embedded/ffmpeg.exe");
	expect(mocks.capture).not.toHaveBeenCalled();
});
it("bounds raw input by encoder consumption and restarts after a profile change", async () => {
	const opts = options(),
		handle = api.startEncodedServiceDesktop(opts);
	const capture = await activeCapture(),
		ack = vi.fn();
	capture.onRawFrame!(frame, ack);
	const child = mocks.spawn.mock.results.at(-1)!.value as ReturnType<typeof childFixture>;
	expect(ack).not.toHaveBeenCalled();
	child.writes[0]();
	await Promise.resolve();
	expect(ack).toHaveBeenCalledOnce();
	handle.configure!({ ...profile, fps: 240 });
	capture.onRawFrame!(frame, vi.fn());
	expect(child.kill).toHaveBeenCalledOnce();
	child.emit("exit", 1);
	expect(opts.onError).not.toHaveBeenCalled();
	expect(source.configure).toHaveBeenLastCalledWith({ ...profile, fps: 240 });
	handle.close();
	handle.close();
	expect(source.close).toHaveBeenCalledOnce();
});
it("closes both helpers when the encoder stops consuming frames", async () => {
	const opts = options(),
		handle = api.startEncodedServiceDesktop(opts);
	const capture = await activeCapture();
	vi.useFakeTimers();
	capture.onRawFrame!(frame, vi.fn());
	await vi.advanceTimersByTimeAsync(5001);
	expect(opts.onError).toHaveBeenCalledWith("Desktop video encoder stopped accepting frames.");
	expect(opts.onClose).toHaveBeenCalledOnce();
	expect(source.close).toHaveBeenCalledOnce();
	handle.close();
});
