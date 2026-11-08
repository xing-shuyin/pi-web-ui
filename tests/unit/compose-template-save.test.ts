import { describe, expect, it } from "vitest";
import { SettingsService, type SettingsHost } from "../../server/settings-service.js";
import { DEFAULT_PROMPT_TEMPLATE } from "../../server/prompt-composer.js";
import type { SubagentTemplatesStore } from "../../server/subagent-templates.js";

const mockTemplates = {
	list: () => [],
	listDefault: () => [],
	get: () => undefined,
	set: () => ({ ok: true as const, id: "t1" }),
	delete: () => true,
} as unknown as SubagentTemplatesStore;

function makeMockHost(savedSettings: Record<string, unknown> = {}) {
	const emitted: any[] = [];
	const saved: any[] = [];
	const host: SettingsHost = {
		clientId: "test-client",
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
				toolWatchdogTimeoutMs: 1_200_000,
				readDirEnabled: true,
				bgAutoCleanupMin: 0,
				toolLazyLoading: true,
				toolApprovalEnabled: true,
				questionnaireEnabled: true,
				goalModeEnabled: true,
				parallelReminderEnabled: true,
				thinkingWrap: false,
				toolsWrap: true,
				toolImagesEnabled: true,
				skillsFullText: [],
				visionBridgeEnabled: true,
				visionBridgeModel: null,
				visionBridgePromptMode: "append",
				visionBridgePrompt: "",
				scmCommitMsgPromptMode: "append",
				scmCommitMsgPrompt: "",
				planModePromptMode: "append",
				planModePrompt: "",
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
				defaultAgentPreset: "standard",
				defaultPermissionPreset: "workspace-write-never",
				...savedSettings,
			}),
			saveSettings: (_id: string, s: any) => {
				Object.assign(savedSettings, structuredClone(s));
				saved.push(structuredClone(s));
			},
			getPresets: () => [],
			savePresets: () => {},
			getQuickPhrasesSeeded: () => true,
		} as any,
		emit: (m: any) => {
			emitted.push(m);
		},
		flushSnapshot: () => {},
		isDisposed: () => false,
		getSession: () => {
			throw new Error("no session");
		},
		cwd: () => "/test-workspace",
		agentDir: () => "/test-agent-dir",
		isStreaming: () => false,
		reloadSession: async () => {},
		applyRetryOverrides: () => {},
		applyCompactionOverrides: () => {},
		applyToolGating: () => {},
		promptSnapshot: () => ({ full: "", texts: {}, toolsSchema: "" }),
	};
	return { host, emitted, saved };
}

describe("compose template persistence and state synchronization", () => {
	it("saves promptTemplate and persists to client state store", async () => {
		const { host, saved, emitted } = makeMockHost();
		const svc = new SettingsService(host, mockTemplates);

		const newTemplate = "{{soul}}\n\n{{tools}}\n\n{{guidelines}}";
		await svc.set({ promptTemplate: newTemplate });

		expect(svc.current.promptTemplate).toBe(newTemplate);
		expect(saved.length).toBeGreaterThan(0);
		expect(saved[saved.length - 1].promptTemplate).toBe(newTemplate);

		const pushMsg = emitted.find((m) => m.type === "settings_state");
		expect(pushMsg).toBeDefined();
		expect(pushMsg.settings.promptTemplate).toBe(newTemplate);
	});

	it("saves promptOverrides and clears override when empty string is provided", async () => {
		const { host, saved, emitted } = makeMockHost();
		const svc = new SettingsService(host, mockTemplates);

		await svc.set({ promptOverrides: { soul: "Custom soul text" } });
		expect(svc.current.promptOverrides?.soul).toBe("Custom soul text");

		await svc.set({ promptOverrides: { soul: "" } });
		expect(svc.current.promptOverrides?.soul).toBeUndefined();

		const pushMsgs = emitted.filter((m) => m.type === "settings_state");
		const lastPush = pushMsgs[pushMsgs.length - 1];
		expect(lastPush.settings.promptOverrides?.soul).toBeUndefined();
	});

	it("preserves DEFAULT_PROMPT_TEMPLATE reset", async () => {
		const { host, saved } = makeMockHost();
		const svc = new SettingsService(host, mockTemplates);

		await svc.set({ promptTemplate: DEFAULT_PROMPT_TEMPLATE });
		expect(svc.current.promptTemplate).toBe(DEFAULT_PROMPT_TEMPLATE);
		expect(saved[saved.length - 1].promptTemplate).toBe(DEFAULT_PROMPT_TEMPLATE);
	});

	it("appends token chip with formatting logic", () => {
		const appendToken = (current: string, token: string) => {
			return current.trim() ? `${current}\n\n{{${token}}}` : `{{${token}}}`;
		};

		expect(appendToken("", "tools")).toBe("{{tools}}");
		expect(appendToken("   ", "tools")).toBe("{{tools}}");

		expect(appendToken("{{soul}}", "tools")).toBe("{{soul}}\n\n{{tools}}");
		expect(appendToken("{{soul}}\n\n{{append}}", "guidelines")).toBe("{{soul}}\n\n{{append}}\n\n{{guidelines}}");
	});
});
