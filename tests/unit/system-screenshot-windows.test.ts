import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));
import { captureWindowsScreenshot, windowsScreenshotScript } from "../../server/system-screenshot-windows.js";

const token = "b".repeat(32);
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a+VQAAAAASUVORK5CYII=";
function fakeChild() {
	return Object.assign(new EventEmitter(), {
		stdin: new PassThrough(),
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		kill: vi.fn(),
	});
}
let child: ReturnType<typeof fakeChild>;
beforeEach(() => {
	vi.useFakeTimers();
	spawn.mockReset();
	child = fakeChild();
	spawn.mockReturnValue(child);
});
afterEach(() => {
	vi.useRealTimers();
});

describe("Windows screenshot helper", () => {
	it("starts a hidden STA process and returns a PNG after the helper has restored the window and exited", async () => {
		const pending = captureWindowsScreenshot(token, "zh", new AbortController().signal);
		child.stdout.write(png.slice(0, 20));
		child.stdout.write(png.slice(20));
		child.emit("close", 0);
		expect(await pending).toBe(`data:image/png;base64,${png}`);
		expect(spawn.mock.calls[0][0]).toBe("powershell.exe");
		expect(spawn.mock.calls[0][1]).toContain("-STA");
		expect(spawn.mock.calls[0][2]).toMatchObject({ windowsHide: true });
		expect(vi.getTimerCount()).toBe(0);
	});
	it("encodes Unicode instructions without interpolating arbitrary user input", () => {
		expect(windowsScreenshotScript(token, "zh")).toContain("拖动框选");
		expect(() => windowsScreenshotScript("'; malicious", "en")).toThrow("invalid screenshot token");
		const pending = captureWindowsScreenshot(token, "en", new AbortController().signal);
		const args = spawn.mock.calls[0][1] as string[];
		const encoded = args[args.indexOf("-EncodedCommand") + 1];
		expect(Buffer.from(encoded, "base64").toString("utf16le")).toBe(windowsScreenshotScript(token, "en"));
		expect(args.join(" ").length + 64).toBeLessThan(32767);
		child.emit("close", 0);
		return pending;
	});
	it.each([false, true])("passes hideWindow=%s as a native boolean", async (hideWindow) => {
		const pending = captureWindowsScreenshot(token, "en", new AbortController().signal, hideWindow);
		const args = spawn.mock.calls[0][1] as string[];
		const script = Buffer.from(args[args.indexOf("-EncodedCommand") + 1], "base64").toString("utf16le");
		expect(script).toContain(`[PiScreenSelection]::Run('${token}', `);
		expect(script).toContain(`, ${process.pid}, $${hideWindow ? "true" : "false"})`);
		child.stdout.write(png);
		child.emit("close", 0);
		expect(await pending).toBe(`data:image/png;base64,${png}`);
	});
	it("does not restore a visible window when a capture is forcibly cancelled", async () => {
		const controller = new AbortController();
		const pending = captureWindowsScreenshot(token, "en", controller.signal, false);
		controller.abort();
		await vi.advanceTimersByTimeAsync(5000);
		expect(child.kill).toHaveBeenCalledOnce();
		expect(spawn).toHaveBeenCalledOnce();
		child.emit("close", null);
		expect(await pending).toBe(null);
		expect(vi.getTimerCount()).toBe(0);
	});
	it("rejects a changed foreground window and permits a normal user cancellation", async () => {
		const failed = captureWindowsScreenshot(token, "en", new AbortController().signal);
		child.stderr.write("window-not-focused");
		child.emit("close", 1);
		await expect(failed).rejects.toThrow("window-not-focused");
		const cancelled = captureWindowsScreenshot(token, "en", new AbortController().signal);
		child.emit("close", 0);
		expect(await cancelled).toBe(null);
	});
	it("requests graceful cancellation before ending the process, then recovers the original window if needed", async () => {
		const controller = new AbortController();
		const end = vi.spyOn(child.stdin, "end");
		const pending = captureWindowsScreenshot(token, "en", controller.signal);
		child.stderr.write("window:123456:3\n");
		controller.abort();
		expect(end).toHaveBeenCalledWith("cancel\n");
		expect(child.kill).not.toHaveBeenCalled();
		const restore = fakeChild();
		spawn.mockReturnValueOnce(restore);
		await vi.advanceTimersByTimeAsync(5000);
		expect(child.kill).toHaveBeenCalledOnce();
		expect(spawn.mock.calls[1][1].join(" ")).toContain("[IntPtr]123456, 3");
		child.emit("close", null);
		expect(await pending).toBe(null);
		expect(vi.getTimerCount()).toBe(0);
	});
	it("does not spawn for an already aborted request and clears timers on launch failure", async () => {
		const controller = new AbortController();
		controller.abort();
		expect(await captureWindowsScreenshot(token, "en", controller.signal)).toBe(null);
		expect(spawn).not.toHaveBeenCalled();
		const failed = captureWindowsScreenshot(token, "en", new AbortController().signal);
		child.emit("error", new Error("ENOENT"));
		await expect(failed).rejects.toThrow("ENOENT");
		expect(vi.getTimerCount()).toBe(0);
	});
	it("rejects malformed helper output", async () => {
		const failed = captureWindowsScreenshot(token, "en", new AbortController().signal);
		child.stdout.write("diagnostics, not a PNG");
		child.emit("close", 0);
		await expect(failed).rejects.toThrow("capture-failed");
	});
});
