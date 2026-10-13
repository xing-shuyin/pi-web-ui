/**
 * 前端排队/插队消息（steer / followUp）乐观更新与快照对账纯函数。
 *
 * 解决问题：
 * 用户在流式运行期间按 Enter（插队 steer）或点排队（followUp）时，ChatInput 会立即清空输入框。
 * 若等待服务端完整走完 WS 往返 + 附件/视觉桥处理 + 快照下发，期间会出现：
 *   1. 输入框已空、下方排队气泡尚未出现的「消息凭空消失」真空期；
 *   2. 发送瞬间恰逢服务端上一帧在途 `snapshot_delta` 到达，若直接覆盖 `state.queue`，
 *      刚出现的气泡会闪退消失，等下一帧快照才再出现；
 *   3. 点 ✕ / ↩（`queue_remove`）撤回气泡时，若等服务端回包才移除或被在途旧快照覆盖，气泡会迟滞或闪烁。
 *
 * 设计：
 * - 发送流式 `prompt` 时：立即用与服务端同构的 `formatStreamingPrompt` 生成乐观项并追加到 `state.queue`；
 * - 发送 `queue_remove` 时：立即从 `state.queue` 移除对应项；
 * - 收到服务端 `snapshot` / `snapshot_delta` 时：通过基线计数（baselineMatches）精确判定服务端是否已落账，
 *   未落账前保持乐观态不闪烁，落账后无缝交接给服务端权威队列，绝不产生重复气泡。
 */

import type { PromptAttachment } from "../../server/protocol.js";
import { removeQueuedByIndexOrText } from "../../server/queue-utils.js";
import { formatStreamingPrompt, readTextQuote, splitQuotedPrompt } from "../../server/text-quote.js";
import type { UiMessage, UiState } from "./types";

/** 乐观入队项最长保活时间（毫秒）：覆盖大图视觉桥转述等慢速前置阶段，超时自动释放。 */
export const OPTIMISTIC_ADD_TTL_MS = 15_000;
/** 乐观移除项最长保活时间（毫秒）：仅用于抵消在途旧 snapshot_delta 的闪回。 */
export const OPTIMISTIC_REMOVE_TTL_MS = 3_000;

export interface PendingQueueAdd {
	conversationId: string;
	kind: "steer" | "followUp";
	rawText: string;
	formattedText: string;
	/** 发送时刻服务端队列中已存在的同内容项数量（支持连续发送两条相同文字如“继续”）。 */
	baselineQueueMatches: number;
	/** 发送时刻已落盘消息中同内容用户消息数量（若入队后瞬间出队落盘，据此即时消解乐观项）。 */
	baselineUserMsgMatches: number;
	createdAt: number;
}

export interface PendingQueueRemove {
	conversationId: string;
	kind: "steer" | "followUp";
	text: string;
	index?: number;
	/** 移除后本地期望剩余的同内容项数量；服务端队列仍大于此值说明在途快照早于移除动作。 */
	expectedRemainingMatches: number;
	createdAt: number;
}

export interface OptimisticQueueTracker {
	adds: PendingQueueAdd[];
	removes: PendingQueueRemove[];
}

export function createOptimisticQueueTracker(): OptimisticQueueTracker {
	return { adds: [], removes: [] };
}

function escapeXmlAttr(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * 将前端 `PromptAttachment[]` 格式化为与服务端 `formatStreamingPrompt` 同构的排队文本，
 * 使 `<QueuedMessage>` 的 `splitQuotedPrompt` 能立即渲染出文本、引用卡片与附件芯片。
 */
export function formatOptimisticQueuedPrompt(text: string, attachments?: readonly PromptAttachment[]): string {
	const quotes = (attachments ?? [])
		.filter((a) => a.mode === "quote")
		.map((a) => readTextQuote(a.quote))
		.filter((q) => q !== null);
	const imageNames: string[] = [];
	const textAsides: string[] = [];

	for (const att of attachments ?? []) {
		if (att.mode === "quote") continue;
		if (att.imageData) {
			imageNames.push(att.name || "image.png");
			continue;
		}
		if (att.fileData) {
			const name = att.name || "file";
			textAsides.push(`<file path="${escapeXmlAttr(name)}" />`);
			continue;
		}
		if (att.mode === "page") {
			const url = att.path || "";
			const title = att.name || url;
			textAsides.push(`<browser-page url="${escapeXmlAttr(url)}" title="${escapeXmlAttr(title)}"></browser-page>`);
			continue;
		}
		if (att.mode === "conversation") {
			const title = att.name || att.conversationId || att.sessionPath || "conversation";
			textAsides.push(`<conversation-ref title="${escapeXmlAttr(title)}"></conversation-ref>`);
			continue;
		}
		if (att.path) {
			const linesAttr = att.lines ? ` lines="${att.lines.start}-${att.lines.end}"` : "";
			textAsides.push(`<file path="${escapeXmlAttr(att.path)}"${linesAttr} />`);
		}
	}

	return formatStreamingPrompt(text, textAsides, quotes, imageNames);
}

/** 提取排队文本的规范化比较签名（正文 + 引用数 + 附件名集合），兼容服务端视觉桥重写图片为 <vision-bridge>。 */
export function normalizeQueuedPromptKey(value: string): string {
	const parsed = splitQuotedPrompt(value);
	const body = parsed.text.trim();
	const quoteSig = parsed.quotes.map((q) => `${q.role}:${q.messageId}:${q.text.trim()}`).join("|");
	return `${body}\u0000${quoteSig}`;
}

export function isSameQueuedPrompt(a: string, b: string): boolean {
	if (a === b) return true;
	return normalizeQueuedPromptKey(a) === normalizeQueuedPromptKey(b);
}

export function countMatchingInQueue(list: readonly string[], target: string): number {
	let count = 0;
	for (const item of list) {
		if (isSameQueuedPrompt(item, target)) count += 1;
	}
	return count;
}

export function countMatchingUserMessages(messages: readonly UiMessage[], rawText: string): number {
	const norm = rawText.trim();
	let count = 0;
	for (const msg of messages) {
		if (msg.role !== "user") continue;
		const textBlock = msg.content.find((b) => b.type === "text") as { type: "text"; text: string } | undefined;
		const msgText = (textBlock?.text ?? "").trim();
		if (msgText === norm) count += 1;
	}
	return count;
}

/**
 * 判断一条流式期间发出的 `prompt` 是否应当进入前端本地乐观队列。
 * 排除：非流式态、空消息、斜杠命令、审查者自动委派模式（直接转给执行会话，不在本会话排队）、
 * 目标审查回合中的 steer（由服务端顺延到 deferredPrompts 并弹 toast，不进 SDK queue）。
 */
export function shouldOptimisticallyQueuePrompt(opts: {
	state: UiState | null;
	text: string;
	attachments?: readonly PromptAttachment[];
	queue?: boolean;
	goalReviewing?: boolean;
}): boolean {
	const { state, text, attachments, queue = false, goalReviewing = false } = opts;
	if (!state || !state.isStreaming) return false;
	if (state.delegateMode === true) return false;
	const trimmed = (text ?? "").trim();
	const hasAttach = Boolean(attachments && attachments.length > 0);
	if (!trimmed && !hasAttach) return false;
	if (trimmed.startsWith("/")) return false;
	if (goalReviewing && !queue) return false;
	return true;
}

/**
 * 发送流式 `prompt` 时记录乐观入队项，并返回乐观更新后的 `UiState`。
 */
export function recordOptimisticQueueAdd(
	tracker: OptimisticQueueTracker,
	state: UiState | null,
	opts: {
		text: string;
		attachments?: readonly PromptAttachment[];
		queue?: boolean;
		engine?: string;
		goalReviewing?: boolean;
		now?: number;
	},
): { tracker: OptimisticQueueTracker; state: UiState | null } {
	const now = opts.now ?? Date.now();
	if (
		!shouldOptimisticallyQueuePrompt({
			state,
			text: opts.text,
			attachments: opts.attachments,
			queue: opts.queue,
			goalReviewing: opts.goalReviewing,
		}) ||
		!state
	) {
		return { tracker, state };
	}

	const kind: "steer" | "followUp" = opts.queue || opts.engine === "dsh" ? "followUp" : "steer";
	const formattedText = formatOptimisticQueuedPrompt(opts.text, opts.attachments);
	const rawText = splitQuotedPrompt(formattedText).text.trim();
	const currentList = kind === "steer" ? state.queue.steering : state.queue.followUp;

	// 当前显示列表中已包含的匹配数作为基线（扣除尚未被服务端确认的同内容乐观项，得到服务端真实基线）
	const unconfirmedSameCount = tracker.adds.filter(
		(a) =>
			a.conversationId === state.conversationId &&
			a.kind === kind &&
			isSameQueuedPrompt(a.formattedText, formattedText),
	).length;
	const currentTotalMatches = countMatchingInQueue(currentList, formattedText);
	const baselineQueueMatches = Math.max(0, currentTotalMatches - unconfirmedSameCount);
	const baselineUserMsgMatches = countMatchingUserMessages(state.messages, rawText);

	const addEntry: PendingQueueAdd = {
		conversationId: state.conversationId,
		kind,
		rawText,
		formattedText,
		baselineQueueMatches,
		baselineUserMsgMatches,
		createdAt: now,
	};

	const nextQueue =
		kind === "steer"
			? { ...state.queue, steering: [...state.queue.steering, formattedText] }
			: { ...state.queue, followUp: [...state.queue.followUp, formattedText] };

	return {
		tracker: {
			adds: [...tracker.adds, addEntry],
			removes: tracker.removes,
		},
		state: {
			...state,
			queue: nextQueue,
		},
	};
}

/**
 * 发送 `queue_remove`（点 ✕ 或 ↩ 撤回）时立即从前端 `state.queue` 移除，并记录短期防闪回标记。
 */
export function recordOptimisticQueueRemove(
	tracker: OptimisticQueueTracker,
	state: UiState | null,
	opts: {
		kind: "steer" | "followUp";
		text: string;
		index?: number;
		now?: number;
	},
): { tracker: OptimisticQueueTracker; state: UiState | null } {
	if (!state) return { tracker, state };
	const now = opts.now ?? Date.now();
	const { kind, text, index } = opts;
	const currentList = kind === "steer" ? state.queue.steering : state.queue.followUp;
	const nextList = removeQueuedByIndexOrText(currentList, text, index);

	// 若此次移除恰好抵消了一条尚未落账的乐观新增项，直接消掉该新增项
	let nextAdds = tracker.adds;
	const pendingAddIdx = nextAdds.findIndex(
		(a) => a.conversationId === state.conversationId && a.kind === kind && isSameQueuedPrompt(a.formattedText, text),
	);
	if (pendingAddIdx >= 0) {
		nextAdds = [...nextAdds.slice(0, pendingAddIdx), ...nextAdds.slice(pendingAddIdx + 1)];
	}

	const expectedRemainingMatches = countMatchingInQueue(nextList, text);
	const removeEntry: PendingQueueRemove = {
		conversationId: state.conversationId,
		kind,
		text,
		index,
		expectedRemainingMatches,
		createdAt: now,
	};

	const nextQueue = kind === "steer" ? { ...state.queue, steering: nextList } : { ...state.queue, followUp: nextList };

	return {
		tracker: {
			adds: nextAdds,
			removes: [...tracker.removes, removeEntry],
		},
		state: {
			...state,
			queue: nextQueue,
		},
	};
}

/**
 * 收到服务端权威 `snapshot` 或合并后的 `snapshot_delta` 时，与本地乐观队列对账：
 * 1. 流式已结束（`!isStreaming`）：清空当前会话所有乐观项，直接使用服务端队列；
 * 2. 先应用尚未被服务端确认的 `removes`（抑制在途旧快照把刚删掉的气泡闪回）；
 * 3. 再检查 `adds`：若服务端 `queue` 或 `messages` 的匹配数已超越发送时基线，说明服务端已确认，
 *    自动移除乐观项；否则保留并追加到 `state.queue` 末尾，确保前置阶段气泡稳定不消失。
 */
export function reconcileOptimisticQueue(
	tracker: OptimisticQueueTracker,
	incomingState: UiState,
	now = Date.now(),
): { tracker: OptimisticQueueTracker; state: UiState } {
	if (tracker.adds.length === 0 && tracker.removes.length === 0) {
		return { tracker, state: incomingState };
	}

	const convId = incomingState.conversationId;
	if (!incomingState.isStreaming) {
		const keptAdds = tracker.adds.filter(
			(a) => a.conversationId !== convId && now - a.createdAt < OPTIMISTIC_ADD_TTL_MS,
		);
		const keptRemoves = tracker.removes.filter(
			(r) => r.conversationId !== convId && now - r.createdAt < OPTIMISTIC_REMOVE_TTL_MS,
		);
		if (keptAdds.length === tracker.adds.length && keptRemoves.length === tracker.removes.length) {
			return { tracker, state: incomingState };
		}
		return {
			tracker: { adds: keptAdds, removes: keptRemoves },
			state: incomingState,
		};
	}

	let steering = [...incomingState.queue.steering];
	let followUp = [...incomingState.queue.followUp];
	let queueMutated = false;

	// 1. 对账 removes
	const nextRemoves: PendingQueueRemove[] = [];
	for (const rem of tracker.removes) {
		if (now - rem.createdAt >= OPTIMISTIC_REMOVE_TTL_MS) continue;
		if (rem.conversationId !== convId) {
			nextRemoves.push(rem);
			continue;
		}
		const targetList = rem.kind === "steer" ? steering : followUp;
		const serverMatches = countMatchingInQueue(targetList, rem.text);
		if (serverMatches > rem.expectedRemainingMatches) {
			// 服务端快照仍带这条已被用户删除的项（在途旧快照）→ 本地继续过滤掉它
			let stripped = removeQueuedByIndexOrText(targetList, rem.text, rem.index);
			if (stripped.length === targetList.length) {
				const fallbackIdx = targetList.findIndex((item) => isSameQueuedPrompt(item, rem.text));
				if (fallbackIdx >= 0) {
					stripped = [...targetList.slice(0, fallbackIdx), ...targetList.slice(fallbackIdx + 1)];
				}
			}
			if (rem.kind === "steer") steering = stripped;
			else followUp = stripped;
			queueMutated = true;
			nextRemoves.push(rem);
		}
		// 若 serverMatches <= rem.expectedRemainingMatches，说明服务端已确认删除，直接丢弃该 remove 追踪项
	}

	// 2. 对账 adds（同内容多条乐观项按顺序逐条核销）
	const nextAdds: PendingQueueAdd[] = [];
	// 记录已经被前序乐观项“认领”的额外服务端匹配数，支持连续多条同文乐观项逐一落账
	const claimedServerExtras = new Map<string, number>();

	for (const add of tracker.adds) {
		if (now - add.createdAt >= OPTIMISTIC_ADD_TTL_MS) continue;
		if (add.conversationId !== convId) {
			nextAdds.push(add);
			continue;
		}
		const targetList = add.kind === "steer" ? steering : followUp;
		const key = `${add.kind}:${normalizeQueuedPromptKey(add.formattedText)}`;
		const claimed = claimedServerExtras.get(key) ?? 0;

		const serverQueueMatches = countMatchingInQueue(targetList, add.formattedText);
		const serverUserMsgMatches = countMatchingUserMessages(incomingState.messages, add.rawText);

		const confirmedInQueue = serverQueueMatches > add.baselineQueueMatches + claimed;
		const confirmedInMessages = serverUserMsgMatches > add.baselineUserMsgMatches;

		if (confirmedInQueue) {
			claimedServerExtras.set(key, claimed + 1);
			continue;
		}
		if (confirmedInMessages) {
			continue;
		}

		// 服务端尚未落账（在途旧快照或服务端仍在处理附件/视觉桥）→ 保持乐观气泡在列尾
		if (add.kind === "steer") {
			steering.push(add.formattedText);
		} else {
			followUp.push(add.formattedText);
		}
		claimedServerExtras.set(key, claimed + 1);
		queueMutated = true;
		nextAdds.push(add);
	}

	const nextTracker =
		nextAdds.length === tracker.adds.length && nextRemoves.length === tracker.removes.length
			? tracker
			: { adds: nextAdds, removes: nextRemoves };

	if (!queueMutated) {
		return { tracker: nextTracker, state: incomingState };
	}

	return {
		tracker: nextTracker,
		state: {
			...incomingState,
			queue: { steering, followUp },
		},
	};
}

/**
 * 当服务端返回 error / warning 级别通知（如流式期间消息被拒绝、会话已中止等）时，
 * 立即撤销当前会话尚未被服务端确认的乐观入队项，防止被拒消息在界面上残留。
 */
export function rollbackUnconfirmedOptimisticAdds(
	tracker: OptimisticQueueTracker,
	state: UiState | null,
): { tracker: OptimisticQueueTracker; state: UiState | null } {
	if (!state || tracker.adds.length === 0) return { tracker, state };
	const convId = state.conversationId;
	const toRollback = tracker.adds.filter((a) => a.conversationId === convId);
	if (toRollback.length === 0) return { tracker, state };

	let steering = [...state.queue.steering];
	let followUp = [...state.queue.followUp];
	for (const item of toRollback) {
		if (item.kind === "steer") {
			steering = removeQueuedByIndexOrText(steering, item.formattedText);
		} else {
			followUp = removeQueuedByIndexOrText(followUp, item.formattedText);
		}
	}

	return {
		tracker: {
			adds: tracker.adds.filter((a) => a.conversationId !== convId),
			removes: tracker.removes,
		},
		state: {
			...state,
			queue: { steering, followUp },
		},
	};
}
