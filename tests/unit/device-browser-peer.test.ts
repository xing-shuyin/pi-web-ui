import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { createDeviceLanServer, probeDeviceTunnel } from "../../server/device-center/device-lan.js";
import { createBrowserPeerGateway } from "../../server/device-center/browser-peer-gateway.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});
function record(type: number, payload = Buffer.alloc(0)) {
	const header = Buffer.alloc(5);
	header[0] = type;
	header.writeUInt32BE(payload.length, 1);
	return Buffer.concat([header, payload]);
}
async function fixture() {
	const hits: http.IncomingHttpHeaders[] = [];
	const app = http.createServer((req, res) => {
		if (req.url === "/api/health") return res.end("ok");
		hits.push(req.headers);
		req.resume();
		res.setHeader("set-cookie", "secret=response");
		res.end("target response");
	});
	app.listen(0, "127.0.0.1");
	await once(app, "listening");
	const port = (app.address() as net.AddressInfo).port;
	expect(port).toBeGreaterThanOrEqual(8900);
	cleanup.push(() => {
		app.closeAllConnections();
		app.close();
	});
	const lan = createDeviceLanServer({ localOrigin: `http://127.0.0.1:${port}`, localAuthToken: "device-secret" });
	cleanup.push(lan.close);
	const grant = await lan.issueGrant({ loopbackOnly: true });
	expect(grant).toBeTruthy();
	const connection = await probeDeviceTunnel(grant!, grant!.port, { timeoutMs: 2000 });
	expect(connection).toBeTruthy();
	const gateway = await createBrowserPeerGateway(connection!);
	cleanup.push(gateway.close);
	const connect = async () => {
		const socket = net.connect(gateway.port, "127.0.0.1");
		socket.on("error", () => {});
		cleanup.push(() => {
			socket.destroy();
		});
		await once(socket, "connect");
		return socket;
	};
	const open = (extra: object = {}) =>
		record(
			0,
			Buffer.from(
				JSON.stringify({
					key: gateway.key,
					kind: "http",
					method: "GET",
					path: "/api/echo",
					headers: {},
					...extra,
				}),
			),
		);
	return { hits, gateway, connect, open };
}
describe("browser peer gateway boundaries", () => {
	it("authenticates fragmented streams, strips browser credentials and keeps device credentials local", async () => {
		const f = await fixture(),
			socket = await f.connect();
		const output: Buffer[] = [];
		let pending = Buffer.alloc(0);
		const ended = new Promise<void>((resolve) =>
			socket.on("data", (data) => {
				pending = Buffer.concat([pending, Buffer.from(data)]);
				while (pending.length >= 5 && pending.length >= 5 + pending.readUInt32BE(1)) {
					const size = pending.readUInt32BE(1),
						type = pending[0],
						data = pending.subarray(5, size + 5);
					if (type === 1) expect(JSON.parse(data.toString()).headers["set-cookie"]).toBeUndefined();
					if (type === 2) output.push(data);
					pending = pending.subarray(size + 5);
					if (type === 3) resolve();
				}
			}),
		);
		const open = f.open({
			headers: {
				authorization: "Bearer browser-secret",
				cookie: "hub=secret",
				origin: "https://other.invalid",
				"x-test": "kept",
			},
		});
		for (let i = 0; i < open.length; i += 7) socket.write(open.subarray(i, i + 7));
		socket.write(record(3));
		await ended;
		expect(Buffer.concat(output).toString()).toBe("target response");
		expect(f.hits).toHaveLength(1);
		expect(f.hits[0].authorization).toBe("Bearer device-secret");
		expect(f.hits[0].cookie).toBeUndefined();
		expect(f.hits[0]["x-test"]).toBe("kept");
	});
	it("rejects unauthorized keys, management paths, external targets and malformed records before forwarding", async () => {
		const f = await fixture();
		for (const bytes of [
			f.open({ key: "0".repeat(64) }),
			f.open({ path: "/setup" }),
			f.open({ path: "/api/device-desktop/local/enable" }),
			f.open({ path: "//other.invalid/api/echo" }),
			f.open({ path: "/__browser_p2p" }),
			f.open({ method: "CONNECT" }),
			record(2, Buffer.from("not opened")),
			Buffer.from([0, 0, 1, 0, 1]),
		]) {
			const socket = await f.connect(),
				closed = once(socket, "close");
			socket.write(bytes);
			await closed;
		}
		expect(f.hits).toHaveLength(0);
	});
	it("closes active streams on session revocation", async () => {
		const f = await fixture(),
			socket = await f.connect(),
			closed = once(socket, "close");
		f.gateway.close();
		await closed;
		expect(socket.destroyed).toBe(true);
	});
});
