import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
	spawn: vi.fn(),
	readFile: vi.fn(),
	writeFile: vi.fn(),
	rename: vi.fn(),
	rm: vi.fn(),
	access: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawn: mock.spawn }));
vi.mock("node:fs/promises", () => ({
	...mock,
	mkdir: vi.fn(),
	mkdtemp: async (prefix: string) => prefix + "fixture",
	chmod: vi.fn(),
}));
beforeEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
	vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
	mock.readFile.mockRejectedValue(new Error("missing"));
	mock.spawn.mockImplementation(() => {
		const child = Object.assign(new EventEmitter(), { stderr: new PassThrough(), kill: vi.fn() });
		queueMicrotask(() => child.emit("close", 0));
		return child;
	});
});
afterEach(() => vi.restoreAllMocks());
it("builds once at a stable path and reuses the same binary after restarting Node", async () => {
	let { macDesktopHelper } = await import("../../server/device-center/native-desktop/macos-helper.js");
	const [capture, permissions] = await Promise.all([macDesktopHelper(), macDesktopHelper()]);
	expect(capture).toBe(permissions);
	expect(capture).toMatch(/native-desktop[\\/]PiWebDesktop$/);
	expect(mock.spawn).toHaveBeenCalledTimes(1);
	expect(mock.spawn.mock.calls[0][1]).toContain("swiftc");
	expect(mock.rename.mock.calls[0][1]).toBe(capture);
	const hash = mock.writeFile.mock.calls.find(([path]) => path.endsWith("source.sha256"))![1];
	mock.readFile.mockResolvedValue(hash);
	vi.resetModules();
	({ macDesktopHelper } = await import("../../server/device-center/native-desktop/macos-helper.js"));
	expect(await macDesktopHelper()).toBe(capture);
	expect(mock.spawn).toHaveBeenCalledTimes(1);
});
it("does not cache a failed build or replace the working executable", async () => {
	mock.spawn.mockImplementationOnce(() => {
		const child = Object.assign(new EventEmitter(), { stderr: new PassThrough(), kill: vi.fn() });
		queueMicrotask(() => {
			child.stderr.write("compiler missing");
			child.emit("close", 1);
		});
		return child;
	});
	const { macDesktopHelper } = await import("../../server/device-center/native-desktop/macos-helper.js");
	await expect(macDesktopHelper()).rejects.toThrow("MAC_DESKTOP_BUILD_FAILED");
	expect(mock.rename).not.toHaveBeenCalled();
	expect(mock.rm).toHaveBeenCalled();
	await expect(macDesktopHelper()).resolves.toMatch(/PiWebDesktop$/);
	expect(mock.spawn).toHaveBeenCalledTimes(2);
});
