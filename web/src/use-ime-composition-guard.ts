import { useRef } from "react";
import { isImeComposingKey, type ImeKeyLike } from "./ime-guard.js";

/**
 * React 侧持有「最近一次 compositionend 时间戳」的输入法守卫（issue #248 / #560）。
 *
 * 用法：
 * ```tsx
 * const imeGuard = useImeCompositionGuard();
 * <input
 *   onCompositionEnd={imeGuard.onCompositionEnd}
 *   onKeyDown={(e) => {
 *     if (imeGuard.isImeKey(e)) return; // 上屏用的回车，不是提交
 *     if (e.key === "Enter") submit();
 *   }}
 * />
 * ```
 *
 * 状态放 ref（不触发重渲）；判定逻辑本身在 `ime-guard.ts` 的纯函数里，便于单测。
 */
export function useImeCompositionGuard() {
	const compositionEndTsRef = useRef(0);
	return {
		/** 挂在 `onCompositionEnd` 上（仅记时间戳，不 preventDefault）。 */
		onCompositionEnd: () => {
			compositionEndTsRef.current = Date.now();
		},
		/** 该按键是否属于输入法上屏，应被提交/发送逻辑忽略。 */
		isImeKey: (e: ImeKeyLike) => isImeComposingKey(e, compositionEndTsRef.current),
	};
}
