import { memo } from "react";
import ReactMarkdown from "react-markdown";
import type { PluggableList } from "unified";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { CopyButton } from "./copy-button";
import { MermaidDiagram } from "./MermaidDiagram";

interface MarkdownProps {
	text: string;
}

/** Shared markdown pipeline + codeblock chrome (copy button). Exported so
 *  StreamMarkdown's per-segment renderers reuse the exact same configuration
 *  as this full-document renderer — streaming preview and final render must
 *  be visually identical. */
export const remarkPlugins = [remarkGfm];
export const rehypePlugins: PluggableList = [
	[rehypeHighlight, { detect: true, ignoreMissing: true }],
];

export function MarkdownBody({ text }: { text: string }) {
	return (
		<ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={{ pre: PreWithCopy }}>
			{text}
		</ReactMarkdown>
	);
}

/** GFM markdown with syntax highlighting; code blocks get a copy button. */
export const Markdown = memo(function Markdown({ text }: MarkdownProps) {
	return (
		<div className="md">
			<MarkdownBody text={text} />
		</div>
	);
});

export function PreWithCopy({ children, ...props }: JSX.IntrinsicElements["pre"]) {
	if (isMermaidCodeBlock(children)) {
		return <MermaidDiagram code={codeText(children)} />;
	}
	return (
		<div className="codeblock">
			<CopyButton text={codeText(children)} />
			<pre {...props}>{children}</pre>
		</div>
	);
}

/** True when `children` is the single ```mermaid fenced-code element that
 *  react-markdown/rehype-highlight hand to a <pre>'s children. */
function isMermaidCodeBlock(children: unknown): boolean {
	const child = Array.isArray(children) ? children[0] : children;
	if (!child || typeof child !== "object" || !("props" in child)) return false;
	const className = (child as { props?: { className?: unknown } }).props?.className;
	return typeof className === "string" && /(^|\s)language-mermaid(\s|$)/.test(className);
}

function codeText(children: unknown): string {
	if (typeof children === "string") return children;
	if (Array.isArray(children)) return children.map(codeText).join("");
	if (children && typeof children === "object" && "props" in children) {
		const props = (children as { props?: { children?: unknown } }).props;
		return codeText(props?.children);
	}
	return "";
}
