import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawn, mkdtemp, readFile, rm } = vi.hoisted(() => ({
	spawn: vi.fn(),
	mkdtemp: vi.fn(),
	readFile: vi.fn(),
	rm: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawn }));
vi.mock("node:fs/promises", () => ({ mkdtemp, readFile, rm }));
import {
	MAC_FRONT_APP_SCRIPT,
	MAC_OSASCRIPT,
	MAC_PS,
	MAC_SCREENCAPTURE,
	ancestorPids,
	captureMacScreenshot,
	macScreenshotArgs,
	macVisibilityScript,
} from "../../server/system-screenshot-macos.js";

const token = "c".repeat(32);
const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a+VQAAAAASUVORK5CYII=",
	"base64",
);

type Reply = { code: number; stdout?: string; stderr?: string };
const replies = new Map<string, Reply[]>();
function reply(command: string, ...values: Reply[]) {
	replies.set(command, values);
}
function fakeChild() {
	return Object.assign(new EventEmitter(), {
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		kill: vi.fn(),
	});
}

beforeEach(() => {
	replies.clear();
	spawn.mockReset();
	mkdtemp.mockReset().mockResolvedValue("/tmp/pi-web-ui-shot-test");
	rm.mockReset().mockResolvedValue(undefined);
	readFile.mockReset().mockResolvedValue(png);
	spawn.mockImplementation((command: string) => {
		const child = fakeChild();
		setImmediate(() => {
			const next = replies.get(command)?.shift() ?? { code: 0 };
			child.stdout.write(next.stdout ?? "");
			child.stderr.write(next.stderr ?? "");
			child.emit("close", next.code);
		});
		return child;
	});
});
afterEach(() => {
	vi.clearAllMocks();
});

const captureArgs = () => spawn.mock.calls.filter(([command]) => command === MAC_SCREENCAPTURE);
const scriptArgs = () => spawn.mock.calls.filter(([command]) => command === MAC_OSASCRIPT);

describe("macOS screenshot helper", () => {
	it("captures interactively into a private temp file and returns a PNG data URL", async () => {
		const result = await captureMacScreenshot(token, "zh", new AbortController().signal, false);
		expect(result).toBe(`data:image/png;base64,${png.toString("base64")}`);
		expect(captureArgs()).toHaveLength(1);
		expect(spawn.mock.calls[0][1]).toEqual(macScreenshotArgs("/tmp/pi-web-ui-shot-test/capture.png"));
		expect(spawn.mock.calls[0][1]).toEqual(["-i", "-x", "-t", "png", "/tmp/pi-web-ui-shot-test/capture.png"]);
		// Keeping the window visible never touches other applications.
		expect(scriptArgs()).toHaveLength(0);
		expect(rm).toHaveBeenCalledWith("/tmp/pi-web-ui-shot-test", { recursive: true, force: true });
	});
	it("hides and restores the frontmost app when its window title carries the nonce", async () => {
		reply(MAC_OSASCRIPT, { code: 0, stdout: `Google Chrome\n4242\npi web ui [${token}]\n` }, { code: 0 }, { code: 0 });
		await captureMacScreenshot(token, "en", new AbortController().signal, true);
		const calls = scriptArgs().map(([, args]) => args as string[]);
		expect(calls[0]).toEqual(["-e", MAC_FRONT_APP_SCRIPT]);
		expect(calls[1]).toEqual(["-e", macVisibilityScript(false), "Google Chrome"]);
		expect(calls[2]).toEqual(["-e", macVisibilityScript(true), "Google Chrome"]);
		expect(calls[1][1]).toContain("set visible of targetProcess to false");
		expect(calls[2][1]).toContain("set frontmost of targetProcess to true");
		// The app is hidden before the overlay opens and restored before the promise settles.
		const order = spawn.mock.calls.map(([command]) => command);
		expect(order).toEqual([MAC_OSASCRIPT, MAC_OSASCRIPT, MAC_SCREENCAPTURE, MAC_OSASCRIPT]);
	});
	it("refuses to hide an unrelated app when the nonce is missing from the front window title", async () => {
		reply(MAC_OSASCRIPT, { code: 0, stdout: "Finder\n4242\nDesktop\n" });
		reply(MAC_PS, { code: 0, stdout: `${process.pid} 1\n` });
		await expect(captureMacScreenshot(token, "zh", new AbortController().signal, true)).rejects.toThrow(
			"window-not-focused",
		);
		expect(captureArgs()).toHaveLength(0);
		expect(spawn.mock.calls.filter(([command]) => command === MAC_OSASCRIPT)).toHaveLength(1);
	});
	it("hides the host app even without the nonce when the frontmost app is our own ancestor", async () => {
		// 桌面端内嵌浏览器窗口的标题是固定的（"pi Browser"），nonce 永远进不了窗口标题：
		// 此时靠「前台应用是承载服务端的宿主进程」来确认，而不是误判为焦点变化。
		reply(
			MAC_OSASCRIPT,
			{ code: 0, stdout: `pi-web-ui-desktop\n${process.ppid}\npi Browser\n` },
			{ code: 0 },
			{ code: 0 },
		);
		reply(MAC_PS, { code: 0, stdout: `${process.ppid} ${process.ppid}\n${process.pid} ${process.ppid}\n` });
		const result = await captureMacScreenshot(token, "zh", new AbortController().signal, true);
		expect(result).toContain("data:image/png;base64,");
		const calls = scriptArgs().map(([, args]) => args as string[]);
		expect(calls[1]).toEqual(["-e", macVisibilityScript(false), "pi-web-ui-desktop"]);
		expect(calls[2]).toEqual(["-e", macVisibilityScript(true), "pi-web-ui-desktop"]);
	});
	it("only walks the process tree when the window title does not carry the nonce", async () => {
		reply(MAC_OSASCRIPT, { code: 0, stdout: `Google Chrome\n4242\npi web ui [${token}]\n` }, { code: 0 }, { code: 0 });
		await captureMacScreenshot(token, "en", new AbortController().signal, true);
		expect(spawn.mock.calls.filter(([command]) => command === MAC_PS)).toHaveLength(0);
	});
	it("keeps capturing with the window visible when Automation permission is missing", async () => {
		reply(MAC_OSASCRIPT, { code: 1, stderr: "Not authorized to send Apple events to System Events." });
		const result = await captureMacScreenshot(token, "en", new AbortController().signal, true);
		expect(result).toContain("data:image/png;base64,");
		expect(captureArgs()).toHaveLength(1);
		expect(scriptArgs()).toHaveLength(1);
	});
	it("treats a missing or empty capture file as a user cancellation", async () => {
		readFile.mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }));
		expect(await captureMacScreenshot(token, "zh", new AbortController().signal, false)).toBeNull();
		readFile.mockResolvedValueOnce(Buffer.alloc(0));
		expect(await captureMacScreenshot(token, "zh", new AbortController().signal, false)).toBeNull();
	});
	it("rejects non-PNG output and invalid tokens, and skips already aborted requests", async () => {
		readFile.mockResolvedValueOnce(Buffer.from("not a png"));
		await expect(captureMacScreenshot(token, "en", new AbortController().signal, false)).rejects.toThrow(
			"capture-failed",
		);
		await expect(captureMacScreenshot("'; rm -rf /", "en", new AbortController().signal, false)).rejects.toThrow(
			"invalid screenshot token",
		);
		const controller = new AbortController();
		controller.abort();
		const callsBefore = spawn.mock.calls.length;
		expect(await captureMacScreenshot(token, "en", controller.signal, false)).toBeNull();
		expect(spawn.mock.calls.length).toBe(callsBefore);
	});
});

describe("ancestorPids", () => {
	it("walks up the ps parent table and stops at a missing or init parent", async () => {
		reply(MAC_PS, {
			code: 0,
			stdout: [`${process.pid} 999001`, "999001 999002", "999002 1", "1 0"].join("\n"),
		});
		const chain = await ancestorPids(new AbortController().signal);
		expect(chain.has(process.pid)).toBe(true);
		expect(chain.has(999001)).toBe(true);
		expect(chain.has(999002)).toBe(true);
		expect(chain.has(1)).toBe(false);
	});
	it("survives a ps failure by keeping only the current process", async () => {
		reply(MAC_PS, { code: 1, stderr: "denied" });
		const chain = await ancestorPids(new AbortController().signal);
		expect([...chain]).toEqual([process.pid]);
	});
});
