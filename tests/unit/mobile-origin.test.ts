import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { mobileCors, mobileOriginAuthorized, isMobileOrigin } from "../../server/mobile-origin.js";

const options = {
	tokenConfigured: () => true,
	authorize: (request: { headers: Record<string, unknown>; url?: string }) =>
		request.headers.authorization === "Bearer test-mobile-secret" ||
		new URL(request.url ?? "/", "http://localhost").searchParams.get("token") === "test-mobile-secret" ||
		request.headers.cookie === "pi_web_token=test-mobile-secret",
};

let server: Server;
let base: string;
beforeAll(async () => {
	const app = express();
	app.use(mobileCors(options));
	app.get("/api/health", (_request, response) => response.json({ ok: true }));
	server = createServer(app);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
	base = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
	server?.closeAllConnections();
	await new Promise<void>((resolve, reject) => server?.close((error) => (error ? reject(error) : resolve())));
});

describe("bundled mobile origin boundary", () => {
	it("admits only exact bundled origins", () => {
		expect(isMobileOrigin("capacitor://localhost")).toBe(true);
		expect(isMobileOrigin("https://localhost")).toBe(true);
		for (const origin of [
			"null",
			"http://localhost",
			"https://localhost.evil.test",
			"capacitor://localhost/",
			undefined,
		]) {
			expect(isMobileOrigin(origin)).toBe(false);
		}
	});
	it("preflights Authorization without granting credentialed-cookie access", async () => {
		const response = await fetch(`${base}/api/health`, {
			method: "OPTIONS",
			headers: {
				Origin: "capacitor://localhost",
				"Access-Control-Request-Method": "POST",
				"Access-Control-Request-Headers": "Authorization, Content-Type",
			},
		});
		expect(response.status).toBe(204);
		expect(response.headers.get("access-control-allow-origin")).toBe("capacitor://localhost");
		expect(response.headers.get("access-control-allow-credentials")).toBeNull();
	});
	it("requires an explicit credential even when a valid cookie was supplied", async () => {
		const response = await fetch(`${base}/api/health`, {
			headers: { Origin: "https://localhost", Cookie: "pi_web_token=test-mobile-secret" },
		});
		expect(response.status).toBe(401);
	});
	it("supports both authenticated HTTP and query-authenticated socket handshakes", async () => {
		const response = await fetch(`${base}/api/health`, {
			headers: { Origin: "https://localhost", Authorization: "Bearer test-mobile-secret" },
		});
		expect(response.status).toBe(200);
		expect(
			mobileOriginAuthorized(
				{ headers: { origin: "capacitor://localhost" }, url: "/ws?token=test-mobile-secret" },
				options,
			),
		).toBe(true);
		expect(
			mobileOriginAuthorized(
				{ headers: { origin: "capacitor://localhost", cookie: "pi_web_token=test-mobile-secret" }, url: "/ws" },
				options,
			),
		).toBe(false);
	});
	it("does not create a native route into the local setup page", async () => {
		const response = await fetch(`${base}/api/setup`, {
			method: "OPTIONS",
			headers: { Origin: "https://localhost", "Access-Control-Request-Method": "POST" },
		});
		expect(response.status).toBe(403);
	});
	it("rejects unrecognized preflight headers", async () => {
		const response = await fetch(`${base}/api/health`, {
			method: "OPTIONS",
			headers: {
				Origin: "https://localhost",
				"Access-Control-Request-Method": "POST",
				"Access-Control-Request-Headers": "X-Forwarded-Host",
			},
		});
		expect(response.status).toBe(403);
	});
	it("leaves ordinary browsers outside this admission path", async () => {
		const response = await fetch(`${base}/api/health`, { headers: { Origin: "https://other.test" } });
		expect(response.headers.get("access-control-allow-origin")).toBeNull();
	});
	it("refuses native admission when the server has no access token", () => {
		expect(
			mobileOriginAuthorized(
				{ headers: { origin: "https://localhost", authorization: "Bearer test-mobile-secret" }, url: "/ws" },
				{ ...options, tokenConfigured: () => false },
			),
		).toBe(false);
	});
});
