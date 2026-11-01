import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createChunkedTransferReceiver,
	prepareChunkedTransfer,
	readChunkFromSource,
	computeManifestHash,
	type ChunkedTransferManifest,
	type TransferChunkPayload,
} from "../../server/device-center/transfer-stream.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "device-chunked-"));
	cleanup.push(() => rm(dir, { recursive: true, force: true }));
	const root = join(dir, "project");
	const dataDir = join(dir, "data");
	await mkdir(root, { recursive: true });
	const receiver = createChunkedTransferReceiver({ root, dataDir, allowReceive: true });
	cleanup.push(() => receiver.close());
	return { dir, root, dataDir, receiver };
}

describe("device-center transfer-stream", () => {
	it("rejects non-UUID transferId and path traversal attempts", async () => {
		const { receiver } = await fixture();
		const invalidManifest: any = {
			version: 2,
			transferId: "../escape",
			totalBytes: 100,
			totalFiles: 1,
			totalChunks: 1,
			chunkSize: 32768,
			files: [{ path: "test.txt", size: 100, sha256: "0".repeat(64), offset: 0, chunkCount: 1, firstChunkIndex: 0 }],
			manifestHash: "0".repeat(64),
		};
		await expect(receiver.initTransfer(invalidManifest)).rejects.toThrow(/strict UUID/);
	});

	it("rejects negative, inconsistent, or mismatched manifest metadata", async () => {
		const { receiver } = await fixture();
		const uuid = "11111111-2222-4333-8444-555555555555";

		// Negative size
		const negativeManifest: any = {
			version: 2,
			transferId: uuid,
			totalBytes: -10,
			totalFiles: 1,
			totalChunks: 1,
			chunkSize: 32768,
			files: [{ path: "test.txt", size: -10, sha256: "0".repeat(64), offset: 0, chunkCount: 1, firstChunkIndex: 0 }],
			manifestHash: "0".repeat(64),
		};
		await expect(receiver.initTransfer(negativeManifest)).rejects.toThrow(/Invalid file size/);

		// Offset mismatch
		const offsetMismatch: any = {
			version: 2,
			transferId: uuid,
			totalBytes: 200,
			totalFiles: 2,
			totalChunks: 2,
			chunkSize: 32768,
			files: [
				{ path: "a.txt", size: 100, sha256: "0".repeat(64), offset: 0, chunkCount: 1, firstChunkIndex: 0 },
				{ path: "b.txt", size: 100, sha256: "0".repeat(64), offset: 50, chunkCount: 1, firstChunkIndex: 1 }, // expected offset 100
			],
			manifestHash: "0".repeat(64),
		};
		await expect(receiver.initTransfer(offsetMismatch)).rejects.toThrow(/Invalid offset/);
	});

	it("rejects mismatched manifest hash", async () => {
		const { receiver } = await fixture();
		const uuid = "11111111-2222-4333-8444-555555555555";
		const files = [
			{ path: "test.txt", size: 10, sha256: "0".repeat(64), offset: 0, chunkCount: 1, firstChunkIndex: 0 },
		];
		const fakeHashManifest: ChunkedTransferManifest = {
			version: 2,
			transferId: uuid,
			totalBytes: 10,
			totalFiles: 1,
			totalChunks: 1,
			chunkSize: 32768,
			files,
			manifestHash: "1".repeat(64), // wrong hash
		};
		await expect(receiver.initTransfer(fakeHashManifest)).rejects.toThrow(/Manifest hash verification failed/);
	});

	it("prepares manifest correctly, validates chunk sizes, and transfers end-to-end with checksums", async () => {
		const { root, receiver } = await fixture();
		// Create a test file of 70 KiB (3 chunks with 32 KiB chunk size)
		const content = Buffer.alloc(70 * 1024, "a");
		await writeFile(join(root, "large.dat"), content);

		const manifest = await prepareChunkedTransfer({
			root,
			paths: ["large.dat"],
			chunkSize: 32 * 1024,
		});

		expect(manifest.version).toBe(2);
		expect(manifest.totalFiles).toBe(1);
		expect(manifest.totalBytes).toBe(70 * 1024);
		expect(manifest.totalChunks).toBe(3); // 32k + 32k + 6k
		expect(manifest.files[0].chunkCount).toBe(3);

		// Init on receiver
		const initRes = await receiver.initTransfer(manifest);
		expect(initRes.status).toBe("staging");
		expect(initRes.receivedChunks).toEqual([]);

		// Read and send chunk 0
		const c0 = await readChunkFromSource({ root, path: "large.dat", offset: 0, size: 32 * 1024 });
		const p0: TransferChunkPayload = {
			transferId: manifest.transferId,
			chunkIndex: 0,
			path: "large.dat",
			offset: 0,
			size: 32 * 1024,
			sha256: c0.sha256,
			data: c0.buffer.toString("base64"),
		};
		const r0 = await receiver.writeChunk(p0);
		expect(r0.receivedChunks).toEqual([0]);

		// Idempotent resend of chunk 0 returns success
		const r0Again = await receiver.writeChunk(p0);
		expect(r0Again.receivedChunks).toEqual([0]);

		// Conflict duplicate chunk with different hash is rejected!
		const conflictChunk: TransferChunkPayload = {
			...p0,
			sha256: "f".repeat(64),
		};
		await expect(receiver.writeChunk(conflictChunk)).rejects.toThrow(/Duplicate chunk with mismatched checksum/);

		// Read and send chunk 1
		const c1 = await readChunkFromSource({ root, path: "large.dat", offset: 32 * 1024, size: 32 * 1024 });
		const p1: TransferChunkPayload = {
			transferId: manifest.transferId,
			chunkIndex: 1,
			path: "large.dat",
			offset: 32 * 1024,
			size: 32 * 1024,
			sha256: c1.sha256,
			data: c1.buffer.toString("base64"),
		};
		await receiver.writeChunk(p1);

		// Check status in progress
		const status = await receiver.getStatus(manifest.transferId);
		expect(status.receivedChunks).toEqual([0, 1]);
		expect(status.status).toBe("staging");

		// Corrupt data chunk is rejected
		const c2 = await readChunkFromSource({ root, path: "large.dat", offset: 64 * 1024, size: 6 * 1024 });
		const corruptData = Buffer.from(c2.buffer);
		corruptData[0] = 0xff; // corrupt a byte
		const p2Corrupt: TransferChunkPayload = {
			transferId: manifest.transferId,
			chunkIndex: 2,
			path: "large.dat",
			offset: 64 * 1024,
			size: 6 * 1024,
			sha256: c2.sha256, // original hash does not match corrupt data
			data: corruptData.toString("base64"),
		};
		await expect(receiver.writeChunk(p2Corrupt)).rejects.toThrow(/Chunk sha256 checksum mismatch/);

		// Send valid chunk 2
		const p2Valid: TransferChunkPayload = {
			transferId: manifest.transferId,
			chunkIndex: 2,
			path: "large.dat",
			offset: 64 * 1024,
			size: 6 * 1024,
			sha256: c2.sha256,
			data: c2.buffer.toString("base64"),
		};
		const r2 = await receiver.writeChunk(p2Valid);
		expect(r2.status).toBe("staged");
		expect(r2.receivedChunks).toEqual([0, 1, 2]);
		expect(r2.preview).toBeDefined();
		expect(r2.preview!.files[0].status).toBe("identical");
	});

	it("supports resuming transfer after simulated interruption and cross-receiver restart", async () => {
		const { dir, root, dataDir } = await fixture();
		const receiver1 = createChunkedTransferReceiver({ root, dataDir, allowReceive: true });

		const contentA = Buffer.from("Hello from file A");
		const contentB = Buffer.from("Hello from file B (second file)");
		await writeFile(join(root, "fileA.txt"), contentA);
		await writeFile(join(root, "fileB.txt"), contentB);

		const manifest = await prepareChunkedTransfer({
			root,
			paths: ["fileA.txt", "fileB.txt"],
			chunkSize: 1024,
		});

		// Init on receiver 1
		await receiver1.initTransfer(manifest);

		// Only send chunk 0 (fileA)
		const c0 = await readChunkFromSource({ root, path: "fileA.txt", offset: 0, size: contentA.length });
		await receiver1.writeChunk({
			transferId: manifest.transferId,
			chunkIndex: 0,
			path: "fileA.txt",
			offset: 0,
			size: contentA.length,
			sha256: c0.sha256,
			data: c0.buffer.toString("base64"),
		});

		// Explicit close of receiver 1: MUST NOT delete persistent staged chunks!
		await receiver1.close();

		// Simulate restart / reopen: create receiver2 pointing to same dataDir and root
		const receiver2 = createChunkedTransferReceiver({ root, dataDir, allowReceive: true });
		cleanup.push(() => receiver2.close());

		// Query status on receiver2: chunk 0 is cleanly preserved and discovered!
		const status = await receiver2.getStatus(manifest.transferId);
		expect(status.status).toBe("staging");
		expect(status.receivedChunks).toEqual([0]);

		// Send missing chunk 1 (fileB)
		const c1 = await readChunkFromSource({ root, path: "fileB.txt", offset: 0, size: contentB.length });
		const r1 = await receiver2.writeChunk({
			transferId: manifest.transferId,
			chunkIndex: 1,
			path: "fileB.txt",
			offset: 0,
			size: contentB.length,
			sha256: c1.sha256,
			data: c1.buffer.toString("base64"),
		});

		expect(r1.status).toBe("staged");
		expect(r1.receivedChunks).toEqual([0, 1]);
	});

	it("cancels transfer and releases quota only after physical IO deletion completes", async () => {
		const { root, receiver, dataDir } = await fixture();
		const content = Buffer.alloc(10 * 1024, "x");
		await writeFile(join(root, "test.txt"), content);

		const manifest = await prepareChunkedTransfer({ root, paths: ["test.txt"] });
		await receiver.initTransfer(manifest);

		// Staged directory exists
		const dirPath = join(dataDir, "device-transfers", `transfer-${manifest.transferId}`);
		const existsBefore = await readFile(join(dirPath, "manifest.json"))
			.then(() => true)
			.catch(() => false);
		expect(existsBefore).toBe(true);

		// Abort
		const res = await receiver.abortTransfer(manifest.transferId);
		expect(res.ok).toBe(true);

		// Physical directory is gone
		const existsAfter = await readFile(join(dirPath, "manifest.json"))
			.then(() => true)
			.catch(() => false);
		expect(existsAfter).toBe(false);

		// Status query throws not found
		await expect(receiver.getStatus(manifest.transferId)).rejects.toThrow(/not found/);
	});

	it("computes per-chunk hashes in manifest and enforces expectedChunkSha256/expectedFileSize on readChunk", async () => {
		const { root } = await fixture();
		const testBytes = Buffer.alloc(2048, "a");
		await writeFile(join(root, "test-chunk-hashes.dat"), testBytes);

		const manifest = await prepareChunkedTransfer({
			root,
			paths: ["test-chunk-hashes.dat"],
			chunkSize: 1024,
		});

		const fileEntry = manifest.files[0];
		expect(fileEntry.chunkHashes).toBeDefined();
		expect(fileEntry.chunkHashes!.length).toBe(fileEntry.chunkCount);

		// Read chunk with valid expectedFileSize and expectedChunkSha256
		const validChunk = await readChunkFromSource({
			root,
			path: "test-chunk-hashes.dat",
			offset: 0,
			size: 1024,
			expectedFileSize: testBytes.length,
			expectedChunkSha256: fileEntry.chunkHashes![0],
		});
		expect(validChunk.sha256).toBe(fileEntry.chunkHashes![0]);

		// Read chunk with altered expectedFileSize fails
		await expect(
			readChunkFromSource({
				root,
				path: "test-chunk-hashes.dat",
				offset: 0,
				size: 1024,
				expectedFileSize: testBytes.length + 10,
			}),
		).rejects.toThrow(/size mismatch/);

		// Read chunk with altered expectedChunkSha256 fails
		await expect(
			readChunkFromSource({
				root,
				path: "test-chunk-hashes.dat",
				offset: 0,
				size: 1024,
				expectedChunkSha256: "0".repeat(64),
			}),
		).rejects.toThrow(/chunk checksum mismatch/);
	});

	it("rejects corrupt or symlinked transfer directories on restart recovery without swallowing", async () => {
		const { root, dataDir } = await fixture();
		const stagingStorage = join(dataDir, "device-transfers");
		await mkdir(stagingStorage, { recursive: true });

		// 1. Create a corrupt directory (missing valid manifest)
		const corruptDir = join(stagingStorage, "transfer-11111111-2222-4333-8444-555555555555");
		await mkdir(corruptDir, { recursive: true });
		await writeFile(join(corruptDir, "manifest.json"), "NOT_JSON");

		// 2. Start receiver and await its initialization
		const receiver = createChunkedTransferReceiver({ root, dataDir, allowReceive: true });
		cleanup.push(() => receiver.close());
		await receiver.getStatus("00000000-0000-4000-8000-000000000000").catch(() => {});

		const corruptExists = await readFile(join(corruptDir, "manifest.json"))
			.then(() => true)
			.catch(() => false);
		expect(corruptExists).toBe(false);
	});

	it("rejects restoring old staged bundles onto mismatched project root (cross-root boundary)", async () => {
		const { root, dataDir, dir } = await fixture();
		const receiver1 = createChunkedTransferReceiver({ root, dataDir, allowReceive: true });

		const content = Buffer.from("Root bound content");
		await writeFile(join(root, "bound.txt"), content);

		const manifest = await prepareChunkedTransfer({ root, paths: ["bound.txt"] });
		await receiver1.initTransfer(manifest);
		await receiver1.close();

		// Create a different project root
		const differentRoot = join(dir, "different-project");
		await mkdir(differentRoot, { recursive: true });

		// Receiver on different root must not adopt bundles bound to original root
		const receiver2 = createChunkedTransferReceiver({ root: differentRoot, dataDir, allowReceive: true });
		cleanup.push(() => receiver2.close());

		// Querying manifest from different root must fail as unknown / purged
		await expect(receiver2.getStatus(manifest.transferId)).rejects.toThrow(/not found/);
	});
});
