/**
 * 待答问卷（ask_user_question）的作答草稿暂存管理。
 *
 * 解决切换会话对照代码、误触刷新页面时未作答完毕的多题选项和自定义输入丢失的问题。
 * 存储介质：sessionStorage（页面级隔离）+ 内存 Map 降级备用。
 * 生命周期：提交成功或主动取消时彻底清理；过期时间 24 小时。
 */

export interface QuestionDraft {
	/** 每题选中的选项 label 数组：qid -> labels */
	selections: Record<string, string[]>;
	/** 每题自定义文本：qid -> text */
	customs: Record<string, string>;
	/** 当前所在步骤下标 */
	step: number;
	/** 保存时间戳（ms） */
	updatedAt?: number;
}

const STORAGE_PREFIX = "pi_web_qdraft_";
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000; // 24 小时

/** 内存 Map 降级存储（用于 SSR 或 sessionStorage 不可用/禁用的隐私模式） */
const memoryDrafts = new Map<string, QuestionDraft>();

function storageKey(questionId: string): string {
	return `${STORAGE_PREFIX}${questionId}`;
}

/** 读取暂存草稿；过期或格式损坏则返回 null 并清理。 */
export function loadQuestionDraft(questionId: string): QuestionDraft | null {
	if (!questionId) return null;

	// 1. 尝试从 sessionStorage 读取
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
	} catch {
		/* sessionStorage 访问受限（如 sandbox），继续尝试内存 */
	}

	// 2. 内存回落
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

/** 保存当前问卷的作答草稿。只有实际存在选项或输入时才保存，避免空草稿。 */
export function saveQuestionDraft(questionId: string, draft: Omit<QuestionDraft, "updatedAt">): void {
	if (!questionId) return;

	const hasAnySelection = Object.values(draft.selections).some((arr) => arr && arr.length > 0);
	const hasAnyCustom = Object.values(draft.customs).some((txt) => txt && txt.trim().length > 0);
	const hasProgress = draft.step > 0;

	// 全空无进度则无需落盘
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

	// 1. 保存内存
	memoryDrafts.set(questionId, record);

	// 2. 保存 sessionStorage
	try {
		if (typeof window !== "undefined" && window.sessionStorage) {
			window.sessionStorage.setItem(storageKey(questionId), JSON.stringify(record));
		}
	} catch {
		/* 忽略 QuotaExceededError 或 SecurityError */
	}
}

/** 清理指定问卷草稿（作答完成/取消时调用）。 */
export function clearQuestionDraft(questionId: string): void {
	if (!questionId) return;
	memoryDrafts.delete(questionId);
	try {
		if (typeof window !== "undefined" && window.sessionStorage) {
			window.sessionStorage.removeItem(storageKey(questionId));
		}
	} catch {
		/* 忽略 */
	}
}
