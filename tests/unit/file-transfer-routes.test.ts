import express from "express";
import { createServer, request, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { registerFileTransferRoutes } from "../../server/file-transfer-routes.js";

const cleanup: { server: Server; root: string }[] = [];
async function fixture(limit?: number) {
	const root = await mkdtemp(join(tmpdir(), "pi-transfer-http-"));
	const temporary = join(root, "temporary");
	await mkdir(temporary);
	await writeFile(join(root, "a.txt"), "archive me");
	const app = express();
	app.use(express.json());
	registerFileTransferRoutes(
		app,
		(id) => (id === "test-client" ? root : undefined),
		temporary,
		limit === undefined
			? undefined
			: (clientId) => {
					expect(clientId).toBe("test-client");
					return limit;
				},
	);
	const server = createServer(app);
	await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
	cleanup.push({ server, root });
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing test address");
	const url = `http://127.0.0.1:${address.port}/api/file-transfer`;
	function archive(action: string, path = "a.txt", headers: Record<string, string> = { "X-File-Operation": "1" }) {
		return fetch(`${url}/archive?clientId=test-client`, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...headers },
			body: JSON.stringify({ action, path }),
		});
	}
	function upload(name: string, body = "hello") {
		return fetch(`${url}/upload?${new URLSearchParams({ clientId: "test-client", dir: "", name })}`, {
			method: "POST",
			headers: { "Content-Type": "application/octet-stream", "X-File-Operation": "1" },
			body,
		});
	}
	return { root, temporary, url, archive, upload };
}
afterEach(async () => {
	for (const { server, root } of cleanup.splice(0)) {
		server.closeAllConnections();
		await new Promise<void>((ok, fail) => server.close((err) => (err ? fail(err) : ok())));
		await rm(root, { recursive: true, force: true });
	}
});

describe("file transfer HTTP routes", () => {
	it("requires explicit operation header and a connected client", async () => {
		const f = await fixture();
		expect((await f.archive("compress", "a.txt", {})).status).toBe(403);
		const unknown = await fetch(`${f.url}/archive?clientId=unknown`, {
			method: "POST",
			headers: { "X-File-Operation": "1", "Content-Type": "application/json" },
			body: JSON.stringify({ action: "compress", path: "a.txt" }),
		});
		expect(unknown.status).toBe(400);
		expect((await f.archive("compress", "../outside")).status).toBe(400);
	});
	it("uploads folder hierarchy, including empty files, without overwriting conflicts", async () => {
		const f = await fixture();
		expect((await f.upload("folder/nested/中文.txt")).status).toBe(200);
		expect((await f.upload("folder/empty.txt", "")).status).toBe(200);
		expect(await readFile(join(f.root, "folder/nested/中文.txt"), "utf8")).toBe("hello");
		expect((await f.upload("folder/nested/中文.txt", "replace")).status).toBe(409);
		expect(await readFile(join(f.root, "folder/nested/中文.txt"), "utf8")).toBe("hello");
		expect((await f.upload("../escape")).status).toBe(400);
		expect((await f.upload("C:/escape")).status).toBe(400);
	});
	it("rejects invalid clients, paths, types and declared sizes before receiving the body", async () => {
		const f = await fixture();
		for (const [query, type, size, status] of [
			["clientId=unknown&dir=&name=a", "application/octet-stream", 1, 400],
			["clientId=test-client&dir=&name=../escape", "application/octet-stream", 1, 400],
			["clientId=test-client&dir=../escape&name=a", "application/octet-stream", 1, 400],
			["clientId=test-client&dir=&name=a", "text/plain", 1, 400],
			["clientId=test-client&dir=&name=a", "application/octet-stream", 32 * 1024 * 1024 + 1, 413],
		] as const) {
			const response = await new Promise<number>((ok, fail) => {
				const req = request(
					`${f.url}/upload?${query}`,
					{
						method: "POST",
						headers: {
							"X-File-Operation": "1",
							"Content-Type": type,
							"Content-Length": size,
						},
					},
					(res) => {
						res.resume();
						ok(res.statusCode!);
						req.destroy();
					},
				);
				req.on("error", fail);
				req.flushHeaders();
			});
			expect(response).toBe(status);
		}
	});
	it.each([false, true])(
		"enforces a custom upload byte limit (chunked: %s) without leaving residue",
		async (chunked) => {
			const f = await fixture(8);
			async function upload(name: string, body: string) {
				if (!chunked) return (await f.upload(name, body)).status;
				return new Promise<number>((ok, fail) => {
					const req = request(
						`${f.url}/upload?clientId=test-client&dir=&name=${name}`,
						{
							method: "POST",
							headers: {
								"X-File-Operation": "1",
								"Content-Type": "application/octet-stream",
								"Transfer-Encoding": "chunked",
							},
						},
						(res) => {
							res.resume();
							res.on("end", () => ok(res.statusCode!));
						},
					);
					req.on("error", fail);
					req.end(body);
				});
			}
			expect(await upload("too-large.txt", "ééééx")).toBe(413);
			await expect.poll(() => readdir(f.root)).toEqual(["a.txt", "temporary"]);
			expect(await upload("at-limit.txt", "éééé")).toBe(200);
			expect(await readFile(join(f.root, "at-limit.txt"))).toEqual(Buffer.from("éééé"));
			expect(await upload("empty.txt", "")).toBe(200);
			expect(await readFile(join(f.root, "empty.txt"))).toHaveLength(0);
			await expect
				.poll(async () => (await readdir(f.root)).sort())
				.toEqual(["a.txt", "at-limit.txt", "empty.txt", "temporary"]);
			expect(await readdir(f.temporary)).toEqual([]);
		},
	);
	it("bounds chunked in-flight bytes and releases reservations after disconnect", async () => {
		const f = await fixture(100 * 1024 * 1024);
		const pending = (name: string) => {
			const req = request(`${f.url}/upload?clientId=test-client&dir=&name=${name}`, {
				method: "POST",
				headers: { "X-File-Operation": "1", "Content-Type": "application/octet-stream" },
			});
			req.on("error", () => {});
			req.write("partial");
			return req;
		};
		const a = pending("a.bin");
		const b = pending("b.bin");
		try {
			await expect.poll(async () => (await readdir(f.root)).filter((n) => n.startsWith(".pi-upload-")).length).toBe(2);
			expect(await readdir(f.root)).not.toContain("a.bin");
			const rejected = await fetch(`${f.url}/upload?clientId=test-client&dir=&name=c.bin`, {
				method: "POST",
				headers: { "X-File-Operation": "1", "Content-Type": "application/octet-stream", "Content-Length": "1" },
				body: "x",
			});
			expect(rejected.status).toBe(429);
		} finally {
			a.destroy();
			b.destroy();
		}
		await expect.poll(async () => (await readdir(f.root)).filter((n) => n.startsWith(".pi-upload-"))).toEqual([]);
		expect((await f.upload("after.bin")).status).toBe(200);
		expect(await readdir(f.root)).not.toContain("a.bin");
		expect(await readdir(f.root)).not.toContain("b.bin");
	});
	it("limits concurrent uploads even when their reserved bytes are small", async () => {
		const f = await fixture();
		const requests = Array.from({ length: 4 }, (_, i) => {
			const req = request(`${f.url}/upload?clientId=test-client&dir=&name=pending-${i}`, {
				method: "POST",
				headers: {
					"X-File-Operation": "1",
					"Content-Type": "application/octet-stream",
					"Content-Length": "2",
				},
			});
			req.on("error", () => {});
			req.write("x");
			return req;
		});
		try {
			await expect.poll(async () => (await readdir(f.root)).filter((n) => n.startsWith(".pi-upload-")).length).toBe(4);
			expect((await f.upload("fifth")).status).toBe(429);
		} finally {
			for (const req of requests) req.destroy();
		}
		await expect.poll(async () => (await readdir(f.root)).filter((n) => n.startsWith(".pi-upload-"))).toEqual([]);
		expect((await f.upload("released")).status).toBe(200);
	});
	it("rejects an oversized chunked body and cleans its staging file", async () => {
		const f = await fixture();
		const status = await new Promise<number>((ok, fail) => {
			const req = request(
				`${f.url}/upload?clientId=test-client&dir=&name=large.bin`,
				{
					method: "POST",
					headers: {
						"X-File-Operation": "1",
						"Content-Type": "application/octet-stream",
					},
				},
				(res) => {
					res.resume();
					ok(res.statusCode!);
					req.destroy();
				},
			);
			req.on("error", fail);
			const chunk = Buffer.alloc(1024 * 1024);
			let sent = 0;
			const send = () => {
				while (sent < 33) {
					sent++;
					if (!req.write(chunk)) {
						req.once("drain", send);
						return;
					}
				}
				req.end();
			};
			send();
		});
		expect(status).toBe(413);
		await expect
			.poll(async () => (await readdir(f.root)).filter((n) => n.startsWith(".pi-upload-") || n === "large.bin"))
			.toEqual([]);
		expect((await f.upload("next.bin")).status).toBe(200);
	});
	it("publishes only one winner for concurrent same-name uploads", async () => {
		const f = await fixture();
		const responses = await Promise.all([f.upload("race.txt", "first"), f.upload("race.txt", "second")]);
		expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
		expect(["first", "second"]).toContain(await readFile(join(f.root, "race.txt"), "utf8"));
		await expect.poll(async () => (await readdir(f.root)).filter((n) => n.startsWith(".pi-upload-"))).toEqual([]);
	});
	it("downloads a temporary archive and deletes it after sending", async () => {
		const f = await fixture();
		const res = await f.archive("download");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-disposition")).toContain("a.txt.tar.gz");
		const bytes = Buffer.from(await res.arrayBuffer());
		expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
		await expect.poll(() => readdir(f.temporary)).toEqual([]);
		await expect(readFile(join(f.root, "a.txt.tar.gz"))).rejects.toThrow();
	});
	it("cleans temporary archives when the download is disconnected", async () => {
		const f = await fixture();
		await writeFile(join(f.root, "a.txt"), randomBytes(4 * 1024 * 1024));
		const res = await f.archive("download");
		expect(res.status).toBe(200);
		await res.body?.cancel();
		await expect.poll(() => readdir(f.temporary), { timeout: 5000 }).toEqual([]);
	});
	it("cleans temporary archives on failure", async () => {
		const f = await fixture();
		expect((await f.archive("download", "missing")).status).toBe(400);
		await expect.poll(() => readdir(f.temporary)).toEqual([]);
	});
	it("compresses alongside the source without overwriting it", async () => {
		const f = await fixture();
		expect((await f.archive("compress")).status).toBe(200);
		expect(await readdir(f.root)).toContain("a.txt.tar.gz");
		await expect.poll(async () => (await f.archive("compress")).status).toBe(400);
		expect(await readFile(join(f.root, "a.txt"), "utf8")).toBe("archive me");
	});
});
