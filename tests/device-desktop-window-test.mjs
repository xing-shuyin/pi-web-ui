import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";

if (!CHROME_PATH) {
	console.log("SKIP remote desktop window: Chrome unavailable");
	process.exit(0);
}
const server = await createServer({
	configFile: fileURLToPath(new URL("../web/vite.config.ts", import.meta.url)),
	server: { host: "127.0.0.1", port: 8997, strictPort: true, open: false },
	plugins: [
		{
			name: "desktop-window-test",
			configureServer(vite) {
				vite.middlewares.use(async (req, res, next) => {
					if (req.url !== "/floating-test") return next();
					res.setHeader("Content-Type", "text/html");
					res.end(
						await vite.transformIndexHtml(
							req.url,
							`<!doctype html><html><body><div id="root"></div><script type="module">
import React from 'react';
import {createRoot} from 'react-dom/client';
import {RemoteDesktopWindow} from '/src/components/RemoteDesktopWindow.tsx';
import {openDeviceAccess} from '/src/device-access.ts';
import '/src/styles.css';
createRoot(document.getElementById('root')).render(React.createElement(RemoteDesktopWindow));
window.showDesktop = () => openDeviceAccess('studio-mac', location.origin, true, false);
</script></body></html>`,
						),
					);
				});
			},
		},
	],
});
let browser;
try {
	await server.listen();
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
	await page.route("**/api/device-center/devices/*/open", (route) =>
		route.fulfill({ json: { url: "http://127.0.0.1:8997/__device/open?ticket=mock" } }),
	);
	await page.route("**/__device/open?*", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: '<body style="margin:0;background:#18332f;color:#daeee9;font:24px system-ui;display:grid;place-content:center;height:100vh"><div style="border:1px solid #577;padding:60px;border-radius:18px">Studio Mac<br><small>Remote desktop preview · mock transport</small></div></body>',
		}),
	);
	await page.goto("http://127.0.0.1:8997/floating-test");
	await page.waitForFunction(() => !!window.showDesktop);
	await page.evaluate(() => window.showDesktop());
	const panel = page.getByRole("dialog");
	await panel.waitFor();
	assert.equal(await panel.locator("iframe").getAttribute("sandbox"), "allow-scripts allow-forms allow-pointer-lock");
	const initial = await panel.boundingBox();
	await page.mouse.move(initial.x + 100, initial.y + 20);
	await page.mouse.down();
	await page.mouse.move(initial.x + 220, initial.y + 130);
	await page.mouse.up();
	const moved = await panel.boundingBox();
	assert(moved.x > initial.x && moved.y > initial.y, "title bar drags window");
	await page.mouse.move(moved.x + moved.width - 6, moved.y + moved.height - 6);
	await page.mouse.down();
	await page.mouse.move(moved.x + moved.width - 100, moved.y + moved.height - 80);
	await page.mouse.up();
	const resized = await panel.boundingBox();
	assert(resized.width < moved.width && resized.height < moved.height, "corner resizes window");
	await page.mouse.click(1300, 850);
	assert.equal(await panel.count(), 1);
	await page.getByRole("button", { name: "Minimize", exact: true }).click();
	assert.equal(await panel.locator("iframe").isVisible(), false);
	await page.getByRole("button", { name: "Restore", exact: true }).click();
	await page.getByRole("button", { name: "Fullscreen", exact: true }).click();
	assert.equal((await panel.boundingBox()).width, 1360);
	await page.getByRole("button", { name: "Exit fullscreen", exact: true }).click();
	assert.equal((await panel.boundingBox()).width, resized.width);
	await mkdir(new URL("../artifacts/device-center/", import.meta.url), { recursive: true });
	await page.screenshot({
		path: fileURLToPath(new URL("../artifacts/device-center/remote-desktop-floating.png", import.meta.url)),
	});
	const popupPromise = page.waitForEvent("popup");
	await page.getByRole("button", { name: "Separate tab", exact: true }).click();
	const popup = await popupPromise;
	await popup.waitForURL("**/__device/open?*");
	assert.equal(await panel.count(), 0);
	assert.equal(await popup.evaluate(() => window.opener), null);
	console.log("PASS remote desktop window drag, resize, persistence, minimize, fullscreen, detach, sandbox");
} finally {
	await browser?.close();
	await server.close();
}
