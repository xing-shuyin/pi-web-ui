import { createElement, type ReactNode } from "react";

/** Split a code element's children into per-logical-line node arrays so each
 *  line can render in its own gutter row (issue #36). rehype-highlight emits a
 *  flat list of text runs and token spans where newlines only live inside text
 *  nodes; a token span that somehow spans lines is cloned once per line so
 *  syntax highlighting survives the split. A trailing newline's phantom empty
 *  line is dropped (matches countLines). */
export function splitCodeLines(node: ReactNode): ReactNode[][] {
	const walk = (n: ReactNode): ReactNode[][] => {
		if (typeof n === "string" || typeof n === "number") {
			const text = String(n);
			return text === "" ? [[]] : text.split("\n").map((p) => (p === "" ? [] : [p]));
		}
		if (Array.isArray(n)) {
			let out: ReactNode[][] = [];
			for (const child of n) {
				const sub = walk(child);
				if (out.length === 0) {
					out = sub;
				} else {
					const head = sub[0] ?? [];
					out[out.length - 1].push(...head);
					out.push(...sub.slice(1));
				}
			}
			return out;
		}
		if (n && typeof n === "object" && "props" in n) {
			const el = n as { type: unknown; props?: { children?: ReactNode } };
			const kids = el.props?.children;
			const rest = { ...el.props, children: undefined };
			const sub = kids == null ? ([] as ReactNode[][]) : walk(kids);
			if (sub.length === 0) return [[createElement(el.type as never, rest)]];
			return sub.map((seg) => [createElement(el.type as never, rest, ...seg)]);
		}
		return [[n]];
	};

	const result = walk(node);
	if (result.length > 1 && result[result.length - 1].length === 0) result.pop();
	return result;
}
