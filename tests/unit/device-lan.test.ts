import { randomBytes } from "node:crypto";
import { once } from "node:events";
import http, { type IncomingHttpHeaders } from "node:http";
import https from "node:https";
import net, { type Socket } from "node:net";
import tls from "node:tls";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
	createDeviceLanServer,
	probeDeviceLan,
	type DeviceLanConnection,
	type DeviceLanGrant,
} from "../../server/device-center/device-lan.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function listen(server: net.Server, host = "127.0.0.1", port = 0) {
	server.listen(port, host);
	await once(server, "listening");
	return (server.address() as net.AddressInfo).port;
}
function track(server: net.Server) {
	const sockets = new Set<Socket>();
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	cleanups.push(async () => {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	return sockets;
}
function request(
	connection: DeviceLanConnection,
	path: string,
	options: {
		method?: string;
		body?: Buffer | string;
		headers?: IncomingHttpHeaders;
	} = {},
) {
	return new Promise<{ status: number; body: Buffer; headers: IncomingHttpHeaders }>((resolve, reject) => {
		const req = https.request(
			`${connection.origin}${path}`,
			{
				agent: connection.agent,
				method: options.method ?? "GET",
				headers: options.headers,
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("error", reject);
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("end", () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks), headers: res.headers }));
			},
		);
		req.setTimeout(2000, () => req.destroy(new Error("request timeout")));
		req.on("error", reject);
		req.end(options.body);
	});
}
async function fixture(options: { enabled?: () => boolean | Promise<boolean>; addresses?: () => string[] } = {}) {
	const requests: { path: string; headers: IncomingHttpHeaders; body: Buffer }[] = [];
	let health = 200;
	const local = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const body = Buffer.concat(chunks);
			requests.push({ path: req.url!, headers: req.headers, body });
			res.setHeader("set-cookie", "private=must-not-cross");
			res.setHeader("authorization", "private-response");
			res.setHeader("x-safe-header", "kept");
			if (req.url === "/api/health") res.writeHead(health).end("ok");
			else if (req.url === "/api/echo") res.end(body);
			else if (req.url === "/api/device-desktop/status") res.end(JSON.stringify({ available: false }));
			else res.end(JSON.stringify({ enabled: true }));
		});
	});
	track(local);
	const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
	cleanups.push(() => {
		for (const ws of wss.clients) ws.terminate();
		wss.close();
	});
	const peers: WebSocket[] = [];
	const upgrades: IncomingHttpHeaders[] = [];
	local.on("upgrade", (req, socket, head) => {
		upgrades.push(req.headers);
		wss.handleUpgrade(req, socket, head, (ws) => {
			peers.push(ws);
			ws.on("error", () => {});
			ws.on("message", (data, binary) => ws.send(data, { binary }));
		});
	});
	const port = await listen(local);
	const origin = `http://127.0.0.1:${port}`;
	const lan = createDeviceLanServer({
		localOrigin: origin,
		localAuthToken: "local-secret",
		addresses: () => ["127.0.0.1"],
		...options,
	});
	cleanups.push(lan.close);
	const grant = await lan.issueGrant();
	return {
		lan,
		grant,
		local,
		peers,
		upgrades,
		requests,
		origin,
		setHealth: (value: number) => {
			health = value;
		},
	};
}
async function connect(grant: DeviceLanGrant) {
	const connection = await probeDeviceLan(grant, { allowLoopback: true });
	expect(connection).not.toBeNull();
	cleanups.push(connection!.close);
	return connection!;
}
async function websocket(connection: DeviceLanConnection, path = "/desktop-ws?viewOnly=0") {
	const ws = new WebSocket(connection.origin.replace("https:", "wss:") + path, {
		agent: connection.agent,
		headers: { cookie: "browser-secret", authorization: "Bearer browser-secret", origin: "https://browser.invalid" },
	});
	ws.on("error", () => {});
	cleanups.push(() => ws.terminate());
	await once(ws, "open");
	return ws;
}
function echo(ws: WebSocket, data: string | Buffer) {
	const reply = once(ws, "message") as Promise<[RawData, boolean]>;
	ws.send(data);
	return reply;
}

describe("authenticated LAN device transport", () => {
	it("uses real TLS 1.2 PSK with no certificate and a reusable authenticated Agent", async () => {
		const { grant } = await fixture();
		expect(grant!.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(grant!.expiresAt - Date.now()).toBeGreaterThan(29 * 60_000);
		const connection = await connect(grant!);
		expect(connection.agent.options.rejectUnauthorized).not.toBe(false);
		const response = await request(connection, "/api/device-desktop/status");
		expect(JSON.parse(response.body.toString())).toEqual({ available: false });
		const socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
			const socket = tls.connect(
				{
					host: "127.0.0.1",
					port: grant!.port,
					minVersion: "TLSv1.2",
					maxVersion: "TLSv1.2",
					ciphers: "PSK-AES128-GCM-SHA256",
					checkServerIdentity: () => undefined,
					pskCallback: () => ({ identity: grant!.identity, psk: Buffer.from(grant!.key, "base64url") }),
				},
				() => resolve(socket),
			);
			socket.on("error", reject);
		});
		expect(socket.getProtocol()).toBe("TLSv1.2");
		expect(socket.getCipher().name).toBe("PSK-AES128-GCM-SHA256");
		expect(socket.getPeerCertificate()).toEqual({});
		socket.destroy();
	});

	it("rewrites local auth, Host and Origin and strips cookies and hop-by-hop headers", async () => {
		const { grant, requests, origin } = await fixture();
		const connection = await connect(grant!);
		const response = await request(connection, "/api/device-desktop/setup/enable", {
			method: "POST",
			body: '{"enabled":true}',
			headers: {
				cookie: "browser-cookie",
				authorization: "Bearer browser-secret",
				host: "evil.invalid",
				origin: "https://evil.invalid",
				connection: "keep-alive, x-private-hop",
				"x-private-hop": "secret",
				"content-type": "application/json",
			},
		});
		expect(response.status).toBe(200);
		expect(response.headers["set-cookie"]).toBeUndefined();
		expect(response.headers.authorization).toBeUndefined();
		expect(response.headers["x-safe-header"]).toBe("kept");
		const forwarded = requests.at(-1)!;
		expect(forwarded.body.toString()).toBe('{"enabled":true}');
		expect(forwarded.headers).toMatchObject({
			host: new URL(origin).host,
			origin,
			authorization: "Bearer local-secret",
		});
		expect(forwarded.headers.cookie).toBeUndefined();
		expect(forwarded.headers["x-private-hop"]).toBeUndefined();
	});

	it("forwards encrypted binary desktop frames and text input without exposing browser credentials", async () => {
		const { grant, upgrades } = await fixture();
		const ws = await websocket(await connect(grant!));
		const control = '{"type":"pointer","x":0.25,"y":0.5,"action":"move"}';
		const [text, binary] = await echo(ws, control);
		expect(text.toString()).toBe(control);
		expect(binary).toBe(false);
		const frame = randomBytes(4096);
		const [reply, isBinary] = await echo(ws, frame);
		expect(Buffer.compare(reply as Buffer, frame)).toBe(0);
		expect(isBinary).toBe(true);
		expect(upgrades[0].cookie).toBeUndefined();
		expect(upgrades[0].authorization).toBe("Bearer local-secret");
	});

	it("carries a full chat snapshot larger than relay control frames and streams large HTTP bodies", async () => {
		const { grant } = await fixture();
		const connection = await connect(grant!);
		const ws = await websocket(connection, "/ws");
		const snapshot = Buffer.alloc(700 * 1024, 120);
		expect(Buffer.compare((await echo(ws, snapshot))[0] as Buffer, snapshot)).toBe(0);
		const upload = Buffer.alloc(2 * 1024 * 1024, 101);
		const response = await request(connection, "/api/echo", { method: "POST", body: upload });
		expect(response.status).toBe(200);
		expect(response.body.equals(upload)).toBe(true);
	});

	it("rejects desktop input and HTTP bodies over 16KB", async () => {
		const { grant, requests } = await fixture();
		const connection = await connect(grant!);
		const response = await request(connection, "/api/device-desktop/setup/enable", {
			method: "POST",
			headers: { "content-length": "16385" },
			body: Buffer.alloc(16385),
		});
		expect(response.status).toBe(413);
		expect(requests.some((r) => r.path.endsWith("setup/enable"))).toBe(false);
		const ws = await websocket(connection);
		const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
		ws.send(Buffer.alloc(16385));
		await closed;
	});

	it("rejects generic HTTP bodies declared above 64MB before opening the local route", async () => {
		const { grant, requests } = await fixture();
		const response = await request(await connect(grant!), "/api/echo", {
			method: "POST",
			headers: { "content-length": String(64 * 1024 * 1024 + 1) },
		});
		expect(response.status).toBe(413);
		expect(requests.some((r) => r.path === "/api/echo")).toBe(false);
	});

	it("rejects desktop output larger than 4MB", async () => {
		const { grant, peers } = await fixture();
		const ws = await websocket(await connect(grant!));
		await echo(ws, "ready");
		const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
		peers[0].send(Buffer.alloc(4 * 1024 * 1024 + 1));
		await closed;
	});

	it("rejects incorrect PSKs and identities, and refuses certificate ciphers", async () => {
		const { grant } = await fixture();
		expect(
			await probeDeviceLan({ ...grant, key: randomBytes(32).toString("base64url") }, { allowLoopback: true }),
		).toBeNull();
		expect(
			await probeDeviceLan({ ...grant, identity: randomBytes(24).toString("base64url") }, { allowLoopback: true }),
		).toBeNull();
		const refused = await new Promise<boolean>((resolve) => {
			const socket = tls.connect({
				host: "127.0.0.1",
				port: grant!.port,
				minVersion: "TLSv1.2",
				maxVersion: "TLSv1.2",
				ciphers: "ECDHE-RSA-AES128-GCM-SHA256",
			});
			socket.once("error", () => {
				socket.destroy();
				resolve(true);
			});
			socket.once("secureConnect", () => {
				socket.destroy();
				resolve(false);
			});
		});
		expect(refused).toBe(true);
	});

	it("validates every grant field and rejects public, link-local and loopback addresses by default", async () => {
		const { grant } = await fixture();
		for (const invalid of [
			null,
			[],
			{},
			{ ...grant, addresses: [] },
			{ ...grant, port: 0 },
			{ ...grant, port: 1.5 },
			{ ...grant, key: "short" },
			{ ...grant, identity: "short" },
			{ ...grant, expiresAt: Date.now() - 1 },
			{ ...grant, expiresAt: Date.now() + 31 * 60_000 },
			{ ...grant, extra: true },
			...["8.8.8.8", "169.254.169.254", "0.0.0.0", "::1", "127.0.0.1", "localhost", "10.0.0.1/path"].map((address) => ({
				...grant,
				addresses: [address],
			})),
		]) {
			expect(await probeDeviceLan(invalid)).toBeNull();
		}
	});

	it("applies relay path validation to HTTP and WebSocket upgrades", async () => {
		const { grant, requests, upgrades } = await fixture();
		const connection = await connect(grant!);
		for (const path of [
			"/api/device-desktop/local/permissions",
			"/api/device-desktop/%6cocal/status",
			"/api/device-center/local/status",
			"/api/setup",
			"//evil.invalid/status",
			"/%252e%252e/api/device-desktop/local/status",
		]) {
			const reply = await request(connection, path);
			expect(reply.status, path).toBe(403);
		}
		expect(requests.every((r) => r.path === "/api/health")).toBe(true);
		const ws = new WebSocket(connection.origin.replace("https:", "wss:") + "/api/device-desktop/local/permissions", {
			agent: connection.agent,
		});
		const error = once(ws, "error");
		ws.on("error", () => {});
		await error;
		expect(upgrades).toHaveLength(0);
	});

	it("probes candidates in parallel and destroys the hanging losing connection", async () => {
		const grant: DeviceLanGrant = {
			addresses: ["127.0.0.2", "127.0.0.1"],
			port: 0,
			identity: randomBytes(24).toString("base64url"),
			key: randomBytes(32).toString("base64url"),
			expiresAt: Date.now() + 60_000,
		};
		const good = https.createServer(
			{
				minVersion: "TLSv1.2",
				maxVersion: "TLSv1.2",
				ciphers: "PSK-AES128-GCM-SHA256",
				pskCallback: (_socket, identity) => (identity === grant.identity ? Buffer.from(grant.key, "base64url") : null),
			},
			(_req, res) => res.end("ok"),
		);
		track(good);
		grant.port = await listen(good);
		const stalled = net.createServer((socket) => socket.resume());
		const losers = track(stalled);
		await listen(stalled, "127.0.0.2", grant.port);
		const start = performance.now();
		const connection = await connect(grant);
		expect(connection.origin).toBe(`https://127.0.0.1:${grant.port}`);
		expect(performance.now() - start).toBeLessThan(650);
		await new Promise<void>((resolve) => setTimeout(resolve, 40));
		expect(losers.size).toBe(0);
	});

	it("enforces a total deadline even when a peer never completes TLS, and supports cancellation", async () => {
		const blackhole = net.createServer((socket) => socket.resume());
		const sockets = track(blackhole);
		const grant: DeviceLanGrant = {
			addresses: ["127.0.0.1"],
			port: await listen(blackhole),
			identity: randomBytes(24).toString("base64url"),
			key: randomBytes(32).toString("base64url"),
			expiresAt: Date.now() + 60_000,
		};
		const start = performance.now();
		expect(await probeDeviceLan(grant, { allowLoopback: true, timeoutMs: 70 })).toBeNull();
		expect(performance.now() - start).toBeLessThan(400);
		const controller = new AbortController();
		const probing = probeDeviceLan(grant, { allowLoopback: true, signal: controller.signal });
		controller.abort();
		expect(await probing).toBeNull();
		await new Promise<void>((resolve) => setTimeout(resolve, 40));
		expect(sockets.size).toBe(0);
	});

	it("requires healthy local HTTP but does not require desktop capture enabled", async () => {
		const f = await fixture();
		expect(f.grant).not.toBeNull();
		f.setHealth(503);
		expect(await f.lan.issueGrant()).toBeNull();
		f.setHealth(200);
		expect(await f.lan.issueGrant()).not.toBeNull();
		const disabled = await fixture({ enabled: () => false });
		expect(disabled.grant).toBeNull();
		const unsafe = await fixture({ addresses: () => ["8.8.8.8"] });
		expect(unsafe.grant).toBeNull();
	});

	it("revokes the oldest grant at the 16-grant bound", async () => {
		const { lan, grant } = await fixture();
		for (let i = 0; i < 16; i++) expect(await lan.issueGrant()).not.toBeNull();
		expect(await probeDeviceLan(grant, { allowLoopback: true })).toBeNull();
	});

	it("revokes only the cancelled grant without interrupting other active device sessions", async () => {
		const { lan, grant } = await fixture();
		const first = await connect(grant!);
		const firstSocket = await websocket(first);
		await echo(firstSocket, "still-connected");
		const cancelled = await lan.issueGrant();
		const second = await connect(cancelled!);
		const secondSocket = await websocket(second);
		await echo(secondSocket, "cancel-this-session");
		const closed = new Promise<void>((resolve) => secondSocket.once("close", () => resolve()));
		lan.revoke(cancelled!.identity);
		await closed;
		expect((await echo(firstSocket, "unaffected"))[0].toString()).toBe("unaffected");
		expect((await request(first, "/api/health")).status).toBe(200);
		expect(await probeDeviceLan(cancelled, { allowLoopback: true })).toBeNull();
	});

	it("rejects an expired grant on an existing TLS connection and closes its desktop bridge", async () => {
		const { lan, grant, peers } = await fixture();
		const connection = await connect(grant!);
		const ws = await websocket(connection);
		await echo(ws, "ready");
		expect((await request(connection, "/api/health")).status).toBe(200);
		vi.spyOn(Date, "now").mockReturnValue(grant!.expiresAt + 1);
		expect((await request(connection, "/api/health")).status).toBe(403);
		expect(await probeDeviceLan(grant, { allowLoopback: true })).toBeNull();
		const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
		const upstreamClosed = new Promise<void>((resolve) => peers[0].once("close", () => resolve()));
		expect(await lan.issueGrant()).not.toBeNull();
		await Promise.all([closed, upstreamClosed]);
	});

	it("closes active upstream sockets, revokes grants and allows the same instance to reopen", async () => {
		const { lan, grant, peers } = await fixture();
		const connection = await connect(grant!);
		const ws = await websocket(connection);
		await echo(ws, "ready");
		const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
		const upstreamClosed = new Promise<void>((resolve) => peers[0].once("close", () => resolve()));
		lan.close();
		lan.close();
		await Promise.all([closed, upstreamClosed]);
		expect(await probeDeviceLan(grant, { allowLoopback: true })).toBeNull();
		const fresh = await lan.issueGrant();
		expect(fresh).not.toBeNull();
		expect(fresh!.identity).not.toBe(grant!.identity);
		expect((await request(await connect(fresh!), "/api/health")).status).toBe(200);
	});

	it("does not resurrect a listener when close races an asynchronous enabled check", async () => {
		let release!: (value: boolean) => void;
		const lan = createDeviceLanServer({
			localOrigin: "http://127.0.0.1:8900",
			addresses: () => ["127.0.0.1"],
			enabled: () =>
				new Promise((resolve) => {
					release = resolve;
				}),
		});
		cleanups.push(lan.close);
		const pending = lan.issueGrant();
		lan.close();
		release(true);
		expect(await pending).toBeNull();
	});
});
