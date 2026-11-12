import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import http from "node:http";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";
const entry = (name) =>
	process.env.PI_P2P_TEST_PACKAGE_ROOT
		? pathToFileURL(join(resolve(process.env.PI_P2P_TEST_PACKAGE_ROOT), "dist/server/device-center", name + ".js")).href
		: new URL(`../server/device-center/${name}.ts`, import.meta.url).href;
const { createDeviceRelay } = await import(entry("relay"));
const { createDeviceConnector } = await import(entry("connector"));
const { createDeviceLanAccess } = await import(entry("device-lan-access"));
const { installLocalDeviceCenter } = await import(entry("local"));

process.env.PI_DEVICE_P2P_TEST_LOOPBACK = "1";
if (process.argv[2]) process.env.PI_DEVICE_P2P_HELPER = resolve(process.argv[2]);
const cleanups = [];
const deadline = () => AbortSignal.timeout(15_000);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const blob = randomBytes(8 * 1024 * 1024);
const frame = randomBytes(256 * 1024);
const requests = [];
async function listen(server) {
	const sockets = new Set();
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	assert(server.address().port >= 8900);
	cleanups.push(async () => {
		for (const socket of sockets) socket.destroy();
		await new Promise((resolve) => server.close(resolve));
	});
	return `http://127.0.0.1:${server.address().port}`;
}
async function websocket(url) {
	const socket = new WebSocket(url.replace(/^http/, "ws"), { origin: "null", handshakeTimeout: 5000 });
	socket.on("error", () => {});
	cleanups.push(() => socket.terminate());
	await once(socket, "open", { signal: deadline() });
	return socket;
}
async function main() {
	const target = http.createServer((req, res) => {
		requests.push({ path: req.url, auth: req.headers.authorization, origin: req.headers.origin });
		if (req.url === "/api/health") return res.end('{"ok":true}');
		if (req.url === "/assets/proof.bin") return res.end(blob);
		if (req.url === "/api/echo") return req.pipe(res);
		if (req.url === "/desktop-preview") return res.end("<!doctype html><title>P2P preview</title>");
		res.writeHead(404).end();
	});
	const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
	target.on("upgrade", (req, socket, head) => {
		requests.push({ path: req.url, auth: req.headers.authorization, origin: req.headers.origin });
		wss.handleUpgrade(req, socket, head, (ws) => {
			ws.on("error", () => {});
			ws.on("message", (data, binary) => {
				if (req.url === "/desktop-ws" && data.toString() === "next") ws.send(frame);
				else ws.send(data, { binary });
			});
		});
	});
	const targetOrigin = await listen(target);
	cleanups.push(() => {
		for (const ws of wss.clients) ws.terminate();
		wss.close();
	});
	const hubApp = express();
	hubApp.use(express.json({ limit: "64kb" }));
	let relay;
	let hubOrigin;
	let negotiations = 0;
	hubApp.post("/api/device-user/devices/:id/open", async (req, res) => {
		if (req.headers.authorization !== "Bearer synthetic-ui" || req.headers["x-device-id"] !== "source")
			return res.sendStatus(403);
		req.headers.origin = hubOrigin;
		// Simulate a LAN that is unreachable while leaving production signaling and P2P untouched.
		const end = res.end;
		res.end = function (data, ...args) {
			if (typeof data === "string" && data.startsWith("{")) {
				const json = JSON.parse(data);
				delete json.deviceLan;
				data = JSON.stringify(json);
			}
			return end.call(this, data, ...args);
		};
		if (req.body.p2pOffer) negotiations++;
		await relay.handleOpen(req, res, req.params.id, false, req.body.preferLan === true, req.body.p2pOffer);
	});
	const hub = http.createServer(hubApp);
	hubOrigin = await listen(hub);
	relay = createDeviceRelay({
		server: hub,
		publicUrl: hubOrigin,
		pathAccess: true,
		authenticateDevice: (id, key) => id === "target" && key === "synthetic-device",
		getAccount: (req) => (req.headers.authorization === "Bearer synthetic-ui" ? { id: "account" } : null),
		ownsDevice: (account, id) => account === "account" && id === "target",
	});
	cleanups.push(() => relay.close());
	const connector = createDeviceConnector({
		hubUrl: hubOrigin,
		deviceId: "target",
		credential: "synthetic-device",
		localOrigin: targetOrigin,
		localAuthToken: "synthetic-target-token",
	});
	cleanups.push(() => connector.close());
	await new Promise((resolve, reject) => {
		const timer = setInterval(() => {
			if (relay.isOnline("target")) {
				clearInterval(timer);
				clearTimeout(limit);
				resolve();
			}
		}, 20);
		const limit = setTimeout(() => {
			clearInterval(timer);
			reject(new Error("Connector unavailable"));
		}, 5000);
	});
	const dataDir = await mkdtemp(join(tmpdir(), "pi-p2p-test-"));
	cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
	await writeFile(
		join(dataDir, "device-center.json"),
		JSON.stringify({
			hubUrl: hubOrigin,
			deviceId: "source",
			name: "Source",
			credential: "synthetic-source",
			uiCredential: "synthetic-ui",
			allowExecution: false,
		}),
	);
	const app = express();
	app.use(express.json());
	const access = createDeviceLanAccess();
	const local = await installLocalDeviceCenter({
		app,
		dataDir,
		lanAccess: access,
		connect: () => ({ close() {}, isConnected: () => true }),
	});
	cleanups.push(() => local.close());
	app.use((req, res) => {
		if (!access.handleRequest(req, res)) res.sendStatus(404);
	});
	const source = http.createServer(app);
	source.on("upgrade", (req, socket, head) => {
		if (!access.handleUpgrade(req, socket, head)) socket.destroy();
	});
	const origin = await listen(source);
	for (const [id, auth, offer, expected] of [
		["target", "wrong", undefined, 403],
		["other", "synthetic-ui", undefined, 403],
		["target", "synthetic-ui", { version: 1, sdp: "malformed" }, 400],
	]) {
		const denied = await fetch(hubOrigin + `/api/device-user/devices/${id}/open`, {
			method: "POST",
			headers: { Authorization: `Bearer ${auth}`, "X-Device-Id": "source", "Content-Type": "application/json" },
			body: JSON.stringify({ preferLan: true, p2pOffer: offer }),
			signal: deadline(),
		});
		assert.equal(denied.status, expected);
	}
	const browserSignal = await fetch(origin + "/api/device-center/devices/target/open", {
		method: "POST",
		headers: { Origin: origin, "Content-Type": "application/json" },
		body: JSON.stringify({ preferLan: true, p2pOffer: {} }),
		signal: deadline(),
	});
	assert.equal(browserSignal.status, 400);
	const open = async () => {
		const response = await fetch(origin + "/api/device-center/devices/target/open", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: origin },
			body: JSON.stringify({ preferLan: true, desktop: true }),
			signal: deadline(),
		});
		assert.equal(response.status, 200);
		return response.json();
	};
	const opened = await open();
	assert.equal(opened.transport, "p2p");
	assert(!JSON.stringify(opened).includes("synthetic"));
	assert.equal(opened.deviceP2P, undefined);
	assert.equal(opened.deviceLan, undefined);
	const wrapper = await fetch(origin + opened.url + "&next=%2Fdesktop-preview", { signal: deadline() });
	const html = await wrapper.text();
	assert.match(html, /type:'device-access-transport',transport:"p2p"/);
	assert(!html.includes("allow-same-origin"));
	const base = html.match(/\/device-lan\/target\/__relay\/[a-f0-9]{64}\//)[0];
	const status = await fetch(origin + base + "api/device-center/chat-status", {
		headers: { Origin: "null" },
		signal: deadline(),
	});
	assert.equal((await status.json()).transport, "p2p");
	const desktop = await websocket(origin + base + "desktop-ws");
	const chat = await websocket(origin + base + "ws");
	await Promise.all([
		(async () => {
			const response = await fetch(origin + base + "assets/proof.bin", {
				headers: { Origin: "null" },
				signal: deadline(),
			});
			assert.equal(response.status, 200);
			assert.equal(hash(Buffer.from(await response.arrayBuffer())), hash(blob));
		})(),
		(async () => {
			for (let index = 0; index < 32; index++) {
				const next = once(desktop, "message", { signal: deadline() });
				desktop.send("next");
				const [data, binary] = await next;
				assert(binary);
				assert.equal(hash(data), hash(frame));
			}
		})(),
		(async () => {
			for (let index = 0; index < 32; index++) {
				const next = once(chat, "message", { signal: deadline() });
				const text = `message ${index}`;
				chat.send(text);
				const [data, binary] = await next;
				assert(!binary);
				assert.equal(data.toString(), text);
			}
		})(),
	]);
	assert(requests.every((req) => req.auth === "Bearer synthetic-target-token" && req.origin === targetOrigin));
	const second = await open();
	assert.equal(second.transport, "p2p");
	const stillAlive = once(chat, "message", { signal: deadline() });
	chat.send("first connection remains live");
	assert.equal((await stillAlive)[0].toString(), "first connection remains live");
	process.env.PI_DEVICE_P2P = "0";
	const fallback = await fetch(origin + base + "__lan_fallback", {
		method: "POST",
		headers: { Origin: "null" },
		signal: deadline(),
	});
	assert.equal(fallback.status, 200);
	const recovered = await fallback.json();
	assert.equal(recovered.transport, "hub");
	assert(recovered.url.startsWith(hubOrigin + "/device/target/__open?"));
	assert.equal(new URL(recovered.url).searchParams.get("next"), "/desktop-preview");
	assert.equal((await open()).transport, "hub");
	delete process.env.PI_DEVICE_P2P;
	const anotherWrapper = await fetch(origin + second.url, { signal: deadline() });
	const anotherBase = (await anotherWrapper.text()).match(/\/device-lan\/target\/__relay\/[a-f0-9]{64}\//)[0];
	const revokedSocket = await websocket(origin + anotherBase + "ws");
	const released = once(revokedSocket, "close", { signal: deadline() });
	assert.equal(
		(
			await fetch(origin + anotherBase + "__lan_close", {
				method: "POST",
				headers: { Origin: "null" },
				signal: deadline(),
			})
		).status,
		204,
	);
	await released;
	const finalOpen = await open();
	assert.equal(finalOpen.transport, "p2p");
	const finalHtml = await (await fetch(origin + finalOpen.url, { signal: deadline() })).text();
	const finalBase = finalHtml.match(/\/device-lan\/target\/__relay\/[a-f0-9]{64}\//)[0];
	const finalSocket = await websocket(origin + finalBase + "ws");
	const revoked = once(finalSocket, "close", { signal: deadline() });
	connector.close();
	await revoked;
	assert.equal((await fetch(origin + finalBase + "assets/proof.bin", { signal: deadline() })).status, 502);
	console.log(
		JSON.stringify(
			{
				ok: true,
				scope: "two native helper processes on loopback, real Hub RPC and local access API",
				negotiations,
				checks: [
					"P2P selected after forced LAN miss",
					"credentials/SDP absent from browser response",
					"8 MiB download + 32 desktop frames + 32 chat messages in parallel",
					"multiple access sessions coexist",
					"P2P disabled -> Hub fallback with correct transport and preview path",
					"connector revocation closes P2P access",
				],
				notTested: ["cross-network NAT", "real desktop capture", "macOS/Linux runtime"],
			},
			null,
			2,
		),
	);
}
try {
	await main();
} finally {
	for (const cleanup of cleanups.reverse()) await cleanup();
}
