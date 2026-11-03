import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClientStateStore } from "../../server/client-state.js";

/** saveSettings 的 null 清除语义：visionBridgeModel / subagentDefaultModel 以
 *  null 为合法值（"清除，跟随主对话"）。合并必须按键存在性而不是 `??`——
 *  `null ?? cur` 会把旧值写回磁盘，设置面板清空后重启又复活。 */
describe("ClientStateStore.saveSettings null 清除语义", () => {
	let dir: string;
	let file: string;
	let store: ClientStateStore;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-client-state-null-test-"));
		file = join(dir, "client-state.json");
		store = new ClientStateStore(file);
	});

	afterEach(() => {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	it("传 null 能清除 visionBridgeModel / subagentDefaultModel", () => {
		store.saveSettings("c1", { visionBridgeModel: "provider/old", subagentDefaultModel: "provider/other" });
		expect(store.getSettings("c1").visionBridgeModel).toBe("provider/old");
		expect(store.getSettings("c1").subagentDefaultModel).toBe("provider/other");

		store.saveSettings("c1", { visionBridgeModel: null, subagentDefaultModel: null });
		expect(store.getSettings("c1").visionBridgeModel).toBeNull();
		expect(store.getSettings("c1").subagentDefaultModel).toBeNull();
	});

	it("不传该 key 时保持旧值（partial 合并不受影响）", () => {
		store.saveSettings("c1", { visionBridgeModel: "provider/keep-me" });
		store.saveSettings("c1", { promptMode: "replace" });
		expect(store.getSettings("c1").visionBridgeModel).toBe("provider/keep-me");
		expect(store.getSettings("c1").promptMode).toBe("replace");
	});

	it("null 清除结果落盘：新实例（模拟重启）后仍是 null，不复活旧值", () => {
		store.saveSettings("c1", { visionBridgeModel: "provider/old" });
		store.saveSettings("c1", { visionBridgeModel: null });

		const reopened = new ClientStateStore(file);
		expect(reopened.getSettings("c1").visionBridgeModel).toBeNull();
	});

	it("promptDisabled 默认包含 plugin_dev，存量老存档升级默认不开启，显式开启后落盘持久化", () => {
		// 1. 全新客户端：默认包含 plugin_dev
		expect(store.getSettings("c_new").promptDisabled).toContain("plugin_dev");

		// 2. 模拟存量老存档（磁盘上存了 promptDisabled: [] 但无 _promptPluginDevConfigured）
		store.saveSettings("c_legacy", { promptMode: "append" });
		// 模拟老数据写入
		const raw = JSON.parse(readFileSync(file, "utf-8"));
		raw.__settings__.settings.promptDisabled = [];
		delete raw.__settings__.settings._promptPluginDevConfigured;
		// 写入文件并重新打开
		writeFileSync(file, JSON.stringify(raw), "utf-8");
		const legacyStore = new ClientStateStore(file);
		expect(legacyStore.getSettings("c_legacy").promptDisabled).toContain("plugin_dev");

		// 3. 用户显式开启 plugin_dev（将 promptDisabled 设为 [] 并保存）
		legacyStore.saveSettings("c_legacy", { promptDisabled: [] });
		expect(legacyStore.getSettings("c_legacy").promptDisabled).toEqual([]);
		// 重新打开验证持久化保留
		const reloadedStore = new ClientStateStore(file);
		expect(reloadedStore.getSettings("c_legacy").promptDisabled).toEqual([]);
	});
});
