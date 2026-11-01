import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { createDeviceHub } from "../../server/device-center/hub.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	vi.useRealTimers();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(publicUrl = "https://hub.test") {
	const dataDir = await mkdtemp(join(tmpdir(), "device-hub-plan-test-"));
	cleanups.push(async () => {
		for (let i = 0; i < 5; i++) {
			try {
				await rm(dataDir, { recursive: true, force: true });
				break;
			} catch (e: any) {
				if (e?.code !== "EBUSY" && e?.code !== "EPERM" && e?.code !== "ENOTEMPTY" && e?.code !== "ENOTEMPTY") throw e;
				await new Promise((r) => setTimeout(r, 60));
			}
		}
	});

	const hub = await createDeviceHub({
		dataDir,
		publicUrl,
	});
	await new Promise<void>((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
	cleanups.push(() => hub.close());
	const address = hub.server.address() as { port: number };

	async function request(
		path: string,
		body?: unknown,
		cookie = "",
		extra: Record<string, string> = {},
		method?: string,
	) {
		const response = await new Promise<{ status: number; body: any; cookie: string }>((resolve, reject) => {
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
							resolve({
								status: incoming.statusCode!,
								body: data ? JSON.parse(data) : {},
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

	async function pair(cookie: string, name = "DevBot") {
		const start = await request("/api/pair/start", { name }, cookie);
		expect((await request("/api/pair/approve", { code: start.body.code }, cookie)).status).toBe(200);
		const result = await request("/api/pair/poll", { pollToken: start.body.pollToken });
		expect(result.status).toBe(200);
		const botId = `bot-${result.body.deviceId}`;
		expect(
			(
				await request(
					"/api/agent/bots",
					{
						bots: [
							{
								id: botId,
								name,
								description: "Planner Bot",
								enabled: true,
								revision: 1,
								tools: ["read", "write", "plan_update"],
							},
						],
					},
					"",
					{ Authorization: `Bearer ${result.body.credential}`, "X-Device-Id": result.body.deviceId },
					"PUT",
				)
			).status,
		).toBe(200);
		return {
			deviceId: result.body.deviceId,
			botId,
			credential: result.body.credential,
			uiCredential: result.body.uiCredential,
		};
	}

	return { hub, request, register, pair };
}

describe("device center hub: Real planOnly HTTP & approve-plan Pipeline", () => {
	it("strictly validates planOnly creation and enforces human-only plan approval to launch next task", async () => {
		const { hub, request, register, pair } = await fixture();
		const cookie = await register();
		const bot = await pair(cookie, "Planner");

		// 1. Create a room
		const roomRes = await request("/api/rooms", { name: "Planning Room", botIds: [bot.botId] }, cookie);
		expect(roomRes.status).toBe(201);
		const roomId = roomRes.body.room.id;

		// 2. String "false" must not be parsed as boolean true
		const falseMsgRes = await request(
			`/api/rooms/${roomId}/messages`,
			{ text: "Not a plan", targetBotIds: [bot.botId], planOnly: "false" },
			cookie,
		);
		expect(falseMsgRes.status).toBe(200);
		expect(falseMsgRes.body.tasks[0].planOnly).toBeUndefined();

		// 3. Send message with strict planOnly: true
		const planMsgRes = await request(
			`/api/rooms/${roomId}/messages`,
			{
				text: "Research and plan architecture",
				targetBotIds: [bot.botId],
				planOnly: true,
				idempotencyKey: "planning-request",
			},
			cookie,
		);
		expect(planMsgRes.status).toBe(200);
		const planTask = planMsgRes.body.tasks[0];
		expect(planTask.planOnly).toBe(true);
		expect(planTask.plan).toEqual({ state: "draft", steps: [] });
		const changedMode = await request(
			`/api/rooms/${roomId}/messages`,
			{
				text: "Research and plan architecture",
				targetBotIds: [bot.botId],
				planOnly: false,
				idempotencyKey: "planning-request",
			},
			cookie,
		);
		expect(changedMode.status).toBe(409);

		// 4. While in draft state, approve-plan fails (409)
		const draftApprove = await request(`/api/rooms/${roomId}/tasks/${planTask.id}/approve-plan`, {}, cookie);
		expect(draftApprove.status).toBe(409);

		// 5. Bot / Agent cannot self-approve (must fail with 401/403/404)
		const botSelfApprove = await request(`/api/rooms/${roomId}/tasks/${planTask.id}/approve-plan`, {}, "", {
			Authorization: `Bearer ${bot.credential}`,
			"X-Device-Id": bot.deviceId,
		});
		expect([401, 403, 404]).toContain(botSelfApprove.status);

		const agentPrefixApprove = await request(`/api/agent/rooms/${roomId}/tasks/${planTask.id}/approve-plan`, {}, "", {
			Authorization: `Bearer ${bot.credential}`,
			"X-Device-Id": bot.deviceId,
		});
		expect([401, 403, 404]).toContain(agentPrefixApprove.status);

		// Report through the real Hub consumer and verify its committed result.
		await hub.store.transact((draft) => {
			draft.tasks.find((task) => task.id === planTask.id)!.status = "running";
		});
		const readyFrame = {
			type: "task_plan_ready" as const,
			taskId: planTask.id,
			botId: bot.botId,
			attemptId: planTask.attemptId,
			plan: {
				state: "ready" as const,
				steps: [{ id: "1", title: "Survey API endpoints", status: "pending" as const }],
			},
		};
		expect(await hub.acceptTaskPlanReady("wrong-device", readyFrame)).toBe(false);
		expect(await hub.acceptTaskPlanReady(bot.deviceId, readyFrame)).toBe(true);
		expect(hub.store.snapshot().tasks.find((task) => task.id === planTask.id)?.plan?.state).toBe("ready");
		expect((await request(`/api/rooms/${roomId}/tasks/${planTask.id}/approve-plan`, {}, cookie)).status).toBe(409);
		await hub.store.transact((draft) => {
			draft.tasks.find((task) => task.id === planTask.id)!.status = "completed";
		});

		// 7. Human user approves the plan
		const humanApprove = await request(`/api/device-user/rooms/${roomId}/tasks/${planTask.id}/approve-plan`, {}, "", {
			Authorization: `Bearer ${bot.uiCredential}`,
			"X-Device-Id": bot.deviceId,
		});
		expect(humanApprove.status).toBe(200);
		expect(humanApprove.body.ok).toBe(true);
		expect(humanApprove.body.plan.state).toBe("approved");
		expect(humanApprove.body.nextTaskId).toBeDefined();

		// 8. Verify the atomically created nextTask in Hub storage
		const snapshot = (hub as any).store.snapshot();
		const approvedTask = snapshot.tasks.find((t: any) => t.id === planTask.id);
		expect(approvedTask.plan.state).toBe("approved");

		const nextTask = snapshot.tasks.find((t: any) => t.id === humanApprove.body.nextTaskId);
		expect(nextTask).toBeDefined();
		expect(nextTask.planOnly).toBe(false); // planOnly restriction lifted for actual execution
		expect(nextTask.parentTaskId).toBe(planTask.id);
		expect(nextTask.rootTaskId).toBe(planTask.rootTaskId);
		expect(nextTask.dispatchDepth).toBe(planTask.dispatchDepth + 1);
		expect(snapshot.tasks.find((task: any) => task.id === planTask.rootTaskId).dispatchCount).toBe(2);
		expect(["queued", "failed"]).toContain(nextTask.status); // A fixture without a relay rejects delivery.
		expect(nextTask.conversationId).toBe(planTask.conversationId);

		// 9. Repeated approval is rejected (409)
		const duplicateApprove = await request(`/api/rooms/${roomId}/tasks/${planTask.id}/approve-plan`, {}, cookie);
		expect(duplicateApprove.status).toBe(409);
	});
});
