import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { chromium } from "playwright-core";
import { BROWSER_LAUNCH_TIMEOUT_MS, BROWSER_TEST_TIMEOUT_MS, CHROME_PATH } from "../lib/chrome.mjs";
import { createServer, request, type Server } from "node:http";
import { once } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { createDeviceDesktop, desktopLocalRequest, DESKTOP_LIMITS } from "../../server/device-center/desktop.js";
import type { NativeDesktopInput } from "../../server/device-center/desktop-native.js";

type Native = NonNullable<Parameters<typeof createDeviceDesktop>[0]["native"]>;
type CaptureOptions = Parameters<Native["start"]>[0];
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	try {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	} finally {
		vi.restoreAllMocks();
	}
});
async function listen(server: Server) {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
	return (server.address() as { port: number }).port;
}
async function fixture(
	options: {
		env?: NodeJS.ProcessEnv;
		supported?: boolean;
		dataDir?: string;
		permissions?: Native["permissions"];
		legacyJpeg?: boolean;
	} = {},
) {
	const app = express();
	const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), "desktop-route-"));
	if (!options.dataDir) cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
	const sessions: { options: CaptureOptions; input: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }[] = [];
	const native: Native = {
		permissions: options.permissions,
		status: () => ({
			supported: options.supported !== false,
			backend: "fake",
			...(options.supported === false ? { reason: "No display" } : {}),
		}),
		start: vi.fn((capture: CaptureOptions) => {
			const session = { options: capture, input: vi.fn(), close: vi.fn() };
			sessions.push(session);
			return session;
		}),
	};
	const desktop = createDeviceDesktop({
		dataDir,
		fileHome: dataDir,
		app,
		authorize: (req) => req.headers.authorization === "Bearer test",
		env: options.env ?? { PI_DEVICE_DESKTOP: "1" },
		native,
	});
	const parent = express();
	parent.use("/nested", app);
	parent.use(app);
	const http = createServer(parent);
	http.on("upgrade", (req, socket, head) => {
		if (req.url?.startsWith("/nested/")) req.url = req.url.slice("/nested".length);
		if (options.legacyJpeg) {
			const url = new URL(req.url!, "http://localhost");
			url.searchParams.delete("jpegFeedback");
			req.url = url.pathname + url.search;
		}
		if (!desktop.handleUpgrade(req, socket, head)) socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
	});
	const port = await listen(http);
	cleanups.push(() => desktop.close());
	const url = `http://127.0.0.1:${port}`;
	return {
		desktop,
		native,
		sessions,
		port,
		url,
		dataDir,
		localPost: (path: string, body?: unknown, extra: Record<string, string> = { ...headers, origin: url }) =>
			new Promise<Response>((resolve, reject) => {
				const req = request(
					url + "/api/device-desktop/local/" + path,
					{
						method: "POST",
						headers: { "content-type": "application/json", ...extra },
					},
					(res) => {
						const chunks: Buffer[] = [];
						res.on("data", (chunk) => chunks.push(chunk));
						res.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode })));
					},
				);
				req.on("error", reject);
				req.end(body === undefined ? undefined : JSON.stringify(body));
			}),
		post: (path: string, body?: unknown) =>
			fetch(url + "/api/device-desktop/setup/" + path, {
				method: "POST",
				headers: { ...headers, origin: url, "content-type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
			}),
	};
}
const headers = { authorization: "Bearer test" };
function wsClient(port: number, path = "/desktop-ws", extra: Record<string, string> = headers) {
	const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: extra });
	const messages: { data: Buffer; binary: boolean }[] = [];
	ws.on("message", (data, binary) => messages.push({ data: Buffer.from(data as Buffer), binary }));
	ws.on("error", () => {});
	cleanups.push(() => ws.terminate());
	return { ws, messages };
}
async function connected(port: number, path = "/desktop-ws") {
	const client = wsClient(port, path);
	await once(client.ws, "open");
	return client;
}
async function rejected(port: number, status: number, path = "/desktop-ws", extra: Record<string, string> = headers) {
	const { ws } = wsClient(port, path, extra);
	const response = once(ws, "unexpected-response");
	expect((await response)[1].statusCode).toBe(status);
	ws.terminate();
}
const inputs: NativeDesktopInput[] = [
	{ type: "pointer", x: 0.25, y: 0.75, action: "move" },
	{ type: "pointer", x: 0.25, y: 0.75, action: "down", button: 0 },
	{ type: "pointer", x: 0.25, y: 0.75, action: "up", button: 0 },
	{ type: "wheel", deltaY: -120 },
	{ type: "key", code: "KeyA", action: "down" },
	{ type: "key", code: "KeyA", action: "up" },
	{ type: "text", text: "Hello 世界" },
	{ type: "release" },
];
const tinyImage = Buffer.from(
	"/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABwn/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdAAYqm//Z",
	"base64",
);

describe("device desktop local authorization", () => {
	it("authorizes lightweight previews, shares requests and reuses live capture", async () => {
		const f = await fixture();
		expect((await fetch(f.url + "/desktop-preview")).status).toBe(403);
		expect((await fetch(f.url + "/api/device-desktop/preview")).status).toBe(403);
		expect((await fetch(f.url + "/desktop-preview", { headers })).status).toBe(200);
		const first = fetch(f.url + "/api/device-desktop/preview", { headers });
		const second = fetch(f.url + "/api/device-desktop/preview", { headers });
		await vi.waitFor(() => expect(f.sessions).toHaveLength(1));
		expect(f.sessions[0].options).toMatchObject({ readOnly: true, preview: true });
		f.sessions[0].options.onFrame(tinyImage);
		for (const response of await Promise.all([first, second])) {
			expect(response.headers.get("cache-control")).toBe("no-store");
			expect(response.headers.get("content-type")).toContain("image/jpeg");
			expect(Buffer.from(await response.arrayBuffer())).toEqual(tinyImage);
		}
		const { ws } = await connected(f.port);
		expect(f.sessions[0].close).toHaveBeenCalledTimes(1);
		f.sessions[1].options.onFrame(tinyImage);
		expect((await fetch(f.url + "/api/device-desktop/preview", { headers })).status).toBe(200);
		expect(f.sessions).toHaveLength(2);
		ws.close();
	});
	it("reports desktop status and native permission support without requesting permissions", async () => {
		const permissions = vi.fn<NonNullable<Native["permissions"]>>();
		const f = await fixture({ permissions });
		const response = await fetch(f.url + "/api/device-desktop/local/status", { headers });
		expect(response.status).toBe(200);
		const status = await (await fetch(f.url + "/api/device-desktop/status", { headers })).json();
		expect(await response.json()).toEqual({ ...status, permissions: { supported: process.platform === "darwin" } });
		expect(permissions).not.toHaveBeenCalled();
	});
	it("requires authorization, exact Origin and a local browser for local operations", async () => {
		const permissions = vi.fn<NonNullable<Native["permissions"]>>();
		const f = await fixture({ permissions });
		for (const path of ["permissions", "enable"]) {
			for (const extra of [
				{ origin: f.url },
				headers,
				{ ...headers, origin: "https://evil.example" },
				{ ...headers, origin: f.url + "/path" },
				{ ...headers, origin: f.url + "/" },
				{ ...headers, origin: f.url, host: "192.168.0.4" },
				{ ...headers, origin: f.url, "sec-fetch-site": "cross-site" },
			]) {
				const response = await f.localPost(
					path,
					path === "permissions" ? { kind: "screen" } : { enabled: true },
					extra,
				);
				expect(response.status, `${path} ${JSON.stringify(extra)}`).toBe(403);
			}
		}
		for (const extra of [
			{},
			{ ...headers, origin: "https://evil.example" },
			{ ...headers, host: "192.168.0.4" },
			{ ...headers, "sec-fetch-site": "cross-site" },
		]) {
			const status = await new Promise<number | undefined>((resolve, reject) => {
				const req = request(f.url + "/api/device-desktop/local/status", { headers: extra }, (res) => {
					res.resume();
					resolve(res.statusCode);
				});
				req.on("error", reject);
				req.end();
			});
			expect(status).toBe(403);
		}
		expect(permissions).not.toHaveBeenCalled();
	});
	it("rejects malformed permission bodies before invoking native permissions", async () => {
		const permissions = vi.fn<NonNullable<Native["permissions"]>>();
		const f = await fixture({ permissions });
		for (const body of [
			undefined,
			{},
			[],
			{ kind: "other" },
			{ kind: 1 },
			{ kind: ["screen"] },
			{ kind: "screen", extra: true },
		]) {
			expect((await f.localPost("permissions", body)).status, JSON.stringify(body)).toBe(400);
		}
		expect(permissions).not.toHaveBeenCalled();
	});
	it.each(["screen", "control"] as const)("passes %s and returns actual denied permissions", async (kind) => {
		const result = { screen: false, accessibility: false };
		const permissions = vi.fn<NonNullable<Native["permissions"]>>().mockResolvedValue(result);
		const f = await fixture({ permissions });
		const response = await f.localPost("permissions", { kind });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(result);
		expect(permissions).toHaveBeenCalledExactlyOnceWith(kind, expect.any(AbortSignal));
		expect(permissions.mock.calls[0][1]?.aborted).toBe(false);
	});
	it.skipIf(process.platform === "darwin")("rejects permission requests without native support off macOS", async () => {
		const f = await fixture();
		expect((await f.localPost("permissions", { kind: "screen" })).status).toBe(400);
	});
	it("returns 409 while a permission request is pending and releases the lock on completion", async () => {
		let finish!: (result: { screen: boolean; accessibility: boolean }) => void;
		const permissions = vi.fn<NonNullable<Native["permissions"]>>().mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const f = await fixture({ permissions });
		const first = f.localPost("permissions", { kind: "screen" });
		await vi.waitFor(() => expect(permissions).toHaveBeenCalledTimes(1));
		expect((await f.localPost("permissions", { kind: "control" })).status).toBe(409);
		expect(permissions).toHaveBeenCalledTimes(1);
		finish({ screen: false, accessibility: false });
		expect((await first).status).toBe(200);
		permissions.mockResolvedValue({ screen: true, accessibility: false });
		expect((await f.localPost("permissions", { kind: "control" })).status).toBe(200);
	});
	it.each(["disconnect", "service close"])("aborts native permission work on %s", async (reason) => {
		let signal: AbortSignal | undefined;
		const aborted = vi.fn();
		const permissions = vi.fn<NonNullable<Native["permissions"]>>().mockImplementation((_kind, current) => {
			signal = current;
			return new Promise((_resolve, reject) =>
				current!.addEventListener(
					"abort",
					() => {
						aborted();
						reject(new Error("aborted"));
					},
					{ once: true },
				),
			);
		});
		const f = await fixture({ permissions });
		const req = request(f.url + "/api/device-desktop/local/permissions", {
			method: "POST",
			headers: { ...headers, origin: f.url, "content-type": "application/json" },
		});
		req.on("error", () => {});
		cleanups.push(() => {
			req.destroy();
		});
		req.end(JSON.stringify({ kind: "screen" }));
		await vi.waitFor(() => expect(permissions).toHaveBeenCalledTimes(1));
		expect(signal?.aborted).toBe(false);
		if (reason === "disconnect") req.destroy();
		else f.desktop.close();
		await vi.waitFor(() => expect(aborted).toHaveBeenCalledTimes(1));
		expect(signal?.aborted).toBe(true);
		req.destroy();
		if (reason === "disconnect") {
			permissions.mockResolvedValue({ screen: false, accessibility: false });
			expect((await f.localPost("permissions", { kind: "control" })).status).toBe(200);
		}
	});
	it("validates, persists and applies local enablement like setup enablement", async () => {
		const f = await fixture({ env: {} });
		for (const body of [undefined, {}, [], { enabled: "true" }, { enabled: true, extra: true }]) {
			expect((await f.localPost("enable", body)).status).toBe(400);
		}
		const response = await f.localPost("enable", { enabled: true });
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ enabled: true, available: true });
		const client = await connected(f.port);
		await vi.waitFor(() => expect(f.sessions).toHaveLength(1));
		const closed = once(client.ws, "close");
		const disabled = await f.localPost("enable", { enabled: false });
		expect(disabled.status).toBe(200);
		expect(await disabled.json()).toEqual(
			await (await fetch(f.url + "/api/device-desktop/setup/status", { headers })).json(),
		);
		await closed;
		expect(f.sessions[0].close).toHaveBeenCalledTimes(1);
		const restored = await fixture({ dataDir: f.dataDir, env: {} });
		expect(await (await fetch(restored.url + "/api/device-desktop/local/status", { headers })).json()).toMatchObject({
			enabled: false,
			available: false,
		});
	});
});

describe("device desktop native route", () => {
	it("reports native support and server permissions consistently without installing packages", async () => {
		const f = await fixture();
		const response = await fetch(f.url + "/api/device-desktop/status", { headers });
		expect(response.status).toBe(200);
		const status = await response.json();
		expect(status).toMatchObject({
			os: process.platform,
			enabled: true,
			environmentEnabled: true,
			available: true,
			supported: true,
			backend: "fake",
			readOnlyEnforcement: "server",
			clientViewOnlyIsPermission: true,
			installation: { state: "not-required", log: expect.any(String) },
		});
		expect(await (await fetch(f.url + "/api/device-desktop/setup/status", { headers })).json()).toEqual(status);
		const installed = await f.post("install");
		expect(installed.status).toBe(200);
		expect(await installed.json()).toMatchObject({ installation: status.installation });
		expect(existsSync(join(f.dataDir, "desktop-runtime"))).toBe(false);
		expect(f.native.start).not.toHaveBeenCalled();
	});
	it("requires enablement and reports unsupported backends without starting capture", async () => {
		for (const options of [{ env: {} }, { supported: false }]) {
			const f = await fixture(options);
			const status = await (await fetch(f.url + "/api/device-desktop/status", { headers })).json();
			expect(status.available).toBe(false);
			if (options.supported === false)
				expect(status).toMatchObject({ supported: false, backend: "fake", reason: "No display" });
			else expect(status.enabled).toBe(false);
			await rejected(f.port, 503);
			expect(f.native.start).not.toHaveBeenCalled();
		}
	});
	it("requires independent authorization and local Host/Origin on HTTP and WebSocket", async () => {
		const f = await fixture();
		for (const extra of [
			{},
			{ ...headers, origin: "https://evil.example" },
			{ ...headers, host: "192.168.0.4" },
			{ ...headers, origin: f.url + "/path" },
		]) {
			const status = await new Promise<number | undefined>((resolve, reject) => {
				const req = request(f.url + "/api/device-desktop/status", { headers: extra }, (res) => {
					res.resume();
					resolve(res.statusCode);
				});
				req.on("error", reject);
				req.end();
			});
			expect(status).toBe(403);
			await rejected(f.port, 403, "/desktop-ws", extra);
		}
		for (const path of ["enable", "install"]) {
			expect((await fetch(f.url + "/api/device-desktop/setup/" + path, { method: "POST", headers })).status).toBe(403);
		}
		expect(f.native.start).not.toHaveBeenCalled();
	});
	it("checks physical loopback and exact origin independent of forwarded headers", () => {
		const req = (remoteAddress: string, host: string, origin?: string) =>
			({
				socket: { remoteAddress },
				headers: { host, origin, "x-forwarded-for": "127.0.0.1", "x-forwarded-host": "localhost" },
			}) as any;
		expect(desktopLocalRequest(req("::ffff:127.0.0.1", "127.0.0.1:8787", "http://127.0.0.1:8787"))).toBe(true);
		expect(desktopLocalRequest(req("::1", "[::1]:8787", "http://[::1]:8787"))).toBe(true);
		for (const args of [
			["10.0.0.1", "localhost"],
			["127.0.0.1", "localhost", "null"],
			["127.0.0.1", "localhost:8787", "http://localhost:9999"],
			["127.0.0.1", "localhost", "http://localhost/"],
		] as const)
			expect(desktopLocalRequest(req(args[0], args[1], args[2]))).toBe(false);
	});
	it("persists enablement, validates writes and honors environment enablement", async () => {
		const f = await fixture({ env: {} });
		for (const body of [{}, { enabled: "true" }, { enabled: true, extra: true }])
			expect((await f.post("enable", body)).status).toBe(400);
		expect((await f.post("enable", { enabled: true })).status).toBe(200);
		expect(JSON.parse(readFileSync(join(f.dataDir, "desktop-settings.json"), "utf8"))).toEqual({ enabled: true });
		const restored = await fixture({ env: {}, dataDir: f.dataDir });
		expect(await (await fetch(restored.url + "/api/device-desktop/status", { headers })).json()).toMatchObject({
			enabled: true,
			environmentEnabled: false,
			available: true,
		});
		const forced = await fixture();
		expect(await (await forced.post("enable", { enabled: false })).json()).toMatchObject({
			enabled: true,
			environmentEnabled: true,
		});
	});
	it("does not publish enabled state when saving settings fails", async () => {
		const f = await fixture({ env: {} });
		mkdirSync(join(f.dataDir, "desktop-settings.json"));
		expect((await f.post("enable", { enabled: true })).status).toBe(500);
		expect(await (await fetch(f.url + "/api/device-desktop/status", { headers })).json()).toMatchObject({
			enabled: false,
			available: false,
		});
		await rejected(f.port, 503);
	});
	it("enforces read-only by default and for every value except explicit viewOnly=0", async () => {
		const f = await fixture();
		for (const query of ["", "?viewOnly=1", "?viewOnly=false", "?viewOnly="]) {
			const { ws, messages } = await connected(f.port, "/desktop-ws" + query);
			const session = f.sessions.at(-1)!;
			expect(session.options.readOnly).toBe(true);
			for (const input of inputs) ws.send(JSON.stringify(input));
			const processed = once(ws, "pong");
			ws.ping();
			await processed;
			const frame = Buffer.from("fake JPEG");
			session.options.onFrame(frame);
			await vi.waitFor(() =>
				expect(messages.some((message) => message.binary && message.data.equals(frame))).toBe(true),
			);
			expect(
				messages.filter((message) => !message.binary).map((message) => JSON.parse(message.data.toString())),
			).toContainEqual({ type: "ready", dynamicQuality: false });
			expect(session.input).not.toHaveBeenCalled();
			const closed = once(ws, "close");
			ws.close();
			await closed;
			await vi.waitFor(() => expect(session.close).toHaveBeenCalledTimes(1));
		}
	});
	it("binds remote file writes to the current authorized control session", async () => {
		const f = await fixture();
		const key = "a".repeat(32),
			other = "b".repeat(32);
		const requestFiles = (path: string, session?: string, method = "GET", body?: unknown) =>
			fetch(f.url + "/api/device-desktop/files/" + path, {
				method,
				headers: {
					...headers,
					...(session ? { "x-pi-desktop-file-session": session } : {}),
					...(body ? { "content-type": "application/json" } : {}),
				},
				body: body ? JSON.stringify(body) : undefined,
			});
		expect((await requestFiles("info")).status).toBe(403);
		const { ws } = await connected(f.port, "/desktop-ws?viewOnly=1");
		const acknowledged = once(ws, "message");
		ws.send(JSON.stringify({ type: "files_session", key }));
		expect(JSON.parse(String((await acknowledged)[0])).type).toBe("files_session_ready");
		expect((await (await requestFiles("info", key)).json()).readOnly).toBe(true);
		expect((await requestFiles("info", other)).status).toBe(403);
		expect((await requestFiles("mkdir", key, "POST", { path: f.dataDir, name: "forbidden" })).status).toBe(403);
		expect(
			(await requestFiles("jobs", key, "POST", { key: other, entries: [{ path: "test.txt", size: 0 }] })).status,
		).toBe(403);
		const readable = join(f.dataDir, "readable.txt");
		await import("node:fs/promises").then((fs) => fs.writeFile(readable, "safe to read"));
		const download = await (await requestFiles("downloads", key, "POST", { path: readable })).json();
		expect(await (await requestFiles("download/" + download.id)).text()).toBe("safe to read");
		const closed = once(ws, "close");
		ws.close();
		await closed;
		expect((await requestFiles("info", key)).status).toBe(403);
		const control = await connected(f.port, "/desktop-ws?viewOnly=0"),
			controlAck = once(control.ws, "message");
		control.ws.send(JSON.stringify({ type: "files_session", key: other }));
		await controlAck;
		expect((await (await requestFiles("info", other)).json()).readOnly).toBe(false);
		expect((await requestFiles("mkdir", other, "POST", { path: f.dataDir, name: "permitted" })).status).toBe(200);
		expect(existsSync(join(f.dataDir, "permitted"))).toBe(true);
		control.ws.close();
	});
	it("forwards validated JSON inputs only after explicit control permission", async () => {
		const f = await fixture();
		const { ws } = await connected(f.port, "/nested/desktop-ws?viewOnly=0");
		const session = f.sessions[0];
		expect(session.options.readOnly).toBe(false);
		for (const input of inputs) ws.send(JSON.stringify(input));
		await vi.waitFor(() => expect(session.input.mock.calls.map(([event]) => event)).toEqual(inputs));
	});
	it.each([
		"{",
		"null",
		"[]",
		"{}",
		'{"type":"unknown"}',
		'{"type":"pointer","x":2,"y":0,"action":"move"}',
		'{"type":"wheel","deltaY":"1"}',
		'{"type":"key","code":"KeyA","action":"press"}',
		'{"type":"text","text":1}',
		'{"type":"pointer","x":0,"y":0,"action":"down"}',
		'{"type":"pointer","x":0,"y":0,"action":"down","button":3}',
		'{"type":"wheel","deltaY":10001}',
		'{"type":"key","code":"bad code","action":"down"}',
		'{"type":"text","text":""}',
		'{"type":"release","extra":true}',
		'{"type":"ack","extra":true}',
	])("closes invalid input %s without forwarding", async (raw) => {
		const f = await fixture();
		const { ws } = await connected(f.port, "/desktop-ws?viewOnly=0");
		const closed = once(ws, "close");
		ws.send(raw);
		await closed;
		expect(f.sessions[0].input).not.toHaveBeenCalled();
		expect(f.sessions[0].close).toHaveBeenCalledTimes(1);
	});
	it("rejects binary and oversized inputs at the 16KB boundary", async () => {
		expect(DESKTOP_LIMITS.input).toBe(16 * 1024);
		const f = await fixture();
		for (const raw of [
			Buffer.from(JSON.stringify(inputs[0])),
			JSON.stringify({ type: "text", text: "a".repeat(DESKTOP_LIMITS.input) }),
		]) {
			const { ws } = await connected(f.port, "/desktop-ws?viewOnly=0");
			const closed = once(ws, "close");
			ws.send(raw);
			await closed;
			expect(f.sessions.at(-1)!.input).not.toHaveBeenCalled();
			expect(f.sessions.at(-1)!.close).toHaveBeenCalledTimes(1);
		}
	});
	it("cleans native capture exactly once after disconnect and ignores late callbacks", async () => {
		const f = await fixture();
		const { ws } = await connected(f.port);
		const session = f.sessions[0];
		const closed = once(ws, "close");
		ws.close();
		await closed;
		await vi.waitFor(() => expect(session.close).toHaveBeenCalledTimes(1));
		session.options.onClose();
		session.options.onError("late error");
		session.options.onFrame(tinyImage);
		f.desktop.close();
		f.desktop.close();
		expect(session.close).toHaveBeenCalledTimes(1);
	});
	it("sends native errors as JSON then closes with 1011", async () => {
		const f = await fixture();
		const { ws, messages } = await connected(f.port);
		const closed = once(ws, "close");
		f.sessions[0].options.onError("Capture failed");
		expect((await closed)[0]).toBe(1011);
		expect(
			messages.filter((message) => !message.binary).map((message) => JSON.parse(message.data.toString())),
		).toContainEqual(expect.objectContaining({ type: "error" }));
		expect(f.sessions[0].close).toHaveBeenCalledTimes(1);
	});
	it("closes the socket when native capture ends", async () => {
		const f = await fixture();
		const { ws } = await connected(f.port);
		const closed = once(ws, "close");
		f.sessions[0].options.onClose();
		await closed;
		expect(f.sessions[0].close).toHaveBeenCalledTimes(1);
	});
	it("limits connections to four, frees capacity and closes all captures on disable", async () => {
		expect(DESKTOP_LIMITS.connections).toBe(4);
		const f = await fixture({ env: {} });
		await f.post("enable", { enabled: true });
		const clients = [];
		for (let i = 0; i < DESKTOP_LIMITS.connections; i++) clients.push(await connected(f.port));
		await rejected(f.port, 429);
		const closed = once(clients[0].ws, "close");
		clients[0].ws.close();
		await closed;
		await vi.waitFor(() => expect(f.sessions[0].close).toHaveBeenCalledTimes(1));
		const replacement = await connected(f.port);
		const stopped = [...clients.slice(1), replacement].map(({ ws }) => once(ws, "close"));
		expect((await f.post("enable", { enabled: false })).status).toBe(200);
		await Promise.all(stopped);
		for (const session of f.sessions) expect(session.close).toHaveBeenCalledTimes(1);
		await rejected(f.port, 503);
	});
	it("pipelines two frames and keeps only the latest additional frame until an ACK", async () => {
		expect(DESKTOP_LIMITS.frame).toBe(4 * 1024 * 1024);
		expect(DESKTOP_LIMITS.queue).toBe(4 * 1024 * 1024);
		const f = await fixture();
		const { ws } = await connected(f.port);
		const send = WebSocket.prototype.send;
		const delivered: Buffer[] = [];
		let finish: ((error?: Error) => void) | undefined;
		vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (
			this: WebSocket,
			data: any,
			options: any,
			callback?: any,
		) {
			if (options?.binary === true) {
				delivered.push(Buffer.from(data));
				finish = callback;
				return;
			}
			return send.call(this, data, options, callback);
		});
		const session = f.sessions[0];
		session.options.onFrame(tinyImage);
		session.options.onFrame(Buffer.from("dropped"));
		const latest = Buffer.from("newest");
		session.options.onFrame(latest);
		expect(delivered).toEqual([tinyImage]);
		expect(finish).toBeTypeOf("function");
		finish!();
		expect(delivered).toEqual([tinyImage, latest]);
		finish!();
		session.options.onFrame(Buffer.from("superseded"));
		const third = Buffer.from("third");
		session.options.onFrame(third);
		expect(delivered).toHaveLength(2);
		ws.send(JSON.stringify({ type: "ack" }));
		await vi.waitFor(() => expect(delivered).toEqual([tinyImage, latest, third]));
		expect(session.input).not.toHaveBeenCalled();
		finish!();
		const closed = once(ws, "close");
		session.options.onFrame(Buffer.alloc(DESKTOP_LIMITS.frame + 1));
		await closed;
		expect(delivered).toHaveLength(3);
		expect(session.close).toHaveBeenCalledTimes(1);
	});
	it("negotiates cumulative JPEG feedback without treating one slow ACK as bandwidth", async () => {
		const f = await fixture();
		const { ws, messages } = await connected(f.port, "/desktop-ws?jpegFeedback=1");
		let now = 0;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		const frames = () => messages.filter((message) => message.binary);
		const send = async (text: string, count: number) => {
			f.sessions[0].options.onFrame(Buffer.from(text));
			await vi.waitFor(() => expect(frames()).toHaveLength(count));
		};
		const ack = async (id: number) => {
			ws.send(JSON.stringify({ type: "jpeg_ack", id }));
			const pong = once(ws, "pong");
			ws.ping();
			await pong;
		};
		await send("first", 1);
		expect(
			messages.filter((message) => !message.binary).map((message) => JSON.parse(message.data.toString())),
		).toContainEqual({ type: "ready", dynamicQuality: false, jpegFeedback: 1 });
		now = 105;
		await ack(1);
		for (let i = 0; i < 2; i++) await send(`frame-${i}`, i + 2);
		f.sessions[0].options.onFrame(Buffer.from("superseded"));
		f.sessions[0].options.onFrame(Buffer.from("latest"));
		await ack(1000);
		await ack(1);
		expect(frames()).toHaveLength(3);
		now = 210;
		await ack(3);
		await vi.waitFor(() => expect(frames()).toHaveLength(4));
		expect(frames().at(-1)!.data.toString()).toBe("latest");
		expect(f.sessions[0].input).not.toHaveBeenCalled();
	});
	it("caps unacknowledged JPEG bytes even with a large latency window", async () => {
		const f = await fixture();
		const { ws, messages } = await connected(f.port, "/desktop-ws?jpegFeedback=1");
		const frame = Buffer.alloc(DESKTOP_LIMITS.queue / 2, 1);
		const frames = () => messages.filter((message) => message.binary);
		for (let i = 1; i <= 2; i++) {
			f.sessions[0].options.onFrame(frame);
			await vi.waitFor(() => expect(frames()).toHaveLength(i));
		}
		f.sessions[0].options.onFrame(frame);
		const pong = once(ws, "pong");
		ws.ping();
		await pong;
		expect(frames()).toHaveLength(2);
		ws.send(JSON.stringify({ type: "jpeg_ack", id: 2 }));
		await vi.waitFor(() => expect(frames()).toHaveLength(3));
	});
	it("drops frames when the WebSocket output queue is full and resumes after draining", async () => {
		const f = await fixture();
		const { messages } = await connected(f.port);
		const buffered = vi.spyOn(WebSocket.prototype, "bufferedAmount", "get").mockReturnValue(DESKTOP_LIMITS.queue);
		f.sessions[0].options.onFrame(tinyImage);
		buffered.mockRestore();
		f.sessions[0].options.onFrame(tinyImage);
		await vi.waitFor(() => expect(messages.filter((message) => message.binary)).toHaveLength(1));
		expect(messages.find((message) => message.binary)!.data).toEqual(tinyImage);
	});
	it("closes a stalled viewer instead of leaving a connected but frozen desktop", async () => {
		const f = await fixture();
		const { ws, messages } = await connected(f.port);
		f.sessions[0].options.onFrame(tinyImage);
		await once(ws, "close");
		expect(
			messages.filter((message) => !message.binary).map((message) => JSON.parse(message.data.toString())),
		).toContainEqual({ type: "error", message: expect.stringContaining("acknowledging") });
		expect(f.sessions[0].close).toHaveBeenCalledTimes(1);
	}, 20000);
	it("does not consume unrelated upgrade paths", async () => {
		const f = await fixture();
		const socket = {
			end() {
				throw new Error("must not touch");
			},
		} as any;
		expect(f.desktop.handleUpgrade({ url: "/other" } as any, socket, Buffer.alloc(0))).toBe(false);
	});
	it.skipIf(!CHROME_PATH).each([false, true])(
		"decodes native frames onto the canvas through a nested proxy path (legacy JPEG: %s)",
		async (legacyJpeg) => {
			const f = await fixture({ legacyJpeg });
			const browser = await chromium.launch({
				executablePath: CHROME_PATH,
				headless: true,
				timeout: BROWSER_LAUNCH_TIMEOUT_MS,
				args: ["--no-sandbox"],
			});
			cleanups.push(() => browser.close());
			// 页面与文件管理器的语言取 navigator.language：断言写的是英文，必须钉住 locale。
			const page = await browser.newPage({
				locale: "en-US",
				extraHTTPHeaders: headers,
				viewport: { width: 390, height: 740 },
			});
			const errors: string[] = [];
			const requests: string[] = [];
			const acknowledgements: any[] = [];
			page.on("pageerror", (error) => errors.push(error.message));
			page.on("websocket", (socket) => {
				requests.push(socket.url());
				socket.on("framesent", ({ payload }) => {
					const value = JSON.parse(String(payload));
					if (value.type === "ack" || value.type === "jpeg_ack") acknowledgements.push(value);
				});
			});
			page.on("response", (response) => {
				if (response.status() >= 400) errors.push(response.url() + ":" + response.status());
			});
			await page.goto(f.url + "/nested/desktop", { timeout: 5000 });
			expect(await page.locator("#viewonly").isChecked()).toBe(false);
			await vi.waitFor(() => expect(f.sessions).toHaveLength(1));
			f.sessions[0].options.onFrame(tinyImage);
			await page.waitForFunction(
				() => {
					const canvas = document.querySelector<HTMLCanvasElement>("#canvas");
					return (
						canvas?.width === 1 && canvas.height === 1 && canvas.getContext("2d")!.getImageData(0, 0, 1, 1).data[3] > 0
					);
				},
				undefined,
				{ timeout: 5000 },
			);
			if (process.env.PI_DEVICE_DESKTOP_SCREENSHOT) {
				mkdirSync("artifacts/device-center", { recursive: true });
				await page.screenshot({ path: "artifacts/device-center/desktop-native.png", fullPage: true });
			}
			expect(requests[0]).toContain("/nested/desktop-ws");
			for (let i = 1; i <= 9; i++) {
				f.sessions[0].options.onFrame(tinyImage);
				await vi.waitFor(() => expect(acknowledgements.length).toBeGreaterThanOrEqual(i + 1));
			}
			expect(acknowledgements.at(-1)).toEqual(legacyJpeg ? { type: "ack" } : { type: "jpeg_ack", id: 10 });
			expect(f.sessions[0].options.readOnly).toBe(false);
			await page.locator("#canvas").focus();
			for (const code of [
				"Numpad0",
				"Numpad1",
				"Numpad9",
				"NumpadDecimal",
				"NumpadAdd",
				"NumpadSubtract",
				"NumpadMultiply",
				"NumpadDivide",
				"NumpadEnter",
				"NumLock",
			]) {
				await page.keyboard.press(code);
				await vi.waitFor(() => {
					expect(f.sessions[0].input).toHaveBeenCalledWith({ type: "key", code, action: "down" });
					expect(f.sessions[0].input).toHaveBeenCalledWith({ type: "key", code, action: "up" });
				});
			}
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
			writeFileSync(join(f.dataDir, "file-for-session.txt"), "test");
			await page.locator("#file-transfer").click();
			const fileDialog = page.locator("#file-transfer-dialog"),
				localFiles = fileDialog.locator(".fm-pane").first();
			await localFiles.getByRole("checkbox", { name: "file-for-session.txt", exact: true }).check();
			const send = localFiles.getByRole("button", { name: "Send →", exact: true });
			await expect.poll(() => send.isEnabled()).toBe(true);
			await fileDialog.locator(".fm-head button").click();
			await page.locator("#viewonly").check();
			await vi.waitFor(() => expect(f.sessions).toHaveLength(2));
			f.sessions[1].options.onFrame(tinyImage);
			await page.getByText("Connected · view only", { exact: true }).waitFor();
			await page.locator("#file-transfer").click();
			await expect.poll(() => send.isDisabled()).toBe(true);
			await fileDialog.locator(".fm-head button").click();
			await page.locator("#viewonly").uncheck();
			await vi.waitFor(() => expect(f.sessions).toHaveLength(3));
			f.sessions[2].options.onFrame(tinyImage);
			await page.getByText("Connected · control enabled", { exact: true }).waitFor();
			await page.locator("#file-transfer").click();
			await expect.poll(() => send.isEnabled()).toBe(true);
			await fileDialog.locator(".fm-head button").click();
			await page.locator("#disconnect").click();
			await vi.waitFor(() => expect(f.sessions[0].close).toHaveBeenCalledTimes(1));
			expect(await page.locator("#connect").isEnabled()).toBe(true);
			expect(errors).toEqual([]);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});
