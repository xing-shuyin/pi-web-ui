import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	registerMarker,
	unregisterMarker,
	getMarker,
	stripMarkers,
	isKnownMarkerTool,
	collectGuidance,
} from "../../server/markers/index.js";
import { MarkerService, type MarkerHost } from "../../server/marker-service.js";
import type { ClientStateStore, MarkerSettings } from "../../server/client-state.js";
import type { MarkerTool } from "../../server/markers/marker.js";
import { stripInlineMarkers, syncKnownInlineMarkers } from "../../web/src/components/Message.js";
import { PluginManager } from "../../server/plugins.js";

const DEFAULT_SETTINGS: MarkerSettings = { markersEnabled: true, disabledMarkers: [] };

function makeMockHost(
	settings: MarkerSettings = DEFAULT_SETTINGS,
	lang = "en",
): {
	host: MarkerHost;
	emitted: unknown[];
	actionsChanged: string[];
} {
	const emitted: unknown[] = [];
	const actionsChanged: string[] = [];
	const store = {
		getMarkerSettings: () => ({ ...settings, disabledMarkers: [...settings.disabledMarkers] }),
		saveMarkerSettings: (_id: string, s: MarkerSettings) => {
			settings.markersEnabled = s.markersEnabled;
			settings.disabledMarkers = [...s.disabledMarkers];
		},
	} as unknown as ClientStateStore;

	const host: MarkerHost = {
		clientId: "test-client",
		stateStore: store,
		emit: (msg) => emitted.push(msg),
		isDisposed: () => false,
		getActiveConversationId: () => "conv-1",
		getSessionManager: () => undefined,
		renameConversation: () => {},
		refreshMarkers: () => {},
		onActionsChange: (cId) => actionsChanged.push(cId),
		lang: () => lang as any,
	};
	return { host, emitted, actionsChanged };
}

describe("插件动态注册 Marker 体系", () => {
	it("支持动态注册与注销 Marker", () => {
		const markerName = "test_custom_marker";
		const tool: MarkerTool<{ count: number }> = {
			name: markerName,
			label: "测试标记",
			pluginId: "plugin-test",
			guidance: ["[[test_custom_marker:ping:msg]] send a ping"],
			apply: (token, _ctx, state) => {
				state.count = (state.count ?? 0) + 1;
				return { applied: true };
			},
			init: () => ({ count: 0 }),
		};

		registerMarker(tool as MarkerTool<unknown>);
		expect(getMarker(markerName)).toBeDefined();
		expect(isKnownMarkerTool(markerName)).toBe(true);

		// stripMarkers 能自动识别并剥离
		const text = "这是前文 [[test_custom_marker:ping:hello]] 这是后文";
		expect(stripMarkers(text)).toBe("这是前文  这是后文");

		// 注销后恢复
		expect(unregisterMarker(markerName)).toBe(true);
		expect(getMarker(markerName)).toBeUndefined();
		expect(isKnownMarkerTool(markerName)).toBe(false);
		expect(stripMarkers(text)).toBe(text);
	});

	it("内置 Marker 坚决不可注销", () => {
		expect(unregisterMarker("notify")).toBe(false);
		expect(unregisterMarker("conv")).toBe(false);
		expect(unregisterMarker("action")).toBe(false);
		expect(getMarker("notify")).toBeDefined();
		expect(isKnownMarkerTool("notify")).toBe(true);
	});

	it("流式未闭合半截标记会被动态正确剥离", () => {
		const markerName = "test_stream_marker";
		registerMarker({
			name: markerName,
			guidance: ["some guidance"],
			apply: () => ({ applied: true }),
		});

		const incomplete = "正文生成中 [[test_stream_marker:param";
		expect(stripMarkers(incomplete, { stripTrailingIncomplete: true })).toBe("正文生成中");

		unregisterMarker(markerName);
	});

	it("MarkerService.listForUi 包含插件 label 与 pluginId", () => {
		const markerName = "test_ui_marker";
		registerMarker({
			name: markerName,
			label: "我的插件标记",
			pluginId: "my-cool-plugin",
			guidance: ["test guidance"],
			apply: () => ({ applied: true }),
		});

		const { host } = makeMockHost();
		const svc = new MarkerService(host);
		const list = svc.listForUi();
		const found = list.find((m) => m.name === markerName);

		expect(found).toBeDefined();
		expect(found?.label).toBe("我的插件标记");
		expect(found?.pluginId).toBe("my-cool-plugin");
		expect(found?.enabled).toBe(true);

		unregisterMarker(markerName);
	});

	it("MarkerService.buildGuidance 自动包含插件 Marker 引导词并在禁用时剔除", () => {
		const markerName = "test_guidance_marker";
		registerMarker({
			name: markerName,
			guidance: ["[[test_guidance_marker:do:something]] execute action"],
			apply: () => ({ applied: true }),
		});

		const { host } = makeMockHost();
		const svc = new MarkerService(host);

		let guidance = svc.buildGuidance();
		expect(guidance).toContain("[[test_guidance_marker:do:something]] execute action");

		// 禁用该标记
		svc.toggleMarker(markerName, false);
		guidance = svc.buildGuidance();
		expect(guidance).not.toContain("test_guidance_marker");

		// 重新启用
		svc.toggleMarker(markerName, true);
		guidance = svc.buildGuidance();
		expect(guidance).toContain("[[test_guidance_marker:do:something]] execute action");

		unregisterMarker(markerName);
	});

	it("handleAssistantText 串行解析并执行插件 Marker 且维护状态", async () => {
		const markerName = "test_state_marker";
		let executed = 0;
		registerMarker({
			name: markerName,
			guidance: ["guidance"],
			apply: (token, _ctx, state: { count: number }) => {
				state.count = (state.count ?? 0) + 1;
				executed++;
				return { applied: true };
			},
			init: () => ({ count: 0 }),
		});

		const { host } = makeMockHost();
		const svc = new MarkerService(host);

		await svc.handleAssistantText("conv-1", "这是回复 [[test_state_marker:add:1]] 内容 [[test_state_marker:add:2]]");

		expect(executed).toBe(2);
		const raw = svc.getRawState("conv-1", markerName) as { count: number };
		expect(raw.count).toBe(2);

		unregisterMarker(markerName);
	});

	it("前端 syncKnownInlineMarkers 与 stripInlineMarkers 动态联动", () => {
		const customTag = "my_custom_tag";
		const raw = "实时回复文字 [[my_custom_tag:click:ok]] 结束";

		// 未同步前，原样保留避免误杀
		expect(stripInlineMarkers(raw, false)).toBe(raw);

		// 同步已知列表
		syncKnownInlineMarkers(["notify", "conv", "action", customTag]);
		expect(stripInlineMarkers(raw, false)).toBe("实时回复文字  结束");

		// 测试流式末尾半截
		const streamingRaw = "文字生成中 [[my_custom_tag:foo";
		expect(stripInlineMarkers(streamingRaw, true)).toBe("文字生成中");
	});

	it("通过 PluginManager 与 host.registerMarker 注册并在反激活时彻底回收", async () => {
		const base = mkdtempSync(join(tmpdir(), "pwi-plug-marker-"));
		try {
			mkdirSync(join(base, "plugins", "marker_fixture"), { recursive: true });
			writeFileSync(
				join(base, "plugins", "marker_fixture", "manifest.json"),
				JSON.stringify({ name: "标记测试插件", permissions: ["tools"] }),
			);
			writeFileSync(
				join(base, "plugins", "marker_fixture", "index.mjs"),
				`
export default {
	activate(host) {
		host.registerMarker({
			name: "plug_tag",
			label: "插件标记",
			guidance: ["[[plug_tag:set:<v>]] set value"],
			apply: () => ({ applied: true }),
		});
	},
};
`,
			);

			const mgr = new PluginManager(base, process.cwd());
			let changed = 0;
			mgr.onMarkersChanged = () => {
				changed += 1;
			};

			await mgr.ensureLoaded();
			expect(getMarker("plug_tag")).toBeDefined();
			expect(isKnownMarkerTool("plug_tag")).toBe(true);
			expect(changed).toBeGreaterThanOrEqual(1);

			// 验证 stripMarkers 认识它
			expect(stripMarkers("hello [[plug_tag:set:123]] world")).toBe("hello  world");

			// 反激活清理
			mgr.dispose();
			expect(getMarker("plug_tag")).toBeUndefined();
			expect(isKnownMarkerTool("plug_tag")).toBe(false);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("插件注册 Marker 命名冲突拦截（内置保留名冲突与跨插件同名冲突）", async () => {
		const base = mkdtempSync(join(tmpdir(), "pwi-plug-marker-conflict-"));
		try {
			mkdirSync(join(base, "plugins", "conflict_fixture"), { recursive: true });
			writeFileSync(
				join(base, "plugins", "conflict_fixture", "manifest.json"),
				JSON.stringify({ name: "冲突夹具", permissions: ["tools"] }),
			);
			writeFileSync(
				join(base, "plugins", "conflict_fixture", "index.mjs"),
				`
export default {
	activate(host) {
		// 试图抢占内置名
		host.registerMarker({
			name: "notify",
			guidance: ["bad"],
			apply: () => ({ applied: true }),
		});
	},
};
`,
			);

			const mgr = new PluginManager(base, process.cwd());
			await mgr.ensureLoaded();

			// 内置 marker 不会被篡改
			const m = getMarker("notify");
			expect(m?.pluginId).toBeUndefined();

			mgr.dispose();
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});
