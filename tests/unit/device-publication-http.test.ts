import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer, request as httpRequest, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeviceHub } from "../../server/device-center/hub.js";
import { hashSecret } from "../../server/device-center/store.js";
import { installLocalDeviceCenter, type LocalDeviceConfig } from "../../server/device-center/local.js";
import { publicationFixture } from "../helpers/publish-intent-fixture.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function directory() {
	const dir = await mkdtemp(join(tmpdir(), "device-publication-http-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}
async function listen(server: Server) {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;
	expect(port).toBeGreaterThanOrEqual(8900);
	cleanups.push(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	return `http://127.0.0.1:${port}`;
}
async function fixture() {
	const { integration, intent } = publicationFixture();
	const calls: { device: string; action: string; payload: any }[] = [];
	const hub = await createDeviceHub({ dataDir: await directory(), publicUrl: "http://hub.test" });
	cleanups.push(() => hub.close());
	const base = await listen(hub.server);
	const observation = {
		intentId: intent.id,
		intentDigest: intent.digest,
		candidateSha: intent.candidateSha,
		observedAt: Date.now(),
		target: "expected_old" as const,
		targetSha: intent.expectedOld,
		phase: "prepared" as const,
		retryable: true,
	};
	await hub.store.transact((state) => {
		for (const id of ["account", "other"]) {
			state.accounts.push({ id, username: id, passwordHash: "", createdAt: 1 });
			state.sessions.push({ accountId: id, hash: hashSecret(id + "-session"), expiresAt: Date.now() + 60_000 });
		}
		for (const id of ["device", "other-device"])
			state.devices.push({
				id,
				accountId: "account",
				name: id,
				credentialHash: hashSecret(id + "-agent"),
				uiCredentialHash: hashSecret(id + "-ui"),
				createdAt: 1,
			});
		state.bots.push({
			id: "bot",
			accountId: "account",
			deviceId: "device",
			enabled: true,
			revision: 1,
			name: "Bot",
			description: "",
			createdAt: 1,
			updatedAt: 1,
		});
		state.rooms.push({ id: "room", accountId: "account", name: "Room", botIds: ["bot"], createdAt: 1 });
		state.conversations.push({
			id: "conversation",
			roomId: "room",
			accountId: "account",
			name: "Conversation",
			latestTaskId: "task",
			createdAt: 1,
			updatedAt: 1,
		} as any);
		state.deliveries.push({
			id: "delivery",
			accountId: "account",
			roomId: "room",
			conversationId: "conversation",
			botId: "bot",
			taskId: "task",
			repository: "repo",
			baseCommit: intent.expectedOld,
			commit: integration.commit,
			branch: "source",
			summary: "Ready",
			checks: [],
			limitations: [],
			createdAt: 1,
		});
		state.reviews.push(intent.review);
		state.integrations.push({
			...integration,
			status: "applying",
			publishIntent: intent,
			publishObservation: observation,
		});
	});
	hub.setRelay({
		callDevice: async (device: string, action: string, payload: any) => {
			calls.push({ device, action, payload });
			if (action === "integration_publication_status") return { status: "pending", publishObservation: observation };
			if (action === "integration_cancel")
				return {
					status: "cancelled",
					publishStop: {
						intentId: intent.id,
						intentDigest: intent.digest,
						candidateSha: intent.candidateSha,
						closed: true,
						stopConfirmed: true,
						pastEffect: "not_applied",
						fencedAt: Date.now(),
						stoppedAt: Date.now(),
					},
					publishObservation: { ...observation, phase: "closed", retryable: false },
				};
			if (action === "integration_confirm")
				return {
					status: "applied",
					publishReceipt: {
						intentId: intent.id,
						intentDigest: intent.digest,
						candidateSha: intent.candidateSha,
						outcome: "applied",
						proof: "cas_exit",
						observedAt: Date.now(),
					},
				};
			throw new Error("Unexpected publication action");
		},
	} as any);
	await vi.waitFor(() => expect(calls).toHaveLength(1));
	calls.length = 0;
	async function request(path: string, body?: unknown, authority = "owner") {
		return new Promise<{ status: number; body: any }>((resolve, reject) => {
			const headers: Record<string, string> = {
				Host: "hub.test",
				Origin: "http://hub.test",
				"Content-Type": "application/json",
			};
			if (["owner", "other", "agent-cookie"].includes(authority))
				headers.Cookie = `device_hub=${authority === "other" ? "other" : "account"}-session`;
			if (["agent", "wrong-agent", "ui", "agent-cookie"].includes(authority)) {
				const device = authority === "wrong-agent" ? "other-device" : "device";
				headers["X-Device-Id"] = device;
				headers["Author" + "ization"] = `Bearer ${device}-${authority === "ui" ? "ui" : "agent"}`;
			}
			const req = httpRequest(base + path, { method: body === undefined ? "GET" : "POST", headers }, (res) => {
				let raw = "";
				res.setEncoding("utf8");
				res.on("data", (chunk) => (raw += chunk));
				res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(raw) }));
			});
			req.on("error", reject);
			req.end(body === undefined ? undefined : JSON.stringify(body));
		});
	}
	return { hub, calls, request, intent };
}
const route = "/api/rooms/room/conversations/conversation/integrations";
const asAgent = (path: string) => path.replace("/api/", "/api/agent/");
const asUser = (path: string) => path.replace("/api/", "/api/device-user/");

describe("publication HTTP authorization", () => {
	it("exposes owner capability and requires exact intent binding for explicit human resume", async () => {
		const { request, calls, intent } = await fixture();
		expect((await request(route)).body.canResumePublication).toBe(true);
		expect((await request(asUser(route), undefined, "ui")).body.canResumePublication).toBe(true);
		expect((await request(route, undefined, "other")).status).toBe(404);
		expect((await request(route, undefined, "none")).status).toBe(401);
		const resume = `${route}/integration/resume`;
		expect((await request(resume, {})).status).toBe(400);
		expect(
			(await request(resume, { intentId: intent.id, intentDigest: intent.digest, candidateSha: "f".repeat(40) }))
				.status,
		).toBe(409);
		expect(calls).toHaveLength(0);
		const result = await request(
			asUser(resume),
			{ intentId: intent.id, intentDigest: intent.digest, candidateSha: intent.candidateSha },
			"ui",
		);
		expect(result.status).toBe(200);
		expect(result.body.integration.publishReceipt.proof).toBe("cas_exit");
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			device: "device",
			action: "integration_confirm",
			payload: { mode: "resume", publishIntent: intent },
		});
	});
	it("rejects agent resume including credentials combined with an owner cookie, and denies missing Bot identity", async () => {
		const { request, calls, intent } = await fixture();
		const input = {
			intentId: intent.id,
			intentDigest: intent.digest,
			candidateSha: intent.candidateSha,
			sourceBotId: "bot",
		};
		expect((await request(asAgent(`${route}/integration/resume`), input, "agent")).status).toBe(403);
		expect((await request(asAgent(`${route}/integration/resume`), input, "agent-cookie")).status).toBe(403);
		expect((await request(`${route}/integration/resume`, input, "agent")).status).toBe(401);
		expect((await request(asAgent(`${route}/integration/reconcile`), {}, "agent")).status).toBe(403);
		expect(calls).toHaveLength(0);
	});
	it("queries original Bot identity after disable or deletion while enforcing original device and account scope", async () => {
		const { hub, request, calls, intent } = await fixture();
		await hub.store.transact((state) => {
			state.bots[0].enabled = false;
			state.bots[0].revision = 2;
		});
		const path = asAgent(`${route}/integration/reconcile`);
		expect((await request(path, { sourceBotId: "bot" }, "agent")).status).toBe(200);
		await hub.store.transact((state) => {
			state.bots = [];
		});
		expect((await request(path, { sourceBotId: "bot" }, "agent")).status).toBe(200);
		expect((await request(path, { sourceBotId: "bot" }, "wrong-agent")).status).toBe(403);
		expect((await request(path, { sourceBotId: "forged" }, "agent")).status).toBe(403);
		expect((await request(`${route}/integration/reconcile`, {}, "other")).status).toBe(404);
		expect(calls).toHaveLength(2);
		for (const call of calls)
			expect(call).toMatchObject({
				device: "device",
				action: "integration_publication_status",
				payload: { accountId: "account", roomId: "room", conversationId: "conversation", publishIntent: intent },
			});
	});
	it("forwards owner cancellation with the original intent to establish a durable publication fence", async () => {
		const { hub, request, calls, intent } = await fixture();
		await hub.store.transact((state) => {
			state.bots = [];
			state.reviews = [];
		});
		const result = await request(`${route}/integration/cancel`, {});
		expect(result.status).toBe(200);
		expect(result.body.integration.publishStop).toMatchObject({
			closed: true,
			stopConfirmed: true,
			pastEffect: "not_applied",
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			device: "device",
			action: "integration_cancel",
			payload: {
				publishIntent: intent,
				accountId: "account",
				roomId: "room",
				conversationId: "conversation",
				ownerCleanup: true,
			},
		});
	});
	it("does not dispatch publication for legacy in-flight records without an intent", async () => {
		const { hub, request, calls } = await fixture();
		await hub.store.transact((state) => {
			delete state.integrations[0].publishIntent;
			delete state.integrations[0].publishObservation;
		});
		const result = await request(`${route}/integration/reconcile`, {});
		expect(result.status).toBe(200);
		expect(result.body.integration.status).toBe("applying");
		expect(result.body.integration.publishReceipt).toBeUndefined();
		expect(calls).toHaveLength(0);
	});
});

describe("local publication proxy and authenticated account binding", () => {
	it("whitelists recovery bodies and backfills old config accountId through a live runtime getter", async () => {
		const received: { path: string; body: any; credential?: string }[] = [];
		let authenticatedAccount: string | undefined;
		const upstream = express();
		upstream.use(express.json());
		upstream.use((req, res) => {
			received.push({ path: req.path, body: req.body, credential: req.headers.authorization });
			res.json(
				req.path === "/api/agent/bots"
					? { bots: [], ...(authenticatedAccount ? { accountId: authenticatedAccount } : {}) }
					: { integration: { id: "integration" } },
			);
		});
		const hubUrl = await listen(createServer(upstream));
		const dataDir = await directory();
		await writeFile(
			join(dataDir, "device-center.json"),
			JSON.stringify({
				hubUrl,
				deviceId: "device",
				name: "Device",
				credential: "device-agent",
				uiCredential: "device-ui",
				allowExecution: false,
			}),
		);
		let runtimeConfig: LocalDeviceConfig | undefined;
		const app = express();
		app.use(express.json());
		const local = await installLocalDeviceCenter({
			app,
			dataDir,
			connect: (config) => {
				runtimeConfig = config;
				return { close() {} };
			},
		});
		cleanups.push(() => local.close());
		expect(runtimeConfig!.accountId).toBeUndefined();
		expect(runtimeConfig!.uiCredential).toBeUndefined();
		await local.syncBots();
		expect(runtimeConfig!.accountId).toBeUndefined();
		authenticatedAccount = "account";
		await local.syncBots();
		expect(runtimeConfig!.accountId).toBe("account");
		authenticatedAccount = "forged-other";
		await expect(local.syncBots()).rejects.toThrow("Device account binding changed");
		expect(runtimeConfig!.accountId).toBe("account");
		const base = await listen(createServer(app));
		const path = `${base}/api/device-center/rooms/room/conversations/conversation/integrations/integration`;
		const post = (suffix: string, body: unknown) =>
			fetch(path + suffix, {
				method: "POST",
				headers: { Origin: base, "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
		const input = { intentId: "intent", intentDigest: "a".repeat(64), candidateSha: "b".repeat(40) };
		expect((await post("/reconcile", {})).status).toBe(200);
		expect((await post("/resume", input)).status).toBe(200);
		const count = received.length;
		for (const body of [
			{ ...input, sourceBotId: "spoof" },
			{ ...input, repoRoot: "arbitrary" },
			{ ...input, accountId: "other" },
		])
			expect((await post("/resume", body)).status).toBe(400);
		expect((await post("/reconcile", { mode: "resume" })).status).toBe(400);
		expect(received).toHaveLength(count);
		expect(received.at(-2)).toMatchObject({
			path: "/api/device-user/rooms/room/conversations/conversation/integrations/integration/reconcile",
			body: {},
			credential: "Bearer device-ui",
		});
		expect(received.at(-1)).toMatchObject({ body: input, credential: "Bearer device-ui" });
		expect(JSON.parse(await readFile(join(dataDir, "device-center.json"), "utf8")).accountId).toBeUndefined();
	});
});
