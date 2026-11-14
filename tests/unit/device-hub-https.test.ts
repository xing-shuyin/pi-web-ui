import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import https from "node:https";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { WebSocket, WebSocketServer } from "ws";
import { httpsPlan, httpsUnits, certificateCommand } from "../../bin/hub-https-install.mjs";
import { secureHubSettings, enableHubHttps } from "../../bin/hub-https.mjs";
import { startHttpsGateway, startAcmeGateway } from "../../bin/hub-https-gateway.mjs";
import { parseHubArgs } from "../../bin/device-hub-cli.mjs";
import { DevicePortals } from "../../server/device-center/device-portals.js";
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
});
it("plans portable IP/domain certificates without copying another application configuration", () => {
	for (const host of ["203.0.113.10", "hub.example.com"]) {
		const p = httpsPlan({ publicUrl: "https://" + host, upstream: "http://127.0.0.1:8790" });
		const args = certificateCommand(p, "/opt/certbot");
		expect(args.includes("--ip-address")).toBe(host === "203.0.113.10");
		expect(args.includes("--required-profile")).toBe(host === "203.0.113.10");
		const units = httpsUnits(p, "/opt/node", "/opt/certbot", "shared-cert");
		expect(units[p.renew + ".service"]).toContain('"shared-cert"');
		expect(units[p.renew + ".service"]).not.toContain("--deploy-hook");
		expect(units[p.renew + ".timer"]).toContain("OnUnitActiveSec=6h");
		expect(JSON.stringify(units)).not.toMatch(/82\.156|sonic|ubuntu/);
	}
	for (const url of [
		"http://host.test",
		"https://localhost",
		"https://10.1.2.3",
		"https://host.test/path",
		"https://user:pass@host.test",
	])
		expect(() => httpsPlan({ publicUrl: url, upstream: "http://127.0.0.1:8790" })).toThrow();
	expect(() => httpsPlan({ publicUrl: "https://host.test", upstream: "http://external.test" })).toThrow();
	expect(parseHubArgs(["https", "--public-url", "https://hub.example.com"], {})).toEqual({
		command: "https",
		publicUrl: "https://hub.example.com",
	});
	expect(parseHubArgs(["install", "--public-url", "http://203.0.113.10:8790", "--https=off"], {})).toMatchObject({
		https: "off",
	});
});
it("preserves bindings/settings during migration and restores the prior configuration on HTTPS verification failure", async () => {
	const root = await mkdtemp(join(tmpdir(), "hub-https-"));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const config = join(root, "service.json");
	const saved = {
		PI_DEVICE_HUB_PUBLIC_URL: "http://203.0.113.10:8790",
		PI_DEVICE_HUB_PORT: "8790",
		PI_DEVICE_HUB_INSTANCE_ID: "owned",
		PI_DEVICE_HUB_DATA_DIR: root,
		PI_DEVICE_HUB_ALLOW_REGISTRATION: "0",
	};
	const original = JSON.stringify(saved);
	await writeFile(config, original);
	const portals = await DevicePortals.open(root, saved.PI_DEVICE_HUB_PUBLIC_URL, [], { pathAccess: true });
	await portals.assign("device-a", "account", "laptop");
	const result = secureHubSettings(saved);
	expect(result.settings.PI_DEVICE_HUB_PUBLIC_URL).toBe("https://203.0.113.10");
	expect(JSON.parse(result.settings.PI_DEVICE_HUB_LEGACY_ORIGINS)).toEqual([saved.PI_DEVICE_HUB_PUBLIC_URL]);
	expect(result.settings.PI_DEVICE_HUB_DATA_DIR).toBe(root);
	const run = vi.fn(),
		install = vi.fn(),
		wait = vi.fn(async (settings) => {
			const registry = await DevicePortals.open(root, settings.PI_DEVICE_HUB_PUBLIC_URL, [], { pathAccess: true });
			expect(registry.getAlias("device-a")).toBe("laptop");
			expect(registry.getOrigin("device-a")).toBe(settings.PI_DEVICE_HUB_PUBLIC_URL + "/device/device-a/");
		});
	await expect(
		enableHubHttps({
			plan: {
				root,
				config,
				manager: "systemctl",
				commands: { stop: [["--user", "stop", "hub"]], start: [["--user", "start", "hub"]] },
			},
			probe: async () => ({ instanceId: "owned" }),
			install,
			wait,
			run,
			log: () => {},
			verify: async () => {
				const registry = await DevicePortals.open(root, result.settings.PI_DEVICE_HUB_PUBLIC_URL, [], {
					pathAccess: true,
				});
				await registry.assign("device-b", "account", "new-device");
				throw Error("Untrusted certificate");
			},
		} as any),
	).rejects.toThrow("restored");
	expect(await readFile(config, "utf8")).toBe(original);
	expect(run).toHaveBeenCalledTimes(4);
	expect(install).toHaveBeenCalledTimes(1);
	const restored = await DevicePortals.open(root, saved.PI_DEVICE_HUB_PUBLIC_URL, [], { pathAccess: true });
	expect(restored.getAlias("device-a")).toBe("laptop");
	expect(restored.getAlias("device-b")).toBe("new-device");
});
it("serves only regular ACME challenge files and rejects traversal and management paths", async () => {
	const root = await mkdtemp(join(tmpdir(), "hub-acme-"));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const { mkdir } = await import("node:fs/promises");
	await mkdir(join(root, ".well-known/acme-challenge"), { recursive: true });
	await writeFile(join(root, ".well-known/acme-challenge", "test-token"), "proof");
	const server = await startAcmeGateway(root, 0, "127.0.0.1");
	cleanup.push(
		() =>
			new Promise<void>((r) => {
				server.closeAllConnections();
				server.close(() => r());
			}),
	);
	const address = server.address() as any;
	expect(address.port).toBeGreaterThanOrEqual(8900);
	const base = "http://127.0.0.1:" + address.port;
	expect(await (await fetch(base + "/.well-known/acme-challenge/test-token")).text()).toBe("proof");
	for (const path of [
		"/",
		"/setup",
		"/api/auth/login",
		"/.well-known/acme-challenge/../secret",
		"/.well-known/acme-challenge/test-token?secret",
	])
		expect((await fetch(base + path)).status).toBe(404);
});
const openssl = process.platform === "win32" ? "C:/Program Files/Git/usr/bin/openssl.exe" : "/usr/bin/openssl";
it.skipIf(!existsSync(openssl))(
	"proxies actual TLS HTTP and binary WebSockets, enforcing the public Host",
	async () => {
		const root = await mkdtemp(join(tmpdir(), "hub-tls-"));
		cleanup.push(() => rm(root, { recursive: true, force: true }));
		const cert = join(root, "cert.pem"),
			key = join(root, "key.pem");
		await new Promise<void>((r, j) => {
			const c = spawn(
				openssl,
				[
					"req",
					"-x509",
					"-newkey",
					"rsa:2048",
					"-nodes",
					"-keyout",
					key,
					"-out",
					cert,
					"-days",
					"2",
					"-subj",
					"/CN=hub.example.com",
					"-addext",
					"subjectAltName=DNS:hub.example.com",
				],
				{ windowsHide: true, stdio: "ignore" },
			);
			c.on("error", j);
			c.on("exit", (n) => (n ? j(Error("openssl failed")) : r()));
		});
		const backend = http.createServer((req, res) => {
			res.setHeader("x-proto", String(req.headers["x-forwarded-proto"]));
			req.pipe(res);
		});
		backend.listen(0, "127.0.0.1");
		await once(backend, "listening");
		const wss = new WebSocketServer({ server: backend });
		wss.on("connection", (ws) => ws.on("message", (data, binary) => ws.send(data, { binary })));
		cleanup.push(() => {
			for (const ws of wss.clients) ws.terminate();
			wss.close();
			backend.closeAllConnections();
			backend.close();
		});
		const gateway = await startHttpsGateway({
			publicUrl: "https://hub.example.com",
			upstream: "http://127.0.0.1:" + (backend.address() as any).port,
			cert,
			key,
			port: 0,
			host: "127.0.0.1",
		});
		cleanup.push(() => gateway.close());
		const port = (gateway.server.address() as any).port,
			ca = await readFile(cert);
		expect(port).toBeGreaterThanOrEqual(8900);
		const request = (host: string) =>
			new Promise<any>((r, j) => {
				const req = https.request(
					{
						host: "127.0.0.1",
						port,
						path: "/api/echo",
						method: "POST",
						servername: "hub.example.com",
						ca,
						headers: { Host: host, "x-forwarded-proto": "spoof" },
					},
					(res) => {
						let data = "";
						res.on("data", (b) => (data += b));
						res.on("end", () => r({ status: res.statusCode, proto: res.headers["x-proto"], data }));
					},
				);
				req.on("error", j);
				req.end("payload");
			});
		expect(await request("hub.example.com")).toEqual({ status: 200, proto: "https", data: "payload" });
		expect((await request("evil.example")).status).toBe(421);
		const ws = new WebSocket("wss://127.0.0.1:" + port + "/ws", {
			servername: "hub.example.com",
			ca,
			headers: { Host: "hub.example.com" },
		} as any);
		cleanup.push(() => ws.terminate());
		await once(ws, "open");
		const reply = once(ws, "message");
		const bytes = Buffer.alloc(128 * 1024, 71);
		ws.send(bytes);
		expect((await reply)[0]).toEqual(bytes);
		ws.close();
	},
);
