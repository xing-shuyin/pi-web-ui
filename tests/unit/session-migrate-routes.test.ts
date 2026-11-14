import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockHost } from "../../plugin-sdk/testing.mjs";

type Captured = { method: string; path: string; handler: (req: any, res: any) => unknown };

let agentDir = "";
let sessionsDir = "";

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "sm-agent-"));
	sessionsDir = join(agentDir, "sessions");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	vi.resetModules();
});

afterEach(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	rmSync(agentDir, { recursive: true, force: true });
});

async function activateWithRoutes() {
	const { default: plugin } = await import("../../plugins/session-migrate/index.mjs");
	const host = createMockHost({});
	plugin.activate(host);
	const routes = host.mock.routes as Captured[];
	const pick = (method: string, path: string) => {
		const hit = routes.find((r) => r.method === method && r.path === path);
		if (!hit) throw new Error(`route not found: ${method} ${path}`);
		return hit.handler;
	};
	return { host, pick };
}

function fakeRes() {
	const res: any = {
		code: 200,
		body: undefined,
		headers: {} as Record<string, string>,
		status(code: number) {
			res.code = code;
			return res;
		},
		json(body: unknown) {
			res.body = body;
			return res;
		},
		setHeader(k: string, v: string) {
			res.headers[k.toLowerCase()] = v;
		},
		end(body?: unknown) {
			res.body = body;
		},
	};
	return res;
}

const sessionText = (id: string, cwd: string) =>
	[
		JSON.stringify({ type: "session", version: 3, id, cwd }),
		JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: [{ type: "text", text: "hi" }] } }),
	].join("\n") + "\n";

describe("session-migrate 路由（#887）", () => {
	it("/export 只认会话库内的 jsonl", async () => {
		const { pick } = await activateWithRoutes();
		const handler = pick("GET", "/export");

		const dir = join(sessionsDir, "--proj--");
		mkdirSync(dir, { recursive: true });
		const file = join(dir, "2024_s1.jsonl");
		writeFileSync(file, sessionText("s1", "/proj"), "utf8");

		const ok = fakeRes();
		await handler({ query: { file } }, ok);
		expect(ok.code).toBe(200);
		expect(ok.headers["content-disposition"]).toContain("2024_s1.jsonl");
		expect(String(ok.body)).toContain('"id":"s1"');

		const outside = join(agentDir, "secret.jsonl");
		writeFileSync(outside, "{}", "utf8");
		const denied = fakeRes();
		await handler({ query: { file: outside } }, denied);
		expect(denied.code).toBe(400);
		expect(denied.body.ok).toBe(false);
	});

	it("/import-file JSON 投递：坏文件 400 / 首次 200 / 重名 409 / 覆盖 200", async () => {
		const { pick } = await activateWithRoutes();
		const handler = pick("POST", "/import-file");

		const bad = fakeRes();
		await handler({ body: { text: "nope" } }, bad);
		expect(bad.code).toBe(400);

		const text = sessionText("route-1", "/proj");
		const first = fakeRes();
		await handler({ body: { text } }, first);
		expect(first.code).toBe(200);
		expect(first.body.ok).toBe(true);

		const dup = fakeRes();
		await handler({ body: { text } }, dup);
		expect(dup.code).toBe(409);
		expect(dup.body.duplicate).toBe(true);

		const overwritten = fakeRes();
		await handler({ body: { text, mode: "overwrite" } }, overwritten);
		expect(overwritten.code).toBe(200);
		expect(overwritten.body.mode).toBe("overwrite");
		expect(readdirSync(join(sessionsDir, "--proj--")).length).toBe(1);
	});

	it("/import-file 支持 octet-stream 流式投递（绕开 express.json 的 10MB 限制）", async () => {
		const { pick } = await activateWithRoutes();
		const handler = pick("POST", "/import-file");
		const stream = Readable.from([Buffer.from(sessionText("route-2", "/proj"))]);
		const res = fakeRes();
		await handler({ headers: {}, on: stream.on.bind(stream) }, res);
		expect(res.code).toBe(200);
		expect(res.body.ok).toBe(true);
		expect(res.body.sessionId).toBe("route-2");
	});
});
