import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceHubStore, type HubTask } from "../../server/device-center/store.js";
import { computeArtifactDigest, createWorkContract } from "../../server/device-center/work-contract.js";
import {
	conversationHasAuditRecords,
	conversationPage,
	trimClosedConversations,
	trimConversationHistory,
} from "../../server/device-center/hub-conversations.js";
import type { DeviceArtifact } from "../../server/protocol.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
});

function task(id: string): HubTask {
	return {
		id,
		attemptId: `${id}-attempt`,
		roomId: "room-1",
		accountId: "account-1",
		botId: "bot-1",
		deviceId: "device-1",
		botRevision: 1,
		text: "work",
		status: "completed",
		createdAt: 1,
		updatedAt: 1,
	};
}

function artifact(): DeviceArtifact {
	const patch = Buffer.from("x".repeat(70 * 1024));
	const value: DeviceArtifact = {
		id: "artifact-1",
		digest: "",
		producer: {
			deviceId: "device-1",
			botId: "bot-1",
			taskId: "evidence",
			attemptId: "evidence-attempt",
			contractDigest: "a".repeat(64),
			manifestDigest: "b".repeat(64),
		},
		baseline: { repositoryId: "repo-1", commit: "a".repeat(40) },
		inputTree: "b".repeat(40),
		outputTree: "c".repeat(40),
		patchBase64: patch.toString("base64"),
		patchSha256: createHash("sha256").update(patch).digest("hex"),
		createdAt: 1,
	};
	value.digest = computeArtifactDigest(value);
	return value;
}

async function store() {
	const dir = await mkdtemp(join(tmpdir(), "device-artifact-retention-"));
	cleanup.push(() => rm(dir, { recursive: true, force: true }));
	const db = await DeviceHubStore.open(dir);
	cleanup.push(() => db.close());
	await db.transact((state) => {
		state.rooms.push({ id: "room-1", accountId: "account-1", name: "Test", botIds: ["bot-1"], createdAt: 1 });
		state.tasks.push({
			...task("evidence"),
			conversationId: "conversation-1",
			executionMode: "code",
			executionCompleted: true,
			artifactProduced: true,
			artifact: artifact(),
		});
		state.conversations.push({
			id: "conversation-1",
			accountId: "account-1",
			roomId: "room-1",
			botId: "bot-1",
			deviceId: "device-1",
			botRevision: 1,
			name: "Test",
			rootTaskId: "evidence",
			latestTaskId: "evidence",
			dispatchDepth: 0,
			createdAt: 1,
			updatedAt: 1,
			closed: true,
		});
		state.conversationMessages.push({
			id: "message-1",
			conversationId: "conversation-1",
			taskId: "evidence",
			kind: "result",
			text: "Captured",
			createdAt: 1,
		});
		for (let i = 0; i < 502; i++) state.tasks.push(task(`ordinary-${i}`));
	});
	return { db, dir };
}

describe("immutable code evidence retention", () => {
	it.each(["chat", "code"] as const)(
		"retains %s contract authority even without execution or artifact proofs",
		async (executionMode) => {
			const { db, dir } = await store();
			const contract = createWorkContract({
				id: "durable-contract",
				revision: 3,
				executionMode,
				goal: "Preserve revision authority",
				...(executionMode === "code" ? { baseline: { repositoryId: "repo-1", commit: "a".repeat(40) } } : {}),
			});
			await db.transact((state) => {
				Object.assign(state.tasks[0]!, {
					contract,
					executionMode,
					status: "failed",
					executionCompleted: false,
					artifactProduced: false,
					artifact: undefined,
				});
				trimConversationHistory(state, "room-1", 1);
				trimClosedConversations(state, "room-1", 0);
			});
			expect(db.snapshot().conversations).toHaveLength(1);
			await db.close();
			const reopened = await DeviceHubStore.open(dir);
			cleanup.push(() => reopened.close());
			expect(reopened.snapshot().tasks.find((row) => row.id === "evidence")?.contract).toEqual(contract);
		},
	);

	it("protects code evidence and its conversation from automatic archive trimming", async () => {
		const { db } = await store();
		await db.transact((state) => {
			expect(conversationHasAuditRecords(state, "conversation-1")).toBe(true);
			trimConversationHistory(state, "room-1", 1);
			trimClosedConversations(state, "room-1", 0);
		});
		expect(db.snapshot().tasks.map((row) => row.id)).toEqual(["evidence", "ordinary-501"]);
		expect(db.snapshot().conversations).toHaveLength(1);
		expect(db.snapshot().conversationMessages).toHaveLength(1);
	});

	it("retains the original patch and independent facts when partition logs are reloaded", async () => {
		const { db, dir } = await store();
		const original = db.snapshot().tasks[0]!.artifact;
		await db.close();
		const reopened = await DeviceHubStore.open(dir);
		cleanup.push(() => reopened.close());
		const record = reopened.snapshot().tasks.find((row) => row.id === "evidence");
		expect(record?.artifact).toEqual(original);
		expect(record).toMatchObject({ executionCompleted: true, artifactProduced: true });
		expect(record).not.toHaveProperty("verificationPassed");
		expect(record).not.toHaveProperty("deliveryAccepted");
	});

	it("bounds conversation projections without changing the stored artifact", async () => {
		const { db } = await store();
		const state = db.snapshot();
		const original = state.tasks[0]!.artifact;
		const page = conversationPage(state, "conversation-1");
		expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(64 * 1024);
		expect(page.truncated).toBe(true);
		expect(page.tasks[0]).toMatchObject({ id: "evidence", artifactProduced: true });
		expect(page.tasks[0]?.artifact).toBeUndefined();
		expect(state.tasks[0]!.artifact).toEqual(original);
	});
});
