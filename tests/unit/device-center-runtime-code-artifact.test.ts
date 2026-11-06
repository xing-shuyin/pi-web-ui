import { mkdtemp, mkdir, rm, writeFile, readFile, rename } from "node:fs/promises";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import { fakeClientSession } from "../helpers/fake-session.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createDeviceRuntime } from "../../server/device-center/runtime.js";
import { createLocalBotRegistry } from "../../server/device-center/bots.js";
import { createWorkContract, createContextManifest } from "../../server/device-center/work-contract.js";
import { computeCanonicalRepositoryId } from "../../server/workspace-handle.js";
import type { DeviceArtifact } from "../../server/protocol.js";
import { getBotExecution } from "../../server/device-center/bot-execution.js";

const execFileAsync = promisify(execFile);
const cleanups: (() => Promise<unknown> | unknown)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.unstubAllGlobals();
});

async function runGit(cwd: string, args: string[]) {
	return await execFileAsync("git", ["-c", "user.name=test", "-c", "user.email=t@e", ...args], { cwd });
}

async function createRepoFixture() {
	const dir = await mkdtemp(join(tmpdir(), "device-runtime-c-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));

	const repoDir = join(dir, "repo");
	await mkdir(repoDir);
	await runGit(repoDir, ["init"]);
	await runGit(repoDir, ["config", "user.name", "Test User"]);
	await runGit(repoDir, ["config", "user.email", "test@example.com"]);
	await writeFile(join(repoDir, "README.md"), "# Test Repo\n");
	await runGit(repoDir, ["add", "README.md"]);
	await runGit(repoDir, ["commit", "-m", "Initial commit"]);

	const { stdout: commitOut } = await runGit(repoDir, ["rev-parse", "HEAD"]);
	const headCommit = commitOut.trim();
	const repoId = await computeCanonicalRepositoryId(repoDir);

	const dataDir = join(dir, "data");
	await mkdir(dataDir);

	const bots = await createLocalBotRegistry(dataDir);
	const bot = await bots.upsert({
		name: "Code Bot",
		description: "Bot for code tasks",
		systemPrompt: "Code instructions",
		cwd: repoDir,
		tools: ["read", "write"],
		skills: [],
		mcpServers: [],
		enabled: true,
	});

	const options = {
		config: {
			hubUrl: "http://127.0.0.1:8999",
			deviceId: "device-1",
			credential: "secret",
			allowExecution: true,
		},
		localOrigin: "http://127.0.0.1:8989",
		dataDir,
		bots,
	};

	return {
		dir,
		repoDir,
		headCommit,
		repoId,
		bot,
		dataDir,
		options,
	};
}

describe("Device Runtime Code Mode & Artifacts (Batch 2C)", { timeout: 30_000 }, () => {
	it("runs the real executor and SDK write through the ClientSession gate in the trusted worktree", async () => {
		const f = await createRepoFixture();
		const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
		await once(server, "listening");
		cleanups.push(
			() =>
				new Promise<void>((resolve) => {
					for (const ws of server.clients) ws.terminate();
					server.close(() => resolve());
				}),
		);
		const port = (server.address() as { port: number }).port;
		let observedCwd = "";
		let writeFailure: unknown;
		server.on("connection", (socket) => {
			let state: any;
			const push = (patch: object = {}) => {
				state = { ...state, ...patch, rev: (state?.rev ?? 0) + 1 };
				socket.send(JSON.stringify({ type: "snapshot", state }));
			};
			socket.on("message", (raw) => {
				void (async () => {
					const msg = JSON.parse(raw.toString());
					if (msg.type === "hello") {
						const cap = getBotExecution(msg.clientId)!;
						await cap.assertWorkspace();
						observedCwd = cap.executionCwd;
						state = {
							clientId: msg.clientId,
							sessionId: "sdk-initial",
							cwd: observedCwd,
							conversationId: "initial",
							messages: [],
							isStreaming: false,
							streamingMessage: null,
						};
						socket.send(JSON.stringify({ type: "ready", clientId: msg.clientId }));
						push();
					} else if (msg.type === "new_chat") {
						push({ conversationId: "fresh-code", sessionId: "sdk-code" });
						socket.send(JSON.stringify({ type: "transition_progress", kind: "new_chat", phase: "done" }));
					} else if (msg.type === "prompt") {
						expect(msg.text).toContain("Write README");
						expect(msg.text).not.toContain("wire text");
						expect(msg.text).not.toContain("unsealed handoff instruction");
						const cap = getBotExecution(state.clientId)!;
						const client = fakeClientSession({
							botExecution: cap,
							cwd: observedCwd,
							roots: [observedCwd],
							sandboxes: { getExecutionIdentity: () => undefined, acquireExecution: () => undefined },
							approvalRules: { list: () => [] },
							auditLogger: { record: () => {} },
							planModeOf: () => false,
							delegateModeOf: () => false,
							goalReviewTurnOf: () => false,
							subagentSecurityModeOf: () => undefined,
							subagentAllowedToolsOf: () => undefined,
							getLang: () => "en",
						}) as any;
						const tool = client.wrapGenericTool(
							createWriteToolDefinition(observedCwd),
							undefined,
							observedCwd,
							undefined,
							true,
						);
						await tool.execute(
							"sdk-write",
							{ path: "README.md", content: "SDK wrote in the isolated worktree\n" },
							undefined,
							undefined,
							{},
						);
						const gitMarkerPath = join(observedCwd, ".git");
						const gitMarkerBackup = join(observedCwd, ".git.original");
						await rename(gitMarkerPath, gitMarkerBackup);
						try {
							await writeFile(gitMarkerPath, `gitdir: ${join(f.repoDir, ".git")}\n`);
							await expect(
								tool.execute(
									"replaced-identity",
									{ path: "README.md", content: "must not write" },
									undefined,
									undefined,
									{},
								),
							).rejects.toThrow();
						} finally {
							await rm(gitMarkerPath, { force: true });
							await rename(gitMarkerBackup, gitMarkerPath);
						}
						await expect(
							client
								.wrapGenericTool({ name: "denied", execute: vi.fn() }, undefined, observedCwd)
								.execute("denied", {}),
						).rejects.toThrow(/authorized/);
						push({
							messages: [{ id: "result", role: "assistant", content: [{ type: "text", text: "SDK write complete" }] }],
						});
					} else if (msg.type === "get_state" || msg.type === "abort") push({ isStreaming: false });
				})().catch((error) => {
					writeFailure = error;
					socket.terminate();
				});
			});
		});
		const runtime = createDeviceRuntime({ ...f.options, localOrigin: `http://127.0.0.1:${port}` });
		cleanups.push(() => runtime.close());
		const contract = createWorkContract({
			executionMode: "code",
			goal: "Write README",
			baseline: { repositoryId: f.repoId, commit: f.headCommit },
		});
		const task = {
			id: "real-sdk-write",
			attemptId: "attempt-1",
			roomId: "room-1",
			botId: f.bot.id,
			botRevision: f.bot.revision,
			deviceId: "device-1",
			text: "wire text",
			handoff: { repository: "repo", commit: f.headCommit, instructions: "unsealed handoff instruction" },
			leaseToken: "lease-sdk",
			leaseGeneration: 1,
			executionMode: "code" as const,
			contract,
			contextManifest: createContextManifest({ contract, context: null }),
		};
		await expect(
			runtime.onTask(task).catch((error) => {
				throw writeFailure ?? error;
			}),
		).resolves.toBe("SDK write complete");
		expect(writeFailure).toBeUndefined();
		expect(observedCwd).not.toBe(f.repoDir);
		expect(await readFile(join(f.repoDir, "README.md"), "utf8")).toBe("# Test Repo\n");
		expect(await readFile(join(observedCwd, "README.md"), "utf8")).toBe("SDK wrote in the isolated worktree\n");
		const outcome = runtime.recovery.getPendingOutboxEntry(task.id, task.attemptId)!;
		expect(outcome.artifactProduced).toBe(true);
		expect(Buffer.from(outcome.artifact!.patchBase64!, "base64").toString()).toContain(
			"SDK wrote in the isolated worktree",
		);
	});

	it("preserves chat resume ownership across fresh code turns in the same conversation", async () => {
		const f = await createRepoFixture();
		const conversationId = randomUUID();
		const chatTranscript = join(f.dir, "chat.jsonl");
		await writeFile(chatTranscript, "chat transcript");
		const observed: { mode?: string; resume?: string; cwd?: string }[] = [];
		const runtime = createDeviceRuntime({
			...f.options,
			executorFactory: (opts) => ({
				async run(task) {
					observed.push({ mode: task.executionMode, resume: opts.resumePath, cwd: opts.executionCwd });
					opts.onSession?.(task.id, `session-${task.id}`);
					opts.onSessionPath?.(
						task.id,
						task.executionMode === "code" ? join(f.dir, `${task.id}.jsonl`) : chatTranscript,
					);
					return "report";
				},
				close() {},
			}),
		});
		cleanups.push(() => runtime.close());
		const base = {
			attemptId: "attempt-1",
			roomId: "room-1",
			botId: f.bot.id,
			botRevision: f.bot.revision,
			deviceId: "device-1",
			conversationId,
			text: "task",
			leaseGeneration: 1,
		};
		await runtime.onTask({ ...base, id: "chat-first", leaseToken: "chat-lease" });
		for (let i = 1; i <= 2; i++) {
			const contract = createWorkContract({
				executionMode: "code",
				goal: `Code turn ${i}`,
				baseline: { repositoryId: f.repoId, commit: f.headCommit },
			});
			await runtime.onTask({
				...base,
				id: `code-turn-${i}`,
				leaseToken: `code-lease-${i}`,
				resume: false,
				executionMode: "code",
				contract,
				contextManifest: createContextManifest({ contract, context: null }),
			});
		}
		await runtime.onTask({ ...base, id: "chat-after-code", leaseToken: "chat-resume", resume: true });
		expect(observed.map((o) => o.resume)).toEqual([undefined, undefined, undefined, chatTranscript]);
		expect(observed[1].cwd).not.toBe(observed[2].cwd);
	});

	it("rejects unsealed context or taskState when the sealed manifest contains neither", async () => {
		const f = await createRepoFixture();
		const factory = vi.fn();
		const runtime = createDeviceRuntime({ ...f.options, executorFactory: factory });
		cleanups.push(() => runtime.close());
		const contract = createWorkContract({
			executionMode: "code",
			goal: "sealed goal",
			baseline: { repositoryId: f.repoId, commit: f.headCommit },
		});
		const base = {
			id: "unsealed",
			attemptId: "attempt-1",
			roomId: "room-1",
			botId: f.bot.id,
			botRevision: f.bot.revision,
			deviceId: "device-1",
			text: "task",
			leaseToken: "lease",
			executionMode: "code" as const,
			contract,
			contextManifest: createContextManifest({ contract, context: null }),
		};
		await expect(runtime.onTask({ ...base, context: { injected: true } as any })).rejects.toThrow(/wire context/);
		await expect(runtime.onTask({ ...base, taskState: { injected: true } as any })).rejects.toThrow(/wire taskState/);
		expect(factory).not.toHaveBeenCalled();
	});

	it("executes code mode task in isolated worktree and binds verified execution cwd", async () => {
		const f = await createRepoFixture();
		let observedExecutionCwd = "";
		let observedWorkspaceHandleId: string | undefined;

		const runtime = createDeviceRuntime({
			...f.options,
			executorFactory: (executorOpts) => {
				observedExecutionCwd = executorOpts.executionCwd ?? executorOpts.cwd;
				observedWorkspaceHandleId = executorOpts.workspaceHandleId;
				return {
					async run(task) {
						if (task.workspaceHandleId) {
						}
						await writeFile(join(observedExecutionCwd, "output.txt"), "hello from code task\n");
						return "task finished successfully";
					},
					close() {},
				};
			},
		});
		cleanups.push(() => runtime.close());

		const contract = createWorkContract({
			executionMode: "code",
			goal: "Write output.txt in worktree",
			baseline: {
				repositoryId: f.repoId,
				commit: f.headCommit,
			},
		});
		const contextManifest = createContextManifest({
			contract,
			context: { test: true },
		});

		const taskId = "task-code-1";
		const attemptId = "attempt-1";
		const result = await runtime.onTask({
			id: taskId,
			attemptId,
			deviceId: "device-1",
			botId: f.bot.id,
			botRevision: f.bot.revision,
			roomId: "room-1",
			leaseToken: "lease-code-1",
			leaseGeneration: 1,
			text: "do code work",
			executionMode: "code",
			contract,
			contextManifest,
		});

		expect(result).toBe("task finished successfully");
		expect(observedExecutionCwd).not.toBe(f.repoDir);
		expect(observedExecutionCwd).toContain("task-workspaces");
		expect(observedWorkspaceHandleId).toBeDefined();

		const outbox = runtime.recovery.getPendingOutboxEntry(taskId, attemptId);
		expect(outbox).toBeDefined();
		expect(outbox?.status).toBe("completed");
		expect(outbox?.executionCompleted).toBe(true);
		expect(outbox?.artifactProduced).toBe(true);
		expect(outbox?.artifact).toBeDefined();
		expect(outbox?.artifact?.producer.taskId).toBe(taskId);
		expect(outbox?.artifact?.producer.attemptId).toBe(attemptId);
		expect(outbox?.artifact?.patchBase64).toBeDefined();

		const { stdout: repoStatus } = await runGit(f.repoDir, ["status", "--porcelain"]);
		expect(repoStatus.trim()).toBe("");
	});

	it("strictly refuses resuming old sessions in code mode first slice", async () => {
		const f = await createRepoFixture();
		const runtime = createDeviceRuntime(f.options);
		cleanups.push(() => runtime.close());

		const contract = createWorkContract({
			executionMode: "code",
			goal: "Resume test",
			baseline: {
				repositoryId: f.repoId,
				commit: f.headCommit,
			},
		});
		const contextManifest = createContextManifest({
			contract,
			context: {},
		});

		await expect(
			runtime.onTask({
				id: "task-code-resume",
				attemptId: "attempt-1",
				deviceId: "device-1",
				botId: f.bot.id,
				botRevision: f.bot.revision,
				roomId: "room-1",
				leaseToken: "lease-1",
				leaseGeneration: 1,
				text: "attempt resume",
				executionMode: "code",
				resume: true,
				contract,
				contextManifest,
			}),
		).rejects.toThrow(/refuses resuming old sessions/i);
	});

	it("marks task as failed when artifact capture fails, recording executionCompleted=true and artifactProduced=false", async () => {
		const f = await createRepoFixture();
		let executorClosed = false;

		const runtime = createDeviceRuntime({
			...f.options,
			executorFactory: (executorOpts) => {
				return {
					async run() {
						const cwd = executorOpts.executionCwd ?? executorOpts.cwd;
						const largeBuf = Buffer.alloc(200 * 1024, "A");
						await writeFile(join(cwd, "large.bin"), largeBuf);
						return "work finished but patch too large";
					},
					close() {
						executorClosed = true;
					},
				};
			},
		});
		cleanups.push(() => runtime.close());

		const contract = createWorkContract({
			executionMode: "code",
			goal: "Trigger oversized patch",
			baseline: {
				repositoryId: f.repoId,
				commit: f.headCommit,
			},
		});
		const contextManifest = createContextManifest({
			contract,
			context: {},
		});

		const taskId = "task-code-fail-capture";
		const attemptId = "attempt-1";

		await expect(
			runtime.onTask({
				id: taskId,
				attemptId,
				deviceId: "device-1",
				botId: f.bot.id,
				botRevision: f.bot.revision,
				roomId: "room-1",
				leaseToken: "lease-capture-fail",
				leaseGeneration: 1,
				text: "make oversized patch",
				executionMode: "code",
				contract,
				contextManifest,
			}),
		).rejects.toThrow(/Task artifact capture failed/i);

		expect(executorClosed).toBe(true);

		const outbox = runtime.recovery.getPendingOutboxEntry(taskId, attemptId);
		expect(outbox).toBeDefined();
		expect(outbox?.status).toBe("failed");
		expect(outbox?.executionCompleted).toBe(true);
		expect(outbox?.artifactProduced).toBe(false);
		expect(outbox?.artifact).toBeUndefined();
	});

	it("does not capture artifact as completed on manual cancellation", async () => {
		const f = await createRepoFixture();
		const controller = new AbortController();

		const runtime = createDeviceRuntime({
			...f.options,
			executorFactory: () => ({
				async run() {
					controller.abort(new Error("User cancelled"));
					return "done text that should not count as completed";
				},
				close() {},
			}),
		});
		cleanups.push(() => runtime.close());

		const contract = createWorkContract({
			executionMode: "code",
			goal: "Cancel test",
			baseline: {
				repositoryId: f.repoId,
				commit: f.headCommit,
			},
		});
		const contextManifest = createContextManifest({
			contract,
			context: {},
		});

		const taskId = "task-code-cancelled";
		const attemptId = "attempt-1";

		await expect(
			runtime.onTask(
				{
					id: taskId,
					attemptId,
					deviceId: "device-1",
					botId: f.bot.id,
					botRevision: f.bot.revision,
					roomId: "room-1",
					leaseToken: "lease-cancelled",
					leaseGeneration: 1,
					text: "will be cancelled",
					executionMode: "code",
					contract,
					contextManifest,
				},
				controller.signal,
			),
		).rejects.toThrow();

		const outbox = runtime.recovery.getPendingOutboxEntry(taskId, attemptId);
		expect(outbox).toBeDefined();
		expect(outbox?.status).toBe("interrupted");
		expect(outbox?.artifactProduced).toBe(false);
	});

	it("preserves artifact across restart and requires exact ACK to clear Outbox", async () => {
		const f = await createRepoFixture();

		const fakeArtifact: DeviceArtifact = {
			id: "artifact-123",
			digest: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
			producer: {
				deviceId: "device-1",
				botId: f.bot.id,
				taskId: "task-recovery-1",
				attemptId: "attempt-1",
			},
			patchBase64: Buffer.from("test patch").toString("base64"),
			patchSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
			createdAt: Date.now(),
		};
		const { computeArtifactDigest } = await import("../../server/device-center/work-contract.js");
		fakeArtifact.digest = computeArtifactDigest(fakeArtifact);
		fakeArtifact.patchSha256 = (await import("node:crypto"))
			.createHash("sha256")
			.update(Buffer.from("test patch"))
			.digest("hex");
		fakeArtifact.digest = computeArtifactDigest(fakeArtifact);

		const runtime1 = createDeviceRuntime(f.options);
		runtime1.recovery.recordTaskStart({
			taskId: "task-recovery-1",
			attemptId: "attempt-1",
			botId: f.bot.id,
			deviceId: "device-1",
			roomId: "room-1",
			leaseToken: "lease-rec-1",
			leaseGeneration: 1,
		});

		const outboxEntry = runtime1.recovery.recordTaskFinish(
			{
				id: "task-recovery-1",
				attemptId: "attempt-1",
				botId: f.bot.id,
				deviceId: "device-1",
				roomId: "room-1",
				leaseToken: "lease-rec-1",
				leaseGeneration: 1,
			},
			{
				status: "completed",
				report: "report with artifact",
				artifact: fakeArtifact,
				executionCompleted: true,
				artifactProduced: true,
			},
		);

		expect(outboxEntry.artifact?.digest).toBe(fakeArtifact.digest);
		await runtime1.close();

		const runtime2 = createDeviceRuntime(f.options);
		cleanups.push(async () => {
			await runtime2.close();
		});

		const recovered = runtime2.recovery.getPendingOutboxEntry("task-recovery-1", "attempt-1");
		expect(recovered).toBeDefined();
		expect(recovered?.artifact?.digest).toBe(fakeArtifact.digest);
		expect(recovered?.executionCompleted).toBe(true);
		expect(recovered?.artifactProduced).toBe(true);

		const badAck1 = runtime2.recovery.ackOutbox("task-recovery-1", "attempt-1", "wrong-fingerprint");
		expect(badAck1).toBe(false);

		const badAck2 = runtime2.recovery.ackOutbox("task-recovery-1", "attempt-1", recovered!.fingerprint, {
			artifactDigest: "mismatched-digest",
		});
		expect(badAck2).toBe(false);

		const goodAck = runtime2.recovery.ackOutbox("task-recovery-1", "attempt-1", recovered!.fingerprint, {
			artifactDigest: fakeArtifact.digest,
		});
		expect(goodAck).toBe(true);

		expect(runtime2.recovery.getPendingOutboxEntry("task-recovery-1", "attempt-1")).toBeUndefined();
	});

	it("rejects conflicting duplicate attempt concurrently", async () => {
		const f = await createRepoFixture();
		const runtime = createDeviceRuntime(f.options);
		cleanups.push(() => runtime.close());

		runtime.recovery.recordTaskStart({
			taskId: "task-conflict",
			attemptId: "attempt-1",
			botId: f.bot.id,
			deviceId: "device-1",
			roomId: "room-1",
			leaseToken: "lease-1",
			leaseGeneration: 1,
		});

		expect(() => {
			runtime.recovery.recordTaskStart({
				taskId: "task-conflict",
				attemptId: "attempt-2",
				botId: f.bot.id,
				deviceId: "device-1",
				roomId: "room-1",
				leaseToken: "lease-2",
				leaseGeneration: 1,
			});
		}).toThrow(/Conflicting attempt active/i);
	});

	it("prevents forged workspace handle and enforces executionCwd in agent-service", async () => {
		const f = await createRepoFixture();
		const { registerBotExecution, getBotExecution } = await import("../../server/device-center/bot-execution.js");

		const fakeHandleId = "forged-handle-uuid-1234";
		const isolatedCwd = join(f.dir, "isolated-worktree");
		await mkdir(isolatedCwd);

		const context = {
			executionCwd: isolatedCwd,
			executionMode: "code" as const,
			workspaceHandleId: fakeHandleId,
			deviceId: "device-1",
			taskId: "task-guard",
			attemptId: "attempt-1",
		};
		expect(() => registerBotExecution(f.bot, undefined, context)).toThrow(/trusted task workspace/);
		expect(() =>
			registerBotExecution(f.bot, undefined, {
				...context,
				workspaceCapability: { handleId: fakeHandleId, resolve: () => ({ cwd: isolatedCwd }) } as any,
			}),
		).toThrow(/trusted task workspace/);
		expect(() =>
			registerBotExecution(f.bot, undefined, {
				executionCwd: isolatedCwd,
			}),
		).toThrow(/Chat execution cwd/);

		expect(() => getBotExecution("device-task-forged-random")).toThrow(/Unregistered Bot execution client/i);
	});

	it("strictly refuses legacy or compat fingerprint bypass when artifact or proof is present", async () => {
		const f = await createRepoFixture();
		const { computeOutcomeFingerprint } = await import("../../server/device-center/task-outcome.js");
		const { settleTaskTerminalOutcome } = await import("../../server/device-center/task-settlement.js");

		const contract = createWorkContract({
			executionMode: "code",
			goal: "Fingerprint test",
			baseline: {
				repositoryId: f.repoId,
				commit: f.headCommit,
			},
		});

		const contextManifest = createContextManifest({
			contract,
			context: { test: true },
		});

		const fakeArtifact: DeviceArtifact = {
			id: "artifact-proof-check",
			digest: "",
			producer: {
				deviceId: "device-1",
				botId: f.bot.id,
				taskId: "task-fp-1",
				attemptId: "attempt-1",
				contractDigest: contract.digest,
				manifestDigest: contextManifest.digest,
			},
			baseline: {
				repositoryId: f.repoId,
				commit: f.headCommit,
			},
			inputTree: "0123456789abcdef0123456789abcdef01234567",
			outputTree: "abcdef0123456789abcdef0123456789abcdef01",
			patchBase64: Buffer.from("dummy patch").toString("base64"),
			patchSha256: (await import("node:crypto")).createHash("sha256").update(Buffer.from("dummy patch")).digest("hex"),
			createdAt: Date.now(),
		};
		const { computeArtifactDigest } = await import("../../server/device-center/work-contract.js");
		fakeArtifact.digest = computeArtifactDigest(fakeArtifact);

		const canonicalFp = computeOutcomeFingerprint(
			"task-fp-1",
			"attempt-1",
			"completed",
			"success report",
			undefined,
			undefined,
			fakeArtifact.digest,
			true,
			true,
		);

		const legacyFp = computeOutcomeFingerprint(
			"task-fp-1",
			"attempt-1",
			"completed",
			"success report",
			undefined,
			undefined,
		);

		const draftState: any = {
			devices: [{ id: "device-1", accountId: "acc-1" }],
			bots: [{ id: f.bot.id, deviceId: "device-1", accountId: "acc-1", enabled: true, revision: f.bot.revision }],
			rooms: [{ id: "room-1", botIds: [f.bot.id], accountId: "acc-1" }],
			tasks: [
				{
					id: "task-fp-1",
					attemptId: "attempt-1",
					botId: f.bot.id,
					botRevision: f.bot.revision,
					deviceId: "device-1",
					accountId: "acc-1",
					roomId: "room-1",
					leaseToken: "lease-fp-1",
					leaseGeneration: 1,
					status: "running",
					executionMode: "code",
					contract,
					contextManifest,
				},
			],
			messages: [],
			conversationMessages: [],
			receipts: [],
		};

		const ctx: any = {
			settings: { groupContextBytes: 10000 },
			getHistoryLimit: () => 50,
		};

		const bypassResult = settleTaskTerminalOutcome(
			draftState,
			"device-1",
			{
				type: "task_event",
				taskId: "task-fp-1",
				attemptId: "attempt-1",
				botId: f.bot.id,
				leaseToken: "lease-fp-1",
				leaseGeneration: 1,
				status: "completed",
				report: "success report",
				artifact: fakeArtifact,
				executionCompleted: true,
				artifactProduced: true,
				fingerprint: legacyFp,
			},
			ctx,
		);

		expect(bypassResult.accepted).toBe(false);
		expect(bypassResult.reason).toContain("Outcome fingerprint mismatch");

		const validResult = settleTaskTerminalOutcome(
			draftState,
			"device-1",
			{
				type: "task_event",
				taskId: "task-fp-1",
				attemptId: "attempt-1",
				botId: f.bot.id,
				leaseToken: "lease-fp-1",
				leaseGeneration: 1,
				status: "completed",
				report: "success report",
				artifact: fakeArtifact,
				executionCompleted: true,
				artifactProduced: true,
				fingerprint: canonicalFp,
			},
			ctx,
		);

		expect(validResult.accepted).toBe(true);
		expect(validResult.fingerprint).toBe(canonicalFp);
	});

	it("does not finalize Outbox and retains worktree when executor stop is unconfirmed", async () => {
		const f = await createRepoFixture();
		const { DeviceTaskStopUnconfirmedError } = await import("../../server/device-center/runtime.js");
		const { existsSync } = await import("node:fs");

		let capturedWorktreeDir = "";

		const runtime = createDeviceRuntime({
			...f.options,
			executorFactory: (executorOpts) => {
				capturedWorktreeDir = executorOpts.executionCwd ?? executorOpts.cwd;
				return {
					async run() {
						await writeFile(join(capturedWorktreeDir, "in-flight.txt"), "running\n");
						throw new Error("Simulated model error");
					},
					close() {
						return Promise.reject(new DeviceTaskStopUnconfirmedError(new Error("Cannot stop executor process")));
					},
				};
			},
		});
		cleanups.push(async () => {
			await runtime.close().catch(() => {});
		});

		const contract = createWorkContract({
			executionMode: "code",
			goal: "Stop unconfirmed test",
			baseline: {
				repositoryId: f.repoId,
				commit: f.headCommit,
			},
		});
		const contextManifest = createContextManifest({
			contract,
			context: {},
		});

		const taskId = "task-stop-unconfirmed";
		const attemptId = "attempt-1";

		await expect(
			runtime.onTask({
				id: taskId,
				attemptId,
				deviceId: "device-1",
				botId: f.bot.id,
				botRevision: f.bot.revision,
				roomId: "room-1",
				leaseToken: "lease-unconfirmed",
				leaseGeneration: 1,
				text: "will fail stop confirmation",
				executionMode: "code",
				contract,
				contextManifest,
			}),
		).rejects.toThrow(/Cannot stop executor process/i);

		const outbox = runtime.recovery.getPendingOutboxEntry(taskId, attemptId);
		expect(outbox).toBeUndefined();

		const activeLease = runtime.recovery.getActiveLease(taskId, attemptId);
		expect(activeLease).toBeDefined();

		expect(capturedWorktreeDir).toBeTruthy();
		expect(existsSync(capturedWorktreeDir)).toBe(true);
	});

	it("retains dirty worktree on disk when artifact capture fails", async () => {
		const f = await createRepoFixture();
		const { existsSync } = await import("node:fs");

		let capturedWorktreeDir = "";

		const runtime = createDeviceRuntime({
			...f.options,
			executorFactory: (executorOpts) => {
				capturedWorktreeDir = executorOpts.executionCwd ?? executorOpts.cwd;
				return {
					async run() {
						await writeFile(join(capturedWorktreeDir, "dirty.txt"), "dirty content\n");
						const huge = Buffer.alloc(200 * 1024, "X");
						await writeFile(join(capturedWorktreeDir, "huge.bin"), huge);
						return "finished run";
					},
					close() {},
				};
			},
		});
		cleanups.push(async () => {
			await runtime.close();
		});

		const contract = createWorkContract({
			executionMode: "code",
			goal: "Dirty capture fail",
			baseline: {
				repositoryId: f.repoId,
				commit: f.headCommit,
			},
		});
		const contextManifest = createContextManifest({
			contract,
			context: {},
		});

		const taskId = "task-dirty-retain";
		const attemptId = "attempt-1";

		await expect(
			runtime.onTask({
				id: taskId,
				attemptId,
				deviceId: "device-1",
				botId: f.bot.id,
				botRevision: f.bot.revision,
				roomId: "room-1",
				leaseToken: "lease-dirty-1",
				leaseGeneration: 1,
				text: "dirty run",
				executionMode: "code",
				contract,
				contextManifest,
			}),
		).rejects.toThrow(/Task artifact capture failed/i);

		expect(capturedWorktreeDir).toBeTruthy();
		expect(existsSync(capturedWorktreeDir)).toBe(true);
		expect(existsSync(join(capturedWorktreeDir, "dirty.txt"))).toBe(true);
	});

	it("rejects task when wire context or taskState is tampered against sealed contextManifest", async () => {
		const f = await createRepoFixture();
		const runtime = createDeviceRuntime(f.options);
		cleanups.push(async () => {
			await runtime.close();
		});

		const contract = createWorkContract({
			executionMode: "code",
			goal: "Tamper check",
			baseline: {
				repositoryId: f.repoId,
				commit: f.headCommit,
			},
		});
		const contextManifest = createContextManifest({
			contract,
			context: { original: "sealed context", roomId: "room-1" },
			taskState: { original: "sealed state" },
		});

		await expect(
			runtime.onTask({
				id: "task-tamper-ctx",
				attemptId: "attempt-1",
				deviceId: "device-1",
				botId: f.bot.id,
				botRevision: f.bot.revision,
				roomId: "room-1",
				leaseToken: "lease-tamper-1",
				leaseGeneration: 1,
				text: "tamper test",
				executionMode: "code",
				contract,
				contextManifest,
				context: { original: "TAMPERED context", roomId: "room-1" } as any,
			}),
		).rejects.toThrow(/Task wire context does not match sealed contextManifest/i);

		await expect(
			runtime.onTask({
				id: "task-tamper-state",
				attemptId: "attempt-1",
				deviceId: "device-1",
				botId: f.bot.id,
				botRevision: f.bot.revision,
				roomId: "room-1",
				leaseToken: "lease-tamper-2",
				leaseGeneration: 1,
				text: "tamper test",
				executionMode: "code",
				contract,
				contextManifest,
				context: { original: "sealed context", roomId: "room-1" } as any,
				taskState: { original: "TAMPERED state" } as any,
			}),
		).rejects.toThrow(/Task wire taskState does not match sealed contextManifest/i);
	});

	it("fails dependent task when dependent tasks share contract.id but have mismatched revisions", async () => {
		const { settleTaskDependencies } = await import("../../server/device-center/task-settlement.js");

		const contractId = "contract-shared-id";
		const predTask: any = {
			id: "task-pred",
			attemptId: "att-1",
			botId: "bot-1",
			deviceId: "dev-1",
			roomId: "room-1",
			accountId: "acc-1",
			status: "completed",
			report: "pred finished",
			contract: { id: contractId, revision: 1, executionMode: "code" },
		};

		const succTask: any = {
			id: "task-succ",
			attemptId: "att-2",
			botId: "bot-1",
			deviceId: "dev-1",
			roomId: "room-1",
			accountId: "acc-1",
			status: "waiting",
			dependsOnTaskId: "task-pred",
			contract: { id: contractId, revision: 2, executionMode: "code" },
		};

		const draftState: any = {
			tasks: [predTask, succTask],
			rooms: [{ id: "room-1", botIds: ["bot-1"] }],
			bots: [{ id: "bot-1", accountId: "acc-1" }],
			messages: [],
			conversationMessages: [],
			receipts: [],
		};

		const ctx: any = {
			settings: { groupContextBytes: 10000 },
			getHistoryLimit: () => 50,
		};

		const effects = settleTaskDependencies(draftState, ctx);
		expect(effects.cascadedFailedTaskIds).toContain("task-succ");
		expect(succTask.status).toBe("failed");
		expect(succTask.report).toContain("契约版本冲突");

		const diffContractTask: any = {
			id: "task-diff",
			attemptId: "att-3",
			botId: "bot-1",
			deviceId: "dev-1",
			roomId: "room-1",
			accountId: "acc-1",
			status: "waiting",
			dependsOnTaskId: "task-pred",
			contract: { id: "different-contract-id", revision: 2, executionMode: "code" },
		};

		draftState.tasks.push(diffContractTask);
		const effects2 = settleTaskDependencies(draftState, ctx);
		expect(effects2.readyTaskIds).toContain("task-diff");
		expect(diffContractTask.status).toBe("queued");
	});

	it("strictly enforces contextManifest.executionPolicy binding against task and acquired bot lease", async () => {
		const f = await createRepoFixture();
		const runtime = createDeviceRuntime(f.options);
		cleanups.push(async () => {
			await runtime.close();
		});

		const contract = createWorkContract({
			executionMode: "code",
			goal: "Policy binding check",
			baseline: {
				repositoryId: f.repoId,
				commit: f.headCommit,
			},
		});

		const { computeManifestDigest } = await import("../../server/device-center/work-contract.js");
		const baseManifest = createContextManifest({
			contract,
			context: { test: true },
		});
		const badRevisionManifest: any = {
			...baseManifest,
			executionPolicy: {
				deviceId: "device-1",
				botId: f.bot.id,
				botRevision: f.bot.revision + 999,
			},
		};
		badRevisionManifest.digest = computeManifestDigest(badRevisionManifest);

		await expect(
			runtime.onTask({
				id: "task-policy-bad-rev",
				attemptId: "attempt-1",
				deviceId: "device-1",
				botId: f.bot.id,
				botRevision: f.bot.revision,
				roomId: "room-1",
				leaseToken: "lease-policy-1",
				leaseGeneration: 1,
				text: "bad revision policy",
				executionMode: "code",
				contract,
				contextManifest: badRevisionManifest,
			}),
		).rejects.toThrow(/Context manifest execution policy mismatch/i);

		const badDeviceManifest: any = {
			...baseManifest,
			executionPolicy: {
				deviceId: "other-device",
				botId: f.bot.id,
				botRevision: f.bot.revision,
			},
		};
		badDeviceManifest.digest = computeManifestDigest(badDeviceManifest);

		await expect(
			runtime.onTask({
				id: "task-policy-bad-dev",
				attemptId: "attempt-1",
				deviceId: "device-1",
				botId: f.bot.id,
				botRevision: f.bot.revision,
				roomId: "room-1",
				leaseToken: "lease-policy-2",
				leaseGeneration: 1,
				text: "bad device policy",
				executionMode: "code",
				contract,
				contextManifest: badDeviceManifest,
			}),
		).rejects.toThrow(/Context manifest execution policy mismatch/i);
	});

	it("prevents in-memory alias mutation from altering stored task.artifact evidence and strictly rejects non-boolean proofs", async () => {
		const f = await createRepoFixture();
		const { settleTaskTerminalOutcome } = await import("../../server/device-center/task-settlement.js");
		const { computeOutcomeFingerprint } = await import("../../server/device-center/task-outcome.js");
		const { computeArtifactDigest } = await import("../../server/device-center/work-contract.js");

		const contract = createWorkContract({
			executionMode: "code",
			goal: "Alias guard test",
			baseline: {
				repositoryId: f.repoId,
				commit: f.headCommit,
			},
		});
		const contextManifest = createContextManifest({
			contract,
			context: { test: true },
		});

		const mutableArtifact: any = {
			id: "artifact-alias-1",
			digest: "",
			producer: {
				deviceId: "device-1",
				botId: f.bot.id,
				taskId: "task-alias-1",
				attemptId: "attempt-1",
				contractDigest: contract.digest,
				manifestDigest: contextManifest.digest,
			},
			baseline: {
				repositoryId: f.repoId,
				commit: f.headCommit,
			},
			inputTree: "0123456789abcdef0123456789abcdef01234567",
			outputTree: "abcdef0123456789abcdef0123456789abcdef01",
			patchBase64: Buffer.from("original patch").toString("base64"),
			patchSha256: (await import("node:crypto"))
				.createHash("sha256")
				.update(Buffer.from("original patch"))
				.digest("hex"),
			createdAt: Date.now(),
		};
		mutableArtifact.digest = computeArtifactDigest(mutableArtifact);

		const canonicalFp = computeOutcomeFingerprint(
			"task-alias-1",
			"attempt-1",
			"completed",
			"report text",
			undefined,
			undefined,
			mutableArtifact.digest,
			true,
			true,
		);

		const draftState: any = {
			devices: [{ id: "device-1", accountId: "acc-1" }],
			bots: [{ id: f.bot.id, deviceId: "device-1", accountId: "acc-1", enabled: true, revision: f.bot.revision }],
			rooms: [{ id: "room-1", botIds: [f.bot.id], accountId: "acc-1" }],
			tasks: [
				{
					id: "task-alias-1",
					attemptId: "attempt-1",
					botId: f.bot.id,
					botRevision: f.bot.revision,
					deviceId: "device-1",
					accountId: "acc-1",
					roomId: "room-1",
					leaseToken: "lease-alias-1",
					leaseGeneration: 1,
					status: "running",
					executionMode: "code",
					contract,
					contextManifest,
				},
			],
			messages: [],
			conversationMessages: [],
			receipts: [],
		};

		const ctx: any = {
			settings: { groupContextBytes: 10000 },
			getHistoryLimit: () => 50,
		};

		const result = settleTaskTerminalOutcome(
			draftState,
			"device-1",
			{
				type: "task_event",
				taskId: "task-alias-1",
				attemptId: "attempt-1",
				botId: f.bot.id,
				leaseToken: "lease-alias-1",
				leaseGeneration: 1,
				status: "completed",
				report: "report text",
				artifact: mutableArtifact,
				executionCompleted: true,
				artifactProduced: true,
				fingerprint: canonicalFp,
			},
			ctx,
		);

		expect(result.accepted).toBe(true);
		const recordedTask = draftState.tasks[0];
		expect(recordedTask.artifact?.digest).toBe(mutableArtifact.digest);

		const originalDigest = mutableArtifact.digest;
		mutableArtifact.patchBase64 = Buffer.from("TAMPERED PATCH").toString("base64");
		mutableArtifact.producer.botId = "hacked-bot";

		expect(recordedTask.artifact.producer.botId).toBe(f.bot.id);
		expect(recordedTask.artifact.patchBase64).toBe(Buffer.from("original patch").toString("base64"));
		expect(recordedTask.artifact.digest).toBe(originalDigest);

		expect(Object.isFrozen(recordedTask.artifact)).toBe(true);
		expect(Object.isFrozen(recordedTask.artifact.producer)).toBe(true);

		const nonBoolResult = settleTaskTerminalOutcome(
			draftState,
			"device-1",
			{
				type: "task_event",
				taskId: "task-alias-1",
				attemptId: "attempt-1",
				botId: f.bot.id,
				leaseToken: "lease-alias-1",
				leaseGeneration: 1,
				status: "failed",
				report: "failed",
				executionCompleted: "true" as any,
			},
			ctx,
		);
		expect(nonBoolResult.accepted).toBe(false);
		expect(nonBoolResult.reason).toContain("Execution proof 'executionCompleted' must be a boolean");
	});
});
