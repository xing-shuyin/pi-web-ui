import express from "express";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalBotRegistry } from "../../server/device-center/bots.js";
import { createDeviceConnector } from "../../server/device-center/connector.js";
import { installLocalDeviceCenter } from "../../server/device-center/local.js";

/**
 * 「全本地」铁律：直聊与群组跑在本机房间引擎上。
 *
 * 这里把远端 Hub 换成一个**除了 `PUT /api/agent/bots` 之外全部 404** 的壳：
 * Bot 列表、直聊、群组、派活都必须照常工作，且远端一个 `/api/device-user/*` 请求都不该收到。
 * 这条测试就是「侧栏不受 Hub 版本/在线状态限制」的守卫。
 */
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

async function listen(server: Server) {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function fixture(hooks: { onConnect?: (config: { hubUrl: string; hubIdentity?: string }) => void } = {}) {
	const dir = await mkdtemp(join(tmpdir(), "local-first-rooms-"));
	cleanup.push(() => rm(dir, { recursive: true, force: true }));
	const dataDir = join(dir, "data");
	const cwd = join(dir, "project");
	await mkdir(dataDir, { recursive: true });
	await mkdir(cwd, { recursive: true });

	const hubHits: string[] = [];
	const remote = createServer((req: IncomingMessage, res: ServerResponse) => {
		hubHits.push(`${req.method} ${req.url}`);
		if (req.method === "PUT" && req.url === "/api/agent/bots") {
			res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ accountId: "acc-remote" }));
			return;
		}
		// 旧 Hub：直聊/房间类端点全都不存在。
		res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "User route missing" }));
	});
	const hubUrl = await listen(remote);
	cleanup.push(
		() =>
			new Promise<void>((resolve) => {
				remote.closeAllConnections();
				remote.close(() => resolve());
			}),
	);

	// 已配对：配置文件在，但房间不该再去远端。
	await writeFile(
		join(dataDir, "device-center.json"),
		JSON.stringify({
			hubUrl,
			name: "DESKTOP-FIRST",
			deviceId: "remote-device-id",
			credential: "remote-agent-token",
			uiCredential: "remote-ui-token",
			allowExecution: true,
		}),
	);

	const bots = await createLocalBotRegistry(dataDir);
	const deliveries: string[] = [];
	const app = express();
	app.use(express.json());
	const local = await installLocalDeviceCenter({
		app,
		dataDir,
		bots,
		connect(config, syncBots) {
			hooks.onConnect?.(config);
			const connector = createDeviceConnector({
				...config,
				localOrigin: "http://127.0.0.1:8999",
				onConnect: syncBots,
				onTask(task) {
					deliveries.push(task.botId);
					return `Completed by ${task.botId}`;
				},
			});
			return { close: connector.close, isConnected: connector.isOnline };
		},
	});
	cleanup.push(() => local.close());
	const server = createServer(app);
	const base = await listen(server);
	cleanup.push(
		() =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	);
	const request = (path: string, body?: unknown) =>
		fetch(`${base}/api/device-center/${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers: { Origin: base, "Content-Type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	const createBot = async (name: string) => {
		const bot = await bots.upsert({
			name,
			description: "",
			systemPrompt: "Help",
			cwd,
			tools: ["read"],
			skills: [],
			mcpServers: [],
			enabled: true,
		});
		// 真实入口（`POST local-bots`）保存后就会同步；测试直接操作 registry，所以显式补一次。
		await local.syncBots();
		return bot;
	};
	return { base, bots, request, createBot, deliveries, hubHits };
}

describe("全本地：直聊与群组不经过远端 Hub", () => {
	it("已配对但 Hub 是旧版本时，Bot 面板、直聊、群组、派活全部本地可用", async () => {
		const f = await fixture();
		await f.createBot("Planner");
		await f.createBot("Builder");
		const botIds = f.bots.list().map((bot) => bot.id);

		// 1) 面板：Bot 与房间都来自本机，不再有「加载失败」。
		const panel = await (await f.request("bot-panel")).json();
		expect(panel.roomsAvailable).toBe(true);
		expect(panel.bots.map((bot: { name: string }) => bot.name).sort()).toEqual(["Builder", "Planner"]);
		expect(panel.bots.every((bot: { local: boolean }) => bot.local === true)).toBe(true);

		// 2) 直聊：幂等建在本机引擎上（`direct-` 前缀 id）。
		const first = await f.request(`bots/${botIds[0]}/direct-room`, {});
		expect(first.status).toBe(201);
		expect(first.status).toBe(201);
		const room = (await first.json()).room;
		expect(room.id.startsWith("direct-")).toBe(true);
		const again = await (await f.request(`bots/${botIds[0]}/direct-room`, {})).json();
		expect(again.room.id).toBe(room.id);
		await expect
			.poll(async () => {
				const data = await (await f.request("direct-rooms")).json();
				return data.rooms.map((entry: { id: string }) => entry.id);
			})
			.toContain(room.id);

		// 3) 群组：本机建房间 + 派活 + 本地 Bot 执行。
		const created = await f.request("rooms", { name: "本地小队", botIds, primaryBotId: botIds[0] });
		expect(created.status).toBe(201);
		const group = (await created.json()).room;
		const sent = await f.request(`rooms/${group.id}/messages`, {
			text: "开工",
			targetBotIds: [botIds[1]],
			idempotencyKey: "local-first-1",
		});
		expect(sent.status).toBe(200);
		await expect.poll(() => f.deliveries).toEqual([botIds[1]]);
		await expect
			.poll(async () => {
				const detail = await (await f.request(`rooms/${group.id}`)).json();
				return detail.tasks[0]?.status;
			})
			.toBe("completed");

		// 4) 远端只收到 Bot 列表镜像，房间类请求一个都没打到它。
		expect(f.hubHits).toContain("PUT /api/agent/bots");
		expect(f.hubHits.filter((hit) => hit.includes("/api/device-user/"))).toEqual([]);
	});

	it("keeps a stable engine identity across restarts so history scope does not follow the random port", async () => {
		const identities: string[] = [];
		const urls: string[] = [];
		const f = await fixture({
			onConnect: (config) => {
				identities.push(config.hubIdentity ?? "<none>");
				urls.push(config.hubUrl);
			},
		});
		await f.request("rooms");
		// disconnect 会重建本机引擎（新端口），等价于一次重启。
		expect((await f.request("disconnect", {})).status).toBe(200);
		expect((await f.request("rooms")).status).toBe(200);
		// 端口必须真的变了，否则这条测试证明不了什么。
		expect(new Set(urls).size).toBeGreaterThan(1);
		// 但用于会话/恢复/锁分桶的身份必须稳定，否则重启后 resume 全部失效。
		expect(new Set(identities)).toEqual(new Set(["local-device-hub"]));
	});
});
