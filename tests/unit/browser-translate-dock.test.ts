import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const DOCK_JS = readFileSync(new URL("../../browser/renderer/dock.js", import.meta.url), "utf8");
const TRANSLATE_JS = readFileSync(new URL("../../browser/renderer/translate.js", import.meta.url), "utf8");

describe("全文翻译入口收进 Dock 展开菜单", () => {
	it("翻译页不再自建悬浮按钮，进度靠 getState/onState 对外发布", () => {
		// 独立徽标按钮和 Dock 重叠且没有进度反馈，入口收进 Dock 后就删掉它
		expect(TRANSLATE_JS).not.toContain("pi-translate-badge");
		expect(TRANSLATE_JS).toContain("getState");
		expect(TRANSLATE_JS).toContain("onState");
		// 分段进度：done/total/failed，供 Dock 的 title 与 Toast 用
		expect(TRANSLATE_JS).toContain("total");
		expect(TRANSLATE_JS).toContain("failed");
	});

	it("Dock 展开菜单里有翻译入口：点火 + 进度 + 完成/失败反馈", () => {
		expect(DOCK_JS).toContain("btn-translate");
		expect(DOCK_JS).toContain("__PI_TRANSLATE__");
		expect(DOCK_JS).toContain("togglePage");
		// 点下去立刻有反馈，翻译中再点只报进度不重复开工
		expect(DOCK_JS).toContain("正在翻译全文");
		expect(DOCK_JS).toContain("翻译进行中");
		expect(DOCK_JS).toContain("翻译完成");
		expect(DOCK_JS).toContain("翻译失败，请重试");
	});

	it("翻完一段立刻回填一段：小分段 + 有限并发，不等全翻完", () => {
		expect(TRANSLATE_JS).toContain("BATCH_CHARS = 1200");
		expect(TRANSLATE_JS).toContain("BATCH_CONCURRENCY = 3");
		expect(TRANSLATE_JS).toContain("Promise.all(workers)");
	});

	it("五个按钮能展开下，翻译中按钮有呼吸态", () => {
		// 展开上限默认 230px ≥ 5 个 32px 钮 + 4 个 6px 间距（184px）；窗口矮时上限被压小并可滚
		expect(DOCK_JS).toContain("var(--dock-menu-max, 230px)");
		expect(DOCK_JS).toContain("--dock-menu-max");
		expect(DOCK_JS).toContain("dock-sub-btn.busy");
		expect(DOCK_JS).toContain("dock-pulse");
	});

	it("Dock 仍只用 createElement 建 UI（Trusted Types 站点也能建出按钮）", () => {
		expect(DOCK_JS).not.toMatch(/\.innerHTML\s*=/);
		expect(TRANSLATE_JS).not.toContain("pi-translate-badge");
	});
});
