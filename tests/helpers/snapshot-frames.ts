import type { ServerMessage, UiState } from "../../server/protocol.js";

/**
 * 把服务端出帧折成一份 `UiState`——**照真客户端的规矩**（`web/src/use-chat.ts` 的 `snapshot` /
 * `snapshot_delta` 两个分支）：
 * - 全量帧整包替换；
 * - 增量帧只在 `baseRev` 对得上本份状态时追加 `appended`，否则算一次失配（真客户端此处会 `get_state`）。
 *
 * 为什么单测需要它：出帧策略是单源（`server/snapshot-channel.ts`），引擎只在「纯追加」时发增量。
 * 断言「界面最终看到什么」就不该只挑全量帧——那测的是帧的形状，不是客户端拿到的状态。
 */
export function applySnapshotFrame(
	prev: UiState | null,
	msg: ServerMessage,
): { state: UiState | null; mismatch: boolean } {
	if (msg.type === "snapshot") return { state: msg.state, mismatch: false };
	if (msg.type !== "snapshot_delta") return { state: prev, mismatch: false };
	if (!prev || prev.conversationId !== msg.conversationId || prev.rev !== msg.baseRev) {
		return { state: prev, mismatch: true };
	}
	return {
		state: { ...prev, ...msg.state, messages: [...prev.messages, ...msg.appended] },
		mismatch: false,
	};
}

/** 折一整串帧，返回客户端此刻该持有的状态。失配时保留旧状态（等下一次全量）。 */
export function foldSnapshotFrames(frames: readonly ServerMessage[]): UiState | null {
	let state: UiState | null = null;
	for (const frame of frames) state = applySnapshotFrame(state, frame).state;
	return state;
}
