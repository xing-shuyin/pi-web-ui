import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import {
	getMcpAccessToken,
	getMcpAuthStorePath,
	loadMcpAuthState,
	mcpAuthLegacyKey,
	mcpAuthStoreKey,
	McpOAuthSignInRequiredError,
	readMcpAuthStore,
	refreshMcpAccessToken,
} from "../../server/mcp-oauth.js";
import { McpClient } from "../../server/mcp-bridge.js";

const SERVER_URL = "https://mcp.example.test/mcp";
const TOKEN_ENDPOINT = "https://auth.example.test/token";

let agentDir: string;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "piweb-mcp-oauth-"));
});

afterEach(() => {
	rmSync(agentDir, { recursive: true, force: true });
});

function storePath(): string {
	return getMcpAuthStorePath({ agentDir });
}

function seedState(options: {
	name?: string;
	serverUrl?: string;
	accessToken?: string | null;
	refreshToken?: string | null;
	expiresInMs?: number | null;
	clientSecret?: string;
	authMethod?: string;
	key?: string;
	extra?: Record<string, unknown>;
}): void {
	const name = options.name ?? "suno";
	const serverUrl = options.serverUrl ?? SERVER_URL;
	const key = options.key ?? mcpAuthStoreKey(name, serverUrl);
	const state: Record<string, unknown> = {
		clientInformation: {
			client_id: "client-abc",
			...(options.clientSecret ? { client_secret: options.clientSecret } : {}),
			...(options.authMethod ? { token_endpoint_auth_method: options.authMethod } : {}),
		},
		discovery: {
			authorizationServerMetadata: { token_endpoint: TOKEN_ENDPOINT },
			resourceMetadata: { resource: serverUrl },
		},
		...(options.extra ?? {}),
	};
	const tokens: Record<string, unknown> = {};
	if (options.accessToken !== null) tokens.access_token = options.accessToken ?? "access-old";
	if (options.refreshToken !== null) tokens.refresh_token = options.refreshToken ?? "refresh-old";
	if (Object.keys(tokens).length > 0) state.tokens = tokens;
	if (options.expiresInMs !== null) state.tokensExpireAt = Date.now() + (options.expiresInMs ?? -60_000);
	writeFileSync(storePath(), `${JSON.stringify({ [key]: state }, null, 2)}\n`, { mode: 0o600 });
}

interface FetchCall {
	url: string;
	body: string;
	headers: Record<string, string>;
}

function mockFetch(handler: (call: FetchCall) => { status?: number; body: unknown }) {
	const calls: FetchCall[] = [];
	const impl = (async (input: string | URL | Request, init?: RequestInit) => {
		const call: FetchCall = {
			url: String(input),
			body: String(init?.body ?? ""),
			headers: { ...((init?.headers as Record<string, string>) ?? {}) },
		};
		calls.push(call);
		const { status = 200, body } = handler(call);
		return new Response(typeof body === "string" ? body : JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		});
	}) as unknown as typeof fetch;
	return { impl, calls };
}

describe("凭据库键口径（与 pi 同源）", () => {
	it("键 = mcp__<name>|<url>，名字里的连字符换成下划线", () => {
		expect(mcpAuthStoreKey("suno", SERVER_URL)).toBe("mcp__suno|https://mcp.example.test/mcp");
		expect(mcpAuthStoreKey("my-server", SERVER_URL)).toBe("mcp__my_server|https://mcp.example.test/mcp");
	});

	it("URL 按 new URL() 归一化（origin 补斜杠）", () => {
		expect(mcpAuthStoreKey("srv", "https://example.test")).toBe("mcp__srv|https://example.test/");
		expect(mcpAuthLegacyKey("https://example.test")).toBe("https://example.test/");
	});

	it("旧版只写 URL 的键仍然被读到", () => {
		seedState({ accessToken: "access-legacy", key: mcpAuthLegacyKey(SERVER_URL) });
		expect(loadMcpAuthState({ agentDir, name: "suno", serverUrl: SERVER_URL }).state?.tokens?.access_token).toBe(
			"access-legacy",
		);
	});

	it("凭据库缺失/损坏时按空库处理，不抛错", () => {
		expect(readMcpAuthStore({ agentDir })).toEqual({});
		writeFileSync(storePath(), "{ not json");
		expect(readMcpAuthStore({ agentDir })).toEqual({});
	});
});

describe("取 token：没过期就直接用", () => {
	it("返回库里的 access token，不发任何刷新请求", async () => {
		seedState({ accessToken: "access-fresh", expiresInMs: 30 * 60_000 });
		const { impl, calls } = mockFetch(() => ({ body: {} }));
		const token = await getMcpAccessToken({ agentDir, name: "suno", serverUrl: SERVER_URL, fetch: impl });
		expect(token).toBe("access-fresh");
		expect(calls).toHaveLength(0);
	});

	it("没有凭据的服务器返回 null（匿名服务器保持原行为）", async () => {
		const { impl, calls } = mockFetch(() => ({ body: {} }));
		expect(await getMcpAccessToken({ agentDir, name: "anon", serverUrl: SERVER_URL, fetch: impl })).toBeNull();
		expect(calls).toHaveLength(0);
	});

	it("有凭据但没有 access token 时返回 null", async () => {
		seedState({ accessToken: null, refreshToken: "refresh-only" });
		const { impl } = mockFetch(() => ({ body: {} }));
		expect(await getMcpAccessToken({ agentDir, name: "suno", serverUrl: SERVER_URL, fetch: impl })).toBeNull();
	});
});

describe("取 token：临近过期时刷新", () => {
	it("用 refresh_token 换新 token，并写回库（含轮换后的刷新令牌与绝对过期时间）", async () => {
		seedState({ accessToken: "access-stale", expiresInMs: -1 });
		const { impl, calls } = mockFetch(() => ({
			body: { access_token: "access-new", refresh_token: "refresh-new", expires_in: 900, token_type: "Bearer" },
		}));
		const token = await getMcpAccessToken({ agentDir, name: "suno", serverUrl: SERVER_URL, fetch: impl });
		expect(token).toBe("access-new");

		const call = calls[0];
		expect(call.url).toBe(TOKEN_ENDPOINT);
		const params = new URLSearchParams(call.body);
		expect(params.get("grant_type")).toBe("refresh_token");
		expect(params.get("refresh_token")).toBe("refresh-old");
		expect(params.get("client_id")).toBe("client-abc");
		expect(params.get("resource")).toBe(SERVER_URL);
		expect(call.headers.Authorization).toBeUndefined();

		const state = readMcpAuthStore({ agentDir })[mcpAuthStoreKey("suno", SERVER_URL)];
		expect(state.tokens?.access_token).toBe("access-new");
		expect(state.tokens?.refresh_token).toBe("refresh-new");
		expect(state.tokensExpireAt).toBeGreaterThan(Date.now() + 800_000);
		if (process.platform !== "win32") expect(statSync(storePath()).mode & 0o777).toBe(0o600);
		expect(state.clientInformation?.client_id).toBe("client-abc");
		expect(state.discovery?.authorizationServerMetadata?.token_endpoint).toBe(TOKEN_ENDPOINT);
	});

	it("刷新令牌没有轮换时保留原来的刷新令牌", async () => {
		seedState({ accessToken: "access-stale", expiresInMs: -1 });
		const { impl } = mockFetch(() => ({ body: { access_token: "access-new", expires_in: 900 } }));
		await getMcpAccessToken({ agentDir, name: "suno", serverUrl: SERVER_URL, fetch: impl });
		expect(readMcpAuthStore({ agentDir })[mcpAuthStoreKey("suno", SERVER_URL)].tokens?.refresh_token).toBe(
			"refresh-old",
		);
	});

	it("刷新响应没有 expires_in 时清掉旧的过期时间，后续请求不再重复刷新", async () => {
		seedState({ accessToken: "access-stale", expiresInMs: -1 });
		const { impl, calls } = mockFetch(() => ({ body: { access_token: "access-no-expiry" } }));
		const options = { agentDir, name: "suno", serverUrl: SERVER_URL, fetch: impl };

		expect(await getMcpAccessToken(options)).toBe("access-no-expiry");
		expect(readMcpAuthStore({ agentDir })[mcpAuthStoreKey("suno", SERVER_URL)].tokensExpireAt).toBeUndefined();

		expect(await getMcpAccessToken(options)).toBe("access-no-expiry");
		expect(await getMcpAccessToken(options)).toBe("access-no-expiry");
		expect(calls).toHaveLength(1);
	});

	it("旧版 URL 键在刷新后迁移到新键并被删除", async () => {
		seedState({ accessToken: "access-stale", expiresInMs: -1, key: mcpAuthLegacyKey(SERVER_URL) });
		const { impl } = mockFetch(() => ({ body: { access_token: "access-new", expires_in: 900 } }));
		await getMcpAccessToken({ agentDir, name: "suno", serverUrl: SERVER_URL, fetch: impl });
		const store = readMcpAuthStore({ agentDir });
		expect(store[mcpAuthStoreKey("suno", SERVER_URL)].tokens?.access_token).toBe("access-new");
		expect(store[mcpAuthLegacyKey(SERVER_URL)]).toBeUndefined();
	});

	it("刷新失败时回落到旧 token（交给服务端的 401 定论）", async () => {
		seedState({ accessToken: "access-stale", expiresInMs: -1 });
		const { impl } = mockFetch(() => ({ status: 400, body: { error: "invalid_grant" } }));
		expect(await getMcpAccessToken({ agentDir, name: "suno", serverUrl: SERVER_URL, fetch: impl })).toBe(
			"access-stale",
		);
	});

	it("授权服务器报 invalid_grant 时抛「需要登录」，库保持不动", async () => {
		seedState({ accessToken: "access-stale", expiresInMs: -1 });
		const before = readFileSync(storePath(), "utf8");
		const { impl } = mockFetch(() => ({ status: 400, body: { error: "invalid_grant" } }));
		await expect(
			refreshMcpAccessToken({ agentDir, name: "suno", serverUrl: SERVER_URL, fetch: impl }),
		).rejects.toBeInstanceOf(McpOAuthSignInRequiredError);
		expect(readFileSync(storePath(), "utf8")).toBe(before);
	});

	it("凭据库锁只包住读-写，不跨网络请求；刷新期间 pi 写入的其它服务器不会丢", async () => {
		seedState({ accessToken: "access-stale", expiresInMs: -1 });
		const otherKey = mcpAuthStoreKey("other", "https://other.example.test/mcp");
		let lockHeldDuringTokenCall: boolean | undefined;
		const { impl } = mockFetch(() => {
			lockHeldDuringTokenCall = existsSync(`${storePath()}.lock`);
			const store = JSON.parse(readFileSync(storePath(), "utf8")) as Record<string, unknown>;
			store[otherKey] = { tokens: { access_token: "other-token" } };
			writeFileSync(storePath(), `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
			return { body: { access_token: "access-new", expires_in: 900 } };
		});

		await getMcpAccessToken({ agentDir, name: "suno", serverUrl: SERVER_URL, fetch: impl });

		expect(lockHeldDuringTokenCall).toBe(false);
		const store = readMcpAuthStore({ agentDir });
		expect(store[otherKey].tokens?.access_token).toBe("other-token");
		expect(store[mcpAuthStoreKey("suno", SERVER_URL)].tokens?.access_token).toBe("access-new");
		expect(existsSync(`${storePath()}.lock`)).toBe(false);
	});

	it("别的进程（pi）正持锁时先等它释放，不抢写", async () => {
		seedState({ accessToken: "access-stale", expiresInMs: -1 });
		const lockPath = `${storePath()}.lock`;
		mkdirSync(lockPath);
		const { impl, calls } = mockFetch(() => ({ body: { access_token: "access-new", expires_in: 900 } }));
		const pending = refreshMcpAccessToken({ agentDir, name: "suno", serverUrl: SERVER_URL, fetch: impl });

		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(calls).toHaveLength(0);
		rmSync(lockPath, { recursive: true, force: true });

		expect(await pending).toBe("access-new");
		expect(calls).toHaveLength(1);
	});

	it("没有刷新令牌 → 强制刷新抛「需要登录」", async () => {
		seedState({ accessToken: "access-only", refreshToken: null });
		const { impl, calls } = mockFetch(() => ({ body: {} }));
		await expect(
			refreshMcpAccessToken({ agentDir, name: "suno", serverUrl: SERVER_URL, fetch: impl }),
		).rejects.toBeInstanceOf(McpOAuthSignInRequiredError);
		expect(calls).toHaveLength(0);
	});
});

describe("401 后的强制刷新", () => {
	it("staleToken 与库里一致 → 真的刷新", async () => {
		seedState({ accessToken: "access-revoked", expiresInMs: 30 * 60_000 });
		const { impl, calls } = mockFetch(() => ({ body: { access_token: "access-new", expires_in: 900 } }));
		const token = await refreshMcpAccessToken({
			agentDir,
			name: "suno",
			serverUrl: SERVER_URL,
			staleToken: "access-revoked",
			fetch: impl,
		});
		expect(token).toBe("access-new");
		expect(calls).toHaveLength(1);
	});

	it("库里已被别的进程换掉 → 不再刷新（刷新令牌会轮换，二次刷新会毁掉授权）", async () => {
		seedState({ accessToken: "access-other", expiresInMs: 30 * 60_000 });
		const { impl, calls } = mockFetch(() => ({ body: { access_token: "should-not-be-used" } }));
		const token = await refreshMcpAccessToken({
			agentDir,
			name: "suno",
			serverUrl: SERVER_URL,
			staleToken: "access-mine",
			fetch: impl,
		});
		expect(token).toBe("access-other");
		expect(calls).toHaveLength(0);
	});

	it("并发刷新只发一次请求（跨进程锁 + staleToken 判据）", async () => {
		seedState({ accessToken: "access-stale", expiresInMs: -1 });
		const { impl, calls } = mockFetch(() => {
			return { body: { access_token: "access-new", expires_in: 900 } };
		});
		const results = await Promise.all([
			getMcpAccessToken({ agentDir, name: "suno", serverUrl: SERVER_URL, fetch: impl }),
			getMcpAccessToken({ agentDir, name: "suno", serverUrl: SERVER_URL, fetch: impl }),
			getMcpAccessToken({ agentDir, name: "suno", serverUrl: SERVER_URL, fetch: impl }),
		]);
		expect(results).toEqual(["access-new", "access-new", "access-new"]);
		expect(calls).toHaveLength(1);
	});

	it("client_secret_basic：密钥走 Basic 头，不进表单", async () => {
		seedState({ accessToken: "access-stale", expiresInMs: -1, clientSecret: "shh", authMethod: "client_secret_basic" });
		const { impl, calls } = mockFetch(() => ({ body: { access_token: "access-new", expires_in: 900 } }));
		await refreshMcpAccessToken({ agentDir, name: "suno", serverUrl: SERVER_URL, fetch: impl });
		expect(calls[0].headers.Authorization).toBe(`Basic ${Buffer.from("client-abc:shh").toString("base64")}`);
		expect(new URLSearchParams(calls[0].body).get("client_secret")).toBeNull();
	});
});

describe("McpClient：OAuth 头与 401→刷新→重试", () => {
	let server: Server;
	let url: string;
	let seenAuthorizations: (string | undefined)[] = [];
	let validToken = "access-valid";
	const clients: McpClient[] = [];

	beforeEach(async () => {
		seenAuthorizations = [];
		server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
			let body = "";
			for await (const chunk of req) body += chunk;

			if (req.url === "/token") {
				res.setHeader("content-type", "application/json");
				res.end(JSON.stringify({ access_token: validToken, expires_in: 900 }));
				return;
			}
			const json = body ? (JSON.parse(body) as { id?: number; method?: string }) : {};

			const auth = req.headers.authorization;
			seenAuthorizations.push(typeof auth === "string" ? auth : undefined);
			if (auth !== `Bearer ${validToken}`) {
				res.writeHead(401, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: "sign in to use this server" }));
				return;
			}
			res.setHeader("content-type", "application/json");
			if (json.method === "initialize") {
				res.end(
					JSON.stringify({
						jsonrpc: "2.0",
						id: json.id,
						result: {
							protocolVersion: "2025-03-26",
							capabilities: {},
							serverInfo: { name: "oauth-mcp", version: "1" },
						},
					}),
				);
				return;
			}
			if (json.method === "notifications/initialized") {
				res.writeHead(202);
				res.end();
				return;
			}
			if (json.method === "tools/list") {
				res.end(
					JSON.stringify({
						jsonrpc: "2.0",
						id: json.id,
						result: { tools: [{ name: "whoami", description: "who", inputSchema: { type: "object" } }] },
					}),
				);
				return;
			}
			res.end(JSON.stringify({ jsonrpc: "2.0", id: json.id, result: { ok: true } }));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as AddressInfo;
		url = `http://127.0.0.1:${port}/mcp`;
	});

	afterEach(async () => {
		for (const c of clients) {
			try {
				c.close();
			} catch {}
		}
		clients.length = 0;
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	function client(name = "suno"): McpClient {
		const c = new McpClient(name, { url }, () => {}, { agentDir });
		clients.push(c);
		return c;
	}

	function seedForUrl(options: { accessToken: string; expiresInMs?: number }): void {
		writeFileSync(
			storePath(),
			`${JSON.stringify(
				{
					[mcpAuthStoreKey("suno", url)]: {
						tokens: { access_token: options.accessToken, refresh_token: "refresh-old" },
						tokensExpireAt: Date.now() + (options.expiresInMs ?? 30 * 60_000),
						clientInformation: { client_id: "client-abc" },
						discovery: { authorizationServerMetadata: { token_endpoint: url.replace("/mcp", "/token") } },
					},
				},
				null,
				2,
			)}\n`,
			{ mode: 0o600 },
		);
	}

	it("把库里的 access token 作为 Authorization 头发出去", async () => {
		seedForUrl({ accessToken: "access-valid" });
		const c = client();
		await c.start();
		expect(seenAuthorizations[0]).toBe("Bearer access-valid");
		expect(c.getTools().map((t) => t.name)).toEqual(["whoami"]);
	});

	it("token 被吊销（401）→ 刷新后用新 token 重试同一请求", async () => {
		seedForUrl({ accessToken: "access-revoked" });
		validToken = "access-valid";
		const c = client();
		await c.start();
		expect(seenAuthorizations[0]).toBe("Bearer access-revoked");
		expect(seenAuthorizations[1]).toBe("Bearer access-valid");
		expect(c.getTools()).toHaveLength(1);
		expect(readMcpAuthStore({ agentDir })[mcpAuthStoreKey("suno", url)].tokens?.access_token).toBe("access-valid");
	});

	it("没有凭据 → 错误里直接告诉用户去 `pi mcp login <server>`", async () => {
		const c = client();
		await expect(c.start()).rejects.toThrow(/MCP_OAUTH_SIGN_IN_REQUIRED/);
		await expect(c.start()).rejects.toThrow(/pi mcp login suno/);
	});

	it("显式配置了 Authorization 头时不动 OAuth 凭据库", async () => {
		seedForUrl({ accessToken: "access-valid" });
		const explicit = new McpClient("suno", { url, headers: { Authorization: "Bearer access-valid" } }, () => {}, {
			agentDir,
		});
		clients.push(explicit);
		await explicit.start();
		expect(seenAuthorizations[0]).toBe("Bearer access-valid");
	});
});
