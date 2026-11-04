import { useEffect, useRef, useState } from "react";
import { renderFence } from "../plugin-fence";
import { THEME_CHANGE_EVENT } from "../theme";
import { CopyButton } from "./copy-button";
import { RunInTerminalButton } from "./terminal-run-button";

/**
 * fenced-code 渲染插件宿主：把 ```lang 围栏交给认领它的插件渲染成自定义 DOM
 * （mermaid → SVG 等），渲染是**按需懒加载**的（命中该语言时才动态 import
 * 插件 bundle，平常聊天零开销）。
 *
 * 路由由 Markdown.tsx 的 PreWithCopy 负责（它订阅注册表版本，plugins 清单一到
 * 会重渲染并把围栏切到这里；普通语言代码块永远走它自身的高亮行号渲染）。本组件
 * 只做：异步 renderFence，产物（DOM）经 state 持有、在宿主容器渲染后再挂载——
 * 不能用 promise 回调里读 holderRef（容器在 done 分支渲染前不存在，ref 必为
 * null，结果会丢掉）。加载中/失败/返回 null 时回退普通代码块，绝不空白。
 */
export function PluginFenceBlock({ lang, code }: { lang: string; code: string }) {
	const holderRef = useRef<HTMLDivElement>(null);
	const elRef = useRef<HTMLElement | null>(null);
	const themeVersionRef = useRef(0);
	const renderedThemeVersionRef = useRef(new WeakMap<HTMLElement, number>());
	const [el, setEl] = useState<HTMLElement | null>(null);

	useEffect(() => {
		const updateTheme = () => {
			const version = ++themeVersionRef.current;
			const current = elRef.current;
			if (!current) return;
			current.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT));
			renderedThemeVersionRef.current.set(current, version);
		};
		window.addEventListener(THEME_CHANGE_EVENT, updateTheme);
		return () => window.removeEventListener(THEME_CHANGE_EVENT, updateTheme);
	}, []);

	useEffect(() => {
		let cancelled = false;
		const requestedThemeVersion = themeVersionRef.current;
		setEl(null);
		renderFence(lang, code).then((result) => {
			if (cancelled) return;
			if (result) renderedThemeVersionRef.current.set(result, requestedThemeVersion);
			setEl(result);
		});
		return () => {
			cancelled = true;
		};
	}, [lang, code]);

	// holder div 渲染完成后把产物挂进去（replaceChildren 兜底防重复挂载）。
	useEffect(() => {
		elRef.current = el;
		const holder = holderRef.current;
		if (holder) {
			holder.replaceChildren();
			if (el) {
				holder.appendChild(el);
				// A theme change can arrive while renderFence is still pending, before
				// elRef exists. Catch the new element up only after it is connected so
				// plugin renderers can atomically replace their mounted output.
				const renderedVersion = renderedThemeVersionRef.current.get(el) ?? themeVersionRef.current;
				if (renderedVersion < themeVersionRef.current) {
					el.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT));
					renderedThemeVersionRef.current.set(el, themeVersionRef.current);
				}
			}
		}
		return () => {
			if (elRef.current === el) elRef.current = null;
		};
	}, [el]);

	if (!el) {
		// 加载中 / 无认领 / 失败：普通代码块（与无插件时展示一致，不空白）。
		return (
			<div className="codeblock">
				<div className="codeblock-actions">
					<RunInTerminalButton code={code} />
					<CopyButton text={code} />
				</div>
				<pre>
					<code>{code}</code>
				</pre>
			</div>
		);
	}
	return <div className="plugin-fence" ref={holderRef} />;
}
