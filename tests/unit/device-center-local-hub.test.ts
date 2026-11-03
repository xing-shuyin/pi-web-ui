import express from "express";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalBotRegistry } from "../../server/device-center/bots.js";
import { readPersistedHub } from "../../server/device-center/store.js";
import { createDeviceConnector } from "../../server/device-center/connector.js";
import { installLocalDeviceCenter } from "../../server/device-center/local.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});
async function listen(server: Server) {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function fixture(dataDir: string) {
	const app = express();
	app.use(express.json());
	const bots = await createLocalBotRegistry(dataDir);
	const deliveries: string[] = [];
	let connections = 0;
	const local = await installLocalDeviceCenter({
		app,
		dataDir,
		bots,
		connect(config, syncBots) {
			connections++;
			expect(config).not.toHaveProperty("uiCredential");
			expect(config.allowExecution).toBe(true);
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
	const server = createServer(app);
	const base = await listen(server);
	let closed = false;
	async function close() {
		if (closed) return;
		closed = true;
		await local.close();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
	cleanup.push(close);
	async function request(path: string, body?: unknown, origin = base) {
		return fetch(`${base}/api/device-center/${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers: { Origin: origin, "Content-Type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	}
	return { local, bots, request, close, deliveries, connections: () => connections };
}
describe("unpaired local Bot groups", () => {
	it("creates a room with two local Bots, routes explicit tasks, and restores the room after restart", async () => {
		const dir = await mkdtemp(join(tmpdir(), "local-bot-group-"));
		cleanup.push(() => rm(dir, { recursive: true, force: true }));
		const dataDir = join(dir, "data");
		const cwd = join(dir, "project");
		await mkdir(cwd);
		const f = await fixture(dataDir);
		for (const name of ["Planner", "Builder"]) {
			const response = await f.request("local-bots", {
				name,
				description: "",
				systemPrompt: "Help",
				cwd,
				tools: ["read"],
				skills: [],
				mcpServers: [],
				enabled: true,
			});
			expect(response.status).toBe(200);
		}
		const statuses = await Promise.all(Array.from({ length: 3 }, async () => (await f.request("chat-status")).json()));
		expect(f.connections()).toBe(1);
		expect(statuses[0]).toMatchObject({ local: true, deviceId: "local-device" });
		expect(JSON.stringify(statuses)).not.toMatch(/credential|secret/i);
		expect(await (await f.request("status")).json()).not.toHaveProperty("hubUrl");
		await expect
			.poll(async () => {
				const result = await (await f.request("bots")).json();
				return result.bots.filter((bot: { online: boolean }) => bot.online).length;
			})
			.toBe(2);
		const botIds = f.bots.list().map((bot) => bot.id);
		const created = await f.request("rooms", { name: "Local team", botIds });
		expect(created.status).toBe(201);
		const { room } = await created.json();
		expect(room.botIds).toEqual(botIds);
		const sent = await f.request(`rooms/${room.id}/messages`, {
			text: "Build it",
			targetBotIds: [botIds[1]],
			idempotencyKey: "local-message-1",
		});
		expect(sent.status).toBe(200);
		await expect.poll(() => f.deliveries).toEqual([botIds[1]]);
		await expect
			.poll(async () => {
				const detail = await (await f.request(`rooms/${room.id}`)).json();
				return detail.tasks[0]?.status;
			})
			.toBe("completed");
		expect((await f.request("rooms", { name: "Forbidden", botIds }, "http://evil.test")).status).toBe(403);
		expect((await f.request("disconnect", {})).status).toBe(200);
		const restored = await (await f.request("rooms")).json();
		expect(restored.rooms[0].id).toBe(room.id);
		expect(f.connections()).toBe(2);
		await f.close();
		const restarted = await fixture(dataDir);
		const result = await (await restarted.request("rooms")).json();
		expect(result.rooms).toHaveLength(1);
		expect(result.rooms[0].id).toBe(room.id);
		expect(restarted.bots.list().map((bot) => bot.id)).toEqual(botIds);
		const saved = await readPersistedHub(join(dataDir, "local-device-hub"));
		expect(saved.devices[0]).not.toHaveProperty("credential");
		expect(saved.messages.some((message: { sender: { type: string } }) => message.sender.type === "bot")).toBe(true);
	});
});
