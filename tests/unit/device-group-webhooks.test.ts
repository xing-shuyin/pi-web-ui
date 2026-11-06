import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request as httpRequest } from "node:http";
import { createHmac } from "node:crypto";
import { createDeviceHub } from "../../server/device-center/hub.js";
import {
	createWebhookToken,
	dispatchGroupWebhook,
	secureCompareTokens,
	testOutgoingWebhook,
	validateWebhookInput,
} from "../../server/device-center/hub-webhooks.js";
import type { DeviceHubStore } from "../../server/device-center/store.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	vi.useRealTimers();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("group webhook validation and security", () => {
	it("validates incoming and outgoing webhook inputs correctly", () => {
		const incoming = validateWebhookInput({
			name: "GitHub Actions",
			type: "incoming",
			allowBotTrigger: true,
		});
		expect(incoming.name).toBe("GitHub Actions");
		expect(incoming.type).toBe("incoming");
		expect(incoming.enabled).toBe(true);
		expect(incoming.allowBotTrigger).toBe(true);

		const outgoing = validateWebhookInput({
			name: "Feishu Alert",
			type: "outgoing",
			url: "https://open.feishu.cn/webhook/v2/xxx",
			secret: "my-secret-key",
			events: ["message", "task_completed"],
			relayViaHub: false,
		});
		expect(outgoing.name).toBe("Feishu Alert");
		expect(outgoing.type).toBe("outgoing");
		expect(outgoing.url).toBe("https://open.feishu.cn/webhook/v2/xxx");
		expect(outgoing.secret).toBe("my-secret-key");
		expect(outgoing.events).toEqual(["message", "task_completed"]);
		expect(outgoing.relayViaHub).toBe(false);

		const defaultRelay = validateWebhookInput({
			name: "DingTalk",
			type: "outgoing",
			url: "https://oapi.dingtalk.com/robot/send",
		});
		expect(defaultRelay.relayViaHub).toBe(true);

		expect(() => validateWebhookInput({ name: "" })).toThrow(/name must be 1-80 characters/i);
		expect(() => validateWebhookInput({ name: "A", type: "outgoing" })).toThrow(/target url is required/i);
		expect(() => validateWebhookInput({ name: "A", type: "outgoing", url: "ftp://invalid" })).toThrow(
			/target url must be a valid http or https url/i,
		);
		expect(() => validateWebhookInput({ name: "A", type: "incoming", events: ["invalid_event" as any] })).toThrow(
			/invalid webhook events/i,
		);
	});

	it("generates tokens and performs timing-safe comparison", () => {
		const token = createWebhookToken();
		expect(typeof token).toBe("string");
		expect(token.length).toBe(48);
		expect(secureCompareTokens(token, token)).toBe(true);
		expect(secureCompareTokens(token, token + "x")).toBe(false);
		expect(secureCompareTokens(token, "wrong-token")).toBe(false);
	});
});

describe("outgoing webhook dispatching", () => {
	it("dispatches webhook events with signature and handles ping test", async () => {
		const receivedRequests: { event: string; signature?: string; body: any }[] = [];

		const targetServer = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (chunk) => chunks.push(chunk));
			req.on("end", () => {
				const bodyStr = Buffer.concat(chunks).toString("utf8");
				receivedRequests.push({
					event: String(req.headers["x-pi-event"]),
					signature: req.headers["x-pi-signature"] as string | undefined,
					body: JSON.parse(bodyStr),
				});
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true }));
			});
		});

		await new Promise<void>((resolve) => targetServer.listen(0, "127.0.0.1", resolve));
		const port = (targetServer.address() as { port: number }).port;
		cleanups.push(() => new Promise<void>((resolve) => targetServer.close(() => resolve())));

		const targetUrl = `http://127.0.0.1:${port}/webhook`;
		const secret = "test-hmac-secret";

		const pingResult = await testOutgoingWebhook({ url: targetUrl, secret });
		expect(pingResult.success).toBe(true);
		expect(receivedRequests.length).toBe(1);
		expect(receivedRequests[0].event).toBe("ping");
		expect(receivedRequests[0].body.event).toBe("ping");
		expect(receivedRequests[0].signature).toBeTruthy();

		const rawPayload = JSON.stringify(receivedRequests[0].body);
		const expectedSig = "sha256=" + createHmac("sha256", secret).update(rawPayload).digest("hex");
		expect(receivedRequests[0].signature).toBe(expectedSig);

		const mockStore = {
			snapshot: () => ({
				rooms: [
					{
						id: "room-1",
						name: "Dev Team",
						webhooks: [
							{
								id: "hook-1",
								roomId: "room-1",
								name: "Outbound Hook",
								type: "outgoing",
								enabled: true,
								url: targetUrl,
								secret,
								events: ["message", "task_completed"],
							},
						],
					},
				],
			}),
		} as unknown as DeviceHubStore;

		dispatchGroupWebhook(mockStore, "room-1", "message", { id: "m1", text: "Hello Webhook" });

		await new Promise((r) => setTimeout(r, 200));

		expect(receivedRequests.length).toBe(2);
		expect(receivedRequests[1].event).toBe("message");
		expect(receivedRequests[1].body.data.text).toBe("Hello Webhook");
		expect(receivedRequests[1].body.roomId).toBe("room-1");
		expect(receivedRequests[1].body.roomName).toBe("Dev Team");

		dispatchGroupWebhook(mockStore, "room-1", "delivery", { commit: "abc" });
		await new Promise((r) => setTimeout(r, 100));
		expect(receivedRequests.length).toBe(2);

		const directStore = {
			snapshot: () => ({
				rooms: [
					{
						id: "room-1",
						name: "Dev Team",
						webhooks: [
							{
								id: "hook-direct",
								roomId: "room-1",
								name: "Direct Hook",
								type: "outgoing",
								enabled: true,
								url: targetUrl,
								relayViaHub: false,
								events: ["message"],
							},
						],
					},
				],
			}),
		} as unknown as DeviceHubStore;

		dispatchGroupWebhook(directStore, "room-1", "message", { id: "m2", text: "Direct message" });
		await new Promise((r) => setTimeout(r, 100));
		expect(receivedRequests.length).toBe(2);
	});
});

async function setupHubFixture() {
	const dataDir = await mkdtemp(join(tmpdir(), "device-webhook-test-"));
	cleanups.push(async () => {
		for (let i = 0; i < 5; i++) {
			try {
				await rm(dataDir, { recursive: true, force: true });
				break;
			} catch (e: any) {
				if (e?.code !== "EBUSY" && e?.code !== "EPERM" && e?.code !== "ENOTEMPTY") throw e;
				await new Promise((r) => setTimeout(r, 60));
			}
		}
	});

	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as { port: number };
	const publicUrl = `http://127.0.0.1:${address.port}`;

	const deliveredTasks: any[] = [];
	const hub = await createDeviceHub({
		server,
		dataDir,
		publicUrl,
		onTask: async (deviceId, task) => {
			deliveredTasks.push(task);
			return true;
		},
	});
	cleanups.push(() => hub.close());

	async function request(
		path: string,
		body?: unknown,
		cookie = "",
		extra: Record<string, string> = {},
		method?: string,
	) {
		return await new Promise<{ status: number; body: any; cookie: string }>((resolve, reject) => {
			const outgoing = httpRequest(
				`http://127.0.0.1:${address.port}${path}`,
				{
					method: method ?? (body === undefined ? "GET" : "POST"),
					headers: {
						Host: new URL(publicUrl).host,
						Origin: publicUrl,
						"Content-Type": "application/json",
						...(cookie ? { Cookie: cookie } : {}),
						...extra,
					},
				},
				(res) => {
					const chunks: Buffer[] = [];
					res.on("data", (chunk) => chunks.push(chunk));
					res.on("end", () => {
						const raw = Buffer.concat(chunks).toString("utf8");
						let parsed: any;
						try {
							parsed = JSON.parse(raw);
						} catch {
							parsed = raw;
						}
						resolve({
							status: res.statusCode ?? 500,
							body: parsed,
							cookie: res.headers["set-cookie"]?.[0]?.split(";")[0] ?? "",
						});
					});
				},
			);
			outgoing.on("error", reject);
			if (body !== undefined) outgoing.write(JSON.stringify(body));
			outgoing.end();
		});
	}

	return { hub, request, publicUrl, deliveredTasks };
}

describe("group webhook hub integration e2e", () => {
	it("manages webhooks via API and handles incoming webhook dispatches", async () => {
		const { hub, request, deliveredTasks } = await setupHubFixture();

		const reg = await request("/api/auth/register", { username: "alice", password: "password-123456" });
		expect(reg.status).toBe(201);
		const cookie = reg.cookie;

		await hub.store.transact((draft) => {
			const owner = draft.accounts.find((a) => a.username === "alice")!;
			draft.devices.push({
				id: "dev-1",
				accountId: owner.id,
				name: "Alice Mac",
				credentialHash: "mock-hash",
				createdAt: Date.now(),
			});
			draft.bots.push({
				id: "bot-ci",
				accountId: owner.id,
				deviceId: "dev-1",
				name: "CIBot",
				description: "Continuous Integration Bot",
				revision: 1,
				enabled: true,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		const createRoom = await request(
			"/api/rooms",
			{ name: "DevOps", botIds: ["bot-ci"], primaryBotId: "bot-ci" },
			cookie,
		);
		expect(createRoom.status).toBe(201);
		const roomId = createRoom.body.room.id;

		const createHook = await request(
			`/api/rooms/${roomId}/webhooks`,
			{
				name: "GitHub Actions CI",
				type: "incoming",
				allowBotTrigger: true,
			},
			cookie,
		);
		expect(createHook.status).toBe(200);
		const hook = createHook.body.webhook;
		expect(hook.id).toBeTruthy();
		expect(hook.token).toBeTruthy();
		expect(hook.type).toBe("incoming");
		expect(hook.allowBotTrigger).toBe(true);

		const listRes = await request(`/api/rooms/${roomId}/webhooks`, undefined, cookie);
		expect(listRes.status).toBe(200);
		expect(listRes.body.webhooks.length).toBe(1);
		expect(listRes.body.webhooks[0].id).toBe(hook.id);

		const unauth = await request(
			`/api/rooms/${roomId}/webhooks/incoming/${hook.id}`,
			{ text: "Build failed on commit abc" },
			"",
			{ Origin: "" },
		);
		expect(unauth.status).toBe(401);

		const pushRes = await request(
			`/api/rooms/${roomId}/webhooks/incoming/${hook.id}?token=${hook.token}`,
			{
				text: "Build failed on commit abc: please check logs",
				senderName: "GitHub CI",
			},
			"",
			{ Origin: "" },
		);
		expect(pushRes.status).toBe(200);
		expect(pushRes.body.success).toBe(true);
		expect(pushRes.body.message.text).toBe("Build failed on commit abc: please check logs");
		expect(pushRes.body.message.sender.type).toBe("webhook");
		expect(pushRes.body.message.sender.name).toBe("GitHub CI");
		expect(pushRes.body.tasks.length).toBe(1);
		expect(pushRes.body.tasks[0].botId).toBe("bot-ci");

		expect(deliveredTasks.length).toBe(1);
		expect(deliveredTasks[0].botId).toBe("bot-ci");
		expect(deliveredTasks[0].text).toBe("Build failed on commit abc: please check logs");

		const regenRes = await request(`/api/rooms/${roomId}/webhooks/${hook.id}/regenerate-token`, {}, cookie);
		expect(regenRes.status).toBe(200);
		const newToken = regenRes.body.webhook.token;
		expect(newToken).not.toBe(hook.token);

		const oldTokenRes = await request(
			`/api/rooms/${roomId}/webhooks/incoming/${hook.id}?token=${hook.token}`,
			{ text: "retry" },
			"",
			{ Origin: "" },
		);
		expect(oldTokenRes.status).toBe(401);

		const newTokenRes = await request(
			`/api/rooms/${roomId}/webhooks/incoming/${hook.id}?token=${newToken}`,
			{ text: "retry with new token" },
			"",
			{ Origin: "" },
		);
		expect(newTokenRes.status).toBe(200);

		const noTriggerHookRes = await request(
			`/api/rooms/${roomId}/webhooks`,
			{
				name: "Quiet Hook",
				type: "incoming",
				allowBotTrigger: false,
			},
			cookie,
		);
		expect(noTriggerHookRes.status).toBe(200);
		const noTriggerHook = noTriggerHookRes.body.webhook;
		const tasksCountBefore = deliveredTasks.length;

		const quietPush = await request(
			`/api/rooms/${roomId}/webhooks/incoming/${noTriggerHook.id}?token=${noTriggerHook.token}`,
			{ text: "Just a quiet notification" },
			"",
			{ Origin: "" },
		);
		expect(quietPush.status).toBe(200);
		expect(quietPush.body.tasks.length).toBe(0);
		expect(deliveredTasks.length).toBe(tasksCountBefore);

		const delRes = await request(`/api/rooms/${roomId}/webhooks/${hook.id}/delete`, {}, cookie);
		expect(delRes.status).toBe(200);

		const relaySet = await request(
			`/api/rooms/${roomId}/hub-relay`,
			{ hubRelayBaseUrl: "https://hub.example.com" },
			cookie,
		);
		expect(relaySet.status).toBe(200);
		expect(relaySet.body.hubRelayBaseUrl).toBe("https://hub.example.com");

		const roomInfo = await request(`/api/rooms/${roomId}`, undefined, cookie);
		expect(roomInfo.body.room.hubRelayBaseUrl).toBe("https://hub.example.com");

		const outHookRes = await request(
			`/api/rooms/${roomId}/webhooks`,
			{
				name: "Internal LAN Hook",
				type: "outgoing",
				url: "http://192.168.1.100:8080/hook",
				relayViaHub: false,
			},
			cookie,
		);
		expect(outHookRes.status).toBe(200);
		expect(outHookRes.body.webhook.relayViaHub).toBe(false);

		const listAfterDel = await request(`/api/rooms/${roomId}/webhooks`, undefined, cookie);
		expect(listAfterDel.body.webhooks.length).toBe(2);
	});
});
