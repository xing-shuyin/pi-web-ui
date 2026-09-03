import { describe, expect, it } from "vitest";
import { encodeTerminalKey } from "../../server/terminals.js";

/** 字节级断言 —— 命名键按名称路由，Ctrl/Alt 组合绝不回退成 “Ctrl+首字母”。 */
describe("encodeTerminalKey", () => {
	it("普通字符原样发送", () => {
		expect(encodeTerminalKey("a")).toEqual({ data: "a" });
	});

	it("Enter / Tab / Escape", () => {
		expect(encodeTerminalKey("Enter")).toEqual({ data: "\r" });
		expect(encodeTerminalKey("Tab")).toEqual({ data: "\t" });
		expect(encodeTerminalKey("Escape")).toEqual({ data: "\x1b" });
	});

	it("方向键无修饰符", () => {
		expect(encodeTerminalKey("ArrowUp")).toEqual({ data: "\x1b[A" });
		expect(encodeTerminalKey("ArrowDown")).toEqual({ data: "\x1b[B" });
	});

	it("Ctrl+ArrowUp = ESC[1;5A（不是 Ctrl+A）", () => {
		expect(encodeTerminalKey("ArrowUp", { ctrl: true })).toEqual({
			data: "\x1b[1;5A",
		});
	});

	it("Ctrl+Enter = CSI-u 13;5（不是 Ctrl+E）", () => {
		expect(encodeTerminalKey("Enter", { ctrl: true })).toEqual({
			data: "\x1b[13;5u",
		});
	});

	it("普通字符 Ctrl 映射 A–Z → 0x01–0x1A", () => {
		expect(encodeTerminalKey("c", { ctrl: true })).toEqual({ data: "\x03" });
		expect(encodeTerminalKey("u", { ctrl: true })).toEqual({ data: "\x15" });
	});

	it("Alt 前缀 ESC；Shift 大写", () => {
		expect(encodeTerminalKey("x", { alt: true })).toEqual({ data: "\x1bx" });
		expect(encodeTerminalKey("x", { shift: true })).toEqual({ data: "X" });
	});

	it("修饰符叠加：xterm 修饰序列 ESC[1;<m>H（无修饰符保持 ESC[H）", () => {
		const home = (m: object) => (encodeTerminalKey("Home", m as never) as { data?: string }).data;
		expect(home({})).toBe("\x1b[H");
		expect(home({ shift: true })).toBe("\x1b[1;2H");
		expect(home({ alt: true })).toBe("\x1b[1;3H");
		expect(home({ ctrl: true })).toBe("\x1b[1;5H");
		expect(home({ ctrl: true, shift: true })).toBe("\x1b[1;6H");
		expect(home({ ctrl: true, alt: true })).toBe("\x1b[1;7H");
		expect(home({ ctrl: true, alt: true, shift: true })).toBe("\x1b[1;8H");
	});

	it("不支持的按键返回 error", () => {
		const a = encodeTerminalKey("F13");
		const b = encodeTerminalKey("");
		expect("error" in a && a.error).toBeTruthy();
		expect("error" in b && b.error).toBeTruthy();
	});
});
