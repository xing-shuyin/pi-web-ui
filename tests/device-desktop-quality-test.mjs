import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { createDeviceDesktop } from "../server/device-center/desktop.ts";
const directory = await mkdtemp(join(tmpdir(), "desktop-quality-test-"));
const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const jpeg = Buffer.from(
	await page.evaluate(() => {
		const c = document.createElement("canvas");
		c.width = 640;
		c.height = 360;
		const x = c.getContext("2d");
		x.fillStyle = "#345";
		x.fillRect(0, 0, 640, 360);
		return c.toDataURL("image/jpeg").split(",")[1];
	}),
	"base64",
);
const profiles = [],
	inputs = [],
	sessions = [];
let supported = true;
const app = express();
const desktop = createDeviceDesktop({
	app,
	authorize: () => true,
	dataDir: directory,
	env: { PI_DEVICE_DESKTOP: "1" },
	native: {
		status: () => ({ supported: true, backend: "fixture" }),
		start(options) {
			const session = { closed: false, readOnly: options.readOnly };
			sessions.push(session);
			const timer = setInterval(() => options.onFrame(jpeg), 50);
			return {
				input: (e) => inputs.push(e),
				close() {
					session.closed = true;
					clearInterval(timer);
				},
				...(supported ? { configure: (p) => profiles.push(p) } : {}),
			};
		},
	},
});
const server = createServer(app);
server.on("upgrade", (req, socket, head) => desktop.handleUpgrade(req, socket, head));
await new Promise((resolve) => server.listen(8995, "127.0.0.1", resolve));
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
	await page.goto("http://127.0.0.1:8995/desktop?viewOnly=1");
	await page.waitForFunction(() => document.querySelector("#status").dataset.connected === "true");
	await page.locator("#viewonly").check();
	await page.waitForFunction(() => document.querySelector("#status").dataset.connected === "true");
	assert.equal(sessions.at(-1).readOnly, true);
	const connectionsBeforeQuality = sessions.length;
	const inputsBeforeQuality = inputs.length;
	await page.waitForFunction(() => !document.querySelector("#quality-mode").disabled);
	await page.locator("#quality-panel summary").click();
	await page.selectOption("#quality-mode", "sharp");
	await page.selectOption("#quality-edge", "1280");
	await page.selectOption("#quality-fps", "15");
	await page.waitForTimeout(700);
	assert.deepEqual(profiles.at(-1), { maxEdge: 1280, quality: 85, fps: 15 });
	assert.equal(sessions.length, connectionsBeforeQuality);
	assert.equal(inputs.length, inputsBeforeQuality);
	await page.selectOption("#quality-mode", "balanced");
	await page.selectOption("#quality-edge", "0");
	await page.setViewportSize({ width: 900, height: 650 });
	await page.waitForTimeout(700);
	assert.equal(profiles.at(-1).maxEdge, 900);
	assert.equal(sessions.length, connectionsBeforeQuality);
	await page.setViewportSize({ width: 390, height: 760 });
	await page.waitForTimeout(700);
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
	assert.equal(sessions.length, connectionsBeforeQuality);
	await page.locator("#disconnect").click();
	supported = false;
	await page.locator("#connect").click();
	await page.waitForFunction(() => document.querySelector("#status").dataset.connected === "true");
	assert.equal(await page.locator("#quality-mode").isDisabled(), true);
	const count = profiles.length;
	await page.waitForTimeout(500);
	assert.equal(profiles.length, count);
	assert.deepEqual(errors, []);
	console.log(
		JSON.stringify({
			passed: true,
			manual: profiles[0],
			profileChanges: profiles.length,
			resizeWithoutReconnect: true,
			readOnlyInputBlocked: true,
			oldBackendCompatible: true,
			mobileOverflow: false,
		}),
	);
} finally {
	await browser.close();
	desktop.close();
	await new Promise((r) => server.close(r));
	await rm(directory, { recursive: true, force: true });
}
