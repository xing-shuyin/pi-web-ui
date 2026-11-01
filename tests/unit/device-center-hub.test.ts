import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { createDeviceHub } from "../../server/device-center/hub.js";
import { DeviceHubStore, hashSecret } from "../../server/device-center/store.js";

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

describe("device center hub", () => {
	it("routes unmentioned human messages to the primary Bot while preserving explicit targets and retries", async () => {
		const { hub, request, register, pair } = await fixture();
		const cookie = await register();
		const first = await pair(cookie, "Primary");
		const second = await pair(cookie, "Other");
		const botIds = [first.botId, second.botId];
		expect((await request("/api/rooms", { name: "Invalid", botIds, primaryBotId: "outsider" }, cookie)).status).toBe(
			400,
		);
		const created = await request("/api/rooms", { name: "Team", botIds, primaryBotId: first.botId }, cookie);
		expect(created.status).toBe(201);
		const path = `/api/rooms/${created.body.room.id}`;
		expect((await request(path, undefined, cookie)).body.room.primaryBotId).toBe(first.botId);
		const body = { text: "Hello", idempotencyKey: "implicit" };
		const implicit = await request(`${path}/messages`, body, cookie);
		expect(implicit.status).toBe(200);
		expect(implicit.body.tasks.map((t: any) => t.botId)).toEqual([first.botId]);
		const followup = await request(`${path}/messages`, { text: "Follow up" }, cookie);
		expect(followup.body.tasks[0].conversationId).toBe(implicit.body.tasks[0].conversationId);
		expect(followup.body.tasks[0].resume).toBe(true);
		const explicit = await request(`${path}/messages`, { text: "Other", targetBotIds: [second.botId] }, cookie);
		expect(explicit.body.tasks.map((t: any) => t.botId)).toEqual([second.botId]);
		const botReply = await request(`/api/agent/rooms/${created.body.room.id}/messages`, { text: "Public reply" }, "", {
			Authorization: `Bearer ${first.credential}`,
			"X-Device-Id": first.deviceId,
		});
		expect(botReply.status).toBe(200);
		expect(botReply.body.tasks).toEqual([]);
		expect((await request(`${path}/members`, { botIds, primaryBotId: "outsider" }, cookie)).status).toBe(400);
		expect((await request(`${path}/members`, { botIds, primaryBotId: second.botId }, cookie)).status).toBe(200);
		const replay = await request(`${path}/messages`, body, cookie);
		expect(replay.status).toBe(200);
		expect(replay.body.message.id).toBe(implicit.body.message.id);
		expect(replay.body.tasks[0].id).toBe(implicit.body.tasks[0].id);
		expect(replay.body.tasks.map((t: any) => t.botId)).toEqual([first.botId]);
		expect((await request(`${path}/members`, { botIds, primaryBotId: null }, cookie)).status).toBe(200);
		expect((await request(`${path}/messages`, { text: "Public only" }, cookie)).body.tasks).toEqual([]);
		await hub.store.transact((draft) => {
			for (const task of draft.tasks) task.status = "completed";
		});
		await request(`${path}/members`, { botIds, primaryBotId: second.botId }, cookie);
		expect(
			(await request(`${path}/members`, { botIds: [first.botId] }, cookie)).body.room.primaryBotId,
		).toBeUndefined();
	});
	it("clears only the authorized room history atomically, preserves membership and rejects active tasks", async () => {
		const { hub, request, register, pair, dataDir } = await fixture();
		const cookie = await register();
		const device = await pair(cookie);
		const otherCookie = await register("bob");
		const room = (await request("/api/rooms", { name: "Team", botIds: [device.botId] }, cookie)).body.room;
		const otherRoom = (await request("/api/rooms", { name: "Other", botIds: [device.botId] }, cookie)).body.room;
		for (const id of [room.id, otherRoom.id])
			await request(`/api/rooms/${id}/messages`, { text: "history", idempotencyKey: "history" }, cookie);
		await hub.store.transact((state) => {
			for (const id of [room.id, otherRoom.id])
				state.tasks.push({
					id,
					attemptId: "attempt",
					roomId: id,
					accountId: room.accountId,
					botId: device.botId,
					botRevision: 1,
					deviceId: device.deviceId,
					text: "task",
					status: "queued",
					createdAt: 1,
					updatedAt: 1,
				});
		});
		const before = hub.store.snapshot();
		expect((await request(`/api/rooms/${room.id}/clear`, {}, otherCookie)).status).toBe(404);
		expect(
			(
				await request(`/api/agent/rooms/${room.id}/clear`, {}, "", {
					Authorization: `Bearer ${device.credential}`,
					"X-Device-Id": device.deviceId,
				})
			).status,
		).toBe(404);
		for (const status of ["queued", "running"] as const) {
			await hub.store.transact((state) => {
				state.tasks.find((task) => task.roomId === room.id)!.status = status;
			});
			const response = await request(`/api/rooms/${room.id}/clear`, {}, cookie);
			expect(response.status).toBe(409);
			expect(response.body.code).toBe("ACTIVE_TASKS");
			expect(hub.store.snapshot().messages).toEqual(before.messages);
		}
		await hub.store.transact((state) => {
			state.tasks.find((task) => task.roomId === room.id)!.status = "completed";
		});
		await hub.store.transact((state) => {
			state.devices.find((entry) => entry.id === device.deviceId)!.uiCredentialHash = hashSecret("clear-ui");
		});
		const response = await request(`/api/device-user/rooms/${room.id}/clear`, {}, "", {
			Authorization: "Bearer clear-ui",
			"X-Device-Id": device.deviceId,
		});
		expect(response.status).toBe(200);
		expect(response.body).toEqual({ cleared: true });
		const after = hub.store.snapshot();
		expect(after.rooms).toEqual(before.rooms);
		for (const key of ["messages", "tasks", "receipts"] as const) {
			expect(after[key].filter((entry) => entry.roomId === room.id)).toEqual([]);
			expect(after[key].filter((entry) => entry.roomId === otherRoom.id)).toEqual(
				before[key].filter((entry) => entry.roomId === otherRoom.id),
			);
		}
		const restored = await DeviceHubStore.open(dataDir);
		const recovered = restored.snapshot();
		expect(recovered.tasks.every((task) => task.status === "interrupted")).toBe(true);
		expect({ ...recovered, tasks: after.tasks }).toEqual(after);
		expect((await request(`/api/rooms/${room.id}/clear`, {}, cookie)).status).toBe(200);
		expect(
			(await request(`/api/rooms/${room.id}/messages`, { text: "new message", idempotencyKey: "history" }, cookie))
				.status,
		).toBe(200);
	});
	it("freezes identical context for parallel recipients and never persists context copies", async () => {
		const { hub, request, register, pair, onTask } = await fixture();
		const cookie = await register();
		const first = await pair(cookie);
		const second = await pair(cookie, "Linux");
		const room = (await request("/api/rooms", { name: "Parallel", botIds: [first.botId, second.botId] }, cookie)).body
			.room;
		await request(`/api/rooms/${room.id}/messages`, { text: "Shared requirements" }, cookie);
		onTask.mockImplementation(async (_deviceId, task) => {
			expect(task.context.messages.map((message: { text: string }) => message.text)).toEqual(["Shared requirements"]);
			if (task.botId === first.botId)
				await hub.store.transact((state) => {
					state.messages.push({
						id: "fast-answer",
						accountId: room.accountId,
						roomId: room.id,
						text: "Do not leak to sibling",
						sender: { type: "bot", id: first.botId, name: "Windows" },
						createdAt: Date.now(),
						taskIds: [task.id],
					});
				});
			return true;
		});
		await request(
			`/api/rooms/${room.id}/messages`,
			{ text: "Review independently", targetBotIds: [first.botId, second.botId] },
			cookie,
		);
		expect(onTask).toHaveBeenCalledTimes(2);
		expect(onTask.mock.calls[0][1].context).toEqual(onTask.mock.calls[1][1].context);
		expect(onTask.mock.calls[1][1].context.messages.map((message: { text: string }) => message.text)).toEqual([
			"Shared requirements",
		]);
		for (const task of hub.store.snapshot().tasks) expect(task).not.toHaveProperty("context");
		await hub.store.transact((state) => {
			for (const task of state.tasks) task.status = "completed";
		});
		expect((await request(`/api/rooms/${room.id}/clear`, {}, cookie)).status).toBe(200);
		onTask.mockImplementation(async (_deviceId, task) => {
			expect(task.context.messages).toEqual([]);
			return true;
		});
		await request(`/api/rooms/${room.id}/messages`, { text: "Fresh start", targetBotIds: [first.botId] }, cookie);
		expect(onTask.mock.calls.at(-1)![1].context.messages).toEqual([]);
	});
	it("shares pre-dispatch context and permits history reads only from an enabled member Bot", async () => {
		const { hub, request, register, pair, onTask } = await fixture();
		const cookie = await register();
		const member = await pair(cookie);
		const outsider = await pair(cookie, "outsider");
		const room = (await request("/api/rooms", { name: "Discussion", botIds: [member.botId] }, cookie)).body.room;
		await request(`/api/rooms/${room.id}/messages`, { text: "Earlier plan: use SQLite" }, cookie);
		onTask.mockImplementation(async (_deviceId, task) => {
			expect(task.context.messages.map((message: { text: string }) => message.text)).toEqual([
				"Earlier plan: use SQLite",
			]);
			expect(task.context.members).toEqual([{ id: member.botId, name: "Windows" }]);
			return true;
		});
		await request(`/api/rooms/${room.id}/messages`, { text: "Review that plan", targetBotIds: [member.botId] }, cookie);
		expect(onTask).toHaveBeenCalledOnce();
		const headers = (device: typeof member) => ({
			Authorization: `Bearer ${device.credential}`,
			"X-Device-Id": device.deviceId,
		});
		const path = `/api/agent/rooms/${room.id}/history?sourceBotId=`;
		const page = await request(path + member.botId, undefined, "", headers(member));
		expect(page.status).toBe(200);
		expect(page.body.messages.map((message: { text: string }) => message.text)).toEqual([
			"Earlier plan: use SQLite",
			"Review that plan",
		]);
		expect(JSON.stringify(page.body)).not.toContain("accountId");
		expect((await request(path + outsider.botId, undefined, "", headers(outsider))).status).toBe(404);
		expect((await request(path + outsider.botId, undefined, "", headers(member))).status).toBe(404);
		expect((await request(`/api/rooms/${room.id}/history`, undefined, cookie)).status).toBe(403);
		await hub.store.transact((state) => {
			state.bots.find((bot) => bot.id === member.botId)!.enabled = false;
		});
		expect((await request(path + member.botId, undefined, "", headers(member))).status).toBe(404);
	});
	it("syncs stable Bot identities atomically, rejects impersonation and stale revisions", async () => {
		const f = await fixture();
		const cookie = await f.register();
		const first = await f.pair(cookie);
		const second = await f.pair(cookie, "Linux");
		const headers = (d: typeof first) => ({ Authorization: `Bearer ${d.credential}`, "X-Device-Id": d.deviceId });
		const bot = { id: first.botId, name: "Windows", description: "test Bot", enabled: true, revision: 1 };
		const sync = (d: typeof first, bots: unknown[]) => f.request("/api/agent/bots", { bots }, "", headers(d), "PUT");
		expect((await sync(first, [bot])).status).toBe(200);
		expect((await sync(second, [bot])).status).toBe(403);
		expect((await sync(first, [{ ...bot, name: "changed" }])).status).toBe(409);
		expect((await sync(first, [{ ...bot, revision: 2, name: "changed" }])).status).toBe(200);
		expect((await sync(first, [bot])).status).toBe(409);
		const listed = await f.request("/api/device-user/bots", undefined, "", {
			Authorization: "Bearer invalid",
			"X-Device-Id": first.deviceId,
		});
		expect(listed.status).toBe(401);
		const publicBots = (await f.request("/api/bots", undefined, cookie)).body.bots;
		expect(publicBots).toHaveLength(2);
		expect(publicBots.find((bot: any) => bot.id === second.botId)).toMatchObject({ deviceName: "Linux" });
		const room = (await f.request("/api/rooms", { name: "Bots", botIds: [first.botId, second.botId] }, cookie)).body
			.room;
		const roomDetail = await f.request(`/api/rooms/${room.id}`, undefined, cookie);
		expect(roomDetail.body.bots.find((bot: any) => bot.id === second.botId)).toMatchObject({ deviceName: "Linux" });
		const path = `/api/agent/rooms/${room.id}/messages`;
		expect((await f.request(path, { text: "forged", sourceBotId: second.botId }, "", headers(first))).status).toBe(403);
		const task = (
			await f.request(`/api/rooms/${room.id}/messages`, { text: "work", targetBotIds: [first.botId] }, cookie)
		).body.tasks[0];
		await expect(
			f.hub.acceptTaskEvent(first.deviceId, {
				taskId: task.id,
				attemptId: task.attemptId,
				botId: second.botId,
				status: "running",
			}),
		).rejects.toThrow("Task missing");
		const blocked = await sync(first, []);
		expect(blocked.status).toBe(409);
		expect(blocked.body.code).toBe("ACTIVE_TASKS");
		expect((await sync(first, [{ ...bot, revision: 3 }])).status).toBe(409);
		await expect(
			f.hub.acceptTaskEvent(first.deviceId, {
				taskId: task.id,
				attemptId: task.attemptId,
				botId: first.botId,
				status: "interrupted",
			}),
		).resolves.toMatchObject({ status: "interrupted" });
		expect((await sync(first, [])).status).toBe(200);
		expect((await f.request(path, { text: "disabled" }, "", headers(first))).status).toBe(403);
	});
	it("provides a stable path for every owned device without requiring an alias", async () => {
		const assign = vi.fn(async () => ({}));
		const f = await fixture("https://hub.test", "devices.test", {
			portals: { assign, getOrigin: () => undefined, getAlias: () => undefined } as any,
		});
		const owner = await f.register("device-owner");
		const other = await f.register("other-owner");
		const first = await f.pair(owner, "Mac");
		const second = await f.pair(owner, "Linux");
		f.hub.setRelay({
			handleAliasOpen: async (_req, res, id) => {
				res.setHeader("Content-Type", "application/json");
				res.end(JSON.stringify({ opened: id }));
			},
		});
		for (const device of [first, second]) {
			const opened = await f.request(`/device/${device.deviceId}`, undefined, owner);
			expect(opened.status).toBe(200);
			expect(opened.body.opened).toBe(device.deviceId);
			expect(assign).toHaveBeenCalledWith(device.deviceId, expect.any(String));
		}
		expect((await f.request(`/device/${first.deviceId}`, undefined, other)).status).toBe(404);
	});
	it("supports public IP HTTP accounts, pairing and tasks without device web access", async () => {
		const { request, register, pair, onTask } = await fixture("http://82.156.246.55:8790", "");
		expect((await request("/api/info")).body).toEqual({ transport: "http", deviceWebAccess: false });
		expect((await request("/api/info", undefined, "", { Host: "evil.test" })).status).toBe(421);
		const cookie = await register();
		expect(cookie).toMatch(/^device_hub=/);
		expect((await request("/api/auth/login", { username: "alice", password: "a-test-password" })).status).toBe(200);
		const device = await pair(cookie);
		expect((await request("/api/devices", undefined, cookie)).body.devices[0].url).toBeNull();
		expect((await request("/api/rooms", { name: "bad" }, cookie, { Origin: "http://evil.test" })).status).toBe(403);
		const room = await request("/api/rooms", { name: "public HTTP", botIds: [device.botId] }, cookie);
		expect(room.status).toBe(201);
		const message = await request(
			`/api/rooms/${room.body.room.id}/messages`,
			{ text: "test", targetBotIds: [device.botId], requestId: "http-ip-task" },
			cookie,
		);
		expect(message.status).toBe(200);
		expect(onTask).toHaveBeenCalled();
	});
	it("isolates accounts, checks Origin, authenticates salted passwords and clears sessions", async () => {
		const { hub, request, register, pair, dataDir } = await fixture();
		const alice = await register();
		const bob = await register("bob");
		expect((await request("/api/me", undefined, alice)).body.account.username).toBe("alice");
		expect((await request("/api/me")).status).toBe(401);
		expect((await request("/api/auth/login", { username: "alice", password: "wrong" })).status).toBe(401);
		expect((await request("/api/auth/login", { username: "alice", password: "a-test-password" })).status).toBe(200);
		expect((await request("/api/rooms", { name: "bad" }, alice, { Origin: "https://evil.test" })).status).toBe(403);
		const device = await pair(alice);
		expect((await request("/api/devices", undefined, bob)).body.devices).toEqual([]);
		expect((await request("/api/rooms", { name: "stolen", botIds: [device.botId] }, bob)).status).toBe(400);
		expect(await hub.store.authenticateDevice(device.deviceId, device.credential)).toBe(true);
		const raw = await readFile(join(dataDir, "device-hub.json"), "utf8");
		expect(raw).not.toContain(device.credential);
		expect(raw).not.toContain("a-test-password");
		expect(hub.store.snapshot().accounts[0].passwordHash).toMatch(/^scrypt:/);
		expect((await request("/api/auth/logout", {}, alice)).status).toBe(200);
		expect((await request("/api/me", undefined, alice)).status).toBe(401);
	});
	it("expires pair grants, consumes them once and revokes credentials and callbacks", async () => {
		const { hub, request, register, pair, onRevoke } = await fixture();
		const cookie = await register();
		const start = await request("/api/pair/start", { name: "Mac" });
		expect((await request("/api/pair/poll", { pollToken: start.body.pollToken })).status).toBe(202);
		const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 11 * 60000);
		expect((await request("/api/pair/approve", { code: start.body.code }, cookie)).status).toBe(404);
		clock.mockRestore();
		const device = await pair(cookie);
		expect((await request("/api/pair/poll", { pollToken: device.start.pollToken })).status).toBe(404);
		expect((await request(`/api/devices/${device.deviceId}/revoke`, {}, cookie)).status).toBe(200);
		expect(await hub.store.authenticateDevice(device.deviceId, device.credential)).toBe(false);
		expect(onRevoke).toHaveBeenCalledWith(device.deviceId);
	});
	it("persists rejected and failed report metadata without fabricating a full report", async () => {
		const { hub, request, register, pair, dataDir } = await fixture();
		const cookie = await register();
		const device = await pair(cookie);
		const room = (await request("/api/rooms", { name: "Report states", botIds: [device.botId] }, cookie)).body.room;
		const send = async (text: string) =>
			(await request(`/api/rooms/${room.id}/messages`, { text, targetBotIds: [device.botId] }, cookie)).body.tasks[0];
		const task = await send("quota report");
		const running = { botId: device.botId, taskId: task.id, attemptId: task.attemptId, status: "running" as const };
		await hub.acceptTaskEvent(device.deviceId, running);
		const reportMetadata = {
			sha256: "a".repeat(64),
			totalBytes: 4 * 1024 * 1024 + 1,
			missing: true,
			rejected: true,
			uploadPending: false,
			publicError: "report_quota_exceeded" as const,
		};
		await hub.acceptTaskEvent(device.deviceId, {
			...running,
			status: "completed",
			report: "Execution succeeded; full report exceeded quota",
			reportMetadata,
		});
		const response = await request(`/api/rooms/${room.id}/tasks/${task.id}/report`, undefined, cookie);
		expect(response.status).toBe(200);
		expect(response.body.meta).toMatchObject({ ...reportMetadata, complete: false, quotaExceeded: true });
		expect(response.body.text).toBeUndefined();
		const reopened = await DeviceHubStore.open(dataDir);
		expect(reopened.snapshot().tasks.find((entry) => entry.id === task.id)?.reportMetadata).toEqual(reportMetadata);
		await reopened.close();
		const failedTask = await send("failed report");
		await hub.acceptTaskEvent(device.deviceId, { ...running, taskId: failedTask.id, attemptId: failedTask.attemptId });
		await hub.acceptTaskEvent(device.deviceId, {
			...running,
			taskId: failedTask.id,
			attemptId: failedTask.attemptId,
			status: "failed",
			report: "Execution interrupted",
		});
		const missing = await request(`/api/rooms/${room.id}/tasks/${failedTask.id}/report`, undefined, cookie);
		expect(missing.body.meta).toMatchObject({
			complete: false,
			missing: true,
			uploadPending: false,
			rejected: false,
			publicError: "report_missing",
		});
		expect(missing.body.text).toBeUndefined();
		await expect(
			hub.acceptTaskEvent(device.deviceId, {
				...running,
				taskId: failedTask.id,
				attemptId: failedTask.attemptId,
				status: "failed",
				reportMetadata: { ...reportMetadata, publicError: "private token" } as any,
			}),
		).rejects.toThrow("Invalid report metadata");
	});
	it("serves an empty journal page instead of 404 for tasks that never wrote audit events", async () => {
		const { hub, request, register, pair } = await fixture();
		const cookie = await register();
		const device = await pair(cookie);
		const room = (await request("/api/rooms", { name: "Audit", botIds: [device.botId] }, cookie)).body.room;
		const task = (
			await request(`/api/rooms/${room.id}/messages`, { text: "audit", targetBotIds: [device.botId] }, cookie)
		).body.tasks[0];
		const empty = await request(`/api/rooms/${room.id}/tasks/${task.id}/journal`, undefined, cookie);
		expect(empty.status).toBe(200);
		expect(empty.body).toEqual({
			taskId: task.id,
			items: [],
			hasMore: false,
			totalEvents: 0,
			truncated: false,
			droppedCount: 0,
			journalUnavailable: false,
		});
		// Unknown tasks and foreign rooms stay 404 — the empty page never widens access.
		expect((await request(`/api/rooms/${room.id}/tasks/unknown-task/journal`, undefined, cookie)).status).toBe(404);
		expect((await request(`/api/rooms/foreign-room/tasks/${task.id}/journal`, undefined, cookie)).status).toBe(404);
		// Real progress turns the same empty page into a populated one.
		await hub.acceptTaskEvent(device.deviceId, {
			botId: device.botId,
			taskId: task.id,
			attemptId: task.attemptId,
			status: "running",
		});
		hub.acceptTaskProgress(device.deviceId, {
			taskId: task.id,
			botId: device.botId,
			attemptId: task.attemptId,
			sequence: 1,
			phase: "tool",
			toolName: "read",
			text: "reading files",
		});
		const populated = await vi.waitFor(async () => {
			const page = await request(`/api/rooms/${room.id}/tasks/${task.id}/journal`, undefined, cookie);
			if (page.body.items.length === 0) throw new Error("journal not appended yet");
			return page;
		});
		expect(populated.body.items.map((item: { type: string }) => item.type)).toEqual(["status", "progress"]);
		expect(populated.body.items[1]).toMatchObject({ type: "progress", toolName: "read" });
	});
	it("dispatches only explicit room targets, enforces attempts and transitions, persists trusted reports", async () => {
		const { hub, request, register, pair, onTask, dataDir } = await fixture();
		const cookie = await register();
		const device = await pair(cookie);
		const room = (await request("/api/rooms", { name: "Win Mac Linux", botIds: [device.botId] }, cookie)).body.room;
		const path = `/api/rooms/${room.id}/messages`;
		await request(path, { text: "@Windows hello", sender: "fake" }, cookie);
		expect(onTask).not.toHaveBeenCalled();
		const payload = {
			text: "test on Mac",
			targetBotIds: [device.botId],
			idempotencyKey: "work-1",
			handoff: { repository: "https://github.com/test/repo", commit: "abcdef", instructions: "Run the real test" },
		};
		const result = await request(path, payload, cookie);
		const task = result.body.tasks[0];
		expect(result.status).toBe(200);
		expect((await request(path, payload, cookie)).body.tasks[0].id).toBe(task.id);
		expect(onTask).toHaveBeenCalledTimes(1);
		expect((await request(path, { ...payload, text: "different" }, cookie)).status).toBe(409);
		expect((await request(path, { text: "follow", parentTaskId: task.id }, cookie)).status).toBe(400);
		await expect(
			hub.acceptTaskEvent(device.deviceId, {
				botId: device.botId,
				taskId: task.id,
				attemptId: "wrong",
				status: "running",
			}),
		).rejects.toThrow("Task missing");
		await expect(
			hub.acceptTaskEvent(device.deviceId, {
				botId: device.botId,
				taskId: task.id,
				attemptId: task.attemptId,
				status: "completed",
				report: "fake",
			}),
		).rejects.toThrow("Invalid task transition");
		const running = { botId: device.botId, taskId: task.id, attemptId: task.attemptId, status: "running" as const };
		await hub.acceptTaskEvent(device.deviceId, running);
		await hub.acceptTaskEvent(device.deviceId, running);
		await expect(hub.acceptTaskEvent(device.deviceId, { ...running, status: "completed" })).rejects.toThrow(
			"requires agent report",
		);
		const completed = { ...running, status: "completed" as const, report: "Actual agent test output: 7 tests passed." };
		await hub.acceptTaskEvent(device.deviceId, completed);
		await hub.acceptTaskEvent(device.deviceId, completed);
		expect(onTask).toHaveBeenCalledTimes(1);
		const state = (await request(`/api/rooms/${room.id}`, undefined, cookie)).body;
		expect(state.messages.at(-1).sender).toEqual({
			type: "bot",
			id: device.botId,
			name: "Windows",
			sourceDeviceId: device.deviceId,
		});
		expect(state.tasks[0].report).toBe(completed.report);
		expect(
			(await request(path, { text: "Linux next", parentTaskId: task.id, targetBotIds: [device.botId] }, cookie)).status,
		).toBe(200);
		const task2 = hub.store.snapshot().tasks[1];
		await hub.acceptTaskEvent(device.deviceId, {
			botId: device.botId,
			taskId: task2.id,
			attemptId: task2.attemptId,
			status: "running",
		});
		const reopened = await DeviceHubStore.open(dataDir);
		expect(reopened.snapshot().tasks[1].status).toBe("interrupted");
		await reopened.close();
	});
	it("does not publish failed writes; concurrent transactions remain serial and recover", async () => {
		const { hub, register, request, pair } = await fixture();
		const cookie = await register();
		const device = await pair(cookie);
		const before = hub.store.snapshot();
		const persist = vi.spyOn(hub.store, "persist").mockRejectedValueOnce(new Error("disk full"));
		expect((await request("/api/rooms", { name: "lost", botIds: [device.botId] }, cookie)).status).toBe(500);
		expect(hub.store.snapshot()).toEqual(before);
		persist.mockRestore();
		await Promise.all([
			request("/api/rooms", { name: "one", botIds: [device.botId] }, cookie),
			request("/api/rooms", { name: "two", botIds: [device.botId] }, cookie),
		]);
		expect(hub.store.snapshot().rooms.map((r) => r.name)).toEqual(["one", "two"]);
	});
	it("authenticates agent routes without cookie fallback and records trusted device sender", async () => {
		const { hub, request, register, pair } = await fixture();
		const cookie = await register();
		const device = await pair(cookie);
		const headers = {
			Authorization: `Bearer ${device.credential}`,
			"X-Device-Id": device.deviceId,
			Origin: "https://elsewhere.test",
		};
		expect((await request("/api/agent/devices", undefined, cookie)).status).toBe(401);
		expect((await request("/api/agent/devices", undefined, "", headers)).status).toBe(200);
		const room = (
			await request("/api/agent/rooms", { name: "Agent", botIds: [device.botId], accountId: "forged" }, "", headers)
		).body.room;
		const result = await request(
			`/api/agent/rooms/${room.id}/messages`,
			{ text: "actual device", sender: { name: "forged" } },
			"",
			headers,
		);
		expect(result.status).toBe(200);
		expect(result.body.message.sender).toEqual({
			type: "bot",
			id: device.botId,
			name: "Windows",
			sourceDeviceId: device.deviceId,
		});
		await request(`/api/devices/${device.deviceId}/revoke`, {}, cookie);
		expect((await request("/api/agent/devices", undefined, "", headers)).status).toBe(401);
		expect(hub.store.getDeviceOwner(device.deviceId)).toBeUndefined();
	});
	it("bounds device handoff chains by trusted parent, persistent root budget and depth", async () => {
		const { hub, request, register, pair } = await fixture();
		const cookie = await register();
		const device = await pair(cookie);
		const other = await pair(cookie, "Mac");
		const room = (await request("/api/rooms", { name: "chain", botIds: [device.botId, other.botId] }, cookie)).body
			.room;
		const headers = { Authorization: `Bearer ${device.credential}`, "X-Device-Id": device.deviceId };
		const path = `/api/agent/rooms/${room.id}/messages`;
		expect((await request(`/api/agent/rooms/${room.id}`, undefined, "", headers)).status).toBe(200);
		expect((await request(path, { text: "no root", targetBotIds: [other.botId] }, "", headers)).status).toBe(400);
		const root = (
			await request(`/api/rooms/${room.id}/messages`, { text: "start", targetBotIds: [device.botId] }, cookie)
		).body.tasks[0];
		expect(
			(await request(path, { text: "queued parent", targetBotIds: [other.botId], parentTaskId: root.id }, "", headers))
				.status,
		).toBe(400);
		await hub.acceptTaskEvent(device.deviceId, {
			botId: device.botId,
			taskId: root.id,
			attemptId: root.attemptId,
			status: "running",
		});
		const dispatched = await request(
			path,
			{ text: "handoff now", targetBotIds: [other.botId], parentTaskId: root.id },
			"",
			headers,
		);
		expect(dispatched.status).toBe(200);
		expect(dispatched.body.tasks[0]).toMatchObject({ rootTaskId: root.id, dispatchDepth: 1 });
		const otherHeaders = { Authorization: `Bearer ${other.credential}`, "X-Device-Id": other.deviceId };
		expect(
			(
				await request(
					path,
					{ text: "forged parent", targetBotIds: [device.botId], parentTaskId: root.id },
					"",
					otherHeaders,
				)
			).status,
		).toBe(400);
		await hub.store.transact((draft) => {
			draft.tasks.find((t) => t.id === root.id)!.dispatchCount = 16;
		});
		expect(
			(await request(path, { text: "budget", targetBotIds: [other.botId], parentTaskId: root.id }, "", headers)).status,
		).toBe(409);
		await hub.store.transact((draft) => {
			const t = draft.tasks.find((t) => t.id === root.id)!;
			t.dispatchCount = 2;
			t.dispatchDepth = 8;
		});
		expect(
			(await request(path, { text: "depth", targetBotIds: [other.botId], parentTaskId: root.id }, "", headers)).status,
		).toBe(409);
	});
	it("does not publish when atomic rename fails and recovers the transaction queue", async () => {
		const { hub, register, request, pair } = await fixture();
		const cookie = await register();
		const device = await pair(cookie);
		const before = hub.store.snapshot();
		await rm(hub.store.path);
		await mkdir(hub.store.path);
		expect((await request("/api/rooms", { name: "rename fails", botIds: [device.botId] }, cookie)).status).toBe(500);
		expect(hub.store.snapshot()).toEqual(before);
		await rm(hub.store.path, { recursive: true });
		expect((await request("/api/rooms", { name: "recovered", botIds: [device.botId] }, cookie)).status).toBe(201);
	});
	it("approves concurrent pair requests at most once and exposes the relay open route", async () => {
		const { hub, register, request } = await fixture();
		const cookie = await register();
		const start = await request("/api/pair/start", { name: "Mac" });
		const replies = await Promise.all([
			request("/api/pair/approve", { code: start.body.code }, cookie),
			request("/api/pair/approve", { code: start.body.code }, cookie),
		]);
		expect(replies.map((r) => r.status).sort()).toEqual([200, 409]);
		expect(hub.store.snapshot().devices).toHaveLength(1);
		const handleOpen = vi.fn(async (_req, res) => {
			res.json({ url: "https://device.test", expiresAt: 1 });
		});
		hub.setRelay({ handleOpen });
		const id = hub.store.snapshot().devices[0].id;
		expect((await request(`/api/devices/${id}/open`, {}, cookie)).body.url).toBe("https://device.test");
		expect(handleOpen).toHaveBeenCalledTimes(1);
	});
	it("limits login attempts and JSON payload size", async () => {
		const { request } = await fixture();
		for (let i = 0; i < 10; i++) await request("/api/auth/login", { username: "missing", password: "wrong-password" });
		expect((await request("/api/auth/login", { username: "missing", password: "wrong-password" })).status).toBe(429);
		expect((await request("/api/pair/start", { name: "x".repeat(33000) })).status).toBe(413);
	});
});
