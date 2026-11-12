import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { build } from "esbuild";
import { WebSocketServer } from "ws";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { wrapperHtml, portalHeaders, transformPortalHtml } from "../server/device-center/path-portal.ts";
import { desktopPreviewPage } from "../server/device-center/desktop-preview-page.ts";
import { desktopPage } from "../server/device-center/desktop-page.ts";

const origin = "http://127.0.0.1:8996";
const compiled = await build({
	stdin: {
		contents: `import React from 'react';import{createRoot}from'react-dom/client';
import{DesktopPreview}from'./web/src/components/desktop-preview';import{RemoteDesktopWindow}from'./web/src/components/RemoteDesktopWindow';
import{openPageDesktop}from'./web/src/device-access';import{applyTheme}from'./web/src/theme';
function App(){React.useEffect(()=>{void openPageDesktop(false,'Studio Mac')},[]);return React.createElement(React.Fragment,null,React.createElement('h2',null,'Remote conversation'),React.createElement('aside',{style:{width:'min(360px,100vw)',marginLeft:'auto'}},React.createElement(DesktopPreview,{visible:true})),React.createElement(RemoteDesktopWindow))}window.setTestTheme=applyTheme;createRoot(document.getElementById('root')).render(React.createElement(App));`,
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
let base,
	jpeg,
	opens = 0,
	frames = 0,
	connections = 0;
const input = [];
const server = createServer(async (req, res) => {
	try {
		const path = new URL(req.url, origin).pathname;
		if (path === "/remote") {
			const wrapper = wrapperHtml(base);
			res.writeHead(200, { "content-type": "text/html", "content-security-policy": wrapper.csp });
			return res.end(wrapper.html);
		}
		if (!path.startsWith(base)) {
			res.writeHead(404);
			return res.end();
		}
		const tail = path.slice(base.length);
		const headers = portalHeaders(new URL(origin), base);
		const html = (body) => {
			res.writeHead(200, { ...headers, "content-type": "text/html" });
			res.end(transformPortalHtml(body, base));
		};
		if (!tail)
			return html(
				`<html><head><style>${css}</style></head><body><div id="root"></div><script>${compiled.outputFiles[0].text}</script></body></html>`,
			);
		if (tail === "desktop-preview") return html(desktopPreviewPage());
		if (tail === "desktop") return html(desktopPage());
		if (tail === "api/device-desktop/preview") {
			frames++;
			res.writeHead(200, { ...headers, "content-type": "image/jpeg" });
			return res.end(jpeg);
		}
		if (tail.startsWith("themes/")) {
			assert.match(tail, /^themes\/[a-z-]+\.css$/);
			res.writeHead(200, { ...headers, "content-type": "text/css" });
			return res.end(await readFile(tail));
		}
		res.writeHead(200, { ...headers, "content-type": "application/json" });
		if (tail === "api/device-center/chat-status")
			return res.end(JSON.stringify({ deviceId: "studio-mac", hubUrl: origin }));
		if (tail === "api/device-center/devices")
			return res.end(JSON.stringify({ devices: [{ id: "studio-mac", name: "Studio Mac", online: true }] }));
		if (tail.endsWith("/open")) opens++;
		res.end(
			JSON.stringify({ enabled: true, supported: true, available: true, environmentEnabled: false, os: "win32" }),
		);
	} catch (error) {
		res.writeHead(500);
		res.end(String(error));
	}
});
const wss = new WebSocketServer({ server });
wss.on("connection", (socket) => {
	connections++;
	socket.send(JSON.stringify({ type: "ready" }));
	const timer = setInterval(() => {
		if (socket.readyState === 1) socket.send(jpeg);
	}, 150);
	socket.on("message", (data) => input.push(JSON.parse(data.toString())));
	socket.on("close", () => clearInterval(timer));
});
let browser;
try {
	await new Promise((resolve) => server.listen(8996, "127.0.0.1", resolve));
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	const source = await browser.newPage();
	await source.setContent(
		'<body style="background:#263d48;color:white;font:24px system-ui;padding:100px">Remote computer · desktop fixture</body>',
	);
	jpeg = await source.screenshot({ type: "jpeg" });
	await source.close();
	await mkdir("artifacts/device-center", { recursive: true });
	for (const prefix of ["/device", "/pi/device-lan"]) {
		base = `${prefix}/studio-mac/__relay/${"a".repeat(64)}/`;
		const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
		const errors = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await page.goto(`${origin}/remote`);
		const app = page.frameLocator("iframe");
		await app.getByText(/Updated \d+s ago/).waitFor();
		const before = frames;
		await page.waitForTimeout(3300);
		assert(frames > before);
		await app.getByRole("button", { name: "Expand and control" }).click();
		const live = app.frameLocator(".remote-desktop-window iframe");
		await live.getByText("Connected · control enabled", { exact: true }).waitFor();
		const connectionCount = connections;
		for (const theme of ["one-dark", "white", "nord"]) {
			const appFrame = page.frames().find((frame) => frame.url() === origin + base);
			await appFrame.evaluate((theme) => window.setTestTheme(theme), theme);
			await appFrame.waitForFunction(() => document.getElementById("theme-stylesheet")?.sheet);
			const expected = await appFrame.evaluate(() =>
				getComputedStyle(document.documentElement).getPropertyValue("--bg-elev").trim(),
			);
			const desktopFrame = page.frames().find((frame) => frame.url() === origin + base + "desktop");
			await desktopFrame.waitForFunction(
				(expected) => document.documentElement.style.getPropertyValue("--bg-elev").trim() === expected,
				expected,
			);
			assert.equal(connections, connectionCount, "theme changes retain desktop socket");
			await page.screenshot({
				path: `artifacts/device-center/current-desktop-${prefix.includes("lan") ? "lan" : "hub"}-${theme}.png`,
			});
		}
		await live.locator("#text-panel summary").click();
		await live.locator("#text").fill("远程输入验证");
		await live.locator("#send-text").click();
		await page.waitForTimeout(100);
		assert(input.some((item) => item.type === "text" && item.text === "远程输入验证"));
		await page.setViewportSize({ width: 390, height: 844 });
		await live.locator("#diagnostics summary").click();
		await live.locator("#text-form").waitFor({ state: "hidden" });
		assert.equal(await live.locator("#text-panel").getAttribute("open"), null);
		const bounds = await live.locator("#statistics").boundingBox();
		assert(bounds.width <= 390);
		await page.screenshot({
			path: `artifacts/device-center/current-desktop-mobile-${prefix.includes("lan") ? "lan" : "hub"}.png`,
		});
		await app.getByRole("button", { name: "Back to preview", exact: true }).last().click();
		await app.getByText(/Updated \d+s ago/).waitFor();
		await app.getByRole("button", { name: "Close desktop", exact: true }).click();
		await app.getByRole("button", { name: "Show this device’s desktop" }).click();
		await app.getByText(/Updated \d+s ago/).waitFor();
		assert.equal(opens, 0, "current desktop never requests another connection");
		assert.deepEqual(errors, []);
		await page.close();
	}
	console.log(JSON.stringify({ passed: true, opens, frames, connections, themes: ["one-dark", "white", "nord"] }));
} finally {
	await browser?.close();
	for (const socket of wss.clients) socket.terminate();
	await new Promise((resolve) => wss.close(resolve));
	await new Promise((resolve) => server.close(resolve));
}
