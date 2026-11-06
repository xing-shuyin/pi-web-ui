import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publicationFixture } from "../helpers/publish-intent-fixture.js";
import {
	appendPublicationJournal,
	createPublicationJournal,
	loadPublicationJournals,
	publicationJournalDirectory,
	PUBLICATION_JOURNAL_LIMITS,
	PUBLICATION_WRITER_EPOCH,
	readPublicationJournal,
} from "../../server/device-center/publication-journal.js";
import { publishLocalIntent } from "../../server/device-center/local-publication.js";
import { sealPublishIntent } from "../../server/device-center/publish-intent.js";
const failure = vi.hoisted(() => ({ sync: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...original,
		open: async (...args: Parameters<typeof original.open>) => {
			const handle = await original.open(...args);
			if (failure.sync && String(args[0]).includes(".tmp-"))
				handle.sync = async () => {
					throw new Error("injected fsync failure");
				};
			return handle;
		},
	};
});
const dirs: string[] = [];
afterEach(async () => {
	failure.sync = false;
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function fixture() {
	const dataDir = await mkdtemp(join(tmpdir(), "publication-journal-"));
	dirs.push(dataDir);
	const { intent } = publicationFixture();
	const repository = {
		repoRoot: join(dataDir, "repo"),
		commonDir: join(dataDir, "repo", ".git"),
		repositoryId: intent.repositoryId,
		objectFormat: intent.objectFormat,
	};
	return { dataDir, intent, repository };
}
async function apply(f: Awaited<ReturnType<typeof fixture>>) {
	let journal = await createPublicationJournal(f.dataDir, f.intent, f.repository);
	journal = await appendPublicationJournal(f.dataDir, journal, "cas_started", {
		processEpoch: PUBLICATION_WRITER_EPOCH,
	});
	const receipt = {
		intentId: f.intent.id,
		intentDigest: f.intent.digest,
		candidateSha: f.intent.candidateSha,
		outcome: "applied" as const,
		proof: "cas_exit" as const,
		observedAt: Date.now(),
	};
	return appendPublicationJournal(f.dataDir, journal, "applied", { receipt, processStopped: true });
}
describe("independent bounded publication journal", () => {
	it("fails fsync before any publication side effect and preserves a previous durable receipt on failed atomic rewrite", async () => {
		const f = await fixture();
		const verify = vi.fn();
		failure.sync = true;
		await expect(
			publishLocalIntent({
				dataDir: f.dataDir,
				publishIntent: f.intent,
				repository: f.repository,
				mode: "first",
				verify,
			}),
		).rejects.toThrow("fsync");
		expect(verify).not.toHaveBeenCalled();
		expect(await readPublicationJournal(f.dataDir, f.intent)).toBeUndefined();
		failure.sync = false;
		const applied = await apply(f);
		failure.sync = true;
		await expect(
			appendPublicationJournal(f.dataDir, applied, "closed", {
				stop: {
					intentId: f.intent.id,
					intentDigest: f.intent.digest,
					candidateSha: f.intent.candidateSha,
					closed: true,
					stopConfirmed: true,
					pastEffect: "applied",
					fencedAt: Date.now(),
					stoppedAt: Date.now(),
				},
			}),
		).rejects.toThrow("fsync");
		expect((await readPublicationJournal(f.dataDir, f.intent))?.receipt).toEqual(applied.receipt);
	});
	it("rejects corrupted, partial, and unreadable journal identity rather than treating them as absence", async () => {
		const f = await fixture();
		await createPublicationJournal(f.dataDir, f.intent, f.repository);
		const dir = publicationJournalDirectory(f.dataDir),
			path = join(dir, (await readdir(dir))[0]);
		const raw = await readFile(path, "utf8");
		await writeFile(path, raw.slice(0, -1));
		await expect(readPublicationJournal(f.dataDir, f.intent)).rejects.toThrow("incomplete");
		await writeFile(path, raw.replace('"prepared"', '"closed"'));
		await expect(readPublicationJournal(f.dataDir, f.intent)).rejects.toThrow("integrity");
		await rm(path);
		await mkdir(path);
		await expect(readPublicationJournal(f.dataDir, f.intent)).rejects.toThrow("integrity");
	});
	it("refuses a different sealed intent for the same original integration", async () => {
		const f = await fixture();
		await createPublicationJournal(f.dataDir, f.intent, f.repository);
		const { digest: _digest, candidateSha: _candidateSha, ...facts } = f.intent;
		const changed = sealPublishIntent({ ...facts, createdAt: facts.createdAt + 1 });
		await expect(readPublicationJournal(f.dataDir, changed)).rejects.toThrow("immutable intent");
	});
	it("reserves terminal capacity at the full entry limit and ignores abandoned atomic temps during reads", async () => {
		const f = await fixture(),
			applied = await apply(f),
			dir = publicationJournalDirectory(f.dataDir);
		const names = Array.from(
			{ length: PUBLICATION_JOURNAL_LIMITS.entries - 1 },
			(_, i) =>
				createHash("sha256")
					.update("slot" + i)
					.digest("hex") + ".jsonl",
		);
		await Promise.all(names.map((name) => writeFile(join(dir, name), "bounded unrelated entry")));
		await writeFile(join(dir, names[0] + ".tmp-" + randomUUID()), "partial atomic snapshot");
		expect((await readPublicationJournal(f.dataDir, f.intent))?.receipt).toEqual(applied.receipt);
		const { intent: other } = publicationFixture("sha1", "new-integration");
		await expect(createPublicationJournal(f.dataDir, other, f.repository)).rejects.toThrow("full");
		const closed = await appendPublicationJournal(f.dataDir, applied, "closed", {
			stop: {
				intentId: f.intent.id,
				intentDigest: f.intent.digest,
				candidateSha: f.intent.candidateSha,
				closed: true,
				stopConfirmed: true,
				pastEffect: "applied",
				fencedAt: Date.now(),
				stoppedAt: Date.now(),
			},
		});
		expect(closed.receipt).toEqual(applied.receipt);
	});
	it("restores process-stop quarantine from the journal even when sessions are missing", async () => {
		const f = await fixture();
		let journal = await createPublicationJournal(f.dataDir, f.intent, f.repository);
		journal = await appendPublicationJournal(f.dataDir, journal, "cas_started", { processEpoch: randomUUID() });
		journal = await appendPublicationJournal(f.dataDir, journal, "applied", {
			receipt: {
				intentId: f.intent.id,
				intentDigest: f.intent.digest,
				candidateSha: f.intent.candidateSha,
				outcome: "applied",
				proof: "target_exact",
				observedAt: Date.now(),
				targetSha: f.intent.candidateSha,
			},
		});
		expect((await loadPublicationJournals(f.dataDir))[0]).toMatchObject({
			casStarted: true,
			processStopped: false,
			receipt: journal.receipt,
		});
	});
	it("never replaces the first immutable positive receipt", async () => {
		const f = await fixture();
		const journal = await apply(f);
		await expect(
			appendPublicationJournal(f.dataDir, journal, "applied", {
				receipt: { ...journal.receipt!, observedAt: Date.now() + 10 },
			}),
		).rejects.toThrow("terminal");
		expect((await readPublicationJournal(f.dataDir, f.intent))?.receipt).toEqual(journal.receipt);
	});
});
