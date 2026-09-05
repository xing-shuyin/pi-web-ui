/// <reference lib="dom" />
/**
 * Pure helpers for ```mermaid fenced-code detection — kept free of React so
 * they're unit-testable (tests/unit/mermaid.test.ts) and importable from
 * MermaidBlock.tsx without pulling DOM/React into the test graph.
 */

/** True only when a code element's className token list contains exactly
 *  `language-mermaid` (react-markdown/rehype-highlight emits language-* classes).
 *  Deliberately NOT a substring match: `language-mermaid2` must not match. */
export function isMermaidLanguage(className: unknown): boolean {
	return typeof className === "string" && /(^|\s)language-mermaid(\s|$)/.test(className);
}

/** Flatten react-markdown children (string / nested element / array) to text. */
export function childrenText(children: unknown): string {
	if (typeof children === "string") return children;
	if (Array.isArray(children)) return children.map(childrenText).join("");
	if (children && typeof children === "object" && "props" in children) {
		const props = (children as { props?: { children?: unknown } }).props;
		return childrenText(props?.children);
	}
	return "";
}

/** The single `<code>` element react-markdown hands a `<pre>`'s children
 *  (possibly wrapped in an array), or null when absent. */
export function singleCodeChild(children: unknown): { props?: { className?: unknown } } | null {
	const child = Array.isArray(children) ? children[0] : children;
	if (!child || typeof child !== "object" || !("props" in child)) return null;
	return child as { props?: { className?: unknown } };
}

/** Give Mermaid's root SVG an intrinsic pixel width from its viewBox.
 * Mermaid emits width="100%" plus max-width for small charts; for wide charts
 * that makes mobile browsers squeeze the entire diagram until labels are
 * unreadable. A concrete width preserves both cases: small charts stay at
 * their natural size and wide charts overflow their scroll container. */
export function preserveMermaidSvgWidth(svg: string): string {
	const match = svg.match(/<svg\b([^>]*)>/i);
	if (!match) return svg;
	const attrs = match[1];
	const viewBox = attrs.match(/\bviewBox=(['"])([^'"]+)\1/i)?.[2];
	if (!viewBox) return svg;
	const values = viewBox
		.trim()
		.split(/[\s,]+/)
		.map(Number);
	const width = values.length === 4 ? values[2] : Number.NaN;
	if (!Number.isFinite(width) || width <= 0) return svg;

	const existingStyle = attrs.match(/\sstyle=(['"])(.*?)\1/i)?.[2] ?? "";
	const cleanStyle = existingStyle.replace(/(?:^|;)\s*(?:max-)?width\s*:[^;]*/gi, "").replace(/^\s*;|;\s*$/g, "");
	const sizedAttrs = attrs.replace(/\swidth=(['"])[^'"]*\1/i, "").replace(/\sstyle=(['"])(.*?)\1/i, "");
	const style = cleanStyle ? `${cleanStyle}; max-width:none` : "max-width:none";
	return svg.replace(match[0], `<svg${sizedAttrs} width="${width}" style="${style}">`);
}

/** The `components={{ pre: ... }}` decision: does this pre's children hold a
 *  mermaid-tagged code element? Pure so tests can assert routing without React. */
export function routePreToMermaid(children: unknown): boolean {
	const code = singleCodeChild(children);
	return code !== null && isMermaidLanguage(code.props?.className);
}
