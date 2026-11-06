import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClientStateStore } from "../../server/client-state.js";
import { sanitizePresetSettings } from "../../server/preset-share.js";
import { PRESET_EXCLUDED_KEYS, PRESET_FIELD_NAMES } from "../../server/preset-fields.js";
import { SettingsService, type SettingsHost } from "../../server/settings-service.js";
import type { SubagentTemplatesStore } from "../../server/subagent-templates.js";
import { MAX_QUICK_ASK_PROMPT_LENGTH, normalizeQuickAskSettings } from "../../server/quick-ask-settings.js";
import { handleSettingsMessage } from "../../server/dispatch-domain-handlers.js";
import type { ClientMessage } from "../../server/protocol.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup() {
	const dir = mkdtempSync(join(tmpdir(), "pi-quick-ask-"));
	roots.push(dir);
	const path = join(dir, "client-state.json");
	const store = new ClientStateStore(path);
	const emit = vi.fn();
	const reloadSession = vi.fn();
	const host = {
		clientId: "quick-ask-test",
		stateStore: store,
		emit,
		flushSnapshot: () => {},
		isDisposed: () => false,
		getSession: () => {
			throw new Error("No main session should be required");
		},
		cwd: () => dir,
		agentDir: () => dir,
		isStreaming: () => false,
		reloadSession,
		applyRetryOverrides: () => {},
		applyCompactionOverrides: () => {},
		applyToolGating: () => {},
		promptSnapshot: () => ({ full: "MAIN SYSTEM MUST NOT BE USED", texts: {}, toolsSchema: "MAIN TOOLS" }),
	} as unknown as SettingsHost;
	const service = new SettingsService(host, { list: () => [] } as unknown as SubagentTemplatesStore);
	return { dir, path, store, host, service, emit, reloadSession };
}
const defaults = {
	quickAskEnabled: true,
	quickAskModel: null,
	quickAskThinking: "off",
	quickAskSystemPrompt: "",
	quickAskExplainPrompt: "解释下: {{input}}",
};

describe("quick ask settings wiring", () => {
	it("keeps popup preferences outside imported and exported main-agent presets", () => {
		const { settings } = sanitizePresetSettings(defaults);
		expect(settings).toEqual({});
		for (const key of Object.keys(defaults)) {
			expect(PRESET_EXCLUDED_KEYS).toContain(key);
			expect(PRESET_FIELD_NAMES).not.toContain(key);
		}
	});
	it("provides isolated defaults without a main conversation", () => {
		const { service, store } = setup();
		expect(service.current).toMatchObject(defaults);
		expect(store.getSettingsSnapshot("other-browser")).toMatchObject(defaults);
	});
	it("normalizes malformed persisted settings", () => {
		const { path } = setup();
		writeFileSync(
			path,
			JSON.stringify({
				__settings__: {
					projects: [],
					settings: {
						quickAskEnabled: "false",
						quickAskModel: "invalid",
						quickAskThinking: "turbo",
						quickAskSystemPrompt: {},
						quickAskExplainPrompt: " ",
					},
				},
			}),
		);
		// Normalization is also exercised directly so corrupted storage never reaches the model call.
		expect(
			normalizeQuickAskSettings({
				quickAskEnabled: "false",
				quickAskModel: "invalid",
				quickAskThinking: "turbo",
				quickAskSystemPrompt: {},
				quickAskExplainPrompt: " ",
			}),
		).toEqual(defaults);
		expect(new ClientStateStore(path).getSettings("browser")).toMatchObject(defaults);
	});
	it("persists all preferences globally, pushes them, and retains them on unrelated updates", async () => {
		const { path, store, service, emit, reloadSession } = setup();
		const values = {
			quickAskEnabled: false,
			quickAskModel: "vendor/model/variant",
			quickAskThinking: "high" as const,
			quickAskSystemPrompt: "Only popup instructions",
			quickAskExplainPrompt: "Explain {{input}} in detail",
		};
		await service.set(values);
		expect(service.current).toMatchObject(values);
		expect(new ClientStateStore(path).getSettings("another-client")).toMatchObject(values);
		service.push();
		const push = emit.mock.calls.map(([message]) => message).findLast((message) => message.type === "settings_state");
		expect(push?.settings).toMatchObject(values);
		await service.set({ quickAskModel: null, quickAskSystemPrompt: "", quickAskEnabled: true });
		await service.set({ scmCommitMsgPrompt: "unrelated" });
		expect(store.getSettings("browser")).toMatchObject({
			...values,
			quickAskEnabled: true,
			quickAskModel: null,
			quickAskSystemPrompt: "",
		});
		expect(reloadSession).not.toHaveBeenCalled();
	});
	it("persists real dispatch patches without dropping fields or resetting omitted preferences", async () => {
		const { service, store, path } = setup();
		let pending = Promise.resolve();
		const session = {
			setSettings: (patch: Parameters<SettingsService["set"]>[0]) => {
				pending = service.set(patch);
				return pending;
			},
		} as any;
		const dispatch = async (patch: Omit<Extract<ClientMessage, { type: "set_settings" }>, "type">) => {
			expect(handleSettingsMessage({ type: "set_settings", ...patch }, session)).toBe(true);
			await pending;
		};
		await dispatch({ quickAskModel: "local/independent" });
		await dispatch({ quickAskThinking: "high" });
		await dispatch({ quickAskSystemPrompt: "Only the popup system" });
		await dispatch({ quickAskExplainPrompt: "Custom {{input}}" });
		await dispatch({ quickAskEnabled: false });
		await dispatch({ quickPhrasesEnabled: false });
		const expected = {
			quickAskModel: "local/independent",
			quickAskThinking: "high",
			quickAskSystemPrompt: "Only the popup system",
			quickAskExplainPrompt: "Custom {{input}}",
			quickAskEnabled: false,
		};
		expect(service.current).toMatchObject(expected);
		expect(new ClientStateStore(path).getSettings("browser")).toMatchObject(expected);
		store.saveSettings("browser", { quickAskModel: undefined, quickAskThinking: undefined });
		expect(store.getSettings("browser")).toMatchObject(expected);
		await dispatch({ quickAskModel: null, quickAskSystemPrompt: "", quickAskEnabled: true });
		expect(service.current).toMatchObject({
			...expected,
			quickAskModel: null,
			quickAskSystemPrompt: "",
			quickAskEnabled: true,
		});
	});
	it("normalizes updates while preserving valid template text and supported thinking levels", async () => {
		const { service } = setup();
		for (const quickAskThinking of ["off", "minimal", "low", "medium", "high", "xhigh"] as const) {
			await service.set({ quickAskThinking });
			expect(service.current.quickAskThinking).toBe(quickAskThinking);
		}
		await service.set({
			quickAskModel: "  vendor/model  ",
			quickAskExplainPrompt: " {{input}} + {{input}} $& ",
			quickAskSystemPrompt: "  custom  ",
		});
		expect(service.current).toMatchObject({
			quickAskModel: "vendor/model",
			quickAskExplainPrompt: " {{input}} + {{input}} $& ",
			quickAskSystemPrompt: "  custom  ",
		});
		await service.set({
			quickAskModel: "",
			quickAskThinking: "invalid" as any,
			quickAskExplainPrompt: " ",
			quickAskSystemPrompt: "x".repeat(MAX_QUICK_ASK_PROMPT_LENGTH + 1),
		});
		expect(service.current).toMatchObject(defaults);
	});
});
