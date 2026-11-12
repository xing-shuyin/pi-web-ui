import assert from "node:assert/strict";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { readFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";
import { WebSocketServer } from "ws";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { desktopPage } from "../server/device-center/desktop-page.ts";
import { wrapperHtml, transformPortalHtml, portalHeaders } from "../server/device-center/path-portal.ts";
import { clipboardConnection } from "../server/device-center/desktop-clipboard.ts";
import { clipboardDigest } from "../server/device-center/desktop-clipboard-native.ts";

const origin = "http://127.0.0.1:8993";
function memory() {
	let value;
	const listeners = new Set(),
		writes = [];
	return {
		writes,
		listeners,
		copy(next) {
			value = next;
			for (const fn of listeners) fn();
		},
		backend: {
			read: async () => value,
			write: async (next) => {
				value = next;
				writes.push(next);
				for (const fn of listeners) fn();
			},
			watch: (fn) => {
				listeners.add(fn);
				return () => listeners.delete(fn);
			},
		},
	};
}
const local = memory(),
	remote = memory();
const wss = new WebSocketServer({ noServer: true, maxPayload: 49152 });
const jpeg = Buffer.from(
	(await readFile(new URL("unit/device-center-desktop.test.ts", import.meta.url), "utf8")).match(
		/const tinyImage = Buffer.from\(\s*"([^"]+)"/,
	)[1],
	"base64",
);
const server = await createServer({
	configFile: fileURLToPath(new URL("../web/vite.config.ts", import.meta.url)),
	cacheDir: fileURLToPath(new URL("../.safe-exec/clipboard-vite", import.meta.url)),
	server: { host: "127.0.0.1", port: 8993, strictPort: true, open: false },
	plugins: [
		{
			name: "clipboard-fixture",
			configureServer(vite) {
				vite.httpServer.on("upgrade", (req, socket, head) => {
					const path = new URL(req.url, origin).pathname;
					if (!path.endsWith("clipboard-ws") && path !== "/fixture/desktop-ws") return;
					wss.handleUpgrade(req, socket, head, (ws) => {
						if (path.endsWith("clipboard-ws"))
							clipboardConnection(ws, path.startsWith("/fixture/") ? remote.backend : local.backend, true);
						else {
							ws.send(JSON.stringify({ type: "ready", dynamicQuality: true }));
							ws.send(
								JSON.stringify({
									type: "displays",
									selected: new URL(req.url, origin).searchParams.get("display") || "left",
									displays: [
										{ id: "left", width: 1200, height: 900, primary: true },
										{ id: "right", width: 600, height: 900, primary: false },
									],
								}),
							);
							ws.send(jpeg, { binary: true });
						}
					});
				});
				vite.middlewares.use(async (req, res, next) => {
					if (req.url === "/clipboard-test") {
						res.setHeader("Content-Type", "text/html");
						res.end(
							await vite.transformIndexHtml(
								req.url,
								`<!doctype html><html><body><div id="root"></div><script type="module">
import React from 'react';import {createRoot} from 'react-dom/client';import {RemoteDesktopWindow} from '/src/components/RemoteDesktopWindow.tsx';import {openDeviceAccess,setDesktopMode,getDesktopAccess} from '/src/device-access.ts';import '/src/styles.css';
createRoot(document.getElementById('root')).render(React.createElement(RemoteDesktopWindow));
window.show=async()=>{await openDeviceAccess('test-host',location.origin,true,false,false,'Test host');setDesktopMode(getDesktopAccess(),'live')};
</script></body></html>`,
							),
						);
						return;
					}
					next();
				});
			},
		},
	],
});
let browser;
try {
	await server.listen();
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	const page = await browser.newPage({ viewport: { width: 1280, height: 850 } }),
		errors = [];
	await page.context().grantPermissions(["local-network-access"]);
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") console.log("browser:", message.text().slice(0, 240));
	});
	await page.route("**/api/device-center/devices/test-host/open", (route) =>
		route.fulfill({ json: { url: origin + "/device/test-host/__open?ticket=test" } }),
	);
	await page.route("**/device/test-host/__open?*", (route) => {
		const wrapper = wrapperHtml(
			"/fixture/",
			"desktop",
			new URL(origin),
			"Test host",
			JSON.stringify([origin, "test-host"]),
			undefined,
			"lan",
			undefined,
			undefined,
			origin + "/api/device-desktop/local/clipboard-ws",
		);
		return route.fulfill({
			contentType: "text/html",
			headers: { "content-security-policy": wrapper.csp },
			body: wrapper.html,
		});
	});
	await page.route("**/fixture/**", (route) => {
		const headers = portalHeaders(new URL(origin), "/fixture/");
		if (route.request().url().endsWith("/desktop"))
			return route.fulfill({
				contentType: "text/html",
				headers,
				body: transformPortalHtml(desktopPage(), origin + "/fixture/"),
			});
		if (route.request().url().includes("/api/device-desktop/"))
			return route.fulfill({
				headers,
				json: { enabled: true, supported: true, available: true, environmentEnabled: false },
			});
		return route.fulfill({ status: 404, headers });
	});
	await page.goto(origin + "/clipboard-test");
	const displayKey = "pi-web-ui:desktop-display:" + encodeURIComponent(JSON.stringify([origin, "test-host"]));
	await page.evaluate((key) => localStorage.setItem(key, "right"), displayKey);
	await page.waitForFunction(() => !!window.show);
	await page.evaluate(() => window.show());
	const select = page.getByRole("combobox", { name: "Clipboard" });
	await select.waitFor();
	await page
		.waitForFunction(() => !document.querySelector(".desktop-clipboard-control select")?.disabled, undefined, {
			timeout: 8000,
		})
		.catch(async (error) => {
			console.log(
				JSON.stringify({
					errors,
					frames: await Promise.all(
						page.frames().map(async (f) => ({
							url: f.url(),
							status: await f
								.locator("#status")
								.textContent({ timeout: 500 })
								.catch(() => null),
						})),
					),
				}),
			);
			throw error;
		});
	assert.equal(await select.inputValue(), "off");
	let desktop = page.frames().find((f) => f.url().endsWith("/fixture/desktop"));
	await desktop.waitForFunction(() => document.querySelector("#display-source")?.value === "right");
	await select.selectOption("both");
	await page.waitForFunction(() =>
		document.querySelector(".desktop-clipboard-control")?.title.includes("copy to sync"),
	);
	const text = { kind: "text", items: [{ name: "text.txt", data: Buffer.from("跨平台 clipboard") }] };
	local.copy(text);
	await wait(() => remote.writes.length === 1);
	assert.equal(clipboardDigest(remote.writes[0]), clipboardDigest(text));
	const files = {
		kind: "files",
		items: [
			{ name: "image.png", data: Buffer.alloc(180000, 4) },
			{ name: "报告.txt", data: Buffer.from("native file bytes") },
		],
	};
	remote.copy(files);
	await wait(() => local.writes.length === 1);
	assert.equal(clipboardDigest(local.writes[0]), clipboardDigest(files));
	await select.selectOption("send");
	await wait(() => local.listeners.size === 1 && remote.listeners.size === 0);
	remote.copy(text);
	await page.waitForTimeout(150);
	assert.equal(local.writes.length, 1);
	await select.selectOption("off");
	await wait(() => !local.listeners.size && !remote.listeners.size);
	await mkdir(new URL("../artifacts/device-center/", import.meta.url), { recursive: true });
	await page.screenshot({
		path: fileURLToPath(new URL("../artifacts/device-center/desktop-clipboard.png", import.meta.url)),
	});
	await page.goto(origin + "/device/test-host/__open?ticket=standalone");
	desktop = page.frames().find((f) => f.url().endsWith("/fixture/desktop"));
	if (!desktop) {
		await page.waitForTimeout(300);
		desktop = page.frames().find((f) => f.url().endsWith("/fixture/desktop"));
	}
	await desktop.waitForFunction(() => document.querySelector("#display-source")?.value === "right");
	await desktop.locator("#display-source").selectOption("left");
	await page.waitForFunction((key) => localStorage.getItem(key) === "left", displayKey);
	const standalone = page.getByRole("combobox", { name: "Clipboard" });
	await standalone.waitFor();
	await standalone.selectOption("receive");
	await wait(() => remote.listeners.size === 1);
	remote.copy(files);
	await wait(() => local.writes.length === 2);
	await page.close();
	await wait(() => !local.listeners.size && !remote.listeners.size);
	assert.deepEqual(errors, []);
	console.log(
		"Clipboard browser passed: floating and standalone, both directions, files, mode changes, cleanup, opaque frames.",
	);
} finally {
	await browser?.close();
	for (const ws of wss.clients) ws.terminate();
	wss.close();
	await server.close();
}
async function wait(predicate) {
	const until = Date.now() + 8000;
	while (!predicate()) {
		if (Date.now() > until) throw new Error("Clipboard fixture timeout");
		await new Promise((resolve) => setTimeout(resolve, 30));
	}
}
