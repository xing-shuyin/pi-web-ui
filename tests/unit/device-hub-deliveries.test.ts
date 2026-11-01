import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceHubStore, type HubState, type Bot } from "../../server/device-center/store.js";
import { addDelivery, addReview, deliverySummary } from "../../server/device-center/hub-deliveries.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "hub-deliveries-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	const store = await DeviceHubStore.open(dir);
	const developer: Bot = {
		id: "dev",
		deviceId: "d",
		accountId: "a",
		name: "Developer",
		description: "",
		enabled: true,
		revision: 1,
		createdAt: 1,
		updatedAt: 1,
	};
	const reviewer = { ...developer, id: "reviewer", deviceId: "r" };
	await store.transact((s) => {
		s.devices.push(...["d", "r"].map((id) => ({ id, accountId: "a", name: id, credentialHash: "", createdAt: 1 })));
		s.bots.push(developer, reviewer);
		s.rooms.push({ id: "room", accountId: "a", name: "Room", botIds: ["dev", "reviewer"], createdAt: 1 });
		for (const bot of [developer, reviewer]) {
			s.conversations.push({
				id: bot.id,
				accountId: "a",
				roomId: "room",
				botId: bot.id,
				deviceId: bot.deviceId,
				botRevision: 1,
				name: bot.name,
				rootTaskId: bot.id,
				latestTaskId: bot.id,
				dispatchDepth: 0,
				createdAt: 1,
				updatedAt: 1,
			});
			s.tasks.push({
				id: bot.id,
				conversationId: bot.id,
				accountId: "a",
				roomId: "room",
				botId: bot.id,
				deviceId: bot.deviceId,
				botRevision: 1,
				attemptId: "attempt",
				text: "work",
				status: "running",
				createdAt: 1,
				updatedAt: 1,
			});
		}
	});
	const actor = { accountId: "a", bot: developer };
	const input = {
		sourceBotId: "dev",
		parentTaskId: "dev",
		idempotencyKey: "d1",
		repository: "https://github.com/example/repo.git",
		baseCommit: "a".repeat(40),
		commit: "b".repeat(40),
		summary: "Implementation",
		checks: [{ command: "npm test", status: "passed", exitCode: 0 }],
	};
	return { store, dir, developer, reviewer, actor, input };
}
function rejects(work: (s: HubState) => unknown, store: DeviceHubStore, status: number) {
	return expect(store.transact(work)).rejects.toMatchObject({ status });
}
describe("immutable development deliveries", () => {
	it("persists append-only delivery/review histories independently of execution and resets current review on new delivery", async () => {
		const { store, actor, input, reviewer, dir } = await fixture();
		const delivery = await store.transact((s) => addDelivery(s, "room", "dev", actor, input));
		expect(delivery.checks[0].source).toBe("bot_reported");
		expect(delivery.limitations).toEqual([]);
		expect(await store.transact((s) => addDelivery(s, "room", "dev", actor, { ...input }))).toEqual(delivery);
		const reviewInput = {
			sourceBotId: "reviewer",
			parentTaskId: "reviewer",
			idempotencyKey: "r1",
			deliveryId: delivery.id,
			commit: delivery.commit,
			verdict: "changes_requested",
			summary: "Add regression coverage",
		};
		const review = await store.transact((s) =>
			addReview(s, "room", "dev", { accountId: "a", bot: reviewer }, reviewInput),
		);
		expect(deliverySummary(store.snapshot(), "dev").latestReview).toEqual(review);
		const second = await store.transact((s) =>
			addDelivery(s, "room", "dev", actor, { ...input, idempotencyKey: "d2", commit: "c".repeat(64) }),
		);
		expect(deliverySummary(store.snapshot(), "dev").latestReview).toBeUndefined();
		await rejects(
			(s) =>
				addReview(
					s,
					"room",
					"dev",
					{ accountId: "a" },
					{ ...reviewInput, sourceBotId: undefined, parentTaskId: undefined, idempotencyKey: "old" },
				),
			store,
			409,
		);
		await store.transact((s) =>
			addReview(
				s,
				"room",
				"dev",
				{ accountId: "a" },
				{
					idempotencyKey: "accept",
					deliveryId: second.id,
					commit: second.commit,
					verdict: "accepted",
					summary: "Verified",
				},
			),
		);
		expect((await DeviceHubStore.open(dir)).snapshot().deliveries).toEqual([delivery, second]);
		expect(store.snapshot().reviews).toHaveLength(2);
		expect(store.snapshot().tasks[0].status).toBe("running");
	});
	it("rejects self review, foreign account/room/task and stale task or Bot revision", async () => {
		const { store, actor, input } = await fixture();
		const delivery = await store.transact((s) => addDelivery(s, "room", "dev", actor, input));
		await rejects(
			(s) =>
				addReview(s, "room", "dev", actor, {
					sourceBotId: "dev",
					parentTaskId: "dev",
					idempotencyKey: "r",
					deliveryId: delivery.id,
					commit: delivery.commit,
					verdict: "accepted",
					summary: "self",
				}),
			store,
			403,
		);
		await rejects((s) => addDelivery(s, "room", "dev", { ...actor, accountId: "foreign" }, input), store, 404);
		await rejects((s) => addDelivery(s, "wrong", "dev", actor, input), store, 404);
		await rejects((s) => addDelivery(s, "room", "dev", actor, { ...input, parentTaskId: "reviewer" }), store, 403);
		await store.transact((s) => {
			s.conversations[0].latestTaskId = "new";
		});
		await rejects((s) => addDelivery(s, "room", "dev", actor, input), store, 403);
		await store.transact((s) => {
			s.conversations[0].latestTaskId = "dev";
			s.bots[0].revision++;
		});
		await rejects((s) => addDelivery(s, "room", "dev", actor, input), store, 403);
	});
	it("detects idempotency conflicts and validates exact SHA, fields, credentials and budgets", async () => {
		const { store, actor, input } = await fixture();
		await store.transact((s) => addDelivery(s, "room", "dev", actor, input));
		await rejects((s) => addDelivery(s, "room", "dev", actor, { ...input, summary: "Changed" }), store, 409);
		for (const patch of [
			{ commit: "abc123" },
			{ baseCommit: "x".repeat(40) },
			{ repository: "https://user:secret@example.com/repo" },
			{ repository: "https://example.com/repo?token=secret" },
			{ checks: [{ command: "test", status: "passed", source: "verified" }] },
			{ checks: [{ command: "test", status: "unknown" }] },
			{ checks: [{ command: "test", status: "passed", exitCode: 1.5 }] },
			{ summary: "x".repeat(8193) },
			{ limitations: Array(33).fill("x") },
			{ extra: true },
		])
			await rejects(
				(s) => addDelivery(s, "room", "dev", actor, { ...input, ...patch, idempotencyKey: "invalid" }),
				store,
				400,
			);
		await rejects(
			(s) =>
				addDelivery(s, "room", "dev", actor, {
					...input,
					idempotencyKey: "large",
					checks: Array(20).fill({ command: "test", status: "passed", result: "x".repeat(4000) }),
				}),
			store,
			413,
		);
		expect(store.snapshot().deliveries).toHaveLength(1);
	});
	it("permits terminal retries but rejects new writes and inconsistent checks", async () => {
		const { store, actor, input } = await fixture();
		const delivery = await store.transact((s) => addDelivery(s, "room", "dev", actor, input));
		for (const check of [
			{ command: "test", status: "passed", exitCode: 1 },
			{ command: "test", status: "failed", exitCode: 0 },
			{ command: "test", status: "not_run", exitCode: 0 },
		])
			await rejects(
				(s) => addDelivery(s, "room", "dev", actor, { ...input, idempotencyKey: "bad-check", checks: [check] }),
				store,
				400,
			);
		await store.transact((s) => {
			s.tasks[0].status = "completed";
		});
		expect(await store.transact((s) => addDelivery(s, "room", "dev", actor, input))).toEqual(delivery);
		await rejects((s) => addDelivery(s, "room", "dev", actor, { ...input, idempotencyKey: "new" }), store, 409);
	});
	it("serializes competing idempotent writes and refuses capacity overflow without eviction", async () => {
		const { store, actor, input } = await fixture();
		const records = await Promise.all(
			Array.from({ length: 4 }, () => store.transact((s) => addDelivery(s, "room", "dev", actor, input))),
		);
		expect(new Set(records.map((r) => r.id)).size).toBe(1);
		await store.transact((s) => {
			s.deliveries = Array.from({ length: 200 }, (_, i) => ({ ...records[0], id: `history-${i}` }));
		});
		await rejects((s) => addDelivery(s, "room", "dev", actor, { ...input, idempotencyKey: "overflow" }), store, 409);
		expect(store.snapshot().deliveries).toHaveLength(200);
	});
	it("keeps complete detail evidence while explicitly bounding list summaries", async () => {
		const { store, actor, input } = await fixture();
		const delivery = await store.transact((s) =>
			addDelivery(s, "room", "dev", actor, {
				...input,
				repository: "C:\\Work Folder\\repo",
				summary: "x".repeat(1000),
				checks: [{ command: "test", status: "passed", result: "full evidence" }],
			}),
		);
		const summary = deliverySummary(store.snapshot(), "dev", true);
		expect(summary.deliverySummaryTruncated).toBe(true);
		expect(summary.latestDelivery?.summary).toHaveLength(512);
		expect(summary.latestDelivery?.checks[0].result).toBeUndefined();
		expect(store.snapshot().deliveries[0]).toEqual(delivery);
	});
	it("does not publish when durable storage fails", async () => {
		const { store, actor, input } = await fixture();
		await rm(store.path);
		await mkdir(store.path);
		await expect(store.transact((s) => addDelivery(s, "room", "dev", actor, input))).rejects.toThrow();
		expect(store.snapshot().deliveries).toEqual([]);
	});
	it("migrates old v2 stores without delivery fields", async () => {
		const { store, dir } = await fixture();
		const old = JSON.parse(await readFile(store.path, "utf8"));
		delete old.deliveries;
		delete old.reviews;
		delete old.deliveryReceipts;
		const { writeFile } = await import("node:fs/promises");
		await writeFile(store.path, JSON.stringify(old));
		const migrated = await DeviceHubStore.open(dir);
		expect(migrated.snapshot().deliveries).toEqual([]);
	});
});
