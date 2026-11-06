const SCM_COMMIT_HISTORY_KEY = "scm-commit-history";
export const SCM_COMMIT_HISTORY_CAP = 20;

export interface KvStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

export function loadCommitHistory(storage: KvStorage = localStorage): string[] {
	try {
		const raw = storage.getItem(SCM_COMMIT_HISTORY_KEY);
		if (!raw) return [];
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((x): x is string => typeof x === "string" && x.length > 0);
	} catch {
		return [];
	}
}

export function rememberCommitMessage(msg: string, storage: KvStorage = localStorage): string[] {
	const text = msg.trim();
	if (!text) return loadCommitHistory(storage);
	const next = [text, ...loadCommitHistory(storage).filter((x) => x !== text)].slice(0, SCM_COMMIT_HISTORY_CAP);
	try {
		storage.setItem(SCM_COMMIT_HISTORY_KEY, JSON.stringify(next));
	} catch {}
	return next;
}

export interface CommitRecallState {
	idx: number;
	draft: string;
}

export const COMMIT_RECALL_INITIAL: CommitRecallState = { idx: -1, draft: "" };

export function cycleCommitRecall(
	entries: string[],
	state: CommitRecallState,
	current: string,
	dir: "up" | "down",
): { state: CommitRecallState; text: string } | null {
	if (entries.length === 0) return null;
	if (dir === "up") {
		if (state.idx >= entries.length - 1) return null;
		if (state.idx === -1) return { state: { idx: 0, draft: current }, text: entries[0] };
		return { state: { idx: state.idx + 1, draft: state.draft }, text: entries[state.idx + 1] };
	}
	if (state.idx === -1) return null;
	if (state.idx === 0) return { state: COMMIT_RECALL_INITIAL, text: state.draft };
	return { state: { idx: state.idx - 1, draft: state.draft }, text: entries[state.idx - 1] };
}
