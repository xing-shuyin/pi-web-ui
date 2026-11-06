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
	const dir = mkdtempSync(join(tmpdir(), "pi-minimal-new-chat-"));
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
		clientId: "minimal-new-chat-test",
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

describe("minimalNewChat 配置项", () => {
	it("默认值为 false", () => {
		const store = tempStore();
		const host = makeHost(store);
		const svc = new SettingsService(host, templates);

		expect(svc.current.minimalNewChat).toBe(false);
	});

	it("SettingsService.set 可以将开关设为 true 并持久化", async () => {
		const store = tempStore();
		const host = makeHost(store);
		const svc = new SettingsService(host, templates);

		await svc.set({ minimalNewChat: true });
		expect(svc.current.minimalNewChat).toBe(true);

		const svc2 = new SettingsService(host, templates);
		expect(svc2.current.minimalNewChat).toBe(true);

		await svc.set({ minimalNewChat: false });
		expect(svc.current.minimalNewChat).toBe(false);
	});

	it("预设字段收录该配置并声明元数据", () => {
		expect(PRESET_FIELD_NAMES).toContain("minimalNewChat");
		expect(PRESET_FIELD_META.minimalNewChat).toBeDefined();
		expect(PRESET_FIELD_META.minimalNewChat.labelZh).toBe("极简新对话");
	});

	it("预设净化保留合法的 minimalNewChat 布尔值", () => {
		const sanitized = sanitizePresetSettings({ minimalNewChat: true });
		expect(sanitized.settings.minimalNewChat).toBe(true);

		const sanitizedFalse = sanitizePresetSettings({ minimalNewChat: false });
		expect(sanitizedFalse.settings.minimalNewChat).toBe(false);
	});
});
