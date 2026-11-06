import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { JSX } from "react";
import ReactMarkdown from "react-markdown";
import type { PluggableList } from "unified";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import remarkMath from "remark-math";
import remarkBackslashMath from "../remark-backslash-math";
import rehypeHighlight from "rehype-highlight";
import { getMathRenderer, loadMathRenderer, subscribeMathRenderer } from "../markdown-math-loader";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import { CopyButton } from "./copy-button";
import { RunInTerminalButton } from "./terminal-run-button";
import { splitCodeLines } from "../code-lines";
import { childrenText, fenceLanguage } from "./mermaid";
import {
	getFenceRegistryVersion,
	hasFenceRenderer,
	hasMessageWidget,
	loadMessageWidget,
	subscribeFenceRegistry,
	widgetRegistry,
} from "../plugin-fence";
import type { FenceRenderContext } from "../plugin-loader";
import { isZhLocale, useLocale } from "../i18n";
import { PluginFenceBlock } from "./PluginFenceBlock";
import { openFilePreview } from "../file-preview-bridge";
import { openImageLightbox } from "../image-lightbox-bridge";
import { appResourceCrossOrigin, appResourceUrl } from "../base-url";
import { isMobileRuntime } from "../mobile-runtime";
import { useAppField } from "../app-globals";
import {
	isExternalOrProtocolLink,
	resolveWorkspaceFileUrl,
	normalizeTargetFilePath,
	markdownFileUrlTransform,
} from "../workspace-file-url";

interface MarkdownProps {
	text: string;
	rawHtml?: boolean;
	hardBreaks?: boolean;
	disableMath?: boolean;
}

/** Shared markdown pipeline + codeblock chrome (copy button). Exported so
 *  StreamMarkdown's per-segment renderers reuse the exact same configuration
 *  as this full-document renderer — streaming preview and final render must
 *  be visually identical. */
const remarkPlugins = [remarkGfm, remarkMath, remarkBackslashMath];
const remarkPluginsNoMath = [remarkGfm];
const remarkPluginsHardBreaks = [remarkGfm, remarkBreaks, remarkMath, remarkBackslashMath];
const remarkPluginsHardBreaksNoMath = [remarkGfm, remarkBreaks];
const rehypePluginsNoMath: PluggableList = [[rehypeHighlight, { detect: false, ignoreMissing: true }]];

export function linkifyFileMentions(text: string): string {
	if (!text || !text.includes("@")) return text;
	const segments = text.split(new RegExp("(```[\\s\\S]*?```|`[^`\\r\\n]+`)", "g"));
	const fileRegex = /(^|[\s(（“"'[])@((?:[\w.-]+\/)*[\w.-]+\.(?:[a-zA-Z0-9]{1,10}))(?=[)\s\],.;:!?，。！？’”"']|$)/g;
	for (let i = 0; i < segments.length; i += 2) {
		if (segments[i]) {
			segments[i] = segments[i].replace(fileRegex, (match, prefix, path) => {
				return prefix + "[" + "@" + path + "](pi-file://" + encodeURIComponent(path) + ")";
			});
		}
	}
	return segments.join("");
}

export function MarkdownBody({
	text,
	rawHtml = false,
	hardBreaks = false,
	disableMath = false,
}: {
	text: string;
	rawHtml?: boolean;
	hardBreaks?: boolean;
	disableMath?: boolean;
}) {
	const mathRenderer = useSyncExternalStore(subscribeMathRenderer, getMathRenderer, getMathRenderer);
	const mathCandidate = !disableMath && (rawHtml || /[$\\\\]|math/i.test(text));
	useEffect(() => {
		if (mathCandidate && !mathRenderer) void loadMathRenderer();
	}, [mathCandidate, mathRenderer]);
	const baseRehype: PluggableList =
		!disableMath && mathRenderer
			? [[mathRenderer, { strict: false, throwOnError: false }], ...rehypePluginsNoMath]
			: rehypePluginsNoMath;
	const rh: PluggableList = rawHtml ? [rehypeRaw, rehypeSanitize, ...baseRehype] : baseRehype;
	const processedText = useMemo(() => linkifyFileMentions(text), [text]);
	const activeRemarks = disableMath
		? hardBreaks
			? remarkPluginsHardBreaksNoMath
			: remarkPluginsNoMath
		: hardBreaks
			? remarkPluginsHardBreaks
			: remarkPlugins;
	return (
		<ReactMarkdown
			remarkPlugins={activeRemarks}
			rehypePlugins={rh}
			urlTransform={markdownFileUrlTransform}
			components={{ pre: PreWithCopy, a: MdLink, img: MdImage }}
		>
			{processedText}
		</ReactMarkdown>
	);
}

export const Markdown = memo(function Markdown({
	text,
	rawHtml = false,
	hardBreaks = false,
	disableMath = false,
}: MarkdownProps) {
	return (
		<div className="md">
			<MarkdownBody text={text} rawHtml={rawHtml} hardBreaks={hardBreaks} disableMath={disableMath} />
		</div>
	);
});

function MdLink({ node: _node, href, children, ...rest }: JSX.IntrinsicElements["a"] & { node?: unknown }) {
	const target = String(href ?? "");
	const isZh = isZhLocale(useLocale());
	const cwd = useAppField("cwd");
	if (target.startsWith("pi-file://")) {
		const rawPath = target.slice("pi-file://".length);
		let filePath = rawPath;
		try {
			filePath = decodeURIComponent(rawPath);
		} catch {
			filePath = rawPath;
		}
		const fileName =
			typeof children === "string" && children.trim() ? children.trim() : (filePath.split("/").pop() ?? filePath);
		return (
			<button
				type="button"
				className="file-pill"
				title={(isZh ? "点击预览文件: " : "Click to preview file: ") + filePath}
				onClick={(e) => {
					e.preventDefault();
					e.stopPropagation();
					openFilePreview({ path: filePath, name: fileName.replace(/^@/, "") });
				}}
			>
				<span className="file-pill-icon" aria-hidden="true">
					📄
				</span>
				<span className="file-pill-name">{fileName}</span>
			</button>
		);
	}
	if (!isExternalOrProtocolLink(target)) {
		const cleanPath = normalizeTargetFilePath(target, cwd);
		const fileName = cleanPath.split("/").pop() || cleanPath;
		const webUrl = resolveWorkspaceFileUrl(target, cwd);
		return (
			<a
				{...rest}
				href={webUrl}
				onClick={(e) => {
					if (e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
						if (openFilePreview({ path: cleanPath, name: fileName })) {
							e.preventDefault();
							e.stopPropagation();
						}
					}
				}}
				target="_blank"
				rel="noreferrer noopener"
				title={(isZh ? "点击预览: " : "Click to preview: ") + cleanPath}
			>
				{children}
			</a>
		);
	}
	if (!/^(https?:|mailto:|tel:)/i.test(target)) {
		return (
			<a href={href} {...rest}>
				{children}
			</a>
		);
	}
	return (
		<a {...rest} href={href} target="_blank" rel="noreferrer noopener">
			{children}
		</a>
	);
}

function MdImage({ node: _node, src, alt, ...rest }: JSX.IntrinsicElements["img"] & { node?: unknown }) {
	const rawSrc = String(src ?? "");
	const cwd = useAppField("cwd");
	let effectiveSrc = rawSrc;
	if (isMobileRuntime() && rawSrc.startsWith("/api/")) {
		effectiveSrc = appResourceUrl(rawSrc);
	} else if (
		rawSrc &&
		!isExternalOrProtocolLink(rawSrc) &&
		!rawSrc.startsWith("data:") &&
		!rawSrc.startsWith("blob:")
	) {
		effectiveSrc = resolveWorkspaceFileUrl(rawSrc, cwd);
	}
	if (appResourceCrossOrigin(effectiveSrc)) effectiveSrc = appResourceUrl(effectiveSrc);
	return (
		<button
			type="button"
			className="image-preview-trigger"
			aria-label={alt || "Image preview"}
			onClick={(e) => {
				e.preventDefault();
				e.stopPropagation();
				openImageLightbox({ src: effectiveSrc, alt });
			}}
		>
			<img
				{...rest}
				crossOrigin={appResourceCrossOrigin(effectiveSrc) ?? rest.crossOrigin}
				src={effectiveSrc}
				alt={alt}
				loading="lazy"
			/>
		</button>
	);
}

function PreWithCopy({ children, ...props }: JSX.IntrinsicElements["pre"]) {
	useSyncExternalStore(subscribeFenceRegistry, getFenceRegistryVersion, getFenceRegistryVersion);
	const lang = fenceLanguage(children);
	if (lang && hasFenceRenderer(lang)) {
		return <PluginFenceBlock lang={lang} code={childrenText(children)} />;
	}
	return <PlainCodeBlock children={children} {...props} />;
}

function PlainCodeBlock({ children, ...props }: JSX.IntrinsicElements["pre"]) {
	const inner =
		children && typeof children === "object" && "props" in children
			? (children as { props?: { children?: ReactNode } }).props?.children
			: children;
	const lines = splitCodeLines(inner);
	const multi = lines.length > 1;
	const numWidth = multi ? `${String(lines.length).length + 1}ch` : undefined;
	const rawCode = codeText(children);
	return (
		<div className="codeblock">
			<div className="codeblock-actions">
				<RunInTerminalButton code={rawCode} />
				<CopyButton text={rawCode} />
			</div>
			<pre {...props}>
				{lines.map((nodes, i) => (
					<div className="code-line" key={i}>
						{multi && (
							<span className="code-num" style={numWidth ? { width: numWidth } : undefined}>
								{i + 1}
							</span>
						)}
						<code className="code-line-body">{nodes}</code>
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

export function PluginWidgetBlock({ type, code, children }: { type: string; code: string; children: ReactNode }) {
	const holderRef = useRef<HTMLDivElement>(null);
	const [el, setEl] = useState<HTMLElement | null>(null);
	useEffect(() => {
		let cancelled = false;
		setEl(null);
		if (!hasMessageWidget(type)) return;
		void loadMessageWidget(type).then(async (renderer) => {
			if (cancelled || !renderer) return;
			try {
				const ctx: FenceRenderContext = {
					pluginId: widgetRegistry.get(type) ?? type,
					send: () => undefined,
					onData: () => () => undefined,
				};
				const result = await renderer(code, ctx);
				if (!cancelled && result instanceof HTMLElement) setEl(result);
			} catch (err) {
				console.error(`[plugin-widget:${type}] 渲染失败:`, err);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [type, code]);
	useEffect(() => {
		const holder = holderRef.current;
		if (holder) {
			holder.replaceChildren();
			if (el) holder.appendChild(el);
		}
	}, [el]);
	if (!el) return <>{children}</>;
	return <div className="plugin-widget" ref={holderRef} />;
}
