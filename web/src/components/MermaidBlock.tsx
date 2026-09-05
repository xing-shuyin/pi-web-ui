import { useEffect, useId, useRef, useState } from "react";
import { useT } from "../i18n";
import { CopyButton } from "./copy-button";
import { childrenText, isMermaidLanguage, singleCodeChild } from "./mermaid";

/** Lazily-loaded, memoized mermaid module — most chats never hit a mermaid
 *  fence, so this stays out of the main bundle until one actually renders. */
let mermaidPromise: Promise<(typeof import("mermaid"))["default"]> | null = null;
function loadMermaid() {
	if (!mermaidPromise) {
		mermaidPromise = import("mermaid").then((mod) => {
			const mermaid = mod.default;
			mermaid.initialize({
				startOnLoad: false,
				securityLevel: "strict",
				// Diagrams render on their own light "paper" card (.mermaid-block in
				// styles.css) under both app themes, so mermaid always uses its light
				// base theme with explicit variables rather than tracking the app chrome.
				theme: "base",
				themeVariables: {
					background: "#ffffff",
					primaryColor: "#f1edfe",
					primaryTextColor: "#1f2430",
					primaryBorderColor: "#8b5cf6",
					lineColor: "#6b7280",
					secondaryColor: "#eef2ff",
					tertiaryColor: "#f8fafc",
					textColor: "#1f2430",
					fontFamily: "var(--mono, monospace)",
				},
			});
			return mermaid;
		});
	}
	return mermaidPromise;
}

/** Module-level counter so render IDs stay unique across React instances too
 *  (useId alone can repeat across Suspense boundaries / strict-mode remounts). */
let renderSeq = 0;

/** Renders a ```mermaid fenced block as an SVG diagram (flowcharts, sequence
 *  diagrams, etc.). Falls back to the raw source in a normal codeblock when
 *  mermaid can't parse it, so a typo never blanks out the message. */
export function MermaidBlock({ code }: { code: string }) {
	const t = useT();
	const reactId = useId().replace(/[^a-zA-Z0-9]/g, "");
	const [svg, setSvg] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const containerRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		let cancelled = false;
		setSvg(null);
		setError(null);
		const renderId = `mermaid-${reactId}-${++renderSeq}`;
		loadMermaid()
			.then((mermaid) => mermaid.render(renderId, code))
			.then(({ svg }) => {
				if (!cancelled) setSvg(svg);
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				setError(err instanceof Error ? err.message : String(err));
				// mermaid's error path leaves its offscreen render target in the DOM
				// (the raw id, or its "d"-prefixed fallback container). Nothing in
				// our tree references it, but clean both up so they can't accumulate.
				for (const id of [renderId, `d${renderId}`]) document.getElementById(id)?.remove();
			});
		return () => {
			cancelled = true;
		};
	}, [code, reactId]);

	if (error) {
		return (
			<div className="mermaid-block mermaid-block-error">
				<div className="mermaid-note">{t("mermaidRenderFailed")}</div>
				<div className="codeblock">
					<CopyButton text={code} />
					<pre>
						<code>{code}</code>
					</pre>
				</div>
			</div>
		);
	}

	if (!svg) {
		return (
			<div className="mermaid-block mermaid-block-loading">
				<div className="mermaid-note">{t("mermaidRendering")}</div>
			</div>
		);
	}

	return (
		<div className="mermaid-block">
			<CopyButton text={code} />
			{/* mermaid.render() output is markup we generated locally from plain-text
			    source (securityLevel: "strict" sanitizes shapes/labels). */}
			<div ref={containerRef} className="mermaid-svg" dangerouslySetInnerHTML={{ __html: svg }} />
		</div>
	);
}

/** Helper for PreWithCopy: the fence's raw source when this <pre> wraps a
 *  single mermaid <code> element, else null (normal codeblock chrome applies). */
export function mermaidCodeFromPre(children: unknown): string | null {
	const code = singleCodeChild(children);
	if (!code || !isMermaidLanguage(code.props?.className)) return null;
	return childrenText(children);
}
