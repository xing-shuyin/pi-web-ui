import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, link, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDesktopFiles, desktopRelativePath } from "../../server/device-center/desktop-files.js";
import { desktopDownloadLimit, fileChunkCrc } from "../../server/device-center/desktop-files-protocol.js";

let home: string, server: Server, files: ReturnType<typeof createDesktopFiles>, enabled: boolean;
const base = "http://127.0.0.1:8997/api/device-desktop/files/";
const json = (body: unknown) => ({
	method: "POST",
	headers: { "content-type": "application/json", "x-test": "yes" },
	body: JSON.stringify(body),
});
const request = (path: string, options: RequestInit = {}) =>
	fetch(base + path, { ...options, headers: { "x-test": "yes", ...options.headers } });
beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "pi-desktop-files-test-"));
	enabled = true;
	const app = express();
	files = createDesktopFiles({ app, home, allowed: (req) => req.headers["x-test"] === "yes", enabled: () => enabled });
	server = createServer(app);
	await new Promise<void>((resolve) => server.listen(8997, "127.0.0.1", resolve));
});
afterEach(async () => {
	files.close();
	server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
	await rm(home, { recursive: true, force: true });
});
async function start(
	entries = [
		{ path: "folder/archive.zip", size: 5, directory: false },
		{ path: "folder/empty", size: 0, directory: true },
	],
) {
	const response = await request("jobs", json({ key: "a".repeat(32), entries }));
	expect(response.status).toBe(200);
	return response.json();
}
async function chunk(id: string, bytes: Buffer, offset = 0, crc = fileChunkCrc(bytes)) {
	return request(`jobs/${id}/chunk?entry=0&offset=${offset}&crc=${crc}`, {
		method: "PUT",
		headers: { "content-type": "application/octet-stream" },
		body: new Uint8Array(bytes),
	});
}
describe("desktop file transfer", () => {
	it("browses chosen directories, exports chunks and preserves existing destination files", async () => {
		const destination = join(home, "chosen"),
			source = join(home, "source");
		await mkdir(destination);
		await mkdir(join(source, "empty"), { recursive: true });
		const bytes = Buffer.from("current archive bytes");
		await writeFile(join(source, "archive.zip"), bytes);
		await writeFile(join(destination, "archive.zip"), "keep original");
		const listed = await (await request("list?path=" + encodeURIComponent(source))).json();
		expect(listed.path).toBe(source);
		expect(listed.entries.find((e: any) => e.name === "archive.zip")).toMatchObject({
			size: bytes.length,
			directory: false,
		});
		const exported = await (
			await request("exports", json({ paths: [join(source, "archive.zip"), join(source, "empty")] }))
		).json();
		const chunked = await (await request(`exports/${exported.id}/chunk?entry=0&offset=0`)).json();
		expect(Buffer.from(chunked.data, "base64")).toEqual(bytes);
		const job = await (
			await request("jobs", json({ key: "b".repeat(32), destination, entries: exported.entries }))
		).json();
		expect(
			(
				await request(`jobs/${job.id}/chunk?entry=0&offset=0&crc=${chunked.crc}`, {
					...json({ data: chunked.data }),
					method: "PUT",
				})
			).status,
		).toBe(200);
		const result = await (await request(`jobs/${job.id}/finish`, json({ checksums: [fileChunkCrc(bytes), 0] }))).json();
		expect(result.complete).toBe(true);
		expect(result.destination).toBe(destination);
		expect(await readFile(join(destination, "archive.zip"), "utf8")).toBe("keep original");
		expect(await readFile(join(destination, "archive (2).zip"))).toEqual(bytes);
		expect(await readdir(join(destination, "empty"))).toEqual([]);
		expect(
			(await request("jobs", json({ key: "b".repeat(32), destination: home, entries: exported.entries }))).status,
		).toBe(409);
		await writeFile(join(source, "archive.zip"), "changed");
		expect((await request(`exports/${exported.id}/chunk?entry=0&offset=0`)).status).toBe(409);
		expect((await request("list?path=" + encodeURIComponent(join(home, "..")))).ok).toBe(false);
	});
	it("validates CRC, replay, offsets and completion before publishing archive bytes and empty directories", async () => {
		const bytes = Buffer.from([80, 75, 0, 255, 19]),
			job = await start();
		expect((await chunk(job.id, bytes, 0, 123)).status).toBe(400);
		expect((await chunk(job.id, bytes, 1)).status).toBe(400);
		expect((await request(`jobs/${job.id}/finish`, json({ checksums: [0, 0] }))).status).toBe(409);
		expect((await chunk(job.id, bytes)).status).toBe(200);
		expect((await chunk(job.id, bytes)).status).toBe(200);
		expect((await chunk(job.id, Buffer.alloc(5))).status).toBe(409);
		const resumed = await start();
		expect(resumed.id).toBe(job.id);
		expect(resumed.entries[0].offset).toBe(5);
		const complete = await (
			await request(`jobs/${job.id}/finish`, json({ checksums: [fileChunkCrc(bytes), 0] }))
		).json();
		expect(complete.complete).toBe(true);
		expect(await readFile(join(complete.destination, "folder/archive.zip"))).toEqual(bytes);
		expect(await readdir(join(complete.destination, "folder/empty"))).toEqual([]);
		expect((await request(`jobs/${job.id}/finish`, json({ checksums: [] }))).status).toBe(200);
		await request(`jobs/${job.id}`, { method: "DELETE" });
		expect(await readFile(join(complete.destination, "folder/archive.zip"))).toEqual(bytes);
	});
	it("rejects paths, collisions, quotas and unauthorized requests", async () => {
		for (const path of ["../x", "C:/x", "/x", "a//b", "a\\b", "a/CON", "a/.", "a/../b", "x."])
			expect(() => desktopRelativePath(path)).toThrow();
		for (const entries of [
			[
				{ path: "a", size: 0 },
				{ path: "A", size: 0 },
			],
			[
				{ path: "a", size: 0 },
				{ path: "a/b", size: 0 },
			],
			[{ path: "x", size: 17 * 1024 ** 3 }],
		])
			expect((await request("jobs", json({ key: "a".repeat(32), entries }))).ok).toBe(false);
		expect((await fetch(base + "info")).status).toBe(403);
		enabled = false;
		expect((await request("info")).status).toBe(403);
	});
	it("cancels incomplete files without touching previously received files", async () => {
		const job = await start();
		await chunk(job.id, Buffer.from("12"));
		await request(`jobs/${job.id}`, { method: "DELETE" });
		expect((await request(`jobs/${job.id}`)).status).toBe(410);
		expect(await readdir(join(home, "Downloads/pi-web-ui-Received"))).toEqual([]);
	});
	it("refuses a replaced staging file without writing through a hard link", async () => {
		const job = await start();
		const inbox = join(home, "Downloads/pi-web-ui-Received"),
			directory = (await readdir(inbox))[0];
		const path = join(inbox, directory, "folder/archive.zip"),
			original = join(home, "untouched.txt");
		await writeFile(original, "original");
		await unlink(path);
		await link(original, path);
		expect((await chunk(job.id, Buffer.from("12345"))).status).toBe(409);
		expect(await readFile(original, "utf8")).toBe("original");
	});
	it("downloads exact binary bytes and a streamed folder archive", async () => {
		await mkdir(join(home, "nested"));
		await writeFile(join(home, "nested/file.zip"), Buffer.from([80, 75, 0, 255]));
		const listing = await (await request("list?path=nested")).json();
		expect(listing.entries[0].name).toBe("file.zip");
		expect((await request("list?path=../")).status).toBe(400);
		const file = await (await request("downloads", json({ path: "nested/file.zip" }))).json();
		const response = await request("download/" + file.id);
		expect(response.headers.get("content-disposition")).toContain("file.zip");
		expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from([80, 75, 0, 255]));
		const folder = await (await request("downloads", json({ path: "nested" }))).json();
		const archive = Buffer.from(await (await request("download/" + folder.id)).arrayBuffer());
		expect(archive.toString()).toContain("nested/file.zip");
	});
	it("keeps upload/download limits scoped and CRC incremental", () => {
		expect(fileChunkCrc(Buffer.from("123456789"))).toBe(0xcbf43926);
		expect(fileChunkCrc(Buffer.from("6789"), fileChunkCrc(Buffer.from("12345")))).toBe(0xcbf43926);
		expect(desktopDownloadLimit("/api/other")).toBeUndefined();
		expect(desktopDownloadLimit("/api/device-desktop/files/download/" + "a".repeat(32), "POST")).toBeUndefined();
		expect(desktopDownloadLimit("/api/device-desktop/files/download/" + "a".repeat(32))).toBeGreaterThan(
			16 * 1024 ** 3,
		);
	});
});
