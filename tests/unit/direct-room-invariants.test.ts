import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	assertDirectRoom,
	buildDirectRoom,
	createDirectRoom,
	DirectRoomInvariantError,
	directRoomViolation,
	isGroupOnlyRoomPath,
	pruneDirectRoomsForBots,
} from "../../server/device-center/direct-rooms.js";
import { buildSharedMessage, shareContentFingerprint } from "../../server/device-center/direct-room-share.js";
import { sameBotConflict } from "../../server/device-center/bot-queue.js";
import { assertRoomWriteInvariants, DeviceHubStore, type Room } from "../../server/device-center/store.js";

/**
 * 直聊不变量的写入单源：路由层的散点校验会被绕过（例如设备撤销连带改 botIds），
 * 因此断言必须落在 store.transact 里，且只校验本事务改动过的房间（存量零迁移）。
 */

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const input = { accountId: "acc", botId: "bot", botName: "Bot" };
const withBlackboard = (room: Room): Room => ({
	...room,
	blackboard: { version: 1, updatedAt: 0, updatedBy: { type: "human", id: "acc", name: "Owner" }, content: "x" },
});

async function fixture() {
	const dataDir = await mkdtemp(join(tmpdir(), "direct-room-store-"));
	const store = await DeviceHubStore.open(dataDir);
	cleanups.push(async () => {
		await store.close();
		await rm(dataDir, { recursive: true, force: true });
	});
	return store;
}

describe("direct room invariants (pure)", () => {
	it("accepts a canonical direct room and rejects group capabilities", () => {
		const room = buildDirectRoom(input);
		expect(assertDirectRoom(room)).toBe(room);
		expect(directRoomViolation(withBlackboard(room))?.code).toBe("DIRECT_ROOM_BLACKBOARD");
		expect(() => assertDirectRoom(withBlackboard(room))).toThrow(DirectRoomInvariantError);
		try {
			assertDirectRoom(withBlackboard(room));
		} catch (error) {
			expect(error).toMatchObject({ status: 409, code: "DIRECT_ROOM_BLACKBOARD" });
		}
	});

	it("createDirectRoom is idempotent and still validates an existing room", () => {
		const draft = { rooms: [] as Room[] };
		const first = createDirectRoom(draft, input);
		expect(createDirectRoom(draft, input)).toEqual(first);
		expect(draft.rooms).toHaveLength(1);
		draft.rooms[0] = withBlackboard(first);
		expect(() => createDirectRoom(draft, input)).toThrow(/blackboard/i);
	});

	it("group-only paths are a single source", () => {
		expect(isGroupOnlyRoomPath("/blackboard")).toBe(true);
		expect(isGroupOnlyRoomPath("/webhooks/hook-1")).toBe(true);
		// 自带 token 的 incoming webhook 不要求账号 Cookie，否则守卫会先于验签返回 401。
		expect(isGroupOnlyRoomPath("/webhooks/incoming/hook-1")).toBe(false);
		expect(isGroupOnlyRoomPath("/messages")).toBe(false);
		expect(isGroupOnlyRoomPath("/blackboardish")).toBe(false);
	});

	it("shares the same-bot conflict rule across Hub and device layers", () => {
		expect(sameBotConflict({ botId: "bot" }, { botId: "bot" })).toBe(true);
		expect(sameBotConflict({ botId: "bot" }, { botId: "other" })).toBe(false);
	});

	it("prunes only the direct rooms of Bots that disappeared", () => {
		const removed = buildDirectRoom({ ...input, botId: "bot-a" });
		const kept = buildDirectRoom({ ...input, botId: "bot-b" });
		const groupWithSameBot: Room = {
			id: "group-1",
			accountId: "acc",
			kind: "group",
			name: "Group",
			botIds: ["bot-a"],
			createdAt: 0,
		};
		const result = pruneDirectRoomsForBots([removed, kept, groupWithSameBot], "acc", new Set(["bot-a"]));
		expect(result.removedRoomIds).toEqual([removed.id]);
		// 群组房间不由这里删（成员清理由调用方处理），别的账号的直聊也不归本次写入路径。
		expect(result.rooms.map((room) => room.id)).toEqual([kept.id, groupWithSameBot.id]);
		expect(pruneDirectRoomsForBots([removed], "other", new Set(["bot-a"])).rooms).toHaveLength(1);
		// 没有 Bot 消失时一个都不动（重复上报同一份清单不该删历史）。
		expect(pruneDirectRoomsForBots([removed], "acc", new Set()).rooms).toHaveLength(1);
	});
});

describe("direct room invariants (store writes)", () => {
	it("rolls back a transaction that would create an invalid direct room", async () => {
		const store = await fixture();
		await expect(
			store.transact((draft) => {
				draft.rooms.push(withBlackboard(buildDirectRoom(input)));
			}),
		).rejects.toMatchObject({ status: 409, code: "DIRECT_ROOM_BLACKBOARD" });
		expect(store.snapshot().rooms).toHaveLength(0);
	});

	it("rejects rewriting a direct room into a group room instead of degrading silently", async () => {
		const store = await fixture();
		await store.transact((draft) => {
			draft.rooms.push(buildDirectRoom(input));
		});
		const direct = store.snapshot().rooms[0];

		// 只改 kind 就能绕过逐字段校验（id / 成员 / 群能力字段都还合法），必须在方向上拒绝。
		await expect(
			store.transact((draft) => {
				draft.rooms[0].kind = "group";
			}),
		).rejects.toMatchObject({ status: 409, code: "DIRECT_ROOM_KIND_REWRITE" });
		expect(store.snapshot().rooms).toHaveLength(1);
		expect(store.snapshot().rooms[0].kind).toBe("direct");

		// 删除是合法清场（Bot 消失 → 容器一起消失），不会被改写断言误伤。
		await store.transact((draft) => {
			draft.rooms = draft.rooms.filter((room) => room.id !== direct.id);
		});
		expect(store.snapshot().rooms).toHaveLength(0);
	});

	it("allows valid direct and group rooms, and only validates rooms touched by the write", async () => {
		const store = await fixture();
		const group: Room = {
			id: "group-1",
			accountId: "acc",
			name: "Group",
			botIds: ["bot"],
			createdAt: 0,
		};
		await store.transact((draft) => {
			draft.rooms.push(buildDirectRoom(input));
			draft.rooms.push(group);
		});
		expect(store.snapshot().rooms).toHaveLength(2);

		// 存量坏数据（历史脏直聊）没有被本事务改动：零迁移，不阻断无关写入。
		const dirty = withBlackboard(buildDirectRoom(input));
		expect(() => assertRoomWriteInvariants([dirty], [dirty])).not.toThrow();
		// 一旦某个写入路径动到它，就必须显式拒绝。
		expect(() => assertRoomWriteInvariants([dirty], [{ ...dirty, name: "Renamed" }])).toThrow(DirectRoomInvariantError);
		// 群房间带黑板是合法的，断言不误伤。
		expect(() =>
			assertRoomWriteInvariants(
				[],
				[
					{
						...group,
						blackboard: {
							version: 1,
							updatedAt: 0,
							updatedBy: { type: "human", id: "acc", name: "Owner" },
							content: "x",
						},
					},
				],
			),
		).not.toThrow();
	});
});

describe("private chat → group share (pure)", () => {
	it("builds a sourced message without dispatching anything", () => {
		const sourceRoomId = buildDirectRoom(input).id;
		const message = buildSharedMessage({
			mode: "as_forward",
			note: "context",
			bot: { id: "bot", name: "Bot" },
			owner: { id: "acc", username: "Alice" },
			targetRoomId: "group-1",
			sourceRoomId,
			messageIds: ["m1"],
			picked: [{ sender: { name: "Bot" }, text: "hello   world" }],
			now: 123,
		});
		expect(message).toMatchObject({
			roomId: "group-1",
			accountId: "acc",
			createdAt: 123,
			sender: { type: "human", id: "acc", name: "Alice" },
			taskIds: [],
			sharedFrom: { mode: "as_forward", sourceRoomId, botId: "bot", messageIds: ["m1"] },
		});
		expect(message.text).toContain("forwarded from a private chat");
		expect(message.text).toContain("context");
		expect(message.text).toContain("Bot: hello world");
	});

	it("rejects an oversized share with an HTTP 413", () => {
		expect(() =>
			buildSharedMessage({
				mode: "as_bot",
				note: "x".repeat(17_000),
				bot: { id: "bot", name: "Bot" },
				owner: { id: "acc", username: "Alice" },
				targetRoomId: "group-1",
				sourceRoomId: buildDirectRoom(input).id,
				messageIds: [],
				picked: [],
			}),
		).toThrowError(/too large/i);
	});

	it("fingerprint ignores message order but changes with content", () => {
		const base = { mode: "as_bot" as const, note: "", sourceRoomId: "s", targetRoomId: "t" };
		const first = shareContentFingerprint({ ...base, messageIds: ["m1", "m2"] });
		expect(shareContentFingerprint({ ...base, messageIds: ["m2", "m1"] })).toBe(first);
		expect(shareContentFingerprint({ ...base, note: "extra", messageIds: ["m1", "m2"] })).not.toBe(first);
	});
});
