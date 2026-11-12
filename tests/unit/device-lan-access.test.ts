import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { Socket, AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { chromium } from "playwright-core";
import { BROWSER_TEST_TIMEOUT_MS } from "../lib/chrome.mjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeviceLanServer } from "../../server/device-center/device-lan.js";
import { createDeviceLanAccess } from "../../server/device-center/device-lan-access.js";

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function listen(server: Server) {
	const sockets = new Set<Socket>();
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	cleanups.push(async () => {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function fixture(basePath = "/", desktop = false, browserScript = "") {
	const received: { path: string; auth?: string; cookie?: string; origin?: string; body: string }[] = [];
	const target = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			received.push({
				path: req.url!,
				auth: req.headers.authorization,
				cookie: req.headers.cookie,
				origin: req.headers.origin,
				body: Buffer.concat(chunks).toString(),
			});
			res.setHeader("Set-Cookie", "target-private=secret");
			if (req.url === "/api/health") res.end('{"ok":true}');
			else if (req.url === "/" || req.url === "/desktop")
				res
					.writeHead(200, { "content-type": "text/html" })
					.end('<!doctype html><div id="root">Remote device</div><script src="/assets/app.js"></script>');
			else if (req.url === "/assets/app.js")
				res.writeHead(200, { "content-type": "text/javascript" }).end(browserScript);
			else if (req.url === "/api/echo")
				res.writeHead(200, { "content-type": "application/json" }).end(Buffer.concat(chunks));
			else res.end("asset");
		});
	});
	const targetOrigin = await listen(target);
	const wss = new WebSocketServer({ noServer: true });
	cleanups.push(() => {
		for (const ws of wss.clients) ws.terminate();
		wss.close();
	});
	target.on("upgrade", (req, socket, head) =>
		wss.handleUpgrade(req, socket, head, (ws) => {
			ws.on("error", () => {});
			ws.on("message", (data, binary) => ws.send(data, { binary }));
		}),
	);
	const transport = createDeviceLanServer({
		localOrigin: targetOrigin,
		localAuthToken: "target-auth",
		addresses: () => ["127.0.0.1"],
	});
	cleanups.push(transport.close);
	const access = createDeviceLanAccess({ allowLoopback: true });
	cleanups.push(access.close);
	const source = createServer((req, res) => {
		if (basePath !== "/" && req.url?.startsWith(basePath)) req.url = "/" + req.url.slice(basePath.length);
		if (!access.handleRequest(req, res)) res.writeHead(401).end("local APIs require auth");
	});
	source.on("upgrade", (req, socket, head) => {
		if (basePath !== "/" && req.url?.startsWith(basePath)) req.url = "/" + req.url.slice(basePath.length);
		if (!access.handleUpgrade(req, socket, head)) socket.destroy();
	});
	const sourceOrigin = await listen(source);
	let valid = true;
	let lanAvailable = true;
	let fallbackCalls = 0;
	const grant = await transport.issueGrant();
	const accessOptions: Parameters<typeof access.open>[1] = {
		deviceId: "remote",
		hubUrl: "https://hub.example",
		origin: sourceOrigin,
		basePath,
		desktop,
		valid: () => valid,
		renew: async () => (lanAvailable ? transport.issueGrant() : null),
		fallback: async () => {
			fallbackCalls++;
			return `https://hub.example/device/remote/__open?ticket=fresh${desktop ? "&next=%2Fdesktop" : ""}`;
		},
	};
	const opened = await access.open(grant, accessOptions);
	expect(opened?.transport).toBe("lan");
	const wrapperUrl = sourceOrigin + (basePath === "/" ? "" : basePath.slice(0, -1)) + opened!.url;
	const wrapper = await fetch(wrapperUrl);
	const html = await wrapper.text();
	const base = html.match(/(?:\/pi)?\/device-lan\/remote\/__relay\/[a-f0-9]{64}\//)![0];
	return {
		access,
		transport,
		received,
		sourceOrigin,
		targetOrigin,
		html,
		wrapper,
		wrapperUrl,
		base,
		setValid(value: boolean) {
			valid = value;
		},
		setLanAvailable(value: boolean) {
			lanAvailable = value;
		},
		getFallbackCalls: () => fallbackCalls,
		async freshUrl() {
			const result = await access.open(await transport.issueGrant(), accessOptions);
			return sourceOrigin + (basePath === "/" ? "" : basePath.slice(0, -1)) + result!.url;
		},
	};
}

describe("local capability portal over authenticated LAN", () => {
	it("keeps preview routing through ticket exchange and LAN-to-Hub fallback", async () => {
		const f = await fixture("/pi/", true);
		const ticket = await f.freshUrl();
		const wrapper = await fetch(ticket + "&next=%2Fdesktop-preview");
		const html = await wrapper.text();
		expect(html).toContain("desktop-preview");
		const base = html.match(/\/pi\/device-lan\/remote\/__relay\/[a-f0-9]{64}\//)![0];
		f.setLanAvailable(false);
		const fallback = await fetch(f.sourceOrigin + base + "__lan_fallback", {
			method: "POST",
			headers: { origin: "null" },
		});
		expect((await fallback.json()).url).toContain("next=%2Fdesktop-preview");
	});
	it(
		"loads a prefixed LAN UI inside the real opaque desktop iframe and falls back after losing LAN",
		async () => {
			const chromeHelper = "../lib/chrome.mjs";
			const { CHROME_PATH } = await import(chromeHelper);
			if (!CHROME_PATH) throw new Error("Chrome required: set PI_WEB_CHROME");
			const f = await fixture(
				"/pi/",
				true,
				`(async()=>{const result={opaque:false,fetch:false,ws:false};try{void document.cookie}catch{result.opaque=true}const base=new URL(document.baseURI);const response=await fetch(new URL('api/echo',base),{method:'POST',headers:{'Content-Type':'application/json'},body:'{"ok":true}',credentials:'omit'});result.fetch=(await response.json()).ok;const ws=new WebSocket(new URL('ws',base).href.replace(/^http/,'ws'));await new Promise((resolve,reject)=>{ws.onopen=()=>ws.send('hello');ws.onmessage=event=>{result.ws=event.data==='hello';resolve()};ws.onerror=reject});document.getElementById('root').textContent=JSON.stringify(result)})()`,
			);
			const fresh = await f.freshUrl();
			const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true, args: ["--no-sandbox"] });
			cleanups.push(() => browser.close());
			const page = await browser.newPage();
			await page.route(f.sourceOrigin + "/embed", (route) =>
				route.fulfill({
					contentType: "text/html",
					body: `<iframe sandbox="allow-scripts allow-forms allow-pointer-lock" src="${fresh}"></iframe>`,
				}),
			);
			await page.route("https://hub.example/**", (route) =>
				route.fulfill({ contentType: "text/html", body: "Hub fallback" }),
			);
			await page.goto(f.sourceOrigin + "/embed");
			await vi.waitFor(
				async () => {
					const frame = page
						.frames()
						.find((frame) => frame.url().includes("/__relay/") && !frame.url().endsWith("/__lan_view"));
					expect(await frame?.locator("#root").textContent()).toContain('"ws":true');
				},
				{ timeout: 10000 },
			);
			let inner = page
				.frames()
				.find((frame) => frame.url().includes("/__relay/") && !frame.url().endsWith("/__lan_view"))!;
			expect(JSON.parse((await inner.locator("#root").textContent())!)).toEqual({
				opaque: true,
				fetch: true,
				ws: true,
			});
			const wrapperFrame = page.frames().find((frame) => frame.url().endsWith("/__lan_view"))!;
			await wrapperFrame.goto(wrapperFrame.url());
			await vi.waitFor(
				async () => {
					inner = page
						.frames()
						.find((frame) => frame.url().includes("/__relay/") && !frame.url().endsWith("/__lan_view"))!;
					expect(await inner?.locator("#root").textContent()).toContain('"ws":true');
				},
				{ timeout: 10000 },
			);
			f.setLanAvailable(false);
			f.transport.close();
			await inner.evaluate(() => parent.postMessage({ type: "device-portal-disconnected" }, "*"));
			await vi.waitFor(
				() =>
					expect(
						page.frames().some((frame) => frame.url().startsWith("https://hub.example/device/remote/__open")),
					).toBe(true),
				{ timeout: 10000 },
			);
			expect(f.getFallbackCalls()).toBe(1);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
	it("opens the whole device UI with opaque sandboxing and rewritten assets without contacting a Hub", async () => {
		const f = await fixture();
		expect(f.wrapper.status).toBe(200);
		expect(f.html).toContain('sandbox="allow-scripts allow-forms allow-downloads"');
		expect(f.html).toContain("LAN");
		expect((await fetch(f.wrapperUrl)).status).toBe(403);
		expect((await fetch(f.wrapper.url)).status).toBe(200);
		const page = await fetch(f.sourceOrigin + f.base, { headers: { Origin: "null", Cookie: "source-private=secret" } });
		expect(page.status).toBe(200);
		expect(page.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
		expect(page.headers.get("access-control-allow-origin")).toBe("null");
		expect(page.headers.get("set-cookie")).toBeNull();
		const body = await page.text();
		expect(body).toContain(`<base href="${f.base}">`);
		expect(body).toContain(`src="${f.base}assets/app.js"`);
		expect(f.received.find((r) => r.path === "/")).toMatchObject({
			auth: "Bearer target-auth",
			cookie: undefined,
			origin: f.targetOrigin,
		});
		expect((await fetch(f.sourceOrigin + f.base + "assets/app.js", { headers: { Origin: "null" } })).status).toBe(200);
	});
	it.each([false, true])("carries chat and desktop WebSocket text/binary through LAN (desktop=%s)", async (desktop) => {
		const f = await fixture("/", desktop);
		const ws = new WebSocket(
			f.sourceOrigin.replace("http:", "ws:") + f.base + (desktop ? "desktop-ws?viewOnly=0" : "ws"),
			{ origin: "null" },
		);
		ws.on("error", () => {});
		cleanups.push(() => ws.terminate());
		await once(ws, "open");
		let reply = once(ws, "message");
		ws.send('{"type":"message","text":"hello"}');
		let [data, binary] = await reply;
		expect(data.toString()).toContain("hello");
		expect(binary).toBe(false);
		reply = once(ws, "message");
		const frame = Buffer.from([0xff, 0xd8, 0x00, 0x01, 0xff, 0xd9]);
		ws.send(frame);
		[data, binary] = await reply;
		expect(data).toEqual(frame);
		expect(binary).toBe(true);
		const closed = once(ws, "close");
		f.access.reset();
		await closed;
	});
	it("preserves uploads, account metadata and reverse proxy prefixes", async () => {
		const f = await fixture("/pi/");
		const response = await fetch(f.sourceOrigin + f.base + "api/echo", {
			method: "POST",
			headers: { Origin: "null", "Content-Type": "application/json" },
			body: '{"text":"hello"}',
		});
		expect(await response.json()).toEqual({ text: "hello" });
		const metadata = await fetch(f.sourceOrigin + f.base + "api/device-center/chat-status", {
			headers: { Origin: "null" },
		});
		expect(await metadata.json()).toEqual({ hubUrl: "https://hub.example", deviceId: "remote", transport: "lan" });
		expect(f.received.some((r) => r.path === "/api/device-center/chat-status")).toBe(false);
	});
	it("never lets a portal capability reach local management routes, another origin, or another device", async () => {
		const f = await fixture();
		for (const path of ["api/device-center/disconnect", "api/device-desktop/local/permissions", "setup", "api/setup"]) {
			expect((await fetch(f.sourceOrigin + f.base + path, { headers: { Origin: "null" } })).status).toBe(403);
		}
		expect((await fetch(f.sourceOrigin + f.base, { headers: { Origin: f.sourceOrigin } })).status).toBe(403);
		expect(
			(await fetch(f.sourceOrigin + f.base.replace("/remote/", "/other/"), { headers: { Origin: "null" } })).status,
		).toBe(403);
		expect((await fetch(f.sourceOrigin + "/api/setup")).status).toBe(401);
		f.setValid(false);
		expect((await fetch(f.sourceOrigin + f.base, { headers: { Origin: "null" } })).status).toBe(403);
	});
	it("requests a fresh Hub ticket from the trusted wrapper after direct transport fails", async () => {
		const f = await fixture("/", true);
		expect(f.html).toContain("device-portal-disconnected");
		expect(f.html).toContain(f.base + "__lan_fallback");
		f.transport.close();
		f.setLanAvailable(false);
		expect(f.wrapper.headers.get("content-security-policy")).toContain(
			`connect-src ${f.sourceOrigin}${f.base}__lan_fallback`,
		);
		const fallback = await fetch(f.sourceOrigin + f.base + "__lan_fallback", {
			method: "POST",
			headers: { Origin: "null" },
		});
		expect(fallback.status).toBe(200);
		expect((await fallback.json()).url).toContain("ticket=fresh&next=%2Fdesktop");
		expect(f.getFallbackCalls()).toBe(1);
		expect(fallback.headers.get("access-control-allow-origin")).toBe("null");
		expect((await fetch(f.sourceOrigin + f.base, { headers: { Origin: "null" } })).status).toBe(403);
	});
	it("retries authenticated LAN before falling back when a temporary link recovers", async () => {
		const f = await fixture("/pi/", true);
		f.transport.close();
		const response = await fetch(f.sourceOrigin + f.base + "__lan_fallback", {
			method: "POST",
			headers: { Origin: "null" },
		});
		expect(response.status).toBe(200);
		const { url } = await response.json();
		expect(url).toMatch(new RegExp(`^${f.sourceOrigin}/pi/device-lan/remote/__open`));
		expect((await fetch(url)).status).toBe(200);
		expect(f.getFallbackCalls()).toBe(0);
	});
	it("releases a capability on wrapper unload but rejects unrelated origins and devices", async () => {
		const f = await fixture("/", true);
		expect(f.html).toContain("pagehide");
		expect(f.html).toContain("keepalive:true");
		expect(
			(
				await fetch(f.sourceOrigin + f.base + "__lan_close", {
					method: "POST",
					headers: { Origin: "https://unrelated.invalid" },
				})
			).status,
		).toBe(403);
		expect(
			(
				await fetch(f.sourceOrigin + f.base.replace("/remote/", "/other/") + "__lan_close", {
					method: "POST",
					headers: { Origin: "null" },
				})
			).status,
		).toBe(403);
		expect(
			(await fetch(f.sourceOrigin + f.base + "__lan_close", { method: "POST", headers: { Origin: "null" } })).status,
		).toBe(204);
		expect((await fetch(f.sourceOrigin + f.base, { headers: { Origin: "null" } })).status).toBe(403);
	});
});
