import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID, createHash } from "node:crypto";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { localPublicationFixture, nativeGit } from "../helpers/local-publication-fixture.js";
import {
	cancelLocalPublication,
	localPublicationStatus,
	publishLocalIntent,
} from "../../server/device-center/local-publication.js";
import {
	appendPublicationJournal,
	createPublicationJournal,
	readPublicationJournal,
} from "../../server/device-center/publication-journal.js";
import { validatePublicationResult } from "../../server/device-center/publish-intent.js";
const exec = promisify(execFile);
const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function fixture() {
	const f = await localPublicationFixture();
	dirs.push(f.dir);
	return f;
}
const fault = async () => {
	throw new Error("injected crash");
};
async function snapshot(dir: string): Promise<string> {
	const files: string[] = [];
	async function visit(path: string) {
		for (const entry of await readdir(path, { withFileTypes: true })) {
			const next = join(path, entry.name);
			if (entry.isDirectory()) await visit(next);
			else
				files.push(
					next +
						":" +
						createHash("sha256")
							.update(await readFile(next))
							.digest("hex"),
				);
		}
	}
	await visit(dir);
	return files.sort().join("\n");
}
// Real Git objects, refs and independent Node crashes require the native Windows process budget.
describe("local publication process and Git faults", { timeout: 60_000 }, () => {
	it("recovers prepared-before-candidate only with exact owner resume, preserves raw candidate and GC pin", async () => {
		const f = await fixture();
		await expect(publishLocalIntent(f.params, { hooks: { afterPrepared: fault } })).rejects.toThrow("injected");
		expect((await localPublicationStatus(f.params)).publishObservation).toMatchObject({
			phase: "prepared",
			target: "expected_old",
			retryable: true,
		});
		const verify = vi.fn(async () => {});
		expect((await publishLocalIntent({ ...f.params, verify })).status).toBe("pending");
		expect(verify).not.toHaveBeenCalled();
		expect((await publishLocalIntent({ ...f.params, mode: "resume" })).status).toBe("applied");
		expect(await nativeGit(f.repoRoot, "rev-parse", "target")).toBe(f.intent.candidateSha);
		expect(await nativeGit(f.repoRoot, "rev-parse", "target^1")).toBe(f.intent.expectedOld);
		expect(await nativeGit(f.repoRoot, "rev-parse", "target^2")).toBe(f.intent.materializedCommit);
		await nativeGit(f.repoRoot, "update-ref", "refs/heads/target", f.intent.expectedOld);
		await nativeGit(f.repoRoot, "gc", "--prune=now");
		expect(await nativeGit(f.repoRoot, "rev-parse", "refs/pi/publications/" + f.intent.digest)).toBe(
			f.intent.candidateSha,
		);
		expect((await localPublicationStatus(f.params)).status).toBe("applied");
	});
	it("never blindly retries cas_started even after the branch returns to the old SHA", async () => {
		const f = await fixture();
		await expect(publishLocalIntent(f.params, { hooks: { afterCasStarted: fault } })).rejects.toThrow();
		const verify = vi.fn(async () => {});
		expect((await publishLocalIntent({ ...f.params, mode: "resume", verify })).publishObservation).toMatchObject({
			phase: "cas_started",
			target: "expected_old",
			retryable: false,
		});
		expect(verify).not.toHaveBeenCalled();
	});
	it("persists the actual successful exit despite outer abort and an applied/cancel race", async () => {
		const f = await fixture();
		const controller = new AbortController();
		let cancellation: ReturnType<typeof cancelLocalPublication> | undefined;
		const result = await publishLocalIntent(f.params, {
			signal: controller.signal,
			hooks: {
				afterCasExit: async () => {
					controller.abort();
					cancellation = cancelLocalPublication(f.params);
				},
			},
		});
		expect(result.publishReceipt?.proof).toBe("cas_exit");
		expect(await cancellation).toMatchObject({
			status: "applied",
			publishStop: { closed: true, stopConfirmed: true, pastEffect: "applied" },
		});
		validatePublicationResult(await localPublicationStatus(f.params), f.intent);
	});
	it("makes observed post-crash receipts durable and monotone after ABA and session cleanup", async () => {
		const f = await fixture();
		await expect(publishLocalIntent(f.params, { hooks: { afterCasExit: fault } })).rejects.toThrow();
		await writeFile(join(f.dataDir, "integration-sessions.json"), "corrupt unrelated session");
		const observed = await localPublicationStatus(f.params);
		expect(observed.publishReceipt?.proof).toBe("target_exact");
		expect(observed.publishStop).toMatchObject({ closed: true, stopConfirmed: false, pastEffect: "applied" });
		await nativeGit(f.repoRoot, "update-ref", "refs/heads/target", f.intent.expectedOld);
		const again = await localPublicationStatus(f.params);
		expect(again.publishReceipt).toEqual(observed.publishReceipt);
		expect(again.publishObservation?.target).toBe("expected_old");
	});
	it("survives ACK loss after durable receipt and observes a descendant independently", async () => {
		const f = await fixture();
		await expect(publishLocalIntent(f.params, { hooks: { afterReceipt: fault } })).rejects.toThrow();
		const child = await nativeGit(
			f.repoRoot,
			"commit-tree",
			f.intent.preparedTree,
			"-p",
			f.intent.candidateSha,
			"-m",
			"descendant",
		);
		await nativeGit(f.repoRoot, "update-ref", "refs/heads/target", child);
		const result = await localPublicationStatus(f.params);
		expect(result.publishReceipt?.proof).toBe("cas_exit");
		expect(result.publishObservation?.target).toBe("descendant");
	});
	it("serializes cancellation before a delayed confirm and persists a tombstone without a session", async () => {
		const f = await fixture();
		let release!: () => void, entered!: () => void;
		const ready = new Promise<void>((r) => {
			entered = r;
		});
		const wait = new Promise<void>((r) => {
			release = r;
		});
		const publication = publishLocalIntent(f.params, {
			hooks: {
				afterPrepared: async () => {
					entered();
					await wait;
				},
			},
		});
		const rejected = expect(publication).rejects.toThrow();
		await ready;
		const cancellation = cancelLocalPublication(f.params);
		release();
		await rejected;
		expect(await cancellation).toMatchObject({
			status: "cancelled",
			publishStop: { stopConfirmed: true, pastEffect: "not_applied" },
		});
		const verify = vi.fn(async () => {});
		expect((await publishLocalIntent({ ...f.params, verify })).status).toBe("cancelled");
		expect(verify).not.toHaveBeenCalled();
		expect(await nativeGit(f.repoRoot, "rev-parse", "target")).toBe(f.intent.expectedOld);
	});
	it("retains a not-applied tombstone when an external actor later points the target at the candidate", async () => {
		const f = await fixture();
		await expect(publishLocalIntent(f.params, { hooks: { afterCandidatePinned: fault } })).rejects.toThrow();
		await cancelLocalPublication(f.params);
		await nativeGit(f.repoRoot, "update-ref", "refs/heads/target", f.intent.candidateSha);
		const result = await localPublicationStatus(f.params);
		expect(result.status).toBe("cancelled");
		expect(result.publishReceipt).toBeUndefined();
		expect(result.publishObservation?.target).toBe("candidate");
		validatePublicationResult(result, f.intent);
	});
	it("only classifies explicit old-value rejection as safely resumable", async () => {
		const f = await fixture();
		const result = await publishLocalIntent(f.params, {
			hooks: {
				afterCasStarted: async () => {
					await nativeGit(f.repoRoot, "update-ref", "refs/heads/target", f.intent.materializedCommit);
				},
			},
		});
		expect(result.publishObservation?.phase).toBe("cas_rejected");
		await nativeGit(f.repoRoot, "update-ref", "refs/heads/target", f.intent.expectedOld);
		expect((await localPublicationStatus(f.params)).publishObservation?.retryable).toBe(true);
		expect((await publishLocalIntent({ ...f.params, mode: "resume" })).status).toBe("applied");
	});
	it("keeps generic CAS failure unknown and fences an old writer without claiming it stopped", async () => {
		const f = await fixture();
		await writeFile(join(f.repository.commonDir, "refs", "heads", "target.lock"), "locked");
		const result = await publishLocalIntent(f.params);
		expect(result.publishObservation).toMatchObject({ phase: "cas_started", retryable: false });
		await rm(join(f.repository.commonDir, "refs", "heads", "target.lock"));
		let journal = await createPublicationJournal(f.dataDir, f.intent, f.repository);
		expect(journal.processStopped).toBe(true);
		const g = await fixture();
		journal = await createPublicationJournal(g.dataDir, g.intent, g.repository);
		await appendPublicationJournal(g.dataDir, journal, "cas_started", { processEpoch: randomUUID() });
		const cancelled = await cancelLocalPublication(g.params);
		expect(cancelled).toMatchObject({
			status: "pending",
			publishStop: { closed: true, stopConfirmed: false, pastEffect: "unknown" },
		});
		expect(cancelled.publishStop?.stoppedAt).toBeUndefined();
	});
	it("does not follow symbolic publication refs or execute reference hooks", async () => {
		const f = await fixture();
		await writeFile(
			join(f.repository.commonDir, "hooks", "reference-transaction"),
			"#!/bin/sh\necho hook > hook-ran\n",
			{ mode: 0o755 },
		);
		await nativeGit(f.repoRoot, "symbolic-ref", "refs/heads/target", "refs/heads/master");
		await expect(publishLocalIntent(f.params)).rejects.toThrow("symbolic");
		expect(await nativeGit(f.repoRoot, "symbolic-ref", "refs/heads/target")).toBe("refs/heads/master");
		await expect(readFile(join(f.repoRoot, "hook-ran"))).rejects.toThrow();
	});
	it("refuses a conflicting retention pin before CAS and preserves both refs", async () => {
		const f = await fixture();
		const pin = "refs/pi/publications/" + f.intent.digest;
		await nativeGit(f.repoRoot, "update-ref", pin, f.intent.expectedOld);
		await expect(publishLocalIntent(f.params)).rejects.toThrow("retention ref identity");
		expect(await nativeGit(f.repoRoot, "rev-parse", pin)).toBe(f.intent.expectedOld);
		expect(await nativeGit(f.repoRoot, "rev-parse", "target")).toBe(f.intent.expectedOld);
		expect((await readPublicationJournal(f.dataDir, f.intent))?.phase).toBe("prepared");
	});
	it("performs repeated original-repository probes without writing Git, config or safe homes", async () => {
		const f = await fixture();
		await expect(publishLocalIntent(f.params, { hooks: { afterCandidatePinned: fault } })).rejects.toThrow();
		const before = await snapshot(f.repoRoot);
		await localPublicationStatus(f.params);
		await localPublicationStatus(f.params);
		expect(await snapshot(f.repoRoot)).toBe(before);
		expect((await readdir(f.dataDir)).sort()).toEqual(["publication-journal-v1"]);
	});
	it.each(["afterPrepared", "afterCasStarted", "afterCasExit", "afterReceipt"] as const)(
		"recovers independent Node process crash at %s",
		async (stage) => {
			const f = await fixture();
			const script = join(f.dir, "crash.mjs");
			const moduleUrl = pathToFileURL(resolve("server/device-center/local-publication.ts")).href;
			await writeFile(
				script,
				`import {publishLocalIntent} from ${JSON.stringify(moduleUrl)};\nawait publishLocalIntent({...${JSON.stringify({ ...f.params, verify: undefined })},verify:async()=>{}},{hooks:{${stage}:async()=>process.exit(77)}});\n`,
			);
			await expect(
				exec(process.execPath, ["--import", "tsx", script], { cwd: process.cwd(), timeout: 30_000, windowsHide: true }),
			).rejects.toMatchObject({ code: 77 });
			const result = await localPublicationStatus(f.params);
			if (stage === "afterPrepared")
				expect(result.publishObservation).toMatchObject({ phase: "prepared", retryable: true });
			else if (stage === "afterCasStarted") {
				expect(result.publishObservation).toMatchObject({ phase: "cas_started", retryable: false });
				expect((await cancelLocalPublication(f.params)).publishStop?.stopConfirmed).toBe(false);
			} else {
				expect(result.status).toBe("applied");
				if (stage === "afterCasExit")
					expect(result.publishStop).toMatchObject({ closed: true, stopConfirmed: false, pastEffect: "applied" });
			}
		},
	);
});
