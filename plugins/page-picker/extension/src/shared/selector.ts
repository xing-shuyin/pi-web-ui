/// <reference lib="dom" />

const IDENT_SAFE = /[a-zA-Z0-9_-]/;

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

export function isUniqueSelector(selector: string, el: Element): boolean {
	try {
		const all = el.ownerDocument.querySelectorAll(selector);
		return all.length === 1 && all[0] === el;
	} catch {
		return false;
	}
}

export function ownSegment(el: Element, maxClasses = 3): string {
	const tag = el.tagName.toLowerCase();
	const id = el.getAttribute("id");
	if (id && isUniqueSelector(`#${escapeIdent(id)}`, el)) return `#${escapeIdent(id)}`;
	const classes = [...el.classList].slice(0, maxClasses).map(escapeIdent);
	return classes.length > 0 ? `${tag}.${classes.join(".")}` : tag;
}

function siblingSegment(el: Element, maxClasses: number): string {
	const base = ownSegment(el, maxClasses);
	const parent = el.parentElement;
	if (!parent) return base;
	let hits = 0;
	for (const child of parent.children) {
		try {
			if (child.matches(base)) hits++;
		} catch {
			return base;
		}
	}
	if (hits <= 1) return base;
	const same = [...parent.children].filter((c) => c.tagName === el.tagName);
	return same.length > 1 ? `${base}:nth-of-type(${same.indexOf(el) + 1})` : base;
}

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

export function tagSummary(el: Element, opts: { maxAttrs?: number; maxValue?: number } = {}): string {
	const maxAttrs = Math.max(0, opts.maxAttrs ?? 2);
	const maxValue = Math.max(4, opts.maxValue ?? 60);
	const tag = el.tagName.toLowerCase();
	const parts: string[] = [];
	const push = (name: string, value: string) => {
		if (parts.length >= maxAttrs + 2) return;
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
