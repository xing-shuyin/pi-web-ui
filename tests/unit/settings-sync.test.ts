import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	MERGE_PATCH_KEYS,
	isPatchConfirmed,
	mergePatchValue,
	overlayPendingSettings,
	prunePendingSettings,
	reconcileOverrideDraft,
	releaseConfirmedDrafts,
	type PendingSettings,
} from "../../web/src/settings-sync.js";

const SETTINGS_SRC = readFileSync(join(__dirname, "..", "..", "web", "src", "components", "SettingsModal.tsx"), "utf8");

describe("设置补丁 overlay：map 字段必须按服务端合并语义叠加", () => {
	it("局部 promptOverrides 补丁不能抹掉其它 token", () => {
		const server = { promptOverrides: { soul: "灵魂 A", append: "追加 B" }, promptTemplate: "{{soul}}" };
		const pending: PendingSettings = { promptOverrides: { value: { append: "追加 C" }, prev: {}, at: Date.now() } };
		const merged = overlayPendingSettings(server, pending);
		expect(merged.promptOverrides).toEqual({ soul: "灵魂 A", append: "追加 C" });
		expect(merged.promptTemplate).toBe("{{soul}}");
	});

	it("空字符串补丁 = 服务端删除该 token", () => {
		const server = { promptOverrides: { soul: "灵魂 A", append: "追加 B" } };
		const pending: PendingSettings = {
			promptOverrides: { value: { soul: "" }, prev: { soul: "灵魂 A" }, at: Date.now() },
		};
		expect(overlayPendingSettings(server, pending).promptOverrides).toEqual({ append: "追加 B" });
	});

	it("非 map 字段整值替换（不做对象合并）", () => {
		const server = { uiLayout: { a: 1, b: 2 } };
		const pending: PendingSettings = { uiLayout: { value: { a: 9 }, prev: { a: 1, b: 2 }, at: Date.now() } };
		expect(overlayPendingSettings(server, pending).uiLayout).toEqual({ a: 9 });
	});

	it("同一字段的补丁再次到达：map 语义累加子键", () => {
		expect(mergePatchValue("promptOverrides", { soul: "A" }, { append: "B" })).toEqual({ soul: "A", append: "B" });
		expect(mergePatchValue("promptTemplate", "x", "y")).toBe("y");
		expect(MERGE_PATCH_KEYS.has("toolPromptOverrides")).toBe(true);
	});
});

describe("回执确认：只认服务端回执，不看本地期望", () => {
	it("局部 map 补丁逐子键确认：等值回执或服务端已变化才算生效", () => {
		const key = "promptOverrides";
		// 等值回执
		expect(isPatchConfirmed(key, { soul: "A", append: "B" }, { value: { soul: "A" }, prev: { soul: "旧" } })).toBe(
			true,
		);
		// 服务端被归一化/别人改过 → 视为已生效，不误报失败
		expect(isPatchConfirmed(key, { soul: "新" }, { value: { soul: "A" }, prev: { soul: "旧" } })).toBe(true);
		// 服务端没动 → 没生效
		expect(isPatchConfirmed(key, { soul: "旧", append: "B" }, { value: { soul: "A" }, prev: { soul: "旧" } })).toBe(
			false,
		);
		// 删除语义：服务端没有该子键 = 生效；还在 = 没生效
		expect(isPatchConfirmed(key, { append: "B" }, { value: { soul: "" }, prev: { soul: "旧" } })).toBe(true);
		expect(isPatchConfirmed(key, { soul: "旧" }, { value: { soul: "" }, prev: { soul: "旧" } })).toBe(false);
	});

	it("标量字段按值比较", () => {
		expect(isPatchConfirmed("promptTemplate", "{{soul}}", { value: "{{soul}}", prev: "" })).toBe(true);
		expect(isPatchConfirmed("promptTemplate", "", { value: "{{soul}}", prev: "" })).toBe(false);
	});

	it("服务端归一化（值变了但不是原样回执）算保存成功，只有完全没动才算失败", () => {
		expect(isPatchConfirmed("terminalBashIdleMs", 0, { value: -5, prev: 15000 })).toBe(true);
		expect(isPatchConfirmed("terminalBashIdleMs", 15000, { value: -5, prev: 15000 })).toBe(false);
	});

	it("未确认的补丁留在 pending，确认后才移除", () => {
		const pending: PendingSettings = {
			promptOverrides: { value: { soul: "A" }, at: 1, prev: {} },
			promptTemplate: { value: "{{soul}}", at: 2, prev: "" },
		};
		const stillStale = prunePendingSettings(pending, { promptOverrides: {}, promptTemplate: "{{soul}}" });
		expect(Object.keys(stillStale)).toEqual(["promptOverrides"]);
		const allConfirmed = prunePendingSettings(pending, { promptOverrides: { soul: "A" }, promptTemplate: "{{soul}}" });
		expect(Object.keys(allConfirmed)).toEqual([]);
	});
});

describe("草稿重建：本地占用（编辑中 / 未回执）绝不被服务端快照覆盖", () => {
	it("回归：编辑 A 后改 B，A 的草稿不能被抹掉", () => {
		const draft = { soul: "灵魂 MARK", append: "追加 NEW" };
		const next = reconcileOverrideDraft(draft, { soul: "灵魂 MARK" }, ["soul", "append"]);
		expect(next).toEqual({ soul: "灵魂 MARK", append: "追加 NEW" });
	});

	it("未被占用的 token 跟随服务端（外部改动 / 预设应用可见）", () => {
		const next = reconcileOverrideDraft({ soul: "旧" }, { soul: "新", append: "追加" }, []);
		expect(next).toEqual({ soul: "新", append: "追加" });
	});

	it("占用的 token 在服务端没有时仍保留（本地已清空 → 保持清空）", () => {
		expect(reconcileOverrideDraft({ soul: "" }, {}, ["soul"])).toEqual({ soul: "" });
	});

	it("回执一致才释放 dirty，否则继续占用", () => {
		const released = releaseConfirmedDrafts(["soul", "append"], { soul: "A", append: "B" }, { soul: "A" });
		expect([...released]).toEqual(["append"]);
		expect([...releaseConfirmedDrafts(new Set<string>(), {}, {})]).toEqual([]);
	});
});

describe("设置面板接线守卫（禁止退回“整块用服务端覆盖本地草稿”的写法）", () => {
	it("段落覆盖草稿走 reconcileOverrideDraft，且保留 dirty 集合", () => {
		expect(SETTINGS_SRC).toContain("reconcileOverrideDraft(prev, settings.promptOverrides, keepTokens)");
		expect(SETTINGS_SRC).toContain("releaseConfirmedDrafts(");
		expect(SETTINGS_SRC).toContain("overridesDirtyRef.current.add(tk)");
	});

	it("不再把局部 patch 当成整个 promptOverrides 重建草稿", () => {
		expect(SETTINGS_SRC).not.toContain("for (const [k, v] of Object.entries(settings.promptOverrides ?? {}))");
	});

	it("保存状态来自服务端回执（useSettingsSync），不再用定时器假装已保存", () => {
		expect(SETTINGS_SRC).toContain("useSettingsSync(");
		expect(SETTINGS_SRC).not.toContain('setSyncState("synced")');
		expect(SETTINGS_SRC).toContain("retryFailedSave");
	});

	it("「恢复默认模板并清空所有覆盖」逐 token 发空串（空对象补丁删不掉服务端覆盖）", () => {
		expect(SETTINGS_SRC).toContain("const clearing: Record<string, string> = {};");
		expect(SETTINGS_SRC).toContain("promptOverrides: clearing,");
		expect(SETTINGS_SRC).not.toContain("promptOverrides: {},");
	});

	it("覆盖编辑有自动落盘（不依赖 blur）+ 失焦提交", () => {
		expect(SETTINGS_SRC).toContain("scheduleOverrideCommit(tk)");
		expect(SETTINGS_SRC).toContain("commitOverride(tk)");
	});
});
