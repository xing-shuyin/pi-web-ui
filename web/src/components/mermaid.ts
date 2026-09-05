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
