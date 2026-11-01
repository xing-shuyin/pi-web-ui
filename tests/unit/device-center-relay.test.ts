import { afterEach, describe, expect, it, vi } from "vitest";
import http, { type Server } from "node:http";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import {
	createDeviceRelay,
	safePath,
	checkedUrl,
	cleanHeaders,
	decodeChunk,
} from "../../server/device-center/relay.js";
import { createDeviceConnector } from "../../server/device-center/connector.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const fn of cleanup.reverse()) fn();
	cleanup.length = 0;
});
async function listen(server: Server) {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	cleanup.push(() => {
		server.closeAllConnections();
		server.close();
	});
	return (server.address() as { port: number }).port;
}
async function request(
	port: number,
	host: string,
	path: string,
	headers: Record<string, string> = {},
	method = "GET",
	body?: string,
) {
	return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port, path, method, headers: { host, ...headers } }, (res) => {
			const data: Buffer[] = [];
			res.on("data", (chunk) => data.push(chunk));
			res.on("end", () =>
				resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(data).toString() }),
			);
		});
		req.on("error", reject);
		req.end(body);
	});
}
async function fixture(onCommand?: Parameters<typeof createDeviceConnector>[0]["onCommand"]) {
	const local = http.createServer((req, res) => {
		if (req.url === "/redirect") {
			res.writeHead(302, { location: `http://${req.headers.host}/next`, "set-cookie": "secret=yes" }).end();
			return;
		}
		if (req.url === "/sse") {
			res.writeHead(200, { "content-type": "text/event-stream", "content-security-policy": "sandbox" });
			res.write("data: one\n\n");
			setTimeout(() => res.end("data: two\n\n"), 20);
			return;
		}
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => res.end(JSON.stringify({ headers: req.headers, body: Buffer.concat(chunks).toString() })));
	});
	const localWs = new WebSocketServer({ server: local });
	localWs.on("connection", (ws) => ws.on("message", (data, binary) => ws.send(data, { binary })));
	cleanup.push(() => localWs.close());
	const localPort = await listen(local);
	let relay: ReturnType<typeof createDeviceRelay>;
	const server = http.createServer((req, res) => {
		if (relay.handleRequest(req, res)) return;
		if (req.url === "/api/devices/dev1/open") {
			void relay.handleOpen(req, res, "dev1");
			return;
		}
		res.writeHead(404).end();
	});
	const port = await listen(server);
	const events = vi.fn();
	relay = createDeviceRelay({
		server,
		publicUrl: `http://127.0.0.1:${port}`,
		deviceDomain: `devices.localhost:${port}`,
		authenticateDevice: (id, key) => id === "dev1" && key === "credential",
		getAccount: () => ({ id: "account" }),
		ownsDevice: (account, id) => account === "account" && id === "dev1",
		onTaskEvent: events,
	});
	cleanup.push(() => relay.close());
	const connector = createDeviceConnector({
		hubUrl: `http://127.0.0.1:${port}`,
		deviceId: "dev1",
		credential: "credential",
		localOrigin: `http://127.0.0.1:${localPort}`,
		localAuthToken: "local-secret",
		onTask: async (task) => {
			if (task.text === "fail") throw new Error("secret");
			return "done";
		},
		onCommand,
	});
	cleanup.push(() => connector.close());
	await vi.waitFor(() => expect(relay.isOnline("dev1")).toBe(true));
	const host = `dev1.devices.localhost:${port}`;
	const origin = `http://${host}`;
	const ticket = await request(
		port,
		`127.0.0.1:${port}`,
		"/api/devices/dev1/open",
		{ origin: `http://127.0.0.1:${port}` },
		"POST",
	);
	const url = new URL(JSON.parse(ticket.body).url);
	const opened = await request(port, host, url.pathname + url.search);
	const cookie = opened.headers["set-cookie"]![0].split(";")[0];
	return {
		port,
		host,
		origin,
		relay,
		connector,
		events,
		cookie,
		opened,
		ticketPath: url.pathname + url.search,
		localPort,
	};
}
describe("device reverse relay", () => {
	it("keeps connector tasks and RPC working without a device domain and refuses web opens", async () => {
		let relay: ReturnType<typeof createDeviceRelay>;
		const server = http.createServer((req, res) => {
			if (relay.handleRequest(req, res)) return;
			if (req.url === "/api/devices/dev1/open") return void relay.handleOpen(req, res, "dev1");
			res.writeHead(404).end();
		});
		const port = await listen(server);
		const publicUrl = `http://127.0.0.1:${port}`;
		const events = vi.fn();
		relay = createDeviceRelay({
			server,
			publicUrl,
			authenticateDevice: (id, key) => id === "dev1" && key === "credential",
			getAccount: () => "account",
			ownsDevice: () => true,
			onTaskEvent: events,
		});
		cleanup.push(() => relay.close());
		const connector = createDeviceConnector({
			hubUrl: publicUrl,
			deviceId: "dev1",
			credential: "credential",
			localOrigin: publicUrl,
			onTask: async () => "complete",
			onCommand: async () => ({ files: ["result.txt"] }),
		});
		cleanup.push(() => connector.close());
		await vi.waitFor(() => expect(relay.isOnline("dev1")).toBe(true));
		expect(await relay.callDevice("dev1", "transfer_preview", {})).toEqual({ files: ["result.txt"] });
		expect(
			relay.sendTask("dev1", {
				id: "task",
				botId: "bot-a",
				deviceId: "dev1",
				botRevision: 1,
				attemptId: "attempt",
				text: "run",
			}),
		).toBe(true);
		await vi.waitFor(() =>
			expect(events).toHaveBeenCalledWith(
				"dev1",
				expect.objectContaining({
					taskId: "task",
					botId: "bot-a",
					attemptId: "attempt",
					status: "completed",
				}),
			),
		);
		const opened = await request(port, `127.0.0.1:${port}`, "/api/devices/dev1/open", { origin: publicUrl }, "POST");
		expect(opened.status).toBe(409);
		expect(JSON.parse(opened.body)).toEqual({
			error: "Device web access requires an independent origin",
			code: "DEVICE_WEB_ORIGIN_REQUIRED",
		});
		expect((await request(port, `127.0.0.1:${port}`, "/__device/open?ticket=x")).status).toBe(404);
		expect(
			(await request(port, `127.0.0.1:${port}`, "/api/devices/dev1/open", { origin: "http://evil.test" }, "POST"))
				.status,
		).toBe(403);
	});
	it("accepts public HTTP independent device domains and rejects shared hub origins", () => {
		const server = http.createServer();
		const base = {
			server,
			publicUrl: "http://82.156.246.55:8790",
			authenticateDevice: () => false,
			getAccount: () => null,
			ownsDevice: () => false,
		};
		const relay = createDeviceRelay({ ...base, deviceDomain: "devices.example.com:8790" });
		cleanup.push(() => relay.close());
		expect(() => createDeviceRelay({ ...base, deviceDomain: "82.156.246.55:8791" })).toThrow("independent");
	});
	it("allows only the exact desktop ticket redirect", async () => {
		const f = await fixture();
		for (const [next, expected] of [
			["/desktop", "/desktop"],
			["https://evil.test", "/"],
			["//evil.test", "/"],
			["/desktop?x=1", "/"],
			["/desktop/", "/"],
			["/%64esktop", "/"],
		]) {
			const ticket = await request(
				f.port,
				`127.0.0.1:${f.port}`,
				"/api/devices/dev1/open",
				{ origin: `http://127.0.0.1:${f.port}` },
				"POST",
			);
			const url = new URL(JSON.parse(ticket.body).url);
			url.searchParams.set("next", next);
			const opened = await request(f.port, f.host, url.pathname + url.search);
			expect(opened.status).toBe(302);
			if (expected === "/desktop") {
				const desktop = new URL(String(opened.headers.location));
				expect(desktop.origin).toBe(`http://127.0.0.1:${f.port}`);
				expect(desktop.pathname).toBe("/device/dev1/__open");
				expect(desktop.searchParams.get("next")).toBe("/desktop");
				const wrapper = await request(f.port, `127.0.0.1:${f.port}`, desktop.pathname + desktop.search);
				expect(wrapper.status).toBe(200);
				expect(wrapper.body).toContain("sandbox=");
				expect(wrapper.body).not.toContain("allow-same-origin");
				expect((await request(f.port, `127.0.0.1:${f.port}`, desktop.pathname + desktop.search)).status).toBe(403);
			} else expect(opened.headers.location).toBe(expected);
			expect((await request(f.port, f.host, url.pathname + url.search)).status).toBe(403);
		}
	});
	it("reassembles 4MiB text snapshots and binary uploads in both directions", async () => {
		const f = await fixture();
		const ws = new WebSocket(`ws://127.0.0.1:${f.port}/echo`, {
			headers: { host: f.host, cookie: f.cookie, origin: f.origin },
			maxPayload: 16 * 1024 * 1024,
		});
		cleanup.push(() => ws.terminate());
		await once(ws, "open");
		for (const binary of [false, true]) {
			const data = Buffer.alloc(4 * 1024 * 1024, binary ? 0xab : 0x61);
			const response = Promise.race([
				once(ws, "message"),
				once(ws, "close").then((args) => {
					throw new Error(`WS closed: ${args}`);
				}),
			]);
			ws.send(data, { binary });
			const [received, isBinary] = await response;
			expect(isBinary).toBe(binary);
			expect(Buffer.from(received as Buffer).equals(data)).toBe(true);
		}
		expect(f.relay.isOnline("dev1")).toBe(true);
	}, 15_000);
	it("accepts fresh tasks after a transient disconnect on the same connector", async () => {
		const f = await fixture();
		expect(
			f.relay.sendTask("dev1", {
				id: "before",
				botId: "bot-a",
				deviceId: "dev1",
				botRevision: 1,
				attemptId: "a",
				text: "before",
			}),
		).toBe(true);
		await vi.waitFor(() =>
			expect(f.events).toHaveBeenCalledWith(
				"dev1",
				expect.objectContaining({
					taskId: "before",
					botId: "bot-a",
					attemptId: "a",
					status: "completed",
				}),
			),
		);
		f.relay.revoke("dev1");
		await vi.waitFor(() => expect(f.connector.isOnline()).toBe(false));
		await vi.waitFor(() => expect(f.relay.isOnline("dev1")).toBe(true), { timeout: 4000 });
		expect(
			f.relay.sendTask("dev1", {
				id: "after",
				botId: "bot-a",
				deviceId: "dev1",
				botRevision: 1,
				attemptId: "b",
				text: "after",
			}),
		).toBe(true);
		await vi.waitFor(() =>
			expect(f.events).toHaveBeenCalledWith(
				"dev1",
				expect.objectContaining({
					taskId: "after",
					botId: "bot-a",
					attemptId: "b",
					status: "completed",
				}),
			),
		);
	});
	it("chunks large commands, rejects missing handlers and propagates cancellation", async () => {
		let aborted = false;
		const f = await fixture(async (action, payload, signal) => {
			if (action === "transfer_apply") {
				await new Promise<void>((resolve) =>
					signal.addEventListener(
						"abort",
						() => {
							aborted = true;
							resolve();
						},
						{ once: true },
					),
				);
				return null;
			}
			return payload;
		});
		const bundle = { bundle: "x".repeat(2 * 1024 * 1024) };
		expect(await f.relay.callDevice("dev1", "transfer_stage", bundle)).toEqual(bundle);
		const controller = new AbortController();
		const pending = f.relay.callDevice("dev1", "transfer_apply", {}, { signal: controller.signal });
		await new Promise((resolve) => setTimeout(resolve, 20));
		controller.abort();
		await expect(pending).rejects.toThrow("cancelled");
		await vi.waitFor(() => expect(aborted).toBe(true));
		await expect(f.relay.callDevice("dev1", "shell" as any, {})).rejects.toThrow("forbidden");
		const blocker = new AbortController();
		const calls = Array.from({ length: 4 }, () =>
			f.relay.callDevice("dev1", "transfer_apply", {}, { signal: blocker.signal }),
		);
		const settled = Promise.allSettled(calls);
		await expect(f.relay.callDevice("dev1", "transfer_preview", {})).rejects.toThrow("capacity");
		blocker.abort();
		await settled;
		await expect(f.relay.callDevice("dev1", "transfer_stage", "x".repeat(12 * 1024 * 1024))).rejects.toThrow("large");
		const noHandler = await fixture();
		await expect(noHandler.relay.callDevice("dev1", "transfer_preview", {})).rejects.toThrow("rejected");
	});
	it("reports interrupted tasks and aborts connector work on disconnect", async () => {
		const f = await fixture();
		let aborted = false;
		const onDisconnect = vi.fn();
		const next = createDeviceConnector({
			hubUrl: `http://127.0.0.1:${f.port}`,
			deviceId: "dev1",
			credential: "credential",
			localOrigin: `http://127.0.0.1:${f.localPort}`,
			onDisconnect,
			onTask: async (_task, signal) => {
				await new Promise<void>((resolve) =>
					signal?.addEventListener(
						"abort",
						() => {
							aborted = true;
							resolve();
						},
						{ once: true },
					),
				);
				return "stopped";
			},
		});
		cleanup.push(() => next.close());
		await vi.waitFor(() => expect(next.isOnline()).toBe(true));
		expect(
			f.relay.sendTask("dev1", {
				id: "pending",
				botId: "bot-a",
				deviceId: "dev1",
				botRevision: 1,
				attemptId: "attempt",
				text: "run",
			}),
		).toBe(true);
		await vi.waitFor(() =>
			expect(f.events).toHaveBeenCalledWith(
				"dev1",
				expect.objectContaining({
					taskId: "pending",
					botId: "bot-a",
					attemptId: "attempt",
					status: "running",
				}),
			),
		);
		f.relay.revoke("dev1");
		await vi.waitFor(() => expect(aborted).toBe(true));
		await vi.waitFor(() => expect(onDisconnect).toHaveBeenCalled());
		expect(f.events).toHaveBeenCalledWith(
			"dev1",
			expect.objectContaining({
				taskId: "pending",
				botId: "bot-a",
				attemptId: "attempt",
				status: "interrupted",
			}),
		);
	});
	it.each([undefined, "bot-other"])(
		"rejects task receipts with botId %s and preserves the assigned Bot on interruption",
		async (botId) => {
			const f = await fixture();
			f.connector.close();
			await vi.waitFor(() => expect(f.relay.isOnline("dev1")).toBe(false));
			const device = new WebSocket(`ws://127.0.0.1:${f.port}/device-connect?deviceId=dev1`, {
				headers: { authorization: "Bearer credential" },
			});
			cleanup.push(() => device.terminate());
			await once(device, "open");
			const task = {
				id: "receipt",
				botId: "bot-a",
				deviceId: "dev1",
				botRevision: 1,
				attemptId: "attempt",
				text: "run",
			};
			const dispatched = once(device, "message");
			expect(f.relay.sendTask("dev1", task)).toBe(true);
			expect(JSON.parse((await dispatched)[0].toString())).toEqual({ type: "task", task });
			const disconnected = once(device, "close");
			device.send(
				JSON.stringify({
					type: "task_event",
					taskId: task.id,
					attemptId: task.attemptId,
					botId,
					status: "completed",
					report: "spoofed",
				}),
			);
			await disconnected;
			await vi.waitFor(() => expect(f.relay.isOnline("dev1")).toBe(false));
			await vi.waitFor(() =>
				expect(f.events).toHaveBeenCalledWith(
					"dev1",
					expect.objectContaining({
						taskId: task.id,
						botId: task.botId,
						attemptId: task.attemptId,
						status: "interrupted",
					}),
				),
			);
			expect(f.events).toHaveBeenCalledTimes(1);
		},
	);
	it("replaces a device connection without stale close losing its successor", async () => {
		const f = await fixture();
		const next = createDeviceConnector({
			hubUrl: `http://127.0.0.1:${f.port}`,
			deviceId: "dev1",
			credential: "credential",
			localOrigin: `http://127.0.0.1:${f.localPort}`,
		});
		cleanup.push(() => next.close());
		await vi.waitFor(() => expect(next.isOnline()).toBe(true));
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(f.relay.isOnline("dev1")).toBe(true);
	});
	it("blocks local desktop authorization routes for every relay transport after normalization", () => {
		for (const method of ["GET", "POST", "WS"]) {
			for (const path of [
				"/api/device-desktop/local",
				"/api/device-desktop/local/",
				"/api/device-desktop/local/status",
				"/api/device-desktop/local/permissions",
				"/api/device-desktop/local/enable",
				"/api/device-desktop/local/status?kind=screen",
				"/api/device-desktop/%6cocal/status",
				"/api/%64evice-desktop/local/permissions",
				"/api/device-desktop/%256cocal/enable",
				"/api/device-desktop/local%2fpermissions",
				"/api/device-desktop/local%252fpermissions",
				"/api/device-desktop/setup/../local/status",
				"/api/device-desktop/setup/%2e%2e/local/status",
				"/api/device-desktop/local/../local/permissions",
				"/API/DEVICE-DESKTOP/LOCAL/STATUS",
			])
				expect(safePath(path, method), `${method} ${path}`).toBe(false);
		}
		for (const path of ["/desktop", "/desktop?viewOnly=1", "/api/device-desktop/status"])
			expect(safePath(path, "GET"), path).toBe(true);
		for (const path of ["/desktop-ws", "/desktop-ws?viewOnly=1"]) expect(safePath(path, "WS"), path).toBe(true);
	});
	it("blocks ambiguous paths, management endpoints and insecure public URLs", () => {
		for (const path of [
			"/devices",
			"/devices/x",
			"/api/device-center/enable",
			"/setup",
			"/api/setup/x",
			"/%64evices",
			"/x/../devices",
			"/%252e%252e/devices",
			"/api%2fsetup",
			"/api%5csetup",
			"//evil",
			"/DEVICES",
		])
			expect(safePath(path), path).toBe(false);
		expect(safePath("/api/health?q=yes")).toBe(true);
		for (const path of [
			"/api/device-center/chat-status",
			"/api/device-center/devices",
			"/api/device-center/rooms",
			"/api/device-center/rooms/team",
			"/api/device-center/rooms/team/events",
		])
			expect(safePath(path, "GET"), path).toBe(true);
		for (const path of [
			"/api/device-center/rooms",
			"/api/device-center/rooms/team/messages",
			"/api/device-center/rooms/team/members",
			"/api/device-center/rooms/team/rename",
			"/api/device-center/rooms/team/delete",
			"/api/device-center/rooms/team/conversations/thread/deliveries",
			"/api/device-center/rooms/team/conversations/thread/reviews",
		])
			expect(safePath(path, "POST"), path).toBe(true);
		for (const method of ["GET", "POST", "WS", "DELETE"]) {
			for (const path of [
				"/api/device-center/workspaces",
				"/api/device-center/config",
				"/api/device-center/status",
				"/api/device-center/devices/target/open",
				"/api/device-center/pair",
				"/api/device-center/rooms/team/messages/extra",
			])
				expect(safePath(path, method), `${method} ${path}`).toBe(false);
		}
		for (const path of ["/api/device-center/bots", "/api/device-center/bots?roomId=member"])
			expect(safePath(path, "GET"), path).toBe(true);
		for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "WS"]) {
			for (const path of [
				"/api/device-center/local-bots",
				"/api/device-center/local-bots?roomId=member",
				"/api/device-center/local-bots/bot-a",
				"/api/device-center/bots/bot-a",
				"/api/device-center/workspaces?roomId=member",
			])
				expect(safePath(path, method), `${method} ${path}`).toBe(false);
			if (method !== "GET") {
				expect(safePath("/api/device-center/bots", method), method).toBe(false);
				expect(safePath("/api/device-center/chat-status", method), method).toBe(false);
			}
		}
		expect(safePath("/api/device-center/rooms", "WS")).toBe(false);
		expect(safePath("/api/device-center/rooms/team/messages", "GET")).toBe(false);
		expect(checkedUrl("http://82.156.246.55:8790").origin).toBe("http://82.156.246.55:8790");
		expect(checkedUrl("ws://82.156.246.55:8790").protocol).toBe("ws:");
		for (const url of ["file:///tmp/a", "http://user:password@example.com", "ws://example.com/#fragment"])
			expect(() => checkedUrl(url)).toThrow();
		expect(() => decodeChunk("!bad")).toThrow();
		expect(
			cleanHeaders({ host: "evil", cookie: "secret", authorization: "secret", origin: "evil", range: "bytes=0-3" }),
		).toEqual({ range: "bytes=0-3" });
	});
	it("exchanges a single-use ticket, filters credentials, streams SSE and uploads", async () => {
		const f = await fixture();
		expect(f.opened.status).toBe(302);
		expect(f.opened.headers["set-cookie"]![0]).toContain("device=");
		expect(f.opened.headers["set-cookie"]![0]).toContain("HttpOnly; SameSite=Lax");
		expect(f.opened.headers["set-cookie"]![0]).not.toContain("Secure");
		expect(f.opened.headers["set-cookie"]![0]).not.toContain("Domain=");
		expect((await request(f.port, f.host, f.ticketPath)).status).toBe(403);
		expect((await request(f.port, f.host, "/")).status).toBe(403);
		const result = await request(
			f.port,
			f.host,
			"/upload",
			{ cookie: `${f.cookie}; hub=secret`, origin: f.origin, authorization: "Bearer browser", range: "bytes=0-3" },
			"POST",
			"payload",
		);
		expect(result.status).toBe(200);
		const data = JSON.parse(result.body);
		expect(data.body).toBe("payload");
		expect(data.headers.authorization).toBe("Bearer local-secret");
		expect(data.headers.cookie).toBe("pi_web_token=local-secret");
		expect(data.headers.host).toBe(`127.0.0.1:${f.localPort}`);
		expect(data.headers.origin).toBe(`http://127.0.0.1:${f.localPort}`);
		expect(data.headers.range).toBe("bytes=0-3");
		const large = "z".repeat(256 * 1024);
		const upload = await request(f.port, f.host, "/upload", { cookie: f.cookie, origin: f.origin }, "POST", large);
		expect(JSON.parse(upload.body).body).toBe(large);
		const sse = await request(f.port, f.host, "/sse", { cookie: f.cookie });
		expect(sse.body).toBe("data: one\n\ndata: two\n\n");
		expect(sse.headers["content-security-policy"]).toBe("sandbox");
		const redirect = await request(f.port, f.host, "/redirect", { cookie: f.cookie });
		expect(redirect.headers.location).toBe("/next");
		expect(redirect.headers["set-cookie"]).toBeUndefined();
		expect((await request(f.port, f.host, "/", { cookie: f.cookie, origin: "https://evil.test" }, "POST")).status).toBe(
			403,
		);
	});
	it("denies management routes on both transport boundaries", async () => {
		const f = await fixture();
		for (const path of ["/devices", "/api/device-center/execute", "/%73etup", "/x/../api/setup"]) {
			expect((await request(f.port, f.host, path, { cookie: f.cookie })).status).toBe(400);
		}
	});
	it("forwards text/binary websocket messages, task outcomes, and revokes live sessions", async () => {
		const f = await fixture();
		const ws = new WebSocket(`ws://127.0.0.1:${f.port}/echo`, {
			headers: { host: f.host, cookie: f.cookie, origin: f.origin },
		});
		cleanup.push(() => ws.terminate());
		await once(ws, "open");
		await new Promise((resolve) => setTimeout(resolve, 40));
		const text = once(ws, "message");
		ws.send("hello");
		expect((await text)[0].toString()).toBe("hello");
		const binary = once(ws, "message");
		ws.send(Buffer.from([0, 1, 255]));
		const [bytes, isBinary] = await binary;
		expect(isBinary).toBe(true);
		expect(bytes).toEqual(Buffer.from([0, 1, 255]));
		expect(
			f.relay.sendTask("dev1", {
				id: "task",
				botId: "bot-a",
				deviceId: "dev1",
				botRevision: 1,
				attemptId: "attempt",
				text: "test",
			}),
		).toBe(true);
		await vi.waitFor(() =>
			expect(f.events).toHaveBeenCalledWith(
				"dev1",
				expect.objectContaining({
					taskId: "task",
					botId: "bot-a",
					attemptId: "attempt",
					status: "completed",
					report: "done",
				}),
			),
		);
		expect(
			f.relay.sendTask("dev1", {
				id: "failed",
				botId: "bot-a",
				deviceId: "dev1",
				botRevision: 1,
				attemptId: "attempt2",
				text: "fail",
			}),
		).toBe(true);
		await vi.waitFor(() =>
			expect(f.events).toHaveBeenCalledWith(
				"dev1",
				expect.objectContaining({
					taskId: "failed",
					botId: "bot-a",
					attemptId: "attempt2",
					status: "failed",
					report: expect.stringContaining("Device task failed"),
				}),
			),
		);
		const disconnected = once(ws, "close");
		f.relay.revoke("dev1");
		await disconnected;
		expect((await request(f.port, f.host, "/", { cookie: f.cookie })).status).toBe(403);
	});
});
