import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	spawn: vi.fn(),
	exec: vi.fn(),
	release: vi.fn(),
	exists: vi.fn(),
	write: vi.fn(),
	remove: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn, execFileSync: mocks.exec }));
vi.mock("node:os", async (original) => ({ ...(await original<typeof import("node:os")>()), release: mocks.release }));
vi.mock("node:fs", () => ({
	existsSync: mocks.exists,
	mkdtempSync: () => "/tmp/native-test",
	writeFileSync: mocks.write,
	rm: mocks.remove,
}));
import {
	nativeDesktopStatus,
	requestNativeDesktopPermissions,
	startNativeDesktop,
	type NativeDesktopInput,
} from "../../server/device-center/desktop-native.js";

function processFixture(blockInput = false) {
	const writes: string[] = [];
	const child = Object.assign(new EventEmitter(), {
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		stdin: new Writable({
			write(chunk, _encoding, done) {
				writes.push(chunk.toString());
				if (!blockInput) done();
			},
		}),
		kill: vi.fn(),
	});
	mocks.spawn.mockReturnValue(child);
	return { child, writes };
}
const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]);
function packet(payload = jpeg) {
	const header = Buffer.alloc(4);
	header.writeUInt32BE(payload.length);
	return Buffer.concat([header, payload]);
}
function options(readOnly?: boolean) {
	return { onFrame: vi.fn(), onError: vi.fn(), onClose: vi.fn(), readOnly };
}
beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(process, "platform", "get").mockReturnValue("win32");
	mocks.exists.mockReturnValue(true);
	mocks.release.mockReturnValue("23.0.0");
	mocks.exec.mockReset();
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

describe("native desktop lifecycle and framed capture", () => {
	it("forces preview helpers to stay read-only even if control was requested", () => {
		const { child, writes } = processFixture();
		const session = startNativeDesktop({ ...options(false), preview: true });
		expect(mocks.spawn.mock.calls[0][1]).toContain("preview");
		session.input({ type: "text", text: "must not type" });
		expect(writes).toEqual([]);
		session.close();
		child.emit("close", 0);
	});
	it("reports real runtime requirements and unsupported platforms", () => {
		expect(nativeDesktopStatus()).toEqual({ supported: true, backend: "windows-gdi-sendinput" });
		mocks.exists.mockReturnValue(false);
		expect(nativeDesktopStatus().supported).toBe(false);
		vi.spyOn(process, "platform", "get").mockReturnValue("linux");
		expect(nativeDesktopStatus()).toMatchObject({ supported: false, backend: "unsupported" });
	});

	it("recognizes full Xcode without a CommandLineTools directory using bounded xcrun discovery", () => {
		vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
		mocks.exists.mockReturnValue(false);
		mocks.exec.mockReturnValue(
			"/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swift\n",
		);
		expect(nativeDesktopStatus()).toMatchObject({ supported: true, backend: "macos-screencapturekit" });
		expect(mocks.exec).toHaveBeenCalledWith(
			"/usr/bin/xcrun",
			["--find", "swift"],
			expect.objectContaining({ timeout: 1500, maxBuffer: 4096 }),
		);
		mocks.exec.mockImplementation(() => {
			throw new Error("timeout");
		});
		expect(nativeDesktopStatus()).toMatchObject({ supported: false, reason: expect.stringContaining("Xcode") });
		mocks.exec.mockClear();
		mocks.release.mockReturnValue("22.0.0");
		expect(nativeDesktopStatus()).toMatchObject({ supported: false, reason: expect.stringContaining("macOS 14") });
		expect(mocks.exec).not.toHaveBeenCalled();
	});

	it("preserves macOS permission guidance from the actual capture host and releases its process", () => {
		vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
		mocks.exec.mockReturnValue("/usr/bin/swift\n");
		const { child } = processFixture();
		const o = options();
		startNativeDesktop(o);
		const message = "MAC_SCREEN_PERMISSION_REQUIRED: Authorize the responsible host on the controlled Mac.";
		child.stderr.write(message);
		child.emit("close", 1);
		expect(o.onError).toHaveBeenCalledWith(message);
		expect(o.onClose).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(60000);
		expect(o.onError).toHaveBeenCalledTimes(1);
	});

	it("reassembles arbitrary header/payload splits and coalesced frames using one persistent process", () => {
		const { child, writes } = processFixture();
		const o = options();
		const session = startNativeDesktop(o);
		const bytes = Buffer.concat([packet(), packet()]);
		for (const byte of bytes.subarray(0, 7)) child.stdout.write(Buffer.from([byte]));
		child.stdout.write(bytes.subarray(7));
		expect(o.onFrame.mock.calls).toEqual([[jpeg], [jpeg]]);
		expect(writes).toEqual(['{"type":"ack"}\n', '{"type":"ack"}\n']);
		expect(mocks.spawn).toHaveBeenCalledTimes(1);
		expect(mocks.spawn.mock.calls[0][1]).toContain("view");
		expect(mocks.write.mock.calls[0][1]).toContain("SendInput");
		session.close();
		child.emit("close", 0, null);
		expect(o.onClose).toHaveBeenCalledTimes(1);
		expect(o.onError).not.toHaveBeenCalled();
		expect(mocks.remove).toHaveBeenCalledTimes(1);
	});

	it.each([0, 3, 4 * 1024 * 1024 + 1, 0xffffffff])(
		"rejects oversized/invalid length %i before allocating payload",
		(length) => {
			const { child } = processFixture();
			const o = options();
			startNativeDesktop(o);
			const header = Buffer.alloc(4);
			header.writeUInt32BE(length);
			child.stdout.write(header);
			expect(o.onError).toHaveBeenCalledWith(expect.stringContaining("frame length"));
			child.emit("close", 0);
			expect(o.onClose).toHaveBeenCalledTimes(1);
		},
	);

	it("rejects invalid JPEG and clears partial frame on disconnect", () => {
		const { child } = processFixture();
		const o = options();
		const session = startNativeDesktop(o);
		child.stdout.write(packet(Buffer.from([0, 0, 0, 0])));
		child.stdout.write(packet());
		expect(o.onFrame).not.toHaveBeenCalled();
		session.close();
		session.close();
		child.emit("close", 1);
		child.emit("close", 1);
		expect(o.onError).toHaveBeenCalledTimes(1);
		expect(o.onClose).toHaveBeenCalledTimes(1);
	});

	it("keeps stderr bounded and reports unexpected exit once", () => {
		const { child } = processFixture();
		const o = options();
		startNativeDesktop(o);
		child.stderr.write("x".repeat(20000));
		child.emit("close", 1);
		expect(o.onError.mock.calls[0][0]).toHaveLength(8192);
		expect(o.onClose).toHaveBeenCalledTimes(1);
	});

	it("reports spawn failure and closes despite missing close event", async () => {
		mocks.spawn.mockImplementationOnce(() => {
			throw new Error("missing helper");
		});
		const o = options();
		startNativeDesktop(o);
		await Promise.resolve();
		expect(o.onError).toHaveBeenCalledWith(expect.stringContaining("missing helper"));
		expect(o.onClose).toHaveBeenCalledTimes(1);
	});

	it("gracefully requests release through close/EOF, then kills a hung helper after a deadline", () => {
		const { child, writes } = processFixture();
		const o = options(false);
		const session = startNativeDesktop(o);
		session.input({ type: "key", code: "ShiftLeft", action: "down" });
		session.close();
		session.close();
		expect(writes).toContain('{"type":"close"}\n');
		expect(child.stdin.writableEnded).toBe(true);
		session.input({ type: "key", code: "KeyA", action: "down" });
		expect(writes).toHaveLength(2);
		vi.advanceTimersByTime(1499);
		expect(child.kill).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(child.kill).toHaveBeenCalledTimes(1);
		child.emit("close", null, "SIGTERM");
		expect(o.onClose).toHaveBeenCalledTimes(1);
	});

	it("times out silent helpers and cancels watchdog after closing", () => {
		const { child } = processFixture();
		const o = options();
		startNativeDesktop(o);
		vi.advanceTimersByTime(45000);
		expect(o.onError).toHaveBeenCalledWith(expect.stringContaining("timed out"));
		child.emit("close", 0);
		vi.advanceTimersByTime(60000);
		expect(o.onError).toHaveBeenCalledTimes(1);
	});
});

describe("local macOS permission requests", () => {
	beforeEach(() => {
		vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
		mocks.exec.mockReturnValue("/usr/bin/swift\n");
	});

	it.each(["screen", "control"] as const)(
		"uses the capture identity and %s mode, returning actual status",
		async (kind) => {
			const { child } = processFixture();
			const result = requestNativeDesktopPermissions(kind);
			expect(mocks.spawn).toHaveBeenCalledWith(
				"/usr/bin/swift",
				[expect.stringContaining("capture.swift"), `permissions-${kind}`],
				expect.objectContaining({ stdio: ["pipe", "pipe", "pipe"] }),
			);
			expect(mocks.write).toHaveBeenCalledWith(
				expect.any(String),
				expect.stringContaining('mode == "permissions-screen" || mode == "permissions-control"'),
				{ mode: 0o600 },
			);
			child.stdout.write('{"screen":false,');
			child.stdout.write('"accessibility":true}');
			expect(mocks.remove).not.toHaveBeenCalled();
			child.emit("close", 0);
			await expect(result).resolves.toEqual({ screen: false, accessibility: true });
			expect(mocks.remove).toHaveBeenCalledWith(
				"/tmp/native-test",
				expect.objectContaining({ recursive: true }),
				expect.any(Function),
			);
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it("keeps all prompting inside permission modes and checks capture permissions without prompting", () => {
		const { child } = processFixture();
		startNativeDesktop(options(false));
		const script = mocks.write.mock.calls[0][1] as string;
		const branch = script.indexOf('if mode == "permissions-screen" || mode == "permissions-control"');
		const end = script.indexOf("exit(0)", branch);
		for (const call of [
			"CGRequestScreenCaptureAccess()",
			"AXIsProcessTrustedWithOptions(prompt)",
			'openPrivacy("Privacy_ScreenCapture")',
			'openPrivacy("Privacy_Accessibility")',
		]) {
			expect(script.indexOf(call)).toBeGreaterThan(branch);
			expect(script.lastIndexOf(call)).toBeLessThan(end);
		}
		expect(script.slice(branch, end)).toContain('if mode == "permissions-control" && !AXIsProcessTrusted()');
		expect(script.slice(branch, end)).not.toContain('fail("MAC_');
		expect(script.slice(end)).toContain("MAC_SCREEN_PERMISSION_REQUIRED");
		expect(script.slice(end)).toContain("MAC_ACCESSIBILITY_PERMISSION_REQUIRED");
		expect(script.slice(end)).toContain("local Device Center");
		child.emit("close", 1);
	});

	it.each(["not json", '{"screen":true}', '{"screen":"true","accessibility":true}', "null"])(
		"rejects malformed result %s",
		async (json) => {
			const { child } = processFixture();
			const result = requestNativeDesktopPermissions("screen");
			child.stdout.write(json);
			child.emit("close", 0);
			await expect(result).rejects.toThrow("Invalid native desktop permission response");
		},
	);

	it("rejects exit errors with bounded stderr", async () => {
		const { child } = processFixture();
		const result = requestNativeDesktopPermissions("control");
		child.stderr.write("x".repeat(20000) + "DENIED");
		child.emit("close", 1);
		const error = await result.catch((error: Error) => error);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toHaveLength(8192);
		expect((error as Error).message.endsWith("DENIED")).toBe(true);
	});

	it("bounds stdout and kills only its helper, cleaning up after close", async () => {
		const { child } = processFixture();
		const result = requestNativeDesktopPermissions("screen");
		child.stdout.write(Buffer.alloc(4097));
		await expect(result).rejects.toThrow("exceeds 4 KB");
		expect(child.kill).toHaveBeenCalledWith("SIGTERM");
		expect(mocks.remove).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1500);
		expect(child.kill).toHaveBeenLastCalledWith("SIGKILL");
		child.emit("close", null, "SIGKILL");
		expect(mocks.remove).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("aborts in flight without accepting a later successful result", async () => {
		const { child } = processFixture();
		const controller = new AbortController();
		const result = requestNativeDesktopPermissions("control", controller.signal);
		controller.abort();
		await expect(result).rejects.toThrow("aborted");
		expect(child.kill).toHaveBeenCalledWith("SIGTERM");
		expect(mocks.remove).not.toHaveBeenCalled();
		child.stdout.write('{"screen":true,"accessibility":true}');
		child.emit("close", 0);
		expect(mocks.remove).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("allows system prompts 120 seconds then times out", async () => {
		const { child } = processFixture();
		const result = requestNativeDesktopPermissions("screen");
		vi.advanceTimersByTime(119999);
		expect(child.kill).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		await expect(result).rejects.toThrow("timed out");
		expect(child.kill).toHaveBeenCalledWith("SIGTERM");
		child.emit("close", null, "SIGTERM");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("handles asynchronous spawn failure and waits for close before cleanup", async () => {
		const { child } = processFixture();
		const result = requestNativeDesktopPermissions("screen");
		child.emit("error", new Error("spawn failed"));
		await expect(result).rejects.toThrow("spawn failed");
		expect(mocks.remove).not.toHaveBeenCalled();
		child.emit("close", -1);
		expect(mocks.remove).toHaveBeenCalledTimes(1);
	});

	it("cleans up if spawning throws synchronously", async () => {
		mocks.spawn.mockImplementationOnce(() => {
			throw new Error("cannot spawn");
		});
		await expect(requestNativeDesktopPermissions("screen")).rejects.toThrow("cannot spawn");
		expect(mocks.remove).toHaveBeenCalledTimes(1);
	});

	it("does not spawn for pre-aborted requests or other platforms", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(requestNativeDesktopPermissions("screen", controller.signal)).rejects.toThrow("aborted");
		vi.spyOn(process, "platform", "get").mockReturnValue("win32");
		await expect(requestNativeDesktopPermissions("screen")).rejects.toThrow("require macOS");
		expect(mocks.spawn).not.toHaveBeenCalled();
		expect(mocks.write).not.toHaveBeenCalled();
	});
});

describe("native desktop input validation", () => {
	it("forwards keypad digits, operators, Enter and NumLock with balanced key releases", () => {
		const { child, writes } = processFixture();
		const session = startNativeDesktop(options(false));
		const codes = [
			...Array.from({ length: 10 }, (_, i) => `Numpad${i}`),
			"NumpadEnter",
			"NumpadAdd",
			"NumpadSubtract",
			"NumpadMultiply",
			"NumpadDivide",
			"NumpadDecimal",
			"NumpadComma",
			"NumpadEqual",
			"NumpadClear",
			"NumLock",
		];
		const events = codes.flatMap(
			(code) =>
				[
					{ type: "key", code, action: "down" },
					{ type: "key", code, action: "up" },
				] as NativeDesktopInput[],
		);
		for (const event of events) session.input(event);
		expect(writes.map((value) => JSON.parse(value))).toEqual(events);
		for (const code of ["Numpad10", "Numpad-1", "NumpadUnknown"]) session.input({ type: "key", code, action: "down" });
		expect(writes).toHaveLength(events.length);
		session.close();
		child.emit("close", 0);
	});
	it("defaults to immutable read-only and never forwards input", () => {
		const { child, writes } = processFixture();
		const config = options();
		const session = startNativeDesktop(config);
		config.readOnly = false;
		session.input({ type: "pointer", x: 0, y: 1, action: "down" });
		session.input({ type: "text", text: "secret" });
		expect(writes).toEqual([]);
		session.close();
		child.emit("close", 0);
	});

	it("validates finite normalized coordinates, bounded text and DOM key codes; strips extras", () => {
		const { child, writes } = processFixture();
		const session = startNativeDesktop(options(false));
		const invalid = [
			null,
			{ type: "pointer", x: -0.1, y: 0, action: "move" },
			{ type: "pointer", x: NaN, y: 0, action: "move" },
			{ type: "pointer", x: 0, y: Infinity, action: "move" },
			{ type: "pointer", x: 0, y: 0, action: "down", button: 3 },
			{ type: "key", code: "Unknown", action: "down" },
			{ type: "key", code: "KeyA", action: "press" },
			{ type: "text", text: "x".repeat(4097) },
			{ type: "text", text: "\0" },
			{ type: "wheel", deltaY: Infinity },
		];
		for (const event of invalid) session.input(event as NativeDesktopInput);
		expect(writes).toEqual([]);
		session.input({ type: "pointer", x: 1, y: 0, action: "down", extra: "ignored" } as NativeDesktopInput);
		session.input({ type: "wheel", deltaY: 999999 });
		session.input({ type: "key", code: "KeyA", action: "down" });
		session.input({ type: "text", text: "中文\n😀" });
		session.input({ type: "release" });
		expect(writes.map((s) => JSON.parse(s))).toEqual([
			{ type: "pointer", x: 1, y: 0, action: "down", button: 0 },
			{ type: "wheel", deltaY: 1200 },
			{ type: "key", code: "KeyA", action: "down" },
			{ type: "text", text: "中文\n😀" },
			{ type: "release" },
		]);
		session.close();
		child.emit("close", 0);
	});

	it("closes stalled input instead of growing an unbounded queue or dropping key releases", () => {
		const { child } = processFixture(true);
		const o = options(false);
		const session = startNativeDesktop(o);
		for (let i = 0; i < 100; i++) session.input({ type: "text", text: "x".repeat(4096) });
		expect(child.stdin.writableLength).toBeLessThanOrEqual(64 * 1024);
		expect(o.onError).toHaveBeenCalledTimes(1);
		child.emit("close", 0);
	});
});
