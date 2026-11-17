import { buildContextRecoveryBlock, stripRecoveryBlocks } from "./context-recovery.js";

export const COMPACTION_RETENTION_INSTRUCTIONS = `Preserve the SDK's default structured checkpoint format. Within its existing sections, always retain the following categories when present; mark missing information as unknown rather than inventing it:
- Goal: the active user goal, scope, and completion criteria.
- Constraints & Preferences: explicit user requirements, prohibitions, permissions, and corrections that still apply.
- Critical Context: verified facts and their evidence (observed outputs, exact paths, symbols, errors, and relevant references). Label hypotheses, inferences, and unverified claims explicitly; never promote them to facts.
- Progress / Done and In Progress: actual changes, affected files, decisions and rationale, and what remains incomplete. Distinguish proposed work from applied changes.
- Progress / Critical Context: validation commands, observed results, failures, and checks not run; never infer success from a proposed command or an absent error.
- Blocked / Next Steps: unresolved questions, blockers, and concrete next actions needed to continue.
Do not copy host-generated blocks into the checkpoint: the <context-recovery> block and the [Context evidence: …] index are re-issued from the session on every compaction, so a copy only adds stale text.
Preserve all context-evidence:<sha256> references verbatim, including references in earlier summaries, with their associated claim and verification status. A reference alone does not prove a claim; do not invent, rewrite, or expand its contents.
Treat any supplied summary as candidate notes to verify against the conversation, not as authoritative evidence. Condense redundant exploration without dropping the retained categories or still-applicable user constraints.`;

export function appendCompactionInstructions(instructions?: string): string {
	if (instructions?.includes(COMPACTION_RETENTION_INSTRUCTIONS)) return instructions;
	return instructions ? `${instructions}\n\n${COMPACTION_RETENTION_INSTRUCTIONS}` : COMPACTION_RETENTION_INSTRUCTIONS;
}

export interface CompactionInstructionsOptions {
	getEvidenceIndex?: () => Promise<string>;
	/**
	 * Context checkpoint the model wrote in-context through `compact_context`.
	 * Consumed once per compaction: returning a non-empty string skips the
	 * summarization request entirely.
	 */
	takeProvidedSummary?: () => string | undefined;
}

/** `details` half of the SDK compaction result: which files the folded history touched. */
interface CompactionFileDetails {
	readFiles: string[];
	modifiedFiles: string[];
}

interface ProvidedPreparation {
	firstKeptEntryId?: unknown;
	tokensBefore?: unknown;
	fileOps?: {
		read?: Iterable<string>;
		written?: Iterable<string>;
		edited?: Iterable<string>;
	} | null;
}

/**
 * Mirror of the SDK's private `computeFileLists`: a file both read and modified
 * counts as modified only.
 */
export function compactionFileDetails(fileOps: ProvidedPreparation["fileOps"]): CompactionFileDetails {
	const modified = new Set<string>([...(fileOps?.edited ?? []), ...(fileOps?.written ?? [])]);
	const readFiles = [...(fileOps?.read ?? [])].filter((f) => !modified.has(f)).sort();
	return { readFiles, modifiedFiles: [...modified].sort() };
}

/** Mirror of the SDK's private `formatFileOperations` trailer. */
export function formatFileDetails(details: CompactionFileDetails): string {
	const sections: string[] = [];
	if (details.readFiles.length > 0) sections.push(`<read-files>\n${details.readFiles.join("\n")}\n</read-files>`);
	if (details.modifiedFiles.length > 0)
		sections.push(`<modified-files>\n${details.modifiedFiles.join("\n")}\n</modified-files>`);
	return sections.length === 0 ? "" : `\n\n${sections.join("\n\n")}`;
}

/**
 * Build the compaction result the SDK would have produced from a model-written
 * checkpoint. Boundary (`firstKeptEntryId`) and size (`tokensBefore`) come from
 * the SDK's own preparation, so the kept-tail policy stays the SDK's.
 */
export function buildProvidedCompaction(
	preparation: unknown,
	summary: string,
): { summary: string; firstKeptEntryId: string; tokensBefore: number; details: CompactionFileDetails } {
	const prep = (preparation ?? {}) as ProvidedPreparation;
	const firstKeptEntryId = prep.firstKeptEntryId;
	if (typeof firstKeptEntryId !== "string" || !firstKeptEntryId) {
		throw new Error("Provided compaction has no kept-entry boundary; session may need migration");
	}
	const details = compactionFileDetails(prep.fileOps);
	return {
		summary: `${summary}${formatFileDetails(details)}`,
		firstKeptEntryId,
		tokensBefore: typeof prep.tokensBefore === "number" && Number.isFinite(prep.tokensBefore) ? prep.tokensBefore : 0,
		details,
	};
}

const installedWrappers = new WeakSet<Function>();

export function installCompactionInstructions(session: unknown, options?: CompactionInstructionsOptions): boolean {
	if (!session || typeof session !== "object") return false;
	try {
		let owner: object | null = session;
		let descriptor: PropertyDescriptor | undefined;
		while (owner && !descriptor) {
			descriptor = Object.getOwnPropertyDescriptor(owner, "_runDefaultCompaction");
			if (!descriptor) owner = Object.getPrototypeOf(owner);
		}
		const original = descriptor?.value;
		if (typeof original !== "function") return false;
		if (installedWrappers.has(original)) return true;
		if (original.length !== 5) return false;
		const getEvidenceIndex = options?.getEvidenceIndex;
		const takeProvidedSummary = options?.takeProvidedSummary;
		const manager = (session as { sessionManager?: { getSessionFile?: unknown } }).sessionManager;
		/** Recovery needs a persisted transcript to point at. */
		const canRecover = typeof manager?.getSessionFile === "function";

		/**
		 * Host-generated enrichment: evidence handles plus the recovery index that makes
		 * folded turns addressable again. An index failure still rejects (evidence must
		 * not vanish silently); a missing recovery index just leaves the summary alone.
		 * With neither source installed the SDK result is returned untouched.
		 */
		const withEnrichment = (result: unknown): unknown | Promise<unknown> => {
			if (!getEvidenceIndex && !canRecover) return result;
			return Promise.resolve(result).then(async (compaction: unknown) => {
				if (!compaction || typeof compaction !== "object" || !("summary" in compaction)) return compaction;
				if (typeof compaction.summary !== "string") return compaction;
				const [index, recovery] = await Promise.all([
					getEvidenceIndex ? getEvidenceIndex() : Promise.resolve(""),
					canRecover ? buildContextRecoveryBlock(session, compaction) : Promise.resolve(""),
				]);
				const parts = [index.trim(), recovery.trim()].filter(Boolean);
				if (!parts.length) return compaction;
				const base = recovery.trim() ? stripRecoveryBlocks(compaction.summary) : compaction.summary;
				return { ...compaction, summary: `${base}\n\n${parts.join("\n\n")}` };
			});
		};

		function wrapped(
			this: unknown,
			preparation: unknown,
			model: unknown,
			instructions: unknown,
			signal: unknown,
			reason: unknown,
			...rest: unknown[]
		) {
			// Model-written checkpoint: no summarization request, the SDK keeps the rest
			// of the pipeline (events, projection refresh, appendCompaction).
			const provided = takeProvidedSummary?.();
			if (typeof provided === "string" && provided.trim()) {
				const summary = provided.trim();
				return Promise.resolve().then(() => withEnrichment(buildProvidedCompaction(preparation, summary)));
			}
			const result = original.call(
				this,
				preparation,
				model,
				typeof instructions === "string" || instructions === undefined
					? appendCompactionInstructions(instructions)
					: instructions,
				signal,
				reason,
				...rest,
			);
			return withEnrichment(result);
		}
		Object.defineProperty(session, "_runDefaultCompaction", {
			...(owner === session ? descriptor : { configurable: true, writable: true, enumerable: false }),
			value: wrapped,
		});
		installedWrappers.add(wrapped);
		return true;
	} catch {
		return false;
	}
}
