import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import * as runtimeModule from "../../bin/hub-upgrade.mjs";
import * as cliModule from "../../bin/device-hub-cli.mjs";
const runtime = runtimeModule as any;
const cli = cliModule as any;
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(platform: NodeJS.Platform = process.platform) {
	const root = mkdtempSync(join(tmpdir(), "hub-update-runtime-"));
	roots.push(root);
	const env = { ...process.env, APPDATA: root, USERNAME: "tester", PI_DEVICE_HUB_SERVICE_NAME: "pi-device-hub-test" };
	const plan = cli.hubServicePlan({ platform, home: root, env });
	mkdirSync(plan.root, { recursive: true });
	mkdirSync(join(plan.file, ".."), { recursive: true });
	const settings = {
		PI_DEVICE_HUB_HOST: "127.0.0.1",
		PI_DEVICE_HUB_PORT: "8790",
		PI_DEVICE_HUB_PUBLIC_URL: "http://127.0.0.1:8790",
		PI_DEVICE_HUB_DATA_DIR: root,
		PI_DEVICE_HUB_INSTANCE_ID: "instance",
		PI_DEVICE_HUB_SERVICE_NAME: "pi-device-hub-test",
		PI_DEVICE_HUB_ALLOW_REGISTRATION: "0",
	};
	writeFileSync(plan.config, JSON.stringify(settings));
	writeFileSync(plan.file, "original service");
	const path = runtime.jobPathFor(root);
	const job = {
		schemaVersion: 1,
		id: randomUUID(),
		state: "queued",
		phase: "queued",
		instanceId: "instance",
		serviceName: "pi-device-hub-test",
		fromVersion: "1.0.0",
		fromBootId: "old",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		requestedBy: "owner",
	};
	runtime.writeUpgradeJob(path, job);
	const health = {
		service: "pi-device-hub",
		status: "ok",
		instanceId: "instance",
		version: "1.0.0",
		bootId: "old",
		allowRegistration: false,
	};
	const probe = vi.fn().mockResolvedValue(health);
	const install = vi.fn().mockResolvedValue({
		root: join(root, "release"),
		entry: join(root, "release/bin/pi-device-hub.mjs"),
		version: "2.0.0",
	});
	const run = vi.fn();
	const portQuery = vi.fn().mockResolvedValue([]);
	return { root, plan, settings, path, job, health, probe, install, run, portQuery };
}
describe("Windows Hub TCP handoff", () => {
	function clock() {
		let time = 0;
		return {
			now: () => time,
			sleep: vi.fn(async (ms: number) => {
				time += ms;
			}),
		};
	}
	it("orders preflight, TaskStop, kernel drain, Create/Run and unchanged health verification", async () => {
		const f = fixture("win32");
		const events: string[] = [];
		const snapshots = [[{ state: 2, pid: 42 }], [{ state: 11, pid: 0 }], [{ state: 100, pid: 0 }], []];
		f.portQuery.mockImplementation(async () => {
			const rows = snapshots.shift()!;
			events.push(`tcp:${rows.map((r) => r.state).join(",")}`);
			return rows;
		});
		f.run.mockImplementation((_file: string, args: string[]) => {
			events.push(args[0]);
		});
		const wait = vi.fn(async () => {
			events.push("health");
			return { ...f.health, version: "2.0.0", bootId: "new" };
		});
		await runtime.runUpgradeJob(f.path, { ...f, ...clock(), wait, log: () => {} });
		expect(events).toEqual(["tcp:2", "/End", "tcp:11", "tcp:100", "tcp:", "/Create", "/Run", "health"]);
		expect(wait).toHaveBeenCalledWith(f.settings, { version: "2.0.0", fromBootId: "old", probe: f.probe });
	});
	it("fails query preflight before replacing the definition or stopping the task", async () => {
		const f = fixture("win32");
		f.portQuery.mockRejectedValue(new Error("query unavailable"));
		await expect(runtime.runUpgradeJob(f.path, { ...f })).rejects.toThrow("query unavailable");
		expect(f.run).not.toHaveBeenCalled();
		expect(readFileSync(f.plan.file, "utf8")).toBe("original service");
	});
	it.each(["listener", "query", "cancel"])(
		"rolls back a %s failure with a separate port drain and no cancelled signal",
		async (failure) => {
			const f = fixture("win32");
			const controller = new AbortController();
			const events: string[] = [];
			let count = 0;
			f.portQuery.mockImplementation(async (_settings, options) => {
				events.push("query");
				count++;
				if (count === 2) {
					if (failure === "listener") return [{ state: 2, pid: 42 }];
					if (failure === "query") throw new Error("query unavailable");
					controller.abort();
					return [{ state: 11, pid: 0 }];
				}
				if (count >= 3) {
					expect(options.signal).toBeUndefined();
					expect(readFileSync(f.plan.file, "utf8")).toBe("original service");
				}
				return count === 3 ? [{ state: 11, pid: 0 }] : [];
			});
			f.run.mockImplementation((file: string, args: string[]) => {
				if (file === f.plan.manager) events.push(args[0]);
			});
			const wait = vi.fn().mockResolvedValue(f.health);
			await expect(
				runtime.runUpgradeJob(f.path, { ...f, ...clock(), signal: controller.signal, wait }),
			).rejects.toThrow("previous Hub service restored");
			expect(events).toEqual(["query", "/End", "query", "/End", "query", "query", "/Create", "/Run"]);
			expect(wait).toHaveBeenCalledExactlyOnceWith(f.settings, expect.objectContaining({ version: "1.0.0" }));
		},
	);
	it("waits again before restoring the exact legacy 0.117 service definition", async () => {
		const f = fixture("win32");
		runtime.writeUpgradeJob(f.path, { ...f.job, fromVersion: "legacy", fromBootId: "legacy" });
		f.probe.mockResolvedValue({ ...f.health, bootId: undefined, version: undefined });
		const original = Buffer.from("\uFEFFlegacy 0.117 task definition", "utf16le");
		writeFileSync(f.plan.file, original);
		const rows = [[], [], [{ state: 11, pid: 0 }], []];
		f.portQuery.mockImplementation(async () => {
			if (rows.length <= 2) expect(readFileSync(f.plan.file)).toEqual(original);
			return rows.shift();
		});
		const wait = vi.fn().mockRejectedValueOnce(new Error("new runtime unhealthy")).mockResolvedValueOnce(f.health);
		await expect(runtime.runUpgradeJob(f.path, { ...f, ...clock(), wait })).rejects.toThrow(
			"previous Hub service restored",
		);
		expect(f.portQuery).toHaveBeenCalledTimes(4);
		expect(readFileSync(f.plan.file)).toEqual(original);
		expect(wait.mock.calls[1][1]).toMatchObject({ version: "legacy", fromBootId: "legacy", legacy: true });
	});
	it("gives each update/rollback drain four minutes and never starts while resources remain", async () => {
		const f = fixture("win32");
		const time = clock();
		f.portQuery.mockResolvedValue([{ state: 11, pid: 0 }]);
		const wait = vi.fn();
		await expect(runtime.runUpgradeJob(f.path, { ...f, ...time, wait })).rejects.toThrow("rollback failed");
		expect(time.now()).toBe(480_000);
		expect(wait).not.toHaveBeenCalled();
		expect(f.run.mock.calls.filter(([file]) => file === f.plan.manager).map(([, args]) => args[0])).toEqual([
			"/End",
			"/End",
		]);
		expect(runtime.readUpgradeJob(f.path).error).toContain("did not drain within 4 minutes");
	});
	it("bounds the last native query by the remaining drain budget", async () => {
		const time = clock();
		const query = vi.fn(async (_settings, { timeout }) => {
			await time.sleep(timeout);
			return [{ state: 100, pid: 0 }];
		});
		await expect(runtime.waitForWindowsHubPort(fixture().settings, { ...time, query })).rejects.toThrow("4 minutes");
		expect(time.now()).toBe(240_000);
		expect(query.mock.calls.at(-1)![1].timeout).toBe(9000);
	});
	it("retains the thirty second version/boot/instance health deadline", async () => {
		vi.useFakeTimers();
		try {
			const f = fixture();
			await expect(
				runtime.waitForRelease(f.settings, {
					version: "2.0.0",
					fromBootId: "old",
					probe: f.probe,
					sleep: async (ms: number) => {
						vi.setSystemTime(Date.now() + ms);
					},
				}),
			).rejects.toThrow("expected version");
			expect(f.probe).toHaveBeenCalledTimes(120);
		} finally {
			vi.useRealTimers();
		}
	});
	it.each(["null", "{}", '[{"state":0,"pid":0}]', '[{"state":11}]', '[{"state":11,"pid":-1}]', "private-value"])(
		"fails closed for malformed native output %s",
		async (output) => {
			await expect(
				runtime.queryWindowsHubTcp(fixture().settings, { run: vi.fn().mockResolvedValue(output) }),
			).rejects.toThrow("Could not query Windows Hub TCP resources");
		},
	);
	it("redacts native errors and returns only state/pid including unknown states", async () => {
		const f = fixture();
		await expect(
			runtime.queryWindowsHubTcp(f.settings, { run: vi.fn().mockRejectedValue(new Error("private-value IP/env/cmd")) }),
		).rejects.toThrow(/^Could not query Windows Hub TCP resources$/);
		const run = vi.fn().mockResolvedValue('[{"state":100,"pid":0,"remoteIP":"private-value"}]');
		await expect(runtime.queryWindowsHubTcp(f.settings, { run, timeout: 123 })).resolves.toEqual([
			{ state: 100, pid: 0 },
		]);
		expect(run).toHaveBeenCalledWith("powershell.exe", expect.any(Array), { timeout: 123, signal: undefined });
	});
	it("times out a stuck native execution", async () => {
		await expect(
			runtime.execute(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeout: 50 }),
		).rejects.toThrow("timed out");
	});
	it("cancels a native execution", async () => {
		const controller = new AbortController();
		const operation = runtime.execute(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			signal: controller.signal,
		});
		const rejected = expect(operation).rejects.toThrow();
		controller.abort();
		await rejected;
	});
});

describe.skipIf(process.platform !== "win32")(
	"Windows TCP native query contract (mock CIM, no service changes)",
	() => {
		it.each([
			["127.0.0.1", [11, 2, 100]],
			["localhost", [11, 2, 100, 5]],
			["0.0.0.0", [11, 8, 2, 100]],
			["::1", [100, 5]],
			["::", [11, 8, 2, 100, 5, 9]],
		])(
			"filters %s by local interface and retains wildcard conflicts",
			async (host, states) => {
				const f = fixture();
				const addresses = ["127.0.0.1", "192.0.2.1", "0.0.0.0", "::", "::1", "2001:db8::1"];
				const rows = addresses.map((LocalAddress, i) => ({
					LocalAddress,
					State: [11, 8, 2, 100, 5, 9][i],
					OwningProcess: 0,
					RemoteAddress: "private-value",
				}));
				const run = async (file: string, args: string[], options: any) =>
					runtime.execute(
						file,
						[
							...args.slice(0, -1),
							`function Get-CimInstance { param($Namespace,$ClassName,$Filter,$ErrorAction) if ($Namespace -ne 'root/StandardCimv2' -or $ClassName -ne 'MSFT_NetTCPConnection' -or $Filter -ne 'LocalPort = 8790' -or $ErrorAction -ne 'Stop') { throw 'Invalid query' }; $mockRows='${JSON.stringify(rows)}' | ConvertFrom-Json; foreach ($row in $mockRows) { $row } }; ${args.at(-1)}`,
						],
						options,
					);
				const result = await runtime.queryWindowsHubTcp({ ...f.settings, PI_DEVICE_HUB_HOST: host }, { run });
				expect(result).toEqual((states as number[]).map((state) => ({ state, pid: 0 })));
			},
			15_000,
		);
		it("distinguishes empty CIM results from provider failure", async () => {
			const f = fixture();
			for (const fail of [false, true]) {
				const run = (file: string, args: string[], options: any) =>
					runtime.execute(
						file,
						[
							...args.slice(0, -1),
							`function Get-CimInstance { ${fail ? "throw 'private-value'" : "return @()"} }; ${args.at(-1)}`,
						],
						options,
					);
				const operation = runtime.queryWindowsHubTcp(f.settings, { run });
				if (fail) await expect(operation).rejects.toThrow(/^Could not query Windows Hub TCP resources$/);
				else await expect(operation).resolves.toEqual([]);
			}
		}, 15_000);
		it("parses hostile host text as one literal PowerShell argument", async () => {
			const host = "x'); throw 'private-value'; #\n$(Get-Process)";
			let script = "";
			await runtime.queryWindowsHubTcp(
				{ ...fixture().settings, PI_DEVICE_HUB_HOST: host },
				{
					run: async (_file: string, args: string[]) => {
						script = args.at(-1)!;
						return "[]";
					},
				},
			);
			const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;
			const result = await runtime.execute("powershell.exe", [
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				`$tokens=$null; $errors=$null; $ast=[Management.Automation.Language.Parser]::ParseInput(${quote(script)},[ref]$tokens,[ref]$errors); if ($errors.Count) { throw 'Invalid PowerShell' }; $values=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.StringConstantExpressionAst]},$true) | ForEach-Object { $_.Value }); ConvertTo-Json -InputObject $values -Compress`,
			]);
			expect(JSON.parse(result)).toContain(host);
		}, 15_000);
	},
);

describe("Hub release updater", () => {
	it("does not replace an active upgrade during the extended handoff budget", async () => {
		const f = fixture();
		runtime.writeUpgradeJob(f.path, { ...f.job, createdAt: Date.now() - 21 * 60_000 });
		f.install.mockRejectedValue(new Error("unexpected upgrade takeover"));
		await expect(runtime.updateInstalledHub({ ...f, log: () => {} })).rejects.toThrow("already in progress");
		expect(f.install).not.toHaveBeenCalled();
		expect(runtime.readUpgradeJob(f.path).id).toBe(f.job.id);
	});
	it("uses the saved service configuration when an independent worker has a different HOME/APPDATA", async () => {
		const f = fixture();
		runtime.writeUpgradeJob(f.path, { ...f.job, serviceConfigPath: f.plan.config });
		const wait = vi.fn().mockResolvedValue({ ...f.health, version: "2.0.0", bootId: "new" });
		await runtime.runUpgradeJob(f.path, {
			install: f.install,
			probe: f.probe,
			run: f.run,
			portQuery: f.portQuery,
			wait,
			log: () => {},
		});
		expect(f.install).toHaveBeenCalledWith(f.plan.root, expect.any(Object));
		expect(wait).toHaveBeenCalledWith(f.settings, expect.objectContaining({ version: "2.0.0" }));
		expect(runtime.readUpgradeJob(f.path).state).toBe("succeeded");
	});
	it("rejects a saved configuration belonging to another named service", async () => {
		const f = fixture();
		runtime.writeUpgradeJob(f.path, { ...f.job, serviceConfigPath: f.plan.config, serviceName: "pi-device-hub-other" });
		await expect(runtime.runUpgradeJob(f.path, { install: f.install })).rejects.toThrow("not a Hub service path");
		expect(f.install).not.toHaveBeenCalled();
	});
	it("retains ownership checks after locating an explicit service configuration", async () => {
		const f = fixture();
		runtime.writeUpgradeJob(f.path, { ...f.job, serviceConfigPath: f.plan.config, instanceId: "other" });
		await expect(runtime.runUpgradeJob(f.path, { install: f.install })).rejects.toThrow("does not belong");
		expect(f.install).not.toHaveBeenCalled();
	});
	it("rejects a relative service configuration path before touching the service", async () => {
		const f = fixture();
		runtime.writeUpgradeJob(f.path, { ...f.job, serviceConfigPath: "service.json" });
		await expect(runtime.runUpgradeJob(f.path, { install: f.install })).rejects.toThrow(
			"Invalid Hub service configuration path",
		);
		expect(f.install).not.toHaveBeenCalled();
	});
	it("installs a release, rewrites the service and persists the verified runtime", async () => {
		const f = fixture();
		const wait = vi.fn().mockResolvedValue({ ...f.health, version: "2.0.0", bootId: "new" });
		await runtime.runUpgradeJob(f.path, { ...f, wait, log: () => {} });
		expect(f.install).toHaveBeenCalledOnce();
		expect(f.run.mock.calls.map((call) => call[1])).toEqual(f.plan.commands.update);
		expect(wait).toHaveBeenCalledWith(f.settings, expect.objectContaining({ version: "2.0.0", fromBootId: "old" }));
		expect(runtime.readUpgradeJob(f.path)).toMatchObject({
			state: "succeeded",
			targetVersion: "2.0.0",
			version: "2.0.0",
			bootId: "new",
		});
		expect(JSON.parse(readFileSync(f.plan.config, "utf8"))).toEqual(f.settings);
	});
	it("does not touch the service when package installation fails", async () => {
		const f = fixture();
		f.install.mockRejectedValue(new Error("registry unavailable"));
		await expect(runtime.runUpgradeJob(f.path, { ...f })).rejects.toThrow("registry unavailable");
		expect(f.run).not.toHaveBeenCalled();
		expect(readFileSync(f.plan.file, "utf8")).toBe("original service");
		expect(runtime.readUpgradeJob(f.path)).toMatchObject({ state: "failed", error: "registry unavailable" });
	});
	it("restores the old service definition when the new runtime fails verification", async () => {
		const f = fixture();
		const wait = vi
			.fn()
			.mockRejectedValueOnce(new Error("new version never started"))
			.mockResolvedValueOnce({ ...f.health, bootId: "rollback" });
		await expect(runtime.runUpgradeJob(f.path, { ...f, wait })).rejects.toThrow("previous Hub service restored");
		expect(readFileSync(f.plan.file, "utf8")).toBe("original service");
		expect(f.run.mock.calls.filter((call) => call[0] === f.plan.manager).map((call) => call[1])).toEqual([
			...f.plan.commands.update,
			...f.plan.commands.update,
		]);
		expect(wait.mock.calls[1][1]).toMatchObject({ version: "1.0.0", fromBootId: "old" });
		expect(runtime.readUpgradeJob(f.path).state).toBe("failed");
	});
	it("captures only the failing Windows task fields before replacing its definition", async () => {
		const f = fixture("win32");
		const wait = vi.fn().mockRejectedValueOnce(new Error("not started")).mockResolvedValueOnce(f.health);
		f.run.mockImplementation((file: string) => {
			if (file !== "powershell.exe") return "";
			expect(readFileSync(f.plan.file, "utf8")).not.toBe("original service");
			return JSON.stringify({
				state: 3,
				instances: 0,
				lastTaskResult: 1,
				expectedNode: true,
				expectedArguments: false,
				credential: "private-value",
				environment: { TOKEN: "private-value" },
			});
		});
		await expect(runtime.runUpgradeJob(f.path, { ...f, wait })).rejects.toThrow("previous Hub service restored");
		const text = readFileSync(join(f.root, "hub-upgrade.log"), "utf8");
		expect(JSON.parse(text.trim().split("\n").at(-1)!)).toEqual({
			event: "windows-task-before-rollback",
			state: 3,
			instances: 0,
			lastTaskResult: 1,
			expectedNode: true,
			expectedArguments: false,
		});
		expect(text).not.toContain("private-value");
	});
	it("still restores the service when Windows diagnostics are unavailable", async () => {
		const f = fixture("win32");
		const wait = vi.fn().mockRejectedValueOnce(new Error("not started")).mockResolvedValueOnce(f.health);
		f.run.mockImplementation((file: string) => {
			if (file === "powershell.exe") throw new Error("private-value");
		});
		await expect(runtime.runUpgradeJob(f.path, { ...f, wait })).rejects.toThrow("previous Hub service restored");
		const text = readFileSync(join(f.root, "hub-upgrade.log"), "utf8");
		expect(text).toContain('"available":false');
		expect(text).not.toContain("private-value");
		expect(readFileSync(f.plan.file, "utf8")).toBe("original service");
	});
	it("preserves both upgrade and rollback errors", async () => {
		const f = fixture();
		const wait = vi.fn().mockRejectedValue(new Error("unhealthy"));
		await expect(runtime.runUpgradeJob(f.path, { ...f, wait })).rejects.toThrow("rollback failed");
		expect(runtime.readUpgradeJob(f.path).error).toContain("unhealthy");
	});
	it("rejects a job for another Hub before installing anything", async () => {
		const f = fixture();
		runtime.writeUpgradeJob(f.path, { ...f.job, instanceId: "other" });
		await expect(runtime.runUpgradeJob(f.path, { ...f })).rejects.toThrow("does not belong");
		expect(f.install).not.toHaveBeenCalled();
	});
	it("rejects an occupied lifecycle lock and records the failure", async () => {
		const f = fixture();
		const release = cli.acquireHubLock(f.plan.root);
		try {
			await expect(runtime.runUpgradeJob(f.path, { ...f })).rejects.toThrow("locked");
		} finally {
			release();
		}
		expect(runtime.readUpgradeJob(f.path).state).toBe("failed");
	});
	it.each([
		{ version: "2.0.0", bootId: "old" },
		{ version: "1.0.0", bootId: "new" },
		{ version: "2.0.0", bootId: "new", instanceId: "other" },
		{ version: "2.0.0", bootId: "new", allowRegistration: true },
	])("never accepts old or incorrect health as an upgrade: %j", async (patch) => {
		const f = fixture();
		f.probe.mockResolvedValue({ ...f.health, ...patch });
		await expect(
			runtime.waitForRelease(f.settings, {
				version: "2.0.0",
				fromBootId: "old",
				probe: f.probe,
				timeout: 5,
				sleep: async () => {},
			}),
		).rejects.toThrow("expected version");
	});
	it("reports safe last-health observations without exposing instance or boot identifiers", async () => {
		const f = fixture();
		f.probe.mockResolvedValue({
			...f.health,
			instanceId: "private-value",
			bootId: "private-value",
			version: "private-value",
		});
		const error = await runtime
			.waitForRelease(f.settings, {
				version: "2.0.0",
				fromBootId: "old",
				probe: f.probe,
				timeout: 5,
				sleep: async () => {},
			})
			.catch((error: Error) => error);
		expect(error.message).toContain(
			"last health: instance=other, registration=expected, version=missing/invalid, boot=changed",
		);
		expect(error.message).not.toContain("private-value");
	});
	it("accepts the exact new version and a different process", async () => {
		const f = fixture();
		f.probe.mockResolvedValue({ ...f.health, version: "2.0.0", bootId: "new" });
		await expect(
			runtime.waitForRelease(f.settings, { version: "2.0.0", fromBootId: "old", probe: f.probe }),
		).resolves.toMatchObject({ bootId: "new" });
	});
	it.each(["linux", "darwin", "win32"])("submits an independent %s service-manager worker", (platform) => {
		const jobPath = join(tmpdir(), "path with spaces", "job.json");
		const plan = runtime.independentWorkerPlan(jobPath, {
			platform,
			node: "C:/Node/node.exe",
			worker: "C:/App/worker.mjs",
			id: randomUUID(),
			uid: 501,
		});
		expect(plan.file).toBe({ linux: "systemd-run", darwin: "launchctl", win32: "powershell.exe" }[platform]);
		if (platform === "darwin") {
			expect(plan.args).toEqual(["bootstrap", "gui/501", plan.definition.path]);
			expect(plan.target).toMatch(/^gui\/501\/com\.xingshuyin\.pi-device-hub-update-/);
			expect(plan.definition.content).toContain("<string>--run</string>");
			expect(plan.definition.content).toContain("path with spaces");
			expect(plan.definition.content).toContain("<key>RunAtLoad</key><true/>");
			expect(plan.definition.content).toContain("<key>KeepAlive</key><false/>");
			expect(plan.definition.content).toContain("<key>LaunchOnlyOnce</key><true/>");
			const logPath = join(tmpdir(), "path with spaces", "hub-upgrade-worker.log");
			expect(plan.definition.content.split(`<string>${logPath}</string>`)).toHaveLength(3);
		} else {
			expect(plan.args.join(" ")).toContain("--run");
			expect(plan.args.join(" ")).toContain("path with spaces");
		}
	});
	it("escapes all macOS worker XML arguments and rejects escaping worker ids", () => {
		const plan = runtime.independentWorkerPlan(join(tmpdir(), "job &<>'\"", "job.json"), {
			platform: "darwin",
			uid: 501,
			node: "/node &<>'\"",
			worker: "/worker &<>'\"",
			id: randomUUID(),
		});
		expect(plan.definition.content).toContain("<string>/node &amp;&lt;&gt;&apos;&quot;</string>");
		expect(plan.definition.content).toContain("<string>/worker &amp;&lt;&gt;&apos;&quot;</string>");
		expect(plan.definition.content).not.toContain("job &<>");
		expect(() => runtime.independentWorkerPlan("job.json", { platform: "darwin", id: "../../escape" })).toThrow(
			"worker id",
		);
		expect(() => runtime.independentWorkerPlan("job.json", { platform: "darwin", uid: "501" })).toThrow("worker uid");
	});
	it.each([false, true])("cleans up the private macOS worker definition (launch failure=%s)", async (failure) => {
		const f = fixture("darwin");
		const launch = runtime.independentWorkerPlan(f.path, { platform: "darwin", uid: 501, id: f.job.id });
		const run = vi.fn(async (_file: string, args: string[]) => {
			if (args[0] !== "bootstrap") return;
			expect(readFileSync(launch.definition.path, "utf8")).toBe(launch.definition.content);
			if (process.platform !== "win32") expect(statSync(launch.definition.path).mode & 0o777).toBe(0o600);
			if (failure) throw new Error("bootstrap rejected");
			runtime.writeUpgradeJob(f.path, { ...f.job, state: "running" });
		});
		const operation = runtime.launchUpgradeJob(f.path, { ...f, platform: "darwin", uid: 501, run });
		if (failure) {
			await expect(operation).rejects.toThrow("bootstrap rejected");
			expect(run).toHaveBeenLastCalledWith("launchctl", ["bootout", launch.target], { timeout: 30000 });
		} else await expect(operation).resolves.toBeUndefined();
		expect(existsSync(launch.definition.path)).toBe(false);
	});
	it("does not overwrite or delete a preexisting macOS worker definition", async () => {
		const f = fixture("darwin");
		const launch = runtime.independentWorkerPlan(f.path, { platform: "darwin", uid: 501, id: f.job.id });
		writeFileSync(launch.definition.path, "owned by another submission");
		await expect(runtime.launchUpgradeJob(f.path, { ...f, platform: "darwin", uid: 501 })).rejects.toThrow();
		expect(readFileSync(launch.definition.path, "utf8")).toBe("owned by another submission");
		expect(f.run).not.toHaveBeenCalled();
	});
	it("unloads only its own one-shot macOS worker after completion", async () => {
		const f = fixture("darwin");
		const launch = runtime.independentWorkerPlan(f.path, { platform: "darwin", uid: 501, id: f.job.id });
		writeFileSync(launch.definition.path, launch.definition.content);
		await runtime.cleanupUpgradeWorker(f.path, { platform: "darwin", uid: 501, run: f.run });
		expect(f.run).toHaveBeenCalledWith("launchctl", ["bootout", launch.target], { timeout: 10000 });
		expect(existsSync(launch.definition.path)).toBe(false);
	});
	it("bootstraps an owned legacy published Hub without versioned health", async () => {
		const f = fixture();
		rmSync(f.path);
		const { version: _version, bootId: _boot, ...legacy } = f.health;
		f.probe.mockResolvedValue(legacy);
		const wait = vi.fn().mockResolvedValue({ ...f.health, version: "2.0.0", bootId: "new" });
		await runtime.updateInstalledHub({ ...f, wait, log: () => {} });
		expect(runtime.readUpgradeJob(f.path)).toMatchObject({
			fromVersion: "legacy",
			fromBootId: "legacy",
			state: "succeeded",
		});
	});

	it("retains the current and proven previous runtime while removing older managed releases", async () => {
		const f = fixture();
		const previous = join(f.plan.root, "releases", randomUUID());
		const current = join(f.plan.root, "releases", randomUUID());
		const obsolete = join(f.plan.root, "releases", randomUUID());
		for (const path of [previous, current, obsolete]) mkdirSync(path, { recursive: true });
		writeFileSync(join(f.plan.root, "active-release.json"), JSON.stringify({ current: previous }));
		writeFileSync(f.plan.file, process.platform === "win32" ? Buffer.from(previous, "utf16le") : previous);
		f.install.mockResolvedValue({ root: current, entry: join(current, "bin/pi-device-hub.mjs"), version: "2.0.0" });
		await runtime.runUpgradeJob(f.path, {
			...f,
			wait: vi.fn().mockResolvedValue({ ...f.health, version: "2.0.0", bootId: "new" }),
			log: () => {},
		});
		expect(() => readFileSync(join(f.plan.root, "active-release.json"))).not.toThrow();
		expect(JSON.parse(readFileSync(join(f.plan.root, "active-release.json"), "utf8"))).toEqual({ current, previous });
		expect(() => readFileSync(obsolete)).toThrow();
		const { existsSync } = await import("node:fs");
		expect(existsSync(obsolete)).toBe(false);
		expect(existsSync(previous)).toBe(true);
		expect(existsSync(current)).toBe(true);
	});

	it("reports worker submission failure instead of acknowledging success", async () => {
		const f = fixture();
		await expect(
			runtime.launchUpgradeJob(f.path, { ...f, run: vi.fn().mockRejectedValue(new Error("scheduler denied")) }),
		).rejects.toThrow("scheduler denied");
	});
});
