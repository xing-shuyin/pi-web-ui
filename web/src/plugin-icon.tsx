import type { JSX } from "react";

const ALLOWED_TAGS = new Set([
	"svg",
	"g",
	"path",
	"circle",
	"rect",
	"line",
	"polyline",
	"polygon",
	"ellipse",
	"use",
	"defs",
	"clipPath",
	"linearGradient",
	"radialGradient",
	"stop",
]);

const ALLOWED_ATTRS = new Set([
	"viewBox",
	"xmlns",
	"d",
	"fill",
	"stroke",
	"stroke-width",
	"stroke-linecap",
	"stroke-linejoin",
	"stroke-dasharray",
	"opacity",
	"x",
	"y",
	"x1",
	"y1",
	"x2",
	"y2",
	"cx",
	"cy",
	"r",
	"rx",
	"ry",
	"width",
	"height",
	"points",
	"offset",
	"stop-color",
	"stop-opacity",
	"fill-opacity",
	"stroke-opacity",
	"stroke-miterlimit",
	"fill-rule",
	"clip-rule",
	"vector-effect",
	"preserveAspectRatio",
	"transform",
	"clip-path",
	"id",
	"href",
	"xlink:href",
	"xmlns:xlink",
	"gradientUnits",
	"gradientTransform",
]);

const DROPPED_TAGS = new Set(["script", "style", "title", "desc", "foreignobject"]);

const ALLOWED_TAGS_LC = new Set([...ALLOWED_TAGS].map((tag) => tag.toLowerCase()));
const ALLOWED_ATTRS_LC = new Set([...ALLOWED_ATTRS].map((name) => name.toLowerCase()));

export function isAllowedIconTag(tag: string): boolean {
	return ALLOWED_TAGS_LC.has(tag.toLowerCase());
}

export function isAllowedIconAttr(name: string): boolean {
	return ALLOWED_ATTRS_LC.has(name.toLowerCase());
}

export function sanitizeIconSvg(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const s = raw.trim();
	if (!s || s.length > 8192) return null;
	if (!/^<svg[\s>]/.test(s.startsWith("<?xml") ? s.slice(s.indexOf("?>") + 2).trimStart() : s)) return null;
	if (typeof DOMParser === "undefined") {
		if (/<script[\s>]/i.test(s) || /\son\w+\s*=/i.test(s) || /javascript\s*:/i.test(s)) return null;
		return s;
	}
	const doc = new DOMParser().parseFromString(s, "image/svg+xml");
	if (doc.querySelector("parsererror")) return null;
	const root = doc.documentElement;
	if (root.tagName.toLowerCase() !== "svg") return null;
	const clean = (el: Element): void => {
		for (const child of Array.from(el.children)) {
			const tag = child.tagName.toLowerCase();
			if (!isAllowedIconTag(tag)) {
				if (DROPPED_TAGS.has(tag)) {
					child.remove();
				} else {
					clean(child);
					child.replaceWith(...child.childNodes);
				}
				continue;
			}
			for (const attr of Array.from(child.attributes)) {
				const name = attr.name.toLowerCase();
				if (!isAllowedIconAttr(name) || /^on/i.test(name) || /^(javascript|data|vbscript):/i.test(attr.value.trim())) {
					child.removeAttribute(attr.name);
				}
			}
			clean(child);
		}
	};
	for (const attr of Array.from(root.attributes)) {
		const name = attr.name.toLowerCase();
		if (!isAllowedIconAttr(name) || /^on/i.test(name)) root.removeAttribute(attr.name);
	}
	clean(root);
	return new XMLSerializer().serializeToString(root);
}

export function PluginIcon({
	icon,
	iconSvg,
	className,
}: {
	icon?: string;
	iconSvg?: string;
	className?: string;
}): JSX.Element | null {
	const safe = sanitizeIconSvg(iconSvg);
	if (safe) {
		return <span className={className ?? "plugin-icon-svg"} aria-hidden dangerouslySetInnerHTML={{ __html: safe }} />;
	}
	if (icon) {
		return (
			<span className={className ? `${className} plugin-icon-glyph` : "plugin-icon-glyph"} aria-hidden>
				{icon}
			</span>
		);
	}
	return null;
}
