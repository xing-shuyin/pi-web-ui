import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import express from "express";
import { chromium } from "playwright-core";
import { BROWSER_TEST_TIMEOUT_MS, CHROME_PATH } from "../lib/chrome.mjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const source = readFileSync(new URL("../../server/index.ts", import.meta.url), "utf8");
const start = source.indexOf('app.use(["/api/file", "/api/attachment/:hash", "/api/preview"]');
const policy = source.slice(start, source.indexOf("\n});", start) + 4);
const app = express();
new Function("app", policy)(app);
app.use((req, res) => {
	res.type(req.path.endsWith(".svg") ? "svg" : "html");
	res
		.status(req.headers.range ? 206 : req.headers["if-none-match"] ? 304 : 200)
		.end(
			'<body><script>document.body.dataset.ran="yes";try{localStorage.getItem("host");document.body.dataset.storage="leaked"}catch(e){document.body.dataset.storage="blocked"}</script></body>',
		);
});
const server = createServer(app);
let base: string;
beforeAll(async () => {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(
	() =>
		new Promise<void>((resolve) => {
			server.closeAllConnections();
			server.close(() => resolve());
		}),
);

describe("inline file policy", () => {
	it.each([
		"/api/file?path=a.xml",
		"/api/attachment/hash",
		"/api/preview/client/a.svg",
		"/api/preview/client/a.xhtml",
		"/api/preview/client/a.xml",
		"/api/preview/client/a.unknown",
	])("isolates all MIME types at %s", async (path) => {
		const requests: RequestInit[] = [
			{},
			{ method: "HEAD" },
			{ headers: { Range: "bytes=0-9" } },
			{ headers: { "If-None-Match": '"v1"' } },
		];
		for (const opts of requests) {
			const res = await fetch(base + path, opts);
			expect(res.headers.get("content-security-policy")).toBe("sandbox");
			expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		}
		const res = await fetch(base + path + (path.includes("?") ? "&" : "?") + "allowJs=1");
		expect(res.headers.get("content-security-policy")).toBe("sandbox allow-scripts");
	});
	it.skipIf(!CHROME_PATH)(
		"blocks scripts by default and keeps allowJs documents opaque",
		async () => {
			const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true, args: ["--no-sandbox"] });
			try {
				const page = await browser.newPage();
				await page.goto(base + "/api/attachment/hash");
				expect(await page.evaluate(() => document.body.dataset.ran)).toBeUndefined();
				await page.goto(base + "/api/attachment/hash?allowJs=1");
				expect(await page.evaluate(() => document.body.dataset.ran)).toBe("yes");
				expect(await page.evaluate(() => document.body.dataset.storage)).toBe("blocked");
			} finally {
				await browser.close();
			}
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
	it("installs policy before local and remote handlers", () => {
		expect(start).toBeGreaterThan(0);
		expect(start).toBeLessThan(source.indexOf('app.get("/api/file"'));
		expect(start).toBeLessThan(source.indexOf('app.get("/api/attachment/:hash"'));
		expect(start).toBeLessThan(source.indexOf("await serveRemoteWorkspaceFile("));
		expect(policy).toContain(source.match(/app\.get\("(\/api\/preview)\/\*splat"/)![1]);
		expect(source).not.toContain("sandbox allow-scripts allow-same-origin");
	});
});
