import { createHash } from "node:crypto";
import type { Room } from "./store.js";

/**
 * 历史直聊容器（legacy direct room）——**只为兼容存量数据**而保留。
 *
 * 私聊已经不是「只有一个 Bot 的群」：它是**一条普通对话 + 会话级 Bot 绑定**
 * （`bot-chat.ts` → `Conversation.bot`，语义见 `docs/agent-bot-design.md`）。
 * 因此这里只做两件事：
 *
 * 1. `pruneLegacyDirectRooms`：Hub 载入时把历史 `kind:"direct"` 房间连同其消息/任务清掉；
 * 2. `assertDirectRoom`：万一存量或对端同步进来的数据里还有直聊房间，写入前仍按旧不变量
 *    校验（成员固定 1、无群能力、id 由 account+bot 派生），避免它悄悄退化成群组。
 *
 * **不要在这里新增「建直聊房间」的入口**——私聊入口是 `new_chat { botId }`。
 */

/**
 * 直聊房间 id 前缀。
 *
 * 用 `direct-` 而不是 `direct:`：房间 id 会直接成为 Hub 分区日志的文件名
 * （`server/device-center/partition-log.ts` 只接受 `[A-Za-z0-9_-]`，且 Windows 不允许 `:`）。
 */
export const DIRECT_ROOM_ID_PREFIX = "direct-";

const DIRECT_ROOM_HASH_LENGTH = 24;

export interface DirectRoomViolation {
	code: string;
	message: string;
}

/**
 * 直聊不变量错误。带 HTTP 状态与机器可读 code，Hub 的错误中间件可直接转成 409，
 * 因此 store 层与路由层可以共用同一个失败语义，而不必各自翻译一遍。
 */
export class DirectRoomInvariantError extends Error {
	readonly status = 409;
	readonly code: string;

	constructor(violation: DirectRoomViolation) {
		super(violation.message);
		this.name = "DirectRoomInvariantError";
		this.code = violation.code;
	}
}

/** 直聊房间 id 由 (accountId, botId) 确定性派生：旧版「开始私聊」天然幂等。 */
export function directRoomId(accountId: string, botId: string): string {
	const hash = createHash("sha256").update(`${accountId}\u0000${botId}`).digest("hex");
	return `${DIRECT_ROOM_ID_PREFIX}${hash.slice(0, DIRECT_ROOM_HASH_LENGTH)}`;
}

export function isDirectRoom(room: Pick<Room, "kind"> | null | undefined): boolean {
	return room?.kind === "direct";
}

export function isGroupRoom(room: Pick<Room, "kind"> | null | undefined): boolean {
	return !isDirectRoom(room);
}

/** 任何写入路径都用它断言：返回房间本身，违规则抛 `DirectRoomInvariantError`。 */
export function assertDirectRoom(room: Room): Room {
	const violation = directRoomViolation(room);
	if (violation) throw new DirectRoomInvariantError(violation);
	return room;
}

/**
 * 不变量校验：返回第一处违规。
 * 直聊房间一旦破坏这些条件，就会悄悄退化成群组（广播、黑板、多成员），必须显式拒绝。
 */
export function directRoomViolation(room: Room): DirectRoomViolation | undefined {
	if (!isDirectRoom(room)) return { code: "ROOM_NOT_DIRECT", message: "Room is not a direct chat" };
	if (room.id !== directRoomId(room.accountId, room.botIds[0] ?? ""))
		return { code: "DIRECT_ROOM_ID", message: "Direct room id must be derived from account and Bot" };
	if (room.botIds.length !== 1)
		return { code: "DIRECT_ROOM_MEMBERS", message: "Direct room must have exactly one Bot" };
	if (room.primaryBotId !== room.botIds[0])
		return { code: "DIRECT_ROOM_PRIMARY", message: "Direct room primary Bot must be its only member" };
	if (room.router) return { code: "DIRECT_ROOM_ROUTER", message: "Direct room cannot enable a group router" };
	if (room.blackboard) return { code: "DIRECT_ROOM_BLACKBOARD", message: "Direct room cannot carry a blackboard" };
	if (room.webhooks?.length) return { code: "DIRECT_ROOM_WEBHOOKS", message: "Direct room cannot register webhooks" };
	if (room.canvasBinding) return { code: "DIRECT_ROOM_CANVAS", message: "Direct room cannot bind a canvas" };
	if (room.hubRelayBaseUrl) return { code: "DIRECT_ROOM_RELAY", message: "Direct room cannot relay to another Hub" };
	return undefined;
}

/** 列表投影：群组列表永远不含历史直聊房间。 */
export function groupRoomsOf(rooms: readonly Room[], accountId: string): Room[] {
	return rooms.filter((room) => room.accountId === accountId && isGroupRoom(room));
}

/**
 * 一次性清理历史私聊房间：私聊已经不是「房间」了（= 普通对话 + Bot 绑定），
 * 旧数据里的 `kind:"direct"` 容器必须在载入时丢掉，否则群组列表 / Bot 面板会留下幽灵房间。
 */
export function pruneLegacyDirectRooms(rooms: readonly Room[]): { rooms: Room[]; removedRoomIds: string[] } {
	const removedRoomIds: string[] = [];
	const kept: Room[] = [];
	for (const room of rooms) {
		if (isDirectRoom(room)) removedRoomIds.push(room.id);
		else kept.push(room);
	}
	return { rooms: kept, removedRoomIds };
}
