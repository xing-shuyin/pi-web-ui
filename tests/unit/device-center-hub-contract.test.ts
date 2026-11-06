import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { createHash } from "node:crypto";
import { createDeviceHub } from "../../server/device-center/hub.js";
import { readPersistedHub } from "../../server/device-center/store.js";
import {
	computeArtifactDigest,
	createWorkContract,
	createContextManifest,
	MAX_PATCH_BYTES,
	MAX_WORK_CONTRACT_BYTES,
	MAX_CONTEXT_MANIFEST_BYTES,
	MAX_CONTRACT_REQUEST_BYTES,
} from "../../server/device-center/work-contract.js";
import type { DeviceArtifact } from "../../server/protocol.js";
import { RELAY_LIMITS } from "../../server/device-center/relay.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	vi.useRealTimers();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(publicUrl = "https://hub.test", onDeliver?: (dataDir: string, task: any) => Promise<void>) {
	const dataDir = await mkdtemp(join(tmpdir(), "device-hub-contract-test-"));
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

	const deliveredTasks: any[] = [];
	const onTask = vi.fn(async (_deviceId: string, task: any) => {
		deliveredTasks.push(task);
		await onDeliver?.(dataDir, task);
	});

	const hub = await createDeviceHub({
		dataDir,
		publicUrl,
		onTask,
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
				(res) => {
					let buffer = "";
					res.on("data", (chunk) => (buffer += chunk));
					res.on("end", () => {
						let parsed: any;
						try {
							parsed = JSON.parse(buffer);
						} catch {
							parsed = buffer;
						}
						resolve({
							status: res.statusCode ?? 500,
							body: parsed,
							cookie: res.headers["set-cookie"]?.[0] ?? "",
						});
					});
				},
			);
			outgoing.on("error", reject);
			if (body !== undefined) outgoing.write(JSON.stringify(body));
			outgoing.end();
		});
		return response;
	}

	// Register account and pair device + bot
	const reg = await request("/api/auth/register", { username: "alice", password: "Password123!" });
	const cookie = reg.cookie;

	const start = await request("/api/pair/start", { name: "test-device" });
	await request("/api/pair/approve", { code: start.body.code }, cookie);
	const poll = await request("/api/pair/poll", { pollToken: start.body.pollToken });
	const device = poll.body;

	const botId = `bot-${device.deviceId}`;
	const botRes = await request(
		"/api/agent/bots",
		{
			bots: [
				{
					id: botId,
					name: "coder-bot",
					description: "Code bot",
					enabled: true,
					revision: 1,
				},
			],
		},
		"",
		{ Authorization: `Bearer ${device.credential}`, "X-Device-Id": device.deviceId },
		"PUT",
	);
	expect(botRes.status).toBe(200);
	const bot = { id: botId, deviceId: device.deviceId };

	// Create a room
	const roomRes = await request("/api/rooms", { name: "test-room", botIds: [bot.id] }, cookie);
	const room = roomRes.body.room;

	return {
		dataDir,
		hub,
		cookie,
		room,
		bot,
		device,
		request,
		deliveredTasks,
	};
}

describe("Hub task creation with executionMode and contract", () => {
	it("defaults executionMode to chat when omitted", async () => {
		const f = await fixture();
		const res = await f.request(
			`/api/rooms/${f.room.id}/messages`,
			{ text: "Hello", targetBotIds: [f.bot.id] },
			f.cookie,
		);
		expect(res.status).toBe(200);
		expect(res.body.tasks[0].executionMode).toBe("chat");
	});

	it("creates immutable work contract with computed digest", async () => {
		const f = await fixture();
		const res = await f.request(
			`/api/rooms/${f.room.id}/messages`,
			{
				text: "Implement widget",
				targetBotIds: [f.bot.id],
				executionMode: "chat",
				contract: {
					id: "widget-contract",
					goal: "Implement widget",
					constraints: ["No external dependencies"],
				},
			},
			f.cookie,
		);
		expect(res.status).toBe(200);
		const task = res.body.tasks[0];
		expect(task.contract).toBeDefined();
		expect(task.contract.id).toBe("widget-contract");
		expect(task.contract.revision).toBe(1);
		expect(task.contract.digest).toMatch(/^[0-9a-f]{64}$/);
		expect(task.contract.constraints).toEqual(["No external dependencies"]);
	});

	it("requires baseline with 40-char commit SHA for code executionMode", async () => {
		const f = await fixture();
		const res = await f.request(
			`/api/rooms/${f.room.id}/messages`,
			{
				text: "Code work",
				targetBotIds: [f.bot.id],
				executionMode: "code",
			},
			f.cookie,
		);
		expect(res.status).toBe(400);
		expect(res.body.error).toMatch(/baseline/i);

		const validRes = await f.request(
			`/api/rooms/${f.room.id}/messages`,
			{
				text: "Code work",
				targetBotIds: [f.bot.id],
				executionMode: "code",
				contract: {
					baseline: { repositoryId: "repo-1", commit: "a".repeat(40) },
				},
			},
			f.cookie,
		);
		expect(validRes.status).toBe(200);
		expect(validRes.body.tasks[0].executionMode).toBe("code");
		expect(validRes.body.tasks[0].contract.baseline.commit).toBe("a".repeat(40));
	});

	it("rejects conflict when top-level executionMode disagrees with contract.executionMode", async () => {
		const f = await fixture();
		const res = await f.request(
			`/api/rooms/${f.room.id}/messages`,
			{
				text: "Conflict test",
				targetBotIds: [f.bot.id],
				executionMode: "chat",
				contract: { executionMode: "code", baseline: { repositoryId: "r1", commit: "a".repeat(40) } },
			},
			f.cookie,
		);
		expect(res.status).toBe(400);
		expect(res.body.error).toMatch(/executionMode conflicts with contract\.executionMode/);
	});

	it("accessible via /api/rooms/:id/tasks route directly", async () => {
		const f = await fixture();
		const res = await f.request(
			`/api/rooms/${f.room.id}/tasks`,
			{ text: "Via tasks route", targetBotIds: [f.bot.id] },
			f.cookie,
		);
		expect(res.status).toBe(200);
		expect(res.body.tasks).toHaveLength(1);
		expect(res.body.tasks[0].text).toBe("Via tasks route");
	});
});

describe("Hub contract idempotency and version conflict guards", () => {
	it("rejects same idempotencyKey with different contract (同 key 异契约冲突)", async () => {
		const f = await fixture();
		const key = "idemp-key-123";

		// First request with contract A
		const first = await f.request(
			`/api/rooms/${f.room.id}/messages`,
			{
				text: "Work A",
				targetBotIds: [f.bot.id],
				idempotencyKey: key,
				contract: { id: "c-idemp", revision: 1, goal: "Goal A" },
			},
			f.cookie,
		);
		expect(first.status).toBe(200);

		// Duplicate request with exact same contract -> 200 duplicate
		const duplicate = await f.request(
			`/api/rooms/${f.room.id}/messages`,
			{
				text: "Work A",
				targetBotIds: [f.bot.id],
				idempotencyKey: key,
				contract: { id: "c-idemp", revision: 1, goal: "Goal A" },
			},
			f.cookie,
		);
		expect(duplicate.status).toBe(200);

		// Same key with DIFFERENT contract goal -> rejected with 409!
		const conflict = await f.request(
			`/api/rooms/${f.room.id}/messages`,
			{
				text: "Work A",
				targetBotIds: [f.bot.id],
				idempotencyKey: key,
				contract: { id: "c-idemp", revision: 1, goal: "Goal CHANGED" },
			},
			f.cookie,
		);
		expect(conflict.status).toBe(409);
		expect(conflict.body.error).toMatch(/Idempotency key reused/i);
	});

	it("successfully replays code request without explicit contract id using stable derived id", async () => {
		const f = await fixture();
		const key = "code-idemp-key-stable";
		const payload = {
			text: "Code without explicit id",
			targetBotIds: [f.bot.id],
			executionMode: "code",
			idempotencyKey: key,
			contract: {
				baseline: { repositoryId: "repo-stable", commit: "b".repeat(40) },
			},
		};

		// First call
		const first = await f.request(`/api/rooms/${f.room.id}/messages`, payload, f.cookie);
		expect(first.status).toBe(200);
		const firstContract = first.body.tasks[0].contract;
		expect(firstContract.id).toMatch(/^contract-[0-9a-f]{16}$/);

		// Exact retry with same idempotency key
		const retry = await f.request(`/api/rooms/${f.room.id}/messages`, payload, f.cookie);
		expect(retry.status).toBe(200);
		expect(retry.body.tasks[0].id).toBe(first.body.tasks[0].id);
		expect(retry.body.tasks[0].contract.id).toBe(firstContract.id);
		expect(retry.body.tasks[0].contract.digest).toBe(firstContract.digest);
	});

	it("rejects creating an older contract revision when a newer revision exists", async () => {
		const f = await fixture();

		// Submit revision 2
		const rev2 = await f.request(
			`/api/rooms/${f.room.id}/messages`,
			{
				text: "Rev 2",
				targetBotIds: [f.bot.id],
				contract: { id: "versioned-feature", revision: 2, goal: "Version 2" },
			},
			f.cookie,
		);
		expect(rev2.status).toBe(200);

		// Attempt to submit older revision 1 for same contract ID -> 409 rejected
		const rev1 = await f.request(
			`/api/rooms/${f.room.id}/messages`,
			{
				text: "Rev 1",
				targetBotIds: [f.bot.id],
				contract: { id: "versioned-feature", revision: 1, goal: "Version 1" },
			},
			f.cookie,
		);
		expect(rev1.status).toBe(409);
		expect(rev1.body.error).toMatch(/already has a newer revision 2/);
	});
});

describe("Hub ContextManifest sealing and delivery resilience", () => {
	it("seals ContextManifest upon initial delivery and passes contract + manifest on wire", async () => {
		const f = await fixture();

		const res = await f.request(
			`/api/rooms/${f.room.id}/messages`,
			{
				text: "Delivery test",
				targetBotIds: [f.bot.id],
				contract: {
					id: "deliver-contract",
					goal: "Delivery test",
				},
			},
			f.cookie,
		);
		expect(res.status).toBe(200);
		const taskId = res.body.tasks[0].id;

		expect(f.deliveredTasks.length).toBeGreaterThanOrEqual(1);
		const delivered = f.deliveredTasks.find((t) => t.id === taskId);
		expect(delivered).toBeDefined();

		// Check wired contract and contextManifest
		expect(delivered.contract).toBeDefined();
		expect(delivered.contract.id).toBe("deliver-contract");
		expect(delivered.contextManifest).toBeDefined();
		expect(delivered.contextManifest.version).toBe(1);
		expect(delivered.contextManifest.contractId).toBe("deliver-contract");
		expect(delivered.contextManifest.contractDigest).toBe(delivered.contract.digest);
		expect(delivered.contextManifest.digest).toMatch(/^[0-9a-f]{64}$/);

		// GET task details returns sealed contract and manifest
		const details = await f.request(`/api/rooms/${f.room.id}/tasks/${taskId}`, undefined, f.cookie);
		expect(details.status).toBe(200);
		expect(details.body.task.contract.digest).toBe(delivered.contract.digest);
		expect(details.body.task.contextManifest.digest).toBe(delivered.contextManifest.digest);
	});

	it("manifest remains immutable across redelivery even if room history advances", async () => {
		const f = await fixture();

		const res = await f.request(
			`/api/rooms/${f.room.id}/messages`,
			{
				text: "Initial task",
				targetBotIds: [f.bot.id],
				contract: { id: "manifest-immut", goal: "Initial task" },
			},
			f.cookie,
		);
		const task = res.body.tasks[0];
		const firstDelivered = f.deliveredTasks.find((t) => t.id === task.id);
		const originalManifestDigest = firstDelivered.contextManifest.digest;

		// Add intervening room messages
		await f.request(`/api/rooms/${f.room.id}/messages`, { text: "Chat message 1" }, f.cookie);
		await f.request(`/api/rooms/${f.room.id}/messages`, { text: "Chat message 2" }, f.cookie);

		// Details endpoint still returns the original frozen manifest
		const details = await f.request(`/api/rooms/${f.room.id}/tasks/${task.id}`, undefined, f.cookie);
		expect(details.body.task.contextManifest.digest).toBe(originalManifestDigest);
	});
});

describe("Hub code artifact outcome validation and superseded revision rejection", () => {
	it("accepts valid code artifact outcome matching contract and manifest", async () => {
		const f = await fixture();
		const commit = "d".repeat(40);

		const taskRes = await f.request(
			`/api/rooms/${f.room.id}/messages`,
			{
				text: "Code task",
				targetBotIds: [f.bot.id],
				executionMode: "code",
				contract: {
					id: "code-contract-1",
					goal: "Code task",
					baseline: { repositoryId: "repo-test", commit },
				},
			},
			f.cookie,
		);
		const task = taskRes.body.tasks[0];
		const delivered = f.deliveredTasks.find((t) => t.id === task.id);

		const art: DeviceArtifact = {
			id: "art-hub-1",
			digest: "",
			producer: {
				deviceId: f.device.deviceId,
				botId: f.bot.id,
				taskId: task.id,
				attemptId: task.attemptId,
				contractDigest: delivered.contract.digest,
				manifestDigest: delivered.contextManifest.digest,
			},
			baseline: { repositoryId: "repo-test", commit },
			inputTree: "1".repeat(40),
			outputTree: "2".repeat(40),
			patchBase64: "",
			patchSha256: createHash("sha256").update("").digest("hex"),
			createdAt: Date.now(),
		};
		art.digest = computeArtifactDigest(art);

		const accepted = await f.hub.acceptTaskEvent(f.device.deviceId, {
			taskId: task.id,
			botId: f.bot.id,
			attemptId: task.attemptId,
			leaseToken: delivered.leaseToken,
			leaseGeneration: delivered.leaseGeneration,
			status: "completed",
			report: "Code task completed successfully.",
			artifact: art,
			executionCompleted: true,
			artifactProduced: true,
		});
		expect(accepted.status).toBe("completed");
		expect(accepted.artifact?.id).toBe("art-hub-1");

		// Task details reflects the saved artifact and proof flags
		const details = await f.request(`/api/rooms/${f.room.id}/tasks/${task.id}`, undefined, f.cookie);
		expect(details.body.task.artifact.id).toBe("art-hub-1");
		expect(details.body.task.executionCompleted).toBe(true);
		expect(details.body.task.artifactProduced).toBe(true);
	});

	it("rejects code outcome with missing executionCompleted or artifactProduced proofs", async () => {
		const f = await fixture();
		const commit = "e".repeat(40);

		const taskRes = await f.request(
			`/api/rooms/${f.room.id}/messages`,
			{
				text: "Proof test",
				targetBotIds: [f.bot.id],
				executionMode: "code",
				contract: {
					id: "code-proof",
					goal: "Proof test",
					baseline: { repositoryId: "repo-proof", commit },
				},
			},
			f.cookie,
		);
		const task = taskRes.body.tasks[0];
		const delivered = f.deliveredTasks.find((t) => t.id === task.id);

		const art: DeviceArtifact = {
			id: "art-proof-fail",
			digest: "",
			producer: {
				deviceId: f.device.deviceId,
				botId: f.bot.id,
				taskId: task.id,
				attemptId: task.attemptId,
				contractDigest: delivered.contract.digest,
				manifestDigest: delivered.contextManifest.digest,
			},
			baseline: { repositoryId: "repo-proof", commit },
			inputTree: "1".repeat(40),
			outputTree: "2".repeat(40),
			createdAt: Date.now(),
		};
		art.digest = computeArtifactDigest(art);

		// Missing executionCompleted: true -> rejected
		await expect(
			f.hub.acceptTaskEvent(f.device.deviceId, {
				taskId: task.id,
				botId: f.bot.id,
				attemptId: task.attemptId,
				leaseToken: delivered.leaseToken,
				leaseGeneration: delivered.leaseGeneration,
				status: "completed",
				report: "Report",
				artifact: art,
				executionCompleted: false, // Proof failure!
				artifactProduced: true,
			}),
		).rejects.toThrow(/executionCompleted/);
	});

	it("rejects advancing an active revision, then preserves exact terminal ACK after advancing", async () => {
		const f = await fixture();

		// Task 1 with revision 1
		const t1Res = await f.request(
			`/api/rooms/${f.room.id}/messages`,
			{
				text: "Rev 1 task",
				targetBotIds: [f.bot.id],
				contract: { id: "supersede-test", revision: 1, goal: "Rev 1" },
			},
			f.cookie,
		);
		const t1 = t1Res.body.tasks[0];
		const d1 = f.deliveredTasks.find((t) => t.id === t1.id);

		// Task 2 with revision 2 for same contract ID -> supersedes revision 1
		const t2Res = await f.request(
			`/api/rooms/${f.room.id}/messages`,
			{
				text: "Rev 2 task",
				targetBotIds: [f.bot.id],
				contract: { id: "supersede-test", revision: 2, goal: "Rev 2" },
			},
			f.cookie,
		);
		expect(t2Res.status).toBe(409);
		expect(t2Res.body.error).toMatch(/older revision is active/);
		const outcome = {
			taskId: t1.id,
			botId: f.bot.id,
			attemptId: t1.attemptId,
			leaseToken: d1.leaseToken,
			leaseGeneration: d1.leaseGeneration,
			status: "completed" as const,
			report: "Completed rev 1",
		};
		await f.hub.acceptTaskEvent(f.device.deviceId, outcome);
		const next = await f.request(
			`/api/rooms/${f.room.id}/messages`,
			{
				text: "Rev 2 task",
				targetBotIds: [f.bot.id],
				contract: { id: "supersede-test", revision: 2, goal: "Rev 2" },
			},
			f.cookie,
		);
		expect(next.status).toBe(200);
		// The original positive ACK may have been lost. Replaying its durable payload still succeeds.
		expect((await f.hub.acceptTaskEvent(f.device.deviceId, outcome)).status).toBe("completed");
		const facts = f.hub.store.snapshot();
		expect(facts.messages.filter((m) => m.taskIds.includes(t1.id) && m.text === outcome.report)).toHaveLength(1);
		await expect(f.hub.acceptTaskEvent(f.device.deviceId, { ...outcome, report: "different" })).rejects.toThrow();
	});
});

describe("Hub WAL persistence and crash recovery of contracts & manifests", () => {
	it("persists contracts and contextManifests to WAL and recovers them intact across restart", async () => {
		const f = await fixture();

		const taskRes = await f.request(
			`/api/rooms/${f.room.id}/messages`,
			{
				text: "Crash recovery test",
				targetBotIds: [f.bot.id],
				contract: {
					id: "persist-contract",
					goal: "Verify WAL persistence",
					constraints: ["No data loss"],
				},
			},
			f.cookie,
		);
		const task = taskRes.body.tasks[0];
		const delivered = f.deliveredTasks.find((t) => t.id === task.id);
		const originalContractDigest = delivered.contract.digest;
		const originalManifestDigest = delivered.contextManifest.digest;

		// Close the Hub instance
		await f.hub.close();

		// Read persisted state directly from storage
		const persisted = await readPersistedHub(f.dataDir);
		const recoveredTask = persisted.tasks.find((t) => t.id === task.id);

		expect(recoveredTask).toBeDefined();
		expect(recoveredTask?.contract).toBeDefined();
		expect(recoveredTask?.contract?.id).toBe("persist-contract");
		expect(recoveredTask?.contract?.digest).toBe(originalContractDigest);
		expect(recoveredTask?.contract?.constraints).toEqual(["No data loss"]);

		expect(recoveredTask?.contextManifest).toBeDefined();
		expect(recoveredTask?.contextManifest?.version).toBe(1);
		expect(recoveredTask?.contextManifest?.contractDigest).toBe(originalContractDigest);
		expect(recoveredTask?.contextManifest?.digest).toBe(originalManifestDigest);

		// Reopen a new Hub on the same dataDir and verify recovery
		const reopenedHub = await createDeviceHub({
			dataDir: f.dataDir,
			publicUrl: "https://hub.test",
		});
		cleanups.push(() => reopenedHub.close());

		const state = (reopenedHub as any).store?.snapshot?.() ?? (await readPersistedHub(f.dataDir));
		const reopenedTask = state.tasks.find((t: any) => t.id === task.id);
		expect(reopenedTask.contract.digest).toBe(originalContractDigest);
		expect(reopenedTask.contextManifest.digest).toBe(originalManifestDigest);
	});
});

describe("Hub contract production regressions", () => {
	const baseline = { repositoryId: "repo", commit: "c".repeat(40) };
	function outcome(f: Awaited<ReturnType<typeof fixture>>, task: any, status: "completed" | "failed" = "completed") {
		const delivered = f.deliveredTasks.find((t) => t.id === task.id);
		return {
			taskId: task.id,
			botId: f.bot.id,
			attemptId: task.attemptId,
			leaseToken: delivered.leaseToken,
			leaseGeneration: delivered.leaseGeneration,
			status,
			report: "settled",
		};
	}
	function inputArtifact(patch = Buffer.alloc(0)): DeviceArtifact {
		const a: DeviceArtifact = {
			id: "artifact",
			digest: "",
			createdAt: 1,
			baseline,
			producer: {
				deviceId: "d",
				botId: "b",
				taskId: "t",
				attemptId: "a",
				contractDigest: "1".repeat(64),
				manifestDigest: "2".repeat(64),
			},
			inputTree: "1".repeat(40),
			outputTree: "2".repeat(40),
			patchBase64: patch.toString("base64"),
			patchSha256: createHash("sha256").update(patch).digest("hex"),
		};
		a.digest = computeArtifactDigest(a);
		return a;
	}

	it("persists the first manifest and lease before invoking the first dispatch callback", async () => {
		let observed = false;
		const f = await fixture("https://hub.test", async (dataDir, wire) => {
			const durable = (await readPersistedHub(dataDir)).tasks.find((t) => t.id === wire.id)!;
			expect(durable.contract!.digest).toBe(wire.contract.digest);
			expect(durable.contextManifest).toEqual(wire.contextManifest);
			expect(durable.leaseToken).toBe(wire.leaseToken);
			expect(durable.leaseGeneration).toBe(wire.leaseGeneration);
			observed = true;
		});
		const res = await f.request(
			`/api/rooms/${f.room.id}/messages`,
			{
				text: "persist before dispatch",
				targetBotIds: [f.bot.id],
				executionMode: "code",
				contract: { goal: "persist before dispatch", baseline },
			},
			f.cookie,
		);
		expect(res.status).toBe(200);
		expect(observed).toBe(true);
	});

	it("does not dispatch when persisting the sealed manifest fails", async () => {
		const f = await fixture();
		const persist = f.hub.store.persist.bind(f.hub.store);
		const failure = vi.spyOn(f.hub.store, "persist").mockImplementation(async (state, seq, diff) => {
			if (state.tasks.some((task) => task.contextManifest)) throw new Error("manifest storage fault");
			await persist(state, seq, diff);
		});
		await f.request(
			`/api/rooms/${f.room.id}/messages`,
			{
				text: "cannot dispatch",
				targetBotIds: [f.bot.id],
				executionMode: "code",
				contract: { goal: "cannot dispatch", baseline },
			},
			f.cookie,
		);
		expect(f.deliveredTasks).toHaveLength(0);
		expect(f.hub.store.snapshot().tasks[0].status).toBe("failed");
		expect((await readPersistedHub(f.dataDir)).tasks[0].contextManifest).toBeUndefined();
		failure.mockRestore();
	});

	it("claims the original lease after restart and commits an artifact against the original sealed manifest", async () => {
		const f = await fixture();
		const res = await f.request(
			`/api/rooms/${f.room.id}/messages`,
			{
				text: "recover code",
				targetBotIds: [f.bot.id],
				executionMode: "code",
				contract: { id: "recover-code", goal: "recover code", baseline },
			},
			f.cookie,
		);
		const task = res.body.tasks[0];
		const wire = f.deliveredTasks.find((t) => t.id === task.id);
		await f.hub.close();
		const redeliver = vi.fn();
		const reopened = await createDeviceHub({ dataDir: f.dataDir, publicUrl: "https://hub.test", onTask: redeliver });
		cleanups.push(() => reopened.close());
		const claim = {
			taskId: task.id,
			attemptId: task.attemptId,
			botId: f.bot.id,
			leaseToken: wire.leaseToken,
			leaseGeneration: wire.leaseGeneration,
		};
		expect(await reopened.claimTask(f.device.deviceId, claim)).toMatchObject({ accepted: true });
		const artifact = inputArtifact();
		artifact.producer = {
			deviceId: f.device.deviceId,
			botId: f.bot.id,
			taskId: task.id,
			attemptId: task.attemptId,
			contractDigest: wire.contract.digest,
			manifestDigest: wire.contextManifest.digest,
		};
		artifact.digest = computeArtifactDigest(artifact);
		const result = {
			...claim,
			status: "completed" as const,
			report: "recovered execution",
			artifact,
			executionCompleted: true,
			artifactProduced: true,
		};
		expect((await reopened.acceptTaskEvent(f.device.deviceId, result)).artifact!.digest).toBe(artifact.digest);
		expect((await reopened.acceptTaskEvent(f.device.deviceId, result)).status).toBe("completed");
		const durable = (await readPersistedHub(f.dataDir)).tasks.find((t) => t.id === task.id)!;
		expect(durable.artifact!.digest).toBe(artifact.digest);
		expect(durable.contextManifest).toEqual(wire.contextManifest);
		expect(redeliver).not.toHaveBeenCalled();
	});

	it("rejects same id/revision with different content across independent idempotency keys", async () => {
		const f = await fixture();
		const body = { text: "first", targetBotIds: [f.bot.id], contract: { id: "unique", revision: 1, goal: "first" } };
		expect(
			(await f.request(`/api/rooms/${f.room.id}/messages`, { ...body, idempotencyKey: "one" }, f.cookie)).status,
		).toBe(200);
		const conflict = await f.request(
			`/api/rooms/${f.room.id}/messages`,
			{ ...body, idempotencyKey: "two", contract: { ...body.contract, goal: "changed" } },
			f.cookie,
		);
		expect(conflict.status).toBe(409);
		expect(conflict.body.error).toMatch(/different content/);
		expect(f.hub.store.snapshot().tasks).toHaveLength(1);
	});

	it.each(["queued", "running", "waiting", "recovery"])(
		"blocks revision advancement while the old task is %s",
		async (state) => {
			const f = await fixture();
			const first = await f.request(
				`/api/rooms/${f.room.id}/messages`,
				{ text: "first", targetBotIds: [f.bot.id], contract: { id: "lifecycle", goal: "first" } },
				f.cookie,
			);
			await f.hub.store.transact((draft) => {
				const task = draft.tasks.find((t) => t.id === first.body.tasks[0].id)!;
				if (state === "recovery") {
					task.status = "interrupted";
					task.recoveryUntil = Date.now() + 60000;
				} else task.status = state as "queued" | "running" | "waiting";
			});
			const next = await f.request(
				`/api/rooms/${f.room.id}/messages`,
				{ text: "next", targetBotIds: [f.bot.id], contract: { id: "lifecycle", revision: 2, goal: "next" } },
				f.cookie,
			);
			expect(next.status).toBe(409);
			expect(next.body.error).toMatch(/older revision is active/);
		},
	);

	it("does not inherit old revision acceptance through dependsOnTaskId", async () => {
		const f = await fixture();
		const first = await f.request(
			`/api/rooms/${f.room.id}/messages`,
			{ text: "first", targetBotIds: [f.bot.id], contract: { id: "dependency", goal: "first" } },
			f.cookie,
		);
		const task = first.body.tasks[0];
		await f.hub.acceptTaskEvent(f.device.deviceId, outcome(f, task));
		const next = await f.request(
			`/api/rooms/${f.room.id}/messages`,
			{
				text: "next",
				targetBotIds: [f.bot.id],
				dependsOnTaskId: task.id,
				contract: { id: "dependency", revision: 2, goal: "next" },
			},
			f.cookie,
		);
		expect(next.status).toBe(409);
		expect(next.body.error).toMatch(/cannot inherit acceptance/);
	});

	it("propagates only proven permanent terminal and obsolete-attempt rejection metadata", async () => {
		const f = await fixture();
		const res = await f.request(
			`/api/rooms/${f.room.id}/messages`,
			{
				text: "old code",
				targetBotIds: [f.bot.id],
				executionMode: "code",
				contract: { id: "negative-ack", goal: "old code", baseline },
			},
			f.cookie,
		);
		const task = res.body.tasks[0];
		const wire = f.deliveredTasks.find((t) => t.id === task.id);
		const failed = outcome(f, task, "failed");
		await f.hub.acceptTaskEvent(f.device.deviceId, failed);
		await f.hub.store.transact((draft) => {
			draft.tasks.find((t) => t.id === task.id)!.cancelRequested = true;
		});
		const artifact = inputArtifact();
		artifact.producer = {
			deviceId: f.device.deviceId,
			botId: f.bot.id,
			taskId: task.id,
			attemptId: task.attemptId,
			contractDigest: wire.contract.digest,
			manifestDigest: wire.contextManifest.digest,
		};
		artifact.digest = computeArtifactDigest(artifact);
		const late = {
			...failed,
			status: "completed" as const,
			artifact,
			executionCompleted: true,
			artifactProduced: true,
		};
		await expect(f.hub.acceptTaskEvent(f.device.deviceId, late)).rejects.toMatchObject({
			status: 409,
			permanent: true,
			reasonCode: "terminal_conflict",
		});
		await f.hub.store.transact((draft) => {
			draft.tasks.find((t) => t.id === task.id)!.attemptId = "different-durable-attempt";
		});
		// Identity rejection takes precedence over validating this artifact against the newer attempt.
		await expect(f.hub.acceptTaskEvent(f.device.deviceId, late)).rejects.toMatchObject({
			status: 409,
			permanent: true,
			reasonCode: "attempt_expired",
		});
	});

	it("fences superseded claims and renewals but still durably settles old terminal facts", async () => {
		const f = await fixture();
		const res = await f.request(
			`/api/rooms/${f.room.id}/messages`,
			{ text: "first", targetBotIds: [f.bot.id], contract: { id: "fence", goal: "first" } },
			f.cookie,
		);
		const task = res.body.tasks[0];
		const event = outcome(f, task);
		await f.hub.store.transact((draft) => {
			const old = draft.tasks.find((t) => t.id === task.id)!;
			old.status = "running";
			draft.tasks.push({
				...old,
				id: "historical-newer",
				attemptId: "newer",
				status: "waiting",
				leaseToken: undefined,
				leaseGeneration: undefined,
				contract: createWorkContract({ id: "fence", revision: 2, goal: "newer" }),
				contextManifest: undefined,
			});
		});
		const claim = {
			taskId: task.id,
			attemptId: task.attemptId,
			botId: f.bot.id,
			leaseToken: event.leaseToken,
			leaseGeneration: event.leaseGeneration,
		};
		expect(await f.hub.claimTask(f.device.deviceId, claim)).toMatchObject({
			accepted: false,
			reason: "Contract revision superseded",
		});
		expect(await f.hub.renewTaskLease(f.device.deviceId, { ...claim, hasActivity: false })).toMatchObject({
			accepted: false,
			reason: "Contract revision superseded",
		});
		await expect(f.hub.acceptTaskEvent(f.device.deviceId, { ...event, status: "running" })).rejects.toThrow(
			/superseded/,
		);
		expect((await f.hub.acceptTaskEvent(f.device.deviceId, { ...event, status: "failed" })).status).toBe("failed");
		expect((await f.hub.acceptTaskEvent(f.device.deviceId, { ...event, status: "failed" })).status).toBe("failed");
	});

	it("starts each code round without transcript resume while preserving the Hub conversation address", async () => {
		const f = await fixture();
		const chat = await f.request(
			`/api/rooms/${f.room.id}/messages`,
			{ text: "chat", targetBotIds: [f.bot.id] },
			f.cookie,
		);
		await f.hub.acceptTaskEvent(f.device.deviceId, outcome(f, chat.body.tasks[0]));
		const conversationId = chat.body.tasks[0].conversationId;
		for (const id of ["code-one", "code-two"]) {
			const res = await f.request(
				`/api/rooms/${f.room.id}/conversations/${conversationId}/messages`,
				{ text: id, executionMode: "code", contract: { id, goal: id, baseline } },
				f.cookie,
			);
			expect(res.status).toBe(200);
			const task = res.body.tasks[0];
			const wire = f.deliveredTasks.find((t) => t.id === task.id);
			expect(wire.resume).toBe(false);
			expect(wire.conversationId).toBe(conversationId);
			expect(wire.contextManifest.executionPolicy).toEqual({
				deviceId: f.device.deviceId,
				botId: f.bot.id,
				botRevision: 1,
			});
			await f.hub.acceptTaskEvent(f.device.deviceId, outcome(f, task, "failed"));
		}
	});

	it("uses sealed null context and taskState without falling back to newer conversation state", async () => {
		const f = await fixture();
		const first = await f.request(
			`/api/rooms/${f.room.id}/messages`,
			{ text: "first", targetBotIds: [f.bot.id] },
			f.cookie,
		);
		const conversationId = first.body.tasks[0].conversationId;
		const second = await f.request(
			`/api/rooms/${f.room.id}/conversations/${conversationId}/messages`,
			{ text: "second", contract: { id: "sealed", goal: "second" } },
			f.cookie,
		);
		const task = second.body.tasks[0];
		await f.hub.store.transact((draft) => {
			const current = draft.tasks.find((t) => t.id === task.id)!;
			current.contextManifest = createContextManifest({ contract: current.contract!, context: null, taskState: null });
			const conversation = draft.conversations.find((c) => c.id === conversationId)!;
			conversation.taskState = { ...conversation.taskState!, objective: "new mutable state" };
		});
		await f.hub.acceptTaskEvent(f.device.deviceId, outcome(f, first.body.tasks[0]));
		const wire = f.deliveredTasks.find((t) => t.id === task.id);
		expect(wire.context).toBeUndefined();
		expect(wire.taskState).toBeUndefined();
		expect(wire.contextManifest.context).toBeNull();
		expect(wire.contextManifest.taskState).toBeNull();
	});

	it("keeps a near-budget contract and snapshot with JSON-escaped text below the actual relay frame ceiling", async () => {
		const f = await fixture();
		for (let i = 0; i < 6; i++) {
			const prior = await f.request(
				`/api/rooms/${f.room.id}/messages`,
				{ text: "h".repeat(15000), targetBotIds: [f.bot.id] },
				f.cookie,
			);
			await f.hub.acceptTaskEvent(f.device.deviceId, outcome(f, prior.body.tasks[0]));
		}
		const body = {
			text: String.fromCharCode(0).repeat(15000),
			targetBotIds: [f.bot.id],
			executionMode: "code",
			contract: {
				id: "large-aggregate",
				goal: "execute sealed contract",
				baseline,
				constraints: Array.from({ length: 64 }, () => "a".repeat(2048)),
				acceptanceCriteria: Array.from({ length: 64 }, (_, i) => "b".repeat(i === 63 ? 700 : 2048)),
			},
		};
		expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(MAX_CONTRACT_REQUEST_BYTES);
		const res = await f.request(`/api/rooms/${f.room.id}/messages`, body, f.cookie);
		expect(res.status).toBe(200);
		const wire = f.deliveredTasks.find((t) => t.id === res.body.tasks[0].id);
		expect(wire).toBeDefined();
		const manifest = wire.contextManifest;
		expect(Buffer.byteLength(JSON.stringify(wire.contract))).toBeGreaterThan(MAX_WORK_CONTRACT_BYTES - 2048);
		expect(Buffer.byteLength(JSON.stringify(manifest))).toBeGreaterThan(MAX_CONTEXT_MANIFEST_BYTES - 8192);
		expect(manifest.context.messages.filter((m: any) => m.text === "h".repeat(15000))).toHaveLength(6);
		expect(manifest.taskState.objective).toBe("h".repeat(2048));
		expect(wire.context).toBeUndefined();
		expect(wire.taskState).toBeUndefined();
		const frame = { type: "task", task: wire };
		expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThanOrEqual(RELAY_LIMITS.frame);
		// The formerly duplicated legacy fields made this same valid request exceed 512 KiB.
		expect(
			Buffer.byteLength(
				JSON.stringify({ ...frame, task: { ...wire, context: manifest.context, taskState: manifest.taskState } }),
			),
		).toBeGreaterThan(RELAY_LIMITS.frame);
	});

	it("preserves legacy snapshot fields when no manifest is present", async () => {
		const f = await fixture();
		const res = await f.request(
			`/api/rooms/${f.room.id}/messages`,
			{ text: "legacy context", targetBotIds: [f.bot.id] },
			f.cookie,
		);
		const wire = f.deliveredTasks.find((t) => t.id === res.body.tasks[0].id);
		expect(wire.contextManifest).toBeUndefined();
		expect(wire.context.roomName).toBe("test-room");
		expect(wire.taskState.objective).toBe("legacy context");
	});

	it("rejects an oversized persisted delivery before invoking the relay", async () => {
		const f = await fixture();
		const first = await f.request(
			`/api/rooms/${f.room.id}/messages`,
			{ text: "blocker", targetBotIds: [f.bot.id] },
			f.cookie,
		);
		const next = await f.request(
			`/api/rooms/${f.room.id}/conversations/${first.body.tasks[0].conversationId}/messages`,
			{ text: "queued", contract: { id: "stored-budget", goal: "queued" } },
			f.cookie,
		);
		const task = next.body.tasks[0];
		await f.hub.store.transact((draft) => {
			draft.tasks.find((t) => t.id === task.id)!.text = String.fromCharCode(0).repeat(
				Math.ceil(RELAY_LIMITS.frame / 6),
			);
		});
		await f.hub.acceptTaskEvent(f.device.deviceId, outcome(f, first.body.tasks[0]));
		expect(f.deliveredTasks.some((t) => t.id === task.id)).toBe(false);
		const rejected = f.hub.store.snapshot().tasks.find((t) => t.id === task.id)!;
		expect(rejected.status).toBe("failed");
		expect(rejected.report).toMatch(/exceeds relay frame size/);
	});

	it("rejects JSON requests above the aggregate creation budget", async () => {
		const f = await fixture();
		const res = await f.request(
			`/api/rooms/${f.room.id}/messages`,
			{
				text: "oversized",
				targetBotIds: [f.bot.id],
				contract: { goal: "oversized" },
				padding: "x".repeat(MAX_CONTRACT_REQUEST_BYTES),
			},
			f.cookie,
		);
		expect(res.status).toBe(413);
		expect(f.deliveredTasks).toHaveLength(0);
	});

	it.each(["messages", "tasks", "conversations", "conversation-turn"])(
		"accepts a full 128 KiB patch through %s without duplicating it in the manifest",
		async (route) => {
			const f = await fixture();
			let path = `/api/rooms/${f.room.id}/${route}`;
			if (route === "conversation-turn") {
				const first = await f.request(
					`/api/rooms/${f.room.id}/messages`,
					{ text: "start", targetBotIds: [f.bot.id] },
					f.cookie,
				);
				await f.hub.acceptTaskEvent(f.device.deviceId, outcome(f, first.body.tasks[0]));
				path = `/api/rooms/${f.room.id}/conversations/${first.body.tasks[0].conversationId}/messages`;
			}
			const art = inputArtifact(Buffer.alloc(MAX_PATCH_BYTES));
			const res = await f.request(
				path,
				{
					text: "large patch",
					executionMode: "code",
					...(route === "conversations"
						? { targetBotId: f.bot.id }
						: route === "conversation-turn"
							? {}
							: { targetBotIds: [f.bot.id] }),
					contract: { id: "large", goal: "large patch", baseline, inputArtifacts: [art] },
				},
				f.cookie,
			);
			expect(res.status).toBe(200);
			const wire = f.deliveredTasks.find((t) => t.id === res.body.tasks[0].id);
			expect(wire.contextManifest.inputs).toEqual([{ id: art.id, digest: art.digest }]);
			expect(Buffer.byteLength(JSON.stringify(wire))).toBeLessThan(512 * 1024);
		},
	);

	it("stores detached artifact evidence and pages raw patch bytes with an immutable digest guard", async () => {
		const f = await fixture();
		const res = await f.request(
			`/api/rooms/${f.room.id}/messages`,
			{ text: "artifact", targetBotIds: [f.bot.id] },
			f.cookie,
		);
		const task = res.body.tasks[0];
		const patch = Buffer.alloc(50001, 123);
		const art = inputArtifact(patch);
		await f.hub.store.transact((draft) => {
			draft.tasks.find((t) => t.id === task.id)!.artifact = art;
		});
		art.producer.taskId = "mutated";
		art.patchBase64 = "";
		expect(f.hub.store.snapshot().tasks.find((t) => t.id === task.id)!.artifact!.producer.taskId).toBe("t");
		const path = `/api/rooms/${f.room.id}/conversations/${task.conversationId}/evidence?evidenceKind=artifact&taskId=${task.id}`;
		const chunks: Buffer[] = [];
		let offset: number | null = 0;
		while (offset !== null) {
			const page = await f.request(
				`${path}&offset=${offset}&limit=24576&expectedDigest=${art.digest}`,
				undefined,
				f.cookie,
			);
			expect(page.status).toBe(200);
			expect(page.body.artifact.patchBase64).toBeUndefined();
			expect(page.body.content.encoding).toBe("base64");
			expect(page.body.content.totalBytes).toBe(patch.length);
			chunks.push(Buffer.from(page.body.content.data, "base64"));
			offset = page.body.content.nextOffset;
		}
		expect(Buffer.concat(chunks)).toEqual(patch);
		expect((await f.request(`${path}&expectedDigest=wrong`, undefined, f.cookie)).status).toBe(409);
		expect((await f.request(`${path}&limit=24577`, undefined, f.cookie)).status).toBe(400);
		expect((await f.request(`${path}&offset=50002`, undefined, f.cookie)).status).toBe(400);
	});

	it("accepts exact legacy chat receipt retries for room and conversation APIs", async () => {
		const f = await fixture();
		const body = { text: "legacy", targetBotIds: [f.bot.id], idempotencyKey: "legacy-room" };
		const first = await f.request(`/api/rooms/${f.room.id}/messages`, body, f.cookie);
		const legacy = createHash("sha256")
			.update(
				JSON.stringify({
					content: "legacy",
					targets: [f.bot.id],
					kind: "message",
					planOnly: false,
					senderType: "human",
				}),
			)
			.digest("hex");
		await f.hub.store.transact((draft) => {
			draft.receipts.find((r) => r.key === body.idempotencyKey)!.fingerprint = legacy;
		});
		const roomRetry = await f.request(`/api/rooms/${f.room.id}/messages`, body, f.cookie);
		expect(roomRetry.status).toBe(200);
		expect(roomRetry.body.tasks[0].id).toBe(first.body.tasks[0].id);
		const conversationId = first.body.tasks[0].conversationId;
		const path = `/api/rooms/${f.room.id}/conversations/${conversationId}/messages`;
		const turn = { text: "turn", idempotencyKey: "legacy-turn" };
		const turnFirst = await f.request(path, turn, f.cookie);
		expect(turnFirst.status).toBe(200);
		const turnLegacy = createHash("sha256")
			.update(
				JSON.stringify({
					content: "turn",
					targets: [],
					conversationId,
					kind: "message",
					planOnly: false,
					senderType: "human",
				}),
			)
			.digest("hex");
		await f.hub.store.transact((draft) => {
			draft.conversationMessages.find((m) => m.idempotencyKey === turn.idempotencyKey)!.fingerprint = turnLegacy;
		});
		const retry = await f.request(path, turn, f.cookie);
		expect(retry.status).toBe(200);
		expect(retry.body.tasks[0].id).toBe(turnFirst.body.tasks[0].id);
		expect((await f.request(path, { ...turn, text: "changed" }, f.cookie)).status).toBe(409);
	});

	it.each([
		null,
		3,
		false,
		[],
		{ id: " " },
		{ executionMode: null },
		{ revision: null },
		{ goal: null },
		{ inputArtifacts: false },
		{ baseline: false },
	])("rejects malformed explicit contract %j", async (contract) => {
		const f = await fixture();
		expect(
			(
				await f.request(
					`/api/rooms/${f.room.id}/messages`,
					{ text: "invalid", targetBotIds: [f.bot.id], contract },
					f.cookie,
				)
			).status,
		).toBe(400);
	});
});
