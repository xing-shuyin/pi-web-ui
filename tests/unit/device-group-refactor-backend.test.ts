import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { request as httpRequest, createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";
import { createDeviceHub } from "../../server/device-center/hub.js";
import { createDeviceRelay, RELAY_LIMITS } from "../../server/device-center/relay.js";
import { createDeviceConnector } from "../../server/device-center/connector.js";
import { createDeviceRuntime } from "../../server/device-center/runtime.js";
import { validateDeviceCollabInput } from "../../server/device-center/collab-tool.js";
import { createDeviceCollabService } from "../../server/device-center/collab-service.js";
import {
	EXECUTION_SETTINGS_LIMITS,
	type DeviceExecutionSettings,
} from "../../server/device-center/execution-settings.js";

describe("Group Refactor Backend - Structured Blackboard, Pipeline & Steering", () => {
	let dataDir: string;
	const cleanups: (() => Promise<unknown>)[] = [];

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "group-refactor-backend-"));
	});

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) {
			try {
				await cleanup();
			} catch {}
		}
		await rm(dataDir, { recursive: true, force: true }).catch(() => {});
	});

	async function fixture(settingsOverride?: Partial<DeviceExecutionSettings>) {
		const server = createServer();
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		cleanups.push(async () => {
			server.closeAllConnections();
			server.close();
		});
		const address = (server.address() as any).port;
		const publicHost = `127.0.0.1:${address}`;
		const publicUrl = `http://${publicHost}`;
		const currentSettings = {
			...EXECUTION_SETTINGS_LIMITS,
			maxActiveTasks: 8,
			maxWaitingTasks: 128,
			groupRetentionLimit: 5000,
			groupContextBytes: 131072,
			blackboardMaxBytes: 262144,
			resourceLockDefaultTtlMs: 1800000,
			...settingsOverride,
		} as DeviceExecutionSettings;

		const onTask = vi.fn().mockResolvedValue(true);
		let relaySteerHandler:
			| ((deviceId: string, taskId: string, attemptId: string, text: string) => Promise<{ steered: boolean }>)
			| undefined;

		const hub = await createDeviceHub({
			server,
			publicUrl,
			dataDir,
			allowRegistration: true,
			onTask,
			getSettings: () => currentSettings,
			relay: {
				steerTask: (deviceId, taskId, attemptId, text) => {
					if (relaySteerHandler) return relaySteerHandler(deviceId, taskId, attemptId, text);
					return Promise.resolve({ steered: true });
				},
			},
		});
		cleanups.push(() => hub.close());

		const request = async (
			path: string,
			body?: unknown,
			cookie?: string,
			headers: Record<string, string> = {},
			method?: string,
		) => {
			return new Promise<{ status: number; body: any; cookie: string }>((resolve, reject) => {
				const req = httpRequest(
					`http://127.0.0.1:${address}${path}`,
					{
						method: method ?? (body === undefined ? "GET" : "POST"),
						headers: {
							Host: publicHost,
							Origin: publicUrl,
							...(cookie ? { Cookie: cookie } : {}),
							...(body === undefined ? {} : { "Content-Type": "application/json" }),
							...headers,
						},
					},
					(incoming) => {
						let data = "";
						incoming.setEncoding("utf8");
						incoming.on("data", (chunk) => {
							data += chunk;
						});
						incoming.on("end", () => {
							const resCookie = incoming.headers["set-cookie"]?.[0]?.split(";")[0] ?? "";
							try {
								resolve({ status: incoming.statusCode!, body: data ? JSON.parse(data) : {}, cookie: resCookie });
							} catch {
								resolve({ status: incoming.statusCode!, body: data, cookie: resCookie });
							}
						});
					},
				);
				req.on("error", reject);
				if (body !== undefined) req.write(JSON.stringify(body));
				req.end();
			});
		};

		const register = async (username = "tester") => {
			const res = await request("/api/auth/register", { username, password: "password123" });
			expect(res.status).toBe(201);
			return res.cookie;
		};

		const pair = async (cookie: string, name = "Device") => {
			const start = await request("/api/pair/start", { name });
			expect((await request("/api/pair/approve", { code: start.body.code }, cookie)).status).toBe(200);
			const result = await request("/api/pair/poll", { pollToken: start.body.pollToken });
			expect(result.status).toBe(200);
			const botId = `bot-${result.body.deviceId}`;
			expect(
				(
					await request(
						"/api/agent/bots",
						{ bots: [{ id: botId, name, description: "test Bot", enabled: true, revision: 1 }] },
						"",
						{ Authorization: `Bearer ${result.body.credential}`, "X-Device-Id": result.body.deviceId },
						"PUT",
					)
				).status,
			).toBe(200);
			return { deviceId: result.body.deviceId, credential: result.body.credential, botId };
		};

		return {
			hub,
			publicUrl,
			request,
			register,
			pair,
			setRelaySteerHandler: (handler: typeof relaySteerHandler) => {
				relaySteerHandler = handler;
			},
		};
	}

	it("validates collab tool input with sectionId", () => {
		expect(() =>
			validateDeviceCollabInput({
				action: "blackboard_update",
				content: "Updated section content",
				expectedVersion: 1,
				sectionId: "arch_spec",
			}),
		).not.toThrow();

		expect(() =>
			validateDeviceCollabInput({
				action: "blackboard_update",
				content: "Updated section content",
				expectedVersion: 1,
				sectionId: "invalid\x00char",
			}),
		).toThrow();
	});

	it("supports updating structured blackboard sections and auto-maintaining content", async () => {
		const f = await fixture();
		const cookie = await f.register("blackboard_user");
		const dev = await f.pair(cookie, "Planner");

		const roomRes = await f.request("/api/rooms", { name: "Spec Room", botIds: [dev.botId] }, cookie);
		expect(roomRes.status).toBe(201);
		const roomId = roomRes.body.room.id;

		// 1. Update section "spec"
		const sec1Res = await f.request(
			`/api/rooms/${roomId}/blackboard/sections/spec`,
			{
				title: "API Specification",
				content: "export interface User { id: string; name: string; }",
				expectedVersion: 0,
			},
			cookie,
			{},
			"PUT",
		);
		expect(sec1Res.status).toBe(200);
		expect(sec1Res.body.ok).toBe(true);
		expect(sec1Res.body.blackboard.version).toBe(1);
		expect(sec1Res.body.blackboard.sections.spec).toBeDefined();
		expect(sec1Res.body.blackboard.sections.spec.title).toBe("API Specification");
		expect(sec1Res.body.blackboard.sections.spec.content).toBe("export interface User { id: string; name: string; }");
		expect(sec1Res.body.blackboard.content).toContain("## API Specification");
		expect(sec1Res.body.blackboard.content).toContain("export interface User");

		// 2. Update section "tasks"
		const sec2Res = await f.request(
			`/api/rooms/${roomId}/blackboard/sections/tasks`,
			{
				title: "Implementation Checklist",
				content: "- [x] Schema\n- [ ] Endpoint",
				expectedVersion: 1,
			},
			cookie,
			{},
			"POST",
		);
		expect(sec2Res.status).toBe(200);
		expect(sec2Res.body.blackboard.version).toBe(2);
		expect(sec2Res.body.blackboard.sections.tasks).toBeDefined();
		expect(sec2Res.body.blackboard.content).toContain("## API Specification");
		expect(sec2Res.body.blackboard.content).toContain("## Implementation Checklist");

		// 3. Version conflict detection on section update
		const conflictRes = await f.request(
			`/api/rooms/${roomId}/blackboard/sections/tasks`,
			{
				content: "Conflicting write",
				expectedVersion: 1, // outdated version, current is 2
			},
			cookie,
			{},
			"PUT",
		);
		expect(conflictRes.status).toBe(409);

		// 4. Update section without title retains original title
		const sec2Update = await f.request(
			`/api/rooms/${roomId}/blackboard/sections/tasks`,
			{
				content: "- [x] Schema\n- [x] Endpoint",
				expectedVersion: 2,
			},
			cookie,
			{},
			"PUT",
		);
		expect(sec2Update.status).toBe(200);
		expect(sec2Update.body.blackboard.version).toBe(3);
		expect(sec2Update.body.blackboard.sections.tasks.title).toBe("Implementation Checklist");
		expect(sec2Update.body.blackboard.sections.tasks.content).toBe("- [x] Schema\n- [x] Endpoint");
	});

	it("creates pipeline DAG tasks when pipeline: true or '->' is present", async () => {
		const f = await fixture();
		const cookie = await f.register("pipeline_user");
		const devA = await f.pair(cookie, "BotA");
		const devB = await f.pair(cookie, "BotB");
		const devC = await f.pair(cookie, "BotC");

		const roomRes = await f.request(
			"/api/rooms",
			{ name: "Pipeline Room", botIds: [devA.botId, devB.botId, devC.botId] },
			cookie,
		);
		expect(roomRes.status).toBe(201);
		const roomId = roomRes.body.room.id;

		// 1. Dispatch pipeline with explicit pipeline: true
		const dispatchRes = await f.request(
			`/api/rooms/${roomId}/messages`,
			{
				text: "Build and test the modules",
				targetBotIds: [devA.botId, devB.botId, devC.botId],
				pipeline: true,
			},
			cookie,
		);
		expect(dispatchRes.status).toBe(200);
		const tasks = dispatchRes.body.tasks;
		expect(tasks.length).toBe(3);

		// Task 0 is queued
		expect(tasks[0].status).toBe("queued");
		expect(tasks[0].dependsOnTaskId).toBeUndefined();

		// Task 1 is waiting on Task 0
		expect(tasks[1].status).toBe("waiting");
		expect(tasks[1].dependsOnTaskId).toBe(tasks[0].id);
		expect(tasks[1].blockReason).toBe("dependency");
		expect(tasks[1].blockReasonDetail).toContain(tasks[0].id);

		// Task 2 is waiting on Task 1
		expect(tasks[2].status).toBe("waiting");
		expect(tasks[2].dependsOnTaskId).toBe(tasks[1].id);
		expect(tasks[2].blockReason).toBe("dependency");
		expect(tasks[2].blockReasonDetail).toContain(tasks[1].id);

		// Verify pipeline notice in chat message
		expect(dispatchRes.body.message.text).toContain("流水线编排");

		// 2. Dispatch pipeline with '->' in content
		const arrowRes = await f.request(
			`/api/rooms/${roomId}/messages`,
			{
				text: "Design -> Implement",
				targetBotIds: [devA.botId, devB.botId],
			},
			cookie,
		);
		expect(arrowRes.status).toBe(200);
		const arrowTasks = arrowRes.body.tasks;
		expect(arrowTasks.length).toBe(2);
		expect(arrowTasks[0].status).toBe("queued");
		expect(arrowTasks[1].status).toBe("waiting");
		expect(arrowTasks[1].dependsOnTaskId).toBe(arrowTasks[0].id);
		expect(arrowTasks[1].blockReason).toBe("dependency");
	});

	it("dispatches steering to relay on running task and reflects steered result", async () => {
		const f = await fixture();
		const cookie = await f.register("steer_user");
		const dev = await f.pair(cookie, "Worker");

		const roomRes = await f.request("/api/rooms", { name: "Steer Room", botIds: [dev.botId] }, cookie);
		const roomId = roomRes.body.room.id;

		const dispatchRes = await f.request(
			`/api/rooms/${roomId}/messages`,
			{ text: "Run worker task", targetBotIds: [dev.botId] },
			cookie,
		);
		const task = dispatchRes.body.tasks[0];

		// Transition task to running
		const taskLease = f.hub.store.snapshot().tasks.find((entry) => entry.id === task.id)!;
		await f.hub.acceptTaskEvent(dev.deviceId, {
			botId: dev.botId,
			leaseToken: taskLease.leaseToken,
			leaseGeneration: taskLease.leaseGeneration,
			taskId: task.id,
			attemptId: task.attemptId,
			status: "running",
		});

		let deliveredTaskId = "";
		let deliveredText = "";
		f.setRelaySteerHandler(async (deviceId, taskId, attemptId, text) => {
			deliveredTaskId = taskId;
			deliveredText = text;
			return { steered: true };
		});

		// Steer the task via Hub steer API
		const steerRes = await f.request(
			`/api/rooms/${roomId}/tasks/${task.id}/steer`,
			{ text: "Dynamic correction: focus on memory efficiency" },
			cookie,
		);
		expect(steerRes.status).toBe(200);
		expect(steerRes.body.steered).toBe(true);

		expect(deliveredTaskId).toBe(task.id);
		expect(deliveredText).toBe("Dynamic correction: focus on memory efficiency");
	});

	it("handles task_steer and task_steered frames between relay and connector", async () => {
		const server = createServer();
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
		cleanups.push(async () => {
			server.closeAllConnections();
			server.close();
		});

		const relay = createDeviceRelay({
			server,
			publicUrl: origin,
			authenticateDevice: (id, key) => id === "dev1" && key === "secret",
			getAccount: () => ({ id: "account" }),
			ownsDevice: () => true,
		});
		cleanups.push(async () => relay.close());

		let receivedSteerTaskId = "";
		let receivedSteerText = "";
		const connector = createDeviceConnector({
			hubUrl: origin,
			deviceId: "dev1",
			credential: "secret",
			localOrigin: origin,
			onSteer: (taskId, text) => {
				receivedSteerTaskId = taskId;
				receivedSteerText = text;
				return true;
			},
		});
		cleanups.push(async () => connector.close());

		for (let i = 0; i < 50; i++) {
			if (relay.isOnline("dev1")) break;
			await new Promise((r) => setTimeout(r, 50));
		}
		expect(relay.isOnline("dev1")).toBe(true);

		// Register a task in relay
		expect(
			relay.sendTask("dev1", {
				id: "t1",
				attemptId: "att1",
				botId: "bot1",
				deviceId: "dev1",
				botRevision: 1,
			}),
		).toBe(true);

		// Now test steerTask
		const steerResult = await relay.steerTask("dev1", "t1", "att1", "Change target to production");
		expect(steerResult).toEqual({ steered: true });
		expect(receivedSteerTaskId).toBe("t1");
		expect(receivedSteerText).toBe("Change target to production");

		// Mismatched attemptId should fail steer
		const mismatchResult = await relay.steerTask("dev1", "t1", "wrong-attempt", "Hello");
		expect(mismatchResult).toEqual({ steered: false });
	});

	it("supports runtime.steerTask targeting active task owner", async () => {
		let executedSteerText = "";
		let steerCalled = false;
		let finishRun: (() => void) | undefined;

		const mockExecutor = {
			run: vi.fn().mockImplementation(
				() =>
					new Promise((resolve) => {
						finishRun = () => resolve("done");
					}),
			),
			close: vi.fn().mockImplementation(() => {
				finishRun?.();
				return Promise.resolve();
			}),
			steer: (text: string) => {
				steerCalled = true;
				executedSteerText = text;
				return true;
			},
		};

		const bot = {
			id: "bot1",
			name: "Bot",
			cwd: process.cwd(),
			revision: 1,
			tools: ["device_collab"],
			enabled: true,
		};
		const bots = {
			get: () => bot,
			list: () => [bot],
			acquire: async () => ({
				bot,
				root: bot.cwd,
				release: () => {},
			}),
		} as any;

		const runtime = createDeviceRuntime({
			config: {
				hubUrl: "http://127.0.0.1:8080",
				deviceId: "dev1",
				credential: "cred",
				allowExecution: true,
			},
			localOrigin: "http://127.0.0.1:3000",
			bots,
			executorFactory: () => mockExecutor,
		});
		cleanups.push(async () => runtime.close());

		// Start a task
		void runtime.onTask({
			id: "task-steer-test",
			attemptId: "att-1",
			roomId: "room-1",
			deviceId: "dev1",
			botId: "bot1",
			botRevision: 1,
			text: "initial task",
			leaseToken: "valid-lease",
		} as any);

		// Wait briefly for owner to register in active set
		await new Promise((r) => setTimeout(r, 100));

		// Call steerTask on runtime
		const result = await runtime.steerTask("task-steer-test", "Mid-flight instruction");
		expect(result).toBe(true);
		expect(steerCalled).toBe(true);
		expect(executedSteerText).toBe("Mid-flight instruction");

		// Non-existent task returns false
		const nonExistent = await runtime.steerTask("random-task", "Text");
		expect(nonExistent).toBe(false);
	});

	it("supports Bot updating blackboard sections via collab-service", async () => {
		const f = await fixture();
		const cookie = await f.register("bot_collab_user");
		const dev = await f.pair(cookie, "ArchitectBot");

		const roomRes = await f.request("/api/rooms", { name: "Collab Room", botIds: [dev.botId] }, cookie);
		expect(roomRes.status).toBe(201);
		const roomId = roomRes.body.room.id;

		const collabService = createDeviceCollabService({
			getConfig: () => ({
				hubUrl: f.publicUrl,
				deviceId: dev.deviceId,
				credential: dev.credential,
				allowExecution: true,
			}),
			root: process.cwd(),
		});

		const updateResult = (await collabService.execute(
			"blackboard_update",
			{
				roomId,
				sourceBotId: dev.botId,
				title: "Database Schema",
				content: "CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT);",
				expectedVersion: 0,
				sectionId: "database_schema",
			},
			undefined,
			{ cwd: process.cwd() },
		)) as any;

		expect(updateResult.ok).toBe(true);
		expect(updateResult.blackboard.version).toBe(1);
		expect(updateResult.blackboard.sections.database_schema).toBeDefined();
		expect(updateResult.blackboard.sections.database_schema.title).toBe("Database Schema");
		expect(updateResult.blackboard.sections.database_schema.updatedBy.type).toBe("bot");
		expect(updateResult.blackboard.sections.database_schema.updatedBy.id).toBe(dev.botId);
		expect(updateResult.blackboard.content).toContain("## Database Schema");
		expect(updateResult.blackboard.content).toContain("CREATE TABLE users");
	});
});
