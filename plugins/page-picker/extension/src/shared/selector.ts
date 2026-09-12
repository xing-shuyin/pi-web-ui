/// <reference lib="dom" />
/**
 * 元素定位串生成（纯函数，可在 jsdom 里单测）。
 *
 * 目标：给 AI 一个**短且唯一**的定位串，让它在源码里能对应上。三种粒度：
 * - `buildSelector`  首选：从元素自身往上叠 `tag.class` / `#id`，找到第一个能唯一命中的前缀；
 *                    实在不唯一才退到全 `:nth-of-type` 路径（长但一定准）。
 * - `buildXPath`     精确路径（`/html/body/div[2]/main/section[2]`），selector 失效时的兜底。
 * - `buildDomPath`   给人看的结构线（`body > div#root > main > section.card`），超深截断。
 */

const IDENT_SAFE = /[a-zA-Z0-9_-]/;

/**
 * CSS 标识符转义。不用 `CSS.escape`：jsdom / 老 Chrome 不保证有，而且手写的更好测。
 * 非 ASCII 用十六进制转义 + 尾随空格（这是 CSS 规范要求的消歧写法）。
 */
export function escapeIdent(raw: string): string {
	let out = "";
	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i];
		const leadingDigit = i === 0 && /[0-9-]/.test(ch);
		if (IDENT_SAFE.test(ch) && !leadingDigit) {
			out += ch;
			continue;
		}
		const cp = ch.codePointAt(0) ?? 0;
		out += cp < 0x80 ? `\\${ch}` : `\\${cp.toString(16)} `;
	}
	return out;
}

/** 这个选择器是不是**只**命中这个元素（匹配到别的 / 匹配不到 / 语法错都算不唯一）。 */
export function isUniqueSelector(selector: string, el: Element): boolean {
	try {
		const all = el.ownerDocument.querySelectorAll(selector);
		return all.length === 1 && all[0] === el;
	} catch {
		return false;
	}
}

/** 某个元素自身的段：`#id`（全局唯一时）否则 `tag.class1.class2`。 */
export function ownSegment(el: Element, maxClasses = 3): string {
	const tag = el.tagName.toLowerCase();
	const id = el.getAttribute("id");
	if (id && isUniqueSelector(`#${escapeIdent(id)}`, el)) return `#${escapeIdent(id)}`;
	const classes = [...el.classList].slice(0, maxClasses).map(escapeIdent);
	return classes.length > 0 ? `${tag}.${classes.join(".")}` : tag;
}

/**
 * 兄弟内唯一的段：先试 `tag.class`，若在同一父级下还撞车就补 `:nth-of-type(n)`。
 *
 * 为什么必要：光靠「往上叠祖先」在兄弟层级是收不住的 —— 往上加祖先段并不能把
 * 同一父级下的两个同级元素区分开，只能眼睁睁退到整条 `:nth-of-type` 长路径。
 * 每层先在本父级内唯一下来，整条链通常两三层就定了。
 */
function siblingSegment(el: Element, maxClasses: number): string {
	const base = ownSegment(el, maxClasses);
	const parent = el.parentElement;
	if (!parent) return base;
	let hits = 0;
	for (const child of parent.children) {
		try {
			if (child.matches(base)) hits++;
		} catch {
			return base; // 段本身不合法（不该发生）→ 不补，交给外层兜底
		}
	}
	if (hits <= 1) return base;
	const same = [...parent.children].filter((c) => c.tagName === el.tagName);
	return same.length > 1 ? `${base}:nth-of-type(${same.indexOf(el) + 1})` : base;
}

/**
 * 首选定位串：先试自身，不唯一就逐层往上叠父级段（每层先保证父级内唯一，见
 * siblingSegment），直到整条链唯一。全走完还不唯一 → 全 `:nth-of-type` 路径。
 */
export function buildSelector(el: Element, opts: { maxDepth?: number; maxClasses?: number } = {}): string {
	const maxDepth = Math.max(1, opts.maxDepth ?? 6);
	const maxClasses = Math.max(0, opts.maxClasses ?? 3);
	const segs = [siblingSegment(el, maxClasses)];
	if (isUniqueSelector(segs[0], el)) return segs[0];
	let node = el.parentElement;
	let depth = 1;
	while (node && node !== el.ownerDocument.documentElement && depth < maxDepth) {
		segs.unshift(siblingSegment(node, maxClasses));
		const candidate = segs.join(" > ");
		if (isUniqueSelector(candidate, el)) return candidate;
		node = node.parentElement;
		depth++;
	}
	return buildNthPath(el);
}

/** 全 `:nth-of-type` 路径（一定准，就是长）。含 `html`，可当选择器直接 querySelector。 */
export function buildNthPath(el: Element): string {
	const segs: string[] = [];
	let node: Element | null = el;
	while (node && node.nodeType === 1) {
		const cur: Element = node;
		let seg = cur.tagName.toLowerCase();
		const parent = cur.parentElement;
		if (parent) {
			const same = [...parent.children].filter((c) => c.tagName === cur.tagName);
			if (same.length > 1) seg += `:nth-of-type(${same.indexOf(cur) + 1})`;
		}
		segs.unshift(seg);
		if (cur === cur.ownerDocument.documentElement) break;
		node = cur.parentElement;
	}
	return segs.join(" > ");
}

/** 精确 XPath（`/html/body/div[2]/main/section[2]`，同标签兄弟只有一个时不带下标）。 */
export function buildXPath(el: Element): string {
	const segs: string[] = [];
	let node: Element | null = el;
	while (node && node.nodeType === 1) {
		const cur: Element = node;
		let seg = cur.tagName.toLowerCase();
		const parent = cur.parentElement;
		if (parent) {
			const same = [...parent.children].filter((c) => c.tagName === cur.tagName);
			if (same.length > 1) seg += `[${same.indexOf(cur) + 1}]`;
		}
		segs.unshift(seg);
		if (cur === cur.ownerDocument.documentElement) break;
		node = cur.parentElement;
	}
	return `/${segs.join("/")}`;
}

/** 人类可读的 DOM 路径：`body > div#root > main > section.card`（去掉 html，超深只留尾巴）。 */
export function buildDomPath(el: Element, opts: { maxDepth?: number; maxClasses?: number } = {}): string {
	const maxDepth = Math.max(1, opts.maxDepth ?? 4);
	const maxClasses = Math.max(0, opts.maxClasses ?? 2);
	const segs: string[] = [];
	let node: Element | null = el;
	while (node && node.nodeType === 1) {
		const cur: Element = node;
		if (cur !== cur.ownerDocument.documentElement) {
			let seg = cur.tagName.toLowerCase();
			const id = cur.getAttribute("id");
			if (id) seg += `#${id}`;
			else {
				const classes = [...cur.classList].slice(0, maxClasses).map(escapeIdent);
				if (classes.length > 0) seg += `.${classes.join(".")}`;
			}
			segs.unshift(seg);
		}
		if (cur === cur.ownerDocument.documentElement) break;
		node = cur.parentElement;
	}
	if (segs.length === 0) return "";
	if (segs.length > maxDepth) return `… > ${segs.slice(-maxDepth).join(" > ")}`;
	return segs.join(" > ");
}

/** 开标签摘要：`<section id="x" class="card card--active" type="…">`（属性截断，防超长）。 */
export function tagSummary(el: Element, opts: { maxAttrs?: number; maxValue?: number } = {}): string {
	const maxAttrs = Math.max(0, opts.maxAttrs ?? 2);
	const maxValue = Math.max(4, opts.maxValue ?? 60);
	const tag = el.tagName.toLowerCase();
	const parts: string[] = [];
	const push = (name: string, value: string) => {
		if (parts.length >= maxAttrs + 2) return; // id/class 之外只再多带 maxAttrs 个
		const v = value.length > maxValue ? `${value.slice(0, maxValue)}…` : value;
		parts.push(`${name}="${v}"`);
	};
	const id = el.getAttribute("id");
	const cls = [...el.classList];
	if (id) push("id", id);
	if (cls.length > 0) push("class", cls.join(" "));
	for (const name of ["type", "name", "role", "href", "src", "value", "placeholder"]) {
		const v = el.getAttribute(name);
		if (v) push(name, v);
		if (parts.length >= maxAttrs + 2) break;
	}
	return `<${tag}${parts.length > 0 ? ` ${parts.join(" ")}` : ""}>`;
}
