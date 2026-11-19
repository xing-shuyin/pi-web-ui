import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	accessSync: vi.fn(),
	statSync: vi.fn(),
	spawn: vi.fn(),
	execFile: vi.fn(),
	execFileSync: vi.fn(),
}));
vi.mock("node:fs", () => ({ accessSync: mocks.accessSync, statSync: mocks.statSync, constants: { X_OK: 1 } }));
vi.mock("node:child_process", () => ({
	spawn: mocks.spawn,
	execFile: mocks.execFile,
	execFileSync: mocks.execFileSync,
}));
import { linuxDesktopStatus, startLinuxDesktop } from "../../server/device-center/desktop-linux.js";

function child() {
	const result = Object.assign(new EventEmitter(), {
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		exitCode: null,
		signalCode: null,
		kill: vi.fn(() => true),
	});
	return result;
}
let capture: ReturnType<typeof child>;
let callbacks: Array<(error: Error | null) => void>;
let commands: ReturnType<typeof child>[];
let available: Set<string>;
const SCREEN_INFO = "default screen number: 0\nscreen #0:\n dimensions: 1920x1080 pixels\n";
const SCREEN_RANDR = "Screen 0: minimum 8 x 8, current 2560 x 1440, maximum 32767 x 32767";
/** 屏幕尺寸探测现在走异步 runProcess（真实调用点是 spawn），这里用一个立刻收场的假子进程顶替。 */
function probeChild(stdout: string, code = 0) {
	const c = Object.assign(new EventEmitter(), {
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		stdin: { end: () => {}, on: () => {} },
		pid: 4242,
		kill: vi.fn(() => true),
	});
	void Promise.resolve().then(() => {
		if (stdout) c.stdout.write(stdout);
		c.emit("close", code, null);
	});
	return c;
}
/** 探针结果是异步落地的：等若干个微任务让 startCapture 真正走到 spawn(ffmpeg)。 */
async function flush() {
	for (let i = 0; i < 40; i++) await Promise.resolve();
}
/** 起一个已等过尺寸探测的会话。 */
async function started(options?: Parameters<typeof start>[0]) {
	const handle = start(options);
	await flush();
	return handle;
}
function ffmpegCalls() {
	return mocks.spawn.mock.calls.filter(([file]) => /ffmpeg$/.test(String(file)));
}

let onFrame: ReturnType<typeof vi.fn<(jpeg: Buffer) => void>>;
let onError: ReturnType<typeof vi.fn<(message: string) => void>>;
let onClose: ReturnType<typeof vi.fn<() => void>>;
function start(readOnly?: boolean) {
	return startLinuxDesktop({ onFrame, onError, onClose, readOnly });
}
function done(error: Error | null = null) {
	callbacks.shift()!(error);
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers();
	vi.spyOn(process, "platform", "get").mockReturnValue("linux");
	vi.stubEnv("PATH", "/mock/bin");
	vi.stubEnv("DISPLAY", ":0.0");
	vi.stubEnv("XDG_SESSION_TYPE", "x11");
	vi.stubEnv("WAYLAND_DISPLAY", "");
	available = new Set(["ffmpeg", "xdotool", "xdpyinfo", "xrandr"]);
	mocks.accessSync.mockImplementation((path: string) => {
		if (!available.has(path.split(/[\\/]/).pop()!)) throw new Error("ENOENT");
	});
	mocks.statSync.mockReturnValue({ isFile: () => true });
	capture = child();
	mocks.spawn.mockImplementation((file: string) => {
		const name = String(file).split(/[\\/]/).pop();
		if (name === "xdpyinfo") return probeChild(SCREEN_INFO);
		if (name === "xrandr") return probeChild(SCREEN_RANDR);
		return capture;
	});
	callbacks = [];
	commands = [];
	mocks.execFile.mockImplementation((_file, _args, _options, callback) => {
		callbacks.push(callback);
		const command = child();
		commands.push(command);
		return command;
	});
	onFrame = vi.fn();
	onError = vi.fn();
	onClose = vi.fn();
});
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("Linux X11 desktop", () => {
	it("reconfigures capture without closing input or accepting frames from the old process", async () => {
		const session = await started(true);
		const previous = capture;
		capture = child();
		mocks.spawn.mockReturnValue(capture);
		session.configure?.({ maxEdge: 1280, quality: 50, fps: 30 });
		vi.advanceTimersByTime(250);
		const calls = ffmpegCalls();
		expect(calls).toHaveLength(2);
		expect(calls[1][1]).toContain("30");
		expect(calls[1][1].join(" ")).toContain("min(1280,iw)");
		const jpeg = Buffer.from([255, 216, 1, 2, 255, 217]);
		previous.stdout.write(jpeg);
		previous.emit("close", 0, null);
		expect(onClose).not.toHaveBeenCalled();
		expect(onFrame).not.toHaveBeenCalled();
		capture.stdout.write(jpeg);
		expect(onFrame).toHaveBeenCalledWith(jpeg);
		session.input({ type: "text", text: "blocked" });
		expect(mocks.execFile).not.toHaveBeenCalled();
		session.close();
		expect(capture.kill).toHaveBeenCalled();
	});
	it("applies preferences during the size probe and acknowledges each X11 pointer switch on its first frame", async () => {
		const onCursor = vi.fn();
		const session = startLinuxDesktop({ onCursor, onFrame, onClose, onError, readOnly: true });
		const jpeg = Buffer.from([255, 216, 1, 2, 255, 217]);
		session.configure?.({ maxEdge: 1280, quality: 65, fps: 30 });
		session.setCursorMode?.("local");
		vi.advanceTimersByTime(300);
		await flush();
		const calls = ffmpegCalls();
		expect(calls).toHaveLength(1);
		const initialArgs = calls[0][1];
		expect(initialArgs[initialArgs.indexOf("-draw_mouse") + 1]).toBe("0");
		expect(initialArgs[initialArgs.indexOf("-framerate") + 1]).toBe("30");
		capture.stdout.write(jpeg);
		expect(onCursor).toHaveBeenCalledWith({ type: "cursor", kind: "local" });
		for (const [mode, arg, kind] of [
			["remote", "1", "embedded"],
			["local", "0", "local"],
		] as const) {
			const previous = capture;
			capture = child();
			mocks.spawn.mockReturnValue(capture);
			session.setCursorMode?.(mode);
			vi.advanceTimersByTime(100);
			const args = ffmpegCalls().at(-1)![1];
			expect(args[args.indexOf("-draw_mouse") + 1]).toBe(arg);
			onCursor.mockClear();
			previous.stdout.write(jpeg);
			expect(onCursor).not.toHaveBeenCalled();
			capture.stdout.write(jpeg);
			expect(onCursor).toHaveBeenCalledWith({ type: "cursor", kind });
		}
		expect(mocks.execFile).not.toHaveBeenCalled();
		session.close();
	});
	it("preserves numeric keypad identity through xdotool press and release", async () => {
		const handle = await started(false);
		const keys = [
			...Array.from({ length: 10 }, (_, i) => [`Numpad${i}`, `KP_${i}`]),
			["NumpadEnter", "KP_Enter"],
			["NumpadAdd", "KP_Add"],
			["NumpadSubtract", "KP_Subtract"],
			["NumpadMultiply", "KP_Multiply"],
			["NumpadDivide", "KP_Divide"],
			["NumpadDecimal", "KP_Decimal"],
			["NumpadComma", "KP_Separator"],
			["NumpadEqual", "KP_Equal"],
			["NumpadClear", "Clear"],
			["NumLock", "Num_Lock"],
		];
		for (const [code, symbol] of keys)
			for (const action of ["down", "up"] as const) {
				handle.input({ type: "key", code, action });
				expect(mocks.execFile).toHaveBeenLastCalledWith(
					expect.any(String),
					[action === "down" ? "keydown" : "keyup", symbol],
					expect.anything(),
					expect.any(Function),
				);
				done();
			}
		handle.close();
	});
	it("reduces capture work for previews and prevents input", async () => {
		const handle = startLinuxDesktop({ onFrame, onError, onClose, readOnly: false, preview: true });
		await flush();
		const args = ffmpegCalls()[0][1];
		expect(args).toContain("1/3");
		expect(args.join(" ")).toContain("640");
		handle.input({ type: "text", text: "no input" });
		expect(commands).toHaveLength(0);
		handle.close();
	});
	it("probes capture separately from optional control and rejects Wayland", async () => {
		expect(linuxDesktopStatus()).toEqual({ supported: true, backend: "x11" });
		available.delete("xdotool");
		expect(linuxDesktopStatus()).toMatchObject({ supported: true, reason: expect.stringContaining("View only") });
		available.delete("ffmpeg");
		expect(linuxDesktopStatus()).toMatchObject({ supported: false, reason: expect.stringContaining("ffmpeg") });
		vi.stubEnv("XDG_SESSION_TYPE", "wayland");
		expect(linuxDesktopStatus()).toMatchObject({
			supported: false,
			reason: expect.stringContaining("Portal/PipeWire"),
		});
	});
	it("rejects XWayland when only WAYLAND_DISPLAY identifies the session", async () => {
		vi.stubEnv("XDG_SESSION_TYPE", "");
		vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
		expect(linuxDesktopStatus()).toMatchObject({
			supported: false,
			reason: expect.stringContaining("Portal/PipeWire"),
		});
	});
	it("requires Linux and a DISPLAY", async () => {
		vi.stubEnv("DISPLAY", "");
		expect(linuxDesktopStatus().supported).toBe(false);
		vi.spyOn(process, "platform", "get").mockReturnValue("win32");
		expect(linuxDesktopStatus().supported).toBe(false);
	});
	it("uses one shell-free ffmpeg process and parses fragmented/batched JPEGs", async () => {
		const handle = await started();
		const [file, args, options] = ffmpegCalls()[0];
		expect(file).toMatch(/ffmpeg$/);
		expect(args).toEqual(expect.arrayContaining(["x11grab", "15", "1920x1080", ":0.0", "mjpeg", "image2pipe"]));
		expect(args.join(" ")).toContain("1600");
		expect(options).toMatchObject({ shell: false, stdio: ["ignore", "pipe", "pipe"], env: process.env });
		capture.stdout.emit("data", Buffer.from([1, 2, 255]));
		capture.stdout.emit("data", Buffer.from([216, 3, 255]));
		capture.stdout.emit("data", Buffer.from([217, 255, 216, 4, 255, 217]));
		expect(onFrame.mock.calls.map(([frame]) => [...frame])).toEqual([
			[255, 216, 3, 255, 217],
			[255, 216, 4, 255, 217],
		]);
		handle.close();
	});
	it("fails oversized frames and ignores output after shutdown", async () => {
		await started();
		capture.stdout.emit("data", Buffer.concat([Buffer.from([255, 216]), Buffer.alloc(4 * 1024 * 1024)]));
		expect(onError).toHaveBeenCalledWith(expect.stringContaining("4 MiB"));
		expect(onClose).toHaveBeenCalledTimes(1);
		capture.stdout.emit("data", Buffer.from([255, 216, 255, 217]));
		expect(onFrame).not.toHaveBeenCalled();
	});
	it("falls back to xrandr and reports dimension probe failures asynchronously", async () => {
		mocks.spawn.mockImplementation((file: string) => {
			const name = String(file).split(/[\\/]/).pop();
			if (name === "xdpyinfo") return probeChild("", 1);
			if (name === "xrandr") return probeChild(SCREEN_RANDR);
			return capture;
		});
		const handle = await started();
		expect(ffmpegCalls()[0][1]).toContain("2560x1440");
		handle.close();

		mocks.spawn.mockImplementation((file: string) => {
			const name = String(file).split(/[\\/]/).pop();
			if (name === "xdpyinfo" || name === "xrandr") return probeChild("", 1);
			return capture;
		});
		await started();
		expect(onError).toHaveBeenCalledWith(expect.stringContaining("dimensions"));
	});
	it("ignores all input by default, and reports optional control dependency only once", async () => {
		let handle = await started();
		handle.input({ type: "key", code: "KeyA", action: "down" });
		expect(mocks.execFile).not.toHaveBeenCalled();
		handle.close();
		available.delete("xdotool");
		handle = await started(false);
		handle.input({ type: "text", text: "hello" });
		handle.input({ type: "text", text: "again" });
		expect(onError).toHaveBeenCalledTimes(1);
		expect(onClose).toHaveBeenCalledTimes(1);
		handle.close();
	});
	it("serializes bounded input, uses physical screen coordinates and treats text as one argument", async () => {
		const handle = await started(false);
		handle.input({ type: "pointer", x: 1, y: 0.5, button: 2, action: "down" });
		handle.input({ type: "text", text: "--file $(touch /tmp/no)" });
		expect(mocks.execFile).toHaveBeenCalledTimes(1);
		expect(mocks.execFile.mock.calls[0][1]).toEqual(["mousemove", "--sync", "1919", "540", "mousedown", "3"]);
		done();
		expect(mocks.execFile.mock.calls[1][1]).toEqual([
			"type",
			"--clearmodifiers",
			"--delay",
			"0",
			"--",
			"--file $(touch /tmp/no)",
		]);
		done();
		handle.close();
		expect(mocks.execFile.mock.calls[2][1]).toEqual(["mouseup", "3"]);
	});
	it("waits for an interrupted command before releasing and never executes queued downs", async () => {
		const handle = await started(false);
		handle.input({ type: "key", code: "ShiftLeft", action: "down" });
		handle.input({ type: "key", code: "KeyA", action: "down" });
		handle.close();
		handle.close();
		expect(commands[0].kill).toHaveBeenCalledWith("SIGKILL");
		expect(mocks.execFile).toHaveBeenCalledTimes(1);
		done(new Error("killed"));
		expect(mocks.execFile.mock.calls[1][1]).toEqual(["keyup", "Shift_L"]);
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(onError).not.toHaveBeenCalled();
	});
	it("release cancels queued input and close still releases if that release was interrupted", async () => {
		const handle = await started(false);
		handle.input({ type: "key", code: "KeyA", action: "down" });
		handle.input({ type: "key", code: "KeyB", action: "down" });
		handle.input({ type: "release" });
		done();
		expect(mocks.execFile.mock.calls[1][1]).toEqual(["keyup", "a"]);
		handle.close();
		done(new Error("killed"));
		expect(mocks.execFile.mock.calls[2][1]).toEqual(["keyup", "a"]);
	});
	it("rejects invalid inputs and bounds queue flooding", async () => {
		const handle = await started(false);
		handle.input({ type: "pointer", x: NaN, y: 0, action: "move" });
		handle.input({ type: "key", code: "--file", action: "down" });
		handle.input({ type: "text", text: "a".repeat(4097) });
		handle.input({ type: "wheel", deltaY: Infinity });
		expect(mocks.execFile).not.toHaveBeenCalled();
		for (let index = 0; index < 131; index++) handle.input({ type: "wheel", deltaY: 10 });
		expect(onError).toHaveBeenCalledWith(expect.stringContaining("queue"));
		expect(onClose).toHaveBeenCalledTimes(1);
	});
	it("bounds stderr, reports process failure once and kills only its own capture", async () => {
		await started();
		capture.stderr.emit("data", Buffer.from("x".repeat(20000)));
		capture.emit("close", 1, null);
		capture.emit("error", new Error("late"));
		expect(onError).toHaveBeenCalledTimes(1);
		expect(onError.mock.calls[0][0].length).toBeLessThan(4300);
		expect(onClose).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(1000);
		expect(capture.kill).toHaveBeenCalledWith("SIGKILL");
	});
	it("handles ffmpeg spawn failure once and clears its termination timer on exit", async () => {
		const handle = await started();
		capture.emit("error", new Error("spawn EACCES"));
		expect(onError).toHaveBeenCalledWith(expect.stringContaining("spawn EACCES"));
		capture.emit("close", -1, null);
		vi.advanceTimersByTime(1000);
		expect(capture.kill.mock.calls).toEqual([["SIGTERM"]]);
		handle.close();
		expect(onClose).toHaveBeenCalledTimes(1);
	});
	it("reports input execution errors", async () => {
		const handle = await started(false);
		handle.input({ type: "key", code: "KeyA", action: "down" });
		done(new Error("permission denied"));
		expect(onError).toHaveBeenCalledWith(expect.stringContaining("permission denied"));
		expect(mocks.execFile.mock.calls[1][1]).toEqual(["keyup", "a"]);
	});
});
