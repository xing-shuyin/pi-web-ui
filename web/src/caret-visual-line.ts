interface CaretLineFlags {
	first: boolean;
	last: boolean;
}

function rowTolerance(ta: HTMLTextAreaElement): number {
	const lh = Number.parseFloat(getComputedStyle(ta).lineHeight) || 0;
	return lh > 0 ? Math.max(2, lh / 2) : 2;
}

const CARET_MARK = "\u200b";

export function caretRowFlags(caretTop: number, endTop: number, tolerance = 1): CaretLineFlags {
	return { first: caretTop <= tolerance, last: Math.abs(endTop - caretTop) <= tolerance };
}

export function logicalLineFlags(value: string, index: number): CaretLineFlags {
	return {
		first: !value.slice(0, index).includes("\n"),
		last: !value.slice(index).includes("\n"),
	};
}

let mirrorEl: HTMLDivElement | null = null;

function getMirror(): HTMLDivElement {
	if (mirrorEl?.isConnected) return mirrorEl;
	const el = document.createElement("div");
	el.setAttribute("aria-hidden", "true");
	el.setAttribute("data-caret-mirror", "");
	const s = el.style;
	s.position = "fixed";
	s.top = "0";
	s.left = "-99999px";
	s.visibility = "hidden";
	s.pointerEvents = "none";
	s.margin = "0";
	s.padding = "0";
	s.border = "0";
	// Must match the measured textarea: the app is global border-box (* rule),
	s.boxSizing = "border-box";
	s.overflow = "visible";
	document.body.appendChild(el);
	mirrorEl = el;
	return el;
}

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
	s.paddingLeft = cs.paddingLeft;
	s.paddingRight = cs.paddingRight;
	const width = ta.clientWidth;
	if (!(width > 0)) return 0;
	s.width = `${width}px`;
	return width;
}

function measureTop(el: HTMLDivElement, prefix: string): number {
	el.textContent = prefix;
	const mark = document.createElement("span");
	mark.textContent = CARET_MARK;
	el.appendChild(mark);
	return mark.offsetTop;
}

export function caretVisualLineFlags(ta: HTMLTextAreaElement): CaretLineFlags {
	const value = ta.value;
	const index = ta.selectionStart;
	if (index !== ta.selectionEnd) return { first: false, last: false };
	const logical = logicalLineFlags(value, index);
	if (!logical.first && !logical.last) return logical;
	if (typeof document === "undefined" || typeof getComputedStyle !== "function") return logical;
	const el = getMirror();
	if (syncMirror(ta, el) <= 0) return logical;
	const caretTop = measureTop(el, value.slice(0, index));
	const endTop = measureTop(el, value);
	const measurable = el.offsetHeight > 0;
	el.textContent = "";
	if (!measurable && value !== "") return logical;
	return caretRowFlags(caretTop, endTop, rowTolerance(ta));
}
