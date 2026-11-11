import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeDisabledPluginTools } from "../../server/client-state.js";
import { syncPluginToolsIntoSession, PluginManager } from "../../server/plugins.js";
import { SettingsService, type SettingsHost } from "../../server/settings-service.js";

describe("normalizeDisabledPluginTools", () => {
	it("非数组回落空（默认全开）", () => {
		expect(normalizeDisabledPluginTools(undefined)).toEqual([]);
		expect(normalizeDisabledPluginTools("x")).toEqual([]);
		expect(normalizeDisabledPluginTools(null)).toEqual([]);
	});

	it("去重/去空白/丢弃脏条目，未知名保留（重装仍关闭）", () => {
		expect(normalizeDisabledPluginTools([" mail ", "mail", "", 42, "ghost_tool", null])).toEqual([
			"mail",
			"ghost_tool",
		]);
	});

	it("超长单名丢弃、总量封顶 256", () => {
		expect(normalizeDisabledPluginTools(["x".repeat(129)])).toEqual([]);
		const many = Array.from({ length: 300 }, (_, i) => `tool_${i}`);
		const out = normalizeDisabledPluginTools(many);
		expect(out).toHaveLength(256);
		expect(out[0]).toBe("tool_0");
	});
});

describe("agentToolsSnapshot / scan attach", () => {
	function makeFixture(base: string) {
		const dir = join(base, "plugins", "fixture");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "manifest.json"), JSON.stringify({ name: "夹具" }));
		writeFileSync(
			join(dir, "index.mjs"),
			`
export default {
	activate(host) {
		host.registerAgentTool({
			name: "fixture_zebra",
			label: "斑马",
			description: "zebra tool",
			execute: async () => "ok",
		});
		host.registerAgentTool({
			name: "fixture_alpha",
			description: "alpha tool",
			execute: async () => "ok",
		});
	},
};
`,
		);
	}

	it("快照按名排序、只含展示字段；分组快照按插件排序", async () => {
		const base = mkdtempSync(join(tmpdir(), "pwi-plug-snap-"));
		try {
			makeFixture(base);
			const mgr = new PluginManager(base, process.cwd());
			await mgr.ensureLoaded();
			expect(mgr.agentToolsSnapshot("fixture").map((t) => t.name)).toEqual(["fixture_alpha", "fixture_zebra"]);
			expect(mgr.agentToolsSnapshot("fixture")[1]).toEqual({
				name: "fixture_zebra",
				label: "斑马",
				description: "zebra tool",
			});
			expect(mgr.agentToolsSnapshot("nope")).toEqual([]);
			expect(mgr.getAgentToolsGrouped()).toEqual([
				{
					pluginId: "fixture",
					tools: [
						{ name: "fixture_alpha", description: "alpha tool" },
						{ name: "fixture_zebra", label: "斑马", description: "zebra tool" },
					],
				},
			]);
			mgr.dispose();
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("scan 与 ensureLoaded 的 UiPluginInfo 自带 agentTools", async () => {
		const base = mkdtempSync(join(tmpdir(), "pwi-plug-scan-"));
		try {
			makeFixture(base);
			const mgr = new PluginManager(base, process.cwd());
			const list = await mgr.ensureLoaded();
			const info = list.find((p) => p.id === "fixture");
			expect(info?.agentTools?.map((t) => t.name)).toEqual(["fixture_alpha", "fixture_zebra"]);
			const rescanned = await mgr.list();
			expect(rescanned.find((p) => p.id === "fixture")?.agentTools).toHaveLength(2);

			const allTools = mgr.getAgentTools();
			expect(allTools).toHaveLength(2);
			expect(allTools[0]?.pluginId).toBe("fixture");
			expect(allTools[1]?.pluginId).toBe("fixture");

			mgr.dispose();
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});

describe("禁用语义（会话同步层面）", () => {
	it("被禁用的工具名不在 defs 里 → 同步时从会话移除", () => {
		const session = {
			_customTools: [{ name: "bash" }, { name: "fixture_alpha" }] as Array<{ name: string } & Record<string, unknown>>,
			_refreshToolRegistry() {},
		};
		const next = syncPluginToolsIntoSession(
			session as never,
			[] as never,
			new Set(["fixture_alpha", "bash"].filter((n) => n !== "bash")),
		);
		expect(next).toEqual(new Set());
		expect(session._customTools.map((d) => d.name)).toEqual(["bash"]);
	});

	it("更新 disabledPlugins 时触发 toolGatingChanged 并调用 applyToolGating (issue #395)", async () => {
		const applyToolGating = vi.fn();
		const host = {
			clientId: "c-test",
			stateStore: {
				getSettings: () => ({
					promptMode: "append",
					customSystemPrompt: "",
					promptTemplate: "",
					promptOverrides: {},
					disabledSkills: [],
					disabledExtensions: [],
					disabledAgentTools: [],
					disabledPluginTools: [],
					terminalToolsEnabled: false,
					terminalBash: false,
					terminalBashIdleMs: 15_000,
					terminalBashMaxForegroundMs: 60_000,
					questionnaireEnabled: true,
					goalModeEnabled: true,
					thinkingWrap: false,
					toolsWrap: true,
					skillsFullText: [],
					visionBridgeEnabled: true,
					visionBridgeModel: null,
					visionBridgePromptMode: "append",
					visionBridgePrompt: "",
					subagentDefaultModel: null,
					retryMaxAttempts: 6,
					softCapTokens: 0,
					softCapByModel: {},
					quickPhrases: [],
					quickPhrasesEnabled: true,
					minimalNewChat: false,
					preserveDraftAcrossConversations: false,
					reviewPrompt: "",
					reviewDisabledSkills: [],
					disabledPlugins: [],
					uiLayout: {},
				}),
				saveSettings: () => {},
				getPresets: () => [],
				getQuickPhrasesSeeded: () => false,
			},
			emit: () => {},
			flushSnapshot: () => {},
			isDisposed: () => false,
			getSession: () => {
				throw new Error("no session");
			},
			cwd: () => "/tmp",
			agentDir: () => "/tmp",
			isStreaming: () => false,
			reloadSession: async () => {},
			applyRetryOverrides: () => {},
			applyCompactionOverrides: () => {},
			applyToolGating,
			promptSnapshot: () => ({ full: "", texts: {}, toolsSchema: "" }),
			getMarkerState: () => ({ disabledMarkers: [], markers: [] }),
			getApprovalPolicy: () => ({ enabled: false }),
			onGoalModeDisabled: () => {},
		} as unknown as SettingsHost;

		const templates = {
			list: () => [],
		} as unknown as import("../../server/subagent-templates.js").SubagentTemplatesStore;
		const approvalRules = { list: () => [] } as unknown as import("../../server/approval-rules.js").ApprovalRulesStore;
		const svc = new SettingsService(host, templates, approvalRules);
		await svc.set({ disabledPlugins: ["vscode-editor"] });
		expect(applyToolGating).toHaveBeenCalledTimes(1);
	});
});
