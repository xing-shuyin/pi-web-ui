import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	DEFAULT_CHAT_WIDTH_SETTINGS,
	normalizeChatWidthSettings,
	DEFAULT_HIDE_MODEL_ROW_SETTINGS,
	normalizeHideModelRowSettings,
} from "../../web/src/chat-width-settings.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CSS = readFileSync(join(ROOT, "web", "src", "styles.css"), "utf8");

describe("normalizeChatWidthSettings", () => {
	it("非对象回退默认（默认关闭）", () => {
		expect(normalizeChatWidthSettings(null)).toEqual(DEFAULT_CHAT_WIDTH_SETTINGS);
		expect(normalizeChatWidthSettings(undefined)).toEqual(DEFAULT_CHAT_WIDTH_SETTINGS);
		expect(normalizeChatWidthSettings("yes")).toEqual(DEFAULT_CHAT_WIDTH_SETTINGS);
		expect(normalizeChatWidthSettings(1)).toEqual(DEFAULT_CHAT_WIDTH_SETTINGS);
	});

	it("保留合法的布尔值", () => {
		expect(normalizeChatWidthSettings({ wide: true })).toEqual({ wide: true });
		expect(normalizeChatWidthSettings({ wide: false })).toEqual({ wide: false });
	});

	it("字段类型错误/缺失回退默认", () => {
		expect(normalizeChatWidthSettings({ wide: "yes" })).toEqual(DEFAULT_CHAT_WIDTH_SETTINGS);
		expect(normalizeChatWidthSettings({ wide: 1 })).toEqual(DEFAULT_CHAT_WIDTH_SETTINGS);
		expect(normalizeChatWidthSettings({})).toEqual(DEFAULT_CHAT_WIDTH_SETTINGS);
		expect(normalizeChatWidthSettings({ other: false })).toEqual(DEFAULT_CHAT_WIDTH_SETTINGS);
	});
});

describe("normalizeHideModelRowSettings", () => {
	it("非对象回退默认（默认关闭）", () => {
		expect(normalizeHideModelRowSettings(null)).toEqual(DEFAULT_HIDE_MODEL_ROW_SETTINGS);
		expect(normalizeHideModelRowSettings(undefined)).toEqual(DEFAULT_HIDE_MODEL_ROW_SETTINGS);
		expect(normalizeHideModelRowSettings("yes")).toEqual(DEFAULT_HIDE_MODEL_ROW_SETTINGS);
		expect(normalizeHideModelRowSettings(1)).toEqual(DEFAULT_HIDE_MODEL_ROW_SETTINGS);
	});

	it("保留合法的布尔值", () => {
		expect(normalizeHideModelRowSettings({ hide: true })).toEqual({ hide: true });
		expect(normalizeHideModelRowSettings({ hide: false })).toEqual({ hide: false });
	});

	it("字段类型错误/缺失回退默认", () => {
		expect(normalizeHideModelRowSettings({ hide: "yes" })).toEqual(DEFAULT_HIDE_MODEL_ROW_SETTINGS);
		expect(normalizeHideModelRowSettings({ hide: 1 })).toEqual(DEFAULT_HIDE_MODEL_ROW_SETTINGS);
		expect(normalizeHideModelRowSettings({})).toEqual(DEFAULT_HIDE_MODEL_ROW_SETTINGS);
		expect(normalizeHideModelRowSettings({ other: false })).toEqual(DEFAULT_HIDE_MODEL_ROW_SETTINGS);
	});

	it("styles.css 包含 .main.hide-model-row 的模型名字行隐藏与紧凑间距规则", () => {
		expect(CSS).toMatch(/\.main\.hide-model-row\s+\.msg-assistant\s+\.msg-meta\s*\{[^}]*display:\s*none/s);
		expect(CSS).toMatch(/\.main\.hide-model-row\s+\.msg-assistant\s*\+\s*\.msg-assistant\s*\{[^}]*padding-top:\s*0/s);
	});
});
