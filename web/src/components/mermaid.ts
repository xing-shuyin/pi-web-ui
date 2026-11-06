/// <reference lib="dom" />

export function isMermaidLanguage(className: unknown): boolean {
	return typeof className === "string" && /(^|\s)language-mermaid(\s|$)/.test(className);
}

export function childrenText(children: unknown): string {
	if (typeof children === "string") return children;
	if (Array.isArray(children)) return children.map(childrenText).join("");
	if (children && typeof children === "object" && "props" in children) {
		const props = (children as { props?: { children?: unknown } }).props;
		return childrenText(props?.children);
	}
	return "";
}

export function singleCodeChild(children: unknown): { props?: { className?: unknown } } | null {
	const child = Array.isArray(children) ? children[0] : children;
	if (!child || typeof child !== "object" || !("props" in child)) return null;
	return child as { props?: { className?: unknown } };
}

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

export function routePreToMermaid(children: unknown): boolean {
	const code = singleCodeChild(children);
	return code !== null && isMermaidLanguage(code.props?.className);
}

export function fenceLanguage(children: unknown): string | null {
	const code = singleCodeChild(children);
	const className = code?.props?.className;
	if (typeof className !== "string") return null;
	const m = className.match(/(?:^|\s)language-([A-Za-z0-9_+-]+)(?:\s|$)/);
	return m ? m[1] : null;
}
