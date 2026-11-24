/**
 * 引擎侧出帧扇出叶子：把「一个 sink 集合」接到 `snapshot-channel` 的闸上。
 *
 * 为什么需要这一层：`SnapshotChannel` 的基线是**每 sink 一份**，而 dsh / universal 的 sink 是
 * 一个 `Set<(msg) => void>` 扇出（多 tab、多设备）。两边各自持有 `Map<sink, SnapshotChannel>`
 * 就等于又抄了一份「谁该发什么」的知识——本文件是那件事的唯一落点，引擎只产 `SnapshotProduct`。
 *
 * 为什么基线不能跨引擎/跨服务共用：同一个 `send` 函数在引擎热切换时会被**复用**
 * （`server/index.ts` 先 `detach(id, send)` 再给新引擎 `attach(id, send)`）。所以闸只许按
 * **服务实例**持有（一个 `SnapshotSinkSet` 实例一份 `WeakMap`），绝不能挂到模块级按 sink 索引的表上：
 * 否则新引擎第一帧会拿老引擎的 `baseRev` 去发增量，客户端必然丢帧重取。
 *
 * 本文件不做任何判定：不发 / 发全量 / 发增量全由 `SnapshotChannel.push()` 决定。
 */
import { SnapshotChannel, snapshotContentKey, type SnapshotLight, type SnapshotProduct } from "./snapshot-channel.js";
import type { ServerMessage, UiMessage } from "./protocol.js";

/** 一个 sink：一条 WS 连接、一个共享 viewer。 */
export type SnapshotSink = (message: ServerMessage) => void | boolean;

/**
 * 由「light 状态 + 消息」拼出一帧的输入。
 *
 * `conversationId` / `rev` 从 `light` 取（`UiState` 自带），内容键只在这一处算——
 * 两个引擎各写一遍 `contentKey` / `ids` 就又长出两份口径了。
 */
export function buildSnapshotProduct(light: SnapshotLight, messages: UiMessage[]): SnapshotProduct {
	return {
		conversationId: light.conversationId,
		rev: light.rev,
		contentKey: snapshotContentKey(light),
		light,
		messages,
		ids: messages.map((message) => message.id),
	};
}

/**
 * 一个服务实例的 sink 集合。**不是**单例：见文件头的「基线不能跨引擎共用」。
 *
 * `sinks` 传取 live 集合的回调（服务自己的 `Set`），所以 attach / detach 不必通知这里：
 * 卸掉的 sink 只是从 `WeakMap` 的遍历里消失，不留下需要清理的基线。
 */
export class SnapshotSinkSet {
	private readonly channels = new WeakMap<SnapshotSink, SnapshotChannel>();

	constructor(private readonly sinks: () => Iterable<SnapshotSink>) {}

	/** 给每个 sink 各出一帧：发不发、全量还是增量，全由闸判。 */
	push(product: SnapshotProduct, options: { force?: boolean } = {}): void {
		// 扇出期间 sink 可能卸掉（`emit` 的老约定），先取快照。
		// eslint-disable-next-line unicorn/no-useless-spread -- snapshot: handlers may unsubscribe mid-emit
		for (const sink of [...this.sinks()]) {
			this.channelFor(sink).push(product, (message) => deliverTo(sink, message), options);
		}
	}

	/**
	 * 只给一个 sink 出帧：`get_state` 是 per-connection 的，按它自报的 `since` 判增量。
	 * 返回 `null` = 这个 sink 不归本服务（调用方自行退化）。
	 */
	pushTo(
		sink: SnapshotSink,
		product: SnapshotProduct,
		options: { force?: boolean; since?: number } = {},
	): ReturnType<SnapshotChannel["push"]> | null {
		const channel = this.channels.get(sink);
		if (!channel) return null;
		return channel.push(product, (message) => deliverTo(sink, message), options);
	}

	private channelFor(sink: SnapshotSink): SnapshotChannel {
		let channel = this.channels.get(sink);
		if (!channel) {
			channel = new SnapshotChannel();
			this.channels.set(sink, channel);
		}
		return channel;
	}
}

/**
 * 一个 sink 抛错不该连坐其它 sink（老 `send()` 的 try/catch 语义）。
 * 抛错按「没送到」记账：闸不提交基线，下一帧自动补全量。
 */
function deliverTo(sink: SnapshotSink, message: ServerMessage): boolean {
	try {
		return sink(message) !== false;
	} catch {
		return false;
	}
}
