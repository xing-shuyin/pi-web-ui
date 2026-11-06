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
	const dir = mkdtempSync(join(tmpdir(), "pi-open-recent-"));
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
		clientId: "open-recent-test",
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

describe("openRecentSessionOnProjectSwitch 配置项", () => {
	it("默认值为 true", () => {
		const store = tempStore();
		const host = makeHost(store);
		const svc = new SettingsService(host, templates);

		expect(svc.current.openRecentSessionOnProjectSwitch).toBe(true);
	});

	it("SettingsService.set 可以将开关设为 false 并持久化", async () => {
		const store = tempStore();
		const host = makeHost(store);
		const svc = new SettingsService(host, templates);

		await svc.set({ openRecentSessionOnProjectSwitch: false });
		expect(svc.current.openRecentSessionOnProjectSwitch).toBe(false);

		const svc2 = new SettingsService(host, templates);
		expect(svc2.current.openRecentSessionOnProjectSwitch).toBe(false);

		await svc2.set({ openRecentSessionOnProjectSwitch: true });
		expect(svc2.current.openRecentSessionOnProjectSwitch).toBe(true);
	});

	it("预设字段名单收录了 openRecentSessionOnProjectSwitch", () => {
		expect(PRESET_FIELD_NAMES).toContain("openRecentSessionOnProjectSwitch");
		const meta = PRESET_FIELD_META.openRecentSessionOnProjectSwitch;
		expect(meta).toBeDefined();
		expect(meta.labelZh).toContain("切换项目");
		expect(meta.labelEn).toContain("Project Switch");
	});

	it("预设净化支持 openRecentSessionOnProjectSwitch 的导出与导入", () => {
		const input = {
			openRecentSessionOnProjectSwitch: false,
			unknownGarbageField: "should be stripped",
		};
		const sanitized = sanitizePresetSettings(input);
		expect(sanitized.fields).toContain("openRecentSessionOnProjectSwitch");
		expect(sanitized.settings.openRecentSessionOnProjectSwitch).toBe(false);
		expect(sanitized.ignored).toContain("unknownGarbageField");
	});
});
