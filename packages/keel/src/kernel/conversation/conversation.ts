import { DEFAULT_CONV_TITLE } from "../../agent-formatters.js";
import type { ClientId, ConversationId, SessionFile } from "../../contracts/ids.js";
import type { UiApprovalPolicyState } from "../../protocol.js";
import { isApprovalPolicyEmpty, type ApprovalPolicy } from "../../tool-approval.js";
import { acceptsTurns, transition } from "./phase.js";
import { ConversationQueues } from "./queues.js";
import type { ConversationKind, ConversationMeta, ConversationPhase } from "./types.js";

export interface ConversationInit {
	id: ConversationId;
	clientId: ClientId;
	cwd: string;
	kind: ConversationKind;
	createdAt: number;
	title?: string;
	parentId?: ConversationId;
	sessionFile?: SessionFile;
}

/**
 * 对话聚合：身份 + 内存相位 + 两条排队。SDK 会话、UI 缓存、终端的持有者不在这里，
 * 它们各自是域；聚合只保证「相位与排队的语义」不被外部随手改写。
 */
export class Conversation {
	readonly meta: ConversationMeta;
	readonly queues = new ConversationQueues();
	private phaseState: ConversationPhase = "idle";
	/** 本对话的审批策略；空策略归一为 `undefined`，判空只认 `isApprovalPolicyEmpty`。 */
	private approvalPolicyState: ApprovalPolicy | undefined;

	constructor(init: ConversationInit) {
		this.meta = {
			id: init.id,
			clientId: init.clientId,
			cwd: init.cwd,
			title: normalizeTitle(init.title),
			kind: init.kind,
			createdAt: init.createdAt,
			lastActiveAt: init.createdAt,
			parentId: init.parentId,
			sessionFile: init.sessionFile,
		};
	}

	get id(): ConversationId {
		return this.meta.id;
	}

	get phase(): ConversationPhase {
		return this.phaseState;
	}

	get acceptsTurns(): boolean {
		return acceptsTurns(this.phaseState);
	}

	beginTurn(now: number): void {
		if (!acceptsTurns(this.phaseState)) throw new ConversationPhaseError(this);
		this.phaseState = transition(this.phaseState, "running");
		this.touch(now);
	}

	endTurn(now: number): void {
		this.phaseState = transition(this.phaseState, "idle");
		this.touch(now);
	}

	/** 退役第一步：立刻不再接新回合（fail-closed），资源释放留给 `finishRetire()`。 */
	retire(): void {
		this.phaseState = transition(this.phaseState, "retiring");
		this.queues.clear();
	}

	finishRetire(): void {
		this.phaseState = transition(this.phaseState, "retired");
	}

	rename(title: string, now?: number): void {
		this.meta.title = normalizeTitle(title);
		if (now !== undefined) this.touch(now);
	}

	touch(now: number): void {
		this.meta.lastActiveAt = now;
	}

	setSessionFile(file: SessionFile | undefined): void {
		if (file) this.meta.sessionFile = file;
		else delete this.meta.sessionFile;
	}

	/** 审批策略唯一所有者在本聚合：读出来的就是内部对象（审批回填类别详情时原地改）。 */
	get approvalPolicy(): ApprovalPolicy | undefined {
		return this.approvalPolicyState;
	}

	set approvalPolicy(next: ApprovalPolicy | undefined) {
		this.approvalPolicyState = isApprovalPolicyEmpty(next) ? undefined : next;
	}

	/**
	 * 合并写入（老实现 `ClientSession.setApprovalPolicy` 的状态部分）：`allowAll` 只在给定时覆盖；
	 * `categories` 给定时把已有项裁剪成这组 id（类别详情只由审批结果回填，不从这里造）。
	 * `conversationId` 归调用方解析，进不来聚合。
	 */
	setApprovalPolicy(partial: { allowAll?: boolean; categories?: readonly string[] }): void {
		const current = this.approvalPolicyState;
		const next: ApprovalPolicy = {
			allowAll: partial.allowAll ?? current?.allowAll ?? false,
			categories: new Map(current?.categories ?? []),
		};
		if (partial.categories) {
			const keep = new Set(partial.categories);
			// eslint-disable-next-line unicorn/no-useless-spread -- 快照：循环里会从 map 删项（迭代中改集合）
			for (const key of [...next.categories.keys()]) if (!keep.has(key)) next.categories.delete(key);
		}
		this.approvalPolicy = next;
	}

	/** 出帧投影：空策略返回 `undefined`，组帧时 `undefined` 不出键（旧帧形状不变）。 */
	approvalPolicyView(): UiApprovalPolicyState | undefined {
		const policy = this.approvalPolicyState;
		if (!policy) return undefined;
		return { conversationId: this.id, allowAll: policy.allowAll, categories: [...policy.categories.values()] };
	}
}

class ConversationPhaseError extends Error {
	constructor(conv: Conversation) {
		super(`conversation ${conv.meta.id} cannot start a turn in phase ${conv.phase}`);
		this.name = "ConversationPhaseError";
	}
}

export function normalizeTitle(title: string | undefined): string {
	const text = (title ?? "").trim();
	return text || DEFAULT_CONV_TITLE;
}
