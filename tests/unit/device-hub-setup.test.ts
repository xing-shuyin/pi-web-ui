import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer, request } from "node:http";
import { installHubSetupRoutes, validateHubSetup } from "../../server/device-center/hub-setup.js";
import { installLocalDeviceCenter } from "../../server/device-center/local.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
});
const emptyStatus = {
	schemaVersion: 1,
	service: "pi-device-hub",
	installed: false,
	running: false,
	owned: false,
	publicUrl: null,
	host: null,
	port: null,
	dataDir: null,
};
const input = { host: "127.0.0.1", port: 8790, publicUrl: "http://127.0.0.1:8790", allowRegistration: true };
async function serve(app: express.Express) {
	const server = createServer(app);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanup.push(
		() =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	);
	const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	return {
		base,
		post: (body: unknown) =>
			fetch(`${base}/api/device-center/setup`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Origin: base },
				body: JSON.stringify(body),
			}),
	};
}

describe("Hub guided installation", () => {
	it("validates bind addresses, origin-only URLs and explicit registration before executing", () => {
		expect(validateHubSetup(input)).toEqual(input);
		for (const patch of [
			{ host: "127.0.0.1;echo bad" },
			{ host: "example.com" },
			{ port: 80 },
			{ port: 1.5 },
			{ publicUrl: "file:///tmp/a" },
			{ publicUrl: "http://user@example.com" },
			{ publicUrl: "http://example.com/path" },
			{ publicUrl: "http://example.com?token=x" },
			{ publicUrl: "http://0.0.0.0:8790" },
			{ allowRegistration: false },
			{ dataDir: "/tmp/other" },
		])
			expect(() => validateHubSetup({ ...input, ...patch })).toThrow();
	});
	it("serializes installation and supplies fixed CLI arguments without shell interpolation", async () => {
		const app = express();
		app.use(express.json());
		let finish!: (output: string) => void;
		const runner = vi.fn((args: string[]) =>
			args[1] === "status"
				? Promise.resolve(JSON.stringify(emptyStatus))
				: new Promise<string>((resolve) => {
						finish = resolve;
					}),
		);
		const setup = installHubSetupRoutes(app, "/isolated data", runner);
		cleanup.push(() => setup.close());
		const { base, post } = await serve(app);
		const pending = post(input);
		await vi.waitFor(() => expect(runner).toHaveBeenCalledOnce());
		expect((await post(input)).status).toBe(409);
		expect(runner.mock.calls[0]).toBeDefined();
		const metadata = await (await fetch(`${base}/api/device-center/setup`)).json();
		expect(metadata.busy).toBe(true);
		expect(metadata.dataDir).toBe(join("/isolated data", "device-hub"));
		finish("Service installed and healthy");
		expect(await (await pending).json()).toEqual({
			publicUrl: input.publicUrl,
			output: "Service installed and healthy",
		});
	});
	it("restores saved installation metadata after refresh and reports unknown state as an error", async () => {
		const app = express();
		app.use(express.json());
		const saved = {
			...emptyStatus,
			installed: true,
			running: true,
			owned: true,
			publicUrl: "http://localhost:9012",
			host: "127.0.0.1",
			port: 9012,
			dataDir: "/saved/hub",
		};
		const runner = vi
			.fn()
			.mockResolvedValueOnce(JSON.stringify(saved))
			.mockRejectedValueOnce(new Error("Cannot read config"));
		const setup = installHubSetupRoutes(app, "/isolated", runner);
		cleanup.push(() => setup.close());
		const { base } = await serve(app);
		const metadata = await (await fetch(`${base}/api/device-center/setup`)).json();
		expect(metadata.installation).toMatchObject({
			installed: true,
			owned: true,
			port: 9012,
			publicUrl: saved.publicUrl,
		});
		const failed = await fetch(`${base}/api/device-center/setup`);
		expect(failed.status).toBe(503);
		expect(await failed.json()).toEqual({ error: "Cannot read config" });
	});
	it("bounds concurrent status queries and cancels them when their browser disconnects", async () => {
		const app = express();
		app.use(express.json());
		const signals: AbortSignal[] = [];
		const runner = vi.fn(
			(_args: string[], signal: AbortSignal) =>
				new Promise<string>((_resolve, reject) => {
					signals.push(signal);
					signal.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true });
				}),
		);
		const setup = installHubSetupRoutes(app, "/isolated", runner);
		cleanup.push(() => setup.close());
		const { base } = await serve(app);
		const first = new AbortController(),
			second = new AbortController();
		const one = fetch(`${base}/api/device-center/setup`, { signal: first.signal }).catch(() => null);
		const two = fetch(`${base}/api/device-center/setup`, { signal: second.signal }).catch(() => null);
		await vi.waitFor(() => expect(signals).toHaveLength(2));
		expect((await fetch(`${base}/api/device-center/setup`)).status).toBe(429);
		first.abort();
		second.abort();
		await Promise.all([one, two]);
		await vi.waitFor(() => expect(signals.every((signal) => signal.aborted)).toBe(true));
	});
	it("reports installer errors and allows retry without publishing success", async () => {
		const app = express();
		app.use(express.json());
		const runner = vi.fn().mockRejectedValueOnce(new Error("Port in use")).mockResolvedValue("Ready");
		const setup = installHubSetupRoutes(app, "/isolated", runner);
		cleanup.push(() => setup.close());
		const { post } = await serve(app);
		const failed = await post(input);
		expect(failed.status).toBe(500);
		expect(await failed.json()).toEqual({ error: "Port in use" });
		expect((await post(input)).status).toBe(200);
	});
	it("supports updating existing Hub service via setup/update endpoint", async () => {
		const app = express();
		app.use(express.json());
		const runner = vi.fn().mockResolvedValue("Hub update completed.");
		const setup = installHubSetupRoutes(app, "/isolated", runner);
		cleanup.push(() => setup.close());
		const { base } = await serve(app);
		const res = await fetch(`${base}/api/device-center/setup/update`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ success: true, output: "Hub update completed." });
		expect(runner).toHaveBeenCalledWith(["hub", "update"], expect.any(AbortSignal));
	});
	it("cancels in-flight work on shutdown and rejects subsequent installs", async () => {
		const app = express();
		app.use(express.json());
		const runner = vi.fn(
			(_args: string[], signal: AbortSignal) =>
				new Promise<string>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true });
				}),
		);
		const setup = installHubSetupRoutes(app, "/isolated", runner);
		const { post } = await serve(app);
		const pending = post(input);
		await vi.waitFor(() => expect(runner).toHaveBeenCalledOnce());
		await setup.close();
		expect((await pending).status).toBe(500);
		expect((await post(input)).status).toBe(409);
	});
	it("keeps installation metadata and side effects behind loopback and same-origin gates", async () => {
		const dir = await mkdtemp(join(tmpdir(), "hub-setup-"));
		cleanup.push(() => rm(dir, { recursive: true, force: true }));
		const app = express();
		app.use(express.json());
		const local = await installLocalDeviceCenter({ app, dataDir: dir, connect: () => ({ close() {} }) });
		cleanup.push(() => local.close());
		const { base } = await serve(app);
		expect((await fetch(`${base}/api/device-center/setup`)).status).toBe(200);
		const deniedHost = await new Promise<number | undefined>((resolve, reject) => {
			request(`${base}/api/device-center/setup`, { headers: { Host: "remote.example" } }, (res) => {
				res.resume();
				resolve(res.statusCode);
			})
				.on("error", reject)
				.end();
		});
		expect(deniedHost).toBe(403);
		const rejected = await fetch(`${base}/api/device-center/setup`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
			body: JSON.stringify(input),
		});
		expect(rejected.status).toBe(403);
	});
});
