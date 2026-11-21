import type { UiMessage } from "./types";
import { asBash, asText, asThinking, asToolCall, parseCollabMessage } from "./components/Message";
import type { MessageClusterItem } from "./components/MessageList";

// 安静模式（issue #956）的判定单源：纯函数，不碰 React / DOM / 协议 / 存储。
// 只回答一个问题：哪些消息属于「内部活动」，不该出现在安静视图里。
// 表现成什么样（折叠行 / 零痕迹）由渲染层按 web/src/quiet-mode.ts 的 style 决定。

export interface QuietFoldItem {
	type: "quiet_fold";
	id: string;
	messages: UiMessage[];
}

export type QuietItem = MessageClusterItem | QuietFoldItem;

export interface QuietFoldOptions {
	/** 正在流式输出的消息 id：永不被折叠，否则打字机效果会在首字出现前消失。 */
	streamingId?: string | null;
	/** 额外强制保留的消息 id（例如组件侧已知的最后一条、置顶项）。 */
	keepIds?: ReadonlySet<string>;
}

export interface QuietFoldSummary {
	total: number;
	thinking: number;
	tools: number;
	bash: number;
	collab: number;
	other: number;
}

function textOf(m: UiMessage): string {
	if (!Array.isArray(m.content)) return "";
	for (const b of m.content) {
		const t = asText(b);
		if (t && t.text.trim().length > 0) return t.text;
	}
	return "";
}

/** 与 MessageList 的 hasMeaningfulText 同义：存在非空文本块。 */
export function hasQuietText(m: UiMessage): boolean {
	return textOf(m) !== "";
}

function collabOf(m: UiMessage) {
	if (m.role !== "user") return null;
	const text = textOf(m);
	if (!text) return null;
	return parseCollabMessage(text);
}

/** 子代理完成通知 / 协作信封的「通知」形态：属于编排消息，可折叠。 */
export function isQuietCollabNotice(m: UiMessage): boolean {
	return collabOf(m)?.isNotice === true;
}

/** 协作信封的「正文」形态（请求 / 结果）：是产出，必须保留。 */
export function isQuietCollabBody(m: UiMessage): boolean {
	const c = collabOf(m);
	return !!c && !c.isNotice;
}

function isAssistantLike(m: UiMessage): boolean {
	return m.role === "assistant" || !m.role;
}

/**
 * turn 边界 = 真实用户消息。
 * 子代理的派发/进度/通知在协议里是 role:"user" + 协作信封，绝不能被当成 turn 边界，
 * 否则会把真正的最终回复判成「中间消息」并藏掉。
 */
function isTurnBoundary(m: UiMessage): boolean {
	if (m.customType) return false;
	if (m.role !== "user") return false;
	return !collabOf(m);
}

function turnKeepSet(messages: readonly UiMessage[], opts: QuietFoldOptions): Set<UiMessage> {
	const keep = new Set<UiMessage>();
	let finalIdx = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (isAssistantLike(m) && hasQuietText(m)) {
			finalIdx = i;
			break;
		}
	}
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i];
		if (isQuietCollabNotice(m)) continue; // 子代理完成通知：属于编排消息，可折叠
		if (!isAssistantLike(m)) {
			// 用户消息、自定义卡片（附件 / 插件 / goal 审阅）、协作正文：保留
			keep.add(m);
			continue;
		}
		if (i === finalIdx) keep.add(m);
		if (m.errorMessage) keep.add(m);
		if (opts.streamingId && m.id === opts.streamingId) keep.add(m);
		if (opts.keepIds?.has(m.id)) keep.add(m);
	}
	return keep;
}

function appendTurnQuiet(out: QuietItem[], items: readonly MessageClusterItem[], opts: QuietFoldOptions): void {
	const all: UiMessage[] = [];
	for (const it of items) {
		if (it.type === "single") all.push(it.message);
		else all.push(...it.messages);
	}
	if (all.length === 0) return;
	const keep = turnKeepSet(all, opts);

	let pending: UiMessage[] = [];
	const flushPending = () => {
		if (pending.length === 0) return;
		out.push({ type: "quiet_fold", id: `quiet-${pending[0].id}`, messages: pending });
		pending = [];
	};

	for (const it of items) {
		if (it.type === "single") {
			if (keep.has(it.message)) {
				flushPending();
				out.push(it);
			} else {
				pending.push(it.message);
			}
			continue;
		}
		const keptMsgs = it.messages.filter((m) => keep.has(m));
		pending.push(...it.messages.filter((m) => !keep.has(m)));
		if (keptMsgs.length === 0) continue;
		flushPending();
		out.push(
			keptMsgs.length === it.messages.length
				? it
				: { type: "tool_cluster", id: `quiet-cluster-${keptMsgs[0].id}`, messages: keptMsgs },
		);
	}
	flushPending();
}

/**
 * 把聚类结果折成安静视图：每轮只留最后一条有文本的助手回复（+ 错误消息 / 协作正文 / 自定义卡片 /
 * 流式中的消息），其余压成 quiet_fold 条目，位置在保留内容之前，保证「先折叠行、后最终回复」。
 */
export function foldQuietItems(items: readonly MessageClusterItem[], opts: QuietFoldOptions = {}): QuietItem[] {
	const out: QuietItem[] = [];
	let turn: MessageClusterItem[] = [];

	for (const it of items) {
		if (it.type === "single" && turn.length > 0 && isTurnBoundary(it.message)) {
			appendTurnQuiet(out, turn, opts);
			turn = [];
		}
		turn.push(it);
	}
	appendTurnQuiet(out, turn, opts);
	return out;
}

export function summarizeQuietFold(messages: readonly UiMessage[]): QuietFoldSummary {
	const summary: QuietFoldSummary = { total: messages.length, thinking: 0, tools: 0, bash: 0, collab: 0, other: 0 };
	for (const m of messages) {
		if (isQuietCollabNotice(m)) {
			summary.collab++;
			continue;
		}
		let counted = false;
		for (const b of m.content ?? []) {
			if (asThinking(b)) {
				summary.thinking++;
				counted = true;
			} else if (asToolCall(b)) {
				summary.tools++;
				counted = true;
			} else if (asBash(b)) {
				summary.bash++;
				counted = true;
			}
		}
		if (!counted) summary.other++;
	}
	return summary;
}
