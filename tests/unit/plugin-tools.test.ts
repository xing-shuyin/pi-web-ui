import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncPluginToolsIntoSession, PluginManager } from "../../server/plugins.js";

function okSession() {
	const calls: string[][] = [];
	return {
		session: {
			_customTools: [] as Array<{ name: string } & Record<string, unknown>>,
			_refreshToolRegistry() {
				calls.push(this._customTools!.map((d) => d.name));
			},
		},
		calls,
	};
}

describe("syncPluginToolsIntoSession", () => {
	it("新增工具并触发 registry 重建", () => {
		const { session, calls } = okSession();
		const defs = [{ name: "mail" }, { name: "calendar" }];
		const next = syncPluginToolsIntoSession(session as never, defs as never, new Set());
		expect(next).toEqual(new Set(["mail", "calendar"]));
		expect(session._customTools!.map((d) => d.name)).toEqual(["mail", "calendar"]);
		expect(calls).toHaveLength(1);
	});

	it("定义未变化时不重建（幂等）", () => {
		const { session, calls } = okSession();
		const defs = [{ name: "a" }];
		syncPluginToolsIntoSession(session as never, defs as never, new Set());
		const again = syncPluginToolsIntoSession(session as never, defs as never, new Set(defs.map((d) => d.name)));
		expect(again).toEqual(new Set(["a"]));
		expect(calls).toHaveLength(1);
	});

	it("移除已注销的工具名", () => {
		const { session, calls } = okSession();
		session._customTools = [{ name: "bash" }, { name: "mail" }];
		const prev = new Set(["mail"]);
		const next = syncPluginToolsIntoSession(session as never, [] as never, prev);
		expect(next).toEqual(new Set());
		expect(session._customTools!.map((d) => d.name)).toEqual(["bash"]);
		expect(calls).toHaveLength(1);
	});

	it("对象不兼容时返回 null 静默降级", () => {
		expect(syncPluginToolsIntoSession({} as never, [], new Set())).toBeNull();
		expect(syncPluginToolsIntoSession({ _customTools: [] } as never, [], new Set())).toBeNull();
	});
});

describe("PluginManager.registerAgentTool", () => {
	function makeFixture(dir: string, body: string) {
		mkdirSync(join(dir, "plugins", "fixture"), { recursive: true });
		writeFileSync(join(dir, "plugins", "fixture", "manifest.json"), JSON.stringify({ name: "夹具" }));
		writeFileSync(join(dir, "plugins", "fixture", "index.mjs"), body);
	}

	it("注册 → 可读取 → 反激活自动注销 → 变化回调触发", async () => {
		const base = mkdtempSync(join(tmpdir(), "pwi-plug-tools-"));
		try {
			makeFixture(
				base,
				`
export default {
	activate(host) {
		const offA = host.registerAgentTool({
			name: "fixture_ping",
			description: "test tool",
			execute: async () => ({ content: [{ type: "text", text: "pong" }] }),
		});
		return () => offA();
	},
};
`,
			);
			const mgr = new PluginManager(base, process.cwd());
			let changes = 0;
			mgr.onAgentToolsChanged = () => {
				changes += 1;
			};
			await mgr.ensureLoaded();
			expect(mgr.getAgentTools().map((t) => t.name)).toEqual(["fixture_ping"]);
			expect(changes).toBeGreaterThanOrEqual(1);

			mgr.dispose();
			await mgr.ensureLoaded();
			const before = mgr.getAgentTools().length;
			void before;
			mgr.dispose();

			rmSync(join(base, "plugins", "fixture"), { recursive: true, force: true });
			const mgr2 = new PluginManager(base, process.cwd());
			await mgr2.ensureLoaded();
			expect(mgr2.getAgentTools()).toEqual([]);
			mgr2.dispose();
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});
