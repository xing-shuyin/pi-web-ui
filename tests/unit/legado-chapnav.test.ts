/**
 * legado-web 阅读页「章末导航」纯逻辑单测（插件内嵌前端的核心判断，见
 * plugins/legado-web/app/src/core/chapnav.ts）。
 *
 * 背景：阅读页原来只有顶部工具栏有「上一章 / 下一章」，正文读到页面底部什么都没有，
 * 想把这一章看完接着往下读只能滚回顶部。现在正文末尾补一条章末导航（上一章 / 目录 /
 * 下一章），这里钉住它的边界：第一章不给上一章、最后一章不给下一章并明说「已是最后
 * 一章」、空目录给重拉提示。
 */
import { describe, expect, it } from "vitest";
import { chapterNavState } from "../../plugins/legado-web/app/src/core/chapnav";

describe("chapterNavState（章末导航）", () => {
	it("第一章：上一章不可点，下一章可点，说明写第 1/总 章", () => {
		const s = chapterNavState(0, 10, "剑来");
		expect(s.canPrev).toBe(false);
		expect(s.canNext).toBe(true);
		expect(s.note).toBe("《剑来》· 第 1/10 章");
	});

	it("中间章：两个方向都可点", () => {
		const s = chapterNavState(4, 10, "剑来");
		expect(s).toEqual({ canPrev: true, canNext: true, note: "《剑来》· 第 5/10 章" });
	});

	it("最后一章：下一章不可点，并明说「已是最后一章」", () => {
		const s = chapterNavState(9, 10, "剑来");
		expect(s.canNext).toBe(false);
		expect(s.canPrev).toBe(true);
		expect(s.note).toBe("《剑来》· 第 10/10 章 · 已是最后一章");
	});

	it("单章书：两个方向都不可点", () => {
		const s = chapterNavState(0, 1, "独章");
		expect(s.canPrev).toBe(false);
		expect(s.canNext).toBe(false);
		expect(s.note).toBe("《独章》· 第 1/1 章 · 已是最后一章");
	});

	it("空目录：不画可点方向，提示用顶部「刷新」重拉目录", () => {
		const s = chapterNavState(0, 0, "剑来");
		expect(s).toEqual({ canPrev: false, canNext: false, note: "目录为空 —— 用顶部「刷新」重拉目录" });
	});

	it("书名原样进 note（转义由调用方按 DOM 插值做）", () => {
		expect(chapterNavState(1, 3, "A & B <x>").note).toBe("《A & B <x>》· 第 2/3 章");
	});
});
