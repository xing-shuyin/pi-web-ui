export interface QuestionDraft {
	selections: Record<string, string[]>;
	customs: Record<string, string>;
	step: number;
	updatedAt?: number;
}

const STORAGE_PREFIX = "pi_web_qdraft_";
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

const memoryDrafts = new Map<string, QuestionDraft>();

function storageKey(questionId: string): string {
	return `${STORAGE_PREFIX}${questionId}`;
}

export function loadQuestionDraft(questionId: string): QuestionDraft | null {
	if (!questionId) return null;

	try {
		if (typeof window !== "undefined" && window.sessionStorage) {
			const raw = window.sessionStorage.getItem(storageKey(questionId));
			if (raw) {
				const parsed = JSON.parse(raw) as QuestionDraft;
				if (
					parsed &&
					typeof parsed === "object" &&
					parsed.selections &&
					typeof parsed.selections === "object" &&
					parsed.customs &&
					typeof parsed.customs === "object" &&
					typeof parsed.step === "number"
				) {
					if (parsed.updatedAt && Date.now() - parsed.updatedAt > DRAFT_TTL_MS) {
						clearQuestionDraft(questionId);
						return null;
					}
					return parsed;
				}
			}
		}
	} catch {}

	const mem = memoryDrafts.get(questionId);
	if (mem) {
		if (mem.updatedAt && Date.now() - mem.updatedAt > DRAFT_TTL_MS) {
			memoryDrafts.delete(questionId);
			return null;
		}
		return mem;
	}

	return null;
}

export function saveQuestionDraft(questionId: string, draft: Omit<QuestionDraft, "updatedAt">): void {
	if (!questionId) return;

	const hasAnySelection = Object.values(draft.selections).some((arr) => arr && arr.length > 0);
	const hasAnyCustom = Object.values(draft.customs).some((txt) => txt && txt.trim().length > 0);
	const hasProgress = draft.step > 0;

	if (!hasAnySelection && !hasAnyCustom && !hasProgress) {
		clearQuestionDraft(questionId);
		return;
	}

	const record: QuestionDraft = {
		selections: { ...draft.selections },
		customs: { ...draft.customs },
		step: draft.step,
		updatedAt: Date.now(),
	};

	memoryDrafts.set(questionId, record);

	try {
		if (typeof window !== "undefined" && window.sessionStorage) {
			window.sessionStorage.setItem(storageKey(questionId), JSON.stringify(record));
		}
	} catch {}
}

export function clearQuestionDraft(questionId: string): void {
	if (!questionId) return;
	memoryDrafts.delete(questionId);
	try {
		if (typeof window !== "undefined" && window.sessionStorage) {
			window.sessionStorage.removeItem(storageKey(questionId));
		}
	} catch {}
}
