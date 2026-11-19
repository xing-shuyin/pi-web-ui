import { describe, it } from "node:test";
import assert from "node:assert/strict";
import plugin from "./index.mjs";
import { createMockHost } from "./sdk/testing.mjs";

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

describe("web-inspect", () => {
	it("beacon pick → state tool reads the pick", async () => {
		const host = createMockHost();
		const cleanup = await plugin.activate(host);
		const route = host.mock.routes.find((r) => r.method === "GET" && r.path === "/collect");
		assert.ok(route, "GET /collect beacon registered");
		const res = resMock();
		await route.handler({ query: { d: encodeURIComponent(JSON.stringify({ type: "pick", tag: "button", text: "Login", sel: "#login", url: "https://example.com" })) } }, res);
		assert.equal(res.body.ok, true);
		const tool = host.mock.agentTools.find((t) => t.name === "web_inspect_state");
		assert.ok(tool, "web_inspect_state registered");
		const out = await tool.execute("t", {}, null);
		assert.match(out.content[0].text, /#login/);
		await cleanup();
	});

	it("log tool filters by kind + clear works", async () => {
		const host = createMockHost();
		const cleanup = await plugin.activate(host);
		const post = host.mock.routes.find((r) => r.method === "POST" && r.path === "/collect");
		await post.handler({ body: { type: "event", ev: "click", text: "submit", sel: "#ok", url: "https://x.test" } }, resMock());
		const logTool = host.mock.agentTools.find((t) => t.name === "web_inspect_log");
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
		const stepsTool = host.mock.agentTools.find((t) => t.name === "web_inspect_steps");
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
		const noteTool = host.mock.agentTools.find((t) => t.name === "web_inspect_note");
		await noteTool.execute("t", { text: "login ok" }, null);
		const reportTool = host.mock.agentTools.find((t) => t.name === "web_inspect_report");
		const out = await reportTool.execute("t", { task: "button does nothing" }, null);
		const keys = Object.keys(written);
		assert.equal(keys.length, 1);
		assert.match(keys[0], /^web-inspect\/report-.*\.md$/);
		assert.match(written[keys[0]], /button does nothing/);
		assert.match(out.content[0].text, /saved: web-inspect\/report-/);
		const clearTool = host.mock.agentTools.find((t) => t.name === "web_inspect_clear");
		await clearTool.execute("t", {}, null);
		const stepsTool = host.mock.agentTools.find((t) => t.name === "web_inspect_steps");
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
		const stepsTool = host.mock.agentTools.find((t) => t.name === "web_inspect_steps");
		const out = await stepsTool.execute("t", {}, null);
		const lines = out.content[0].text.split("\n").filter((l) => /^\d+\. /.test(l));
		assert.equal(lines.length, 2);
		assert.match(lines[0], /1\. \[visit\] https:\/\/a\.test/);
		assert.match(lines[1], /2\. \[click\]/);
		await cleanup();
	});
});
