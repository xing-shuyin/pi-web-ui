import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request as httpRequest } from "node:http";
import { createDeviceHub } from "../../server/device-center/hub.js";
import { createDeviceCollabService } from "../../server/device-center/collab-service.js";
import { groupTaskContext } from "../../server/device-center/group-context.js";
import { registerBotExecution } from "../../server/device-center/bot-execution.js";
import { DEFAULT_EXECUTION_SETTINGS } from "../../server/device-center/execution-settings.js";
import type { LocalBot } from "../../server/device-center/bots.js";
import type { Room } from "../../server/device-center/store.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	vi.useRealTimers();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
	const dataDir = await mkdtemp(join(tmpdir(), "device-blackboard-test-"));
	cleanups.push(async () => {
		for (let i = 0; i < 5; i++) {
			try {
				await rm(dataDir, { recursive: true, force: true });
				break;
			} catch (e: any) {
				if (e?.code !== "EBUSY" && e?.code !== "EPERM" && e?.code !== "ENOTEMPTY") throw e;
				await new Promise((r) => setTimeout(r, 60));
			}
		}
	});

	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as { port: number };
	const publicUrl = `http://127.0.0.1:${address.port}`;

	const hub = await createDeviceHub({
		server,
		dataDir,
		publicUrl,
	});
	cleanups.push(() => hub.close());

	async function request(
		path: string,
		body?: unknown,
		cookie = "",
		extra: Record<string, string> = {},
		method?: string,
	) {
		const response = await new Promise<{ status: number; body: any; cookie: string }>((resolve, reject) => {
			const outgoing = httpRequest(
				`http://127.0.0.1:${address.port}${path}`,
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
					incoming.on("data", (chunk) => {
						data += chunk;
					});
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
		return response;
	}

	async function register(username = "alice") {
		const result = await request("/api/auth/register", { username, password: "a-test-password" });
		expect(result.status).toBe(201);
		return result.cookie;
	}

	async function pair(cookie: string, name = "DevBot") {
		const start = await request("/api/pair/start", { name }, cookie);
		expect((await request("/api/pair/approve", { code: start.body.code }, cookie)).status).toBe(200);
		const result = await request("/api/pair/poll", { pollToken: start.body.pollToken });
		expect(result.status).toBe(200);
		const botId = `bot-${result.body.deviceId}`;
		expect(
			(
				await request(
					"/api/agent/bots",
					{
						bots: [
							{
								id: botId,
								name,
								description: "Dev Bot",
								enabled: true,
								revision: 1,
								tools: ["read", "write", "device_collab"],
							},
						],
					},
					"",
					{ Authorization: `Bearer ${result.body.credential}`, "X-Device-Id": result.body.deviceId },
					"PUT",
				)
			).status,
		).toBe(200);
		return {
			deviceId: result.body.deviceId,
			botId,
			credential: result.body.credential,
			uiCredential: result.body.uiCredential,
		};
	}

	return { hub, request, register, pair, publicUrl, address };
}

describe("Group Blackboard Architecture", () => {
	it("covers blackboard lifecycle: initial null, human creation, bot collab read/update, CAS conflict, 403 authorization, 32KB limit, and context injection", async () => {
		const { request, register, pair, publicUrl } = await fixture();
		const cookie = await register();
		const bot1 = await pair(cookie, "WorkerBot1");
		const bot2 = await pair(cookie, "OutsiderBot2");

		// Create room with bot1 only
		const roomRes = await request("/api/rooms", { name: "Architecture Working Group", botIds: [bot1.botId] }, cookie);
		expect(roomRes.status).toBe(201);
		const roomId = roomRes.body.room.id;

		// 1) 空黑板默认返回 null
		const emptyRes = await request(`/api/rooms/${roomId}/blackboard`, undefined, cookie);
		expect(emptyRes.status).toBe(200);
		expect(emptyRes.body).toEqual({ blackboard: null });

		// 2) 人类首次创建黑板（expectedVersion = 0）成功并初始化 version = 1
		const createRes = await request(
			`/api/rooms/${roomId}/blackboard`,
			{
				content: "# System Consensus\nInitial architecture contract.",
				expectedVersion: 0,
				title: "Architecture Spec",
			},
			cookie,
			{},
			"PUT",
		);
		expect(createRes.status).toBe(200);
		expect(createRes.body.ok).toBe(true);
		expect(createRes.body.blackboard).toMatchObject({
			version: 1,
			title: "Architecture Spec",
			content: "# System Consensus\nInitial architecture contract.",
			updatedBy: {
				type: "human",
				name: "alice",
			},
		});
		expect(typeof createRes.body.blackboard.updatedAt).toBe("number");

		// 再次读验证持久化
		const readBackRes = await request(`/api/rooms/${roomId}/blackboard`, undefined, cookie);
		expect(readBackRes.status).toBe(200);
		expect(readBackRes.body.blackboard.version).toBe(1);
		expect(readBackRes.body.blackboard.content).toBe("# System Consensus\nInitial architecture contract.");

		// 3) Bot 通过 device_collab 读取黑板
		const collabService1 = createDeviceCollabService({
			getConfig: () => ({
				hubUrl: publicUrl,
				deviceId: bot1.deviceId,
				credential: bot1.credential,
				allowExecution: true,
			}),
			root: process.cwd(),
		});

		const botReadResult = (await collabService1.execute(
			"blackboard_read",
			{
				roomId,
				sourceBotId: bot1.botId,
			},
			undefined,
			{ cwd: process.cwd() },
		)) as any;
		expect(botReadResult).toBeDefined();
		expect(botReadResult.blackboard.version).toBe(1);
		expect(botReadResult.blackboard.content).toBe("# System Consensus\nInitial architecture contract.");

		// 4) Bot 乐观锁更新黑板（匹配 expectedVersion）成功，version 自增
		const botUpdateResult = (await collabService1.execute(
			"blackboard_update",
			{
				roomId,
				sourceBotId: bot1.botId,
				expectedVersion: 1,
				content: "# System Consensus v2\nUpdated data contract.",
				title: "Architecture Spec v2",
			},
			undefined,
			{ cwd: process.cwd() },
		)) as any;
		expect(botUpdateResult).toBeDefined();
		expect(botUpdateResult.ok).toBe(true);
		expect(botUpdateResult.blackboard).toMatchObject({
			version: 2,
			title: "Architecture Spec v2",
			content: "# System Consensus v2\nUpdated data contract.",
			updatedBy: {
				type: "bot",
				id: bot1.botId,
				name: "WorkerBot1",
			},
		});

		// 5) 乐观锁版本冲突（expectedVersion 不匹配）返回 409
		const conflictRes = await request(
			`/api/agent/rooms/${roomId}/blackboard`,
			{
				sourceBotId: bot1.botId,
				expectedVersion: 1, // 当前版本已是 2
				content: "Concurrent conflicting update",
			},
			"",
			{
				Authorization: `Bearer ${bot1.credential}`,
				"X-Device-Id": bot1.deviceId,
			},
			"PUT",
		);
		expect(conflictRes.status).toBe(409);
		expect(conflictRes.body.error).toBe("Version conflict");

		// Bot 通过 collabService 遇到 409 冲突也会抛出错误
		await expect(
			collabService1.execute(
				"blackboard_update",
				{
					roomId,
					sourceBotId: bot1.botId,
					expectedVersion: 1,
					content: "Conflicting collab attempt",
				},
				undefined,
				{ cwd: process.cwd() },
			),
		).rejects.toThrow();

		// 6) 非群成员 Bot 试图读写黑板被拒绝（403）
		// bot2 读黑板
		const outsiderReadRes = await request(
			`/api/agent/rooms/${roomId}/blackboard?sourceBotId=${bot2.botId}`,
			undefined,
			"",
			{
				Authorization: `Bearer ${bot2.credential}`,
				"X-Device-Id": bot2.deviceId,
			},
			"GET",
		);
		expect(outsiderReadRes.status).toBe(403);

		// bot2 写黑板
		const outsiderWriteRes = await request(
			`/api/agent/rooms/${roomId}/blackboard`,
			{
				sourceBotId: bot2.botId,
				expectedVersion: 2,
				content: "Outsider invasion",
			},
			"",
			{
				Authorization: `Bearer ${bot2.credential}`,
				"X-Device-Id": bot2.deviceId,
			},
			"PUT",
		);
		expect(outsiderWriteRes.status).toBe(403);

		// 7) 超限内容被拦截
		const hugeContent = "x".repeat(DEFAULT_EXECUTION_SETTINGS.blackboardMaxBytes + 1);
		const oversizedRes = await request(
			`/api/rooms/${roomId}/blackboard`,
			{
				expectedVersion: 2,
				content: hugeContent,
			},
			cookie,
			{},
			"PUT",
		);
		expect(oversizedRes.status).toBe(400);

		// 控制字符内容被拦截
		const controlCharRes = await request(
			`/api/rooms/${roomId}/blackboard`,
			{
				expectedVersion: 2,
				content: "Invalid\x00Control",
			},
			cookie,
			{},
			"PUT",
		);
		expect(controlCharRes.status).toBe(400);

		// 8) 任务执行上下文中正确携带黑板内容
		const latestBlackboard = (await request(`/api/rooms/${roomId}/blackboard`, undefined, cookie)).body.blackboard;
		expect(latestBlackboard.version).toBe(2);

		const fakeRoom: Room = {
			id: roomId,
			accountId: "test-account",
			name: "Architecture Working Group",
			botIds: [bot1.botId],
			blackboard: latestBlackboard,
			createdAt: Date.now(),
		};
		const fakeBots = [
			{
				id: bot1.botId,
				accountId: "test-account",
				deviceId: bot1.deviceId,
				name: "WorkerBot1",
				description: "",
				enabled: true,
				revision: 1,
				tools: ["read", "write"],
				createdAt: Date.now(),
				updatedAt: Date.now(),
			} as any,
		];

		const context = groupTaskContext(fakeRoom, fakeBots, []);
		expect(context.blackboard).toBeDefined();
		expect(context.blackboard?.version).toBe(2);
		expect(context.blackboard?.content).toBe("# System Consensus v2\nUpdated data contract.");

		const localBot: LocalBot = {
			id: bot1.botId,
			name: "WorkerBot1",
			description: "Local bot",
			systemPrompt: "",
			enabled: true,
			cwd: process.cwd(),
			revision: 1,
			tools: ["read", "write"],
			skills: [],
			mcpServers: [],
		};

		const registered = registerBotExecution(localBot, undefined, { groupContext: context });
		try {
			expect(registered.capability.instructions).toContain("[GROUP BLACKBOARD v2] Architecture Spec v2");
			expect(registered.capability.instructions).toContain("# System Consensus v2\nUpdated data contract.");
		} finally {
			registered.release();
		}

		// 无 title 时独立块正确呈现（无多余空格）
		const noTitleRoom: Room = {
			...fakeRoom,
			blackboard: {
				...latestBlackboard,
				title: undefined,
			},
		};
		const noTitleContext = groupTaskContext(noTitleRoom, fakeBots, []);
		const registeredNoTitle = registerBotExecution(localBot, undefined, { groupContext: noTitleContext });
		try {
			expect(registeredNoTitle.capability.instructions).toContain("[GROUP BLACKBOARD v2]\n# System Consensus v2");
		} finally {
			registeredNoTitle.release();
		}
	});
});
