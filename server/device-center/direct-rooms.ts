import { createHash } from "node:crypto";
import type { Room } from "./store.js";

/**
 * 直聊容器（direct room）单源。
 *
 * 设计：私聊不是新系统，而是"只有一个 Bot 的群"——沿用既有的
 * 消息 → 任务 → 租约 → 执行 → 交付/评审 → 恢复 全链路，只额外锁定三件事：
 *
 * 1. 成员固定：`botIds` 恒为 1 个，且就是 `primaryBotId`（复用既有"主 Bot 私聊"路径）；
 * 2. 无群能力：router / blackboard / webhooks / canvas / hub-relay 一律不存在；
 * 3. 不可见：`GET /api/rooms`（群组列表）不返回直聊房间，改由 `GET /api/direct-rooms` 提供。
 *
 * id 由 (accountId, botId) 确定性派生：重复"开始私聊"天然幂等，不会长出两个房间。
 */

/**
 * 直聊房间 id 前缀。
 *
 * 用 `direct-` 而不是 `direct:`：房间 id 会直接成为 Hub 分区日志的文件名
 * （`server/device-center/partition-log.ts` 只接受 `[A-Za-z0-9_-]`，且 Windows 不允许 `:`），
 * 带冒号的 id 会让直聊的消息/任务**写不进分区日志**，重启后丢失。
 */
export const DIRECT_ROOM_ID_PREFIX = "direct-";

const DIRECT_ROOM_HASH_LENGTH = 24;

/** 直聊房间支持的能力（与群组区分，供 UI 与守卫共用）。 */
export const DIRECT_ROOM_CAPABILITIES = ["message", "task", "conversation", "history", "stop", "attention"] as const;

/**
 * 只对 kind==="group" 生效的端点路径单源。
 * 与 `directRoomViolation` 里禁止的字段一一对应：黑板 / Webhook / 画布 / 中继 / 路由。
 * 路由守卫不再自己写正则，新增群能力时只改这里。
 */
export const GROUP_ONLY_ROOM_PATHS = ["blackboard", "webhooks", "canvas", "hub-relay", "router"] as const;

export function isGroupOnlyRoomPath(path: string): boolean {
	// incoming webhook 挂在 /webhooks 下，但它自带 token 认证、没有账号 Cookie：
	// 不归「需要账号登录的群能力」这一类，否则守卫会在路由验签之前就把它拒成 401。
	if (path.startsWith("/webhooks/incoming/")) return false;
	return GROUP_ONLY_ROOM_PATHS.some((name) => path === `/${name}` || path.startsWith(`/${name}/`));
}

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

/** 任何写入路径都用它断言：返回房间本身，违规则抛 `DirectRoomInvariantError`。 */
export function assertDirectRoom(room: Room): Room {
	const violation = directRoomViolation(room);
	if (violation) throw new DirectRoomInvariantError(violation);
	return room;
}

export function directRoomId(accountId: string, botId: string): string {
	return (
		DIRECT_ROOM_ID_PREFIX +
		createHash("sha256").update(`${accountId}\u0000${botId}`).digest("hex").slice(0, DIRECT_ROOM_HASH_LENGTH)
	);
}

export function isDirectRoomId(roomId: string): boolean {
	return roomId.startsWith(DIRECT_ROOM_ID_PREFIX);
}

export function isDirectRoom(room: Pick<Room, "kind"> | null | undefined): boolean {
	return room?.kind === "direct";
}

/** 群组语义（列表、成员、路由、黑板、Webhook、画布）只对 kind==="group" 生效。 */
export function isGroupRoom(room: Pick<Room, "kind"> | null | undefined): boolean {
	return !isDirectRoom(room);
}

export function directRoomOf(rooms: readonly Room[], accountId: string, botId: string): Room | undefined {
	const id = directRoomId(accountId, botId);
	return rooms.find((room) => room.id === id && room.accountId === accountId);
}

export function buildDirectRoom(input: { accountId: string; botId: string; botName: string; now?: number }): Room {
	const botName = input.botName.trim();
	if (!input.accountId || !input.botId || !botName)
		throw new Error("Direct room requires an account, a Bot and its name");
	return {
		id: directRoomId(input.accountId, input.botId),
		accountId: input.accountId,
		name: botName.slice(0, 128),
		kind: "direct",
		botIds: [input.botId],
		// 主 Bot 让既有"无 targetBotIds 时投递给主 Bot"的路径直接生效，无需为直聊另写分发逻辑。
		primaryBotId: input.botId,
		createdAt: input.now ?? Date.now(),
	};
}

/**
 * 幂等创建：已存在则原样返回（不修复、不覆盖，修复由调用方显式决定）。
 * 无论新建还是命中已有房间都做不变量断言——重复「开始私聊」不应把一条坏数据洗白。
 * store 的写入断言是最终兜底，这里是离入口最近的一次快速失败。
 */
export function createDirectRoom(draft: { rooms: Room[] }, input: Parameters<typeof buildDirectRoom>[0]): Room {
	const existing = directRoomOf(draft.rooms, input.accountId, input.botId);
	if (existing) return assertDirectRoom(existing);
	const room = assertDirectRoom(buildDirectRoom(input));
	draft.rooms.push(room);
	return room;
}

/**
 * 不变量校验：返回第一处违规（供 Hub 的写入路径断言，测试也复用它）。
 * 直聊房间一旦破坏这些条件，就会悄悄退化成群组（广播、黑板、多成员），必须显式拒绝而不是尽力修补。
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

/** 列表投影：直聊房间不上群组列表，由 `/api/direct-rooms` 单独提供。 */
export function groupRoomsOf(rooms: readonly Room[], accountId: string): Room[] {
	return rooms.filter((room) => room.accountId === accountId && isGroupRoom(room));
}

/**
 * Bot 消失后清理由 (accountId, botId) 派生的直聊容器。
 *
 * 直聊房间是 Bot 的函数：Bot 记录没了，容器也不该留下，否则会剩下一个没有成员、
 * 却仍被当作私聊的非法房间（`assertDirectRoom` 仍会放过它，因为它结构上"合法"，
 * 只是永远派不出任务）。设备撤销与设备重新注册（`PUT /api/agent/bots` 里 Bot 不再出现）
 * 两条路径共用这一份判定，避免一边清理一边残留。
 *
 * 只删直聊容器；群组房间由调用方自己剔除成员，不在这里处理。
 */
export function pruneDirectRoomsForBots(
	rooms: readonly Room[],
	accountId: string,
	removedBotIds: ReadonlySet<string>,
): { rooms: Room[]; removedRoomIds: string[] } {
	if (!removedBotIds.size) return { rooms: [...rooms], removedRoomIds: [] };
	const removedRoomIds: string[] = [];
	const kept: Room[] = [];
	for (const room of rooms) {
		const orphaned =
			room.accountId === accountId && isDirectRoom(room) && room.botIds.some((botId) => removedBotIds.has(botId));
		if (orphaned) removedRoomIds.push(room.id);
		else kept.push(room);
	}
	return { rooms: kept, removedRoomIds };
}
