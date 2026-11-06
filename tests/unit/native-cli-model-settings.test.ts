import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientStateStore } from "../../server/client-state.js";
import { handleSettingsMessage } from "../../server/dispatch-domain-handlers.js";
import { normalizeNativeCliInheritModel } from "../../server/engine-catalog.js";
import { SettingsService, type SettingsHost } from "../../server/settings-service.js";
import type { SubagentTemplatesStore } from "../../server/subagent-templates.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
	const root = mkdtempSync(join(tmpdir(), "pi-cli-model-settings-"));
	roots.push(root);
	const file = join(root, "client-state.json");
	const store = new ClientStateStore(file);
	const host = {
		clientId: "cli-model-settings",
		stateStore: store,
		emit: vi.fn(),
		flushSnapshot: vi.fn(),
		isDisposed: () => false,
		getSession: () => {
			throw new Error("no session");
		},
		cwd: () => root,
		agentDir: () => root,
		isStreaming: () => false,
		reloadSession: vi.fn(async () => {}),
		applyRetryOverrides: vi.fn(),
		applyCompactionOverrides: vi.fn(),
		applyToolGating: vi.fn(),
		promptSnapshot: () => ({ full: "", texts: {}, toolsSchema: "" }),
	};
	const service = new SettingsService(
		host as unknown as SettingsHost,
		{ list: () => [] } as unknown as SubagentTemplatesStore,
	);
	return { file, store, service, host };
}

describe("native CLI model inheritance settings", () => {
	it("keeps all CLI defaults until independently enabled, persists changes, and pushes settings without reloading", async () => {
		const { file, service, host } = setup();
		expect(service.current.nativeCliInheritModel).toEqual({});
		await service.set({ nativeCliInheritModel: { pi: true, claude: true } });
		await service.set({ nativeCliInheritModel: { codex: true } });
		await service.set({ nativeCliInheritModel: { claude: false } });
		const expected = { pi: true, claude: false, codex: true };
		expect(service.current.nativeCliInheritModel).toEqual(expected);
		expect(new ClientStateStore(file).getSettings("another-client").nativeCliInheritModel).toEqual(expected);
		expect(host.emit).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "settings_state",
				settings: expect.objectContaining({ nativeCliInheritModel: expected }),
			}),
		);
		expect(host.reloadSession).not.toHaveBeenCalled();
	});

	it("accepts only supported CLI ids and boolean preferences at the service and storage boundaries", async () => {
		expect(normalizeNativeCliInheritModel(null)).toEqual({});
		expect(normalizeNativeCliInheritModel([])).toEqual({});
		expect(normalizeNativeCliInheritModel(Object.create({ pi: true }))).toEqual({});
		const { service, store } = setup();
		await service.set({
			nativeCliInheritModel: { pi: true, codex: "yes", dsh: true, durable: true, custom: true } as any,
		});
		expect(service.current.nativeCliInheritModel).toEqual({ pi: true });
		store.saveSettings("another-client", { nativeCliInheritModel: { pi: false, claude: true, unknown: true } as any });
		expect(service.current.nativeCliInheritModel).toEqual({ pi: false, claude: true });
		const detached = store.getSettings("another-client");
		detached.nativeCliInheritModel.claude = false;
		expect(store.getSettings("another-client").nativeCliInheritModel.claude).toBe(true);
	});

	it("forwards CLI preferences from the settings wire message", () => {
		const setSettings = vi.fn(async () => {});
		expect(
			handleSettingsMessage({ type: "set_settings", nativeCliInheritModel: { codex: false } }, { setSettings } as any),
		).toBe(true);
		expect(setSettings).toHaveBeenCalledWith(expect.objectContaining({ nativeCliInheritModel: { codex: false } }));
	});
});
