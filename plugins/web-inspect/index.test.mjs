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
	it("beacon pick → state 工具读到点选", async () => {
		const host = createMockHost();
		const cleanup = await plugin.activate(host);
		const route = host.mock.routes.find((r) => r.method === "GET" && r.path === "/collect");
		assert.ok(route, "注册了 GET /collect 信标");
		const res = resMock();
		await route.handler({ query: { d: encodeURIComponent(JSON.stringify({ type: "pick", tag: "button", text: "Login", sel: "#login", url: "https://example.com" })) } }, res);
		assert.equal(res.body.ok, true);
		const tool = host.mock.agentTools.find((t) => t.name === "web_inspect_state");
		assert.ok(tool, "注册了 web_inspect_state");
		const out = await tool.execute("t", {}, null);
		assert.match(out.content[0].text, /#login/);
		await cleanup();
	});

	it("log 工具按 kind 过滤 + clear 生效", async () => {
		const host = createMockHost();
		const cleanup = await plugin.activate(host);
		const post = host.mock.routes.find((r) => r.method === "POST" && r.path === "/collect");
		await post.handler({ body: { type: "event", ev: "click", text: "提交", sel: "#ok", url: "https://x.test" } }, resMock());
		const logTool = host.mock.agentTools.find((t) => t.name === "web_inspect_log");
		const out = await logTool.execute("t", { kind: "click", limit: 10 }, null);
		assert.match(out.content[0].text, /提交/);
		const empty = await logTool.execute("t", { kind: "pick" }, null);
		assert.match(empty.content[0].text, /暂无/);
		host.mock.emit("onMessage", { action: "clear" }, "c1");
		const after = await logTool.execute("t", {}, null);
		assert.match(after.content[0].text, /暂无/);
		await cleanup();
	});
});
