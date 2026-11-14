import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, open, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import express from "express";
import { WebSocketServer } from "ws";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { createDesktopFiles } from "../server/device-center/desktop-files.ts";
import { desktopPage } from "../server/device-center/desktop-page.ts";
import { desktopFilesPortalScript } from "../server/device-center/desktop-files-bridge.ts";
import { createDeviceRelay } from "../server/device-center/relay.ts";
import { createDeviceConnector } from "../server/device-center/connector.ts";
const root = await mkdtemp(join(tmpdir(), "pi-dual-files-")),
	localHome = join(root, "local"),
	remoteHome = join(root, "remote");
await mkdir(join(localHome, "outgoing", "project", "empty"), { recursive: true });
await mkdir(join(localHome, "receive"));
await mkdir(join(remoteHome, "selected-destination"), { recursive: true });
await writeFile(join(localHome, "outgoing", "project", "settings.ini"), "[dual]\nvalid=yes\n");
const block = randomBytes(1024 ** 2),
	count = process.env.PI_FILE_TEST_LARGE ? 1025 : process.env.PI_FILE_TEST_UI ? 8 : 70,
	archive = join(localHome, "outgoing", "archive.zip");
const f = await open(archive, "wx");
try {
	for (let i = 0; i < count; i++) await f.write(block);
} finally {
	await f.close();
}
const digest = async (path) => {
	const h = createHash("sha256");
	for await (const c of createReadStream(path)) h.update(c);
	return h.digest("hex");
};
const expected = await digest(archive),
	remoteOrigin = "http://127.0.0.1:8981",
	hubOrigin = "http://127.0.0.1:8982",
	localOrigin = "http://127.0.0.1:8983";
const remoteApp = express(),
	localApp = express();
let delay = 8;
remoteApp.use((req, _res, next) => {
	if (req.path.endsWith("/chunk") && req.method === "PUT") setTimeout(next, delay);
	else next();
});
const remoteFiles = createDesktopFiles({ app: remoteApp, home: remoteHome, allowed: () => true, enabled: () => true });
const localFiles = createDesktopFiles({
	app: localApp,
	base: "/api/device-desktop/local/files",
	home: localHome,
	allowed: (req) =>
		req.headers["x-pi-local-files"] === "1" && (!req.headers.origin || req.headers.origin === localOrigin),
	enabled: () => true,
});
remoteApp.get("/desktop", (_req, res) => res.type("html").send(desktopPage()));
remoteApp.get("/api/device-desktop/status", (_req, res) =>
	res.json({ enabled: true, available: true, supported: true, environmentEnabled: false, os: "win32" }),
);
let ticket, relay, connector, browser;
localApp.get("/", (_req, res) =>
	res
		.type("html")
		.send(
			`<html><head><style>:root{--bg:#f5f7fa;--bg-elev:#fff;--text:#202938;--text-muted:#596579;--border:#d5dbe4;--accent:#2469ba}body{margin:0}iframe{width:100vw;height:100vh;border:0}</style></head><body><iframe sandbox="allow-scripts allow-forms allow-downloads" src="${ticket}&next=%2Fdesktop"></iframe><script>const frame=document.querySelector('iframe');${desktopFilesPortalScript(localOrigin + "/api/device-desktop/local/clipboard-ws")}</script></body></html>`,
		),
);
const target = createServer(remoteApp),
	hub = createServer((req, res) => {
		if (req.url === "/open") void relay.handleOpen(req, res, "remote");
		else if (!relay.handleRequest(req, res)) res.writeHead(404).end();
	}),
	controller = createServer(localApp),
	servers = [target, hub, controller],
	wss = new WebSocketServer({ noServer: true });
target.on("upgrade", (req, socket, head) =>
	wss.handleUpgrade(req, socket, head, (ws) => ws.send(JSON.stringify({ type: "ready" }))),
);
relay = createDeviceRelay({
	server: hub,
	publicUrl: hubOrigin,
	pathAccess: true,
	authenticateDevice: (id, key) => id === "remote" && key === "key",
	getAccount: () => "owner",
	ownsDevice: (_owner, id) => id === "remote",
});
let rss = 0;
const memory = setInterval(() => {
	rss = Math.max(rss, process.memoryUsage().rss);
}, 100);
try {
	for (const [i, s] of servers.entries()) await new Promise((r) => s.listen(8981 + i, "127.0.0.1", r));
	connector = createDeviceConnector({
		hubUrl: hubOrigin,
		deviceId: "remote",
		credential: "key",
		localOrigin: remoteOrigin,
		localAuthToken: "token",
		onTask: async () => "",
	});
	const begin = Date.now();
	while (!relay.isOnline("remote")) {
		assert.ok(Date.now() - begin < 10000);
		await new Promise((r) => setTimeout(r, 20));
	}
	ticket = (await (await fetch(hubOrigin + "/open", { method: "POST", headers: { origin: hubOrigin } })).json()).url;
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	const page = await browser.newPage({ viewport: { width: 1280, height: 850 }, locale: "zh-CN" }),
		errors = [];
	page.on("pageerror", (e) => errors.push(e.message));
	page.on("console", (m) => {
		if (m.type() === "error") console.log("browser:", m.text().slice(0, 200));
	});
	await page.goto(localOrigin);
	const desktop = page.frameLocator("iframe").frameLocator("iframe");
	await desktop.getByRole("button", { name: "文件传输", exact: true }).click();
	const dialog = page.locator("#file-transfer-dialog"),
		left = dialog.locator(".fm-pane").nth(0),
		right = dialog.locator(".fm-pane").nth(1);
	await left.locator(".fm-path").waitFor();
	await page.waitForFunction(() => document.querySelectorAll(".fm-pane .fm-grid tbody tr").length > 2);
	async function navigate(pane, path) {
		await pane.locator(".fm-path").fill(path);
		await pane.locator(".fm-path").press("Enter");
		await page.waitForFunction(({ index, path }) => document.querySelectorAll(".fm-path")[index].value === path, {
			index: pane === left ? 0 : 1,
			path,
		});
		await pane.getByRole("button", { name: "↻", exact: true }).click();
		await page.waitForTimeout(150);
	}
	async function select(pane, name) {
		await pane.getByRole("checkbox", { name, exact: true }).check();
	}
	const destination = join(remoteHome, "selected-destination");
	await navigate(left, join(localHome, "outgoing"));
	await navigate(right, destination);
	await select(left, "archive.zip");
	const started = Date.now();
	await left.getByRole("button", { name: "发送 →", exact: true }).click();
	await dialog.locator(".fm-tasks progress").waitFor();
	await page.waitForFunction(() => document.querySelector(".fm-tasks progress").value > 0);
	await dialog.locator(".fm-task-actions").getByRole("button", { name: "暂停", exact: true }).click();
	await dialog.getByText("已暂停", { exact: true }).waitFor();
	assert.equal((await readdir(destination)).filter((n) => !n.startsWith(".incoming-")).length, 0);
	await dialog.locator(".fm-task-actions").getByRole("button", { name: "继续", exact: true }).click();
	await dialog.getByText("已完成 · 文件已校验", { exact: true }).waitFor({ timeout: 300000 });
	assert.equal(await digest(join(destination, "archive.zip")), expected);
	console.log(
		JSON.stringify({
			phase: "native -> nested Hub selected destination, pause/resume",
			bytes: count * block.length,
			seconds: (Date.now() - started) / 1000,
			sha256: expected,
		}),
	);
	delay = 0;
	await select(left, "project");
	await left.getByRole("button", { name: "发送 →", exact: true }).click();
	await page.waitForFunction(
		() =>
			[...document.querySelectorAll(".fm-tasks tbody tr")].filter((r) => r.textContent.includes("已完成 · 文件已校验"))
				.length === 2,
	);
	assert.equal(await readFile(join(destination, "project", "settings.ini"), "utf8"), "[dual]\nvalid=yes\n");
	assert.deepEqual(await readdir(join(destination, "project", "empty")), []);
	await navigate(left, join(localHome, "receive"));
	await select(right, "archive.zip");
	await right.getByRole("button", { name: "← 接收", exact: true }).click();
	await page.waitForFunction(
		() =>
			[...document.querySelectorAll(".fm-tasks tbody tr")].filter((r) => r.textContent.includes("已完成 · 文件已校验"))
				.length === 3,
		{},
		{ timeout: 300000 },
	);
	assert.equal(await digest(join(localHome, "receive", "archive.zip")), expected);
	await right.getByRole("button", { name: "← 接收", exact: true }).click();
	await page.waitForFunction(
		() =>
			[...document.querySelectorAll(".fm-tasks tbody tr")].filter((r) => r.textContent.includes("已完成 · 文件已校验"))
				.length === 4,
		{},
		{ timeout: 300000 },
	);
	assert.equal(await digest(join(localHome, "receive", "archive (2).zip")), expected);
	await mkdir("artifacts/device-center", { recursive: true });
	await dialog.screenshot({ path: "artifacts/device-center/dual-files-light.png" });
	await page.evaluate(() => {
		for (const [name, value] of Object.entries({
			"--bg": "#0b1116",
			"--bg-elev": "#131d25",
			"--text": "#e6edf3",
			"--text-muted": "#a8b8c6",
			"--border": "#314453",
			"--accent": "#20c4b1",
		}))
			document.documentElement.style.setProperty(name, value);
	});
	await dialog.screenshot({ path: "artifacts/device-center/dual-files-dark.png" });
	assert.ok(
		await dialog.evaluate((e) => getComputedStyle(e.querySelector("tbody td")).color === getComputedStyle(e).color),
		"Dark table cells must inherit the dialog text color",
	);
	await page.setViewportSize({ width: 560, height: 820 });
	assert.ok(await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth + 1));
	await dialog.screenshot({ path: "artifacts/device-center/dual-files-narrow.png" });
	assert.equal((await fetch(localOrigin + "/api/device-desktop/local/files/info")).status, 403);
	// Real browser FileSystem handles in OPFS stand in for the user-selected directory;
	// the OS permission dialog itself is intentionally outside this automated test.
	await writeFile(join(remoteHome, "browser-receive.zip"), block);
	await page.addInitScript(() => {
		window.showDirectoryPicker = () => navigator.storage.getDirectory();
	});
	await page.setViewportSize({ width: 1280, height: 850 });
	ticket = (await (await fetch(hubOrigin + "/open", { method: "POST", headers: { origin: hubOrigin } })).json()).url;
	await page.goto(ticket + "&next=%2Fdesktop");
	await page.frameLocator("iframe").getByRole("button", { name: "文件传输", exact: true }).click();
	const browserDialog = page.locator("#file-transfer-dialog"),
		browserLeft = browserDialog.locator(".fm-pane").first(),
		browserRight = browserDialog.locator(".fm-pane").nth(1);
	await browserLeft.getByRole("button", { name: "选择本机目录", exact: true }).click();
	await browserRight.getByRole("checkbox", { name: "browser-receive.zip", exact: true }).check();
	await browserRight.getByRole("button", { name: "← 接收", exact: true }).click();
	await browserDialog.getByText("已完成 · 文件已校验", { exact: true }).waitFor();
	const savedHash = await page.evaluate(async () => {
		const root = await navigator.storage.getDirectory(),
			file = await (await root.getFileHandle("browser-receive.zip")).getFile();
		return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())), (v) =>
			v.toString(16).padStart(2, "0"),
		).join("");
	});
	assert.equal(savedHash, createHash("sha256").update(block).digest("hex"));
	assert.deepEqual(errors, []);
	console.log(
		JSON.stringify({
			ok: true,
			cases: [
				"native -> nested Hub",
				"nested Hub -> native",
				"chosen folders",
				"empty directories",
				"pause/resume",
				"collision keeps both",
				"private endpoint denies missing header",
				"light/dark/narrow",
				"browser FileSystem handle receiver",
			],
			peakNodeRssMiB: Math.ceil(rss / 1024 ** 2),
		}),
	);
} finally {
	clearInterval(memory);
	await browser?.close();
	localFiles.close();
	remoteFiles.close();
	connector?.close();
	relay?.close();
	for (const ws of wss.clients) ws.terminate();
	wss.close();
	for (const s of servers) {
		s.closeAllConnections();
		s.close();
	}
	await rm(root, { recursive: true, force: true });
}
