import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeviceTaskEventFrame } from "../../server/protocol.js";
import type { HubState, HubTask } from "../../server/device-center/store.js";
import { DeviceHubStore, hashSecret } from "../../server/device-center/store.js";
import { createServer, request as httpRequest, type Server } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import {
	createWorkContract,
	createContextManifest,
	computeArtifactDigest,
} from "../../server/device-center/work-contract.js";
import { WebSocket } from "ws";
import { createDeviceRelay, type DeviceRelayOptions } from "../../server/device-center/relay.js";
import { createDeviceConnector, type DeviceConnectorOptions } from "../../server/device-center/connector.js";
import { TaskRecoveryManager } from "../../server/device-center/task-recovery.js";
import { createDeviceHub } from "../../server/device-center/hub.js";
import { DEFAULT_EXECUTION_SETTINGS } from "../../server/device-center/execution-settings.js";
import { computeOutcomeFingerprint, computeLegacyOutcomeFingerprint } from "../../server/device-center/task-outcome.js";
import { establishConversation } from "../../server/device-center/hub-conversations.js";
import { reportUploadMetadata } from "../../server/device-center/report-metadata.js";
import {
	settleTaskTerminalOutcome,
	rescanReadyTasksOnRecovery,
	sweepExpiredRecoveryLeases,
} from "../../server/device-center/task-settlement.js";

const ctx = { settings: DEFAULT_EXECUTION_SETTINGS, getHistoryLimit: () => 500 };
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	vi.useRealTimers();
	for (const fn of cleanup.splice(0).reverse()) await fn();
});
function task(id: string, fields: Partial<HubTask> = {}): HubTask {
	return {
		id,
		attemptId: `attempt-${id}`,
		roomId: "room",
		accountId: "account",
		deviceId: "device",
		botId: "bot",
		botRevision: 1,
		text: id,
		status: "running",
		createdAt: 1,
		updatedAt: 1,
		...fields,
	};
}
function state(tasks: HubTask[]): HubState {
	return {
		accounts: [{ id: "account", username: "owner", passwordHash: "hash", createdAt: 1 }],
		devices: [
			{
				id: "device",
				accountId: "account",
				name: "device",
				credentialHash: hashSecret("credential"),
				uiCredentialHash: hashSecret("ui-credential"),
				createdAt: 1,
			},
		],
		bots: [
			{
				id: "bot",
				accountId: "account",
				deviceId: "device",
				name: "bot",
				description: "",
				enabled: true,
				revision: 1,
				createdAt: 1,
				updatedAt: 1,
			},
		],
		rooms: [{ id: "room", accountId: "account", name: "room", botIds: ["bot"], createdAt: 1 }],
		tasks,
		messages: [],
		conversations: [],
		conversationMessages: [],
		receipts: [],
	} as unknown as HubState;
}
function event(t: HubTask, fields: Partial<DeviceTaskEventFrame> = {}): DeviceTaskEventFrame {
	return {
		type: "task_event",
		taskId: t.id,
		attemptId: t.attemptId,
		botId: t.botId,
		status: "completed",
		report: "done",
		leaseToken: t.leaseToken,
		leaseGeneration: t.leaseGeneration,
		...fields,
	};
}

describe("device task settlement fault boundaries", () => {
	it("marks deleted attempts permanent only for the authenticated local Bot route", () => {
		const t = task("deleted");
		expect(settleTaskTerminalOutcome(state([]), "device", event(t), ctx)).toMatchObject({
			accepted: false,
			permanent: true,
			reasonCode: "attempt_expired",
		});
		for (const [deviceId, frame, tasks] of [
			["unknown-device", event(t), []],
			["device", event(t, { botId: "unknown-bot" }), []],
			["device", event(t), [task(t.id, { accountId: "other-account" })]],
			["device", event(t), [task(t.id, { deviceId: "other-device" })]],
		] as const) {
			const result = settleTaskTerminalOutcome(state([...tasks]), deviceId, frame, ctx);
			expect(result.accepted).toBe(false);
			expect(result.permanent).not.toBe(true);
		}
	});

	it("positively ACKs identical committed evidence even after a later stop flag", () => {
		const t = task("already-committed", { leaseToken: "lease", leaseGeneration: 1 });
		const draft = state([t]);
		const frame = event(t, { executionCompleted: true, artifactProduced: false });
		expect(settleTaskTerminalOutcome(draft, "device", frame, ctx).accepted).toBe(true);
		t.stopConfirmed = true;
		expect(settleTaskTerminalOutcome(draft, "device", frame, ctx)).toMatchObject({
			accepted: true,
			duplicate: true,
			fingerprint: t.outcomeFingerprint,
		});
	});

	it.each([
		{ leaseToken: undefined },
		{ leaseGeneration: undefined },
		{ leaseToken: "stale" },
		{ leaseGeneration: 1 },
		{ attemptId: "stale" },
	])("rejects unfenced terminal frames without mutating the draft: %j", (fields) => {
		const t = task("first", { leaseToken: "lease", leaseGeneration: 2 });
		const draft = state([t]);
		const before = structuredClone(draft);
		expect(settleTaskTerminalOutcome(draft, "device", event(t, fields), ctx).accepted).toBe(false);
		expect(draft).toEqual(before);
	});
	it.each(["cancelRequested", "stopConfirmed"] as const)("rejects completion protected by %s", (flag) => {
		const t = task("first", { [flag]: true });
		const draft = state([t]);
		expect(settleTaskTerminalOutcome(draft, "device", event(t), ctx).accepted).toBe(false);
		expect(t.status).toBe("running");
	});
	it("rejects forged digest before publishing or changing report metadata", () => {
		const t = task("first");
		const draft = state([t]);
		const before = structuredClone(draft);
		expect(settleTaskTerminalOutcome(draft, "device", event(t, { fingerprint: "forged" }), ctx).accepted).toBe(false);
		expect(draft).toEqual(before);
	});
	it("keeps committed content immutable on duplicate and conflicting terminal frames", () => {
		const t = task("first", { leaseToken: "lease", leaseGeneration: 2 });
		const draft = state([t]);
		const frame = event(t, { reportMetadata: reportUploadMetadata() });
		const accepted = settleTaskTerminalOutcome(draft, "device", frame, ctx);
		expect(accepted.accepted).toBe(true);
		expect(t.outcomeFingerprint).toBe(
			computeOutcomeFingerprint(t.id, t.attemptId, "completed", "done", undefined, reportUploadMetadata()),
		);
		expect(t.terminalAcceptedLeaseGeneration).toBe(2);
		const committed = structuredClone(draft);
		expect(settleTaskTerminalOutcome(draft, "device", frame, ctx)).toMatchObject({
			accepted: true,
			duplicate: true,
			fingerprint: t.outcomeFingerprint,
		});
		expect(draft).toEqual(committed);
		for (const fields of [
			{ error: "changed" },
			{ reportMetadata: { ...reportUploadMetadata(), rejected: true } },
			{ report: "changed" },
			{ status: "failed" as const },
		]) {
			expect(settleTaskTerminalOutcome(draft, "device", { ...frame, ...fields }, ctx).accepted).toBe(false);
			expect(draft).toEqual(committed);
		}
	});
	it.each(["failed", "interrupted", "completed"] as const)(
		"cascades an unsuccessful predecessor (%s) once through all descendants",
		(status) => {
			const first = task("first", { status, cancelRequested: status === "completed" });
			const second = task("second", { status: "waiting", dependsOnTaskId: first.id });
			const third = task("third", { status: "waiting", dependsOnTaskId: second.id });
			const draft = state([first, second, third]);
			rescanReadyTasksOnRecovery(draft, Date.now(), 60_000, ctx);
			expect(second.status).toBe("failed");
			expect(third.status).toBe("failed");
			const committed = structuredClone(draft);
			rescanReadyTasksOnRecovery(draft, Date.now(), 60_000, ctx);
			expect(draft).toEqual(committed);
		},
	);
	it("rescans a completed predecessor and injects its report exactly once", () => {
		const first = task("first", { status: "completed", report: "output" });
		const second = task("second", { status: "waiting", dependsOnTaskId: first.id });
		const draft = state([first, second]);
		expect(rescanReadyTasksOnRecovery(draft, Date.now(), 60_000, ctx).readyTaskIds).toContain(second.id);
		expect(second.status).toBe("queued");
		const text = second.text;
		rescanReadyTasksOnRecovery(draft, Date.now(), 60_000, ctx);
		expect(second.text).toBe(text);
	});
	it("does not fail downstream while an interrupted predecessor can still claim recovery", () => {
		const first = task("first", { status: "interrupted", leaseToken: "lease", recoveryUntil: Date.now() + 30_000 });
		const second = task("second", { status: "waiting", dependsOnTaskId: first.id });
		const draft = state([first, second]);
		rescanReadyTasksOnRecovery(draft, Date.now(), 60_000, ctx);
		expect(second.status).toBe("waiting");
		expect(settleTaskTerminalOutcome(draft, "device", event(first), ctx).accepted).toBe(true);
	});
	it("cannot adopt an interrupted terminal after the recovery window closes", () => {
		const first = task("first", { status: "interrupted", recoveryUntil: Date.now() - 1 });
		expect(settleTaskTerminalOutcome(state([first]), "device", event(first), ctx).accepted).toBe(false);
	});
	it("restores inconsistent unissued queued dependencies to waiting before dispatch", () => {
		const first = task("first");
		const second = task("second", { status: "queued", dependsOnTaskId: first.id });
		const draft = state([first, second]);
		rescanReadyTasksOnRecovery(draft, 100, 1000, ctx);
		expect(second.status).toBe("waiting");
		first.status = "completed";
		delete first.recoveryUntil;
		expect(rescanReadyTasksOnRecovery(draft, 200, 1000, ctx).readyTaskIds).toContain(second.id);
		expect(second.status).toBe("queued");
	});
	it("accepts the original wire outcome after full-report metadata hydration without reverting display metadata", () => {
		const t = task("metadata");
		const draft = state([t]);
		const metadata = { sha256: "a".repeat(64), totalBytes: 100, missing: false, rejected: false, uploadPending: true };
		const frame = event(t, { reportMetadata: metadata });
		const initial = settleTaskTerminalOutcome(draft, "device", frame, ctx);
		expect(initial.accepted).toBe(true);
		expect(t.outcomeCanonicalFingerprint).toBe(initial.fingerprint);
		t.reportMetadata = { ...metadata, uploadPending: false };
		const committed = structuredClone(draft);
		expect(settleTaskTerminalOutcome(draft, "device", frame, ctx)).toMatchObject({
			accepted: true,
			duplicate: true,
			fingerprint: initial.fingerprint,
		});
		expect(draft).toEqual(committed);
		expect(
			settleTaskTerminalOutcome(draft, "device", { ...frame, reportMetadata: { ...metadata, totalBytes: 200 } }, ctx)
				.accepted,
		).toBe(false);
		expect(draft).toEqual(committed);
	});
	it("backfills a verified legacy terminal digest without publishing another result", () => {
		const t = task("old-terminal", { status: "completed", report: "done", leaseToken: "lease", leaseGeneration: 1 });
		const draft = state([t]);
		const fingerprint = computeOutcomeFingerprint(t.id, t.attemptId, "completed", "done");
		expect(settleTaskTerminalOutcome(draft, "device", event(t), ctx)).toMatchObject({
			accepted: true,
			duplicate: true,
			fingerprint,
		});
		expect(t.outcomeFingerprint).toBe(fingerprint);
		expect(t.terminalAcceptedLeaseGeneration).toBe(1);
		expect(draft.messages).toHaveLength(0);
	});
	it("ACKs the original committed digest for identical content with either valid digest encoding", () => {
		const t = task("legacy-digest");
		const draft = state([t]);
		const legacy = computeLegacyOutcomeFingerprint(t.id, t.attemptId, "completed", "done");
		expect(settleTaskTerminalOutcome(draft, "device", event(t, { fingerprint: legacy }), ctx).accepted).toBe(true);
		const committed = structuredClone(draft);
		const canonical = computeOutcomeFingerprint(t.id, t.attemptId, "completed", "done");
		expect(settleTaskTerminalOutcome(draft, "device", event(t, { fingerprint: canonical }), ctx)).toMatchObject({
			accepted: true,
			duplicate: true,
			fingerprint: legacy,
		});
		expect(draft).toEqual(committed);
	});
	it("rejects legacy digest field-boundary collisions by comparing committed content", () => {
		const t = task("legacy");
		const draft = state([t]);
		const fingerprint = computeLegacyOutcomeFingerprint(t.id, t.attemptId, "failed", "a:b", "c");
		const first = event(t, { status: "failed", report: "a:b", error: "c", fingerprint });
		expect(settleTaskTerminalOutcome(draft, "device", first, ctx).accepted).toBe(true);
		const committed = structuredClone(draft);
		const collision = { ...first, report: "a", error: "b:c" };
		expect(computeLegacyOutcomeFingerprint(t.id, t.attemptId, "failed", collision.report, collision.error)).toBe(
			fingerprint,
		);
		expect(settleTaskTerminalOutcome(draft, "device", collision, ctx).accepted).toBe(false);
		expect(draft).toEqual(committed);
	});
	it("queues exactly one parent continuation when a recovery window expires", () => {
		const root = task("root", { status: "completed", rootTaskId: "root", dispatchDepth: 0 });
		const child = task("child", {
			status: "interrupted",
			parentTaskId: root.id,
			rootTaskId: root.id,
			dispatchDepth: 1,
			leaseToken: "lease",
			leaseGeneration: 1,
			recoveryUntil: 100,
		});
		const downstream = task("downstream", { status: "waiting", dependsOnTaskId: child.id });
		const draft = state([root, child, downstream]);
		establishConversation(draft, root);
		establishConversation(draft, child);
		const result = rescanReadyTasksOnRecovery(draft, 101, 60_000, ctx);
		expect(result.settledWakes.find((n) => n.taskId === child.id)?.wake?.resultOfTaskId).toBe(child.id);
		expect(child.report).toContain("recovery window expired");
		expect(downstream.status).toBe("failed");
		const committed = structuredClone(draft);
		rescanReadyTasksOnRecovery(draft, 102, 60_000, ctx);
		expect(draft).toEqual(committed);
		expect(draft.tasks.filter((t) => t.resultOfTaskId === child.id)).toHaveLength(1);
	});
	it("distinguishes unissued queued work from leased queued work, without extending recovery", () => {
		const issued = task("issued", { status: "queued", leaseToken: "lease", leaseGeneration: 1 });
		const unissued = task("unissued", { status: "queued" });
		const draft = state([issued, unissued]);
		rescanReadyTasksOnRecovery(draft, 100, 1000, ctx);
		expect(issued.recoveryUntil).toBe(1100);
		expect(unissued.recoveryUntil).toBeUndefined();
		rescanReadyTasksOnRecovery(draft, 200, 1000, ctx);
		expect(issued.recoveryUntil).toBe(1100);
	});
	it("settles expired provisional interrupted work and cascades just once", () => {
		const first = task("first", { status: "interrupted", leaseToken: "lease", leaseGeneration: 1, recoveryUntil: 100 });
		const second = task("second", { status: "waiting", dependsOnTaskId: first.id });
		const draft = state([first, second]);
		const sweep = sweepExpiredRecoveryLeases(draft, 101, ctx);
		expect(sweep.settledWakes.map((s) => s.taskId)).toContain(first.id);
		expect(first.outcomeFingerprint).toBeTruthy();
		expect(second.status).toBe("failed");
		const committed = structuredClone(draft);
		sweepExpiredRecoveryLeases(draft, 102, ctx);
		expect(draft).toEqual(committed);
	});
});

async function persistedHub(tasks: HubTask[], onTask = vi.fn(async () => true), resume = true) {
	const dir = await mkdtemp(join(tmpdir(), "device-settlement-"));
	cleanup.push(() => rm(dir, { recursive: true, force: true }));
	const store = await DeviceHubStore.open(dir);
	await store.transact((draft) => Object.assign(draft, state(tasks)));
	await store.close();
	let hub = await createDeviceHub({ dataDir: dir, publicUrl: "http://127.0.0.1:8998", onTask });
	if (resume) await hub.resumeQueuedTasks();
	cleanup.push(() => hub.close());
	return {
		hub,
		dir,
		onTask,
		async restart() {
			await hub.close();
			hub = await createDeviceHub({ dataDir: dir, publicUrl: "http://127.0.0.1:8998", onTask });
			if (resume) await hub.resumeQueuedTasks();
			return hub;
		},
	};
}

describe("Hub durable task settlement integration", () => {
	it("persists fingerprint and rejects a conflicting duplicate after restart", async () => {
		const t = task("first", { leaseToken: "lease", leaseGeneration: 1 });
		const fixture = await persistedHub([t]);
		let hub = fixture.hub;
		const frame = event(t, { fingerprint: computeOutcomeFingerprint(t.id, t.attemptId, "completed", "done") });
		const committed = await hub.acceptTaskEvent("device", frame);
		expect(committed.outcomeFingerprint).toBe(frame.fingerprint);
		const snapshot = hub.store.snapshot();
		hub = await fixture.restart();
		await hub.acceptTaskEvent("device", frame);
		expect(hub.store.snapshot()).toEqual(snapshot);
		await expect(hub.acceptTaskEvent("device", { ...frame, report: "conflict" })).rejects.toThrow();
		expect(hub.store.snapshot()).toEqual(snapshot);
	});
	it.each(["running", "queued"] as const)(
		"rejects late claim and running frames after the %s task recovery window expires",
		async (status) => {
			const t = task("expired", { status, leaseToken: "lease", leaseGeneration: 1 });
			const { hub } = await persistedHub([t]);
			await hub.store.transact((draft) => {
				draft.tasks[0].status = status;
				draft.tasks[0].recoveryUntil = Date.now() - 1;
			});
			const committed = hub.store.snapshot();
			const claim = {
				taskId: t.id,
				attemptId: t.attemptId,
				botId: t.botId,
				leaseToken: t.leaseToken!,
				leaseGeneration: t.leaseGeneration,
			};
			expect(await hub.claimTask("device", claim)).toMatchObject({
				accepted: false,
				reason: "Recovery window expired",
			});
			await expect(hub.acceptTaskEvent("device", event(t, { status: "running" }))).rejects.toThrow(
				"Recovery window expired",
			);
			expect((await hub.renewTaskLease("device", { ...claim, hasActivity: true })).accepted).toBe(false);
			expect(hub.store.snapshot()).toEqual(committed);
		},
	);
	it("starts a bounded recovery window when a leased queued delivery disconnects", async () => {
		const { hub } = await persistedHub([]);
		const t = task("queued-disconnect", { status: "queued", leaseToken: "lease", leaseGeneration: 1 });
		await hub.store.transact((draft) => {
			draft.tasks.push(t);
		});
		await hub.onTaskDisconnect("device", t.id, t.attemptId);
		const window = hub.store.snapshot().tasks[0].recoveryUntil;
		expect(window).toBeGreaterThan(Date.now());
		await hub.onTaskDisconnect("device", t.id, t.attemptId);
		expect(hub.store.snapshot().tasks[0].recoveryUntil).toBe(window);
	});
	it("keeps recovered queued work durable until the transport explicitly becomes ready", async () => {
		const t = task("not-ready", { status: "queued" });
		const onTask = vi.fn(async () => true);
		const { hub } = await persistedHub([t], onTask, false);
		expect(onTask).not.toHaveBeenCalled();
		expect(hub.store.snapshot().tasks[0]).toMatchObject({ status: "queued" });
		expect(hub.store.snapshot().tasks[0].leaseToken).toBeUndefined();
		await hub.resumeQueuedTasks("other-device");
		expect(onTask).not.toHaveBeenCalled();
		await hub.resumeQueuedTasks("device");
		await hub.resumeQueuedTasks("device");
		expect(onTask).toHaveBeenCalledTimes(1);
		expect(hub.store.snapshot().tasks[0].leaseToken).toBeDefined();
	});
	it("recovers only unissued queued tasks and successful dependencies on startup", async () => {
		const first = task("first", { status: "completed", report: "output" });
		const second = task("second", { status: "waiting", dependsOnTaskId: first.id });
		const unissued = task("unissued", { status: "queued" });
		const issued = task("issued", { status: "queued", leaseToken: "lease", leaseGeneration: 1 });
		const { hub, onTask } = await persistedHub([first, second, unissued, issued]);
		expect(onTask.mock.calls.map((c) => (c as unknown as [string, HubTask])[1].id).sort()).toEqual([
			"second",
			"unissued",
		]);
		expect(hub.store.snapshot().tasks.find((t) => t.id === issued.id)?.recoveryUntil).toBeGreaterThan(Date.now());
	});
});

async function listen(server: Server) {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const port = (server.address() as { port: number }).port;
	expect(port).toBeGreaterThanOrEqual(8900);
	return `http://127.0.0.1:${port}`;
}
async function transport(
	options: Pick<DeviceConnectorOptions, "recovery" | "onTask"> = {},
	onTaskEvent?: DeviceRelayOptions["onTaskEvent"],
) {
	const server = createServer((_req, res) => res.writeHead(404).end());
	const url = await listen(server);
	cleanup.push(
		() =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	);
	const events: DeviceTaskEventFrame[] = [];
	const relay = createDeviceRelay({
		server,
		publicUrl: url,
		authenticateDevice: () => true,
		getAccount: () => "account",
		ownsDevice: () => true,
		onTaskEvent(id, frame) {
			events.push(structuredClone(frame));
			return onTaskEvent?.(id, frame);
		},
	});
	cleanup.push(async () => relay.close());
	const connector = createDeviceConnector({
		hubUrl: url,
		deviceId: "device",
		credential: "credential",
		localOrigin: url,
		...options,
	});
	cleanup.push(async () => connector.close());
	await vi.waitFor(() => expect(relay.isOnline("device")).toBe(true));
	return { relay, connector, events, url };
}
function expectWireOutcome(frame: DeviceTaskEventFrame, entry: ReturnType<TaskRecoveryManager["recordTaskFinish"]>) {
	expect(frame).toMatchObject({
		taskId: entry.taskId,
		attemptId: entry.attemptId,
		botId: entry.botId,
		status: entry.status,
		fingerprint: entry.fingerprint,
		leaseToken: entry.leaseToken,
		leaseGeneration: entry.leaseGeneration,
	});
	expect(frame.report).toBe(entry.report);
	expect(frame.error).toBe(entry.error);
	expect(frame.reportMetadata).toEqual(entry.reportMetadata);
}

function codeOutcomeTask(id: string) {
	const contract = createWorkContract({
		executionMode: "code",
		goal: "Produce evidence",
		baseline: { repositoryId: "repo", commit: "a".repeat(40) },
	});
	const contextManifest = createContextManifest({ contract, context: null });
	const t = task(id, {
		leaseToken: "code-lease",
		leaseGeneration: 2,
		executionMode: "code",
		contract,
		contextManifest,
	});
	const artifact = {
		id: `artifact-${id}`,
		digest: "",
		producer: {
			deviceId: t.deviceId,
			botId: t.botId,
			taskId: t.id,
			attemptId: t.attemptId,
			contractDigest: contract.digest,
			manifestDigest: contextManifest.digest,
		},
		baseline: contract.baseline!,
		inputTree: "b".repeat(40),
		outputTree: "b".repeat(40),
		patchBase64: "",
		patchSha256: createHash("sha256").update("").digest("hex"),
		createdAt: 1,
	};
	artifact.digest = computeArtifactDigest(artifact);
	return { t, artifact };
}

describe("connector durable terminal wire outcomes", () => {
	it("replays identical code evidence after disconnect and only clears it on the committed duplicate ACK", async () => {
		const { t, artifact } = codeOutcomeTask("artifact-replay");
		const { hub } = await persistedHub([t]);
		const recovery = new TaskRecoveryManager({ deviceId: "device" });
		const entry = recovery.recordTaskFinish(t, {
			status: "completed",
			report: "code report",
			artifact,
			executionCompleted: true,
			artifactProduced: true,
		});
		const first = await transport({ recovery }, async (device, frame) => {
			const committed = await hub.acceptTaskEvent(device, frame);
			return { ...committed, outcomeFingerprint: "lost-ack" };
		});
		await vi.waitFor(() => expect(first.events).toHaveLength(1));
		await vi.waitFor(() => expect(hub.store.snapshot().tasks[0].status).toBe("completed"));
		expect(recovery.getPendingOutboxEntry(t.id, t.attemptId)).toBeDefined();
		await first.connector.close();
		const second = await transport({ recovery }, (device, frame) => hub.acceptTaskEvent(device, frame));
		await vi.waitFor(() => expect(recovery.getPendingOutbox()).toEqual([]));
		expect(first.events[0].artifact).toEqual(artifact);
		expect(second.events[0]).toMatchObject({
			fingerprint: entry.fingerprint,
			artifact,
			executionCompleted: true,
			artifactProduced: true,
		});
		expect(hub.store.snapshot().messages).toHaveLength(1);
		expect(hub.store.snapshot().tasks[0].artifact).toEqual(artifact);
	});

	it.each(["terminal_conflict", "attempt_expired"] as const)(
		"durably quarantines %s replay without disconnecting or discarding code evidence",
		async (reasonCode) => {
			const { t, artifact } = codeOutcomeTask(`quarantine-${reasonCode}`);
			const fixture = await persistedHub([t]);
			let hub = fixture.hub;
			if (reasonCode === "terminal_conflict") {
				await hub.acceptTaskEvent(
					"device",
					event(t, {
						status: "interrupted",
						report: "Hub already stopped",
						executionCompleted: false,
						artifactProduced: false,
					}),
				);
				await hub.store.transact((draft) => {
					draft.tasks[0].stopConfirmed = true;
				});
			} else
				await hub.store.transact((draft) => {
					draft.tasks = [];
				});
			const dataDir = await mkdtemp(join(tmpdir(), "quarantine-wire-"));
			cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
			const options = { dataDir, deviceId: "device" };
			const recovery = new TaskRecoveryManager(options);
			const entry = recovery.recordTaskFinish(t, {
				status: "completed",
				report: "durable completed",
				artifact,
				executionCompleted: true,
				artifactProduced: true,
			});
			const wire = await transport({ recovery }, (device, frame) => hub.acceptTaskEvent(device, frame));
			await vi.waitFor(() => expect(recovery.getQuarantinedOutcomes()).toHaveLength(1));
			expect(wire.relay.isOnline("device")).toBe(true);
			expect(wire.events).toHaveLength(1);
			expect(recovery.getPendingOutbox()).toEqual([]);
			const archive = new TaskRecoveryManager(options).getQuarantinedOutcomes();
			expect(archive[0]).toMatchObject({
				reasonCode,
				outcome: { fingerprint: entry.fingerprint, artifact, report: "durable completed", status: "completed" },
			});
			hub = await fixture.restart();
			if (reasonCode === "terminal_conflict") expect(hub.store.snapshot().tasks[0].status).toBe("interrupted");
			else expect(hub.store.snapshot().tasks).toEqual([]);
		},
	);

	it("sends the persisted failure verbatim instead of deriving a completed/failed payload", async () => {
		const recovery = new TaskRecoveryManager({ deviceId: "device" });
		let entry: ReturnType<TaskRecoveryManager["recordTaskFinish"]>;
		const t = task("wire", { status: "queued", leaseToken: "lease", leaseGeneration: 3 });
		const f = await transport({
			recovery,
			async onTask(received) {
				entry = recovery.recordTaskFinish(received, {
					status: "failed",
					report: "persisted report",
					error: new Error("private detail"),
					reportMetadata: reportUploadMetadata(),
				});
				throw new Error("different ephemeral error");
			},
		});
		expect(f.relay.sendTask("device", t)).toBe(true);
		await vi.waitFor(() => expect(f.events.some((e) => e.status === "failed")).toBe(true));
		expectWireOutcome(
			f.events.find((e) => e.status === "failed")!,
			entry!,
		);
		expect(recovery.getPendingOutboxEntry(t.id, t.attemptId)).toBeDefined();
	});
	it("does not invent a terminal failure when recovery has no committed outcome", async () => {
		const recovery = new TaskRecoveryManager({ deviceId: "device" });
		let resolveHandled!: () => void;
		const handled = new Promise<void>((resolve) => {
			resolveHandled = resolve;
		});
		const f = await transport({
			recovery,
			async onTask() {
				resolveHandled();
				throw new Error("outbox commit failed");
			},
		});
		expect(
			f.relay.sendTask("device", task("uncommitted", { status: "queued", leaseToken: "lease", leaseGeneration: 1 })),
		).toBe(true);
		await handled;
		await new Promise<void>((resolve) => setImmediate(resolve));
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(f.events.map((e) => e.status)).toEqual(["running"]);
	});
	it.each(["resolve", "reject"])(
		"still sends a persisted interrupted outcome after abort when the handler can %s",
		async (mode) => {
			const recovery = new TaskRecoveryManager({ deviceId: "device" });
			const t = task("aborted", { status: "queued", leaseToken: "lease", leaseGeneration: 2 });
			let entry: ReturnType<TaskRecoveryManager["recordTaskFinish"]>;
			const f = await transport({
				recovery,
				onTask(received, signal) {
					return new Promise<string | void>((resolve, reject) =>
						signal!.addEventListener(
							"abort",
							() => {
								entry = recovery.recordTaskFinish(received, {
									status: "interrupted",
									report: "durable interrupted",
									reportMetadata: reportUploadMetadata(),
								});
								if (mode === "reject") reject(new Error("cancelled"));
								else resolve("ephemeral completed report");
							},
							{ once: true },
						),
					);
				},
			});
			expect(f.relay.sendTask("device", t)).toBe(true);
			await vi.waitFor(() => expect(f.events).toHaveLength(1));
			expect(await f.relay.cancelTask("device", t.id, t.attemptId)).toEqual({ stopped: true });
			await vi.waitFor(() => expect(f.events.some((e) => e.status === "interrupted")).toBe(true));
			expectWireOutcome(
				f.events.find((e) => e.status === "interrupted")!,
				entry!,
			);
		},
	);
	it("replays the same lease and outcome fields on reconnect, retaining outbox after a wrong committed ACK", async () => {
		const recovery = new TaskRecoveryManager({ deviceId: "device" });
		const t = task("replay", { leaseToken: "lease", leaseGeneration: 5 });
		const entry = recovery.recordTaskFinish(t, {
			status: "failed",
			report: "persisted",
			error: new Error("private"),
			reportMetadata: reportUploadMetadata(),
		});
		const f = await transport({ recovery }, () => ({
			...t,
			status: "failed",
			outcomeFingerprint: "wrong-committed-digest",
		}));
		await vi.waitFor(() => expect(f.events).toHaveLength(1));
		expectWireOutcome(f.events[0], entry);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(recovery.getPendingOutboxEntry(t.id, t.attemptId)).toBeDefined();
	});
	it("clears a durable outbox only after relay returns the committed fingerprint", async () => {
		const recovery = new TaskRecoveryManager({ deviceId: "device" });
		const t = task("ack", { leaseToken: "lease", leaseGeneration: 1 });
		const entry = recovery.recordTaskFinish(t, { status: "completed", report: "persisted" });
		await transport({ recovery }, () => ({ ...t, status: "completed", outcomeFingerprint: entry.fingerprint }));
		await vi.waitFor(() => expect(recovery.getPendingOutboxEntry(t.id, t.attemptId)).toBeUndefined());
	});
});

describe("Hub HTTP and relay settlement regression", () => {
	it("fences a relay revoke outcome with the originally issued lease and fails downstream", async () => {
		const first = task("revoked", { leaseToken: "issued-lease", leaseGeneration: 4 });
		const dependent = task("dependent", { status: "waiting", dependsOnTaskId: first.id });
		const { hub } = await persistedHub([first, dependent]);
		const f = await transport(
			{
				onTask(_task, signal) {
					return new Promise((_resolve, reject) =>
						signal!.addEventListener("abort", () => reject(new Error("revoked")), { once: true }),
					);
				},
			},
			(id, frame) => hub.acceptTaskEvent(id, frame),
		);
		expect(f.relay.sendTask("device", first)).toBe(true);
		await vi.waitFor(() => expect(hub.store.snapshot().tasks[0].status).toBe("running"));
		f.relay.revoke("device");
		await vi.waitFor(() => expect(hub.store.snapshot().tasks[0].status).toBe("interrupted"));
		const settled = hub.store.snapshot();
		expect(settled.tasks[0].outcomeFingerprint).toBeTruthy();
		expect(settled.tasks.find((t) => t.id === dependent.id)?.status).toBe("failed");
		expect(f.events.find((e) => e.status === "interrupted")).toMatchObject({
			leaseToken: first.leaseToken,
			leaseGeneration: first.leaseGeneration,
		});
	});
	it.each(["failed", "interrupted", "completed"] as const)(
		"never dispatches a newly created dependency of an unsuccessful %s predecessor",
		async (status) => {
			const first = task("first", { status, cancelRequested: status === "completed" });
			const { hub, onTask } = await persistedHub([first]);
			const url = await listen(hub.server);
			const response = await new Promise<{ status: number; body: any }>((resolve, reject) => {
				const req = httpRequest(
					url + "/api/device-user/rooms/room/messages",
					{
						method: "POST",
						headers: {
							"content-type": "application/json",
							host: "127.0.0.1:8998",
							"x-device-id": "device",
							authorization: "Bearer ui-credential",
						},
					},
					(res) => {
						const chunks: Buffer[] = [];
						res.on("data", (chunk) => chunks.push(chunk));
						res.on("end", () =>
							resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }),
						);
					},
				);
				req.on("error", reject);
				req.end(
					JSON.stringify({
						text: "dependent",
						targetBotIds: ["bot"],
						dependsOnTaskId: first.id,
						idempotencyKey: "new-dependency",
					}),
				);
			});
			expect(response.status).toBe(200);
			const body = response.body;
			expect(body.tasks[0].status).toBe("failed");
			expect(onTask).not.toHaveBeenCalled();
		},
	);
	it("ACKs repeated committed outcomes without repeating messages or downstream dispatch", async () => {
		const first = task("first", { leaseToken: "lease", leaseGeneration: 1 });
		const dependent = task("dependent", { status: "waiting", dependsOnTaskId: first.id });
		const { hub, onTask } = await persistedHub([first, dependent]);
		const url = await listen(hub.server);
		const relay = createDeviceRelay({
			server: hub.server,
			publicUrl: url,
			authenticateDevice: () => true,
			getAccount: () => "account",
			ownsDevice: () => true,
			onTaskEvent: (id, frame) => hub.acceptTaskEvent(id, frame),
		});
		cleanup.push(async () => relay.close());
		const ws = new WebSocket(url.replace("http:", "ws:") + "/device-connect?deviceId=device", {
			headers: { authorization: "Bearer credential" },
		});
		cleanup.push(async () => ws.terminate());
		const acks: Record<string, unknown>[] = [];
		ws.on("message", (raw) => {
			const frame = JSON.parse(String(raw));
			if (frame.type === "task_result_ack") acks.push(frame);
		});
		await once(ws, "open");
		const frame = event(first, {
			fingerprint: computeOutcomeFingerprint(first.id, first.attemptId, "completed", "done"),
		});
		ws.send(JSON.stringify(frame));
		await vi.waitFor(() => expect(acks).toHaveLength(1));
		const committed = hub.store.snapshot();
		ws.send(JSON.stringify(frame));
		await vi.waitFor(() => expect(acks).toHaveLength(2));
		expect(acks[1]).toMatchObject({
			accepted: true,
			fingerprint: committed.tasks.find((t) => t.id === first.id)?.outcomeFingerprint,
		});
		expect(hub.store.snapshot()).toEqual(committed);
		expect(committed.messages.filter((m) => m.taskIds.includes(first.id))).toHaveLength(1);
		expect(onTask).toHaveBeenCalledTimes(1);
	});
	it("returns the Hub's committed digest in ACK instead of echoing an untrusted fingerprint", async () => {
		const f = await transport({}, (_id, frame) => ({
			...task(frame.taskId),
			status: "completed",
			outcomeFingerprint: "committed-digest",
		}));
		f.connector.close();
		await vi.waitFor(() => expect(f.relay.isOnline("device")).toBe(false));
		const ws = new WebSocket(f.url.replace("http:", "ws:") + "/device-connect?deviceId=device", {
			headers: { authorization: "Bearer credential" },
		});
		cleanup.push(async () => ws.terminate());
		await once(ws, "open");
		const ack = once(ws, "message");
		ws.send(JSON.stringify(event(task("echo"), { fingerprint: "untrusted-echo" })));
		const [raw] = await ack;
		expect(JSON.parse(String(raw))).toMatchObject({
			type: "task_result_ack",
			accepted: true,
			fingerprint: "committed-digest",
		});
	});
});
