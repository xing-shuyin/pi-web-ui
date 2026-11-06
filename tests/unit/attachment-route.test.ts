import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findAttachment, initAttachmentStore, saveAttachmentSync } from "../../server/attachment-store.js";

const source = readFileSync(new URL("../../server/index.ts", import.meta.url), "utf8");
const start = source.indexOf('app.get("/api/attachment/:hash"');
const handler = source.slice(start, source.indexOf("\n});", start) + 4);
const app = express();
new Function(
	"app",
	"findAttachment",
	handler.replaceAll(" as { statusCode?: number }", "").replaceAll(" as Error", ""),
)(app, findAttachment);
const server = createServer(app);
const tempDir = mkdtempSync(join(tmpdir(), "pi-attachment-route-"));
initAttachmentStore(join(tempDir, ".pi-web"));
const image = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=",
	"base64",
);
const record = saveAttachmentSync(image, "image/png");
let base: string;

beforeAll(async () => {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
	await new Promise<void>((resolve) => {
		server.closeAllConnections();
		server.close(() => resolve());
	});
	rmSync(tempDir, { recursive: true, force: true });
});

describe("attachment HTTP route under hidden dataDir", () => {
	it("serves the image bytes with MIME and immutable caching", async () => {
		const res = await fetch(base + record.url);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("image/png");
		expect(res.headers.get("cache-control")).toContain("immutable");
		expect(Buffer.from(await res.arrayBuffer())).toEqual(image);
	});
	it("supports HEAD and byte ranges", async () => {
		const head = await fetch(base + record.url, { method: "HEAD" });
		expect(head.status).toBe(200);
		expect(head.headers.get("content-length")).toBe(String(image.length));
		expect((await head.arrayBuffer()).byteLength).toBe(0);
		const range = await fetch(base + record.url, { headers: { Range: "bytes=0-7" } });
		expect(range.status).toBe(206);
		expect(Buffer.from(await range.arrayBuffer())).toEqual(image.subarray(0, 8));
	});
	it.each(["0".repeat(64), ".env", "%2e%2e%2fsecret"])("rejects missing or invalid hash %s", async (hash) => {
		const res = await fetch(`${base}/api/attachment/${hash}`);
		expect(res.status).toBe(404);
	});
});
