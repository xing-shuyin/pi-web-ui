/**
 * 输入法（IME）回车判定 —— 全仓单源。
 *
 * 背景（issue #248 / #560）：macOS 中文输入法（鼠须管 / Squirrel、微信输入法等）在
 * 编码态下敲 Enter 是「把未上屏的编码原样上屏」，不是「提交」。浏览器有两条会漏判的
 * 路径：
 *   1. 组合期间的 keydown 带 `isComposing = true`（部分环境 keyCode 退化成 229）；
 *   2. **compositionend 之后紧跟一个 `isComposing = false` 的 Enter**（macOS 实测），
 *      此时只看 `isComposing` 会漏掉，文字刚上屏就误触发提交/发送。
 *
 * 三条判定合起来才安全：`isComposing` 覆盖路径 1，`keyCode === 229` 覆盖退化环境，
 * 「距 compositionend < 50ms」覆盖路径 2（时间窗由 `IME_COMPOSITION_END_GRACE_MS` 定）。
 *
 * 为什么不直接读事件：`compositionend` 与紧随其后的 `keydown` 是两个独立事件，判定需要
 * 「上一次 compositionend 的时间戳」这一跨事件状态。因此本模块只做**纯函数判定**，
 * 状态由调用方持有（`useImeCompositionGuard()` 是 React 侧的标准实现），
 * 这样单测可以传时间戳确定性地覆盖路径 2，不依赖真实计时。
 */

/** compositionend 之后仍视为「输入法上屏」的时间窗（毫秒）。 */
export const IME_COMPOSITION_END_GRACE_MS = 50;

/** 判定所需的最小事件形状（KeyboardEvent 天然满足，单测可传普通对象）。 */
export interface ImeKeyLike {
	/** `KeyboardEvent.isComposing`。 */
	isComposing?: boolean;
	/** 已废弃的 `KeyboardEvent.keyCode`：229 = IME 正在处理该按键。 */
	keyCode?: number;
}

/**
 * 这个按键是否属于输入法上屏（应当被提交/发送逻辑忽略）。
 *
 * @param e 键盘事件（或同形状对象）
 * @param lastCompositionEndTs 最近一次 compositionend 的时间戳（`Date.now()`）；
 *        从未发生过传 0/undefined
 * @param now 当前时间戳，默认 `Date.now()`（可注入以便单测）
 */
export function isImeComposingKey(e: ImeKeyLike, lastCompositionEndTs = 0, now = Date.now()): boolean {
	if (e.isComposing) return true;
	if (e.keyCode === 229) return true;
	// 时间窗只在「确实有过 compositionend」时生效：否则 `now - 0` 恒大于窗口，
	// 首次按键不会被误拦（这也是传 0 而不是 `Date.now()` 初始化的原因）。
	if (lastCompositionEndTs > 0 && now - lastCompositionEndTs < IME_COMPOSITION_END_GRACE_MS) return true;
	return false;
}
