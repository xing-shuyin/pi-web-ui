import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import * as integration from "../../server/device-center/hub-integration.js";
import * as hubs from "../../server/device-center/hub.js";
import * as relays from "../../server/device-center/relay.js";
import { startDeviceHub } from "../../server/device-center/main.js";
import { createLocalDeviceHub } from "../../server/device-center/local-hub.js";

vi.mock("../../server/device-center/transfers.js", () => ({
	installDeviceTransfers: async () => ({ close: async () => {} }),
}));
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	vi.useRealTimers();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
});
async function directory() {
	const dir = await mkdtemp(join(tmpdir(), "device-publication-recovery-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}
async function unusedPort() {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	expect(port).toBeGreaterThanOrEqual(8900);
	return port;
}
const driver = {
	callDevice: vi.fn(async () => {
		throw new Error("No mutation expected");
	}),
} as any;

describe("publication recovery lifecycle hooks", () => {
	it("queries on startup, relay attachment and the existing timer even when there are no task recovery candidates", async () => {
		const scan = vi.spyOn(integration, "reconcilePendingIntegrations").mockResolvedValue([]);
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const hub = await hubs.createDeviceHub({ dataDir: await directory(), publicUrl: "http://hub.test", relay: driver });
		cleanups.push(() => hub.close());
		expect(scan).toHaveBeenCalledTimes(1);
		expect(scan.mock.calls[0][2]).toEqual({ limit: 16, deviceId: undefined });
		hub.setRelay(driver);
		expect(scan).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(scan).toHaveBeenCalledTimes(3);
		expect(driver.callDevice).not.toHaveBeenCalled();
	});
	it("isolates query failure from task recovery and can try the next query", async () => {
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		const scan = vi
			.spyOn(integration, "reconcilePendingIntegrations")
			.mockRejectedValueOnce(new Error("status unavailable"))
			.mockResolvedValue([]);
		const hub = await hubs.createDeviceHub({ dataDir: await directory(), publicUrl: "http://hub.test" });
		cleanups.push(() => hub.close());
		hub.setRelay(driver);
		await vi.waitFor(() =>
			expect(warning).toHaveBeenCalledWith("[HubRecovery] Publication query failed", expect.any(Error)),
		);
		await expect(hub.reconcilePendingPublications("device")).resolves.toEqual([]);
		expect(scan).toHaveBeenLastCalledWith(hub.store, expect.any(Object), { limit: 16, deviceId: "device" });
		await expect(hub.resumeQueuedTasks("device")).resolves.toBeUndefined();
	});
	for (const kind of ["standalone", "local"] as const) {
		it(`${kind} device-ready invokes publication queries even if queued task recovery fails`, async () => {
			const actualCreate = hubs.createDeviceHub;
			const taskRecovery = vi.fn(async () => {
				throw new Error("task recovery failed");
			});
			const publicationQuery = vi.fn(async () => []);
			vi.spyOn(hubs, "createDeviceHub").mockImplementation(async (options) => {
				const hub = await actualCreate(options);
				hub.resumeQueuedTasks = taskRecovery;
				hub.reconcilePendingPublications = publicationQuery;
				return hub;
			});
			let ready: ((id: string) => void | Promise<void>) | undefined;
			vi.spyOn(relays, "createDeviceRelay").mockImplementation((options) => {
				ready = options.onDeviceConnect;
				return {
					close() {},
					isOnline: () => false,
					sendTask: () => true,
					revoke() {},
					callDevice: driver.callDevice,
				} as any;
			});
			const dir = await directory();
			const hub =
				kind === "local"
					? await createLocalDeviceHub(dir)
					: await startDeviceHub({
							PI_DEVICE_HUB_DATA_DIR: dir,
							PI_DEVICE_HUB_PUBLIC_URL: "http://hub.test",
							PI_DEVICE_HUB_PORT: String(await unusedPort()),
						});
			cleanups.push(() => hub.close());
			if (kind === "local")
				expect((hub as Awaited<ReturnType<typeof createLocalDeviceHub>>).config.accountId).toBe("local-account");
			await expect(ready!("device")).rejects.toThrow("task recovery failed");
			expect(taskRecovery).toHaveBeenCalledWith("device");
			expect(publicationQuery).toHaveBeenCalledWith("device");
		});
	}
});
