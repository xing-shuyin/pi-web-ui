// Opt-in local acceptance: protected Windows service -> WS -> real WebCodecs.
// Shows its own non-activating animation for 20 seconds. No user input or recording.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import express from "express";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
const packageRoot = process.env.PI_DESKTOP_TEST_PACKAGE_ROOT;
const minimumFps = Number(process.env.PI_DESKTOP_TEST_MIN_FPS || 10);
const requestedEdge = Number(process.env.PI_DESKTOP_TEST_EDGE || 1280);
assert.ok(Number.isFinite(minimumFps) && minimumFps > 0 && minimumFps <= 240);
assert.ok([960, 1280, 1920, 2560].includes(requestedEdge));
const { createDeviceDesktop } = await import(
	packageRoot
		? pathToFileURL(join(packageRoot, "dist/server/device-center/desktop.js")).href
		: new URL("../server/device-center/desktop.ts", import.meta.url).href
);
const dir = await mkdtemp(join(tmpdir(), "pi-rustdesk-stream-")),
	app = express();
const desktop = createDeviceDesktop({
	app,
	dataDir: dir,
	env: { PI_DEVICE_DESKTOP: "1" },
	authorize: (req) => req.headers.authorization === "Bearer local-rustdesk-test",
});
const server = createServer(app);
server.on("upgrade", (req, socket, head) => {
	const url = new URL(req.url, "http://localhost");
	url.searchParams.set("viewOnly", "1");
	req.url = url.pathname + url.search;
	if (!desktop.handleUpgrade(req, socket, head)) socket.destroy();
});
let browser,
	page,
	motion,
	paints = "";
const stats = [],
	errors = [],
	backends = [];
let connections = 0;
try {
	const exe = join(dir, "motion.exe"),
		compiler = spawn(
			join(process.env.SystemRoot, "Microsoft.NET/Framework64/v4.0.30319/csc.exe"),
			[
				"/nologo",
				"/target:exe",
				"/out:" + exe,
				"/r:System.Drawing.dll",
				"/r:System.Windows.Forms.dll",
				resolve("tests/fixtures/desktop-motion.cs"),
			],
			{ windowsHide: true, stdio: "pipe" },
		);
	let compilerError = "";
	compiler.stdout.on("data", (b) => (compilerError += b));
	compiler.stderr.on("data", (b) => (compilerError += b));
	const [code] = await once(compiler, "exit");
	assert.equal(code, 0, compilerError);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const port = server.address().port;
	assert.ok(port >= 8900);
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true, args: ["--no-sandbox"] });
	page = await browser.newPage({ extraHTTPHeaders: { authorization: "Bearer local-rustdesk-test" } });
	page.on("pageerror", (e) => errors.push(e.message));
	page.on("websocket", (ws) => {
		connections++;
		ws.on("framereceived", ({ payload }) => {
			if (typeof payload !== "string") return;
			const m = JSON.parse(payload);
			if (m.type === "stats") stats.push(m);
			if (m.type === "error") errors.push(m.message);
			if (m.type === "displays" && m.encoder) {
				const backend = { capture: m.capture, runtime: m.encoderRuntime, fallback: m.fallback };
				if (JSON.stringify(backend) !== JSON.stringify(backends.at(-1))) backends.push(backend);
			}
		});
	});
	await page.goto(`http://127.0.0.1:${port}/desktop?viewOnly=1`);
	await page.waitForFunction(() => document.querySelector("#canvas").width > 2, undefined, { timeout: 20000 });
	assert.ok(
		backends.some((b) => b.runtime === "native-d3d11"),
		"Actual native RustDesk codec required; a fallback is not acceptance",
	);
	await page.evaluate((edge) => {
		document.getElementById("quality-mode").value = "balanced";
		document.getElementById("quality-edge").value = String(edge);
		const fps = document.getElementById("quality-fps");
		fps.value = "120";
		fps.dispatchEvent(new Event("change"));
	}, requestedEdge);
	await page.waitForFunction(
		(edge) => Math.max(document.querySelector("#canvas").width, document.querySelector("#canvas").height) === edge,
		requestedEdge,
		{ timeout: 15000 },
	);
	motion = spawn(exe, [], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
	motion.stdout.on("data", (b) => (paints += b));
	motion.stderr.on("data", (b) => errors.push(String(b)));
	await page.waitForTimeout(5000);
	const initial = stats.at(-1);
	assert.ok(initial?.ackMeasured);
	await page.waitForTimeout(7000);
	const final = stats.at(-1);
	const fps = ((final.captured - initial.captured) * 1000) / (final.elapsedMs - initial.elapsedMs);
	assert.ok(
		fps >= minimumFps,
		`Dynamic capture ${fps} FPS is below the requested ${minimumFps} FPS acceptance threshold`,
	);
	assert.ok(final.videoInFlight < 64 && final.queued < 4 * 1024 * 1024);
	// Same-resolution bitrate/FPS change must preserve the browser connection.
	await page.evaluate(() => {
		const target = document.getElementById("quality-fps");
		target.value = "60";
		target.dispatchEvent(new Event("change"));
	});
	await page.waitForTimeout(4000);
	assert.equal(connections, 1);
	assert.equal(stats.at(-1).profile.fps, 60);
	const diagnostics = await page.locator("#statistics").textContent();
	// No frames are required on an unchanged desktop. Heartbeats must survive the old 15s stall cutoff.
	if (motion.exitCode === null) await once(motion, "exit");
	await page.waitForTimeout(17000);
	assert.deepEqual(errors, []);
	assert.equal(connections, 1);
	assert.ok(
		backends.every((b) => b.runtime === "native-d3d11"),
		"Native codec fell back during the test",
	);
	console.log(
		JSON.stringify({
			ok: true,
			measuredUpdateFps: +fps.toFixed(1),
			requestedEdge,
			backends,
			ackMs: final.ackMs,
			queued: final.queued,
			inFlight: final.videoInFlight,
			paints: paints.trim(),
			diagnostics,
			scope:
				"generated moving desktop window -> installed native D3D11 hardware codec -> localhost browser; not Internet or high-refresh acceptance",
		}),
	);
} catch (error) {
	console.error(
		JSON.stringify({
			errors,
			backends,
			samples: stats.slice(-3),
			diagnostics: await page?.locator("#statistics").textContent(),
			fallback: await page?.locator("#statistics").getAttribute("title"),
		}),
	);
	throw error;
} finally {
	if (motion?.exitCode === null) {
		motion.kill();
		await once(motion, "exit");
	}
	await browser?.close();
	desktop.close();
	server.closeAllConnections();
	await new Promise((r) => server.close(r));
	await rm(dir, { recursive: true, force: true });
}
