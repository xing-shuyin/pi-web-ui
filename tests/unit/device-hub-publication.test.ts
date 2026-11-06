import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { publicationFixture } from "../helpers/publish-intent-fixture.js";
import { DeviceHubStore, readPersistedHub } from "../../server/device-center/store.js";
import {
	hubCancelIntegration,
	hubConfirmIntegration,
	hubReconcileIntegration,
	hubResumeIntegration,
	reconcilePendingIntegrations,
} from "../../server/device-center/hub-integration.js";
import { assertNoApplyingIntegration } from "../../server/device-center/delivery-authority.js";
import {
	computeVerificationDigest,
	computeVerificationPlanDigest,
} from "../../server/device-center/integration-verification.js";
import type { DeviceIntegration, DevicePublishIntent } from "../../server/protocol.js";

const actor = { accountId: "account" };
const identity = (intent: DevicePublishIntent) => ({
	intentId: intent.id,
	intentDigest: intent.digest,
	candidateSha: intent.candidateSha,
});
const receipt = (intent: DevicePublishIntent, observedAt = 10) => ({
	...identity(intent),
	outcome: "applied" as const,
	proof: "cas_exit" as const,
	observedAt,
});
const observation = (intent: DevicePublishIntent, phase: "prepared" | "cas_started" | "unknown" = "cas_started") => ({
	...identity(intent),
	observedAt: 10,
	target: "expected_old" as const,
	targetSha: intent.expectedOld,
	phase,
	retryable: phase === "prepared",
});

describe("Hub durable publication intent and recovery", () => {
	let dir: string;
	let store: DeviceHubStore;
	let integration: DeviceIntegration;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "hub-publication-"));
		store = await DeviceHubStore.open(dir);
		const fixture = publicationFixture();
		integration = fixture.integration;
		await store.transact((draft) => {
			draft.rooms.push({ id: "room", accountId: "account", name: "Room", botIds: ["bot"], createdAt: 1 });
			draft.devices.push({ id: "device", accountId: "account", name: "Device", credentialHash: "hash", createdAt: 1 });
			draft.bots.push({
				id: "bot",
				accountId: "account",
				deviceId: "device",
				name: "Bot",
				description: "",
				enabled: true,
				revision: 1,
				createdAt: 1,
				updatedAt: 1,
			});
			draft.conversations.push({
				id: "conversation",
				roomId: "room",
				accountId: "account",
				botId: "bot",
				deviceId: "device",
				botRevision: 1,
				name: "Conversation",
				rootTaskId: "task",
				latestTaskId: "task",
				dispatchDepth: 0,
				createdAt: 1,
				updatedAt: 1,
			});
			draft.tasks.push({
				id: "task",
				attemptId: "attempt",
				accountId: "account",
				roomId: "room",
				conversationId: "conversation",
				botId: "bot",
				botRevision: 1,
				deviceId: "device",
				text: "Task",
				status: "running",
				createdAt: 1,
				updatedAt: 1,
			});
			draft.deliveries.push({
				...fixture.intent.delivery,
				commit: integration.commit,
				id: "delivery",
				accountId: "account",
				roomId: "room",
				conversationId: "conversation",
				botId: "bot",
				taskId: "task",
				repository: "repo:test",
				baseCommit: integration.expectedTargetSha,
				summary: "Delivered",
				checks: [],
				limitations: [],
				createdAt: 1,
			});
			draft.reviews.push(fixture.intent.review);
			draft.integrations.push(integration);
		});
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		await store?.close();
		await rm(dir, { recursive: true, force: true });
	});
	const confirm = (store: DeviceHubStore, driver: any, currentActor = actor) =>
		hubConfirmIntegration(store, "room", "conversation", "integration", currentActor, {}, driver);

	it("WAL intent persist failure dispatches zero publication RPC and leaves verification retryable", async () => {
		const rpc = vi.fn();
		vi.spyOn(store, "persist").mockRejectedValueOnce(new Error("intent fsync failed"));
		await expect(confirm(store, { callDeviceCommand: rpc })).rejects.toThrow(/fsync/);
		expect(rpc).not.toHaveBeenCalled();
		expect(store.snapshot().integrations[0]).toMatchObject({ status: "verified" });
		expect(store.snapshot().integrations[0].publishIntent).toBeUndefined();
		expect((await readPersistedHub(dir)).integrations[0].publishIntent).toBeUndefined();
	});

	it("rejects aggregate UTF-8 proof larger than relay budget before WAL reservation or RPC", async () => {
		await store.transact((draft) => {
			const record = draft.integrations[0];
			const commands = Array.from({ length: 8 }, () => "😀".repeat(2048));
			record.verificationPlan = {
				...record.verificationPlan!,
				commands,
				digest: computeVerificationPlanDigest(commands),
			};
			const facts = {
				...record.verification!,
				planDigest: record.verificationPlan.digest,
				results: commands.map((command) => ({
					command,
					status: "passed" as const,
					exitCode: 0,
					outputDigest: "d".repeat(64),
					outputPreview: "😀".repeat(8192),
				})),
			};
			const { digest: _digest, verifiedAt: _time, ...factsOnly } = facts;
			record.verification = { ...factsOnly, digest: computeVerificationDigest(record, factsOnly), verifiedAt: 1 };
		});
		const persist = vi.spyOn(store, "persist");
		const rpc = vi.fn();
		await expect(confirm(store, { callDeviceCommand: rpc })).rejects.toThrow(
			/aggregate proof exceeds transport budget/,
		);
		expect(persist).not.toHaveBeenCalled();
		expect(rpc).not.toHaveBeenCalled();
		expect(store.snapshot().integrations[0].publishIntent).toBeUndefined();
	});

	it("seals/fsyncs before RPC; repeated apply never re-dispatches; automatic recovery only queries", async () => {
		const rpc = vi.fn(async (_device, action, payload) => {
			const persisted = (await readPersistedHub(dir)).integrations[0];
			expect(persisted.publishIntent).toEqual(payload.publishIntent);
			expect(["integration_confirm", "integration_publication_status"]).toContain(action);
			return { status: "pending", publishObservation: observation(payload.publishIntent) };
		});
		const first = await confirm(store, { callDeviceCommand: rpc });
		expect(first.status).toBe("applying");
		await confirm(store, { callDeviceCommand: rpc });
		expect(rpc).toHaveBeenCalledTimes(1);
		await reconcilePendingIntegrations(store, { callDeviceCommand: rpc });
		await reconcilePendingIntegrations(store, { callDeviceCommand: rpc });
		expect(rpc.mock.calls.map((c) => c[1])).toEqual([
			"integration_confirm",
			"integration_publication_status",
			"integration_publication_status",
		]);
		expect(() => assertNoApplyingIntegration(store.snapshot(), "account", "room", "conversation")).toThrow(/freezes/);
	});

	it("post-CAS revoke cannot erase an applied receipt or require current actor/review authority", async () => {
		const bot = store.snapshot().bots[0];
		const result = await confirm(
			store,
			{
				callDeviceCommand: async (_device: string, _action: string, payload: any) => {
					await store.transact((draft) => {
						draft.bots = [];
						draft.reviews = [];
						draft.rooms[0].botIds = [];
						draft.tasks[0].status = "failed";
					});
					return { status: "applied", publishReceipt: receipt(payload.publishIntent) };
				},
			},
			{ accountId: "account", bot } as any,
		);
		expect(result.status).toBe("applied");
		expect(result.publishIntent!.actor).toMatchObject({ botId: "bot", botDeviceId: "device", taskId: "task" });
		expect(result.publishReceipt).toEqual(receipt(result.publishIntent!));
		expect((await readPersistedHub(dir)).integrations[0].publishReceipt).toEqual(result.publishReceipt);
	});

	it("Hub WAL failure after device success keeps original intent recoverable by read-only receipt query", async () => {
		let knownIntent!: DevicePublishIntent;
		await expect(
			confirm(store, {
				callDeviceCommand: async (_d: string, _a: string, p: any) => {
					knownIntent = p.publishIntent;
					vi.spyOn(store, "persist").mockRejectedValueOnce(new Error("receipt WAL unavailable"));
					return { status: "applied", publishReceipt: receipt(knownIntent) };
				},
			}),
		).rejects.toThrow(/WAL unavailable/);
		expect(store.snapshot().integrations[0].publishReceipt).toBeUndefined();
		expect(store.snapshot().integrations[0].publishIntent).toEqual(knownIntent);
		const rpc = vi.fn(async () => ({ status: "applied", publishReceipt: receipt(knownIntent) }));
		const recovered = await hubReconcileIntegration(store, "room", "conversation", actor, "integration", {
			callDeviceCommand: rpc,
		});
		expect(recovered.status).toBe("applied");
		expect(rpc.mock.calls).toHaveLength(1);
	});

	it("exact owner resume consumes only proven not-started intent; cas_started with old target is unsafe", async () => {
		const calls: any[] = [];
		await confirm(store, {
			callDeviceCommand: async (_d: string, _a: string, p: any) => ({
				status: "pending",
				publishObservation: observation(p.publishIntent),
			}),
		});
		let current = store.snapshot().integrations[0];
		const input = identity(current.publishIntent!);
		await expect(
			hubResumeIntegration(store, "room", "conversation", actor, "integration", input, { callDeviceCommand: vi.fn() }),
		).rejects.toThrow(/not proven safe/);
		await hubReconcileIntegration(store, "room", "conversation", actor, "integration", {
			callDeviceCommand: async () => ({
				status: "pending",
				publishObservation: observation(current.publishIntent!, "prepared"),
			}),
		});
		await expect(
			hubResumeIntegration(
				store,
				"room",
				"conversation",
				{ ...actor, bot: store.snapshot().bots[0] },
				"integration",
				input,
			),
		).rejects.toThrow(/human account owner/);
		await expect(
			hubResumeIntegration(store, "room", "conversation", actor, "integration", {
				...input,
				candidateSha: integration.commit!,
			}),
		).rejects.toThrow(/exact/);
		current = await hubResumeIntegration(store, "room", "conversation", actor, "integration", input, {
			callDeviceCommand: async (_d, action, payload) => {
				calls.push({ action, payload });
				return { status: "applied", publishReceipt: receipt((payload as any).publishIntent) };
			},
		});
		expect(calls).toHaveLength(1);
		expect(calls[0].payload.mode).toBe("resume");
		expect(calls[0].payload.publishIntent).toEqual(current.publishIntent);
		expect(current.publishReceipt!.candidateSha).toBe(input.candidateSha);
	});

	it("safe journal phase cannot override revoked current resume authority", async () => {
		await confirm(store, {
			callDeviceCommand: async (_d: string, _a: string, p: any) => ({
				status: "pending",
				publishObservation: observation(p.publishIntent, "prepared"),
			}),
		});
		await store.transact((draft) => {
			draft.reviews = [];
		});
		const rpc = vi.fn();
		await expect(
			hubResumeIntegration(
				store,
				"room",
				"conversation",
				actor,
				"integration",
				identity(store.snapshot().integrations[0].publishIntent!),
				{ callDeviceCommand: rpc },
			),
		).rejects.toThrow(/accepted|review/i);
		expect(rpc).not.toHaveBeenCalled();
	});

	it("closed unknown tombstone releases future authority while preserving uncertain past effect", async () => {
		await confirm(store, {
			callDeviceCommand: async () => {
				throw new Error("ACK lost");
			},
		}).catch(() => {});
		const result = await hubCancelIntegration(store, "room", "conversation", "integration", actor, {
			callDeviceCommand: async (_d, action, payload) => {
				expect(action).toBe("integration_cancel");
				const intent = (payload as any).publishIntent;
				return {
					status: "pending",
					publishStop: {
						...identity(intent),
						closed: true,
						stopConfirmed: true,
						pastEffect: "unknown",
						fencedAt: 11,
						stoppedAt: 11,
					},
				};
			},
		});
		expect(result.status).toBe("cancelling");
		expect(result.error).toMatch(/historical outcome remains unknown/);
		expect(result.publishStop).toMatchObject({ closed: true, pastEffect: "unknown" });
		expect(() => assertNoApplyingIntegration(store.snapshot(), "account", "room", "conversation")).not.toThrow();
	});

	it("cancel sends full reserved intent before delayed confirm and applied wins over cancellation/stale failure", async () => {
		let release!: (value: unknown) => void;
		let started!: () => void;
		const start = new Promise<void>((r) => {
			started = r;
		});
		const pending = confirm(store, {
			callDeviceCommand: async () => {
				started();
				return new Promise((r) => {
					release = r;
				});
			},
		});
		await start;
		const intent = store.snapshot().integrations[0].publishIntent!;
		const stopped = await hubCancelIntegration(store, "room", "conversation", "integration", actor, {
			callDeviceCommand: async (_d, _a, payload) => {
				expect((payload as any).publishIntent).toEqual(intent);
				return {
					status: "applied",
					publishReceipt: receipt(intent),
					publishStop: {
						...identity(intent),
						closed: true,
						stopConfirmed: true,
						pastEffect: "applied",
						fencedAt: 11,
						stoppedAt: 11,
					},
				};
			},
		});
		expect(stopped.status).toBe("applied");
		release({
			status: "applied",
			publishReceipt: { ...receipt(intent, 20), proof: "target_exact", targetSha: intent.candidateSha },
		});
		await pending;
		expect(store.snapshot().integrations[0].publishReceipt).toEqual(receipt(intent));
		await expect(
			hubReconcileIntegration(store, "room", "conversation", actor, "integration", {
				callDeviceCommand: async () => {
					throw new Error("stale failure");
				},
			}),
		).rejects.toThrow(/stale failure/);
		expect(store.snapshot().integrations[0].status).toBe("applied");
	});

	it("does not downgrade historical receipt when target moves to old/other/missing; forged proof is rejected", async () => {
		const applied = await confirm(store, {
			callDeviceCommand: async (_d: string, _a: string, p: any) => ({
				status: "applied",
				publishReceipt: receipt(p.publishIntent),
			}),
		});
		for (const target of ["expected_old", "other", "missing"] as const) {
			const result = await hubReconcileIntegration(store, "room", "conversation", actor, "integration", {
				callDeviceCommand: async () => ({
					status: "pending",
					publishObservation: {
						...observation(applied.publishIntent!),
						target,
						...(target === "missing" ? { targetSha: undefined } : {}),
					},
				}),
			});
			expect(result.status).toBe("applied");
			expect(result.publishObservation!.target).toBe(target);
			expect(result.publishReceipt).toEqual(applied.publishReceipt);
		}
		await expect(
			hubReconcileIntegration(store, "room", "conversation", actor, "integration", {
				callDeviceCommand: async () => ({
					status: "applied",
					publishReceipt: { ...receipt(applied.publishIntent!), intentId: "forged" },
				}),
			}),
		).rejects.toThrow(/identity/);
		expect(store.snapshot().integrations[0].publishReceipt).toEqual(applied.publishReceipt);
	});

	it("round-robins bounded scans and deduplicates simultaneous startup/ready recovery", async () => {
		await store.transact((draft) => {
			draft.integrations = Array.from({ length: 19 }, (_, n) => {
				const f = publicationFixture("sha1", `integration-${n}`);
				return { ...f.integration, status: "applying" as const, publishIntent: f.intent };
			});
		});
		const seen = new Set<string>();
		let active = 0,
			maxActive = 0;
		const rpc = vi.fn(async (_d: string, action: string, payload: any) => {
			expect(action).toBe("integration_publication_status");
			seen.add(payload.integrationId);
			active++;
			maxActive = Math.max(maxActive, active);
			await new Promise<void>((resolve) => setTimeout(resolve, 1));
			active--;
			return { status: "pending", publishObservation: observation(payload.publishIntent) };
		});
		await Promise.all([
			reconcilePendingIntegrations(store, { callDeviceCommand: rpc }, { limit: 16 }),
			reconcilePendingIntegrations(store, { callDeviceCommand: rpc }, { deviceId: "device", limit: 16 }),
		]);
		expect(rpc).toHaveBeenCalledTimes(16);
		// A device-specific empty scan must not reset the global scan's next-page cursor.
		await reconcilePendingIntegrations(store, { callDeviceCommand: rpc }, { deviceId: "another-device", limit: 16 });
		await reconcilePendingIntegrations(store, { callDeviceCommand: rpc }, { limit: 16 });
		expect(seen.size).toBe(19);
		expect(maxActive).toBeLessThanOrEqual(4);
	});

	it("future fence without confirmed child stop stays frozen and queried; delayed weaker stop cannot reopen it", async () => {
		await confirm(store, {
			callDeviceCommand: async (_d: string, _a: string, p: any) => ({
				status: "pending",
				publishObservation: observation(p.publishIntent, "prepared"),
			}),
		});
		const intent = store.snapshot().integrations[0].publishIntent!;
		const stop = { ...identity(intent), closed: true, stopConfirmed: false, pastEffect: "unknown", fencedAt: 10 };
		const pending = await hubCancelIntegration(store, "room", "conversation", "integration", actor, {
			callDeviceCommand: async () => ({ status: "pending", publishStop: stop }),
		});
		expect(pending.status).toBe("cancelling");
		expect(pending.publishObservation!.retryable).toBe(false);
		expect(() => assertNoApplyingIntegration(store.snapshot(), "account", "room")).toThrow(/freezes/);
		await expect(
			hubResumeIntegration(store, "room", "conversation", actor, "integration", identity(intent)),
		).rejects.toThrow(/closed/);
		const query = vi.fn(async () => ({
			status: "cancelled",
			publishStop: { ...stop, stopConfirmed: true, pastEffect: "not_applied", stoppedAt: 20 },
		}));
		await reconcilePendingIntegrations(store, { callDeviceCommand: query });
		expect(query).toHaveBeenCalledTimes(1);
		expect(store.snapshot().integrations[0].status).toBe("cancelled");
		await hubReconcileIntegration(store, "room", "conversation", actor, "integration", {
			callDeviceCommand: async () => ({ status: "pending", publishStop: stop }),
		});
		expect(store.snapshot().integrations[0]).toMatchObject({
			status: "cancelled",
			publishStop: { stopConfirmed: true, stoppedAt: 20 },
		});
		expect(() => assertNoApplyingIntegration(store.snapshot(), "account", "room")).not.toThrow();
	});

	it("an applied receipt cannot release future authority while the original Git child stop is unconfirmed", async () => {
		const applied = await confirm(store, {
			callDeviceCommand: async (_d: string, _a: string, p: any) => ({
				status: "applied",
				publishReceipt: receipt(p.publishIntent),
				publishStop: {
					...identity(p.publishIntent),
					closed: true,
					stopConfirmed: false,
					pastEffect: "applied",
					fencedAt: 10,
				},
			}),
		});
		expect(applied.status).toBe("applied");
		expect(() => assertNoApplyingIntegration(store.snapshot(), "account", "room")).toThrow(/freezes/);
		const query = vi.fn(async () => ({
			status: "applied",
			publishReceipt: applied.publishReceipt,
			publishStop: applied.publishStop,
		}));
		await reconcilePendingIntegrations(store, { callDeviceCommand: query });
		expect(query).toHaveBeenCalledTimes(1);
		expect(store.snapshot().integrations[0].status).toBe("applied");
		const stopped = await hubCancelIntegration(store, "room", "conversation", "integration", actor, {
			callDeviceCommand: async (_d, action) => {
				expect(action).toBe("integration_cancel");
				return {
					status: "applied",
					publishReceipt: applied.publishReceipt,
					publishStop: { ...applied.publishStop, stopConfirmed: true, stoppedAt: 20 },
				};
			},
		});
		expect(stopped.status).toBe("applied");
		expect(stopped.publishReceipt).toEqual(applied.publishReceipt);
		expect(() => assertNoApplyingIntegration(store.snapshot(), "account", "room")).not.toThrow();
		await reconcilePendingIntegrations(store, { callDeviceCommand: query });
		expect(query).toHaveBeenCalledTimes(1);
	});

	it("legacy unknown apply failure stays frozen and cannot be cleaned into a false cancellation", async () => {
		await store.transact((draft) => {
			draft.integrations[0].status = "failed";
			draft.integrations[0].cleanupPending = true;
			draft.integrations[0].error = "Apply failed; check target outcome: timeout";
		});
		const rpc = vi.fn();
		await expect(
			hubCancelIntegration(store, "room", "conversation", "integration", actor, { callDeviceCommand: rpc }),
		).rejects.toThrow(/manual investigation/);
		expect(rpc).not.toHaveBeenCalled();
		expect(() => assertNoApplyingIntegration(store.snapshot(), "account", "room")).toThrow(/freezes/);
	});

	it("legacy applied/in-flight records acquire neither synthesized intent nor automatic retry", async () => {
		const rpc = vi.fn();
		await store.transact((draft) => {
			draft.integrations[0].status = "applying";
		});
		await reconcilePendingIntegrations(store, { callDeviceCommand: rpc });
		expect(
			(await hubReconcileIntegration(store, "room", "conversation", actor, "integration", { callDeviceCommand: rpc }))
				.publishIntent,
		).toBeUndefined();
		await store.transact((draft) => {
			draft.integrations[0].status = "applied";
		});
		expect((await confirm(store, { callDeviceCommand: rpc })).publishReceipt).toBeUndefined();
		expect(rpc).not.toHaveBeenCalled();
	});
});
