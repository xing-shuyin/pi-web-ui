import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { ensureBuild, PREBUILT_ENV } from "./lib/ensure-build.mjs";
import { startDeviceHub } from "../server/device-center/main.ts";
import { createDeviceConnector } from "../server/device-center/connector.ts";

const repo = fileURLToPath(new URL("..", import.meta.url));
async function waitFor(check, label, timeout = 45_000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (await check()) return;
		await delay(100);
	}
	throw new Error(`Timed out waiting for ${label}`);
}

async function reservePort() {
	const server = createServer();
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const port = server.address().port;
	await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	return port >= 18980 ? port : reservePort();
}

async function stopChild(child) {
	if (!child || child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise((resolve) => child.once("exit", resolve));
	child.kill("SIGTERM");
	const killTimer = setTimeout(() => {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}, 5000);
	try {
		await exited;
	} finally {
		clearTimeout(killTimer);
	}
}

async function main() {
	if (!CHROME_PATH) {
		console.log("SKIP device-path-portals-browser: Chrome unavailable (set PI_WEB_CHROME)");
		return;
	}
	const previousPrebuilt = process.env[PREBUILT_ENV];
	process.env[PREBUILT_ENV] = "1";
	try {
		ensureBuild(repo, "device-path-portals-browser");
	} finally {
		if (previousPrebuilt === undefined) delete process.env[PREBUILT_ENV];
		else process.env[PREBUILT_ENV] = previousPrebuilt;
	}
	const root = await mkdtemp(join(tmpdir(), "pi-device-path-browser-"));
	let server;
	let hub;
	let connector;
	let browser;
	let serverLog = "";
	const pageErrors = [];
	const consoleErrors = [];
	const failedRequests = [];
	const badResponses = [];
	const sockets = [];
	const packets = [];
	const navigations = [];
	try {
		const work = join(root, "work");
		const agent = join(root, "agent");
		const home = join(root, "home");
		for (const path of [work, agent, home]) await mkdir(path, { recursive: true });
		const localPort = await reservePort();
		let hubPort = await reservePort();
		while (hubPort === localPort) hubPort = await reservePort();
		const localOrigin = `http://127.0.0.1:${localPort}`;
		const hubOrigin = `http://127.0.0.1:${hubPort}`;
		server = spawn(process.execPath, [join(repo, "dist/server/index.js")], {
			cwd: work,
			env: {
				...process.env,
				HOME: home,
				USERPROFILE: home,
				APPDATA: join(home, "AppData", "Roaming"),
				LOCALAPPDATA: join(home, "AppData", "Local"),
				PI_WEB_HOST: "127.0.0.1",
				PI_WEB_PORT: String(localPort),
				PI_WEB_CWD: work,
				PI_WEB_DATA_DIR: join(root, "pi-data"),
				PI_CODING_AGENT_DIR: agent,
				PI_WEB_SDK: "bundled",
				PI_WEB_TOKEN: "",
				PI_WEB_PLUGIN_CATALOG_URL: "off",
				PI_WEB_PLUGIN_CATALOG_INSTALL: "0",
			},
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		server.on("error", (error) => (serverLog += `\n${error.message}`));
		for (const stream of [server.stdout, server.stderr]) {
			stream.on("data", (chunk) => (serverLog = (serverLog + chunk.toString()).slice(-24_000)));
		}
		await waitFor(async () => {
			assert.equal(server.exitCode, null, `Isolated pi exited: ${serverLog}`);
			try {
				return (await fetch(`${localOrigin}/api/health`, { signal: AbortSignal.timeout(1000) })).ok;
			} catch {
				return false;
			}
		}, "isolated real pi server");
		hub = await startDeviceHub({
			PI_DEVICE_HUB_PUBLIC_URL: hubOrigin,
			PI_DEVICE_HUB_PORT: String(hubPort),
			PI_DEVICE_HUB_HOST: "127.0.0.1",
			PI_DEVICE_HUB_PATH_ACCESS: "1",
			PI_DEVICE_HUB_DATA_DIR: join(root, "hub-data"),
			PI_DEVICE_HUB_ALLOW_REGISTRATION: "1",
		});
		async function api(path, body, cookie) {
			const response = await fetch(hubOrigin + path, {
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
		const owner = await api("/api/auth/register", {
			username: "path-browser-owner",
			password: "path-browser-temporary-password",
		});
		const cookie = owner.response.headers.get("set-cookie")?.split(";")[0];
		assert.ok(cookie, "Temporary account registration must issue the Hub login cookie");
		const pair = await api("/api/pair/start", { name: "Isolated real pi browser test" });
		await api("/api/pair/approve", { code: pair.data.code }, cookie);
		const paired = await api("/api/pair/poll", { pollToken: pair.data.pollToken });
		const { deviceId, credential } = paired.data;
		assert.ok(deviceId && credential);
		connector = createDeviceConnector({ hubUrl: hubOrigin, deviceId, credential, localOrigin });
		await waitFor(async () => {
			if (!connector.isOnline()) return false;
			const { data } = await api("/api/devices", undefined, cookie);
			return data.devices.some((device) => device.id === deviceId && device.online);
		}, "paired connector online");

		browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true, args: ["--no-sandbox"] });
		const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		const equals = cookie.indexOf("=");
		await context.addCookies([
			{
				name: cookie.slice(0, equals),
				value: cookie.slice(equals + 1),
				url: hubOrigin,
				httpOnly: true,
				sameSite: "Strict",
			},
		]);
		context.setDefaultTimeout(30_000);
		const requests = [];
		context.on("request", (request) => requests.push(request.url()));
		const page = await context.newPage();
		page.on("pageerror", (error) => pageErrors.push(error.message));
		page.on("framenavigated", (frame) => navigations.push(frame.url()));
		page.on("console", (message) => {
			if (message.type() === "error") consoleErrors.push(message.text());
		});
		page.on("requestfailed", (request) => failedRequests.push(`${request.url()}: ${request.failure()?.errorText}`));
		page.on("response", async (response) => {
			if (response.status() >= 400 && badResponses.length < 5) {
				badResponses.push({
					url: response.url(),
					status: response.status(),
					body: await response.text().catch(() => "unavailable"),
				});
			}
		});
		page.on("websocket", (socket) => {
			sockets.push(socket.url());
			socket.on("framereceived", ({ payload }) => {
				try {
					packets.push(JSON.parse(String(payload)));
				} catch {}
			});
		});
		const response = await page.goto(`${hubOrigin}/device/${deviceId}/`);
		assert.equal(response.status(), 200);
		const frameElement = page.locator("iframe");
		await frameElement.waitFor();
		assert.equal(await frameElement.getAttribute("sandbox"), "allow-scripts allow-forms allow-downloads");
		const frame = await (await frameElement.elementHandle()).contentFrame();
		assert.ok(frame, "Portal must expose an iframe");
		await frame.locator("#root .app").waitFor();
		await frame.locator(".status-conn.ok").waitFor();
		await frame.locator("textarea").first().waitFor();
		assert.equal(await frame.locator("textarea").first().isEnabled(), true, "Real chat composer is ready");
		await waitFor(() => packets.some((packet) => packet.type === "snapshot"), "actual pi WS snapshot");
		assert.ok(
			(await frame.locator("body").innerText()).trim().length > 30,
			"React must render the actual empty chat UI",
		);
		const base = `/device/${deviceId}/__relay/`;
		assert.ok(new URL(frame.url()).pathname.startsWith(base));
		assert.ok(
			sockets.some((url) => new URL(url).pathname.startsWith(base) && new URL(url).pathname.endsWith("/ws")),
			"App WebSocket must use the capability URL",
		);
		const storage = await frame.evaluate(() => {
			localStorage.setItem("portal-browser-probe", "local");
			sessionStorage.setItem("portal-browser-probe", "session");
			let cookieDenied = false;
			try {
				void document.cookie;
			} catch (error) {
				cookieDenied = error.name === "SecurityError";
			}
			return {
				local: localStorage.getItem("portal-browser-probe"),
				session: sessionStorage.getItem("portal-browser-probe"),
				cookieDenied,
			};
		});
		assert.deepEqual(
			storage,
			{ local: "local", session: "session", cookieDenied: true },
			"Opaque frame storage shim works while browser cookie access stays blocked",
		);
		assert.equal((await context.request.get(`${hubOrigin}/api/auth/me`)).ok(), true);
		const isolation = await frame.evaluate(async (origin) => {
			try {
				const response = await fetch(`${origin}/api/auth/me`, { credentials: "include" });
				return { denied: !response.ok, status: response.status };
			} catch {
				return { denied: true, blocked: true };
			}
		}, hubOrigin);
		assert.equal(isolation.denied, true, "Opaque device frame cannot fetch the Hub account with its cookie");
		assert.deepEqual(
			await page.evaluate(() => ({
				local: localStorage.getItem("portal-browser-probe"),
				session: sessionStorage.getItem("portal-browser-probe"),
			})),
			{ local: null, session: null },
			"Frame memory storage is isolated from Hub storage",
		);
		for (const url of [...requests, ...sockets]) {
			const parsed = new URL(url);
			if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) continue;
			assert.equal(parsed.hostname, "127.0.0.1", `Unexpected browser network host: ${url}`);
			assert.equal(parsed.port, String(hubPort), `Browser must use only the single Hub port: ${url}`);
		}
		assert.ok(
			requests.some((url) => /\/assets\/.*\.js(?:\?|$)/.test(url)),
			"Real built React JavaScript must be requested through Hub",
		);
		await delay(1000);
		assert.equal(sockets.length, 1, "App must keep its original WS instead of reloading in an opaque storage loop");
		assert.equal(
			navigations.filter((url) => url.startsWith(`${hubOrigin}${base}`) && !new URL(url).hash).length,
			1,
			"Capability document must boot once without repeated reloads",
		);
		assert.deepEqual(pageErrors, [], "Opaque React app must not throw, including localStorage SecurityError");
		console.log(
			`PASS device-path-portals-browser: real React boot, connected WS snapshot, opaque storage, cookie isolation; ${requests.length} HTTP requests/${sockets.length} WS all through one Hub port`,
		);
	} catch (error) {
		console.error("Browser diagnostics:", {
			pageErrors: pageErrors.slice(0, 8),
			consoleErrors: consoleErrors.slice(0, 8),
			failedRequests: failedRequests.slice(0, 3),
			badResponses,
			sockets: sockets.length,
			packets: packets.slice(0, 5).map(({ type, buildId, protocolVersion }) => ({ type, buildId, protocolVersion })),
			navigations: navigations.slice(0, 4),
			navigationCount: navigations.length,
		});
		console.error("Isolated pi diagnostics:", serverLog);
		throw error;
	} finally {
		try {
			await browser?.close();
		} finally {
			try {
				connector?.close();
				await hub?.close();
			} finally {
				await stopChild(server);
				await rm(root, { recursive: true, force: true });
			}
		}
	}
}

main().catch((error) => {
	console.error("FAIL device-path-portals-browser:", error);
	process.exitCode = 1;
});
