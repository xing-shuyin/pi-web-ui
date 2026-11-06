import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { RemoteSshService } from "../../server/remote-ssh-service.js";

const uri = "ssh://tester@example.test/work";
let dataDir: string;
const services: RemoteSshService[] = [];
beforeEach(async () => {
	dataDir = await fs.mkdtemp(path.join(process.platform === "win32" ? "E:/tmp" : os.tmpdir(), "remote-ssh-command-"));
});
afterEach(async () => {
	for (const service of services.splice(0))
		for (const id of (service as any).connections.keys()) service.closeConnection(id);
	vi.restoreAllMocks();
	vi.useRealTimers();
	await fs.rm(dataDir, { recursive: true, force: true });
});
function setup() {
	const service = new RemoteSshService(dataDir);
	services.push(service);
	let callback: any;
	let command = "";
	const client = Object.assign(new EventEmitter(), {
		exec: vi.fn((cmd, _opts, cb) => {
			command = cmd;
			callback = cb;
		}),
		shell: vi.fn((_opts, cb) => {
			callback = cb;
		}),
		end: vi.fn(),
	});
	const conn = (service as any).registerConnection(client, {
		host: "example.test",
		username: "tester",
		auth: { type: "agent" },
	});
	vi.spyOn(service as any, "getOrConnectByUri").mockResolvedValue({ conn, parsed: { remotePath: "/work" } });
	vi.spyOn(service as any, "getOrConnectHost").mockResolvedValue(conn);
	const channel = Object.assign(new EventEmitter(), {
		stderr: new EventEmitter(),
		write: vi.fn(),
		close: vi.fn(),
		signal: vi.fn(),
		setWindow: vi.fn(),
		pause: vi.fn(),
		resume: vi.fn(),
	});
	const marker = (kind: string) => {
		const nonce = /PI_WEB_READY_([a-f0-9]{48})/.exec(command)?.[1];
		if (!nonce) throw new Error("Missing startup nonce");
		return `__PI_WEB_${kind}_${nonce}__`;
	};
	const output = (text: string) => channel.emit("data", Buffer.from(text));
	return {
		service,
		client,
		conn,
		channel,
		marker,
		output,
		get command() {
			return command;
		},
		open: (error: Error | null = null, stream = channel) => callback(error, stream),
		launch: (options: any = {}) =>
			service.createCommandPty(
				uri,
				{
					file: "/remote/bin/claude",
					args: ["a b", "x'$(id)"],
					env: { SECRET: "key'$(touch /tmp/never)\nnext" },
					...options.command,
				},
				80,
				24,
				options,
			),
	};
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("remote command PTY", () => {
	it("waits for fragmented non-echoing readiness, sends secrets only to stdin, and buffers initial output", async () => {
		const s = setup();
		const launched = s.launch();
		let resolved = false;
		void launched.then(() => {
			resolved = true;
		});
		await tick();
		s.open();
		expect(s.command).not.toContain("SECRET");
		expect(s.command).not.toContain("touch /tmp/never");
		expect(s.command).toContain("/bin/sh -c");
		expect(s.command).toContain("stty -echo -echonl -icanon");
		expect(s.command).toContain("exec");
		expect(s.command).toContain("/remote/bin/claude");
		expect(s.channel.write).not.toHaveBeenCalled();
		expect(resolved).toBe(false);
		const ready = s.marker("READY");
		s.output(ready.slice(0, 13));
		expect(s.channel.write).not.toHaveBeenCalled();
		s.output(ready.slice(13));
		expect(s.channel.write).toHaveBeenCalledOnce();
		const payload = s.channel.write.mock.calls[0][0];
		expect(payload).toContain("export SECRET=");
		expect(payload).toContain("touch /tmp/never");
		expect(payload).toMatch(/\nPI_WEB_END_[a-f0-9]{48}\n$/);
		expect(resolved).toBe(false);
		const start = s.marker("STARTED");
		s.output(start.slice(0, 17));
		s.output(start.slice(17) + "first\r\n");
		const pty = await launched;
		const received = vi.fn();
		pty.onData(received);
		expect(received).toHaveBeenCalledWith("first\r\n");
		s.output("second");
		expect(received).toHaveBeenLastCalledWith("second");
		pty.write("input");
		expect(s.channel.write).toHaveBeenLastCalledWith("input");
		pty.resize(100, 40);
		expect(s.channel.setWindow).toHaveBeenCalledWith(40, 100, 0, 0);
		expect(pty.cols).toBe(100);
		expect(pty.rows).toBe(40);
		pty.kill();
		expect(s.channel.close).toHaveBeenCalledOnce();
		expect(s.client.end).not.toHaveBeenCalled();
		expect(s.conn.activeOperations).toBe(0);
	});
	it("replays an early successful exit after preserving UTF-8 output", async () => {
		const s = setup();
		const launched = s.launch();
		await tick();
		s.open();
		s.output(s.marker("READY"));
		s.output(s.marker("STARTED"));
		const utf8 = Buffer.from("你好");
		s.channel.emit("data", utf8.subarray(0, 2));
		s.channel.emit("data", utf8.subarray(2));
		s.channel.emit("close", 0);
		const pty = await launched;
		const data = vi.fn();
		const exit = vi.fn();
		pty.onData(data);
		pty.onExit(exit);
		expect(data).toHaveBeenCalledWith("你好");
		expect(exit).toHaveBeenCalledWith({ exitCode: 0 });
	});
	it("rejects immediate exec failures after the start marker", async () => {
		const s = setup();
		const launched = s.launch();
		const rejected = expect(launched).rejects.toThrow("exit 127");
		await tick();
		s.open();
		s.output(s.marker("READY"));
		s.output(s.marker("STARTED"));
		s.channel.emit("close", 127);
		await rejected;
		expect(s.conn.activeOperations).toBe(0);
	});
	it("rejects missing executable/bootstrap failures before any environment is sent", async () => {
		const s = setup();
		const launched = s.launch();
		const rejected = expect(launched).rejects.toThrow("exit 126");
		await tick();
		s.open();
		s.output("not executable");
		s.channel.emit("close", 126);
		await rejected;
		expect(s.channel.write).not.toHaveBeenCalled();
		expect(s.conn.activeOperations).toBe(0);
	});
	it("rejects cancellation before connect and closes only a late channel during opening", async () => {
		const s = setup();
		const cancelled = new AbortController();
		cancelled.abort();
		await expect(s.launch({ signal: cancelled.signal })).rejects.toThrow("cancelled");
		expect(s.client.exec).not.toHaveBeenCalled();
		const controller = new AbortController();
		const launched = s.launch({ signal: controller.signal });
		const rejected = expect(launched).rejects.toThrow("cancelled");
		await tick();
		controller.abort();
		await rejected;
		s.open();
		expect(s.channel.close).toHaveBeenCalledOnce();
		expect(s.channel.write).not.toHaveBeenCalled();
		expect(s.conn.activeOperations).toBe(0);
		expect(s.client.end).not.toHaveBeenCalled();
	});
	it("cancels after readiness without leaking environment through errors", async () => {
		const s = setup();
		const controller = new AbortController();
		const launched = s.launch({ signal: controller.signal });
		const rejected = expect(launched).rejects.toThrow("cancelled");
		await tick();
		s.open();
		s.output(s.marker("READY"));
		controller.abort(new Error("sensitive cancellation message"));
		await rejected;
		expect(s.channel.close).toHaveBeenCalledOnce();
		expect(s.conn.activeOperations).toBe(0);
	});
	it("times out a stalled handshake and ignores a late ready marker", async () => {
		vi.useFakeTimers();
		const s = setup();
		const launched = s.launch();
		const rejected = expect(launched).rejects.toThrow("timed out");
		await Promise.resolve();
		s.open();
		await vi.advanceTimersByTimeAsync(25_000);
		await rejected;
		s.output(s.marker("READY"));
		expect(s.channel.write).not.toHaveBeenCalled();
		expect(s.channel.close).toHaveBeenCalledOnce();
	});
	it("releases on connection loss while opening and on channel errors", async () => {
		const s = setup();
		const launched = s.launch();
		const rejected = expect(launched).rejects.toThrow("connection lost");
		await tick();
		s.client.emit("end");
		await rejected;
		expect(s.conn.activeOperations).toBe(0);
		s.open();
		expect(s.channel.close).toHaveBeenCalledOnce();
		const other = setup();
		const second = other.launch();
		const secondRejected = expect(second).rejects.toThrow("channel failed");
		await tick();
		other.open();
		other.channel.emit("error", new Error("do not expose remote errors"));
		await secondRejected;
		expect(other.conn.activeOperations).toBe(0);
	});
	it("bounds environment/handshake data and validates assignment names before connecting", async () => {
		const s = setup();
		await expect(s.launch({ command: { env: { SECRET: "x".repeat(65536) } } })).rejects.toThrow("64 KiB");
		for (const env of [{ "BAD;id": "x" }, { PI_WEB_BOOTSTRAP_PAYLOAD: "x" }, { SECRET: "x\0" }, { SECRET: "x\r" }])
			await expect(s.launch({ command: { env } })).rejects.toThrow("Invalid remote environment");
		await expect(s.launch({ command: { unsetEnv: ["X;id"] } })).rejects.toThrow("environment name");
		expect(s.client.exec).not.toHaveBeenCalled();
		const launched = s.launch();
		const rejected = expect(launched).rejects.toThrow("Invalid remote CLI startup handshake");
		await tick();
		s.open();
		s.output("x".repeat(128 * 1024 + 1));
		await rejected;
		expect(s.channel.close).toHaveBeenCalledOnce();
	});
});

describe("pooled SSH operation leases", () => {
	it("keeps a command PTY past 30 minutes and idles only after channel close", async () => {
		vi.useFakeTimers();
		const s = setup();
		const launched = s.launch();
		await Promise.resolve();
		s.open();
		s.output(s.marker("READY"));
		s.output(s.marker("STARTED"));
		await vi.advanceTimersByTimeAsync(0);
		const pty = await launched;
		await vi.advanceTimersByTimeAsync(31 * 60_000);
		expect(s.client.end).not.toHaveBeenCalled();
		pty.kill();
		await vi.advanceTimersByTimeAsync(29 * 60_000);
		expect(s.client.end).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(s.client.end).toHaveBeenCalledOnce();
	});
	it("counts overlapping workspace exec and shell channels independently", async () => {
		vi.useFakeTimers();
		const s = setup();
		let execCallback: any;
		s.client.exec.mockImplementation(((_cmd: string, cb: any) => {
			execCallback = cb;
		}) as any);
		const execution = s.service.execInWorkspace(uri, "long-running");
		await Promise.resolve();
		execCallback(null, s.channel);
		const shellChannel = Object.assign(new EventEmitter(), { write: vi.fn(), close: vi.fn() });
		const shell = s.service.openShell({ host: "example.test", username: "tester" });
		await Promise.resolve();
		s.open(null, shellChannel as any);
		await shell;
		expect(s.conn.activeOperations).toBe(2);
		await vi.advanceTimersByTimeAsync(31 * 60_000);
		expect(s.client.end).not.toHaveBeenCalled();
		s.channel.emit("close", 0);
		await execution;
		expect(s.conn.activeOperations).toBe(1);
		await vi.advanceTimersByTimeAsync(31 * 60_000);
		expect(s.client.end).not.toHaveBeenCalled();
		shellChannel.emit("close", 0);
		expect(s.conn.activeOperations).toBe(0);
		await vi.advanceTimersByTimeAsync(30 * 60_000);
		expect(s.client.end).toHaveBeenCalledOnce();
	});
	it("holds the original virtual PTY during handshake and releases on kill or failure", async () => {
		vi.useFakeTimers();
		const s = setup();
		const pty = s.service.createVirtualPty(uri, 80, 24);
		await Promise.resolve();
		expect(s.conn.activeOperations).toBe(1);
		await vi.advanceTimersByTimeAsync(31 * 60_000);
		expect(s.client.end).not.toHaveBeenCalled();
		pty.kill();
		s.open();
		expect(s.channel.close).toHaveBeenCalledOnce();
		expect(s.conn.activeOperations).toBe(0);
		const other = setup();
		other.service.createVirtualPty(uri, 80, 24);
		await Promise.resolve();
		other.open(new Error("no shell"));
		expect(other.conn.activeOperations).toBe(0);
	});
});
