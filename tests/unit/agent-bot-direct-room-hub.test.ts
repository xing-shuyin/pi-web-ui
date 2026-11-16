import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDeviceHub } from "../../server/device-center/hub.js";
import { directRoomId } from "../../server/device-center/direct-rooms.js";
import { readPersistedHub } from "../../server/device-center/store.js";
import { BOT_QUEUE_MAX_PENDING, rankBotQueue } from "../../server/device-center/bot-queue.js";

/**
 * 直聊房间的 HTTP 契约：幂等开启、群组列表隔离、群能力拒绝、消息默认投给唯一 Bot。
 * 这里走真实 Hub + 账号 Cookie + 设备注册，验证的是接线而不是纯函数（纯函数见 agent-bot-direct-room.test.ts）。
 */

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(publicUrl = "https://hub.test") {
	const dataDir = await mkdtemp(join(tmpdir(), "direct-room-hub-"));
	cleanups.push(async () => {
		for (let i = 0; i < 5; i++) {
			try {
				await rm(dataDir, { recursive: true, force: true });
				return;
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code !== "EBUSY" && code !== "EPERM") throw error;
				await new Promise((resolve) => setTimeout(resolve, 60));
			}
		}
	});
	const delivered: { deviceId: string; task: { id: string; botId: string } }[] = [];
	const hub = await createDeviceHub({
		dataDir,
		publicUrl,
		// 模拟"设备在线并接单"：任务进入下发态（持租约），但不会自己完成，正好用来观察排队。
		onTask: (deviceId, task) => {
			delivered.push({ deviceId, task });
			return true;
		},
	});
	await new Promise<void>((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
	cleanups.push(() => hub.close());
	const { port } = hub.server.address() as { port: number };

	async function request(
		path: string,
		body?: unknown,
		cookie = "",
		extra: Record<string, string> = {},
		method?: string,
	) {
		return new Promise<{ status: number; body: any; cookie: string }>((resolve, reject) => {
			const outgoing = httpRequest(
				`http://127.0.0.1:${port}${path}`,
				{
					method: method ?? (body === undefined ? "GET" : "POST"),
					headers: {
						Host: new URL(publicUrl).host,
						Origin: publicUrl,
						"Content-Type": "application/json",
						Cookie: cookie,
						...extra,
					},
				},
				(incoming) => {
					let data = "";
					incoming.setEncoding("utf8");
					incoming.on("data", (chunk) => (data += chunk));
					incoming.on("end", () => {
						try {
							resolve({
								status: incoming.statusCode!,
								body: data ? JSON.parse(data) : {},
								cookie: incoming.headers["set-cookie"]?.[0]?.split(";")[0] ?? "",
							});
						} catch (error) {
							reject(error);
						}
					});
				},
			);
			outgoing.on("error", reject);
			outgoing.end(body === undefined ? undefined : JSON.stringify(body));
		});
	}

	async function pair(cookie: string, name: string) {
		const start = await request("/api/pair/start", { name });
		expect((await request("/api/pair/approve", { code: start.body.code }, cookie)).status).toBe(200);
		const result = await request("/api/pair/poll", { pollToken: start.body.pollToken });
		expect(result.status).toBe(200);
		const botId = `bot-${result.body.deviceId}`;
		const registered = await request(
			"/api/agent/bots",
			{ bots: [{ id: botId, name, description: "test Bot", enabled: true, revision: 1 }] },
			"",
			{ Authorization: `Bearer ${result.body.credential}`, "X-Device-Id": result.body.deviceId },
			"PUT",
		);
		expect(registered.status).toBe(200);
		return {
			botId,
			deviceId: result.body.deviceId as string,
			credential: result.body.credential as string,
			uiCredential: result.body.uiCredential as string,
		};
	}

	return { hub, request, pair, delivered, dataDir };
}

async function login(f: Awaited<ReturnType<typeof fixture>>, username = "alice") {
	const registered = await f.request("/api/auth/register", { username, password: "a-test-password" });
	expect(registered.status).toBe(201);
	expect(registered.cookie).toBeTruthy();
	return { cookie: registered.cookie };
}

describe("直聊房间 HTTP 契约", () => {
	it("开启是幂等的，且不出现在群组列表里", async () => {
		const f = await fixture();
		const account = await login(f);
		const bot = await f.pair(account.cookie, "Atlas");

		const created = await f.request(`/api/bots/${bot.botId}/direct-room`, {}, account.cookie);
		expect(created.status).toBe(201);
		expect(created.body.room.kind).toBe("direct");
		expect(created.body.room.botIds).toEqual([bot.botId]);
		expect(created.body.room.primaryBotId).toBe(bot.botId);

		const again = await f.request(`/api/bots/${bot.botId}/direct-room`, {}, account.cookie);
		expect(again.body.room.id).toBe(created.body.room.id);
		expect(created.body.room.id).toContain("direct-");

		const groups = await f.request("/api/rooms", undefined, account.cookie);
		expect(groups.body.rooms).toHaveLength(0);

		const direct = await f.request("/api/direct-rooms", undefined, account.cookie);
		expect(direct.body.rooms).toHaveLength(1);
		expect(direct.body.rooms[0].bot.id).toBe(bot.botId);
	});

	it("群能力与成员变更是硬拒绝，不静默降级", async () => {
		const f = await fixture();
		const account = await login(f);
		const bot = await f.pair(account.cookie, "Atlas");
		const other = await f.pair(account.cookie, "Other");
		const room = (await f.request(`/api/bots/${bot.botId}/direct-room`, {}, account.cookie)).body.room;
		const base = `/api/rooms/${room.id}`;

		const members = await f.request(`${base}/members`, { botIds: [bot.botId, other.botId] }, account.cookie);
		expect(members.status).toBe(409);
		expect(members.body.code).toBe("DIRECT_ROOM_FIXED_MEMBER");

		const blackboard = await f.request(
			`${base}/blackboard`,
			{ content: "x", expectedVersion: 0 },
			account.cookie,
			{},
			"PUT",
		);
		expect(blackboard.status).toBe(409);
		expect(blackboard.body.code).toBe("DIRECT_ROOM_CAPABILITY");

		const canvas = await f.request(`${base}/canvas`, { binding: null }, account.cookie);
		expect(canvas.status).toBe(409);
		expect(canvas.body.code).toBe("DIRECT_ROOM_CAPABILITY");
	});

	it("不带 targetBotIds 的消息直接投给唯一 Bot（复用主 Bot 路径）", async () => {
		const f = await fixture();
		const account = await login(f);
		const bot = await f.pair(account.cookie, "Atlas");
		const room = (await f.request(`/api/bots/${bot.botId}/direct-room`, {}, account.cookie)).body.room;

		const sent = await f.request(
			`/api/rooms/${room.id}/messages`,
			{ text: "你好", idempotencyKey: "direct-1" },
			account.cookie,
		);
		expect(sent.status).toBe(200);
		expect(sent.body.tasks.map((task: { botId: string }) => task.botId)).toEqual([bot.botId]);
		expect(sent.body.tasks[0].roomId).toBe(room.id);
		expect(sent.body.tasks[0].conversationId).toBeTruthy();
	});

	it("删除后重建是同 id 的空房间，Bot 本身不受影响", async () => {
		const f = await fixture();
		const account = await login(f);
		const bot = await f.pair(account.cookie, "Atlas");
		const room = (await f.request(`/api/bots/${bot.botId}/direct-room`, {}, account.cookie)).body.room;
		expect(room.id).toBe(directRoomId(room.accountId, bot.botId));

		expect((await f.request(`/api/rooms/${room.id}/delete`, {}, account.cookie)).status).toBe(200);
		const recreated = await f.request(`/api/bots/${bot.botId}/direct-room`, {}, account.cookie);
		expect(recreated.body.room.id).toBe(room.id);
		expect((await f.request("/api/rooms", undefined, account.cookie)).body.rooms).toHaveLength(0);
		expect((await f.request("/api/direct-rooms", undefined, account.cookie)).body.rooms).toHaveLength(1);
	});

	it("设备不再上报某个 Bot 时，它的直聊房间一起消失", async () => {
		const f = await fixture();
		const account = await login(f);
		const bot = await f.pair(account.cookie, "Atlas");
		await f.request(`/api/bots/${bot.botId}/direct-room`, {}, account.cookie);
		expect((await f.request("/api/direct-rooms", undefined, account.cookie)).body.rooms).toHaveLength(1);

		// 设备侧删掉这个 Bot 后重新上报：Bot 从注册表消失 → 派生的直聊容器不能留成孤儿。
		const emptied = await f.request(
			"/api/agent/bots",
			{ bots: [] },
			"",
			{ Authorization: `Bearer ${bot.credential}`, "X-Device-Id": bot.deviceId },
			"PUT",
		);
		expect(emptied.status).toBe(200);
		expect((await f.request("/api/direct-rooms", undefined, account.cookie)).body.rooms).toHaveLength(0);
	});

	it("只是停用（enabled=false）时保留直聊历史，不跟着删房间", async () => {
		const f = await fixture();
		const account = await login(f);
		const bot = await f.pair(account.cookie, "Atlas");
		const room = (await f.request(`/api/bots/${bot.botId}/direct-room`, {}, account.cookie)).body.room;

		const disabled = await f.request(
			"/api/agent/bots",
			{ bots: [{ id: bot.botId, name: "Atlas", description: "test Bot", enabled: false, revision: 2 }] },
			"",
			{ Authorization: `Bearer ${bot.credential}`, "X-Device-Id": bot.deviceId },
			"PUT",
		);
		expect(disabled.status).toBe(200);
		const direct = await f.request("/api/direct-rooms", undefined, account.cookie);
		expect(direct.body.rooms.map((row: { id: string }) => row.id)).toEqual([room.id]);
		expect(direct.body.rooms[0].bot.enabled).toBe(false);
	});

	it("同一 Bot 并发派活改为排队：后到的不失败，私聊优先于群", async () => {
		const f = await fixture();
		const account = await login(f);
		const bot = await f.pair(account.cookie, "Atlas");
		const group = await f.request(
			"/api/rooms",
			{ name: "Team", botIds: [bot.botId], primaryBotId: bot.botId },
			account.cookie,
		);
		expect(group.status).toBe(201);

		// 1) 群里的第一条：立刻下发，占住这个 Bot 的执行位。
		const running = await f.request(
			`/api/rooms/${group.body.room.id}/messages`,
			{ text: "先跑这个", idempotencyKey: "q-1" },
			account.cookie,
		);
		expect(running.status).toBe(200);
		expect(running.body.tasks[0].status).toBe("queued");
		expect(f.delivered).toHaveLength(1);

		// 2) 同一会话的第二条：等上一轮跑完，而不是失败。
		const sameThread = await f.request(
			`/api/rooms/${group.body.room.id}/messages`,
			{ text: "同一会话的第二条", idempotencyKey: "q-2" },
			account.cookie,
		);
		expect(sameThread.body.tasks[0].status).toBe("queued");
		expect(sameThread.body.tasks[0].blockReason).toBe("dependency");
		expect(String(sameThread.body.tasks[0].queuedReason)).toContain("queued behind the previous turn");

		// 3) 私聊（新会话）：命中 Bot 级队列闸门，优先级 0。
		const direct = (await f.request(`/api/bots/${bot.botId}/direct-room`, {}, account.cookie)).body.room;
		const dm = await f.request(
			`/api/rooms/${direct.id}/messages`,
			{ text: "私聊里的任务", idempotencyKey: "q-3" },
			account.cookie,
		);
		expect(dm.status).toBe(200);
		expect(dm.body.tasks[0].blockReason).toBe("bot_busy");
		expect(String(dm.body.tasks[0].queuedReason)).toMatch(/前面还有|Bot is finishing/);

		// 4) 另一个群（不同会话）：同样 bot_busy，但优先级低于私聊。
		const otherGroup = await f.request(
			"/api/rooms",
			{ name: "Other", botIds: [bot.botId], primaryBotId: bot.botId },
			account.cookie,
		);
		const other = await f.request(
			`/api/rooms/${otherGroup.body.room.id}/messages`,
			{ text: "另一个群的任务", idempotencyKey: "q-4" },
			account.cookie,
		);
		expect(other.body.tasks[0].blockReason).toBe("bot_busy");
		const state = f.hub.store.snapshot();
		const order = rankBotQueue(state.tasks, new Set(), bot.botId).map((task) => task.roomId);
		expect(order[0]).toBe(direct.id);
		expect(order).toContain(otherGroup.body.room.id);
	});

	it("私聊 → 群：带来源与幂等，投递本身不派活", async () => {
		const f = await fixture();
		const account = await login(f);
		const bot = await f.pair(account.cookie, "Atlas");
		const direct = (await f.request(`/api/bots/${bot.botId}/direct-room`, {}, account.cookie)).body.room;
		await f.request(
			`/api/rooms/${direct.id}/messages`,
			{ text: "这是私聊里的结论", idempotencyKey: "dm-1" },
			account.cookie,
		);
		const directDetail = await f.request(`/api/rooms/${direct.id}`, undefined, account.cookie);
		const sourceMessage = directDetail.body.messages[0];

		const group = await f.request(
			"/api/rooms",
			{ name: "Team", botIds: [bot.botId], primaryBotId: bot.botId },
			account.cookie,
		);
		const share = await f.request(
			`/api/bots/${bot.botId}/share`,
			{
				sourceRoomId: direct.id,
				targetRoomId: group.body.room.id,
				mode: "as_forward",
				messageIds: [sourceMessage.id],
				note: "同步一下",
				idempotencyKey: "share-1",
			},
			account.cookie,
		);
		expect(share.status).toBe(200);
		expect(share.body.duplicate).toBe(false);
		expect(share.body.message.sender).toMatchObject({ type: "human" });
		expect(share.body.message.text).toContain("来自与 Atlas 的私聊");
		expect(share.body.message.text).toContain("同步一下");
		expect(share.body.message.text).toContain("这是私聊里的结论");
		expect(share.body.message.sharedFrom).toMatchObject({
			mode: "as_forward",
			sourceRoomId: direct.id,
			botId: bot.botId,
			messageIds: [sourceMessage.id],
		});
		// 投递是"公布"而不是"派活"：群任务数不因投递增加。
		expect(share.body.message.taskIds).toEqual([]);
		const groupDetail = await f.request(`/api/rooms/${group.body.room.id}`, undefined, account.cookie);
		expect(groupDetail.body.tasks).toHaveLength(0);

		// 幂等：同样的 key 与内容不产生第二条消息。
		const again = await f.request(
			`/api/bots/${bot.botId}/share`,
			{
				sourceRoomId: direct.id,
				targetRoomId: group.body.room.id,
				mode: "as_forward",
				messageIds: [sourceMessage.id],
				note: "同步一下",
				idempotencyKey: "share-1",
			},
			account.cookie,
		);
		expect(again.body.duplicate).toBe(true);
		expect(again.body.message.id).toBe(share.body.message.id);
		const afterRepeat = await f.request(`/api/rooms/${group.body.room.id}`, undefined, account.cookie);
		expect(afterRepeat.body.messages).toHaveLength(1);

		// 同一个 key 换了内容：直接冲突，而不是悄悄覆盖。
		const conflicted = await f.request(
			`/api/bots/${bot.botId}/share`,
			{
				sourceRoomId: direct.id,
				targetRoomId: group.body.room.id,
				mode: "as_forward",
				messageIds: [sourceMessage.id],
				note: "改了内容",
				idempotencyKey: "share-1",
			},
			account.cookie,
		);
		expect(conflicted.status).toBe(409);
	});

	it("as_bot 要求 Bot 是目标群成员；来源必须是私聊；Bot 自己不能广播", async () => {
		const f = await fixture();
		const account = await login(f);
		const bot = await f.pair(account.cookie, "Atlas");
		const other = await f.pair(account.cookie, "Other");
		const direct = (await f.request(`/api/bots/${bot.botId}/direct-room`, {}, account.cookie)).body.room;
		await f.request(`/api/rooms/${direct.id}/messages`, { text: "私聊内容", idempotencyKey: "dm-1" }, account.cookie);
		const directDetail = await f.request(`/api/rooms/${direct.id}`, undefined, account.cookie);
		const sourceMessage = directDetail.body.messages[0];

		// 目标群里没有这个 Bot：as_bot 必须拒绝，as_forward 允许。
		const outsiderGroup = await f.request(
			"/api/rooms",
			{ name: "NoAtlas", botIds: [other.botId], primaryBotId: other.botId },
			account.cookie,
		);
		const denied = await f.request(
			`/api/bots/${bot.botId}/share`,
			{
				sourceRoomId: direct.id,
				targetRoomId: outsiderGroup.body.room.id,
				mode: "as_bot",
				messageIds: [sourceMessage.id],
				idempotencyKey: "share-outsider",
			},
			account.cookie,
		);
		expect(denied.status).toBe(409);
		expect(denied.body.code).toBe("SHARE_BOT_NOT_MEMBER");

		const forwarded = await f.request(
			`/api/bots/${bot.botId}/share`,
			{
				sourceRoomId: direct.id,
				targetRoomId: outsiderGroup.body.room.id,
				mode: "as_forward",
				messageIds: [sourceMessage.id],
				idempotencyKey: "share-forward-outsider",
			},
			account.cookie,
		);
		expect(forwarded.status).toBe(200);
		expect(forwarded.body.message.sender.type).toBe("human");

		// 作为 Bot 发言时，发送者身份必须是那个 Bot。
		const memberGroup = await f.request(
			"/api/rooms",
			{ name: "WithAtlas", botIds: [bot.botId], primaryBotId: bot.botId },
			account.cookie,
		);
		const asBot = await f.request(
			`/api/bots/${bot.botId}/share`,
			{
				sourceRoomId: direct.id,
				targetRoomId: memberGroup.body.room.id,
				mode: "as_bot",
				messageIds: [sourceMessage.id],
				idempotencyKey: "share-as-bot",
			},
			account.cookie,
		);
		expect(asBot.status).toBe(200);
		expect(asBot.body.message.sender).toMatchObject({ type: "bot", id: bot.botId, name: "Atlas" });

		// 来源必须是直聊房间：拿群当来源直接 404。
		const fromGroup = await f.request(
			`/api/bots/${bot.botId}/share`,
			{
				sourceRoomId: memberGroup.body.room.id,
				targetRoomId: outsiderGroup.body.room.id,
				mode: "as_forward",
				messageIds: [sourceMessage.id],
				idempotencyKey: "share-bad-source",
			},
			account.cookie,
		);
		expect(fromGroup.status).toBe(404);

		// 设备（Bot 自身）没有投递权限：agent 路由白名单里没有 share，直接 404。
		const asDevice = await f.request(
			`/api/agent/bots/${bot.botId}/share`,
			{
				sourceRoomId: direct.id,
				targetRoomId: memberGroup.body.room.id,
				mode: "as_bot",
				messageIds: [sourceMessage.id],
				idempotencyKey: "share-as-device",
			},
			"",
			{ Authorization: `Bearer ${bot.credential}`, "X-Device-Id": bot.deviceId },
		);
		expect(asDevice.status).toBe(404);
	});

	it("浏览器侧走 device-user 代理：开直聊、发私聊消息、再投递到群", async () => {
		const f = await fixture();
		const account = await login(f);
		const bot = await f.pair(account.cookie, "Atlas");
		// 浏览器用的是 device-user 前缀 + UI 凭证 + X-Device-Id，不是账号 Cookie。
		const uiHeaders = { Authorization: `Bearer ${bot.uiCredential}`, "X-Device-Id": bot.deviceId };
		const room = await f.request(`/api/device-user/bots/${bot.botId}/direct-room`, {}, "", uiHeaders);
		expect(room.status).toBe(201);
		const direct = room.body.room.id;

		const message = await f.request(
			`/api/device-user/rooms/${direct}/messages`,
			{ text: "私聊里的结论", idempotencyKey: "ui-1" },
			"",
			uiHeaders,
		);
		expect(message.status).toBe(200);

		const group = await f.request(
			"/api/rooms",
			{ name: "Team", botIds: [bot.botId], primaryBotId: bot.botId },
			account.cookie,
		);
		const shared = await f.request(
			`/api/device-user/bots/${bot.botId}/share`,
			{
				sourceRoomId: direct,
				targetRoomId: group.body.room.id,
				mode: "as_bot",
				messageIds: [message.body.message.id],
				idempotencyKey: "ui-share-1",
			},
			"",
			uiHeaders,
		);
		expect(shared.status).toBe(200);
		expect(shared.body.message.sender).toMatchObject({ type: "bot", id: bot.botId });
		expect(shared.body.message.sharedFrom.mode).toBe("as_bot");
	});

	it("排队提示带预计等待（没有历史耗时时用 30s 兜底）", async () => {
		const f = await fixture();
		const account = await login(f);
		const bot = await f.pair(account.cookie, "Atlas");
		const direct = (await f.request(`/api/bots/${bot.botId}/direct-room`, {}, account.cookie)).body.room;
		await f.request(`/api/rooms/${direct.id}/messages`, { text: "第一条", idempotencyKey: "e-1" }, account.cookie);
		const group = await f.request(
			"/api/rooms",
			{ name: "Team", botIds: [bot.botId], primaryBotId: bot.botId },
			account.cookie,
		);
		const queued = await f.request(
			`/api/rooms/${group.body.room.id}/messages`,
			{ text: "群里的第二条", idempotencyKey: "e-2" },
			account.cookie,
		);
		expect(queued.body.tasks[0].blockReason).toBe("bot_busy");
		expect(String(queued.body.tasks[0].queuedReason)).toMatch(/约 \d+(s|min)/);
	});

	it("排队满 12 个后新的派活直接 429", async () => {
		const f = await fixture();
		const account = await login(f);
		const bot = await f.pair(account.cookie, "Atlas");
		const direct = (await f.request(`/api/bots/${bot.botId}/direct-room`, {}, account.cookie)).body.room;
		// 造一个"正在执行"的任务 + 12 个已停放的排队任务，占满队列。
		await f.hub.store.transact((draft) => {
			const base = {
				roomId: direct.id,
				accountId: draft.accounts[0].id,
				botId: bot.botId,
				deviceId: bot.deviceId,
				botRevision: 1,
				text: "seeded",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};
			draft.tasks.push({ ...base, id: "seed-running", attemptId: "seed-running", status: "running" });
			for (let i = 0; i < BOT_QUEUE_MAX_PENDING; i++)
				draft.tasks.push({
					...base,
					id: `seed-${i}`,
					attemptId: `seed-${i}`,
					status: "queued",
					blockReason: "bot_busy",
				});
		});
		const denied = await f.request(
			`/api/rooms/${direct.id}/messages`,
			{ text: "再派一个", idempotencyKey: "full-1" },
			account.cookie,
		);
		expect(denied.status).toBe(429);
		expect(denied.body.code).toBe("BOT_QUEUE_FULL");
	});

	it("直聊消息真的落盘：分区日志里有，重开 store 能读回来", async () => {
		const f = await fixture();
		const account = await login(f);
		const bot = await f.pair(account.cookie, "Atlas");
		const room = (await f.request(`/api/bots/${bot.botId}/direct-room`, {}, account.cookie)).body.room;
		await f.request(
			`/api/rooms/${room.id}/messages`,
			{ text: "持久化检查", idempotencyKey: "persist-1" },
			account.cookie,
		);

		// 房间 id 必须是合法分区名，日志文件才会真的存在（冒号会让写入被静默跳过）。
		const partition = join(f.dataDir, "hub-log", "messages", `${room.id}.jsonl`);
		expect(await readFile(partition, "utf8")).toContain("持久化检查");
		const persisted = await readPersistedHub(f.dataDir);
		expect(persisted.messages.some((message) => message.text === "持久化检查")).toBe(true);
	});

	it("不存在的 Bot 不会建出房间", async () => {
		const f = await fixture();
		const account = await login(f);
		const missing = await f.request("/api/bots/bot-missing/direct-room", {}, account.cookie);
		expect(missing.status).toBe(404);
	});

	it("设备撤销时直聊容器随 Bot 一起清掉，不留无成员的非法房间", async () => {
		const f = await fixture();
		const account = await login(f);
		const bot = await f.pair(account.cookie, "Atlas");
		const room = (await f.request(`/api/bots/${bot.botId}/direct-room`, {}, account.cookie)).body.room;
		expect(room.id).toContain("direct-");
		expect((await f.request("/api/direct-rooms", undefined, account.cookie)).body.rooms).toHaveLength(1);

		// 没有这段清理，store 的写入断言会把撤销设备整个事务拒掉（直聊剩 0 个成员）。
		const revoked = await f.request(`/api/devices/${bot.deviceId}/revoke`, {}, account.cookie);
		expect(revoked.status).toBe(200);
		expect((await f.request("/api/direct-rooms", undefined, account.cookie)).body.rooms).toHaveLength(0);
		expect((await f.request("/api/rooms", undefined, account.cookie)).body.rooms).toHaveLength(0);
	});
});
