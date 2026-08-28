import { useEffect, useId, useRef, useState } from "react";
import { useT } from "../i18n";
import { CopyButton } from "./copy-button";

/** Lazily-loaded, memoized mermaid module — most chats never hit a mermaid
 *  fence, so this stays out of the main bundle until one actually renders. */
let mermaidPromise: Promise<typeof import("mermaid")["default"]> | null = null;
function loadMermaid() {
	if (!mermaidPromise) {
		mermaidPromise = import("mermaid").then((mod) => {
			const mermaid = mod.default;
			mermaid.initialize({
				startOnLoad: false,
				securityLevel: "strict",
				// Diagrams read best on a light "paper" background — mermaid's
				// dark theme renders low-contrast boxes that clash with
				// whatever surrounds them (see .mermaid-block in styles.css,
				// which gives this its own light card instead of matching the
				// app's dark chrome directly).
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

let renderSeq = 0;

/** Renders a ```mermaid fenced block as an SVG diagram (flowcharts, sequence
 *  diagrams, etc. — see docs/AI_Investment_OS_SYSTEM_DESIGN.md for examples).
 *  Falls back to the raw source in a codeblock if mermaid can't parse it, so
 *  a typo never blanks out the rest of the document. */
export function MermaidDiagram({ code }: { code: string }) {
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
				if (!cancelled) {
					setError(err instanceof Error ? err.message : String(err));
				}
				// mermaid sometimes leaves a detached error node behind in the DOM
				// on parse failure; nothing in our tree references it so it's inert,
				// but clean up the offscreen render target just in case.
				document.getElementById(renderId)?.remove();
			});
		return () => {
			cancelled = true;
		};
	}, [code, reactId]);

	if (error) {
		return (
			<div className="mermaid-block mermaid-block-error">
				<div className="mermaid-error-note">{t("mermaidRenderFailed")}</div>
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
				<div className="mermaid-loading-note">{t("mermaidRendering")}</div>
			</div>
		);
	}

	return (
		<div className="mermaid-block">
			<CopyButton text={code} />
			{/* mermaid.render() output is inert markup we generated locally
			 *  (securityLevel: "strict" also has mermaid itself sanitize it). */}
			<div
				ref={containerRef}
				className="mermaid-svg"
				// eslint-disable-next-line react/no-danger
				dangerouslySetInnerHTML={{ __html: svg }}
			/>
		</div>
	);
}
