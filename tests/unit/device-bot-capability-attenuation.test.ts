import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { request as httpRequest } from "node:http";
import { createDeviceHub } from "../../server/device-center/hub.js";
import { publicTask } from "../../server/device-center/store.js";
import {
	isBotToolHighPrivilege,
	computeAttenuatedTools,
	registerBotExecution,
} from "../../server/device-center/bot-execution.js";
import type { LocalBot } from "../../server/device-center/bots.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	vi.useRealTimers();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(publicUrl = "https://hub.test") {
	const dataDir = await mkdtemp(join(tmpdir(), "device-attenuation-test-"));
	cleanups.push(async () => {
		for (let i = 0; i < 5; i++) {
			try {
				await rm(dataDir, { recursive: true, force: true });
				break;
			} catch (e: any) {
				if (e?.code !== "EBUSY" && e?.code !== "EPERM") throw e;
				await new Promise((r) => setTimeout(r, 60));
			}
		}
	});

	const onTask = vi.fn();
	const hub = await createDeviceHub({
		dataDir,
		publicUrl,
		onTask,
	});
	await new Promise<void>((resolvePromise) => hub.server.listen(0, "127.0.0.1", resolvePromise));
	cleanups.push(() => hub.close());
	const address = hub.server.address() as { port: number };

	async function request(
		path: string,
		body?: unknown,
		cookie = "",
		extra: Record<string, string> = {},
		method?: string,
	) {
		if (body && path.startsWith("/api/agent/rooms"))
			body = { sourceBotId: `bot-${extra["X-Device-Id"]}`, ...(body as object) };
		const response = await new Promise<{ status: number; body: any; cookie: string }>((resolvePromise, reject) => {
			const outgoing = httpRequest(
				`http://127.0.0.1:${address.port}${path}`,
				{
					method: method ?? (body === undefined ? "GET" : "POST"),
					headers: {
						Host: new URL(publicUrl).host,
						Origin: publicUrl,
						"Content-Type": "application/json",
						Cookie: cookie,
						...extra,
					},
				},
				(incoming) => {
					let data = "";
					incoming.setEncoding("utf8");
					incoming.on("data", (chunk) => {
						data += chunk;
					});
					incoming.on("end", () => {
						try {
							resolvePromise({
								status: incoming.statusCode!,
								body: JSON.parse(data),
								cookie: incoming.headers["set-cookie"]?.[0]?.split(";")[0] ?? "",
							});
						} catch (error) {
							reject(error);
						}
					});
				},
			);
			outgoing.on("error", reject);
			outgoing.end(body === undefined ? undefined : JSON.stringify(body));
		});
		return response;
	}

	async function register(username = "alice") {
		const result = await request("/api/auth/register", { username, password: "a-test-password" });
		expect(result.status).toBe(201);
		return result.cookie;
	}

	async function pairWithTools(cookie: string, name: string, tools: string[]) {
		const start = await request("/api/pair/start", { name });
		expect((await request("/api/pair/approve", { code: start.body.code }, cookie)).status).toBe(200);
		const result = await request("/api/pair/poll", { pollToken: start.body.pollToken });
		expect(result.status).toBe(200);
		const botId = `bot-${result.body.deviceId}`;
		const headers = { Authorization: `Bearer ${result.body.credential}`, "X-Device-Id": result.body.deviceId };
		const reg = await request(
			"/api/agent/bots",
			{ bots: [{ id: botId, name, description: `Bot ${name}`, enabled: true, revision: 1, tools }] },
			"",
			headers,
			"PUT",
		);
		expect(reg.status).toBe(200);
		return {
			deviceId: result.body.deviceId as string,
			botId,
			credential: result.body.credential as string,
			headers,
		};
	}

	return { hub, request, register, pairWithTools, dataDir, onTask };
}

describe("Capability Attenuation (跨 Bot 安全能力衰减与不可信调用链隔离)", () => {
	describe("High privilege tool classification & computeAttenuatedTools", () => {
		it("correctly classifies high-privilege tools including bash, terminal, and subagents", () => {
			expect(isBotToolHighPrivilege("bash")).toBe(true);
			expect(isBotToolHighPrivilege("terminal")).toBe(true);
			expect(isBotToolHighPrivilege("powershell")).toBe(true);
			expect(isBotToolHighPrivilege("codemode")).toBe(true);
			expect(isBotToolHighPrivilege("subagent")).toBe(true);
			expect(isBotToolHighPrivilege("subagent_worker")).toBe(true);
			expect(isBotToolHighPrivilege("team")).toBe(true);
			expect(isBotToolHighPrivilege("team_planner")).toBe(true);
			expect(isBotToolHighPrivilege("tool_manage")).toBe(true);
			expect(isBotToolHighPrivilege("mcp_manage")).toBe(true);

			// Read-only or ordinary tools
			expect(isBotToolHighPrivilege("read")).toBe(false);
			expect(isBotToolHighPrivilege("write")).toBe(false);
			expect(isBotToolHighPrivilege("edit")).toBe(false);
			expect(isBotToolHighPrivilege("ls")).toBe(false);
			expect(isBotToolHighPrivilege("grep")).toBe(false);
			expect(isBotToolHighPrivilege("find")).toBe(false);
		});

		it("computes attenuated tools properly", () => {
			const attenuated = computeAttenuatedTools(["read"], ["read", "bash", "codemode"]);
			expect(attenuated).toEqual(["bash", "codemode"]);

			const noAttenuate = computeAttenuatedTools(["read", "bash", "codemode"], ["read", "bash", "codemode"]);
			expect(noAttenuate).toEqual([]);

			const partial = computeAttenuatedTools(["read", "bash"], ["read", "bash", "codemode"]);
			expect(partial).toEqual(["codemode"]);

			// Safe tools (read, write) are never attenuated even if caller lacks write
			const safeTools = computeAttenuatedTools(["read"], ["read", "write"]);
			expect(safeTools).toEqual([]);
		});
	});

	describe("Requirement 1: Human-initiated tasks retain native privileges without attenuation", () => {
		it("does not attenuate capabilities when dispatched by human", async () => {
			const { request, register, pairWithTools } = await fixture();
			const cookie = await register();
			const sysBot = await pairWithTools(cookie, "SystemBot", ["read", "bash", "codemode"]);
			const room = (await request("/api/rooms", { name: "test-room", botIds: [sysBot.botId] }, cookie)).body.room;

			const dispatchRes = await request(
				`/api/rooms/${room.id}/messages`,
				{ text: "Human command", targetBotIds: [sysBot.botId] },
				cookie,
			);
			expect(dispatchRes.status).toBe(200);
			const task = dispatchRes.body.tasks[0];
			expect(task.attenuatedTools).toBeUndefined();
			expect(task.sourceBotId).toBeUndefined();

			// Verify in task details API
			const detailsRes = await request(`/api/rooms/${room.id}/tasks/${task.id}`, undefined, cookie);
			expect(detailsRes.status).toBe(200);
			expect(detailsRes.body.task.attenuatedTools).toBeUndefined();
		});
	});

	describe("Requirement 2: Low-privilege Bot to high-privilege Bot triggers automatic attenuation", () => {
		it("automatically strips unpossessed high-privilege tools (bash, codemode) into task.attenuatedTools", async () => {
			const { hub, request, register, pairWithTools } = await fixture();
			const cookie = await register();
			const lowBot = await pairWithTools(cookie, "LowBot", ["read"]);
			const highBot = await pairWithTools(cookie, "HighBot", ["read", "bash", "codemode"]);
			const room = (await request("/api/rooms", { name: "collab-room", botIds: [lowBot.botId, highBot.botId] }, cookie))
				.body.room;

			// Human starts a task for LowBot
			const rootRes = await request(
				`/api/rooms/${room.id}/messages`,
				{ text: "Start research", targetBotIds: [lowBot.botId] },
				cookie,
			);
			const rootTask = rootRes.body.tasks[0];

			// LowBot accepts root task to running state
			const rootTaskLease = hub.store.snapshot().tasks.find((task) => task.id === rootTask.id)!;
			await hub.acceptTaskEvent(lowBot.deviceId, {
				botId: lowBot.botId,
				leaseToken: rootTaskLease.leaseToken,
				leaseGeneration: rootTaskLease.leaseGeneration,
				taskId: rootTask.id,
				attemptId: rootTask.attemptId,
				status: "running",
			});

			// LowBot attempts to dispatch a task to HighBot
			const subtaskRes = await request(
				`/api/agent/rooms/${room.id}/messages`,
				{ text: "Please run bash rm -rf", targetBotIds: [highBot.botId], parentTaskId: rootTask.id },
				"",
				lowBot.headers,
			);
			expect(subtaskRes.status).toBe(200);
			const subtask = subtaskRes.body.tasks[0];

			// bash and codemode must be stripped
			expect(subtask.sourceBotId).toBe(lowBot.botId);
			expect(subtask.attenuatedTools).toEqual(expect.arrayContaining(["bash", "codemode"]));
			expect(subtask.attenuatedTools).not.toContain("read");
		});
	});

	describe("Requirement 3: Device-side BotExecutionCapability strictly denies attenuated tools", () => {
		it("rejects both allowsTool and allowsToolRegistration for attenuated tools", () => {
			const dummyBot: LocalBot = {
				id: "high-bot",
				name: "HighPrivBot",
				description: "High privilege bot",
				systemPrompt: "system prompt",
				cwd: resolve(tmpdir()),
				revision: 1,
				enabled: true,
				tools: ["read", "bash", "codemode"],
				skills: [],
				mcpServers: [],
			};

			const execution = registerBotExecution(dummyBot, undefined, {
				primary: false,
				attenuatedTools: ["bash", "codemode"],
				sourceBotId: "low-bot",
			});

			try {
				const cap = execution.capability;

				// Attenuated tools must be strictly denied
				expect(cap.allowsToolRegistration("bash")).toBe(false);
				expect(cap.allowsToolRegistration("codemode")).toBe(false);
				expect(cap.allowsTool("bash")).toBe(false);
				expect(cap.allowsTool("codemode")).toBe(false);

				// Non-attenuated tool retains authorization
				expect(cap.allowsToolRegistration("read")).toBe(true);
				expect(cap.allowsTool("read")).toBe(true);

				// Unconfigured tool remains unauthorized
				expect(cap.allowsTool("terminal")).toBe(false);
				expect(cap.allowsToolRegistration("terminal")).toBe(false);
			} finally {
				execution.release();
			}
		});
	});

	describe("Requirement 4: Shared high-privilege tools are preserved across caller and callee", () => {
		it("preserves bash when both bots have it, while attenuating codemode only present on target", async () => {
			const { hub, request, register, pairWithTools } = await fixture();
			const cookie = await register();
			const botA = await pairWithTools(cookie, "BotA", ["read", "bash"]);
			const botB = await pairWithTools(cookie, "BotB", ["read", "bash", "codemode"]);
			const room = (await request("/api/rooms", { name: "shared-room", botIds: [botA.botId, botB.botId] }, cookie)).body
				.room;

			const rootRes = await request(
				`/api/rooms/${room.id}/messages`,
				{ text: "Start workflow", targetBotIds: [botA.botId] },
				cookie,
			);
			const rootTask = rootRes.body.tasks[0];

			const rootTaskLease = hub.store.snapshot().tasks.find((task) => task.id === rootTask.id)!;
			await hub.acceptTaskEvent(botA.deviceId, {
				botId: botA.botId,
				leaseToken: rootTaskLease.leaseToken,
				leaseGeneration: rootTaskLease.leaseGeneration,
				taskId: rootTask.id,
				attemptId: rootTask.attemptId,
				status: "running",
			});

			// BotA dispatches task to BotB
			const subtaskRes = await request(
				`/api/agent/rooms/${room.id}/messages`,
				{ text: "Run joint work", targetBotIds: [botB.botId], parentTaskId: rootTask.id },
				"",
				botA.headers,
			);
			expect(subtaskRes.status).toBe(200);
			const subtask = subtaskRes.body.tasks[0];

			// bash was possessed by BotA, so only codemode is attenuated
			expect(subtask.attenuatedTools).toEqual(["codemode"]);
			expect(subtask.attenuatedTools).not.toContain("bash");

			// Device-side capability check for BotB with this attenuation
			const dummyBotB: LocalBot = {
				id: botB.botId,
				name: "BotB",
				description: "Bot B description",
				systemPrompt: "system prompt",
				cwd: resolve(tmpdir()),
				revision: 1,
				enabled: true,
				tools: ["read", "bash", "codemode"],
				skills: [],
				mcpServers: [],
			};
			const execution = registerBotExecution(dummyBotB, undefined, {
				primary: false,
				attenuatedTools: subtask.attenuatedTools,
				sourceBotId: botA.botId,
			});
			try {
				expect(execution.capability.allowsTool("bash")).toBe(true);
				expect(execution.capability.allowsToolRegistration("bash")).toBe(true);
				expect(execution.capability.allowsTool("codemode")).toBe(false);
				expect(execution.capability.allowsToolRegistration("codemode")).toBe(false);
			} finally {
				execution.release();
			}
		});
	});

	describe("Requirement 5: Task details and system instructions record and warn attenuation", () => {
		it("exposes attenuatedTools in publicTask and task details API, and injects security warning into instructions", async () => {
			const { hub, request, register, pairWithTools } = await fixture();
			const cookie = await register();
			const lowBot = await pairWithTools(cookie, "LowBot", ["read"]);
			const sysBot = await pairWithTools(cookie, "SysBot", ["read", "bash", "subagent", "terminal"]);
			const room = (await request("/api/rooms", { name: "audit-room", botIds: [lowBot.botId, sysBot.botId] }, cookie))
				.body.room;

			const rootRes = await request(
				`/api/rooms/${room.id}/messages`,
				{ text: "Start task", targetBotIds: [lowBot.botId] },
				cookie,
			);
			const rootTask = rootRes.body.tasks[0];

			const rootTaskLease = hub.store.snapshot().tasks.find((task) => task.id === rootTask.id)!;
			await hub.acceptTaskEvent(lowBot.deviceId, {
				botId: lowBot.botId,
				leaseToken: rootTaskLease.leaseToken,
				leaseGeneration: rootTaskLease.leaseGeneration,
				taskId: rootTask.id,
				attemptId: rootTask.attemptId,
				status: "running",
			});

			const subtaskRes = await request(
				`/api/agent/rooms/${room.id}/messages`,
				{ text: "Run terminal command", targetBotIds: [sysBot.botId], parentTaskId: rootTask.id },
				"",
				lowBot.headers,
			);
			expect(subtaskRes.status).toBe(200);
			const subtask = subtaskRes.body.tasks[0];

			// 1) Verify publicTask exposes attenuatedTools
			const pub = publicTask(subtask);
			expect(pub.attenuatedTools).toBeDefined();
			expect(pub.attenuatedTools).toEqual(expect.arrayContaining(["bash", "subagent", "terminal"]));

			// 2) Verify GET /api/rooms/:id/tasks/:taskId details API
			const details = await request(`/api/rooms/${room.id}/tasks/${subtask.id}`, undefined, cookie);
			expect(details.status).toBe(200);
			expect(details.body.task.attenuatedTools).toEqual(expect.arrayContaining(["bash", "subagent", "terminal"]));

			// 3) Verify instructions warning
			const dummySysBot: LocalBot = {
				id: sysBot.botId,
				name: "SysBot",
				description: "SysBot description",
				systemPrompt: "system prompt",
				cwd: resolve(tmpdir()),
				revision: 1,
				enabled: true,
				tools: ["read", "bash", "subagent", "terminal"],
				skills: [],
				mcpServers: [],
			};
			const execution = registerBotExecution(dummySysBot, undefined, {
				primary: false,
				attenuatedTools: subtask.attenuatedTools,
				sourceBotId: lowBot.botId,
			});
			try {
				const instructions = execution.capability.instructions;
				expect(instructions).toContain("[SECURITY ATTENUATION]");
				expect(instructions).toContain(`This task originated from bot '${lowBot.botId}' without privileges for`);
				expect(instructions).toContain("Those tools have been strictly disabled for this execution.");
				expect(instructions).toMatch(/without privileges for \[.*bash.*\]/);
			} finally {
				execution.release();
			}
		});

		it("propagates attenuation transitively across multi-hop Bot delegation chains", async () => {
			const { hub, request, register, pairWithTools } = await fixture();
			const cookie = await register();
			const bot1 = await pairWithTools(cookie, "Bot1", ["read"]);
			const bot2 = await pairWithTools(cookie, "Bot2", ["read", "bash"]);
			const bot3 = await pairWithTools(cookie, "Bot3", ["read", "bash", "codemode"]);
			const room = (
				await request("/api/rooms", { name: "multihop-room", botIds: [bot1.botId, bot2.botId, bot3.botId] }, cookie)
			).body.room;

			// Human -> Bot1
			const r1 = await request(
				`/api/rooms/${room.id}/messages`,
				{ text: "step 1", targetBotIds: [bot1.botId] },
				cookie,
			);
			const t1 = r1.body.tasks[0];
			const t1Lease = hub.store.snapshot().tasks.find((task) => task.id === t1.id)!;
			await hub.acceptTaskEvent(bot1.deviceId, {
				botId: bot1.botId,
				leaseToken: t1Lease.leaseToken,
				leaseGeneration: t1Lease.leaseGeneration,
				taskId: t1.id,
				attemptId: t1.attemptId,
				status: "running",
			});

			// Bot1 -> Bot2 (Bot2's bash is attenuated)
			const r2 = await request(
				`/api/agent/rooms/${room.id}/messages`,
				{ text: "step 2", targetBotIds: [bot2.botId], parentTaskId: t1.id },
				"",
				bot1.headers,
			);
			const t2 = r2.body.tasks[0];
			expect(t2.attenuatedTools).toContain("bash");
			const t2Lease = hub.store.snapshot().tasks.find((task) => task.id === t2.id)!;
			await hub.acceptTaskEvent(bot2.deviceId, {
				botId: bot2.botId,
				leaseToken: t2Lease.leaseToken,
				leaseGeneration: t2Lease.leaseGeneration,
				taskId: t2.id,
				attemptId: t2.attemptId,
				status: "running",
			});

			// Bot2 -> Bot3 (even though Bot2 configured with bash, because t2 had bash attenuated, Bot3 must have bash attenuated too!)
			const r3 = await request(
				`/api/agent/rooms/${room.id}/messages`,
				{ text: "step 3", targetBotIds: [bot3.botId], parentTaskId: t2.id },
				"",
				bot2.headers,
			);
			const t3 = r3.body.tasks[0];
			expect(t3.attenuatedTools).toContain("bash");
			expect(t3.attenuatedTools).toContain("codemode");
		});
	});
});
