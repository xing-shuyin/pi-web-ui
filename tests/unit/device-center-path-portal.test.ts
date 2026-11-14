import { afterEach, describe, expect, it, vi } from "vitest";
import http, { type Server } from "node:http";
import { once } from "node:events";
import { gzipSync } from "node:zlib";
import { WebSocketServer } from "ws";
import { chromium } from "playwright-core";
import { BROWSER_TEST_TIMEOUT_MS } from "../lib/chrome.mjs";
import { createDeviceRelay } from "../../server/device-center/relay.js";
import { createDeviceConnector } from "../../server/device-center/connector.js";
import {
	capabilityBase,
	createPortalResponse,
	PATH_HTML_LIMIT,
	portalHeaders,
	transformPortalHtml,
} from "../../server/device-center/path-portal.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const fn of cleanup.reverse()) await fn();
	cleanup.length = 0;
});
async function listen(server: Server) {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	cleanup.push(() => {
		server.closeAllConnections();
		server.close();
	});
	return (server.address() as { port: number }).port;
}
async function fixture(deviceName?: string, deviceRemark?: string, secondDevice = false) {
	const received: http.IncomingHttpHeaders[] = [];
	const local = http.createServer((req, res) => {
		received.push(req.headers);
		if (["/", "/desktop", "/desktop-preview"].includes(req.url?.split("?")[0] ?? "")) {
			res.writeHead(200, {
				"content-type": "text/html",
				"set-cookie": "device=bad; Path=/",
				"clear-site-data": '"*"',
				"service-worker-allowed": "/",
				"access-control-allow-origin": "*",
				"access-control-allow-credentials": "true",
			});
			res.end(
				'<html><head><base href="/evil/"><link rel="stylesheet" href="/style.css"></head><body><script type="module" src="/assets/app.js"></script></body></html>',
			);
		} else if (req.url === "/assets/large.bin") {
			res.setHeader("content-type", "application/octet-stream");
			res.end(Buffer.alloc(8 * 1024 * 1024, 120));
		} else if (req.url === "/assets/compressed.js") {
			res.setHeader("content-type", "text/javascript");
			const body = "export const compressed = true;";
			if (req.headers["accept-encoding"]?.includes("gzip")) {
				res.setHeader("content-encoding", "gzip");
				res.end(gzipSync(body));
			} else res.end(body);
		} else if (req.url === "/assets/app.js") {
			res.setHeader("content-type", "text/javascript");
			res.end(`import { value } from './chunk.js';
 const result={module:value,opaque:false,fetch:false,ws:false,hubBlocked:false};
 try{void document.cookie}catch{result.opaque=true}
 const base=new URL(document.baseURI); const data=await fetch(new URL('api/data',base)).then(r=>r.json());result.fetch=data.ok;
 try{await fetch('/hub-secret');}catch{result.hubBlocked=true}
 const ws=new WebSocket(new URL('ws',base).href.replace(/^http/,'ws'));await new Promise((resolve,reject)=>{ws.onopen=()=>ws.send('echo');ws.onmessage=e=>{result.ws=e.data==='echo';ws.close();resolve()};ws.onerror=reject});
 parent.postMessage({type:'device-session-hash',hash:'#s=synced'},'*');document.body.textContent=JSON.stringify(result);`);
		} else if (req.url === "/assets/chunk.js") {
			res.setHeader("content-type", "text/javascript");
			res.end('export const value="loaded"');
		} else if (req.url === "/api/data") {
			res.setHeader("content-type", "application/json");
			res.end('{"ok":true}');
		} else if (req.url === "/style.css") {
			res.setHeader("content-type", "text/css");
			res.end("body{color:rgb(1,2,3)}");
		} else if (req.url === "/redirect") {
			res.writeHead(302, { location: "/api/data" }).end();
		} else {
			res.setHeader("content-type", "image/svg+xml");
			res.end('<svg xmlns="http://www.w3.org/2000/svg"/>');
		}
	});
	const localWs = new WebSocketServer({ server: local });
	localWs.on("connection", (ws, req) => {
		received.push(req.headers);
		ws.on("message", (data, binary) => ws.send(data, { binary }));
	});
	cleanup.push(() => {
		localWs.close();
	});
	const localPort = await listen(local);
	let relay: ReturnType<typeof createDeviceRelay>;
	let hubHits = 0;
	const server = http.createServer((req, res) => {
		if (relay.handleRequest(req, res)) return;
		if (req.url === "/open") {
			void relay.handleOpen(req, res, "dev1");
			return;
		}
		if (req.url === "/hub-secret") hubHits++;
		res.writeHead(404).end();
	});
	const port = await listen(server);
	const origin = `http://127.0.0.1:${port}`;
	relay = createDeviceRelay({
		server,
		publicUrl: origin,
		pathAccess: true,
		authenticateDevice: (id, key) => (id === "dev1" || (secondDevice && id === "dev2")) && key === "credential",
		getAccount: (req) => (req.headers.cookie?.includes("hub=secret") ? "account" : null),
		ownsDevice: (account, id) => account === "account" && (id === "dev1" || (secondDevice && id === "dev2")),
		getDeviceName: () => deviceName,
		getDeviceRemark: () => deviceRemark,
	});
	cleanup.push(() => relay.close());
	const connector = createDeviceConnector({
		hubUrl: origin,
		deviceId: "dev1",
		credential: "credential",
		localOrigin: `http://127.0.0.1:${localPort}`,
		localAuthToken: "local-token",
		onTask: async () => "done",
	});
	cleanup.push(() => connector.close());
	await vi.waitFor(() => expect(relay.isOnline("dev1")).toBe(true));
	if (secondDevice) {
		const other = createDeviceConnector({
			hubUrl: origin,
			deviceId: "dev2",
			credential: "credential",
			localOrigin: `http://127.0.0.1:${localPort}`,
			localAuthToken: "local-token",
			onTask: async () => "done",
		});
		cleanup.push(() => other.close());
		await vi.waitFor(() => expect(relay.isOnline("dev2")).toBe(true));
	}
	const request = async (path: string, headers: Record<string, string> = {}, method = "GET") => {
		const response = await fetch(origin + path, { headers, method, redirect: "manual" });
		return { status: response.status, headers: response.headers, body: await response.text() };
	};
	const open = async () => {
		const ticket = await request("/open", { cookie: "hub=secret", origin }, "POST");
		expect(ticket.status).toBe(200);
		const url = new URL(JSON.parse(ticket.body).url);
		if (deviceName && deviceRemark) expect(JSON.parse(ticket.body).deviceLabel).toBe(`${deviceRemark} · ${deviceName}`);
		const wrapper = await request(url.pathname + url.search);
		const base = /\/device\/dev1\/__relay\/[a-f0-9]{64}\//.exec(wrapper.body)![0];
		return { wrapper, base, ticketPath: url.pathname + url.search };
	};
	return { relay, origin, request, open, received, hubHits: () => hubHits };
}

describe("single-port device path portal", () => {
	it("opens another owned desktop inside a remote page without forwarding privileged device-center requests", async () => {
		const f = await fixture(undefined, undefined, true);
		const { base } = await f.open();
		for (const target of ["outsider", "../dev2", "https://evil.example"]) {
			expect(
				(await f.request(base + "__desktop_target?device=" + encodeURIComponent(target), { origin: "null" })).status,
			).toBe(403);
			expect(
				(await f.request(base + "__desktop_open?device=" + encodeURIComponent(target), { origin: f.origin }, "POST"))
					.status,
			).toBe(403);
		}
		expect((await f.request(base + "__desktop_target?device=dev2", { origin: "https://evil.example" })).status).toBe(
			403,
		);
		const preview = await f.request(base + "__desktop_target?device=dev2&preview=1", { origin: "null" });
		expect(preview.status).toBe(200);
		const childBase = /\/device\/dev2\/__relay\/[a-f0-9]{64}\//.exec(preview.body)![0];
		expect(preview.body).toContain(childBase + "desktop-preview");
		expect(preview.headers.get("content-security-policy")).toContain("frame-src " + f.origin + childBase);
		expect((await f.request(childBase + "desktop", { origin: "null" })).status).toBe(200);
		const opened = await f.request(base + "__desktop_open?device=dev2", { origin: f.origin }, "POST");
		expect(opened.status).toBe(200);
		expect(new URL(JSON.parse(opened.body).url).pathname).toBe("/device/dev2/__open");
		f.relay.revoke("dev2");
		expect((await f.request(childBase + "desktop", { origin: "null" })).status).toBe(403);
		f.relay.revoke("dev1");
		expect((await f.request(base + "__desktop_target?device=dev2", { origin: "null" })).status).toBe(403);
	});
	it("issues separate desktop tickets only to the owning outer portal", async () => {
		const f = await fixture();
		const { base } = await f.open();
		const endpoint = base + "__desktop_open";
		for (const origin of ["null", "https://other.example", ""]) {
			expect((await f.request(endpoint, { origin }, "POST")).status).toBe(403);
		}
		expect((await f.request(endpoint, { origin: f.origin })).status).toBe(403);
		expect((await f.request(endpoint.replace("dev1", "dev2"), { origin: f.origin }, "POST")).status).toBe(403);
		const opened = await f.request(endpoint, { origin: f.origin }, "POST");
		expect(opened.status).toBe(200);
		const url = new URL(JSON.parse(opened.body).url);
		expect(url.pathname).toBe("/device/dev1/__open");
		const child = await f.request(url.pathname + url.search + "&next=%2Fdesktop");
		expect(child.status).toBe(200);
		const childBase = /\/device\/dev1\/__relay\/[a-f0-9]{64}\//.exec(child.body)![0];
		expect(childBase).not.toBe(base);
		expect(child.body).toContain(childBase + "desktop");
		expect((await f.request(url.pathname + url.search)).status).toBe(403);
		expect((await f.request(base + "api/data", { origin: "null" })).status).toBe(200);
		f.relay.revoke("dev1");
		expect((await f.request(endpoint, { origin: f.origin }, "POST")).status).toBe(403);
	});
	it("uses the remark and computer name in the tab title and escapes HTML", async () => {
		const f = await fixture("DESKTOP-TEST", '办公机 </title><script>alert("x")</script>&');
		const expected =
			"<title>办公机 &lt;/title&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp; · DESKTOP-TEST · pi-web-ui</title>";
		expect((await f.request("/device/dev1/", { cookie: "hub=secret" })).body).toContain(expected);
		expect((await f.open()).wrapper.body).toContain(expected);
	});
	it("requires Hub account or one-use device ticket; wrapper never grants same origin", async () => {
		const f = await fixture();
		expect((await f.request("/device/dev1/")).status).toBe(401);
		const direct = await f.request("/device/dev1/", { cookie: "hub=secret" });
		expect(direct.status).toBe(200);
		expect(direct.body).toContain("<title>dev1 · pi-web-ui</title>");
		const { wrapper, ticketPath } = await f.open();
		expect(wrapper.body).toContain('sandbox="allow-scripts allow-forms allow-downloads"');
		expect(wrapper.body).not.toContain("allow-same-origin");
		expect(wrapper.headers.get("content-security-policy")).not.toContain("sandbox");
		expect(wrapper.body).toContain("+location.hash");
		expect(wrapper.body).toContain("event.source!==frame.contentWindow");
		expect(wrapper.body).toContain("event.origin!=='null'");
		expect((await f.request(ticketPath)).status).toBe(403);
		expect((await f.request("/device/dev1/", { cookie: "hub=secret", origin: "null" })).status).toBe(401);
	});
	it.each(["/desktop", "/desktop-preview"])("embeds %s from another origin with both frames opaque", async (path) => {
		const chromeHelper = "../lib/chrome.mjs";
		const { CHROME_PATH } = await import(chromeHelper);
		if (!CHROME_PATH) throw new Error("Chrome required: set PI_WEB_CHROME");
		const f = await fixture();
		const ticket = await f.request("/open", { cookie: "hub=secret", origin: f.origin }, "POST");
		const url = new URL(JSON.parse(ticket.body).url);
		url.searchParams.set("next", path);
		const parent = http.createServer((_req, res) => {
			res.setHeader("content-type", "text/html");
			res.end(
				`<iframe sandbox="allow-scripts allow-forms allow-pointer-lock" allowfullscreen src="${url.href}"></iframe>`,
			);
		});
		const parentPort = await listen(parent);
		const browser = await chromium.launch({ executablePath: CHROME_PATH!, headless: true, args: ["--no-sandbox"] });
		cleanup.push(() => browser.close());
		const page = await browser.newPage();
		await page.goto(`http://127.0.0.1:${parentPort}`);
		const frame = page.frameLocator("iframe").frameLocator("iframe");
		await expect.poll(() => frame.locator("body").textContent(), { timeout: 15000 }).toContain('"ws":true');
		const result = JSON.parse((await frame.locator("body").textContent())!);
		expect(result).toMatchObject({ module: "loaded", opaque: true, fetch: true, ws: true, hubBlocked: true });
		await expect.poll(() => page.frameLocator("iframe").locator("#loading").isHidden()).toBe(true);
		expect(f.hubHits()).toBe(0);
		expect((await f.request(url.pathname + url.search)).status).toBe(403);
	});

	it("serves minimal account binding for current and older remote device UIs", async () => {
		const f = await fixture();
		const { base } = await f.open();
		const before = f.received.length;
		for (const route of ["chat-status", "status"]) {
			const response = await f.request(base + "api/device-center/" + route, { origin: "null" });
			expect(response.status).toBe(200);
			expect(JSON.parse(response.body)).toEqual({ hubUrl: f.origin, deviceId: "dev1" });
			expect(response.headers.get("access-control-allow-origin")).toBe("null");
		}
		expect(f.received.length).toBe(before);
	});
	it("exposes policy rejection status to authenticated sandbox requests only", async () => {
		const f = await fixture();
		const { base } = await f.open();
		const denied = await f.request(base + "api/device-center/config", { origin: "null" });
		expect(denied.status).toBe(400);
		expect(denied.headers.get("access-control-allow-origin")).toBe("null");
		expect(denied.headers.get("access-control-allow-credentials")).toBeNull();
		const invalid = await f.request(base + "api/device-center/config", { origin: f.origin });
		expect(invalid.status).toBe(403);
		expect(invalid.headers.get("access-control-allow-origin")).toBeNull();
	});
	it("streams resources larger than the relay queue without dropping the device", async () => {
		const f = await fixture();
		const { base } = await f.open();
		const asset = await f.request(base + "assets/large.bin", { origin: "null" });
		expect(asset.status).toBe(200);
		expect(asset.body.length).toBe(8 * 1024 * 1024);
		expect(asset.body).toBe("x".repeat(8 * 1024 * 1024));
		expect(f.relay.isOnline("dev1")).toBe(true);
	});
	it("preserves asset compression while requesting identity only for rewritten entry HTML", async () => {
		const f = await fixture();
		const { base } = await f.open();
		const headers = { origin: "null", "accept-encoding": "gzip" };
		const entry = await f.request(base + "?first=1", headers);
		expect(entry.status).toBe(200);
		expect(entry.body).toContain(`<base href="${base}">`);
		expect(f.received.at(-1)?.["accept-encoding"]).toBe("identity");
		const asset = await f.request(base + "assets/compressed.js", headers);
		expect(asset.status).toBe(200);
		expect(asset.headers.get("content-encoding")).toBe("gzip");
		expect(asset.body).toBe("export const compressed = true;");
		expect(f.received.at(-1)?.["accept-encoding"]).toBe("gzip");
	});
	it("binds capability to device, expiration and revocation, stripping Hub credentials", async () => {
		const f = await fixture();
		const { base } = await f.open();
		expect((await f.request(base.replace("dev1", "dev2") + "api/data", { origin: "null" })).status).toBe(403);
		expect((await f.request(base + "api/data", { origin: f.origin })).status).toBe(403);
		const result = await f.request(base + "api/data", {
			origin: "null",
			cookie: "hub=secret",
			authorization: "Bearer hub-secret",
		});
		expect(result.status).toBe(200);
		expect(f.received.at(-1)?.cookie).not.toContain("hub=secret");
		expect(f.received.at(-1)?.authorization).not.toContain("hub-secret");
		expect(result.headers.get("access-control-allow-origin")).toBe("null");
		expect(result.headers.get("access-control-allow-credentials")).toBeNull();
		const time = Date.now();
		const now = vi.spyOn(Date, "now").mockReturnValue(time + 16 * 60_000);
		expect((await f.request(base + "api/data", { origin: "null" })).status).toBe(200);
		now.mockReturnValue(time + 9 * 60 * 60_000);
		try {
			expect((await f.request(base + "api/data", { origin: "null" })).status).toBe(403);
		} finally {
			now.mockRestore();
		}
		const next = await f.open();
		f.relay.revoke("dev1");
		expect((await f.request(next.base + "api/data", { origin: "null" })).status).toBe(403);
	});
	it("handles null CORS preflight, transforms entry HTML and confines redirects and every document", async () => {
		const f = await fixture();
		const { base } = await f.open();
		const preflight = await f.request(
			base + "api/data",
			{ origin: "null", "access-control-request-method": "POST" },
			"OPTIONS",
		);
		expect(preflight.status).toBe(204);
		expect(preflight.headers.get("access-control-allow-origin")).toBe("null");
		const html = await f.request(base, { origin: "null", cookie: "hub=secret" });
		expect(html.body).toContain(`<base href="${base}">`);
		expect(html.body).toContain(`src="${base}assets/app.js"`);
		expect(html.body).not.toContain("/evil/");
		for (const header of [
			"set-cookie",
			"clear-site-data",
			"service-worker-allowed",
			"access-control-allow-credentials",
		])
			expect(html.headers.get(header)).toBeNull();
		const svg = await f.request(base + "other.svg", { origin: "null" });
		expect(svg.headers.get("content-security-policy")).toContain("sandbox allow-scripts allow-forms allow-downloads;");
		expect(svg.headers.get("content-security-policy")).toContain("worker-src 'none'");
		expect(svg.headers.get("content-security-policy")).not.toContain("allow-same-origin");
		const redirect = await f.request(base + "redirect", { origin: "null" });
		expect(redirect.headers.get("location")).toBe(base + "api/data");
	});
	it("limits buffered HTML to 2 MiB and rejects redirects escaping a capability", () => {
		const res = { writeHead: vi.fn(), flushHeaders: vi.fn(), write: vi.fn(), end: vi.fn() } as any;
		const base = capabilityBase("dev1", "a".repeat(64));
		const response = createPortalResponse(res, new URL("http://localhost:50001"), base, true);
		response.start(200, { "content-type": "text/html" });
		expect(() => response.write(Buffer.alloc(PATH_HTML_LIMIT + 1))).toThrow("2 MiB");
		for (const location of ["https://evil.test/", "//evil.test/", "/../hub", "/%252e%252e/hub", "/x\\hub"]) {
			expect(() =>
				createPortalResponse(res, new URL("http://localhost:50001"), base, false).start(302, { location }),
			).toThrow();
		}
		expect(portalHeaders(new URL("http://localhost:50001"), base)["content-security-policy"]).toContain(
			`connect-src http://localhost:50001${base} ws://localhost:50001${base};`,
		);
		expect(transformPortalHtml('<a href="/next">', base)).toContain(`href="${base}next"`);
	});
	it(
		"runs opaque HTML modules, null-origin fetch and WebSocket in real Chrome",
		async () => {
			const chromeHelper = "../lib/chrome.mjs";
			const { CHROME_PATH } = await import(chromeHelper);
			if (!CHROME_PATH) throw new Error("Chrome required: set PI_WEB_CHROME");
			const f = await fixture();
			const { ticketPath } = await f.open();
			const fresh = await f.request("/open", { cookie: "hub=secret", origin: f.origin }, "POST");
			const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true, args: ["--no-sandbox"] });
			cleanup.push(() => browser.close());
			const context = await browser.newContext();
			await context.addCookies([{ name: "hub", value: "secret", url: f.origin }]);
			const page = await context.newPage();
			await page.goto(JSON.parse(fresh.body).url + "#s=initial");
			const frame = page.frames().find((frame) => frame !== page.mainFrame())!;
			await vi.waitFor(async () => expect(await frame.locator("body").textContent()).toContain('"ws":true'), {
				timeout: 10000,
			});
			const result = JSON.parse((await frame.locator("body").textContent())!);
			expect(result).toEqual({ module: "loaded", opaque: true, fetch: true, ws: true, hubBlocked: true });
			await frame.evaluate(() => {
				document.body.innerHTML = '<div id="root"><span class="status-conn">Connecting</span></div>';
			});
			await expect.poll(() => page.locator("#loading").isHidden()).toBe(true);
			await expect.poll(() => frame.getByRole("status").isVisible()).toBe(true);
			await frame.evaluate(() => document.querySelector(".status-conn")!.classList.add("ok"));
			await expect.poll(() => frame.getByRole("status").isHidden()).toBe(true);
			await frame.evaluate(() => document.querySelector(".status-conn")!.classList.remove("ok"));
			await expect.poll(() => frame.getByRole("status").isVisible()).toBe(true);
			expect(f.hubHits()).toBe(0);
			await expect.poll(() => page.url()).toContain("#s=synced");
			expect(frame.url()).toContain("#s=initial");
			expect((await context.cookies()).find((cookie) => cookie.name === "hub")?.value).toBe("secret");
			expect(f.received.every((headers) => !headers.cookie?.includes("hub=secret"))).toBe(true);
			expect(ticketPath).toContain("/__open?ticket=");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});
