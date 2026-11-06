import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { createDeviceHub } from "../../server/device-center/hub.js";
import { computeCanonicalRepositoryId } from "../../server/workspace-handle.js";
import { hashSecret, readPersistedHub } from "../../server/device-center/store.js";
import { addDelivery, addReview } from "../../server/device-center/hub-deliveries.js";
import {
	hubPrepareIntegration,
	hubVerifyIntegration,
	hubConfirmIntegration,
	hubCancelIntegration,
} from "../../server/device-center/hub-integration.js";
import {
	devicePrepareIntegration,
	deviceVerifyIntegration,
	deviceConfirmIntegration,
	deviceCancelIntegration,
	deviceCancelPublication,
	devicePublicationStatus,
} from "../../server/device-center/device-integration.js";
import {
	computeArtifactDigest,
	canonicalizeJson,
	createContextManifest,
	createWorkContract,
} from "../../server/device-center/work-contract.js";
import { deliveryReviewMatches } from "../../server/device-center/delivery-subject.js";
import type { DeviceArtifact, DeviceDelivery, DeviceIntegration } from "../../server/protocol.js";

const exec = promisify(execFile);
const git = async (cwd: string, args: string[]) => (await exec("git", args, { cwd, windowsHide: true })).stdout.trim();
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

describe("artifact delivery verification authority through Hub HTTP and WAL", { timeout: 30000 }, () => {
	let dir: string, repo: string, dataDir: string, base: string, outputTree: string;
	let hub: Awaited<ReturnType<typeof createDeviceHub>>;
	let accountId: string, cookie: string, port: number;
	let delivery: DeviceDelivery;
	let actor: { accountId: string; bot: any };
	let driver: { callDeviceCommand: (device: string, action: string, payload: any) => Promise<unknown> };
	const path = "/api/rooms/room/conversations/conversation";
	async function request(url: string, body?: unknown, bot = false, method?: string) {
		return new Promise<{ status: number; body: any; cookie: string }>((resolve, reject) => {
			const req = httpRequest(
				`http://127.0.0.1:${port}${bot ? url.replace("/api/", "/api/agent/") : url}`,
				{
					method: method ?? (body === undefined ? "GET" : "POST"),
					headers: {
						Host: "hub.test",
						Origin: "https://hub.test",
						"Content-Type": "application/json",
						...(bot
							? { ["Author" + "ization"]: "Bearer test-device-token", "X-Device-Id": "device" }
							: { Cookie: cookie ?? "" }),
					},
				},
				(res) => {
					let raw = "";
					res.on("data", (chunk) => (raw += chunk));
					res.on("end", () =>
						resolve({ status: res.statusCode!, body: JSON.parse(raw), cookie: res.headers["set-cookie"]?.[0] ?? "" }),
					);
				},
			);
			req.on("error", reject);
			if (body !== undefined) req.write(JSON.stringify(body));
			req.end();
		});
	}
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "hub-artifact-integration-"));
		repo = join(dir, "repo");
		dataDir = join(dir, "hub");
		await mkdir(repo);
		await git(repo, ["init", "-b", "main"]);
		await git(repo, ["config", "user.name", "Integration Test"]);
		await git(repo, ["config", "user.email", "integration@example.test"]);
		await git(repo, ["config", "commit.gpgSign", "false"]);
		await git(repo, ["config", "core.autocrlf", "false"]);
		await writeFile(join(repo, "file.txt"), "baseline\n");
		await git(repo, ["add", "."]);
		await git(repo, ["commit", "-m", "baseline"]);
		base = await git(repo, ["rev-parse", "HEAD"]);
		const inputTree = await git(repo, ["rev-parse", "HEAD^{tree}"]);
		await git(repo, ["checkout", "-b", "artifact-source"]);
		await writeFile(join(repo, "file.txt"), "baseline\nartifact\n");
		await git(repo, ["add", "."]);
		await git(repo, ["commit", "-m", "artifact source"]);
		outputTree = await git(repo, ["rev-parse", "HEAD^{tree}"]);
		const { stdout: patch } = await exec("git", ["diff", "--binary", base, "HEAD"], { cwd: repo, windowsHide: true });
		await git(repo, ["checkout", "--detach", base]);
		driver = {
			callDeviceCommand: async (_device, action, payload) => {
				const local = { ...payload, repoRoot: repo, dataDir };
				if (action === "integration_prepare") return devicePrepareIntegration(local);
				if (action === "integration_verify") return deviceVerifyIntegration(local);
				if (action === "integration_confirm") return deviceConfirmIntegration(local);
				if (action === "integration_publication_status") return devicePublicationStatus(local);
				if (action === "integration_cancel")
					return payload.publishIntent ? deviceCancelPublication(local) : deviceCancelIntegration(local);
				throw new Error("Unexpected RPC");
			},
		};
		hub = await createDeviceHub({
			dataDir,
			publicUrl: "https://hub.test",
			relay: {
				callDevice: (id: string, action: string, payload: unknown) => driver.callDeviceCommand(id, action, payload),
			} as any,
		});
		await new Promise<void>((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
		port = (hub.server.address() as { port: number }).port;
		expect(port).toBeGreaterThanOrEqual(8900);
		const reg = await request("/api/auth/register", { username: "artifact-test", password: "test-only-password" });
		expect(reg.status).toBe(201);
		accountId = reg.body.account.id;
		cookie = reg.cookie;
		const contract = createWorkContract({
			id: "contract",
			revision: 1,
			executionMode: "code",
			goal: "Implement artifact",
			baseline: { repositoryId: await computeCanonicalRepositoryId(repo), commit: base },
			acceptanceCriteria: ["File contains artifact / 文件含变更", "Baseline is retained"],
		});
		const manifest = createContextManifest({
			contract,
			context: {},
			executionPolicy: { deviceId: "device", botId: "author", botRevision: 1 },
		});
		const art: DeviceArtifact = {
			id: "artifact",
			digest: "",
			producer: {
				deviceId: "device",
				botId: "author",
				taskId: "code-task",
				attemptId: "code-attempt",
				contractDigest: contract.digest,
				manifestDigest: manifest.digest,
			},
			baseline: contract.baseline,
			inputTree,
			outputTree,
			patchBase64: Buffer.from(patch).toString("base64"),
			patchSha256: digest(patch),
			createdAt: Date.now(),
		};
		art.digest = computeArtifactDigest(art);
		await hub.store.transact((s) => {
			s.devices.push({
				id: "device",
				accountId,
				name: "Test device",
				credentialHash: hashSecret("test-device-token"),
				createdAt: Date.now(),
			});
			for (const id of ["author", "target", "reviewer"])
				s.bots.push({
					id,
					accountId,
					deviceId: "device",
					revision: 1,
					enabled: true,
					name: id,
					cwd: repo,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				} as any);
			s.rooms.push({
				id: "room",
				accountId,
				name: "Test room",
				botIds: ["author", "target", "reviewer"],
				createdAt: Date.now(),
			});
			s.conversations.push({
				id: "conversation",
				accountId,
				roomId: "room",
				botId: "author",
				botRevision: 1,
				deviceId: "device",
				name: "Code",
				latestTaskId: "current-task",
				rootTaskId: "code-task",
				dispatchDepth: 0,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			const common = {
				accountId,
				roomId: "room",
				conversationId: "conversation",
				botId: "author",
				deviceId: "device",
				botRevision: 1,
				text: "test",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};
			s.tasks.push({
				...common,
				id: "code-task",
				attemptId: "code-attempt",
				status: "completed",
				executionMode: "code",
				contract,
				contextManifest: manifest,
				artifact: art,
				executionCompleted: true,
				artifactProduced: true,
			});
			s.tasks.push({ ...common, id: "current-task", attemptId: "current-attempt", status: "running" });
		});
		actor = { accountId, bot: hub.store.snapshot().bots.find((b) => b.id === "author")! };
		delivery = await hub.store.transact((s) =>
			addDelivery(s, "room", "conversation", actor, {
				sourceBotId: "author",
				parentTaskId: "current-task",
				artifactTaskId: "code-task",
				idempotencyKey: "delivery",
				summary: "Artifact ready",
				checks: [],
			}),
		);
	}, 30000);
	afterEach(async () => {
		await hub?.close();
		await rm(dir, { recursive: true, force: true });
	});
	const criteriaResults = [
		{ criterionIndex: 0, verdict: "met", evidence: "verified file content" },
		{ criterionIndex: 1, verdict: "met", evidence: "sealed baseline unchanged" },
	];
	async function prepare(): Promise<DeviceIntegration> {
		return hubPrepareIntegration(
			hub.store,
			"room",
			"conversation",
			{ accountId },
			{ deliveryId: delivery.id, targetBotId: "target" },
			driver,
		);
	}
	async function verify(prep: DeviceIntegration): Promise<DeviceIntegration> {
		return hubVerifyIntegration(
			hub.store,
			"room",
			"conversation",
			prep.id,
			{ accountId },
			{
				commands: [
					"node -e \"if(!require('fs').readFileSync('file.txt','utf8').includes('artifact'))process.exit(1)\"",
				],
			},
			driver,
		);
	}
	async function review(verified: DeviceIntegration, extra = {}) {
		return hub.store.transact((s) =>
			addReview(
				s,
				"room",
				"conversation",
				{ accountId },
				{
					idempotencyKey: "review",
					deliveryId: delivery.id,
					artifactDigest: delivery.artifactRef!.artifactDigest,
					integrationId: verified.id,
					verificationDigest: verified.verification!.digest,
					verdict: "accepted",
					summary: "Reviewed every criterion",
					criteriaResults,
					...extra,
				},
			),
		);
	}

	it("derives immutable artifact from a completed task while preserving running write authority, verifies then reviews and applies via HTTP", async () => {
		expect(delivery.commit).toBeUndefined();
		expect(delivery.taskId).toBe("current-task");
		expect(delivery.artifactRef!.artifactTaskId).toBe("code-task");
		expect(delivery.acceptanceCriteria).toHaveLength(2);
		const prepResponse = await request(`${path}/integrations`, { deliveryId: delivery.id, targetBotId: "target" });
		expect(prepResponse.status).toBe(200);
		const prep = prepResponse.body.integration;
		expect(prep.preparedTree).toBe(outputTree);
		expect(prep.materializedCommit).not.toBe(outputTree);
		const noReview = await request(`${path}/reviews`, {
			idempotencyKey: "early",
			deliveryId: delivery.id,
			artifactDigest: delivery.artifactRef!.artifactDigest,
			verdict: "accepted",
			summary: "Premature",
			criteriaResults,
		});
		expect(noReview.status).toBe(409);
		const botVerify = await request(
			`${path}/integrations/${prep.id}/verify`,
			{ sourceBotId: "author", commands: ['node -e "process.exit(0)"'] },
			true,
		);
		expect(botVerify.status).toBe(403);
		const originalDriver = driver;
		driver = {
			callDeviceCommand: async (id, action, payload) => {
				const raw = await originalDriver.callDeviceCommand(id, action, payload);
				return action === "integration_verify"
					? { ...(raw as object), digest: "device-cannot-authorize-digest", verifiedAt: 0, untrustedExtra: "ignored" }
					: raw;
			},
		};
		const verifiedResponse = await request(`${path}/integrations/${prep.id}/verify`, {
			commands: ["node -e \"console.log(require('fs').readFileSync('file.txt','utf8'))\""],
		});
		expect(verifiedResponse.status).toBe(200);
		const verified = verifiedResponse.body.integration;
		expect(verified.verification.results[0].outputPreview).toContain("artifact");
		expect(verified.verification.digest).toMatch(/^[a-f0-9]{64}$/);
		expect(verified.verification.untrustedExtra).toBeUndefined();
		expect(verified.verification.verifiedAt).toBeGreaterThan(0);
		await expect(verify(verified)).rejects.toThrow(/immutable/);
		await review(verified);
		const applied = await request(`${path}/integrations/${prep.id}/apply`, { expectedTargetSha: base });
		expect(applied.status).toBe(200);
		expect(applied.body.integration.status).toBe("applied");
		expect(await git(repo, ["show", "main:file.txt"])).toContain("artifact");
		await review(verified); // Exact idempotent review replay still works after apply.
		const persisted = await readPersistedHub(dataDir);
		expect(persisted.integrations[0].verification!.digest).toBe(verified.verification.digest);
		expect(persisted.tasks.find((t) => t.id === "code-task")!.artifact!.digest).toBe(
			delivery.artifactRef!.artifactDigest,
		);
	}, 30000);
	it("reads evidence by delivery artifact subject instead of the latest running task and rejects conflicting selectors", async () => {
		const ok = await request(`${path}/evidence?evidenceKind=artifact&deliveryId=${delivery.id}`);
		expect(ok.status).toBe(200);
		expect(ok.body.taskId).toBe("code-task");
		expect(
			(await request(`${path}/evidence?evidenceKind=artifact&deliveryId=${delivery.id}&taskId=current-task`)).status,
		).toBe(409);
		expect(
			(await request(`${path}/evidence?evidenceKind=artifact&deliveryId=${delivery.id}&digest=${"f".repeat(64)}`))
				.status,
		).toBe(409);
		const details = await request("/api/rooms/room/tasks/code-task");
		expect(details.status).toBe(200);
		expect(details.body.deliveries[0].artifactRef).toEqual(delivery.artifactRef);
		expect(details.body.deliveries[0].commit).toBeUndefined();
		expect(details.body.deliveries[0].reportedCheckCount).toBe(0);
		expect(details.body.deliveries[0].passed).toBe(false);
	});
	it("rejects absent commits as a shared review subject", () => {
		expect(
			deliveryReviewMatches(delivery, {
				deliveryId: delivery.id,
				accountId,
				roomId: "room",
				conversationId: "conversation",
			} as any),
		).toBe(false);
	});
	it("requires current running writer without treating a completed artifact task as authority", async () => {
		await expect(
			hub.store.transact((s) =>
				addDelivery(s, "room", "conversation", actor, {
					sourceBotId: "author",
					parentTaskId: "code-task",
					artifactTaskId: "code-task",
					idempotencyKey: "old-task",
					summary: "invalid",
					checks: [],
				}),
			),
		).rejects.toThrow(/current|Current/);
		await hub.store.transact((s) => {
			s.tasks.find((t) => t.id === "current-task")!.status = "completed";
		});
		await expect(
			hub.store.transact((s) =>
				addDelivery(s, "room", "conversation", actor, {
					sourceBotId: "author",
					parentTaskId: "current-task",
					artifactTaskId: "code-task",
					idempotencyKey: "terminal",
					summary: "invalid",
					checks: [],
				}),
			),
		).rejects.toThrow(/running/);
	});
	it.each(["empty", "missing", "wrong-command", "wrong-exit", "wrong-tree", "wrong-plan", "wrong-commit"])(
		"rejects forged %s verification evidence",
		async (mode) => {
			const prep = await prepare();
			const fake = {
				callDeviceCommand: async (_id: string, _action: string, p: any) => {
					const raw: any = {
						status: "verified",
						planDigest: p.verificationPlan.digest,
						artifactDigest: p.artifactRef.artifactDigest,
						materializedCommit: p.materializedCommit,
						treeBefore: p.preparedTree,
						treeAfter: p.preparedTree,
						results: p.verificationPlan.commands.map((command: string) => ({
							command,
							status: "passed",
							exitCode: 0,
							outputDigest: digest(""),
							outputPreview: "",
						})),
					};
					if (mode === "empty") raw.results = [];
					if (mode === "missing") delete raw.results;
					if (mode === "wrong-command") raw.results[0].command = "other";
					if (mode === "wrong-exit") raw.results[0].exitCode = 1;
					if (mode === "wrong-tree") raw.treeAfter = "f".repeat(40);
					if (mode === "wrong-plan") raw.planDigest = "f".repeat(64);
					if (mode === "wrong-commit") raw.materializedCommit = "f".repeat(40);
					return raw;
				},
			};
			await expect(
				hubVerifyIntegration(
					hub.store,
					"room",
					"conversation",
					prep.id,
					{ accountId },
					{ commands: ['node -e "process.exit(0)"'] },
					fake,
				),
			).rejects.toThrow();
			expect(hub.store.snapshot().integrations[0].verification).toBeUndefined();
			await expect(
				hubConfirmIntegration(hub.store, "room", "conversation", prep.id, { accountId }, {}, driver),
			).rejects.toThrow(/successful real verification proof/);
		},
	);
	it("requires complete unique met criteria and an independent matching review", async () => {
		const verified = await verify(await prepare());
		for (const invalid of [
			[],
			[criteriaResults[0]],
			[criteriaResults[0], criteriaResults[0]],
			[criteriaResults[0], { ...criteriaResults[1], verdict: "not_met" }],
		])
			await expect(review(verified, { criteriaResults: invalid })).rejects.toThrow(/criterion|criteria|Criterion/);
		await expect(
			hub.store.transact((s) =>
				addReview(s, "room", "conversation", actor, {
					sourceBotId: "author",
					parentTaskId: "current-task",
					idempotencyKey: "self",
					deliveryId: delivery.id,
					artifactDigest: delivery.artifactRef!.artifactDigest,
					integrationId: verified.id,
					verificationDigest: verified.verification!.digest,
					verdict: "accepted",
					summary: "self",
					criteriaResults,
				}),
			),
		).rejects.toThrow(/Self review/);
		await expect(review(verified, { verificationDigest: "f".repeat(64) })).rejects.toThrow(
			/matching successful verification/,
		);
		await review(verified);
		const other = await verify(await prepare());
		await expect(
			hubConfirmIntegration(hub.store, "room", "conversation", other.id, { accountId }, {}, driver),
		).rejects.toThrow(/match verification/);
	});
	it("rejects a later contract revision from another conversation and preserves old evidence", async () => {
		const verified = await verify(await prepare());
		await hub.store.transact((s) => {
			const task = structuredClone(s.tasks.find((t) => t.id === "code-task")!);
			task.id = "new-version";
			task.conversationId = "other-conversation";
			const { digest: _digest, createdAt: _createdAt, ...input } = task.contract!;
			task.contract = createWorkContract({ ...input, revision: 2 });
			s.tasks.push(task);
		});
		await expect(review(verified)).rejects.toThrow(/no longer authoritative/);
		expect(hub.store.snapshot().integrations[0].verification!.digest).toBe(verified.verification!.digest);
		const historical = await request(
			`${path}/evidence?evidenceKind=acceptance&deliveryId=${delivery.id}&expectedDigest=${delivery.artifactRef!.contractDigest}`,
		);
		expect(historical.status).toBe(200);
		expect(historical.body.acceptance.contractRevision).toBe(1);
	});
	it("rechecks target membership and revision after verification RPC", async () => {
		const prep = await prepare();
		const original = driver;
		const race = {
			callDeviceCommand: async (id: string, action: string, payload: any) => {
				const response = await original.callDeviceCommand(id, action, payload);
				await hub.store.transact((s) => {
					s.bots.find((b) => b.id === "target")!.revision++;
				});
				return response;
			},
		};
		await expect(
			hubVerifyIntegration(
				hub.store,
				"room",
				"conversation",
				prep.id,
				{ accountId },
				{ commands: ['node -e "process.exit(0)"'] },
				race,
			),
		).rejects.toThrow(/membership, revision or device/);
		expect(hub.store.snapshot().integrations[0].verification).toBeUndefined();
	});
	it("freezes delivery, review and same contract before RPC and preserves applied fact after actor revoke", async () => {
		const verified = await verify(await prepare());
		await review(verified);
		const original = driver;
		const race = {
			callDeviceCommand: async (id: string, action: string, payload: any) => {
				await expect(
					hub.store.transact((s) =>
						addReview(
							s,
							"room",
							"conversation",
							{ accountId },
							{
								idempotencyKey: "replacement",
								deliveryId: delivery.id,
								artifactDigest: delivery.artifactRef!.artifactDigest,
								verdict: "changes_requested",
								summary: "changed",
							},
						),
					),
				).rejects.toThrow(/freezes/);
				await expect(
					hub.store.transact((s) =>
						addDelivery(s, "room", "conversation", actor, {
							sourceBotId: "author",
							parentTaskId: "current-task",
							artifactTaskId: "code-task",
							idempotencyKey: "replacement-delivery",
							summary: "changed",
							checks: [],
						}),
					),
				).rejects.toThrow(/freezes/);
				const {
					digest: _digest,
					createdAt: _createdAt,
					...contractInput
				} = hub.store.snapshot().tasks.find((t) => t.id === "code-task")!.contract!;
				const frozenContract = await request("/api/rooms/room/messages", {
					text: "same contract",
					targetBotIds: ["author"],
					executionMode: "code",
					contract: contractInput,
				});
				expect(frozenContract.status).toBe(409);
				expect(frozenContract.body.error).toMatch(/freezes/);
				const response = await original.callDeviceCommand(id, action, payload);
				await hub.store.transact((s) => {
					s.bots.find((b) => b.id === "author")!.revision++;
				});
				return response;
			},
		};
		const applied = await hubConfirmIntegration(hub.store, "room", "conversation", verified.id, actor, {}, race);
		expect(applied.status).toBe("applied");
		expect(applied.publishReceipt).toMatchObject({
			outcome: "applied",
			proof: "cas_exit",
			candidateSha: applied.publishIntent!.candidateSha,
		});
		expect(await git(repo, ["rev-parse", "main"])).toBe(applied.publishIntent!.candidateSha);
		expect(hub.store.snapshot().bots.find((b) => b.id === "author")!.revision).toBe(actor.bot.revision + 1);
	});
	it("freezes owner plan across failures and lets a current Bot reuse only the unchanged authorization", async () => {
		const prep = await prepare();
		const commands = ["node -e \"console.log('authorized')\""];
		await expect(
			hubVerifyIntegration(
				hub.store,
				"room",
				"conversation",
				prep.id,
				{ accountId },
				{ commands },
				{ callDeviceCommand: async () => ({ status: "verified" }) },
			),
		).rejects.toThrow();
		const plan = hub.store.snapshot().integrations[0].verificationPlan;
		await expect(
			hubVerifyIntegration(hub.store, "room", "conversation", prep.id, actor, { commands: ["other"] }, driver),
		).rejects.toThrow(/cannot change/);
		await expect(
			hubVerifyIntegration(hub.store, "room", "conversation", prep.id, { accountId }, { commands: ["other"] }, driver),
		).rejects.toThrow(/frozen/);
		const reused = await request(`${path}/integrations/${prep.id}/verify`, { sourceBotId: "author", commands }, true);
		expect(reused.status).toBe(200);
		expect(reused.body.integration.verificationPlan).toEqual(plan);
		expect(reused.body.integration.status).toBe("verified");
	});
	it("preserves same-version contract authority on conflicting HTTP submissions and through automatic task retention", async () => {
		const verified = await verify(await prepare());
		await review(verified);
		const {
			digest: _digest,
			createdAt: _createdAt,
			...contractInput
		} = hub.store.snapshot().tasks.find((t) => t.id === "code-task")!.contract!;
		const conflicting = await request("/api/rooms/room/messages", {
			text: "conflicting",
			targetBotIds: ["author"],
			executionMode: "code",
			contract: { ...contractInput, goal: "different same version" },
		});
		expect(conflicting.status).toBe(409);
		expect(conflicting.body.error).toMatch(/different content/);
		await hub.store.transact((s) => {
			const current = s.tasks.find((t) => t.id === "current-task")!;
			for (let i = 0; i < 550; i++)
				s.tasks.push({ ...current, id: `filler-${i}`, attemptId: `filler-attempt-${i}`, status: "completed" });
		});
		const restored = await readPersistedHub(dataDir);
		expect(restored.tasks.find((t) => t.id === "code-task")!.contract!.digest).toBe(
			delivery.artifactRef!.contractDigest,
		);
		expect(restored.integrations[0].verification!.digest).toBe(verified.verification!.digest);
		expect(restored.reviews[0].verificationDigest).toBe(verified.verification!.digest);
	});
	it.each(["baseline", "tree"])("rejects an artifact prepare response with a different %s", async (mismatch) => {
		const fake = {
			callDeviceCommand: async () => ({
				status: "prepared",
				objectFormat: "sha1",
				repositoryId: delivery.artifactRef!.repositoryId,
				expectedTargetSha: mismatch === "baseline" ? "f".repeat(40) : base,
				materializedCommit: base,
				preparedTree: mismatch === "tree" ? "f".repeat(40) : outputTree,
			}),
		};
		await expect(
			hubPrepareIntegration(
				hub.store,
				"room",
				"conversation",
				{ accountId },
				{ deliveryId: delivery.id, targetBotId: "target" },
				fake,
			),
		).rejects.toThrow(/baseline|tree mismatch/);
	});
	it.each(["failed", "verified", "verifying"] as const)(
		"preserves legacy %s without positive stop or receipt across cancellation retries",
		async (status) => {
			const prep = await prepare();
			await hub.store.transact((s) => {
				const old = s.integrations.find((i) => i.id === prep.id)!;
				old.status = status;
				delete old.targetDeviceId;
			});
			// A v46 local session has no durable positive-stop marker. Modern prepares explicitly do.
			const sessionsPath = join(dataDir, "integration-sessions.json");
			const sessions = JSON.parse(await readFile(sessionsPath, "utf8"));
			delete sessions.find((session: any) => session.integrationId === prep.id).verificationStopConfirmed;
			await writeFile(sessionsPath, JSON.stringify(sessions), "utf8");
			const noStop = driver;
			await expect(
				hubCancelIntegration(hub.store, "room", "conversation", prep.id, { accountId }, noStop),
			).rejects.toThrow(/stop unconfirmed/);
			const current = hub.store.snapshot().integrations[0];
			expect(current.status).toBe("failed");
			expect(current.cleanupPending).toBe(true);
			expect(current.verificationMayBeRunning).toBe(true);
			await expect(
				hubCancelIntegration(hub.store, "room", "conversation", prep.id, { accountId }, noStop),
			).rejects.toThrow(/stop unconfirmed/);
		},
	);
	it("freezes ordinary HTTP room, conversation and Bot authority mutations even when all tasks are terminal", async () => {
		const verified = await verify(await prepare());
		await review(verified);
		await hub.store.transact((s) => {
			s.tasks.find((t) => t.id === "current-task")!.status = "completed";
		});
		const original = driver;
		const guarded = {
			callDeviceCommand: async (id: string, action: string, payload: any) => {
				for (const [url, body] of [
					["/api/rooms/room/members", { botIds: ["author", "reviewer"] }],
					["/api/rooms/room/clear", {}],
					["/api/rooms/room/delete", {}],
					[`${path}/stop`, {}],
					[`${path}/delete`, {}],
				] as const) {
					const rejected = await request(url, body);
					expect(rejected.status).toBe(409);
					expect(rejected.body.error).toMatch(/freezes/);
				}
				const bots = hub.store.snapshot().bots.map((b) => ({
					id: b.id,
					name: b.name,
					description: "",
					enabled: b.enabled,
					revision: b.revision + (b.id === "target" ? 1 : 0),
				}));
				const registration = await request("/api/bots", { bots }, true, "PUT");
				expect(registration.status).toBe(409);
				expect(registration.body.error).toMatch(/freezes/);
				return original.callDeviceCommand(id, action, payload);
			},
		};
		const applied = await hubConfirmIntegration(
			hub.store,
			"room",
			"conversation",
			verified.id,
			{ accountId },
			{},
			guarded,
		);
		expect(applied.status).toBe("applied");
		expect(hub.store.snapshot().conversations[0].closed).not.toBe(true);
	});
	it("retains emergency device revocation while settling the original successful publication", async () => {
		const verified = await verify(await prepare());
		await review(verified);
		const original = driver;
		const revoked = {
			callDeviceCommand: async (id: string, action: string, payload: any) => {
				const response = await request("/api/devices/device/revoke", {});
				expect(response.status).toBe(200);
				return original.callDeviceCommand(id, action, payload);
			},
		};
		const result = await hubConfirmIntegration(
			hub.store,
			"room",
			"conversation",
			verified.id,
			{ accountId },
			{},
			revoked,
		);
		expect(result.status).toBe("applied");
		expect(result.publishReceipt).toMatchObject({
			outcome: "applied",
			proof: "cas_exit",
			candidateSha: result.publishIntent!.candidateSha,
		});
		expect(await git(repo, ["rev-parse", "main"])).toBe(result.publishIntent!.candidateSha);
		expect(hub.store.snapshot().devices.some((d) => d.id === "device")).toBe(false);
		expect(result.verification!.digest).toBe(verified.verification!.digest);
	});
	it("allows sealed criteria beyond the author-input budget while preserving the summary and checks limit", async () => {
		await hub.store.transact((s) => {
			const source = structuredClone(s.tasks.find((t) => t.id === "code-task")!);
			const { digest: _d, createdAt: _at, ...input } = source.contract!;
			source.id = "large-code-task";
			source.attemptId = "large-attempt";
			source.contract = createWorkContract({
				...input,
				revision: 2,
				acceptanceCriteria: Array.from({ length: 13 }, (_, i) => `${i}:`.padEnd(2000, "x")),
			});
			source.contextManifest = createContextManifest({
				contract: source.contract,
				context: {},
				executionPolicy: { deviceId: "device", botId: "author", botRevision: 1 },
			});
			source.artifact!.producer = {
				...source.artifact!.producer,
				taskId: source.id,
				attemptId: source.attemptId,
				contractDigest: source.contract.digest,
				manifestDigest: source.contextManifest.digest,
			};
			source.artifact!.digest = computeArtifactDigest(source.artifact!);
			s.tasks.push(source);
		});
		const input = {
			sourceBotId: "author",
			parentTaskId: "current-task",
			artifactTaskId: "large-code-task",
			idempotencyKey: "large-criteria",
			summary: "ready",
			checks: [],
		};
		const result = await hub.store.transact((s) => addDelivery(s, "room", "conversation", actor, input));
		expect(result.acceptanceCriteria).toHaveLength(13);
		const bytes: Buffer[] = [];
		let offset: number | null = 0;
		while (offset !== null) {
			const page = await request(
				`${path}/evidence?evidenceKind=acceptance&deliveryId=${result.id}&expectedDigest=${result.artifactRef!.contractDigest}&sourceBotId=author&offset=${offset}&limit=8191`,
				undefined,
				true,
			);
			expect(page.status).toBe(200);
			expect(page.body.taskId).toBe("large-code-task");
			expect(page.body.deliveryId).toBe(result.id);
			expect(page.body.acceptance.criteriaCount).toBe(13);
			expect(page.body.acceptance.contractDigest).toBe(result.artifactRef!.contractDigest);
			bytes.push(Buffer.from(page.body.content.data, "base64"));
			offset = page.body.content.nextOffset;
			expect(page.body.acceptance.criteriaDigest).toBe(digest(canonicalizeJson(result.acceptanceCriteria!)));
		}
		expect(Buffer.concat(bytes).toString("utf8")).toBe(canonicalizeJson(result.acceptanceCriteria!));
		await expect(
			hub.store.transact((s) =>
				addDelivery(s, "room", "conversation", actor, {
					...input,
					idempotencyKey: "oversized-author",
					checks: Array.from({ length: 8 }, () => ({ command: "test", status: "passed", result: "x".repeat(4096) })),
				}),
			),
		).rejects.toThrow(/Delivery budget exceeded/);
	});
	it.each(["disabled", "membership", "revision"] as const)(
		"lets only the authenticated owner clean up a %s target using its original device identity",
		async (change) => {
			const prep = await prepare();
			await hub.store.transact((s) => {
				const target = s.bots.find((b) => b.id === "target")!;
				if (change === "disabled") target.enabled = false;
				if (change === "revision") target.revision++;
				if (change === "membership") s.rooms[0].botIds = s.rooms[0].botIds.filter((id) => id !== "target");
			});
			const botAttempt = await request(
				`${path}/integrations/${prep.id}/cancel`,
				{ sourceBotId: "author", ownerCleanup: true },
				true,
			);
			expect(botAttempt.status).toBe(409);
			const original = driver;
			let called = false;
			driver = {
				callDeviceCommand: async (id, action, payload) => {
					called = true;
					expect(id).toBe("device");
					expect(action).toBe("integration_cancel");
					expect(payload.ownerCleanup).toBe(true);
					expect(payload.targetBotRevision).toBe(1);
					return original.callDeviceCommand(id, action, payload);
				},
			};
			const cancelled = await request(`${path}/integrations/${prep.id}/cancel`, {});
			expect(cancelled.status).toBe(200);
			expect(cancelled.body.integration.status).toBe("cancelled");
			expect(called).toBe(true);
			expect(cancelled.body.integration.verification).toBeUndefined();
		},
	);
	it("rejects a different account attempting owner cleanup before issuing any device command", async () => {
		const prep = await prepare();
		const savedCookie = cookie;
		const registered = await request("/api/auth/register", {
			username: "other-owner",
			password: "other-test-password",
		});
		expect(registered.status).toBe(201);
		cookie = registered.cookie;
		let calls = 0;
		const original = driver;
		driver = {
			callDeviceCommand: async (...args) => {
				calls++;
				return original.callDeviceCommand(...args);
			},
		};
		const denied = await request(`${path}/integrations/${prep.id}/cancel`, { ownerCleanup: true });
		expect(denied.status).toBe(404);
		expect(calls).toBe(0);
		cookie = savedCookie;
	});
	it("paginates exact UTF8 sealed acceptance bytes and rejects conflicting subjects and digest selectors", async () => {
		const chunks: Buffer[] = [];
		let offset: number | null = 0;
		while (offset !== null) {
			const page = await request(
				`${path}/evidence?evidenceKind=acceptance&deliveryId=${delivery.id}&expectedDigest=${delivery.artifactRef!.contractDigest}&offset=${offset}&limit=7`,
			);
			expect(page.status).toBe(200);
			chunks.push(Buffer.from(page.body.content.data, "base64"));
			offset = page.body.content.nextOffset;
			expect(page.body.acceptance).toEqual({
				contractId: delivery.artifactRef!.contractId,
				contractRevision: delivery.artifactRef!.contractRevision,
				contractDigest: delivery.artifactRef!.contractDigest,
				criteriaDigest: digest(canonicalizeJson(delivery.acceptanceCriteria!)),
				criteriaCount: 2,
			});
		}
		expect(JSON.parse(Buffer.concat(chunks).toString("utf8"))).toEqual(delivery.acceptanceCriteria);
		for (const [query, status] of [
			["deliveryId=unknown", 404],
			[`deliveryId=${delivery.id}&taskId=current-task`, 409],
			[`deliveryId=${delivery.id}&expectedDigest=${"f".repeat(64)}`, 409],
			[
				`deliveryId=${delivery.id}&expectedDigest=${delivery.artifactRef!.contractDigest}&digest=${"f".repeat(64)}`,
				409,
			],
			[`deliveryId=${delivery.id}&limit=24577`, 400],
			[`deliveryId=${delivery.id}&digest=x&digest=y`, 400],
			["deliveryId=", 400],
			[`deliveryId=${delivery.id}&expectedDigest=`, 409],
		] as const)
			expect((await request(`${path}/evidence?evidenceKind=acceptance&${query}`)).status).toBe(status);
	});
});
