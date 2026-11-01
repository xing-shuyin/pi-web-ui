import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteSshService } from "../../server/remote-ssh-service.js";

const uri = "ssh://tester@example.test/work";
function setup() {
	const service = Object.create(RemoteSshService.prototype) as RemoteSshService;
	const stream = Object.assign(new EventEmitter(), {
		end: vi.fn(),
		destroy: vi.fn(),
		writableFinished: false,
		_writableState: { emitClose: false, finalCalled: false } as { emitClose: boolean; finalCalled?: boolean },
	});
	const sftp = { createWriteStream: vi.fn(() => stream), end: vi.fn() };
	const client = { end: vi.fn() };
	const connect = vi.spyOn(service as any, "getOrConnectByUri").mockResolvedValue({ sftp, conn: { client } });
	const controller = new AbortController();
	let settled = false;
	const start = async (opts: Parameters<RemoteSshService["sftpWriteFile"]>[3] = {}) => {
		const result = service.sftpWriteFile(uri, "/work/file", Buffer.from("payload"), opts);
		void result.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await Promise.resolve();
		return { result };
	};
	return { service, stream, sftp, client, connect, controller, start, settled: () => settled };
}
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("SFTP write cancellation and resource release", () => {
	it.each(["abort", "timeout", "error"])(
		"waits for delayed close after %s and only destroys this stream",
		async (mode) => {
			vi.useFakeTimers();
			const s = setup();
			const { result } = await s.start({ signal: s.controller.signal, timeoutMs: 20 });
			const rejected = expect(result).rejects.toThrow(mode === "timeout" ? "timed out" : "write failed");
			if (mode === "abort") s.controller.abort(new Error("write failed"));
			else if (mode === "timeout") await vi.advanceTimersByTimeAsync(20);
			else s.stream.emit("error", new Error("write failed"));
			await Promise.resolve();
			expect(s.settled()).toBe(false);
			expect(s.stream.destroy).toHaveBeenCalledOnce();
			expect(s.sftp.end).not.toHaveBeenCalled();
			expect(s.client.end).not.toHaveBeenCalled();
			s.stream.emit("close");
			await rejected;
			expect(() => s.stream.emit("error", new Error("late error"))).not.toThrow();
			expect(vi.getTimerCount()).toBe(0);
		},
	);
	it("uses a 30 second default timeout", async () => {
		vi.useFakeTimers();
		const s = setup();
		const { result } = await s.start();
		const rejected = expect(result).rejects.toThrow("30000ms");
		await vi.advanceTimersByTimeAsync(29_999);
		expect(s.stream.destroy).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(s.settled()).toBe(false);
		s.stream.emit("close");
		await rejected;
	});
	it("finish alone does not settle; close resolves and removes cancellation", async () => {
		const s = setup();
		const { result } = await s.start({ signal: s.controller.signal, flag: "a" });
		expect(s.sftp.createWriteStream).toHaveBeenCalledWith("/work/file", { flags: "a" });
		s.stream.emit("finish");
		await Promise.resolve();
		expect(s.settled()).toBe(false);
		s.stream.emit("close");
		await result;
		s.controller.abort();
		expect(s.stream.destroy).not.toHaveBeenCalled();
	});
	it("handles ssh2 close immediately before finish", async () => {
		const s = setup();
		const { result } = await s.start();
		s.stream.emit("close");
		s.stream.emit("finish");
		await expect(result).resolves.toBeUndefined();
	});
	it("resolves when ssh2 closes after _final without ever emitting finish", async () => {
		// Real ssh2 SFTP WriteStream: `_final` calls destroy(), so Writable emits no `finish` —
		// only `close`, right after the SFTP CLOSE acknowledgement.
		const s = setup();
		Object.defineProperty(s.stream, "_writableState", { value: { emitClose: false, finalCalled: false } });
		const { result } = await s.start();
		expect(s.stream.writableFinished).toBe(false);
		s.stream._writableState.finalCalled = true;
		s.stream.emit("close");
		await expect(result).resolves.toBeUndefined();
	});
	it("rejects an unfinished close", async () => {
		const s = setup();
		const { result } = await s.start();
		s.stream.emit("close");
		await expect(result).rejects.toThrow("before finishing");
	});
	it("does not connect when pre-cancelled", async () => {
		const s = setup();
		s.controller.abort(new Error("pre-cancelled"));
		await expect(
			s.service.sftpWriteFile(uri, "/work/file", "x", { signal: s.controller.signal, createParents: true }),
		).rejects.toThrow("pre-cancelled");
		expect(s.connect).not.toHaveBeenCalled();
	});
	it("checks cancellation after the shared connection returns", async () => {
		const s = setup();
		let connected!: (value: any) => void;
		s.connect.mockReturnValue(
			new Promise((resolve) => {
				connected = resolve;
			}),
		);
		const { result } = await s.start({ signal: s.controller.signal });
		const rejected = expect(result).rejects.toThrow("connecting");
		s.controller.abort(new Error("connecting"));
		connected({ sftp: s.sftp });
		await rejected;
		expect(s.sftp.createWriteStream).not.toHaveBeenCalled();
	});
	it("forwards mkdir options and checks cancellation after mkdir", async () => {
		const s = setup();
		const mkdir = vi.spyOn(s.service, "execInWorkspace").mockImplementation(async () => {
			s.controller.abort(new Error("mkdir cancelled"));
			return { stdout: "", stderr: "", exitCode: 0 };
		});
		await expect(
			s.service.sftpWriteFile(uri, "/work/file", "x", {
				signal: s.controller.signal,
				timeoutMs: 50,
				createParents: true,
			}),
		).rejects.toThrow("mkdir cancelled");
		expect(mkdir).toHaveBeenCalledWith(uri, "mkdir -p '/work'", {
			cwd: "/",
			signal: s.controller.signal,
			timeoutMs: 50,
		});
		expect(s.connect).not.toHaveBeenCalled();
	});
	it("waits for a Node writable destroy callback even when ssh2 disables close events", async () => {
		const s = setup();
		let release!: (error?: Error | null) => void;
		const stream = new Writable({
			emitClose: false,
			write(_data, _encoding, _callback) {},
			destroy(_error, callback) {
				release = callback;
			},
		});
		s.sftp.createWriteStream.mockReturnValue(stream as any);
		const { result } = await s.start({ signal: s.controller.signal });
		const rejected = expect(result).rejects.toThrow("cancelled");
		s.controller.abort(new Error("cancelled"));
		expect(s.settled()).toBe(false);
		release(new Error("close failed"));
		await rejected;
	});
});
