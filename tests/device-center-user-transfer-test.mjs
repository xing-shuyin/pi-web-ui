// Human HTTP start/list/preview/apply and resume/abort across two HTTP services,
// genuine DeviceRuntime instances and real WebSocket RPC. No mock device/file handlers.
// Run: node --import tsx tests/device-center-user-transfer-test.mjs
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import WebSocket from "ws";
import { hashSecret } from "../server/device-center/store.ts";
import { createDeviceRelay, createCommandChannel, parseFrame } from "../server/device-center/relay.ts";
import { installDeviceTransfers } from "../server/device-center/transfers.ts";
import { createDeviceRuntime } from "../server/device-center/runtime.ts";
import { createLocalBotRegistry } from "../server/device-center/bots.ts";
import { createDeviceHub } from "../server/device-center/hub.ts";
import { installLocalDeviceCenter } from "../server/device-center/local.ts";

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
	const hubServer = createServer();
	await new Promise((resolve) => hubServer.listen(0, "127.0.0.1", resolve));
	const hub = await createDeviceHub({
		server: hubServer,
		dataDir: hubDataDir,
		publicUrl: `http://127.0.0.1:${hubServer.address().port}`,
	});
	const store = hub.store;
	cleanup.push(() => hub.close());
	const accountId = "test-account";
	const deviceIdA = "device-a";
	const deviceIdB = "device-b";
	const credA = "secret-token-device-a";
	const credB = "secret-token-device-b";
	const roomId = "room-collab";

	await store.transact((s) => {
		s.accounts.push({ id: accountId, username: "user", passwordHash: "h", createdAt: 1 });
		s.devices.push({
			id: deviceIdA,
			accountId,
			name: "Device A",
			credentialHash: hashSecret(credA),
			uiCredentialHash: hashSecret("ui-a"),
			createdAt: 1,
		});
		s.devices.push({
			id: deviceIdB,
			accountId,
			name: "Device B",
			credentialHash: hashSecret(credB),
			uiCredentialHash: hashSecret("ui-b"),
			createdAt: 1,
		});
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
	const deviceApp = express();
	deviceApp.get("/health", (_req, res) => res.json({ ok: true }));
	const deviceServer = createServer(deviceApp);
	await new Promise((resolve) => deviceServer.listen(0, "127.0.0.1", resolve));
	cleanup.push(() => new Promise((resolve) => deviceServer.close(resolve)));
	const deviceUrl = `http://127.0.0.1:${deviceServer.address().port}`;
	const app = hub.app;
	const server = hub.server;
	assert.equal(server.listening, true);
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
	hub.setRelay(relay);

	// Install transfers routes on Hub
	const scheduler = await installDeviceTransfers({ app, hub, dataDir: hubDataDir, relay });
	cleanup.push(() => scheduler.close());
	const localDataDir = join(tempDir, "user-local-data");
	await mkdir(localDataDir);
	await writeFile(
		join(localDataDir, "device-center.json"),
		JSON.stringify({
			hubUrl,
			deviceId: deviceIdA,
			credential: credA,
			uiCredential: "ui-a",
			name: "Device A",
			allowExecution: true,
		}),
	);
	deviceApp.use(express.json());
	const local = await installLocalDeviceCenter({
		app: deviceApp,
		dataDir: localDataDir,
		connect: async () => ({ close() {} }),
	});
	cleanup.push(() => local.close());

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
		localOrigin: deviceUrl,
		dataDir: dataDirA,
		bots: botsA,
	});
	cleanup.push(() => runtimeA.close());

	// Connect Device A WebSocket to Hub Relay
	console.log("Connecting genuine Device A WebSocket to Hub Relay...");
	const wsUrlA = `ws://127.0.0.1:${hubPort}/device-connect?deviceId=${deviceIdA}`;
	let wsA = new WebSocket(wsUrlA, {
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
	let sourceReads = 0;
	let fault = "none";
	let gateEntered;
	let releaseGate;
	const sourceHandler = async (action, payload, signal) => {
		if (action === "transfer_read_chunk") {
			sourceReads++;
			if (fault === "disconnect") {
				fault = "none";
				wsB.terminate();
				throw new Error("Simulated network failure");
			}
			if (fault === "sender-disconnect") {
				fault = "none";
				wsA.terminate();
				throw new Error("Sender disconnected");
			}
			if (fault === "gate") {
				gateEntered?.();
				await new Promise((resolve) => {
					releaseGate = resolve;
				});
			}
		}
		return runtimeA.onCommand(action, payload, signal);
	};
	let rpcA = createCommandChannel(wsA, sourceHandler);
	wsA.on("message", (raw) => {
		try {
			const frame = parseFrame(Buffer.from(raw));
			rpcA.handle(frame);
		} catch (err) {
			console.error("Device A RPC handle error:", err);
		}
	});

	// Set up Device B Genuine Runtime
	const runtimeBOptions = {
		config: {
			deviceId: deviceIdB,
			hubUrl,
			credential: credB,
			uiCredential: "ui-b",
			name: "Device B",
			allowExecution: true,
		},
		localOrigin: deviceUrl,
		dataDir: dataDirB,
		bots: botsB,
	};
	let runtimeB = createDeviceRuntime(runtimeBOptions);
	cleanup.push(() => runtimeB.close());

	// Connect Device B WebSocket to Hub Relay
	console.log("Connecting genuine Device B WebSocket to Hub Relay...");
	const wsUrlB = `ws://127.0.0.1:${hubPort}/device-connect?deviceId=${deviceIdB}`;
	let wsB = new WebSocket(wsUrlB, {
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
	let rpcB = createCommandChannel(wsB, runtimeB.onCommand);
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

	async function api(path, body, expected = 200) {
		const response = await fetch(
			deviceUrl + `/api/device-center/rooms/${roomId}/transfers${path}`,
			body === undefined
				? {}
				: {
						method: "POST",
						headers: { "Content-Type": "application/json", Origin: deviceUrl },
						body: JSON.stringify(body),
					},
		);
		const data = await response.json();
		assert.equal(response.status, expected, JSON.stringify(data));
		return data;
	}
	async function waitStatus(id, expected) {
		for (let n = 0; n < 600; n++) {
			const { transfers } = await api("");
			const item = transfers.find((row) => row.transferId === id);
			if (item?.status === expected) return item;
			if (["failed", "interrupted"].includes(item?.status) && expected === "ready")
				throw new Error(JSON.stringify(item));
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		throw new Error("Timed out: " + expected);
	}
	const base = { sourceBotId: botIdA, targetBotId: botIdB, recursive: true };
	const bytes = Buffer.alloc(9 * 1024 * 1024, 71);
	await writeFile(join(rootA, "human.bin"), bytes);
	const first = await api("/start", { ...base, paths: ["human.bin"], idempotencyKey: "human-request-1" }, 202);
	assert.equal(
		(await api("/start", { ...base, paths: ["human.bin"], idempotencyKey: "human-request-1" })).transferId,
		first.transferId,
	);
	await api("/start", { ...base, paths: ["different.bin"], idempotencyKey: "human-request-1" }, 409);
	const ready = await waitStatus(first.transferId, "ready");
	assert.ok(ready.manifestHash);
	const preview = await api(`/${first.transferId}/preview`);
	const changes = preview.preview ?? preview;
	assert.equal(changes.files[0].status, "create");
	await api(`/${first.transferId}/apply`, { revision: changes.revision, overwritePaths: [] });
	assert.equal(sha256(await readFile(join(rootB, "human.bin"))), sha256(bytes));
	assert.equal((await waitStatus(first.transferId, "applied")).status, "applied");
	console.log("PASS human start -> idempotent retry -> list -> preview -> apply (9 MiB, real runtime RPC)");

	await writeFile(join(rootA, "resume.bin"), bytes.subarray(0, 256 * 1024));
	fault = "disconnect";
	const broken = await api("/start", { ...base, paths: ["resume.bin"], idempotencyKey: "human-resume-1" }, 202);
	const interrupted = await waitStatus(broken.transferId, "interrupted");
	await api(
		`/${broken.transferId}/resume`,
		{
			manifestHash: "wrong",
			sourceBotRevision: interrupted.sourceBotRevision,
			targetBotRevision: interrupted.targetBotRevision,
		},
		409,
	);
	await runtimeB.close();
	runtimeB = createDeviceRuntime(runtimeBOptions);
	wsB = new WebSocket(wsUrlB, { headers: { Authorization: `Bearer ${credB}` } });
	await new Promise((resolve, reject) => {
		wsB.once("open", resolve);
		wsB.once("error", reject);
	});
	rpcB = createCommandChannel(wsB, runtimeB.onCommand);
	wsB.on("message", (raw) => rpcB.handle(parseFrame(Buffer.from(raw))));
	await api(
		`/${broken.transferId}/resume`,
		{
			manifestHash: interrupted.manifestHash,
			sourceBotRevision: interrupted.sourceBotRevision,
			targetBotRevision: interrupted.targetBotRevision,
		},
		202,
	);
	await waitStatus(broken.transferId, "ready");
	const resumedPreview = await api(`/${broken.transferId}/preview`);
	await api(`/${broken.transferId}/apply`, {
		revision: (resumedPreview.preview ?? resumedPreview).revision,
		overwritePaths: [],
	});
	assert.equal(sha256(await readFile(join(rootB, "resume.bin"))), sha256(bytes.subarray(0, 256 * 1024)));
	console.log("PASS disconnected target -> original manifest + revision resume -> real apply");
	console.log("PASS receiver runtime reconstruction preserves scoped manifest/chunks");

	await writeFile(join(rootA, "abort.bin"), bytes.subarray(0, 128 * 1024));
	fault = "gate";
	const entered = new Promise((resolve) => {
		gateEntered = resolve;
	});
	const cancelled = await api("/start", { ...base, paths: ["abort.bin"], idempotencyKey: "human-abort-1" }, 202);
	await entered;
	let abortSettled = false;
	const abort = api(`/${cancelled.transferId}/abort`, {}).then((result) => {
		abortSettled = true;
		return result;
	});
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(abortSettled, false, "Abort must wait for sender IO settled ACK");
	await api(`/${cancelled.transferId}/abort`, {}, 409);
	await api("/start", { ...base, paths: ["human.bin"], idempotencyKey: "while-aborting" }, 429);
	fault = "none";
	releaseGate();
	assert.equal((await abort).status, "cancelled");
	const readsAfter = sourceReads;
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(sourceReads, readsAfter, "Sender loop must stop on abort");
	await assert.rejects(readFile(join(rootB, "abort.bin")));
	await api(`/${cancelled.transferId}/resume`, { manifestHash: "x" }, 409);
	assert.equal(
		(await api("/start", { ...base, paths: ["abort.bin"], idempotencyKey: "human-abort-1" })).status,
		"cancelled",
	);
	console.log("PASS abort during sender IO waits, holds capacity, stops loop, prevents resume");
	// Retrying a saved manifest must reject source bytes changed without changing file size.
	await writeFile(join(rootA, "changed.bin"), bytes.subarray(0, 128 * 1024));
	fault = "disconnect";
	const changed = await api("/start", { ...base, paths: ["changed.bin"], idempotencyKey: "human-source-change" }, 202);
	const changedInterrupted = await waitStatus(changed.transferId, "interrupted");
	await writeFile(join(rootA, "changed.bin"), Buffer.alloc(128 * 1024, 88));
	wsB = new WebSocket(wsUrlB, { headers: { Authorization: `Bearer ${credB}` } });
	await new Promise((resolve, reject) => {
		wsB.once("open", resolve);
		wsB.once("error", reject);
	});
	rpcB = createCommandChannel(wsB, runtimeB.onCommand);
	wsB.on("message", (raw) => rpcB.handle(parseFrame(Buffer.from(raw))));
	await api(
		`/${changed.transferId}/resume`,
		{
			manifestHash: changedInterrupted.manifestHash,
			sourceBotRevision: changedInterrupted.sourceBotRevision,
			targetBotRevision: changedInterrupted.targetBotRevision,
		},
		202,
	);
	await waitStatus(changed.transferId, "interrupted");
	await assert.rejects(readFile(join(rootB, "changed.bin")));
	console.log("PASS source changed with original size cannot mix chunks into saved manifest");
	await writeFile(join(rootA, "fenced.bin"), bytes.subarray(0, 128 * 1024));
	fault = "sender-disconnect";
	const fenced = await api("/start", { ...base, paths: ["fenced.bin"], idempotencyKey: "human-fence" }, 202);
	const fencedRow = await waitStatus(fenced.transferId, "interrupted");
	await api("/start", { ...base, paths: ["human.bin"], idempotencyKey: "blocked-sender-device" }, 409);
	wsA = new WebSocket(wsUrlA, { headers: { Authorization: `Bearer ${credA}` } });
	await new Promise((resolve, reject) => {
		wsA.once("open", resolve);
		wsA.once("error", reject);
	});
	rpcA = createCommandChannel(wsA, sourceHandler);
	wsA.on("message", (raw) => rpcA.handle(parseFrame(Buffer.from(raw))));
	await api(
		`/${fenced.transferId}/resume`,
		{
			manifestHash: fencedRow.manifestHash,
			sourceBotRevision: fencedRow.sourceBotRevision,
			targetBotRevision: fencedRow.targetBotRevision,
		},
		202,
	);
	await waitStatus(fenced.transferId, "ready");
	await api(`/${fenced.transferId}/abort`, {});
	console.log("PASS sender lost during RPC -> persistent device block -> real runtime fence -> resume");
	// Reconstruct the Hub registry from disk, then inspect through HTTP and perform real RPC.
	await scheduler.close();
	const restoredApp = express();
	restoredApp.use(express.json());
	const restored = await installDeviceTransfers({
		app: restoredApp,
		store,
		authenticateAgent: hub.authenticateAgent,
		getAccount: () => ({ id: accountId }),
		dataDir: hubDataDir,
		relay,
	});
	cleanup.push(() => restored.close());
	const restoredServer = createServer(restoredApp);
	await new Promise((resolve) => restoredServer.listen(0, "127.0.0.1", resolve));
	cleanup.push(() => new Promise((resolve) => restoredServer.close(resolve)));
	const restoredUrl = `http://127.0.0.1:${restoredServer.address().port}/api/rooms/${roomId}/transfers`;
	const restoredList = await (await fetch(restoredUrl)).json();
	const restoredRow = restoredList.transfers.find((r) => r.transferId === changed.transferId);
	assert.equal(restoredRow.manifestHash, changedInterrupted.manifestHash);
	await writeFile(join(rootA, "changed.bin"), bytes.subarray(0, 128 * 1024));
	const restoredResume = await fetch(restoredUrl + `/${changed.transferId}/resume`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			manifestHash: restoredRow.manifestHash,
			sourceBotRevision: restoredRow.sourceBotRevision,
			targetBotRevision: restoredRow.targetBotRevision,
		}),
	});
	assert.equal(restoredResume.status, 202);
	for (let i = 0; i < 300; i++) {
		const rows = await (await fetch(restoredUrl)).json();
		if (rows.transfers.find((r) => r.transferId === changed.transferId)?.status === "ready") break;
		if (i === 299) throw new Error("restored job not ready");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	const restoredPreview = await (await fetch(restoredUrl + `/${changed.transferId}/preview`)).json();
	const restoredApply = await fetch(restoredUrl + `/${changed.transferId}/apply`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ revision: (restoredPreview.preview ?? restoredPreview).revision, overwritePaths: [] }),
	});
	assert.equal(restoredApply.status, 200);
	assert.equal(sha256(await readFile(join(rootB, "changed.bin"))), sha256(bytes.subarray(0, 128 * 1024)));
	console.log("PASS persisted Hub registry reconstructed -> original manifest resume -> actual runtime apply");
	console.log("PASS two HTTP services + genuine runtime + actual WebSocket RPC user transfer closure");
}
run()
	.then(() => cleanAll())
	.catch(async (error) => {
		console.error(error);
		await cleanAll();
		process.exitCode = 1;
	});
