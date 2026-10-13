import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { JSX } from "react";
import ReactMarkdown from "react-markdown";
import type { PluggableList } from "unified";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import remarkMath from "remark-math";
import remarkBackslashMath from "../remark-backslash-math";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import "katex/dist/katex.min.css";
import { CopyButton } from "./copy-button";
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
import { PluginFenceBlock } from "./PluginFenceBlock";
import { openFilePreview } from "../file-preview-bridge";

interface MarkdownProps {
	text: string;
	/** 渲染原始 HTML（嵌在 markdown 里）。默认关闭：聊天消息的 markdown 镜像会
	 *  转义 HTML，提问对话框等信任模型的地方可开启以支持 HTML + markdown 混排。 */
	rawHtml?: boolean;
	/** 保留单个换行（\n → <br>）。CommonMark 的软换行在 <p> 里会被浏览器折叠成
	 *  空格，用户自己输入/粘贴的多行纯文本因此显示成一整串。默认关闭（助手输出
	 *  走标准 markdown 段落语义）；用户气泡开启以忠实呈现用户原文的换行。 */
	hardBreaks?: boolean;
}

/** Shared markdown pipeline + codeblock chrome (copy button). Exported so
 *  StreamMarkdown's per-segment renderers reuse the exact same configuration
 *  as this full-document renderer — streaming preview and final render must
 *  be visually identical. */
const remarkPlugins = [remarkGfm, remarkMath, remarkBackslashMath];
/** Same pipeline + hard line breaks — used for USER bubbles so typed/pasted
 *  multi-line text keeps every line break (see MarkdownProps.hardBreaks). */
const remarkPluginsHardBreaks = [remarkGfm, remarkBreaks, remarkMath, remarkBackslashMath];
const rehypePlugins: PluggableList = [
	// KaTeX 在 highlight 之前：两者目标节点不相交（.math vs pre code），
	// 公式解析失败时只显示红色源码（throwOnError: false），不打断整条消息。
	[rehypeKatex, { strict: false, throwOnError: false }],
	[rehypeHighlight, { detect: true, ignoreMissing: true }],
];

/**
 * 把正文中的 @file.ext 提及安全转换为 pi-file:// 链接，供 MdLink 渲染为小药丸微标。
 * - 仅在非代码段生效（严格跳过 ``` 代码围栏与 ` 行内代码）；
 * - 排除邮箱（a@b.com）与推特类无扩展名用户名（@alice）；
 * - 支持工作区相对路径，如 @src/App.tsx、@package.json。
 */
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
}: {
	text: string;
	rawHtml?: boolean;
	hardBreaks?: boolean;
}) {
	// rawHtml 时在 highlight 之前插入 rehype-raw：先把它内嵌的原始 HTML 解析成
	// hast 节点，再统一交给 highlight 做代码高亮，顺序不可颠倒。
	// rehype-raw 之后紧接 rehype-sanitize（GitHub 式默认白名单）：rawHtml 的来源
	// （提问对话框等）信任模型再宽也是"模型输出"，script/事件属性/iframe 一律剥掉，
	// 常用标签与 markdown 生成的结构（含 language-* 类名，KaTeX 的 language-math
	// 走同一前缀）保留。sanitize 必须在 katex/highlight 之前：它们后续添加的
	// class/元素不会被白名单误伤。非 rawHtml 路径本来就没有原始 HTML，不接 sanitize。
	const rh: PluggableList = rawHtml ? [rehypeRaw, rehypeSanitize, ...rehypePlugins] : rehypePlugins;
	const processedText = useMemo(() => linkifyFileMentions(text), [text]);
	return (
		<ReactMarkdown
			remarkPlugins={hardBreaks ? remarkPluginsHardBreaks : remarkPlugins}
			rehypePlugins={rh}
			components={{ pre: PreWithCopy, a: MdLink }}
		>
			{processedText}
		</ReactMarkdown>
	);
}

/** GFM markdown with syntax highlighting; code blocks get a copy button. */
export const Markdown = memo(function Markdown({ text, rawHtml = false, hardBreaks = false }: MarkdownProps) {
	return (
		<div className="md">
			<MarkdownBody text={text} rawHtml={rawHtml} hardBreaks={hardBreaks} />
		</div>
	);
});

/** 正文里的外链一律新窗口打开（`target=_blank` + `rel`）。
 *
 * 两笔账都算得上：网页版里是「新标签页打开」这种更符合预期的行为（和界面里手写
 * 外链的写法一致）；桌面壳里 `target=_blank` 的点击走 `setWindowOpenHandler` 被
 * 转给系统浏览器 —— 而裸 `href` 会触发同帧导航把应用窗口带走（issue #154，
 * 桌面壳另有 `will-navigate` 守卫兜底脚本发起的跳转）。站内锚点（`#…`）与相对
 * 路径不动：它们本来就是应用内导航。 */
function MdLink({ node: _node, href, children, ...rest }: JSX.IntrinsicElements["a"] & { node?: unknown }) {
	// node 是 react-markdown 塞进 props 的内部 hast 节点（运行时存在、类型里没有），
	// 必须在这里截下：透传给 <a> 会渲染成 node="[object Object]" 垃圾属性。
	const target = String(href ?? "");
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
				title={"点击预览文件: " + filePath}
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
	if (!/^(https?:|mailto:|tel:)/i.test(target)) {
		return (
			<a href={href} {...rest}>
				{children}
			</a>
		);
	}
	return (
		// {...rest} 放在安全默认之前：rest 来自渲染内容（rawHtml 时是模型给的
		// 属性），不可信 —— target/rel 后置才能保证 `_blank` + noreferrer noopener
		// 不会被 `<a target="_self">` 之类的输入覆盖掉。
		<a {...rest} href={href} target="_blank" rel="noreferrer noopener">
			{children}
		</a>
	);
}

function PreWithCopy({ children, ...props }: JSX.IntrinsicElements["pre"]) {
	// fenced-code 渲染插件机制：有插件认领 ```lang 时交给它渲染（mermaid → SVG
	// 等），否则回退普通代码块（高亮 + 行号）。认领表由 server 的 plugins 清单 +
	// plugin-fence.ts 维护，插件命中才懒加载。
	//
	// 订阅注册表版本：attach 时历史消息快照先于 plugins 清单到达，清单一到版本
	// 变化 → 本组件（及整条渲染树）重渲染 → 未命中的 mermaid 围栏补挂插件宿主。
	// useSyncExternalStore 会绕过外层 memo 的 props 比较，无需穿透传参。
	// 第三参数提供同步 getServerSnapshot（= 当前版本），使 SSR/服务端渲染（renderToStaticMarkup）
	// 不因缺 getServerSnapshot 抛错 —— 提问对话框/预览的代码块在服务端渲染时也能正常出图。
	useSyncExternalStore(subscribeFenceRegistry, getFenceRegistryVersion, getFenceRegistryVersion);
	const lang = fenceLanguage(children);
	if (lang && hasFenceRenderer(lang)) {
		return <PluginFenceBlock lang={lang} code={childrenText(children)} />;
	}
	return <PlainCodeBlock children={children} {...props} />;
}

/** 普通代码块（高亮 + 行号 + 复制按钮）——无插件认领语言的默认展示。 */
function PlainCodeBlock({ children, ...props }: JSX.IntrinsicElements["pre"]) {
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

/**
 * 自定义消息类型（UiMessage.customType）的插件渲染宿主（messageWidget 泛化，
 * 见 plugin-fence.ts 的 loadMessageWidget/hasMessageWidget）。
 *
 * 仿 PluginFenceBlock 的懒加载模式：命中类型时才动态 import 插件 bundle，
 * 平常零开销。无认领 / 加载中 / 加载失败 / renderer 返回 null 时一律回退
 * children（原文默认渲染），绝不空白。fence 逻辑一字不改。
 */
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
				// 与 fence 同一套窄上下文；上行 send 暂为 no-op（fence 的 wsSend
				// 在 plugin-fence.ts 模块内，渲染层不碰它，后续收编时再接线）。
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
