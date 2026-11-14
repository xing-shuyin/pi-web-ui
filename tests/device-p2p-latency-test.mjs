import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { Transform } from "node:stream";
import { createDeviceLanServer } from "../server/device-center/device-lan.ts";
import { connectDeviceP2P, createDeviceP2PTarget } from "../server/device-center/device-p2p.ts";

process.env.PI_DEVICE_P2P_TEST_LOOPBACK = "1";
const cleanup = [];
async function listen(server) {
	const sockets = new Set();
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	cleanup.push(async () => {
		for (const socket of sockets) socket.destroy();
		await new Promise((resolve) => server.close(resolve));
	});
	assert(server.address().port >= 8900);
	return server.address().port;
}
try {
	const backend = http.createServer((req, res) => res.end(req.url === "/api/health" ? "ok" : "authenticated desktop"));
	const port = await listen(backend);
	const lan = createDeviceLanServer({ localOrigin: `http://127.0.0.1:${port}` });
	cleanup.push(() => lan.close());
	let delayMs = 400;
	const delayedLan = {
		...lan,
		async issueGrant(options) {
			const grant = await lan.issueGrant(options);
			assert(grant);
			const proxy = net.createServer((downstream) => {
				const upstream = net.connect(grant.port, "127.0.0.1");
				const streams = [];
				const delayed = () => {
					let timer;
					const stream = new Transform({
						transform(chunk, encoding, done) {
							timer = setTimeout(() => done(null, chunk), delayMs);
						},
						destroy(error, done) {
							clearTimeout(timer);
							done(error);
						},
					});
					streams.push(stream);
					return stream;
				};
				const stop = () => {
					upstream.destroy();
					downstream.destroy();
					for (const stream of streams) stream.destroy();
				};
				upstream.on("error", stop);
				downstream.on("error", stop);
				upstream.on("close", stop);
				downstream.on("close", stop);
				downstream.pipe(delayed()).pipe(upstream).pipe(delayed()).pipe(downstream);
			});
			return { ...grant, port: await listen(proxy) };
		},
	};
	const target = createDeviceP2PTarget(delayedLan);
	cleanup.push(() => target.reset());
	const failures = [];
	const started = Date.now();
	const peer = await connectDeviceP2P(
		async (offer, signal) => ({ deviceP2P: await target.accept(offer, signal) }),
		AbortSignal.timeout(25000),
		(reason) => failures.push(reason),
	);
	assert(peer, `authenticated P2P failed: ${failures.join(", ")}`);
	cleanup.push(() => peer.connection.close());
	assert(Date.now() - started > 2000, "test must exceed the old two-second TLS probe");
	const body = await new Promise((resolve, reject) => {
		const req = https.get(
			`${peer.connection.origin}/desktop`,
			{ agent: peer.connection.agent, signal: AbortSignal.timeout(8000) },
			(res) => {
				let text = "";
				res.on("data", (chunk) => (text += chunk));
				res.on("end", () => resolve(text));
				res.on("error", reject);
			},
		);
		req.on("error", reject);
	});
	assert.equal(body, "authenticated desktop");
	console.log(`PASS real DataChannel + authenticated TLS/HTTP at 800 ms injected RTT (${Date.now() - started} ms)`);
	peer.connection.close();
	target.reset();
	delayMs = 0;
	const rejected = await connectDeviceP2P(async (offer, signal) => {
		const answer = await target.accept(offer, signal);
		assert(answer?.grant);
		return { deviceP2P: { ...answer, grant: { ...answer.grant, key: "A".repeat(43) } } };
	}, AbortSignal.timeout(15000));
	assert.equal(rejected, null, "wrong PSK must never be accepted");
	console.log("PASS wrong TLS key rejected");
} finally {
	for (const close of cleanup.reverse()) await close();
}
