import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerGlobalPromptRoutes } from "../../server/global-prompt-files.js";

let root: string;
let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
let baseUrl = "";

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "pi-global-prompt-routes-"));
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const dataDir = join(root, "data");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(dataDir, { recursive: true });
	writeFileSync(join(agentDir, "SYSTEM.md"), "before", "utf8");
	const app = express();
	app.use(express.json());
	registerGlobalPromptRoutes(app, { homeDir, agentDir, dataDir });
	server = app.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server!.once("listening", resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
	if (!server) return;
	await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
	server = undefined;
});

describe("global prompt HTTP routes", () => {
	it("lists, updates, rejects stale writes, and blocks cross-site writes", async () => {
		const listed = await fetch(`${baseUrl}/api/global-prompts`).then((response) => response.json());
		const file = listed.files.find((item: { id: string }) => item.id === "pi:system");
		expect(file.content).toBe("before");

		const saved = await fetch(`${baseUrl}/api/global-prompts`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id: file.id, content: "after", expectedRevision: file.revision }),
		});
		expect(saved.status).toBe(200);
		expect(readFileSync(join(root, "agent", "SYSTEM.md"), "utf8")).toBe("after");

		const stale = await fetch(`${baseUrl}/api/global-prompts`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id: file.id, content: "stale", expectedRevision: file.revision }),
		});
		expect(stale.status).toBe(409);

		const crossSite = await fetch(`${baseUrl}/api/global-prompts`, {
			method: "PUT",
			headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" },
			body: JSON.stringify({ id: file.id, content: "blocked", expectedRevision: file.revision }),
		});
		expect(crossSite.status).toBe(403);
		expect(readFileSync(join(root, "agent", "SYSTEM.md"), "utf8")).toBe("after");
	});

	it("registers and removes custom files without deleting them", async () => {
		const customPath = join(root, "custom.md");
		writeFileSync(customPath, "custom", "utf8");
		const added = await fetch(`${baseUrl}/api/global-prompts/custom`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: customPath, label: "Custom agent" }),
		});
		expect(added.status).toBe(200);
		const catalog = await added.json();
		const file = catalog.files.find((item: { custom: boolean }) => item.custom);
		expect(file).toMatchObject({ label: "Custom agent", content: "custom" });

		const removed = await fetch(`${baseUrl}/api/global-prompts/custom/${encodeURIComponent(file.id)}`, {
			method: "DELETE",
		});
		expect(removed.status).toBe(200);
		expect(readFileSync(customPath, "utf8")).toBe("custom");
	});
});
