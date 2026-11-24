import type { ServerMessage, UiMessage, UiState } from "../../protocol.js";

/** 一帧的内容投影：指纹（比相等用）+ 消息身份序列（下一帧的增量基线）。 */
export interface SnapshotFrameContent {
	key: string;
	ids: readonly string[];
}

/**
 * 一帧的内容指纹（老实现 `snapshotContentKey` + 消息 id 序列，issue #965）。
 *
 * 用处只有一个：判断「这一帧和本 sink 上一帧是不是同一份内容」——是就一帧都不发。
 *
 * 口径与 `server/snapshot-channel.ts` 逐字对齐：**除 `messages` 之外的一切**参与序列化
 * （`rev` / `version` 是每帧自增的计数而不是内容，必须剔掉），消息只认 id 序列——
 * 流式期的文字变化由 `streamingMessage` 带出来，不靠逐条消息内容比对。
 *
 * - `snapshot`：ids 取帧里的 `messages`；
 * - `snapshot_delta`：ids = 基线 ids + 这一帧的 `appended`（增量只允许纯追加）；
 * - 其它帧（自定义 builders / 单测的假帧）→ `undefined`：调用方据此退回「按变化出帧」，
 *   绝不因为拿不到指纹就把真实变化吞掉。
 */
export function snapshotFrameContent(
	message: ServerMessage,
	baselineIds: readonly string[] = [],
): SnapshotFrameContent | undefined {
	if (message.type === "snapshot") {
		const state: UiState | undefined = message.state;
		if (!state || typeof state !== "object") return undefined;
		const messages: readonly UiMessage[] = Array.isArray(state.messages) ? state.messages : [];
		const ids = messages.map(idOf);
		return { key: buildKey(state, ids), ids };
	}
	if (message.type === "snapshot_delta") {
		const state = message.state;
		if (!state || typeof state !== "object") return undefined;
		const appended: readonly UiMessage[] = Array.isArray(message.appended) ? message.appended : [];
		const ids = [...baselineIds, ...appended.map(idOf)];
		return { key: buildKey(state, ids), ids };
	}
	return undefined;
}

/** 只要指纹的便捷口（发布器之外的调用方 / 单测）。 */
export function snapshotFrameKey(message: ServerMessage, baselineIds: readonly string[] = []): string | undefined {
	return snapshotFrameContent(message, baselineIds)?.key;
}

/** 消息身份：没有 id 的条目给空串（占位），只要序列稳定就能比相等。 */
function idOf(message: UiMessage | undefined): string {
	return typeof message?.id === "string" ? message.id : "";
}

function buildKey(state: object, ids: readonly string[]): string {
	const { messages: _messages, rev: _rev, version: _version, ...light } = state as Record<string, unknown>;
	return `${JSON.stringify(light)}\u0000${ids.join("\u0001")}`;
}
