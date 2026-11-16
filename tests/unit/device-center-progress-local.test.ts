import { afterEach, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installLocalDeviceCenter } from "../../server/device-center/local.js";
import { createLocalBotRegistry } from "../../server/device-center/bots.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function listen(server: Server) {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanup.push(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

/**
 * SSE 直播流现在由**本机房间引擎**提供（不再是远端 Hub 的代理）。
 * 断言三件事：真的拿到 `text/event-stream`、首批画面里没有凭据、客户端断开后代理不卡死。
 */
it("streams room events from the local engine without leaking credentials and survives client abort", async () => {
	const dir = await mkdtemp(join(tmpdir(), "group-progress-local-"));
	cleanup.push(() => rm(dir, { recursive: true, force: true }));
	const cwd = join(dir, "project");
	const { mkdir } = await import("node:fs/promises");
	await mkdir(cwd, { recursive: true });
	const bots = await createLocalBotRegistry(dir);
	const app = express();
	app.use(express.json());
	const local = await installLocalDeviceCenter({ app, dataDir: dir, bots, connect: () => ({ close() {} }) });
	cleanup.push(() => local.close());
	const base = await listen(createServer(app));
	const created = await fetch(`${base}/api/device-center/local-bots`, {
		method: "POST",
		headers: { Origin: base, "Content-Type": "application/json" },
		body: JSON.stringify({
			name: "Streamer",
			description: "",
			systemPrompt: "Help",
			cwd,
			tools: ["read"],
			skills: [],
			mcpServers: [],
			enabled: true,
		}),
	});
	expect(created.status).toBe(200);
	const botId = (await created.json()).bot.id;
	const room = await fetch(`${base}/api/device-center/rooms`, {
		method: "POST",
		headers: { Origin: base, "Content-Type": "application/json" },
		body: JSON.stringify({ name: "Stream room", botIds: [botId] }),
	});
	expect(room.status).toBe(201);
	const roomId = (await room.json()).room.id;

	const controller = new AbortController();
	const response = await fetch(`${base}/api/device-center/rooms/${roomId}/events`, { signal: controller.signal });
	expect(response.headers.get("content-type")).toContain("text/event-stream");
	const reader = response.body!.getReader();
	const first = await reader.read();
	const text = new TextDecoder().decode(first.value);
	expect(text.length).toBeGreaterThan(0);
	expect(text).not.toContain("credential");
	expect(text).not.toContain("uiCredential");
	controller.abort();
	await reader.cancel().catch(() => {});
	// 断开后代理仍能正常服务（流不会把事件循环或房间引擎卡住）。
	await expect
		.poll(
			async () => {
				const detail = await fetch(`${base}/api/device-center/rooms/${roomId}`);
				return detail.status;
			},
			{ timeout: 4000 },
		)
		.toBe(200);
});
