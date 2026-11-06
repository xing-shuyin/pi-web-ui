import { useEffect, useRef, useState } from "react";
import { renderFence } from "../plugin-fence";
import { THEME_CHANGE_EVENT } from "../theme";
import { CopyButton } from "./copy-button";
import { RunInTerminalButton } from "./terminal-run-button";

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

	useEffect(() => {
		elRef.current = el;
		const holder = holderRef.current;
		if (holder) {
			holder.replaceChildren();
			if (el) {
				holder.appendChild(el);
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
