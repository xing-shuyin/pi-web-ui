import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { networkInterfaces } from "node:os";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
const source = process.env.PI_BROWSER_P2P_TEST_PACKAGE_ROOT;
const { createDeviceRelay } = await import(
	source ? pathToFileURL(join(source, "dist/server/device-center/relay.js")).href : "../server/device-center/relay.ts"
);
const { createDeviceConnector } = await import(
	source
		? pathToFileURL(join(source, "dist/server/device-center/connector.js")).href
		: "../server/device-center/connector.ts"
);
const cleanup = [];
async function listen(server, host = "127.0.0.1") {
	const sockets = new Set();
	server.on("connection", (s) => {
		sockets.add(s);
		s.on("close", () => sockets.delete(s));
	});
	server.listen(0, host);
	await once(server, "listening");
	assert(server.address().port >= 8900);
	cleanup.push(async () => {
		for (const s of sockets) s.destroy();
		await new Promise((r) => server.close(r));
	});
	return "http://" + host + ":" + server.address().port;
}
let writes = 0,
	lostWrites = 0,
	hubData = 0,
	relay;
const html = `<!doctype html><meta charset="utf-8"><div id="root">Browser transport fixture</div><script>
window.testReady=(async()=>{
 const response=await fetch(new URL('api/echo',document.baseURI));window.echo=await response.json();
 const url=new URL('ws',document.baseURI);url.protocol=url.protocol.replace('http','ws');
 const ws=new WebSocket(url.href);ws.binaryType='arraybuffer';window.testSocket=ws;
 await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
 window.socketEcho=await new Promise(r=>{ws.onmessage=e=>r(e.data);ws.send('browser-p2p')});
 document.getElementById('root').textContent='ready';
})();window.testReady.catch(e=>document.getElementById('root').textContent='error:'+e.message);
</script>`;
try {
	const target = http.createServer((req, res) => {
		if (!["Bearer fixture-target", "Bearer fixture-other"].includes(req.headers.authorization)) {
			res.writeHead(401).end();
			return;
		}
		if (req.url === "/api/health") return res.end("ok");
		if (req.url === "/api/echo") {
			res.setHeader("content-type", "application/json");
			return res.end(
				JSON.stringify({ device: req.headers.authorization === "Bearer fixture-other" ? "other" : "target" }),
			);
		}
		if (req.url === "/api/upload") {
			let size = 0,
				valid = true;
			req.on("data", (data) => {
				size += data.length;
				valid &&= data.every((x) => x === 71);
			});
			req.on("end", () => res.end(JSON.stringify({ size, valid })));
			return;
		}
		if (req.url === "/api/slow") {
			res.write("first");
			return;
		}
		if (req.url === "/api/write-drop") {
			req.resume();
			req.on("end", () => {
				lostWrites++;
				res.destroy();
			});
			return;
		}
		if (req.url === "/api/write" && req.method === "POST") {
			writes++;
			req.resume();
			return res.end("written");
		}
		if (req.url === "/api/stream") {
			res.setHeader("content-type", "application/octet-stream");
			res.end(Buffer.alloc(2 * 1024 * 1024, 42));
			return;
		}
		res.setHeader("content-type", "text/html");
		res.end(html);
	});
	const targetOrigin = await listen(target),
		wss = new WebSocketServer({ server: target });
	wss.on("connection", (ws) => ws.on("message", (data, binary) => ws.send(data, { binary })));
	cleanup.push(() => {
		for (const ws of wss.clients) ws.terminate();
		wss.close();
	});
	const hub = http.createServer((req, res) => {
		if (req.url?.includes("/__relay/") && /\/(api\/echo|api\/write|api\/stream|ws)(?:\?|$)/.test(req.url)) hubData++;
		if (relay?.handleRequest(req, res)) return;
		if (req.url === "/open" && req.headers.authorization === "Bearer fixture-ui")
			void relay.handleOpen(req, res, "target");
		else res.writeHead(404).end();
	});
	const insecure = process.argv.includes("--insecure-origin");
	const hubAddress = insecure
		? Object.values(networkInterfaces())
				.flat()
				.find((x) => x?.family === "IPv4" && !x.internal && /^(10\.|192\.168\.|172\.)/.test(x.address))?.address
		: "127.0.0.1";
	assert(hubAddress, "A private interface is required for the insecure HTTP origin test");
	const hubOrigin = await listen(hub, hubAddress);
	hub.on("upgrade", (req) => {
		if (req.url?.includes("/__relay/")) hubData++;
	});
	relay = createDeviceRelay({
		server: hub,
		publicUrl: hubOrigin,
		pathAccess: true,
		authenticateDevice: (id, credential) => ["target", "other"].includes(id) && credential === "fixture-device",
		getAccount: (req) => (req.headers.authorization === "Bearer fixture-ui" ? { id: "owner" } : null),
		ownsDevice: (account, id) => account === "owner" && ["target", "other"].includes(id),
	});
	cleanup.push(() => relay.close());
	const connector = createDeviceConnector({
		hubUrl: hubOrigin,
		deviceId: "target",
		credential: "fixture-device",
		localOrigin: targetOrigin,
		localAuthToken: "fixture-target",
	});
	cleanup.push(() => connector.close());
	const other = createDeviceConnector({
		hubUrl: hubOrigin,
		deviceId: "other",
		credential: "fixture-device",
		localOrigin: targetOrigin,
		localAuthToken: "fixture-other",
	});
	cleanup.push(() => other.close());
	for (let i = 0; i < 100 && !relay.isOnline("target"); i++) await new Promise((r) => setTimeout(r, 50));
	assert(relay.isOnline("target"));
	const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	cleanup.push(() => browser.close());
	const page = await browser.newPage(),
		errors = [];
	let session;
	page.on("response", async (response) => {
		if (
			response.request().frame() === page.mainFrame() &&
			response.url().endsWith("/__browser_p2p") &&
			response.status() === 200
		)
			session = (await response.json()).key;
	});
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => {
		if (["error", "warning"].includes(message.type())) console.log("browser:", message.text().slice(0, 350));
	});
	const open = await fetch(hubOrigin + "/open", {
		method: "POST",
		headers: { Authorization: "Bearer fixture-ui", Origin: hubOrigin },
	});
	assert(open.ok, "open status " + open.status);
	await page.goto((await open.json()).url);
	assert.equal(await page.evaluate(() => window.isSecureContext), !insecure);
	await page
		.waitForFunction(() => ["lan", "p2p"].includes(window.__piBrowserTransport), {}, { timeout: 45000 })
		.catch(async (error) => {
			console.log("route", await page.locator("#browser-route").textContent());
			console.log("errors", errors);
			throw error;
		});
	const frame = page.frames().find((f) => f !== page.mainFrame());
	assert(frame);
	await frame.waitForFunction(() => document.getElementById("root")?.textContent === "ready", {}, { timeout: 15000 });
	assert.deepEqual(await frame.evaluate(() => window.echo), { device: "target" });
	assert.equal(await frame.evaluate(() => window.socketEcho), "browser-p2p");
	assert.equal(hubData, 0, "direct fetch and websocket must not use Hub data relay");
	const stream = await frame.evaluate(async () => {
		const r = await fetch(new URL("api/stream", document.baseURI));
		const reader = r.body.getReader();
		let count = 0,
			valid = true;
		for (;;) {
			const item = await reader.read();
			if (item.done) break;
			count += item.value.length;
			valid &&= item.value.every((x) => x === 42);
		}
		return { count, valid };
	});
	assert.deepEqual(stream, { count: 2 * 1024 * 1024, valid: true });
	console.log("Download verified");
	assert.deepEqual(
		await frame.evaluate(async () => {
			const body = new Uint8Array(4 * 1024 * 1024).fill(71);
			return (await fetch(new URL("api/upload", document.baseURI), { method: "POST", body })).json();
		}),
		{ size: 4 * 1024 * 1024, valid: true },
	);
	console.log("Upload verified");
	assert.equal(
		await frame.evaluate(
			() =>
				new Promise((resolve) => {
					window.testSocket.onmessage = (e) =>
						resolve(new Uint8Array(e.data).every((x) => x === 19) && e.data.byteLength === 300 * 1024);
					window.testSocket.send(new Uint8Array(300 * 1024).fill(19));
				}),
		),
		true,
	);
	console.log("Binary socket verified");
	assert.equal(
		await frame.evaluate(async () => {
			const controller = new AbortController();
			const response = await fetch(new URL("api/slow", document.baseURI), { signal: controller.signal });
			const reader = response.body.getReader();
			await reader.read();
			controller.abort();
			try {
				await reader.read();
				return false;
			} catch (e) {
				return e.name === "AbortError";
			}
		}),
		true,
	);
	console.log("Abort verified");
	assert(["lan", "p2p"].includes(await page.evaluate(() => window.__piBrowserTransport)));
	await frame.evaluate(() =>
		fetch(new URL("api/write", document.baseURI), { method: "POST", body: "one" }).then((r) => r.text()),
	);
	assert.equal(writes, 1);
	const base = await frame.evaluate(() => document.baseURI);
	const previousData = hubData;
	await frame.evaluate(() => {
		const nested = document.createElement("iframe");
		nested.id = "nested";
		nested.src = new URL("__desktop_target?device=other", document.baseURI);
		document.body.append(nested);
	});
	const nestedElement = await frame.waitForSelector("#nested");
	const nested = await nestedElement.contentFrame();
	await nested.waitForFunction(() => ["lan", "p2p"].includes(window.__piBrowserTransport), {}, { timeout: 30000 });
	const nestedApp = nested.childFrames()[0];
	await nestedApp.waitForFunction(() => document.getElementById("root")?.textContent === "ready");
	assert.deepEqual(await nestedApp.evaluate(() => window.echo), { device: "other" });
	assert.equal(hubData, previousData, "nested device also connects directly from the browser");
	console.log("Nested device verified");
	await frame.evaluate(() => document.getElementById("nested").remove());
	assert.equal(
		(
			await fetch(base + "__browser_p2p", {
				method: "POST",
				headers: { Origin: "https://wrong.invalid", "Content-Type": "application/json" },
				body: "{}",
			})
		).status,
		403,
	);
	assert.equal(
		(
			await fetch(base + "__browser_p2p", {
				method: "POST",
				headers: { Origin: hubOrigin, "Content-Type": "application/json" },
				body: JSON.stringify({ version: 1, sdp: "bad" }),
			})
		).status,
		503,
	);
	assert.equal(
		(
			await fetch(base + "__browser_p2p", {
				method: "POST",
				headers: { Origin: hubOrigin, "Content-Type": "application/json" },
				body: JSON.stringify({ close: true, session }),
			})
		).status,
		204,
	);
	await page.waitForFunction(() => window.__piBrowserTransport === "hub");
	await frame.evaluate(() =>
		fetch(new URL("api/write", document.baseURI), { method: "POST", body: "two" }).then((r) => r.text()),
	);
	assert.equal(writes, 2);
	assert(hubData > 0, "new requests use Hub after peer revocation");
	const retryOpen = await fetch(hubOrigin + "/open", {
		method: "POST",
		headers: { Authorization: "Bearer fixture-ui", Origin: hubOrigin },
	});
	await page.goto((await retryOpen.json()).url);
	await page.waitForFunction(() => ["lan", "p2p"].includes(window.__piBrowserTransport));
	const retryFrame = page.frames()[1];
	await retryFrame.waitForFunction(() => document.getElementById("root")?.textContent === "ready");
	assert.equal(
		await retryFrame.evaluate(async () => {
			try {
				return !(await fetch(new URL("api/write-drop", document.baseURI), { method: "POST", body: "must not replay" }))
					.ok;
			} catch {
				return true;
			}
		}),
		true,
	);
	assert.equal(lostWrites, 1);
	const fallbackPage = await browser.newPage();
	await fallbackPage.addInitScript(() => {
		window.RTCPeerConnection = undefined;
	});
	const fallbackOpen = await fetch(hubOrigin + "/open", {
		method: "POST",
		headers: { Authorization: "Bearer fixture-ui", Origin: hubOrigin },
	});
	await fallbackPage.goto((await fallbackOpen.json()).url);
	await fallbackPage.waitForFunction(() => window.__piBrowserTransport === "hub");
	await fallbackPage.frames()[1].waitForFunction(() => document.getElementById("root")?.textContent === "ready");
	await fallbackPage.close();
	const oldEnabled = process.env.PI_DEVICE_P2P;
	try {
		process.env.PI_DEVICE_P2P = "0";
		const disabledPage = await browser.newPage();
		const disabledOpen = await fetch(hubOrigin + "/open", {
			method: "POST",
			headers: { Authorization: "Bearer fixture-ui", Origin: hubOrigin },
		});
		await disabledPage.goto((await disabledOpen.json()).url);
		await disabledPage.waitForFunction(() => window.__piBrowserTransport === "hub");
		await disabledPage.frames()[1].waitForFunction(() => document.getElementById("root")?.textContent === "ready");
		assert(relay.isOnline("target"), "failed negotiation must keep the device connector online");
		await disabledPage.close();
	} finally {
		if (oldEnabled === undefined) delete process.env.PI_DEVICE_P2P;
		else process.env.PI_DEVICE_P2P = oldEnabled;
	}
	assert.deepEqual(errors, []);
	console.log(
		JSON.stringify({
			passed: true,
			insecureOrigin: insecure,
			realBrowser: true,
			realDataChannel: true,
			fetch: true,
			websocket: true,
			streamBytes: stream.count,
			uploadBytes: 4 * 1024 * 1024,
			binaryWebsocket: true,
			abort: true,
			nestedDevice: true,
			noRtcFallback: true,
			disabledPeerFallback: true,
			writeExactlyOnce: true,
			lostWriteNotReplayed: true,
			originGuard: true,
			revocationFallback: true,
		}),
	);
} finally {
	for (const fn of cleanup.reverse()) await fn();
}
