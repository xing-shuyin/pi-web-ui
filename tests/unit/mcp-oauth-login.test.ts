import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	cancelMcpOAuthLogin,
	finishMcpOAuthLogin,
	getMcpOAuthLoginStatus,
	startMcpOAuthLogin,
} from "../../server/mcp-oauth-login.js";
import { loadMcpAuthState } from "../../server/mcp-oauth.js";

type Login = Awaited<ReturnType<typeof startMcpOAuthLogin>>;
interface RequestRecord {
	method: string;
	path: string;
	body: string;
	contentType?: string;
}

let agentDir: string;
let fixture: Server;
let origin: string;
let requests: RequestRecord[];
let registrations: Record<string, unknown>[];
let issuedCodes: Map<string, URLSearchParams>;
let logins: Login[];
let tokenMode: "success" | "reject" | "hold";
let tokenReached: Promise<void>;
let markTokenReached: () => void;
let heldToken: ServerResponse | undefined;

function json(res: ServerResponse, value: unknown, status = 200): void {
	res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
}

beforeEach(async () => {
	agentDir = mkdtempSync(join(tmpdir(), "piweb-mcp-oauth-login-"));
	requests = [];
	registrations = [];
	issuedCodes = new Map();
	logins = [];
	tokenMode = "success";
	heldToken = undefined;
	tokenReached = new Promise((resolve) => {
		markTokenReached = resolve;
	});
	fixture = createServer((req, res) => {
		void (async () => {
			const url = new URL(req.url!, origin);
			let body = "";
			for await (const chunk of req) body += chunk;
			requests.push({ method: req.method!, path: url.pathname, body, contentType: req.headers["content-type"] });
			switch (url.pathname) {
				case "/.well-known/oauth-protected-resource/mcp":
					json(res, {
						resource: `${origin}/mcp`,
						authorization_servers: [origin],
						scopes_supported: ["tools:read", "offline_access"],
					});
					return;
				case "/.well-known/oauth-authorization-server":
					json(res, {
						issuer: origin,
						authorization_endpoint: `${origin}/authorize`,
						token_endpoint: `${origin}/token`,
						registration_endpoint: `${origin}/register`,
						response_types_supported: ["code"],
						grant_types_supported: ["authorization_code", "refresh_token"],
						code_challenge_methods_supported: ["S256"],
						token_endpoint_auth_methods_supported: ["none"],
					});
					return;
				case "/register": {
					if (req.method !== "POST") {
						json(res, { error: "invalid_request" }, 405);
						return;
					}
					const metadata = JSON.parse(body) as Record<string, unknown>;
					registrations.push(metadata);
					json(res, { ...metadata, client_id: `fixture-client-${registrations.length}` }, 201);
					return;
				}
				case "/authorize": {
					const callback = new URL(url.searchParams.get("redirect_uri")!);
					callback.searchParams.set("state", url.searchParams.get("state")!);
					if (url.searchParams.get("decision") === "deny") callback.searchParams.set("error", "access_denied");
					else {
						const code = `fixture-code-${issuedCodes.size + 1}`;
						issuedCodes.set(code, url.searchParams);
						callback.searchParams.set("code", code);
					}
					res.writeHead(302, { location: callback.href }).end();
					return;
				}
				case "/token": {
					markTokenReached();
					const params = new URLSearchParams(body);
					const authorization = issuedCodes.get(params.get("code")!);
					const verifier = params.get("code_verifier") ?? "";
					const challenge = createHash("sha256").update(verifier).digest("base64url");
					if (
						req.method !== "POST" ||
						!authorization ||
						params.get("grant_type") !== "authorization_code" ||
						params.get("redirect_uri") !== authorization.get("redirect_uri") ||
						params.get("client_id") !== authorization.get("client_id") ||
						params.get("resource") !== `${origin}/mcp` ||
						challenge !== authorization.get("code_challenge")
					) {
						json(res, { error: "invalid_grant" }, 400);
						return;
					}
					if (tokenMode === "hold") {
						heldToken = res;
						return;
					}
					if (tokenMode === "reject") {
						json(res, { error: "invalid_grant" }, 400);
						return;
					}
					json(res, {
						access_token: "fixture-access",
						refresh_token: "fixture-refresh",
						token_type: "Bearer",
						expires_in: 3600,
					});
					return;
				}
				default:
					json(res, { error: "not_found" }, 404);
			}
		})().catch(() => json(res, { error: "fixture_error" }, 500));
	});
	await new Promise<void>((resolve, reject) => {
		fixture.once("error", reject);
		fixture.listen(0, "127.0.0.1", resolve);
	});
	origin = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;
});

afterEach(async () => {
	for (const login of logins) cancelMcpOAuthLogin(login.id);
	heldToken?.destroy();
	await new Promise<void>((resolve, reject) => {
		fixture.close((error) => (error ? reject(error) : resolve()));
		fixture.closeAllConnections();
	});
	rmSync(agentDir, { recursive: true, force: true });
});

function storePath(): string {
	return join(agentDir, "mcp-auth.json");
}
function readStore(): Record<string, any> {
	return JSON.parse(readFileSync(storePath(), "utf8"));
}
function tokenRequests(): RequestRecord[] {
	return requests.filter((request) => request.path === "/token");
}
async function start(): Promise<Login> {
	const login = await startMcpOAuthLogin({ agentDir, name: "my-server", serverUrl: `${origin}/mcp` });
	logins.push(login);
	return login;
}
async function authorize(login: Login, deny = false): Promise<string> {
	const url = new URL(login.authorizationUrl);
	if (deny) url.searchParams.set("decision", "deny");
	const response = await fetch(url, { redirect: "manual" });
	expect(response.status).toBe(302);
	await response.text();
	return response.headers.get("location")!;
}

describe("MCP OAuth login with local discovery, DCR and PKCE", () => {
	it("manually completes and persists a grant in pi's shared format without ephemeral secrets", async () => {
		const startedAt = Date.now();
		const login = await start();
		const auth = new URL(login.authorizationUrl);
		expect(auth.origin).toBe(origin);
		expect(auth.pathname).toBe("/authorize");
		expect(Object.fromEntries(auth.searchParams)).toMatchObject({
			response_type: "code",
			client_id: "fixture-client-1",
			redirect_uri: login.redirectUrl,
			code_challenge_method: "S256",
			resource: `${origin}/mcp`,
			scope: "tools:read offline_access",
		});
		expect(auth.searchParams.get("state")).toMatch(/^[\w-]{32,}$/);
		expect(auth.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/);
		expect(auth.searchParams.has("code_verifier")).toBe(false);
		expect(new URL(login.redirectUrl).hostname).toBe("127.0.0.1");
		expect(requests.map((request) => request.path)).toEqual([
			"/.well-known/oauth-protected-resource/mcp",
			"/.well-known/oauth-authorization-server",
			"/register",
		]);
		expect(registrations).toEqual([
			expect.objectContaining({
				client_name: "pi-web-ui",
				application_type: "native",
				redirect_uris: [login.redirectUrl],
				grant_types: ["authorization_code", "refresh_token"],
				response_types: ["code"],
				token_endpoint_auth_method: "none",
			}),
		]);
		expect(getMcpOAuthLoginStatus(login.id)).toEqual({ status: "pending" });
		expect(existsSync(storePath())).toBe(false);
		const callback = await authorize(login);
		await finishMcpOAuthLogin({ id: login.id, redirectUrl: callback });
		expect(getMcpOAuthLoginStatus(login.id)).toEqual({ status: "complete" });
		const credentials = readStore();
		expect(Object.keys(credentials)).toEqual([`mcp__my_server|${origin}/mcp`]);
		const saved = credentials[`mcp__my_server|${origin}/mcp`];
		expect(saved.tokens).toMatchObject({
			access_token: "fixture-access",
			refresh_token: "fixture-refresh",
			token_type: "Bearer",
			expires_in: 3600,
		});
		expect(saved.tokensExpireAt).toBeGreaterThanOrEqual(startedAt + 3600_000);
		expect(saved.tokensExpireAt).toBeLessThanOrEqual(Date.now() + 3600_000);
		expect(saved.clientInformation.client_id).toBe("fixture-client-1");
		expect(saved.discovery).toMatchObject({
			authorizationServerUrl: origin,
			authorizationServerMetadata: { token_endpoint: `${origin}/token` },
			resourceMetadata: { resource: `${origin}/mcp` },
		});
		expect(saved).not.toHaveProperty("codeVerifier");
		expect(saved).not.toHaveProperty("oauthState");
		expect(loadMcpAuthState({ agentDir, name: "my-server", serverUrl: `${origin}/mcp` }).state).toEqual(saved);
		const exchange = tokenRequests();
		expect(exchange).toHaveLength(1);
		expect(exchange[0].contentType).toBe("application/x-www-form-urlencoded");
		const verifier = new URLSearchParams(exchange[0].body).get("code_verifier")!;
		expect(verifier).toMatch(/^[\w-]{43,128}$/);
		expect(createHash("sha256").update(verifier).digest("base64url")).toBe(auth.searchParams.get("code_challenge"));
		expect(readFileSync(storePath(), "utf8")).not.toContain(verifier);
		await finishMcpOAuthLogin({ id: login.id, redirectUrl: callback });
		expect(tokenRequests()).toHaveLength(1);
	});

	it.each([
		"wrong state",
		"duplicate state",
		"wrong origin",
		"wrong path",
		"missing code",
		"duplicate code",
		"invalid URL",
	])("rejects %s without consuming the real login", async (kind) => {
		const login = await start();
		const callback = await authorize(login);
		const forged = new URL(callback);
		if (kind === "wrong state") forged.searchParams.set("state", "forged-state");
		if (kind === "duplicate state") forged.searchParams.append("state", forged.searchParams.get("state")!);
		if (kind === "wrong origin") forged.hostname = "localhost";
		if (kind === "wrong path") forged.pathname += "/other";
		if (kind === "missing code") forged.searchParams.delete("code");
		if (kind === "duplicate code") forged.searchParams.append("code", "other-code");
		await expect(
			finishMcpOAuthLogin({ id: login.id, redirectUrl: kind === "invalid URL" ? "not a URL" : forged.href }),
		).rejects.toThrow();
		expect(getMcpOAuthLoginStatus(login.id)).toEqual({ status: "pending" });
		expect(tokenRequests()).toHaveLength(0);
		expect(existsSync(storePath())).toBe(false);
		await finishMcpOAuthLogin({ id: login.id, redirectUrl: callback });
		expect(getMcpOAuthLoginStatus(login.id)).toEqual({ status: "complete" });
	});

	it("uses independent state, PKCE challenges and callbacks for simultaneous logins", async () => {
		const first = await start();
		const second = await start();
		const a = new URL(first.authorizationUrl);
		const b = new URL(second.authorizationUrl);
		expect(a.searchParams.get("state")).not.toBe(b.searchParams.get("state"));
		expect(a.searchParams.get("code_challenge")).not.toBe(b.searchParams.get("code_challenge"));
		expect(first.redirectUrl).not.toBe(second.redirectUrl);
		await expect(finishMcpOAuthLogin({ id: second.id, redirectUrl: await authorize(first) })).rejects.toThrow(
			"does not match",
		);
		expect(getMcpOAuthLoginStatus(second.id)).toEqual({ status: "pending" });
	});

	it("automatically completes through the loopback callback", async () => {
		const login = await start();
		const response = await fetch(login.authorizationUrl);
		expect(response.url.startsWith(login.redirectUrl + "?")).toBe(true);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
		expect(await response.text()).toContain("MCP sign-in complete");
		expect(getMcpOAuthLoginStatus(login.id)).toEqual({ status: "complete" });
		expect(readStore()[`mcp__my_server|${origin}/mcp`].tokens.access_token).toBe("fixture-access");
		expect(tokenRequests()).toHaveLength(1);
	});

	it("keeps the loopback listener usable after stray requests and a forged state", async () => {
		const login = await start();
		const callback = await authorize(login);
		const wrongPath = new URL(login.redirectUrl);
		wrongPath.pathname = "/unrelated";
		const stray = await fetch(wrongPath);
		expect(stray.status).toBe(404);
		await stray.text();
		const wrongMethod = await fetch(callback, { method: "POST" });
		expect(wrongMethod.status).toBe(404);
		await wrongMethod.text();
		const forged = new URL(callback);
		forged.searchParams.set("state", "forged-state");
		const rejected = await fetch(forged);
		expect(rejected.status).toBe(400);
		await rejected.text();
		expect(getMcpOAuthLoginStatus(login.id)).toEqual({ status: "pending" });
		expect(tokenRequests()).toHaveLength(0);
		const accepted = await fetch(callback);
		expect(accepted.status).toBe(200);
		await accepted.text();
		expect(getMcpOAuthLoginStatus(login.id)).toEqual({ status: "complete" });
	});

	it("cancels a pending login and prevents subsequent exchange or storage", async () => {
		const login = await start();
		const callback = await authorize(login);
		cancelMcpOAuthLogin(login.id);
		cancelMcpOAuthLogin(login.id);
		expect(() => getMcpOAuthLoginStatus(login.id)).toThrow("cancelled");
		await expect(finishMcpOAuthLogin({ id: login.id, redirectUrl: callback })).rejects.toThrow("cancelled");
		expect(tokenRequests()).toHaveLength(0);
		expect(existsSync(storePath())).toBe(false);
	});

	it.each(["manual", "loopback"])(
		"joins a held %s completion when the redirect is pasted manually",
		async (firstCaller) => {
			tokenMode = "hold";
			const login = await start();
			const callback = await authorize(login);
			const first =
				firstCaller === "manual"
					? finishMcpOAuthLogin({ id: login.id, redirectUrl: callback })
					: fetch(callback).then(async (response) => {
							expect(response.status).toBe(200);
							expect(await response.text()).toContain("MCP sign-in complete");
						});
			const firstResult = Promise.allSettled([first]);
			await tokenReached;
			const second = finishMcpOAuthLogin({ id: login.id, redirectUrl: callback });
			let secondSettled = false;
			const secondResult = Promise.allSettled([second]).then((results) => {
				secondSettled = true;
				return results;
			});
			const forged = new URL(callback);
			forged.searchParams.set("state", "forged-state");
			await expect(finishMcpOAuthLogin({ id: login.id, redirectUrl: forged.href })).rejects.toThrow("does not match");
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(secondSettled).toBe(false);
			expect(getMcpOAuthLoginStatus(login.id)).toEqual({ status: "pending" });
			expect(tokenRequests()).toHaveLength(1);
			expect(existsSync(storePath())).toBe(false);

			json(heldToken!, {
				access_token: "fixture-access",
				refresh_token: "fixture-refresh",
				token_type: "Bearer",
				expires_in: 3600,
			});
			expect(await firstResult).toEqual([{ status: "fulfilled", value: undefined }]);
			expect(await secondResult).toEqual([{ status: "fulfilled", value: undefined }]);
			expect(tokenRequests()).toHaveLength(1);
			expect(getMcpOAuthLoginStatus(login.id)).toEqual({ status: "complete" });
			expect(readStore()[`mcp__my_server|${origin}/mcp`].tokens).toMatchObject({
				access_token: "fixture-access",
				refresh_token: "fixture-refresh",
			});
		},
	);

	it("cancels an in-flight token exchange without persisting a late grant", async () => {
		tokenMode = "hold";
		const login = await start();
		const callback = await authorize(login);
		const completion = finishMcpOAuthLogin({ id: login.id, redirectUrl: callback });
		const rejected = expect(completion).rejects.toThrow("Cannot complete");
		await tokenReached;
		const joined = expect(finishMcpOAuthLogin({ id: login.id, redirectUrl: callback })).rejects.toThrow(
			"Cannot complete",
		);
		expect(tokenRequests()).toHaveLength(1);
		cancelMcpOAuthLogin(login.id);
		json(heldToken!, { access_token: "late-access", token_type: "Bearer" });
		await Promise.all([rejected, joined]);
		expect(() => getMcpOAuthLoginStatus(login.id)).toThrow("cancelled");
		expect(existsSync(storePath())).toBe(false);
	});

	it.each(["manual", "loopback"])("records authorization denial via %s without writing credentials", async (mode) => {
		const login = await start();
		const callback = await authorize(login, true);
		if (mode === "manual")
			await expect(finishMcpOAuthLogin({ id: login.id, redirectUrl: callback })).rejects.toThrow("denied");
		else {
			const response = await fetch(callback);
			expect(response.status).toBe(400);
			expect(await response.text()).toContain("sign-in failed");
		}
		expect(getMcpOAuthLoginStatus(login.id)).toEqual({ status: "error", error: expect.stringContaining("denied") });
		expect(existsSync(storePath())).toBe(false);
		expect(tokenRequests()).toHaveLength(0);
		await expect(finishMcpOAuthLogin({ id: login.id, redirectUrl: callback })).rejects.toThrow("denied");
	});

	it("reports a rejected token grant and preserves existing credentials", async () => {
		tokenMode = "reject";
		const existing = { unrelated: { tokens: { access_token: "keep-me" } } };
		const original = JSON.stringify(existing);
		writeFileSync(storePath(), original);
		const login = await start();
		await expect(finishMcpOAuthLogin({ id: login.id, redirectUrl: await authorize(login) })).rejects.toThrow(
			"Cannot complete",
		);
		expect(getMcpOAuthLoginStatus(login.id).status).toBe("error");
		expect(readFileSync(storePath(), "utf8")).toBe(original);
		const exchanges = tokenRequests().length;
		expect(exchanges).toBeGreaterThanOrEqual(1);
		await expect(finishMcpOAuthLogin({ id: login.id, redirectUrl: await authorize(login) })).rejects.toThrow(
			"Cannot complete",
		);
		expect(tokenRequests()).toHaveLength(exchanges);
	});

	it("merges the completed grant with other server credentials added while sign-in was pending", async () => {
		const existing = {
			"mcp__other|http://127.0.0.1/other": { tokens: { access_token: "other-access", refresh_token: "other-refresh" } },
		};
		writeFileSync(storePath(), JSON.stringify(existing));
		const login = await start();
		const latest = {
			...existing,
			"http://127.0.0.1/legacy": {
				clientInformation: { client_id: "legacy" },
				tokens: { access_token: "legacy-access" },
			},
		};
		writeFileSync(storePath(), JSON.stringify(latest));
		await finishMcpOAuthLogin({ id: login.id, redirectUrl: await authorize(login) });
		expect(readStore()).toMatchObject(latest);
		expect(Object.keys(readStore())).toHaveLength(3);
		expect(readStore()[`mcp__my_server|${origin}/mcp`].tokens.access_token).toBe("fixture-access");
	});
});
