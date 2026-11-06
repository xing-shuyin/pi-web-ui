import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClientStateStore } from "../../server/client-state.js";
import { PRESET_FIELD_META, PRESET_FIELD_NAMES } from "../../server/preset-fields.js";
import { sanitizePresetSettings } from "../../server/preset-share.js";
import { SettingsService, type SettingsHost } from "../../server/settings-service.js";

const roots: string[] = [];
function tempStore(): ClientStateStore {
	const dir = mkdtempSync(join(tmpdir(), "pi-preserve-draft-"));
	roots.push(dir);
	return new ClientStateStore(join(dir, "client-state.json"));
}

afterEach(() => {
	for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const templates = { list: () => [] } as unknown as import("../../server/subagent-templates.js").SubagentTemplatesStore;

function makeHost(store: ClientStateStore): SettingsHost & { emitted: unknown[] } {
	const emitted: unknown[] = [];
	return {
		clientId: "preserve-draft-test",
		stateStore: store,
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
		emitted,
	} as SettingsHost & { emitted: unknown[] };
}

describe("preserveDraftAcrossConversations 配置项", () => {
	it("默认值为 false", () => {
		const store = tempStore();
		const host = makeHost(store);
		const svc = new SettingsService(host, templates);

		expect(svc.current.preserveDraftAcrossConversations).toBe(false);
	});

	it("SettingsService.set 可以将开关设为 true 并持久化", async () => {
		const store = tempStore();
		const host = makeHost(store);
		const svc = new SettingsService(host, templates);

		await svc.set({ preserveDraftAcrossConversations: true });
		expect(svc.current.preserveDraftAcrossConversations).toBe(true);

		const svc2 = new SettingsService(host, templates);
		expect(svc2.current.preserveDraftAcrossConversations).toBe(true);

		await svc.set({ preserveDraftAcrossConversations: false });
		expect(svc.current.preserveDraftAcrossConversations).toBe(false);
	});

	it("预设字段名单收录了 preserveDraftAcrossConversations", () => {
		expect(PRESET_FIELD_NAMES).toContain("preserveDraftAcrossConversations");
		expect(PRESET_FIELD_META.preserveDraftAcrossConversations).toBeDefined();
		expect(PRESET_FIELD_META.preserveDraftAcrossConversations.labelZh).toBe("输入框文字跨对话保留");
	});

	it("预设净化保留合法的 preserveDraftAcrossConversations 布尔值", () => {
		const sanitized = sanitizePresetSettings({ preserveDraftAcrossConversations: true });
		expect(sanitized.settings.preserveDraftAcrossConversations).toBe(true);

		const sanitizedFalse = sanitizePresetSettings({ preserveDraftAcrossConversations: false });
		expect(sanitizedFalse.settings.preserveDraftAcrossConversations).toBe(false);
	});
});
