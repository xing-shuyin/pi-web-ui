import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { SettingsService, type SettingsHost } from "../../server/settings-service.js";
import type { ClientStateStore } from "../../server/client-state.js";

function makeHost(over: Partial<SettingsHost> & { emitted?: unknown[] } = {}): SettingsHost & {
	emitted: unknown[];
} {
	const emitted: unknown[] = over.emitted ?? [];
	return {
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
			getPresets: () => [],
			getQuickPhrasesSeeded: () => false,
		} as unknown as ClientStateStore,
		emit: (m: unknown) => {
			emitted.push(m);
		},
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
		applyToolGating: () => {},
		promptSnapshot: () => ({ full: "", texts: {}, toolsSchema: "" }),
		...over,
		emitted,
	} as SettingsHost & { emitted: unknown[] };
}

const templates = { list: () => [] } as unknown as import("../../server/subagent-templates.js").SubagentTemplatesStore;

let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	errSpy.mockRestore();
});

describe("目标模式总开关 on→off", () => {
	it("只在 on→off 跃迁时调一次 onGoalModeDisabled", async () => {
		const cb = vi.fn();
		const store = { saved: 0, goalModeEnabled: true };
		const host = makeHost({
			onGoalModeDisabled: cb,
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
					goalModeEnabled: store.goalModeEnabled,
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
				getPresets: () => [],
				getQuickPhrasesSeeded: () => false,
				saveSettings: (_id: string, patch: { goalModeEnabled?: boolean }) => {
					if (patch.goalModeEnabled !== undefined) store.goalModeEnabled = patch.goalModeEnabled;
					store.saved++;
				},
			} as unknown as ClientStateStore,
		});
		const svc = new SettingsService(host, templates);
		await svc.set({ goalModeEnabled: false });
		expect(cb).toHaveBeenCalledTimes(1);
		await svc.set({ goalModeEnabled: false });
		expect(cb).toHaveBeenCalledTimes(1);
		await svc.set({ goalModeEnabled: true });
		expect(cb).toHaveBeenCalledTimes(1);
		expect(store.saved).toBe(3);
	});
});

describe("SettingsService.applyRuntime", () => {
	it("success emits info notice", async () => {
		const host = makeHost();
		const svc = new SettingsService(host, templates);
		await svc.applyRuntime();
		const notices = host.emitted.filter((m) => (m as { type?: string }).type === "notice");
		expect(notices.some((m) => (m as { level?: string }).level === "info")).toBe(true);
		expect(errSpy).not.toHaveBeenCalled();
	});

	it("failure logs + emits error notice", async () => {
		const host = makeHost({
			reloadSession: async () => {
				throw new Error("disk corrupt");
			},
		});
		const svc = new SettingsService(host, templates);
		await svc.applyRuntime();
		expect(errSpy).toHaveBeenCalled();
		const errs = host.emitted.filter(
			(m) => (m as { type?: string }).type === "notice" && (m as { level?: string }).level === "error",
		);
		expect(errs.length).toBe(1);
		expect((errs[0] as { textEn?: string }).textEn).toMatch(/Failed to apply settings/);
	});

	it("streaming defers with info notice and no reload call", async () => {
		const reload = vi.fn(async () => {});
		const host = makeHost({ isStreaming: () => true, reloadSession: reload });
		const svc = new SettingsService(host, templates);
		await svc.applyRuntime();
		expect(reload).not.toHaveBeenCalled();
		expect(svc.hasPendingReload()).toBe(true);
		const infos = host.emitted.filter(
			(m) => (m as { type?: string }).type === "notice" && (m as { level?: string }).level === "info",
		);
		expect(infos.length).toBe(1);
		expect(svc.consumePendingReload()).toBe(true);
		expect(svc.hasPendingReload()).toBe(false);
	});

	it("applyReload 中途 isStreaming 变 true 也会被防御并转为 pendingReload (TOCTOU 防御)", async () => {
		const reload = vi.fn(async () => {});
		let streaming = false;
		const host = makeHost({
			isStreaming: () => streaming,
			reloadSession: reload,
		});
		const svc = new SettingsService(host, templates);
		streaming = true;
		await (svc as unknown as { applyReload: () => Promise<void> }).applyReload();
		expect(reload).not.toHaveBeenCalled();
		expect(svc.hasPendingReload()).toBe(true);
		expect(svc.consumePendingReload()).toBe(true);
	});
});
