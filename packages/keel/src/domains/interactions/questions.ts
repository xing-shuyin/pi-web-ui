import type { QuestionResult } from "../../pending-question.js";
import type { QuestionAnswer, ServerMessage, UiQuestion } from "../../protocol.js";
import type { TransportPort } from "../../contracts/ports.js";
import type { InteractionInbox } from "./inbox.js";

export interface AskUserWaiter {
	/** 登记一条 pending 并发一帧 `question_pending`，返回等待结果的 promise（绝不悬挂）。 */
	askUser(questions: UiQuestion[], signal: AbortSignal, conversationId?: string): Promise<QuestionResult>;
	/** 前端回包：`true` = 本次真的结算了这条；重复回包 / 未知 id 一律 `false`。 */
	answer(id: string, answers: QuestionAnswer[], cancelled?: boolean, cancelReason?: string): boolean;
	/** 某会话还在等的提问（给快照投影用），按登记顺序。 */
	pendingForSnapshot(conversationId: string): Array<{ id: string; questions: UiQuestion[] }>;
	/** 会话收尾：本会话的提问全部结算成取消，返回结算条数。 */
	cancelConversation(conversationId: string, reason: string): number;
	/** 全量待答提问（问卷队列 `question_queue` 用）。 */
	list(): Array<{ id: string; conversationId: string; questions: UiQuestion[]; createdAt: number }>;
	/** 过户移出：将属于给定会话集合的 pending 提问移出本 waiter，发送 retraction 帧，返回移出的条目。 */
	transferOut(conversationIds: ReadonlySet<string>): PendingAskTransfer[];
	/** 过户移入：将提问移入本 waiter，向 transport 发送 question_pending 帧。 */
	transferIn(transfers: readonly PendingAskTransfer[]): void;
}

export interface PendingAskTransfer {
	readonly id: string;
	readonly conversationId: string;
	readonly questions: UiQuestion[];
	readonly createdAt: number;
	readonly settle: (result: QuestionResult) => void;
	readonly detachAbort: () => void;
}

type QuestionFrame = Extract<ServerMessage, { type: "question_pending" }>;

interface PendingAsk {
	readonly conversationId: string;
	readonly questions: UiQuestion[];
	readonly createdAt: number;
	readonly settle: (result: QuestionResult) => void;
	/** 撤掉 abort 监听：结算后再来一次 abort 不许再动已结算的条目。 */
	readonly detachAbort: () => void;
}

const TRANSPORT_CLOSED_REASON = "通道已关闭，提问无法送达";
const SEND_FAILED_REASON = "提问帧发送失败";
const ABORTED_REASON = "提问已中止";

/** 取消结果：没给理由就不塞 `reason`（协议里它是可选项，不编空串）。 */
function cancelled(reason?: string): QuestionResult {
	return reason === undefined || reason === "" ? { cancelled: true } : { cancelled: true, reason };
}

function deferred<T>(): { promise: Promise<T>; settle: (value: T) => void } {
	let settle!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		settle = done;
	});
	return { promise, settle };
}

/** `UiQuestion` 列表 → 协议帧：只发本域真有的字段，`owner` / `createdAt` / `deadline` 之类不编。 */
function questionFrame(id: string, questions: UiQuestion[], conversationId: string): QuestionFrame {
	return {
		type: "question_pending",
		id,
		questions,
		...(conversationId === "" ? {} : { conversationId }),
	};
}

export function createAskUserWaiter(input: {
	inbox: InteractionInbox;
	transport: TransportPort;
	/** 缺省 `q-<递增序号>`；注入了就完全用注入的（同一 id 只许登记一次，重复即拒）。 */
	nextId?: () => string;
	onChanged?: () => void;
}): AskUserWaiter {
	const { inbox, transport } = input;
	const pending = new Map<string, PendingAsk>();
	const usedIds = new Set<string>();
	let idSeq = 0;
	let seq = 0;
	const defaultNextId = () => {
		let id: string;
		do {
			id = `q-${++idSeq}`;
		} while (usedIds.has(id));
		usedIds.add(id);
		return id;
	};
	const nextId = input.nextId ?? defaultNextId;

	/**
	 * 结算唯一出口：先摘本域（幂等短路），再撤 abort 监听、结算 promise，最后通知对端与收件箱。
	 * 顺序是有意的——对端通知帧发不出去也不能让等待方悬着，收件箱回调抛错同理。
	 */
	const settleEntry = (id: string, result: QuestionResult): boolean => {
		const entry = pending.get(id);
		if (!entry) return false;
		pending.delete(id);
		entry.detachAbort();
		entry.settle(result);
		if (!transport.isClosed()) {
			try {
				transport.send({ type: "question_retracted", id });
			} catch {
				// 收起对话框只是通知：发不出去由对端下一次快照自愈，不回滚已结算的问答。
			}
		}
		inbox.settle("question", id, result);
		input.onChanged?.();
		return true;
	};

	return {
		async askUser(questions: UiQuestion[], signal: AbortSignal, conversationId?: string): Promise<QuestionResult> {
			if (transport.isClosed()) return cancelled(TRANSPORT_CLOSED_REASON);
			if (signal.aborted) return cancelled(ABORTED_REASON);
			const id = nextId();
			usedIds.add(id);
			const seqMatch = /^q-(\d+)$/.exec(id);
			if (seqMatch) {
				const num = parseInt(seqMatch[1], 10);
				if (Number.isFinite(num) && num > idSeq) idSeq = num;
			}
			// 本域只认会话内的提问：调用方没给会话 id 的按空串登记（帧里也不带这个字段）。
			const owner = conversationId ?? "";
			// 快照与帧共用一份列表：调用方回头改自己的数组不该影响还在等的这条。
			const asked = [...questions];
			const { promise, settle } = deferred<QuestionResult>();
			const nowSeq = ++seq;
			// `createdAt` 只当登记序号用：本域不读时钟，这里只要保住登记顺序。
			if (!inbox.register({ kind: "question", id, conversationId: owner, createdAt: nowSeq })) {
				return cancelled(`提问 id 重复：${id}`);
			}
			const onAbort = () => settleEntry(id, cancelled(ABORTED_REASON));
			signal.addEventListener("abort", onAbort, { once: true });
			pending.set(id, {
				conversationId: owner,
				questions: asked,
				createdAt: nowSeq,
				settle,
				detachAbort: () => signal.removeEventListener("abort", onAbort),
			});
			try {
				transport.send(questionFrame(id, asked, owner));
			} catch {
				settleEntry(id, cancelled(SEND_FAILED_REASON));
			}
			input.onChanged?.();
			return promise;
		},

		answer(id: string, answers: QuestionAnswer[], cancelledFlag?: boolean, cancelReason?: string): boolean {
			return settleEntry(id, cancelledFlag ? cancelled(cancelReason) : answers);
		},

		pendingForSnapshot(conversationId: string): Array<{ id: string; questions: UiQuestion[] }> {
			const out: Array<{ id: string; questions: UiQuestion[] }> = [];
			for (const [id, entry] of pending) {
				if (entry.conversationId === conversationId) out.push({ id, questions: entry.questions });
			}
			return out;
		},

		list(): Array<{ id: string; conversationId: string; questions: UiQuestion[]; createdAt: number }> {
			const out: Array<{ id: string; conversationId: string; questions: UiQuestion[]; createdAt: number }> = [];
			for (const [id, entry] of pending) {
				out.push({ id, conversationId: entry.conversationId, questions: entry.questions, createdAt: entry.createdAt });
			}
			return out;
		},

		cancelConversation(conversationId: string, reason: string): number {
			// 先取快照再结算：结算会从 pending 删项，边迭代边删不可取。
			// 遍历本域 pending（而非 inbox.list）：取消要落到 promise 上，收件箱里被别处摘掉的也得结算。
			const targets: string[] = [];
			for (const [id, entry] of pending) {
				if (entry.conversationId === conversationId) targets.push(id);
			}
			let settled = 0;
			for (const id of targets) {
				if (settleEntry(id, cancelled(reason))) settled++;
			}
			return settled;
		},

		transferOut(conversationIds: ReadonlySet<string>): PendingAskTransfer[] {
			const out: PendingAskTransfer[] = [];
			for (const [id, entry] of pending) {
				if (conversationIds.has(entry.conversationId)) {
					pending.delete(id);
					out.push({
						id,
						conversationId: entry.conversationId,
						questions: entry.questions,
						createdAt: entry.createdAt,
						settle: entry.settle,
						detachAbort: entry.detachAbort,
					});
					if (!transport.isClosed()) {
						try {
							transport.send({ type: "question_retracted", id });
						} catch {}
					}
				}
			}
			if (out.length > 0) input.onChanged?.();
			return out;
		},

		transferIn(transfers: readonly PendingAskTransfer[]): void {
			if (transfers.length === 0) return;
			for (const t of transfers) {
				usedIds.add(t.id);
				const seqMatch = /^q-(\d+)$/.exec(t.id);
				if (seqMatch) {
					const num = parseInt(seqMatch[1], 10);
					if (Number.isFinite(num) && num > idSeq) idSeq = num;
				}
				pending.set(t.id, {
					conversationId: t.conversationId,
					questions: t.questions,
					createdAt: t.createdAt,
					settle: t.settle,
					detachAbort: t.detachAbort,
				});
				inbox.register({ kind: "question", id: t.id, conversationId: t.conversationId, createdAt: t.createdAt });
				if (!transport.isClosed()) {
					try {
						transport.send(questionFrame(t.id, t.questions, t.conversationId));
					} catch {}
				}
			}
			input.onChanged?.();
		},
	};
}
