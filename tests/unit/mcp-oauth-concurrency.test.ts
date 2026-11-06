import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpClient } from "../../server/mcp-bridge.js";
import { getMcpAccessToken, refreshMcpAccessToken } from "../../server/mcp-oauth.js";

const url = "https://mcp.example.test/mcp";
const key = `mcp__test|${url}`;
let agentDir: string;
let path: string;
const clients: McpClient[] = [];
function deferred<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}
function state(token = "old") {
	return {
		tokens: { access_token: token, refresh_token: `refresh-${token}` },
		tokensExpireAt: Date.now() - 1000,
		clientInformation: { client_id: "client" },
		discovery: { authorizationServerMetadata: { token_endpoint: "https://auth.example.test/token" } },
	};
}
function save(store: Record<string, unknown>) {
	writeFileSync(path, JSON.stringify(store));
}
function load() {
	return JSON.parse(readFileSync(path, "utf8"));
}
function json(value: unknown, status = 200) {
	return new Response(JSON.stringify(value), { status });
}
function options(signal?: AbortSignal) {
	return { agentDir, name: "test", serverUrl: url, staleToken: "old", signal };
}
function request(client: McpClient, timeout = 8000, signal?: AbortSignal): Promise<unknown> {
	return (client as any).requestHttp("tools/call", {}, timeout, signal);
}
function client() {
	const c = new McpClient("test", { url }, () => {}, { agentDir });
	clients.push(c);
	return c;
}
beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "mcp-oauth-races-"));
	path = join(agentDir, "mcp-auth.json");
	save({ [key]: state() });
});
afterEach(() => {
	for (const c of clients.splice(0)) c.close();
	vi.restoreAllMocks();
	vi.useRealTimers();
	rmSync(agentDir, { recursive: true, force: true });
});

describe("refresh commit compare-and-swap", () => {
	it.each(["delete", "relogin", "client", "discovery", "expiry", "refresh-token"])(
		"preserves %s during an in-flight refresh",
		async (change) => {
			const entered = deferred();
			const release = deferred<Response>();
			const fetch = vi.fn(async () => {
				entered.resolve();
				return release.promise;
			});
			const pending = refreshMcpAccessToken({ ...options(), fetch });
			await entered.promise;
			const store = load();
			if (change === "delete") delete store[key];
			if (change === "relogin") store[key] = state("relogin");
			if (change === "client") store[key].clientInformation.client_id = "new-client";
			if (change === "discovery") store[key].discovery.authorizationServerMetadata.token_endpoint += "/new";
			if (change === "expiry") store[key].tokensExpireAt += 1000;
			if (change === "refresh-token") store[key].tokens.refresh_token = "rotated-elsewhere";
			store.other = { untouched: true };
			save(store);
			const before = readFileSync(path, "utf8");
			release.resolve(json({ access_token: "invalid-stale-result", refresh_token: "invalid-refresh" }));
			expect(await pending).toBe(change === "delete" ? null : change === "relogin" ? "relogin" : "old");
			expect(readFileSync(path, "utf8")).toBe(before);
		},
	);

	it("migrates legacy state while preserving unrelated fields, entries, and a separate legacy grant", async () => {
		save({ [url]: state() });
		const fetch = vi.fn(async () => {
			const store = load();
			store[url].pendingVerifier = "keep";
			store.other = { untouched: true };
			save(store);
			return json({ access_token: "new" });
		});
		expect(await refreshMcpAccessToken({ ...options(), fetch })).toBe("new");
		expect(load()).toMatchObject({
			[key]: { pendingVerifier: "keep", tokens: { access_token: "new" } },
			other: { untouched: true },
		});
		expect(load()[url]).toBeUndefined();
		const legacy = state("separate");
		save({ ...load(), [url]: legacy });
		await refreshMcpAccessToken({
			...options(),
			staleToken: "new",
			fetch: async () => json({ access_token: "newer" }),
		});
		expect(load()[url]).toEqual(legacy);
	});

	it.each(["delete", "relogin"])("re-reads the current grant after failed refresh and %s", async (change) => {
		const fetch = vi.fn(async () => {
			save(change === "delete" ? {} : { [key]: state("relogin") });
			throw new Error("network failure");
		});
		expect(await getMcpAccessToken({ ...options(), fetch })).toBe(change === "delete" ? null : "relogin");
	});
});

describe("refresh cancellation isolation", () => {
	it("a canceled lock waiter cannot abort the holder or another waiter", async () => {
		const entered = deferred();
		const release = deferred<Response>();
		const fetch = vi.fn(async () => {
			entered.resolve();
			return release.promise;
		});
		const holder = refreshMcpAccessToken({ ...options(), fetch });
		await entered.promise;
		const controller = new AbortController();
		const canceled = refreshMcpAccessToken({ ...options(controller.signal), fetch });
		const rejected = expect(canceled).rejects.toThrow();
		const survivor = refreshMcpAccessToken({ ...options(), fetch });
		controller.abort();
		await rejected;
		release.resolve(json({ access_token: "new", refresh_token: "rotated" }));
		expect(await holder).toBe("new");
		expect(await survivor).toBe("new");
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("canceled holder discards a late response and releases its lock for a survivor", async () => {
		const entered = deferred();
		const release = deferred<Response>();
		const controller = new AbortController();
		const fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
			expect(init?.signal).toBeDefined();
			entered.resolve();
			return release.promise;
		});
		const pending = refreshMcpAccessToken({ ...options(controller.signal), fetch });
		const rejected = expect(pending).rejects.toThrow();
		await entered.promise;
		controller.abort();
		release.resolve(json({ access_token: "must-not-commit" }));
		await rejected;
		expect(load()[key].tokens.access_token).toBe("old");
		expect(await refreshMcpAccessToken({ ...options(), fetch: async () => json({ access_token: "survivor" }) })).toBe(
			"survivor",
		);
	});

	it.each(["refresh", "store"])("can cancel while waiting for the %s lock", async (kind) => {
		const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
		const lock = kind === "store" ? `${path}.lock` : join(agentDir, `mcp-auth-refresh-${hash}.lock`);
		mkdirSync(lock);
		const controller = new AbortController();
		const fetch = vi.fn();
		const pending = refreshMcpAccessToken({ ...options(controller.signal), fetch });
		const rejected = expect(pending).rejects.toThrow();
		controller.abort();
		await rejected;
		expect(fetch).not.toHaveBeenCalled();
	});

	it("cancels response body reads and cannot write back after cancellation", async () => {
		const entered = deferred();
		const controller = new AbortController();
		const fetch = vi.fn(
			async (_input: unknown, init?: RequestInit) =>
				new Response(
					new ReadableStream({
						start(stream) {
							entered.resolve();
							init?.signal?.addEventListener("abort", () => stream.error(new Error("body canceled")), { once: true });
						},
					}),
				),
		);
		const pending = refreshMcpAccessToken({ ...options(controller.signal), fetch });
		const rejected = expect(pending).rejects.toThrow();
		await entered.promise;
		controller.abort();
		await rejected;
		expect(load()[key].tokens.access_token).toBe("old");
	});

	it("checks cancellation while waiting to commit under the store lock", async () => {
		const entered = deferred();
		const controller = new AbortController();
		const fetch = vi.fn(async () => {
			mkdirSync(`${path}.lock`);
			entered.resolve();
			return json({ access_token: "must-not-commit" });
		});
		const pending = refreshMcpAccessToken({ ...options(controller.signal), fetch });
		const rejected = expect(pending).rejects.toThrow();
		await entered.promise;
		controller.abort();
		await rejected;
		expect(load()[key].tokens.access_token).toBe("old");
	});
});

describe("HTTP request auth lifecycle", () => {
	it("uses each request's actual token for overlapping 401s, even after another request uses the refreshed token", async () => {
		const stored = state();
		stored.tokensExpireAt = Date.now() + 60_000;
		save({ [key]: stored });
		const first401 = deferred<Response>();
		const second401 = deferred<Response>();
		const firstSent = deferred();
		const secondSent = deferred();
		let oldRequests = 0;
		let refreshes = 0;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			if (String(input).includes("auth.example")) {
				refreshes++;
				return json({ access_token: "new", expires_in: 900 });
			}
			if ((init?.headers as Record<string, string>).Authorization === "Bearer old") {
				if (++oldRequests === 1) {
					firstSent.resolve();
					return first401.promise;
				}
				secondSent.resolve();
				return second401.promise;
			}
			return json({ result: "ok" });
		});
		const c = client();
		const first = request(c);
		await firstSent.promise;
		const second = request(c);
		await secondSent.promise;
		first401.resolve(json({}, 401));
		expect(await first).toBe("ok");
		expect(await request(c)).toBe("ok");
		second401.resolve(json({}, 401));
		expect(await second).toBe("ok");
		expect(refreshes).toBe(1);
	});

	it.each([
		["abort", "preflight"],
		["timeout", "preflight"],
		["close", "preflight"],
		["abort", "401"],
		["timeout", "401"],
		["close", "401"],
	])("%s settles auth during %s promptly and prevents late writeback", async (kind, phase) => {
		const entered = deferred();
		const release = deferred<Response>();
		let refreshSignal: AbortSignal | null | undefined;
		if (phase === "401") {
			const stored = state();
			stored.tokensExpireAt = Date.now() + 60_000;
			save({ [key]: stored });
		}
		const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			if (String(input) === url) return json({}, 401);
			refreshSignal = init?.signal;
			entered.resolve();
			return release.promise;
		});
		const c = client();
		const controller = new AbortController();
		if (kind === "timeout") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const pending = request(c, 1000, controller.signal);
		const rejected = expect(pending).rejects.toThrow(
			kind === "timeout" ? /超时/ : kind === "close" ? /closed/ : /aborted/,
		);
		await entered.promise;
		if (kind === "abort") controller.abort();
		if (kind === "close") c.close();
		if (kind === "timeout") await vi.advanceTimersByTimeAsync(1000);
		await rejected;
		expect(refreshSignal?.aborted).toBe(true);
		release.resolve(json({ access_token: "late" }));
		await vi.waitFor(() => expect((c as any).pending.size).toBe(0));
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(load()[key].tokens.access_token).toBe("old");
		expect(fetch).toHaveBeenCalledTimes(phase === "401" ? 2 : 1);
	});

	it("timeout cancels an SSE reader through the internal request signal", async () => {
		const stored = state();
		stored.tokensExpireAt = Date.now() + 60_000;
		save({ [key]: stored });
		const reading = deferred();
		const cancel = vi.fn();
		vi.spyOn(globalThis, "fetch").mockImplementation(
			async () =>
				new Response(
					new ReadableStream({
						pull() {
							reading.resolve();
						},
						cancel,
					}),
					{ headers: { "content-type": "text/event-stream" } },
				),
		);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const pending = request(client(), 1000);
		const rejected = expect(pending).rejects.toThrow(/超时/);
		await reading.promise;
		await vi.advanceTimersByTimeAsync(1000);
		await rejected;
		expect(cancel).toHaveBeenCalledTimes(1);
	});

	it("a late noncooperative HTTP response cannot restore a closed session", async () => {
		const stored = state();
		stored.tokensExpireAt = Date.now() + 60_000;
		save({ [key]: stored });
		const entered = deferred();
		const release = deferred<Response>();
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			entered.resolve();
			return release.promise;
		});
		const c = client();
		const pending = request(c);
		const rejected = expect(pending).rejects.toThrow(/closed/);
		await entered.promise;
		c.close();
		await rejected;
		release.resolve(
			new Response(JSON.stringify({ result: "late" }), { headers: { "mcp-session-id": "must-not-restore" } }),
		);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect((c as any).sessionId).toBeNull();
	});

	it("notification timeout covers expired-token preflight", async () => {
		const entered = deferred();
		let refreshSignal: AbortSignal | null | undefined;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			refreshSignal = init?.signal;
			entered.resolve();
			return new Promise((_resolve, reject) =>
				init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
			);
		});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const pending = (client() as any).sendHttpNotification("notifications/initialized", {});
		await entered.promise;
		await vi.advanceTimersByTimeAsync(8000);
		await pending;
		expect(refreshSignal?.aborted).toBe(true);
		expect(load()[key].tokens.access_token).toBe("old");
	});

	it("close cancels notification preflight too", async () => {
		const entered = deferred();
		let refreshSignal: AbortSignal | null | undefined;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			refreshSignal = init?.signal;
			entered.resolve();
			return new Promise((_resolve, reject) =>
				init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
			);
		});
		const c = client();
		const pending = (c as any).sendHttpNotification("notifications/initialized", {});
		await entered.promise;
		c.close();
		await pending;
		expect(refreshSignal?.aborted).toBe(true);
		expect(load()[key].tokens.access_token).toBe("old");
	});
});
