import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installLocalDeviceCenter } from "../../server/device-center/local.js";
import { createHash } from "node:crypto";
import { computeArtifactDigest } from "../../server/device-center/work-contract.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});
async function listen(server: Server) {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanup.push(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
describe("local persistent conversation proxy", () => {
	it("forwards all conversation routes with UI authority and strict body allowlists", async () => {
		const received: {
			method: string;
			path: string;
			body: unknown;
			authorization: string | undefined;
			device: unknown;
		}[] = [];
		const upstream = express();
		upstream.use(express.json());
		upstream.use((req, res) => {
			received.push({
				method: req.method,
				path: req.path,
				body: req.body,
				authorization: req.headers.authorization,
				device: req.headers["x-device-id"],
			});
			res
				.status(req.method === "POST" ? 409 : 200)
				.json(req.method === "POST" ? { code: "CONVERSATION_BUSY", error: "busy" } : { conversations: [] });
		});
		const hubUrl = await listen(createServer(upstream));
		const dataDir = await mkdtemp(join(tmpdir(), "local-conversations-"));
		cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
		await writeFile(
			join(dataDir, "device-center.json"),
			JSON.stringify({
				hubUrl,
				deviceId: "source",
				name: "Source",
				credential: "agent-secret",
				uiCredential: "ui-secret",
				allowExecution: false,
			}),
		);
		const app = express();
		app.use(express.json());
		const local = await installLocalDeviceCenter({ app, dataDir, connect: () => ({ close() {} }) });
		cleanup.push(() => local.close());
		const base = await listen(createServer(app));
		const route = `${base}/api/device-center/rooms/team/conversations`;
		for (const suffix of ["", "/thread"]) {
			expect((await fetch(route + suffix)).status).toBe(200);
		}
		const create = { name: "Review", targetBotId: "original-bot", text: "Start", idempotencyKey: "new-key" };
		const continuation = { text: "Follow up", kind: "message", requestId: "request", idempotencyKey: "continue-key" };
		for (const [suffix, body] of [
			["", create],
			["/thread/messages", continuation],
		] as const) {
			const result = await fetch(route + suffix, {
				method: "POST",
				headers: { Origin: base, "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			expect(result.status).toBe(409);
			expect(await result.json()).toEqual({
				code: "HUB_REJECTED",
				error: "busy",
				hubStatus: 409,
				hubCode: "CONVERSATION_BUSY",
			});
		}
		expect(received.map((entry) => entry.path)).toEqual([
			"/api/device-user/rooms/team/conversations",
			"/api/device-user/rooms/team/conversations/thread",
			"/api/device-user/rooms/team/conversations",
			"/api/device-user/rooms/team/conversations/thread/messages",
		]);
		expect(received[2].body).toEqual(create);
		expect(received[3].body).toEqual(continuation);
		for (const entry of received) {
			expect(entry.authorization).toBe("Bearer ui-secret");
			expect(entry.device).toBe("source");
		}
		for (const [suffix, body] of [
			["", { ...create, credential: "injected" }],
			["/thread/messages", { ...continuation, targetBotId: "other-bot" }],
		] as const) {
			expect(
				(
					await fetch(route + suffix, {
						method: "POST",
						headers: { Origin: base, "Content-Type": "application/json" },
						body: JSON.stringify(body),
					})
				).status,
			).toBe(400);
		}
		expect(
			(
				await fetch(route + "/thread/messages", {
					method: "POST",
					headers: { Origin: "https://other.test", "Content-Type": "application/json" },
					body: JSON.stringify(continuation),
				})
			).status,
		).toBe(403);
		expect(received).toHaveLength(4);
	});
	it("forwards bounded artifact contracts through all task creation routes while keeping ordinary requests small", async () => {
		const received: unknown[] = [];
		const upstream = express();
		upstream.use(express.json({ limit: "1mb" }));
		upstream.use((req, res) => {
			received.push(req.body);
			res.json({ ok: true });
		});
		const hubUrl = await listen(createServer(upstream));
		const dataDir = await mkdtemp(join(tmpdir(), "local-contract-capacity-"));
		cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
		await writeFile(
			join(dataDir, "device-center.json"),
			JSON.stringify({
				hubUrl,
				deviceId: "source",
				name: "Source",
				credential: "agent-secret",
				uiCredential: "ui-secret",
				allowExecution: false,
			}),
		);
		const app = express();
		app.use(express.json({ limit: "1mb" }));
		const local = await installLocalDeviceCenter({ app, dataDir, connect: () => ({ close() {} }) });
		cleanup.push(() => local.close());
		const base = await listen(createServer(app));
		const patch = Buffer.alloc(64 * 1024, 7);
		const inputArtifact = {
			id: "artifact-1",
			digest: "",
			producer: {
				deviceId: "producer-device",
				botId: "producer-bot",
				taskId: "producer-task",
				attemptId: "producer-attempt",
				contractDigest: "b".repeat(64),
				manifestDigest: "c".repeat(64),
			},
			baseline: { repositoryId: "repo-1", commit: "a".repeat(40) },
			inputTree: "d".repeat(40),
			outputTree: "e".repeat(40),
			patchBase64: patch.toString("base64"),
			patchSha256: createHash("sha256").update(patch).digest("hex"),
			createdAt: 1,
		};
		inputArtifact.digest = computeArtifactDigest(inputArtifact);
		const contract = {
			id: "contract-1",
			revision: 1,
			executionMode: "code",
			baseline: inputArtifact.baseline,
			inputArtifacts: [inputArtifact],
		};
		const post = (path: string, body: unknown) =>
			fetch(`${base}/api/device-center/${path}`, {
				method: "POST",
				headers: { Origin: base, "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
		for (const path of [
			"rooms/team/messages",
			"rooms/team/conversations",
			"rooms/team/conversations/thread/messages",
		]) {
			const response = await post(path, { text: "Code task", executionMode: "code", contract });
			expect(response.status).toBe(200);
		}
		expect(received).toHaveLength(3);
		for (const body of received) expect(body).toMatchObject({ executionMode: "code", contract });
		expect((await post("rooms/team/messages", { text: "x".repeat(40 * 1024) })).status).toBe(400);
		expect(
			(await post("rooms/team/messages", { text: "Code", contract: { ...contract, goal: "x".repeat(384 * 1024) } }))
				.status,
		).toBe(400);
		expect(received).toHaveLength(3);
	});

	it("forwards exact artifact acceptance fields through the owner UI route and rejects forged receipts", async () => {
		const received: { path: string; body: unknown; authorization: string | undefined }[] = [];
		const upstream = express();
		upstream.use(express.json());
		upstream.use((req, res) => {
			received.push({ path: req.path, body: req.body, authorization: req.headers.authorization });
			if (req.path.endsWith("/verify") || req.path.endsWith("/cancel")) {
				setTimeout(
					() => res.json({ integration: { status: req.path.endsWith("/cancel") ? "cancelled" : "verified" } }),
					16000,
				);
				return;
			}
			res.json({ ok: true });
		});
		const hubUrl = await listen(createServer(upstream));
		const dataDir = await mkdtemp(join(tmpdir(), "local-artifact-acceptance-"));
		cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
		await writeFile(
			join(dataDir, "device-center.json"),
			JSON.stringify({
				hubUrl,
				deviceId: "source",
				name: "Source",
				credential: "agent-fixture",
				uiCredential: "owner-fixture",
				allowExecution: true,
			}),
		);
		const app = express();
		app.use(express.json());
		const local = await installLocalDeviceCenter({ app, dataDir, connect: () => ({ close() {} }) });
		cleanup.push(() => local.close());
		const base = `${await listen(createServer(app))}/api/device-center/rooms/team/conversations/thread`;
		const post = (suffix: string, body: unknown) =>
			fetch(`${base}/${suffix}`, {
				method: "POST",
				headers: { Origin: new URL(base).origin, "content-type": "application/json" },
				body: JSON.stringify(body),
			});
		const delivery = { artifactTaskId: "captured-task", summary: "Captured artifact", idempotencyKey: "delivery-key" };
		const review = {
			deliveryId: "delivery",
			artifactDigest: "a".repeat(64),
			integrationId: "integration",
			verificationDigest: "b".repeat(64),
			criteriaResults: [{ criterionIndex: 0, verdict: "met", evidence: "Observed verification" }],
			verdict: "accepted",
			summary: "Reviewed",
		};
		expect((await post("deliveries", delivery)).status).toBe(200);
		expect((await post("reviews", review)).status).toBe(200);
		expect(received.map((item) => item.body)).toEqual([delivery, review]);
		expect(received.every((item) => item.authorization === "Bearer owner-fixture")).toBe(true);
		expect(received.every((item) => !item.path.includes("/agent/"))).toBe(true);
		expect((await post("reviews", { ...review, verification: { status: "verified" } })).status).toBe(400);
		expect((await post("deliveries", { ...delivery, artifactRef: { artifactDigest: "a".repeat(64) } })).status).toBe(
			400,
		);
		expect(received).toHaveLength(2);
		const verified = await post("integrations/integration/verify", { commands: ["node check.cjs"] });
		expect(verified.status).toBe(200);
		expect(await verified.json()).toMatchObject({ integration: { status: "verified" } });
		expect(received).toHaveLength(3);
		const cancelled = await post("integrations/integration/cancel", {});
		expect(cancelled.status).toBe(200);
		expect(await cancelled.json()).toMatchObject({ integration: { status: "cancelled" } });
		expect(received).toHaveLength(4);
	}, 60000);

	describe("error forwarding", () => {
		it("keeps the hub status, message and code for every allowed failure class", async () => {
			let reply: { status: number; body: unknown } = { status: 404, body: { error: "Task missing" } };
			const upstream = express();
			upstream.use((_req, res) => res.status(reply.status).json(reply.body));
			const hubUrl = await listen(createServer(upstream));
			const dataDir = await mkdtemp(join(tmpdir(), "local-errors-"));
			cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
			await writeFile(
				join(dataDir, "device-center.json"),
				JSON.stringify({
					hubUrl,
					deviceId: "source",
					name: "Source",
					credential: "agent-secret",
					uiCredential: "ui-secret",
					allowExecution: false,
				}),
			);
			const app = express();
			app.use(express.json());
			const local = await installLocalDeviceCenter({ app, dataDir, connect: () => ({ close() {} }) });
			cleanup.push(() => local.close());
			const route = `${await listen(createServer(app))}/api/device-center/rooms/team/tasks/task`;
			const get = async () => {
				const result = await fetch(route);
				return { status: result.status, body: await result.json() };
			};
			expect(await get()).toEqual({
				status: 404,
				body: { code: "HUB_REJECTED", error: "Task missing", hubStatus: 404 },
			});
			reply = { status: 409, body: { code: "ACTIVE_TASKS", error: "remove blocked" } };
			expect(await get()).toEqual({
				status: 409,
				body: {
					code: "ACTIVE_TASKS",
					error: "Stop active tasks before removing members, clearing messages or deleting this group",
				},
			});
			reply = { status: 401, body: { error: "UI device authentication required; pair again" } };
			expect(await get()).toEqual({
				status: 409,
				body: { code: "REPAIR_REQUIRED", error: "Pair this computer again", hubStatus: 401 },
			});
			reply = { status: 403, body: { error: "Plan approval is restricted to human users" } };
			expect(await get()).toEqual({
				status: 403,
				body: { code: "HUB_FORBIDDEN", error: "Plan approval is restricted to human users", hubStatus: 403 },
			});
			reply = { status: 500, body: {} };
			expect(await get()).toEqual({
				status: 502,
				body: { code: "HUB_REJECTED", error: "Hub rejected group request", hubStatus: 500 },
			});
			reply = { status: 403, body: { error: "denied for ui-secret and agent-secret" } };
			const scrubbed = await get();
			expect(scrubbed.status).toBe(403);
			expect(JSON.stringify(scrubbed.body)).not.toContain("ui-secret");
			expect(JSON.stringify(scrubbed.body)).not.toContain("agent-secret");
			expect(scrubbed.body).toMatchObject({ code: "HUB_FORBIDDEN", error: "denied for [REDACTED] and [REDACTED]" });
		});
	});
});
