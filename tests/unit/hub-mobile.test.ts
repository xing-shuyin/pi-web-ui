import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http, { type IncomingHttpHeaders, type Server } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { createDeviceHub } from "../../server/device-center/hub.js";
import { createDeviceRelay } from "../../server/device-center/relay.js";
import { createDeviceConnector } from "../../server/device-center/connector.js";
import {
	createAccountAuth,
	createNativeAccountAuth,
	hashPassword,
	SESSION_TTL,
} from "../../server/device-center/hub-auth.js";
import { hashSecret, readPersistedHub } from "../../server/device-center/store.js";

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});
async function listen(server: Server) {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return (server.address() as { port: number }).port;
}
async function fixture() {
	const dataDir = await mkdtemp(join(tmpdir(), "hub-mobile-"));
	cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
	const local = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			res.setHeader("access-control-allow-origin", "https://untrusted.test");
			const path = req.url!.split("?")[0];
			if (path.startsWith("/themes/")) {
				res.setHeader(
					"content-type",
					path === "/themes/html.css"
						? "text/html"
						: path === "/themes/script.css"
							? "application/javascript"
							: path === "/themes/json.css"
								? "application/json"
								: "text/css; charset=utf-8",
				);
				res.end(":root { --bg: #123456; }");
				return;
			}
			if (path === "/icons/icon-192.png") {
				res.setHeader("content-type", req.url!.includes("html=1") ? "text/html" : "image/png");
				res.end(
					Buffer.from(
						"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFz0AAAAASUVORK5CYII=",
						"base64",
					),
				);
				return;
			}
			res.setHeader(
				"content-type",
				path === "/api/html" ? "text/html" : path === "/api/script" ? "text/javascript" : "application/json",
			);
			res.end(JSON.stringify({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() }));
		});
	});
	const localWs = new WebSocketServer({ server: local });
	localWs.on("connection", (ws, req) => ws.send(JSON.stringify(req.headers)));
	const localPort = await listen(local);
	cleanups.push(() => {
		localWs.close();
		local.closeAllConnections();
		local.close();
	});
	const server = http.createServer();
	const port = await listen(server);
	const publicUrl = `http://127.0.0.1:${port}`;
	let relay: ReturnType<typeof createDeviceRelay>;
	const hub = await createDeviceHub({
		dataDir,
		publicUrl,
		server,
		pathAccess: true,
		isOnline: (id) => relay?.isOnline(id) ?? false,
	});
	cleanups.push(() => hub.close());
	const passwordHash = await hashPassword("mobile-test-password");
	await hub.store.transact((draft) => {
		draft.accounts.push(
			{ id: "alice", username: "alice", passwordHash, createdAt: Date.now() },
			{ id: "bob", username: "bob", passwordHash, createdAt: Date.now() },
		);
		for (const [id, accountId] of [
			["first", "alice"],
			["second", "alice"],
			["offline", "alice"],
			["foreign", "bob"],
		])
			draft.devices.push({
				id,
				accountId,
				name: `Device ${id}`,
				...(id === "first" ? { remark: "desk" } : {}),
				credentialHash: hashSecret(`credential-${id}`),
				createdAt: Date.now(),
			});
	});
	relay = createDeviceRelay({
		server,
		publicUrl,
		pathAccess: true,
		getAccount: hub.getRelayAccount,
		authenticateDevice: (id, credential) => hub.store.authenticateDevice(id, credential),
		ownsDevice: (account, id) => hub.store.getDeviceOwner(id) === account,
	});
	hub.setRelay(relay);
	cleanups.push(() => relay.close());
	for (const id of ["first", "second", "foreign"]) {
		const connector = createDeviceConnector({
			hubUrl: publicUrl,
			deviceId: id,
			credential: `credential-${id}`,
			localOrigin: `http://127.0.0.1:${localPort}`,
			localAuthToken: `local-${id}`,
			onTask: async () => "done",
		});
		cleanups.push(() => connector.close());
	}
	await vi.waitFor(() => expect(["first", "second", "foreign"].every((id) => relay.isOnline(id))).toBe(true));
	async function request(
		path: string,
		{
			method = "GET",
			body,
			token,
			origin = "capacitor://localhost",
			headers = {},
		}: {
			method?: string;
			body?: unknown;
			token?: string;
			origin?: string | null;
			headers?: Record<string, string>;
		} = {},
	) {
		return new Promise<{ status: number; headers: IncomingHttpHeaders; data: any; text: string }>((resolve, reject) => {
			const req = http.request(
				publicUrl + path,
				{
					method,
					headers: {
						...(origin === null ? {} : { origin }),
						"content-type": "application/json",
						...(token ? { authorization: `Bearer ${token}` } : {}),
						...headers,
					},
				},
				(res) => {
					const chunks: Buffer[] = [];
					res.on("data", (chunk) => chunks.push(chunk));
					res.on("end", () => {
						const text = Buffer.concat(chunks).toString();
						let data;
						try {
							data = JSON.parse(text);
						} catch {}
						resolve({ status: res.statusCode!, headers: res.headers, data, text });
					});
					res.on("error", reject);
				},
			);
			req.on("error", reject);
			req.end(body === undefined ? undefined : JSON.stringify(body));
		});
	}
	async function login(username = "alice", origin = "capacitor://localhost") {
		const result = await request("/api/mobile-hub/login", {
			method: "POST",
			body: { username, password: "mobile-test-password" },
			origin,
		});
		expect(result.status).toBe(200);
		expect(result.headers["set-cookie"]).toBeUndefined();
		return result.data.token as string;
	}
	async function access(token: string, id = "first", origin = "capacitor://localhost") {
		const result = await request(`/api/mobile-hub/devices/${id}/access`, { method: "POST", body: {}, token, origin });
		expect(result.status).toBe(200);
		expect(result.data.token).toBe("");
		return new URL(result.data.serverUrl).pathname;
	}
	return { hub, relay, dataDir, publicUrl, request, login, access };
}

function websocket(url: string, origin: string | null, expectOpen: boolean) {
	return new Promise<any>((resolve, reject) => {
		const ws = new WebSocket(url, { ...(origin === null ? {} : { origin }), handshakeTimeout: 2000 });
		ws.on("message", (data) => {
			ws.close();
			resolve(JSON.parse(data.toString()));
		});
		ws.on("open", () => {
			if (!expectOpen) {
				ws.terminate();
				reject(new Error("Unexpected websocket acceptance"));
			}
		});
		ws.on("error", (error) => (expectOpen ? reject(error) : resolve(false)));
	});
}

describe("Hub native mobile API", () => {
	it("persists only hashed native sessions, scopes devices, and keeps bearer out of cookie/admin auth", async () => {
		const f = await fixture();
		expect((await f.request("/api/mobile-hub/devices")).status).toBe(401);
		expect(
			(await f.request("/api/mobile-hub/login", { method: "POST", body: { username: "alice", password: "wrong" } }))
				.status,
		).toBe(401);
		const token = await f.login();
		expect((await f.request("/api/mobile-hub/devices", { token })).data.devices).toEqual([
			{ id: "first", name: "Device first", remark: "desk", online: true },
			{ id: "second", name: "Device second", online: true },
			{ id: "offline", name: "Device offline", online: false },
		]);
		const persisted = await readPersistedHub(f.dataDir);
		expect(persisted.sessions[0]).toMatchObject({ hash: hashSecret(token), accountId: "alice" });
		expect(JSON.stringify(persisted)).not.toContain(token);
		expect(persisted.sessions[0].expiresAt - Date.now()).toBeGreaterThan(SESSION_TTL - 5000);
		const req = {
			headers: { cookie: `device_hub=${token}`, authorization: `Bearer ${token}` },
		} as http.IncomingMessage;
		expect(createAccountAuth(f.hub.store, f.publicUrl).getAccount(req)).toBeNull();
		expect(createNativeAccountAuth(f.hub.store).getSession(req)?.account.id).toBe("alice");
		expect((await f.request("/api/devices", { token, origin: f.publicUrl })).status).toBe(401);
		expect(
			(await f.request("/api/system/upgrade", { method: "POST", body: {}, token, origin: f.publicUrl })).status,
		).toBe(401);
		const browser = await f.request("/api/auth/login", {
			method: "POST",
			body: { username: "alice", password: "mobile-test-password" },
			origin: f.publicUrl,
		});
		const cookie = browser.headers["set-cookie"]![0].split(";")[0];
		expect((await f.request("/api/devices", { origin: f.publicUrl, headers: { cookie } })).status).toBe(200);
		expect((await f.request("/api/mobile-hub/devices", { headers: { cookie } })).status).toBe(401);
		expect((await f.request("/api/mobile-hub/devices", { token: cookie.split("=")[1] })).status).toBe(401);
		expect(
			(await f.request("/api/mobile-hub/devices/foreign/access", { method: "POST", body: {}, token })).status,
		).toBe(404);
		expect(
			(await f.request("/api/mobile-hub/devices/offline/access", { method: "POST", body: {}, token })).status,
		).toBe(503);
	});

	it("limits login and accepts only precise native Origins without relaxing browser Host/CSRF", async () => {
		const f = await fixture();
		for (const origin of [
			"null",
			"https://evil.test",
			"https://localhost.evil.test",
			"http://localhost",
			"capacitor://localhost:123",
		]) {
			const rejected = await f.request("/api/mobile-hub/login", { method: "POST", body: {}, origin });
			expect(rejected.status).toBe(403);
			expect(rejected.headers["access-control-allow-origin"]).toBeUndefined();
		}
		expect((await f.request("/api/mobile-hub/login", { method: "POST", body: {}, origin: null })).status).toBe(403);
		const preflight = await f.request("/api/mobile-hub/devices", { method: "OPTIONS", origin: "https://localhost" });
		expect(preflight.status).toBe(204);
		expect(preflight.headers["access-control-allow-origin"]).toBe("https://localhost");
		expect((await f.request("/api/mobile-hub/devices", { headers: { host: "evil.test" } })).status).toBe(421);
		expect((await f.request("/api/auth/login", { method: "POST", body: {} })).status).toBe(403);
		for (let index = 0; index < 10; index++)
			expect((await f.request("/api/mobile-hub/login", { method: "POST", body: {} })).status).toBe(400);
		expect((await f.request("/api/auth/login", { method: "POST", body: {}, origin: f.publicUrl })).status).toBe(429);
	});

	it("switches devices using private capabilities and preserves native CORS and local token injection for HTTP/WS", async () => {
		const f = await fixture();
		const token = await f.login();
		const first = await f.access(token),
			second = await f.access(token, "second", "https://localhost");
		expect(first).not.toBe(second);
		const response = await f.request(first + "/api/state", { method: "POST", body: { hello: "native" } });
		expect(response.status).toBe(200);
		expect(response.headers["access-control-allow-origin"]).toBe("capacitor://localhost");
		expect(response.data.headers.authorization).toBe("Bearer local-first");
		expect(response.data.body).toBe(JSON.stringify({ hello: "native" }));
		expect((await f.request(second + "/api/state", { origin: "https://localhost" })).data.headers.authorization).toBe(
			"Bearer local-second",
		);
		const preflight = await f.request(first + "/api/state", { method: "OPTIONS" });
		expect(preflight.status).toBe(204);
		expect(preflight.headers["access-control-allow-origin"]).toBe("capacitor://localhost");
		for (const origin of [null, "null", f.publicUrl, "https://evil.test", "https://localhost"]) {
			expect((await f.request(first + "/api/state", { origin })).status).toBe(403);
			expect(await websocket(f.publicUrl.replace("http:", "ws:") + first + "/ws", origin, false)).toBe(false);
		}
		const wsHeaders = await websocket(
			f.publicUrl.replace("http:", "ws:") + first + "/ws",
			"capacitor://localhost",
			true,
		);
		expect(wsHeaders.authorization).toBe("Bearer local-first");
		expect((await f.request(first.replace("/first/", "/second/") + "/api/state")).status).toBe(403);
		expect((await f.request(first + "/")).status).toBe(403);
		expect((await f.request(first + "/api/state", { origin: null })).status).toBe(403);
		expect((await f.request(first + "/api/html")).status).toBe(415);
		const browserToken = "browser-session";
		await f.hub.store.transact((draft) =>
			draft.sessions.push({ hash: hashSecret(browserToken), accountId: "alice", expiresAt: Date.now() + SESSION_TTL }),
		);
		const wrapper = await f.request("/device/first/", {
			origin: f.publicUrl,
			headers: { cookie: `device_hub=${browserToken}` },
		});
		const opaqueBase = /\/device\/first\/__relay\/[a-f0-9]{64}\//.exec(wrapper.text)![0];
		expect((await f.request(opaqueBase + "api/state")).status).toBe(403);
		expect((await f.request(opaqueBase + "api/state", { origin: "null" })).headers["access-control-allow-origin"]).toBe(
			"null",
		);
		expect(
			await websocket(f.publicUrl.replace("http:", "ws:") + opaqueBase + "ws", "capacitor://localhost", false),
		).toBe(false);
	});

	it("serves only confirmed CSS and icon resources with safe MIME, retaining native Origin and method checks", async () => {
		const f = await fixture();
		const cap = await f.access(await f.login());
		for (const path of ["/themes/night.css?version=1", "/themes/bases/flow-base.css"]) {
			const css = await f.request(cap + path);
			expect(css.status).toBe(200);
			expect(css.text).toBe(":root { --bg: #123456; }");
			expect(css.headers["content-type"]).toBe("text/css; charset=utf-8");
			expect(css.headers["access-control-allow-origin"]).toBe("capacitor://localhost");
			const head = await f.request(cap + path, { method: "HEAD" });
			expect(head.status).toBe(200);
			expect(head.text).toBe("");
		}
		const icon = await f.request(cap + "/icons/icon-192.png");
		expect(icon.status).toBe(200);
		expect(icon.headers["content-type"]).toBe("image/png");
		for (const method of ["POST", "PUT"]) {
			for (const path of ["/themes/night.css", "/icons/icon-192.png"])
				expect((await f.request(cap + path, { method, body: {} })).status).toBe(403);
		}
		for (const path of [
			"/themes/index.js",
			"/themes/page.html",
			"/assets/index.js",
			"/uploads/image.png",
			"/fonts/theme.woff2",
			"/icons/other.png",
		])
			expect((await f.request(cap + path)).status).toBe(403);
		for (const path of [
			"/themes/html.css",
			"/themes/script.css",
			"/themes/json.css",
			"/icons/icon-192.png?html=1",
			"/api/html",
			"/api/script",
		])
			expect((await f.request(cap + path)).status).toBe(415);
		for (const origin of [null, "null", "https://evil.test"])
			expect((await f.request(cap + "/themes/night.css", { origin })).status).toBe(403);
		// A rejected resource response must leave the existing device relay usable.
		expect((await f.request(cap + "/api/state")).status).toBe(200);
	});

	it("revokes capabilities on logout, session expiry, ownership changes and device revocation, with eight hour grants", async () => {
		const f = await fixture();
		const token = await f.login();
		const cap = await f.access(token);
		await f.hub.store.transact((draft) => {
			draft.devices.find((device) => device.id === "first")!.accountId = "bob";
		});
		expect((await f.request(cap + "/api/state")).status).toBe(403);
		await f.hub.store.transact((draft) => {
			draft.devices.find((device) => device.id === "first")!.accountId = "alice";
		});
		const now = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(now + 8 * 60 * 60 * 1000 + 1);
		expect((await f.request(cap + "/api/state")).status).toBe(403);
		vi.restoreAllMocks();
		const fresh = await f.access(token);
		expect((await f.request("/api/mobile-hub/logout", { method: "POST", body: {}, token })).status).toBe(200);
		expect((await f.request("/api/mobile-hub/devices", { token })).status).toBe(401);
		expect((await f.request(fresh + "/api/state")).status).toBe(403);
		expect(await websocket(f.publicUrl.replace("http:", "ws:") + fresh + "/ws", "capacitor://localhost", false)).toBe(
			false,
		);
		const expiring = await f.login(),
			expiringCap = await f.access(expiring);
		await f.hub.store.transact((draft) => {
			draft.sessions.find((session) => session.hash === hashSecret(expiring))!.expiresAt = Date.now() - 1;
		});
		expect((await f.request("/api/mobile-hub/devices", { token: expiring })).status).toBe(401);
		expect((await f.request(expiringCap + "/api/state")).status).toBe(403);
		const lastToken = await f.login(),
			lastCap = await f.access(lastToken);
		await f.hub.store.transact((draft) => {
			draft.devices = draft.devices.filter((device) => device.id !== "first");
		});
		expect((await f.request(lastCap + "/api/state")).status).toBe(403);
	});

	it("scopes central push registration and authoritative device events, rejecting spoofed identities", async () => {
		vi.stubEnv("PI_WEB_JPUSH_APP_KEY", "hub-test-key");
		vi.stubEnv("PI_WEB_JPUSH_MASTER_SECRET", "hub-test-secret");
		const pushes = vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 }));
		vi.stubGlobal("fetch", pushes);
		const f = await fixture();
		const alice = await f.login(),
			bob = await f.login("bob");
		const phone = { deviceId: randomUUID(), registrationId: "registration-phone", platform: "android" };
		expect((await f.request("/api/mobile-push/devices", { method: "POST", body: phone, token: alice })).status).toBe(
			200,
		);
		expect(
			(await f.request(`/api/mobile-push/status?deviceId=${phone.deviceId}`, { token: alice })).data.device?.deviceId,
		).toBe(phone.deviceId);
		expect(
			(await f.request(`/api/mobile-push/status?deviceId=${phone.deviceId}`, { token: bob })).data.device,
		).toBeNull();
		expect(
			(
				await f.request("/api/mobile-push/status", {
					headers: { authorization: "Bearer credential-first", "x-device-id": "first" },
				})
			).status,
		).toBe(401);
		const event = {
			eventId: "event-one",
			kind: "done",
			clientId: "client",
			sessionId: "session",
			occurredAt: Date.now(),
		};
		const headers = { authorization: "Bearer credential-first", "x-device-id": "first" };
		const otherPhone = { ...phone, deviceId: randomUUID(), registrationId: "registration-bob" };
		expect((await f.request("/api/mobile-push/devices", { method: "POST", body: otherPhone, token: bob })).status).toBe(
			200,
		);
		expect((await f.request("/api/agent/mobile-notifications", { method: "POST", body: event, headers })).status).toBe(
			200,
		);
		await vi.waitFor(() => expect(pushes).toHaveBeenCalledTimes(1));
		const pushed = JSON.parse(pushes.mock.calls[0][1]!.body as string);
		expect(pushed.audience.registration_id).toEqual([phone.registrationId]);
		expect(pushed.notification.android.extras.deviceId).toBe("first");
		expect(pushed.notification.android.title).toContain("Device first");
		expect(
			(
				await f.request("/api/agent/mobile-notifications", {
					method: "POST",
					body: { ...event, kind: "arbitrary" },
					headers,
				})
			).status,
		).toBe(400);
		for (const forged of [{ deviceId: "foreign" }, { deviceName: "fake" }, { accountId: "bob" }, { scopeId: "bob" }])
			expect(
				(await f.request("/api/agent/mobile-notifications", { method: "POST", body: { ...event, ...forged }, headers }))
					.status,
			).toBe(400);
		expect(
			(
				await f.request("/api/agent/mobile-notifications", {
					method: "POST",
					body: event,
					headers: { ...headers, "x-device-id": "foreign" },
				})
			).status,
		).toBe(401);
		await f.hub.store.transact((draft) => {
			draft.devices = draft.devices.filter((device) => device.id !== "first");
		});
		expect((await f.request("/api/agent/mobile-notifications", { method: "POST", body: event, headers })).status).toBe(
			401,
		);
	});
});
