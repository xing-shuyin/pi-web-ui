// Real >1 GiB websocket transfer. Only isolated temporary files; never reads/writes the user's clipboard.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, open, readFile, readdir, rm, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { clipboardConnection } from "../server/device-center/desktop-clipboard-connection.ts";
import { fileClipboardSource, diskClipboardSink } from "../server/device-center/desktop-clipboard-transfer.ts";
import { clipboardBrowserBridge } from "../server/device-center/desktop-clipboard-bridge.ts";

const root = await mkdtemp(join(tmpdir(), "pi-clipboard-large-test-"));
const clients = [],
	servers = [];
let peak = process.memoryUsage().rss,
	notify,
	received,
	resolveReceived,
	rejectReceived;
const completion = new Promise((resolve, reject) => {
	resolveReceived = resolve;
	rejectReceived = reject;
});
const source = join(root, "archive.zip"),
	size = 1024 * 1024 * 1024 + 1048576;
const memoryTimer = setInterval(() => {
	peak = Math.max(peak, process.memoryUsage().rss);
}, 25);
const started = Date.now();
let bridge;
async function endpoint(backend, port) {
	const server = createServer(),
		wss = new WebSocketServer({ server, maxPayload: 49152, perMessageDeflate: false });
	servers.push({ server, wss });
	wss.on("connection", (ws) => clipboardConnection(ws, backend, true));
	server.listen(port, "127.0.0.1");
	await once(server, "listening");
	return `ws://127.0.0.1:${port}`;
}
async function digest(path) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}
const timeout = setTimeout(() => rejectReceived(new Error("Transfer timed out")), 240000);
try {
	const file = await open(source, "wx");
	await file.truncate(size);
	for (const offset of [0, Math.floor(size / 2), size - 4096])
		await file.write(Buffer.alloc(4096, offset === 0 ? 0x52 : 0xa5), 0, 4096, offset);
	await file.close();
	const localUrl = await endpoint(
		{
			read: async () => undefined,
			write: async () => {},
			watch: (fn) => {
				notify = fn;
				return () => {
					notify = undefined;
				};
			},
			readSource: (signal, max) => fileClipboardSource([source], signal, max),
		},
		8995,
	);
	const remoteUrl = await endpoint(
		{
			read: async () => undefined,
			write: async () => {
				throw new Error("Unexpected buffered write");
			},
			watch: () => () => {},
			receiveFiles: (offer, signal) =>
				diskClipboardSink(
					offer,
					async (paths) => {
						received = paths[0];
						resolveReceived();
					},
					signal,
					root,
				),
		},
		8996,
	);
	let remote;
	const errors = [];
	let readyResolve;
	const ready = new Promise((resolve) => {
		readyResolve = resolve;
	});
	bridge = clipboardBrowserBridge({
		open: () => {
			const ws = new WebSocket(localUrl);
			clients.push(ws);
			return ws;
		},
		id: () => randomUUID(),
		state: (code) => {
			if (code === "clipboard-ready") readyResolve();
			else if (code !== "clipboard-connecting" && !code.startsWith("clipboard-progress:")) {
				errors.push(code);
				rejectReceived(new Error(code));
			}
		},
		post: (message) => {
			const value = message.payload;
			if (value.type === "bridge-stop") {
				remote?.close();
				return;
			}
			if (value.type === "bridge-start") {
				remote = new WebSocket(remoteUrl);
				clients.push(remote);
				remote.on("message", (raw) => {
					const packet = JSON.parse(raw.toString());
					bridge.receive({ type: "desktop-clipboard", channel: message.channel, payload: packet });
					if (packet.type === "clipboard-capabilities")
						remote.send(
							JSON.stringify({
								type: "start",
								read: false,
								write: true,
								streamFiles: packet.streamFiles && value.capabilities.streamFiles,
								maxBytes: value.capabilities.maxFileBytes,
							}),
						);
				});
				return;
			}
			remote.send(JSON.stringify(value));
		},
	});
	bridge.set("send");
	await ready;
	assert(notify);
	notify();
	await completion;
	assert.equal((await stat(received)).size, size);
	assert.equal(await digest(source), await digest(received));
	assert.deepEqual(errors, []);
	assert(peak < 400 * 1024 * 1024, `Memory not bounded: ${peak}`);
	// An interrupted receiving transfer removes its own staging directory and never applies partial files.
	const controller = new AbortController();
	const fixture = await fileClipboardSource([source], controller.signal, size);
	let applied = false;
	const sink = await diskClipboardSink(
		fixture.offer,
		async () => {
			applied = true;
		},
		controller.signal,
		root,
	);
	await sink.write(0, 0, Buffer.alloc(4096));
	controller.abort();
	await sink.abort();
	await fixture.close();
	assert.equal(applied, false);
	assert.equal((await readdir(root)).filter((name) => name.startsWith("pi-web-clipboard-")).length, 1);
	console.log(
		JSON.stringify({
			bytes: size,
			sha256: await digest(received),
			peakRssMiB: Math.round(peak / 1048576),
			seconds: Math.round((Date.now() - started) / 1000),
			cleanup: true,
		}),
	);
} finally {
	clearTimeout(timeout);
	clearInterval(memoryTimer);
	bridge?.close();
	for (const ws of clients) ws.terminate();
	for (const { server, wss } of servers) {
		for (const ws of wss.clients) ws.terminate();
		wss.close();
		await new Promise((resolve) => server.close(resolve));
	}
	await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
