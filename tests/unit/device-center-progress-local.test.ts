import { afterEach, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installLocalDeviceCenter } from "../../server/device-center/local.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function listen(server: Server) {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanup.push(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
it("authenticates the local SSE upstream privately and aborts it on client disconnect", async () => {
	const dir = await mkdtemp(join(tmpdir(), "group-progress-local-"));
	cleanup.push(() => rm(dir, { recursive: true, force: true }));
	const remote = express();
	const headers = vi.fn();
	const disconnected = vi.fn();
	remote.get("/api/device-user/rooms/room/events", (req, res) => {
		headers(req.headers);
		res.set("Content-Type", "text/event-stream");
		res.write('event: progress\ndata: {"phase":"tool","toolName":"read"}\n\n');
		res.once("close", disconnected);
	});
	const hubUrl = await listen(createServer(remote));
	await writeFile(
		join(dir, "device-center.json"),
		JSON.stringify({
			hubUrl,
			deviceId: "device",
			name: "local",
			credential: "device-secret",
			uiCredential: "ui-secret",
			allowExecution: false,
		}),
	);
	const app = express();
	app.use(express.json());
	const local = await installLocalDeviceCenter({
		app,
		dataDir: dir,
		connect: () => ({ close() {}, isConnected: () => true }),
	});
	cleanup.push(() => local.close());
	const base = await listen(createServer(app));
	const controller = new AbortController();
	const response = await fetch(`${base}/api/device-center/rooms/room/events`, { signal: controller.signal });
	expect(response.headers.get("content-type")).toContain("text/event-stream");
	const reader = response.body!.getReader();
	const first = await reader.read();
	const text = new TextDecoder().decode(first.value);
	expect(text).toContain('"toolName":"read"');
	expect(text).not.toContain("secret");
	expect(headers.mock.calls[0][0].authorization).toBe("Bearer ui-secret");
	expect(headers.mock.calls[0][0]["x-device-id"]).toBe("device");
	controller.abort();
	await reader.cancel().catch(() => {});
	await vi.waitFor(() => expect(disconnected).toHaveBeenCalled(), { timeout: 2000 });
});
