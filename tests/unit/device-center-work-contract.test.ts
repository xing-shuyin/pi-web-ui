import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
	canonicalizeJson,
	computeArtifactDigest,
	computeContractDigest,
	computeManifestDigest,
	createContextManifest,
	createWorkContract,
	validateCodeArtifactOutcome,
	validateContextManifest,
	validateDeviceArtifact,
	validateInputArtifacts,
	validateWorkContract,
	contractInputReferences,
	MAX_WORK_CONTRACT_BYTES,
	MAX_CONTEXT_MANIFEST_BYTES,
	MAX_PATCH_BYTES,
} from "../../server/device-center/work-contract.js";
import type { DeviceArtifact } from "../../server/protocol.js";

describe("work-contract: canonical JSON and deterministic digests", () => {
	it("sorts object keys alphabetically and ignores undefined values", () => {
		const objA = { b: 2, a: 1, c: undefined, nested: { y: "hello", x: true } };
		const objB = { nested: { x: true, y: "hello" }, a: 1, b: 2 };
		expect(canonicalizeJson(objA)).toBe(canonicalizeJson(objB));
		expect(canonicalizeJson(objA)).toBe('{"a":1,"b":2,"nested":{"x":true,"y":"hello"}}');
	});

	it("computes deterministic contract digests regardless of property order", () => {
		const contract1 = createWorkContract({
			id: "contract-1",
			revision: 1,
			executionMode: "chat",
			goal: "Build feature",
			constraints: ["c1", "c2"],
			acceptanceCriteria: ["a1"],
		});
		const contract2 = createWorkContract({
			acceptanceCriteria: ["a1"],
			constraints: ["c1", "c2"],
			goal: "Build feature",
			executionMode: "chat",
			revision: 1,
			id: "contract-1",
		});
		expect(contract1.digest).toBe(contract2.digest);
		expect(computeContractDigest(contract1)).toBe(contract1.digest);
	});

	it("computes deterministic manifest digest", () => {
		const contract = createWorkContract({
			id: "contract-1",
			goal: "Goal",
			executionMode: "chat",
		});
		const manifest = createContextManifest({
			contract,
			context: { foo: "bar" },
			taskState: { state: "ok" },
			inputs: null,
			policyRef: "policy-v1",
			truncationBudget: 50000,
		});
		expect(manifest.digest).toMatch(/^[0-9a-f]{64}$/);
		expect(computeManifestDigest(manifest)).toBe(manifest.digest);
	});
});

describe("work-contract: deep freeze and structured immutability", () => {
	it("prevents external mutation from affecting created contract", () => {
		const constraints = ["original-constraint"];
		const criteria = ["original-criteria"];
		const contract = createWorkContract({
			id: "contract-mut",
			goal: "Test immutability",
			constraints,
			acceptanceCriteria: criteria,
		});

		constraints.push("tampered-constraint");
		criteria[0] = "tampered-criteria";

		expect(contract.constraints).toEqual(["original-constraint"]);
		expect(contract.acceptanceCriteria).toEqual(["original-criteria"]);

		// Mutating frozen contract directly throws in strict mode
		expect(() => {
			(contract as any).goal = "changed";
		}).toThrow();
		expect(() => {
			contract.constraints?.push("new");
		}).toThrow();
	});

	it("prevents external mutation from affecting sealed ContextManifest", () => {
		const contract = createWorkContract({ id: "c-1", goal: "Goal" });
		const context = { messages: [{ text: "first" }] };
		const taskState = { step: 1 };
		const manifest = createContextManifest({
			contract,
			context,
			taskState,
		});

		context.messages.push({ text: "second" });
		taskState.step = 99;

		expect((manifest.context as any).messages).toHaveLength(1);
		expect((manifest.taskState as any).step).toBe(1);

		expect(() => {
			(manifest as any).contractId = "tampered";
		}).toThrow();
	});
});

describe("work-contract: strict allowlist and bounding guards", () => {
	it("rejects unknown fields in contract input", () => {
		expect(() => {
			createWorkContract({
				goal: "Goal",
				unknownField: "hack",
			} as any);
		}).toThrow(/Unknown field 'unknownField'/);
	});

	it("rejects unknown fields in baseline", () => {
		expect(() => {
			createWorkContract({
				goal: "Goal",
				executionMode: "code",
				baseline: {
					repositoryId: "repo-1",
					commit: "0123456789012345678901234567890123456789",
					extra: "danger",
				} as any,
			});
		}).toThrow(/Unknown field 'extra'/);
	});

	it("rejects unknown fields during validateWorkContract", () => {
		const contract = createWorkContract({ goal: "Goal" });
		const tampered = { ...contract, injected: 123 };
		const res = validateWorkContract(tampered);
		expect(res.valid).toBe(false);
		if (!res.valid) expect(res.reason).toMatch(/Unknown field 'injected'/);
	});

	it("rejects unknown fields in artifact and producer (e.g. producer.cwd)", () => {
		const validArt: DeviceArtifact = {
			id: "art-1",
			digest: "",
			producer: {
				deviceId: "d1",
				botId: "b1",
				taskId: "t1",
				attemptId: "att1",
			},
			createdAt: Date.now(),
		};
		validArt.digest = computeArtifactDigest(validArt);

		const tamperedArt = {
			...validArt,
			producer: {
				...validArt.producer,
				cwd: "/home/user/repo",
			},
		};
		const res = validateDeviceArtifact(tamperedArt);
		expect(res.valid).toBe(false);
		if (!res.valid) expect(res.reason).toMatch(/Unknown field 'cwd' in artifact\.producer/);
	});

	it("rejects unknown fields in contextManifest", () => {
		const contract = createWorkContract({ goal: "Goal" });
		const manifest = createContextManifest({ contract, context: {} });
		const tampered = { ...manifest, extra: "unauthorized" };
		const res = validateContextManifest(tampered);
		expect(res.valid).toBe(false);
		if (!res.valid) expect(res.reason).toMatch(/Unknown field 'extra'/);
	});

	it("handles malformed unknown inputs without throwing in validate functions", () => {
		expect(validateWorkContract(null).valid).toBe(false);
		expect(validateWorkContract("not-an-object").valid).toBe(false);
		expect(validateWorkContract([1, 2, 3]).valid).toBe(false);
		expect(validateWorkContract({}).valid).toBe(false);

		expect(validateContextManifest(null).valid).toBe(false);
		expect(validateContextManifest(undefined).valid).toBe(false);
		expect(validateContextManifest(12345).valid).toBe(false);

		expect(validateDeviceArtifact(null).valid).toBe(false);
		expect(validateDeviceArtifact({ id: 123 }).valid).toBe(false);

		expect(validateInputArtifacts("not-an-array").valid).toBe(false);
	});

	it("bounds string lengths and array counts", () => {
		expect(() => {
			createWorkContract({ goal: "a".repeat(20_000) });
		}).toThrow(/exceeds maximum length/);

		expect(() => {
			createWorkContract({
				goal: "Goal",
				constraints: Array.from({ length: 100 }, (_, i) => `c-${i}`),
			});
		}).toThrow(/exceeds limit/);

		expect(() => {
			createWorkContract({
				goal: "Goal",
				constraints: ["a".repeat(3000)],
			});
		}).toThrow(/up to 2048 characters/);
	});
});

describe("work-contract: code mode baseline and artifact rules", () => {
	const validCommit = "a".repeat(40);

	it("requires baseline with 40-char hex commit for code executionMode", () => {
		expect(() => {
			createWorkContract({ executionMode: "code", goal: "Code work" });
		}).toThrow(/requires a baseline/);

		expect(() => {
			createWorkContract({
				executionMode: "code",
				goal: "Code work",
				baseline: { repositoryId: "repo", commit: "short" },
			});
		}).toThrow(/40-character hex commit SHA/);

		const validContract = createWorkContract({
			executionMode: "code",
			goal: "Code work",
			baseline: { repositoryId: "repo", commit: validCommit },
		});
		expect(validContract.baseline?.commit).toBe(validCommit);
		expect(validContract.executionMode).toBe("code");
	});

	it("validates strict canonical base64 and bounded size in patch", () => {
		const rawContent = Buffer.from("console.log('patch content');\n");
		const canonicalBase64 = rawContent.toString("base64");
		const patchSha256 = createHash("sha256").update(rawContent).digest("hex");

		const art: DeviceArtifact = {
			id: "art-patch",
			digest: "",
			producer: {
				deviceId: "d1",
				botId: "b1",
				taskId: "t1",
				attemptId: "att1",
			},
			baseline: { repositoryId: "repo-1", commit: validCommit },
			inputTree: "1".repeat(40),
			outputTree: "2".repeat(40),
			patchBase64: canonicalBase64,
			patchSha256,
			createdAt: Date.now(),
		};
		art.digest = computeArtifactDigest(art);

		expect(validateDeviceArtifact(art).valid).toBe(true);

		// Non-canonical base64 with spaces or invalid chars
		const nonCanonical = { ...art, patchBase64: canonicalBase64 + "  \n" };
		nonCanonical.digest = computeArtifactDigest(nonCanonical);
		expect(validateDeviceArtifact(nonCanonical).valid).toBe(false);

		// Mismatched patchSha256
		const badHash = { ...art, patchSha256: "0".repeat(64) };
		badHash.digest = computeArtifactDigest(badHash);
		const badHashRes = validateDeviceArtifact(badHash);
		expect(badHashRes.valid).toBe(false);
		if (!badHashRes.valid) expect(badHashRes.reason).toMatch(/does not match patchBase64 content/);

		// Exceeds 128 KiB
		const hugePatch = Buffer.alloc(130 * 1024, "x");
		const hugeArt = {
			...art,
			patchBase64: hugePatch.toString("base64"),
			patchSha256: createHash("sha256").update(hugePatch).digest("hex"),
		};
		hugeArt.digest = computeArtifactDigest(hugeArt);
		const hugeRes = validateDeviceArtifact(hugeArt);
		expect(hugeRes.valid).toBe(false);
		if (!hugeRes.valid) expect(hugeRes.reason).toMatch(/exceeds maximum bounded size/);
	});

	it("rejects local file paths in trees and properties", () => {
		const artWithLocalTree: DeviceArtifact = {
			id: "art-local",
			digest: "",
			producer: { deviceId: "d1", botId: "b1", taskId: "t1", attemptId: "att1" },
			inputTree: "C:\\Users\\admin\\repo",
			createdAt: Date.now(),
		};
		artWithLocalTree.digest = computeArtifactDigest(artWithLocalTree);
		expect(validateDeviceArtifact(artWithLocalTree).valid).toBe(false);
	});
});

describe("work-contract: inputArtifacts safe synthesis", () => {
	const validCommit = "b".repeat(40);

	it("rejects inputArtifacts in chat executionMode", () => {
		const art: DeviceArtifact = {
			id: "art-1",
			digest: "",
			producer: { deviceId: "d1", botId: "b1", taskId: "t1", attemptId: "att1" },
			createdAt: Date.now(),
		};
		art.digest = computeArtifactDigest(art);

		expect(() => {
			createWorkContract({
				executionMode: "chat",
				goal: "Chat goal",
				inputArtifacts: [art],
			});
		}).toThrow(/Chat execution mode does not support inputArtifacts synthesis/);
	});

	it("rejects inputArtifacts with mismatched baseline", () => {
		const art: DeviceArtifact = {
			id: "art-1",
			digest: "",
			producer: { deviceId: "d1", botId: "b1", taskId: "t1", attemptId: "att1" },
			baseline: { repositoryId: "repo-A", commit: "a".repeat(40) },
			createdAt: Date.now(),
		};
		art.digest = computeArtifactDigest(art);

		expect(() => {
			createWorkContract({
				executionMode: "code",
				goal: "Code goal",
				baseline: { repositoryId: "repo-B", commit: validCommit },
				inputArtifacts: [art],
			});
		}).toThrow(/baseline repository mismatch/);
	});

	it("rejects duplicate artifact IDs in inputArtifacts", () => {
		const art1: DeviceArtifact = {
			id: "dup-1",
			digest: "",
			producer: {
				deviceId: "d1",
				botId: "b1",
				taskId: "t1",
				attemptId: "att1",
				contractDigest: "a".repeat(64),
				manifestDigest: "b".repeat(64),
			},
			inputTree: "1".repeat(40),
			outputTree: "2".repeat(40),
			patchBase64: "",
			patchSha256: createHash("sha256").update("").digest("hex"),
			baseline: { repositoryId: "repo-1", commit: validCommit },
			createdAt: Date.now(),
		};
		art1.digest = computeArtifactDigest(art1);

		expect(() => {
			createWorkContract({
				executionMode: "code",
				goal: "Code goal",
				baseline: { repositoryId: "repo-1", commit: validCommit },
				inputArtifacts: [art1, art1],
			});
		}).toThrow(/Duplicate artifact id/);
	});
});

describe("work-contract: validateCodeArtifactOutcome", () => {
	const commit = "c".repeat(40);
	const contract = createWorkContract({
		id: "c-outcome",
		revision: 1,
		executionMode: "code",
		goal: "Outcome test",
		baseline: { repositoryId: "repo-1", commit },
	});
	const manifest = createContextManifest({
		contract,
		context: { initial: true },
	});

	const task = {
		id: "task-100",
		attemptId: "att-100",
		deviceId: "dev-100",
		botId: "bot-100",
		executionMode: "code" as const,
		contract,
		contextManifest: manifest,
	};

	it("validates code outcome with valid proofs and artifact matching task, contract, manifest", () => {
		const art: DeviceArtifact = {
			id: "art-out",
			digest: "",
			producer: {
				deviceId: "dev-100",
				botId: "bot-100",
				taskId: "task-100",
				attemptId: "att-100",
				contractDigest: contract.digest,
				manifestDigest: manifest.digest,
			},
			baseline: { repositoryId: "repo-1", commit },
			inputTree: "1".repeat(40),
			outputTree: "2".repeat(40),
			patchBase64: "",
			patchSha256: createHash("sha256").update("").digest("hex"),
			createdAt: Date.now(),
		};
		art.digest = computeArtifactDigest(art);

		const res = validateCodeArtifactOutcome({
			task,
			artifact: art,
			executionCompleted: true,
			artifactProduced: true,
		});
		expect(res.valid).toBe(true);
		if (res.valid) expect(res.artifact?.id).toBe("art-out");
	});

	it("rejects outcome if executionCompleted or artifactProduced proof flags are missing", () => {
		const art: DeviceArtifact = {
			id: "art-out",
			digest: "",
			producer: {
				deviceId: "dev-100",
				botId: "bot-100",
				taskId: "task-100",
				attemptId: "att-100",
			},
			createdAt: Date.now(),
		};
		art.digest = computeArtifactDigest(art);

		const missingExec = validateCodeArtifactOutcome({
			task,
			artifact: art,
			executionCompleted: false,
			artifactProduced: true,
		});
		expect(missingExec.valid).toBe(false);
		if (!missingExec.valid) expect(missingExec.reason).toMatch(/executionCompleted/);

		const missingProduced = validateCodeArtifactOutcome({
			task,
			artifact: art,
			executionCompleted: true,
			artifactProduced: false,
		});
		expect(missingProduced.valid).toBe(false);
		if (!missingProduced.valid) expect(missingProduced.reason).toMatch(/artifactProduced/);
	});

	it("rejects outcome if artifact producer attemptId or digests do not match", () => {
		const art: DeviceArtifact = {
			id: "art-out",
			digest: "",
			producer: {
				deviceId: "dev-100",
				botId: "bot-100",
				taskId: "task-100",
				attemptId: "OLD-ATTEMPT", // Mismatch!
				contractDigest: contract.digest,
				manifestDigest: manifest.digest,
			},
			baseline: { repositoryId: "repo-1", commit },
			inputTree: "1".repeat(40),
			outputTree: "2".repeat(40),
			patchBase64: "",
			patchSha256: createHash("sha256").update("").digest("hex"),
			createdAt: Date.now(),
		};
		art.digest = computeArtifactDigest(art);

		const res = validateCodeArtifactOutcome({
			task,
			artifact: art,
			executionCompleted: true,
			artifactProduced: true,
		});
		expect(res.valid).toBe(false);
		if (!res.valid) expect(res.reason).toMatch(/attemptId.*mismatch/);
	});
});

describe("work-contract: production boundary regressions", () => {
	const baseline = { repositoryId: "repo", commit: "c".repeat(40) };
	function artifact(patch = Buffer.alloc(0)): DeviceArtifact {
		const value: DeviceArtifact = {
			id: "input",
			digest: "",
			createdAt: 1,
			baseline,
			producer: {
				deviceId: "device",
				botId: "bot",
				taskId: "task",
				attemptId: "attempt",
				contractDigest: "a".repeat(64),
				manifestDigest: "b".repeat(64),
			},
			inputTree: "1".repeat(40),
			outputTree: "2".repeat(40),
			patchBase64: patch.toString("base64"),
			patchSha256: createHash("sha256").update(patch).digest("hex"),
		};
		value.digest = computeArtifactDigest(value);
		return value;
	}
	const contract = () =>
		createWorkContract({ goal: "code goal", executionMode: "code", baseline, inputArtifacts: [artifact()] });

	it.each(["baseline", "inputTree", "outputTree", "patchBase64", "patchSha256", "contractDigest", "manifestDigest"])(
		"rejects input artifact without %s even when its digest is recomputed",
		(field) => {
			const value = structuredClone(artifact()) as any;
			if (field.endsWith("Digest")) delete value.producer[field];
			else delete value[field];
			value.digest = computeArtifactDigest(value);
			expect(validateInputArtifacts([value], baseline, "code").valid).toBe(false);
		},
	);

	it("accepts the exact 128 KiB patch ceiling and an empty no-op, rejects oversized and noncanonical patches", () => {
		expect(validateInputArtifacts([artifact()], baseline, "code").valid).toBe(true);
		expect(validateInputArtifacts([artifact(Buffer.alloc(MAX_PATCH_BYTES))], baseline, "code").valid).toBe(true);
		expect(validateDeviceArtifact(artifact(Buffer.alloc(MAX_PATCH_BYTES + 1))).valid).toBe(false);
		const value = artifact(Buffer.from("f"));
		value.patchBase64 = "Zh==";
		value.digest = computeArtifactDigest(value);
		expect(validateDeviceArtifact(value).valid).toBe(false);
	});

	it("bounds aggregate contracts, manifest bytes and artifact count without relaxing individual guards", () => {
		expect(Buffer.byteLength(JSON.stringify(contract()))).toBeLessThan(MAX_WORK_CONTRACT_BYTES);
		expect(() =>
			createWorkContract({
				goal: "large",
				executionMode: "code",
				baseline,
				inputArtifacts: [
					artifact(Buffer.alloc(MAX_PATCH_BYTES)),
					{ ...artifact(Buffer.alloc(MAX_PATCH_BYTES)), id: "second" },
				].map((a) => ({ ...a, digest: computeArtifactDigest(a) })),
			}),
		).toThrow(/maximum size/);
		expect(
			validateInputArtifacts(
				Array.from({ length: 9 }, (_, i) => {
					const a = { ...artifact(), id: String(i) };
					return { ...a, digest: computeArtifactDigest(a) };
				}),
				baseline,
				"code",
			).valid,
		).toBe(false);
		expect(() =>
			createContextManifest({ contract: contract(), context: "x".repeat(MAX_CONTEXT_MANIFEST_BYTES) }),
		).toThrow(/maximum size/);
	});

	it("seals ordered input references and enforces the actual context byte budget", () => {
		const c = contract();
		const manifest = createContextManifest({
			contract: c,
			context: { message: "中文" },
			truncationBudget: 32,
			policyRef: "server/device-center/group-context.ts#groupTaskContext",
		});
		expect(manifest.inputs).toEqual(contractInputReferences(c));
		expect(JSON.stringify(manifest.inputs)).not.toContain("patchBase64");
		expect(() => createContextManifest({ contract: c, context: { message: "中文" }, truncationBudget: 8 })).toThrow(
			/truncationBudget/,
		);
		expect(() => createContextManifest({ contract: c, context: null, inputs: c.inputArtifacts })).toThrow(
			/inputs do not match/,
		);
		const changed = { ...manifest, inputs: [{ id: "input", digest: "0".repeat(64) }] };
		changed.digest = computeManifestDigest(changed);
		expect(validateContextManifest(changed, c).valid).toBe(false);
	});

	it("binds executable contract and manifest fields to their digests", () => {
		const c = contract();
		for (const change of [
			{ goal: "other" },
			{ constraints: ["other"] },
			{ acceptanceCriteria: ["other"] },
			{ baseline: { ...baseline, commit: "d".repeat(40) } },
			{ inputArtifacts: [] },
		])
			expect(validateWorkContract({ ...c, ...change }).valid).toBe(false);
		const m = createContextManifest({
			contract: c,
			context: { a: 1 },
			taskState: { progress: "first" },
			truncationBudget: 100,
			policyRef: "policy-v1",
			executionPolicy: { deviceId: "device", botId: "bot", botRevision: 1 },
		});
		for (const change of [
			{ context: { a: 2 } },
			{ taskState: { progress: "changed" } },
			{ inputs: null },
			{ truncationBudget: 99 },
			{ policyRef: "policy-v2" },
			{ executionPolicy: { deviceId: "device", botId: "bot", botRevision: 2 } },
		])
			expect(validateContextManifest({ ...m, ...change }, c).valid).toBe(false);
	});

	it("returns detached deeply frozen contract, manifest and artifact evidence", () => {
		const rawArtifact = structuredClone(artifact());
		const a = validateDeviceArtifact(rawArtifact);
		const rawContract = structuredClone(contract());
		const c = validateWorkContract(rawContract);
		const rawManifest = structuredClone(
			createContextManifest({ contract: rawContract, context: { nested: { value: "sealed" } } }),
		);
		const m = validateContextManifest(rawManifest, rawContract);
		expect(a.valid && c.valid && m.valid).toBe(true);
		rawArtifact.producer.taskId = "mutated";
		rawContract.baseline!.commit = "e".repeat(40);
		(rawManifest.context as any).nested.value = "mutated";
		if (a.valid) {
			expect(a.artifact.producer.taskId).toBe("task");
			expect(Object.isFrozen(a.artifact.producer)).toBe(true);
		}
		if (c.valid) expect(c.contract.baseline!.commit).toBe(baseline.commit);
		if (m.valid) {
			expect((m.manifest.context as any).nested.value).toBe("sealed");
			expect(Object.isFrozen(m.manifest.context)).toBe(true);
		}
	});

	it("rejects malformed unknown inputs without throwing or JSON coercion", () => {
		const cycle: any = {};
		cycle.self = cycle;
		for (const bad of [
			null,
			3,
			false,
			[],
			"x",
			cycle,
			{
				get goal() {
					throw new Error("getter");
				},
			},
		]) {
			expect(validateWorkContract(bad).valid).toBe(false);
			expect(validateDeviceArtifact(bad).valid).toBe(false);
			expect(validateContextManifest(bad).valid).toBe(false);
		}
		const m = createContextManifest({ contract: contract(), context: null });
		for (const context of [cycle, new Date(), { value: Infinity }, [undefined], { f() {} }])
			expect(validateContextManifest({ ...m, context }).valid).toBe(false);
		expect(validateCodeArtifactOutcome({ task: {} as any, executionCompleted: "true" }).valid).toBe(false);
		expect(validateCodeArtifactOutcome(null as any).valid).toBe(false);
		expect(() => createWorkContract({ goal: "x", id: " " })).toThrow(/id/);
	});

	it.each(["patchBase64", "patchSha256", "contractDigest", "manifestDigest"])(
		"rejects code outcomes missing %s",
		(field) => {
			const c = contract();
			const m = createContextManifest({ contract: c, context: null });
			const a = structuredClone(artifact()) as any;
			a.producer.contractDigest = c.digest;
			a.producer.manifestDigest = m.digest;
			if (field.endsWith("Digest")) delete a.producer[field];
			else delete a[field];
			a.digest = computeArtifactDigest(a);
			expect(
				validateCodeArtifactOutcome({
					task: { id: "task", attemptId: "attempt", deviceId: "device", botId: "bot", contract: c, contextManifest: m },
					artifact: a,
					executionCompleted: true,
					artifactProduced: true,
				}).valid,
			).toBe(false);
		},
	);
});
