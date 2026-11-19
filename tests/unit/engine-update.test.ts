import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import {
	classifyEngineUpdateError,
	isVersionOutdated,
	queryLatestVersion,
	registerEngineUpdateRoutes,
} from "../../server/engine-update.js";

describe("engine version compare", () => {
	it("numeric segments, longer wins only when greater", () => {
		expect(isVersionOutdated("1.1.0", "1.5.2")).toBe(true);
		expect(isVersionOutdated("1.5.2", "1.5.2")).toBe(false);
		expect(isVersionOutdated("1.10.0", "1.9.9")).toBe(false);
		expect(isVersionOutdated(null, "1.5.2")).toBe(false);
		expect(isVersionOutdated("1.5.2", null)).toBe(false);
	});
});

describe("engine update error classification", () => {
	const base = { code: 1, stdout: "", stderr: "", timedOut: false, aborted: false } as const;
	it("timeout is distinguished", () => {
		expect(classifyEngineUpdateError({ ...base, timedOut: true })).toMatch(/超时/);
	});
	it("permission failures are distinguished", () => {
		expect(classifyEngineUpdateError({ ...base, stderr: "npm ERR! Error: EACCES permission denied" })).toMatch(
			/权限不足/,
		);
	});
	it("network failures are distinguished", () => {
		expect(classifyEngineUpdateError({ ...base, stderr: "npm ERR! ENOTFOUND registry.npmjs.org" })).toMatch(/网络失败/);
		expect(classifyEngineUpdateError({ ...base, stderr: "fetch failed" })).toMatch(/网络失败/);
	});
	it("missing npm is distinguished", () => {
		expect(classifyEngineUpdateError({ ...base, code: null, spawnError: "spawn npm ENOENT" })).toMatch(/npm/);
	});
	it("generic output keeps the first line, empty output falls back to exit code", () => {
		expect(classifyEngineUpdateError({ ...base, stderr: "\nboom line\nsecond" })).toBe("更新失败：boom line");
		expect(classifyEngineUpdateError({ ...base })).toMatch(/exit 1/);
	});
});

describe("engine registry fallback", () => {
	it("fetch rejection resolves to null instead of throwing", async () => {
		await expect(
			queryLatestVersion(() => {
				throw new Error("offline");
			}),
		).resolves.toBeNull();
		await expect(queryLatestVersion(() => Promise.reject(new Error("offline")))).resolves.toBeNull();
	});
	it("abort path still resolves to null", async () => {
		await expect(
			queryLatestVersion((signal) => {
				signal.throwIfAborted();
				return Promise.resolve("9.9.9");
			}),
		).resolves.toBe("9.9.9");
	});
});

describe("engine routes with fake runtime", () => {
	let server: Server | null = null;
	afterEach(async () => {
		if (server) {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server!.close(() => resolve()));
			server = null;
		}
		vi.restoreAllMocks();
	});

	async function start(deps: Parameters<typeof registerEngineUpdateRoutes>[1]) {
		const app = express();
		app.use(express.json());
		registerEngineUpdateRoutes(app, deps);
		server = await new Promise<Server>((resolve, reject) => {
			const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
			instance.once("error", reject);
		});
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Missing test server address");
		return `http://127.0.0.1:${address.port}`;
	}

	it("GET /api/engine/status returns the bundled/inUse/latest shape", async () => {
		const origin = await start({
			getBundledVersion: () => "1.1.0",
			getInUseVersion: () => "1.5.2",
			getLatestVersion: () => Promise.resolve("1.5.2"),
		});
		const res = await fetch(`${origin}/api/engine/status`);
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(await res.json()).toEqual({ bundled: "1.1.0", inUse: "1.5.2", latest: "1.5.2" });
	});

	it("GET degrades to null when the registry is unreachable", async () => {
		const origin = await start({
			getBundledVersion: () => "1.1.0",
			getInUseVersion: () => "1.1.0",
			getLatestVersion: () => Promise.reject(new Error("offline")),
		});
		expect(await (await fetch(`${origin}/api/engine/status`)).json()).toEqual({
			bundled: "1.1.0",
			inUse: "1.1.0",
			latest: null,
		});
	});

	it("POST success returns ok+version, failure returns ok:false with human error", async () => {
		const okOrigin = await start({
			getLatestVersion: () => Promise.resolve("1.5.2"),
			runGlobalUpdate: () => Promise.resolve({ code: 0, stdout: "ok", stderr: "", timedOut: false, aborted: false }),
		});
		expect(
			await (
				await fetch(`${okOrigin}/api/engine/update`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: "{}",
				})
			).json(),
		).toEqual({ ok: true, version: "1.5.2" });

		const failOrigin = await start({
			getLatestVersion: () => Promise.resolve("1.5.2"),
			runGlobalUpdate: () =>
				Promise.resolve({ code: 1, stdout: "", stderr: "ENOTFOUND registry", timedOut: false, aborted: false }),
		});
		const failRes = await fetch(`${failOrigin}/api/engine/update`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
		});
		expect(failRes.status).toBe(500);
		const failBody = (await failRes.json()) as { ok: boolean; error: string };
		expect(failBody.ok).toBe(false);
		expect(failBody.error).toMatch(/网络失败/);
	});

	it("POST never invokes npm twice concurrently", async () => {
		let calls = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const origin = await start({
			getLatestVersion: () => Promise.resolve("1.5.2"),
			runGlobalUpdate: () => {
				calls += 1;
				return gate.then(() => ({ code: 0, stdout: "", stderr: "", timedOut: false, aborted: false }));
			},
		});
		const post = () =>
			fetch(`${origin}/api/engine/update`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{}",
			});
		const first = post();
		await vi.waitFor(() => expect(calls).toBe(1));
		const second = await post();
		expect(second.status).toBe(409);
		expect(await second.json()).toEqual({ ok: false, error: expect.any(String) });
		release();
		expect(await (await first).json()).toEqual({ ok: true, version: "1.5.2" });
		expect(calls).toBe(1);
	});
});
