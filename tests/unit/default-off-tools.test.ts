import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CANVAS_TOOL_NAME,
	DELEGATE_TASK_TOOL_NAME,
	MCP_MANAGE_TOOL_NAME,
	PATCH_TOOL_NAME,
	SANDBOX_TOOL_NAME,
	WORKTREE_TOOL_NAME,
	defaultDisabledAgentTools,
	getAgentToolEntry,
} from "../../server/tool-manager.js";
import { ClientStateStore, DEFAULT_CLIENT_SETTINGS, DEFAULT_DISABLED_MARKERS } from "../../server/client-state.js";

/** 出厂默认关闭 = 目录 defaultOn:false 与出厂设置 disabledAgentTools 同名，两处任一处漏写都会红。 */
const DEFAULT_OFF_TOOLS = [
	SANDBOX_TOOL_NAME,
	WORKTREE_TOOL_NAME,
	CANVAS_TOOL_NAME,
	MCP_MANAGE_TOOL_NAME,
	PATCH_TOOL_NAME,
	DELEGATE_TASK_TOOL_NAME,
	"ls",
] as const;

describe("出厂默认关闭的工具", () => {
	it("目录 defaultOn:false", () => {
		for (const name of DEFAULT_OFF_TOOLS) {
			expect(getAgentToolEntry(name)?.defaultOn, name).toBe(false);
			expect(defaultDisabledAgentTools(), name).toContain(name);
		}
	});

	it("出厂设置 disabledAgentTools 同名单", () => {
		const off = new Set(DEFAULT_CLIENT_SETTINGS.disabledAgentTools);
		for (const name of DEFAULT_OFF_TOOLS) expect(off.has(name), name).toBe(true);
	});

	it("重名的重量级工具不会被顺带打开", () => {
		const off = new Set(DEFAULT_CLIENT_SETTINGS.disabledAgentTools);
		const onDemand = new Set(DEFAULT_CLIENT_SETTINGS.toolOnDemandTools);
		// terminal 不在禁用名单，但在按需名单里（= 不常驻，先 load_tools 才下发 schema）
		expect(off.has("terminal")).toBe(false);
		expect(onDemand.has("terminal")).toBe(true);
		expect(off.has("powershell")).toBe(true);
		expect(off.has("bash")).toBe(false);
		expect(off.has("read")).toBe(false);
	});

	it("出厂按需名单 = 7 个，且与禁用名单不重叠", () => {
		expect([...DEFAULT_CLIENT_SETTINGS.toolOnDemandTools].sort()).toEqual(
			[
				"agent_bot",
				"browser_design",
				"browser_page",
				"browser_script",
				"compact_context",
				"schedule",
				"terminal",
			].sort(),
		);
		const off = new Set(DEFAULT_CLIENT_SETTINGS.disabledAgentTools);
		for (const name of DEFAULT_CLIENT_SETTINGS.toolOnDemandTools) expect(off.has(name), name).toBe(false);
	});

	it("延迟加载总闸出厂默认开", () => {
		expect(DEFAULT_CLIENT_SETTINGS.toolLazyLoading).toBe(true);
	});
});

describe("全新用户的生效默认（getSettings 而非常量表）", () => {
	let dir: string;
	let store: ClientStateStore;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-default-settings-test-"));
		store = new ClientStateStore(join(dir, "client-state.json"));
	});

	afterEach(() => {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {}
	});

	it("按需名单 / 懒加载 / 审批 / 看门狗 / 默认权限都按新出厂值生效", () => {
		const s = store.getSettings("fresh-client");
		// normalizeToolOnDemandList(undefined) 会吞掉出厂名单，所以这行盯的就是那条回落
		expect(s.toolOnDemandTools).toEqual([
			"terminal",
			"browser_page",
			"browser_script",
			"browser_design",
			"agent_bot",
			"schedule",
			"compact_context",
		]);
		expect(s.toolLazyLoading).toBe(true);
		expect(s.toolApprovalEnabled).toBe(true);
		expect(s.toolWatchdogTimeoutMs).toBe(20 * 60_000);
		expect(s.readDirEnabled).toBe(true);
		expect(s.terminalBash).toBe(false);
		expect(s.defaultPermissionPreset).toBe("workspace-write-never");
		expect(s.disabledAgentTools).toEqual([
			"powershell",
			"ls",
			"delegate_task",
			"phone",
			"patch",
			"lsp",
			"eval",
			"tool_search",
			"mcp_manage",
			"sandbox",
			"worktree",
			"canvas",
		]);
	});
});

describe("出厂默认关闭的标记", () => {
	let dir: string;
	let store: ClientStateStore;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-default-markers-test-"));
		store = new ClientStateStore(join(dir, "client-state.json"));
	});

	afterEach(() => {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {}
	});

	it("DEFAULT_DISABLED_MARKERS 含 notify", () => {
		expect(DEFAULT_DISABLED_MARKERS).toContain("notify");
	});

	it("新客户端 getMarkerSettings 回落默认值", () => {
		const s = store.getMarkerSettings("fresh-client");
		expect(s.disabledMarkers).toEqual([...DEFAULT_DISABLED_MARKERS]);
	});

	it("保存其它字段时不会把 notify 复活", () => {
		store.saveMarkerSettings("c1", {});
		expect(store.getMarkerSettings("c1").disabledMarkers).toEqual([...DEFAULT_DISABLED_MARKERS]);
	});

	it("显式开启 notify 能落盘", () => {
		store.saveMarkerSettings("c1", { disabledMarkers: [] });
		expect(store.getMarkerSettings("c1").disabledMarkers).toEqual([]);
	});

	it("旧版全局开关能从落盘数据读出（供迁移）", () => {
		const file = join(dir, "legacy-state.json");
		writeFileSync(
			file,
			JSON.stringify({ __settings__: { projects: [], markers: { markersEnabled: false, disabledMarkers: [] } } }),
		);
		const legacy = new ClientStateStore(file);
		expect(legacy.getLegacyMarkersGlobalOff()).toBe(true);
		legacy.saveMarkerSettings("c1", { disabledMarkers: ["notify", "conv", "action"] });
		expect(legacy.getLegacyMarkersGlobalOff()).toBeUndefined();
	});
});
