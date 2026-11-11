import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import plugin from "../index.mjs";

function mockHost(dir) {
	const tools = new Map();
	const routes = new Map();
	return {
		tools,
		routes,
		host: {
			dataDir: dir,
			cwd: dir,
			log() {},
			broadcast() {},
			notify() {},
			getSettings() {
				return {};
			},
			route(method, path, handler) {
				routes.set(`${method} ${path}`, handler);
				return () => routes.delete(`${method} ${path}`);
			},
			registerAgentTool(spec) {
				tools.set(spec.name, spec);
				return () => tools.delete(spec.name);
			},
			onClientMessage() {
				return () => {};
			},
			llm: { complete: async () => ({ ok: false }), supportsImages: false },
		},
	};
}

test("插件激活：智能层就绪、新工具与路由注册、可干净卸载", async () => {
	const dir = mkdtempSync(join(tmpdir(), "bili-activate-"));
	const { host, tools, routes } = mockHost(dir);
	const dispose = await plugin.activate(host);
	try {
		for (const name of ["bili_ask", "bili_deepen", "bili_taste", "bili_index", "bili_delivery"]) {
			assert.ok(tools.has(name), `缺少工具 ${name}`);
			const spec = tools.get(name);
			assert.ok(spec.description && spec.parameters && typeof spec.execute === "function", `${name} 规格不完整`);
		}
		for (const name of ["bili_search", "bili_duty_run", "bili_video_content", "bili_dm_sessions"]) {
			assert.ok(tools.has(name), `旧工具应保留：${name}`);
		}
		assert.ok(routes.has("GET /intel"), "应有 GET /intel");
		assert.ok(routes.has("POST /intel/ask"), "应有 POST /intel/ask");
		assert.ok(routes.has("POST /intel/signal"), "应有 POST /intel/signal");

		// 未登录/无网络时，工具应返回结构化错误而不是抛异常
		const r = await tools.get("bili_taste").execute({ action: "list" }, "id", undefined);
		assert.equal(r.ok, true);
		assert.ok(r.summary);
		const idx = await tools.get("bili_index").execute({ action: "search", query: "不存在的词" }, "id", undefined);
		assert.equal(idx.ok, true);
	} finally {
		dispose();
		rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	}
});
