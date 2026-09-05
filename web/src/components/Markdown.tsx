import { memo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import type { PluggableList } from "unified";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { CopyButton } from "./copy-button";
import { splitCodeLines } from "../code-lines";
import { MermaidBlock, mermaidCodeFromPre } from "./MermaidBlock";
import { routePreToMermaid } from "./mermaid";

interface MarkdownProps {
	text: string;
}

/** Shared markdown pipeline + codeblock chrome (copy button). Exported so
 *  StreamMarkdown's per-segment renderers reuse the exact same configuration
 *  as this full-document renderer — streaming preview and final render must
 *  be visually identical. */
export const remarkPlugins = [remarkGfm];
export const rehypePlugins: PluggableList = [[rehypeHighlight, { detect: true, ignoreMissing: true }]];

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

function PreWithCopy({ children, ...props }: JSX.IntrinsicElements["pre"]) {
	// ```mermaid fences render as SVG diagrams instead of highlighted code.
	if (routePreToMermaid(children)) return <MermaidBlock code={mermaidCodeFromPre(children)!} />;
	// react-markdown 传进来的是 <pre><code …>…</code></pre> 里的 code 元素；
	// 按逻辑行切分的是它内部的 span/文本 children，而不是 code 元素本身
	// （否则每行会嵌套一个克隆的 <code>，且尾随空行无法被丢弃）。
	const inner =
		children && typeof children === "object" && "props" in children
			? (children as { props?: { children?: ReactNode } }).props?.children
			: children;
	const lines = splitCodeLines(inner);
	const multi = lines.length > 1;
	const numWidth = multi ? `${String(lines.length).length + 1}ch` : undefined;
	return (
		<div className="codeblock">
			<CopyButton text={codeText(children)} />
			<pre {...props}>
				{lines.map((nodes, i) => (
					<div className="code-line" key={i}>
						{multi && (
							<span className="code-num" style={numWidth ? { width: numWidth } : undefined}>
								{i + 1}
							</span>
						)}
						<code className="code-line-body hljs">{nodes}</code>
					</div>
				))}
			</pre>
		</div>
	);
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
