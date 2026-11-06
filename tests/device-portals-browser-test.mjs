import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import { WebSocketServer } from "ws";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { startDeviceHub } from "../server/device-center/main.ts";
import { createDeviceConnector } from "../server/device-center/connector.ts";

async function listen(server) {
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const port = server.address().port;
	assert.ok(port >= 8900, `Test listener must use a port >=8900, got ${port}`);
	return port;
}

async function closeServer(server) {
	server.closeAllConnections();
	await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function waitFor(predicate, label) {
	const deadline = Date.now() + 10_000;
	while (!(await predicate())) {
		assert.ok(Date.now() < deadline, `Timed out waiting for ${label}`);
		await delay(25);
	}
}

async function main() {
	if (!CHROME_PATH) {
		console.log("SKIP device-portals-browser: Chrome unavailable (set PI_WEB_CHROME)");
		return;
	}
	const dataDir = await mkdtemp(join(tmpdir(), "pi-device-portals-browser-"));
	const reservations = [];
	const received = [];
	let hub;
	let connector;
	let browser;
	const mock = createServer((req, res) => {
		received.push({ kind: "http", path: req.url, headers: { ...req.headers } });
		res.writeHead(200, {
			"content-type": "text/html; charset=utf-8",
			"set-cookie": "remote_cookie=must-not-reach-browser; Path=/; SameSite=Lax",
		});
		res.end('<!doctype html><title>Mock local device UI</title><main id="mock-ui">Actual local device UI</main>');
	});
	const mockWs = new WebSocketServer({ server: mock, path: "/ws" });
	mockWs.on("connection", (socket, req) => {
		received.push({ kind: "ws", path: req.url, headers: { ...req.headers } });
		socket.on("message", (data, binary) => socket.send(data, { binary }));
	});
	try {
		const mockPort = await listen(mock);
		for (let i = 0; i < 2; i++) {
			const server = createServer();
			reservations.push(server);
			await listen(server);
		}
		const [hubPort, portalPort] = reservations.map((server) => server.address().port);
		for (const server of reservations.splice(0)) await closeServer(server);
		const hubOrigin = `http://127.0.0.1:${hubPort}`;
		const portalOrigin = `http://127.0.0.1:${portalPort}`;
		const localOrigin = `http://127.0.0.1:${mockPort}`;
		hub = await startDeviceHub({
			PI_DEVICE_HUB_PUBLIC_URL: hubOrigin,
			PI_DEVICE_HUB_PORT: String(hubPort),
			PI_DEVICE_HUB_HOST: "127.0.0.1",
			PI_DEVICE_HUB_PORTAL_PORTS: String(portalPort),
			PI_DEVICE_HUB_DATA_DIR: dataDir,
			PI_DEVICE_HUB_ALLOW_REGISTRATION: "1",
		});
		async function api(path, body, cookie) {
			const response = await fetch(`${hubOrigin}${path}`, {
				method: body === undefined ? "GET" : "POST",
				headers: {
					Origin: hubOrigin,
					"Content-Type": "application/json",
					...(cookie ? { Cookie: cookie } : {}),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				signal: AbortSignal.timeout(10_000),
			});
			const text = await response.text();
			assert.ok(response.ok, `${path}: ${response.status} ${text}`);
			return { response, data: JSON.parse(text) };
		}
		const owner = await api("/api/auth/register", { username: "portal-owner", password: "portal-browser-test-123" });
		const ownerCookie = owner.response.headers.get("set-cookie")?.split(";")[0];
		assert.ok(ownerCookie, "Registration must issue the real hub account cookie");
		const start = await api("/api/pair/start", { name: "Mock Mac" });
		await api("/api/pair/approve", { code: start.data.code }, ownerCookie);
		const paired = await api("/api/pair/poll", { pollToken: start.data.pollToken });
		const { deviceId, credential } = paired.data;
		assert.ok(deviceId && credential, "Pairing must issue actual device credentials");
		const alias = await api(`/api/devices/${deviceId}/alias`, { alias: "mac" }, ownerCookie);
		assert.equal(alias.data.device.alias, "mac");
		assert.equal(alias.data.device.url, portalOrigin);
		assert.equal(hub.portals.getOrigin(deviceId), portalOrigin);
		connector = createDeviceConnector({ hubUrl: hubOrigin, deviceId, credential, localOrigin });
		await waitFor(async () => {
			if (!connector.isOnline()) return false;
			const { data } = await api("/api/devices", undefined, ownerCookie);
			return data.devices.some((device) => device.id === deviceId && device.online);
		}, "connector to register with the actual hub relay");

		browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true, args: ["--no-sandbox"] });
		async function contextWithCookie(cookie) {
			const context = await browser.newContext();
			if (cookie) {
				const separator = cookie.indexOf("=");
				await context.addCookies([
					{
						name: cookie.slice(0, separator),
						value: cookie.slice(separator + 1),
						url: hubOrigin,
						httpOnly: true,
						sameSite: "Strict",
					},
				]);
			}
			context.setDefaultTimeout(10_000);
			context.setDefaultNavigationTimeout(15_000);
			return context;
		}
		const context = await contextWithCookie(ownerCookie);
		const page = await context.newPage();
		const pageErrors = [];
		page.on("pageerror", (error) => pageErrors.push(error.message));
		const response = await page.goto(`${hubOrigin}/mac#s=example-ID`);
		assert.equal(response.status(), 200);
		await page.locator("#mock-ui").waitFor();
		assert.deepEqual(await page.evaluate(() => ({ origin: location.origin, hash: location.hash })), {
			origin: portalOrigin,
			hash: "#s=example-ID",
		});
		const chain = [];
		for (let request = response.request(); request; request = request.redirectedFrom()) {
			const hop = await request.response();
			chain.unshift({ url: request.url(), status: hop.status(), location: hop.headers().location });
		}
		assert.deepEqual(
			chain.map((hop) => hop.status),
			[302, 302, 200],
			"Must traverse both real redirects",
		);
		assert.equal(new URL(chain[0].url).origin, hubOrigin);
		assert.equal(new URL(chain[0].url).pathname, "/mac");
		assert.equal(new URL(chain[1].url).origin, portalOrigin);
		assert.equal(new URL(chain[1].url).pathname, "/__device/open");
		assert.ok(new URL(chain[1].url).searchParams.get("ticket"));
		assert.equal(chain[2].location, undefined);
		assert.equal(response.headers()["set-cookie"], undefined, "Remote Set-Cookie must be stripped by the relay");
		assert.ok(received.some((request) => request.kind === "http" && request.path === "/"));
		assert.ok(!(await context.cookies()).some((cookie) => cookie.name === "remote_cookie"));
		assert.ok((await context.cookies()).some((cookie) => cookie.name === ownerCookie.split("=")[0]));
		console.log("PASS: two real redirects preserve #s=example-ID on the allocated portal origin");

		const echoed = await page.evaluate(
			() =>
				new Promise((resolve, reject) => {
					const socket = new WebSocket(`${location.origin.replace(/^http/, "ws")}/ws`);
					const timer = setTimeout(() => {
						socket.close();
						reject(new Error("Portal WS echo timed out"));
					}, 8000);
					socket.onopen = () => socket.send("portal-browser-echo");
					socket.onmessage = (event) => {
						clearTimeout(timer);
						socket.close();
						resolve(event.data);
					};
					socket.onerror = () => {
						clearTimeout(timer);
						socket.close();
						reject(new Error("Portal WS failed"));
					};
				}),
		);
		assert.equal(echoed, "portal-browser-echo");
		assert.ok(received.some((request) => request.kind === "ws" && request.path === "/ws"));
		for (const request of received) {
			assert.equal(request.headers.cookie, undefined, `${request.kind}: hub/portal cookies reached the mock`);
			assert.ok(!JSON.stringify(request.headers).includes(ownerCookie.split("=")[1]), "Hub account token leaked");
		}
		console.log("PASS: actual portal WebSocket echo; hub cookies excluded from local HTTP and WS headers");

		const setupCount = received.length;
		const setup = await page.evaluate(async () => (await fetch("/api/setup")).status);
		assert.equal(setup, 400, "Relay must deny local setup access");
		assert.ok(!received.slice(setupCount).some((request) => request.path === "/api/setup"));
		const crossPort = await page.evaluate(async (origin) => {
			try {
				await fetch(`${origin}/api/auth/logout`, { method: "POST", credentials: "include" });
				return "unexpected success";
			} catch {
				return "blocked";
			}
		}, hubOrigin);
		assert.equal(crossPort, "blocked", "Browser must block the cross-origin hub response");
		const rejected = await context.request.post(`${hubOrigin}/api/auth/logout`, { headers: { Origin: portalOrigin } });
		assert.equal(rejected.status(), 403, "Hub must reject a write from its portal's different port");
		await api("/api/me", undefined, ownerCookie);
		console.log("PASS: /api/setup never reaches the mock; cross-port hub POST is rejected with 403");

		const anonymous = await contextWithCookie();
		const anonymousPage = await anonymous.newPage();
		const login = await anonymousPage.goto(`${hubOrigin}/mac#s=example-ID`);
		assert.equal(login.status(), 401);
		assert.equal(new URL(anonymousPage.url()).origin, hubOrigin);
		assert.match(await anonymousPage.locator("body").innerText(), /Sign in/);
		assert.equal(await anonymousPage.locator("a").getAttribute("href"), "/");
		const other = await api("/api/auth/register", { username: "portal-other", password: "portal-browser-test-456" });
		const otherCookie = other.response.headers.get("set-cookie")?.split(";")[0];
		assert.ok(otherCookie);
		const otherContext = await contextWithCookie(otherCookie);
		const otherPage = await otherContext.newPage();
		const hidden = await otherPage.goto(`${hubOrigin}/mac#s=example-ID`);
		assert.equal(hidden.status(), 404);
		assert.equal(hidden.request().redirectedFrom(), null);
		assert.equal(new URL(otherPage.url()).origin, hubOrigin);
		assert.deepEqual(pageErrors, []);
		console.log("PASS: unauthenticated alias shows hub sign-in; another owner gets 404 without a redirect");
		const rollbackReservations = [];
		const rollbackDir = await mkdtemp(join(tmpdir(), "pi-device-portals-rollback-"));
		try {
			for (let i = 0; i < 3; i++) {
				const server = createServer();
				rollbackReservations.push(server);
				await listen(server);
			}
			const [rollbackHub, firstPortal, occupiedPortal] = rollbackReservations.map((server) => server.address().port);
			await closeServer(rollbackReservations[0]);
			await closeServer(rollbackReservations[1]);
			await assert.rejects(
				async () => {
					const unexpected = await startDeviceHub({
						PI_DEVICE_HUB_PUBLIC_URL: `http://127.0.0.1:${rollbackHub}`,
						PI_DEVICE_HUB_PORT: String(rollbackHub),
						PI_DEVICE_HUB_HOST: "127.0.0.1",
						PI_DEVICE_HUB_PORTAL_PORTS: `${firstPortal},${occupiedPortal}`,
						PI_DEVICE_HUB_DATA_DIR: rollbackDir,
					});
					await unexpected.close();
				},
				{ code: "EADDRINUSE" },
			);
			for (const port of [firstPortal, rollbackHub]) {
				const probe = createServer();
				try {
					await new Promise((resolve, reject) => {
						probe.once("error", reject);
						probe.listen(port, "127.0.0.1", resolve);
					});
					assert.equal(probe.address().port, port);
				} finally {
					if (probe.listening) await closeServer(probe);
				}
			}
		} finally {
			for (const server of rollbackReservations) if (server.listening) await closeServer(server);
			await rm(rollbackDir, { recursive: true, force: true });
		}
		console.log("PASS: occupied second portal rejects startup; first portal and hub ports are released");
		console.log("PASS device-portals-browser (real Chrome, source TypeScript, isolated hub/portal/local UI)");
	} finally {
		try {
			await browser?.close();
		} finally {
			connector?.close();
			try {
				await hub?.close();
			} finally {
				for (const socket of mockWs.clients) socket.terminate();
				await new Promise((resolve) => mockWs.close(resolve));
				if (mock.listening) await closeServer(mock);
				for (const server of reservations) if (server.listening) await closeServer(server);
				await rm(dataDir, { recursive: true, force: true });
			}
		}
	}
}

main().catch((error) => {
	console.error("FAIL device-portals-browser:", error);
	process.exitCode = 1;
});
