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
let supported = true,
	refreshHz = 144;
const app = express();
const desktop = createDeviceDesktop({
	app,
	authorize: () => true,
	dataDir: directory,
	env: { PI_DEVICE_DESKTOP: "1" },
	native: {
		status: () => ({ supported: true, backend: "fixture" }),
		start(options) {
			const session = { closed: false, readOnly: options.readOnly, cursor: options.onCursor };
			sessions.push(session);
			const timer = setInterval(() => {
				options.onDisplays?.({
					type: "displays",
					selected: "one",
					displays: [{ id: "one", width: 3840, height: 2160, primary: true, refreshHz }],
					maxEdge: 4096,
					capture: "dxgi",
					encoderRuntime: "native-d3d11",
					colorRange: "limited",
				});
				options.onFrame(jpeg);
			}, 50);
			return {
				input: (e) => inputs.push(e),
				close() {
					session.closed = true;
					clearInterval(timer);
				},
				...(supported
					? {
							configure: (p) => profiles.push(p),
							setCursorMode(mode) {
								options.onCursor?.(
									mode === "remote"
										? { type: "cursor", kind: "position", x: 0.75, y: 0.25 }
										: { type: "cursor", kind: "local" },
								);
							},
						}
					: {}),
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
	assert.equal(await page.locator("#quality-fps").inputValue(), "0");
	await page.waitForFunction(() => document.querySelector("#statistics").textContent.includes("144 Hz"));
	assert.equal(profiles.at(-1).fps, 144);
	refreshHz = 165;
	await page.waitForFunction(() => document.querySelector("#statistics").textContent.includes("165 Hz"));
	assert.equal(profiles.at(-1).fps, 165);
	await page.selectOption("#quality-fps", "240");
	refreshHz = 60;
	await page.waitForFunction(() => document.querySelector("#statistics").textContent.includes("60 Hz"));
	assert.equal(profiles.at(-1).fps, 240);
	await page.selectOption("#quality-mode", "sharp");
	await page.selectOption("#quality-resolution", "1280x720");
	await page.selectOption("#quality-fps", "15");
	await page.waitForTimeout(700);
	assert.deepEqual(profiles.at(-1), { maxEdge: 1280, quality: 85, fps: 15, colorRange: "limited" });
	assert.equal(sessions.length, connectionsBeforeQuality);
	assert.equal(inputs.length, inputsBeforeQuality);
	await page.selectOption("#quality-mode", "balanced");
	await page.selectOption("#quality-resolution", "window");
	await page.setViewportSize({ width: 900, height: 650 });
	await page.waitForTimeout(700);
	assert.equal(profiles.at(-1).maxEdge, 900);
	assert.equal(sessions.length, connectionsBeforeQuality);
	await page.setViewportSize({ width: 390, height: 760 });
	await page.waitForTimeout(700);
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
	assert.equal(sessions.length, connectionsBeforeQuality);
	await page.setViewportSize({ width: 1280, height: 800 });
	if (!(await page.locator("#quality-form").isVisible())) await page.locator("#quality-panel summary").click();
	await page.selectOption("#quality-resolution", "custom");
	await page.fill("#quality-width", "2560");
	await page.fill("#quality-height", "1440");
	await page.locator("#quality-height").press("Tab");
	await page.waitForTimeout(800);
	assert.equal(profiles.at(-1).maxEdge, 2560);
	assert.equal(sessions.length, connectionsBeforeQuality);
	await page.selectOption("#quality-resolution", "native");
	await page.waitForTimeout(800);
	assert.equal(profiles.at(-1).maxEdge, 3840);
	await page.selectOption("#quality-color", "full");
	await page.waitForTimeout(800);
	assert.equal(profiles.at(-1).colorRange, "full");
	assert.equal(await page.locator("#statistics").isVisible(), true);
	await page.locator("#canvas").click();
	assert.equal(await page.locator("#statistics").isVisible(), true);
	await page.keyboard.press("Escape");
	assert.equal(await page.locator("#statistics").isVisible(), true);
	await page.locator("#diagnostics").click();
	assert.equal(await page.locator("#statistics").isVisible(), false);
	await page.reload();
	await page.waitForFunction(() => document.querySelector("#status").dataset.connected === "true");
	assert.equal(await page.locator("#statistics").isVisible(), false);
	assert.equal(await page.locator("#quality-resolution").inputValue(), "native");
	assert.equal(await page.locator("#quality-color").inputValue(), "full");
	assert.equal(await page.locator("#quality-fps").inputValue(), "15");
	await page.locator("#diagnostics").click();
	assert.equal(await page.locator("#statistics").isVisible(), true);
	await page.screenshot({ path: ".safe-exec/display-options.png" });
	const total = sessions.length;
	await page.locator("#settings summary").click();
	assert.equal(await page.locator("#cursor-mode").inputValue(), "local");
	await page.selectOption("#cursor-mode", "remote");
	await page.locator("#cursor-plane").waitFor({ state: "visible" });
	await page.keyboard.press("Escape");
	const plane = await page.locator("#cursor-plane").boundingBox();
	const marker = await page.locator("#remote-cursor").boundingBox();
	assert.ok(Math.abs(marker.x - (plane.x + plane.width * 0.75)) < 2);
	assert.ok(Math.abs(marker.y - (plane.y + plane.height * 0.25)) < 2);
	await page.mouse.move(plane.x + plane.width * 0.2, plane.y + plane.height * 0.7);
	assert.equal(await page.locator("#canvas").evaluate((e) => getComputedStyle(e).cursor), "none");
	assert.deepEqual(await page.locator("#remote-cursor").boundingBox(), marker);
	const sprite = await page.evaluate(() => {
		const c = document.createElement("canvas");
		c.width = 24;
		c.height = 30;
		return c.toDataURL().split(",")[1];
	});
	sessions.at(-1).cursor({
		type: "cursor",
		kind: "position",
		x: 0.75,
		y: 0.25,
		shape: { png: sprite, width: 24, height: 30, hotX: 5, hotY: 3 },
	});
	await page.waitForFunction(() => document.getElementById("cursor-image").naturalWidth === 24);
	assert.equal(await page.locator("#cursor-arrow").isHidden(), true);
	await page.mouse.move(plane.x + 10, plane.y - 2);
	assert.notEqual(await page.locator("#canvas").evaluate((e) => getComputedStyle(e).cursor), "none");
	sessions.at(-1).cursor({ type: "cursor", kind: "hidden" });
	await page.locator("#cursor-plane").waitFor({ state: "hidden" });
	sessions.at(-1).cursor({ type: "cursor", kind: "position", x: 0.1, y: 0.8 });
	await page.locator("#cursor-plane").waitFor({ state: "visible" });
	await page.locator("#settings summary").click();
	await page.selectOption("#cursor-mode", "local");
	await page.locator("#cursor-plane").waitFor({ state: "hidden" });
	await page.selectOption("#cursor-mode", "remote");
	await page.locator("#cursor-plane").waitFor({ state: "visible" });
	assert.equal(sessions.length, total);
	await page.reload();
	await page.locator("#cursor-plane").waitFor({ state: "visible" });
	assert.equal(await page.locator("#cursor-mode").inputValue(), "remote");
	sessions.at(-1).cursor({ type: "cursor", kind: "embedded" });
	await page.locator("#cursor-plane").waitFor({ state: "hidden" });
	await page.mouse.move(plane.x + 80, plane.y + 50);
	assert.equal(await page.locator("#canvas").evaluate((e) => getComputedStyle(e).cursor), "none");
	const retina = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 2 });
	await retina.goto("http://127.0.0.1:8995/desktop");
	await retina.waitForFunction(() => document.querySelector("#status").dataset.connected === "true");
	await retina.locator("#scale").uncheck();
	await retina.waitForFunction(
		() => document.querySelector("canvas").getBoundingClientRect().width * devicePixelRatio === 640,
	);
	const bounds = await retina.locator("canvas").boundingBox();
	await retina.mouse.click(bounds.x + bounds.width * 0.75, bounds.y + bounds.height * 0.25);
	await retina.waitForTimeout(400);
	assert.equal(profiles.at(-1).maxEdge, 3840);
	assert.ok(
		inputs.some(
			(e) => e.type === "pointer" && e.action === "down" && Math.abs(e.x - 0.75) < 0.01 && Math.abs(e.y - 0.25) < 0.01,
		),
	);
	await retina.close();
	await page.locator("#disconnect").click();
	supported = false;
	await page.locator("#connect").click();
	await page.waitForFunction(() => document.querySelector("#status").dataset.connected === "true");
	assert.equal(await page.locator("#quality-mode").isDisabled(), true);
	assert.equal(await page.locator("#cursor-mode").isDisabled(), true);
	assert.equal(await page.locator("#cursor-plane").isHidden(), true);
	assert.notEqual(await page.locator("#canvas").evaluate((e) => getComputedStyle(e).cursor), "none");
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
			cursorSwitchWithoutReconnect: true,
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
