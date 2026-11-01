import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { createDeviceHub } from "../../server/device-center/hub.js";
import { DeviceHubStore } from "../../server/device-center/store.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	vi.useRealTimers();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(
	publicUrl = "https://hub.test",
	deviceDomain: string | undefined = "devices.test",
	extra: Partial<Parameters<typeof createDeviceHub>[0]> = {},
) {
	const dataDir = await mkdtemp(join(tmpdir(), "device-hub-test-"));
	cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
	const onTask = vi.fn();
	const onRevoke = vi.fn();
	const hub = await createDeviceHub({
		dataDir,
		publicUrl,
		deviceDomain: deviceDomain || undefined,
		onTask,
		onRevoke,
		...extra,
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
		if (body && path.startsWith("/api/agent/rooms"))
			body = { sourceBotId: `bot-${extra["X-Device-Id"]}`, ...(body as object) };
		const response = await new Promise<{ status: number; body: any; cookie: string; headers: unknown }>(
			(resolve, reject) => {
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
									body: JSON.parse(data),
									cookie: incoming.headers["set-cookie"]?.[0]?.split(";")[0] ?? "",
									headers: incoming.headers,
								});
							} catch (error) {
								reject(error);
							}
						});
					},
				);
				outgoing.on("error", reject);
				outgoing.end(body === undefined ? undefined : JSON.stringify(body));
			},
		);
		return response;
	}
	async function register(username = "alice") {
		const result = await request("/api/auth/register", { username, password: "a-test-password" });
		expect(result.status).toBe(201);
		return result.cookie;
	}
	async function pair(cookie: string, name = "Windows") {
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
		return { ...result.body, botId, start: start.body } as {
			deviceId: string;
			botId: string;
			credential: string;
			start: { code: string; pollToken: string };
		};
	}
	return { hub, request, register, pair, dataDir, onTask, onRevoke };
}

describe("durable hub conversations", () => {
	it("publishes task state atomically and accepts only current Bot progress with revision checks", async () => {
		const { hub, request, register, pair, onTask } = await fixture();
		const cookie = await register();
		const bot = await pair(cookie);
		const room = (await request("/api/rooms", { name: "state", botIds: [bot.botId] }, cookie)).body.room;
		const first = (
			await request(
				`/api/rooms/${room.id}/conversations`,
				{ targetBotId: bot.botId, text: "Implement original goal" },
				cookie,
			)
		).body;
		const path = `/api/rooms/${room.id}/conversations/${first.conversation.id}/task-state`;
		const agentPath = path.replace("/api/", "/api/agent/");
		const headers = { Authorization: `Bearer ${bot.credential}`, "X-Device-Id": bot.deviceId };
		const initial = await request(path, undefined, cookie);
		expect(initial.status).toBe(200);
		expect(initial.body.taskState.objective).toContain("original goal");
		expect(initial.body.taskState.phase).toBe("queued");
		expect(onTask.mock.calls[0][1].taskState.objective).toContain("original goal");
		expect((await request(agentPath, undefined, "", headers)).status).toBe(404);
		expect((await request(`${agentPath}?sourceBotId=${bot.botId}`, undefined, "", headers)).status).toBe(200);
		await hub.acceptTaskEvent(bot.deviceId, {
			taskId: first.task.id,
			attemptId: first.task.attemptId,
			botId: bot.botId,
			status: "running",
		});
		const active = (await request(path, undefined, cookie)).body;
		const update = {
			parentTaskId: first.task.id,
			expectedRevision: active.taskState.revision,
			progress: "Implemented parser",
			constraints: ["Keep API compatibility"],
			blockers: [],
			nextSteps: ["Run tests"],
		};
		expect((await request(path, update, cookie)).status).toBe(403);
		expect((await request(agentPath, { ...update, parentTaskId: "spoof" }, "", headers)).status).toBe(409);
		expect((await request(agentPath, { ...update, objective: "Overwrite user goal" }, "", headers)).status).toBe(400);
		const saved = await request(agentPath, update, "", headers);
		expect(saved.status).toBe(200);
		expect(saved.body.taskState.reported).toMatchObject({
			taskId: first.task.id,
			botId: bot.botId,
			progress: update.progress,
		});
		expect(saved.body.taskState.objective).toBe(initial.body.taskState.objective);
		expect(saved.body.taskState.revision).toBeGreaterThan(active.taskState.revision);
		expect(saved.body.events.at(-1).type).toBe("task_updated");
		expect((await request(agentPath, update, "", headers)).status).toBe(409);
		const noop = await request(agentPath, { ...update, expectedRevision: saved.body.taskState.revision }, "", headers);
		expect(noop.status).toBe(200);
		expect(noop.body.taskState.revision).toBe(saved.body.taskState.revision);
		await hub.acceptTaskEvent(bot.deviceId, {
			taskId: first.task.id,
			attemptId: first.task.attemptId,
			botId: bot.botId,
			status: "completed",
			report: "Done",
		});
		const done = (await request(path, undefined, cookie)).body;
		expect(done.taskState.phase).toBe("completed");
		expect(
			(await request(agentPath, { ...update, expectedRevision: done.taskState.revision }, "", headers)).status,
		).toBe(409);
	});
	it("persists a Bot question and atomically resumes its original conversation on a human answer", async () => {
		const { hub, request, register, pair, dataDir, onTask } = await fixture();
		const cookie = await register();
		const bot = await pair(cookie);
		const room = (await request("/api/rooms", { name: "team", botIds: [bot.botId] }, cookie)).body.room;
		const base = `/api/rooms/${room.id}/conversations`;
		const first = (await request(base, { targetBotId: bot.botId, text: "start" }, cookie)).body;
		await hub.acceptTaskEvent(bot.deviceId, {
			taskId: first.task.id,
			attemptId: first.task.attemptId,
			botId: bot.botId,
			status: "running",
		});
		const path = `${base}/${first.conversation.id}`;
		const agentPath = `/api/agent/rooms/${room.id}/conversations/${first.conversation.id}/attention`;
		const headers = { Authorization: `Bearer ${bot.credential}`, "X-Device-Id": bot.deviceId };
		const question = { parentTaskId: first.task.id, question: "Which option?", kind: "decision" };
		expect((await request(`${path}/attention`, question, cookie)).status).toBe(403);
		const asked = await request(agentPath, question, "", headers);
		expect(asked.status).toBe(200);
		expect((await request(agentPath, question, "", headers)).body.attention.id).toBe(asked.body.attention.id);
		const body = { text: "Option A", attentionId: asked.body.attention.id, idempotencyKey: "answer" };
		const answered = await request(`${path}/messages`, body, cookie);
		expect(answered.status).toBe(200);
		expect(onTask).toHaveBeenCalledTimes(1);
		const queued = JSON.parse(await readFile(join(dataDir, "device-hub.json"), "utf8"));
		expect(queued.conversations[0].latestTaskId).toBe(first.task.id);
		expect(queued.tasks.find((task: any) => task.id === answered.body.task.id).status).toBe("queued");
		expect(queued.conversations[0].taskState.decisions[0].answer).toBe("Option A");
		expect(queued.tasks.find((task: any) => task.id === answered.body.task.id).rootTaskId).toBe(answered.body.task.id);
		expect(queued.tasks.find((task: any) => task.id === answered.body.task.id).parentTaskId).toBeUndefined();
		const followup = (await request(`${path}/messages`, { text: "Follow up", idempotencyKey: "follow-up" }, cookie))
			.body.task;
		expect(onTask).toHaveBeenCalledTimes(1);
		const runningState = (await request(`${path}/task-state`, undefined, cookie)).body.taskState;
		expect(runningState.currentTaskId).toBe(first.task.id);
		expect(runningState.phase).toBe("running");
		await hub.acceptTaskEvent(bot.deviceId, {
			taskId: first.task.id,
			attemptId: first.task.attemptId,
			botId: bot.botId,
			status: "completed",
			report: "Waiting for a decision",
		});
		const saved = JSON.parse(await readFile(join(dataDir, "device-hub.json"), "utf8"));
		expect(saved.conversations[0].attention).toBeUndefined();
		expect(onTask).toHaveBeenCalledTimes(2);
		expect(onTask.mock.calls[1][1].id).toBe(answered.body.task.id);
		expect(answered.body.task.conversationId).toBe(first.conversation.id);
		expect(answered.body.task.resume).toBe(true);
		expect((await request(`${path}/messages`, body, cookie)).body.task.id).toBe(answered.body.task.id);
		expect((await request(`${path}/messages`, { ...body, text: "Option B" }, cookie)).status).toBe(409);
		expect((await request(`${path}/messages`, { ...body, idempotencyKey: "stale" }, cookie)).status).toBe(409);
		expect(onTask).toHaveBeenCalledTimes(2);
		expect((await request(path, undefined, cookie)).body.conversation.attention).toBeUndefined();
		await hub.acceptTaskEvent(bot.deviceId, {
			...answered.body.task,
			taskId: answered.body.task.id,
			status: "running",
		});
		const done = {
			...answered.body.task,
			taskId: answered.body.task.id,
			status: "completed",
			report: "Answer consumed",
		};
		await hub.acceptTaskEvent(bot.deviceId, done);
		await hub.acceptTaskEvent(bot.deviceId, done);
		expect(onTask).toHaveBeenCalledTimes(3);
		expect(onTask.mock.calls[2][1].id).toBe(followup.id);
	});
	it("persists addresses, queues continuation once and rejects changed identity", async () => {
		const { hub, request, register, pair, onTask, dataDir } = await fixture();
		const cookie = await register();
		const device = await pair(cookie);
		const room = (await request("/api/rooms", { name: "team", botIds: [device.botId] }, cookie)).body.room;
		const base = "/api/rooms/" + room.id + "/conversations";
		const first = await request(base, { targetBotId: device.botId, text: "start", idempotencyKey: "create" }, cookie);
		expect(first.status).toBe(200);
		expect(first.body.task.resume).toBe(false);
		const cid = first.body.conversation.id;
		const turn = await request(base + "/" + cid + "/messages", { text: "continue", idempotencyKey: "next" }, cookie);
		expect(turn.status).toBe(200);
		expect(turn.body.task.resume).toBe(true);
		expect(turn.body.task.rootTaskId).toBe(turn.body.task.id);
		expect(turn.body.task.rootTaskId).not.toBe(first.body.task.id);
		const duplicate = await request(
			base + "/" + cid + "/messages",
			{ text: "continue", idempotencyKey: "next" },
			cookie,
		);
		expect(duplicate.body.task.id).toBe(turn.body.task.id);
		expect(onTask).toHaveBeenCalledTimes(1);
		await hub.acceptTaskEvent(device.deviceId, {
			taskId: first.body.task.id,
			attemptId: first.body.task.attemptId,
			botId: device.botId,
			status: "running",
		});
		await hub.acceptTaskEvent(device.deviceId, {
			taskId: first.body.task.id,
			attemptId: first.body.task.attemptId,
			botId: device.botId,
			status: "completed",
			report: "done",
		});
		expect(onTask).toHaveBeenCalledTimes(2);
		expect((await request(base + "/" + cid, undefined, cookie)).body.messages).toHaveLength(3);
		expect((await request("/api/rooms/" + room.id + "/clear", {}, cookie)).status).toBe(409);
		const persisted = JSON.parse(await readFile(join(dataDir, "device-hub.json"), "utf8"));
		expect(persisted.conversations[0].id).toBe(cid);
		expect(persisted.tasks.every((t: any) => !("context" in t))).toBe(true);
		await hub.store.transact((d) => {
			d.bots[0].revision++;
		});
		expect((await request(base + "/" + cid + "/messages", { text: "stale" }, cookie)).status).toBe(409);
	});
	it("wakes the parent exactly once under its shared root budget", async () => {
		const { hub, request, register, pair, onTask } = await fixture();
		const cookie = await register();
		const a = await pair(cookie, "a"),
			b = await pair(cookie, "b");
		const room = (await request("/api/rooms", { name: "team", botIds: [a.botId, b.botId] }, cookie)).body.room;
		const base = "/api/rooms/" + room.id + "/conversations";
		const parent = (await request(base, { targetBotId: a.botId, text: "parent" }, cookie)).body.task;
		await hub.acceptTaskEvent(a.deviceId, {
			taskId: parent.id,
			attemptId: parent.attemptId,
			botId: a.botId,
			status: "running",
		});
		const headers = { Authorization: "Bearer " + a.credential, "X-Device-Id": a.deviceId };
		expect(
			(
				await request(
					"/api/agent/rooms/" + room.id + "/conversations",
					{ targetBotId: b.botId, text: "bad" },
					"",
					headers,
				)
			).status,
		).toBe(400);
		const child = (
			await request(
				"/api/agent/rooms/" + room.id + "/conversations",
				{ targetBotId: b.botId, text: "child", parentTaskId: parent.id },
				"",
				headers,
			)
		).body.task;
		await hub.acceptTaskEvent(b.deviceId, {
			taskId: child.id,
			attemptId: child.attemptId,
			botId: b.botId,
			status: "running",
		});
		const done = {
			taskId: child.id,
			attemptId: child.attemptId,
			botId: b.botId,
			status: "completed" as const,
			report: "result",
		};
		await hub.acceptTaskEvent(b.deviceId, done);
		await hub.acceptTaskEvent(b.deviceId, done);
		const wake = hub.store.snapshot().tasks.find((t) => t.resultOfTaskId === child.id)!;
		expect(wake.conversationId).toBe(parent.conversationId);
		expect(wake.resume).toBe(true);
		expect(wake.rootTaskId).toBe(parent.id);
		expect(onTask).toHaveBeenCalledTimes(2);
		await hub.acceptTaskEvent(a.deviceId, {
			taskId: parent.id,
			attemptId: parent.attemptId,
			botId: a.botId,
			status: "completed",
			report: "delegated",
		});
		expect(onTask).toHaveBeenCalledTimes(3);
		expect(hub.store.snapshot().tasks.find((t) => t.id === parent.id)?.dispatchCount).toBe(3);
	});
	it("keeps continuation budget finite and validates reply correlation", async () => {
		const { hub, request, register, pair } = await fixture();
		const cookie = await register();
		const a = await pair(cookie, "a"),
			b = await pair(cookie, "b");
		const room = (await request("/api/rooms", { name: "r", botIds: [a.botId, b.botId] }, cookie)).body.room;
		const base = "/api/rooms/" + room.id + "/conversations";
		const initial = (await request(base, { targetBotId: a.botId, text: "start", idempotencyKey: "start" }, cookie))
			.body;
		const cid = initial.conversation.id;
		await hub.acceptTaskEvent(a.deviceId, {
			taskId: initial.task.id,
			attemptId: initial.task.attemptId,
			botId: a.botId,
			status: "running",
		});
		const ah = { Authorization: "Bearer " + a.credential, "X-Device-Id": a.deviceId };
		const bh = { Authorization: "Bearer " + b.credential, "X-Device-Id": b.deviceId };
		const agentBase = "/api/agent/rooms/" + room.id + "/conversations";
		const asked = await request(
			agentBase,
			{ targetBotId: b.botId, text: "question", kind: "request", requestId: "q", parentTaskId: initial.task.id },
			"",
			ah,
		);
		expect(asked.status).toBe(200);
		expect(asked.body.conversation).toMatchObject({
			sourceBotId: a.botId,
			sourceConversationId: initial.conversation.id,
			parentTaskId: initial.task.id,
		});
		const listed = await request(`/api/rooms/${room.id}/conversations`, undefined, cookie);
		expect(listed.body.conversations.find((entry: any) => entry.id === asked.body.conversation.id)).toMatchObject({
			sourceBotId: a.botId,
			sourceConversationId: initial.conversation.id,
			parentTaskId: initial.task.id,
		});
		await hub.acceptTaskEvent(b.deviceId, {
			taskId: asked.body.task.id,
			attemptId: asked.body.task.attemptId,
			botId: b.botId,
			status: "running",
		});
		const reply = {
			text: "answer",
			kind: "reply",
			requestId: "q",
			parentTaskId: asked.body.task.id,
			idempotencyKey: "answer",
		};
		expect(
			(await request(agentBase + "/" + cid + "/messages", { ...reply, requestId: "missing" }, "", bh)).status,
		).toBe(403);
		const answer = await request(agentBase + "/" + cid + "/messages", reply, "", bh);
		expect(answer.status).toBe(200);
		expect((await request(agentBase + "/" + cid + "/messages", reply, "", bh)).body.task.id).toBe(answer.body.task.id);
		expect(
			(await request(agentBase + "/" + cid + "/messages", { ...reply, idempotencyKey: "again" }, "", bh)).status,
		).toBe(409);
		await hub.store.transact((d) => {
			d.tasks.find((t) => t.id === initial.task.id)!.dispatchCount = 16;
		});
		expect(
			(
				await request(
					agentBase + "/" + cid + "/messages",
					{ text: "over budget", parentTaskId: initial.task.id },
					"",
					ah,
				)
			).status,
		).toBe(409);
		for (let i = 0; i < 18; i++) {
			const human = await request(base + "/" + cid + "/messages", { text: "human " + i }, cookie);
			expect(human.status).toBe(200);
			expect(human.body.task.rootTaskId).toBe(human.body.task.id);
			expect(human.body.task.dispatchDepth).toBe(0);
			expect(human.body.task.dispatchCount).toBe(1);
			expect(human.body.task.conversationId).toBe(cid);
		}
		expect(
			(
				await request(
					agentBase + "/" + cid + "/messages",
					{ text: "still exhausted", parentTaskId: initial.task.id },
					"",
					ah,
				)
			).status,
		).toBe(409);
		expect(hub.store.snapshot().conversationMessages.filter((m) => m.kind === "reply")).toHaveLength(1);
		await hub.acceptTaskEvent(b.deviceId, {
			taskId: asked.body.task.id,
			attemptId: asked.body.task.attemptId,
			botId: b.botId,
			status: "completed",
			report: "answered",
		});
		expect(hub.store.snapshot().tasks.some((t) => t.resultOfTaskId === asked.body.task.id)).toBe(false);
		await hub.acceptTaskEvent(a.deviceId, {
			taskId: initial.task.id,
			attemptId: initial.task.attemptId,
			botId: a.botId,
			status: "completed",
			report: "ready for reply",
		});
		await hub.acceptTaskEvent(a.deviceId, {
			taskId: answer.body.task.id,
			attemptId: answer.body.task.attemptId,
			botId: a.botId,
			status: "running",
		});
		await hub.acceptTaskEvent(a.deviceId, {
			taskId: answer.body.task.id,
			attemptId: answer.body.task.attemptId,
			botId: a.botId,
			status: "completed",
			report: "read",
		});
		expect(hub.store.snapshot().tasks.some((t) => t.resultOfTaskId === answer.body.task.id)).toBe(false);
		expect((await request(agentBase + "/" + cid + "/messages", reply, "", bh)).body.task.id).toBe(answer.body.task.id);
	});
	it("replays all targets for a multi-target dispatch receipt", async () => {
		const { request, register, pair, onTask } = await fixture();
		const cookie = await register();
		const a = await pair(cookie, "a"),
			b = await pair(cookie, "b");
		const room = (await request("/api/rooms", { name: "r", botIds: [a.botId, b.botId] }, cookie)).body.room;
		const path = "/api/rooms/" + room.id + "/messages";
		const body = { text: "both", targetBotIds: [a.botId, b.botId], idempotencyKey: "both" };
		const first = await request(path, body, cookie),
			duplicate = await request(path, body, cookie);
		expect(duplicate.body.tasks.map((t: any) => t.id)).toEqual(first.body.tasks.map((t: any) => t.id));
		expect(duplicate.body.tasks).toHaveLength(2);
		expect(onTask).toHaveBeenCalledTimes(2);
	});
	it("notifies the parent for reportless terminal failures exactly once", async () => {
		const { hub, request, register, pair, onTask } = await fixture();
		const cookie = await register();
		const a = await pair(cookie, "a"),
			b = await pair(cookie, "b");
		const room = (await request("/api/rooms", { name: "r", botIds: [a.botId, b.botId] }, cookie)).body.room;
		const parent = (
			await request("/api/rooms/" + room.id + "/conversations", { targetBotId: a.botId, text: "parent" }, cookie)
		).body.task;
		await hub.acceptTaskEvent(a.deviceId, {
			botId: a.botId,
			taskId: parent.id,
			attemptId: parent.attemptId,
			status: "running",
		});
		const child = (
			await request(
				"/api/agent/rooms/" + room.id + "/conversations",
				{ targetBotId: b.botId, text: "child", parentTaskId: parent.id },
				"",
				{ Authorization: "Bearer " + a.credential, "X-Device-Id": a.deviceId },
			)
		).body.task;
		const interrupted = {
			botId: b.botId,
			taskId: child.id,
			attemptId: child.attemptId,
			status: "interrupted" as const,
		};
		await hub.acceptTaskEvent(b.deviceId, interrupted);
		await hub.acceptTaskEvent(b.deviceId, interrupted);
		expect(hub.store.snapshot().tasks.find((t) => t.resultOfTaskId === child.id)?.text).toContain("interrupted");
		expect(onTask).toHaveBeenCalledTimes(2);
		await hub.acceptTaskEvent(a.deviceId, {
			taskId: parent.id,
			attemptId: parent.attemptId,
			botId: a.botId,
			status: "completed",
			report: "delegated",
		});
		expect(onTask).toHaveBeenCalledTimes(3);
	});
	it("closes admission before cancel and keeps unconfirmed work pending", async () => {
		const { hub, request, register, pair } = await fixture();
		const cookie = await register();
		const bot = await pair(cookie);
		const room = (await request("/api/rooms", { name: "r", botIds: [bot.botId] }, cookie)).body.room;
		const base = "/api/rooms/" + room.id + "/conversations";
		const created = (await request(base, { targetBotId: bot.botId, text: "start" }, cookie)).body;
		const path = base + "/" + created.conversation.id;
		const queued = (await request(path + "/messages", { text: "queued answer" }, cookie)).body.task;
		expect((await request(path + "/stop", {}, cookie)).body).toEqual({ stopped: false, pending: 1 });
		expect(hub.store.snapshot().tasks.find((task) => task.id === queued.id)).toMatchObject({
			status: "interrupted",
			cancelRequested: true,
			stopConfirmed: true,
		});
		await hub.acceptTaskEvent(bot.deviceId, {
			botId: bot.botId,
			taskId: created.task.id,
			attemptId: created.task.attemptId,
			status: "running",
		});
		await hub.acceptTaskEvent(bot.deviceId, {
			botId: bot.botId,
			taskId: created.task.id,
			attemptId: created.task.attemptId,
			status: "failed",
		});
		expect((await request(path + "/stop", {}, cookie)).body).toEqual({ stopped: false, pending: 1 });
		expect((await request(path + "/messages", { text: "too late" }, cookie)).status).toBe(409);
		expect((await request("/api/rooms/" + room.id + "/clear", {}, cookie)).status).toBe(409);
		hub.setRelay({ cancelTask: async () => ({ stopped: true }) });
		expect((await request(path + "/stop", {}, cookie)).body).toEqual({ stopped: true, pending: 0 });
		expect(hub.store.snapshot().tasks[0].status).toBe("interrupted");
		expect((await request("/api/rooms/" + room.id + "/clear", {}, cookie)).status).toBe(200);
	});
	it("interrupts pending and uncertain tasks after restart without executing again", async () => {
		const { request, register, pair, dataDir } = await fixture();
		const cookie = await register();
		const bot = await pair(cookie);
		const room = (await request("/api/rooms", { name: "r", botIds: [bot.botId] }, cookie)).body.room;
		await request("/api/rooms/" + room.id + "/conversations", { targetBotId: bot.botId, text: "pending" }, cookie);
		const reopened = await DeviceHubStore.open(dataDir);
		expect(reopened.snapshot().tasks[0].status).toBe("interrupted");
		expect(reopened.snapshot().conversations).toHaveLength(1);
	});
});
