import { describe, expect, it } from "vitest";
import { IME_COMPOSITION_END_GRACE_MS, isImeComposingKey } from "../../web/src/ime-guard.js";

/**
 * issue #560 / #248：macOS 中文输入法（鼠须管）在编码态敲 Enter 是「上屏」而非「提交」。
 * 本判定是聊天输入框与 ask_user_question 问卷输入框共用的单源，两条漏判路径都要覆盖。
 */
describe("isImeComposingKey", () => {
	it("组合态回车（isComposing=true）判定为上屏", () => {
		// Chromium 实测：Input.imeSetComposition 之后按 Enter → key=Enter/keyCode=13/isComposing=true
		expect(isImeComposingKey({ isComposing: true, keyCode: 13 }, 0, 1_000)).toBe(true);
	});

	it("keyCode 229（IME 正在处理该按键）判定为上屏", () => {
		expect(isImeComposingKey({ isComposing: false, keyCode: 229 }, 0, 1_000)).toBe(true);
	});

	it("compositionend 刚结束时那个 isComposing=false 的 Enter（macOS 变体）判定为上屏", () => {
		const compositionEnd = 1_000;
		// 紧随其后（同一时刻）的 Enter：只看 isComposing 会漏，靠时间窗拦住
		expect(isImeComposingKey({ isComposing: false, keyCode: 13 }, compositionEnd, compositionEnd)).toBe(true);
		// 窗口内
		expect(isImeComposingKey({ isComposing: false, keyCode: 13 }, compositionEnd, compositionEnd + 49)).toBe(true);
	});

	it("超出 50ms 窗口的常规回车放行（不能把正常提交也拦掉）", () => {
		const compositionEnd = 1_000;
		expect(isImeComposingKey({ isComposing: false, keyCode: 13 }, compositionEnd, compositionEnd + 50)).toBe(false);
		expect(isImeComposingKey({ isComposing: false, keyCode: 13 }, compositionEnd, compositionEnd + 5_000)).toBe(false);
	});

	it("从未发生过 compositionend（时间戳 0）时不误拦首次按键", () => {
		// 关键边界：不能拿 Date.now() 初始化，否则 now - 0 永远大于窗口之外……
		// 反过来 0 若被当作「刚刚结束」会把所有按键都拦掉。
		expect(isImeComposingKey({ isComposing: false, keyCode: 13 }, 0, 1_700_000_000_000)).toBe(false);
		expect(isImeComposingKey({ isComposing: false, keyCode: 13 })).toBe(false);
	});

	it("grace 窗口常量就是 50ms（两端各测一次，锁住契约）", () => {
		expect(IME_COMPOSITION_END_GRACE_MS).toBe(50);
		const t = 1_000;
		expect(isImeComposingKey({ isComposing: false, keyCode: 13 }, t, t + IME_COMPOSITION_END_GRACE_MS - 1)).toBe(true);
		expect(isImeComposingKey({ isComposing: false, keyCode: 13 }, t, t + IME_COMPOSITION_END_GRACE_MS)).toBe(false);
	});

	it("普通按键（非 Enter、无组合态）一律放行", () => {
		expect(isImeComposingKey({ isComposing: false, keyCode: 65 }, 0, 1_000)).toBe(false);
		expect(isImeComposingKey({ isComposing: false, keyCode: 13 })).toBe(false);
	});
});
