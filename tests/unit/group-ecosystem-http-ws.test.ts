import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { installLocalDeviceCenter } from "../../server/device-center/local.js";
import { createLocalBotRegistry } from "../../server/device-center/bots.js";
import { handleCanvasMessage } from "../../server/canvas/canvas-dispatch.js";
import { CanvasOrchestrator } from "../../server/canvas/canvas-orchestrator.js";
import { DeviceHubStore } from "../../server/device-center/store.js";
import { safePath } from "../../server/device-center/relay.js";
import type { CanvasGraph, ClientMessage, ServerMessage } from "../../server/protocol.js";

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
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "group-ecosystem-"));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const cwd = join(root, "project"),
		dataDir = join(root, "data");
	await Promise.all([mkdir(cwd), mkdir(dataDir)]);
	const bots = await createLocalBotRegistry(dataDir);
	const app = express();
	app.use(express.json());
	const local = await installLocalDeviceCenter({
		app,
		dataDir,
		bots,
		botCatalog: { dataDir, defaultCwd: cwd, models: async () => [] },
		connect: () => ({ close() {} }),
	});
	cleanup.push(() => local.close());
	const server = createServer(app),
		base = await listen(server);
	const request = async (path: string, body?: unknown) => {
		const response = await fetch(`${base}/api/device-center/${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers: { Origin: base, "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		return { status: response.status, data: await response.json() };
	};
	await request("chat-status");
	const created = await request("local-bots", {
		name: "worker",
		description: "kept",
		systemPrompt: "original",
		cwd,
		tools: ["read"],
		skills: [],
		mcpServers: [],
		enabled: true,
	});
	expect(created.status).toBe(200);
	return { cwd, dataDir, bots, server, base, request, bot: created.data.bot };
}
function graph(): CanvasGraph {
	return {
		id: "group_explicit",
		name: "Local group graph",
		viewport: { x: 0, y: 0, zoom: 1 },
		status: "idle",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		nodes: [
			{
				id: "input",
				title: "input",
				role: "trigger",
				x: 0,
				y: 0,
				width: 240,
				engine: "pi",
				model: "",
				cwd: ".",
				useWorktree: false,
				status: "idle",
				config: { payload: "hello group" },
			},
		],
		edges: [],
	};
}
describe("group ecosystem real HTTP and WS", () => {
	it("reads actual local configuration; preserves omitted grants; rejects stale, busy and untrusted presets", async () => {
		const { request, bot, bots, cwd } = await fixture();
		const path = `local-bots/${bot.id}`;
		expect(safePath(`/api/device-center/${path}`, "GET")).toBe(false);
		expect(safePath(`/api/device-center/${path}/preset`, "POST")).toBe(false);
		const read = await request(path);
		expect(read.data.bot).toMatchObject({ revision: 1, cwd, tools: ["read"], systemPrompt: "original" });
		const saved = await request(`${path}/preset`, { revision: 1, preset: { systemPrompt: "reviewed" } });
		expect(saved.status).toBe(200);
		expect(saved.data.bot).toMatchObject({
			revision: 2,
			cwd,
			tools: ["read"],
			skills: [],
			mcpServers: [],
			description: "kept",
			systemPrompt: "reviewed",
		});
		expect((await request(`${path}/preset`, { revision: 1, preset: { tools: [] } })).status).toBe(409);
		for (const preset of [
			{ customInstructions: "wrong" },
			{ cwd: "elsewhere" },
			{ tools: ["invented_tool"] },
			{ model: { provider: "secret", modelId: "absent" } },
			{ apiKey: "credential-must-not-escape" },
		])
			expect((await request(`${path}/preset`, { revision: 2, preset })).status).toBe(400);
		const lease = await bots.acquire(bot.id);
		try {
			const busy = await request(`${path}/preset`, { revision: 2, preset: { tools: [] } });
			expect(busy.status).toBe(409);
			expect(busy.data.code).toBe("BOT_BUSY");
			expect(lease.bot.tools).toEqual(["read"]);
		} finally {
			lease.release();
		}
		const final = await request(path);
		expect(final.data.bot.revision).toBe(2);
		expect(final.data.bot.tools).toEqual(["read"]);
		expect(JSON.stringify(final)).not.toContain("credential-must-not-escape");
		expect((await request("local-bots/remote-bot")).status).toBe(404);
		const revoked = await request(`${path}/preset`, { revision: 2, preset: { tools: [] } });
		expect(revoked.status).toBe(200);
		expect(revoked.data.bot).toMatchObject({ revision: 3, cwd, tools: [], systemPrompt: "reviewed" });
	});
	it("persists group references through HTTP without running, then explicitly runs the chosen graph/cwd over WS", async () => {
		const { server, dataDir, request, base, bot, cwd } = await fixture();
		const room = await request("rooms", { name: "Canvas group", botIds: [bot.id] });
		expect(room.status).toBe(201);
		const roomId = room.data.room.id;
		const orchestrator = new CanvasOrchestrator(cwd, dataDir);
		const wss = new WebSocketServer({ server, path: "/ws" });
		orchestrator.setBroadcaster((msg: ServerMessage) => {
			for (const client of wss.clients) client.send(JSON.stringify(msg));
		});
		wss.on("connection", (socket) =>
			socket.on("message", (raw) =>
				handleCanvasMessage(
					JSON.parse(String(raw)) as ClientMessage,
					dataDir,
					orchestrator,
					(msg) => socket.send(JSON.stringify(msg)),
					{ runBase: dataDir },
				),
			),
		);
		const ws = new WebSocket(base.replace("http:", "ws:") + "/ws");
		cleanup.push(async () => {
			ws.terminate();
			for (const socket of wss.clients) socket.terminate();
			await new Promise<void>((resolve) => wss.close(() => resolve()));
			orchestrator.stopAll(graph().id);
		});
		const messages: ServerMessage[] = [];
		ws.on("message", (data) => messages.push(JSON.parse(String(data))));
		await new Promise<void>((resolve, reject) => {
			ws.once("open", resolve);
			ws.once("error", reject);
		});
		const send = (msg: ClientMessage) => ws.send(JSON.stringify(msg));
		const wait = async (predicate: (msg: ServerMessage) => boolean) => {
			for (let attempt = 0; attempt < 200; attempt++) {
				const found = messages.find(predicate);
				if (found) return found;
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			throw new Error(`WS result missing: ${JSON.stringify(messages)}`);
		};
		send({ type: "canvas_save", graph: graph(), baseRev: 0, requestId: "save" });
		await wait((msg) => msg.type === "canvas_graph_state" && msg.requestId === "save");
		send({ type: "canvas_list" });
		await wait((msg) => msg.type === "canvas_list_result" && msg.graphs.some((item) => item.id === graph().id));
		const binding = { deviceId: "local-device", graphId: graph().id, cwd, title: graph().name };
		expect((await request(`rooms/${roomId}/canvas`, { binding })).status).toBe(200);
		expect((await request(`rooms/${roomId}`)).data.room.canvasBinding).toEqual(binding);
		const persisted = await DeviceHubStore.open(join(dataDir, "local-device-hub"));
		expect(persisted.snapshot().rooms.find((item) => item.id === roomId)?.canvasBinding).toEqual(binding);
		expect(messages.some((msg) => msg.type === "canvas_node_event")).toBe(false);
		expect(
			(await request(`rooms/${roomId}/canvas`, { binding: { ...binding, deviceId: "remote-unknown" } })).status,
		).toBe(403);
		send({ type: "canvas_load", id: binding.graphId, requestId: "reference-only" });
		await wait((msg) => msg.type === "canvas_graph_state" && msg.requestId === "reference-only");
		expect(messages.some((msg) => msg.type === "canvas_node_event")).toBe(false);
		send({ type: "canvas_run_all", graphId: binding.graphId, cwd: join(cwd, "missing") });
		await wait((msg) => msg.type === "canvas_error" && msg.graphId === binding.graphId);
		expect(messages.some((msg) => msg.type === "canvas_node_event")).toBe(false);
		send({ type: "canvas_run_all", graphId: binding.graphId, cwd: binding.cwd });
		await wait((msg) => msg.type === "canvas_node_event" && msg.graphId === binding.graphId && msg.event === "done");
		expect(orchestrator.getNodeLog(binding.graphId, "input").some((entry) => entry.text.includes(cwd))).toBe(true);
		expect((await request(`rooms/${roomId}/canvas`, { binding: null })).status).toBe(200);
		expect((await request(`rooms/${roomId}`)).data.room.canvasBinding).toBeUndefined();
	});
});
