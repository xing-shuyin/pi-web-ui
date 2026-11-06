import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createHubUpgradeManager } from "../../server/device-center/hub-upgrade.js";
import { waitForHubUpgrade } from "../../web/src/hub-upgrade.js";
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
	const dataDir = await mkdtemp(join(tmpdir(), "hub-upgrade-manager-"));
	roots.push(dataDir);
	const serviceConfigPath = join(dataDir, "service.json");
	await writeFile(
		serviceConfigPath,
		JSON.stringify({ PI_DEVICE_HUB_INSTANCE_ID: "instance", PI_DEVICE_HUB_DATA_DIR: dataDir }),
	);
	const launch = vi.fn().mockResolvedValue(undefined);
	const options = {
		dataDir,
		serviceConfigPath,
		instanceId: "instance",
		version: "1",
		bootId: "old",
		workerPath: fileURLToPath(new URL("../../bin/hub-upgrade.mjs", import.meta.url)),
		launch,
	};
	return { ...options, manager: createHubUpgradeManager(options) };
}
describe("durable Hub upgrade submission", () => {
	it("persists a job before starting the independent worker, and survives manager recreation", async () => {
		const f = await fixture();
		f.launch.mockImplementation(async (path) => {
			expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
				state: "queued",
				requestedBy: "owner",
				fromBootId: "old",
			});
		});
		const job = await f.manager.start("owner");
		expect(await createHubUpgradeManager(f).status(job.id)).toEqual(job);
		await expect(f.manager.start("owner")).rejects.toMatchObject({ status: 409 });
	});
	it("preserves the verified service location for workers with a different home or APPDATA", async () => {
		const f = await fixture();
		await writeFile(
			f.serviceConfigPath,
			JSON.stringify({
				PI_DEVICE_HUB_INSTANCE_ID: f.instanceId,
				PI_DEVICE_HUB_DATA_DIR: f.dataDir,
				PI_DEVICE_HUB_SERVICE_NAME: "pi-device-hub-isolated",
				PI_DEVICE_HUB_TOKEN: "not-copied-into-job",
			}),
		);
		f.launch.mockImplementation(async (path) => {
			const stored = JSON.parse(await readFile(path, "utf8"));
			expect(stored.serviceConfigPath).toBe(f.serviceConfigPath);
			expect(stored.serviceName).toBe("pi-device-hub-isolated");
			expect(JSON.stringify(stored)).not.toContain("not-copied-into-job");
		});
		const manager = createHubUpgradeManager({ ...f, serviceConfigPath: relative(process.cwd(), f.serviceConfigPath) });
		const job = await manager.start("owner");
		expect(job).not.toHaveProperty("serviceConfigPath");
		expect(await createHubUpgradeManager(f).status(job.id)).toEqual(job);
	});
	it("rejects overlapping submissions even while the configuration read is pending", async () => {
		const f = await fixture();
		const first = f.manager.start("owner");
		await expect(f.manager.start("owner")).rejects.toMatchObject({ status: 409 });
		await first;
		expect(f.launch).toHaveBeenCalledOnce();
	});
	it("serializes submissions across independent Hub managers and processes", async () => {
		const f = await fixture();
		let finish: (() => void) | undefined;
		f.launch.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		const first = f.manager.start("owner");
		await vi.waitFor(() => expect(f.launch).toHaveBeenCalledOnce());
		try {
			await expect(createHubUpgradeManager(f).start("owner")).rejects.toMatchObject({ status: 409 });
		} finally {
			finish?.();
			await first;
		}
		expect(f.launch).toHaveBeenCalledOnce();
	});

	it("persists worker launch errors and returns a failed HTTP outcome", async () => {
		const f = await fixture();
		f.launch.mockRejectedValue(new Error("scheduler permission denied"));
		await expect(f.manager.start("owner")).rejects.toMatchObject({ status: 503 });
		expect(await f.manager.status()).toMatchObject({ state: "failed", error: "scheduler permission denied" });
	});
	it("rejects foreground and mismatched service instances before launch", async () => {
		const f = await fixture();
		await expect(createHubUpgradeManager({ ...f, serviceConfigPath: undefined }).start("owner")).rejects.toMatchObject({
			status: 409,
		});
		await expect(createHubUpgradeManager({ ...f, instanceId: "other" }).start("owner")).rejects.toMatchObject({
			status: 409,
		});
		expect(f.launch).not.toHaveBeenCalled();
	});
	it("keeps an active handoff protected after twenty minutes", async () => {
		const f = await fixture();
		const job = await f.manager.start("owner");
		await writeFile(
			join(f.dataDir, "hub-upgrade.json"),
			JSON.stringify({ ...job, createdAt: Date.now() - 21 * 60_000 }),
		);
		expect(await f.manager.status(job.id)).toMatchObject({ id: job.id, state: "queued" });
		await expect(f.manager.start("owner")).rejects.toMatchObject({ status: 409 });
		expect(f.launch).toHaveBeenCalledOnce();
	});
	it("does not let an abandoned job stay running forever", async () => {
		const f = await fixture();
		const job = await f.manager.start("owner");
		await writeFile(
			join(f.dataDir, "hub-upgrade.json"),
			JSON.stringify({ ...job, createdAt: Date.now() - 31 * 60_000 }),
		);
		expect(await f.manager.status(job.id)).toMatchObject({ state: "failed" });
	});
});
describe("upgrade completion shown to users", () => {
	const initial = { id: "job", state: "queued" as const, fromBootId: "old" };
	it("continues observing a valid handoff after twenty minutes", async () => {
		let now = 1000;
		let sleeps = 0;
		const date = vi.spyOn(Date, "now").mockImplementation(() => now);
		const poll = vi
			.fn()
			.mockResolvedValueOnce(initial)
			.mockResolvedValueOnce({ ...initial, state: "succeeded", targetVersion: "2", version: "2", bootId: "new" });
		try {
			await expect(
				waitForHubUpgrade(initial, {
					poll,
					sleep: async () => {
						now += sleeps++ === 0 ? 21 * 60_000 : 1500;
					},
				}),
			).resolves.toMatchObject({ state: "succeeded", bootId: "new" });
			expect(poll).toHaveBeenCalledTimes(2);
		} finally {
			date.mockRestore();
		}
	});
	it("waits through a service restart and accepts the verified job only", async () => {
		const poll = vi
			.fn()
			.mockRejectedValueOnce(new Error("connection refused"))
			.mockResolvedValueOnce({ ...initial, state: "running" })
			.mockResolvedValueOnce({ ...initial, state: "succeeded", targetVersion: "2", version: "2", bootId: "new" });
		await expect(waitForHubUpgrade(initial, { poll, sleep: async () => {} })).resolves.toMatchObject({
			version: "2",
			bootId: "new",
		});
		expect(poll).toHaveBeenCalledTimes(3);
	});
	it("returns real installation/rollback failure to the user", async () => {
		await expect(
			waitForHubUpgrade(initial, {
				poll: async () => ({ ...initial, state: "failed", error: "rolled back" }),
				sleep: async () => {},
			}),
		).rejects.toThrow("rolled back");
	});
	it("does not poll forever after account revocation", async () => {
		await expect(
			waitForHubUpgrade(initial, {
				poll: async () => {
					throw Object.assign(new Error("forbidden"), { status: 403 });
				},
				sleep: async () => {},
			}),
		).rejects.toThrow("forbidden");
	});
	it("does not call any endpoint after the view is closed", async () => {
		const poll = vi.fn();
		await expect(waitForHubUpgrade(initial, { poll, isCurrent: () => false })).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(poll).not.toHaveBeenCalled();
	});
	it("rejects acknowledgement-only, stale process and wrong-version responses", async () => {
		await expect(waitForHubUpgrade(undefined as any, { poll: vi.fn() })).rejects.toThrow("Invalid");
		for (const result of [
			{ targetVersion: "2", version: "2", bootId: "old" },
			{ targetVersion: "2", version: "1", bootId: "new" },
		]) {
			await expect(waitForHubUpgrade({ ...initial, ...result, state: "succeeded" }, { poll: vi.fn() })).rejects.toThrow(
				"does not match",
			);
		}
	});
});
