// Real cross-device chunked file transfer, resume, checksum, >8MiB and 128+ files test
// executed across real WebSocket RPC connections and genuine DeviceRuntime instances.
// Run: node --import tsx tests/device-center-chunked-transfer-test.mjs
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import WebSocket from "ws";
import { DeviceHubStore, hashSecret } from "../server/device-center/store.ts";
import { createDeviceRelay, createCommandChannel, parseFrame } from "../server/device-center/relay.ts";
import { installDeviceTransfers } from "../server/device-center/transfers.ts";
import { createDeviceRuntime } from "../server/device-center/runtime.ts";
import { createLocalBotRegistry } from "../server/device-center/bots.ts";
import { createDeviceFileSync } from "../server/device-center/file-sync.ts";

const cleanup = [];
async function cleanAll() {
	for (const fn of cleanup.splice(0).reverse()) {
		try {
			await fn();
		} catch {}
	}
}

process.on("exit", () => {
	for (const fn of cleanup.splice(0).reverse()) {
		try {
			fn();
		} catch {}
	}
});

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

async function run() {
	console.log("=== Starting Chunked Transfer Real Runtime + WebSocket RPC Integration Test ===");
	const tempDir = await mkdtemp(join(tmpdir(), "chunked-transfer-rpc-"));
	cleanup.push(() => rm(tempDir, { recursive: true, force: true }));

	const hubDataDir = join(tempDir, "hub-data");
	const rootA = join(tempDir, "deviceA-project");
	const dataDirA = join(tempDir, "deviceA-data");
	const rootB = join(tempDir, "deviceB-project");
	const dataDirB = join(tempDir, "deviceB-data");

	await mkdir(hubDataDir, { recursive: true });
	await mkdir(rootA, { recursive: true });
	await mkdir(dataDirA, { recursive: true });
	await mkdir(rootB, { recursive: true });
	await mkdir(dataDirB, { recursive: true });

	// Local Bot Registries for Device A and Device B
	const botsA = await createLocalBotRegistry(dataDirA);
	const createdBotA = await botsA.upsert({
		name: "Bot A",
		description: "Real source bot",
		systemPrompt: "",
		cwd: rootA,
		enabled: true,
		tools: [],
		skills: [],
		mcpServers: [],
	});
	const botIdA = createdBotA.id;

	const botsB = await createLocalBotRegistry(dataDirB);
	const createdBotB = await botsB.upsert({
		name: "Bot B",
		description: "Real target bot",
		systemPrompt: "",
		cwd: rootB,
		enabled: true,
		tools: [],
		skills: [],
		mcpServers: [],
	});
	const botIdB = createdBotB.id;

	// Hub Store setup
	const store = await DeviceHubStore.open(hubDataDir);
	const accountId = "test-account";
	const deviceIdA = "device-a";
	const deviceIdB = "device-b";
	const credA = "secret-token-device-a";
	const credB = "secret-token-device-b";
	const roomId = "room-collab";

	await store.transact((s) => {
		s.accounts.push({ id: accountId, username: "user", passwordHash: "h", createdAt: 1 });
		s.devices.push({ id: deviceIdA, accountId, name: "Device A", credentialHash: hashSecret(credA), createdAt: 1 });
		s.devices.push({ id: deviceIdB, accountId, name: "Device B", credentialHash: hashSecret(credB), createdAt: 1 });
		s.bots.push({
			id: botIdA,
			deviceId: deviceIdA,
			accountId,
			name: "Bot A",
			description: "",
			enabled: true,
			revision: createdBotA.revision,
			createdAt: 1,
			updatedAt: 1,
		});
		s.bots.push({
			id: botIdB,
			deviceId: deviceIdB,
			accountId,
			name: "Bot B",
			description: "",
			enabled: true,
			revision: createdBotB.revision,
			createdAt: 1,
			updatedAt: 1,
		});
		s.rooms.push({
			id: roomId,
			accountId,
			name: "Test Collab Room",
			botIds: [botIdA, botIdB],
			createdAt: 1,
		});
	});

	// Hub HTTP & WebSocket Server Setup
	const app = express();
	app.use(express.json());
	const server = createServer(app);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanup.push(() => new Promise((resolve) => server.close(resolve)));

	const hubPort = server.address().port;
	const hubUrl = `http://127.0.0.1:${hubPort}`;

	// Real Device Relay with WebSocket handling
	const relay = createDeviceRelay({
		server,
		publicUrl: hubUrl,
		getAccount: async () => ({ id: accountId, username: "user" }),
		authenticateDevice: async (id, token) => store.authenticateDevice(id, token),
		ownsDevice: (owner, id) => store.getDeviceOwner(id) === owner,
		getDeviceName: (id) => store.getDevice(id)?.name,
		onTaskProgress: () => {},
		onTaskInteractions: () => {},
		onTaskEvent: async () => {},
		onTaskClaim: async () => ({ accepted: false }),
		onTaskLeaseRenew: async () => ({ accepted: false }),
	});
	cleanup.push(() => relay.close());

	// Install transfers routes on Hub
	await installDeviceTransfers({
		app,
		store,
		dataDir: hubDataDir,
		relay,
		authenticateAgent: async (req) => {
			const did = req.headers["x-device-id"];
			const auth = req.headers.authorization?.slice(7);
			if (did && auth && (await store.authenticateDevice(did, auth))) {
				const d = store.snapshot().devices.find((item) => item.id === did);
				return d ? { device: d, account: { id: accountId } } : undefined;
			}
			return undefined;
		},
		getAccount: () => ({ id: accountId }),
	});

	// Set up Device A Genuine Runtime
	const runtimeA = createDeviceRuntime({
		config: {
			deviceId: deviceIdA,
			hubUrl,
			credential: credA,
			uiCredential: "ui-a",
			name: "Device A",
			allowExecution: true,
		},
		localOrigin: `http://127.0.0.1:${hubPort}`,
		dataDir: dataDirA,
		bots: botsA,
	});
	cleanup.push(() => runtimeA.close());

	// Connect Device A WebSocket to Hub Relay
	console.log("Connecting genuine Device A WebSocket to Hub Relay...");
	const wsUrlA = `ws://127.0.0.1:${hubPort}/device-connect?deviceId=${deviceIdA}`;
	const wsA = new WebSocket(wsUrlA, {
		headers: {
			Authorization: `Bearer ${credA}`,
			Host: `127.0.0.1:${hubPort}`,
		},
	});
	cleanup.push(() => wsA.terminate());
	await new Promise((resolve, reject) => {
		wsA.once("open", resolve);
		wsA.once("error", reject);
	});
	const rpcA = createCommandChannel(wsA, runtimeA.onCommand);
	wsA.on("message", (raw) => {
		try {
			const frame = parseFrame(Buffer.from(raw));
			rpcA.handle(frame);
		} catch (err) {
			console.error("Device A RPC handle error:", err);
		}
	});

	// Set up Device B Genuine Runtime
	const runtimeB = createDeviceRuntime({
		config: {
			deviceId: deviceIdB,
			hubUrl,
			credential: credB,
			uiCredential: "ui-b",
			name: "Device B",
			allowExecution: true,
		},
		localOrigin: `http://127.0.0.1:${hubPort}`,
		dataDir: dataDirB,
		bots: botsB,
	});
	cleanup.push(() => runtimeB.close());

	// Connect Device B WebSocket to Hub Relay
	console.log("Connecting genuine Device B WebSocket to Hub Relay...");
	const wsUrlB = `ws://127.0.0.1:${hubPort}/device-connect?deviceId=${deviceIdB}`;
	const wsB = new WebSocket(wsUrlB, {
		headers: {
			Authorization: `Bearer ${credB}`,
			Host: `127.0.0.1:${hubPort}`,
		},
	});
	cleanup.push(() => wsB.terminate());
	await new Promise((resolve, reject) => {
		wsB.once("open", resolve);
		wsB.once("error", reject);
	});
	const rpcB = createCommandChannel(wsB, runtimeB.onCommand);
	wsB.on("message", (raw) => {
		try {
			const frame = parseFrame(Buffer.from(raw));
			rpcB.handle(frame);
		} catch (err) {
			console.error("Device B RPC handle error:", err);
		}
	});

	// Verify both devices are online on Hub Relay
	assert.equal(relay.isOnline(deviceIdA), true, "Device A must be online on Hub Relay");
	assert.equal(relay.isOnline(deviceIdB), true, "Device B must be online on Hub Relay");
	console.log("✓ Both Device A and Device B connected via genuine WebSocket RPC channels");

	const syncA = createDeviceFileSync({ root: rootA, dataDir: dataDirA, allowReceive: true });
	cleanup.push(() => syncA.close());

	async function postAgentTransfer(body) {
		const res = await fetch(`${hubUrl}/api/agent/transfers`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Device-Id": deviceIdA,
				Authorization: `Bearer ${credA}`,
			},
			body: JSON.stringify({
				roomId,
				sourceBotId: botIdA,
				targetBotId: botIdB,
				...body,
			}),
		});
		const data = await res.json().catch(() => ({}));
		return { status: res.status, data };
	}

	async function getUserTransfers() {
		const res = await fetch(`${hubUrl}/api/rooms/${roomId}/transfers`);
		const data = await res.json().catch(() => ({}));
		return { status: res.status, data };
	}

	async function postUserApply(transferId, revision, overwritePaths) {
		const res = await fetch(`${hubUrl}/api/rooms/${roomId}/transfers/${transferId}/apply`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ revision, overwritePaths }),
		});
		const data = await res.json().catch(() => ({}));
		return { status: res.status, data };
	}

	async function postUserAbort(transferId) {
		const res = await fetch(`${hubUrl}/api/rooms/${roomId}/transfers/${transferId}/abort`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		const data = await res.json().catch(() => ({}));
		return { status: res.status, data };
	}

	// =========================================================================
	// Scenario 1: Real >8MiB (9 MiB) file transfer across WebSocket RPC & resume
	// =========================================================================
	console.log("Scenario 1: >8MiB (9 MiB) file across genuine WebSocket RPC with resume...");
	const bigFileSize = 9 * 1024 * 1024; // 9 MiB
	const bigFileBuffer = Buffer.alloc(bigFileSize);
	for (let i = 0; i < bigFileSize; i += 4096) {
		bigFileBuffer.write(`RPC_PAYLOAD_CHUNK_${i}_`, i, "utf8");
	}
	const expectedBigHash = sha256(bigFileBuffer);
	await writeFile(join(rootA, "real-9mb-asset.bin"), bigFileBuffer);

	const chunkSize = 32 * 1024; // 32 KiB -> 288 chunks
	const manifest1 = await syncA.prepareChunked({
		paths: ["real-9mb-asset.bin"],
		chunkSize,
	});

	assert.equal(manifest1.totalBytes, bigFileSize);
	assert.equal(manifest1.totalChunks, 288);

	// 1. Init chunked transfer on Hub -> transfers RPC call to Device B runtimeB!
	const initRes = await postAgentTransfer({
		action: "init",
		manifest: manifest1,
	});
	assert.equal(initRes.status, 200, `Init transfer failed: ${JSON.stringify(initRes.data)}`);
	assert.equal(initRes.data.status, "staging");
	const transferId1 = initRes.data.transferId;
	assert.ok(transferId1);

	// Verify User-facing GET endpoint sees the active transfer
	const userList1 = await getUserTransfers();
	assert.equal(userList1.status, 200);
	assert.ok(Array.isArray(userList1.data.transfers));
	const item1 = userList1.data.transfers.find((t) => t.transferId === transferId1);
	assert.ok(item1, "User GET /api/rooms/:id/transfers must return the active transfer");
	assert.equal(item1.sourceBotId, botIdA);
	assert.equal(item1.targetBotId, botIdB);

	// 2. Stream first 45 chunks over WebSocket RPC, then simulate pause/interruption
	console.log("  Streaming first 45 chunks over WebSocket RPC...");
	for (let c = 0; c < 45; c++) {
		const offset = c * chunkSize;
		const size = Math.min(chunkSize, bigFileSize - offset);
		const { buffer, sha256: chunkHash } = await syncA.readChunk({
			path: "real-9mb-asset.bin",
			offset,
			size,
		});
		const chunkRes = await postAgentTransfer({
			action: "chunk",
			transferId: transferId1,
			chunk: {
				transferId: transferId1,
				chunkIndex: c,
				path: "real-9mb-asset.bin",
				offset,
				size,
				sha256: chunkHash,
				data: buffer.toString("base64"),
			},
		});
		assert.equal(chunkRes.status, 200, `Chunk ${c} failed: ${chunkRes.data?.error || JSON.stringify(chunkRes.data)}`);
	}

	// 3. Status query over WebSocket RPC: verify exact 45 chunks received
	console.log("  Querying transfer status over WebSocket RPC to verify resume boundary...");
	const statusRes = await postAgentTransfer({
		action: "status",
		transferId: transferId1,
	});
	assert.equal(statusRes.status, 200);
	assert.equal(statusRes.data.status, "staging");
	assert.equal(statusRes.data.receivedChunks.length, 45);

	// 4. Resume remaining chunks from 45 to 287
	console.log("  Resuming remaining chunks (45 to 287) across WebSocket RPC...");
	for (let c = 45; c < manifest1.totalChunks; c++) {
		const offset = c * chunkSize;
		const size = Math.min(chunkSize, bigFileSize - offset);
		const { buffer, sha256: chunkHash } = await syncA.readChunk({
			path: "real-9mb-asset.bin",
			offset,
			size,
		});
		const chunkRes = await postAgentTransfer({
			action: "chunk",
			transferId: transferId1,
			chunk: {
				transferId: transferId1,
				chunkIndex: c,
				path: "real-9mb-asset.bin",
				offset,
				size,
				sha256: chunkHash,
				data: buffer.toString("base64"),
			},
		});
		assert.equal(chunkRes.status, 200);
	}

	// 5. Query user transfers: should now be staged!
	const userListAfterChunks = await getUserTransfers();
	assert.equal(userListAfterChunks.status, 200);
	const userItemStaged = userListAfterChunks.data.transfers.find((t) => t.transferId === transferId1);
	assert.ok(userItemStaged);
	assert.equal(userItemStaged.status, "staged");
	assert.equal(userItemStaged.receivedChunks?.length, 288);

	// 6. User Apply endpoint call
	console.log("  Applying staged transfer via User endpoint...");
	const previewRes = await postAgentTransfer({ action: "preview", transferId: transferId1 });
	assert.equal(previewRes.status, 200);
	const rev1 = previewRes.data.preview?.revision || previewRes.data.revision;

	const userApplyRes = await postUserApply(transferId1, rev1, ["real-9mb-asset.bin"]);
	assert.equal(userApplyRes.status, 200);
	assert.deepEqual(userApplyRes.data.applied, ["real-9mb-asset.bin"]);

	// 7. Verify file on Device B's physical project root
	const destBytes = await readFile(join(rootB, "real-9mb-asset.bin"));
	assert.equal(destBytes.length, bigFileSize);
	assert.equal(sha256(destBytes), expectedBigHash);
	console.log("  ✓ Real >8MiB file transferred over WebSocket RPC and verified with exact SHA256 match!");

	// =========================================================================
	// Scenario 2: 130 files directory transfer across WebSocket RPC
	// =========================================================================
	console.log("Scenario 2: 130 files directory transfer (breaking 128-file limit) over WebSocket RPC...");
	const testDir = "source-bundle";
	await mkdir(join(rootA, testDir), { recursive: true });
	const filesMap = new Map();
	for (let i = 0; i < 130; i++) {
		const filename = `${testDir}/part_${String(i).padStart(3, "0")}.txt`;
		const content = `Genuine content for file ${i}: ${randomUUID()}`;
		await writeFile(join(rootA, filename), content);
		filesMap.set(filename, content);
	}

	const manifest2 = await syncA.prepareChunked({
		paths: [testDir],
		recursive: true,
		chunkSize: 32 * 1024,
	});
	assert.equal(manifest2.totalFiles, 130);
	assert.ok(manifest2.totalFiles > 128);

	const init2 = await postAgentTransfer({ action: "init", manifest: manifest2 });
	assert.equal(init2.status, 200);
	const transferId2 = init2.data.transferId;

	// Stream all files/chunks
	for (const file of manifest2.files) {
		for (let c = 0; c < file.chunkCount; c++) {
			const offset = c * manifest2.chunkSize;
			const size = Math.min(manifest2.chunkSize, file.size - offset);
			const { buffer, sha256: chunkHash } = await syncA.readChunk({
				path: file.path,
				offset,
				size,
			});
			const chunkRes = await postAgentTransfer({
				action: "chunk",
				transferId: transferId2,
				chunk: {
					transferId: transferId2,
					chunkIndex: file.firstChunkIndex + c,
					path: file.path,
					offset,
					size,
					sha256: chunkHash,
					data: buffer.toString("base64"),
				},
			});
			assert.equal(chunkRes.status, 200);
		}
	}

	const preview2 = await postAgentTransfer({ action: "preview", transferId: transferId2 });
	assert.equal(preview2.status, 200);
	const rev2 = preview2.data.preview?.revision || preview2.data.revision;

	const apply2 = await postUserApply(
		transferId2,
		rev2,
		manifest2.files.map((f) => f.path),
	);
	assert.equal(apply2.status, 200);
	assert.equal(apply2.data.applied?.length, 130);

	for (const [p, expected] of filesMap.entries()) {
		const targetContent = await readFile(join(rootB, p), "utf8");
		assert.equal(targetContent, expected);
	}
	console.log("  ✓ 130 files transferred across WebSocket RPC and verified on disk!");

	// =========================================================================
	// Scenario 3: Corrupt chunk intercepted over WebSocket RPC
	// =========================================================================
	console.log("Scenario 3: Corrupt chunk intercepted over WebSocket RPC...");
	await writeFile(join(rootA, "corrupt-rpc.txt"), "Authentic content");
	const manifest3 = await syncA.prepareChunked({ paths: ["corrupt-rpc.txt"] });
	const init3 = await postAgentTransfer({ action: "init", manifest: manifest3 });
	const transferId3 = init3.data.transferId;

	const { buffer: originalBuf, sha256: originalHash } = await syncA.readChunk({
		path: "corrupt-rpc.txt",
		offset: 0,
		size: manifest3.totalBytes,
	});

	const damagedBuf = Buffer.from(originalBuf);
	damagedBuf[0] = 0xee; // alter first byte

	const badRes = await postAgentTransfer({
		action: "chunk",
		transferId: transferId3,
		chunk: {
			transferId: transferId3,
			chunkIndex: 0,
			path: "corrupt-rpc.txt",
			offset: 0,
			size: manifest3.totalBytes,
			sha256: originalHash,
			data: damagedBuf.toString("base64"),
		},
	});
	assert.notEqual(badRes.status, 200, "Corrupt chunk must fail over WebSocket RPC");

	// Retry with authentic chunk
	const goodRes = await postAgentTransfer({
		action: "chunk",
		transferId: transferId3,
		chunk: {
			transferId: transferId3,
			chunkIndex: 0,
			path: "corrupt-rpc.txt",
			offset: 0,
			size: manifest3.totalBytes,
			sha256: originalHash,
			data: originalBuf.toString("base64"),
		},
	});
	assert.equal(goodRes.status, 200, "Authentic chunk retry must succeed");
	console.log("  ✓ Corrupt chunk correctly rejected and recovered over WebSocket RPC!");

	// =========================================================================
	// Scenario 4: Agent Abort endpoint cancels transfer and frees physical IO
	// =========================================================================
	console.log("Scenario 4: Agent Abort endpoint physically purges staged IO over WebSocket RPC...");
	await writeFile(join(rootA, "agent-abort.txt"), Buffer.alloc(32 * 1024, "u"));
	const manifest4 = await syncA.prepareChunked({ paths: ["agent-abort.txt"] });
	const init4 = await postAgentTransfer({ action: "init", manifest: manifest4 });
	const transferId4 = init4.data.transferId;

	async function findStagedManifest(baseDir, tid) {
		const targetName = `transfer-${tid}`;
		async function walk(dir) {
			const entries = await readdir(dir).catch(() => []);
			for (const e of entries) {
				const full = join(dir, e);
				const s = await lstat(full).catch(() => null);
				if (s?.isDirectory()) {
					if (e === targetName) return join(full, "manifest.json");
					const found = await walk(full);
					if (found) return found;
				}
			}
			return null;
		}
		return await walk(baseDir);
	}

	const manifestFileBefore = await findStagedManifest(dataDirB, manifest4.transferId);
	assert.ok(manifestFileBefore, "Staged manifest must exist on target before abort");
	const existsBefore = await readFile(manifestFileBefore)
		.then(() => true)
		.catch(() => false);
	assert.equal(existsBefore, true);

	const agentAbortRes = await postAgentTransfer({ action: "abort", transferId: transferId4 });
	assert.equal(agentAbortRes.status, 200);
	assert.equal(agentAbortRes.data.status, "cancelled");

	const manifestFileAfter = await findStagedManifest(dataDirB, manifest4.transferId);
	assert.equal(manifestFileAfter, null, "Staged directory must be physically purged after abort");
	console.log("  ✓ Agent abort released physical staged IO across WebSocket RPC!");

	await cleanAll();
	console.log("=== All Genuine WebSocket RPC & DeviceRuntime Integration Tests Passed! ===");
}

run().catch(async (err) => {
	console.error("Test failed with error:", err);
	await cleanAll();
	process.exit(1);
});
