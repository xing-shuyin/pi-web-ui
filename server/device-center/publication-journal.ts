import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, opendir, readFile, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { DevicePublishIntent, DevicePublishReceipt, DevicePublishStop } from "../protocol.js";
import { validatePublishIntent } from "./publish-intent.js";
import { canonicalizeJson } from "./work-contract.js";

export const PUBLICATION_WRITER_EPOCH = randomUUID();
export const PUBLICATION_JOURNAL_LIMITS = {
	entries: 512,
	bytes: 512 * 1024,
	headerBytes: 448 * 1024,
	events: 16,
} as const;
export interface PublicationRepository {
	repoRoot: string;
	commonDir: string;
	repositoryId: string;
	objectFormat: "sha1" | "sha256";
}
export type PublicationPhase = "prepared" | "cas_started" | "cas_rejected" | "applied" | "closed";
export interface PublicationJournal {
	intent: DevicePublishIntent;
	repository?: PublicationRepository;
	phase: PublicationPhase;
	receipt?: DevicePublishReceipt;
	stop?: DevicePublishStop;
	sequence: number;
	hash: string;
	casStarted?: boolean;
	processEpoch?: string;
	processStopped?: boolean;
}
interface JournalEvent {
	version: 1;
	sequence: number;
	previous: string;
	phase: PublicationPhase;
	intent?: DevicePublishIntent;
	repository?: PublicationRepository;
	receipt?: DevicePublishReceipt;
	stop?: DevicePublishStop;
	processEpoch?: string;
	processStopped?: boolean;
	hash: string;
}
const queues = new Map<string, Promise<unknown>>();
export async function serializePublication<T>(dataDir: string, run: () => Promise<T>): Promise<T> {
	const key = resolve(dataDir);
	const pending = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(run);
	queues.set(key, pending);
	try {
		return await pending;
	} finally {
		if (queues.get(key) === pending) queues.delete(key);
	}
}
export function publicationJournalDirectory(dataDir: string): string {
	return join(dataDir, "publication-journal-v1");
}
function fileName(intent: DevicePublishIntent) {
	return (
		createHash("sha256")
			.update(canonicalizeJson([intent.accountId, intent.targetDeviceId, intent.integrationId]))
			.digest("hex") + ".jsonl"
	);
}
function digest(event: Omit<JournalEvent, "hash">) {
	return createHash("sha256").update(canonicalizeJson(event)).digest("hex");
}
async function inspectDirectory(dataDir: string, create: boolean): Promise<string[]> {
	const dir = publicationJournalDirectory(dataDir);
	if (create) await mkdir(dir, { recursive: true });
	let names: string[];
	try {
		const stat = await lstat(dir);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Publication journal directory is unsafe");
		names = [];
		for await (const entry of await opendir(dir)) {
			names.push(entry.name);
			if (names.length > PUBLICATION_JOURNAL_LIMITS.entries * 3)
				throw new Error("Publication journal directory capacity exceeded");
		}
	} catch (error) {
		if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	if (
		names.filter((name) => name.endsWith(".jsonl")).length > PUBLICATION_JOURNAL_LIMITS.entries ||
		names.some((name) => !/^[a-f0-9]{64}\.jsonl(?:\.tmp-[a-f0-9-]{36})?$/.test(name))
	)
		throw new Error("Publication journal capacity or directory integrity failure");
	return names;
}
function assertProof(intent: DevicePublishIntent, proof: DevicePublishReceipt | DevicePublishStop) {
	if (
		proof.intentId !== intent.id ||
		proof.intentDigest !== intent.digest ||
		proof.candidateSha !== intent.candidateSha
	)
		throw new Error("Publication journal proof identity mismatch");
}
export async function readPublicationJournal(
	dataDir: string,
	input: DevicePublishIntent,
): Promise<PublicationJournal | undefined> {
	const intent = validatePublishIntent(input);
	const directory = publicationJournalDirectory(dataDir);
	let stat;
	const path = join(directory, fileName(intent));
	try {
		const parent = await lstat(directory);
		if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("Publication journal directory is unsafe");
		stat = await lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > PUBLICATION_JOURNAL_LIMITS.bytes || stat.size === 0)
		throw new Error("Publication journal file integrity failure");
	const raw = await readFile(path, "utf8");
	return parsePublicationJournal(raw, intent);
}
function parsePublicationJournal(raw: string, intent: DevicePublishIntent): PublicationJournal {
	if (!raw.endsWith("\n") || Buffer.byteLength(raw) > PUBLICATION_JOURNAL_LIMITS.bytes)
		throw new Error("Publication journal is incomplete");
	const lines = raw.slice(0, -1).split("\n");
	if (lines.length > PUBLICATION_JOURNAL_LIMITS.events) throw new Error("Publication journal event capacity exceeded");
	let journal: PublicationJournal | undefined;
	for (const [sequence, line] of lines.entries()) {
		const event = JSON.parse(line) as JournalEvent;
		const { hash, ...facts } = event;
		if (
			event.version !== 1 ||
			event.sequence !== sequence ||
			event.previous !== (journal?.hash ?? "") ||
			hash !== digest(facts)
		)
			throw new Error("Publication journal chain integrity failure");
		if (sequence === 0) {
			if (!event.intent || !["prepared", "closed"].includes(event.phase))
				throw new Error("Invalid publication journal header");
			const original = validatePublishIntent(event.intent);
			if (canonicalizeJson(original) !== canonicalizeJson(intent))
				throw new Error("Publication journal immutable intent mismatch");
			if (event.phase === "prepared" && !event.repository) throw new Error("Publication repository identity missing");
			if (
				event.repository &&
				(event.repository.repositoryId !== intent.repositoryId ||
					event.repository.objectFormat !== intent.objectFormat ||
					typeof event.repository.repoRoot !== "string" ||
					typeof event.repository.commonDir !== "string")
			)
				throw new Error("Publication repository identity mismatch");
			journal = { intent: original, repository: event.repository, phase: event.phase, sequence, hash };
		} else {
			if (event.intent || event.repository) throw new Error("Publication journal identity replacement");
			assertTransition(journal!, event.phase, event.receipt, event.stop, event.processStopped);
			journal = { ...journal!, phase: event.phase, sequence, hash };
		}
		if (event.phase === "cas_started" && !event.processStopped) {
			if (typeof event.processEpoch !== "string" || !/^[a-f0-9-]{36}$/.test(event.processEpoch))
				throw new Error("Publication CAS process identity missing");
			journal!.casStarted = true;
			journal!.processEpoch = event.processEpoch;
			journal!.processStopped = false;
		}
		if (event.processStopped === true) journal!.processStopped = true;
		if (event.receipt) {
			assertProof(intent, event.receipt);
			if (
				event.receipt.outcome !== "applied" ||
				!["cas_exit", "target_exact", "target_descendant"].includes(event.receipt.proof) ||
				!Number.isFinite(event.receipt.observedAt)
			)
				throw new Error("Invalid publication receipt");
			if (journal!.receipt && canonicalizeJson(journal!.receipt) !== canonicalizeJson(event.receipt))
				throw new Error("Publication receipt is immutable");
			journal!.receipt = event.receipt;
		}
		if (event.stop) {
			assertProof(intent, event.stop);
			if (
				event.stop.closed !== true ||
				!["applied", "not_applied", "unknown"].includes(event.stop.pastEffect) ||
				typeof event.stop.stopConfirmed !== "boolean" ||
				!Number.isFinite(event.stop.fencedAt) ||
				(event.stop.stopConfirmed && !Number.isFinite(event.stop.stoppedAt)) ||
				(!event.stop.stopConfirmed && event.stop.stoppedAt !== undefined)
			)
				throw new Error("Invalid publication stop");
			journal!.stop = event.stop;
		}
		if (event.receipt?.proof === "cas_exit" && event.processStopped !== true)
			throw new Error("Publication actual-exit stop proof missing");
		if (event.phase === "cas_rejected" && event.processStopped !== true)
			throw new Error("Publication rejection stop proof missing");
		if (journal!.receipt && journal!.stop?.pastEffect === "not_applied")
			throw new Error("Contradictory publication proof");
		if (journal!.phase === "applied" && !journal!.receipt) throw new Error("Publication applied receipt missing");
		if (journal!.phase === "closed" && !journal!.stop) throw new Error("Publication stop missing");
	}
	return journal!;
}
export async function loadPublicationJournals(dataDir: string): Promise<PublicationJournal[]> {
	const names = await inspectDirectory(dataDir, false);
	const journals: PublicationJournal[] = [];
	for (const name of names.filter((name) => name.endsWith(".jsonl"))) {
		const path = join(publicationJournalDirectory(dataDir), name);
		const stat = await lstat(path);
		if (!stat.isFile() || stat.isSymbolicLink() || !stat.size || stat.size > PUBLICATION_JOURNAL_LIMITS.bytes)
			throw new Error("Publication journal integrity failure during admission");
		const raw = await readFile(path, "utf8");
		const header = JSON.parse(raw.split("\n", 1)[0]) as JournalEvent;
		const intent = validatePublishIntent(header.intent);
		if (fileName(intent) !== name) throw new Error("Publication journal filename identity mismatch");
		const journal = await readPublicationJournal(dataDir, intent);
		if (!journal) throw new Error("Publication journal disappeared during admission");
		journals.push(journal);
	}
	return journals;
}
function assertTransition(
	journal: PublicationJournal,
	next: PublicationPhase,
	proof?: DevicePublishReceipt,
	stop?: DevicePublishStop,
	processStopped?: boolean,
) {
	if (journal.phase === "cas_started" && next === "cas_started" && processStopped === true) return;
	if (journal.phase === "closed" && next === "closed" && !journal.stop?.stopConfirmed && stop?.stopConfirmed) return;
	if (!journal.receipt && next === "applied" && proof && ["target_exact", "target_descendant"].includes(proof.proof))
		return;
	if (journal.stop || (journal.receipt && next !== "closed")) throw new Error("Publication journal is terminal");
	const allowed: Record<PublicationPhase, PublicationPhase[]> = {
		prepared: ["cas_started", "closed"],
		cas_started: ["cas_rejected", "applied", "closed"],
		cas_rejected: ["cas_started", "closed"],
		applied: ["closed"],
		closed: [],
	};
	if (!allowed[journal.phase].includes(next)) throw new Error("Invalid publication journal transition");
}
async function flushDirectory(path: string) {
	let handle;
	try {
		handle = await open(path, "r");
		await handle.sync();
	} catch (error) {
		if (
			process.platform !== "win32" ||
			!["EPERM", "EISDIR", "EINVAL", "EBADF", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")
		)
			throw error;
	} finally {
		await handle?.close();
	}
}
async function writeAtomicJournal(path: string, content: string, exclusive: boolean) {
	const temp = `${path}.tmp-${randomUUID()}`;
	const handle = await open(temp, "wx", 0o600);
	try {
		try {
			await handle.writeFile(content);
			await handle.sync();
		} finally {
			await handle.close();
		}
		if (exclusive) {
			await link(temp, path);
			await unlink(temp);
		} else await rename(temp, path);
		await flushDirectory(resolve(path, ".."));
	} finally {
		await unlink(temp).catch((error) => {
			if (error.code !== "ENOENT") throw error;
		});
	}
}
export async function createPublicationJournal(
	dataDir: string,
	input: DevicePublishIntent,
	repository?: PublicationRepository,
	stop?: DevicePublishStop,
): Promise<PublicationJournal> {
	const intent = validatePublishIntent(input);
	const existing = await readPublicationJournal(dataDir, intent);
	if (existing) return existing;
	const names = await inspectDirectory(dataDir, true);
	if (names.length >= PUBLICATION_JOURNAL_LIMITS.entries * 3 - 1)
		throw new Error("Publication journal temporary capacity exhausted");
	if (names.filter((name) => name.endsWith(".jsonl")).length >= PUBLICATION_JOURNAL_LIMITS.entries)
		throw new Error("Publication journal is full");
	const facts: Omit<JournalEvent, "hash"> = {
		version: 1,
		sequence: 0,
		previous: "",
		phase: stop ? "closed" : "prepared",
		intent,
		...(repository ? { repository } : {}),
		...(stop ? { stop } : {}),
	};
	const event = { ...facts, hash: digest(facts) };
	const line = JSON.stringify(event) + "\n";
	if (Buffer.byteLength(line) > PUBLICATION_JOURNAL_LIMITS.headerBytes)
		throw new Error("Publication journal intent exceeds reserved capacity");
	parsePublicationJournal(line, intent);
	await writeAtomicJournal(join(publicationJournalDirectory(dataDir), fileName(intent)), line, true);
	return (await readPublicationJournal(dataDir, intent))!;
}
export async function appendPublicationJournal(
	dataDir: string,
	journal: PublicationJournal,
	phase: PublicationPhase,
	proof?: { receipt?: DevicePublishReceipt; stop?: DevicePublishStop; processEpoch?: string; processStopped?: boolean },
): Promise<PublicationJournal> {
	const current = await readPublicationJournal(dataDir, journal.intent);
	if (!current || current.hash !== journal.hash) throw new Error("Publication journal changed concurrently");
	assertTransition(current, phase, proof?.receipt, proof?.stop, proof?.processStopped);
	if (
		current.sequence >=
		PUBLICATION_JOURNAL_LIMITS.events - (phase === "cas_started" && !proof?.processStopped ? 5 : 1)
	)
		throw new Error("Publication journal reserved capacity exhausted");
	const facts: Omit<JournalEvent, "hash"> = {
		version: 1,
		sequence: current.sequence + 1,
		previous: current.hash,
		phase,
		...proof,
	};
	const line = JSON.stringify({ ...facts, hash: digest(facts) }) + "\n";
	if (Buffer.byteLength(line) > 4096) throw new Error("Publication journal event too large");
	const names = await inspectDirectory(dataDir, false);
	if (names.length >= PUBLICATION_JOURNAL_LIMITS.entries * 3 - 1)
		throw new Error("Publication journal temporary capacity exhausted");
	const path = join(publicationJournalDirectory(dataDir), fileName(journal.intent));
	const raw = await readFile(path, "utf8");
	if (Buffer.byteLength(raw) + Buffer.byteLength(line) > PUBLICATION_JOURNAL_LIMITS.bytes)
		throw new Error("Publication journal capacity exceeded");
	parsePublicationJournal(raw + line, journal.intent);
	await writeAtomicJournal(path, raw + line, false);
	return (await readPublicationJournal(dataDir, journal.intent))!;
}
