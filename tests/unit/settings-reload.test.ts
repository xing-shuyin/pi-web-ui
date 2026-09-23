/**
 * settings-reload failures must be visible (w18-reload):
 * applyRuntime() success → info notice; failure → console.error + error notice;
 * streaming → deferred with info notice and no reload call.
 */
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
				editSoftEnabled: false,
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
});
