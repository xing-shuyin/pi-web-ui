import { describe, expect, it } from "vitest";
import {
	buildDirectRoom,
	createDirectRoom,
	directRoomId,
	directRoomOf,
	directRoomViolation,
	groupRoomsOf,
	isDirectRoom,
	isGroupRoom,
} from "../../server/device-center/direct-rooms.js";
import type { Room } from "../../server/device-center/store.js";

const ACCOUNT = "acc-1";
const BOT = "bot-1";

function groupRoom(overrides: Partial<Room> = {}): Room {
	return {
		id: "room-group",
		accountId: ACCOUNT,
		kind: "group",
		name: "team",
		botIds: [BOT, "bot-2"],
		createdAt: 1,
		...overrides,
	};
}

describe("直聊房间 = 退化群组（单 Bot、无群能力、id 幂等）", () => {
	it("id 由 (账号, Bot) 确定性派生：重复开启不会长出两个房间", () => {
		expect(directRoomId(ACCOUNT, BOT)).toBe(directRoomId(ACCOUNT, BOT));
		expect(directRoomId(ACCOUNT, BOT)).not.toBe(directRoomId(ACCOUNT, "bot-2"));
		expect(directRoomId(ACCOUNT, BOT).startsWith("direct-")).toBe(true);
		const draft = { rooms: [] as Room[] };
		const first = createDirectRoom(draft, { accountId: ACCOUNT, botId: BOT, botName: "Atlas" });
		const second = createDirectRoom(draft, { accountId: ACCOUNT, botId: BOT, botName: "Atlas" });
		expect(second.id).toBe(first.id);
		expect(draft.rooms).toHaveLength(1);
	});

	it("单成员 + 主 Bot + 无群能力是硬不变量", () => {
		const room = buildDirectRoom({ accountId: ACCOUNT, botId: BOT, botName: "Atlas" });
		expect(room.kind).toBe("direct");
		expect(room.botIds).toEqual([BOT]);
		expect(room.primaryBotId).toBe(BOT);
		expect(directRoomViolation(room)).toBeUndefined();
		expect(isDirectRoom(room)).toBe(true);
		expect(isGroupRoom(room)).toBe(false);
	});

	it("任何让直聊退化成群组的写入都会被显式拒绝", () => {
		const base = buildDirectRoom({ accountId: ACCOUNT, botId: BOT, botName: "Atlas" });
		const codeOf = (patch: Partial<Room>) => directRoomViolation({ ...base, ...patch })?.code;
		expect(codeOf({ botIds: [BOT, "bot-2"] })).toBe("DIRECT_ROOM_MEMBERS");
		expect(codeOf({ primaryBotId: undefined })).toBe("DIRECT_ROOM_PRIMARY");
		expect(codeOf({ id: "direct-deadbeef" })).toBe("DIRECT_ROOM_ID");
		expect(codeOf({ router: { enabled: true } as Room["router"] })).toBe("DIRECT_ROOM_ROUTER");
		expect(codeOf({ blackboard: { version: 1 } as Room["blackboard"] })).toBe("DIRECT_ROOM_BLACKBOARD");
		expect(codeOf({ webhooks: [{}] as Room["webhooks"] })).toBe("DIRECT_ROOM_WEBHOOKS");
		expect(codeOf({ canvasBinding: { deviceId: "d", graphId: "g", cwd: "/tmp", title: "t" } })).toBe(
			"DIRECT_ROOM_CANVAS",
		);
		expect(codeOf({ hubRelayBaseUrl: "https://x" })).toBe("DIRECT_ROOM_RELAY");
	});

	it("群组列表只返回 group，直聊房间单独查询", () => {
		const rooms = [
			groupRoom(),
			buildDirectRoom({ accountId: ACCOUNT, botId: BOT, botName: "Atlas" }),
			groupRoom({ id: "other-account", accountId: "acc-2" }),
		];
		expect(groupRoomsOf(rooms, ACCOUNT).map((room) => room.id)).toEqual(["room-group"]);
		expect(directRoomOf(rooms, ACCOUNT, BOT)?.kind).toBe("direct");
		expect(directRoomOf(rooms, ACCOUNT, "bot-2")).toBeUndefined();
	});

	it("存量房间缺省 kind 仍按群组处理（零迁移）", () => {
		const legacy = groupRoom({ kind: undefined });
		expect(isGroupRoom(legacy)).toBe(true);
		const draft = { rooms: [legacy] };
		const created = createDirectRoom(draft, { accountId: ACCOUNT, botId: BOT, botName: "Atlas" });
		expect(draft.rooms).toHaveLength(2);
		expect(draft.rooms[0].kind).toBeUndefined();
		expect(created.kind).toBe("direct");
	});
});
