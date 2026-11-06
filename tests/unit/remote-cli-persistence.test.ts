import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	attachPersistentRemoteNativeCli,
	openPersistentRemoteNativeCli,
	probeRemoteCliPersistence,
	probePersistentRemoteNativeCli,
	terminatePersistentRemoteNativeCli,
} from "../../server/remote-cli-persistence.js";
import { RemoteSshService } from "../../server/remote-ssh-service.js";

const uri = "ssh://fixture@example.test/work";
const key = "d0c3ace0-80c5-4f54-bfba-2893bb557394";
const otherKey = "12f8830b-10b7-4e48-9d52-715197f9d864";
const launch = {
	file: "/bin/target",
	args: ["a b", "$(touch never)", "x'y"],
	env: { API_KEY: "fixture-secret-'$(touch never)\nsecond", HEADERS: "X-A: a\nX-B: b\tend" },
};
const options = { key, cols: 100, rows: 40 };
let root: string;
const services: RemoteSshService[] = [];
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(process.platform === "win32" ? "E:/tmp" : os.tmpdir(), "remote-cli-persistence-"));
});
afterEach(async () => {
	for (const service of services.splice(0))
		for (const id of (service as any).connections.keys()) service.closeConnection(id);
	vi.restoreAllMocks();
	await fs.rm(root, { recursive: true, force: true });
});

type Session = { state: "starting" | "running"; nonce: string; owner: string; generation: string; dead?: number };
function remote() {
	return {
		sessions: new Map<string, Session>(),
		commands: [] as string[],
		payloads: [] as string[],
		available: true,
		disconnected: false,
		stopFails: false,
		invalidState: false,
		beforeAttach: null as (() => void) | null,
		beforeOpenAttach: null as (() => void) | null,
		attached: new Map<string, Set<number>>(),
		gate: undefined as Promise<void> | undefined,
	};
}
function setup(host = remote()) {
	const service = new RemoteSshService(root);
	services.push(service);
	const channels: any[] = [];
	const client = Object.assign(new EventEmitter(), {
		end: vi.fn(() => client.emit("end")),
		exec: vi.fn((command: string, _opts: unknown, callback: (error: null, channel: any) => void) => {
			host.commands.push(command);
			const id = /pi-web-cli-([0-9a-f-]{36})/.exec(command)?.[1];
			if (!id) throw new Error("Missing private socket key");
			const prefix = /__PI_WEB_ATTACH_[a-f0-9]{32}_/.exec(command)?.[0];
			if (prefix) host.beforeAttach?.();
			else host.beforeOpenAttach?.();
			const session = host.sessions.get(id);
			const channel = Object.assign(new EventEmitter(), {
				stderr: new EventEmitter(),
				write: vi.fn((payload: string) => {
					host.payloads.push(payload);
					if (session?.state === "starting") {
						session.state = "running";
						queueMicrotask(() => channel.emit("data", Buffer.from(`__PI_WEB_STARTED_${session.nonce}__first-output`)));
					}
				}),
				close: vi.fn(() => channel.emit("close", 0)),
				setWindow: vi.fn(),
				pause: vi.fn(),
				resume: vi.fn(),
			});
			channels.push(channel);
			callback(null, channel);
			if (prefix) {
				const pid = 4000 + channels.length;
				queueMicrotask(() => {
					channel.emit("data", Buffer.from(`${prefix}${pid}__`));
					if (!session || session.owner !== id || !command.includes(session.generation))
						return channel.emit("close", 1);
					let clients = host.attached.get(id);
					if (!clients) host.attached.set(id, (clients = new Set()));
					clients.add(pid);
					channel.emit("data", Buffer.from("attached-output"));
				});
				return;
			}
			if (session?.state === "starting")
				queueMicrotask(() => channel.emit("data", Buffer.from(`__PI_WEB_READY_${session.nonce}__`)));
		}),
	});
	const conn = (service as any).registerConnection(client, {
		host: "example.test",
		username: "fixture",
		auth: { type: "agent" },
	});
	vi.spyOn(service as any, "getOrConnectByUri").mockResolvedValue({ conn, parsed: { remotePath: "/work" } });
	const executor = vi.spyOn(service, "execInWorkspace").mockImplementation(async (_uri, command) => {
		host.commands.push(command);
		if (host.disconnected) throw new Error("SSH connection lost");
		const result = (stdout: string, exitCode = 0) => ({ stdout, exitCode, stderr: "" });
		if (command.includes("command -v tmux"))
			return host.available ? result("/usr/bin/tmux\ntmux 3.4\n") : result("", 127);
		const id = /pi-web-cli-([0-9a-f-]{36})/.exec(command)?.[1];
		if (!id) throw new Error("Missing private socket key");
		if (command.includes("new-session -d")) {
			await host.gate;
			if (host.sessions.has(id)) return result("existing\n");
			const nonce = /PI_WEB_READY_([a-f0-9]{48})/.exec(command)?.[1];
			if (!nonce) throw new Error("Missing pane bootstrap");
			host.sessions.set(id, { nonce, state: "starting", owner: id, generation: nonce.slice(0, 32) });
			return result("created\n");
		}
		if (command.includes("if-shell -F")) {
			if (host.stopFails) return result("", 1);
			host.sessions.delete(id);
			return result("");
		}
		const marker = /([a-f0-9]{32})\|/.exec(command)?.[1];
		if (!marker) throw new Error("Missing state marker");
		if (host.invalidState) return result("unverified", 125);
		const session = host.sessions.get(id);
		if (command.includes("list-clients")) {
			if (!session) return result("", 1);
			return result(
				[...(host.attached.get(id) ?? [])]
					.map((pid) => `${marker}|123|$0|${pid}|${session.owner}|${session.generation}`)
					.join("\n"),
			);
		}
		if (!session) return result(`${marker}|absent\n`);
		return result(
			`${marker}|${session.owner}|${session.state}|${session.dead === undefined ? 0 : 1}|${session.dead ?? ""}|123|$0|${session.generation}\n`,
		);
	});
	return { service, host, conn, client, channels, executor };
}

describe("remote CLI tmux persistence", () => {
	it("reports tmux capability without changing ordinary remote CLI launch", async () => {
		const s = setup();
		expect(await probeRemoteCliPersistence(s.service, uri)).toEqual({ available: true });
		s.host.available = false;
		expect(await probeRemoteCliPersistence(s.service, uri)).toEqual({
			available: false,
			error: expect.stringContaining("tmux 3.2"),
		});
		await expect(openPersistentRemoteNativeCli(s.service, uri, launch, options)).rejects.toThrow("tmux 3.2");
		expect(s.client.exec).not.toHaveBeenCalled();
	});

	it("validates server UUIDs before touching SSH, including shell syntax and noncanonical keys", async () => {
		const s = setup();
		for (const invalid of ["", "../escape", `${key};id`, key.toUpperCase(), "00000000-0000-0000-0000-000000000000"]) {
			await expect(openPersistentRemoteNativeCli(s.service, uri, launch, { ...options, key: invalid })).rejects.toThrow(
				"persistence key",
			);
		}
		expect(s.executor).not.toHaveBeenCalled();
	});

	it("injects complete multiline env only into a new pane, never into tmux command argv", async () => {
		const s = setup();
		const handle = await openPersistentRemoteNativeCli(s.service, uri, launch, options);
		expect(handle.created).toBe(true);
		expect(handle.sessionName).toBe(`pi-web-cli-${key}`);
		expect(s.conn.activeOperations).toBe(1);
		expect(s.host.payloads).toHaveLength(1);
		expect(s.host.payloads[0]).toContain("unset TMUX\nunset TMUX_PANE");
		expect(s.host.payloads[0]).toContain("X-A: a\nX-B: b\tend");
		const commands = s.host.commands.join("\n");
		expect(commands).not.toContain("fixture-secret");
		expect(commands).not.toContain("export API_KEY");
		expect(commands).toContain("-f /dev/null");
		expect(commands).toContain("remain-on-exit on");
		expect(commands).toContain("PI_WEB_BOOTSTRAP_WATCHDOG");
		expect(commands).toContain("@pi-web-state running");
		const received = vi.fn();
		handle.pty.onData(received);
		expect(received).toHaveBeenCalledWith("first-output");
		handle.pty.resize(120, 50);
		expect(s.channels[0].setWindow).toHaveBeenCalledWith(50, 120, 0, 0);
		handle.pty.kill();
		expect(s.conn.activeOperations).toBe(0);
		expect(s.client.end).not.toHaveBeenCalled();
		expect(await handle.probe()).toEqual({ alive: true });
	});

	it("serializes concurrent opens and reattaches without starting CLI or resending env", async () => {
		const s = setup();
		const [first, second] = await Promise.all([
			openPersistentRemoteNativeCli(s.service, uri, launch, options),
			openPersistentRemoteNativeCli(s.service, uri, { ...launch, args: ["--resume", "native-session"] }, options),
		]);
		expect([first.created, second.created]).toEqual([true, false]);
		expect(s.host.commands.filter((command) => command.includes("new-session -d"))).toHaveLength(1);
		expect(s.host.payloads).toHaveLength(1);
		expect(s.conn.activeOperations).toBe(2);
		first.pty.kill();
		expect(s.conn.activeOperations).toBe(1);
		expect(await second.probe()).toEqual({ alive: true });
		second.pty.kill();
	});

	it("uses atomic remote creation across distinct service instances", async () => {
		const first = setup();
		const second = setup(first.host);
		let release!: () => void;
		first.host.gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const opens = Promise.all([
			openPersistentRemoteNativeCli(first.service, uri, launch, options),
			openPersistentRemoteNativeCli(second.service, uri, launch, options),
		]);
		await vi.waitFor(() =>
			expect(first.host.commands.filter((command) => command.includes("new-session -d"))).toHaveLength(2),
		);
		release();
		const handles = await opens;
		expect(handles.map((handle) => handle.created).sort()).toEqual([false, true]);
		expect(first.host.payloads).toHaveLength(1);
		expect(first.host.sessions.size).toBe(1);
	});

	it("probes and deletes historical persistence without attaching or launching another CLI", async () => {
		const first = setup();
		const handle = await openPersistentRemoteNativeCli(first.service, uri, launch, options);
		handle.pty.kill();
		const next = setup(first.host);
		expect(await probePersistentRemoteNativeCli(next.service, uri, key)).toEqual({ alive: true });
		await terminatePersistentRemoteNativeCli(next.service, uri, key);
		await terminatePersistentRemoteNativeCli(next.service, uri, key);
		expect(await probePersistentRemoteNativeCli(next.service, uri, key)).toEqual({ alive: false });
		expect(next.client.exec).not.toHaveBeenCalled();
		expect(first.host.payloads).toHaveLength(1);
		expect(first.host.commands.filter((command) => command.includes("new-session -d"))).toHaveLength(1);
		first.host.disconnected = true;
		await expect(terminatePersistentRemoteNativeCli(next.service, uri, key)).rejects.toThrow("SSH connection lost");
		await expect(probePersistentRemoteNativeCli(next.service, uri, key)).rejects.toThrow("SSH connection lost");
	});

	it("reattaches after service recreation and never reports a disconnected probe as completion", async () => {
		const first = setup();
		const initial = await openPersistentRemoteNativeCli(first.service, uri, launch, options);
		first.client.emit("end");
		expect(first.conn.activeOperations).toBe(0);
		first.host.disconnected = true;
		await expect(initial.probe()).rejects.toThrow("SSH connection lost");
		first.host.disconnected = false;
		const next = setup(first.host);
		const reattached = await openPersistentRemoteNativeCli(next.service, uri, launch, options);
		expect(reattached.created).toBe(false);
		expect(next.host.payloads).toHaveLength(1);
		await reattached.terminate();
		expect(await reattached.probe()).toEqual({ alive: false });
		expect(next.client.end).not.toHaveBeenCalled();
	});

	it("keeps explicit stop retryable and isolates other keys on the shared SSH connection", async () => {
		const s = setup();
		const first = await openPersistentRemoteNativeCli(s.service, uri, launch, options);
		const second = await openPersistentRemoteNativeCli(s.service, uri, launch, { ...options, key: otherKey });
		s.host.stopFails = true;
		await expect(first.terminate()).rejects.toThrow("could not be stopped");
		expect(await first.probe()).toEqual({ alive: true });
		s.host.stopFails = false;
		await first.terminate();
		await first.terminate();
		expect(await first.probe()).toEqual({ alive: false });
		expect(await second.probe()).toEqual({ alive: true });
		expect(s.client.end).not.toHaveBeenCalled();
	});

	it("preserves a pane exit code and creates the supplied resume launch after that pane exits", async () => {
		const s = setup();
		const first = await openPersistentRemoteNativeCli(s.service, uri, launch, options);
		s.host.sessions.get(key)!.dead = 23;
		expect(await first.probe()).toEqual({ alive: false, exitCode: 23 });
		const next = await openPersistentRemoteNativeCli(
			s.service,
			uri,
			{ ...launch, args: ["--resume", "session-123"] },
			options,
		);
		expect(next.created).toBe(true);
		expect(s.host.commands.filter((command) => command.includes("new-session -d"))).toHaveLength(2);
		expect(s.host.commands.filter((command) => command.includes("new-session -d")).at(-1)).toContain("--resume");
	});

	it("refuses unverified sockets and foreign sessions before attaching or terminating", async () => {
		const s = setup();
		const handle = await openPersistentRemoteNativeCli(s.service, uri, launch, options);
		s.host.sessions.get(key)!.owner = otherKey;
		await expect(openPersistentRemoteNativeCli(s.service, uri, launch, options)).rejects.toThrow("ownership");
		await expect(handle.terminate()).rejects.toThrow("ownership");
		expect(s.host.sessions.has(key)).toBe(true);
		s.host.invalidState = true;
		await expect(handle.probe()).rejects.toThrow("could not be verified");
	});

	it("strictly attaches existing live and dead panes without an original CLI launch or model environment", async () => {
		const s = setup();
		const initial = await openPersistentRemoteNativeCli(s.service, uri, launch, options);
		initial.pty.kill();
		const create = vi.spyOn(s.service, "createCommandPty");
		const before = s.host.commands.length;
		const [first, second] = await Promise.all([
			attachPersistentRemoteNativeCli(s.service, uri, options),
			attachPersistentRemoteNativeCli(s.service, uri, options),
		]);
		expect([first.created, second.created]).toEqual([false, false]);
		expect(s.host.payloads).toHaveLength(1);
		expect(s.host.commands.slice(before).join("\n")).not.toContain("new-session");
		expect(s.host.commands.slice(before).join("\n")).not.toContain("/bin/target");
		for (const call of create.mock.calls) {
			expect(call[1].file).toBe("/usr/bin/tmux");
			expect(call[1].env).toBeUndefined();
			expect(call[1].args.join(" ")).toContain("attach-session");
		}
		const output = vi.fn();
		first.pty.onData(output);
		expect(output).toHaveBeenCalledWith("attached-output");
		expect(output.mock.calls.join()).not.toContain("__PI_WEB_ATTACH");
		first.pty.resize(120, 50);
		expect(first.pty.cols).toBe(120);
		s.host.sessions.get(key)!.dead = 17;
		const dead = await attachPersistentRemoteNativeCli(s.service, uri, options);
		expect(dead.created).toBe(false);
		expect(await dead.probe()).toEqual({ alive: false, exitCode: 17 });
		expect(s.host.payloads).toHaveLength(1);
	});

	it("rejects missing or raced strict attachment without creating a session", async () => {
		const s = setup();
		await expect(attachPersistentRemoteNativeCli(s.service, uri, options)).rejects.toThrow(/missing.*retry/);
		expect(s.client.exec).not.toHaveBeenCalled();
		await openPersistentRemoteNativeCli(s.service, uri, launch, options);
		const created = s.host.commands.filter((command) => command.includes("new-session")).length;
		s.host.beforeAttach = () => s.host.sessions.delete(key);
		await expect(attachPersistentRemoteNativeCli(s.service, uri, options)).rejects.toThrow(
			/disappeared or changed.*retry/,
		);
		expect(s.host.commands.filter((command) => command.includes("new-session"))).toHaveLength(created);
		expect(s.host.payloads).toHaveLength(1);
		expect(s.client.end).not.toHaveBeenCalled();
	});

	it("rejects generation changes between strict attach inspection and the tmux server queue", async () => {
		const s = setup();
		await openPersistentRemoteNativeCli(s.service, uri, launch, options);
		s.host.beforeAttach = () => {
			s.host.sessions.get(key)!.generation = "b".repeat(32);
		};
		await expect(attachPersistentRemoteNativeCli(s.service, uri, options)).rejects.toThrow(/changed.*retry/);
		expect(s.host.sessions.get(key)!.generation).toBe("b".repeat(32));
		expect(s.host.payloads).toHaveLength(1);
	});

	it("rejects generation changes before an open attachment returns its handle", async () => {
		const s = setup();
		await openPersistentRemoteNativeCli(s.service, uri, launch, options);
		s.host.beforeOpenAttach = () => {
			s.host.sessions.get(key)!.generation = "c".repeat(32);
		};
		await expect(openPersistentRemoteNativeCli(s.service, uri, launch, options)).rejects.toThrow(/changed.*retry/);
		expect(s.host.sessions.get(key)!.generation).toBe("c".repeat(32));
		expect(s.host.payloads).toHaveLength(1);
	});

	it("binds open and attach handles to their generation while historical stop targets the current key", async () => {
		const s = setup();
		const old = await openPersistentRemoteNativeCli(s.service, uri, launch, options);
		const oldAttachment = await attachPersistentRemoteNativeCli(s.service, uri, options);
		s.host.sessions.get(key)!.dead = 23;
		const current = await openPersistentRemoteNativeCli(s.service, uri, launch, options);
		expect(current.created).toBe(true);
		expect(await old.probe()).toEqual({ alive: false });
		expect(await oldAttachment.probe()).toEqual({ alive: false });
		await old.terminate();
		await oldAttachment.terminate();
		expect(await current.probe()).toEqual({ alive: true });
		await terminatePersistentRemoteNativeCli(s.service, uri, key);
		expect(await current.probe()).toEqual({ alive: false });
	});

	it("cancels strict attachment without starting another CLI or closing the shared connection", async () => {
		const s = setup();
		await openPersistentRemoteNativeCli(s.service, uri, launch, options);
		const controller = new AbortController();
		s.host.beforeAttach = () => controller.abort();
		await expect(
			attachPersistentRemoteNativeCli(s.service, uri, { ...options, signal: controller.signal }),
		).rejects.toThrow("cancelled");
		expect(s.host.payloads).toHaveLength(1);
		expect(s.client.end).not.toHaveBeenCalled();
	});

	it("cancels before connect or during preparation without attaching or closing other connections", async () => {
		const s = setup();
		const controller = new AbortController();
		controller.abort();
		await expect(
			openPersistentRemoteNativeCli(s.service, uri, launch, { ...options, signal: controller.signal }),
		).rejects.toThrow("cancelled");
		expect(s.executor).not.toHaveBeenCalled();
		let release!: () => void;
		s.host.gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const late = new AbortController();
		const pending = openPersistentRemoteNativeCli(s.service, uri, launch, { ...options, signal: late.signal });
		const rejected = expect(pending).rejects.toThrow("cancelled");
		await vi.waitFor(() => expect(s.host.commands.some((command) => command.includes("new-session -d"))).toBe(true));
		late.abort();
		await rejected;
		release();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(s.client.exec).not.toHaveBeenCalled();
		expect(s.conn.activeOperations).toBe(0);
		expect(s.client.end).not.toHaveBeenCalled();
	});
});
