import { mkdtempSync, rmSync } from "node:fs";
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
		expect(off.has("terminal")).toBe(true);
		expect(off.has("powershell")).toBe(true);
		expect(off.has("bash")).toBe(false);
		expect(off.has("read")).toBe(false);
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
		expect(s.markersEnabled).toBe(true);
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
});
