import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installLocalDeviceCenter } from "../../server/device-center/local.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});
async function listen(server: Server) {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanup.push(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
describe("local persistent conversation proxy", () => {
	it("forwards all conversation routes with UI authority and strict body allowlists", async () => {
		const received: {
			method: string;
			path: string;
			body: unknown;
			authorization: string | undefined;
			device: unknown;
		}[] = [];
		const upstream = express();
		upstream.use(express.json());
		upstream.use((req, res) => {
			received.push({
				method: req.method,
				path: req.path,
				body: req.body,
				authorization: req.headers.authorization,
				device: req.headers["x-device-id"],
			});
			res
				.status(req.method === "POST" ? 409 : 200)
				.json(req.method === "POST" ? { code: "CONVERSATION_BUSY", error: "busy" } : { conversations: [] });
		});
		const hubUrl = await listen(createServer(upstream));
		const dataDir = await mkdtemp(join(tmpdir(), "local-conversations-"));
		cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
		await writeFile(
			join(dataDir, "device-center.json"),
			JSON.stringify({
				hubUrl,
				deviceId: "source",
				name: "Source",
				credential: "agent-secret",
				uiCredential: "ui-secret",
				allowExecution: false,
			}),
		);
		const app = express();
		app.use(express.json());
		const local = await installLocalDeviceCenter({ app, dataDir, connect: () => ({ close() {} }) });
		cleanup.push(() => local.close());
		const base = await listen(createServer(app));
		const route = `${base}/api/device-center/rooms/team/conversations`;
		for (const suffix of ["", "/thread"]) {
			expect((await fetch(route + suffix)).status).toBe(200);
		}
		const create = { name: "Review", targetBotId: "original-bot", text: "Start", idempotencyKey: "new-key" };
		const continuation = { text: "Follow up", kind: "message", requestId: "request", idempotencyKey: "continue-key" };
		for (const [suffix, body] of [
			["", create],
			["/thread/messages", continuation],
		] as const) {
			const result = await fetch(route + suffix, {
				method: "POST",
				headers: { Origin: base, "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			expect(result.status).toBe(409);
			// The hub's own diagnosis must survive the proxy hop; a fixed "rejected" string made every
			// hub-side failure indistinguishable in the UI.
			expect(await result.json()).toEqual({
				code: "HUB_REJECTED",
				error: "busy",
				hubStatus: 409,
				hubCode: "CONVERSATION_BUSY",
			});
		}
		expect(received.map((entry) => entry.path)).toEqual([
			"/api/device-user/rooms/team/conversations",
			"/api/device-user/rooms/team/conversations/thread",
			"/api/device-user/rooms/team/conversations",
			"/api/device-user/rooms/team/conversations/thread/messages",
		]);
		expect(received[2].body).toEqual(create);
		expect(received[3].body).toEqual(continuation);
		for (const entry of received) {
			expect(entry.authorization).toBe("Bearer ui-secret");
			expect(entry.device).toBe("source");
		}
		for (const [suffix, body] of [
			["", { ...create, credential: "injected" }],
			["/thread/messages", { ...continuation, targetBotId: "other-bot" }],
		] as const) {
			expect(
				(
					await fetch(route + suffix, {
						method: "POST",
						headers: { Origin: base, "Content-Type": "application/json" },
						body: JSON.stringify(body),
					})
				).status,
			).toBe(400);
		}
		expect(
			(
				await fetch(route + "/thread/messages", {
					method: "POST",
					headers: { Origin: "https://other.test", "Content-Type": "application/json" },
					body: JSON.stringify(continuation),
				})
			).status,
		).toBe(403);
		expect(received).toHaveLength(4);
	});
	describe("error forwarding", () => {
		it("keeps the hub status, message and code for every allowed failure class", async () => {
			let reply: { status: number; body: unknown } = { status: 404, body: { error: "Task missing" } };
			const upstream = express();
			upstream.use((_req, res) => res.status(reply.status).json(reply.body));
			const hubUrl = await listen(createServer(upstream));
			const dataDir = await mkdtemp(join(tmpdir(), "local-errors-"));
			cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
			await writeFile(
				join(dataDir, "device-center.json"),
				JSON.stringify({
					hubUrl,
					deviceId: "source",
					name: "Source",
					credential: "agent-secret",
					uiCredential: "ui-secret",
					allowExecution: false,
				}),
			);
			const app = express();
			app.use(express.json());
			const local = await installLocalDeviceCenter({ app, dataDir, connect: () => ({ close() {} }) });
			cleanup.push(() => local.close());
			const route = `${await listen(createServer(app))}/api/device-center/rooms/team/tasks/task`;
			const get = async () => {
				const result = await fetch(route);
				return { status: result.status, body: await result.json() };
			};
			expect(await get()).toEqual({
				status: 404,
				body: { code: "HUB_REJECTED", error: "Task missing", hubStatus: 404 },
			});
			reply = { status: 409, body: { code: "ACTIVE_TASKS", error: "remove blocked" } };
			expect(await get()).toEqual({
				status: 409,
				body: {
					code: "ACTIVE_TASKS",
					error: "Stop active tasks before removing members, clearing messages or deleting this group",
				},
			});
			reply = { status: 401, body: { error: "UI device authentication required; pair again" } };
			expect(await get()).toEqual({
				status: 409,
				body: { code: "REPAIR_REQUIRED", error: "Pair this computer again", hubStatus: 401 },
			});
			reply = { status: 403, body: { error: "Plan approval is restricted to human users" } };
			expect(await get()).toEqual({
				status: 403,
				body: { code: "HUB_FORBIDDEN", error: "Plan approval is restricted to human users", hubStatus: 403 },
			});
			reply = { status: 500, body: {} };
			expect(await get()).toEqual({
				status: 502,
				body: { code: "HUB_REJECTED", error: "Hub rejected group request", hubStatus: 500 },
			});
			// The forwarded cause is scrubbed: the hub may echo configured credentials back.
			reply = { status: 403, body: { error: "denied for ui-secret and agent-secret" } };
			const scrubbed = await get();
			expect(scrubbed.status).toBe(403);
			expect(JSON.stringify(scrubbed.body)).not.toContain("ui-secret");
			expect(JSON.stringify(scrubbed.body)).not.toContain("agent-secret");
			expect(scrubbed.body).toMatchObject({ code: "HUB_FORBIDDEN", error: "denied for [REDACTED] and [REDACTED]" });
		});
	});
});
