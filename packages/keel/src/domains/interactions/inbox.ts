import type { ConversationId } from "../../contracts/ids.js";
import type { QuestionResult } from "../../pending-question.js";
import type { ToolApprovalResolution } from "../../tool-approval.js";

export type InteractionKind = "approval" | "question" | "page" | "phone";

/** 页面调用 / 电话调用共用的结算形状（老树两处内联，这里只给一个名字）。 */
export type CallOutcome<T = unknown> = { ok: true; result?: T } | { ok: false; error: string };

export interface InteractionResults {
	approval: ToolApprovalResolution;
	question: QuestionResult;
	page: CallOutcome;
	phone: CallOutcome;
}

/** 四类各给一份取消结果：批量取消不许「摘掉却不结算」，否则调用方的 promise 永远悬着。 */
export type InteractionOutcomes = { [K in InteractionKind]: InteractionResults[K] };

export interface InteractionRecord {
	readonly kind: InteractionKind;
	readonly id: string;
	readonly conversationId: ConversationId;
	readonly createdAt: number;
	readonly payload?: unknown;
}

export interface InteractionRegistration {
	kind: InteractionKind;
	id: string;
	conversationId: ConversationId;
	createdAt: number;
	payload?: unknown;
}

export type InteractionSettleFn = <K extends InteractionKind>(
	kind: K,
	id: string,
	result: InteractionResults[K],
) => void;

/**
 * 四类「等用户 / 等外部响应」的收件箱：审批、问卷、页面调用、电话调用。
 * 这里只有登记与一次性结算：发帧、计时、持久化都在调用方；时间由 `createdAt` 参数传入，本类不读时钟。
 */
export class InteractionInbox {
	private readonly entries = new Map<string, InteractionRecord>();

	constructor(private readonly onSettle: InteractionSettleFn) {}

	/** 同一个 id 只接受一次登记（四类共用一个 id 命名空间），重复登记不动原记录。 */
	register(input: InteractionRegistration): boolean {
		if (this.entries.has(input.id)) return false;
		this.entries.set(input.id, { ...input });
		return true;
	}

	has(id: string): boolean {
		return this.entries.has(id);
	}

	get(id: string): InteractionRecord | undefined {
		return this.entries.get(id);
	}

	list(kind: InteractionKind): InteractionRecord[] {
		const out: InteractionRecord[] = [];
		for (const entry of this.entries.values()) {
			if (entry.kind === kind) out.push(entry);
		}
		return out;
	}

	size(kind: InteractionKind): number {
		let count = 0;
		for (const entry of this.entries.values()) {
			if (entry.kind === kind) count++;
		}
		return count;
	}

	total(): number {
		return this.entries.size;
	}

	/**
	 * 结算一条：先摘除再回调，所以重复结算（含回调抛错后的重试）一律拿到 `false`，回调最多触发一次。
	 * 回调抛出的错误直接向上抛：此时代收件箱状态已一致，吞掉只会让调用方误判成「还在等」。
	 */
	settle<K extends InteractionKind>(kind: K, id: string, result: InteractionResults[K]): boolean {
		const entry = this.entries.get(id);
		if (!entry || entry.kind !== kind) return false;
		this.entries.delete(id);
		this.onSettle(kind, id, result);
		return true;
	}

	/** 取出某类全部登记并清空：只摘除、不结算（还要通知等待方请用 `cancelAll` / `cancelConversation`）。 */
	drain(kind: InteractionKind): InteractionRecord[] {
		const taken: InteractionRecord[] = [];
		// eslint-disable-next-line unicorn/no-useless-spread -- 快照：循环里会从 map 删项（迭代中改集合）
		for (const entry of [...this.entries.values()]) {
			if (entry.kind !== kind) continue;
			this.entries.delete(entry.id);
			taken.push(entry);
		}
		return taken;
	}

	cancelConversation(conversationId: ConversationId, outcomes: InteractionOutcomes): number {
		return this.cancelWhere((entry) => entry.conversationId === conversationId, outcomes);
	}

	cancelAll(outcomes: InteractionOutcomes): number {
		return this.cancelWhere(() => true, outcomes);
	}

	private cancelWhere(match: (entry: InteractionRecord) => boolean, outcomes: InteractionOutcomes): number {
		let settled = 0;
		// 快照迭代：结算回调可能顺手登记/结算别的条目。
		// eslint-disable-next-line unicorn/no-useless-spread -- 同上，循环里会从 map 删项
		for (const entry of [...this.entries.values()]) {
			if (!match(entry)) continue;
			let done = false;
			switch (entry.kind) {
				case "approval":
					done = this.settle("approval", entry.id, outcomes.approval);
					break;
				case "question":
					done = this.settle("question", entry.id, outcomes.question);
					break;
				case "page":
					done = this.settle("page", entry.id, outcomes.page);
					break;
				case "phone":
					done = this.settle("phone", entry.id, outcomes.phone);
					break;
			}
			if (done) settled++;
		}
		return settled;
	}
}
