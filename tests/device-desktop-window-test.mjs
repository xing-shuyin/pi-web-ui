import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { desktopPreviewPage } from "../server/device-center/desktop-preview-page.ts";
import { wrapperHtml, transformPortalHtml, portalHeaders } from "../server/device-center/path-portal.ts";

if (!CHROME_PATH) throw new Error("Chrome is required for the desktop preview browser test");
const origin = "http://127.0.0.1:8997";
const server = await createServer({
	configFile: fileURLToPath(new URL("../web/vite.config.ts", import.meta.url)),
	server: { host: "127.0.0.1", port: 8997, strictPort: true, open: false },
	plugins: [
		{
			name: "desktop-preview-test",
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
import {DesktopPreview} from '/src/components/desktop-preview.tsx';
import {openDeviceAccess} from '/src/device-access.ts';
import '/src/styles.css';
function Fixture(){const [visible,setVisible]=React.useState(true);window.setPreviewVisible=setVisible;return React.createElement(React.Fragment,null,
React.createElement('main',{style:{padding:32}},React.createElement('h2',null,'Conversation'),React.createElement('p',null,'Chat and files remain available beside the remote desktop.')),
React.createElement('aside',{className:'panel panel-right',style:{position:'fixed',right:0,top:0,width:'min(360px,100vw)',height:'100dvh',display:visible?'flex':'none'}},React.createElement(DesktopPreview,{visible}),React.createElement('div',{style:{padding:16}},'Files',React.createElement('p',null,'src/'),React.createElement('p',null,'package.json'))),React.createElement(RemoteDesktopWindow));}
createRoot(document.getElementById('root')).render(React.createElement(Fixture));
window.showDesktop=()=>openDeviceAccess('studio-mac',location.origin,true,false,false,'Studio Mac');
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
	const source = await browser.newPage({ viewport: { width: 960, height: 600 } });
	await source.setContent(
		'<body style="margin:0;background:#18332f;color:#daeee9;font:24px system-ui;display:grid;place-content:center;height:100vh"><div style="border:1px solid #577;padding:60px;border-radius:18px">Studio Mac<br><small>Desktop preview test fixture</small></div></body>',
	);
	const jpeg = await source.screenshot({ type: "jpeg", quality: 65 });
	await source.close();
	const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	let opens = 0,
		snapshots = 0,
		liveLoads = 0;
	await page.route("**/api/device-center/devices", (route) =>
		route.fulfill({
			json: {
				devices: [
					{ id: "studio-mac", name: "Studio Mac", online: true },
					{
						id: "office-win",
						name: "Office Windows with a very long device name that still fits the menu",
						online: true,
					},
					{ id: "offline", name: "Offline computer", online: false },
				],
			},
		}),
	);
	await page.route("**/api/device-center/devices/*/open", (route) =>
		route.fulfill({
			json: {
				url: `${origin}/device/${new URL(route.request().url()).pathname.split("/").at(-2)}/__open?ticket=${++opens}`,
			},
		}),
	);
	await page.route("**/device/*/__open?*", (route) => {
		const initial = new URL(route.request().url()).searchParams.get("next").slice(1);
		const wrapper = wrapperHtml("/fixture/", initial, new URL(origin), "Studio Mac");
		return route.fulfill({
			contentType: "text/html",
			headers: { "content-security-policy": wrapper.csp },
			body: wrapper.html,
		});
	});
	await page.route("**/fixture/**", (route) => {
		const path = new URL(route.request().url()).pathname;
		const headers = portalHeaders(new URL(origin), "/fixture/");
		if (path.endsWith("/api/device-desktop/preview")) {
			snapshots++;
			return route.fulfill({ contentType: "image/jpeg", headers, body: jpeg });
		}
		if (path.endsWith("/desktop-preview"))
			return route.fulfill({
				contentType: "text/html",
				headers,
				body: transformPortalHtml(desktopPreviewPage(), `${origin}/fixture/`),
			});
		if (path.endsWith("/desktop")) {
			liveLoads++;
			return route.fulfill({
				contentType: "text/html",
				headers,
				body: transformPortalHtml(
					'<body style="background:#18332f;color:#eee;font:24px system-ui"><h2>Interactive desktop fixture</h2><button id="control">Click to operate</button><p id="result"></p><script>document.getElementById("control").onclick=()=>document.getElementById("result").textContent="Input received"</script></body>',
					`${origin}/fixture/`,
				),
			});
		}
		return route.fulfill({ status: 404, headers });
	});
	await page.goto(origin + "/floating-test");
	await page.waitForFunction(() => !!window.showDesktop);
	await page.evaluate(() => window.showDesktop());
	const preview = page.locator(".desktop-preview");
	await preview.getByText(/Updated \d+s ago/).waitFor();
	assert.equal(await page.getByRole("dialog").count(), 0);
	assert.equal(snapshots, 1);
	await page.waitForTimeout(3400);
	assert(snapshots >= 2, "preview refreshes repeatedly");
	await preview.getByRole("button", { name: "Collapse preview" }).click();
	const paused = snapshots;
	await page.waitForTimeout(3400);
	assert.equal(snapshots, paused, "collapsed preview stops fetching");
	await preview.getByRole("button", { name: "Expand preview" }).click();
	await page.waitForTimeout(300);
	assert(snapshots > paused);
	await mkdir(new URL("../artifacts/device-center/", import.meta.url), { recursive: true });
	const screenshot = (name) =>
		page.screenshot({ path: fileURLToPath(new URL(`../artifacts/device-center/${name}.png`, import.meta.url)) });
	await screenshot("desktop-sidebar-preview");
	const beforePicker = page.url();
	await preview.getByRole("button", { name: "Choose device" }).click();
	const picker = page.getByRole("dialog", { name: "Choose device", exact: true });
	const deviceOption = picker.getByRole("button", { name: /Office Windows/ });
	await deviceOption.waitFor();
	assert(await picker.getByRole("button", { name: /Offline computer/ }).isDisabled());
	assert((await picker.boundingBox()).x + (await picker.boundingBox()).width <= 1360);
	await screenshot("desktop-device-picker");
	await deviceOption.click();
	await preview.getByText(/Updated \d+s ago/).waitFor();
	assert.equal(await picker.count(), 0);
	assert.equal(page.url(), beforePicker);
	assert((await preview.locator("iframe").getAttribute("src")).includes("/device/office-win/"));
	await page.getByRole("button", { name: "Expand and control" }).click();
	const panel = page.getByRole("dialog");
	await panel.locator("iframe").waitFor();
	const live = panel.frameLocator("iframe").frameLocator("iframe");
	await live.getByRole("button", { name: "Click to operate" }).click();
	await live.getByText("Input received").waitFor();
	const frame = await panel.locator("iframe").elementHandle();
	const initial = await panel.boundingBox();
	const titlebar = await panel.locator(".remote-desktop-titlebar strong").boundingBox();
	await page.mouse.move(titlebar.x + 20, titlebar.y + titlebar.height / 2);
	await page.mouse.down();
	await page.mouse.move(titlebar.x + 120, titlebar.y + titlebar.height / 2 + 60, { steps: 5 });
	await page.mouse.up();
	await page.waitForFunction(
		({ x, y }) => {
			const rect = document.querySelector(".remote-desktop-window").getBoundingClientRect();
			return rect.x > x && rect.y > y;
		},
		initial,
		{ timeout: 3000 },
	);
	const moved = await panel.boundingBox();
	assert(moved.x > initial.x && moved.y > initial.y);
	const resizeHandle = await panel.locator(".remote-desktop-resize").boundingBox();
	await page.mouse.move(resizeHandle.x + 8, resizeHandle.y + 8);
	await page.mouse.down();
	await page.mouse.move(resizeHandle.x - 90, resizeHandle.y - 70, { steps: 5 });
	await page.mouse.up();
	await page.waitForFunction(
		(width) => document.querySelector(".remote-desktop-window").getBoundingClientRect().width < width,
		moved.width,
		{ timeout: 3000 },
	);
	const resized = await panel.boundingBox();
	assert(resized.width < moved.width);
	await panel.getByRole("button", { name: "Fullscreen", exact: true }).click();
	assert.equal((await panel.boundingBox()).width, 1360);
	await panel.getByRole("button", { name: "Exit fullscreen", exact: true }).click();
	assert(await panel.locator("iframe").evaluate((element, original) => element === original, frame));
	assert.equal(liveLoads, 1, "fullscreen preserves the live connection");
	const duringLive = snapshots;
	await page.waitForTimeout(3400);
	assert.equal(snapshots, duringLive, "live desktop does not keep a second preview running");
	await screenshot("remote-desktop-floating");
	await panel.getByRole("button", { name: "Back to preview", exact: true }).first().click();
	await preview.getByText(/Updated \d+s ago/).waitFor();
	assert.equal(await panel.count(), 0);
	await page.evaluate(() => window.setPreviewVisible(false));
	const hidden = snapshots;
	await page.waitForTimeout(3400);
	assert.equal(snapshots, hidden, "hidden sidebar pauses capture requests");
	await page.evaluate(() => window.setPreviewVisible(true));
	await page.setViewportSize({ width: 390, height: 844 });
	await screenshot("desktop-sidebar-mobile");
	await preview.getByRole("button", { name: "Choose device" }).click();
	await picker.getByRole("button", { name: /Studio Mac/ }).waitFor();
	assert((await picker.boundingBox()).x + (await picker.boundingBox()).width <= 390);
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
	await screenshot("desktop-device-picker-mobile");
	await picker.getByRole("button", { name: /Studio Mac/ }).click();
	await preview.getByRole("button", { name: "Expand and control" }).click();
	await panel.locator("iframe").waitFor();
	assert.equal((await panel.boundingBox()).width, 390);
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
	await panel.getByRole("button", { name: "Back to preview" }).last().click();
	await preview.getByText(/Updated \d+s ago/).waitFor();
	assert.equal(await panel.count(), 0);
	assert.equal(await preview.count(), 1);
	await preview.getByRole("button", { name: "Close desktop" }).click();
	assert.equal(await preview.count(), 0);
	assert.equal(await page.locator("iframe").count(), 0);
	assert.deepEqual(errors, []);
	console.log(
		`PASS sidebar preview refresh/pause, nested sandbox, control, drag/resize, stable fullscreen, return, mobile and cleanup (${opens} tickets)`,
	);
} finally {
	await browser?.close();
	await server.close();
}
