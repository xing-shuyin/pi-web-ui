import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
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
	return { root, plan, settings, path, job, health, probe, install, run };
}
describe("Hub release updater", () => {
	it("uses the saved service configuration when an independent worker has a different HOME/APPDATA", async () => {
		const f = fixture();
		runtime.writeUpgradeJob(f.path, { ...f.job, serviceConfigPath: f.plan.config });
		const wait = vi.fn().mockResolvedValue({ ...f.health, version: "2.0.0", bootId: "new" });
		await runtime.runUpgradeJob(f.path, { install: f.install, probe: f.probe, run: f.run, wait, log: () => {} });
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
			id: "test",
		});
		expect(plan.file).toBe({ linux: "systemd-run", darwin: "launchctl", win32: "powershell.exe" }[platform]);
		expect(plan.args.join(" ")).toContain("--run");
		expect(plan.args.join(" ")).toContain("path with spaces");
		if (platform === "darwin") {
			const logPath = join(tmpdir(), "path with spaces", "hub-upgrade-worker.log");
			expect(plan.args.slice(3, 7)).toEqual(["-o", logPath, "-e", logPath]);
		}
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
