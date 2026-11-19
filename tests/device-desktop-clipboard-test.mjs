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
			read: async () => {
				if (value?.error) throw new Error(value.error);
				return value;
			},
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
const input = [];
let frameAcks = 0,
	connections = 0,
	remoteOS = "win32";
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
							connections++;
							const timer = setInterval(() => {
								if (ws.readyState === 1) ws.send(jpeg, { binary: true });
							}, 60);
							ws.once("close", () => clearInterval(timer));
							ws.on("message", (data) => {
								const packet = JSON.parse(data.toString());
								if (packet.type === "ack") frameAcks++;
								if (packet.type === "key" || packet.type === "release") input.push(packet);
							});
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
	const browserContext = await browser.newContext({ viewport: { width: 1280, height: 850 } });
	const page = await browserContext.newPage(),
		errors = [];
	await page.addInitScript(() => {
		Object.defineProperty(navigator, "platform", { value: "MacIntel" });
		Object.defineProperty(navigator, "userAgentData", { value: undefined });
	});
	await page.context().grantPermissions(["local-network-access"]);
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") console.log("browser:", message.text().slice(0, 240));
	});
	await page
		.context()
		.route("**/api/device-center/devices/test-host/open", (route) =>
			route.fulfill({ json: { url: origin + "/device/test-host/__open?ticket=test" } }),
		);
	await page.context().route("**/device/test-host/__open?*", (route) => {
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
	await page.context().route("**/fixture/**", (route) => {
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
				json: { enabled: true, supported: true, available: true, environmentEnabled: false, os: remoteOS },
			});
		return route.fulfill({ status: 404, headers });
	});
	await page.goto(origin + "/clipboard-test");
	const displayKey = "pi-web-ui:desktop-display:" + encodeURIComponent(JSON.stringify([origin, "test-host"]));
	await page.evaluate((key) => localStorage.setItem(key, "right"), displayKey);
	await page.waitForFunction(() => !!window.show);
	await page.evaluate(() => window.show());
	const select = page.getByRole("combobox", { name: "Clipboard" });
	await page.locator(".desktop-clipboard-control select").waitFor({ state: "attached" });
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
	let desktop = page.frames().find((f) => f.url().endsWith("/fixture/desktop"));
	await desktop.waitForFunction(() => document.querySelector("#display-source")?.value === "right");
	assert.equal(await page.locator(".desktop-clipboard-launcher:visible").count(), 0);
	assert.ok(
		await desktop
			.locator("#clipboard")
			.evaluate((el) => el.getBoundingClientRect().left < 160 && el.getBoundingClientRect().top < 60),
	);
	await desktop.getByRole("button", { name: "Clipboard", exact: true }).click();
	await page.getByRole("dialog", { name: "Clipboard", exact: true }).waitFor();
	await select.waitFor();
	assert.equal(await select.inputValue(), "off", "Opening clipboard UI must not enable sync");
	await desktop.waitForFunction(() => document.querySelector("#display-source")?.value === "right");
	await select.selectOption("both");
	await page.waitForFunction(() =>
		document.querySelector(".desktop-clipboard-control")?.title.includes("copy to sync"),
	);
	await page.getByRole("button", { name: "Close", exact: true }).click();
	await desktop.locator("#quality-panel").evaluate((el) => {
		el.open = true;
	});
	await desktop.locator("#quality-mode").selectOption("sharp");
	await desktop.locator("#quality-fps").selectOption("120");
	await desktop.locator("#quality-resolution").selectOption("1280x720");
	await desktop.locator("#settings").evaluate((el) => {
		el.open = true;
	});
	await desktop.locator("#map-shortcuts").check();
	await desktop.locator("#scale").uncheck();
	await page.waitForFunction(() =>
		Object.keys(localStorage)
			.filter((key) => key.startsWith("pi-web-ui:desktop-preferences:"))
			.some((key) => JSON.parse(localStorage.getItem(key)).scale === false),
	);
	await page.reload();
	await page.waitForFunction(() => !!window.show);
	await page.evaluate(() => window.show());
	await page.waitForFunction(() =>
		document.querySelector(".desktop-clipboard-control")?.title.includes("copy to sync"),
	);
	desktop = page.frames().find((f) => f.url().endsWith("/fixture/desktop"));
	await desktop.waitForFunction(() => document.querySelector("#quality-fps").value === "120");
	assert.equal(await desktop.locator("#quality-mode").inputValue(), "sharp");
	assert.equal(await desktop.locator("#quality-resolution").inputValue(), "1280x720");
	assert.equal(await desktop.locator("#map-shortcuts").isChecked(), true);
	assert.equal(await desktop.locator("#scale").isChecked(), false);
	await desktop.getByRole("button", { name: "Clipboard", exact: true }).click();
	assert.equal(await select.inputValue(), "both");
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
	await page.getByRole("button", { name: "Close", exact: true }).click();
	assert.equal(local.listeners.size + remote.listeners.size, 2, "Closing settings keeps selected sync enabled");
	local.copy({ error: "clipboard-folder" });
	await desktop
		.locator("#clipboard-transfer-status")
		.getByText(/Folder not synced/)
		.waitFor();
	assert.equal(
		remote.writes.length,
		1,
		"Failed copy must retain the previous clipboard without silently claiming success",
	);
	await desktop.getByRole("button", { name: "Clipboard", exact: true }).click();
	assert.equal(await select.inputValue(), "both");
	await select.selectOption("send");
	await wait(() => local.listeners.size === 1 && remote.listeners.size === 0);
	remote.copy(text);
	await page.waitForTimeout(150);
	assert.equal(local.writes.length, 1);
	await select.selectOption("off");
	await wait(() => !local.listeners.size && !remote.listeners.size);
	await mkdir(new URL("../artifacts/device-center/", import.meta.url), { recursive: true });
	await page.getByRole("button", { name: "Close", exact: true }).click();
	await desktop.locator("#toolbar").screenshot({ path: "artifacts/device-center/clipboard-direct-toolbar.png" });
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
	assert.equal(await page.locator("#clipboard-launcher:visible").count(), 0);
	await desktop.getByRole("button", { name: "Clipboard", exact: true }).click();
	await standalone.waitFor();
	assert.equal(await standalone.inputValue(), "off");
	assert.equal(local.listeners.size + remote.listeners.size, 0);
	await standalone.selectOption("receive");
	await wait(() => remote.listeners.size === 1);
	await page.reload();
	await wait(() => remote.listeners.size === 1);
	await page
		.frameLocator("iframe")
		.locator("#quality-fps")
		.evaluate((el) => el.value)
		.then((value) => assert.equal(value, "120"));
	await page.frameLocator("iframe").getByRole("button", { name: "Clipboard", exact: true }).click();
	assert.equal(await standalone.inputValue(), "receive");
	remote.copy(files);
	await wait(() => local.writes.length === 2);
	await standalone.selectOption("both");
	await page.getByRole("button", { name: "Close", exact: true }).click();
	desktop = page.frames().find((f) => f.url().endsWith("/fixture/desktop"));
	await desktop.locator("#canvas").focus();
	await desktop.evaluate(() => {
		const screen = document.querySelector("#screen"),
			canvas = document.querySelector("#canvas");
		window.originalScreen = screen.getBoundingClientRect().toJSON();
		window.shifted = false;
		const observer = new MutationObserver(() => {
			const rect = screen.getBoundingClientRect();
			if (rect.y !== window.originalScreen.y || rect.height !== window.originalScreen.height) window.shifted = true;
		});
		observer.observe(document.querySelector("main"), { childList: true, subtree: true, attributes: true });
		window.originalCanvas = canvas;
	});
	const opened = connections,
		acks = frameAcks;
	const before = input.length;
	await wait(() => local.listeners.size === 1 && remote.listeners.size === 1);
	for (let i = 0; i < 12; i++) {
		const value = { kind: "text", items: [{ name: "text.txt", data: Buffer.from("copy " + i) }] };
		const [from, to] = i % 2 ? [remote, local] : [local, remote];
		const count = to.writes.length;
		await page.keyboard.press("Meta+c");
		from.copy(value);
		await wait(() => to.writes.length === count + 1);
		assert.deepEqual(to.writes.at(-1), value);
		await page.keyboard.press("Meta+v");
	}
	await wait(
		() =>
			input.slice(before).filter((p) => p.type === "key" && p.action === "up" && p.code === "ControlLeft").length ===
			24,
	);
	const keys = input.slice(before).filter((p) => p.type === "key");
	assert.equal(
		keys.some((p) => p.code.startsWith("Meta")),
		false,
	);
	assert.equal(keys.filter((p) => p.action === "down" && p.code === "KeyC").length, 12);
	assert.equal(keys.filter((p) => p.action === "down" && p.code === "KeyV").length, 12);
	local.copy({ error: "clipboard-folder" });
	await desktop
		.locator("#clipboard-transfer-status")
		.getByText(/Folder not synced/)
		.waitFor();
	assert.equal(
		await desktop.evaluate(
			() =>
				!window.shifted &&
				window.originalCanvas === document.querySelector("#canvas") &&
				document.activeElement === window.originalCanvas,
		),
		true,
	);
	assert.equal(connections, opened, "clipboard changes must not reconnect the desktop");
	assert.ok(frameAcks > acks + 4, "video kept painting and acknowledging frames during copies");
	await page.close();
	await wait(() => !local.listeners.size && !remote.listeners.size);
	remoteOS = "darwin";
	const winViewer = await page.context().newPage();
	await winViewer.addInitScript(() => {
		Object.defineProperty(navigator, "platform", { value: "Win32" });
		Object.defineProperty(navigator, "userAgentData", { value: undefined });
	});
	await winViewer.goto(origin + "/device/test-host/__open?ticket=standalone");
	const mac = winViewer.frameLocator("iframe");
	await mac.locator("#canvas").waitFor();
	await mac.locator("#status[data-connected=true]").waitFor();
	for (const enabled of [false, true]) {
		await mac.locator("#settings").evaluate((el) => {
			el.open = true;
		});
		await mac.locator("#map-shortcuts").setChecked(enabled);
		await mac.locator("#canvas").focus();
		const i = input.length;
		await winViewer.keyboard.press("Control+v");
		await wait(() => input.slice(i).filter((k) => k.type === "key").length >= 4);
		const modifier = enabled ? "MetaLeft" : "ControlLeft";
		assert.deepEqual(
			input
				.slice(i)
				.filter((k) => k.type === "key")
				.map((k) => [k.action, k.code]),
			[
				["down", modifier],
				["down", "KeyV"],
				["up", "KeyV"],
				["up", modifier],
			],
		);
	}
	await winViewer.close();
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
