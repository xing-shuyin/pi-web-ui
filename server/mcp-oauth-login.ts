import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { authorizeMcp, McpOAuthProvider, MemoryOAuthStateStore } from "@earendil-works/pi-mcp/oauth";
import {
	getMcpAuthStorePath,
	mcpAuthStoreKey,
	readMcpAuthStore,
	withMcpAuthStoreLock,
	writeMcpAuthStore,
	type McpAuthStoreOptions,
	type McpOAuthState,
} from "./mcp-oauth.js";

const LOGIN_TTL_MS = 10 * 60_000;
const attempts = new Map<string, LoginAttempt>();
export interface McpOAuthLoginStatus {
	status: "pending" | "complete" | "error";
	error?: string;
}
interface LoginAttempt {
	controller: AbortController;
	server: Server;
	redirectUrl: string;
	authorizationUrl: string;
	provider: McpOAuthProvider;
	store: MemoryOAuthStateStore;
	options: McpAuthStoreOptions & { name: string; serverUrl: string };
	status: McpOAuthLoginStatus;
	finishing?: Promise<void>;
	timer: ReturnType<typeof setTimeout>;
}

export async function startMcpOAuthLogin(
	options: McpAuthStoreOptions & { name: string; serverUrl: string },
): Promise<{ id: string; authorizationUrl: string; redirectUrl: string }> {
	const url = new URL(options.serverUrl);
	if (
		url.protocol !== "https:" &&
		!(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
	)
		throw new Error("MCP OAuth requires HTTPS (HTTP is allowed only on loopback).");
	if (attempts.size >= 32) throw new Error("Too many pending MCP sign-ins. Close an existing sign-in and retry.");
	const id = randomBytes(24).toString("hex");
	const callbackPath = `/mcp/oauth/${randomBytes(16).toString("hex")}`;
	const controller = new AbortController();
	const store = new MemoryOAuthStateStore();
	const server = createServer((req, res) => {
		res.setHeader("Content-Type", "text/plain; charset=utf-8");
		res.setHeader("Cache-Control", "no-store");
		res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
		const attempt = attempts.get(id);
		if (!attempt || req.method !== "GET" || !req.url?.startsWith(`${callbackPath}?`)) {
			res.writeHead(404).end("Not found");
			return;
		}
		void finishMcpOAuthLogin({ id, redirectUrl: new URL(req.url, attempt.redirectUrl).href }).then(
			() => res.end("MCP sign-in complete. You can close this tab and return to pi-web-ui."),
			() => res.writeHead(400).end("MCP sign-in failed. Return to pi-web-ui and try again."),
		);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.removeListener("error", reject);
			resolve();
		});
	});
	server.unref();
	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		throw new Error("Cannot open MCP OAuth callback listener.");
	}
	const redirectUrl = `http://127.0.0.1:${address.port}${callbackPath}`;
	const provider = new McpOAuthProvider({
		serverUrl: options.serverUrl,
		redirectUrl,
		clientMetadata: {
			client_name: "pi-web-ui",
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		},
		store,
		onRedirect: (authorizationUrl) => {
			attempt.authorizationUrl = authorizationUrl.href;
		},
	});
	const attempt: LoginAttempt = {
		controller,
		server,
		redirectUrl,
		authorizationUrl: "",
		provider,
		store,
		options: { ...options },
		status: { status: "pending" },
		finishing: undefined,
		timer: setTimeout(() => cancelMcpOAuthLogin(id), LOGIN_TTL_MS),
	};
	attempt.timer.unref();
	attempts.set(id, attempt);
	try {
		await authorizeMcp(provider, {
			serverUrl: options.serverUrl,
			skipRefresh: true,
			signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
		});
		controller.signal.throwIfAborted();
		if (!attempt.authorizationUrl) throw new Error("No OAuth authorization URL returned.");
		return { id, authorizationUrl: attempt.authorizationUrl, redirectUrl };
	} catch {
		cancelMcpOAuthLogin(id);
		throw new Error(
			"Cannot start MCP OAuth sign-in. Check that the server supports OAuth discovery and client registration.",
		);
	}
}

function getAttempt(id: string): LoginAttempt {
	const attempt = attempts.get(id);
	if (!attempt) throw new Error("MCP sign-in expired or was cancelled. Start sign-in again.");
	return attempt;
}

export function getMcpOAuthLoginStatus(id: string): McpOAuthLoginStatus {
	return { ...getAttempt(id).status };
}

export async function finishMcpOAuthLogin({ id, redirectUrl }: { id: string; redirectUrl: string }): Promise<void> {
	const attempt = getAttempt(id);
	if (attempt.status.status === "complete") return;
	if (attempt.status.status === "error") throw new Error(attempt.status.error);
	let callback: URL;
	try {
		callback = new URL(redirectUrl);
	} catch {
		throw new Error("Paste the full OAuth redirect URL.");
	}
	const expected = new URL(attempt.redirectUrl);
	const state = attempt.store.load()?.oauthState;
	if (
		callback.origin !== expected.origin ||
		callback.pathname !== expected.pathname ||
		!state ||
		callback.searchParams.getAll("state").length !== 1 ||
		callback.searchParams.get("state") !== state
	)
		throw new Error("The OAuth redirect does not match this sign-in request.");
	if (attempt.finishing) return attempt.finishing;
	if (callback.searchParams.has("error")) {
		attempt.status = { status: "error", error: "OAuth authorization was denied. Start sign-in again." };
		attempt.server.close();
		throw new Error(attempt.status.error);
	}
	const code = callback.searchParams.get("code");
	if (!code || callback.searchParams.getAll("code").length !== 1)
		throw new Error("The OAuth redirect URL is missing an authorization code.");
	attempt.finishing = completeLogin(attempt, code, callback.searchParams.get("iss") ?? undefined);
	return attempt.finishing;
}

async function completeLogin(attempt: LoginAttempt, code: string, iss?: string): Promise<void> {
	try {
		const result = await authorizeMcp(attempt.provider, {
			serverUrl: attempt.options.serverUrl,
			authorizationCode: code,
			iss,
			signal: AbortSignal.any([attempt.controller.signal, AbortSignal.timeout(30_000)]),
		});
		if (result !== "AUTHORIZED" || !attempt.store.load()?.tokens?.access_token)
			throw new Error("No OAuth grant returned.");
		await withMcpAuthStoreLock(
			getMcpAuthStorePath(attempt.options),
			() => {
				attempt.controller.signal.throwIfAborted();
				const saved = { ...attempt.store.load()! };
				delete saved.codeVerifier;
				delete saved.oauthState;
				const credentials = readMcpAuthStore(attempt.options);
				credentials[mcpAuthStoreKey(attempt.options.name, attempt.options.serverUrl)] = saved as McpOAuthState;
				writeMcpAuthStore(credentials, attempt.options);
			},
			attempt.controller.signal,
		);
		attempt.status = { status: "complete" };
	} catch {
		attempt.status = { status: "error", error: "Cannot complete MCP OAuth sign-in. Start sign-in again." };
		throw new Error(attempt.status.error);
	} finally {
		attempt.server.close();
	}
}

export function cancelMcpOAuthLogin(id: string): void {
	const attempt = attempts.get(id);
	if (!attempt) return;
	attempt.controller.abort();
	attempt.server.close();
	clearTimeout(attempt.timer);
	attempts.delete(id);
}
