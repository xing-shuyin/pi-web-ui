import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publicationFixture } from "../helpers/publish-intent-fixture.js";
import {
	assertPublishIntentScope,
	buildPublishCommit,
	sealPublishIntent,
	validatePublicationResult,
	validatePublishIntent,
} from "../../server/device-center/publish-intent.js";
import { hasVerifiedIntegration } from "../../server/device-center/integration-verification.js";

const exec = promisify(execFile);

describe("publish-intent canonical version 1", () => {
	it.each(["sha1", "sha256"] as const)(
		"matches real Git %s object hashing, fixed identity and parent order",
		async (format) => {
			const dir = await mkdtemp(join(tmpdir(), "publish-commit-"));
			try {
				const { intent, integration } = publicationFixture(format);
				expect(hasVerifiedIntegration(integration)).toBe(true);
				const { raw, candidateSha } = buildPublishCommit(intent);
				await exec("git", ["init", `--object-format=${format}`], { cwd: dir, windowsHide: true });
				const path = join(dir, "commit.raw");
				await writeFile(path, raw);
				const { stdout } = await exec("git", ["hash-object", "-t", "commit", path], { cwd: dir, windowsHide: true });
				expect(stdout.trim()).toBe(candidateSha);
				expect(raw.toString()).toContain(
					`tree ${intent.preparedTree}\nparent ${intent.expectedOld}\nparent ${intent.materializedCommit}\n`,
				);
				expect(raw.toString()).toContain(
					"author Pi Publication <publication@pi.invalid> 1700000000 +0000\ncommitter Pi Publication <publication@pi.invalid> 1700000000 +0000",
				);
				expect(raw.toString()).toContain(`Intent: ${intent.id}\nIntent-Digest: ${intent.digest}\n`);
				expect(raw.includes(13)).toBe(false);
				expect(buildPublishCommit(structuredClone(intent))).toEqual({ raw, candidateSha });
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		},
	);

	it("seals independent snapshots and binds all facts, intent ID and candidate", () => {
		const { intent } = publicationFixture();
		const { digest: _digest, candidateSha: _candidate, ...facts } = intent;
		const sealed = sealPublishIntent(facts);
		facts.review.summary = "mutated";
		expect(sealed.review.summary).toBe("Reviewed");
		for (const key of [
			"id",
			"repositoryId",
			"targetDeviceId",
			"expectedOld",
			"preparedTree",
			"digest",
			"candidateSha",
		] as const) {
			const forged = structuredClone(sealed);
			(forged as any)[key] += "0";
			expect(() => validatePublishIntent(forged), key).toThrow(/publication/);
		}
		expect(() => assertPublishIntentScope(intent, { accountId: "foreign" })).toThrow(/accountId mismatch/);
		expect(() => validatePublishIntent({ ...sealed, cwd: "arbitrary" })).toThrow(/fields/);
	});

	it("rejects re-sealed invalid review, verification, ref and algorithm evidence", () => {
		const { intent } = publicationFixture();
		for (const change of [
			(v: any) => {
				v.review.accountId = "foreign";
			},
			(v: any) => {
				v.review.commit = v.expectedOld;
			},
			(v: any) => {
				v.verification.results[0].exitCode = 1;
			},
			(v: any) => {
				v.verificationPlan.commands = ["changed"];
			},
			(v: any) => {
				v.targetRef = "refs/heads/a.lock/child";
			},
			(v: any) => {
				v.targetRef = "refs/heads/a@{b";
			},
			(v: any) => {
				v.objectFormat = "sha256";
			},
		]) {
			const { digest: _d, candidateSha: _c, ...facts } = structuredClone(intent);
			change(facts);
			expect(() => sealPublishIntent(facts)).toThrow(/publication/);
		}
	});

	it("validates immutable proof identity and rejects unsafe retry/cancel contradictions", () => {
		const { intent } = publicationFixture();
		const identity = { intentId: intent.id, intentDigest: intent.digest, candidateSha: intent.candidateSha };
		const receipt = { ...identity, outcome: "applied", proof: "cas_exit", observedAt: 1 };
		expect(validatePublicationResult({ status: "applied", publishReceipt: receipt }, intent).publishReceipt).toEqual(
			receipt,
		);
		for (const result of [
			{ status: "applied" },
			{ status: "pending", publishReceipt: receipt },
			{ status: "applied", publishReceipt: { ...receipt, intentDigest: "0".repeat(64) } },
			{ status: "applied", publishReceipt: { ...receipt, proof: "target_exact", targetSha: intent.expectedOld } },
			{
				status: "pending",
				publishObservation: {
					...identity,
					observedAt: 1,
					target: "expected_old",
					targetSha: intent.expectedOld,
					phase: "cas_started",
					retryable: true,
				},
			},
			{ status: "cancelled", publishStop: { ...identity, closed: true, pastEffect: "unknown", stoppedAt: 1 } },
			{ status: "pending", repoRoot: "arbitrary" },
		])
			expect(() => validatePublicationResult(result, intent)).toThrow(/publication/);
	});
});
