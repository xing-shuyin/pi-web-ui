import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { ensureBuild } from "./lib/ensure-build.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const TIMEOUT = 25_000;
const WINDOW = 4;
const TOTAL = 16;
const sockets = new Set();
let server;
let serverLog = "";
let tmp;

async function randomPort() {
	for (let attempt = 0; attempt < 30; attempt++) {
		const port = randomInt(8900, 60_000);
		const probe = createServer();
		try {
			await new Promise((resolve, reject) => {
				probe.once("error", reject);
				probe.listen(port, "127.0.0.1", resolve);
			});
			await new Promise((resolve, reject) => probe.close((err) => (err ? reject(err) : resolve())));
			return port;
		} catch (err) {
			if (err.code !== "EADDRINUSE") throw err;
		}
	}
	throw new Error("Could not reserve a random loopback port");
}

async function waitFor(test, label, timeout = TIMEOUT) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (server && (server.exitCode !== null || server.signalCode !== null)) {
			throw new Error(`Server exited while waiting for ${label}`);
		}
		const result = await test();
		if (result) return result;
		await sleep(40);
	}
	throw new Error(`Timed out: ${label}`);
}

async function connect(port, clientId) {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
	sockets.add(ws);
	const packets = [];
	const errors = [];
	ws.on("message", (raw) => {
		try {
			packets.push(JSON.parse(raw.toString()));
		} catch (err) {
			errors.push(err);
		}
	});
	ws.on("error", (err) => errors.push(err));
	await waitFor(() => {
		if (errors.length) throw errors[0];
		if (ws.readyState === WebSocket.CLOSED) throw new Error(`${clientId}: socket closed before hello`);
		return ws.readyState === WebSocket.OPEN;
	}, `${clientId} socket open`);
	const browser = {
		clientId,
		ws,
		packets,
		send(message) {
			assert.ok(
				[
					"hello",
					"get_state",
					"new_chat",
					"open_shared_conversation",
					"set_model",
					"pin_conversation",
					"switch_conversation",
					"switch_session",
					"load_earlier_messages",
				].includes(message.type),
				`Unexpected test command: ${message.type}`,
			);
			ws.send(JSON.stringify(message));
		},
		async wait(from, predicate, label) {
			try {
				return await waitFor(() => {
					if (errors.length) throw errors[0];
					if (ws.readyState !== WebSocket.OPEN) throw new Error(`${clientId}: socket closed during ${label}`);
					return packets.slice(from).find(predicate);
				}, `${clientId}: ${label}`);
			} catch (err) {
				console.error(
					`${clientId} recent packets:`,
					JSON.stringify(
						packets
							.slice(from)
							.map((m) => ({
								type: m.type,
								...(m.type === "notice" ? { text: m.textEn ?? m.text } : {}),
								...(m.state
									? {
											conversationId: m.state.conversationId,
											sessionId: m.state.sessionId,
											sharedConversation: m.state.sharedConversation,
										}
									: {}),
							}))
							.slice(-30),
					),
				);
				throw err;
			}
		},
	};
	browser.send({ type: "hello", clientId });
	await browser.wait(0, (m) => m.type === "snapshot", "hello snapshot");
	return browser;
}

async function snapshot(browser, predicate = () => true) {
	const from = browser.packets.length;
	browser.send({ type: "get_state" });
	return (await browser.wait(from, (m) => m.type === "snapshot" && predicate(m.state), "authoritative snapshot")).state;
}

function local(state, browser) {
	return state.clientId === browser.clientId && !state.sharedConversation;
}

function shared(state, viewer, owner, id) {
	return (
		state.clientId === viewer.clientId &&
		state.sharedConversation?.owner === owner.clientId &&
		state.sharedConversation?.conversationId === id &&
		state.conversationId === id
	);
}

async function newChat(browser, independent, ephemeral = false) {
	const requestId = randomUUID();
	const from = browser.packets.length;
	browser.send({ type: "new_chat", requestId, ephemeral, ...(independent === undefined ? {} : { independent }) });
	const result = await browser.wait(
		from,
		(m) => m.type === "new_chat_result" && m.requestId === requestId,
		"new_chat acknowledgement",
	);
	assert.equal(result.ok, true);
	return snapshot(browser, (s) => local(s, browser) && s.conversationId === result.conversationId);
}

async function openShared(viewer, owner, target) {
	const from = viewer.packets.length;
	viewer.send({ type: "open_shared_conversation", owner: owner.clientId, id: target.conversationId });
	const state = (
		await viewer.wait(
			from,
			(m) => {
				if (m.type === "notice" && m.level === "error")
					throw new Error(`${viewer.clientId}: open shared failed: ${m.textEn ?? m.text}`);
				return m.type === "snapshot" && shared(m.state, viewer, owner, target.conversationId);
			},
			`shared snapshot from ${owner.clientId}/${target.conversationId}`,
		)
	).state;
	assert.equal(state.sessionId, target.sessionId);
	assert.equal(resolve(state.sessionFile), resolve(target.sessionFile));
	return state;
}

async function setModel(browser, id, identity) {
	browser.send({ type: "set_model", modelId: `mock/${id}` });
	return waitFor(async () => {
		const state = await snapshot(browser, identity);
		return state.model?.provider === "mock" && state.model.id === id ? state : false;
	}, `${browser.clientId}: model ${id}`);
}

async function disconnect(browser) {
	await new Promise((resolve) => {
		browser.ws.once("close", resolve);
		browser.ws.close();
	});
	sockets.delete(browser.ws);
}

function seedSession(agentDir, work, label) {
	const sessionId = randomUUID();
	const file = join(agentDir, "sessions", `${label}_${sessionId}.jsonl`);
	const timestamp = new Date().toISOString();
	const entries = [{ type: "session", version: 3, id: sessionId, timestamp, cwd: work }];
	let parentId = null;
	for (let i = 0; i < TOTAL; i++) {
		const id = `${label}-${i}`;
		entries.push({
			type: "message",
			id,
			parentId,
			timestamp,
			message: {
				role: "user",
				content: [{ type: "text", text: `${label} history ${i}` }],
				timestamp: Date.now() + i,
			},
		});
		parentId = id;
	}
	writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	return { file, sessionId, label };
}

async function openHistory(browser, seed) {
	browser.send({ type: "switch_session", path: seed.file, independent: false });
	return snapshot(browser, (s) => local(s, browser) && s.sessionId === seed.sessionId);
}

async function historyPage(viewer, state, all = false) {
	const from = viewer.packets.length;
	viewer.send({
		type: "load_earlier_messages",
		conversationId: state.conversationId,
		before: state.historyStart,
		beforeId: state.messages[0]?.id,
		historyGeneration: state.historyGeneration,
		count: WINDOW,
		all,
	});
	const page = await viewer.wait(from, (m) => m.type === "earlier_messages", "shared history page");
	assert.equal(page.conversationId, state.conversationId);
	assert.notEqual(page.resyncRequired, true);
	assert.equal(page.historyTotal, TOTAL);
	assert.equal(page.before, state.historyStart);
	assert.equal(page.beforeId, state.messages[0]?.id);
	assert.equal(page.historyStart + page.messages.length, state.historyStart);
	assert.ok(page.messages.every((m) => !state.messages.some((existing) => existing.id === m.id)));
	return page;
}

function historyTexts(messages, label, start, end) {
	assert.deepEqual(
		messages.map((m) =>
			m.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join(""),
		),
		Array.from({ length: end - start }, (_, i) => `${label} history ${start + i}`),
	);
}

try {
	await ensureBuild(ROOT, "shared-conversation-test");
	tmp = mkdtempSync(join(tmpdir(), "pi-shared-conversation-"));
	const work = join(tmp, "work");
	const dataDir = join(tmp, "data");
	const agentDir = join(tmp, "agent");
	for (const dir of [work, dataDir, join(agentDir, "sessions")]) mkdirSync(dir, { recursive: true });
	writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ mock: { type: "api_key", key: "dummy" } }));
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				mock: {
					api: "openai-completions",
					baseUrl: "http://127.0.0.1:1/v1",
					apiKey: "dummy",
					models: [
						{ id: "mock-model", name: "Mock Model" },
						{ id: "other-model", name: "Other Model" },
					],
				},
			},
		}),
	);
	const seedA = seedSession(agentDir, work, "owner-a");
	const seedB = seedSession(agentDir, work, "owner-b");
	const port = await randomPort();
	server = spawn(process.execPath, [join(ROOT, "dist", "server", "index.js")], {
		cwd: ROOT,
		env: {
			...process.env,
			PI_WEB_HOST: "127.0.0.1",
			PI_WEB_PORT: String(port),
			PI_WEB_CWD: work,
			PI_WEB_DATA_DIR: dataDir,
			PI_CODING_AGENT_DIR: agentDir,
			PI_WEB_SDK: "bundled",
			PI_WEB_TOKEN: "",
			PI_WEB_PLUGIN_CATALOG_URL: "off",
			PI_WEB_PLUGIN_CATALOG_INSTALL: "0",
			PI_WEB_HISTORY_WINDOW: String(WINDOW),
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	server.on("error", (err) => (serverLog += String(err)));
	for (const stream of [server.stdout, server.stderr]) {
		stream.on("data", (chunk) => (serverLog = (serverLog + chunk.toString()).slice(-24_000)));
	}
	await waitFor(async () => {
		try {
			return (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) })).ok;
		} catch {
			return false;
		}
	}, "isolated server health");

	const ownerA = await connect(port, "shared-owner-a");
	const ownerB = await connect(port, "shared-owner-b");
	let viewer = await connect(port, "shared-viewer");
	const ownViewer = await newChat(viewer);
	const a = await newChat(ownerA);
	const b = await newChat(ownerB);
	assert.equal(a.conversationId, "c1");
	assert.equal(b.conversationId, "c1");
	assert.notEqual(a.sessionId, b.sessionId);

	const rejectedFrom = viewer.packets.length;
	viewer.send({ type: "open_shared_conversation", owner: ownerA.clientId, id: a.conversationId });
	await viewer.wait(
		rejectedFrom,
		(m) => m.type === "notice" && m.level === "error" && m.textEn === "Shared conversation is unavailable.",
		"independent share rejected",
	);
	const rejected = await snapshot(viewer, (s) => local(s, viewer));
	assert.equal(rejected.sessionId, ownViewer.sessionId);
	assert.ok(!viewer.packets.slice(rejectedFrom).some((m) => m.state?.sharedConversation));
	console.log("✓ default new_chat is independent; failed share keeps viewer local");

	const sharedA = await newChat(ownerA, false);
	const sharedB = await newChat(ownerB, false);
	assert.equal(sharedA.sessionId, a.sessionId, "blank new_chat must reuse owner A c1");
	assert.equal(sharedB.sessionId, b.sessionId, "blank new_chat must reuse owner B c1");
	await setModel(ownerA, "mock-model", (s) => local(s, ownerA));
	await setModel(ownerB, "other-model", (s) => local(s, ownerB));
	await openShared(viewer, ownerA, sharedA);
	assert.equal((await snapshot(ownerA, (s) => local(s, ownerA))).sessionId, a.sessionId);
	console.log("✓ independent:false opens in another browser without transferring ownership");

	ownerA.send({ type: "pin_conversation", id: a.conversationId, pinned: true });
	const otherA = await newChat(ownerA, undefined, true);
	ownerA.send({ type: "pin_conversation", id: otherA.conversationId, pinned: true });
	assert.notEqual(otherA.conversationId, a.conversationId);
	assert.notEqual(otherA.sessionId, a.sessionId);
	await setModel(ownerA, "mock-model", (s) => local(s, ownerA) && s.sessionId === otherA.sessionId);
	const stable = await snapshot(viewer, (s) => shared(s, viewer, ownerA, a.conversationId));
	assert.equal(stable.sessionId, a.sessionId);
	await setModel(viewer, "other-model", (s) => shared(s, viewer, ownerA, a.conversationId));
	assert.equal((await snapshot(ownerA, (s) => local(s, ownerA))).sessionId, otherA.sessionId);
	assert.equal((await snapshot(ownerA, (s) => local(s, ownerA))).model.id, "mock-model");
	assert.equal((await snapshot(ownerB, (s) => local(s, ownerB))).model.id, "other-model");
	ownerA.send({ type: "switch_conversation", id: a.conversationId });
	const writtenA = await snapshot(ownerA, (s) => local(s, ownerA) && s.sessionId === a.sessionId);
	assert.equal(writtenA.model.id, "other-model", "viewer wrote shared c1, not owner active c2");
	ownerA.send({ type: "switch_conversation", id: otherA.conversationId });
	await snapshot(ownerA, (s) => local(s, ownerA) && s.sessionId === otherA.sessionId);
	console.log("✓ owner active switch preserves shared target; model writes reach the original conversation");

	await disconnect(viewer);
	viewer = await connect(port, "shared-viewer");
	const restored = await snapshot(viewer, (s) => shared(s, viewer, ownerA, a.conversationId));
	assert.equal(restored.sessionId, a.sessionId);
	assert.equal(restored.model.id, "other-model");
	assert.equal((await snapshot(ownerA, (s) => local(s, ownerA))).sessionId, otherA.sessionId);
	console.log("✓ disconnect/hello reconnect restores shared c1 while owner remains on c2");

	await openShared(viewer, ownerB, sharedB);
	await setModel(viewer, "mock-model", (s) => shared(s, viewer, ownerB, b.conversationId));
	assert.equal((await snapshot(ownerB, (s) => local(s, ownerB))).model.id, "mock-model");
	await openShared(viewer, ownerA, sharedA);
	assert.equal((await snapshot(viewer, (s) => shared(s, viewer, ownerA, a.conversationId))).model.id, "other-model");
	console.log("✓ two owners with c1 remain isolated by owner and transcript identity");

	const exited = await newChat(viewer);
	assert.equal(exited.clientId, viewer.clientId);
	assert.equal(exited.sessionId, ownViewer.sessionId);
	assert.ok(!exited.sharedConversation);
	await setModel(ownerB, "other-model", (s) => local(s, ownerB));
	assert.equal((await snapshot(viewer, (s) => local(s, viewer))).sessionId, ownViewer.sessionId);
	console.log("✓ viewer new_chat exits shared view and receives its own snapshot");

	const historyA = await openHistory(ownerA, seedA);
	ownerB.send({ type: "pin_conversation", id: b.conversationId, pinned: true });
	await newChat(ownerB, undefined, true);
	const historyB = await openHistory(ownerB, seedB);
	assert.equal(historyA.conversationId, historyB.conversationId);
	let tail = await openShared(viewer, ownerA, historyA);
	assert.equal(tail.historyTotal, TOTAL);
	assert.equal(tail.historyStart, TOTAL - WINDOW);
	historyTexts(tail.messages, seedA.label, TOTAL - WINDOW, TOTAL);
	let page = await historyPage(viewer, tail);
	historyTexts(page.messages, seedA.label, TOTAL - 2 * WINDOW, TOTAL - WINDOW);
	let expanded = await snapshot(viewer, (s) => shared(s, viewer, ownerA, historyA.conversationId));
	assert.equal(expanded.historyStart, TOTAL - 2 * WINDOW);
	historyTexts(expanded.messages, seedA.label, TOTAL - 2 * WINDOW, TOTAL);
	console.log("✓ shared history page joins the tail; get_state preserves the expanded window");

	tail = await openShared(viewer, ownerB, historyB);
	assert.equal(tail.historyStart, TOTAL - WINDOW, "owner A's expanded window must not leak into owner B");
	historyTexts(tail.messages, seedB.label, TOTAL - WINDOW, TOTAL);
	page = await historyPage(viewer, tail, true);
	assert.equal(page.historyStart, 0);
	historyTexts(page.messages, seedB.label, 0, TOTAL - WINDOW);
	expanded = await snapshot(viewer, (s) => shared(s, viewer, ownerB, historyB.conversationId));
	assert.equal(expanded.historyStart, 0);
	historyTexts(expanded.messages, seedB.label, 0, TOTAL);
	assert.equal((await historyPage(viewer, expanded, true)).messages.length, 0);
	console.log(
		"✓ colliding history IDs keep owner-specific caches; all:true reaches the beginning and then returns empty",
	);
	console.log("\nALL PASS (zero model requests)");
} catch (err) {
	console.error(err?.stack ?? err);
	if (serverLog) console.error(`\nIsolated server output:\n${serverLog}`);
	process.exitCode = 1;
} finally {
	for (const socket of sockets) socket.terminate();
	if (server && server.exitCode === null && server.signalCode === null) {
		const closed = new Promise((resolve) => server.once("close", resolve));
		server.kill("SIGKILL");
		await closed;
	}
	if (tmp) rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
