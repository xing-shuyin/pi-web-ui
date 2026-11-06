import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, readFile, writeFile, utimes } from "node:fs/promises";
import * as fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
// @ts-ignore plugin ESM
import { Commands, quote, integer, utf8Tail } from "../../plugins/remote-workbench/lib/runtime.mjs";
// @ts-ignore plugin ESM
import { Shells } from "../../plugins/remote-workbench/lib/shells.mjs";
// @ts-ignore plugin ESM
import { Tasks, Tunnels } from "../../plugins/remote-workbench/lib/services.mjs";
// @ts-ignore plugin ESM
import plugin from "../../plugins/remote-workbench/index.mjs";

const dirs: string[] = [];
const cleanup: Array<() => void> = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0)) fn();
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	vi.useRealTimers();
	vi.restoreAllMocks();
});
const settle = async () => {
	for (let i = 0; i < 12; i++) await new Promise<void>((r) => setImmediate(r));
};
function channel() {
	const s = new EventEmitter() as any;
	s.stderr = new EventEmitter();
	for (const method of ["pause", "resume", "close", "destroy", "signal", "setWindow"]) s[method] = vi.fn();
	s.stderr.pause = vi.fn();
	s.stderr.resume = vi.fn();
	s.write = vi.fn(() => true);
	return s;
}
async function fixture() {
	const dataDir = await mkdtemp(path.join(os.tmpdir(), "remote-runtime-"));
	dirs.push(dataDir);
	const values = new Map<string, any>();
	const routes = new Map<string, any>();
	const conn = new EventEmitter() as any;
	const svc = {
		listProfiles: vi.fn(async () => [{ name: "a", host: "example", port: 22, username: "u", remotePath: "/a'b" }]),
		getOrConnectHost: vi.fn(async () => ({ client: conn })),
		openShell: vi.fn(),
		probe: vi.fn(),
		saveProfile: vi.fn(),
		deleteProfile: vi.fn(),
		getSftp: vi.fn(),
	};
	const host = {
		dataDir,
		storage: {
			get: (key: string, fallback: any) => values.get(key) ?? fallback,
			set: vi.fn((key: string, v: any) => {
				values.set(key, structuredClone(v));
			}),
		},
		services: { get: () => svc },
		sendTo: vi.fn(),
		log: vi.fn(),
		route: (m: string, p: string, fn: any) => {
			routes.set(m + " " + p, fn);
		},
		onMessage: vi.fn(() => () => {}),
		registerAgentTool: vi.fn(),
	};
	const commands = new Commands(host, () => svc);
	await commands.ready;
	cleanup.push(() => commands.dispose());
	return { host, svc, conn, commands, values, routes };
}
async function response(routes: Map<string, any>, method: string, url: string, body: any = {}, query: any = {}) {
	const res = { json: vi.fn(), status: vi.fn() };
	res.status.mockReturnValue(res);
	await routes.get(method + " " + url)({ body, query }, res);
	return res.json.mock.calls[0][0];
}

describe("remote workbench command runtime", () => {
	it("quotes cwd and preserves the profile default", async () => {
		const f = await fixture();
		const s = channel();
		f.conn.exec = vi.fn((_cmd: any, cb: any) => {
			cb(null, s);
			queueMicrotask(() => s.emit("close", 0));
		});
		const r = await f.commands.run({ host: "a", cmd: "pwd" });
		expect(r.ok).toBe(true);
		expect(f.conn.exec.mock.calls[0][0]).toBe(`cd -- ${quote("/a'b")} && pwd`);
	});
	it("rejects destructive commands on review-mode profiles", async () => {
		const f = await fixture();
		f.svc.listProfiles.mockResolvedValue([{ name: "a", host: "x", port: 22, username: "u", reviewMode: true }] as any);
		f.conn.exec = vi.fn();
		const r = await f.commands.run({ host: "a", cmd: "rm -rf /" });
		expect(r.error).toContain("Approval Gate");
		expect(f.conn.exec).not.toHaveBeenCalled();
	});
	it("keeps unknown exit codes unsuccessful", async () => {
		const f = await fixture();
		const s = channel();
		f.conn.exec = (_c: any, cb: any) => {
			cb(null, s);
			queueMicrotask(() => s.emit("close"));
		};
		expect((await f.commands.run({ host: "a", cmd: "true" })).ok).toBe(false);
	});
	it("stores complete logs and bounds UTF8 summaries", async () => {
		const f = await fixture();
		const s = channel();
		const data = Buffer.from("中".repeat(16000));
		f.conn.exec = (_c: any, cb: any) => {
			cb(null, s);
			queueMicrotask(() => {
				s.emit("data", data);
				s.emit("close", 0);
			});
		};
		const r = await f.commands.run({ host: "a", cmd: "print" });
		expect(Buffer.byteLength(r.output)).toBeLessThanOrEqual(32768);
		expect(r.output).not.toContain("�");
		expect(r.truncated).toBe(true);
		const log = await f.commands.read(r.logId);
		expect(Buffer.from(log.b64, "base64")).toEqual(data);
	});
	it("closes channels on cancellation", async () => {
		const f = await fixture();
		const s = channel();
		f.conn.exec = (_c: any, cb: any) => cb(null, s);
		const c = new AbortController();
		const pending = f.commands.run({ host: "a", cmd: "sleep 10" }, c.signal);
		await vi.waitFor(() => expect(s.listenerCount("data")).toBe(1));
		c.abort();
		const r = await pending;
		expect(r.cancelled).toBe(true);
		expect(s.close).toHaveBeenCalled();
		expect(r.stopGuarantee).toContain("may continue");
	});
	it("closes a late channel after cancellation", async () => {
		const f = await fixture();
		let done: any;
		f.conn.exec = (_c: any, cb: any) => {
			done = cb;
		};
		const c = new AbortController();
		const pending = f.commands.run({ host: "a", cmd: "sleep" }, c.signal);
		await vi.waitFor(() => expect(done).toBeTypeOf("function"));
		c.abort();
		await pending;
		const s = channel();
		done(null, s);
		expect(s.close).toHaveBeenCalled();
	});
	it("times out and closes the channel", async () => {
		const f = await fixture();
		const s = channel();
		f.conn.exec = (_c: any, cb: any) => cb(null, s);
		const pending = f.commands.run({ host: "a", cmd: "sleep", timeout: 1 });
		await settle();
		vi.useFakeTimers();
		vi.useRealTimers();
		const r = await pending;
		expect(r.timedOut).toBe(true);
		expect(s.close).toHaveBeenCalled();
	});
	it("enforces shared disk capacity", async () => {
		const f = await fixture();
		f.commands.maxTotalBytes = 8;
		const s = channel();
		f.conn.exec = (_c: any, cb: any) => {
			cb(null, s);
			queueMicrotask(() => s.emit("data", Buffer.alloc(9)));
		};
		const r = await f.commands.run({ host: "a", cmd: "flood" });
		expect(r.error).toContain("capacity");
		expect(s.close).toHaveBeenCalled();
		expect(f.commands.totalBytes).toBe(0);
	});
	it("does not resume while another disk write remains", async () => {
		const f = await fixture();
		const s = channel();
		f.conn.exec = (_c: any, cb: any) => {
			cb(null, s);
			queueMicrotask(() => {
				s.emit("data", Buffer.from("one"));
				s.emit("data", Buffer.from("two"));
				s.emit("close", 0);
			});
		};
		const r = await f.commands.run({ host: "a", cmd: "x" });
		expect(await readFile(path.join(f.commands.dir, r.logId), "utf8")).toBe("onetwo");
		expect(s.pause).toHaveBeenCalledTimes(2);
	});
	it("discovers logs across reload and expires old files", async () => {
		const f = await fixture();
		const key = "a".repeat(48);
		await writeFile(path.join(f.commands.dir, key), "old");
		await utimes(path.join(f.commands.dir, key), new Date(0), new Date(0));
		const next = new Commands(f.host, () => f.svc);
		cleanup.push(() => next.dispose());
		await next.ready;
		await expect(readFile(path.join(next.dir, key))).rejects.toThrow();
	});
	it("rejects invalid numeric limits and repairs UTF8 tail boundaries", () => {
		expect(() => integer(-1, 0, 0, 10)).toThrow();
		expect(utf8Tail(Buffer.from("a中"), 3).toString()).toBe("中");
	});
});

describe("additional failure boundaries", () => {
	it("reports a delayed log write failure even after exit zero", async () => {
		const f = await fixture(),
			s = channel();
		const original = fsPromises.open;
		f.commands.fileFactory = async (...args: any[]) => {
			const file = await (original as any)(...args);
			if (args[1] === "wx")
				file.write = async () => {
					throw new Error("write failed");
				};
			return file;
		};
		f.conn.exec = (_c: any, cb: any) => {
			cb(null, s);
			queueMicrotask(() => {
				s.emit("data", Buffer.from("x"));
				s.emit("close", 0);
			});
		};
		const r = await f.commands.run({ host: "a", cmd: "x" });
		expect(r.ok).toBe(false);
		expect(r.error).toContain("write failed");
	});
	it("reserves command capacity across concurrent log opens", async () => {
		const f = await fixture();
		f.conn.exec = vi.fn();
		const pending = Array.from({ length: 20 }, () => f.commands.run({ host: "a", cmd: "x" }).catch((e: Error) => e));
		await vi.waitFor(() => expect(f.commands.running.size).toBe(16));
		f.commands.dispose();
		const results = await Promise.all(pending);
		expect(results.filter((r) => r instanceof Error)).toHaveLength(4);
	});
	it("reads UTF8 logs with stable byte offsets", async () => {
		const f = await fixture(),
			s = channel();
		f.conn.exec = (_c: any, cb: any) => {
			cb(null, s);
			queueMicrotask(() => {
				s.emit("data", Buffer.from("中中中"));
				s.emit("close", 0);
			});
		};
		const r = await f.commands.run({ host: "a", cmd: "x" });
		const a = await f.commands.readText(r.logId, 0, 4),
			b = await f.commands.readText(r.logId, a.nextOffset, 4);
		expect(a.text).toBe("中");
		expect(a.nextOffset).toBe(3);
		expect(b.text).toBe("中");
	});
	it("marks active log EOF false", async () => {
		const f = await fixture(),
			s = channel();
		f.conn.exec = (_c: any, cb: any) => cb(null, s);
		const pending = f.commands.run({ host: "a", cmd: "x" });
		await vi.waitFor(() => expect(s.listenerCount("data")).toBe(1));
		const key = [...f.commands.logs.keys()][0];
		expect((await f.commands.read(key)).eof).toBe(false);
		s.emit("close", 0);
		await pending;
	});
	it("returns committed task identity when later scheduling persistence fails", async () => {
		const f = await fixture();
		const run = vi.fn(() => new Promise(() => {}));
		const tasks = new Tasks(f.host, { run });
		cleanup.push(() => tasks.dispose());
		const save = f.host.storage.set.getMockImplementation()!;
		let count = 0;
		f.host.storage.set.mockImplementation((...args: any[]) => {
			if (++count === 3) throw new Error("disk");
			return (save as any)(...args);
		});
		const task = tasks.start({ hostNames: ["a", "b"], cmd: "x", concurrency: 2 });
		expect(task.id).toBeTruthy();
		expect(run).toHaveBeenCalledTimes(1);
		expect(tasks.storageError).toBe("disk");
	});
});

describe("terminal ownership and lifecycle", () => {
	async function shellFixture() {
		const f = await fixture();
		const s = channel();
		f.svc.openShell.mockResolvedValue({ stream: s, close: s.close });
		const shells = new Shells(f.host, () => f.svc, f.commands);
		cleanup.push(() => shells.dispose());
		const open = () => shells.message({ action: "shell_open", reqId: "r", hostName: "a" }, "owner");
		return { ...f, s, shells, open };
	}
	it("rejects foreign input resize close and detach", async () => {
		const f = await shellFixture();
		await f.open();
		const session = [...f.shells.sessions.values()][0] as any;
		for (const action of ["shell_input", "shell_resize", "shell_close", "shell_detach"])
			await f.shells.message({ action, shellId: session.id, reqId: action }, "foreign");
		expect(f.s.close).not.toHaveBeenCalled();
		expect(f.host.sendTo.mock.calls.filter((c: any) => c[1].error?.includes("owner")).length).toBe(4);
	});
	it("lists only sessions proven by resume tokens", async () => {
		const f = await shellFixture();
		await f.open();
		await f.shells.message({ action: "shell_list", reqId: "list", resumeTokens: [] }, "other");
		expect(f.host.sendTo.mock.lastCall?.[1].sessions).toEqual([]);
	});
	it("detaches then attaches by token and transfers ownership", async () => {
		const f = await shellFixture();
		await f.open();
		const session = [...f.shells.sessions.values()][0] as any;
		await f.shells.message({ action: "shell_detach", shellId: session.id }, "owner");
		expect(session.owner).toBe(null);
		await f.shells.message({ action: "shell_attach", resumeToken: session.token }, "next");
		expect(session.owner).toBe("next");
	});
	it("closes a late open on cancelled request", async () => {
		const f = await shellFixture();
		let resolve: any;
		f.svc.openShell.mockImplementation(
			() =>
				new Promise((r) => {
					resolve = r;
				}),
		);
		const pending = f.open();
		await settle();
		await f.shells.message({ action: "shell_cancel", openReqId: "r" }, "owner");
		resolve({ stream: f.s, close: f.s.close });
		await pending;
		expect(f.s.close).toHaveBeenCalled();
		expect(f.shells.sessions.size).toBe(0);
	});
	it("closes a late open after unload", async () => {
		const f = await shellFixture();
		let resolve: any;
		f.svc.openShell.mockImplementation(
			() =>
				new Promise((r) => {
					resolve = r;
				}),
		);
		const pending = f.open();
		await settle();
		f.shells.dispose();
		resolve({ stream: f.s, close: f.s.close });
		await pending;
		expect(f.s.close).toHaveBeenCalled();
	});
	it("limits inflight output until ACK credits return", async () => {
		const f = await shellFixture();
		await f.open();
		const session = [...f.shells.sessions.values()][0] as any;
		f.s.emit("data", Buffer.alloc(100000));
		expect(session.inflight.size).toBe(4);
		expect(f.s.pause).toHaveBeenCalled();
		await f.shells.message({ action: "shell_ack", shellId: session.id, seq: 4 }, "owner");
		expect(session.sent).toBeGreaterThan(4);
	});
	it("bounds detached replay and reports the gap", async () => {
		const f = await shellFixture();
		await f.open();
		const session = [...f.shells.sessions.values()][0] as any;
		await f.shells.message({ action: "shell_detach", shellId: session.id }, "owner");
		f.s.emit("data", Buffer.alloc(400000));
		expect(session.tailBytes).toBeLessThanOrEqual(262144);
		await f.shells.message({ action: "shell_attach", resumeToken: session.token }, "next");
		expect(f.host.sendTo.mock.calls.some((c: any) => c[1].action === "shell_gap")).toBe(true);
	});
	it("detaches heartbeat timeouts and closes expired sessions", async () => {
		const f = await shellFixture();
		await f.open();
		const session = [...f.shells.sessions.values()][0] as any;
		session.heartbeat = Date.now() - 46000;
		f.shells.tick();
		expect(session.owner).toBe(null);
		session.expiresAt = 0;
		f.shells.tick();
		expect(f.s.close).toHaveBeenCalled();
	});
	it("delivers unsent terminal tail on close", async () => {
		const f = await shellFixture();
		await f.open();
		f.s.emit("data", Buffer.alloc(100000, 97));
		f.s.emit("close", 0);
		const event = f.host.sendTo.mock.calls.find((c: any) => c[1].action === "shell_close")?.[1];
		expect(Buffer.from(event.tailB64, "base64").length).toBe(100000 - 65536);
	});
	it("retains closed detached terminal until token reattach", async () => {
		const f = await shellFixture();
		await f.open();
		const s = [...f.shells.sessions.values()][0] as any;
		await f.shells.message({ action: "shell_detach", shellId: s.id }, "owner");
		f.s.emit("data", Buffer.from("final"));
		f.s.emit("close", 0);
		expect(f.shells.sessions.size).toBe(1);
		await f.shells.message({ action: "shell_attach", resumeToken: s.token }, "next");
		expect(f.shells.sessions.size).toBe(0);
	});
	it("acknowledges accepted blocked input and resumes on drain", async () => {
		const f = await shellFixture();
		await f.open();
		const s = [...f.shells.sessions.values()][0] as any;
		f.s.write.mockReturnValue(false);
		await f.shells.message({ action: "shell_input", reqId: "i", shellId: s.id, b64: "YQ==" }, "owner");
		expect(f.host.sendTo.mock.lastCall?.[1]).toMatchObject({ accepted: true, writable: false });
		f.s.emit("drain");
		expect(f.host.sendTo.mock.lastCall?.[1].action).toBe("shell_drain");
	});
	it("releases capacity on an open timeout and closes its late result", async () => {
		const f = await shellFixture();
		let resolve: any;
		f.svc.openShell.mockImplementation(
			() =>
				new Promise((r) => {
					resolve = r;
				}),
		);
		vi.useFakeTimers();
		const pending = f.open();
		await Promise.resolve();
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(15001);
		await pending;
		expect(f.shells.opens.size).toBe(0);
		expect(f.shells.sessions.size).toBe(0);
		resolve({ stream: f.s, close: f.s.close });
		await Promise.resolve();
		await Promise.resolve();
		expect(f.s.close).toHaveBeenCalled();
		vi.useRealTimers();
	});
	it("rejects unsafe tmux names before opening", async () => {
		const f = await shellFixture();
		await f.shells.message(
			{ action: "shell_open", reqId: "x", hostName: "a", tmux: true, tmuxSession: "a;evil" },
			"owner",
		);
		expect(f.svc.openShell).not.toHaveBeenCalled();
	});
});

describe("task state and persistent failures", () => {
	it("enforces concurrency and retries only failed hosts", async () => {
		const f = await fixture();
		const pending: Array<(v: any) => void> = [];
		const run = vi.fn(() => new Promise((r) => pending.push(r)));
		const tasks = new Tasks(f.host, { run });
		cleanup.push(() => tasks.dispose());
		const t = tasks.start({ hostNames: ["a", "b"], cmd: "x", concurrency: 1 });
		expect(run).toHaveBeenCalledTimes(1);
		pending.shift()!({ ok: false, output: "failure" });
		await settle();
		expect(run).toHaveBeenCalledTimes(2);
		pending.shift()!({ ok: true, output: "ok" });
		await settle();
		tasks.retry(t.id);
		expect(run).toHaveBeenCalledTimes(3);
		expect((run.mock.calls as any)[2][0].host).toBe("a");
	});
	it("does not execute when initial persistence fails", async () => {
		const f = await fixture();
		const run = vi.fn();
		const tasks = new Tasks(f.host, { run });
		f.host.storage.set.mockImplementation(() => {
			throw new Error("disk full");
		});
		expect(() => tasks.start({ hostNames: ["a"], cmd: "x" })).toThrow();
		expect(run).not.toHaveBeenCalled();
	});
	it("keeps completed execution facts if persistence fails", async () => {
		const f = await fixture();
		let finish: any;
		const run = vi.fn(
			() =>
				new Promise((r) => {
					finish = r;
				}),
		);
		const tasks = new Tasks(f.host, { run });
		const t = tasks.start({ hostNames: ["a"], cmd: "x" });
		f.host.storage.set.mockImplementation(() => {
			throw new Error("disk full");
		});
		finish({ ok: true, output: "x".repeat(32000) });
		await settle();
		expect(tasks.list()[0].items[0].status).toBe("succeeded");
		expect(tasks.list()[0].items[0].result.output.length).toBeLessThanOrEqual(2048);
		expect(tasks.storageError).toContain("disk full");
		tasks.pump();
		expect(run).toHaveBeenCalledTimes(1);
		f.host.storage.set.mockImplementation(() => {});
		tasks.flush();
		expect(tasks.storageError).toBeUndefined();
		expect(t.id).toBeTruthy();
	});
	it("cancels queued tasks without running them", async () => {
		const f = await fixture();
		const run = vi.fn(
			(_p: any, s: any) =>
				new Promise((r) => s.addEventListener("abort", () => r({ ok: false, cancelled: true, output: "" }))),
		);
		const tasks = new Tasks(f.host, { run });
		const t = tasks.start({ hostNames: ["a", "b"], cmd: "x", concurrency: 1 });
		tasks.cancel(t.id);
		await settle();
		expect(run).toHaveBeenCalledTimes(1);
		expect(tasks.list()[0].items.every((i: any) => i.status === "cancelled")).toBe(true);
	});
	it("marks interrupted persisted tasks without replaying commands", async () => {
		const f = await fixture();
		f.values.set("tasks", [{ id: "x", status: "running", items: [{ hostName: "a", status: "running" }] }]);
		const run = vi.fn();
		const tasks = new Tasks(f.host, { run });
		expect(tasks.list()[0].status).toBe("cancelled");
		expect(run).not.toHaveBeenCalled();
	});
});

describe("tunnels and HTTP validation", () => {
	function serverFactory() {
		const servers: any[] = [];
		const create = (accept: any) => {
			const s = new EventEmitter() as any;
			s.accept = accept;
			s.listen = vi.fn(() => queueMicrotask(() => s.emit("listening")));
			s.close = vi.fn(() => queueMicrotask(() => s.emit("close")));
			servers.push(s);
			return s;
		};
		return { servers, create };
	}
	it("saves before starting and closes active sockets and channels", async () => {
		const f = await fixture();
		const sf = serverFactory();
		const tunnels = new Tunnels(f.host, () => f.svc, sf.create);
		cleanup.push(() => tunnels.dispose());
		const t = await tunnels.start({ hostName: "a", localPort: 9999, targetPort: 22 });
		const state = tunnels.active.get(t.id);
		const socket = { destroy: vi.fn() },
			stream = channel();
		state.sockets.add(socket);
		state.channels.add(stream);
		tunnels.stop(t.id);
		expect(socket.destroy).toHaveBeenCalled();
		expect(stream.close).toHaveBeenCalled();
		expect(sf.servers[0].close).toHaveBeenCalled();
		expect(tunnels.list()[0].status).toBe("stopped");
	});
	it("cancels a tunnel start while SSH connection is pending", async () => {
		const f = await fixture();
		let resolve: any;
		f.svc.getOrConnectHost.mockImplementation(
			() =>
				new Promise((r) => {
					resolve = r;
				}),
		);
		const sf = serverFactory();
		const tunnels = new Tunnels(f.host, () => f.svc, sf.create);
		const c = tunnels.save({ hostName: "a", localPort: 9999, targetPort: 22 });
		const pending = tunnels.start({ id: c.id });
		await settle();
		tunnels.stop(c.id);
		resolve({ client: f.conn });
		await expect(pending).rejects.toThrow("cancelled");
		expect(sf.servers.length).toBe(0);
	});
	it("does not publish tunnel config when storage fails", async () => {
		const f = await fixture();
		const tunnels = new Tunnels(f.host, () => f.svc);
		f.host.storage.set.mockImplementation(() => {
			throw new Error("disk");
		});
		expect(() => tunnels.save({ hostName: "a", localPort: 9999, targetPort: 22 })).toThrow();
		expect(tunnels.list()).toEqual([]);
	});
	it("rejects path traversal and invalid upload base64", async () => {
		const f = await fixture();
		const dispose = await plugin.activate(f.host);
		cleanup.push(dispose);
		for (const body of [
			{ fileName: "../a", b64: "YQ==" },
			{ fileName: "x", b64: "???" },
			{ fileName: "x", b64: "YQ=" },
		]) {
			const result = await response(f.routes, "POST", "/files/upload", { hostName: "a", ...body });
			expect(result.ok).toBe(false);
		}
		expect(f.svc.getSftp).not.toHaveBeenCalled();
	});
	it("uploads exclusively without overwriting an existing file", async () => {
		const f = await fixture();
		const stream = channel();
		stream.end = vi.fn(() => queueMicrotask(() => stream.emit("close")));
		const createWriteStream = vi.fn(() => stream);
		f.svc.getSftp.mockResolvedValue({ createWriteStream } as any);
		const dispose = await plugin.activate(f.host);
		cleanup.push(dispose);
		const r = await response(f.routes, "POST", "/files/upload", {
			hostName: "a",
			targetDir: "/tmp",
			fileName: "a",
			b64: "YQ==",
		});
		expect(r.ok).toBe(true);
		expect(createWriteStream).toHaveBeenCalledWith("/tmp/a", { flags: "wx" });
	});
	it("closes preview handles before returning read failures", async () => {
		const f = await fixture();
		const close = vi.fn((_h: any, cb: any) => cb());
		f.svc.getSftp.mockResolvedValue({
			open: (_p: any, _m: any, cb: any) => cb(null, "handle"),
			read: () => {
				throw new Error("read failed");
			},
			close,
		} as any);
		const dispose = await plugin.activate(f.host);
		cleanup.push(dispose);
		const r = await response(f.routes, "POST", "/files/read", { hostName: "a", path: "/tmp/a" });
		expect(r.ok).toBe(false);
		expect(close).toHaveBeenCalledTimes(1);
	});
	it("rejects malformed persisted tasks without overwriting storage", async () => {
		const f = await fixture();
		f.values.set("tasks", { bad: true });
		expect(() => new Tasks(f.host, f.commands)).toThrow("Invalid persisted tasks");
		expect(f.host.storage.set).not.toHaveBeenCalled();
	});
	it("returns storage errors and leaves host metadata unchanged", async () => {
		const f = await fixture();
		const dispose = await plugin.activate(f.host);
		cleanup.push(dispose);
		f.host.storage.set.mockImplementation(() => {
			throw new Error("disk full");
		});
		const r = await response(f.routes, "POST", "/hosts/metadata", { name: "a", group: "prod" });
		expect(r.ok).toBe(false);
		expect(f.values.has("hostMetadata")).toBe(false);
	});
});
