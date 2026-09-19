/**
 * 提交信息历史 — SCM 面板提交输入框的 ↑/↓ 回溯。
 *
 * localStorage 存最近用过的提交信息（去重置顶、上限 20 条），纯 UI 偏好；
 * 读写全部 try/catch（隐私模式 / 配额满静默降级为无历史）。循环逻辑单独
 * 抽成纯函数 cycleCommitRecall 便于单测。
 */

export const SCM_COMMIT_HISTORY_KEY = "scm-commit-history";
export const SCM_COMMIT_HISTORY_CAP = 20;

/** 最小化的 Storage 形状（测试可注入内存实现）。 */
export interface KvStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

/** 读历史（最新在前）。坏 JSON / 非字符串数组 → 空列表。 */
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

/** 记住一条提交信息：去空白、空串忽略、去重置顶、截断到上限。返回新列表。 */
export function rememberCommitMessage(msg: string, storage: KvStorage = localStorage): string[] {
	const text = msg.trim();
	if (!text) return loadCommitHistory(storage);
	const next = [text, ...loadCommitHistory(storage).filter((x) => x !== text)].slice(0, SCM_COMMIT_HISTORY_CAP);
	try {
		storage.setItem(SCM_COMMIT_HISTORY_KEY, JSON.stringify(next));
	} catch {
		// 写不进去就只管本次会话
	}
	return next;
}

/** 回溯游标状态：idx = -1 表示在“ live 草稿”（还没开始翻历史）。 */
export interface CommitRecallState {
	idx: number;
	/** 进入回溯前的草稿（↓ 退回 live 时恢复）。 */
	draft: string;
}

export const COMMIT_RECALL_INITIAL: CommitRecallState = { idx: -1, draft: "" };

/**
 * ↑/↓ 翻历史（shell 风格）。返回新的状态与应填入输入框的文本；
 * 无法移动（空历史 / 已到端点）返回 null，调用方保持现状。
 *
 * - ↑：-1 → 0 时把 current 存为草稿；到最旧一条后再按无效。
 * - ↓：从 0 退回 -1 时恢复草稿；-1 时再按无效。
 */
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
	// down
	if (state.idx === -1) return null;
	if (state.idx === 0) return { state: COMMIT_RECALL_INITIAL, text: state.draft };
	return { state: { idx: state.idx - 1, draft: state.draft }, text: entries[state.idx - 1] };
}
