/**
 * 输入框光标的「视觉行」判定（issue #127）。
 *
 * 输入框是自适应高度的 textarea：长文本按宽度自动折行后界面上是多行，但 value 里
 * 一个 `\n` 都没有。历史回溯（`↑`/`↓` 翻全局 prompt 历史）原先只看逻辑行（有没有
 * `\n`），于是「自动折行的长草稿」里按 `↑` 会直接跳到上一条历史，把正在编辑的内容
 * 打断 —— 用户预期的是普通多行文本框的光标上移。
 *
 * 判定方式：镜像测量。把与折行相关的样式（字体/行高/字距/white-space…）拷到一个
 * 隐藏 div 上，塞入「光标前的文本 + 一个零宽标记」，量标记的 `offsetTop`；div 与
 * textarea 的折行规则一致（`pre-wrap` + `break-word`），所以「上方还有没有视觉行」
 * 可以直接比像素：
 *   - 光标在首视觉行 ⇔ 光标标记的 offsetTop ≈ 0
 *   - 光标在末视觉行 ⇔ 光标标记的 offsetTop ≈ 全文末尾标记的 offsetTop
 *
 * 拿不到布局时（SSR / jsdom / 未挂载 / `display:none`）回落旧的逻辑行判定，行为
 * 与改动前完全一致 —— 宁可少一次「视觉行精确判定」，也不要误判成可以翻历史。
 */

export interface CaretLineFlags {
	/** 光标上方没有其他视觉行（`↑` 可以进历史） */
	first: boolean;
	/** 光标下方没有其他视觉行（`↓` 可以进历史） */
	last: boolean;
}

/** offsetTop 是取整像素；行高通常 ≥ 14px，1px 容差足以吸收取整误差。 */
const ROW_TOLERANCE = 1;

/** 零宽空格：让行尾标记在 pre-wrap 下真的占一个「折行点」，量得到 offsetTop。 */
const CARET_MARK = "\u200b";

/** 纯函数：按镜像测量的像素位置折算首/末视觉行。 */
export function caretRowFlags(caretTop: number, endTop: number, tolerance = ROW_TOLERANCE): CaretLineFlags {
	return { first: caretTop <= tolerance, last: Math.abs(endTop - caretTop) <= tolerance };
}

/** 纯函数：没有布局信息时的退路 —— 按逻辑行（`\n`）判定，即 issue #127 之前的行为。 */
export function logicalLineFlags(value: string, index: number): CaretLineFlags {
	return {
		first: !value.slice(0, index).includes("\n"),
		last: !value.slice(index).includes("\n"),
	};
}

let mirrorEl: HTMLDivElement | null = null;

/** 取（或重建）测量用的隐藏镜像 div。 */
function getMirror(): HTMLDivElement {
	if (mirrorEl?.isConnected) return mirrorEl;
	const el = document.createElement("div");
	el.setAttribute("aria-hidden", "true");
	el.setAttribute("data-caret-mirror", ""); // 便于 DevTools / 回归脚本识别这个测量节点
	const s = el.style;
	s.position = "fixed"; // 不参与文档流、不产生滚动条
	s.top = "0";
	s.left = "-99999px";
	s.visibility = "hidden"; // 仍然参与布局（display:none 就量不到了）
	s.pointerEvents = "none";
	s.margin = "0";
	s.padding = "0";
	s.border = "0";
	s.boxSizing = "content-box";
	s.overflow = "visible";
	document.body.appendChild(el);
	mirrorEl = el;
	return el;
}

/** 把 textarea 上影响折行的样式拷到镜像上；返回可用的内容宽度（≤0 表示量不了）。 */
function syncMirror(ta: HTMLTextAreaElement, el: HTMLDivElement): number {
	const cs = getComputedStyle(ta);
	const s = el.style;
	s.fontFamily = cs.fontFamily;
	s.fontSize = cs.fontSize;
	s.fontStyle = cs.fontStyle;
	s.fontWeight = cs.fontWeight;
	s.fontVariant = cs.fontVariant;
	s.fontStretch = cs.fontStretch;
	s.lineHeight = cs.lineHeight;
	s.letterSpacing = cs.letterSpacing;
	s.wordSpacing = cs.wordSpacing;
	s.textTransform = cs.textTransform;
	s.textIndent = cs.textIndent;
	s.tabSize = cs.tabSize;
	s.whiteSpace = cs.whiteSpace || "pre-wrap";
	s.overflowWrap = cs.overflowWrap || "break-word";
	s.wordBreak = cs.wordBreak || "normal";
	s.direction = cs.direction;
	s.writingMode = cs.writingMode;
	// textarea 的内容盒宽度（clientWidth 已排除纵向滚动条）。
	const width = ta.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
	if (!(width > 0)) return 0;
	s.width = `${width}px`;
	return width;
}

/** 量「prefix 末尾那个光标位置」在镜像里的 offsetTop。 */
function measureTop(el: HTMLDivElement, prefix: string): number {
	el.textContent = prefix;
	const mark = document.createElement("span");
	mark.textContent = CARET_MARK;
	el.appendChild(mark);
	return mark.offsetTop;
}

/**
 * 光标当前所在的视觉行位置：首行 / 末行两个布尔量。
 *
 * 有选区时两者都为 false（交给浏览器做选区扩展，不翻历史）——与改动前一致。
 */
export function caretVisualLineFlags(ta: HTMLTextAreaElement): CaretLineFlags {
	const value = ta.value;
	const index = ta.selectionStart;
	if (index !== ta.selectionEnd) return { first: false, last: false };
	const logical = logicalLineFlags(value, index);
	// 逻辑行本身就不在边界：那一定不在首/末视觉行，省掉测量（多行长文的常见路径）。
	if (!logical.first && !logical.last) return logical;
	if (typeof document === "undefined" || typeof getComputedStyle !== "function") return logical;
	const el = getMirror();
	if (syncMirror(ta, el) <= 0) return logical;
	const caretTop = measureTop(el, value.slice(0, index));
	const endTop = measureTop(el, value);
	// 没有布局引擎的宿主（jsdom / SSR / 未挂载元素）：offsetTop 恒为 0，会把任意位置
	// 都判成首行 —— 用镜像高度判掉，回落逻辑行。
	const measurable = el.offsetHeight > 0;
	el.textContent = ""; // 别把整份草稿留在镜像里
	if (!measurable && value !== "") return logical;
	return caretRowFlags(caretTop, endTop);
}
