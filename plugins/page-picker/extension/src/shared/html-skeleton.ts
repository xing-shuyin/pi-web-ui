/// <reference lib="dom" />

import { collapse, truncate } from "./text.js";

const VOID_TAGS = new Set([
	"area",
	"base",
	"br",
	"col",
	"embed",
	"hr",
	"img",
	"input",
	"link",
	"meta",
	"param",
	"source",
	"track",
	"wbr",
]);

export interface SkeletonOptions {
	maxDepth?: number;
	maxText?: number;
	maxLength?: number;
	maxClasses?: number;
}

function attrsOf(el: Element, maxClasses: number): string {
	const parts: string[] = [];
	const id = el.getAttribute("id");
	if (id) parts.push(`id="${id}"`);
	const classes = [...el.classList];
	if (classes.length > 0) {
		const shown = classes.slice(0, maxClasses).join(" ");
		parts.push(`class="${shown}${classes.length > maxClasses ? " …" : ""}"`);
	}
	return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

export function htmlSkeleton(root: Element, opts: SkeletonOptions = {}): string {
	const maxDepth = Math.max(0, opts.maxDepth ?? 2);
	const maxText = Math.max(0, opts.maxText ?? 60);
	const maxLength = Math.max(16, opts.maxLength ?? 400);
	const maxClasses = Math.max(0, opts.maxClasses ?? 4);

	let out = "";
	const emit = (el: Element, depth: number): void => {
		const tag = el.tagName.toLowerCase();
		out += `<${tag}${attrsOf(el, maxClasses)}>`;
		if (VOID_TAGS.has(tag)) return;
		if (depth >= maxDepth) {
			if (el.childNodes.length > 0) out += "…";
			out += `</${tag}>`;
			return;
		}
		for (const child of el.childNodes) {
			if (child.nodeType === 3) {
				const text = collapse(child.textContent ?? "");
				if (text) out += truncate(text, maxText);
			} else if (child.nodeType === 1) {
				emit(child as Element, depth + 1);
			}
		}
		out += `</${tag}>`;
	};
	emit(root, 0);
	return truncate(out, maxLength);
}
