import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer, globalAgent } from "node:http";
import { createConnection } from "node:net";
import * as releaseHelpers from "../lib/hub-upgrade-release.mjs";
import * as hubCli from "../../bin/device-hub-cli.mjs";
const {
	parseHubArgs,
	hubServicePlan,
	runHubCli,
	assertServiceAbsent,
	runManager,
	assertPortAvailable,
	probeHub,
	windowsArg,
	acquireHubLock,
	runHubCliEntry,
} = hubCli as any;

const env = { PI_DEVICE_HUB_PUBLIC_URL: "http://localhost:8790" };
describe("Hub standalone CLI", () => {
	it.skipIf(process.platform !== "win32").each([
		[2, 1],
		[4, 1],
		[3, 1],
		[3, 0],
	])("waits for Windows task state %s with %s instances to stop", async (state, instances) => {
		let script = "";
		runManager("schtasks.exe", ["/End", "/TN", "pi-device-hub-test"], (_file: string, args: string[], options: any) => {
			script = args.at(-1)!;
			expect(options.timeout).toBeLessThanOrEqual(30000);
			return { status: 0, stdout: "" };
		});
		const expectedStops = state === 3 && instances === 0 ? 0 : 1;
		const harness = `
$global:reads=0; $global:stops=0; $global:waits=0
$global:task=[pscustomobject]@{State=${state}; Count=${instances}}
$global:task | Add-Member ScriptMethod GetInstances { param($flags) [pscustomobject]@{Count=$this.Count} }
$global:task | Add-Member ScriptMethod Stop { param($flags) $global:stops++ }
$global:folder=[pscustomobject]@{}
$global:folder | Add-Member ScriptMethod GetTask { param($name) $global:reads++; if ($global:stops -gt 0 -and $global:reads -ge 4) {$global:task.State=3; $global:task.Count=0}; $global:task }
$global:service=[pscustomobject]@{}
$global:service | Add-Member ScriptMethod Connect {}
$global:service | Add-Member ScriptMethod GetFolder { param($path) $global:folder }
function New-Object { param($ComObject) $global:service }
function Start-Sleep { param($Milliseconds) $global:waits++ }
${script}
if ($global:stops -ne ${expectedStops}) { throw 'Incorrect Stop count' }
if (${expectedStops} -eq 1 -and $global:waits -lt 2) { throw 'Returned while old instances still existed' }
`;
		await new Promise<void>((done, reject) => {
			const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", harness], {
				windowsHide: true,
			});
			let output = "";
			for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => (output += chunk));
			child.once("error", reject);
			child.once("close", (code) => (code === 0 ? done() : reject(new Error(output))));
		});
	});
	it.each([false, true])("records safe service startup diagnostics (failure=%s)", async (failure) => {
		const root = mkdtempSync(join(tmpdir(), "hub-service-log-"));
		try {
			const config = join(root, "service.json");
			writeFileSync(config, JSON.stringify({ ...parseHubArgs([], env).settings, credential: "private-value" }));
			const error = Object.assign(new Error("private-value must never be logged"), { code: "EADDRINUSE" });
			const foreground = failure ? vi.fn().mockRejectedValue(error) : vi.fn().mockResolvedValue("hub");
			const operation = runHubCli(["--service-config", config], { foreground });
			if (failure) await expect(operation).rejects.toBe(error);
			else await expect(operation).resolves.toBe("hub");
			const text = readFileSync(join(root, "service-runtime.log"), "utf8");
			const records = text
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(records.map((record) => record.event)).toEqual(["starting", failure ? "failed" : "ready"]);
			if (failure) expect(records[1].code).toBe("EADDRINUSE");
			expect(text).not.toContain("private-value");
			expect(text).not.toContain("PI_DEVICE_HUB");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it.each(["bootstrap", "bootout"])("shares the macOS 30s deadline between print and %s", (action) => {
		let elapsed = 0;
		const calls: any[] = [];
		const inspect = (_file: string, args: string[], options: any) => {
			calls.push({ args, ...options });
			elapsed += 29000;
			return args[0] === "print" && action === "bootstrap"
				? { status: 1, stderr: "Could not find service" }
				: { status: 0, stdout: "ok" };
		};
		const run = () => runManager("launchctl", [action, "gui/10/test", "/unit"], inspect, () => elapsed);
		if (action === "bootout") expect(run).toThrow(/30s deadline/);
		else run();
		expect(calls.map((c) => c.timeout)).toEqual([30000, 1000]);
		expect(calls.every((c) => c.killSignal === "SIGKILL")).toBe(true);
	});
	it("waits for launchd removal before bootstrapping a replacement", () => {
		let loaded = true;
		let stopping = false;
		let elapsed = 0;
		let bootstraps = 0;
		const inspect = (_file: string, args: string[]) => {
			if (args[0] === "print")
				return loaded
					? { status: 0, stdout: stopping ? "state = exiting" : "state = running" }
					: { status: 113, stderr: "Could not find service" };
			if (args[0] === "bootout") stopping = true;
			if (args[0] === "bootstrap") {
				expect(loaded).toBe(false);
				loaded = true;
				bootstraps++;
			}
			return { status: 0, stdout: "ok" };
		};
		const pause = () => {
			expect(stopping).toBe(true);
			loaded = false;
			elapsed += 50;
		};
		runManager("launchctl", ["bootout", "gui/10/test"], inspect, () => elapsed, pause);
		runManager("launchctl", ["bootstrap", "gui/10", "/test.plist"], inspect, () => elapsed, pause);
		expect(bootstraps).toBe(1);
	});
	it("shares the Windows absence-check deadline and refuses a new command after expiry", () => {
		const plan = hubServicePlan({ platform: "win32", home: tmpdir(), env: { USERNAME: "test" } });
		let elapsed = 0;
		const timeouts: number[] = [];
		assertServiceAbsent(
			plan,
			(_file: string, _args: string[], options: any) => {
				timeouts.push(options.timeout);
				elapsed += 25000;
				return { status: 3 };
			},
			() => elapsed,
		);
		expect(timeouts).toEqual([30000, 5000]);
		elapsed = 0;
		let calls = 0;
		expect(() =>
			assertServiceAbsent(
				plan,
				() => {
					calls++;
					elapsed = 30000;
					return { status: 1 };
				},
				() => elapsed,
			),
		).toThrow("30s deadline");
		expect(calls).toBe(1);
	});
	it("processes cancellation after an absence-check phase before starting the manager", async () => {
		const root = mkdtempSync(join(tmpdir(), "hub-check-cancel-"));
		let managerCalls = 0;
		try {
			await expect(
				runHubCliEntry(["install"], {
					env,
					plan: {
						root,
						config: join(root, "config"),
						file: join(root, "unit"),
						manager: "systemctl",
						commands: { status: [[]] },
					},
					inspect: () => {
						process.emit("SIGTERM");
						return { status: 0, stdout: "not-found" };
					},
					run: () => {
						managerCalls++;
					},
					log: () => {},
				}),
			).rejects.toThrow("cancelled");
			expect(managerCalls).toBe(0);
			expect(existsSync(join(root, "config"))).toBe(false);
			expect(existsSync(join(root, "lifecycle.lock"))).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("recovers only a confirmed dead lock and preserves concurrent/unknown owners", () => {
		const root = mkdtempSync(join(tmpdir(), "hub-lock-"));
		try {
			const release = acquireHubLock(root);
			expect(() => acquireHubLock(root)).toThrow("locked by PID");
			release();
			const lock = join(root, "lifecycle.lock");
			mkdirSync(lock);
			writeFileSync(
				join(lock, "owner-dead.json"),
				JSON.stringify({ token: "dead", pid: 123456, hostname: hostname() }),
			);
			const recovered = acquireHubLock(root, { alive: () => false });
			expect(() => acquireHubLock(root)).toThrow("locked by PID");
			recovered();
			mkdirSync(lock);
			expect(() => acquireHubLock(root)).toThrow("unknown ownership");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it.each(["SIGTERM", "SIGINT"] as const)(
		"cooperatively cancels %s between manager commands and permits recovery",
		async (signalName) => {
			const root = mkdtempSync(join(tmpdir(), "hub-cancel-"));
			const config = join(root, "service.json");
			const settings = { ...parseHubArgs([], env).settings, PI_DEVICE_HUB_INSTANCE_ID: "saved" };
			writeFileSync(config, JSON.stringify(settings));
			const plan = { root, config, commands: { restart: [["first"], ["second"]] } };
			const calls: string[] = [];
			const handlers = process.listenerCount(signalName);
			try {
				await expect(
					runHubCliEntry(["restart"], {
						plan,
						log: () => {},
						run: (_file: string, args: string[]) => {
							calls.push(args[0]);
							process.emit(signalName);
						},
					}),
				).rejects.toThrow("cancelled");
				expect(calls).toEqual(["first"]);
				expect(process.listenerCount(signalName)).toBe(handlers);
				expect(existsSync(join(root, "lifecycle.lock"))).toBe(false);
				expect(JSON.parse(readFileSync(config, "utf8"))).toEqual(settings);
				const status = await runHubCli(["status", "--json"], { plan, log: () => {} });
				expect(status.registration).toEqual({ configured: false, active: null });
				const release = acquireHubLock(root);
				release();
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
	);
	it("receives real IPC cancellation queued during a synchronous native command", async () => {
		const root = mkdtempSync(join(tmpdir(), "hub-ipc-"));
		const config = join(root, "service.json");
		const settings = { ...parseHubArgs([], env).settings, PI_DEVICE_HUB_INSTANCE_ID: "ipc-saved" };
		writeFileSync(config, JSON.stringify(settings));
		const fixture = join(root, "runner.mjs");
		const queued = join(root, "cancel-queued");
		writeFileSync(
			fixture,
			`
import { runHubCliEntry } from ${JSON.stringify(new URL("../../bin/device-hub-cli.mjs", import.meta.url).href)};
import { spawnSync } from 'node:child_process';
let calls = 0;
try {
 await runHubCliEntry(['restart'], {
  plan: { root: ${JSON.stringify(root)}, config: ${JSON.stringify(config)}, commands: { restart: [['first'], ['second']] } },
  run: () => {
   calls++; process.send({type:'manager-started'});
   const native = spawnSync(process.execPath, ['-e', ${JSON.stringify(`const fs = require('node:fs'); const deadline = Date.now() + 10000; const pause = new Int32Array(new SharedArrayBuffer(4)); while (!fs.existsSync(${JSON.stringify(queued)})) { if (Date.now() > deadline) process.exit(3); Atomics.wait(pause, 0, 0, 10); }`)}]);
   if (native.status !== 0) throw new Error('IPC queue handshake timed out');
  },
  log: () => {}
 });
 process.exitCode = 2;
} catch (error) {
 process.send({type:'result', message:error.message, calls, listeners:process.listenerCount('message')});
 process.exitCode = 1;
} finally { process.disconnect(); }
`,
		);
		try {
			const child = spawn(process.execPath, [fixture], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
			const messages: any[] = [];
			const result = await new Promise<number | null>((done, reject) => {
				const timer = setTimeout(() => {
					child.kill();
					reject(new Error("IPC cancellation timed out"));
				}, 15000);
				child.on("message", (message: any) => {
					messages.push(message);
					if (message.type === "manager-started")
						child.send({ type: "cancel-hub-operation" }, (error) => {
							if (error) {
								clearTimeout(timer);
								reject(error);
								return;
							}
							writeFileSync(queued, "queued");
						});
				});
				child.on("error", (error) => {
					clearTimeout(timer);
					reject(error);
				});
				child.on("exit", (code) => {
					clearTimeout(timer);
					done(code);
				});
			});
			expect(result).toBe(1);
			expect(messages.find((m) => m.type === "result")).toMatchObject({
				calls: 1,
				listeners: 0,
				message: expect.stringContaining("cancelled"),
			});
			expect(existsSync(join(root, "lifecycle.lock"))).toBe(false);
			expect(JSON.parse(readFileSync(config, "utf8"))).toEqual(settings);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("ignores unrelated IPC messages and removes listeners on failure and success", async () => {
		const root = mkdtempSync(join(tmpdir(), "hub-ipc-ignore-"));
		const config = join(root, "service.json");
		writeFileSync(config, JSON.stringify(parseHubArgs([], env).settings));
		const listeners = process.listenerCount("message");
		try {
			await expect(
				runHubCliEntry(["stop"], {
					plan: { root, config, commands: { stop: [[]] } },
					log: () => {},
					run: () => {
						for (const message of [null, "cancel-hub-operation", { type: "other" }, [{ type: "cancel-hub-operation" }]])
							process.listeners("message").at(-1)!(message as any, undefined);
					},
				}),
			).resolves.toBeUndefined();
			expect(process.listenerCount("message")).toBe(listeners);
			await expect(
				runHubCliEntry(["stop"], {
					plan: { root, config, commands: { stop: [[]] } },
					log: () => {},
					run: () => {
						throw new Error("manager failure");
					},
				}),
			).rejects.toThrow("manager failure");
			expect(process.listenerCount("message")).toBe(listeners);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("preserves newly installed configuration on cancellation and start can recover it", async () => {
		const root = mkdtempSync(join(tmpdir(), "hub-install-cancel-"));
		const config = join(root, "service.json");
		const plan = {
			root,
			config,
			file: join(root, "unit"),
			content: "unit",
			manager: "systemctl",
			commands: { install: [["enable"], ["start"]], start: [["start"]] },
		};
		const controller = new AbortController();
		let server: ReturnType<typeof createServer> | undefined;
		try {
			await expect(
				runHubCli(["install", "--port", "18992"], {
					env,
					plan,
					signal: controller.signal,
					inspect: () => ({ status: 0, stdout: "not-found" }),
					run: () => controller.abort(new Error("install cancelled")),
					log: () => {},
				}),
			).rejects.toThrow(/cancelled|aborted/);
			const settings = JSON.parse(readFileSync(config, "utf8"));
			expect(settings.PI_DEVICE_HUB_INSTANCE_ID).toBeTruthy();
			expect(existsSync(plan.file)).toBe(true);
			expect(existsSync(join(root, "lifecycle.lock"))).toBe(false);
			server = createServer((_req, res) =>
				res.end(
					JSON.stringify({
						service: "pi-device-hub",
						status: "ok",
						instanceId: settings.PI_DEVICE_HUB_INSTANCE_ID,
						allowRegistration: false,
					}),
				),
			);
			await new Promise<void>((done) => server!.listen(18992, "127.0.0.1", done));
			await runHubCli(["start"], { plan, run: () => {}, log: () => {} });
			const status = await runHubCli(["status", "--json"], { plan, log: () => {} });
			expect(status).toMatchObject({
				installed: true,
				running: true,
				owned: true,
				registration: { configured: false, active: false },
			});
		} finally {
			if (server) await new Promise<void>((done) => server!.close(() => done()));
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("cancels health waiting without removing saved configuration", async () => {
		const root = mkdtempSync(join(tmpdir(), "hub-wait-cancel-"));
		const config = join(root, "service.json");
		writeFileSync(config, JSON.stringify({ ...parseHubArgs([], env).settings, PI_DEVICE_HUB_PORT: "18991" }));
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(new Error("wait cancelled")), 30);
		try {
			await expect(
				runHubCli(["start"], {
					signal: controller.signal,
					plan: { root, config, commands: { start: [[]] } },
					run: () => {},
					log: () => {},
				}),
			).rejects.toThrow(/cancelled|aborted/);
			expect(existsSync(config)).toBe(true);
			expect(existsSync(join(root, "lifecycle.lock"))).toBe(false);
		} finally {
			clearTimeout(timer);
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("accepts the backend install contract, with safe defaults", () => {
		const { settings } = parseHubArgs(
			[
				"install",
				"--host",
				"127.0.0.1",
				"--port",
				"8790",
				"--public-url",
				env.PI_DEVICE_HUB_PUBLIC_URL,
				"--data-dir",
				join(tmpdir(), "hub"),
				"--allow-registration",
			],
			{},
		);
		expect(settings.PI_DEVICE_HUB_ALLOW_REGISTRATION).toBe("1");
		expect(
			parseHubArgs(["install"], { ...env, PI_DEVICE_HUB_ALLOW_REGISTRATION: "1" }).settings
				.PI_DEVICE_HUB_ALLOW_REGISTRATION,
		).toBe("0");
		expect(parseHubArgs([], env).settings).toMatchObject({
			PI_DEVICE_HUB_HOST: "127.0.0.1",
			PI_DEVICE_HUB_PORT: "8790",
		});
		expect(parseHubArgs(["status", "--json"], {})).toEqual({ command: "status", json: true });
	});
	it("patches only registration on restart and retains the patch if the manager fails", async () => {
		const root = mkdtempSync(join(tmpdir(), "hub-cli-patch-"));
		const config = join(root, "service.json");
		const saved = {
			...parseHubArgs([], env).settings,
			PI_DEVICE_HUB_INSTANCE_ID: "stable",
			PI_DEVICE_HUB_ALLOW_REGISTRATION: "1",
		};
		writeFileSync(config, JSON.stringify(saved));
		try {
			await expect(
				runHubCli(["restart", "--allow-registration=false"], {
					plan: { root, config, commands: { restart: [[]] } },
					run: () => {
						throw new Error("offline");
					},
					log: () => {},
				}),
			).rejects.toThrow("offline");
			expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({ ...saved, PI_DEVICE_HUB_ALLOW_REGISTRATION: "0" });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("uses bootout/bootstrap for macOS stop/start without KeepAlive resurrection", () => {
		const plan = hubServicePlan({ platform: "darwin", home: tmpdir(), uid: 10 });
		expect(plan.commands.stop[0][0]).toBe("bootout");
		expect(plan.commands.start[0][0]).toBe("bootstrap");
		expect(plan.commands.restart.map((args: string[]) => args[0])).toEqual(["bootout", "bootstrap"]);
	});
	it("rejects invalid or misleading arguments", () => {
		for (const args of [
			["install", "--port", "0"],
			["install", "--port", "1.5"],
			["install", "--public-url", "https://u:p@host"],
			["install", "--public-url", "https://host/path"],
			["install", "--host", "a\nb"],
			["start", "--port", "8900"],
			["install", "--allow-registration=yes"],
			["nonsense"],
		])
			expect(() => parseHubArgs(args, env)).toThrow();
	});
	it("renders native services without a shell or agent runtime", () => {
		for (const platform of ["linux", "darwin", "win32"]) {
			const plan = hubServicePlan({
				platform,
				home: "/home/a b",
				env: { USERNAME: "a&b" },
				node: "/node $%x",
				entry: "/a b/hub.mjs",
				uid: 10,
			});
			expect(plan.content).toContain("--service-config");
			expect(plan.content).not.toContain("pi-web-ui.mjs");
			if (platform === "linux") expect(plan.content).toContain("$$%%");
			if (platform === "win32") expect(plan.content).toContain("a&amp;b");
		}
		expect(windowsArg('a"b\\')).toBe('"a\\"b\\\\"');
	});
	it("fails closed when native service ownership is unknown", () => {
		const plan = hubServicePlan({ platform: "linux", home: tmpdir() });
		expect(() => assertServiceAbsent(plan, () => ({ status: 0, stdout: "loaded" }))).toThrow();
		expect(() => assertServiceAbsent(plan, () => ({ status: 1, stdout: "", stderr: "unavailable" }))).toThrow();
		expect(() => assertServiceAbsent(plan, () => ({ status: 0, stdout: "not-found\n" }))).not.toThrow();
	});
	it("provides machine readable not-installed status without loading server code", async () => {
		const root = mkdtempSync(join(tmpdir(), "hub-cli-test-"));
		try {
			const logs: string[] = [];
			await runHubCli(["status", "--json"], {
				plan: { config: join(root, "missing") },
				log: (s: string) => logs.push(s),
			});
			expect(JSON.parse(logs[0])).toMatchObject({
				schemaVersion: 1,
				installed: false,
				running: false,
				owned: false,
				health: null,
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("resets a real TCP self-connection before returning an unhealthy result", async () => {
		const reservation = createServer();
		await new Promise<void>((done) => reservation.listen(0, "127.0.0.1", done));
		const port = (reservation.address() as { port: number }).port;
		await new Promise<void>((done) => reservation.close(() => done()));
		let socket: ReturnType<typeof createConnection> | undefined;
		let reset: ReturnType<typeof vi.spyOn> | undefined;
		let selfConnected = false;
		const create = vi.spyOn(globalAgent, "createConnection").mockImplementationOnce((options: any) => {
			socket = createConnection({ ...options, localPort: port });
			reset = vi.spyOn(socket, "resetAndDestroy");
			socket.once("connect", () => {
				selfConnected = socket!.localAddress === socket!.remoteAddress && socket!.localPort === socket!.remotePort;
			});
			return socket;
		});
		try {
			const settings = { ...parseHubArgs([], env).settings, PI_DEVICE_HUB_PORT: String(port) };
			expect(await probeHub(settings)).toBeNull();
			expect(selfConnected).toBe(true);
			expect(reset).toHaveBeenCalledOnce();
			expect(socket!.destroyed).toBe(true);
			await expect(assertPortAvailable(settings)).resolves.toBeUndefined();
		} finally {
			socket?.destroy();
			create.mockRestore();
		}
	});
	it("projects only safe startup bind and TCP state fields", () => {
		const summarize = (releaseHelpers as any).summarizeServiceRuntime;
		const row = {
			event: "failed",
			port: 54321,
			syscall: "listen",
			address: "127.0.0.1",
			tcp: [
				{ state: 2, pid: 123, command: "private-value", remoteAddress: "private-value" },
				{ state: 99, pid: 1 },
			],
			message: "private-value",
			stack: "private-value",
		};
		expect(summarize(row)).toEqual({
			event: "failed",
			port: 54321,
			syscall: "listen",
			address: "127.0.0.1",
			tcp: [{ state: 2, pid: 123 }],
		});
		expect(
			summarize({
				...row,
				port: -1,
				syscall: "private-value",
				address: "10.0.0.1",
				tcp: [{ state: 2, pid: "private-value" }],
			}),
		).toEqual({ event: "failed", tcp: [] });
	});
	it.skipIf(process.platform !== "win32")(
		"captures only the conflicting Windows local port at startup failure",
		async () => {
			const root = mkdtempSync(join(tmpdir(), "hub-bind-log-"));
			try {
				const config = join(root, "service.json");
				writeFileSync(config, JSON.stringify(parseHubArgs([], env).settings));
				const error = Object.assign(new Error("private-value"), {
					code: "EADDRINUSE",
					port: 54321,
					syscall: "listen",
					address: "127.0.0.1",
				});
				const inspect = vi.fn().mockReturnValue({
					status: 0,
					stdout: JSON.stringify([
						{ state: 2, pid: 123, command: "private-value" },
						{ state: 11, pid: 0 },
					]),
				});
				await expect(
					runHubCli(["--service-config", config], { foreground: vi.fn().mockRejectedValue(error), inspect }),
				).rejects.toBe(error);
				const text = readFileSync(join(root, "service-runtime.log"), "utf8");
				const failed = JSON.parse(text.trim().split("\n").at(-1)!);
				expect(failed).toMatchObject({
					port: 54321,
					syscall: "listen",
					address: "127.0.0.1",
					tcp: [
						{ state: 2, pid: 123 },
						{ state: 11, pid: 0 },
					],
				});
				expect(text).not.toContain("private-value");
				expect(inspect).toHaveBeenCalledOnce();
				const script = inspect.mock.calls[0][1].at(-1);
				expect(script).toContain("Get-NetTCPConnection -LocalPort 54321");
				expect(script).not.toMatch(/RemoteAddress|CommandLine|Environment/);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
	);
	it("rejects a port conflict and probes instance identity with the correct Host", async () => {
		const server = createServer((req, res) => {
			expect(req.headers.host).toBe("localhost:8790");
			res.end(JSON.stringify({ service: "pi-device-hub", status: "ok", instanceId: "owner" }));
		});
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		const port = (server.address() as { port: number }).port;
		const settings = { ...parseHubArgs([], env).settings, PI_DEVICE_HUB_PORT: String(port) };
		try {
			await expect(assertPortAvailable(settings)).rejects.toThrow();
			expect(await probeHub(settings)).toMatchObject({ instanceId: "owner" });
		} finally {
			await new Promise<void>((done) => server.close(() => done()));
		}
	});
	it("retains failed installation for diagnosis and refuses overwrite", async () => {
		const root = mkdtempSync(join(tmpdir(), "hub-cli-test-"));
		const plan = {
			...hubServicePlan({ platform: "linux", home: root }),
			root,
			config: join(root, "service.json"),
			file: join(root, "service.unit"),
		};
		const options = {
			plan,
			env: { ...env, PI_DEVICE_HUB_PORT: "18990" },
			inspect: () => ({ status: 0, stdout: "not-found" }),
			run: () => {
				throw new Error("manager unavailable");
			},
			log: () => {},
		};
		try {
			await expect(runHubCli(["install"], options)).rejects.toThrow("manager unavailable");
			expect(JSON.parse(readFileSync(plan.config, "utf8")).PI_DEVICE_HUB_INSTANCE_ID).toBeTruthy();
			await expect(runHubCli(["install"], options)).rejects.toThrow("already exists");
			expect(existsSync(join(root, "lifecycle.lock"))).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("delegates update to the package updater instead of merely rewriting the service", async () => {
		expect(parseHubArgs(["update"])).toEqual({ command: "update" });
		const upgrade = vi.fn().mockResolvedValue({ state: "succeeded" });
		const run = vi.fn();
		await runHubCli(["update"], { env, upgrade, run, plan: hubServicePlan({ platform: "linux" }) });
		expect(upgrade).toHaveBeenCalledWith(
			expect.objectContaining({ env, plan: expect.objectContaining({ manager: expect.any(String) }) }),
		);
		expect(run).not.toHaveBeenCalled();
	});
});
