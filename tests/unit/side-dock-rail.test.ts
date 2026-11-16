import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CSS = readFileSync(fileURLToPath(new URL("../../web/src/styles.css", import.meta.url)), "utf8");
const DOCK_TSX = readFileSync(fileURLToPath(new URL("../../web/src/components/SideDock.tsx", import.meta.url)), "utf8");

/** 取出某个选择器的规则体（只取第一处，够用）。 */
function ruleBody(selector: string): string {
	const at = CSS.indexOf(`${selector} {`);
	if (at < 0) return "";
	const end = CSS.indexOf("\n\t}", at);
	return end < 0 ? "" : CSS.slice(at, end);
}

/**
 * 侧栏贯通列（SideDock）回归守卫。
 *
 * 背景：旧版把图标放进「贴边胶囊」，只声明 `overflow-y: auto` 会把另一轴从 `visible`
 * 计算成 `auto`，而 tooltip 伪元素是往侧向伸出的绝对定位元素 —— 竖向列表里因此冒出
 * 横向滚动条。这里把「贯通 + 不出现横向滚动 + tooltip 离开滚动容器」锁死。
 */
describe("侧栏贯通列（SideDock）", () => {
	it("列宽走 --side-dock-w 且不再 fit-content（贯通实体列，不是贴边胶囊）", () => {
		const body = ruleBody(".side-dock");
		expect(body).not.toBe("");
		expect(body).toContain("width: var(--side-dock-w, 56px)");
		expect(body).not.toContain("fit-content");
		// 胶囊造型（外框/阴影/毛玻璃）是割裂感的来源，栏本体不许再有
		expect(body).not.toContain("box-shadow");
		expect(body).not.toContain("backdrop-filter");
	});

	it("图标列两轴都显式声明：竖向可滚、横向 clip（不让滚动条冒出来）", () => {
		const body = ruleBody(".side-dock-seg");
		expect(body).toContain("overflow-y: auto");
		expect(body).toContain("overflow-x: clip");
	});

	it("不再用伪元素画 tooltip（会撑出横向滚动条），改走 .rail-tip 单例层", () => {
		expect(CSS).not.toContain(".side-dock-left [data-tip]::after");
		expect(CSS).not.toContain(".side-dock-right [data-tip]::after");
		expect(CSS).toContain(".rail-tip {");
		expect(DOCK_TSX).toContain('className="rail-tip"');
		// 浮层 z-index 走叠栈钩子，不写死
		expect(DOCK_TSX).toContain("useOverlayZIndex");
	});

	it("右侧 tooltip 不能被「left 到视口右缘」的剩余空间挤成折行", () => {
		// fixed 元素不写宽度时，浏览器按 left 到视口右缘计算 shrink-to-fit；
		// 右栏 tooltip 用 left = 图标左边 − 8 再 translate(-100%)，只剩几十像素 → 文字折行。
		const body = ruleBody(".rail-tip");
		expect(body).toContain("width: max-content");
		expect(body).toContain("max-width:");
	});

	it("旧版 70vh 浮标已移除（浮层不可能上下贯通）", () => {
		const body = ruleBody(".side-dock-float");
		expect(body).not.toBe("");
		expect(body).not.toContain("70vh");
		expect(body).not.toContain("position: fixed");
		expect(body).not.toContain("top: 50%");
	});

	it("触屏/窄屏有独立的列宽与命中区（手机版不吃掉内容宽度）", () => {
		const at = CSS.indexOf("@media (max-width: 768px) {\n\t\t.layout {\n\t\t\t--side-dock-w: 46px;");
		expect(at).toBeGreaterThan(0);
		const slice = CSS.slice(at, at + 900);
		expect(slice).toContain(".side-dock .bar-item");
		expect(slice).toContain("width: 38px");
	});
});
