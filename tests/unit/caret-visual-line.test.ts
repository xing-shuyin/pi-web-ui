// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { caretRowFlags, caretVisualLineFlags, logicalLineFlags } from "../../web/src/caret-visual-line.js";

/**
 * 输入框光标「视觉行」判定单测（issue #127）。
 *
 * jsdom 没有布局引擎（offsetTop/clientWidth 恒 0），所以这里锁的是**纯函数**与
 * **无布局时的回落**：真正的折行判定由 tests/composer-history-test.mjs 在真浏览器里锁。
 */

const makeTa = (value: string, start = value.length, end = start): HTMLTextAreaElement => {
	const ta = document.createElement("textarea");
	ta.value = value;
	ta.selectionStart = start;
	ta.selectionEnd = end;
	document.body.appendChild(ta);
	return ta;
};

describe("caretRowFlags", () => {
	it("光标标记贴顶 → 首视觉行", () => {
		expect(caretRowFlags(0, 46)).toEqual({ first: true, last: false });
	});
	it("光标标记与文末标记同高 → 末视觉行（但不在首行）", () => {
		expect(caretRowFlags(46, 46)).toEqual({ first: false, last: true });
	});
	it("单行文本：首末都是它", () => {
		expect(caretRowFlags(0, 0)).toEqual({ first: true, last: true });
	});
	it("中间视觉行：都不是", () => {
		expect(caretRowFlags(23, 69)).toEqual({ first: false, last: false });
	});
	it("容差吸收 offsetTop 取整误差（1px 内当作同一行）", () => {
		expect(caretRowFlags(0, 1).last).toBe(true);
		expect(caretRowFlags(0, 23).last).toBe(false);
	});
});

describe("logicalLineFlags", () => {
	it("没有换行 → 首末都为真", () => {
		expect(logicalLineFlags("一段很长但没有换行的文本", 5)).toEqual({ first: true, last: true });
	});
	it("光标在首行 → first 为真、last 为假", () => {
		expect(logicalLineFlags("aaa\nbbb", 1)).toEqual({ first: true, last: false });
	});
	it("光标在末行 → last 为真、first 为假", () => {
		expect(logicalLineFlags("aaa\nbbb", 5)).toEqual({ first: false, last: true });
	});
	it("光标在中间行 → 都不是", () => {
		expect(logicalLineFlags("aaa\nbbb\nccc", 5)).toEqual({ first: false, last: false });
	});
	it("空文本 → 首末都为真（空输入框按 ↑ 仍翻历史）", () => {
		expect(logicalLineFlags("", 0)).toEqual({ first: true, last: true });
	});
});

describe("caretVisualLineFlags（无布局宿主 → 回落逻辑行）", () => {
	it("自动折行长文本（jsdom 量不到布局）按旧逻辑判成首/末行 —— 与改动前一致，不误判", () => {
		const long = "这是一段很长的、在真浏览器里一定会自动折行的文本".repeat(3);
		expect(caretVisualLineFlags(makeTa(long))).toEqual({ first: true, last: true });
	});

	it("真实换行的中间行仍然是『不许翻历史』（量不到布局也不会退化成允许）", () => {
		expect(caretVisualLineFlags(makeTa("a\nb\nc", 2))).toEqual({ first: false, last: false });
	});

	it("有选区：不翻历史（交给浏览器扩展选区）", () => {
		expect(caretVisualLineFlags(makeTa("a\nb", 0, 2))).toEqual({ first: false, last: false });
	});

	it("空输入框：首末都为真", () => {
		expect(caretVisualLineFlags(makeTa(""))).toEqual({ first: true, last: true });
	});

	it("测量节点复用：挂在 body 上的隐藏镜像节点可被识别（不重复创建 / 不写正文）", () => {
		const long = "x".repeat(500);
		caretVisualLineFlags(makeTa(long));
		caretVisualLineFlags(makeTa(long));
		const mirrors = document.querySelectorAll("body > div[data-caret-mirror]");
		expect(mirrors.length).toBe(1);
		expect(mirrors[0].textContent).toBe("");
	});
});
