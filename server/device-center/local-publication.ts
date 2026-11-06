import { spawn, execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type {
	DevicePublicationResult,
	DevicePublishIntent,
	DevicePublishObservation,
	DevicePublishReceipt,
	DevicePublishStop,
} from "../protocol.js";
import { buildPublishCommit, validatePublishIntent } from "./publish-intent.js";
import {
	appendPublicationJournal,
	createPublicationJournal,
	readPublicationJournal,
	serializePublication,
	type PublicationJournal,
	type PublicationRepository,
	PUBLICATION_WRITER_EPOCH,
} from "./publication-journal.js";

export interface PublicationGitExit {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	error?: Error;
}
export class PublicationStopUnconfirmedError extends Error {
	readonly stopUnconfirmed = true;
	constructor() {
		super("Publication Git process stop unconfirmed");
	}
}
const activeChildren = new Map<string, Set<number>>();
const controllers = new Map<string, AbortController>();
const fences = new Set<string>();
const operationKey = (dataDir: string, intent: DevicePublishIntent) =>
	JSON.stringify([resolve(dataDir), intent.accountId, intent.targetDeviceId, intent.integrationId]);
const gitEnvironment = () => {
	const env = { ...process.env };
	for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
	return {
		...env,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
		GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
		GIT_TERMINAL_PROMPT: "0",
		GIT_NO_REPLACE_OBJECTS: "1",
		GIT_GRAFT_FILE: process.platform === "win32" ? "NUL" : "/dev/null",
		GIT_NO_LAZY_FETCH: "1",
		GIT_OPTIONAL_LOCKS: "0",
		GIT_ATTR_NOSYSTEM: "1",
		GIT_LFS_SKIP_SMUDGE: "1",
	};
};
export function runPublicationGit(
	cwd: string,
	args: string[],
	options: { signal?: AbortSignal; input?: Buffer; key?: string; timeoutMs?: number; stopTimeoutMs?: number } = {},
): Promise<PublicationGitExit> {
	options.signal?.throwIfAborted();
	return new Promise((resolveExit, reject) => {
		const child = spawn(
			"git",
			[
				"--no-optional-locks",
				"-c",
				"core.hooksPath=/dev/null",
				"-c",
				"maintenance.auto=false",
				"-c",
				"gc.auto=0",
				"-c",
				"core.fsmonitor=false",
				"-c",
				"credential.helper=",
				"-c",
				"protocol.allow=never",
				...args,
			],
			{
				cwd,
				env: gitEnvironment(),
				windowsHide: true,
				detached: process.platform !== "win32",
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		const children = activeChildren.get(options.key ?? "") ?? new Set<number>();
		if (options.key && child.pid) {
			children.add(child.pid);
			activeChildren.set(options.key, children);
		}
		let stdout = "",
			stderr = "",
			error: Error | undefined,
			settled = false;
		let stopTimer: ReturnType<typeof setTimeout> | undefined;
		const settle = (result?: PublicationGitExit) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearTimeout(stopTimer);
			options.signal?.removeEventListener("abort", stop);
			if (result) resolveExit(result);
			else reject(new PublicationStopUnconfirmedError());
		};
		const stop = () => {
			if (child.pid) {
				if (process.platform === "win32")
					execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { timeout: 1500, windowsHide: true }, () => {});
				else
					try {
						process.kill(-child.pid, "SIGKILL");
					} catch {}
			}
			stopTimer ??= setTimeout(() => settle(), options.stopTimeoutMs ?? 2000);
		};
		const timer = setTimeout(stop, options.timeoutMs ?? 30_000);
		options.signal?.addEventListener("abort", stop, { once: true });
		for (const [stream, target] of [
			[child.stdout, "stdout"],
			[child.stderr, "stderr"],
		] as const)
			stream.on("data", (chunk: Buffer) => {
				const remaining = Math.max(0, 256 * 1024 - Buffer.byteLength(stdout) - Buffer.byteLength(stderr));
				if (target === "stdout") stdout += chunk.subarray(0, remaining).toString();
				else stderr += chunk.subarray(0, remaining).toString();
				if (chunk.length > remaining) {
					error = new Error("Publication Git output exceeded bound");
					stop();
				}
			});
		child.on("error", (value) => {
			error = value;
		});
		child.on("close", (code, signal) => {
			if (child.pid) children.delete(child.pid);
			if (options.key && !children.size) activeChildren.delete(options.key);
			settle({ code, signal, stdout, stderr, ...(error ? { error } : {}) });
		});
		child.stdin.on("error", () => {});
		child.stdin.end(options.input);
		if (options.signal?.aborted) stop();
	});
}
async function checkedGit(
	repo: PublicationRepository,
	args: string[],
	signal?: AbortSignal,
	input?: Buffer,
	key?: string,
) {
	const result = await runPublicationGit(repo.repoRoot, args, { signal, input, key });
	if (result.code !== 0 || result.signal || result.error)
		throw new Error(`Publication Git failed: ${result.stderr.slice(0, 300)}`, { cause: result.error });
	return result.stdout.trim();
}
function receipt(
	intent: DevicePublishIntent,
	proof: DevicePublishReceipt["proof"],
	targetSha?: string,
): DevicePublishReceipt {
	return {
		intentId: intent.id,
		intentDigest: intent.digest,
		candidateSha: intent.candidateSha,
		outcome: "applied",
		proof,
		observedAt: Date.now(),
		...(targetSha ? { targetSha } : {}),
	};
}
function observation(
	intent: DevicePublishIntent,
	phase: DevicePublishObservation["phase"],
	values: Partial<DevicePublishObservation> = {},
): DevicePublishObservation {
	return {
		intentId: intent.id,
		intentDigest: intent.digest,
		candidateSha: intent.candidateSha,
		observedAt: Date.now(),
		target: "unknown",
		phase,
		retryable: false,
		...values,
	};
}
async function verifyOriginalRepository(journal: PublicationJournal) {
	const repo = journal.repository;
	if (!repo) throw new Error("Original publication repository is unavailable");
	const root = await realpath(repo.repoRoot),
		common = await realpath(repo.commonDir);
	const equal = (a: string, b: string) =>
		process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
	if (!equal(root, repo.repoRoot) || !equal(common, repo.commonDir))
		throw new Error("Original publication repository path changed");
	const top = await checkedGit(repo, ["rev-parse", "--show-toplevel"]);
	const gitCommon = await checkedGit(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	const format = await checkedGit(repo, ["rev-parse", "--show-object-format"]);
	if (
		!equal(await realpath(top), root) ||
		!equal(await realpath(gitCommon), common) ||
		format !== repo.objectFormat ||
		repo.repositoryId !== journal.intent.repositoryId
	)
		throw new Error("Original publication repository identity changed");
	await checkedGit(repo, ["cat-file", "-e", `${journal.intent.expectedOld}^{commit}`]);
	return repo;
}
export function localPublicationStatus(params: {
	dataDir: string;
	publishIntent: DevicePublishIntent;
}): Promise<DevicePublicationResult> {
	return serializePublication(params.dataDir, () => publicationStatusWithinGate(params));
}
async function publicationStatusWithinGate(params: {
	dataDir: string;
	publishIntent: DevicePublishIntent;
}): Promise<DevicePublicationResult> {
	const intent = validatePublishIntent(params.publishIntent);
	let journal: PublicationJournal | undefined;
	try {
		journal = await readPublicationJournal(params.dataDir, intent);
	} catch {
		return {
			status: "pending",
			publishObservation: observation(intent, "unknown", { error: "Publication journal is unreadable or corrupt" }),
		};
	}
	if (!journal) return { status: "pending", publishObservation: observation(intent, "absent") };
	let current = observation(intent, journal.phase);
	let inferred: DevicePublishReceipt | undefined;
	try {
		const repo = await verifyOriginalRepository(journal);
		const target = await runPublicationGit(repo.repoRoot, ["rev-parse", "--verify", journal.intent.targetRef]);
		if (target.code !== 0) {
			current = observation(intent, journal.phase, {
				target: target.code === 128 && !target.error && !target.signal ? "missing" : "unknown",
			});
		} else {
			const sha = target.stdout.trim();
			const exists = await runPublicationGit(repo.repoRoot, ["cat-file", "-e", `${intent.candidateSha}^{commit}`]);
			if (exists.code !== 0 || exists.signal || exists.error) {
				if (journal.phase !== "prepared" || sha !== intent.expectedOld)
					throw new Error("Candidate object is unavailable");
				await checkedGit(repo, ["cat-file", "-e", intent.preparedTree + "^{tree}"]);
				await checkedGit(repo, ["cat-file", "-e", intent.materializedCommit + "^{commit}"]);
			}
			if (sha === intent.candidateSha) {
				current = observation(intent, journal.phase, { target: "candidate", targetSha: sha });
				inferred = receipt(intent, "target_exact", sha);
			} else if (sha === intent.expectedOld)
				current = observation(intent, journal.phase, { target: "expected_old", targetSha: sha });
			else {
				const shallow = await checkedGit(repo, ["rev-parse", "--is-shallow-repository"]);
				if (shallow !== "false") throw new Error("Shallow ancestry is inconclusive");
				const ancestry = await runPublicationGit(repo.repoRoot, [
					"merge-base",
					"--is-ancestor",
					intent.candidateSha,
					sha,
				]);
				if (ancestry.code === 0 && !ancestry.signal && !ancestry.error) {
					current = observation(intent, journal.phase, { target: "descendant", targetSha: sha });
					inferred = receipt(intent, "target_descendant", sha);
				} else if (ancestry.code === 1 && !ancestry.signal && !ancestry.error)
					current = observation(intent, journal.phase, { target: "other", targetSha: sha });
				else throw new Error("Publication ancestry is inconclusive");
			}
		}
		current.retryable =
			!journal.stop &&
			!journal.receipt &&
			!inferred &&
			["prepared", "cas_rejected"].includes(journal.phase) &&
			current.target === "expected_old";
	} catch {
		current = observation(intent, journal.phase, {
			error: "Original publication repository observation is unavailable",
		});
	}
	if (journal.stop?.pastEffect === "not_applied") inferred = undefined;
	if (!journal.receipt && inferred)
		journal = await appendPublicationJournal(params.dataDir, journal, "applied", { receipt: inferred });
	const positive = journal.receipt;
	if (positive && journal.casStarted && !journal.processStopped && !journal.stop) {
		const stop: DevicePublishStop = {
			intentId: intent.id,
			intentDigest: intent.digest,
			candidateSha: intent.candidateSha,
			closed: true,
			stopConfirmed: false,
			pastEffect: "applied",
			fencedAt: Date.now(),
		};
		journal = await appendPublicationJournal(params.dataDir, journal, "closed", { stop });
	}
	return {
		status: positive
			? "applied"
			: journal.stop?.stopConfirmed && journal.stop.pastEffect === "not_applied"
				? "cancelled"
				: "pending",
		...(positive ? { publishReceipt: positive } : {}),
		publishObservation: current,
		...(journal.stop ? { publishStop: journal.stop } : {}),
	};
}
export interface LocalPublicationHooks {
	afterPrepared?: () => Promise<void>;
	afterCandidatePinned?: () => Promise<void>;
	afterCasStarted?: () => Promise<void>;
	afterCasExit?: (result: PublicationGitExit) => Promise<void>;
	afterReceipt?: () => Promise<void>;
}
export function publishLocalIntent(
	params: {
		dataDir: string;
		publishIntent: DevicePublishIntent;
		repository: PublicationRepository;
		mode: "first" | "resume";
		verify: (signal: AbortSignal) => Promise<void>;
	},
	options: { signal?: AbortSignal; hooks?: LocalPublicationHooks } = {},
): Promise<DevicePublicationResult> {
	const intent = validatePublishIntent(params.publishIntent);
	const key = operationKey(params.dataDir, intent);
	return serializePublication(params.dataDir, async () => {
		if (activeChildren.get(key)?.size) throw new PublicationStopUnconfirmedError();
		if (fences.has(key)) return publicationStatusWithinGate(params);
		const existing = await readPublicationJournal(params.dataDir, intent);
		if (existing?.receipt || existing?.stop) return publicationStatusWithinGate(params);
		if (existing && (params.mode !== "resume" || !["prepared", "cas_rejected"].includes(existing.phase)))
			return publicationStatusWithinGate(params);
		if (!existing && params.mode === "resume") return publicationStatusWithinGate(params);
		const controller = new AbortController();
		controllers.set(key, controller);
		const signal = AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : [])]);
		try {
			signal.throwIfAborted();
			let journal = existing ?? (await createPublicationJournal(params.dataDir, intent, params.repository));
			await options.hooks?.afterPrepared?.();
			await verifyOriginalRepository(journal);
			await params.verify(signal);
			signal.throwIfAborted();
			const { raw, candidateSha } = buildPublishCommit(intent);
			const repo = journal.repository!;
			const written = await checkedGit(repo, ["hash-object", "-t", "commit", "-w", "--stdin"], signal, raw, key);
			if (written !== candidateSha) throw new Error("Publication candidate hash mismatch");
			const pin = `refs/pi/publications/${intent.digest}`;
			const existingPin = await runPublicationGit(repo.repoRoot, ["show-ref", "--verify", "--hash", pin], {
				signal,
				key,
			});
			if (existingPin.code === 0) {
				if (existingPin.stdout.trim() !== candidateSha) throw new Error("Publication retention ref identity mismatch");
				const symbolicPin = await runPublicationGit(repo.repoRoot, ["symbolic-ref", "-q", pin], { signal, key });
				if (symbolicPin.code !== 1) throw new Error("Publication retention ref is symbolic or unreadable");
			} else {
				if (existingPin.signal || existingPin.error || ![1, 128].includes(existingPin.code ?? -1))
					throw new Error("Publication retention ref is unreadable");
				await checkedGit(
					repo,
					["update-ref", "--no-deref", pin, candidateSha, "0".repeat(candidateSha.length)],
					signal,
					undefined,
					key,
				);
			}
			await options.hooks?.afterCandidatePinned?.();
			await params.verify(signal);
			signal.throwIfAborted();
			if (fences.has(key)) return publicationStatusWithinGate(params);
			const symbolicTarget = await runPublicationGit(repo.repoRoot, ["symbolic-ref", "-q", intent.targetRef], {
				signal,
				key,
			});
			if (symbolicTarget.code !== 1) throw new Error("Publication target is symbolic or unreadable");
			journal = await appendPublicationJournal(params.dataDir, journal, "cas_started", {
				processEpoch: PUBLICATION_WRITER_EPOCH,
			});
			await options.hooks?.afterCasStarted?.();
			signal.throwIfAborted();
			const exit = await runPublicationGit(
				repo.repoRoot,
				["update-ref", "--no-deref", intent.targetRef, candidateSha, intent.expectedOld],
				{ signal, key },
			);
			await options.hooks?.afterCasExit?.(exit);
			if (exit.code === 0 && !exit.signal && !exit.error) {
				const applied = receipt(intent, "cas_exit", candidateSha);
				journal = await appendPublicationJournal(params.dataDir, journal, "applied", {
					receipt: applied,
					processStopped: true,
				});
				await options.hooks?.afterReceipt?.();
				return { status: "applied", publishReceipt: applied };
			}
			if (
				!exit.signal &&
				!exit.error &&
				[1, 128].includes(exit.code ?? -1) &&
				/cannot lock ref .*is at [a-f0-9]+ but expected [a-f0-9]+/.test(exit.stderr)
			)
				await appendPublicationJournal(params.dataDir, journal, "cas_rejected", { processStopped: true });
			else await appendPublicationJournal(params.dataDir, journal, "cas_started", { processStopped: true });
			return publicationStatusWithinGate(params);
		} finally {
			if (controllers.get(key) === controller) controllers.delete(key);
		}
	});
}
export function cancelLocalPublication(params: {
	dataDir: string;
	publishIntent: DevicePublishIntent;
}): Promise<DevicePublicationResult> {
	const intent = validatePublishIntent(params.publishIntent);
	const key = operationKey(params.dataDir, intent);
	fences.add(key);
	controllers.get(key)?.abort(new Error("Publication cancelled"));
	return serializePublication(params.dataDir, async () => {
		const live = !!activeChildren.get(key)?.size;
		let journal = await readPublicationJournal(params.dataDir, intent);
		if (journal?.stop?.stopConfirmed) return publicationStatusWithinGate(params);
		const observed = await publicationStatusWithinGate(params);
		journal = await readPublicationJournal(params.dataDir, intent);
		const stopConfirmed =
			!live &&
			(!journal?.casStarted || journal.processStopped === true || journal.processEpoch === PUBLICATION_WRITER_EPOCH);
		if (journal?.stop && !stopConfirmed) {
			if (live) throw new PublicationStopUnconfirmedError();
			return { ...observed, cleanupPending: true };
		}
		const stop: DevicePublishStop = {
			intentId: intent.id,
			intentDigest: intent.digest,
			candidateSha: intent.candidateSha,
			closed: true,
			stopConfirmed,
			pastEffect: observed.publishReceipt
				? "applied"
				: !journal || !journal.casStarted || journal.phase === "cas_rejected"
					? "not_applied"
					: "unknown",
			fencedAt: journal?.stop?.fencedAt ?? Date.now(),
			...(stopConfirmed ? { stoppedAt: Date.now() } : {}),
		};
		if (journal)
			await appendPublicationJournal(params.dataDir, journal, "closed", {
				stop,
				...(stopConfirmed ? { processStopped: true } : {}),
			});
		else await createPublicationJournal(params.dataDir, intent, undefined, stop);
		if (live) throw new PublicationStopUnconfirmedError();
		return {
			...observed,
			status: observed.publishReceipt
				? "applied"
				: stopConfirmed && stop.pastEffect === "not_applied"
					? "cancelled"
					: "pending",
			publishStop: stop,
			...(!stopConfirmed ? { cleanupPending: true } : {}),
		};
	});
}
