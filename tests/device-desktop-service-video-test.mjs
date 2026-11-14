// Opt-in Windows integration: real installed service -> native capture/encoder -> browser.
// Read-only, isolated test server. This does not lock/unlock Windows or benchmark moving content.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import express from "express";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
const packageRoot = process.env.PI_DESKTOP_TEST_PACKAGE_ROOT;
const moduleUrl = (name) =>
	packageRoot
		? pathToFileURL(join(packageRoot, "dist/server/device-center", name + ".js")).href
		: new URL("../server/device-center/" + name + ".ts", import.meta.url).href;
const { createDeviceDesktop } = await import(moduleUrl("desktop"));
const { windowsDesktopServicePath, windowsDesktopServiceProfiles } = await import(moduleUrl("windows-desktop-service"));
const service = windowsDesktopServicePath();
assert.ok(
	service && windowsDesktopServiceProfiles(service, "video-v1"),
	"Install the built-in video-v1 Windows desktop service first",
);
const dataDir = await mkdtemp(join(tmpdir(), "pi-service-video-"));
const app = express();
const desktop = createDeviceDesktop({
	app,
	dataDir,
	env: { PI_DEVICE_DESKTOP: "1" },
	authorize: (req) => req.headers.authorization === "Bearer local-video-test",
});
const server = createServer(app);
server.on("upgrade", (req, socket, head) => {
	const url = new URL(req.url, "http://localhost");
	url.searchParams.set("viewOnly", "1");
	req.url = url.pathname + url.search;
	if (!desktop.handleUpgrade(req, socket, head)) socket.destroy();
});
let browser, page;
const errors = [],
	samples = [],
	declarations = [];
try {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const port = server.address().port;
	assert.ok(port >= 8900);
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true, args: ["--no-sandbox"] });
	page = await browser.newPage({ extraHTTPHeaders: { authorization: "Bearer local-video-test" } });
	await page.addInitScript(() => {
		const Decoder = globalThis.VideoDecoder;
		if (Decoder)
			globalThis.VideoDecoder = class extends Decoder {
				constructor(init) {
					super({
						...init,
						error: (error) => {
							console.error("video-decoder", error.name, error.message);
							init.error(error);
						},
					});
				}
			};
	});
	page.on("console", (message) => {
		if (message.type() === "error" && message.text().startsWith("video-decoder")) errors.push(message.text());
	});
	let connections = 0,
		frames = 0,
		video = false;
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("websocket", (socket) => {
		connections++;
		socket.on("framereceived", ({ payload }) => {
			if (typeof payload !== "string") {
				frames++;
				return;
			}
			const message = JSON.parse(payload);
			if (message.type === "error") errors.push(message.message ?? JSON.stringify(message));
			if (message.type === "video") {
				video = true;
				declarations.push(message);
			}
			if (message.type === "stats") samples.push({ ...message, at: performance.now() });
		});
	});
	await page.goto(`http://127.0.0.1:${port}/desktop`);
	await page.waitForFunction(
		() => {
			const c = document.querySelector("#canvas");
			return c.width > 2 && c.height > 2 && c.getContext("2d").getImageData(0, 0, 1, 1).data[3] > 0;
		},
		undefined,
		{ timeout: 30000 },
	);
	assert.ok(video);
	const checks = [];
	for (const [edge, fps] of [
		[960, 60],
		[1280, 120],
		[960, 240],
	]) {
		await page.evaluate(
			({ edge, fps }) => {
				document.getElementById("quality-mode").value = "balanced";
				document.getElementById("quality-edge").value = String(edge);
				const target = document.getElementById("quality-fps");
				target.value = String(fps);
				target.dispatchEvent(new Event("change"));
			},
			{ edge, fps },
		);
		await page.waitForFunction(
			(edge) => {
				const c = document.querySelector("#canvas");
				return Math.max(c.width, c.height) === edge && c.getContext("2d").getImageData(0, 0, 1, 1).data[3] > 0;
			},
			edge,
			{ timeout: 15000 },
		);
		const at = performance.now(),
			before = frames;
		await new Promise((resolve, reject) => {
			const timer = setInterval(() => {
				if (samples.filter((s) => s.at > at && s.profile?.fps === fps).length >= 2) {
					clearInterval(timer);
					clearTimeout(deadline);
					resolve();
				}
			}, 50);
			const deadline = setTimeout(() => {
				clearInterval(timer);
				reject(new Error("No continuing native video statistics"));
			}, 12000);
		});
		const [a, b] = samples.filter((s) => s.at > at && s.profile?.fps === fps).slice(-2);
		const actual = ((b.captured - a.captured) * 1000) / (b.at - a.at);
		assert.ok(
			actual >= 0 && actual <= fps * 1.3,
			`Unexpected ${actual} FPS for ${fps} target (check synthesized duplicates)`,
		);
		checks.push({ edge, targetFps: fps, deliveredFps: Math.round(actual * 10) / 10 });
	}
	assert.equal(connections, 1, "Profile changes must preserve the browser connection");
	assert.deepEqual(errors, []);
	console.log(
		JSON.stringify(
			{
				ok: true,
				checks,
				diagnostics: await page.locator("#statistics").textContent(),
				fallback: await page.locator("#statistics").getAttribute("title"),
				scope: "real current stationary Windows desktop; read-only; no lock/unlock or GPU/high-refresh acceptance",
			},
			null,
			2,
		),
	);
} catch (error) {
	console.error(
		JSON.stringify(
			{
				errors,
				declarations,
				samples: samples.slice(-4),
				viewer: await page?.evaluate(() => ({
					status: document.getElementById("status").textContent,
					stats: document.getElementById("statistics").textContent,
					width: document.querySelector("#canvas").width,
					height: document.querySelector("#canvas").height,
				})),
			},
			null,
			2,
		),
	);
	throw error;
} finally {
	await browser?.close();
	desktop.close();
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
	await rm(dataDir, { recursive: true, force: true });
}
