import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ClientStateStore,
	DEFAULT_KEEP_RECENT_MESSAGES,
	KEEP_RECENT_MESSAGES_MAX,
	KEEP_RECENT_MESSAGES_MIN,
	normalizeKeepRecentMessages,
} from "../../server/client-state.js";
import { SettingsService, type SettingsHost } from "../../server/settings-service.js";

const roots: string[] = [];
function tempStore(): ClientStateStore {
	const dir = mkdtempSync(join(tmpdir(), "pi-keep-recent-"));
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
		clientId: "keep-recent-test",
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

describe("normalizeKeepRecentMessages", () => {
	it("缺省/脏值回落默认 15", () => {
		expect(normalizeKeepRecentMessages(undefined)).toBe(DEFAULT_KEEP_RECENT_MESSAGES);
		expect(normalizeKeepRecentMessages(null)).toBe(DEFAULT_KEEP_RECENT_MESSAGES);
		expect(normalizeKeepRecentMessages("")).toBe(DEFAULT_KEEP_RECENT_MESSAGES);
		expect(normalizeKeepRecentMessages("abc")).toBe(DEFAULT_KEEP_RECENT_MESSAGES);
		expect(normalizeKeepRecentMessages(NaN)).toBe(DEFAULT_KEEP_RECENT_MESSAGES);
		expect(normalizeKeepRecentMessages(Infinity)).toBe(DEFAULT_KEEP_RECENT_MESSAGES);
	});

	it("整数保留，浮点数向下取整，字符串解析", () => {
		expect(normalizeKeepRecentMessages(42)).toBe(42);
		expect(normalizeKeepRecentMessages("42")).toBe(42);
		expect(normalizeKeepRecentMessages(42.9)).toBe(42);
	});

	it("钳到 [5, 100]", () => {
		expect(normalizeKeepRecentMessages(KEEP_RECENT_MESSAGES_MIN)).toBe(KEEP_RECENT_MESSAGES_MIN);
		expect(normalizeKeepRecentMessages(KEEP_RECENT_MESSAGES_MAX)).toBe(KEEP_RECENT_MESSAGES_MAX);
		expect(normalizeKeepRecentMessages(KEEP_RECENT_MESSAGES_MIN - 1)).toBe(KEEP_RECENT_MESSAGES_MIN);
		expect(normalizeKeepRecentMessages(KEEP_RECENT_MESSAGES_MAX + 1)).toBe(KEEP_RECENT_MESSAGES_MAX);
		expect(normalizeKeepRecentMessages(-10)).toBe(KEEP_RECENT_MESSAGES_MIN);
	});
});

describe("ClientStateStore 持久化 keepRecentMessages", () => {
	it("新存档取默认值 15（与原硬编码 KEEP_RECENT=15 完全一致，默认行为不变）", () => {
		expect(DEFAULT_KEEP_RECENT_MESSAGES).toBe(15);
		expect(tempStore().getSettings("c").keepRecentMessages).toBe(DEFAULT_KEEP_RECENT_MESSAGES);
	});

	it("saveSettings 合并后可重读，且脏值被钳制", () => {
		const store = tempStore();
		store.saveSettings("c", { keepRecentMessages: 42 });
		expect(store.getSettings("c").keepRecentMessages).toBe(42);

		store.saveSettings("c", { keepRecentMessages: 999 });
		expect(store.getSettings("c").keepRecentMessages).toBe(KEEP_RECENT_MESSAGES_MAX);
		store.saveSettings("c", { keepRecentMessages: 1 });
		expect(store.getSettings("c").keepRecentMessages).toBe(KEEP_RECENT_MESSAGES_MIN);

		store.saveSettings("c", { keepRecentMessages: 42 });
		store.saveSettings("c", { thinkingWrap: true });
		expect(store.getSettings("c").keepRecentMessages).toBe(42);
	});
});

describe("SettingsService.set(keepRecentMessages)", () => {
	it("钳制后写入并随 settings_state 下发", async () => {
		const store = tempStore();
		const host = makeHost(store);
		const svc = new SettingsService(host, templates);

		await svc.set({ keepRecentMessages: 3 });
		expect(svc.current.keepRecentMessages).toBe(KEEP_RECENT_MESSAGES_MIN);
		await svc.set({ keepRecentMessages: 500 });
		expect(svc.current.keepRecentMessages).toBe(KEEP_RECENT_MESSAGES_MAX);

		const state = host.emitted.filter((m) => (m as { type?: string }).type === "settings_state").pop() as
			{ settings: { keepRecentMessages?: number } } | undefined;
		expect(state?.settings.keepRecentMessages).toBe(KEEP_RECENT_MESSAGES_MAX);
	});

	it("随预设保存与应用（上游白名单模型：与 thinkingWrap 等 UI 偏好同等待遇）", async () => {
		const store = tempStore();
		const host = makeHost(store);
		const svc = new SettingsService(host, templates);

		await svc.set({ keepRecentMessages: 25 });
		await svc.savePreset("ui-preset");
		const preset = store.getPresets("c").find((p) => p.name === "ui-preset");
		expect(preset).toBeDefined();
		expect((preset as { keepRecentMessages?: number }).keepRecentMessages).toBe(25);

		await svc.set({ keepRecentMessages: 12 });
		await svc.applyPreset("ui-preset");
		expect(svc.current.keepRecentMessages).toBe(25);
	});
});
