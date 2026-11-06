import { createServer, type Server } from "node:http";
import { afterEach, expect, it } from "vitest";
import { openBrowserWhenUp } from "../../extensions/webui.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function reservePort(): Promise<number> {
	const probe = createServer();
	await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
	const port = (probe.address() as { port: number }).port;
	await new Promise<void>((resolve) => probe.close(() => resolve()));
	return port;
}

it("opens the browser only after the server answers", async () => {
	const port = await reservePort();
	const server: Server = createServer((_req, res) => {
		res.setHeader("Content-Type", "application/json");
		res.end(JSON.stringify({ ok: true }));
	});
	cleanup.push(
		() =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	);
	const started = Date.now();
	setTimeout(() => server.listen(port, "127.0.0.1"), 600);

	const answers: boolean[] = [];
	await openBrowserWhenUp(`http://localhost:${port}`, port, {
		isAlive: () => true,
		open: async () => {
			const res = await fetch(`http://127.0.0.1:${port}/api/health`);
			answers.push(res.ok);
		},
	});
	expect(answers).toEqual([true]);
	expect(Date.now() - started).toBeGreaterThanOrEqual(500);
});

it("never opens anything when the child process is already gone", async () => {
	let opened = 0;
	const before = Date.now();
	await openBrowserWhenUp("http://localhost:1", 1, {
		isAlive: () => false,
		open: async () => {
			opened++;
		},
	});
	expect(opened).toBe(0);
	expect(Date.now() - before).toBeLessThan(1000);
});
