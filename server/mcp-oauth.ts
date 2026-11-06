import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { writeAtomicSync } from "./atomic-file.js";

export const MCP_REFRESH_SKEW_MS = 30_000;
const REFRESH_LOCK_STALE_MS = 20_000;
const REFRESH_LOCK_WAIT_MS = 25_000;
const REFRESH_LOCK_RETRY_MS = 100;
const REFRESH_REQUEST_TIMEOUT_MS = 20_000;
const STORE_LOCK_WAIT_MS = 2_000;
const STORE_LOCK_STALE_MS = 10_000;
const STORE_LOCK_RETRY_MS = 20;

export interface McpOAuthTokens {
	access_token?: string;
	refresh_token?: string;
	token_type?: string;
	expires_in?: number;
	scope?: string;
}

export interface McpOAuthState {
	tokens?: McpOAuthTokens;
	tokensExpireAt?: number;
	clientInformation?: {
		client_id?: string;
		client_secret?: string;
		token_endpoint_auth_method?: string;
	};
	discovery?: {
		authorizationServerMetadata?: {
			token_endpoint?: string;
			token_endpoint_auth_methods_supported?: string[];
		};
		resourceMetadata?: { resource?: string };
	};
}

export type McpAuthStore = Record<string, McpOAuthState>;

export class McpOAuthSignInRequiredError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "McpOAuthSignInRequiredError";
	}
}

export interface McpAuthStoreOptions {
	agentDir?: string;
	storePath?: string;
}

export interface McpOAuthTokenOptions extends McpAuthStoreOptions {
	name: string;
	serverUrl: string;
	fetch?: typeof fetch;
	now?: () => number;
	signal?: AbortSignal;
}

export interface McpRefreshOptions extends McpOAuthTokenOptions {
	staleToken?: string;
}

export function defaultMcpAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function getMcpAuthStorePath(options: McpAuthStoreOptions = {}): string {
	if (options.storePath) return options.storePath;
	return join(options.agentDir || defaultMcpAgentDir(), "mcp-auth.json");
}

function normalizeServerUrl(serverUrl: string): string {
	try {
		return String(new URL(serverUrl));
	} catch {
		return serverUrl;
	}
}

function mcpNamespace(name: string): string {
	return `mcp__${name.replace(/-/g, "_")}`;
}

export function mcpAuthStoreKey(name: string, serverUrl: string): string {
	return `${mcpNamespace(name)}|${normalizeServerUrl(serverUrl)}`;
}

export function mcpAuthLegacyKey(serverUrl: string): string {
	return normalizeServerUrl(serverUrl);
}

export function readMcpAuthStore(options: McpAuthStoreOptions = {}): McpAuthStore {
	try {
		const parsed = JSON.parse(readFileSync(getMcpAuthStorePath(options), "utf8")) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as McpAuthStore;
	} catch {}
	return {};
}

export function writeMcpAuthStore(store: McpAuthStore, options: McpAuthStoreOptions = {}): void {
	writeAtomicSync(getMcpAuthStorePath(options), `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

export function loadMcpAuthState(options: McpAuthStoreOptions & { name: string; serverUrl: string }): {
	key: string;
	legacyKey: string;
	state: McpOAuthState | undefined;
} {
	const key = mcpAuthStoreKey(options.name, options.serverUrl);
	const legacyKey = mcpAuthLegacyKey(options.serverUrl);
	const store = readMcpAuthStore(options);
	return { key, legacyKey, state: store[key] ?? store[legacyKey] };
}

function isExpired(state: McpOAuthState, nowMs: number): boolean {
	const expireAt = state.tokensExpireAt;
	if (typeof expireAt !== "number") return false;
	return expireAt - MCP_REFRESH_SKEW_MS <= nowMs;
}

function lockPathFor(storePath: string, key: string): string {
	const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
	return `${storePath.replace(/mcp-auth\.json$/, "")}mcp-auth-refresh-${hash}.lock`;
}

async function withRefreshLock<T>(
	storePath: string,
	key: string,
	fn: () => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	const lockPath = lockPathFor(storePath, key);
	mkdirSync(join(lockPath, ".."), { recursive: true, mode: 0o700 });
	const deadline = Date.now() + REFRESH_LOCK_WAIT_MS;
	for (;;) {
		signal?.throwIfAborted();
		try {
			mkdirSync(lockPath);
			break;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			try {
				if (Date.now() - statSync(lockPath).mtimeMs > REFRESH_LOCK_STALE_MS) {
					rmSync(lockPath, { recursive: true, force: true });
					continue;
				}
			} catch {
				continue;
			}
			if (Date.now() > deadline)
				throw new Error("Timed out waiting for the MCP refresh lock (another process is refreshing)");
			await sleep(REFRESH_LOCK_RETRY_MS, undefined, { signal });
		}
	}
	const renewal = setInterval(
		() => {
			try {
				const now = new Date();
				utimesSync(lockPath, now, now);
			} catch {}
		},
		Math.max(1_000, Math.floor(REFRESH_LOCK_STALE_MS / 4)),
	);
	renewal.unref?.();
	try {
		signal?.throwIfAborted();
		return await fn();
	} finally {
		clearInterval(renewal);
		rmSync(lockPath, { recursive: true, force: true });
	}
}

export async function withMcpAuthStoreLock<T>(storePath: string, fn: () => T, signal?: AbortSignal): Promise<T> {
	const lockPath = `${storePath}.lock`;
	mkdirSync(dirname(storePath), { recursive: true, mode: 0o700 });
	const deadline = Date.now() + STORE_LOCK_WAIT_MS;
	for (;;) {
		signal?.throwIfAborted();
		try {
			mkdirSync(lockPath, { mode: 0o700 });
			break;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			try {
				if (Date.now() - statSync(lockPath).mtimeMs > STORE_LOCK_STALE_MS) {
					rmSync(lockPath, { recursive: true, force: true });
					continue;
				}
			} catch {
				continue;
			}
			if (Date.now() > deadline) throw new Error(`Timed out waiting for the MCP credential store lock (${lockPath})`);
			await sleep(STORE_LOCK_RETRY_MS, undefined, { signal });
		}
	}
	try {
		signal?.throwIfAborted();
		return fn();
	} finally {
		rmSync(lockPath, { recursive: true, force: true });
	}
}

interface RefreshResponseTokens extends McpOAuthTokens {
	access_token: string;
}

function parseTokenResponse(value: unknown, fallbackRefreshToken: string): RefreshResponseTokens {
	if (!value || typeof value !== "object") {
		throw new McpOAuthSignInRequiredError(
			"The authorization server answered the refresh with something that is not a JSON object",
		);
	}
	const raw = value as Record<string, unknown>;
	if (typeof raw.error === "string") {
		const description = typeof raw.error_description === "string" ? raw.error_description : String(raw.error);
		throw new McpOAuthSignInRequiredError(`The authorization server rejected the refresh token: ${description}`);
	}
	if (typeof raw.access_token !== "string" || !raw.access_token) {
		throw new McpOAuthSignInRequiredError("The authorization server answered the refresh without an access_token");
	}
	return {
		access_token: raw.access_token,
		refresh_token:
			typeof raw.refresh_token === "string" && raw.refresh_token ? raw.refresh_token : fallbackRefreshToken,
		token_type: typeof raw.token_type === "string" ? raw.token_type : undefined,
		expires_in: typeof raw.expires_in === "number" ? raw.expires_in : undefined,
		scope: typeof raw.scope === "string" ? raw.scope : undefined,
	};
}

function selectClientAuthMethod(state: McpOAuthState): "client_secret_basic" | "client_secret_post" | "none" {
	const information = state.clientInformation ?? {};
	const hinted = information.token_endpoint_auth_method;
	if (hinted === "client_secret_basic" || hinted === "client_secret_post" || hinted === "none") return hinted;
	return information.client_secret ? "client_secret_basic" : "none";
}

async function requestRefreshToken(state: McpOAuthState, options: McpRefreshOptions): Promise<RefreshResponseTokens> {
	const tokenEndpoint = state.discovery?.authorizationServerMetadata?.token_endpoint;
	const clientId = state.clientInformation?.client_id;
	const refreshToken = state.tokens?.refresh_token;
	if (!tokenEndpoint) {
		throw new McpOAuthSignInRequiredError("The stored credentials have no token endpoint; sign in again");
	}
	if (!clientId) {
		throw new McpOAuthSignInRequiredError("The stored credentials have no client_id; sign in again");
	}
	if (!refreshToken) {
		throw new McpOAuthSignInRequiredError("The stored credentials have no refresh token; sign in again");
	}

	const params = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken });
	const resource = state.discovery?.resourceMetadata?.resource ?? options.serverUrl;
	if (resource) params.set("resource", resource);
	const headers: Record<string, string> = {
		Accept: "application/json",
		"Content-Type": "application/x-www-form-urlencoded",
	};
	const method = selectClientAuthMethod(state);
	const secret = state.clientInformation?.client_secret;
	if (method === "client_secret_basic" && secret) {
		headers.Authorization = `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`;
	} else {
		params.set("client_id", clientId);
		if (method === "client_secret_post" && secret) params.set("client_secret", secret);
	}

	const doFetch = options.fetch ?? fetch;
	const timeout = AbortSignal.timeout(REFRESH_REQUEST_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	signal.throwIfAborted();
	let response: Response;
	try {
		response = await doFetch(tokenEndpoint, { method: "POST", headers, body: params.toString(), signal });
	} catch (err) {
		signal.throwIfAborted();
		const detail = err instanceof Error ? err.message : String(err);
		throw new Error(`MCP token refresh request failed: ${detail}`);
	}
	const text = await response.text().catch((err) => {
		signal.throwIfAborted();
		throw err;
	});
	signal.throwIfAborted();
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		parsed = undefined;
	}
	if (parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string") {
		return parseTokenResponse(parsed, refreshToken);
	}
	if (!response.ok) {
		throw new McpOAuthSignInRequiredError(`MCP token refresh failed (HTTP ${response.status}): ${text.slice(0, 200)}`);
	}
	return parseTokenResponse(parsed, refreshToken);
}

export async function refreshMcpAccessToken(options: McpRefreshOptions): Promise<string | null> {
	const storePath = getMcpAuthStorePath(options);
	const key = mcpAuthStoreKey(options.name, options.serverUrl);
	const { signal } = options;
	return withRefreshLock(
		storePath,
		key,
		async () => {
			const legacyKey = mcpAuthLegacyKey(options.serverUrl);
			const { state, sourceKey } = await withMcpAuthStoreLock(
				storePath,
				() => {
					const store = readMcpAuthStore(options);
					const sourceKey = store[key] ? key : legacyKey;
					return { state: store[sourceKey], sourceKey };
				},
				signal,
			);
			if (!state?.tokens?.access_token && !state?.tokens?.refresh_token) {
				throw new McpOAuthSignInRequiredError(
					`MCP server "${options.name}" needs an OAuth sign-in (no stored credentials found)`,
				);
			}
			const storedToken = state?.tokens?.access_token;
			if (options.staleToken && storedToken && storedToken !== options.staleToken) {
				return storedToken;
			}
			if (!state) return null;
			const tokens = await requestRefreshToken(state, options);
			const nowMs = (options.now ?? Date.now)();
			const expiresAt = typeof tokens.expires_in === "number" ? nowMs + tokens.expires_in * 1000 : undefined;
			return withMcpAuthStoreLock(
				storePath,
				() => {
					signal?.throwIfAborted();
					const fresh = readMcpAuthStore(options);
					const currentKey = fresh[key] ? key : legacyKey;
					const base = fresh[currentKey];
					if (currentKey !== sourceKey || !base || !sameCredentials(base, state)) {
						return base?.tokens?.access_token ?? null;
					}
					const next: McpOAuthState = {
						...base,
						tokens: { ...base.tokens, ...trimUndefined(tokens) },
					};
					if (expiresAt === undefined) delete next.tokensExpireAt;
					else next.tokensExpireAt = expiresAt;
					fresh[key] = next;
					if (sourceKey === legacyKey && legacyKey !== key) delete fresh[legacyKey];
					signal?.throwIfAborted();
					writeMcpAuthStore(fresh, options);
					return tokens.access_token;
				},
				signal,
			);
		},
		signal,
	);
}

function sameCredentials(a: McpOAuthState, b: McpOAuthState): boolean {
	return isDeepStrictEqual(
		[a.tokens, a.tokensExpireAt, a.clientInformation, a.discovery],
		[b.tokens, b.tokensExpireAt, b.clientInformation, b.discovery],
	);
}

function trimUndefined(tokens: McpOAuthTokens): McpOAuthTokens {
	const out: McpOAuthTokens = {};
	for (const [k, v] of Object.entries(tokens)) {
		if (v !== undefined) (out as Record<string, unknown>)[k] = v;
	}
	return out;
}

export async function getMcpAccessToken(options: McpOAuthTokenOptions): Promise<string | null> {
	options.signal?.throwIfAborted();
	const { state } = loadMcpAuthState(options);
	const token = state?.tokens?.access_token;
	if (!state || !token) return null;
	if (!isExpired(state, (options.now ?? Date.now)())) return token;
	if (!state.tokens?.refresh_token) return token;
	try {
		return await refreshMcpAccessToken({ ...options, staleToken: token });
	} catch {
		options.signal?.throwIfAborted();
		return loadMcpAuthState(options).state?.tokens?.access_token ?? null;
	}
}
