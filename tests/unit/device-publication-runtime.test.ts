import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { localPublicationFixture, intentForIntegration, nativeGit } from "../helpers/local-publication-fixture.js";
import { createLocalBotRegistry } from "../../server/device-center/bots.js";
import { createDeviceRuntime } from "../../server/device-center/runtime.js";
import { appendPublicationJournal, createPublicationJournal } from "../../server/device-center/publication-journal.js";
import { deviceConfirmIntegration } from "../../server/device-center/device-integration.js";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const run of cleanup.splice(0).reverse()) await run();
});
async function fixture() {
	const f = await localPublicationFixture();
	cleanup.push(() => rm(f.dir, { recursive: true, force: true }));
	const bots = await createLocalBotRegistry(join(f.dir, "registry"));
	const input = {
		name: "original",
		description: "",
		systemPrompt: "",
		cwd: f.repoRoot,
		tools: ["read", "bash"],
		skills: [],
		mcpServers: [],
		enabled: true,
	};
	const bot = await bots.upsert(input),
		other = await bots.upsert({ ...input, name: "other" });
	const intent = intentForIntegration(
		{ ...f.integration, targetBotId: bot.id, targetBotRevision: bot.revision },
		f.facts,
	);
	const config: { hubUrl: string; credential: string; deviceId: string; allowExecution: boolean; accountId?: string } =
		{
			hubUrl: "http://127.0.0.1:8999",
			credential: "secret",
			deviceId: "device",
			allowExecution: true,
			accountId: "account",
		};
	const options = { config, localOrigin: "http://127.0.0.1:8989", bots, dataDir: f.dataDir };
	const command = {
		accountId: intent.accountId,
		roomId: intent.roomId,
		conversationId: intent.conversationId,
		integrationId: intent.integrationId,
		targetBotId: intent.targetBotId,
		targetBotRevision: intent.targetBotRevision,
		publishIntent: intent,
	};
	const task = {
		id: "task-" + randomUUID(),
		attemptId: "attempt",
		roomId: "room",
		botId: other.id,
		botRevision: other.revision,
		deviceId: "device",
		text: "test",
		leaseToken: "lease",
		leaseGeneration: 1,
	};
	return { ...f, bots, bot, other, config, options, intent, command, task };
}
// These cases construct real repositories and exercise the complete runtime admission route.
describe("publication historical runtime routing", { timeout: 30_000 }, () => {
	it("fences real ownerCleanup cancellation before enabled/currentBot/acquire even without a session", async () => {
		const f = await fixture();
		await f.bots.remove(f.bot.id, f.bot.revision);
		f.config.allowExecution = false;
		const acquire = vi.spyOn(f.bots, "acquire"),
			get = vi.spyOn(f.bots, "get");
		const runtime = createDeviceRuntime(f.options);
		cleanup.push(() => runtime.close());
		const result = await runtime.onCommand(
			"integration_cancel",
			{ ...f.command, ownerCleanup: true },
			new AbortController().signal,
		);
		expect(result).toMatchObject({
			status: "cancelled",
			publishStop: { closed: true, stopConfirmed: true, pastEffect: "not_applied" },
		});
		expect(acquire).not.toHaveBeenCalled();
		expect(get).not.toHaveBeenCalled();
		const verify = await deviceConfirmIntegration({
			dataDir: f.dataDir,
			integrationId: f.intent.integrationId,
			targetBotId: f.intent.targetBotId,
			targetBotRevision: f.intent.targetBotRevision,
			repoRoot: f.repoRoot,
			deliveryId: f.intent.delivery.id,
			expectedTargetSha: f.intent.expectedOld,
			publishIntent: f.intent,
		});
		expect(verify.status).toBe("cancelled");
		expect(await nativeGit(f.repoRoot, "rev-parse", "target")).toBe(f.intent.expectedOld);
	});
	it("uses stored account/device scope for historical reads and fails closed for new publication with no authenticated account", async () => {
		const f = await fixture();
		const runtime = createDeviceRuntime(f.options);
		cleanup.push(() => runtime.close());
		delete f.config.accountId;
		await expect(runtime.onCommand("integration_confirm", f.command, new AbortController().signal)).rejects.toThrow(
			"account context",
		);
		await expect(
			runtime.onCommand("integration_publication_status", f.command, new AbortController().signal),
		).rejects.toThrow("account context");
		await createPublicationJournal(f.dataDir, f.intent, f.repository);
		expect(
			await runtime.onCommand("integration_publication_status", f.command, new AbortController().signal),
		).toMatchObject({ status: "pending", publishObservation: { phase: "prepared", retryable: true } });
		await expect(
			runtime.onCommand(
				"integration_publication_status",
				{ ...f.command, accountId: "forged" },
				new AbortController().signal,
			),
		).rejects.toThrow("scope");
		f.config.accountId = "account";
		await expect(runtime.onCommand("integration_confirm", f.command, new AbortController().signal)).rejects.toThrow(
			"session not found",
		);
	});
	it("restores original root quarantine from an old writer journal despite missing/corrupt sessions, even with an observed applied receipt", async () => {
		const f = await fixture();
		let journal = await createPublicationJournal(f.dataDir, f.intent, f.repository);
		journal = await appendPublicationJournal(f.dataDir, journal, "cas_started", { processEpoch: randomUUID() });
		await appendPublicationJournal(f.dataDir, journal, "applied", {
			receipt: {
				intentId: f.intent.id,
				intentDigest: f.intent.digest,
				candidateSha: f.intent.candidateSha,
				outcome: "applied",
				proof: "target_exact",
				targetSha: f.intent.candidateSha,
				observedAt: Date.now(),
			},
		});
		await writeFile(join(f.dataDir, "integration-sessions.json"), "corrupt old sessions");
		expect(f.task.botId).not.toBe(f.intent.targetBotId);
		expect(f.bots.get(f.task.botId)).toMatchObject({ enabled: true, cwd: f.repoRoot });
		const freeLease = await f.bots.acquire(f.task.botId);
		freeLease.release();
		const executor = vi.fn();
		const runtime = createDeviceRuntime({ ...f.options, executorFactory: executor });
		cleanup.push(() => runtime.close());
		await expect(runtime.onTask(f.task)).rejects.toThrow("unavailable or busy");
		expect(executor).not.toHaveBeenCalled();
		const closed = await runtime.onCommand(
			"integration_cancel",
			{ ...f.command, ownerCleanup: true },
			new AbortController().signal,
		);
		expect(closed).toMatchObject({
			status: "applied",
			publishStop: { closed: true, stopConfirmed: false, pastEffect: "applied" },
		});
		await expect(runtime.onTask({ ...f.task, id: "second-task" })).rejects.toThrow("unavailable or busy");
	});
});
