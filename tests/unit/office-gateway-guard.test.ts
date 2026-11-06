import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { request } from "node:http";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const guard = fileURLToPath(new URL("../../plugins/office/gateway-guard.cjs", import.meta.url));
let child: ChildProcessWithoutNullStreams;
let port: number;
let exited: Promise<void>;

beforeAll(async () => {
	child = spawn(
		process.execPath,
		[
			"--require",
			guard,
			"--require",
			guard,
			"--eval",
			`
		const http = require('node:http');
		const server = http.createServer((req, res) => { res.setHeader('x-observed-fetch-mode', req.headers['sec-fetch-mode'] || 'absent'); res.end('gateway-handler'); });
		server.on('upgrade', (req, socket) => socket.end('HTTP/1.1 101 Switching Protocols\\r\\nConnection: Upgrade\\r\\nUpgrade: websocket\\r\\n\\r\\ngateway-upgrade'));
		server.listen(0, '127.0.0.1', () => console.log(server.address().port));
	`,
		],
		{ stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
	);
	exited = new Promise((done) => child.once("exit", () => done()));
	port = await new Promise<number>((done, reject) => {
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => reject(new Error("Gateway guard harness startup timed out")), 5000);
		child.stderr.on("data", (chunk) => {
			stderr = (stderr + chunk).slice(-4096);
		});
		child.once("error", reject);
		child.once("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`Gateway harness exited ${code}: ${stderr}`));
		});
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
			if (stdout.includes("\n")) {
				clearTimeout(timer);
				done(Number(stdout.trim()));
			}
		});
	});
});
afterAll(async () => {
	if (!child) return;
	child.kill();
	await exited;
});

function httpRequest(headers: Record<string, string> = {}, method = "GET") {
	return new Promise<{ status: number; body: string; headers: Record<string, unknown> }>((done, reject) => {
		const req = request({ host: "127.0.0.1", port, path: "/uf/test", method, headers }, (res) => {
			let body = "";
			res.on("data", (chunk) => {
				body += chunk;
			});
			res.on("end", () => done({ status: res.statusCode!, body, headers: res.headers }));
		});
		req.setTimeout(3000, () => req.destroy(new Error("HTTP harness timed out")));
		req.on("error", reject);
		req.end();
	});
}
function rawRequest(headers: string[]) {
	return new Promise<string>((done, reject) => {
		const socket = connect(port, "127.0.0.1", () => {
			socket.write(`GET /uf/test/events HTTP/1.1\r\n${headers.join("\r\n")}\r\n\r\n`);
		});
		let text = "";
		socket.setTimeout(3000, () => socket.destroy(new Error("Socket harness timed out")));
		socket.on("data", (chunk) => {
			text += chunk;
		});
		socket.on("error", reject);
		socket.on("end", () => done(text));
	});
}

describe("Office gateway preload browser admission", () => {
	it("preserves internal HTTP and WebSocket requests without browser headers", async () => {
		expect(await httpRequest()).toMatchObject({ status: 200, body: "gateway-handler" });
		const upgraded = await rawRequest([`Host: 127.0.0.1:${port}`, "Connection: Upgrade", "Upgrade: websocket"]);
		expect(upgraded).toContain("101 Switching Protocols");
		expect(upgraded).toContain("gateway-upgrade");
	});

	it("admits real Node fetch with Undici's Sec-Fetch-Mode header", async () => {
		const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) });
		expect(response.status).toBe(200);
		expect(response.headers.get("x-observed-fetch-mode")).toBe("cors");
		expect(await response.text()).toBe("gateway-handler");
	});

	it.each(["Sec-Fetch-Site", "Sec-Fetch-Dest", "Sec-Fetch-User", "Origin"])(
		"rejects native fetch when browser header %s is present alongside mode",
		async (name) => {
			const response = await fetch(`http://127.0.0.1:${port}/`, {
				headers: { [name]: name === "Origin" ? "null" : "" },
				signal: AbortSignal.timeout(3000),
			});
			expect(response.status).toBe(403);
			expect(await response.text()).not.toContain("gateway-handler");
		},
	);

	it.each(["https://attacker.example", "null", ""])(
		"rejects HTTP Origin %j including opaque and empty values",
		async (origin) => {
			const response = await httpRequest({ Origin: origin }, "POST");
			expect(response.status).toBe(403);
			expect(response.body).not.toContain("gateway-handler");
			expect(response.headers["access-control-allow-origin"]).toBeUndefined();
		},
	);

	it.each(["cross-site", "same-origin", "none", ""])(
		"rejects browser Fetch Metadata %j including navigation",
		async (site) => {
			expect((await httpRequest({ "Sec-Fetch-Site": site })).status).toBe(403);
		},
	);

	it("rejects preflight, other Fetch Metadata and legacy WebSocket Origin headers", async () => {
		expect((await httpRequest({ Origin: "https://attacker.example" }, "OPTIONS")).status).toBe(403);
		expect((await httpRequest({ "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" })).status).toBe(403);
		expect((await httpRequest({ "Sec-WebSocket-Origin": "https://attacker.example" })).status).toBe(403);
	});

	it.each(["attacker.example", "localhost", "127.0.0.1", "127.0.0.1:1"])(
		"rejects unpinned Host %j to prevent DNS rebinding",
		async (host) => {
			expect((await httpRequest({ Host: host })).status).toBe(403);
		},
	);

	it("rejects missing and duplicate Host headers", async () => {
		expect(await rawRequest(["Connection: close"])).toMatch(/^HTTP\/1\.1 (?:400|403) /);
		expect(await rawRequest([`Host: 127.0.0.1:${port}`, `Host: 127.0.0.1:${port}`, "Connection: close"])).toContain(
			"403 Forbidden",
		);
	});

	it.each([
		"Origin: https://attacker.example",
		"Origin: null",
		"Origin:",
		"Sec-Fetch-Site: cross-site",
		"Sec-Fetch-Dest: websocket",
		"Sec-Fetch-User: ?1",
	])("blocks upgrade before the gateway listener: %s", async (header) => {
		const response = await rawRequest([`Host: 127.0.0.1:${port}`, "Connection: Upgrade", "Upgrade: websocket", header]);
		expect(response).toContain("403 Forbidden");
		expect(response).not.toContain("gateway-upgrade");
	});
});
