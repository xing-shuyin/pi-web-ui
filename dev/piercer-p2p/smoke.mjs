// Uses the real pi-web-ui TLS-PSK gateway with a synthetic desktop, not live user data.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter, once } from "node:events";
import http from "node:http";
import https from "node:https";
import { createInterface } from "node:readline";
import { WebSocket, WebSocketServer } from "ws";
import { createDeviceLanServer, probeDeviceLan } from "../../server/device-center/device-lan.ts";

const binary = process.argv[2];
assert(binary, "Usage: node --import tsx dev/piercer-p2p/smoke.mjs <proof-binary>");
const cleanup = [];
const checks = [];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const file = randomBytes(8 * 1024 * 1024);
const frame = randomBytes(256 * 1024);
const received = [];
const timeout = () => AbortSignal.timeout(10_000);

async function request(connection, path, body) {
	return new Promise((resolve, reject) => {
		const req = https.request(
			connection.origin + path,
			{ agent: connection.agent, method: body ? "POST" : "GET", signal: timeout() },
			(res) => {
				const chunks = [];
				res.on("data", (chunk) => chunks.push(chunk));
				res.on("error", reject);
				res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
			},
		);
		req.on("error", reject);
		req.end(body);
	});
}

async function socket(connection, path) {
	const ws = new WebSocket(connection.origin.replace("https:", "wss:") + path, {
		agent: connection.agent,
		handshakeTimeout: 5000,
	});
	ws.on("error", () => {});
	cleanup.push(() => ws.terminate());
	await once(ws, "open", { signal: timeout() });
	return ws;
}

async function main() {
	const server = http.createServer((req, res) => {
		received.push({ path: req.url, auth: req.headers.authorization, origin: req.headers.origin });
		if (req.url === "/api/health") return res.end('{"ok":true}');
		if (req.url === "/assets/proof.bin") return res.end(file);
		if (req.url === "/desktop-preview") return res.end("<!doctype html><title>preview fixture</title>");
		if (req.url === "/api/echo") return req.pipe(res);
		res.writeHead(404).end();
	});
	const tcpSockets = new Set();
	server.on("connection", (tcp) => {
		tcpSockets.add(tcp);
		tcp.on("close", () => tcpSockets.delete(tcp));
	});
	cleanup.push(() => {
		for (const tcp of tcpSockets) tcp.destroy();
		return new Promise((resolve) => server.close(resolve));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const port = server.address().port;
	assert(port >= 8900);
	const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
	cleanup.push(() => {
		for (const ws of wss.clients) ws.terminate();
		wss.close();
	});
	server.on("upgrade", (req, tcp, head) => {
		received.push({ path: req.url, auth: req.headers.authorization, origin: req.headers.origin });
		wss.handleUpgrade(req, tcp, head, (ws) => {
			ws.on("error", () => {});
			ws.on("message", (data, binary) => {
				if (req.url === "/desktop-ws" && data.toString() === "next") ws.send(frame);
				else ws.send(data, { binary });
			});
		});
	});
	const localOrigin = `http://127.0.0.1:${port}`;
	const lan = createDeviceLanServer({
		localOrigin,
		localAuthToken: "synthetic-proof-token",
		addresses: () => ["127.0.0.1"],
	});
	cleanup.push(lan.close);
	const grant = await lan.issueGrant();
	assert(grant);
	assert(grant.port >= 8900);

	const events = new EventEmitter();
	const child = spawn(binary, ["--target-port", String(grant.port)], {
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
	let stderr = "";
	child.stderr.on("data", (bytes) => (stderr = (stderr + bytes).slice(-4096)));
	child.on("error", (error) => events.emit("error", error));
	child.on("exit", (code) => {
		if (code) events.emit("error", new Error(`helper exited ${code}: ${stderr}`));
	});
	events.on("error", () => {});
	const lines = createInterface({ input: child.stdout });
	lines.on("line", (line) => {
		try {
			const message = JSON.parse(line);
			events.emit(message.type, message);
		} catch (error) {
			events.emit("error", error);
		}
	});
	cleanup.push(async () => {
		if (child.exitCode === null) {
			child.stdin.end("quit\n");
			try {
				await once(child, "exit", { signal: AbortSignal.timeout(3000) });
			} catch {
				child.kill();
				await once(child, "exit", { signal: AbortSignal.timeout(3000) }).catch(() => {});
			}
		}
		lines.close();
	});
	const [ready] = await once(events, "ready", { signal: timeout() });
	assert.equal(ready.localCandidate, "host");
	assert.equal(ready.remoteCandidate, "host");
	assert.equal(ready.protocol, "udp");
	checks.push("real Pion WebRTC host/host UDP pair (loopback only)");
	const tunneled = { ...grant, port: ready.port };
	const connection = await probeDeviceLan(tunneled, { allowLoopback: true, timeoutMs: 5000 });
	assert(connection, "real TLS-PSK health check must succeed through the DataChannel");
	cleanup.push(connection.close);
	checks.push("existing TLS-PSK authentication through the P2P byte stream");
	const page = await request(connection, "/desktop-preview");
	assert.equal(page.status, 200);
	assert.match(page.body.toString(), /preview fixture/);
	const upload = randomBytes(128 * 1024);
	const echo = await request(connection, "/api/echo", upload);
	assert.equal(echo.status, 200);
	assert.equal(hash(echo.body), hash(upload));
	checks.push("preview HTML and 128 KiB HTTP upload with SHA-256 equality");

	const desktop = await socket(connection, "/desktop-ws");
	const chat = await socket(connection, "/ws");
	const started = performance.now();
	await Promise.all([
		(async () => {
			const download = await request(connection, "/assets/proof.bin");
			assert.equal(download.status, 200);
			assert.equal(hash(download.body), hash(file));
		})(),
		(async () => {
			for (let index = 0; index < 32; index++) {
				const next = once(desktop, "message", { signal: timeout() });
				desktop.send("next");
				const [data, binary] = await next;
				assert(binary);
				assert.equal(hash(data), hash(frame));
			}
		})(),
		(async () => {
			for (let index = 0; index < 32; index++) {
				const next = once(chat, "message", { signal: timeout() });
				const message = JSON.stringify({ index, text: "synthetic chat event" });
				chat.send(message);
				const [data, binary] = await next;
				assert(!binary);
				assert.equal(data.toString(), message);
			}
		})(),
	]);
	const transferMs = Math.round(performance.now() - started);
	checks.push("concurrent 8 MiB download, 32 x 256 KiB desktop binary messages, 32 chat messages");
	assert(received.every((req) => req.auth === "Bearer synthetic-proof-token" && req.origin === localOrigin));
	checks.push("target receives only its own injected authorization and Origin");
	const statsReply = once(events, "stats", { signal: timeout() });
	child.stdin.write("stats\n");
	const [stats] = await statsReply;
	assert(stats.maxBuffered <= 512 * 1024 + 16 * 1024);
	assert(stats.streams >= 3);
	checks.push("per-stream send queue bounded to 512 KiB plus one 16 KiB chunk");

	const denied = await probeDeviceLan(
		{ ...tunneled, key: randomBytes(32).toString("base64url") },
		{ allowLoopback: true, timeoutMs: 1000 },
	);
	assert.equal(denied, null);
	checks.push("wrong TLS-PSK credential rejected over the P2P stream");
	const desktopClosed = once(desktop, "close", { signal: timeout() });
	const chatClosed = once(chat, "close", { signal: timeout() });
	lan.revoke(grant.identity);
	await Promise.all([desktopClosed, chatClosed]);
	const revoked = await probeDeviceLan(tunneled, { allowLoopback: true, timeoutMs: 1000 });
	assert.equal(revoked, null);
	checks.push("grant revocation closes live desktop/chat streams and rejects reconnection");
	console.log(
		JSON.stringify(
			{
				ok: true,
				scope: ready.scope,
				pion: "v3.2.32 (same version as Piercer reference)",
				checks,
				transferMs,
				stats,
				notTested: [
					"cross-machine NAT traversal",
					"production Hub signaling",
					"real desktop capture/FPS",
					"Hub fallback",
					"macOS/Linux runtime",
				],
			},
			null,
			2,
		),
	);
}

try {
	await main();
} finally {
	for (const stop of cleanup.reverse()) await stop();
}
