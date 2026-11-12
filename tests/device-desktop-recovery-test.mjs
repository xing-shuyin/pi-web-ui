// Simulated native failures; real Windows diagnostics are verified separately.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";
import { WebSocketServer } from "ws";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { desktopPage } from "../server/device-center/desktop-page.ts";
import { desktopPreviewPage } from "../server/device-center/desktop-preview-page.ts";
import { wrapperHtml } from "../server/device-center/path-portal.ts";

const origin = "http://127.0.0.1:8995";
let failing = true,
	connections = 0,
	requests = 0,
	jpeg,
	browser;
const server = createServer(async (req, res) => {
	if (req.url === "/desktop" || req.url === "/desktop-preview")
		return res
			.writeHead(200, { "content-type": "text/html" })
			.end(req.url === "/desktop" ? desktopPage() : desktopPreviewPage());
	if (req.url === "/api/device-desktop/status")
		return res
			.writeHead(200, { "content-type": "application/json" })
			.end(JSON.stringify({ enabled: true, available: true, supported: true, environmentEnabled: false }));
	if (req.url === "/api/device-desktop/preview") {
		requests++;
		return failing
			? res
					.writeHead(502, { "content-type": "application/json" })
					.end(JSON.stringify({ error: "WINDOWS_SESSION_DISCONNECTED: The Windows user session is disconnected." }))
			: res.writeHead(200, { "content-type": "image/jpeg" }).end(jpeg);
	}
	if (req.url === "/favicon.svg")
		return res.writeHead(200, { "content-type": "image/svg+xml" }).end(await readFile("web/public/favicon.svg"));
	if (req.url === "/wrapper") {
		const page = wrapperHtml("/", "desktop-preview", undefined, "办公室 · DESKTOP-TEST");
		return res.writeHead(200, { "content-type": "text/html", "content-security-policy": page.csp }).end(page.html);
	}
	res.writeHead(404).end();
});
const wss = new WebSocketServer({ server });
wss.on("connection", (socket) => {
	connections++;
	if (failing)
		return socket.send(
			JSON.stringify({
				type: "error",
				message: "WINDOWS_SESSION_DISCONNECTED: The Windows user session is disconnected.",
			}),
		);
	socket.send(JSON.stringify({ type: "ready" }));
	socket.send(jpeg);
});
try {
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(8995, "127.0.0.1", resolve);
	});
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	const page = await browser.newPage({ locale: "zh-CN" });
	await page.setContent("<body>Desktop recovered</body>");
	jpeg = await page.screenshot({ type: "jpeg" });
	await page.clock.install();
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.addInitScript(() => {
		window.received = [];
		addEventListener("message", (event) => window.received.push(event.data));
	});
	await page.goto(origin + "/desktop-preview");
	await page.waitForFunction(() => window.received.some((event) => event.error?.includes("Windows 会话已断开")));
	assert.equal(requests, 1);
	assert.equal(
		await page.evaluate(() => window.received.some((event) => event.type === "device-portal-disconnected")),
		false,
		"capture failure must not trigger transport fallback",
	);
	failing = false;
	await page.clock.fastForward(10001);
	await page.waitForFunction(() => window.received.some((event) => event.updatedAt));
	assert(requests >= 2, "preview retries after the desktop recovers");
	failing = true;
	await page.goto(origin + "/desktop");
	await page.getByText(/Windows 会话已断开/).waitFor();
	await page.getByRole("button", { name: "断开", exact: true }).click();
	const stoppedAt = connections;
	await page.clock.fastForward(20000);
	assert.equal(connections, stoppedAt, "manual disconnect cancels recovery");
	await page.getByRole("button", { name: "连接", exact: true }).click();
	await page.getByText(/Windows 会话已断开/).waitFor();
	failing = false;
	await page.clock.fastForward(10001);
	await page.getByText("已连接 · 可控制", { exact: true }).waitFor();
	assert.equal(connections, stoppedAt + 2);
	await page.goto(origin + "/wrapper");
	assert.equal(await page.title(), "办公室 · DESKTOP-TEST · pi-web-ui");
	const icon = await page.locator('link[rel="icon"]').getAttribute("href");
	assert.equal(icon, "/favicon.svg");
	assert.equal(
		await page.evaluate(
			(src) =>
				new Promise((resolve) => {
					const img = new Image();
					img.onload = () => resolve(true);
					img.onerror = () => resolve(false);
					img.src = src;
				}),
			icon,
		),
		true,
		"the wrapper CSP permits the shared application icon",
	);
	assert.deepEqual(errors, []);
	console.log(
		JSON.stringify({
			previewRecovery: true,
			liveRecovery: true,
			manualDisconnect: true,
			noSpuriousFallback: true,
			tabTitle: true,
			favicon: true,
		}),
	);
} finally {
	await browser?.close();
	for (const socket of wss.clients) socket.terminate();
	wss.close();
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
}
