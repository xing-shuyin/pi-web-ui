import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import express from "express";
import { WebSocketServer } from "ws";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { createDesktopFiles } from "../server/device-center/desktop-files.ts";
import { desktopPage } from "../server/device-center/desktop-page.ts";
import { createDeviceConnector } from "../server/device-center/connector.ts";
import { createDeviceRelay } from "../server/device-center/relay.ts";
import { createDeviceLanServer } from "../server/device-center/device-lan.ts";
import { createDeviceLanAccess } from "../server/device-center/device-lan-access.ts";

const root = await mkdtemp(join(tmpdir(), "pi-files-browser-")),
	home = join(root, "receiver");
await mkdir(home);
const targetOrigin = "http://127.0.0.1:8981",
	hubOrigin = "http://127.0.0.1:8982",
	localOrigin = "http://127.0.0.1:8983";
const app = express(),
	files = createDesktopFiles({ app, home, allowed: () => true, enabled: () => true });
app.get("/desktop", (_req, res) => res.type("html").send(desktopPage()));
app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.get("/api/device-desktop/status", (_req, res) =>
	res.json({ enabled: true, available: true, supported: true, os: "win32" }),
);
const target = createServer(app),
	wss = new WebSocketServer({ noServer: true });
target.on("upgrade", (req, socket, head) =>
	wss.handleUpgrade(req, socket, head, (ws) => ws.send(JSON.stringify({ type: "ready" }))),
);
let relay, connector, browser, access, lan;
const hub = createServer((req, res) => {
	if (req.url === "/open") void relay.handleOpen(req, res, "target");
	else if (!relay.handleRequest(req, res)) res.writeHead(404).end();
});
relay = createDeviceRelay({
	server: hub,
	publicUrl: hubOrigin,
	pathAccess: true,
	authenticateDevice: (id, key) => id === "target" && key === "key",
	getAccount: () => "owner",
	ownsDevice: (_owner, id) => id === "target",
});
const localHome = join(root, "controller");
await mkdir(localHome);
const controllerApp = express();
const localFiles = createDesktopFiles({
	app: controllerApp,
	home: localHome,
	base: "/api/device-desktop/local/files",
	allowed: (req) => req.headers["x-pi-local-files"] === "1",
	enabled: () => true,
});
controllerApp.use((req, res) => {
	if (!access?.handleRequest(req, res)) res.writeHead(404).end();
});
const source = createServer(controllerApp);
source.on("upgrade", (req, socket, head) => {
	if (!access.handleUpgrade(req, socket, head)) socket.destroy();
});
const servers = [target, hub, source];
const digest = async (path) => {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
};
let rss = process.memoryUsage().rss;
const memory = setInterval(() => (rss = Math.max(rss, process.memoryUsage().rss)), 100);
try {
	for (const [index, server] of servers.entries())
		await new Promise((resolve) => server.listen(8981 + index, "127.0.0.1", resolve));
	connector = createDeviceConnector({
		hubUrl: hubOrigin,
		deviceId: "target",
		credential: "key",
		localOrigin: targetOrigin,
		localAuthToken: "token",
		onTask: async () => "",
	});
	const started = Date.now();
	while (!relay.isOnline("target")) {
		assert.ok(Date.now() - started < 10000);
		await new Promise((r) => setTimeout(r, 20));
	}
	const archive = join(root, "large-archive.zip"),
		block = randomBytes(1024 * 1024),
		count = process.env.PI_FILE_TEST_SMALL ? 70 : 1025;
	const file = await open(archive, "wx");
	try {
		for (let index = 0; index < count; index++) await file.write(block);
	} finally {
		await file.close();
	}
	const expected = await digest(archive),
		bytes = count * block.length;
	const folder = join(root, "selected-folder");
	await mkdir(join(folder, "nested"), { recursive: true });
	await writeFile(join(folder, "nested/settings.ini"), "[section]\nvalue=one\n");
	await writeFile(join(folder, "other.zip"), randomBytes(100000));
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 800 } });
	const failures = [];
	const page = await context.newPage();
	page.on("pageerror", (e) => failures.push(e.message));
	const ticket = (await (await fetch(hubOrigin + "/open", { method: "POST", headers: { origin: hubOrigin } })).json())
		.url;
	await page.goto(ticket + "&next=%2Fdesktop");
	const frame = page.frameLocator("iframe");
	await frame.getByRole("button", { name: "File transfer", exact: true }).click();
	const uploadAt = Date.now(),
		dialog = page.locator("#file-transfer-dialog"),
		left = dialog.locator(".fm-pane").first(),
		right = dialog.locator(".fm-pane").nth(1);
	const chooser = page.waitForEvent("filechooser");
	await left.getByRole("button", { name: "Choose files", exact: true }).click();
	await (await chooser).setFiles(archive);
	await left.getByRole("checkbox", { name: "large-archive.zip", exact: true }).check();
	await left.getByRole("button", { name: "Send →", exact: true }).click();
	await dialog.getByText("Completed · verified", { exact: true }).waitFor({ timeout: 360000 });
	const saved = join(home, "large-archive.zip");
	assert.equal(await digest(saved), expected);
	console.log(
		JSON.stringify({ phase: "Hub browser upload", bytes, sha256: expected, seconds: (Date.now() - uploadAt) / 1000 }),
	);
	await right.getByRole("checkbox", { name: "large-archive.zip", exact: true }).check();
	const downloadPromise = page.waitForEvent("download");
	await right.getByRole("button", { name: "← Receive", exact: true }).click();
	const download = await downloadPromise;
	await download.saveAs(join(root, "downloaded.zip"));
	assert.equal(await digest(join(root, "downloaded.zip")), expected);
	const folderChooser = page.waitForEvent("filechooser");
	await left.getByRole("button", { name: "Choose folder", exact: true }).click();
	await (await folderChooser).setFiles(folder);
	await left.getByRole("checkbox", { name: "selected-folder", exact: true }).check();
	await left.getByRole("button", { name: "Send →", exact: true }).click();
	await page.waitForFunction(
		() =>
			[...document.querySelectorAll(".fm-tasks tbody tr")].filter((r) => r.textContent.includes("Completed · verified"))
				.length === 2,
	);
	assert.equal(await readFile(join(home, "selected-folder/nested/settings.ini"), "utf8"), "[section]\nvalue=one\n");
	lan = createDeviceLanServer({ localOrigin: targetOrigin, localAuthToken: "token", addresses: () => ["127.0.0.1"] });
	access = createDeviceLanAccess({ allowLoopback: true });
	const opened = await access.open(await lan.issueGrant(), {
		deviceId: "target",
		hubUrl: hubOrigin,
		origin: localOrigin,
		desktop: true,
		valid: () => true,
		renew: () => lan.issueGrant(),
		fallback: async () => ticket,
	});
	await page.goto(localOrigin + opened.url);
	const lanFrame = page.frameLocator("iframe");
	await lanFrame.getByRole("button", { name: "File transfer", exact: true }).click();
	await writeFile(join(localHome, "lan.zip"), block);
	const nativeDialog = page.locator("#file-transfer-dialog"),
		nativeLeft = nativeDialog.locator(".fm-pane").first(),
		nativeRight = nativeDialog.locator(".fm-pane").nth(1);
	await nativeLeft.getByRole("button", { name: "↻", exact: true }).click();
	await nativeLeft.getByRole("checkbox", { name: "lan.zip", exact: true }).check();
	await nativeLeft.getByRole("button", { name: "Send →", exact: true }).click();
	await nativeDialog.getByText("Completed · verified", { exact: true }).waitFor();
	assert.deepEqual(await readFile(join(home, "lan.zip")), block);
	await nativeRight.getByRole("checkbox", { name: "large-archive.zip", exact: true }).check();
	await nativeRight.getByRole("button", { name: "← Receive", exact: true }).click();
	await page.waitForFunction(
		() =>
			[...document.querySelectorAll(".fm-tasks tbody tr")].filter((r) => r.textContent.includes("Completed · verified"))
				.length === 2,
		{},
		{ timeout: 360000 },
	);
	assert.equal(await digest(join(localHome, "large-archive.zip")), expected);
	assert.deepEqual(failures, []);
	console.log(
		JSON.stringify({
			ok: true,
			bytes,
			sha256: expected,
			peakNodeRssMiB: Math.ceil(rss / 1024 ** 2),
			cases: ["Hub upload >1GiB", "Hub streamed download", "folder hierarchy", "LAN upload", "LAN streamed download"],
		}),
	);
} finally {
	clearInterval(memory);
	await browser?.close();
	files.close();
	localFiles.close();
	access?.close();
	lan?.close();
	connector?.close();
	relay.close();
	for (const ws of wss.clients) ws.terminate();
	wss.close();
	for (const server of servers) {
		server.closeAllConnections();
		server.close();
	}
	await rm(root, { recursive: true, force: true });
}
