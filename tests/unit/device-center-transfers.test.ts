import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { DeviceHubStore } from "../../server/device-center/store.js";
import { installDeviceTransfers } from "../../server/device-center/transfers.js";
import { createDeviceCollabService } from "../../server/device-center/collab-service.js";
import type { createDeviceFileSync } from "../../server/device-center/file-sync.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "device-transfers-"));
	cleanup.push(() => rm(dir, { recursive: true, force: true }));
	const store = await DeviceHubStore.open(dir);
	await store.transact((s) => {
		s.accounts.push({ id: "a", username: "a", passwordHash: "hash", createdAt: 1 });
		for (const id of ["source", "target", "other"])
			s.devices.push({ id, accountId: "a", name: id, credentialHash: "hash", createdAt: 1 });
		for (const [id, deviceId] of [
			["source-bot", "source"],
			["source-sibling", "source"],
			["target-bot", "target"],
			["target-sibling", "target"],
			["other-bot", "other"],
		])
			s.bots.push({
				id,
				deviceId,
				accountId: "a",
				name: id,
				description: "",
				enabled: true,
				revision: 1,
				createdAt: 1,
				updatedAt: 1,
			});
		s.rooms.push({ id: "room", accountId: "a", name: "r", botIds: s.bots.map((b) => b.id), createdAt: 1 });
	});
	let caller = "source";
	const relay = {
		callDevice: vi.fn(async (_id: string, action: string) => {
			if (action === "transfer_stage")
				return {
					id: "local-secret",
					revision: "rev",
					files: [{ path: "x.txt", sha256: "hash", base64: "secret" }],
					base64: "secret",
				};
			return { id: "local-secret", revision: "rev", applied: ["x.txt"] };
		}),
	};
	async function start() {
		const app = express();
		await installDeviceTransfers({
			app,
			store,
			dataDir: dir,
			relay,
			authenticateAgent: async () => {
				const device = store.snapshot().devices.find((d) => d.id === caller);
				return device ? { device, account: { id: "a" } } : undefined;
			},
		});
		app.use(((error: { status?: number }, _req: unknown, res: express.Response, _next: unknown) =>
			res.status(error.status ?? 500).json({ error: "rejected" })) as express.ErrorRequestHandler);
		const server = await new Promise<Server>((resolve) => {
			const s = app.listen(0, "127.0.0.1", () => resolve(s));
		});
		cleanup.push(() => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("No port");
		return async (body: object) =>
			fetch(`http://127.0.0.1:${address.port}/api/agent/transfers`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ roomId: "room", sourceBotId: "source-bot", targetBotId: "target-bot", ...body }),
			});
	}
	return {
		store,
		relay,
		dir,
		start,
		caller: (id: string) => {
			caller = id;
		},
	};
}
describe("device transfer receipts", () => {
	it("projects bounded exclusion metadata through the real remote transfer response without opaque fields", async () => {
		const f = await fixture();
		const post = await f.start();
		const exclusions = Array.from({ length: 150 }, (_, i) => ({
			path: `project/.env${String(i).padStart(3, "0")}${"密".repeat(50)}`,
			reason: "sensitive",
			base64: "OPAQUE_PAYLOAD",
		}));
		f.relay.callDevice.mockResolvedValueOnce({
			id: "local-secret",
			revision: "rev",
			manifest: { version: 1, totalExcluded: 150, exclusions, token: "OPAQUE_PAYLOAD" },
		} as any);
		const response = await post({ action: "stage", bundle: {} });
		expect(response.status).toBe(200);
		const result = await response.json();
		const manifest = result.manifest;
		expect(manifest.totalExcluded).toBe(150);
		expect(manifest.exclusions.length).toBeGreaterThan(0);
		expect(manifest.exclusions.length).toBeLessThanOrEqual(128);
		expect(Buffer.byteLength(JSON.stringify(manifest.exclusions))).toBeLessThanOrEqual(8192);
		expect(manifest.exclusions[0]).toEqual({ path: exclusions[0].path, reason: "sensitive" });
		expect(JSON.stringify(result)).not.toContain("OPAQUE_PAYLOAD");
		f.relay.callDevice.mockResolvedValueOnce({
			revision: "rev",
			totalExcluded: 200,
			exclusions: Array.from({ length: 200 }, (_, i) => ({ path: `tree/.env${i}`, reason: "sensitive" })),
		} as any);
		const preview = await (await post({ action: "preview", transferId: result.transferId })).json();
		expect(preview.exclusions).toHaveLength(128);
		expect(preview.totalExcluded).toBe(200);
		f.relay.callDevice.mockResolvedValueOnce({
			revision: "rev",
			totalExcluded: -1,
			exclusions: [
				{ path: "../bad", reason: "sensitive" },
				{ path: "C:/bad", reason: "sensitive" },
				{ path: "tree/.env", reason: "unknown" },
				{ path: "tree/node_modules", reason: "ignored", token: "OPAQUE_PAYLOAD" },
			],
		} as any);
		const sanitized = await (await post({ action: "preview", transferId: result.transferId })).json();
		expect(sanitized.totalExcluded).toBeUndefined();
		expect(sanitized.exclusions).toEqual([{ path: "tree/node_modules", reason: "ignored" }]);
	});
	it("persists only authorization metadata, returns opaque IDs and restores authorization", async () => {
		const f = await fixture();
		const post = await f.start();
		const response = await post({ action: "stage", bundle: { base64: "PAYLOAD" } });
		expect(response.status).toBe(200);
		const result = await response.json();
		expect(result.transferId).not.toBe("local-secret");
		expect(JSON.stringify(result)).not.toContain("secret");
		const disk = await readFile(join(f.dir, "device-transfers.json"), "utf8");
		expect(disk).not.toContain("PAYLOAD");
		const restored = await f.start();
		expect((await restored({ action: "preview", transferId: result.transferId })).status).toBe(200);
		f.caller("other");
		expect((await restored({ action: "preview", transferId: result.transferId })).status).toBe(403);
		f.caller("source");
		await f.store.transact((s) => {
			s.rooms[0].botIds = ["source-bot"];
		});
		expect((await restored({ action: "preview", transferId: result.transferId })).status).toBe(403);
	});
	it("requires explicit apply and consumes permission before uncertain relay side effects", async () => {
		const f = await fixture();
		const post = await f.start();
		const { transferId } = await (await post({ action: "stage", bundle: {} })).json();
		expect((await post({ action: "apply", transferId, revision: "rev" })).status).toBe(400);
		f.relay.callDevice.mockRejectedValueOnce(new Error("credential secret"));
		const failed = await post({ action: "apply", transferId, revision: "rev", overwritePaths: [] });
		expect(failed.status).toBe(502);
		expect(await failed.text()).not.toContain("secret");
		const restored = await f.start();
		expect((await restored({ action: "apply", transferId, revision: "rev", overwritePaths: [] })).status).toBe(409);
		expect(f.relay.callDevice).toHaveBeenCalledTimes(2);
	});
	it("rechecks membership after relay and passes cancellation to the device", async () => {
		const f = await fixture();
		const post = await f.start();
		f.relay.callDevice.mockImplementationOnce(async () => {
			await f.store.transact((s) => {
				s.rooms[0].botIds = ["source-bot"];
			});
			return { id: "local", revision: "rev", applied: [] };
		});
		expect((await post({ action: "stage", bundle: {} })).status).toBe(403);
		const args = f.relay.callDevice.mock.calls[0] as unknown as [string, string, unknown, { signal: AbortSignal }];
		expect(args[3].signal).toBeInstanceOf(AbortSignal);
		await expect(readFile(join(f.dir, "device-transfers.json"))).rejects.toMatchObject({ code: "ENOENT" });
	});
	it("binds receipts to exact Bots, including siblings sharing a device", async () => {
		const f = await fixture();
		const post = await f.start();
		expect((await post({ action: "stage", sourceBotId: "other-bot", bundle: {} })).status).toBe(403);
		expect(f.relay.callDevice).not.toHaveBeenCalled();
		const { transferId } = await (await post({ action: "stage", bundle: {} })).json();
		for (const identity of [{ sourceBotId: "source-sibling" }, { targetBotId: "target-sibling" }]) {
			expect((await post({ action: "preview", transferId, ...identity })).status).toBe(403);
			expect(
				(await post({ action: "apply", transferId, revision: "rev", overwritePaths: [], ...identity })).status,
			).toBe(403);
		}
		expect(f.relay.callDevice).toHaveBeenCalledTimes(1);
		expect((await post({ action: "preview", transferId })).status).toBe(200);
		await f.store.transact((s) => {
			s.bots.find((b) => b.id === "target-bot")!.revision++;
		});
		expect((await post({ action: "preview", transferId })).status).toBe(403);
		expect(f.relay.callDevice).toHaveBeenCalledTimes(2);
	});
	it("rejects expired and foreign-room receipts", async () => {
		const f = await fixture();
		const post = await f.start();
		const { transferId } = await (await post({ action: "stage", bundle: {} })).json();
		expect((await post({ action: "preview", transferId, roomId: "different" })).status).toBe(403);
		const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 25 * 3600000);
		try {
			expect((await post({ action: "preview", transferId })).status).toBe(403);
		} finally {
			now.mockRestore();
		}
	});
});
describe("device collaboration service", () => {
	it("uses trusted parent, fixed root, credentials, cancellation and never retries", async () => {
		const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ id: "task" })));
		const service = createDeviceCollabService({
			root: process.cwd(),
			files: {} as ReturnType<typeof createDeviceFileSync>,
			getConfig: () => ({
				hubUrl: "http://localhost:9000",
				deviceId: "source",
				credential: "SECRET",
				allowExecution: true,
			}),
			getParentTask: () => "trusted",
			fetch: request,
		});
		const signal = new AbortController().signal;
		await service.execute(
			"send_task",
			{ roomId: "room", sourceBotId: "source-bot", targetBotId: "target-bot", prompt: "work", parentTaskId: "trusted" },
			signal,
			{ cwd: process.cwd(), sessionId: "s" },
		);
		await expect(
			service.execute(
				"send_task",
				{
					roomId: "room",
					sourceBotId: "source-bot",
					targetBotId: "target-bot",
					prompt: "work",
					parentTaskId: "forged",
				},
				signal,
				{ cwd: process.cwd(), sessionId: "s" },
			),
		).rejects.toThrow("Device collaboration request failed.");
		expect(request).toHaveBeenCalledTimes(1);
		const init = request.mock.calls[0][1]!;
		expect(JSON.parse(init.body as string)).toMatchObject({
			parentTaskId: "trusted",
			sourceBotId: "source-bot",
			targetBotIds: ["target-bot"],
		});
		expect(String(request.mock.calls[0][0])).toContain("/api/agent/rooms/room/messages");
		expect(init.signal).toBe(signal);
		expect(init.redirect).toBe("error");
		expect(init.headers).toMatchObject({ authorization: "Bearer SECRET", "X-Device-Id": "source" });
		await expect(service.execute("list_rooms", {}, signal, { cwd: join(process.cwd(), "other") })).rejects.toThrow(
			"Device collaboration request failed.",
		);
		request.mockRejectedValueOnce(new Error("SECRET"));
		await expect(service.execute("list_rooms", {}, signal, { cwd: process.cwd() })).rejects.toThrow(
			"Device collaboration request failed.",
		);
		expect(request).toHaveBeenCalledTimes(2);
	});
	it("blocks writes with execution disabled and strips bundle data from stage reports", async () => {
		let enabled = false;
		const prepare = vi.fn().mockResolvedValue({
			manifest: { version: 1, files: [{ path: "x", sha256: "hash", size: 1 }], totalBytes: 1 },
			files: [{ path: "x", base64: "SECRET" }],
		});
		const request = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(
				JSON.stringify({
					transferId: "opaque",
					base64: "SECRET",
					files: [{ path: "x", sha256: "hash", base64: "SECRET" }],
				}),
			),
		);
		const service = createDeviceCollabService({
			root: process.cwd(),
			files: { prepare } as unknown as ReturnType<typeof createDeviceFileSync>,
			getConfig: () => ({
				hubUrl: "http://localhost:9000",
				deviceId: "source",
				credential: "SECRET",
				allowExecution: enabled,
			}),
			fetch: request,
		});
		const args = { roomId: "room", sourceBotId: "source-bot", targetBotId: "target-bot", paths: ["x"] };
		await expect(service.execute("sync_files", args, undefined, { cwd: process.cwd() })).rejects.toThrow();
		expect(prepare).not.toHaveBeenCalled();
		enabled = true;
		const result = await service.execute("sync_files", args, undefined, { cwd: process.cwd() });
		expect(result).toMatchObject({ transferId: "opaque", files: [{ path: "x", sha256: "hash" }] });
		expect(JSON.stringify(result)).not.toContain("SECRET");
	});

	it("supports chunked transfer endpoints (init, chunk, status, abort) and truncated summary", async () => {
		const env = await fixture();
		const post = await env.start();
		const uuid = "33333333-4444-4555-8666-777777777777";

		env.relay.callDevice.mockImplementation(async (_id: string, action: string): Promise<any> => {
			if (action === "transfer_init") {
				return {
					transferId: uuid,
					status: "staging",
					totalBytes: 1000,
					totalChunks: 2,
					receivedChunks: [],
				};
			}
			if (action === "transfer_chunk") {
				return {
					transferId: uuid,
					status: "staging",
					chunkIndex: 0,
					received: true,
					percent: 50,
					receivedChunks: [0],
				};
			}
			if (action === "transfer_status") {
				return {
					transferId: uuid,
					status: "staging",
					receivedChunks: [0],
					totalChunks: 2,
					percent: 50,
				};
			}
			if (action === "transfer_abort") {
				return { ok: true, status: "cancelled" };
			}
			return { id: uuid };
		});

		// 1. init
		const initRes = await post({
			action: "init",
			manifest: {
				version: 2,
				transferId: uuid,
				totalBytes: 1000,
				totalFiles: 1,
				totalChunks: 2,
				chunkSize: 500,
				files: [{ path: "f.txt", size: 1000, sha256: "0".repeat(64), offset: 0, chunkCount: 2, firstChunkIndex: 0 }],
				manifestHash: "0".repeat(64),
			},
		});
		expect(initRes.status).toBe(200);
		const initData = (await initRes.json()) as any;
		expect(initData.status).toBe("staging");
		const transferId = initData.transferId;
		expect(typeof transferId).toBe("string");

		// 2. chunk
		const chunkRes = await post({
			action: "chunk",
			transferId,
			chunk: {
				transferId: uuid,
				chunkIndex: 0,
				path: "f.txt",
				offset: 0,
				size: 500,
				sha256: "0".repeat(64),
				data: Buffer.alloc(500).toString("base64"),
			},
		});
		expect(chunkRes.status).toBe(200);
		const chunkData = (await chunkRes.json()) as any;
		expect(chunkData.chunkIndex).toBe(0);
		expect(chunkData.percent).toBe(50);

		// 3. status
		const statusRes = await post({
			action: "status",
			transferId,
		});
		expect(statusRes.status).toBe(200);
		const statusData = (await statusRes.json()) as any;
		expect(statusData.status).toBe("staging");
		expect(statusData.receivedChunks).toEqual([0]);

		// 4. abort
		const abortRes = await post({
			action: "abort",
			transferId,
		});
		expect(abortRes.status).toBe(200);
		const abortData = (await abortRes.json()) as any;
		expect(abortData.status).toBe("cancelled");
	});
});
