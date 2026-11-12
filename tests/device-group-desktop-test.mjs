import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { desktopPreviewPage } from "../server/device-center/desktop-preview-page.ts";
import { wrapperHtml, transformPortalHtml, portalHeaders } from "../server/device-center/path-portal.ts";

if (!CHROME_PATH) throw new Error("Chrome is required for group desktop verification");
const origin = "http://127.0.0.1:8996";
const server = await createServer({
	configFile: fileURLToPath(new URL("../web/vite.config.ts", import.meta.url)),
	cacheDir: fileURLToPath(new URL("../.safe-exec/group-desktop-vite", import.meta.url)),
	server: { host: "127.0.0.1", port: 8996, strictPort: true, open: false },
	plugins: [
		{
			name: "group-desktop-test",
			configureServer(vite) {
				vite.middlewares.use(async (req, res, next) => {
					if (req.url !== "/group-test") return next();
					res.setHeader("Content-Type", "text/html");
					res.end(
						await vite.transformIndexHtml(
							req.url,
							`<!doctype html><html><head><base href="/"></head><body><div id="root"></div><script type="module">
import React from 'react';
import {createRoot} from 'react-dom/client';
import {DesktopPreview} from '/src/components/desktop-preview.tsx';
import {RemoteDesktopWindow} from '/src/components/RemoteDesktopWindow.tsx';
import {setActiveGroupRoomData} from '/src/group-active-context.ts';
import {getDesktopAccess,openDeviceAccess} from '/src/device-access.ts';
import {applyTheme} from '/src/theme.ts';
import '/src/styles.css';
const bots=[{id:'writer',name:'Writer',deviceId:'pc'},{id:'reviewer',name:'Reviewer',deviceId:'pc'},{id:'mac-bot',name:'Mac Bot',deviceId:'mac'},{id:'offline-bot',name:'Offline Bot',deviceId:'offline'},{id:'local-bot',name:'Local Bot',deviceId:'local'},{id:'missing',name:'Missing device'}];
window.groupBots=bots;
window.showGroup=(roomId='team',members=bots)=>setActiveGroupRoomData({roomId,detail:{room:{id:roomId,name:'Project team',botIds:members.map(b=>b.id)},bots:members,messages:[],tasks:[]},devices:members,members,conversations:[],attentionCount:0,disabled:false,conversationError:''});
window.leaveGroup=()=>setActiveGroupRoomData(null);
window.desktopAccess=getDesktopAccess;
window.openMemberFromSidebar=()=>openDeviceAccess('pc',location.origin,true,false,false,'Reviewer');
window.setTestTheme=applyTheme;
function Fixture(){const [visible,setVisible]=React.useState(true);window.setVisible=setVisible;return React.createElement(React.Fragment,null,
React.createElement('main',{style:{padding:32}},React.createElement('h2',null,'Project team'),React.createElement('p',null,'Group conversation')),
React.createElement('aside',{className:'panel panel-right',style:{position:'fixed',right:0,top:0,width:'min(380px,100vw)',height:'100dvh',display:visible?'flex':'none'}},React.createElement(DesktopPreview,{visible}),React.createElement('div',{style:{padding:16}},'Files')),React.createElement(RemoteDesktopWindow));}
createRoot(document.getElementById('root')).render(React.createElement(Fixture));window.showGroup();
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
	const context = await browser.newContext({ locale: "en-US", viewport: { width: 1360, height: 900 } });
	const source = await context.newPage();
	await source.setContent(
		'<body style="background:#18332f;color:#daeee9;font:32px system-ui;padding:50px">Group desktop fixture<br><small>Live preview</small></body>',
	);
	const jpeg = await source.screenshot({ type: "jpeg", quality: 65 });
	await source.close();
	const page = await context.newPage();
	const errors = [],
		opens = [],
		snapshots = new Map();
	page.on("pageerror", (error) => errors.push(error.message));
	await context.route("**/themes/white.css?*", async (route) =>
		route.fulfill({ contentType: "text/css", body: await readFile("themes/white.css", "utf8") }),
	);
	await context.route("**/api/device-center/chat-status", (route) =>
		route.fulfill({ json: { hubUrl: origin, deviceId: "local" } }),
	);
	await context.route("**/api/device-center/devices", (route) =>
		route.fulfill({
			json: {
				devices: [
					{ id: "pc", name: "WORKSTATION", remark: "Studio", online: true },
					{ id: "mac", name: "Mac Mini", online: true },
					{ id: "offline", name: "Offline PC", online: false },
					{ id: "local", name: "Local PC", online: true },
					{ id: "outsider", name: "Not in group", online: true },
					...Array.from({ length: 8 }, (_, index) => ({
						id: `extra-${index}`,
						name: `Extra PC ${index}`,
						online: true,
					})),
				],
			},
		}),
	);
	await context.route("**/api/device-center/devices/*/open", (route) => {
		const id = new URL(route.request().url()).pathname.split("/").at(-2);
		opens.push(id);
		return route.fulfill({ json: { url: `${origin}/device/${id}/__open?ticket=${opens.length}` } });
	});
	await context.route("**/device/*/__open?*", (route) => {
		const url = new URL(route.request().url()),
			id = url.pathname.split("/")[2];
		const wrapper = wrapperHtml(`/group-fixture/${id}/`, url.searchParams.get("next").slice(1), new URL(origin), id);
		return route.fulfill({
			contentType: "text/html",
			headers: { "content-security-policy": wrapper.csp },
			body: wrapper.html,
		});
	});
	async function desktop(route, id, base) {
		const path = new URL(route.request().url()).pathname;
		// The local built-in page keeps its origin; only relayed pages receive an opaque portal CSP.
		const headers = id === "local" ? {} : portalHeaders(new URL(origin), base);
		if (path.endsWith("/api/device-desktop/preview")) {
			snapshots.set(id, (snapshots.get(id) || 0) + 1);
			return route.fulfill({ contentType: "image/jpeg", headers, body: jpeg });
		}
		const html = path.endsWith("/desktop-preview")
			? desktopPreviewPage()
			: `<body><h2>Desktop ${id}</h2><button>Operate ${id}</button></body>`;
		return route.fulfill({ contentType: "text/html", headers, body: transformPortalHtml(html, `${origin}${base}`) });
	}
	await context.route("**/group-fixture/**", (route) => {
		const id = new URL(route.request().url()).pathname.split("/")[2];
		return desktop(route, id, `/group-fixture/${id}/`);
	});
	await context.route(`${origin}/desktop*`, (route) => desktop(route, "local", "/"));
	await context.route(`${origin}/api/device-desktop/preview`, (route) => desktop(route, "local", "/"));
	await page.goto(`${origin}/group-test`);
	const group = page.getByRole("region", { name: "Group desktops" });
	await group
		.getByText(/Updated \d+s ago/)
		.first()
		.waitFor();
	assert.equal(await group.locator("article").count(), 4, "one card per device, not per Bot");
	assert.equal(
		await group.getByRole("button", { name: "View Missing device’s desktop", exact: true }).isDisabled(),
		true,
	);
	assert.equal(await group.getByText("Not in group", { exact: true }).count(), 0);
	assert.equal(opens.filter((id) => id === "pc").length, 1);
	assert(!opens.includes("local") && !opens.includes("offline"));
	assert.equal(await group.getByText("Studio · WORKSTATION", { exact: true }).count(), 1);
	await mkdir(".safe-exec/group-desktop-ui", { recursive: true });
	await group.locator("article").first().frameLocator("iframe").locator("#loading").waitFor({ state: "hidden" });
	await page.screenshot({ path: ".safe-exec/group-desktop-ui/overview-dark.png" });
	await page.evaluate(() => window.setTestTheme("white"));
	await page.waitForFunction(
		() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() === "#ffffff",
	);
	await page.waitForTimeout(300);
	await page.screenshot({ path: ".safe-exec/group-desktop-ui/overview-light.png" });
	await page.evaluate(() => window.setTestTheme(null));
	await page.evaluate(() => window.openMemberFromSidebar());
	await group.locator(".group-desktop-grid.is-single").waitFor();
	assert.equal(
		await group.getByRole("button", { name: "View Reviewer’s desktop", exact: true }).getAttribute("aria-pressed"),
		"true",
	);
	await group.getByRole("button", { name: "View Reviewer’s desktop", exact: true }).click();
	assert.equal(await group.locator("article").count(), 1);
	await group.getByRole("button", { name: "Open and control Reviewer’s desktop", exact: true }).click();
	const panel = page.locator(".remote-desktop-window");
	await panel.frameLocator("iframe").frameLocator("iframe").getByRole("button", { name: "Operate pc" }).click();
	assert.equal((await page.evaluate(() => window.desktopAccess())).id, "pc");
	await panel.getByRole("button", { name: "Back to preview", exact: true }).last().click();
	await group.getByText(/Updated \d+s ago/).waitFor();
	assert.equal(await panel.count(), 0);
	await group.getByRole("button", { name: "View Mac Bot’s desktop", exact: true }).click();
	await group.getByText(/Updated \d+s ago/).waitFor();
	await page.waitForTimeout(300);
	const previous = snapshots.get("pc");
	await page.waitForTimeout(3300);
	assert.equal(snapshots.get("pc"), previous, "unselected device stops polling");
	await group.getByRole("button", { name: "View Local Bot’s desktop", exact: true }).click();
	await group.getByText("Using current connection", { exact: true }).waitFor();
	await group.getByText(/Updated \d+s ago/).waitFor();
	assert(!opens.includes("local"), "local member never connects back through the Hub");
	await group.getByRole("button", { name: "All members", exact: true }).click();
	await group.locator("article").first().waitFor();
	await page.evaluate(() => window.setVisible(false));
	await page.waitForTimeout(300);
	const hidden = [...snapshots.values()].reduce((a, b) => a + b, 0);
	await page.waitForTimeout(3300);
	assert.equal(
		[...snapshots.values()].reduce((a, b) => a + b, 0),
		hidden,
		"hidden panel releases all previews",
	);
	await page.evaluate(() => window.setVisible(true));
	await page.setViewportSize({ width: 390, height: 844 });
	await group.getByRole("button", { name: "View Writer’s desktop", exact: true }).click();
	await group.getByText(/Updated \d+s ago/).waitFor();
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
	await group.frameLocator("iframe").locator("#loading").waitFor({ state: "hidden" });
	await page.screenshot({ path: ".safe-exec/group-desktop-ui/member-mobile.png" });
	await group.getByRole("button", { name: "Open and control Writer’s desktop", exact: true }).click();
	await panel.locator("iframe").waitFor();
	await page.evaluate(() =>
		window.showGroup(
			"team",
			window.groupBots.filter((bot) => bot.deviceId !== "pc"),
		),
	);
	await panel.waitFor({ state: "detached" });
	assert.equal(
		await page.evaluate(() => window.desktopAccess()),
		null,
		"removed member cannot retain a live group desktop",
	);
	await page.evaluate(() =>
		window.showGroup(
			"large",
			Array.from({ length: 8 }, (_, index) => ({
				id: `extra-bot-${index}`,
				name: `Member ${index}`,
				deviceId: `extra-${index}`,
			})),
		),
	);
	await group
		.getByText(/Updated \d+s ago/)
		.first()
		.waitFor();
	await page.waitForTimeout(350);
	assert(opens.filter((id) => id.startsWith("extra-")).length <= 6, "offscreen desktops must not all request tickets");
	assert(!opens.includes("extra-7"));
	await group.locator(".group-desktop-grid").evaluate((element) => (element.scrollTop = element.scrollHeight));
	await group
		.getByRole("article", { name: "Extra PC 7", exact: true })
		.getByText(/Updated \d+s ago/)
		.waitFor();
	assert(opens.includes("extra-7"), "scrolling into view resumes the selected visible cards");
	await page.evaluate(() => window.showGroup("another", [window.groupBots[2]]));
	await group.getByText(/Updated \d+s ago/).waitFor();
	assert.equal(await group.locator("article").count(), 1);
	assert.equal(
		await group.getByRole("button", { name: "All members", exact: true }).getAttribute("aria-pressed"),
		"true",
	);
	await page.evaluate(() => window.leaveGroup());
	await group.waitFor({ state: "detached" });
	assert.equal(await page.locator("iframe").count(), 0);
	assert.deepEqual(errors, []);
	console.log(
		"PASS grouped device previews, member selection, same-device sharing, local route, live return, pause, mobile, membership removal and navigation cleanup",
	);
} finally {
	await browser?.close();
	await server.close();
}
