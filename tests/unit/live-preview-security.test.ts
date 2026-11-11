import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { proxyHttp } from "../../server/http-proxy.js";
import express from "express";
import { stripTypeScriptTypes } from "node:module";
import { chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import plugin from "../../plugins/live-preview/index.mjs";
import { BROWSER_TEST_TIMEOUT_MS, CHROME_PATH } from "../lib/chrome.mjs";

const source = readFileSync(new URL("../../server/index.ts", import.meta.url), "utf8");
function extract(from: string, until: string) {
	const start = source.indexOf(from);
	return source.slice(start, source.indexOf(until, start));
}
const code = stripTypeScriptTypes(extract("function livePreviewCapability(", "\napp.use("));
const routes = new Map<string, { prefix: string; pluginId: string; host: string; port: number }>();
const pluginMgr = {
	findProxy(path: string) {
		return [...routes.values()]
			.filter((r) => path === r.prefix || path.startsWith(r.prefix + "/"))
			.sort((a, b) => b.prefix.length - a.prefix.length)[0];
	},
};
const { livePreviewCapability } = new Function(
	"pluginMgr",
	"createHash",
	"timingSafeEqual",
	code + "\nreturn {livePreviewCapability};",
)(pluginMgr, createHash, timingSafeEqual);
const files = new Map([
	[
		"nested/index.html",
		'<!doctype html><html><body><h1>first</h1><script>try{localStorage.getItem("host");document.body.dataset.storage="leaked"}catch(e){document.body.dataset.storage="blocked"}fetch("/api/private").then(r=>r.text()).then(()=>document.body.dataset.api="leaked").catch(()=>document.body.dataset.api="blocked")</script><script type="module" src="./app.mjs"></script></body></html>',
	],
	["nested/app.mjs", 'document.body.dataset.module="ok";'],
	["fragment.html", "<h1>fragment</h1>"],
	[
		"drawing.svg",
		'<svg xmlns="http://www.w3.org/2000/svg"><script>document.documentElement.setAttribute("ran","yes")</script></svg>',
	],
	["readme.md", "# Heading\nSome text\n## Second heading\nMore text"],
	["video.mp4", "0123456789"],
]);
let onChange = () => {};
let deactivate: () => void;
let base: string;
let cap: string;
let privateReads = 0;
const app = express();
app.use((req, res, next) => {
	const preview = livePreviewCapability(req);
	if (preview) {
		proxyHttp(preview, req, res);
		return;
	}
	if (req.headers.cookie === "pi_web_token=test-host-secret") {
		next();
		return;
	}
	res.status(401).end("unauthorized");
});
app.get("/api/private", (_req, res) => {
	privateReads++;
	res.end("secret");
});
app.use((req, res) => {
	const hit = pluginMgr.findProxy(req.path);
	if (hit) proxyHttp(hit, req, res);
	else res.status(404).end("not found");
});
const server = createServer(app);
const auth = { Cookie: "pi_web_token=test-host-secret" };
beforeAll(async () => {
	deactivate = await plugin.activate({
		cwd: "/isolated-test-workspace",
		getSettings: () => ({}),
		registerProxy(prefix: string, port: number) {
			routes.set(prefix, { prefix, port, pluginId: "live-preview", host: "127.0.0.1" });
			return () => routes.delete(prefix);
		},
		registerAgentTool() {
			return () => {};
		},
		fs: {
			stat: async (path: string) => {
				if (files.has(path)) return { type: "file", size: files.get(path)!.length };
				if (path === "nested") return { type: "dir" };
				throw Error("missing");
			},
			readText: async (path: string) => {
				if (!files.has(path)) throw Error("missing");
				return files.get(path);
			},
			read: async (path: string) => Buffer.from(files.get(path)!),
			list: async () => [],
			watch: (_path: string, cb: () => void) => {
				onChange = cb;
				return () => {};
			},
		},
	});
	cap = [...routes.keys()].find((p) => p.startsWith("/__live-preview/"))!;
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
	deactivate?.();
	server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("live-preview isolated capability service with TOKEN enabled", () => {
	it("requires host auth to issue a capability; drops query credentials", async () => {
		expect((await fetch(base + "/liveserver/nested/index.html", { redirect: "manual" })).status).toBe(401);
		const res = await fetch(base + "/liveserver/nested/index.html?token=test-host-secret", {
			headers: auth,
			redirect: "manual",
		});
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe(cap + "/nested/index.html");
		expect(cap).toMatch(/^\/__live-preview\/[a-f0-9]{64}$/);
		expect((await fetch(base + "/api/private")).status).toBe(401);
	});
	it("keeps every document isolated, with noncredentialed CORS and no capability referrer", async () => {
		for (const path of ["nested/index.html", "readme.md", "drawing.svg", "fragment.html", ""]) {
			const res = await fetch(base + cap + "/" + path);
			expect(res.status).toBe(200);
			expect(res.headers.get("content-security-policy")).toBe("sandbox allow-scripts");
			expect(res.headers.get("access-control-allow-origin")).toBe("*");
			expect(res.headers.get("access-control-allow-credentials")).toBeNull();
			expect(res.headers.get("referrer-policy")).toBe("no-referrer");
		}
		expect(await (await fetch(base + cap + "/fragment.html")).text()).toContain("new EventSource");
		const range = await fetch(base + cap + "/video.mp4", { headers: { Range: "bytes=2-5" } });
		expect(range.status).toBe(206);
		expect(await range.text()).toBe("2345");
		expect((await fetch(base + cap + "/nested", { redirect: "manual" })).headers.get("location")).toBe(
			cap + "/nested/",
		);
	});
	it("rejects wrong capabilities, methods, other plugin identities and path escapes", async () => {
		expect(livePreviewCapability({ method: "POST", path: cap + "/" })).toBeUndefined();
		expect(livePreviewCapability({ method: "GET", path: cap + "suffix/" })).toBeUndefined();
		const hit = routes.get(cap)!;
		hit.pluginId = "another-plugin";
		expect(livePreviewCapability({ method: "GET", path: cap + "/" })).toBeUndefined();
		hit.pluginId = "live-preview";
		for (const suffix of ["/%2e%2e%2fapi/private", "/%5c..%5capi/private", "/%00", "/%zz"]) {
			expect((await fetch(base + cap + suffix)).status).toBe(400);
		}
		expect((await fetch(base + cap + "/api/private")).status).toBe(404);
		expect((await fetch(base + cap + "/../../api/private")).status).toBe(401);
		expect(privateReads).toBe(0);
	});
	it.skipIf(!CHROME_PATH)(
		"runs modules, blocks host access and auto-refreshes via SSE without host credentials",
		async () => {
			const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true, args: ["--no-sandbox"] });
			try {
				const context = await browser.newContext();
				await context.addCookies([
					{ name: "pi_web_token", value: "test-host-secret", url: base, httpOnly: true, sameSite: "Strict" },
				]);
				const page = await context.newPage();
				await page.goto(base + "/liveserver/nested/index.html");
				await page.waitForFunction(
					() => document.body.dataset.module === "ok" && document.body.dataset.api === "blocked",
				);
				expect(await page.evaluate(() => document.body.dataset.storage)).toBe("blocked");
				expect(privateReads).toBe(0);
				files.set("nested/index.html", files.get("nested/index.html")!.replace("first", "refreshed"));
				onChange();
				await page.waitForFunction(() => document.querySelector("h1")?.textContent === "refreshed");
				await page.goto(base + cap + "/readme.md");
				expect(await page.locator("#pmt").count()).toBe(1);
			} finally {
				await browser.close();
			}
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
	it("revokes the capability on deactivation, including existing SSE connections", async () => {
		const res = await fetch(base + cap + "/__livepreview/events");
		const reader = res.body!.getReader();
		await reader.read();
		deactivate();
		expect((await reader.read()).done).toBe(true);
		expect(livePreviewCapability({ method: "GET", path: cap + "/" })).toBeUndefined();
		expect((await fetch(base + cap + "/nested/index.html")).status).toBe(401);
	});
});
