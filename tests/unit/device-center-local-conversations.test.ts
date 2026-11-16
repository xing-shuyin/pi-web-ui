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
describe("local persistent conversation routes", () => {
	it("keeps the body allowlist and same-origin rules while serving conversations from the local engine", async () => {
		const remoteHits: string[] = [];
		const upstream = express();
		upstream.use(express.json());
		upstream.use((req, res) => {
			remoteHits.push(`${req.method} ${req.path}`);
			res.status(500).json({ error: "rooms must not reach the remote hub" });
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
		// 房间不存在：本机引擎回 404，设备层按 Hub 语义映射（证明请求落在本机而不是远端）。
		for (const suffix of ["", "/thread"]) {
			const response = await fetch(route + suffix);
			expect(response.status).toBe(404);
			expect(await response.json()).toMatchObject({ code: "HUB_REJECTED", hubStatus: 404 });
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
			// 过了设备侧允许列表 → 落到本机引擎（房间不存在 404），而不是 400 INVALID_BODY。
			expect(result.status).toBe(404);
			expect(await result.json()).toMatchObject({ code: "HUB_REJECTED", hubStatus: 404 });
		}
		// 多一个字段就是注入：闸门先拒（凭据 / 越权只能由服务端决定）。
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
		// 房间流量一次都没打到远端 Hub。
		expect(remoteHits.filter((hit) => hit.includes("/rooms"))).toEqual([]);
	});
	it("bounds artifact contracts and oversized text at the device gate", async () => {
		const remoteHits: string[] = [];
		const upstream = express();
		upstream.use(express.json({ limit: "1mb" }));
		upstream.use((req, res) => {
			remoteHits.push(`${req.method} ${req.path}`);
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
		// 契约体（64KB patch）过闸后落到本机引擎：房间不存在 → 404，而不是被闸门拒成 400。
		for (const path of [
			"rooms/team/messages",
			"rooms/team/conversations",
			"rooms/team/conversations/thread/messages",
		]) {
			const response = await post(path, { text: "Code task", executionMode: "code", contract });
			// 契约体没被设备侧闸门拒（INVALID_BODY）：请求真的带着完整契约进了本机引擎。
			expect((await response.json()).code).not.toBe("INVALID_BODY");
		}
		// 超大文本 / 超大契约：设备侧闸门先拒，永不读进内存再转发。
		const oversizeText = await post("rooms/team/messages", { text: "x".repeat(40 * 1024) });
		expect(oversizeText.status).toBe(400);
		expect((await oversizeText.json()).code).toBe("INVALID_BODY");
		const oversizeContract = await post("rooms/team/messages", {
			text: "Code",
			contract: { ...contract, goal: "x".repeat(384 * 1024) },
		});
		expect(oversizeContract.status).toBe(400);
		expect((await oversizeContract.json()).code).toBe("INVALID_BODY");
		expect(remoteHits.filter((hit) => hit.includes("/rooms"))).toEqual([]);
	});

	it("accepts only the declared artifact fields and rejects forged receipts", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "local-artifact-acceptance-"));
		cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
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
		// 合法字段过闸（房间不存在 → 404），伪造的验收字段被闸门拒成 400。
		expect((await post("deliveries", delivery)).status).not.toBe(400);
		expect((await post("reviews", review)).status).not.toBe(400);
		expect((await post("reviews", { ...review, verification: { status: "verified" } })).status).toBe(400);
		expect((await post("deliveries", { ...delivery, artifactRef: { artifactDigest: "a".repeat(64) } })).status).toBe(
			400,
		);
	});
	describe("error forwarding (device-level proxy still points at the paired Hub)", () => {
		it("keeps the hub status, message and code for every allowed failure class", async () => {
			let reply: { status: number; body: unknown } = { status: 404, body: { error: "Device missing" } };
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
			const route = `${await listen(createServer(app))}/api/device-center/devices`;
			const get = async () => {
				const result = await fetch(route);
				return { status: result.status, body: await result.json() };
			};
			expect(await get()).toEqual({
				status: 404,
				body: { code: "HUB_REJECTED", error: "Device missing", hubStatus: 404 },
			});
			reply = { status: 409, body: { error: "Device busy" } };
			expect(await get()).toEqual({
				status: 409,
				body: { code: "HUB_REJECTED", error: "Device busy", hubStatus: 409 },
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
