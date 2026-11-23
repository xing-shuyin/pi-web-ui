/**
 * 单 sink 出帧策略单源（issue #965）。
 *
 * 一条不变式：**一个 sink 只会收到它还不持有的内容**。
 *
 * - 内容键（除 messages 外的字段 + 消息 id 序列）与本 sink 上一帧相同 → 这一帧不发；
 * - 与本 sink 上一帧构成「纯追加」→ `snapshot_delta`，`baseRev` 取**本 sink** 上一帧的 rev；
 * - 其余（换会话 / 非前缀变化 / 新 sink / 客户端明确要全量）→ `snapshot` 全量。
 *
 * 基线为什么必须是「每 sink 一份」：`emit()` 是多 sink 扇出（多 tab、多设备、共享 viewer），
 * 各连接进度不同。共用一份会话级基线时落后方必然 `baseRev` 失配 → 客户端 `get_state`
 * → 再发一次全量，于是同一份内容被连发多遍（首屏 4 帧 356KB 全量的来源）。
 *
 * 交付回执：`push()` 只有在 `deliver()` 没有返回 `false` 时才提交基线。被背压或视图切换
 * 丢掉的帧不会被误记成「已送达」，下一个 flush 会补一帧全量。
 */
import type { ServerMessage, UiMessage, UiState } from "./protocol.js";

/** 除 messages 之外的状态（与 `snapshot_delta.state` 同形）。 */
export type SnapshotLight = Omit<UiState, "messages" | "rev"> & { rev: number };

/** 一帧的输入：内容只在生产者那里算一次，sink 只判定「发不发 / 发哪种」。 */
export interface SnapshotProduct {
	conversationId: string;
	rev: number;
	/** `snapshotContentKey(light)` 的结果。 */
	contentKey: string;
	/** 增量帧携带的 state（不含 messages）。 */
	light: SnapshotLight;
	/** 只有全量帧才带的字段（如 draft 回显）；惰性求值，且不参与内容键。 */
	fullExtras?: () => Omit<Partial<UiState>, "messages" | "rev">;
	messages: UiMessage[];
	/** 与 `messages` 逐条对齐的消息 id（顺序敏感：前缀判定与 `appended` 切片都用它）。 */
	ids: readonly string[];
}

/** `deliver` 的返回值：`false` = 这一帧被丢弃（背压 / 视图过滤），基线不提交。 */
export type SnapshotDeliver = (message: ServerMessage) => boolean | void;

export type SnapshotFrameKind = "skipped" | "delta" | "full" | "dropped";

interface SnapshotBaseline {
	conversationId: string;
	rev: number;
	contentKey: string;
	ids: readonly string[];
}

/**
 * 内容键：把「除 messages 外的所有字段」序列化。
 *
 * `rev` / `version` 是每帧自增的计数而不是内容，必须剔掉——否则任何比较恒不相等，
 * 整条「未变不发」的闸就会失效。
 */
export function snapshotContentKey(light: SnapshotLight): string {
	const { rev: _rev, version: _version, ...rest } = light;
	return JSON.stringify(rest);
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

function isPrefix(shorter: readonly string[], longer: readonly string[]): boolean {
	if (shorter.length > longer.length) return false;
	for (let i = 0; i < shorter.length; i++) if (shorter[i] !== longer[i]) return false;
	return true;
}

export class SnapshotChannel {
	private baseline: SnapshotBaseline | null = null;

	/** 这个 sink 当前持有的会话与 rev（诊断 / 单测用）。 */
	get current(): { conversationId: string; rev: number } | null {
		return this.baseline ? { conversationId: this.baseline.conversationId, rev: this.baseline.rev } : null;
	}

	/**
	 * 给这个 sink 出一帧。
	 *
	 * `since`：客户端声明「我手上是 rev=since 那份」。命中本 sink 基线且纯追加时回增量，
	 * 否则回全量——**不信任客户端的 `since`**（对不上就重发全量，永不乱发增量）。
	 * `force`：连「内容没变」也要回（客户端明确表示自己没有状态）。
	 */
	push(
		product: SnapshotProduct,
		deliver: SnapshotDeliver,
		options: { force?: boolean; since?: number } = {},
	): SnapshotFrameKind {
		const prev = this.baseline;
		const sameConversation = prev?.conversationId === product.conversationId;
		const unchanged = sameConversation && prev.contentKey === product.contentKey && sameIds(prev.ids, product.ids);
		const sinceUsable =
			sameConversation &&
			(options.since === undefined || options.since === prev.rev) &&
			isPrefix(prev.ids, product.ids);
		const wantsFull = options.force === true || !sinceUsable;

		if (unchanged && !wantsFull) return "skipped";

		const kind: "delta" | "full" = wantsFull ? "full" : "delta";
		const message: ServerMessage =
			kind === "full"
				? {
						type: "snapshot",
						state: { ...product.light, ...product.fullExtras?.(), messages: product.messages },
					}
				: {
						type: "snapshot_delta",
						conversationId: product.conversationId,
						rev: product.rev,
						baseRev: (prev as SnapshotBaseline).rev,
						appended: product.messages.slice((prev as SnapshotBaseline).ids.length),
						state: product.light,
					};

		const outcome = deliver(message);
		if (outcome === false) return "dropped";
		this.baseline = {
			conversationId: product.conversationId,
			rev: product.rev,
			contentKey: product.contentKey,
			ids: product.ids,
		};
		return kind;
	}

	/** 丢掉基线（下次一定是全量）。客户端视图被外部重置时用。 */
	reset(): void {
		this.baseline = null;
	}
}
