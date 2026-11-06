import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClientStateStore } from "../../server/client-state.js";

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
		} catch {}
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
		expect(store.getSettings("c_new").promptDisabled).toContain("plugin_dev");

		store.saveSettings("c_legacy", { promptMode: "append" });
		const raw = JSON.parse(readFileSync(file, "utf-8"));
		raw.__settings__.settings.promptDisabled = [];
		delete raw.__settings__.settings._promptPluginDevConfigured;
		writeFileSync(file, JSON.stringify(raw), "utf-8");
		const legacyStore = new ClientStateStore(file);
		expect(legacyStore.getSettings("c_legacy").promptDisabled).toContain("plugin_dev");

		legacyStore.saveSettings("c_legacy", { promptDisabled: [] });
		expect(legacyStore.getSettings("c_legacy").promptDisabled).toEqual([]);
		const reloadedStore = new ClientStateStore(file);
		expect(reloadedStore.getSettings("c_legacy").promptDisabled).toEqual([]);
	});
});
