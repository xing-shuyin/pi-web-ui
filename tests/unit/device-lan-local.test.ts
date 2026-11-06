import express from "express";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { installLocalDeviceCenter } from "../../server/device-center/local.js";
import type { DeviceLanAccessOptions } from "../../server/device-center/device-lan-access.js";

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function listen(server: Server) {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanups.push(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
it.each([true, false])(
	"negotiates LAN at the device open API while keeping peer keys out of the browser (reachable=%s)",
	async (reachable) => {
		const dir = await mkdtemp(join(tmpdir(), "device-lan-local-"));
		cleanups.push(() => rm(dir, { recursive: true, force: true }));
		const grant = {
			addresses: ["192.168.1.20"],
			port: 50001,
			identity: "peer-session",
			key: "server-only-peer-secret",
			expiresAt: Date.now() + 60000,
		};
		const hub = express();
		hub.use(express.json());
		const requests: unknown[] = [];
		let hubOrigin = "";
		hub.post("/api/device-user/devices/target/open", (req, res) => {
			expect(req.headers.authorization).toBe("Bearer paired-ui");
			expect(req.headers["x-device-id"]).toBe("source");
			requests.push(req.body);
			res.json({
				url: `${hubOrigin}/device/target/__open?ticket=fresh`,
				expiresAt: Date.now() + 30000,
				deviceLan: grant,
			});
		});
		hubOrigin = await listen(createServer(hub));
		await writeFile(
			join(dir, "device-center.json"),
			JSON.stringify({
				hubUrl: hubOrigin,
				deviceId: "source",
				name: "Source",
				credential: "paired-device",
				uiCredential: "paired-ui",
				allowExecution: false,
			}),
		);
		const app = express();
		app.use(express.json());
		let accessOptions: DeviceLanAccessOptions | undefined;
		const open = vi.fn(async (_grant: unknown, options: DeviceLanAccessOptions) => {
			accessOptions = options;
			return reachable ? { url: `/device-lan/target/__open?ticket=${"a".repeat(64)}`, transport: "lan" } : null;
		});
		const reset = vi.fn();
		const local = await installLocalDeviceCenter({
			app,
			dataDir: dir,
			connect: () => ({ close() {}, isConnected: () => true }),
			lanAccess: { open, reset, close() {} } as any,
		});
		cleanups.push(() => local.close());
		const origin = await listen(createServer(app));
		const response = await fetch(origin + "/api/device-center/devices/target/open", {
			method: "POST",
			headers: { Origin: origin, "Content-Type": "application/json" },
			body: JSON.stringify({ preferLan: true, desktop: true, basePath: "/pi/" }),
		});
		expect(response.status).toBe(200);
		const data = await response.json();
		expect(data.transport).toBe(reachable ? "lan" : "hub");
		expect(data.url).toContain(reachable ? "/device-lan/target/" : hubOrigin + "/device/target/");
		expect(JSON.stringify(data)).not.toContain(grant.key);
		expect(data.deviceLan).toBeUndefined();
		expect(open).toHaveBeenCalledWith(
			grant,
			expect.objectContaining({ deviceId: "target", origin, basePath: "/pi/", desktop: true }),
		);
		expect(requests[0]).toEqual({ preferLan: true, desktop: true, basePath: "/pi/" });
		expect(accessOptions!.valid()).toBe(true);
		expect(await accessOptions!.renew()).toEqual(grant);
		expect(await accessOptions!.fallback()).toBe(`${hubOrigin}/device/target/__open?ticket=fresh&next=%2Fdesktop`);
		const disconnected = await fetch(origin + "/api/device-center/disconnect", {
			method: "POST",
			headers: { Origin: origin, "Content-Type": "application/json" },
			body: "{}",
		});
		expect(disconnected.status).toBe(200);
		expect(accessOptions!.valid()).toBe(false);
		expect(reset).toHaveBeenCalled();
	},
);
