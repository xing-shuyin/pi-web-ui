import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
// @ts-expect-error jsdom is installed without declaration files in this project.
import { JSDOM } from "jsdom";
import { desktopPage } from "../../server/device-center/desktop-page.js";
import { chromium } from "playwright-core";
import { BROWSER_LAUNCH_TIMEOUT_MS, BROWSER_TEST_TIMEOUT_MS, CHROME_PATH } from "../lib/chrome.mjs";
import http, { type Server } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { createDeviceRelay } from "../../server/device-center/relay.js";
import { createDeviceConnector } from "../../server/device-center/connector.js";
import { createDeviceDesktop } from "../../server/device-center/desktop.js";

type Native = NonNullable<Parameters<typeof createDeviceDesktop>[0]["native"]>;
type CaptureOptions = Parameters<Native["start"]>[0];
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function listen(server: Server) {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	cleanups.push(() => {
		server.closeAllConnections();
		server.close();
	});
	return (server.address() as { port: number }).port;
}
async function request(port: number, host: string, path: string, headers: Record<string, string> = {}, method = "GET") {
	return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port, path, method, headers: { host, ...headers } }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk) => chunks.push(chunk));
			res.on("end", () =>
				resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }),
			);
		});
		req.on("error", reject);
		req.end();
	});
}
async function fixture() {
	const dataDir = mkdtempSync(join(tmpdir(), "desktop-relay-"));
	cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
	const sessions: { options: CaptureOptions; input: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }[] = [];
	const authorized = vi.fn((req: http.IncomingMessage) => req.headers.authorization === "Bearer local-secret");
	const app = express();
	const desktop = createDeviceDesktop({
		app,
		dataDir,
		env: { PI_DEVICE_DESKTOP: "1" },
		authorize: authorized,
		native: {
			status: () => ({ supported: true, backend: "fake-relay" }),
			start: (options) => {
				const session = { options, input: vi.fn(), close: vi.fn() };
				sessions.push(session);
				return session;
			},
		},
	});
	const local = http.createServer(app);
	local.on("upgrade", (req, socket, head) => {
		if (!desktop.handleUpgrade(req, socket, head)) socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
	});
	const localPort = await listen(local);
	cleanups.push(() => desktop.close());
	let relay: ReturnType<typeof createDeviceRelay>;
	const hub = http.createServer((req, res) => {
		if (relay.handleRequest(req, res)) return;
		if (req.url === "/api/devices/dev1/open") return void relay.handleOpen(req, res, "dev1");
		res.writeHead(404).end();
	});
	const port = await listen(hub);
	const publicUrl = `http://127.0.0.1:${port}`;
	relay = createDeviceRelay({
		server: hub,
		publicUrl,
		deviceDomain: `devices.localhost:${port}`,
		authenticateDevice: (id, key) => id === "dev1" && key === "credential",
		getAccount: () => ({ id: "account" }),
		ownsDevice: (account, id) => account === "account" && id === "dev1",
	});
	cleanups.push(() => relay.close());
	const connector = createDeviceConnector({
		hubUrl: publicUrl,
		deviceId: "dev1",
		credential: "credential",
		localOrigin: `http://127.0.0.1:${localPort}`,
		localAuthToken: "local-secret",
	});
	cleanups.push(() => connector.close());
	await vi.waitFor(() => expect(relay.isOnline("dev1")).toBe(true));
	const ticket = await request(port, `127.0.0.1:${port}`, "/api/devices/dev1/open", { origin: publicUrl }, "POST");
	expect(ticket.status).toBe(200);
	const ticketUrl = new URL(JSON.parse(ticket.body).url);
	const host = `dev1.devices.localhost:${port}`;
	const origin = `http://${host}`;
	const opened = await request(port, host, ticketUrl.pathname + ticketUrl.search);
	expect(opened.status).toBe(302);
	const cookie = opened.headers["set-cookie"]![0].split(";")[0];
	function client(viewOnly: 0 | 1) {
		const ws = new WebSocket(`ws://127.0.0.1:${port}/desktop-ws?viewOnly=${viewOnly}`, {
			headers: { host, cookie, origin, authorization: "Bearer browser-credential" },
		});
		const messages: { binary: boolean; data: Buffer }[] = [];
		ws.on("message", (data, binary) => messages.push({ binary, data: Buffer.from(data as Buffer) }));
		ws.on("error", () => {});
		cleanups.push(() => ws.terminate());
		return { ws, messages };
	}
	return { port, host, origin, cookie, localPort, sessions, authorized, client };
}
const jpeg = Buffer.alloc(8192, 0xab);
jpeg.writeUInt16BE(0xffd8, 0);
jpeg.writeUInt16BE(0xffd9, jpeg.length - 2);

describe("desktop page macOS permission guidance", () => {
	async function page(os: string, language: string, enabled = true) {
		const dom = new JSDOM(desktopPage(), { url: "http://localhost/desktop", runScripts: "outside-only" });
		cleanups.push(() => dom.window.close());
		const { window } = dom;
		Object.defineProperty(window.navigator, "language", { value: language });
		window.HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ clearRect: vi.fn() })) as any;
		Object.assign(window, { createImageBitmap: vi.fn() });
		const sockets: any[] = [];
		class Socket {
			static OPEN = 1;
			readyState = 1;
			onmessage: ((event: { data: string }) => void) | null = null;
			close = vi.fn();
			constructor(public url: string) {
				sockets.push(this);
			}
		}
		const fetch = vi.fn(async (_url: unknown, options?: { body?: string }) => {
			if (options?.body) enabled = JSON.parse(options.body).enabled;
			return {
				ok: true,
				json: async () => ({
					enabled,
					available: true,
					environmentEnabled: false,
					supported: true,
					os,
				}),
			};
		});
		Object.assign(window, { fetch, WebSocket: Socket });
		const script = window.document.querySelector('script[type="module"]')!.textContent!;
		window.eval(script);
		const connect = window.document.getElementById("connect") as HTMLButtonElement;
		await vi.waitFor(() => expect((window.document.getElementById("check") as HTMLButtonElement).disabled).toBe(false));
		expect(sockets).toHaveLength(enabled ? 1 : 0);
		if (enabled) expect(String(sockets[0].url)).toContain("viewOnly=0");
		expect(connect.disabled).toBe(true);
		expect((window.document.getElementById("viewonly") as HTMLInputElement).checked).toBe(false);
		expect((window.document.getElementById("settings") as HTMLDetailsElement).open).toBe(!enabled);
		expect((window.document.getElementById("text-panel") as HTMLDetailsElement).open).toBe(false);
		return { window, sockets, connect, fetch, guide: window.document.getElementById("mac-permission-guide")! };
	}

	it.each(["zh-CN", "en"])("shows actionable Mac guidance and translates permission errors in %s", async (language) => {
		const p = await page("darwin", language);
		expect(p.guide.hidden).toBe(false);
		const guide = p.guide.textContent!;
		for (const host of ["pi-web-ui", "+"]) expect(guide).toContain(host);
		for (const text of language === "zh-CN"
			? [
					"被控 Mac",
					"设备中心",
					"授予屏幕录制权限",
					"辅助功能",
					"仅查看",
					"远端连接不会触发授权",
					"可能不重复弹窗",
					"重启服务",
				]
			: [
					"controlled Mac",
					"Device Center",
					"Grant screen recording permission",
					"Accessibility",
					"Viewing",
					"Remote connections never request permission",
					"may suppress repeat prompts",
					"restart the service",
				])
			expect(guide).toContain(text);
		expect(p.window.document.getElementById("setup-status")!.textContent).toContain(
			language === "zh-CN" ? "未验证系统权限" : "permissions not verified",
		);
		for (const [prefix, expected] of [
			[
				"MAC_SCREEN_PERMISSION_REQUIRED",
				language === "zh-CN" ? "缺少屏幕录制权限" : "Screen recording permission is required",
			],
			[
				"MAC_ACCESSIBILITY_PERMISSION_REQUIRED",
				language === "zh-CN" ? "缺少辅助功能权限" : "Accessibility permission is required",
			],
			["Unrelated backend error", "Unrelated backend error"],
		]) {
			if (!p.connect.disabled) p.connect.click();
			const socket = p.sockets.at(-1)!;
			socket.onmessage({
				data: JSON.stringify({
					type: "error",
					message: prefix.startsWith("MAC_") ? prefix + " Permission denied on Mac" : prefix,
				}),
			});
			expect(p.window.document.getElementById("status")!.textContent).toContain(expected);
			expect(socket.close).toHaveBeenCalledOnce();
			expect(p.guide.hidden).toBe(false);
			expect(p.guide.textContent).toBe(guide);
			expect(p.connect.disabled).toBe(false);
		}
		expect(p.sockets).toHaveLength(3);
		expect(p.fetch).toHaveBeenCalledOnce();
	});

	it("waits for explicit enable and does not reconnect after a manual disconnect and status refresh", async () => {
		const p = await page("linux", "en", false);
		(p.window.document.getElementById("enable") as HTMLButtonElement).click();
		await vi.waitFor(() => expect(p.sockets).toHaveLength(1));
		expect(String(p.sockets[0].url)).toContain("viewOnly=0");
		(p.window.document.getElementById("disconnect") as HTMLButtonElement).click();
		expect(p.sockets[0].close).toHaveBeenCalledOnce();
		(p.window.document.getElementById("check") as HTMLButtonElement).click();
		await vi.waitFor(() => expect(p.fetch).toHaveBeenCalledTimes(4));
		expect(p.sockets).toHaveLength(1);
	});

	it.each(["win32", "linux"])("hides Mac guidance on %s", async (os) => {
		const p = await page(os, "en");
		expect(p.guide.hidden).toBe(true);
	});
});

describe("native desktop through device relay and connector", () => {
	it("serves preview JPEGs through the authenticated Hub and connector without enabling input", async () => {
		const f = await fixture();
		const response = request(f.port, f.host, "/api/device-desktop/preview", { cookie: f.cookie });
		await vi.waitFor(() => expect(f.sessions).toHaveLength(1));
		expect(f.sessions[0].options).toMatchObject({ readOnly: true, preview: true });
		f.sessions[0].options.onFrame(jpeg);
		const result = await response;
		expect(result.status).toBe(200);
		expect(result.headers["content-type"]).toContain("image/jpeg");
		expect(f.sessions[0].input).not.toHaveBeenCalled();
	});
	it.skipIf(!CHROME_PATH)(
		"keeps native control connected when browser pointer movement has button=-1",
		async () => {
			const f = await fixture();
			const browser = await chromium.launch({
				executablePath: CHROME_PATH,
				headless: true,
				timeout: BROWSER_LAUNCH_TIMEOUT_MS,
				args: ["--no-sandbox"],
			});
			cleanups.push(() => browser.close());
			const page = await browser.newPage({ extraHTTPHeaders: { authorization: "Bearer local-secret" } });
			await page.goto(`http://127.0.0.1:${f.localPort}/desktop`);
			expect(await page.locator("#text").getAttribute("maxlength")).toBe("2048");
			expect(await page.locator("#viewonly").isChecked()).toBe(false);
			expect(await page.locator("#settings").getAttribute("open")).toBeNull();
			await vi.waitFor(() => expect(f.sessions).toHaveLength(1));
			const session = f.sessions[0];
			expect(session.options.readOnly).toBe(false);
			const image = await page.evaluate(() => {
				const canvas = document.createElement("canvas");
				canvas.width = canvas.height = 32;
				const context = canvas.getContext("2d")!;
				context.fillStyle = "red";
				context.fillRect(0, 0, 32, 32);
				return canvas.toDataURL("image/jpeg").split(",")[1];
			});
			session.options.onFrame(Buffer.from(image, "base64"));
			await page.waitForFunction(() => document.querySelector<HTMLCanvasElement>("#canvas")?.width === 32);
			const box = await page.locator("#canvas").boundingBox();
			expect(box).not.toBeNull();
			await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
			await vi.waitFor(() =>
				expect(session.input).toHaveBeenCalledWith(expect.objectContaining({ type: "pointer", action: "move" })),
			);
			expect(session.input.mock.calls.find(([event]) => event.type === "pointer")![0]).not.toHaveProperty("button", -1);
			expect(session.close).not.toHaveBeenCalled();
			for (const viewport of [
				{ width: 1166, height: 700 },
				{ width: 390, height: 740 },
			]) {
				await page.setViewportSize(viewport);
				const toolbar = await page.locator("#toolbar").boundingBox();
				const screen = await page.locator("#screen").boundingBox();
				expect(toolbar!.height).toBeLessThanOrEqual(48);
				expect(screen!.height).toBeGreaterThanOrEqual(viewport.height - 48);
			}
			await page.locator("#viewonly").check();
			await vi.waitFor(() => expect(f.sessions).toHaveLength(2));
			expect(f.sessions[1].options.readOnly).toBe(true);
			await vi.waitFor(() => expect(session.close).toHaveBeenCalledTimes(1));
			await page.locator("#disconnect").click();
			await vi.waitFor(() => expect(f.sessions[1].close).toHaveBeenCalledTimes(1));
			await vi.waitFor(() => expect(session.close).toHaveBeenCalledTimes(1));
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
	it("rewrites local authorization and transports binary frames and read-only ACKs through the full tunnel", async () => {
		const f = await fixture();
		const status = await request(f.port, f.host, "/api/device-desktop/status", { cookie: f.cookie });
		expect(status.status).toBe(200);
		expect(JSON.parse(status.body)).toMatchObject({
			available: true,
			backend: "fake-relay",
			readOnlyEnforcement: "server",
		});
		const { ws, messages } = f.client(1);
		await once(ws, "open");
		await vi.waitFor(() => expect(f.sessions).toHaveLength(1));
		const session = f.sessions[0];
		expect(session.options.readOnly).toBe(true);
		const localRequest = f.authorized.mock.calls.at(-1)![0];
		expect(localRequest.headers).toMatchObject({
			host: `127.0.0.1:${f.localPort}`,
			origin: `http://127.0.0.1:${f.localPort}`,
			authorization: "Bearer local-secret",
		});
		ws.send(JSON.stringify({ type: "text", text: "must never reach desktop" }));
		ws.send(JSON.stringify({ type: "release" }));
		session.options.onFrame(jpeg);
		await vi.waitFor(() => expect(messages.filter((message) => message.binary)).toHaveLength(1));
		expect(messages.find((message) => message.binary)!.data).toEqual(jpeg);
		expect(
			messages.filter((message) => !message.binary).map((message) => JSON.parse(message.data.toString())),
		).toContainEqual({ type: "ready" });
		session.options.onFrame(Buffer.from("must drop until ACK"));
		ws.send(JSON.stringify({ type: "ack" }));
		await vi.waitFor(() => {
			session.options.onFrame(jpeg);
			expect(messages.filter((message) => message.binary)).toHaveLength(2);
		});
		expect(messages.filter((message) => message.binary).map((message) => message.data)).toEqual([jpeg, jpeg]);
		expect(session.input).not.toHaveBeenCalled();
		const closed = once(ws, "close");
		ws.close();
		await closed;
		await vi.waitFor(() => expect(session.close).toHaveBeenCalledTimes(1));
	});
	it("preserves explicit control permission, forwards inputs and cleans capture when the remote socket closes", async () => {
		const f = await fixture();
		const { ws, messages } = f.client(0);
		await once(ws, "open");
		await vi.waitFor(() => expect(f.sessions).toHaveLength(1));
		const session = f.sessions[0];
		expect(session.options.readOnly).toBe(false);
		const inputs = [
			{ type: "pointer", x: 0.25, y: 0.75, button: 0, action: "down" },
			{ type: "wheel", deltaY: 120 },
			{ type: "key", code: "KeyA", action: "up" },
			{ type: "text", text: "remote 世界" },
			{ type: "release" },
		];
		for (const input of inputs) ws.send(JSON.stringify(input));
		await vi.waitFor(() => expect(session.input.mock.calls.map(([event]) => event)).toEqual(inputs));
		session.options.onFrame(jpeg);
		await vi.waitFor(() => expect(messages.some((message) => message.binary && message.data.equals(jpeg))).toBe(true));
		ws.send(JSON.stringify({ type: "ack" }));
		const closed = once(ws, "close");
		ws.close();
		await closed;
		await vi.waitFor(() => expect(session.close).toHaveBeenCalledTimes(1));
		expect(session.input.mock.calls.map(([event]) => event)).toEqual(inputs);
	});
});
