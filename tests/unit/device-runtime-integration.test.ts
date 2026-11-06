import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeviceRuntime } from "../../server/device-center/runtime.js";
import { createLocalBotRegistry } from "../../server/device-center/bots.js";
import {
	deviceCancelIntegration,
	deviceConfirmIntegration,
	devicePrepareIntegration,
	deviceVerifyIntegration,
	loadPersistentSessions,
} from "../../server/device-center/device-integration.js";
import { git } from "../../server/workspace-handle.js";
import { publicationFixture } from "../helpers/publish-intent-fixture.js";
import { intentForIntegration } from "../helpers/local-publication-fixture.js";
import { PublicationStopUnconfirmedError } from "../../server/device-center/local-publication.js";
import { VerificationStopUnconfirmedError } from "../../server/device-center/local-verification.js";

vi.mock("../../server/device-center/device-integration.js", () => ({
	devicePrepareIntegration: vi.fn(),
	deviceVerifyIntegration: vi.fn(),
	deviceConfirmIntegration: vi.fn(),
	devicePublicationStatus: vi.fn(),
	deviceCancelPublication: vi.fn(),
	deviceCancelIntegration: vi.fn(),
	loadPersistentSessions: vi.fn(async () => new Map()),
}));
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
	vi.resetAllMocks();
	vi.mocked(loadPersistentSessions).mockResolvedValue(new Map());
});
async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "runtime-integration-"));
	cleanup.push(() => rm(dir, { recursive: true, force: true }));
	const root = join(dir, "repo");
	await mkdir(root);
	await git(root, ["init"]);
	const bots = await createLocalBotRegistry(join(dir, "data"));
	const input = {
		name: "one",
		description: "",
		systemPrompt: "",
		cwd: root,
		tools: ["bash", "read"],
		skills: [],
		mcpServers: [],
		enabled: true,
	};
	const one = await bots.upsert(input);
	const two = await bots.upsert({ ...input, name: "two" });
	let leases = 0;
	const acquire = bots.acquire.bind(bots);
	bots.acquire = async (id) => {
		const lease = await acquire(id);
		leases++;
		let released = false;
		return {
			...lease,
			release() {
				if (!released) {
					released = true;
					leases--;
					lease.release();
				}
			},
		};
	};
	const options = {
		config: {
			hubUrl: "http://127.0.0.1:8999",
			deviceId: "device",
			credential: "secret",
			allowExecution: true,
			accountId: "account",
		},
		localOrigin: "http://127.0.0.1:8989",
		dataDir: join(dir, "data"),
		bots,
	};
	const command = {
		integrationId: "integration-one",
		targetBotId: one.id,
		targetBotRevision: one.revision,
		targetBranch: "target",
	};
	const task = {
		id: "task",
		attemptId: "attempt",
		roomId: "room",
		botId: two.id,
		botRevision: two.revision,
		deviceId: "device",
		text: "test",
		leaseToken: "lease",
		leaseGeneration: 1,
	};
	return { options, one, two, bots, command, task, leases: () => leases };
}
const signal = () => new AbortController().signal;

describe("runtime integration ownership", () => {
	it("retains the Bot lease and blocks its root when publication process stop is unconfirmed", async () => {
		const f = await fixture();
		const integration = publicationFixture().integration;
		const { digest: _digest, verifiedAt: _at, ...facts } = integration.verification!;
		const intent = intentForIntegration(
			{ ...integration, id: f.command.integrationId, targetBotId: f.one.id, targetBotRevision: f.one.revision },
			facts,
		);
		vi.mocked(deviceConfirmIntegration).mockRejectedValue(new PublicationStopUnconfirmedError());
		const executor = vi.fn();
		const runtime = createDeviceRuntime({ ...f.options, executorFactory: executor });
		const command = {
			...f.command,
			accountId: intent.accountId,
			roomId: intent.roomId,
			conversationId: intent.conversationId,
			publishIntent: intent,
		};
		await expect(runtime.onCommand("integration_confirm", command, signal())).rejects.toMatchObject({
			stopUnconfirmed: true,
		});
		expect(f.leases()).toBe(1);
		await expect(runtime.onTask(f.task)).rejects.toThrow("blocked");
		expect(executor).not.toHaveBeenCalled();
		await expect(runtime.close()).rejects.toMatchObject({ stopUnconfirmed: true });
	});
	it("shares root exclusion with normal tasks, queues tasks until integration releases its lease", async () => {
		const f = await fixture();
		let finish!: (value: any) => void;
		let calls = 0;
		vi.mocked(devicePrepareIntegration).mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const runtime = createDeviceRuntime({
			...f.options,
			executorFactory: () => ({
				async run() {
					calls++;
					return "done";
				},
				close() {},
			}),
		});
		cleanup.push(() => runtime.close());
		const integration = runtime.onCommand("integration_prepare", f.command, signal());
		await vi.waitFor(() => expect(devicePrepareIntegration).toHaveBeenCalledOnce());
		const task = runtime.onTask(f.task);
		await vi.waitFor(() => expect(runtime.getSchedulerSnapshot().waitingCount).toBe(1));
		expect(calls).toBe(0);
		expect(f.leases()).toBe(1);
		await expect(runtime.onCommand("integration_verify", f.command, signal())).rejects.toThrow();
		finish({ status: "prepared", expectedTargetSha: "a".repeat(40) });
		await integration;
		expect(await task).toBe("done");
		expect(calls).toBe(1);
		expect(f.leases()).toBe(0);
	});
	it("rejects prepare and cancel when another Bot task owns the same root", async () => {
		const f = await fixture();
		let finish!: (value: string) => void;
		const runtime = createDeviceRuntime({
			...f.options,
			executorFactory: () => ({
				run() {
					return new Promise((resolve) => {
						finish = resolve;
					});
				},
				close() {},
			}),
		});
		cleanup.push(() => runtime.close());
		const task = runtime.onTask(f.task);
		await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
		await expect(runtime.onCommand("integration_prepare", f.command, signal())).rejects.toThrow();
		await expect(runtime.onCommand("integration_cancel", f.command, signal())).rejects.toThrow("busy");
		vi.mocked(loadPersistentSessions).mockResolvedValue(
			new Map([
				[
					f.command.integrationId,
					{
						integrationId: f.command.integrationId,
						targetBotId: f.one.id,
						targetBotRevision: f.one.revision,
						repoRoot: f.one.cwd,
					} as any,
				],
			]),
		);
		await expect(
			runtime.onCommand("integration_cancel", { ...f.command, ownerCleanup: true }, signal()),
		).rejects.toThrow("busy");
		expect(devicePrepareIntegration).not.toHaveBeenCalled();
		expect(deviceCancelIntegration).not.toHaveBeenCalled();
		finish("done");
		await task;
		expect(f.leases()).toBe(0);
	});
	it("does not release the Bot or root lease when stopping verification is unconfirmed", async () => {
		const f = await fixture();
		const failure = new VerificationStopUnconfirmedError();
		vi.mocked(deviceVerifyIntegration).mockRejectedValue(failure);
		const runtime = createDeviceRuntime({
			...f.options,
			executorFactory: () => ({
				async run() {
					return "unexpected";
				},
				close() {},
			}),
		});
		cleanup.push(async () => {
			await expect(runtime.close()).rejects.toBe(failure);
		});
		await expect(runtime.onCommand("integration_verify", f.command, signal())).rejects.toBe(failure);
		expect(f.leases()).toBe(1);
		expect(runtime.getSchedulerSnapshot().blockedCount).toBe(1);
		await expect(runtime.onTask(f.task)).rejects.toThrow("stop unconfirmed");
		await expect(runtime.onCommand("integration_cancel", f.command, signal())).rejects.toThrow("stop unconfirmed");
		expect(deviceCancelIntegration).not.toHaveBeenCalled();
		expect(f.leases()).toBe(1);
	});
	it("rejects new work after restart when a durable in-flight marker remains", async () => {
		const f = await fixture();
		vi.mocked(loadPersistentSessions).mockResolvedValue(
			new Map([
				[
					f.command.integrationId,
					{
						integrationId: f.command.integrationId,
						targetBotId: f.one.id,
						repoRoot: f.one.cwd,
						verificationInFlight: true,
					} as any,
				],
			]),
		);
		const run = vi.fn(async () => "unexpected");
		const runtime = createDeviceRuntime({ ...f.options, executorFactory: () => ({ run, close() {} }) });
		cleanup.push(() => runtime.close());
		await expect(runtime.onTask(f.task)).rejects.toThrow();
		await expect(runtime.onCommand("integration_cancel", f.command, signal())).rejects.toThrow("stop unconfirmed");
		expect(run).not.toHaveBeenCalled();
		expect(deviceCancelIntegration).not.toHaveBeenCalled();
		expect(f.leases()).toBe(0);
	});
	it("allows owner cleanup of the original session after the Bot is disabled and revised", async () => {
		const f = await fixture();
		await f.bots.upsert({ ...f.one, enabled: false });
		vi.mocked(loadPersistentSessions).mockResolvedValue(
			new Map([
				[
					f.command.integrationId,
					{
						integrationId: f.command.integrationId,
						targetBotId: f.one.id,
						targetBotRevision: f.one.revision,
						repoRoot: f.one.cwd,
					} as any,
				],
			]),
		);
		vi.mocked(deviceCancelIntegration).mockResolvedValue({ status: "cancelled" });
		const runtime = createDeviceRuntime(f.options);
		cleanup.push(() => runtime.close());
		await expect(
			runtime.onCommand("integration_cancel", { ...f.command, ownerCleanup: true, cwd: "forged" }, signal()),
		).resolves.toEqual({ status: "cancelled" });
		expect(deviceCancelIntegration).toHaveBeenCalledWith(
			expect.objectContaining({ targetBotId: f.one.id, targetBotRevision: f.one.revision, repoRoot: f.one.cwd }),
			expect.anything(),
		);
		expect(f.leases()).toBe(0);
		await expect(
			runtime.onCommand("integration_cancel", { ...f.command, ownerCleanup: true, targetBotRevision: 999 }, signal()),
		).rejects.toThrow("identity mismatch");
	});
	it("retains logical root ownership when owner cleanup cannot prove the old process stopped", async () => {
		const f = await fixture();
		const failure = new VerificationStopUnconfirmedError();
		vi.mocked(loadPersistentSessions).mockResolvedValue(
			new Map([
				[
					f.command.integrationId,
					{
						integrationId: f.command.integrationId,
						targetBotId: f.one.id,
						targetBotRevision: f.one.revision,
						repoRoot: f.one.cwd,
					} as any,
				],
			]),
		);
		vi.mocked(deviceCancelIntegration).mockRejectedValue(failure);
		const runtime = createDeviceRuntime(f.options);
		cleanup.push(async () => {
			await expect(runtime.close()).rejects.toBe(failure);
		});
		await expect(runtime.onCommand("integration_cancel", { ...f.command, ownerCleanup: true }, signal())).rejects.toBe(
			failure,
		);
		expect(runtime.getSchedulerSnapshot().blockedCount).toBe(1);
		await expect(runtime.onTask(f.task)).rejects.toThrow("stop unconfirmed");
	});
	it("isolates an unmarked legacy session until explicit prepared owner cleanup", async () => {
		const f = await fixture();
		vi.mocked(loadPersistentSessions).mockResolvedValue(
			new Map([
				[
					f.command.integrationId,
					{
						integrationId: f.command.integrationId,
						targetBotId: f.one.id,
						targetBotRevision: f.one.revision,
						repoRoot: f.one.cwd,
					} as any,
				],
			]),
		);
		vi.mocked(deviceCancelIntegration).mockImplementation(async () => {
			vi.mocked(loadPersistentSessions).mockResolvedValue(new Map());
			return { status: "cancelled" };
		});
		const run = vi.fn(async () => "admitted");
		const runtime = createDeviceRuntime({ ...f.options, executorFactory: () => ({ run, close() {} }) });
		cleanup.push(() => runtime.close());
		await expect(runtime.onTask(f.task)).rejects.toThrow();
		expect(run).not.toHaveBeenCalled();
		await expect(
			runtime.onCommand("integration_cancel", { ...f.command, priorStatus: "prepared", ownerCleanup: true }, signal()),
		).resolves.toEqual({ status: "cancelled" });
		await expect(runtime.onTask({ ...f.task, id: "after-cleanup", attemptId: "next-attempt" })).resolves.toBe(
			"admitted",
		);
	});
	it("still requires the target Bot bash permission despite an owner plan", async () => {
		const f = await fixture();
		const bot = await f.bots.upsert({ ...f.one, tools: ["read"] });
		const runtime = createDeviceRuntime(f.options);
		cleanup.push(() => runtime.close());
		await expect(
			runtime.onCommand(
				"integration_verify",
				{ ...f.command, targetBotRevision: bot.revision, verificationPlan: { authorizedByAccountId: "owner" } },
				signal(),
			),
		).rejects.toThrow("bash command permission");
		expect(deviceVerifyIntegration).not.toHaveBeenCalled();
		expect(f.leases()).toBe(0);
	});
});
