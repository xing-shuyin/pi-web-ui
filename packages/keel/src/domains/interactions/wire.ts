import type { ToolApprovalResolution } from "../../../../../server/tool-approval.js";
import type { ServerMessage, UiApprovalCategory, UiToolApproval } from "../../../../../server/protocol.js";
import type { TransportPort } from "../../contracts/ports.js";
import type { InteractionInbox } from "./inbox.js";

export interface ApprovalRequestInput {
	conversationId: string;
	toolName: string;
	params?: unknown;
	reason?: string;
	category?: string;
}

export interface ApprovalWaiter {
	/** 登记一条 pending 并发一帧 `tool_approval_pending`，返回等待结果的 promise（绝不悬挂）。 */
	request(input: ApprovalRequestInput): Promise<ToolApprovalResolution>;
	/** 前端回包：`true` = 本次真的结算了这条；重复回包 / 未知 id 一律 `false`。 */
	resolve(id: string, decision: "approve" | "deny" | "edit", editedParams?: unknown, reason?: string): boolean;
	/** 某会话还在等的审批（给快照投影用），按登记顺序。 */
	pendingForSnapshot(conversationId: string): UiToolApproval[];
	/** 会话收尾：本会话的审批全部结算成 deny，返回结算条数。 */
	cancelConversation(conversationId: string, reason: string): number;
}

type ApprovalFrame = Extract<ServerMessage, { type: "tool_approval_pending" }>;

interface PendingApproval {
	readonly conversationId: string;
	readonly approval: UiToolApproval;
	readonly settle: (result: ToolApprovalResolution) => void;
}

const TRANSPORT_CLOSED_REASON = "通道已关闭，审批无法送达";
const SEND_FAILED_REASON = "审批帧发送失败";

/**
 * 协议里 `category` 是 `{id,label,labelEn}` 三件套，本域只拿到类目 id（与 `policy.ts` 同口径）：
 * 两处文案用 id 兜底，宁可显示 id，也不悄悄把类目丢掉（丢了「同类全部允许」就没了）。
 */
function approvalCategory(id: string | undefined): UiApprovalCategory | undefined {
	if (!id) return undefined;
	return { id, label: id, labelEn: id };
}

function deferred<T>(): { promise: Promise<T>; settle: (value: T) => void } {
	let settle!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		settle = done;
	});
	return { promise, settle };
}

/** `UiToolApproval` → 协议帧：只投影本域真有的字段，`hits` / `parentTool` / `owner` 之类不编。 */
function approvalFrame(approval: UiToolApproval): ApprovalFrame {
	return {
		type: "tool_approval_pending",
		id: approval.id,
		toolCallId: approval.toolCallId,
		toolName: approval.toolName,
		params: approval.params,
		...(approval.reason === undefined ? {} : { reason: approval.reason }),
		...(approval.category === undefined ? {} : { category: approval.category }),
		conversationId: approval.conversationId,
	};
}

export function createApprovalWaiter(input: {
	inbox: InteractionInbox;
	transport: TransportPort;
	/** 缺省 `appr-<递增序号>`；注入了就完全用注入的（同一 id 只许登记一次，重复即拒）。 */
	nextId?: () => string;
}): ApprovalWaiter {
	const { inbox, transport } = input;
	const pending = new Map<string, PendingApproval>();
	let idSeq = 0;
	let seq = 0;
	const nextId = input.nextId ?? (() => `appr-${++idSeq}`);

	/**
	 * 结算唯一出口：先摘本域（幂等短路），再结算 promise，最后通知对端与收件箱。
	 * 顺序是有意的——对端通知帧发不出去也不能让等待方悬着，收件箱回调抛错同理。
	 */
	const settleEntry = (id: string, result: ToolApprovalResolution): boolean => {
		const entry = pending.get(id);
		if (!entry) return false;
		pending.delete(id);
		entry.settle(result);
		if (!transport.isClosed()) {
			try {
				transport.send({ type: "tool_approval_resolved", id });
			} catch {
				// 收起对话框只是通知：发不出去由对端下一次快照自愈，不回滚已结算的审批。
			}
		}
		inbox.settle("approval", id, result);
		return true;
	};

	return {
		async request(req: ApprovalRequestInput): Promise<ToolApprovalResolution> {
			if (transport.isClosed()) return { decision: "deny", reason: TRANSPORT_CLOSED_REASON };
			const id = nextId();
			const category = approvalCategory(req.category);
			const approval: UiToolApproval = {
				id,
				// 协议必填 `toolCallId`，本域只有审批 id：同一个填上（调用方拿不到 UI 侧的工具调用 id）。
				toolCallId: id,
				toolName: req.toolName,
				params: req.params ?? {},
				...(req.reason === undefined ? {} : { reason: req.reason }),
				...(category === undefined ? {} : { category }),
				conversationId: req.conversationId,
			};
			const { promise, settle } = deferred<ToolApprovalResolution>();
			// `createdAt` 只当登记序号用：本域不读时钟，这里只要保住登记顺序。
			if (!inbox.register({ kind: "approval", id, conversationId: req.conversationId, createdAt: ++seq })) {
				return { decision: "deny", reason: `审批 id 重复：${id}` };
			}
			pending.set(id, { conversationId: req.conversationId, approval, settle });
			try {
				transport.send(approvalFrame(approval));
			} catch {
				settleEntry(id, { decision: "deny", reason: SEND_FAILED_REASON });
			}
			return promise;
		},

		resolve(id: string, decision: "approve" | "deny" | "edit", editedParams?: unknown, reason?: string): boolean {
			return settleEntry(id, {
				decision,
				...(editedParams === undefined ? {} : { editedParams }),
				...(reason === undefined ? {} : { reason }),
			});
		},

		pendingForSnapshot(conversationId: string): UiToolApproval[] {
			const out: UiToolApproval[] = [];
			for (const entry of pending.values()) {
				if (entry.conversationId === conversationId) out.push(entry.approval);
			}
			return out;
		},

		cancelConversation(conversationId: string, reason: string): number {
			let settled = 0;
			// 只碰 approval：问卷 / 页面 / 电话各有自己的取消语义，本域不替它们结算。
			for (const record of inbox.list("approval")) {
				if (record.conversationId !== conversationId) continue;
				if (settleEntry(record.id, { decision: "deny", reason })) settled++;
			}
			return settled;
		},
	};
}
