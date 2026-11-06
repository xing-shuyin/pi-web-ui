import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { createDeviceHub } from "../../server/device-center/hub.js";
import { hashSecret } from "../../server/device-center/store.js";
import { createWorkItem } from "../../server/device-center/work-items.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
	const dataDir = await mkdtemp(join(tmpdir(), "hub-router-test-"));
	cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
	const callDevice = vi.fn(async () => ({
		models: [{ provider: "test", id: "router-model", name: "Router model", reasoning: true }],
	}));
	const hub = await createDeviceHub({ dataDir, publicUrl: "https://hub.test", relay: { callDevice }, onTask: vi.fn() });
	await new Promise<void>((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
	cleanups.push(() => hub.close());
	await hub.store.transact((state) => {
		state.accounts.push({ id: "owner", username: "owner", passwordHash: "", createdAt: 1 });
		state.devices.push({
			id: "device",
			accountId: "owner",
			name: "Router host",
			credentialHash: hashSecret("agent-token"),
			uiCredentialHash: hashSecret("ui-token"),
			createdAt: 1,
		});
		state.bots.push({
			id: "worker",
			accountId: "owner",
			deviceId: "device",
			name: "Executor",
			description: "Executes tasks",
			enabled: true,
			revision: 1,
			createdAt: 1,
			updatedAt: 1,
			tools: [],
		});
		state.rooms.push({
			id: "room",
			accountId: "owner",
			name: "Team",
			botIds: ["worker"],
			primaryBotId: "worker",
			createdAt: 1,
		});
	});
	const port = (hub.server.address() as { port: number }).port;
	async function request(path: string, body?: unknown, agent = false, method = body === undefined ? "GET" : "POST") {
		return new Promise<{ status: number; body: any }>((resolve, reject) => {
			const outgoing = httpRequest(
				`http://127.0.0.1:${port}${path}`,
				{
					method,
					headers: {
						Host: "hub.test",
						Origin: "https://hub.test",
						"Content-Type": "application/json",
						"X-Device-Id": "device",
						Authorization: `Bearer ${agent ? "agent-token" : "ui-token"}`,
					},
				},
				(incoming) => {
					let text = "";
					incoming.setEncoding("utf8");
					incoming.on("data", (chunk) => {
						text += chunk;
					});
					incoming.on("end", () => {
						try {
							resolve({ status: incoming.statusCode!, body: JSON.parse(text) });
						} catch (e) {
							reject(new Error(`${incoming.statusCode}: ${text}`, { cause: e }));
						}
					});
				},
			);
			outgoing.on("error", reject);
			outgoing.end(body === undefined ? undefined : JSON.stringify(body));
		});
	}
	const user = (path: string, body?: unknown, method?: string) =>
		request(`/api/device-user${path}`, body, false, method);
	const agent = (path: string, body?: unknown) => request(`/api/agent${path}`, body, true);
	const router = {
		enabled: true,
		deviceId: "device",
		model: "test/router-model",
		thinkingLevel: "high",
		tools: ["reply", "dispatch", "work_items"],
	};
	expect((await user("/rooms/room", { router })).status).toBe(200);
	return { hub, user, agent, router, callDevice, request };
}

describe("Hub group orchestration", () => {
	it("shares one dispatch budget lineage across parallel decisions in the same router plan", async () => {
		const { hub, user, agent } = await fixture();
		await hub.store.transact((s) => {
			s.bots.push({ ...s.bots[0], id: "worker-two", name: "Second executor" });
			s.rooms[0].botIds.push("worker-two");
		});
		await user("/rooms/room/messages", { text: "Delegate two independent checks" });
		const { job } = (await agent("/router/jobs/next")).body;
		const completed = await agent(`/router/jobs/${job.id}/complete`, {
			leaseToken: job.leaseToken,
			actions: [
				{ type: "dispatch", botId: "worker", text: "Check source" },
				{ type: "dispatch", botId: "worker-two", text: "Check documentation" },
			],
		});
		expect(completed.status).toBe(200);
		const tasks = hub.store.snapshot().tasks;
		expect(tasks).toHaveLength(2);
		expect(tasks[1].rootTaskId).toBe(tasks[0].rootTaskId);
		expect(tasks[0].dispatchCount).toBe(2);
	});
	it("retries failed jobs only under their unchanged group configuration", async () => {
		const { hub, user, agent } = await fixture();
		await user("/rooms/room/messages", { text: "A request" });
		const { job } = (await agent("/router/jobs/next")).body;
		expect(
			(await agent(`/router/jobs/${job.id}/fail`, { leaseToken: job.leaseToken, error: "Provider unavailable" }))
				.status,
		).toBe(200);
		expect((await user(`/rooms/room/router/jobs/${job.id}/retry`, {})).status).toBe(200);
		const resumed = (await agent("/router/jobs/next")).body.job;
		expect(resumed.id).toBe(job.id);
		expect(resumed.attempts).toBe(2);
		expect(
			(await agent(`/router/jobs/${job.id}/complete`, { leaseToken: resumed.leaseToken, actions: [] })).status,
		).toBe(200);
		expect(hub.store.snapshot().routerJobs[0].status).toBe("completed");
	});
	it("fences pending decisions when chat history is cleared while preserving work items", async () => {
		const { hub, user, agent } = await fixture();
		const event = {
			roomId: "room",
			provider: "github",
			channelId: "o/r",
			threadId: "#1",
			eventId: "e",
			title: "Persistent item",
			text: "Request",
			authorId: "12",
			mode: "observe",
			authorized: false,
		};
		await user("/work-items/ingest", event);
		await user("/rooms/room/messages", { text: "A request" });
		const { job } = (await agent("/router/jobs/next")).body;
		expect((await user("/rooms/room/clear", {})).status).toBe(200);
		expect(hub.store.snapshot().workItems).toHaveLength(1);
		expect(hub.store.snapshot().messages).toHaveLength(0);
		expect(
			(
				await agent(`/router/jobs/${job.id}/complete`, {
					leaseToken: job.leaseToken,
					actions: [{ type: "reply", text: "Late decision" }],
				})
			).status,
		).toBe(409);
		expect((await user("/rooms/room/delete", {})).status).toBe(200);
		expect(hub.store.snapshot().workItems).toHaveLength(0);
		expect(hub.store.snapshot().routerJobs).toHaveLength(0);
	});
	it("routes authorized legacy incoming webhooks through the group AI and rechecks channel revocation", async () => {
		const { hub, user, agent, request } = await fixture();
		const created = await user("/rooms/room/webhooks", { name: "Automation", type: "incoming", allowBotTrigger: true });
		expect(created.status).toBe(200);
		const hook = created.body.webhook;
		const incoming = await request(`/api/rooms/room/webhooks/incoming/${hook.id}?token=${hook.token}`, {
			text: "Please coordinate this",
		});
		expect(incoming.status).toBe(200);
		expect(incoming.body.tasks).toEqual([]);
		const { job } = (await agent("/router/jobs/next")).body;
		expect(job.trigger.type).toBe("webhook_message");
		expect((await user(`/rooms/room/webhooks/${hook.id}`, { enabled: false })).status).toBe(200);
		const stale = await agent(`/router/jobs/${job.id}/complete`, {
			leaseToken: job.leaseToken,
			actions: [{ type: "dispatch", botId: "worker", text: "Do work" }],
		});
		expect([400, 403, 409]).toContain(stale.status);
		expect(hub.store.snapshot().tasks).toHaveLength(0);
	});
	it("paginates bounded work item previews without exposing prepared actions or lease credentials", async () => {
		const { hub, user } = await fixture();
		await hub.store.transact((state) => {
			for (let i = 0; i < 33; i++)
				createWorkItem(
					state,
					{
						accountId: "owner",
						roomId: "room",
						source: { provider: "github", channelId: "o/r", threadId: `#${i}` },
						title: `Item ${i}`,
						text: "长文本".repeat(10000),
						author: { id: "12" },
						sourceTrust: { connectorId: "test", verified: true },
						authorization: { mode: "observe", authorizedBy: "test" },
					},
					i + 1,
				);
		});
		const first = await user("/rooms/room/work-items");
		expect(first.status).toBe(200);
		expect(first.body.workItems.length).toBeGreaterThan(0);
		expect(first.body.workItems.length).toBeLessThanOrEqual(30);
		expect(first.body.nextCursor).toEqual(expect.any(String));
		expect(Buffer.byteLength(JSON.stringify(first.body))).toBeLessThan(110 * 1024);
		const second = await user(`/rooms/room/work-items?before=${encodeURIComponent(first.body.nextCursor)}`);
		expect(second.body.workItems).toHaveLength(33 - first.body.workItems.length);
		expect(second.body.nextCursor).toBeNull();
		expect(new Set([...first.body.workItems, ...second.body.workItems].map((w) => w.id)).size).toBe(33);
		expect((await user("/rooms/room/work-items?before=invalid")).status).toBe(409);
	});
	it("preserves event lifecycle evidence and prioritizes the origin work item in bounded router context", async () => {
		const { hub, user, agent } = await fixture();
		const event = {
			roomId: "room",
			provider: "github",
			channelId: "o/r",
			threadId: "#origin",
			eventId: "merged-1",
			title: "Origin",
			text: "An issue",
			authorId: "12",
			mode: "auto",
			authorized: true,
			kind: "pull_request.merged",
		};
		const incoming = await user("/work-items/ingest", event);
		expect(incoming.status).toBe(200);
		await hub.store.transact((state) => {
			for (let i = 0; i < 60; i++)
				createWorkItem(
					state,
					{
						accountId: "owner",
						roomId: "room",
						source: { provider: "github", channelId: "o/r", threadId: `#later${i}` },
						title: "Later",
						text: "长文本".repeat(10000),
						author: { id: "12" },
						sourceTrust: { connectorId: "test", verified: true },
						authorization: { mode: "observe", authorizedBy: "test" },
					},
					Date.now() + i,
				);
		});
		const next = await agent("/router/jobs/next");
		expect(next.status).toBe(200);
		expect(next.body.context.workItems[0].id).toBe(incoming.body.workItem.id);
		expect(next.body.context.workItemEvent.kind).toBe("pull_request.merged");
		expect(Buffer.byteLength(JSON.stringify(next.body))).toBeLessThan(256 * 1024);
	});
	it("routes unaddressed human messages to the independent AI instead of the legacy primary Bot", async () => {
		const { hub, user, agent } = await fixture();
		const posted = await user("/rooms/room/messages", { text: "Review this request", idempotencyKey: "input-1" });
		expect(posted.status).toBe(200);
		expect(posted.body.tasks).toEqual([]);
		expect(hub.store.snapshot().tasks).toHaveLength(0);
		expect(
			(await user("/rooms/room/messages", { text: "Review this request", idempotencyKey: "input-1" })).status,
		).toBe(200);
		const next = await agent("/router/jobs/next");
		expect(next.status).toBe(200);
		const { job, context } = next.body;
		expect(job.config.model).toBe("test/router-model");
		expect(context.members[0].id).toBe("worker");
		expect(context.room.id).toBe("room");
		expect(
			(
				await agent(`/router/jobs/${job.id}/complete`, {
					leaseToken: job.leaseToken,
					actions: [{ type: "reply", text: "I will coordinate the work." }],
				})
			).status,
		).toBe(200);
		const state = hub.store.snapshot();
		expect(state.routerJobs).toHaveLength(1);
		expect(state.routerJobs[0].status).toBe("completed");
		expect(state.messages.at(-1)?.sender.type).toBe("router");
		expect(state.messages.at(-1)?.routerJobId).toBe(job.id);
		expect((await agent("/router/jobs/next")).body.job).toBeNull();
	});
	it("dispatches through existing receipts and survives replay after an effect was durably applied", async () => {
		const { hub, user, agent } = await fixture();
		await user("/rooms/room/messages", { text: "Please delegate this" });
		const { job } = (await agent("/router/jobs/next")).body;
		const actions = [{ type: "dispatch", botId: "worker", text: "Inspect the repository" }];
		const first = await agent(`/router/jobs/${job.id}/complete`, { leaseToken: job.leaseToken, actions });
		expect(first.status).toBe(200);
		expect(hub.store.snapshot().tasks).toHaveLength(1);
		expect(hub.store.snapshot().tasks[0].botId).toBe("worker");
		await hub.store.transact((s) => {
			const row = s.routerJobs.find((j) => j.id === job.id)!;
			row.status = "running";
			row.appliedActionCount = 0;
			row.leaseExpiresAt = Date.now() + 60000;
		});
		const replay = await agent(`/router/jobs/${job.id}/complete`, { leaseToken: job.leaseToken, actions });
		expect(replay.status).toBe(200);
		expect(hub.store.snapshot().tasks).toHaveLength(1);
		expect(hub.store.snapshot().messages.filter((m) => m.routerJobId === job.id)).toHaveLength(1);
	});
	it("preserves observe mode until explicit human authorization and atomically applies a dispatch plus business update", async () => {
		const { hub, user, agent } = await fixture();
		const event = {
			roomId: "room",
			provider: "github",
			channelId: "owner/repo",
			threadId: "#7",
			eventId: "event-7",
			title: "Issue 7",
			text: "Fix the issue",
			authorId: "123",
			mode: "observe",
			authorized: false,
		};
		const incoming = await user("/work-items/ingest", event);
		expect(incoming.status).toBe(200);
		const item = incoming.body.workItem;
		expect(item.authorized).toBe(false);
		expect((await agent("/router/jobs/next")).body.job).toBeNull();
		expect((await user("/work-items/ingest", event)).body.duplicate).toBe(true);
		const authorization = await user(
			`/rooms/room/work-items/${item.id}`,
			{ revision: item.revision, authorize: true },
			"PATCH",
		);
		expect(authorization.status).toBe(200);
		expect(authorization.body.workItem.manualAuthorized).toBe(true);
		const current = authorization.body.workItem,
			{ job } = (await agent("/router/jobs/next")).body;
		const completed = await agent(`/router/jobs/${job.id}/complete`, {
			leaseToken: job.leaseToken,
			actions: [
				{ type: "dispatch", botId: "worker", text: "Fix issue 7" },
				{
					type: "work_item_update",
					workItemId: item.id,
					revision: current.revision,
					status: "running",
					summary: "Implementation started",
				},
			],
		});
		expect(completed.status).toBe(200);
		const state = hub.store.snapshot();
		expect(state.workItems[0].taskIds).toHaveLength(1);
		expect(state.workItems[0].status).toBe("running");
		expect(state.workItems[0].revision).toBe(current.revision + 1);
		const delivery = (await user("/work-item-deliveries/claim", { provider: "github" })).body.delivery;
		expect(delivery.threadId).toBe("#7");
		expect(delivery.leaseToken).toEqual(expect.any(String));
		expect(
			(
				await user(`/work-item-deliveries/${delivery.id}/complete`, {
					leaseToken: delivery.leaseToken,
					externalId: "comment-1",
				})
			).status,
		).toBe(200);
		expect((await user("/work-item-deliveries/claim", { provider: "github" })).body.delivery).toBeNull();
	});
	it("rejects stale leases and unauthorized use of the device channel for configuration", async () => {
		const { hub, user, agent } = await fixture();
		expect((await agent("/work-items/ingest", {})).status).toBe(404);
		expect((await user("/router/jobs/next")).status).toBe(404);
		await user("/rooms/room/messages", { text: "A request" });
		const { job } = (await agent("/router/jobs/next")).body;
		expect(
			(
				await agent(`/router/jobs/${job.id}/complete`, {
					leaseToken: "stale",
					actions: [{ type: "reply", text: "Wrong lease" }],
				})
			).status,
		).toBe(409);
		expect(hub.store.snapshot().messages).toHaveLength(1);
	});
	it("makes configuration changes fence previously claimed jobs", async () => {
		const { hub, user, agent, router } = await fixture();
		await user("/rooms/room/messages", { text: "A request" });
		const { job } = (await agent("/router/jobs/next")).body;
		expect((await user("/rooms/room", { router: { ...router, enabled: false } })).status).toBe(200);
		expect(
			(
				await agent(`/router/jobs/${job.id}/complete`, {
					leaseToken: job.leaseToken,
					actions: [{ type: "dispatch", botId: "worker", text: "Late decision" }],
				})
			).status,
		).toBe(409);
		expect(hub.store.snapshot().tasks).toHaveLength(0);
	});
	it("looks up models on the selected owned device and refuses unknown devices", async () => {
		const { user, callDevice } = await fixture();
		const catalog = await user("/router-models?deviceId=device");
		expect(catalog.status).toBe(200);
		expect(catalog.body.deviceId).toBe("device");
		expect(catalog.body.models[0].id).toBe("router-model");
		expect(callDevice).toHaveBeenCalledWith("device", "group_router_models", {});
		expect((await user("/router-models?deviceId=unowned")).status).toBe(404);
	});
});
