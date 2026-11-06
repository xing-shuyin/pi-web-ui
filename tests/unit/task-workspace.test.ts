import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { ContextManifest, DeviceArtifact, DeviceWorkContract } from "../../server/protocol.js";
import {
	captureTaskArtifact,
	cleanupTaskWorkspace,
	clearTaskWorkspaceRegistry,
	getRegisteredWorkspaceCount,
	getTaskWorkspaceCapability,
	isTrustedTaskWorkspaceCapability,
	resolveTrustedTaskWorkspace,
	prepareTaskWorkspace,
	resolveTaskWorkspace,
	type TaskWorkspaceBinding,
} from "../../server/device-center/task-workspace.js";
import { computeCanonicalRepositoryId, git } from "../../server/workspace-handle.js";
import {
	computeArtifactDigest,
	computeContractDigest,
	computeManifestDigest,
	contractInputReferences,
	validateDeviceArtifact,
} from "../../server/device-center/work-contract.js";

const exec = promisify(execFile);
const tempDirs: string[] = [];

async function gitExec(cwd: string, ...args: string[]): Promise<string> {
	return (await exec("git", args, { cwd, windowsHide: true })).stdout.trim();
}

async function fixture(): Promise<{
	repo: string;
	baseCommit: string;
	dataDir: string;
	canonicalRepoId: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "task-ws-test-"));
	tempDirs.push(root);
	const repo = join(root, "repo");
	const dataDir = join(root, "data");
	await mkdir(join(repo, "src"), { recursive: true });
	await mkdir(dataDir, { recursive: true });

	await gitExec(repo, "init", "-b", "main");
	await gitExec(repo, "config", "user.name", "Task Test");
	await gitExec(repo, "config", "user.email", "task@example.invalid");
	await gitExec(repo, "config", "core.autocrlf", "false");
	await writeFile(join(repo, "src", "app.ts"), 'console.log("baseline");\n');
	await writeFile(join(repo, ".gitignore"), ".env\n");
	await gitExec(repo, "add", ".");
	await gitExec(repo, "commit", "-m", "baseline");
	const baseCommit = await gitExec(repo, "rev-parse", "HEAD");
	const canonicalRepoId = await computeCanonicalRepositoryId(repo);

	return { repo, baseCommit, dataDir, canonicalRepoId };
}

function buildContract(repoId: string, commit: string, overrides?: Partial<DeviceWorkContract>): DeviceWorkContract {
	const c: DeviceWorkContract = {
		id: `contract-${randomUUID()}`,
		revision: 1,
		digest: "",
		executionMode: "code",
		goal: "Execute test task",
		baseline: {
			repositoryId: repoId,
			commit,
		},
		inputArtifacts: [],
		createdAt: Date.now(),
		...overrides,
	};
	c.digest = computeContractDigest(c);
	return c;
}

function buildManifest(contract: DeviceWorkContract): ContextManifest {
	const m: ContextManifest = {
		version: 1,
		digest: "",
		contractId: contract.id,
		contractRevision: contract.revision,
		contractDigest: contract.digest,
		context: { info: "test" },
		inputs: contractInputReferences(contract),
		createdAt: Date.now(),
	};
	m.digest = computeManifestDigest(m);
	return m;
}

afterEach(async () => {
	clearTaskWorkspaceRegistry();
	await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
});

describe("task-workspace isolation and capabilities", { timeout: 30_000 }, () => {
	it("prepares concurrent workspaces without collision and verifies opaque handle resolution", async () => {
		const { repo, baseCommit, dataDir, canonicalRepoId } = await fixture();
		const contract1 = buildContract(canonicalRepoId, baseCommit);
		const manifest1 = buildManifest(contract1);

		const contract2 = buildContract(canonicalRepoId, baseCommit);
		const manifest2 = buildManifest(contract2);

		const [handle1, handle2] = await Promise.all([
			prepareTaskWorkspace({
				dataDir,
				deviceId: "dev-1",
				botId: "bot-1",
				botRevision: 1,
				taskId: "task-1",
				attemptId: "att-1",
				repoRoot: repo,
				contract: contract1,
				contextManifest: manifest1,
			}),
			prepareTaskWorkspace({
				dataDir,
				deviceId: "dev-1",
				botId: "bot-1",
				botRevision: 1,
				taskId: "task-2",
				attemptId: "att-1",
				repoRoot: repo,
				contract: contract2,
				contextManifest: manifest2,
			}),
		]);

		expect(getRegisteredWorkspaceCount()).toBe(2);
		expect(handle1.handleId).not.toBe(handle2.handleId);

		const binding1: TaskWorkspaceBinding = {
			deviceId: "dev-1",
			botId: "bot-1",
			botRevision: 1,
			taskId: "task-1",
			attemptId: "att-1",
		};

		const res1 = await resolveTaskWorkspace(handle1, binding1);
		expect(res1.baseCommit).toBe(baseCommit);
		expect(res1.contractDigest).toBe(contract1.digest);
		expect(res1.manifestDigest).toBe(manifest1.digest);

		const cap1 = getTaskWorkspaceCapability(handle1, binding1);
		expect(await cap1.getCwd()).toBe(res1.cwd);
		expect(await cap1.getRepoRoot()).toBe(res1.repoRoot);
		expect(isTrustedTaskWorkspaceCapability(cap1)).toBe(true);
		expect(Object.isFrozen(cap1)).toBe(true);
		expect(Object.isFrozen(cap1.binding)).toBe(true);
		expect(await resolveTrustedTaskWorkspace(cap1, binding1)).toEqual(res1);
		let forgedCalls = 0;
		const forged = {
			...cap1,
			resolve: async () => {
				forgedCalls++;
				return res1;
			},
		};
		expect(isTrustedTaskWorkspaceCapability(forged)).toBe(false);
		await expect(resolveTrustedTaskWorkspace(forged, binding1)).rejects.toThrow("Untrusted");
		expect(forgedCalls).toBe(0);
		await expect(resolveTrustedTaskWorkspace(cap1, { ...binding1, botRevision: 2 })).rejects.toThrow(
			"binding mismatch",
		);

		await expect(resolveTaskWorkspace("fake-uuid-not-in-registry", binding1)).rejects.toThrow(
			"Unregistered or expired",
		);

		await expect(resolveTaskWorkspace(handle1, { ...binding1, taskId: "wrong-task" })).rejects.toThrow(
			"Task workspace binding mismatch",
		);

		await cleanupTaskWorkspace(handle1, binding1);
		expect(isTrustedTaskWorkspaceCapability(cap1)).toBe(false);
		await expect(resolveTrustedTaskWorkspace(cap1, binding1)).rejects.toThrow("expired");
		await cleanupTaskWorkspace(handle2, { ...binding1, taskId: "task-2" });
		expect(getRegisteredWorkspaceCount()).toBe(0);
	});

	it("strictly validates repository baseline and rejects dirty/tampered baseline", async () => {
		const { repo, baseCommit, dataDir, canonicalRepoId } = await fixture();

		await writeFile(join(repo, "src", "dirty.txt"), "dirty uncommitted\n");
		const contract = buildContract(canonicalRepoId, baseCommit);
		const manifest = buildManifest(contract);

		await expect(
			prepareTaskWorkspace({
				dataDir,
				deviceId: "dev-1",
				botId: "bot-1",
				botRevision: 1,
				taskId: "task-1",
				attemptId: "att-1",
				repoRoot: repo,
				contract,
				contextManifest: manifest,
			}),
		).rejects.toThrow("requires a clean baseline repository");

		await rm(join(repo, "src", "dirty.txt"));

		const fakeCommit = "a".repeat(40);
		const badCommitContract = buildContract(canonicalRepoId, fakeCommit);
		const badCommitManifest = buildManifest(badCommitContract);
		await expect(
			prepareTaskWorkspace({
				dataDir,
				deviceId: "dev-1",
				botId: "bot-1",
				botRevision: 1,
				taskId: "task-1",
				attemptId: "att-1",
				repoRoot: repo,
				contract: badCommitContract,
				contextManifest: badCommitManifest,
			}),
		).rejects.toThrow("does not exist in repository");

		const badRepoContract = buildContract("fake-repo-id", baseCommit);
		const badRepoManifest = buildManifest(badRepoContract);
		await expect(
			prepareTaskWorkspace({
				dataDir,
				deviceId: "dev-1",
				botId: "bot-1",
				botRevision: 1,
				taskId: "task-1",
				attemptId: "att-1",
				repoRoot: repo,
				contract: badRepoContract,
				contextManifest: badRepoManifest,
			}),
		).rejects.toThrow("Repository identity mismatch");
	});

	it("explicitly rejects a Bot.cwd below the Git root before creating a broader workspace", async () => {
		const { repo, baseCommit, dataDir, canonicalRepoId } = await fixture();
		const contract = buildContract(canonicalRepoId, baseCommit);
		await expect(
			prepareTaskWorkspace({
				dataDir,
				repoRoot: join(repo, "src"),
				deviceId: "dev",
				botId: "bot",
				botRevision: 1,
				taskId: "subdir",
				attemptId: "one",
				contract,
				contextManifest: buildManifest(contract),
			}),
		).rejects.toThrow("subdirectory code workspaces are not supported");
		expect(getRegisteredWorkspaceCount()).toBe(0);
		expect(await gitExec(repo, "worktree", "list", "--porcelain")).not.toContain("task-workspaces");
	});

	it("captures cumulative artifact with GC retention, enforces 128 KiB patch bound, and caches result", async () => {
		const { repo, baseCommit, dataDir, canonicalRepoId } = await fixture();
		const contract = buildContract(canonicalRepoId, baseCommit);
		const manifest = buildManifest(contract);
		const binding: TaskWorkspaceBinding = {
			deviceId: "dev-1",
			botId: "bot-1",
			botRevision: 1,
			taskId: "task-capture",
			attemptId: "att-1",
		};

		const handle = await prepareTaskWorkspace({
			dataDir,
			...binding,
			repoRoot: repo,
			contract,
			contextManifest: manifest,
		});

		const ws = await resolveTaskWorkspace(handle, binding);

		await writeFile(join(ws.cwd, "src", "feature.ts"), "export const answer = 42;\n");
		await writeFile(join(ws.cwd, "src", "app.ts"), 'console.log("updated");\n');

		const artifact1 = await captureTaskArtifact(handle, binding);
		expect(artifact1.producer.taskId).toBe("task-capture");
		expect(artifact1.producer.attemptId).toBe("att-1");
		expect(artifact1.producer.contractDigest).toBe(contract.digest);
		expect(artifact1.producer.manifestDigest).toBe(manifest.digest);
		expect(artifact1.baseline?.commit).toBe(baseCommit);
		expect(artifact1.patchBase64).toBeDefined();
		expect(artifact1.patchSha256).toBeDefined();

		expect(JSON.stringify(artifact1)).not.toContain(ws.cwd);
		expect(JSON.stringify(artifact1)).not.toContain(repo);

		const ref = (await gitExec(repo, "for-each-ref", "--format=%(refname)", "refs/pi-tasks/artifacts/"))
			.split("\n")
			.find((value) => value.endsWith(`/${handle.handleId}`))!;
		const refCommit = await gitExec(repo, "rev-parse", ref);
		expect(refCommit).toMatch(/^[0-9a-fA-F]{40}$/);

		const originalJson = JSON.stringify(artifact1);
		expect(Object.isFrozen(artifact1)).toBe(true);
		expect(Object.isFrozen(artifact1.producer)).toBe(true);
		expect(Object.isFrozen(artifact1.baseline)).toBe(true);
		expect(Reflect.set(artifact1.producer, "botId", "forged")).toBe(false);
		expect(Reflect.set(artifact1.baseline!, "commit", "0".repeat(40))).toBe(false);
		expect(Reflect.set(artifact1, "patchBase64", "forged")).toBe(false);
		expect(validateDeviceArtifact(artifact1).valid).toBe(true);
		expect(computeArtifactDigest(artifact1)).toBe(artifact1.digest);

		const artifact2 = await captureTaskArtifact(handle, binding);
		expect(artifact2).toBe(artifact1);
		expect(artifact2.id).toBe(artifact1.id);
		expect(artifact2.digest).toBe(artifact1.digest);
		expect(JSON.stringify(artifact2)).toBe(originalJson);

		await expect(cleanupTaskWorkspace(handle, binding)).rejects.toThrow("retained for inspection");

		await cleanupTaskWorkspace(handle, binding, { force: true });
	});

	it("rejects a real Git patch above 128 KiB without caching it or publishing a ref", async () => {
		const { repo, baseCommit, dataDir, canonicalRepoId } = await fixture();
		const contract = buildContract(canonicalRepoId, baseCommit);
		const binding: TaskWorkspaceBinding = {
			deviceId: "dev",
			botId: "bot",
			botRevision: 1,
			taskId: "oversized",
			attemptId: "one",
		};
		const handle = await prepareTaskWorkspace({
			...binding,
			dataDir,
			repoRoot: repo,
			contract,
			contextManifest: buildManifest(contract),
		});
		const ws = await resolveTaskWorkspace(handle, binding);
		const large = join(ws.cwd, "large.txt");
		await writeFile(large, "x".repeat(128 * 1024));
		await expect(captureTaskArtifact(handle, binding)).rejects.toThrow("exceeds maximum limit");
		expect(await gitExec(repo, "for-each-ref", "--format=%(refname)", "refs/pi-tasks/artifacts/")).toBe("");
		await rm(large);
		const noop = await captureTaskArtifact(handle, binding);
		expect(noop.patchBase64).toBe("");
		await cleanupTaskWorkspace(handle, binding);
	});

	it("safely verifies and composes inputArtifacts, proving outputTree before applying", async () => {
		const { repo, baseCommit, dataDir, canonicalRepoId } = await fixture();

		const upContract = buildContract(canonicalRepoId, baseCommit);
		const upManifest = buildManifest(upContract);
		const upBinding: TaskWorkspaceBinding = {
			deviceId: "dev-upstream",
			botId: "bot-up",
			botRevision: 1,
			taskId: "task-up",
			attemptId: "att-1",
		};

		const upHandle = await prepareTaskWorkspace({
			dataDir,
			...upBinding,
			repoRoot: repo,
			contract: upContract,
			contextManifest: upManifest,
		});
		const upWs = await resolveTaskWorkspace(upHandle, upBinding);
		await writeFile(join(upWs.cwd, "src", "lib.ts"), 'export const lib = "ok";\n');
		const upArtifact = await captureTaskArtifact(upHandle, upBinding);
		await cleanupTaskWorkspace(upHandle, upBinding, { force: true });

		const downContract = buildContract(canonicalRepoId, baseCommit, {
			inputArtifacts: [upArtifact],
		});
		const downManifest = buildManifest(downContract);
		const downBinding: TaskWorkspaceBinding = {
			deviceId: "dev-down",
			botId: "bot-down",
			botRevision: 1,
			taskId: "task-down",
			attemptId: "att-1",
		};

		const downHandle = await prepareTaskWorkspace({
			dataDir,
			...downBinding,
			repoRoot: repo,
			contract: downContract,
			contextManifest: downManifest,
		});

		const downWs = await resolveTaskWorkspace(downHandle, downBinding);
		const libContent = await readFile(join(downWs.cwd, "src", "lib.ts"), "utf8");
		expect(libContent).toBe('export const lib = "ok";\n');

		await writeFile(join(downWs.cwd, "src", "chain.ts"), "export const chain = 1;\n");
		const downArtifact = await captureTaskArtifact(downHandle, downBinding);
		const prepareWith = (taskId: string, inputArtifacts: DeviceArtifact[]) => {
			const contract = buildContract(canonicalRepoId, baseCommit, { inputArtifacts });
			const binding = { ...downBinding, taskId };
			return {
				binding,
				options: { ...binding, repoRoot: repo, dataDir, contract, contextManifest: buildManifest(contract) },
			};
		};
		const chain = prepareWith("chain", [downArtifact]);
		const chainHandle = await prepareTaskWorkspace(chain.options);
		const chainWs = await resolveTaskWorkspace(chainHandle, chain.binding);
		expect(await readFile(join(chainWs.cwd, "src", "lib.ts"), "utf8")).toBe('export const lib = "ok";\n');
		expect(await readFile(join(chainWs.cwd, "src", "chain.ts"), "utf8")).toContain("chain = 1");
		await cleanupTaskWorkspace(chainHandle, chain.binding, { force: true });

		const overlap = prepareWith("overlap", [upArtifact, downArtifact]);
		await expect(prepareTaskWorkspace(overlap.options)).rejects.toThrow("Input artifact conflict");

		const emptyTree = await gitExec(repo, "rev-parse", `${baseCommit}^{tree}`);
		const noop: DeviceArtifact = {
			...upArtifact,
			id: "noop",
			patchBase64: "",
			patchSha256: createHash("sha256").update("").digest("hex"),
			inputTree: emptyTree,
			outputTree: emptyTree,
			digest: "",
		};
		noop.digest = computeArtifactDigest(noop);
		const empty = prepareWith("empty", [noop]);
		const emptyHandle = await prepareTaskWorkspace(empty.options);
		expect((await resolveTaskWorkspace(emptyHandle, empty.binding)).inputTree).toBe(emptyTree);
		await cleanupTaskWorkspace(emptyHandle, empty.binding);

		for (const field of ["baseline", "outputTree"] as const) {
			const unproved = { ...upArtifact, id: `missing-${field}`, [field]: undefined, digest: "" };
			unproved.digest = computeArtifactDigest(unproved);
			const invalid = prepareWith(`missing-${field}`, [unproved]);
			await expect(prepareTaskWorkspace(invalid.options)).rejects.toThrow(/baseline|outputTree/);
		}

		const independent = prepareWith("independent", []);
		const independentHandle = await prepareTaskWorkspace(independent.options);
		const independentWs = await resolveTaskWorkspace(independentHandle, independent.binding);
		await writeFile(join(independentWs.cwd, "src", "independent.ts"), "independent\n");
		const independentArtifact = await captureTaskArtifact(independentHandle, independent.binding);
		await cleanupTaskWorkspace(independentHandle, independent.binding, { force: true });
		const combined = prepareWith("combined", [upArtifact, independentArtifact]);
		const combinedHandle = await prepareTaskWorkspace(combined.options);
		const combinedWs = await resolveTaskWorkspace(combinedHandle, combined.binding);
		expect(await readFile(join(combinedWs.cwd, "src", "independent.ts"), "utf8")).toBe("independent\n");
		expect(await readFile(join(combinedWs.cwd, "src", "lib.ts"), "utf8")).toContain("lib");
		await writeFile(join(combinedWs.cwd, "src", "output.ts"), "output\n");
		const combinedArtifact = await captureTaskArtifact(combinedHandle, combined.binding);
		await cleanupTaskWorkspace(combinedHandle, combined.binding, { force: true });
		await git(repo, ["gc", "--prune=now"]);
		await expect(git(repo, ["cat-file", "-e", combinedArtifact.inputTree!])).resolves.toBe("");
		await expect(git(repo, ["cat-file", "-e", combinedArtifact.outputTree!])).resolves.toBe("");

		const counterfeitArtifact: DeviceArtifact = {
			...upArtifact,
			id: `artifact-fake-${randomUUID()}`,
			outputTree: "1".repeat(40),
		};
		counterfeitArtifact.digest = computeArtifactDigest(counterfeitArtifact);

		const fakeContract = buildContract(canonicalRepoId, baseCommit, {
			inputArtifacts: [counterfeitArtifact],
		});
		const fakeManifest = buildManifest(fakeContract);

		await expect(
			prepareTaskWorkspace({
				dataDir,
				deviceId: "dev-fake",
				botId: "bot-fake",
				botRevision: 1,
				taskId: "task-fake",
				attemptId: "att-1",
				repoRoot: repo,
				contract: fakeContract,
				contextManifest: fakeManifest,
			}),
		).rejects.toThrow("Artifact patch does not produce declared outputTree");

		expect(getRegisteredWorkspaceCount()).toBe(1);

		await cleanupTaskWorkspace(downHandle, downBinding, { force: true });
	}, 90_000);

	it("aborts workspace preparation cleanly when signal is triggered and leaves no residues", async () => {
		const { repo, baseCommit, dataDir, canonicalRepoId } = await fixture();
		const contract = buildContract(canonicalRepoId, baseCommit);
		const manifest = buildManifest(contract);

		const controller = new AbortController();
		controller.abort();

		await expect(
			prepareTaskWorkspace({
				dataDir,
				deviceId: "dev-abort",
				botId: "bot-abort",
				botRevision: 1,
				taskId: "task-abort",
				attemptId: "att-1",
				repoRoot: repo,
				contract,
				contextManifest: manifest,
				signal: controller.signal,
			}),
		).rejects.toThrow();

		expect(getRegisteredWorkspaceCount()).toBe(0);
	});

	it("copies contract and context before awaiting, and freezes the capability binding", async () => {
		const { repo, baseCommit, dataDir, canonicalRepoId } = await fixture();
		const contract = buildContract(canonicalRepoId, baseCommit);
		const manifest = buildManifest(contract);
		const binding: TaskWorkspaceBinding = {
			deviceId: "dev",
			botId: "bot",
			botRevision: 1,
			taskId: "copy",
			attemptId: "one",
		};
		const expectedContract = contract.digest;
		const expectedManifest = manifest.digest;
		const options = { ...binding, dataDir, repoRoot: repo, contract, contextManifest: manifest };
		const preparing = prepareTaskWorkspace(options);
		contract.digest = "f".repeat(64);
		contract.baseline!.repositoryId = "modified";
		(manifest.context as Record<string, unknown>).info = "modified";
		manifest.digest = "f".repeat(64);
		options.botRevision = 99;
		const handle = await preparing;
		const cap = getTaskWorkspaceCapability(handle, binding);
		binding.botId = "mutated";
		const resolved = await cap.resolve();
		expect(resolved.contractDigest).toBe(expectedContract);
		expect(resolved.manifestDigest).toBe(expectedManifest);
		const artifact = await cap.captureArtifact();
		expect(artifact.baseline?.repositoryId).toBe(canonicalRepoId);
		expect(artifact.producer.contractDigest).toBe(expectedContract);
		expect(artifact.producer.manifestDigest).toBe(expectedManifest);
		await cap.cleanup();
	});

	it("isolates same task/attempt across bots, single-flights capture, and retains all trees through GC", async () => {
		const { repo, baseCommit, dataDir, canonicalRepoId } = await fixture();
		const contract = buildContract(canonicalRepoId, baseCommit);
		const common = { dataDir, repoRoot: repo, contract, contextManifest: buildManifest(contract) };
		const b1: TaskWorkspaceBinding = {
			deviceId: "dev",
			botId: "first",
			botRevision: 1,
			taskId: "same",
			attemptId: "same",
		};
		const b2 = { ...b1, botId: "second" };
		const preparing = prepareTaskWorkspace({ ...common, ...b1 });
		await expect(prepareTaskWorkspace({ ...common, ...b1 })).rejects.toThrow("already preparing");
		const [h1, h2] = await Promise.all([preparing, prepareTaskWorkspace({ ...common, ...b2 })]);
		const [w1, w2] = await Promise.all([resolveTaskWorkspace(h1, b1), resolveTaskWorkspace(h2, b2)]);
		expect(w1.cwd).not.toBe(w2.cwd);
		await writeFile(join(w1.cwd, "first.txt"), "one\n");
		await writeFile(join(w2.cwd, "second.txt"), "two\n");
		const [a1, repeat1, a2] = await Promise.all([
			captureTaskArtifact(h1, b1),
			captureTaskArtifact(h1, b1),
			captureTaskArtifact(h2, b2),
		]);
		expect(repeat1).toBe(a1);
		expect(a1.outputTree).not.toBe(a2.outputTree);
		const refs = (await gitExec(repo, "for-each-ref", "--format=%(refname)", "refs/pi-tasks/")).split("\n");
		expect(refs).toHaveLength(4);
		await cleanupTaskWorkspace(h1, b1, { force: true });
		const retained = (await gitExec(repo, "for-each-ref", "--format=%(refname)", "refs/pi-tasks/")).split("\n");
		expect(retained).toHaveLength(3);
		expect(retained.filter((ref) => ref.endsWith(`/${h2.handleId}`))).toHaveLength(2);
		expect((await resolveTaskWorkspace(h2, b2)).cwd).toBe(w2.cwd);
		await cleanupTaskWorkspace(h2, b2, { force: true });
		await git(repo, ["gc", "--prune=now"]);
		for (const oid of [baseCommit, a1.inputTree!, a1.outputTree!, a2.outputTree!]) {
			await expect(git(repo, ["cat-file", "-e", oid])).resolves.toBe("");
		}
	}, 60_000);

	it("does not overwrite an existing artifact ref and never deletes a changed retention ref", async () => {
		const { repo, baseCommit, dataDir, canonicalRepoId } = await fixture();
		const contract = buildContract(canonicalRepoId, baseCommit);
		const binding: TaskWorkspaceBinding = {
			deviceId: "dev",
			botId: "bot",
			botRevision: 1,
			taskId: "cas",
			attemptId: "one",
		};
		const handle = await prepareTaskWorkspace({
			...binding,
			dataDir,
			repoRoot: repo,
			contract,
			contextManifest: buildManifest(contract),
		});
		const workspaceRef = (
			await gitExec(repo, "for-each-ref", "--format=%(refname)", "refs/pi-tasks/workspaces/")
		).trim();
		const artifactRef = workspaceRef.replace("/workspaces/", "/artifacts/");
		await gitExec(repo, "update-ref", artifactRef, baseCommit);
		await expect(captureTaskArtifact(handle, binding)).rejects.toThrow();
		expect(await gitExec(repo, "rev-parse", artifactRef)).toBe(baseCommit);
		await gitExec(repo, "update-ref", workspaceRef, baseCommit);
		await expect(cleanupTaskWorkspace(handle, binding)).rejects.toThrow();
		expect(await gitExec(repo, "rev-parse", workspaceRef)).toBe(baseCommit);
		expect(await gitExec(repo, "rev-parse", artifactRef)).toBe(baseCommit);
	});

	it("cleans an abort immediately after real worktree creation without deleting unknown paths", async () => {
		const { repo, baseCommit, dataDir, canonicalRepoId } = await fixture();
		const contract = buildContract(canonicalRepoId, baseCommit);
		const controller = new AbortController();
		const original = controller.signal.throwIfAborted.bind(controller.signal);
		const root = join(dataDir, "task-workspaces");
		controller.signal.throwIfAborted = () => {
			if (existsSync(root) && readdirSync(root).some((name) => existsSync(join(root, name, ".git"))))
				controller.abort();
			original();
		};
		await expect(
			prepareTaskWorkspace({
				dataDir,
				repoRoot: repo,
				contract,
				contextManifest: buildManifest(contract),
				deviceId: "dev",
				botId: "bot",
				botRevision: 1,
				taskId: "abort-real",
				attemptId: "one",
				signal: controller.signal,
			}),
		).rejects.toThrow();
		expect(controller.signal.aborted).toBe(true);
		expect(getRegisteredWorkspaceCount()).toBe(0);
		expect(await gitExec(repo, "worktree", "list", "--porcelain")).not.toContain("task-workspaces");
		expect(readdirSync(root)).toEqual([]);
	});

	it("detects source gitdir junction substitution against its original canonical identity", async () => {
		const { repo, baseCommit, dataDir, canonicalRepoId } = await fixture();
		const contract = buildContract(canonicalRepoId, baseCommit);
		const binding: TaskWorkspaceBinding = {
			deviceId: "dev",
			botId: "bot",
			botRevision: 1,
			taskId: "redirect",
			attemptId: "one",
		};
		const handle = await prepareTaskWorkspace({
			...binding,
			dataDir,
			repoRoot: repo,
			contract,
			contextManifest: buildManifest(contract),
		});
		const source = join(repo, ".git");
		const moved = join(repo, ".git-moved");
		await rename(source, moved);
		await symlink(moved, source, "junction");
		await expect(resolveTaskWorkspace(handle, binding)).rejects.toThrow("git-common-dir changed");
		await expect(captureTaskArtifact(handle, binding)).rejects.toThrow("git-common-dir changed");
		await expect(cleanupTaskWorkspace(handle, binding, { force: true })).rejects.toThrow("git-common-dir changed");
		await rm(source);
		await rename(moved, source);
		await cleanupTaskWorkspace(handle, binding);
	});

	it("detects worktree pointer and path substitution and blocks unauthorized operations", async () => {
		const { repo, baseCommit, dataDir, canonicalRepoId } = await fixture();
		const contract = buildContract(canonicalRepoId, baseCommit);
		const manifest = buildManifest(contract);
		const binding: TaskWorkspaceBinding = {
			deviceId: "dev-tamper",
			botId: "bot-tamper",
			botRevision: 1,
			taskId: "task-tamper",
			attemptId: "att-1",
		};

		const handle = await prepareTaskWorkspace({
			dataDir,
			...binding,
			repoRoot: repo,
			contract,
			contextManifest: manifest,
		});

		const ws = await resolveTaskWorkspace(handle, binding);

		await rename(join(ws.cwd, ".git"), join(ws.cwd, ".git.saved"));
		await writeFile(join(ws.cwd, ".git"), `gitdir: ${join(repo, ".git")}\n`);

		await expect(resolveTaskWorkspace(handle, binding)).rejects.toThrow("Worktree identity error");
		await expect(captureTaskArtifact(handle, binding)).rejects.toThrow("Worktree identity error");
		await expect(cleanupTaskWorkspace(handle, binding)).rejects.toThrow("Worktree identity error");

		await rm(join(ws.cwd, ".git"));
		await rename(join(ws.cwd, ".git.saved"), join(ws.cwd, ".git"));

		const saved = `${ws.cwd}-saved`;
		const unrelated = join(dataDir, "unrelated");
		await mkdir(unrelated);
		await writeFile(join(unrelated, "keep.txt"), "keep\n");
		await rename(ws.cwd, saved);
		await symlink(unrelated, ws.cwd, "junction");
		await expect(resolveTaskWorkspace(handle, binding)).rejects.toThrow("path redirect");
		await expect(captureTaskArtifact(handle, binding)).rejects.toThrow("path redirect");
		await expect(cleanupTaskWorkspace(handle, binding, { force: true })).rejects.toThrow("path redirect");
		expect(await readFile(join(unrelated, "keep.txt"), "utf8")).toBe("keep\n");
		await rm(ws.cwd);
		await rename(saved, ws.cwd);
		await cleanupTaskWorkspace(handle, binding, { force: true });
	});
});
