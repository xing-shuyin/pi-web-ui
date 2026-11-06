const CDN_URL = "https://esm.sh/mermaid@12.0.0";
const THEME_CHANGE_EVENT = "pi-web-ui:theme-change";

let mermaidPromise = null;

function importModule(url) {
	return import(/* @vite-ignore */ url).then((mod) => mod.default ?? mod);
}

function loadMermaid() {
	if (!mermaidPromise) {
		mermaidPromise = importModule("./vendor/mermaid.bundle.mjs").catch(() => importModule(CDN_URL));
	}
	return mermaidPromise;
}

function cssVar(name, fallback) {
	return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function isDarkTheme() {
	const scheme = getComputedStyle(document.documentElement).colorScheme;
	if (scheme.split(/\s+/).includes("dark")) return true;
	if (scheme.split(/\s+/).includes("light")) return false;

	const rgb = getComputedStyle(document.body)
		.backgroundColor.match(/[\d.]+/g)
		?.slice(0, 3)
		.map(Number);
	if (!rgb || rgb.length < 3) return true;
	return rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114 < 128;
}

function diagramFontSize() {
	const size = Number.parseFloat(cssVar("--mermaid-font-size", "12px"));
	return Number.isFinite(size) && size > 0 ? size : 12;
}

function themeVariables(dark, fontSize) {
	return dark
		? {
				background: cssVar("--bg-elev2", "#1a1d26"),
				primaryColor: cssVar("--bg-elev", "#14161c"),
				primaryBorderColor: cssVar("--border", "#262a35"),
				lineColor: cssVar("--text-dim", "#9aa1b4"),
				textColor: cssVar("--text", "#e6e8ef"),
				primaryTextColor: cssVar("--text", "#e6e8ef"),
				nodeBorder: cssVar("--accent", "#8b5cf6"),
				labelBackground: cssVar("--bg", "#0d0e12"),
				fontFamily: cssVar("--mono", "monospace"),
				fontSize: `${fontSize}px`,
			}
		: {
				background: cssVar("--bg", "#ffffff"),
				primaryColor: cssVar("--bg-elev2", "#f6f8fa"),
				primaryBorderColor: cssVar("--border", "#d0d7de"),
				lineColor: cssVar("--text-dim", "#59636e"),
				textColor: cssVar("--text", "#1f2328"),
				primaryTextColor: cssVar("--text", "#1f2328"),
				nodeBorder: cssVar("--accent", "#0969da"),
				labelBackground: cssVar("--bg", "#ffffff"),
				fontFamily: cssVar("--mono", "monospace"),
				fontSize: `${fontSize}px`,
			};
}

let seq = 0;

function preserveSvgWidth(svg) {
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

let renderQueue = Promise.resolve();

function renderSvg(code) {
	const result = renderQueue.then(async () => {
		const mermaid = await loadMermaid();
		const dark = isDarkTheme();
		const fontSize = diagramFontSize();
		mermaid.initialize({
			startOnLoad: false,
			securityLevel: "strict",
			theme: dark ? "dark" : "base",
			fontSize,
			sequence: {
				actorFontSize: fontSize,
				messageFontSize: fontSize,
				noteFontSize: fontSize,
			},
			gantt: {
				fontSize,
				sectionFontSize: fontSize,
			},
			themeVariables: themeVariables(dark, fontSize),
		});

		const renderId = `mermaid-fence-${++seq}-${Date.now().toString(36)}`;
		const holder = document.createElement("div");
		holder.style.position = "absolute";
		holder.style.left = "-99999px";
		holder.style.width = "1000px";
		holder.dataset.mermaidRender = renderId;
		document.body.appendChild(holder);
		try {
			const { svg } = await mermaid.render(renderId, code, holder);
			return { dark, svg: preserveSvgWidth(svg) };
		} finally {
			holder.remove();
		}
	});
	renderQueue = result.then(
		() => undefined,
		() => undefined,
	);
	return result;
}

function applyRenderedSvg(el, rendered) {
	if (rendered.dark) el.dataset.mermaidDark = "true";
	else delete el.dataset.mermaidDark;
	el.innerHTML = rendered.svg;
}

async function renderMermaid(code) {
	const el = document.createElement("div");
	el.className = "mermaid-block mermaid-svg";
	applyRenderedSvg(el, await renderSvg(code));

	let themeRequest = 0;
	el.addEventListener(THEME_CHANGE_EVENT, () => {
		const request = ++themeRequest;
		renderSvg(code)
			.then((rendered) => {
				if (request !== themeRequest || !el.isConnected) return;
				applyRenderedSvg(el, rendered);
			})
			.catch((err) => console.error("[plugin:mermaid] theme re-render failed:", err));
	});
	return el;
}

export default {
	renderers: {
		mermaid: renderMermaid,
	},
};
