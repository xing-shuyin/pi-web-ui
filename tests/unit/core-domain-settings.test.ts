import { describe, expect, it } from "vitest";
import {
	DEFAULT_KEEP_RECENT_MESSAGES,
	DEFAULT_RETRY_MAX_ATTEMPTS,
	normalizeUiLayout,
} from "../../server/client-state.js";
import type { ClientSettings } from "../../server/client-state.js";
import type { StatePort } from "../../server/core/contracts/ports.js";
import {
	applySettingsPatch,
	buildSettingsView,
	CLIENT_SETTINGS_KEYS,
	SettingsStore,
	settingsStateKey,
} from "../../server/core/domains/settings/index.js";

const VIEW_KEYS = [
	"bgAutoCleanupMin",
	"codemodeInlineBudget",
	"codemodeMode",
	"disabledPluginTools",
	"followUpMode",
	"keepRecentMessages",
	"promptDisabled",
	"promptOverrides",
	"retryMaxAttempts",
	"skillsCatalogBudget",
	"skillsCatalogMaxDesc",
	"skillsFullText",
	"skillsFullTextMaxBytes",
	"skillsMaxFileBytes",
	"steeringMode",
	"subagentAutoWakeMaxTurns",
	"toolWatchdogTimeoutMs",
	"uiLayout",
];

/** 客户端可能送来任意 JSON：类型闸门就是为这些越界输入准备的。 */
function rawPatch(raw: Record<string, unknown>): Partial<ClientSettings> {
	return raw as unknown as Partial<ClientSettings>;
}

class FakeState implements StatePort {
	readonly data = new Map<string, unknown>();
	readonly writes: { key: string; value: unknown }[] = [];

	read(key: string): unknown {
		return this.data.get(key);
	}

	write(key: string, value: unknown): void {
		this.writes.push({ key, value });
		this.data.set(key, value);
	}

	seed(key: string, value: unknown): void {
		this.data.set(key, value);
	}
}

describe("domains/settings · buildSettingsView", () => {
	it("视图键名与 ClientSettings 逐字一致，且只包含声明过的字段", () => {
		const view = buildSettingsView({ current: {} });
		expect(Object.keys(view).sort()).toEqual(VIEW_KEYS);
	});

	it("无补丁时按当前生效值投影", () => {
		const view = buildSettingsView({ current: { keepRecentMessages: 42, retryMaxAttempts: 3 } });
		expect(view.keepRecentMessages).toBe(42);
		expect(view.retryMaxAttempts).toBe(3);
	});

	it("后一个补丁覆盖前一个", () => {
		const view = buildSettingsView({
			current: { keepRecentMessages: 10 },
			patches: [{ keepRecentMessages: 20 }, { keepRecentMessages: 30 }],
		});
		expect(view.keepRecentMessages).toBe(30);
	});

	it("undefined 的补丁值不覆盖已有值", () => {
		const view = buildSettingsView({
			current: { keepRecentMessages: 42 },
			patches: [{ keepRecentMessages: 30 }, { keepRecentMessages: undefined }],
		});
		expect(view.keepRecentMessages).toBe(30);
	});

	it("补丁值类型不符时回落当前值，不抛", () => {
		const view = buildSettingsView({
			current: { keepRecentMessages: 42 },
			patches: [rawPatch({ keepRecentMessages: "abc" })],
		});
		expect(view.keepRecentMessages).toBe(42);
	});

	it("类型相符但越界：交给单源 normalize* 收敛", () => {
		const view = buildSettingsView({
			current: {},
			patches: [{ keepRecentMessages: 999, retryMaxAttempts: -5 }],
		});
		expect(view.keepRecentMessages).toBe(100);
		expect(view.retryMaxAttempts).toBe(0);
	});

	it("当前值本身是脏数据时同样归一化，不抛", () => {
		const view = buildSettingsView({ current: rawPatch({ keepRecentMessages: "abc", retryMaxAttempts: null }) });
		expect(view.keepRecentMessages).toBe(DEFAULT_KEEP_RECENT_MESSAGES);
		expect(view.retryMaxAttempts).toBe(DEFAULT_RETRY_MAX_ATTEMPTS);
	});

	it("promptOverrides 的非法 token 由单源剔掉", () => {
		const view = buildSettingsView({
			current: {},
			patches: [{ promptOverrides: { tools: "工具段", bogus: "不存在" } }],
		});
		expect(view.promptOverrides).toEqual({ tools: "工具段" });
	});

	it("promptOverrides 不是字符串字典时回落当前值", () => {
		const view = buildSettingsView({
			current: { promptOverrides: { append: "保留" } },
			patches: [rawPatch({ promptOverrides: ["tools"] })],
		});
		expect(view.promptOverrides).toEqual({ append: "保留" });
	});

	it("promptDisabled 走单源：非法 token 被剔掉并补回 plugin_dev", () => {
		const view = buildSettingsView({
			current: { promptDisabled: [] },
			patches: [{ promptDisabled: ["tools", "bogus"] }],
		});
		expect(view.promptDisabled).toEqual(["tools", "plugin_dev"]);
	});

	it("枚举字段类型不符回落当前值，合法值照常生效", () => {
		const current = { steeringMode: "one-at-a-time" as const };
		expect(buildSettingsView({ current, patches: [rawPatch({ steeringMode: 5 })] }).steeringMode).toBe("one-at-a-time");
		expect(buildSettingsView({ current, patches: [{ steeringMode: "all" }] }).steeringMode).toBe("all");
	});

	it("uiLayout 非对象时回落当前值，并交给单源归一化", () => {
		const current = { uiLayout: { hidden: ["host:x"] } };
		expect(buildSettingsView({ current, patches: [rawPatch({ uiLayout: [] })] }).uiLayout).toEqual(
			normalizeUiLayout(current.uiLayout),
		);
	});

	it("空补丁序列 = 当前值归一化后的结果", () => {
		const current = { keepRecentMessages: 42 };
		expect(buildSettingsView({ current, patches: [] })).toEqual(buildSettingsView({ current }));
	});
});

describe("domains/settings · applySettingsPatch", () => {
	it("增 / 改 ClientSettings 的键，并在 changed 里按补丁顺序报出来", () => {
		const result = applySettingsPatch(
			{ keepRecentMessages: 20 },
			{ keepRecentMessages: 30, steeringMode: "one-at-a-time" },
		);
		expect(result.changed).toEqual(["keepRecentMessages", "steeringMode"]);
		expect(result.next.keepRecentMessages).toBe(30);
		expect(result.next.steeringMode).toBe("one-at-a-time");
	});

	it("未知键计入 ignored，且不写进 next", () => {
		const result = applySettingsPatch({ keepRecentMessages: 20 }, rawPatch({ nope: 1, keepRecentMessages: 20 }));
		expect(result.ignored).toEqual(["nope"]);
		expect("nope" in result.next).toBe(false);
		expect(result.changed).toEqual([]);
	});

	it("值未真的变化不进 changed：对象键顺序不同也算相同", () => {
		const result = applySettingsPatch(
			{ promptOverrides: { append: "a", tools: "b" } },
			{ promptOverrides: { tools: "b", append: "a" } },
		);
		expect(result.changed).toEqual([]);
	});

	it("数组按结构比较：同内容不算变化，内容不同才算", () => {
		const current = { skillsFullText: ["alpha", "beta"] };
		expect(applySettingsPatch(current, { skillsFullText: ["alpha", "beta"] }).changed).toEqual([]);
		const result = applySettingsPatch(current, { skillsFullText: ["alpha", "gamma"] });
		expect(result.changed).toEqual(["skillsFullText"]);
		expect(result.next.skillsFullText).toEqual(["alpha", "gamma"]);
	});

	it("undefined 不覆盖已有值，也不算变化", () => {
		const result = applySettingsPatch({ keepRecentMessages: 20 }, { keepRecentMessages: undefined });
		expect(result.changed).toEqual([]);
		expect(result.next.keepRecentMessages).toBe(20);
	});

	it("空补丁不动任何键", () => {
		const current = { keepRecentMessages: 20, steeringMode: "all" as const };
		const result = applySettingsPatch(current, {});
		expect(result.changed).toEqual([]);
		expect(result.ignored).toEqual([]);
		expect(result.next).toEqual(current);
	});

	it("纯函数：不修改入参", () => {
		const current = { keepRecentMessages: 20, promptOverrides: { append: "a" } };
		const before = structuredClone(current);
		applySettingsPatch(current, { keepRecentMessages: 30, promptOverrides: { append: "b" } });
		expect(current).toEqual(before);
	});

	it("ClientSettings 键表包含可选键，且不含任意字符串", () => {
		expect(CLIENT_SETTINGS_KEYS.has("keepRecentMessages")).toBe(true);
		expect(CLIENT_SETTINGS_KEYS.has("devNoCache")).toBe(true);
		expect(CLIENT_SETTINGS_KEYS.has("bogus")).toBe(false);
	});
});

describe("domains/settings · SettingsStore", () => {
	it("load 经注入的 StatePort 读取已落盘值，并剔掉未知键", () => {
		const state = new FakeState();
		state.seed(settingsStateKey("c1"), { keepRecentMessages: 42, nope: 1 });
		const { settings, view } = new SettingsStore(state).load("c1");
		expect(settings.keepRecentMessages).toBe(42);
		expect("nope" in settings).toBe(false);
		expect(view.keepRecentMessages).toBe(42);
	});

	it("save 只把变更键写进注入的 StatePort", () => {
		const state = new FakeState();
		new SettingsStore(state).save("c1", { keepRecentMessages: 42 });
		expect(state.writes).toEqual([{ key: settingsStateKey("c1"), value: { keepRecentMessages: 42 } }]);
		expect(state.read(settingsStateKey("c1"))).toEqual({ keepRecentMessages: 42 });
	});

	it("多次 save 累积落盘，不把默认值整份抄进去", () => {
		const state = new FakeState();
		const store = new SettingsStore(state);
		store.save("c1", { keepRecentMessages: 42 });
		store.save("c1", { steeringMode: "one-at-a-time" });
		expect(state.read(settingsStateKey("c1"))).toEqual({ keepRecentMessages: 42, steeringMode: "one-at-a-time" });
	});

	it("version 随真实变更单调递增，值未变 / 空补丁不升", () => {
		const state = new FakeState();
		const store = new SettingsStore(state);
		expect(store.version()).toBe(0);
		store.save("c1", { keepRecentMessages: 42 });
		expect(store.version()).toBe(1);
		store.save("c1", { keepRecentMessages: 42 });
		expect(store.version()).toBe(1);
		store.save("c1", {});
		expect(store.version()).toBe(1);
		store.save("c1", { steeringMode: "one-at-a-time" });
		expect(store.version()).toBe(2);
	});

	it("空补丁与全未知键都不写盘", () => {
		const state = new FakeState();
		const store = new SettingsStore(state);
		expect(store.save("c1", {}).changed).toEqual([]);
		const ignored = store.save("c1", rawPatch({ nope: 1 }));
		expect(ignored.ignored).toEqual(["nope"]);
		expect(state.writes).toEqual([]);
	});

	it("load 不动版本号", () => {
		const state = new FakeState();
		const store = new SettingsStore(state);
		store.load("c1");
		store.load("c2");
		expect(store.version()).toBe(0);
	});

	it("不同 clientId 落盘键互相隔离", () => {
		const state = new FakeState();
		const store = new SettingsStore(state);
		store.save("c1", { keepRecentMessages: 42 });
		store.save("c2", { keepRecentMessages: 60 });
		expect(store.load("c1").settings.keepRecentMessages).toBe(42);
		expect(store.load("c2").settings.keepRecentMessages).toBe(60);
	});

	it("落盘原值、读时归一化：非法值不外泄到视图", () => {
		const state = new FakeState();
		const store = new SettingsStore(state);
		const saved = store.save("c1", rawPatch({ keepRecentMessages: "abc" }));
		expect(state.read(settingsStateKey("c1"))).toEqual({ keepRecentMessages: "abc" });
		expect(saved.view.keepRecentMessages).toBe(DEFAULT_KEEP_RECENT_MESSAGES);
	});
});
