import { describe, expect, it } from "vitest";
import { IME_COMPOSITION_END_GRACE_MS, isImeComposingKey } from "../../web/src/ime-guard.js";

describe("isImeComposingKey", () => {
	it("组合态回车（isComposing=true）判定为上屏", () => {
		expect(isImeComposingKey({ isComposing: true, keyCode: 13 }, 0, 1_000)).toBe(true);
	});

	it("keyCode 229（IME 正在处理该按键）判定为上屏", () => {
		expect(isImeComposingKey({ isComposing: false, keyCode: 229 }, 0, 1_000)).toBe(true);
	});

	it("compositionend 刚结束时那个 isComposing=false 的 Enter（macOS 变体）判定为上屏", () => {
		const compositionEnd = 1_000;
		expect(isImeComposingKey({ isComposing: false, keyCode: 13 }, compositionEnd, compositionEnd)).toBe(true);
		expect(isImeComposingKey({ isComposing: false, keyCode: 13 }, compositionEnd, compositionEnd + 49)).toBe(true);
	});

	it("超出 50ms 窗口的常规回车放行（不能把正常提交也拦掉）", () => {
		const compositionEnd = 1_000;
		expect(isImeComposingKey({ isComposing: false, keyCode: 13 }, compositionEnd, compositionEnd + 50)).toBe(false);
		expect(isImeComposingKey({ isComposing: false, keyCode: 13 }, compositionEnd, compositionEnd + 5_000)).toBe(false);
	});

	it("从未发生过 compositionend（时间戳 0）时不误拦首次按键", () => {
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
