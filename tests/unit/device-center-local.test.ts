import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installLocalDeviceCenter, normalizeHubUrl } from "../../server/device-center/local.js";
import { DEFAULT_EXECUTION_SETTINGS } from "../../server/device-center/execution-settings.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function listen(server: Server) {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanup.push(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
describe("local device enrollment", () => {
	it("accepts public HTTP(S) hubs and rejects URL credentials, fragments or paths", () => {
		expect(normalizeHubUrl("https://console.example.com/")).toBe("https://console.example.com");
		expect(normalizeHubUrl("http://127.0.0.1:8790")).toBe("http://127.0.0.1:8790");
		expect(normalizeHubUrl("http://198.51.100.10:8790/")).toBe("http://198.51.100.10:8790");
		expect(normalizeHubUrl("http://example.com")).toBe("http://example.com");
		for (const value of [
			"ws://198.51.100.10:8790",
			"http://example.com/#fragment",
			"http://user:password@example.com",
			"https://user@example.com",
			"https://example.com/path",
			"https://example.com/?token=x",
			"file:///tmp/a",
		])
			expect(() => normalizeHubUrl(value)).toThrow();
	});
	it("pairs without exposing credentials and keeps execution on the local engine", async () => {
		const dir = await mkdtemp(join(tmpdir(), "device-local-"));
		cleanup.push(() => rm(dir, { recursive: true, force: true }));
		const remote = express();
		remote.use(express.json());
		remote.post("/api/pair/start", (_req, res) =>
			res.json({ code: "12345678", pollToken: "poll-secret", expiresAt: Date.now() + 60000 }),
		);
		remote.post("/api/pair/poll", (_req, res) =>
			res.json({ deviceId: "device-a", credential: "device-secret", uiCredential: "ui-secret" }),
		);
		const remoteHits: string[] = [];
		remote.use((req, res) => {
			remoteHits.push(`${req.method} ${req.path}`);
			if (req.path === "/api/agent/bots") return res.json({ accountId: "acc" });
			res.status(404).json({ error: "User route missing" });
		});
		const hub = await listen(createServer(remote));
		const app = express();
		app.use(express.json());
		const connectTargets: string[] = [];
		const local = await installLocalDeviceCenter({
			app,
			dataDir: dir,
			connect: (cfg) => {
				connectTargets.push(cfg.hubUrl);
				return { close() {}, isConnected: () => true };
			},
		});
		cleanup.push(() => local.close());
		const base = await listen(createServer(app));
		const legacy = await fetch(`${base}/devices`, { redirect: "manual" });
		expect(legacy.status).toBe(302);
		expect(legacy.headers.get("location")).toBe("./?view=devices");
		const post = (path: string, body: unknown, origin = base) =>
			fetch(`${base}/api/device-center/${path}`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Origin: origin },
				body: JSON.stringify(body),
			});
		expect((await post("pair", { hubUrl: hub, name: "Windows" }, "https://evil.example")).status).toBe(403);
		expect((await post("pair", { hubUrl: hub, name: "Windows" })).status).toBe(200);
		const paired = await (await post("poll", {})).json();
		expect(paired).toEqual({ paired: true });
		const status = await (await fetch(`${base}/api/device-center/status`)).text();
		expect(status).not.toContain("device-secret");
		expect(status).not.toContain("poll-secret");
		expect(status).not.toContain("ui-secret");
		expect(JSON.parse(await readFile(join(dir, "device-center.json"), "utf8")).uiCredential).toBe("ui-secret");
		// 配对后：连接必须带**配对得来的真实设备身份**接远端 Hub —— 设备在线表与任务投递都按它认人；
		// 只接本机引擎会让远端永远看到"设备离线"（派出去的任务直接判失败）。
		expect(connectTargets.length).toBeGreaterThan(0);
		expect(connectTargets).toContain(hub);
		// 但房间/执行仍然不落在远端：没有一条设备用户路由被请求。
		expect(remoteHits.some((hit) => hit.includes("/api/device-user/"))).toBe(false);
		expect((await post("execution", { allowExecution: true })).status).toBe(200);
		expect(JSON.parse(await readFile(join(dir, "device-center.json"), "utf8")).allowExecution).toBe(true);
		const beforeDisconnect = connectTargets.length;
		expect((await post("disconnect", {})).status).toBe(200);
		expect(JSON.parse(await readFile(join(dir, "device-center.json"), "utf8"))).toBeNull();
		// 断开配对后只剩本机引擎：连接退到 loopback，不再碰远端。
		expect(
			connectTargets
				.slice(beforeDisconnect)
				.every((target) => target !== hub && target.startsWith("http://127.0.0.1:")),
		).toBe(true);
	});

	it("manages execution settings and queue snapshot with persistence-first semantics", async () => {
		const dir = await mkdtemp(join(tmpdir(), "device-local-settings-"));
		cleanup.push(() => rm(dir, { recursive: true, force: true }));

		await writeFile(
			join(dir, "device-center.json"),
			JSON.stringify({
				hubUrl: "http://127.0.0.1:8790",
				name: "Test",
				deviceId: "dev-1",
				credential: "cred",
				uiCredential: "ui",
				allowExecution: true,
			}),
		);

		const app = express();
		app.use(express.json());

		let runtimeSettings = { ...DEFAULT_EXECUTION_SETTINGS };
		let cancelledTask: string | undefined;

		const mockRuntime = {
			getSchedulerSnapshot: () => ({
				settings: runtimeSettings,
				activeCount: 1,
				waitingCount: 1,
				blockedCount: 0,
				running: [
					{
						taskId: "run-1",
						attemptId: "att-1",
						roomId: "room-1",
						botId: "bot-1",
						startedAt: Date.now(),
					},
				],
				waiting: [
					{
						taskId: "wait-1",
						attemptId: "att-2",
						roomId: "room-2",
						botId: "bot-2",
						queuedAt: Date.now(),
						queuePosition: 1,
						blockReason: "workspace_conflict" as const,
						blockReasonDetail: "Workspace is currently in use by an active task",
						cancelable: true,
					},
				],
				blocked: [],
			}),
			updateExecutionSettings: (next: any) => {
				runtimeSettings = next;
				return runtimeSettings;
			},
			cancelScheduledTask: (id: string) => {
				cancelledTask = id;
				return true;
			},
		};

		const local = await installLocalDeviceCenter({
			app,
			dataDir: dir,
			connect: () => ({
				close() {},
				isConnected: () => true,
				runtime: mockRuntime,
			}),
		});
		cleanup.push(() => local.close());

		const base = await listen(createServer(app));
		const post = (path: string, body: unknown) =>
			fetch(`${base}/api/device-center/${path}`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Origin: base },
				body: JSON.stringify(body),
			});

		const initialRes = await fetch(`${base}/api/device-center/execution-settings`);
		expect(initialRes.status).toBe(200);
		const initialData = await initialRes.json();
		expect(initialData.settings).toEqual(DEFAULT_EXECUTION_SETTINGS);

		const updateRes = await post("execution-settings", { maxActiveTasks: 8, maxWaitingTasks: 40 });
		expect(updateRes.status).toBe(200);
		const updateData = await updateRes.json();
		expect(updateData.settings).toEqual({ ...DEFAULT_EXECUTION_SETTINGS, maxActiveTasks: 8, maxWaitingTasks: 40 });
		expect(runtimeSettings).toEqual({ ...DEFAULT_EXECUTION_SETTINGS, maxActiveTasks: 8, maxWaitingTasks: 40 });

		const savedContent = JSON.parse(await readFile(join(dir, "execution-settings.json"), "utf8"));
		expect(savedContent).toEqual({ ...DEFAULT_EXECUTION_SETTINGS, maxActiveTasks: 8, maxWaitingTasks: 40 });

		const badRes = await post("execution-settings", {
			maxActiveTasks: 8,
			maxWaitingTasks: 40,
			extra: "illegal",
		});
		expect(badRes.status).toBe(400);
		expect(runtimeSettings).toEqual({ ...DEFAULT_EXECUTION_SETTINGS, maxActiveTasks: 8, maxWaitingTasks: 40 });

		const queueRes = await fetch(`${base}/api/device-center/execution-queue`);
		expect(queueRes.status).toBe(200);
		const queueData = await queueRes.json();
		expect(queueData.activeCount).toBe(1);
		expect(queueData.waitingCount).toBe(1);
		expect(queueData.waiting[0]?.blockReason).toBe("workspace_conflict");
		expect(queueData.waiting[0]?.root).toBeUndefined();
		expect(queueData.running[0]?.root).toBeUndefined();

		const cancelRes = await post("execution-queue/cancel", { taskId: "wait-1" });
		expect(cancelRes.status).toBe(200);
		const cancelData = await cancelRes.json();
		expect(cancelData.cancelled).toBe(true);
		expect(cancelledTask).toBe("wait-1");
	});

	it("supports upgrading connected Hub service from client", async () => {
		const dir = await mkdtemp(join(tmpdir(), "device-hub-client-upg-"));
		cleanup.push(() => rm(dir, { recursive: true, force: true }));
		const app = express();
		app.use(express.json());

		const localUnpaired = await installLocalDeviceCenter({
			app,
			dataDir: dir,
			connect: () => ({ close() {} }),
		});
		cleanup.push(() => localUnpaired.close());
		const base = await listen(createServer(app));

		const unpRes = await fetch(`${base}/api/device-center/upgrade-hub`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: base },
			body: JSON.stringify({}),
		});
		expect(unpRes.status).toBe(400);
		expect(await unpRes.json()).toEqual({ error: "Device hub not paired" });
		await localUnpaired.close();

		let upgradeHeaders: Record<string, string | string[] | undefined> = {};
		const mockHub = createServer((req, res) => {
			if (req.url === "/api/device-user/system/upgrade" && req.method === "POST") {
				upgradeHeaders = req.headers;
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						ok: true,
						job: { id: "12345678-1234-1234-1234-123456789012", state: "queued", fromBootId: "old" },
					}),
				);
				return;
			}
			if (req.url === "/health") {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ service: "pi-device-hub", status: "ok" }));
				return;
			}
			res.writeHead(404).end();
		});
		const hubBase = await listen(mockHub);

		await writeFile(
			join(dir, "device-center.json"),
			JSON.stringify({
				deviceId: "dev-test-1",
				uiCredential: "human-ui-token",
				credential: "cred-secret-123",
				name: "MyClient",
				allowExecution: true,
				hubUrl: hubBase,
			}),
		);

		const app2 = express();
		app2.use(express.json());
		const localPaired = await installLocalDeviceCenter({
			app: app2,
			dataDir: dir,
			connect: () => ({ close() {}, isConnected: () => true }),
		});
		cleanup.push(() => localPaired.close());
		const base2 = await listen(createServer(app2));

		const upgRes = await fetch(`${base2}/api/device-center/upgrade-hub`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: base2 },
			body: JSON.stringify({}),
		});
		expect(upgRes.status).toBe(200);
		const upgData = await upgRes.json();
		expect(upgData.ok).toBe(true);
		expect(upgData.job.state).toBe("queued");
		expect(upgData.healthy).toBeUndefined();
		expect(upgradeHeaders["x-device-id"]).toBe("dev-test-1");
		expect(upgradeHeaders["authorization"]).toBe("Bearer human-ui-token");
	});
});
