import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { isLocalScreenshotRequest, registerSystemScreenshotRoutes } from "../../server/system-screenshot.js";

const token = "a".repeat(32);
let server: Server;
let origin: string;
let capture: ReturnType<typeof vi.fn>;

beforeEach(async () => {
	capture = vi.fn().mockResolvedValue("data:image/png;base64,test");
	const app = express();
	app.use(express.json());
	registerSystemScreenshotRoutes(app, { platform: "win32", capture: capture as any });
	server = await new Promise<Server>((resolve, reject) => {
		const instance = app.listen(18900 + Math.floor(Math.random() * 10000), "127.0.0.1", () => resolve(instance));
		instance.once("error", reject);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing test server address");
	origin = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
	server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
});
const post = (body: unknown = { token, locale: "zh" }, headers: Record<string, string> = {}, signal?: AbortSignal) =>
	fetch(`${origin}/api/system-screenshot`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: origin, ...headers },
		body: JSON.stringify(body),
		signal,
	});

function localRequest(headers: Record<string, string> = {}, address = "127.0.0.1") {
	return { socket: { remoteAddress: address }, headers: { host: "localhost:3333", ...headers } } as any;
}

describe("system screenshot boundaries", () => {
	it("requires loopback transport, host, origin and no proxy headers", () => {
		expect(isLocalScreenshotRequest(localRequest())).toBe(true);
		expect(isLocalScreenshotRequest(localRequest({}, "::ffff:127.0.0.1"))).toBe(true);
		expect(isLocalScreenshotRequest(localRequest({ host: "[::1]:3333", origin: "http://[::1]:3333" }, "::1"))).toBe(
			true,
		);
		const blockedHeaders: Record<string, string>[] = [
			{ host: "attacker.example" },
			{ origin: "https://attacker.example" },
			{ origin: "http://localhost:4444" },
			{ origin: "null" },
			{ "x-forwarded-for": "10.0.0.2" },
			{ "x-real-ip": "127.0.0.1" },
			{ forwarded: "for=10.0.0.2" },
			{ "sec-fetch-site": "cross-site" },
		];
		for (const headers of blockedHeaders) expect(isLocalScreenshotRequest(localRequest(headers))).toBe(false);
		expect(isLocalScreenshotRequest(localRequest({}, "192.168.1.2"))).toBe(false);
	});
	it("queries availability without capturing and never caches desktop data", async () => {
		const response = await fetch(`${origin}/api/system-screenshot`);
		expect(await response.json()).toEqual({ available: true });
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(capture).not.toHaveBeenCalled();
		const remote = await fetch(`${origin}/api/system-screenshot`, { headers: { "x-forwarded-for": "10.0.0.1" } });
		expect(await remote.json()).toEqual({ available: false });
	});
	it("rejects proxy and cross-origin capture requests before invoking native code", async () => {
		const blockedHeaders: Record<string, string>[] = [
			{ Origin: "https://evil.example" },
			{ "x-forwarded-for": "10.0.0.1" },
		];
		for (const headers of blockedHeaders) {
			const response = await post(undefined, headers);
			expect(response.status).toBe(403);
		}
		expect(capture).not.toHaveBeenCalled();
	});
	it("validates nonce, locale and window mode before spawning", async () => {
		for (const body of [
			{ token: "' ; injected", locale: "zh" },
			{ token, locale: "invalid" },
			...["false", 0, null, {}].map((hideWindow) => ({ token, locale: "zh", hideWindow })),
			{},
			null,
		]) {
			const response = await post(body);
			expect(response.status).toBe(400);
		}
		expect(capture).not.toHaveBeenCalled();
	});
});

describe("system screenshot lifecycle", () => {
	it("returns only the chosen image and treats cancellation as success", async () => {
		const response = await post();
		expect(await response.json()).toEqual({ cancelled: false, dataUrl: "data:image/png;base64,test" });
		expect(capture).toHaveBeenCalledWith(token, "zh", expect.any(AbortSignal), true);
		capture.mockResolvedValueOnce(null);
		expect(await (await post()).json()).toEqual({ cancelled: true });
	});
	it.each([false, true])("passes the explicit hideWindow=%s choice to native capture", async (hideWindow) => {
		const response = await post({ token, locale: "en", hideWindow });
		expect(response.status).toBe(200);
		expect(capture).toHaveBeenCalledWith(token, "en", expect.any(AbortSignal), hideWindow);
	});
	it("holds the desktop lock across modes until native capture finishes and releases it after failure", async () => {
		let fail!: (error: Error) => void;
		capture.mockImplementationOnce(() => new Promise((_resolve, reject) => (fail = reject)));
		const first = post();
		await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce());
		expect((await post({ token, locale: "zh", hideWindow: false })).status).toBe(409);
		fail(new Error("window-not-focused"));
		expect(await (await first).json()).toEqual({ error: "window-not-focused" });
		expect((await post()).status).toBe(200);
	});
	it("cancels disconnected clients without unlocking while the helper still owns the window", async () => {
		let finish!: (value: null) => void;
		let nativeSignal!: AbortSignal;
		capture.mockImplementationOnce((_token, _locale, signal: AbortSignal) => {
			nativeSignal = signal;
			return new Promise((resolve) => (finish = resolve));
		});
		const controller = new AbortController();
		const first = post(undefined, {}, controller.signal).catch(() => null);
		await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce());
		controller.abort();
		await vi.waitFor(() => expect(nativeSignal.aborted).toBe(true));
		expect((await post()).status).toBe(409);
		finish(null);
		await first;
		await vi.waitFor(async () => expect((await post()).status).toBe(200));
	});
	it("never returns native diagnostic output to the browser", async () => {
		capture.mockRejectedValueOnce(new Error("sensitive native diagnostic path"));
		const response = await post();
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: "capture-failed" });
	});
});
