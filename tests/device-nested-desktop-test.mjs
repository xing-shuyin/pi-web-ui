import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { build } from "esbuild";
import { WebSocketServer } from "ws";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { createDeviceRelay } from "../server/device-center/relay.ts";
import { createDeviceConnector } from "../server/device-center/connector.ts";
import { desktopPage } from "../server/device-center/desktop-page.ts";
import { desktopPreviewPage } from "../server/device-center/desktop-preview-page.ts";
import { clipboardConnection } from "../server/device-center/desktop-clipboard.ts";

const origin = "http://127.0.0.1:8991";
const compiled = await build({
	stdin: {
		contents: `import React from 'react';import{createRoot}from'react-dom/client';
import{DesktopPreview}from'./web/src/components/desktop-preview';import{RemoteDesktopWindow}from'./web/src/components/RemoteDesktopWindow';
import{openPageDesktop,openDeviceAccess}from'./web/src/device-access';
function App(){React.useEffect(()=>{void openPageDesktop(false,'PC B')},[]);return React.createElement(React.Fragment,null,
React.createElement('button',{onClick:()=>openDeviceAccess('pc-c',${JSON.stringify(origin)},true,false,false,'PC C')},'Choose PC C'),
React.createElement('aside',{style:{width:360,marginLeft:'auto'}},React.createElement(DesktopPreview,{visible:true})),React.createElement(RemoteDesktopWindow))}createRoot(document.getElementById('root')).render(React.createElement(App));`,
		resolveDir: process.cwd(),
		loader: "tsx",
	},
	bundle: true,
	write: false,
	minify: true,
	format: "iife",
	define: { "process.env.NODE_ENV": '"production"', "import.meta.env.BASE_URL": '"/"' },
});
const css = await readFile("web/src/styles.css", "utf8");
const tiny = Buffer.from(
	(await readFile("tests/unit/device-center-desktop.test.ts", "utf8")).match(
		/const tinyImage = Buffer.from\(\s*"([^"]+)"/,
	)[1],
	"base64",
);
const backends = new Map(),
	servers = [],
	sockets = [],
	connectors = [];
let forbiddenOpens = 0,
	browser,
	relay;
const wait = async (fn) => {
	const until = Date.now() + 10000;
	while (!fn()) {
		if (Date.now() > until) throw new Error("Fixture timed out");
		await new Promise((r) => setTimeout(r, 25));
	}
};
try {
	for (const [id, port] of [
		["pc-b", 8992],
		["pc-c", 8994],
	]) {
		let content = { kind: "text", items: [{ name: "text.txt", data: Buffer.from(id + " clipboard") }] };
		const backend = {
			read: async () => content,
			write: async (value) => {
				content = value;
			},
			watch: () => () => {},
		};
		backends.set(id, backend);
		const server = createServer((req, res) => {
			const path = new URL(req.url, origin).pathname;
			res.setHeader("content-type", "text/html");
			if (path === "/")
				return res.end(
					`<html><head><style>${css}</style></head><body><div id="root"></div><script>${compiled.outputFiles[0].text}</script></body></html>`,
				);
			if (path === "/desktop") return res.end(desktopPage());
			if (path === "/desktop-preview") return res.end(desktopPreviewPage());
			if (path === "/api/device-desktop/preview") {
				res.setHeader("content-type", "image/jpeg");
				return res.end(tiny);
			}
			res.setHeader("content-type", "application/json");
			if (path === "/api/device-center/chat-status")
				return res.end(JSON.stringify({ deviceId: id, hubUrl: origin, name: id }));
			if (path === "/api/device-center/devices")
				return res.end(
					JSON.stringify({
						devices: [
							{ id: "pc-b", name: "PC B", online: true },
							{ id: "pc-c", name: "PC C", online: true },
						],
					}),
				);
			if (path.endsWith("/open")) {
				forbiddenOpens++;
				res.writeHead(500);
				return res.end();
			}
			return res.end(
				JSON.stringify({ enabled: true, supported: true, available: true, environmentEnabled: false, os: "win32" }),
			);
		});
		const wss = new WebSocketServer({ noServer: true });
		sockets.push(wss);
		server.on("upgrade", (req, socket, head) =>
			wss.handleUpgrade(req, socket, head, (ws) => {
				if (req.url.startsWith("/desktop-clipboard-ws"))
					return clipboardConnection(ws, backend, !req.url.includes("viewOnly=1"));
				ws.send(JSON.stringify({ type: "ready", dynamicQuality: true }));
				ws.send(tiny);
			}),
		);
		await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
		servers.push(server);
	}
	const hub = createServer((req, res) => {
		if (!relay.handleRequest(req, res)) res.writeHead(404).end();
	});
	relay = createDeviceRelay({
		server: hub,
		publicUrl: origin,
		pathAccess: true,
		authenticateDevice: (id, key) => ["pc-b", "pc-c"].includes(id) && key === "test-key",
		getAccount: (req) => (req.headers.cookie?.includes("hub=test") ? "owner" : null),
		ownsDevice: (account, id) => account === "owner" && ["pc-b", "pc-c"].includes(id),
	});
	await new Promise((resolve) => hub.listen(8991, "127.0.0.1", resolve));
	servers.push(hub);
	for (const [id, port] of [
		["pc-b", 8992],
		["pc-c", 8994],
	])
		connectors.push(
			createDeviceConnector({
				hubUrl: origin,
				deviceId: id,
				credential: "test-key",
				localOrigin: `http://127.0.0.1:${port}`,
				localAuthToken: "test-token",
				onTask: async () => "done",
			}),
		);
	await wait(() => relay.isOnline("pc-b") && relay.isOnline("pc-c"));
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
	await context.addCookies([{ name: "hub", value: "test", url: origin }]);
	await context.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: undefined }));
	const page = await context.newPage(),
		errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") console.log(message.text().slice(0, 400));
	});
	await page.goto(origin + "/device/pc-b/");
	const app = page.frameLocator("body > iframe");
	await app.getByText(/Updated \d+s ago/).waitFor();
	await app.getByRole("button", { name: "Expand and control" }).click();
	await app
		.frameLocator(".remote-desktop-window iframe")
		.getByText("Connected · control enabled", { exact: true })
		.waitFor();
	await page.locator(".browser-clipboard summary").click();
	await page.getByRole("textbox", { name: "Clipboard text" }).fill("from browser to B");
	await page.getByRole("button", { name: "Send to remote" }).click();
	await page.getByText("Written to remote clipboard. Paste on the remote computer.", { exact: true }).waitFor();
	assert.equal((await backends.get("pc-b").read()).items[0].data.toString(), "from browser to B");
	await app.getByRole("button", { name: "Back to preview", exact: true }).last().click();
	await app.getByRole("button", { name: "Choose PC C", exact: true }).click();
	await app.getByText(/Updated \d+s ago/).waitFor();
	await app.getByRole("button", { name: "Expand and control" }).click();
	const live = app.frameLocator(".remote-desktop-window iframe").frameLocator("iframe");
	await live.getByText("Connected · control enabled", { exact: true }).waitFor();
	if ((await page.locator(".browser-clipboard").getAttribute("open")) === null)
		await page.locator(".browser-clipboard summary").click();
	await page.getByRole("button", { name: "Read remote text" }).click();
	await page.waitForFunction(() => document.querySelector(".browser-clipboard textarea")?.value === "pc-c clipboard");
	await page.getByRole("textbox", { name: "Clipboard text" }).fill("from browser to C");
	await page.getByRole("button", { name: "Send to remote" }).click();
	await page.getByText("Written to remote clipboard. Paste on the remote computer.", { exact: true }).waitFor();
	assert.equal((await backends.get("pc-c").read()).items[0].data.toString(), "from browser to C");
	assert.equal((await backends.get("pc-b").read()).items[0].data.toString(), "from browser to B");
	await page.getByRole("button", { name: "Copy locally" }).click();
	await page.getByText("Press Ctrl/Cmd+C to copy the selected text.", { exact: true }).waitFor();
	assert.equal(
		await page.getByRole("textbox", { name: "Clipboard text" }).evaluate((el) => el.selectionEnd - el.selectionStart),
		"from browser to C".length,
	);
	await live.locator("#viewonly").check();
	await live.getByText("Connected · view only", { exact: true }).waitFor();
	await page.waitForFunction(
		() =>
			[...document.querySelectorAll(".browser-clipboard button")].find((b) => b.textContent === "Send to remote")
				?.disabled,
	);
	const popupPromise = page.waitForEvent("popup");
	await app.getByRole("button", { name: "Separate tab", exact: true }).click();
	const popup = await popupPromise;
	await popup.frameLocator("iframe").getByText("Connected · control enabled", { exact: true }).waitFor();
	assert.match(popup.url(), /\/device\/pc-c\//);
	await popup.close();
	await app.getByText(/Updated \d+s ago/).waitFor();
	assert.equal(forbiddenOpens, 0);
	assert.deepEqual(errors, []);
	await mkdir("artifacts/device-center", { recursive: true });
	await page.screenshot({ path: "artifacts/device-center/hub-nested-desktop.png" });
	console.log(
		"PASS: real Hub + two device connectors, nested preview/control, clipboard identity, independent tab and return.",
	);
} finally {
	await browser?.close();
	for (const connector of connectors) connector.close();
	relay?.close();
	for (const wss of sockets) {
		for (const ws of wss.clients) ws.terminate();
		wss.close();
	}
	for (const server of servers) {
		server.closeAllConnections();
		server.close();
	}
}
