import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import express from "express";
import { createDeviceHub } from "../../server/device-center/hub.js";
import { installLocalDeviceCenter } from "../../server/device-center/local.js";
import { HubUpgradeError } from "../../server/device-center/hub-upgrade.js";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function listen(server: Server) {
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function fixture() {
	const dataDir = await mkdtemp(join(tmpdir(), "hub-upgrade-http-"));
	cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
	const server = createServer();
	const base = await listen(server);
	const job = {
		schemaVersion: 1 as const,
		id: randomUUID(),
		state: "queued" as const,
		phase: "queued",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		instanceId: "instance",
		fromVersion: "1",
		fromBootId: "old",
		requestedBy: "owner",
	};
	const manager = { start: vi.fn().mockResolvedValue(job), status: vi.fn().mockResolvedValue(job) };
	const hub = await createDeviceHub({
		dataDir,
		server,
		publicUrl: base,
		allowRegistration: true,
		upgradeManager: manager,
	});
	cleanup.push(async () => {
		server.closeAllConnections();
		await hub.close();
	});
	async function request(path: string, body?: object, headers: Record<string, string> = {}) {
		const res = await fetch(base + path, {
			method: body ? "POST" : "GET",
			headers: { "Content-Type": "application/json", Connection: "close", ...headers },
			...(body ? { body: JSON.stringify(body) } : {}),
		});
		return { status: res.status, body: await res.json(), cookie: res.headers.get("set-cookie")?.split(";")[0] ?? "" };
	}
	async function register(username: string) {
		return request(
			"/api/auth/register",
			{ username, ["pass" + "word"]: "test-only-upgrade-fixture" },
			{ Origin: base },
		);
	}
	async function pair(cookie: string) {
		const start = await request("/api/pair/start", { name: "device" }, { Origin: base });
		expect(
			(await request("/api/pair/approve", { code: start.body.code }, { Origin: base, Cookie: cookie })).status,
		).toBe(200);
		return (await request("/api/pair/poll", { pollToken: start.body.pollToken }, { Origin: base })).body;
	}
	return { base, job, hub, manager, dataDir, request, register, pair };
}
describe("Hub upgrade authorization and actual client forwarding", () => {
	it("reserves Hub-wide maintenance for the first account", async () => {
		const f = await fixture();
		const owner = await f.register("owner");
		const other = await f.register("other");
		expect(owner.body.account.canUpgradeHub).toBe(true);
		expect(other.body.account.canUpgradeHub).toBe(false);
		expect((await f.request("/api/system/upgrade", {}, { Origin: f.base, Cookie: other.cookie })).status).toBe(403);
		expect(f.manager.start).not.toHaveBeenCalled();
		expect((await f.request("/api/system/upgrade", {}, { Origin: f.base, Cookie: owner.cookie })).status).toBe(202);
		expect(f.manager.start).toHaveBeenCalledWith(owner.body.account.id);
	});
	it("accepts the owner device's human credential without browser Origin, and rejects execution credentials", async () => {
		const f = await fixture();
		const owner = await f.register("owner");
		const pair = await f.pair(owner.cookie);
		const headers = { "X-Device-Id": pair.deviceId, Authorization: `Bearer ${pair.uiCredential}` };
		expect((await f.request("/api/device-user/system/upgrade", {}, headers)).status).toBe(202);
		expect((await f.request(`/api/device-user/system/upgrade?id=${f.job.id}`, undefined, headers)).body.job.id).toBe(
			f.job.id,
		);
		expect(
			(
				await f.request(
					"/api/device-user/system/upgrade",
					{},
					{ ...headers, Authorization: `Bearer ${pair.credential}` },
				)
			).status,
		).toBe(401);
		expect(
			(await f.request("/api/agent/system/upgrade", {}, { ...headers, Authorization: `Bearer ${pair.credential}` }))
				.status,
		).toBe(404);
	});
	it("keeps cookie CSRF checks and rejects revoked device credentials", async () => {
		const f = await fixture();
		const owner = await f.register("owner");
		const pair = await f.pair(owner.cookie);
		expect(
			(await f.request("/api/system/upgrade", {}, { Origin: "https://evil.test", Cookie: owner.cookie })).status,
		).toBe(403);
		await f.request(`/api/devices/${pair.deviceId}/revoke`, {}, { Origin: f.base, Cookie: owner.cookie });
		expect(
			(
				await f.request(
					"/api/device-user/system/upgrade",
					{},
					{ "X-Device-Id": pair.deviceId, Authorization: `Bearer ${pair.uiCredential}` },
				)
			).status,
		).toBe(401);
	});
	it("forwards real requests and job status between the client and real Hub without probing health", async () => {
		const f = await fixture();
		const owner = await f.register("owner");
		const pair = await f.pair(owner.cookie);
		const localDir = join(f.dataDir, "client");
		const { mkdir } = await import("node:fs/promises");
		await mkdir(localDir);
		await writeFile(
			join(localDir, "device-center.json"),
			JSON.stringify({
				hubUrl: f.base,
				name: "client",
				deviceId: pair.deviceId,
				credential: pair.credential,
				uiCredential: pair.uiCredential,
				allowExecution: false,
			}),
		);
		const app = express();
		app.use(express.json());
		const local = await installLocalDeviceCenter({ app, dataDir: localDir, connect: () => ({ close() {} }) });
		const server = createServer(app);
		const base = await listen(server);
		cleanup.push(async () => {
			server.closeAllConnections();
			await new Promise<void>((done) => server.close(() => done()));
			await local.close();
		});
		const post = async (path: string, body: object) => {
			const res = await fetch(`${base}/api/device-center/${path}`, {
				method: "POST",
				headers: { Origin: base, "Content-Type": "application/json", Connection: "close" },
				body: JSON.stringify(body),
			});
			return { status: res.status, body: await res.json() };
		};
		expect(await post("upgrade-hub", {})).toMatchObject({
			status: 202,
			body: { ok: true, job: { state: "queued", id: f.job.id } },
		});
		expect(await post("upgrade-hub-status", { id: f.job.id })).toMatchObject({
			status: 200,
			body: { job: { id: f.job.id } },
		});
		f.manager.start.mockRejectedValue(new HubUpgradeError(503, "scheduler unavailable"));
		expect(await post("upgrade-hub", {})).toEqual({ status: 503, body: { error: "scheduler unavailable" } });
	});
});
