import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { createDeviceDesktop } from "../server/device-center/desktop.ts";
const directory = await mkdtemp(join(tmpdir(), "desktop-displays-test-"));
const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 850 } }),
	errors = [],
	sessions = [];
const displays = [
	{ id: "left", width: 1280, height: 720, primary: true },
	{ id: "right", width: 600, height: 900, primary: false },
];
const frames = await page.evaluate(
	(displays) =>
		Object.fromEntries(
			displays.map((d) => {
				const c = document.createElement("canvas");
				c.width = d.width;
				c.height = d.height;
				const context = c.getContext("2d");
				context.fillStyle = d.primary ? "#205030" : "#302050";
				context.fillRect(0, 0, c.width, c.height);
				return [d.id, c.toDataURL("image/jpeg").split(",")[1]];
			}),
		),
	displays,
);
const app = express(),
	desktop = createDeviceDesktop({
		app,
		authorize: () => true,
		dataDir: directory,
		env: { PI_DEVICE_DESKTOP: "1" },
		native: {
			status: () => ({ supported: true, backend: "fixture" }),
			start(options) {
				const selected = options.display === "right" ? "right" : "left";
				const session = { selected, options, closed: false, inputs: [], profiles: [] };
				sessions.push(session);
				const timer = setInterval(() => {
					options.onDisplays?.({ type: "displays", displays, selected });
					options.onFrame(Buffer.from(frames[selected], "base64"));
				}, 40);
				return {
					input: (value) => session.inputs.push(value),
					configure: (value) => session.profiles.push(value),
					close() {
						session.closed = true;
						clearInterval(timer);
					},
				};
			},
		},
	});
const server = createServer(app);
server.on("upgrade", (req, socket, head) => desktop.handleUpgrade(req, socket, head));
try {
	await new Promise((resolve) => server.listen(8992, "127.0.0.1", resolve));
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto("http://127.0.0.1:8992/desktop");
	await page.waitForFunction(() => document.querySelector("#status").dataset.connected === "true");
	assert.equal(await page.locator("#display-source option").count(), 2);
	await page.selectOption("#display-source", "right");
	await page.waitForFunction(
		() => document.querySelector("canvas").width === 600 && document.querySelector("canvas").height === 900,
	);
	assert(sessions[0].closed);
	const second = sessions.find((s) => s.selected === "right" && !s.closed);
	assert(second);
	await page.locator("#canvas").click();
	await page.waitForTimeout(100);
	assert(
		second.inputs.some(
			(i) => i.type === "pointer" && i.action === "down" && Math.abs(i.x - 0.5) < 0.01 && Math.abs(i.y - 0.5) < 0.01,
		),
	);
	await page.locator("#quality-panel summary").click();
	await page.selectOption("#quality-mode", "balanced");
	for (const fps of ["60", "120", "240"]) {
		await page.selectOption("#quality-fps", fps);
		await wait(() => second.profiles.at(-1)?.fps === Number(fps));
	}
	await page.locator("#disconnect").click();
	await page.waitForTimeout(2600);
	const response = await page.request.get("http://127.0.0.1:8992/api/device-desktop/preview?display=right");
	assert(response.ok());
	assert.deepEqual(await response.body(), Buffer.from(frames.right, "base64"));
	assert(sessions.some((s) => s.options.preview && s.options.readOnly && s.selected === "right"));
	assert.deepEqual(errors, []);
	console.log(
		"Display browser passed: monitor switch, portrait geometry, old input cleanup, selected preview, 60/120/240 profiles.",
	);
} finally {
	desktop.close();
	await browser.close();
	await new Promise((resolve) => server.close(resolve));
	await rm(directory, { recursive: true, force: true });
}
async function wait(predicate) {
	const until = Date.now() + 5000;
	while (!predicate()) {
		if (Date.now() > until) throw new Error("Profile timeout");
		await new Promise((resolve) => setTimeout(resolve, 30));
	}
}
