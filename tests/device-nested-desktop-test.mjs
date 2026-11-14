import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { createDesktopFiles } from "../server/device-center/desktop-files.ts";
import { createDeviceLanServer } from "../server/device-center/device-lan.ts";
import { createDeviceLanAccess } from "../server/device-center/device-lan-access.ts";
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
const home = await mkdtemp(join(tmpdir(), "pi-nested-transfer-")),
	fileServices = [];
let lanAccess, lanTransport;
let forbiddenOpens = 0,
	browser,
	relay;
let macPermissionMissing = false;
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
		const app = express();
		await mkdir(join(home, id));
		fileServices.push(createDesktopFiles({ app, home: join(home, id), allowed: () => true, enabled: () => true }));
		app.use((req, res) => {
			const path = new URL(req.url, origin).pathname;
			res.setHeader("content-type", "text/html");
			if (path === "/")
				return res.end(
					`<html><head><style>${css}</style></head><body><div id="root"></div><script>${compiled.outputFiles[0].text}</script></body></html>`,
				);
			if (path === "/desktop") return res.end(desktopPage());
			if (path === "/desktop-preview") return res.end(desktopPreviewPage());
			if (path === "/api/device-desktop/preview") {
				if (id === "pc-c" && macPermissionMissing) {
					res.writeHead(503, { "content-type": "application/json" });
					return res.end(JSON.stringify({ error: "MAC_SCREEN_PERMISSION_REQUIRED: denied" }));
				}
				res.setHeader("content-type", "image/jpeg");
				return res.end(tiny);
			}
			res.setHeader("content-type", "application/json");
			if (path === "/api/device-center/chat-status")
				return res.end(JSON.stringify({ deviceId: id, hubUrl: origin, name: id }));
			if (path === "/api/device-center/devices")
				return res.writeHead(403).end("Remote device pairing must not supply the viewer device list");
			if (path.endsWith("/open")) {
				forbiddenOpens++;
				res.writeHead(500);
				return res.end();
			}
			return res.end(
				JSON.stringify({ enabled: true, supported: true, available: true, environmentEnabled: false, os: "win32" }),
			);
		});
		const server = createServer(app);
		const wss = new WebSocketServer({ noServer: true });
		sockets.push(wss);
		server.on("upgrade", (req, socket, head) =>
			wss.handleUpgrade(req, socket, head, (ws) => {
				if (req.url.startsWith("/desktop-clipboard-ws"))
					return clipboardConnection(ws, backend, !req.url.includes("viewOnly=1"));
				if (id === "pc-c" && macPermissionMissing) {
					ws.send(JSON.stringify({ type: "error", message: "MAC_SCREEN_PERMISSION_REQUIRED: denied" }));
					ws.close();
					return;
				}
				ws.send(JSON.stringify({ type: "ready", dynamicQuality: true }));
				ws.send(tiny);
			}),
		);
		await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
		servers.push(server);
	}
	const hub = createServer((req, res) => {
		const target = /^\/open\/(pc-[bc])$/.exec(req.url);
		if (target) {
			void relay.handleOpen(req, res, target[1]);
			return;
		}
		if (!relay.handleRequest(req, res)) res.writeHead(404).end();
	});
	relay = createDeviceRelay({
		server: hub,
		publicUrl: origin,
		pathAccess: true,
		authenticateDevice: (id, key) => ["pc-b", "pc-c"].includes(id) && key === "test-key",
		getAccount: (req) => (req.headers.cookie?.includes("hub=test") ? "owner" : null),
		ownsDevice: (account, id) => account === "owner" && ["pc-b", "pc-c"].includes(id),
		getDeviceName: (id) => (id === "pc-b" ? "PC B" : "PC C"),
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
	// UI 文案取 navigator.language；断言写的是英文，钉住 locale 免得中文机器上假红。
	const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, locale: "en-US" });
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
	await page.evaluate(() => window.postMessage({ type: "desktop-clipboard-show" }, "*"));
	assert.equal(await page.locator(".desktop-clipboard-dialog[open]").count(), 0, "Ignore an unrelated sender");
	assert.equal(
		await page.locator("#clipboard-launcher:visible").count(),
		0,
		"No duplicate launcher outside the desktop window",
	);
	const currentDesktop = app.frameLocator(".remote-desktop-window iframe");
	await currentDesktop.locator("#quality-panel").evaluate((el) => {
		el.open = true;
	});
	await currentDesktop.locator("#quality-fps").selectOption("120");
	await currentDesktop.locator("#quality-panel").evaluate((el) => {
		el.open = false;
	});
	await currentDesktop
		.locator("body")
		.evaluate(() => parent.postMessage({ type: "desktop-clipboard-available", connected: true, viewOnly: false }, "*"));
	await page.locator("#clipboard-launcher").waitFor();
	const legacy = await page.locator("#clipboard-launcher").boundingBox();
	assert.ok(legacy.x < 20 && legacy.y < 20, "Legacy fallback stays at the top left");
	await currentDesktop
		.locator("body")
		.evaluate(() =>
			parent.postMessage({ type: "desktop-clipboard-available", connected: true, viewOnly: false, toolbar: true }, "*"),
		);
	await page.locator("#clipboard-launcher").waitFor({ state: "hidden" });
	await mkdir("artifacts/device-center", { recursive: true });
	await currentDesktop.locator("#toolbar").screenshot({ path: "artifacts/device-center/clipboard-nested-toolbar.png" });
	assert.ok(
		await app
			.frameLocator(".remote-desktop-window iframe")
			.locator("#clipboard")
			.evaluate((el) => el.getBoundingClientRect().left < 160 && el.getBoundingClientRect().top < 60),
	);
	await app
		.frameLocator(".remote-desktop-window iframe")
		.getByRole("button", { name: "Clipboard", exact: true })
		.click();
	await page.getByRole("dialog", { name: "Clipboard", exact: true }).waitFor();
	await page.getByRole("textbox", { name: "Clipboard text" }).fill("from browser to B");
	await page.getByRole("button", { name: "Send to remote" }).click();
	await page.getByText("Written to remote clipboard. Paste on the remote computer.", { exact: true }).waitFor();
	assert.equal((await backends.get("pc-b").read()).items[0].data.toString(), "from browser to B");
	await page.getByRole("button", { name: "Close", exact: true }).click();
	await app.getByRole("button", { name: "Back to preview", exact: true }).last().click();
	macPermissionMissing = true;
	await app.getByRole("button", { name: "Choose device", exact: true }).click();
	await app.getByRole("button", { name: /PC C/ }).click();
	await app.getByText(/Screen Recording permission is missing on the controlled Mac/).waitFor();
	macPermissionMissing = false;
	await app.getByText(/Updated \d+s ago/).waitFor({ timeout: 20000 });
	macPermissionMissing = true;
	await app.getByRole("button", { name: "Expand and control" }).click();
	const live = app.frameLocator(".remote-desktop-window iframe").frameLocator("iframe");
	await live.getByText(/Screen Recording permission is missing on the controlled Mac/).waitFor();
	macPermissionMissing = false;
	await live.getByText("Connected · control enabled", { exact: true }).waitFor({ timeout: 20000 });
	await live.getByRole("button", { name: "File transfer", exact: true }).click();
	const archiveBytes = Buffer.alloc(3 * 1024 * 1024 + 37, 0xab);
	const fileDialog = page.locator("#file-transfer-dialog"),
		leftFiles = fileDialog.locator(".fm-pane").nth(0),
		rightFiles = fileDialog.locator(".fm-pane").nth(1);
	const chooserPromise = page.waitForEvent("filechooser");
	await leftFiles.getByRole("button", { name: "Choose files", exact: true }).click();
	await (
		await chooserPromise
	).setFiles({ name: "current-archive.zip", mimeType: "application/zip", buffer: archiveBytes });
	await leftFiles.getByRole("checkbox", { name: "current-archive.zip", exact: true }).check();
	await leftFiles.getByRole("button", { name: "Send →", exact: true }).click();
	await fileDialog.getByText("Completed · verified", { exact: true }).waitFor();
	const receivedC = join(home, "pc-c");
	assert.deepEqual(await readFile(join(receivedC, "current-archive.zip")), archiveBytes);
	await rightFiles.getByRole("checkbox", { name: "current-archive.zip", exact: true }).check();
	const nestedDownloadPromise = page.waitForEvent("download");
	await rightFiles.getByRole("button", { name: "← Receive", exact: true }).click();
	const nestedDownload = await nestedDownloadPromise;
	await nestedDownload.saveAs(join(home, "nested-download.zip"));
	assert.deepEqual(await readFile(join(home, "nested-download.zip")), archiveBytes);
	assert.equal((await readdir(join(home, "pc-b"))).length, 0, "C selection must never write files to B");
	await fileDialog.getByRole("button", { name: "Hide", exact: true }).click();
	assert.equal(await live.locator("#quality-fps").inputValue(), "60", "A different target keeps its own preferences");
	await live.locator("#quality-panel").evaluate((el) => {
		el.open = true;
	});
	await live.locator("#quality-fps").selectOption("240");
	await live.locator("#quality-panel").evaluate((el) => {
		el.open = false;
	});
	assert.equal(await page.locator("#clipboard-launcher:visible").count(), 0);
	assert.ok(
		await live
			.locator("#clipboard")
			.evaluate((el) => el.getBoundingClientRect().left < 160 && el.getBoundingClientRect().top < 60),
	);
	await live.getByRole("button", { name: "Clipboard", exact: true }).click();
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
	await page.getByRole("button", { name: "Close", exact: true }).click();
	await live.locator("#viewonly").check();
	await live.getByText("Connected · view only", { exact: true }).waitFor();
	await live.getByRole("button", { name: "Clipboard", exact: true }).click();
	await page.waitForFunction(
		() =>
			[...document.querySelectorAll(".browser-clipboard button")].find((b) => b.textContent === "Send to remote")
				?.disabled,
	);
	await page.getByRole("button", { name: "Close", exact: true }).click();
	const popupPromise = page.waitForEvent("popup");
	await app.getByRole("button", { name: "Separate tab", exact: true }).click();
	const popup = await popupPromise;
	await popup.frameLocator("iframe").getByText("Connected · view only", { exact: true }).waitFor();
	assert.equal(await popup.frameLocator("iframe").locator("#quality-fps").inputValue(), "240");
	assert.equal(await popup.locator("#clipboard-launcher:visible").count(), 0);
	await popup.frameLocator("iframe").getByRole("button", { name: "Clipboard", exact: true }).click();
	await popup.getByRole("button", { name: "Read remote text", exact: true }).click();
	await popup.waitForFunction(
		() => document.querySelector(".browser-clipboard textarea")?.value === "from browser to C",
	);
	assert.match(popup.url(), /\/device\/pc-c\//);
	await popup.close();
	await app.getByText(/Updated \d+s ago/).waitFor();
	assert.equal(forbiddenOpens, 0);
	assert.deepEqual(errors, []);
	await mkdir("artifacts/device-center", { recursive: true });
	await page.screenshot({ path: "artifacts/device-center/hub-nested-desktop.png" });
	const direct = await context.newPage();
	await direct.goto("http://127.0.0.1:8992/desktop");
	await direct.getByText("Connected · control enabled", { exact: true }).waitFor();
	await direct.getByRole("button", { name: "Clipboard", exact: true }).click();
	await direct.getByRole("button", { name: "Read remote text", exact: true }).click();
	await direct.waitForFunction(
		() => document.querySelector(".browser-clipboard textarea")?.value === "from browser to B",
	);
	await direct.getByRole("button", { name: "Close", exact: true }).click();
	await direct.locator("#disconnect").click();
	await direct.getByRole("button", { name: "Clipboard", exact: true }).click();
	assert.equal(await direct.getByRole("button", { name: "Read remote text", exact: true }).isEnabled(), false);
	await direct.getByText("Connect the remote desktop first.", { exact: true }).waitFor();
	await direct.close();
	lanTransport = createDeviceLanServer({
		localOrigin: "http://127.0.0.1:8992",
		localAuthToken: "test-token",
		addresses: () => ["127.0.0.1"],
	});
	lanAccess = createDeviceLanAccess({ allowLoopback: true });
	const localOrigin = "http://127.0.0.1:8998";
	const controllerHome = join(home, "controller");
	await mkdir(controllerHome);
	await writeFile(join(controllerHome, "lan-archive.zip"), archiveBytes);
	const controllerApp = express();
	fileServices.push(
		createDesktopFiles({
			app: controllerApp,
			home: controllerHome,
			base: "/api/device-desktop/local/files",
			allowed: (req) => req.headers["x-pi-local-files"] === "1",
			enabled: () => true,
		}),
	);
	controllerApp.use((req, res) => {
		if (!lanAccess.handleRequest(req, res)) res.writeHead(404).end();
	});
	const local = createServer(controllerApp);
	local.on("upgrade", (req, socket, head) => {
		if (!lanAccess.handleUpgrade(req, socket, head)) socket.destroy();
	});
	await new Promise((resolve) => local.listen(8998, "127.0.0.1", resolve));
	servers.push(local);
	const ticket = async (id) =>
		(await (await fetch(origin + "/open/" + id, { method: "POST", headers: { cookie: "hub=test", origin } })).json())
			.url;
	const opened = await lanAccess.open(await lanTransport.issueGrant(), {
		deviceId: "pc-b",
		hubUrl: origin,
		origin: localOrigin,
		desktop: false,
		valid: () => true,
		renew: () => lanTransport.issueGrant(),
		fallback: () => ticket("pc-b"),
		openDevice: ticket,
		listDevices: async () => [
			{ id: "pc-b", name: "PC B", online: true },
			{ id: "pc-c", name: "PC C", online: true },
		],
	});
	const localPage = await context.newPage();
	localPage.on("console", (message) => {
		if (message.type() === "error") console.log("LAN:", message.text().replace(/[a-f0-9]{64}/g, "CAPABILITY"));
	});
	localPage.on("requestfailed", (request) =>
		console.log(
			"LAN request failed:",
			request.url().replace(/[a-f0-9]{64}/g, "CAPABILITY"),
			request.failure()?.errorText,
		),
	);
	await localPage.goto(localOrigin + opened.url);
	const remoteApp = localPage.frameLocator("body > iframe");
	await remoteApp.getByText(/Updated \d+s ago/).waitFor();
	await remoteApp.getByRole("button", { name: "Choose device", exact: true }).click();
	await remoteApp.getByRole("button", { name: /PC C Online/ }).click();
	await remoteApp.getByText(/Updated \d+s ago/).waitFor();
	await remoteApp.getByRole("button", { name: "Expand and control" }).click();
	const other = remoteApp.frameLocator(".remote-desktop-window iframe").frameLocator("iframe").frameLocator("iframe");
	await other.getByText("Connected · control enabled", { exact: true }).waitFor();
	await remoteApp
		.locator(".remote-desktop-titlebar")
		.getByRole("button", { name: "Choose device", exact: true })
		.click();
	await remoteApp.getByRole("button", { name: /PC B Online/ }).click();
	const own = remoteApp.frameLocator(".remote-desktop-window iframe");
	await own.getByText("Connected · control enabled", { exact: true }).waitFor();
	await own.getByRole("button", { name: "File transfer", exact: true }).click();
	const nativeDialog = localPage.locator("#file-transfer-dialog"),
		nativeLeft = nativeDialog.locator(".fm-pane").first();
	await nativeLeft.getByRole("checkbox", { name: "lan-archive.zip", exact: true }).check();
	await nativeLeft.getByRole("button", { name: "Send →", exact: true }).click();
	await nativeDialog.getByText("Completed · verified", { exact: true }).waitFor();
	assert.deepEqual(await readFile(join(home, "pc-b", "lan-archive.zip")), archiveBytes);
	await localPage.close();
	console.log(
		"PASS: real Hub + two device connectors, nested preview/control, clipboard identity, independent tab and return.",
	);
} finally {
	await browser?.close();
	lanAccess?.close();
	lanTransport?.close();
	for (const service of fileServices) service.close();
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
	await rm(home, { recursive: true, force: true });
}
