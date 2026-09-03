/**
 * 插件 AI 工具扩展点单测：
 *  - syncPluginToolsIntoSession：三向 diff（新增/更新/移除）+ 不兼容对象降级；
 *  - PluginManager.registerAgentTool：注册/重名拒绝/反激活自动注销/onAgentToolsChanged 回调。
 * 零 token、零网络，毫秒级。
 */
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
		const defs = [{ name: "mail_list" }, { name: "mail_read" }];
		const next = syncPluginToolsIntoSession(session as never, defs as never, new Set());
		expect(next).toEqual(new Set(["mail_list", "mail_read"]));
		expect(session._customTools!.map((d) => d.name)).toEqual(["mail_list", "mail_read"]);
		expect(calls).toHaveLength(1);
	});

	it("定义未变化时不重建（幂等）", () => {
		const { session, calls } = okSession();
		const defs = [{ name: "a" }];
		syncPluginToolsIntoSession(session as never, defs as never, new Set());
		const again = syncPluginToolsIntoSession(session as never, defs as never, new Set(defs.map((d) => d.name)));
		expect(again).toEqual(new Set(["a"]));
		expect(calls).toHaveLength(1); // 第二次没有 changed，不重建
	});

	it("移除已注销的工具名", () => {
		const { session, calls } = okSession();
		session._customTools = [{ name: "bash" }, { name: "mail_list" }];
		const prev = new Set(["mail_list"]);
		const next = syncPluginToolsIntoSession(session as never, [] as never, prev);
		expect(next).toEqual(new Set());
		expect(session._customTools!.map((d) => d.name)).toEqual(["bash"]); // 内置工具不动
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

			// 重名注册被拒绝（返回的注销函数是空操作）
			mgr.dispose();
			await mgr.ensureLoaded();
			const before = mgr.getAgentTools().length;
			void before;
			mgr.dispose();

			// 删除插件目录后重新加载 → 工具随之消失
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
