import { describe, it } from "node:test";
import assert from "node:assert/strict";
import plugin from "./index.mjs";
import { createMockHost } from "./sdk/testing.mjs";

function htmlResMock() {
	return {
		statusCode: 200,
		body: null,
		headers: {},
		status(c) {
			this.statusCode = c;
			return this;
		},
		json(o) {
			this.body = o;
			return this;
		},
		setHeader(k, v) {
			this.headers[k] = v;
		},
		send(t) {
			this.body = t;
			return this;
		},
	};
}

function resMock() {
	return {
		statusCode: 200,
		body: null,
		status(c) {
			this.statusCode = c;
			return this;
		},
		json(o) {
			this.body = o;
			return this;
		},
	};
}

describe("web-capture", () => {
	it("beacon pick → state tool reads the pick", async () => {
		const host = createMockHost();
		const cleanup = await plugin.activate(host);
		const route = host.mock.routes.find((r) => r.method === "GET" && r.path === "/collect");
		assert.ok(route, "GET /collect beacon registered");
		const res = resMock();
		await route.handler({ query: { d: encodeURIComponent(JSON.stringify({ type: "pick", tag: "button", text: "Login", sel: "#login", url: "https://example.com" })) } }, res);
		assert.equal(res.body.ok, true);
		const tool = host.mock.agentTools.find((t) => t.name === "web_capture_state");
		assert.ok(tool, "web_capture_state registered");
		const out = await tool.execute("t", {}, null);
		assert.match(out.content[0].text, /#login/);
		await cleanup();
	});

	it("log tool filters by kind + clear works", async () => {
		const host = createMockHost();
		const cleanup = await plugin.activate(host);
		const post = host.mock.routes.find((r) => r.method === "POST" && r.path === "/collect");
		await post.handler({ body: { type: "event", ev: "click", text: "submit", sel: "#ok", url: "https://x.test" } }, resMock());
		const logTool = host.mock.agentTools.find((t) => t.name === "web_capture_log");
		const out = await logTool.execute("t", { kind: "click", limit: 10 }, null);
		assert.match(out.content[0].text, /submit/);
		const empty = await logTool.execute("t", { kind: "pick" }, null);
		assert.match(empty.content[0].text, /no matching log/);
		host.mock.emit("onMessage", { action: "clear" }, "c1");
		const after = await logTool.execute("t", {}, null);
		assert.match(after.content[0].text, /no matching log/);
		await cleanup();
	});

	it("single step report + steps tool + settings route", async () => {
		const host = createMockHost({ settings: { maxSteps: 50 } });
		const cleanup = await plugin.activate(host);
		host.mock.emit("onMessage", { action: "step", step: { kind: "visit", label: "visit: https://a.test", url: "https://a.test" } }, "c1");
		host.mock.emit("onMessage", { action: "step", step: { kind: "click", label: "click: Go", sel: "#go", url: "https://a.test" } }, "c1");
		const stepsTool = host.mock.agentTools.find((t) => t.name === "web_capture_steps");
		const out = await stepsTool.execute("t", {}, null);
		assert.match(out.content[0].text, /1\. \[visit\]/);
		assert.match(out.content[0].text, /#go/);
		const settingsRoute = host.mock.routes.find((r) => r.method === "GET" && r.path === "/settings");
		const res = resMock();
		await settingsRoute.handler({}, res);
		assert.equal(res.body.settings.maxSteps, 50);
		await cleanup();
	});

	it("report tool writes file + note/clear tools", async () => {
		const written = {};
		const host = createMockHost({ fs: { mkdir: async () => {}, write: async (p, data) => { written[p] = String(data); } } });
		const cleanup = await plugin.activate(host);
		host.mock.emit("onMessage", { action: "step", step: { kind: "visit", label: "visit: https://a.test", url: "https://a.test" } }, "c1");
		const noteTool = host.mock.agentTools.find((t) => t.name === "web_capture_note");
		await noteTool.execute("t", { text: "login ok" }, null);
		const reportTool = host.mock.agentTools.find((t) => t.name === "web_capture_report");
		const out = await reportTool.execute("t", { task: "button does nothing" }, null);
		const keys = Object.keys(written);
		assert.equal(keys.length, 1);
		assert.match(keys[0], /^web-capture\/report-.*\.md$/);
		assert.match(written[keys[0]], /button does nothing/);
		assert.match(out.content[0].text, /saved: web-capture\/report-/);
		const clearTool = host.mock.agentTools.find((t) => t.name === "web_capture_clear");
		await clearTool.execute("t", {}, null);
		const stepsTool = host.mock.agentTools.find((t) => t.name === "web_capture_steps");
		const after = await stepsTool.execute("t", {}, null);
		assert.match(after.content[0].text, /no steps recorded/);
		await cleanup();
	});

	it("drops consecutive duplicate steps; empty labels fall back", async () => {
		const host = createMockHost();
		const cleanup = await plugin.activate(host);
		host.mock.emit("onMessage", { action: "step", step: { kind: "visit", label: "https://a.test", url: "https://a.test" } }, "c1");
		host.mock.emit("onMessage", { action: "step", step: { kind: "visit", label: "https://a.test", url: "https://a.test" } }, "c1");
		host.mock.emit("onMessage", { action: "step", step: { kind: "click", label: "", sel: "#go", url: "https://a.test" } }, "c1");
		const stepsTool = host.mock.agentTools.find((t) => t.name === "web_capture_steps");
		const out = await stepsTool.execute("t", {}, null);
		const lines = out.content[0].text.split("\n").filter((l) => /^\d+\. /.test(l));
		assert.equal(lines.length, 2);
		assert.match(lines[0], /1\. \[visit\] https:\/\/a\.test/);
		assert.match(lines[1], /2\. \[click\]/);
		await cleanup();
	});

	it("proxy injects base+recorder, strips CSP; rejects bad/non-html", async () => {
		const realFetch = globalThis.fetch;
		const enc = (t) => new TextEncoder().encode(t).buffer;
		globalThis.fetch = async () => ({
			headers: { get: (h) => (String(h).toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null) },
			arrayBuffer: async () =>
				enc('<html><head><meta http-equiv="Content-Security-Policy" content="x"><title>T</title></head><body><a href="/x">go</a></body></html>'),
		});
		try {
			const host = createMockHost();
			const cleanup = await plugin.activate(host);
			const route = host.mock.routes.find((r) => r.method === "GET" && r.path === "/proxy");
			assert.ok(route, "GET /proxy registered");
			const res = htmlResMock();
			await route.handler({ query: { url: "https://example.com/a/b", ep: "https://h/plugins-api/web-capture", msk: "1" } }, res);
			assert.equal(res.statusCode, 200);
			assert.match(res.headers["Content-Type"] ?? "", /text\/html/);
			assert.match(res.body, /<base href="https:\/\/example\.com\/a\/">/);
			assert.doesNotMatch(res.body, /content-security-policy/i);
			assert.match(res.body, /__WI_LOGGED/);
			assert.match(res.body, /https:\/\/h\/plugins-api\/web-capture/);
			assert.match(res.body, /window\.__WI_PATH="\/a\/b"/);
			const bad = htmlResMock();
			await route.handler({ query: { url: "ftp://x/y" } }, bad);
			assert.equal(bad.statusCode, 400);
			assert.match(bad.body, /Bad URL/);
			globalThis.fetch = async () => ({
				headers: { get: () => "application/pdf" },
				arrayBuffer: async () => new Uint8Array(10).buffer,
			});
			const pdf = htmlResMock();
			await route.handler({ query: { url: "https://example.com/f.pdf" } }, pdf);
			assert.equal(pdf.statusCode, 415);
			assert.match(pdf.body, /Not an HTML page/);
			await cleanup();
		} finally {
			globalThis.fetch = realFetch;
		}
	});
});
